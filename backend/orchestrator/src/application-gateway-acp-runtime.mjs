import { createApplicationAgentEventBridge } from "./application-agent-events.mjs";
import { projectApplicationProviderOperationState } from "./application-provider-state.mjs";
import { CodexAppServerConversationReadAdapter } from "./codex-app-server-conversation-read-adapter.mjs";
import { createClaudeCodeSessionJournal } from "./claude-code-session-journal.mjs";
import { AcpStdioClient } from "./acp-stdio-client.mjs";
import { ACP_ADAPTER_ID, ACP_PROVIDER_ID, AcpSessionHost, createAcpProviderDescriptor } from "./acp-session-host.mjs";
import { ACP_PROVIDER_CONFIG_PATH, acpEnvironment, normalizeAcpProviderConfig, readAcpProviderConfig } from "./acp-provider-config.mjs";
import { createProjectMemoryAcp } from "./project-memory-acp.mjs";
import { createAcpDeskPolicy } from "./acp-desk-policy.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";
import { createAgentTurnCommits } from "./agent-turn-commits.mjs";

// Desk agents on an ACP agent (DeepSeek Harness) beside Claude Code: a factory
// for application-gateway-read-runtime.mjs `extraProviders`. It starts the
// agent process from `.project-local/application-gateway/acp-provider.json`
// and returns the memory provider, conversation route and event bridge the
// read runtime routes per agent (project-memory-provider-router.mjs).

export const APPLICATION_GATEWAY_ACP_RUNTIME_VERSION = "v0.1.0";
export { ACP_PROVIDER_CONFIG_PATH, normalizeAcpProviderConfig, readAcpProviderConfig };

const SESSION_FOLDER = "acp-sessions";

function nothing() {
  return { memoryProvider: null, conversationRoute: null, agentEventBridge: null, providerStates: [],
    authenticationStates: [], close: async () => {} };
}

/**
 * The factory. `acp`: the normalized config, plus for tests `startClient`
 * (returns a started client) used instead of starting the configured program,
 * and `policy` used instead of the config's `deskPolicy` (acp-desk-policy.mjs).
 */
export function createAcpProviderFactory(acp) {
  return async ({ repoRoot, sourceId, instanceId, now, memoryService, assertVisible, readPermissions = {},
    onDiagnostic = () => {} }) => {
    const diagnostic = (record) => onDiagnostic({ schemaVersion: 1, ...record, instanceId });
    let host = null;
    let memoryProvider = null;
    let agentEvents = null;
    try {
      const startClient = acp.startClient ?? (async () => {
        const client = new AcpStdioClient({ command: acp.command, args: acp.args, cwd: acp.home,
          env: await acpEnvironment(acp), onDiagnostic: diagnostic });
        client.start();
        return client;
      });
      const journal = await createClaudeCodeSessionJournal({ controllerRoot: repoRoot, folder: SESSION_FOLDER });
      // acp-provider.json turnSilenceMinutes: 0 lifts the silence guard, none keeps the host's default.
      const silence = acp.turnSilenceMinutes ?? null;
      host = new AcpSessionHost({ startClient, journal, now, models: acp.models, mcpServers: acp.mcpServers,
        onDiagnostic: diagnostic,
        ...(silence === null ? {} : { silenceTimeoutMs: silence === 0 ? null : silence * 60_000 }) });
      await host.connect();
      const observedAtUtc = now().toISOString();
      const descriptor = createAcpProviderDescriptor({ sourceId, runtimeInstanceId: `gateway-acp-${instanceId}`,
        observedAtUtc });
      const conversationReader = new CodexAppServerConversationReadAdapter({ client: host, descriptor, now,
        adapterId: ACP_ADAPTER_ID });
      const authentication = await conversationReader.readAuthentication();
      memoryProvider = await createProjectMemoryAcp({ host, controllerRoot: repoRoot,
        sourceId: memoryService.archive.projectId, providerSourceId: sourceId, instanceId,
        archive: memoryService.archive, descriptor, assertVisible,
        onInteractionChanged: (record) => agentEvents?.interactionChanged(record),
        resolveWorkspace: (agent) => resolveProjectWorkspace(memoryService.store, agent.projectId),
        policy: acp.policy ?? (acp.deskPolicy ? createAcpDeskPolicy(acp.deskPolicy) : null),
        enforcesWriteZones: acp.enforcesWriteZones === true,
        commits: acp.agentCommits === false ? null : (acp.commits ?? createAgentTurnCommits()),
        onCommit: (record) => diagnostic({ component: "agent-turn-commits", phase: "commit", provider: ACP_PROVIDER_ID,
          agentId: record.agentId, operationId: record.operationId, turnId: record.turnId, state: record.state,
          reasonCode: record.reason ?? null, sha: record.sha ?? null,
          files: Array.isArray(record.files) ? record.files.length : 0 }) });
      agentEvents = createApplicationAgentEventBridge({ service: memoryService, client: host,
        providerSourceId: sourceId, instanceId, now, providerId: ACP_PROVIDER_ID });
      // A finished turn settles its send receipt at once (as the Claude runtime does).
      host.on("turn/completed", async ({ threadId, turnId }) => {
        try {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const catalog = await memoryService.catalog();
            const agent = catalog.value.agents.find((item) => item.binding?.providerId === ACP_PROVIDER_ID
              && item.binding.threadId === threadId);
            if (!agent) return;
            const operation = agent.operations.find((item) => item.turnId === turnId);
            if (operation) {
              await memoryService.receipt({ agentId: agent.agentId, operationId: operation.operationId });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } catch (error) {
          diagnostic({ component: "acp-provider-runtime", phase: "settle",
            reasonCode: typeof error?.code === "string" ? error.code : "settle_failed" });
        }
      });
      const runtimeHost = host;
      return {
        memoryProvider,
        conversationRoute: { providerId: ACP_PROVIDER_ID, adapterId: ACP_ADAPTER_ID, reader: conversationReader },
        agentEventBridge: agentEvents,
        providerStates: [projectApplicationProviderOperationState({ descriptor, asOfUtc: observedAtUtc,
          permissions: readPermissions })],
        authenticationStates: [authentication.data.state],
        close: async () => {
          agentEvents?.close();
          await memoryProvider?.close();
          await runtimeHost.close();
        },
      };
    } catch (error) {
      agentEvents?.close();
      await memoryProvider?.close().catch(() => undefined);
      await host?.close().catch(() => undefined);
      diagnostic({ component: "acp-provider-runtime",
        reasonCode: typeof error?.code === "string" ? error.code : "acp_provider_unavailable",
        message: String(error?.message ?? "").slice(0, 300) });
      return nothing();
    }
  };
}

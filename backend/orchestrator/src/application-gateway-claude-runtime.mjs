import { createApplicationAgentEventBridge } from "./application-agent-events.mjs";
import { createApplicationGatewayProviderMutationBridge } from "./application-gateway-provider-mutation-bridge.mjs";
import { projectApplicationProviderOperationState } from "./application-provider-state.mjs";
import { CodexAppServerConversationReadAdapter } from "./codex-app-server-conversation-read-adapter.mjs";
import {
  claudeEnvironment, claudeProgramOf, loadClaudeSdk, loadClaudeZod, readClaudeAccount,
} from "./claude-code-sdk.mjs";
import { createClaudeCodeSessionJournal } from "./claude-code-session-journal.mjs";
import {
  CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_PROVIDER_ID, ClaudeCodeSessionHost, createClaudeCodeProviderDescriptor,
} from "./claude-code-session-host.mjs";
import {
  CLAUDE_PROVIDER_CONFIG_PATH, normalizeClaudeProviderConfig, readClaudeProviderConfig,
} from "./claude-provider-config.mjs";
import { createProjectMemoryClaude } from "./project-memory-claude.mjs";
import { createDeskTaskTools } from "./desk-agent-task-tools.mjs";
import { createDeskCoordinatorTools } from "./desk-coordinator-tools.mjs";
import { createDeskTaskReturns } from "./desk-task-returns.mjs";
import { deskTaskGateHook } from "./desk-task-gate.mjs";
import { agentSettings } from "./project-memory-service.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";
import { applyRateLimitEvent, normalizeClaudeUsage, writeClaudeUsage } from "./claude-usage.mjs";
import { createAgentTurnCommits } from "./agent-turn-commits.mjs";
import { recordActionQuietly } from "./action-journal.mjs";
import { memoryWrite } from "./action-journal-gateway.mjs";

// The Gateway's provider runtime when desk agents run on Claude Code instead
// of the Codex App Server. It returns the same shape as the Codex runtime in
// application-gateway-read-runtime.mjs. The owner chat and the generic
// provider mutations (thread create, turn start, interrupt) stay with the
// controller's own route and are not offered here.

export const APPLICATION_GATEWAY_CLAUDE_RUNTIME_VERSION = "v0.5.0";
export { CLAUDE_PROVIDER_CONFIG_PATH, normalizeClaudeProviderConfig, readClaudeProviderConfig };

/** The coordinator gets the controller's tools; every other agent its task tools. */
function deskTools({ controllerRoot, service, returns }) {
  const agentTools = createDeskTaskTools({ controllerRoot, onReportSubmitted: returns.reportSubmitted,
    onTaskDeclined: returns.taskDeclined });
  const coordinatorTools = createDeskCoordinatorTools({ controllerRoot, service });
  return (agent) => (agentSettings(agent).role === "coordinator" ? coordinatorTools(agent) : agentTools(agent));
}

function unavailable(reasonCode) {
  return {
    status: "unavailable", reasonCode, executionProvider: null, conversationReader: null,
    providerStates: [], authenticationStates: [], mutationHandlers: {},
    mutationStatus: createApplicationGatewayProviderMutationBridge().operations,
    ownerChatHandlers: {}, interactionHandlers: {}, agentEventHandlers: {}, conversationCapture: null,
    ownerChatStatus: Object.freeze({ configured: false, status: "disabled", reasonCode: "not_configured", sourceId: null }),
    conversationProvider: Object.freeze({ providerId: CLAUDE_CODE_PROVIDER_ID, adapterId: CLAUDE_CODE_ADAPTER_ID }),
    close: async () => {},
  };
}

/**
 * `claude`: the normalized config, plus for tests an `sdk` object and a
 * `readAccount` function used instead of the installed SDK and `auth status`.
 * `attach: false`: the memory provider is not set on the service; the caller
 * routes it with other providers (project-memory-provider-router.mjs) and
 * takes `memoryProvider`, `conversationRoute` and `agentEventBridge` from the result.
 */
export async function createClaudeProviderRuntime({ repoRoot, sourceId, instanceId, now, claude,
  memoryService, assertVisible, readPermissions = {}, onDiagnostic = () => {}, attach = true }) {
  let host = null;
  let memoryProvider = null;
  let agentEvents = null;
  const returns = memoryService ? createDeskTaskReturns({ controllerRoot: repoRoot, service: memoryService, now,
    runReportOperation: claude.runReportOperation,
    onDiagnostic: (record) => onDiagnostic({ ...record, instanceId }) }) : null;
  const settleTurn = async ({ threadId, turnId }) => {
    try {
      // A very short turn can end before the send has recorded its turn ID;
      // the receipt is taken once it has, within a second.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const catalog = await memoryService.catalog();
        const agent = catalog.value.agents.find((item) => item.binding?.providerId === CLAUDE_CODE_PROVIDER_ID
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
      onDiagnostic({ schemaVersion: 1, component: "claude-provider-runtime", instanceId, phase: "settle",
        reasonCode: typeof error?.code === "string" ? error.code : "settle_failed" });
    }
  };
  try {
    const sdk = claude.sdk ?? await loadClaudeSdk(claude.sdkPath);
    const env = claudeEnvironment({ configDir: claude.claudeConfigDir ?? null,
      keepProviderVariables: claude.keepProviderVariables === true });
    const readAccount = claude.readAccount
      ?? (() => readClaudeAccount({ program: claudeProgramOf(claude.sdkPath), env }));
    const journal = await createClaudeCodeSessionJournal({ controllerRoot: repoRoot });
    let zod = claude.zod ?? null;
    if (zod === null && !claude.sdk) {
      try { zod = loadClaudeZod(claude.sdkPath); } catch { zod = null; }
    }
    // The plan's usage, as the turns learn it, for the window's meter (claude-usage.mjs).
    let usage = null;
    const onUsage = (record) => {
      const next = record.kind === "usage" ? normalizeClaudeUsage(record.answer, record.observedAtUtc)
        : applyRateLimitEvent(usage, record.info, record.observedAtUtc);
      if (next === null || next === usage) return;
      usage = next;
      writeClaudeUsage(repoRoot, usage).catch((error) => onDiagnostic({ schemaVersion: 1,
        component: "claude-provider-runtime", instanceId, phase: "usage",
        reasonCode: typeof error?.code === "string" ? error.code : "usage_not_written" }));
    };
    host = new ClaudeCodeSessionHost({ sdk, journal, now, env, models: claude.models, zod,
      settingSources: claude.settingSources, permissionMode: claude.permissionMode, readAccount, onUsage,
      onDiagnostic: (record) => onDiagnostic({ schemaVersion: 1, ...record, instanceId }) });
    await host.connect();
    const observedAtUtc = now().toISOString();
    const descriptor = createClaudeCodeProviderDescriptor({ sourceId,
      runtimeInstanceId: `gateway-claude-${instanceId}`, observedAtUtc });
    const conversationReader = new CodexAppServerConversationReadAdapter({ client: host, descriptor, now,
      adapterId: CLAUDE_CODE_ADAPTER_ID });
    const authentication = await conversationReader.readAuthentication();
    const authenticated = authentication.data.state.status === "authenticated";
    if (memoryService) {
      // The provider is set even while Claude Code is signed out: every send
      // reads the account again first, so signing in needs no Gateway restart.
      memoryProvider = await createProjectMemoryClaude({ host, controllerRoot: repoRoot,
        sourceId: memoryService.archive.projectId, providerSourceId: sourceId, instanceId,
        archive: memoryService.archive, descriptor, assertVisible,
        onInteractionChanged: (record) => agentEvents?.interactionChanged(record),
        resolveWorkspace: (agent) => resolveProjectWorkspace(memoryService.store, agent.projectId),
        // The agent's own write of an approved document goes into the action journal as the agent's.
        documents: async (agent, documentPath) => {
          const written = await memoryService.writeMemoryFromDocument({ agentId: agent.agentId, path: documentPath });
          const scope = await memoryService.store.readScope({ scopeId: written.scopeId }).catch(() => null);
          if (scope !== null) {
            await recordActionQuietly(memoryService.store, memoryWrite(scope,
              { previousRevision: written.revision - 1, revision: written.revision },
              { kind: "agent", id: agent.agentId }), { now, onDiagnostic });
          }
          return written;
        },
        // Controller tasks reach desk agents registered as sources (claude-code-controller.md).
        taskTools: claude.taskTools ?? deskTools({ controllerRoot: repoRoot, service: memoryService, returns }),
        taskGate: claude.taskTools ? null : (agent) => deskTaskGateHook({ controllerRoot: repoRoot, agentId: agent.agentId }),
        // Each turn's work becomes a commit in the git of its project folder (agent-turn-commits.mjs);
        // claude-provider.json `agentCommits: false` turns it off.
        commits: claude.agentCommits === false ? null : (claude.commits ?? createAgentTurnCommits()),
        // A fetch from an address not on this list asks the person (claude-provider.json `webFetchHosts`).
        webFetchHosts: claude.webFetchHosts ?? null,
        onCommit: (record) => onDiagnostic({ schemaVersion: 1, component: "agent-turn-commits", instanceId,
          phase: "commit", agentId: record.agentId, operationId: record.operationId, turnId: record.turnId,
          state: record.state, reasonCode: record.reason ?? null, sha: record.sha ?? null,
          files: Array.isArray(record.files) ? record.files.length : 0 }) });
      if (attach) memoryService.provider = memoryProvider;
      agentEvents = createApplicationAgentEventBridge({ service: memoryService, client: host,
        providerSourceId: sourceId, instanceId, now, providerId: CLAUDE_CODE_PROVIDER_ID });
      // A finished turn settles its send receipt at once, so the agent counts as
      // idle (and the attention model sees it) without waiting for a reader; a
      // task return that waited for a busy coordinator goes out then.
      host.on("turn/completed", async (event) => {
        await settleTurn(event);
        await returns.retryPending().catch(() => undefined);
      });
    }
    const runtimeHost = host;
    return {
      ...unavailable(authenticated ? "available" : "provider_authentication_required"),
      status: authenticated ? "available" : "unavailable",
      conversationReader,
      providerStates: [projectApplicationProviderOperationState({ descriptor, asOfUtc: observedAtUtc,
        permissions: readPermissions })],
      authenticationStates: [authentication.data.state],
      agentEventHandlers: agentEvents?.handlers ?? {},
      memoryProvider,
      agentEventBridge: agentEvents,
      conversationRoute: { providerId: CLAUDE_CODE_PROVIDER_ID, adapterId: CLAUDE_CODE_ADAPTER_ID, reader: conversationReader },
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
    if (memoryService?.provider === memoryProvider) memoryService.provider = null;
    onDiagnostic({ schemaVersion: 1, component: "claude-provider-runtime", instanceId,
      reasonCode: typeof error?.code === "string" ? error.code : "claude_provider_unavailable" });
    return unavailable(typeof error?.code === "string" && /^claude_[a-z_]{1,64}$/u.test(error.code)
      ? error.code : "claude_provider_unavailable");
  }
}

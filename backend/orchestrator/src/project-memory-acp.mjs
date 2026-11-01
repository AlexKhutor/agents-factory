import { CodexConversationArchive } from "./codex-conversation-archive.mjs";
import { createFileProviderMutationLease } from "./provider-mutation-lease-store.mjs";
import { applicationCanonicalSha256 as hash } from "./application-contract.mjs";
import { createApplicationProviderInteractionBridge } from "./application-provider-interaction-bridge.mjs";
import { ACP_PROVIDER_ID, acpTurnState } from "./acp-session-host.mjs";
import { effectiveWriteZone } from "./project-memory-service.mjs";

// Desk agents on an ACP agent (DeepSeek Harness): the provider of
// ProjectMemoryService that project-memory-claude.mjs is for Claude Code. One
// agent is one ACP session (acp-session-host.mjs); one message is one turn.
//
// What is checked, and what is not: the model must be one the machine-local
// config offers, and it is set on the session before each turn; the agent
// process must be running. The agent's own tools run under the agent's own
// rules; a tool call it asks about goes through `policy` (write zones, A2b)
// and otherwise to the person.

export const PROJECT_MEMORY_ACP_VERSION = "v0.1.0";

function fail(code) { throw Object.assign(new Error(code), { code }); }

/**
 * `policy({ agent, root, zone })`: the desk's decision for the tool calls the
 * agent asks about, as acp-session-host startTurn takes it; null leaves every
 * question to the person. `enforcesWriteZones`: true only when that policy
 * holds the agent inside its zone (proven by a live test, plan A2b).
 * `commits`: commits each turn's work to the git of the project folder.
 */
export async function createProjectMemoryAcp({ host, controllerRoot, sourceId, providerSourceId,
  instanceId, archive, assertVisible, resolveWorkspace, descriptor = null, onInteractionChanged,
  policy = null, enforcesWriteZones = false, commits = null, onCommit = () => {} } = {}) {
  if (!host || typeof resolveWorkspace !== "function" || typeof assertVisible !== "function") {
    fail("memory_provider_unavailable");
  }
  const captures = new Map();
  const interactions = new Map();
  const pendingCommits = new Map();
  const commitOnEnd = async ({ turnId, turn }) => {
    const pending = pendingCommits.get(turnId);
    if (pending === undefined) return;
    pendingCommits.delete(turnId);
    let outcome;
    try {
      outcome = await commits.commitTurn({ ...pending, turnId, status: turn?.status ?? "completed" });
    } catch (error) {
      outcome = { state: "failed", reason: typeof error?.code === "string" ? error.code : "commit_failed" };
    }
    try { onCommit({ agentId: pending.agent.agentId, operationId: pending.operationId, turnId, ...outcome }); } catch { /* a record only */ }
  };
  if (commits !== null) host.on("turn/completed", commitOnEnd);
  const { lease } = await createFileProviderMutationLease({ controllerRoot, projectId: sourceId });
  const captureFor = (agent) => {
    let capture = captures.get(agent.agentId);
    if (!capture) {
      capture = new CodexConversationArchive({ archive, client: host, binding: agent.binding,
        providerId: ACP_PROVIDER_ID });
      capture.observe(); captures.set(agent.agentId, capture);
    }
    return capture;
  };
  const bound = (agent) => {
    const binding = agent.binding;
    if (!binding || binding.providerId !== ACP_PROVIDER_ID || binding.sourceId !== providerSourceId
        || binding.projectId !== sourceId) fail("memory_identity_conflict");
    return binding.threadId;
  };
  const preflight = async (profile) => {
    if (profile.provider !== ACP_PROVIDER_ID || profile.fallbackPolicy !== "deny") fail("memory_provider_unavailable");
    if (!host.models.some((model) => model.id === profile.model && model.efforts.includes(profile.reasoningEffort))) {
      fail("memory_profile_conflict");
    }
    await assertVisible();
    const account = await host.readAccount();
    if (account.account === null) fail("memory_provider_unavailable");
  };
  const interactionFor = async (agent) => {
    if (!descriptor) fail("memory_provider_unavailable");
    if (!interactions.has(agent.agentId)) {
      const capture = captureFor(agent);
      interactions.set(agent.agentId, createApplicationProviderInteractionBridge({
        controllerRoot, projectId: sourceId, client: host, descriptor,
        target: { sourceId: providerSourceId, threadId: bound(agent) },
        conversationId: capture.conversationId, archive: capture,
        onChanged: onInteractionChanged,
      }));
    }
    return interactions.get(agent.agentId);
  };
  return {
    memoryDocuments: false,
    controllerTasks: false,
    // Its answer comes in pieces (agent_message_chunk): a task's plan is their text joined as it came.
    chunkedText: true,
    enforcesWriteZones: enforcesWriteZones === true && typeof policy === "function",
    // The agent keeps its whole conversation; memory is sent again only after it changed.
    async memoryDeliveryKey(agent) {
      const session = await host.readSessionMeta(bound(agent));
      return session === null ? null : "acp";
    },
    preflight,
    resolveWorkspace,
    async create(agent) {
      const workspace = await resolveWorkspace(agent);
      const threadId = await host.createSession({ cwd: workspace.workspacePath });
      return { projectId: sourceId, sourceId: providerSourceId, providerId: ACP_PROVIDER_ID, threadId };
    },
    async send({ agent, operation, text, displayText = null, writeZone }) {
      await preflight(agent.profile);
      const workspace = await resolveWorkspace(agent);
      if (workspace.workspaceKey !== agent.workspaceKey) fail("memory_workspace_conflict");
      const threadId = bound(agent);
      const session = await host.readThread(threadId);
      if (session === null) fail("memory_identity_conflict");
      const capture = captureFor(agent);
      if (descriptor) await interactionFor(agent);
      await capture.flush();
      const owner = { sourceId: providerSourceId, runtimeInstanceId: instanceId, threadId,
        operation: "memory.agent.send", operationId: operation.operationId, correlationId: operation.operationId };
      const intentSha256 = hash({ agentId: agent.agentId, ...operation });
      const acquired = await lease.acquire({ owner, intentSha256 });
      if (!acquired.mutationAllowed) fail("memory_uncertain_outcome");
      const zone = writeZone !== undefined ? writeZone : effectiveWriteZone(agent);
      const before = commits === null ? null : await commits.snapshot(workspace.workspacePath).catch(() => null);
      try {
        const result = await host.startTurn(threadId, [{ type: "text", text }], {
          model: agent.profile.model, effort: agent.profile.reasoningEffort,
          clientUserMessageId: operation.operationId,
          ...(typeof displayText === "string" ? { displayText } : {}),
          ...(typeof policy === "function" ? { policy: policy({ agent, root: workspace.workspacePath, zone }) } : {}),
          // A task's planning turn (agent-tasks.mjs): the host refuses every change in it.
          ...(operation.task?.phase === "plan" ? { planning: true } : {}),
        });
        const turnId = result?.turn?.id;
        if (typeof turnId !== "string" || !turnId) fail("memory_invalid_observation");
        if (before !== null) {
          pendingCommits.set(turnId, { folder: workspace.workspacePath, before, zone, agent,
            operationId: operation.operationId, displayText });
        }
        capture.recordDelivery({ requestId: operation.operationId, deliveryState: "accepted", turnId });
        await capture.flush();
        await lease.release({ owner, intentSha256, leaseId: acquired.record.leaseId,
          outcome: "applied", receiptSha256: hash({ threadId, turnId }) });
        return { turnId, state: "started" };
      } catch (error) {
        const refused = ["acp_session_busy", "memory_profile_conflict", "provider_disconnected",
          "invalid_request"].includes(error?.code);
        await lease.release({ owner, intentSha256, leaseId: acquired.record.leaseId,
          ...(refused ? { outcome: "not-applied", receiptSha256: hash({ threadId, refused: error.code }) }
            : { outcome: "uncertain" }) }).catch(() => {});
        throw error;
      }
    },
    async observe({ agent, operation }) {
      const turn = await host.readTurn(bound(agent), operation.turnId);
      if (turn === null) fail("memory_invalid_observation");
      return { turnId: turn.id, state: acpTurnState(turn),
        observedModel: typeof turn.observedModel === "string" ? turn.observedModel : null,
        failure: typeof turn.failure === "string" ? turn.failure : null };
    },
    /** A message for the running turn: it waits for the agent's current prompt to end. */
    async steer({ agent, operation, text, mode, clientId }) {
      await assertVisible();
      await preflight(agent.profile);
      return host.steerTurn(bound(agent), operation.turnId, [{ type: "text", text }],
        { mode, clientUserMessageId: clientId });
    },
    async unqueue({ agent, operation, clientId }) {
      await assertVisible();
      return host.cancelQueued(bound(agent), operation.turnId, clientId);
    },
    queued(agent) {
      return agent.binding ? host.queuedMessages(bound(agent)) : [];
    },
    async trace(agent, options) {
      return host.readTrace(bound(agent), options);
    },
    async capture(agent) {
      await captureFor(agent).flush();
    },
    async interrupt({ agent, operation }) {
      await assertVisible();
      await host.interruptTurn(bound(agent), operation.turnId);
    },
    ...(descriptor ? {
      async interactionSummary(agent) {
        const bridge = await interactions.get(agent.agentId);
        if (!bridge) fail("memory_provider_unavailable");
        return bridge.summary();
      },
      async listInteractions(agent, input) { return (await interactionFor(agent)).list(input); },
      async respondInteraction(agent, input) {
        await assertVisible();
        return (await interactionFor(agent)).respond(input);
      },
    } : {}),
    async close() {
      if (commits !== null) host.off("turn/completed", commitOnEnd);
      for (const pending of interactions.values()) {
        const bridge = await pending.catch(() => null);
        await bridge?.close();
      }
      for (const capture of captures.values()) await capture.close();
    },
  };
}

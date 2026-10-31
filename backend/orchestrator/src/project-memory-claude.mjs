import { CodexConversationArchive } from "./codex-conversation-archive.mjs";
import { createFileProviderMutationLease } from "./provider-mutation-lease-store.mjs";
import { applicationCanonicalSha256 as hash } from "./application-contract.mjs";
import { createApplicationProviderInteractionBridge } from "./application-provider-interaction-bridge.mjs";
import { CLAUDE_EFFORTS } from "./claude-code-sdk.mjs";
import { CLAUDE_CODE_PROVIDER_ID, claudeTurnState } from "./claude-code-session-host.mjs";
import { claudeSecretHook, claudeWebFetchHook } from "./agent-secret-paths.mjs";
import { claudeWriteZoneHook } from "./agent-write-zone.mjs";
import { effectiveWriteZone } from "./project-memory-service.mjs";

// Desk agents on Claude Code: the provider of ProjectMemoryService that
// project-memory-codex.mjs is for Codex. One agent is one Claude Code session
// (see claude-code-session-host.mjs); one message is one turn of it.
//
// What is checked, and what is not: the account is read before a turn
// (`claude auth status`), the model must be one the machine-local config
// offers, and Claude Code reports the model the session started with and the
// models a turn used - both are recorded with the turn. The effort cannot be
// read back from Claude Code; it is only requested.

export const PROJECT_MEMORY_CLAUDE_VERSION = "v0.4.0";

function fail(code) { throw Object.assign(new Error(code), { code }); }

/**
 * `documents(agent, path)`: writes the approved memory document (the
 * service's writeMemoryFromDocument); with it, every turn carries the desk's
 * tool write_memory_from_document. `taskTools(agent)`: the controller task
 * tools of the agent (desk-agent-task-tools.mjs), carried by every turn too.
 * `taskGate(agent)`: a PreToolUse hook holding the plan gate of the agent's
 * controller task (desk-task-gate.mjs), beside its write zone.
 * `commits`: commits each turn's work to the git of the project folder
 * (agent-turn-commits.mjs); `onCommit(record)` hears how each one went.
 */
export async function createProjectMemoryClaude({ host, controllerRoot, sourceId, providerSourceId,
  instanceId, archive, assertVisible, resolveWorkspace, descriptor = null, onInteractionChanged,
  documents = null, taskTools = null, taskGate = null, commits = null, onCommit = () => {}, webFetchHosts = null } = {}) {
  if (!host || typeof resolveWorkspace !== "function" || typeof assertVisible !== "function") {
    fail("memory_provider_unavailable");
  }
  const captures = new Map();
  const interactions = new Map();
  // The folder's uncommitted files before a turn, by turn id, until the turn ends.
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
        providerId: CLAUDE_CODE_PROVIDER_ID });
      capture.observe(); captures.set(agent.agentId, capture);
    }
    return capture;
  };
  const bound = (agent) => {
    const binding = agent.binding;
    if (!binding || binding.providerId !== CLAUDE_CODE_PROVIDER_ID || binding.sourceId !== providerSourceId
        || binding.projectId !== sourceId) fail("memory_identity_conflict");
    return binding.threadId;
  };
  const preflight = async (profile) => {
    if (profile.provider !== CLAUDE_CODE_PROVIDER_ID || profile.fallbackPolicy !== "deny") {
      fail("memory_provider_unavailable");
    }
    if (!host.models.some((model) => model.id === profile.model && model.efforts.includes(profile.reasoningEffort))
        || (profile.reasoningEffort !== "default" && !CLAUDE_EFFORTS.includes(profile.reasoningEffort))) {
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
  const memoryDocuments = typeof documents === "function" && host.supportsDeskTools === true;
  // What the tool answers the agent: what was written, or why nothing was.
  const memoryDocumentTool = (agent) => ({
    name: "write_memory_from_document",
    description: "Writes a memory document into memory, exactly as the person approved it in the desk. Give the path"
      + " of the document from the root of the project folder. Without the person's approval, or if the document"
      + " changed since, nothing is written and the answer says why.",
    inputSchema: (z) => ({ path: z.string().describe("Path of the document from the root of the project folder,"
      + " for example docs/memory/project.md") }),
    async handler(args) {
      const documentPath = String(args?.path ?? "");
      try {
        const result = await documents(agent, documentPath);
        return `Written: ${result.entries} entries into the ${result.kind} memory, now revision ${result.revision}.`;
      } catch (error) {
        const reasons = {
          memory_document_not_approved: "the person has not approved this document in the desk",
          memory_authorization_consumed: "this approval was already used; ask the person to approve the document again",
          memory_document_changed: "the document changed after the person approved it; ask the person to approve it again",
          memory_revision_conflict: "the memory changed after the approval; ask the person to approve the document again",
          memory_document_missing: "there is no such file in the project folder",
          memory_document_path_invalid: "the path must be a file inside the project folder",
        };
        return `Nothing written: ${reasons[error?.code] ?? `the desk refused (${error?.code ?? "unknown"})`}.`;
      }
    },
  });
  const deskToolsFor = (agent) => [
    ...(memoryDocuments ? [memoryDocumentTool(agent)] : []),
    ...(typeof taskTools === "function" && host.supportsDeskTools === true ? taskTools(agent) : []),
  ];
  return {
    memoryDocuments,
    controllerTasks: typeof taskTools === "function" && host.supportsDeskTools === true,
    // Every tool call is checked against the agent's write zone before it runs
    // (claudeWriteZoneHook), so agents with zones that cannot meet may share a folder.
    enforcesWriteZones: true,
    // Memory is sent again only after it changed or Claude Code compacted the
    // session, which may have dropped it from the conversation.
    async memoryDeliveryKey(agent) {
      const session = await host.readSessionMeta(bound(agent));
      return session === null ? null : `compactions:${session.compactions ?? 0}`;
    },
    preflight,
    resolveWorkspace,
    async create(agent) {
      const workspace = await resolveWorkspace(agent);
      const threadId = await host.createSession({ cwd: workspace.workspacePath });
      return { projectId: sourceId, sourceId: providerSourceId, providerId: CLAUDE_CODE_PROVIDER_ID, threadId };
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
      // A delivery that may have happened is never repeated: an interrupted
      // Claude Code turn continues by itself when the session is next resumed.
      if (!acquired.mutationAllowed) fail("memory_uncertain_outcome");
      // What is attached to the agent: the service knows the catalog (a quarter lead's quarter).
      const zone = writeZone !== undefined ? writeZone : effectiveWriteZone(agent);
      // The agent's own permission mode (set by the person), else the provider's.
      const permissionMode = agent.permissionMode ?? host.permissionMode ?? "acceptEdits";
      const hooks = [
        // Secrets first: every agent, every permission mode; a fetch from an unknown address asks the person
        // (agent-secret-paths.mjs).
        claudeSecretHook({ root: workspace.workspacePath }),
        claudeWebFetchHook(webFetchHosts === null ? {} : { hosts: webFetchHosts }),
        ...(zone === null ? [] : [claudeWriteZoneHook({ root: workspace.workspacePath, patterns: zone, permissionMode })]),
        ...(typeof taskGate === "function" ? [taskGate(agent)] : []),
      ];
      // What the folder holds uncommitted before the turn: what differs after it is the turn's work.
      const before = commits === null ? null : await commits.snapshot(workspace.workspacePath).catch(() => null);
      try {
        const result = await host.startTurn(threadId, [{ type: "text", text }], {
          model: agent.profile.model, effort: agent.profile.reasoningEffort, permissionMode,
          clientUserMessageId: operation.operationId,
          // The chat shows what the person typed; Claude Code gets the memory in front of it.
          ...(typeof displayText === "string" ? { displayText } : {}),
          deskTools: deskToolsFor(agent),
          // Hooks are not part of the prompt: the cached start of it stays the same.
          query: { hooks: { PreToolUse: [{ hooks }] } },
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
        // A refusal before the process started leaves nothing behind (the turn
        // could not even be recorded); the service then frees the agent.
        // Anything later is uncertain and stays so.
        const refused = ["claude_session_busy", "memory_profile_conflict", "provider_disconnected",
          "invalid_request", "claude_journal_unavailable", "claude_journal_invalid", "claude_journal_full",
          "claude_turn_exists", "thread_not_found"].includes(error?.code);
        await lease.release({ owner, intentSha256, leaseId: acquired.record.leaseId,
          ...(refused ? { outcome: "not-applied", receiptSha256: hash({ threadId, refused: error.code }) }
            : { outcome: "uncertain" }) }).catch(() => {});
        if (refused && error && typeof error === "object") error.notDelivered = true;
        throw error;
      }
    },
    async observe({ agent, operation }) {
      const turn = await host.readTurn(bound(agent), operation.turnId);
      if (turn === null) fail("memory_invalid_observation");
      return { turnId: turn.id, state: claudeTurnState(turn),
        observedModel: typeof turn.observedModel === "string" ? turn.observedModel : null,
        failure: typeof turn.failure === "string" ? turn.failure : null };
    },
    /**
     * A message for the agent's running turn: steered in at once, or held for
     * the turn's end (claude-code-session-host steerTurn). The message goes as
     * typed - the turn already has the memory. `turn_not_active` when the turn
     * is over: the service then sends it as a new message.
     */
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
      // A catalog read must not instantiate a bridge, recover its journal, or
      // subscribe a session. Unknown observation remains unavailable, not zero.
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

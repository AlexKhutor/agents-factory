import { createHash } from "node:crypto";
import { createProjectMemoryStore } from "./project-memory-store.mjs";
import { createConversationArchive } from "./conversation-archive.mjs";
import { resolveProviderMutationProjectId } from "./provider-mutation-lease-store.mjs";
import path from "node:path";
import { WRITE_ZONE_LIMITS, normalizeWriteZone, writeZonesOverlap } from "./agent-write-zone.mjs";
import { entriesFromDocument, normalizeDocumentPath, readMemoryDocument } from "./memory-documents.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";
import { createOpenDeskTaskReader } from "./desk-task-index.mjs";
import { listVisibleScopes, requireOpenProject } from "./project-archive.mjs";
import { unmountedWorldProjects } from "./world-registry.mjs";
import { nameOf, readNames } from "./object-names.mjs";

export const PROJECT_MEMORY_SERVICE_VERSION = "v0.9.0";
export const AGENT_ROLES = Object.freeze(["feature", "project-lead", "quarter-lead", "coordinator"]);
/**
 * How an agent's tool calls are approved, as Claude Code's permission modes:
 * manual ("default": edits and changing commands are asked), "acceptEdits"
 * (file edits in the folder pass), "auto" (Claude Code's classifier decides,
 * asking when it cannot) and "bypassPermissions" (nothing is asked). An agent
 * without its own mode takes the provider's (claude-provider.json).
 */
export const AGENT_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto", "bypassPermissions"]);
/** A lead changes only memory documents; its zone is fixed. */
export const LEAD_WRITE_ZONE = Object.freeze(["docs/memory/**"]);
/** The coordinator works in the controller root and writes only task drafts there. */
export const COORDINATOR_WRITE_ZONE = Object.freeze(["coordination/drafts/**"]);
const NO_SETTINGS = Object.freeze({ role: "feature", writeZone: null, revision: 0, updatedAtUtc: null });
const APPROVALS = "memory-document-approvals-v1";
const KEPT_APPROVALS = 32;

/**
 * What an agent is doing now, for the desk and the attention model: working on
 * a message, waiting for the person's answer inside a turn, idle (no message
 * running: it waits for a task), an uncertain delivery that needs the person,
 * closed, or unknown (still being created or failed creation). `sinceUtc` is
 * when that began, as far as the backend saw it. An agent that holds a started
 * controller task (`openTask`, desk-task-index.mjs) is never idle: between
 * messages it waits for the person (its plan's confirmation, say).
 */
export function agentActivity(agent, attention = null, openTask = null) {
  if (["archived", "closing"].includes(agent.state)) return { state: "closed", sinceUtc: agent.archivedAtUtc ?? null };
  if (agent.state !== "active") return { state: "unknown", sinceUtc: null };
  if (agent.currentOperationId) {
    const operation = agent.operations.find((item) => item.operationId === agent.currentOperationId);
    if (operation?.state === "uncertain") return { state: "uncertain", sinceUtc: operation.requestedAtUtc ?? null };
    const asking = attention?.availability === "available"
      && (attention.pendingQuestions ?? 0) + (attention.pendingApprovals ?? 0) > 0;
    return { state: asking ? "waiting-for-person" : "working", sinceUtc: operation?.requestedAtUtc ?? null };
  }
  const last = agent.operations.at(-1);
  const since = last?.settledAtUtc ?? last?.requestedAtUtc ?? agent.createdAtUtc ?? null;
  if (openTask !== null) return { state: "waiting-for-person", sinceUtc: since ?? openTask.startedAtUtc ?? null };
  return { state: "idle", sinceUtc: since };
}

/** An agent's role and write zone; agents created before settings existed are features without a zone. */
export function agentSettings(agent) { return agent.settings ?? NO_SETTINGS; }

/**
 * The paths the agent may change, or null for the whole folder: what is
 * attached to it. A feature agent - its zone (null: the folder). A project lead
 * answers for the whole project - its folder. A quarter lead answers for its
 * quarter - the zones of the quarter's feature agents and the memory documents
 * (the folder, when one of those agents has it). `agents` is the catalog; a
 * quarter lead without it gets only the memory documents. The coordinator
 * writes only task drafts.
 */
export function effectiveWriteZone(agent, agents = []) {
  const settings = agentSettings(agent);
  if (settings.role === "feature") return settings.writeZone;
  if (settings.role === "coordinator") return [...COORDINATOR_WRITE_ZONE];
  if (settings.role === "project-lead") return null;
  const members = agents.filter((other) => other.agentId !== agent.agentId && other.state !== "archived"
    && other.projectId === agent.projectId && other.quarterId === agent.quarterId
    && agentSettings(other).role === "feature");
  if (members.some((other) => agentSettings(other).writeZone === null)) return null;
  return [...new Set([...LEAD_WRITE_ZONE, ...members.flatMap((other) => agentSettings(other).writeZone)])]
    .slice(0, WRITE_ZONE_LIMITS.patterns);
}

function roleLines(agent, { documents, agents = [], names = null }) {
  const settings = agentSettings(agent);
  const zone = effectiveWriteZone(agent, agents);
  // Names change, IDs do not (object-names.mjs): an agent knows its own name and refers to everything by ID.
  const lines = [`Your name: ${nameOf(names, "agent", agent.agentId)} (ID ${agent.agentId}). Projects, quarters and`
    + " agents have names the person may change and IDs that never change: refer to them by ID."];
  if (settings.role === "coordinator") {
    lines.push("Your role: the world lead - the coordinator of this controller, above the project and quarter leads."
      + " You see every project (\"overview\" above: its title, its lead and how many agents work in it). You turn"
      + " the person's confirmed intents into controller tasks for the project leads and the desk agents that take"
      + " tasks, and follow them to their reports with your desk tools (controller_agents, controller_dispatch,"
      + " controller_start_task, controller_task_status, controller_read_report); controller_agents names who"
      + " takes tasks. A task for a project as a whole goes to its lead. Confirm the intent, the outcomes, the"
      + " boundary, the target agent and the return contract (report operation and what you do after the report)"
      + " with the person before dispatching. You never implement an agent's work yourself, and you change files"
      + " only under coordination/drafts/.");
  } else if (settings.role === "project-lead") {
    lines.push(`Your role: lead of project ${agent.projectId}. You are responsible for the whole project: you keep`
      + " its project memory and know its quarters and the agents working in each of them, with their roles and"
      + " models (\"overview\" above). The person talks to you about the project as a whole. The whole project"
      + " folder is yours to change. Parts of it are the write zones of the quarters' agents: when you change"
      + " one of those, say so in your answer, so its agent knows.");
  } else if (settings.role === "quarter-lead") {
    lines.push(`Your role: lead of quarter ${agent.quarterId} of project ${agent.projectId}. You keep its quarter`
      + " memory and an overview of its agents (\"overview\" above). "
      + (zone === null ? "The whole project folder is yours to change, as it is for an agent of your quarter."
        : `You may change the parts of the folder that belong to your quarter: ${zone.join(", ")}. Other`
          + " agents own the rest: read it, but do not change it; if a change is needed there, say so in your answer."));
  } else if (zone !== null) {
    lines.push(`Your write zone in this folder: ${zone.join(", ")}. Other agents own the rest of the folder:`
      + " read it, but do not change it; if a change is needed there, say so in your answer.");
  }
  if (documents && settings.role !== "coordinator") {
    const which = settings.role === "project-lead" ? "your own or the project's memory"
      : settings.role === "quarter-lead" ? "your own or the quarter's memory" : "your own memory";
    lines.push(`To change ${which}, write a memory document in a file you may change (a "# title" line names it,`
      + " each \"## heading\" starts one entry) and ask the person to approve it in the desk. After the approval,"
      + " write it into memory with the desk's tool write_memory_from_document. Memory is never changed without the"
      + " person's approval of the exact document.");
  }
  return lines;
}
const KEY = "memory-agents-v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
/**
 * Turn failures the person can act on (the provider's own code) and the agent's problem each one
 * raises: it stays until one of the agent's turns completes again.
 */
const FAILURE_PROBLEMS = Object.freeze(new Map([
  ["acp_model_unreachable", "model_unreachable"],
  ["claude_signed_out", "claude_signed_out"],
]));
const TURN_PROBLEMS = new Set(FAILURE_PROBLEMS.values());
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code) { throw Object.assign(new Error(code), { code }); }
function problem(error) {
  return typeof error?.code === "string" && /^memory_[a-z_]{1,64}$/.test(error.code)
    ? error.code : "memory_operation_unconfirmed";
}
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))) fail("memory_invalid_input");
}
function id(value) { if (typeof value !== "string" || !ID.test(value)) fail("memory_invalid_input"); return value; }
function profile(value) {
  exact(value, ["provider", "model", "reasoningEffort", "fallbackPolicy"]);
  [value.provider, value.model, value.reasoningEffort].forEach(id);
  if (value.fallbackPolicy !== "deny") fail("memory_invalid_input");
  return { provider: value.provider, model: value.model,
    reasoningEffort: value.reasoningEffort, fallbackPolicy: "deny" };
}
function reference(scope) { return { scopeId: scope.scopeId, revision: scope.revision, sha256: scope.sha256 }; }
/**
 * What an agent must have received: its project and quarter memory, and its
 * own memory when it has one. Agents created before agent memory existed keep
 * the two-scope manifest and its hash.
 */
function manifestOf(pair, own = null) {
  const body = { project: reference(pair.project), quarter: reference(pair.quarter),
    ...(own ? { agent: reference(own) } : {}) };
  return { ...body, manifestHash: hash(body) };
}
/** The scope of an agent's own memory; derived from the agent ID so it fits any ID length. */
export function agentMemoryScopeId(agentId) {
  return `agent-memory:${createHash("sha256").update(id(agentId)).digest("hex").slice(0, 32)}`;
}
/**
 * A send operation as the Gateway returns it. A field named `memory` reads as
 * a memory body to the Gateway's privacy check and fails the whole answer, so
 * the delivery mark is `memorySnapshot`; operations recorded before carry it
 * as `memory`.
 */
function publicOperation(op) {
  if (!op) return op;
  const { memory, ...rest } = structuredClone(op);
  return memory === undefined || rest.memorySnapshot !== undefined ? rest : { ...rest, memorySnapshot: memory };
}

function publicAgent(agent) {
  // The permission mode is read through the trusted host (readPermissionModes), not the public agent.
  const { operations, createHash, workspaceKey, stops, settings, memoryDelivery, profileChangedAtUtc,
    permissionMode, ...view } = agent;
  const last = operations.at(-1);
  return structuredClone({ ...view, settings: agentSettings(agent), lastOperation: last
    ? { operationId: last.operationId, state: last.state,
      ...(typeof last.observedModel === "string" ? { observedModel: last.observedModel } : {}) } : null });
}

// What a tool printed may carry a secret: in the trace it is masked, the way
// the Gateway's privacy check would refuse it (application-contract.mjs).
const TRACE_SECRETS = Object.freeze([
  /data:(?:image|audio|video)\/[^\s"'<>)]*/giu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
]);
function maskTrace(value) {
  if (typeof value !== "string") return value ?? null;
  return TRACE_SECRETS.reduce((text, pattern) => text.replace(pattern, "[hidden]"), value);
}
const TRACE_KEYS = Object.freeze(["atUtc", "turnId", "type", "model", "effort", "cwd", "claudeCodeVersion",
  "trigger", "preTokens", "text", "displayText", "toolUseId", "tool", "input", "isError", "output", "diff",
  "clientId", "delivery", "reason", "status", "failure", "resultSubtype", "durationMs", "numTurns", "costUsd",
  "usage", "models"]);
/** A trace record as the Gateway returns it: known fields only, secrets masked. */
function maskTraceRecord(record) {
  const result = {};
  for (const key of TRACE_KEYS) {
    if (!Object.hasOwn(record ?? {}, key)) continue;
    const value = record[key];
    result[key] = typeof value === "string" ? maskTrace(value) : structuredClone(value);
  }
  return result;
}

export class ProjectMemoryService {
  constructor({ store, provider = null, archive, now = () => new Date(), openTasks = async () => new Map(), worldProjects = null }) {
    Object.assign(this, { store, provider, archive, now, openTasks, worldProjects });
  }
  /**
   * A provider flag for one agent: under the provider router
   * (project-memory-provider-router.mjs) it is the flag of that agent's provider.
   */
  providerFlag(agent, name) {
    if (typeof this.provider?.flagFor === "function") return this.provider.flagFor(agent, name);
    return this.provider?.[name] === true;
  }
  /** Ends the store and archive bridges once the calls already sent are done. */
  async close() {
    await this.store?.close?.();
    await this.archive?.close?.();
  }
  async catalog() {
    return await this.store.readDocument({ key: KEY }) ?? { revision: 0, value: { agents: [] } };
  }
  async change(update) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const doc = await this.catalog();
      const result = update(doc.value);
      if (await this.store.compareAndSwapDocument({ key: KEY,
        expectedRevision: doc.revision, value: doc.value })) return result;
    }
    fail("memory_contention");
  }
  find(doc, agentId) {
    const agent = doc.agents.find((item) => item.agentId === id(agentId));
    if (!agent) fail("memory_agent_not_found");
    return agent;
  }
  async listAgents(input = {}) {
    exact(input, ["projectId", "quarterId"]);
    if (input.projectId !== undefined) id(input.projectId);
    if (input.quarterId !== undefined) id(input.quarterId);
    const doc = await this.catalog();
    const agents = doc.value.agents
      .filter((agent) => (!input.projectId || agent.projectId === input.projectId)
        && (!input.quarterId || agent.quarterId === input.quarterId));
    const views = [];
    const open = await this.openTasks();
    const pairs = new Map();
    // Agents' own memories in one store call, not one per agent.
    const owned = new Map((await this.store.readScopes({ scopeIds: agents
      .filter((agent) => agent.state !== "archived" && agent.agentScopeId)
      .map((agent) => agent.agentScopeId) })).map((scope) => [scope.scopeId, scope]));
    for (const agent of agents) {
      const key = JSON.stringify([agent.projectId, agent.quarterId]);
      if (agent.state !== "archived" && !pairs.has(key)) {
        pairs.set(key, await this.store.readPair({ projectId: agent.projectId, quarterId: agent.quarterId }));
      }
      const context = await this.agentContext(agent, pairs.get(key), owned.get(agent.agentScopeId));
      const attention = await this.attention(agent);
      views.push({ ...publicAgent(agent), requiredManifest: context.requiredManifest,
        deliveryState: context.deliveryState, contentState: context.contentState,
        attention, activity: agentActivity(agent, attention, open.get(agent.agentId) ?? null) });
    }
    return { schemaVersion: 1, revision: doc.revision, agents: views,
      totalAgents: views.length, truncated: false, omissionCount: 0 };
  }
  /**
   * Every agent's activity from the catalog alone, without memory or provider
   * reads: one store call, for the attention model's idle agents.
   */
  async listActivity() {
    const doc = await this.catalog();
    const open = await this.openTasks();
    return doc.value.agents.map((agent) => ({ agentId: agent.agentId, projectId: agent.projectId,
      quarterId: agent.quarterId, state: agent.state, settings: agentSettings(agent),
      activity: agentActivity(agent, null, open.get(agent.agentId) ?? null) }));
  }
  /**
   * Two agents of one folder may run at the same time only under a provider
   * that holds write zones, when both have a zone and the zones cannot meet.
   */
  mayCollide(left, right, agents = []) {
    // Both agents' providers must hold zones: a zone a provider cannot enforce protects nothing.
    if (!this.providerFlag(left, "enforcesWriteZones") || !this.providerFlag(right, "enforcesWriteZones")) return true;
    const leftZone = effectiveWriteZone(left, agents);
    const rightZone = effectiveWriteZone(right, agents);
    return leftZone === null || rightZone === null || writeZonesOverlap(leftZone, rightZone);
  }
  /**
   * Sets an agent's role and write zone. A trusted local command only (the
   * memory CLI after the person's confirmation), never a public operation:
   * like memory, a zone is the person's decision.
   */
  async setAgentSettings(input) {
    exact(input, ["agentId", "expectedRevision", "role", "writeZone"]);
    const agentId = id(input.agentId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || !AGENT_ROLES.includes(input.role)) fail("memory_invalid_input");
    const writeZone = input.writeZone === null ? null : normalizeWriteZone(input.writeZone);
    if (input.role !== "feature" && writeZone !== null) fail("memory_invalid_input");
    await this.change((doc) => {
      const agent = this.find(doc, agentId);
      if (agent.state === "archived") fail("memory_agent_closed");
      const current = agentSettings(agent);
      if (current.revision !== input.expectedRevision) fail("memory_revision_conflict");
      // One lead per project and one per quarter; one coordinator for the controller.
      if (input.role !== "feature" && doc.agents.some((other) => other.agentId !== agentId
          && other.state !== "archived" && agentSettings(other).role === input.role
          && (input.role === "coordinator" || (other.projectId === agent.projectId
            && (input.role === "project-lead" || other.quarterId === agent.quarterId))))) fail("memory_role_taken");
      agent.settings = { role: input.role, writeZone, revision: current.revision + 1,
        updatedAtUtc: this.now().toISOString() };
    });
    return this.readAgent({ agentId });
  }
  /**
   * The agent's permission mode, the person's decision like its role: set by
   * the trusted host, never by an agent or a public call. Null goes back to the
   * provider's mode. It applies from the agent's next turn.
   */
  async setAgentPermissionMode(input) {
    exact(input, ["agentId", "permissionMode"]);
    const agentId = id(input.agentId);
    if (input.permissionMode !== null && !AGENT_PERMISSION_MODES.includes(input.permissionMode)) {
      fail("memory_invalid_input");
    }
    let changed = false;
    await this.change((doc) => {
      const agent = this.find(doc, agentId);
      if (agent.state === "archived") fail("memory_agent_closed");
      changed = (agent.permissionMode ?? null) !== input.permissionMode;
      if (input.permissionMode === null) delete agent.permissionMode;
      else agent.permissionMode = input.permissionMode;
    });
    return { agentId, permissionMode: input.permissionMode, changed };
  }
  /** Every agent's own permission mode (null: the provider's), for the trusted host's window. */
  async readPermissionModes() {
    const agents = (await this.catalog()).value.agents;
    return { agents: agents.map((agent) => ({ agentId: agent.agentId, permissionMode: agent.permissionMode ?? null })) };
  }
  /** Read-modify-compare-and-swap of one store document. */
  async changeDocument(key, update) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await this.store.readDocument({ key });
      const value = current?.value ?? { approvals: [] };
      const result = update(value);
      if (await this.store.compareAndSwapDocument({ key, expectedRevision: current?.revision ?? 0, value })) return result;
    }
    fail("memory_contention");
  }
  approvalsKey(agentId) {
    return `${APPROVALS}:${createHash("sha256").update(id(agentId)).digest("hex").slice(0, 32)}`;
  }
  /** The memories an agent may fill from a document: its own; its project's or quarter's when it leads them. */
  async documentTargets(agent) {
    const role = agentSettings(agent).role;
    const targets = [];
    if (agent.agentScopeId) targets.push({ kind: "agent", scope: await this.store.readScope({ scopeId: agent.agentScopeId }) });
    if (role !== "feature") {
      const pair = await this.store.readPair({ projectId: agent.projectId, quarterId: agent.quarterId });
      if (role === "project-lead") targets.push({ kind: "project", scope: pair.project });
      if (role === "quarter-lead") targets.push({ kind: "quarter", scope: pair.quarter });
    }
    return targets;
  }
  async documentOf(agent, documentPath) {
    const workspace = await resolveProjectWorkspace(this.store, agent.projectId);
    const document = await readMemoryDocument(workspace.workspacePath, documentPath);
    return { document, entries: entriesFromDocument(document.text, path.posix.basename(document.path)) };
  }
  /** What approving a document would write: for the trusted host to show the person before it asks. */
  async previewMemoryDocument(input) {
    exact(input, ["agentId", "path", "target"]);
    const agent = this.find((await this.catalog()).value, input.agentId);
    if (agent.state === "archived") fail("memory_agent_closed");
    const target = (await this.documentTargets(agent)).find((item) => item.kind === input.target);
    if (!target) fail("memory_document_target_denied");
    const { document, entries } = await this.documentOf(agent, input.path);
    return { schemaVersion: 1, agentId: agent.agentId, path: document.path, contentSha256: document.contentSha256,
      bytes: document.bytes, target: { kind: target.kind, scopeId: target.scope.scopeId, revision: target.scope.revision },
      entries: entries.map((entry) => ({ id: entry.id, title: entry.title, characters: entry.text.length })),
      excerpt: document.text.slice(0, 1200) };
  }
  /**
   * The person's approval of one exact document for one memory: a trusted
   * local command (the memory CLI after the person confirmed the preview).
   * It records the store's grant for exactly these entries at the memory's
   * current revision; `apply` writes them at once, otherwise the agent's tool
   * does. A newer approval of the same path supersedes an unused older one.
   */
  async approveMemoryDocument(input) {
    exact(input, ["commandId", "agentId", "path", "target", "expectedSha256", "apply"]);
    if (typeof input.apply !== "boolean") fail("memory_invalid_input");
    const agent = this.find((await this.catalog()).value, input.agentId);
    if (agent.state === "archived") fail("memory_agent_closed");
    const target = (await this.documentTargets(agent)).find((item) => item.kind === input.target);
    if (!target) fail("memory_document_target_denied");
    const { document, entries } = await this.documentOf(agent, input.path);
    if (document.contentSha256 !== input.expectedSha256) fail("memory_document_changed");
    await this.store.authorizeWrite({ commandId: id(input.commandId), scopeId: target.scope.scopeId,
      expectedRevision: target.scope.revision, entries, requestedBy: agent.agentId });
    const approval = { commandId: input.commandId, path: document.path, contentSha256: document.contentSha256,
      kind: target.kind, scopeId: target.scope.scopeId, expectedRevision: target.scope.revision,
      approvedAtUtc: this.now().toISOString(), state: "approved", writtenRevision: null };
    await this.changeDocument(this.approvalsKey(agent.agentId), (value) => {
      if (value.approvals.some((item) => item.commandId === approval.commandId)) return;
      for (const item of value.approvals) {
        if (item.path === approval.path && item.state === "approved") item.state = "superseded";
      }
      value.approvals.push(approval);
      value.approvals.splice(0, Math.max(0, value.approvals.length - KEPT_APPROVALS));
    });
    if (!input.apply) return { ...approval, write: null };
    // The person's own button: the person is the author of this revision.
    return { ...approval, write: await this.applyApproval(agent, approval, "project-owner") };
  }
  /** The agent's tool: writes the latest approval of this document, if it is still exactly as approved. */
  async writeMemoryFromDocument(input) {
    exact(input, ["agentId", "path"]);
    const agent = this.find((await this.catalog()).value, input.agentId);
    if (agent.state !== "active") fail("memory_agent_closed");
    const relative = normalizeDocumentPath(input.path);
    const current = await this.store.readDocument({ key: this.approvalsKey(agent.agentId) });
    const approval = (current?.value.approvals ?? []).filter((item) => item.path === relative).at(-1);
    if (!approval || approval.state === "superseded") fail("memory_document_not_approved");
    if (approval.state === "written") fail("memory_authorization_consumed");
    return this.applyApproval(agent, approval, agent.agentId);
  }
  async applyApproval(agent, approval, actorId) {
    const { document, entries } = await this.documentOf(agent, approval.path);
    if (document.contentSha256 !== approval.contentSha256) fail("memory_document_changed");
    const receipt = await this.store.write({ scopeId: approval.scopeId, expectedRevision: approval.expectedRevision,
      entries, operationId: `document-write:${hash(approval.commandId).slice(0, 32)}`,
      commandId: approval.commandId, actorId });
    await this.changeDocument(this.approvalsKey(agent.agentId), (value) => {
      const stored = value.approvals.find((item) => item.commandId === approval.commandId);
      if (stored) Object.assign(stored, { state: "written", writtenRevision: receipt.revision });
    });
    return { kind: approval.kind, scopeId: approval.scopeId, revision: receipt.revision, entries: entries.length };
  }
  /**
   * What a lead oversees, by titles only: the project's quarters, the
   * quarter's agents, or - for the world lead (the coordinator) - every other
   * open project with its lead and how many agents work in it. Each one with
   * its name (object-names.mjs) beside its ID.
   */
  async overviewFor(agent, agents) {
    const role = agentSettings(agent).role;
    const namesOf = async (projectId) => readNames(this.store, projectId).catch(() => null);
    if (role === "coordinator") {
      // Only what changes rarely, as for the other leads: the overview is part
      // of the memory delivery key. Which agents take tasks right now is the
      // coordinator's tool controller_agents, read when it needs it.
      const projects = (await listVisibleScopes(this.store)).scopes
        .filter((scope) => scope.kind === "project" && scope.projectId !== agent.projectId).slice(0, 128);
      const overview = { projects: await Promise.all(projects.map(async (scope) => {
        const members = agents.filter((other) => other.agentId !== agent.agentId && other.state !== "archived"
          && other.projectId === scope.projectId);
        const lead = members.find((other) => agentSettings(other).role === "project-lead") ?? null;
        const names = await namesOf(scope.projectId);
        return { projectId: scope.projectId, name: nameOf(names, "project", scope.projectId), title: scope.title,
          lead: lead?.agentId ?? null, leadName: lead ? nameOf(names, "agent", lead.agentId) : null, agents: members.length };
      })) };
      // Projects the world knows that are not on this PC: their title only
      // (docs/project-package.md §7.2); their content is not here to read.
      const away = typeof this.worldProjects === "function"
        ? (await this.worldProjects()).filter((project) => !project.archived).slice(0, 128) : [];
      if (away.length === 0) return overview;
      return { ...overview,
        notHere: "Projects marked not-here are on another PC: only their title is known here; their agents cannot be reached from this PC.",
        projectsNotHere: away.map((project) => ({ projectId: project.projectId, title: project.title, availability: "not-here" })) };
    }
    if (role === "project-lead") {
      const listed = (await this.store.listScopes({ projectId: agent.projectId })).scopes
        .filter((scope) => scope.kind === "quarter").slice(0, 128);
      const scopes = await this.store.readScopes({ scopeIds: listed.map((scope) => scope.scopeId) });
      const names = await namesOf(agent.projectId);
      // Who works in each quarter, briefly: the lead knows its people. Only
      // what changes rarely (role, model): the overview is part of the memory
      // delivery key, and a busy/idle flag would resend the memory every time.
      const members = (quarterId) => agents.filter((other) => other.agentId !== agent.agentId
        && other.state !== "archived" && other.projectId === agent.projectId && other.quarterId === quarterId)
        .slice(0, 64).map((other) => ({ agentId: other.agentId, name: nameOf(names, "agent", other.agentId),
          role: agentSettings(other).role, model: other.profile?.model ?? null }));
      return { quarters: scopes.map((scope) => ({ quarterId: scope.quarterId, name: nameOf(names, "quarter", scope.quarterId),
        title: scope.title, memory: scope.entries.map((entry) => entry.title), agents: members(scope.quarterId) })) };
    }
    if (role === "quarter-lead") {
      const members = agents.filter((other) => other.agentId !== agent.agentId && other.state !== "archived"
        && other.projectId === agent.projectId && other.quarterId === agent.quarterId).slice(0, 128);
      const scopes = new Map((await this.store.readScopes({ scopeIds: members
        .filter((other) => other.agentScopeId).map((other) => other.agentScopeId) }))
        .map((scope) => [scope.scopeId, scope]));
      const names = await namesOf(agent.projectId);
      return { agents: members.map((other) => ({ agentId: other.agentId, name: nameOf(names, "agent", other.agentId),
        role: agentSettings(other).role,
        model: other.profile?.model ?? null, writeZone: effectiveWriteZone(other),
        memory: scopes.get(other.agentScopeId)?.entries.map((entry) => entry.title) ?? [] })) };
    }
    return null;
  }
  async readAgent(input) {
    exact(input, ["agentId"]);
    const agent = this.find((await this.catalog()).value, input.agentId);
    const context = await this.agentContext(agent);
    const attention = await this.attention(agent);
    const open = await this.openTasks();
    return { ...publicAgent(agent), requiredManifest: context.requiredManifest,
      deliveryState: context.deliveryState, contentState: context.contentState,
      attention, activity: agentActivity(agent, attention, open.get(agent.agentId) ?? null) };
  }
  async attention(agent) {
    const absent = { availability: "unavailable", coverage: "captured-only",
      sourceSequence: null, sourceRevision: null, pendingQuestions: null,
      pendingApprovals: null, recoveryRequired: null, observedAtUtc: null };
    if (!agent.binding || typeof this.provider?.interactionSummary !== "function") return absent;
    try {
      const result = await this.provider.interactionSummary(agent);
      const numbers = ["sourceSequence", "sourceRevision", "pendingQuestions", "pendingApprovals", "recoveryRequired"];
      if (result?.availability !== "available" || result.coverage !== "captured-only"
          || numbers.some((key) => !Number.isSafeInteger(result[key]) || result[key] < 0)
          || !Number.isFinite(Date.parse(result.observedAtUtc))) return absent;
      return { availability: "available", coverage: "captured-only",
        ...Object.fromEntries(numbers.map((key) => [key, result[key]])), observedAtUtc: result.observedAtUtc };
    } catch { return absent; }
  }
  async createAgent(input) {
    exact(input, ["agentId", "projectId", "quarterId", "operationId", "profile"]);
    const normalized = { agentId: id(input.agentId), projectId: id(input.projectId),
      quarterId: id(input.quarterId), operationId: id(input.operationId), profile: profile(input.profile) };
    const digest = hash(normalized);
    const existing = (await this.catalog()).value.agents.find((a) => a.agentId === normalized.agentId);
    if (existing) {
      if (existing.createHash !== digest) fail("memory_identity_conflict");
      return publicAgent(existing);
    }
    const pair = await this.store.readPair({ projectId: normalized.projectId, quarterId: normalized.quarterId });
    if (!this.provider) fail("memory_provider_unavailable");
    await this.provider.preflight(normalized.profile);
    const workspaceKey = this.provider.resolveWorkspace
      ? (await this.provider.resolveWorkspace(normalized)).workspaceKey : null;
    // The agent's own memory, empty at first. Creation is idempotent by its
    // operation ID, so a repeated agent creation finds the same scope.
    const agentScopeId = agentMemoryScopeId(normalized.agentId);
    const own = await this.store.createScope({ scopeId: agentScopeId, kind: "agent",
      projectId: normalized.projectId, quarterId: normalized.quarterId, title: normalized.agentId,
      operationId: `create-${agentScopeId}` });
    const agent = { ...normalized, createHash: digest, state: "creating", binding: null,
      workspaceKey, agentScopeId,
      assignedManifest: manifestOf(pair, own), deliveredManifest: null, currentOperationId: null,
      createdAtUtc: this.now().toISOString(), archivedAtUtc: null,
      coverage: "captured-only", operations: [] };
    const claimed = await this.change((doc) => {
      if (doc.agents.some((a) => a.agentId === agent.agentId)) return false;
      if (doc.agents.some((a) => a.operationId === agent.operationId)) fail("memory_identity_conflict");
      if (doc.agents.length >= 128) fail("memory_capacity_exceeded");
      doc.agents.push(agent); return true;
    });
    if (!claimed) return this.createAgent(normalized);
    try {
      const binding = await this.provider.create(agent);
      await this.change((doc) => {
        if (doc.agents.some((a) => a.agentId !== agent.agentId && a.binding
          && hash(a.binding) === hash(binding))) fail("memory_identity_conflict");
        Object.assign(this.find(doc, agent.agentId), { binding, state: "active" });
      });
    } catch (error) {
      await this.change((doc) => {
        Object.assign(this.find(doc, agent.agentId), { state: "uncertain", problemCode: problem(error) });
      });
    }
    return this.readAgent({ agentId: agent.agentId });
  }
  async send(input) {
    exact(input, ["agentId", "operationId", "text"]);
    const agentId = id(input.agentId), operationId = id(input.operationId);
    if (typeof input.text !== "string" || !input.text.trim()
      || Buffer.byteLength(input.text, "utf8") > 16384
      || /data:(?:image|audio|video)\//iu.test(input.text)) fail("memory_invalid_input");
    const intentHash = hash({ agentId, operationId, text: input.text });
    let agent = this.find((await this.catalog()).value, agentId);
    const previous = agent.operations.find((op) => op.operationId === operationId);
    if (previous) {
      if (previous.intentHash !== intentHash) fail("memory_identity_conflict");
      return this.receipt({ agentId, operationId });
    }
    if (agent.state !== "active") fail("memory_agent_closed");
    if (!this.provider) fail("memory_provider_unavailable");
    if (agent.currentOperationId) await this.receipt({ agentId, operationId: agent.currentOperationId });
    await this.provider.preflight(agent.profile);
    if (this.provider.resolveWorkspace) {
      const workspace = await this.provider.resolveWorkspace(agent);
      if (workspace.workspaceKey !== agent.workspaceKey) fail("memory_workspace_conflict");
    }
    const context = await this.context({ agentId });
    const manifest = context.requiredManifest;
    // Memory goes again only when it may be missing from the conversation: a
    // provider that can tell (memoryDeliveryKey) gets it when the manifest or
    // the agent's settings changed, when the provider compacted the
    // conversation, or when the last message did not complete. Others get it
    // with every message, as before.
    const deliveryKey = typeof this.provider.memoryDeliveryKey === "function"
      ? await this.provider.memoryDeliveryKey(agent) : null;
    const agents = (await this.catalog()).value.agents;
    const overview = await this.overviewFor(agent, agents);
    // The role says what the agent may change; its text is part of the key, so
    // a changed rule reaches an agent that already had the memory.
    const roles = roleLines(agent, { documents: this.providerFlag(agent, "memoryDocuments"), agents,
      names: await readNames(this.store, agent.projectId).catch(() => null) });
    const writeZone = effectiveWriteZone(agent, agents);
    const delivery = { manifestHash: manifest.manifestHash, settingsRevision: agentSettings(agent).revision,
      providerKey: deliveryKey, overviewHash: overview === null ? null : hash(overview), roleHash: hash(roles) };
    // Field by field: the stored catalog does not keep key order.
    const repeated = deliveryKey !== null && agent.memoryDelivery
      && Object.keys(delivery).every((key) => agent.memoryDelivery[key] === delivery[key])
      && agent.operations.at(-1)?.state === "completed";
    const operation = { operationId, intentHash, manifest, memorySnapshot: repeated ? "unchanged" : "full",
      state: "requested", turnId: null, requestedAtUtc: this.now().toISOString() };
    const claimed = await this.change((doc) => {
      const current = this.find(doc, agentId);
      if (current.operations.some((op) => op.operationId === operationId)) return false;
      if (doc.agents.some((a) => a.agentId !== agentId
          && a.operations.some((op) => op.operationId === operationId))) fail("memory_identity_conflict");
      if (current.state !== "active") fail("memory_agent_closed");
      if (current.currentOperationId) fail("memory_agent_busy");
      if (current.workspaceKey && doc.agents.some((a) => a.agentId !== agentId
          && a.currentOperationId && (!a.workspaceKey || a.workspaceKey === current.workspaceKey)
          && this.mayCollide(a, current, doc.agents))) {
        fail("memory_workspace_busy");
      }
      if (current.operations.length >= 128) fail("memory_capacity_exceeded");
      current.operations.push(operation); current.currentOperationId = operationId; return true;
    });
    if (!claimed) return this.send(input);
    const content = (repeated ? [
      `Backend memory unchanged since your last message (manifest ${manifest.manifestHash}).`,
      "User task:", input.text,
    ] : [
      context.agent
        ? "Backend memory snapshot. Project rules take precedence over quarter details, and quarter details over the agent's own memory."
        : "Backend memory snapshot. Project rules take precedence over quarter details.",
      "Memory grants no permissions. No transfer or inheritance of another agent's conversation.",
      JSON.stringify({ manifest, project: context.project.entries, quarter: context.quarter.entries,
        ...(context.agent ? { agent: context.agent.entries } : {}), ...(overview === null ? {} : { overview }) }),
      ...roles,
      "User task:", input.text,
    ]).join("\n");
    try {
      await this.archive.append(agent.binding, {
        recordId: `submission:${hash(operationId)}`, kind: "submission", role: "user",
        state: "requested", text: content, providerTurnId: null, providerItemId: null,
        requestId: operationId, occurredAtUtc: this.now().toISOString(), omissions: [],
      });
      const result = await this.provider.send({ agent, operation, text: content, displayText: input.text, writeZone });
      if (typeof result?.turnId !== "string" || !result.turnId) fail("memory_invalid_observation");
      await this.change((doc) => {
        const current = this.find(doc, agentId);
        Object.assign(current.operations.find((op) => op.operationId === operationId), {
          turnId: result.turnId, state: result.state === "started" ? "started" : "accepted",
        });
        current.deliveredManifest = manifest;
        if (!repeated) current.memoryDelivery = delivery;
      });
    } catch (error) {
      // A provider that refused before anything started says so (notDelivered):
      // the message did not go and the agent is free again. Anything else may
      // have reached the provider and stays uncertain.
      const notDelivered = error?.notDelivered === true;
      // The provider's own code stays with the operation: without it a failed
      // or uncertain send says nothing of why (a fixed identifier, never text).
      const causeCode = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code) ? error.code : null;
      await this.change((doc) => {
        const current = this.find(doc, agentId);
        Object.assign(current.operations.find((op) => op.operationId === operationId), { causeCode }, notDelivered
          ? { state: "failed", settledAtUtc: this.now().toISOString(),
            problemCode: problem(error) === "memory_operation_unconfirmed" ? "memory_send_not_started" : problem(error) }
          : { state: "uncertain", problemCode: problem(error) });
        if (notDelivered && current.currentOperationId === operationId) current.currentOperationId = null;
      });
    }
    agent = this.find((await this.catalog()).value, agentId);
    return publicOperation(agent.operations.find((op) => op.operationId === operationId));
  }
  async receipt(input) {
    exact(input, ["agentId", "operationId"]);
    const agentId = id(input.agentId), operationId = id(input.operationId);
    const agent = this.find((await this.catalog()).value, agentId);
    let op = agent.operations.find((item) => item.operationId === operationId);
    if (!op) fail("memory_operation_not_found");
    let observation = TERMINAL.has(op.state) ? "terminal" : "unavailable";
    if (op.turnId && this.provider && !TERMINAL.has(op.state)) {
      try {
        const observed = await this.provider.observe({ agent, operation: op });
        if (observed.turnId !== op.turnId) fail("memory_invalid_observation");
        observation = "available";
        if (TERMINAL.has(observed.state) || observed.state === "started") {
          await this.change((doc) => {
            const current = this.find(doc, agentId);
            const stored = current.operations.find((item) => item.operationId === operationId);
            if (!TERMINAL.has(stored.state)) stored.state = observed.state;
            // The model that actually answered (Claude Code reports it).
            if (typeof observed.observedModel === "string" && /^[A-Za-z0-9._:\[\]-]{1,160}$/u.test(observed.observedModel)) {
              stored.observedModel = observed.observedModel;
            }
            // A model that did not answer, or a lost sign-in, is the agent's problem until one of its turns
            // completes again (attention in Atlas, even after the person saw the failed turn).
            if (stored.state === "failed" && FAILURE_PROBLEMS.has(observed.failure)) {
              current.problemCode = FAILURE_PROBLEMS.get(observed.failure);
            } else if (stored.state === "completed" && TURN_PROBLEMS.has(current.problemCode)) {
              current.problemCode = null;
            }
            // When the backend saw the message end: the agent is idle from then on.
            if (TERMINAL.has(stored.state) && !stored.settledAtUtc) stored.settledAtUtc = this.now().toISOString();
            if (TERMINAL.has(stored.state) && current.currentOperationId === operationId) current.currentOperationId = null;
          });
        }
      } catch { /* The durable receipt remains authoritative when observation is unavailable. */ }
    }
    op = this.find((await this.catalog()).value, agentId).operations.find((item) => item.operationId === operationId);
    return { ...publicOperation(op), observation };
  }
  async closeAgent(input) {
    exact(input, ["agentId", "operationId"]);
    const agentId = id(input.agentId), operationId = id(input.operationId);
    let agent = this.find((await this.catalog()).value, agentId);
    if (agent.closeOperationId && agent.closeOperationId !== operationId) fail("memory_identity_conflict");
    if (agent.state === "archived") return publicAgent(agent);
    if (agent.currentOperationId) await this.receipt({ agentId, operationId: agent.currentOperationId });
    await this.change((doc) => {
      const current = this.find(doc, agentId);
      if (current.closeOperationId && current.closeOperationId !== operationId) fail("memory_identity_conflict");
      if (!["active", "closing"].includes(current.state)) fail("memory_agent_busy");
      if (current.currentOperationId) fail("memory_agent_busy");
      current.state = "closing"; current.closeOperationId = operationId;
    });
    agent = this.find((await this.catalog()).value, agentId);
    if (this.provider) await this.provider.capture(agent);
    else if (agent.operations.length) fail("memory_provider_unavailable");
    await this.archive.read(agent.binding, { limit: 1 });
    await this.change((doc) => {
      Object.assign(this.find(doc, agentId), { state: "archived", archivedAtUtc: this.now().toISOString() });
    });
    return this.readAgent({ agentId });
  }
  /**
   * Opens a closed agent again (the undo of its closing, action-journal-undo.mjs):
   * the same agent with its conversation, memory and settings, in a project and
   * quarter that are not archived, while no other open agent holds its role.
   */
  async reopenAgent(input) {
    exact(input, ["agentId"]);
    const agentId = id(input.agentId);
    const agent = this.find((await this.catalog()).value, agentId);
    if (agent.state !== "archived") fail("memory_agent_open");
    await requireOpenProject(this.store, agent.projectId, agent.quarterId);
    await this.change((doc) => {
      const current = this.find(doc, agentId);
      if (current.state !== "archived") fail("memory_agent_open");
      const role = agentSettings(current).role;
      if (role !== "feature" && doc.agents.some((other) => other.agentId !== agentId && other.state !== "archived"
          && agentSettings(other).role === role && (role === "coordinator" || (other.projectId === current.projectId
            && (role === "project-lead" || other.quarterId === current.quarterId))))) fail("memory_role_taken");
      current.state = "active";
      current.archivedAtUtc = null;
      delete current.closeOperationId;
    });
    return this.readAgent({ agentId });
  }
  async interrupt(input) {
    exact(input, ["agentId", "operationId"]);
    const agentId = id(input.agentId), operationId = id(input.operationId);
    if (!this.provider?.interrupt) fail("memory_provider_unavailable");
    const agent = this.find((await this.catalog()).value, agentId);
    const previous = agent.stops?.find((stop) => stop.operationId === operationId);
    if (previous) return structuredClone(previous);
    const operation = agent.operations.find((op) => op.operationId === operationId);
    if (!operation?.turnId || agent.currentOperationId !== operationId || TERMINAL.has(operation.state)) {
      fail("memory_identity_conflict");
    }
    const stop = { operationId, turnId: operation.turnId, state: "requested", automaticRetryAllowed: false };
    const claimed = await this.change((doc) => {
      const current = this.find(doc, agentId);
      current.stops ??= [];
      if (current.stops.some((s) => s.operationId === operationId)) return false;
      if (current.currentOperationId !== operationId) fail("memory_identity_conflict");
      current.stops.push(stop); return true;
    });
    if (!claimed) return this.interrupt(input);
    let state = "accepted";
    try { await this.provider.interrupt({ agent, operation }); }
    catch { state = "uncertain"; }
    await this.change((doc) => {
      this.find(doc, agentId).stops.find((s) => s.operationId === operationId).state = state;
    });
    // An accepted interrupt request does not release the workspace writer.
    return { ...stop, state };
  }
  /**
   * A message while the agent works, as in Claude Code and Codex. `mode:
   * "steer"` gives it to the running turn at once (read when the current tool
   * calls finish); `mode: "queue"` holds it for the turn's end. When the agent
   * is not working - or its turn ended meanwhile - the message is an ordinary
   * send under the same operation ID, with the memory in front of it.
   */
  async steer(input) {
    exact(input, ["agentId", "operationId", "text", "mode"]);
    const agentId = id(input.agentId), operationId = id(input.operationId);
    if (input.mode !== "steer" && input.mode !== "queue") fail("memory_invalid_input");
    if (typeof input.text !== "string" || !input.text.trim()
      || Buffer.byteLength(input.text, "utf8") > 16384
      || /data:(?:image|audio|video)\//iu.test(input.text)) fail("memory_invalid_input");
    const started = (op) => ({ agentId, operationId, delivery: "started", turnId: op.turnId ?? null, state: op.state });
    let agent = this.find((await this.catalog()).value, agentId);
    const previous = agent.operations.find((op) => op.operationId === operationId);
    if (previous) return started(await this.send({ agentId, operationId, text: input.text }));
    if (agent.state !== "active") fail("memory_agent_closed");
    const current = agent.currentOperationId
      ? agent.operations.find((op) => op.operationId === agent.currentOperationId) : null;
    if (current?.turnId && !TERMINAL.has(current.state) && typeof this.provider?.steer === "function") {
      try {
        const result = await this.provider.steer({ agent, operation: current, text: input.text, mode: input.mode,
          clientId: operationId });
        return { agentId, operationId, delivery: result.delivery === "queued" ? "queued" : "steered",
          turnId: current.turnId, state: "started" };
      } catch (error) {
        if (error?.code !== "turn_not_active") throw error;
      }
      await this.receipt({ agentId, operationId: current.operationId });
    }
    return started(await this.send({ agentId, operationId, text: input.text }));
  }
  /** Takes back a message held for the end of the turn; `cancelled: false` when it already went. */
  async unqueue(input) {
    exact(input, ["agentId", "operationId"]);
    const agentId = id(input.agentId), operationId = id(input.operationId);
    const agent = this.find((await this.catalog()).value, agentId);
    const current = agent.currentOperationId
      ? agent.operations.find((op) => op.operationId === agent.currentOperationId) : null;
    if (!current?.turnId || typeof this.provider?.unqueue !== "function") return { agentId, operationId, cancelled: false };
    const result = await this.provider.unqueue({ agent, operation: current, clientId: operationId });
    return { agentId, operationId, cancelled: result?.cancelled === true };
  }
  /**
   * The model and reasoning effort of an agent's next turns, as in the model
   * picker of Claude Code and Codex. The conversation stays the same session;
   * the prompt cache of the new model starts cold.
   */
  async setProfile(input) {
    exact(input, ["agentId", "profile"]);
    const agentId = id(input.agentId);
    const next = profile(input.profile);
    if (!this.provider) fail("memory_provider_unavailable");
    const agent = this.find((await this.catalog()).value, agentId);
    if (agent.state === "archived" || agent.state === "closing") fail("memory_agent_closed");
    if (next.provider !== agent.profile.provider) fail("memory_profile_conflict");
    await this.provider.preflight(next);
    await this.change((doc) => {
      const current = this.find(doc, agentId);
      if (current.state === "archived" || current.state === "closing") fail("memory_agent_closed");
      current.profile = next;
      current.profileChangedAtUtc = this.now().toISOString();
    });
    return this.readAgent({ agentId });
  }
  /**
   * One page of the agent's trace: everything its turns did, in full - the
   * owner's view behind the chat. Secrets that a tool printed are masked; the
   * rest is as Claude Code produced it.
   */
  async trace(input) {
    exact(input, ["agentId", "before", "after", "maxBytes"]);
    const agentId = id(input.agentId);
    const cursor = (value) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string" || !/^\d{1,6}:\d{1,12}$/u.test(value)) fail("memory_invalid_input");
      return value;
    };
    if (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1
        || input.maxBytes > 512 * 1024)) fail("memory_invalid_input");
    const agent = this.find((await this.catalog()).value, agentId);
    if (!agent.binding || typeof this.provider?.trace !== "function") fail("memory_provider_unavailable");
    const page = await this.provider.trace(agent, { before: cursor(input.before), after: cursor(input.after),
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }) });
    const queued = typeof this.provider.queued === "function" ? this.provider.queued(agent) : [];
    return { schemaVersion: 1, agentId, records: page.records.map(maskTraceRecord), beforeCursor: page.beforeCursor,
      afterCursor: page.afterCursor, gap: page.gap === true, exhausted: page.exhausted === true,
      queued: queued.map((held) => ({ clientId: held.clientId, message: maskTrace(held.displayText),
        queuedAtUtc: held.queuedAtUtc })) };
  }
  async interactions(input) {
    exact(input, ["agentId", "limit"]);
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 32)) {
      fail("memory_invalid_input");
    }
    const agent = this.find((await this.catalog()).value, input.agentId);
    if (!agent.binding || !this.provider?.listInteractions) fail("memory_provider_unavailable");
    return this.provider.listInteractions(agent, input.limit === undefined ? {} : { limit: input.limit });
  }
  async respond(input) {
    exact(input, ["agentId", "response"]);
    const agent = this.find((await this.catalog()).value, input.agentId);
    if (!agent.binding || !this.provider?.respondInteraction) fail("memory_provider_unavailable");
    return this.provider.respondInteraction(agent, input.response);
  }
  async readArchive(input) {
    exact(input, ["agentId", "cursor", "limit"]);
    const agent = await this.readAgent({ agentId: input.agentId });
    if (!agent.binding) fail("memory_archive_unavailable");
    const { binding, ...page } = await this.archive.read(agent.binding, {
      cursor: input.cursor ?? null, limit: input.limit ?? 50,
    });
    return { ...page, agentId: agent.agentId, canRestore: false, canSend: agent.state === "active" };
  }
  async context(input) {
    exact(input, ["agentId"]);
    return this.agentContext(this.find((await this.catalog()).value, input.agentId));
  }
  async agentContext(agent, pair, own) {
    if (agent.state === "archived") {
      const pinned = agent.deliveredManifest ?? agent.assignedManifest;
      const read = ({ scopeId, revision }) => this.store.readScope({ scopeId, revision });
      pair = { project: await read(pinned.project), quarter: await read(pinned.quarter) };
      own = pinned.agent ? await read(pinned.agent) : null;
    } else {
      pair ??= await this.store.readPair({ projectId: agent.projectId, quarterId: agent.quarterId });
      own ??= agent.agentScopeId ? await this.store.readScope({ scopeId: agent.agentScopeId }) : null;
    }
    const manifest = manifestOf(pair, own);
    const scopes = [pair.project, pair.quarter, ...(own ? [own] : [])];
    const populated = scopes.filter((scope) => scope.entries.length > 0).length;
    return { schemaVersion: 1, agentId: agent.agentId, ...pair, agent: own ?? null, manifestHash: manifest.manifestHash,
      contentState: populated === 0 ? "empty" : populated === scopes.length ? "populated" : "partial",
      deliveryState: agent.state === "archived" ? "archived"
        : agent.operations.some((op) => op.operationId === agent.currentOperationId
          && ["requested", "uncertain"].includes(op.state)) ? "uncertain"
        : agent.deliveredManifest?.manifestHash === manifest.manifestHash ? "delivered" : "pending",
      deliveredManifest: agent.deliveredManifest, requiredManifest: manifest,
      startBlockedByEmptyMemory: false };
  }
}

export async function createProjectMemoryService({ controllerRoot, sourceId, provider = null,
  now = () => new Date(), store, archive, pythonCommand } = {}) {
  return new ProjectMemoryService({
    store: store ?? await createProjectMemoryStore({ controllerRoot, now, pythonCommand }),
    archive: archive ?? await createConversationArchive({ controllerRoot,
      projectId: await resolveProviderMutationProjectId(controllerRoot), now, pythonCommand }),
    provider, now, openTasks: controllerRoot ? createOpenDeskTaskReader(controllerRoot) : undefined,
    worldProjects: controllerRoot ? () => unmountedWorldProjects(controllerRoot).catch(() => []) : null,
  });
}

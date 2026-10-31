// PROTOTYPE. A bridge that lets the desk run on a Paperclip server.
//
// It has the same shape as the development fixture (src/dev/dev-gateway.mjs):
// it opens no listener, it hands the host a descriptor resolver and a fetch
// implementation, and it speaks the real transport shape, so the verified kit
// client and the whole host path run unchanged. The difference is where the
// answers come from: every operation is translated into calls to Paperclip's
// REST API on this machine, and nothing here is synthetic.
//
// How the four levels are found in Paperclip:
//
//   World    one company (config/paperclip.json names it)
//   Project  a project; its bound folder is the primary workspace's cwd
//   Quarter  a root issue of the project labelled `atlas-quarter`
//   Agent    an agent whose metadata.atlas names its project and quarter
//
// The two memories are `memory` documents: the quarter's on its own issue, the
// project's on the one root issue labelled `atlas-project-memory`.
//
// An agent's conversation with the person is ONE issue: a child of the agent's
// quarter, assigned to that agent. The first message is the issue's
// description, every later message is a comment on it. A person's comment
// wakes the agent (and reopens the issue if the agent had closed it), and
// Paperclip resumes the provider session it keeps per agent and issue - that is
// what lets the agent remember the conversation. The first message carries both
// memories as they are at that moment (see memory-format.mjs); a later message
// carries them again only when they have changed since. The desk's view of the
// conversation is rebuilt from the agent's issues, their comments, their runs
// and the run logs.

import { randomUUID } from "node:crypto";
import { lstat, open, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveOver } from "../host/move-over.mjs";
import {
  atlasIdMarker, atlasIdOf, conversationDescription, embedMemory, entriesFromMarkdown, isConversation, markdownFromEntries,
  operationMarker, operationOf, sha256, splitEmbeddedMemory,
} from "./memory-format.mjs";
import { parseRunLog } from "./transcript.mjs";
import { tx } from "../host/i18n.mjs";

const CONTRACT_VERSION = "v0.1.0";
const CAPABILITY_VERSION = "v0.2.0";
const DISCOVERY_OPERATION_ID = "discovery.application.capabilities";
const SOURCE_ID = "paperclip";
const QUARTER_LABEL = "atlas-quarter";
const PROJECT_MEMORY_LABEL = "atlas-project-memory";
const LABEL_COLORS = Object.freeze({ [QUARTER_LABEL]: "#4f8a5b", [PROJECT_MEMORY_LABEL]: "#8a7a4f" });

const IMPLEMENTED = Object.freeze({
  "query.memory.scopes.list": "query",
  "query.memory.scope.read": "query",
  "query.memory.agents.list": "query",
  "query.memory.agent.read": "query",
  "query.memory.agent.context": "query",
  "query.memory.agent.archive": "query",
  "query.agent-control.interactions": "query",
  "query.agent-conversation.resolve": "query",
  "query.agent-conversation.read": "query",
  "query.project-workspace.list": "query",
  "query.project-workspace.read": "query",
  "query.agent-artifacts.list": "query",
  "query.agent-artifacts.read": "query",
  "query.agent-events.read": "query",
  "receipt.memory.agent.send": "receipt-lookup",
  "mutation.memory.scope.create": "mutation",
  "mutation.memory.agent.create": "mutation",
  "mutation.memory.agent.send": "mutation",
  "mutation.memory.agent.close": "mutation",
  "approval.agent-control.respond": "approval",
  "mutation.agent-control.interrupt": "mutation",
  "mutation.project-workspace.save": "mutation",
});
// Not offered: mutation.memory.project.copy. Paperclip has no atomic copy of a
// project with its quarters and memory, and a copy made of several calls would
// not be the all-or-nothing operation the contract promises.

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE_RUN = new Set(["queued", "running"]);
const OPEN_ISSUE = new Set(["todo", "in_progress", "in_review", "blocked"]);
const CLOSED_ISSUE = new Set(["done", "cancelled"]);
// How long a message that no run has picked up yet still counts as on its way to the agent.
const WAKE_GRACE_MS = 120_000;
// The note earlier versions of this bridge left on a task they stopped. It is not something the person said.
const LEGACY_STOP_NOTE = "Stopped from the desk.";
// How reasoning and the backend's bookkeeping are told apart from real actions: the
// first line of an activity item. The window knows the same two lines (workspace.js).
const REASONING_HEAD = "Thinking";
const SERVICE_HEAD = "Internal · ";
const SNAPSHOT_TTL_MS = 2000;
const CONVERSATION_TTL_MS = 3000;
const TURN_ITEM_CAP = 24;
const PAGE_CONTENT_CAP = 256;
const FILE_MAX_BYTES = 1_048_576;
const PAGE_MAX_BYTES = 65_536;

// The adapter a profile's provider word stands for. Anything else must already
// be the type of an adapter Paperclip has.
const PROVIDER_ADAPTER = Object.freeze({ claude: "claude_local", codex: "codex_local" });

/** One line to stderr when ATLAS_BRIDGE_DEBUG is set: what the bridge could not tell the desk in a code. */
const debug = (line) => { if (process.env.ATLAS_BRIDGE_DEBUG) process.stderr.write(`[paperclip-bridge] ${line}\n`); };

const iso = (value) => new Date(value).toISOString();
const safeId =(value) => (typeof value === "string" && ID.test(value) ? value : null);
const clipText = (text, limit = 65_536) => (text.length > limit ? text.slice(0, limit) : text);

/** Reads config/paperclip.json: where the Paperclip API is and which company is the world. */
export async function loadPaperclipConfig(projectRoot) {
  const configPath = path.join(projectRoot, "config", "paperclip.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    return error?.code === "ENOENT"
      ? { status: "missing", reasonCode: "paperclip_config_missing" }
      : { status: "invalid", reasonCode: "paperclip_config_unparsable" };
  }
  let url;
  try {
    url = new URL(parsed?.apiUrl);
  } catch {
    return { status: "invalid", reasonCode: "paperclip_api_url_invalid" };
  }
  // The bridge is for a server on this machine only, like the gateway it stands in for.
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    return { status: "invalid", reasonCode: "paperclip_api_url_not_loopback" };
  }
  if (typeof parsed.companyId !== "string" || !UUID.test(parsed.companyId)) {
    return { status: "invalid", reasonCode: "paperclip_company_id_invalid" };
  }
  const agentDefaults = parsed.agentDefaults !== null && typeof parsed.agentDefaults === "object" ? parsed.agentDefaults : {};
  return {
    status: "loaded",
    config: Object.freeze({
      apiUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
      port: Number(url.port === "" ? 80 : url.port),
      companyId: parsed.companyId,
      // Adapter settings every agent created from the desk starts with.
      agentDefaults: Object.freeze({ ...agentDefaults }),
    }),
  };
}

function operationRef(family, operationId) {
  return { schemaVersion: 1, contractVersion: CONTRACT_VERSION, family, operationId };
}

function envelope(request, now, body) {
  return {
    schemaVersion: 1, contractVersion: CONTRACT_VERSION,
    requestId: request.requestId, correlationId: request.correlationId,
    ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
    operation: request.operation, startedAtUtc: iso(now), completedAtUtc: iso(Date.now()),
    diagnostics: [], ...body,
  };
}

function failure(request, now, code, message, reasonCode = null) {
  return envelope(request, now, {
    outcome: "failed",
    error: { code, message, retryable: false, phase: "precondition", ...(reasonCode === null ? {} : { reasonCode }) },
  });
}

/** A thrown refusal: becomes a failed envelope with the same code and reason. */
class Refusal extends Error {
  constructor(code, message, reasonCode = null) {
    super(message);
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

/** A change whose answer never came back: it may have happened. Never retried here. */
class Uncertain extends Error {}

/** An operation that was taken on, as opposed to one that is already finished. */
const accepted = (output) => ({ accepted: true, output });

export function createPaperclipGateway({
  kit, config, fetchFn = (...args) => globalThis.fetch(...args),
  // The time Paperclip's own timestamps are compared with; a test whose stand-in keeps its own time passes that.
  clock = () => Date.now(),
} = {}) {
  if (kit === undefined || typeof kit.readText !== "function") {
    throw new TypeError("createPaperclipGateway needs the verified kit");
  }
  const sessionId = randomUUID();
  const instanceId = randomUUID();
  const workspace = Object.freeze({
    projectId: `paperclip-${config.companyId.slice(0, 8)}`,
    sourceId: SOURCE_ID,
    workspaceRootSha256: sha256(`${config.apiUrl}|${config.companyId}`),
  });
  const provider = Object.freeze({
    adapterId: SOURCE_ID, adapterFamily: "execution-provider", adapterVersion: "v0.1.0",
    sourceId: SOURCE_ID, runtimeInstanceId: instanceId,
  });
  const company = `/companies/${config.companyId}`;

  // --- Paperclip REST --------------------------------------------------------------

  async function get(resource) {
    let response;
    try {
      response = await fetchFn(`${config.apiUrl}${resource}`, { headers: { accept: "application/json" } });
    } catch {
      throw new Refusal("source_unavailable", "Paperclip is not reachable", "paperclip_unreachable");
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Refusal("source_unavailable", `Paperclip answered ${response.status}`, "paperclip_request_failed");
    }
    return response.json();
  }

  /**
   * One change. A refused change is a Refusal with Paperclip's own words; a
   * request that got no answer is Uncertain, because it may have been applied.
   */
  async function change(method, resource, body = {}) {
    let response;
    try {
      response = await fetchFn(`${config.apiUrl}${resource}`, {
        method, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } catch (error) {
      debug(`${method} ${resource} got no answer: ${error?.cause?.code ?? error?.cause?.message ?? error?.message}`);
      throw new Uncertain();
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch { /* no body */ }
    if (!response.ok) {
      const words = clipText(String(payload?.error ?? `Paperclip answered ${response.status}`), 512);
      const code = response.status === 409 ? "conflict" : response.status === 404 ? "source_unavailable" : "request_refused";
      throw new Refusal(code, words, safeId(payload?.code) ?? `paperclip_http_${response.status}`);
    }
    return payload;
  }

  const memo = new Map();
  /** One in-flight or recent result per key: a refresh of the desk asks the same things many times. */
  function cached(key, ttlMs, load) {
    const hit = memo.get(key);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < ttlMs) return hit.value;
    const value = load().catch((error) => {
      memo.delete(key);
      throw error;
    });
    memo.set(key, { at: now, value });
    return value;
  }
  /** After a change nothing read before it is current. */
  const forget = () => memo.clear();

  let health = { at: 0, ok: false };
  async function reachable() {
    if (Date.now() - health.at < 5000) return health.ok;
    let ok = false;
    try {
      const response = await fetchFn(`${config.apiUrl}/health`, { headers: { accept: "application/json" } });
      ok = response.ok;
    } catch { /* not reachable */ }
    health = { at: Date.now(), ok };
    return ok;
  }

  // --- the world, as Paperclip has it now --------------------------------------------

  let catalogRevision = 0;
  let catalogHash = null;
  let attentionSequence = 0;
  let attentionHash = null;

  const conversationIdOf = (agentUuid) => `conversation:${sha256(`paperclip-conversation:${agentUuid}`)}`;
  const projectScopeId = (projectId) => `${projectId}-memory`;
  const quarterScopeId = (projectId, quarterId) => `${projectId}-${quarterId}-memory`;

  function scopeOf({ scopeId, kind, projectId, quarterId, title, document, updatedAt }) {
    const body = document?.body ?? "";
    return {
      schemaVersion: 1, scopeId, kind, projectId, quarterId,
      title: clipText(title.trim() === "" ? scopeId : title, 512),
      // An absent document is revision 1; an existing one is its own number plus one,
      // so "never written" and "written once" are different revisions.
      revision: document === null || document === undefined ? 1 : document.latestRevisionNumber + 1,
      sha256: sha256(body),
      author: safeId(document?.updatedByUserId) ?? safeId(document?.updatedByAgentId) ?? SOURCE_ID,
      updatedAtUtc: iso(document?.updatedAt ?? updatedAt),
      entries: entriesFromMarkdown(body, { defaultTitle: title }),
    };
  }

  const manifestPart = (scope) => ({ scopeId: scope.scopeId, revision: scope.revision, sha256: scope.sha256 });
  function manifestOf(project, quarter) {
    return {
      project: manifestPart(project), quarter: manifestPart(quarter),
      manifestHash: sha256(`${project.scopeId}:${project.revision}:${quarter.scopeId}:${quarter.revision}`),
    };
  }
  const NO_SCOPE = Object.freeze({ scopeId: "unassigned", revision: 1, sha256: sha256(""), entries: [] });

  const RUN_STATE = Object.freeze({
    queued: "accepted", running: "started", succeeded: "completed",
    failed: "failed", timed_out: "failed", cancelled: "interrupted",
  });

  function agentState(status) {
    if (status === "terminated") return "archived";
    if (status === "error") return "failed";
    if (status === "pending_approval") return "creating";
    return "active";
  }

  const issueInteractions = (issueId) => cached(`interactions:${issueId}`, SNAPSHOT_TTL_MS,
    async () => (await get(`/issues/${issueId}/interactions`)) ?? []);
  const issueComments = (issueId) => cached(`comments:${issueId}`, SNAPSHOT_TTL_MS,
    async () => (await get(`/issues/${issueId}/comments`)) ?? []);

  const byCreation = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  /** A comment the person wrote, as opposed to the agent's, Paperclip's own, or this bridge's old stop note. */
  const saidByPerson = (comment) => comment.authorType === "user" && (comment.createdByRunId ?? null) === null
    && String(comment.body ?? "").trim() !== LEGACY_STOP_NOTE;

  /**
   * What the person said in one task, oldest first: the task itself, then each
   * of their comments. `operationId` is the desk's id of the send that made the
   * message, or null for one written in Paperclip; `delivered` is the memory
   * that travelled with it, or null.
   */
  function messagesOf(issue, comments) {
    const said = (text, at, commentId) => {
      const split = splitEmbeddedMemory(text);
      return { at, commentId, text: split.message, delivered: split.delivered, operationId: operationOf(text) };
    };
    // The description of a conversation is the fixed text that says how it works, not something the
    // person said - except in conversations opened before that, whose description is their first message.
    const fixed = isConversation(issue.description) && operationOf(issue.description) === null;
    return [
      ...(fixed ? [] : [said(issue.description, issue.createdAt, null)]),
      ...[...comments].filter(saidByPerson).sort(byCreation).map((comment) => said(comment.body, comment.createdAt, comment.id)),
    ];
  }

  /** The message a run answers: the last one said before the run was made. */
  const messageOfRun = (messages, run) => [...messages].reverse().find((message) => String(message.at) <= String(run.createdAt)) ?? null;
  const runsOfIssue = (view, issueId) => view.runs.filter((run) => run.contextSnapshot?.issueId === issueId);

  // Paperclip's list of issues carries only the beginning of a long description
  // (1200 characters), and the desk's markers sit after the message and its
  // memory. A cut description is read whole, once per change of its issue.
  const descriptions = new Map();
  async function wholeDescriptions(issues) {
    await Promise.all(issues.filter((issue) => issue.descriptionTruncated === true).map(async (issue) => {
      const key = `${issue.id}:${issue.updatedAt}`;
      if (!descriptions.has(key)) {
        const whole = await get(`/issues/${issue.id}`);
        if (typeof whole?.description !== "string") return;
        descriptions.set(key, whole.description);
      }
      issue.description = descriptions.get(key);
    }));
  }

  function loadSnapshot() {
    return cached("snapshot", SNAPSHOT_TTL_MS, async () => {
      const [projects, issues, agents, labels, runs] = await Promise.all([
        get(`${company}/projects`), get(`${company}/issues`), get(`${company}/agents`),
        get(`${company}/labels`), get(`${company}/heartbeat-runs?limit=200`),
      ]);
      await wholeDescriptions(issues ?? []);
      const observedAtUtc = iso(Date.now());
      const labelId = (name) => (labels ?? []).find((label) => label.name === name)?.id ?? null;
      const quarterLabel = labelId(QUARTER_LABEL);
      const memoryLabel = labelId(PROJECT_MEMORY_LABEL);
      const has = (issue, label) => label !== null && (issue.labelIds ?? []).includes(label);
      const issueById = new Map((issues ?? []).map((issue) => [issue.id, issue]));

      const projectViews = (projects ?? []).filter((project) => project.archivedAt === null || project.archivedAt === undefined)
        .map((project) => ({
          uuid: project.id,
          projectId: atlasIdOf(project.description) ?? safeId(project.urlKey) ?? project.id,
          name: project.name ?? project.id,
          cwd: project.primaryWorkspace?.cwd ?? null, updatedAt: project.updatedAt,
          memoryIssue: (issues ?? []).find((issue) => issue.projectId === project.id && has(issue, memoryLabel)) ?? null,
        }));
      const projectByUuid = new Map(projectViews.map((view) => [view.uuid, view]));
      const quarterViews = (issues ?? [])
        // A quarter that was cancelled in Paperclip is closed: it leaves the map.
        .filter((issue) => issue.parentId === null && has(issue, quarterLabel) && projectByUuid.has(issue.projectId)
          && issue.status !== "cancelled")
        .map((issue) => ({
          uuid: issue.id,
          quarterId: atlasIdOf(issue.description) ?? safeId(issue.identifier) ?? issue.id,
          project: projectByUuid.get(issue.projectId),
          title: String(issue.title ?? "").replace(/^quarter:\s*/i, ""), updatedAt: issue.updatedAt, status: issue.status,
        }));
      const quarterByUuid = new Map(quarterViews.map((view) => [view.uuid, view]));

      const memoryDocument = (issueId) => get(`/issues/${issueId}/documents/memory`);
      const [projectDocuments, quarterDocuments] = await Promise.all([
        Promise.all(projectViews.map((view) => (view.memoryIssue === null ? null : memoryDocument(view.memoryIssue.id)))),
        Promise.all(quarterViews.map((view) => memoryDocument(view.uuid))),
      ]);
      const scopes = [];
      const scopeHome = new Map();
      projectViews.forEach((view, index) => {
        view.document = projectDocuments[index];
        view.scope = scopeOf({
          scopeId: projectScopeId(view.projectId), kind: "project", projectId: view.projectId, quarterId: null,
          title: view.name, document: view.document, updatedAt: view.updatedAt,
        });
        scopes.push(view.scope);
        scopeHome.set(view.scope.scopeId, { kind: "project", view });
      });
      quarterViews.forEach((view, index) => {
        view.document = quarterDocuments[index];
        view.scope = scopeOf({
          scopeId: quarterScopeId(view.project.projectId, view.quarterId), kind: "quarter",
          projectId: view.project.projectId, quarterId: view.quarterId, title: view.title,
          document: view.document, updatedAt: view.updatedAt,
        });
        scopes.push(view.scope);
        scopeHome.set(view.scope.scopeId, { kind: "quarter", view });
      });

      const runsByAgent = new Map();
      for (const run of runs ?? []) {
        if (!runsByAgent.has(run.agentId)) runsByAgent.set(run.agentId, []);
        runsByAgent.get(run.agentId).push(run);
      }
      for (const list of runsByAgent.values()) list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const issuesByAgent = new Map();
      for (const issue of issues ?? []) {
        if (issue.assigneeAgentId === null || issue.assigneeAgentId === undefined) continue;
        if (!issuesByAgent.has(issue.assigneeAgentId)) issuesByAgent.set(issue.assigneeAgentId, []);
        issuesByAgent.get(issue.assigneeAgentId).push(issue);
      }
      for (const list of issuesByAgent.values()) list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

      const agentViews = await Promise.all((agents ?? []).map(async (agent) => {
        const link = agent.metadata?.atlas ?? {};
        const project = projectByUuid.get(link.projectId) ?? null;
        const quarter = quarterByUuid.get(link.quarterIssueId) ?? null;
        const member = project !== null && quarter !== null && quarter.project === project;
        const myIssues = issuesByAgent.get(agent.id) ?? [];
        const myRuns = runsByAgent.get(agent.id) ?? [];
        const open = myIssues.filter((issue) => OPEN_ISSUE.has(issue.status));
        const pending = (await Promise.all(open.map((issue) => issueInteractions(issue.id)))).flat()
          .filter((interaction) => interaction.status === "pending");
        // The agent's conversation: its newest task in its own quarter that was opened as one. A
        // conversation of the earlier kind - its description is the first message, with older
        // instructions to the agent - is history: the next message opens a new one.
        const conversation = !member ? null
          : [...myIssues].reverse().find((issue) => issue.parentId === quarter.uuid && isConversation(issue.description)
            && operationOf(issue.description) === null) ?? null;
        const messages = conversation === null ? [] : messagesOf(conversation, await issueComments(conversation.id));
        // A message no run has picked up yet. Paperclip starts the run a moment
        // after the comment; past the grace time the message is no longer assumed to be on its way.
        const last = messages.at(-1) ?? null;
        const waiting = last !== null && !CLOSED_ISSUE.has(conversation.status)
          && !myRuns.some((run) => run.contextSnapshot?.issueId === conversation.id && String(run.createdAt) >= String(last.at))
          && (conversation.status === "todo" || clock() - Date.parse(last.at) < WAKE_GRACE_MS) ? last : null;
        return { uuid: agent.id, agentId: safeId(link.agentId) ?? safeId(agent.urlKey) ?? agent.id, raw: agent,
          project, quarter, member, issues: myIssues, runs: myRuns, pending, conversation, messages, waiting };
      }));

      /** What was said in one of the agent's tasks; only the conversation's comments are read here. */
      const saidIn = (view, issue) => (issue === view.conversation ? view.messages : messagesOf(issue, []));
      /** The desk's id for the work a run belongs to: the send's own id when it was sent from the desk. */
      const operationOfRun = (view, run) => {
        const issue = issueById.get(run.contextSnapshot?.issueId);
        return (issue === undefined ? null : messageOfRun(saidIn(view, issue), run)?.operationId) ?? run.id;
      };

      const pendingKey = sha256(JSON.stringify(agentViews.map((view) => view.pending.map((item) => item.id))));
      if (pendingKey !== attentionHash) {
        attentionHash = pendingKey;
        attentionSequence += 1;
      }

      const records = agentViews.map((view) => {
        const projectScope = view.member ? view.project.scope : NO_SCOPE;
        const quarterScope = view.member ? view.quarter.scope : NO_SCOPE;
        const required = manifestOf(projectScope, quarterScope);
        // The memory an agent was given is the newest one embedded in a message that a run has picked up.
        let delivered = null;
        for (const issue of [...view.issues].reverse()) {
          const newestRun = runsOfIssue(view, issue.id)[0] ?? null;
          if (newestRun === null) continue;
          const carried = [...saidIn(view, issue)].reverse()
            .find((message) => message.delivered !== null && String(message.at) <= String(newestRun.createdAt));
          if (carried !== undefined) {
            delivered = manifestOf(carried.delivered.project, carried.delivered.quarter);
            break;
          }
        }
        const latest = view.runs[0] ?? null;
        const state = agentState(view.raw.status);
        const filled = [projectScope, quarterScope].filter((scope) => scope.entries.length > 0).length;
        const configuration = view.raw.adapterConfig ?? {};
        return {
          agentId: view.agentId,
          projectId: view.member ? view.project.projectId : "unassigned",
          quarterId: view.member ? view.quarter.quarterId : "unassigned",
          operationId: `create:${view.uuid}`,
          profile: {
            provider: safeId(view.raw.adapterType) ?? "unknown",
            model: safeId(configuration.model) ?? "default",
            reasoningEffort: safeId(configuration.effort) ?? "default",
            fallbackPolicy: "deny",
          },
          binding: { projectId: workspace.projectId, sourceId: SOURCE_ID,
            providerId: safeId(view.raw.adapterType) ?? "unknown", threadId: view.uuid },
          assignedManifest: required, requiredManifest: required, deliveredManifest: delivered,
          currentOperationId: latest !== null && ACTIVE_RUN.has(latest.status) ? operationOfRun(view, latest) : null,
          lastOperation: latest === null ? null : {
            schemaVersion: 1, operationId: operationOfRun(view, latest), kind: "send", state: RUN_STATE[latest.status] ?? "uncertain",
            requestedAtUtc: iso(latest.createdAt), updatedAtUtc: iso(latest.updatedAt ?? latest.finishedAt ?? latest.createdAt),
          },
          problemCode: null,
          contentState: filled === 0 ? "empty" : filled === 2 ? "populated" : "partial",
          deliveryState: state === "archived" ? "archived" : delivered === null ? "pending" : "delivered",
          state,
          createdAtUtc: iso(view.raw.createdAt),
          archivedAtUtc: state === "archived" ? iso(view.raw.updatedAt ?? view.raw.createdAt) : null,
          coverage: "captured-only",
          attention: {
            availability: "available", coverage: "captured-only",
            sourceSequence: attentionSequence, sourceRevision: 0,
            pendingQuestions: view.pending.filter((item) => item.kind === "ask_user_questions").length,
            pendingApprovals: view.pending.filter((item) => item.kind !== "ask_user_questions").length,
            recoveryRequired: view.raw.status === "error" ? 1 : 0,
            observedAtUtc,
          },
        };
      });
      // The catalog revision moves only when something other than the observation time changed.
      const stable = sha256(JSON.stringify(records.map((record) => ({ ...record, attention: { ...record.attention, observedAtUtc: null } }))));
      if (stable !== catalogHash) {
        catalogHash = stable;
        catalogRevision += 1;
      }
      for (const record of records) record.attention.sourceRevision = catalogRevision;
      agentViews.forEach((view, index) => { view.record = records[index]; });

      return {
        observedAtUtc, scopes, scopeHome, projects: projectViews, quarters: quarterViews, agents: agentViews,
        labels: { quarter: quarterLabel, memory: memoryLabel },
        agentById: new Map(agentViews.map((view) => [view.agentId, view])),
        projectById: new Map(projectViews.map((view) => [view.projectId, view])),
        runById: new Map((runs ?? []).map((run) => [run.id, run])),
      };
    });
  }

  async function agentOf(agentId) {
    const view = (await loadSnapshot()).agentById.get(agentId);
    if (view === undefined) throw new Refusal("source_unavailable", "Unknown agent");
    return view;
  }

  // --- conversation ------------------------------------------------------------------

  const ref = (kind, externalId) => ({
    schemaVersion: 1, kind, relationship: SOURCE_ID,
    authority: { schemaVersion: 1, authorityType: "provider", sourceId: SOURCE_ID, externalId, contractVersion: CONTRACT_VERSION },
  });

  const TURN_STATE = Object.freeze({
    queued: "pending", running: "active", succeeded: "completed",
    failed: "failed", timed_out: "failed", cancelled: "interrupted",
  });

  const logs = new Map();
  /** A finished run's log never changes, so it is parsed once. */
  async function runItems(runId, finished) {
    if (logs.has(runId)) return logs.get(runId);
    const log = await get(`/heartbeat-runs/${runId}/log`);
    const items = parseRunLog(typeof log?.content === "string" ? log.content : "");
    if (finished) logs.set(runId, items);
    return items;
  }

  function questionText(interaction) {
    const questions = interaction.payload?.questions ?? [];
    if (questions.length === 0) return interaction.payload?.prompt ?? interaction.title ?? interaction.kind;
    return questions.map((question) => {
      const options = (question.options ?? []).map((option) => option.label).join(" / ");
      return options === "" ? question.prompt : tx("{prompt}\nOptions: {options}", { prompt: question.prompt, options });
    }).join("\n\n");
  }

  function answerText(interaction) {
    const questions = new Map((interaction.payload?.questions ?? []).map((question) => [question.id, question]));
    const answers = interaction.result?.answers ?? [];
    if (answers.length === 0) return interaction.status;
    return answers.map((answer) => {
      const question = questions.get(answer.questionId);
      const labels = (answer.optionIds ?? []).map((id) => (
        (question?.options ?? []).find((option) => option.id === id)?.label ?? id));
      return [...labels, ...(answer.otherText ? [answer.otherText] : [])].join(", ");
    }).join("; ");
  }

  function buildConversation(view) {
    return cached(`conversation:${view.uuid}`, CONVERSATION_TTL_MS, async () => {
      const snapshot = await loadSnapshot();
      const turns = [];
      let partialReason = null;
      let newest = view.raw.createdAt;
      const touch = (value) => { if (value && String(value) > String(newest)) newest = value; };

      for (const issue of view.issues) {
        const [runs, comments, interactions] = await Promise.all([
          get(`/issues/${issue.id}/runs`), issueComments(issue.id), issueInteractions(issue.id),
        ]);
        const ordered = [...(runs ?? [])].sort(byCreation);
        // What the person said in this task, as chat items: the task first, then their comments.
        let carried = false;
        const said = messagesOf(issue, comments).map((message) => {
          // The first memory a task carries is "given"; any later one is an update.
          const memoryNote = message.delivered === null ? ""
            : tx("\n\n({value}memory sent {value2}: project — revision {revision}, quarter — revision {revision2})", { value2: message.commentId === null ? tx("with the task") : tx("with the message"), value: carried ? tx("updated ") : "", revision: message.delivered.project.revision, revision2: message.delivered.quarter.revision });
          if (message.delivered !== null) carried = true;
          if (message.commentId !== null) return { kind: "user", at: message.at, key: `comment:${message.commentId}`, text: `${message.text}${memoryNote}` };
          // A message sent from the desk is shown as it was typed; any other task with its number and title.
          const heading = message.operationId !== null ? "" : `${issue.identifier} · ${issue.title}`;
          const body = [heading, message.text].filter((part) => part !== "").join("\n\n");
          return { kind: "user", at: message.at, key: `issue:${issue.id}`, text: `${body === "" ? issue.title : body}${memoryNote}` };
        });
        touch(issue.updatedAt);

        // Said after the last run: on its way to the agent, or - in a task that is closed - a remark nothing answered.
        const lastRunAt = ordered.length === 0 ? "" : String(ordered.at(-1).createdAt);
        const unanswered = said.filter((item) => String(item.at) > lastRunAt);
        if (unanswered.length > 0) {
          const state = issue.status === "cancelled" ? "interrupted" : issue.status === "done" ? "completed"
            : issue.status === "todo" || clock() - Date.parse(unanswered.at(-1).at) < WAKE_GRACE_MS ? "pending" : "unknown";
          turns.push({ key: unanswered[0].key, state, startedAt: unanswered[0].at, completedAt: null,
            items: unanswered.map(({ key, ...item }) => item) });
        }
        for (let index = 0; index < ordered.length; index += 1) {
          const run = ordered[index];
          const from = index === 0 ? "" : String(ordered[index - 1].createdAt);
          const until = index + 1 < ordered.length ? String(ordered[index + 1].createdAt) : "￿";
          const started = String(run.createdAt);
          // What the person said between the previous run and this one.
          const items = said.filter((item) => String(item.at) > from && String(item.at) <= started).map(({ key, ...item }) => item);
          for (const interaction of interactions) {
            if (interaction.resolvedAt && String(interaction.resolvedAt) > from && String(interaction.resolvedAt) <= started) {
              items.push({ kind: "user", at: interaction.resolvedAt,
                text: tx("Answer to the question “{kind}”: {value}", { kind: interaction.title ?? interaction.kind, value: answerText(interaction) }) });
            }
          }
          const finished = !ACTIVE_RUN.has(run.status);
          try {
            items.push(...await runItems(run.runId, finished));
          } catch {
            partialReason = "run_log_unavailable";
          }
          for (const comment of [...(comments ?? [])].reverse()) {
            if (comment.authorType === "system" && String(comment.createdAt) >= started && String(comment.createdAt) < until) {
              // Paperclip's own notices are its bookkeeping; one that reports a failure stays a visible action.
              items.push({ kind: comment.presentation?.tone === "danger" ? "tool" : "service", at: comment.createdAt, text: `Paperclip: ${comment.body}` });
            }
          }
          const detail = snapshot.runById.get(run.runId);
          if ((run.status === "failed" || run.status === "timed_out") && typeof detail?.error === "string") {
            items.push({ kind: "tool", at: run.finishedAt ?? run.createdAt, text: tx("The run ended with an error: {error}", { error: detail.error }) });
          }
          for (const interaction of interactions) {
            if (interaction.sourceRunId === run.runId) {
              items.push({ kind: "question", at: interaction.createdAt, text: tx("Question: {value}", { value: questionText(interaction) }) });
            }
          }
          turns.push({ key: run.runId, state: TURN_STATE[run.status] ?? "unknown",
            startedAt: run.startedAt ?? run.createdAt, completedAt: finished ? (run.finishedAt ?? null) : null, items });
          touch(run.finishedAt ?? run.startedAt ?? run.createdAt);
        }
        for (const comment of comments ?? []) touch(comment.createdAt);
      }

      turns.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      const active = turns.find((turn) => turn.state === "active" || turn.state === "pending") ?? null;
      // While a run is going the log grows without any timestamp moving; each rebuild is then a new revision.
      const revision = iso(active === null ? newest : Date.now());
      const threadRef = ref("provider-thread", view.uuid);

      const shaped = turns.map((turn) => {
        let items = turn.items.filter((item) => item.kind === "thinking" || (typeof item.text === "string" && item.text.trim() !== ""));
        let cut = false;
        if (items.length > TURN_ITEM_CAP) {
          items = [...items.slice(0, 6), { kind: "cut", at: items[6].at }, ...items.slice(items.length - (TURN_ITEM_CAP - 7))];
          cut = true;
        }
        const turnRef = ref("provider-turn", turn.key);
        const content = items.map((item, index) => {
          const base = {
            schemaVersion: 1, contractVersion: CONTRACT_VERSION, provider: { ...provider },
            itemRef: ref("provider-item", `${turn.key}:${index}`), turnRef,
            observedAtUtc: iso(item.at ?? turn.startedAt),
          };
          if ((item.kind === "thinking" && item.text === null) || item.kind === "cut") {
            return { ...base, contentClass: "omitted", role: null, visibility: "omitted", text: null, contentSha256: null,
              omissionReason: item.kind === "thinking" ? "hidden_reasoning" : "oversized_content" };
          }
          // The contract has no class for reasoning or for the backend's own
          // bookkeeping. Both travel as activity; the first line says which it is,
          // and the window shows them by that line (REASONING_HEAD, SERVICE_HEAD).
          const text = clipText(item.kind === "thinking" ? `${REASONING_HEAD}\n\n${item.text}`
            : item.kind === "service" ? `${SERVICE_HEAD}${item.text}` : item.text);
          const shape = {
            user: ["user-message", "user"], assistant: ["assistant-message", "assistant"],
            tool: ["tool-summary", "tool"], change: ["change-summary", "tool"], question: ["interaction-summary", "assistant"],
            thinking: ["tool-summary", "tool"], service: ["tool-summary", "tool"],
          }[item.kind];
          return { ...base, contentClass: shape[0], role: shape[1], visibility: "user-visible", text,
            contentSha256: sha256(text), omissionReason: null };
        });
        return {
          turn: { turnRef, threadRef, state: turn.state, startedAtUtc: iso(turn.startedAt),
            completedAtUtc: turn.completedAt === null ? null : iso(turn.completedAt), itemCount: content.length },
          content, cut,
        };
      });

      return {
        revision, shaped, partialReason,
        thread: {
          threadRef, parentThreadRef: null,
          activeTurnRef: active === null ? null : ref("provider-turn", active.key),
          title: clipText(String(view.raw.name ?? view.agentId), 256),
          state: turns.length === 0 ? "empty" : active === null ? "idle" : "active",
          archived: view.record.state === "archived", updatedAtUtc: revision,
        },
      };
    });
  }

  function bindingOf(view) {
    const base = { schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: view.agentId, archiveCoverage: "captured-only" };
    if (!view.member) return { ...base, conversationId: null, liveRead: { status: "unavailable", reasonCode: "agent_unbound" } };
    const conversationId = conversationIdOf(view.uuid);
    if (view.record.state === "archived") {
      return { ...base, conversationId, liveRead: { status: "unavailable", reasonCode: "agent_archived" } };
    }
    return { ...base, conversationId, liveRead: { status: "available", reasonCode: "available" } };
  }

  async function conversationPage(view, input) {
    const binding = bindingOf(view);
    if (binding.liveRead.status !== "available") {
      throw new Refusal("source_unavailable", "Live read unavailable", binding.liveRead.reasonCode);
    }
    const limit = input.limit ?? 32;
    const built = await buildConversation(view);
    let offset = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
      const parts = /^pc-conv:(\d+):(\d+):(.+)$/u.exec(input.cursor);
      if (parts === null) throw new Refusal("stale_revision", "Unknown conversation cursor", "cursor_invalid");
      if (Number(parts[2]) !== limit) throw new Refusal("conflict", "Continue with the same limit", "limit_changed");
      if (parts[3] !== built.revision) throw new Refusal("stale_revision", "The conversation moved on", "stale_revision");
      offset = Number(parts[1]);
    }
    // A page holds whole turns, at most `limit` of them and at most 256 content items.
    const chosen = [];
    let count = 0;
    for (const entry of built.shaped.slice(offset, offset + limit)) {
      if (chosen.length > 0 && count + entry.content.length > PAGE_CONTENT_CAP) break;
      chosen.push(entry);
      count += entry.content.length;
    }
    const next = offset + chosen.length;
    const content = chosen.flatMap((entry) => entry.content).slice(0, PAGE_CONTENT_CAP);
    const reasons = [
      built.partialReason,
      chosen.some((entry) => entry.cut) ? "turn_items_cut" : null,
      content.some((item) => item.omissionReason === "hidden_reasoning") ? "hidden_reasoning_omitted" : null,
    ].filter((reason) => reason !== null);
    return {
      schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: view.agentId,
      conversationId: binding.conversationId, mode: "provider-read", revision: built.revision,
      nextCursor: next < built.shaped.length ? `pc-conv:${next}:${limit}:${built.revision}` : null,
      observedAtUtc: iso(Date.now()), thread: built.thread,
      turns: chosen.map((entry) => entry.turn), content,
      completeness: reasons.length === 0 ? { status: "complete", reasonCode: null } : { status: "partial", reasonCode: reasons[0] },
    };
  }

  /** The same conversation as captured archive records, for an agent that can no longer be read live. */
  async function archivePage(view, input) {
    const built = await buildConversation(view);
    const KIND = Object.freeze({
      "user-message": "submission", "assistant-message": "message", "tool-summary": "activity",
      "change-summary": "activity", "interaction-summary": "interaction", omitted: "omission",
    });
    const all = built.shaped.flatMap((entry) => entry.content.map((item) => ({ item, turn: entry.turn })));
    const limit = Math.min(input.limit ?? 32, 100);
    const offset = input.cursor === undefined || input.cursor === null ? 0 : Number(/^pc-arch:(\d+)$/u.exec(input.cursor)?.[1] ?? NaN);
    if (!Number.isSafeInteger(offset)) throw new Refusal("conflict", "Unknown archive cursor");
    const items = all.slice(offset, offset + limit).map(({ item, turn }, index) => {
      const sequence = offset + index + 1;
      return {
        firstSequence: sequence, sequence, contentSha256: item.contentSha256 ?? sha256(`omitted:${sequence}`),
        observedAtUtc: item.observedAtUtc,
        record: {
          recordId: `pc-archive-${sequence}`, kind: KIND[item.contentClass], role: item.role,
          state: turn.state === "active" ? "started" : "completed", text: item.text,
          providerTurnId: safeId(item.turnRef.authority.externalId), providerItemId: null, requestId: null,
          occurredAtUtc: item.observedAtUtc, omissions: item.omissionReason === null ? [] : [item.omissionReason],
        },
      };
    });
    return {
      schemaVersion: 1, agentId: view.agentId, revision: all.length, coverage: "captured-only", items,
      nextCursor: offset + limit < all.length ? `pc-arch:${offset + limit}` : null,
    };
  }

  // --- questions ---------------------------------------------------------------------

  const INTERACTION_STATE = Object.freeze({ pending: "awaiting-owner", expired: "expired", withdrawn: "expired" });

  function interactionRecord(view, interaction, sequence) {
    const question = interaction.kind === "ask_user_questions";
    const requestSha256 = sha256(`${interaction.id}:${JSON.stringify(interaction.payload ?? {})}`);
    const record = {
      schemaVersion: 1, contractVersion: CONTRACT_VERSION,
      interactionId: interaction.id, conversationId: conversationIdOf(view.uuid),
      provider: { adapterId: SOURCE_ID, adapterVersion: "v0.1.0", sourceId: SOURCE_ID, runtimeInstanceId: instanceId },
      providerRequest: {
        // The method names the form of answer the host builds: text answers for
        // questions, accept or decline for everything else.
        method: question ? "item/tool/requestUserInput" : "item/paperclip/requestConfirmation",
        requestId: interaction.id, requestIdType: "string", generation: 1, threadId: view.uuid,
        turnId: interaction.sourceRunId ?? interaction.issueId, itemId: interaction.id, requestSha256,
      },
      interactionRequest: {
        requestId: interaction.id, requestSha256, sourceSequence: sequence,
        owner: { schemaVersion: 1, actorType: "local-operator", actorId: "local-board" },
        allowedResponses: question ? ["submit-text", "cancel"] : ["accept", "decline"],
      },
      display: question
        ? { kind: "user-input", title: clipText(interaction.title ?? tx("Agent question"), 4096),
          fields: { questions: (interaction.payload?.questions ?? []).map((item) => ({
            id: item.id,
            prompt: tx("{prompt}{value}", { prompt: item.prompt, value: (item.options ?? []).length === 0 ? "" : tx(" Options: {value}", { value: item.options.map((option) => option.label).join(" / ") }) }),
          })) } }
        : { kind: "permission-approval", title: clipText(interaction.title ?? interaction.kind, 4096),
          fields: { prompt: interaction.payload?.prompt ?? interaction.summary ?? null, paperclipKind: interaction.kind } },
      state: INTERACTION_STATE[interaction.status] ?? "resolved",
      response: null, providerResponseSha256: null,
      requestedAtUtc: iso(interaction.createdAt),
      // Paperclip sets no deadline on a question; none is invented here.
      deadlineAtUtc: null,
      updatedAtUtc: iso(interaction.updatedAt ?? interaction.createdAt),
      automaticRetryAllowed: false,
    };
    return { ...record, recordSha256: sha256(JSON.stringify(record)) };
  }

  async function interactionsOf(view) {
    const recent = [...view.issues].reverse().slice(0, 12);
    const lists = await Promise.all(recent.map((issue) => issueInteractions(issue.id)));
    return lists.flat().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async function interactionRecords(view, limit) {
    const records = (await interactionsOf(view)).map((interaction, index) => interactionRecord(view, interaction, index + 1));
    return {
      schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: view.agentId, sourceSequence: attentionSequence,
      records: records.slice(-limit), truncated: records.length > limit, omissionCount: Math.max(0, records.length - limit),
    };
  }

  /** The option a typed answer names: its label, its id or its number in the list. */
  function optionFor(question, text) {
    const wanted = text.trim().toLowerCase();
    const options = question.options ?? [];
    return options.find((option) => String(option.label).toLowerCase() === wanted || String(option.id).toLowerCase() === wanted)
      ?? (/^\d+$/.test(wanted) ? options[Number(wanted) - 1] : undefined) ?? null;
  }

  async function respond(view, input) {
    const response = input.response ?? {};
    const interaction = (await interactionsOf(view)).find((item) => item.id === response.interactionId);
    if (interaction === undefined) throw new Refusal("source_unavailable", "Unknown interaction");
    if (interaction.status !== "pending") throw new Refusal("conflict", "The request already has a decision");
    const before = interactionRecord(view, interaction, 0);
    if (response.requestSha256 !== before.providerRequest.requestSha256) {
      throw new Refusal("conflict", "Request identity does not match");
    }
    if (!before.interactionRequest.allowedResponses.includes(response.selectedResponse)) {
      throw new Refusal("conflict", "Choice is not allowed for this request");
    }
    const base = `/issues/${interaction.issueId}/interactions/${interaction.id}`;
    if (response.selectedResponse === "submit-text") {
      const typed = response.providerResponse?.answers ?? {};
      const answers = (interaction.payload?.questions ?? []).map((question) => {
        const text = String(typed[question.id]?.answers?.[0] ?? "");
        const option = optionFor(question, text);
        if (option === null && (question.options ?? []).length > 0 && question.allowOther === false) {
          throw new Refusal("conflict", "The answer is not one of the offered options", "answer_not_an_option");
        }
        return option === null ? { questionId: question.id, optionIds: [], otherText: text } : { questionId: question.id, optionIds: [option.id] };
      });
      await change("POST", `${base}/respond`, { answers });
    } else if (response.selectedResponse === "accept") {
      await change("POST", `${base}/accept`, {});
    } else if (response.selectedResponse === "decline") {
      await change("POST", `${base}/reject`, { reason: "Declined from the desk." });
    } else {
      // "cancel" on a question: the person chose not to answer it.
      await change("POST", `${base}/withdraw`, { reason: "Left unanswered from the desk." });
    }
    forget();
    const after = ((await issueInteractions(interaction.issueId)).find((item) => item.id === interaction.id)) ?? interaction;
    const record = { ...interactionRecord(view, after, 0), response: { ...response },
      providerResponseSha256: sha256(JSON.stringify(response.providerResponse ?? null)) };
    return {
      interaction: record, response: record.response,
      receipt: {
        schemaVersion: 1, contractVersion: CONTRACT_VERSION,
        interactionId: interaction.id, requestSha256: before.providerRequest.requestSha256,
        responseSha256: sha256(JSON.stringify(record.response)),
        providerResponseSha256: record.providerResponseSha256,
        deliveryState: "response-returned", automaticRetryAllowed: false,
      },
    };
  }

  // --- sending, stopping, closing ----------------------------------------------------

  /**
   * The message a send made, found by the send's own id - also after this
   * process restarted: the task it is in, when it was said, when the next
   * message was said (null when it is the last one), and the memory the agent
   * has had since it.
   */
  function sentOf(view, operationId) {
    const index = view.messages.findIndex((message) => message.operationId === operationId);
    if (index !== -1) {
      const carried = view.messages.slice(0, index + 1).reverse().find((message) => message.delivered !== null) ?? null;
      return { issue: view.conversation, message: view.messages[index], until: view.messages[index + 1]?.at ?? null,
        delivered: carried?.delivered ?? null };
    }
    // A task from before conversations: one message, one task.
    const issue = view.issues.find((item) => item !== view.conversation && operationOf(item.description) === operationId);
    if (issue === undefined) return null;
    const [message] = messagesOf(issue, []);
    return { issue, message, until: null, delivered: message.delivered };
  }

  /** The runs that answer one message: those of its task made after it and before the next message. */
  const runsOfSent = (view, sent) => runsOfIssue(view, sent.issue.id).filter((run) => String(run.createdAt) >= String(sent.message.at)
    && (sent.until === null || String(run.createdAt) < String(sent.until)));

  function operationRecord(view, operationId, sent) {
    const latest = runsOfSent(view, sent)[0] ?? null;
    return {
      schemaVersion: 1, operationId, agentId: view.agentId, kind: "send",
      // No run yet means the message is handed over and waiting for the agent to wake.
      state: latest === null ? "accepted" : (RUN_STATE[latest.status] ?? "uncertain"),
      turnId: latest === null ? null : latest.id,
      intentHash: sha256(sent.message.text),
      ...(sent.delivered === null ? {} : { manifest: manifestOf(sent.delivered.project, sent.delivered.quarter) }),
      requestedAtUtc: iso(sent.message.at),
      updatedAtUtc: iso(latest?.updatedAt ?? latest?.finishedAt ?? sent.message.at),
    };
  }

  /** A stable UUID for a send: Paperclip drops a second comment that carries the same one. */
  const requestIdOf = (operationId) => {
    const hex = sha256(`atlas-send:${operationId}`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };

  async function send(view, input) {
    const replay = sentOf(view, input.operationId);
    // The same operation id returns the message it already made instead of sending twice.
    if (replay !== null) return accepted(operationRecord(view, input.operationId, replay));
    if (!view.member) throw new Refusal("conflict", "The agent has no project and quarter", "agent_unbound");
    if (view.record.state !== "active") throw new Refusal("conflict", "The agent is not active", `agent_${view.record.state}`);
    // One piece of work at a time: busy work is refused, never queued behind the person's back.
    // A message that is handed over but not picked up yet counts as work too.
    if (view.runs.some((run) => ACTIVE_RUN.has(run.status)) || view.issues.some((issue) => issue.status === "todo") || view.waiting !== null) {
      throw new Refusal("conflict", "The agent is busy", "agent_busy");
    }
    const text = String(input.text ?? "");
    const memory = { project: view.project.scope, quarter: view.quarter.scope };
    const required = manifestOf(memory.project, memory.quarter);
    const conversation = await openConversation(view);
    // The memory travels with the first message, and again only when it is no longer what the agent was last given.
    const carried = [...view.messages].reverse().find((message) => message.delivered !== null) ?? null;
    const current = carried !== null
      && manifestOf(carried.delivered.project, carried.delivered.quarter).manifestHash === required.manifestHash;
    const body = `${current ? text.trim() : embedMemory({ ...memory, message: text, conversation: carried === null ? null : "update" })}\n\n${operationMarker(input.operationId)}`;
    // A person's comment wakes the agent, and reopens the task when it is closed.
    const comment = await change("POST", `/issues/${conversation.id}/comments`, { body, clientRequestId: requestIdOf(input.operationId) });
    forget();
    if (operationOf(comment?.body) !== input.operationId) {
      throw new Refusal("conflict", "Paperclip returned another comment instead of adding this one", "message_deduplicated");
    }
    return accepted({
      schemaVersion: 1, operationId: input.operationId, agentId: view.agentId, kind: "send", state: "accepted",
      turnId: null, intentHash: sha256(splitEmbeddedMemory(text).message), manifest: required,
      requestedAtUtc: iso(comment.createdAt ?? Date.now()), updatedAtUtc: iso(comment.createdAt ?? Date.now()),
    });
  }

  /**
   * The agent's conversation task, made on the first message. It is made
   * without waking the agent, and closed: a person's comment on a closed task
   * is what starts a run. That way every message - the first one too - reaches
   * the agent the same way, as a comment, and Paperclip treats every run as an
   * answer to a comment: it asks neither for a comment of the agent's own nor
   * for a "next step" run (both cost a whole extra run after a task's first
   * run otherwise).
   */
  async function openConversation(view) {
    let conversation = view.conversation;
    if (conversation === null) {
      // "backlog" is the one status in which assigning a task does not wake its agent.
      conversation = await createIssue({
        title: clipText(`Desk conversation: ${view.raw.name ?? view.agentId}`, 120), description: conversationDescription(),
        status: "backlog", priority: "medium", projectId: view.project.uuid, parentId: view.quarter.uuid, assigneeAgentId: view.uuid,
      }, `atlas-conversation-${view.uuid}`);
      forget();
      if (!isConversation(conversation?.description) || conversation.assigneeAgentId !== view.uuid) {
        throw new Refusal("conflict", "Paperclip returned another task instead of creating this one", "task_deduplicated");
      }
    }
    if (conversation.status === "backlog") await change("PATCH", `/issues/${conversation.id}`, { status: "done" });
    return conversation;
  }

  async function receipt(view, input) {
    const sent = sentOf(view, input.operationId);
    let record;
    if (sent !== null) {
      record = operationRecord(view, input.operationId, sent);
    } else {
      // Work that was not sent from the desk is known by its run.
      const run = view.runs.find((item) => item.id === input.operationId);
      if (run === undefined) throw new Refusal("source_unavailable", "Unknown operation");
      record = {
        schemaVersion: 1, operationId: run.id, agentId: view.agentId, kind: "send", state: RUN_STATE[run.status] ?? "uncertain",
        turnId: run.id, intentHash: sha256(run.id), requestedAtUtc: iso(run.createdAt),
        updatedAtUtc: iso(run.updatedAt ?? run.finishedAt ?? run.createdAt),
      };
    }
    const going = record.state === "accepted" || record.state === "started";
    return { ...record, observation: going ? "available" : "terminal", automaticRetryAllowed: false };
  }

  async function interrupt(view, input) {
    const sent = sentOf(view, input.operationId);
    const run = (sent === null ? view.runs.filter((item) => item.id === input.operationId) : runsOfSent(view, sent))
      .find((item) => ACTIVE_RUN.has(item.status));
    if (run === undefined) throw new Refusal("conflict", "There is no running turn to stop", "no_active_turn");
    await change("POST", `/heartbeat-runs/${run.id}/cancel`, {});
    // Paperclip leaves a stopped task "in progress"; say what happened to it instead.
    // A cancelled conversation is not over: the person's next message reopens it.
    const issueId = run.contextSnapshot?.issueId ?? null;
    if (issueId !== null) {
      try {
        await change("PATCH", `/issues/${issueId}`, { status: "cancelled" });
      } catch { /* the run is stopped; the task's status is a courtesy */ }
    }
    forget();
    return accepted({ operationId: input.operationId, turnId: run.id, state: "accepted", automaticRetryAllowed: false });
  }

  async function closeAgent(view) {
    if (view.runs.some((run) => ACTIVE_RUN.has(run.status))) throw new Refusal("conflict", "The current turn is not terminal", "agent_busy");
    await change("POST", `/agents/${view.uuid}/terminate`, {});
    forget();
    return (await agentOf(view.agentId)).record;
  }

  // --- creating ----------------------------------------------------------------------

  async function labelIds() {
    const snapshot = await loadSnapshot();
    const ids = { ...snapshot.labels };
    for (const [key, name] of [["quarter", QUARTER_LABEL], ["memory", PROJECT_MEMORY_LABEL]]) {
      if (ids[key] === null) ids[key] = (await change("POST", `${company}/labels`, { name, color: LABEL_COLORS[name] })).id;
    }
    return ids;
  }

  /**
   * Creates one issue, and exactly one. Paperclip by itself returns an existing
   * open issue when another with the same title and parent was made in the last
   * 48 hours - two projects' "Project memory", or two messages that start with
   * the same line, would silently become one. `allowDuplicate` turns that off;
   * the idempotency key keeps a repeated request from making a second issue.
   */
  const createIssue = (body, idempotencyKey = null) => change("POST", `${company}/issues`, {
    ...body, allowDuplicate: true, ...(idempotencyKey === null ? {} : { idempotencyKey }),
  });

  const memoryIssueOf = async (projectUuid, memoryLabel) => createIssue({
    title: "Project memory",
    description: "Holds the project memory (the rules of the project) as the `memory` document. Not a task.",
    status: "backlog", projectId: projectUuid, labelIds: [memoryLabel],
  });

  async function createScope(input) {
    const snapshot = await loadSnapshot();
    const labels = await labelIds();
    if (input.kind === "project") {
      if (snapshot.projectById.has(input.projectId)) throw new Refusal("conflict", "Project already exists");
      const project = await change("POST", `${company}/projects`, {
        name: input.title, description: atlasIdMarker(input.projectId), status: "in_progress",
      });
      await memoryIssueOf(project.id, labels.memory);
    } else {
      const project = snapshot.projectById.get(input.projectId);
      if (project === undefined) throw new Refusal("source_unavailable", "Unknown project");
      if (snapshot.quarters.some((quarter) => quarter.project === project && quarter.quarterId === input.quarterId)) {
        throw new Refusal("conflict", "Quarter already exists");
      }
      await createIssue({
        title: input.title,
        description: `${atlasIdMarker(input.quarterId)}\n\nA quarter (feature). Its child issues are the work given to the agents of this quarter; its \`memory\` document is the quarter memory.`,
        status: "backlog", projectId: project.uuid, labelIds: [labels.quarter],
      }, safeId(input.operationId));
    }
    forget();
    const created = (await loadSnapshot()).scopes.find((scope) => scope.scopeId === input.scopeId);
    if (created === undefined) {
      debug(`scope ${input.scopeId} was created but is not in the catalog that was read after it`);
      throw new Uncertain();
    }
    return created;
  }

  async function createAgent(input) {
    const snapshot = await loadSnapshot();
    if (snapshot.agentById.has(input.agentId)) throw new Refusal("conflict", "Agent already exists");
    const project = snapshot.projectById.get(input.projectId);
    const quarter = snapshot.quarters.find((item) => item.project === project && item.quarterId === input.quarterId);
    if (project === undefined || quarter === undefined) {
      throw new Refusal("source_unavailable", "Both the project and the quarter must exist first");
    }
    // Paperclip runs an agent in its project's folder and refuses one that is not a git repository.
    if (project.cwd === null) throw new Refusal("conflict", "Bind the project folder first", "workspace_not_bound");
    const adapterType = PROVIDER_ADAPTER[input.profile.provider] ?? input.profile.provider;
    const known = (await get("/adapters")) ?? [];
    if (!known.some((adapter) => adapter.type === adapterType)) {
      throw new Refusal("conflict", "Paperclip has no such adapter", "profile_provider_unknown");
    }
    const effort = input.profile.reasoningEffort;
    await change("POST", `${company}/agents`, {
      name: input.agentId, role: "engineer", adapterType,
      adapterConfig: {
        ...config.agentDefaults, cwd: project.cwd,
        ...(input.profile.model === "default" ? {} : { model: input.profile.model }),
        ...(effort === "default" ? {} : { effort }),
      },
      metadata: { atlas: { agentId: input.agentId, projectId: project.uuid, quarterIssueId: quarter.uuid, operationId: input.operationId } },
    });
    forget();
    return (await agentOf(input.agentId)).record;
  }

  // --- memory writes (called by the host's trusted actions, not over the transport) ----

  async function saveMemory({ scopeId, expectedRevision, entries }) {
    forget();
    const snapshot = await loadSnapshot();
    const home = snapshot.scopeHome.get(scopeId);
    if (home === undefined) return { ok: false, error: { code: "source_unavailable", reasonCode: "scope_unknown" } };
    const current = home.view.scope;
    if (current.revision !== expectedRevision) return { ok: false, error: { code: "stale_revision", reasonCode: "stale_revision" } };
    const body = markdownFromEntries(entries);
    try {
      let issueId = home.kind === "quarter" ? home.view.uuid : home.view.memoryIssue?.id ?? null;
      if (issueId === null) issueId = (await memoryIssueOf(home.view.uuid, (await labelIds()).memory)).id;
      const document = home.view.document ?? null;
      await change("PUT", `/issues/${issueId}/documents/memory`, {
        title: home.kind === "quarter" ? "Quarter memory" : "Project memory", format: "markdown", body,
        ...(document === null ? {} : { baseRevisionId: document.latestRevisionId }),
      });
    } catch (error) {
      if (error instanceof Uncertain) return { ok: false, error: { code: "uncertain_outcome", reasonCode: "no_answer", uncertain: true } };
      if (error instanceof Refusal) {
        // Paperclip guards the document by its own revision: a change made there since our read is the same conflict.
        return error.code === "conflict"
          ? { ok: false, error: { code: "stale_revision", reasonCode: "stale_revision" } }
          : { ok: false, error: { code: error.code, reasonCode: error.reasonCode } };
      }
      throw error;
    }
    forget();
    const saved = (await loadSnapshot()).scopeHome.get(scopeId)?.view.scope ?? null;
    return { ok: true, receipt: {
      status: "written", scopeId, revision: saved?.revision ?? null, sha256: saved?.sha256 ?? null,
      entryCount: entries.length, replay: false,
    } };
  }

  async function bindWorkspace({ projectId, workspacePath }) {
    forget();
    const project = (await loadSnapshot()).projectById.get(projectId);
    if (project === undefined) return { ok: false, error: { code: "source_unavailable", reasonCode: "project_unknown" } };
    const fingerprint = sha256(path.resolve(workspacePath).toLowerCase());
    if (project.cwd !== null) {
      return sha256(path.resolve(project.cwd).toLowerCase()) === fingerprint
        ? { ok: true, response: { status: "bound", projectId, workspaceFingerprint: fingerprint, replay: true } }
        : { ok: false, error: { code: "conflict", reasonCode: "workspace_binding_conflict" } };
    }
    try {
      await lstat(path.join(workspacePath, ".git"));
    } catch {
      // Paperclip would accept the folder and then refuse every run in it.
      return { ok: false, error: { code: "workspace_not_a_git_repository", reasonCode: "workspace_not_a_git_repository" } };
    }
    try {
      await change("POST", `/projects/${project.uuid}/workspaces`, {
        name: path.basename(workspacePath), cwd: workspacePath.replace(/\\/g, "/"), isPrimary: true,
      });
    } catch (error) {
      if (error instanceof Uncertain) return { ok: false, error: { code: "uncertain_outcome", reasonCode: "no_answer", uncertain: true } };
      if (error instanceof Refusal) return { ok: false, error: { code: error.code, reasonCode: error.reasonCode } };
      throw error;
    }
    forget();
    return { ok: true, response: { status: "bound", projectId, workspaceFingerprint: fingerprint, replay: false } };
  }

  // --- project files -----------------------------------------------------------------

  const WORKSPACE_BASE = Object.freeze({ schemaVersion: 1, contractVersion: CONTRACT_VERSION });

  async function projectRoot(projectId) {
    const view = (await loadSnapshot()).projectById.get(projectId);
    if (view === undefined || view.cwd === null) {
      throw new Refusal("source_unavailable", "Project folder not bound", "workspace_not_bound");
    }
    const root = path.resolve(view.cwd);
    try {
      if (!(await lstat(root)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Refusal("source_unavailable", "Project folder is gone", "workspace_path_missing");
    }
    return root;
  }

  /** A project-relative path, confined to the project folder; anything else is refused without a reason. */
  function resolveInside(root, relative, refusal = "source_unavailable") {
    if (typeof relative !== "string" || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative)) {
      throw new Refusal(refusal, "Path refused");
    }
    const parts = relative.split("/").filter((part) => part !== "");
    if (parts.some((part) => part === "." || part === ".." || part === ".git")) {
      throw new Refusal(refusal, "Path refused");
    }
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Refusal(refusal, "Path refused");
    return target;
  }

  async function listFiles(input) {
    const root = await projectRoot(input.projectId);
    const directory = input.path ?? "";
    const target = resolveInside(root, directory);
    let names;
    try {
      names = await readdir(target);
    } catch {
      throw new Refusal("source_unavailable", "No such directory");
    }
    const entries = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name === ".git") continue;
      let info;
      try {
        info = await lstat(path.join(target, name));
      } catch {
        continue;
      }
      // Links are not followed: a link could lead outside the project folder.
      if (info.isDirectory()) entries.push({ name, kind: "directory", sizeBytes: null, contentSha256: null });
      else if (info.isFile()) entries.push({ name, kind: "file", sizeBytes: info.size, contentSha256: null });
    }
    const limit = Math.min(input.limit ?? 128, 256);
    return {
      ...WORKSPACE_BASE, projectId: input.projectId, path: directory, kind: "list",
      contentSha256: sha256(JSON.stringify(entries)), observedAtUtc: iso(Date.now()),
      entries: entries.slice(0, limit), totalEntries: Math.min(entries.length, 4096),
      omissionCount: Math.max(0, entries.length - limit), truncated: entries.length > limit, nextCursor: null,
    };
  }

  /** The whole text file, or a refusal: missing, not a plain file, larger than 1 MiB, or not text. */
  async function textFileBytes(target, refusal = "source_unavailable") {
    let info;
    try {
      info = await lstat(target);
    } catch {
      throw new Refusal(refusal, "No such file");
    }
    if (!info.isFile() || info.size > FILE_MAX_BYTES) throw new Refusal(refusal, "File is not readable here");
    const handle = await open(target, "r");
    let bytes;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.includes(0)) throw new Refusal(refusal, "File is not text");
    return bytes;
  }

  async function readFilePage(projectId, relative, maximumBytes, cursor) {
    const root = await projectRoot(projectId);
    const bytes = await textFileBytes(resolveInside(root, relative));
    let offset = 0;
    if (cursor !== null && cursor !== undefined) {
      const match = /^pc-file:(\d+)$/u.exec(cursor);
      if (match === null || Number(match[1]) > bytes.length) throw new Refusal("stale_revision", "Unknown file cursor", "cursor_invalid");
      offset = Number(match[1]);
    }
    let end = Math.min(offset + Math.min(maximumBytes ?? PAGE_MAX_BYTES, PAGE_MAX_BYTES), bytes.length);
    // Never cut a UTF-8 character in half.
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const chunk = bytes.subarray(offset, end);
    return {
      ...WORKSPACE_BASE, projectId, path: relative, kind: "read", contentSha256: sha256(bytes),
      observedAtUtc: iso(Date.now()), text: chunk.toString("utf8"),
      range: { offsetBytes: offset, returnedBytes: chunk.length, totalBytes: bytes.length },
      truncated: end < bytes.length, nextCursor: end < bytes.length ? `pc-file:${end}` : null,
    };
  }

  /** Replaces a text file only while it still is the version that was read. */
  async function saveFile(input) {
    const root = await projectRoot(input.projectId);
    const target = resolveInside(root, input.path, "access_denied");
    const text = String(input.text ?? "");
    const next = Buffer.from(text, "utf8");
    if (next.length > FILE_MAX_BYTES) throw new Refusal("access_denied", "Project file save refused");
    const current = await textFileBytes(target, "access_denied");
    if (sha256(current) !== input.expectedSha256) throw new Refusal("stale_revision", "Project file save refused");
    // Written beside the file and moved over it, so a reader never sees half of it.
    const temporary = `${target}.atlas-${randomUUID()}.tmp`;
    await writeFile(temporary, next);
    await moveOver(temporary, target);
    return {
      ...WORKSPACE_BASE, projectId: input.projectId, path: input.path, operationId: input.operationId,
      previousSha256: input.expectedSha256, contentSha256: sha256(next), bytesWritten: next.length,
      completedAtUtc: iso(Date.now()),
    };
  }

  // --- events ------------------------------------------------------------------------
  //
  // Paperclip pushes live events over a WebSocket; the desk's contract is a
  // cursor read. The bridge keeps a small log per agent and fills it by
  // comparing what it sees now with what it saw at the previous read.

  const watched = new Map();
  const eventCursor = (agentId, sequence) => `pc-events:${instanceId}:${agentId}:${sequence}`;

  function observe(view) {
    let state = watched.get(view.agentId);
    const first = state === undefined;
    if (first) {
      state = { runs: new Map(), pending: null, log: [] };
      watched.set(view.agentId, state);
    }
    const append = (kind, turnId) => state.log.push({
      sequence: state.log.length + 1, turnId: safeId(turnId), itemId: null, kind, observedAtUtc: iso(Date.now()),
    });
    for (const run of [...view.runs].reverse()) {
      const before = state.runs.get(run.id);
      const active = ACTIVE_RUN.has(run.status);
      if (!first) {
        if (before === undefined) {
          append("turn-started", run.id);
          if (!active) append("turn-completed", run.id);
        } else if (ACTIVE_RUN.has(before) && !active) {
          append("turn-completed", run.id);
        } else if (active) {
          // A run in progress keeps producing output: the conversation is worth reading again.
          append("item-completed", run.id);
        }
      }
      state.runs.set(run.id, run.status);
    }
    const pending = view.pending.map((item) => item.id).join(",");
    if (!first && pending !== state.pending) append("interaction-changed", null);
    state.pending = pending;
    return state;
  }

  async function eventsPage(view, input) {
    const binding = bindingOf(view);
    if (binding.conversationId === null) throw new Refusal("source_unavailable", "Agent has no conversation", "agent_unbound");
    const state = observe(view);
    const head = eventCursor(view.agentId, state.log.length);
    const page = (mode, reasonCode, events, hasMore, nextCursor) => ({
      ...WORKSPACE_BASE, agentId: view.agentId, conversationId: binding.conversationId, mode, reasonCode,
      coverage: "observed-only", events, hasMore, nextCursor, observedAtUtc: iso(Date.now()),
    });
    if (input.cursor === undefined || input.cursor === null) return page("snapshot-required", "initial_snapshot_required", [], false, head);
    const parts = /^pc-events:([^:]+):(.+):(\d+)$/u.exec(input.cursor);
    if (parts === null || parts[1] !== instanceId || parts[2] !== view.agentId || Number(parts[3]) > state.log.length) {
      return page("resync-required", "cursor_invalid", [], false, head);
    }
    const limit = Math.min(input.limit ?? 64, 64);
    const after = state.log.slice(Number(parts[3]));
    const events = after.slice(0, limit);
    return page("resumed", null, events, after.length > limit, eventCursor(view.agentId, Number(parts[3]) + events.length));
  }

  // --- discovery ---------------------------------------------------------------------

  let discoverySequence = 0;
  async function capabilities(now) {
    const example = JSON.parse(await kit.readText("examples/capabilities.discovery.v1.json"));
    const operations = {};
    for (const [family, entries] of Object.entries(example.surface.operations)) {
      operations[family] = entries.filter(({ operation }) => (
        operation.operationId === DISCOVERY_OPERATION_ID || IMPLEMENTED[operation.operationId] === family));
    }
    discoverySequence += 1;
    return {
      ...example,
      descriptorId: `application-capabilities:${workspace.projectId}`,
      sourceId: SOURCE_ID,
      sequence: discoverySequence,
      publishedAtUtc: iso(now),
      validForSeconds: 300,
      surface: { ...example.surface, operations },
      // Provider-scoped routes are not offered by this bridge.
      providerOperations: { ...example.providerOperations, definitions: [] },
      providerStates: [],
    };
  }

  function descriptorAt(now) {
    const publishedAtUtc = iso(now - 1_000);
    const validUntilUtc = iso(now + 1_800_000);
    return {
      schemaVersion: 1, contractVersion: "v0.2.0",
      descriptorId: `application-gateway:${sha256(`${workspace.projectId}:${instanceId}:${publishedAtUtc}`)}`,
      transportId: "loopback-http-json-ndjson-v1", publishedAtUtc, validUntilUtc,
      instance: {
        instanceId, generation: 1, lifecycleIdentitySha256: sha256(instanceId),
        processId: process.pid, processStartedAtUtc: iso(now - 9_000),
        readyAtUtc: iso(now - 4_000), adapterVersion: "v0.1.0-paperclip",
      },
      workspace: { ...workspace },
      endpoint: {
        schemaVersion: 1, contractVersion: CONTRACT_VERSION,
        transportId: "loopback-http-json-ndjson-v1", instanceId,
        lifecycleIdentitySha256: sha256(instanceId), sessionId,
        workspaceRootSha256: workspace.workspaceRootSha256,
        scheme: "http", host: "127.0.0.1", port: config.port, authority: `127.0.0.1:${config.port}`,
        endpointId: `gateway-endpoint-${sha256(`${instanceId}:${sessionId}`)}`,
      },
      authorization: {
        scheme: "Bearer", sessionId,
        // Not a credential: a local trusted Paperclip needs none, and the bridge sends none.
        bearerToken: `bridge-${"0".repeat(37)}`, expiresAtUtc: validUntilUtc,
      },
      routes: [
        { routeId: "application-operations", method: "POST", path: "/v1/operations",
          requestContractVersion: CONTRACT_VERSION, responseMediaType: "application/json" },
        { routeId: "application-event-read", method: "POST", path: "/v1/events/read",
          requestContractVersion: CONTRACT_VERSION, responseMediaType: "application/x-ndjson" },
      ],
      capabilityDiscovery: { operationId: DISCOVERY_OPERATION_ID, contractVersion: CAPABILITY_VERSION },
      exposedOperations: [
        operationRef("discovery", DISCOVERY_OPERATION_ID),
        ...Object.entries(IMPLEMENTED).map(([operationId, family]) => operationRef(family, operationId)),
      ],
    };
  }

  // --- operations --------------------------------------------------------------------

  async function answer(operationId, input) {
    switch (operationId) {
      case "query.memory.scopes.list": {
        const snapshot = await loadSnapshot();
        return { schemaVersion: 1, truncated: false, scopes: snapshot.scopes.map(({ entries, ...metadata }) => metadata) };
      }
      case "query.memory.scope.read": {
        const found = (await loadSnapshot()).scopes.find((scope) => scope.scopeId === input.scopeId);
        if (found === undefined) throw new Refusal("source_unavailable", "Unknown scope");
        return found;
      }
      case "query.memory.agents.list": {
        const snapshot = await loadSnapshot();
        return { schemaVersion: 1, revision: catalogRevision, agents: snapshot.agents.map((view) => view.record) };
      }
      case "query.memory.agent.read":
        return (await agentOf(input.agentId)).record;
      case "query.memory.agent.context": {
        const view = await agentOf(input.agentId);
        return {
          schemaVersion: 1, agentId: view.agentId,
          contentState: view.record.contentState, deliveryState: view.record.deliveryState,
          startBlockedByEmptyMemory: false,
          project: view.member ? view.project.scope : null, quarter: view.member ? view.quarter.scope : null,
          manifestHash: view.record.requiredManifest.manifestHash,
          deliveredManifest: view.record.deliveredManifest, requiredManifest: view.record.requiredManifest,
        };
      }
      case "query.memory.agent.archive":
        return archivePage(await agentOf(input.agentId), input);
      case "query.agent-control.interactions":
        return interactionRecords(await agentOf(input.agentId), input.limit ?? 16);
      case "query.agent-conversation.resolve":
        return bindingOf(await agentOf(input.agentId));
      case "query.agent-conversation.read":
        return conversationPage(await agentOf(input.agentId), input);
      case "query.project-workspace.list":
        return listFiles(input);
      case "query.project-workspace.read":
        return readFilePage(input.projectId, input.path, input.maximumBytes, input.cursor);
      case "query.agent-artifacts.list": {
        const view = await agentOf(input.agentId);
        // Nothing registers artifacts through this bridge yet: the list is empty, not unknown.
        return { ...WORKSPACE_BASE, agentId: view.agentId, revision: 0, coverage: "registered-only", records: [], truncated: false };
      }
      case "query.agent-artifacts.read":
        throw new Refusal("source_unavailable", "Unknown artifact", "artifact_not_registered");
      case "query.agent-events.read":
        return eventsPage(await agentOf(input.agentId), input);

      case "receipt.memory.agent.send":
        forget();
        return receipt(await agentOf(input.agentId), input);
      case "mutation.memory.agent.send":
        forget();
        return send(await agentOf(input.agentId), input);
      case "mutation.agent-control.interrupt":
        forget();
        return interrupt(await agentOf(input.agentId), input);
      case "approval.agent-control.respond":
        forget();
        return respond(await agentOf(input.agentId), input);
      case "mutation.memory.agent.close":
        forget();
        return closeAgent(await agentOf(input.agentId));
      case "mutation.memory.scope.create":
        forget();
        return createScope(input);
      case "mutation.memory.agent.create":
        forget();
        return createAgent(input);
      case "mutation.project-workspace.save":
        return saveFile(input);
      default:
        throw new Refusal("unsupported_capability", "The Paperclip bridge does not implement it");
    }
  }

  async function handle(request) {
    const started = Date.now();
    const operationId = request?.operation?.operationId;
    try {
      if (operationId === DISCOVERY_OPERATION_ID) {
        return envelope(request, started, { outcome: "succeeded", output: { capabilities: await capabilities(started) } });
      }
      const result = await answer(operationId, request?.input ?? {});
      return result !== null && typeof result === "object" && result.accepted === true && "output" in result
        ? envelope(request, started, { outcome: "accepted", output: result.output })
        : envelope(request, started, { outcome: "succeeded", output: result });
    } catch (error) {
      if (error instanceof Uncertain) {
        forget();
        return envelope(request, started, { outcome: "uncertain", error: {
          code: "uncertain_outcome", message: "Paperclip did not answer; the change may have been applied",
          retryable: false, phase: "observation",
        } });
      }
      if (error instanceof Refusal) return failure(request, started, error.code, error.message, error.reasonCode);
      debug(`${operationId} failed inside the bridge: ${error?.stack ?? error}`);
      return failure(request, started, "source_unavailable", "The Paperclip bridge failed", "bridge_error");
    }
  }

  async function fetchImpl(url, options = {}) {
    if (!String(url).endsWith("/v1/operations")) return new Response("route not implemented", { status: 404 });
    const result = await handle(JSON.parse(options.body));
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  return {
    workspace: { ...workspace },
    resolveDescriptor: async () => ((await reachable())
      ? { status: "available", descriptor: descriptorAt(Date.now()) }
      : { status: "unavailable", reasonCode: "paperclip_unreachable" }),
    fetchImpl,
    saveMemory,
    bindWorkspace,
    // What the readiness panel may show about the backend: no address, no ids beyond the world's own.
    readRuntimeSummary: async () => {
      const ok = await reachable();
      return {
        controllerRootConfigured: true, status: ok ? "read" : "missing",
        lifecycle: ok ? "ready" : "stopped", health: ok ? "paperclip" : null,
        heartbeatAtUtc: ok ? iso(health.at) : null, failureReasonCode: ok ? null : "paperclip_unreachable",
        generation: 1, projectId: workspace.projectId, descriptorPresent: ok,
      };
    },
  };
}

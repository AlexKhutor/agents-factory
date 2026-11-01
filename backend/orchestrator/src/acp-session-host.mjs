import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { ADAPTER_CONTRACT_VERSION, validateAdapterDescriptor } from "./adapter-contracts.mjs";
import { secretToolReason } from "./agent-secret-paths.mjs";
import {
  conversationReadCapabilityExtension,
  isProviderConversationReadOperation,
} from "./provider-conversation-read-contract.mjs";
import { CLAUDE_CODE_SESSION_LIMITS, claudeSessionId, clipText } from "./claude-code-session-journal.mjs";

// Agents that speak the Agent Client Protocol (DeepSeek Harness `dsh --profile
// acp`, for example), presented to the rest of the backend in the same shape
// as claude-code-session-host.mjs: threads, turns and items; `turn/started`,
// `item/started`, `item/completed` and `turn/completed`; server requests for
// the person's decisions. The conversation read adapter, the interaction
// bridge, the archive and the agent event stream therefore work unchanged.
//
// One agent process serves every session. A thread is one ACP session and its
// id is the session id the agent gave (a UUID). A turn is one `session/prompt`,
// and the messages that waited for its end go as further prompts of the same
// turn. ACP has no steering: a message for a running turn always waits.
// Sessions the process does not hold (after a Gateway or agent restart) are
// taken back with `session/resume`.

export const ACP_SESSION_HOST_VERSION = "v0.1.0";
export const ACP_ADAPTER_ID = "acp-stdio";
export const ACP_ADAPTER_VERSION = "v0.1.0";
export const ACP_PROVIDER_ID = "acp";
export const ACP_PROTOCOL_VERSION = 1;

/** The agent's own tool names (DeepSeek Harness) that run commands, and that write files (with the path's field). */
export const ACP_SHELL_TOOLS = Object.freeze(new Set(["bash", "pwsh", "shell"]));
export const ACP_FILE_TOOLS = Object.freeze(new Map([
  ["write", "file_path"], ["edit", "file_path"], ["str_replace_editor", "path"],
]));
/** Its tools that only read. The desk gate asks about them too, so a secret is refused (agent-secret-paths.mjs). */
export const ACP_READ_TOOLS = Object.freeze(new Map([
  ["read", ["file_path"]], ["read_image", ["file_path"]], ["glob", ["path"]], ["grep", ["path", "include"]],
]));
const ACP_PATH_FIELDS = new Map([...[...ACP_FILE_TOOLS].map(([name, field]) => [name, [field]]), ...ACP_READ_TOOLS]);
const ACP_SHELLS = new Map([["bash", false], ["shell", false], ["pwsh", true]]);

const TRACE_LIMITS = Object.freeze({ textBytes: 128 * 1024, inputBytes: 64 * 1024, outputBytes: 64 * 1024 });
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const STOP_GRACE_MS = 10_000;
// A local model may think long before its first word on a long prompt: ten minutes of silence by default.
export const DEFAULT_SILENCE_MS = 10 * 60 * 1000;
const SETUP_TIMEOUT_MS = 120_000;
// The agent's model did not answer: its server is off or out of reach (a proxy's 502-504, a refused or
// timed-out connection). The person can act on that, so the turn says it (`acp_model_unreachable`).
const MODEL_UNREACHABLE = /\b50[234]\b[^\n]{0,24}status|status[^\n]{0,8}\b50[234]\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|fetch failed|socket hang up|connect(?:ion)? (?:refused|error|timed? ?out)/iu;

function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }

function clip(value, maximumBytes) { return clipText(value, maximumBytes).text; }

function capability(operation, { visibility = "headless", recovery = ["none"] } = {}) {
  return {
    operation, support: "native", contractVersions: [ADAPTER_CONTRACT_VERSION],
    guarantees: ["exact-native-identity",
      ...(operation === "observeLifecycle"
        ? ["provider-observed-start", "provider-observed-terminal", "ordered-lifecycle"] : [])],
    visibility, interruptBehavior: "not-applicable", recovery,
    limits: operation === "listThreads" ? { maximumItems: 128 } : {},
    extensions: isProviderConversationReadOperation(operation) ? [conversationReadCapabilityExtension()] : [],
  };
}

/** The read-side adapter descriptor of the ACP provider runtime. */
export function createAcpProviderDescriptor({ sourceId, runtimeInstanceId, observedAtUtc }) {
  const identity = { adapterId: ACP_ADAPTER_ID, adapterFamily: "execution-provider",
    adapterVersion: ACP_ADAPTER_VERSION, sourceId, runtimeInstanceId };
  return validateAdapterDescriptor({
    schemaVersion: 1, contractVersion: ADAPTER_CONTRACT_VERSION, identity,
    authority: { schemaVersion: 1, authorityType: "provider", sourceId,
      externalId: runtimeInstanceId, contractVersion: ACP_ADAPTER_VERSION },
    capabilities: [
      capability("discoverCapabilities"),
      capability("listModels"),
      capability("listThreads", { recovery: ["reconnect"] }),
      capability("readThread", { recovery: ["reconnect", "read-after-disconnect"] }),
      capability("getUsage", { recovery: ["reconnect"] }),
      capability("observeLifecycle", { visibility: "provider-observed", recovery: ["reconnect"] }),
    ],
    capabilitiesObservedAtUtc: observedAtUtc,
    capabilitiesValidForSeconds: 3600,
    extensions: [],
  });
}

/**
 * Models offered to desk agents, from the machine-local config: `id` is what
 * the desk shows and records, `value` the agent's own value of its "model"
 * config option (DeepSeek Harness: JSON of [provider, model]); `efforts` the
 * agent's "reasoning_effort" values, "default" leaving the agent's own.
 */
export function normalizeAcpModels(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 32) fail("acp_models_invalid");
  return models.map((model) => {
    if (!model || typeof model !== "object" || typeof model.id !== "string" || !ID.test(model.id)) {
      fail("acp_models_invalid");
    }
    const value = model.value ?? null;
    if (value !== null && (typeof value !== "string" || value.length > 512)) fail("acp_models_invalid");
    const efforts = model.efforts ?? ["default"];
    if (!Array.isArray(efforts) || efforts.length < 1
        || efforts.some((effort) => typeof effort !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(effort))) {
      fail("acp_models_invalid");
    }
    const defaultEffort = model.defaultEffort ?? efforts[0];
    if (!efforts.includes(defaultEffort)) fail("acp_models_invalid");
    // Where Atlas asks whether the model's server answers (an address of the server, no key, no tokens).
    const check = model.check ?? null;
    if (check !== null && (typeof check !== "string" || !/^https?:\/\/[^\s]{1,500}$/u.test(check))) fail("acp_models_invalid");
    return { id: model.id, value, displayName: typeof model.displayName === "string" ? model.displayName.slice(0, 256) : model.id,
      efforts: [...new Set(efforts)], defaultEffort, check };
  });
}

function textOf(input) {
  if (!Array.isArray(input) || input.length < 1
      || input.some((part) => part?.type !== "text" || typeof part.text !== "string")) {
    fail("invalid_request", "Only text input is supported");
  }
  const text = input.map((part) => part.text).join("\n");
  if (!text.trim()) fail("invalid_request", "Input text is empty");
  return text;
}

/** The text of ACP content blocks (a tool's result, a message). */
function contentText(content) {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => {
    const inner = block?.type === "content" ? block.content : block;
    if (inner?.type === "text" && typeof inner.text === "string") return inner.text;
    if (inner?.type === "image") return "[image]";
    if (inner?.type === "resource_link" && typeof inner.uri === "string") return inner.uri;
    return "";
  }).filter(Boolean).join("\n");
}

const lineCount = (text) => (typeof text === "string" && text !== "" ? text.split(/\r?\n/u).length : 0);
const text = (value, maximumBytes) => (typeof value === "string" && value !== "" ? clip(value, maximumBytes) : null);
const inputOf = (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});

/** The chat item a tool call becomes, in the item shapes of the Codex client. */
function toolItem(id, name, input) {
  if (ACP_SHELL_TOOLS.has(name)) {
    return { id, type: "commandExecution", tool: name, command: clip(input.command ?? "", 8192),
      description: text(input.description, 512), aggregatedOutput: null, exitCode: null, status: "inProgress" };
  }
  if (ACP_FILE_TOOLS.has(name) && !(name === "str_replace_editor" && input.command === "view")) {
    const target = input[ACP_FILE_TOOLS.get(name)];
    const writes = name === "write" || (name === "str_replace_editor" && input.command === "create");
    const added = lineCount(input.content ?? input.file_text ?? input.new_string ?? input.new_str ?? input.insert_text);
    const removed = writes ? null : lineCount(input.old_string ?? input.old_str);
    return { id, type: "fileChange", tool: name,
      changes: typeof target === "string" ? [{ path: clip(target, 1024), kind: writes ? "write" : "update", added, removed }] : [],
      status: "inProgress" };
  }
  const keys = Object.keys(input);
  return { id, type: "mcpToolCall", tool: clip(name, 256),
    detail: keys.length === 0 ? null : clip(JSON.stringify(input), 512), status: "inProgress" };
}

function threadView(session, active, turns = null) {
  return {
    id: session.sessionId, name: null, status: active ? "active" : "idle",
    updatedAt: session.updatedAtUtc, createdAt: session.createdAtUtc,
    ...(turns === null ? {} : { turns: turns.map(turnView) }),
  };
}

function turnView(turn) {
  return { id: turn.id, status: turn.status, startedAt: turn.startedAt, completedAt: turn.completedAt,
    items: structuredClone(turn.items) };
}

function pageOf(values, { cursor = null, limit = 32 } = {}) {
  const start = cursor === null || cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > values.length) fail("invalid_request", "Invalid cursor");
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 128) : 32;
  const end = Math.min(values.length, start + size);
  return { data: values.slice(start, end), nextCursor: end < values.length ? String(end) : null };
}

/** The current value of one of the agent's config options. */
function optionValue(configOptions, id) {
  const option = Array.isArray(configOptions) ? configOptions.find((entry) => entry?.id === id) : null;
  return typeof option?.currentValue === "string" ? option.currentValue : null;
}

export class AcpSessionHost extends EventEmitter {
  #startClient;
  #journal;
  #now;
  #models;
  #mcpServers;
  #requestTimeoutMs;
  #onDiagnostic;
  #recoverOnConnect;
  #stopGraceMs;
  #client = null;
  #starting = null;
  #agentInfo = null;
  #loaded = new Set();
  #configured = new Map();
  #handlers = new Map();
  #running = new Map();
  #silenceTimeoutMs;
  #silenceCheckMs;
  #updates = Promise.resolve();
  #generation = 0;
  #closed = false;

  /**
   * `startClient()`: a new, started AcpStdioClient (acp-stdio-client.mjs) for
   * the agent process; called again when the process has ended. `mcpServers`:
   * the ACP MCP server list every session gets (session/new and session/resume).
   */
  /**
   * `silenceTimeoutMs`: a turn whose agent gives no sign of life that long (no update, no question to the
   * desk) while nobody is waiting for the person ends as `acp_model_unreachable` - a model server that hangs
   * instead of failing (seen 30.10, the office Qwen). null: no limit.
   */
  constructor({ startClient, journal, now = () => new Date(), models, mcpServers = [],
    requestTimeoutMs = 24 * 60 * 60 * 1000, onDiagnostic = () => {}, recoverOnConnect = true,
    stopGraceMs = STOP_GRACE_MS, silenceTimeoutMs = DEFAULT_SILENCE_MS, silenceCheckMs = 15_000 } = {}) {
    super();
    if (typeof startClient !== "function" || !journal || typeof now !== "function") fail("acp_host_invalid");
    if (!Array.isArray(mcpServers)) fail("acp_host_invalid");
    if (silenceTimeoutMs !== null && (!Number.isSafeInteger(silenceTimeoutMs) || silenceTimeoutMs < 1)) fail("acp_host_invalid");
    this.#startClient = startClient;
    this.#journal = journal;
    this.#now = now;
    this.#models = normalizeAcpModels(models);
    this.#mcpServers = structuredClone(mcpServers);
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#onDiagnostic = onDiagnostic;
    this.#recoverOnConnect = recoverOnConnect !== false;
    this.#stopGraceMs = stopGraceMs;
    this.#silenceTimeoutMs = silenceTimeoutMs;
    this.#silenceCheckMs = silenceCheckMs;
  }

  get models() { return structuredClone(this.#models); }

  /** ACP agents ask before acting by their own rules; the desk has no modes to give them. */
  get permissionMode() { return "default"; }

  /** The desk's own tools travel as an MCP server the agent is given, not as in-process tools. */
  get supportsDeskTools() { return false; }

  /** What the agent said it is (initialize), once it has been started. */
  get agentInfo() { return this.#agentInfo === null ? null : structuredClone(this.#agentInfo); }

  #at() { return this.#now().toISOString(); }

  #diagnostic(record) {
    try { this.#onDiagnostic({ component: "acp-session-host", atUtc: this.#at(), ...record }); }
    catch { /* Diagnostics never change a turn. */ }
  }

  // --- connection ---------------------------------------------------------------------

  async connect() {
    if (this.#closed) fail("provider_disconnected");
    if (this.#recoverOnConnect) await this.#journal.recover(this.#at());
    await this.#ensureClient();
  }

  /** The running agent process, started (and initialized) when there is none. */
  async #ensureClient() {
    if (this.#closed) fail("provider_disconnected");
    if (this.#client?.running) return this.#client;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      const client = await this.#startClient();
      const generation = ++this.#generation;
      // Updates are taken one after another, in the order the agent sent them.
      client.on("notification", (method, params) => {
        if (method !== "session/update") return;
        this.#updates = this.#updates.then(() => this.#update(params)).catch((error) => this.#diagnostic({
          phase: "update", reasonCode: error?.code ?? "acp_update_failed", message: clip(error?.message ?? "", 200) }));
      });
      client.on("exit", () => this.#lost(generation));
      client.onRequest("session/request_permission", (params) => this.#permission(params));
      try {
        const answer = await client.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "agents-factory-gateway", version: ACP_SESSION_HOST_VERSION },
        }, { timeoutMs: SETUP_TIMEOUT_MS });
        if (answer?.protocolVersion !== ACP_PROTOCOL_VERSION) fail("acp_protocol_unsupported");
        if (!answer?.agentCapabilities?.sessionCapabilities?.resume) fail("acp_resume_unsupported");
        this.#agentInfo = { name: clip(String(answer.agentInfo?.name ?? "acp-agent"), 128),
          version: clip(String(answer.agentInfo?.version ?? ""), 64) };
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      this.#loaded.clear();
      this.#configured.clear();
      this.#client = client;
      return client;
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  /** The agent process ended: what it held is gone, and turns that ran in it are over. */
  #lost(generation) {
    if (generation !== this.#generation) return;
    this.#loaded.clear();
    this.#configured.clear();
    for (const run of this.#running.values()) run.lost();
    if (!this.#closed) this.#diagnostic({ phase: "connection", reasonCode: "acp_process_exited" });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const runs = [...this.#running.values()];
    await Promise.all(runs.map((run) => run.stop()));
    await Promise.all(runs.map((run) => run.finished.catch(() => undefined)));
    await this.#client?.close().catch(() => undefined);
    this.emit("close");
  }

  registerServerRequestHandler(method, handler) {
    if (typeof method !== "string" || typeof handler !== "function") fail("invalid_request");
    if (this.#handlers.has(method)) fail("conflict", `A handler for ${method} is already registered`);
    this.#handlers.set(method, handler);
    return () => { if (this.#handlers.get(method) === handler) this.#handlers.delete(method); };
  }

  // --- reads --------------------------------------------------------------------------

  /** ACP agents have no account of the person's; one that runs counts as signed in. */
  async readAccount() {
    const running = this.#client?.running === true;
    return { requiresOpenaiAuth: false,
      account: running ? { type: ACP_PROVIDER_ID, authMethod: null, subscriptionType: null } : null };
  }

  async listModels() {
    return { data: this.#models.map((model) => ({ id: model.id, displayName: model.displayName,
      supportedReasoningEfforts: model.efforts, defaultReasoningEffort: model.defaultEffort })), nextCursor: null };
  }

  async listThreads(options = {}) {
    const sessions = await this.#journal.list();
    const page = pageOf(sessions, options);
    return { data: page.data.map((session) => threadView(session, this.#running.has(session.sessionId))),
      nextCursor: page.nextCursor };
  }

  async readThread(threadId, includeTurns = false) {
    const session = await this.#journal.readSession(claudeSessionId(threadId));
    if (session === null) return null;
    const turns = includeTurns === true ? await this.#journal.readTurns(threadId) : null;
    return { thread: threadView(session, this.#running.has(threadId), turns) };
  }

  async listThreadTurns(threadId, options = {}) {
    const session = await this.#journal.readSession(claudeSessionId(threadId));
    if (session === null) fail("thread_not_found");
    const ids = options.sortDirection === "desc" ? [...session.turnIds].reverse() : session.turnIds;
    const page = pageOf(ids, options);
    const turns = [];
    for (const id of page.data) {
      const turn = await this.#journal.readTurn(threadId, id);
      if (turn === null) fail("concurrent_update");
      turns.push(turnView(turn));
    }
    return { data: turns, nextCursor: page.nextCursor };
  }

  /** The context the session fills now (ACP reports occupancy, not spent tokens). */
  async readThreadUsage(threadId) {
    const session = await this.#journal.readSession(claudeSessionId(threadId));
    if (session === null) fail("thread_not_found");
    const usage = session.usage;
    if (usage === null || !(usage.contextWindow > 0)) return { threadUsage: null };
    return { threadUsage: { groups: [{ inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }], modelContextWindow: usage.contextWindow } };
  }

  async readSessionMeta(threadId) {
    return this.#journal.readSession(claudeSessionId(threadId));
  }

  async readTurn(threadId, turnId) {
    return this.#journal.readTurn(claudeSessionId(threadId), turnId);
  }

  // --- writes -------------------------------------------------------------------------

  /** A new session: the agent starts it at once and names it. */
  async createSession({ cwd }) {
    const client = await this.#ensureClient();
    const answer = await client.request("session/new", { cwd, mcpServers: structuredClone(this.#mcpServers) },
      { timeoutMs: SETUP_TIMEOUT_MS });
    const sessionId = claudeSessionId(answer?.sessionId);
    const atUtc = this.#at();
    await this.#journal.create({ sessionId, cwd, atUtc });
    await this.#journal.updateSession(sessionId, (session) => { session.providerStarted = true; });
    this.#loaded.add(sessionId);
    this.#configured.set(sessionId, { model: optionValue(answer.configOptions, "model"),
      effort: optionValue(answer.configOptions, "reasoning_effort") });
    return sessionId;
  }

  /**
   * Starts one turn and returns once it is recorded. `options`: model, effort,
   * the client's message id, the text the person typed (`displayText`), and
   * `policy({ tool, input, cwd })` -> "allow" | "deny" | "ask": what the desk
   * decides itself when the agent asks before a tool call (write zones, A2b);
   * without it every question goes to the person.
   */
  async startTurn(threadId, input, options = {}) {
    if (this.#closed) fail("provider_disconnected");
    claudeSessionId(threadId);
    const text = textOf(input);
    const model = options.model ?? null;
    const entry = model === null ? null : this.#models.find((item) => item.id === model);
    if (model !== null && !entry) fail("memory_profile_conflict");
    const effort = options.effort ?? "default";
    if (effort !== "default" && !(entry ?? this.#models[0]).efforts.includes(effort)) fail("memory_profile_conflict");
    if (this.#running.has(threadId)) fail("acp_session_busy");
    const turnId = randomUUID();
    const startedAt = this.#at();
    const displayText = typeof options.displayText === "string" && options.displayText.trim() !== ""
      ? clip(options.displayText, CLAUDE_CODE_SESSION_LIMITS.textBytes) : null;
    const userItem = { id: `${turnId}:user`, type: "userMessage", content: [{ type: "text", text }],
      ...(displayText === null ? {} : { displayText }),
      clientId: typeof options.clientUserMessageId === "string" ? options.clientUserMessageId : null, atUtc: startedAt };
    const run = this.#claim(threadId, turnId, options.policy);
    // A task's planning turn (agent-tasks.mjs): nothing but reading is allowed in it.
    run.planning = options.planning === true;
    let session;
    try {
      session = await this.#journal.appendTurn(threadId, { id: turnId, status: "inProgress", startedAt,
        completedAt: null, clientUserMessageId: userItem.clientId, requestedModel: model, requestedEffort: effort,
        observedModel: null, modelsUsed: [], resultSubtype: null, costUsd: null, recovery: null,
        failure: null, items: [userItem] }, startedAt);
    } catch (error) {
      this.#running.delete(threadId);
      throw error;
    }
    this.emit("turn/started", { threadId, turnId,
      turn: { id: turnId, status: "inProgress", startedAt, items: [structuredClone(userItem)] } });
    await this.#trace(run, { type: "turn_started", model, effort, clientId: userItem.clientId,
      displayText, text: clip(text, TRACE_LIMITS.textBytes) });
    run.begin(session, text, { entry, effort });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  /**
   * A message for a running turn. ACP cannot hand it over mid-prompt, so both
   * modes hold it until the agent's current prompt ends and then send it as the
   * next prompt of the same turn; until then it can be taken back.
   */
  async steerTurn(threadId, turnId, input, { mode = "steer", clientUserMessageId = null, displayText = null } = {}) {
    if (this.#closed) fail("provider_disconnected");
    if (mode !== "steer" && mode !== "queue") fail("invalid_request", "mode");
    const run = this.#running.get(claudeSessionId(threadId));
    const clientId = typeof clientUserMessageId === "string" ? clientUserMessageId : null;
    if (run && run.turnId === turnId && clientId !== null
        && (run.held.some((held) => held.clientId === clientId) || run.delivered.has(clientId))) {
      return { delivery: "queued", clientId };
    }
    if (run && run.turnId === turnId && !run.accepting) {
      await run.finished;
      fail("turn_not_active");
    }
    if (!run || run.turnId !== turnId) fail("turn_not_active");
    const text = textOf(input);
    const message = { clientId, text,
      displayText: typeof displayText === "string" && displayText.trim() !== ""
        ? clip(displayText, CLAUDE_CODE_SESSION_LIMITS.textBytes) : null,
      queuedAtUtc: this.#at() };
    run.held.push(message);
    await this.#trace(run, { type: "user_queued", clientId, displayText: message.displayText,
      text: clip(text, TRACE_LIMITS.textBytes) });
    return { delivery: "queued", clientId };
  }

  async cancelQueued(threadId, turnId, clientUserMessageId) {
    const run = this.#running.get(claudeSessionId(threadId));
    if (!run || run.turnId !== turnId) return { cancelled: false };
    const index = run.held.findIndex((held) => held.clientId === clientUserMessageId);
    if (index === -1) return { cancelled: false };
    const [message] = run.held.splice(index, 1);
    await this.#trace(run, { type: "user_cancelled", clientId: message.clientId });
    return { cancelled: true };
  }

  queuedMessages(threadId) {
    const run = this.#running.get(claudeSessionId(threadId));
    if (!run) return [];
    return run.held.map((held) => ({ clientId: held.clientId, displayText: held.displayText ?? held.text,
      queuedAtUtc: held.queuedAtUtc, turnId: run.turnId }));
  }

  async interruptTurn(threadId, turnId) {
    const run = this.#running.get(claudeSessionId(threadId));
    if (!run || run.turnId !== turnId) fail("turn_not_active");
    await run.stop();
    return {};
  }

  // --- one turn -----------------------------------------------------------------------

  #claim(threadId, turnId, policy) {
    const host = this;
    const abortController = new AbortController();
    let finishedResolve;
    const finished = new Promise((resolve) => { finishedResolve = resolve; });
    const run = {
      threadId, turnId, abortController, finished, stopping: false, accepting: true, gone: false,
      policy: typeof policy === "function" ? policy : null,
      held: [], delivered: new Set(), extraInputs: 0, tools: new Map(), toolIds: new Map(), messages: 0,
      // The last sign of life of the agent, and how many of its questions wait for the person now.
      lastSignAt: Date.now(), waitingForPerson: 0, silent: false,
      begin(session, text, options) {
        host.#execute(run, session, text, options).then(finishedResolve, finishedResolve);
      },
      async stop() {
        if (run.stopping) return;
        run.stopping = true;
        host.#client?.notify("session/cancel", { sessionId: threadId });
        // An agent that does not end the prompt is no longer waited for.
        const last = setTimeout(() => abortController.abort(), host.#stopGraceMs);
        last.unref?.();
        finished.finally(() => clearTimeout(last));
      },
      lost() {
        run.gone = true;
        abortController.abort();
      },
    };
    this.#running.set(threadId, run);
    return run;
  }

  /** The session is held by the running agent process, with the turn's model and effort. */
  async #prepare(run, session, { entry, effort }) {
    const client = await this.#ensureClient();
    const { threadId } = run;
    if (!this.#loaded.has(threadId)) {
      const answer = await client.request("session/resume", { sessionId: threadId, cwd: session.cwd,
        mcpServers: structuredClone(this.#mcpServers) }, { timeoutMs: SETUP_TIMEOUT_MS, signal: run.abortController.signal });
      this.#loaded.add(threadId);
      this.#configured.set(threadId, { model: optionValue(answer?.configOptions, "model"),
        effort: optionValue(answer?.configOptions, "reasoning_effort") });
      await this.#trace(run, { type: "session_resumed" });
    }
    const configured = this.#configured.get(threadId) ?? { model: null, effort: null };
    const wanted = [];
    if (entry?.value && configured.model !== entry.value) wanted.push(["model", entry.value]);
    // "default" is the agent's own effort: its empty value in DeepSeek Harness.
    const effortValue = effort === "default" ? null : effort;
    if (effortValue !== null && configured.effort !== effortValue) wanted.push(["reasoning_effort", effortValue]);
    for (const [configId, value] of wanted) {
      const answer = await client.request("session/set_config_option", { sessionId: threadId, configId, value },
        { timeoutMs: SETUP_TIMEOUT_MS, signal: run.abortController.signal });
      this.#configured.set(threadId, { model: optionValue(answer?.configOptions, "model") ?? configured.model,
        effort: optionValue(answer?.configOptions, "reasoning_effort") ?? configured.effort });
    }
    const observed = entry?.id ?? this.#models.find((model) => model.value === this.#configured.get(threadId)?.model)?.id ?? null;
    if (observed !== null) {
      await this.#record(run, (turn) => {
        turn.observedModel = observed;
        if (!turn.modelsUsed.includes(observed)) turn.modelsUsed.push(observed);
      });
    }
    return client;
  }

  /**
   * The silence guard of a turn: when the agent has said nothing for `silenceTimeoutMs` and no question of it
   * waits for the person, the turn is cancelled and ends as `acp_model_unreachable`. Returns the stop.
   */
  #watchSilence(run) {
    if (this.#silenceTimeoutMs === null) return () => {};
    const timer = setInterval(() => {
      if (run.stopping || run.silent || run.waitingForPerson > 0) return;
      if (Date.now() - run.lastSignAt < this.#silenceTimeoutMs) return;
      run.silent = true;
      this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "turn", reasonCode: "acp_turn_silent",
        message: `no sign of the agent for ${Math.round(this.#silenceTimeoutMs / 1000)} s` });
      this.#client?.notify("session/cancel", { sessionId: run.threadId });
      run.abortController.abort();
    }, Math.max(10, Math.min(this.#silenceCheckMs, this.#silenceTimeoutMs)));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #execute(run, session, text, options) {
    const { threadId, turnId } = run;
    let stopReason = null;
    let failure = null;
    const unwatch = this.#watchSilence(run);
    try {
      const client = await this.#prepare(run, session, options);
      let next = text;
      while (next !== null) {
        const answer = await client.request("session/prompt", { sessionId: threadId,
          prompt: [{ type: "text", text: next }] }, { signal: run.abortController.signal });
        // The agent sends a prompt's updates before its answer: they are all taken first.
        await this.#updates;
        stopReason = typeof answer?.stopReason === "string" ? answer.stopReason.slice(0, 32) : "end_turn";
        await this.#trace(run, { type: "prompt_finished", stopReason });
        next = null;
        if (run.stopping || stopReason === "cancelled") break;
        // Messages that waited for the prompt's end go together, as the next prompt.
        const held = run.held.splice(0);
        if (held.length > 0) {
          for (const message of held) await this.#deliver(run, message);
          next = held.map((message) => message.text).join("\n\n");
        }
      }
    } catch (error) {
      // A silent model is unreachable as surely as a refused connection: the same problem for the person.
      failure = run.silent ? "acp_model_unreachable" : run.stopping && !run.gone ? null : run.gone ? "acp_process_exited"
        : MODEL_UNREACHABLE.test(String(error?.message ?? "")) ? "acp_model_unreachable" : "acp_prompt_failed";
      this.#diagnostic({ threadId, turnId, phase: "turn", reasonCode: error?.code ?? "acp_prompt_failed",
        message: clip(error?.message ?? error, 400) });
    } finally {
      run.accepting = false;
      unwatch();
    }
    if (run.silent) await this.#trace(run, { type: "turn_silent", seconds: Math.round(this.#silenceTimeoutMs / 1000) });
    if (run.stopping) {
      for (const held of run.held.splice(0)) {
        await this.#trace(run, { type: "user_cancelled", clientId: held.clientId, reason: "turn_stopped" });
      }
    }
    const status = failure !== null ? "failed"
      : run.stopping || stopReason === "cancelled" ? "interrupted"
        : stopReason === "refusal" ? "failed" : "completed";
    await this.#finish(run, status, stopReason, failure ?? (stopReason === "refusal" ? "acp_refusal" : null));
  }

  async #deliver(run, message) {
    run.extraInputs += 1;
    if (message.clientId !== null) run.delivered.add(message.clientId);
    await this.#addItem(run, { id: `${run.turnId}:user:${run.extraInputs}`, type: "userMessage",
      content: [{ type: "text", text: message.text }],
      ...(message.displayText === null ? {} : { displayText: message.displayText }),
      clientId: message.clientId, delivery: "queue" }, true);
    await this.#trace(run, { type: "user_input", delivery: "queue", clientId: message.clientId,
      displayText: message.displayText, text: clip(message.text, TRACE_LIMITS.textBytes) });
  }

  async #record(run, change) {
    await this.#journal.updateTurn(run.threadId, run.turnId, change, this.#at());
  }

  async #trace(run, record) {
    if (typeof this.#journal.appendTrace !== "function") return;
    try {
      await this.#journal.appendTrace(run.threadId, { atUtc: this.#at(), turnId: run.turnId, ...record });
    } catch (error) {
      this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "trace",
        reasonCode: error?.code ?? "acp_trace_unavailable" });
    }
  }

  async readTrace(threadId, options = {}) {
    if (typeof this.#journal.readTrace !== "function") fail("acp_trace_unavailable");
    if (await this.#journal.readSession(claudeSessionId(threadId)) === null) fail("thread_not_found");
    return this.#journal.readTrace(threadId, options);
  }

  async #addItem(run, item, completed) {
    // When the item was written: the conversation shows it, not the time it was read.
    if (typeof item.atUtc !== "string") item.atUtc = this.#at();
    await this.#record(run, (turn) => {
      if (turn.items.length >= CLAUDE_CODE_SESSION_LIMITS.itemsPerTurn) { turn.truncatedItems = true; return; }
      turn.items.push(structuredClone(item));
    });
    const event = { threadId: run.threadId, turnId: run.turnId, item: structuredClone(item) };
    this.emit("item/started", event);
    if (completed) this.emit("item/completed", structuredClone(event));
  }

  async #completeItem(run, itemId, change) {
    let completed = null;
    await this.#record(run, (turn) => {
      const item = turn.items.find((entry) => entry.id === itemId);
      if (!item) return;
      change(item);
      completed = structuredClone(item);
    });
    if (completed !== null) this.emit("item/completed", { threadId: run.threadId, turnId: run.turnId, item: completed });
  }

  /** The item id of one of the agent's tool calls: its own id when the chat can carry it. */
  #toolId(run, toolCallId) {
    if (run.toolIds.has(toolCallId)) return run.toolIds.get(toolCallId);
    const id = ID.test(toolCallId) ? toolCallId : `${run.turnId}:tool:${run.toolIds.size + 1}`;
    run.toolIds.set(toolCallId, id);
    return id;
  }

  /** One `session/update` of a session with a running turn. */
  async #update(params) {
    const sessionId = params?.sessionId;
    const update = params?.update;
    const run = typeof sessionId === "string" ? this.#running.get(sessionId) : undefined;
    if (!run || run.gone || !update || typeof update.sessionUpdate !== "string") return;
    run.lastSignAt = Date.now();
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const said = contentText(update.content);
      if (!said.trim()) return;
      run.messages += 1;
      const base = typeof update.messageId === "string" && ID.test(update.messageId) ? update.messageId : run.turnId;
      const id = `${base}:${run.messages}`;
      if (kind === "agent_message_chunk") {
        await this.#addItem(run, { id, type: "agentMessage", text: clip(said.trim(), CLAUDE_CODE_SESSION_LIMITS.textBytes) }, true);
        await this.#trace(run, { type: "assistant", text: clip(said, TRACE_LIMITS.textBytes) });
      } else {
        await this.#addItem(run, { id, type: "reasoning", summary: clip(said.trim(), 8192) }, true);
        await this.#trace(run, { type: "thinking", text: clip(said, TRACE_LIMITS.textBytes) });
      }
      return;
    }
    if (kind === "tool_call" && typeof update.toolCallId === "string") {
      const name = typeof update.title === "string" && update.title ? update.title.slice(0, 256) : "tool";
      const input = inputOf(update.rawInput);
      const item = toolItem(this.#toolId(run, update.toolCallId), name, input);
      run.tools.set(update.toolCallId, { itemId: item.id, name, input });
      await this.#trace(run, { type: "tool_use", toolUseId: item.id, tool: name,
        input: clip(JSON.stringify(update.rawInput ?? {}), TRACE_LIMITS.inputBytes) });
      await this.#addItem(run, item, false);
      return;
    }
    if (kind === "tool_call_update" && typeof update.toolCallId === "string") {
      const tool = run.tools.get(update.toolCallId);
      if (!tool || (update.status !== "completed" && update.status !== "failed")) return;
      run.tools.delete(update.toolCallId);
      const failed = update.status === "failed";
      const output = contentText(update.content ?? []);
      await this.#completeItem(run, tool.itemId, (item) => {
        item.status = failed ? "failed" : "completed";
        if (item.type === "commandExecution") item.aggregatedOutput = clip(output, CLAUDE_CODE_SESSION_LIMITS.outputBytes);
        else item.output = clip(output, CLAUDE_CODE_SESSION_LIMITS.outputBytes);
      });
      await this.#trace(run, { type: "tool_result", toolUseId: tool.itemId, isError: failed,
        output: clip(output, TRACE_LIMITS.outputBytes) });
      return;
    }
    if (kind === "usage_update" && Number.isSafeInteger(update.used) && Number.isSafeInteger(update.size)) {
      await this.#journal.updateSession(run.threadId, (session) => {
        session.usage = { inputTokens: update.used, cachedInputTokens: 0, outputTokens: 0, totalTokens: update.used,
          contextWindow: update.size, costUsd: 0 };
      });
      return;
    }
    if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
      this.#configured.set(run.threadId, { model: optionValue(update.configOptions, "model"),
        effort: optionValue(update.configOptions, "reasoning_effort") });
    }
  }

  async #finish(run, status, stopReason, failure) {
    try {
      await this.#record(run, (turn) => {
        for (const item of turn.items) if (item.status === "inProgress") item.status = status;
        Object.assign(turn, { status, completedAt: this.#at(), failure, resultSubtype: stopReason });
      });
    } catch (error) {
      this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "finish",
        reasonCode: error?.code ?? "acp_journal_unavailable" });
    }
    await this.#trace(run, { type: "turn_finished", status, failure, resultSubtype: stopReason });
    this.#running.delete(run.threadId);
    this.emit("turn/completed", { threadId: run.threadId, turnId: run.turnId,
      turn: { id: run.turnId, status, items: [] } });
  }

  // --- the person's decisions ----------------------------------------------------------

  #request(run, session, tool) {
    const base = { threadId: run.threadId, turnId: run.turnId, itemId: tool.itemId };
    if (ACP_SHELL_TOOLS.has(tool.name)) {
      return { method: "item/commandExecution/requestApproval", params: { ...base,
        command: clip(tool.input.command ?? "", 8192), cwd: session.cwd,
        reason: text(tool.input.description, 4096), availableDecisions: ["accept", "cancel", "decline"] } };
    }
    if (ACP_FILE_TOOLS.has(tool.name)) {
      const target = tool.input[ACP_FILE_TOOLS.get(tool.name)];
      return { method: "item/fileChange/requestApproval", params: { ...base,
        reason: clip(`${tool.name} ${typeof target === "string" ? target : ""}`.trim(), 4096), grantRoot: null } };
    }
    return { method: "item/permissions/requestApproval", params: { ...base, cwd: session.cwd,
      reason: clip(tool.name, 256),
      permissions: { tool: clip(tool.name, 256), input: clip(JSON.stringify(tool.input), 4096) } } };
  }

  /** The agent asks before a tool call: the desk's policy decides, else the person. */
  async #permission(params) {
    const reject = { outcome: { outcome: "selected", optionId: "reject-once" } };
    const allow = { outcome: { outcome: "selected", optionId: "allow-once" } };
    // The tool call it asks about came as an update before the question.
    await this.#updates;
    const run = this.#running.get(params?.sessionId);
    const toolCallId = params?.toolCall?.toolCallId;
    const tool = run && typeof toolCallId === "string" ? run.tools.get(toolCallId) : undefined;
    const offered = new Set((params?.options ?? []).map((option) => option?.optionId));
    if (!run || !tool || !offered.has("allow-once") || !offered.has("reject-once")) {
      this.#diagnostic({ phase: "interaction", reasonCode: "acp_permission_unknown_call" });
      return reject;
    }
    const session = await this.#journal.readSession(run.threadId);
    // Every decision goes to the trace (`permission`): a refused action is the
    // person's attention in the desk, whoever refused it.
    const decided = (decision, by) => this.#trace(run, { type: "permission", toolUseId: tool.itemId, tool: tool.name,
      decision, by });
    // Secrets first, whatever the desk policy (none configured included); any other read is never asked about.
    if (secretToolReason({ tool: tool.name, input: tool.input, root: session.cwd, fields: ACP_PATH_FIELDS,
      shells: ACP_SHELLS }) !== null) {
      await decided("deny", "desk");
      return reject;
    }
    if (ACP_READ_TOOLS.has(tool.name) || (tool.name === "str_replace_editor" && tool.input?.command === "view")) return allow;
    if (run.planning === true) {
      await decided("deny", "desk");
      return reject;
    }
    let verdict = "ask";
    if (run.policy !== null) {
      try { verdict = await run.policy({ tool: tool.name, input: structuredClone(tool.input), cwd: session.cwd }); }
      catch { verdict = "deny"; }
    }
    if (verdict === "allow" || verdict === "deny") {
      await decided(verdict, "desk");
      return verdict === "allow" ? allow : reject;
    }
    const { method, params: request } = this.#request(run, session, tool);
    const handler = this.#handlers.get(method);
    if (!handler) { await decided("deny", "nobody"); return reject; }
    const requestId = `${run.turnId}:${tool.itemId}`;
    const deadlineAtUtc = new Date(this.#now().getTime() + this.#requestTimeoutMs).toISOString();
    let payload;
    // The agent waits for the person now, not the other way round: the silence guard does not count it.
    run.waitingForPerson += 1;
    try {
      payload = await handler(request, { requestId, method, generation: this.#generation, deadlineAtUtc,
        signal: run.abortController.signal });
    } catch (error) {
      this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "interaction",
        reasonCode: error?.code ?? "interaction_failed" });
      await decided("deny", "nobody");
      return reject;
    } finally {
      run.waitingForPerson -= 1;
      run.lastSignAt = Date.now();
    }
    this.emit("serverRequestState", { requestId, generation: this.#generation, method,
      providerResolvedAtUtc: this.#at() });
    if (method === "item/permissions/requestApproval") {
      const granted = payload?.permissions && Object.keys(payload.permissions).length > 0;
      await decided(granted ? "allow" : "deny", "person");
      return granted ? allow : reject;
    }
    if (payload?.decision === "accept") { await decided("allow", "person"); return allow; }
    if (payload?.decision === "cancel") {
      await decided("cancel", "person");
      run.stop().catch(() => undefined);
      return { outcome: { outcome: "cancelled" } };
    }
    await decided("deny", "person");
    return reject;
  }
}

export function acpTurnState(turn) {
  if (turn === null) return "unknown";
  if (turn.status === "inProgress") return "started";
  return TERMINAL.has(turn.status) ? turn.status : "unknown";
}

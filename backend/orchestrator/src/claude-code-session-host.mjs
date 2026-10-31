import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { ADAPTER_CONTRACT_VERSION, validateAdapterDescriptor } from "./adapter-contracts.mjs";
import {
  conversationReadCapabilityExtension,
  isProviderConversationReadOperation,
} from "./provider-conversation-read-contract.mjs";
import { CLAUDE_AGENT_TOOLS, CLAUDE_EFFORTS, claudeDeskToolName } from "./claude-code-sdk.mjs";
import { FILE_TOOLS, SHELL_TOOLS } from "./agent-write-zone.mjs";
import { CLAUDE_CODE_SESSION_LIMITS, claudeSessionId, clipText } from "./claude-code-session-journal.mjs";

// Claude Code sessions, driven through the Agent SDK, presented to the rest of
// the backend in the shape of the Codex App Server client it already uses:
// threads, turns and items; `turn/started`, `item/started`, `item/completed`
// and `turn/completed` notifications; and server requests for the person's
// decisions. The interaction bridge, the conversation read adapter, the
// conversation archive and the agent event stream therefore work unchanged.
//
// A thread is one Claude Code session; its id is the session id. A turn is one
// SDK query that resumes the session, takes one message and ends with the
// turn (measured 2026-09-30: a resumed process reads the earlier conversation
// from the prompt cache exactly as a long-lived one). The same fixed options
// go with every turn: Claude Code does not restore them on resume.

export const CLAUDE_CODE_SESSION_HOST_VERSION = "v0.5.0";
/** The SDK's permission modes a turn may run in (the agent's own, else the provider's). */
export const CLAUDE_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto", "bypassPermissions",
  "plan", "dontAsk"]);
export const CLAUDE_CODE_ADAPTER_ID = "claude-code-sdk";
export const CLAUDE_CODE_ADAPTER_VERSION = "v0.1.0";
export const CLAUDE_CODE_PROVIDER_ID = "claude";

// What one trace record may hold (the whole record stays under the journal's
// CLAUDE_CODE_TRACE_LIMITS.recordBytes).
const TRACE_LIMITS = Object.freeze({ textBytes: 128 * 1024, inputBytes: 64 * 1024, outputBytes: 64 * 1024,
  diffBytes: 96 * 1024 });

const QUESTION_TOOL = "AskUserQuestion";
const PLAN_TOOL = "TodoWrite";
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const ACCOUNT_TTL_MS = 60_000;
const STOP_GRACE_MS = 10_000;
// Claude Code lost its sign-in (the OAuth session expired and could not be refreshed, or there is
// none): the person signs in again, so the turn says it (`claude_signed_out`).
const SIGNED_OUT = /Failed to authenticate|OAuth (?:session|token)[^\n]{0,40}(?:expired|revoked|invalid)|not logged in|Please run \/login|authentication_error|invalid_grant/iu;
// How long a result waits for Claude Code's "idle" before the turn is taken as over.
const IDLE_GRACE_MS = 15_000;
// The plan usage is read from a running turn at most this often, and given this long to answer.
const USAGE_INTERVAL_MS = 60_000;
const USAGE_TIMEOUT_MS = 10_000;

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

/** The read-side adapter descriptor of the Claude Code provider runtime. */
export function createClaudeCodeProviderDescriptor({ sourceId, runtimeInstanceId, observedAtUtc }) {
  const identity = { adapterId: CLAUDE_CODE_ADAPTER_ID, adapterFamily: "execution-provider",
    adapterVersion: CLAUDE_CODE_ADAPTER_VERSION, sourceId, runtimeInstanceId };
  return validateAdapterDescriptor({
    schemaVersion: 1, contractVersion: ADAPTER_CONTRACT_VERSION, identity,
    authority: { schemaVersion: 1, authorityType: "provider", sourceId,
      externalId: runtimeInstanceId, contractVersion: CLAUDE_CODE_ADAPTER_VERSION },
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

/** Models offered to desk agents, from the machine-local config. */
export function normalizeClaudeModels(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 32) fail("claude_models_invalid");
  return models.map((model) => {
    if (!model || typeof model !== "object" || typeof model.id !== "string" || !ID.test(model.id)) {
      fail("claude_models_invalid");
    }
    const efforts = model.efforts ?? ["default", ...CLAUDE_EFFORTS];
    if (!Array.isArray(efforts) || efforts.length < 1
        || efforts.some((effort) => effort !== "default" && !CLAUDE_EFFORTS.includes(effort))) {
      fail("claude_models_invalid");
    }
    const defaultEffort = model.defaultEffort ?? efforts[0];
    if (!efforts.includes(defaultEffort)) fail("claude_models_invalid");
    return { id: model.id, displayName: typeof model.displayName === "string" ? model.displayName.slice(0, 256) : model.id,
      efforts: [...new Set(efforts)], defaultEffort };
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

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text
    : part?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

function planText(todos) {
  if (!Array.isArray(todos)) return null;
  const marks = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };
  const lines = todos.slice(0, 64).map((todo) => {
    const mark = marks[todo?.status] ?? "[ ]";
    const said = todo?.status === "in_progress" && typeof todo?.activeForm === "string" ? todo.activeForm : todo?.content;
    return `${mark} ${String(said ?? "").trim()}`;
  }).filter((line) => line.length > 4);
  return lines.length ? lines.join("\n") : null;
}

const lineCount = (text) => (typeof text === "string" && text !== "" ? text.split(/\r?\n/u).length : 0);
const text = (value, maximumBytes) => (typeof value === "string" && value !== "" ? clip(value, maximumBytes) : null);

/**
 * How many lines a file tool adds and removes, from its input: what Claude
 * Code shows as "+3 −1". The result's patch, when it comes, replaces the
 * estimate (changeStatsOf). Write and NotebookEdit say only what they write.
 */
function inputChangeStats(name, input) {
  if (name === "Edit") return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.slice(0, 256).reduce((sum, edit) => ({
      added: sum.added + lineCount(edit?.new_string), removed: sum.removed + lineCount(edit?.old_string),
    }), { added: 0, removed: 0 });
  }
  if (name === "Write") return { added: lineCount(input.content), removed: null };
  if (name === "NotebookEdit") return { added: lineCount(input.new_source), removed: null };
  return { added: null, removed: null };
}

/**
 * The short account of what a reading or searching tool was asked: the file,
 * the pattern, the address. Claude Code shows the same in its transcript.
 */
function toolDetail(name, input) {
  if (name === "Read") {
    const from = Number.isSafeInteger(input.offset) ? input.offset : null;
    const span = Number.isSafeInteger(input.limit) ? input.limit : null;
    const range = from !== null && span !== null ? ` (lines ${from}–${from + span - 1})`
      : from !== null ? ` (from line ${from})` : "";
    return text(input.file_path, 1024) === null ? null : `${clip(input.file_path, 1024)}${range}`;
  }
  if (name === "Grep") {
    const where = [text(input.path, 512), text(input.glob, 256)].filter(Boolean).join(" · ");
    return text(input.pattern, 512) === null ? null : `"${clip(input.pattern, 512)}"${where ? ` in ${where}` : ""}`;
  }
  if (name === "Glob") {
    return text(input.pattern, 512) === null ? null
      : `${clip(input.pattern, 512)}${text(input.path, 512) ? ` in ${clip(input.path, 512)}` : ""}`;
  }
  if (name === "WebFetch") return text(input.url, 1024);
  if (name === "WebSearch") return text(input.query, 512) === null ? null : `"${clip(input.query, 512)}"`;
  const keys = Object.keys(input);
  return keys.length === 0 ? null : clip(JSON.stringify(input), 512);
}

/** The chat item a tool call becomes, in the item shapes of the Codex client. */
function toolItem(part) {
  const input = part.input && typeof part.input === "object" ? part.input : {};
  if (SHELL_TOOLS.has(part.name)) {
    return { id: part.id, type: "commandExecution", tool: part.name,
      command: clip(input.command ?? "", 8192), description: text(input.description, 512),
      aggregatedOutput: null, exitCode: null, status: "inProgress" };
  }
  if (FILE_TOOLS.has(part.name)) {
    const target = input[FILE_TOOLS.get(part.name)];
    const { added, removed } = inputChangeStats(part.name, input);
    return { id: part.id, type: "fileChange", tool: part.name,
      changes: typeof target === "string"
        ? [{ path: clip(target, 1024), kind: part.name === "Write" ? "write" : "update", added, removed }] : [],
      status: "inProgress" };
  }
  if (part.name === PLAN_TOOL) {
    const plan = planText(input.todos);
    if (plan !== null) return { id: part.id, type: "plan", tool: part.name, text: clip(plan, 8192), status: "inProgress" };
  }
  return { id: part.id, type: "mcpToolCall", tool: clip(part.name, 256), detail: toolDetail(part.name, input),
    status: "inProgress" };
}

/**
 * The agent's questions to the person (AskUserQuestion) as the chat keeps them:
 * what was asked and, once the person answered, the answers in the same order.
 * Claude Code keeps the same in its transcript.
 */
function questionItem(part) {
  const asked = Array.isArray(part.input?.questions) ? part.input.questions.slice(0, 16) : [];
  return { id: part.id, type: "userQuestion", tool: QUESTION_TOOL,
    questions: asked.map((question, index) => ({ header: text(question?.header, 256),
      question: clip(question?.question || "", 4096) || `Question ${index + 1}` })),
    answers: null, status: "inProgress" };
}

/**
 * Exact line counts and the unified diff of a file tool's result, from the
 * structured patch Claude Code returns with it (`tool_use_result`). The counts
 * go to the chat; the diff goes only to the trace.
 */
function patchOf(toolUseResult) {
  const hunks = Array.isArray(toolUseResult?.structuredPatch) ? toolUseResult.structuredPatch : null;
  if (hunks === null) {
    if (toolUseResult?.type === "create" && typeof toolUseResult.content === "string") {
      return { added: lineCount(toolUseResult.content), removed: 0, diff: null };
    }
    return null;
  }
  let added = 0;
  let removed = 0;
  const lines = [];
  for (const hunk of hunks.slice(0, 512)) {
    if (!Array.isArray(hunk?.lines)) continue;
    lines.push(`@@ -${hunk.oldStart ?? "?"},${hunk.oldLines ?? "?"} +${hunk.newStart ?? "?"},${hunk.newLines ?? "?"} @@`);
    for (const line of hunk.lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
      lines.push(line);
    }
  }
  return { added, removed, diff: lines.length > 0 ? lines.join("\n") : null };
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

export class ClaudeCodeSessionHost extends EventEmitter {
  #sdk;
  #journal;
  #now;
  #env;
  #models;
  #settingSources;
  #permissionMode;
  #tools;
  #readAccount;
  #requestTimeoutMs;
  #onDiagnostic;
  #zod;
  #recoverOnConnect;
  #idleGraceMs;
  #onUsage;
  #usageIntervalMs;
  #usageReadAtMs = 0;
  #usageReading = false;
  #handlers = new Map();
  #running = new Map();
  #account = null;
  #accountAtMs = 0;
  #generation = 1;
  #closed = false;

  constructor({ sdk, journal, now = () => new Date(), env = null, models,
    settingSources = ["project", "local"], permissionMode = "acceptEdits", tools = CLAUDE_AGENT_TOOLS,
    readAccount, requestTimeoutMs = 24 * 60 * 60 * 1000, onDiagnostic = () => {}, zod = null,
    recoverOnConnect = true, idleGraceMs = IDLE_GRACE_MS, onUsage = null,
    usageIntervalMs = USAGE_INTERVAL_MS } = {}) {
    super();
    if (typeof sdk?.query !== "function" || !journal || typeof readAccount !== "function"
        || typeof now !== "function") fail("claude_host_invalid");
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) fail("claude_host_invalid");
    this.#sdk = sdk;
    this.#journal = journal;
    this.#now = now;
    this.#env = env;
    this.#models = normalizeClaudeModels(models);
    this.#settingSources = [...settingSources];
    this.#permissionMode = permissionMode;
    this.#tools = [...tools];
    this.#readAccount = readAccount;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#onDiagnostic = onDiagnostic;
    this.#zod = zod;
    this.#recoverOnConnect = recoverOnConnect !== false;
    this.#idleGraceMs = idleGraceMs;
    this.#onUsage = typeof onUsage === "function" ? onUsage : null;
    this.#usageIntervalMs = usageIntervalMs;
  }

  get models() { return structuredClone(this.#models); }

  /** The provider's permission mode: a turn without its own (`options.permissionMode`) runs in it. */
  get permissionMode() { return this.#permissionMode; }

  /** Whether turns can carry the desk's own tool (an in-process MCP server of the SDK). */
  get supportsDeskTools() {
    return this.#zod !== null && typeof this.#sdk.createSdkMcpServer === "function" && typeof this.#sdk.tool === "function";
  }

/**
   * The desk's tools as one in-process MCP server: `deskTools` is a list of
   * { name, description, inputSchema(zod) -> shape, handler(args) -> text }.
   */
  #deskServer(deskTools) {
    const zod = this.#zod;
    return this.#sdk.createSdkMcpServer({
      name: "desk", version: "1.0.0",
      tools: deskTools.map((tool) => this.#sdk.tool(tool.name, tool.description, tool.inputSchema(zod),
        async (args) => ({ content: [{ type: "text", text: String(await tool.handler(args ?? {})) }] }))),
    });
  }

  #at() { return this.#now().toISOString(); }

  #diagnostic(record) {
    try { this.#onDiagnostic({ component: "claude-code-session-host", atUtc: this.#at(), ...record }); }
    catch { /* Diagnostics never change a turn. */ }
  }

  // --- connection ---------------------------------------------------------------------

  async connect() {
    if (this.#closed) fail("provider_disconnected");
    // A journal that other processes write at the same time (one-off service
    // turns) is not recovered: their running turns are not this host's.
    if (this.#recoverOnConnect) await this.#journal.recover(this.#at());
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const runs = [...this.#running.values()];
    await Promise.all(runs.map((run) => run.stop()));
    await Promise.all(runs.map((run) => run.finished.catch(() => undefined)));
    this.emit("close");
  }

  registerServerRequestHandler(method, handler) {
    if (typeof method !== "string" || typeof handler !== "function") fail("invalid_request");
    if (this.#handlers.has(method)) fail("conflict", `A handler for ${method} is already registered`);
    this.#handlers.set(method, handler);
    return () => { if (this.#handlers.get(method) === handler) this.#handlers.delete(method); };
  }

  // --- reads --------------------------------------------------------------------------

  async readAccount() {
    const nowMs = this.#now().getTime();
    if (this.#account === null || nowMs - this.#accountAtMs > ACCOUNT_TTL_MS) {
      this.#account = await this.#readAccount();
      this.#accountAtMs = nowMs;
    }
    const account = this.#account;
    return {
      requiresOpenaiAuth: account?.state === "signed-out",
      account: account?.state === "signed-in"
        ? { type: "claude", authMethod: account.authMethod ?? null, subscriptionType: account.subscriptionType ?? null }
        : null,
    };
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

  async readThreadUsage(threadId) {
    const session = await this.#journal.readSession(claudeSessionId(threadId));
    if (session === null) fail("thread_not_found");
    const usage = session.usage;
    if (usage === null || !(usage.contextWindow > 0)) return { threadUsage: null };
    return { threadUsage: { groups: [{ inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }], modelContextWindow: usage.contextWindow } };
  }

  /** A session's metadata (no turns): its start, usage and how often Claude Code compacted it. */
  async readSessionMeta(threadId) {
    return this.#journal.readSession(claudeSessionId(threadId));
  }

  /** The state of one turn as the host knows it; null when the turn is unknown. */
  async readTurn(threadId, turnId) {
    return this.#journal.readTurn(claudeSessionId(threadId), turnId);
  }

  // --- writes -------------------------------------------------------------------------

  /** A new session: nothing runs until the first turn, which starts it under this id. */
  async createSession({ cwd }) {
    if (this.#closed) fail("provider_disconnected");
    const sessionId = randomUUID();
    await this.#journal.create({ sessionId, cwd, atUtc: this.#at() });
    return sessionId;
  }

  /**
   * Starts one turn and returns once it is recorded and its process started.
   * `options`: model, effort ("default" leaves Claude Code's own), the
   * client's message id, and per-agent query additions (hooks, MCP servers,
   * allowed tools, a system note) that stage 2 supplies.
   */
  async startTurn(threadId, input, options = {}) {
    if (this.#closed) fail("provider_disconnected");
    claudeSessionId(threadId);
    const text = textOf(input);
    const model = options.model ?? null;
    if (model !== null && !this.#models.some((entry) => entry.id === model)) fail("memory_profile_conflict");
    const effort = options.effort ?? "default";
    if (effort !== "default" && !CLAUDE_EFFORTS.includes(effort)) fail("memory_profile_conflict");
    const permissionMode = options.permissionMode ?? this.#permissionMode;
    if (!CLAUDE_PERMISSION_MODES.includes(permissionMode)) fail("invalid_request", "permissionMode");
    if (this.#running.has(threadId)) fail("claude_session_busy");
    const turnId = randomUUID();
    const startedAt = this.#at();
    // `displayText` is what the person typed; `text` what Claude Code is sent
    // (with the memory snapshot and the role in front). The chat shows the
    // first, the trace keeps both.
    const displayText = typeof options.displayText === "string" && options.displayText.trim() !== ""
      ? clip(options.displayText, CLAUDE_CODE_SESSION_LIMITS.textBytes) : null;
    const userItem = { id: `${turnId}:user`, type: "userMessage", content: [{ type: "text", text }],
      ...(displayText === null ? {} : { displayText }),
      clientId: typeof options.clientUserMessageId === "string" ? options.clientUserMessageId : null, atUtc: startedAt };
    // The process is claimed before anything awaits, so a second start of the
    // same session cannot slip in while the turn is being recorded.
    const run = this.#claim(threadId, turnId);
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
    run.begin(session, text, { ...options, model, effort, permissionMode });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  /**
   * A message for a turn that is still running, as in Claude Code and Codex:
   * `mode: "steer"` hands it to Claude Code at once, and Claude Code reads it
   * when its current tool calls finish, within the same turn; `mode: "queue"`
   * holds it here until the turn's work is over, then sends it as the next
   * message - until then it can be taken back (cancelQueued). Refused with
   * `turn_not_active` when the turn is over or ending: the caller then starts a
   * new turn instead.
   */
  async steerTurn(threadId, turnId, input, { mode = "steer", clientUserMessageId = null, displayText = null } = {}) {
    if (this.#closed) fail("provider_disconnected");
    const run = this.#running.get(claudeSessionId(threadId));
    if (mode !== "steer" && mode !== "queue") fail("invalid_request", "mode");
    const clientId = typeof clientUserMessageId === "string" ? clientUserMessageId : null;
    // The same message again (a retried request) is not delivered twice.
    if (run && run.turnId === turnId && clientId !== null) {
      if (run.held.some((held) => held.clientId === clientId)) return { delivery: "queued", clientId };
      if (run.delivered.has(clientId)) return { delivery: "steered", clientId };
    }
    if (run && run.turnId === turnId && !run.accepting) {
      // The turn is ending: its record settles first, so the new message can start the next one.
      await run.finished;
      fail("turn_not_active");
    }
    if (!run || run.turnId !== turnId) fail("turn_not_active");
    const text = textOf(input);
    const message = { clientId, text,
      displayText: typeof displayText === "string" && displayText.trim() !== ""
        ? clip(displayText, CLAUDE_CODE_SESSION_LIMITS.textBytes) : null,
      queuedAtUtc: this.#at() };
    if (mode === "queue") {
      run.held.push(message);
      await this.#trace(run, { type: "user_queued", clientId: message.clientId, displayText: message.displayText,
        text: clip(text, TRACE_LIMITS.textBytes) });
      return { delivery: "queued", clientId: message.clientId };
    }
    await this.#deliver(run, message, "steer");
    return { delivery: "steered", clientId: message.clientId };
  }

  /** Takes back a message held for the end of the turn; false when it was already sent. */
  async cancelQueued(threadId, turnId, clientUserMessageId) {
    const run = this.#running.get(claudeSessionId(threadId));
    if (!run || run.turnId !== turnId) return { cancelled: false };
    const index = run.held.findIndex((held) => held.clientId === clientUserMessageId);
    if (index === -1) return { cancelled: false };
    const [message] = run.held.splice(index, 1);
    await this.#trace(run, { type: "user_cancelled", clientId: message.clientId });
    return { cancelled: true };
  }

  /** Messages still held for the end of a turn: what the chat shows above its input. */
  queuedMessages(threadId) {
    const run = this.#running.get(claudeSessionId(threadId));
    if (!run) return [];
    return run.held.map((held) => ({ clientId: held.clientId, displayText: held.displayText ?? held.text,
      queuedAtUtc: held.queuedAtUtc, turnId: run.turnId }));
  }

  /** Hands one message to the running Claude Code process and records it in the turn. */
  async #deliver(run, message, delivery) {
    run.extraInputs += 1;
    if (message.clientId !== null) run.delivered.add(message.clientId);
    const id = `${run.turnId}:user:${run.extraInputs}`;
    await this.#addItem(run, { id, type: "userMessage", content: [{ type: "text", text: message.text }],
      ...(message.displayText === null ? {} : { displayText: message.displayText }),
      clientId: message.clientId, delivery }, true);
    await this.#trace(run, { type: "user_input", delivery, clientId: message.clientId,
      displayText: message.displayText, text: clip(message.text, TRACE_LIMITS.textBytes) });
    run.push({ type: "user", message: { role: "user", content: message.text }, parent_tool_use_id: null,
      session_id: run.threadId, priority: "next" });
  }

  async interruptTurn(threadId, turnId) {
    const run = this.#running.get(claudeSessionId(threadId));
    if (!run || run.turnId !== turnId) fail("turn_not_active");
    await run.stop();
    return {};
  }

  // --- one turn -----------------------------------------------------------------------

  #claim(threadId, turnId) {
    const host = this;
    const abortController = new AbortController();
    let finishedResolve;
    const finished = new Promise((resolve) => { finishedResolve = resolve; });
    // The input of the Claude Code process: the first message, then whatever
    // is steered in or released from the queue, until the turn's work is over.
    const inputs = [];
    let wake = null;
    const run = {
      threadId, turnId, abortController, finished, stream: null, stopping: false, tools: new Map(), answers: new Map(),
      accepting: true, held: [], delivered: new Set(), extraInputs: 0, stateEvents: false, idle: null, idleFallback: null,
      observedModel: null, modelsSeen: new Set(),
      push(message) {
        if (!run.accepting) return;
        if (wake !== null) { const resolve = wake; wake = null; resolve(message); } else inputs.push(message);
      },
      nextInput() {
        if (inputs.length > 0) return Promise.resolve(inputs.shift());
        if (!run.accepting) return Promise.resolve(null);
        return new Promise((resolve) => { wake = resolve; });
      },
      /** No more input: the process ends after its current work. */
      close() {
        run.accepting = false;
        if (wake !== null) { const resolve = wake; wake = null; resolve(null); }
      },
      begin(session, text, options) {
        host.#execute(run, session, text, options).then(finishedResolve, finishedResolve);
      },
      async stop() {
        if (run.stopping) return;
        run.stopping = true;
        try {
          if (typeof run.stream?.interrupt === "function") await run.stream.interrupt();
          else abortController.abort();
        } catch { abortController.abort(); }
        // A process that does not answer the request is ended after a while.
        const last = setTimeout(() => abortController.abort(), STOP_GRACE_MS);
        finished.finally(() => clearTimeout(last));
      },
    };
    this.#running.set(threadId, run);
    return run;
  }

  /**
   * A result came: Claude Code finished one stretch of work. Messages held for
   * the end of the turn go now, one after another; Claude Code starts on them
   * at once. Otherwise the turn is over when Claude Code says it is idle - a
   * steered message may still be on its way - or, from a Claude Code that does
   * not report its state, right away.
   */
  async #afterResult(run) {
    if (run.stopping) {
      // The person stopped the turn: what waited for its end is not sent.
      for (const held of run.held.splice(0)) {
        await this.#trace(run, { type: "user_cancelled", clientId: held.clientId, reason: "turn_stopped" });
      }
      run.close();
      return;
    }
    if (run.held.length > 0) {
      for (const held of run.held.splice(0)) await this.#deliver(run, held, "queue");
      return;
    }
    if (!run.stateEvents) { run.close(); return; }
    // Idle is the authoritative end; a Claude Code that never says so does not
    // keep the turn open for ever. Work that goes on after the result (a
    // background task that finished, say) cancels this fallback: then only idle
    // ends the turn, and a message steered in meanwhile still reaches it.
    clearTimeout(run.idleFallback);
    run.idleFallback = setTimeout(() => run.close(), this.#idleGraceMs);
    run.idle = () => {
      run.idle = null;
      clearTimeout(run.idleFallback);
      run.idleFallback = null;
      if (run.held.length > 0) this.#afterResult(run);
      else run.close();
    };
  }

  /** What the host learned about the plan's usage goes to `onUsage`; it never stops a turn. */
  #usage(record) {
    if (this.#onUsage === null) return;
    try { this.#onUsage(record); } catch { /* the window's meter only */ }
  }

  /**
   * The plan's usage windows (5 hours, the week, per model), as Claude Code's
   * /usage: asked of the process of a turn that runs anyway - no session is
   * started for it and no model is called - at most once a minute.
   */
  #readUsage(run) {
    const read = run.stream?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (this.#onUsage === null || typeof read !== "function" || this.#usageReading) return;
    const nowMs = this.#now().getTime();
    if (nowMs - this.#usageReadAtMs < this.#usageIntervalMs) return;
    this.#usageReadAtMs = nowMs;
    this.#usageReading = true;
    let timer = null;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("late"), { code: "claude_usage_timeout" })), USAGE_TIMEOUT_MS);
    });
    Promise.race([Promise.resolve().then(() => read.call(run.stream, { skipBehaviors: true })), late])
      .then((answer) => this.#usage({ kind: "usage", answer, observedAtUtc: this.#at() }))
      .catch((error) => this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "usage",
        reasonCode: typeof error?.code === "string" ? error.code : "claude_usage_unavailable" }))
      .finally(() => {
        clearTimeout(timer);
        this.#usageReading = false;
      });
  }

  /** Claude Code works on after a result: the turn stays open until it says idle. */
  #stillWorking(run) {
    if (run.idleFallback === null || run.idleFallback === undefined) return;
    clearTimeout(run.idleFallback);
    run.idleFallback = null;
  }

  async #sessionExists(session) {
    if (session.providerStarted) return true;
    if (session.turnIds.length <= 1 || typeof this.#sdk.getSessionInfo !== "function") return false;
    // An earlier first turn may have started the session without the Gateway
    // seeing it (a Gateway that stopped mid-turn): Claude Code's own record decides.
    try { return Boolean(await this.#sdk.getSessionInfo(session.sessionId, { dir: session.cwd })); }
    catch { return false; }
  }

  async #execute(run, session, text, options) {
    const { threadId, turnId } = run;
    let result = null;
    let failure = null;
    let usageTimer = null;
    try {
      const resume = await this.#sessionExists(session);
      async function* prompt() {
        // The message goes in as a stream, kept open until the turn's work is
        // over: in that form the SDK can ask the person, can be interrupted and
        // takes the messages steered in while it works.
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: threadId };
        for (;;) {
          const next = await run.nextInput();
          if (next === null) return;
          yield next;
        }
      }
      run.stream = this.#sdk.query({ prompt: prompt(), options: this.#queryOptions(run, session, resume, options) });
      // A long turn spends the plan while it runs: its usage is read again on a timer, not only at its ends.
      if (this.#onUsage !== null) {
        usageTimer = setInterval(() => this.#readUsage(run), this.#usageIntervalMs);
        usageTimer.unref?.();
      }
      for await (const message of run.stream) {
        await this.#take(run, message);
        if (run.identityMismatch) { failure = "claude_session_identity_mismatch"; break; }
        if (message.type === "result") {
          result = message;
          this.#readUsage(run);
          await this.#afterResult(run);
        }
      }
    } catch (error) {
      failure = run.stopping ? null : SIGNED_OUT.test(String(error?.message ?? "")) ? "claude_signed_out" : "claude_process_failed";
      this.#diagnostic({ threadId, turnId, phase: "turn", reasonCode: "claude_process_failed",
        message: clip(error?.message ?? error, 400) });
      // A turn the Gateway can no longer follow (its record could not be
      // written, say) is not left running unobserved.
      run.abortController.abort();
    } finally {
      clearInterval(usageTimer);
      run.close();
    }
    if (run.identityMismatch) run.abortController.abort();
    // A result marked as an error (a usage limit, say) ends the turn as failed
    // even when its subtype says success.
    const status = result?.subtype === "success" && result.is_error !== true && !run.identityMismatch ? "completed"
      : run.stopping ? "interrupted" : "failed";
    await this.#finish(run, status, result, failure ?? (status !== "failed" ? null
      : result?.is_error === true ? (SIGNED_OUT.test(String(result?.result ?? "")) ? "claude_signed_out" : "claude_error_result")
        : result?.subtype ?? "claude_no_result"));
  }

  #queryOptions(run, session, resume, options) {
    const { threadId } = run;
    const extra = options.query ?? {};
    // The desk's tool goes with every turn of an agent that has it, so the
    // tool list stays the same from one turn to the next (prompt cache).
    const deskTools = Array.isArray(options.deskTools) && options.deskTools.length > 0 && this.supportsDeskTools
      ? options.deskTools : null;
    const desk = deskTools === null ? null : this.#deskServer(deskTools);
    const mcpServers = { ...(extra.mcpServers ?? {}), ...(desk === null ? {} : { desk }) };
    const allowedTools = [...(extra.allowedTools ?? []),
      ...(deskTools ?? []).map((tool) => claudeDeskToolName(tool.name))];
    return {
      cwd: session.cwd,
      abortController: run.abortController,
      // Claude Code reports when its work is over ("idle"), queued messages
      // included: the authoritative end of a turn that took steered messages.
      env: { ...(this.#env ?? process.env), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      ...(resume ? { resume: threadId } : { sessionId: threadId }),
      ...(options.model === null ? {} : { model: options.model }),
      ...(options.effort === "default" ? {} : { effort: options.effort }),
      settingSources: [...this.#settingSources],
      strictMcpConfig: true,
      skills: [],
      tools: [...this.#tools],
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(extra.hooks ? { hooks: extra.hooks } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true,
        ...(typeof extra.systemNote === "string" ? { append: extra.systemNote } : {}) },
      // The provider's own short account of its reasoning, not a bare mark.
      thinking: { type: "adaptive", display: "summarized" },
      // The agent's own mode, else the provider's; bypassing every check needs
      // the SDK's explicit consent flag as well.
      permissionMode: options.permissionMode ?? this.#permissionMode,
      ...((options.permissionMode ?? this.#permissionMode) === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: (toolName, input, details) => this.#ask(run, session, toolName, input, details),
      stderr: (line) => this.#diagnostic({ threadId, turnId: run.turnId, phase: "stderr",
        message: clip(String(line).trimEnd(), 400) }),
    };
  }

  async #record(run, change) {
    await this.#journal.updateTurn(run.threadId, run.turnId, change, this.#at());
  }

  /** One record of the session's trace; a trace that cannot be written never stops the turn. */
  async #trace(run, record) {
    if (typeof this.#journal.appendTrace !== "function") return;
    try {
      await this.#journal.appendTrace(run.threadId, { atUtc: this.#at(), turnId: run.turnId, ...record });
    } catch (error) {
      this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "trace",
        reasonCode: error?.code ?? "claude_trace_unavailable" });
    }
  }

  /** The session's trace, a page at a time (journal readTrace). */
  async readTrace(threadId, options = {}) {
    if (typeof this.#journal.readTrace !== "function") fail("claude_trace_unavailable");
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

  async #take(run, message) {
    // What a sub-agent says and does belongs to that tool call, not to the conversation.
    if (typeof message?.parent_tool_use_id === "string") return;
    if (message?.type === "system" && message.subtype === "init") {
      if (message.session_id !== run.threadId) {
        run.identityMismatch = true;
        this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "init",
          reasonCode: "claude_session_identity_mismatch" });
        return;
      }
      const model = typeof message.model === "string" ? message.model.slice(0, 160) : null;
      run.observedModel = model;
      await this.#record(run, (turn, session) => {
        session.providerStarted = true;
        turn.observedModel = model;
      });
      await this.#trace(run, { type: "session", model, cwd: typeof message.cwd === "string" ? clip(message.cwd, 1024) : null,
        claudeCodeVersion: typeof message.claude_code_version === "string" ? message.claude_code_version.slice(0, 64) : null });
      this.#readUsage(run);
      return;
    }
    if (message?.type === "rate_limit_event") {
      // Close to a plan limit, or refused by it: the window shows it with the usage.
      this.#usage({ kind: "rate-limit", info: message.rate_limit_info ?? null, observedAtUtc: this.#at() });
      return;
    }
    if (message?.type === "system" && message.subtype === "session_state_changed") {
      run.stateEvents = true;
      if (message.state === "idle") run.idle?.();
      else this.#stillWorking(run);
      return;
    }
    if (message?.type === "system" && message.subtype === "compact_boundary") {
      // Claude Code replaced the earlier conversation with a summary: what the
      // agent was told before may be gone (memory is sent again, see
      // ProjectMemoryService.send).
      await this.#record(run, (turn, session) => {
        session.compactions = (session.compactions ?? 0) + 1;
        turn.compacted = true;
      });
      const meta = message.compact_metadata ?? {};
      await this.#trace(run, { type: "compacted", trigger: typeof meta.trigger === "string" ? meta.trigger.slice(0, 32) : null,
        preTokens: Number.isSafeInteger(meta.pre_tokens) ? meta.pre_tokens : null });
      return;
    }
    if (message?.type === "assistant" && Array.isArray(message.message?.content)) {
      this.#stillWorking(run);
      const base = typeof message.uuid === "string" && ID.test(message.uuid) ? message.uuid : randomUUID();
      // The model that actually answered: the session may have been switched
      // to another one, or Claude Code may have fallen back.
      const model = typeof message.message.model === "string" ? message.message.model.slice(0, 160) : null;
      if (model !== null && (model !== run.observedModel || !run.modelsSeen.has(model))) {
        run.observedModel = model;
        run.modelsSeen.add(model);
        await this.#record(run, (turn) => {
          turn.observedModel = model;
          if (!turn.modelsUsed.includes(model) && turn.modelsUsed.length < 8) turn.modelsUsed.push(model);
        });
      }
      for (const [index, part] of message.message.content.entries()) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          await this.#addItem(run, { id: `${base}:${index}`, type: "agentMessage",
            text: clip(part.text.trim(), CLAUDE_CODE_SESSION_LIMITS.textBytes) }, true);
          await this.#trace(run, { type: "assistant", model, text: clip(part.text, TRACE_LIMITS.textBytes) });
        } else if (part?.type === "thinking") {
          await this.#addItem(run, { id: `${base}:${index}`, type: "reasoning",
            summary: typeof part.thinking === "string" ? clip(part.thinking.trim(), 8192) : null }, true);
          if (typeof part.thinking === "string" && part.thinking.trim()) {
            await this.#trace(run, { type: "thinking", text: clip(part.thinking, TRACE_LIMITS.textBytes) });
          }
        } else if (part?.type === "tool_use" && typeof part.id === "string" && ID.test(part.id)) {
          await this.#trace(run, { type: "tool_use", toolUseId: part.id, tool: clip(part.name ?? "", 256),
            input: clip(JSON.stringify(part.input ?? {}), TRACE_LIMITS.inputBytes) });
          const item = part.name === QUESTION_TOOL ? questionItem(part) : toolItem(part);
          run.tools.set(part.id, item.type);
          await this.#addItem(run, item, false);
        }
      }
      return;
    }
    if (message?.type === "user" && Array.isArray(message.message?.content)) {
      for (const part of message.message.content) {
        if (part?.type !== "tool_result" || !run.tools.has(part.tool_use_id)) continue;
        const failed = part.is_error === true;
        const output = clip(resultText(part.content), CLAUDE_CODE_SESSION_LIMITS.outputBytes);
        run.tools.delete(part.tool_use_id);
        // One tool result per message is the usual case: its structured
        // result (a file tool's patch) belongs to it.
        const patch = failed ? null : patchOf(message.tool_use_result);
        const answers = run.answers.get(part.tool_use_id) ?? null;
        run.answers.delete(part.tool_use_id);
        await this.#completeItem(run, part.tool_use_id, (item) => {
          item.status = failed ? "failed" : "completed";
          if (item.type === "userQuestion") item.answers = failed ? null : answers;
          else if (item.type === "commandExecution") item.aggregatedOutput = output;
          else item.output = output;
          if (item.type === "fileChange" && patch !== null && item.changes.length === 1) {
            Object.assign(item.changes[0], { added: patch.added, removed: patch.removed });
          }
        });
        await this.#trace(run, { type: "tool_result", toolUseId: part.tool_use_id, isError: failed,
          output: clip(resultText(part.content), TRACE_LIMITS.outputBytes),
          ...(patch?.diff ? { diff: clip(patch.diff, TRACE_LIMITS.diffBytes) } : {}) });
      }
    }
  }

  async #finish(run, status, result, failure) {
    const usage = result?.usage ?? null;
    const modelUsage = result?.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : {};
    try {
      await this.#record(run, (turn, session) => {
        // Tool calls the turn left open end with it.
        for (const item of turn.items) if (item.status === "inProgress") item.status = status;
        // Models seen in the turn's answers and in its last result, together:
        // a turn that took a queued message may have run on more than one.
        const modelsUsed = [...new Set([...(turn.modelsUsed ?? []),
          ...Object.keys(modelUsage).map((name) => name.slice(0, 160))])].slice(0, 8);
        Object.assign(turn, { status, completedAt: this.#at(), failure,
          resultSubtype: typeof result?.subtype === "string" ? result.subtype.slice(0, 64) : null,
          modelsUsed,
          costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null });
        if (usage !== null) {
          const previous = session.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
            contextWindow: 0, costUsd: 0 };
          const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          const cached = usage.cache_read_input_tokens ?? 0;
          const output = usage.output_tokens ?? 0;
          const window = Math.max(0, ...Object.values(modelUsage).map((entry) => Number(entry?.contextWindow) || 0));
          session.usage = { inputTokens: previous.inputTokens + input, cachedInputTokens: previous.cachedInputTokens + cached,
            outputTokens: previous.outputTokens + output, totalTokens: previous.totalTokens + input + cached + output,
            contextWindow: window || previous.contextWindow,
            costUsd: previous.costUsd + (typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0) };
        }
      });
    } catch (error) {
      this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "finish",
        reasonCode: error?.code ?? "claude_journal_unavailable" });
    }
    // The trace keeps per-turn usage and each model's share; the turn file
    // keeps only the model names, the session file the running totals.
    const perModel = Object.fromEntries(Object.entries(modelUsage).slice(0, 8).map(([name, entry]) => [name.slice(0, 160), {
      inputTokens: Number(entry?.inputTokens) || 0, outputTokens: Number(entry?.outputTokens) || 0,
      cacheReadInputTokens: Number(entry?.cacheReadInputTokens) || 0,
      cacheCreationInputTokens: Number(entry?.cacheCreationInputTokens) || 0,
      costUsd: Number(entry?.costUSD) || 0, contextWindow: Number(entry?.contextWindow) || 0 }]));
    await this.#trace(run, { type: "turn_finished", status, failure,
      resultSubtype: typeof result?.subtype === "string" ? result.subtype.slice(0, 64) : null,
      durationMs: Number.isSafeInteger(result?.duration_ms) ? result.duration_ms : null,
      numTurns: Number.isSafeInteger(result?.num_turns) ? result.num_turns : null,
      costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
      usage: usage === null ? null : { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0 },
      models: perModel });
    this.#running.delete(run.threadId);
    this.emit("turn/completed", { threadId: run.threadId, turnId: run.turnId,
      turn: { id: run.turnId, status, items: [] } });
  }

  // --- the person's decisions ----------------------------------------------------------

  #request(run, session, toolName, input, details) {
    const base = { threadId: run.threadId, turnId: run.turnId, itemId: details.toolUseID };
    const reason = typeof details.title === "string" && details.title.trim() ? clip(details.title, 4096)
      : typeof details.decisionReason === "string" ? clip(details.decisionReason, 4096) : null;
    if (SHELL_TOOLS.has(toolName)) {
      return { method: "item/commandExecution/requestApproval", params: { ...base,
        command: clip(input?.command ?? "", 8192), cwd: session.cwd, reason,
        availableDecisions: ["accept", "cancel", "decline"] } };
    }
    if (FILE_TOOLS.has(toolName)) {
      const target = input?.[FILE_TOOLS.get(toolName)];
      return { method: "item/fileChange/requestApproval", params: { ...base,
        reason: reason ?? clip(`${toolName} ${typeof target === "string" ? target : ""}`.trim(), 4096), grantRoot: null } };
    }
    if (toolName === QUESTION_TOOL && Array.isArray(input?.questions) && input.questions.length > 0) {
      const questions = input.questions.slice(0, 16).map((question, index) => ({
        id: `q${index + 1}`,
        header: clip(question?.header || `Question ${index + 1}`, 256),
        question: clip(question?.question || "", 4096) || `Question ${index + 1}`,
        isOther: true,
        // Several options may be chosen; the answers go back joined with ", ".
        multiSelect: question?.multiSelect === true,
        options: Array.isArray(question?.options) && question.options.length > 0
          ? question.options.slice(0, 16).map((option) => ({ label: clip(option?.label || "-", 1024),
            description: clip(option?.description ?? "", 2048) }))
          : null,
      }));
      return { method: "item/tool/requestUserInput", params: { ...base, isBlocking: true, questions } };
    }
    return { method: "item/permissions/requestApproval", params: { ...base, cwd: session.cwd,
      reason: reason ?? clip(toolName, 256),
      permissions: { tool: clip(toolName, 256), input: clip(JSON.stringify(input ?? {}), 4096) } } };
  }

  #decision(method, params, payload, toolName, input) {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      if (payload?.decision === "accept") return { behavior: "allow", updatedInput: input };
      if (payload?.decision === "cancel") return { behavior: "deny", message: "The person stopped this turn.", interrupt: true };
      return { behavior: "deny", message: "The person declined this action." };
    }
    if (method === "item/tool/requestUserInput") {
      const answers = {};
      for (const [index, question] of params.questions.entries()) {
        const given = payload?.answers?.[question.id]?.answers;
        if (!Array.isArray(given) || given.length === 0) {
          return { behavior: "deny", message: "The person did not answer." };
        }
        answers[String(input.questions[index]?.question ?? question.question)] = given.map(String).join(", ");
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    const granted = payload?.permissions && Object.keys(payload.permissions).length > 0;
    return granted ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `The person did not allow ${toolName}.` };
  }

  async #ask(run, session, toolName, input, details = {}) {
    if (typeof details.toolUseID !== "string" || !ID.test(details.toolUseID)) {
      return { behavior: "deny", message: "The request has no usable identity; the action was not taken." };
    }
    const { method, params } = this.#request(run, session, toolName, input, details);
    const handler = this.#handlers.get(method);
    if (!handler) return { behavior: "deny", message: "Nobody can answer this request now; the action was not taken." };
    const requestId = `${run.turnId}:${details.toolUseID}`;
    const signals = [run.abortController.signal, ...(details.signal ? [details.signal] : [])];
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const deadlineAtUtc = new Date(this.#now().getTime() + this.#requestTimeoutMs).toISOString();
    let payload;
    try {
      payload = await handler(params, { requestId, method, generation: this.#generation, deadlineAtUtc, signal });
    } catch (error) {
      this.#diagnostic({ threadId: run.threadId, turnId: run.turnId, phase: "interaction",
        reasonCode: error?.code ?? "interaction_failed" });
      return { behavior: "deny", message: "The request ended without the person's decision; the action was not taken." };
    }
    this.emit("serverRequestState", { requestId, generation: this.#generation, method,
      providerResolvedAtUtc: this.#at() });
    const decision = this.#decision(method, params, payload, toolName, input);
    // The person's decision goes to the trace: a refused action is attention in the desk.
    if (method !== "item/tool/requestUserInput") {
      await this.#trace(run, { type: "permission", toolUseId: details.toolUseID, tool: clip(toolName, 256),
        decision: decision.behavior === "allow" ? "allow" : decision.interrupt === true ? "cancel" : "deny", by: "person" });
    }
    if (method === "item/tool/requestUserInput" && decision.behavior === "allow") {
      // The answers, in the order of the questions, for the chat's record of them.
      run.answers.set(details.toolUseID, params.questions.map((question) =>
        clip(payload.answers[question.id].answers.map(String).join(", "), 4096)));
    }
    return decision;
  }
}

export function claudeTurnState(turn) {
  if (turn === null) return "unknown";
  if (turn.status === "inProgress") return "started";
  return TERMINAL.has(turn.status) ? turn.status : "unknown";
}

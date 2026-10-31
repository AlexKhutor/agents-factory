import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { claudeSecretHook } from "./agent-secret-paths.mjs";
import { claudeWriteZoneHook, normalizeWriteZone } from "./agent-write-zone.mjs";
import {
  claudeEnvironment, claudeProgramOf, loadClaudeSdk, loadClaudeZod, readClaudeAccount,
} from "./claude-code-sdk.mjs";
import { createClaudeCodeSessionJournal } from "./claude-code-session-journal.mjs";
import { ClaudeCodeSessionHost } from "./claude-code-session-host.mjs";
import { readClaudeProviderConfig } from "./claude-provider-config.mjs";
import { ServiceReviewProvider } from "./control-review-provider.mjs";
import { ServiceReportSummarizer } from "./report-presentation.mjs";

// The controller's one-off model turns - the review of one child report and
// the summary of one report - on Claude Code instead of the Codex App Server.
//
// The reviewer and the summarizer drive a client of the Codex App Server
// shape (connect, startThread, startTurn, waitForTurn, interruptTurn, usage,
// notifications). This client gives them that shape over a Claude Code
// session host, so their own logic - cancellation, heartbeats, agent records,
// the decision file, the summary checks - runs unchanged. Nobody watches a
// service turn: what it may do is fixed in advance. The reviewer reads
// anything and writes only inside its review folder (a write zone held by a
// hook); it has no shell, no web and no sub-agents, so the desk gives it one
// read-only tool to hash a file (the review checks task and report SHA-256).
// The summarizer has no tools at all.

export const CLAUDE_CODE_SERVICE_CLIENT_VERSION = "v0.2.0";
export const CLAUDE_CODE_SERVICE_PROVIDER_ID = "claude-code";
export const CLAUDE_REVIEW_SERVICE_NAME = "claude_code_serialized_reviewer";
export const CLAUDE_SUMMARY_SERVICE_NAME = "claude_code_report_summarizer";
/** Service turns keep their own journal, apart from the desk's agents. */
export const CLAUDE_SERVICE_JOURNAL_FOLDER = "claude-service-sessions";
export const CLAUDE_REVIEW_TOOLS = Object.freeze(["Read", "Glob", "Grep", "Write", "Edit"]);
export const CLAUDE_SUMMARY_TOOLS = Object.freeze([]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const NOTIFICATIONS = Object.freeze(["turn/started", "item/started", "item/completed", "turn/completed"]);
const REVIEW_SKILL = "the review skill in .agents/skills/review-child-report/SKILL.md";
const MAX_HASHED_BYTES = 256 * 1024 * 1024;

/** The reviewer's desk tool: the SHA-256 of one file, read only. */
export function fileSha256Tool(root) {
  return {
    name: "file_sha256",
    description: "Computes the SHA-256 of one file (read only), to verify task, report and evidence hashes."
      + " The path is absolute or relative to the controller root.",
    inputSchema: (z) => ({ path: z.string() }),
    handler: async (args) => {
      if (typeof args?.path !== "string" || !args.path.trim()) return "Nothing done: name a file.";
      const file = path.resolve(root, args.path);
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile()) return "Nothing done: no such file.";
      if (info.size > MAX_HASHED_BYTES) return "Nothing done: the file is too large to hash here.";
      const hash = createHash("sha256");
      await new Promise((resolve, reject) => {
        createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
      });
      return `sha256 ${hash.digest("hex")} (${info.size} bytes)`;
    },
  };
}

function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }

export class ClaudeCodeServiceClient extends EventEmitter {
  #createHost;
  #writeZone;
  #host = null;
  #threads = new Map();
  #completed = new Map();
  #waiting = new Map();
  #detach = [];
  #closed = false;

  /**
   * `createHost`: async () => a ClaudeCodeSessionHost; `writeZone`: the
   * patterns (from the turn's folder) a turn may change, or null for none.
   */
  #deskTools;

  /** `deskTools(cwd)`: the desk tools of a turn in that folder, or null for none. */
  constructor({ createHost, writeZone = null, deskTools = null } = {}) {
    super();
    if (typeof createHost !== "function") fail("claude_service_invalid");
    this.#createHost = createHost;
    this.#writeZone = writeZone === null ? null : normalizeWriteZone(writeZone);
    this.#deskTools = typeof deskTools === "function" ? deskTools : null;
  }

  async connect() {
    if (this.#closed || this.#host !== null) fail("provider_disconnected");
    const host = await this.#createHost();
    this.#host = host;
    for (const method of NOTIFICATIONS) {
      const listener = (params) => {
        if (method === "turn/completed") this.#settle(params);
        this.emit("notification", { method, params });
      };
      host.on(method, listener);
      this.#detach.push(() => host.off(method, listener));
    }
    // The answers nobody is there to give. A write reaches the question only
    // after the zone hook let it through; a read may go anywhere, as the Codex
    // reviewer's could; a command is never run.
    this.#detach.push(host.registerServerRequestHandler("item/fileChange/requestApproval",
      async () => ({ decision: this.#writeZone === null ? "decline" : "accept" })));
    this.#detach.push(host.registerServerRequestHandler("item/commandExecution/requestApproval",
      async () => ({ decision: "decline" })));
    this.#detach.push(host.registerServerRequestHandler("item/permissions/requestApproval",
      async (params) => (READ_TOOLS.has(params?.permissions?.tool)
        ? { permissions: { [params.permissions.tool]: "allow" } } : { permissions: {} })));
    await host.connect();
    return { serverInfo: { name: "claude-code", version: null } };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      // Closing the host stops a running turn; its end still reaches waiters.
      await this.#host?.close();
    } finally {
      for (const detach of this.#detach.splice(0)) detach();
      for (const waiters of this.#waiting.values()) {
        for (const waiter of waiters) waiter.reject(Object.assign(new Error("provider_disconnected"),
          { code: "provider_disconnected" }));
      }
      this.#waiting.clear();
    }
  }

  #connected() {
    if (this.#host === null || this.#closed) fail("provider_disconnected");
    return this.#host;
  }

  #settle(params) {
    const turnId = params?.turn?.id ?? params?.turnId;
    if (typeof turnId !== "string") return;
    this.#completed.set(turnId, params);
    for (const waiter of this.#waiting.get(turnId) ?? []) waiter.resolve(params);
    this.#waiting.delete(turnId);
  }

  async listModels() {
    return this.#connected().listModels();
  }

  /** A new session; its model, effort and instructions apply to its turns. */
  async startThread({ cwd, model = null, config = {}, developerInstructions = null } = {}) {
    const host = this.#connected();
    const effort = typeof config?.model_reasoning_effort === "string" ? config.model_reasoning_effort : "default";
    const id = await host.createSession({ cwd });
    this.#threads.set(id, { cwd, model, effort,
      note: typeof developerInstructions === "string" && developerInstructions.trim() ? developerInstructions : null });
    return { thread: { id, model, reasoningEffort: effort === "default" ? null : effort } };
  }

  /** Claude Code sessions have no names; the journal keeps the session by its ID. */
  async setThreadName() {
    return {};
  }

  async startTurn(threadId, prompt) {
    const host = this.#connected();
    const thread = this.#threads.get(threadId);
    if (!thread) fail("thread_not_found");
    // Secrets first, then the write zone when the service has one (agent-secret-paths.mjs).
    const hooks = { PreToolUse: [{ hooks: [claudeSecretHook({ root: thread.cwd }),
      ...(this.#writeZone === null ? [] : [claudeWriteZoneHook({ root: thread.cwd, patterns: this.#writeZone })])] }] };
    const deskTools = this.#deskTools === null ? null : this.#deskTools(thread.cwd);
    return host.startTurn(threadId, [{ type: "text", text: String(prompt) }], {
      model: thread.model, effort: thread.effort, ...(deskTools ? { deskTools } : {}),
      query: { hooks, ...(thread.note === null ? {} : { systemNote: thread.note }) },
    });
  }

  /** Resolves with the turn's completion (as the Codex client: { threadId, turnId, turn }). */
  waitForTurn(turnId, timeoutMs = 3_600_000) {
    if (this.#completed.has(turnId)) return Promise.resolve(this.#completed.get(turnId));
    if (this.#closed) return Promise.reject(Object.assign(new Error("provider_disconnected"), { code: "provider_disconnected" }));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (params) => { clearTimeout(timer); resolve(params); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.#waiting.get(turnId)?.delete(waiter);
        reject(Object.assign(new Error(`Timed out waiting for turn ${turnId}`), { code: "TURN_WAIT_TIMEOUT" }));
      }, timeoutMs);
      timer.unref?.();
      if (!this.#waiting.has(turnId)) this.#waiting.set(turnId, new Set());
      this.#waiting.get(turnId).add(waiter);
    });
  }

  async interruptTurn(threadId, turnId) {
    return this.#connected().interruptTurn(threadId, turnId);
  }

  async readThread(threadId, includeTurns = false) {
    return this.#connected().readThread(threadId, includeTurns);
  }

  async readThreadUsage(threadId) {
    return this.#connected().readThreadUsage(threadId);
  }

  /** A service turn has no sub-agents (its tools have no Task tool). */
  async listDescendantThreads() {
    return { data: [], nextCursor: null };
  }
}

/**
 * Hosts for service turns of one controller. `claude`: the normalized
 * provider config (read from the controller when null), plus for tests an
 * `sdk` object and a `readAccount` function.
 */
export function claudeServiceHosts({ controllerRoot, tools, claude = null, now = () => new Date(),
  onDiagnostic = () => {} }) {
  return async () => {
    const config = claude ?? await readClaudeProviderConfig(controllerRoot);
    const sdk = config.sdk ?? await loadClaudeSdk(config.sdkPath);
    const env = claudeEnvironment({ configDir: config.claudeConfigDir ?? null,
      keepProviderVariables: config.keepProviderVariables === true });
    const readAccount = config.readAccount ?? (() => readClaudeAccount({ program: claudeProgramOf(config.sdkPath), env }));
    const journal = await createClaudeCodeSessionJournal({ controllerRoot, folder: CLAUDE_SERVICE_JOURNAL_FOLDER });
    // zod, in which desk tools are declared, comes from beside the SDK.
    let zod = config.zod ?? null;
    if (zod === null && !config.sdk) {
      try { zod = loadClaudeZod(config.sdkPath); } catch { zod = null; }
    }
    return new ClaudeCodeSessionHost({ sdk, journal, now, env, models: config.models, tools: [...tools], zod,
      settingSources: config.settingSources, permissionMode: "acceptEdits", readAccount, recoverOnConnect: false,
      onDiagnostic });
  };
}

/** The folder of an item's decision file, as a write zone. */
export function reviewWriteZone(item) {
  const reference = String(item?.decisionPath || `coordination/reviews/${item?.taskId}/decision.json`);
  return [`${path.posix.dirname(reference.replace(/\\/gu, "/"))}/**`];
}

/** The serialized reviewer of the control cycle, on Claude Code. */
export function createClaudeReviewProvider({ controllerRoot, provider = {}, claude = null, onDiagnostic } = {}) {
  const createHost = claudeServiceHosts({ controllerRoot, tools: CLAUDE_REVIEW_TOOLS, claude, onDiagnostic });
  return new ServiceReviewProvider({
    cwd: controllerRoot,
    providerId: CLAUDE_CODE_SERVICE_PROVIDER_ID,
    serviceName: CLAUDE_REVIEW_SERVICE_NAME,
    clientVersion: CLAUDE_CODE_SERVICE_CLIENT_VERSION,
    // Claude Code turns carry no skills (skills: []); the reviewer reads the skill file itself.
    promptOptions: { reviewSkill: REVIEW_SKILL },
    clientFactory: (item) => new ClaudeCodeServiceClient({ createHost, writeZone: reviewWriteZone(item),
      deskTools: (cwd) => [fileSha256Tool(cwd)] }),
    model: provider.model,
    reasoningEffort: provider.reasoningEffort,
    pollIntervalMs: provider.pollIntervalMs ?? 1000,
    heartbeatIntervalMs: provider.heartbeatIntervalMs ?? 60_000,
    turnTimeoutMs: provider.turnTimeoutMs ?? 3_600_000,
    interruptConfirmationTimeoutMs: provider.interruptConfirmationTimeoutMs ?? 10_000,
  });
}

/** The report summarizer of the report operations, on Claude Code. */
export function createClaudeReportSummarizer({ controllerRoot, turnTimeoutMs = 600_000, claude = null,
  onDiagnostic } = {}) {
  const createHost = claudeServiceHosts({ controllerRoot, tools: CLAUDE_SUMMARY_TOOLS, claude, onDiagnostic });
  return new ServiceReportSummarizer({
    cwd: controllerRoot,
    providerId: CLAUDE_CODE_SERVICE_PROVIDER_ID,
    serviceName: CLAUDE_SUMMARY_SERVICE_NAME,
    clientVersion: CLAUDE_CODE_SERVICE_CLIENT_VERSION,
    clientFactory: () => new ClaudeCodeServiceClient({ createHost }),
    turnTimeoutMs,
  });
}

import { validateAdapterDescriptor } from "./adapter-contracts.mjs";
import { createApplicationAuthenticationState } from "./application-authentication-state.mjs";
import {
  ProviderConversationContentPolicyError,
  createOmittedProviderConversationContent,
  createVisibleProviderConversationContent,
} from "./provider-conversation-content-policy.mjs";
import { createProviderConversationReadData } from "./provider-conversation-read-data.mjs";
import { assessProviderConversationReadCapabilities } from "./provider-conversation-read-contract.mjs";
import { createProviderConversationThreadReadResult } from "./provider-conversation-reader.mjs";
import { validateExternalReference } from "./work-authority-contract.mjs";

export const CODEX_APP_SERVER_CONVERSATION_READ_ADAPTER_VERSION = "v0.4.1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_RECORDS = 128;
const MAX_CONTENT = 256;
const READ_ATTEMPTS = 4;
const DROPPED = Symbol("dropped");

/**
 * Items of each turn, fitted into `budget` items for the whole page. Turns that
 * fit stay whole; the budget left over is shared among the longer ones. A
 * shortened turn keeps the person's messages, its last answer and its latest
 * actions, and one marker (`DROPPED`, carrying the first left-out item's id)
 * where the left-out part was.
 */
function fitTurnItems(turnItems, budget) {
  const total = turnItems.reduce((sum, items) => sum + items.length, 0);
  if (total <= budget) return turnItems;
  // Water-filling: short turns are kept whole, the rest share what remains.
  const allowance = new Array(turnItems.length).fill(0);
  let left = budget;
  const order = turnItems.map((items, index) => ({ index, size: items.length }))
    .sort((a, b) => a.size - b.size);
  order.forEach(({ index, size }, position) => {
    const share = Math.floor(left / (order.length - position));
    allowance[index] = Math.min(size, Math.max(share, 0));
    left -= allowance[index];
  });
  return turnItems.map((items, index) => {
    const room = allowance[index];
    if (items.length <= room) return items;
    if (room <= 1) return [{ [DROPPED]: true, id: items[0]?.id }];
    const keep = new Set();
    items.forEach((item, at) => { if (item?.type === "userMessage") keep.add(at); });
    const lastAnswer = items.map((item) => item?.type).lastIndexOf("agentMessage");
    if (lastAnswer !== -1) keep.add(lastAnswer);
    // The marker takes one place; the latest actions fill what remains.
    for (let at = items.length - 1; at >= 0 && keep.size < room - 1; at -= 1) keep.add(at);
    const kept = [...keep].sort((a, b) => a - b).slice(-(room - 1));
    const result = [];
    let marked = false;
    kept.forEach((at, position) => {
      const previous = position === 0 ? -1 : kept[position - 1];
      if (!marked && at - previous > 1) {
        result.push({ [DROPPED]: true, id: items[previous + 1]?.id });
        marked = true;
      }
      result.push(items[at]);
    });
    return result;
  });
}

export class CodexAppServerConversationReadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodexAppServerConversationReadError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CodexAppServerConversationReadError(code, message, details);
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_request", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) fail("invalid_request", `${label} has unsupported fields`, { unknown });
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_provider_payload", `${label} is not a bounded provider identifier`);
  }
  return value;
}

function pageOptions(value, fields = []) {
  exact(value, ["cursor", "limit", ...fields], "provider read options");
  const cursor = value.cursor ?? null;
  const limit = value.limit ?? 50;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 512)) {
    fail("invalid_request", "Provider cursor is invalid");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS) {
    fail("invalid_request", `Provider page limit must be between 1 and ${MAX_RECORDS}`);
  }
  return { cursor, limit };
}

function providerRef(provider, kind, externalId) {
  return {
    schemaVersion: 1,
    kind,
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: provider.sourceId,
      externalId: identifier(externalId, `${kind} id`),
      contractVersion: provider.adapterVersion,
    },
  };
}

function exactProviderRef(value, provider, kind, label) {
  validateExternalReference(value);
  if (value.kind !== kind || value.relationship !== "provider-owner"
      || value.authority.authorityType !== "provider"
      || value.authority.sourceId !== provider.sourceId
      || value.authority.contractVersion !== provider.adapterVersion) {
    fail("identity_mismatch", `${label} is not owned by this provider runtime`);
  }
  return identifier(value.authority.externalId, `${label} native id`);
}

function utc(value, label) {
  if (value === null || value === undefined) return null;
  let milliseconds;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value > 10_000_000_000 ? value : value * 1000;
  } else if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    milliseconds = Date.parse(value);
  } else {
    fail("invalid_provider_payload", `${label} is not a supported timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

/**
 * When an item was written: its own time (the Claude Code and ACP hosts stamp `atUtc`), else its
 * turn's - the person's message at the start, the rest at the end (or the start while it runs) -
 * else the read. A conversation shows when things happened, not when they were read.
 */
function itemTime(item, turn, fallback) {
  const lenient = (value) => { try { return utc(value, "item time"); } catch { return null; } };
  const started = lenient(turn?.startedAt ?? turn?.createdAt);
  return lenient(item?.atUtc)
    ?? (item?.type === "userMessage" ? started : lenient(turn?.completedAt) ?? started)
    ?? fallback;
}

function completeness(nextCursor, reasonCode = "provider_pagination") {
  return nextCursor === null || nextCursor === undefined
    ? { status: "complete", reasonCode: null, nextCursor: null }
    : { status: "partial", reasonCode, nextCursor: String(nextCursor) };
}

function threadState(thread, hasTurns = null) {
  const state = thread?.status?.type ?? thread?.status ?? "unknown";
  if (state === "active") return "active";
  if (state === "systemError" || state === "failed") return "failed";
  if (["idle", "notLoaded", "completed"].includes(state)) {
    return hasTurns === false ? "empty" : "idle";
  }
  return "unknown";
}

function turnState(turn) {
  const state = turn?.status?.type ?? turn?.status ?? "unknown";
  return ({
    notStarted: "pending",
    inProgress: "active",
    completed: "completed",
    failed: "failed",
    interrupted: "interrupted",
  })[state] ?? "unknown";
}

function threadMetadata(provider, thread, { archived = false, hasTurns = null } = {}) {
  const threadId = identifier(thread?.id, "thread.id");
  const parentId = thread?.parentThreadId ?? null;
  return {
    threadRef: providerRef(provider, "provider-thread", threadId),
    parentThreadRef: parentId === null ? null : providerRef(provider, "provider-thread", parentId),
    title: typeof thread?.name === "string" && thread.name.length > 0
      ? thread.name.slice(0, 256) : null,
    state: threadState(thread, hasTurns),
    archived: thread?.archived === true || archived,
    updatedAtUtc: utc(thread?.updatedAt ?? thread?.updatedAtUtc ?? null, "thread.updatedAt"),
    activeTurnRef: null,
  };
}

function turnMetadata(provider, threadId, turn) {
  return {
    turnRef: providerRef(provider, "provider-turn", turn?.id),
    threadRef: providerRef(provider, "provider-thread", threadId),
    state: turnState(turn),
    startedAtUtc: utc(turn?.startedAt ?? turn?.createdAt ?? null, "turn.startedAt"),
    completedAtUtc: utc(turn?.completedAt ?? null, "turn.completedAt"),
    itemCount: Array.isArray(turn?.items) ? turn.items.length : 0,
  };
}

function omitted(provider, itemRef, turnRef, observedAtUtc, omissionReason) {
  return createOmittedProviderConversationContent({
    provider, itemRef, turnRef, observedAtUtc, omissionReason,
  });
}

function visible(provider, itemRef, turnRef, observedAtUtc, contentClass, text) {
  if (typeof text !== "string" || text.length === 0) {
    return omitted(provider, itemRef, turnRef, observedAtUtc, "unsupported_content");
  }
  if (Buffer.byteLength(text, "utf8") > 65_536) {
    return omitted(provider, itemRef, turnRef, observedAtUtc, "oversized_content");
  }
  try {
    return createVisibleProviderConversationContent({
      provider, itemRef, turnRef, contentClass, text, observedAtUtc,
    });
  } catch (error) {
    if (error instanceof ProviderConversationContentPolicyError) {
      return omitted(provider, itemRef, turnRef, observedAtUtc, "unsafe_content");
    }
    throw error;
  }
}

function publicActivityStatus(value) {
  const raw = value?.type ?? value;
  return ({
    inProgress: "in progress",
    running: "in progress",
    completed: "completed",
    failed: "failed",
    declined: "declined",
    cancelled: "cancelled",
  })[raw] ?? "status unknown";
}

// How much of a command's output the chat shows; the trace keeps more.
const OUTPUT_PREVIEW_BYTES = 6 * 1024;
// The data is English; the window shows it in the person's language (Atlas locales).
const STATUS_WORDS = Object.freeze({ "in progress": "running", failed: "error", declined: "declined",
  cancelled: "cancelled", interrupted: "interrupted" });

// A secret a tool printed is masked in the preview, so the action stays
// visible instead of being omitted whole by the content policy.
const OUTPUT_SECRETS = Object.freeze([
  /data:(?:image|audio|video)\/[^\s"'<>)]*/giu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
]);

function preview(text, maximumBytes) {
  const value = OUTPUT_SECRETS.reduce((current, pattern) => current.replace(pattern, "[hidden]"),
    String(text ?? "")).replace(/\s+$/u, "");
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const head = Buffer.from(value, "utf8").subarray(0, maximumBytes).toString("utf8").replace(/�+$/u, "");
  return `${head}\n…`;
}

/** "+3 −1" of a file change; empty when the counts are unknown. */
function changeCounts(change) {
  const parts = [];
  if (Number.isSafeInteger(change?.added)) parts.push(`+${change.added}`);
  if (Number.isSafeInteger(change?.removed)) parts.push(`−${change.removed}`);
  return parts.join(" ");
}

/**
 * The readable account of one tool call, as Claude Code shows it in its
 * transcript: the first line says what was done (the chat shows it folded),
 * the rest what came of it. Items of an older journal, without the detail,
 * keep their former one-line form.
 */
function activitySummary(item) {
  const status = publicActivityStatus(item?.status);
  const statusWord = STATUS_WORDS[status] ?? null;
  const tail = statusWord === null ? "" : ` · ${statusWord}`;
  if (item?.type === "commandExecution") {
    const exit = Number.isSafeInteger(item.exitCode) ? ` (exit ${item.exitCode})` : "";
    if (typeof item.command !== "string" || item.command.trim() === "") {
      return { contentClass: "tool-summary", text: `Command ${status}${exit}.` };
    }
    const firstLine = item.command.split(/\r?\n/u)[0];
    const head = `$ ${firstLine}${item.command.includes("\n") ? " …" : ""}${tail}${exit}`;
    const lines = [head];
    if (typeof item.description === "string" && item.description.trim()) lines.push(`# ${item.description.trim()}`);
    if (item.command.includes("\n")) lines.push(item.command);
    if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()) {
      lines.push("", preview(item.aggregatedOutput, OUTPUT_PREVIEW_BYTES));
    }
    return { contentClass: "tool-summary", text: lines.join("\n") };
  }
  if (item?.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes.slice(0, 64) : [];
    if (changes.length === 0 || changes.some((change) => typeof change?.path !== "string")) {
      const count = Array.isArray(item.changes) && item.changes.length <= 256
        ? ` (${item.changes.length} ${item.changes.length === 1 ? "change" : "changes"})`
        : "";
      return { contentClass: "change-summary", text: `File change ${status}${count}.` };
    }
    const tool = typeof item.tool === "string" && item.tool ? item.tool : "Edit";
    const lines = changes.map((change) => {
      const counts = changeCounts(change);
      return `${tool} ${change.path}${counts ? ` (${counts})` : ""}`;
    });
    lines[0] += tail;
    if (typeof item.output === "string" && item.output.trim() && status === "failed") {
      lines.push("", preview(item.output, OUTPUT_PREVIEW_BYTES));
    }
    return { contentClass: "change-summary", text: lines.join("\n") };
  }
  if (["mcpToolCall", "dynamicToolCall", "collabToolCall"].includes(item?.type)) {
    if (typeof item.tool !== "string" || item.tool === "") {
      return { contentClass: "tool-summary", text: `Tool call ${status}.` };
    }
    const name = item.tool.startsWith("mcp__") ? item.tool.split("__").slice(1).join(" · ") : item.tool;
    const lines = [`${name}${typeof item.detail === "string" && item.detail ? ` ${item.detail}` : ""}${tail}`];
    if (typeof item.output === "string" && item.output.trim() && (status === "failed" || !["Read"].includes(item.tool))) {
      lines.push("", preview(item.output, status === "failed" ? OUTPUT_PREVIEW_BYTES : 2048));
    }
    return { contentClass: "tool-summary", text: lines.join("\n") };
  }
  return null;
}

/**
 * The agent's questions to the person and the person's answers, as Claude Code
 * keeps them in its transcript ("User answered Claude's questions: · question
 * → answer"): a heading, then "· question" and, when answered, "  → answer".
 * The window knows these headings.
 */
function questionSummary(item) {
  const questions = Array.isArray(item.questions)
    ? item.questions.filter((entry) => typeof entry?.question === "string" && entry.question.trim() !== "")
    : [];
  if (questions.length === 0) return null;
  const answers = Array.isArray(item.answers) && item.answers.length === questions.length ? item.answers : null;
  const status = publicActivityStatus(item.status);
  const line = (value) => String(value).replace(/\s+/gu, " ").trim();
  const lines = [answers !== null ? "You answered the agent's questions:"
    : status === "in progress" ? "The agent asks:" : "The agent's question was left unanswered:"];
  questions.forEach((entry, index) => {
    lines.push(`· ${line(entry.question)}`);
    if (answers !== null) lines.push(`  → ${line(answers[index])}`);
  });
  return lines.join("\n");
}

/**
 * What the person typed. A Claude turn keeps it beside the text Claude Code
 * was sent (`displayText`); a turn recorded before that keeps only the sent
 * text, and the person's part of it follows the last "User task:" line.
 */
function ownerText(item, sent) {
  if (typeof item?.displayText === "string" && item.displayText.trim() !== "") return item.displayText;
  const marker = "\nUser task:\n";
  const at = sent.lastIndexOf(marker);
  return at === -1 ? sent : sent.slice(at + marker.length);
}

function itemContent(provider, turnRef, item, observedAtUtc) {
  const itemRef = providerRef(provider, "provider-item", item?.id);
  if (item?.type === "userMessage") {
    if (!Array.isArray(item.content) || item.content.length === 0) {
      return omitted(provider, itemRef, turnRef, observedAtUtc, "unsupported_content");
    }
    if (item.content.some((part) => ["image", "localImage"].includes(part?.type))) {
      return omitted(provider, itemRef, turnRef, observedAtUtc, "media_bytes");
    }
    if (item.content.some((part) => part?.type !== "text" || typeof part.text !== "string")) {
      return omitted(provider, itemRef, turnRef, observedAtUtc, "unsupported_content");
    }
    return visible(
      provider, itemRef, turnRef, observedAtUtc, "user-message",
      ownerText(item, item.content.map((part) => part.text).join("\n")),
    );
  }
  if (item?.type === "agentMessage") {
    return visible(
      provider, itemRef, turnRef, observedAtUtc, "assistant-message", item.text,
    );
  }
  if (item?.type === "plan") {
    // The agent's plan (TodoWrite): a checklist under the heading the window
    // knows ("Plan"), not a question to the person.
    return visible(
      provider, itemRef, turnRef, observedAtUtc, "tool-summary", `Plan\n${item.text}`,
    );
  }
  if (item?.type === "reasoning" && typeof item.summary === "string" && item.summary.trim() !== "") {
    // Claude Code's own short account of its reasoning ("summarized" thinking):
    // shown folded, under the heading the window knows ("Thinking").
    return visible(
      provider, itemRef, turnRef, observedAtUtc, "tool-summary", `Thinking\n${item.summary.trim()}`,
    );
  }
  if (item?.type === "userQuestion") {
    const text = questionSummary(item);
    return text === null ? omitted(provider, itemRef, turnRef, observedAtUtc, "unsupported_content")
      : visible(provider, itemRef, turnRef, observedAtUtc, "interaction-summary", text);
  }
  if (item?.type === "exitedReviewMode") {
    return visible(
      provider, itemRef, turnRef, observedAtUtc, "interaction-summary", item.review,
    );
  }
  const activity = activitySummary(item);
  if (activity !== null) {
    return visible(
      provider, itemRef, turnRef, observedAtUtc,
      activity.contentClass, activity.text,
    );
  }
  const reason = ({
    reasoning: "hidden_reasoning",
    imageView: "media_bytes",
  })[item?.type] ?? "unsupported_content";
  return omitted(provider, itemRef, turnRef, observedAtUtc, reason);
}

function integer(value) {
  const result = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function providerErrorCode(error) {
  const candidates = [error?.code, error?.cause?.code, error?.details?.code];
  return candidates.find((value) => typeof value === "string" || typeof value === "number")
    ?? null;
}

function normalizeProviderError(operation, error) {
  const code = String(providerErrorCode(error) ?? "");
  if (code === "-32601" || /METHOD_NOT_FOUND|UNSUPPORTED_METHOD/ui.test(code)) {
    return new CodexAppServerConversationReadError(
      "unsupported_provider_method", "Provider read method is unsupported", { operation },
    );
  }
  if (/DISCONNECT|TRANSPORT|PROCESS_EXIT|SOCKET|ECONN|EPIPE/ui.test(code)) {
    return new CodexAppServerConversationReadError(
      "provider_disconnected", "Provider connection is unavailable", { operation },
    );
  }
  return new CodexAppServerConversationReadError(
    "provider_read_failed", "Provider read failed", { operation },
  );
}

export class CodexAppServerConversationReadAdapter {
  #client;
  #descriptor;
  #now;

  // adapterId: the provider runtime whose client this reads. The Claude Code
  // session host presents the same client shape (claude-code-session-host.mjs).
  constructor({ client, descriptor, now = () => new Date(), adapterId = "codex-app-server" } = {}) {
    const validDescriptor = validateAdapterDescriptor(descriptor);
    const assessment = assessProviderConversationReadCapabilities(validDescriptor);
    if (validDescriptor.identity.adapterId !== adapterId || !assessment.compatible) {
      fail("capability_mismatch", "A compatible Codex App Server descriptor is required", {
        failures: assessment.failures,
      });
    }
    for (const method of [
      "listModels", "readAccount", "listThreads", "readThread", "listThreadTurns",
      "readThreadUsage",
    ]) {
      if (typeof client?.[method] !== "function") {
        fail("invalid_client", `Codex App Server client lacks ${method}`);
      }
    }
    if (typeof now !== "function") fail("invalid_client", "A clock function is required");
    this.#client = client;
    this.#descriptor = structuredClone(validDescriptor);
    this.#now = now;
  }

  get descriptor() {
    return structuredClone(this.#descriptor);
  }

  get #provider() {
    return this.#descriptor.identity;
  }

  #envelope(kind, data, observedAtUtc = this.#now().toISOString()) {
    return createProviderConversationReadData({
      kind,
      provider: this.#provider,
      observedAtUtc,
      freshness: { status: "fresh", ageSeconds: 0, staleAfterSeconds: 60 },
      data,
    });
  }

  async #call(operation, action) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CodexAppServerConversationReadError) throw error;
      throw normalizeProviderError(operation, error);
    }
  }

  async listModels(options = {}) {
    const { cursor, limit } = pageOptions(options, ["includeHidden"]);
    const includeHidden = options.includeHidden ?? false;
    if (typeof includeHidden !== "boolean") {
      fail("invalid_request", "includeHidden must be boolean");
    }
    const raw = await this.#call(
      "model/list", () => this.#client.listModels({ cursor, limit, includeHidden }),
    );
    if (!Array.isArray(raw?.data) || raw.data.length > MAX_RECORDS) {
      fail("invalid_provider_payload", "App Server returned an invalid model page");
    }
    const records = raw.data.map((model) => {
      const id = identifier(model?.id ?? model?.model, "model.id");
      const efforts = (model?.supportedReasoningEfforts ?? []).map(
        (item) => typeof item === "string" ? item : item?.reasoningEffort,
      ).filter((item) => typeof item === "string");
      return {
        modelRef: providerRef(this.#provider, "provider-item", id),
        name: String(model?.displayName ?? id).slice(0, 256),
        supportedReasoningEfforts: [...new Set(efforts)],
        defaultReasoningEffort: model?.defaultReasoningEffort ?? null,
      };
    });
    return this.#envelope("model-catalog", {
      records,
      completeness: completeness(raw.nextCursor ?? null),
    });
  }

  async readAuthentication(options = {}) {
    exact(options, [], "authentication read options");
    const raw = await this.#call(
      "account/read", () => this.#client.readAccount({ refreshToken: false }),
    );
    if (typeof raw?.requiresOpenaiAuth !== "boolean"
        || (raw.account !== null
          && (typeof raw.account !== "object" || Array.isArray(raw.account)))) {
      fail("invalid_provider_payload", "App Server returned an invalid account state");
    }
    const status = raw.account !== null
      ? "authenticated" : raw.requiresOpenaiAuth ? "unauthenticated" : "unknown";
    const observedAtUtc = this.#now().toISOString();
    const state = createApplicationAuthenticationState({
      providerId: this.#provider.adapterId,
      providerVersion: this.#provider.adapterVersion,
      runtimeInstanceId: this.#provider.runtimeInstanceId,
      status,
      observedAtUtc,
      capabilities: [
        { capabilityId: "status-observation", support: "supported" },
        { capabilityId: "interactive-login", support: "unsupported" },
        {
          capabilityId: "session-reuse",
          support: status === "authenticated" ? "supported" : "unknown",
        },
        { capabilityId: "logout", support: "unsupported" },
      ],
    });
    return this.#envelope("authentication", { state }, observedAtUtc);
  }

  async listThreads(options = {}) {
    const { cursor, limit } = pageOptions(options, ["archived"]);
    const archived = options.archived ?? false;
    if (typeof archived !== "boolean") fail("invalid_request", "archived must be boolean");
    const raw = await this.#call("thread/list", () => this.#client.listThreads({
      cursor, limit, archived, sortKey: "updated_at", sortDirection: "desc",
    }));
    if (!Array.isArray(raw?.data) || raw.data.length > MAX_RECORDS) {
      fail("invalid_provider_payload", "App Server returned an invalid thread page");
    }
    return this.#envelope("thread-catalog", {
      records: raw.data.map((thread) => threadMetadata(this.#provider, thread, { archived })),
      completeness: completeness(raw.nextCursor ?? null),
    });
  }

  async readThread(options = {}) {
    exact(options, [
      "threadRef", "cursor", "limit", "archived", "includeContent",
    ], "thread read options");
    const { cursor, limit } = pageOptions({
      cursor: options.cursor, limit: options.limit,
    });
    const archived = options.archived ?? false;
    const includeContent = options.includeContent ?? true;
    if (typeof archived !== "boolean" || typeof includeContent !== "boolean") {
      fail("invalid_request", "archived and includeContent must be boolean");
    }
    const threadId = exactProviderRef(
      options.threadRef, this.#provider, "provider-thread", "threadRef",
    );
    const rawThread = await this.#call(
      "thread/read", () => this.#client.readThread(threadId, false),
    );
    if (rawThread === null || rawThread?.thread === null) {
      fail("thread_not_found", "Provider thread was not found");
    }
    if (rawThread?.thread?.id !== threadId) {
      fail("identity_mismatch", "App Server thread read changed native identity");
    }
    if (!includeContent) {
      const observedAtUtc = this.#now().toISOString();
      const threadRead = this.#envelope("thread-read", {
        thread: threadMetadata(this.#provider, rawThread.thread, { archived }),
        turns: [],
        completeness: {
          status: "metadata-only", reasonCode: "turns_not_requested", nextCursor: null,
        },
      }, observedAtUtc);
      return createProviderConversationThreadReadResult({
        provider: this.#provider,
        threadRead,
        content: [],
        contentCompleteness: {
          status: "metadata-only", reasonCode: "content_not_requested", nextCursor: null,
        },
      });
    }

    // A running turn writes its record with every item: a read that met a
    // write is read again a few times before it says the thread moved.
    let startThread = rawThread;
    let rawTurns;
    let finalThread;
    for (let attempt = 1; ; attempt += 1) {
      const initialRevision = threadMetadata(this.#provider, startThread.thread, {
        archived,
      }).updatedAtUtc;
      if (initialRevision === null) {
        fail("provider_revision_unavailable", "Provider thread revision is unavailable");
      }
      rawTurns = await this.#call(
        "thread/turns/list",
        () => this.#client.listThreadTurns(threadId, {
          cursor, limit, sortDirection: "asc", itemsView: "full",
        }),
      );
      if (!Array.isArray(rawTurns?.data) || rawTurns.data.length > MAX_RECORDS) {
        fail("invalid_provider_payload", "App Server returned an invalid turn page");
      }
      finalThread = await this.#call(
        "thread/read", () => this.#client.readThread(threadId, false),
      );
      if (finalThread === null || finalThread?.thread === null) {
        fail("thread_not_found", "Provider thread was not found");
      }
      if (finalThread?.thread?.id !== threadId) {
        fail("identity_mismatch", "App Server thread read changed native identity");
      }
      const finalRevision = threadMetadata(this.#provider, finalThread.thread, {
        archived,
      }).updatedAtUtc;
      if (finalRevision === null) {
        fail("provider_revision_unavailable", "Provider thread revision is unavailable");
      }
      if (finalRevision === initialRevision) break;
      if (attempt >= READ_ATTEMPTS) {
        fail("concurrent_update", "Provider thread changed during the bounded read");
      }
      startThread = finalThread;
    }
    const observedAtUtc = this.#now().toISOString();
    const turns = rawTurns.data.map((turn) => turnMetadata(this.#provider, threadId, turn));
    const content = [];
    rawTurns.data.forEach((turn) => {
      if (turn.items !== undefined && !Array.isArray(turn.items)) {
        fail("invalid_provider_payload", "App Server returned invalid turn items");
      }
    });
    // A page holds at most MAX_CONTENT items: a long turn is shortened to its
    // messages and its last actions, and says what it left out.
    const fitted = fitTurnItems(rawTurns.data.map((turn) => turn.items ?? []), MAX_CONTENT);
    fitted.forEach((items, turnIndex) => {
      const turnRef = turns[turnIndex].turnRef;
      for (const item of items) {
        const at = itemTime(item, rawTurns.data[turnIndex], observedAtUtc);
        content.push(item?.[DROPPED] === true
          ? omitted(this.#provider, providerRef(this.#provider, "provider-item", item.id), turnRef,
            at, "oversized_content")
          : itemContent(this.#provider, turnRef, item, at));
      }
    });
    const pageCompleteness = completeness(rawTurns.nextCursor ?? null);
    const threadRead = this.#envelope("thread-read", {
      thread: threadMetadata(this.#provider, finalThread.thread, {
        archived, hasTurns: rawTurns.data.length > 0,
      }),
      turns,
      completeness: pageCompleteness,
    }, observedAtUtc);
    return createProviderConversationThreadReadResult({
      provider: this.#provider,
      threadRead,
      content,
      contentCompleteness: pageCompleteness,
    });
  }

  async readUsage(options = {}) {
    exact(options, ["threadRef"], "usage read options");
    const threadId = exactProviderRef(
      options.threadRef, this.#provider, "provider-thread", "threadRef",
    );
    let data = null;
    const raw = await this.#call(
      "account/usage/read", () => this.#client.readThreadUsage(threadId),
    );
    const usage = raw?.threadUsage ?? null;
    const groups = Array.isArray(usage?.groups) ? usage.groups : [];
    const totals = groups.map((group) => ({
      input: integer(group?.inputTokens),
      cached: integer(group?.cachedInputTokens),
      output: integer(group?.outputTokens),
      total: integer(group?.totalTokens),
    }));
    const contextWindow = integer(usage?.modelContextWindow ?? raw?.modelContextWindow);
    if (totals.length > 0 && contextWindow !== null && contextWindow > 0
        && totals.every((item) => Object.values(item).every((value) => value !== null))) {
      data = {
        availability: "available",
        threadRef: providerRef(this.#provider, "provider-thread", threadId),
        turnRef: null,
        inputTokens: totals.reduce((sum, item) => sum + item.input, 0),
        cachedInputTokens: totals.reduce((sum, item) => sum + item.cached, 0),
        outputTokens: totals.reduce((sum, item) => sum + item.output, 0),
        reasoningOutputTokens: null,
        totalTokens: totals.reduce((sum, item) => sum + item.total, 0),
        contextWindow,
        measuredAtUtc: this.#now().toISOString(),
      };
    }
    return this.#envelope("usage", data ?? {
      availability: "unavailable",
      threadRef: null,
      turnRef: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      contextWindow: null,
      measuredAtUtc: null,
    });
  }
}

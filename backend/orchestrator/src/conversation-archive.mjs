import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applicationCanonicalSha256 } from "./application-contract.mjs";
import { SqliteControlStore } from "./sqlite-control-store.mjs";
import { PersistentSqliteBridge, persistentSqliteBridgeEnabled } from "./sqlite-bridge-server.mjs";
import { resolveSqliteBackend, sqliteBackendOption } from "./sqlite-backend.mjs";
import { NodeConversationArchiveBridge } from "./conversation-archive-store-node.mjs";
import { resolveProviderMutationProjectId } from "./provider-mutation-lease-store.mjs";
import { openSplitMemoryBridge } from "./project-memory-store.mjs";
import { SplitConversationArchiveBridge } from "./project-memory-split.mjs";

export const CONVERSATION_ARCHIVE_VERSION = "v0.2.0";
export const CONVERSATION_ARCHIVE_IMPLEMENTATION_VERSION = "v0.3.1";
export const CONVERSATION_ARCHIVE_LIMITS = Object.freeze({ textBytes: 262_144, pageItems: 100 });
const BINDING_FIELDS = ["projectId", "sourceId", "providerId", "threadId"];
const RECORD_FIELDS = [
  "recordId", "kind", "role", "state", "text", "providerTurnId", "providerItemId",
  "requestId", "occurredAtUtc", "omissions",
];
const KINDS = new Set(["submission", "message", "activity", "delivery", "interaction", "omission"]);
const STATES = new Set([
  "requested", "accepted", "started", "completed", "failed", "interrupted", "uncertain", "unknown",
]);
const OMISSIONS = new Set([
  "hidden_reasoning", "unsupported_content", "oversized_content", "inline_media",
  "private_content", "content_not_provided", "history_not_imported", "provider_unavailable",
]);

export class ConversationArchiveError extends Error {
  constructor(code) { super(code); this.name = "ConversationArchiveError"; this.code = code; }
}
function fail(code = "archive_invalid_input") { throw new ConversationArchiveError(code); }
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== fields.length
      || fields.some((field) => !Object.hasOwn(value, field))) fail();
}
function id(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function utc(value) {
  if (typeof value !== "string" || value.length > 32 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail();
  return value;
}
function fieldHash(value, fields) {
  // Fixed field order preserves exact text, including non-NFC user input.
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(
    fields.map((field) => [field, value[field]]),
  )), "utf8").digest("hex");
}
export function conversationArchiveIdentity(binding) {
  exact(binding, BINDING_FIELDS);
  BINDING_FIELDS.forEach((field) => id(binding[field]));
  return `conversation:${fieldHash(binding, BINDING_FIELDS)}`;
}
export function validateConversationArchiveRecord(value) {
  exact(value, RECORD_FIELDS);
  id(value.recordId);
  if (!KINDS.has(value.kind) || !STATES.has(value.state)
      || ![null, "user", "assistant", "tool", "system"].includes(value.role)) fail();
  for (const field of ["providerTurnId", "providerItemId", "requestId"]) {
    if (value[field] !== null) id(value[field]);
  }
  if (value.occurredAtUtc !== null) utc(value.occurredAtUtc);
  if (!Array.isArray(value.omissions) || value.omissions.length > OMISSIONS.size
      || value.omissions.some((reason) => !OMISSIONS.has(reason))
      || new Set(value.omissions).size !== value.omissions.length) fail();
  if (value.text !== null && (typeof value.text !== "string"
      || Buffer.byteLength(value.text, "utf8") > CONVERSATION_ARCHIVE_LIMITS.textBytes
      || /data:(?:image|audio|video)\//iu.test(value.text)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text))) fail();
  if (value.kind === "message" && !["user", "assistant", "system"].includes(value.role)) fail();
  if (value.kind === "message" && value.text === null && value.omissions.length === 0) fail();
  if (value.kind === "submission" && (value.role !== "user" || !value.text
      || value.requestId === null || value.state !== "requested")) fail();
  if (value.kind === "activity" && value.role !== "tool") fail();
  if (value.kind === "omission" && (value.text !== null || value.omissions.length === 0)) fail();
  return structuredClone(value);
}

function decodeCursor(cursor, conversationId) {
  if (cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 1024) fail("archive_invalid_cursor");
  let value;
  try { value = JSON.parse(cursor); } catch { fail("archive_invalid_cursor"); }
  try { exact(value, ["schemaVersion", "conversationId", "revision", "after", "sha256"]); }
  catch { fail("archive_invalid_cursor"); }
  const { sha256, ...body } = value;
  if (value.schemaVersion !== 1 || value.conversationId !== conversationId
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isSafeInteger(value.after) || value.after < 0 || value.after > value.revision
      || sha256 !== applicationCanonicalSha256(body)) fail("archive_invalid_cursor");
  return value;
}

function providerCursor(value) {
  if (value !== null && (typeof value !== "string" || !value.length || value.length > 512)) fail();
}

export class ConversationArchive {
  constructor({ store, projectId, now = () => new Date() }) {
    this.store = store;
    this.projectId = id(projectId);
    this.now = now;
  }
  async invoke(command, payload) {
    try { return await this.store.invoke(command, { projectId: this.projectId, ...payload }); }
    catch (error) {
      let code;
      try { code = JSON.parse(error.stderr.trim().split(/\r?\n/).at(-1)).error; } catch {}
      fail(["archive_identity_conflict", "archive_unsupported_schema", "archive_invalid_cursor"]
        .includes(code) ? code : "archive_unavailable");
    }
  }
  binding(value) {
    const conversationId = conversationArchiveIdentity(value);
    if (value.projectId !== this.projectId) fail("archive_identity_conflict");
    return { conversationId, binding: structuredClone(value) };
  }
  /** Ends the archive's bridge process after the calls already sent; with node:sqlite, only later calls fail. */
  async close() {
    if (typeof this.store.close === "function") await this.store.close();
  }
  async append(binding, value) {
    const scope = this.binding(binding);
    const record = validateConversationArchiveRecord(value);
    return this.invoke("append", {
      ...scope, record, contentSha256: fieldHash(record, RECORD_FIELDS),
      observedAtUtc: utc(this.now().toISOString()),
    });
  }
  async readImportCheckpoint(binding) {
    const value = await this.invoke("import-state", this.binding(binding));
    try {
      exact(value, ["revision", "cursor", "exhausted"]);
      providerCursor(value.cursor);
      if (!Number.isSafeInteger(value.revision) || value.revision < 0
          || typeof value.exhausted !== "boolean"
          || (value.revision === 0 && (value.cursor !== null || value.exhausted))
          || (value.revision > 0 && value.exhausted !== (value.cursor === null))) fail();
    } catch { fail("archive_unavailable"); }
    return value;
  }
  async checkpointImport(binding, { expectedRevision, nextCursor }) {
    providerCursor(nextCursor);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || expectedRevision >= Number.MAX_SAFE_INTEGER) fail();
    const swapped = await this.invoke("checkpoint-import", {
      ...this.binding(binding), expectedRevision, nextCursor,
    });
    if (typeof swapped !== "boolean") fail("archive_unavailable");
    return swapped;
  }
  async read(binding, { cursor = null, limit = 50 } = {}) {
    const scope = this.binding(binding);
    if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATION_ARCHIVE_LIMITS.pageItems) fail();
    const position = decodeCursor(cursor, scope.conversationId);
    const page = await this.invoke("read", {
      ...scope, limit, revision: position?.revision ?? null, after: position?.after ?? 0,
    });
    try {
      exact(page, ["revision", "items", "nextAfter"]);
      if (!Number.isSafeInteger(page.revision) || page.revision < 0
          || (position !== null && page.revision !== position.revision)
          || !Array.isArray(page.items) || page.items.length > limit) fail();
      let previous = position?.after ?? 0;
      for (const item of page.items) {
        exact(item, ["firstSequence", "sequence", "contentSha256", "observedAtUtc", "record"]);
        if (!Number.isSafeInteger(item.sequence) || !Number.isSafeInteger(item.firstSequence)
            || item.firstSequence <= previous || item.sequence < item.firstSequence
            || item.sequence > page.revision) fail();
        utc(item.observedAtUtc);
        validateConversationArchiveRecord(item.record);
        if (item.contentSha256 !== fieldHash(item.record, RECORD_FIELDS)) fail();
        previous = item.firstSequence;
      }
      if (page.nextAfter !== null && (page.items.length === 0 || page.nextAfter !== previous)) fail();
    } catch { fail("archive_unavailable"); }
    const body = page.nextAfter === null ? null : {
      schemaVersion: 1, conversationId: scope.conversationId, revision: page.revision, after: page.nextAfter,
    };
    return {
      schemaVersion: 1, contractVersion: CONVERSATION_ARCHIVE_VERSION,
      ...scope, revision: page.revision, coverage: "captured-only", items: page.items,
      nextCursor: body === null ? null : JSON.stringify({ ...body, sha256: applicationCanonicalSha256(body) }),
    };
  }
}

/**
 * `sqliteBackend` ("node" | "python") overrides AGENTS_FACTORY_SQLITE and the
 * default: node:sqlite in this process when the runtime has it, else the
 * Python bridge (`bridgePath`, `pythonCommand`).
 */
export async function createConversationArchive({
  controllerRoot, projectId, now, pythonCommand, bridgePath, sqliteBackend,
}) {
  id(projectId);
  try { sqliteBackendOption(sqliteBackend); } catch { fail(); }
  const root = await realpath(controllerRoot);
  if (await resolveProviderMutationProjectId(root) !== projectId) fail("archive_identity_conflict");
  let split;
  try { split = await openSplitMemoryBridge(root, sqliteBackend); } catch { fail("archive_unavailable"); }
  if (split !== null) {
    // One archive per project beside its memory (project-memory-split.mjs).
    const { sqlite } = await resolveSqliteBackend({ backend: "node" });
    const archive = new ConversationArchive({ projectId, now,
      store: new SplitConversationArchiveBridge({ controllerRoot: root, sqlite, memory: split }) });
    Object.defineProperty(archive, "sqliteBackend", { value: "node" });
    await archive.invoke("init", {});
    return archive;
  }
  const directory = path.join(root, ".project-local", "orchestration", "conversation-archive");
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  const relative = path.relative(root, canonical);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fail("archive_identity_conflict");
  }
  const databasePath = path.join(canonical, "archive.v1.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    const info = await lstat(`${databasePath}${suffix}`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (info !== null && (!info.isFile() || info.isSymbolicLink())) fail("archive_identity_conflict");
  }
  const { backend, sqlite } = await resolveSqliteBackend({ backend: sqliteBackend });
  const script = bridgePath ?? fileURLToPath(new URL("conversation-archive-store.py", import.meta.url));
  const archive = new ConversationArchive({
    projectId, now,
    // In this process with node:sqlite; else one long-lived Python bridge
    // (sqlite-bridge-server.mjs), as for project memory.
    store: backend === "node"
      ? new NodeConversationArchiveBridge({ databasePath, sqlite })
      : persistentSqliteBridgeEnabled()
        ? new PersistentSqliteBridge({ databasePath, pythonCommand, bridgePath: script,
          unavailableCode: "archive_unavailable" })
        : new SqliteControlStore({ databasePath, pythonCommand, bridgePath: script }),
  });
  Object.defineProperty(archive, "sqliteBackend", { value: backend });
  await archive.invoke("init", {});
  return archive;
}

import path from "node:path";

import { NodeSqliteConnection } from "./sqlite-node-connection.mjs";
import {
  PythonError, isDict, jsonTransport, pyEquals, pyItem, pyTypeName, pythonJson, sortedTransport, utf8,
} from "./sqlite-python-compat.mjs";

// conversation-archive-store.py on node:sqlite, in the calling process: the
// same schema and migration, one connection and transaction per request, the
// same PRAGMAs (no journal mode: the archive keeps SQLite's rollback journal),
// the same stored JSON and page byte budget, the same error codes and results.

class ArchiveFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ArchiveFailure(code);
}

const encoded = (value) => pythonJson(value, { sortKeys: true });

function loads(text) {
  if (typeof text !== "string") throw new PythonError("TypeError", "the JSON object must be str, bytes or bytearray");
  return JSON.parse(text);
}

function initialize(db, projectId) {
  const version = db.value("PRAGMA user_version");
  if (![0, 1, 2].includes(version)) fail("archive_unsupported_schema");
  if (version === 0) {
    if (db.get("SELECT name FROM sqlite_master WHERE type='table'") !== null) fail("archive_unsupported_schema");
    db.exec("CREATE TABLE archive_meta (project_id TEXT NOT NULL)");
    db.run("INSERT INTO archive_meta VALUES (?)", [projectId]);
    db.exec(`CREATE TABLE conversations (
            id TEXT PRIMARY KEY, binding TEXT NOT NULL)`);
    db.exec(`CREATE TABLE entries (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            record_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
            observed_at_utc TEXT NOT NULL, record TEXT NOT NULL)`);
    db.exec("CREATE INDEX entries_conversation ON entries(conversation_id, record_id, sequence)");
    db.exec("PRAGMA user_version=1");
  }
  const row = db.get("SELECT project_id FROM archive_meta");
  if (row === null || !pyEquals(row.project_id, projectId)) fail("archive_identity_conflict");
  if (version < 2) {
    db.exec(`CREATE TABLE import_checkpoints (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
            revision INTEGER NOT NULL, cursor TEXT, exhausted INTEGER NOT NULL)`);
    db.exec("PRAGMA user_version=2");
  }
}

function checkScope(db, payload, create = false) {
  const identity = pyItem(payload, "conversationId");
  const binding = pyItem(payload, "binding");
  if (!pyEquals(pyItem(binding, "projectId"), pyItem(payload, "projectId"))) fail("archive_identity_conflict");
  const serialized = encoded(binding);
  const row = db.get("SELECT binding FROM conversations WHERE id=?", [identity]);
  if (row !== null && row.binding !== serialized) fail("archive_identity_conflict");
  if (row === null && create) db.run("INSERT INTO conversations VALUES (?,?)", [identity, serialized]);
  return identity;
}

function append(db, payload) {
  const identity = checkScope(db, payload, true);
  const record = pyItem(payload, "record");
  const latest = db.get(`SELECT sequence, content_sha256, record FROM entries
        WHERE conversation_id=? AND record_id=? ORDER BY sequence DESC LIMIT 1`,
  [identity, pyItem(record, "recordId")]);
  if (latest !== null && pyEquals(latest.content_sha256, pyItem(payload, "contentSha256"))) {
    return { conversationId: identity, sequence: latest.sequence, replay: true, contentSha256: latest.content_sha256 };
  }
  if (latest !== null && (pyEquals(pyItem(record, "kind"), "submission")
      || pyEquals(pyItem(loads(latest.record), "kind"), "submission"))) {
    fail("archive_identity_conflict");
  }
  const inserted = db.run(`INSERT INTO entries
        (conversation_id,record_id,content_sha256,observed_at_utc,record)
        VALUES (?,?,?,?,?)`, [identity, record.recordId, pyItem(payload, "contentSha256"),
    pyItem(payload, "observedAtUtc"), encoded(record)]);
  return { conversationId: identity, sequence: inserted.lastInsertRowid, replay: false,
    contentSha256: payload.contentSha256 };
}

function comparable(value) {
  if (typeof value === "boolean") return Number(value);
  if (typeof value !== "number") {
    throw new PythonError("TypeError", `'>' not supported between instances of '${pyTypeName(value)}' and 'int'`);
  }
  return value;
}

function readPage(db, payload) {
  const identity = checkScope(db, payload);
  const current = db.value("SELECT COALESCE(MAX(sequence),0) AS current FROM entries WHERE conversation_id=?",
    [identity]);
  const requested = pyItem(payload, "revision");
  const revision = requested !== null ? requested : current;
  if (comparable(revision) > current || comparable(revision) < 0 || comparable(pyItem(payload, "after")) > revision) {
    fail("archive_invalid_cursor");
  }
  const limit = comparable(pyItem(payload, "limit"));
  const rows = db.all(`WITH versions AS (
        SELECT record_id, MIN(sequence) AS first_sequence, MAX(sequence) AS latest
        FROM entries WHERE conversation_id=? AND sequence<=? GROUP BY record_id)
        SELECT versions.first_sequence, entries.sequence, entries.content_sha256,
               entries.observed_at_utc, entries.record
        FROM versions JOIN entries ON entries.sequence=versions.latest
        WHERE versions.first_sequence>? ORDER BY versions.first_sequence LIMIT ?`,
  [identity, revision, payload.after, limit + 1]);
  if (!Number.isInteger(limit)) {
    throw new PythonError("TypeError", "slice indices must be integers or None or have an __index__ method");
  }
  const items = [];
  let size = 0;
  for (const row of rows.slice(0, limit < 0 ? Math.max(rows.length + limit, 0) : limit)) {
    const item = { firstSequence: row.first_sequence, sequence: row.sequence, contentSha256: row.content_sha256,
      observedAtUtc: row.observed_at_utc, record: loads(row.record) };
    const itemSize = utf8(encoded(item)).length;
    if (items.length > 0 && size + itemSize > 524288) break;
    items.push(item);
    size += itemSize;
  }
  return { revision, items, nextAfter: rows.length > items.length ? items.at(-1).firstSequence : null };
}

function importState(db, payload) {
  const identity = checkScope(db, payload);
  const row = db.get("SELECT revision,cursor,exhausted FROM import_checkpoints WHERE conversation_id=?", [identity]);
  return row !== null
    ? { revision: row.revision, cursor: row.cursor, exhausted: Boolean(row.exhausted) }
    : { revision: 0, cursor: null, exhausted: false };
}

function checkpointImport(db, payload) {
  const current = importState(db, payload);
  if (!pyEquals(current.revision, pyItem(payload, "expectedRevision"))) return false;
  const identity = checkScope(db, payload, true);
  const nextCursor = pyItem(payload, "nextCursor");
  db.run(`INSERT INTO import_checkpoints VALUES (?,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET
        revision=excluded.revision,cursor=excluded.cursor,exhausted=excluded.exhausted`,
  [identity, current.revision + 1, nextCursor, nextCursor === null]);
  return true;
}

/**
 * Rows of a project package into a new archive (project-package-import.mjs),
 * stored exactly as append and checkpoint-import store them, sequences kept.
 * Node only; not reachable through ConversationArchive or the Gateway.
 */
const IMPORT_ROWS = {
  conversations: (db, row) => db.run("INSERT INTO conversations VALUES (?,?)", [row.conversationId, encoded(row.binding)]),
  entries: (db, row) => db.run(`INSERT INTO entries
        (sequence,conversation_id,record_id,content_sha256,observed_at_utc,record) VALUES (?,?,?,?,?,?)`,
  [row.sequence, row.conversationId, row.recordId, row.contentSha256, row.observedAtUtc, encoded(row.record)]),
  checkpoints: (db, row) => db.run("INSERT INTO import_checkpoints VALUES (?,?,?,?)",
    [row.conversationId, row.revision, row.cursor, row.exhausted]),
};

function importRows(db, payload) {
  const insert = IMPORT_ROWS[pyItem(payload, "table")];
  const rows = pyItem(payload, "rows");
  if (insert === undefined || !Array.isArray(rows) || rows.some((row) => !isDict(row))) fail("archive_invalid_input");
  try {
    for (const row of rows) insert(db, row);
  } catch (error) {
    if (/constraint/iu.test(String(error?.message))) fail("archive_identity_conflict");
    throw error;
  }
  return { schemaVersion: 1, imported: rows.length };
}

const COMMANDS = new Set(["init", "append", "read", "import-state", "checkpoint-import", "import-rows"]);
const OPERATIONS = { append, read: readPage, "import-state": importState, "checkpoint-import": checkpointImport,
  "import-rows": importRows };
const MAX_PAYLOAD_BYTES = 2097152;

/** One command in its own connection and transaction; an error rolls it back. */
function run(sqlite, database, command, payload) {
  if (!COMMANDS.has(command) || !isDict(payload)) fail("archive_invalid_input");
  const db = new NodeSqliteConnection(sqlite, database, { timeoutMs: 10_000 });
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA synchronous=FULL");
    db.exec(command === "read" || command === "import-state" ? "BEGIN" : "BEGIN IMMEDIATE");
    let result;
    try {
      if (command === "init") {
        initialize(db, pyItem(payload, "projectId"));
        result = { schemaVersion: 1, ready: true };
      } else {
        if (db.value("PRAGMA user_version") !== 2) fail("archive_unsupported_schema");
        const meta = db.get("SELECT project_id FROM archive_meta");
        if (meta === null) throw new PythonError("TypeError", "'NoneType' object is not subscriptable");
        if (!pyEquals(meta.project_id, pyItem(payload, "projectId"))) fail("archive_identity_conflict");
        result = OPERATIONS[command](db, payload);
      }
    } catch (error) {
      db.rollback();
      throw error;
    }
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}

function errorCode(error) {
  return error instanceof ArchiveFailure ? error.code : "archive_unavailable";
}

function bridgeFailure(command, code, detail = "") {
  const error = new Error(`SQLite bridge '${command}' failed: ${code}${detail ? ` (${detail})` : ""}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}\n`;
  return error;
}

/**
 * The conversation archive's `invoke` in this process. Answers and failures
 * have the shape the Python bridge gave them (sqlite-bridge-server.mjs).
 */
export class NodeConversationArchiveBridge {
  #closed = false;

  constructor({ databasePath, sqlite }) {
    if (!databasePath || typeof sqlite?.DatabaseSync !== "function") {
      throw new Error("NodeConversationArchiveBridge requires databasePath and node:sqlite");
    }
    this.databasePath = path.resolve(databasePath);
    this.sqlite = sqlite;
    this.sqliteBackend = "node";
  }

  async invoke(command, payload = {}) {
    if (this.#closed) throw bridgeFailure(command, "archive_unavailable", "closed");
    let result;
    try {
      // The bridge read the payload as one JSON line of at most this many bytes.
      const request = jsonTransport(payload);
      if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > MAX_PAYLOAD_BYTES) fail("archive_invalid_input");
      result = run(this.sqlite, this.databasePath, command, request);
    } catch (error) {
      throw bridgeFailure(command, errorCode(error));
    }
    return sortedTransport(result);
  }

  /** Nothing stays open between requests; later calls fail as after the bridge closed. */
  async close() {
    this.#closed = true;
  }
}

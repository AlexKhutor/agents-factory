import path from "node:path";

import { NodeSqliteConnection, isIntegrityError } from "./sqlite-node-connection.mjs";
import {
  PythonError, isDict, isPythonInputError, jsonTransport, pyEquals, pyHashKey, pyIsInt, pyItem, pyIter,
  pyTypeName, pythonJson, sha256Hex, sortedTransport,
} from "./sqlite-python-compat.mjs";

// project-memory-store.py on node:sqlite, in the calling process. Every command
// keeps the Python bridge's meaning: the same schema and migration, one
// connection and one transaction per request, the same PRAGMAs and busy
// timeout, the same hashes of the same canonical JSON, the same error codes and
// result shapes. A database either implementation wrote is read and changed by
// the other; both may use one file at the same time.

class MemoryFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new MemoryFailure(code);
}

const TABLES = ["memory_documents", "memory_operations", "memory_revisions", "memory_scopes", "memory_write_grants"];
// Version 2 adds the agent scope: an agent's own memory, beside the project
// and the quarter it belongs to.
const SCHEMA_VERSION = 2;

const scopesTable = (name) => `CREATE TABLE ${name} (
        scope_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('project','quarter','agent')),
        project_id TEXT NOT NULL,
        quarter_id TEXT,
        title TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        CHECK ((kind='project' AND quarter_id IS NULL)
            OR (kind IN ('quarter','agent') AND quarter_id IS NOT NULL)))`;

const SCOPE_COLUMNS = "scope_id,kind,project_id,quarter_id,title,current_revision";

const encoded = (value) => pythonJson(value, { sortKeys: true });
const valueSha256 = (value) => sha256Hex(encoded(value));

function decodedStored(value) {
  try {
    if (typeof value !== "string") throw new TypeError("not text");
    return JSON.parse(value);
  } catch {
    return fail("memory_identity_conflict");
  }
}

function presentTables(db) {
  return new Set(db.all("SELECT name FROM sqlite_master "
    + "WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((row) => row.name));
}

function scopeIndexes(db) {
  db.exec(`CREATE UNIQUE INDEX one_project_memory_scope
        ON memory_scopes(project_id) WHERE kind='project'`);
  db.exec(`CREATE UNIQUE INDEX one_quarter_memory_scope
        ON memory_scopes(project_id,quarter_id) WHERE kind='quarter'`);
}

function migrateV1(db) {
  // SQLite cannot change a CHECK constraint in place: the scope table is
  // rebuilt with the same rows. Foreign keys are off for this connection
  // (see run), and are verified before the transaction commits.
  db.exec(scopesTable("memory_scopes_v2"));
  db.exec(`INSERT INTO memory_scopes_v2 SELECT ${SCOPE_COLUMNS} FROM memory_scopes`);
  db.exec("DROP TABLE memory_scopes");
  db.exec("ALTER TABLE memory_scopes_v2 RENAME TO memory_scopes");
  scopeIndexes(db);
  if (db.get("PRAGMA foreign_key_check") !== null) fail("memory_unsupported_schema");
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
}

function initialize(db) {
  const version = db.value("PRAGMA user_version");
  if (![0, 1, SCHEMA_VERSION].includes(version)) fail("memory_unsupported_schema");
  if (version === 1 || version === SCHEMA_VERSION) {
    const present = presentTables(db);
    if (present.size !== TABLES.length || TABLES.some((name) => !present.has(name))) {
      fail("memory_unsupported_schema");
    }
    if (version === 1) migrateV1(db);
    return;
  }
  const existing = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (existing !== null) fail("memory_unsupported_schema");
  db.exec(scopesTable("memory_scopes"));
  scopeIndexes(db);
  db.exec(`CREATE TABLE memory_revisions (
        scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        content_sha256 TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        author TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        PRIMARY KEY (scope_id,revision))`);
  db.exec(`CREATE TABLE memory_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','write')),
        request_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL)`);
  db.exec(`CREATE TABLE memory_write_grants (
        command_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
        expected_revision INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        authorized_at_utc TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        consumed_operation_id TEXT UNIQUE,
        consumed_at_utc TEXT)`);
  db.exec(`CREATE TABLE memory_documents (
        key TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        value_json TEXT NOT NULL)`);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
}

function verifyHash(payload, fields) {
  const expected = valueSha256(Object.fromEntries(fields.map((field) => [field, pyItem(payload, field)])));
  if (!pyEquals(payload.requestSha256 ?? null, expected)) fail("memory_invalid_input");
}

function operationReplay(db, operationId, kind, requestSha256) {
  const row = db.get("SELECT operation_kind,request_sha256,result_json FROM memory_operations WHERE operation_id=?",
    [operationId]);
  if (row === null) return null;
  if (!pyEquals(row.operation_kind, kind) || !pyEquals(row.request_sha256, requestSha256)) {
    fail("memory_operation_conflict");
  }
  return decodedStored(row.result_json);
}

function scopeRecord(db, scopeId) {
  const row = db.get(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE scope_id=?`, [scopeId]);
  if (row === null) fail("memory_scope_not_found");
  return row;
}

function scopeDto(db, scope, requestedRevision = null) {
  const selected = requestedRevision === null ? scope.current_revision : requestedRevision;
  const row = db.get("SELECT content_sha256,entries_json,author,updated_at_utc "
    + "FROM memory_revisions WHERE scope_id=? AND revision=?", [scope.scope_id, selected]);
  if (row === null) fail("memory_revision_not_found");
  const entries = decodedStored(row.entries_json);
  if (!pyEquals(valueSha256(entries), row.content_sha256)) fail("memory_identity_conflict");
  return {
    schemaVersion: 1,
    scopeId: scope.scope_id,
    kind: scope.kind,
    projectId: scope.project_id,
    quarterId: scope.quarter_id,
    title: scope.title,
    revision: selected,
    sha256: row.content_sha256,
    entries,
    author: row.author,
    updatedAtUtc: row.updated_at_utc,
  };
}

function scopeMetadata(dto) {
  const { entries: _entries, ...metadata } = dto;
  return metadata;
}

function createScope(db, payload) {
  verifyHash(payload, ["scopeId", "kind", "projectId", "quarterId", "title", "operationId"]);
  const replay = operationReplay(db, pyItem(payload, "operationId"), "create", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  if (!pyEquals(pyItem(payload, "contentSha256"), valueSha256([]))) fail("memory_invalid_input");
  if (db.get("SELECT 1 AS present FROM memory_scopes WHERE scope_id=?", [payload.scopeId]) !== null) {
    fail("memory_scope_conflict");
  }
  let logical;
  if (pyEquals(payload.kind, "project")) {
    logical = db.get("SELECT 1 AS present FROM memory_scopes WHERE kind='project' AND project_id=?",
      [payload.projectId]);
  } else if (pyEquals(payload.kind, "agent")) {
    // An agent's memory belongs to an existing quarter; its own identity is
    // the scope ID, which the service derives from the agent ID.
    if (db.get("SELECT 1 AS present FROM memory_scopes WHERE kind='quarter' AND project_id=? AND quarter_id=?",
      [payload.projectId, payload.quarterId]) === null) fail("memory_scope_not_found");
    logical = null;
  } else {
    const parent = db.get("SELECT 1 AS present FROM memory_scopes WHERE kind='project' AND project_id=?",
      [payload.projectId]);
    if (parent === null) fail("memory_project_scope_required");
    logical = db.get("SELECT 1 AS present FROM memory_scopes WHERE kind='quarter' AND project_id=? AND quarter_id=?",
      [payload.projectId, payload.quarterId]);
  }
  if (logical !== null) fail("memory_scope_conflict");
  try {
    db.run("INSERT INTO memory_scopes VALUES (?,?,?,?,?,1)",
      [payload.scopeId, payload.kind, payload.projectId, payload.quarterId, payload.title]);
    db.run("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
      [payload.scopeId, 1, pyItem(payload, "contentSha256"), encoded([]), "system", pyItem(payload, "updatedAtUtc")]);
  } catch (error) {
    if (isIntegrityError(error)) fail("memory_scope_conflict");
    throw error;
  }
  const result = scopeDto(db, scopeRecord(db, payload.scopeId));
  db.run("INSERT INTO memory_operations VALUES (?,?,?,?)",
    [payload.operationId, "create", payload.requestSha256, encoded(result)]);
  return result;
}

function pySet(value) {
  return new Set(pyIter(value).map(pyHashKey));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function dictValues(value) {
  if (!isDict(value)) throw new PythonError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'values'`);
  return Object.values(value);
}

const COPY_FIELDS = ["sourceProjectId", "targetProjectId", "targetProjectScopeId", "quarterScopeIds", "operationId"];

function copyProject(db, payload) {
  verifyHash(payload, COPY_FIELDS);
  if (pyEquals(payload.sourceProjectId, payload.targetProjectId)) fail("memory_invalid_input");
  const replay = operationReplay(db, payload.operationId, "create", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  const rows = db.all(`SELECT ${SCOPE_COLUMNS} `
    + "FROM memory_scopes WHERE project_id=? AND kind IN ('project','quarter') ORDER BY "
    + "CASE kind WHEN 'project' THEN 0 ELSE 1 END, quarter_id,scope_id LIMIT 513", [payload.sourceProjectId]);
  return copyRows(db, payload, rows.map((row) => ({ row, source: () => scopeDto(db, row) })));
}

/**
 * The split layout's project copy (project-memory-split.mjs): the source
 * project lives in another database, so its scopes come in the payload, read
 * there in the order copy-project reads them. Node only (R22).
 */
function copyProjectFrom(db, payload) {
  verifyHash(payload, COPY_FIELDS);
  if (pyEquals(payload.sourceProjectId, payload.targetProjectId)) fail("memory_invalid_input");
  const replay = operationReplay(db, payload.operationId, "create", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  const sources = pyItem(payload, "sources");
  if (!Array.isArray(sources) || sources.length > 513) fail("memory_invalid_input");
  return copyRows(db, payload, sources.map((source) => {
    if (!isDict(source) || !["project", "quarter"].includes(source.kind)
        || !pyEquals(source.projectId, payload.sourceProjectId)
        || !pyEquals(valueSha256(source.entries), source.sha256)) fail("memory_invalid_input");
    return { row: { scope_id: source.scopeId, kind: source.kind, quarter_id: source.quarterId, title: source.title },
      source: () => source };
  }));
}

function copyRows(db, payload, rows) {
  if (rows.length === 0 || rows[0].row.kind !== "project") fail("memory_project_scope_required");
  if (rows.length > 512 || rows.filter(({ row }) => row.kind === "project").length !== 1) fail("memory_limit_exceeded");
  if (db.get("SELECT 1 AS present FROM memory_scopes WHERE project_id=? LIMIT 1", [payload.targetProjectId]) !== null) {
    fail("memory_scope_conflict");
  }
  const expectedQuarters = new Set(rows.filter(({ row }) => row.kind === "quarter").map(({ row }) => pyHashKey(row.quarter_id)));
  if (!sameSet(pySet(payload.quarterScopeIds), expectedQuarters)) fail("memory_invalid_input");
  const targets = [payload.targetProjectScopeId, ...dictValues(payload.quarterScopeIds)];
  if (new Set(targets.map(pyHashKey)).size !== targets.length) fail("memory_invalid_input");
  for (const target of targets) {
    if (db.get("SELECT 1 AS present FROM memory_scopes WHERE scope_id=?", [target]) !== null) {
      fail("memory_scope_conflict");
    }
  }
  const copied = [];
  for (const { row, source: read } of rows) {
    const source = read();
    const target = row.kind === "project" ? payload.targetProjectScopeId : pyItem(payload.quarterScopeIds, row.quarter_id);
    db.run("INSERT INTO memory_scopes VALUES (?,?,?,?,?,1)",
      [target, row.kind, payload.targetProjectId, row.quarter_id, row.title]);
    db.run("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
      [target, 1, source.sha256, encoded(source.entries), "system", pyItem(payload, "copiedAtUtc")]);
    copied.push({
      sourceScopeId: row.scope_id, targetScopeId: target,
      kind: row.kind, quarterId: row.quarter_id,
      sourceRevision: source.revision, sourceSha256: source.sha256,
      targetRevision: 1, targetSha256: source.sha256,
    });
  }
  const result = {
    schemaVersion: 1, outcome: "complete",
    sourceProjectId: payload.sourceProjectId,
    targetProjectId: payload.targetProjectId,
    operationId: payload.operationId, scopes: copied,
    copiedAtUtc: payload.copiedAtUtc,
  };
  db.run("INSERT INTO memory_operations VALUES (?,?,?,?)",
    [payload.operationId, "create", payload.requestSha256, encoded(result)]);
  return result;
}

function readScope(db, payload) {
  return scopeDto(db, scopeRecord(db, pyItem(payload, "scopeId")), pyItem(payload, "revision"));
}

function pyIntOperand(value) {
  if (typeof value === "boolean") return Number(value);
  if (typeof value !== "number") {
    throw new PythonError("TypeError", `unsupported operand type(s) for +: '${pyTypeName(value)}' and 'int'`);
  }
  return value;
}

function listScopes(db, payload) {
  const parameters = [];
  // Agents' own memories are read through their agents, not listed here.
  let where = "WHERE kind IN ('project','quarter')";
  if (pyItem(payload, "projectId") !== null) {
    where += " AND project_id=?";
    parameters.push(payload.projectId);
  }
  const limit = pyItem(payload, "limit");
  parameters.push(pyIntOperand(limit) + 1);
  const rows = db.all(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes ${where} `
    + "ORDER BY project_id, CASE kind WHEN 'project' THEN 0 ELSE 1 END, quarter_id, scope_id LIMIT ?", parameters);
  if (!pyIsInt(limit) && typeof limit !== "boolean") {
    throw new PythonError("TypeError", "slice indices must be integers or None or have an __index__ method");
  }
  const end = Number(limit);
  const visible = rows.slice(0, end < 0 ? Math.max(rows.length + end, 0) : end);
  return {
    schemaVersion: 1,
    scopes: visible.map((row) => scopeMetadata(scopeDto(db, row))),
    truncated: rows.length > visible.length,
  };
}

function authorizeWrite(db, payload) {
  verifyHash(payload, ["commandId", "scopeId", "expectedRevision", "contentSha256", "requestedBy"]);
  const row = db.get("SELECT request_sha256,result_json FROM memory_write_grants WHERE command_id=?",
    [payload.commandId]);
  if (row !== null) {
    if (!pyEquals(row.request_sha256, pyItem(payload, "requestSha256"))) fail("memory_command_conflict");
    return decodedStored(row.result_json);
  }
  const scope = scopeRecord(db, payload.scopeId);
  if (!pyEquals(scope.current_revision, payload.expectedRevision)) fail("memory_revision_conflict");
  const result = {
    schemaVersion: 1,
    commandId: payload.commandId,
    scopeId: payload.scopeId,
    expectedRevision: payload.expectedRevision,
    contentSha256: payload.contentSha256,
    requestedBy: payload.requestedBy,
    authorizedAtUtc: pyItem(payload, "authorizedAtUtc"),
  };
  db.run("INSERT INTO memory_write_grants "
    + "(command_id,scope_id,expected_revision,content_sha256,requested_by,"
    + "authorized_at_utc,request_sha256,result_json) VALUES (?,?,?,?,?,?,?,?)", [
    payload.commandId, payload.scopeId, payload.expectedRevision,
    payload.contentSha256, payload.requestedBy, payload.authorizedAtUtc,
    pyItem(payload, "requestSha256"), encoded(result),
  ]);
  return result;
}

function writeScope(db, payload) {
  verifyHash(payload, ["scopeId", "expectedRevision", "entries", "operationId", "commandId", "actorId"]);
  if (!pyEquals(valueSha256(payload.entries), pyItem(payload, "contentSha256"))) fail("memory_invalid_input");
  const replay = operationReplay(db, payload.operationId, "write", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  const grant = db.get("SELECT scope_id,expected_revision,content_sha256,consumed_operation_id "
    + "FROM memory_write_grants WHERE command_id=?", [payload.commandId]);
  if (grant === null) fail("memory_authorization_required");
  if (!pyEquals(grant.scope_id, payload.scopeId)
      || !pyEquals(grant.expected_revision, payload.expectedRevision)
      || !pyEquals(grant.content_sha256, payload.contentSha256)) {
    fail("memory_authorization_mismatch");
  }
  if (grant.consumed_operation_id !== null) fail("memory_authorization_consumed");
  const scope = scopeRecord(db, payload.scopeId);
  if (!pyEquals(scope.current_revision, payload.expectedRevision)) fail("memory_revision_conflict");
  const nextRevision = pyIntOperand(payload.expectedRevision) + 1;
  try {
    db.run("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)", [
      payload.scopeId, nextRevision, payload.contentSha256,
      encoded(payload.entries), payload.actorId, pyItem(payload, "updatedAtUtc"),
    ]);
    const updated = db.run("UPDATE memory_scopes SET current_revision=? WHERE scope_id=? AND current_revision=?",
      [nextRevision, payload.scopeId, payload.expectedRevision]);
    if (updated.changes !== 1) fail("memory_revision_conflict");
    const consumed = db.run("UPDATE memory_write_grants SET consumed_operation_id=?,consumed_at_utc=? "
      + "WHERE command_id=? AND consumed_operation_id IS NULL",
    [payload.operationId, payload.updatedAtUtc, payload.commandId]);
    if (consumed.changes !== 1) fail("memory_authorization_consumed");
  } catch (error) {
    if (isIntegrityError(error)) fail("memory_revision_conflict");
    throw error;
  }
  const result = {
    schemaVersion: 1,
    operationId: payload.operationId,
    commandId: payload.commandId,
    scopeId: payload.scopeId,
    previousRevision: payload.expectedRevision,
    revision: nextRevision,
    sha256: payload.contentSha256,
    // actorId is attribution only; the consumed control grant is write authority.
    author: payload.actorId,
    updatedAtUtc: payload.updatedAtUtc,
  };
  db.run("INSERT INTO memory_operations VALUES (?,?,?,?)",
    [payload.operationId, "write", payload.requestSha256, encoded(result)]);
  return result;
}

function readPair(db, payload) {
  const project = db.get(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE kind='project' AND project_id=?`,
    [pyItem(payload, "projectId")]);
  const quarter = db.get(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE kind='quarter' AND project_id=? AND quarter_id=?`,
    [payload.projectId, pyItem(payload, "quarterId")]);
  if (project === null || quarter === null) fail("memory_scope_not_found");
  return { project: scopeDto(db, project), quarter: scopeDto(db, quarter) };
}

function readScopeSet(db, payload) {
  const scopeIds = pyItem(payload, "scopeIds");
  if (!Array.isArray(scopeIds) || scopeIds.length > 128) fail("memory_invalid_input");
  const scopes = [];
  for (const scopeId of scopeIds) {
    const row = db.get(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE scope_id=?`, [scopeId]);
    if (row !== null) scopes.push(scopeDto(db, row));
  }
  return { schemaVersion: 1, scopes };
}

function readDocument(db, payload) {
  const row = db.get("SELECT revision,value_json FROM memory_documents WHERE key=?", [pyItem(payload, "key")]);
  if (row === null) return null;
  return { revision: row.revision, value: decodedStored(row.value_json) };
}

function compareAndSwapDocument(db, payload) {
  const row = db.get("SELECT revision FROM memory_documents WHERE key=?", [pyItem(payload, "key")]);
  const current = row === null ? 0 : row.revision;
  if (!pyEquals(current, pyItem(payload, "expectedRevision"))) return false;
  const nextRevision = current + 1;
  const serialized = encoded(pyItem(payload, "value"));
  if (row === null) {
    db.run("INSERT INTO memory_documents VALUES (?,?,?)", [payload.key, nextRevision, serialized]);
  } else {
    const updated = db.run("UPDATE memory_documents SET revision=?,value_json=? WHERE key=? AND revision=?",
      [nextRevision, serialized, payload.key, current]);
    if (updated.changes !== 1) return false;
  }
  return true;
}

/**
 * Rows of a project package into a new database (project-package-import.mjs),
 * stored exactly as the commands above store them. Node only; not reachable
 * through ProjectMemoryStore or the Gateway.
 */
const IMPORT_ROWS = {
  scopes: (db, row) => db.run("INSERT INTO memory_scopes VALUES (?,?,?,?,?,?)",
    [row.scopeId, row.kind, row.projectId, row.quarterId, row.title, row.currentRevision]),
  revisions: (db, row) => {
    if (!pyEquals(valueSha256(row.entries), row.contentSha256)) fail("memory_identity_conflict");
    db.run("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
      [row.scopeId, row.revision, row.contentSha256, encoded(row.entries), row.author, row.updatedAtUtc]);
  },
  operations: (db, row) => db.run("INSERT INTO memory_operations VALUES (?,?,?,?)",
    [row.operationId, row.operationKind, row.requestSha256, encoded(row.result)]),
  grants: (db, row) => db.run("INSERT INTO memory_write_grants VALUES (?,?,?,?,?,?,?,?,?,?)",
    [row.commandId, row.scopeId, row.expectedRevision, row.contentSha256, row.requestedBy, row.authorizedAtUtc,
      row.requestSha256, encoded(row.result), row.consumedOperationId, row.consumedAtUtc]),
  documents: (db, row) => db.run("INSERT INTO memory_documents VALUES (?,?,?)",
    [row.key, row.revision, encoded(row.value)]),
};

function importRows(db, payload) {
  const insert = IMPORT_ROWS[pyItem(payload, "table")];
  const rows = pyItem(payload, "rows");
  if (insert === undefined || !Array.isArray(rows) || rows.some((row) => !isDict(row))) fail("memory_invalid_input");
  try {
    for (const row of rows) insert(db, row);
  } catch (error) {
    if (isIntegrityError(error)) fail("memory_identity_conflict");
    throw error;
  }
  return { schemaVersion: 1, imported: rows.length };
}

const READ_COMMANDS = new Set(["read-scope", "list-scopes", "read-pair", "read-scope-set", "read-document"]);
const OPERATIONS = {
  "create-scope": createScope,
  "copy-project": copyProject,
  "copy-project-from": copyProjectFrom,
  "import-rows": importRows,
  "read-scope": readScope,
  "list-scopes": listScopes,
  "authorize-write": authorizeWrite,
  write: writeScope,
  "read-pair": readPair,
  "read-scope-set": readScopeSet,
  "read-document": readDocument,
  "compare-and-swap-document": compareAndSwapDocument,
};

const MAX_PAYLOAD_BYTES = 524288;

/** One command in its own connection and transaction; an error rolls it back. */
function run(sqlite, database, command, payload) {
  if (command !== "init" && !Object.hasOwn(OPERATIONS, command)) fail("memory_invalid_input");
  if (!isDict(payload)) fail("memory_invalid_input");
  const db = new NodeSqliteConnection(sqlite, database, { timeoutMs: 10_000 });
  try {
    // Initialization may rebuild the scope table; it checks foreign keys itself.
    db.exec(command === "init" ? "PRAGMA foreign_keys=OFF" : "PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=10000");
    db.exec("PRAGMA synchronous=FULL");
    if (command === "init") db.exec("PRAGMA journal_mode=WAL");
    db.exec(READ_COMMANDS.has(command) ? "BEGIN" : "BEGIN IMMEDIATE");
    let result;
    try {
      if (command === "init") {
        initialize(db);
        result = { schemaVersion: 1, ready: true };
      } else {
        if (db.value("PRAGMA user_version") !== SCHEMA_VERSION) fail("memory_unsupported_schema");
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
  if (error instanceof MemoryFailure) return error.code;
  if (isPythonInputError(error)) return "memory_invalid_input";
  return "memory_unavailable";
}

function bridgeFailure(command, code, detail = "") {
  const error = new Error(`SQLite bridge '${command}' failed: ${code}${detail ? ` (${detail})` : ""}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}\n`;
  return error;
}

/**
 * The project memory store's `invoke` in this process. Answers and failures
 * have the shape the Python bridge gave them (sqlite-bridge-server.mjs).
 */
export class NodeProjectMemoryBridge {
  #closed = false;

  constructor({ databasePath, sqlite }) {
    if (!databasePath || typeof sqlite?.DatabaseSync !== "function") {
      throw new Error("NodeProjectMemoryBridge requires databasePath and node:sqlite");
    }
    this.databasePath = path.resolve(databasePath);
    this.sqlite = sqlite;
    this.sqliteBackend = "node";
  }

  async invoke(command, payload = {}) {
    if (this.#closed) throw bridgeFailure(command, "memory_unavailable", "closed");
    let result;
    try {
      // The bridge read the payload as one JSON line of at most this many bytes.
      const request = jsonTransport(payload);
      if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > MAX_PAYLOAD_BYTES) fail("memory_limit_exceeded");
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

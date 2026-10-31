import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { NodeSqliteConnection } from "./sqlite-node-connection.mjs";
import { FORMAT_VERSION, commandSnapshot } from "./sqlite-control-store-node.mjs";
import { isDict, jsonTransport, pyEquals, pyGet } from "./sqlite-python-compat.mjs";

// sqlite-control-snapshot-reader.py on node:sqlite: a serialized-control
// snapshot read without changing the database, its WAL or its SHM. The same
// read-only URI (immutable without a WAL, a read-only SHM with one), query-only
// mode, schema checks, and command_snapshot of the store; the same error codes.

const SUPPORTED_FORMAT_VERSION = 4;
const REQUIRED_COLUMNS = {
  control_state: ["singleton_id", "mode", "reason", "updated_at_utc"],
  queue_items: [
    "item_id", "report_key", "source_id", "task_id", "report_id",
    "title", "report_status", "report_sha256", "task_sha256",
    "source_revision", "report_path", "task_path", "decision_path",
    "priority", "dispatch_sequence", "dependencies_json", "plan_json",
    "blockers_json", "evidence_json", "state", "phase",
    "current_action", "summary", "final_decision", "decision_reference",
    "thread_id", "turn_id", "lease_token", "lease_owner",
    "lease_expires_at_utc", "attempts", "error", "created_at_utc",
    "updated_at_utc", "started_at_utc", "finished_at_utc",
  ],
  agents: [
    "agent_id", "item_id", "parent_agent_id", "kind", "role",
    "provider", "state", "current_action", "last_completed",
    "next_action", "blockers_json", "thread_id", "turn_id",
    "can_interrupt", "started_at_utc", "last_heartbeat_utc",
    "statistics_json", "updated_at_utc",
  ],
  worker_tasks: [
    "source_id", "task_id", "title", "state", "phase", "summary_json",
    "plan_json", "workflow_json", "timing_json", "blockers_json",
    "evidence_json", "stop_events_json", "progress_sequence",
    "progress_sha256", "progress_path", "started_at_utc", "updated_at_utc",
  ],
  worker_agents: [
    "agent_id", "source_id", "task_id", "parent_agent_id", "kind",
    "role", "provider", "state", "current_action", "last_completed",
    "next_action", "blockers_json", "can_interrupt", "started_at_utc",
    "last_heartbeat_utc", "semantic_updated_at_utc", "statistics_json",
    "updated_at_utc",
  ],
  events: ["sequence", "at_utc", "event_type", "item_id", "agent_id", "payload_json"],
};

/** A bounded, machine-readable snapshot source failure. */
export class SnapshotReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadStoreContract() {
  if (FORMAT_VERSION !== SUPPORTED_FORMAT_VERSION) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
      `Snapshot reader does not support store format ${FORMAT_VERSION}`);
  }
  return SUPPORTED_FORMAT_VERSION;
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function connectReadOnly(sqlite, databasePath) {
  let resolved;
  try {
    resolved = realpathSync.native(path.resolve(databasePath));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new SnapshotReadError("CONTROL_SNAPSHOT_DATABASE_ABSENT", "Control store database does not exist");
    }
    throw error;
  }
  if (!isFile(resolved)) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_DATABASE_ABSENT", "Control store database is not a regular file");
  }
  const walExists = isFile(`${resolved}-wal`);
  const shmExists = isFile(`${resolved}-shm`);
  if (walExists !== shmExists) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_WAL_INCOMPLETE",
      "Control store WAL and SHM must either both exist or both be absent");
  }
  // Existing WAL indexes must be mapped read-only so reader marks cannot alter SHM.
  const immutable = walExists ? "&readonly_shm=1" : "&immutable=1";
  const uri = `${pathToFileURL(resolved).href}?mode=ro&cache=private${immutable}`;
  let connection = null;
  try {
    connection = new NodeSqliteConnection(sqlite, uri, { timeoutMs: 0 });
    connection.exec("PRAGMA query_only = ON");
    if (connection.value("PRAGMA query_only") !== 1) {
      connection.close();
      connection = null;
      throw new SnapshotReadError("CONTROL_SNAPSHOT_READ_ONLY_UNAVAILABLE", "SQLite query-only mode could not be enabled");
    }
    return connection;
  } catch (error) {
    if (error instanceof SnapshotReadError) throw error;
    if (connection !== null) connection.close();
    if (error?.code === "ERR_SQLITE_ERROR") {
      throw new SnapshotReadError("CONTROL_SNAPSHOT_OPEN_FAILED",
        `Control store database could not be opened read-only: ${error.message}`);
    }
    throw error;
  }
}

function validateSchema(connection, expectedVersion) {
  const version = Number(connection.value("PRAGMA user_version"));
  if (version !== expectedVersion) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
      `Unsupported control store schema version: ${version}; expected ${expectedVersion}`);
  }
  const tables = new Set(connection.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((row) => row.name));
  const missingTables = Object.keys(REQUIRED_COLUMNS).filter((table) => !tables.has(table)).sort();
  if (missingTables.length > 0) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
      `Control store schema is missing tables: ${missingTables.join(", ")}`);
  }
  const missingColumns = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(connection.all(`PRAGMA table_info("${table}")`).map((row) => row.name));
    missingColumns.push(...required.filter((column) => !columns.has(column)).map((column) => `${table}.${column}`));
  }
  if (missingColumns.length > 0) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
      `Control store schema is missing columns: ${missingColumns.join(", ")}`);
  }
  if (connection.get("SELECT singleton_id FROM control_state WHERE singleton_id = 1") === null) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED", "Control store schema has no singleton control state");
  }
}

/**
 * One run of `sqlite-control-snapshot-reader.py --database <path>`: the
 * snapshot, or an error with the script's `code` and message.
 */
export function readControlSnapshot(sqlite, databasePath, options = {}) {
  const payload = jsonTransport(options);
  if (!isDict(payload)) {
    throw new SnapshotReadError("CONTROL_SNAPSHOT_PAYLOAD_INVALID", "Snapshot options must be a JSON object");
  }
  const expectedVersion = loadStoreContract();
  const connection = connectReadOnly(sqlite, databasePath);
  try {
    connection.exec("BEGIN");
    validateSchema(connection, expectedVersion);
    const result = commandSnapshot(connection, payload);
    if (!pyEquals(pyGet(result, "formatVersion"), expectedVersion)) {
      throw new SnapshotReadError("CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
        "Control snapshot format does not match the store schema");
    }
    return result;
  } finally {
    connection.rollback();
    connection.close();
  }
}

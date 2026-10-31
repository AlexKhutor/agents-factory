import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { NodeSqliteConnection } from "./sqlite-node-connection.mjs";
import {
  PythonError, isDict, isoFromMicroseconds, jsonTransport, nowMicroseconds, parseUtcMicroseconds, pyEquals,
  pyAtLeast, pyClampInt, pyGet, pyHashKey, pyInt, pyIter, pyKeyCompare, pyLength, pyOr, pyRepr, pySlice, pyStr, pyTruthy,
  pyTypeName, pythonJson, utcNow, utf8,
} from "./sqlite-python-compat.mjs";

// sqlite-control-store.py on node:sqlite, in the calling process. Each command
// runs as one spawn of the Python script did: resolve the path, open a
// connection with the same PRAGMAs and busy timeout, migrate, run the command
// with the same statements in the same transactions (some commands run in
// autocommit, as in Python), close. Results and error messages are the ones
// the script printed; the format stays version 4, so either implementation
// reads and changes a database the other wrote, also at the same time.

export const FORMAT_VERSION = 4;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REPORT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const CONTROL_MODES = new Set(["running", "paused", "draining", "emergency_stopped"]);
const ITEM_STATES = new Set([
  "queued", "leased", "review_running", "decision_validating", "accepted", "reviewed", "integrating",
  "integrated", "waiting", "blocked", "cancelling", "cancelled", "stop_unconfirmed", "recovery_required", "failed",
]);
const ACTIVE_STATES = ["leased", "review_running", "decision_validating", "integrating", "cancelling",
  "recovery_required"];
const TERMINAL_STATES = new Set(["accepted", "integrated", "cancelled", "failed"]);
const FINAL_STATES = [...TERMINAL_STATES, "reviewed"];
const RETRYABLE_STATES = new Set(["cancelled", "failed", "recovery_required", "stop_unconfirmed"]);
const DECISIONS = new Set(["accepted", "rejected", "deferred", "superseded"]);
const CORRECTION_EVIDENCE_KINDS = new Set(["report-correction", "corrected-progress", "corrected-execution-summary"]);
const AGENT_STATES = new Set([
  "registered", "starting", "running", "waiting", "blocked", "cancellation_requested", "interrupted",
  "completed", "failed", "stop_unconfirmed", "stale",
]);
const WORKER_TASK_STATES = new Set([
  "accepted", "running", "waiting", "blocked", "cancelling", "cancelled", "completed", "failed", "stop_unconfirmed",
]);

const valueError = (message) => new PythonError("ValueError", message);
const inSet = (set, value) => typeof value === "string" && set.has(value);

export function boundedText(value, maximum = 2048) {
  if (value === null || value === undefined) return null;
  const text = pyStr(value);
  if (text.length <= maximum || pyLength(text) <= maximum) return text;
  return `${pySlice(text, maximum - 15)}...<truncated>`;
}

const jsonText = (value) => pythonJson(value);

function loads(text) {
  if (typeof text !== "string") {
    throw new PythonError("TypeError", `the JSON object must be str, bytes or bytearray, not ${pyTypeName(text)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PythonError("JSONDecodeError", error.message);
  }
}

function jsonValue(value, fallback) {
  if (!pyTruthy(value)) return fallback;
  return loads(value);
}

function requireSha256(value, label) {
  const text = pyStr(pyOr(value, "")).toLowerCase();
  if (!SHA256_PATTERN.test(text)) throw valueError(`Invalid ${label}`);
  return text;
}

function mergeReportCorrectionEvidence(current, incoming, state) {
  if (!Array.isArray(current) || !Array.isArray(incoming)) throw valueError("Queue evidence must be an array");
  const currentText = new Set(current.map(jsonText));
  const incomingText = new Set(incoming.map(jsonText));
  if (incomingText.size !== incoming.length) throw valueError("Queue evidence cannot contain duplicate entries");
  if ([...incomingText].every((text) => currentText.has(text))) return current;
  const preserved = new Set(current.map(jsonText));
  if (![...preserved].every((text) => incomingText.has(text))) {
    throw valueError("Existing immutable report evidence cannot be removed or replaced");
  }
  const additions = incoming.filter((entry) => !currentText.has(jsonText(entry)));
  const additionKinds = additions.filter(isDict).map((entry) => pyGet(entry, "kind"));
  // Evaluated in Python's order: the kinds are hashed only when it gets there.
  const incomplete = () => {
    if (!(state === "queued" || inSet(RETRYABLE_STATES, state)) || additions.length !== 3) return true;
    const kindKeys = new Set(additionKinds.map(pyHashKey));
    const expectedKinds = new Set([...CORRECTION_EVIDENCE_KINDS].map(pyHashKey));
    return kindKeys.size !== expectedKinds.size || [...kindKeys].some((key) => !expectedKinds.has(key))
      || kindKeys.size !== 3;
  };
  if (incomplete()) {
    throw valueError("Only one complete immutable report-correction evidence set may augment a queued report");
  }
  const existingCorrections = current.filter((entry) => isDict(entry)
    && inSet(CORRECTION_EVIDENCE_KINDS, pyGet(entry, "kind")));
  if (existingCorrections.length > 0) throw valueError("A different immutable report correction already exists");
  for (const entry of additions) {
    if (!isDict(entry)) throw valueError("Report-correction evidence entries must be objects");
    requireSha256(pyGet(entry, "sha256"), `${pyStr(pyGet(entry, "kind"))} evidence sha256`);
    if (typeof pyGet(entry, "path") !== "string" || !entry.path) {
      throw valueError("Report-correction evidence requires a path");
    }
  }
  return incoming;
}

function agentStatistics(value) {
  if (value === null || value === undefined) return {};
  if (!isDict(value)) throw valueError("Agent statistics must be an object");
  if (pyTruthy(value) && !pyEquals(pyGet(value, "schemaVersion"), 1)) {
    throw valueError("Agent statistics require schemaVersion 1");
  }
  if (utf8(jsonText(value)).length > 128 * 1024) throw valueError("Agent statistics exceed the 128 KiB storage budget");
  return value;
}

function mapping(value) {
  if (!isDict(value)) throw new PythonError("TypeError", `'${pyTypeName(value)}' object is not a mapping`);
  return value;
}

function dictItems(value) {
  if (!isDict(value)) throw new PythonError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'items'`);
  return Object.entries(value);
}

function mergeAgentStatistics(current, incoming) {
  const left = agentStatistics(current);
  const right = agentStatistics(incoming);
  if (!pyTruthy(left)) return right;
  if (!pyTruthy(right)) return left;
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (!["tokens", "cost", "limitations", "timing"].includes(key)) merged[key] = value;
  }
  if (pyEquals(pyGet(pyGet(right, "tokens", {}), "status"), "available") || !pyTruthy(pyGet(left, "tokens"))) {
    merged.tokens = pyGet(right, "tokens");
  }
  if (pyEquals(pyGet(pyGet(right, "cost", {}), "status"), "estimated") || !pyTruthy(pyGet(left, "cost"))) {
    merged.cost = pyGet(right, "cost");
  }
  const timing = { ...mapping(pyOr(pyGet(left, "timing"), {})) };
  for (const [key, value] of dictItems(pyOr(pyGet(right, "timing"), {}))) {
    if (value !== null) timing[key] = value;
  }
  merged.timing = timing;
  const seen = new Set();
  const limitations = [];
  for (const entry of [...pyIter(pyOr(pyGet(left, "limitations"), [])), ...pyIter(pyOr(pyGet(right, "limitations"), []))]) {
    const key = pyHashKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    limitations.push(entry);
  }
  merged.limitations = limitations.slice(0, 20);
  return agentStatistics(merged);
}

function requireId(value, label) {
  const text = pyStr(pyOr(value, ""));
  if (!ID_PATTERN.test(text)) throw valueError(`Invalid ${label}: ${pyRepr(text)}`);
  return text;
}

function requireItemId(value, label = "itemId") {
  const text = pyStr(pyOr(value, ""));
  if (!ITEM_ID_PATTERN.test(text)) throw valueError(`Invalid ${label}: ${pyRepr(text)}`);
  return text;
}

function requireReportId(value) {
  const text = pyStr(pyOr(value, ""));
  if (!REPORT_ID_PATTERN.test(text)) throw valueError(`Invalid reportId: ${pyRepr(text)}`);
  return text;
}

/** Path(database_path).expanduser().resolve(): symbolic links resolved where the path exists. */
function resolvedDatabasePath(databasePath) {
  let existing = path.resolve(databasePath);
  const rest = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return path.resolve(databasePath);
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try {
    real = realpathSync.native(existing);
  } catch {
    real = existing;
  }
  return path.join(real, ...rest);
}

function connect(sqlite, databasePath) {
  const resolved = resolvedDatabasePath(databasePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const connection = new NodeSqliteConnection(sqlite, resolved, { timeoutMs: 30_000 });
  try {
    connection.exec("PRAGMA journal_mode=WAL");
    connection.exec("PRAGMA synchronous=FULL");
    connection.exec("PRAGMA foreign_keys=ON");
    connection.exec("PRAGMA busy_timeout=30000");
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

const SCHEMA = `
        CREATE TABLE IF NOT EXISTS control_state (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          mode TEXT NOT NULL,
          reason TEXT,
          updated_at_utc TEXT NOT NULL
        );

        INSERT OR IGNORE INTO control_state(singleton_id, mode, reason, updated_at_utc)
        VALUES (1, 'running', NULL, '1970-01-01T00:00:00Z');

        CREATE TABLE IF NOT EXISTS queue_items (
          item_id TEXT PRIMARY KEY,
          report_key TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          title TEXT NOT NULL,
          report_status TEXT NOT NULL,
          report_sha256 TEXT NOT NULL,
          task_sha256 TEXT,
          source_revision TEXT NOT NULL,
          report_path TEXT NOT NULL,
          task_path TEXT,
          decision_path TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          dispatch_sequence INTEGER NOT NULL DEFAULT 0,
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          plan_json TEXT NOT NULL DEFAULT '[]',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          state TEXT NOT NULL,
          phase TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          final_decision TEXT,
          decision_reference TEXT,
          thread_id TEXT,
          turn_id TEXT,
          lease_token TEXT,
          lease_owner TEXT,
          lease_expires_at_utc TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at_utc TEXT NOT NULL,
          updated_at_utc TEXT NOT NULL,
          started_at_utc TEXT,
          finished_at_utc TEXT,
          UNIQUE(source_id, task_id)
        );

        CREATE INDEX IF NOT EXISTS idx_queue_state_order
          ON queue_items(state, priority DESC, dispatch_sequence ASC, created_at_utc ASC);

        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          parent_agent_id TEXT,
          kind TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT,
          state TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          last_completed TEXT,
          next_action TEXT,
          blockers_json TEXT NOT NULL DEFAULT '[]',
          thread_id TEXT,
          turn_id TEXT,
          can_interrupt INTEGER NOT NULL DEFAULT 0,
          started_at_utc TEXT,
          last_heartbeat_utc TEXT,
          statistics_json TEXT NOT NULL DEFAULT '{}',
          updated_at_utc TEXT NOT NULL,
          FOREIGN KEY(item_id) REFERENCES queue_items(item_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_agents_item ON agents(item_id);

        CREATE TABLE IF NOT EXISTS worker_tasks (
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          phase TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          plan_json TEXT NOT NULL DEFAULT '[]',
          workflow_json TEXT NOT NULL DEFAULT '{}',
          timing_json TEXT NOT NULL DEFAULT '{}',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          stop_events_json TEXT NOT NULL DEFAULT '[]',
          progress_sequence INTEGER NOT NULL DEFAULT 0,
          progress_sha256 TEXT NOT NULL,
          progress_path TEXT NOT NULL,
          started_at_utc TEXT,
          updated_at_utc TEXT NOT NULL,
          PRIMARY KEY(source_id, task_id)
        );

        CREATE TABLE IF NOT EXISTS worker_agents (
          agent_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          parent_agent_id TEXT,
          kind TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT,
          state TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          last_completed TEXT,
          next_action TEXT,
          blockers_json TEXT NOT NULL DEFAULT '[]',
          can_interrupt INTEGER NOT NULL DEFAULT 0,
          started_at_utc TEXT,
          last_heartbeat_utc TEXT,
          semantic_updated_at_utc TEXT,
          statistics_json TEXT NOT NULL DEFAULT '{}',
          updated_at_utc TEXT NOT NULL,
          FOREIGN KEY(source_id, task_id) REFERENCES worker_tasks(source_id, task_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_worker_agents_task ON worker_agents(source_id, task_id);

        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          at_utc TEXT NOT NULL,
          event_type TEXT NOT NULL,
          item_id TEXT,
          agent_id TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_events_item_sequence ON events(item_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_events_at ON events(at_utc);
        `;

function columns(connection, table) {
  return new Set(connection.all(`PRAGMA table_info(${table})`).map((row) => row.name));
}

function migrate(connection) {
  const previousVersion = connection.value("PRAGMA user_version");
  if (previousVersion > FORMAT_VERSION) {
    throw new PythonError("RuntimeError", `Unsupported control queue database version: ${previousVersion}`);
  }
  connection.exec(SCHEMA);
  const workerTaskColumns = columns(connection, "worker_tasks");
  if (!workerTaskColumns.has("workflow_json")) {
    connection.exec("ALTER TABLE worker_tasks ADD COLUMN workflow_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!workerTaskColumns.has("timing_json")) {
    connection.exec("ALTER TABLE worker_tasks ADD COLUMN timing_json TEXT NOT NULL DEFAULT '{}'");
  }
  const workerAgentColumns = columns(connection, "worker_agents");
  if (!workerAgentColumns.has("semantic_updated_at_utc")) {
    connection.exec("ALTER TABLE worker_agents ADD COLUMN semantic_updated_at_utc TEXT");
  }
  if (!workerAgentColumns.has("statistics_json")) {
    connection.exec("ALTER TABLE worker_agents ADD COLUMN statistics_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns(connection, "agents").has("statistics_json")) {
    connection.exec("ALTER TABLE agents ADD COLUMN statistics_json TEXT NOT NULL DEFAULT '{}'");
  }
  connection.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
  const version = connection.value("PRAGMA user_version");
  if (version !== FORMAT_VERSION) {
    throw new PythonError("RuntimeError", `Unsupported control queue database version: ${version}`);
  }
}

function addEvent(connection, eventType, { itemId = null, agentId = null, payload = null, atUtc = null } = {}) {
  const inserted = connection.run(`
        INSERT INTO events(at_utc, event_type, item_id, agent_id, payload_json)
        VALUES (?, ?, ?, ?, ?)
        `, [pyTruthy(atUtc) ? atUtc : utcNow(), eventType, itemId, agentId, jsonText(pyOr(payload, {}))]);
  return inserted.lastInsertRowid;
}

export function itemFromRow(row) {
  if (row === null) return null;
  return {
    itemId: row.item_id,
    reportKey: row.report_key,
    sourceId: row.source_id,
    taskId: row.task_id,
    reportId: row.report_id,
    title: row.title,
    reportStatus: row.report_status,
    reportSha256: row.report_sha256,
    taskSha256: row.task_sha256,
    sourceRevision: row.source_revision,
    reportPath: row.report_path,
    taskPath: row.task_path,
    decisionPath: row.decision_path,
    priority: row.priority,
    dispatchSequence: row.dispatch_sequence,
    dependencies: jsonValue(row.dependencies_json, []),
    plan: jsonValue(row.plan_json, []),
    blockers: jsonValue(row.blockers_json, []),
    evidence: jsonValue(row.evidence_json, []),
    state: row.state,
    phase: row.phase,
    currentAction: row.current_action,
    summary: row.summary,
    finalDecision: row.final_decision,
    decisionReference: row.decision_reference,
    threadId: row.thread_id,
    turnId: row.turn_id,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAtUtc: row.lease_expires_at_utc,
    attempts: row.attempts,
    error: row.error,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    startedAtUtc: row.started_at_utc,
    finishedAtUtc: row.finished_at_utc,
  };
}

export function agentFromRow(row) {
  return {
    agentId: row.agent_id,
    itemId: row.item_id,
    parentAgentId: row.parent_agent_id,
    kind: row.kind,
    role: row.role,
    provider: row.provider,
    state: row.state,
    currentAction: row.current_action,
    lastCompleted: row.last_completed,
    nextAction: row.next_action,
    blockers: jsonValue(row.blockers_json, []),
    threadId: row.thread_id,
    turnId: row.turn_id,
    canInterrupt: pyTruthy(row.can_interrupt),
    startedAtUtc: row.started_at_utc,
    lastHeartbeatUtc: row.last_heartbeat_utc,
    statistics: jsonValue(row.statistics_json, {}),
    updatedAtUtc: row.updated_at_utc,
  };
}

export function eventFromRow(row) {
  return {
    sequence: row.sequence,
    atUtc: row.at_utc,
    type: row.event_type,
    itemId: row.item_id,
    agentId: row.agent_id,
    data: jsonValue(row.payload_json, {}),
  };
}

export function workerTaskFromRow(row) {
  return {
    sourceId: row.source_id,
    taskId: row.task_id,
    title: row.title,
    state: row.state,
    phase: row.phase,
    summary: jsonValue(row.summary_json, {}),
    plan: jsonValue(row.plan_json, []),
    workflow: jsonValue(row.workflow_json, {}),
    timing: jsonValue(row.timing_json, {}),
    blockers: jsonValue(row.blockers_json, []),
    evidence: jsonValue(row.evidence_json, []),
    stopEvents: jsonValue(row.stop_events_json, []),
    progressSequence: row.progress_sequence,
    progressSha256: row.progress_sha256,
    progressPath: row.progress_path,
    startedAtUtc: row.started_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

export function workerAgentFromRow(row) {
  return {
    agentId: row.agent_id,
    sourceId: row.source_id,
    taskId: row.task_id,
    parentAgentId: row.parent_agent_id,
    kind: row.kind,
    role: row.role,
    provider: row.provider,
    state: row.state,
    currentAction: row.current_action,
    lastCompleted: row.last_completed,
    nextAction: row.next_action,
    blockers: jsonValue(row.blockers_json, []),
    canInterrupt: pyTruthy(row.can_interrupt),
    startedAtUtc: row.started_at_utc,
    lastHeartbeatUtc: row.last_heartbeat_utc,
    semanticUpdatedAtUtc: row.semantic_updated_at_utc,
    statistics: jsonValue(row.statistics_json, {}),
    updatedAtUtc: row.updated_at_utc,
  };
}

/** A transaction as the script wrote it: COMMIT on return, ROLLBACK on an error. */
function immediate(connection, body) {
  connection.exec("BEGIN IMMEDIATE");
  let result;
  try {
    result = body();
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
  return result;
}

const commit = (connection, result) => {
  connection.exec("COMMIT");
  return result;
};

function commandInit(connection) {
  const control = connection.get("SELECT * FROM control_state WHERE singleton_id = 1");
  return { formatVersion: FORMAT_VERSION, mode: (control ?? undefinedRow()).mode };
}

function undefinedRow() {
  throw new PythonError("TypeError", "'NoneType' object is not subscriptable");
}

function commandEnqueue(connection, payload) {
  const sourceId = requireId(pyGet(payload, "sourceId"), "sourceId");
  const taskId = requireId(pyGet(payload, "taskId"), "taskId");
  const reportId = requireReportId(pyOr(pyGet(payload, "reportId"), `${taskId}-report`));
  const reportSha = requireSha256(pyGet(payload, "reportSha256"), "reportSha256");
  let taskSha = pyGet(payload, "taskSha256");
  if (pyTruthy(taskSha)) taskSha = requireSha256(taskSha, "taskSha256");
  let itemId = pyOr(pyGet(payload, "itemId"), `${sourceId}:${taskId}:${reportSha.slice(0, 12)}`);
  itemId = requireItemId(itemId);
  const dependencies = pyIter(pyGet(payload, "dependencies", [])).map((item) => requireId(item, "dependency"));
  const now = utcNow();
  const reportKey = `${sourceId}:${taskId}:${reportSha}`;

  return immediate(connection, () => {
    let existingTask = connection.get("SELECT * FROM queue_items WHERE source_id = ? AND task_id = ?",
      [sourceId, taskId]);
    if (existingTask !== null) {
      if (existingTask.report_sha256 !== reportSha) {
        throw valueError(`Task ${sourceId}/${taskId} already has a different immutable report`);
      }
      const mergedEvidence = mergeReportCorrectionEvidence(
        jsonValue(existingTask.evidence_json, []),
        pyGet(payload, "evidence", []),
        existingTask.state,
      );
      if (!pyEquals(mergedEvidence, jsonValue(existingTask.evidence_json, []))) {
        connection.run("UPDATE queue_items SET evidence_json = ?, updated_at_utc = ? WHERE item_id = ?",
          [jsonText(mergedEvidence), now, existingTask.item_id]);
        addEvent(connection, "queue.item_evidence_augmented", {
          itemId: existingTask.item_id,
          payload: { kinds: [...CORRECTION_EVIDENCE_KINDS].sort(pyKeyCompare) },
          atUtc: now,
        });
        existingTask = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [existingTask.item_id]);
      }
      return commit(connection, { created: false, item: itemFromRow(existingTask) });
    }

    connection.run(`
            INSERT INTO queue_items(
              item_id, report_key, source_id, task_id, report_id, title,
              report_status, report_sha256, task_sha256, source_revision,
              report_path, task_path, decision_path, priority, dispatch_sequence,
              dependencies_json, plan_json, blockers_json, evidence_json,
              state, phase, current_action, summary, created_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
      itemId,
      reportKey,
      sourceId,
      taskId,
      reportId,
      boundedText(pyOr(pyGet(payload, "title"), taskId), 256),
      boundedText(pyOr(pyGet(payload, "reportStatus"), "completed"), 32),
      reportSha,
      taskSha,
      boundedText(pyOr(pyGet(payload, "sourceRevision"), "unknown"), 256),
      boundedText(pyOr(pyGet(payload, "reportPath"), ""), 2048),
      boundedText(pyGet(payload, "taskPath"), 2048),
      boundedText(pyGet(payload, "decisionPath"), 2048),
      pyInt(pyGet(payload, "priority", 0)),
      pyInt(pyGet(payload, "dispatchSequence", 0)),
      jsonText(dependencies),
      jsonText(pyGet(payload, "plan", [])),
      jsonText(pyGet(payload, "blockers", [])),
      jsonText(pyGet(payload, "evidence", [])),
      "queued",
      "intake",
      "Waiting for serialized review",
      boundedText(pyOr(pyGet(payload, "summary"), ""), 2048),
      now,
      now,
    ]);
    addEvent(connection, "queue.item_enqueued", {
      itemId,
      payload: { sourceId, taskId, reportSha256: reportSha },
      atUtc: now,
    });
    const row = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { created: true, item: itemFromRow(row) });
  });
}

function dependenciesSatisfied(connection, dependencies) {
  for (const taskId of pyIter(dependencies)) {
    const row = connection.get(
      "SELECT state, final_decision FROM queue_items WHERE task_id = ? ORDER BY created_at_utc DESC LIMIT 1",
      [taskId],
    );
    if (row === null || !["accepted", "reviewed", "integrated"].includes(row.state)
        || row.final_decision !== "accepted") return false;
  }
  return true;
}

function leaseSeconds(payload) {
  return pyClampInt(pyGet(payload, "leaseSeconds", 120), 15, 3600);
}

function commandClaim(connection, payload) {
  const owner = boundedText(pyOr(pyGet(payload, "owner"), `process-${process.pid}`), 128);
  let requestedSource = pyGet(payload, "sourceId");
  let requestedTask = pyGet(payload, "taskId");
  if (pyTruthy(requestedSource) !== pyTruthy(requestedTask)) {
    throw valueError("sourceId and taskId must be supplied together for a targeted claim");
  }
  if (pyTruthy(requestedSource)) {
    requestedSource = requireId(requestedSource, "sourceId");
    requestedTask = requireId(requestedTask, "taskId");
  }
  const seconds = leaseSeconds(payload);
  const nowMicros = nowMicroseconds();
  const now = isoFromMicroseconds(nowMicros);
  const expires = isoFromMicroseconds(nowMicros + seconds * 1_000_000);

  return immediate(connection, () => {
    const control = connection.get("SELECT * FROM control_state WHERE singleton_id = 1");
    if (control.mode !== "running") {
      return commit(connection, { item: null, reason: `control-${pyStr(control.mode)}` });
    }
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const active = connection.get(
      `SELECT * FROM queue_items WHERE state IN (${placeholders}) ORDER BY updated_at_utc LIMIT 1`,
      ACTIVE_STATES,
    );
    if (active !== null) {
      return commit(connection, { item: null, reason: "active-review", active: itemFromRow(active) });
    }
    const candidates = pyTruthy(requestedSource)
      ? connection.all(`
                SELECT * FROM queue_items
                WHERE state = 'queued' AND source_id = ? AND task_id = ?
                ORDER BY priority DESC, dispatch_sequence ASC, created_at_utc ASC, item_id ASC
                `, [requestedSource, requestedTask])
      : connection.all(`
                SELECT * FROM queue_items
                WHERE state = 'queued'
                ORDER BY priority DESC, dispatch_sequence ASC, created_at_utc ASC, item_id ASC
                `);
    let selected = null;
    for (const candidate of candidates) {
      if (dependenciesSatisfied(connection, jsonValue(candidate.dependencies_json, []))) {
        selected = candidate;
        break;
      }
    }
    if (selected === null) {
      connection.exec("COMMIT");
      let reason;
      if (pyTruthy(requestedSource)) {
        const existing = connection.get("SELECT state FROM queue_items WHERE source_id = ? AND task_id = ?",
          [requestedSource, requestedTask]);
        reason = existing !== null ? `requested-item-${pyStr(existing.state)}` : "requested-item-not-found";
        if (candidates.length > 0) reason = "dependencies-not-ready";
      } else {
        reason = candidates.length > 0 ? "dependencies-not-ready" : "queue-empty";
      }
      return { item: null, reason };
    }

    const leaseToken = randomUUID();
    connection.run(`
            UPDATE queue_items
            SET state = 'leased', phase = 'review-starting', current_action = ?,
                lease_token = ?, lease_owner = ?, lease_expires_at_utc = ?,
                attempts = attempts + 1, started_at_utc = COALESCE(started_at_utc, ?),
                updated_at_utc = ?
            WHERE item_id = ? AND state = 'queued'
            `, ["Starting serialized review", leaseToken, owner, expires, now, now, selected.item_id]);
    addEvent(connection, "queue.item_claimed", {
      itemId: selected.item_id,
      payload: { owner, leaseExpiresAtUtc: expires },
      atUtc: now,
    });
    const claimed = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [selected.item_id]);
    return commit(connection, { item: itemFromRow(claimed), reason: "claimed" });
  });
}

function commandAccept(connection, payload) {
  const sourceId = requireId(pyGet(payload, "sourceId"), "sourceId");
  const taskId = requireId(pyGet(payload, "taskId"), "taskId");
  const reportSha = requireSha256(pyGet(payload, "reportSha256"), "reportSha256");
  const evidence = pyOr(pyGet(payload, "evidence"), []);
  if (!Array.isArray(evidence)) throw valueError("Acceptance evidence must be an array");
  const acceptanceEvidence = evidence.filter((entry) => isDict(entry) && pyEquals(pyGet(entry, "kind"), "acceptance"));
  if (acceptanceEvidence.length !== 1) {
    throw valueError("Deterministic acceptance requires exactly one acceptance evidence reference");
  }
  requireSha256(pyGet(acceptanceEvidence[0], "sha256"), "acceptance evidence sha256");
  const summary = boundedText(pyOr(pyGet(payload, "summary"), "Deterministic acceptance passed"), 2048);
  const plan = pyGet(payload, "plan");
  const now = utcNow();

  return immediate(connection, () => {
    const row = connection.get("SELECT * FROM queue_items WHERE source_id = ? AND task_id = ?", [sourceId, taskId]);
    if (row === null) throw valueError(`Queue item does not exist: ${sourceId}/${taskId}`);
    if (row.report_sha256 !== reportSha) throw valueError(`Report SHA-256 changed for ${sourceId}/${taskId}`);
    if (row.state === "accepted" && row.final_decision === "accepted") {
      return commit(connection, { accepted: true, idempotent: true, item: itemFromRow(row) });
    }
    if (row.state !== "queued") {
      throw valueError(`Queue item ${sourceId}/${taskId} cannot be accepted from state ${pyStr(row.state)}`);
    }
    const control = connection.get("SELECT mode FROM control_state WHERE singleton_id = 1");
    if (control.mode !== "running") {
      throw valueError(`Control is ${pyStr(control.mode)}; deterministic acceptance is not allowed`);
    }
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const active = connection.get(`SELECT item_id FROM queue_items WHERE state IN (${placeholders}) LIMIT 1`,
      ACTIVE_STATES);
    if (active !== null) throw valueError(`Another serialized operation is active: ${pyStr(active.item_id)}`);
    if (row.report_status !== "completed") {
      throw valueError(`Only a completed child report can be accepted, got ${pyStr(row.report_status)}`);
    }
    if (pyTruthy(jsonValue(row.blockers_json, []))) {
      throw valueError("A report with unresolved blockers cannot be accepted");
    }
    if (!dependenciesSatisfied(connection, jsonValue(row.dependencies_json, []))) {
      throw valueError("Report dependencies are not ready for deterministic acceptance");
    }
    const completedPlan = Array.isArray(plan) ? plan : pyIter(jsonValue(row.plan_json, []))
      .filter(isDict).map((step) => ({ ...step, state: "completed" }));
    connection.run(`
            UPDATE queue_items
            SET state = 'accepted', phase = 'complete', current_action = ?, summary = ?,
                final_decision = 'accepted', evidence_json = ?, plan_json = ?,
                lease_token = NULL, lease_owner = NULL, lease_expires_at_utc = NULL,
                finished_at_utc = COALESCE(finished_at_utc, ?), updated_at_utc = ?
            WHERE item_id = ? AND state = 'queued'
            `, [
      "Verified child report accepted without model review",
      summary,
      jsonText(evidence),
      jsonText(completedPlan),
      now,
      now,
      row.item_id,
    ]);
    addEvent(connection, "queue.item_accepted", {
      itemId: row.item_id,
      payload: { sourceId, taskId, reportSha256: reportSha, method: "deterministic" },
      atUtc: now,
    });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [row.item_id]);
    return commit(connection, { accepted: true, idempotent: false, item: itemFromRow(updated) });
  });
}

const PATCH_COLUMNS = {
  phase: ["phase", (value) => boundedText(value, 64)],
  currentAction: ["current_action", (value) => boundedText(value, 512)],
  summary: ["summary", (value) => boundedText(value, 2048)],
  threadId: ["thread_id", (value) => boundedText(value, 256)],
  turnId: ["turn_id", (value) => boundedText(value, 256)],
  error: ["error", (value) => boundedText(value, 2048)],
  finalDecision: ["final_decision", (value) => boundedText(value, 32)],
  decisionReference: ["decision_reference", (value) => boundedText(value, 2048)],
  leaseExpiresAtUtc: ["lease_expires_at_utc", (value) => boundedText(value, 64)],
  finishedAtUtc: ["finished_at_utc", (value) => boundedText(value, 64)],
  plan: ["plan_json", jsonText],
  blockers: ["blockers_json", jsonText],
  evidence: ["evidence_json", jsonText],
};

/** `value in container` for a list, a str (substring) or a dict (key). */
function pyContains(container, value) {
  if (typeof container === "string") {
    if (typeof value !== "string") {
      throw new PythonError("TypeError", `'in <string>' requires string as left operand, not ${pyTypeName(value)}`);
    }
    return container.includes(value);
  }
  if (isDict(container)) return Object.hasOwn(container, pyStr(value)) && typeof value === "string";
  return pyIter(container).some((entry) => pyEquals(entry, value));
}

function commandTransition(connection, payload) {
  const itemId = requireItemId(pyGet(payload, "itemId"));
  const target = pyStr(pyOr(pyGet(payload, "toState"), ""));
  if (!ITEM_STATES.has(target)) throw valueError(`Unsupported queue state: ${target}`);
  let expected = pyOr(pyGet(payload, "fromStates"), []);
  if (typeof expected === "string") expected = [expected];
  if (pyIter(expected).some((state) => pyHashKey(state) && !inSet(ITEM_STATES, state))) {
    throw valueError("fromStates contains an unsupported state");
  }
  const patch = pyOr(pyGet(payload, "patch"), {});
  const leaseToken = pyGet(payload, "leaseToken");
  const now = utcNow();

  return immediate(connection, () => {
    const row = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    if (row === null) throw valueError(`Queue item does not exist: ${itemId}`);
    if (pyTruthy(expected) && !pyContains(expected, row.state)) {
      throw valueError(`Queue item ${itemId} is ${pyStr(row.state)}, expected one of ${pyStr(expected)}`);
    }
    if (pyTruthy(leaseToken) && !pyEquals(row.lease_token, leaseToken)) {
      throw valueError(`Lease token does not own queue item ${itemId}`);
    }

    const assignments = ["state = ?", "updated_at_utc = ?"];
    const values = [target, now];
    for (const [key, value] of dictItems(patch)) {
      if (!Object.hasOwn(PATCH_COLUMNS, key)) throw valueError(`Unsupported transition patch field: ${key}`);
      const [column, converter] = PATCH_COLUMNS[key];
      if (key === "finalDecision" && value !== null && pyHashKey(value) && !inSet(DECISIONS, value)) {
        throw valueError(`Unsupported final decision: ${pyStr(value)}`);
      }
      assignments.push(`${column} = ?`);
      values.push(converter(value));
    }
    if (TERMINAL_STATES.has(target) || target === "reviewed" || target === "stop_unconfirmed") {
      assignments.push("lease_token = NULL", "lease_owner = NULL", "lease_expires_at_utc = NULL");
    }
    if (TERMINAL_STATES.has(target) || target === "stop_unconfirmed") {
      assignments.push("finished_at_utc = COALESCE(finished_at_utc, ?)");
      values.push(now);
    }
    values.push(itemId);
    connection.run(`UPDATE queue_items SET ${assignments.join(", ")} WHERE item_id = ?`, values);
    addEvent(connection, "queue.state_changed", {
      itemId,
      payload: { from: row.state, to: target, patchKeys: Object.keys(patch).sort(pyKeyCompare) },
      atUtc: now,
    });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { item: itemFromRow(updated) });
  });
}

function commandHeartbeat(connection, payload) {
  const itemId = requireItemId(pyGet(payload, "itemId"));
  const leaseToken = pyGet(payload, "leaseToken");
  const seconds = leaseSeconds(payload);
  const nowMicros = nowMicroseconds();
  const now = isoFromMicroseconds(nowMicros);
  const expires = isoFromMicroseconds(nowMicros + seconds * 1_000_000);
  const row = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
  if (row === null) throw valueError(`Queue item does not exist: ${itemId}`);
  if (pyTruthy(leaseToken) && !pyEquals(row.lease_token, leaseToken)) {
    throw valueError(`Lease token does not own queue item ${itemId}`);
  }
  connection.run(`
        UPDATE queue_items
        SET lease_expires_at_utc = ?, current_action = COALESCE(?, current_action), updated_at_utc = ?
        WHERE item_id = ?
        `, [expires, boundedText(pyGet(payload, "currentAction"), 512), now, itemId]);
  addEvent(connection, "queue.heartbeat", { itemId, payload: { leaseExpiresAtUtc: expires }, atUtc: now });
  return { item: itemFromRow(connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId])) };
}

function commandSetMode(connection, payload) {
  const mode = pyStr(pyOr(pyGet(payload, "mode"), ""));
  if (!CONTROL_MODES.has(mode)) throw valueError(`Unsupported control mode: ${mode}`);
  const reason = boundedText(pyGet(payload, "reason"), 1024);
  const now = utcNow();
  return immediate(connection, () => {
    const previous = connection.get("SELECT * FROM control_state WHERE singleton_id = 1");
    connection.run("UPDATE control_state SET mode = ?, reason = ?, updated_at_utc = ? WHERE singleton_id = 1",
      [mode, reason, now]);
    if (mode === "emergency_stopped") {
      const placeholders = ACTIVE_STATES.map(() => "?").join(",");
      connection.run(`
                UPDATE queue_items
                SET state = 'cancelling', phase = 'emergency-stop',
                    current_action = 'Emergency stop requested', updated_at_utc = ?
                WHERE state IN (${placeholders})
                `, [now, ...ACTIVE_STATES]);
      connection.run(`
                UPDATE agents
                SET state = 'cancellation_requested', current_action = 'Emergency stop requested',
                    updated_at_utc = ?
                WHERE state IN ('starting', 'running', 'waiting', 'blocked')
                `, [now]);
      connection.run(`
                UPDATE worker_tasks
                SET state = 'cancelling', phase = 'emergency-stop',
                    summary_json = ?, updated_at_utc = ?
                WHERE state IN ('accepted', 'running', 'waiting', 'blocked')
                `, [jsonText({
        now: "Emergency stop requested",
        done: [],
        next: [],
        blockers: [pyOr(reason, "Emergency stop requested")],
      }), now]);
      connection.run(`
                UPDATE worker_agents
                SET state = 'cancellation_requested', current_action = 'Emergency stop requested',
                    updated_at_utc = ?
                WHERE state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                `, [now]);
    }
    addEvent(connection, "control.mode_changed", {
      payload: { from: (previous ?? undefinedRow()).mode, to: mode, reason },
      atUtc: now,
    });
    return commit(connection, { mode, reason, updatedAtUtc: now });
  });
}

function commandUpsertProgress(connection, payload) {
  const sourceId = requireId(pyGet(payload, "sourceId"), "sourceId");
  const taskId = requireId(pyGet(payload, "taskId"), "taskId");
  const state = pyStr(pyOr(pyGet(payload, "state"), "running"));
  if (!WORKER_TASK_STATES.has(state)) throw valueError(`Unsupported worker task state: ${state}`);
  const progressSha = requireSha256(pyGet(payload, "progressSha256"), "progressSha256");
  const progressSequence = pyAtLeast(pyGet(payload, "sequence", 0), 0);
  const summary = pyOr(pyGet(payload, "summary"), {});
  if (!isDict(summary)) throw valueError("Worker progress summary must be an object");
  const agents = pyOr(pyGet(payload, "agents"), []);
  if (!Array.isArray(agents) || agents.length > 256) throw valueError("Worker progress agents must be a bounded array");
  const now = utcNow();
  const updated = boundedText(pyOr(pyGet(payload, "updatedAtUtc"), now), 64);

  return immediate(connection, () => {
    const existing = connection.get("SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?",
      [sourceId, taskId]);
    if (existing !== null && pyInt(existing.progress_sequence) > progressSequence) {
      return commit(connection, { updated: false, reason: "older-sequence", task: workerTaskFromRow(existing) });
    }
    const changed = existing === null || existing.progress_sha256 !== progressSha;
    const incomingTiming = pyOr(pyGet(payload, "timing"), {});
    const existingTiming = existing !== null ? jsonValue(existing.timing_json, {}) : {};
    const incomingSemanticAt = pyGet(incomingTiming, "semanticUpdatedAtUtc");
    const semanticChanged = changed && (
      existing === null
      || !pyTruthy(incomingSemanticAt)
      || !pyEquals(pyGet(existingTiming, "semanticUpdatedAtUtc"), incomingSemanticAt)
    );
    connection.run(`
            INSERT INTO worker_tasks(
              source_id, task_id, title, state, phase, summary_json, plan_json,
              workflow_json, timing_json, blockers_json, evidence_json, stop_events_json, progress_sequence,
              progress_sha256, progress_path, started_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, task_id) DO UPDATE SET
              title = excluded.title,
              state = excluded.state,
              phase = excluded.phase,
              summary_json = excluded.summary_json,
              plan_json = excluded.plan_json,
              workflow_json = excluded.workflow_json,
              timing_json = excluded.timing_json,
              blockers_json = excluded.blockers_json,
              evidence_json = excluded.evidence_json,
              stop_events_json = excluded.stop_events_json,
              progress_sequence = excluded.progress_sequence,
              progress_sha256 = excluded.progress_sha256,
              progress_path = excluded.progress_path,
              started_at_utc = COALESCE(worker_tasks.started_at_utc, excluded.started_at_utc),
              updated_at_utc = excluded.updated_at_utc
            `, [
      sourceId,
      taskId,
      boundedText(pyOr(pyGet(payload, "title"), taskId), 256),
      state,
      boundedText(pyOr(pyGet(payload, "phase"), "execution"), 64),
      jsonText(summary),
      jsonText(pyOr(pyGet(payload, "plan"), [])),
      jsonText(pyOr(pyGet(payload, "workflow"), {})),
      jsonText(pyOr(pyGet(payload, "timing"), {})),
      jsonText(pyOr(pyOr(pyGet(payload, "blockers"), pyGet(summary, "blockers")), [])),
      jsonText(pyOr(pyGet(payload, "evidence"), [])),
      jsonText(pyOr(pyGet(payload, "stopEvents"), [])),
      progressSequence,
      progressSha,
      boundedText(pyOr(pyGet(payload, "progressPath"), ""), 2048),
      boundedText(pyGet(payload, "startedAtUtc"), 64),
      updated,
    ]);
    const incomingAgentIds = [];
    for (const agent of agents) {
      const agentId = requireId(pyGet(agent, "agentId"), "agentId");
      incomingAgentIds.push(agentId);
      const agentState = pyStr(pyOr(pyGet(agent, "state"), "running"));
      if (!AGENT_STATES.has(agentState)) throw valueError(`Unsupported worker agent state: ${agentState}`);
      let parent = pyGet(agent, "parentAgentId");
      if (pyTruthy(parent)) parent = requireId(parent, "parentAgentId");
      const existingAgent = connection.get("SELECT statistics_json FROM worker_agents WHERE agent_id = ?", [agentId]);
      const statistics = mergeAgentStatistics(
        existingAgent !== null ? jsonValue(existingAgent.statistics_json, {}) : {},
        Object.hasOwn(agent, "statistics") && agent.statistics !== undefined ? agent.statistics : {},
      );
      connection.run(`
                INSERT INTO worker_agents(
                  agent_id, source_id, task_id, parent_agent_id, kind, role, provider,
                  state, current_action, last_completed, next_action, blockers_json,
                  can_interrupt, started_at_utc, last_heartbeat_utc, semantic_updated_at_utc,
                  statistics_json, updated_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                  source_id = excluded.source_id,
                  task_id = excluded.task_id,
                  parent_agent_id = excluded.parent_agent_id,
                  kind = excluded.kind,
                  role = excluded.role,
                  provider = excluded.provider,
                  state = CASE
                    WHEN worker_agents.state = 'cancellation_requested'
                     AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    THEN worker_agents.state
                    ELSE excluded.state
                  END,
                  current_action = CASE
                    WHEN worker_agents.state = 'cancellation_requested'
                     AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    THEN worker_agents.current_action
                    ELSE excluded.current_action
                  END,
                  last_completed = excluded.last_completed,
                  next_action = excluded.next_action,
                  blockers_json = excluded.blockers_json,
                  can_interrupt = excluded.can_interrupt,
                  started_at_utc = COALESCE(worker_agents.started_at_utc, excluded.started_at_utc),
                  last_heartbeat_utc = excluded.last_heartbeat_utc,
                  semantic_updated_at_utc = excluded.semantic_updated_at_utc,
                  statistics_json = excluded.statistics_json,
                  updated_at_utc = excluded.updated_at_utc
                `, [
        agentId,
        sourceId,
        taskId,
        parent,
        boundedText(pyOr(pyGet(agent, "kind"), "primary"), 32),
        boundedText(pyOr(pyGet(agent, "role"), "child-project-agent"), 128),
        boundedText(pyGet(agent, "provider"), 64),
        agentState,
        boundedText(pyOr(pyGet(agent, "currentAction"), ""), 512),
        boundedText(pyGet(agent, "lastCompleted"), 512),
        boundedText(pyGet(agent, "nextAction"), 512),
        jsonText(pyOr(pyGet(agent, "blockers"), [])),
        pyTruthy(pyGet(agent, "canInterrupt")) ? 1 : 0,
        boundedText(pyGet(agent, "startedAtUtc"), 64),
        boundedText(pyOr(pyGet(agent, "lastHeartbeatUtc"), updated), 64),
        boundedText(pyOr(pyOr(pyGet(agent, "semanticUpdatedAtUtc"), pyGet(agent, "updatedAtUtc")), updated), 64),
        jsonText(statistics),
        boundedText(pyOr(pyGet(agent, "updatedAtUtc"), updated), 64),
      ]);
    }
    if (incomingAgentIds.length > 0) {
      const placeholders = incomingAgentIds.map(() => "?").join(",");
      connection.run(
        `DELETE FROM worker_agents WHERE source_id = ? AND task_id = ? AND agent_id NOT IN (${placeholders})`,
        [sourceId, taskId, ...incomingAgentIds],
      );
    } else {
      connection.run("DELETE FROM worker_agents WHERE source_id = ? AND task_id = ?", [sourceId, taskId]);
    }
    if (semanticChanged) {
      addEvent(connection, "worker.progress_updated", {
        payload: { sourceId, taskId, state, sequence: progressSequence },
        atUtc: pyOr(incomingSemanticAt, updated),
      });
    }
    const row = connection.get("SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?", [sourceId, taskId]);
    return commit(connection, {
      updated: changed,
      semanticUpdated: semanticChanged,
      reason: "stored",
      task: workerTaskFromRow(row),
    });
  });
}

function commandRequestCancel(connection, payload) {
  let itemId = pyGet(payload, "itemId");
  let taskId = pyGet(payload, "taskId");
  let agentId = pyGet(payload, "agentId");
  let sourceId = pyGet(payload, "sourceId");
  if (pyTruthy(sourceId)) sourceId = requireId(sourceId, "sourceId");
  let targetAgent = null;
  let workerTask = null;
  let workerAgent = null;
  if (pyTruthy(itemId)) {
    itemId = requireItemId(itemId);
  } else if (pyTruthy(taskId)) {
    taskId = requireId(taskId, "taskId");
    const queueRows = connection.all(
      "SELECT item_id FROM queue_items WHERE task_id = ? AND (? IS NULL OR source_id = ?) ORDER BY created_at_utc DESC",
      [taskId, sourceId, sourceId],
    );
    if (!pyTruthy(sourceId) && queueRows.length > 1) {
      throw valueError(`Task ID ${pyRepr(taskId)} is ambiguous; provide sourceId`);
    }
    const row = queueRows[0] ?? null;
    itemId = row !== null ? row.item_id : null;
    if (!pyTruthy(itemId)) {
      const workerRows = connection.all(
        "SELECT * FROM worker_tasks WHERE task_id = ? AND (? IS NULL OR source_id = ?) ORDER BY updated_at_utc DESC",
        [taskId, sourceId, sourceId],
      );
      if (!pyTruthy(sourceId) && workerRows.length > 1) {
        throw valueError(`Worker task ID ${pyRepr(taskId)} is ambiguous; provide sourceId`);
      }
      workerTask = workerRows[0] ?? null;
    }
  } else if (pyTruthy(agentId)) {
    agentId = requireId(agentId, "agentId");
    targetAgent = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
    itemId = targetAgent !== null ? targetAgent.item_id : null;
    if (!pyTruthy(itemId)) {
      workerAgent = connection.get("SELECT * FROM worker_agents WHERE agent_id = ?", [agentId]);
      if (workerAgent !== null) {
        workerTask = connection.get("SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?",
          [workerAgent.source_id, workerAgent.task_id]);
      }
    }
  } else {
    throw valueError("Cancellation requires itemId, taskId, or agentId");
  }
  if (!pyTruthy(itemId) && workerTask === null) throw valueError("Cancellation target does not exist");
  const reason = boundedText(pyOr(pyGet(payload, "reason"), "Cancellation requested"), 1024);
  const now = utcNow();

  return immediate(connection, () => {
    if (workerTask !== null) {
      const terminalWorkerStates = ["cancelled", "completed", "failed"];
      let targetState;
      if (workerAgent !== null) {
        const terminalAgentStates = ["interrupted", "completed", "failed", "stop_unconfirmed"];
        const targetAgentState = terminalAgentStates.includes(workerAgent.state)
          ? workerAgent.state : "cancellation_requested";
        connection.run(`
                    UPDATE worker_agents SET state = ?, current_action = ?, updated_at_utc = ?
                    WHERE agent_id = ?
                    `, [targetAgentState, reason, now, agentId]);
        targetState = workerTask.state;
      } else {
        targetState = terminalWorkerStates.includes(workerTask.state) ? workerTask.state : "cancelling";
        const summary = jsonValue(workerTask.summary_json, {});
        if (Array.isArray(summary)) {
          throw new PythonError("TypeError", "list indices must be integers or slices, not str");
        }
        if (!isDict(summary)) {
          throw new PythonError("TypeError", `'${pyTypeName(summary)}' object does not support item assignment`);
        }
        summary.now = reason;
        connection.run(`
                    UPDATE worker_tasks
                    SET state = ?, phase = 'cancellation', summary_json = ?, updated_at_utc = ?
                    WHERE source_id = ? AND task_id = ?
                    `, [targetState, jsonText(summary), now, workerTask.source_id, workerTask.task_id]);
        connection.run(`
                    UPDATE worker_agents
                    SET state = 'cancellation_requested', current_action = ?, updated_at_utc = ?
                    WHERE source_id = ? AND task_id = ?
                      AND state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    `, [reason, now, workerTask.source_id, workerTask.task_id]);
      }
      addEvent(connection, "control.external_cancellation_requested", {
        agentId,
        payload: {
          scope: pyTruthy(agentId) ? "agent" : "task",
          sourceId: workerTask.source_id,
          taskId: workerTask.task_id,
          reason,
          state: targetState,
        },
        atUtc: now,
      });
      return commit(connection, {
        item: null,
        external: true,
        sourceId: workerTask.source_id,
        taskId: workerTask.task_id,
        agentId,
        state: targetState,
      });
    }

    const row = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    if (row === null) throw valueError(`Queue item does not exist: ${pyStr(itemId)}`);
    let targetState;
    if (pyTruthy(agentId)) {
      if (targetAgent === null) throw valueError(`Agent does not exist: ${pyStr(agentId)}`);
      const terminalAgentStates = ["interrupted", "completed", "failed", "stop_unconfirmed"];
      const targetAgentState = terminalAgentStates.includes(targetAgent.state)
        ? targetAgent.state : "cancellation_requested";
      connection.run(`
                UPDATE agents SET state = ?, current_action = ?, updated_at_utc = ?
                WHERE agent_id = ?
                `, [targetAgentState, reason, now, agentId]);
      targetState = row.state;
    } else {
      if (TERMINAL_STATES.has(row.state)) targetState = row.state;
      else if (["queued", "waiting", "blocked"].includes(row.state)) targetState = "cancelled";
      else targetState = "cancelling";
      connection.run(`
                UPDATE queue_items
                SET state = ?, phase = 'cancellation', current_action = ?, updated_at_utc = ?,
                    finished_at_utc = CASE WHEN ? = 'cancelled' THEN COALESCE(finished_at_utc, ?) ELSE finished_at_utc END
                WHERE item_id = ?
                `, [targetState, reason, now, targetState, now, itemId]);
      connection.run(`
                UPDATE agents SET state = 'cancellation_requested', current_action = ?, updated_at_utc = ?
                WHERE item_id = ? AND state IN ('starting', 'running', 'waiting', 'blocked')
                `, [reason, now, itemId]);
    }
    addEvent(connection, "control.cancellation_requested", {
      itemId,
      agentId,
      payload: { scope: pyTruthy(agentId) ? "agent" : "task", reason, state: targetState },
      atUtc: now,
    });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { item: itemFromRow(updated), agentId });
  });
}

function commandRetry(connection, payload) {
  const itemId = requireItemId(pyGet(payload, "itemId"));
  const now = utcNow();
  return immediate(connection, () => {
    const control = connection.get("SELECT mode FROM control_state WHERE singleton_id = 1");
    if (control.mode === "emergency_stopped") throw valueError("Resume control before retrying an item");
    const row = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    if (row === null) throw valueError(`Queue item does not exist: ${itemId}`);
    if (!inSet(RETRYABLE_STATES, row.state)) {
      throw valueError(`Queue item ${itemId} is not retryable from state ${pyStr(row.state)}`);
    }
    connection.run(`
            UPDATE queue_items
            SET state = 'queued', phase = 'retry-queued', current_action = 'Waiting for retry',
                thread_id = NULL, turn_id = NULL, lease_token = NULL, lease_owner = NULL,
                lease_expires_at_utc = NULL, error = NULL, final_decision = NULL,
                decision_reference = NULL, finished_at_utc = NULL, updated_at_utc = ?
            WHERE item_id = ?
            `, [now, itemId]);
    connection.run("DELETE FROM agents WHERE item_id = ?", [itemId]);
    addEvent(connection, "queue.item_retried", { itemId, atUtc: now });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { item: itemFromRow(updated) });
  });
}

function commandFinalizeStop(connection, payload) {
  const reason = boundedText(pyOr(pyGet(payload, "reason"), "Stop confirmation timed out"), 1024);
  const now = utcNow();
  return immediate(connection, () => {
    const queueRows = connection.all("SELECT item_id FROM queue_items WHERE state = 'cancelling'");
    connection.run(`
            UPDATE queue_items
            SET state = 'stop_unconfirmed', phase = 'stopped', current_action = ?,
                lease_token = NULL, lease_owner = NULL, lease_expires_at_utc = NULL,
                finished_at_utc = COALESCE(finished_at_utc, ?), updated_at_utc = ?
            WHERE state = 'cancelling'
            `, [reason, now, now]);
    connection.run(`
            UPDATE agents
            SET state = 'stop_unconfirmed', current_action = ?, can_interrupt = 0, updated_at_utc = ?
            WHERE state = 'cancellation_requested'
            `, [reason, now]);
    const workerRows = connection.all("SELECT source_id, task_id FROM worker_tasks WHERE state = 'cancelling'");
    connection.run(`
            UPDATE worker_tasks
            SET state = 'stop_unconfirmed', phase = 'stopped', updated_at_utc = ?
            WHERE state = 'cancelling'
            `, [now]);
    connection.run(`
            UPDATE worker_agents
            SET state = 'stop_unconfirmed', current_action = ?, can_interrupt = 0, updated_at_utc = ?
            WHERE state = 'cancellation_requested'
            `, [reason, now]);
    const queueItems = queueRows.map((row) => row.item_id);
    const workerTasks = workerRows.map((row) => `${pyStr(row.source_id)}:${pyStr(row.task_id)}`);
    addEvent(connection, "control.stop_confirmation_timed_out", {
      payload: { reason, queueItems, workerTasks: [...workerTasks] },
      atUtc: now,
    });
    return commit(connection, { queueItems: [...queueItems], workerTasks, reason });
  });
}

function commandRecover(connection) {
  const nowMicros = nowMicroseconds();
  const now = isoFromMicroseconds(nowMicros);
  const recovered = [];
  return immediate(connection, () => {
    const rows = connection.all(`
            SELECT * FROM queue_items
            WHERE state IN ('leased', 'review_running', 'decision_validating', 'integrating', 'cancelling')
              AND lease_expires_at_utc IS NOT NULL
            `);
    for (const row of rows) {
      const expires = parseUtcMicroseconds(row.lease_expires_at_utc);
      if (expires === null || expires > nowMicros) continue;
      let target;
      let action;
      if (row.state === "leased" && !pyTruthy(row.thread_id)) {
        target = "queued";
        action = "Recovered expired pre-turn lease";
      } else if (row.state === "cancelling") {
        target = "stop_unconfirmed";
        action = "Cancellation lease expired without provider confirmation";
      } else {
        target = "recovery_required";
        action = "Provider reconciliation required after lease expiry";
      }
      connection.run(`
                UPDATE queue_items
                SET state = ?, phase = 'recovery', current_action = ?, lease_token = NULL,
                    lease_owner = NULL, lease_expires_at_utc = NULL, updated_at_utc = ?
                WHERE item_id = ?
                `, [target, action, now, row.item_id]);
      addEvent(connection, "queue.lease_recovered", {
        itemId: row.item_id,
        payload: { from: row.state, to: target },
        atUtc: now,
      });
      recovered.push({ itemId: row.item_id, from: row.state, to: target });
    }
    return commit(connection, { recovered });
  });
}

function commandUpsertAgent(connection, payload) {
  const agentId = requireId(pyGet(payload, "agentId"), "agentId");
  const itemId = requireItemId(pyGet(payload, "itemId"));
  let parent = pyGet(payload, "parentAgentId");
  if (pyTruthy(parent)) parent = requireId(parent, "parentAgentId");
  const state = pyStr(pyOr(pyGet(payload, "state"), "registered"));
  if (!AGENT_STATES.has(state)) throw valueError(`Unsupported agent state: ${state}`);
  const now = utcNow();
  const starting = state === "starting" || state === "running";
  const started = pyOr(pyGet(payload, "startedAtUtc"), starting ? now : null);
  const heartbeat = pyOr(pyGet(payload, "lastHeartbeatUtc"), starting ? now : null);
  const existingAgent = connection.get("SELECT statistics_json FROM agents WHERE agent_id = ?", [agentId]);
  const statistics = mergeAgentStatistics(
    existingAgent !== null ? jsonValue(existingAgent.statistics_json, {}) : {},
    Object.hasOwn(payload, "statistics") && payload.statistics !== undefined ? payload.statistics : {},
  );
  connection.run(`
        INSERT INTO agents(
          agent_id, item_id, parent_agent_id, kind, role, provider, state,
          current_action, last_completed, next_action, blockers_json,
          thread_id, turn_id, can_interrupt, started_at_utc,
          last_heartbeat_utc, statistics_json, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          item_id = excluded.item_id,
          parent_agent_id = COALESCE(excluded.parent_agent_id, agents.parent_agent_id),
          kind = excluded.kind,
          role = excluded.role,
          provider = excluded.provider,
          state = CASE
            WHEN agents.state = 'cancellation_requested'
             AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
            THEN agents.state
            ELSE excluded.state
          END,
          current_action = CASE
            WHEN agents.state = 'cancellation_requested'
             AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
            THEN agents.current_action
            ELSE excluded.current_action
          END,
          last_completed = excluded.last_completed,
          next_action = excluded.next_action,
          blockers_json = excluded.blockers_json,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          can_interrupt = excluded.can_interrupt,
          started_at_utc = COALESCE(agents.started_at_utc, excluded.started_at_utc),
          last_heartbeat_utc = excluded.last_heartbeat_utc,
          statistics_json = excluded.statistics_json,
          updated_at_utc = excluded.updated_at_utc
        `, [
    agentId,
    itemId,
    parent,
    boundedText(pyOr(pyGet(payload, "kind"), "primary"), 32),
    boundedText(pyOr(pyGet(payload, "role"), "worker"), 128),
    boundedText(pyGet(payload, "provider"), 64),
    state,
    boundedText(pyOr(pyGet(payload, "currentAction"), ""), 512),
    boundedText(pyGet(payload, "lastCompleted"), 512),
    boundedText(pyGet(payload, "nextAction"), 512),
    jsonText(pyGet(payload, "blockers", [])),
    boundedText(pyGet(payload, "threadId"), 256),
    boundedText(pyGet(payload, "turnId"), 256),
    pyTruthy(pyGet(payload, "canInterrupt")) ? 1 : 0,
    started,
    heartbeat,
    jsonText(statistics),
    now,
  ]);
  addEvent(connection, "agent.preview_updated", {
    itemId,
    agentId,
    payload: { state, currentAction: boundedText(pyOr(pyGet(payload, "currentAction"), ""), 256) },
    atUtc: now,
  });
  const row = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
  return { agent: agentFromRow(row) };
}

function commandUpsertAgentStatistics(connection, payload) {
  const agentId = requireId(pyGet(payload, "agentId"), "agentId");
  const incoming = agentStatistics(pyGet(payload, "statistics"));
  const row = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
  if (row === null) throw valueError(`Agent does not exist: ${agentId}`);
  const merged = mergeAgentStatistics(jsonValue(row.statistics_json, {}), incoming);
  const now = utcNow();
  connection.run("UPDATE agents SET statistics_json = ? WHERE agent_id = ?", [jsonText(merged), agentId]);
  addEvent(connection, "agent.statistics_updated", {
    itemId: row.item_id,
    agentId,
    payload: {
      tokenStatus: pyGet(pyGet(merged, "tokens", {}), "status", "unavailable"),
      costStatus: pyGet(pyGet(merged, "cost", {}), "status", "unavailable"),
    },
    atUtc: now,
  });
  const updated = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
  return { agent: agentFromRow(updated) };
}

function commandAddEvent(connection, payload) {
  let itemId = pyGet(payload, "itemId");
  let agentId = pyGet(payload, "agentId");
  if (pyTruthy(itemId)) itemId = requireItemId(itemId);
  if (pyTruthy(agentId)) agentId = requireId(agentId, "agentId");
  const eventType = boundedText(pyOr(pyGet(payload, "type"), "custom.event"), 128);
  const sequence = addEvent(connection, eventType, { itemId, agentId, payload: pyOr(pyGet(payload, "data"), {}) });
  return { sequence };
}

/** command_snapshot; the read-only snapshot reader runs the same function. */
export function commandSnapshot(connection, payload) {
  const eventLimit = pyClampInt(pyGet(payload, "eventLimit", 200), 0, 1000);
  const control = connection.get("SELECT * FROM control_state WHERE singleton_id = 1") ?? undefinedRow();
  const items = connection.all(`
        SELECT * FROM queue_items
        ORDER BY
          CASE WHEN state IN ('leased','review_running','decision_validating','integrating','cancelling','recovery_required')
               THEN 0 WHEN state = 'queued' THEN 1 ELSE 2 END,
          priority DESC, dispatch_sequence ASC, created_at_utc ASC
        `).map(itemFromRow);
  const agents = connection.all("SELECT * FROM agents ORDER BY item_id, parent_agent_id, agent_id").map(agentFromRow);
  const workerTasks = connection.all("SELECT * FROM worker_tasks ORDER BY updated_at_utc DESC, source_id, task_id")
    .map(workerTaskFromRow);
  const workerAgents = connection.all("SELECT * FROM worker_agents ORDER BY source_id, task_id, parent_agent_id, agent_id")
    .map(workerAgentFromRow);
  const eventRows = connection.all("SELECT * FROM events ORDER BY sequence DESC LIMIT ?", [eventLimit]);
  const events = eventRows.reverse().map(eventFromRow);
  const sequence = connection.value("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events");
  const counts = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return {
    formatVersion: FORMAT_VERSION,
    sequence: pyInt(sequence),
    control: { mode: control.mode, reason: control.reason, updatedAtUtc: control.updated_at_utc },
    counts,
    items,
    agents,
    workerTasks,
    workerAgents,
    events,
  };
}

/** Path.expanduser(): a leading "~" is the home folder. */
function expandUser(text) {
  return /^~(?:$|[\/])/u.test(text) ? path.join(homedir(), text.slice(1)) : text;
}

/** time.strftime("%Y%m%dT%H%M%SZ") of a UTC time. */
function compactStamp(microseconds) {
  return new Date(Math.floor(microseconds / 1000)).toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "")
    .concat("Z");
}

function commandCompact(connection, payload) {
  const retentionDays = pyClampInt(pyGet(payload, "retentionDays", 30), 1, 3650);
  const archiveRoot = resolvedDatabasePath(expandUser(pyStr(pyOr(pyGet(payload, "archiveRoot"), ""))) || ".");
  mkdirSync(archiveRoot, { recursive: true });
  const cutoff = isoFromMicroseconds(nowMicroseconds() - retentionDays * 86_400_000_000);
  const terminalPlaceholders = FINAL_STATES.map(() => "?").join(",");
  const rows = connection.all(`
        SELECT events.* FROM events
        LEFT JOIN queue_items ON queue_items.item_id = events.item_id
        WHERE events.at_utc < ?
          AND (events.item_id IS NULL OR queue_items.state IN (${terminalPlaceholders}))
        ORDER BY events.sequence
        `, [cutoff, ...FINAL_STATES]);
  if (rows.length === 0) return { archivedEvents: 0, cutoffUtc: cutoff, archive: null };

  const firstSequence = rows[0].sequence;
  const lastSequence = rows.at(-1).sequence;
  const stamp = compactStamp(nowMicroseconds());
  const fileName = `control-events-${firstSequence}-${lastSequence}-${stamp}.jsonl.gz`;
  const archivePath = path.join(archiveRoot, fileName);
  const lines = rows.map((row) => `${pythonJson(eventFromRow(row))}\n`).join("");
  const uncompressed = utf8(lines);
  writeFileSync(archivePath, gzipSync(uncompressed, { level: 9 }));
  const compressedHash = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const manifest = {
    schemaVersion: 1,
    archiveFile: fileName,
    eventCount: rows.length,
    firstSequence,
    lastSequence,
    uncompressedSha256: createHash("sha256").update(uncompressed).digest("hex"),
    compressedSha256: compressedHash,
    createdAtUtc: utcNow(),
  };
  const manifestPath = `${archivePath}.manifest.json`;
  // Path.write_text writes the platform's line endings.
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, process.platform === "win32" ? manifestText.replaceAll("\n", "\r\n") : manifestText, "utf8");

  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.run("DELETE FROM events WHERE sequence >= ? AND sequence <= ?", [firstSequence, lastSequence]);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    for (const file of [archivePath, manifestPath]) {
      try { unlinkSync(file); } catch { /* missing_ok */ }
    }
    throw error;
  }
  connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { archivedEvents: rows.length, cutoffUtc: cutoff, archive: manifest };
}

export const CONTROL_COMMANDS = Object.freeze({
  init: commandInit,
  enqueue: commandEnqueue,
  claim: commandClaim,
  accept: commandAccept,
  transition: commandTransition,
  heartbeat: commandHeartbeat,
  "set-mode": commandSetMode,
  "upsert-progress": commandUpsertProgress,
  "request-cancel": commandRequestCancel,
  "finalize-stop": commandFinalizeStop,
  retry: commandRetry,
  recover: commandRecover,
  "upsert-agent": commandUpsertAgent,
  "upsert-agent-statistics": commandUpsertAgentStatistics,
  "add-event": commandAddEvent,
  snapshot: commandSnapshot,
  compact: commandCompact,
});

/**
 * One run of `sqlite-control-store.py --database <path> <command>`: resolves
 * to the result, or throws an error whose `pythonMessage` is what the script
 * wrote as `error` and whose `exitCode` is the script's exit code.
 */
export function runControlCommand(sqlite, databasePath, command, payload) {
  try {
    if (typeof command !== "string" || !Object.hasOwn(CONTROL_COMMANDS, command)) {
      // argparse's usage and error lines (Python 3.12), exit code 2.
      const names = Object.keys(CONTROL_COMMANDS).sort();
      const error = new PythonError("SystemExit", [
        "usage: sqlite-control-store.py [-h] --database DATABASE",
        `${" ".repeat(31)}{${names.join(",")}}`,
        `sqlite-control-store.py: error: argument command: invalid choice: ${pyRepr(pyStr(command))} `
          + `(choose from ${names.join(", ")})`,
      ].join("\n"));
      error.exitCode = 2;
      throw error;
    }
    const request = jsonTransport(payload);
    if (!isDict(request)) throw valueError("Command payload must be a JSON object");
    const connection = connect(sqlite, databasePath);
    try {
      migrate(connection);
      return CONTROL_COMMANDS[command](connection, request);
    } finally {
      connection.close();
    }
  } catch (error) {
    error.exitCode ??= 1;
    error.pythonMessage ??= error instanceof PythonError ? error.message : String(error?.message ?? error);
    throw error;
  }
}

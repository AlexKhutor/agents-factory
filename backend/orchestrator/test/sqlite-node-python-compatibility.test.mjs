import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { ProjectMemoryStore, createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { NodeProjectMemoryBridge } from "../src/project-memory-store-node.mjs";
import { ConversationArchive, createConversationArchive } from "../src/conversation-archive.mjs";
import { NodeConversationArchiveBridge } from "../src/conversation-archive-store-node.mjs";
import { PersistentSqliteBridge } from "../src/sqlite-bridge-server.mjs";
import { SqliteControlStore } from "../src/sqlite-control-store.mjs";
import { SqliteControlSnapshotReader } from "../src/sqlite-control-snapshot-reader.mjs";
import { loadNodeSqlite } from "../src/sqlite-backend.mjs";
import { sqliteBackendUnavailable } from "./fixtures/sqlite-backends/helpers.mjs";
import { ARCHIVE_BINDING, COUNTER_KEY, archiveRecord } from "./fixtures/sqlite-backends/shared.mjs";

// The node:sqlite stores against the Python bridges they replace: the same
// commands give the same answers, error codes and stored bytes; a database one
// wrote is read and changed by the other; both work on one file at once.

const sqlite = await loadNodeSqlite();
const skip = sqliteBackendUnavailable("node") ?? sqliteBackendUnavailable("python") ?? false;
const SOURCE = fileURLToPath(new URL("../src/", import.meta.url));
const WORKER = fileURLToPath(new URL("./fixtures/sqlite-backends/worker.mjs", import.meta.url));
const PYTHON = process.env.PYTHON || "python";

async function temporary(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

async function controllerRoot(t, prefix) {
  const root = await temporary(t, prefix);
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ sourceId: "controller" }));
  return root;
}

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 1, 0, 0, 0, 0) + 1000 * tick++);
}

function python(script, ...args) {
  const result = spawnSync(PYTHON, ["-c", script, ...args], { encoding: "utf8", windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Every table, the schema, the user version and the journal mode of a database. */
function dump(databasePath) {
  const db = new sqlite.DatabaseSync(databasePath);
  try {
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
      .map((row) => ({ ...row }));
    const content = {};
    for (const { name } of schema.filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"))) {
      content[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((row) => ({ ...row }));
    }
    return {
      userVersion: db.prepare("PRAGMA user_version").get().user_version,
      journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
      schema,
      content,
    };
  } finally {
    db.close();
  }
}

const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const STAMP = /\d{8}T\d{6}Z/gu;

/** Times the store took from the clock, lease tokens and archive stamps replaced. */
function normalized(value) {
  if (typeof value === "string") {
    // argparse quotes the choices up to Python 3.13 ('a', 'b') and not from 3.14 (a, b): the same message.
    return value.replace(TIME, "<time>").replace(UUID, "<uuid>").replace(STAMP, "<stamp>")
      .replace(/\(choose from ([^)]*)\)/gu, (_, list) => `(choose from ${list.replace(/'/gu, "")})`);
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

function bridgeCode(error) {
  try {
    return JSON.parse(error.stderr.trim().split(/\r?\n/u).at(-1)).error;
  } catch {
    return `unparsed: ${error?.message}`;
  }
}

async function outcome(call) {
  try {
    return { ok: await call() };
  } catch (error) {
    return { error: error.code ?? error.message };
  }
}

async function rawOutcome(call) {
  try {
    return { ok: await call() };
  } catch (error) {
    return { error: bridgeCode(error) };
  }
}

function pythonMemoryBridge(databasePath) {
  return new PersistentSqliteBridge({ databasePath, bridgePath: path.join(SOURCE, "project-memory-store.py"),
    unavailableCode: "memory_unavailable" });
}

function pythonArchiveBridge(databasePath) {
  return new PersistentSqliteBridge({ databasePath, bridgePath: path.join(SOURCE, "conversation-archive-store.py"),
    unavailableCode: "archive_unavailable" });
}

const entry = (id, text = `text ${id}`) => ({ id, title: `Title ${id}`, text });

async function memoryScenario(bridge) {
  const store = new ProjectMemoryStore({ store: bridge, now: fixedClock() });
  const results = [];
  const step = async (name, call) => results.push([name, await outcome(call)]);
  const raw = async (name, command, payload) => results.push([name, await rawOutcome(() => bridge.invoke(command, payload))]);
  const scope = (scopeId, kind, projectId, quarterId, operationId) => ({
    scopeId, kind, projectId, quarterId, title: `${kind} ${scopeId}`, operationId });
  const unicode = [entry("u1", "line\nwith \"quotes\", \\ backslash,\ttab, é, Привет, \u{1f600}"),
    { id: "u2", title: "\u{1f600} title", text: "" }];

  await step("init", () => store.initialize());
  await step("quarter-before-project", () => store.createScope(scope("q1", "quarter", "p", "q", "op-q1")));
  await step("project", () => store.createScope(scope("p1", "project", "p", null, "op-p1")));
  await step("project-replay", () => store.createScope(scope("p1", "project", "p", null, "op-p1")));
  await step("project-operation-conflict", () => store.createScope(scope("p2", "project", "p2", null, "op-p1")));
  await step("project-duplicate", () => store.createScope(scope("p3", "project", "p", null, "op-p3")));
  await step("quarter", () => store.createScope(scope("q1", "quarter", "p", "q", "op-q1")));
  await step("quarter-9", () => store.createScope(scope("q9", "quarter", "p", "9", "op-q9")));
  await step("quarter-10", () => store.createScope(scope("q10", "quarter", "p", "10", "op-q10")));
  await step("agent", () => store.createScope(scope("agent-memory:solver", "agent", "p", "q", "op-a1")));
  await step("agent-missing-quarter", () => store.createScope(scope("agent-memory:x", "agent", "p", "none", "op-a2")));
  await step("authorize", () => store.authorizeWrite({ commandId: "c1", scopeId: "p1", expectedRevision: 1,
    entries: unicode, requestedBy: "owner" }));
  await step("authorize-replay", () => store.authorizeWrite({ commandId: "c1", scopeId: "p1", expectedRevision: 1,
    entries: unicode, requestedBy: "owner" }));
  await step("authorize-conflict", () => store.authorizeWrite({ commandId: "c1", scopeId: "p1", expectedRevision: 1,
    entries: [entry("other")], requestedBy: "owner" }));
  await step("authorize-stale", () => store.authorizeWrite({ commandId: "c2", scopeId: "p1", expectedRevision: 5,
    entries: [], requestedBy: "owner" }));
  await step("write-missing-grant", () => store.write({ scopeId: "p1", expectedRevision: 1, entries: unicode,
    operationId: "w0", commandId: "none", actorId: "agent" }));
  await step("write-mismatch", () => store.write({ scopeId: "p1", expectedRevision: 1, entries: [entry("x")],
    operationId: "w1", commandId: "c1", actorId: "agent" }));
  await step("write", () => store.write({ scopeId: "p1", expectedRevision: 1, entries: unicode,
    operationId: "w1", commandId: "c1", actorId: "agent" }));
  await step("write-replay", () => store.write({ scopeId: "p1", expectedRevision: 1, entries: unicode,
    operationId: "w1", commandId: "c1", actorId: "agent" }));
  await step("write-operation-conflict", () => store.write({ scopeId: "p1", expectedRevision: 1, entries: unicode,
    operationId: "w1", commandId: "c1", actorId: "someone-else" }));
  await step("write-consumed", () => store.write({ scopeId: "p1", expectedRevision: 1, entries: unicode,
    operationId: "w2", commandId: "c1", actorId: "agent" }));
  await step("authorize-agent", () => store.authorizeWrite({ commandId: "c3", scopeId: "agent-memory:solver",
    expectedRevision: 1, entries: [entry("role", "solver")], requestedBy: "owner" }));
  await step("write-agent", () => store.write({ scopeId: "agent-memory:solver", expectedRevision: 1,
    entries: [entry("role", "solver")], operationId: "w3", commandId: "c3", actorId: "owner" }));
  await step("read", () => store.readScope({ scopeId: "p1" }));
  await step("read-revision-1", () => store.readScope({ scopeId: "p1", revision: 1 }));
  await step("read-revision-9", () => store.readScope({ scopeId: "p1", revision: 9 }));
  await step("read-missing", () => store.readScope({ scopeId: "missing" }));
  await step("read-scopes", () => store.readScopes({ scopeIds: ["p1", "missing", "agent-memory:solver", "q1"] }));
  await step("read-pair", () => store.readPair({ projectId: "p", quarterId: "q" }));
  await step("read-pair-missing", () => store.readPair({ projectId: "p", quarterId: "missing" }));
  await step("list", () => store.listScopes());
  await step("list-project", () => store.listScopes({ projectId: "p" }));
  // Both implementations hash a mapping with several integer-like keys the way
  // json.dumps(sort_keys=True) orders them, unlike the JS canonical form.
  await step("copy-integer-like-quarters", () => store.copyProject({ sourceProjectId: "p", targetProjectId: "p-copy",
    targetProjectScopeId: "pc", quarterScopeIds: { q: "qc", 9: "qc9", 10: "qc10" }, operationId: "copy-1" }));
  await step("copy-incomplete", () => store.copyProject({ sourceProjectId: "p", targetProjectId: "p-copy",
    targetProjectScopeId: "pc", quarterScopeIds: { q: "qc" }, operationId: "copy-2" }));
  await step("document-missing", () => store.readDocument({ key: "d1" }));
  await step("document-wrong-revision", () => store.compareAndSwapDocument({ key: "d1", expectedRevision: 1,
    value: { a: 1 } }));
  const document = { b: [1.5, 1e-7, 0.0001, 1e21, 123456789.125, -3, 0, "x"], a: { z: null, y: true },
    10: "ten", 9: "nine", "￿": "bmp", "\u{1f600}": "astral", "é": "e", nested: [{ k: "v", a: [] }] };
  await step("document-create", () => store.compareAndSwapDocument({ key: "d1", expectedRevision: 0, value: document }));
  await step("document-read", () => store.readDocument({ key: "d1" }));
  await step("document-update", () => store.transactionDocument({ key: "d1", expectedRevision: 1, value: { n: 2 } }));
  await step("document-stale", () => store.compareAndSwapDocument({ key: "d1", expectedRevision: 1, value: { n: 3 } }));

  await raw("raw-unknown-command", "nope", {});
  await raw("raw-payload-not-object", "read-scope", ["p1"]);
  await raw("raw-missing-field", "read-scope", { scopeId: "p1" });
  await raw("raw-object-parameter", "read-scope", { scopeId: { id: "p1" }, revision: null });
  await raw("raw-boolean-revision", "read-scope", { scopeId: "p1", revision: true });
  await raw("raw-float-revision", "read-scope", { scopeId: "p1", revision: 1.5 });
  await raw("raw-string-limit", "list-scopes", { projectId: null, limit: "5" });
  await raw("raw-negative-limit", "list-scopes", { projectId: null, limit: -2 });
  await raw("raw-scope-set-not-list", "read-scope-set", { scopeIds: "p1" });
  await raw("raw-cas-missing-value", "compare-and-swap-document", { key: "d2", expectedRevision: 0 });
  await raw("raw-cas-stale-missing-value", "compare-and-swap-document", { key: "d2", expectedRevision: 4 });
  await raw("raw-lone-surrogate", "compare-and-swap-document", { key: "d3", expectedRevision: 0,
    value: { "\ud800": 1 } });
  await raw("raw-integer-too-large", "read-document", { key: 2 ** 64 });
  await raw("raw-request-hash", "create-scope", { ...scope("p9", "project", "p9", null, "op-p9"),
    requestSha256: "0".repeat(64), contentSha256: "0".repeat(64), updatedAtUtc: "2026-10-01T00:00:00.000Z" });
  await raw("raw-init-again", "init", {});
  return results;
}

test("project memory: node:sqlite gives the Python bridge's answers, error codes and stored bytes", { skip }, async (t) => {
  const root = await temporary(t, "memory-parity-");
  const pythonPath = path.join(root, "python.sqlite");
  const nodePath = path.join(root, "node.sqlite");
  const pythonBridge = pythonMemoryBridge(pythonPath);
  t.after(() => pythonBridge.close());
  const fromPython = await memoryScenario(pythonBridge);
  await pythonBridge.close();
  const fromNode = await memoryScenario(new NodeProjectMemoryBridge({ databasePath: nodePath, sqlite }));

  for (const [index, [name, expected]] of fromPython.entries()) {
    assert.deepEqual(fromNode[index], [name, expected], name);
  }
  assert.equal(JSON.stringify(fromNode), JSON.stringify(fromPython), "same key order in every answer");
  assert.deepEqual(dump(nodePath), dump(pythonPath));
  // The quirk both keep: JS and Python canonical JSON order such keys differently.
  assert.deepEqual(fromNode.find(([name]) => name === "copy-integer-like-quarters")[1], { error: "memory_invalid_input" });
});

async function archiveScenario(bridge) {
  const archive = new ConversationArchive({ store: bridge, projectId: "controller", now: fixedClock() });
  const results = [];
  const step = async (name, call) => results.push([name, await outcome(call)]);
  const raw = async (name, command, payload) => results.push([name, await rawOutcome(() => bridge.invoke(command, payload))]);
  const binding = { projectId: "controller", sourceId: "worker", providerId: "codex", threadId: "thread/é\u{1f600}" };
  const other = { ...binding, providerId: "claude" };
  const message = (recordId, text, extra = {}) => ({ ...archiveRecord(recordId, text), role: "user", ...extra });

  await step("init", () => bridge.invoke("init", { projectId: "controller" }));
  await step("init-foreign", () => bridge.invoke("init", { projectId: "foreign" }));
  await step("append", () => archive.append(binding, message("a", "first \u{1f600} é \"q\" \\")));
  await step("append-replay", () => archive.append(binding, message("a", "first \u{1f600} é \"q\" \\")));
  await step("append-changed", () => archive.append(binding, message("a", "first, edited")));
  await step("append-submission", () => archive.append(binding, message("s", "send", {
    kind: "submission", state: "requested", requestId: "req-1" })));
  await step("append-submission-changed", () => archive.append(binding, message("s", "changed", {
    kind: "submission", state: "requested", requestId: "req-1" })));
  await step("append-omission", () => archive.append(binding, { ...message("o", null), kind: "omission", role: null,
    state: "unknown", omissions: ["hidden_reasoning", "inline_media"] }));
  await step("append-other-binding", () => archive.append(other, message("a", "other provider")));
  // Two records that cannot share one 512 KiB page.
  await step("append-large-1", () => archive.append(binding, message("large-1", "x".repeat(262_144))));
  await step("append-large-2", () => archive.append(binding, message("large-2", "é".repeat(131_072))));
  await step("append-lone-surrogate", () => archive.append(binding, message("bad", "broken \ud800 text")));
  const first = await outcome(() => archive.read(binding, { limit: 2 }));
  results.push(["read-limit-2", first]);
  await step("read-next", () => archive.read(binding, { cursor: first.ok.nextCursor, limit: 100 }));
  await step("read-all", () => archive.read(binding, { limit: 100 }));
  await step("read-other", () => archive.read(other));
  await step("read-foreign-project", () => archive.read({ ...binding, projectId: "foreign" }));
  await step("checkpoint-state", () => archive.readImportCheckpoint(binding));
  await step("checkpoint", () => archive.checkpointImport(binding, { expectedRevision: 0, nextCursor: "next" }));
  await step("checkpoint-stale", () => archive.checkpointImport(binding, { expectedRevision: 0, nextCursor: "x" }));
  await step("checkpoint-exhausted", () => archive.checkpointImport(binding, { expectedRevision: 1, nextCursor: null }));
  await step("checkpoint-state-2", () => archive.readImportCheckpoint(binding));
  await step("checkpoint-new-conversation", () => archive.checkpointImport({ ...binding, threadId: "new" },
    { expectedRevision: 0, nextCursor: "c" }));

  const scopeOf = (value) => ({ conversationId: archive.binding(value).conversationId, binding: value });
  await raw("raw-unknown-command", "nope", { projectId: "controller" });
  await raw("raw-wrong-project", "read", { projectId: "foreign", ...scopeOf(binding), limit: 5, revision: null, after: 0 });
  await raw("raw-revision-ahead", "read", { projectId: "controller", ...scopeOf(binding), limit: 5, revision: 999,
    after: 0 });
  await raw("raw-after-beyond", "read", { projectId: "controller", ...scopeOf(binding), limit: 5, revision: 2,
    after: 3 });
  await raw("raw-limit-zero", "read", { projectId: "controller", ...scopeOf(binding), limit: 0, revision: null,
    after: 0 });
  await raw("raw-missing-field", "read", { projectId: "controller", ...scopeOf(binding), limit: 5 });
  await raw("raw-binding-mismatch", "import-state", { projectId: "controller", conversationId: scopeOf(binding).conversationId,
    binding: other });
  await raw("raw-payload-not-object", "read", "x");
  return results;
}

test("conversation archive: node:sqlite gives the Python bridge's answers, error codes and stored bytes", { skip }, async (t) => {
  const root = await temporary(t, "archive-parity-");
  const pythonPath = path.join(root, "python.sqlite");
  const nodePath = path.join(root, "node.sqlite");
  const pythonBridge = pythonArchiveBridge(pythonPath);
  t.after(() => pythonBridge.close());
  const fromPython = await archiveScenario(pythonBridge);
  await pythonBridge.close();
  const fromNode = await archiveScenario(new NodeConversationArchiveBridge({ databasePath: nodePath, sqlite }));

  for (const [index, [name, expected]] of fromPython.entries()) {
    assert.deepEqual(fromNode[index], [name, expected], name);
  }
  assert.equal(JSON.stringify(fromNode), JSON.stringify(fromPython), "same key order in every answer");
  const stored = dump(nodePath);
  assert.deepEqual(stored, dump(pythonPath));
  assert.equal(stored.journalMode, "delete", "the archive keeps SQLite's rollback journal");
  const pages = Object.fromEntries(fromNode);
  assert.equal(pages["read-limit-2"].ok.items.length, 2);
  assert.equal(pages["append-lone-surrogate"].error, "archive_unavailable");
});

const sha = (character) => character.repeat(64);

function controlReport(taskId, extra = {}) {
  return { sourceId: "worker-one", taskId, reportSha256: sha("a"), title: `Task ${taskId}`,
    reportPath: `knowledge/reports/${taskId}.md`, ...extra };
}

async function controlScenario(store, root) {
  const results = [];
  const step = async (name, call) => {
    try {
      const value = await call();
      results.push([name, { ok: value }]);
      return value;
    } catch (error) {
      results.push([name, { error: { message: error.message, code: error.code, exitCode: error.exitCode,
        stderr: error.stderr } }]);
      return null;
    }
  };
  const evidence = [
    { kind: "report", path: "knowledge/report.md", sha256: sha("1") },
    { kind: "progress", path: "knowledge/progress.json", sha256: sha("2"), extra: { n: 1.5, small: 0.00001 } },
  ];
  const corrections = [
    { kind: "report-correction", path: "c.json", sha256: sha("4") },
    { kind: "corrected-progress", path: "cp.json", sha256: sha("5") },
    { kind: "corrected-execution-summary", path: "cs.json", sha256: sha("6") },
  ];
  await step("init", () => store.initialize());
  await step("enqueue-a", () => store.enqueue(controlReport("task-a", { priority: 2, evidence,
    plan: [{ step: 1, title: "check" }, "not-an-object"], summary: "Summary \u{1f600}" })));
  await step("enqueue-b", () => store.enqueue(controlReport("task-b", { reportSha256: sha("b"),
    dependencies: ["task-a"], dispatchSequence: "3" })));
  await step("enqueue-c", () => store.enqueue(controlReport("task-c", { reportSha256: sha("C"),
    title: "Ünïcode \u{1f600} ".repeat(30), summary: 12345, taskSha256: sha("D") })));
  await step("enqueue-replay", () => store.enqueue(controlReport("task-a", { evidence })));
  await step("enqueue-partial-correction", () => store.enqueue(controlReport("task-a",
    { evidence: [...evidence, corrections[0]] })));
  await step("enqueue-correction", () => store.enqueue(controlReport("task-a", { evidence: [...evidence, ...corrections] })));
  await step("enqueue-replaced-evidence", () => store.enqueue(controlReport("task-a",
    { evidence: [{ ...evidence[0], sha256: sha("9") }, evidence[1], ...corrections] })));
  await step("enqueue-other-report", () => store.enqueue(controlReport("task-a", { reportSha256: sha("d") })));
  await step("enqueue-bad-id", () => store.enqueue(controlReport("Bad Id")));
  await step("enqueue-bad-priority", () => store.enqueue(controlReport("task-p", { reportSha256: sha("e"),
    priority: "high" })));
  await step("enqueue-bad-sha", () => store.enqueue(controlReport("task-q", { reportSha256: "xyz" })));
  await step("claim-half-target", () => store.claim({ sourceId: "worker-one", owner: "test" }));
  await step("claim-missing-target", () => store.claim({ sourceId: "worker-one", taskId: "missing", owner: "test" }));
  await step("claim-dependent-target", () => store.claim({ sourceId: "worker-one", taskId: "task-b", owner: "test" }));
  const claimed = await step("claim", () => store.claim({ owner: "test", leaseSeconds: 5 }));
  const itemA = claimed?.item?.itemId;
  const leaseToken = claimed?.item?.leaseToken;
  await step("claim-busy", () => store.claim({ owner: "test" }));
  await step("heartbeat", () => store.heartbeat(itemA, { leaseToken, currentAction: "Reviewing", leaseSeconds: 9999 }));
  await step("heartbeat-foreign-token", () => store.heartbeat(itemA, { leaseToken: "someone-else" }));
  await step("transition-unknown-state", () => store.transition(itemA, "bogus"));
  await step("transition-unexpected-state", () => store.transition(itemA, "review_running", { fromStates: ["queued"] }));
  await step("transition-unknown-patch", () => store.transition(itemA, "review_running", { patch: { nope: 1 } }));
  await step("transition-bad-decision", () => store.transition(itemA, "review_running",
    { patch: { finalDecision: "maybe" } }));
  await step("transition", () => store.transition(itemA, "review_running", { fromStates: "leased", leaseToken,
    patch: { phase: "review", threadId: "thread-1", plan: [{ step: 1, state: "done" }], summary: "x".repeat(3000) } }));
  await step("agent", () => store.upsertAgent({ agentId: "agent-a", itemId: itemA, state: "running", kind: "primary",
    statistics: { schemaVersion: 1, tokens: { status: "available", input: 10 }, timing: { startedAtUtc: "2026-01-01T00:00:00Z" },
      limitations: ["a"] } }));
  await step("agent-child", () => store.upsertAgent({ agentId: "agent-a-sub", itemId: itemA, parentAgentId: "agent-a",
    state: "waiting", canInterrupt: true, blockers: ["needs input"] }));
  await step("agent-bad-state", () => store.upsertAgent({ agentId: "agent-x", itemId: itemA, state: "dancing" }));
  await step("agent-missing-item", () => store.upsertAgent({ agentId: "agent-y", itemId: "no-such-item", state: "running" }));
  await step("agent-statistics", () => store.upsertAgentStatistics("agent-a", { schemaVersion: 1,
    cost: { status: "estimated", usd: 0.5 }, limitations: ["a", "b", 1, true], timing: { endedAtUtc: null, x: 1 } }));
  await step("agent-statistics-version", () => store.upsertAgentStatistics("agent-a", { schemaVersion: 2 }));
  await step("agent-statistics-missing", () => store.upsertAgentStatistics("agent-zzz", {}));
  await step("agent-plain", () => store.upsertAgent({ agentId: "agent-n", itemId: itemA, state: "running",
    statistics: { schemaVersion: 1, note: "x" } }));
  // Python fails after its autocommit UPDATE; the merged statistics stay.
  await step("agent-statistics-without-tokens", () => store.upsertAgentStatistics("agent-n", { schemaVersion: 1, other: 1 }));
  await step("event", () => store.addEvent("custom.one", { itemId: itemA, agentId: "agent-a",
    data: { n: 1.5, small: 0.00001, list: [1, "x"], 10: "a", 9: "b" } }));
  await step("event-default", () => store.addEvent(undefined));
  await step("event-bad-agent", () => store.addEvent("x", { agentId: "Bad Agent" }));
  await step("cancel-subagent", () => store.requestCancel({ agentId: "agent-a-sub" }, "stop sub"));
  await step("cancel-missing-agent-of-item", () => store.requestCancel({ itemId: itemA, agentId: "ghost" }, "x"));
  await step("cancel-nothing", () => store.requestCancel({}, null));
  await step("cancel-missing-task", () => store.requestCancel({ taskId: "missing" }));
  await step("progress", () => store.upsertProgress({ sourceId: "worker-two", taskId: "ext-1", state: "running",
    progressSha256: sha("1"), sequence: 2, title: "External", progressPath: "worker-two:progress.json",
    summary: { now: "Working", done: [], next: ["x"], blockers: [] },
    timing: { semanticUpdatedAtUtc: "2026-02-01T00:00:00Z" }, workflow: { stage: "plan" },
    agents: [
      { agentId: "w-1", state: "running", statistics: { schemaVersion: 1, tokens: { status: "available" } } },
      { agentId: "w-2", parentAgentId: "w-1", state: "waiting", canInterrupt: 1, currentAction: "Waiting" },
    ], updatedAtUtc: "2026-02-01T00:00:01Z" }));
  await step("progress-older", () => store.upsertProgress({ sourceId: "worker-two", taskId: "ext-1",
    progressSha256: sha("2"), sequence: 1 }));
  await step("progress-heartbeat", () => store.upsertProgress({ sourceId: "worker-two", taskId: "ext-1",
    progressSha256: sha("1"), sequence: 3, timing: { semanticUpdatedAtUtc: "2026-02-01T00:00:00Z" },
    agents: [{ agentId: "w-1", state: "running" }] }));
  await step("progress-bad-agent", () => store.upsertProgress({ sourceId: "worker-two", taskId: "ext-2",
    progressSha256: sha("3"), agents: ["w-3"] }));
  await step("progress-bad-state", () => store.upsertProgress({ sourceId: "worker-two", taskId: "ext-2",
    progressSha256: sha("3"), state: "sleeping" }));
  await step("cancel-external-agent", () => store.requestCancel({ agentId: "w-1" }, "agent stop"));
  await step("cancel-removed-agent", () => store.requestCancel({ agentId: "w-2" }, "agent stop"));
  await step("cancel-external-task", () => store.requestCancel({ taskId: "ext-1" }, "external stop"));
  await step("mode-unknown", () => store.setMode("sideways"));
  await step("mode-paused", () => store.setMode("paused", "maintenance"));
  await step("claim-paused", () => store.claim({ owner: "test" }));
  await step("accept-paused", () => store.accept({ sourceId: "worker-one", taskId: "task-c", reportSha256: sha("c"),
    evidence: [{ kind: "acceptance", sha256: sha("f"), path: "acceptance.json" }] }));
  await step("mode-running", () => store.setMode("running"));
  await step("accept-while-active", () => store.accept({ sourceId: "worker-one", taskId: "task-c",
    reportSha256: sha("c"), evidence: [{ kind: "acceptance", sha256: sha("f"), path: "acceptance.json" }] }));
  await step("expire-lease", () => store.transition(itemA, "review_running", {
    patch: { leaseExpiresAtUtc: "2020-01-01T00:00:00Z" } }));
  await step("recover", () => store.recover());
  await step("retry", () => store.retry(itemA));
  await step("retry-again", () => store.retry(itemA));
  await step("accept-without-evidence", () => store.accept({ sourceId: "worker-one", taskId: "task-c",
    reportSha256: sha("c"), evidence: [] }));
  await step("accept-changed-report", () => store.accept({ sourceId: "worker-one", taskId: "task-c",
    reportSha256: sha("e"), evidence: [{ kind: "acceptance", sha256: sha("f") }] }));
  await step("accept", () => store.accept({ sourceId: "worker-one", taskId: "task-c", reportSha256: sha("c"),
    evidence: [{ kind: "acceptance", sha256: sha("f"), path: "acceptance.json" }] }));
  await step("accept-replay", () => store.accept({ sourceId: "worker-one", taskId: "task-c", reportSha256: sha("c"),
    evidence: [{ kind: "acceptance", sha256: sha("f"), path: "acceptance.json" }] }));
  await step("claim-a-again", () => store.claim({ owner: "test", sourceId: "worker-one", taskId: "task-a" }));
  await step("emergency-stop", () => store.setMode("emergency_stopped", "fire"));
  await step("retry-stopped", () => store.retry(itemA));
  await step("finalize-stop", () => store.finalizeStop("timeout"));
  await step("mode-running-again", () => store.setMode("running"));
  await step("cancel-task-b", () => store.requestCancel({ sourceId: "worker-one", taskId: "task-b" }, "not needed"));
  await step("snapshot", () => store.snapshot({ eventLimit: 500 }));
  await step("snapshot-no-events", () => store.snapshot({ eventLimit: 0 }));
  await step("snapshot-bad-limit", () => store.snapshot({ eventLimit: "x" }));
  // Old finished events leave for an archive file.
  const db = new sqlite.DatabaseSync(store.databasePath);
  for (const second of [1, 2, 3]) {
    db.prepare("INSERT INTO events(at_utc, event_type, item_id, agent_id, payload_json) VALUES (?, ?, NULL, NULL, ?)")
      .run(`2020-01-01T00:00:0${second}Z`, "old.event", JSON.stringify({ second, text: "\u{1f600}" }));
  }
  db.close();
  const archiveRoot = path.join(root, "archives");
  const compacted = await step("compact", () => store.compact({ retentionDays: 30, archiveRoot }));
  await step("compact-nothing", () => store.compact({ retentionDays: 30, archiveRoot }));
  await step("unknown-command", () => store.invoke("bogus"));
  await step("payload-not-object", () => store.invoke("snapshot", []));
  return { results, archive: compacted?.archive ?? null, archiveRoot };
}

test("control store: node:sqlite gives the Python script's answers, messages and stored rows", { skip }, async (t) => {
  const pythonRoot = await temporary(t, "control-parity-python-");
  const nodeRoot = await temporary(t, "control-parity-node-");
  const pythonStore = new SqliteControlStore({ databasePath: path.join(pythonRoot, "control.db"), sqliteBackend: "python" });
  const nodeStore = new SqliteControlStore({ databasePath: path.join(nodeRoot, "control.db"), sqliteBackend: "node" });
  assert.equal(await nodeStore.sqliteBackend(), "node");
  const fromPython = await controlScenario(pythonStore, pythonRoot);
  const fromNode = await controlScenario(nodeStore, nodeRoot);

  // Archive files: the same lines; gzip framing and file stamps may differ.
  for (const run of [fromPython, fromNode]) {
    const file = path.join(run.archiveRoot, run.archive.archiveFile);
    const bytes = await readFile(file);
    assert.equal(run.archive.compressedSha256, (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
    run.lines = gunzipSync(bytes).toString("utf8");
    run.manifestText = (await readFile(`${file}.manifest.json`, "utf8"))
      .replace(/"compressedSha256": "[a-f0-9]{64}"/u, '"compressedSha256": "<sha>"');
    for (const [, value] of run.results) {
      if (value.ok?.archive) value.ok.archive.compressedSha256 = "<sha>";
    }
  }
  assert.equal(fromNode.lines, fromPython.lines);
  assert.equal(normalized(fromNode.manifestText), normalized(fromPython.manifestText));
  assert.equal(fromNode.archive.uncompressedSha256, fromPython.archive.uncompressedSha256);

  const expected = normalized(fromPython.results);
  const actual = normalized(fromNode.results);
  for (const [index, [name, value]] of expected.entries()) assert.deepEqual(actual[index], [name, value], name);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), "same key order in every answer");
  assert.deepEqual(normalized(dump(nodeStore.databasePath)), normalized(dump(pythonStore.databasePath)));

  // Timestamps the store writes keep Python's isoformat (microseconds, "Z").
  const items = dump(nodeStore.databasePath).content.queue_items;
  for (const item of items) assert.match(item.created_at_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?Z$/u);

  // Each read-only snapshot reader reads the other implementation's database.
  for (const [databasePath, sqliteBackend] of [[pythonStore.databasePath, "node"], [nodeStore.databasePath, "python"]]) {
    const reader = new SqliteControlSnapshotReader({ databasePath, sqliteBackend });
    const store = new SqliteControlStore({ databasePath, sqliteBackend: sqliteBackend === "node" ? "python" : "node" });
    assert.deepEqual(await reader.snapshot({ eventLimit: 50 }), await store.snapshot({ eventLimit: 50 }));
  }
});

test("project memory written by one implementation is read and changed by the other", { skip }, async (t) => {
  const root = await controllerRoot(t, "memory-cross-");
  const now = fixedClock();
  const fromPython = await createProjectMemoryStore({ controllerRoot: root, now, sqliteBackend: "python" });
  t.after(() => fromPython.close());
  const fromNode = await createProjectMemoryStore({ controllerRoot: root, now, sqliteBackend: "node" });
  assert.equal(fromPython.sqliteBackend, "python");
  assert.equal(fromNode.sqliteBackend, "node");
  const project = { scopeId: "p1", kind: "project", projectId: "p", quarterId: null, title: "Project", operationId: "op-1" };
  const created = await fromPython.createScope(project);
  assert.deepEqual(await fromNode.createScope(project), created, "Node replays Python's create receipt");
  await fromNode.createScope({ scopeId: "q1", kind: "quarter", projectId: "p", quarterId: "q", title: "Q",
    operationId: "op-2" });
  const entries = [entry("one", "written through Node, \u{1f600}")];
  const grant = await fromNode.authorizeWrite({ commandId: "c1", scopeId: "p1", expectedRevision: 1, entries,
    requestedBy: "owner" });
  assert.deepEqual(await fromPython.authorizeWrite({ commandId: "c1", scopeId: "p1", expectedRevision: 1, entries,
    requestedBy: "owner" }), grant, "Python replays Node's grant");
  const receipt = await fromPython.write({ scopeId: "p1", expectedRevision: 1, entries, operationId: "w1",
    commandId: "c1", actorId: "agent" });
  assert.deepEqual(await fromNode.write({ scopeId: "p1", expectedRevision: 1, entries, operationId: "w1",
    commandId: "c1", actorId: "agent" }), receipt, "Node replays Python's write");
  await assert.rejects(fromNode.write({ scopeId: "p1", expectedRevision: 1, entries, operationId: "w2",
    commandId: "c1", actorId: "agent" }), { code: "memory_authorization_consumed" });
  assert.deepEqual(await fromNode.readScope({ scopeId: "p1" }), await fromPython.readScope({ scopeId: "p1" }));
  assert.deepEqual(await fromNode.readPair({ projectId: "p", quarterId: "q" }),
    await fromPython.readPair({ projectId: "p", quarterId: "q" }));
  assert.deepEqual(await fromNode.listScopes(), await fromPython.listScopes());
  assert.equal(await fromNode.compareAndSwapDocument({ key: "doc", expectedRevision: 0, value: { by: "node" } }), true);
  assert.equal(await fromPython.compareAndSwapDocument({ key: "doc", expectedRevision: 1, value: { by: "python" } }), true);
  assert.deepEqual(await fromNode.readDocument({ key: "doc" }), { revision: 2, value: { by: "python" } });
});

test("a schema-1 memory database migrated by node:sqlite is used by Python", { skip }, async (t) => {
  const root = await controllerRoot(t, "memory-migration-cross-");
  const directory = path.join(root, ".project-local", "orchestration", "project-memory");
  await mkdir(directory, { recursive: true });
  const database = path.join(directory, "project-memory.v1.sqlite");
  python(`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE memory_scopes (scope_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('project','quarter')),
  project_id TEXT NOT NULL, quarter_id TEXT, title TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  CHECK ((kind='project' AND quarter_id IS NULL) OR (kind='quarter' AND quarter_id IS NOT NULL)));
CREATE UNIQUE INDEX one_project_memory_scope ON memory_scopes(project_id) WHERE kind='project';
CREATE UNIQUE INDEX one_quarter_memory_scope ON memory_scopes(project_id,quarter_id) WHERE kind='quarter';
CREATE TABLE memory_revisions (scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
  revision INTEGER NOT NULL CHECK (revision >= 1), content_sha256 TEXT NOT NULL, entries_json TEXT NOT NULL,
  author TEXT NOT NULL, updated_at_utc TEXT NOT NULL, PRIMARY KEY (scope_id,revision));
CREATE TABLE memory_operations (operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','write')), request_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL);
CREATE TABLE memory_write_grants (command_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
  expected_revision INTEGER NOT NULL, content_sha256 TEXT NOT NULL, requested_by TEXT NOT NULL,
  authorized_at_utc TEXT NOT NULL, request_sha256 TEXT NOT NULL, result_json TEXT NOT NULL,
  consumed_operation_id TEXT UNIQUE, consumed_at_utc TEXT);
CREATE TABLE memory_documents (key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision >= 1),
  value_json TEXT NOT NULL);
PRAGMA user_version=1;
""")
db.execute("INSERT INTO memory_scopes VALUES ('p','project','robotarm',NULL,'RobotArm',1)")
db.execute("INSERT INTO memory_scopes VALUES ('q','quarter','robotarm','tools','Tools',1)")
for scope in ('p', 'q'):
    db.execute("INSERT INTO memory_revisions VALUES (?,1,?,'[]','system','2026-09-01T00:00:00.000Z')",
               (scope, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'))
db.commit()
`, database);
  const migrated = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "node" });
  assert.equal(dump(database).userVersion, 2);
  await migrated.createScope({ scopeId: "agent-memory:solver", kind: "agent", projectId: "robotarm", quarterId: "tools",
    title: "solver", operationId: "create-agent" });
  const fromPython = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "python" });
  t.after(() => fromPython.close());
  assert.deepEqual((await fromPython.listScopes({ projectId: "robotarm" })).scopes.map((scope) => scope.scopeId), ["p", "q"]);
  assert.equal((await fromPython.readScope({ scopeId: "agent-memory:solver" })).kind, "agent");
  assert.equal(python(`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(db.execute("PRAGMA foreign_key_check").fetchone(), db.execute("PRAGMA integrity_check").fetchone()[0])
`, database), "None ok");
});

test("an archive written by one implementation is read and changed by the other, also after migration", { skip }, async (t) => {
  const root = await controllerRoot(t, "archive-cross-");
  const now = fixedClock();
  const fromPython = await createConversationArchive({ controllerRoot: root, projectId: "controller", now,
    sqliteBackend: "python" });
  t.after(() => fromPython.close());
  const fromNode = await createConversationArchive({ controllerRoot: root, projectId: "controller", now,
    sqliteBackend: "node" });
  const binding = { ...ARCHIVE_BINDING, threadId: "thread/é" };
  const saved = await fromPython.append(binding, archiveRecord("one", "from Python \u{1f600}"));
  const replay = await fromNode.append(binding, archiveRecord("one", "from Python \u{1f600}"));
  assert.deepEqual(replay, { ...saved, replay: true }, "Node sees Python's binding and content hash");
  await fromNode.append(binding, archiveRecord("two", "from Node"));
  await fromPython.append(binding, archiveRecord("three", "from Python again"));
  const firstPage = await fromPython.read(binding, { limit: 1 });
  assert.deepEqual(await fromNode.read(binding, { limit: 1 }), firstPage);
  assert.deepEqual(await fromNode.read(binding, { cursor: firstPage.nextCursor, limit: 5 }),
    await fromPython.read(binding, { cursor: firstPage.nextCursor, limit: 5 }));
  assert.equal(await fromNode.checkpointImport(binding, { expectedRevision: 0, nextCursor: "n" }), true);
  assert.equal(await fromPython.checkpointImport(binding, { expectedRevision: 0, nextCursor: "n" }), false);
  assert.deepEqual(await fromPython.readImportCheckpoint(binding), { revision: 1, cursor: "n", exhausted: false });

  // Back to schema 1 (no checkpoints table); node:sqlite migrates, Python reads.
  const database = fromNode.store.databasePath;
  await fromPython.close();
  python("import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('DROP TABLE import_checkpoints'); "
    + "db.execute('PRAGMA user_version=1'); db.commit(); db.close()", database);
  const migrated = await createConversationArchive({ controllerRoot: root, projectId: "controller", sqliteBackend: "node" });
  assert.equal(dump(database).userVersion, 2);
  assert.equal((await migrated.readImportCheckpoint(binding)).revision, 0);
  const reopened = await createConversationArchive({ controllerRoot: root, projectId: "controller", sqliteBackend: "python" });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.read(binding)).items.map((item) => item.record.recordId), ["one", "two", "three"]);
});

test("the control queue moves between implementations on one database, also from format 1", { skip }, async (t) => {
  const root = await temporary(t, "control-cross-");
  const databasePath = path.join(root, "control.db");
  python(`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE worker_tasks (source_id TEXT NOT NULL, task_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
  phase TEXT NOT NULL, summary_json TEXT NOT NULL, plan_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]', evidence_json TEXT NOT NULL DEFAULT '[]',
  stop_events_json TEXT NOT NULL DEFAULT '[]', progress_sequence INTEGER NOT NULL DEFAULT 0,
  progress_sha256 TEXT NOT NULL, progress_path TEXT NOT NULL, started_at_utc TEXT, updated_at_utc TEXT NOT NULL,
  PRIMARY KEY(source_id, task_id));
CREATE TABLE worker_agents (agent_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, task_id TEXT NOT NULL,
  parent_agent_id TEXT, kind TEXT NOT NULL, role TEXT NOT NULL, provider TEXT, state TEXT NOT NULL,
  current_action TEXT NOT NULL DEFAULT '', last_completed TEXT, next_action TEXT,
  blockers_json TEXT NOT NULL DEFAULT '[]', can_interrupt INTEGER NOT NULL DEFAULT 0, started_at_utc TEXT,
  last_heartbeat_utc TEXT, updated_at_utc TEXT NOT NULL,
  FOREIGN KEY(source_id, task_id) REFERENCES worker_tasks(source_id, task_id) ON DELETE CASCADE);
INSERT INTO worker_tasks VALUES ('worker-one', 'old-task', 'Old', 'waiting', 'planning',
  '{"now":"Waiting","done":[],"next":[],"blockers":[]}', '[]', '[]', '[]', '[]', 1, '${sha("f")}', 'p.json',
  '2026-08-17T18:00:00.000Z', '2026-08-17T18:01:00.000Z');
PRAGMA user_version = 1;
""")
db.commit()
`, databasePath);
  const fromNode = new SqliteControlStore({ databasePath, sqliteBackend: "node" });
  const fromPython = new SqliteControlStore({ databasePath, sqliteBackend: "python" });
  assert.equal((await fromNode.initialize()).formatVersion, 4);
  assert.deepEqual((await fromPython.snapshot()).workerTasks[0].workflow, {});
  const queued = await fromPython.enqueue(controlReport("task-a"));
  const claimed = await fromNode.claim({ owner: "node" });
  assert.equal(claimed.item.itemId, queued.item.itemId);
  await fromPython.heartbeat(claimed.item.itemId, { leaseToken: claimed.item.leaseToken, currentAction: "Python beat" });
  await fromNode.transition(claimed.item.itemId, "reviewed", { fromStates: ["leased"], leaseToken: claimed.item.leaseToken,
    patch: { finalDecision: "accepted" } });
  await fromPython.upsertAgent({ agentId: "agent-a", itemId: claimed.item.itemId, state: "completed",
    statistics: { schemaVersion: 1, tokens: { status: "available" } } });
  await fromNode.upsertAgentStatistics("agent-a", { schemaVersion: 1, cost: { status: "estimated" } });
  const pythonView = await fromPython.snapshot({ eventLimit: 100 });
  assert.deepEqual(await fromNode.snapshot({ eventLimit: 100 }), pythonView);
  assert.equal(pythonView.items[0].state, "reviewed");
  assert.equal(pythonView.agents[0].statistics.cost.status, "estimated");
  assert.deepEqual(pythonView.events.map((event) => event.type), [
    "queue.item_enqueued", "queue.item_claimed", "queue.heartbeat", "queue.state_changed",
    "agent.preview_updated", "agent.statistics_updated",
  ]);
});

function runWorker(argument) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(argument)], { windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`worker ${argument.label} exited ${code}: ${stderr}`));
      else resolve({ ...JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)), stderr });
    });
  });
}

test("Node processes and Python bridges share one memory database without lost updates", { skip }, async (t) => {
  const root = await temporary(t, "memory-concurrent-");
  const databasePath = path.join(root, "memory.sqlite");
  const setup = new ProjectMemoryStore({ store: new NodeProjectMemoryBridge({ databasePath, sqlite }) });
  await setup.initialize();
  assert.equal(await setup.compareAndSwapDocument({ key: COUNTER_KEY, expectedRevision: 0,
    value: { count: 0, writers: [] } }), true);
  const count = 12;
  const bridges = [0, 1].map(() => pythonMemoryBridge(databasePath));
  t.after(() => Promise.all(bridges.map((bridge) => bridge.close())));
  const pythonWriter = async (bridge, label) => {
    const store = new ProjectMemoryStore({ store: bridge });
    let retries = 0;
    for (let index = 0; index < count; index += 1) {
      for (;;) {
        const current = await store.readDocument({ key: COUNTER_KEY });
        const value = { count: current.value.count + 1, writers: [...current.value.writers, label].slice(-8) };
        if (await store.compareAndSwapDocument({ key: COUNTER_KEY, expectedRevision: current.revision, value })) break;
        retries += 1;
      }
    }
    return { label, retries };
  };
  const results = await Promise.all([
    ...[0, 1, 2].map((index) => runWorker({ kind: "memory", databasePath, label: `node-${index}`, count })),
    ...bridges.map((bridge, index) => pythonWriter(bridge, `python-${index}`)),
  ]);
  const final = await setup.readDocument({ key: COUNTER_KEY });
  assert.equal(final.value.count, 5 * count, JSON.stringify(results));
  assert.equal(final.revision, 5 * count + 1);
  for (const result of results.filter((value) => value.stderr !== undefined)) assert.equal(result.stderr, "");
});

test("Node processes and Python bridges append to one archive at the same time", { skip }, async (t) => {
  const root = await temporary(t, "archive-concurrent-");
  const databasePath = path.join(root, "archive.sqlite");
  const reader = new ConversationArchive({ projectId: "controller",
    store: new NodeConversationArchiveBridge({ databasePath, sqlite }) });
  await reader.invoke("init", {});
  const count = 8;
  const bridges = [0, 1].map(() => pythonArchiveBridge(databasePath));
  t.after(() => Promise.all(bridges.map((bridge) => bridge.close())));
  const pythonWriter = async (bridge, label) => {
    const archive = new ConversationArchive({ projectId: "controller", store: bridge });
    const sequences = [];
    for (let index = 0; index < count; index += 1) {
      sequences.push((await archive.append(ARCHIVE_BINDING, archiveRecord(`${label}-${index}`, `${label} ${index}`))).sequence);
      await archive.append(ARCHIVE_BINDING, archiveRecord("shared", "the same observation from every writer"));
    }
    return { label, sequences };
  };
  const results = await Promise.all([
    ...[0, 1].map((index) => runWorker({ kind: "archive", databasePath, label: `node-${index}`, count })),
    ...bridges.map((bridge, index) => pythonWriter(bridge, `python-${index}`)),
  ]);
  const sequences = results.flatMap((result) => result.sequences);
  assert.equal(new Set(sequences).size, 4 * count);
  const page = await reader.read(ARCHIVE_BINDING, { limit: 100 });
  assert.equal(page.items.length, 4 * count + 1);
  assert.equal(page.items.filter((item) => item.record.recordId === "shared").length, 1);
  assert.equal(dump(databasePath).content.entries.filter((row) => row.record_id === "shared").length, 1,
    "the shared observation was appended once and replayed by every other writer");
});

test("Node processes and the Python script enqueue and claim on one control queue", { skip }, async (t) => {
  const root = await temporary(t, "control-concurrent-");
  const databasePath = path.join(root, "control.db");
  await new SqliteControlStore({ databasePath, sqliteBackend: "node" }).initialize();
  const count = 4;
  const pythonStore = new SqliteControlStore({ databasePath, sqliteBackend: "python" });
  const pythonWriter = async (label) => {
    const created = [];
    for (let index = 0; index < count; index += 1) {
      created.push((await pythonStore.enqueue(controlReport(`${label}-${index}`, { title: label }))).created);
    }
    return { label, created, claimed: (await pythonStore.claim({ owner: label })).reason };
  };
  const results = await Promise.all([
    ...[0, 1].map((index) => runWorker({ kind: "control", databasePath, label: `node-${index}`, count })),
    pythonWriter("python-0"),
  ]);
  const snapshot = await pythonStore.snapshot({ eventLimit: 1000 });
  assert.equal(snapshot.items.length, 3 * count);
  assert.ok(results.every((result) => result.created.every(Boolean)));
  assert.equal(results.filter((result) => result.claimed === "claimed").length, 1, JSON.stringify(results));
  assert.equal(snapshot.items.filter((item) => item.state === "leased").length, 1);
  assert.equal(new Set(snapshot.events.map((event) => event.sequence)).size, snapshot.events.length);
});

test("node:sqlite stores leave no SQLite files open between requests", { skip: sqliteBackendUnavailable("node") ?? false },
  async (t) => {
    const root = await controllerRoot(t, "node-closed-files-");
    const memory = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "node" });
    await memory.createScope({ scopeId: "p1", kind: "project", projectId: "p", quarterId: null, title: "P",
      operationId: "op" });
    const archive = await createConversationArchive({ controllerRoot: root, projectId: "controller", sqliteBackend: "node" });
    await archive.append(ARCHIVE_BINDING, archiveRecord("one", "text"));
    const control = new SqliteControlStore({ databasePath: path.join(root, "control.db"), sqliteBackend: "node" });
    await control.enqueue(controlReport("task-a"));
    // As after the Python bridge's requests: the WAL is checkpointed and gone,
    // and the files can be removed while the stores still exist.
    const memoryFiles = await readdir(path.join(root, ".project-local", "orchestration", "project-memory"));
    assert.deepEqual(memoryFiles, ["project-memory.v1.sqlite"]);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("control.db")), ["control.db"]);
    await rm(path.join(root, ".project-local"), { recursive: true });
    await rm(path.join(root, "control.db"));
    await memory.close();
    await assert.rejects(memory.readScope({ scopeId: "p1" }), { code: "memory_unavailable" });
  });

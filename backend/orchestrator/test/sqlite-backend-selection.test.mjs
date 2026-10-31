import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SQLITE_BACKEND_ENVIRONMENT, loadNodeSqlite, requestedSqliteBackend, resolveSqliteBackend,
} from "../src/sqlite-backend.mjs";
import { SqliteControlStore } from "../src/sqlite-control-store.mjs";
import { SqliteControlSnapshotReader } from "../src/sqlite-control-snapshot-reader.mjs";
import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { createConversationArchive } from "../src/conversation-archive.mjs";
import { sqliteBackendUnavailable } from "./fixtures/sqlite-backends/helpers.mjs";

// Which implementation a store uses: node:sqlite by default where it loads;
// a constructor option, then AGENTS_FACTORY_SQLITE, win; a runtime without
// node:sqlite (the bundle targets node20) falls back to Python, not a crash.

const ORCHESTRATOR = fileURLToPath(new URL("..", import.meta.url));
const UNAVAILABLE = pathToFileURL(path.join(ORCHESTRATOR, "test", "fixtures", "sqlite-backends", "unavailable.mjs")).href;
const moduleUrl = (name) => pathToFileURL(path.join(ORCHESTRATOR, "src", name)).href;

function withEnvironment(value, body) {
  const previous = process.env[SQLITE_BACKEND_ENVIRONMENT];
  if (value === undefined) delete process.env[SQLITE_BACKEND_ENVIRONMENT];
  else process.env[SQLITE_BACKEND_ENVIRONMENT] = value;
  const restore = () => {
    if (previous === undefined) delete process.env[SQLITE_BACKEND_ENVIRONMENT];
    else process.env[SQLITE_BACKEND_ENVIRONMENT] = previous;
  };
  return Promise.resolve().then(body).finally(restore);
}

const available = async () => ({ DatabaseSync: class {} });
const missing = async () => null;

test("the option wins over the environment, the environment over the default", async () => {
  await withEnvironment(undefined, async () => {
    assert.equal(requestedSqliteBackend(), null);
    assert.equal((await resolveSqliteBackend({ load: available })).backend, "node");
    assert.equal((await resolveSqliteBackend({ backend: "python", load: available })).backend, "python");
  });
  await withEnvironment("python", async () => {
    assert.equal(requestedSqliteBackend(), "python");
    assert.equal((await resolveSqliteBackend({ load: available })).backend, "python");
    assert.equal((await resolveSqliteBackend({ backend: "node", load: available })).backend, "node");
  });
  await withEnvironment(" Node ", async () => {
    assert.equal(requestedSqliteBackend(), "node");
    assert.equal(requestedSqliteBackend("python"), "python");
  });
  await withEnvironment("sqlite3", async () => {
    assert.equal(requestedSqliteBackend(), null, "an unknown environment value is ignored");
    assert.equal((await resolveSqliteBackend({ load: available })).backend, "node");
  });
  assert.throws(() => requestedSqliteBackend("pyhton"), { code: "SQLITE_BACKEND_INVALID" });
  assert.throws(() => new SqliteControlStore({ databasePath: "x.db", sqliteBackend: "sqlite" }),
    { code: "SQLITE_BACKEND_INVALID" });
  await assert.rejects(createProjectMemoryStore({ controllerRoot: os.tmpdir(), sqliteBackend: "sqlite" }),
    { code: "memory_invalid_input" });
  await assert.rejects(createConversationArchive({ controllerRoot: os.tmpdir(), projectId: "controller",
    sqliteBackend: "sqlite" }), { code: "archive_invalid_input" });
});

test("without node:sqlite every store falls back to Python, even when node is asked for", async () => {
  await withEnvironment("node", async () => {
    assert.deepEqual(await resolveSqliteBackend({ load: missing }), { backend: "python", sqlite: null });
    assert.deepEqual(await resolveSqliteBackend({ backend: "node", load: missing }), { backend: "python", sqlite: null });
  });
  let loads = 0;
  await resolveSqliteBackend({ backend: "python", load: async () => { loads += 1; return null; } });
  assert.equal(loads, 0, "Python asked for explicitly never loads node:sqlite");
});

test("a script other than the control store's always runs in Python", () => {
  const store = new SqliteControlStore({ databasePath: "x.db", bridgePath: "project-memory-store.py",
    sqliteBackend: "node" });
  assert.equal(store.requestedSqliteBackend, "python");
  const reader = new SqliteControlSnapshotReader({ databasePath: "x.db", bridgePath: "custom-reader.py" });
  assert.equal(reader.requestedSqliteBackend, "python");
  const copy = new SqliteControlStore({ databasePath: "x.db", bridgePath: path.join("elsewhere", "sqlite-control-store.py") });
  assert.equal(copy.requestedSqliteBackend, null, "a copy of the control store script may run in node:sqlite");
});

const SCRIPT = `
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { createProjectMemoryStore } = await import(${JSON.stringify(moduleUrl("project-memory-store.mjs"))});
const { createConversationArchive } = await import(${JSON.stringify(moduleUrl("conversation-archive.mjs"))});
const { SqliteControlStore } = await import(${JSON.stringify(moduleUrl("sqlite-control-store.mjs"))});
const { SqliteControlSnapshotReader } = await import(${JSON.stringify(moduleUrl("sqlite-control-snapshot-reader.mjs"))});
const root = await mkdtemp(path.join(os.tmpdir(), "sqlite-selection-child-"));
try {
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ sourceId: "controller" }));
  const memory = await createProjectMemoryStore({ controllerRoot: root });
  await memory.createScope({ scopeId: "p1", kind: "project", projectId: "p", quarterId: null, title: "P", operationId: "op" });
  const archive = await createConversationArchive({ controllerRoot: root, projectId: "controller" });
  const binding = { projectId: "controller", sourceId: "s", providerId: "p", threadId: "t" };
  await archive.append(binding, { recordId: "r", kind: "message", role: "user", state: "requested", text: "hi",
    providerTurnId: null, providerItemId: null, requestId: "r", occurredAtUtc: null, omissions: [] });
  const control = new SqliteControlStore({ databasePath: path.join(root, "control.db") });
  await control.enqueue({ sourceId: "worker-one", taskId: "task-a", reportSha256: "a".repeat(64) });
  const reader = new SqliteControlSnapshotReader({ databasePath: path.join(root, "control.db") });
  const snapshot = await reader.snapshot();
  const result = {
    memory: memory.sqliteBackend, archive: archive.sqliteBackend,
    control: await control.sqliteBackend(), reader: await reader.sqliteBackend(),
    scopes: (await memory.listScopes()).scopes.length, records: (await archive.read(binding)).items.length,
    items: snapshot.items.length,
  };
  await memory.close();
  await archive.close();
  process.stdout.write(JSON.stringify(result));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
`;

function child({ unavailable = false, environment = {} } = {}) {
  const env = { ...process.env, ...environment };
  if (environment[SQLITE_BACKEND_ENVIRONMENT] === undefined) delete env[SQLITE_BACKEND_ENVIRONMENT];
  // The fixture's module.register() is deprecated from Node 26; that warning is the fixture's, not the stores'.
  const result = spawnSync(process.execPath, [
    ...(unavailable ? ["--no-deprecation", "--import", UNAVAILABLE] : []), "--input-type=module", "-e", SCRIPT,
  ], { encoding: "utf8", windowsHide: true, timeout: 120_000, env });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout), stderr: result.stderr };
}

const python = { skip: sqliteBackendUnavailable("python") ?? false };
const node = { skip: sqliteBackendUnavailable("node") ?? false };
const counts = { scopes: 1, records: 1, items: 1 };

test("a runtime without node:sqlite runs every store in Python", python, () => {
  for (const environment of [{}, { [SQLITE_BACKEND_ENVIRONMENT]: "node" }]) {
    const result = child({ unavailable: true, environment });
    assert.deepEqual(result, { memory: "python", archive: "python", control: "python", reader: "python",
      ...counts, stderr: "" });
  }
});

test("node:sqlite is the default, quietly, and AGENTS_FACTORY_SQLITE=python still selects Python", node, () => {
  const result = child();
  assert.deepEqual(result, { memory: "node", archive: "node", control: "node", reader: "node", ...counts, stderr: "" },
    "no ExperimentalWarning on stderr");
  if (!python.skip) {
    assert.deepEqual(child({ environment: { [SQLITE_BACKEND_ENVIRONMENT]: "python" } }),
      { memory: "python", archive: "python", control: "python", reader: "python", ...counts, stderr: "" });
  }
});

test("loading node:sqlite gives process.emitWarning back", node, async () => {
  assert.notEqual(await loadNodeSqlite(), null);
  assert.equal(process.emitWarning.name, "emitWarning", "process.emitWarning is restored after the load");
});

test("node:sqlite needs no bridge script beside the modules", node, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sqlite-no-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ sourceId: "controller" }));
  const missingScript = path.join(root, "missing.py");
  const memory = await createProjectMemoryStore({ controllerRoot: root, bridgePath: missingScript, sqliteBackend: "node" });
  assert.equal(memory.sqliteBackend, "node");
  await assert.rejects(createProjectMemoryStore({ controllerRoot: root, bridgePath: missingScript, sqliteBackend: "python" }),
    { code: "memory_identity_conflict" });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { sqliteBackendOf, sqliteBackendTest as test } from "./fixtures/sqlite-backends/helpers.mjs";

// The memory database as schema 1 created it (before agent scopes), so the
// migration is tested against the real old layout, not a description of it.
const SCHEMA_1 = `
CREATE TABLE memory_scopes (
    scope_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('project','quarter')),
    project_id TEXT NOT NULL,
    quarter_id TEXT,
    title TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    CHECK ((kind='project' AND quarter_id IS NULL)
        OR (kind='quarter' AND quarter_id IS NOT NULL)));
CREATE UNIQUE INDEX one_project_memory_scope ON memory_scopes(project_id) WHERE kind='project';
CREATE UNIQUE INDEX one_quarter_memory_scope ON memory_scopes(project_id,quarter_id) WHERE kind='quarter';
CREATE TABLE memory_revisions (
    scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    content_sha256 TEXT NOT NULL,
    entries_json TEXT NOT NULL,
    author TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    PRIMARY KEY (scope_id,revision));
CREATE TABLE memory_operations (
    operation_id TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','write')),
    request_sha256 TEXT NOT NULL,
    result_json TEXT NOT NULL);
CREATE TABLE memory_write_grants (
    command_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
    expected_revision INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    authorized_at_utc TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    result_json TEXT NOT NULL,
    consumed_operation_id TEXT UNIQUE,
    consumed_at_utc TEXT);
CREATE TABLE memory_documents (
    key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    value_json TEXT NOT NULL);
PRAGMA user_version=1;
`;
// The SHA-256 of "[]" in the store's canonical JSON.
const EMPTY = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

function python(script, ...args) {
  const result = spawnSync(process.env.PYTHON || "python", ["-c", script, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function oldDatabase(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: "controller" }));
  const directory = path.join(root, ".project-local", "orchestration", "project-memory");
  await mkdir(directory, { recursive: true });
  const database = path.join(directory, "project-memory.v1.sqlite");
  python(`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript(sys.argv[2])
db.execute("INSERT INTO memory_scopes VALUES ('p','project','robotarm',NULL,'RobotArm',1)")
db.execute("INSERT INTO memory_scopes VALUES ('q','quarter','robotarm','tools','Tools',1)")
for scope in ('p', 'q'):
    db.execute("INSERT INTO memory_revisions VALUES (?,1,?,'[]','system','2026-09-01T00:00:00.000Z')", (scope, sys.argv[3]))
db.execute("INSERT INTO memory_documents VALUES ('memory-agents-v1',1,'{\\"agents\\":[]}')")
db.commit()
`, database, SCHEMA_1, EMPTY);
  return { root, database };
}

test("a schema-1 memory database moves to schema 2 with its scopes, revisions and documents", async (t) => {
  const { root, database } = await oldDatabase(t);
  const sqliteBackend = sqliteBackendOf(t);
  const store = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend });
  assert.equal(store.sqliteBackend, sqliteBackend);
  assert.equal(python(`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(db.execute("PRAGMA user_version").fetchone()[0], db.execute("PRAGMA foreign_key_check").fetchone())
`, database), "2 None");
  const scopes = await store.listScopes({ projectId: "robotarm" });
  assert.deepEqual(scopes.scopes.map((scope) => scope.scopeId), ["p", "q"]);
  assert.equal((await store.readDocument({ key: "memory-agents-v1" })).revision, 1);
  const own = await store.createScope({ scopeId: "agent-memory:solver", kind: "agent", projectId: "robotarm",
    quarterId: "tools", title: "solver", operationId: "create-agent-memory" });
  assert.equal(own.kind, "agent");
  assert.equal(own.quarterId, "tools");
  // Agent memories are read through their agents, not listed with the project.
  assert.deepEqual((await store.listScopes({ projectId: "robotarm" })).scopes.map((scope) => scope.scopeId), ["p", "q"]);
  const entries = [{ id: "role", title: "Role", text: "I own the joint solver." }];
  await store.authorizeWrite({ commandId: "own-1", scopeId: own.scopeId, expectedRevision: 1, entries, requestedBy: "owner" });
  const written = await store.write({ scopeId: own.scopeId, expectedRevision: 1, entries, operationId: "write-own-1",
    commandId: "own-1", actorId: "owner" });
  assert.equal(written.revision, 2);
  const [read] = await store.readScopes({ scopeIds: [own.scopeId, "missing-scope"] });
  assert.deepEqual(read.entries, entries);
  await assert.rejects(store.createScope({ scopeId: "agent-memory:x", kind: "agent", projectId: "robotarm",
    quarterId: "missing-quarter", title: "x", operationId: "create-x" }), { code: "memory_scope_not_found" });
  // Opening again leaves a schema-2 database as it is.
  await createProjectMemoryStore({ controllerRoot: root, sqliteBackend });
  assert.equal((await store.readScope({ scopeId: own.scopeId })).revision, 2);
});

test("a project copy takes project and quarter memory, never agents' own", async (t) => {
  const { root } = await oldDatabase(t);
  const store = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: sqliteBackendOf(t) });
  await store.createScope({ scopeId: "agent-memory:solver", kind: "agent", projectId: "robotarm",
    quarterId: "tools", title: "solver", operationId: "create-agent-memory" });
  const copy = await store.copyProject({ sourceProjectId: "robotarm", targetProjectId: "robotarm-2",
    targetProjectScopeId: "p2", quarterScopeIds: { tools: "q2" }, operationId: "copy-robotarm" });
  assert.deepEqual(copy.scopes.map((scope) => scope.kind), ["project", "quarter"]);
});

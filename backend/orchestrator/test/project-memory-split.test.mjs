import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConversationArchive } from "../src/conversation-archive.mjs";
import { archiveProject, listVisibleScopes } from "../src/project-archive.mjs";
import { ProjectMemoryService } from "../src/project-memory-service.mjs";
import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import {
  mountedProjects, projectFolderName, projectsRoot, resolveStoreLayout, singleMemoryDatabase, writeStoreLayoutMarker,
} from "../src/project-store-layout.mjs";
import { loadNodeSqlite } from "../src/sqlite-backend.mjs";

const SOURCE = "split-fixture";
const sqlite = await loadNodeSqlite();
const skip = sqlite === null ? "node:sqlite is not available" : false;
const profile = { provider: "fixture", model: "m", reasoningEffort: "max", fallbackPolicy: "deny" };

async function instance(t, { split }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-split-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "project-version.json"), JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  if (split) await writeStoreLayoutMarker(root);
  return root;
}

async function open(root, now) {
  const store = await createProjectMemoryStore({ controllerRoot: root, now, sqliteBackend: "node" });
  const archive = await createConversationArchive({ controllerRoot: root, projectId: SOURCE, now, sqliteBackend: "node" });
  let thread = 0;
  const service = new ProjectMemoryService({ store, archive, now, provider: { preflight: async () => {},
    capture: async () => {},
    create: async (agent) => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "fixture",
      threadId: `thread-${agent.agentId}-${++thread}` }) } });
  return { store, archive, service };
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 26, 0, 0, tick++));
}

/** The same work in either layout; what the API answers is compared. */
async function scenario(root) {
  const { store, archive, service } = await open(root, clock());
  const scope = (scopeId, kind, projectId, quarterId) =>
    store.createScope({ scopeId, kind, projectId, quarterId, title: scopeId, operationId: `op-${scopeId}` });
  await scope("alpha-memory", "project", "alpha", null);
  await scope("alpha-q1-memory", "quarter", "alpha", "q1");
  await scope("beta-memory", "project", "beta", null);
  await scope("beta-q1-memory", "quarter", "beta", "q1");
  await scope("beta-q2-memory", "quarter", "beta", "q2");
  await scope("world-memory", "project", "world", null);
  await scope("world-hq-memory", "quarter", "world", "hq");
  await service.createAgent({ agentId: "alpha-agent", projectId: "alpha", quarterId: "q1", operationId: "create-alpha-agent", profile });
  await service.createAgent({ agentId: "beta-agent", projectId: "beta", quarterId: "q1", operationId: "create-beta-agent", profile });
  await service.createAgent({ agentId: "lead", projectId: "world", quarterId: "hq", operationId: "create-lead", profile });
  await service.createAgent({ agentId: "beta-old", projectId: "beta", quarterId: "q2", operationId: "create-beta-old", profile });
  const lead = await service.readAgent({ agentId: "lead" });
  await service.setAgentSettings({ agentId: "lead", expectedRevision: lead.settings.revision, role: "coordinator", writeZone: null });
  await service.closeAgent({ agentId: "beta-old", operationId: "close-beta-old" });
  await service.closeAgent({ agentId: "alpha-agent", operationId: "close-alpha-agent" });
  await archiveProject({ store, projectId: "alpha", now: () => new Date(Date.UTC(2026, 9, 26, 1)) });
  const binding = (await service.readAgent({ agentId: "beta-agent" })).binding;
  await archive.append(binding,
    { recordId: "r1", kind: "message", role: "user", state: "completed", text: "hello beta", providerTurnId: null,
      providerItemId: null, requestId: null, occurredAtUtc: "2026-10-26T00:00:00.000Z", omissions: [] });
  const snapshot = {
    agents: (await service.listAgents()).agents,
    visible: await listVisibleScopes(store),
    all: await store.listScopes(),
    betaScopes: await store.listScopes({ projectId: "beta" }),
    pair: await store.readPair({ projectId: "beta", quarterId: "q1" }),
    conversation: (await archive.read(binding)).items.map((item) => item.record.text),
  };
  await service.close();
  return snapshot;
}

test("the split layout answers exactly as one database does", { skip }, async (t) => {
  const single = await scenario(await instance(t, { split: false }));
  const splitRoot = await instance(t, { split: true });
  const split = await scenario(splitRoot);
  assert.deepEqual(split, single);
  assert.ok(single.agents.length === 4 && single.conversation.length === 1);

  // Each project in its own folder; no single database was made.
  const projects = await mountedProjects(splitRoot);
  assert.deepEqual(projects.map((project) => project.projectId), ["alpha", "beta", "world"]);
  for (const { folder } of projects) assert.ok((await readdir(folder)).includes("memory.sqlite"));
  await assert.rejects(readdir(path.dirname(singleMemoryDatabase(splitRoot))), { code: "ENOENT" });
  assert.equal((await resolveStoreLayout(splitRoot)).layout, "split");

  // A project's database holds its scopes, its agents, its archive flag and its conversation only.
  const read = (projectId, sql) => {
    const db = new sqlite.DatabaseSync(path.join(projectsRoot(splitRoot), projectFolderName(projectId), "memory.sqlite"), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  assert.deepEqual(read("beta", "SELECT DISTINCT project_id FROM memory_scopes").map((row) => row.project_id), ["beta"]);
  const catalog = (projectId) => JSON.parse(read(projectId, "SELECT value_json FROM memory_documents WHERE key='memory-agents-v1'")[0]?.value_json ?? '{"agents":[]}');
  assert.deepEqual(catalog("beta").agents.map((agent) => agent.agentId), ["beta-agent", "beta-old"]);
  assert.deepEqual(catalog("world").agents.map((agent) => agent.agentId), ["lead"]);
  const flags = JSON.parse(read("alpha", "SELECT value_json FROM memory_documents WHERE key='memory-project-archive-v1'")[0].value_json);
  assert.deepEqual(Object.keys(flags.projects), ["alpha"]);
  const archived = (projectId) => {
    const db = new sqlite.DatabaseSync(path.join(projectsRoot(splitRoot), projectFolderName(projectId), "archive.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT binding FROM conversations").all().map((row) => JSON.parse(row.binding).threadId); } finally { db.close(); }
  };
  assert.equal(archived("beta").length, 1);
  assert.match(archived("beta")[0], /^thread-beta-agent-/u);
});

test("the merged catalog revision moves with every change and a stale swap fails across processes", { skip }, async (t) => {
  const root = await instance(t, { split: true });
  const first = await open(root, clock());
  for (const [scopeId, kind, projectId, quarterId] of [["a-memory", "project", "a", null], ["a-q-memory", "quarter", "a", "q"],
    ["b-memory", "project", "b", null], ["b-q-memory", "quarter", "b", "q"]]) {
    await first.store.createScope({ scopeId, kind, projectId, quarterId, title: scopeId, operationId: `op-${scopeId}` });
  }
  await first.service.createAgent({ agentId: "a1", projectId: "a", quarterId: "q", operationId: "create-a1", profile });
  await first.service.createAgent({ agentId: "b1", projectId: "b", quarterId: "q", operationId: "create-b1", profile });
  const before = await first.store.readDocument({ key: "memory-agents-v1" });
  const second = await open(root, clock());
  const a1 = await second.service.readAgent({ agentId: "a1" });
  await second.service.setAgentSettings({ agentId: "a1", expectedRevision: a1.settings.revision, role: "project-lead", writeZone: null });
  const after = await first.store.readDocument({ key: "memory-agents-v1" });
  assert.equal(after.revision, before.revision + 1);
  assert.equal(await first.store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: before.revision,
    value: before.value }), false);
  // One write may change one project only.
  const both = structuredClone(after.value);
  for (const agent of both.agents) agent.note = "x";
  await assert.rejects(first.store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: after.revision, value: both }),
    { code: "memory_cross_project_change" });
  await first.service.close();
  await second.service.close();
});

test("a project copy goes into a new project's database and replays; a reused operation id conflicts", { skip }, async (t) => {
  const root = await instance(t, { split: true });
  const { store } = await open(root, clock());
  await store.createScope({ scopeId: "src-memory", kind: "project", projectId: "src", quarterId: null, title: "Src", operationId: "op-src" });
  await store.createScope({ scopeId: "src-q-memory", kind: "quarter", projectId: "src", quarterId: "q", title: "Q", operationId: "op-src-q" });
  const copy = { sourceProjectId: "src", targetProjectId: "dst", targetProjectScopeId: "dst-memory",
    quarterScopeIds: { q: "dst-q-memory" }, operationId: "copy-1" };
  const first = await store.copyProject(copy);
  assert.deepEqual(await store.copyProject(copy), first);
  assert.deepEqual((await store.listScopes({ projectId: "dst" })).scopes.map((scope) => scope.scopeId), ["dst-memory", "dst-q-memory"]);
  assert.deepEqual((await mountedProjects(root)).map((project) => project.projectId), ["dst", "src", "world"]);
  await assert.rejects(store.createScope({ scopeId: "other-memory", kind: "project", projectId: "other", quarterId: null,
    title: "Other", operationId: "copy-1" }), { code: "memory_operation_conflict" });
  await assert.rejects(store.createScope({ scopeId: "src-memory", kind: "project", projectId: "other", quarterId: null,
    title: "Other", operationId: "op-other" }), { code: "memory_scope_conflict" });
  await assert.rejects(store.createScope({ scopeId: "lost-q", kind: "quarter", projectId: "nowhere", quarterId: "q",
    title: "Q", operationId: "op-lost" }), { code: "memory_project_scope_required" });
  assert.deepEqual((await mountedProjects(root)).map((project) => project.projectId), ["dst", "src", "world"]);
  await store.close();
});

test("reading a project's scopes waits while another process holds its database", { skip }, async (t) => {
  // The Gateway opens and closes the databases on every request; a memory CLI
  // Atlas ran meanwhile read them without waiting and failed with memory_unavailable.
  const root = await instance(t, { split: true });
  const { store } = await open(root, clock());
  await store.createScope({ scopeId: "a-memory", kind: "project", projectId: "a", quarterId: null,
    title: "A", operationId: "op-a" });
  const database = path.join(projectsRoot(root), projectFolderName("a"), "memory.sqlite");
  const holder = spawn(process.execPath, ["-e", [
    "const { DatabaseSync } = require('node:sqlite');",
    `const db = new DatabaseSync(${JSON.stringify(database)});`,
    "db.exec('PRAGMA locking_mode=EXCLUSIVE'); db.exec('BEGIN IMMEDIATE');",
    "db.prepare('SELECT count(*) AS n FROM memory_scopes').get(); db.exec('COMMIT');",
    "process.stdout.write('locked\\n');",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); db.close();"].join(" ")],
  { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((resolve) => holder.on("exit", resolve));
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  // A scope no project names makes the store read every project's scopes again, "a" first of all.
  const started = Date.now();
  await assert.rejects(store.readScope({ scopeId: "missing-memory" }), { code: "memory_scope_not_found" });
  assert.ok(Date.now() - started >= 500, "the read waited for the holder");
  await store.close();
  assert.equal(await exited, 0);
});

test("project folders are safe Windows names; the split layout needs node:sqlite", { skip }, async (t) => {
  assert.equal(projectFolderName("alpha.1"), "alpha.1");
  assert.match(projectFolderName("team:alpha"), /^~[a-f0-9]{32}$/u);
  assert.match(projectFolderName("con"), /^~/u);
  assert.match(projectFolderName("Aux.txt"), /^~/u);
  const root = await instance(t, { split: true });
  const { store } = await open(root, clock());
  await store.createScope({ scopeId: "colon-memory", kind: "project", projectId: "team:alpha", quarterId: null,
    title: "Colon", operationId: "op-colon" });
  assert.ok((await mountedProjects(root)).some((project) => project.projectId === "team:alpha"));
  await store.close();
  await assert.rejects(createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "python" }), { code: "memory_sqlite_required" });
});

test("an instance without the marker stays single; the environment starts only a new one split", { skip }, async (t) => {
  const root = await instance(t, { split: false });
  const { store } = await open(root, clock());
  await store.close();
  assert.equal((await resolveStoreLayout(root, { env: { AGENTS_FACTORY_STORE_LAYOUT: "split" } })).layout, "single");
  const fresh = await instance(t, { split: false });
  await mkdir(path.join(fresh, ".project-local"), { recursive: true });
  assert.equal((await resolveStoreLayout(fresh, { env: {} })).layout, "single");
  assert.equal((await resolveStoreLayout(fresh, { env: { AGENTS_FACTORY_STORE_LAYOUT: "split" } })).layout, "split");
  assert.equal((await resolveStoreLayout(fresh, { env: {} })).layout, "split");
});

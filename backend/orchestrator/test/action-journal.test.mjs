import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { journalKeyOf, readProjectActions, recordAction, recordActionQuietly } from "../src/action-journal.mjs";
import { journalGatewayHandlers } from "../src/action-journal-gateway.mjs";
import { undoAction } from "../src/action-journal-undo.mjs";
import { createApplicationProjectMemoryHandlers } from "../src/application-project-memory.mjs";
import { createApplicationProjectWorkspaceHandlers } from "../src/application-project-workspace.mjs";
import { createApplicationProjectWorkspaceSaveHandler } from "../src/application-project-workspace-save.mjs";
import { archivedSets } from "../src/project-archive.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { selectProjectRecords } from "../src/project-package-export.mjs";
import { bindProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { mountedProjects, writeStoreLayoutMarker } from "../src/project-store-layout.mjs";
import { loadNodeSqlite } from "../src/sqlite-backend.mjs";
import { openReadOnlyDatabase } from "../src/sqlite-node-connection.mjs";

// The action journal (roadmap step 1, track B): the person's changes through
// the Gateway and the trusted host are recorded once each, in the project's
// own journal, and the undoable ones come back as they were.

const SOURCE = "controller";
const PROFILE = { provider: "claude", model: "claude-a", reasoningEffort: "default", fallbackPolicy: "deny" };
const PERSON = { kind: "person", id: null };

/** A keyed document store, as the memory store's documents behave. */
function documentStore() {
  const documents = new Map();
  return {
    documents,
    async readDocument({ key }) { return structuredClone(documents.get(key) ?? null); },
    async compareAndSwapDocument({ key, expectedRevision, value }) {
      if ((documents.get(key)?.revision ?? 0) !== expectedRevision) return false;
      documents.set(key, { revision: expectedRevision + 1, value: structuredClone(value) });
      return true;
    },
  };
}

async function controller(t, { split = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "action-journal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: SOURCE }));
  await writeFile(path.join(root, "project-version.json"), JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  if (split) {
    await writeFile(path.join(root, "instance.json"), JSON.stringify({ schemaVersion: 1, instanceId: "journal" }));
    await writeStoreLayoutMarker(root);
  }
  await mkdir(path.join(root, ".project-local", "application-gateway"), { recursive: true });
  await writeFile(path.join(root, ".project-local", "application-gateway", "claude-provider.json"),
    JSON.stringify({ schemaVersion: 1, sdkPath: path.join(root, "sdk"), models: [{ id: "claude-a" }, { id: "claude-b" }] }));
  return root;
}

/** The memory service with a provider that creates, captures and steers without a model. */
async function serviceOf(root) {
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  service.provider = { preflight: async () => {}, capture: async () => {}, steer: async () => {}, trace: async () => ({}),
    create: async (agent) => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "claude", threadId: `thread-${agent.agentId}` }) };
  return service;
}

function gateway(service) {
  const handlers = journalGatewayHandlers(createApplicationProjectMemoryHandlers({ service }), { service });
  return (operationId, input) => handlers[operationId]({ input });
}

/** The memory CLI as the trusted host runs it, with an input file inside the instance. */
async function cli(root, action, input = null, extra = {}) {
  const options = { "repo-root": root, action, ...extra };
  if (input !== null) {
    const relative = path.join(".project-local", "atlas-input", `${action}.json`);
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), JSON.stringify(input));
    options["input-file"] = relative;
  }
  return runProjectMemoryCommand(options);
}

async function project(call, projectId = "alpha") {
  await call("mutation.memory.scope.create", { scopeId: `${projectId}-memory`, kind: "project", projectId,
    quarterId: null, title: "Alpha", operationId: `create-${projectId}` });
  await call("mutation.memory.scope.create", { scopeId: `${projectId}-q1`, kind: "quarter", projectId,
    quarterId: "q1", title: "Q1", operationId: `create-${projectId}-q1` });
}

test("journal entries: newest first, checked, kept within the document's budget", async () => {
  const store = documentStore();
  let clock = Date.parse("2026-10-31T10:00:00.000Z");
  const now = () => new Date(clock += 1_000);
  const first = await recordAction(store, { action: "agent.create", actor: PERSON, projectId: "alpha", quarterId: "q1",
    agentId: "a", summary: "Created agent a", undo: { kind: "close-agent", agentId: "a" } }, { now });
  assert.match(first.entryId, /^[a-f0-9-]{36}$/u);
  assert.deepEqual({ ...first, entryId: null }, { entryId: null, atUtc: "2026-10-31T10:00:01.000Z", actor: PERSON,
    action: "agent.create", projectId: "alpha", quarterId: "q1", agentId: "a", summary: "Created agent a",
    undo: { kind: "close-agent", agentId: "a" }, noUndo: null, undoes: null, undoneBy: null, undoneAtUtc: null });
  await recordAction(store, { action: "project.file-save", actor: PERSON, projectId: "alpha", summary: "Saved a.md",
    noUndo: "file_not_kept" }, { now });
  // An undo marks what it undid, and is itself not undoable.
  const undo = await recordAction(store, { action: "agent.close", actor: PERSON, projectId: "alpha", agentId: "a",
    summary: "Closed agent a", undoes: first.entryId }, { now });
  assert.equal(undo.noUndo, "undo_entry");
  const entries = await readProjectActions(store, { projectId: "alpha" });
  assert.deepEqual(entries.map((entry) => entry.action), ["agent.close", "project.file-save", "agent.create"]);
  assert.equal(entries[2].undoneBy, undo.entryId);
  assert.deepEqual(await readProjectActions(store, { projectId: "beta" }), []);
  assert.equal(store.documents.has(journalKeyOf("alpha")), true);

  for (const broken of [{ action: "agent.delete" }, { action: "agent.create", actor: { kind: "robot" } },
    { action: "agent.create", actor: PERSON, projectId: "../x", summary: "x" },
    { action: "agent.create", actor: PERSON, projectId: "alpha", summary: "" },
    { action: "agent.create", actor: PERSON, projectId: "alpha", summary: "x", undo: { kind: "delete-all" } },
    { action: "agent.create", actor: PERSON, projectId: "alpha", summary: "x", noUndo: "because" }]) {
    await assert.rejects(recordAction(store, broken), { code: "journal_invalid_entry" });
  }
  // The quiet form reports instead of failing; no text of the entry reaches the diagnostic.
  const diagnostics = [];
  assert.equal(await recordActionQuietly(store, { action: "agent.create", actor: PERSON, projectId: "alpha", summary: "" },
    { onDiagnostic: (record) => diagnostics.push(record) }), null);
  assert.deepEqual(diagnostics, [{ schemaVersion: 1, component: "action-journal", phase: "record", action: "agent.create",
    reasonCode: "journal_invalid_entry" }]);

  // A long journal keeps its newest entries within the store's document size.
  for (let index = 0; index < 1_100; index += 1) {
    await recordAction(store, { action: "memory.write", actor: PERSON, projectId: "big", summary: `Write ${index} ${"x".repeat(200)}`,
      undo: { kind: "memory-revision", scopeId: "big-memory", revision: index + 1, expectRevision: index + 2 } }, { now });
  }
  const kept = store.documents.get(journalKeyOf("big")).value.entries;
  assert.ok(kept.length < 1_100 && Buffer.byteLength(JSON.stringify(kept)) <= 200 * 1024);
  assert.match(kept.at(-1).summary, /^Write 1099 /u);
});

test("the person's changes through the Gateway are journaled once, and each undo brings back what was", async (t) => {
  const root = await controller(t);
  const service = await serviceOf(root);
  t.after(() => service.close());
  const call = gateway(service);
  await project(call);
  const create = { agentId: "a", projectId: "alpha", quarterId: "q1", operationId: "create-a", profile: PROFILE };
  await call("mutation.memory.agent.create", create);
  await call("mutation.memory.agent.create", create);
  await call("mutation.memory.agent.profile", { agentId: "a", profile: { ...PROFILE, model: "claude-b" } });
  await call("mutation.memory.agent.close", { agentId: "a", operationId: "close-a" });
  await call("mutation.memory.agent.close", { agentId: "a", operationId: "close-a" });
  const entries = await readProjectActions(service.store, { projectId: "alpha" });
  assert.deepEqual(entries.map((entry) => [entry.action, entry.summary]), [
    ["agent.close", "Closed agent a"],
    ["agent.profile", "Model of a: claude-a (default) → claude-b (default)"],
    ["agent.create", "Created agent a (claude-a)"],
    ["scope.create", "Created quarter \"Q1\""],
    ["scope.create", "Created project \"Alpha\""],
  ], "a retried operation adds nothing");
  assert.ok(entries.every((entry) => entry.actor.kind === "person" && entry.projectId === "alpha"));
  const [closed, profiled, created, quarter] = entries;
  const undo = (entry) => undoAction({ controllerRoot: root, store: service.store, service, projectId: "alpha",
    entryId: entry.entryId });

  // Closed - opened again, with the same conversation binding.
  const reopened = await undo(closed);
  assert.equal(reopened.undo.action, "agent.reopen");
  assert.equal(reopened.undo.undoes, closed.entryId);
  let agent = service.find((await service.catalog()).value, "a");
  assert.equal(agent.state, "active");
  assert.equal(agent.binding.threadId, "thread-a");
  await assert.rejects(undo(closed), { code: "journal_already_undone" });
  await assert.rejects(undo(reopened.undo), { code: "journal_not_undoable" });
  // The model - back to the one before.
  await undo(profiled);
  assert.equal(service.find((await service.catalog()).value, "a").profile.model, "claude-a");
  // A later change stands in the way of an earlier undo.
  await call("mutation.memory.agent.profile", { agentId: "a", profile: { ...PROFILE, model: "claude-b" } });
  await call("mutation.memory.agent.profile", { agentId: "a", profile: { ...PROFILE, reasoningEffort: "high" } });
  const [latest, earlier] = await readProjectActions(service.store, { projectId: "alpha", limit: 2 });
  await assert.rejects(undo(earlier), { code: "journal_undo_stale" });
  await undo(latest);
  await undo(earlier);
  assert.equal(service.find((await service.catalog()).value, "a").profile.model, "claude-a");
  // A model the provider no longer offers is not brought back.
  await call("mutation.memory.agent.profile", { agentId: "a", profile: { ...PROFILE, model: "claude-b" } });
  await writeFile(path.join(root, ".project-local", "application-gateway", "claude-provider.json"),
    JSON.stringify({ schemaVersion: 1, sdkPath: path.join(root, "sdk"), models: [{ id: "claude-b" }] }));
  const [onB] = await readProjectActions(service.store, { projectId: "alpha", limit: 1 });
  await assert.rejects(undo(onB), { code: "journal_undo_model_unavailable" });

  // Created and never used - closed; once it worked, the person closes it instead.
  await undo(created);
  agent = service.find((await service.catalog()).value, "a");
  assert.equal(agent.state, "archived");
  await call("mutation.memory.agent.create", { ...create, agentId: "b", operationId: "create-b" });
  const [bornB] = await readProjectActions(service.store, { projectId: "alpha", limit: 1 });
  await service.change((doc) => { service.find(doc, "b").operations.push({ operationId: "send-1", state: "completed" }); });
  await assert.rejects(undo(bornB), { code: "journal_undo_agent_worked" });
  // A quarter with an open agent is not archived; once it has none, its creation is undone.
  await assert.rejects(undo(quarter), { code: "memory_quarter_has_agents" });
  await service.change((doc) => { Object.assign(service.find(doc, "b"), { state: "archived", operations: [] }); });
  await undo(quarter);
  assert.equal((await archivedSets(service.store)).quarters.has("alpha/q1"), true);
  // An archived quarter keeps a closed agent closed.
  const closedOnce = (await readProjectActions(service.store, { projectId: "alpha" }))
    .find((entry) => entry.action === "agent.close" && entry.undoes === created.entryId);
  assert.ok(closedOnce, "the undo of a creation is journaled as a closing");
});

test("the trusted host's changes are journaled, read and undone through the memory CLI", async (t) => {
  const root = await controller(t);
  const service = await serviceOf(root);
  const call = gateway(service);
  await project(call);
  await call("mutation.memory.agent.create", { agentId: "lead", projectId: "alpha", quarterId: "q1",
    operationId: "create-lead", profile: PROFILE });
  await service.close();

  await cli(root, "set-agent-settings", { commandId: "settings-1", agentId: "lead", expectedRevision: 0,
    role: "project-lead", writeZone: null }, { "confirm-user-command": "settings-1" });
  await cli(root, "set-permission-mode", { agentId: "lead", permissionMode: "acceptEdits" }, { "confirm-agent": "lead" });
  await cli(root, "set-permission-mode", { agentId: "lead", permissionMode: "acceptEdits" }, { "confirm-agent": "lead" });
  await cli(root, "save-user-edit", { scopeId: "alpha-memory", expectedRevision: 1,
    entries: [{ id: "rules", title: "Rules", text: "Keep the API." }], operationId: "edit-1", commandId: "edit-1",
    actorId: "project-owner" }, { "confirm-user-command": "edit-1" });
  await cli(root, "save-user-edit", { scopeId: "alpha-memory", expectedRevision: 2,
    entries: [{ id: "rules", title: "Rules", text: "Keep the API stable." }], operationId: "edit-2", commandId: "edit-2",
    actorId: "project-owner" }, { "confirm-user-command": "edit-2" });
  await cli(root, "archive-quarter", { projectId: "alpha", quarterId: "q2" }, { "confirm-project": "alpha",
    "confirm-quarter": "q2" }).catch(() => null);

  const journal = await cli(root, "read-journal", { projectId: "alpha" });
  assert.deepEqual(journal.entries.map((entry) => entry.action), ["memory.write", "memory.write",
    "agent.permission-mode", "agent.settings", "agent.create", "scope.create", "scope.create"],
  "a refused action and a repeated one are not journaled");
  const all = await cli(root, "read-journal");
  assert.equal(all.entries.length, journal.entries.length);
  const [secondEdit, firstEdit, mode, settings] = journal.entries;
  assert.equal(firstEdit.summary, "Memory \"Alpha\": revision 1 → 2");

  const undo = (entry, confirm = entry.entryId) => cli(root, "undo-action", { projectId: "alpha", entryId: entry.entryId },
    { "confirm-entry": confirm });
  await assert.rejects(undo(settings, "another-entry"), /invalid_argument:confirm-entry/u);
  // The memory: the first edit waits for the second; the second goes back to the first's text.
  await assert.rejects(undo(firstEdit), /journal_undo_stale/u);
  await undo(secondEdit);
  const reread = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  t.after(() => reread.close());
  let memory = await reread.store.readScope({ scopeId: "alpha-memory" });
  assert.equal(memory.revision, 4);
  assert.deepEqual(memory.entries, [{ id: "rules", title: "Rules", text: "Keep the API." }]);
  // The undo itself is the newest entry; the first edit is still in the way of nothing now.
  const [undid] = (await cli(root, "read-journal", { projectId: "alpha", limit: 1 })).entries;
  assert.equal(undid.undoes, secondEdit.entryId);
  await assert.rejects(undo(firstEdit), /journal_undo_stale/u, "revision 4 is not what the first edit left");

  await undo(settings);
  await undo(mode);
  const lead = reread.find((await reread.catalog()).value, "lead");
  assert.equal(lead.settings.role, "feature");
  assert.equal(lead.permissionMode, undefined);
  memory = await reread.store.readScope({ scopeId: "alpha-memory" });
  assert.equal(memory.revision, 4, "undoing other entries leaves the memory alone");
});

test("each project's journal lives in its own database and goes into its package", async (t) => {
  const root = await controller(t, { split: true });
  const service = await serviceOf(root);
  t.after(() => service.close());
  const call = gateway(service);
  await project(call, "alpha");
  await project(call, "beta");
  assert.deepEqual((await readProjectActions(service.store, { projectId: "beta" })).map((entry) => entry.summary),
    ["Created quarter \"Q1\"", "Created project \"Alpha\""]);
  for (const projectId of ["alpha", "beta"]) {
    const mounted = (await mountedProjects(root)).find((item) => item.projectId === projectId);
    const db = openReadOnlyDatabase(await loadNodeSqlite(), path.join(mounted.folder, "memory.sqlite"));
    try {
      const keys = db.prepare("SELECT key FROM memory_documents").all().map((row) => row.key);
      assert.ok(keys.includes(journalKeyOf(projectId)), projectId);
      assert.ok(!keys.includes(journalKeyOf(projectId === "alpha" ? "beta" : "alpha")), projectId);
    } finally {
      db.close();
    }
  }

  // Where a project may be kept (a fact of the split world): journaled and undone.
  await service.close();
  await cli(root, "set-project-policy", { projectId: "alpha", policy: { homeOnly: true, allowedMachines: null } },
    { "confirm-project": "alpha" });
  const [policy] = (await cli(root, "read-journal", { projectId: "alpha", limit: 1 })).entries;
  assert.equal(policy.action, "project.policy");
  assert.equal(policy.summary, "Where alpha may be kept: home only");
  await cli(root, "undo-action", { projectId: "alpha", entryId: policy.entryId }, { "confirm-entry": policy.entryId });
  assert.deepEqual((await cli(root, "read-world-registry")).projects.alpha.policy, { homeOnly: false, allowedMachines: null });

  // A single database: the package of a project takes its journal and not another's.
  const row = (projectId) => ({ key: journalKeyOf(projectId), revision: 1,
    value_json: JSON.stringify({ schemaVersion: 1, projectId, entries: [] }) });
  const memory = { scopes: [
    { scope_id: "alpha-memory", kind: "project", project_id: "alpha", quarter_id: null, title: "Alpha", current_revision: 1 },
    { scope_id: "beta-memory", kind: "project", project_id: "beta", quarter_id: null, title: "Beta", current_revision: 1 }],
  revisions: [], operations: [], grants: [], documents: [row("alpha"), row("beta")] };
  const records = selectProjectRecords({ memory, archive: null, projectId: "alpha" });
  assert.deepEqual(records.documents.map((document) => document.key), [journalKeyOf("alpha")]);
  assert.deepEqual(records.unassignedDocuments, []);
});

test("a file saved from Atlas comes back to the version before the save, while nothing changed it since", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "action-journal-file-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "work");
  await mkdir(path.join(folder, "docs"), { recursive: true });
  await writeFile(path.join(folder, "docs", "notes.md"), "first\n");
  const store = documentStore();
  await bindProjectWorkspace(store, { projectId: "alpha", workspacePath: folder });
  const reads = createApplicationProjectWorkspaceHandlers({ store, sourceId: SOURCE, instanceId: "journal-files" });
  const read = async () => (await reads["query.project-workspace.read"]({ input: { projectId: "alpha", path: "docs/notes.md" } }))
    .contentSha256;
  const service = { store };
  const handlers = journalGatewayHandlers({ "mutation.project-workspace.save": createApplicationProjectWorkspaceSaveHandler({
    store, readProject: reads["query.project-workspace.read"] }) }, { service, controllerRoot: root });
  const save = async (text, operationId) => handlers["mutation.project-workspace.save"]({ input: { projectId: "alpha",
    path: "docs/notes.md", operationId, expectedSha256: await read(), text } });
  const undo = (entry) => undoAction({ controllerRoot: root, store, service, projectId: "alpha", entryId: entry.entryId });
  const file = () => readFile(path.join(folder, "docs", "notes.md"), "utf8");

  await save("second\n", "save-1");
  const [saved] = await readProjectActions(store, { projectId: "alpha" });
  assert.equal(saved.summary, "Saved docs/notes.md");
  assert.equal(saved.undo.kind, "restore-file");
  // The kept copy is in this PC's journal folder, not in the project folder.
  const kept = path.join(root, ".project-local", "journal-files", journalKeyOf("alpha").slice(-32), saved.undo.sha256);
  assert.equal(await readFile(kept, "utf8"), "first\n");
  await save("third\n", "save-2");
  await assert.rejects(undo(saved), { code: "journal_undo_stale" });
  const [later] = await readProjectActions(store, { projectId: "alpha" });
  await undo(later);
  assert.equal(await file(), "second\n");
  await undo(saved);
  assert.equal(await file(), "first\n");
  const [restored] = await readProjectActions(store, { projectId: "alpha" });
  assert.equal(restored.summary, "docs/notes.md back to the version before the save");
  assert.equal(restored.undoes, saved.entryId);

  // Saved on another PC (the copy is not here): said so, the file stays.
  await save("fourth\n", "save-3");
  const [elsewhere] = await readProjectActions(store, { projectId: "alpha" });
  await rm(path.join(root, ".project-local", "journal-files"), { recursive: true, force: true });
  await assert.rejects(undo(elsewhere), { code: "journal_undo_file_not_here" });
  assert.equal(await file(), "fourth\n");
});

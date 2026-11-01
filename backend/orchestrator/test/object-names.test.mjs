import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { journalGatewayHandlers } from "../src/action-journal-gateway.mjs";
import { createApplicationProjectMemoryHandlers } from "../src/application-project-memory.mjs";
import { idStem, newObjectId } from "../src/object-ids.mjs";
import { nameOf, namesKeyOf, normalizeName, readNames, setName } from "../src/object-names.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { selectProjectRecords } from "../src/project-package-export.mjs";
import { mountedProjects, writeStoreLayoutMarker } from "../src/project-store-layout.mjs";
import { loadNodeSqlite } from "../src/sqlite-backend.mjs";
import { openReadOnlyDatabase } from "../src/sqlite-node-connection.mjs";

// Names and hidden IDs (roadmap step 2): an ID made from the first name never
// changes; the name is free text, renamed by the trusted host, journaled and
// undone, kept in the project's own database.

const SOURCE = "controller";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const PROFILE = { provider: "claude", model: "claude-a", reasoningEffort: "default", fallbackPolicy: "deny" };

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
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "object-names-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: SOURCE }));
  await writeFile(path.join(root, "project-version.json"), JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  if (split) {
    await writeFile(path.join(root, "instance.json"), JSON.stringify({ schemaVersion: 1, instanceId: "names" }));
    await writeStoreLayoutMarker(root);
  }
  return root;
}

async function world(root) {
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  service.provider = { preflight: async () => {}, capture: async () => {},
    create: async (agent) => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "claude", threadId: `thread-${agent.agentId}` }) };
  const handlers = journalGatewayHandlers(createApplicationProjectMemoryHandlers({ service }), { service });
  const call = (operationId, input) => handlers[operationId]({ input });
  for (const projectId of ["alpha", "beta"]) {
    await call("mutation.memory.scope.create", { scopeId: `${projectId}-memory`, kind: "project", projectId, quarterId: null,
      title: projectId, operationId: `create-${projectId}` });
    await call("mutation.memory.scope.create", { scopeId: `${projectId}-q1`, kind: "quarter", projectId, quarterId: "q1",
      title: "q1", operationId: `create-${projectId}-q1` });
  }
  await call("mutation.memory.agent.create", { agentId: "studio", projectId: "alpha", quarterId: "q1", operationId: "create-studio",
    profile: PROFILE });
  await service.close();
}

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

test("an ID is made of the first name's Latin letters and four random characters", () => {
  assert.equal(idStem("Billing"), "billing");
  assert.equal(idStem("Квартал оплаты"), "kvartal-oplaty");
  assert.equal(idStem("Ёлка и щука"), "elka-i-shchuka");
  assert.equal(idStem("Café crème — v2"), "cafe-creme-v2");
  assert.equal(idStem("  !!!  "), "item");
  assert.equal(idStem("日本語"), "item");
  assert.equal(idStem("a".repeat(60)), "a".repeat(40));
  assert.equal(idStem(`${"word ".repeat(7)}x`).length <= 40, true);
  assert.equal(idStem(`${"word ".repeat(7)}x`).endsWith("-"), false);

  const fixed = (values) => { let call = 0; return (length) => Buffer.from(values[call++].slice(0, length)); };
  assert.equal(newObjectId("Billing", { random: fixed([[7, 15, 3, 20]]) }), "billing-7f3k");
  // A taken ID is not given again.
  assert.equal(newObjectId("Billing", { taken: ["billing-7f3k"], random: fixed([[7, 15, 3, 20], [0, 1, 2, 3]]) }),
    "billing-0123");
  for (const name of ["Платёжный шлюз", "UI · mobile", "x", "", "ровно сорок символов и ещё немного текста сверху"]) {
    const made = newObjectId(name);
    assert.match(made, ID, name);
    assert.match(made, /-[0-9a-z]{4}$/u, name);
  }
});

test("names: free text, kept per project, an object without one is named by its ID", async () => {
  const store = documentStore();
  assert.deepEqual(await readNames(store, "alpha"), { project: null, quarters: {}, agents: {} });
  assert.equal(nameOf(await readNames(store, "alpha"), "agent", "studio"), "studio");
  assert.deepEqual(await setName(store, { projectId: "alpha", kind: "agent", objectId: "studio", name: "  Майя   ведущая " }),
    { projectId: "alpha", kind: "agent", objectId: "studio", previous: null, name: "Майя ведущая" });
  await setName(store, { projectId: "alpha", kind: "project", objectId: "alpha", name: "Платёжный шлюз" });
  const names = await readNames(store, "alpha");
  assert.equal(nameOf(names, "agent", "studio"), "Майя ведущая");
  assert.equal(nameOf(names, "project", "alpha"), "Платёжный шлюз");
  assert.equal(nameOf(names, "quarter", "q1"), "q1");
  assert.equal((await setName(store, { projectId: "alpha", kind: "agent", objectId: "studio", name: null })).previous,
    "Майя ведущая");
  assert.equal(nameOf(await readNames(store, "alpha"), "agent", "studio"), "studio");
  assert.ok(store.documents.has(namesKeyOf("alpha")));
  for (const broken of ["", "   ", "a".repeat(121), "line\u0001break", 7]) assert.throws(() => normalizeName(broken), { code: "name_invalid" });
  assert.equal(normalizeName("ж".repeat(120)).length, 120);
  await assert.rejects(setName(store, { projectId: "alpha", kind: "project", objectId: "beta", name: "x" }),
    { code: "name_invalid_input" });
  await assert.rejects(setName(store, { projectId: "alpha", kind: "user", objectId: "x", name: "x" }), { code: "name_invalid_input" });
});

test("the trusted host renames a project, a quarter and an agent; the rename is journaled and undone", async (t) => {
  const root = await controller(t);
  await world(root);
  const rename = (input) => cli(root, "rename", input, { "confirm-project": input.projectId });
  await rename({ projectId: "alpha", kind: "project", objectId: "alpha", name: "Платёжный шлюз" });
  await rename({ projectId: "alpha", kind: "quarter", objectId: "q1", name: "Квартал оплаты" });
  await rename({ projectId: "alpha", kind: "agent", objectId: "studio", name: "Майя" });
  await rename({ projectId: "alpha", kind: "agent", objectId: "studio", name: "Майя" });
  await assert.rejects(rename({ projectId: "alpha", kind: "agent", objectId: "ghost", name: "x" }), /name_object_not_found/u);
  await assert.rejects(rename({ projectId: "beta", kind: "agent", objectId: "studio", name: "x" }), /name_object_not_found/u);
  await assert.rejects(rename({ projectId: "alpha", kind: "quarter", objectId: "q9", name: "x" }), /name_object_not_found/u);
  await assert.rejects(cli(root, "rename", { projectId: "alpha", kind: "project", objectId: "alpha", name: "x" },
    { "confirm-project": "beta" }), /invalid_argument:confirm-project/u);

  const names = await cli(root, "read-names");
  assert.deepEqual(names.projects.alpha, { project: "Платёжный шлюз", quarters: { q1: "Квартал оплаты" }, agents: { studio: "Майя" } });
  assert.deepEqual(names.projects.beta, { project: null, quarters: {}, agents: {} });
  assert.deepEqual(Object.keys(names.projects).sort(), ["alpha", "beta", "world"]);
  assert.deepEqual((await cli(root, "read-names", { projectId: "beta" })).projects, { beta: { project: null, quarters: {}, agents: {} } });

  const journal = (await cli(root, "read-journal", { projectId: "alpha" })).entries;
  const renames = journal.filter((entry) => entry.action === "object.rename");
  assert.deepEqual(renames.map((entry) => entry.summary), ["Renamed agent studio: \"studio\" → \"Майя\"",
    "Renamed quarter q1: \"q1\" → \"Квартал оплаты\"", "Renamed project alpha: \"alpha\" → \"Платёжный шлюз\""],
  "the same name again is not a change");
  const [agentRename, quarterRename] = renames;
  assert.equal(agentRename.agentId, "studio");
  // A later rename stands in the way of an earlier undo; undone, the object is named as before.
  await rename({ projectId: "alpha", kind: "quarter", objectId: "q1", name: "Оплата" });
  const undo = (entry) => cli(root, "undo-action", { projectId: "alpha", entryId: entry.entryId }, { "confirm-entry": entry.entryId });
  await assert.rejects(undo(quarterRename), /journal_undo_stale/u);
  await undo(agentRename);
  const after = (await cli(root, "read-names", { projectId: "alpha" })).projects.alpha;
  assert.deepEqual(after.agents, {});
  assert.equal(after.quarters.q1, "Оплата");
  const [undid] = (await cli(root, "read-journal", { projectId: "alpha", limit: 1 })).entries;
  assert.equal(undid.summary, "Name of agent studio back to \"studio\"");
});

test("a project's names live in its own database and go into its package", async (t) => {
  const root = await controller(t, { split: true });
  await world(root);
  await cli(root, "rename", { projectId: "alpha", kind: "project", objectId: "alpha", name: "Альфа" }, { "confirm-project": "alpha" });
  await cli(root, "rename", { projectId: "beta", kind: "quarter", objectId: "q1", name: "Бета-квартал" }, { "confirm-project": "beta" });
  for (const projectId of ["alpha", "beta"]) {
    const mounted = (await mountedProjects(root)).find((item) => item.projectId === projectId);
    const db = openReadOnlyDatabase(await loadNodeSqlite(), path.join(mounted.folder, "memory.sqlite"));
    try {
      const keys = db.prepare("SELECT key FROM memory_documents").all().map((row) => row.key);
      assert.ok(keys.includes(namesKeyOf(projectId)), projectId);
      assert.ok(!keys.includes(namesKeyOf(projectId === "alpha" ? "beta" : "alpha")), projectId);
    } finally {
      db.close();
    }
  }
  const row = (projectId) => ({ key: namesKeyOf(projectId), revision: 1,
    value_json: JSON.stringify({ schemaVersion: 1, projectId, project: projectId, quarters: {}, agents: {} }) });
  const memory = { scopes: [
    { scope_id: "alpha-memory", kind: "project", project_id: "alpha", quarter_id: null, title: "Alpha", current_revision: 1 },
    { scope_id: "beta-memory", kind: "project", project_id: "beta", quarter_id: null, title: "Beta", current_revision: 1 }],
  revisions: [], operations: [], grants: [], documents: [row("alpha"), row("beta")] };
  const records = selectProjectRecords({ memory, archive: null, projectId: "beta" });
  assert.deepEqual(records.documents.map((document) => document.key), [namesKeyOf("beta")]);
});

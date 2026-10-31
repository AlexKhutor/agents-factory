import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectPolicy, readMachines, readThisMachine, setThisMachine } from "../src/machine-identity.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { mountProject, unmountProject } from "../src/project-mount.mjs";
import { writeStoreLayoutMarker } from "../src/project-store-layout.mjs";
import { projectSummary, readWorldRegistry, unmountedWorldProjects, worldRegistryView } from "../src/world-registry.mjs";
import { put, skip } from "./fixtures/project-package-fixture.mjs";

// Block 2 additions (owner, 2026-10-26): every PC has a name; a project may be kept
// to some PCs; the world records where each project is and a summary without text,
// and a project made here is in the registry at once.

const SOURCE = "registry-fixture";
const CANARY = "OFFICE-CANARY-4410";
const profile = { provider: "fixture", model: "m", reasoningEffort: "max", fallbackPolicy: "deny" };

async function service(root) {
  let tick = 0;
  return createProjectMemoryService({ controllerRoot: root, now: () => new Date(Date.UTC(2026, 9, 26, 9, 0, tick++)),
    provider: { preflight: async () => {}, capture: async () => {},
      create: async (agent) => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "fixture", threadId: `thread-${agent.agentId}` }) } });
}

async function splitInstance(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-registry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  await put(root, "instance.json", JSON.stringify({ schemaVersion: 1, instanceId: "world-r" }));
  await writeStoreLayoutMarker(root);
  return root;
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

test("a PC has a name the world knows, and a policy names PCs only", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-machine-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readThisMachine(root), null);
  assert.deepEqual(await setThisMachine(root, { machineId: "office", title: "Office" }), { machineId: "office", title: "Office", home: false });
  await setThisMachine(root, { machineId: "home", title: "Home", home: true });
  assert.deepEqual(await readThisMachine(root), { machineId: "home", title: "Home", home: true });
  assert.deepEqual(await readMachines(root), { home: { title: "Home", home: true }, office: { title: "Office", home: false } });
  // Renaming keeps the home mark unless it is given again.
  await setThisMachine(root, { machineId: "home", title: "Flat" });
  assert.deepEqual(await readThisMachine(root), { machineId: "home", title: "Flat", home: true });
  await assert.rejects(setThisMachine(root, { machineId: "../x" }), { code: "machine_id_invalid" });
  await assert.rejects(setThisMachine(root, { machineId: "pc", title: "" }), { code: "machine_title_invalid" });

  assert.deepEqual(projectPolicy({ homeOnly: false, allowedMachines: ["office", "home"] }),
    { homeOnly: false, allowedMachines: ["home", "office"] });
  for (const bad of [null, {}, { homeOnly: "yes", allowedMachines: null }, { homeOnly: false, allowedMachines: [] },
    { homeOnly: false, allowedMachines: ["a b"] }, { homeOnly: false, allowedMachines: ["x", "x"] },
    { homeOnly: false, allowedMachines: null, extra: 1 }]) {
    assert.throws(() => projectPolicy(bad), { code: "policy_invalid" });
  }
});

test("the summary counts and dates, never text", () => {
  const summary = projectSummary({
    projectId: "p",
    agents: [
      { projectId: "p", state: "active", createdAtUtc: "2026-10-01T00:00:00.000Z", operations: [{ requestedAtUtc: "2026-10-20T10:00:00.000Z" }] },
      { projectId: "p", state: "archived", createdAtUtc: "2026-10-02T00:00:00.000Z", operations: [] },
      { projectId: "other", state: "active", createdAtUtc: "2026-10-25T00:00:00.000Z", operations: [] },
    ],
    scopes: [{ kind: "project", projectId: "p" }, { kind: "quarter", projectId: "p", quarterId: "hq" },
      { kind: "quarter", projectId: "p", quarterId: "a" }, { kind: "quarter", projectId: "p", quarterId: "old" }],
    archive: { quarters: { "p/old": {} } },
    tasks: [{ stage: "planned" }, { stage: "accepted-by-code" }, { stage: "declined" }, { stage: "reported" }],
  });
  assert.deepEqual(summary, { agents: 1, quarters: 1, tasksOpen: 2, lastActivityUtc: "2026-10-20T10:00:00.000Z" });
});

test("a project made here is in the registry at once, with this PC as its place", { skip }, async (t) => {
  const root = await splitInstance(t);
  await setThisMachine(root, { machineId: "office", title: "Office" });
  const memory = await service(root);
  await memory.store.createScope({ scopeId: "world-memory", kind: "project", projectId: "world", quarterId: null, title: "World", operationId: "op-w" });
  await memory.store.createScope({ scopeId: "work-memory", kind: "project", projectId: "work", quarterId: null, title: "Work", operationId: "op-p" });
  const first = (await readWorldRegistry(root)).projects;
  assert.equal(first.world, undefined);
  assert.equal(first.work.title, "Work");
  assert.equal(first.work.location.machineId, "office");
  assert.deepEqual(first.work.summary, { agents: 0, quarters: 0, tasksOpen: 0, lastActivityUtc: null });
  // A replayed creation leaves the record as it is.
  await memory.store.createScope({ scopeId: "work-memory", kind: "project", projectId: "work", quarterId: null, title: "Work", operationId: "op-p" });
  assert.deepEqual((await readWorldRegistry(root)).projects.work, first.work);
  await memory.close();
});

test("policy, place and summary through unmount and mount; the trusted host reads and sets them", { skip }, async (t) => {
  const root = await splitInstance(t);
  await setThisMachine(root, { machineId: "office", title: "Office" });
  const memory = await service(root);
  for (const [scopeId, kind, projectId, quarterId, title] of [["world-memory", "project", "world", null, "World"],
    ["work-memory", "project", "work", null, "Work"], ["work-q-memory", "quarter", "work", "q", "Q"]]) {
    await memory.store.createScope({ scopeId, kind, projectId, quarterId, title, operationId: `op-${scopeId}` });
  }
  const entries = [{ id: "e1", title: "Notes", text: `${CANARY} is office content` }];
  await memory.store.authorizeWrite({ commandId: "cmd-1", scopeId: "work-memory", expectedRevision: 1, entries, requestedBy: "owner" });
  await memory.store.write({ scopeId: "work-memory", expectedRevision: 1, entries, operationId: "write-1", commandId: "cmd-1", actorId: "owner" });
  await memory.createAgent({ agentId: "worker", projectId: "work", quarterId: "q", operationId: "create-worker", profile });
  await memory.close();

  // Only this PC: the person's choice in the trusted host, named twice.
  const policy = { homeOnly: false, allowedMachines: ["office"] };
  await assert.rejects(cli(root, "set-project-policy", { projectId: "work", policy }, { "confirm-project": "other" }));
  await assert.rejects(cli(root, "set-project-policy", { projectId: "nope", policy }, { "confirm-project": "nope" }), { code: "project_not_found" });
  await assert.rejects(cli(root, "set-project-policy", { projectId: "work", policy: { homeOnly: 1 } }, { "confirm-project": "work" }),
    { code: "policy_invalid" });
  assert.deepEqual(await cli(root, "set-project-policy", { projectId: "work", policy }, { "confirm-project": "work" }),
    { schemaVersion: 1, projectId: "work", policy });
  const view = await cli(root, "read-world-registry");
  assert.equal(view.split, true);
  assert.deepEqual(view.thisMachine, { machineId: "office", title: "Office", home: false });
  assert.equal(view.projects.work.here, true);
  assert.deepEqual(view.projects.work.policy, policy);

  // The package carries the recorded policy; the world keeps the place and a summary.
  const out = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), "af-registry-package-"))), "work");
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  await unmountProject({ controllerRoot: root, projectId: "work", out, confirm: "work" });
  assert.deepEqual(JSON.parse(await readFile(path.join(out, "project.af.json"), "utf8")).policy, policy);
  const away = await unmountedWorldProjects(root);
  assert.equal(away.length, 1);
  assert.equal(away[0].projectId, "work");
  assert.deepEqual(away[0].allowedMachines, ["office"]);
  assert.equal(away[0].location.machineId, null);
  assert.deepEqual({ ...away[0].summary, lastActivityUtc: typeof away[0].summary.lastActivityUtc },
    { agents: 1, quarters: 1, tasksOpen: 0, lastActivityUtc: "string" });
  assert.ok(!JSON.stringify(await worldRegistryView(root)).includes(CANARY));
  assert.equal((await cli(root, "read-world-registry")).projects.work.here, false);

  // Mounted again here: this PC is its place.
  await mountProject({ controllerRoot: root, packageDir: out });
  const back = (await readWorldRegistry(root)).projects.work;
  assert.equal(back.location.machineId, "office");
  assert.deepEqual(back.policy, policy);
  assert.deepEqual(await unmountedWorldProjects(root), []);
});

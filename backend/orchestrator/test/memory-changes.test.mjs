import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { journalGatewayHandlers } from "../src/action-journal-gateway.mjs";
import { createApplicationProjectMemoryHandlers } from "../src/application-project-memory.mjs";
import { applyChanges, changesKeyOf, normalizeChanges } from "../src/memory-changes.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { selectProjectRecords } from "../src/project-package-export.mjs";
import { recordWorldProjects } from "../src/world-registry.mjs";

// The agent's own memory changes (roadmap track V, item 2a): an agent asks to add,
// change or remove entries of a memory it may change; the person approves or
// rejects the change in the chat; its own memory may be written at once when the
// person allowed that.

const SOURCE = "controller";
const PROFILE = { provider: "claude", model: "claude-a", reasoningEffort: "default", fallbackPolicy: "deny" };
const fixed = (bytes) => () => Uint8Array.from(bytes);

test("changes are set and delete by title; nothing changed, or an unknown entry, is refused", () => {
  const entries = [{ id: "part-1", title: "Goal", text: "Ship it" }, { id: "part-2", title: "Style", text: "Short" }];
  const changes = normalizeChanges([{ action: "set", title: "goal", text: "Ship it on Friday" },
    { action: "set", title: "Owner", text: "Nova" }, { action: "delete", title: "Style" }]);
  const { entries: next, diff } = applyChanges(entries, changes, { random: fixed([1, 2, 3, 4]) });
  assert.deepEqual(next, [{ id: "part-1", title: "Goal", text: "Ship it on Friday" },
    { id: "note-1234", title: "Owner", text: "Nova" }]);
  assert.deepEqual(diff.map((line) => [line.change, line.title]), [["changed", "Goal"], ["added", "Owner"], ["removed", "Style"]]);
  assert.throws(() => applyChanges(entries, normalizeChanges([{ action: "set", title: "Goal", text: "Ship it" }])),
    { code: "memory_change_empty" });
  assert.throws(() => applyChanges(entries, normalizeChanges([{ action: "delete", title: "Nope" }])),
    { code: "memory_change_no_entry" });
  assert.throws(() => normalizeChanges([{ action: "set", title: "Goal" }]), { code: "memory_change_invalid_input" });
  assert.throws(() => normalizeChanges([]), { code: "memory_change_invalid_input" });
});

async function controller(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "memory-changes-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: SOURCE }));
  await writeFile(path.join(root, "project-version.json"), JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  return root;
}

async function world(root) {
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  service.provider = { preflight: async () => {}, capture: async () => {},
    create: async (agent) => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "claude", threadId: `thread-${agent.agentId}` }) };
  const handlers = journalGatewayHandlers(createApplicationProjectMemoryHandlers({ service }), { service });
  const call = (operationId, input) => handlers[operationId]({ input });
  await call("mutation.memory.scope.create", { scopeId: "alpha-memory", kind: "project", projectId: "alpha", quarterId: null,
    title: "alpha", operationId: "create-alpha" });
  await call("mutation.memory.scope.create", { scopeId: "alpha-q1", kind: "quarter", projectId: "alpha", quarterId: "q1",
    title: "q1", operationId: "create-alpha-q1" });
  for (const agentId of ["nova", "lead"]) {
    await call("mutation.memory.agent.create", { agentId, projectId: "alpha", quarterId: "q1", operationId: `create-${agentId}`,
      profile: PROFILE });
  }
  await service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "project-lead", writeZone: null });
  return service;
}

/** More of the world: a quarter q2 in alpha, a home-only project beta, and the world lead's project hq. */
async function hierarchy(root, service) {
  const handlers = createApplicationProjectMemoryHandlers({ service });
  const call = (operationId, input) => handlers[operationId]({ input });
  const scope = (scopeId, kind, projectId, quarterId) => call("mutation.memory.scope.create", { scopeId, kind, projectId,
    quarterId, title: scopeId, operationId: `create-${scopeId}` });
  await scope("alpha-q2", "quarter", "alpha", "q2");
  for (const projectId of ["beta", "hq"]) {
    await scope(`${projectId}-memory`, "project", projectId, null);
    await scope(`${projectId}-q1`, "quarter", projectId, "q1");
  }
  const agents = [["qlead", "alpha", "q1", "quarter-lead"], ["far", "alpha", "q2", null], ["bee", "beta", "q1", null],
    ["chief", "hq", "q1", "coordinator"]];
  for (const [agentId, projectId, quarterId, role] of agents) {
    await call("mutation.memory.agent.create", { agentId, projectId, quarterId, operationId: `create-${agentId}`, profile: PROFILE });
    if (role !== null) await service.setAgentSettings({ agentId, expectedRevision: 0, role, writeZone: null });
  }
  await recordWorldProjects(root, [{ projectId: "beta", policy: { homeOnly: true, allowedMachines: null } }]);
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

test("an agent's change waits for the person; approved, it is written and journaled with its undo", async (t) => {
  const root = await controller(t);
  const service = await world(root);
  t.after(() => service.close());
  const asked = await service.proposeMemoryChange({ agentId: "nova", target: "own",
    changes: [{ action: "set", title: "Tools", text: "Use pnpm, not npm." }], reason: "the person said so" });
  assert.equal(asked.state, "pending");
  assert.deepEqual((await service.readMemoryFor({ agentId: "nova", target: "own" })).entries, [], "nothing is written yet");
  await assert.rejects(service.proposeMemoryChange({ agentId: "nova", target: "project",
    changes: [{ action: "set", title: "Rule", text: "x" }] }), { code: "memory_change_target_denied" });
  const pending = await cli(root, "read-memory-changes", { projectId: "alpha", states: ["pending"] });
  assert.deepEqual(pending.changes.map((item) => [item.changeId, item.agentId, item.target.kind]), [[asked.changeId, "nova", "own"]]);
  await assert.rejects(cli(root, "approve-memory-change", { projectId: "alpha", changeId: asked.changeId }), /confirm-change/u);
  const approved = await cli(root, "approve-memory-change", { projectId: "alpha", changeId: asked.changeId },
    { "confirm-change": asked.changeId });
  assert.equal(approved.state, "approved");
  assert.deepEqual((await service.readMemoryFor({ agentId: "nova", target: "own" })).entries,
    [{ title: "Tools", text: "Use pnpm, not npm." }]);
  const [entry] = (await cli(root, "read-journal", { projectId: "alpha", limit: 1 })).entries;
  assert.deepEqual([entry.action, entry.agentId, entry.undo?.kind], ["memory.write", "nova", "memory-revision"]);
  // A second change asked for the same revision is stale once the first was written.
  const first = await service.proposeMemoryChange({ agentId: "nova", target: "own",
    changes: [{ action: "delete", title: "Tools" }] });
  const second = await service.proposeMemoryChange({ agentId: "nova", target: "own",
    changes: [{ action: "set", title: "Tools", text: "Use yarn." }] });
  await service.decideMemoryChange({ projectId: "alpha", changeId: first.changeId, approve: true });
  await assert.rejects(service.decideMemoryChange({ projectId: "alpha", changeId: second.changeId, approve: true }),
    { code: "memory_change_stale" });
  const rejected = await service.proposeMemoryChange({ agentId: "nova", target: "own",
    changes: [{ action: "set", title: "Mood", text: "Calm" }] });
  assert.equal((await service.decideMemoryChange({ projectId: "alpha", changeId: rejected.changeId, approve: false })).state,
    "rejected");
  assert.deepEqual((await service.readMemoryFor({ agentId: "nova", target: "own" })).entries, []);
});

test("a lead asks to change the memory of the agents below it; the world lead not of a project kept to some PCs", async (t) => {
  const root = await controller(t);
  const service = await world(root);
  t.after(() => service.close());
  await hierarchy(root, service);
  const ask = (agentId, agentOf) => service.proposeMemoryChange({ agentId, target: "agent", agentOf,
    changes: [{ action: "set", title: "Note", text: `from ${agentId}` }] });
  // A quarter lead: its quarter's agents, not another quarter's.
  assert.equal((await ask("qlead", "nova")).state, "pending");
  await assert.rejects(ask("qlead", "far"), { code: "memory_change_target_denied" });
  // The world lead: an agent of a project that goes with the world, asked, as any other change...
  assert.equal((await ask("chief", "far")).state, "pending");
  assert.deepEqual((await service.readMemoryFor({ agentId: "chief", target: "agent", agentOf: "far" })).entries, []);
  // ... but a home-only project's memory never comes into its chat, neither read nor changed.
  await assert.rejects(ask("chief", "bee"), { code: "memory_change_target_kept" });
  await assert.rejects(service.readMemoryFor({ agentId: "chief", target: "agent", agentOf: "bee" }),
    { code: "memory_change_target_kept" });
  // A project lead stays in its project; a feature agent reaches no one.
  await assert.rejects(ask("lead", "bee"), { code: "memory_change_target_denied" });
  await assert.rejects(ask("far", "nova"), { code: "memory_change_target_denied" });
});

test("an agent allowed to may change its own memory without asking; a project lead asks for an agent's", async (t) => {
  const root = await controller(t);
  const service = await world(root);
  t.after(() => service.close());
  await cli(root, "set-memory-autonomy", { agentId: "nova", allowed: true }, { "confirm-agent": "nova" });
  const written = await service.proposeMemoryChange({ agentId: "nova", target: "own",
    changes: [{ action: "set", title: "Tools", text: "pnpm" }] });
  assert.equal(written.state, "written");
  assert.deepEqual((await service.readMemoryFor({ agentId: "nova", target: "own" })).entries, [{ title: "Tools", text: "pnpm" }]);
  assert.equal((await service.readPermissionModes()).agents.find((agent) => agent.agentId === "nova").ownMemoryWithoutAsking, true);
  // The lead may change the project's memory and, asked, nova's; a feature agent neither.
  const project = await service.proposeMemoryChange({ agentId: "lead", target: "project",
    changes: [{ action: "set", title: "Goal", text: "Ship" }] });
  const ofNova = await service.proposeMemoryChange({ agentId: "lead", target: "agent", agentOf: "nova",
    changes: [{ action: "set", title: "Tools", text: "npm" }] });
  assert.deepEqual([project.state, ofNova.state], ["pending", "pending"], "only an agent's own memory goes without asking");
  await assert.rejects(service.proposeMemoryChange({ agentId: "nova", target: "agent", agentOf: "lead",
    changes: [{ action: "set", title: "x", text: "y" }] }), { code: "memory_change_target_denied" });
  assert.equal((await service.readMemoryFor({ agentId: "lead", target: "agent", agentOf: "nova" })).entries[0].text, "pnpm");
  const { entries } = await cli(root, "read-journal", { projectId: "alpha", limit: 5 });
  assert.equal(entries.find((item) => item.action === "agent.memory-autonomy")?.noUndo, "setting_not_undone");
  // The project's changes go with it in its package.
  const memory = { scopes: [{ scope_id: "alpha-memory", kind: "project", project_id: "alpha", quarter_id: null, title: "a",
    current_revision: 1 }], revisions: [], operations: [], grants: [],
  documents: [{ key: changesKeyOf("alpha"), revision: 1, value_json: JSON.stringify({ schemaVersion: 1, changes: [] }) }] };
  assert.deepEqual(selectProjectRecords({ memory, archive: null, projectId: "alpha" }).documents.map((item) => item.key),
    [changesKeyOf("alpha")]);
});

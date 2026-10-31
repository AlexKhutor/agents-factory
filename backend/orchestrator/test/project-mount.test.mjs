import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { mountProject, unmountProject } from "../src/project-mount.mjs";
import { ProjectPackageError } from "../src/project-package-export.mjs";
import { mountedProjects, writeStoreLayoutMarker } from "../src/project-store-layout.mjs";
import { readWorldRegistry } from "../src/world-registry.mjs";
import { readWorldTaskBoard } from "../src/world-task-board.mjs";
import { put, skip } from "./fixtures/project-package-fixture.mjs";

const SOURCE = "mount-fixture";
const CANARY = "HOME-CANARY-7731";
const profile = { provider: "fixture", model: "m", reasoningEffort: "max", fallbackPolicy: "deny" };
const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 26, 3, 0, tick++));
}

async function service(root, now = clock()) {
  return createProjectMemoryService({ controllerRoot: root, now, provider: { preflight: async () => {}, capture: async () => {},
    create: async (agent) => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "fixture", threadId: `thread-${agent.agentId}` }) } });
}

/** A split instance: the world with its lead, an open project and a home-only project full of its own content. */
async function instance(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-mount-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  await put(root, "instance.json", JSON.stringify({ schemaVersion: 1, instanceId: "world-m" }));
  await writeStoreLayoutMarker(root);
  const memory = await service(root);
  const { store, archive } = memory;
  for (const [scopeId, kind, projectId, quarterId, title] of [
    ["world-memory", "project", "world", null, "World"], ["world-hq-memory", "quarter", "world", "hq", "HQ"],
    ["open-memory", "project", "open", null, "Open project"], ["open-q-memory", "quarter", "open", "q", "Q"],
    ["home-memory", "project", "home", null, "Home project"], ["home-q-memory", "quarter", "home", "q", "Q"]]) {
    await store.createScope({ scopeId, kind, projectId, quarterId, title, operationId: `op-${scopeId}` });
  }
  const entries = [{ id: "e1", title: "Mods", text: `${CANARY} lives in the home memory` }];
  await store.authorizeWrite({ commandId: "cmd-home", scopeId: "home-memory", expectedRevision: 1, entries, requestedBy: "owner" });
  await store.write({ scopeId: "home-memory", expectedRevision: 1, entries, operationId: "write-home", commandId: "cmd-home", actorId: "owner" });
  await memory.createAgent({ agentId: "lead", projectId: "world", quarterId: "hq", operationId: "create-lead", profile });
  const lead = await memory.readAgent({ agentId: "lead" });
  await memory.setAgentSettings({ agentId: "lead", expectedRevision: lead.settings.revision, role: "coordinator", writeZone: null });
  await memory.createAgent({ agentId: "open-agent", projectId: "open", quarterId: "q", operationId: "create-open-agent", profile });
  await memory.createAgent({ agentId: "home-agent", projectId: "home", quarterId: "q", operationId: "create-home-agent", profile });
  const home = await memory.readAgent({ agentId: "home-agent" });
  await archive.append(home.binding, { recordId: "r1", kind: "message", role: "user", state: "completed",
    text: `${CANARY} in a talk`, providerTurnId: null, providerItemId: null, requestId: null,
    occurredAtUtc: "2026-10-26T03:00:00.000Z", omissions: [] });
  await memory.close();
  const local = ".project-local";
  await put(root, `${local}/orchestration/claude-sessions/thread-home-agent/session.json`, JSON.stringify({ cwd: "x", note: CANARY }));
  await put(root, `${local}/orchestration/claude-sessions/thread-open-agent/session.json`, JSON.stringify({ cwd: "y" }));
  await put(root, "config/source-registry.json", JSON.stringify({ sources: [{ id: "desk-home-agent", deskAgentId: "home-agent" }] }));
  const packet = JSON.stringify({ taskId: "task-home-1", targetId: "desk-home-agent", title: `${CANARY} task`,
    dispatchedAtUtc: "2026-10-26T03:10:00.000Z" });
  await put(root, `${local}/desk-agents/desk-home-agent/.orchestrator/tasks/inbox/task-home-1/task.json`, packet);
  await put(root, `${local}/desk-agents/desk-home-agent/logs/run.log`, `machine log ${CANARY}`);
  await put(root, "coordination/tasks/dispatched/task-home-1/task.json", packet);
  await put(root, "knowledge/reports/inbox/desk-home-agent/2026-10-26-task-home-1.md", `# ${CANARY} report`);
  // Each agent's provider interaction store (an answered approval naming the agent's folder).
  for (const [scope, threadId, cwd] of [["a".repeat(64), "thread-home-agent", `E:\\${CANARY}\\mods`],
    ["b".repeat(64), "thread-open-agent", "W:\\open"]]) {
    await put(root, `${local}/orchestration/provider-interactions/${scope}/records.v1/${"c".repeat(64)}.json`,
      JSON.stringify({ interactionId: "provider-interaction:1", providerRequest: { threadId },
        display: { kind: "command-approval", fields: { cwd } }, state: "resolved" }));
  }
  return root;
}

const interactionRecord = (root, scope) => path.join(root, ".project-local", "orchestration", "provider-interactions",
  scope, "records.v1", `${"c".repeat(64)}.json`);

/** Every file under a folder that holds the text. */
async function holding(folder, text) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if ((await readFile(full)).includes(text)) found.push(path.relative(folder, full));
    }
  };
  await walk(folder);
  return found;
}

test("an unmounted home-only project leaves only its title in the world, and mounts back whole", { skip }, async (t) => {
  const root = await instance(t);
  const out = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), "af-package-"))), "home");
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  assert.ok((await holding(root, CANARY)).length >= 5);

  await assert.rejects(unmountProject({ controllerRoot: root, projectId: "home", out }), refused("unmount_confirmation_required"));
  await assert.rejects(unmountProject({ controllerRoot: root, projectId: "world", out, confirm: "world" }), refused("unmount_world_refused"));
  const result = await unmountProject({ controllerRoot: root, projectId: "home", out, confirm: "home" });
  assert.ok(result.removedFiles >= 4);
  assert.equal(result.tasksIndexed, 1);
  // The home agent's answered approvals left with it (R5); the open agent's stay.
  assert.equal(result.removedInteractionStores, 1);
  await assert.rejects(stat(interactionRecord(root, "a".repeat(64))), { code: "ENOENT" });
  assert.ok((await stat(interactionRecord(root, "b".repeat(64)))).isFile());

  // Nothing of the project is left on this PC; its package has it all.
  assert.deepEqual(await holding(root, CANARY), []);
  assert.ok((await holding(out, CANARY)).length >= 4);
  assert.deepEqual((await mountedProjects(root)).map((project) => project.projectId), ["open", "world"]);
  const recorded = (await readWorldRegistry(root)).projects.home;
  assert.deepEqual({ title: recorded.title, policy: recorded.policy, archived: recorded.archived },
    { title: "Home project", policy: { homeOnly: false, allowedMachines: null }, archived: false });
  // Where it is (its package) and what it holds, by counts and a time only.
  assert.equal(recorded.location.machineId, null);
  assert.deepEqual({ ...recorded.summary, lastActivityUtc: typeof recorded.summary.lastActivityUtc },
    { agents: 1, quarters: 1, tasksOpen: 1, lastActivityUtc: "string" });
  assert.ok(!JSON.stringify(await readWorldRegistry(root)).includes(CANARY));

  // The world sees the project by its title only.
  const memory = await service(root);
  const agents = (await memory.listAgents()).agents.map((agent) => agent.agentId).sort();
  assert.deepEqual(agents, ["lead", "open-agent"]);
  assert.ok(!(await memory.store.listScopes()).scopes.some((scope) => scope.projectId === "home"));
  const lead = await memory.readAgent({ agentId: "lead" });
  const catalog = (await memory.catalog()).value.agents;
  const overview = await memory.overviewFor(catalog.find((agent) => agent.agentId === "lead"), catalog);
  assert.deepEqual(overview.projects.map((project) => project.projectId), ["open"]);
  assert.deepEqual(overview.projectsNotHere, [{ projectId: "home", title: "Home project", availability: "not-here" }]);
  assert.ok(!JSON.stringify(overview).includes(CANARY));
  assert.equal(lead.agentId, "lead");
  await memory.close();
  const board = await readWorldTaskBoard({ controllerRoot: root });
  const task = board.tasks.find((item) => item.taskId === "task-home-1");
  assert.equal(task.availability, "not-here");
  assert.equal(task.title, null);
  assert.equal(task.projectTitle, "Home project");
  assert.equal(board.sources.find((source) => source.sourceId === "desk-home-agent").availability, "not-here");
  assert.ok(!JSON.stringify(board).includes(CANARY));

  // Back on this PC: everything where it was, the index gone.
  await mountProject({ controllerRoot: root, packageDir: out });
  assert.deepEqual((await mountedProjects(root)).map((project) => project.projectId), ["home", "open", "world"]);
  assert.ok((await holding(root, CANARY)).length >= 4);
  const again = await readWorldTaskBoard({ controllerRoot: root });
  const back = again.tasks.find((item) => item.taskId === "task-home-1");
  assert.equal(back.title, `${CANARY} task`);
  assert.equal(back.availability, undefined);
  await assert.rejects(stat(path.join(root, ".world", "tasks", "home.json")), { code: "ENOENT" });
  const after = await service(root);
  const catalogAfter = (await after.catalog()).value.agents;
  const overviewAfter = await after.overviewFor(catalogAfter.find((agent) => agent.agentId === "lead"), catalogAfter);
  assert.equal(overviewAfter.projectsNotHere, undefined);
  assert.deepEqual(overviewAfter.projects.map((project) => project.projectId), ["home", "open"]);
  await after.close();
});

test("unmount refuses a busy agent and keeps everything", { skip }, async (t) => {
  const root = await instance(t);
  const out = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), "af-package-"))), "home");
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  const memory = await service(root);
  const catalog = await memory.store.readDocument({ key: "memory-agents-v1" });
  const value = structuredClone(catalog.value);
  value.agents.find((agent) => agent.agentId === "home-agent").currentOperationId = "send-1";
  assert.equal(await memory.store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: catalog.revision, value }), true);
  await memory.close();
  const before = (await holding(root, CANARY)).sort();
  await assert.rejects(unmountProject({ controllerRoot: root, projectId: "home", out, confirm: "home" }), refused("project_not_quiescent"));
  assert.deepEqual((await holding(root, CANARY)).sort(), before);
  assert.deepEqual((await mountedProjects(root)).map((project) => project.projectId), ["home", "open", "world"]);
});

test("unmount refuses while an agent's question or approval is open, and keeps everything", { skip }, async (t) => {
  const root = await instance(t);
  const out = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), "af-package-"))), "home");
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  const record = interactionRecord(root, "a".repeat(64));
  await writeFile(record, JSON.stringify({ ...JSON.parse(await readFile(record, "utf8")), state: "awaiting-owner" }));
  const before = (await holding(root, CANARY)).sort();
  await assert.rejects(unmountProject({ controllerRoot: root, projectId: "home", out, confirm: "home" }),
    refused("unmount_interactions_open"));
  assert.deepEqual((await holding(root, CANARY)).sort(), before);
  assert.deepEqual((await mountedProjects(root)).map((project) => project.projectId), ["home", "open", "world"]);
  assert.equal((await readWorldRegistry(root)).projects.home?.location?.machineId ?? "here", "here");
});

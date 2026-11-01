import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { journalGatewayHandlers } from "../src/action-journal-gateway.mjs";
import {
  approveTask, cancelTask, createTask, parseTaskPlan, parseTaskResults, planningPrompt, readTask, readTasks, recordPlan,
  reviseTask, settleWork, tasksKeyOf, workPrompt,
} from "../src/agent-tasks.mjs";
import { createApplicationProjectMemoryHandlers } from "../src/application-project-memory.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { ProjectMemoryService, createProjectMemoryService } from "../src/project-memory-service.mjs";
import { selectProjectRecords } from "../src/project-package-export.mjs";
import { mountedProjects, writeStoreLayoutMarker } from "../src/project-store-layout.mjs";
import { loadNodeSqlite } from "../src/sqlite-backend.mjs";
import { openReadOnlyDatabase } from "../src/sqlite-node-connection.mjs";

// Task mode (roadmap track V, items 1-2): a task is planned first, read-only;
// the person approves the plan, asks for changes or cancels; only an approved
// plan is worked on. The records are the task board's too (track M).

const PLAN = [
  "## Understanding", "Add a button to the toolbar.",
  "## Questions", "- Which colour?", "- Left or right?",
  "## Plan", "1. Read toolbar.js", "2. Add the button", "   with a label", "3. Test it",
].join("\n");

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

const at = (minute) => new Date(Date.UTC(2026, 10, 1, 12, minute));
const task0 = { projectId: "alpha", quarterId: "q1", agentId: "nova" };

test("the plan's form is read from the agent's answer, in English or Russian headings", () => {
  const plan = parseTaskPlan(`Let me look first.\n${PLAN}\n`);
  assert.deepEqual(plan, { understanding: "Add a button to the toolbar.", questions: ["Which colour?", "Left or right?"],
    steps: ["Read toolbar.js", "Add the button with a label", "Test it"], formatted: true, raw: null });
  const inline = parseTaskPlan("**Understanding:** fix it\n**Questions**: None.\nPlan:\n- one\n- two");
  assert.deepEqual([inline.understanding, inline.questions, inline.steps], ["fix it", [], ["one", "two"]]);
  const ru = (...codes) => String.fromCodePoint(...codes);
  const russian = parseTaskPlan(`### ${ru(0x41f, 0x43b, 0x430, 0x43d)}\n1. ${ru(0x448, 0x430, 0x433)}`);
  assert.deepEqual(russian.steps, [ru(0x448, 0x430, 0x433)]);
  // A note after the list is no step; an indented line after a blank one still is.
  const noted = parseTaskPlan("## Plan\n1. Read it\n2. Check it\n\n   once more\n\nI could not write the plan file, so here it is.");
  assert.deepEqual(noted.steps, ["Read it", "Check it once more"]);
  const loose = parseTaskPlan("I would just do it.");
  assert.deepEqual([loose.formatted, loose.steps, loose.raw], [false, [], "I would just do it."]);
});

test("a task goes planning -> waiting for the person -> revised -> approved -> done", async () => {
  const store = documentStore();
  const created = await createTask(store, { ...task0, text: "Add a button", now: at(0) });
  assert.match(created.taskId, /^task-[0-9a-z]{4}$/u);
  assert.deepEqual([created.stage, created.waitingFor, created.origin], ["planning", "agent", "chat"]);
  await assert.rejects(createTask(store, { ...task0, text: "Another", now: at(0) }), { code: "task_agent_busy" });
  const { taskId } = created;
  assert.match(planningPrompt(created), /Task mode: plan first, change nothing/u);
  assert.match(planningPrompt(created), /## Understanding[\s\S]*## Questions[\s\S]*## Plan[\s\S]*Add a button$/u);

  const first = await recordPlan(store, { projectId: "alpha", taskId, planText: PLAN, operationId: "op-1", now: at(1) });
  assert.deepEqual([first.stage, first.waitingFor, first.revisions.length], ["awaiting-approval", "person", 1]);
  const again = await recordPlan(store, { projectId: "alpha", taskId, planText: PLAN, operationId: "op-1", now: at(1) });
  assert.equal(again.revisions.length, 1, "the same turn's plan is kept once");

  const revised = await reviseTask(store, { projectId: "alpha", taskId, remarks: "Put it on the right", answers: ["Blue", ""],
    now: at(2) });
  assert.equal(revised.stage, "planning");
  const prompt = planningPrompt(revised);
  assert.match(prompt, /asked to change the plan of task task-[0-9a-z]{4} \(revision 1\)/u);
  assert.match(prompt, /Put it on the right/u);
  assert.match(prompt, /1\. Which colour\?\n   Answer: Blue/u);
  assert.doesNotMatch(prompt, /Left or right\?\n   Answer/u, "an unanswered question is not sent as answered");

  await recordPlan(store, { projectId: "alpha", taskId, planText: PLAN.replace("3. Test it", "3. Test it\n4. Commit"),
    operationId: "op-2", now: at(3) });
  await assert.rejects(approveTask(store, { projectId: "alpha", taskId, revision: 1, now: at(4) }),
    { code: "task_revision_conflict" });
  const approved = await approveTask(store, { projectId: "alpha", taskId, revision: 2, answers: ["Blue", "Right"], now: at(4) });
  assert.deepEqual([approved.stage, approved.steps.length, approved.steps[0].status], ["in-progress", 4, "pending"]);
  assert.match(workPrompt(approved), /approved revision 2 of the plan[\s\S]*4\. Commit/u);
  assert.match(workPrompt(approved), /2\. Left or right\?\n   Answer: Right/u);

  const done = await settleWork(store, { projectId: "alpha", taskId, state: "completed", operationId: "op-3", now: at(5),
    todos: [{ status: "completed" }, { status: "completed" }, { status: "completed" }, { status: "in_progress" }] });
  assert.deepEqual([done.stage, done.waitingFor, done.steps.map((step) => step.status)],
    ["done", null, ["done", "done", "done", "in-progress"]]);
  const next = await createTask(store, { ...task0, text: "Next one", now: at(6) });
  assert.notEqual(next.taskId, taskId);
  const { previousStage } = await cancelTask(store, { projectId: "alpha", taskId: next.taskId, now: at(7) });
  assert.equal(previousStage, "planning");
  const listed = await readTasks(store, { projectId: "alpha", agentId: "nova" });
  assert.deepEqual(listed.tasks.map((task) => task.stage), ["cancelled", "done"], "newest first");
  assert.equal((await readTasks(store, { projectId: "alpha", stages: ["done"] })).tasks.length, 1);
  assert.equal((await readTask(store, { projectId: "alpha", taskId })).stage, "done");
  assert.ok(store.documents.has(tasksKeyOf("alpha")));
});

function serviceFixture() {
  const store = documentStore();
  const pair = { project: { scopeId: "alpha", revision: 1, sha256: "a".repeat(64), entries: [] },
    quarter: { scopeId: "q1", revision: 1, sha256: "b".repeat(64), entries: [] } };
  const owned = new Map();
  Object.assign(store, {
    async readPair() { return structuredClone(pair); },
    async readScope({ scopeId }) { return structuredClone(owned.get(scopeId) ?? pair.project); },
    async createScope(input) {
      owned.set(input.scopeId, { ...input, revision: 1, sha256: "c".repeat(64), entries: [] });
      return structuredClone(owned.get(input.scopeId));
    },
    async readScopes({ scopeIds }) { return scopeIds.filter((id) => owned.has(id)).map((id) => structuredClone(owned.get(id))); },
  });
  const sent = [];
  const traces = new Map();
  const provider = {
    terminal: false, failSend: false,
    async preflight() {},
    async create(agent) { return { projectId: "controller", sourceId: "source-a", providerId: "claude", threadId: `thread-${agent.agentId}` }; },
    async send({ text, operation }) {
      if (this.failSend) throw Object.assign(new Error("not sent"), { notDelivered: true });
      sent.push({ text, operation: structuredClone(operation) });
      return { turnId: `turn-${sent.length}`, state: "started" };
    },
    async observe({ operation }) { return { turnId: operation.turnId, state: this.terminal ? "completed" : "started" }; },
    async trace() { return { records: [...traces.values()].flat() }; },
    async capture() {},
  };
  const archive = { async append() {}, async read() { return { coverage: "captured-only", items: [] }; } };
  const service = new ProjectMemoryService({ store, archive, provider });
  return { service, store, provider, sent, traces };
}

test("the agent's next message is the task's turn: read-only planning, then the approved work", async () => {
  const { service, provider, sent, traces } = serviceFixture();
  await service.createAgent({ agentId: "nova", projectId: "alpha", quarterId: "q1", operationId: "create-nova",
    profile: { provider: "claude", model: "claude-a", reasoningEffort: "default", fallbackPolicy: "deny" } });
  const task = await service.startTask({ agentId: "nova", text: "Add a button" });
  assert.equal(task.stage, "planning");
  const operation = await service.send({ agentId: "nova", operationId: "send-1", text: "Add a button" });
  assert.equal(operation.task, undefined, "the task link is not part of the public operation");
  assert.deepEqual(sent[0].operation.task, { taskId: task.taskId, phase: "plan" });
  assert.match(sent[0].text, /User task:\nTask mode: plan first, change nothing/u);
  assert.equal((await service.readAgent({ agentId: "nova" })).taskTurn, undefined, "the mark is not shown");

  // The planning turn ends: its plan (Claude's ExitPlanMode) goes into the task, once.
  traces.set("turn-1", [{ turnId: "turn-1", type: "assistant", text: "Looking around." },
    { turnId: "turn-1", type: "tool_use", tool: "ExitPlanMode", input: JSON.stringify({ plan: PLAN }) }]);
  provider.terminal = true;
  await service.receipt({ agentId: "nova", operationId: "send-1" });
  await service.receipt({ agentId: "nova", operationId: "send-1" });
  let current = await service.readTask({ projectId: "alpha", taskId: task.taskId });
  assert.deepEqual([current.stage, current.revisions.length, current.revisions[0].steps.length], ["awaiting-approval", 1, 3]);

  // An ordinary message in between is not the task's.
  provider.terminal = false;
  await service.send({ agentId: "nova", operationId: "send-2", text: "Just a question" });
  assert.equal(sent[1].operation.task, undefined);
  assert.match(sent[1].text, /User task:\nJust a question$/u);
  provider.terminal = true;
  await service.receipt({ agentId: "nova", operationId: "send-2" });

  await service.approveTask({ agentId: "nova", taskId: task.taskId, revision: 1, answers: ["Blue"] });
  provider.terminal = false;
  await service.send({ agentId: "nova", operationId: "send-3", text: "Plan approved" });
  assert.deepEqual(sent[2].operation.task, { taskId: task.taskId, phase: "work" });
  assert.match(sent[2].text, /approved revision 1 of the plan[\s\S]*Answer: Blue/u);
  traces.set("turn-3", [{ turnId: "turn-3", type: "tool_use", tool: "TodoWrite",
    input: JSON.stringify({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "completed" },
      { content: "c", status: "completed" }] }) }]);
  provider.terminal = true;
  await service.receipt({ agentId: "nova", operationId: "send-3" });
  current = await service.readTask({ projectId: "alpha", taskId: task.taskId });
  assert.deepEqual([current.stage, current.steps.map((step) => step.status)], ["done", ["done", "done", "done"]]);
});

test("the results the agent lists are read from its answer, plain paths and what each is", () => {
  const answer = ["Done: the button is there.", "", "## Results",
    "- `src/toolbar.js` - the button", "- **docs/button.md** \u2014 how to use it", "- [notes.txt](notes/notes.txt): notes",
    "- out.log", "", "That is all.", "## Plan", "1. Not a result"].join("\n");
  assert.deepEqual(parseTaskResults(answer), { listed: true, items: [
    { path: "src/toolbar.js", note: "the button" }, { path: "docs/button.md", note: "how to use it" },
    { path: "notes/notes.txt", note: "notes" }, { path: "out.log", note: "" }] });
  // A Russian heading; "None" lists nothing; no heading, nothing listed.
  assert.deepEqual(parseTaskResults("## \u0420\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u044b\n- a.txt - x").items,
    [{ path: "a.txt", note: "x" }]);
  assert.deepEqual(parseTaskResults("## Results\nNone"), { listed: true, items: [] });
  assert.deepEqual(parseTaskResults("All done."), { listed: false, items: [] });
  assert.match(workPrompt({ taskId: "task-0001", text: "t", approved: { revision: 1, answers: [] },
    revisions: [{ revision: 1, steps: ["a - b"], questions: [] }] }), /"## Results"[\s\S]*become your artifacts/u);
});

test("a completed work's listed results become the agent's artifacts, or stay with why; without the registry it waits", async () => {
  const { service, provider, traces } = serviceFixture();
  await service.createAgent({ agentId: "nova", projectId: "alpha", quarterId: "q1", operationId: "create-nova",
    profile: { provider: "claude", model: "claude-a", reasoningEffort: "default", fallbackPolicy: "deny" } });
  const task = await service.startTask({ agentId: "nova", text: "Write a report" });
  await service.send({ agentId: "nova", operationId: "send-1", text: "Write a report" });
  traces.set("turn-1", [{ turnId: "turn-1", type: "assistant", text: PLAN }]);
  provider.terminal = true;
  await service.receipt({ agentId: "nova", operationId: "send-1" });
  await service.approveTask({ agentId: "nova", taskId: task.taskId, revision: 1, answers: [] });
  provider.terminal = false;
  await service.send({ agentId: "nova", operationId: "send-2", text: "Plan approved" });
  traces.set("turn-2", [{ turnId: "turn-2", type: "assistant", text: ["Done.", "## Results", "- docs/report.md - the report",
    "- missing.txt - gone", "- C:/elsewhere/x.txt - outside"].join("\n") }]);
  provider.terminal = true;
  // No registry (a host that cannot register): the task stays at work until a receipt that can.
  await service.receipt({ agentId: "nova", operationId: "send-2" });
  assert.equal((await service.readTask({ projectId: "alpha", taskId: task.taskId })).stage, "in-progress");
  const registered = [];
  service.artifactRegistry = {
    async read(projectId, filePath) {
      if (projectId !== "alpha" || filePath !== "docs/report.md") throw Object.assign(new Error("gone"), { code: "source_unavailable" });
      return { contentSha256: "d".repeat(64) };
    },
    async register(input) { registered.push(input); return { artifactId: input.artifactId }; },
  };
  await service.receipt({ agentId: "nova", operationId: "send-2" });
  await service.receipt({ agentId: "nova", operationId: "send-2" });
  const done = await service.readTask({ projectId: "alpha", taskId: task.taskId });
  assert.equal(done.stage, "done");
  assert.deepEqual(registered, [{ agentId: "nova", artifactId: `${task.taskId}.1`, path: "docs/report.md", sha256: "d".repeat(64) }],
    "registered once, with the hash it has now");
  assert.deepEqual(done.results, [
    { path: "docs/report.md", note: "the report", artifactId: `${task.taskId}.1`, problem: null },
    { path: "missing.txt", note: "gone", artifactId: null, problem: "source_unavailable" },
    { path: "C:/elsewhere/x.txt", note: "outside", artifactId: null, problem: "outside_project" }]);
});

test("a task's turn that did not go waits for the next message; a cancelled task leaves an ordinary one", async () => {
  const { service, provider, sent } = serviceFixture();
  await service.createAgent({ agentId: "nova", projectId: "alpha", quarterId: "q1", operationId: "create-nova",
    profile: { provider: "claude", model: "claude-a", reasoningEffort: "default", fallbackPolicy: "deny" } });
  const task = await service.startTask({ agentId: "nova", text: "Add a button" });
  provider.failSend = true;
  await service.send({ agentId: "nova", operationId: "send-1", text: "Add a button" });
  provider.failSend = false;
  await service.send({ agentId: "nova", operationId: "send-2", text: "Add a button" });
  assert.deepEqual(sent[0].operation.task, { taskId: task.taskId, phase: "plan" });
  provider.terminal = true;
  await service.receipt({ agentId: "nova", operationId: "send-2" });
  const busy = await service.reviseTask({ agentId: "nova", taskId: task.taskId, remarks: "More detail" });
  assert.equal(busy.stage, "planning");
  await service.cancelTask({ agentId: "nova", taskId: task.taskId });
  provider.terminal = false;
  await service.send({ agentId: "nova", operationId: "send-3", text: "Hello" });
  assert.equal(sent[1].operation.task, undefined);
  await assert.rejects(service.startTask({ agentId: "nova", text: "x" }), { code: "memory_agent_busy" });
});

// --- through the memory CLI, as the trusted host runs it -------------------------

const SOURCE = "controller";

async function controller(t, { split = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-tasks-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: SOURCE }));
  await writeFile(path.join(root, "project-version.json"), JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  if (split) {
    await writeFile(path.join(root, "instance.json"), JSON.stringify({ schemaVersion: 1, instanceId: "tasks" }));
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
  await call("mutation.memory.agent.create", { agentId: "nova", projectId: "alpha", quarterId: "q1", operationId: "create-nova",
    profile: { provider: "claude", model: "claude-a", reasoningEffort: "default", fallbackPolicy: "deny" } });
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

test("the trusted host starts, reads and cancels a task; each step goes into the History", async (t) => {
  const root = await controller(t);
  await world(root);
  await assert.rejects(cli(root, "start-task", { agentId: "nova", text: "Add a button" }), /confirm-agent/u);
  const task = await cli(root, "start-task", { agentId: "nova", text: "Add a button" }, { "confirm-agent": "nova" });
  assert.equal(task.stage, "planning");
  const listed = await cli(root, "read-tasks", { projectId: "alpha", waitingFor: "agent" });
  assert.deepEqual(listed.tasks.map((item) => item.taskId), [task.taskId]);
  // Without a project: every project's tasks (the window's attention reads what waits for the person anywhere).
  const everywhere = await cli(root, "read-tasks", { waitingFor: "agent" });
  assert.deepEqual([everywhere.projectId, everywhere.tasks.map((item) => item.taskId)], [null, [task.taskId]]);
  assert.deepEqual((await cli(root, "read-tasks", { waitingFor: "person" })).tasks, []);
  assert.equal((await cli(root, "read-task", { projectId: "alpha", taskId: task.taskId })).text, "Add a button");
  await cli(root, "cancel-task", { agentId: "nova", taskId: task.taskId }, { "confirm-agent": "nova" });
  const { entries } = await cli(root, "read-journal", { projectId: "alpha", limit: 2 });
  assert.deepEqual(entries.map((entry) => [entry.action, entry.noUndo, entry.agentId]),
    [["task.cancel", "task_not_undone", "nova"], ["task.start", "task_not_undone", "nova"]]);
  assert.equal(entries[1].summary, `Gave task ${task.taskId} to nova: a plan first`);
});

test("a project's tasks live in its own database and go into its package", async (t) => {
  const root = await controller(t, { split: true });
  await world(root);
  await cli(root, "start-task", { agentId: "nova", text: "Add a button" }, { "confirm-agent": "nova" });
  for (const projectId of ["alpha", "beta"]) {
    const mounted = (await mountedProjects(root)).find((item) => item.projectId === projectId);
    const db = openReadOnlyDatabase(await loadNodeSqlite(), path.join(mounted.folder, "memory.sqlite"));
    try {
      const keys = db.prepare("SELECT key FROM memory_documents").all().map((row) => row.key);
      assert.equal(keys.includes(tasksKeyOf("alpha")), projectId === "alpha", projectId);
    } finally {
      db.close();
    }
  }
  const row = (projectId) => ({ key: tasksKeyOf(projectId), revision: 1,
    value_json: JSON.stringify({ schemaVersion: 1, projectId, tasks: [] }) });
  const memory = { scopes: [
    { scope_id: "alpha-memory", kind: "project", project_id: "alpha", quarter_id: null, title: "Alpha", current_revision: 1 },
    { scope_id: "beta-memory", kind: "project", project_id: "beta", quarter_id: null, title: "Beta", current_revision: 1 }],
  revisions: [], operations: [], grants: [], documents: [row("alpha"), row("beta")] };
  const records = selectProjectRecords({ memory, archive: null, projectId: "beta" });
  assert.deepEqual(records.documents.map((document) => document.key), [tasksKeyOf("beta")]);
});

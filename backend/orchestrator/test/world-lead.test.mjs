import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplicationGatewayFailureLogRecord } from "../src/application-gateway-runtime.mjs";
import { archiveProject } from "../src/project-archive.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { bindProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { TASK_STAGES, readWorldTaskBoard, taskStageOf } from "../src/world-task-board.mjs";

// The world lead (Atlas): one coordinator above every project, in the reserved
// world project bound to the controller root, and the read path of its task
// board - which desk agents take tasks and where each task stands.

const profile = { provider: "claude", model: "claude-test", reasoningEffort: "default", fallbackPolicy: "deny" };

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A controller with the world project bound to its root and one ordinary project with a lead. */
async function controller(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "world-lead-"));
  const work = path.join(root, "RobotArm");
  const controllerRoot = path.join(root, "controller");
  await mkdir(work, { recursive: true });
  await json(path.join(controllerRoot, ".orchestrator", "contract.json"), { schemaVersion: 1, sourceId: "controller" });
  const service = await createProjectMemoryService({ controllerRoot, sourceId: "controller" });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const [scopeId, kind, projectId, quarterId, title] of [
    ["world-memory", "project", "world", null, "World"], ["world-hq-memory", "quarter", "world", "hq", "World HQ"],
    ["robotarm-memory", "project", "robotarm", null, "RobotArm"], ["robotarm-hq", "quarter", "robotarm", "hq", "HQ"],
    ["robotarm-tools", "quarter", "robotarm", "tools", "Tools"],
    ["old-memory", "project", "old", null, "Old"],
  ]) {
    await service.store.createScope({ scopeId, kind, projectId, quarterId, title, operationId: `create-${scopeId}` });
  }
  await bindProjectWorkspace(service.store, { projectId: "world", workspacePath: controllerRoot });
  await bindProjectWorkspace(service.store, { projectId: "robotarm", workspacePath: work });
  const sent = [];
  service.provider = {
    preflight: async () => {},
    resolveWorkspace: async (agent) => ({ workspaceKey: agent.projectId }),
    create: async (agent) => ({ projectId: "controller", sourceId: "controller", providerId: "claude",
      threadId: `thread-${agent.agentId}` }),
    async send({ agent, operation, text }) {
      sent.push({ agentId: agent.agentId, operationId: operation.operationId, text });
      return { turnId: `turn-${sent.length}`, state: "started" };
    },
    async observe({ operation }) { return { turnId: operation.turnId, state: "completed" }; },
    async capture() {},
  };
  for (const [agentId, projectId, quarterId] of [["world-lead", "world", "hq"], ["robotarm-lead", "robotarm", "hq"],
    ["solver", "robotarm", "tools"], ["ui", "robotarm", "tools"]]) {
    await service.createAgent({ agentId, projectId, quarterId, operationId: `create-${agentId}`, profile });
  }
  return { root, work, controllerRoot, service, sent };
}

test("the world lead is the coordinator in the world project: it sees every other open project", async (t) => {
  const f = await controller(t);
  await f.service.setAgentSettings({ agentId: "robotarm-lead", expectedRevision: 0, role: "project-lead", writeZone: null });
  const lead = await f.service.setAgentSettings({ agentId: "world-lead", expectedRevision: 0, role: "coordinator",
    writeZone: null });
  assert.equal(lead.settings.role, "coordinator");
  // One world lead per controller, wherever the second one would sit.
  await assert.rejects(f.service.setAgentSettings({ agentId: "solver", expectedRevision: 0, role: "coordinator",
    writeZone: null }), { code: "memory_role_taken" });
  // An archived project is not overseen.
  await archiveProject({ store: f.service.store, projectId: "old" });

  await f.service.send({ agentId: "world-lead", operationId: "world-1", text: "What is going on?" });
  const content = f.sent.at(-1).text;
  const snapshot = JSON.parse(content.split("\n")[2]);
  assert.deepEqual(snapshot.overview, { projects: [{ projectId: "robotarm", name: "robotarm", title: "RobotArm",
    lead: "robotarm-lead", leadName: "robotarm-lead", agents: 3 }] });
  assert.match(content, /Your role: the world lead - the coordinator of this controller, above the project and quarter leads\./u);
  assert.match(content, /A task for a project as a whole goes to its lead\./u);
  assert.match(content, /you change files only under coordination\/drafts\/\./u);
  // Its write zone is the task drafts of the controller root it works in.
  const catalog = (await f.service.catalog()).value.agents;
  const { effectiveWriteZone } = await import("../src/project-memory-service.mjs");
  assert.deepEqual(effectiveWriteZone(catalog.find((agent) => agent.agentId === "world-lead"), catalog),
    ["coordination/drafts/**"]);
});

/** A desk agent's coordination folder as register-desk-source leaves it. */
async function deskSource(controllerRoot, agentId, projectFolder) {
  const sourceId = `desk-${agentId}`;
  const folder = path.join(controllerRoot, ".project-local", "desk-agents", sourceId);
  await json(path.join(folder, ".orchestrator", "contract.json"), { schemaVersion: 1, sourceId, kitProfile: "claude-desk",
    executorState: "installed" });
  await json(path.join(folder, ".orchestrator", "desk-agent.json"), { schemaVersion: 1, sourceId, agentId,
    projectId: "robotarm", quarterId: "tools", registeredAtUtc: "2026-10-20T08:00:00.000Z" });
  return { sourceId, folder, entry: { id: sourceId, ownerRole: `desk agent ${agentId}`, workspaceRelativeSourceRoot: ".",
    taskInbox: ".orchestrator/tasks/inbox", reportOutbox: ".orchestrator/reports/outbox",
    progressOutbox: ".orchestrator/progress/outbox", executionAdapter: "claude-desk-agent",
    providerRoute: "claude-desk-agent", coordinationProfile: "claude-desk", executorState: "installed",
    requiredDocuments: [], reportInbox: `knowledge/reports/inbox/${sourceId}`, deskAgentId: agentId },
  binding: { workspacePath: folder, sourcePath: projectFolder } };
}

/** One task packet, delivered to the agent's inbox and archived by the controller. */
async function dispatch(controllerRoot, source, taskId, dispatchedAtUtc, title) {
  const packet = { schemaVersion: 1, contractVersion: "v0.3.0", taskId, coordinatorId: "agents-factory-control",
    targetId: source.sourceId, title, priority: "normal", dispatchedAtUtc };
  const text = `${JSON.stringify(packet, null, 2)}\n`;
  for (const directory of [path.join(controllerRoot, "coordination", "tasks", "dispatched", taskId),
    path.join(source.folder, ".orchestrator", "tasks", "inbox", taskId)]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "task.json"), text);
  }
}

test("the task board names the desk agents and where each task stands, without a path", async (t) => {
  const f = await controller(t);
  const root = f.controllerRoot;
  const solver = await deskSource(root, "solver", f.work);
  const ui = await deskSource(root, "ui", f.work);
  await json(path.join(root, "config", "source-registry.json"), { schemaVersion: 2,
    sources: [{ id: "sampleapp", ownerRole: "codex child" }, solver.entry, ui.entry] });
  await json(path.join(root, ".project-local", "source-bindings.json"), { schemaVersion: 2,
    sources: { [solver.sourceId]: solver.binding, [ui.sourceId]: ui.binding } });
  const out = (source, ...parts) => path.join(source.folder, ".orchestrator", ...parts);
  const returns = path.join(root, ".project-local", "orchestration", "desk-task-returns");

  // dispatched only
  await dispatch(root, solver, "solver-a-001", "2026-10-20T09:00:00.000Z", "Only dispatched");
  // started, not accepted yet; the coordinator wrote its definition
  await dispatch(root, solver, "solver-b-002", "2026-10-20T09:01:00.000Z", "Started");
  await json(path.join(returns, "solver-b-002.json"), { schemaVersion: 1, taskId: "solver-b-002", sourceId: solver.sourceId,
    agentId: "solver", coordinatorAgentId: "world-lead", reportOperation: "accept",
    continuationPolicy: "stop-after-report", startedAtUtc: "2026-10-20T09:02:00.000Z", returnState: "waiting" });
  await json(path.join(root, ".project-local", "desk-coordinator", "definitions", "solver-b-002.json"), { taskId: "solver-b-002" });
  // accepted by the agent
  await dispatch(root, solver, "solver-c-003", "2026-10-20T09:03:00.000Z", "Accepted");
  await json(out(solver, "tasks", "acknowledged", "solver-c-003.json"), { schemaVersion: 1, taskId: "solver-c-003",
    decision: "accepted", reason: null, agentId: "solver", acknowledgedAtUtc: "2026-10-20T09:04:00.000Z" });
  // a plan waiting for the person
  await dispatch(root, solver, "solver-d-004", "2026-10-20T09:05:00.000Z", "Planned");
  await json(out(solver, "tasks", "acknowledged", "solver-d-004.json"), { taskId: "solver-d-004", decision: "accepted" });
  await json(out(solver, "progress", "outbox", "solver-d-004", "progress.json"), { taskId: "solver-d-004", state: "accepted",
    summary: { now: "Plan published" }, updatedAtUtc: "2026-10-20T09:06:00.000Z",
    workflow: { lifecycleStage: "awaiting_confirmation", plan: { revision: 1, status: "awaiting_confirmation" } } });
  // in progress
  await dispatch(root, ui, "ui-e-005", "2026-10-20T09:07:00.000Z", "In progress");
  await json(out(ui, "tasks", "acknowledged", "ui-e-005.json"), { taskId: "ui-e-005", decision: "accepted" });
  await json(out(ui, "progress", "outbox", "ui-e-005", "progress.json"), { taskId: "ui-e-005", state: "running",
    summary: { now: `Editing ${path.join(f.work, "tools", "ui", "x.py")}` },
    workflow: { lifecycleStage: "implementation", plan: { revision: 1, status: "confirmed" } } });
  // reported, then accepted by code
  await dispatch(root, ui, "ui-f-006", "2026-10-20T09:08:00.000Z", "Reported");
  await json(out(ui, "reports", "outbox", "ui-f-006", "report.json"), { taskId: "ui-f-006", status: "completed",
    summary: "Done", reportedAtUtc: "2026-10-20T09:30:00.000Z" });
  await dispatch(root, ui, "ui-g-007", "2026-10-20T09:09:00.000Z", "Accepted by code");
  await json(out(ui, "reports", "outbox", "ui-g-007", "report.json"), { taskId: "ui-g-007", status: "completed", summary: "Done" });
  await json(path.join(root, "coordination", "acceptances", ui.sourceId, "ui-g-007", "acceptance.json"), {
    taskId: "ui-g-007", result: "passed", evaluatedAtUtc: "2026-10-20T09:40:00.000Z" });
  // declined
  await dispatch(root, ui, "ui-h-008", "2026-10-20T09:10:00.000Z", "Declined");
  await json(out(ui, "tasks", "acknowledged", "ui-h-008.json"), { taskId: "ui-h-008", decision: "blocked",
    reason: "Outside my write zone" });
  // a packet the controller no longer has the same way
  await dispatch(root, ui, "ui-i-009", "2026-10-20T09:11:00.000Z", "Changed");
  await writeFile(path.join(root, "coordination", "tasks", "dispatched", "ui-i-009", "task.json"), "{}\n");

  const board = await runProjectMemoryCommand({ "repo-root": root, action: "read-task-board" });
  assert.deepEqual(board.sources, [{ agentId: "solver", sourceId: "desk-solver", valid: true },
    { agentId: "ui", sourceId: "desk-ui", valid: true }]);
  const stages = Object.fromEntries(board.tasks.map((task) => [task.taskId, task.stage]));
  assert.deepEqual(stages, { "ui-i-009": "dispatched", "ui-h-008": "declined", "ui-g-007": "accepted-by-code",
    "ui-f-006": "reported", "ui-e-005": "in-progress", "solver-d-004": "planned", "solver-c-003": "accepted",
    "solver-b-002": "started", "solver-a-001": "dispatched" });
  assert.deepEqual(board.tasks.map((task) => task.taskId).slice(0, 2), ["ui-i-009", "ui-h-008"], "newest first");
  const byId = (taskId) => board.tasks.find((task) => task.taskId === taskId);
  assert.equal(byId("ui-i-009").verified, false);
  assert.equal(byId("ui-h-008").verified, true);
  assert.deepEqual(byId("solver-b-002").start, { startedAtUtc: "2026-10-20T09:02:00.000Z", coordinatorAgentId: "world-lead",
    reportOperation: "accept", continuationPolicy: "stop-after-report", returnState: "waiting", declined: false });
  assert.equal(byId("solver-b-002").dispatchedByCoordinator, true);
  assert.equal(byId("solver-d-004").progress.planStatus, "awaiting_confirmation");
  assert.equal(byId("ui-h-008").acknowledgement.reason, "Outside my write zone");
  assert.deepEqual(byId("ui-g-007").acceptance, { result: "passed", evaluatedAtUtc: "2026-10-20T09:40:00.000Z" });
  assert.equal(board.truncated, false);
  // No folder of the controller leaves the board (an agent's own words may name a file; that is its text).
  const withoutAgentText = JSON.stringify({ ...board, tasks: board.tasks.map((task) => ({ ...task, progress: null })) });
  assert.equal(withoutAgentText.includes(root), false);
  assert.equal(withoutAgentText.includes(root.replaceAll("\\", "\\\\")), false);

  // One agent's tasks; the sources stay whole, so its registered state is known.
  const one = await runProjectMemoryCommand({ "repo-root": root, action: "read-task-board", "input-file": await (async () => {
    const file = path.join(root, ".project-local", "atlas-input", "board.json");
    await json(file, { agentId: "solver" });
    return path.relative(root, file);
  })() });
  assert.deepEqual(one.tasks.map((task) => task.agentId).filter((agentId) => agentId !== "solver"), []);
  assert.equal(one.tasks.length, 4);
  assert.equal(one.sources.length, 2);
  const badInput = path.join(root, ".project-local", "atlas-input", "bad.json");
  await json(badInput, { agentId: "solver", path: "C:/" });
  await assert.rejects(runProjectMemoryCommand({ "repo-root": root, action: "read-task-board",
    "input-file": path.relative(root, badInput) }), /invalid_argument:input-file/u);

  // A source whose coordination folder no longer validates is listed as such, and its tasks are still read.
  await rm(path.join(ui.folder, ".orchestrator", "desk-agent.json"));
  const broken = await readWorldTaskBoard({ controllerRoot: root });
  assert.deepEqual(broken.sources.find((source) => source.agentId === "ui"), { agentId: "ui", sourceId: "desk-ui", valid: false });
  // An empty controller has an empty board.
  const empty = await mkdtemp(path.join(os.tmpdir(), "world-board-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.deepEqual(await readWorldTaskBoard({ controllerRoot: empty }), { schemaVersion: 1, sources: [], tasks: [], truncated: false });
});

test("a task's stage follows the contract's order and ends early when the agent does not take it", () => {
  const base = { start: null, acknowledgement: null, progress: null, report: null, acceptance: null };
  const progress = (lifecycleStage, extra = {}) => ({ state: "accepted", lifecycleStage, planStatus: null, ...extra });
  assert.equal(taskStageOf(base), "dispatched");
  assert.equal(taskStageOf({ ...base, start: { declined: false } }), "started");
  assert.equal(taskStageOf({ ...base, acknowledgement: { decision: "accepted" } }), "accepted");
  assert.equal(taskStageOf({ ...base, progress: progress("understanding") }), "accepted");
  assert.equal(taskStageOf({ ...base, progress: progress("planning") }), "planned");
  assert.equal(taskStageOf({ ...base, progress: progress("awaiting_confirmation", { planStatus: "confirmed" }) }), "planned");
  assert.equal(taskStageOf({ ...base, progress: progress("validation") }), "in-progress");
  assert.equal(taskStageOf({ ...base, progress: { state: "running", lifecycleStage: null, planStatus: null } }), "in-progress");
  assert.equal(taskStageOf({ ...base, report: { status: "completed" } }), "reported");
  assert.equal(taskStageOf({ ...base, report: { status: "completed" }, acceptance: { result: "passed" } }), "accepted-by-code");
  assert.equal(taskStageOf({ ...base, acknowledgement: { decision: "rejected" } }), "declined");
  assert.equal(taskStageOf({ ...base, start: { declined: true } }), "declined");
  assert.deepEqual(TASK_STAGES, ["dispatched", "started", "accepted", "planned", "in-progress", "reported",
    "accepted-by-code", "declined"]);
});

test("a desk registration's refusal keeps its code for Atlas, and nothing private", async (t) => {
  for (const code of ["desk_source_conflict", "desk_source_binding_conflict", "desk_source_folder_conflict",
    "desk_source_record_conflict", "desk_source_registration_busy", "desk_source_kit_install_failed",
    "desk_source_contract_mismatch", "controller_registry_incompatible", "duplicate_source_id"]) {
    const error = Object.assign(new Error(code), { code, memoryPhase: "operation", output: "C:\\private\\path" });
    assert.deepEqual(createApplicationGatewayFailureLogRecord(error), { status: "failed", code, phase: "memory-operation" });
  }
  // Only the memory CLI's own phases keep such a code; anything else stays generic.
  assert.deepEqual(createApplicationGatewayFailureLogRecord(Object.assign(new Error("desk_source_conflict"),
    { code: "desk_source_conflict" })), { status: "failed", code: "application_gateway_failed" });
  assert.deepEqual(createApplicationGatewayFailureLogRecord(Object.assign(new Error("x"),
    { code: "desk_source_Private Text", memoryPhase: "operation" })),
  { status: "failed", code: "application_gateway_failed", phase: "memory-operation" });

  // Through the CLI: a registry entry that differs is a conflict, never overwritten.
  const f = await controller(t);
  const root = f.controllerRoot;
  await json(path.join(root, "config", "source-registry.json"), { schemaVersion: 2,
    sources: [{ id: "desk-solver", deskAgentId: "solver", executionAdapter: "something-else" }] });
  await json(path.join(root, ".project-local", "source-bindings.json"), { schemaVersion: 2, sources: {} });
  const input = path.join(root, ".project-local", "atlas-input", "register.json");
  await json(input, { agentId: "solver" });
  const options = { "repo-root": root, action: "register-desk-source", "input-file": path.relative(root, input) };
  await assert.rejects(runProjectMemoryCommand(options), /confirm-agent/u);
  await assert.rejects(runProjectMemoryCommand({ ...options, "confirm-agent": "solver" }), (error) => {
    assert.equal(error.code, "desk_source_conflict");
    assert.deepEqual(createApplicationGatewayFailureLogRecord(error), { status: "failed", code: "desk_source_conflict",
      phase: "memory-operation", diagnosticId: error.diagnosticId, diagnosticPersisted: error.diagnosticPersisted });
    return true;
  });
  // An archived agent is refused before anything is written.
  const archive = path.join(root, ".project-local", "atlas-input", "register-ui.json");
  await json(archive, { agentId: "ui" });
  await f.service.closeAgent({ agentId: "ui", operationId: "close-ui" });
  await assert.rejects(runProjectMemoryCommand({ "repo-root": root, action: "register-desk-source",
    "input-file": path.relative(root, archive), "confirm-agent": "ui" }), { code: "memory_agent_closed" });
});

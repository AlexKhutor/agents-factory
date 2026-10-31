import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installSpawnGuard } from "./fixtures/desk-task/spawn-guard.mjs";
import { createController, exists, writeJson } from "./fixtures/desk-task/harness.mjs";
import { readDeskAgentSource, registerDeskAgentSource } from "../src/desk-agent-sources.mjs";
import { createDeskTaskTools } from "../src/desk-agent-task-tools.mjs";
import { createDeskCoordinatorTools } from "../src/desk-coordinator-tools.mjs";
import { installDeskAgentKit, runDeskControllerTool } from "../src/desk-task-controller.mjs";
import { createDeskTaskReturns } from "../src/desk-task-returns.mjs";
import { readDeskTaskReturn } from "../src/desk-tasks.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { bindProjectWorkspace } from "../src/project-workspace-binding.mjs";

// The whole desk task chain of the Claude desk route in Node, with no
// PowerShell anywhere: register a desk agent (kit installed into its own
// folder), the coordinator dispatches and starts a task, the agent accepts,
// publishes its plan, the person confirms it, the agent reports progress and
// submits its report, and control-cli imports the report and accepts it
// deterministically; the coordinator gets the return. Every start of
// powershell or pwsh in this process and in control-cli's process is refused
// and recorded by a spawn guard; the controller has no PowerShell tools.

const orchestratorRoot = fileURLToPath(new URL("../", import.meta.url));
const guardUrl = pathToFileURL(fileURLToPath(new URL("./fixtures/desk-task/spawn-guard.mjs", import.meta.url))).href;
const profile = { provider: "claude", model: "claude-test", reasoningEffort: "default", fallbackPolicy: "deny" };
const attempts = installSpawnGuard({ log: null });

/** control-cli report in its own Node process, under the same guard (desk-task-returns' runControlReportOperation). */
function controlCliReport(guardLog) {
  return ({ controllerRoot, sourceId, taskId, operation }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", guardUrl, path.join(orchestratorRoot, "src", "control-cli.mjs"),
      "report", "--config", path.join(controllerRoot, ".project-local", "orchestration", "control-cycle.json"),
      "--operation", operation, "--source-id", sourceId, "--task-id", taskId],
    { cwd: controllerRoot, windowsHide: true, env: { ...process.env, DESK_TASK_SPAWN_GUARD_LOG: guardLog } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`control-cli report exited ${code}: ${stderr.slice(-3000)}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

test("a desk task goes from registration to deterministic acceptance without PowerShell", async (t) => {
  assert.throws(() => spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"]), { code: "POWERSHELL_SPAWNED" },
    "the guard refuses PowerShell");
  attempts.length = 0;

  const root = await mkdtemp(path.join(os.tmpdir(), "desk-chain-node-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const controller = path.join(root, "controller");
  const work = path.join(root, "RobotArm");
  const guardLog = path.join(root, "powershell-attempts.log");
  // No PowerShell tools in the controller: only data (the child kit, the knowledge folder, configuration).
  await createController(controller, { powershellTools: false });
  await mkdir(work, { recursive: true });
  await writeJson(path.join(controller, ".project-local", "orchestration", "control-cycle.json"), {
    schemaVersion: 1, controllerRoot: controller, publicationIntervalMs: 15000,
    provider: { type: "fake" }, allowFakeProvider: true,
    // The Codex-era collector command: a desk agent's report never runs it.
    collector: { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      "tools/collect_child_reports_v2.ps1"], toolReport: "logs/collect_child_reports_v2.report.json",
    taskRoot: "coordination/tasks/dispatched", timeoutMs: 120000 },
  });

  const service = await createProjectMemoryService({ controllerRoot: controller, sourceId: "controller" });
  const sent = [];
  service.provider = {
    preflight: async () => {},
    resolveWorkspace: async (agent) => ({ workspaceKey: agent.projectId === "hq" ? "hq" : "robotarm" }),
    create: async (agent) => ({ projectId: "controller", sourceId: "controller", providerId: "claude",
      threadId: `thread-${agent.agentId}` }),
    async send({ agent, operation, text }) {
      sent.push({ agentId: agent.agentId, operationId: operation.operationId, text });
      return { turnId: `turn-${sent.length}`, state: "started" };
    },
    async observe({ operation }) { return { turnId: operation.turnId, state: "completed" }; },
  };
  for (const [scopeId, kind, projectId, quarterId] of [["p", "project", "robotarm", null], ["q", "quarter", "robotarm", "tools"],
    ["hq-p", "project", "hq", null], ["hq-q", "quarter", "hq", "main"]]) {
    await service.store.createScope({ scopeId, kind, projectId, quarterId, title: scopeId, operationId: `create-${scopeId}` });
  }
  await bindProjectWorkspace(service.store, { projectId: "robotarm", workspacePath: work });
  await bindProjectWorkspace(service.store, { projectId: "hq", workspacePath: controller });
  await service.createAgent({ agentId: "solver", projectId: "robotarm", quarterId: "tools", operationId: "create-solver", profile });
  await service.createAgent({ agentId: "boss", projectId: "hq", quarterId: "main", operationId: "create-boss", profile });
  await service.setAgentSettings({ agentId: "boss", expectedRevision: 0, role: "coordinator", writeZone: null });

  // 1. Registration: the kit goes into the agent's own coordination folder.
  const registered = await registerDeskAgentSource({ controllerRoot: controller, service, agentId: "solver",
    installKit: installDeskAgentKit });
  assert.equal(registered.status, "registered");
  assert.equal((await readDeskAgentSource({ controllerRoot: controller, agentId: "solver" })).sourceId, "desk-solver");
  const folder = path.join(controller, registered.coordinationFolder);
  const contract = JSON.parse(await readFile(path.join(folder, ".orchestrator", "contract.json"), "utf8"));
  assert.equal(contract.kitProfile, "claude-desk");

  // 2. The coordinator dispatches and starts the task.
  const operations = [];
  const runReport = controlCliReport(guardLog);
  const returns = createDeskTaskReturns({ controllerRoot: controller, service,
    runReportOperation: async (input) => { operations.push(input); return runReport(input); } });
  const coordinator = Object.fromEntries(createDeskCoordinatorTools({ controllerRoot: controller, service,
    run: runDeskControllerTool })(await service.readAgent({ agentId: "boss" })).map((tool) => [tool.name, tool.handler]));
  const definition = {
    taskId: "solver-fix-001", targetId: "desk-solver", title: "Fix the joint solver drift",
    intent: "The joint follows the wheels without drifting on long tracks.",
    desiredOutcomes: ["No visible drift on the 200-segment test track."],
    responsibilityBoundary: "The solver agent owns tools/jointsolver only.", priority: "normal",
    requiredReading: [], forbiddenPaths: [], constraints: [], deliverables: ["One immutable child task report."],
    artifactReferences: [], allowSubagents: false,
  };
  const dispatched = await coordinator.controller_dispatch({ definition: JSON.stringify(definition) });
  assert.match(dispatched, /^Dispatched\.[\s\S]*task_child_action: delivered/u);
  assert.match(await coordinator.controller_start_task({ taskId: "solver-fix-001", reportOperation: "accept" }), /^Started/u);
  assert.equal(sent.at(-1).operationId, "task-start:solver-fix-001");

  // 3. The agent works the task with its desk tools.
  const agent = Object.fromEntries(createDeskTaskTools({ controllerRoot: controller,
    revisionOf: async () => "uncommitted (base 0123456789ab)", onReportSubmitted: returns.reportSubmitted })(
    { agentId: "solver" }).map((tool) => [tool.name, tool.handler]));
  const step = async (name, args) => {
    const answer = await agent[name](args);
    assert.match(answer, /^Done\./u, `${name}: ${answer}`);
    return answer;
  };
  assert.match(await agent.task_read({ taskId: "solver-fix-001" }), /# Orchestrated Task: Fix the joint solver drift/u);
  await step("task_accept", { taskId: "solver-fix-001", decision: "accepted" });
  await step("task_progress", { taskId: "solver-fix-001", taskState: "running", phase: "planning",
    lifecycleStage: "planning", ruleCheckpoint: "task_start", currentAction: "Reading the solver" });
  await step("task_progress", { taskId: "solver-fix-001", taskState: "waiting", phase: "planning",
    lifecycleStage: "awaiting_confirmation", currentAction: "Plan published", stepId: "tune",
    stepTitle: "Tune the damping", stepState: "pending" });
  assert.match(await agent.task_progress({ taskId: "solver-fix-001", lifecycleStage: "implementation",
    ruleCheckpoint: "pre_implementation" }), /^Refused \(exit 1\):[\s\S]*Implementation is locked/u);
  await step("task_confirm_plan", { taskId: "solver-fix-001", confirmationNote: "The person said: go." });
  await step("task_progress", { taskId: "solver-fix-001", taskState: "running", phase: "implementation",
    lifecycleStage: "implementation", ruleCheckpoint: "pre_implementation", currentAction: "Tuning",
    stepId: "tune", stepTitle: "Tune the damping", stepState: "running" });
  await step("task_progress", { taskId: "solver-fix-001", phase: "reporting", lifecycleStage: "reporting",
    ruleCheckpoint: "pre_completion", currentAction: "Writing the report", stepId: "tune",
    stepTitle: "Tune the damping", stepState: "completed" });
  await step("task_progress", { taskId: "solver-fix-001", taskState: "completed", lifecycleStage: "complete",
    currentAction: "Report ready", done: ["Damping tuned"] });
  const report = ["# Child Task Report", "", ...["Outcome", "Responsibility Boundary", "Changes", "Tests",
    "Contract Impact", "Artifacts", "Risks And Open Questions", "Unexpected Bug", "Coordinator Decision Requested",
    "References"].flatMap((section) => [`## ${section}`, "", section === "Unexpected Bug" ? "none" : "Text.", ""])].join("\n");
  await step("task_report", { taskId: "solver-fix-001", status: "completed", summary: "Damping tuned.", report });

  // 4. control-cli imports and accepts the report; the coordinator hears it.
  let record;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    record = await readDeskTaskReturn({ controllerRoot: controller, taskId: "solver-fix-001" });
    if (!["waiting", "operation-done"].includes(record.returnState)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(record.operationFailure, null, record.operationFailure);
  assert.equal(record.returnState, "delivered");
  assert.deepEqual(operations, [{ controllerRoot: controller, sourceId: "desk-solver", taskId: "solver-fix-001",
    operation: "accept" }]);
  assert.equal(record.operationResult.action, "accepted");
  assert.match(record.operationResult.report.path, /^knowledge\/reports\/inbox\/desk-solver\/\d{4}-\d{2}-\d{2}-solver-fix-001-report\.md$/u);
  assert.match(record.operationResult.acceptance.path, /solver-fix-001/u);
  assert.ok(await exists(path.join(controller, ...record.operationResult.acceptance.path.split("/"))), "the acceptance record");
  const catalog = JSON.parse(await readFile(path.join(controller, "knowledge", "catalog.json"), "utf8"));
  assert.ok(catalog.documents.some((document) => document.path.endsWith("solver-fix-001-report.progress.json")));
  const inbox = await readdir(path.join(controller, "knowledge", "reports", "inbox", "desk-solver"));
  assert.ok(inbox.some((name) => name.endsWith("-solver-fix-001-report.md.meta.json")));
  const wake = sent.find((item) => item.operationId === "task-return:solver-fix-001");
  assert.equal(wake.agentId, "boss");
  assert.match(wake.text, /Report operation: accept; action: accepted\./u);
  assert.match(wake.text, /Deterministic acceptance: /u);

  // 5. The control cycle's collection of every source stays in-process while every source is a desk agent.
  const { collectAllReportsByRoute, collectReportsByRoute } = await import("../src/desk-task-collect.mjs");
  const fallback = [];
  const cycleReports = await collectAllReportsByRoute({ controllerRoot: controller, collector: { taskRoot:
    "coordination/tasks/dispatched" } }, { fallback: async (input) => { fallback.push(input); return []; } });
  assert.deepEqual(cycleReports.map((item) => `${item.sourceId}/${item.taskId}`), ["desk-solver/solver-fix-001"]);
  assert.equal(fallback.length, 0);
  assert.deepEqual(await collectAllReportsByRoute({ controllerRoot: controller, collector: null }), [],
    "no collector configured, no collection");
  // A source of another route goes to the configured collector.
  assert.deepEqual(await collectReportsByRoute({ controllerRoot: controller, sourceId: "sampleapp", taskId: "x-task" },
    { fallback: async (input) => { fallback.push(input); return ["fallback"]; } }), ["fallback"]);

  // 6. Nothing started PowerShell, here or in control-cli's process.
  assert.deepEqual(attempts, []);
  assert.equal(await exists(guardLog), false, await readFile(guardLog, "utf8").catch(() => ""));
  assert.equal(await exists(path.join(controller, "tools")), false, "the controller has no PowerShell tools");
});

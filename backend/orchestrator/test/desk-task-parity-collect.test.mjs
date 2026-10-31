import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectVerifiedReports } from "../src/control-report-collector.mjs";
import { collectDeskVerifiedReports, runDeskCollector } from "../src/desk-task-collect.mjs";
import { installDeskAgentKit, runDeskControllerTool } from "../src/desk-task-controller.mjs";
import { runDeskKitScript } from "../src/desk-task-kit.mjs";
import {
  createController, registerDeskAgentFiles, runPowerShellFile, windowsPowerShellOnlyEnv, writeJson, writeText,
} from "./fixtures/desk-task/harness.mjs";
import { jsonAt, parityStep } from "./fixtures/desk-task/parity.mjs";

// The controller's collection of a desk agent's reports (collect_child_reports_v2.ps1
// -> collect_child_reports.ps1 -> import_agent_report.ps1, then
// rebuild_knowledge_catalog.ps1) against the Node port (desk-task-collect.mjs)
// on the same folder, and the verified report list control-cli builds from it.

const windows = process.platform === "win32";
const REPORT = ["# Child Task Report", "",
  ...["Outcome", "Responsibility Boundary", "Changes", "Tests", "Contract Impact", "Artifacts", "Risks And Open Questions",
    "Coordinator Decision Requested", "References"].flatMap((section) => [`## ${section}`, "", `${section} text.`, ""])].join("\n");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "desk-parity-collect-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const controller = path.join(root, "controller");
  await createController(controller);
  const { sourceId, folder } = await registerDeskAgentFiles(controller, { projectFolder: path.join(root, "RobotArm") });
  assert.equal((await installDeskAgentKit(controller, sourceId)).code, 0);
  return { root, controller, sourceId, folder };
}

/** A task through the whole chain with the Node kit; `finish` chooses the outcome. */
async function workTask(f, taskId, { contractVersion = "v0.3.0", outcome = "completed" } = {}) {
  const definitionPath = path.join(f.controller, "drafts", `${taskId}.json`);
  await writeJson(definitionPath, {
    contractVersion, ...(contractVersion === "v0.3.0" ? { workflowPolicy: "intent-confirm-plan-v1",
      intentConfirmation: { status: "confirmed", confirmedBy: "project-owner", confirmedAtUtc: "2026-10-02T08:00:00.000Z" } } : {}),
    taskId, targetId: f.sourceId, title: `Task ${taskId}`, intent: "Tune the solver.", desiredOutcomes: ["Tuned."],
    responsibilityBoundary: "The solver agent owns tools/jointsolver only.", deliverables: ["One report."],
    allowSubagents: false,
  });
  const dispatched = await runDeskControllerTool(path.join(f.controller, "tools", "dispatch_child_task.ps1"),
    ["-SourceId", f.sourceId, "-TaskDefinitionPath", definitionPath, "-RepoRoot", f.controller]);
  assert.equal(dispatched.code, 0, dispatched.output);
  const kit = (name) => path.join(f.folder, ".agents", "skills", "execute-orchestrated-task", "scripts", `${name}.ps1`);
  const run = async (name, parameters) => {
    const result = await runDeskKitScript(kit(name), { TaskId: taskId, WorkspaceRoot: f.folder, ...parameters });
    assert.equal(result.code, 0, `${name}: ${result.output}`);
  };
  const progress = (parameters) => run("update_task_progress", { AgentId: `${f.sourceId}-primary`, Provider: "claude",
    ...parameters });
  await run("accept_task", { Decision: "accepted", AgentId: `${f.sourceId}-primary` });
  if (contractVersion === "v0.3.0") {
    await progress({ RuleCheckpoint: "task_start", LifecycleStage: "awaiting_confirmation", StepId: "tune",
      StepTitle: "Tune", StepState: "pending" });
    await run("confirm_task_plan", {});
    await progress({ RuleCheckpoint: "pre_implementation", LifecycleStage: "implementation", TaskState: "running",
      StepId: "tune", StepTitle: "Tune", StepState: "running" });
  } else {
    await progress({ TaskState: "running", StepId: "tune", StepTitle: "Tune", StepState: "running" });
  }
  if (outcome === "completed") {
    if (contractVersion === "v0.3.0") await progress({ RuleCheckpoint: "pre_completion", LifecycleStage: "reporting" });
    await progress({ TaskState: "completed", LifecycleStage: contractVersion === "v0.3.0" ? "complete" : undefined,
      StepId: "tune", StepTitle: "Tune", StepState: "completed", LastCompleted: "Tuned" });
  } else {
    await progress({ TaskState: outcome, Blocker: ["Needs the UI owner"] });
  }
  const draft = path.join(f.folder, ".orchestrator", "reports", "drafts", taskId, "report.md");
  await writeText(draft, REPORT);
  await run("submit_report", { Status: outcome, SourceRevision: "0123456789abcdef0123456789abcdef01234567",
    ReportPath: draft, Summary: `Report of ${taskId}.` });
}

function collectorSteps(f) {
  const v2 = path.join(f.controller, "tools", "collect_child_reports_v2.ps1");
  const outcome = (result) => ({ code: result.status, output: `${result.stdout}\n${result.stderr}` });
  return (label, { sourceId = f.sourceId, taskId = null, times } = {}) => parityStep({ root: f.root, label, times,
    powershell: () => outcome(runPowerShellFile(v2, ["-RepoRoot", f.controller, ...(sourceId ? ["-SourceId", sourceId] : []),
      ...(taskId ? ["-TaskId", taskId] : [])], { cwd: f.controller })),
    node: (clock) => runDeskCollector({ RepoRoot: f.controller, ...(sourceId ? { SourceId: sourceId } : {}),
      ...(taskId ? { TaskId: taskId } : {}) }, { clock }) });
}

const imported = (f, taskId, date) => (files) => [jsonAt(files,
  `controller/knowledge/reports/inbox/${f.sourceId}/${date}-${taskId}-report.md.meta.json`).importedAtUtc];

test("collecting a desk agent's reports imports, copies the companions and catalogs the same files",
  { skip: !windows && "needs Windows PowerShell" }, async (t) => {
    const f = await fixture(t);
    await workTask(f, "solver-fix-001");
    await workTask(f, "solver-fix-002", { contractVersion: "v0.2.0" });
    const date = new Date().toISOString().slice(0, 10);
    const collect = collectorSteps(f);
    await collect("collect one task", { taskId: "solver-fix-001", times: imported(f, "solver-fix-001", date) });
    await collect("collect the same task again (already imported)", { taskId: "solver-fix-001" });
    await collect("collect the whole source (the second task is new)", { times: imported(f, "solver-fix-002", date) });

    // A blocked report: the collector holds a report with unfinished plan steps back, whatever its status.
    await workTask(f, "solver-fix-003", { contractVersion: "v0.2.0", outcome: "blocked" });
    await collect("collect a blocked report (refused, the import stays)", { taskId: "solver-fix-003",
      times: imported(f, "solver-fix-003", date) });

    // A report changed after it was submitted is refused before anything is imported.
    await workTask(f, "solver-fix-004");
    await appendFile(path.join(f.folder, ".orchestrator", "reports", "outbox", "solver-fix-004", "report.md"), "\nEdited.\n");
    await collect("collect an edited report (refused)", { taskId: "solver-fix-004" });
    await collect("collect a source that is not registered (refused)", { sourceId: "desk-nobody" });
  });

test("control-cli's verified report list is the same from the in-process collection as from the PowerShell collector",
  { skip: !windows && "needs Windows PowerShell" }, async (t) => {
    const f = await fixture(t);
    await workTask(f, "solver-fix-001");
    const collector = { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      "tools/collect_child_reports_v2.ps1"], toolReport: "logs/collect_child_reports_v2.report.json",
    taskRoot: "coordination/tasks/dispatched", timeoutMs: 120_000 };
    const date = new Date().toISOString().slice(0, 10);
    const events = { powershell: [], node: [] };
    let fromPowerShell;
    let fromNode;
    await parityStep({ root: f.root, label: "control-cli collection", times: imported(f, "solver-fix-001", date),
      powershell: async () => {
        // The collector command inherits this process's environment: Windows PowerShell 5.1 only, as everywhere here.
        const saved = { ...process.env };
        Object.assign(process.env, windowsPowerShellOnlyEnv());
        try {
          fromPowerShell = await collectVerifiedReports({ controllerRoot: f.controller, collector, sourceId: f.sourceId,
            taskId: "solver-fix-001", logger: async (event) => { events.powershell.push(event); } });
        } finally {
          for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
          Object.assign(process.env, saved);
        }
        return { code: 0, output: "" };
      },
      node: async (clock) => {
        fromNode = await collectDeskVerifiedReports({ controllerRoot: f.controller, collector, sourceId: f.sourceId,
          taskId: "solver-fix-001", clock, logger: async (event) => { events.node.push(event); } });
        return { code: 0, output: "" };
      } });
    assert.equal(fromNode.length, 1);
    assert.deepEqual(fromNode, fromPowerShell);
    assert.deepEqual(events.node, events.powershell);
  });

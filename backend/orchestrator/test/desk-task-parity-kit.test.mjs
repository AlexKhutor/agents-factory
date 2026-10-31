import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runKitScriptWithPowerShell } from "../src/desk-agent-task-tools.mjs";
import { installDeskAgentKit, runDeskControllerTool } from "../src/desk-task-controller.mjs";
import { runDeskKitScript } from "../src/desk-task-kit.mjs";
import { createController, registerDeskAgentFiles, runPowerShellFile, writeJson, writeText } from "./fixtures/desk-task/harness.mjs";
import { jsonAt, parityStep, stampTime } from "./fixtures/desk-task/parity.mjs";

// The desk agent's side of the task chain and the controller's dispatch and
// kit installation, run step by step with the PowerShell scripts and with
// the Node port (desk-task-kit.mjs, desk-task-controller.mjs) on the same
// folder: the files must be the same bytes (see fixtures/desk-task/parity.mjs
// for what is normalized and why).

const windows = process.platform === "win32";
const AGENT = "desk-solver-primary";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "desk-parity-kit-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const controller = path.join(root, "controller");
  await createController(controller);
  const { sourceId, folder } = await registerDeskAgentFiles(controller, { projectFolder: path.join(root, "RobotArm") });
  const kit = (name) => path.join(folder, ".agents", "skills", "execute-orchestrated-task", "scripts", `${name}.ps1`);
  const outcome = (result) => ({ code: result.status, output: `${result.stdout}\n${result.stderr}` });
  const steps = {
    install: (label) => parityStep({ root, label,
      powershell: () => outcome(runPowerShellFile(path.join(controller, "tools", "install_child_coordination_kit.ps1"),
        ["-SourceId", sourceId, "-RepoRoot", controller])),
      node: () => installDeskAgentKit(controller, sourceId) }),
    dispatch: (label, definitionPath, times) => parityStep({ root, label, times,
      powershell: () => outcome(runPowerShellFile(path.join(controller, "tools", "dispatch_child_task.ps1"),
        ["-SourceId", sourceId, "-TaskDefinitionPath", definitionPath, "-RepoRoot", controller])),
      node: (clock) => runDeskControllerTool(path.join(controller, "tools", "dispatch_child_task.ps1"),
        ["-SourceId", sourceId, "-TaskDefinitionPath", definitionPath, "-RepoRoot", controller], { clock }) }),
    kit: (label, name, parameters, times) => parityStep({ root, label, times,
      powershell: () => runKitScriptWithPowerShell(kit(name), { ...parameters, WorkspaceRoot: folder }, { cwd: folder }),
      node: (clock) => runDeskKitScript(kit(name), { ...parameters, WorkspaceRoot: folder }, { clock }) }),
    // A switch (HeartbeatOnly) passes only on a -File command line; the desk tools never send one.
    kitFile: (label, name, args, parameters, times) => parityStep({ root, label, times,
      powershell: () => outcome(runPowerShellFile(kit(name), [...args, "-WorkspaceRoot", folder], { cwd: folder })),
      node: (clock) => runDeskKitScript(kit(name), { ...parameters, WorkspaceRoot: folder }, { clock }) }),
  };
  const desk = (relative) => `controller/.project-local/desk-agents/${sourceId}/${relative}`;
  return { root, controller, sourceId, folder, steps, desk };
}

const definition = (overrides = {}) => ({
  contractVersion: "v0.3.0", workflowPolicy: "intent-confirm-plan-v1",
  intentConfirmation: { status: "confirmed", confirmedBy: "project-owner", confirmedAtUtc: "2026-10-02T08:00:00.000Z",
    note: "Confirmed in the desk." },
  taskId: "solver-fix-001", targetId: "desk-solver", title: "Fix the joint's <solver> & drift",
  intent: "Гусеница следует за колёсами без дрейфа.",
  desiredOutcomes: ["No visible drift on the 200-segment test track."],
  responsibilityBoundary: "The solver agent owns tools/jointsolver only.",
  priority: "high", requiredReading: [], forbiddenPaths: ["tools\\ui\\", "docs/"], constraints: [],
  deliverables: ["One immutable child task report."],
  artifactReferences: [{ kind: "file", path: "tools\\jointsolver\\solver.py", sha256: "AB".repeat(32) }],
  allowSubagents: false,
  executionProfile: { provider: "anthropic", model: "claude-test", reasoningEffort: "default", fallbackPolicy: "deny" },
  ...overrides,
});

const REPORT = ["\uFEFF# Child Task Report", "", "Task ID: `solver-fix-001`", "",
  ...["Outcome", "Responsibility Boundary", "Changes", "Tests", "Contract Impact", "Artifacts", "Risks And Open Questions",
    "Unexpected Bug", "Coordinator Decision Requested", "References"].flatMap((section) => [`## ${section}  `, "",
    section === "Unexpected Bug" ? "none" : `${section} text.`, ""])].join("\r\n");

test("install, dispatch and the agent's whole v0.3.0 task write the same files as the PowerShell kit",
  { skip: !windows && "needs Windows PowerShell" }, async (t) => {
    const f = await fixture(t);
    await f.steps.install("install the kit");
    await f.steps.install("install the kit again (nothing to change)");

    const definitionPath = path.join(f.controller, "drafts", "solver-fix-001.json");
    await writeJson(definitionPath, definition());
    const dispatched = (files) => [jsonAt(files, "controller/coordination/tasks/dispatched/solver-fix-001/task.json").dispatchedAtUtc];
    await f.steps.dispatch("dispatch (one outcome, empty lists, a backslash path, escapes)", definitionPath, dispatched);
    await f.steps.dispatch("dispatch again (already dispatched and delivered)", definitionPath, () => ["2026-10-20T09:00:00.000Z"]);
    const changed = path.join(f.controller, "drafts", "changed.json");
    await writeJson(changed, definition({ title: "Another title" }));
    await f.steps.dispatch("dispatch a different definition under the same ID (refused)", changed, () => ["2026-10-20T09:00:00.000Z"]);
    const unsafe = path.join(f.controller, "drafts", "unsafe.json");
    await writeJson(unsafe, definition({ taskId: "solver-fix-002", intent: "Read C:\\machine-local\\secret.txt." }));
    await f.steps.dispatch("dispatch a machine-local path (refused)", unsafe);

    const acknowledged = (files) => [jsonAt(files, f.desk(".orchestrator/tasks/acknowledged/solver-fix-001.json")).acknowledgedAtUtc];
    const progressed = (files) => [jsonAt(files, f.desk(".orchestrator/progress/outbox/solver-fix-001/progress.json")).updatedAtUtc];
    const confirmed = (files) => [
      jsonAt(files, f.desk(".orchestrator/tasks/approvals/solver-fix-001/approval-2.json")).confirmedAtUtc,
      ...progressed(files)];
    const progress = (label, parameters) => f.steps.kit(label, "update_task_progress",
      { TaskId: "solver-fix-001", AgentId: AGENT, Provider: "claude", ...parameters }, progressed);

    await f.steps.kit("accept", "accept_task", { TaskId: "solver-fix-001", Decision: "accepted", AgentId: AGENT }, acknowledged);
    await f.steps.kit("accept again (already acknowledged)", "accept_task",
      { TaskId: "solver-fix-001", Decision: "accepted", AgentId: AGENT }, () => ["2026-10-20T09:00:00.000Z"]);
    // A refused update has read the clock already (the script takes its time first) but wrote nothing.
    const unrecorded = () => ["2026-10-20T09:00:00.000Z"];
    await f.steps.kit("a first update without task_start (refused)", "update_task_progress",
      { TaskId: "solver-fix-001", AgentId: AGENT, Provider: "claude", TaskState: "running" }, unrecorded);
    await progress("task_start", { TaskState: "running", Phase: "planning", LifecycleStage: "planning",
      RuleCheckpoint: "task_start", CurrentAction: "Reading the solver", Next: ["Publish the plan", "Wait for confirmation"] });
    await progress("the plan's first step", { TaskState: "waiting", Phase: "planning", LifecycleStage: "awaiting_confirmation",
      CurrentAction: "Plan published", StepId: "tune", StepTitle: "Tune the solver's damping", StepState: "pending" });
    await progress("a second step (plan revision 2)", { StepId: "verify", StepTitle: "Verify on the <200> track",
      StepState: "pending" });
    await f.steps.kit("implementation before confirmation (refused)", "update_task_progress",
      { TaskId: "solver-fix-001", AgentId: AGENT, Provider: "claude", LifecycleStage: "implementation",
        RuleCheckpoint: "pre_implementation" }, unrecorded);
    await f.steps.kit("confirm the plan", "confirm_task_plan",
      { TaskId: "solver-fix-001", ConfirmedBy: "project-owner", ConfirmationNote: "The person said: go & do it." }, confirmed);
    await f.steps.kit("confirm again (already confirmed and synchronized)", "confirm_task_plan",
      { TaskId: "solver-fix-001", ConfirmedBy: "project-owner", ConfirmationNote: "The person said: go & do it." },
      () => ["2026-10-20T09:00:00.000Z"]);
    await progress("pre_implementation", { TaskState: "running", Phase: "implementation", LifecycleStage: "implementation",
      RuleCheckpoint: "pre_implementation", CurrentAction: "Changing the solver", StepId: "tune",
      StepTitle: "Tune the solver's damping", StepState: "running", Done: ["Plan confirmed"] });
    await progress("bounded lists", { StepId: "tune", StepTitle: "Tune the solver's damping", StepState: "completed",
      Done: ["Tuned", "Tuned", " ", "x".repeat(300), ...Array.from({ length: 25 }, (_, index) => `item ${index}`)],
      Blocker: [] });
    await progress("the second step", { StepId: "verify", StepTitle: "Verify on the <200> track", StepState: "running",
      CurrentAction: "Verifying" });
    await f.steps.kit("a completed report before completion (refused)", "submit_report", {
      TaskId: "solver-fix-001", Status: "completed", SourceRevision: "uncommitted (base 0123456789ab)",
      ReportPath: path.join(f.folder, ".orchestrator", "reports", "drafts", "solver-fix-001", "report.md"),
      Summary: "Too early." });
    await progress("pre_completion", { TaskState: "running", Phase: "reporting", LifecycleStage: "reporting",
      RuleCheckpoint: "pre_completion", CurrentAction: "Writing the report", StepId: "verify",
      StepTitle: "Verify on the <200> track", StepState: "completed" });
    await progress("complete", { TaskState: "completed", Phase: "reporting", LifecycleStage: "complete",
      CurrentAction: "Report ready", LastCompleted: "Drift removed", NextAction: "Submit the report",
      Done: ["Solver fixed", "Report written"] });

    const draft = path.join(f.folder, ".orchestrator", "reports", "drafts", "solver-fix-001", "report.md");
    await writeText(draft, REPORT);
    const reported = (files) => [jsonAt(files, f.desk(".orchestrator/reports/outbox/solver-fix-001/report.json")).reportedAtUtc];
    const submit = { TaskId: "solver-fix-001", Status: "completed", SourceRevision: "uncommitted (base 0123456789ab)",
      ReportPath: draft, Summary: "The drift is gone on the <200> test track & the solver's damping is tuned." };
    await f.steps.kit("submit the report", "submit_report", submit, reported);
    await f.steps.kit("submit again (already submitted)", "submit_report", submit);
    await f.steps.kit("a different report under the same task (refused)", "submit_report", { ...submit, Summary: "Other." });
    const delivered = JSON.parse(await readFile(path.join(f.folder, ".orchestrator", "reports", "outbox", "solver-fix-001",
      "report.json"), "utf8"));
    assert.equal(delivered.status, "completed");
  });

test("a v0.2.0 task, a coordinator's cancellation and a controller return signal write the same files",
  { skip: !windows && "needs Windows PowerShell" }, async (t) => {
    const f = await fixture(t);
    await f.steps.install("install the kit");
    const definitionPath = path.join(f.controller, "drafts", "solver-fix-003.json");
    await writeJson(definitionPath, definition({ contractVersion: "v0.2.0", workflowPolicy: undefined,
      intentConfirmation: undefined, taskId: "solver-fix-003", desiredOutcomes: ["One", "Two"],
      requiredReading: ["README.md"], constraints: ["Keep the API."], executionProfile: undefined, priority: "low" }));
    const dispatched = (files) => [jsonAt(files, "controller/coordination/tasks/dispatched/solver-fix-003/task.json").dispatchedAtUtc];
    await f.steps.dispatch("dispatch a v0.2.0 task", definitionPath, dispatched);
    const acknowledged = (files) => [jsonAt(files, f.desk(".orchestrator/tasks/acknowledged/solver-fix-003.json")).acknowledgedAtUtc];
    await f.steps.kit("accept", "accept_task", { TaskId: "solver-fix-003", Decision: "accepted", AgentId: AGENT }, acknowledged);
    const progressPath = f.desk(".orchestrator/progress/outbox/solver-fix-003/progress.json");
    const progressed = (files) => [jsonAt(files, progressPath).updatedAtUtc];
    const progress = (label, parameters, times = progressed) => f.steps.kit(label, "update_task_progress",
      { TaskId: "solver-fix-003", AgentId: AGENT, Provider: "claude", ...parameters }, times);
    await progress("first update (no workflow gate)", { TaskState: "running", Phase: "implementation",
      StepId: "work", StepTitle: "Work", StepState: "running" });
    await f.steps.kitFile("a heartbeat", "update_task_progress", ["-TaskId", "solver-fix-003", "-AgentId", AGENT,
      "-HeartbeatOnly"], { TaskId: "solver-fix-003", AgentId: AGENT, HeartbeatOnly: true }, progressed);
    await f.steps.kitFile("a heartbeat with a semantic field (refused)", "update_task_progress", ["-TaskId", "solver-fix-003",
      "-HeartbeatOnly", "-Phase", "x"], { TaskId: "solver-fix-003", HeartbeatOnly: true, Phase: "x" });

    // The coordinator cancels the task; the agent sees it at its next update and confirms the stop.
    await writeJson(path.join(f.folder, ".orchestrator", "control", "inbox", "solver-fix-003.cancel.json"), {
      schemaVersion: 1, command: "cancel-task", taskId: "solver-fix-003", reason: "The person changed plans.",
      requestedBy: "coordinator", requestedAtUtc: "2026-10-20T10:00:00.000Z" });
    await progress("an update sees the cancellation", { CurrentAction: "Still working" });
    await progress("the agent confirms the stop", { TaskState: "cancelled", CurrentAction: "Stopped" }, (files) => {
      const archived = [...files.keys()].find((name) => /control\/archive\/solver-fix-003\.cancel-\d{8}T\d{9}Z\.json$/u.test(name));
      return [...progressed(files), stampTime(/(\d{8}T\d{9}Z)\.json$/u.exec(archived)[1])];
    });

    // A second task with a controller return binding: the report publishes a wake signal.
    const second = path.join(f.controller, "drafts", "solver-fix-004.json");
    await writeJson(second, definition({ contractVersion: "v0.2.0", workflowPolicy: undefined, intentConfirmation: undefined,
      taskId: "solver-fix-004", executionProfile: undefined }));
    await f.steps.dispatch("dispatch a second v0.2.0 task", second,
      (files) => [jsonAt(files, "controller/coordination/tasks/dispatched/solver-fix-004/task.json").dispatchedAtUtc]);
    await f.steps.kit("accept it as blocked", "accept_task", { TaskId: "solver-fix-004", Decision: "blocked",
      Reason: "The UI belongs to another agent.", AgentId: AGENT },
    (files) => [jsonAt(files, f.desk(".orchestrator/tasks/acknowledged/solver-fix-004.json")).acknowledgedAtUtc]);
    const progress4 = f.desk(".orchestrator/progress/outbox/solver-fix-004/progress.json");
    await f.steps.kit("a blocked final update", "update_task_progress", { TaskId: "solver-fix-004", AgentId: AGENT,
      Provider: "claude", TaskState: "blocked", Phase: "intake", Blocker: ["Needs the UI owner"] },
    (files) => [jsonAt(files, progress4).updatedAtUtc]);
    const taskSha256 = (await readFile(path.join(f.folder, ".orchestrator", "tasks", "inbox", "solver-fix-004", "task.sha256"),
      "utf8")).split(/\s+/u)[0];
    await writeJson(path.join(f.folder, ".orchestrator", "control", "controller-return", "solver-fix-004.json"), {
      schemaVersion: 1, bindingId: "binding-4", taskId: "solver-fix-004", sourceId: "desk-solver", taskSha256,
      scope: "single-machine", expiresAtUtc: "2099-01-01T00:00:00.000Z" });
    const draft = path.join(f.folder, ".orchestrator", "reports", "drafts", "solver-fix-004", "report.md");
    await writeText(draft, REPORT.replace("\uFEFF", ""));
    await f.steps.kit("a blocked report with a wake signal", "submit_report", { TaskId: "solver-fix-004", Status: "blocked",
      SourceRevision: "not under version control", ReportPath: draft, Summary: "Blocked by the UI owner." }, (files) => [
      jsonAt(files, f.desk(".orchestrator/reports/outbox/solver-fix-004/report.json")).reportedAtUtc,
      jsonAt(files, f.desk(".orchestrator/events/outbox/solver-fix-004/wake.json")).occurredAtUtc]);
    await f.steps.kit("submit it again (the signal is already published)", "submit_report", { TaskId: "solver-fix-004",
      Status: "blocked", SourceRevision: "not under version control", ReportPath: draft, Summary: "Blocked by the UI owner." },
    () => ["2026-10-20T11:00:00.000Z"]);
  });

test("a desk agent's progress keeps non-ASCII text that the kit carries from update to update", async (t) => {
  // Windows PowerShell's Get-Content reads progress.json in the ANSI code page,
  // so the scripts garble a carried non-ASCII step title or summary; the Node
  // kit reads UTF-8. This difference is intended and is why the parity runs
  // above keep carried progress text ASCII.
  const root = await mkdtemp(path.join(os.tmpdir(), "desk-utf8-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = path.join(root, "controller");
  await createController(controller, { powershellTools: false });
  const { sourceId, folder } = await registerDeskAgentFiles(controller, { projectFolder: path.join(root, "RobotArm") });
  assert.equal((await installDeskAgentKit(controller, sourceId)).code, 0);
  const definitionPath = path.join(controller, "drafts", "task.json");
  await writeJson(definitionPath, definition());
  const tool = (name) => path.join(controller, "tools", `${name}.ps1`);
  assert.equal((await runDeskControllerTool(tool("dispatch_child_task"), ["-SourceId", sourceId, "-TaskDefinitionPath",
    definitionPath, "-RepoRoot", controller])).code, 0);
  const kit = (name) => path.join(folder, ".agents", "skills", "execute-orchestrated-task", "scripts", `${name}.ps1`);
  const run = async (name, parameters) => {
    const result = await runDeskKitScript(kit(name), { TaskId: "solver-fix-001", WorkspaceRoot: folder, ...parameters });
    assert.equal(result.code, 0, result.output);
  };
  await run("accept_task", { Decision: "accepted" });
  await run("update_task_progress", { RuleCheckpoint: "task_start", StepId: "plan", StepTitle: "Настроить демпфирование",
    StepState: "pending", Done: ["Прочитан решатель"] });
  await run("update_task_progress", { CurrentAction: "Жду подтверждения" });
  const progress = JSON.parse(await readFile(path.join(folder, ".orchestrator", "progress", "outbox", "solver-fix-001",
    "progress.json"), "utf8"));
  assert.equal(progress.plan[0].title, "Настроить демпфирование");
  assert.deepEqual(progress.summary.done, ["Прочитан решатель"]);
  assert.equal(progress.workflow.plan.revision, 1, "the carried title keeps the plan's identity");
  await writeFile(path.join(root, "done"), "");
});

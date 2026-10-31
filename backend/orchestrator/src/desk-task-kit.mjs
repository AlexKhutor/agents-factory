import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  assertJsonSchema, assertOrchestratedDurableText, compactStamp, copyItem, exists, fullPath,
  guidN, hasProperty, isFile, isNullOrWhiteSpace, moveItem, netMatch, netTrim, portableRelativePath, property,
  psArray, psBool, psCustomObject, psEquals, psIn, psJson, psString, readAllText, readJson, refuse, removeQuietly,
  runInProcess, sha256Bytes, sha256File, sha256Text, truthy, utcStamp, withToolRun, writePsJson,
  writeTextUtf8NoBom,
} from "./desk-task-common.mjs";

// The child kit of a desk agent in Node: what the kit's PowerShell scripts
// (.agents/skills/execute-orchestrated-task/scripts/accept_task.ps1,
// update_task_progress.ps1, confirm_task_plan.ps1, submit_report.ps1 and
// .agents/skills/signal-orchestrator/scripts/signal_orchestrator.ps1) do in
// the agent's coordination folder, with the same checks, files and hashes.
// The desk tools of the Gateway call them in-process for the Claude desk
// route (desk-agent-task-tools.mjs); the scripts stay for other routes.

export const DESK_TASK_KIT_VERSION = "v0.1.0";

const TASK_ID_PATTERN = "^[a-z0-9][a-z0-9.-]{2,95}$";
const IDENTITY_PATTERN = "^[a-z0-9][a-z0-9._-]{0,95}$";
const SETS = {
  Decision: ["accepted", "rejected", "blocked"],
  Status: ["completed", "blocked", "failed"],
  TaskState: ["accepted", "running", "waiting", "blocked", "cancelling", "cancelled", "completed", "failed",
    "stop_unconfirmed"],
  StepState: ["pending", "running", "completed", "blocked", "cancelled", "failed"],
  AgentKind: ["primary", "subagent", "tool-runner"],
  AgentState: ["registered", "starting", "running", "waiting", "blocked", "cancellation_requested", "interrupted",
    "completed", "failed", "stop_unconfirmed", "stale"],
  LifecycleStage: ["understanding", "clarification", "planning", "awaiting_confirmation", "implementation",
    "validation", "reporting", "complete"],
  RuleCheckpoint: ["task_start", "context_recovery", "pre_implementation", "plan_change", "pre_delegation",
    "pre_completion"],
};

const bound = (parameters, name) => parameters[name] !== undefined && parameters[name] !== null;

/** The binding checks of the scripts' param blocks (Mandatory, ValidateSet, ValidatePattern, ValidateRange). */
function bind(parameters, { mandatory = [], sets = [], patterns = {}, ranges = {} }) {
  const missing = mandatory.filter((name) => !bound(parameters, name));
  if (missing.length > 0) {
    refuse(`Cannot process command because of one or more missing mandatory parameters: ${missing.join(" ")}.`);
  }
  for (const name of sets) {
    if (!bound(parameters, name)) continue;
    if (!SETS[name].some((item) => item.toLowerCase() === String(parameters[name]).toLowerCase())) {
      refuse(`Cannot validate argument on parameter '${name}'. The argument "${parameters[name]}" does not belong to`
        + ` the set "${SETS[name].join(",")}" specified by the ValidateSet attribute. Supply an argument that is in the`
        + " set and then try the command again.", "desk_task_input_invalid");
    }
  }
  for (const [name, pattern] of Object.entries(patterns)) {
    if (bound(parameters, name) && !netMatch(pattern, parameters[name])) {
      refuse(`Cannot validate argument on parameter '${name}'. The argument "${parameters[name]}" does not match the`
        + ` "${pattern}" pattern. Supply an argument that matches "${pattern}" and try the command again.`,
      "desk_task_input_invalid");
    }
  }
  for (const [name, [minimum, maximum]] of Object.entries(ranges)) {
    if (bound(parameters, name) && (Number(parameters[name]) < minimum || Number(parameters[name]) > maximum)) {
      refuse(`Cannot validate argument on parameter '${name}'. The ${parameters[name]} argument is`
        + ` ${Number(parameters[name]) < minimum ? "less than the minimum" : "greater than the maximum"} allowed range`
        + ` of ${Number(parameters[name]) < minimum ? minimum : maximum}. Supply an argument that is`
        + ` ${Number(parameters[name]) < minimum ? "greater than or equal to" : "less than or equal to"}`
        + ` ${Number(parameters[name]) < minimum ? minimum : maximum} and then try the command again.`,
      "desk_task_input_invalid");
    }
  }
}

/** [string] of an optional [string] parameter: an unbound one is "". */
const text = (parameters, name, fallback = "") => (bound(parameters, name) ? psString(parameters[name]) : fallback);

/** [int] of a JSON value. */
function psInt(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  const number = Number(typeof value === "string" ? value.trim() : value);
  if (!Number.isFinite(number)) refuse(`Cannot convert value "${psString(value)}" to type "System.Int32".`);
  const floor = Math.floor(number);
  const fraction = number - floor;
  // [int] rounds half to even.
  return fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/** The first word of a SHA-256 sidecar, in lower case. */
async function sidecarHash(file) { return netTrim(await readAllText(file)).split(/\s+/u)[0].toLowerCase(); }

// ---------------------------------------------------------------------------
// coordination_common.ps1

/** Find-OrchestratedWorkspaceRoot. */
export async function findWorkspaceRoot(workspaceRoot) {
  const candidates = [];
  if (truthy(workspaceRoot)) candidates.push(fullPath(workspaceRoot));
  candidates.push(process.cwd());
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (!info) refuse(`Cannot find path '${candidate}' because it does not exist.`);
    let current = info.isDirectory() ? candidate : path.dirname(candidate);
    for (;;) {
      if (await isFile(path.join(current, ".orchestrator", "contract.json"))
          && await isFile(path.join(current, "project-version.json"))) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return refuse("Could not find a workspace containing .orchestrator/contract.json and project-version.json.");
}

/** Get-OrchestratedRelativePath. */
const relativeToWorkspace = (root, target) => portableRelativePath(root, target,
  (outside) => `Target is outside the workspace: ${outside}`);

function isDateTimeText(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

/** Read-OrchestratedTask: the inbox packet, checked against the contract and its sidecar. */
export async function readOrchestratedTask(root, taskId) {
  if (!netMatch(TASK_ID_PATTERN, taskId)) refuse(`Invalid task ID '${taskId}'.`);
  const contract = await readJson(path.join(root, ".orchestrator", "contract.json"));
  const taskDirectory = path.join(root, ".orchestrator", "tasks", "inbox", taskId);
  const taskPath = path.join(taskDirectory, "task.json");
  const taskHashPath = path.join(taskDirectory, "task.sha256");
  if (!(await isFile(taskPath)) || !(await isFile(taskHashPath))) {
    refuse(`Task '${taskId}' is incomplete or missing from the inbox.`);
  }
  const taskText = await readAllText(taskPath);
  assertOrchestratedDurableText(taskText, "task packet");
  const task = JSON.parse(taskText);
  if (!psEquals(property(task, "taskId"), taskId) || !psEquals(property(task, "targetId"), property(contract, "sourceId"))) {
    refuse("Task identity or target does not match the child contract.");
  }
  const supported = ["v0.1.0"];
  if (hasProperty(contract, "supportedTaskContractVersions")) {
    for (const version of psArray(property(contract, "supportedTaskContractVersions"))) {
      const normalized = psString(version);
      if (normalized && !supported.includes(normalized)) supported.push(normalized);
    }
  }
  const current = psString(property(contract, "taskContractVersion"));
  if (current && !supported.includes(current)) supported.push(current);
  const version = psString(property(task, "contractVersion"));
  if (!supported.includes(version)) refuse(`Unsupported task contract '${version}'; supported: ${supported.join(", ")}.`);
  if (psIn(version, ["v0.2.0", "v0.3.0"])) {
    for (const required of ["intent", "desiredOutcomes", "responsibilityBoundary", "executionAuthority"]) {
      if (!hasProperty(task, required)) refuse(`Task contract ${version} is missing '${required}'.`);
    }
    if (isNullOrWhiteSpace(psString(property(task, "intent")))
        || isNullOrWhiteSpace(psString(property(task, "responsibilityBoundary")))
        || psArray(property(task, "desiredOutcomes")).length === 0) {
      refuse(`Task contract ${version} requires a non-empty intent, responsibility boundary, and desired outcomes.`);
    }
    if (hasProperty(task, "allowedPaths") || hasProperty(task, "acceptanceCriteria")) {
      refuse(`Task contract ${version} must not prescribe allowedPaths or acceptanceCriteria.`);
    }
    const authority = property(task, "executionAuthority");
    if (!psEquals(property(authority, "implementationOwner"), "target")
        || !psEquals(property(authority, "localValidationOwner"), "target")
        || !psEquals(property(authority, "crossProjectAcceptanceOwner"), "coordinator")) {
      refuse(`Task contract ${version} has an invalid executionAuthority split.`);
    }
    if (psEquals(version, "v0.3.0")) {
      const confirmation = property(task, "intentConfirmation");
      if (!psEquals(property(task, "workflowPolicy"), "intent-confirm-plan-v1") || !hasProperty(task, "intentConfirmation")
          || !psEquals(property(confirmation, "status"), "confirmed")
          || isNullOrWhiteSpace(psString(property(confirmation, "confirmedBy")))
          || isNullOrWhiteSpace(psString(property(confirmation, "confirmedAtUtc")))) {
        refuse("Task contract v0.3.0 requires policy intent-confirm-plan-v1 and an explicit intent confirmation.");
      }
      if (!isDateTimeText(psString(property(confirmation, "confirmedAtUtc")))) {
        refuse("Task contract v0.3.0 has an invalid intent confirmation timestamp.");
      }
    }
  }
  const taskSha256 = await sha256File(taskPath);
  if (taskSha256 !== await sidecarHash(taskHashPath)) refuse(`Task packet hash mismatch for '${taskId}'.`);
  return { contract, task, taskPath, taskDirectory, taskSha256 };
}

/** Get-OrchestratedPlanIdentity: the SHA-256 of the plan's ids and titles. */
export function planIdentity(plan) {
  const shape = [];
  for (const step of plan) {
    const id = psString(property(step, "id"));
    const title = psString(property(step, "title"));
    if (!netMatch(IDENTITY_PATTERN, id) || isNullOrWhiteSpace(title)) {
      refuse("A plan step requires a valid id and non-empty title.");
    }
    assertOrchestratedDurableText(title, "plan step title");
    shape.push({ id, title });
  }
  return { sha256: sha256Text(psJson(shape, { compress: true })), shape };
}

/** Get-OrchestratedPlanApproval: the confirmed approval of a plan revision, or null. */
async function planApproval(root, taskId, revision, taskSha256, planSha256) {
  if (revision < 1) return null;
  const approvalPath = path.join(root, ".orchestrator", "tasks", "approvals", taskId, `approval-${revision}.json`);
  if (!(await isFile(approvalPath))) return null;
  const hashPath = path.join(root, ".orchestrator", "tasks", "approvals", taskId, `approval-${revision}.sha256`);
  if (!(await isFile(hashPath))) refuse(`Plan approval '${approvalPath}' is missing its SHA-256 sidecar.`);
  const actual = await sha256File(approvalPath);
  const declared = await sidecarHash(hashPath);
  if (!/^[a-f0-9]{64}$/iu.test(declared) || actual !== declared) {
    refuse(`Plan approval '${approvalPath}' does not match its SHA-256 sidecar.`);
  }
  const approvalText = await readAllText(approvalPath);
  assertOrchestratedDurableText(approvalText, "plan approval");
  const approval = JSON.parse(approvalText);
  await assertJsonSchema(approval, path.join(root, ".orchestrator", "schemas", "plan-approval.schema.json"), "Plan approval");
  if (psInt(property(approval, "schemaVersion")) !== 1 || !psEquals(property(approval, "contractVersion"), "v0.1.0")
      || !psEquals(property(approval, "taskId"), taskId) || psInt(property(approval, "planRevision")) !== revision
      || !psEquals(property(approval, "taskSha256"), taskSha256) || !psEquals(property(approval, "planSha256"), planSha256)
      || !psEquals(property(approval, "status"), "confirmed")) {
    refuse(`Plan approval '${approvalPath}' does not match the current task and plan identity.`);
  }
  return { path: approvalPath, approval };
}

/** The kit's ConvertTo-BoundedStrings: distinct, non-empty, durable, at most 20 of at most 256 characters. */
function boundedStrings(values, maximum = 20, maximumLength = 256) {
  const result = [];
  for (const value of psArray(values)) {
    const item = psString(value);
    if (isNullOrWhiteSpace(item) || result.includes(item)) continue;
    assertOrchestratedDurableText(item, "progress summary");
    result.push(item.length > maximumLength ? item.slice(0, maximumLength) : item);
    if (result.length >= maximum) break;
  }
  return result;
}

// One progress update of a task at a time, in this process; the lock file is
// held open so that a PowerShell update of the same task waits for it.
const progressLocks = new Map();
async function withProgressLock(lockPath, action) {
  const key = lockPath.toLowerCase();
  const previous = progressLocks.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const chain = previous.then(() => mine);
  progressLocks.set(key, chain);
  await previous;
  const deadline = Date.now() + 30_000;
  let handle = null;
  try {
    for (;;) {
      try {
        handle = await open(lockPath, "a");
        break;
      } catch (error) {
        if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
        if (Date.now() >= deadline) refuse(`Timed out waiting for progress lock '${lockPath}'.`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return await action();
  } finally {
    await handle?.close().catch(() => undefined);
    release();
    if (progressLocks.get(key) === chain) progressLocks.delete(key);
  }
}

/** Write-OrchestratedJsonAtomic. */
async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${guidN()}`;
  try {
    await writePsJson(temporary, value);
    await moveItem(temporary, file, { force: true });
  } finally {
    await removeQuietly(temporary);
  }
}

/**
 * Compress-OrchestratedEvents: events.jsonl at its size bound goes into a
 * verified gzip archive with a manifest. (Node's gzip bytes differ from .NET's
 * GZipStream; the manifest records the hashes of the bytes written.)
 */
async function compressEvents(eventPath, archiveDirectory, maximumBytes, clock) {
  const info = await stat(eventPath).catch(() => null);
  if (!info?.isFile() || info.size < maximumBytes) return null;
  await mkdir(archiveDirectory, { recursive: true });
  const archivePath = path.join(archiveDirectory, `events-${compactStamp(clock())}-${guidN()}.jsonl.gz`);
  const manifestPath = `${archivePath}.manifest.json`;
  const source = await readFile(eventPath);
  const sourceHash = sha256Bytes(source);
  await writeFile(archivePath, gzipSync(source));
  const roundTrip = gunzipSync(await readFile(archivePath));
  if (sha256Bytes(roundTrip) !== sourceHash || roundTrip.length !== source.length) {
    await removeQuietly(archivePath);
    refuse("Compressed progress event archive failed round-trip verification.");
  }
  await writeJsonAtomic(manifestPath, {
    schemaVersion: 1, archiveFile: path.basename(archivePath), sourceFile: path.basename(eventPath),
    sourceBytes: source.length, uncompressedSha256: sourceHash, compressedSha256: await sha256File(archivePath),
    createdAtUtc: utcStamp(clock()),
  });
  await removeQuietly(eventPath);
  return psCustomObject({ Path: archivePath, ManifestPath: manifestPath, SourceBytes: source.length });
}

// ---------------------------------------------------------------------------
// accept_task.ps1

/**
 * Acknowledges a delivered task exactly once (accepted, rejected or blocked).
 * Parameters as the script's: TaskId, Decision, Reason, AgentId, WorkspaceRoot.
 */
export async function acceptTask(parameters, { output, clock = () => new Date() }) {
  bind(parameters, { mandatory: ["TaskId"], sets: ["Decision"] });
  const root = await findWorkspaceRoot(parameters.WorkspaceRoot);
  const taskId = psString(parameters.TaskId);
  const decision = text(parameters, "Decision", "accepted");
  const reason = text(parameters, "Reason");
  const agentId = text(parameters, "AgentId", "codex");
  return withToolRun({ root, toolName: "accept_orchestrated_task", output,
    parameters: { TaskId: taskId, Decision: decision, Reason: reason, AgentId: agentId } }, async () => {
    if (!psEquals(decision, "accepted") && isNullOrWhiteSpace(reason)) {
      refuse("A rejected or blocked task acknowledgement requires a reason.");
    }
    assertOrchestratedDurableText(reason, "acknowledgement reason");
    const taskInfo = await readOrchestratedTask(root, taskId);
    const ackDirectory = path.join(root, ".orchestrator", "tasks", "acknowledged");
    const ackPath = path.join(ackDirectory, `${taskId}.json`);
    const ack = {
      schemaVersion: 1, taskId, sourceId: psString(property(taskInfo.contract, "sourceId")),
      taskSha256: taskInfo.taskSha256, decision, reason: reason ? reason : null, agentId,
      acknowledgedAtUtc: utcStamp(clock()),
    };
    let action = "acknowledged";
    if (await isFile(ackPath)) {
      const existing = await readJson(ackPath);
      if (!psEquals(property(existing, "taskSha256"), taskInfo.taskSha256) || !psEquals(property(existing, "decision"), decision)
          || !psEquals(property(existing, "agentId"), agentId) || !psEquals(property(existing, "reason"), reason)) {
        refuse(`Task acknowledgement is immutable and already differs for '${taskId}'.`);
      }
      action = "already-acknowledged";
    } else {
      await mkdir(ackDirectory, { recursive: true });
      await writePsJson(ackPath, ack);
    }
    output.host(`task_ack_action: ${action}`);
    output.host(`task_id: ${taskId}`);
    output.host(`task_decision: ${decision}`);
    return { Action: action, TaskId: taskId, Decision: decision, TaskSha256: taskInfo.taskSha256, AckPath: ackPath };
  });
}

// ---------------------------------------------------------------------------
// update_task_progress.ps1

const PROGRESS_SEMANTIC = ["TaskState", "Phase", "CurrentAction", "Done", "Next", "Blocker", "StepId", "StepTitle",
  "StepState", "ParentAgentId", "AgentKind", "AgentRole", "Provider", "AgentState", "LastCompleted", "NextAction",
  "CanInterrupt", "LifecycleStage", "RuleCheckpoint"];

function agentStateOf(taskState) {
  const state = String(taskState).toLowerCase();
  return { completed: "completed", failed: "failed", cancelled: "interrupted", cancelling: "cancellation_requested",
    stop_unconfirmed: "stop_unconfirmed", blocked: "blocked", waiting: "waiting" }[state] ?? "running";
}

/**
 * Publishes a task's progress (progress.json, events.jsonl). Parameters as the
 * script's: TaskId, TaskState, Phase, CurrentAction, Done, Next, Blocker,
 * StepId, StepTitle, StepState, AgentId, ParentAgentId, AgentKind, AgentRole,
 * Provider, AgentState, LastCompleted, NextAction, CanInterrupt,
 * LifecycleStage, RuleCheckpoint, HeartbeatOnly, HeartbeatIntervalSeconds,
 * WorkspaceRoot, MaxEventBytes.
 */
export async function updateTaskProgress(parameters, { output, clock = () => new Date() }) {
  bind(parameters, { mandatory: ["TaskId"], sets: ["TaskState", "StepState", "AgentKind", "AgentState", "LifecycleStage",
    "RuleCheckpoint"], ranges: { HeartbeatIntervalSeconds: [30, 60], MaxEventBytes: [65536, 1073741824] } });
  const root = await findWorkspaceRoot(parameters.WorkspaceRoot);
  const taskId = psString(parameters.TaskId);
  const heartbeatOnly = psBool(parameters.HeartbeatOnly);
  const heartbeatIntervalSeconds = bound(parameters, "HeartbeatIntervalSeconds") ? Number(parameters.HeartbeatIntervalSeconds) : 60;
  const maxEventBytes = bound(parameters, "MaxEventBytes") ? Number(parameters.MaxEventBytes) : 1_048_576;
  let taskState = text(parameters, "TaskState");
  let phase = text(parameters, "Phase");
  const currentAction = text(parameters, "CurrentAction");
  const stepId = text(parameters, "StepId");
  const stepTitle = text(parameters, "StepTitle");
  const stepState = text(parameters, "StepState");
  let agentId = text(parameters, "AgentId");
  const parentAgentId = text(parameters, "ParentAgentId");
  const agentKind = text(parameters, "AgentKind", "primary");
  const agentRole = text(parameters, "AgentRole", "child-project-agent");
  const provider = text(parameters, "Provider", "claude");
  let agentState = text(parameters, "AgentState");
  const lastCompleted = text(parameters, "LastCompleted");
  const nextAction = text(parameters, "NextAction");
  const canInterrupt = bound(parameters, "CanInterrupt") ? psBool(parameters.CanInterrupt) : true;
  let lifecycleStage = text(parameters, "LifecycleStage");
  const ruleCheckpoint = text(parameters, "RuleCheckpoint");
  return withToolRun({ root, toolName: "update_orchestrated_task_progress", output, parameters: {
    TaskId: taskId, TaskState: taskState, Phase: phase, AgentId: agentId, AgentState: agentState, StepId: stepId,
    StepState: stepState, LifecycleStage: lifecycleStage, RuleCheckpoint: ruleCheckpoint, HeartbeatOnly: heartbeatOnly,
    HeartbeatIntervalSeconds: heartbeatIntervalSeconds,
  } }, async () => {
    const taskInfo = await readOrchestratedTask(root, taskId);
    const sourceId = psString(property(taskInfo.contract, "sourceId"));
    if (!agentId) agentId = `${sourceId}-primary`;
    for (const identity of [agentId, parentAgentId, stepId]) {
      if (identity && !netMatch(IDENTITY_PATTERN, identity)) refuse(`Invalid progress identity '${identity}'.`);
    }
    for (const field of [phase, currentAction, stepTitle, agentRole, lastCompleted, nextAction]) {
      if (field) assertOrchestratedDurableText(field, "progress field");
    }
    const progressDirectory = path.join(root, ".orchestrator", "progress", "outbox", taskId);
    const progressPath = path.join(progressDirectory, "progress.json");
    const eventPath = path.join(progressDirectory, "events.jsonl");
    const archiveDirectory = path.join(progressDirectory, "archive");
    await mkdir(progressDirectory, { recursive: true });
    return withProgressLock(path.join(progressDirectory, ".update.lock"), async () => {
      const existing = await isFile(progressPath) ? await readJson(progressPath) : null;
      const strictWorkflow = psEquals(property(taskInfo.task, "contractVersion"), "v0.3.0");
      if (heartbeatOnly && !existing) refuse("HeartbeatOnly requires an existing progress record.");
      if (heartbeatOnly) {
        const semantic = PROGRESS_SEMANTIC.filter((name) => bound(parameters, name));
        if (semantic.length > 0) {
          refuse(`HeartbeatOnly cannot be combined with semantic progress fields: ${semantic.join(", ")}.`);
        }
      }
      if (!bound(parameters, "TaskState")) taskState = existing ? psString(existing.state) : "accepted";
      if (!bound(parameters, "Phase")) phase = existing ? psString(existing.phase) : "intake";
      const now = utcStamp(clock());
      let summaryNow = currentAction ? currentAction : existing ? psString(existing.summary?.now) : "Task accepted";
      const carried = (name) => psArray(existing?.summary?.[name]).map(psString);
      const summaryDone = bound(parameters, "Done") ? boundedStrings(parameters.Done) : existing ? carried("done") : [];
      const summaryNext = bound(parameters, "Next") ? boundedStrings(parameters.Next) : existing ? carried("next") : [];
      const summaryBlockers = bound(parameters, "Blocker") ? boundedStrings(parameters.Blocker)
        : existing ? carried("blockers") : [];

      const plan = [];
      let matched = false;
      if (stepId && (!stepTitle || !stepState)) refuse("StepId requires StepTitle and StepState.");
      for (const step of psArray(existing ? existing.plan : [])) {
        if (!stepId || !psEquals(property(step, "id"), stepId)) {
          plan.push(step);
          continue;
        }
        matched = true;
        plan.push({ id: stepId, title: stepTitle, state: stepState,
          startedAtUtc: hasProperty(step, "startedAtUtc") && truthy(step.startedAtUtc) ? psString(step.startedAtUtc)
            : psEquals(stepState, "running") ? now : null });
      }
      if (stepId && !matched) {
        plan.push({ id: stepId, title: stepTitle, state: stepState, startedAtUtc: psEquals(stepState, "running") ? now : null });
      }
      if (plan.length > 100) refuse("Progress plan exceeds 100 steps.");

      const identity = planIdentity(plan);
      const existingWorkflow = existing && hasProperty(existing, "workflow") ? existing.workflow : null;
      const existingPlanRevision = existingWorkflow ? psInt(existingWorkflow.plan?.revision) : 0;
      const existingPlanSha256 = existingWorkflow ? psString(existingWorkflow.plan?.sha256) : "";
      const planChanged = !psEquals(identity.sha256, existingPlanSha256);
      const planRevision = plan.length === 0 ? 0
        : existingPlanRevision > 0 && !planChanged ? existingPlanRevision : Math.max(1, existingPlanRevision + 1);

      let workflow = null;
      if (strictWorkflow) {
        if (!existing && !psEquals(ruleCheckpoint, "task_start")) {
          refuse("The first v0.3.0 progress update must record the task_start rule checkpoint.");
        }
        const previousPlanStatus = existingWorkflow ? psString(existingWorkflow.plan?.status) : "draft";
        if (planChanged && existingPlanRevision > 0 && psEquals(previousPlanStatus, "confirmed")
            && !psEquals(ruleCheckpoint, "plan_change")) {
          refuse("Changing a confirmed plan requires the plan_change rule checkpoint and renewed user confirmation.");
        }
        const checkpoints = [...psArray(existingWorkflow ? existingWorkflow.ruleCheckpoints : [])];
        if (ruleCheckpoint) {
          checkpoints.push({ kind: ruleCheckpoint, policy: "intent-confirm-plan-v1", planRevision, recordedAtUtc: now });
        }
        while (checkpoints.length > 50) checkpoints.shift();
        const approvalInfo = plan.length > 0
          ? await planApproval(root, taskId, planRevision, taskInfo.taskSha256, identity.sha256) : null;
        const planStatus = plan.length === 0 ? "draft" : approvalInfo ? "confirmed" : "awaiting_confirmation";
        if (!lifecycleStage) {
          lifecycleStage = existingWorkflow ? psString(existingWorkflow.lifecycleStage)
            : plan.length > 0 ? "planning" : "understanding";
        }
        if (planChanged && psEquals(previousPlanStatus, "confirmed")) lifecycleStage = "awaiting_confirmation";
        const checkpointOf = (kind) => checkpoints.some((checkpoint) => psEquals(property(checkpoint, "kind"), kind)
          && psInt(property(checkpoint, "planRevision")) === planRevision);
        if (psIn(lifecycleStage, ["implementation", "validation", "reporting", "complete"])) {
          if (!approvalInfo) refuse("Implementation is locked until the user confirms the current plan revision.");
          if (!checkpointOf("pre_implementation")) {
            refuse("Implementation requires a pre_implementation rule checkpoint for the current plan revision.");
          }
        }
        if (psEquals(lifecycleStage, "complete") && !checkpointOf("pre_completion")) {
          refuse("Completion requires a pre_completion rule checkpoint for the current plan revision.");
        }
        const confirmation = property(taskInfo.task, "intentConfirmation");
        workflow = {
          policy: "intent-confirm-plan-v1",
          lifecycleStage,
          intent: {
            statement: psString(property(taskInfo.task, "intent")),
            desiredOutcomes: psArray(property(taskInfo.task, "desiredOutcomes")).map((item) => (item === null ? null : psString(item))),
            status: "confirmed",
            confirmedBy: psString(property(confirmation, "confirmedBy")),
            confirmedAtUtc: psString(property(confirmation, "confirmedAtUtc")),
          },
          plan: {
            revision: planRevision, sha256: identity.sha256, status: planStatus,
            approvalPath: approvalInfo ? relativeToWorkspace(root, approvalInfo.path) : null,
            confirmedBy: approvalInfo ? psString(property(approvalInfo.approval, "confirmedBy")) : null,
            confirmedAtUtc: approvalInfo ? psString(property(approvalInfo.approval, "confirmedAtUtc")) : null,
          },
          lastRuleCheckpoint: checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null,
          ruleCheckpoints: checkpoints,
        };
      }

      const existingAgents = psArray(existing ? existing.agents : []);
      const previousAgent = existingAgents.find((agent) => psEquals(property(agent, "agentId"), agentId)) ?? null;
      if (!agentState) {
        agentState = heartbeatOnly && previousAgent ? psString(previousAgent.state) : agentStateOf(taskState);
      }
      const agents = existingAgents.filter((agent) => !psEquals(property(agent, "agentId"), agentId));
      const semanticUpdatedAt = heartbeatOnly && previousAgent
        ? hasProperty(previousAgent, "semanticUpdatedAtUtc") ? psString(previousAgent.semanticUpdatedAtUtc)
          : psString(previousAgent.updatedAtUtc)
        : now;
      const agent = {
        agentId,
        parentAgentId: parentAgentId ? parentAgentId : previousAgent ? (previousAgent.parentAgentId ?? null) : null,
        kind: heartbeatOnly && previousAgent ? psString(previousAgent.kind) : agentKind,
        role: heartbeatOnly && previousAgent ? psString(previousAgent.role) : agentRole,
        provider: heartbeatOnly && previousAgent ? psString(previousAgent.provider) : provider,
        state: agentState,
        currentAction: summaryNow,
        lastCompleted: lastCompleted ? lastCompleted : previousAgent ? (previousAgent.lastCompleted ?? null) : null,
        nextAction: nextAction ? nextAction : previousAgent ? (previousAgent.nextAction ?? null) : null,
        blockers: summaryBlockers,
        canInterrupt: heartbeatOnly && previousAgent ? psBool(previousAgent.canInterrupt)
          : canInterrupt && !psIn(agentState, ["interrupted", "completed", "failed", "stop_unconfirmed"]),
        startedAtUtc: previousAgent && truthy(previousAgent.startedAtUtc) ? psString(previousAgent.startedAtUtc) : now,
        lastHeartbeatUtc: now,
        semanticUpdatedAtUtc: semanticUpdatedAt,
        updatedAtUtc: heartbeatOnly && previousAgent ? psString(previousAgent.updatedAtUtc) : now,
      };
      agents.push(agent);
      if (agents.length > 256) refuse("Progress exceeds 256 agents.");

      const stopEvents = [...psArray(existing ? existing.stopEvents : [])];
      const inbox = path.join(root, ".orchestrator", "control", "inbox");
      let stopCommandPath = null;
      for (const candidate of [path.join(inbox, "emergency-stop.json"), path.join(inbox, `${taskId}.cancel.json`),
        path.join(inbox, "agents", `${agentId}.cancel.json`)]) {
        if (await isFile(candidate)) { stopCommandPath = candidate; break; }
      }
      const cancellationRequested = Boolean(stopCommandPath);
      let archiveStopCommand = false;
      if (cancellationRequested) {
        const stopText = await readAllText(stopCommandPath);
        assertOrchestratedDurableText(stopText, "orchestration stop command");
        const stopCommand = JSON.parse(stopText);
        const command = psString(property(stopCommand, "command"));
        const eventScope = psEquals(command, "emergency-stop-all") ? "all" : psEquals(command, "cancel-task") ? "task" : "agent";
        const eventTarget = psEquals(command, "cancel-agent") ? agentId : taskId;
        const requestedAt = psString(property(stopCommand, "requestedAtUtc"));
        const known = stopEvents.some((event) => psEquals(property(event, "scope"), eventScope)
          && psEquals(property(event, "targetId"), eventTarget) && psEquals(property(event, "atUtc"), requestedAt));
        if (!known) {
          stopEvents.push({ scope: eventScope, targetId: eventTarget, status: "requested",
            reason: psString(property(stopCommand, "reason")), atUtc: requestedAt });
        }
        const terminal = psIn(taskState, ["cancelled", "completed", "failed", "stop_unconfirmed"])
          || psIn(agentState, ["interrupted", "completed", "failed", "stop_unconfirmed"]);
        if (terminal) {
          archiveStopCommand = !psEquals(command, "emergency-stop-all");
          const confirmed = psEquals(taskState, "stop_unconfirmed") || psEquals(agentState, "stop_unconfirmed")
            ? "unconfirmed" : "confirmed";
          for (const event of stopEvents) {
            if (psEquals(property(event, "scope"), eventScope) && psEquals(property(event, "targetId"), eventTarget)) {
              event.status = confirmed;
            }
          }
        } else {
          for (const item of agents) {
            if (psEquals(property(item, "agentId"), agentId)) {
              item.state = "cancellation_requested";
              item.currentAction = "Cancellation requested by coordinator";
              item.canInterrupt = false;
            }
          }
          if (!psEquals(command, "cancel-agent") || psEquals(agentKind, "primary")) {
            taskState = "cancelling";
            phase = "cancellation";
            summaryNow = "Cancellation requested by coordinator";
          }
        }
      }
      while (stopEvents.length > 100) stopEvents.shift();

      const semanticUpdate = !heartbeatOnly || cancellationRequested;
      if (semanticUpdate && heartbeatOnly) {
        for (const item of agents) {
          if (psEquals(property(item, "agentId"), agentId)) {
            item.semanticUpdatedAtUtc = now;
            item.updatedAtUtc = now;
          }
        }
      }
      const previousSemanticUpdatedAt = existing && hasProperty(existing, "timing")
        ? psString(existing.timing?.semanticUpdatedAtUtc) : existing ? psString(existing.updatedAtUtc) : now;
      const semanticUpdatedAtUtc = semanticUpdate ? now : previousSemanticUpdatedAt;
      const nextHeartbeatDueAtUtc = utcStamp(new Date(Date.parse(now) + heartbeatIntervalSeconds * 1000));
      const progress = {
        schemaVersion: 1,
        contractVersion: strictWorkflow ? "v0.3.0" : "v0.2.0",
        sequence: existing ? psInt(existing.sequence) + 1 : 1,
        taskId,
        sourceId,
        title: psString(property(taskInfo.task, "title")),
        state: taskState,
        phase,
        summary: { now: summaryNow, done: summaryDone, next: summaryNext, blockers: summaryBlockers },
        plan,
        agents,
        evidence: existing ? psArray(existing.evidence) : [],
        stopEvents,
        startedAtUtc: existing ? psString(existing.startedAtUtc) : now,
        updatedAtUtc: now,
      };
      if (strictWorkflow) progress.workflow = workflow;
      progress.timing = { semanticUpdatedAtUtc, lastHeartbeatUtc: now, heartbeatIntervalSeconds, nextHeartbeatDueAtUtc };
      await writeJsonAtomic(progressPath, progress);
      let archivedStopCommandPath = null;
      if (archiveStopCommand && stopCommandPath) {
        const stopArchive = path.join(root, ".orchestrator", "control", "archive");
        await mkdir(stopArchive, { recursive: true });
        archivedStopCommandPath = path.join(stopArchive,
          `${path.basename(stopCommandPath, path.extname(stopCommandPath))}-${compactStamp(clock())}.json`);
        await moveItem(stopCommandPath, archivedStopCommandPath);
      }
      let archivedEvents = null;
      if (semanticUpdate) {
        archivedEvents = await compressEvents(eventPath, archiveDirectory, maxEventBytes, clock);
        const event = { schemaVersion: 1, sequence: progress.sequence, taskId, agentId, state: agentState, phase,
          lifecycleStage: strictWorkflow ? lifecycleStage : null, currentAction: summaryNow, updatedAtUtc: now };
        await appendFile(eventPath, Buffer.from(`${psJson(event, { compress: true })}\n`, "utf8"));
      }
      output.host(`task_progress_state: ${taskState}`);
      output.host(`task_progress_sequence: ${progress.sequence}`);
      output.host(`task_cancellation_requested: ${cancellationRequested}`);
      output.host(`task_progress_semantic_update: ${semanticUpdate}`);
      if (strictWorkflow) {
        output.host(`task_lifecycle_stage: ${lifecycleStage}`);
        output.host(`task_plan_status: ${workflow.plan.status}`);
      }
      return {
        TaskId: taskId, Sequence: progress.sequence, State: taskState, AgentId: agentId, AgentState: agentState,
        CancellationRequested: cancellationRequested, ProgressPath: progressPath,
        ProgressSha256: await sha256File(progressPath), ArchivedEvents: archivedEvents,
        ArchivedStopCommand: archivedStopCommandPath, SemanticUpdate: semanticUpdate,
        SemanticUpdatedAtUtc: semanticUpdatedAtUtc, LastHeartbeatUtc: now, NextHeartbeatDueAtUtc: nextHeartbeatDueAtUtc,
        LifecycleStage: strictWorkflow ? lifecycleStage : null, PlanRevision: strictWorkflow ? planRevision : null,
        PlanStatus: strictWorkflow ? psString(workflow.plan.status) : null,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// confirm_task_plan.ps1

/**
 * Records the person's confirmation of the current plan revision (approval
 * and sidecar), then opens the gate in progress.json. Parameters: TaskId,
 * ConfirmedBy, ConfirmationNote, WorkspaceRoot.
 */
export async function confirmTaskPlan(parameters, { output, clock = () => new Date() }) {
  bind(parameters, { mandatory: ["TaskId"] });
  const root = await findWorkspaceRoot(parameters.WorkspaceRoot);
  const taskId = psString(parameters.TaskId);
  const confirmedBy = text(parameters, "ConfirmedBy", "project-owner");
  const note = text(parameters, "ConfirmationNote");
  return withToolRun({ root, toolName: "confirm_orchestrated_task_plan", output,
    parameters: { TaskId: taskId, ConfirmedBy: confirmedBy, HasNote: !isNullOrWhiteSpace(note) } }, async () => {
    if (isNullOrWhiteSpace(confirmedBy)) refuse("ConfirmedBy must not be empty.");
    assertOrchestratedDurableText(confirmedBy, "plan confirmer");
    assertOrchestratedDurableText(note, "plan confirmation note");
    const taskInfo = await readOrchestratedTask(root, taskId);
    if (!psEquals(property(taskInfo.task, "contractVersion"), "v0.3.0")) {
      refuse("A separate plan confirmation applies only to task contract v0.3.0.");
    }
    const progressPath = path.join(root, ".orchestrator", "progress", "outbox", taskId, "progress.json");
    if (!(await isFile(progressPath))) {
      refuse(`Publish the proposed plan before confirming it; progress.json does not exist for '${taskId}'.`);
    }
    const progressText = await readAllText(progressPath);
    assertOrchestratedDurableText(progressText, "task progress");
    const progress = JSON.parse(progressText);
    const sourceId = psString(property(taskInfo.contract, "sourceId"));
    if (!psEquals(progress.taskId, taskId) || !psEquals(progress.sourceId, sourceId)) {
      refuse(`Progress identity does not match task '${taskId}'.`);
    }
    if (!hasProperty(progress, "workflow") || !psEquals(progress.workflow?.policy, "intent-confirm-plan-v1")) {
      refuse("Progress does not contain the required intent-confirm-plan-v1 workflow.");
    }
    const plan = psArray(progress.plan);
    if (plan.length === 0) refuse("The implementation plan must contain at least one step before confirmation.");
    const identity = planIdentity(plan);
    const revision = psInt(progress.workflow.plan?.revision);
    if (revision < 1 || !psEquals(progress.workflow.plan?.sha256, identity.sha256)) {
      refuse("Progress plan revision or SHA-256 does not match the current plan structure.");
    }
    const approvalDirectory = path.join(root, ".orchestrator", "tasks", "approvals", taskId);
    const approvalPath = path.join(approvalDirectory, `approval-${revision}.json`);
    const approvalHashPath = path.join(approvalDirectory, `approval-${revision}.sha256`);
    const approval = {
      schemaVersion: 1, contractVersion: "v0.1.0", status: "confirmed", workflowPolicy: "intent-confirm-plan-v1",
      taskId, sourceId, taskSha256: taskInfo.taskSha256, planRevision: revision, planSha256: identity.sha256,
      confirmedBy, confirmedAtUtc: utcStamp(clock()), note: note ? note : null,
    };
    await assertJsonSchema(approval, path.join(root, ".orchestrator", "schemas", "plan-approval.schema.json"), "Plan approval");
    let action = "confirmed";
    let approvalSha256;
    if (await isFile(approvalPath)) {
      const existing = JSON.parse(await readAllText(approvalPath));
      if (!psEquals(existing.taskSha256, taskInfo.taskSha256) || psInt(existing.planRevision) !== revision
          || !psEquals(existing.planSha256, identity.sha256) || !psEquals(existing.confirmedBy, confirmedBy)
          || !psEquals(existing.note, note)) {
        refuse(`Plan approval revision ${revision} is immutable and already differs for '${taskId}'.`);
      }
      approvalSha256 = await sha256File(approvalPath);
      if (!(await isFile(approvalHashPath))) refuse("Existing plan approval is missing its SHA-256 sidecar.");
      const declared = await sidecarHash(approvalHashPath);
      if (!/^[a-f0-9]{64}$/iu.test(declared) || approvalSha256 !== declared) {
        refuse("Existing plan approval hash does not match its sidecar.");
      }
      action = "already-confirmed";
    } else {
      await mkdir(approvalDirectory, { recursive: true });
      const temporary = `${approvalPath}.tmp-${guidN()}`;
      try {
        await writePsJson(temporary, approval);
        await moveItem(temporary, approvalPath);
      } finally {
        await removeQuietly(temporary);
      }
      approvalSha256 = await sha256File(approvalPath);
      await writeTextUtf8NoBom(approvalHashPath, `${approvalSha256}  ${path.basename(approvalPath)}\n`);
    }
    const relativeApprovalPath = relativeToWorkspace(root, approvalPath);
    const synchronized = psEquals(progress.workflow.plan?.status, "confirmed")
      && psEquals(progress.workflow.plan?.approvalPath, relativeApprovalPath);
    if (!synchronized) {
      // The script runs update_task_progress.ps1 with its own defaults (AgentId, Provider "claude").
      await updateTaskProgress({ TaskId: taskId, TaskState: "waiting", Phase: "planning", LifecycleStage: "planning",
        CurrentAction: "Plan confirmed; implementation has not started",
        Next: ["Record the pre-implementation checkpoint and execute the confirmed plan"], AgentState: "waiting",
        WorkspaceRoot: root }, { output, clock });
    }
    const synchronizedProgress = JSON.parse(await readAllText(progressPath));
    if (!psEquals(synchronizedProgress.workflow?.plan?.status, "confirmed")
        || !psEquals(synchronizedProgress.workflow?.plan?.approvalPath, relativeApprovalPath)) {
      refuse("Plan approval was written but progress synchronization did not open the implementation gate.");
    }
    output.host(`task_plan_confirmation_action: ${action}`);
    output.host(`task_id: ${taskId}`);
    output.host(`plan_revision: ${revision}`);
    output.host(`plan_sha256: ${identity.sha256}`);
    return {
      Action: action, TaskId: taskId, TaskSha256: taskInfo.taskSha256, PlanRevision: revision,
      PlanSha256: identity.sha256, ApprovalPath: approvalPath, ApprovalSha256: approvalSha256, ProgressPath: progressPath,
      ProgressSha256: await sha256File(progressPath),
    };
  });
}

// ---------------------------------------------------------------------------
// submit_report.ps1

const REPORT_HEADINGS = ["## Outcome", "## Responsibility Boundary", "## Changes", "## Tests", "## Contract Impact",
  "## Artifacts", "## Risks And Open Questions", "## Coordinator Decision Requested", "## References"];
const NET_SPACE_CLASS = "[\\f\\n\\r\\t\\v\\x85\\p{Z}]";

/** (?m)^<heading>\s*$ of .NET: a line (split at line feeds) that is the heading and white space. */
function hasHeading(textValue, heading) {
  const line = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}${NET_SPACE_CLASS}*$`, "iu");
  return textValue.split("\n").some((item) => line.test(item));
}

/**
 * Submits the task's one immutable report (report.md, report.json and, for
 * report contract v0.2.0, the final progress and an execution summary), then
 * the controller's wake signal. Parameters: TaskId, Status, SourceRevision,
 * ReportPath, Summary, WorkspaceRoot, MaxReportBytes.
 */
export async function submitReport(parameters, { output, clock = () => new Date() }) {
  bind(parameters, { mandatory: ["TaskId", "Status", "SourceRevision", "ReportPath", "Summary"], sets: ["Status"] });
  const root = await findWorkspaceRoot(parameters.WorkspaceRoot);
  const taskId = psString(parameters.TaskId);
  const status = psString(parameters.Status);
  const sourceRevision = psString(parameters.SourceRevision);
  const reportPathParameter = psString(parameters.ReportPath);
  const summary = psString(parameters.Summary);
  const maxReportBytes = bound(parameters, "MaxReportBytes") ? Number(parameters.MaxReportBytes) : 4_194_304;
  return withToolRun({ root, toolName: "submit_orchestrated_report", output, parameters: { TaskId: taskId,
    Status: status, SourceRevision: sourceRevision, ReportPath: reportPathParameter, Summary: summary,
    MaxReportBytes: maxReportBytes } }, async (keep) => {
    if (isNullOrWhiteSpace(sourceRevision) || isNullOrWhiteSpace(summary)) refuse("SourceRevision and Summary must not be empty.");
    assertOrchestratedDurableText(summary, "report summary");
    const taskInfo = await readOrchestratedTask(root, taskId);
    const sourceId = psString(property(taskInfo.contract, "sourceId"));
    const ackPath = path.join(root, ".orchestrator", "tasks", "acknowledged", `${taskId}.json`);
    if (!(await isFile(ackPath))) refuse(`Task '${taskId}' must be acknowledged before a report is submitted.`);
    const ack = await readJson(ackPath);
    if (psEquals(status, "completed") && !psEquals(ack.decision, "accepted")) {
      refuse("A completed report requires an accepted acknowledgement.");
    }
    if (!psEquals(ack.taskSha256, taskInfo.taskSha256)) refuse(`Acknowledgement task hash does not match '${taskId}'.`);

    const resolvedReportPath = fullPath(reportPathParameter);
    if (!(await exists(resolvedReportPath))) refuse(`Cannot find path '${resolvedReportPath}' because it does not exist.`);
    relativeToWorkspace(root, resolvedReportPath);
    const reportInfo = await stat(resolvedReportPath);
    if (reportInfo.isDirectory() || path.extname(resolvedReportPath).toLowerCase() !== ".md") {
      refuse("ReportPath must identify one Markdown file inside the workspace.");
    }
    if (reportInfo.size > maxReportBytes) refuse(`Report exceeds the ${maxReportBytes} byte limit.`);
    const reportText = await readAllText(resolvedReportPath);
    assertOrchestratedDurableText(reportText, "child report");
    for (const heading of REPORT_HEADINGS) {
      if (!hasHeading(reportText, heading)) refuse(`Report is missing required heading '${heading}'.`);
    }

    const reportId = `${taskId}-report`;
    const outbox = path.join(root, ".orchestrator", "reports", "outbox", taskId);
    const destinationReportPath = path.join(outbox, "report.md");
    const metadataPath = path.join(outbox, "report.json");
    const sourceDocument = relativeToWorkspace(root, destinationReportPath);
    const sourceHash = await sha256File(resolvedReportPath);
    const contractVersion = psString(property(taskInfo.contract, "reportContractVersion"));
    const progressSourcePath = path.join(root, ".orchestrator", "progress", "outbox", taskId, "progress.json");
    const destinationProgressPath = path.join(outbox, "progress.json");
    const executionSummaryPath = path.join(outbox, "execution-summary.json");
    const v02 = psEquals(contractVersion, "v0.2.0");
    let progressHash = null;
    let executionSummary = null;
    if (v02) {
      if (!(await isFile(progressSourcePath))) {
        refuse("Report contract v0.2.0 requires a final progress snapshot. Run update_task_progress.ps1 first.");
      }
      const progressText = await readAllText(progressSourcePath);
      assertOrchestratedDurableText(progressText, "final progress snapshot");
      const progress = JSON.parse(progressText);
      await assertJsonSchema(progress, path.join(root, ".orchestrator", "schemas", "worker-progress.schema.json"),
        "Final worker progress snapshot");
      const expectedState = psEquals(status, "completed") ? "completed" : psEquals(status, "blocked") ? "blocked" : "failed";
      const progressContract = psString(progress.contractVersion);
      if (!psIn(progressContract, ["v0.2.0", "v0.3.0"]) || !psEquals(progress.taskId, taskId)
          || !psEquals(progress.sourceId, sourceId) || !psEquals(progress.state, expectedState)) {
        refuse(`Final progress snapshot does not match the report identity or status '${expectedState}'.`);
      }
      if (psEquals(progressContract, "v0.3.0")) {
        if (!psEquals(property(taskInfo.task, "contractVersion"), "v0.3.0") || !hasProperty(progress, "workflow")
            || !psEquals(progress.workflow?.policy, "intent-confirm-plan-v1")) {
          refuse("Final progress v0.3.0 does not match a task using intent-confirm-plan-v1.");
        }
        if (psEquals(status, "completed") && (!psEquals(progress.workflow.lifecycleStage, "complete")
            || !psEquals(progress.workflow.plan?.status, "confirmed")
            || isNullOrWhiteSpace(psString(progress.workflow.plan?.approvalPath)))) {
          refuse("A completed v0.3.0 report requires complete lifecycle state and a confirmed plan approval.");
        }
      }
      const steps = psArray(progress.plan);
      if (psEquals(status, "completed")) {
        const unfinished = steps.filter((step) => !psEquals(step.state, "completed"));
        if (unfinished.length > 0) {
          refuse(`A completed report requires every plan step to be completed. Unfinished steps: ${unfinished
            .map((step) => psString(step.id)).join(", ")}`);
        }
      }
      progressHash = await sha256File(progressSourcePath);
      executionSummary = {
        schemaVersion: 1,
        stage: "child-execution",
        taskId,
        sourceId,
        outcome: status,
        summary,
        completedSteps: steps.filter((step) => psEquals(step.state, "completed")).map((step) => psString(step.title)),
        remainingSteps: steps.filter((step) => !psEquals(step.state, "completed")).map((step) => psString(step.title)),
        blockers: psArray(progress.summary?.blockers).map((item) => (item === null ? null : psString(item))),
        agentResults: psArray(progress.agents).map((agent) => ({
          agentId: psString(agent.agentId), state: psString(agent.state),
          summary: truthy(agent.lastCompleted) ? psString(agent.lastCompleted)
            : truthy(agent.currentAction) ? psString(agent.currentAction) : "No bounded summary supplied",
        })),
        stopEvents: psArray(progress.stopEvents).map((event) => ({
          scope: psString(event.scope), targetId: truthy(event.targetId) ? psString(event.targetId) : null,
          status: psString(event.status), reason: truthy(event.reason) ? psString(event.reason) : null,
          atUtc: psString(event.atUtc),
        })),
        sourceRevision,
        decisionReference: null,
        startedAtUtc: psString(progress.startedAtUtc),
        finishedAtUtc: psString(progress.updatedAtUtc),
      };
    }
    let action = "submitted";
    if (await isFile(destinationReportPath) || await isFile(metadataPath)) {
      if (await isFile(destinationReportPath) && await isFile(metadataPath)
          && await sha256File(destinationReportPath) === sourceHash) {
        const existing = await readJson(metadataPath);
        if (!psEquals(existing.status, status) || !psEquals(existing.sourceRevision, sourceRevision)
            || !psEquals(existing.summary, summary) || !psEquals(existing.taskSha256, taskInfo.taskSha256)
            || !psEquals(existing.contractVersion, contractVersion)) {
          refuse(`Existing report content matches, but immutable metadata differs for task '${taskId}'.`);
        }
        if (v02 && (!(await isFile(destinationProgressPath)) || !(await isFile(executionSummaryPath))
            || !psEquals(existing.progressSha256, await sha256File(destinationProgressPath))
            || !psEquals(existing.executionSummarySha256, await sha256File(executionSummaryPath)))) {
          refuse("Existing v0.2.0 report is missing immutable progress or execution summary evidence.");
        }
        action = "already-submitted";
      } else {
        refuse(`A different immutable report already exists for task '${taskId}'.`);
      }
    } else {
      await mkdir(outbox, { recursive: true });
      const temporaryReport = `${destinationReportPath}.tmp-${guidN()}`;
      const temporaryMetadata = `${metadataPath}.tmp-${guidN()}`;
      const temporaryProgress = `${destinationProgressPath}.tmp-${guidN()}`;
      const temporarySummary = `${executionSummaryPath}.tmp-${guidN()}`;
      try {
        await copyItem(resolvedReportPath, temporaryReport);
        if (v02) {
          await copyItem(progressSourcePath, temporaryProgress);
          await writePsJson(temporarySummary, executionSummary);
        }
        const metadata = {
          schemaVersion: 1, contractVersion, reportId, taskId, sourceId, status, summary, sourceRevision, sourceDocument,
          taskSha256: taskInfo.taskSha256, reportFile: "report.md", reportSha256: sourceHash,
          reportedAtUtc: utcStamp(clock()),
        };
        if (v02) {
          Object.assign(metadata, { progressFile: "progress.json", progressSha256: progressHash,
            executionSummaryFile: "execution-summary.json", executionSummarySha256: await sha256File(temporarySummary) });
        }
        await writePsJson(temporaryMetadata, metadata);
        await moveItem(temporaryReport, destinationReportPath);
        if (v02) {
          await moveItem(temporaryProgress, destinationProgressPath);
          await moveItem(temporarySummary, executionSummaryPath);
        }
        await moveItem(temporaryMetadata, metadataPath);
      } finally {
        for (const temporary of [temporaryReport, temporaryMetadata, temporaryProgress, temporarySummary]) {
          await removeQuietly(temporary);
        }
      }
    }
    const result = { Action: action, TaskId: taskId, ReportId: reportId, Status: status, TaskSha256: taskInfo.taskSha256,
      ReportSha256: sourceHash, ReportPath: destinationReportPath, MetadataPath: metadataPath,
      ProgressPath: v02 ? destinationProgressPath : null, ExecutionSummaryPath: v02 ? executionSummaryPath : null };
    keep(result);
    // The kit installs the signal skill; its presence is what the script checks.
    if (await isFile(path.join(root, ".agents", "skills", "signal-orchestrator", "scripts", "signal_orchestrator.ps1"))) {
      try {
        await signalOrchestrator({ TaskId: taskId, WorkspaceRoot: root }, { output, clock });
        result.ControllerSignal = "published-or-not-configured";
      } catch (error) {
        const message = String(error?.message ?? error);
        result.ControllerSignal = "failed";
        result.ControllerSignalProblem = message.slice(0, 1024);
        output.host(`The immutable report is valid, but the controller wake signal failed: ${message}`);
      }
    } else {
      result.ControllerSignal = "skill-not-installed";
    }
    output.host(`task_report_action: ${action}`);
    output.host(`task_id: ${taskId}`);
    output.host(`task_report_status: ${status}`);
    output.host(`task_report_sha256: ${sourceHash}`);
    return result;
  });
}

// ---------------------------------------------------------------------------
// signal_orchestrator.ps1

/**
 * Publishes the controller's wake signal for a submitted report when the
 * task has a controller return binding; without one it does nothing.
 * Parameters: TaskId, WorkspaceRoot.
 */
export async function signalOrchestrator(parameters, { output, clock = () => new Date() }) {
  bind(parameters, { mandatory: ["TaskId"], patterns: { TaskId: TASK_ID_PATTERN } });
  const candidate = truthy(parameters.WorkspaceRoot) ? fullPath(parameters.WorkspaceRoot) : process.cwd();
  if (!(await exists(candidate))) refuse(`Cannot find path '${candidate}' because it does not exist.`);
  const root = await findWorkspaceRoot(candidate);
  const taskId = psString(parameters.TaskId);
  return withToolRun({ root, toolName: "signal_orchestrator", output, parameters: { TaskId: taskId } }, async () => {
    const bindingPath = path.join(root, ".orchestrator", "control", "controller-return", `${taskId}.json`);
    if (!(await isFile(bindingPath))) {
      output.host("orchestrator_signal_action: not-configured");
      return { Action: "not-configured", TaskId: taskId, Reason: "controller-return-binding-missing" };
    }
    const binding = await readJson(bindingPath);
    const now = clock();
    const expires = Date.parse(psString(binding.expiresAtUtc));
    if (!psEquals(binding.taskId, taskId) || !psEquals(binding.scope, "single-machine")
        || isNullOrWhiteSpace(psString(binding.bindingId)) || Number.isNaN(expires) || expires <= now.getTime()) {
      refuse(`Controller return binding is invalid or expired for task '${taskId}'.`);
    }
    const metadataPath = path.join(root, ".orchestrator", "reports", "outbox", taskId, "report.json");
    if (!(await isFile(metadataPath))) refuse(`Immutable report metadata is missing for task '${taskId}'.`);
    const metadataBytes = await readFile(metadataPath);
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    if (!psEquals(metadata.taskId, taskId) || !psEquals(metadata.sourceId, binding.sourceId)
        || !psEquals(metadata.taskSha256, binding.taskSha256)) {
      refuse(`Report and controller return binding identities do not match for task '${taskId}'.`);
    }
    const metadataSha256 = sha256Bytes(metadataBytes);
    const signal = {
      schemaVersion: 1, eventType: "child-report-ready", sourceId: psString(metadata.sourceId), taskId,
      taskSha256: psString(metadata.taskSha256), returnBindingId: psString(binding.bindingId),
      reportStatus: psString(metadata.status), reportMetadataSha256: metadataSha256, occurredAtUtc: utcStamp(now),
    };
    const signalDirectory = path.join(root, ".orchestrator", "events", "outbox", taskId);
    const signalPath = path.join(signalDirectory, "wake.json");
    const hashPath = path.join(signalDirectory, "wake.sha256");
    const bytes = Buffer.from(`${psJson(signal)}\n`, "utf8");
    let signalSha256 = sha256Bytes(bytes);
    let action = "published";
    if (await isFile(signalPath) || await isFile(hashPath)) {
      if (!(await isFile(signalPath) && await isFile(hashPath))) {
        refuse(`Incomplete immutable wake signal already exists for task '${taskId}'.`);
      }
      const existingSha = await sha256File(signalPath);
      if (existingSha !== await sidecarHash(hashPath)) refuse(`Existing wake signal hash is invalid for task '${taskId}'.`);
      const existing = JSON.parse((await readFile(signalPath)).toString("utf8"));
      if (!psEquals(existing.taskId, taskId) || !psEquals(existing.returnBindingId, binding.bindingId)
          || !psEquals(existing.reportMetadataSha256, metadataSha256)) {
        refuse(`A different immutable wake signal already exists for task '${taskId}'.`);
      }
      action = "already-published";
      signalSha256 = existingSha;
    } else {
      await mkdir(signalDirectory, { recursive: true });
      const temporarySignal = `${signalPath}.tmp-${guidN()}`;
      const temporaryHash = `${hashPath}.tmp-${guidN()}`;
      try {
        await writeFile(temporarySignal, bytes);
        await writeTextUtf8NoBom(temporaryHash, `${signalSha256}  wake.json\n`);
        await moveItem(temporarySignal, signalPath);
        await moveItem(temporaryHash, hashPath);
      } finally {
        await removeQuietly(temporarySignal);
        await removeQuietly(temporaryHash);
      }
    }
    output.host(`orchestrator_signal_action: ${action}`);
    output.host(`orchestrator_signal_sha256: ${signalSha256}`);
    return { Action: action, TaskId: taskId, SignalPath: signalPath, SignalSha256: signalSha256 };
  });
}

// ---------------------------------------------------------------------------
// The scripts by name, for the desk tools

export const DESK_KIT_SCRIPTS = Object.freeze({
  accept_task: acceptTask,
  update_task_progress: updateTaskProgress,
  confirm_task_plan: confirmTaskPlan,
  submit_report: submitReport,
  signal_orchestrator: signalOrchestrator,
});

/**
 * Runs a kit script in-process: the same call shape as the PowerShell runner
 * of desk-agent-task-tools.mjs (the script's path, its named parameters) and
 * the same answer ({ code, output }).
 */
export async function runDeskKitScript(script, parameters, { clock } = {}) {
  const name = path.basename(String(script)).replace(/\.ps1$/iu, "");
  const implementation = DESK_KIT_SCRIPTS[name];
  if (!implementation) return { code: 1, output: `ERROR: The kit has no script '${name}'.` };
  return runInProcess((output) => implementation(parameters, { output, ...(clock ? { clock } : {}) }));
}


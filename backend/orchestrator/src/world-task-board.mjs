import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { DESK_AGENT_FOLDER, readDeskAgentSource } from "./desk-agent-sources.mjs";
import { DESK_TASK_RETURNS_DIRECTORY } from "./desk-task-index.mjs";
import { readWorldTaskIndexes } from "./world-registry.mjs";

// The task board of the world lead (Atlas): which desk agents take controller
// tasks, and where each task dispatched to them stands - dispatched, started,
// accepted by the agent, planned, in progress, reported, accepted by code - or
// that the agent did not take it. Read-only, from the files the controller and
// the agents' kits already write (claude-code-controller.md); nothing here
// decides or changes a task. The trusted host reads it through the memory CLI
// (read-task-board); the Gateway never exposes it, and no path leaves it.

export const WORLD_TASK_BOARD_VERSION = "v0.1.0";
export const TASK_BOARD_LIMITS = Object.freeze({ sources: 128, tasks: 200, tasksPerSource: 512, text: 400 });
/** Where a task stands, in the order of the task contract; `declined` ends it early. */
export const TASK_STAGES = Object.freeze(["dispatched", "started", "accepted", "planned", "in-progress", "reported",
  "accepted-by-code", "declined"]);

const TASK_ID = /^[a-z0-9][a-z0-9.-]{2,95}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_FILE_BYTES = 1024 * 1024;
const IMPLEMENTING = new Set(["implementation", "validation", "reporting", "complete"]);
const PLANNING = new Set(["planning", "awaiting_confirmation"]);
// Progress of a task without the v0.3.0 workflow: its state alone.
const WORKING_STATES = new Set(["running", "in_progress", "working", "validating", "completed", "failed", "blocked",
  "cancelling", "cancelled"]);

function fail(code) { throw Object.assign(new Error(code), { code }); }

async function readBounded(file) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
  return readFile(file).catch(() => null);
}

async function readJson(file) {
  const bytes = await readBounded(file);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8").replace(/^﻿/u, ""));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (value, limit = TASK_BOARD_LIMITS.text) => (typeof value === "string" && value.trim() !== ""
  ? value.trim().slice(0, limit) : null);
const token = (value) => (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value) ? value : null);
const time = (value) => (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
  ? value : null);
const integer = (value) => (Number.isSafeInteger(value) ? value : null);

/**
 * Where a task stands, from what the board read. A task the agent rejected or
 * blocked at acceptance is `declined`: no report will come. A deterministic
 * acceptance of its report is the last step.
 */
export function taskStageOf(task) {
  if ((task.acknowledgement !== null && task.acknowledgement.decision !== "accepted") || task.start?.declined === true) {
    return "declined";
  }
  if (task.acceptance !== null) return "accepted-by-code";
  if (task.report !== null) return "reported";
  const progress = task.progress;
  if (progress !== null) {
    if (IMPLEMENTING.has(progress.lifecycleStage)) return "in-progress";
    if (PLANNING.has(progress.lifecycleStage) || ["awaiting_confirmation", "confirmed"].includes(progress.planStatus)) {
      return "planned";
    }
    if (progress.lifecycleStage === null && WORKING_STATES.has(progress.state)) return "in-progress";
  }
  if (task.acknowledgement !== null || progress !== null) return "accepted";
  if (task.start !== null) return "started";
  return "dispatched";
}

/** The desk agents registered as controller sources, each with whether its source still validates. */
async function readSources(root) {
  const registry = await readJson(path.join(root, "config", "source-registry.json"));
  const entries = Array.isArray(registry?.sources) ? registry.sources : [];
  const sources = [];
  for (const entry of entries) {
    if (sources.length >= TASK_BOARD_LIMITS.sources) break;
    if (typeof entry?.deskAgentId !== "string" || !ID.test(entry.deskAgentId) || typeof entry.id !== "string") continue;
    const found = await readDeskAgentSource({ controllerRoot: root, agentId: entry.deskAgentId }).catch(() => null);
    sources.push({ agentId: entry.deskAgentId, sourceId: entry.id,
      valid: found !== null && found.sourceId === entry.id });
  }
  return sources;
}

async function readTask(root, source, taskId) {
  const folder = path.join(root, DESK_AGENT_FOLDER, source.sourceId, ".orchestrator");
  const inboxBytes = await readBounded(path.join(folder, "tasks", "inbox", taskId, "task.json"));
  if (inboxBytes === null) return null;
  let packet;
  try { packet = JSON.parse(inboxBytes.toString("utf8").replace(/^﻿/u, "")); } catch { return null; }
  if (packet?.taskId !== taskId) return null;
  // The controller archives the same immutable packet it delivered.
  const dispatchedBytes = await readBounded(path.join(root, "coordination", "tasks", "dispatched", taskId, "task.json"));
  const acknowledgement = await readJson(path.join(folder, "tasks", "acknowledged", `${taskId}.json`));
  const progress = await readJson(path.join(folder, "progress", "outbox", taskId, "progress.json"));
  const report = await readJson(path.join(folder, "reports", "outbox", taskId, "report.json"));
  const returned = await readJson(path.join(root, DESK_TASK_RETURNS_DIRECTORY, `${taskId}.json`));
  const start = returned !== null && returned.agentId === source.agentId ? returned : null;
  const acceptanceFile = await readJson(path.join(root, "coordination", "acceptances", source.sourceId, taskId,
    "acceptance.json"));
  const recorded = start?.operationResult?.acceptance ?? null;
  const acceptance = acceptanceFile !== null && acceptanceFile.taskId === taskId
    ? { result: token(acceptanceFile.result), evaluatedAtUtc: time(acceptanceFile.evaluatedAtUtc) }
    : recorded !== null && typeof recorded === "object" ? { result: "passed", evaluatedAtUtc: null } : null;
  const decision = start?.operationResult?.decision ?? null;
  const definition = await lstat(path.join(root, ".project-local", "desk-coordinator", "definitions", `${taskId}.json`))
    .catch(() => null);
  const task = {
    taskId,
    title: text(packet.title, 200),
    sourceId: source.sourceId,
    agentId: source.agentId,
    contractVersion: token(packet.contractVersion),
    priority: token(packet.priority),
    dispatchedAtUtc: time(packet.dispatchedAtUtc),
    verified: dispatchedBytes !== null && sha256(dispatchedBytes) === sha256(inboxBytes),
    dispatchedByCoordinator: definition?.isFile() === true,
    start: start === null ? null : {
      startedAtUtc: time(start.startedAtUtc),
      coordinatorAgentId: typeof start.coordinatorAgentId === "string" && ID.test(start.coordinatorAgentId)
        ? start.coordinatorAgentId : null,
      reportOperation: token(start.reportOperation),
      continuationPolicy: token(start.continuationPolicy),
      returnState: token(start.returnState),
      declined: start.declined !== undefined && start.declined !== null,
    },
    acknowledgement: acknowledgement === null || acknowledgement.taskId !== taskId ? null : {
      decision: token(acknowledgement.decision),
      reason: text(acknowledgement.reason),
      acknowledgedAtUtc: time(acknowledgement.acknowledgedAtUtc),
    },
    progress: progress === null || progress.taskId !== taskId ? null : {
      state: token(progress.state),
      lifecycleStage: token(progress.workflow?.lifecycleStage ?? progress.lifecycleStage ?? null),
      planStatus: token(progress.workflow?.plan?.status ?? null),
      planRevision: integer(progress.workflow?.plan?.revision ?? null),
      now: text(progress.summary?.now, 200),
      updatedAtUtc: time(progress.updatedAtUtc),
    },
    report: report === null || report.taskId !== taskId ? null : {
      status: token(report.status),
      summary: text(report.summary),
      reportedAtUtc: time(report.reportedAtUtc),
    },
    acceptance,
    review: decision === null || typeof decision !== "object" ? null : { outcome: token(decision.outcome) },
  };
  return { ...task, stage: taskStageOf(task) };
}

/**
 * The board: every desk source, and the tasks in their inboxes (of one agent
 * when `agentId` is given), newest dispatch first. `truncated` says that more
 * tasks exist than were returned.
 */
export async function readWorldTaskBoard({ controllerRoot, agentId = null }) {
  if (typeof controllerRoot !== "string" || !path.isAbsolute(controllerRoot)) fail("memory_invalid_input");
  if (agentId !== null && (typeof agentId !== "string" || !ID.test(agentId))) fail("memory_invalid_input");
  const root = path.resolve(controllerRoot);
  const sources = await readSources(root);
  const tasks = [];
  let truncated = false;
  for (const source of sources) {
    if (agentId !== null && source.agentId !== agentId) continue;
    const inbox = path.join(root, DESK_AGENT_FOLDER, source.sourceId, ".orchestrator", "tasks", "inbox");
    const names = (await readdir(inbox, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && TASK_ID.test(entry.name)).map((entry) => entry.name).sort();
    if (names.length > TASK_BOARD_LIMITS.tasksPerSource) truncated = true;
    for (const taskId of names.slice(-TASK_BOARD_LIMITS.tasksPerSource)) {
      const task = await readTask(root, source, taskId);
      if (task !== null) tasks.push(task);
    }
  }
  // A project that is not on this PC: its agents and tasks by the world's index
  // alone (R34) - no title, no report - marked "not-here".
  for (const index of await readWorldTaskIndexes(root).catch(() => [])) {
    for (const entry of index.sources) {
      const listed = sources.find((source) => source.sourceId === entry.sourceId);
      if (listed) listed.availability = "not-here";
      else if (sources.length < TASK_BOARD_LIMITS.sources && entry.agentId && entry.sourceId) {
        sources.push({ agentId: entry.agentId, sourceId: entry.sourceId, valid: false, availability: "not-here" });
      }
    }
    for (const entry of index.tasks) {
      if (agentId !== null && entry.agentId !== agentId) continue;
      if (!TASK_ID.test(entry.taskId ?? "") || tasks.some((task) => task.taskId === entry.taskId)) continue;
      tasks.push({ taskId: entry.taskId, title: null, sourceId: entry.sourceId, agentId: entry.agentId,
        contractVersion: null, priority: null, dispatchedAtUtc: time(entry.dispatchedAtUtc), verified: false,
        dispatchedByCoordinator: false, start: null, acknowledgement: null, progress: null, report: null,
        acceptance: null, review: null, stage: TASK_STAGES.includes(entry.stage) ? entry.stage : "dispatched",
        availability: "not-here", projectTitle: text(index.title, 200) });
    }
  }
  tasks.sort((left, right) => String(right.dispatchedAtUtc ?? "").localeCompare(String(left.dispatchedAtUtc ?? ""))
    || left.taskId.localeCompare(right.taskId));
  if (tasks.length > TASK_BOARD_LIMITS.tasks) truncated = true;
  return { schemaVersion: 1, sources, tasks: tasks.slice(0, TASK_BOARD_LIMITS.tasks), truncated };
}

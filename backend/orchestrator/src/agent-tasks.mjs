import { createHash } from "node:crypto";
import { newObjectId } from "./object-ids.mjs";

// Tasks given to an agent in its chat's task mode (roadmap track V, items 1-2;
// docs/personal/plans/01_11_2026_task-mode-and-plan.md). The agent first changes
// nothing and answers with how it understood the task, its questions and the
// steps it plans; the person approves the plan, asks for changes or cancels the
// task, and only an approved plan is worked on. One store document per project
// (`agent-tasks-v1:<hash of the project ID>`), in the project's own memory
// database like its names and action journal: it goes with the project. The
// record and its stages are made for the task board (track M) too: the board
// lists the same records, and its columns are the stages.

export const AGENT_TASKS_VERSION = "v0.1.0";
export const TASKS_PREFIX = "agent-tasks-v1:";
export const TASK_STAGES = Object.freeze(["planning", "awaiting-approval", "in-progress", "done", "cancelled"]);
export const OPEN_STAGES = Object.freeze(["planning", "awaiting-approval", "in-progress"]);
export const TASK_PHASES = Object.freeze(["plan", "work"]);
export const TASK_ORIGINS = Object.freeze(["chat"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const LIMITS = Object.freeze({ tasks: 200, revisions: 20, remarks: 20, text: 8000, understanding: 4000,
  questions: 16, question: 1000, steps: 40, step: 600, answers: 16, answer: 2000, raw: 16000,
  results: 32, resultPath: 400, resultNote: 400, documentBytes: 200 * 1024 });
const CAS_ATTEMPTS = 32;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu;

function fail(code) { throw Object.assign(new Error(code), { code }); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) fail("task_invalid_input");
  return value;
}
/** Free text as kept: no control characters but new lines and tabs, at most `max` characters. */
function clip(value, max) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").replace(CONTROL, "").trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : text;
}
function requiredText(value, max) {
  if (typeof value !== "string" || !value.trim()) fail("task_invalid_input");
  const text = String(value).replace(/\r\n?/gu, "\n").replace(CONTROL, "").trim();
  if ([...text].length > max) fail("task_text_too_long");
  return text;
}

/** The store document of one project's tasks. */
export function tasksKeyOf(projectId) {
  return `${TASKS_PREFIX}${sha256(id(projectId)).slice(0, 32)}`;
}

/**
 * Who a task waits for: the person while its plan waits for approval or after
 * the agent stopped (a failed or interrupted turn); the agent while it plans or
 * works; nobody once it is done or cancelled.
 */
export function waitingForOf(task) {
  if (!OPEN_STAGES.includes(task?.stage)) return null;
  if (task.stage === "awaiting-approval" || task.stopped) return "person";
  return "agent";
}

function tasksOf(value) {
  return Array.isArray(value?.tasks) ? value.tasks.filter((task) => task && typeof task.taskId === "string"
    && ID.test(task.taskId) && TASK_STAGES.includes(task.stage)) : [];
}

/** Old finished tasks go first when the document is full; open ones always stay. */
function trim(tasks) {
  const closed = () => tasks.findIndex((task) => !OPEN_STAGES.includes(task.stage));
  while (tasks.length > LIMITS.tasks && closed() !== -1) tasks.splice(closed(), 1);
  while (Buffer.byteLength(JSON.stringify(tasks), "utf8") > LIMITS.documentBytes && closed() !== -1) {
    tasks.splice(closed(), 1);
  }
}

async function change(store, projectId, update) {
  const key = tasksKeyOf(projectId);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const record = await store.readDocument({ key });
    const tasks = structuredClone(tasksOf(record?.value));
    const result = update(tasks);
    trim(tasks);
    const value = { schemaVersion: 1, projectId, tasks };
    if (await store.compareAndSwapDocument({ key, expectedRevision: record?.revision ?? 0, value })) {
      return result;
    }
  }
  return fail("task_contention");
}

function find(tasks, taskId) {
  const task = tasks.find((item) => item.taskId === taskId);
  if (!task) fail("task_not_found");
  return task;
}

/** A task as it is shown: the record with whom it waits for. */
export function publicTask(task) {
  return { ...structuredClone(task), waitingFor: waitingForOf(task) };
}

/**
 * Tasks of one project, newest first. Filters: `agentId`, `quarterId`,
 * `stages` (a list), `waitingFor` ("person" | "agent"), `limit` (1-200).
 */
export async function readTasks(store, input = {}) {
  const projectId = id(input.projectId);
  const stages = input.stages ?? null;
  if (stages !== null && (!Array.isArray(stages) || stages.some((stage) => !TASK_STAGES.includes(stage)))) {
    fail("task_invalid_input");
  }
  if (input.waitingFor !== undefined && input.waitingFor !== null && !["person", "agent"].includes(input.waitingFor)) {
    fail("task_invalid_input");
  }
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.tasks) fail("task_invalid_input");
  const record = await store.readDocument({ key: tasksKeyOf(projectId) });
  const tasks = tasksOf(record?.value)
    .filter((task) => (input.agentId ?? null) === null || task.agentId === input.agentId)
    .filter((task) => (input.quarterId ?? null) === null || task.quarterId === input.quarterId)
    .filter((task) => stages === null || stages.includes(task.stage))
    .filter((task) => (input.waitingFor ?? null) === null || waitingForOf(task) === input.waitingFor)
    .sort((a, b) => String(b.updatedAtUtc).localeCompare(String(a.updatedAtUtc)));
  return { schemaVersion: 1, projectId, tasks: tasks.slice(0, limit).map(publicTask), truncated: tasks.length > limit };
}

const WORLD_PROJECT_ID = "world";

/**
 * Tasks of every project the store holds and the world's, newest first (the
 * window's attention: what waits for the person anywhere). Filters as readTasks.
 */
export async function readAllTasks(store, input = {}) {
  const { projectId, limit = 100, ...filters } = input;
  if (projectId !== undefined) fail("task_invalid_input");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.tasks) fail("task_invalid_input");
  const projectIds = [...new Set([...(await store.listScopes({})).scopes.map((scope) => scope.projectId), WORLD_PROJECT_ID])];
  const tasks = [];
  let truncated = false;
  for (const id of projectIds) {
    const read = await readTasks(store, { ...filters, projectId: id, limit: LIMITS.tasks });
    tasks.push(...read.tasks);
    truncated ||= read.truncated;
  }
  tasks.sort((a, b) => String(b.updatedAtUtc).localeCompare(String(a.updatedAtUtc)));
  return { schemaVersion: 1, projectId: null, tasks: tasks.slice(0, limit), truncated: truncated || tasks.length > limit };
}

/** One task of a project. */
export async function readTask(store, { projectId, taskId }) {
  const record = await store.readDocument({ key: tasksKeyOf(id(projectId)) });
  return publicTask(find(tasksOf(record?.value), id(taskId)));
}

/** The open task of an agent, or null: an agent works on one task at a time. */
export async function openTaskOf(store, { projectId, agentId }) {
  const record = await store.readDocument({ key: tasksKeyOf(id(projectId)) });
  const task = tasksOf(record?.value).find((item) => item.agentId === agentId && OPEN_STAGES.includes(item.stage));
  return task === undefined ? null : publicTask(task);
}

/** A new task of an agent, at the planning stage. */
export async function createTask(store, { projectId, quarterId, agentId, text, now = new Date(), random } = {}) {
  id(projectId); id(quarterId); id(agentId);
  const body = requiredText(text, LIMITS.text);
  const at = now.toISOString();
  return change(store, projectId, (tasks) => {
    if (tasks.some((task) => task.agentId === agentId && OPEN_STAGES.includes(task.stage))) fail("task_agent_busy");
    const taskId = newObjectId("task", { taken: tasks.map((task) => task.taskId), ...(random ? { random } : {}) });
    const task = { schemaVersion: 1, taskId, origin: "chat", projectId, quarterId, agentId, text: body,
      stage: "planning", stopped: null, revisions: [], remarks: [], approved: null, steps: [],
      lastOperationId: null, createdAtUtc: at, updatedAtUtc: at };
    tasks.push(task);
    return publicTask(task);
  });
}

function answersOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.answers) fail("task_invalid_input");
  return value.map((answer) => (typeof answer === "string" ? clip(answer, LIMITS.answer) : ""));
}

/** The agent's answer to a planning turn becomes the plan's next revision; the task then waits for the person. */
export async function recordPlan(store, { projectId, taskId, planText, operationId = null, now = new Date() }) {
  const plan = parseTaskPlan(planText);
  return change(store, projectId, (tasks) => {
    const task = find(tasks, id(taskId));
    if (operationId !== null && task.revisions.some((revision) => revision.operationId === operationId)) {
      return publicTask(task);
    }
    if (task.stage !== "planning") fail("task_stage_conflict");
    const at = now.toISOString();
    task.revisions.push({ revision: (task.revisions.at(-1)?.revision ?? 0) + 1, ...plan, operationId, atUtc: at });
    if (task.revisions.length > LIMITS.revisions) task.revisions.splice(0, task.revisions.length - LIMITS.revisions);
    Object.assign(task, { stage: "awaiting-approval", stopped: null, lastOperationId: operationId, updatedAtUtc: at });
    return publicTask(task);
  });
}

/** The person asks for changes: their remarks and answers go to the agent, which plans again. */
export async function reviseTask(store, { projectId, taskId, remarks, answers, now = new Date() }) {
  const text = requiredText(remarks, LIMITS.text);
  const given = answersOf(answers);
  return change(store, projectId, (tasks) => {
    const task = find(tasks, id(taskId));
    if (task.stage !== "awaiting-approval" && !(task.stage === "planning" && task.stopped)) fail("task_stage_conflict");
    const at = now.toISOString();
    task.remarks.push({ afterRevision: task.revisions.at(-1)?.revision ?? 0, text, answers: given, atUtc: at });
    if (task.remarks.length > LIMITS.remarks) task.remarks.splice(0, task.remarks.length - LIMITS.remarks);
    Object.assign(task, { stage: "planning", stopped: null, updatedAtUtc: at });
    return publicTask(task);
  });
}

/** The person approves one revision of the plan (the latest only): the agent works on it next. */
export async function approveTask(store, { projectId, taskId, revision, answers, now = new Date() }) {
  const given = answersOf(answers);
  return change(store, projectId, (tasks) => {
    const task = find(tasks, id(taskId));
    if (task.stage !== "awaiting-approval") fail("task_stage_conflict");
    const latest = task.revisions.at(-1);
    if (!latest || latest.revision !== revision) fail("task_revision_conflict");
    const at = now.toISOString();
    Object.assign(task, { stage: "in-progress", stopped: null, updatedAtUtc: at,
      approved: { revision, answers: given, atUtc: at },
      steps: latest.steps.map((step) => ({ text: step, status: "pending" })) });
    return publicTask(task);
  });
}

/** The person cancels an open task. Returns the task and the stage it had. */
export async function cancelTask(store, { projectId, taskId, now = new Date() }) {
  return change(store, projectId, (tasks) => {
    const task = find(tasks, id(taskId));
    if (!OPEN_STAGES.includes(task.stage)) fail("task_stage_conflict");
    const previousStage = task.stage;
    Object.assign(task, { stage: "cancelled", stopped: null, updatedAtUtc: now.toISOString() });
    return { task: publicTask(task), previousStage };
  });
}

/** A turn of the task stopped without a result (failed, interrupted): the task waits for the person. */
export async function stopTask(store, { projectId, taskId, state, operationId = null, now = new Date() }) {
  return change(store, projectId, (tasks) => {
    const task = find(tasks, id(taskId));
    if (!OPEN_STAGES.includes(task.stage)) return publicTask(task);
    Object.assign(task, { stopped: state === "failed" ? "failed" : "interrupted", lastOperationId: operationId,
      updatedAtUtc: now.toISOString() });
    return publicTask(task);
  });
}

const TODO_STATUSES = new Map([["pending", "pending"], ["in_progress", "in-progress"], ["completed", "done"]]);

/**
 * The end of a work turn: a completed one makes the task done; the agent's
 * last todo list (one item per plan step, in order) marks the steps. `results`
 * are the files the agent listed as the task's results, each with its artifact
 * (or why it has none): the task board's card shows them.
 */
export async function settleWork(store, { projectId, taskId, state, todos = null, results = null, operationId = null,
  now = new Date() }) {
  return change(store, projectId, (tasks) => {
    const task = find(tasks, id(taskId));
    if (task.stage !== "in-progress") return publicTask(task);
    if (Array.isArray(todos)) {
      todos.slice(0, task.steps.length).forEach((todo, index) => {
        const status = TODO_STATUSES.get(todo?.status);
        if (status) task.steps[index].status = status;
      });
    }
    if (state === "completed") {
      if (!Array.isArray(todos)) for (const step of task.steps) step.status = "done";
      Object.assign(task, { stage: "done", stopped: null });
      if (Array.isArray(results)) task.results = structuredClone(results.slice(0, LIMITS.results));
    } else {
      task.stopped = state === "failed" ? "failed" : "interrupted";
    }
    Object.assign(task, { lastOperationId: operationId, updatedAtUtc: now.toISOString() });
    return publicTask(task);
  });
}

// --- the plan's form ------------------------------------------------------------
//
// The agent answers a planning turn in three sections under fixed English
// headings; the text under them may be in the person's language. The headings
// are also recognised in Russian (by code point: the source stays ASCII).

const RU = (codes) => String.fromCodePoint(...codes);
const HEADINGS = Object.freeze([
  ["understanding", ["understanding", "summary", RU([0x43f, 0x43e, 0x43d, 0x438, 0x43c, 0x430, 0x43d, 0x438, 0x435])]],
  ["questions", ["questions", "open questions", "question", RU([0x432, 0x43e, 0x43f, 0x440, 0x43e, 0x441, 0x44b])]],
  ["plan", ["plan", "steps", RU([0x43f, 0x43b, 0x430, 0x43d]), RU([0x448, 0x430, 0x433, 0x438])]],
  ["results", ["results", "result", RU([0x440, 0x435, 0x437, 0x443, 0x43b, 0x44c, 0x442, 0x430, 0x442, 0x44b]),
    RU([0x440, 0x435, 0x437, 0x443, 0x43b, 0x44c, 0x442, 0x430, 0x442])]],
]);
const NONE = new Set(["none", "no questions", "n/a", "-", RU([0x43d, 0x435, 0x442]),
  RU([0x432, 0x43e, 0x43f, 0x440, 0x43e, 0x441, 0x43e, 0x432, 0x20, 0x43d, 0x435, 0x442])]);

/** The section a line starts, and the text after its heading on the same line ("**Plan:** ..."). */
function headingOf(line) {
  // "## Plan", "**Plan**", "**Plan:**", "**Plan**:", "Plan:" - the label ends at a colon or a closing mark.
  const bare = line.trim().replace(/^#{1,6}\s*/u, "").replace(/^(\*\*|__)/u, "");
  const end = bare.search(/:|\*\*|__/u);
  const label = (end === -1 ? bare : bare.slice(0, end)).trim().toLowerCase();
  if (!label || label.length > 40) return null;
  const rest = end === -1 ? "" : bare.slice(end).replace(/^(?:\*\*|__|:|\s)+/u, "").trim();
  for (const [section, words] of HEADINGS) if (words.includes(label)) return { section, rest };
  return null;
}

const ITEM = /^\s{0,6}(?:[-*]|\d{1,3}[.)])\s+(.*)$/u;

/**
 * The items of a list: a line that goes on an item is part of it, an indented one
 * even after a blank line; text after a blank line that is not indented (a note
 * after the list) is no part of any item.
 */
function items(lines) {
  const found = [];
  let gap = false;
  for (const line of lines) {
    const match = ITEM.exec(line);
    if (match) {
      found.push(match[1].trim());
      gap = false;
    } else if (!line.trim()) {
      gap = true;
    } else if (found.length > 0 && (!gap || /^\s/u.test(line))) {
      found[found.length - 1] += ` ${line.trim()}`;
    }
  }
  return found.map((item) => item.replace(/^\[[ xX]\]\s*/u, "").trim()).filter(Boolean);
}

/**
 * A plan from the agent's answer: `{ understanding, questions, steps, formatted, raw }`.
 * `formatted` is false when no steps were found: then `raw` keeps the answer as it was.
 */
export function parseTaskPlan(answer) {
  const text = String(answer ?? "").replace(/\r\n?/gu, "\n");
  const sections = { understanding: [], questions: [], plan: [], results: [] };
  let current = null;
  for (const line of text.split("\n")) {
    const heading = headingOf(line);
    if (heading !== null) {
      current = heading.section;
      if (heading.rest) sections[current].push(heading.rest);
      continue;
    }
    if (current !== null) sections[current].push(line);
  }
  const steps = items(sections.plan).slice(0, LIMITS.steps).map((step) => clip(step, LIMITS.step));
  const listed = items(sections.questions);
  const rest = sections.questions.join("\n").trim();
  const questions = (listed.length > 0 ? listed : rest ? [rest] : [])
    .filter((question) => !NONE.has(question.toLowerCase().replace(/[.!]+$/u, "").trim()))
    .slice(0, LIMITS.questions).map((question) => clip(question, LIMITS.question));
  const formatted = steps.length > 0;
  return { understanding: clip(sections.understanding.join("\n"), LIMITS.understanding), questions, steps, formatted,
    raw: formatted ? null : clip(text, LIMITS.raw) };
}

/**
 * The results the agent listed at the end of its work, under "## Results": `{ listed, items }`, each
 * item `{ path, note }` from "path - what it is". "None" lists no file; without the heading nothing
 * is listed. A path in backticks, quotes, bold or a Markdown link is taken plain.
 */
export function parseTaskResults(answer) {
  const lines = [];
  let inside = false;
  let listed = false;
  for (const line of String(answer ?? "").replace(/\r\n?/gu, "\n").split("\n")) {
    const heading = headingOf(line);
    if (heading !== null) {
      inside = heading.section === "results";
      listed ||= inside;
      if (inside && heading.rest) lines.push(heading.rest);
      continue;
    }
    if (inside) lines.push(line);
  }
  const plain = (value) => value.trim().replace(/^\[([^\]]*)\]\(([^)]+)\)$/u, "$2").replace(/^\*\*(.+)\*\*$/u, "$1")
    .replace(/^([`"'])(.+)\1$/u, "$2").trim();
  const found = items(lines)
    .filter((item) => !NONE.has(item.toLowerCase().replace(/[.!]+$/u, "").trim()))
    .slice(0, LIMITS.results)
    .map((item) => {
      const split = /\s+[\u2014\u2013]\s+|\s+-\s+|:\s+/u.exec(item);
      const head = split === null ? item : item.slice(0, split.index);
      const note = split === null ? "" : item.slice(split.index + split[0].length);
      return { path: clip(plain(head), LIMITS.resultPath), note: clip(note, LIMITS.resultNote) };
    })
    .filter((item) => item.path);
  return { listed, items: found };
}

// --- what the agent is told ------------------------------------------------------

const FORM = [
  "Answer in exactly this form, under these three English headings (the text under them may be in the person's language):",
  "## Understanding",
  "What the task is, in one to three sentences.",
  "## Questions",
  "What is unclear and needs the person's answer, one per line starting with \"- \"; \"None\" if nothing is unclear.",
  "## Plan",
  // The Plan tab shows the steps' names as a short list and the whole plan on request (the owner's check of 01.11).
  "The steps you will take, numbered \"1.\", \"2.\", ..., one line each: first the step's short name (two to six"
    + " words), then \" - \" and what exactly you will do in it.",
  "Do not write the plan to a file: no plan file is needed, and the folder of your settings is closed to agents.",
  "If you have a tool to present a plan for approval (ExitPlanMode), give it the same text; then end your turn.",
];

function answerLines(questions, answers) {
  const lines = [];
  (questions ?? []).forEach((question, index) => {
    const answer = answers?.[index] ?? "";
    if (answer.trim()) lines.push(`${index + 1}. ${question}\n   Answer: ${answer.trim()}`);
  });
  return lines;
}

/** What the agent gets for a planning turn of `task` (the first plan or a revision asked for). */
export function planningPrompt(task) {
  const remark = task.remarks?.at(-1) ?? null;
  const previous = task.revisions?.at(-1) ?? null;
  if (remark === null || previous === null || remark.afterRevision !== previous.revision) {
    return [
      `Task mode: plan first, change nothing (task ${task.taskId}).`,
      "This message is a task from the person. Do not change any file and do not run anything that changes something; do not start the work yet. Read what you need, then plan.",
      ...FORM,
      "The person approves the plan, or asks for changes, before any work starts.",
      "",
      "The task:",
      task.text,
    ].join("\n");
  }
  const answers = answerLines(previous.questions, remark.answers);
  return [
    `Task mode: the person asked to change the plan of task ${task.taskId} (revision ${previous.revision}). Still change nothing.`,
    "Their remarks:",
    remark.text,
    ...(answers.length > 0 ? ["Answers to your questions:", ...answers] : []),
    `Give the whole plan again as revision ${previous.revision + 1}, not only the changes.`,
    ...FORM,
  ].join("\n");
}

/** What the agent gets for the work turn of an approved plan. */
export function workPrompt(task) {
  const approved = task.approved;
  const revision = task.revisions.find((item) => item.revision === approved?.revision) ?? task.revisions.at(-1);
  const answers = answerLines(revision?.questions, approved?.answers);
  return [
    `Task mode: the person approved revision ${revision?.revision ?? 1} of the plan of task ${task.taskId}. Do the work now.`,
    "Follow the plan step by step. Keep a todo list with one item per plan step, in the same order, and mark each step done when it is.",
    ...(answers.length > 0 ? ["Answers to your questions:", ...answers] : []),
    "The approved plan:",
    ...(revision?.steps ?? []).map((step, index) => `${index + 1}. ${step}`),
    "When you are done, say briefly what was done, step by step. Then list the task's results under the heading"
      + " \"## Results\": each file you created or changed for the task, one per line, \"- path - what it is\", the path"
      + " relative to the project folder; \"None\" if the task left no file. They become your artifacts.",
    "",
    "The task:",
    task.text,
  ].join("\n");
}

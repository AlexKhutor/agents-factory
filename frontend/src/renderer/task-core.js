"use strict";

// Pure logic of an agent's tasks from its chat (the backend's agent-tasks.mjs): which
// task the Plan tab shows, what changed between two revisions of a plan, how far
// the work is, and the words for a task's stage. No DOM and no backend, so every
// rule is checked by tests without a window. The task board (roadmap track M)
// shows the same records and uses the same words.

(function (root, factory) {
  const node = typeof module === "object" && module !== null && module.exports;
  const api = factory(node ? require("./i18n-core.js") : root);
  if (node) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis === "undefined" ? this : globalThis, function (i18n) {
  const { tx } = i18n;
  const OPEN_TASK_STAGES = Object.freeze(["planning", "awaiting-approval", "in-progress"]);

  /** Whether a task is still open: planned, waiting for the person or worked on. */
  const isOpenTask = (task) => OPEN_TASK_STAGES.includes(task?.stage);

  /** The task the Plan tab shows: the agent's open one, else its latest. Tasks come newest first. */
  function currentTask(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    return list.find(isOpenTask) ?? list[0] ?? null;
  }

  /**
   * The steps of a plan against the revision before it, in order: each one kept,
   * added or removed (the longest common run of equal steps stays; the rest changed).
   */
  function stepDiff(previous, current) {
    const before = Array.isArray(previous) ? previous : [];
    const after = Array.isArray(current) ? current : [];
    const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const table = Array.from({ length: before.length + 1 }, () => new Array(after.length + 1).fill(0));
    for (let i = before.length - 1; i >= 0; i -= 1) {
      for (let j = after.length - 1; j >= 0; j -= 1) {
        table[i][j] = same(before[i], after[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const steps = [];
    let i = 0;
    let j = 0;
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && same(before[i], after[j])) {
        steps.push({ text: after[j], change: "same" });
        i += 1; j += 1;
      } else if (j < after.length && (i >= before.length || table[i][j + 1] >= table[i + 1][j])) {
        steps.push({ text: after[j], change: "added" });
        j += 1;
      } else {
        steps.push({ text: before[i], change: "removed" });
        i += 1;
      }
    }
    return steps;
  }

  /** How far the work on an approved plan is: { done, total, current } (current: the 1-based step, or null). */
  function stepProgress(task) {
    const steps = Array.isArray(task?.steps) ? task.steps : [];
    const done = steps.filter((step) => step.status === "done").length;
    const index = steps.findIndex((step) => step.status !== "done");
    return { done, total: steps.length, current: index === -1 ? null : index + 1 };
  }

  /** A step's name in the short list is at most this long. */
  const STEP_NAME_MAX = 80;

  /**
   * A plan step as the short list and the whole plan show it (the owner's check of 01.11): the
   * agent writes "a short name — what exactly", the short list shows the name. A step without
   * a name is its own name when short; a long one is cut at a word, its whole text the detail.
   * Returns { name, detail, named }.
   */
  function stepParts(text) {
    const value = String(text ?? "").trim();
    const bare = (part) => part.replace(/^\*\*(.+)\*\*$/u, "$1").trim();
    const split = /\s+[\u2014\u2013]\s+|\s+-\s+|:\s+/u.exec(value);
    if (split !== null && split.index > 0 && split.index <= STEP_NAME_MAX) {
      const detail = value.slice(split.index + split[0].length).trim();
      if (detail) return { name: bare(value.slice(0, split.index)), detail, named: true };
    }
    if (value.length <= STEP_NAME_MAX) return { name: value, detail: "", named: false };
    const cut = value.lastIndexOf(" ", STEP_NAME_MAX - 1);
    return { name: `${value.slice(0, cut > 20 ? cut : STEP_NAME_MAX - 1).trim()}\u2026`, detail: value, named: false };
  }

  /** A task's stage in the window's words; a stopped turn is said first. */
  function taskStageWords(task) {
    if (isOpenTask(task) && task.stopped === "failed") return tx("The agent's turn failed: waiting for you");
    if (isOpenTask(task) && task.stopped === "interrupted") return tx("The agent's turn was stopped: waiting for you");
    switch (task?.stage) {
      case "planning": return tx("The agent is preparing the plan");
      case "awaiting-approval": return tx("The plan is waiting for your approval");
      case "in-progress": {
        const { current, total } = stepProgress(task);
        return current === null ? tx("In progress") : tx("In progress: step {current} of {total}", { current, total });
      }
      case "done": return tx("Done");
      case "cancelled": return tx("Cancelled");
      default: return tx("Unknown stage");
    }
  }

  /** The message the chat shows when the person approves a revision (the agent gets the plan with it). */
  const approvalMessage = (revision) => tx("Plan approved (revision {revision}). Go ahead.", { revision });
  /** The remark that asks an agent to answer again in the plan's form. */
  const formRemark = () => tx("Please answer in the plan's form: Understanding, Questions, Plan with numbered steps.");

  return { OPEN_TASK_STAGES, isOpenTask, currentTask, stepDiff, stepParts, stepProgress, taskStageWords, approvalMessage,
    formRemark };
}));

// Which finished turn of each agent the person has already seen.
//
// A turn that ended while nobody looked at the chat is attention: the agent
// answered and waits for the person, as an unread message in Codex or Claude
// Code. The host keeps, per environment, the last operation of each agent the
// person saw; a newer finished operation is "unread" until the chat of that
// agent is opened. An agent seen for the first time is taken as read - starting
// Atlas must not flood the list with old answers.
//
// Deliberately a small file of its own, like ui-state.json: losing it only
// marks the current answers as read.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveOver } from "./move-over.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_AGENTS = 4096;
// The operation states after which the agent waits for the person.
const FINISHED = Object.freeze({ completed: "completed", interrupted: "interrupted", failed: "failed" });

function sanitize(value) {
  const result = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [environment, agents] of Object.entries(value.environments ?? {})) {
    if (typeof environment !== "string" || environment.length > 200) continue;
    if (agents === null || typeof agents !== "object" || Array.isArray(agents)) continue;
    const kept = {};
    for (const [agentId, operationId] of Object.entries(agents).slice(0, MAX_AGENTS)) {
      if (ID.test(agentId) && (operationId === "" || (typeof operationId === "string" && ID.test(operationId)))) {
        kept[agentId] = operationId;
      }
    }
    result[environment] = kept;
  }
  return result;
}

/**
 * The question an answer ends with, or null: one of its last four non-empty
 * lines, without Markdown marks, ends with a question mark ("Is this a mechanism in
 * ML/AI?" followed by "Clarify, and I will create a task! 👍" counts). The latest such
 * line is returned, clipped for the attention list.
 */
export function questionOf(text) {
  const lines = String(text ?? "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  for (const line of lines.slice(-4).reverse()) {
    const plain = line.replace(/^[-*>#\d.)\s]+/u, "").replace(/[*_`~\s]+$/u, "").replace(/[*_`]/gu, "");
    if (/[?？]["»”'’)\]]*$/u.test(plain)) return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain;
  }
  return null;
}

function sanitizeAnswers(value) {
  const result = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [environment, agents] of Object.entries(value)) {
    if (typeof environment !== "string" || environment.length > 200 || agents === null || typeof agents !== "object") continue;
    const kept = {};
    for (const [agentId, entry] of Object.entries(agents).slice(0, MAX_AGENTS)) {
      if (!ID.test(agentId) || !ID.test(entry?.operationId ?? "")) continue;
      kept[agentId] = { operationId: entry.operationId,
        question: typeof entry.question === "string" ? entry.question.slice(0, 200) : null,
        ...(Number.isSafeInteger(entry.refused) && entry.refused >= 0 ? { refused: Math.min(entry.refused, 99) } : {}) };
    }
    result[environment] = kept;
  }
  return result;
}

export function createTurnSeenStore({ directory, environment }) {
  const file = path.join(directory, "seen-turns.json");
  let environments = null;
  // Per environment and agent: the operation whose answer was read, and the
  // question it ended with (null: no question).
  let answers = null;
  let writing = Promise.resolve();

  async function load() {
    if (environments !== null) return;
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      environments = sanitize(stored);
      answers = sanitizeAnswers(stored?.answers);
    } catch {
      environments = {};
      answers = {};
    }
  }

  function save() {
    const body = JSON.stringify({ schemaVersion: 1, environments, answers });
    writing = writing.then(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, body, "utf8");
        await moveOver(temporary, file);
      } catch {
        await rm(temporary, { force: true });
      }
    });
    return writing;
  }

  const seenOf = () => {
    environments[environment] ??= {};
    return environments[environment];
  };

  return {
    /**
     * Attention items for finished turns the person has not seen, for the
     * agents of `projection`. Agents met for the first time are recorded as
     * read.
     */
    async itemsFor(projection) {
      await load();
      const seen = seenOf();
      const items = [];
      let changed = false;
      for (const project of projection?.projects ?? []) {
        for (const quarter of project.quarters ?? []) {
          for (const agent of quarter.agents ?? []) {
            const last = agent.lastOperation ?? null;
            const lastId = typeof last?.operationId === "string" && ID.test(last.operationId) ? last.operationId : "";
            if (!(agent.agentId in seen)) {
              seen[agent.agentId] = lastId;
              changed = true;
              continue;
            }
            const finished = FINISHED[last?.state];
            if (lastId === "" || finished === undefined || agent.currentOperationId) continue;
            if (seen[agent.agentId] === lastId) continue;
            items.push({
              kind: "turn-finished", agentId: agent.agentId, projectId: agent.projectId,
              quarterId: agent.quarterId, operationId: lastId, outcome: finished,
            });
          }
        }
      }
      if (changed) await save();
      return items;
    },

    /**
     * Agents whose last finished turn ended with a question to the person, in
     * words rather than through the question tool ("Which option do you
     * prefer?"). That is attention until the person answers - a new message
     * replaces the operation - not only until the chat is opened. The answer of
     * each finished turn is read once (`lastAnswerOf(agentId)` -> text, or
     * { text, refused }, or null) and remembered; at most `budget` agents are
     * read per call. A turn in which an action of the agent was refused (by the
     * person or by the desk's rules) is attention too, until the next message.
     */
    async questionsFor(projection, lastAnswerOf, { budget = 3 } = {}) {
      await load();
      answers[environment] ??= {};
      const known = answers[environment];
      const items = [];
      let reads = 0;
      let changed = false;
      for (const project of projection?.projects ?? []) {
        for (const quarter of project.quarters ?? []) {
          for (const agent of quarter.agents ?? []) {
            const last = agent.lastOperation ?? null;
            if (last?.state !== "completed" || agent.currentOperationId || !ID.test(last.operationId ?? "")) continue;
            let entry = known[agent.agentId];
            // An answer remembered before refusals were counted is read again.
            if (entry?.operationId !== last.operationId || entry.refused === undefined) {
              if (reads >= budget) continue;
              reads += 1;
              let answer = null;
              try { answer = await lastAnswerOf(agent.agentId); } catch { answer = null; }
              const text = typeof answer === "string" ? answer : answer?.text;
              if (typeof text !== "string") continue;
              const refused = Number.isSafeInteger(answer?.refused) && answer.refused > 0 ? Math.min(answer.refused, 99) : 0;
              entry = { operationId: last.operationId, question: questionOf(text), refused };
              known[agent.agentId] = entry;
              changed = true;
            }
            const where = { agentId: agent.agentId, projectId: agent.projectId, quarterId: agent.quarterId,
              operationId: last.operationId };
            if (entry.refused > 0) items.push({ kind: "refused", ...where, count: entry.refused });
            if (entry.question === null) continue;
            items.push({ kind: "asks-you", ...where, question: entry.question });
          }
        }
      }
      if (changed) await save();
      return items;
    },

    /** The person opened the chat: this operation of the agent is read. */
    async markSeen(agentId, operationId) {
      if (!ID.test(agentId ?? "") || !(operationId === "" || ID.test(operationId ?? ""))) {
        return { ok: false, error: { code: "invalid_input" } };
      }
      await load();
      const seen = seenOf();
      if (seen[agentId] !== operationId) {
        seen[agentId] = operationId;
        await save();
      }
      return { ok: true, data: { agentId, operationId } };
    },
  };
}

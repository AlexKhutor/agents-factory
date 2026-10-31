// A finished turn nobody has seen is attention until the chat of that agent is
// opened; an agent met for the first time is taken as read, and environments
// never share their marks.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTurnSeenStore, questionOf } from "../src/host/turn-seen.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const projectionOf = (agents) => ({
  projects: [{ projectId: "p", quarters: [{ quarterId: "q", agents: agents.map((agent) => ({
    projectId: "p", quarterId: "q", currentOperationId: null, ...agent,
  })) }] }],
});

const folder = await mkdtemp(path.join(os.tmpdir(), "atlas-turn-seen-"));
try {
  const store = createTurnSeenStore({ directory: folder, environment: "live:a" });
  const first = await store.itemsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-1", state: "completed" } },
    { agentId: "a2", lastOperation: null },
  ]));
  check("agent-seen-for-the-first-time-is-read", first.length === 0, first);

  const later = await store.itemsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-2", state: "completed" } },
    { agentId: "a2", lastOperation: { operationId: "op-3", state: "interrupted" } },
  ]));
  check("new-finished-turn-is-attention",
    later.length === 2 && later[0].kind === "turn-finished" && later[0].operationId === "op-2"
      && later[1].outcome === "interrupted",
    later);

  const running = await store.itemsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-4", state: "started" }, currentOperationId: "op-4" },
  ]));
  check("running-turn-is-not-attention", running.length === 0, running);

  await store.markSeen("a2", "op-3");
  const reopened = createTurnSeenStore({ directory: folder, environment: "live:a" });
  const afterSeen = await reopened.itemsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-2", state: "completed" } },
    { agentId: "a2", lastOperation: { operationId: "op-3", state: "interrupted" } },
  ]));
  check("opened-chat-clears-mark-and-it-persists",
    afterSeen.length === 1 && afterSeen[0].agentId === "a1", afterSeen);

  const other = createTurnSeenStore({ directory: folder, environment: "fixture" });
  const fresh = await other.itemsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-2", state: "completed" } },
  ]));
  check("environments-do-not-share-marks", fresh.length === 0, fresh);

  const refused = await store.markSeen("../a1", "op-2");
  check("foreign-identifier-refused", refused.ok === false, refused);

  // An answer that ends with a question to the person waits for the person's
  // reply - opening the chat does not clear it, a new message does.
  check("question-at-end-of-answer-recognized",
    questionOf("Options:\n1. A\n2. B\n\n**Which option interests you, or something else?**")
      === "Which option interests you, or something else?"
      && questionOf("Done. File created.") === null
      && questionOf("Why so? Because it is faster.") === null
      && questionOf("Clarify:\n- Is it a mechanism in ML/AI?\n- Is it part of the system?\n\nClarify, and I will create a task! 👍")
        === "Is it part of the system?"
      && questionOf("Was there a question?\na\nb\nc\nd") === null,
    null);
  const answers = { a1: "Done.\nWhich option interests you?", a2: "Done." };
  let reads = 0;
  const lastAnswerOf = async (agentId) => { reads += 1; return answers[agentId] ?? null; };
  const asking = await store.questionsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-7", state: "completed" } },
    { agentId: "a2", lastOperation: { operationId: "op-8", state: "completed" } },
  ]), lastAnswerOf);
  const again = await store.questionsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-7", state: "completed" } },
    { agentId: "a2", lastOperation: { operationId: "op-8", state: "completed" } },
  ]), lastAnswerOf);
  const answered = await store.questionsFor(projectionOf([
    { agentId: "a1", lastOperation: { operationId: "op-9", state: "started" }, currentOperationId: "op-9" },
  ]), lastAnswerOf);
  check("question-waits-for-answer-and-is-read-once",
    asking.length === 1 && asking[0].kind === "asks-you" && asking[0].agentId === "a1"
      && asking[0].question === "Which option interests you?"
      && again.length === 1 && reads === 2 && answered.length === 0,
    { asking, again, reads, answered });

  // An action refused in the last turn (by the person or the desk's rules) is
  // attention until the next message, with or without a question.
  const turns = { r1: { text: "The command was refused. Tell me what to do.", refused: 1 },
    r2: { text: "Refused. Try again?", refused: 2 }, r3: { text: "Done.", refused: 0 } };
  const refusedItems = await store.questionsFor(projectionOf([
    { agentId: "r1", lastOperation: { operationId: "op-21", state: "completed" } },
    { agentId: "r2", lastOperation: { operationId: "op-22", state: "completed" } },
    { agentId: "r3", lastOperation: { operationId: "op-23", state: "completed" } },
  ]), async (agentId) => turns[agentId] ?? null);
  const kinds = refusedItems.map((item) => `${item.agentId}:${item.kind}${item.count ? `:${item.count}` : ""}`).sort();
  check("refused-action-is-attention",
    kinds.join(",") === "r1:refused:1,r2:asks-you,r2:refused:2", kinds);
} finally {
  await rm(folder, { recursive: true, force: true });
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "turn-seen",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

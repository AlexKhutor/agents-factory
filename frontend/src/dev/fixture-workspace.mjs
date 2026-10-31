// DEVELOPMENT. The agents' workspace in the fixture: the bound conversation, the files
// of the project, registered artifacts.
//
// Everything is synthetic and marked as a fixture. The shapes follow the schemas of Kit
// v0.15.0 exactly (tools/test-agent-workspace.mjs checks them); not one line here
// came from a provider.

import { sha256 } from "./fixture-world.mjs";

const CONTRACT_VERSION = "v0.1.0";
export const FIXTURE_REVISION = "2026-09-18T09:30:00.000Z";

export const conversationIdOf = (agentId) => `conversation:${sha256(`fixture-conversation:${agentId}`)}`;

const PROVIDER = Object.freeze({
  adapterId: "fixture", adapterFamily: "execution-provider", adapterVersion: "v0.1.0",
  sourceId: "fixture", runtimeInstanceId: "fixture-runtime",
});

function ref(kind, externalId) {
  return {
    schemaVersion: 1, kind, relationship: "fixture",
    authority: { schemaVersion: 1, authorityType: "provider", sourceId: "fixture", externalId, contractVersion: CONTRACT_VERSION },
  };
}

const at = (minute) => new Date(Date.UTC(2026, 8, 18, 9, minute, 0)).toISOString();

function item(agentId, turn, index, contentClass, role, text, minute) {
  const base = {
    schemaVersion: 1, contractVersion: CONTRACT_VERSION, provider: { ...PROVIDER },
    itemRef: ref("provider-item", `${agentId}-${turn}-${index}`), turnRef: ref("provider-turn", `${agentId}-${turn}`),
    observedAtUtc: at(minute),
  };
  if (text === null) {
    return { ...base, contentClass: "omitted", role: null, visibility: "omitted", text: null,
      contentSha256: null, omissionReason: role };
  }
  return { ...base, contentClass, role, visibility: "user-visible", text, contentSha256: sha256(text), omissionReason: null };
}

// The conversation of agent data-ingest-1 - three turns, with a command, its result and omitted
// reasoning. The other agents have one short turn.
function turnsFor(agentId) {
  if (agentId === "data-ingest-1") {
    return [
      { turn: "t1", state: "completed", minute: 1, items: [
        ["user-message", "user", "Check that the build passes, and describe what is broken."],
        ["tool-summary", "tool", "npm test -- scheduler: 42 passing, 1 failing (queue drains twice under load)"],
        ["assistant-message", "assistant", "One test fails: under load the queue is drained twice. Looks like a race in drain()."],
      ] },
      { turn: "t2", state: "completed", minute: 9, items: [
        ["user-message", "user", "Fix the lock and run the tests again."],
        [null, "hidden_reasoning", null],
        ["interaction-summary", "assistant",
          "You answered the agent's questions:\n· Where should the lock be released: in drain() or in the scheduler?\n  → In drain()"],
        ["change-summary", "tool", "src/queue/drain.mjs: the lock is released after the queue is marked empty"],
        ["assistant-message", "assistant", "Fixed the order. The report is in reports/drain-analysis.md."],
      ] },
      { turn: "t3", state: "active", minute: 15, items: [
        ["interaction-summary", "assistant", "Asking for permission to run npm test."],
      ] },
    ];
  }
  return [
    { turn: "t1", state: "completed", minute: 2, items: [
      ["user-message", "user", "Fixture: start by reading the quarter memory."],
      ["assistant-message", "assistant", `Fixture: ${agentId} has read the memory and is waiting for a task.`],
    ] },
  ];
}

/**
 * One page of the conversation: turns from offset to offset+limit and their content.
 * `revision` changes when something is sent to the agent: an old cursor then
 * becomes stale.
 */
export function conversationPage(agent, { offset, limit, revision }) {
  const all = turnsFor(agent.agentId);
  const chosen = all.slice(offset, offset + limit);
  const turns = chosen.map((turn) => ({
    turnRef: ref("provider-turn", `${agent.agentId}-${turn.turn}`), threadRef: ref("provider-thread", agent.agentId),
    state: turn.state, startedAtUtc: at(turn.minute), completedAtUtc: turn.state === "completed" ? at(turn.minute + 3) : null,
    itemCount: turn.items.length,
  }));
  const content = chosen.flatMap((turn) => turn.items.map(([contentClass, role, text], index) => (
    item(agent.agentId, turn.turn, index, contentClass, role, text, turn.minute + index))));
  const omitted = content.some((entry) => entry.visibility === "omitted");
  const next = offset + limit < all.length ? offset + limit : null;
  return {
    schemaVersion: 1, contractVersion: CONTRACT_VERSION, agentId: agent.agentId,
    conversationId: conversationIdOf(agent.agentId), mode: "provider-read", revision,
    nextCursor: next === null ? null : `fx-conv:${agent.agentId}:${next}:${limit}:${revision}`,
    observedAtUtc: new Date().toISOString(),
    thread: {
      threadRef: ref("provider-thread", agent.agentId), parentThreadRef: null,
      activeTurnRef: all.some((turn) => turn.state === "active")
        ? ref("provider-turn", `${agent.agentId}-${all.find((turn) => turn.state === "active").turn}`) : null,
      title: `Fixture: ${agent.agentId}`, state: agent.currentOperationId === null ? "idle" : "active",
      archived: false, updatedAtUtc: revision,
    },
    turns,
    content,
    completeness: omitted
      ? { status: "partial", reasonCode: "hidden_reasoning_omitted" }
      : { status: "complete", reasonCode: null },
  };
}

// --- files of project data-pipeline ----------------------------------------------------

const TRACE = Array.from({ length: 2400 }, (_, index) => (
  `2026-09-18T09:${String(10 + (index % 50)).padStart(2, "0")}:00Z drain worker=${index % 4} queue=${index % 17} state=${index % 9 === 0 ? "empty" : "busy"}\n`)).join("");

const DRAIN_NOW = `export async function drain(queue, lock) {
  await lock.acquire();
  try {
    while (queue.length > 0) await queue.shift()();
    queue.markEmpty();
  } finally {
    lock.release();
  }
}
`;
const DRAIN_REGISTERED = `export async function drain(queue, lock) {
  await lock.acquire();
  while (queue.length > 0) await queue.shift()();
  lock.release();
  queue.markEmpty();
}
`;
const REPORT = `# Review of drain() — fixture

Under load the queue was emptied twice: the lock was released before
the queue was marked empty. The order is fixed in src/queue/drain.mjs.
`;

/** Path -> content (a string) or the size of a file that cannot be read. */
export const PROJECT_FILES = Object.freeze({
  "data-pipeline": Object.freeze({
    "README.md": "# Data pipeline — fixture\n\nThe project folder, bound in the fixture.\n",
    "src/queue/drain.mjs": DRAIN_NOW,
    "reports/drain-analysis.md": REPORT,
    "logs/drain-trace.log": TRACE,
    "data/export.bin": { sizeBytes: 2 * 1024 * 1024 },
  }),
});

/** Registered artifacts: a link to a path with its hash at the time of registration. */
export const ARTIFACTS = Object.freeze({
  "data-ingest-1": Object.freeze([
    { artifactId: "drain-report", path: "reports/drain-analysis.md",
      sha256: sha256(Buffer.from(REPORT, "utf8")), sizeBytes: Buffer.byteLength(REPORT, "utf8"),
      registeredAtUtc: "2026-09-18T09:14:00.000Z" },
    // Registered before the edit: the file has changed since, and the hash no longer matches.
    { artifactId: "drain-patch", path: "src/queue/drain.mjs",
      sha256: sha256(Buffer.from(DRAIN_REGISTERED, "utf8")), sizeBytes: Buffer.byteLength(DRAIN_REGISTERED, "utf8"),
      registeredAtUtc: "2026-09-18T09:12:00.000Z" },
  ]),
});

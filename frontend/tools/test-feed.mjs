// The conversation feed and the agent's context line.
//
// The contract does not fix the order of archive pages. The feed must not
// depend on it: the same entries, arriving in any order, must give one and
// the same feed — each entry once, in its latest state, in the order
// of first appearance.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorldView } from "../src/host/memory-view.mjs";
import { createSession } from "../src/host/session.mjs";

const require = createRequire(import.meta.url);
const core = require("../src/renderer/feed-core.js");
const i18n = require("../src/renderer/i18n-core.js");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
i18n.setLocale("en", JSON.parse(readFileSync(path.join(PROJECT_ROOT, "locales", "en.json"), "utf8")));

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const entry = (recordId, firstSequence, sequence, extra = {}) => ({
  firstSequence, sequence,
  record: { recordId, kind: "message", role: "assistant", state: "completed", text: recordId,
    providerTurnId: "t1", occurredAtUtc: null, omissions: [], ...extra },
});
const ids = (records) => core.orderedFeedEntries(records).map((item) => item.record.recordId);

// --- the order does not depend on the page order ---------------------------------

{
  const all = [entry("a", 1, 1), entry("b", 2, 2), entry("c", 3, 5), entry("d", 4, 4)];
  const forward = core.mergeFeedEntries(new Map(), all);
  const backward = core.mergeFeedEntries(new Map(), [...all].reverse());
  const split = core.mergeFeedEntries(core.mergeFeedEntries(new Map(), all.slice(2)), all.slice(0, 2));
  check("feed-does-not-depend-on-page-order",
    JSON.stringify(ids(forward)) === JSON.stringify(["a", "b", "c", "d"])
      && JSON.stringify(ids(backward)) === JSON.stringify(ids(forward))
      && JSON.stringify(ids(split)) === JSON.stringify(ids(forward)),
    { forward: ids(forward), backward: ids(backward), split: ids(split) });
}

// --- one entry is one line, in its latest state ------------------------------------

{
  const started = entry("run", 4, 4, { kind: "activity", role: "tool", state: "started" });
  const finished = entry("run", 4, 6, { kind: "activity", role: "tool", state: "completed" });
  const records = core.mergeFeedEntries(new Map(), [entry("x", 3, 3), started, entry("y", 5, 5), finished]);
  const ordered = core.orderedFeedEntries(records);
  const run = ordered.filter((item) => item.record.recordId === "run");
  check("entry-shown-once-in-latest-state",
    run.length === 1 && run[0].record.state === "completed" && run[0].sequence === 6
      && JSON.stringify(ordered.map((item) => item.record.recordId)) === JSON.stringify(["x", "run", "y"]),
    ordered.map((item) => `${item.record.recordId}:${item.sequence}:${item.record.state}`));

  const stale = core.mergeFeedEntries(new Map(), [finished, started]);
  check("stale-update-does-not-overwrite-newer",
    stale.get("run").record.state === "completed", stale.get("run"));
}

// --- turns -----------------------------------------------------------------------------

{
  const entries = [
    entry("gap", 1, 1, { kind: "omission", providerTurnId: null }),
    entry("q1", 2, 2, { providerTurnId: "t1" }),
    entry("a1", 3, 3, { providerTurnId: "t1" }),
    entry("q2", 4, 4, { providerTurnId: "t2" }),
    entry("late", 5, 5, { providerTurnId: "t1" }),
  ];
  const groups = core.groupFeedByTurn(entries);
  check("entries-grouped-by-turn-in-order-of-appearance",
    groups.length === 4
      && groups[0].turn === null && groups[0].number === null
      && groups[1].turn === "t1" && groups[1].number === 1 && groups[1].entries.length === 2
      && groups[2].turn === "t2" && groups[2].number === 2
      && groups[3].turn === "t1" && groups[3].number === 3,
    groups.map((group) => `${group.turn}#${group.number}:${group.entries.length}`));
}

// --- the agent's last message -------------------------------------------------------

{
  const entries = [
    entry("said", 1, 1, { text: "Done." }),
    entry("tool", 2, 2, { kind: "activity", role: "tool", text: "npm test" }),
    entry("empty", 3, 3, { text: null }),
  ];
  const last = core.lastAgentMessage(entries);
  check("last-message-only-in-the-agents-own-words",
    last !== null && last.text === "Done." && core.lastAgentMessage([entries[1]]) === null, last);
}

// --- context line ----------------------------------------------------------------------

{
  const base = {
    state: "active", deliveryState: "delivered", problemCode: null,
    currentOperationId: null, lastOperation: null,
  };
  const line = (patch, questions = 0) => core.agentContextLine({ ...base, ...patch }, questions).text;
  const expectations = [
    [line({ state: "archived", problemCode: "x" }, 3), "archived"],
    [line({ problemCode: "memory_provider_unavailable" }, 3), "failed"],
    [line({ deliveryState: "uncertain" }, 3), "uncertain"],
    [line({ currentOperationId: "op" }, 2), "? 2 questions"],
    [line({ currentOperationId: "op" }), "turn running"],
    [line({ lastOperation: { operationId: "op", state: "interrupted" } }), "turn interrupted"],
    [line({}), "no turns yet"],
  ];
  check("context-line-by-importance-to-the-person",
    expectations.every(([actual, expected]) => actual === expected), expectations);

  // Plural forms come from the locale: English in the code, Russian from locales/ru.json.
  const counts = [1, 2, 5, 11, 21, 22, 25];
  const english = counts.map((count) => core.questionsCount(count));
  i18n.setLocale("ru", JSON.parse(readFileSync(path.join(PROJECT_ROOT, "locales", "ru.json"), "utf8")));
  const russian = counts.map((count) => core.questionsCount(count));
  i18n.setLocale("en", JSON.parse(readFileSync(path.join(PROJECT_ROOT, "locales", "en.json"), "utf8")));
  check("questions-plural-forms",
    JSON.stringify(english) === JSON.stringify(
      ["1 question", "2 questions", "5 questions", "11 questions", "21 questions", "22 questions", "25 questions"])
    && JSON.stringify(russian) === JSON.stringify(
      ["1 вопрос", "2 вопроса", "5 вопросов", "11 вопросов", "21 вопрос", "22 вопроса", "25 вопросов"]),
    { english, russian });
}

// --- sending: the agent state together with the declared operation ----------------
//
// A declared operation is not yet permission to send to this agent: for an archived agent
// the button must not be available, and the handler must not call the client, even if
// it is called around the button.

{
  const available = { operationId: "mutation.memory.agent.send", status: "available", reasonCode: "available" };
  const agent = (state) => ({ agentId: "a1", state });
  const attempt = async (subject, operation) => {
    const calls = [];
    const outcome = await core.guardedSend({
      agent: subject, operation,
      send: async (target) => { calls.push(target.agentId); return { ok: true }; },
    });
    return { outcome, calls };
  };

  const archived = core.sendAvailability(agent("archived"), available);
  check("send-button-disabled-for-archived-agent",
    archived.allowed === false && typeof archived.reason === "string" && archived.reason.includes("archive"),
    archived);
  const archivedAttempt = await attempt(agent("archived"), available);
  check("handler-does-not-call-client-for-archived-agent",
    archivedAttempt.calls.length === 0 && archivedAttempt.outcome.sent === false
      && archivedAttempt.outcome.reason === archived.reason,
    archivedAttempt);

  const notYet = [null, undefined, { agentId: "a1" }, agent(null), agent("paused"),
    agent("creating"), agent("closing"), agent("failed"), agent("uncertain")];
  const notYetResults = await Promise.all(notYet.map(async (subject) => ({
    verdict: core.sendAvailability(subject, available), ...(await attempt(subject, available)),
  })));
  check("unknown-or-unread-state-does-not-allow",
    notYetResults.every((item) => item.verdict.allowed === false && item.verdict.reason
      && item.calls.length === 0 && item.outcome.sent === false),
    notYetResults);

  const offered = [null, { ...available, status: "unavailable", reasonCode: "operation_not_exposed" }];
  const offeredResults = await Promise.all(offered.map(async (operation) => ({
    verdict: core.sendAvailability(agent("active"), operation), ...(await attempt(agent("active"), operation)),
  })));
  check("active-without-declared-operation-does-not-allow",
    offeredResults.every((item) => item.verdict.allowed === false && item.calls.length === 0)
      && offeredResults[1].verdict.reason.includes("operation_not_exposed"),
    offeredResults);

  const active = core.sendAvailability(agent("active"), available);
  const activeAttempt = await attempt(agent("active"), available);
  check("active-agent-send-allowed-and-calls-client-once",
    active.allowed === true && active.reason === null
      && activeAttempt.outcome.sent === true && JSON.stringify(activeAttempt.calls) === JSON.stringify(["a1"])
      && activeAttempt.outcome.response.ok === true,
    { active, activeAttempt });
}

{
  // The same on the fixture: the real operation availability and the real agent catalog.
  const session = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
  const operation = (await session.gateway.availability())
    .find((entry) => entry.operationId === "mutation.memory.agent.send") ?? null;
  const view = await buildWorldView(session.gateway, { desktop: session.kit.desktop, withInteractions: false });
  const agents = view.projection.projects.flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents));
  const byState = (state) => agents.find((item) => item.state === state) ?? null;
  const archivedAgent = byState("archived");
  const activeAgent = byState("active");
  const calls = [];
  const send = async (target) => { calls.push(target.agentId); return { ok: true }; };
  const archivedOutcome = await core.guardedSend({ agent: archivedAgent, operation, send });
  check("fixture-archived-refused-active-allowed",
    operation?.status === "available" && archivedAgent !== null && activeAgent !== null
      && core.sendAvailability(archivedAgent, operation).allowed === false
      && archivedOutcome.sent === false && calls.length === 0
      && core.sendAvailability(activeAgent, operation).allowed === true,
    { operation, archived: archivedAgent?.agentId, active: activeAgent?.agentId, calls });
}

// --- the fixture's real archive, read in reverse page order ------------------------

{
  const session = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
  const read = async (cursor) => (await session.gateway.run("query.memory.agent.archive",
    { agentId: "core-scheduler-1", cursor, limit: 50 })).result.output;
  const first = await read(null);
  const second = await read(first.nextCursor);
  const inOrder = core.mergeFeedEntries(core.mergeFeedEntries(new Map(), first.items), second.items);
  const reversed = core.mergeFeedEntries(core.mergeFeedEntries(new Map(), second.items), first.items);
  const groups = core.groupFeedByTurn(core.orderedFeedEntries(inOrder));
  check("fixture-archive-same-in-any-order",
    JSON.stringify(ids(inOrder)) === JSON.stringify(ids(reversed)) && inOrder.size === 11,
    { inOrder: ids(inOrder), reversed: ids(reversed) });
  check("fixture-archive-starts-with-honest-gap",
    groups[0].turn === null && groups[0].entries[0].record.omissions.includes("history_not_imported"),
    groups[0]);
}

// --- S1: opening the conversation, renewal versus restart, search in a file ----------

{
  // The binding decides the route before anything else is read: an archived or
  // unbound agent never reads events, and a live one keeps the head cursor
  // (events) before its snapshot (the conversation pages).
  const plan = core.chatOpenPlan;
  const live = plan({ liveReadAvailable: true, eventsAvailable: true, route: "live" });
  const liveNoEvents = plan({ liveReadAvailable: true, eventsAvailable: false, route: "live" });
  const archived = plan({ liveReadAvailable: true, eventsAvailable: true, route: "archive" });
  const unavailable = plan({ liveReadAvailable: true, eventsAvailable: true, route: "unavailable" });
  const notAdvertised = plan({ liveReadAvailable: false, eventsAvailable: true, route: null });
  check("binding-decides-route-events-only-for-live-branch",
    JSON.stringify(live) === JSON.stringify(["events-head", "conversation"])
      && JSON.stringify(liveNoEvents) === JSON.stringify(["conversation"])
      && JSON.stringify(archived) === JSON.stringify(["archive"])
      && JSON.stringify(unavailable) === JSON.stringify(["archive"])
      && JSON.stringify(notAdvertised) === JSON.stringify(["archive"]),
    { live, liveNoEvents, archived, unavailable, notAdvertised });
}

{
  // A renewed descriptor of the same gateway instance is not a restart: the
  // workspace stays open. A new instance or generation is a restart.
  const change = core.connectionChange;
  const before = { available: true, descriptorId: "d1", instanceId: "i1", generation: 15 };
  const renewed = change(before, { available: true, descriptorId: "d2", instanceId: "i1", generation: 15 });
  const restarted = change(before, { available: true, descriptorId: "d3", instanceId: "i2", generation: 16 });
  const same = change(before, { ...before });
  const lost = change(before, { available: false, error: { code: "gateway_unavailable" } });
  const first = change(null, before);
  check("connection-renewal-is-not-restart",
    renewed === "renewed" && restarted === "restarted" && same === "same" && lost === "lost" && first === "connected",
    { renewed, restarted, same, lost, first });
}

{
  const text = "alpha\nBeta beta\ngamma\n";
  const found = core.findInText(text, "beta");
  const none = core.findInText(text, "delta");
  const empty = core.findInText(text, "  ");
  const many = core.findInText("x".repeat(500), "x", { limit: 100 });
  check("search-in-open-file",
    found.count === 2 && found.matches[0].line === 2 && found.matches[1].index === 11 && !found.truncated
      && none.count === 0 && empty.count === 0 && many.count === 100 && many.truncated === true,
    { found, none, empty, many: { count: many.count, truncated: many.truncated } });
}

{
  // An unread world is not an empty one: the map header must not say "0".
  const unread = core.worldCountLine(null);
  const unavailable = core.worldCountLine({ status: "unavailable", projection: null });
  const ready = core.worldCountLine({ status: "ready", projection: { projects: [
    { quarters: [{ agents: [{}, {}] }] }, { quarters: [{ agents: [{}] }, { agents: [] }] },
  ] } });
  check("unread-world-is-not-zero-projects",
    unread === "world not read" && unavailable === "world not read" && ready === "2 projects · 3 agents",
    { unread, unavailable, ready });
}

{
  // The gateway's state in words, only from the host summary and the connection.
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const state = (runtime, connection) => core.gatewayState({ runtime, connection, now });
  const later = "2026-09-24T12:30:00.000Z";
  const earlier = "2026-09-24T11:30:00.000Z";
  const results = {
    ready: state({ lifecycle: "ready" }, { available: true, validUntilUtc: later }),
    expired: state({ lifecycle: "ready" }, { available: true, validUntilUtc: earlier }),
    uncertain: state({ lifecycle: "uncertain" }, { available: false, error: { reasonCode: "lifecycle_uncertain" } }),
    stale: state({ lifecycle: "ready" }, { available: false, error: { reasonCode: "instance_mismatch" } }),
    stopped: state({ lifecycle: "stopped" }, { available: false, error: { reasonCode: "lifecycle_stopped" } }),
    fixture: state({ lifecycle: "ready", health: "fixture" }, { available: true, validUntilUtc: later }),
    unknown: state(null, null),
  };
  check("gateway-state-honest",
    results.ready === "ready" && results.expired === "expired" && results.uncertain === "uncertain"
      && results.stale === "stale" && results.stopped === "stopped" && results.fixture === "ready"
      && results.unknown === "unknown", results);
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "feed",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

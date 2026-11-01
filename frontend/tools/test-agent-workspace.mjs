// Codex backend P1 on the desk: agent conversation, project files, artifacts,
// events, captured attention, the requested profile and the copy mode.
//
// Every case runs on a real boundary: the kit's own schema files (read through
// the accepted-delivery loader), the real kit client against the development
// fixture, the real read journal, or a scripted gateway where the fixture
// cannot produce the edge (a stale page, a mismatched binding). Nothing here
// talks to a live gateway or a provider.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_LIMITS, createAgentWorkspace } from "../src/host/agent-workspace.mjs";
import { createChannels, CHANNEL_NAMES } from "../src/host/ipc.mjs";
import { loadAcceptedKit } from "../src/host/kit.mjs";
import { buildWorldView } from "../src/host/memory-view.mjs";
import { EXPECTED_CAPABILITIES, READ_OPERATIONS } from "../src/host/operations.mjs";
import { createReadJournal, readFacts } from "../src/host/read-journal.mjs";
import { loadSchemaSet } from "../src/host/schema-check.mjs";
import { createSession } from "../src/host/session.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const feedCore = require("../src/renderer/feed-core.js");
const outcomeCore = require("../src/renderer/outcome-core.js");

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const NEW_READS = Object.freeze([
  "query.agent-conversation.resolve", "query.agent-conversation.read",
  "query.project-workspace.list", "query.project-workspace.read",
  "query.agent-artifacts.list", "query.agent-artifacts.read",
  "query.agent-events.read",
]);

const kit = await loadAcceptedKit({ applicationRoot: PROJECT_ROOT });
const schemas = await loadSchemaSet(kit);
// The kit's own DTO samples: schema-bound shapes, not a live conversation.
const samples = (await kit.loadAgentWorkspaceSamples()).createAgentWorkspaceFixture();

// --- the kit's schemas are the reference ------------------------------------------

{
  const r = samples.responses;
  const results = {
    binding: schemas.check("application-agent-conversation.v1.json", "binding", r["query.agent-conversation.resolve"]),
    fileRead: schemas.check("application-project-workspace.v1.json", "page", r["query.project-workspace.read"]),
    fileList: schemas.check("application-project-workspace.v1.json", "page", r["query.project-workspace.list"]),
    catalog: schemas.check("application-agent-artifacts.v1.json", "catalog", r["query.agent-artifacts.list"]),
    artifact: schemas.check("application-agent-artifacts.v1.json", "page", r["query.agent-artifacts.read"]),
    events: schemas.check("application-agent-events.v1.json", "page", r["query.agent-events.read"]),
  };
  check("kit-examples-pass-its-own-schemas", Object.values(results).every((item) => item.ok), results);
}

{
  const file = samples.responses["query.project-workspace.read"];
  const tooLong = schemas.check("application-project-workspace.v1.json", "readInput",
    { projectId: "example-project", path: "a".repeat(WORKSPACE_LIMITS.pathMax + 1) });
  const tooBig = schemas.check("application-project-workspace.v1.json", "page",
    { ...file, range: { offsetBytes: 0, returnedBytes: 0, totalBytes: WORKSPACE_LIMITS.fileMaxBytes + 1 } });
  const pageTooBig = schemas.check("application-project-workspace.v1.json", "readInput",
    { projectId: "example-project", path: "a.txt", maximumBytes: WORKSPACE_LIMITS.pageMaxBytes + 1 });
  const extra = schemas.check("application-agent-conversation.v1.json", "binding",
    { ...samples.responses["query.agent-conversation.resolve"], threadId: "guessed" });
  const truncatedCatalog = schemas.check("application-agent-artifacts.v1.json", "catalog",
    { ...samples.responses["query.agent-artifacts.list"], truncated: true });
  const snapshotWithEvents = schemas.check("application-agent-events.v1.json", "page",
    { ...samples.responses["query.agent-events.read"],
      events: [{ sequence: 1, turnId: null, itemId: null, kind: "turn-started", observedAtUtc: "2026-09-23T12:00:00.000Z" }] });
  check("schemas-reject-path-size-extra-field-and-events-in-snapshot",
    !tooLong.ok && !tooBig.ok && !pageTooBig.ok && !extra.ok && !truncatedCatalog.ok && !snapshotWithEvents.ok,
    { tooLong, tooBig, pageTooBig, extra, truncatedCatalog, snapshotWithEvents });
  const shown = JSON.stringify(extra.problems);
  check("schema-problem-carries-no-value", !shown.includes("guessed"), extra.problems);
}

// --- the allowlist ------------------------------------------------------------------

{
  const missing = NEW_READS.filter((id) => READ_OPERATIONS[id] !== "read");
  const stillAwaited = EXPECTED_CAPABILITIES.flatMap((item) => item.operations).filter((id) => NEW_READS.includes(id));
  const awaitedIds = EXPECTED_CAPABILITIES.map((item) => item.capabilityId);
  check("new-reads-allowed-and-no-longer-expected",
    missing.length === 0 && stillAwaited.length === 0
      && !awaitedIds.includes("project-files") && !awaitedIds.includes("artifacts")
      && !awaitedIds.includes("agent-event-stream") && !awaitedIds.includes("agent-thread-link"),
    { missing, stillAwaited, awaitedIds });
}

{
  const bridge = await readFile(path.join(PROJECT_ROOT, "src", "preload", "bridge.cjs"), "utf8");
  const channels = ["atlas:conversation", "atlas:project-files", "atlas:project-file",
    "atlas:artifacts", "atlas:artifact", "atlas:agent-events"];
  const missing = channels.filter((name) => !CHANNEL_NAMES.includes(name) || !bridge.includes(`"${name}"`));
  check("channels-and-bridge-name-new-reads", missing.length === 0, { missing });
}

// --- through the development fixture: real kit client, real journal ---------------------

let confirmAnswer = true;
const session = await createSession({
  projectRoot: PROJECT_ROOT, mode: "dev-fixture",
  confirm: async () => confirmAnswer, chooseDirectory: async () => null,
});
const workspace = session.agentWorkspace;
const entriesFor = (from, operationId) => session.journal.snapshot().entries.slice(from)
  .filter((entry) => entry.operationId === operationId);
const mark = () => session.journal.snapshot().entries.length;

{
  const from = mark();
  const result = await workspace.conversation({ agentId: "data-ingest-1" });
  const data = result.data;
  check("live-conversation-read-by-agent-binding",
    result.ok && data.route === "live" && data.traversal.status === "complete"
      && data.binding.conversationId !== null && data.content.length > 0
      && data.pages.every((page) => page.conversationId === data.binding.conversationId)
      && entriesFor(from, "query.agent-conversation.resolve").length === 1,
    result);
}

{
  const from = mark();
  const result = await workspace.conversation({ agentId: "data-ingest-1", limit: 1 });
  const reads = entriesFor(from, "query.agent-conversation.read");
  check("continuation-runs-to-end-with-same-limit",
    result.ok && result.data.traversal.status === "complete" && result.data.pages.length === 3
      && reads.length === 3 && reads.every((entry) => entry.target.limit === 1)
      && reads.slice(1).every((entry) => entry.target.cursorSupplied === true),
    { result: result.data?.traversal, reads: reads.map((entry) => entry.target) });
}

{
  const result = await workspace.conversation({ agentId: "data-ingest-1", limit: 1, maxPages: 2 });
  check("unfinished-conversation-honestly-partial",
    result.ok && result.data.traversal.status === "partial" && result.data.traversal.reasonCode === "page_limit"
      && result.data.pages.length === 2,
    result.data?.traversal);
}

{
  const from = mark();
  const result = await workspace.conversation({ agentId: "data-enrich-1" });
  check("archived-agent-routed-to-archive",
    result.ok && result.data.route === "archive" && result.data.binding.reasonCode === "agent_archived"
      && result.data.content === null && entriesFor(from, "query.agent-conversation.read").length === 0,
    result);
}

{
  const result = await workspace.conversation({ agentId: "orphan-agent-1" });
  check("unavailable-live-read-is-not-empty-conversation",
    result.ok && result.data.route === "unavailable" && result.data.binding.reasonCode === "agent_unbound"
      && result.data.content === null && result.data.pages === null,
    result);
}

{
  const listed = await workspace.listProjectFiles({ projectId: "data-pipeline" });
  const big = await workspace.readProjectFile({ projectId: "data-pipeline", path: "logs/drain-trace.log" });
  const next = big.ok ? await workspace.readProjectFile({
    projectId: "data-pipeline", path: "logs/drain-trace.log", cursor: big.data.nextCursor,
  }) : null;
  check("project-files-read-in-pages-up-to-64-kb",
    listed.ok && listed.data.kind === "list" && listed.data.entries.length > 0
      && big.ok && big.data.range.returnedBytes <= WORKSPACE_LIMITS.pageMaxBytes && big.data.truncated === true
      && typeof big.data.nextCursor === "string"
      && next?.ok && next.data.range.offsetBytes === big.data.range.returnedBytes,
    { listed: listed.ok ? listed.data.entries.length : listed, big: big.ok ? big.data.range : big, next: next?.data?.range ?? next });
  const nested = await workspace.listProjectFiles({ projectId: "data-pipeline", path: "src" });
  check("subfolder-read-only-on-explicit-request",
    nested.ok && nested.data.path === "src" && !nested.data.entries.some((entry) => entry.name.includes("/")),
    nested);
}

{
  const from = mark();
  const dispatchesBefore = session.journal.snapshot().dispatches.length;
  const refused = await workspace.readProjectFile({ projectId: "data-pipeline", path: "a".repeat(257) });
  const entries = session.journal.snapshot().entries.slice(from);
  check("path-longer-than-256-not-sent",
    !refused.ok && refused.error.code === "invalid_input"
      && entries.length === 1 && entries[0].status === "not-attempted"
      && session.journal.snapshot().dispatches.length === dispatchesBefore,
    { refused, entries });
}

{
  const huge = await workspace.readProjectFile({ projectId: "data-pipeline", path: "data/export.bin" });
  check("file-over-1-mb-not-passed-off-as-content",
    !huge.ok && huge.error.code === "source_unavailable", huge);
}

{
  const list = await workspace.listArtifacts({ agentId: "data-ingest-1" });
  const report = await workspace.readArtifact({ agentId: "data-ingest-1", artifactId: "task-d0ne.1" });
  const patch = await workspace.readArtifact({ agentId: "data-ingest-1", artifactId: "drain-patch" });
  check("artifacts-only-registered-references",
    list.ok && list.data.coverage === "registered-only" && list.data.records.length === 2, list);
  check("artifact-checked-against-registered-hash",
    report.ok && report.data.verification === "hash-matches" && typeof report.data.text === "string"
      && patch.ok && patch.data.verification === "hash-mismatch" && patch.data.text === null,
    { report: report.data?.verification ?? report, patch: patch.data?.verification ?? patch });
}

{
  const from = mark();
  workspace.forgetEvents("data-ingest-1");
  const first = await workspace.pollEvents({ agentId: "data-ingest-1" });
  const quiet = await workspace.pollEvents({ agentId: "data-ingest-1" });
  const interactions = await session.gateway.run("query.agent-control.interactions", { agentId: "data-ingest-1", limit: 16 });
  const record = interactions.result.output.records[0];
  confirmAnswer = true;
  const responded = await session.mutations.respond({
    agentId: "data-ingest-1", interactionId: record.interactionId, selectedResponse: "decline",
  });
  const after = await workspace.pollEvents({ agentId: "data-ingest-1" });
  const after2 = await workspace.pollEvents({ agentId: "data-ingest-1" });
  check("events-snapshot-first-then-continuation",
    first.ok && first.data.action === "snapshot" && first.data.reasonCode === "initial_snapshot_required"
      && quiet.ok && quiet.data.action === "none", { first, quiet });
  check("interaction-changed-refreshes-questions-and-attention",
    responded.ok && after.ok && after.data.action === "invalidate"
      && after.data.invalidate.includes("interactions") && after.data.invalidate.includes("attention"),
    { responded: responded.ok, after });
  const polled = session.journal.snapshot().entries.slice(from)
    .filter((entry) => entry.operationId.startsWith("mutation.") || entry.operationId.startsWith("approval."));
  check("events-do-not-repeat-changes",
    after2.ok && after2.data.action === "none" && polled.length === 1
      && polled[0].operationId === "approval.agent-control.respond",
    { after2, polled: polled.map((entry) => entry.operationId) });
}

// --- scripted gateway: the edges the fixture cannot produce -----------------------------

function envelope(output, outcome = "succeeded", error = null) {
  return { ok: true, result: { outcome, output, ...(error ? { error } : {}) } };
}

function scripted(handlers) {
  const calls = [];
  return {
    calls,
    run: async (operationId, input) => {
      calls.push({ operationId, input: structuredClone(input) });
      const handler = handlers[operationId];
      if (handler === undefined) return { ok: false, error: { code: "operation_not_allowed" } };
      return handler(input, calls.filter((call) => call.operationId === operationId).length);
    },
  };
}

const CONVERSATION_ID = `conversation:${"c".repeat(64)}`;
const liveBinding = {
  schemaVersion: 1, contractVersion: "v0.1.0", agentId: "agent-a", conversationId: CONVERSATION_ID,
  archiveCoverage: "captured-only", liveRead: { status: "available", reasonCode: "available" },
};
const authority = { schemaVersion: 1, authorityType: "provider", sourceId: "scripted", externalId: "x", contractVersion: "v0.1.0" };
const ref = (kind, externalId) => ({ schemaVersion: 1, kind, relationship: "scripted", authority: { ...authority, externalId } });
function page({ revision = "2026-09-23T12:00:00.000Z", nextCursor = null, conversationId = CONVERSATION_ID, turn = "t1" } = {}) {
  return {
    schemaVersion: 1, contractVersion: "v0.1.0", agentId: "agent-a", conversationId, mode: "provider-read",
    revision, nextCursor, observedAtUtc: "2026-09-23T12:00:01.000Z",
    thread: { threadRef: ref("provider-thread", "th"), parentThreadRef: null, activeTurnRef: null,
      title: null, state: "idle", archived: false, updatedAtUtc: null },
    turns: [{ turnRef: ref("provider-turn", turn), threadRef: ref("provider-thread", "th"), state: "completed",
      startedAtUtc: null, completedAtUtc: null, itemCount: 1 }],
    content: [{ schemaVersion: 1, contractVersion: "v0.1.0",
      provider: { adapterId: "codex", adapterFamily: "execution-provider", adapterVersion: "v0.1.0",
        sourceId: "scripted", runtimeInstanceId: "rt" },
      itemRef: ref("provider-item", `${turn}-i`), turnRef: ref("provider-turn", turn), contentClass: "assistant-message",
      role: "assistant", visibility: "user-visible", text: "hello", contentSha256: "d".repeat(64),
      omissionReason: null, observedAtUtc: "2026-09-23T12:00:01.000Z" }],
    completeness: { status: "complete", reasonCode: null },
  };
}

{
  const gateway = scripted({
    "query.agent-conversation.resolve": () => envelope(liveBinding),
    "query.agent-conversation.read": (input, n) => (n === 1 ? envelope(page({ nextCursor: "c2" }))
      : envelope(null, "failed", { code: "stale_revision", reasonCode: "stale_revision" })),
  });
  const result = await createAgentWorkspace({ gateway, schemas }).conversation({ agentId: "agent-a" });
  check("stale-page-stops-traversal-without-stitching",
    result.ok && result.data.traversal.status === "stale" && result.data.content === null && result.data.pages === null,
    result);
}

{
  const gateway = scripted({
    "query.agent-conversation.resolve": () => envelope(liveBinding),
    "query.agent-conversation.read": (input, n) => envelope(n === 1 ? page({ nextCursor: "c2" })
      : page({ revision: "2026-09-23T12:05:00.000Z", turn: "t2" })),
  });
  const result = await createAgentWorkspace({ gateway, schemas }).conversation({ agentId: "agent-a" });
  check("revision-change-mid-traversal-is-stale",
    result.ok && result.data.traversal.status === "stale" && result.data.content === null, result);
}

{
  const gateway = scripted({
    "query.agent-conversation.resolve": () => envelope(liveBinding),
    "query.agent-conversation.read": () => envelope(page({ conversationId: `conversation:${"e".repeat(64)}` })),
  });
  const result = await createAgentWorkspace({ gateway, schemas }).conversation({ agentId: "agent-a" });
  check("foreign-conversation-not-shown",
    result.ok && result.data.traversal.status === "invalid" && result.data.traversal.reasonCode === "binding_mismatch"
      && result.data.content === null, result);
}

{
  const gateway = scripted({
    "query.agent-conversation.resolve": () => envelope({ ...liveBinding, threadId: "guessed" }),
  });
  const result = await createAgentWorkspace({ gateway, schemas }).conversation({ agentId: "agent-a" });
  check("off-schema-response-is-not-data",
    !result.ok && result.error.code === "response_invalid" && gateway.calls.length === 1, result);
}

{
  const head = "head-1";
  const eventsPage = (mode, events = [], nextCursor = "head-2", reasonCode = null) => ({
    schemaVersion: 1, contractVersion: "v0.1.0", agentId: "agent-a", conversationId: CONVERSATION_ID,
    mode, reasonCode, coverage: "observed-only", events, hasMore: false, nextCursor,
    observedAtUtc: "2026-09-23T12:00:00.000Z",
  });
  const event = (sequence, kind) => ({ sequence, turnId: null, itemId: null, kind, observedAtUtc: "2026-09-23T12:00:00.000Z" });
  const gateway = scripted({
    "query.agent-events.read": (input, n) => {
      if (n === 1) return envelope(eventsPage("snapshot-required", [], head, "initial_snapshot_required"));
      if (n === 2) return envelope(eventsPage("resumed", [event(5, "turn-started"), event(6, "item-completed")], "head-3"));
      if (n === 3) return envelope(eventsPage("resync-required", [], "head-9", "replay_gap"));
      return envelope(eventsPage("resumed", [event(12, "turn-completed"), event(11, "item-completed")], "head-10"));
    },
  });
  const follower = createAgentWorkspace({ gateway, schemas });
  const a = await follower.pollEvents({ agentId: "agent-a" });
  const b = await follower.pollEvents({ agentId: "agent-a" });
  const c = await follower.pollEvents({ agentId: "agent-a" });
  const d = await follower.pollEvents({ agentId: "agent-a" });
  const cursors = gateway.calls.map((call) => call.input.cursor ?? null);
  check("head-saved-before-snapshot-and-continued-from",
    a.data.action === "snapshot" && b.data.action === "invalidate" && b.data.invalidate.includes("conversation")
      && cursors[0] === null && cursors[1] === head && cursors[2] === "head-3",
    { a, b, cursors });
  check("gap-and-reverse-order-need-new-snapshot",
    c.data.action === "snapshot" && c.data.reasonCode === "replay_gap" && cursors[3] === "head-9"
      && d.data.action === "snapshot" && d.data.reasonCode === "sequence_not_increasing",
    { c, d, cursors });
  check("events-read-only-events",
    gateway.calls.every((call) => call.operationId === "query.agent-events.read"), gateway.calls);
}

// --- captured attention and the requested profile ---------------------------------------

{
  const world = await buildWorldView(session.gateway, { desktop: session.kit.desktop });
  const agents = world.projection.projects.flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents));
  const unavailable = agents.find((agent) => agent.agentId === "core-storage-2");
  const recovering = agents.find((agent) => agent.agentId === "core-scheduler-2");
  check("unavailable-attention-stays-null-not-zero",
    unavailable?.attention?.availability === "unavailable" && unavailable.attention.pendingQuestions === null
      && unavailable.attention.recoveryRequired === null, unavailable?.attention);
  check("catalog-attention-gives-recovery-item",
    recovering?.attention?.recoveryRequired === 1
      && world.attention.some((item) => item.kind === "recovery" && item.agentId === "core-scheduler-2"),
    { attention: recovering?.attention, items: world.attention.filter((item) => item.agentId === "core-scheduler-2") });
  const profiled = agents.find((agent) => agent.agentId === "data-ingest-2");
  check("profile-in-projection-requested-and-exact",
    profiled?.profile?.provider === "fixture" && profiled.profile.fallbackPolicy === "deny"
      && profiled.profileSource === "requested", profiled);
  const perAgent = world.interactions.perAgent.find((item) => item.agentId === "data-ingest-2");
  check("recent-questions-carry-truncated-and-omissionCount",
    perAgent?.truncated === false && perAgent.omissionCount === 0, perAgent);
}

{
  let catalogReads = 0;
  const gateway = {
    run: async (operationId, input) => {
      if (operationId === "query.memory.agents.list") {
        catalogReads += 1;
        const response = await session.gateway.run(operationId, input);
        if (catalogReads === 2) {
          for (const agent of response.result.output.agents) {
            if (agent.agentId === "data-ingest-2") agent.attention = { ...agent.attention, pendingQuestions: 7 };
          }
        }
        return response;
      }
      return session.gateway.run(operationId, input);
    },
  };
  const world = await buildWorldView(gateway, { desktop: session.kit.desktop });
  const agent = world.projection.projects.flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents))
    .find((item) => item.agentId === "data-ingest-2");
  check("catalog-reread-after-reading-questions",
    catalogReads === 2 && agent?.attention?.pendingQuestions === 7, { catalogReads, attention: agent?.attention });
}

{
  const channels = createChannels({ session, appVersion: "test" });
  const from = mark();
  const response = await channels["atlas:interactions"]({ agentId: "billing-invoice-1" });
  const after = session.journal.snapshot().entries.slice(from).map((entry) => entry.operationId);
  check("explicit-question-read-rereads-agent",
    response.ok && after[0] === "query.agent-control.interactions" && after[1] === "query.memory.agent.read"
      && response.attention !== undefined, { after, attention: response.attention });
}

// --- the journal keeps facts, not bodies ---------------------------------------------------

{
  const journal = createReadJournal({ header: { mode: "dev-fixture" } });
  const secret = "SECRET-BODY-TEXT";
  const conversationFacts = readFacts("query.agent-conversation.read", { ...page(), content: [{ ...page().content[0], text: secret }] });
  const fileFacts = readFacts("query.project-workspace.read",
    { ...samples.responses["query.project-workspace.read"], text: secret });
  const entry = journal.begin("query.project-workspace.read", { projectId: "p", path: `secret/${secret}.txt` });
  const shown = JSON.stringify({ conversationFacts, fileFacts, target: entry.target });
  check("journal-keeps-no-text-or-path",
    !shown.includes(secret) && conversationFacts?.contentCount === 1 && fileFacts?.totalBytes === 0
      && entry.target.pathLength === `secret/${secret}.txt`.length,
    { conversationFacts, fileFacts, target: entry.target });
}

// --- the renderer's pure rules --------------------------------------------------------------

{
  const none = feedCore.attentionFacts({ availability: "unavailable", coverage: "captured-only", sourceSequence: null,
    sourceRevision: null, pendingQuestions: null, pendingApprovals: null, recoveryRequired: null, observedAtUtc: null });
  const missing = feedCore.attentionFacts(null);
  const some = feedCore.attentionFacts({ availability: "available", coverage: "captured-only", sourceSequence: 3,
    sourceRevision: 2, pendingQuestions: 0, pendingApprovals: 1, recoveryRequired: 0, observedAtUtc: "2026-09-23T12:00:00.000Z" });
  check("attention-null-not-zero-in-window",
    none.questions === "no data" && missing.questions === "no data" && none.available === false
      && some.questions === "0" && some.approvals === "1" && some.available === true, { none, missing, some });
}

{
  const steps = [
    { kind: "project", id: "p-copy", part: { memoryScopeId: "p-memory" } },
    { kind: "quarter", id: "q-copy", projectId: "p-copy", part: { memoryScopeId: "q-memory" } },
    { kind: "agent", id: "a-copy", projectId: "p-copy", quarterId: "q-copy", part: {} },
  ];
  const structure = outcomeCore.pasteSteps(steps, { mode: "structure-only" });
  const withMemory = outcomeCore.pasteSteps(steps, { mode: "structure-and-memory" });
  const unchosen = outcomeCore.pasteSteps(steps, { mode: null });
  check("copy-without-agents-and-with-explicit-mode",
    structure.every((step) => step.kind !== "agent" && step.kind !== "memory")
      && withMemory.filter((step) => step.kind === "memory").length === 2
      && withMemory.every((step) => step.kind !== "agent") && unchosen === null,
    { structure, withMemory, unchosen });
  const pinned = outcomeCore.pinSources(withMemory, new Map([
    ["p-memory", { ok: true, revision: 4, entries: [{ id: "a", title: "A", text: "t" }] }],
    ["q-memory", { ok: false, code: "source_unavailable" }],
  ]));
  check("sources-pinned-before-write",
    pinned.ok === false && pinned.problems.length === 1 && pinned.problems[0].scopeId === "q-memory"
      && pinned.pinned.get("p-memory").revision === 4, pinned);
}

// --- S1: binding before events, pages of one file version --------------------------------

{
  // The window asks for the binding alone first; an archived agent then never
  // reads events or conversation pages.
  const from = mark();
  const live = await workspace.conversation({ agentId: "data-ingest-1", bindingOnly: true });
  const archived = await workspace.conversation({ agentId: "data-enrich-1", bindingOnly: true });
  const reads = session.journal.snapshot().entries.slice(from).map((entry) => entry.operationId);
  check("binding-read-separately-without-pages",
    live.ok && live.data.route === "live" && live.data.pages === null && live.data.traversal === null
      && archived.ok && archived.data.route === "archive"
      && reads.every((id) => id === "query.agent-conversation.resolve") && reads.length === 2,
    { live: live.data, archived: archived.data, reads });
}

{
  // A continuation page belongs to the version the first page came from; a
  // page of a changed file is refused, never glued to the earlier text.
  const first = await workspace.readProjectFile({ projectId: "data-pipeline", path: "logs/drain-trace.log" });
  const same = await workspace.readProjectFile({ projectId: "data-pipeline", path: "logs/drain-trace.log",
    cursor: first.data.nextCursor, expectedSha256: first.data.contentSha256 });
  const changed = await workspace.readProjectFile({ projectId: "data-pipeline", path: "logs/drain-trace.log",
    cursor: first.data.nextCursor, expectedSha256: "0".repeat(64) });
  check("page-of-other-file-version-not-stitched",
    first.ok && same.ok && !changed.ok && changed.error.code === "file_changed", { same: same.ok, changed });
}

{
  const record = { artifactId: "r", path: "r.txt", sha256: "a".repeat(64), sizeBytes: 3, registeredAtUtc: "2026-09-23T12:00:00.000Z" };
  const filePage = (text, contentSha256, nextCursor, offset) => ({
    schemaVersion: 1, contractVersion: "v0.1.0", projectId: "p", path: "r.txt", kind: "read", contentSha256,
    observedAtUtc: "2026-09-23T12:00:00.000Z", text, range: { offsetBytes: offset, returnedBytes: text.length, totalBytes: 3 },
    truncated: nextCursor !== null, nextCursor,
  });
  const gateway = scripted({
    "query.agent-artifacts.list": () => envelope({ schemaVersion: 1, contractVersion: "v0.1.0", agentId: "agent-a",
      revision: 1, coverage: "registered-only", records: [record], truncated: false }),
    "query.agent-artifacts.read": (input, n) => envelope({ schemaVersion: 1, contractVersion: "v0.1.0", agentId: "agent-a",
      artifactId: "r", coverage: "registered-reference",
      page: n === 1 ? filePage("ab", "b".repeat(64), "c2", 0) : filePage("c", "c".repeat(64), null, 2) }),
  });
  const result = await createAgentWorkspace({ gateway, schemas }).readArtifact({ agentId: "agent-a", artifactId: "r" });
  check("artifact-from-pages-of-different-versions-not-assembled",
    !result.ok && result.error.code === "file_changed", result);
}

// --- S1 finalize (Kit v0.16.1): hash-guarded save, atomic copy -----------------------------

const { createHash } = await import("node:crypto");
const { createMutations } = await import("../src/host/mutations.mjs");
const utf8Sha = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const writes = session.mutations;

{
  const first = await workspace.readProjectFile({ projectId: "data-pipeline", path: "README.md" });
  const text = "# Data pipeline — fixture\n\nAn edit from the editor.\n";
  const from = mark();
  const saved = await writes.saveProjectFile({
    projectId: "data-pipeline", path: "README.md", expectedSha256: first.data.contentSha256, text,
  });
  const reread = await workspace.readProjectFile({ projectId: "data-pipeline", path: "README.md" });
  const entries = session.journal.snapshot().entries.slice(from);
  const entry = entries.find((item) => item.operationId === "mutation.project-workspace.save");
  const receipt = saved.ok ? saved.data.receipt : null;
  check("hash-guarded-save-with-receipt-and-reread",
    saved.ok && receipt.previousSha256 === first.data.contentSha256 && receipt.contentSha256 === utf8Sha(text)
      && receipt.bytesWritten === Buffer.byteLength(text, "utf8")
      && reread.ok && reread.data.contentSha256 === receipt.contentSha256 && reread.data.text === text
      && entry?.status === "success" && entry.entryKind === "mutation" && entry.mutationOperationId === receipt.operationId
      && !JSON.stringify(session.journal.snapshot()).includes("An edit from the editor"),
    { saved, entry });

  const stale = await writes.saveProjectFile({
    projectId: "data-pipeline", path: "README.md", expectedSha256: first.data.contentSha256, text: "other text\n",
  });
  const after = await workspace.readProjectFile({ projectId: "data-pipeline", path: "README.md" });
  check("stale-hash-does-not-overwrite",
    !stale.ok && stale.error.code === "stale_revision" && stale.error.uncertain !== true
      && after.ok && after.data.text === text, { stale, text: after.data?.text });
}

{
  const from = mark();
  const dispatches = session.journal.snapshot().dispatches.length;
  const escape = await writes.saveProjectFile({ projectId: "data-pipeline", path: "../outside.txt",
    expectedSha256: "a".repeat(64), text: "x" });
  const huge = await writes.saveProjectFile({ projectId: "data-pipeline", path: "README.md",
    expectedSha256: "a".repeat(64), text: "x".repeat(1_048_577) });
  confirmAnswer = false;
  const declinedSave = await writes.saveProjectFile({ projectId: "data-pipeline", path: "README.md",
    expectedSha256: "a".repeat(64), text: "x" });
  confirmAnswer = true;
  const binary = await writes.saveProjectFile({ projectId: "data-pipeline", path: "data/export.bin",
    expectedSha256: "a".repeat(64), text: "x" });
  const refusedBefore = session.journal.snapshot().entries.slice(from)
    .filter((item) => item.operationId === "mutation.project-workspace.save" && item.status === "not-attempted");
  check("refusal-before-write-path-size-confirmation",
    escape.error?.code === "invalid_input" && escape.error.reasonCode === "path_not_public"
      && huge.error?.code === "invalid_input" && huge.error.reasonCode === "file_too_large"
      && declinedSave.error?.code === "user_declined" && refusedBefore.length === 3
      && session.journal.snapshot().dispatches.length === dispatches + 1, // only the binary save went out
    { escape: escape.error, huge: huge.error, declined: declinedSave.error, refusedBefore: refusedBefore.length,
      dispatched: session.journal.snapshot().dispatches.length - dispatches });
  check("binary-or-large-file-refused-by-backend",
    !binary.ok && binary.error.code === "access_denied", binary);
}

{
  const base = "a".repeat(64);
  const text = "new text\n";
  const readPage = (contentSha256) => envelope({ schemaVersion: 1, contractVersion: "v0.1.0", projectId: "p", path: "f.txt",
    kind: "read", contentSha256, observedAtUtc: "2026-09-24T12:00:00.000Z", text: "", truncated: false, nextCursor: null,
    range: { offsetBytes: 0, returnedBytes: 0, totalBytes: 0 } });
  let current = utf8Sha(text);
  const gateway = scripted({
    "mutation.project-workspace.save": () => ({ ok: true, result: { outcome: "uncertain", error: { code: "uncertain_outcome" } } }),
    "query.project-workspace.read": () => readPage(current),
  });
  const writer = createMutations({ gateway, confirm: async () => true, schemas });
  const lost = await writer.saveProjectFile({ projectId: "p", path: "f.txt", expectedSha256: base, text });
  const operationId = lost.identity?.operationId;
  const applied = await writer.reconcileProjectFileSave({ operationId });
  current = base;
  const notApplied = await writer.reconcileProjectFileSave({ operationId });
  current = "c".repeat(64);
  const elsewhere = await writer.reconcileProjectFileSave({ operationId });
  const unknown = await writer.reconcileProjectFileSave({ operationId: "atlas-save-unknown" });
  const notYet = await writer.resendProjectFileSave({ operationId }); // the latest reconciliation said elsewhere
  current = base;
  await writer.reconcileProjectFileSave({ operationId });
  const resent = await writer.resendProjectFileSave({ operationId });
  const saves = gateway.calls.filter((call) => call.operationId === "mutation.project-workspace.save");
  check("lost-write-checked-by-read-not-retry",
    lost.error?.code === "uncertain_outcome" && typeof operationId === "string"
      && applied.data?.state === "applied" && notApplied.data?.state === "not-applied"
      && elsewhere.data?.state === "changed-elsewhere" && unknown.error?.reasonCode === "reconcile_unknown"
      && notYet.error?.reasonCode === "resend_not_reconciled"
      && saves.length === 2 && saves[1].input.operationId === operationId
      && JSON.stringify(saves[1].input) === JSON.stringify(saves[0].input),
    { lost: lost.error, applied: applied.data, notApplied: notApplied.data, elsewhere: elsewhere.data,
      unknown: unknown.error, resent: resent.error ?? resent.data, saves: saves.length });

  const wrongReceipt = createMutations({ confirm: async () => true, schemas, gateway: scripted({
    "mutation.project-workspace.save": (input) => envelope({ schemaVersion: 1, contractVersion: "v0.1.0",
      projectId: input.projectId, path: input.path, operationId: input.operationId, previousSha256: input.expectedSha256,
      contentSha256: "d".repeat(64), bytesWritten: 3, completedAtUtc: "2026-09-24T12:00:00.000Z" }),
  }) });
  const mismatch = await wrongReceipt.saveProjectFile({ projectId: "p", path: "f.txt", expectedSha256: base, text: "abc" });
  check("wrong-receipt-is-not-success", !mismatch.ok && mismatch.error.code === "uncertain_outcome"
    && mismatch.error.reasonCode === "receipt_mismatch", mismatch);
}

{
  const scopesBefore = (await session.gateway.run("query.memory.scopes.list", {})).result.output.scopes;
  const quarters = scopesBefore.filter((scope) => scope.kind === "quarter" && scope.projectId === "data-pipeline");
  const from = mark();
  const copied = await writes.copyProject({ sourceProjectId: "data-pipeline", targetProjectId: "data-pipeline-copy" });
  const scopesAfter = (await session.gateway.run("query.memory.scopes.list", {})).result.output.scopes;
  const agents = (await session.gateway.run("query.memory.agents.list", {})).result.output.agents;
  const receipt = copied.ok ? copied.data.receipt : null;
  const entry = session.journal.snapshot().entries.slice(from).find((item) => item.operationId === "mutation.memory.project.copy");
  check("project-copy-with-memory-atomic-without-agents",
    copied.ok && receipt.outcome === "complete" && receipt.scopes.length === quarters.length + 1
      && receipt.scopes.every((scope) => scope.targetRevision === 1 && scope.targetSha256 === scope.sourceSha256)
      && quarters.every((quarter) => scopesAfter.some((scope) => scope.projectId === "data-pipeline-copy"
        && scope.kind === "quarter" && scope.quarterId === quarter.quarterId))
      && !agents.some((agent) => agent.projectId === "data-pipeline-copy")
      && entry?.status === "success" && entry.mutationOperationId === receipt.operationId,
    { copied: copied.error ?? copied.data?.receipt?.scopes?.length, entry });

  const again = await writes.copyProject({ sourceProjectId: "data-pipeline", targetProjectId: "data-pipeline-copy" });
  const scopesAgain = (await session.gateway.run("query.memory.scopes.list", {})).result.output.scopes;
  // The host sees the target in the fresh catalog and refuses before any write;
  // the backend's own atomic refusal is covered in test-outcomes.
  check("repeat-copy-refused-before-write-nothing-created",
    !again.ok && again.error.code === "invalid_input" && again.error.reasonCode === "target_project_exists"
      && scopesAgain.length === scopesAfter.length, again);
}

{
  const catalog = (truncated) => envelope({ schemaVersion: 1, truncated, scopes: [
    { schemaVersion: 1, scopeId: "s-memory", kind: "project", projectId: "s", quarterId: null, title: "S", revision: 2,
      sha256: "a".repeat(64), author: "x", updatedAtUtc: "2026-09-24T12:00:00.000Z" },
    { schemaVersion: 1, scopeId: "s-q1-memory", kind: "quarter", projectId: "s", quarterId: "q1", title: "Q", revision: 3,
      sha256: "b".repeat(64), author: "x", updatedAtUtc: "2026-09-24T12:00:00.000Z" },
  ] });
  let copies = 0;
  const receiptFor = (input) => ({ schemaVersion: 1, outcome: "complete", sourceProjectId: input.sourceProjectId,
    targetProjectId: input.targetProjectId, operationId: input.operationId, copiedAtUtc: "2026-09-24T12:00:00.000Z",
    scopes: [
      { sourceScopeId: "s-memory", targetScopeId: input.targetProjectScopeId, kind: "project", quarterId: null,
        sourceRevision: 2, sourceSha256: "a".repeat(64), targetRevision: 1, targetSha256: "a".repeat(64) },
      { sourceScopeId: "s-q1-memory", targetScopeId: input.quarterScopeIds.q1, kind: "quarter", quarterId: "q1",
        sourceRevision: 3, sourceSha256: "b".repeat(64), targetRevision: 1, targetSha256: "b".repeat(64) },
    ] });
  const gateway = scripted({
    "query.memory.scopes.list": () => catalog(false),
    "mutation.memory.project.copy": (input) => {
      copies += 1;
      return copies === 1 ? { ok: true, result: { outcome: "uncertain", error: { code: "uncertain_outcome" } } }
        : envelope(receiptFor(input));
    },
  });
  const writer = createMutations({ gateway, confirm: async () => true, schemas });
  const lost = await writer.copyProject({ sourceProjectId: "s", targetProjectId: "t" });
  const reconciled = await writer.reconcileProjectCopy({ operationId: lost.identity?.operationId });
  const sent = gateway.calls.filter((call) => call.operationId === "mutation.memory.project.copy");
  const truncatedWriter = createMutations({ confirm: async () => true, schemas, gateway: scripted({
    "query.memory.scopes.list": () => catalog(true),
  }) });
  const truncated = await truncatedWriter.copyProject({ sourceProjectId: "s", targetProjectId: "t" });
  check("lost-copy-receipt-checked-with-same-request",
    lost.error?.code === "uncertain_outcome" && reconciled.ok && reconciled.data.receipt.outcome === "complete"
      && sent.length === 2 && JSON.stringify(sent[0].input) === JSON.stringify(sent[1].input)
      && sent[0].input.quarterScopeIds.q1 === "t-q1-memory" && sent[0].input.targetProjectScopeId === "t-memory",
    { lost: lost.error, reconciled: reconciled.error ?? "ok", sent: sent.map((call) => call.input) });
  check("incomplete-catalog-not-copied",
    truncated.error?.code === "invalid_input" && truncated.error.reasonCode === "catalog_truncated", truncated);
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "agent-workspace",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

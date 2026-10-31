import assert from "node:assert/strict";
import test from "node:test";
import { ProjectMemoryService } from "../src/project-memory-service.mjs";

const profile = { provider: "openai", model: "model-test", reasoningEffort: "max", fallbackPolicy: "deny" };
const create = (agentId = "agent-a", quarterId = "feature-a") => ({ agentId, projectId: "project-a",
  quarterId, operationId: `create-${agentId}`, profile });
function fixture() {
  let doc = null, creates = 0, sends = 0, captured = 0;
  const rows = [], inputs = [], history = new Map(), owned = new Map();
  const pair = { project: { scopeId: "project-a", revision: 1, sha256: "a".repeat(64), entries: [] },
    quarter: { scopeId: "feature-a", revision: 1, sha256: "b".repeat(64), entries: [] } };
  const store = {
    async readDocument() { return structuredClone(doc); },
    async compareAndSwapDocument({ expectedRevision, value }) {
      if ((doc?.revision ?? 0) !== expectedRevision) return false;
      doc = { revision: expectedRevision + 1, value: structuredClone(value) }; return true;
    },
    async readPair({ projectId, quarterId }) {
      assert.equal(projectId, "project-a"); assert.equal(quarterId, "feature-a");
      for (const scope of Object.values(pair)) history.set(`${scope.scopeId}:${scope.revision}`, structuredClone(scope));
      return structuredClone(pair);
    },
    async readScope({ scopeId, revision }) {
      return structuredClone(revision === undefined ? owned.get(scopeId) : history.get(`${scopeId}:${revision}`));
    },
    // Agents' own memories (schema 2): created empty with each agent.
    async createScope(input) {
      if (!owned.has(input.scopeId)) {
        owned.set(input.scopeId, { scopeId: input.scopeId, kind: input.kind, projectId: input.projectId,
          quarterId: input.quarterId, title: input.title, revision: 1, sha256: "c".repeat(64), entries: [] });
      }
      const scope = owned.get(input.scopeId);
      history.set(`${scope.scopeId}:${scope.revision}`, structuredClone(scope));
      return structuredClone(scope);
    },
    async readScopes({ scopeIds }) {
      return scopeIds.filter((scopeId) => owned.has(scopeId)).map((scopeId) => structuredClone(owned.get(scopeId)));
    },
  };
  const archive = {
    async append(binding, record) { rows.push({ binding, record }); },
    async read(binding) { return { coverage: "captured-only", items: rows.filter((r) => r.binding.threadId === binding.threadId) }; },
  };
  const provider = {
    failSend: false, failCreate: false, terminal: false,
    async preflight(value) { assert.deepEqual(value, profile); },
    async create() { creates++; if (this.failCreate) throw Error("lost"); return {
      projectId: "controller", sourceId: "source-a", providerId: "codex", threadId: `thread-${creates}`,
    }; },
    async send({ text, operation }) {
      sends++; inputs.push(text);
      assert.ok(rows.some((row) => row.record.requestId === operation.operationId));
      if (this.failSend) throw Error("lost acknowledgement");
      return { turnId: `turn-${sends}`, state: "started" };
    },
    async observe({ operation }) { return { turnId: operation.turnId, state: this.terminal ? "completed" : "started" }; },
    async capture() { captured++; },
  };
  const service = new ProjectMemoryService({ store, archive, provider });
  return { service, pair, provider, rows, inputs, store, archive,
    counts: () => ({ creates, sends, captured }) };
}

test("new agent has a fresh binding and two empty memories without a start gate", async () => {
  const f = fixture();
  const a = await f.service.createAgent(create());
  const b = await f.service.createAgent(create("agent-b"));
  assert.notEqual(a.binding.threadId, b.binding.threadId);
  const catalog = await f.service.listAgents();
  assert.equal(catalog.truncated, false);
  assert.equal(catalog.omissionCount, 0);
  assert.equal(catalog.totalAgents, 2);
  const empty = await f.service.listAgents({ projectId: "other-project" });
  assert.equal(empty.totalAgents, 0); assert.equal(empty.truncated, false);
  assert.equal(a.state, "active");
  const context = await f.service.context({ agentId: a.agentId });
  assert.equal(context.contentState, "empty");
  assert.equal(context.startBlockedByEmptyMemory, false);
  assert.equal(context.deliveryState, "pending");
  const receipt = await f.service.send({ agentId: a.agentId, operationId: "send-a", text: "task" });
  assert.equal(receipt.state, "started");
  assert.equal((await f.service.context({ agentId: a.agentId })).deliveryState, "delivered");
});

test("a model that does not answer is the agent's problem until one of its turns completes again", async () => {
  const f = fixture(); const a = await f.service.createAgent(create());
  const turn = async (operationId, state, failure) => {
    f.provider.observe = async ({ operation }) => ({ turnId: operation.turnId, state, failure });
    await f.service.send({ agentId: a.agentId, operationId, text: operationId });
    await f.service.receipt({ agentId: a.agentId, operationId });
    return f.service.readAgent({ agentId: a.agentId });
  };
  assert.equal((await turn("send-1", "failed", "acp_prompt_failed")).problemCode ?? null, null, "another failure is no such problem");
  const down = await turn("send-2", "failed", "acp_model_unreachable");
  assert.deepEqual([down.problemCode, down.state, down.lastOperation.state], ["model_unreachable", "active", "failed"]);
  assert.equal((await turn("send-3", "completed", null)).problemCode, null);
  assert.equal((await turn("send-4", "failed", "claude_signed_out")).problemCode, "claude_signed_out");
  assert.equal((await turn("send-5", "completed", null)).problemCode, null);
});

test("same creation replays; changed membership and foreign session adoption fail", async () => {
  const f = fixture(); await f.service.createAgent(create());
  await f.service.createAgent(create());
  assert.equal(f.counts().creates, 1);
  await assert.rejects(f.service.createAgent({ ...create(), quarterId: "different" }), { code: "memory_identity_conflict" });
  await assert.rejects(f.service.createAgent({ ...create("b"), threadId: "old-chat" }), { code: "memory_invalid_input" });
  f.provider.create = async () => (await f.service.readAgent({ agentId: "agent-a" })).binding;
  assert.equal((await f.service.createAgent(create("agent-b"))).state, "uncertain");
});

test("catalog attention is explicit unavailable or exact bound provider summary", async () => {
  const f = fixture(); await f.service.createAgent(create());
  const absent = (await f.service.listAgents()).agents[0].attention;
  assert.equal(absent.availability, "unavailable");
  assert.equal(absent.pendingQuestions, null);
  const summary = { availability: "available", coverage: "captured-only", sourceSequence: 4,
    sourceRevision: 9, pendingQuestions: 2, pendingApprovals: 1, recoveryRequired: 1,
    observedAtUtc: "2026-09-23T12:00:00.000Z" };
  f.provider.interactionSummary = async (agent) => {
    assert.equal(agent.binding.threadId, "thread-1"); return summary;
  };
  assert.deepEqual((await f.service.listAgents()).agents[0].attention, summary);
  f.provider.interactionSummary = async () => { throw Error("private failure"); };
  assert.deepEqual((await f.service.listAgents()).agents[0].attention, absent);
  f.provider.interactionSummary = async () => ({ ...summary, pendingQuestions: -1 });
  assert.equal((await f.service.listAgents()).agents[0].attention.availability, "unavailable");
});

test("updates reach the next turn and do not rewrite an existing manifest", async () => {
  const f = fixture(); await f.service.createAgent(create());
  const first = await f.service.send({ agentId: "agent-a", operationId: "send-a", text: "first" });
  f.pair.project.revision = 2; f.pair.project.sha256 = "c".repeat(64);
  f.pair.project.entries = [{ id: "rule", title: "Goal", text: "new project rule" }];
  assert.equal((await f.service.context({ agentId: "agent-a" })).deliveryState, "pending");
  assert.equal((await f.service.listAgents()).agents[0].requiredManifest.project.revision, 2);
  await assert.rejects(f.service.send({ agentId: "agent-a", operationId: "send-b", text: "next" }), { code: "memory_agent_busy" });
  assert.equal(f.counts().sends, 1);
  f.provider.terminal = true;
  const second = await f.service.send({ agentId: "agent-a", operationId: "send-b", text: "next" });
  assert.equal(first.manifest.project.revision, 1); assert.equal(second.manifest.project.revision, 2);
  assert.ok(f.inputs[1].includes("new project rule"));
});

test("lost acknowledgement survives restart and never resubmits", async () => {
  const f = fixture(); await f.service.createAgent(create()); f.provider.failSend = true;
  const request = { agentId: "agent-a", operationId: "send-a", text: "once" };
  assert.equal((await f.service.send(request)).state, "uncertain");
  const restarted = new ProjectMemoryService({ store: f.store, provider: f.provider, archive: f.archive });
  assert.equal((await restarted.send(request)).state, "uncertain");
  assert.equal((await restarted.readAgent({ agentId: "agent-a" })).deliveryState, "uncertain");
  assert.equal(f.counts().sends, 1);
  await assert.rejects(restarted.send({ ...request, text: "different" }), { code: "memory_identity_conflict" });
  await assert.rejects(restarted.send({ ...request, operationId: "send-b" }), { code: "memory_agent_busy" });
});

test("concurrent same request has only one provider invocation", async () => {
  const f = fixture(); await f.service.createAgent(create());
  const request = { agentId: "agent-a", operationId: "send-a", text: "once" };
  await Promise.all([f.service.send(request), f.service.send(request)]);
  assert.equal(f.counts().sends, 1);
});

test("one working-folder writer survives restart and releases only on observed terminal", async () => {
  const f = fixture();
  f.provider.resolveWorkspace = async () => ({ workspaceKey: "same-folder" });
  await f.service.createAgent(create()); await f.service.createAgent(create("agent-b"));
  const first = { agentId: "agent-a", operationId: "send-a", text: "first" };
  const second = { agentId: "agent-b", operationId: "send-b", text: "second" };
  await f.service.send(first);
  const restarted = new ProjectMemoryService({ store: f.store, archive: f.archive, provider: f.provider });
  await assert.rejects(restarted.send(second), { code: "memory_workspace_busy" });
  assert.equal(f.counts().sends, 1);
  f.provider.terminal = true;
  await restarted.receipt({ agentId: first.agentId, operationId: first.operationId });
  assert.equal((await restarted.send(second)).state, "started");
  assert.equal(f.counts().sends, 2);
  assert.equal(Object.hasOwn(await restarted.readAgent({ agentId: "agent-a" }), "workspaceKey"), false);
});

test("lost acknowledgement holds the folder and simultaneous writers cannot bypass the claim", async () => {
  const f = fixture(); f.provider.resolveWorkspace = async () => ({ workspaceKey: "same" });
  await f.service.createAgent(create()); await f.service.createAgent(create("agent-b"));
  f.provider.failSend = true;
  const results = await Promise.allSettled(["agent-a", "agent-b"].map((agentId) =>
    f.service.send({ agentId, operationId: `send-${agentId}`, text: "once" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "memory_workspace_busy");
  assert.equal(f.counts().sends, 1);
});

test("interrupt is one-shot, exact-turn-bound and does not release the writer on acknowledgement", async () => {
  const f = fixture(); let stops = 0;
  f.provider.interrupt = async ({ operation }) => { assert.equal(operation.turnId, "turn-1"); stops++; };
  await f.service.createAgent(create());
  const input = { agentId: "agent-a", operationId: "send-a" };
  await f.service.send({ ...input, text: "work" });
  assert.equal((await f.service.interrupt(input)).state, "accepted");
  assert.equal((await f.service.interrupt(input)).state, "accepted");
  assert.equal(stops, 1);
  await assert.rejects(f.service.send({ ...input, operationId: "send-b", text: "next" }), { code: "memory_agent_busy" });
  await assert.rejects(f.service.interrupt({ ...input, operationId: "other" }), { code: "memory_identity_conflict" });
  f.provider.terminal = true;
  await f.service.receipt(input);
  assert.equal((await f.service.readAgent({ agentId: input.agentId })).currentOperationId, null);
});

test("uncertain interrupt survives service reconstruction without another provider call", async () => {
  const f = fixture(); let calls = 0;
  f.provider.interrupt = async () => { calls++; throw Error("lost response"); };
  await f.service.createAgent(create());
  const input = { agentId: "agent-a", operationId: "send-a" };
  await f.service.send({ ...input, text: "task" });
  assert.equal((await f.service.interrupt(input)).state, "uncertain");
  const next = new ProjectMemoryService({ store: f.store, provider: f.provider, archive: f.archive });
  assert.equal((await next.interrupt(input)).state, "uncertain");
  assert.equal(calls, 1);
});

test("closed agent stays archived, history remains readable without provider", async () => {
  const f = fixture(); await f.service.createAgent(create());
  await f.service.send({ agentId: "agent-a", operationId: "send-a", text: "preserve me" });
  await assert.rejects(f.service.closeAgent({ agentId: "agent-a", operationId: "close-a" }), { code: "memory_agent_busy" });
  f.provider.terminal = true;
  assert.equal((await f.service.closeAgent({ agentId: "agent-a", operationId: "close-a" })).state, "archived");
  const snapshot = await f.store.readDocument();
  const counts = f.counts();
  const archivedRows = structuredClone(f.rows);
  f.provider.preflight = async () => { throw Error("archived send reached provider preflight"); };
  await assert.rejects(f.service.send({ agentId: "agent-a", operationId: "blocked-new-send", text: "resume" }), { code: "memory_agent_closed" });
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(f.rows, archivedRows);
  assert.deepEqual(await f.store.readDocument(), snapshot);
  const restarted = new ProjectMemoryService({ store: f.store, archive: f.archive });
  assert.equal((await restarted.createAgent(create())).state, "archived");
  await assert.rejects(restarted.send({ agentId: "agent-a", operationId: "new-send", text: "resume" }), { code: "memory_agent_closed" });
  const page = await restarted.readArchive({ agentId: "agent-a" });
  assert.ok(page.items[0].record.text.includes("preserve me")); assert.equal(page.canRestore, false);
  assert.equal(page.canSend, false);
  f.pair.project.revision = 2; f.pair.project.sha256 = "c".repeat(64);
  assert.equal((await restarted.context({ agentId: "agent-a" })).project.revision, 1);
});

test("creation uncertainty and archive failure cannot fabricate readiness", async () => {
  const f = fixture(); f.provider.failCreate = true;
  assert.equal((await f.service.createAgent(create())).state, "uncertain");
  await f.service.createAgent(create()); assert.equal(f.counts().creates, 1);
  f.provider.failCreate = false;
  await f.service.createAgent(create("agent-b"));
  f.provider.capture = async () => { throw Error("capture unavailable"); };
  await assert.rejects(f.service.closeAgent({ agentId: "agent-b", operationId: "close-b" }));
  assert.equal((await f.service.readAgent({ agentId: "agent-b" })).state, "closing");
});

// A message while the agent works: steered into its running turn, or - when
// nothing runs, or the turn ended meanwhile - an ordinary send of the same
// operation, with the memory in front of it.
test("steer goes to the running turn and falls back to a send when nothing runs", async () => {
  const f = fixture();
  const steered = [];
  let turnOver = false;
  f.provider.steer = async ({ operation, text, mode, clientId }) => {
    if (turnOver) throw Object.assign(Error("turn_not_active"), { code: "turn_not_active" });
    steered.push({ turnId: operation.turnId, text, mode, clientId });
    return { delivery: mode === "queue" ? "queued" : "steered" };
  };
  f.provider.trace = async () => ({ records: [], beforeCursor: null, afterCursor: null, gap: false, exhausted: true });
  const agent = await f.service.createAgent(create());
  const idle = await f.service.steer({ agentId: agent.agentId, operationId: "op-1", text: "Start", mode: "steer" });
  assert.equal(idle.delivery, "started");
  assert.equal(f.counts().sends, 1);
  const now = await f.service.steer({ agentId: agent.agentId, operationId: "op-2", text: "Also this", mode: "steer" });
  const later = await f.service.steer({ agentId: agent.agentId, operationId: "op-3", text: "Then that", mode: "queue" });
  assert.deepEqual([now.delivery, later.delivery], ["steered", "queued"]);
  assert.deepEqual(steered.map((item) => [item.turnId, item.text, item.mode, item.clientId]),
    [["turn-1", "Also this", "steer", "op-2"], ["turn-1", "Then that", "queue", "op-3"]]);
  assert.equal(f.inputs.length, 1, "a steered message is not a new turn");
  // The turn ended between the click and the request: the message starts the next turn.
  turnOver = true;
  f.provider.terminal = true;
  const next = await f.service.steer({ agentId: agent.agentId, operationId: "op-4", text: "One more", mode: "steer" });
  assert.equal(next.delivery, "started");
  assert.equal(next.turnId, "turn-2");
  assert.ok(f.inputs[1].endsWith("User task:\nOne more"));
  await assert.rejects(f.service.steer({ agentId: agent.agentId, operationId: "op-5", text: "x", mode: "now" }),
    { code: "memory_invalid_input" });
});

test("the profile of the next turns changes; a closed agent keeps its own", async () => {
  const f = fixture();
  const checked = [];
  f.provider.preflight = async (value) => { checked.push(value.model); };
  const agent = await f.service.createAgent(create());
  const changed = await f.service.setProfile({ agentId: agent.agentId,
    profile: { ...profile, model: "model-two", reasoningEffort: "high" } });
  assert.equal(changed.profile.model, "model-two");
  assert.equal(changed.profile.reasoningEffort, "high");
  assert.equal(Object.hasOwn(changed, "profileChangedAtUtc"), false);
  assert.deepEqual(checked.at(-1), "model-two");
  await assert.rejects(f.service.setProfile({ agentId: agent.agentId,
    profile: { ...profile, provider: "claude" } }), { code: "memory_profile_conflict" });
  await f.service.closeAgent({ agentId: agent.agentId, operationId: "close-1" });
  await assert.rejects(f.service.setProfile({ agentId: agent.agentId, profile }), { code: "memory_agent_closed" });
});

test("the trace masks what looks like a secret and keeps only known fields", async () => {
  const f = fixture();
  const secret = `sk-${"a".repeat(30)}`;
  f.provider.steer = async () => ({ delivery: "steered" });
  f.provider.trace = async (agent, options) => ({
    records: [{ type: "tool_result", output: `token ${secret} and Bearer ${"b".repeat(30)}`, extra: "dropped",
      text: "plain" }],
    beforeCursor: "1:0", afterCursor: "1:99", gap: false, exhausted: true, options,
  });
  f.provider.queued = () => [{ clientId: "q-1", displayText: "later please", queuedAtUtc: "2026-10-03T00:00:00.000Z" }];
  const agent = await f.service.createAgent(create());
  const page = await f.service.trace({ agentId: agent.agentId, before: null, after: "1:10" });
  assert.equal(page.records[0].output, "token [hidden] and [hidden]");
  assert.equal(Object.hasOwn(page.records[0], "extra"), false);
  assert.equal(page.records[0].text, "plain");
  assert.deepEqual(page.queued, [{ clientId: "q-1", message: "later please", queuedAtUtc: "2026-10-03T00:00:00.000Z" }]);
  assert.equal(page.afterCursor, "1:99");
  await assert.rejects(f.service.trace({ agentId: agent.agentId, before: "x" }), { code: "memory_invalid_input" });
});

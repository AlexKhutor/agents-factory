import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLAUDE_AGENT_TOOLS } from "../src/claude-code-sdk.mjs";
import { createClaudeCodeSessionJournal } from "../src/claude-code-session-journal.mjs";
import {
  CLAUDE_CODE_ADAPTER_ID, ClaudeCodeSessionHost, createClaudeCodeProviderDescriptor,
} from "../src/claude-code-session-host.mjs";
import { CodexAppServerConversationReadAdapter } from "../src/codex-app-server-conversation-read-adapter.mjs";
import {
  FAKE_MODEL, FAKE_MODELS, createFakeClaudeSdk, fakeResult, signedIn,
} from "./fixtures/fake-claude-sdk.mjs";

async function fixture(t, { turns = [], readAccount = signedIn } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = createFakeClaudeSdk({ turns });
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root });
  const diagnostics = [];
  const host = new ClaudeCodeSessionHost({ sdk, journal, models: FAKE_MODELS, readAccount,
    onDiagnostic: (record) => diagnostics.push(record) });
  await host.connect();
  t.after(() => host.close());
  const events = [];
  for (const name of ["turn/started", "item/started", "item/completed", "turn/completed", "serverRequestState"]) {
    host.on(name, (event) => events.push([name, event]));
  }
  return { root, sdk, journal, host, events, diagnostics };
}

function completion(host, turnId) {
  return new Promise((resolve) => {
    const listener = (event) => {
      if (event.turnId !== turnId) return;
      host.off("turn/completed", listener);
      resolve(event);
    };
    host.on("turn/completed", listener);
  });
}

async function runTurn(host, threadId, text, options = {}) {
  const started = await host.startTurn(threadId, [{ type: "text", text }], options);
  const done = await completion(host, started.turn.id);
  return { turnId: started.turn.id, status: done.turn.status };
}

test("a turn starts the session under its id, streams items and the next turn resumes it", async (t) => {
  const f = await fixture(t);
  const threadId = await f.host.createSession({ cwd: f.root });
  const first = await runTurn(f.host, threadId, "First task", { model: FAKE_MODEL, effort: "default",
    clientUserMessageId: "op-1" });
  assert.equal(first.status, "completed");
  const options = f.sdk.calls[0].options;
  assert.equal(options.sessionId, threadId);
  assert.equal(options.resume, undefined);
  assert.equal(options.cwd, f.root);
  assert.equal(options.model, FAKE_MODEL);
  assert.equal(options.effort, undefined, "the default effort is Claude Code's own");
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(options.tools, [...CLAUDE_AGENT_TOOLS]);
  assert.deepEqual(options.settingSources, ["project", "local"]);
  assert.equal(f.sdk.calls[0].prompt.message.content, "First task");

  const second = await runTurn(f.host, threadId, "Second task", { model: FAKE_MODEL, effort: "high" });
  assert.equal(second.status, "completed");
  assert.equal(f.sdk.calls[1].options.resume, threadId);
  assert.equal(f.sdk.calls[1].options.sessionId, undefined);
  assert.equal(f.sdk.calls[1].options.effort, "high");

  const turns = await f.host.listThreadTurns(threadId, { limit: 10 });
  assert.equal(turns.data.length, 2);
  const types = turns.data[0].items.map((item) => item.type);
  assert.deepEqual(types, ["userMessage", "reasoning", "agentMessage", "commandExecution", "plan", "agentMessage"]);
  // Every item says when it was written; the person's message at the start of the turn.
  assert.ok(turns.data[0].items.every((item) => Number.isFinite(Date.parse(item.atUtc))));
  assert.equal(turns.data[0].items[0].atUtc, turns.data[0].startedAt);
  const command = turns.data[0].items.find((item) => item.type === "commandExecution");
  assert.equal(command.command, "echo hi");
  assert.equal(command.aggregatedOutput, "hi");
  assert.equal(command.status, "completed");
  const plan = turns.data[0].items.find((item) => item.type === "plan");
  assert.equal(plan.text, "[x] Read the code\n[~] Writing the fix");
  assert.equal(turns.data[0].items[0].clientId, "op-1");

  const turn = await f.host.readTurn(threadId, first.turnId);
  assert.equal(turn.observedModel, FAKE_MODEL);
  assert.deepEqual(turn.modelsUsed, [FAKE_MODEL]);
  const usage = await f.host.readThreadUsage(threadId);
  assert.equal(usage.threadUsage.modelContextWindow, 200000);
  assert.equal(usage.threadUsage.groups[0].cachedInputTokens, 2000);

  const kinds = f.events.filter(([, event]) => event.turnId === first.turnId).map(([name]) => name);
  assert.equal(kinds[0], "turn/started");
  assert.equal(kinds.at(-1), "turn/completed");
  assert.ok(kinds.includes("item/completed"));
});

test("a turn runs in the agent's permission mode, else the provider's; bypass carries the SDK's consent", async (t) => {
  const f = await fixture(t);
  const threadId = await f.host.createSession({ cwd: f.root });
  assert.equal(f.host.permissionMode, "acceptEdits");
  await runTurn(f.host, threadId, "One", { model: FAKE_MODEL });
  assert.equal(f.sdk.calls[0].options.permissionMode, "acceptEdits");
  assert.equal(f.sdk.calls[0].options.allowDangerouslySkipPermissions, undefined);
  await runTurn(f.host, threadId, "Two", { model: FAKE_MODEL, permissionMode: "auto" });
  assert.equal(f.sdk.calls[1].options.permissionMode, "auto");
  assert.equal(f.sdk.calls[1].options.allowDangerouslySkipPermissions, undefined);
  await runTurn(f.host, threadId, "Three", { model: FAKE_MODEL, permissionMode: "bypassPermissions" });
  assert.equal(f.sdk.calls[2].options.permissionMode, "bypassPermissions");
  assert.equal(f.sdk.calls[2].options.allowDangerouslySkipPermissions, true);
  await assert.rejects(f.host.startTurn(threadId, [{ type: "text", text: "Four" }], { permissionMode: "yolo" }),
    { code: "invalid_request" });
  assert.equal(f.sdk.calls.length, 3, "a refused mode starts nothing");
});

test("the Codex read adapter reads a Claude Code session as an exact provider thread", async (t) => {
  const f = await fixture(t);
  const threadId = await f.host.createSession({ cwd: f.root });
  await runTurn(f.host, threadId, "Read me", { model: FAKE_MODEL });
  const descriptor = createClaudeCodeProviderDescriptor({ sourceId: "controller",
    runtimeInstanceId: "gateway-claude-one", observedAtUtc: new Date().toISOString() });
  const reader = new CodexAppServerConversationReadAdapter({ client: f.host, descriptor,
    adapterId: CLAUDE_CODE_ADAPTER_ID });
  assert.throws(() => new CodexAppServerConversationReadAdapter({ client: f.host, descriptor }),
    { code: "capability_mismatch" });
  const threadRef = { schemaVersion: 1, kind: "provider-thread", relationship: "provider-owner",
    authority: { schemaVersion: 1, authorityType: "provider", sourceId: "controller",
      externalId: threadId, contractVersion: descriptor.identity.adapterVersion } };
  const read = await reader.readThread({ threadRef, includeContent: true, limit: 10, cursor: null });
  assert.equal(read.threadRead.data.thread.state, "idle");
  assert.equal(read.threadRead.data.turns.length, 1);
  assert.equal(read.threadRead.data.turns[0].state, "completed");
  const classes = read.content.map((item) => item.omissionReason ?? item.contentClass);
  assert.ok(classes.includes("user-message"));
  assert.ok(classes.includes("assistant-message"));
  assert.ok(classes.includes("tool-summary"));
  const texts = read.content.map((item) => item.text ?? "");
  assert.ok(texts.some((text) => text.startsWith("Plan\n[x] Read the code")), "the plan is visible");
  assert.ok(texts.some((text) => text === "Thinking\nConsidering."), "the reasoning summary is visible");
  assert.ok(texts.some((text) => text.startsWith("$ echo hi")), "the command is visible");
  assert.equal(texts[0], "Read me", "the person's message as typed");
  const auth = await reader.readAuthentication();
  assert.equal(auth.data.state.status, "authenticated");
  const models = await reader.listModels({});
  assert.equal(models.data.records[0].name, "Claude test");
});

test("the person's decisions reach Claude Code through the registered request handlers", async (t) => {
  const decisions = [];
  const turns = [async function* asking({ sessionId, ask }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    decisions.push(await ask("Bash", { command: "rm -rf build" }, "toolu_b1", { title: "Run rm -rf build" }));
    decisions.push(await ask("AskUserQuestion", { questions: [{ question: "Which color?", header: "Color",
      options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cold" }] }] }, "toolu_q1"));
    decisions.push(await ask("WebFetch", { url: "https://example.com" }, "toolu_w1"));
    decisions.push(await ask("Write", { file_path: "/outside/x.txt", content: "x" }, "toolu_f1"));
    yield fakeResult(sessionId);
  }];
  const f = await fixture(t, { turns });
  const seen = [];
  f.host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params, metadata) => {
    seen.push(["command", params, metadata]); return { decision: "accept" };
  });
  f.host.registerServerRequestHandler("item/tool/requestUserInput", async (params) => {
    seen.push(["question", params]); return { answers: { q1: { answers: ["Blue"] } } };
  });
  f.host.registerServerRequestHandler("item/permissions/requestApproval", async (params) => {
    seen.push(["permission", params]); return { permissions: {}, scope: "turn" };
  });
  assert.throws(() => f.host.registerServerRequestHandler("item/tool/requestUserInput", async () => ({})),
    { code: "conflict" });
  const threadId = await f.host.createSession({ cwd: f.root });
  const done = await runTurn(f.host, threadId, "Do things", { model: FAKE_MODEL });
  assert.equal(done.status, "completed");

  const [command, question, permission] = seen;
  assert.equal(command[1].threadId, threadId);
  assert.equal(command[1].turnId, done.turnId);
  assert.equal(command[1].itemId, "toolu_b1");
  assert.equal(command[1].command, "rm -rf build");
  assert.equal(command[1].reason, "Run rm -rf build");
  assert.equal(command[2].generation, 1);
  assert.equal(command[2].requestId, `${done.turnId}:toolu_b1`);
  assert.equal(question[1].questions[0].id, "q1");
  assert.equal(question[1].questions[0].options[1].label, "Blue");
  assert.equal(permission[1].permissions.tool, "WebFetch");

  assert.deepEqual(decisions[0], { behavior: "allow", updatedInput: { command: "rm -rf build" } });
  assert.equal(decisions[1].behavior, "allow");
  assert.deepEqual(decisions[1].updatedInput.answers, { "Which color?": "Blue" });
  assert.equal(decisions[2].behavior, "deny");
  // No handler for file changes: nobody can decide, so the action is not taken.
  assert.equal(decisions[3].behavior, "deny");
  const resolved = f.events.filter(([name]) => name === "serverRequestState");
  assert.equal(resolved.length, 3);
});

test("the agent's question and the person's answer stay in the chat", async (t) => {
  const input = (question) => ({ questions: [{ question, header: "Pick", multiSelect: false,
    options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cold" }] }] });
  const asked = (sessionId, id, question) => ({ type: "assistant", session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: input(question) }] } });
  // What Claude Code sends back: the answers, or the refusal as an error.
  const answered = (sessionId, id, decision) => ({ type: "user", session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id,
      ...(decision.behavior === "allow" ? { content: "User has answered your questions." }
        : { content: decision.message, is_error: true }) }] } });
  const turns = [async function* questions({ sessionId, ask }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield asked(sessionId, "toolu_q1", "Which   color?\nPick one.");
    yield answered(sessionId, "toolu_q1", await ask("AskUserQuestion", input("Which   color?\nPick one."), "toolu_q1"));
    yield asked(sessionId, "toolu_q2", "Which size?");
    yield answered(sessionId, "toolu_q2", await ask("AskUserQuestion", input("Which size?"), "toolu_q2"));
    yield fakeResult(sessionId);
  }];
  const f = await fixture(t, { turns });
  f.host.registerServerRequestHandler("item/tool/requestUserInput", async (params) =>
    (params.questions[0].question === "Which size?" ? {} : { answers: { q1: { answers: ["Blue"] } } }));
  const threadId = await f.host.createSession({ cwd: f.root });
  const done = await runTurn(f.host, threadId, "Ask me", { model: FAKE_MODEL });
  assert.equal(done.status, "completed");

  const turns2 = await f.host.listThreadTurns(threadId, { limit: 10 });
  const questions = turns2.data[0].items.filter((item) => item.type === "userQuestion");
  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0].questions, [{ header: "Pick", question: "Which   color?\nPick one." }]);
  assert.deepEqual(questions[0].answers, ["Blue"]);
  assert.equal(questions[0].status, "completed");
  assert.equal(questions[1].answers, null, "an unanswered question keeps no answer");
  assert.equal(questions[1].status, "failed");

  const descriptor = createClaudeCodeProviderDescriptor({ sourceId: "controller",
    runtimeInstanceId: "gateway-claude-one", observedAtUtc: new Date().toISOString() });
  const reader = new CodexAppServerConversationReadAdapter({ client: f.host, descriptor,
    adapterId: CLAUDE_CODE_ADAPTER_ID });
  const threadRef = { schemaVersion: 1, kind: "provider-thread", relationship: "provider-owner",
    authority: { schemaVersion: 1, authorityType: "provider", sourceId: "controller",
      externalId: threadId, contractVersion: descriptor.identity.adapterVersion } };
  const read = await reader.readThread({ threadRef, includeContent: true, limit: 10, cursor: null });
  const summaries = read.content.filter((item) => item.contentClass === "interaction-summary").map((item) => item.text);
  assert.deepEqual(summaries, [
    "You answered the agent's questions:\n· Which color? Pick one.\n  → Blue",
    "The agent's question was left unanswered:\n· Which size?",
  ]);
});

test("a question that takes several options says so, and its answers go back joined", async (t) => {
  const input = { questions: [{ question: "Which parts?", header: "Parts", multiSelect: true,
    options: [{ label: "Hull", description: "" }, { label: "Tracks", description: "" }, { label: "Turret", description: "" }] }] };
  let decision = null;
  const turns = [async function* several({ sessionId, ask }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield { type: "assistant", session_id: sessionId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_m1", name: "AskUserQuestion", input }] } };
    decision = await ask("AskUserQuestion", input, "toolu_m1");
    yield fakeResult(sessionId);
  }];
  const f = await fixture(t, { turns });
  let asked = null;
  f.host.registerServerRequestHandler("item/tool/requestUserInput", async (params) => {
    asked = params;
    return { answers: { q1: { answers: ["Hull, Turret"] } } };
  });
  const threadId = await f.host.createSession({ cwd: f.root });
  assert.equal((await runTurn(f.host, threadId, "Ask me", { model: FAKE_MODEL })).status, "completed");
  assert.equal(asked.questions[0].multiSelect, true);
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput.answers, { "Which parts?": "Hull, Turret" });
});

test("a stop ends the turn as interrupted, and a busy session refuses a second start", async (t) => {
  const turns = [async function* waiting({ sessionId, interrupted }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    await interrupted;
    yield { type: "result", subtype: "error_during_execution", session_id: sessionId, is_error: true };
  }];
  const f = await fixture(t, { turns });
  const threadId = await f.host.createSession({ cwd: f.root });
  const started = await f.host.startTurn(threadId, [{ type: "text", text: "Long work" }], { model: FAKE_MODEL });
  const done = completion(f.host, started.turn.id);
  await assert.rejects(f.host.startTurn(threadId, [{ type: "text", text: "Again" }], { model: FAKE_MODEL }),
    { code: "claude_session_busy" });
  assert.equal((await f.host.readThread(threadId)).thread.status, "active");
  await assert.rejects(f.host.interruptTurn(threadId, "another-turn"), { code: "turn_not_active" });
  await f.host.interruptTurn(threadId, started.turn.id);
  assert.equal((await done).turn.status, "interrupted");
  assert.equal(f.sdk.calls[0].interrupted, true);
  assert.equal((await f.host.readThread(threadId)).thread.status, "idle");
});

test("a turn whose process reports another session fails and is not trusted", async (t) => {
  const turns = [async function* foreign() {
    yield { type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000000000", model: FAKE_MODEL };
    yield fakeResult("00000000-0000-4000-8000-000000000000");
  }];
  const f = await fixture(t, { turns });
  const threadId = await f.host.createSession({ cwd: f.root });
  const done = await runTurn(f.host, threadId, "Hello", { model: FAKE_MODEL });
  assert.equal(done.status, "failed");
  const turn = await f.host.readTurn(threadId, done.turnId);
  assert.equal(turn.failure, "claude_session_identity_mismatch");
  assert.equal((await f.journal.readSession(threadId)).providerStarted, false);
});

test("a result marked as an error fails the turn and its text reaches the conversation", async (t) => {
  const turns = [async function* limited({ sessionId }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield { type: "assistant", uuid: "11111111-1111-4111-8111-111111111111", session_id: sessionId,
      parent_tool_use_id: null, message: { content: [{ type: "text", text: "You've hit your session limit" }] } };
    yield fakeResult(sessionId, { is_error: true, result: "You've hit your session limit" });
  }];
  const f = await fixture(t, { turns });
  const threadId = await f.host.createSession({ cwd: f.root });
  const done = await runTurn(f.host, threadId, "Hello", { model: FAKE_MODEL });
  assert.equal(done.status, "failed");
  const turn = await f.host.readTurn(threadId, done.turnId);
  assert.equal(turn.failure, "claude_error_result");
  assert.ok(turn.items.some((item) => item.type === "agentMessage" && /session limit/u.test(item.text)));
});

test("a lost sign-in fails the turn as claude_signed_out, whether as an error result or a thrown error", async (t) => {
  const message = "Failed to authenticate: OAuth session expired and could not be refreshed";
  const turns = [
    async function* asResult({ sessionId }) {
      yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
      yield fakeResult(sessionId, { is_error: true, result: message });
    },
    async function* asThrow({ sessionId }) {
      yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
      throw new Error(`Claude Code returned an error result: ${message}`);
    },
  ];
  const f = await fixture(t, { turns });
  const threadId = await f.host.createSession({ cwd: f.root });
  for (let index = 0; index < 2; index += 1) {
    const done = await runTurn(f.host, threadId, `Hello ${index}`, { model: FAKE_MODEL });
    assert.equal(done.status, "failed");
    assert.equal((await f.host.readTurn(threadId, done.turnId)).failure, "claude_signed_out");
  }
});

test("an unknown model is refused before anything starts, and a restart closes unfinished turns", async (t) => {
  const f = await fixture(t);
  const threadId = await f.host.createSession({ cwd: f.root });
  await assert.rejects(f.host.startTurn(threadId, [{ type: "text", text: "x" }], { model: "other-model" }),
    { code: "memory_profile_conflict" });
  assert.equal(f.sdk.calls.length, 0);
  const unfinished = "11111111-1111-4111-8111-111111111111";
  await f.journal.appendTurn(threadId, { id: unfinished, status: "inProgress", startedAt: null,
    completedAt: null, items: [{ id: "toolu_x", type: "commandExecution", status: "inProgress" }] },
  new Date().toISOString());
  const restarted = await createClaudeCodeSessionJournal({ controllerRoot: f.root });
  assert.equal(await restarted.recover(new Date().toISOString()), 1);
  const turn = await restarted.readTurn(threadId, unfinished);
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.recovery, "gateway_restarted");
  assert.equal(turn.items[0].status, "interrupted");
  assert.equal(await restarted.recover(new Date().toISOString()), 0);
});

test("a long-lived session keeps its latest turns in the journal, one file per turn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root, keptTurns: 3 });
  const sessionId = "22222222-2222-4222-8222-222222222222";
  await journal.create({ sessionId, cwd: root, atUtc: new Date().toISOString() });
  await assert.rejects(journal.create({ sessionId, cwd: root, atUtc: new Date().toISOString() }),
    { code: "claude_session_exists" });
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `33333333-3333-4333-8333-33333333333${index}`;
    ids.push(id);
    await journal.appendTurn(sessionId, { id, status: "completed", startedAt: null, completedAt: null, items: [] },
      new Date().toISOString());
  }
  const session = await journal.readSession(sessionId);
  assert.deepEqual(session.turnIds, ids.slice(2));
  assert.equal(session.droppedTurns, 2);
  assert.equal(await journal.readTurn(sessionId, ids[0]), null);
  assert.equal((await journal.readTurns(sessionId)).length, 3);
  await journal.updateTurn(sessionId, ids[4], (turn) => { turn.items.push({ id: "x", type: "agentMessage" }); },
    new Date().toISOString());
  const fresh = await createClaudeCodeSessionJournal({ controllerRoot: root, keptTurns: 3 });
  assert.equal((await fresh.readTurn(sessionId, ids[4])).items.length, 1);
  await assert.rejects(createClaudeCodeSessionJournal({ controllerRoot: root, keptTurns: 0 }),
    { code: "claude_journal_invalid" });
});

test("the account is read from Claude Code's own status and kept for a minute", async (t) => {
  let reads = 0;
  const f = await fixture(t, { readAccount: async () => { reads += 1; return { state: "signed-out" }; } });
  const first = await f.host.readAccount();
  assert.deepEqual(first, { requiresOpenaiAuth: true, account: null });
  await f.host.readAccount();
  assert.equal(reads, 1);
});

test("a task's planning turn runs in plan mode; ExitPlanMode never reaches the person and its plan stays in the trace", async (t) => {
  const decisions = [];
  const plan = "## Understanding\nAdd a button.\n## Questions\nNone\n## Plan\n1. Add it";
  const planning = async function* planningTurn({ sessionId, ask }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield { type: "assistant", session_id: sessionId, message: { model: FAKE_MODEL,
      content: [{ type: "tool_use", id: "toolu_p1", name: "ExitPlanMode", input: { plan } }] } };
    decisions.push(await ask("ExitPlanMode", { plan }, "toolu_p1"));
    yield fakeResult(sessionId);
  };
  const f = await fixture(t, { turns: [planning, planning] });
  let asked = 0;
  f.host.registerServerRequestHandler("item/permissions/requestApproval", async () => { asked += 1; return { permissions: {} }; });
  const threadId = await f.host.createSession({ cwd: f.root });
  assert.equal((await runTurn(f.host, threadId, "Plan it", { model: FAKE_MODEL, permissionMode: "plan", planning: true })).status,
    "completed");
  assert.equal(f.sdk.calls[0].options.permissionMode, "plan");
  assert.ok(f.sdk.calls[0].options.tools.includes("ExitPlanMode"), "the tool list is the same for every turn");
  assert.equal(decisions[0].behavior, "deny");
  assert.match(decisions[0].message, /recorded and shown to the person for approval/u);
  // Outside a planning turn there is no plan to present either; the person is never asked.
  await runTurn(f.host, threadId, "Go on", { model: FAKE_MODEL });
  assert.equal(decisions[1].behavior, "deny");
  assert.match(decisions[1].message, /no plan to present/u);
  assert.equal(asked, 0);
  const trace = await f.host.readTrace(threadId, { maxBytes: 512 * 1024 });
  const exits = trace.records.filter((record) => record.type === "tool_use" && record.tool === "ExitPlanMode");
  assert.equal(JSON.parse(exits[0].input).plan, plan);
});

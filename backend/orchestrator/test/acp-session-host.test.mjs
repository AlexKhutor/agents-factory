import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { AcpStdioClient } from "../src/acp-stdio-client.mjs";
import { AcpSessionHost, createAcpProviderDescriptor, normalizeAcpModels } from "../src/acp-session-host.mjs";
import { acpEnvironment, normalizeAcpProviderConfig } from "../src/acp-provider-config.mjs";
import { createClaudeCodeSessionJournal } from "../src/claude-code-session-journal.mjs";
import { CodexAppServerConversationReadAdapter } from "../src/codex-app-server-conversation-read-adapter.mjs";
import { createApplicationGatewayReadHandlers } from "../src/application-gateway-read-bridge.mjs";

const AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const MODELS = [{ id: "qwen", value: "[\"p\",\"qwen\"]", displayName: "Qwen" }, { id: "a", value: "[\"p\",\"a\"]" }];
const MCP = [{ name: "inzoi", command: process.execPath, args: ["gateway.py"], env: [] }];

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acp-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "agent.log");
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root, folder: "acp-sessions" });
  const make = () => new AcpSessionHost({ journal, models: MODELS, mcpServers: MCP, stopGraceMs: 2000,
    startClient: async () => {
      const client = new AcpStdioClient({ command: process.execPath, args: [AGENT],
        env: { ...process.env, FAKE_ACP_LOG: log } });
      client.start();
      return client;
    } });
  const entries = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
  return { root, journal, make, entries };
}

const ended = (host, turnId) => new Promise((resolve) => {
  const listener = (event) => { if (event.turnId === turnId) { host.off("turn/completed", listener); resolve(event); } };
  host.on("turn/completed", listener);
});

test("a turn records the agent's thought, message, tool call and the person's decision", async (t) => {
  const { root, make, entries } = await setup(t);
  const host = make();
  t.after(() => host.close());
  await host.connect();
  const asked = [];
  host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
    asked.push(params);
    return { decision: "accept" };
  });
  const threadId = await host.createSession({ cwd: root });
  const started = await host.startTurn(threadId, [{ type: "text", text: "run a tool" }], { model: "qwen",
    displayText: "run" });
  const done = await ended(host, started.turn.id);
  assert.equal(done.turn.status, "completed");
  const turn = await host.readTurn(threadId, started.turn.id);
  assert.deepEqual(turn.items.map((item) => item.type),
    ["userMessage", "reasoning", "commandExecution", "agentMessage"]);
  const command = turn.items[2];
  assert.equal(command.command, "Get-ChildItem");
  assert.equal(command.status, "completed");
  assert.equal(command.aggregatedOutput, "a.txt");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].command, "Get-ChildItem");
  assert.equal(asked[0].itemId, command.id);
  assert.equal(turn.observedModel, "qwen");
  // The model was set on the session before the prompt; the MCP servers went with session/new.
  const log = await entries();
  assert.equal(log.find((entry) => entry.method === "prompt").model, "[\"p\",\"qwen\"]");
  assert.deepEqual(log.find((entry) => entry.method === "session/new.mcp").mcpServers, MCP);
  assert.equal(log.find((entry) => entry.method === "permission").allowed, true);
  const usage = await host.readThreadUsage(threadId);
  assert.equal(usage.threadUsage.modelContextWindow, 98304);
});

test("the desk's policy decides before the person is asked", async (t) => {
  const { root, make, entries } = await setup(t);
  const host = make();
  t.after(() => host.close());
  await host.connect();
  let asked = 0;
  host.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { asked += 1; return { decision: "accept" }; });
  const threadId = await host.createSession({ cwd: root });
  const seen = [];
  const started = await host.startTurn(threadId, [{ type: "text", text: "tool please" }], {
    policy: async (call) => { seen.push(call); return "deny"; } });
  await ended(host, started.turn.id);
  assert.equal(asked, 0);
  assert.equal(seen[0].tool, "pwsh");
  assert.equal(seen[0].input.command, "Get-ChildItem");
  assert.equal(seen[0].cwd, root);
  assert.equal((await entries()).find((entry) => entry.method === "permission").allowed, false);
  const turn = await host.readTurn(threadId, started.turn.id);
  assert.equal(turn.items.find((item) => item.type === "commandExecution").status, "failed");
  // The refusal is in the trace, for the desk's attention.
  const trace = await host.readTrace(threadId);
  const decision = trace.records.find((record) => record.type === "permission");
  assert.deepEqual([decision.decision, decision.by, decision.tool, decision.turnId], ["deny", "desk", "pwsh", started.turn.id]);
});

test("a secret is refused before any policy; any other read is allowed without the person", async (t) => {
  const { root, make, entries } = await setup(t);
  const host = make();
  t.after(() => host.close());
  await host.connect();
  let asked = 0;
  host.registerServerRequestHandler("item/permissions/requestApproval", async () => { asked += 1; return { permissions: { read: true } }; });
  const threadId = await host.createSession({ cwd: root });
  // No desk policy at all: the secret check does not depend on one.
  for (const file of ["notes/plan.md", ".project-local/claude-account/.credentials.json", "~/.ssh/config"]) {
    const started = await host.startTurn(threadId, [{ type: "text", text: `read ${file}` }], {});
    await ended(host, started.turn.id);
  }
  assert.deepEqual((await entries()).filter((entry) => entry.method === "permission").map((entry) => entry.allowed),
    [true, false, false]);
  assert.equal(asked, 0);
  // Refusals are in the trace for the desk's attention; an ordinary read is not.
  const trace = await host.readTrace(threadId);
  assert.deepEqual(trace.records.filter((record) => record.type === "permission").map((record) => [record.tool, record.decision, record.by]),
    [["read", "deny", "desk"], ["read", "deny", "desk"]]);
});

test("a turn the agent stays silent in ends as an unreachable model; a question to the person is not silence", async (t) => {
  const { root, journal, entries } = await setup(t);
  const log = path.join(root, "agent.log");
  const host = new AcpSessionHost({ journal, models: MODELS, mcpServers: MCP, stopGraceMs: 200,
    silenceTimeoutMs: 400, silenceCheckMs: 50,
    startClient: async () => {
      const client = new AcpStdioClient({ command: process.execPath, args: [AGENT], env: { ...process.env, FAKE_ACP_LOG: log } });
      client.start();
      return client;
    } });
  t.after(() => host.close());
  await host.connect();
  const threadId = await host.createSession({ cwd: root });
  // "slow": one thought, then nothing until the turn is cancelled - a model server that hangs.
  const started = await host.startTurn(threadId, [{ type: "text", text: "slow" }], {});
  const done = await ended(host, started.turn.id);
  assert.equal(done.turn.status, "failed");
  const turn = await host.readTurn(threadId, started.turn.id);
  assert.equal(turn.failure, "acp_model_unreachable");
  assert.ok((await entries()).some((entry) => entry.method === "session/cancel"), "the agent is told to stop");
  assert.ok((await host.readTrace(threadId)).records.some((record) => record.type === "turn_silent"));
  // A person who takes longer than the limit to answer a question does not end the turn.
  host.registerServerRequestHandler("item/commandExecution/requestApproval", async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { decision: "accept" };
  });
  const asked = await host.startTurn(threadId, [{ type: "text", text: "tool please" }], {});
  assert.equal((await ended(host, asked.turn.id)).turn.status, "completed");
});

test("the silence limit and a model's check address are optional and checked", () => {
  const base = { schemaVersion: 1, command: process.execPath, args: [], home: tmpdir(),
    models: [{ id: "q", check: "http://office-pc:8080/health" }] };
  const config = normalizeAcpProviderConfig(base);
  assert.equal(config.turnSilenceMinutes, null);
  assert.equal(config.models[0].check, "http://office-pc:8080/health");
  assert.equal(normalizeAcpProviderConfig({ ...base, turnSilenceMinutes: 0 }).turnSilenceMinutes, 0);
  for (const bad of [{ turnSilenceMinutes: -1 }, { turnSilenceMinutes: 1.5 }, { models: [{ id: "q", check: "ftp://x" }] }]) {
    assert.throws(() => normalizeAcpProviderConfig({ ...base, ...bad }), { code: /^acp_/u });
  }
});

test("a turn whose model does not answer says so; another failure stays a plain prompt failure", async (t) => {
  const { root, make } = await setup(t);
  const host = make();
  t.after(() => host.close());
  await host.connect();
  const threadId = await host.createSession({ cwd: root });
  const down = await host.startTurn(threadId, [{ type: "text", text: "model down" }]);
  assert.equal((await ended(host, down.turn.id)).turn.status, "failed");
  assert.equal((await host.readTurn(threadId, down.turn.id)).failure, "acp_model_unreachable");
  const broken = await host.startTurn(threadId, [{ type: "text", text: "broken" }]);
  await ended(host, broken.turn.id);
  assert.equal((await host.readTurn(threadId, broken.turn.id)).failure, "acp_prompt_failed");
});

test("a message for a running turn waits for its prompt; stopping drops it and ends the turn", async (t) => {
  const { root, make } = await setup(t);
  const host = make();
  t.after(() => host.close());
  await host.connect();
  const threadId = await host.createSession({ cwd: root });
  const started = await host.startTurn(threadId, [{ type: "text", text: "slow work" }]);
  const done = ended(host, started.turn.id);
  const queued = await host.steerTurn(threadId, started.turn.id, [{ type: "text", text: "and then this" }],
    { mode: "steer", clientUserMessageId: "c1" });
  assert.deepEqual(queued, { delivery: "queued", clientId: "c1" });
  assert.equal(host.queuedMessages(threadId).length, 1);
  await assert.rejects(host.startTurn(threadId, [{ type: "text", text: "x" }]), { code: "acp_session_busy" });
  await host.interruptTurn(threadId, started.turn.id);
  assert.equal((await done).turn.status, "interrupted");
  const turn = await host.readTurn(threadId, started.turn.id);
  assert.equal(turn.items.filter((item) => item.type === "userMessage").length, 1);
});

test("held messages go as the next prompt of the same turn", async (t) => {
  const { root, make, entries } = await setup(t);
  const host = make();
  t.after(() => host.close());
  await host.connect();
  const threadId = await host.createSession({ cwd: root });
  // A permission question keeps the first prompt open while the message is queued.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  host.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { await gate; return { decision: "accept" }; });
  const started = await host.startTurn(threadId, [{ type: "text", text: "tool first" }]);
  const done = ended(host, started.turn.id);
  await host.steerTurn(threadId, started.turn.id, [{ type: "text", text: "second" }], { mode: "queue", clientUserMessageId: "c2" });
  release();
  assert.equal((await done).turn.status, "completed");
  const prompts = (await entries()).filter((entry) => entry.method === "prompt").map((entry) => entry.text);
  assert.deepEqual(prompts, ["tool first", "second"]);
  const turn = await host.readTurn(threadId, started.turn.id);
  assert.equal(turn.items.filter((item) => item.type === "userMessage").length, 2);
});

test("a new agent process takes a session back with session/resume", async (t) => {
  const { root, make, entries } = await setup(t);
  const first = make();
  await first.connect();
  const threadId = await first.createSession({ cwd: root });
  await first.close();
  const second = make();
  t.after(() => second.close());
  await second.connect();
  const started = await second.startTurn(threadId, [{ type: "text", text: "hello again" }]);
  assert.equal((await ended(second, started.turn.id)).turn.status, "completed");
  assert.ok((await entries()).some((entry) => entry.method === "session/resume"));
  const listed = await second.listThreads();
  assert.equal(listed.data[0].id, threadId);
});

test("the provider config keeps secrets out of the file and telemetry off", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "acp-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = path.join(root, "key.txt");
  await writeFile(secret, "s3cret\n");
  const config = normalizeAcpProviderConfig({ schemaVersion: 1, command: process.execPath, args: ["dsh.js", "--profile", "acp"],
    home: root, env: { EXTRA: "1" }, secretEnv: { WORK_KEY: secret }, models: MODELS, mcpServers: MCP });
  const env = await acpEnvironment(config, { base: { PATH: "p", Path: "p2", OPENAI_API_KEY: "leak", SystemRoot: "C:\\Windows" } });
  assert.equal(env.WORK_KEY, "s3cret");
  assert.equal(env.EXTRA, "1");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, "p");
  assert.equal(env.Path, undefined);
  assert.equal(env.DSH_HOME, root);
  assert.equal(env.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(env.DSH_TELEMETRY_MODE, "DISABLED");
  assert.equal(env.DSH_PERMISSION_MODE, "workspace-write");
  for (const bad of [{ env: { DSH_TELEMETRY_MODE: "FEEDBACK_ONLY" } }, { secretEnv: { K: "relative.txt" } },
    { home: "relative" }, { apiKey: "x" }]) {
    assert.throws(() => normalizeAcpProviderConfig({ schemaVersion: 1, command: process.execPath, args: [], home: root,
      models: MODELS, ...bad }), { code: "acp_provider_config_invalid" });
  }
  assert.throws(() => normalizeAcpModels([{ id: "x", efforts: ["default"], defaultEffort: "high" }]), { code: "acp_models_invalid" });
});

test("provider reads go to the reader the request names", async () => {
  const at = new Date().toISOString();
  const reader = (descriptor, name) => new CodexAppServerConversationReadAdapter({ descriptor, adapterId: descriptor.identity.adapterId,
    client: { listModels: async () => ({ data: [{ id: name, displayName: name }], nextCursor: null }), readAccount: async () => ({}),
      listThreads: async () => ({}), readThread: async () => ({}), listThreadTurns: async () => ({}), readThreadUsage: async () => ({}) } });
  const acp = createAcpProviderDescriptor({ sourceId: "s", runtimeInstanceId: "gateway-acp-1", observedAtUtc: at });
  const handlers = createApplicationGatewayReadHandlers({ extraConversationReaders: [reader(acp, "qwen")] });
  const identity = { adapterId: acp.identity.adapterId, adapterVersion: acp.identity.adapterVersion, sourceId: "s",
    runtimeInstanceId: "gateway-acp-1" };
  const listed = await handlers["query.provider.models.list"]({ input: { provider: identity } });
  assert.equal(listed.data.records[0].name, "qwen");
  await assert.rejects(async () => handlers["query.provider.models.list"]({ input: { provider: { ...identity, sourceId: "other" } } }));
});

test("a task's planning turn refuses every change, whatever the policy; reads still go", async (t) => {
  const { root, make, entries } = await setup(t);
  const host = make();
  t.after(() => host.close());
  await host.connect();
  let asked = 0;
  host.registerServerRequestHandler("item/commandExecution/requestApproval", async () => { asked += 1; return { decision: "accept" }; });
  host.registerServerRequestHandler("item/permissions/requestApproval", async () => { asked += 1; return { permissions: { read: true } }; });
  const threadId = await host.createSession({ cwd: root });
  const asks = [];
  for (const text of ["tool please", "read notes/plan.md"]) {
    const started = await host.startTurn(threadId, [{ type: "text", text }], {
      planning: true, policy: async (call) => { asks.push(call); return "allow"; } });
    await ended(host, started.turn.id);
  }
  assert.deepEqual((await entries()).filter((entry) => entry.method === "permission").map((entry) => entry.allowed), [false, true]);
  assert.equal(asked, 0, "the person is not asked");
  assert.equal(asks.length, 0, "not even an allowing policy is asked");
  const trace = await host.readTrace(threadId);
  assert.deepEqual(trace.records.filter((record) => record.type === "permission").map((record) => [record.tool, record.decision, record.by]),
    [["pwsh", "deny", "desk"]]);
  // The next, ordinary turn is not a planning one.
  const started = await host.startTurn(threadId, [{ type: "text", text: "tool please" }], { policy: async () => "allow" });
  await ended(host, started.turn.id);
  assert.equal((await entries()).filter((entry) => entry.method === "permission").at(-1).allowed, true);
});

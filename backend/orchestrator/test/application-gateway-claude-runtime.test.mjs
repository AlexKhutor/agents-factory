import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createClaudeProviderRuntime, normalizeClaudeProviderConfig, readClaudeProviderConfig,
} from "../src/application-gateway-claude-runtime.mjs";
import { bindProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { createApplicationGatewayReadRuntime } from "../src/application-gateway-read-runtime.mjs";
import { createClaudeCodeSessionJournal } from "../src/claude-code-session-journal.mjs";
import { ClaudeCodeSessionHost } from "../src/claude-code-session-host.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { FAKE_MODEL, FAKE_MODELS, FAKE_ZOD, createFakeClaudeSdk, signedIn } from "./fixtures/fake-claude-sdk.mjs";

const SOURCE = "controller";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: SOURCE }));
  return root;
}

const claudeConfig = (extra = {}) => ({ sdkPath: path.resolve("fake-sdk"), claudeConfigDir: null,
  keepProviderVariables: false, models: FAKE_MODELS, settingSources: ["project", "local"],
  permissionMode: "acceptEdits", sdk: createFakeClaudeSdk(), readAccount: signedIn, ...extra });

/** A Claude Code session with one finished turn, bound to agent "a" of project "p". */
async function boundAgent(root) {
  const sdk = createFakeClaudeSdk();
  const host = new ClaudeCodeSessionHost({ sdk, models: FAKE_MODELS, readAccount: signedIn,
    journal: await createClaudeCodeSessionJournal({ controllerRoot: root }) });
  await host.connect();
  const threadId = await host.createSession({ cwd: root });
  const done = new Promise((resolve) => host.once("turn/completed", resolve));
  await host.startTurn(threadId, [{ type: "text", text: "Earlier task" }], { model: FAKE_MODEL });
  await done;
  await host.close();
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  for (const [scopeId, kind, quarterId] of [["p", "project", null], ["q", "quarter", "q"]]) {
    await service.store.createScope({ scopeId, kind, projectId: "p", quarterId, title: scopeId,
      operationId: `create-${scopeId}` });
  }
  service.provider = { preflight: async () => {},
    create: async () => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "claude", threadId }) };
  await service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a",
    profile: { provider: "claude", model: FAKE_MODEL, reasoningEffort: "default", fallbackPolicy: "deny" } });
  return threadId;
}

test("the Gateway runs desk agents on Claude Code and reads their sessions live", async (t) => {
  const root = await fixture(t);
  const threadId = await boundAgent(root);
  const runtime = await createApplicationGatewayReadRuntime({ repoRoot: root, sourceId: SOURCE,
    instanceId: "claude-runtime-test", provider: "claude", claude: claudeConfig() });
  t.after(() => runtime.close());
  assert.equal(runtime.provider, "claude");
  assert.deepEqual(runtime.providerStatus, { status: "available", reasonCode: "available" });
  assert.equal(runtime.authenticationStates[0].status, "authenticated");
  assert.equal(runtime.authenticationStates[0].provider.providerId, "claude-code-sdk");
  assert.deepEqual(runtime.memoryStatus, { storage: "available", execution: "available" });
  assert.equal(runtime.ownerChatStatus.status, "disabled");
  const read = (operationId, input) => runtime.handlers[operationId]({ input });

  const resolved = await read("query.agent-conversation.resolve", { agentId: "a" });
  assert.deepEqual(resolved.liveRead, { status: "available", reasonCode: "available" });
  const page = await read("query.agent-conversation.read", { agentId: "a", limit: 50 });
  assert.equal(page.thread.threadRef.authority.externalId, threadId);
  assert.equal(page.turns.length, 1);
  assert.ok(page.content.some((item) => item.contentClass === "assistant-message" && item.text === "Done."));
  const events = await read("query.agent-events.read", { agentId: "a" });
  assert.equal(events.mode, "snapshot-required");
  const agents = await read("query.memory.agents.list", {});
  assert.equal(agents.agents[0].binding.providerId, "claude");
  for (const operationId of ["mutation.memory.agent.send", "mutation.memory.agent.create",
    "query.agent-control.interactions", "approval.agent-control.respond", "mutation.agent-control.interrupt"]) {
    assert.equal(typeof runtime.handlers[operationId], "function", operationId);
  }
});

test("a Claude runtime that cannot start leaves the Gateway's own resources readable", async (t) => {
  const root = await fixture(t);
  const runtime = await createApplicationGatewayReadRuntime({ repoRoot: root, sourceId: SOURCE,
    instanceId: "claude-runtime-missing", provider: "claude",
    claude: claudeConfig({ sdk: undefined, sdkPath: path.join(root, "no-sdk-here") }) });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.providerStatus, { status: "unavailable", reasonCode: "claude_sdk_unavailable" });
  assert.equal(runtime.memoryStatus.execution, "unavailable");
  assert.equal(typeof runtime.handlers["query.memory.scopes.list"], "function");
  // Claude Code is the Gateway's provider: another one, or none configured, is refused (the Codex path left).
  for (const refused of [{ provider: "codex", claude: claudeConfig() }, { provider: "other" }, { provider: "claude" }]) {
    await assert.rejects(createApplicationGatewayReadRuntime({ repoRoot: root, sourceId: SOURCE,
      instanceId: "claude-runtime-other", ...refused }), { code: "source_unavailable" });
  }
});

test("a signed-out Claude Code is reported, and the agents' provider stays in place for a later sign-in", async (t) => {
  const root = await fixture(t);
  const runtime = await createApplicationGatewayReadRuntime({ repoRoot: root, sourceId: SOURCE,
    instanceId: "claude-runtime-signed-out", provider: "claude",
    claude: claudeConfig({ readAccount: async () => ({ state: "signed-out" }) }) });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.providerStatus, { status: "unavailable", reasonCode: "provider_authentication_required" });
  assert.equal(runtime.authenticationStates[0].status, "unauthenticated");
  assert.equal(runtime.memoryStatus.execution, "available");
});

test("the machine-local Claude provider config is strict", async (t) => {
  const root = await fixture(t);
  await assert.rejects(readClaudeProviderConfig(root), { code: "claude_provider_config_missing" });
  const valid = { schemaVersion: 1, sdkPath: path.resolve("sdk"), models: [{ id: "claude-sonnet-5" }] };
  const normalized = normalizeClaudeProviderConfig(valid);
  assert.deepEqual(normalized.settingSources, ["project", "local"]);
  assert.equal(normalized.permissionMode, "acceptEdits");
  assert.deepEqual(normalized.models[0].efforts, ["default", "low", "medium", "high", "xhigh", "max"]);
  // No list: the built-in documentation hosts; a list replaces them ([] asks before every fetch).
  assert.equal(normalized.webFetchHosts, null);
  assert.deepEqual(normalizeClaudeProviderConfig({ ...valid, webFetchHosts: ["intranet.example.com"] }).webFetchHosts,
    ["intranet.example.com"]);
  for (const broken of [{ ...valid, schemaVersion: 2 }, { ...valid, sdkPath: "relative" },
    { ...valid, extra: true }, { ...valid, models: [] }, { ...valid, permissionMode: "bypassPermissions" },
    { ...valid, models: [{ id: "x", efforts: ["huge"] }] }, { ...valid, webFetchHosts: ["https://x.com"] },
    { ...valid, webFetchHosts: "github.com" }]) {
    assert.throws(() => normalizeClaudeProviderConfig(broken), { code: /^claude_/u });
  }
  await mkdir(path.join(root, ".project-local", "application-gateway"), { recursive: true });
  await writeFile(path.join(root, ".project-local", "application-gateway", "claude-provider.json"), JSON.stringify(valid));
  assert.equal((await readClaudeProviderConfig(root)).models[0].id, "claude-sonnet-5");
});

test("the Gateway settles a finished Claude turn at once, so the agent is idle without a reader", async (t) => {
  const root = await fixture(t);
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  for (const [scopeId, kind, quarterId] of [["p", "project", null], ["q", "quarter", "q"]]) {
    await service.store.createScope({ scopeId, kind, projectId: "p", quarterId, title: scopeId,
      operationId: `create-${scopeId}` });
  }
  await bindProjectWorkspace(service.store, { projectId: "p", workspacePath: root });
  const sdk = createFakeClaudeSdk();
  const runtime = await createClaudeProviderRuntime({ repoRoot: root, sourceId: SOURCE,
    instanceId: "claude-runtime-settle", now: () => new Date(), claude: claudeConfig({ sdk, zod: FAKE_ZOD }),
    memoryService: service, assertVisible: async () => {} });
  t.after(() => runtime.close());
  await service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a",
    profile: { provider: "claude", model: FAKE_MODEL, reasoningEffort: "default", fallbackPolicy: "deny" } });
  await service.send({ agentId: "a", operationId: "send-1", text: "Hello" });
  let operation;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Only the catalog is read: no receipt, no agent read that could observe the turn.
    operation = (await service.catalog()).value.agents[0].operations[0];
    if (operation.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(operation.state, "completed");
  assert.match(operation.settledAtUtc, /Z$/u);
  assert.equal((await service.listActivity())[0].activity.state, "idle");
  // Every turn carries the desk's tools: the memory document and the controller task tools.
  assert.deepEqual(sdk.calls[0].options.allowedTools, ["mcp__desk__write_memory_from_document",
    "mcp__desk__task_read", "mcp__desk__task_accept", "mcp__desk__task_progress",
    "mcp__desk__task_confirm_plan", "mcp__desk__task_report"]);
  const taskRead = sdk.calls[0].options.mcpServers.desk.tools.find((tool) => tool.name === "task_read");
  assert.match((await taskRead.handler({ taskId: "some-task" })).content[0].text, /not registered for controller tasks/u);
});

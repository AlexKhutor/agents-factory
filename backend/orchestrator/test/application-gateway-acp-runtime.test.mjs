import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAcpProviderFactory, normalizeAcpProviderConfig, readAcpProviderConfig } from "../src/application-gateway-acp-runtime.mjs";
import { randomUUID } from "node:crypto";
import { AcpStdioClient } from "../src/acp-stdio-client.mjs";
import { createClaudeProviderRuntime } from "../src/application-gateway-claude-runtime.mjs";
import { createProjectMemoryProviderRouter } from "../src/project-memory-provider-router.mjs";
import { createApplicationGatewayReadRuntime } from "../src/application-gateway-read-runtime.mjs";
import { bindProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { FAKE_MODEL, FAKE_MODELS, createFakeClaudeSdk, signedIn } from "./fixtures/fake-claude-sdk.mjs";

const SOURCE = "controller";
const AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-acp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId: SOURCE }));
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  for (const [scopeId, kind, quarterId] of [["p", "project", null], ["q", "quarter", "q"]]) {
    await service.store.createScope({ scopeId, kind, projectId: "p", quarterId, title: scopeId,
      operationId: `create-${scopeId}` });
  }
  await bindProjectWorkspace(service.store, { projectId: "p", workspacePath: root });
  return root;
}

const claudeConfig = () => ({ sdkPath: path.resolve("fake-sdk"), claudeConfigDir: null, keepProviderVariables: false,
  models: FAKE_MODELS, settingSources: ["project", "local"], permissionMode: "acceptEdits", sdk: createFakeClaudeSdk(),
  readAccount: signedIn, agentCommits: false });

const acpConfig = (root) => ({
  ...normalizeAcpProviderConfig({ schemaVersion: 1, command: process.execPath, args: [AGENT], home: root,
    models: [{ id: "qwen", value: "[\"p\",\"qwen\"]", displayName: "Qwen" }], agentCommits: false }),
  // The test starts the fake agent with the test's own environment.
  startClient: async () => {
    const client = new AcpStdioClient({ command: process.execPath, args: [AGENT], env: process.env });
    client.start();
    return client;
  },
});

const profile = (provider, model) => ({ provider, model, reasoningEffort: "default", fallbackPolicy: "deny" });

test("the Gateway reports both providers and routes their reads", async (t) => {
  const root = await fixture(t);
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  service.provider = { preflight: async () => {},
    create: async () => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "acp", threadId: randomUUID() }) };
  await service.createAgent({ agentId: "qwen", projectId: "p", quarterId: "q", operationId: "c-qwen",
    profile: profile("acp", "qwen") });
  const runtime = await createApplicationGatewayReadRuntime({ repoRoot: root, sourceId: SOURCE,
    instanceId: "acp-runtime-test", provider: "claude", claude: claudeConfig(),
    extraProviders: [createAcpProviderFactory(acpConfig(root))] });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.memoryStatus, { storage: "available", execution: "available" });
  assert.deepEqual(runtime.authenticationStates.map((state) => state.provider.providerId), ["claude-code-sdk", "acp-stdio"]);
  assert.ok(runtime.authenticationStates.every((state) => state.status === "authenticated"));
  assert.equal(runtime.providerStates.length, 2);
  const call = (operationId, input) => runtime.handlers[operationId]({ input });
  const resolved = await call("query.agent-conversation.resolve", { agentId: "qwen" });
  assert.deepEqual(resolved.liveRead, { status: "available", reasonCode: "available" });
  // The models of each provider are listed by the reader the request names.
  const identity = (state) => ({ adapterId: state.provider.providerId, adapterVersion: state.provider.providerVersion,
    sourceId: SOURCE, runtimeInstanceId: state.provider.runtimeInstanceId });
  const [claudeState, acpState] = runtime.authenticationStates;
  const acpModels = await call("query.provider.models.list", { provider: identity(acpState) });
  assert.deepEqual(acpModels.data.records.map((record) => record.name), ["Qwen"]);
  const claudeModels = await call("query.provider.models.list", { provider: identity(claudeState) });
  assert.ok(claudeModels.data.records.some((record) => record.name !== "Qwen"));
});

test("a Claude lead and an ACP agent work side by side, each on its own provider", async (t) => {
  const root = await fixture(t);
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: SOURCE });
  const base = { repoRoot: root, sourceId: SOURCE, instanceId: "acp-pair", now: () => new Date(),
    memoryService: service, assertVisible: async () => {} };
  const claude = await createClaudeProviderRuntime({ ...base, claude: claudeConfig(), attach: false });
  const acp = await createAcpProviderFactory(acpConfig(root))(base);
  t.after(async () => { await acp.close(); await claude.close(); });
  service.provider = createProjectMemoryProviderRouter({ claude: claude.memoryProvider, acp: acp.memoryProvider });
  await service.createAgent({ agentId: "lead", projectId: "p", quarterId: "q", operationId: "c-lead",
    profile: profile("claude", FAKE_MODEL) });
  await service.createAgent({ agentId: "qwen", projectId: "p", quarterId: "q", operationId: "c-qwen",
    profile: profile("acp", "qwen") });
  await assert.rejects(service.createAgent({ agentId: "bad", projectId: "p", quarterId: "q", operationId: "c-bad",
    profile: profile("acp", "gpt") }));
  await service.send({ agentId: "qwen", operationId: "s-qwen", text: "hello qwen" });
  // Two agents without zones share the folder one at a time: the lead's turn waits for Qwen's to end.
  const settled = async (agentId) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const agent = (await service.catalog()).value.agents.find((item) => item.agentId === agentId);
      if (agent.operations[0]?.state === "completed") return agent;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`${agentId} did not finish`);
  };
  const qwen = await settled("qwen");
  await service.send({ agentId: "lead", operationId: "s-lead", text: "hello lead" });
  const lead = await settled("lead");
  assert.equal(qwen.binding.providerId, "acp");
  assert.equal(lead.binding.providerId, "claude");
  // Write zones are held by Claude Code only, until the ACP policy is proven (A2b).
  assert.equal(service.providerFlag(qwen, "enforcesWriteZones"), false);
  assert.equal(service.providerFlag(lead, "enforcesWriteZones"), true);
});

test("without acp-provider.json the Gateway has no ACP provider; a broken one is refused", async (t) => {
  const root = await fixture(t);
  assert.equal(await readAcpProviderConfig(root), null);
  await mkdir(path.join(root, ".project-local", "application-gateway"), { recursive: true });
  await writeFile(path.join(root, ".project-local", "application-gateway", "acp-provider.json"),
    JSON.stringify({ schemaVersion: 1, command: "dsh", args: [], home: root, models: [{ id: "q" }] }));
  await assert.rejects(readAcpProviderConfig(root), { code: "acp_provider_config_invalid" });
  // An agent program that cannot start leaves Claude Code alone in the Gateway.
  const runtime = await createApplicationGatewayReadRuntime({ repoRoot: root, sourceId: SOURCE,
    instanceId: "acp-runtime-missing", provider: "claude", claude: claudeConfig(),
    extraProviders: [createAcpProviderFactory({ ...acpConfig(root), startClient: async () => { throw new Error("nope"); } })] });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.memoryStatus, { storage: "available", execution: "available" });
  assert.equal(runtime.authenticationStates.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";

import { createConversationArchive } from "../src/conversation-archive.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { ProjectMemoryService } from "../src/project-memory-service.mjs";
import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { createApplicationProjectMemoryHandlers } from "../src/application-project-memory.mjs";
import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";
import { createApplicationGatewayReadRuntime } from "../src/application-gateway-read-runtime.mjs";
import { FAKE_MODELS } from "./fixtures/fake-claude-sdk.mjs";

const sourceId = "memory-integration";
const profile = {
  provider: "fixture",
  model: "example-model-max",
  reasoningEffort: "max",
  fallbackPolicy: "deny",
};

class FixtureProvider {
  constructor() {
    this.sent = [];
    this.observed = [];
  }

  async preflight() {}

  async create(agent) {
    return {
      projectId: sourceId,
      sourceId: "memory-fixture-worker",
      providerId: "fixture",
      threadId: `thread-${agent.agentId}`,
    };
  }

  async send({ agent, operation, text }) {
    this.sent.push({ agentId: agent.agentId, operationId: operation.operationId, text });
    return { turnId: `turn-${operation.operationId}`, state: "started" };
  }

  async observe({ agent, operation }) {
    this.observed.push({ agentId: agent.agentId, operationId: operation.operationId });
    return { turnId: operation.turnId, state: "completed" };
  }

  async capture() {}
}

test("lost memory submission acknowledgement survives restart without a second send", async (t) => {
  const { now, openStore, openArchive } = await fixture(t);
  const store = await openStore(), archive = await openArchive();
  for (const [scopeId, kind, quarterId] of [
    ["project-scope", "project", null], ["quarter-scope", "quarter", "quarter-one"],
  ]) {
    await store.createScope({ scopeId, kind, projectId: "project-one", quarterId,
      title: scopeId, operationId: `create-${scopeId}` });
  }
  const provider = new FixtureProvider();
  provider.send = async ({ agent: selected, operation, text }) => {
    const persisted = await archive.read(selected.binding, { limit: 50 });
    assert.ok(persisted.items.some((item) => item.record.requestId === operation.operationId));
    provider.sent.push({ operationId: operation.operationId, text });
    throw new Error("fixture acknowledgement lost after writer entry");
  };
  const service = new ProjectMemoryService({ store, archive, provider, now });
  await service.createAgent(agent("uncertain-agent", "create-uncertain-agent"));
  const input = { agentId: "uncertain-agent", operationId: "uncertain-send", text: "Send exactly once." };
  assert.equal((await service.send(input)).state, "uncertain");
  const restarted = new ProjectMemoryService({ store: await openStore(),
    archive: await openArchive(), provider, now });
  const replay = await restarted.send(input);
  assert.equal(replay.state, "uncertain");
  assert.equal(replay.observation, "unavailable");
  await assert.rejects(restarted.send({ ...input, text: "Changed input." }),
    { code: "memory_identity_conflict" });
  await assert.rejects(restarted.send({ ...input, operationId: "another-send" }),
    { code: "memory_agent_busy" });
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.observed.length, 0);
  const offline = new ProjectMemoryService({ store: await openStore(),
    archive: await openArchive(), provider: null, now });
  assert.equal((await offline.receipt({ agentId: input.agentId,
    operationId: input.operationId })).state, "uncertain");
  const page = await offline.readArchive({ agentId: input.agentId, limit: 50 });
  assert.equal(page.items.filter((item) => item.record.requestId === input.operationId).length, 1);
});

async function fixture(t) {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "project-memory-integration-"));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(
    path.join(root, ".orchestrator", "contract.json"),
    `${JSON.stringify({ sourceId })}\n`,
    "utf8",
  );
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 14, 1, 0, tick++));
  t.after(async () => {
    const relative = path.relative(temporary, await realpath(root));
    assert.ok(relative.startsWith("project-memory-integration-") && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const openStore = () => createProjectMemoryStore({ controllerRoot: root, now });
  const openArchive = () => createConversationArchive({
    controllerRoot: root, projectId: sourceId, now,
  });
  return { root, now, openStore, openArchive };
}

function agent(agentId, operationId) {
  return {
    agentId,
    projectId: "project-one",
    quarterId: "quarter-one",
    operationId,
    profile,
  };
}

test("trusted artifact CLI requires exact confirmation and registers a pinned project file offline", async (t) => {
  const { root, openStore, openArchive, now } = await fixture(t);
  const store = await openStore();
  for (const [scopeId, kind, quarterId] of [["project-scope", "project", null], ["quarter-scope", "quarter", "quarter-one"]]) {
    await store.createScope({ scopeId, kind, projectId: "project-one", quarterId, title: scopeId, operationId: `create-${scopeId}` });
  }
  const service = new ProjectMemoryService({ store, archive: await openArchive(), provider: new FixtureProvider(), now });
  await service.createAgent(agent("artifact-agent", "create-artifact-agent"));
  const file = path.join(root, "artifact-input.json");
  const input = { agentId: "artifact-agent", artifactId: "result", path: "result.txt",
    sha256: createHash("sha256").update("result").digest("hex") };
  await writeFile(path.join(root, "result.txt"), "result");
  await writeFile(file, JSON.stringify({ projectId: "project-one", workspacePath: root }));
  await runProjectMemoryCommand({ "repo-root": root, action: "bind-workspace", "input-file": file, "confirm-project": "project-one" });
  // The trusted host reads which folder the project is bound to; binding it to
  // another folder is refused with its own code.
  await writeFile(file, JSON.stringify({ projectId: "project-one" }));
  assert.deepEqual(await runProjectMemoryCommand({ "repo-root": root, action: "read-workspace", "input-file": file }),
    { projectId: "project-one", configured: true, workspacePath: await realpath(root), available: true });
  const other = path.join(root, "other-folder");
  await mkdir(other);
  await writeFile(file, JSON.stringify({ projectId: "project-one", workspacePath: other }));
  await assert.rejects(runProjectMemoryCommand({ "repo-root": root, action: "bind-workspace", "input-file": file,
    "confirm-project": "project-one" }), { code: "memory_workspace_conflict", memoryPhase: "bind-workspace" });
  // The project has an open agent: since plan R36 its folder changes on the
  // person's confirmation while no agent of it works (project-rebind.mjs), and back.
  const moved = await runProjectMemoryCommand({ "repo-root": root, action: "rebind-workspace", "input-file": file,
    "confirm-project": "project-one" });
  assert.equal(moved.to, await realpath(other));
  await writeFile(file, JSON.stringify({ projectId: "project-one", workspacePath: root }));
  await runProjectMemoryCommand({ "repo-root": root, action: "rebind-workspace", "input-file": file,
    "confirm-project": "project-one" });
  await writeFile(file, JSON.stringify({ projectId: "project-one", workspacePath: other }));
  await assert.rejects(runProjectMemoryCommand({ "repo-root": root, action: "rebind-workspace", "input-file": file }),
    /confirm-project/);
  await writeFile(file, JSON.stringify(input));
  const options = { "repo-root": root, action: "register-artifact", "input-file": file };
  await assert.rejects(runProjectMemoryCommand(options), /confirm-agent/);
  const result = await runProjectMemoryCommand({ ...options, "confirm-agent": input.agentId });
  assert.equal(result.sha256, input.sha256); assert.equal(result.sizeBytes, 6);
  assert.deepEqual(await runProjectMemoryCommand({ ...options, "confirm-agent": input.agentId }), result);
});

test("top-level controller without child contract exposes offline memory", async (t) => {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "memory-controller-"));
  t.after(async () => {
    assert.ok(path.relative(temporary, await realpath(root)).startsWith("memory-controller-"));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "project-version.json"), JSON.stringify({ projectName: "Main_Controller", projectVersion: "v0.1.0" }));
  // The provider cannot start (no Claude Agent SDK here): memory is still read, nothing runs.
  const runtime = await createApplicationGatewayReadRuntime({ repoRoot: root,
    sourceId: "orchestrator-development", instanceId: "memory-test",
    claude: { sdkPath: path.join(root, "no-sdk-here"), claudeConfigDir: null, keepProviderVariables: false,
      models: FAKE_MODELS, settingSources: ["project", "local"], permissionMode: "acceptEdits" } });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.memoryStatus, { storage: "available", execution: "unavailable" });
  assert.equal(typeof runtime.handlers["query.memory.scope.read"], "function");
});

test("trusted host saves one confirmed edit and replays its receipt, not another revision", async (t) => {
  const { root, openStore } = await fixture(t);
  const store = await openStore();
  await store.createScope({ scopeId: "user-scope", kind: "project", projectId: "project-one",
    quarterId: null, title: "Project", operationId: "create-user-scope" });
  const input = { scopeId: "user-scope", expectedRevision: 1, entries: [
    { id: "rule", title: "Rule", text: "User-approved rule" },
  ], operationId: "save-user-rule", commandId: "user-command", actorId: "local-user" };
  const file = "user-edit.json";
  await writeFile(path.join(root, file), JSON.stringify(input));
  const options = { "repo-root": root, action: "save-user-edit", "input-file": file };
  await assert.rejects(runProjectMemoryCommand(options), /confirm-user-command/);
  assert.equal((await store.readScope({ scopeId: input.scopeId })).revision, 1);
  const confirmed = { ...options, "confirm-user-command": input.commandId };
  const result = await runProjectMemoryCommand(confirmed);
  assert.equal(result.revision, 2);
  assert.deepEqual(await runProjectMemoryCommand(confirmed), result);
  await writeFile(path.join(root, file), JSON.stringify({ ...input, entries: [] }));
  await assert.rejects(runProjectMemoryCommand(confirmed), { code: "memory_command_conflict" });
  assert.equal((await store.readScope({ scopeId: input.scopeId })).revision, 2);
  await writeFile(path.join(root, file), JSON.stringify({ ...input,
    commandId: "stale-command", operationId: "stale-write" }));
  await assert.rejects(runProjectMemoryCommand({ ...confirmed,
    "confirm-user-command": "stale-command" }), (error) => {
    assert.equal(error.code, "memory_revision_conflict");
    assert.equal(error.memoryPhase, "authorize");
    assert.equal(error.diagnosticPersisted, true);
    return true;
  });
  assert.equal((await store.readScope({ scopeId: input.scopeId })).revision, 2);
  await writeFile(path.join(root, file), JSON.stringify({ projectId: "project-one", workspacePath: root }));
  const diagnosticRoot = path.join(root, ".project-local", "memory-cli-diagnostics");
  const records = await Promise.all((await readdir(diagnosticRoot)).map(async (name) =>
    JSON.parse(await readFile(path.join(diagnosticRoot, name), "utf8"))));
  assert.ok(records.some((record) => record.code === "memory_revision_conflict"
    && record.phase === "memory-authorize" && record.action === "save-user-edit"));
  assert.doesNotMatch(JSON.stringify(records), /User-approved rule|workspacePath|stack|user-scope/);
  const bind = { ...options, action: "bind-workspace" };
  await assert.rejects(runProjectMemoryCommand(bind), /confirm-project/);
  const binding = await runProjectMemoryCommand({ ...bind, "confirm-project": "project-one" });
  assert.equal(binding.configured, true);
  assert.equal(Object.hasOwn(binding, "workspacePath"), false);
});

test("real memory, service and archive preserve authorized updates across restart", async (t) => {
  const { root, now, openStore, openArchive } = await fixture(t);
  const store = await openStore();
  const archive = await openArchive();
  await store.createScope({
    scopeId: "project-scope", kind: "project", projectId: "project-one",
    quarterId: null, title: "Integration project", operationId: "create-project",
  });
  await store.createScope({
    scopeId: "quarter-scope", kind: "quarter", projectId: "project-one",
    quarterId: "quarter-one", title: "Integration quarter", operationId: "create-quarter",
  });

  const provider = new FixtureProvider();
  const firstService = new ProjectMemoryService({ store, archive, provider, now });
  await firstService.createAgent(agent("agent-one", "create-agent-one"));
  await firstService.createAgent(agent("agent-two", "create-agent-two"));
  await firstService.send({
    agentId: "agent-one", operationId: "initial-turn", text: "Inspect the empty baseline.",
  });

  const entries = [{
    id: "shared-rule",
    title: "Shared rule",
    text: "Use the durable memory revision on the next turn.",
  }];
  const authorization = {
    commandId: "authorize-project-update",
    scopeId: "project-scope",
    expectedRevision: 1,
    entries,
    requestedBy: "integration-user",
  };
  const inputFile = "authorize-project-update.json";
  await writeFile(path.join(root, inputFile), `${JSON.stringify(authorization)}\n`, "utf8");
  await assert.rejects(runProjectMemoryCommand({
    "repo-root": root,
    action: "authorize-write",
    "input-file": inputFile,
    "confirm-user-command": "wrong-command",
  }), /invalid_argument:confirm-user-command/u);
  const grant = await runProjectMemoryCommand({
    "repo-root": root,
    action: "authorize-write",
    "input-file": inputFile,
    "confirm-user-command": authorization.commandId,
  });
  assert.equal(grant.commandId, authorization.commandId);
  const receipt = await store.write({
    scopeId: "project-scope",
    expectedRevision: 1,
    entries,
    operationId: "write-project-update",
    commandId: authorization.commandId,
    actorId: "integration-user",
  });
  assert.equal(receipt.revision, 2);

  const updateViews = await firstService.listAgents({ projectId: "project-one" });
  assert.equal(updateViews.agents.length, 2);
  assert.ok(updateViews.agents.every((item) => item.requiredManifest.project.revision === 2));
  assert.ok(updateViews.agents.every((item) => item.deliveryState === "pending"));

  const restarted = new ProjectMemoryService({
    store: await openStore(), archive: await openArchive(), provider, now,
  });
  assert.equal((await restarted.listAgents()).revision > 0, true);
  const next = await restarted.send({
    agentId: "agent-one", operationId: "next-turn", text: "Continue after the update.",
  });
  assert.equal(next.state, "started");
  const delivered = provider.sent.find((item) => item.operationId === "next-turn");
  assert.match(delivered.text, /Use the durable memory revision on the next turn\./u);
  assert.match(delivered.text, /"revision":2/u);

  const afterDelivery = await restarted.listAgents({ projectId: "project-one" });
  const one = afterDelivery.agents.find((item) => item.agentId === "agent-one");
  const two = afterDelivery.agents.find((item) => item.agentId === "agent-two");
  assert.equal(one.deliveryState, "delivered");
  assert.equal(two.deliveryState, "pending");
  assert.equal(one.requiredManifest.project.revision, 2);
  assert.equal(two.requiredManifest.project.revision, 2);

  const replay = await restarted.send({
    agentId: "agent-one", operationId: "next-turn", text: "Continue after the update.",
  });
  assert.equal(replay.state, "completed");
  assert.equal(provider.sent.filter((item) => item.operationId === "next-turn").length, 1);
  await restarted.send({
    agentId: "agent-two", operationId: "second-agent-turn", text: "Use the shared update.",
  });
  const deliveredToBoth = await restarted.listAgents({ projectId: "project-one" });
  assert.ok(deliveredToBoth.agents.every((item) => item.deliveryState === "delivered"));
  assert.ok(deliveredToBoth.agents.every((item) => item.deliveredManifest.project.revision === 2));
  assert.match(provider.sent.find((item) => item.operationId === "second-agent-turn").text,
    /Use the durable memory revision on the next turn\./u);
  assert.doesNotMatch(provider.sent.find((item) => item.operationId === "initial-turn").text,
    /Use the durable memory revision on the next turn\./u);

  await restarted.closeAgent({ agentId: "agent-one", operationId: "close-agent-one" });
  const offline = new ProjectMemoryService({
    store: await openStore(), archive: await openArchive(), provider: null, now,
  });
  const page = await offline.readArchive({ agentId: "agent-one", cursor: null, limit: 50 });
  assert.equal(page.canRestore, false);
  assert.equal(page.canSend, false);
  assert.equal(page.coverage, "captured-only");
  assert.equal((await offline.receipt({ agentId: "agent-one", operationId: "next-turn" })).state,
    "completed");
  assert.equal(provider.sent.length, 3);
  assert.ok(page.items.some((item) => item.record.text?.includes(
    "Use the durable memory revision on the next turn.",
  )));
  assert.equal((await offline.readAgent({ agentId: "agent-two" })).state, "active");
  const gateway = createApplicationGatewayBackend({ sourceId, sequence: 1,
    publishedAtUtc: now().toISOString(), epoch: "memory-test", now,
    operationHandlers: createApplicationProjectMemoryHandlers({ service: offline }) });
  for (const operationId of ["query.memory.agent.context", "query.memory.agent.archive", "query.memory.agent.read"]) {
    const result = await gateway.invokeApplication({ schemaVersion: 1, contractVersion: "v0.1.0",
      requestId: `request-${operationId}`, correlationId: "memory-test",
      operation: { schemaVersion: 1, contractVersion: "v0.1.0", family: "query", operationId },
      requestedAtUtc: now().toISOString(), input: { agentId: "agent-one" } });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
  }
});

test("trusted host sets an agent's role and write zone only with the person's confirmation", async (t) => {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "memory-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId }));
  const store = await createProjectMemoryStore({ controllerRoot: root });
  for (const [scopeId, kind, quarterId] of [["p", "project", null], ["q", "quarter", "q"]]) {
    await store.createScope({ scopeId, kind, projectId: "p", quarterId, title: scopeId, operationId: `create-${scopeId}` });
  }
  const archive = await createConversationArchive({ controllerRoot: root, projectId: sourceId });
  const service = new ProjectMemoryService({ store, archive, provider: { preflight: async () => {},
    create: async () => ({ projectId: sourceId, sourceId, providerId: "fixture", threadId: "thread-a" }) } });
  await service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  const input = { commandId: "zone-command", agentId: "a", expectedRevision: 0, role: "feature",
    writeZone: ["tools/jointsolver/**"] };
  await writeFile(path.join(root, "settings.json"), JSON.stringify(input));
  const options = { "repo-root": root, action: "set-agent-settings", "input-file": "settings.json" };
  await assert.rejects(runProjectMemoryCommand(options), /confirm-user-command/);
  const result = await runProjectMemoryCommand({ ...options, "confirm-user-command": "zone-command" });
  assert.deepEqual(result.settings.writeZone, ["tools/jointsolver/**"]);
  assert.equal((await service.readAgent({ agentId: "a" })).settings.revision, 1);

  // The permission mode: set by the trusted host for this agent, read for its window, not in the public agent.
  const read = { "repo-root": root, action: "read-permission-modes" };
  assert.deepEqual(await runProjectMemoryCommand(read), { defaultMode: null, agents: [{ agentId: "a", permissionMode: null }] });
  await writeFile(path.join(root, "mode.json"), JSON.stringify({ agentId: "a", permissionMode: "bypassPermissions" }));
  const mode = { "repo-root": root, action: "set-permission-mode", "input-file": "mode.json" };
  await assert.rejects(runProjectMemoryCommand(mode), /confirm-agent/);
  assert.deepEqual(await runProjectMemoryCommand({ ...mode, "confirm-agent": "a" }),
    { agentId: "a", permissionMode: "bypassPermissions", changed: true });
  assert.deepEqual((await runProjectMemoryCommand(read)).agents, [{ agentId: "a", permissionMode: "bypassPermissions" }]);
  assert.equal(Object.hasOwn(await service.readAgent({ agentId: "a" }), "permissionMode"), false);
  await writeFile(path.join(root, "mode.json"), JSON.stringify({ agentId: "a", permissionMode: "yolo" }));
  await assert.rejects(runProjectMemoryCommand({ ...mode, "confirm-agent": "a" }),
    { code: "memory_invalid_input", memoryPhase: "operation" });
  await writeFile(path.join(root, "mode.json"), JSON.stringify({ agentId: "a", permissionMode: null }));
  assert.equal((await runProjectMemoryCommand({ ...mode, "confirm-agent": "a" })).changed, true);
  assert.deepEqual((await runProjectMemoryCommand(read)).agents, [{ agentId: "a", permissionMode: null }]);
});

test("trusted host previews a memory document, and approves it only with the person's confirmation", async (t) => {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "memory-documents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ schemaVersion: 1, sourceId }));
  await mkdir(path.join(root, "work", "docs", "memory"), { recursive: true });
  await writeFile(path.join(root, "work", "docs", "memory", "a.md"), "## Scope\nThe joint solver.\n");
  await writeFile(path.join(root, "bind.json"), JSON.stringify({ projectId: "p", workspacePath: path.join(root, "work") }));
  await runProjectMemoryCommand({ "repo-root": root, action: "bind-workspace", "input-file": "bind.json", "confirm-project": "p" });
  const store = await createProjectMemoryStore({ controllerRoot: root });
  for (const [scopeId, kind, quarterId] of [["p", "project", null], ["q", "quarter", "q"]]) {
    await store.createScope({ scopeId, kind, projectId: "p", quarterId, title: scopeId, operationId: `create-${scopeId}` });
  }
  const archive = await createConversationArchive({ controllerRoot: root, projectId: sourceId });
  const service = new ProjectMemoryService({ store, archive, provider: { preflight: async () => {},
    create: async () => ({ projectId: sourceId, sourceId, providerId: "fixture", threadId: "thread-a" }) } });
  await service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  await writeFile(path.join(root, "preview.json"), JSON.stringify({ agentId: "a", path: "docs/memory/a.md", target: "agent" }));
  const preview = await runProjectMemoryCommand({ "repo-root": root, action: "preview-memory-document", "input-file": "preview.json" });
  assert.equal(preview.entries[0].title, "Scope");
  await writeFile(path.join(root, "approve.json"), JSON.stringify({ commandId: "doc-1", agentId: "a", path: preview.path,
    target: "agent", expectedSha256: preview.contentSha256, apply: true }));
  const options = { "repo-root": root, action: "approve-memory-document", "input-file": "approve.json" };
  await assert.rejects(runProjectMemoryCommand(options), /confirm-user-command/);
  const approved = await runProjectMemoryCommand({ ...options, "confirm-user-command": "doc-1" });
  assert.equal(approved.write.revision, 2);
  assert.deepEqual((await service.context({ agentId: "a" })).agent.entries,
    [{ id: "part-1", title: "Scope", text: "The joint solver." }]);

  // The agent's commits in its project folder: none while the folder is not under git;
  // the folder becomes a repository only with the person's confirmation of the project.
  await writeFile(path.join(root, "commits.json"), JSON.stringify({ agentId: "a" }));
  const commits = { "repo-root": root, action: "read-agent-commits", "input-file": "commits.json" };
  assert.deepEqual(await runProjectMemoryCommand(commits), { agentId: "a", versioned: false, commits: [] });
  await writeFile(path.join(root, "init.json"), JSON.stringify({ projectId: "p" }));
  const init = { "repo-root": root, action: "init-project-git", "input-file": "init.json" };
  await assert.rejects(runProjectMemoryCommand(init), /confirm-project/);
  assert.deepEqual(await runProjectMemoryCommand({ ...init, "confirm-project": "p" }),
    { projectId: "p", initialised: true, versioned: true });
  assert.deepEqual(await runProjectMemoryCommand(commits), { agentId: "a", versioned: true, commits: [] });
});

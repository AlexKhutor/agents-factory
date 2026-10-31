import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplicationAgentControlHandlers } from "../src/application-agent-control.mjs";
import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";
import { createApplicationProjectMemoryHandlers } from "../src/application-project-memory.mjs";
import { createClaudeCodeSessionJournal } from "../src/claude-code-session-journal.mjs";
import { ClaudeCodeSessionHost, createClaudeCodeProviderDescriptor } from "../src/claude-code-session-host.mjs";
import { createProjectMemoryClaude } from "../src/project-memory-claude.mjs";
import { createAgentTurnCommits } from "../src/agent-turn-commits.mjs";
import { execFileSync } from "node:child_process";
import { createProjectMemoryService } from "../src/project-memory-service.mjs";
import { settleUncertainSend } from "../src/project-send-settle.mjs";
import { createFileProviderMutationLease } from "../src/provider-mutation-lease-store.mjs";
import { bindProjectWorkspace, resolveProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { FAKE_MODEL, FAKE_MODELS, FAKE_ZOD, createFakeClaudeSdk, fakeResult, signedIn } from "./fixtures/fake-claude-sdk.mjs";
import { setName } from "../src/object-names.mjs";

const profile = { provider: "claude", model: FAKE_MODEL, reasoningEffort: "default", fallbackPolicy: "deny" };

async function fixture(t, { turns = [], readAccount = signedIn, commits = null, onCommit = () => {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-claude-"));
  // One cleanup, in order: the provider and host stop, the store bridges end,
  // then the folder goes (on Windows a database being written cannot be removed).
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"),
    JSON.stringify({ schemaVersion: 1, sourceId: "controller" }));
  const workspace = path.join(root, "work");
  await mkdir(workspace);
  const service = await createProjectMemoryService({ controllerRoot: root, sourceId: "controller" });
  for (const [scopeId, kind, quarterId] of [["p", "project", null], ["q", "quarter", "q"]]) {
    await service.store.createScope({ scopeId, kind, projectId: "p", quarterId, title: scopeId,
      operationId: `create-${scopeId}` });
  }
  await bindProjectWorkspace(service.store, { projectId: "p", workspacePath: workspace });
  const sdk = createFakeClaudeSdk({ turns });
  const host = new ClaudeCodeSessionHost({ sdk, models: FAKE_MODELS, readAccount, zod: FAKE_ZOD,
    journal: await createClaudeCodeSessionJournal({ controllerRoot: root }) });
  await host.connect();
  const descriptor = createClaudeCodeProviderDescriptor({ sourceId: "controller",
    runtimeInstanceId: "gateway-claude-test", observedAtUtc: new Date().toISOString() });
  let visible = true;
  const provider = await createProjectMemoryClaude({ host, controllerRoot: root,
    sourceId: service.archive.projectId, providerSourceId: "controller", instanceId: "test-one",
    archive: service.archive, descriptor,
    assertVisible: async () => { if (!visible) throw Object.assign(new Error(), { code: "memory_monitor_unavailable" }); },
    resolveWorkspace: (agent) => resolveProjectWorkspace(service.store, agent.projectId),
    documents: (agent, documentPath) => service.writeMemoryFromDocument({ agentId: agent.agentId, path: documentPath }),
    commits, onCommit });
  service.provider = provider;
  cleanup.push(() => provider.close(), () => host.close(), () => service.close());
  return { root, workspace, service, sdk, host, hide: () => { visible = false; } };
}

function finished(host) {
  return new Promise((resolve) => host.once("turn/completed", resolve));
}

async function settle(service, agentId, operationId) {
  // A loaded Windows machine can take a few seconds to settle two turns at once.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const receipt = await service.receipt({ agentId, operationId });
    if (["completed", "failed", "interrupted"].includes(receipt.state)) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("turn did not settle");
}

test("a desk agent on Claude Code: a session at creation, a turn per message, an exact receipt", async (t) => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q",
    operationId: "create-a", profile });
  assert.equal(agent.state, "active");
  assert.equal(agent.binding.providerId, "claude");
  assert.match(agent.binding.threadId, /^[0-9a-f-]{36}$/u);
  assert.equal(f.sdk.calls.length, 0, "creating an agent starts no turn");

  const done = finished(f.host);
  const operation = await f.service.send({ agentId: "a", operationId: "send-1", text: "Hello" });
  assert.equal(operation.state, "started");
  await done;
  const receipt = await settle(f.service, "a", "send-1");
  assert.equal(receipt.state, "completed");
  assert.equal((await f.service.readAgent({ agentId: "a" })).lastOperation.state, "completed");
  const call = f.sdk.calls[0];
  assert.equal(call.options.cwd, path.join(f.workspace));
  assert.equal(call.options.sessionId, agent.binding.threadId);
  assert.match(call.prompt.message.content, /^Backend memory snapshot\./u);
  assert.match(call.prompt.message.content, /User task:\nHello$/u);

  // The same operation again is answered from its receipt; nothing is resent.
  const again = await f.service.send({ agentId: "a", operationId: "send-1", text: "Hello" });
  assert.equal(again.state, "completed");
  assert.equal(f.sdk.calls.length, 1);

  const next = finished(f.host);
  await f.service.send({ agentId: "a", operationId: "send-2", text: "And now?" });
  await next;
  assert.equal((await settle(f.service, "a", "send-2")).state, "completed");
  assert.equal(f.sdk.calls[1].options.resume, agent.binding.threadId);

  const archive = await f.service.readArchive({ agentId: "a", limit: 100 });
  const kinds = archive.items.map((item) => `${item.record.kind}:${item.record.role ?? "-"}`);
  assert.ok(kinds.includes("submission:user"));
  assert.ok(kinds.includes("message:assistant"));
  assert.ok(kinds.includes("activity:tool"));
  assert.ok(archive.items.some((item) => item.record.kind === "delivery" && item.record.state === "completed"));
});

test("a session that never ran works after a mount without its empty turns folder; a turn not even recorded frees the agent", async (t) => {
  // Live check 2026-10-27: a project package carries files only, so the empty
  // turns folder of an agent that was never sent anything did not come back.
  const f = await fixture(t);
  const agent = await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q",
    operationId: "create-a", profile });
  const turns = path.join(f.root, ".project-local", "orchestration", "claude-sessions", agent.binding.threadId, "turns");
  await rm(turns, { recursive: true });
  const done = finished(f.host);
  assert.equal((await f.service.send({ agentId: "a", operationId: "send-1", text: "Hello" })).state, "started");
  await done;
  assert.equal((await settle(f.service, "a", "send-1")).state, "completed");

  // When the turn cannot be recorded the process never starts: the send failed, it is not uncertain.
  await rm(turns, { recursive: true });
  await writeFile(turns, "not a folder");
  const refused = await f.service.send({ agentId: "a", operationId: "send-2", text: "Again" });
  assert.equal(refused.state, "failed");
  assert.equal(refused.problemCode, "memory_send_not_started");
  assert.equal((await f.service.readAgent({ agentId: "a" })).currentOperationId, null);
  assert.equal(f.sdk.calls.length, 1);
  await rm(turns);
  const next = finished(f.host);
  assert.equal((await f.service.send({ agentId: "a", operationId: "send-3", text: "Once more" })).state, "started");
  await next;
  assert.equal((await settle(f.service, "a", "send-3")).state, "completed");
});

/** A send the service marked uncertain before it knew a turn, with its lease uncertain: as the live check left it. */
async function strand(f, agentId, operationId, { lease = true } = {}) {
  const catalog = await f.service.store.readDocument({ key: "memory-agents-v1" });
  const next = structuredClone(catalog.value);
  const agent = next.agents.find((item) => item.agentId === agentId);
  const known = agent.operations.find((op) => op.operationId === operationId);
  if (known) Object.assign(known, { state: "uncertain", turnId: null, problemCode: "memory_operation_unconfirmed" });
  else {
    agent.operations.push({ operationId, intentHash: "0".repeat(64), manifest: agent.assignedManifest, memorySnapshot: "full",
      state: "uncertain", turnId: null, requestedAtUtc: new Date().toISOString(), problemCode: "memory_operation_unconfirmed" });
  }
  agent.currentOperationId = operationId;
  assert.ok(await f.service.store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: catalog.revision, value: next }));
  if (!lease) return;
  const { lease: leases } = await createFileProviderMutationLease({ controllerRoot: f.root, projectId: f.service.archive.projectId });
  const owner = { sourceId: "controller", runtimeInstanceId: "test-one", threadId: agent.binding.threadId,
    operation: "memory.agent.send", operationId, correlationId: operationId };
  const acquired = await leases.acquire({ owner, intentSha256: "a".repeat(64) });
  await leases.release({ owner, intentSha256: "a".repeat(64), leaseId: acquired.record.leaseId, outcome: "uncertain" });
}

test("the person settles an uncertain send: no turn in the journal frees the agent, a recorded turn is taken up", async (t) => {
  const f = await fixture(t);
  await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  await f.service.createAgent({ agentId: "b", projectId: "p", quarterId: "q", operationId: "create-b", profile });
  await strand(f, "a", "stuck-1");
  // The stranded send holds the agent, the project's folder and the instance's provider lease.
  await assert.rejects(f.service.send({ agentId: "a", operationId: "send-a", text: "Hi" }), { code: "memory_agent_busy" });
  await assert.rejects(f.service.send({ agentId: "b", operationId: "send-b", text: "Hi" }), { code: "memory_workspace_busy" });

  const settleA = (operationId, extra = {}) => settleUncertainSend({ controllerRoot: f.root, store: f.service.store,
    agentId: "a", operationId, confirm: "a", ...extra });
  await assert.rejects(settleA("stuck-1", { confirm: "b" }), { code: "settle_confirmation_required" });
  const status = path.join(f.root, ".project-local", "application-gateway", "status.v1.json");
  await mkdir(path.dirname(status), { recursive: true });
  await writeFile(status, JSON.stringify({ terminal: false, identity: { process: { processId: process.pid } } }));
  await assert.rejects(settleA("stuck-1"), { code: "gateway_running" });
  await rm(status);

  const freed = await settleA("stuck-1");
  assert.equal(freed.found, null);
  assert.equal(freed.operationState, "failed");
  assert.equal(freed.leaseOutcome, "not-applied");
  assert.equal(freed.causeCode, null, "the stranded send had no provider code, and none is invented");
  assert.equal(freed.problemCode, "memory_operation_unconfirmed");
  assert.equal((await f.service.readAgent({ agentId: "a" })).currentOperationId, null);
  await assert.rejects(settleA("stuck-1"), { code: "settle_not_uncertain" });
  const done = finished(f.host);
  assert.equal((await f.service.send({ agentId: "b", operationId: "send-b2", text: "Hi" })).state, "started");
  await done;
  assert.equal((await settle(f.service, "b", "send-b2")).state, "completed");

  // A send whose turn the journal holds went: the operation gets that turn.
  await strand(f, "b", "send-b2", { lease: false });
  const taken = await settleUncertainSend({ controllerRoot: f.root, store: f.service.store, agentId: "b",
    operationId: "send-b2", confirm: "b" });
  assert.equal(taken.operationState, "completed");
  assert.equal(taken.leaseOutcome, "applied");
  assert.match(taken.found.turnId, /^[0-9a-f-]{36}$/u);
  assert.equal((await f.service.readAgent({ agentId: "b" })).currentOperationId, null);
});

test("a signed-out Claude Code, an unoffered model or a hidden monitor refuses before anything runs", async (t) => {
  const f = await fixture(t, { readAccount: async () => ({ state: "signed-out" }) });
  await assert.rejects(f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q",
    operationId: "create-a", profile }), { code: "memory_provider_unavailable" });
  await assert.rejects(f.service.createAgent({ agentId: "b", projectId: "p", quarterId: "q",
    operationId: "create-b", profile: { ...profile, model: "other-model" } }), { code: "memory_profile_conflict" });
  await assert.rejects(f.service.createAgent({ agentId: "c", projectId: "p", quarterId: "q",
    operationId: "create-c", profile: { ...profile, provider: "openai" } }), { code: "memory_provider_unavailable" });
  f.hide();
  await assert.rejects(f.service.createAgent({ agentId: "d", projectId: "p", quarterId: "q",
    operationId: "create-d", profile }), { code: "memory_monitor_unavailable" });
  assert.equal(f.sdk.calls.length, 0);
  assert.equal((await f.service.listAgents({})).agents.length, 0);
});

test("the person answers the agent's question through agent control, and the turn goes on", async (t) => {
  let decision;
  const turns = [async function* asking({ sessionId, ask }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    decision = await ask("AskUserQuestion", { questions: [{ question: "Proceed?", header: "Go",
      options: [{ label: "Yes", description: "go on" }, { label: "No", description: "stop" }] }] }, "toolu_ask1");
    yield fakeResult(sessionId);
  }];
  const f = await fixture(t, { turns });
  await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  const gateway = createApplicationGatewayBackend({ sourceId: "controller", sequence: 1, epoch: "claude-test",
    publishedAtUtc: new Date().toISOString(), operationHandlers: createApplicationAgentControlHandlers(f.service) });
  const invoke = async (operationId, input) => {
    const result = await gateway.invokeApplication({ schemaVersion: 1, contractVersion: "v0.1.0",
      requestId: "claude-test", correlationId: "claude-test", requestedAtUtc: new Date().toISOString(),
      operation: { schemaVersion: 1, contractVersion: "v0.1.0", family: operationId.split(".")[0], operationId },
      input });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
    return result.output;
  };
  const done = finished(f.host);
  await f.service.send({ agentId: "a", operationId: "send-1", text: "Ask me first" });
  let record;
  for (let attempt = 0; attempt < 200 && !record; attempt += 1) {
    record = (await invoke("query.agent-control.interactions", { agentId: "a" })).records[0];
    if (!record) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(record, "the question reached the person");
  assert.equal(record.display.kind, "user-input");
  assert.equal(record.display.fields.questions[0].question, "Proceed?");
  const agents = await f.service.listAgents({});
  assert.equal(agents.agents[0].attention.pendingQuestions, 1);
  await invoke("approval.agent-control.respond", { agentId: "a", response: {
    interactionId: record.interactionId, requestSha256: record.interactionRequest.requestSha256,
    responseId: "answer-one", operator: record.interactionRequest.owner, selectedResponse: "submit-text",
    providerResponse: { answers: { q1: { answers: ["Yes"] } } }, respondedAtUtc: new Date().toISOString() } });
  await done;
  assert.deepEqual(decision.updatedInput.answers, { "Proceed?": "Yes" });
  assert.equal((await settle(f.service, "a", "send-1")).state, "completed");
  const archive = await f.service.readArchive({ agentId: "a", limit: 100 });
  assert.ok(archive.items.some((item) => item.record.kind === "interaction"));
});

test("a stop from the desk interrupts the running turn", async (t) => {
  const turns = [async function* waiting({ sessionId, interrupted }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    await interrupted;
    yield { type: "result", subtype: "error_during_execution", session_id: sessionId, is_error: true };
  }];
  const f = await fixture(t, { turns });
  await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  const done = finished(f.host);
  await f.service.send({ agentId: "a", operationId: "send-1", text: "Work long" });
  const stop = await f.service.interrupt({ agentId: "a", operationId: "send-1" });
  assert.equal(stop.state, "accepted");
  await done;
  assert.equal((await settle(f.service, "a", "send-1")).state, "interrupted");
});

test("write zones go with every turn, and agents whose zones cannot meet share a folder at once", async (t) => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const turns = [async function* held({ sessionId }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    await gate;
    yield fakeResult(sessionId);
  }];
  const f = await fixture(t, { turns });
  for (const agentId of ["solver", "ui", "free"]) {
    await f.service.createAgent({ agentId, projectId: "p", quarterId: "q", operationId: `create-${agentId}`, profile });
  }
  const solver = await f.service.setAgentSettings({ agentId: "solver", expectedRevision: 0, role: "feature",
    writeZone: ["tools/jointsolver/**"] });
  assert.deepEqual(solver.settings.writeZone, ["tools/jointsolver/**"]);
  assert.equal(solver.settings.revision, 1);
  await assert.rejects(f.service.setAgentSettings({ agentId: "solver", expectedRevision: 0, role: "feature",
    writeZone: ["x/**"] }), { code: "memory_revision_conflict" });
  await f.service.setAgentSettings({ agentId: "ui", expectedRevision: 0, role: "feature", writeZone: ["tools/ui/**"] });

  await f.service.send({ agentId: "solver", operationId: "solver-1", text: "Fix the solver" });
  const options = f.sdk.calls[0].options;
  // Secrets and web fetches first (every agent), then the zone.
  const [secrets, fetches, hook] = options.hooks.PreToolUse[0].hooks;
  assert.equal((await secrets({ tool_name: "Read", tool_input: { file_path: path.join(f.workspace, ".env") } }))
    .hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await fetches({ tool_name: "WebFetch", tool_input: { url: "https://collect.example.net/?q=x" } }))
    .hookSpecificOutput.permissionDecision, "ask");
  assert.deepEqual(await fetches({ tool_name: "WebFetch", tool_input: { url: "https://nodejs.org/api/fs.html" } }), {});
  const refused = await hook({ tool_name: "Write", tool_input: { file_path: path.join(f.workspace, "tools", "ui", "panel.py") } });
  assert.equal(refused.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await hook({ tool_name: "Edit", tool_input: {
    file_path: path.join(f.workspace, "tools", "jointsolver", "solve.py") } }), {});
  assert.match(f.sdk.calls[0].prompt.message.content, /Your write zone in this folder: tools\/jointsolver\/\*\*\./u);

  // The UI agent's zone cannot meet the solver's: it starts while the solver works.
  const ui = await f.service.send({ agentId: "ui", operationId: "ui-1", text: "Fix the panel" });
  assert.equal(ui.state, "started");
  // An agent without a zone could change anything: it waits.
  await assert.rejects(f.service.send({ agentId: "free", operationId: "free-1", text: "Anything" }),
    { code: "memory_workspace_busy" });
  open();
  assert.equal((await settle(f.service, "solver", "solver-1")).state, "completed");
  assert.equal((await settle(f.service, "ui", "ui-1")).state, "completed");
});

test("a lead may change what it leads: the project lead the folder, the quarter lead its quarter's zones", async (t) => {
  const f = await fixture(t);
  await f.service.store.createScope({ scopeId: "other", kind: "quarter", projectId: "p", quarterId: "other",
    title: "other", operationId: "create-other" });
  for (const [agentId, quarterId] of [["lead", "q"], ["solver", "q"], ["quarter-lead", "q"], ["ui", "other"]]) {
    await f.service.createAgent({ agentId, projectId: "p", quarterId, operationId: `create-${agentId}`, profile });
  }
  await f.service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "project-lead", writeZone: null });
  await f.service.setAgentSettings({ agentId: "solver", expectedRevision: 0, role: "feature", writeZone: ["tools/solver/**"] });
  await f.service.setAgentSettings({ agentId: "ui", expectedRevision: 0, role: "feature", writeZone: ["tools/ui/**"] });
  await f.service.setAgentSettings({ agentId: "quarter-lead", expectedRevision: 0, role: "quarter-lead", writeZone: null });
  const run = async (agentId, operationId) => {
    const done = finished(f.host);
    await f.service.send({ agentId, operationId, text: "Tidy the project" });
    await done;
    await settle(f.service, agentId, operationId);
    return f.sdk.calls.at(-1);
  };
  // The project lead: the whole folder, no zone hook at all (the secret and web fetch hooks only).
  const leadCall = await run("lead", "lead-1");
  assert.equal(leadCall.options.hooks.PreToolUse[0].hooks.length, 2);
  assert.match(leadCall.prompt.message.content, /The whole project folder is yours to change\./u);
  // The quarter lead: its quarter's zones and the memory documents, nothing else.
  const quarterCall = await run("quarter-lead", "quarter-1");
  const hook = quarterCall.options.hooks.PreToolUse[0].hooks[2];
  for (const allowed of [["docs", "memory", "q.md"], ["tools", "solver", "a.py"]]) {
    assert.deepEqual(await hook({ tool_name: "Write", tool_input: { file_path: path.join(f.workspace, ...allowed) } }), {});
  }
  assert.equal((await hook({ tool_name: "Write", tool_input: {
    file_path: path.join(f.workspace, "tools", "ui", "x.py") } })).hookSpecificOutput.permissionDecision, "deny");
  assert.match(quarterCall.prompt.message.content, /docs\/memory\/\*\*, tools\/solver\/\*\*/u);
  // The project lead's folder meets every zone in it; the quarter lead's meets its quarter's only.
  const catalog = (await f.service.catalog()).value.agents;
  const byId = (agentId) => catalog.find((agent) => agent.agentId === agentId);
  assert.equal(f.service.mayCollide(byId("lead"), byId("ui"), catalog), true);
  assert.equal(f.service.mayCollide(byId("quarter-lead"), byId("solver"), catalog), true);
  assert.equal(f.service.mayCollide(byId("quarter-lead"), byId("ui"), catalog), false);
});

test("a role whose rule changed goes to an agent that already had its memory", async (t) => {
  const f = await fixture(t);
  await f.service.createAgent({ agentId: "lead", projectId: "p", quarterId: "q", operationId: "create-lead", profile });
  await f.service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "project-lead", writeZone: null });
  const run = async (operationId) => {
    const done = finished(f.host);
    await f.service.send({ agentId: "lead", operationId, text: "Go on" });
    await done;
    await settle(f.service, "lead", operationId);
    return f.sdk.calls.at(-1).prompt.message.content;
  };
  assert.match(await run("one"), /^Backend memory snapshot\./u);
  assert.match(await run("two"), /^Backend memory unchanged/u);
  // An older delivery, made before the role's text was part of it, sends the memory and the role again.
  await f.service.change((doc) => { delete doc.agents.find((agent) => agent.agentId === "lead").memoryDelivery.roleHash; });
  assert.match(await run("three"), /The whole project folder is yours to change\./u);
});

test("one lead per project and per quarter", async (t) => {
  const f = await fixture(t);
  for (const [agentId, quarterId] of [["lead", "q"], ["second", "q"], ["quarter-lead", "q"]]) {
    await f.service.createAgent({ agentId, projectId: "p", quarterId, operationId: `create-${agentId}`, profile });
  }
  await assert.rejects(f.service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "project-lead",
    writeZone: ["docs/**"] }), { code: "memory_invalid_input" });
  const lead = await f.service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "project-lead",
    writeZone: null });
  assert.equal(lead.settings.role, "project-lead");
  await assert.rejects(f.service.setAgentSettings({ agentId: "second", expectedRevision: 0, role: "project-lead",
    writeZone: null }), { code: "memory_role_taken" });
  await f.service.setAgentSettings({ agentId: "quarter-lead", expectedRevision: 0, role: "quarter-lead",
    writeZone: null });
  await assert.rejects(f.service.setAgentSettings({ agentId: "second", expectedRevision: 0, role: "quarter-lead",
    writeZone: null }), { code: "memory_role_taken" });
  const done = finished(f.host);
  await f.service.send({ agentId: "lead", operationId: "lead-1", text: "Fill the project memory" });
  await done;
  assert.match(f.sdk.calls[0].prompt.message.content, /Your role: lead of project p\./u);
});

test("an agent's own memory goes with its project and quarter memory, and again only when needed", async (t) => {
  const compacting = async function* ({ sessionId }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    yield { type: "system", subtype: "compact_boundary", session_id: sessionId };
    yield fakeResult(sessionId);
  };
  const f = await fixture(t);
  const agent = await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  assert.match(agent.agentScopeId, /^agent-memory:[0-9a-f]{32}$/u);
  const context = await f.service.context({ agentId: "a" });
  assert.deepEqual(context.agent.entries, []);
  assert.equal(context.agent.kind, "agent");
  assert.ok(context.requiredManifest.agent);
  const prompts = [];
  const say = async (operationId, text) => {
    const done = finished(f.host);
    const operation = await f.service.send({ agentId: "a", operationId, text });
    await done;
    await settle(f.service, "a", operationId);
    prompts.push(f.sdk.calls.at(-1).prompt.message.content);
    return operation;
  };
  const first = await say("send-1", "Collect the context");
  assert.equal(first.memorySnapshot, "full");
  assert.match(prompts[0], /"agent":\[\]/u);
  const second = await say("send-2", "Go on");
  assert.equal(second.memorySnapshot, "unchanged");
  // Through the Gateway's own handlers and privacy check, as the window sends: the
  // live acceptance found every send answered access_denied while its field was `memory`.
  const gateway = createApplicationGatewayBackend({ sourceId: "controller", sequence: 1, epoch: "claude-memory",
    publishedAtUtc: new Date().toISOString(), operationHandlers: createApplicationProjectMemoryHandlers({ service: f.service }) });
  const viaGateway = async (operationId, input) => {
    const result = await gateway.invokeApplication({ schemaVersion: 1, contractVersion: "v0.1.0",
      requestId: `memory-${operationId}`, correlationId: "claude-memory", requestedAtUtc: new Date().toISOString(),
      operation: { schemaVersion: 1, contractVersion: "v0.1.0", operationId,
        family: operationId.startsWith("receipt.") ? "receipt-lookup" : operationId.split(".")[0] }, input });
    assert.equal(result.outcome, "succeeded", JSON.stringify(result.error));
    return result.output;
  };
  const sentDone = finished(f.host);
  const sent = await viaGateway("mutation.memory.agent.send", { agentId: "a", operationId: "send-gw", text: "Through the Gateway" });
  assert.equal(JSON.stringify(sent).includes('"memory"'), false);
  await sentDone;
  await settle(f.service, "a", "send-gw");
  const receipt = await viaGateway("receipt.memory.agent.send", { agentId: "a", operationId: "send-gw" });
  assert.match(JSON.stringify(receipt), /"memorySnapshot":"unchanged"/u);
  assert.match(prompts[1], /^Backend memory unchanged since your last message \(manifest [0-9a-f]{64}\)\.\nUser task:\nGo on$/u);

  const entries = [{ id: "scope", title: "What I own", text: "The joint solver." }];
  await f.service.store.authorizeWrite({ commandId: "own-1", scopeId: agent.agentScopeId, expectedRevision: 1,
    entries, requestedBy: "owner" });
  await f.service.store.write({ scopeId: agent.agentScopeId, expectedRevision: 1, entries,
    operationId: "write-own-1", commandId: "own-1", actorId: "owner" });
  assert.equal((await say("send-3", "Next")).memorySnapshot, "full");
  assert.match(prompts[2], /The joint solver\./u);
  assert.equal((await say("send-4", "Next")).memorySnapshot, "unchanged");

  await f.service.setAgentSettings({ agentId: "a", expectedRevision: 0, role: "feature", writeZone: ["tools/jointsolver/**"] });
  assert.equal((await say("send-5", "Next")).memorySnapshot, "full", "a new zone goes to the agent");

  f.sdk.queue.push(compacting);
  assert.equal((await say("send-6", "Long work")).memorySnapshot, "unchanged");
  assert.equal((await say("send-7", "After the summary")).memorySnapshot, "full", "a compacted session gets memory again");
  assert.equal((await say("send-8", "Next")).memorySnapshot, "unchanged");
  const listed = await f.service.listAgents({});
  assert.equal(listed.agents[0].contentState, "partial");
  assert.equal(listed.agents[0].deliveryState, "delivered");
});

test("an archived agent keeps the memory it was last given, its own included", async (t) => {
  const f = await fixture(t);
  const agent = await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  const done = finished(f.host);
  await f.service.send({ agentId: "a", operationId: "send-1", text: "Hello" });
  await done;
  await settle(f.service, "a", "send-1");
  const entries = [{ id: "later", title: "Later", text: "Written after the last message." }];
  await f.service.store.authorizeWrite({ commandId: "own-1", scopeId: agent.agentScopeId, expectedRevision: 1,
    entries, requestedBy: "owner" });
  await f.service.store.write({ scopeId: agent.agentScopeId, expectedRevision: 1, entries,
    operationId: "write-own-1", commandId: "own-1", actorId: "owner" });
  await f.service.closeAgent({ agentId: "a", operationId: "close-a" });
  const context = await f.service.context({ agentId: "a" });
  assert.equal(context.deliveryState, "archived");
  assert.equal(context.agent.revision, 1);
  assert.deepEqual(context.agent.entries, []);
});

test("an agent's turn runs in its own permission mode, from the next turn, else in the provider's", async (t) => {
  const f = await fixture(t);
  await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  const run = async (operationId) => {
    const done = finished(f.host);
    await f.service.send({ agentId: "a", operationId, text: "Hello" });
    await done;
    await settle(f.service, "a", operationId);
    return f.sdk.calls.at(-1).options;
  };
  assert.equal((await run("send-1")).permissionMode, "acceptEdits");
  await f.service.setAgentPermissionMode({ agentId: "a", permissionMode: "bypassPermissions" });
  const bypass = await run("send-2");
  assert.equal(bypass.permissionMode, "bypassPermissions");
  assert.equal(bypass.allowDangerouslySkipPermissions, true);
  await f.service.setAgentPermissionMode({ agentId: "a", permissionMode: "default" });
  assert.equal((await run("send-3")).permissionMode, "default");
});

test("what an agent's turn wrote in its project folder becomes a commit by the agent", async (t) => {
  let folder = null;
  const writing = async function* ({ sessionId }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    await writeFile(path.join(folder, "CLAUDE.md"), "# Project rules\n");
    yield fakeResult(sessionId);
  };
  const records = [];
  let heard;
  const committed = new Promise((resolve) => { heard = resolve; });
  const f = await fixture(t, { turns: [writing], commits: createAgentTurnCommits(),
    onCommit: (record) => { records.push(record); heard(record); } });
  folder = f.workspace;
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: folder, encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet");
  await f.service.createAgent({ agentId: "lead", projectId: "p", quarterId: "q", operationId: "create-lead", profile });
  await f.service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "project-lead", writeZone: null });
  await f.service.send({ agentId: "lead", operationId: "send-1", text: "Write CLAUDE.md" });
  const record = await committed;
  assert.equal(record.state, "committed");
  assert.deepEqual(record.files, ["CLAUDE.md"]);
  assert.equal(record.operationId, "send-1");
  assert.equal(git("log", "-1", "--format=%an"), "lead");
  assert.match(git("log", "-1", "--format=%s"), /^lead: Write CLAUDE\.md$/u);
  assert.equal(records.length, 1);
});

test("an agent that was never sent anything closes, and its empty archive reads", async (t) => {
  const f = await fixture(t);
  await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  const closed = await f.service.closeAgent({ agentId: "a", operationId: "close-a" });
  assert.equal(closed.state, "archived");
  assert.equal(closed.lastOperation, null);
  // The same close again answers with the archived agent; another identity is refused.
  assert.equal((await f.service.closeAgent({ agentId: "a", operationId: "close-a" })).state, "archived");
  await assert.rejects(f.service.closeAgent({ agentId: "a", operationId: "close-b" }), { code: "memory_identity_conflict" });
  const archive = await f.service.readArchive({ agentId: "a" });
  assert.deepEqual(archive.items, []);
});

test("a lead's memory document goes into memory only as the person approved it", async (t) => {
  const replies = [];
  const usingTool = async function* ({ sessionId, options }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    replies.push((await options.mcpServers.desk.tools[0].handler({ path: "docs/memory/project.md" })).content[0].text);
    yield fakeResult(sessionId);
  };
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, "docs", "memory"), { recursive: true });
  const documentFile = path.join(f.workspace, "docs", "memory", "project.md");
  await writeFile(documentFile, "# RobotArm\n\n## Owners\nSolver: solver. UI: ui.\n\n## Style\nShort answers.\n");
  for (const agentId of ["lead", "solver"]) {
    await f.service.createAgent({ agentId, projectId: "p", quarterId: "q", operationId: `create-${agentId}`, profile });
  }
  await f.service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "project-lead", writeZone: null });
  const run = async (operationId) => {
    f.sdk.queue.push(usingTool);
    const done = finished(f.host);
    await f.service.send({ agentId: "lead", operationId, text: "Write the memory document into memory" });
    await done;
    await settle(f.service, "lead", operationId);
    return replies.at(-1);
  };

  assert.match(await run("lead-1"), /^Nothing written: the person has not approved this document/u);
  const call = f.sdk.calls[0];
  assert.ok(call.options.allowedTools.includes("mcp__desk__write_memory_from_document"));
  assert.match(call.prompt.message.content, /write_memory_from_document/u);
  await assert.rejects(f.service.previewMemoryDocument({ agentId: "solver", path: "docs/memory/project.md", target: "project" }),
    { code: "memory_document_target_denied" });
  await assert.rejects(f.service.previewMemoryDocument({ agentId: "lead", path: "../outside.md", target: "project" }),
    { code: "memory_document_path_invalid" });
  const preview = await f.service.previewMemoryDocument({ agentId: "lead", path: "docs/memory/project.md", target: "project" });
  assert.deepEqual(preview.entries.map((entry) => entry.title), ["Owners", "Style"]);
  assert.equal(preview.target.revision, 1);
  await assert.rejects(f.service.approveMemoryDocument({ commandId: "approve-0", agentId: "lead", path: preview.path,
    target: "project", expectedSha256: "0".repeat(64), apply: false }), { code: "memory_document_changed" });
  const approval = await f.service.approveMemoryDocument({ commandId: "approve-1", agentId: "lead", path: preview.path,
    target: "project", expectedSha256: preview.contentSha256, apply: false });
  assert.equal(approval.state, "approved");
  assert.equal(approval.write, null);

  assert.equal(await run("lead-2"), "Written: 2 entries into the project memory, now revision 2.");
  const project = await f.service.store.readScope({ scopeId: "p" });
  assert.equal(project.revision, 2);
  assert.equal(project.author, "lead");
  assert.deepEqual(project.entries.map((entry) => entry.text), ["Solver: solver. UI: ui.", "Short answers."]);
  assert.match(await run("lead-3"), /^Nothing written: this approval was already used/u);

  // A document changed after its approval is not written.
  const second = await f.service.previewMemoryDocument({ agentId: "lead", path: preview.path, target: "agent" });
  await f.service.approveMemoryDocument({ commandId: "approve-2", agentId: "lead", path: preview.path,
    target: "agent", expectedSha256: second.contentSha256, apply: false });
  await writeFile(documentFile, "# RobotArm\n\n## Owners\nSomeone else.\n");
  assert.match(await run("lead-4"), /^Nothing written: the document changed after the person approved it/u);

  // The person's own button writes at once, as the person.
  const third = await f.service.previewMemoryDocument({ agentId: "lead", path: preview.path, target: "agent" });
  const applied = await f.service.approveMemoryDocument({ commandId: "approve-3", agentId: "lead", path: preview.path,
    target: "agent", expectedSha256: third.contentSha256, apply: true });
  assert.equal(applied.write.revision, 2);
  const own = await f.service.store.readScope({ scopeId: (await f.service.readAgent({ agentId: "lead" })).agentScopeId });
  assert.equal(own.author, "project-owner");
});

test("leads get an overview of what they oversee, and it goes again when it changes", async (t) => {
  const f = await fixture(t);
  for (const agentId of ["lead", "solver"]) {
    await f.service.createAgent({ agentId, projectId: "p", quarterId: "q", operationId: `create-${agentId}`, profile });
  }
  await f.service.setAgentSettings({ agentId: "lead", expectedRevision: 0, role: "quarter-lead", writeZone: null });
  await f.service.setAgentSettings({ agentId: "solver", expectedRevision: 0, role: "feature", writeZone: ["tools/jointsolver/**"] });
  const say = async (operationId) => {
    const done = finished(f.host);
    const operation = await f.service.send({ agentId: "lead", operationId, text: "Status?" });
    await done;
    await settle(f.service, "lead", operationId);
    return { operation, prompt: f.sdk.calls.at(-1).prompt.message.content };
  };
  const first = await say("lead-1");
  const snapshot = JSON.parse(first.prompt.split("\n")[2]);
  assert.deepEqual(snapshot.overview, { agents: [{ agentId: "solver", name: "solver", role: "feature", model: FAKE_MODEL,
    writeZone: ["tools/jointsolver/**"], memory: [] }] });
  // Every agent knows its own name and refers to everything by ID (object-names.mjs).
  assert.match(first.prompt, /^Your name: lead \(ID lead\)\. Projects, quarters and agents have names .*refer to them by ID\.$/mu);
  assert.equal((await say("lead-2")).operation.memorySnapshot, "unchanged");
  await f.service.setAgentSettings({ agentId: "solver", expectedRevision: 1, role: "feature", writeZone: ["tools/solver/**"] });
  assert.equal((await say("lead-3")).operation.memorySnapshot, "full", "a changed overview goes to the lead");
  // A renamed agent is a changed overview too: the lead gets it with the next message.
  await setName(f.service.store, { projectId: "p", kind: "agent", objectId: "solver", name: "Grid planner" });
  const renamed = await say("lead-4");
  assert.equal(renamed.operation.memorySnapshot, "full");
  assert.equal(JSON.parse(renamed.prompt.split("\n")[2]).overview.agents[0].name, "Grid planner");
});

test("the kit's memory schema accepts what the backend now returns for Claude agents", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const schema = JSON.parse(await readFile(new URL("../schemas/application-project-memory.v1.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const fragment = (name) => ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
  const valid = (name, value) => {
    const validate = fragment(name);
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  };
  const f = await fixture(t);
  await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  await f.service.setAgentSettings({ agentId: "a", expectedRevision: 0, role: "feature", writeZone: ["tools/a/**"] });
  const done = finished(f.host);
  const operation = await f.service.send({ agentId: "a", operationId: "send-1", text: "Hello" });
  await done;
  valid("agentOperation", operation);
  valid("sendReceipt", await settle(f.service, "a", "send-1"));
  valid("agent", await f.service.readAgent({ agentId: "a" }));
  for (const agent of (await f.service.listAgents({})).agents) valid("agent", agent);
  const context = await f.service.context({ agentId: "a" });
  valid("context", context);
  valid("scope", context.agent);
  assert.equal(fragment("agent")({ ...(await f.service.readAgent({ agentId: "a" })),
    settings: { role: "boss", writeZone: null, revision: 1, updatedAtUtc: null } }), false);
});

test("an agent is working while its message runs and idle from when the backend saw it end", async (t) => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const turns = [async function* held({ sessionId }) {
    yield { type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL };
    await gate;
    yield fakeResult(sessionId);
  }];
  const f = await fixture(t, { turns });
  const created = await f.service.createAgent({ agentId: "a", projectId: "p", quarterId: "q", operationId: "create-a", profile });
  assert.deepEqual(created.activity, { state: "idle", sinceUtc: created.createdAtUtc });
  await f.service.send({ agentId: "a", operationId: "send-1", text: "Work" });
  assert.equal((await f.service.readAgent({ agentId: "a" })).activity.state, "working");
  assert.equal((await f.service.listActivity())[0].activity.state, "working");
  const done = finished(f.host);
  open();
  await done;
  const receipt = await settle(f.service, "a", "send-1");
  assert.match(receipt.settledAtUtc, /Z$/u);
  assert.deepEqual((await f.service.readAgent({ agentId: "a" })).activity,
    { state: "idle", sinceUtc: receipt.settledAtUtc });
});

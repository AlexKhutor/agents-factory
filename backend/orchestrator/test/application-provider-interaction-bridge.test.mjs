import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS,
  createApplicationProviderInteractionBridge,
} from "../src/application-provider-interaction-bridge.mjs";

const PROJECT = "agents-factory-control";
const SOURCE = "orchestrator-development";
const THREAD = "01a00a22-bfab-7e01-8978-b1b86ba89361";
const TURN = "01a0ad2e-a78a-7cb2-ad16-408835cb18b8";
const ITEM = "item-one";
const NOW = "2026-09-12T12:00:00.000Z";
const DESCRIPTOR = { identity: { adapterId: "codex-app-server", adapterVersion: "v0.5.0",
  sourceId: SOURCE, runtimeInstanceId: "gateway-app-server-one" } };

class FakeClient extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  registerServerRequestHandler(method, handler) {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }
  request(method, params, requestId = 7) {
    return this.handlers.get(method)(params, {
      requestId, method, generation: 1,
      deadlineAtUtc: "2026-09-12T13:00:00.000Z",
      signal: new AbortController().signal,
    });
  }
}

async function fixture(t, client = new FakeClient()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-interaction-"));
  await mkdir(path.join(root, ".orchestrator"), { recursive: true });
  await writeFile(path.join(root, ".orchestrator", "contract.json"),
    `${JSON.stringify({ sourceId: PROJECT })}\n`, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const archived = [];
  const changed = [];
  const bridge = await createApplicationProviderInteractionBridge({
    controllerRoot: root, projectId: PROJECT, client, descriptor: DESCRIPTOR,
    target: { sourceId: SOURCE, threadId: THREAD },
    conversationId: `conversation:${"a".repeat(64)}`,
    archive: { recordInteraction: async (record) => { archived.push(record); } },
    onChanged: (record) => changed.push(record),
    now: () => new Date(NOW),
  });
  return { root, client, bridge, archived, changed };
}

async function pendingRecord(bridge, predicate = () => true) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const page = await bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read]({
      input: { limit: 8 },
    });
    const record = page.records.find(predicate);
    if (record) return record;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("interaction_not_published");
}

test("two exact thread bridges share one native client without stealing requests", async (t) => {
  const f = await fixture(t);
  const other = await createApplicationProviderInteractionBridge({ controllerRoot: f.root,
    projectId: PROJECT, client: f.client, descriptor: DESCRIPTOR,
    target: { sourceId: SOURCE, threadId: "second-thread" },
    conversationId: `conversation:${"b".repeat(64)}`, now: () => new Date(NOW) });
  t.after(async () => { await f.bridge.close(); await other.close(); });
  const params = { threadId: THREAD, turnId: TURN, itemId: ITEM, command: "read-only fixture", cwd: null, reason: null };
  const first = f.client.request("item/commandExecution/requestApproval", params, 101);
  const second = f.client.request("item/commandExecution/requestApproval", { ...params, threadId: "second-thread" }, 102);
  const a = await pendingRecord(f.bridge), b = await pendingRecord(other);
  assert.equal(a.providerRequest.threadId, THREAD);
  assert.equal(b.providerRequest.threadId, "second-thread");
  const response = (r) => ({ interactionId: r.interactionId, requestSha256: r.interactionRequest.requestSha256,
    responseId: `response-${r.providerRequest.requestId}`, operator: r.interactionRequest.owner,
    selectedResponse: "decline", providerResponse: { decision: "decline" }, respondedAtUtc: NOW });
  await assert.rejects(other.respond(response(a)));
  await f.bridge.respond(response(a)); await other.respond(response(b));
  assert.deepEqual(await first, { decision: "decline" });
  assert.deepEqual(await second, { decision: "decline" });
  await f.bridge.close();
  assert.equal(f.client.handlers.size, 5);
  assert.throws(() => f.client.request("item/commandExecution/requestApproval", { ...params, threadId: "unbound" }), /Unbound/);
});

test("command approval is persisted, identity-bound and returned exactly once", async (t) => {
  const { client, bridge, archived, changed } = await fixture(t);
  const provider = client.request("item/commandExecution/requestApproval", {
    itemId: ITEM, startedAtMs: Date.parse(NOW), threadId: THREAD, turnId: TURN,
    command: "git status --short", cwd: "E:/project", reason: "Inspect status",
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
  });
  const record = await pendingRecord(bridge);
  assert.equal(record.providerRequest.threadId, THREAD);
  assert.equal(record.providerRequest.turnId, TURN);
  assert.equal(record.providerRequest.itemId, ITEM);
  assert.equal(record.providerRequest.generation, 1);
  assert.equal(record.state, "awaiting-owner");
  assert.deepEqual(record.interactionRequest.allowedResponses, ["accept", "cancel", "decline"]);
  const input = {
    interactionId: record.interactionId,
    requestSha256: record.interactionRequest.requestSha256,
    responseId: "provider-response-one",
    operator: record.interactionRequest.owner,
    selectedResponse: "accept",
    providerResponse: { decision: "accept" },
    respondedAtUtc: NOW,
  };
  const receipt = await bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.respond]({ input });
  assert.equal(receipt.receipt.automaticRetryAllowed, false);
  assert.deepEqual(await provider, { decision: "accept" });
  await assert.rejects(
    bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.respond]({ input }),
    (error) => error.code === "conflict",
  );
  assert.equal(archived[0].interactionId, record.interactionId);
  assert.ok(archived.some((entry) => entry.phase === "response"));
  assert.equal((await bridge.summary()).pendingApprovals, 0);
  assert.ok(changed.length >= 3);
  assert.deepEqual(Object.keys(changed[0]).sort(), ["itemId", "threadId", "turnId"]);
  client.emit("exit", { code: 1 });
  await assert.rejects(bridge.summary(), { code: "source_unavailable" });
  await bridge.close();
});

test("file, question, permission and MCP responses preserve their exact native shapes", async (t) => {
  const { client, bridge } = await fixture(t);
  const cases = [
    {
      method: "item/fileChange/requestApproval",
      params: { itemId: "file-item", startedAtMs: Date.parse(NOW), threadId: THREAD,
        turnId: TURN, reason: "Apply the bounded patch", grantRoot: null },
      selectedResponse: "decline", providerResponse: { decision: "decline" },
    },
    {
      method: "item/tool/requestUserInput",
      params: { isBlocking: true, itemId: "question-item", threadId: THREAD, turnId: TURN,
        questions: [{ id: "target", header: "Target", question: "Which target?",
          isOther: true, isSecret: true, options: null }] },
      selectedResponse: "submit-text",
      providerResponse: { answers: { target: { answers: ["private-answer"] } } },
    },
    {
      method: "item/permissions/requestApproval",
      params: { cwd: "E:/project", itemId: "permission-item",
        permissions: { network: { enabled: true }, fileSystem: null },
        reason: "Access the requested host", startedAtMs: Date.parse(NOW),
        threadId: THREAD, turnId: TURN },
      selectedResponse: "grant",
      providerResponse: { permissions: { fileSystem: null, network: { enabled: true } },
        scope: "turn", strictAutoReview: false },
    },
    {
      method: "mcpServer/elicitation/request",
      params: { serverName: "example-mcp", threadId: THREAD, turnId: TURN,
        mode: "form", message: "Choose a value",
        requestedSchema: { type: "object", properties: { value: { type: "string" } } } },
      selectedResponse: "accept",
      providerResponse: { action: "accept", content: { value: "bounded" } },
    },
  ];
  let requestId = 20;
  for (const item of cases) {
    const provider = client.request(item.method, item.params, requestId);
    const record = await pendingRecord(bridge, (candidate) => candidate.state === "awaiting-owner");
    const result = await bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.respond]({
      input: {
        interactionId: record.interactionId,
        requestSha256: record.interactionRequest.requestSha256,
        responseId: `provider-response-${requestId}`,
        operator: record.interactionRequest.owner,
        selectedResponse: item.selectedResponse,
        providerResponse: item.providerResponse,
        respondedAtUtc: NOW,
      },
    });
    assert.deepEqual(await provider, item.providerResponse);
    assert.equal(result.interaction.providerRequest.method, item.method);
    assert.equal(result.interaction.state, "response-returned");
    assert.equal(result.receipt.deliveryState, "response-returned");
    requestId += 1;
  }
  const page = await bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read]({
    input: { limit: 8 },
  });
  assert.equal(page.records.length, cases.length);
  assert.equal(JSON.stringify(page).includes("private-answer"), false);
  assert.deepEqual(new Set(page.records.map((record) => record.providerRequest.method)),
    new Set(cases.map((item) => item.method)));
  await bridge.close();
});

test("restart stales an unanswered provider question and never synthesizes a response", async (t) => {
  const firstClient = new FakeClient();
  const first = await fixture(t, firstClient);
  void firstClient.request("item/tool/requestUserInput", {
    isBlocking: true, itemId: ITEM, threadId: THREAD, turnId: TURN,
    questions: [{ id: "choice", header: "Choice", question: "Continue?",
      options: [{ label: "Yes", description: "Continue" }] }],
  });
  const original = await pendingRecord(first.bridge);
  await first.bridge.close();
  const secondClient = new FakeClient();
  const second = await createApplicationProviderInteractionBridge({
    controllerRoot: first.root, projectId: PROJECT, client: secondClient,
    descriptor: { identity: { ...DESCRIPTOR.identity,
      runtimeInstanceId: "gateway-app-server-two" } },
    target: { sourceId: SOURCE, threadId: THREAD },
    conversationId: `conversation:${"a".repeat(64)}`, now: () => new Date(NOW),
  });
  const recovered = await pendingRecord(second);
  assert.equal(recovered.interactionId, original.interactionId);
  assert.equal(recovered.state, "stale");
  assert.equal(secondClient.handlers.size, 5);
  await second.close();
});

test("provider interaction records are isolated by exact archive conversation", async (t) => {
  const first = await fixture(t);
  void first.client.request("item/fileChange/requestApproval", {
    itemId: ITEM, threadId: THREAD, turnId: TURN, reason: "First conversation",
  });
  await pendingRecord(first.bridge);
  await first.bridge.close();
  const isolated = await createApplicationProviderInteractionBridge({
    controllerRoot: first.root, projectId: PROJECT, client: new FakeClient(),
    descriptor: DESCRIPTOR, target: { sourceId: SOURCE, threadId: THREAD },
    conversationId: `conversation:${"b".repeat(64)}`, now: () => new Date(NOW),
  });
  const page = await isolated.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read]({
    input: { limit: 8 },
  });
  assert.equal(page.sourceSequence, 0);
  assert.deepEqual(page.records, []);
  const scopes = await readdir(path.join(first.root, ".project-local", "orchestration",
    "provider-interactions"));
  assert.equal(scopes.length, 2);
  await isolated.close();
});

test("restart recovers unanswered evidence older than the bounded recent index", async (t) => {
  const firstClient = new FakeClient();
  const first = await fixture(t, firstClient);
  void firstClient.request("item/fileChange/requestApproval", {
    itemId: "oldest-item", startedAtMs: Date.parse(NOW), threadId: THREAD, turnId: TURN,
    reason: "Oldest request",
  }, 100);
  const oldest = await pendingRecord(first.bridge);
  for (let index = 1; index < 129; index += 1) {
    void firstClient.request("item/fileChange/requestApproval", {
      itemId: `item-${index}`, startedAtMs: Date.parse(NOW),
      threadId: THREAD, turnId: TURN, reason: `Request ${index}`,
    }, 100 + index);
  }
  let sequence = 0;
  for (let attempt = 0; attempt < 2000 && sequence < 129; attempt += 1) {
    const page = await first.bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read]({
      input: { limit: 1 },
    });
    sequence = page.sourceSequence;
    if (sequence < 129) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(sequence, 129);
  const summary = await first.bridge.summary();
  assert.equal(summary.availability, "available");
  assert.equal(summary.pendingApprovals, 129);
  assert.equal(summary.pendingQuestions, 0);
  assert.equal(summary.recoveryRequired, 0);
  assert.equal(summary.sourceSequence, 129);
  await first.bridge.close();
  await assert.rejects(first.bridge.summary(), { code: "source_unavailable" });
  const stateRoot = path.join(first.root, ".project-local", "orchestration",
    "provider-interactions");
  const scopes = await readdir(stateRoot);
  assert.equal(scopes.length, 1);
  const second = await createApplicationProviderInteractionBridge({
    controllerRoot: first.root, projectId: PROJECT, client: new FakeClient(),
    descriptor: DESCRIPTOR, target: { sourceId: SOURCE, threadId: THREAD },
    conversationId: `conversation:${"a".repeat(64)}`, now: () => new Date(NOW),
  });
  const fileName = `${createHash("sha256").update(oldest.interactionId).digest("hex")}.json`;
  const recovered = JSON.parse(await readFile(path.join(
    stateRoot, scopes[0], "records.v1", fileName,
  ), "utf8"));
  assert.equal(recovered.interactionId, oldest.interactionId);
  assert.equal(recovered.interactionRequest.sourceSequence, 1);
  assert.equal(recovered.state, "stale");
  const latest = await second.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read]({
    input: { limit: 64 },
  });
  assert.equal(latest.sourceSequence, 129);
  assert.equal(latest.records.length, 64);
  assert.equal(latest.truncated, true);
  assert.equal(latest.omissionCount, 65);
  assert.equal((await second.summary()).recoveryRequired, 129);
  assert.equal((await second.summary()).pendingApprovals, 0);
  assert.ok(latest.records.every((record) => record.state === "stale"));
  await second.close();
});

test("portable provider interaction schema accepts read and response results", async (t) => {
  const { client, bridge } = await fixture(t);
  const provider = client.request("item/commandExecution/requestApproval", {
    itemId: ITEM, startedAtMs: Date.parse(NOW), threadId: THREAD, turnId: TURN,
    command: "git status --short", cwd: "E:/project", reason: "Inspect status",
  }, 90);
  const record = await pendingRecord(bridge);
  const page = await bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read]({
    input: { limit: 8 },
  });
  const result = await bridge.handlers[APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.respond]({
    input: {
      interactionId: record.interactionId,
      requestSha256: record.interactionRequest.requestSha256,
      responseId: "provider-schema-response",
      operator: record.interactionRequest.owner,
      selectedResponse: "accept",
      providerResponse: { decision: "accept" },
      respondedAtUtc: NOW,
    },
  });
  assert.deepEqual(await provider, { decision: "accept" });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-actor-ref.schema.json",
    "application-resource-ref.schema.json",
    "application-interaction-request.schema.json",
    "application-interaction-response.schema.json",
    "application-provider-interaction.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(
      new URL(`../schemas/${name}`, import.meta.url), "utf8",
    )));
  }
  const validate = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-provider-interaction.v1.json",
  );
  assert.equal(validate(page), true, JSON.stringify(validate.errors));
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  const expanded = structuredClone(result);
  expanded.receipt.retry = true;
  assert.equal(validate(expanded), false);
  await bridge.close();
});

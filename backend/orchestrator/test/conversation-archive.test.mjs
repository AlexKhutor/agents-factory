import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import {
  ConversationArchive, conversationArchiveIdentity, createConversationArchive,
  validateConversationArchiveRecord,
} from "../src/conversation-archive.mjs";
import { CodexConversationArchive } from "../src/codex-conversation-archive.mjs";
import { createApplicationConversationArchiveHandlers } from "../src/application-conversation-archive.mjs";
import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";
import { sqliteBackendOf, sqliteBackendTest as test } from "./fixtures/sqlite-backends/helpers.mjs";

const binding = { projectId: "controller", sourceId: "worker", providerId: "codex", threadId: "thread/opaque" };
function message(recordId, text = "visible message") {
  return { recordId, kind: "message", role: "user", state: "requested", text,
    providerTurnId: null, providerItemId: null, requestId: recordId,
    occurredAtUtc: null, omissions: [] };
}

test("notification capture is scoped, drains on close and exposes failures without payloads", async (t) => {
  const { archive } = await fixture(t);
  const client = new EventEmitter();
  const capture = new CodexConversationArchive({ archive, binding, client });
  capture.observe();
  const item = { id: "tool", type: "commandExecution", command: "node --version",
    aggregatedOutput: "v20.19.1", exitCode: 0, status: "completed" };
  client.emit("item/completed", { threadId: "wrong", turnId: "turn", item });
  client.emit("item/completed", { threadId: binding.threadId, turnId: "turn", item });
  client.emit("turn/completed", { threadId: binding.threadId, turn: { id: "turn", status: "completed" } });
  await capture.flush();
  const page = await archive.read(binding);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every(({ record }) => record.state === "completed"));
  archive.append = async () => { throw new Error("private provider body"); };
  client.emit("item/completed", { threadId: binding.threadId, turnId: "turn", item });
  await assert.rejects(capture.flush(), { code: "archive_capture_unavailable" });
  assert.deepEqual(capture.captureStatus, {
    status: "unavailable", reasonCode: "archive_capture_failed",
    synchronization: {
      state: "not-started", pagesImported: 0, capturedRecords: 0,
      checkpointRevision: 0, exhausted: false,
    },
  });
  await assert.rejects(capture.recordOutgoing({ requestId: "next", text: "blocked" }), {
    code: "archive_capture_unavailable",
  });
  await capture.close();
  assert.equal(client.listenerCount("turn/completed"), 0);
});
async function fixture(t) {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "conversation-archive-test-"));
  t.after(async () => {
    const relative = path.relative(temporary, await realpath(root));
    assert.ok(relative.startsWith("conversation-archive-test-") && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator/contract.json"), JSON.stringify({ sourceId: "controller" }));
  const sqliteBackend = sqliteBackendOf(t);
  const open = async () => {
    const archive = await createConversationArchive({ controllerRoot: root, projectId: "controller", sqliteBackend });
    assert.equal(archive.sqliteBackend, sqliteBackend);
    return archive;
  };
  return { root, open, archive: await open() };
}

test("archive retains exact text independently of any provider across restart", async (t) => {
  const { archive, open } = await fixture(t);
  const saved = await archive.append(binding, message("request-1", "Text stored before provider submission."));
  assert.equal(saved.replay, false);
  assert.equal(JSON.stringify(saved).includes("Text stored"), false);
  const restarted = await open();
  const page = await restarted.read(binding);
  assert.equal(page.items[0].record.text, "Text stored before provider submission.");
  assert.equal(page.coverage, "captured-only");
  assert.equal(page.nextCursor, null);
  assert.equal(page.conversationId, saved.conversationId);
});

test("archive public responses validate and UTF-8 content survives the Windows Python bridge", async (t) => {
  const { archive } = await fixture(t);
  const text = "\u041f\u0440\u0438\u0432\u0435\u0442 \u4e16\u754c \ud83d\udc4b e\u0301";
  await archive.append(binding, message("unicode", text));
  const handlers = createApplicationConversationArchiveHandlers({ archive, binding });
  const resolved = await handlers["query.conversation.archive.resolve"]({ input: {} });
  const page = await handlers["query.conversation.archive.read"]({
    input: { conversationId: resolved.conversationId },
  });
  const schema = JSON.parse(await readFile(new URL("../schemas/application-conversation-archive.schema.json", import.meta.url)));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.ok(validate(resolved), JSON.stringify(validate.errors));
  assert.ok(validate(page), JSON.stringify(validate.errors));
  assert.equal(page.items[0].record.text, text);
  assert.equal(page.binding, undefined);
  const backend = createApplicationGatewayBackend({ sourceId: "controller", epoch: "archive-test",
    publishedAtUtc: new Date().toISOString(), operationHandlers: handlers });
  const result = await backend.invokeApplication({ schemaVersion: 1, contractVersion: "v0.1.0",
    requestId: "archive-read", correlationId: "archive-read", requestedAtUtc: new Date().toISOString(),
    operation: { schemaVersion: 1, contractVersion: "v0.1.0", family: "query",
      operationId: "query.conversation.archive.read" },
    input: { conversationId: resolved.conversationId } });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.output.items[0].record.text, text);
  assert.deepEqual(result.diagnostics, []);
});

test("provider-neutral bindings isolate providers, sources and opaque thread IDs", async (t) => {
  const { archive } = await fixture(t);
  const scopes = [binding, { ...binding, providerId: "fake-qwen" },
    { ...binding, threadId: "another-chat" }, { ...binding, sourceId: "second-worker" }];
  for (const [index, scope] of scopes.entries()) await archive.append(scope, message("same-id", `scope-${index}`));
  assert.equal(new Set(scopes.map(conversationArchiveIdentity)).size, 4);
  for (const [index, scope] of scopes.entries()) {
    assert.deepEqual((await archive.read(scope)).items.map((item) => item.record.text), [`scope-${index}`]);
  }
  await assert.rejects(archive.read({ ...binding, projectId: "foreign" }), { code: "archive_identity_conflict" });
});

test("snapshot pages cannot mix later edits or messages into an existing revision", async (t) => {
  const { archive } = await fixture(t);
  await archive.append(binding, message("a", "first"));
  await archive.append(binding, message("b", "old"));
  const first = await archive.read(binding, { limit: 1 });
  await archive.append(binding, message("b", "new"));
  await archive.append(binding, message("c", "later"));
  const second = await archive.read(binding, { cursor: first.nextCursor, limit: 1 });
  assert.equal(second.revision, first.revision);
  assert.equal(second.items[0].record.text, "old");
  assert.equal(second.nextCursor, null);
  const current = await archive.read(binding);
  assert.deepEqual(current.items.map((item) => item.record.text), ["first", "new", "later"]);
  await assert.rejects(archive.read({ ...binding, providerId: "fake-qwen" }, { cursor: first.nextCursor }),
    { code: "archive_invalid_cursor" });
});

test("concurrent exact observations append once and changed observations retain a revision", async (t) => {
  const { archive, open } = await fixture(t);
  const other = await open();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    (i % 2 ? archive : other).append(binding, message("one"))));
  assert.equal(results.filter((result) => !result.replay).length, 1);
  assert.equal(new Set(results.map((result) => result.sequence)).size, 1);
  const updated = await archive.append(binding, { ...message("one"), state: "accepted" });
  assert.ok(updated.sequence > results[0].sequence);
  const current = await archive.read(binding);
  assert.equal(current.items.length, 1);
  assert.equal(current.items[0].record.state, "accepted");
});

test("invalid/private-shaped records never reach the store and failures expose no payload", async () => {
  let calls = 0;
  const archive = new ConversationArchive({ projectId: "controller", store: {
    async invoke() { calls++; throw Object.assign(new Error("private transcript"), {
      stderr: "private transcript", stdout: "private transcript",
    }); },
  } });
  for (const record of [
    { ...message("a"), reasoning: "private" },
    { ...message("a"), kind: "reasoning" },
    message("a", "x".repeat(262_145)),
    message("a", "data:" + "image/png;" + "base64,fixture"),
  ]) await assert.rejects(archive.append(binding, record), { code: "archive_invalid_input" });
  assert.equal(calls, 0);
  await assert.rejects(archive.append(binding, message("a")), (error) => {
    assert.equal(error.code, "archive_unavailable");
    assert.equal(error.message.includes("private"), false);
    assert.equal(error.stderr, undefined);
    assert.equal(error.stdout, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test("page byte budgets preserve continuation instead of dropping large messages", async (t) => {
  const { archive } = await fixture(t);
  const text = "x".repeat(262_144);
  await archive.append(binding, message("a", text));
  await archive.append(binding, message("b", text));
  const first = await archive.read(binding);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await archive.read(binding, { cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].record.recordId, "b");
  assert.equal(second.nextCursor, null);
});

test("explicit omissions stay body-free and invalid cursors fail closed", async (t) => {
  const { archive } = await fixture(t);
  const omitted = { ...message("omitted"), kind: "omission", role: null,
    text: null, state: "unknown", omissions: ["hidden_reasoning"] };
  validateConversationArchiveRecord(omitted);
  await archive.append(binding, omitted);
  const page = await archive.read(binding);
  assert.equal(page.items[0].record.text, null);
  assert.deepEqual(page.items[0].record.omissions, ["hidden_reasoning"]);
  await assert.rejects(archive.read(binding, { cursor: "broken" }), { code: "archive_invalid_cursor" });
  await assert.rejects(archive.read(binding, { limit: 0 }), { code: "archive_invalid_input" });
});

test("a corrupt database fails closed without touching provider files", async (t) => {
  const { archive, root } = await fixture(t);
  const database = path.join(root, ".project-local/orchestration/conversation-archive/archive.v1.sqlite");
  await writeFile(database, "not a database");
  await assert.rejects(archive.read(binding), { code: "archive_unavailable" });
  assert.equal(await readFile(database, "utf8"), "not a database");
});

test("Codex public-page import preserves messages and commands without private history", async (t) => {
  const { archive, open } = await fixture(t);
  const calls = [];
  const client = {
    async readThread(threadId, includeTurns) {
      calls.push(["read", threadId, includeTurns]); return { thread: { id: threadId } };
    },
    async listThreadTurns(threadId, options) {
      calls.push(["page", threadId, options]);
      return { data: [{ id: "turn-one", status: "completed", items: [
        { id: "user", type: "userMessage", clientId: "request-one", content: [{ type: "text", text: "hello" }] },
        { id: "agent", type: "agentMessage", text: "answer" },
        { id: "cmd", type: "commandExecution", command: "node --version", aggregatedOutput: "v20.19.1", exitCode: 0 },
        { id: "private", type: "reasoning", text: "must not archive" },
      ] }], nextCursor: "second-page" };
    },
  };
  const adapter = new CodexConversationArchive({ archive, binding, client });
  await adapter.recordOutgoing({ requestId: "request-one", text: "hello" });
  const imported = await adapter.importPage();
  assert.equal(imported.capturedRecords, 4);
  assert.equal(imported.nextCursor, "second-page");
  assert.equal(imported.coverage, "provider-page");
  assert.equal((await adapter.importPage()).capturedRecords, 0);
  const restarted = await open();
  const records = (await restarted.read(binding)).items.map((item) => item.record);
  assert.equal(records.length, 5);
  assert.equal(records.filter((record) => record.kind === "submission").length, 1);
  assert.equal(records.filter((record) => record.kind === "message").length, 2);
  assert.ok(records.some((record) => record.text?.includes("node --version")));
  assert.equal(JSON.stringify(records).includes("must not archive"), false);
  assert.deepEqual(records.at(-1).omissions, ["hidden_reasoning"]);
  assert.ok(calls.every(([, threadId]) => threadId === binding.threadId));
  assert.equal(calls[1][2].sortDirection, "asc");
});

test("archive submission identity is immutable while provider echoes are separate facts", async (t) => {
  const { archive } = await fixture(t);
  const adapter = new CodexConversationArchive({ archive, binding, client: {} });
  await adapter.recordOutgoing({ requestId: "one", text: "original" });
  await assert.rejects(adapter.recordOutgoing({ requestId: "one", text: "changed" }),
    { code: "archive_identity_conflict" });
  await adapter.recordItem({ id: "turn", status: "completed" },
    { id: "item", type: "userMessage", clientId: "one", content: [] });
  const page = await archive.read(binding);
  assert.equal(page.items[0].record.text, "original");
  await assert.rejects(archive.append(binding, {
    ...page.items[0].record, kind: "message", text: "replace through another kind",
  }), { code: "archive_identity_conflict" });
  assert.equal(page.items[1].record.text, null);
  assert.deepEqual(page.items[1].record.omissions, ["content_not_provided"]);
});

test("unavailable or foreign provider reads never prevent reading the captured archive", async (t) => {
  const { archive } = await fixture(t);
  const client = { async readThread() { throw new Error("private provider detail"); } };
  const adapter = new CodexConversationArchive({ archive, binding, client });
  await adapter.recordOutgoing({ requestId: "one", text: "offline text" });
  await assert.rejects(adapter.importPage(), { code: "archive_provider_unavailable" });
  assert.equal((await archive.read(binding)).items[0].record.text, "offline text");
  client.readThread = async () => ({ thread: { id: "foreign" } });
  await assert.rejects(adapter.importPage(), { code: "archive_identity_conflict" });
});

function importClient(pages) {
  return {
    calls: [],
    async readThread(threadId) { return { thread: { id: threadId } }; },
    async listThreadTurns(_threadId, options) {
      this.calls.push(options.cursor ?? null);
      return structuredClone(pages[options.cursor ?? "first"]);
    },
  };
}
function importTurn(id) {
  return { id, status: "completed", items: [{ id: `item-${id}`, type: "agentMessage", text: id }] };
}

test("backfill resumes after restart and requires explicit restart after page exhaustion", async (t) => {
  const { archive, open } = await fixture(t);
  const client = importClient({ first: { data: [importTurn("one")], nextCursor: "private-cursor" },
    "private-cursor": { data: [importTurn("two")], nextCursor: null } });
  const first = new CodexConversationArchive({ archive, binding, client });
  const result = await first.importNextPage();
  assert.equal(result.exhausted, false);
  assert.equal(JSON.stringify(result).includes("private-cursor"), false);
  const reopened = await open();
  const second = new CodexConversationArchive({ archive: reopened, binding, client });
  assert.equal((await second.importNextPage()).exhausted, true);
  assert.deepEqual(client.calls, [null, "private-cursor"]);
  assert.equal((await second.importNextPage()).capturedRecords, 0);
  assert.equal(client.calls.length, 2);
  assert.equal((await reopened.read(binding)).items.length, 2);
  assert.equal((await second.importNextPage({ restart: true })).capturedRecords, 0);
  assert.equal(client.calls[2], null);
});

test("automatic synchronization resumes partial scans and rechecks an exhausted history", async (t) => {
  const { archive, open } = await fixture(t);
  const client = importClient({
    first: { data: [importTurn("one")], nextCursor: "private-cursor" },
    "private-cursor": { data: [importTurn("two")], nextCursor: null },
  });
  const first = new CodexConversationArchive({ archive, binding, client });
  assert.deepEqual(await first.synchronize({ maxPages: 1 }), {
    state: "partial", pagesImported: 1, capturedRecords: 1,
    checkpointRevision: 1, exhausted: false,
  });
  const second = new CodexConversationArchive({ archive: await open(), binding, client });
  assert.equal((await second.synchronize()).state, "caught-up");
  assert.deepEqual(client.calls, [null, "private-cursor"]);
  const third = new CodexConversationArchive({ archive: await open(), binding, client });
  const refreshed = await third.synchronize();
  assert.equal(refreshed.state, "caught-up");
  assert.equal(refreshed.capturedRecords, 0);
  assert.equal(client.calls[2], null);
});

test("partial page failure never advances the checkpoint and retry deduplicates saved items", async (t) => {
  const { archive } = await fixture(t);
  const turn = importTurn("first");
  turn.items.push({ type: "agentMessage", text: "invalid missing id" });
  const pages = { first: { data: [turn], nextCursor: null } };
  const capture = new CodexConversationArchive({ archive, binding, client: importClient(pages) });
  await assert.rejects(capture.importNextPage(), { code: "archive_invalid_provider_page" });
  assert.equal((await archive.readImportCheckpoint(binding)).revision, 0);
  assert.equal((await archive.read(binding)).items.length, 1);
  turn.items[1].id = "second";
  assert.equal((await capture.importNextPage()).capturedRecords, 1);
  assert.equal((await archive.read(binding)).items.length, 2);
});

test("checkpoint acknowledgement loss resumes from committed state without fetching again", async (t) => {
  const { archive, open } = await fixture(t);
  const client = importClient({ first: { data: [importTurn("one")], nextCursor: null } });
  const checkpoint = archive.checkpointImport.bind(archive);
  archive.checkpointImport = async (...args) => { await checkpoint(...args); throw new Error("lost local acknowledgement"); };
  await assert.rejects(new CodexConversationArchive({ archive, binding, client }).importNextPage());
  const restarted = new CodexConversationArchive({ archive: await open(), binding, client });
  assert.equal((await restarted.importNextPage()).exhausted, true);
  assert.equal(client.calls.length, 1);
});

test("import checkpoints use compare-and-swap and remain conversation-scoped", async (t) => {
  const { archive, open } = await fixture(t);
  const second = await open();
  const results = await Promise.all([archive, second].map((store) => store.checkpointImport(binding, {
    expectedRevision: 0, nextCursor: "next",
  })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await archive.readImportCheckpoint({ ...binding, providerId: "another" })).revision, 0);
  const client = importClient({ next: { data: [], nextCursor: "next" } });
  await assert.rejects(new CodexConversationArchive({ archive, binding, client }).importNextPage(), {
    code: "archive_import_cursor_stalled",
  });
  assert.equal((await archive.readImportCheckpoint(binding)).revision, 1);
});

test("schema v1 archive migrates transactionally without changing stored messages", async (t) => {
  const { archive, open } = await fixture(t);
  await archive.append(binding, message("old", "retained across migration"));
  execFileSync("python", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('DROP TABLE import_checkpoints'); db.execute('PRAGMA user_version=1'); db.commit(); db.close()",
    archive.store.databasePath], { windowsHide: true });
  const migrated = await open();
  assert.equal((await migrated.read(binding)).items[0].record.text, "retained across migration");
  assert.equal((await migrated.readImportCheckpoint(binding)).revision, 0);
});

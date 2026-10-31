import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";

import {
  PROJECT_MEMORY_LIMITS,
  createProjectMemoryStore,
} from "../src/project-memory-store.mjs";
import { sqliteBackendOf, sqliteBackendTest as test } from "./fixtures/sqlite-backends/helpers.mjs";

function entry(id, text = `text-${id}`) {
  return { id, title: `Title ${id}`, text };
}

async function fixture(t) {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "project-memory-test-"));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 14, 0, 0, tick++));
  t.after(async () => {
    const relative = path.relative(temporary, await realpath(root));
    assert.ok(relative.startsWith("project-memory-test-") && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const sqliteBackend = sqliteBackendOf(t);
  const open = async () => {
    const store = await createProjectMemoryStore({ controllerRoot: root, now, sqliteBackend });
    assert.equal(store.sqliteBackend, sqliteBackend);
    return store;
  };
  return { root, open, store: await open() };
}

async function createProject(store, projectId = "project-one", suffix = "one") {
  return store.createScope({
    scopeId: `project-scope-${suffix}`,
    kind: "project",
    projectId,
    quarterId: null,
    title: `Project ${suffix}`,
    operationId: `create-project-${suffix}`,
  });
}

async function createQuarter(store, {
  projectId = "project-one", quarterId = "quarter-one", suffix = "one",
} = {}) {
  return store.createScope({
    scopeId: `quarter-scope-${suffix}`,
    kind: "quarter",
    projectId,
    quarterId,
    title: `Quarter ${suffix}`,
    operationId: `create-quarter-${suffix}`,
  });
}

async function authorize(store, {
  commandId, scopeId = "project-scope-one", expectedRevision = 1,
  entries = [entry("one")], requestedBy = "local-user",
}) {
  return store.authorizeWrite({ commandId, scopeId, expectedRevision, entries, requestedBy });
}

async function write(store, {
  operationId, commandId, scopeId = "project-scope-one", expectedRevision = 1,
  entries = [entry("one")], actorId = "agent-one",
}) {
  return store.write({
    scopeId, expectedRevision, entries, operationId, commandId, actorId,
  });
}

test("project and quarter scopes are logically unique and isolated", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(createQuarter(store), { code: "memory_project_scope_required" });
  const project = await createProject(store);
  const quarter = await createQuarter(store);
  await createProject(store, "project-two", "two");

  assert.equal(project.revision, 1);
  assert.deepEqual(project.entries, []);
  assert.equal(project.author, "system");
  assert.equal(quarter.projectId, project.projectId);
  await assert.rejects(store.createScope({
    scopeId: "another-project-scope", kind: "project", projectId: "project-one",
    quarterId: null, title: "Duplicate", operationId: "duplicate-project",
  }), { code: "memory_scope_conflict" });
  await assert.rejects(store.createScope({
    scopeId: "another-quarter-scope", kind: "quarter", projectId: "project-one",
    quarterId: "quarter-one", title: "Duplicate", operationId: "duplicate-quarter",
  }), { code: "memory_scope_conflict" });

  const listed = await store.listScopes({ projectId: "project-one" });
  assert.equal(listed.schemaVersion, 1);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.scopes.map(({ kind }) => kind), ["project", "quarter"]);
  assert.ok(listed.scopes.every((scope) => !Object.hasOwn(scope, "entries")));
  assert.equal(JSON.stringify(listed).includes("text-one"), false);
  assert.equal((await store.listScopes()).scopes.length, 3);
});

test("project copy is atomic, copies project and quarter memory, and replays exactly", async (t) => {
  const { store } = await fixture(t);
  await createProject(store);
  await createQuarter(store);
  const contents = [entry("copied", "retained project memory")];
  await authorize(store, { commandId: "copy-source-grant", entries: contents });
  await write(store, { commandId: "copy-source-grant", operationId: "copy-source-write", entries: contents });
  const request = {
    sourceProjectId: "project-one", targetProjectId: "project-copy",
    targetProjectScopeId: "project-scope-copy", operationId: "copy-operation",
    quarterScopeIds: { "quarter-one": "quarter-scope-copy" },
  };
  const receipt = await store.copyProject(request);
  assert.equal(receipt.outcome, "complete");
  assert.equal(receipt.scopes.length, 2);
  assert.deepEqual((await store.readScope({ scopeId: "project-scope-copy" })).entries, contents);
  assert.deepEqual((await store.readScope({ scopeId: "quarter-scope-copy" })).entries, []);
  assert.deepEqual(await store.copyProject(request), receipt);
  await assert.rejects(store.copyProject({ ...request, targetProjectId: "different" }),
    { code: "memory_operation_conflict" });
  assert.equal((await store.listScopes({ projectId: "project-copy" })).scopes.length, 2);
});

test("project copy rejects incomplete mapping without creating a partial target", async (t) => {
  const { store } = await fixture(t);
  await createProject(store);
  await createQuarter(store);
  await assert.rejects(store.copyProject({
    sourceProjectId: "project-one", targetProjectId: "project-copy",
    targetProjectScopeId: "project-scope-copy", operationId: "copy-incomplete",
    quarterScopeIds: {},
  }), { code: "memory_invalid_input" });
  assert.deepEqual((await store.listScopes({ projectId: "project-copy" })).scopes, []);
});

test("every write requires one exact durable control grant", async (t) => {
  const { store } = await fixture(t);
  await createProject(store);
  const intended = [entry("approved", "approved text")];
  await assert.rejects(write(store, {
    operationId: "write-without-grant", commandId: "missing-command", entries: intended,
    actorId: "local-user",
  }), { code: "memory_authorization_required" });

  const grant = await authorize(store, { commandId: "command-one", entries: intended });
  assert.equal(grant.contentSha256.length, 64);
  assert.deepEqual(
    await authorize(store, { commandId: "command-one", entries: intended }),
    grant,
  );
  await assert.rejects(authorize(store, {
    commandId: "command-one", entries: [entry("changed")],
  }), { code: "memory_command_conflict" });
  await assert.rejects(write(store, {
    operationId: "write-mismatch", commandId: "command-one",
    entries: [entry("changed")], actorId: "local-user",
  }), { code: "memory_authorization_mismatch" });

  const receipt = await write(store, {
    operationId: "write-approved", commandId: "command-one", entries: intended,
    actorId: "local-user",
  });
  assert.equal(receipt.revision, 2);
  assert.equal((await store.readScope({ scopeId: "project-scope-one" })).author, "local-user");
  await assert.rejects(write(store, {
    operationId: "write-second", commandId: "command-one", entries: intended,
  }), { code: "memory_authorization_consumed" });
});

test("write retries return the identical receipt and changed operation payloads conflict", async (t) => {
  const { store, open } = await fixture(t);
  await createProject(store);
  const entries = [entry("stable", "same bytes")];
  await authorize(store, { commandId: "stable-command", entries });
  const request = {
    operationId: "stable-operation", commandId: "stable-command", entries,
  };
  const first = await write(store, request);
  const restarted = await open();
  const replay = await write(restarted, request);
  assert.deepEqual(replay, first);
  assert.equal((await restarted.readScope({ scopeId: "project-scope-one" })).revision, 2);
  await assert.rejects(write(restarted, {
    ...request, actorId: "different-actor",
  }), { code: "memory_operation_conflict" });
});

test("an authorized empty revision is legal", async (t) => {
  const { store } = await fixture(t);
  await createProject(store);
  await authorize(store, { commandId: "empty-command", entries: [] });
  const receipt = await write(store, {
    operationId: "empty-operation", commandId: "empty-command", entries: [],
  });
  assert.equal(receipt.revision, 2);
  assert.deepEqual((await store.readScope({ scopeId: "project-scope-one" })).entries, []);
});

test("concurrent writers cannot overwrite the same expected revision", async (t) => {
  const { store, open } = await fixture(t);
  await createProject(store);
  const second = await open();
  const left = [entry("left")];
  const right = [entry("right")];
  await authorize(store, { commandId: "command-left", entries: left });
  await authorize(second, { commandId: "command-right", entries: right });
  const results = await Promise.allSettled([
    write(store, { operationId: "operation-left", commandId: "command-left", entries: left }),
    write(second, { operationId: "operation-right", commandId: "command-right", entries: right }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const failure = results.find(({ status }) => status === "rejected");
  assert.equal(failure.reason.code, "memory_revision_conflict");
  const current = await store.readScope({ scopeId: "project-scope-one" });
  assert.equal(current.revision, 2);
  assert.ok(["left", "right"].includes(current.entries[0].id));
});

test("restart reads retain historical content, authors and stable create replay", async (t) => {
  const { store, open } = await fixture(t);
  const created = await createProject(store);
  assert.deepEqual(await createProject(store), created);
  await assert.rejects(store.createScope({
    scopeId: "different-scope", kind: "project", projectId: "project-other",
    quarterId: null, title: "Different", operationId: "create-project-one",
  }), { code: "memory_operation_conflict" });
  const entries = [entry("history", "preserved exact e\u0301 text")];
  await authorize(store, { commandId: "history-command", entries });
  await write(store, {
    operationId: "history-operation", commandId: "history-command", entries,
    actorId: "author-one",
  });

  const restarted = await open();
  const initial = await restarted.readScope({ scopeId: created.scopeId, revision: 1 });
  const current = await restarted.readScope({ scopeId: created.scopeId });
  assert.deepEqual(initial.entries, []);
  assert.equal(initial.author, "system");
  assert.equal(current.entries[0].text, "preserved exact e\u0301 text");
  assert.equal(current.author, "author-one");
  assert.equal(current.revision, 2);
  await assert.rejects(restarted.readScope({ scopeId: created.scopeId, revision: 3 }), {
    code: "memory_revision_not_found",
  });
});

test("readPair returns one coherent project and quarter snapshot", async (t) => {
  const { store } = await fixture(t);
  await createProject(store);
  await createQuarter(store);
  const projectEntries = [entry("project-entry")];
  const quarterEntries = [entry("quarter-entry")];
  await authorize(store, { commandId: "pair-project", entries: projectEntries });
  await authorize(store, {
    commandId: "pair-quarter", scopeId: "quarter-scope-one", entries: quarterEntries,
  });
  await write(store, {
    operationId: "pair-project-write", commandId: "pair-project", entries: projectEntries,
  });
  await write(store, {
    operationId: "pair-quarter-write", commandId: "pair-quarter",
    scopeId: "quarter-scope-one", entries: quarterEntries,
  });
  const pair = await store.readPair({ projectId: "project-one", quarterId: "quarter-one" });
  assert.deepEqual(pair.project.entries, projectEntries);
  assert.deepEqual(pair.quarter.entries, quarterEntries);
  assert.equal(pair.project.revision, 2);
  assert.equal(pair.quarter.revision, 2);
  await assert.rejects(store.readPair({ projectId: "project-one", quarterId: "missing" }), {
    code: "memory_scope_not_found",
  });
  await assert.rejects(store.readPair({
    projectId: "project-one", quarterId: "quarter-one", revision: 2,
  }), { code: "memory_invalid_input" });
});

test("private documents use independent bounded compare-and-swap storage", async (t) => {
  const { store, open } = await fixture(t);
  assert.equal(await store.readDocument({ key: "agent-membership" }), null);
  assert.equal(await store.compareAndSwapDocument({
    key: "agent-membership", expectedRevision: 1, value: { agents: [] },
  }), false);
  const source = { agents: [{ agentId: "agent-one", state: "active" }] };
  assert.equal(await store.compareAndSwapDocument({
    key: "agent-membership", expectedRevision: 0, value: source,
  }), true);
  source.agents[0].state = "changed-after-write";
  const first = await store.readDocument({ key: "agent-membership" });
  assert.equal(first.revision, 1);
  assert.equal(first.value.agents[0].state, "active");
  first.value.agents[0].state = "changed-after-read";
  assert.equal((await store.readDocument({ key: "agent-membership" })).value.agents[0].state, "active");
  assert.equal(await store.compareAndSwapDocument({
    key: "agent-membership", expectedRevision: 0, value: { agents: [] },
  }), false);
  assert.equal(await store.transactionDocument({
    key: "agent-membership", expectedRevision: 1, value: { agents: [], generation: 2 },
  }), true);
  assert.deepEqual(await (await open()).readDocument({ key: "agent-membership" }), {
    revision: 2, value: { agents: [], generation: 2 },
  });
});

test("memory content and private documents enforce exact bounded safe inputs", async (t) => {
  const { store } = await fixture(t);
  await createProject(store);
  const tooMany = Array.from({ length: PROJECT_MEMORY_LIMITS.entries + 1 }, (_, index) => (
    entry(`entry-${index}`)
  ));
  await assert.rejects(authorize(store, {
    commandId: "too-many", entries: tooMany,
  }), { code: "memory_invalid_input" });
  await assert.rejects(authorize(store, {
    commandId: "too-large", entries: [entry("large", "x".repeat(65_536))],
  }), { code: "memory_limit_exceeded" });
  for (const [commandId, text] of [
    ["inline-media", "data:image/png;base64,fixture"],
    ["credential", `Bearer ${"a".repeat(24)}`],
    ["control-byte", "bad\u0000text"],
  ]) {
    await assert.rejects(authorize(store, {
      commandId, entries: [entry(commandId, text)],
    }), { code: "memory_invalid_input" });
  }
  await assert.rejects(authorize(store, {
    commandId: "duplicate-entry", entries: [entry("same"), entry("same")],
  }), { code: "memory_invalid_input" });
  await assert.rejects(store.authorizeWrite({
    commandId: "extra-field", scopeId: "project-scope-one", expectedRevision: 1,
    entries: [{ ...entry("one"), path: "arbitrary/file" }], requestedBy: "local-user",
  }), { code: "memory_invalid_input" });
  await assert.rejects(store.compareAndSwapDocument({
    key: "unsafe-document", expectedRevision: 0,
    value: { token: `sk-${"x".repeat(24)}` },
  }), { code: "memory_invalid_input" });
  await assert.rejects(store.compareAndSwapDocument({
    key: "large-document", expectedRevision: 0,
    value: { text: "x".repeat(PROJECT_MEMORY_LIMITS.documentBytes) },
  }), { code: "memory_limit_exceeded" });
});

test("scope APIs reject unknown fields and invalid project-quarter shapes", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.createScope({
    scopeId: "bad-project", kind: "project", projectId: "project-one",
    quarterId: "not-null", title: "Bad", operationId: "bad-project-operation",
  }), { code: "memory_invalid_input" });
  await assert.rejects(store.createScope({
    scopeId: "bad-quarter", kind: "quarter", projectId: "project-one",
    quarterId: null, title: "Bad", operationId: "bad-quarter-operation",
  }), { code: "memory_invalid_input" });
  await createProject(store);
  await assert.rejects(store.readScope({
    scopeId: "project-scope-one", includeHistory: true,
  }), { code: "memory_invalid_input" });
  await assert.rejects(store.listScopes({ projectId: "project-one", limit: 100 }), {
    code: "memory_invalid_input",
  });
});

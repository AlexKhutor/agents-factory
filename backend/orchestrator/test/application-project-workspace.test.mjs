import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { createApplicationProjectWorkspaceHandlers } from "../src/application-project-workspace.mjs";
import { createAgentArtifactService } from "../src/application-agent-artifacts.mjs";

const LIST = "query.project-workspace.list", READ = "query.project-workspace.read";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-workspace-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src")); await mkdir(path.join(root, ".project-local"));
  await writeFile(path.join(root, "src", "one.txt"), "first second");
  await writeFile(path.join(root, "README.md"), "hello");
  await writeFile(path.join(root, ".env"), "private");
  const docs = new Map();
  const store = { async readDocument({ key }) { return structuredClone(docs.get(key) ?? null); },
    async compareAndSwapDocument({ key, expectedRevision, value }) {
      if ((docs.get(key)?.revision ?? 0) !== expectedRevision) return false;
      docs.set(key, { revision: expectedRevision + 1, value: structuredClone(value) }); return true;
    } };
  await bindProjectWorkspace(store, { projectId: "project-a", workspacePath: root });
  await bindProjectWorkspace(store, { projectId: "project-b", workspacePath: root });
  const make = () => createApplicationProjectWorkspaceHandlers({ store, sourceId: "controller",
    instanceId: "runtime-one", now: () => new Date("2026-09-23T10:30:00.000Z") });
  const handlers = make();
  const invoke = (operation, input) => handlers[operation]({ input });
  return { root, store, docs, make, invoke };
}

test("bound project browsing hides private names, pages stably and never exposes the root", async (t) => {
  const f = await fixture(t);
  const first = await f.invoke(LIST, { projectId: "project-a", limit: 1 });
  assert.equal(first.entries.length, 1); assert.equal(first.omissionCount, 2);
  assert.equal(first.truncated, true); assert.ok(first.nextCursor);
  const last = await f.invoke(LIST, { projectId: "project-a", limit: 1, cursor: first.nextCursor });
  assert.equal(last.nextCursor, null); assert.equal(last.truncated, false);
  assert.deepEqual([...first.entries, ...last.entries].map((e) => e.name), ["README.md", "src"]);
  assert.ok(!JSON.stringify(first).includes(f.root));
  const file = await f.invoke(READ, { projectId: "project-a", path: "src/one.txt", maximumBytes: 6 });
  assert.equal(file.text, "first ");
  const rest = await f.invoke(READ, { projectId: "project-a", path: "src/one.txt", maximumBytes: 6, cursor: file.nextCursor });
  assert.equal(rest.text, "second"); assert.equal(rest.nextCursor, null);
});

test("paths beyond the inherited resource-identity bound fail explicitly before filesystem reads", async (t) => {
  const f = await fixture(t);
  const nested = ['x'.repeat(90), 'y'.repeat(90), 'z'.repeat(90)].join('/');
  await mkdir(path.join(f.root, nested), { recursive: true });
  await writeFile(path.join(f.root, nested, 'result.txt'), 'bounded');
  await assert.rejects(f.invoke(READ, { projectId: 'project-a', path: nested + '/result.txt' }), { code: 'conflict' });
});

test("continuation rejects cross-project, changed content and Gateway reconstruction", async (t) => {
  const f = await fixture(t), input = { projectId: "project-a", path: "src/one.txt", maximumBytes: 5 };
  const first = await f.invoke(READ, input);
  await assert.rejects(f.invoke(READ, { ...input, projectId: "project-b", cursor: first.nextCursor }));
  await assert.rejects(f.make()[READ]({ input: { ...input, cursor: first.nextCursor } }));
  await writeFile(path.join(f.root, "src/one.txt"), "different bytes");
  await assert.rejects(f.invoke(READ, { ...input, cursor: first.nextCursor }), { code: "stale_revision" });
});

test("UTF-8 paging never splits a code point or stalls a continuation", async (t) => {
  // "Privet" in Cyrillic: two bytes per letter, so a 3-byte page always ends inside one.
  const word = "\u041f\u0440\u0438\u0432\u0435\u0442";
  const f = await fixture(t); await writeFile(path.join(f.root, "src/unicode.txt"), word);
  const input = { projectId: "project-a", path: "src/unicode.txt", maximumBytes: 3 };
  let text = "", cursor = null, pages = 0;
  do {
    const page = await f.invoke(READ, { ...input, cursor });
    assert.ok(page.range.returnedBytes > 0 && page.range.returnedBytes <= 3);
    text += page.text; cursor = page.nextCursor;
    assert.ok(++pages <= 6);
  } while (cursor);
  assert.equal(text, word);
});

test("artifact continuations cannot be borrowed by another agent sharing the same project file", async (t) => {
  const f = await fixture(t);
  const page = await f.invoke(READ, { projectId: "project-a", path: "src/one.txt" });
  const artifacts = createAgentArtifactService({ service: { store: f.store,
    readAgent: async ({ agentId }) => ({ agentId, projectId: "project-a" }) }, projectRead: f.make()[READ] });
  for (const agentId of ["a", "b"]) await artifacts.register({ agentId, artifactId: "file",
    path: "src/one.txt", sha256: page.contentSha256 });
  const first = await artifacts.read({ agentId: "a", artifactId: "file", maximumBytes: 5 });
  assert.ok(first.page.nextCursor);
  await assert.rejects(artifacts.read({ agentId: "b", artifactId: "file", maximumBytes: 5, cursor: first.page.nextCursor }));
});

test("unbound projects, escaping paths, private stores, secrets and reparse targets fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke(LIST, { projectId: "unbound" }), { code: "source_unavailable" });
  for (const name of ["../README.md", "C:/secret", ".env", ".project-local/auth.json", "src/../README.md", "auth.json "]) {
    await assert.rejects(f.invoke(READ, { projectId: "project-a", path: name }), { code: "access_denied" });
  }
  await writeFile(path.join(f.root, "src/secret.txt"), "Bearer " + "x".repeat(24));
  await assert.rejects(f.invoke(READ, { projectId: "project-a", path: "src/secret.txt" }), { code: "access_denied" });
  await symlink(path.join(f.root, "src"), path.join(f.root, "link"), "junction");
  await assert.rejects(f.invoke(READ, { projectId: "project-a", path: "link/one.txt" }), { code: "access_denied" });
});

test("project workspace refusal retains bounded public and operator reasons", async (t) => {
  const f = await fixture(t), diagnostics = [];
  const handlers = createApplicationProjectWorkspaceHandlers({ store: f.store, sourceId: "controller",
    instanceId: "runtime-one", now: () => new Date("2026-09-23T10:30:00.000Z"),
    onDiagnostic: (record) => diagnostics.push(record) });
  await assert.rejects(handlers[LIST]({ input: { projectId: "unbound" },
    requestId: "request-one", correlationId: "request-one" }),
  { code: "source_unavailable", details: { reasonCode: "workspace_not_bound" } });
  assert.deepEqual(diagnostics.map(({ phase, code, reasonCode }) => ({ phase, code, reasonCode })),
    [{ phase: "workspace-binding", code: "source_unavailable", reasonCode: "workspace_not_bound" }]);
  const bound = [...f.docs.values()].find((record) => record.value.projectId === "project-a");
  const originalWorkspaceKey = bound.value.workspaceKey;
  bound.value.workspaceKey = "f".repeat(64);
  await assert.rejects(handlers[LIST]({ input: { projectId: "project-a" } }),
    { code: "source_unavailable", details: { reasonCode: "workspace_binding_conflict" } });
  assert.equal(diagnostics.at(-1).reasonCode, "workspace_binding_conflict");
  bound.value.workspaceKey = originalWorkspaceKey;
  await rm(f.root, { recursive: true, force: true });
  await assert.rejects(handlers[LIST]({ input: { projectId: "project-a" } }),
    { code: "source_unavailable", details: { reasonCode: "workspace_path_missing" } });
  assert.equal(diagnostics.at(-1).reasonCode, "workspace_path_missing");
  assert.doesNotMatch(JSON.stringify(diagnostics), /workspacePath|project-workspace-read-/);
});

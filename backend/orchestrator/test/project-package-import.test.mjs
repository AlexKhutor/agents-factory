import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConversationArchive } from "../src/conversation-archive.mjs";
import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { exportProject, ProjectPackageError } from "../src/project-package-export.mjs";
import { importProject, migrateToSplitLayout } from "../src/project-package-import.mjs";
import { mountedProjects, resolveStoreLayout, singleMemoryDatabase, writeStoreLayoutMarker } from "../src/project-store-layout.mjs";
import { binding, CONTROLLER, fixedNow, fixture, put, skip, treeOf } from "./fixtures/project-package-fixture.mjs";

const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;
const hashOf = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

/** What the stores answer, layout aside: catalog agents as a set, scopes with their revisions, conversations. */
async function view(root) {
  const store = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "node", now: fixedNow });
  const archive = await createConversationArchive({ controllerRoot: root, projectId: CONTROLLER, sqliteBackend: "node", now: fixedNow });
  try {
    const catalog = await store.readDocument({ key: "memory-agents-v1" });
    const scopes = (await store.listScopes()).scopes;
    const contents = [];
    for (const scope of scopes) {
      for (let revision = 1; revision <= scope.revision; revision += 1) {
        contents.push(await store.readScope({ scopeId: scope.scopeId, revision }));
      }
    }
    const conversations = {};
    for (const [threadId, providerId] of [["th-alpha", "claude-code"], ["th-beta", "claude-code"]]) {
      conversations[threadId] = (await archive.read(binding(threadId, providerId))).items.map((item) => item.record);
    }
    return {
      agents: catalog.value.agents.map((agent) => JSON.stringify(agent)).sort(),
      scopes, contents, conversations,
      mystery: (await store.readDocument({ key: "mystery-doc" }))?.value ?? null,
      archiveFlags: (await store.readDocument({ key: "memory-project-archive-v1" }))?.value ?? null,
    };
  } finally {
    await store.close();
    await archive.close();
  }
}

test("migration moves a single-DB instance to the split layout with every answer unchanged", { skip }, async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await view(root);
  const singleHash = await hashOf(singleMemoryDatabase(root));
  const result = await migrateToSplitLayout({ controllerRoot: root, now: fixedNow });
  assert.equal(result.migrated, true);
  assert.equal((await resolveStoreLayout(root, { env: {} })).layout, "split");
  assert.deepEqual((await mountedProjects(root)).map((project) => project.projectId), ["alpha", "beta", "world"]);
  assert.deepEqual(await view(root), before);
  assert.equal(await hashOf(singleMemoryDatabase(root)), singleHash, "the single database is never changed");
  assert.equal(result.totals.documents, 7);
  const instance = JSON.parse(await readFile(path.join(root, "instance.json"), "utf8"));
  assert.equal(instance.instanceId, "world-1");
  await assert.rejects(migrateToSplitLayout({ controllerRoot: root }), refused("store_layout_already_split"));
});

test("a package imported into another split instance exports back byte for byte", { skip }, async (t) => {
  const source = await fixture();
  const target = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-import-")));
  t.after(async () => { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); });
  const out = path.join(source, "packages", "alpha");
  await exportProject({ controllerRoot: source, projectId: "alpha", out, now: fixedNow });

  await put(target, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: CONTROLLER }));
  await put(target, "instance.json", JSON.stringify({ schemaVersion: 1, instanceId: "world-1" }));
  await assert.rejects(importProject({ controllerRoot: target, packageDir: out }), refused("store_layout_single"));
  await writeStoreLayoutMarker(target);
  const imported = await importProject({ controllerRoot: target, packageDir: out });
  assert.equal(imported.workspace, "bound"); // the source instance's folder is on this PC
  assert.equal(imported.files.identical, 0);
  assert.ok(imported.files.written >= 12);
  assert.equal(await readFile(path.join(target, ".project-local/claude-account/projects/C--x-alpha/th-alpha.jsonl"), "utf8"), '{"t":1}\n');
  assert.ok((await readdir(path.join(target, ".project-local/desk-agents/desk-alpha-agent/tasks/inbox/task-1"))).includes("task.json"));

  const again = path.join(target, "packages", "alpha");
  await exportProject({ controllerRoot: target, projectId: "alpha", out: again, now: fixedNow });
  const [first, second] = [await treeOf(out), await treeOf(again)];
  const desk = (tree) => [...tree].filter(([name]) => name.startsWith(".desk/")).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.deepEqual(desk(second).map(([name]) => name), desk(first).map(([name]) => name));
  for (const [name, bytes] of desk(first)) assert.ok(bytes.equals(second.get(name)), `${name} differs`);
  const manifest = (tree) => JSON.parse(tree.get("project.af.json").toString("utf8"));
  assert.deepEqual(manifest(second).files, manifest(first).files);
  assert.deepEqual(manifest(second).workspace, manifest(first).workspace);

  await assert.rejects(importProject({ controllerRoot: target, packageDir: out }), refused("project_already_mounted"));
});

test("import refuses a changed, incomplete or foreign package, or a file it would overwrite, before writing", { skip }, async (t) => {
  const source = await fixture();
  t.after(() => rm(source, { recursive: true, force: true }));
  const out = path.join(source, "packages", "beta");
  await exportProject({ controllerRoot: source, projectId: "beta", out, now: fixedNow });
  const fresh = async (instanceId) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-import-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(root, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: CONTROLLER }));
    await put(root, "instance.json", JSON.stringify({ schemaVersion: 1, instanceId }));
    await writeStoreLayoutMarker(root);
    return root;
  };
  await assert.rejects(importProject({ controllerRoot: await fresh("world-2"), packageDir: out }), refused("package_world_mismatch"));

  const conflicting = await fresh("world-1");
  await put(conflicting, ".project-local/orchestration/claude-sessions/th-beta/session.json", '{"cwd":"elsewhere"}');
  await assert.rejects(importProject({ controllerRoot: conflicting, packageDir: out }), refused("import_file_conflict"));
  assert.deepEqual((await mountedProjects(conflicting)).map((project) => project.projectId), []);

  const scopes = path.join(out, ".desk", "memory", "scopes.jsonl");
  const original = await readFile(scopes);
  await writeFile(scopes, original.toString("utf8").replace("Beta", "Gamma"));
  await assert.rejects(importProject({ controllerRoot: await fresh("world-1"), packageDir: out }), refused("package_hash_mismatch"));
  await writeFile(scopes, original);
  await put(out, ".desk/memory/extra.jsonl", "");
  await assert.rejects(importProject({ controllerRoot: await fresh("world-1"), packageDir: out }), refused("package_files_mismatch"));
});

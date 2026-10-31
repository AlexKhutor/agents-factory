import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { INSTANCE_KIND, INSTANCE_SCHEMA_VERSION, migrateInstance } from "../src/agents-factory-migrate.mjs";
import { agentsFactoryLayout } from "../src/agents-factory-paths.mjs";
import { mountedProjects, resolveStoreLayout, singleMemoryDatabase, writeStoreLayoutMarker } from "../src/project-store-layout.mjs";
import { fixture, put, skip } from "./fixtures/project-package-fixture.mjs";

// Plan 4.3 / 5.1: an instance of schema 1 moves to the split layout on `migrate` (the update), and
// its mode is recorded.

const layoutOf = (root, base) => agentsFactoryLayout({ dataDir: path.join(base, "data"), instanceDir: root });
const recordOf = async (root) => JSON.parse(await readFile(path.join(root, "instance.json"), "utf8"));

test("schema 1 → 2: a single-database instance is split behind a backup, keeps its signature, records its mode", { skip }, async (t) => {
  const root = await fixture();
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-migration-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(base, { recursive: true, force: true }); });
  // As an instance made before the split: schema 1, no signature yet.
  await put(root, "instance.json", JSON.stringify({ schemaVersion: 1, kind: INSTANCE_KIND, createdBy: "agents-factory v0.1.0" }));
  const layout = layoutOf(root, base);
  const planned = await migrateInstance({ layout, dryRun: true });
  assert.deepEqual(planned.pending.map((item) => item.id), ["split-store-and-mode"]);
  assert.equal(INSTANCE_SCHEMA_VERSION, 2);

  const migrated = await migrateInstance({ layout });
  assert.equal(migrated.state, "migrated");
  assert.equal((await resolveStoreLayout(root, { env: {} })).layout, "split");
  assert.deepEqual((await mountedProjects(root)).map((item) => item.projectId), ["alpha", "beta", "world"]);
  const record = await recordOf(root);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.mode, "local");
  assert.equal(typeof record.instanceId, "string", "the world's signature made by the split stays");
  assert.ok(migrated.backup.files > 0);
  assert.ok((await readFile(singleMemoryDatabase(root))).length > 0, "the single database is kept");
  assert.equal((await migrateInstance({ layout })).state, "current");
});

test("schema 1 → 2 on an instance already split and synced (the personal one): only the mode is recorded", { skip }, async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-migration-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "instance");
  await put(root, "instance.json", JSON.stringify({ schemaVersion: 1, kind: INSTANCE_KIND, instanceId: "w-1" }));
  await writeStoreLayoutMarker(root);
  await put(root, ".project-local/sync.json", JSON.stringify({ schemaVersion: 1, packagesRoot: path.join(base, "packages"),
    author: { name: "Test", email: "test@example.com" },
    world: { remotes: [{ name: "hub", url: path.join(base, "world.git"), primary: true }] } }));
  const migrated = await migrateInstance({ layout: layoutOf(root, base) });
  assert.equal(migrated.state, "migrated");
  assert.deepEqual(await recordOf(root), { ...(await recordOf(root)), schemaVersion: 2, mode: "synced", instanceId: "w-1" });
});

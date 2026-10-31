import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readInstanceMode, setInstanceMode } from "../src/instance-mode.mjs";
import { readThisMachine } from "../src/machine-identity.mjs";
import { ProjectPackageError } from "../src/project-package-export.mjs";
import { assertWorldHeld, initWorld, syncStatus } from "../src/sync-engine.mjs";
import { put } from "./fixtures/project-package-fixture.mjs";

// Plan 5.1 (docs/project-package.md §14.9): local or synced, in instance.json.

const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;
const settings = (base) => ({ schemaVersion: 1, branch: "main", packagesRoot: path.join(base, "packages"),
  author: { name: "Test", email: "test@example.com" },
  world: { remotes: [{ name: "hub", url: path.join(base, "world.git"), primary: true }] }, projects: {} });

async function instance(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-mode-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "instance");
  await put(root, "instance.json", JSON.stringify({ schemaVersion: 1, kind: "agents-factory-instance", instanceId: "w-1" }));
  return { base, root };
}

const record = async (root) => JSON.parse(await readFile(path.join(root, "instance.json"), "utf8"));

test("an instance that records no mode is local, or synced when it has a sync.json (as before the mode)", async (t) => {
  const { base, root } = await instance(t);
  assert.deepEqual(await readInstanceMode(root), { mode: "local", recorded: false, missing: [], begun: false });
  await put(root, ".project-local/sync.json", JSON.stringify(settings(base)));
  assert.deepEqual(await readInstanceMode(root), { mode: "synced", recorded: false, missing: ["sync_machine_unnamed"], begun: false });
  await put(root, ".project-local/sync.json", "{ not json");
  assert.deepEqual((await readInstanceMode(root)).missing, ["sync_config_invalid", "sync_machine_unnamed"]);
});

test("synced needs a checked sync.json and this PC's name; nothing is written before both are right", async (t) => {
  const { base, root } = await instance(t);
  const file = path.join(base, "sync.json");
  await assert.rejects(setInstanceMode({ controllerRoot: root, mode: "synced" }), refused("mode_confirmation_required"));
  await assert.rejects(setInstanceMode({ controllerRoot: root, mode: "server", confirm: "server" }), refused("mode_invalid"));
  await assert.rejects(setInstanceMode({ controllerRoot: root, mode: "synced", confirm: "synced" }), refused("sync_not_configured"));
  await put(base, "sync.json", JSON.stringify({ ...settings(base), packagesRoot: "relative" }));
  await assert.rejects(setInstanceMode({ controllerRoot: root, mode: "synced", confirm: "synced", syncConfig: file,
    machine: { machineId: "home", home: true } }), refused("sync_config_invalid"));
  await put(base, "sync.json", JSON.stringify(settings(base)));
  await assert.rejects(setInstanceMode({ controllerRoot: root, mode: "synced", confirm: "synced", syncConfig: file }),
    refused("sync_machine_unnamed"));
  assert.equal((await record(root)).mode, undefined);
  assert.equal((await readInstanceMode(root)).mode, "local", "no sync.json was written");

  const set = await setInstanceMode({ controllerRoot: root, mode: "synced", confirm: "synced", syncConfig: file,
    machine: { machineId: "home", title: "Home", home: true } });
  assert.deepEqual({ previous: set.previous, mode: set.mode, recorded: set.recorded, missing: set.missing },
    { previous: "local", mode: "synced", recorded: true, missing: [] });
  assert.equal((await record(root)).mode, "synced");
  assert.equal((await record(root)).instanceId, "w-1", "the rest of instance.json stays");
  assert.equal((await readThisMachine(root)).machineId, "home");
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".project-local/sync.json"), "utf8")), settings(base));
});

test("local turns sync off: the commands refuse, the Gateway's guard steps aside; local only while the world is here", async (t) => {
  const { base, root } = await instance(t);
  await put(root, ".project-local/sync.json", JSON.stringify(settings(base)));
  await put(root, ".project-local/sync-state.json", JSON.stringify({ schemaVersion: 1, world: { held: false } }));
  // Sync began here and the world is elsewhere: this PC may not go local (it would run a stale world).
  await assert.rejects(setInstanceMode({ controllerRoot: root, mode: "local", confirm: "local" }), refused("mode_world_elsewhere"));
  await assert.rejects(assertWorldHeld(root), refused("sync_world_not_held"));
  await put(root, ".project-local/sync-state.json", JSON.stringify({ schemaVersion: 1, world: { held: true } }));
  const set = await setInstanceMode({ controllerRoot: root, mode: "local", confirm: "local" });
  assert.equal(set.mode, "local");
  await assert.rejects(initWorld({ controllerRoot: root }), refused("sync_mode_local"));
  await put(root, ".project-local/sync-state.json", JSON.stringify({ schemaVersion: 1, world: { held: false } }));
  await assertWorldHeld(root);
  assert.deepEqual(await syncStatus({ controllerRoot: root }), { configured: true, mode: "local" });
});

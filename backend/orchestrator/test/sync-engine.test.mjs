import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { mountedProjects } from "../src/project-store-layout.mjs";
import {
  assertWorldHeld, initWorld, readSyncState, releaseAll, releaseWorld, syncStatus, takeAll, takeWorld,
} from "../src/sync-engine.mjs";
import { readWorldRegistry } from "../src/world-registry.mjs";
import { skip } from "./fixtures/project-package-fixture.mjs";
import { gitIn, lockOf, office, refused, CANARY, service, setup } from "./fixtures/sync-fixture.mjs";

// Block 3 (docs/project-package.md §14) between two instances on one disk: "home" and "office",
// with bare repos for remotes. The home-only project never reaches the office (R5, R37).

async function filesHolding(folder, text) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if ((await readFile(full)).includes(text)) found.push(path.relative(folder, full));
    }
  };
  await walk(folder);
  return found;
}

test("the world and an open project go to the office and back; the home-only project stays home", { skip }, async (t) => {
  const env = await setup(t);
  const { home, remotes, base } = env;

  // Configured but not begun: the Gateway may still run here (sync init is to come).
  await assertWorldHeld(home);
  // First push: the world held at home, also on the mirror.
  const init = await initWorld({ controllerRoot: home });
  assert.equal(init.action, "initialized");
  assert.equal(lockOf(remotes, "world").holder, "home");
  assert.equal(gitIn(path.join(remotes, "world-mirror.git"), "rev-parse", "main").trim(),
    gitIn(path.join(remotes, "world.git"), "rev-parse", "main").trim());

  // Home finishes: the open project leaves this PC; the home-only one is backed up and stays.
  const released = await releaseAll({ controllerRoot: home });
  assert.deepEqual(released.results.map((item) => `${item.target}:${item.action}`),
    ["homep:backed-up", "open:released", "world:released"]);
  assert.deepEqual((await mountedProjects(home)).map((item) => item.projectId), ["homep", "world"]);
  assert.equal(lockOf(remotes, "world").holder, null);
  assert.equal(lockOf(remotes, "open").holder, null);
  assert.equal(lockOf(remotes, "homep").holder, "home");
  await assert.rejects(assertWorldHeld(home), refused("sync_world_not_held"));

  // Nothing of the home-only project is in the world repo, in any commit.
  assert.ok(!gitIn(path.join(remotes, "world.git"), "log", "--all", "-p").includes(CANARY));
  assert.ok(gitIn(path.join(remotes, "homep.git"), "log", "--all", "-p").includes(CANARY));

  // The office takes everything it may: the world and the open project; the home-only one is refused before any fetch.
  const work = await office(env);
  const taken = await takeAll({ controllerRoot: work });
  assert.deepEqual(taken.results.map((item) => `${item.target}:${item.action}`), ["world:taken", "open:taken"]);
  assert.deepEqual(taken.skipped, [{ projectId: "homep", reason: "sync_policy_denied" }]);
  await assert.rejects(stat(path.join(base, "packages-office", "homep")), { code: "ENOENT" });
  assert.deepEqual(await filesHolding(work, CANARY), []);
  assert.deepEqual((await mountedProjects(work)).map((item) => item.projectId), ["open", "world"]);
  await assertWorldHeld(work);
  assert.equal(lockOf(remotes, "world").holder, "office");
  // ...and where it is and what it holds, as of the world's release at home (the release records it).
  const homep = (await readWorldRegistry(work)).projects.homep;
  assert.equal(homep.location?.machineId, "home");
  assert.deepEqual({ agents: homep.summary?.agents, quarters: homep.summary?.quarters }, { agents: 1, quarters: 1 });
  assert.equal(released.results.find((item) => item.target === "world").recorded.join(), "homep");
  const memory = await service(work);
  assert.deepEqual((await memory.listAgents()).agents.map((agent) => agent.agentId).sort(), ["lead", "open-agent"]);
  await memory.close();

  // Home cannot take what the office holds.
  await assert.rejects(takeWorld({ controllerRoot: home }), refused("sync_held_elsewhere"));
  const status = await syncStatus({ controllerRoot: home, remote: true });
  assert.equal(status.world.held, false);
  assert.equal(status.world.remote.holder, "office");

  // The office finishes; home takes the world back and the open project with it.
  const back = await releaseAll({ controllerRoot: work });
  assert.deepEqual(back.results.map((item) => `${item.target}:${item.action}`), ["open:released", "world:released"]);
  await assert.rejects(assertWorldHeld(work), refused("sync_world_not_held"));
  const again = await takeAll({ controllerRoot: home });
  assert.deepEqual(again.results.map((item) => `${item.target}:${item.action}`), ["world:taken", "homep:already-mounted", "open:taken"]);
  assert.deepEqual((await mountedProjects(home)).map((item) => item.projectId), ["homep", "open", "world"]);
  assert.equal((await readSyncState(home)).world.held, true);
});

test("a take refuses a world changed here without the lock, and a release by a PC that does not hold it", { skip }, async (t) => {
  const env = await setup(t);
  const { home } = env;
  await initWorld({ controllerRoot: home });
  await releaseWorld({ controllerRoot: home });
  await assert.rejects(releaseWorld({ controllerRoot: home }), refused("sync_not_holder"));
  // A change to the world store while this PC did not hold it.
  const memory = await service(home);
  await memory.store.createScope({ scopeId: "world-late-memory", kind: "quarter", projectId: "world", quarterId: "late",
    title: "Late", operationId: "op-late" });
  await memory.close();
  await assert.rejects(takeWorld({ controllerRoot: home }), refused("sync_world_changed_here"));
  assert.equal(lockOf(env.remotes, "world").holder, null, "nothing was taken");
  // A tracked file changed here refuses too.
  await writeFile(path.join(home, "project-version.json"), "{}");
  await assert.rejects(takeWorld({ controllerRoot: home }), refused("sync_local_changes"));
});

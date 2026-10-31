import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNotMovedAway, moveInstance } from "../src/instance-move.mjs";
import { instancePathHash } from "../src/instance-relocate.mjs";
import { readThisMachine } from "../src/machine-identity.mjs";
import { ProjectPackageError } from "../src/project-package-export.mjs";
import { claudeProjectSlug, dshSessionSlug } from "../src/project-rebind.mjs";
import { resolveStoreLayout } from "../src/project-store-layout.mjs";
import { CONTROLLER, fixedNow, fixture, put, skip } from "./fixtures/project-package-fixture.mjs";

// Plan 4.3: what the home relocation Z: → W: did by hand, in one command (docs/project-package.md §10a).

const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;
const exists = (target) => lstat(target).then(() => true, () => false);

test("an instance moves in one command: links, a dead Gateway, the PC's name, paths, split layout; the old folder stays", { skip }, async (t) => {
  const root = await fixture();
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-move-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(base, { recursive: true, force: true }); });
  const local = path.join(root, ".project-local");
  // The project's agents worked in its folder inside the instance (the fixture names another
  // folder): their sessions sit where Claude Code and DeepSeek Harness put them, and follow the move.
  const alphaWs = path.join(root, "alpha-ws");
  await put(local, "orchestration/claude-sessions/th-alpha/session.json", JSON.stringify({ cwd: alphaWs }));
  await put(local, "orchestration/acp-sessions/th-alpha-acp/session.json", JSON.stringify({ cwd: alphaWs }));
  await rename(path.join(local, "claude-account/projects/C--x-alpha"), path.join(local, "claude-account/projects", claudeProjectSlug(alphaWs)));
  await rename(path.join(local, "dsh-home/sessions/--x-alpha--"), path.join(local, "dsh-home/sessions", dshSessionSlug(alphaWs)));
  // A link out of the instance (like DeepSeek Harness's node_modules) and one inside it.
  const outside = path.join(base, "harness-modules", "pkg");
  await mkdir(outside, { recursive: true });
  await mkdir(path.join(local, "dsh-home", "profiles", "node_modules"), { recursive: true });
  await symlink(outside, path.join(local, "dsh-home", "profiles", "node_modules", "pkg"), "junction");
  await symlink(path.join(root, "alpha-ws"), path.join(root, "alpha-link"), "junction");
  // A Gateway that died: its records and its connection descriptor stay behind.
  await put(local, "application-gateway/status.v1.json", JSON.stringify({ terminal: false, identity: { process: { processId: 999999 } } }));
  await put(local, "application-gateway/monitor-owner.v1.json", "{}");
  await put(local, "application-gateway/connection.v1.json", "{}");
  await put(local, "application-gateway/claude-provider.json", JSON.stringify({ claudeConfigDir: path.join(local, "claude-account"),
    sdkPath: "C:\\sdk\\claude", keepProviderVariables: false }, null, 2));
  await put(local, "claude-account/.credentials.json", "{}");
  // Atlas: its config and the camera of this instance.
  const atlas = path.join(base, "atlas");
  const keyOf = (folder) => `live-${instancePathHash(folder).slice(0, 16)}`;
  await put(atlas, "config/local.json", JSON.stringify({ controllerRoot: root,
    expectedWorkspace: { projectId: CONTROLLER, workspaceRootSha256: instancePathHash(root) } }, null, 2));
  await put(atlas, `user-data/layouts/${keyOf(root)}.view.json`, JSON.stringify({ x: 1, y: 2, scale: 0.5 }));

  const to = path.join(base, "moved");
  await assert.rejects(moveInstance({ controllerRoot: root, to }), refused("move_confirmation_required"));
  const inner = path.join(root, "inner");
  await assert.rejects(moveInstance({ controllerRoot: root, to: inner, confirm: inner }), refused("move_target_overlaps"));
  await put(base, "taken/file.txt", "x");
  const taken = path.join(base, "taken");
  await assert.rejects(moveInstance({ controllerRoot: root, to: taken, confirm: taken }), refused("move_target_not_empty"));

  const result = await moveInstance({ controllerRoot: root, to, confirm: to, atlasConfig: path.join(atlas, "config/local.json"),
    machine: { machineId: "home", title: "Home", home: true }, now: fixedNow });

  // The copy: split, named, its paths its own, the sign-in along.
  assert.equal((await resolveStoreLayout(to, { env: {} })).layout, "split");
  assert.deepEqual([...result.migratedToSplit.projects].sort(), ["alpha", "beta", "world"]);
  assert.equal((await readThisMachine(to)).machineId, "home");
  const provider = JSON.parse(await readFile(path.join(to, ".project-local/application-gateway/claude-provider.json"), "utf8"));
  assert.equal(provider.claudeConfigDir, path.join(to, ".project-local", "claude-account"));
  assert.equal(provider.sdkPath, "C:\\sdk\\claude");
  assert.deepEqual(result.signIn, { claudeConfigDir: path.join(to, ".project-local", "claude-account"), credentialsFile: true });
  assert.ok(result.rebound.some((item) => item.projectId === "alpha" && item.to === path.join(to, "alpha-ws")));
  // Links stay links: out of the instance as before, inside it into the copy.
  assert.equal(path.resolve(await readlink(path.join(to, ".project-local/dsh-home/profiles/node_modules/pkg"))), outside);
  assert.equal(path.resolve(await readlink(path.join(to, "alpha-link"))), path.join(to, "alpha-ws"));
  assert.ok(result.copied.links >= 2 && result.copied.files > 0);
  // The dead Gateway's records are set aside in the copy, unread; the Gateway may start there.
  assert.deepEqual([...result.gatewayRecordsSetAside].sort(), ["connection.v1.json", "monitor-owner.v1.json", "status.v1.json"]);
  assert.equal(await exists(path.join(to, ".project-local/application-gateway/connection.v1.json")), false);
  await assertNotMovedAway(to);
  // Atlas follows the move; the camera came along.
  const config = JSON.parse(await readFile(path.join(atlas, "config/local.json"), "utf8"));
  assert.equal(config.controllerRoot, to);
  assert.equal(config.expectedWorkspace.workspaceRootSha256, instancePathHash(to));
  assert.ok((await readdir(path.join(atlas, "user-data/layouts"))).includes(`${keyOf(to)}.view.json`));
  assert.equal(result.atlas.view, "copied");
  // A receipt in the new folder.
  assert.ok(result.receipt.startsWith(path.join(to, ".project-local", "move-receipts")));

  // The old folder is the backup: as it was, plus the note of where it went. Its Gateway does not start.
  assert.equal((await resolveStoreLayout(root, { env: {} })).layout, "single");
  assert.ok(await exists(path.join(local, "application-gateway/connection.v1.json")));
  await assert.rejects(assertNotMovedAway(root), refused("instance_moved_away"));
  const again = path.join(base, "again");
  await assert.rejects(moveInstance({ controllerRoot: root, to: again, confirm: again }), refused("instance_moved_away"));

  // A running Gateway refuses a move (this process stands in for it).
  await put(to, ".project-local/application-gateway/status.v1.json", JSON.stringify({ terminal: false,
    identity: { process: { processId: process.pid } } }));
  const third = path.join(base, "third");
  await assert.rejects(moveInstance({ controllerRoot: to, to: third, confirm: third }), refused("gateway_running"));
  assert.equal(await exists(third), false, "nothing was copied");
});

test("a move that cannot finish says so: the copy is incomplete, the source and Atlas are as they were", { skip }, async (t) => {
  const root = await fixture();
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-move-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(base, { recursive: true, force: true }); });
  // The fixture's agent session names another folder ("x"): the rebind of its project refuses.
  const atlas = path.join(base, "atlas");
  const config = JSON.stringify({ controllerRoot: root, expectedWorkspace: { projectId: CONTROLLER,
    workspaceRootSha256: instancePathHash(root) } }, null, 2);
  await put(atlas, "config/local.json", config);
  const to = path.join(base, "moved");
  await assert.rejects(moveInstance({ controllerRoot: root, to, confirm: to, atlasConfig: path.join(atlas, "config/local.json") }),
    (error) => refused("move_incomplete")(error) && error.message.startsWith("move_incomplete: paths: rebind_session_elsewhere"));
  assert.equal(await readFile(path.join(atlas, "config/local.json"), "utf8"), config);
  await assertNotMovedAway(root);
  assert.ok(await exists(to), "the incomplete copy is left for the person to look at");
});

import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { readThisMachine, setThisMachine } from "./machine-identity.mjs";
import { gatewayRunning, ProjectPackageError } from "./project-package-export.mjs";
import { migrateToSplitLayout } from "./project-package-import.mjs";
import { resolveStoreLayout } from "./project-store-layout.mjs";
import { relocateAtlas, relocateInstance } from "./instance-relocate.mjs";

// Moving an instance to another folder in one command (plan 4.3, docs/project-package.md §10a):
// what the home relocation Z: → W: did by hand. The whole instance is copied (logins included:
// it stays on the person's own PC), links as links; in the copy a dead Gateway's records are set
// aside, the PC is named when asked, the paths are rewritten (`instance relocate`, Atlas's config
// and map included), and a single-database instance moves to the split layout. The source is not
// changed except for one file that says where the instance went: its Gateway then refuses to
// start, so two copies of one world never run. It stays as the backup.

const GATEWAY = [".project-local", "application-gateway"];
// A Gateway that is not running but left these behind would refuse to start in the copy
// (`gateway_process_collision`, `gateway_recovery_identity_mismatch`): they name the old path.
const DEAD_GATEWAY_RECORDS = ["status.v1.json", "monitor-owner.v1.json", "monitor-status.v1.json"];
const DESCRIPTOR = "connection.v1.json";
const MOVED_FILE = path.join(".project-local", "moved-to.json");

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

const stamp = (now) => now().toISOString().replace(/[-:.]/gu, "");
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** The folder the instance was moved to, or null. */
export async function movedTo(controllerRoot) {
  try {
    const value = JSON.parse(await readFile(path.join(controllerRoot, MOVED_FILE), "utf8"));
    return typeof value?.to === "string" ? value.to : null;
  } catch {
    return null;
  }
}

/** The Gateway of a moved-away instance does not start: the instance lives on in its new folder. */
export async function assertNotMovedAway(controllerRoot) {
  const to = await movedTo(controllerRoot);
  if (to !== null) fail("instance_moved_away", to);
}

/**
 * Copies `from` into `to`: files, folders, and links as links (a junction stays a junction, a
 * link into the instance points into the copy). Counts what it copied.
 */
async function copyTree(from, to, root, target, counts) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(source);
      const absolute = path.isAbsolute(link) ? link : null;
      const pointed = absolute !== null && inside(root, absolute) ? path.join(target, path.relative(root, absolute)) : link;
      const kind = await stat(source).then((info) => (info.isDirectory() ? "dir" : "file"), () => "dir");
      try {
        await symlink(pointed, destination, process.platform === "win32" ? (kind === "dir" ? "junction" : "file") : undefined);
      } catch (error) {
        fail("move_link_not_copied", `${path.relative(root, source)}: ${error.code ?? "failed"}`);
      }
      counts.links += 1;
    } else if (entry.isDirectory()) {
      await copyTree(source, destination, root, target, counts);
      counts.folders += 1;
    } else if (entry.isFile()) {
      await copyFile(source, destination);
      counts.files += 1;
      counts.bytes += (await lstat(source)).size;
    }
  }
}

/** In the copy: a Gateway that is not running left records of the old path; they go to a backup folder unread. */
async function setAsideDeadGateway(root, backup) {
  const folder = path.join(root, ...GATEWAY);
  const status = path.join(folder, "status.v1.json");
  const moved = [];
  const put = async (name) => {
    const file = path.join(folder, name);
    if (!await exists(file)) return;
    await mkdir(backup, { recursive: true });
    await rename(file, path.join(backup, name));
    moved.push(name);
  };
  let terminal = true;
  try { terminal = JSON.parse(await readFile(status, "utf8"))?.terminal === true; } catch { terminal = true; }
  if (!terminal) for (const name of DEAD_GATEWAY_RECORDS) await put(name);
  // A clean stop removes the connection descriptor; one left behind is a dead Gateway's.
  await put(DESCRIPTOR);
  return moved;
}

/** Whether the provider's sign-in came along: the credentials file is there (never read). */
async function claudeSignIn(root) {
  let configDir = path.join(root, ".project-local", "claude-account");
  try {
    const provider = JSON.parse(await readFile(path.join(root, ...GATEWAY, "claude-provider.json"), "utf8"));
    if (typeof provider?.claudeConfigDir === "string") configDir = provider.claudeConfigDir;
  } catch { /* no provider config: the default folder */ }
  return { claudeConfigDir: configDir, credentialsFile: await exists(path.join(configDir, ".credentials.json")) };
}

/**
 * Moves the instance at `controllerRoot` to `to` (absolute; missing or an empty folder).
 * `confirm` repeats `to`. Gateway stopped. Returns the receipt, also written in the new folder.
 */
export async function moveInstance({ controllerRoot, to, confirm, atlasConfig = null, machine = null,
  now = () => new Date() }) {
  if (typeof to !== "string" || !path.isAbsolute(to)) fail("move_target_invalid");
  if (confirm !== to) fail("move_confirmation_required", to);
  const root = await realpath(controllerRoot);
  const target = path.resolve(to);
  if (inside(root, target) || inside(target, root)) fail("move_target_overlaps", target);
  if (await exists(target)) {
    if (!(await lstat(target)).isDirectory() || (await readdir(target)).length > 0) fail("move_target_not_empty", target);
  }
  if (await movedTo(root) !== null) fail("instance_moved_away", await movedTo(root));
  if (await gatewayRunning(path.join(root, ...GATEWAY, "status.v1.json"))) fail("gateway_running");
  if (machine !== null && typeof machine.machineId !== "string") fail("machine_id_invalid");

  const startedAtUtc = now().toISOString();
  const counts = { files: 0, folders: 0, links: 0, bytes: 0 };
  await copyTree(root, target, root, target, counts);
  const copy = await realpath(target);
  // From here a failure leaves an incomplete copy and the source as it was; Atlas is switched last.
  let step = "gateway-records";
  let setAside;
  let relocated;
  let migrated = null;
  let atlas = null;
  try {
    setAside = await setAsideDeadGateway(copy, path.join(copy, ".project-local", "backups", `move-${stamp(now)}`));
    step = "machine";
    if (machine !== null) await setThisMachine(copy, machine);
    // Paths first: the migration reads the sessions where the provider configs say they are.
    step = "paths";
    relocated = await relocateInstance({ controllerRoot: copy, from: root, confirm: root, now });
    step = "split-layout";
    if ((await resolveStoreLayout(copy, { env: {} })).layout !== "split") {
      migrated = { projects: ((await migrateToSplitLayout({ controllerRoot: copy, now })).projects ?? [])
        .map((item) => item?.projectId ?? item) };
    }
    step = "atlas";
    if (atlasConfig !== null) atlas = await relocateAtlas(path.resolve(atlasConfig), root, copy);
  } catch (error) {
    fail("move_incomplete", `${step}: ${error?.message || error?.code || "failed"} — the copy in ${copy} is not complete `
      + `(delete it); ${root} is unchanged`);
  }
  await writeFile(path.join(root, MOVED_FILE), `${JSON.stringify({ schemaVersion: 1, to: copy, movedAtUtc: now().toISOString() }, null, 2)}\n`, "utf8");

  const receipt = { schemaVersion: 1, from: root, to: copy, startedAtUtc, copied: counts, gatewayRecordsSetAside: setAside,
    machine: (await readThisMachine(copy))?.machineId ?? null, migratedToSplit: migrated,
    configs: relocated.configs, rebound: relocated.rebound, atlas,
    stillNamingOldPath: relocated.stillNamingOldPath, signIn: await claudeSignIn(copy), sourceMarked: MOVED_FILE.replace(/\\/gu, "/"),
    movedAtUtc: now().toISOString() };
  const file = path.join(copy, ".project-local", "move-receipts", `${stamp(now)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { ...receipt, receipt: file, gatewayHash: relocated.gatewayHash };
}

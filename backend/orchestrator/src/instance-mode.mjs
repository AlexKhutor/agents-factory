import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { readThisMachine, setThisMachine } from "./machine-identity.mjs";
import { ProjectPackageError } from "./project-package-export.mjs";
import {
  INSTANCE_MODES, readSyncConfig, readSyncState, recordedMode, syncBegun, syncConfigOf,
} from "./sync-engine.mjs";

// Local or synced (plan 5.1, docs/project-package.md §14.9). `local`: everything on this PC, no
// repositories, the sync commands refuse. `synced`: the world and projects go between PCs; it needs
// this PC's name and its sync.json (remotes, packages root). The mode lives in instance.json, so
// both PCs share it; an instance that records none is `synced` when it has a sync.json (as before
// the mode existed), else `local`.

const SYNC_CONFIG = path.join(".project-local", "sync.json");

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

async function writeJsonOver(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

/** The mode, whether instance.json records it, and what a synced instance still lacks. */
export async function readInstanceMode(controllerRoot) {
  const root = await realpath(controllerRoot);
  const recorded = await recordedMode(root);
  let config = null;
  let configProblem = null;
  try { config = await readSyncConfig(root); } catch (error) { configProblem = error?.code ?? "sync_config_invalid"; }
  const mode = recorded ?? (config !== null || configProblem !== null ? "synced" : "local");
  const missing = [];
  if (mode === "synced") {
    if (configProblem !== null) missing.push(configProblem);
    else if (config === null) missing.push("sync_not_configured");
    if (await readThisMachine(root) === null) missing.push("sync_machine_unnamed");
  }
  return { mode, recorded: recorded !== null, missing, begun: await syncBegun(root) };
}

/**
 * Sets the mode; `confirm` repeats it. To `synced`: a sync.json (`syncConfig`, a file checked
 * before anything is written, or the one in place) and this PC's name (`machine`, or the one set).
 * To `local`: only while the world is here, or sync never began.
 */
export async function setInstanceMode({ controllerRoot, mode, confirm, syncConfig = null, machine = null,
  now = () => new Date() }) {
  if (!INSTANCE_MODES.includes(mode)) fail("mode_invalid", String(mode));
  if (confirm !== mode) fail("mode_confirmation_required", mode);
  const root = await realpath(controllerRoot);
  const recordFile = path.join(root, "instance.json");
  let record;
  try { record = JSON.parse(await readFile(recordFile, "utf8")); } catch { record = null; }
  if (record === null || typeof record !== "object") fail("instance_not_initialized", "instance.json");
  const previous = await readInstanceMode(root);

  if (mode === "local") {
    // A PC that gave the world away would run a stale copy of it.
    if (previous.begun && (await readSyncState(root)).world.held !== true) {
      fail("mode_world_elsewhere", "take the world first (agents-factory sync take)");
    }
  } else {
    let candidate = null;
    if (syncConfig !== null) {
      try { candidate = JSON.parse(await readFile(syncConfig, "utf8")); } catch { fail("sync_config_invalid", syncConfig); }
      syncConfigOf(candidate);
    } else if (await readSyncConfig(root) === null) {
      fail("sync_not_configured", "--sync-config <file>");
    }
    if (machine !== null) await setThisMachine(root, machine);
    if (await readThisMachine(root) === null) fail("sync_machine_unnamed", "--machine-id <id>");
    if (candidate !== null) await writeJsonOver(path.join(root, SYNC_CONFIG), candidate);
  }
  await writeJsonOver(recordFile, { ...record, mode, updatedAtUtc: now().toISOString() });
  return { previous: previous.mode, ...await readInstanceMode(root) };
}

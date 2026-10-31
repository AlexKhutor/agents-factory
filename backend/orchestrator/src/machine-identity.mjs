import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// This PC's name in a world that lives on several PCs (docs/project-package.md §4, §8).
// Which PC this is stays on the PC (.project-local/machine.json, never synced); how a
// PC is called and whether it is the home one sits in the world's machine overlay
// (machine/<machineId>.json), so every PC can name the others ("at the office"). A project
// may be kept to some PCs (policy.allowedMachines) or to the home one (policy.homeOnly).

export const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u;
const LOCAL_FILE = path.join(".project-local", "machine.json");
const OVERLAY_FOLDER = "machine";
const MAX_TITLE = 80;

function fail(code, detail) { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); }

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

const overlayPath = (controllerRoot, machineId) => path.join(controllerRoot, OVERLAY_FOLDER, `${machineId}.json`);

/** Every PC the world knows: { <machineId>: { title, home } }. */
export async function readMachines(controllerRoot) {
  const folder = path.join(controllerRoot, OVERLAY_FOLDER);
  const entries = await readdir(folder, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const machines = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = await readJson(path.join(folder, entry.name));
    const machineId = entry.name.slice(0, -".json".length);
    if (!MACHINE_ID.test(machineId) || value?.machineId !== machineId) continue;
    machines[machineId] = { title: typeof value.title === "string" ? value.title : machineId, home: value.home === true };
  }
  return machines;
}

/** This PC: { machineId, title, home }, or null while it has no name yet. */
export async function readThisMachine(controllerRoot) {
  const local = await readJson(path.join(controllerRoot, LOCAL_FILE));
  if (typeof local?.machineId !== "string" || !MACHINE_ID.test(local.machineId)) return null;
  const machines = await readMachines(controllerRoot);
  return { machineId: local.machineId, ...(machines[local.machineId] ?? { title: local.machineId, home: false }) };
}

/** Names this PC. The id is this PC's; the title and the home mark are seen by every PC. */
export async function setThisMachine(controllerRoot, { machineId, title = null, home = null }) {
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) fail("machine_id_invalid", String(machineId));
  if (title !== null && (typeof title !== "string" || title.trim() === "" || title.length > MAX_TITLE)) fail("machine_title_invalid");
  if (home !== null && typeof home !== "boolean") fail("machine_home_invalid");
  const current = await readJson(overlayPath(controllerRoot, machineId));
  const overlay = {
    ...(current ?? {}),
    schemaVersion: 1,
    machineId,
    title: title ?? current?.title ?? machineId,
    home: home ?? current?.home === true,
  };
  await writeJson(overlayPath(controllerRoot, machineId), overlay);
  await writeJson(path.join(controllerRoot, LOCAL_FILE), { schemaVersion: 1, machineId });
  return { machineId, title: overlay.title, home: overlay.home };
}

/** A project policy as the world keeps it; anything else is refused. */
export function projectPolicy(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("policy_invalid");
  const keys = Object.keys(value).sort().join();
  if (keys !== "allowedMachines,homeOnly") fail("policy_invalid", keys);
  if (typeof value.homeOnly !== "boolean") fail("policy_invalid", "homeOnly");
  const allowed = value.allowedMachines;
  if (allowed !== null && (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 16
      || allowed.some((id) => typeof id !== "string" || !MACHINE_ID.test(id)) || new Set(allowed).size !== allowed.length)) {
    fail("policy_invalid", "allowedMachines");
  }
  return { homeOnly: value.homeOnly, allowedMachines: allowed === null ? null : [...allowed].sort() };
}

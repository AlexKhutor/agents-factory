import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateLayout } from "./layout-store.mjs";

// The map of a split instance (backend docs/project-package.md §9): instead of
// one file in Atlas's own folder, the world part sits in the instance's world
// (.world/layout/world.json: the world HQ and where each project stands) and
// each mounted project's part beside its stores
// (.project-local/projects/<folder>/layout.json: its box, quarters, agents),
// so a project's notes and arrangement travel in its package. The camera
// (`view`) stays on this PC. A project that is not on this PC keeps only its place
// and box size in the world part: its notes are in its package, not here.
//
// The renderer keeps one version-1 layout object; this store assembles it on
// read and splits it on write by the agents' membership the renderer sends.
// The first read of an instance that has no world part yet is the old file
// (Atlas's user-data); the first write splits it. The old file stays.
//
// A project part this store has not read (a project mounted while the window
// is open) is newer than the window's map: a write keeps it as it is and asks
// the window to read the map again (`reloadProjects`).

const WORLD_PROJECT = "world";
// Where a project stands and how big its box is: the world part keeps this for every project.
const GEOMETRY = ["x", "y", "auto", "width", "height"];
const MARKER = path.join(".project-local", "projects", "store-layout.v1.json");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_MEMBERS = 4096;

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

async function readJson(target) {
  try { return JSON.parse(await readFile(target, "utf8")); } catch { return null; }
}

const pick = (entry, keys) => Object.fromEntries(Object.entries(entry ?? {}).filter(([key]) => keys.includes(key)));
const omit = (entry, keys) => Object.fromEntries(Object.entries(entry ?? {}).filter(([key]) => !keys.includes(key)));

/** agentId -> projectId from the renderer, identifiers only; anything else is dropped. */
function cleanMembership(membership) {
  if (membership === null || typeof membership !== "object" || Array.isArray(membership)) return new Map();
  return new Map(Object.entries(membership).slice(0, MAX_MEMBERS)
    .filter(([agentId, projectId]) => ID.test(agentId) && typeof projectId === "string" && ID.test(projectId)));
}

/** Whether the instance keeps one memory database per project (the split layout). */
export async function isSplitInstance(controllerRoot) {
  return typeof controllerRoot === "string" && await exists(path.join(controllerRoot, MARKER));
}

/** The projects mounted here: [{ projectId, folder }]. */
export async function mountedProjectFolders(controllerRoot) {
  const directory = path.join(controllerRoot, ".project-local", "projects");
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const identity = await readJson(path.join(directory, entry.name, "project.json"));
    if (typeof identity?.projectId === "string") result.push({ projectId: identity.projectId, folder: path.join(directory, entry.name) });
  }
  return result;
}

/** The projects the world knows that are not here (registry minus mounted). */
async function awayProjectIds(controllerRoot, mounted) {
  const registry = await readJson(path.join(controllerRoot, ".world", "registry.json"));
  const here = new Set(mounted.map((item) => item.projectId));
  return new Set(Object.keys(registry?.projects ?? {}).filter((projectId) => !here.has(projectId)));
}

async function writeIfChanged(target, value, { create = true } = {}) {
  const text = `${JSON.stringify(value, null, 1)}\n`;
  const current = await readFile(target, "utf8").catch(() => null);
  if (current !== null) {
    const { updatedAtUtc: ignored, ...before } = JSON.parse(current);
    const { updatedAtUtc: ignoredToo, ...after } = value;
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
  }
  if (!create && !await exists(path.dirname(target))) return false;
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}

export function createSplitLayoutStore({ controllerRoot, legacy, directory, environment = "unconfigured" }) {
  const worldFile = path.join(controllerRoot, ".world", "layout", "world.json");
  const viewFile = path.join(directory, "layouts", `${environment}.view.json`);
  // projectId -> the updatedAtUtc of its part as this store last read or wrote it.
  const seen = new Map();
  // agentId -> projectId, as last read or written: an agent of a project taken
  // off this PC meanwhile is not in the projection any more, and must not land
  // in the world part.
  const known = new Map();
  let queue = Promise.resolve();

  async function read() {
    const world = await readJson(worldFile);
    if (world === null) return legacy.read();
    const layout = { schemaVersion: 1, projects: {}, quarters: { ...(world.quarters ?? {}) }, agents: { ...(world.agents ?? {}) } };
    for (const [projectId, entry] of Object.entries(world.projects ?? {})) layout.projects[projectId] = { ...entry };
    const parts = new Map();
    for (const { projectId, folder } of await mountedProjectFolders(controllerRoot)) {
      const part = await readJson(path.join(folder, "layout.json"));
      if (part === null || part.projectId !== projectId) continue;
      parts.set(projectId, part.updatedAtUtc ?? null);
      if (projectId !== WORLD_PROJECT) {
        layout.projects[projectId] = { ...(part.project ?? {}), ...pick(world.projects?.[projectId], GEOMETRY) };
      }
      layout.quarters[projectId] = { ...(part.quarters ?? {}) };
      Object.assign(layout.agents, part.agents ?? {});
      for (const agentId of Object.keys(part.agents ?? {})) known.set(agentId, projectId);
    }
    const view = await readJson(viewFile);
    if (view && typeof view === "object") layout.view = view;
    if (validateLayout(layout) !== null) return legacy.read();
    seen.clear();
    for (const [projectId, updatedAtUtc] of parts) seen.set(projectId, updatedAtUtc);
    return { ok: true, data: { status: "loaded", environment, layout, source: "split" } };
  }

  async function writeNow(layout, membership) {
    const problem = validateLayout(layout);
    if (problem !== null) return { ok: false, error: { code: "layout_invalid", reasonCode: problem } };
    const owners = cleanMembership(membership);
    const updatedAtUtc = new Date().toISOString();
    const mounted = await mountedProjectFolders(controllerRoot);
    const away = await awayProjectIds(controllerRoot, mounted);
    // A part on disk this store has not seen came from elsewhere (an import): it stays.
    // An agent the renderer names no project for (the world is not read yet, or
    // the Gateway is paused) stays in the part that holds it.
    const newer = new Set();
    const holder = new Map();
    for (const { projectId, folder } of mounted) {
      const present = await readJson(path.join(folder, "layout.json"));
      if (present === null) continue;
      if (!seen.has(projectId) || seen.get(projectId) !== (present.updatedAtUtc ?? null)) newer.add(projectId);
      for (const agentId of Object.keys(present.agents ?? {})) holder.set(agentId, projectId);
    }
    const parts = new Map(mounted.filter(({ projectId }) => !newer.has(projectId)).map(({ projectId, folder }) => [projectId,
      { folder, value: { schemaVersion: 1, projectId, updatedAtUtc, project: {}, quarters: {}, agents: {} } }]));
    const elsewhere = (projectId) => away.has(projectId) || newer.has(projectId);
    const world = { schemaVersion: 1, updatedAtUtc, projects: {}, quarters: {}, agents: {} };
    for (const [projectId, entry] of Object.entries(layout.projects ?? {})) {
      if (projectId === WORLD_PROJECT) world.projects[projectId] = entry;
      else if (parts.has(projectId)) {
        world.projects[projectId] = pick(entry, GEOMETRY);
        parts.get(projectId).value.project = omit(entry, GEOMETRY);
      } else if (elsewhere(projectId)) world.projects[projectId] = pick(entry, GEOMETRY);
      else world.projects[projectId] = entry;
    }
    // Where a project not on this PC stands is the world's, written by the PC that holds it: a
    // window that never saw it (its map was read before a take brought it) must not erase it.
    const present = await readJson(worldFile);
    for (const projectId of away) {
      if (world.projects[projectId] === undefined && present?.projects?.[projectId] !== undefined) {
        world.projects[projectId] = pick(present.projects[projectId], GEOMETRY);
      }
    }
    for (const [projectId, quarters] of Object.entries(layout.quarters ?? {})) {
      if (parts.has(projectId)) parts.get(projectId).value.quarters = quarters;
      else if (!elsewhere(projectId)) world.quarters[projectId] = quarters;
    }
    for (const [agentId, entry] of Object.entries(layout.agents ?? {})) {
      const projectId = owners.get(agentId) ?? holder.get(agentId) ?? known.get(agentId);
      if (projectId !== undefined) known.set(agentId, projectId);
      if (parts.has(projectId)) parts.get(projectId).value.agents[agentId] = entry;
      else if (!elsewhere(projectId)) world.agents[agentId] = entry;
    }
    try {
      await writeIfChanged(worldFile, world);
      for (const [projectId, { folder, value }] of parts) {
        // A project unmounted meanwhile has no folder any more: its part is in its package.
        if (await writeIfChanged(path.join(folder, "layout.json"), value, { create: false })) {
          seen.set(projectId, updatedAtUtc);
        } else if (!seen.has(projectId)) {
          const present = await readJson(path.join(folder, "layout.json"));
          if (present !== null) seen.set(projectId, present.updatedAtUtc ?? null);
        }
      }
      if (layout.view && typeof layout.view === "object") await writeIfChanged(viewFile, layout.view);
    } catch (error) {
      return { ok: false, error: { code: "layout_not_saved", reasonCode: error?.code ?? "write_failed" } };
    }
    return { ok: true, data: { status: "saved", environment, updatedAtUtc, reloadProjects: [...newer].sort() } };
  }

  function write(layout, membership = {}) {
    const run = queue.then(() => writeNow(layout, membership));
    queue = run.catch(() => undefined);
    return run;
  }

  return { read, write, file: worldFile, environment, split: true };
}

/**
 * The map store of a controller: the split one while the instance is split
 * (checked on every call, so a migration made while Atlas is open is followed
 * from the next read), the old single file otherwise.
 */
export function createInstanceLayoutStore({ controllerRoot = null, legacy, directory, environment }) {
  if (typeof controllerRoot !== "string") return legacy;
  const split = createSplitLayoutStore({ controllerRoot, legacy, directory, environment });
  const current = async () => (await isSplitInstance(controllerRoot) ? split : legacy);
  return {
    read: async () => (await current()).read(),
    write: async (layout, membership) => (await current()).write(layout, membership),
    file: legacy.file,
    environment,
  };
}

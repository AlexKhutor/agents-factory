import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Where the memory and conversation stores live (docs/project-package.md §4-§5).
//
// "single": today's layout, one memory DB and one conversation archive for the
// whole instance under .project-local/orchestration. "split": one folder per
// mounted project under .project-local/projects/<folder>/ with its own
// memory.sqlite and archive.sqlite, plus the reserved project `world` for
// everything that belongs to no project. A marker file chooses split; without
// it an instance stays single (until block 2's migration writes the marker).

export const STORE_LAYOUT_MARKER = "store-layout.v1.json";
export const WORLD_PROJECT_ID = "world";
export const STORE_LAYOUT_ENVIRONMENT = "AGENTS_FACTORY_STORE_LAYOUT";
const PROJECT_FILE = "project.json";
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const PLAIN_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu;

export class ProjectStoreLayoutError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProjectStoreLayoutError";
    this.code = code;
  }
}
function fail(code, detail) { throw new ProjectStoreLayoutError(code, detail); }

async function kind(target) {
  const info = await lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (info === null) return null;
  if (info.isSymbolicLink()) fail("store_layout_link_refused", target);
  return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
}

export function projectsRoot(controllerRoot) {
  return path.join(controllerRoot, ".project-local", "projects");
}

export function singleMemoryDatabase(controllerRoot) {
  return path.join(controllerRoot, ".project-local", "orchestration", "project-memory", "project-memory.v1.sqlite");
}

/**
 * The folder name of a project: the id itself when it is a safe Windows name,
 * else a hash (ids may hold ':' and may be reserved device names).
 */
export function projectFolderName(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) fail("store_project_id_invalid");
  if (PLAIN_FOLDER.test(projectId) && !RESERVED.test(projectId) && !projectId.endsWith(".")) return projectId;
  return `~${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

/**
 * "split" when the marker is there; "single" otherwise. With
 * AGENTS_FACTORY_STORE_LAYOUT=split a new instance (no single memory DB yet)
 * starts split and gets the marker.
 */
export async function resolveStoreLayout(controllerRoot, { env = process.env } = {}) {
  const root = await realpath(controllerRoot);
  const marker = path.join(projectsRoot(root), STORE_LAYOUT_MARKER);
  const markerKind = await kind(marker);
  if (markerKind === "file") {
    const value = JSON.parse(await readFile(marker, "utf8"));
    if (value?.schemaVersion !== 1 || value?.layout !== "split") fail("store_layout_unsupported", marker);
    return { layout: "split", root };
  }
  if (markerKind !== null) fail("store_layout_unsupported", marker);
  if (String(env?.[STORE_LAYOUT_ENVIRONMENT] ?? "").trim().toLowerCase() === "split"
      && await kind(singleMemoryDatabase(root)) === null) {
    await writeStoreLayoutMarker(root);
    return { layout: "split", root };
  }
  return { layout: "single", root };
}

export async function writeStoreLayoutMarker(controllerRoot, { now = () => new Date() } = {}) {
  const directory = projectsRoot(controllerRoot);
  await mkdir(directory, { recursive: true });
  const marker = path.join(directory, STORE_LAYOUT_MARKER);
  if (await kind(marker) === "file") return marker;
  await writeOnce(marker, `${JSON.stringify({ schemaVersion: 1, layout: "split",
    createdAtUtc: now().toISOString() }, null, 2)}\n`);
  return marker;
}

/** The folder of a project's live stores, created with its identity file when asked. */
export async function projectStoreFolder(controllerRoot, projectId, { create = false } = {}) {
  const folder = path.join(projectsRoot(controllerRoot), projectFolderName(projectId));
  const identity = path.join(folder, PROJECT_FILE);
  const present = await kind(identity);
  if (present === "file") {
    const value = JSON.parse(await readFile(identity, "utf8"));
    if (value?.projectId !== projectId) fail("store_project_identity_conflict", folder);
    return folder;
  }
  if (!create) return null;
  await mkdir(folder, { recursive: true });
  await writeOnce(identity, `${JSON.stringify({ schemaVersion: 1, projectId }, null, 2)}\n`);
  const value = JSON.parse(await readFile(identity, "utf8"));
  if (value?.projectId !== projectId) fail("store_project_identity_conflict", folder);
  return folder;
}

/** Writes a small file through a unique temporary; another writer's file in place is kept. */
async function writeOnce(target, text) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    if (await kind(target) !== "file") throw error;
  }
}

/** The projects whose stores are on this PC: [{ projectId, folder }], sorted by projectId. */
export async function mountedProjects(controllerRoot) {
  const directory = projectsRoot(controllerRoot);
  if (await kind(directory) !== "directory") return [];
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(directory, entry.name);
    const identity = path.join(folder, PROJECT_FILE);
    if (await kind(identity) !== "file") continue;
    const value = JSON.parse(await readFile(identity, "utf8"));
    if (typeof value?.projectId !== "string" || projectFolderName(value.projectId) !== entry.name) {
      fail("store_project_identity_conflict", folder);
    }
    found.push({ projectId: value.projectId, folder });
  }
  return found.sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
}

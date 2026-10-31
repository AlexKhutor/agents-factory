import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { MACHINE_ID, projectPolicy, readMachines } from "./machine-identity.mjs";
import { mountedProjects, projectFolderName, resolveStoreLayout, WORLD_PROJECT_ID } from "./project-store-layout.mjs";

// The world's own record of its projects (docs/project-package.md §7): every
// project the world knows, by identity only - id, title, policy, archived -
// whether or not it is on this PC. A project that is not on this PC is shown by
// this identity alone ("not on this PC"); the world keeps no content of it, and
// for its desk tasks only an index line (R34). Two more facts travel with the
// identity, neither of them content:
//   location - the PC it was last mounted on ({ machineId, atUtc }; machineId
//              null: it went into its package), written by create, mount, unmount;
//   summary  - counts and a time, no text ({ agents, quarters, tasksOpen,
//              lastActivityUtc }), as of the last time the project was here.
// Which projects are on this PC is still this PC's own fact (.project-local/projects).

export const WORLD_FOLDER = ".world";
const REGISTRY_FILE = "registry.json";
const TASKS_FOLDER = "tasks";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function fail(code, detail) { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); }
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function registryPath(controllerRoot) {
  return path.join(controllerRoot, WORLD_FOLDER, REGISTRY_FILE);
}

/** The registry: { schemaVersion, projects: { <projectId>: { title, policy, archived } } }. */
export async function readWorldRegistry(controllerRoot) {
  const file = registryPath(controllerRoot);
  if (!await exists(file)) return { schemaVersion: 1, projects: {} };
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value?.schemaVersion !== 1 || !value.projects || typeof value.projects !== "object") fail("world_registry_invalid");
  return value;
}

function location(value) {
  if (value === null || typeof value !== "object" || (value.machineId !== null && !MACHINE_ID.test(String(value.machineId)))
      || typeof value.atUtc !== "string" || !Number.isFinite(Date.parse(value.atUtc))) fail("world_registry_invalid", "location");
  return { machineId: value.machineId, atUtc: value.atUtc };
}

function summary(value) {
  const count = (item) => (Number.isSafeInteger(item) && item >= 0 ? item : fail("world_registry_invalid", "summary"));
  const at = value?.lastActivityUtc;
  if (at !== null && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) fail("world_registry_invalid", "summary");
  return { agents: count(value.agents), quarters: count(value.quarters), tasksOpen: count(value.tasksOpen), lastActivityUtc: at };
}

/**
 * What the world may say about a project that is not here: counts and a time, no
 * text (variant A of the owner's choice, 2026-10-26). Open agents, quarters that
 * are not archived (the headquarters quarter is not one), desk tasks not ended,
 * and the newest agent start or turn request.
 */
export function projectSummary({ projectId, agents = [], scopes = [], archive = null, tasks = [] }) {
  const archivedQuarters = new Set(Object.keys(archive?.quarters ?? {}));
  const own = agents.filter((agent) => agent?.projectId === projectId);
  const times = own.flatMap((agent) => [agent.createdAtUtc, ...(agent.operations ?? []).map((operation) => operation?.requestedAtUtc)])
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value))).sort();
  return {
    agents: own.filter((agent) => agent.state !== "archived").length,
    quarters: scopes.filter((scope) => scope?.kind === "quarter" && scope.projectId === projectId && scope.quarterId !== "hq"
      && !archivedQuarters.has(`${projectId}/${scope.quarterId}`)).length,
    tasksOpen: tasks.filter((task) => !["accepted-by-code", "declined"].includes(task?.stage)).length,
    lastActivityUtc: times.at(-1) ?? null,
  };
}

/** Records projects by identity; fields not given keep their value. Sorted, so a rewrite of the same is the same. */
export async function recordWorldProjects(controllerRoot, entries) {
  const registry = await readWorldRegistry(controllerRoot);
  for (const entry of entries) {
    if (typeof entry?.projectId !== "string" || !ID.test(entry.projectId) || entry.projectId === WORLD_PROJECT_ID) {
      fail("world_registry_invalid", String(entry?.projectId));
    }
    const current = registry.projects[entry.projectId] ?? { title: entry.projectId, policy: { homeOnly: false, allowedMachines: null }, archived: false };
    registry.projects[entry.projectId] = {
      title: typeof entry.title === "string" ? entry.title : current.title,
      policy: entry.policy ? projectPolicy(entry.policy) : current.policy,
      archived: typeof entry.archived === "boolean" ? entry.archived : current.archived,
      location: entry.location === undefined ? current.location ?? null : entry.location === null ? null : location(entry.location),
      summary: entry.summary !== undefined ? summary(entry.summary) : current.summary ?? null,
    };
  }
  const projects = Object.fromEntries(Object.keys(registry.projects).sort(compare).map((id) => [id, registry.projects[id]]));
  await writeJson(registryPath(controllerRoot), { schemaVersion: 1, projects });
  return projects;
}

/** The projects the world knows that are not on this PC: identity only. */
export async function unmountedWorldProjects(controllerRoot) {
  // One database holds every project: none is away.
  if ((await resolveStoreLayout(controllerRoot, { env: {} })).layout !== "split") return [];
  const registry = await readWorldRegistry(controllerRoot);
  const machines = await readMachines(controllerRoot);
  const here = new Set((await mountedProjects(controllerRoot)).map((project) => project.projectId));
  const where = (value) => (value === null || value === undefined ? null
    : { machineId: value.machineId, title: value.machineId === null ? null : machines[value.machineId]?.title ?? value.machineId,
      atUtc: value.atUtc });
  return Object.entries(registry.projects).filter(([projectId]) => !here.has(projectId))
    .map(([projectId, entry]) => ({ projectId, title: entry.title, archived: entry.archived === true,
      homeOnly: entry.policy?.homeOnly === true, allowedMachines: entry.policy?.allowedMachines ?? null,
      location: where(entry.location), summary: entry.summary ?? null, availability: "not-here" }))
    .sort((a, b) => compare(a.projectId, b.projectId));
}

/**
 * Every project the world knows, for the trusted host: identity, policy, where it
 * is, whether it is here, its summary; and this PC and the PCs the world knows.
 */
export async function worldRegistryView(controllerRoot, { thisMachine = null } = {}) {
  const registry = await readWorldRegistry(controllerRoot);
  const here = new Set((await mountedProjects(controllerRoot)).map((project) => project.projectId));
  return {
    schemaVersion: 1,
    split: (await resolveStoreLayout(controllerRoot, { env: {} })).layout === "split",
    thisMachine,
    machines: await readMachines(controllerRoot),
    projects: Object.fromEntries(Object.entries(registry.projects).map(([projectId, entry]) => [projectId,
      { ...entry, location: entry.location ?? null, summary: entry.summary ?? null, here: here.has(projectId) }])),
  };
}

function taskIndexPath(controllerRoot, projectId) {
  return path.join(controllerRoot, WORLD_FOLDER, TASKS_FOLDER, `${projectFolderName(projectId)}.json`);
}

/**
 * The index of a project's desk tasks while the project is not on this PC:
 * per task its id, agent, desk source, stage and times; per agent its source.
 * No task text, no report.
 */
export async function writeWorldTaskIndex(controllerRoot, projectId, { sources, tasks }) {
  const clean = (value) => (typeof value === "string" && value.length <= 160 ? value : null);
  await writeJson(taskIndexPath(controllerRoot, projectId), {
    schemaVersion: 1, projectId,
    sources: sources.map((source) => ({ agentId: clean(source.agentId), sourceId: clean(source.sourceId) }))
      .sort((a, b) => compare(String(a.sourceId), String(b.sourceId))),
    tasks: tasks.map((task) => ({ taskId: clean(task.taskId), agentId: clean(task.agentId), sourceId: clean(task.sourceId),
      stage: clean(task.stage), dispatchedAtUtc: clean(task.dispatchedAtUtc) }))
      .sort((a, b) => compare(String(a.taskId), String(b.taskId))),
  });
}

export async function removeWorldTaskIndex(controllerRoot, projectId) {
  await rm(taskIndexPath(controllerRoot, projectId), { force: true });
}

/** Every task index of a project that is not on this PC. */
export async function readWorldTaskIndexes(controllerRoot) {
  const here = new Set((await mountedProjects(controllerRoot)).map((project) => project.projectId));
  const result = [];
  for (const project of await unmountedWorldProjects(controllerRoot)) {
    const file = taskIndexPath(controllerRoot, project.projectId);
    if (here.has(project.projectId) || !await exists(file)) continue;
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.schemaVersion === 1 && value.projectId === project.projectId) result.push({ ...value, title: project.title });
  }
  return result;
}

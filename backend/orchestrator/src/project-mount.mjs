import { readdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import {
  deskSourceIdOf, exportProject, instancePaths, ProjectPackageError,
} from "./project-package-export.mjs";
import { importProject, packagePlacement, readProjectPackage } from "./project-package-import.mjs";
import { mountedProjects, projectStoreFolder, resolveStoreLayout, WORLD_PROJECT_ID } from "./project-store-layout.mjs";
import { readThisMachine } from "./machine-identity.mjs";
import { readWorldTaskBoard } from "./world-task-board.mjs";
import { projectSummary, recordWorldProjects, removeWorldTaskIndex, writeWorldTaskIndex } from "./world-registry.mjs";

// Mounting and unmounting a project on this PC (docs/project-package.md §7,
// plan 2.6). Unmount exports the project into its package, checks the package,
// and only then takes the project's data off the instance: its stores, its
// agents' session files, desk folders and task materials. The world keeps the
// project's identity (registry) and an index line per desk task (R34), nothing
// else. Mount imports the package back. Both run with the Gateway stopped.

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

async function removeEmptyParents(file, stopAt) {
  let folder = path.dirname(file);
  const stops = new Set(stopAt.map((item) => path.resolve(item).toLowerCase()));
  while (!stops.has(path.resolve(folder).toLowerCase())) {
    const entries = await readdir(folder).catch(() => null);
    if (entries === null || entries.length > 0) return;
    await rmdir(folder).catch(() => {});
    folder = path.dirname(folder);
  }
}

async function holdsFiles(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || await holdsFiles(path.join(folder, entry.name))) return true;
  }
  return false;
}

const documentValue = (files, key) => {
  const text = files.get("memory/documents.jsonl")?.toString("utf8") ?? "";
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const record = JSON.parse(line);
    if (record.key === key) return record.value;
  }
  return null;
};

/**
 * The provider interaction stores (an agent's questions and approvals) of these
 * agent threads, found by the thread each record names, and whether one is
 * still open. Their history is in the conversation archive the package holds.
 */
async function interactionStoresOf(root, threadIds) {
  const base = path.join(root, ".project-local", "orchestration", "provider-interactions");
  const found = [];
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const records = path.join(base, entry.name, "records.v1");
    let mine = false;
    let open = false;
    for (const name of await readdir(records).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      let record;
      try { record = JSON.parse(await readFile(path.join(records, name), "utf8")); } catch {
        fail("unmount_interaction_unreadable", path.join(records, name));
      }
      if (!threadIds.has(record?.providerRequest?.threadId)) continue;
      mine = true;
      if (record.state !== "resolved") open = true;
    }
    if (mine) found.push({ folder: path.join(base, entry.name), open });
  }
  return found;
}

const jsonLinesOf = (files, name) => (files.get(name)?.toString("utf8") ?? "").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line));

/** The world's summary of a project, from its package (counts and a time, no text). */
const packageSummary = (files, projectId, tasks) => projectSummary({
  projectId, agents: documentValue(files, "memory-agents-v1")?.agents ?? [], scopes: jsonLinesOf(files, "memory/scopes.jsonl"),
  archive: documentValue(files, "memory-project-archive-v1"), tasks,
});

/**
 * Takes a project off this PC. `confirm` must name the project (the person's
 * confirmation). The package at `out` is written and checked first; then the
 * project's stores go (from then on it is not mounted), then its files, each
 * only if it is byte for byte the package's copy.
 */
export async function unmountProject({ controllerRoot, projectId, out, confirm, now = () => new Date(), policy = null,
  claudeConfigDir, dshHome }) {
  if (confirm !== projectId) fail("unmount_confirmation_required", projectId);
  if (projectId === WORLD_PROJECT_ID) fail("unmount_world_refused");
  const root = await realpath(controllerRoot);
  if ((await resolveStoreLayout(root, { env: {} })).layout !== "split") fail("store_layout_single", "migrate the instance first");
  const folder = await projectStoreFolder(root, projectId);
  if (folder === null) fail("project_not_mounted", projectId);

  const board = await readWorldTaskBoard({ controllerRoot: root });
  const exported = await exportProject({ controllerRoot: root, projectId, out, now, policy, claudeConfigDir, dshHome });
  const { manifest, files } = await readProjectPackage(out);
  const catalog = documentValue(files, "memory-agents-v1")?.agents ?? [];
  const agents = catalog.map((agent) => agent.agentId);
  // An agent's question or approval still open must be answered first (spec §13.4); answered ones
  // leave this PC with the project (R5), their history goes in the package's archive.
  const interactions = await interactionStoresOf(root,
    new Set(catalog.map((agent) => agent.binding?.threadId).filter((threadId) => typeof threadId === "string")));
  if (interactions.some((store) => store.open)) fail("unmount_interactions_open", projectId);
  const paths = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  const removals = [];
  for (const [name, content] of files) {
    const target = packagePlacement(name, paths);
    if (target === null) continue;
    const present = await readFile(target).catch(() => null);
    if (present === null || !present.equals(content)) fail("unmount_file_changed", target);
    removals.push(target);
  }

  const archived = documentValue(files, "memory-project-archive-v1");
  const sources = new Set(agents.map(deskSourceIdOf));
  await recordWorldProjects(root, [{ projectId, title: manifest.title, policy: manifest.policy,
    archived: Object.hasOwn(archived?.projects ?? {}, projectId),
    location: { machineId: null, atUtc: now().toISOString() },
    summary: packageSummary(files, projectId, board.tasks.filter((task) => sources.has(task.sourceId))) }]);
  await writeWorldTaskIndex(root, projectId, {
    sources: board.sources.filter((source) => sources.has(source.sourceId)),
    tasks: board.tasks.filter((task) => sources.has(task.sourceId)),
  });

  // From here the project is off this PC; what is left of it is identical to its package.
  await rm(folder, { recursive: true, force: true });
  const bases = [paths.claudeSessions, paths.acpSessions, path.join(paths.claudeConfigDir, "projects"),
    path.join(paths.dshHome, "sessions"), path.join(paths.dshHome, "storages", "session_projcache", "sessions"),
    paths.deskAgents, paths.dispatched, paths.definitions, paths.returns, paths.reports, paths.acceptances];
  const anchors = new Set();
  for (const target of removals) {
    await rm(target, { force: true });
    const base = bases.find((item) => !path.relative(item, target).startsWith("..") && !path.isAbsolute(path.relative(item, target)));
    // The folder of one session or task under its base (two levels for slug folders): gone once no file is left in it.
    if (base !== undefined) {
      const parts = path.relative(base, target).split(path.sep);
      if (parts.length > 1) anchors.add(path.join(base, parts[0]));
      if (parts.length > 2) anchors.add(path.join(base, parts[0], parts[1]));
    }
    await removeEmptyParents(target, bases);
  }
  for (const anchor of [...anchors].sort((a, b) => b.length - a.length)) {
    if (!await holdsFiles(anchor)) await rm(anchor, { recursive: true, force: true });
  }
  // The desk folders' machine logs are not in the package; the folders go whole.
  for (const sourceId of sources) await rm(path.join(paths.deskAgents, sourceId), { recursive: true, force: true });
  for (const store of interactions) await rm(store.folder, { recursive: true, force: true });
  return { projectId, package: out, revision: exported.revision, removedFiles: removals.length,
    removedInteractionStores: interactions.length,
    tasksIndexed: board.tasks.filter((task) => sources.has(task.sourceId)).length };
}

/** Brings a project's package onto this PC (import) and drops its task index. */
export async function mountProject({ controllerRoot, packageDir, claudeConfigDir, dshHome, now = () => new Date() }) {
  const root = await realpath(controllerRoot);
  const imported = await importProject({ controllerRoot: root, packageDir, claudeConfigDir, dshHome });
  const { manifest, files } = await readProjectPackage(packageDir);
  const archived = documentValue(files, "memory-project-archive-v1");
  const sources = new Set((documentValue(files, "memory-agents-v1")?.agents ?? [])
    .filter((agent) => agent.projectId === manifest.projectId).map((agent) => deskSourceIdOf(agent.agentId)));
  const board = await readWorldTaskBoard({ controllerRoot: root });
  const machine = await readThisMachine(root);
  await recordWorldProjects(root, [{ projectId: manifest.projectId, title: manifest.title, policy: manifest.policy,
    archived: Object.hasOwn(archived?.projects ?? {}, manifest.projectId),
    location: machine === null ? null : { machineId: machine.machineId, atUtc: now().toISOString() },
    summary: packageSummary(files, manifest.projectId, board.tasks.filter((task) => sources.has(task.sourceId))) }]);
  await removeWorldTaskIndex(root, manifest.projectId);
  return imported;
}

/** Records every mounted project in the world registry (after a migration, or to repair it). */
export async function recordMountedProjects(controllerRoot, titles = new Map()) {
  const root = await realpath(controllerRoot);
  const entries = (await mountedProjects(root)).filter((project) => project.projectId !== WORLD_PROJECT_ID)
    .map((project) => ({ projectId: project.projectId, ...(titles.has(project.projectId) ? titles.get(project.projectId) : {}) }));
  return recordWorldProjects(root, entries);
}

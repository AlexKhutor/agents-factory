import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { readMachines, readThisMachine } from "./machine-identity.mjs";
import { createProjectMemoryStore } from "./project-memory-store.mjs";
import { mountProject, unmountProject } from "./project-mount.mjs";
import {
  canonicalJson, deskSourceIdOf, exportProject, gatewayRunning, instancePaths, ProjectPackageError,
} from "./project-package-export.mjs";
import { importProject, packagePlacement, readProjectPackage } from "./project-package-import.mjs";
import {
  mountedProjects, projectStoreFolder, resolveStoreLayout, singleMemoryDatabase, WORLD_PROJECT_ID, writeStoreLayoutMarker,
} from "./project-store-layout.mjs";
import { readProjectWorkspace } from "./project-workspace-binding.mjs";
import { loadNodeSqlite } from "./sqlite-backend.mjs";
import { openReadOnlyDatabase } from "./sqlite-node-connection.mjs";
import {
  cloneRepo, commit, ensureRepo, fastForward, fetchBranch, git, head, isRepo, localChanges, pushAll, showFile, stageAll,
} from "./sync-git.mjs";
import { projectSummary, readWorldRegistry, recordWorldProjects } from "./world-registry.mjs";
import { readWorldTaskBoard } from "./world-task-board.mjs";

// Block 3: taking and releasing the world and projects between PCs
// (docs/project-package.md §14). Every repo has a lock (`sync-lock.json`)
// whose truth is the repo's primary remote: a take or a release counts only
// once its push to the primary succeeded. The world is the instance folder;
// a project is its package folder. Remotes, the packages root and what this PC
// released last are machine-local (`.project-local/sync.json`,
// `sync-state.json`). Everything runs with the Gateway stopped.

const CONFIG_FILE = path.join(".project-local", "sync.json");
const STATE_FILE = path.join(".project-local", "sync-state.json");
const LOCK_FILE = "sync-lock.json";
const WORLD_PACKAGE = path.join(".world", "package");
const NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const NO_POLICY = Object.freeze({ homeOnly: false, allowedMachines: null });

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

async function writeJsonOver(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

// --- configuration and state (machine-local) ----------------------------------------------

function remotesOf(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) fail("sync_config_invalid", `${label}.remotes`);
  const names = new Set();
  const remotes = value.map((remote) => {
    if (!remote || typeof remote !== "object" || typeof remote.url !== "string" || remote.url.trim() === ""
        || typeof remote.name !== "string" || !NAME.test(remote.name) || names.has(remote.name)) {
      fail("sync_config_invalid", `${label}.remotes`);
    }
    names.add(remote.name);
    return { name: remote.name, url: remote.url, primary: remote.primary === true, home: remote.home === true };
  });
  if (remotes.filter((remote) => remote.primary).length !== 1) fail("sync_config_invalid", `${label}: one primary remote`);
  return remotes;
}

/** This PC's sync settings; null when the instance is not synced (mode `local`). */
export async function readSyncConfig(controllerRoot) {
  let value;
  try { value = JSON.parse(await readFile(path.join(controllerRoot, CONFIG_FILE), "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("sync_config_invalid", "sync.json");
  }
  return syncConfigOf(value);
}

/** The instance's modes (plan 5.1, §14.9): everything on one PC, or the world and projects between PCs. */
export const INSTANCE_MODES = Object.freeze(["local", "synced"]);

/** The mode instance.json records, or null when it records none (then sync.json decides). */
export async function recordedMode(root) {
  try {
    const mode = JSON.parse(await readFile(path.join(root, "instance.json"), "utf8"))?.mode;
    return INSTANCE_MODES.includes(mode) ? mode : null;
  } catch {
    return null;
  }
}

/** A parsed sync.json, checked (§14.5); `sync_config_invalid` names the first wrong field. */
export function syncConfigOf(value) {
  if (value?.schemaVersion !== 1) fail("sync_config_invalid", "schemaVersion");
  const branch = value.branch ?? "main";
  if (typeof branch !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(branch)) fail("sync_config_invalid", "branch");
  if (typeof value.packagesRoot !== "string" || !path.isAbsolute(value.packagesRoot)) fail("sync_config_invalid", "packagesRoot");
  if (typeof value.author?.name !== "string" || typeof value.author?.email !== "string"
      || value.author.name.trim() === "" || !/^[^\s@]+@[^\s@]+$/u.test(value.author.email)) {
    fail("sync_config_invalid", "author");
  }
  const projects = {};
  for (const [projectId, entry] of Object.entries(value.projects ?? {})) {
    if (!ID.test(projectId) || projectId === WORLD_PROJECT_ID) fail("sync_config_invalid", `projects.${projectId}`);
    projects[projectId] = { remotes: remotesOf(entry?.remotes, projectId) };
  }
  return { branch, packagesRoot: value.packagesRoot, author: { name: value.author.name, email: value.author.email },
    world: { remotes: remotesOf(value.world?.remotes, "world") }, projects };
}

/** Whether sync began here: this PC took or released something, or the instance is the world repo. */
export async function syncBegun(root) {
  return await exists(path.join(root, STATE_FILE)) || await isRepo(root);
}

/** What this PC holds and what it released last (machine-local). */
export async function readSyncState(controllerRoot) {
  try {
    const value = JSON.parse(await readFile(path.join(controllerRoot, STATE_FILE), "utf8"));
    if (value?.schemaVersion === 1) return { world: { held: false, releasedSha256: null, ...value.world }, projects: value.projects ?? {} };
  } catch (error) {
    if (error?.code !== "ENOENT") fail("sync_state_invalid", "sync-state.json");
  }
  return { world: { held: false, releasedSha256: null }, projects: {} };
}

async function writeSyncState(root, state) {
  await writeJsonOver(path.join(root, STATE_FILE), { schemaVersion: 1, ...state });
}

// --- locks, hashes, secrets ----------------------------------------------------------------

function lockOf(text, label) {
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); } catch { fail("sync_lock_invalid", label); }
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !(value.holder === null || (typeof value.holder === "string" && value.holder !== ""))) fail("sync_lock_invalid", label);
  return value;
}

async function remoteLock(dir, remote, branch, label) {
  return lockOf(await showFile(dir, `refs/remotes/${remote.name}/${branch}`, LOCK_FILE), label);
}

async function writeLock(dir, lock) {
  await writeFile(path.join(dir, LOCK_FILE), `${JSON.stringify({ schemaVersion: 1, ...lock }, null, 2)}\n`, "utf8");
}

/** A package's content hash: its manifest's file list (names, sizes, hashes), not its times. */
async function packageHash(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, "project.af.json"), "utf8"));
  return createHash("sha256").update(canonicalJson(manifest.files ?? {})).digest("hex");
}

const SECRET_FILES = new Set([".credentials.json", ".claude.json", "connection.v1.json"]);
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/u, /\bsk-[A-Za-z0-9]{32,}\b/u, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, /"(?:accessToken|refreshToken)"\s*:\s*"[^"]{8,}"/u,
];

/** Refuses a push that would carry a secret (plan risk "secrets leak to GitHub"). */
async function scanStaged(dir, files) {
  for (const name of files) {
    if (SECRET_FILES.has(path.basename(name))) fail("sync_secret_found", name);
    const full = path.join(dir, name);
    const info = await lstat(full).catch(() => null);
    if (info === null || !info.isFile() || info.size > 32 * 1024 * 1024) continue;
    const content = await readFile(full);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) fail("sync_secret_found", name);
  }
}

async function commitAndPush(dir, remotes, branch, message) {
  await scanStaged(dir, await stageAll(dir));
  const committed = await commit(dir, message);
  return { committed, ...await pushAll(dir, remotes, branch) };
}

// --- policy -------------------------------------------------------------------------------

/** May this PC hold the project at all (§8: deny wins)? */
function mayHold(policy, machine) {
  if (policy.homeOnly && machine.home !== true) return false;
  if (Array.isArray(policy.allowedMachines) && !policy.allowedMachines.includes(machine.machineId)) return false;
  return true;
}

/** Is this PC the only one that may hold it? Then a release is a backup: it stays here. */
function onlyHere(policy, machine, machines) {
  if (Array.isArray(policy.allowedMachines)) return policy.allowedMachines.length === 1 && policy.allowedMachines[0] === machine.machineId;
  if (!policy.homeOnly) return false;
  return !Object.entries(machines).some(([machineId, item]) => machineId !== machine.machineId && item.home === true);
}

async function context(controllerRoot, { needGatewayStopped = true } = {}) {
  const root = await realpath(controllerRoot);
  if (await recordedMode(root) === "local") fail("sync_mode_local", "agents-factory instance mode --set synced");
  const config = await readSyncConfig(root);
  if (config === null) fail("sync_not_configured", CONFIG_FILE);
  const machine = await readThisMachine(root);
  if (machine === null) fail("sync_machine_unnamed", "agents-factory machine set");
  if (needGatewayStopped && await gatewayRunning(path.join(root, ".project-local", "application-gateway", "status.v1.json"))) {
    fail("gateway_running");
  }
  return { root, config, machine, machines: await readMachines(root), state: await readSyncState(root) };
}

const stamp = (now) => now().toISOString().replace(/[-:.]/gu, "");
const primaryOf = (remotes) => remotes.find((remote) => remote.primary);

/**
 * The world says where each project held here is and what it holds, by counts
 * and a time (projectSummary, no text): a project that only stays on its PC is
 * never unmounted or mounted, so without this the other PC would see the
 * summary of the day it was made. Read from each store, read-only.
 */
async function recordHeldProjects(root, machine, now) {
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) return [];
  const board = await readWorldTaskBoard({ controllerRoot: root });
  const entries = [];
  for (const { projectId, folder } of await mountedProjects(root)) {
    if (projectId === WORLD_PROJECT_ID) continue;
    const db = openReadOnlyDatabase(sqlite, path.join(folder, "memory.sqlite"));
    let agents = [];
    let archive = null;
    let scopes = [];
    try {
      for (const row of db.prepare("SELECT key, value_json FROM memory_documents WHERE key IN ('memory-agents-v1', 'memory-project-archive-v1')").all()) {
        const value = JSON.parse(row.value_json);
        if (row.key === "memory-agents-v1") agents = value?.agents ?? [];
        else archive = value;
      }
      scopes = db.prepare("SELECT kind, project_id AS projectId, quarter_id AS quarterId FROM memory_scopes").all();
    } finally {
      db.close();
    }
    const sources = new Set(agents.map((agent) => deskSourceIdOf(agent.agentId)));
    entries.push({ projectId, location: { machineId: machine.machineId, atUtc: now().toISOString() },
      summary: projectSummary({ projectId, agents, scopes, archive, tasks: board.tasks.filter((task) => sources.has(task.sourceId)) }) });
  }
  if (entries.length > 0) await recordWorldProjects(root, entries);
  return entries.map((entry) => entry.projectId);
}

// --- the world ----------------------------------------------------------------------------

/** Makes the instance the world repo and pushes it first, held by this PC (§14.6 `sync init`). */
export async function initWorld({ controllerRoot, now = () => new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  await ensureRepo(root, { branch: config.branch, author: config.author, remotes: config.world.remotes });
  const primary = primaryOf(config.world.remotes);
  if (await fetchBranch(root, primary.name, config.branch)) fail("sync_already_initialized", primary.name);
  await recordHeldProjects(root, machine, now);
  await exportProject({ controllerRoot: root, projectId: WORLD_PROJECT_ID, out: path.join(root, WORLD_PACKAGE), now });
  const releasedSha256 = await packageHash(path.join(root, WORLD_PACKAGE));
  await writeLock(root, { holder: machine.machineId, sequence: 1, changedAtUtc: now().toISOString(), releasedSha256 });
  const pushed = await commitAndPush(root, config.world.remotes, config.branch, `world: first push from ${machine.machineId}`);
  state.world = { held: true, releasedSha256 };
  await writeSyncState(root, state);
  return { target: "world", action: "initialized", holder: machine.machineId, ...pushed };
}

export async function releaseWorld({ controllerRoot, now = () => new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  await ensureRepo(root, { branch: config.branch, author: config.author, remotes: config.world.remotes });
  const primary = primaryOf(config.world.remotes);
  if (!await fetchBranch(root, primary.name, config.branch)) fail("sync_not_initialized", "world");
  const lock = await remoteLock(root, primary, config.branch, "world");
  if (lock?.holder !== machine.machineId) fail("sync_not_holder", lock?.holder ?? "free");
  await fastForward(root, primary.name, config.branch);
  const held = await recordHeldProjects(root, machine, now);
  await exportProject({ controllerRoot: root, projectId: WORLD_PROJECT_ID, out: path.join(root, WORLD_PACKAGE), now });
  const releasedSha256 = await packageHash(path.join(root, WORLD_PACKAGE));
  await writeLock(root, { holder: null, sequence: lock.sequence + 1, changedAtUtc: now().toISOString(), releasedSha256 });
  const pushed = await commitAndPush(root, config.world.remotes, config.branch, `world: released by ${machine.machineId}`);
  state.world = { held: false, releasedSha256 };
  await writeSyncState(root, state);
  return { target: "world", action: "released", sequence: lock.sequence + 1, recorded: held, ...pushed };
}

/**
 * The world store of this PC before a take: what it released last (or none)
 * may be replaced; anything else was changed here without the lock.
 */
async function checkLocalWorld(root, state, incomingSha256, now) {
  const store = await projectStoreFolder(root, WORLD_PROJECT_ID);
  if (store === null) return null;
  const backup = path.join(root, ".project-local", "backups", `take-${stamp(now)}`, "world");
  await exportProject({ controllerRoot: root, projectId: WORLD_PROJECT_ID, out: backup, now });
  const here = await packageHash(backup);
  if (here === incomingSha256) return { backup, same: true, store };
  if (here !== state.world.releasedSha256) fail("sync_world_changed_here", backup);
  return { backup, same: false, store };
}

/** Puts the taken world package in place of this PC's old world store (kept in `backup`). */
async function replaceWorldStore(root, local) {
  if (local !== null && local.same) return false;
  if (local !== null) {
    const paths = await instancePaths(root, WORLD_PROJECT_ID);
    const { files } = await readProjectPackage(local.backup);
    for (const [name] of files) {
      const target = packagePlacement(name, paths);
      if (target !== null) await rm(target, { force: true });
    }
    await rm(local.store, { recursive: true, force: true });
  }
  await importProject({ controllerRoot: root, packageDir: path.join(root, WORLD_PACKAGE) });
  return true;
}

export async function takeWorld({ controllerRoot, now = () => new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  await ensureRepo(root, { branch: config.branch, author: config.author, remotes: config.world.remotes });
  const primary = primaryOf(config.world.remotes);
  if (!await fetchBranch(root, primary.name, config.branch)) fail("sync_not_initialized", "world");
  const lock = await remoteLock(root, primary, config.branch, "world");
  if (lock === null) fail("sync_lock_invalid", "world: no lock");
  if (lock.holder !== null && lock.holder !== machine.machineId) fail("sync_held_elsewhere", lock.holder);
  if (lock.holder === machine.machineId && state.world.held) return { target: "world", action: "already-held" };
  // This PC's own name file (machine set) is the one change it may bring: it goes with the take.
  const own = `machine/${machine.machineId}.json`;
  const changes = (await localChanges(root)).filter((line) => line.slice(3).replace(/^"|"$/gu, "") !== own);
  if (changes.length > 0) fail("sync_local_changes", changes.slice(0, 5).join("; "));
  // A PC that never had a store (a fresh clone of the world) starts in the split layout.
  if ((await resolveStoreLayout(root, { env: {} })).layout !== "split") {
    if (await exists(singleMemoryDatabase(root))) fail("store_layout_single", "migrate the instance first");
    await writeStoreLayoutMarker(root, { now });
  }
  // What is here is checked before anything arrives: the files the old store placed are still its own.
  const local = await checkLocalWorld(root, state, lock.releasedSha256, now);
  await fastForward(root, primary.name, config.branch);
  let pushed = null;
  if (lock.holder !== machine.machineId) {
    await writeLock(root, { holder: machine.machineId, sequence: lock.sequence + 1, changedAtUtc: now().toISOString(),
      releasedSha256: lock.releasedSha256 });
    pushed = await commitAndPush(root, config.world.remotes, config.branch, `world: taken by ${machine.machineId}`);
  }
  const replaced = await replaceWorldStore(root, local);
  state.world = { held: true, releasedSha256: lock.releasedSha256 };
  await writeSyncState(root, state);
  return { target: "world", action: "taken", replaced, backup: local?.backup ?? null, ...(pushed ?? {}) };
}

// --- projects -----------------------------------------------------------------------------

async function projectPolicyOf(root, projectId) {
  return (await readWorldRegistry(root)).projects[projectId]?.policy ?? NO_POLICY;
}

function projectRemotes(config, projectId, policy) {
  const entry = config.projects[projectId];
  if (entry === undefined) fail("sync_project_not_configured", projectId);
  // R37: a home-only project goes only to remotes at home.
  if (policy.homeOnly && entry.remotes.some((remote) => !remote.home)) fail("sync_remote_not_home", projectId);
  return entry.remotes;
}

/** The project's folder for its agents must be committed and pushed before it leaves (§14.1). */
async function pushWorkspace(root, projectId) {
  const store = await createProjectMemoryStore({ controllerRoot: root });
  let workspace;
  try { workspace = await readProjectWorkspace(store, { projectId }); } finally { await store.close?.(); }
  if (!workspace.configured) return { workspace: "none" };
  const folder = workspace.workspacePath;
  if (!await exists(folder) || !await isRepo(folder)) return { workspace: "not-synced", folder };
  if ((await localChanges(folder)).length > 0) fail("sync_workspace_not_pushed", `${folder}: uncommitted changes`);
  const upstream = await git(folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
  if (upstream.code !== 0) fail("sync_workspace_not_pushed", `${folder}: no upstream`);
  const ahead = Number((await git(folder, ["rev-list", "--count", "@{u}..HEAD"])).stdout.trim());
  if (ahead > 0) {
    const pushed = await git(folder, ["push", "--porcelain"], { allowFail: true });
    if (pushed.code !== 0) fail("sync_workspace_not_pushed", `${folder}: push refused`);
  }
  return { workspace: "pushed", folder, commits: ahead };
}

async function packageRepo(config, projectId, remotes) {
  const dir = path.join(config.packagesRoot, projectId);
  await mkdir(dir, { recursive: true });
  await ensureRepo(dir, { branch: config.branch, author: config.author, remotes });
  return dir;
}

/**
 * Releases a project held here: into its package repo and off this PC — or,
 * when only this PC may hold it (R37: the inZOI project at home), as a backup
 * that stays mounted and held.
 */
export async function releaseProject({ controllerRoot, projectId, now = () => new Date() }) {
  const { root, config, machine, machines, state } = await context(controllerRoot);
  const policy = await projectPolicyOf(root, projectId);
  const remotes = projectRemotes(config, projectId, policy);
  if (await projectStoreFolder(root, projectId) === null) fail("project_not_mounted", projectId);
  const dir = await packageRepo(config, projectId, remotes);
  const primary = primaryOf(remotes);
  const known = await fetchBranch(dir, primary.name, config.branch);
  const lock = known ? await remoteLock(dir, primary, config.branch, projectId) : null;
  if (lock?.holder && lock.holder !== machine.machineId) fail("sync_held_elsewhere", lock.holder);
  if (known) await fastForward(dir, primary.name, config.branch);
  const stays = onlyHere(policy, machine, machines);
  let workspace = null;
  if (stays) {
    await exportProject({ controllerRoot: root, projectId, out: dir, now, policy });
  } else {
    workspace = await pushWorkspace(root, projectId);
    await unmountProject({ controllerRoot: root, projectId, out: dir, confirm: projectId, now, policy });
  }
  const releasedSha256 = await packageHash(dir);
  const sequence = (lock?.sequence ?? 0) + 1;
  await writeLock(dir, { holder: stays ? machine.machineId : null, sequence, changedAtUtc: now().toISOString(), releasedSha256 });
  const pushed = await commitAndPush(dir, remotes, config.branch,
    `${projectId}: ${stays ? "backup" : "released"} by ${machine.machineId}`);
  state.projects[projectId] = { held: stays, releasedSha256 };
  await writeSyncState(root, state);
  return { target: projectId, action: stays ? "backed-up" : "released", sequence, workspace, ...pushed };
}

/** Takes a free project this PC may hold: policy first, before anything is fetched (§8). */
export async function takeProject({ controllerRoot, projectId, now = () => new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  const policy = await projectPolicyOf(root, projectId);
  if (!mayHold(policy, machine)) fail("sync_policy_denied", projectId);
  const remotes = projectRemotes(config, projectId, policy);
  const dir = path.join(config.packagesRoot, projectId);
  const primary = primaryOf(remotes);
  if (!await exists(dir)) {
    await mkdir(config.packagesRoot, { recursive: true });
    await cloneRepo(config.packagesRoot, dir, primary, config.branch);
  }
  await ensureRepo(dir, { branch: config.branch, author: config.author, remotes });
  if (!await fetchBranch(dir, primary.name, config.branch)) fail("sync_not_initialized", projectId);
  const lock = await remoteLock(dir, primary, config.branch, projectId);
  if (lock === null) fail("sync_lock_invalid", `${projectId}: no lock`);
  if (lock.holder !== null && lock.holder !== machine.machineId) fail("sync_held_elsewhere", lock.holder);
  const changes = await localChanges(dir);
  if (changes.length > 0) fail("sync_local_changes", `${projectId}: ${changes.slice(0, 5).join("; ")}`);
  await fastForward(dir, primary.name, config.branch);
  let pushed = null;
  if (lock.holder !== machine.machineId) {
    await writeLock(dir, { holder: machine.machineId, sequence: lock.sequence + 1, changedAtUtc: now().toISOString(),
      releasedSha256: lock.releasedSha256 });
    pushed = await commitAndPush(dir, remotes, config.branch, `${projectId}: taken by ${machine.machineId}`);
  }
  const mounted = await projectStoreFolder(root, projectId) !== null;
  const result = mounted ? null : await mountProject({ controllerRoot: root, packageDir: dir, now });
  state.projects[projectId] = { held: true, releasedSha256: lock.releasedSha256 };
  await writeSyncState(root, state);
  return { target: projectId, action: mounted ? "already-mounted" : "taken", mounted: result !== null, ...(pushed ?? {}) };
}

// --- all at once and status ---------------------------------------------------------------

/** Every project held here (released, or backed up when it may live only here), then the world. */
export async function releaseAll({ controllerRoot, now = () => new Date() }) {
  const { root, config } = await context(controllerRoot);
  const results = [];
  const local = [];
  for (const { projectId } of await mountedProjects(root)) {
    if (projectId === WORLD_PROJECT_ID) continue;
    if (config.projects[projectId] === undefined) { local.push(projectId); continue; }
    results.push(await releaseProject({ controllerRoot: root, projectId, now }));
  }
  results.push(await releaseWorld({ controllerRoot: root, now }));
  return { results, stayLocal: local };
}

/** The world, then every configured project this PC may hold that is free. */
export async function takeAll({ controllerRoot, now = () => new Date() }) {
  const results = [await takeWorld({ controllerRoot, now })];
  const { root, config, machine } = await context(controllerRoot);
  const registry = await readWorldRegistry(root);
  const skipped = [];
  for (const projectId of Object.keys(config.projects).sort()) {
    const policy = registry.projects[projectId]?.policy ?? NO_POLICY;
    if (!mayHold(policy, machine)) { skipped.push({ projectId, reason: "sync_policy_denied" }); continue; }
    try {
      results.push(await takeProject({ controllerRoot: root, projectId, now }));
    } catch (error) {
      if (!(error instanceof ProjectPackageError) || !["sync_held_elsewhere", "sync_not_initialized"].includes(error.code)) throw error;
      skipped.push({ projectId, reason: error.code });
    }
  }
  return { results, skipped };
}

/** What this PC holds, by its own record; with `remote`, also each primary's lock. */
export async function syncStatus({ controllerRoot, remote = false }) {
  const root = await realpath(controllerRoot);
  const recorded = await recordedMode(root);
  const config = await readSyncConfig(root);
  if (config === null || recorded === "local") return { configured: config !== null, mode: recorded ?? "local" };
  const machine = await readThisMachine(root);
  const machines = await readMachines(root);
  const state = await readSyncState(root);
  const mounted = new Set((await mountedProjects(root)).map((project) => project.projectId));
  const registry = await readWorldRegistry(root);
  const lockAt = async (dir, remotes, label) => {
    if (!remote || !await exists(dir) || !await isRepo(dir)) return null;
    try {
      const primary = primaryOf(remotes);
      if (!await fetchBranch(dir, primary.name, config.branch)) return { reachable: true, holder: null, initialized: false };
      const lock = await remoteLock(dir, primary, config.branch, label);
      return { reachable: true, initialized: true, holder: lock?.holder ?? null, sequence: lock?.sequence ?? null };
    } catch (error) {
      return { reachable: false, code: error?.code ?? "sync_git_failed" };
    }
  };
  const projects = [];
  for (const projectId of [...new Set([...Object.keys(config.projects), ...[...mounted].filter((id) => id !== WORLD_PROJECT_ID)])].sort()) {
    const policy = registry.projects[projectId]?.policy ?? NO_POLICY;
    const entry = config.projects[projectId];
    projects.push({ projectId, configured: entry !== undefined, mounted: mounted.has(projectId),
      held: state.projects[projectId]?.held === true, policy,
      mayHold: machine === null ? null : mayHold(policy, machine),
      onlyHere: machine === null ? null : onlyHere(policy, machine, machines),
      remote: entry === undefined ? null : await lockAt(path.join(config.packagesRoot, projectId), entry.remotes, projectId) });
  }
  return { configured: true, mode: "synced", machine, machines, world: { held: state.world.held === true,
    remote: await lockAt(root, config.world.remotes, "world") }, projects };
}

// --- recovery -----------------------------------------------------------------------------

const ownMachineFile = (machine) => `machine/${machine.machineId}.json`;
const changedPath = (line) => line.slice(3).replace(/^"|"$/gu, "");

/** This PC's latest step in a repo's history: what it last did to the lock, and the lock it wrote then. */
async function lastOwnStep(dir, ref, label, machineId) {
  const steps = new Map([[`${label}: released by ${machineId}`, "released"], [`${label}: taken by ${machineId}`, "taken"],
    [`${label}: backup by ${machineId}`, "backed-up"], [`${label}: first push from ${machineId}`, "initialized"]]);
  for (const line of (await git(dir, ["log", "--format=%H%x09%s", ref])).stdout.split(/\r?\n/u)) {
    const [sha, subject] = line.split("\t");
    if (steps.has(subject)) return { step: steps.get(subject), lock: lockOf(await showFile(dir, sha, LOCK_FILE), label) };
  }
  return null;
}

const countOf = async (dir, range) => Number((await git(dir, ["rev-list", "--count", range])).stdout.trim());

/**
 * One repo (the world or a project's package) against its primary remote, this PC's record and its mirrors.
 * Every finding names the action that settles it, or none when only a person can decide (`hint`).
 */
async function recoverTarget(ctx, target, { apply, now }) {
  const { root, config, machine, state } = ctx;
  const { dir, remotes, label, world } = target;
  const findings = [];
  const note = (kind, detail, action, hint = null) => {
    const finding = { target: label, kind, detail, action, ...(hint === null ? {} : { hint }) };
    findings.push(finding);
    return finding;
  };
  const record = () => (world ? state.world : state.projects[label]) ?? { held: false, releasedSha256: null };
  const setRecord = async (value) => {
    if (world) state.world = value; else state.projects[label] = value;
    await writeSyncState(root, state);
  };
  if (!await exists(dir) || !await isRepo(dir)) return findings;
  const primary = primaryOf(remotes);
  const ref = `refs/remotes/${primary.name}/${config.branch}`;
  let initialized;
  try {
    initialized = await fetchBranch(dir, primary.name, config.branch);
  } catch (error) {
    note("unreachable", `${primary.name}: ${error.message}`, null, "check the connection and run sync recover again");
    return findings;
  }
  const dirty = (await localChanges(dir)).filter((line) => !world || changedPath(line) !== ownMachineFile(machine));
  // The lock as the primary will hold it once this PC's own unpushed commits are pushed (none: never pushed).
  let lockRef = initialized ? ref : null;
  let unpushed = false;
  if (await head(dir) !== null) {
    const ahead = await countOf(dir, initialized ? `${ref}..HEAD` : "HEAD");
    const behind = initialized ? await countOf(dir, `HEAD..${ref}`) : 0;
    if (ahead > 0 && behind === 0) {
      unpushed = true;
      const finding = note("unpushed", `${ahead} commit(s) of this PC are not in ${primary.name}`, "push");
      if (apply) {
        finding.result = await pushAll(dir, remotes, config.branch);
        await fetchBranch(dir, primary.name, config.branch);
        lockRef = ref;
      } else {
        lockRef = "HEAD";
      }
    } else if (ahead > 0) {
      const subjects = (await git(dir, ["log", "--format=%s", `${ref}..HEAD`])).stdout.split(/\r?\n/u).filter(Boolean);
      const lost = subjects.every((subject) => subject === `${label}: taken by ${machine.machineId}`);
      if (!lost || dirty.length > 0) {
        note("diverged", `${ahead} commit(s) here, ${behind} in ${primary.name}: ${subjects.slice(0, 3).join("; ")}`, null,
          "both sides hold work: settle it in git by hand, nothing was changed");
        return findings;
      }
      // Another PC took the lock first: this PC's take never counted (§14: the primary is the truth). A take
      // commits only the lock (and this PC's own name file, which stays as a change, as before the take).
      const finding = note("lost-race", `this PC's take lost to ${primary.name}`, "drop-local");
      if (apply) {
        const kept = `refs/agents-factory/recover-${stamp(now)}`;
        await git(dir, ["update-ref", kept, "HEAD"]);
        await git(dir, ["reset", "-q", "--keep", ref]);
        if (world && await showFile(dir, kept, ownMachineFile(machine)) !== null) {
          await git(dir, ["checkout", kept, "--", ownMachineFile(machine)]);
          await git(dir, ["reset", "-q", "--", ownMachineFile(machine)]);
        }
        finding.kept = kept;
      }
    }
  }
  const lock = lockRef === null ? null : lockOf(await showFile(dir, lockRef, LOCK_FILE), label);
  const held = record().held === true;
  const mounted = world || (await mountedProjects(root)).some((project) => project.projectId === label);

  if (!world && !mounted && dirty.length > 0 && (lock === null || lock.holder === machine.machineId)) {
    // A release that unmounted the project and stopped before its commit: nobody else could have written
    // this package, and it checks out complete (hashes), so the release is finished as it would have been.
    const finding = note("release-not-finished", "the project left this PC but its release was not pushed", "finish-release");
    if (apply) {
      await readProjectPackage(dir);
      await ensureRepo(dir, { branch: config.branch, author: config.author, remotes });
      const releasedSha256 = await packageHash(dir);
      await writeLock(dir, { holder: null, sequence: (lock?.sequence ?? 0) + 1, changedAtUtc: now().toISOString(), releasedSha256 });
      finding.result = await commitAndPush(dir, remotes, config.branch, `${label}: released by ${machine.machineId}`);
      await setRecord({ held: false, releasedSha256 });
    }
    return findings;
  }
  if (lock === null) return findings;
  if (dirty.length > 0 && !held) {
    // Changed here without the lock: a take refuses it (sync_local_changes). Kept in a stash, not lost.
    const finding = note("changed-without-lock", dirty.slice(0, 5).map(changedPath).join("; "), "set-aside");
    if (apply) {
      const message = `agents-factory recover ${stamp(now)}`;
      await git(dir, ["stash", "push", "--include-untracked", "-m", message, "--", ".",
        ...(world ? [`:(exclude)${ownMachineFile(machine)}`] : [])]);
      finding.stash = message;
    }
  }
  if (held && lock.holder !== machine.machineId) {
    const last = await lastOwnStep(dir, lockRef, label, machine.machineId);
    if (last?.step === "released" && last.lock !== null) {
      const finding = note("release-not-recorded", `${primary.name} has this PC's release; this PC still counts it held`, "record-release");
      if (apply) await setRecord({ held: false, releasedSha256: last.lock.releasedSha256 });
    } else {
      note("held-elsewhere", `this PC counts it held, ${primary.name} names ${lock.holder ?? "nobody"}`, null,
        "no release of this PC explains it: ask on the other PC before changing anything");
    }
  } else if (!held && lock.holder === machine.machineId) {
    // A take pushed its lock and stopped before the store arrived here: the same take finishes it.
    const finding = note("take-not-finished", `${primary.name} names this PC, the store did not arrive`, "finish-take");
    if (apply) {
      try {
        finding.result = world ? await takeWorld({ controllerRoot: root, now })
          : await takeProject({ controllerRoot: root, projectId: label, now });
      } catch (error) {
        if (!(error instanceof ProjectPackageError)) throw error;
        finding.error = error.code;
      }
      // The take wrote its own record: the next target must not write back the old one.
      Object.assign(state, await readSyncState(root));
    }
  }
  if (unpushed) return findings;
  for (const mirror of remotes.filter((remote) => !remote.primary)) {
    let present;
    try { present = await fetchBranch(dir, mirror.name, config.branch); } catch {
      note("mirror-unreachable", mirror.name, null, "it catches up on the next push once it is reachable");
      continue;
    }
    const mirrorRef = `refs/remotes/${mirror.name}/${config.branch}`;
    if (present && await countOf(dir, `${mirrorRef}..${ref}`) === 0) continue;
    if (present && await countOf(dir, `${ref}..${mirrorRef}`) > 0) {
      note("mirror-diverged", `${mirror.name} has commits ${primary.name} lacks`, null, "the primary is the truth: compare them by hand");
      continue;
    }
    const finding = note("mirror-behind", `${mirror.name} lacks commits of ${primary.name}`, "push-mirror");
    if (apply) {
      const pushed = await git(dir, ["push", "--porcelain", mirror.name, `${ref}:refs/heads/${config.branch}`], { allowFail: true });
      finding.result = { pushed: pushed.code === 0 };
    }
  }
  return findings;
}

/**
 * Stuck sync states without hand-made git (roadmap step 1, §14.10): a commit not pushed, a take lost to
 * another PC, a release or take stopped halfway, this PC's record behind its remote, changes made without
 * the lock, a mirror behind. Without `apply` it only reads (the Gateway may run); with it, it settles what
 * is safe to settle and names what is not.
 */
export async function recoverSync({ controllerRoot, apply = false, now = () => new Date() }) {
  const ctx = await context(controllerRoot, { needGatewayStopped: apply });
  const targets = [{ dir: ctx.root, remotes: ctx.config.world.remotes, label: WORLD_PROJECT_ID, world: true }];
  for (const projectId of Object.keys(ctx.config.projects).sort()) {
    const policy = await projectPolicyOf(ctx.root, projectId);
    let remotes;
    try { remotes = projectRemotes(ctx.config, projectId, policy); } catch (error) {
      if (!(error instanceof ProjectPackageError)) throw error;
      continue;
    }
    targets.push({ dir: path.join(ctx.config.packagesRoot, projectId), remotes, label: projectId, world: false });
  }
  const findings = [];
  for (const target of targets) {
    try {
      findings.push(...await recoverTarget(ctx, target, { apply, now }));
    } catch (error) {
      if (!(error instanceof ProjectPackageError)) throw error;
      findings.push({ target: target.label, kind: "failed", detail: error.message, action: null, error: error.code });
    }
  }
  return { applied: apply, machineId: ctx.machine.machineId, findings,
    needsPerson: findings.some((finding) => finding.action === null || finding.error !== undefined) };
}

/**
 * The Gateway runs only on the PC that holds the world (§14.3). A `local`
 * instance always may, and so may one whose sync is configured but not begun
 * (no state yet, not a repo: `sync init` is still to come). A fresh clone of the
 * world is a repo: it takes the world first.
 */
export async function assertWorldHeld(controllerRoot) {
  const root = await realpath(controllerRoot);
  // A local instance has no other PC (its mode was set while the world was here).
  if (await recordedMode(root) === "local" || await readSyncConfig(root) === null) return;
  if (!await syncBegun(root)) return;
  if ((await readSyncState(root)).world.held !== true) fail("sync_world_not_held", "take the world first (agents-factory sync take)");
}

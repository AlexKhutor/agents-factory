import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { NodeConversationArchiveBridge } from "./conversation-archive-store-node.mjs";
import {
  deskSourceIdOf, exportProject, gatewayRunning, instancePaths, PROJECT_PACKAGE_SCHEMA, ProjectPackageError,
} from "./project-package-export.mjs";
import { NodeProjectMemoryBridge } from "./project-memory-store-node.mjs";
import { SplitProjectMemoryBridge } from "./project-memory-split.mjs";
import {
  projectFolderName, projectsRoot, projectStoreFolder, resolveStoreLayout, singleMemoryDatabase,
  STORE_LAYOUT_MARKER, WORLD_PROJECT_ID, writeStoreLayoutMarker,
} from "./project-store-layout.mjs";
import { resolveProviderMutationProjectId } from "./provider-mutation-lease-store.mjs";
import { loadNodeSqlite } from "./sqlite-backend.mjs";
import { openReadOnlyDatabase } from "./sqlite-node-connection.mjs";
import { readThisMachine } from "./machine-identity.mjs";
import { recordWorldProjects } from "./world-registry.mjs";

// Import of a project package into a split instance, and the migration of a
// single-DB instance to the split layout (docs/project-package.md §6.5-§6.6).
// An import checks everything before it writes anything; a migration exports
// every project and the world, imports them, exports them again from the new
// layout and keeps the result only when that export equals the first.

export const PROJECT_PACKAGE_IMPORT_VERSION = "v0.1.0";
const MANIFEST = "project.af.json";
const DESK = ".desk";
const MEMORY_SCHEMA = 2;
const ARCHIVE_SCHEMAS = new Set([null, 1, 2]);
const MEMORY_CHUNK_BYTES = 384 * 1024;
const ARCHIVE_CHUNK_BYTES = 1536 * 1024;

function fail(code, detail) { throw new ProjectPackageError(code, detail); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

async function readJson(target, fallback = null) {
  if (!await exists(target)) return fallback;
  try { return JSON.parse(await readFile(target, "utf8")); } catch { return fail("package_invalid", path.basename(target)); }
}

async function filesUnder(folder) {
  const found = [];
  const walk = async (current, relative) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail("package_link_refused", rel);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  if (await exists(folder)) await walk(folder, "");
  return found.sort(compare);
}

const lines = (text) => text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

/** Splits rows into payloads under the bridge's request limit. */
function chunks(rows, limit) {
  const result = [];
  let current = [];
  let size = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (bytes > limit) fail("package_record_too_large");
    if (current.length > 0 && size + bytes > limit) { result.push(current); current = []; size = 0; }
    current.push(row);
    size += bytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** Where a package file goes in the instance; null for the files the stores take (and the map part). */
export function packagePlacement(relative, paths) {
  const parts = relative.split("/");
  const rest = (from) => parts.slice(from);
  const join = (base, list) => {
    if (list.length === 0 || list.some((part) => part === "" || part === "." || part === "..")) fail("package_path_invalid", relative);
    return path.join(base, ...list);
  };
  switch (parts[0]) {
    case "memory":
    case "archive":
    case "layout.json":
      return null;
    case "sessions":
      if (parts[1] === "claude") return join(paths.claudeSessions, rest(2));
      if (parts[1] === "acp") return join(paths.acpSessions, rest(2));
      if (parts[1] === "claude-sdk") return join(path.join(paths.claudeConfigDir, "projects"), rest(2));
      if (parts[1] === "dsh") return join(path.join(paths.dshHome, "sessions"), rest(2));
      if (parts[1] === "dsh-projcache") return join(path.join(paths.dshHome, "storages", "session_projcache", "sessions"), rest(2));
      break;
    case "desk":
      if (parts[1] === "agents" && parts.length > 3) return join(path.join(paths.deskAgents, deskSourceIdOf(parts[2])), rest(3));
      if (parts[1] === "tasks" && parts[2] === "dispatched") return join(paths.dispatched, rest(3));
      if (parts[1] === "tasks" && parts[2] === "definitions") return join(paths.definitions, rest(3));
      if (parts[1] === "tasks" && parts[2] === "returns") return join(paths.returns, rest(3));
      if (parts[1] === "reports") return join(paths.reports, rest(2));
      if (parts[1] === "acceptances") return join(paths.acceptances, rest(2));
      break;
    default:
      break;
  }
  return fail("package_path_unknown", relative);
}

/** Reads and checks a package: manifest, every file against its hash, nothing extra. */
export async function readProjectPackage(packageDir) {
  const manifest = await readJson(path.join(packageDir, MANIFEST));
  if (manifest === null || manifest.schema !== PROJECT_PACKAGE_SCHEMA) fail("package_invalid", MANIFEST);
  if (typeof manifest.projectId !== "string") fail("package_invalid", "projectId");
  if (manifest.storeSchemas?.memory !== MEMORY_SCHEMA) fail("package_schema_newer", `memory ${manifest.storeSchemas?.memory}`);
  if (!ARCHIVE_SCHEMAS.has(manifest.storeSchemas?.archive ?? null)) fail("package_schema_newer", "archive");
  const listed = Object.keys(manifest.files ?? {}).sort(compare);
  const present = (await filesUnder(path.join(packageDir, DESK))).map((name) => `${DESK}/${name}`);
  if (listed.length !== present.length || listed.some((name, index) => name !== present[index])) {
    fail("package_files_mismatch");
  }
  const bytes = new Map();
  for (const name of listed) {
    const content = await readFile(path.join(packageDir, ...name.split("/")));
    const expected = manifest.files[name];
    if (content.length !== expected.bytes || sha256(content) !== expected.sha256) fail("package_hash_mismatch", name);
    bytes.set(name.slice(DESK.length + 1), content);
  }
  return { manifest, files: bytes };
}

async function storeIsEmpty(folder) {
  const sqlite = await loadNodeSqlite();
  const database = path.join(folder, "memory.sqlite");
  if (!await exists(database)) return true;
  const db = openReadOnlyDatabase(sqlite, database);
  try {
    return ["memory_scopes", "memory_documents", "memory_operations", "memory_write_grants"]
      .every((table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === 0);
  } finally {
    db.close();
  }
}

/**
 * Imports a package into a split instance: the project's stores, its
 * session journals, transcripts, desk folders and task files, and its
 * folder binding as recorded (a folder that is not on this PC shows as
 * missing and is rebound by the person, R36). Refuses before writing when
 * anything does not fit; removes what it wrote when a later step fails.
 */
export async function importProject({ controllerRoot, packageDir, claudeConfigDir, dshHome }) {
  const root = await realpath(controllerRoot);
  if ((await resolveStoreLayout(root, { env: {} })).layout !== "split") fail("store_layout_single", "migrate the instance first");
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) fail("memory_sqlite_required");
  if (await gatewayRunning(path.join(root, ".project-local", "application-gateway", "status.v1.json"))) fail("gateway_running");
  const { manifest, files } = await readProjectPackage(path.resolve(packageDir));
  const projectId = manifest.projectId;
  const instance = await readJson(path.join(root, "instance.json"), {});
  if (typeof manifest.worldId === "string" && typeof instance?.instanceId === "string"
      && manifest.worldId !== instance.instanceId) fail("package_world_mismatch", manifest.worldId);
  const controllerId = await resolveProviderMutationProjectId(root);

  const text = (name) => (files.has(name) ? files.get(name).toString("utf8") : "");
  const memory = {
    scopes: lines(text("memory/scopes.jsonl")), revisions: lines(text("memory/revisions.jsonl")),
    grants: lines(text("memory/grants.jsonl")), operations: lines(text("memory/operations.jsonl")),
    documents: lines(text("memory/documents.jsonl")),
  };
  if (memory.scopes.some((scope) => scope.projectId !== projectId)) fail("package_invalid", "scope of another project");
  const conversations = lines(text("archive/conversations.jsonl"));
  if (conversations.some((conversation) => conversation.binding?.projectId !== controllerId)) {
    fail("package_world_mismatch", "controller");
  }
  const entries = conversations.flatMap((conversation) => lines(
    text(`archive/entries/${conversation.conversationId.replace(/^conversation:/u, "")}.jsonl`))
    .map((entry) => ({ ...entry, conversationId: conversation.conversationId })));
  const checkpoints = conversations.filter((conversation) => conversation.importCheckpoint !== null)
    .map((conversation) => ({ conversationId: conversation.conversationId, ...conversation.importCheckpoint }));
  const hint = manifest.workspace?.boundPathHint;
  if (typeof hint === "string" && typeof manifest.workspace?.workspaceKey === "string") {
    memory.documents.push({ key: `workspace-${sha256(projectId)}`, revision: 1,
      value: { projectId, workspacePath: hint, workspaceKey: manifest.workspace.workspaceKey } });
    memory.documents.sort((a, b) => compare(a.key, b.key));
  }

  const existing = await projectStoreFolder(root, projectId);
  if (existing !== null && !(projectId === WORLD_PROJECT_ID && await storeIsEmpty(existing))) {
    fail("project_already_mounted", projectId);
  }
  const paths = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  const writes = [];
  let identical = 0;
  for (const [name, content] of files) {
    const target = packagePlacement(name, paths);
    if (target === null) continue;
    if (await exists(target)) {
      if (!(await readFile(target)).equals(content)) fail("import_file_conflict", target);
      identical += 1;
    } else {
      writes.push({ target, content });
    }
  }

  const folder = await projectStoreFolder(root, projectId, { create: true });
  const written = [];
  try {
    const store = new NodeProjectMemoryBridge({ databasePath: path.join(folder, "memory.sqlite"), sqlite });
    await store.invoke("init", {});
    for (const table of ["scopes", "revisions", "grants", "operations", "documents"]) {
      for (const rows of chunks(memory[table], MEMORY_CHUNK_BYTES)) await store.invoke("import-rows", { table, rows });
    }
    if (conversations.length > 0) {
      const archive = new NodeConversationArchiveBridge({ databasePath: path.join(folder, "archive.sqlite"), sqlite });
      await archive.invoke("init", { projectId: controllerId });
      const tables = {
        conversations: conversations.map(({ conversationId, binding }) => ({ conversationId, binding })),
        entries, checkpoints,
      };
      for (const [table, rows] of Object.entries(tables)) {
        for (const chunk of chunks(rows, ARCHIVE_CHUNK_BYTES)) {
          await archive.invoke("import-rows", { projectId: controllerId, table, rows: chunk });
        }
      }
    }
    // The project's part of the Atlas map goes beside its stores (docs/project-package.md §9).
    if (files.has("layout.json")) await writeFile(path.join(folder, "layout.json"), files.get("layout.json"));
    for (const { target, content } of writes) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
      written.push(target);
    }
  } catch (error) {
    for (const target of written) await rm(target, { force: true });
    await rm(folder, { recursive: true, force: true });
    throw error instanceof ProjectPackageError ? error
      : new ProjectPackageError("import_failed", String(error?.code ?? error?.message ?? error).slice(0, 200));
  }
  return {
    projectId, folder, scopes: memory.scopes.length, documents: memory.documents.length,
    conversations: conversations.length, entries: entries.length,
    files: { written: written.length, identical },
    workspace: typeof hint === "string" ? (await exists(hint) ? "bound" : "missing") : "none",
  };
}

async function deskTree(folder) {
  const tree = new Map();
  for (const name of await filesUnder(path.join(folder, DESK))) {
    tree.set(name, sha256(await readFile(path.join(folder, DESK, ...name.split("/")))));
  }
  return tree;
}

/** The projects a single database names: scopes, agents, archive flags; the world always. */
async function singleProjects(root) {
  const sqlite = await loadNodeSqlite();
  const db = openReadOnlyDatabase(sqlite, singleMemoryDatabase(root));
  try {
    const ids = new Set([WORLD_PROJECT_ID, ...db.prepare("SELECT DISTINCT project_id FROM memory_scopes").all()
      .map((row) => row.project_id)]);
    const document = (key) => {
      const row = db.prepare("SELECT value_json FROM memory_documents WHERE key=?").get(key);
      return row ? JSON.parse(row.value_json) : null;
    };
    for (const agent of document("memory-agents-v1")?.agents ?? []) if (typeof agent?.projectId === "string") ids.add(agent.projectId);
    const flags = document("memory-project-archive-v1");
    for (const key of Object.keys(flags?.projects ?? {})) ids.add(key);
    for (const key of Object.keys(flags?.quarters ?? {})) ids.add(key.split("/")[0]);
    const totals = {};
    for (const [name, table] of [["scopes", "memory_scopes"], ["revisions", "memory_revisions"],
      ["operations", "memory_operations"], ["grants", "memory_write_grants"]]) {
      totals[name] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    }
    totals.agents = (document("memory-agents-v1")?.agents ?? []).length;
    return { ids: [...ids].sort(compare), totals };
  } finally {
    db.close();
  }
}

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Every document of the single database reads the same through the split layout. */
async function verifyDocuments(root) {
  const sqlite = await loadNodeSqlite();
  const db = openReadOnlyDatabase(sqlite, singleMemoryDatabase(root));
  let rows;
  try { rows = db.prepare("SELECT key, value_json FROM memory_documents").all(); } finally { db.close(); }
  const split = new SplitProjectMemoryBridge({ controllerRoot: root, sqlite });
  try {
    await split.invoke("init", {});
    for (const row of rows) {
      const before = JSON.parse(row.value_json);
      const after = (await split.invoke("read-document", { key: row.key }))?.value ?? null;
      let same;
      if (row.key === "memory-agents-v1") {
        const byId = (value) => new Map((value?.agents ?? []).map((agent) => [agent.agentId, canonical(agent)]));
        const [a, b] = [byId(before), byId(after)];
        same = a.size === b.size && [...a].every(([id, text]) => b.get(id) === text);
      } else if (row.key === "memory-project-archive-v1") {
        same = canonical(before?.projects ?? {}) === canonical(after?.projects ?? {})
          && canonical(before?.quarters ?? {}) === canonical(after?.quarters ?? {});
      } else {
        same = canonical(before) === canonical(after);
      }
      if (!same) fail("store_layout_verify_failed", `document ${row.key}`);
    }
  } finally {
    await split.close();
  }
  return rows.length;
}

async function archiveTotals(root) {
  const database = path.join(root, ".project-local", "orchestration", "conversation-archive", "archive.v1.sqlite");
  if (!await exists(database)) return { conversations: 0, entries: 0 };
  const sqlite = await loadNodeSqlite();
  const db = openReadOnlyDatabase(sqlite, database);
  try {
    return {
      conversations: db.prepare("SELECT count(*) AS n FROM conversations").get().n,
      entries: db.prepare("SELECT count(*) AS n FROM entries").get().n,
    };
  } finally {
    db.close();
  }
}

/**
 * Moves a single-DB instance to the split layout (Gateway stopped). Every
 * project and the world are exported into .project-local/backups/split-<utc>/,
 * the totals are checked, the packages imported, the new layout exported again
 * and compared with the first export file by file. Anything short of equal
 * undoes the move (the marker and the projects folder go); the single
 * database is never changed and stays where it is.
 */
export async function migrateToSplitLayout({ controllerRoot, now = () => new Date(), claudeConfigDir, dshHome }) {
  const root = await realpath(controllerRoot);
  if ((await resolveStoreLayout(root, { env: {} })).layout === "split") fail("store_layout_already_split");
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) fail("memory_sqlite_required");
  const projectsFolder = projectsRoot(root);
  if (await exists(projectsFolder) && (await readdir(projectsFolder)).length > 0) fail("store_layout_projects_present", projectsFolder);
  if (!await exists(singleMemoryDatabase(root))) {
    await writeStoreLayoutMarker(root, { now });
    return { migrated: false, layout: "split", projects: [] };
  }

  // The world's signature (R35), made once.
  const instanceFile = path.join(root, "instance.json");
  const instance = await readJson(instanceFile, {});
  if (typeof instance?.instanceId !== "string") {
    const temporary = `${instanceFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...instance, instanceId: randomUUID() }, null, 2)}\n`, "utf8");
    await rename(temporary, instanceFile);
  }

  const stamp = now().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  const work = path.join(root, ".project-local", "backups", `split-${stamp}`);
  if (await exists(work)) fail("store_layout_backup_exists", work);
  const stores = path.join(work, "stores");
  await mkdir(stores, { recursive: true });
  for (const source of [singleMemoryDatabase(root),
    path.join(root, ".project-local", "orchestration", "conversation-archive", "archive.v1.sqlite")]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (await exists(`${source}${suffix}`)) await copyFile(`${source}${suffix}`, path.join(stores, `${path.basename(source)}${suffix}`));
    }
  }

  const { ids, totals } = await singleProjects(root);
  const archived = await archiveTotals(root);
  const exported = [];
  for (const projectId of ids) {
    const out = path.join(work, "packages", projectFolderName(projectId));
    const result = await exportProject({ controllerRoot: root, projectId, out, now, claudeConfigDir, dshHome })
      .catch((error) => {
        // A project that only an agent or a flag names, with no scopes, cannot stand alone.
        if (error?.code === "project_not_found") return null;
        throw error;
      });
    if (result !== null) exported.push({ projectId, out, counts: result.counts });
  }
  const sum = (name) => exported.reduce((total, item) => total + (item.counts[name] ?? 0), 0);
  const expected = { ...totals, ...archived };
  const found = {
    scopes: sum("scopes"), revisions: sum("revisions"), operations: sum("operations"), grants: sum("grants"),
    agents: sum("agents"), conversations: sum("conversations"), entries: sum("entries"),
  };
  for (const name of Object.keys(found)) {
    if (found[name] !== expected[name]) fail("store_layout_export_incomplete", `${name}: ${found[name]} of ${expected[name]}`);
  }

  await writeStoreLayoutMarker(root, { now });
  try {
    const ordered = [...exported].sort((a, b) => (a.projectId === WORLD_PROJECT_ID ? -1 : b.projectId === WORLD_PROJECT_ID ? 1
      : compare(a.projectId, b.projectId)));
    for (const item of ordered) await importProject({ controllerRoot: root, packageDir: item.out, claudeConfigDir, dshHome });
    for (const item of ordered) {
      const again = path.join(work, "verify", projectFolderName(item.projectId));
      await exportProject({ controllerRoot: root, projectId: item.projectId, out: again, now, claudeConfigDir, dshHome });
      const [before, after] = [await deskTree(item.out), await deskTree(again)];
      const same = before.size === after.size && [...before].every(([name, hash]) => after.get(name) === hash);
      if (!same) fail("store_layout_verify_failed", item.projectId);
    }
    found.documents = await verifyDocuments(root);
    // The world's record of its projects, by identity (world-registry.mjs).
    const entries = [];
    const machine = await readThisMachine(root);
    for (const item of exported.filter((entry) => entry.projectId !== WORLD_PROJECT_ID)) {
      const manifest = await readJson(path.join(item.out, MANIFEST));
      entries.push({ projectId: item.projectId, title: manifest.title, policy: manifest.policy,
        location: machine === null ? null : { machineId: machine.machineId, atUtc: now().toISOString() } });
    }
    if (entries.length > 0) await recordWorldProjects(root, entries);
  } catch (error) {
    await rm(path.join(projectsFolder, STORE_LAYOUT_MARKER), { force: true });
    for (const name of await readdir(projectsFolder).catch(() => [])) {
      await rm(path.join(projectsFolder, name), { recursive: true, force: true });
    }
    throw error;
  }
  return {
    migrated: true, layout: "split", work, singleDatabaseKept: singleMemoryDatabase(root),
    projects: exported.map((item) => ({ projectId: item.projectId, counts: item.counts })),
    totals: found,
  };
}

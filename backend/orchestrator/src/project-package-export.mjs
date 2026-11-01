import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { journalKeyOf } from "./action-journal.mjs";
import { namesKeyOf } from "./object-names.mjs";
import { tasksKeyOf } from "./agent-tasks.mjs";
import { changesKeyOf } from "./memory-changes.mjs";
import { loadNodeSqlite } from "./sqlite-backend.mjs";
import { openReadOnlyDatabase } from "./sqlite-node-connection.mjs";
import { projectStoreFolder, resolveStoreLayout, WORLD_PROJECT_ID } from "./project-store-layout.mjs";
import { readWorldRegistry } from "./world-registry.mjs";

// Text export of one project (docs/project-package.md §6): everything the
// installation keeps about the project - memory, agents, conversations, agent
// sessions, desk tasks - as deterministic files, so that an export of
// unchanged data is byte-identical and a package can be imported elsewhere.
// This version reads the single-DB layout of backend v0.148.0, read-only.

export const PROJECT_PACKAGE_EXPORT_VERSION = "v0.1.0";
export const PROJECT_PACKAGE_SCHEMA = "agents-factory.project-package/1";
const MANIFEST = "project.af.json";
const DESK = ".desk";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MEMORY_SCHEMA = 2;
const ARCHIVE_SCHEMAS = new Set([1, 2]);
const MEMORY_TABLES = ["memory_documents", "memory_operations", "memory_revisions", "memory_scopes", "memory_write_grants"];
const CATALOG_KEY = "memory-agents-v1";
const ARCHIVE_KEY = "memory-project-archive-v1";
const APPROVALS_KEY = "memory-document-approvals-v1";

export class ProjectPackageError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProjectPackageError";
    this.code = code;
  }
}
function fail(code, detail) { throw new ProjectPackageError(code, detail); }

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Two names the owning modules derive; repeated here so that the CLI bundle
// does not pull the desk-task and contract modules in. The test holds them to
// the originals (desk-agent-sources.mjs deskAgentSourceId,
// application-agent-artifacts.mjs `agent-artifacts-${applicationCanonicalSha256(agentId)}`).
export function deskSourceIdOf(agentId) {
  return /^[a-z0-9][a-z0-9-]{0,47}$/u.test(agentId) ? `desk-${agentId}` : `desk-${sha256(agentId).slice(0, 16)}`;
}
export function artifactsKeyOf(agentId) {
  return `agent-artifacts-${sha256(JSON.stringify(agentId))}`;
}

/** Canonical JSON: keys sorted, no insignificant whitespace, undefined fields left out. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") fail("export_value_invalid");
    if (typeof value === "number" && !Number.isFinite(value)) fail("export_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort(compare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function jsonLines(records) {
  return records.length === 0 ? "" : `${records.map(canonicalJson).join("\n")}\n`;
}

function parsed(text, what) {
  try { return JSON.parse(text); } catch { return fail("export_source_invalid", what); }
}

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

async function readJsonFile(target, fallback = null) {
  if (!await exists(target)) return fallback;
  return parsed(await readFile(target, "utf8"), path.basename(target));
}

/**
 * Where an instance keeps a project's stores (single or split layout,
 * project-store-layout.mjs), its session journals and task files, and where
 * the provider homes are. Paths only: nothing is created here.
 */
export async function instancePaths(root, projectId, options = {}) {
  const local = path.join(root, ".project-local");
  const claudeProvider = await readJsonFile(path.join(local, "application-gateway", "claude-provider.json"));
  const acpProvider = await readJsonFile(path.join(local, "application-gateway", "acp-provider.json"));
  const { layout } = await resolveStoreLayout(root, { env: {} });
  let stores = {
    memoryDb: path.join(local, "orchestration", "project-memory", "project-memory.v1.sqlite"),
    archiveDb: path.join(local, "orchestration", "conversation-archive", "archive.v1.sqlite"),
  };
  if (layout === "split") {
    const folder = await projectStoreFolder(root, projectId);
    stores = folder === null ? { memoryDb: null, archiveDb: null }
      : { memoryDb: path.join(folder, "memory.sqlite"), archiveDb: path.join(folder, "archive.sqlite") };
  }
  return {
    layout,
    ...stores,
    claudeSessions: path.join(local, "orchestration", "claude-sessions"),
    acpSessions: path.join(local, "orchestration", "acp-sessions"),
    claudeConfigDir: options.claudeConfigDir
      ?? (typeof claudeProvider?.claudeConfigDir === "string" ? claudeProvider.claudeConfigDir : path.join(local, "claude-account")),
    dshHome: options.dshHome ?? (typeof acpProvider?.home === "string" ? acpProvider.home : path.join(local, "dsh-home")),
    deskAgents: path.join(local, "desk-agents"),
    dispatched: path.join(root, "coordination", "tasks", "dispatched"),
    definitions: path.join(local, "desk-coordinator", "definitions"),
    returns: path.join(local, "orchestration", "desk-task-returns"),
    reports: path.join(root, "knowledge", "reports", "inbox"),
    acceptances: path.join(root, "coordination", "acceptances"),
    gatewayStatus: path.join(local, "application-gateway", "status.v1.json"),
    instance: path.join(root, "instance.json"),
  };
}

async function openReadOnly(file) {
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) fail("memory_sqlite_required");
  return openReadOnlyDatabase(sqlite, file);
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((row) => row.name));
}

/** Every row of the memory DB, checked against schema version 2. */
function readMemory(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const tables = tableNames(db);
  if (version !== MEMORY_SCHEMA || MEMORY_TABLES.some((name) => !tables.has(name))) {
    fail("memory_schema_unsupported", `user_version ${version}`);
  }
  return {
    scopes: db.prepare("SELECT * FROM memory_scopes").all(),
    revisions: db.prepare("SELECT * FROM memory_revisions").all(),
    operations: db.prepare("SELECT * FROM memory_operations").all(),
    grants: db.prepare("SELECT * FROM memory_write_grants").all(),
    documents: db.prepare("SELECT * FROM memory_documents").all(),
  };
}

function readArchive(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const tables = tableNames(db);
  if (!ARCHIVE_SCHEMAS.has(version) || !tables.has("conversations") || !tables.has("entries")) {
    fail("archive_schema_unsupported", `user_version ${version}`);
  }
  return {
    version,
    conversations: db.prepare("SELECT * FROM conversations").all(),
    entries: db.prepare("SELECT * FROM entries").all(),
    checkpoints: tables.has("import_checkpoints") ? db.prepare("SELECT * FROM import_checkpoints").all() : [],
  };
}

/**
 * Which records belong to the project (§3.2-§3.3). The world (`world`) also
 * takes what belongs to no project - documents of no known owner, operations
 * of no scope, conversations of no agent - so that exporting every project
 * and the world leaves nothing behind; for any other project those are only
 * reported.
 */
export function selectProjectRecords({ memory, archive, projectId }) {
  const world = projectId === WORLD_PROJECT_ID;
  const scopes = memory.scopes.filter((row) => row.project_id === projectId)
    .map((row) => ({ scopeId: row.scope_id, kind: row.kind, projectId: row.project_id, quarterId: row.quarter_id,
      title: row.title, currentRevision: row.current_revision }))
    .sort((a, b) => compare(a.scopeId, b.scopeId));
  let projectScope = scopes.find((scope) => scope.kind === "project") ?? null;
  if (projectScope === null && world) projectScope = { title: "World" };
  if (projectScope === null) fail("project_not_found", projectId);
  const scopeIds = new Set(scopes.map((scope) => scope.scopeId));
  const scopeProjects = new Map(memory.scopes.map((row) => [row.scope_id, row.project_id]));

  const revisions = memory.revisions.filter((row) => scopeIds.has(row.scope_id))
    .map((row) => ({ scopeId: row.scope_id, revision: row.revision, contentSha256: row.content_sha256,
      entries: parsed(row.entries_json, "entries_json"), author: row.author, updatedAtUtc: row.updated_at_utc }))
    .sort((a, b) => compare(a.scopeId, b.scopeId) || a.revision - b.revision);

  const operationProject = (result) => {
    if (typeof result?.targetProjectId === "string") return result.targetProjectId;
    if (typeof result?.scopeId === "string") return scopeProjects.get(result.scopeId) ?? null;
    return null;
  };
  const operations = [];
  let unassignedOperations = 0;
  for (const row of memory.operations) {
    const result = parsed(row.result_json, "result_json");
    const owner = operationProject(result);
    if (owner === null) unassignedOperations += 1;
    if (owner !== projectId && !(world && owner === null)) continue;
    operations.push({ operationId: row.operation_id, operationKind: row.operation_kind,
      requestSha256: row.request_sha256, result });
  }
  operations.sort((a, b) => compare(a.operationId, b.operationId));

  const grants = memory.grants.filter((row) => scopeIds.has(row.scope_id))
    .map((row) => ({ commandId: row.command_id, scopeId: row.scope_id, expectedRevision: row.expected_revision,
      contentSha256: row.content_sha256, requestedBy: row.requested_by, authorizedAtUtc: row.authorized_at_utc,
      requestSha256: row.request_sha256, result: parsed(row.result_json, "grant result_json"),
      consumedOperationId: row.consumed_operation_id, consumedAtUtc: row.consumed_at_utc }))
    .sort((a, b) => compare(a.commandId, b.commandId));

  const documents = new Map(memory.documents.map((row) => [row.key,
    { key: row.key, revision: row.revision, value: parsed(row.value_json, row.key) }]));
  const catalog = documents.get(CATALOG_KEY);
  const allAgents = Array.isArray(catalog?.value?.agents) ? catalog.value.agents : [];
  const agents = allAgents.filter((agent) => agent?.projectId === projectId);
  // Who owns each keyed document: an agent's approvals and artifacts follow the
  // agent; a folder binding is its project's (exported as the manifest's hint).
  const owners = new Map();
  for (const agent of allAgents) {
    if (typeof agent?.agentId !== "string") continue;
    owners.set(`${APPROVALS_KEY}:${sha256(agent.agentId).slice(0, 32)}`, agent.projectId);
    owners.set(artifactsKeyOf(agent.agentId), agent.projectId);
  }
  const knownProjects = new Set([...memory.scopes.map((row) => row.project_id),
    ...allAgents.map((agent) => agent?.projectId).filter((id) => typeof id === "string")]);
  const bindings = new Map([...knownProjects].map((id) => [`workspace-${sha256(id)}`, id]));
  // A project's action journal, its names and its agents' tasks go with it (action-journal.mjs,
  // object-names.mjs, agent-tasks.mjs).
  for (const id of knownProjects) {
    try {
      owners.set(journalKeyOf(id), id); owners.set(namesKeyOf(id), id); owners.set(tasksKeyOf(id), id);
      owners.set(changesKeyOf(id), id);
    }
    catch { /* an ID no journal can have */ }
  }
  const exported = [];
  if (catalog) exported.push({ ...catalog, value: { ...catalog.value, agents } });
  const archived = documents.get(ARCHIVE_KEY);
  if (archived) {
    const projects = Object.fromEntries(Object.entries(archived.value?.projects ?? {})
      .filter(([key]) => key === projectId));
    const quarters = Object.fromEntries(Object.entries(archived.value?.quarters ?? {})
      .filter(([key]) => key.startsWith(`${projectId}/`)));
    if (Object.keys(projects).length + Object.keys(quarters).length > 0) {
      exported.push({ ...archived, value: { ...archived.value, projects, quarters } });
    }
  }
  const unassignedDocuments = [];
  for (const [key, document] of documents) {
    if (key === CATALOG_KEY || key === ARCHIVE_KEY || bindings.has(key)) continue;
    const owner = owners.get(key) ?? null;
    if (owner === projectId) exported.push(document);
    else if (owner === null) {
      unassignedDocuments.push(key);
      if (world) exported.push(document);
    }
  }
  exported.sort((a, b) => compare(a.key, b.key));
  unassignedDocuments.sort(compare);
  const binding = documents.get(`workspace-${sha256(projectId)}`)?.value ?? null;

  const threads = new Map(allAgents.filter((agent) => agent?.binding?.threadId)
    .map((agent) => [agent.binding.threadId, agent]));
  const conversations = [];
  const entriesByConversation = new Map();
  if (archive) {
    const checkpoints = new Map(archive.checkpoints.map((row) => [row.conversation_id, row]));
    for (const row of archive.conversations) {
      const bindingValue = parsed(row.binding, "conversation binding");
      const agent = threads.get(bindingValue?.threadId);
      const owner = agent && agent.binding.providerId === bindingValue.providerId ? agent.projectId : null;
      if (owner !== projectId && !(world && owner === null)) continue;
      const checkpoint = checkpoints.get(row.id);
      conversations.push({ conversationId: row.id, binding: bindingValue,
        importCheckpoint: checkpoint ? { revision: checkpoint.revision, cursor: checkpoint.cursor,
          exhausted: checkpoint.exhausted } : null });
      entriesByConversation.set(row.id, []);
    }
    for (const row of archive.entries) {
      const list = entriesByConversation.get(row.conversation_id);
      if (!list) continue;
      list.push({ sequence: row.sequence, recordId: row.record_id, contentSha256: row.content_sha256,
        observedAtUtc: row.observed_at_utc, record: parsed(row.record, "archive record") });
    }
    conversations.sort((a, b) => compare(a.conversationId, b.conversationId));
    for (const list of entriesByConversation.values()) list.sort((a, b) => a.sequence - b.sequence);
  }
  return { projectScope, scopes, revisions, operations, grants, documents: exported, agents, binding,
    conversations, entriesByConversation, unassignedDocuments, unassignedOperations };
}

/** Files of a folder, recursively, sorted; links are refused (nothing outside is followed). */
async function filesOf(folder, skipTop = new Set()) {
  const found = [];
  const walk = async (current, relative) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      if (relative === "" && skipTop.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail("export_link_refused", rel);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) found.push({ full, rel });
    }
  };
  if (await exists(folder)) await walk(folder, "");
  return found;
}

async function subfolders(folder) {
  if (!await exists(folder)) return [];
  return (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    .map((entry) => entry.name).sort(compare);
}

/** Files of the project's sessions, desk folders and tasks: [target path in .desk, source file]. */
async function projectFiles({ layout, agents }) {
  const files = [];
  const add = (target, full) => files.push({ target, full });
  const folder = async (source, target, skipTop) => {
    for (const file of await filesOf(source, skipTop)) add(`${target}/${file.rel}`, file.full);
  };
  const claudeProjects = path.join(layout.claudeConfigDir, "projects");
  const claudeSlugs = await subfolders(claudeProjects);
  const dshSessions = path.join(layout.dshHome, "sessions");
  const dshSlugs = await subfolders(dshSessions);
  for (const agent of [...agents].sort((a, b) => compare(a.agentId, b.agentId))) {
    const threadId = agent.binding?.threadId;
    if (typeof threadId === "string" && ID.test(threadId)) {
      await folder(path.join(layout.claudeSessions, threadId), `sessions/claude/${threadId}`);
      await folder(path.join(layout.acpSessions, threadId), `sessions/acp/${threadId}`);
      for (const slug of claudeSlugs) {
        const transcript = path.join(claudeProjects, slug, `${threadId}.jsonl`);
        if (await exists(transcript)) add(`sessions/claude-sdk/${slug}/${threadId}.jsonl`, transcript);
        await folder(path.join(claudeProjects, slug, threadId), `sessions/claude-sdk/${slug}/${threadId}`);
      }
      for (const slug of dshSlugs) {
        await folder(path.join(dshSessions, slug, threadId), `sessions/dsh/${slug}/${threadId}`);
      }
      const projcache = path.join(layout.dshHome, "storages", "session_projcache", "sessions", `${threadId}.json`);
      if (await exists(projcache)) add(`sessions/dsh-projcache/${threadId}.json`, projcache);
    }
    const sourceId = deskSourceIdOf(agent.agentId);
    await folder(path.join(layout.deskAgents, sourceId), `desk/agents/${agent.agentId}`, new Set(["logs"]));
    await folder(path.join(layout.reports, sourceId), `desk/reports/${sourceId}`);
    await folder(path.join(layout.acceptances, sourceId), `desk/acceptances/${sourceId}`);
  }
  // Task materials follow the target agent's project (R34).
  const sources = new Set(agents.map((agent) => deskSourceIdOf(agent.agentId)));
  const agentIds = new Set(agents.map((agent) => agent.agentId));
  const taskIds = new Set();
  for (const taskId of await subfolders(layout.dispatched)) {
    const task = await readJsonFile(path.join(layout.dispatched, taskId, "task.json"));
    if (task && sources.has(task.targetId)) taskIds.add(taskId);
  }
  if (await exists(layout.returns)) {
    for (const name of (await readdir(layout.returns)).filter((n) => n.endsWith(".json")).sort(compare)) {
      const record = await readJsonFile(path.join(layout.returns, name));
      if (record && (agentIds.has(record.agentId) || sources.has(record.sourceId))) taskIds.add(name.slice(0, -5));
    }
  }
  for (const taskId of [...taskIds].sort(compare)) {
    await folder(path.join(layout.dispatched, taskId), `desk/tasks/dispatched/${taskId}`);
    for (const [source, target] of [[layout.definitions, "definitions"], [layout.returns, "returns"]]) {
      const file = path.join(source, `${taskId}.json`);
      if (await exists(file)) add(`desk/tasks/${target}/${taskId}.json`, file);
    }
  }
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.target)) fail("export_file_twice", file.target);
    seen.add(file.target);
  }
  return files.sort((a, b) => compare(a.target, b.target));
}

/** A Gateway whose status names a live process. A status left by a Gateway that died says "ready" too. */
export async function gatewayRunning(statusFile) {
  const status = await readJsonFile(statusFile);
  if (status === null || status.terminal === true) return false;
  const pid = Number(status.identity?.process?.processId);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** The package folder may be new, empty, or a package of the same project. */
async function previousManifest(out, projectId) {
  if (!await exists(out)) return null;
  const manifest = await readJsonFile(path.join(out, MANIFEST));
  if (manifest !== null) {
    if (manifest.projectId !== projectId) fail("package_other_project", manifest.projectId);
    return manifest;
  }
  const present = (await readdir(out)).filter((name) => ![".git", "workspace"].includes(name));
  if (present.length > 0) fail("package_folder_not_empty", out);
  return null;
}

/**
 * Exports one project of a single-DB instance into a package folder: writes
 * `.desk/` and `project.af.json`, nothing else. Unchanged data gives the same
 * bytes, the manifest included (its revision moves only when a file changed).
 */
export async function exportProject({
  controllerRoot, projectId, out, now = () => new Date(), machineId = null, policy = null,
  claudeConfigDir, dshHome, allowRunningGateway = false,
}) {
  if (typeof projectId !== "string" || !ID.test(projectId)) fail("project_id_invalid");
  if (typeof out !== "string" || !path.isAbsolute(out)) fail("package_folder_invalid");
  const root = await realpath(controllerRoot);
  const layout = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  if (!allowRunningGateway && await gatewayRunning(layout.gatewayStatus)) fail("gateway_running");
  if (layout.memoryDb === null) fail("project_not_found", projectId);
  if (!await exists(layout.memoryDb)) fail("memory_store_missing");

  const memoryDb = await openReadOnly(layout.memoryDb);
  let memory;
  try { memory = readMemory(memoryDb); } finally { memoryDb.close(); }
  let archive = null;
  if (await exists(layout.archiveDb)) {
    const archiveDb = await openReadOnly(layout.archiveDb);
    try { archive = readArchive(archiveDb); } finally { archiveDb.close(); }
  }
  const selected = selectProjectRecords({ memory, archive, projectId });
  const busy = selected.agents.filter((agent) => agent.currentOperationId);
  if (busy.length > 0) fail("project_not_quiescent", busy.map((agent) => agent.agentId).join(","));

  const texts = new Map([
    ["memory/scopes.jsonl", jsonLines(selected.scopes)],
    ["memory/revisions.jsonl", jsonLines(selected.revisions)],
    ["memory/operations.jsonl", jsonLines(selected.operations)],
    ["memory/grants.jsonl", jsonLines(selected.grants)],
    ["memory/documents.jsonl", jsonLines(selected.documents)],
  ]);
  // Archive files only for conversations that exist: a project with none has no archive, in either layout.
  if (selected.conversations.length > 0) {
    texts.set("archive/conversations.jsonl", jsonLines(selected.conversations));
    for (const conversation of selected.conversations) {
      const name = conversation.conversationId.replace(/^conversation:/u, "");
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name)) fail("export_name_invalid", conversation.conversationId);
      texts.set(`archive/entries/${name}.jsonl`, jsonLines(selected.entriesByConversation.get(conversation.conversationId)));
    }
  }
  const copied = await projectFiles({ layout, agents: selected.agents });
  // The project's part of the Atlas map (split layout: beside its stores), docs/project-package.md §9.
  const mapPart = layout.layout === "split" ? path.join(path.dirname(layout.memoryDb), "layout.json") : null;
  if (mapPart !== null && await exists(mapPart)) copied.push({ target: "layout.json", full: mapPart });

  const previous = await previousManifest(out, projectId);
  // Where the project may be kept: as given, else as the world records it, else as its package said.
  const recorded = (await readWorldRegistry(root)).projects[projectId]?.policy ?? null;
  const staging = path.join(out, `${DESK}.export-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  const files = {};
  try {
    const put = async (relative, bytes) => {
      const target = path.join(staging, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      files[`${DESK}/${relative}`] = { bytes: bytes.length, sha256: sha256(bytes) };
    };
    for (const [relative, text] of texts) await put(relative, Buffer.from(text, "utf8"));
    for (const file of copied) await put(file.target, await readFile(file.full));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const sortedFiles = Object.fromEntries(Object.keys(files).sort(compare).map((key) => [key, files[key]]));
  const changed = previous === null || canonicalJson(previous.files ?? {}) !== canonicalJson(sortedFiles);
  const instance = await readJsonFile(layout.instance, {});
  const boundPath = typeof selected.binding?.workspacePath === "string" ? selected.binding.workspacePath : null;
  const ownWorkspace = path.join(out, "workspace");
  const manifest = {
    schema: PROJECT_PACKAGE_SCHEMA,
    projectId,
    title: selected.projectScope.title,
    worldId: typeof instance?.instanceId === "string" ? instance.instanceId : null,
    policy: policy ?? recorded ?? previous?.policy ?? { homeOnly: false, allowedMachines: null },
    workspace: {
      folder: "workspace",
      external: boundPath !== null && path.resolve(boundPath).toLowerCase() !== path.resolve(ownWorkspace).toLowerCase(),
      boundPathHint: boundPath,
      workspaceKey: selected.binding?.workspaceKey ?? null,
    },
    storeSchemas: { memory: MEMORY_SCHEMA, archive: selected.conversations.length > 0 ? 2 : null },
    export: changed
      ? { revision: (previous?.export?.revision ?? 0) + 1, exportedAtUtc: now().toISOString(), exportedBy: machineId,
        exporter: PROJECT_PACKAGE_EXPORT_VERSION, sourceLayout: layout.layout }
      : previous.export,
    lock: previous?.lock ?? null,
    counts: {
      scopes: selected.scopes.length, revisions: selected.revisions.length, operations: selected.operations.length,
      grants: selected.grants.length, documents: selected.documents.length, agents: selected.agents.length,
      conversations: selected.conversations.length,
      entries: [...selected.entriesByConversation.values()].reduce((sum, list) => sum + list.length, 0),
      copiedFiles: copied.length,
    },
    files: sortedFiles,
  };
  await rm(path.join(out, DESK), { recursive: true, force: true });
  await rename(staging, path.join(out, DESK));
  await writeFile(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    projectId, out, changed, revision: manifest.export.revision, counts: manifest.counts,
    unassignedDocuments: selected.unassignedDocuments, unassignedOperations: selected.unassignedOperations,
  };
}

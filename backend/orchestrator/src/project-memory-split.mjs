import { createHash } from "node:crypto";
import path from "node:path";

import { ACTION_JOURNAL_PREFIX, journalKeyOf } from "./action-journal.mjs";
import { NAMES_PREFIX, namesKeyOf } from "./object-names.mjs";
import { TASKS_PREFIX, tasksKeyOf } from "./agent-tasks.mjs";
import { CHANGES_PREFIX, changesKeyOf } from "./memory-changes.mjs";
import { NodeConversationArchiveBridge } from "./conversation-archive-store-node.mjs";
import { NodeProjectMemoryBridge } from "./project-memory-store-node.mjs";
import { artifactsKeyOf } from "./project-package-export.mjs";
import { readThisMachine } from "./machine-identity.mjs";
import { mountedProjects, projectStoreFolder, WORLD_PROJECT_ID } from "./project-store-layout.mjs";
import { readWorldRegistry, recordWorldProjects } from "./world-registry.mjs";
import { openReadOnlyDatabase } from "./sqlite-node-connection.mjs";

// The split store layout (docs/project-package.md §5): one memory database per
// mounted project and one for the world, behind the same bridge interface as
// the single database, so ProjectMemoryStore, the memory service, the Gateway
// and Atlas keep their contracts.
//
// Commands go to the database of the project they name: by projectId, by the
// project of a scope, by the key family of a document. The agent catalog and
// the archive flags are one document per project; a read merges them, and the
// merged document's revision is the sum of the parts' revisions, so it moves
// on every change in any part and a compare-and-swap sees a change made by any
// process. A change may touch one project only.

const CATALOG_KEY = "memory-agents-v1";
const ARCHIVE_KEY = "memory-project-archive-v1";
const APPROVALS_PREFIX = "memory-document-approvals-v1:";
const MERGED = new Set([CATALOG_KEY, ARCHIVE_KEY]);
const SCOPE_COMMANDS = new Set(["read-scope", "authorize-write", "write"]);
const MEMORY_FILE = "memory.sqlite";
const ARCHIVE_FILE = "archive.sqlite";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A failure in the shape the bridges give (ProjectMemoryStore and ConversationArchive read stderr). */
function failure(command, code) {
  const error = new Error(`Split store '${command}' failed: ${code}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}\n`;
  return error;
}

/** The listing order of list-scopes: project, its project scope first, quarter, scope id. */
function scopeOrder(a, b) {
  return compare(a.projectId, b.projectId)
    || (a.kind === "project" ? 0 : 1) - (b.kind === "project" ? 0 : 1)
    || compare(a.quarterId ?? "", b.quarterId ?? "")
    || compare(a.scopeId, b.scopeId);
}

export class SplitProjectMemoryBridge {
  #root;
  #sqlite;
  #bridges = new Map();
  #scopes = new Map();

  constructor({ controllerRoot, sqlite }) {
    if (!controllerRoot || typeof sqlite?.DatabaseSync !== "function") {
      throw new Error("SplitProjectMemoryBridge requires controllerRoot and node:sqlite");
    }
    this.#root = controllerRoot;
    this.#sqlite = sqlite;
    this.sqliteBackend = "node";
  }

  /**
   * The bridge of a project's database; a new project gets its folder and
   * database. Calls at the same time share one opening.
   */
  async #bridge(projectId, { create = false } = {}) {
    const bridge = await this.#opening(projectId, create);
    // A read that found no project may have been in flight when this call makes it.
    if (bridge === null && create) {
      this.#bridges.delete(projectId);
      return this.#opening(projectId, true);
    }
    return bridge;
  }

  #opening(projectId, create) {
    if (!this.#bridges.has(projectId)) {
      const opening = (async () => {
        const folder = await projectStoreFolder(this.#root, projectId, { create });
        if (folder === null) return null;
        const bridge = new NodeProjectMemoryBridge({ databasePath: path.join(folder, MEMORY_FILE), sqlite: this.#sqlite });
        await bridge.invoke("init", {});
        return bridge;
      })();
      this.#bridges.set(projectId, opening);
      opening.then((bridge) => { if (bridge === null) this.#bridges.delete(projectId); },
        () => this.#bridges.delete(projectId));
    }
    return this.#bridges.get(projectId);
  }

  async #world() {
    return this.#bridge(WORLD_PROJECT_ID, { create: true });
  }

  /** Every mounted project's bridge, the world first, then by projectId. */
  async #all() {
    const world = await this.#world();
    const result = [[WORLD_PROJECT_ID, world]];
    for (const { projectId } of await mountedProjects(this.#root)) {
      if (projectId !== WORLD_PROJECT_ID) result.push([projectId, await this.#bridge(projectId)]);
    }
    return result;
  }

  /** Which project holds each scope; read again when a scope is not known (another process may have made it). */
  async #refreshScopes() {
    this.#scopes.clear();
    for (const [projectId] of await this.#all()) {
      const folder = await projectStoreFolder(this.#root, projectId);
      const db = openReadOnlyDatabase(this.#sqlite, path.join(folder, MEMORY_FILE));
      try {
        for (const row of db.prepare("SELECT scope_id FROM memory_scopes").all()) this.#scopes.set(row.scope_id, projectId);
      } finally {
        db.close();
      }
    }
  }

  async #projectOfScope(scopeId) {
    if (!this.#scopes.has(scopeId)) await this.#refreshScopes();
    return this.#scopes.get(scopeId) ?? null;
  }

  /**
   * The project whose database recorded an operation id. One database keeps
   * operation ids unique for the whole instance; the split layout checks every
   * database, so a replay goes where the operation is and a reused id conflicts.
   */
  async #projectOfOperation(operationId) {
    if (typeof operationId !== "string") return null;
    for (const [projectId] of await this.#all()) {
      const folder = await projectStoreFolder(this.#root, projectId);
      const db = openReadOnlyDatabase(this.#sqlite, path.join(folder, MEMORY_FILE));
      try {
        if (db.prepare("SELECT 1 AS present FROM memory_operations WHERE operation_id=?").get(operationId)) return projectId;
      } finally {
        db.close();
      }
    }
    return null;
  }

  /** The operation's database when it is recorded; a conflict when it is recorded for another project. */
  async #operationTarget(command, operationId, projectId) {
    const owner = await this.#projectOfOperation(operationId);
    if (owner !== null && projectId !== null && owner !== projectId) throw failure(command, "memory_operation_conflict");
    return owner;
  }

  async #catalogAgents() {
    const merged = await this.#mergedRead(CATALOG_KEY);
    return Array.isArray(merged?.value?.agents) ? merged.value.agents : [];
  }

  /** The project a document belongs to (docs/project-package.md §3.2); the world for any other key. */
  async #documentOwner(key) {
    if (key.startsWith("workspace-")) {
      const hash = key.slice("workspace-".length);
      for (const { projectId } of await mountedProjects(this.#root)) if (sha256(projectId) === hash) return projectId;
      return WORLD_PROJECT_ID;
    }
    // A project's action journal (action-journal.mjs), its names (object-names.mjs) and its agents'
    // tasks (agent-tasks.mjs) live with the project.
    for (const [prefix, keyOf] of [[ACTION_JOURNAL_PREFIX, journalKeyOf], [NAMES_PREFIX, namesKeyOf],
      [TASKS_PREFIX, tasksKeyOf], [CHANGES_PREFIX, changesKeyOf]]) {
      if (!key.startsWith(prefix)) continue;
      for (const { projectId } of await mountedProjects(this.#root)) if (keyOf(projectId) === key) return projectId;
      return WORLD_PROJECT_ID;
    }
    if (key.startsWith(APPROVALS_PREFIX) || key.startsWith("agent-artifacts-")) {
      for (const agent of await this.#catalogAgents()) {
        if (typeof agent?.agentId !== "string") continue;
        if (key === `${APPROVALS_PREFIX}${sha256(agent.agentId).slice(0, 32)}` || key === artifactsKeyOf(agent.agentId)) {
          return (await this.#bridge(agent.projectId)) === null ? WORLD_PROJECT_ID : agent.projectId;
        }
      }
    }
    return WORLD_PROJECT_ID;
  }

  async #parts(key) {
    const parts = new Map();
    for (const [projectId, bridge] of await this.#all()) {
      const document = await bridge.invoke("read-document", { key });
      if (document !== null) parts.set(projectId, document);
    }
    return parts;
  }

  async #mergedRead(key) {
    const parts = await this.#parts(key);
    if (parts.size === 0) return null;
    const revision = [...parts.values()].reduce((sum, part) => sum + part.revision, 0);
    const values = [...parts.values()].map((part) => part.value);
    if (key === CATALOG_KEY) {
      const { agents: ignored, ...rest } = values[0] ?? {};
      const agents = values.flatMap((value) => (Array.isArray(value?.agents) ? value.agents : []))
        .map((agent, index) => ({ agent, index }))
        .sort((a, b) => compare(String(a.agent?.createdAtUtc ?? ""), String(b.agent?.createdAtUtc ?? "")) || a.index - b.index)
        .map(({ agent }) => agent);
      return { revision, value: { ...rest, agents } };
    }
    const { projects: ignoredProjects, quarters: ignoredQuarters, ...rest } = values[0] ?? {};
    return { revision, value: { ...rest,
      projects: Object.assign({}, ...values.map((value) => value?.projects ?? {})),
      quarters: Object.assign({}, ...values.map((value) => value?.quarters ?? {})) } };
  }

  /** Splits a merged document into each project's part. */
  #split(key, value) {
    const groups = new Map();
    const group = (projectId) => {
      if (!groups.has(projectId)) groups.set(projectId, key === CATALOG_KEY ? [] : { projects: {}, quarters: {} });
      return groups.get(projectId);
    };
    if (key === CATALOG_KEY) {
      const { agents, ...rest } = value;
      for (const agent of Array.isArray(agents) ? agents : []) group(agent?.projectId ?? WORLD_PROJECT_ID).push(agent);
      return { rest, groups, build: (agentsOf) => ({ ...rest, agents: agentsOf ?? [] }) };
    }
    const { projects, quarters, ...rest } = value;
    for (const [projectId, entry] of Object.entries(projects ?? {})) group(projectId).projects[projectId] = entry;
    for (const [quarterKey, entry] of Object.entries(quarters ?? {})) group(quarterKey.split("/")[0]).quarters[quarterKey] = entry;
    return { rest, groups, build: (part) => ({ ...rest, projects: part?.projects ?? {}, quarters: part?.quarters ?? {} }) };
  }

  async #mergedSwap(key, expectedRevision, value) {
    const parts = await this.#parts(key);
    const current = [...parts.values()].reduce((sum, part) => sum + part.revision, 0);
    if (current !== expectedRevision) return false;
    const { groups, build } = this.#split(key, value);
    const changed = [];
    for (const projectId of new Set([...parts.keys(), ...groups.keys()])) {
      const next = build(groups.get(projectId));
      const before = parts.get(projectId);
      if (before === undefined && !groups.has(projectId)) continue;
      if (before === undefined || canonical(before.value) !== canonical(next)) changed.push(projectId);
    }
    // An unchanged write still counts as a write: the world's part takes the new revision.
    if (changed.length === 0) changed.push(WORLD_PROJECT_ID);
    if (changed.length > 1) throw failure("compare-and-swap-document", "memory_cross_project_change");
    const [projectId] = changed;
    const bridge = await this.#bridge(projectId);
    if (bridge === null) throw failure("compare-and-swap-document", "memory_scope_not_found");
    return bridge.invoke("compare-and-swap-document",
      { key, expectedRevision: parts.get(projectId)?.revision ?? 0, value: build(groups.get(projectId)) });
  }

  async #copyProject(payload) {
    if (await this.#operationTarget("copy-project", payload.operationId, payload.targetProjectId) !== null) {
      return (await this.#bridge(payload.targetProjectId)).invoke("copy-project-from", { ...payload, sources: [] });
    }
    const source = await this.#bridge(payload.sourceProjectId);
    const listed = source === null ? { scopes: [], truncated: false }
      : await source.invoke("list-scopes", { projectId: payload.sourceProjectId, limit: 513 });
    if (listed.truncated) throw failure("copy-project", "memory_limit_exceeded");
    if (listed.scopes.length === 0) throw failure("copy-project", "memory_project_scope_required");
    for (const target of [payload.targetProjectScopeId, ...Object.values(payload.quarterScopeIds ?? {})]) {
      const owner = await this.#projectOfScope(target);
      if (owner !== null && owner !== payload.targetProjectId) throw failure("copy-project", "memory_scope_conflict");
    }
    const dtos = new Map();
    const ids = listed.scopes.map((scope) => scope.scopeId);
    for (let index = 0; index < ids.length; index += 128) {
      const set = await source.invoke("read-scope-set", { scopeIds: ids.slice(index, index + 128) });
      for (const dto of set.scopes) dtos.set(dto.scopeId, dto);
    }
    const sources = listed.scopes.map((scope) => {
      const dto = dtos.get(scope.scopeId);
      return { scopeId: dto.scopeId, kind: dto.kind, projectId: dto.projectId, quarterId: dto.quarterId,
        title: dto.title, revision: dto.revision, sha256: dto.sha256, entries: dto.entries };
    });
    const target = await this.#bridge(payload.targetProjectId, { create: true });
    const result = await target.invoke("copy-project-from", { ...payload, sources });
    for (const scope of result.scopes ?? []) this.#scopes.set(scope.targetScopeId, payload.targetProjectId);
    await this.#registerNewProject(payload.targetProjectId, sources.find((scope) => scope.kind === "project")?.title);
    return result;
  }

  /**
   * A project made here goes into the world registry at once, so other PCs know it
   * (docs/project-package.md §7): its title, this PC as its place, an empty summary.
   * A project the registry knows already is left as it is.
   * The store is the truth; a registry that could not be written is repaired from the
   * mounted projects (project-mount.mjs recordMountedProjects), so this never fails the change.
   */
  async #registerNewProject(projectId, title) {
    if (projectId === WORLD_PROJECT_ID) return;
    try {
      // A replayed creation, a copy into a known project: the registry has it already.
      if (Object.hasOwn((await readWorldRegistry(this.#root)).projects, projectId)) return;
      const machine = await readThisMachine(this.#root);
      await recordWorldProjects(this.#root, [{ projectId, ...(typeof title === "string" ? { title } : {}),
        location: machine === null ? null : { machineId: machine.machineId, atUtc: new Date().toISOString() },
        summary: { agents: 0, quarters: 0, tasksOpen: 0, lastActivityUtc: null } }]);
    } catch {
      // See above: repaired later, the project itself is made.
    }
  }

  async invoke(command, payload = {}) {
    switch (command) {
      case "init":
        await this.#world();
        await this.#refreshScopes();
        return { schemaVersion: 1, ready: true };
      case "create-scope": {
        await this.#operationTarget(command, payload.operationId, payload.projectId);
        const owner = await this.#projectOfScope(payload.scopeId);
        if (owner !== null && owner !== payload.projectId) throw failure(command, "memory_scope_conflict");
        // Only a project scope makes a project's database; a quarter or an agent
        // scope of a project that is not here gets the answer one database gives.
        const bridge = await this.#bridge(payload.projectId, { create: payload.kind === "project" })
          ?? await this.#world();
        const result = await bridge.invoke(command, payload);
        this.#scopes.set(payload.scopeId, payload.projectId);
        if (payload.kind === "project") await this.#registerNewProject(payload.projectId, payload.title);
        return result;
      }
      case "copy-project":
        return this.#copyProject(payload);
      case "list-scopes": {
        if (payload.projectId !== null && payload.projectId !== undefined) {
          const bridge = await this.#bridge(payload.projectId);
          return bridge === null ? { schemaVersion: 1, scopes: [], truncated: false } : bridge.invoke(command, payload);
        }
        const scopes = [];
        let truncated = false;
        for (const [, bridge] of await this.#all()) {
          const listed = await bridge.invoke(command, payload);
          scopes.push(...listed.scopes);
          truncated ||= listed.truncated;
        }
        scopes.sort(scopeOrder);
        const limit = payload.limit;
        return { schemaVersion: 1, scopes: scopes.slice(0, limit), truncated: truncated || scopes.length > limit };
      }
      case "read-pair": {
        const bridge = await this.#bridge(payload.projectId);
        if (bridge === null) throw failure(command, "memory_scope_not_found");
        return bridge.invoke(command, payload);
      }
      case "read-scope-set": {
        const byProject = new Map();
        for (const scopeId of payload.scopeIds ?? []) {
          const owner = await this.#projectOfScope(scopeId);
          if (owner === null) continue;
          if (!byProject.has(owner)) byProject.set(owner, []);
          byProject.get(owner).push(scopeId);
        }
        const found = new Map();
        for (const [projectId, scopeIds] of byProject) {
          const set = await (await this.#bridge(projectId)).invoke(command, { ...payload, scopeIds });
          for (const scope of set.scopes) found.set(scope.scopeId, scope);
        }
        return { schemaVersion: 1, scopes: (payload.scopeIds ?? []).filter((id) => found.has(id)).map((id) => found.get(id)) };
      }
      case "read-document":
        if (MERGED.has(payload.key)) return this.#mergedRead(payload.key);
        return (await this.#bridge(await this.#documentOwner(payload.key))).invoke(command, payload);
      case "compare-and-swap-document": {
        if (MERGED.has(payload.key)) return this.#mergedSwap(payload.key, payload.expectedRevision, payload.value);
        // A folder binding names its project; binding a project that has no scopes yet makes its store.
        const bound = payload.value?.projectId;
        if (payload.key.startsWith("workspace-") && typeof bound === "string"
            && payload.key === `workspace-${sha256(bound)}`) {
          return (await this.#bridge(bound, { create: true })).invoke(command, payload);
        }
        return (await this.#bridge(await this.#documentOwner(payload.key))).invoke(command, payload);
      }
      default: {
        if (!SCOPE_COMMANDS.has(command)) throw failure(command, "memory_invalid_input");
        // A scope no project holds behaves as in one database without it: the world answers.
        const owner = await this.#projectOfScope(payload.scopeId) ?? WORLD_PROJECT_ID;
        if (command === "write") await this.#operationTarget(command, payload.operationId, owner);
        return (await this.#bridge(owner)).invoke(command, payload);
      }
    }
  }

  /** The project a conversation's thread belongs to, through the catalog; null when no agent has it. */
  async projectOfThread(threadId) {
    for (const agent of await this.#catalogAgents()) {
      if (agent?.binding?.threadId === threadId && typeof agent.projectId === "string") return agent.projectId;
    }
    return null;
  }

  async close() {
    for (const opening of this.#bridges.values()) {
      const bridge = await opening.catch(() => null);
      if (bridge !== null) await bridge.close();
    }
  }
}

/**
 * The conversation archive in the split layout: one archive database per
 * project, beside its memory database. A conversation goes to the project of
 * the agent whose thread it is; a thread no agent has goes to the world. Each
 * database keeps the controller id in archive_meta (the world's identity), so
 * the archive store's own identity checks stay as they are.
 */
export class SplitConversationArchiveBridge {
  #root;
  #sqlite;
  #memory;
  #bridges = new Map();
  #threads = new Map();

  constructor({ controllerRoot, sqlite, memory }) {
    if (!controllerRoot || typeof sqlite?.DatabaseSync !== "function" || typeof memory?.projectOfThread !== "function") {
      throw new Error("SplitConversationArchiveBridge requires controllerRoot, node:sqlite and the split memory bridge");
    }
    this.#root = controllerRoot;
    this.#sqlite = sqlite;
    this.#memory = memory;
    this.sqliteBackend = "node";
  }

  async #projectOf(threadId) {
    if (typeof threadId !== "string") return WORLD_PROJECT_ID;
    if (!this.#threads.has(threadId)) {
      const projectId = await this.#memory.projectOfThread(threadId);
      if (projectId === null) return WORLD_PROJECT_ID;
      this.#threads.set(threadId, projectId);
    }
    return this.#threads.get(threadId);
  }

  async #bridge(projectId, controllerId) {
    if (!this.#bridges.has(projectId)) {
      const opening = (async () => {
        let folder = await projectStoreFolder(this.#root, projectId, { create: projectId === WORLD_PROJECT_ID });
        if (folder === null) folder = await projectStoreFolder(this.#root, WORLD_PROJECT_ID, { create: true });
        const bridge = new NodeConversationArchiveBridge({ databasePath: path.join(folder, ARCHIVE_FILE), sqlite: this.#sqlite });
        await bridge.invoke("init", { projectId: controllerId });
        return bridge;
      })();
      this.#bridges.set(projectId, opening);
      opening.catch(() => this.#bridges.delete(projectId));
    }
    return this.#bridges.get(projectId);
  }

  async invoke(command, payload = {}) {
    if (command === "init") return { schemaVersion: 1, ready: true };
    const projectId = await this.#projectOf(payload?.binding?.threadId);
    return (await this.#bridge(projectId, payload.projectId)).invoke(command, payload);
  }

  async close() {
    for (const opening of this.#bridges.values()) {
      const bridge = await opening.catch(() => null);
      if (bridge !== null) await bridge.close();
    }
    await this.#memory.close();
  }
}

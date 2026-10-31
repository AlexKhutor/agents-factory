import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { SqliteControlStore } from "./sqlite-control-store.mjs";
import { PersistentSqliteBridge, persistentSqliteBridgeEnabled } from "./sqlite-bridge-server.mjs";
import { resolveSqliteBackend, sqliteBackendOption } from "./sqlite-backend.mjs";
import { NodeProjectMemoryBridge } from "./project-memory-store-node.mjs";
import { SplitProjectMemoryBridge } from "./project-memory-split.mjs";
import { resolveStoreLayout } from "./project-store-layout.mjs";

export const PROJECT_MEMORY_LIMITS = Object.freeze({
  entries: 64,
  contentBytes: 64 * 1024,
  listScopes: 512,
  documentBytes: 256 * 1024,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SENSITIVE_TEXT = Object.freeze([
  /data:(?:image|audio|video)\//iu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
]);
const BRIDGE_ERRORS = new Set([
  "memory_authorization_consumed", "memory_authorization_mismatch",
  "memory_authorization_required", "memory_command_conflict", "memory_cross_project_change",
  "memory_identity_conflict", "memory_invalid_input", "memory_limit_exceeded",
  "memory_operation_conflict", "memory_project_scope_required",
  "memory_revision_conflict", "memory_revision_not_found", "memory_scope_conflict",
  "memory_scope_not_found", "memory_unsupported_schema",
]);

export class ProjectMemoryStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProjectMemoryStoreError";
    this.code = code;
  }
}

function fail(code = "memory_invalid_input") {
  throw new ProjectMemoryStoreError(code);
}

function exact(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const allowed = new Set([...required, ...optional]);
  if (required.some((field) => !Object.hasOwn(value, field))
      || Object.keys(value).some((field) => !allowed.has(field))) fail();
}

function identifier(value) {
  if (typeof value !== "string" || !ID.test(value)) fail();
  return value;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedText(value, { allowEmpty = false, maximumBytes = 65_536 } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
      || FORBIDDEN_CONTROL.test(value)
      || hasUnpairedSurrogate(value)
      || SENSITIVE_TEXT.some((pattern) => pattern.test(value))) fail();
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("memory_limit_exceeded");
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function hash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function revision(value, { allowZero = false, incrementable = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)
      || (incrementable && value >= Number.MAX_SAFE_INTEGER)) fail();
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || value.length > 32 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) fail("memory_unavailable");
  return value;
}

function normalizeEntries(value) {
  if (!Array.isArray(value) || value.length > PROJECT_MEMORY_LIMITS.entries) fail();
  const ids = new Set();
  const entries = value.map((entry) => {
    exact(entry, ["id", "title", "text"]);
    const normalized = {
      id: identifier(entry.id),
      title: boundedText(entry.title, { maximumBytes: 512 }),
      text: boundedText(entry.text, { allowEmpty: true }),
    };
    if (ids.has(normalized.id)) fail();
    ids.add(normalized.id);
    return normalized;
  });
  if (Buffer.byteLength(canonicalJson(entries), "utf8") > PROJECT_MEMORY_LIMITS.contentBytes) {
    fail("memory_limit_exceeded");
  }
  return entries;
}

/** Project, quarter, and since schema 2 an agent's own memory (beside its quarter). */
export const PROJECT_MEMORY_SCOPE_KINDS = Object.freeze(["project", "quarter", "agent"]);

function normalizeScope(value) {
  exact(value, ["scopeId", "kind", "projectId", "quarterId", "title", "operationId"]);
  if (!PROJECT_MEMORY_SCOPE_KINDS.includes(value.kind)) fail();
  const scope = {
    scopeId: identifier(value.scopeId),
    kind: value.kind,
    projectId: identifier(value.projectId),
    quarterId: value.quarterId === null ? null : identifier(value.quarterId),
    title: boundedText(value.title, { maximumBytes: 512 }),
    operationId: identifier(value.operationId),
  };
  if ((scope.kind === "project") !== (scope.quarterId === null)) fail();
  return scope;
}

function validateJson(value, state = { depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.depth > 24 || state.nodes > 8_192) fail("memory_limit_exceeded");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") return boundedText(value, {
    allowEmpty: true,
    maximumBytes: PROJECT_MEMORY_LIMITS.documentBytes,
  });
  if (!value || typeof value !== "object") fail();
  const childState = { ...state, depth: state.depth + 1 };
  if (Array.isArray(value)) {
    if (value.length > 2_048) fail("memory_limit_exceeded");
    const result = value.map((item) => validateJson(item, childState));
    state.nodes = childState.nodes;
    return result;
  }
  const keys = Object.keys(value);
  if (Object.getPrototypeOf(value) !== Object.prototype || keys.length > 512) fail();
  const result = {};
  for (const key of keys) {
    if (!key || Buffer.byteLength(key, "utf8") > 256 || FORBIDDEN_CONTROL.test(key)) fail();
    result[key] = validateJson(value[key], childState);
  }
  state.nodes = childState.nodes;
  return result;
}

function normalizeDocumentValue(value) {
  const normalized = validateJson(value);
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > PROJECT_MEMORY_LIMITS.documentBytes) {
    fail("memory_limit_exceeded");
  }
  return normalized;
}

function validateMetadata(value) {
  exact(value, [
    "schemaVersion", "scopeId", "kind", "projectId", "quarterId", "title",
    "revision", "sha256", "author", "updatedAtUtc",
  ]);
  if (value.schemaVersion !== 1 || !PROJECT_MEMORY_SCOPE_KINDS.includes(value.kind)
      || (value.kind === "project") !== (value.quarterId === null)) fail("memory_unavailable");
  identifier(value.scopeId);
  identifier(value.projectId);
  if (value.quarterId !== null) identifier(value.quarterId);
  boundedText(value.title, { maximumBytes: 512 });
  revision(value.revision);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) fail("memory_unavailable");
  identifier(value.author);
  timestamp(value.updatedAtUtc);
  return structuredClone(value);
}

function validateScopeDto(value) {
  exact(value, [
    "schemaVersion", "scopeId", "kind", "projectId", "quarterId", "title",
    "revision", "sha256", "entries", "author", "updatedAtUtc",
  ]);
  const metadata = validateMetadata(Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "entries")));
  const entries = normalizeEntries(value.entries);
  if (hash(entries) !== metadata.sha256) fail("memory_unavailable");
  return { ...metadata, entries };
}

function validateWriteReceipt(value) {
  exact(value, [
    "schemaVersion", "operationId", "commandId", "scopeId", "previousRevision",
    "revision", "sha256", "author", "updatedAtUtc",
  ]);
  if (value.schemaVersion !== 1) fail("memory_unavailable");
  for (const field of ["operationId", "commandId", "scopeId", "author"]) identifier(value[field]);
  revision(value.previousRevision);
  revision(value.revision);
  if (value.revision !== value.previousRevision + 1 || !SHA256.test(value.sha256)) {
    fail("memory_unavailable");
  }
  timestamp(value.updatedAtUtc);
  return structuredClone(value);
}

function validateGrant(value) {
  exact(value, [
    "schemaVersion", "commandId", "scopeId", "expectedRevision", "contentSha256",
    "requestedBy", "authorizedAtUtc",
  ]);
  if (value.schemaVersion !== 1 || !SHA256.test(value.contentSha256)) fail("memory_unavailable");
  for (const field of ["commandId", "scopeId", "requestedBy"]) identifier(value[field]);
  revision(value.expectedRevision);
  timestamp(value.authorizedAtUtc);
  return structuredClone(value);
}

function nowUtc(now) {
  let value;
  try { value = now().toISOString(); } catch { fail("memory_unavailable"); }
  return timestamp(value);
}

function bridgeValue(validate) {
  try {
    return validate();
  } catch {
    fail("memory_unavailable");
  }
}

export class ProjectMemoryStore {
  constructor({ store, now = () => new Date() }) {
    if (!store || typeof store.invoke !== "function" || typeof now !== "function") fail();
    this.store = store;
    this.now = now;
  }

  async #invoke(command, payload = {}) {
    try {
      return await this.store.invoke(command, payload);
    } catch (error) {
      let code;
      try { code = JSON.parse(error.stderr.trim().split(/\r?\n/u).at(-1)).error; } catch {}
      fail(BRIDGE_ERRORS.has(code) ? code : "memory_unavailable");
    }
  }

  async createScope(value) {
    const scope = normalizeScope(value);
    const requestSha256 = hash(scope);
    const result = await this.#invoke("create-scope", {
      ...scope,
      requestSha256,
      contentSha256: hash([]),
      updatedAtUtc: nowUtc(this.now),
    });
    return bridgeValue(() => validateScopeDto(result));
  }

  async copyProject(value) {
    exact(value, ["sourceProjectId", "targetProjectId", "targetProjectScopeId",
      "quarterScopeIds", "operationId"]);
    const sourceProjectId = identifier(value.sourceProjectId);
    const targetProjectId = identifier(value.targetProjectId);
    if (sourceProjectId === targetProjectId) fail();
    if (!value.quarterScopeIds || typeof value.quarterScopeIds !== "object"
        || Array.isArray(value.quarterScopeIds)
        || Object.keys(value.quarterScopeIds).length > PROJECT_MEMORY_LIMITS.listScopes - 1) fail();
    const quarterScopeIds = Object.fromEntries(Object.entries(value.quarterScopeIds)
      .map(([quarterId, scopeId]) => [identifier(quarterId), identifier(scopeId)]));
    const scopeIds = [identifier(value.targetProjectScopeId), ...Object.values(quarterScopeIds)];
    if (new Set(scopeIds).size !== scopeIds.length) fail();
    const request = { sourceProjectId, targetProjectId,
      targetProjectScopeId: scopeIds[0], quarterScopeIds,
      operationId: identifier(value.operationId) };
    const result = await this.#invoke("copy-project", {
      ...request, requestSha256: hash(request), copiedAtUtc: nowUtc(this.now),
    });
    return bridgeValue(() => {
      exact(result, ["schemaVersion", "outcome", "sourceProjectId", "targetProjectId",
        "operationId", "scopes", "copiedAtUtc"]);
      if (result.schemaVersion !== 1 || result.outcome !== "complete"
          || result.sourceProjectId !== sourceProjectId || result.targetProjectId !== targetProjectId
          || result.operationId !== request.operationId || !Array.isArray(result.scopes)
          || result.scopes.length !== scopeIds.length) fail("memory_unavailable");
      for (const scope of result.scopes) {
        exact(scope, ["sourceScopeId", "targetScopeId", "kind", "quarterId",
          "sourceRevision", "sourceSha256", "targetRevision", "targetSha256"]);
        identifier(scope.sourceScopeId);
        if (!scopeIds.includes(identifier(scope.targetScopeId))
            || !["project", "quarter"].includes(scope.kind)
            || (scope.quarterId !== null && !Object.hasOwn(quarterScopeIds, identifier(scope.quarterId)))
            || !Number.isInteger(scope.sourceRevision) || scope.sourceRevision < 1
            || scope.targetRevision !== 1 || !SHA256.test(scope.sourceSha256)
            || scope.sourceSha256 !== scope.targetSha256) fail("memory_unavailable");
      }
      return result;
    });
  }

  async readScope(value) {
    exact(value, ["scopeId"], ["revision"]);
    const requestedRevision = Object.hasOwn(value, "revision")
      ? revision(value.revision)
      : null;
    const result = await this.#invoke("read-scope", {
      scopeId: identifier(value.scopeId),
      revision: requestedRevision,
    });
    return bridgeValue(() => validateScopeDto(result));
  }

  /**
   * Ends the store's bridge process after the calls already sent
   * (sqlite-bridge-server.mjs); with node:sqlite, only later calls fail.
   */
  async close() {
    if (typeof this.store.close === "function") await this.store.close();
  }

  async listScopes(value = {}) {
    exact(value, [], ["projectId"]);
    const result = await this.#invoke("list-scopes", {
      projectId: Object.hasOwn(value, "projectId") ? identifier(value.projectId) : null,
      limit: PROJECT_MEMORY_LIMITS.listScopes,
    });
    try {
      exact(result, ["schemaVersion", "scopes", "truncated"]);
      if (result.schemaVersion !== 1 || !Array.isArray(result.scopes)
          || result.scopes.length > PROJECT_MEMORY_LIMITS.listScopes
          || typeof result.truncated !== "boolean") fail("memory_unavailable");
      return {
        schemaVersion: 1,
        scopes: result.scopes.map(validateMetadata),
        truncated: result.truncated,
      };
    } catch (error) {
      if (error instanceof ProjectMemoryStoreError && error.code === "memory_unavailable") throw error;
      fail("memory_unavailable");
    }
  }

  async authorizeWrite(value) {
    // This trusted local control call records authority; callers must prove the
    // upstream user command before invoking it. Memory text cannot self-grant.
    exact(value, ["commandId", "scopeId", "expectedRevision", "entries", "requestedBy"]);
    const grant = {
      commandId: identifier(value.commandId),
      scopeId: identifier(value.scopeId),
      expectedRevision: revision(value.expectedRevision, { incrementable: true }),
      contentSha256: hash(normalizeEntries(value.entries)),
      requestedBy: identifier(value.requestedBy),
    };
    const result = await this.#invoke("authorize-write", {
      ...grant,
      requestSha256: hash(grant),
      authorizedAtUtc: nowUtc(this.now),
    });
    return bridgeValue(() => validateGrant(result));
  }

  async write(value) {
    exact(value, [
      "scopeId", "expectedRevision", "entries", "operationId", "commandId", "actorId",
    ]);
    const request = {
      scopeId: identifier(value.scopeId),
      expectedRevision: revision(value.expectedRevision, { incrementable: true }),
      entries: normalizeEntries(value.entries),
      operationId: identifier(value.operationId),
      commandId: identifier(value.commandId),
      actorId: identifier(value.actorId),
    };
    const result = await this.#invoke("write", {
      ...request,
      contentSha256: hash(request.entries),
      requestSha256: hash(request),
      updatedAtUtc: nowUtc(this.now),
    });
    return bridgeValue(() => validateWriteReceipt(result));
  }

  /** Current versions of the named scopes that exist, in one store call. */
  async readScopes(value) {
    exact(value, ["scopeIds"]);
    if (!Array.isArray(value.scopeIds) || value.scopeIds.length > 128) fail();
    const scopeIds = [...new Set(value.scopeIds.map(identifier))];
    if (scopeIds.length === 0) return [];
    const result = await this.#invoke("read-scope-set", { scopeIds });
    return bridgeValue(() => {
      exact(result, ["schemaVersion", "scopes"]);
      if (result.schemaVersion !== 1 || !Array.isArray(result.scopes)) fail("memory_unavailable");
      const scopes = result.scopes.map(validateScopeDto);
      if (scopes.some((scope) => !scopeIds.includes(scope.scopeId))) fail("memory_unavailable");
      return scopes;
    });
  }

  async readPair(value) {
    exact(value, ["projectId", "quarterId"]);
    const result = await this.#invoke("read-pair", {
      projectId: identifier(value.projectId),
      quarterId: identifier(value.quarterId),
    });
    try {
      exact(result, ["project", "quarter"]);
      const pair = {
        project: validateScopeDto(result.project),
        quarter: validateScopeDto(result.quarter),
      };
      if (pair.project.kind !== "project" || pair.quarter.kind !== "quarter"
          || pair.project.projectId !== value.projectId
          || pair.quarter.projectId !== value.projectId
          || pair.quarter.quarterId !== value.quarterId) fail("memory_unavailable");
      return pair;
    } catch (error) {
      if (error instanceof ProjectMemoryStoreError && error.code === "memory_unavailable") throw error;
      fail("memory_unavailable");
    }
  }

  async readDocument(value) {
    exact(value, ["key"]);
    const result = await this.#invoke("read-document", { key: identifier(value.key) });
    if (result === null) return null;
    try {
      exact(result, ["revision", "value"]);
      const normalized = normalizeDocumentValue(result.value);
      return { revision: revision(result.revision), value: normalized };
    } catch {
      fail("memory_unavailable");
    }
  }

  async compareAndSwapDocument(value) {
    exact(value, ["key", "expectedRevision", "value"]);
    const result = await this.#invoke("compare-and-swap-document", {
      key: identifier(value.key),
      expectedRevision: revision(value.expectedRevision, { allowZero: true, incrementable: true }),
      value: normalizeDocumentValue(value.value),
    });
    if (typeof result !== "boolean") fail("memory_unavailable");
    return result;
  }

  transactionDocument(value) {
    return this.compareAndSwapDocument(value);
  }

  async initialize() {
    const result = await this.#invoke("init");
    if (result?.schemaVersion !== 1 || result?.ready !== true
        || Object.keys(result).length !== 2) fail("memory_unavailable");
  }
}

async function checkedBridgePath(value) {
  if (typeof value !== "string" || !value) fail();
  const resolved = path.resolve(value);
  const info = await lstat(resolved).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink()) fail("memory_identity_conflict");
  const canonical = await realpath(resolved);
  if (path.relative(resolved, canonical) !== "") fail("memory_identity_conflict");
  return canonical;
}

/**
 * The split layout's bridge (project-memory-split.mjs) when the instance is
 * split, else null. The split layout runs on node:sqlite only (R22).
 */
export async function openSplitMemoryBridge(controllerRoot, sqliteBackend) {
  if (typeof controllerRoot !== "string" || !controllerRoot) fail();
  let layout;
  try { layout = await resolveStoreLayout(controllerRoot); } catch { fail("memory_identity_conflict"); }
  if (layout.layout !== "split") return null;
  const { backend, sqlite } = await resolveSqliteBackend({ backend: sqliteBackend });
  if (backend !== "node") fail("memory_sqlite_required");
  return new SplitProjectMemoryBridge({ controllerRoot: layout.root, sqlite });
}

async function checkedDatabaseDirectory(controllerRoot) {
  if (typeof controllerRoot !== "string" || !controllerRoot) fail();
  let root;
  try { root = await realpath(controllerRoot); } catch { fail("memory_identity_conflict"); }
  let directory = root;
  for (const segment of [".project-local", "orchestration", "project-memory"]) {
    const candidate = path.join(directory, segment);
    const existing = await lstat(candidate).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing === null) await mkdir(candidate);
    else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail("memory_identity_conflict");
    }
    const canonical = await realpath(candidate);
    const relative = path.relative(root, canonical);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      fail("memory_identity_conflict");
    }
    directory = canonical;
  }
  return directory;
}

async function rejectLinkedDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const info = await lstat(`${databasePath}${suffix}`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (info !== null && (!info.isFile() || info.isSymbolicLink())) {
      fail("memory_identity_conflict");
    }
  }
}

/**
 * `sqliteBackend` ("node" | "python") overrides AGENTS_FACTORY_SQLITE and the
 * default: node:sqlite in this process when the runtime has it, else the
 * Python bridge (`bridgePath`, `pythonCommand`), which is then required.
 */
export async function createProjectMemoryStore({
  controllerRoot,
  now = () => new Date(),
  pythonCommand,
  bridgePath = fileURLToPath(new URL("project-memory-store.py", import.meta.url)),
  sqliteBackend,
}) {
  if (typeof now !== "function") fail();
  try { sqliteBackendOption(sqliteBackend); } catch { fail(); }
  const split = await openSplitMemoryBridge(controllerRoot, sqliteBackend);
  if (split !== null) {
    const memory = new ProjectMemoryStore({ now, store: split });
    Object.defineProperty(memory, "sqliteBackend", { value: "node" });
    await memory.initialize();
    return memory;
  }
  const directory = await checkedDatabaseDirectory(controllerRoot);
  const databasePath = path.join(directory, "project-memory.v1.sqlite");
  await rejectLinkedDatabase(databasePath);
  const { backend, sqlite } = await resolveSqliteBackend({ backend: sqliteBackend });
  let store;
  if (backend === "node") {
    store = new NodeProjectMemoryBridge({ databasePath, sqlite });
  } else {
    const canonicalBridge = await checkedBridgePath(bridgePath);
    // One long-lived bridge (sqlite-bridge-server.mjs); the old one Python
    // process per call stays available with ORCHESTRATOR_SQLITE_BRIDGE=spawn.
    store = persistentSqliteBridgeEnabled()
      ? new PersistentSqliteBridge({ databasePath, pythonCommand, bridgePath: canonicalBridge,
        unavailableCode: "memory_unavailable" })
      : new SqliteControlStore({ databasePath, pythonCommand, bridgePath: canonicalBridge });
  }
  const memory = new ProjectMemoryStore({ now, store });
  Object.defineProperty(memory, "sqliteBackend", { value: backend });
  await memory.initialize();
  return memory;
}

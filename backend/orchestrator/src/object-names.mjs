import { createHash } from "node:crypto";

// The names of a project, its quarters and its agents (roadmap step 2,
// docs/personal/plans/01_11_2026_names-and-ids.md). The ID (object-ids.mjs)
// never changes; the name is free text the person may change at any time.
// One store document per project (`names-v1:<hash of the project ID>`), in the
// project's own memory database like its action journal: it goes with the
// project into its package and between PCs, and the database schema stays as
// it is. An object without an entry is named by its ID, so the objects made
// before names existed need no migration.

export const OBJECT_NAMES_VERSION = "v0.1.0";
export const NAMES_PREFIX = "names-v1:";
export const NAME_KINDS = Object.freeze(["project", "quarter", "agent"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_NAME = 120;
const CAS_ATTEMPTS = 32;

function fail(code) { throw Object.assign(new Error(code), { code }); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) fail("name_invalid_input");
  return value;
}

/** The store document of one project's names. */
export function namesKeyOf(projectId) {
  return `${NAMES_PREFIX}${sha256(id(projectId)).slice(0, 32)}`;
}

/** A name as kept: trimmed, single spaces, 1-120 characters, no control characters. */
export function normalizeName(value) {
  if (typeof value !== "string") fail("name_invalid");
  const name = value.replace(/\s+/gu, " ").trim();
  if (!name || [...name].length > MAX_NAME || /[\u0000-\u001f\u007f]/u.test(name)) fail("name_invalid");
  return name;
}

function emptyNames() { return { project: null, quarters: {}, agents: {} }; }

function namesOf(value) {
  const names = emptyNames();
  if (typeof value?.project === "string") names.project = value.project;
  for (const kind of ["quarters", "agents"]) {
    for (const [key, name] of Object.entries(value?.[kind] ?? {})) {
      if (ID.test(key) && typeof name === "string") names[kind][key] = name;
    }
  }
  return names;
}

/** The names of one project: { project, quarters: {id: name}, agents: {id: name} }. */
export async function readNames(store, projectId) {
  const record = await store.readDocument({ key: namesKeyOf(projectId) });
  return namesOf(record?.value);
}

/** The name an object is shown by: its own, or its ID. */
export function nameOf(names, kind, objectId) {
  if (kind === "project") return names?.project ?? objectId;
  return names?.[`${kind}s`]?.[objectId] ?? objectId;
}

/**
 * Sets the name of one object of a project (null: back to its ID). Returns
 * the name before and after (null where the object was named by its ID).
 */
export async function setName(store, { projectId, kind, objectId, name }) {
  if (!NAME_KINDS.includes(kind)) fail("name_invalid_input");
  id(objectId);
  if (kind === "project" && objectId !== projectId) fail("name_invalid_input");
  const next = name === null ? null : normalizeName(name);
  const key = namesKeyOf(projectId);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const record = await store.readDocument({ key });
    const names = namesOf(record?.value);
    const previous = kind === "project" ? names.project : names[`${kind}s`][objectId] ?? null;
    if (kind === "project") names.project = next;
    else if (next === null) delete names[`${kind}s`][objectId];
    else names[`${kind}s`][objectId] = next;
    const value = { schemaVersion: 1, projectId, ...names };
    if (await store.compareAndSwapDocument({ key, expectedRevision: record?.revision ?? 0, value })) {
      return { projectId, kind, objectId, previous, name: next };
    }
  }
  return fail("name_contention");
}

const AGENTS_KEY = "memory-agents-v1";
const WORLD_PROJECT_ID = "world";

/** Renames an object that exists: a project or quarter by its memory scope, an agent by the catalog. */
export async function renameObject(store, input) {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join() !== "kind,name,objectId,projectId") {
    fail("name_invalid_input");
  }
  const projectId = id(input.projectId);
  const objectId = id(input.objectId);
  if (input.kind === "agent") {
    const agents = (await store.readDocument({ key: AGENTS_KEY }))?.value?.agents ?? [];
    if (!agents.some((agent) => agent.agentId === objectId && agent.projectId === projectId)) fail("name_object_not_found");
  } else if (NAME_KINDS.includes(input.kind)) {
    const scopes = (await store.listScopes({ projectId })).scopes;
    const found = input.kind === "project" ? objectId === projectId && scopes.some((scope) => scope.kind === "project")
      : scopes.some((scope) => scope.kind === "quarter" && scope.quarterId === objectId);
    if (!found) fail("name_object_not_found");
  } else {
    fail("name_invalid_input");
  }
  return setName(store, { projectId, kind: input.kind, objectId, name: input.name });
}

/** The names of one project ({projectId}) or of every project the store holds and the world's. */
export async function readAllNames(store, input = {}) {
  const keys = Object.keys(input ?? {});
  if (keys.some((key) => key !== "projectId")) fail("name_invalid_input");
  const projectIds = typeof input?.projectId === "string" ? [id(input.projectId)]
    : [...new Set([...(await store.listScopes({})).scopes.map((scope) => scope.projectId), WORLD_PROJECT_ID])];
  const projects = {};
  for (const projectId of projectIds) projects[projectId] = await readNames(store, projectId);
  return { schemaVersion: 1, projects };
}

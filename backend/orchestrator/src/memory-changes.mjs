import { createHash, randomBytes } from "node:crypto";

// An agent's own changes to memory (roadmap track V, item 2a;
// docs/personal/plans/01_11_2026_agent-memory-tools.md). The agent says what to
// add, change or remove - entries by title - and the change waits for the
// person, who approves or rejects it in the agent's chat; approved, it is
// written at once, exactly as shown. An agent's change of its own memory is
// written at once when the person allowed that for the agent. One store
// document per project (`memory-changes-v1:<hash of the project ID>`) keeps the
// changes, pending and decided, in the project's own database.

export const MEMORY_CHANGES_VERSION = "v0.1.0";
export const CHANGES_PREFIX = "memory-changes-v1:";
// written: applied at once without asking (the agent's own memory, allowed by the person).
export const CHANGE_STATES = Object.freeze(["pending", "approved", "rejected", "stale", "written"]);
export const CHANGE_TARGETS = Object.freeze(["own", "quarter", "project", "agent"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const LIMITS = Object.freeze({ kept: 100, changes: 32, title: 512, text: 65_536, reason: 2000,
  documentBytes: 200 * 1024 });
const CAS_ATTEMPTS = 32;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu;

function fail(code) { throw Object.assign(new Error(code), { code }); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) fail("memory_change_invalid_input");
  return value;
}
function text(value, max, { empty = false } = {}) {
  if (typeof value !== "string") fail("memory_change_invalid_input");
  const clean = value.replace(/\r\n?/gu, "\n").replace(CONTROL, "").trim();
  if (!empty && !clean) fail("memory_change_invalid_input");
  if (Buffer.byteLength(clean, "utf8") > max) fail("memory_change_too_large");
  return clean;
}
const suffix = (random) => [...random(4)].map((byte) => BASE36[byte % 36]).join("");

/** The store document of one project's memory changes. */
export function changesKeyOf(projectId) {
  return `${CHANGES_PREFIX}${sha256(id(projectId)).slice(0, 32)}`;
}

/**
 * The changes an agent asked for, checked: `[{ action: "set", title, text } | { action: "delete", title }]`.
 * A title names an entry; "set" adds it, or changes the text of the one with that title.
 */
export function normalizeChanges(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.changes) fail("memory_change_invalid_input");
  return value.map((change) => {
    if (!change || typeof change !== "object") fail("memory_change_invalid_input");
    const title = text(change.title, LIMITS.title);
    if (change.action === "set") return { action: "set", title, text: text(change.text, LIMITS.text) };
    if (change.action === "delete") return { action: "delete", title };
    return fail("memory_change_invalid_input");
  });
}

const sameTitle = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A memory's entries after the changes, and what changed: `{ entries, diff }`, where each
 * line of `diff` is `{ title, change: "added" | "changed" | "removed", text, previous }`.
 * A change that leaves an entry as it was is no change; nothing changed at all is refused.
 */
export function applyChanges(entries, changes, { random = randomBytes } = {}) {
  const next = entries.map((entry) => ({ id: entry.id, title: entry.title, text: entry.text }));
  const diff = [];
  const taken = new Set(next.map((entry) => entry.id));
  for (const change of changes) {
    const index = next.findIndex((entry) => sameTitle(entry.title, change.title));
    if (change.action === "delete") {
      if (index === -1) fail("memory_change_no_entry");
      diff.push({ title: next[index].title, change: "removed", text: null, previous: next[index].text });
      next.splice(index, 1);
    } else if (index === -1) {
      let entryId;
      do entryId = `note-${suffix(random)}`; while (taken.has(entryId));
      taken.add(entryId);
      next.push({ id: entryId, title: change.title, text: change.text });
      diff.push({ title: change.title, change: "added", text: change.text, previous: null });
    } else if (next[index].text !== change.text) {
      diff.push({ title: next[index].title, change: "changed", text: change.text, previous: next[index].text });
      next[index] = { ...next[index], text: change.text };
    }
  }
  if (diff.length === 0) fail("memory_change_empty");
  return { entries: next, diff };
}

function changesOf(value) {
  return Array.isArray(value?.changes) ? value.changes.filter((change) => change && typeof change.changeId === "string"
    && ID.test(change.changeId) && CHANGE_STATES.includes(change.state)) : [];
}

/** Old decided changes go first when the document is full; pending ones always stay. */
function trim(changes) {
  const decided = () => changes.findIndex((change) => change.state !== "pending");
  while (changes.length > LIMITS.kept && decided() !== -1) changes.splice(decided(), 1);
  while (Buffer.byteLength(JSON.stringify(changes), "utf8") > LIMITS.documentBytes && decided() !== -1) {
    changes.splice(decided(), 1);
  }
}

async function change(store, projectId, update) {
  const key = changesKeyOf(projectId);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const record = await store.readDocument({ key });
    const changes = structuredClone(changesOf(record?.value));
    const result = update(changes);
    trim(changes);
    if (await store.compareAndSwapDocument({ key, expectedRevision: record?.revision ?? 0,
      value: { schemaVersion: 1, projectId, changes } })) return result;
  }
  return fail("memory_change_contention");
}

/**
 * Records an agent's change: pending for the person, or written already (`state: "written"`,
 * `writtenRevision`). `target` is `{ kind, scopeId, agentId }` - the memory's owner agent for
 * an agent's memory, null otherwise.
 */
export async function recordChange(store, { projectId, quarterId, agentId, target, baseRevision, changes, diff,
  reason = null, state = "pending", writtenRevision = null, now = new Date(), random = randomBytes }) {
  id(projectId); id(quarterId); id(agentId);
  if (!CHANGE_TARGETS.includes(target?.kind)) fail("memory_change_invalid_input");
  const at = now.toISOString();
  return change(store, projectId, (list) => {
    let changeId;
    do changeId = `mem-${suffix(random)}`; while (list.some((item) => item.changeId === changeId));
    const record = { schemaVersion: 1, changeId, projectId, quarterId, agentId,
      target: { kind: target.kind, scopeId: id(target.scopeId), agentId: target.agentId ?? null },
      baseRevision, changes, diff, reason: reason === null ? null : text(reason, LIMITS.reason, { empty: true }) || null,
      state, createdAtUtc: at, decidedAtUtc: state === "pending" ? null : at, writtenRevision };
    list.push(record);
    return structuredClone(record);
  });
}

/** One project's changes, newest first; by the agent that asked, and states. */
export async function readChanges(store, { projectId, agentId = null, states = null, limit = 50 } = {}) {
  id(projectId);
  if (states !== null && (!Array.isArray(states) || states.some((state) => !CHANGE_STATES.includes(state)))) {
    fail("memory_change_invalid_input");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.kept) fail("memory_change_invalid_input");
  const record = await store.readDocument({ key: changesKeyOf(projectId) });
  const changes = changesOf(record?.value)
    .filter((item) => agentId === null || item.agentId === agentId)
    .filter((item) => states === null || states.includes(item.state))
    .sort((a, b) => String(b.createdAtUtc).localeCompare(String(a.createdAtUtc)));
  return { schemaVersion: 1, projectId, changes: changes.slice(0, limit), truncated: changes.length > limit };
}

/** Every project's changes (the window's attention reads the pending ones anywhere). */
export async function readAllChanges(store, { states = null, limit = 50 } = {}) {
  const projectIds = [...new Set([...(await store.listScopes({})).scopes.map((scope) => scope.projectId), "world"])];
  const changes = [];
  for (const projectId of projectIds) changes.push(...(await readChanges(store, { projectId, states, limit: LIMITS.kept })).changes);
  changes.sort((a, b) => String(b.createdAtUtc).localeCompare(String(a.createdAtUtc)));
  return { schemaVersion: 1, projectId: null, changes: changes.slice(0, limit), truncated: changes.length > limit };
}

/** One change of a project. */
export async function readChange(store, { projectId, changeId }) {
  const record = await store.readDocument({ key: changesKeyOf(projectId) });
  const found = changesOf(record?.value).find((item) => item.changeId === id(changeId));
  if (!found) fail("memory_change_not_found");
  return structuredClone(found);
}

/** The person's decision on a pending change: approved (and written), rejected, or stale (the memory moved on). */
export async function settleChange(store, { projectId, changeId, state, writtenRevision = null, now = new Date() }) {
  if (!["approved", "rejected", "stale"].includes(state)) fail("memory_change_invalid_input");
  return change(store, projectId, (list) => {
    const found = list.find((item) => item.changeId === id(changeId));
    if (!found) fail("memory_change_not_found");
    if (found.state !== "pending") fail("memory_change_decided");
    Object.assign(found, { state, decidedAtUtc: now.toISOString(), writtenRevision });
    return structuredClone(found);
  });
}

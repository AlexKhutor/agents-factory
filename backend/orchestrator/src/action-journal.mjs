import { createHash, randomUUID } from "node:crypto";

// The journal of changing actions (roadmap step 1, track B; the plan:
// docs/personal/plans/31_10_2026_action-journal.md): who changed what and
// when, one journal per project, and how to undo it when that is possible.
//
// Each project's journal is one store document (`action-journal-v1:<hash of
// the project ID>`), so it lives in the project's memory database and goes
// with the project into its package and between PCs; the world's journal is
// that of the reserved project `world`. An entry names the action, its
// project, quarter and agent, who did it (the person through Atlas or the
// trusted host, or an agent through its tool) and a short summary - never a
// memory text or a message. `undo` is the recipe of the inverse action
// (action-journal-undo.mjs) or null with the reason in `noUndo`. The newest
// entries are kept while they fit the store's document size.
//
// Recording is done where an action enters: the Gateway's mutation handlers
// (action-journal-gateway.mjs), the memory CLI's trusted actions and the
// desk's memory document tool. A journal that cannot be written never fails
// the action it describes; the caller reports it as a diagnostic.

export const ACTION_JOURNAL_VERSION = "v0.1.0";
export const ACTION_JOURNAL_PREFIX = "action-journal-v1:";

export const JOURNAL_ACTIONS = Object.freeze([
  "agent.create", "agent.close", "agent.reopen", "agent.profile", "agent.settings", "agent.permission-mode",
  "scope.create", "memory.write", "memory.approve", "project.archive", "project.restore", "quarter.archive",
  "quarter.restore", "project.copy", "project.policy", "project.bind", "project.rebind", "project.git-init",
  "project.file-save", "agent.desk-source", "object.rename",
]);
export const UNDO_KINDS = Object.freeze([
  "close-agent", "reopen-agent", "set-profile", "set-settings", "set-permission-mode", "archive-project",
  "restore-project", "archive-quarter", "restore-quarter", "memory-revision", "set-project-policy", "restore-file",
  "rename",
]);
/** Why an entry has no undo. */
export const NO_UNDO_REASONS = Object.freeze([
  "undo_entry", "file_not_kept", "binding_not_undone", "git_not_undone", "desk_source_not_undone",
  "approval_without_write", "first_revision",
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const ENTRY_ID = /^[a-f0-9-]{36}$/u;
const MAX_ENTRIES = 1_000;
// The store refuses a document above 256 KiB; the journal stays well below it.
const MAX_BYTES = 200 * 1024;
const MAX_SUMMARY = 300;
const CAS_ATTEMPTS = 32;

export class ActionJournalError extends Error {
  constructor(code) {
    super(code);
    this.name = "ActionJournalError";
    this.code = code;
  }
}
function fail(code) { throw new ActionJournalError(code); }

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) fail("journal_invalid_entry");
  return value;
}
const optionalId = (value) => (value === null || value === undefined ? null : id(value));

/** The store document of one project's journal. */
export function journalKeyOf(projectId) {
  return `${ACTION_JOURNAL_PREFIX}${sha256(id(projectId)).slice(0, 32)}`;
}

function summaryOf(value) {
  if (typeof value !== "string") fail("journal_invalid_entry");
  const text = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!text) fail("journal_invalid_entry");
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1)}…`;
}

function actorOf(value) {
  if (!value || typeof value !== "object" || !["person", "agent"].includes(value.kind)) fail("journal_invalid_entry");
  if (value.kind === "agent") return { kind: "agent", id: id(value.id) };
  return { kind: "person", id: optionalId(value.id) };
}

/** An undo recipe: its kind and plain JSON data (ids, a profile, revisions). */
function undoOf(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !UNDO_KINDS.includes(value.kind)) {
    fail("journal_invalid_entry");
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > 4_096) fail("journal_invalid_entry");
  return JSON.parse(text);
}

/** A new entry as the callers give it, checked; `entryId` and `atUtc` are added here. */
function newEntry(input, { now, newId }) {
  if (!input || typeof input !== "object") fail("journal_invalid_entry");
  if (!JOURNAL_ACTIONS.includes(input.action)) fail("journal_invalid_entry");
  const undo = undoOf(input.undo);
  const noUndo = undo === null ? (input.noUndo ?? null) : null;
  if (noUndo !== null && !NO_UNDO_REASONS.includes(noUndo)) fail("journal_invalid_entry");
  const undoes = input.undoes === undefined || input.undoes === null ? null : input.undoes;
  if (undoes !== null && !ENTRY_ID.test(undoes)) fail("journal_invalid_entry");
  return {
    entryId: newId(),
    atUtc: now().toISOString(),
    actor: actorOf(input.actor),
    action: input.action,
    projectId: id(input.projectId),
    quarterId: optionalId(input.quarterId),
    agentId: optionalId(input.agentId),
    summary: summaryOf(input.summary),
    undo,
    noUndo: undo === null && noUndo === null && undoes !== null ? "undo_entry" : noUndo,
    undoes,
    undoneBy: null,
    undoneAtUtc: null,
  };
}

/** Keeps the newest entries within the count and the byte budget. */
function trimmed(entries) {
  let kept = entries.slice(-MAX_ENTRIES);
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept), "utf8") > MAX_BYTES) {
    kept = kept.slice(Math.ceil(kept.length / 10));
  }
  return kept;
}

async function readDocument(store, projectId) {
  const record = await store.readDocument({ key: journalKeyOf(projectId) });
  const entries = Array.isArray(record?.value?.entries) ? record.value.entries : [];
  return { revision: record?.revision ?? 0, entries };
}

async function change(store, projectId, update) {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await readDocument(store, projectId);
    const entries = current.entries.map((entry) => ({ ...entry }));
    const result = update(entries);
    const value = { schemaVersion: 1, projectId, entries: trimmed(entries) };
    if (await store.compareAndSwapDocument({ key: journalKeyOf(projectId), expectedRevision: current.revision, value })) {
      return result;
    }
  }
  return fail("journal_contention");
}

/** Records one action in its project's journal; returns the stored entry. */
export async function recordAction(store, input, { now = () => new Date(), newId = randomUUID } = {}) {
  const entry = newEntry(input, { now, newId });
  return change(store, entry.projectId, (entries) => {
    entries.push(entry);
    if (entry.undoes !== null) {
      const undone = entries.find((item) => item.entryId === entry.undoes);
      if (undone && undone.undoneBy === null) Object.assign(undone, { undoneBy: entry.entryId, undoneAtUtc: entry.atUtc });
    }
    return entry;
  });
}

/**
 * Records an action without failing its caller: a journal that cannot be
 * written is reported through `onDiagnostic` (no input, no summary) and the
 * action stands.
 */
export async function recordActionQuietly(store, input, { onDiagnostic = () => {}, ...options } = {}) {
  try {
    return await recordAction(store, input, options);
  } catch (error) {
    try {
      onDiagnostic({ schemaVersion: 1, component: "action-journal", phase: "record",
        action: JOURNAL_ACTIONS.includes(input?.action) ? input.action : "unknown",
        reasonCode: typeof error?.code === "string" ? error.code : "journal_unavailable" });
    } catch { /* a diagnostic sink that fails is not the action's problem */ }
    return null;
  }
}

/** One project's entries, newest first (at most `limit`). */
export async function readProjectActions(store, { projectId, limit = 200 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENTRIES) fail("journal_invalid_query");
  const { entries } = await readDocument(store, id(projectId));
  return entries.slice(-limit).reverse();
}

/** Several projects' entries merged, newest first (at most `limit`). */
export async function readActions(store, { projectIds, limit = 200 } = {}) {
  if (!Array.isArray(projectIds) || projectIds.length > 1_024) fail("journal_invalid_query");
  const all = [];
  for (const projectId of new Set(projectIds)) all.push(...await readProjectActions(store, { projectId, limit }));
  return all.sort((a, b) => (a.atUtc < b.atUtc ? 1 : a.atUtc > b.atUtc ? -1 : 0)).slice(0, limit);
}

/** One entry of a project's journal, or null. */
export async function findAction(store, { projectId, entryId }) {
  if (typeof entryId !== "string" || !ENTRY_ID.test(entryId)) fail("journal_invalid_query");
  const { entries } = await readDocument(store, id(projectId));
  return entries.find((entry) => entry.entryId === entryId) ?? null;
}

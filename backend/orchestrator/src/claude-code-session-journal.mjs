import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { renameOver } from "./rename-over.mjs";

// What the desk has seen of each Claude Code session it drives: its turns and
// their items, as the Agent SDK streamed them. Claude Code keeps its own
// transcript too; this journal is the Gateway's record of the turns it ran,
// with the identities it handed out, so reads stay exact across restarts.
//
// One folder per session: `session.json` (metadata and the order of turns)
// and one file per turn, so a new item rewrites only its own turn. Desk agents
// live long; the journal keeps their latest turns for live reads, and the
// conversation archive (conversation-archive.mjs) keeps the whole history.

export const CLAUDE_CODE_SESSION_JOURNAL_VERSION = "v0.3.0";
export const CLAUDE_CODE_SESSION_LIMITS = Object.freeze({
  sessions: 1024, keptTurns: 512, itemsPerTurn: 512, textBytes: 65_536, outputBytes: 16_384,
  sessionBytes: 256 * 1024, turnBytes: 16 * 1024 * 1024, cachedTurns: 256,
});

// The trace of a session: everything a turn did, in full, one JSON record per
// line, only ever appended - the desk's counterpart of a Codex rollout file.
// The chat shows a readable digest (the turn files above); the trace keeps what
// the chat leaves out: the whole prompt with its memory, tool inputs and
// outputs, diffs, the model and usage of each turn. Files rotate by size and
// the newest two are kept, so a long-lived agent's trace stays bounded.
export const CLAUDE_CODE_TRACE_LIMITS = Object.freeze({
  fileBytes: 32 * 1024 * 1024, keptFiles: 2, recordBytes: 256 * 1024, pageBytes: 512 * 1024, pageRecords: 512,
});
const TRACE_FILE = /^trace-(\d{6})\.jsonl$/u;
const TRACE_CURSOR = /^(\d{1,6}):(\d{1,12})$/u;
const traceName = (generation) => `trace-${String(generation).padStart(6, "0")}.jsonl`;

function traceCursor(value) {
  if (value === null || value === undefined) return null;
  const match = typeof value === "string" ? TRACE_CURSOR.exec(value) : null;
  if (match === null) fail("claude_trace_cursor_invalid");
  return { generation: Number(match[1]), offset: Number(match[2]) };
}

/**
 * Complete JSON lines of a byte range, each with its start and end offset in
 * the range; a line cut by the range start (when `startsMidLine`) or by its end
 * is left out. A damaged line is skipped, never repaired.
 */
function traceLines(buffer, startsMidLine) {
  const lines = [];
  let start = 0;
  if (startsMidLine) {
    const first = buffer.indexOf(0x0a);
    if (first === -1) return lines;
    start = first + 1;
  }
  for (let index = start; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    try { lines.push({ record: JSON.parse(buffer.subarray(start, index).toString("utf8")), start, end: index + 1 }); }
    catch { /* skipped */ }
    start = index + 1;
  }
  return lines;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);

function fail(code) { throw Object.assign(new Error(code), { code }); }

export function claudeSessionId(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail("claude_session_id_invalid");
  return value;
}

function turnId(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail("claude_turn_id_invalid");
  return value;
}

/** Clips text to a byte budget on a character boundary; says whether it did. */
export function clipText(value, maximumBytes) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text, clipped: false };
  // A character cut in half decodes to U+FFFD at the end; it is dropped.
  const head = bytes.subarray(0, maximumBytes - 3).toString("utf8").replace(/�+$/u, "");
  return { text: `${head}...`, clipped: true };
}

async function readBounded(file, maximumBytes) {
  let info;
  try { info = await lstat(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("claude_journal_unavailable");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) fail("claude_journal_invalid");
  try { return JSON.parse(await readFile(file, "utf8")); } catch { fail("claude_journal_invalid"); }
}

// The rename waits out a moment's hold of the target on Windows (rename-over.mjs):
// a turn must not fail because an antivirus scan touched its record.
async function writeAtomic(file, value, maximumBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) fail("claude_journal_full");
  const temporary = `${file}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameOver(temporary, file);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    fail("claude_journal_unavailable");
  }
}

function validSession(value, sessionId) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || value.sessionId !== sessionId
      || typeof value.cwd !== "string" || !Array.isArray(value.turnIds)
      || typeof value.providerStarted !== "boolean") fail("claude_journal_invalid");
  return value;
}

function validTurn(value, id) {
  if (!value || typeof value !== "object" || value.id !== id || typeof value.status !== "string"
      || !Array.isArray(value.items)) fail("claude_journal_invalid");
  return value;
}

class ClaudeCodeSessionJournal {
  #directory;
  #sessions = new Map();
  #turns = new Map();
  #queues = new Map();

  #keptTurns;

  constructor(directory, keptTurns) { this.#directory = directory; this.#keptTurns = keptTurns; }

  #folder(sessionId) { return path.join(this.#directory, claudeSessionId(sessionId)); }
  #sessionFile(sessionId) { return path.join(this.#folder(sessionId), "session.json"); }
  #turnFile(sessionId, id) { return path.join(this.#folder(sessionId), "turns", `${turnId(id)}.json`); }

  async #loadSession(sessionId) {
    if (this.#sessions.has(sessionId)) return this.#sessions.get(sessionId);
    const value = await readBounded(this.#sessionFile(sessionId), CLAUDE_CODE_SESSION_LIMITS.sessionBytes);
    if (value === null) return null;
    const session = validSession(value, sessionId);
    this.#sessions.set(sessionId, session);
    return session;
  }

  async #loadTurn(sessionId, id) {
    const key = `${sessionId}:${id}`;
    if (this.#turns.has(key)) return this.#turns.get(key);
    const value = await readBounded(this.#turnFile(sessionId, id), CLAUDE_CODE_SESSION_LIMITS.turnBytes);
    if (value === null) fail("claude_journal_invalid");
    return this.#remember(key, validTurn(value, id));
  }

  #remember(key, turn) {
    this.#turns.delete(key);
    this.#turns.set(key, turn);
    while (this.#turns.size > CLAUDE_CODE_SESSION_LIMITS.cachedTurns) this.#turns.delete(this.#turns.keys().next().value);
    return turn;
  }

  /** Runs one change of one session after the previous one finished. */
  #serial(sessionId, action) {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.#queues.set(sessionId, next);
    return next.finally(() => { if (this.#queues.get(sessionId) === next) this.#queues.delete(sessionId); });
  }

  async #storeSession(session) {
    await writeAtomic(this.#sessionFile(session.sessionId), session, CLAUDE_CODE_SESSION_LIMITS.sessionBytes);
    this.#sessions.set(session.sessionId, session);
  }

  async #names() {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && UUID.test(entry.name)).map((entry) => entry.name);
  }

  async create({ sessionId, cwd, atUtc }) {
    claudeSessionId(sessionId);
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) fail("claude_cwd_invalid");
    return this.#serial(sessionId, async () => {
      if (await this.#loadSession(sessionId) !== null) fail("claude_session_exists");
      if ((await this.#names()).length >= CLAUDE_CODE_SESSION_LIMITS.sessions) fail("claude_journal_full");
      await mkdir(path.join(this.#folder(sessionId), "turns"), { recursive: true });
      const session = { schemaVersion: 1, contractVersion: CLAUDE_CODE_SESSION_JOURNAL_VERSION, sessionId, cwd,
        createdAtUtc: atUtc, updatedAtUtc: atUtc, providerStarted: false, usage: null, turnIds: [], droppedTurns: 0 };
      await this.#storeSession(session);
      return structuredClone(session);
    });
  }

  /** The session's metadata and the order of its kept turns; null when unknown. */
  async readSession(sessionId) {
    claudeSessionId(sessionId);
    const session = await this.#loadSession(sessionId);
    return session === null ? null : structuredClone(session);
  }

  async readTurn(sessionId, id) {
    const session = await this.#loadSession(claudeSessionId(sessionId));
    if (session === null || !session.turnIds.includes(id)) return null;
    return structuredClone(await this.#loadTurn(sessionId, id));
  }

  /** Kept turns `start` to `end` (exclusive), oldest first. */
  async readTurns(sessionId, start = 0, end = undefined) {
    const session = await this.#loadSession(claudeSessionId(sessionId));
    if (session === null) fail("thread_not_found");
    const turns = [];
    for (const id of session.turnIds.slice(start, end)) turns.push(structuredClone(await this.#loadTurn(sessionId, id)));
    return turns;
  }

  async updateSession(sessionId, change) {
    claudeSessionId(sessionId);
    return this.#serial(sessionId, async () => {
      const current = await this.#loadSession(sessionId);
      if (current === null) fail("thread_not_found");
      const next = structuredClone(current);
      const result = await change(next);
      await this.#storeSession(validSession(next, sessionId));
      return result;
    });
  }

  /** Adds a turn; the oldest finished turns beyond the kept number leave the journal. */
  async appendTurn(sessionId, turn, atUtc) {
    claudeSessionId(sessionId);
    turnId(turn.id);
    return this.#serial(sessionId, async () => {
      const current = await this.#loadSession(sessionId);
      if (current === null) fail("thread_not_found");
      const next = structuredClone(current);
      if (next.turnIds.includes(turn.id)) fail("claude_turn_exists");
      // The turns folder of a session that never ran is empty, and a project
      // package carries files only: after a mount it is not there.
      await mkdir(path.dirname(this.#turnFile(sessionId, turn.id)), { recursive: true })
        .catch(() => fail("claude_journal_unavailable"));
      await writeAtomic(this.#turnFile(sessionId, turn.id), turn, CLAUDE_CODE_SESSION_LIMITS.turnBytes);
      this.#remember(`${sessionId}:${turn.id}`, structuredClone(turn));
      next.turnIds.push(turn.id);
      const dropped = next.turnIds.splice(0, Math.max(0, next.turnIds.length - this.#keptTurns));
      next.droppedTurns += dropped.length;
      next.updatedAtUtc = atUtc;
      await this.#storeSession(next);
      for (const id of dropped) {
        this.#turns.delete(`${sessionId}:${id}`);
        await rm(this.#turnFile(sessionId, id), { force: true }).catch(() => undefined);
      }
      return structuredClone(next);
    });
  }

  /** Applies `change(turn, session)` to copies and stores both; returns what `change` returned. */
  async updateTurn(sessionId, id, change, atUtc) {
    claudeSessionId(sessionId);
    return this.#serial(sessionId, async () => {
      const session = await this.#loadSession(sessionId);
      if (session === null || !session.turnIds.includes(id)) fail("claude_turn_not_found");
      const turn = structuredClone(await this.#loadTurn(sessionId, id));
      const nextSession = structuredClone(session);
      const result = await change(turn, nextSession);
      validTurn(turn, id);
      await writeAtomic(this.#turnFile(sessionId, id), turn, CLAUDE_CODE_SESSION_LIMITS.turnBytes);
      this.#remember(`${sessionId}:${id}`, turn);
      nextSession.updatedAtUtc = atUtc;
      await this.#storeSession(validSession(nextSession, sessionId));
      return result;
    });
  }

  // --- trace --------------------------------------------------------------------------

  #traceQueues = new Map();
  #traceState = new Map();

  async #traceGenerations(sessionId) {
    let entries;
    try { entries = await readdir(this.#folder(sessionId)); } catch (error) {
      if (error.code === "ENOENT") return [];
      fail("claude_journal_unavailable");
    }
    return entries.map((name) => TRACE_FILE.exec(name)).filter(Boolean).map((match) => Number(match[1]))
      .sort((left, right) => left - right);
  }

  /**
   * Appends one record to the session's trace. Appends of a session are
   * ordered; they do not wait for turn writes. No fsync: the trace is the
   * owner's record of what happened, and a crash may lose its last lines, never
   * the chat's journal.
   */
  async appendTrace(sessionId, record) {
    claudeSessionId(sessionId);
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (line.byteLength > CLAUDE_CODE_TRACE_LIMITS.recordBytes) fail("claude_trace_record_too_large");
    const previous = this.#traceQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      let state = this.#traceState.get(sessionId);
      if (state === undefined) {
        const generations = await this.#traceGenerations(sessionId);
        const generation = generations.at(-1) ?? 1;
        let size = 0;
        try { size = (await lstat(path.join(this.#folder(sessionId), traceName(generation)))).size; } catch { size = 0; }
        state = { generation, size };
        this.#traceState.set(sessionId, state);
      }
      if (state.size > 0 && state.size + line.byteLength > CLAUDE_CODE_TRACE_LIMITS.fileBytes) {
        state.generation += 1;
        state.size = 0;
        for (const old of await this.#traceGenerations(sessionId)) {
          if (old <= state.generation - CLAUDE_CODE_TRACE_LIMITS.keptFiles) {
            await rm(path.join(this.#folder(sessionId), traceName(old)), { force: true }).catch(() => undefined);
          }
        }
      }
      const handle = await open(path.join(this.#folder(sessionId), traceName(state.generation)), "a");
      try { await handle.writeFile(line); } finally { await handle.close(); }
      state.size += line.byteLength;
    });
    this.#traceQueues.set(sessionId, next);
    return next.finally(() => { if (this.#traceQueues.get(sessionId) === next) this.#traceQueues.delete(sessionId); });
  }

  /**
   * One page of the trace, oldest record first. Without a cursor: the newest
   * records. `before`: the records that end at that cursor (older). `after`:
   * the records written since that cursor (newer). Cursors are
   * "<generation>:<byte offset>"; a cursor into a file that rotated away
   * continues at the oldest kept record and says so (`gap`).
   */
  async readTrace(sessionId, { before = null, after = null, maxBytes = CLAUDE_CODE_TRACE_LIMITS.pageBytes } = {}) {
    claudeSessionId(sessionId);
    if (before !== null && after !== null) fail("claude_trace_cursor_invalid");
    // A page always fits the largest record, so a read always moves on.
    const budget = Math.min(Math.max(Number.isSafeInteger(maxBytes) ? maxBytes : 0, CLAUDE_CODE_TRACE_LIMITS.recordBytes),
      CLAUDE_CODE_TRACE_LIMITS.pageBytes);
    const generations = await this.#traceGenerations(sessionId);
    const empty = { records: [], beforeCursor: null, afterCursor: null, gap: false, exhausted: true };
    if (generations.length === 0) return { ...empty, afterCursor: after ?? null };
    const sizeOf = async (generation) => {
      try { return (await lstat(path.join(this.#folder(sessionId), traceName(generation)))).size; } catch { return 0; }
    };
    const readRange = async (generation, start, end) => {
      const handle = await open(path.join(this.#folder(sessionId), traceName(generation)), "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        return buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    };
    const oldest = generations[0];
    const newest = generations.at(-1);
    if (after !== null) {
      let { generation, offset } = traceCursor(after);
      let gap = false;
      if (generation < oldest) { generation = oldest; offset = 0; gap = true; }
      if (generation > newest) return { ...empty, afterCursor: after };
      let size = await sizeOf(generation);
      if (offset > size) { offset = 0; gap = true; }
      // A finished file is read to its end before the next one.
      if (offset === size && generation < newest) { generation += 1; offset = 0; size = await sizeOf(generation); }
      const buffer = await readRange(generation, offset, Math.min(size, offset + budget));
      const lines = traceLines(buffer, false).slice(0, CLAUDE_CODE_TRACE_LIMITS.pageRecords);
      const nextOffset = offset + (lines.at(-1)?.end ?? 0);
      return { records: lines.map((line) => line.record), beforeCursor: `${generation}:${offset}`,
        afterCursor: `${generation}:${nextOffset}`, gap, exhausted: generation === newest && nextOffset >= size };
    }
    let generation = newest;
    let end = await sizeOf(newest);
    let gap = false;
    if (before !== null) {
      ({ generation, offset: end } = traceCursor(before));
      if (generation < oldest) return { ...empty, gap: true };
      if (generation > newest) { generation = newest; end = await sizeOf(newest); }
      if (end === 0 && generation > oldest) { generation -= 1; end = await sizeOf(generation); }
      end = Math.min(end, await sizeOf(generation));
    }
    const start = Math.max(0, end - budget);
    const buffer = await readRange(generation, start, end);
    const lines = traceLines(buffer, start > 0).slice(-CLAUDE_CODE_TRACE_LIMITS.pageRecords);
    const first = start + (lines[0]?.start ?? buffer.length);
    const last = start + (lines.at(-1)?.end ?? 0);
    return { records: lines.map((line) => line.record),
      beforeCursor: first > 0 || generation > oldest ? `${generation}:${first}` : null,
      afterCursor: before === null ? `${generation}:${lines.length > 0 ? last : end}` : null, gap,
      exhausted: first === 0 && generation === oldest };
  }

  async list() {
    const sessions = [];
    for (const name of await this.#names()) {
      const session = await this.#loadSession(name).catch(() => null);
      if (session !== null) sessions.push(structuredClone(session));
    }
    return sessions.sort((left, right) => right.updatedAtUtc.localeCompare(left.updatedAtUtc));
  }

  /**
   * A turn still marked as running when the Gateway starts belonged to a
   * process that is gone with the previous Gateway. It is recorded as
   * interrupted, with the reason; it is never run again from here. One writer
   * per session means only a session's last turn can be unfinished.
   */
  async recover(atUtc) {
    let recovered = 0;
    for (const name of await this.#names()) {
      const session = await this.#loadSession(name).catch(() => null);
      const last = session?.turnIds.at(-1);
      if (!last) continue;
      const turn = await this.#loadTurn(name, last).catch(() => null);
      if (turn === null || TERMINAL.has(turn.status)) continue;
      await this.updateTurn(name, last, (next) => {
        Object.assign(next, { status: "interrupted", recovery: "gateway_restarted" });
        for (const item of next.items) if (item.status === "inProgress") item.status = "interrupted";
      }, atUtc);
      recovered += 1;
    }
    return recovered;
  }
}

/**
 * The journal of a controller. `folder` names its folder under
 * `.project-local/orchestration`: the desk's agents use `claude-sessions`,
 * one-off service turns (review, summary) a folder of their own.
 */
export async function createClaudeCodeSessionJournal({ controllerRoot,
  keptTurns = CLAUDE_CODE_SESSION_LIMITS.keptTurns, folder = "claude-sessions" }) {
  if (!Number.isSafeInteger(keptTurns) || keptTurns < 1 || keptTurns > CLAUDE_CODE_SESSION_LIMITS.keptTurns) {
    fail("claude_journal_invalid");
  }
  if (typeof folder !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(folder)) fail("claude_journal_invalid");
  const root = await realpath(controllerRoot);
  const directory = path.join(root, ".project-local", "orchestration", folder);
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  const relative = path.relative(root, canonical);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fail("claude_journal_unavailable");
  }
  return new ClaudeCodeSessionJournal(canonical, keptTurns);
}

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { renameOver } from "./rename-over.mjs";

// The Claude plan's usage windows, as Claude Code's /usage shows them: the
// 5-hour session, the week, and the per-model weekly limits. The session host
// reads them from a turn that is running anyway (no session is started for
// it, and no model call is made: the SDK asks the claude.ai usage endpoint)
// and from the rate-limit events of turns. The last reading is kept in a
// machine-local file the window reads; it holds percentages and times only.

export const CLAUDE_USAGE_VERSION = "v0.1.0";
export const CLAUDE_USAGE_PATH = path.join(".project-local", "application-gateway", "claude-usage.v1.json");

// The fixed windows of a plan, in the order Claude Code shows them. Labels are English; the window
// shows them in the person's language by `id` (Atlas locales).
const WINDOWS = Object.freeze([["five_hour", "Session (5 h)"], ["seven_day", "Week (7 days)"],
  ["seven_day_opus", "Opus · week"], ["seven_day_sonnet", "Sonnet · week"]]);
const RATE_LIMIT_STATUS = new Set(["allowed", "allowed_warning", "rejected"]);

const percent = (value) => (typeof value === "number" && Number.isFinite(value)
  ? Math.min(100, Math.max(0, Math.round(value * 10) / 10)) : null);
const time = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value))
  ? new Date(value).toISOString() : null);
const label = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 64) : "");

/**
 * The answer of the SDK's usage request, as a snapshot: the plan, whether plan
 * limits apply, and each known window ({id, label, utilization 0-100 | null,
 * resetsAtUtc | null}). Null when the answer is not one.
 */
export function normalizeClaudeUsage(answer, observedAtUtc) {
  if (!answer || typeof answer !== "object") return null;
  const limits = answer.rate_limits && typeof answer.rate_limits === "object" ? answer.rate_limits : null;
  const windows = [];
  for (const [id, words] of WINDOWS) {
    const window = limits?.[id];
    if (!window || typeof window !== "object") continue;
    windows.push({ id, label: words, utilization: percent(window.utilization), resetsAtUtc: time(window.resets_at),
      status: null });
  }
  for (const model of Array.isArray(limits?.model_scoped) ? limits.model_scoped.slice(0, 8) : []) {
    const name = label(model?.display_name);
    if (name === "") continue;
    windows.push({ id: `model:${name}`, label: `${name} · limit`, utilization: percent(model.utilization),
      resetsAtUtc: time(model.resets_at), status: null });
  }
  return {
    schemaVersion: 1, contractVersion: CLAUDE_USAGE_VERSION, observedAtUtc: time(observedAtUtc),
    subscriptionType: typeof answer.subscription_type === "string" ? label(answer.subscription_type) : null,
    available: answer.rate_limits_available === true, windows,
  };
}

/**
 * A rate-limit event of a turn: the status of one window (allowed, close to
 * the limit, refused) and when it resets. It marks the window in the last
 * snapshot, or starts one.
 */
export function applyRateLimitEvent(snapshot, info, observedAtUtc) {
  if (!info || typeof info !== "object" || !RATE_LIMIT_STATUS.has(info.status)) return snapshot;
  const id = typeof info.rateLimitType === "string" ? label(info.rateLimitType) : null;
  if (id === null || id === "") return snapshot;
  const next = snapshot === null
    ? { schemaVersion: 1, contractVersion: CLAUDE_USAGE_VERSION, observedAtUtc: time(observedAtUtc),
      subscriptionType: null, available: true, windows: [] }
    : structuredClone(snapshot);
  const resetsAtUtc = Number.isFinite(info.resetsAt) ? new Date(info.resetsAt * 1000).toISOString() : null;
  const known = next.windows.find((window) => window.id === id);
  const words = WINDOWS.find(([windowId]) => windowId === id)?.[1] ?? id;
  if (known) {
    known.status = info.status;
    if (resetsAtUtc !== null) known.resetsAtUtc = resetsAtUtc;
  } else {
    next.windows.push({ id, label: words, utilization: null, resetsAtUtc, status: info.status });
  }
  next.statusObservedAtUtc = time(observedAtUtc);
  return next;
}

/** Keeps the snapshot for the window: written whole, then moved over the old one. */
export async function writeClaudeUsage(repoRoot, snapshot) {
  const file = path.join(repoRoot, CLAUDE_USAGE_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    // The window may be reading the old file: renameOver waits out a short lock.
    await renameOver(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

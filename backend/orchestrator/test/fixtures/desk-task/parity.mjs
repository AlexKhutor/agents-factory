import assert from "node:assert/strict";

import { restore, snapshot } from "./harness.mjs";

// Parity of one step of the desk task chain: the step runs with PowerShell,
// the folder is put back, the step runs with Node, and the two resulting
// folders are compared byte for byte. What legitimately differs is
// normalized here, and only that:
// - the time a contract file records: Node replays the times PowerShell wrote
//   (a replay clock), so these files and every hash over them stay exact;
// - a tool's own log (logs/<tool>.log): PowerShell's transcript against
//   Node's line log; only that it exists is compared;
// - a tool's run report (logs/<tool>.report.json): run times, duration, the
//   machine block and the PowerShell error decoration are dropped, the rest
//   (tool, versions, status, exit code, parameters, result, error message)
//   is compared;
// - the time stamp in the name of a rotated log (logs/old/<tool>-<stamp>.*);
// - the random folder name of a kit backup (child-kit-backups/<id>/<guid>).

const STAMP = /\d{8}T\d{9}Z/gu;

function normalizedName(name) {
  return name.replace(/(child-kit-backups\/[^/]+\/)[0-9a-f]{32}(\/|$)/u, "$1<guid>$2")
    .replace(/(^|\/)logs\/old\/(.+)-\d{8}T\d{9}Z(\.log|\.report\.json)$/u, "$1logs/old/$2-<stamp>$3")
    .replace(/(^|\/)logs\/(.+)-\d{8}T\d{9}Z(\.log|\.report\.json)$/u, "$1logs/$2-<stamp>$3");
}

/** A tool run report without what differs between two runs of the same step. */
export function normalizedToolReport(bytes) {
  const report = JSON.parse(bytes.toString("utf8"));
  for (const key of ["startedAtUtc", "finishedAtUtc", "durationMs", "machine", "transcriptStartAttempts"]) delete report[key];
  for (const key of ["logPath", "reportPath"]) if (typeof report[key] === "string") report[key] = report[key].replace(STAMP, "<stamp>");
  if (report.error) report.error = { message: report.error.message };
  return JSON.stringify(report, null, 2).replace(/(child-kit-backups(?:\\\\|\/)+[^\\/"]+(?:\\\\|\/)+)[0-9a-f]{32}/gu, "$1<guid>");
}

function comparable(name, bytes) {
  if (bytes === null) return "<folder>";
  if (/(^|\/)logs\/(old\/)?[^/]+\.log$/u.test(name)) return "<tool log>";
  if (/(^|\/)logs\/(old\/)?[^/]+\.report\.json$/u.test(name)) return normalizedToolReport(bytes);
  return bytes.toString("hex");
}

/** name -> sorted list of comparable contents (a normalized name can stand for several files). */
function normalized(files) {
  const map = new Map();
  for (const [name, bytes] of files) {
    const key = normalizedName(name);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(comparable(name, bytes));
  }
  for (const list of map.values()) list.sort();
  return map;
}

function preview(name, value) {
  if (value === "<folder>" || value === "<tool log>") return value;
  if (/\.report\.json$/u.test(name)) return value;
  const text = Buffer.from(value, "hex").toString("utf8");
  return text.length > 6000 ? `${text.slice(0, 6000)}...` : text;
}

/** Asserts that two folder snapshots are the same after normalization. */
export function assertSameTree(expected, actual, label) {
  const left = normalized(expected);
  const right = normalized(actual);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const name of names) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a) assert.fail(`${label}: only Node wrote ${name}`);
    if (!b) assert.fail(`${label}: only PowerShell wrote ${name}`);
    if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
      assert.equal(b.map((value) => preview(name, value)).join("\n----\n"),
        a.map((value) => preview(name, value)).join("\n----\n"), `${label}: ${name} differs (Node vs PowerShell)`);
    }
  }
}

/** A clock that returns the given times in order and fails on any other call. */
export function replayClock(times) {
  const queue = times.map((time) => (time instanceof Date ? time : new Date(time)));
  const clock = () => {
    if (queue.length === 0) throw new Error("The Node step asked for more times than the PowerShell step recorded.");
    return queue.shift();
  };
  clock.remaining = () => queue.length;
  return clock;
}

export const jsonAt = (files, name) => {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Expected ${name} after the PowerShell step.`);
  return JSON.parse(bytes.toString("utf8"));
};

/** The time of a compact stamp (yyyyMMddTHHmmssfffZ). */
export function stampTime(stamp) {
  const [, y, mo, d, h, mi, s, ms] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(stamp);
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)));
}

/**
 * One parity step in `root`: `powershell()` runs the step with PowerShell
 * (returns { code, output }), `times(files)` reads the times it recorded,
 * `node(clock)` runs the step with Node. The trees must match; so must the
 * outcome (success or refusal) and, for a refusal, Node's message must be
 * PowerShell's. Returns both outcomes; the folder keeps Node's result.
 */
export async function parityStep({ root, label, powershell, node, times = () => [] }) {
  const before = await snapshot(root);
  const ps = await powershell();
  const afterPowerShell = await snapshot(root);
  const clock = replayClock(await times(afterPowerShell, ps));
  await restore(root, before);
  const js = await node(clock);
  const afterNode = await snapshot(root);
  assert.equal(js.code === 0, ps.code === 0,
    `${label}: Node ${js.code === 0 ? "succeeded" : "refused"}, PowerShell ${ps.code === 0 ? "succeeded" : "refused"}\n`
    + `PowerShell: ${String(ps.output).slice(-3000)}\nNode: ${String(js.output).slice(-3000)}`);
  if (js.code !== 0) {
    const message = js.error?.message ?? /ERROR: (.*)$/u.exec(js.output)?.[1] ?? "";
    assert.ok(message && String(ps.output).replace(/\s+/gu, " ").includes(message.replace(/\s+/gu, " ")),
      `${label}: PowerShell did not refuse with Node's message "${message}"\nPowerShell: ${String(ps.output).slice(-3000)}`);
  }
  assert.equal(clock.remaining(), 0, `${label}: Node used fewer recorded times than PowerShell wrote`);
  assertSameTree(afterPowerShell, afterNode, label);
  return { powershell: ps, node: js };
}

export { restore, snapshot };

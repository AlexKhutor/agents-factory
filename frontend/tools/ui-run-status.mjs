// The UI pack's status file, written by the runner itself.
//
// An operator's status surface (tools/ui-status-server.mjs) reads this file:
// run identity, the command and source it runs, the phase, the current scene
// and attempt, when it started and was last updated, every scene's result and
// the final exit. Each write replaces the file atomically (temporary file,
// then rename), so a reader never sees a half-written state. The file holds no
// backend data and no secret: scene names, statuses, times and an exit code.

import { renameSync, rmSync, writeFileSync } from "node:fs";

const RENAME_ATTEMPTS = 10;
const RENAME_PAUSE_MS = 25;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

export function createRunStatus({ file, runId, command, source, sceneNames, now = () => new Date() }) {
  const state = {
    format: "atlas-ui-run-status/1",
    runId,
    command,
    source,
    total: sceneNames.length,
    phase: "ready",
    status: "waiting",
    current: null,
    startedAtUtc: null,
    updatedAtUtc: null,
    finishedAtUtc: null,
    elapsedMs: null,
    exitCode: null,
    sequence: 0,
    scenes: sceneNames.map((name) => ({ name, status: "pending", attempts: 0 })),
    counts: { passed: 0, failed: 0, skipped: 0, pending: sceneNames.length },
  };

  function write() {
    const at = now();
    state.sequence += 1;
    state.updatedAtUtc = at.toISOString();
    state.elapsedMs = state.startedAtUtc === null ? null : at.getTime() - Date.parse(state.startedAtUtc);
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0, running: 0 };
    for (const scene of state.scenes) counts[scene.status] = (counts[scene.status] ?? 0) + 1;
    state.counts = counts;
    const temporary = `${file}.${process.pid}.tmp`;
    // On Windows a file a reader has open cannot be replaced (EPERM): the checks window
    // (test-monitor.cjs) reads it twice a second. A few tries, then this state is skipped -
    // the next one is written; the status is a side channel and never fails the run.
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 1)}\n`);
      for (let attempt = 1; ; attempt += 1) {
        try {
          renameSync(temporary, file);
          return;
        } catch (error) {
          if (attempt >= RENAME_ATTEMPTS || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
          Atomics.wait(PAUSE, 0, 0, RENAME_PAUSE_MS);
        }
      }
    } catch {
      try { rmSync(temporary, { force: true }); } catch { /* the next write replaces it */ }
    }
  }

  const sceneNamed = (name) => state.scenes.find((scene) => scene.name === name);

  return {
    /** Before the run: identity and command are visible, nothing has started. */
    prepare() {
      write();
    },
    start() {
      state.phase = "running";
      state.status = "running";
      state.startedAtUtc = now().toISOString();
      write();
    },
    /** A scene attempt begins. */
    scene(index, name, attempt) {
      state.current = { index, name, attempt };
      const scene = sceneNamed(name);
      if (scene !== undefined) {
        scene.status = "running";
        scene.attempts = attempt;
      }
      write();
    },
    result(name, status) {
      const scene = sceneNamed(name);
      if (scene !== undefined) scene.status = status;
      write();
    },
    /** Keeps "updated" fresh while one scene runs long. */
    heartbeat() {
      write();
    },
    finish({ status, exitCode }) {
      state.phase = "finished";
      state.status = status;
      state.exitCode = exitCode;
      state.current = null;
      state.finishedAtUtc = now().toISOString();
      write();
    },
  };
}

// Starts the checks window (tools/test-monitor.cjs) for a test run: on Windows, not in CI,
// unless the run says --no-monitor. The window reads the run's status file
// (tools/ui-run-status.mjs format); it outlives the run and goes away by itself.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Whether this run shows the checks window. */
export const monitorWanted = (argv = process.argv) => process.platform === "win32" && !process.env.CI
  && !argv.includes("--no-monitor");

/** A status file for a run that was given none. */
export const monitorStatusFile = (name) => path.join(os.tmpdir(), `atlas-checks-${name}-${process.pid}.json`);

/** Opens the checks window on `statusFile` (or hands it to the one already open); false without Electron. */
export function startTestMonitor({ statusFile, label }) {
  const electron = path.join(PROJECT_ROOT, "node_modules", "electron", "dist", "electron.exe");
  if (!existsSync(electron)) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(PROJECT_ROOT, "tools", "test-monitor.cjs"), "--status-file", statusFile,
    "--label", label], { detached: true, stdio: "ignore", env });
  child.unref();
  return true;
}

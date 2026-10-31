import { spawnSync } from "node:child_process";
import nodeTest from "node:test";

import { loadNodeSqlite } from "../../../src/sqlite-backend.mjs";

// Store tests run once per SQLite implementation: node:sqlite in the test
// process and the Python bridges. A backend this machine does not have is
// skipped with a reason, never silently replaced by the other one.

export const SQLITE_TEST_BACKENDS = Object.freeze(["node", "python"]);

const backends = new WeakMap();

let pythonAvailable;
function hasPython() {
  pythonAvailable ??= spawnSync(process.env.PYTHON || "python", ["-c", "import sqlite3"], {
    windowsHide: true, stdio: "ignore",
  }).status === 0;
  return pythonAvailable;
}

const nodeSqlite = await loadNodeSqlite();

/** Why `backend` cannot run here, or null. */
export function sqliteBackendUnavailable(backend) {
  if (backend === "node" && nodeSqlite === null) return "node:sqlite is not available in this Node";
  if (backend === "python" && !hasPython()) return "Python 3 with sqlite3 is not available";
  return null;
}

/**
 * test() once per backend, named "<name> [sqlite: <backend>]". The body gets
 * the usual test context; sqliteBackendOf(t) names its backend.
 */
export function sqliteBackendTest(name, options, body) {
  const [settings, run] = typeof options === "function" ? [{}, options] : [options ?? {}, body];
  for (const backend of SQLITE_TEST_BACKENDS) {
    const skip = settings.skip ?? sqliteBackendUnavailable(backend) ?? false;
    nodeTest(`${name} [sqlite: ${backend}]`, { ...settings, skip }, (t, ...rest) => {
      backends.set(t, backend);
      return run(t, ...rest);
    });
  }
}

/** The backend of a test declared with sqliteBackendTest (its own context). */
export function sqliteBackendOf(t) {
  const backend = backends.get(t);
  if (backend === undefined) throw new Error("sqliteBackendOf: not the context of a sqliteBackendTest");
  return backend;
}

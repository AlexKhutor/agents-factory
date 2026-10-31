import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveSqliteBackend, sqliteBackendOption } from "./sqlite-backend.mjs";
import { readControlSnapshot } from "./sqlite-control-snapshot-reader-node.mjs";

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRIDGE = path.join(CURRENT_DIRECTORY, "sqlite-control-snapshot-reader.py");
const MAX_BRIDGE_OUTPUT_BYTES = 4 * 1024 * 1024;
// The node:sqlite implementation replaces this script only.
const NODE_IMPLEMENTED_BRIDGE = "sqlite-control-snapshot-reader.py";

function commandParts(value) {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["python"];
}

function bridgeError(code, stderr, stdout) {
  let detail = stderr.trim();
  let reasonCode = "CONTROL_SNAPSHOT_READ_FAILED";
  try {
    const parsed = JSON.parse(detail.split(/\r?\n/).filter(Boolean).at(-1));
    if (parsed?.error) detail = parsed.error;
    if (parsed?.code) reasonCode = parsed.code;
  } catch {
    // Preserve bounded stderr when the bridge could not emit JSON.
  }
  const error = new Error(`SQLite control snapshot read failed (${code}): ${detail || "no error detail"}`);
  error.code = reasonCode;
  error.exitCode = code;
  error.stderr = stderr;
  error.stdout = stdout;
  return error;
}

/** The snapshot in node:sqlite, failing as the script did (its JSON error line in stderr). */
function snapshotInNode(sqlite, databasePath, options) {
  try {
    return readControlSnapshot(sqlite, databasePath, options);
  } catch (error) {
    // Only the reader's own failures carry a code; anything else is a read failure.
    const code = typeof error?.code === "string" && error.code.startsWith("CONTROL_SNAPSHOT_")
      ? error.code : "CONTROL_SNAPSHOT_READ_FAILED";
    const message = String(error?.message ?? error);
    // Python writes text output with the platform's line endings.
    const newline = process.platform === "win32" ? "\r\n" : "\n";
    throw bridgeError(1, `{"ok": false, "code": ${JSON.stringify(code)}, "error": ${JSON.stringify(message)}}${newline}`, "");
  }
}

export class SqliteControlSnapshotReader {
  #backend = null;

  /**
   * `sqliteBackend` ("node" | "python") overrides AGENTS_FACTORY_SQLITE and
   * the default (node:sqlite when this runtime has it, else Python).
   */
  constructor({
    databasePath,
    pythonCommand = process.env.PYTHON || "python",
    bridgePath = DEFAULT_BRIDGE,
    timeoutMs = 30_000,
    sqliteBackend,
  }) {
    if (!databasePath) throw new Error("SqliteControlSnapshotReader requires databasePath");
    this.databasePath = path.resolve(databasePath);
    this.pythonCommand = commandParts(pythonCommand);
    this.bridgePath = path.resolve(bridgePath);
    this.timeoutMs = timeoutMs;
    this.requestedSqliteBackend = path.basename(this.bridgePath) === NODE_IMPLEMENTED_BRIDGE
      ? sqliteBackendOption(sqliteBackend)
      : "python";
  }

  /** "node" or "python": the implementation this reader uses. */
  async sqliteBackend() {
    return (await this.#resolved()).backend;
  }

  #resolved() {
    this.#backend ??= resolveSqliteBackend({ backend: this.requestedSqliteBackend ?? undefined });
    return this.#backend;
  }

  async snapshot(options = {}) {
    const { backend, sqlite } = await this.#resolved();
    if (backend === "node") return snapshotInNode(sqlite, this.databasePath, options);
    return this.#invoke(options);
  }

  #invoke(payload) {
    return new Promise((resolve, reject) => {
      const [executable, ...prefixArguments] = this.pythonCommand;
      const child = spawn(executable, [
        ...prefixArguments,
        this.bridgePath,
        "--database",
        this.databasePath,
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        const error = new Error(
          `SQLite control snapshot read timed out after ${this.timeoutMs} ms`,
        );
        error.code = "CONTROL_SNAPSHOT_READ_TIMEOUT";
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();

      const append = (current, chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_BRIDGE_OUTPUT_BYTES) {
          child.kill();
          const error = new Error("SQLite control snapshot exceeded output budget");
          error.code = "CONTROL_SNAPSHOT_OUTPUT_EXCEEDED";
          throw error;
        }
        return current + chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk) => {
        try {
          stdout = append(stdout, chunk);
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = append(stderr, chunk);
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        }
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error.code = error.code ?? "CONTROL_SNAPSHOT_READ_START_FAILED";
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(bridgeError(code, stderr, stdout));
          return;
        }
        try {
          const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
          const response = JSON.parse(line);
          if (!response?.ok) throw new Error(response?.error || "SQLite reader returned no result");
          resolve(response.result);
        } catch (error) {
          error.code = "CONTROL_SNAPSHOT_READ_RESPONSE_INVALID";
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }
}

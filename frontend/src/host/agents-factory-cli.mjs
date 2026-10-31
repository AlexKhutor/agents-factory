// Finding and running the `agents-factory` CLI. Host process only.
//
// The CLI is the product's own command line (workstream B of stage 0): it
// starts and stops the Gateway, keeps the Anthropic API key in the operating
// system's store and installs the autostart service. Atlas runs it as a child
// process and reads one JSON object from its stdout.
//
// Rules this module keeps:
//   - the page never names an executable or a path: both are resolved here,
//     from the host's own configuration;
//   - arguments go as an array (no shell), so nothing can become shell syntax;
//   - a secret goes only through stdin - never argv (other processes can read
//     a command line) and never the environment - and is not kept after the
//     write; if the CLI ever echoes it, its whole output is dropped;
//   - output is bounded, and only named, pattern-checked fields leave this
//     module. Free text (`message`, stderr) never does: it may carry a path.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 8192;
// After the process exits, its pipes normally close at once. A child it left
// running in the background may still hold them; the answer is already written
// by then, so it is read without waiting for that child.
const CLOSE_GRACE_MS = 500;

/** Where the CLI is looked for, by source, in order. */
export const AGENTS_FACTORY_CLI = Object.freeze({
  controllerRelative: path.join(".orchestrator", "runtime", "agents-factory.mjs"),
  // From the frontend folder of this repository to the backend's build output.
  developmentRelative: path.join("..", "backend", "orchestrator", "dist", "agents-factory-cli.bundle.mjs"),
});

/**
 * The backend's development build is a fallback of a source checkout only: a
 * packaged application (its code inside app.asar) never looks for it.
 */
export function developmentBuildAllowed(applicationRoot) {
  return typeof applicationRoot === "string" && !applicationRoot.split(/[\\/]/u).includes("app.asar");
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * The CLI script to run, or why there is none. A script named in the
 * configuration is the only one tried when it is named: a wrong setting is
 * reported, not silently replaced by another CLI.
 *
 * @param controllerRoot  the configured controller (the CLI's `--instance`)
 * @param configured      `agentsFactoryCli.script` of config/local.json, or null;
 *                        relative paths are taken from the controller root
 * @param applicationRoot the frontend folder, for the development build
 * @param development     whether the development build may be used (never in a
 *                        packaged application, never in the fixture)
 */
export async function resolveAgentsFactoryCli({
  controllerRoot, configured = null, applicationRoot = null, development = false,
}) {
  if (typeof configured === "string" && configured.trim() !== "") {
    const script = path.resolve(controllerRoot, configured);
    return await isFile(script)
      ? { found: true, script, source: "configured" }
      : { found: false, source: "configured", reasonCode: "agents_factory_cli_missing" };
  }
  const inController = path.join(controllerRoot, AGENTS_FACTORY_CLI.controllerRelative);
  if (await isFile(inController)) return { found: true, script: inController, source: "controller" };
  if (development && typeof applicationRoot === "string") {
    const built = path.resolve(applicationRoot, AGENTS_FACTORY_CLI.developmentRelative);
    if (await isFile(built)) return { found: true, script: built, source: "development" };
  }
  return { found: false, source: null, reasonCode: "agents_factory_cli_missing" };
}

/**
 * How the CLI is started: a configured Node, or this Electron binary run as
 * Node (ELECTRON_RUN_AS_NODE). Under plain Node (the tests) `process.execPath`
 * is Node itself and the variable is ignored.
 */
export function cliLauncher(nodeExecutable = null) {
  if (typeof nodeExecutable === "string" && nodeExecutable.trim() !== "") {
    return { executable: nodeExecutable, env: { ...process.env } };
  }
  return { executable: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/**
 * Runs the CLI once. `secret`, when given, is written to stdin and stdin is
 * closed; nothing else is ever written there. Resolves to
 * {status: "exited", exitCode, stdout} or {status: <why not>} - never throws,
 * and never returns stderr (only its size is known to the caller: nothing).
 */
export function runAgentsFactory({ launcher, script, args, cwd, secret = null, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launcher.executable, [script, ...args], {
        cwd, env: launcher.env, shell: false, windowsHide: true,
        stdio: [secret === null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ status: "spawn_failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    let exitCode = null;
    let graceTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      // A CLI that printed the secret back has its output dropped whole: no
      // part of it may reach the page, the journal or a log.
      const echoed = secret !== null && secret !== ""
        && (stdout.includes(secret) || stderr.includes(secret));
      stdout = "";
      stderr = "";
      resolve(echoed ? { status: "secret_echoed" } : value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: "timeout" });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish({ status: "output_too_large" });
        return;
      }
      stdout += chunk;
    });
    // Kept only so an echoed secret can be detected; never returned.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });
    child.on("error", () => finish({ status: "spawn_failed" }));
    child.on("exit", (code) => {
      exitCode = code;
      graceTimer = setTimeout(() => finish({ status: "exited", exitCode, stdout }), CLOSE_GRACE_MS);
    });
    child.on("close", (code) => finish({ status: "exited", exitCode: exitCode ?? code, stdout }));

    if (secret !== null) {
      // A CLI that exits before reading stdin closes the pipe: that is its answer
      // to give on stdout, not a host fault.
      child.stdin.on("error", () => {});
      child.stdin.end(secret, "utf8");
    }
  });
}

const word = (value) => (typeof value === "string" && WORD.test(value) ? value : null);

/** The one JSON object the CLI printed: the whole of stdout, or else its last line. */
function jsonObjectOf(stdout) {
  const text = String(stdout ?? "").trim();
  const parse = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  return parse(text) ?? parse(text.split(/\r?\n/u).at(-1) ?? "");
}

/**
 * The CLI's answer as {ok: true, value} or {ok: false, error}. A failure keeps
 * only the CLI's own code (`code`, a token) and the exit code; `message` is free
 * text and is not carried. `uncertain` marks an outcome that may have happened:
 * a CLI stopped mid-run, or one that answered success unreadably.
 */
export function parseAgentsFactoryOutput(result) {
  if (result.status === "secret_echoed") {
    return { ok: false, error: { code: "cli_output_rejected", reasonCode: "secret_echoed", uncertain: true } };
  }
  if (result.status !== "exited") {
    const uncertain = result.status === "timeout" || result.status === "output_too_large";
    return { ok: false, error: { code: "cli_unavailable", reasonCode: result.status, uncertain } };
  }
  const value = jsonObjectOf(result.stdout);
  if (result.exitCode === 0 && value?.ok === true) return { ok: true, value };
  if (result.exitCode === 0 && value?.ok !== false) {
    return {
      ok: false,
      error: {
        code: "cli_response_invalid", reasonCode: value === null ? "not_json" : "ok_missing",
        uncertain: true, exitCode: 0,
      },
    };
  }
  const fallback = result.exitCode === 2 ? "agents_factory_arguments_rejected" : "agents_factory_failed";
  return {
    ok: false,
    error: { code: "cli_failed", reasonCode: word(value?.code) ?? fallback, exitCode: result.exitCode },
  };
}

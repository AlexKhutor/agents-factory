import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Shared helpers of the agents-factory CLI: errors with stable codes, JSON
// files, processes. Nothing here prints; the entry point owns the output.

export class AgentsFactoryError extends Error {
  constructor(code, message = code, { exitCode = 1, detail = null } = {}) {
    super(message);
    this.name = "AgentsFactoryError";
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export function fail(code, message = code, options = {}) {
  throw new AgentsFactoryError(code, message, options);
}

export function usage(message) {
  throw new AgentsFactoryError("invalid_arguments", message, { exitCode: 2 });
}

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function isProcessAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

export function ageMs(utc, now = Date.now()) {
  const parsed = Date.parse(utc ?? "");
  return Number.isFinite(parsed) ? now - parsed : Infinity;
}

export async function pathKind(target) {
  const info = await lstat(target).catch(() => null);
  if (info === null) return null;
  if (info.isSymbolicLink()) return "link";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

/** Reads a JSON file; null when it does not exist; `invalidCode` when it is not JSON. */
export async function readJsonFile(file, { invalidCode = "json_file_invalid", maxBytes = 4 * 1024 * 1024 } = {}) {
  let text;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes) fail(invalidCode, `Not a readable JSON file: ${file}`);
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof AgentsFactoryError) throw error;
    fail(invalidCode, `Cannot read ${file}`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return fail(invalidCode, `Not valid JSON: ${file}`);
  }
}

export async function writeFileAtomic(file, content, { mode = 0o644 } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, file);
        break;
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt >= 5) {
          throw error;
        }
        await sleep(30 * attempt);
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** rename, retried on Windows while a scanner briefly holds a fresh file. */
export async function renameWithRetry(from, to, { attempts = 8, platform = process.platform } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt >= attempts) throw error;
      await sleep(60 * attempt);
    }
  }
}

export async function writeJsonAtomic(file, value, options) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function sha256File(file) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

/** One argument quoted for CommandLineToArgvW (the MSVC rules). */
export function quoteWindowsArgument(value) {
  const text = String(value);
  if (text !== "" && !/[\s"]/u.test(text)) return text;
  let result = "\"";
  let backslashes = 0;
  for (const character of text) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === "\"") {
      result += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      result += `${"\\".repeat(backslashes)}${character}`;
    }
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

export function windowsCommandLine(file, args) {
  return [file, ...args].map(quoteWindowsArgument).join(" ");
}

/**
 * Runs a program to completion. Never throws for a non-zero exit: the caller
 * decides. `errorCode` is set when the program could not be started.
 */
export function runProcess(file, args, {
  input = null, env = process.env, cwd = undefined, timeoutMs = 60_000, maxOutputBytes = 4 * 1024 * 1024,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: "", stderr: "", errorCode: error?.code ?? "spawn_failed" });
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let errorCode = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes < maxOutputBytes) stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < 256 * 1024) stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => {
      errorCode = error?.code ?? "spawn_failed";
    });
    child.stdin.on("error", () => {});
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        errorCode: timedOut ? "timeout" : errorCode,
      });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const defaultExecutor = Object.freeze({ run: runProcess });

/** The child environment: the Node of Electron needs ELECTRON_RUN_AS_NODE to act as Node. */
export function nodeChildEnvironment(base = process.env, { nodePath = process.execPath, omit = [] } = {}) {
  const env = { ...base };
  for (const name of omit) delete env[name];
  if (process.versions.electron && path.resolve(nodePath) === path.resolve(process.execPath)) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export function nowUtc() {
  return new Date().toISOString();
}

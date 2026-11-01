#!/usr/bin/env node

// orchestrator/src/agents-factory-commands.mjs
import os4 from "node:os";
import path37 from "node:path";

// orchestrator/src/agents-factory-common.mjs
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
var AgentsFactoryError = class extends Error {
  constructor(code, message = code, { exitCode = 1, detail = null } = {}) {
    super(message);
    this.name = "AgentsFactoryError";
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
};
function fail(code, message = code, options = {}) {
  throw new AgentsFactoryError(code, message, options);
}
function usage(message) {
  throw new AgentsFactoryError("invalid_arguments", message, { exitCode: 2 });
}
var sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function isProcessAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function ageMs(utc, now = Date.now()) {
  const parsed2 = Date.parse(utc ?? "");
  return Number.isFinite(parsed2) ? now - parsed2 : Infinity;
}
async function pathKind(target) {
  const info = await lstat(target).catch(() => null);
  if (info === null) return null;
  if (info.isSymbolicLink()) return "link";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}
async function readJsonFile(file, { invalidCode = "json_file_invalid", maxBytes = 4 * 1024 * 1024 } = {}) {
  let text3;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes) fail(invalidCode, `Not a readable JSON file: ${file}`);
    text3 = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof AgentsFactoryError) throw error;
    fail(invalidCode, `Cannot read ${file}`);
  }
  try {
    return JSON.parse(text3.charCodeAt(0) === 65279 ? text3.slice(1) : text3);
  } catch {
    return fail(invalidCode, `Not valid JSON: ${file}`);
  }
}
async function writeFileAtomic(file, content, { mode = 420 } = {}) {
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
    await rm(temporary, { force: true }).catch(() => {
    });
  }
}
async function renameWithRetry(from, to, { attempts = 8, platform = process.platform } = {}) {
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
async function writeJsonAtomic(file, value, options) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}
`, options);
}
async function sha256File(file) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}
function quoteWindowsArgument(value) {
  const text3 = String(value);
  if (text3 !== "" && !/[\s"]/u.test(text3)) return text3;
  let result = '"';
  let backslashes = 0;
  for (const character of text3) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      result += `${"\\".repeat(backslashes)}${character}`;
    }
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}
function windowsCommandLine(file, args) {
  return [file, ...args].map(quoteWindowsArgument).join(" ");
}
function runProcess(file, args, {
  input = null,
  env = process.env,
  cwd = void 0,
  timeoutMs = 6e4,
  maxOutputBytes = 4 * 1024 * 1024
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
    let errorCode3 = null;
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
      errorCode3 = error?.code ?? "spawn_failed";
    });
    child.stdin.on("error", () => {
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        errorCode: timedOut ? "timeout" : errorCode3
      });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}
var defaultExecutor = Object.freeze({ run: runProcess });
function nodeChildEnvironment(base = process.env, { nodePath = process.execPath, omit = [] } = {}) {
  const env = { ...base };
  for (const name of omit) delete env[name];
  if (process.versions.electron && path.resolve(nodePath) === path.resolve(process.execPath)) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}
function nowUtc() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// orchestrator/src/agents-factory-doctor.mjs
import { constants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { createServer } from "node:net";
import path33 from "node:path";

// orchestrator/src/agents-factory-gateway.mjs
import { randomUUID as randomUUID12 } from "node:crypto";
import { spawn as spawn4 } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir as mkdir16, open as open2, readFile as readFile19, rename as rename15, rm as rm11, stat as stat5 } from "node:fs/promises";
import path28 from "node:path";

// orchestrator/src/agents-factory-key.mjs
import { readFile as readFile2, rm as rm2 } from "node:fs/promises";
import path2 from "node:path";
var KEY_SERVICE = "agents-factory";
var KEY_ACCOUNT = "anthropic-api-key";
var KEY_LABEL = "Agents Factory Anthropic API key";
var DPAPI_ENTROPY = "AgentsFactory.AnthropicApiKey.v1";
var KEY_PATTERN = /^[A-Za-z0-9_\-.:+/=]{16,512}$/u;
function keyStoreKind(platform = process.platform) {
  if (platform === "win32") return "windows-dpapi";
  if (platform === "darwin") return "macos-keychain";
  return "linux-secret-service";
}
function normalizeApiKey(text3) {
  const key = typeof text3 === "string" ? text3.trim() : "";
  if (!KEY_PATTERN.test(key)) fail("key_invalid", "The API key is empty or has characters an Anthropic key does not have");
  return key;
}
function windowsPowerShell(env) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return path2.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function encodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}
var PROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Array]::Clear($plain, 0, $plain.Length)
[Console]::Out.Write([Convert]::ToBase64String($cipher))`;
var UNPROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$cipher = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
[Array]::Clear($plain, 0, $plain.Length)`;
async function runPowerShell(executor, env, script, input) {
  const result = await executor.run(windowsPowerShell(env), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand(script)
  ], { input, env, timeoutMs: 6e4 });
  if (result.status !== 0) fail("key_store_unavailable", "Windows DPAPI (PowerShell) did not complete");
  return result.stdout.trim();
}
function base64(text3) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text3)) fail("key_store_unavailable", "The key store returned an unexpected answer");
  return text3;
}
function createKeyStore({ platform = process.platform, layout, executor = defaultExecutor, env = process.env } = {}) {
  const kind2 = keyStoreKind(platform);
  if (kind2 === "windows-dpapi") {
    const file = layout.dpapiKeyFile;
    return Object.freeze({
      kind: kind2,
      async has() {
        return await pathKind(file) === "file";
      },
      async set(key) {
        const value = normalizeApiKey(key);
        const ciphertext = base64(await runPowerShell(executor, env, PROTECT_SCRIPT, Buffer.from(value, "utf8").toString("base64")));
        await writeJsonAtomic(file, {
          schemaVersion: 1,
          kind: "dpapi-current-user",
          entropyId: DPAPI_ENTROPY,
          ciphertext,
          storedAtUtc: nowUtc()
        }, { mode: 384 });
      },
      async get() {
        if (await pathKind(file) !== "file") return null;
        let record;
        try {
          record = JSON.parse(await readFile2(file, "utf8"));
        } catch {
          fail("key_store_invalid", "The stored key record is unreadable");
        }
        if (record?.schemaVersion !== 1 || record.kind !== "dpapi-current-user" || typeof record.ciphertext !== "string") {
          fail("key_store_invalid", "The stored key record is not supported");
        }
        const plain = base64(await runPowerShell(executor, env, UNPROTECT_SCRIPT, base64(record.ciphertext)));
        return normalizeApiKey(Buffer.from(plain, "base64").toString("utf8"));
      },
      async remove() {
        const existed = await pathKind(file) === "file";
        await rm2(file, { force: true });
        return existed;
      }
    });
  }
  if (kind2 === "macos-keychain") {
    const security = "/usr/bin/security";
    const identity = ["-s", KEY_SERVICE, "-a", KEY_ACCOUNT];
    return Object.freeze({
      kind: kind2,
      async has() {
        const result = await executor.run(security, ["find-generic-password", ...identity], { env, timeoutMs: 3e4 });
        if (result.status === 0) return true;
        if (result.status === 44) return false;
        return fail("key_store_unavailable", "The macOS Keychain did not answer");
      },
      async set(key) {
        const value = normalizeApiKey(key);
        const command = `add-generic-password -U -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -l "${KEY_LABEL}" -w "${value}"
`;
        const result = await executor.run(security, ["-i"], { input: command, env, timeoutMs: 3e4 });
        if (result.status !== 0) fail("key_store_unavailable", "The macOS Keychain did not store the key");
      },
      async get() {
        const result = await executor.run(security, ["find-generic-password", ...identity, "-w"], { env, timeoutMs: 3e4 });
        if (result.status === 44) return null;
        if (result.status !== 0) fail("key_store_unavailable", "The macOS Keychain did not answer");
        return normalizeApiKey(result.stdout);
      },
      async remove() {
        const result = await executor.run(security, ["delete-generic-password", ...identity], { env, timeoutMs: 3e4 });
        if (result.status === 0) return true;
        if (result.status === 44) return false;
        return fail("key_store_unavailable", "The macOS Keychain did not remove the key");
      }
    });
  }
  const attributes = ["service", KEY_SERVICE, "account", KEY_ACCOUNT];
  const secretTool = "secret-tool";
  const unavailable = (result) => result.errorCode === "ENOENT" ? fail("key_store_unavailable", "secret-tool (libsecret) is not installed") : fail("key_store_unavailable", "The Secret Service did not answer");
  return Object.freeze({
    kind: kind2,
    async has() {
      const result = await executor.run(secretTool, ["lookup", ...attributes], { env, timeoutMs: 3e4 });
      if (result.status === 0) return result.stdout.trim() !== "";
      if (result.status === 1 && result.errorCode === null) return false;
      return unavailable(result);
    },
    async set(key) {
      const value = normalizeApiKey(key);
      const result = await executor.run(
        secretTool,
        ["store", `--label=${KEY_LABEL}`, ...attributes],
        { input: value, env, timeoutMs: 3e4 }
      );
      if (result.status !== 0) unavailable(result);
    },
    async get() {
      const result = await executor.run(secretTool, ["lookup", ...attributes], { env, timeoutMs: 3e4 });
      if (result.status === 1 && result.errorCode === null) return null;
      if (result.status !== 0) unavailable(result);
      return result.stdout.trim() === "" ? null : normalizeApiKey(result.stdout);
    },
    async remove() {
      const existed = await this.has();
      const result = await executor.run(secretTool, ["clear", ...attributes], { env, timeoutMs: 3e4 });
      if (result.status !== 0 && existed) unavailable(result);
      return existed;
    }
  });
}
async function resolveApiKey({ env = process.env, store }) {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "") {
    return { source: "environment", key: env.ANTHROPIC_API_KEY, reasonCode: null };
  }
  try {
    const key = await store.get();
    return key === null ? { source: "none", key: null, reasonCode: "key_not_stored" } : { source: "key-store", key, reasonCode: null };
  } catch (error) {
    return { source: "none", key: null, reasonCode: typeof error?.code === "string" ? error.code : "key_store_unavailable" };
  }
}
async function keyStatus({ env = process.env, store }) {
  return {
    hasKey: await store.has(),
    store: store.kind,
    environmentOverride: typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== ""
  };
}

// orchestrator/src/instance-move.mjs
import { copyFile as copyFile3, lstat as lstat11, mkdir as mkdir11, readdir as readdir8, readFile as readFile11, readlink, realpath as realpath9, rename as rename11, stat as stat2, symlink, writeFile as writeFile9 } from "node:fs/promises";
import path19 from "node:path";

// orchestrator/src/machine-identity.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { lstat as lstat2, mkdir as mkdir2, readdir, readFile as readFile3, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import path3 from "node:path";
var MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u;
var LOCAL_FILE = path3.join(".project-local", "machine.json");
var OVERLAY_FOLDER = "machine";
var MAX_TITLE = 80;
function fail2(code, detail) {
  throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}
async function readJson(file) {
  try {
    return JSON.parse(await readFile3(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function writeJson(target, value) {
  await mkdir2(path3.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID2()}.tmp`;
  await writeFile2(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename2(temporary, target);
}
var overlayPath = (controllerRoot, machineId) => path3.join(controllerRoot, OVERLAY_FOLDER, `${machineId}.json`);
async function readMachines(controllerRoot) {
  const folder = path3.join(controllerRoot, OVERLAY_FOLDER);
  const entries = await readdir(folder, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const machines = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = await readJson(path3.join(folder, entry.name));
    const machineId = entry.name.slice(0, -".json".length);
    if (!MACHINE_ID.test(machineId) || value?.machineId !== machineId) continue;
    machines[machineId] = { title: typeof value.title === "string" ? value.title : machineId, home: value.home === true };
  }
  return machines;
}
async function readThisMachine(controllerRoot) {
  const local = await readJson(path3.join(controllerRoot, LOCAL_FILE));
  if (typeof local?.machineId !== "string" || !MACHINE_ID.test(local.machineId)) return null;
  const machines = await readMachines(controllerRoot);
  return { machineId: local.machineId, ...machines[local.machineId] ?? { title: local.machineId, home: false } };
}
async function setThisMachine(controllerRoot, { machineId, title = null, home = null }) {
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) fail2("machine_id_invalid", String(machineId));
  if (title !== null && (typeof title !== "string" || title.trim() === "" || title.length > MAX_TITLE)) fail2("machine_title_invalid");
  if (home !== null && typeof home !== "boolean") fail2("machine_home_invalid");
  const current = await readJson(overlayPath(controllerRoot, machineId));
  const overlay = {
    ...current ?? {},
    schemaVersion: 1,
    machineId,
    title: title ?? current?.title ?? machineId,
    home: home ?? current?.home === true
  };
  await writeJson(overlayPath(controllerRoot, machineId), overlay);
  await writeJson(path3.join(controllerRoot, LOCAL_FILE), { schemaVersion: 1, machineId });
  return { machineId, title: overlay.title, home: overlay.home };
}
function projectPolicy(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail2("policy_invalid");
  const keys = Object.keys(value).sort().join();
  if (keys !== "allowedMachines,homeOnly") fail2("policy_invalid", keys);
  if (typeof value.homeOnly !== "boolean") fail2("policy_invalid", "homeOnly");
  const allowed = value.allowedMachines;
  if (allowed !== null && (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 16 || allowed.some((id5) => typeof id5 !== "string" || !MACHINE_ID.test(id5)) || new Set(allowed).size !== allowed.length)) {
    fail2("policy_invalid", "allowedMachines");
  }
  return { homeOnly: value.homeOnly, allowedMachines: allowed === null ? null : [...allowed].sort() };
}

// orchestrator/src/project-package-export.mjs
import { createHash as createHash8 } from "node:crypto";
import { lstat as lstat5, mkdir as mkdir5, readFile as readFile6, readdir as readdir3, realpath as realpath2, rename as rename5, rm as rm5, writeFile as writeFile5 } from "node:fs/promises";
import path6 from "node:path";

// orchestrator/src/action-journal.mjs
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
var ACTION_JOURNAL_PREFIX = "action-journal-v1:";
var JOURNAL_ACTIONS = Object.freeze([
  "agent.create",
  "agent.close",
  "agent.reopen",
  "agent.profile",
  "agent.settings",
  "agent.permission-mode",
  "scope.create",
  "memory.write",
  "memory.approve",
  "project.archive",
  "project.restore",
  "quarter.archive",
  "quarter.restore",
  "project.copy",
  "project.policy",
  "project.bind",
  "project.rebind",
  "project.git-init",
  "project.file-save",
  "agent.desk-source",
  "object.rename",
  "task.start",
  "task.revise",
  "task.approve",
  "task.cancel",
  "agent.memory-autonomy"
]);
var UNDO_KINDS = Object.freeze([
  "close-agent",
  "reopen-agent",
  "set-profile",
  "set-settings",
  "set-permission-mode",
  "archive-project",
  "restore-project",
  "archive-quarter",
  "restore-quarter",
  "memory-revision",
  "set-project-policy",
  "restore-file",
  "rename"
]);
var NO_UNDO_REASONS = Object.freeze([
  "undo_entry",
  "file_not_kept",
  "binding_not_undone",
  "git_not_undone",
  "desk_source_not_undone",
  "approval_without_write",
  "first_revision",
  "task_not_undone",
  "setting_not_undone"
]);
var ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var MAX_BYTES = 200 * 1024;
var ActionJournalError = class extends Error {
  constructor(code) {
    super(code);
    this.name = "ActionJournalError";
    this.code = code;
  }
};
function fail3(code) {
  throw new ActionJournalError(code);
}
var sha256 = (value) => createHash2("sha256").update(value).digest("hex");
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) fail3("journal_invalid_entry");
  return value;
}
function journalKeyOf(projectId) {
  return `${ACTION_JOURNAL_PREFIX}${sha256(id(projectId)).slice(0, 32)}`;
}

// orchestrator/src/object-names.mjs
import { createHash as createHash3 } from "node:crypto";
var NAMES_PREFIX = "names-v1:";
var NAME_KINDS = Object.freeze(["project", "quarter", "agent"]);
var ID2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
function fail4(code) {
  throw Object.assign(new Error(code), { code });
}
var sha2562 = (value) => createHash3("sha256").update(value).digest("hex");
function id2(value) {
  if (typeof value !== "string" || !ID2.test(value)) fail4("name_invalid_input");
  return value;
}
function namesKeyOf(projectId) {
  return `${NAMES_PREFIX}${sha2562(id2(projectId)).slice(0, 32)}`;
}

// orchestrator/src/agent-tasks.mjs
import { createHash as createHash4 } from "node:crypto";

// orchestrator/src/object-ids.mjs
var CYRILLIC = Object.freeze(Object.fromEntries([
  [1072, "a"],
  [1073, "b"],
  [1074, "v"],
  [1075, "g"],
  [1076, "d"],
  [1077, "e"],
  [1105, "e"],
  [1078, "zh"],
  [1079, "z"],
  [1080, "i"],
  [1081, "y"],
  [1082, "k"],
  [1083, "l"],
  [1084, "m"],
  [1085, "n"],
  [1086, "o"],
  [1087, "p"],
  [1088, "r"],
  [1089, "s"],
  [1090, "t"],
  [1091, "u"],
  [1092, "f"],
  [1093, "kh"],
  [1094, "ts"],
  [1095, "ch"],
  [1096, "sh"],
  [1097, "shch"],
  [1098, ""],
  [1099, "y"],
  [1100, ""],
  [1101, "e"],
  [1102, "yu"],
  [1103, "ya"],
  [1110, "i"],
  [1111, "yi"],
  [1108, "ye"],
  [1169, "g"]
].map(([code, latin]) => [String.fromCodePoint(code), latin])));

// orchestrator/src/agent-tasks.mjs
var TASKS_PREFIX = "agent-tasks-v1:";
var TASK_STAGES = Object.freeze(["planning", "awaiting-approval", "in-progress", "done", "cancelled"]);
var OPEN_STAGES = Object.freeze(["planning", "awaiting-approval", "in-progress"]);
var TASK_PHASES = Object.freeze(["plan", "work"]);
var TASK_ORIGINS = Object.freeze(["chat"]);
var ID3 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var LIMITS = Object.freeze({
  tasks: 200,
  revisions: 20,
  remarks: 20,
  text: 8e3,
  understanding: 4e3,
  questions: 16,
  question: 1e3,
  steps: 40,
  step: 600,
  answers: 16,
  answer: 2e3,
  raw: 16e3,
  results: 32,
  resultPath: 400,
  resultNote: 400,
  documentBytes: 200 * 1024
});
function fail5(code) {
  throw Object.assign(new Error(code), { code });
}
var sha2563 = (value) => createHash4("sha256").update(value).digest("hex");
function id3(value) {
  if (typeof value !== "string" || !ID3.test(value)) fail5("task_invalid_input");
  return value;
}
function tasksKeyOf(projectId) {
  return `${TASKS_PREFIX}${sha2563(id3(projectId)).slice(0, 32)}`;
}
var RU = (codes) => String.fromCodePoint(...codes);
var HEADINGS = Object.freeze([
  ["understanding", ["understanding", "summary", RU([1087, 1086, 1085, 1080, 1084, 1072, 1085, 1080, 1077])]],
  ["questions", ["questions", "open questions", "question", RU([1074, 1086, 1087, 1088, 1086, 1089, 1099])]],
  ["plan", ["plan", "steps", RU([1087, 1083, 1072, 1085]), RU([1096, 1072, 1075, 1080])]],
  ["results", [
    "results",
    "result",
    RU([1088, 1077, 1079, 1091, 1083, 1100, 1090, 1072, 1090, 1099]),
    RU([1088, 1077, 1079, 1091, 1083, 1100, 1090, 1072, 1090])
  ]]
]);
var NONE = /* @__PURE__ */ new Set([
  "none",
  "no questions",
  "n/a",
  "-",
  RU([1085, 1077, 1090]),
  RU([1074, 1086, 1087, 1088, 1086, 1089, 1086, 1074, 32, 1085, 1077, 1090])
]);

// orchestrator/src/memory-changes.mjs
import { createHash as createHash5, randomBytes } from "node:crypto";
var CHANGES_PREFIX = "memory-changes-v1:";
var CHANGE_STATES = Object.freeze(["pending", "approved", "rejected", "stale", "written"]);
var CHANGE_TARGETS = Object.freeze(["own", "quarter", "project", "agent"]);
var ID4 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var LIMITS2 = Object.freeze({
  kept: 100,
  changes: 32,
  title: 512,
  text: 65536,
  reason: 2e3,
  documentBytes: 200 * 1024
});
function fail6(code) {
  throw Object.assign(new Error(code), { code });
}
var sha2564 = (value) => createHash5("sha256").update(value).digest("hex");
function id4(value) {
  if (typeof value !== "string" || !ID4.test(value)) fail6("memory_change_invalid_input");
  return value;
}
function changesKeyOf(projectId) {
  return `${CHANGES_PREFIX}${sha2564(id4(projectId)).slice(0, 32)}`;
}

// orchestrator/src/sqlite-backend.mjs
var SQLITE_BACKENDS = Object.freeze(["node", "python"]);
var SQLITE_BACKEND_ENVIRONMENT = "AGENTS_FACTORY_SQLITE";
var loading = null;
function experimentalSqliteWarning(warning, rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  const name = type ?? warning?.name;
  const message = typeof warning === "string" ? warning : warning?.message;
  return name === "ExperimentalWarning" && /\bSQLite\b/u.test(String(message ?? ""));
}
async function importNodeSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function emitWarningExceptSqlite(warning, ...rest) {
    if (experimentalSqliteWarning(warning, rest)) return void 0;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    const module = await import("node:sqlite");
    return typeof module?.DatabaseSync === "function" ? module : null;
  } catch {
    return null;
  } finally {
    if (process.emitWarning.name === "emitWarningExceptSqlite") process.emitWarning = emitWarning;
  }
}
function loadNodeSqlite() {
  loading ??= importNodeSqlite();
  return loading;
}
function sqliteBackendOption(value) {
  if (value === void 0 || value === null) return null;
  if (!SQLITE_BACKENDS.includes(value)) {
    const error = new TypeError(`sqliteBackend must be one of ${SQLITE_BACKENDS.join(", ")}`);
    error.code = "SQLITE_BACKEND_INVALID";
    throw error;
  }
  return value;
}
function requestedSqliteBackend(option) {
  const explicit = sqliteBackendOption(option);
  if (explicit !== null) return explicit;
  const environment = String(process.env[SQLITE_BACKEND_ENVIRONMENT] ?? "").trim().toLowerCase();
  return SQLITE_BACKENDS.includes(environment) ? environment : null;
}
async function resolveSqliteBackend({ backend, load = loadNodeSqlite } = {}) {
  if (requestedSqliteBackend(backend) === "python") return { backend: "python", sqlite: null };
  const sqlite = await load();
  return sqlite ? { backend: "node", sqlite } : { backend: "python", sqlite: null };
}

// orchestrator/src/sqlite-python-compat.mjs
import { createHash as createHash6 } from "node:crypto";
var PythonError = class extends Error {
  constructor(type, message) {
    super(message);
    this.name = type;
    this.pythonType = type;
  }
};
var INPUT_ERROR_TYPES = /* @__PURE__ */ new Set(["KeyError", "TypeError", "ValueError", "JSONDecodeError", "UnicodeEncodeError"]);
function isPythonInputError(error) {
  return error instanceof PythonError && INPUT_ERROR_TYPES.has(error.pythonType);
}
function pyIsInt(value) {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 1e21;
}
function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function pyTypeName(value) {
  if (value === null || value === void 0) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "bigint") return "int";
  if (typeof value === "number") return pyIsInt(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}
function pyFloatRepr(value) {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
    if (digits.length <= exponent + 1) return `${sign}${digits}${"0".repeat(exponent + 1 - digits.length)}.0`;
    return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  }
  const significand = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${significand}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
}
function numberJson(value) {
  const text3 = JSON.stringify(value);
  if (text3 === "null") return "null";
  return /[.eE]/u.test(text3) ? pyFloatRepr(value) : text3;
}
var ESCAPES = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "	": "\\t" };
function stringJson(value) {
  if (value.isWellFormed()) return JSON.stringify(value);
  let text3 = '"';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (ESCAPES[character]) text3 += ESCAPES[character];
    else if (code < 32) text3 += `\\u${code.toString(16).padStart(4, "0")}`;
    else text3 += character;
  }
  return `${text3}"`;
}
function pyKeyCompare(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a === b) continue;
    const surrogateA = a >= 55296 && a <= 57343;
    const surrogateB = b >= 55296 && b <= 57343;
    if (surrogateA !== surrogateB && (surrogateA ? b : a) >= 57344) return surrogateA ? 1 : -1;
    return a - b;
  }
  return left.length - right.length;
}
function prepared(value) {
  return value !== null && typeof value === "object" && typeof value.toJSON === "function" ? value.toJSON() : value;
}
function pythonJson(value, { sortKeys = false } = {}) {
  const input = prepared(value);
  if (input === null || input === void 0 || typeof input === "function" || typeof input === "symbol") return "null";
  if (typeof input === "boolean") return input ? "true" : "false";
  if (typeof input === "number") return numberJson(input);
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "string") return stringJson(input);
  if (Array.isArray(input)) return `[${input.map((item) => pythonJson(item, { sortKeys })).join(",")}]`;
  const keys = Object.keys(input).filter((key) => {
    const item = prepared(input[key]);
    return item !== void 0 && typeof item !== "function" && typeof item !== "symbol";
  });
  if (sortKeys) keys.sort(pyKeyCompare);
  return `{${keys.map((key) => `${stringJson(key)}:${pythonJson(input[key], { sortKeys })}`).join(",")}}`;
}
function jsonTransport(value) {
  const text3 = JSON.stringify(value);
  if (text3 === void 0) {
    throw new PythonError("JSONDecodeError", "Expecting value: line 1 column 1 (char 0)");
  }
  return JSON.parse(text3);
}
function sortedTransport(value) {
  if (Array.isArray(value)) return value.map((item) => item === void 0 ? null : sortedTransport(item));
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort(pyKeyCompare)) {
    if (value[key] !== void 0) result[key] = sortedTransport(value[key]);
  }
  return result;
}
function utf8(text3) {
  if (!text3.isWellFormed()) {
    let position = 0;
    for (const character of text3) {
      const code = character.codePointAt(0);
      if (code >= 55296 && code <= 57343) {
        throw new PythonError(
          "UnicodeEncodeError",
          `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${position}: surrogates not allowed`
        );
      }
      position += 1;
    }
  }
  return Buffer.from(text3, "utf8");
}
function sha256Hex(text3) {
  return createHash6("sha256").update(utf8(text3)).digest("hex");
}
function stringRepr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let text3 = quote;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === quote || character === "\\") text3 += `\\${character}`;
    else if (character === "\n") text3 += "\\n";
    else if (character === "\r") text3 += "\\r";
    else if (character === "	") text3 += "\\t";
    else if (code === 32 || !/[\p{C}\p{Z}]/u.test(character)) text3 += character;
    else if (code < 256) text3 += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 65536) text3 += `\\u${code.toString(16).padStart(4, "0")}`;
    else text3 += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return `${text3}${quote}`;
}
function pyRepr(value) {
  if (typeof value === "string") return stringRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isDict(value)) {
    return `{${Object.keys(value).map((key) => `${stringRepr(key)}: ${pyRepr(value[key])}`).join(", ")}}`;
  }
  return pyStr(value);
}
function pyStr(value) {
  if (value === null || value === void 0) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return pyIsInt(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === "string") return value;
  return pyRepr(value);
}
function pyTruthy(value) {
  if (value === null || value === void 0 || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function pyOr(left, right) {
  return pyTruthy(left) ? left : right;
}
function pyGet(dictionary, key, fallback = null) {
  if (!isDict(dictionary)) {
    throw new PythonError("AttributeError", `'${pyTypeName(dictionary)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(dictionary, key) && dictionary[key] !== void 0 ? dictionary[key] : fallback;
}
function pyItem(dictionary, key) {
  if (Array.isArray(dictionary)) {
    throw new PythonError("TypeError", "list indices must be integers or slices, not str");
  }
  if (!isDict(dictionary)) {
    throw new PythonError("TypeError", `'${pyTypeName(dictionary)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(dictionary, key) || dictionary[key] === void 0) throw new PythonError("KeyError", pyRepr(key));
  return dictionary[key];
}
function pyIter(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PythonError("TypeError", `'${pyTypeName(value)}' object is not iterable`);
}
function pyHashKey(value) {
  if (value === null || value === void 0) return "None";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return `n:${typeof value === "bigint" ? value.toString() : Number(value)}`;
  }
  if (typeof value === "string") return `s:${value}`;
  throw new PythonError("TypeError", `unhashable type: '${pyTypeName(value)}'`);
}
function pyEquals(left, right) {
  const numeric = (value) => typeof value === "number" || typeof value === "boolean" || typeof value === "bigint";
  if (numeric(left) || numeric(right)) {
    if (!numeric(left) || !numeric(right)) return false;
    const exact2 = (value) => typeof value === "boolean" ? BigInt(value) : value;
    return exact2(left) == exact2(right);
  }
  if (left === null || left === void 0 || right === null || right === void 0) {
    return (left ?? null) === (right ?? null);
  }
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => pyEquals(item, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && pyEquals(left[key], right[key]));
}
function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new PythonError("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(value)) throw new PythonError("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(value) + 0;
  }
  if (typeof value === "string") {
    const match = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/u.exec(value);
    if (match) {
      const digits = `${match[1]}${match[2].replaceAll("_", "")}`;
      const number = Number(digits) + 0;
      return Number.isSafeInteger(number) ? number : BigInt(digits);
    }
    throw new PythonError("ValueError", `invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  throw new PythonError(
    "TypeError",
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`
  );
}
function pyClampInt(value, low, high) {
  const number = pyInt(value);
  if (number < low) return low;
  if (number > high) return high;
  return Number(number);
}
function pyAtLeast(value, low) {
  const number = pyInt(value);
  return number < low ? low : number;
}
function pyLength(text3) {
  let length = 0;
  for (const _ of text3) length += 1;
  return length;
}
function pySlice(text3, end) {
  let result = "";
  let count = 0;
  for (const character of text3) {
    if (count >= end) break;
    result += character;
    count += 1;
  }
  return result;
}
var MICROSECONDS_PER_MILLISECOND = 1e3;
var lastMicroseconds = 0;
function nowMicroseconds() {
  const sub = Number(process.hrtime.bigint() / 1000n % 1000n);
  let value = Date.now() * MICROSECONDS_PER_MILLISECOND + sub;
  if (value <= lastMicroseconds) value = lastMicroseconds + 1;
  lastMicroseconds = value;
  return value;
}
function isoFromMicroseconds(microseconds) {
  const seconds = Math.floor(microseconds / 1e6);
  const fraction = microseconds - seconds * 1e6;
  const whole = new Date(seconds * 1e3).toISOString().slice(0, 19);
  return fraction === 0 ? `${whole}Z` : `${whole}.${String(fraction).padStart(6, "0")}Z`;
}
function utcNow() {
  return isoFromMicroseconds(nowMicroseconds());
}
var ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?$/u;
function parseUtcMicroseconds(value) {
  if (!pyTruthy(value)) return null;
  if (typeof value !== "string") {
    throw new PythonError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'replace'`);
  }
  const text3 = value.replaceAll("Z", "+00:00");
  const match = ISO_DATE_TIME.exec(text3);
  const invalid = () => new PythonError("ValueError", `Invalid isoformat string: ${pyRepr(text3)}`);
  if (!match) throw invalid();
  const [
    ,
    year,
    month,
    day,
    hour = "0",
    minute = "0",
    second = "0",
    fraction = "",
    zulu,
    sign,
    offsetHour,
    offsetMinute,
    offsetSecond = "0"
  ] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) throw invalid();
  const daysInMonth = new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
  if (parts[2] > daysInMonth) throw invalid();
  const micro = Number(fraction.slice(0, 6).padEnd(6, "0"));
  let milliseconds;
  if (zulu === void 0 && sign === void 0) {
    milliseconds = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime();
  } else {
    milliseconds = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    if (sign !== void 0) {
      const offset = (Number(offsetHour) * 3600 + Number(offsetMinute) * 60 + Number(offsetSecond)) * 1e3;
      if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) throw invalid();
      milliseconds += sign === "+" ? -offset : offset;
    }
  }
  return milliseconds * MICROSECONDS_PER_MILLISECOND + micro;
}

// orchestrator/src/sqlite-node-connection.mjs
var SQLITE_CONSTRAINT = 19;
function isIntegrityError(error) {
  return typeof error?.errcode === "number" && (error.errcode & 255) === SQLITE_CONSTRAINT;
}
function bindValue(value, index) {
  if (value === null || value === void 0) return null;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") {
    if (!pyIsInt(value)) return value;
    if (value >= 2 ** 63 || value < -(2 ** 63)) {
      throw new PythonError("OverflowError", "Python int too large to convert to SQLite INTEGER");
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) utf8(value);
    return value;
  }
  if (typeof value === "bigint") {
    if (value >= 2n ** 63n || value < -(2n ** 63n)) {
      throw new PythonError("OverflowError", "Python int too large to convert to SQLite INTEGER");
    }
    return value;
  }
  throw new PythonError(
    "ProgrammingError",
    `Error binding parameter ${index}: type '${pyTypeName(value)}' is not supported`
  );
}
function bound(parameters) {
  return parameters.map((value, index) => bindValue(value, index + 1));
}
function prepared2(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}
function row(value) {
  if (value === void 0 || value === null) return null;
  for (const key of Object.keys(value)) {
    if (typeof value[key] === "bigint") value[key] = Number(value[key]);
  }
  return value;
}
function openReadOnlyDatabase(sqlite, location2, { timeoutMs = 1e4 } = {}) {
  const database = new sqlite.DatabaseSync(location2, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout=${Math.trunc(timeoutMs)}`);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
var NodeSqliteConnection = class {
  /**
   * `timeoutMs` is the busy timeout sqlite3.connect(timeout=...) sets before
   * any statement runs. Foreign keys start off and double-quoted string
   * literals stay allowed, as in Python's sqlite3 (node:sqlite flips both).
   */
  constructor(sqlite, location2, { timeoutMs, readOnly = false }) {
    this.database = new sqlite.DatabaseSync(location2, {
      readOnly,
      enableForeignKeyConstraints: false,
      enableDoubleQuotedStringLiterals: true
    });
    try {
      this.database.exec(`PRAGMA busy_timeout=${Math.trunc(timeoutMs)}`);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  /** Statements without parameters, run to completion. */
  exec(sql) {
    this.database.exec(sql);
  }
  get(sql, parameters = []) {
    return row(prepared2(this.database, sql).get(...bound(parameters)));
  }
  all(sql, parameters = []) {
    return prepared2(this.database, sql).all(...bound(parameters)).map(row);
  }
  /** { changes, lastInsertRowid } of one statement. */
  run(sql, parameters = []) {
    const result = this.database.prepare(sql).run(...bound(parameters));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
  /** The first column of the first row (PRAGMA user_version and the like). */
  value(sql, parameters = []) {
    const row2 = this.get(sql, parameters);
    return row2 === null ? null : Object.values(row2)[0];
  }
  /** Python's Connection.rollback(): only when a transaction is open. */
  rollback() {
    if (typeof this.database.isTransaction === "boolean") {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      return;
    }
    try {
      this.database.exec("ROLLBACK");
    } catch (error) {
      if (!/no transaction is active/u.test(String(error?.message))) throw error;
    }
  }
  close() {
    this.database.close();
  }
};

// orchestrator/src/project-store-layout.mjs
import { createHash as createHash7, randomUUID as randomUUID4 } from "node:crypto";
import { lstat as lstat3, mkdir as mkdir3, readdir as readdir2, readFile as readFile4, realpath, rename as rename3, rm as rm3, writeFile as writeFile3 } from "node:fs/promises";
import path4 from "node:path";
var STORE_LAYOUT_MARKER = "store-layout.v1.json";
var WORLD_PROJECT_ID = "world";
var STORE_LAYOUT_ENVIRONMENT = "AGENTS_FACTORY_STORE_LAYOUT";
var PROJECT_FILE = "project.json";
var PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var PLAIN_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
var RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu;
var ProjectStoreLayoutError = class extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProjectStoreLayoutError";
    this.code = code;
  }
};
function fail7(code, detail) {
  throw new ProjectStoreLayoutError(code, detail);
}
async function kind(target) {
  const info = await lstat3(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  if (info.isSymbolicLink()) fail7("store_layout_link_refused", target);
  return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
}
function projectsRoot(controllerRoot) {
  return path4.join(controllerRoot, ".project-local", "projects");
}
function singleMemoryDatabase(controllerRoot) {
  return path4.join(controllerRoot, ".project-local", "orchestration", "project-memory", "project-memory.v1.sqlite");
}
function projectFolderName(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) fail7("store_project_id_invalid");
  if (PLAIN_FOLDER.test(projectId) && !RESERVED.test(projectId) && !projectId.endsWith(".")) return projectId;
  return `~${createHash7("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}
async function resolveStoreLayout(controllerRoot, { env = process.env } = {}) {
  const root = await realpath(controllerRoot);
  const marker = path4.join(projectsRoot(root), STORE_LAYOUT_MARKER);
  const markerKind = await kind(marker);
  if (markerKind === "file") {
    const value = JSON.parse(await readFile4(marker, "utf8"));
    if (value?.schemaVersion !== 1 || value?.layout !== "split") fail7("store_layout_unsupported", marker);
    return { layout: "split", root };
  }
  if (markerKind !== null) fail7("store_layout_unsupported", marker);
  if (String(env?.[STORE_LAYOUT_ENVIRONMENT] ?? "").trim().toLowerCase() === "split" && await kind(singleMemoryDatabase(root)) === null) {
    await writeStoreLayoutMarker(root);
    return { layout: "split", root };
  }
  return { layout: "single", root };
}
async function writeStoreLayoutMarker(controllerRoot, { now = () => /* @__PURE__ */ new Date() } = {}) {
  const directory = projectsRoot(controllerRoot);
  await mkdir3(directory, { recursive: true });
  const marker = path4.join(directory, STORE_LAYOUT_MARKER);
  if (await kind(marker) === "file") return marker;
  await writeOnce(marker, `${JSON.stringify({
    schemaVersion: 1,
    layout: "split",
    createdAtUtc: now().toISOString()
  }, null, 2)}
`);
  return marker;
}
async function projectStoreFolder(controllerRoot, projectId, { create = false } = {}) {
  const folder = path4.join(projectsRoot(controllerRoot), projectFolderName(projectId));
  const identity = path4.join(folder, PROJECT_FILE);
  const present = await kind(identity);
  if (present === "file") {
    const value2 = JSON.parse(await readFile4(identity, "utf8"));
    if (value2?.projectId !== projectId) fail7("store_project_identity_conflict", folder);
    return folder;
  }
  if (!create) return null;
  await mkdir3(folder, { recursive: true });
  await writeOnce(identity, `${JSON.stringify({ schemaVersion: 1, projectId }, null, 2)}
`);
  const value = JSON.parse(await readFile4(identity, "utf8"));
  if (value?.projectId !== projectId) fail7("store_project_identity_conflict", folder);
  return folder;
}
async function writeOnce(target, text3) {
  const temporary = `${target}.${process.pid}.${randomUUID4()}.tmp`;
  await writeFile3(temporary, text3, "utf8");
  try {
    await rename3(temporary, target);
  } catch (error) {
    await rm3(temporary, { force: true });
    if (await kind(target) !== "file") throw error;
  }
}
async function mountedProjects(controllerRoot) {
  const directory = projectsRoot(controllerRoot);
  if (await kind(directory) !== "directory") return [];
  const found = [];
  for (const entry of await readdir2(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path4.join(directory, entry.name);
    const identity = path4.join(folder, PROJECT_FILE);
    if (await kind(identity) !== "file") continue;
    const value = JSON.parse(await readFile4(identity, "utf8"));
    if (typeof value?.projectId !== "string" || projectFolderName(value.projectId) !== entry.name) {
      fail7("store_project_identity_conflict", folder);
    }
    found.push({ projectId: value.projectId, folder });
  }
  return found.sort((a, b) => a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0);
}

// orchestrator/src/world-registry.mjs
import { randomUUID as randomUUID5 } from "node:crypto";
import { lstat as lstat4, mkdir as mkdir4, readFile as readFile5, rename as rename4, rm as rm4, writeFile as writeFile4 } from "node:fs/promises";
import path5 from "node:path";
var WORLD_FOLDER = ".world";
var REGISTRY_FILE = "registry.json";
var TASKS_FOLDER = "tasks";
var ID5 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
function fail8(code, detail) {
  throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}
var compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
async function exists(target) {
  return lstat4(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
async function writeJson2(target, value) {
  await mkdir4(path5.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID5()}.tmp`;
  await writeFile4(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename4(temporary, target);
}
function registryPath(controllerRoot) {
  return path5.join(controllerRoot, WORLD_FOLDER, REGISTRY_FILE);
}
async function readWorldRegistry(controllerRoot) {
  const file = registryPath(controllerRoot);
  if (!await exists(file)) return { schemaVersion: 1, projects: {} };
  const value = JSON.parse(await readFile5(file, "utf8"));
  if (value?.schemaVersion !== 1 || !value.projects || typeof value.projects !== "object") fail8("world_registry_invalid");
  return value;
}
function location(value) {
  if (value === null || typeof value !== "object" || value.machineId !== null && !MACHINE_ID.test(String(value.machineId)) || typeof value.atUtc !== "string" || !Number.isFinite(Date.parse(value.atUtc))) fail8("world_registry_invalid", "location");
  return { machineId: value.machineId, atUtc: value.atUtc };
}
function summary(value) {
  const count = (item) => Number.isSafeInteger(item) && item >= 0 ? item : fail8("world_registry_invalid", "summary");
  const at = value?.lastActivityUtc;
  if (at !== null && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) fail8("world_registry_invalid", "summary");
  return { agents: count(value.agents), quarters: count(value.quarters), tasksOpen: count(value.tasksOpen), lastActivityUtc: at };
}
function projectSummary({ projectId, agents = [], scopes = [], archive = null, tasks = [] }) {
  const archivedQuarters = new Set(Object.keys(archive?.quarters ?? {}));
  const own = agents.filter((agent) => agent?.projectId === projectId);
  const times = own.flatMap((agent) => [agent.createdAtUtc, ...(agent.operations ?? []).map((operation) => operation?.requestedAtUtc)]).filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value))).sort();
  return {
    agents: own.filter((agent) => agent.state !== "archived").length,
    quarters: scopes.filter((scope) => scope?.kind === "quarter" && scope.projectId === projectId && scope.quarterId !== "hq" && !archivedQuarters.has(`${projectId}/${scope.quarterId}`)).length,
    tasksOpen: tasks.filter((task) => !["accepted-by-code", "declined"].includes(task?.stage)).length,
    lastActivityUtc: times.at(-1) ?? null
  };
}
async function recordWorldProjects(controllerRoot, entries) {
  const registry = await readWorldRegistry(controllerRoot);
  for (const entry of entries) {
    if (typeof entry?.projectId !== "string" || !ID5.test(entry.projectId) || entry.projectId === WORLD_PROJECT_ID) {
      fail8("world_registry_invalid", String(entry?.projectId));
    }
    const current = registry.projects[entry.projectId] ?? { title: entry.projectId, policy: { homeOnly: false, allowedMachines: null }, archived: false };
    registry.projects[entry.projectId] = {
      title: typeof entry.title === "string" ? entry.title : current.title,
      policy: entry.policy ? projectPolicy(entry.policy) : current.policy,
      archived: typeof entry.archived === "boolean" ? entry.archived : current.archived,
      location: entry.location === void 0 ? current.location ?? null : entry.location === null ? null : location(entry.location),
      summary: entry.summary !== void 0 ? summary(entry.summary) : current.summary ?? null
    };
  }
  const projects = Object.fromEntries(Object.keys(registry.projects).sort(compare).map((id5) => [id5, registry.projects[id5]]));
  await writeJson2(registryPath(controllerRoot), { schemaVersion: 1, projects });
  return projects;
}
async function unmountedWorldProjects(controllerRoot) {
  if ((await resolveStoreLayout(controllerRoot, { env: {} })).layout !== "split") return [];
  const registry = await readWorldRegistry(controllerRoot);
  const machines = await readMachines(controllerRoot);
  const here = new Set((await mountedProjects(controllerRoot)).map((project) => project.projectId));
  const where = (value) => value === null || value === void 0 ? null : {
    machineId: value.machineId,
    title: value.machineId === null ? null : machines[value.machineId]?.title ?? value.machineId,
    atUtc: value.atUtc
  };
  return Object.entries(registry.projects).filter(([projectId]) => !here.has(projectId)).map(([projectId, entry]) => ({
    projectId,
    title: entry.title,
    archived: entry.archived === true,
    homeOnly: entry.policy?.homeOnly === true,
    allowedMachines: entry.policy?.allowedMachines ?? null,
    location: where(entry.location),
    summary: entry.summary ?? null,
    availability: "not-here"
  })).sort((a, b) => compare(a.projectId, b.projectId));
}
function taskIndexPath(controllerRoot, projectId) {
  return path5.join(controllerRoot, WORLD_FOLDER, TASKS_FOLDER, `${projectFolderName(projectId)}.json`);
}
async function writeWorldTaskIndex(controllerRoot, projectId, { sources, tasks }) {
  const clean = (value) => typeof value === "string" && value.length <= 160 ? value : null;
  await writeJson2(taskIndexPath(controllerRoot, projectId), {
    schemaVersion: 1,
    projectId,
    sources: sources.map((source) => ({ agentId: clean(source.agentId), sourceId: clean(source.sourceId) })).sort((a, b) => compare(String(a.sourceId), String(b.sourceId))),
    tasks: tasks.map((task) => ({
      taskId: clean(task.taskId),
      agentId: clean(task.agentId),
      sourceId: clean(task.sourceId),
      stage: clean(task.stage),
      dispatchedAtUtc: clean(task.dispatchedAtUtc)
    })).sort((a, b) => compare(String(a.taskId), String(b.taskId)))
  });
}
async function removeWorldTaskIndex(controllerRoot, projectId) {
  await rm4(taskIndexPath(controllerRoot, projectId), { force: true });
}
async function readWorldTaskIndexes(controllerRoot) {
  const here = new Set((await mountedProjects(controllerRoot)).map((project) => project.projectId));
  const result = [];
  for (const project of await unmountedWorldProjects(controllerRoot)) {
    const file = taskIndexPath(controllerRoot, project.projectId);
    if (here.has(project.projectId) || !await exists(file)) continue;
    const value = JSON.parse(await readFile5(file, "utf8"));
    if (value?.schemaVersion === 1 && value.projectId === project.projectId) result.push({ ...value, title: project.title });
  }
  return result;
}

// orchestrator/src/project-package-export.mjs
var PROJECT_PACKAGE_EXPORT_VERSION = "v0.1.0";
var PROJECT_PACKAGE_SCHEMA = "agents-factory.project-package/1";
var MANIFEST = "project.af.json";
var DESK = ".desk";
var ID6 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var MEMORY_SCHEMA = 2;
var ARCHIVE_SCHEMAS = /* @__PURE__ */ new Set([1, 2]);
var MEMORY_TABLES = ["memory_documents", "memory_operations", "memory_revisions", "memory_scopes", "memory_write_grants"];
var CATALOG_KEY = "memory-agents-v1";
var ARCHIVE_KEY = "memory-project-archive-v1";
var APPROVALS_KEY = "memory-document-approvals-v1";
var ProjectPackageError = class extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProjectPackageError";
    this.code = code;
  }
};
function fail9(code, detail) {
  throw new ProjectPackageError(code, detail);
}
var sha2565 = (value) => createHash8("sha256").update(value).digest("hex");
var compare2 = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function deskSourceIdOf(agentId) {
  return /^[a-z0-9][a-z0-9-]{0,47}$/u.test(agentId) ? `desk-${agentId}` : `desk-${sha2565(agentId).slice(0, 16)}`;
}
function artifactsKeyOf(agentId) {
  return `agent-artifacts-${sha2565(JSON.stringify(agentId))}`;
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (value === void 0 || typeof value === "function" || typeof value === "symbol") fail9("export_value_invalid");
    if (typeof value === "number" && !Number.isFinite(value)) fail9("export_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === void 0 ? null : item)).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== void 0).sort(compare2).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function jsonLines(records) {
  return records.length === 0 ? "" : `${records.map(canonicalJson).join("\n")}
`;
}
function parsed(text3, what) {
  try {
    return JSON.parse(text3);
  } catch {
    return fail9("export_source_invalid", what);
  }
}
async function exists2(target) {
  return lstat5(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
async function readJsonFile2(target, fallback = null) {
  if (!await exists2(target)) return fallback;
  return parsed(await readFile6(target, "utf8"), path6.basename(target));
}
async function instancePaths(root, projectId, options = {}) {
  const local = path6.join(root, ".project-local");
  const claudeProvider = await readJsonFile2(path6.join(local, "application-gateway", "claude-provider.json"));
  const acpProvider = await readJsonFile2(path6.join(local, "application-gateway", "acp-provider.json"));
  const { layout } = await resolveStoreLayout(root, { env: {} });
  let stores = {
    memoryDb: path6.join(local, "orchestration", "project-memory", "project-memory.v1.sqlite"),
    archiveDb: path6.join(local, "orchestration", "conversation-archive", "archive.v1.sqlite")
  };
  if (layout === "split") {
    const folder = await projectStoreFolder(root, projectId);
    stores = folder === null ? { memoryDb: null, archiveDb: null } : { memoryDb: path6.join(folder, "memory.sqlite"), archiveDb: path6.join(folder, "archive.sqlite") };
  }
  return {
    layout,
    ...stores,
    claudeSessions: path6.join(local, "orchestration", "claude-sessions"),
    acpSessions: path6.join(local, "orchestration", "acp-sessions"),
    claudeConfigDir: options.claudeConfigDir ?? (typeof claudeProvider?.claudeConfigDir === "string" ? claudeProvider.claudeConfigDir : path6.join(local, "claude-account")),
    dshHome: options.dshHome ?? (typeof acpProvider?.home === "string" ? acpProvider.home : path6.join(local, "dsh-home")),
    deskAgents: path6.join(local, "desk-agents"),
    dispatched: path6.join(root, "coordination", "tasks", "dispatched"),
    definitions: path6.join(local, "desk-coordinator", "definitions"),
    returns: path6.join(local, "orchestration", "desk-task-returns"),
    reports: path6.join(root, "knowledge", "reports", "inbox"),
    acceptances: path6.join(root, "coordination", "acceptances"),
    gatewayStatus: path6.join(local, "application-gateway", "status.v1.json"),
    instance: path6.join(root, "instance.json")
  };
}
async function openReadOnly(file) {
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) fail9("memory_sqlite_required");
  return openReadOnlyDatabase(sqlite, file);
}
function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row2) => row2.name));
}
function readMemory(db) {
  const version2 = db.prepare("PRAGMA user_version").get().user_version;
  const tables = tableNames(db);
  if (version2 !== MEMORY_SCHEMA || MEMORY_TABLES.some((name) => !tables.has(name))) {
    fail9("memory_schema_unsupported", `user_version ${version2}`);
  }
  return {
    scopes: db.prepare("SELECT * FROM memory_scopes").all(),
    revisions: db.prepare("SELECT * FROM memory_revisions").all(),
    operations: db.prepare("SELECT * FROM memory_operations").all(),
    grants: db.prepare("SELECT * FROM memory_write_grants").all(),
    documents: db.prepare("SELECT * FROM memory_documents").all()
  };
}
function readArchive(db) {
  const version2 = db.prepare("PRAGMA user_version").get().user_version;
  const tables = tableNames(db);
  if (!ARCHIVE_SCHEMAS.has(version2) || !tables.has("conversations") || !tables.has("entries")) {
    fail9("archive_schema_unsupported", `user_version ${version2}`);
  }
  return {
    version: version2,
    conversations: db.prepare("SELECT * FROM conversations").all(),
    entries: db.prepare("SELECT * FROM entries").all(),
    checkpoints: tables.has("import_checkpoints") ? db.prepare("SELECT * FROM import_checkpoints").all() : []
  };
}
function selectProjectRecords({ memory, archive, projectId }) {
  const world = projectId === WORLD_PROJECT_ID;
  const scopes = memory.scopes.filter((row2) => row2.project_id === projectId).map((row2) => ({
    scopeId: row2.scope_id,
    kind: row2.kind,
    projectId: row2.project_id,
    quarterId: row2.quarter_id,
    title: row2.title,
    currentRevision: row2.current_revision
  })).sort((a, b) => compare2(a.scopeId, b.scopeId));
  let projectScope = scopes.find((scope) => scope.kind === "project") ?? null;
  if (projectScope === null && world) projectScope = { title: "World" };
  if (projectScope === null) fail9("project_not_found", projectId);
  const scopeIds = new Set(scopes.map((scope) => scope.scopeId));
  const scopeProjects = new Map(memory.scopes.map((row2) => [row2.scope_id, row2.project_id]));
  const revisions = memory.revisions.filter((row2) => scopeIds.has(row2.scope_id)).map((row2) => ({
    scopeId: row2.scope_id,
    revision: row2.revision,
    contentSha256: row2.content_sha256,
    entries: parsed(row2.entries_json, "entries_json"),
    author: row2.author,
    updatedAtUtc: row2.updated_at_utc
  })).sort((a, b) => compare2(a.scopeId, b.scopeId) || a.revision - b.revision);
  const operationProject = (result) => {
    if (typeof result?.targetProjectId === "string") return result.targetProjectId;
    if (typeof result?.scopeId === "string") return scopeProjects.get(result.scopeId) ?? null;
    return null;
  };
  const operations = [];
  let unassignedOperations = 0;
  for (const row2 of memory.operations) {
    const result = parsed(row2.result_json, "result_json");
    const owner = operationProject(result);
    if (owner === null) unassignedOperations += 1;
    if (owner !== projectId && !(world && owner === null)) continue;
    operations.push({
      operationId: row2.operation_id,
      operationKind: row2.operation_kind,
      requestSha256: row2.request_sha256,
      result
    });
  }
  operations.sort((a, b) => compare2(a.operationId, b.operationId));
  const grants = memory.grants.filter((row2) => scopeIds.has(row2.scope_id)).map((row2) => ({
    commandId: row2.command_id,
    scopeId: row2.scope_id,
    expectedRevision: row2.expected_revision,
    contentSha256: row2.content_sha256,
    requestedBy: row2.requested_by,
    authorizedAtUtc: row2.authorized_at_utc,
    requestSha256: row2.request_sha256,
    result: parsed(row2.result_json, "grant result_json"),
    consumedOperationId: row2.consumed_operation_id,
    consumedAtUtc: row2.consumed_at_utc
  })).sort((a, b) => compare2(a.commandId, b.commandId));
  const documents = new Map(memory.documents.map((row2) => [
    row2.key,
    { key: row2.key, revision: row2.revision, value: parsed(row2.value_json, row2.key) }
  ]));
  const catalog = documents.get(CATALOG_KEY);
  const allAgents = Array.isArray(catalog?.value?.agents) ? catalog.value.agents : [];
  const agents = allAgents.filter((agent) => agent?.projectId === projectId);
  const owners = /* @__PURE__ */ new Map();
  for (const agent of allAgents) {
    if (typeof agent?.agentId !== "string") continue;
    owners.set(`${APPROVALS_KEY}:${sha2565(agent.agentId).slice(0, 32)}`, agent.projectId);
    owners.set(artifactsKeyOf(agent.agentId), agent.projectId);
  }
  const knownProjects = /* @__PURE__ */ new Set([
    ...memory.scopes.map((row2) => row2.project_id),
    ...allAgents.map((agent) => agent?.projectId).filter((id5) => typeof id5 === "string")
  ]);
  const bindings = new Map([...knownProjects].map((id5) => [`workspace-${sha2565(id5)}`, id5]));
  for (const id5 of knownProjects) {
    try {
      owners.set(journalKeyOf(id5), id5);
      owners.set(namesKeyOf(id5), id5);
      owners.set(tasksKeyOf(id5), id5);
      owners.set(changesKeyOf(id5), id5);
    } catch {
    }
  }
  const exported = [];
  if (catalog) exported.push({ ...catalog, value: { ...catalog.value, agents } });
  const archived = documents.get(ARCHIVE_KEY);
  if (archived) {
    const projects = Object.fromEntries(Object.entries(archived.value?.projects ?? {}).filter(([key]) => key === projectId));
    const quarters = Object.fromEntries(Object.entries(archived.value?.quarters ?? {}).filter(([key]) => key.startsWith(`${projectId}/`)));
    if (Object.keys(projects).length + Object.keys(quarters).length > 0) {
      exported.push({ ...archived, value: { ...archived.value, projects, quarters } });
    }
  }
  const unassignedDocuments = [];
  for (const [key, document] of documents) {
    if (key === CATALOG_KEY || key === ARCHIVE_KEY || bindings.has(key)) continue;
    const owner = owners.get(key) ?? null;
    if (owner === projectId) exported.push(document);
    else if (owner === null) {
      unassignedDocuments.push(key);
      if (world) exported.push(document);
    }
  }
  exported.sort((a, b) => compare2(a.key, b.key));
  unassignedDocuments.sort(compare2);
  const binding = documents.get(`workspace-${sha2565(projectId)}`)?.value ?? null;
  const threads = new Map(allAgents.filter((agent) => agent?.binding?.threadId).map((agent) => [agent.binding.threadId, agent]));
  const conversations = [];
  const entriesByConversation = /* @__PURE__ */ new Map();
  if (archive) {
    const checkpoints = new Map(archive.checkpoints.map((row2) => [row2.conversation_id, row2]));
    for (const row2 of archive.conversations) {
      const bindingValue = parsed(row2.binding, "conversation binding");
      const agent = threads.get(bindingValue?.threadId);
      const owner = agent && agent.binding.providerId === bindingValue.providerId ? agent.projectId : null;
      if (owner !== projectId && !(world && owner === null)) continue;
      const checkpoint = checkpoints.get(row2.id);
      conversations.push({
        conversationId: row2.id,
        binding: bindingValue,
        importCheckpoint: checkpoint ? {
          revision: checkpoint.revision,
          cursor: checkpoint.cursor,
          exhausted: checkpoint.exhausted
        } : null
      });
      entriesByConversation.set(row2.id, []);
    }
    for (const row2 of archive.entries) {
      const list = entriesByConversation.get(row2.conversation_id);
      if (!list) continue;
      list.push({
        sequence: row2.sequence,
        recordId: row2.record_id,
        contentSha256: row2.content_sha256,
        observedAtUtc: row2.observed_at_utc,
        record: parsed(row2.record, "archive record")
      });
    }
    conversations.sort((a, b) => compare2(a.conversationId, b.conversationId));
    for (const list of entriesByConversation.values()) list.sort((a, b) => a.sequence - b.sequence);
  }
  return {
    projectScope,
    scopes,
    revisions,
    operations,
    grants,
    documents: exported,
    agents,
    binding,
    conversations,
    entriesByConversation,
    unassignedDocuments,
    unassignedOperations
  };
}
async function filesOf(folder, skipTop = /* @__PURE__ */ new Set()) {
  const found = [];
  const walk = async (current, relative) => {
    for (const entry of (await readdir3(current, { withFileTypes: true })).sort((a, b) => compare2(a.name, b.name))) {
      if (relative === "" && skipTop.has(entry.name)) continue;
      const full = path6.join(current, entry.name);
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail9("export_link_refused", rel);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) found.push({ full, rel });
    }
  };
  if (await exists2(folder)) await walk(folder, "");
  return found;
}
async function subfolders(folder) {
  if (!await exists2(folder)) return [];
  return (await readdir3(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compare2);
}
async function projectFiles({ layout, agents }) {
  const files = [];
  const add = (target, full) => files.push({ target, full });
  const folder = async (source, target, skipTop) => {
    for (const file of await filesOf(source, skipTop)) add(`${target}/${file.rel}`, file.full);
  };
  const claudeProjects = path6.join(layout.claudeConfigDir, "projects");
  const claudeSlugs = await subfolders(claudeProjects);
  const dshSessions = path6.join(layout.dshHome, "sessions");
  const dshSlugs = await subfolders(dshSessions);
  for (const agent of [...agents].sort((a, b) => compare2(a.agentId, b.agentId))) {
    const threadId = agent.binding?.threadId;
    if (typeof threadId === "string" && ID6.test(threadId)) {
      await folder(path6.join(layout.claudeSessions, threadId), `sessions/claude/${threadId}`);
      await folder(path6.join(layout.acpSessions, threadId), `sessions/acp/${threadId}`);
      for (const slug of claudeSlugs) {
        const transcript = path6.join(claudeProjects, slug, `${threadId}.jsonl`);
        if (await exists2(transcript)) add(`sessions/claude-sdk/${slug}/${threadId}.jsonl`, transcript);
        await folder(path6.join(claudeProjects, slug, threadId), `sessions/claude-sdk/${slug}/${threadId}`);
      }
      for (const slug of dshSlugs) {
        await folder(path6.join(dshSessions, slug, threadId), `sessions/dsh/${slug}/${threadId}`);
      }
      const projcache = path6.join(layout.dshHome, "storages", "session_projcache", "sessions", `${threadId}.json`);
      if (await exists2(projcache)) add(`sessions/dsh-projcache/${threadId}.json`, projcache);
    }
    const sourceId = deskSourceIdOf(agent.agentId);
    await folder(path6.join(layout.deskAgents, sourceId), `desk/agents/${agent.agentId}`, /* @__PURE__ */ new Set(["logs"]));
    await folder(path6.join(layout.reports, sourceId), `desk/reports/${sourceId}`);
    await folder(path6.join(layout.acceptances, sourceId), `desk/acceptances/${sourceId}`);
  }
  const sources = new Set(agents.map((agent) => deskSourceIdOf(agent.agentId)));
  const agentIds = new Set(agents.map((agent) => agent.agentId));
  const taskIds = /* @__PURE__ */ new Set();
  for (const taskId of await subfolders(layout.dispatched)) {
    const task = await readJsonFile2(path6.join(layout.dispatched, taskId, "task.json"));
    if (task && sources.has(task.targetId)) taskIds.add(taskId);
  }
  if (await exists2(layout.returns)) {
    for (const name of (await readdir3(layout.returns)).filter((n) => n.endsWith(".json")).sort(compare2)) {
      const record = await readJsonFile2(path6.join(layout.returns, name));
      if (record && (agentIds.has(record.agentId) || sources.has(record.sourceId))) taskIds.add(name.slice(0, -5));
    }
  }
  for (const taskId of [...taskIds].sort(compare2)) {
    await folder(path6.join(layout.dispatched, taskId), `desk/tasks/dispatched/${taskId}`);
    for (const [source, target] of [[layout.definitions, "definitions"], [layout.returns, "returns"]]) {
      const file = path6.join(source, `${taskId}.json`);
      if (await exists2(file)) add(`desk/tasks/${target}/${taskId}.json`, file);
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const file of files) {
    if (seen.has(file.target)) fail9("export_file_twice", file.target);
    seen.add(file.target);
  }
  return files.sort((a, b) => compare2(a.target, b.target));
}
async function gatewayRunning(statusFile) {
  const status = await readJsonFile2(statusFile);
  if (status === null || status.terminal === true) return false;
  const pid = Number(status.identity?.process?.processId);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function previousManifest(out, projectId) {
  if (!await exists2(out)) return null;
  const manifest = await readJsonFile2(path6.join(out, MANIFEST));
  if (manifest !== null) {
    if (manifest.projectId !== projectId) fail9("package_other_project", manifest.projectId);
    return manifest;
  }
  const present = (await readdir3(out)).filter((name) => ![".git", "workspace"].includes(name));
  if (present.length > 0) fail9("package_folder_not_empty", out);
  return null;
}
async function exportProject({
  controllerRoot,
  projectId,
  out,
  now = () => /* @__PURE__ */ new Date(),
  machineId = null,
  policy = null,
  claudeConfigDir,
  dshHome,
  allowRunningGateway = false
}) {
  if (typeof projectId !== "string" || !ID6.test(projectId)) fail9("project_id_invalid");
  if (typeof out !== "string" || !path6.isAbsolute(out)) fail9("package_folder_invalid");
  const root = await realpath2(controllerRoot);
  const layout = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  if (!allowRunningGateway && await gatewayRunning(layout.gatewayStatus)) fail9("gateway_running");
  if (layout.memoryDb === null) fail9("project_not_found", projectId);
  if (!await exists2(layout.memoryDb)) fail9("memory_store_missing");
  const memoryDb = await openReadOnly(layout.memoryDb);
  let memory;
  try {
    memory = readMemory(memoryDb);
  } finally {
    memoryDb.close();
  }
  let archive = null;
  if (await exists2(layout.archiveDb)) {
    const archiveDb = await openReadOnly(layout.archiveDb);
    try {
      archive = readArchive(archiveDb);
    } finally {
      archiveDb.close();
    }
  }
  const selected = selectProjectRecords({ memory, archive, projectId });
  const busy = selected.agents.filter((agent) => agent.currentOperationId);
  if (busy.length > 0) fail9("project_not_quiescent", busy.map((agent) => agent.agentId).join(","));
  const texts = /* @__PURE__ */ new Map([
    ["memory/scopes.jsonl", jsonLines(selected.scopes)],
    ["memory/revisions.jsonl", jsonLines(selected.revisions)],
    ["memory/operations.jsonl", jsonLines(selected.operations)],
    ["memory/grants.jsonl", jsonLines(selected.grants)],
    ["memory/documents.jsonl", jsonLines(selected.documents)]
  ]);
  if (selected.conversations.length > 0) {
    texts.set("archive/conversations.jsonl", jsonLines(selected.conversations));
    for (const conversation of selected.conversations) {
      const name = conversation.conversationId.replace(/^conversation:/u, "");
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name)) fail9("export_name_invalid", conversation.conversationId);
      texts.set(`archive/entries/${name}.jsonl`, jsonLines(selected.entriesByConversation.get(conversation.conversationId)));
    }
  }
  const copied = await projectFiles({ layout, agents: selected.agents });
  const mapPart = layout.layout === "split" ? path6.join(path6.dirname(layout.memoryDb), "layout.json") : null;
  if (mapPart !== null && await exists2(mapPart)) copied.push({ target: "layout.json", full: mapPart });
  const previous = await previousManifest(out, projectId);
  const recorded = (await readWorldRegistry(root)).projects[projectId]?.policy ?? null;
  const staging = path6.join(out, `${DESK}.export-${process.pid}`);
  await rm5(staging, { recursive: true, force: true });
  const files = {};
  try {
    const put = async (relative, bytes) => {
      const target = path6.join(staging, ...relative.split("/"));
      await mkdir5(path6.dirname(target), { recursive: true });
      await writeFile5(target, bytes);
      files[`${DESK}/${relative}`] = { bytes: bytes.length, sha256: sha2565(bytes) };
    };
    for (const [relative, text3] of texts) await put(relative, Buffer.from(text3, "utf8"));
    for (const file of copied) await put(file.target, await readFile6(file.full));
  } catch (error) {
    await rm5(staging, { recursive: true, force: true });
    throw error;
  }
  const sortedFiles = Object.fromEntries(Object.keys(files).sort(compare2).map((key) => [key, files[key]]));
  const changed = previous === null || canonicalJson(previous.files ?? {}) !== canonicalJson(sortedFiles);
  const instance = await readJsonFile2(layout.instance, {});
  const boundPath = typeof selected.binding?.workspacePath === "string" ? selected.binding.workspacePath : null;
  const ownWorkspace = path6.join(out, "workspace");
  const manifest = {
    schema: PROJECT_PACKAGE_SCHEMA,
    projectId,
    title: selected.projectScope.title,
    worldId: typeof instance?.instanceId === "string" ? instance.instanceId : null,
    policy: policy ?? recorded ?? previous?.policy ?? { homeOnly: false, allowedMachines: null },
    workspace: {
      folder: "workspace",
      external: boundPath !== null && path6.resolve(boundPath).toLowerCase() !== path6.resolve(ownWorkspace).toLowerCase(),
      boundPathHint: boundPath,
      workspaceKey: selected.binding?.workspaceKey ?? null
    },
    storeSchemas: { memory: MEMORY_SCHEMA, archive: selected.conversations.length > 0 ? 2 : null },
    export: changed ? {
      revision: (previous?.export?.revision ?? 0) + 1,
      exportedAtUtc: now().toISOString(),
      exportedBy: machineId,
      exporter: PROJECT_PACKAGE_EXPORT_VERSION,
      sourceLayout: layout.layout
    } : previous.export,
    lock: previous?.lock ?? null,
    counts: {
      scopes: selected.scopes.length,
      revisions: selected.revisions.length,
      operations: selected.operations.length,
      grants: selected.grants.length,
      documents: selected.documents.length,
      agents: selected.agents.length,
      conversations: selected.conversations.length,
      entries: [...selected.entriesByConversation.values()].reduce((sum, list) => sum + list.length, 0),
      copiedFiles: copied.length
    },
    files: sortedFiles
  };
  await rm5(path6.join(out, DESK), { recursive: true, force: true });
  await rename5(staging, path6.join(out, DESK));
  await writeFile5(path6.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}
`, "utf8");
  return {
    projectId,
    out,
    changed,
    revision: manifest.export.revision,
    counts: manifest.counts,
    unassignedDocuments: selected.unassignedDocuments,
    unassignedOperations: selected.unassignedOperations
  };
}

// orchestrator/src/project-package-import.mjs
import { createHash as createHash10, randomUUID as randomUUID6 } from "node:crypto";
import { copyFile, lstat as lstat7, mkdir as mkdir7, readFile as readFile8, readdir as readdir5, realpath as realpath4, rename as rename8, rm as rm6, writeFile as writeFile6 } from "node:fs/promises";
import path11 from "node:path";

// orchestrator/src/conversation-archive-store-node.mjs
import path7 from "node:path";
var ArchiveFailure = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
};
function fail10(code) {
  throw new ArchiveFailure(code);
}
var encoded = (value) => pythonJson(value, { sortKeys: true });
function loads(text3) {
  if (typeof text3 !== "string") throw new PythonError("TypeError", "the JSON object must be str, bytes or bytearray");
  return JSON.parse(text3);
}
function initialize(db, projectId) {
  const version2 = db.value("PRAGMA user_version");
  if (![0, 1, 2].includes(version2)) fail10("archive_unsupported_schema");
  if (version2 === 0) {
    if (db.get("SELECT name FROM sqlite_master WHERE type='table'") !== null) fail10("archive_unsupported_schema");
    db.exec("CREATE TABLE archive_meta (project_id TEXT NOT NULL)");
    db.run("INSERT INTO archive_meta VALUES (?)", [projectId]);
    db.exec(`CREATE TABLE conversations (
            id TEXT PRIMARY KEY, binding TEXT NOT NULL)`);
    db.exec(`CREATE TABLE entries (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            record_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
            observed_at_utc TEXT NOT NULL, record TEXT NOT NULL)`);
    db.exec("CREATE INDEX entries_conversation ON entries(conversation_id, record_id, sequence)");
    db.exec("PRAGMA user_version=1");
  }
  const row2 = db.get("SELECT project_id FROM archive_meta");
  if (row2 === null || !pyEquals(row2.project_id, projectId)) fail10("archive_identity_conflict");
  if (version2 < 2) {
    db.exec(`CREATE TABLE import_checkpoints (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
            revision INTEGER NOT NULL, cursor TEXT, exhausted INTEGER NOT NULL)`);
    db.exec("PRAGMA user_version=2");
  }
}
function checkScope(db, payload, create = false) {
  const identity = pyItem(payload, "conversationId");
  const binding = pyItem(payload, "binding");
  if (!pyEquals(pyItem(binding, "projectId"), pyItem(payload, "projectId"))) fail10("archive_identity_conflict");
  const serialized = encoded(binding);
  const row2 = db.get("SELECT binding FROM conversations WHERE id=?", [identity]);
  if (row2 !== null && row2.binding !== serialized) fail10("archive_identity_conflict");
  if (row2 === null && create) db.run("INSERT INTO conversations VALUES (?,?)", [identity, serialized]);
  return identity;
}
function append(db, payload) {
  const identity = checkScope(db, payload, true);
  const record = pyItem(payload, "record");
  const latest = db.get(
    `SELECT sequence, content_sha256, record FROM entries
        WHERE conversation_id=? AND record_id=? ORDER BY sequence DESC LIMIT 1`,
    [identity, pyItem(record, "recordId")]
  );
  if (latest !== null && pyEquals(latest.content_sha256, pyItem(payload, "contentSha256"))) {
    return { conversationId: identity, sequence: latest.sequence, replay: true, contentSha256: latest.content_sha256 };
  }
  if (latest !== null && (pyEquals(pyItem(record, "kind"), "submission") || pyEquals(pyItem(loads(latest.record), "kind"), "submission"))) {
    fail10("archive_identity_conflict");
  }
  const inserted = db.run(`INSERT INTO entries
        (conversation_id,record_id,content_sha256,observed_at_utc,record)
        VALUES (?,?,?,?,?)`, [
    identity,
    record.recordId,
    pyItem(payload, "contentSha256"),
    pyItem(payload, "observedAtUtc"),
    encoded(record)
  ]);
  return {
    conversationId: identity,
    sequence: inserted.lastInsertRowid,
    replay: false,
    contentSha256: payload.contentSha256
  };
}
function comparable(value) {
  if (typeof value === "boolean") return Number(value);
  if (typeof value !== "number") {
    throw new PythonError("TypeError", `'>' not supported between instances of '${pyTypeName(value)}' and 'int'`);
  }
  return value;
}
function readPage(db, payload) {
  const identity = checkScope(db, payload);
  const current = db.value(
    "SELECT COALESCE(MAX(sequence),0) AS current FROM entries WHERE conversation_id=?",
    [identity]
  );
  const requested = pyItem(payload, "revision");
  const revision2 = requested !== null ? requested : current;
  if (comparable(revision2) > current || comparable(revision2) < 0 || comparable(pyItem(payload, "after")) > revision2) {
    fail10("archive_invalid_cursor");
  }
  const limit = comparable(pyItem(payload, "limit"));
  const rows = db.all(
    `WITH versions AS (
        SELECT record_id, MIN(sequence) AS first_sequence, MAX(sequence) AS latest
        FROM entries WHERE conversation_id=? AND sequence<=? GROUP BY record_id)
        SELECT versions.first_sequence, entries.sequence, entries.content_sha256,
               entries.observed_at_utc, entries.record
        FROM versions JOIN entries ON entries.sequence=versions.latest
        WHERE versions.first_sequence>? ORDER BY versions.first_sequence LIMIT ?`,
    [identity, revision2, payload.after, limit + 1]
  );
  if (!Number.isInteger(limit)) {
    throw new PythonError("TypeError", "slice indices must be integers or None or have an __index__ method");
  }
  const items = [];
  let size = 0;
  for (const row2 of rows.slice(0, limit < 0 ? Math.max(rows.length + limit, 0) : limit)) {
    const item = {
      firstSequence: row2.first_sequence,
      sequence: row2.sequence,
      contentSha256: row2.content_sha256,
      observedAtUtc: row2.observed_at_utc,
      record: loads(row2.record)
    };
    const itemSize = utf8(encoded(item)).length;
    if (items.length > 0 && size + itemSize > 524288) break;
    items.push(item);
    size += itemSize;
  }
  return { revision: revision2, items, nextAfter: rows.length > items.length ? items.at(-1).firstSequence : null };
}
function importState(db, payload) {
  const identity = checkScope(db, payload);
  const row2 = db.get("SELECT revision,cursor,exhausted FROM import_checkpoints WHERE conversation_id=?", [identity]);
  return row2 !== null ? { revision: row2.revision, cursor: row2.cursor, exhausted: Boolean(row2.exhausted) } : { revision: 0, cursor: null, exhausted: false };
}
function checkpointImport(db, payload) {
  const current = importState(db, payload);
  if (!pyEquals(current.revision, pyItem(payload, "expectedRevision"))) return false;
  const identity = checkScope(db, payload, true);
  const nextCursor = pyItem(payload, "nextCursor");
  db.run(
    `INSERT INTO import_checkpoints VALUES (?,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET
        revision=excluded.revision,cursor=excluded.cursor,exhausted=excluded.exhausted`,
    [identity, current.revision + 1, nextCursor, nextCursor === null]
  );
  return true;
}
var IMPORT_ROWS = {
  conversations: (db, row2) => db.run("INSERT INTO conversations VALUES (?,?)", [row2.conversationId, encoded(row2.binding)]),
  entries: (db, row2) => db.run(
    `INSERT INTO entries
        (sequence,conversation_id,record_id,content_sha256,observed_at_utc,record) VALUES (?,?,?,?,?,?)`,
    [row2.sequence, row2.conversationId, row2.recordId, row2.contentSha256, row2.observedAtUtc, encoded(row2.record)]
  ),
  checkpoints: (db, row2) => db.run(
    "INSERT INTO import_checkpoints VALUES (?,?,?,?)",
    [row2.conversationId, row2.revision, row2.cursor, row2.exhausted]
  )
};
function importRows(db, payload) {
  const insert = IMPORT_ROWS[pyItem(payload, "table")];
  const rows = pyItem(payload, "rows");
  if (insert === void 0 || !Array.isArray(rows) || rows.some((row2) => !isDict(row2))) fail10("archive_invalid_input");
  try {
    for (const row2 of rows) insert(db, row2);
  } catch (error) {
    if (/constraint/iu.test(String(error?.message))) fail10("archive_identity_conflict");
    throw error;
  }
  return { schemaVersion: 1, imported: rows.length };
}
var COMMANDS = /* @__PURE__ */ new Set(["init", "append", "read", "import-state", "checkpoint-import", "import-rows"]);
var OPERATIONS = {
  append,
  read: readPage,
  "import-state": importState,
  "checkpoint-import": checkpointImport,
  "import-rows": importRows
};
var MAX_PAYLOAD_BYTES = 2097152;
function run(sqlite, database, command, payload) {
  if (!COMMANDS.has(command) || !isDict(payload)) fail10("archive_invalid_input");
  const db = new NodeSqliteConnection(sqlite, database, { timeoutMs: 1e4 });
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA synchronous=FULL");
    db.exec(command === "read" || command === "import-state" ? "BEGIN" : "BEGIN IMMEDIATE");
    let result;
    try {
      if (command === "init") {
        initialize(db, pyItem(payload, "projectId"));
        result = { schemaVersion: 1, ready: true };
      } else {
        if (db.value("PRAGMA user_version") !== 2) fail10("archive_unsupported_schema");
        const meta = db.get("SELECT project_id FROM archive_meta");
        if (meta === null) throw new PythonError("TypeError", "'NoneType' object is not subscriptable");
        if (!pyEquals(meta.project_id, pyItem(payload, "projectId"))) fail10("archive_identity_conflict");
        result = OPERATIONS[command](db, payload);
      }
    } catch (error) {
      db.rollback();
      throw error;
    }
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
function errorCode(error) {
  return error instanceof ArchiveFailure ? error.code : "archive_unavailable";
}
function bridgeFailure(command, code, detail = "") {
  const error = new Error(`SQLite bridge '${command}' failed: ${code}${detail ? ` (${detail})` : ""}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}
`;
  return error;
}
var NodeConversationArchiveBridge = class {
  #closed = false;
  constructor({ databasePath, sqlite }) {
    if (!databasePath || typeof sqlite?.DatabaseSync !== "function") {
      throw new Error("NodeConversationArchiveBridge requires databasePath and node:sqlite");
    }
    this.databasePath = path7.resolve(databasePath);
    this.sqlite = sqlite;
    this.sqliteBackend = "node";
  }
  async invoke(command, payload = {}) {
    if (this.#closed) throw bridgeFailure(command, "archive_unavailable", "closed");
    let result;
    try {
      const request = jsonTransport(payload);
      if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > MAX_PAYLOAD_BYTES) fail10("archive_invalid_input");
      result = run(this.sqlite, this.databasePath, command, request);
    } catch (error) {
      throw bridgeFailure(command, errorCode(error));
    }
    return sortedTransport(result);
  }
  /** Nothing stays open between requests; later calls fail as after the bridge closed. */
  async close() {
    this.#closed = true;
  }
};

// orchestrator/src/project-memory-store-node.mjs
import path8 from "node:path";
var MemoryFailure = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
};
function fail11(code) {
  throw new MemoryFailure(code);
}
var TABLES = ["memory_documents", "memory_operations", "memory_revisions", "memory_scopes", "memory_write_grants"];
var SCHEMA_VERSION = 2;
var scopesTable = (name) => `CREATE TABLE ${name} (
        scope_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('project','quarter','agent')),
        project_id TEXT NOT NULL,
        quarter_id TEXT,
        title TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        CHECK ((kind='project' AND quarter_id IS NULL)
            OR (kind IN ('quarter','agent') AND quarter_id IS NOT NULL)))`;
var SCOPE_COLUMNS = "scope_id,kind,project_id,quarter_id,title,current_revision";
var encoded2 = (value) => pythonJson(value, { sortKeys: true });
var valueSha256 = (value) => sha256Hex(encoded2(value));
function decodedStored(value) {
  try {
    if (typeof value !== "string") throw new TypeError("not text");
    return JSON.parse(value);
  } catch {
    return fail11("memory_identity_conflict");
  }
}
function presentTables(db) {
  return new Set(db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((row2) => row2.name));
}
function scopeIndexes(db) {
  db.exec(`CREATE UNIQUE INDEX one_project_memory_scope
        ON memory_scopes(project_id) WHERE kind='project'`);
  db.exec(`CREATE UNIQUE INDEX one_quarter_memory_scope
        ON memory_scopes(project_id,quarter_id) WHERE kind='quarter'`);
}
function migrateV1(db) {
  db.exec(scopesTable("memory_scopes_v2"));
  db.exec(`INSERT INTO memory_scopes_v2 SELECT ${SCOPE_COLUMNS} FROM memory_scopes`);
  db.exec("DROP TABLE memory_scopes");
  db.exec("ALTER TABLE memory_scopes_v2 RENAME TO memory_scopes");
  scopeIndexes(db);
  if (db.get("PRAGMA foreign_key_check") !== null) fail11("memory_unsupported_schema");
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
}
function initialize2(db) {
  const version2 = db.value("PRAGMA user_version");
  if (![0, 1, SCHEMA_VERSION].includes(version2)) fail11("memory_unsupported_schema");
  if (version2 === 1 || version2 === SCHEMA_VERSION) {
    const present = presentTables(db);
    if (present.size !== TABLES.length || TABLES.some((name) => !present.has(name))) {
      fail11("memory_unsupported_schema");
    }
    if (version2 === 1) migrateV1(db);
    return;
  }
  const existing = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (existing !== null) fail11("memory_unsupported_schema");
  db.exec(scopesTable("memory_scopes"));
  scopeIndexes(db);
  db.exec(`CREATE TABLE memory_revisions (
        scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        content_sha256 TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        author TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        PRIMARY KEY (scope_id,revision))`);
  db.exec(`CREATE TABLE memory_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','write')),
        request_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL)`);
  db.exec(`CREATE TABLE memory_write_grants (
        command_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
        expected_revision INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        authorized_at_utc TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        consumed_operation_id TEXT UNIQUE,
        consumed_at_utc TEXT)`);
  db.exec(`CREATE TABLE memory_documents (
        key TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        value_json TEXT NOT NULL)`);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
}
function verifyHash(payload, fields) {
  const expected = valueSha256(Object.fromEntries(fields.map((field) => [field, pyItem(payload, field)])));
  if (!pyEquals(payload.requestSha256 ?? null, expected)) fail11("memory_invalid_input");
}
function operationReplay(db, operationId, kind2, requestSha256) {
  const row2 = db.get(
    "SELECT operation_kind,request_sha256,result_json FROM memory_operations WHERE operation_id=?",
    [operationId]
  );
  if (row2 === null) return null;
  if (!pyEquals(row2.operation_kind, kind2) || !pyEquals(row2.request_sha256, requestSha256)) {
    fail11("memory_operation_conflict");
  }
  return decodedStored(row2.result_json);
}
function scopeRecord(db, scopeId) {
  const row2 = db.get(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE scope_id=?`, [scopeId]);
  if (row2 === null) fail11("memory_scope_not_found");
  return row2;
}
function scopeDto(db, scope, requestedRevision = null) {
  const selected = requestedRevision === null ? scope.current_revision : requestedRevision;
  const row2 = db.get("SELECT content_sha256,entries_json,author,updated_at_utc FROM memory_revisions WHERE scope_id=? AND revision=?", [scope.scope_id, selected]);
  if (row2 === null) fail11("memory_revision_not_found");
  const entries = decodedStored(row2.entries_json);
  if (!pyEquals(valueSha256(entries), row2.content_sha256)) fail11("memory_identity_conflict");
  return {
    schemaVersion: 1,
    scopeId: scope.scope_id,
    kind: scope.kind,
    projectId: scope.project_id,
    quarterId: scope.quarter_id,
    title: scope.title,
    revision: selected,
    sha256: row2.content_sha256,
    entries,
    author: row2.author,
    updatedAtUtc: row2.updated_at_utc
  };
}
function scopeMetadata(dto) {
  const { entries: _entries, ...metadata } = dto;
  return metadata;
}
function createScope(db, payload) {
  verifyHash(payload, ["scopeId", "kind", "projectId", "quarterId", "title", "operationId"]);
  const replay = operationReplay(db, pyItem(payload, "operationId"), "create", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  if (!pyEquals(pyItem(payload, "contentSha256"), valueSha256([]))) fail11("memory_invalid_input");
  if (db.get("SELECT 1 AS present FROM memory_scopes WHERE scope_id=?", [payload.scopeId]) !== null) {
    fail11("memory_scope_conflict");
  }
  let logical;
  if (pyEquals(payload.kind, "project")) {
    logical = db.get(
      "SELECT 1 AS present FROM memory_scopes WHERE kind='project' AND project_id=?",
      [payload.projectId]
    );
  } else if (pyEquals(payload.kind, "agent")) {
    if (db.get(
      "SELECT 1 AS present FROM memory_scopes WHERE kind='quarter' AND project_id=? AND quarter_id=?",
      [payload.projectId, payload.quarterId]
    ) === null) fail11("memory_scope_not_found");
    logical = null;
  } else {
    const parent = db.get(
      "SELECT 1 AS present FROM memory_scopes WHERE kind='project' AND project_id=?",
      [payload.projectId]
    );
    if (parent === null) fail11("memory_project_scope_required");
    logical = db.get(
      "SELECT 1 AS present FROM memory_scopes WHERE kind='quarter' AND project_id=? AND quarter_id=?",
      [payload.projectId, payload.quarterId]
    );
  }
  if (logical !== null) fail11("memory_scope_conflict");
  try {
    db.run(
      "INSERT INTO memory_scopes VALUES (?,?,?,?,?,1)",
      [payload.scopeId, payload.kind, payload.projectId, payload.quarterId, payload.title]
    );
    db.run(
      "INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
      [payload.scopeId, 1, pyItem(payload, "contentSha256"), encoded2([]), "system", pyItem(payload, "updatedAtUtc")]
    );
  } catch (error) {
    if (isIntegrityError(error)) fail11("memory_scope_conflict");
    throw error;
  }
  const result = scopeDto(db, scopeRecord(db, payload.scopeId));
  db.run(
    "INSERT INTO memory_operations VALUES (?,?,?,?)",
    [payload.operationId, "create", payload.requestSha256, encoded2(result)]
  );
  return result;
}
function pySet(value) {
  return new Set(pyIter(value).map(pyHashKey));
}
function sameSet(left, right) {
  return left.size === right.size && [...left].every((key) => right.has(key));
}
function dictValues(value) {
  if (!isDict(value)) throw new PythonError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'values'`);
  return Object.values(value);
}
var COPY_FIELDS = ["sourceProjectId", "targetProjectId", "targetProjectScopeId", "quarterScopeIds", "operationId"];
function copyProject(db, payload) {
  verifyHash(payload, COPY_FIELDS);
  if (pyEquals(payload.sourceProjectId, payload.targetProjectId)) fail11("memory_invalid_input");
  const replay = operationReplay(db, payload.operationId, "create", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  const rows = db.all(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE project_id=? AND kind IN ('project','quarter') ORDER BY CASE kind WHEN 'project' THEN 0 ELSE 1 END, quarter_id,scope_id LIMIT 513`, [payload.sourceProjectId]);
  return copyRows(db, payload, rows.map((row2) => ({ row: row2, source: () => scopeDto(db, row2) })));
}
function copyProjectFrom(db, payload) {
  verifyHash(payload, COPY_FIELDS);
  if (pyEquals(payload.sourceProjectId, payload.targetProjectId)) fail11("memory_invalid_input");
  const replay = operationReplay(db, payload.operationId, "create", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  const sources = pyItem(payload, "sources");
  if (!Array.isArray(sources) || sources.length > 513) fail11("memory_invalid_input");
  return copyRows(db, payload, sources.map((source) => {
    if (!isDict(source) || !["project", "quarter"].includes(source.kind) || !pyEquals(source.projectId, payload.sourceProjectId) || !pyEquals(valueSha256(source.entries), source.sha256)) fail11("memory_invalid_input");
    return {
      row: { scope_id: source.scopeId, kind: source.kind, quarter_id: source.quarterId, title: source.title },
      source: () => source
    };
  }));
}
function copyRows(db, payload, rows) {
  if (rows.length === 0 || rows[0].row.kind !== "project") fail11("memory_project_scope_required");
  if (rows.length > 512 || rows.filter(({ row: row2 }) => row2.kind === "project").length !== 1) fail11("memory_limit_exceeded");
  if (db.get("SELECT 1 AS present FROM memory_scopes WHERE project_id=? LIMIT 1", [payload.targetProjectId]) !== null) {
    fail11("memory_scope_conflict");
  }
  const expectedQuarters = new Set(rows.filter(({ row: row2 }) => row2.kind === "quarter").map(({ row: row2 }) => pyHashKey(row2.quarter_id)));
  if (!sameSet(pySet(payload.quarterScopeIds), expectedQuarters)) fail11("memory_invalid_input");
  const targets = [payload.targetProjectScopeId, ...dictValues(payload.quarterScopeIds)];
  if (new Set(targets.map(pyHashKey)).size !== targets.length) fail11("memory_invalid_input");
  for (const target of targets) {
    if (db.get("SELECT 1 AS present FROM memory_scopes WHERE scope_id=?", [target]) !== null) {
      fail11("memory_scope_conflict");
    }
  }
  const copied = [];
  for (const { row: row2, source: read } of rows) {
    const source = read();
    const target = row2.kind === "project" ? payload.targetProjectScopeId : pyItem(payload.quarterScopeIds, row2.quarter_id);
    db.run(
      "INSERT INTO memory_scopes VALUES (?,?,?,?,?,1)",
      [target, row2.kind, payload.targetProjectId, row2.quarter_id, row2.title]
    );
    db.run(
      "INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
      [target, 1, source.sha256, encoded2(source.entries), "system", pyItem(payload, "copiedAtUtc")]
    );
    copied.push({
      sourceScopeId: row2.scope_id,
      targetScopeId: target,
      kind: row2.kind,
      quarterId: row2.quarter_id,
      sourceRevision: source.revision,
      sourceSha256: source.sha256,
      targetRevision: 1,
      targetSha256: source.sha256
    });
  }
  const result = {
    schemaVersion: 1,
    outcome: "complete",
    sourceProjectId: payload.sourceProjectId,
    targetProjectId: payload.targetProjectId,
    operationId: payload.operationId,
    scopes: copied,
    copiedAtUtc: payload.copiedAtUtc
  };
  db.run(
    "INSERT INTO memory_operations VALUES (?,?,?,?)",
    [payload.operationId, "create", payload.requestSha256, encoded2(result)]
  );
  return result;
}
function readScope(db, payload) {
  return scopeDto(db, scopeRecord(db, pyItem(payload, "scopeId")), pyItem(payload, "revision"));
}
function pyIntOperand(value) {
  if (typeof value === "boolean") return Number(value);
  if (typeof value !== "number") {
    throw new PythonError("TypeError", `unsupported operand type(s) for +: '${pyTypeName(value)}' and 'int'`);
  }
  return value;
}
function listScopes(db, payload) {
  const parameters = [];
  let where = "WHERE kind IN ('project','quarter')";
  if (pyItem(payload, "projectId") !== null) {
    where += " AND project_id=?";
    parameters.push(payload.projectId);
  }
  const limit = pyItem(payload, "limit");
  parameters.push(pyIntOperand(limit) + 1);
  const rows = db.all(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes ${where} ORDER BY project_id, CASE kind WHEN 'project' THEN 0 ELSE 1 END, quarter_id, scope_id LIMIT ?`, parameters);
  if (!pyIsInt(limit) && typeof limit !== "boolean") {
    throw new PythonError("TypeError", "slice indices must be integers or None or have an __index__ method");
  }
  const end = Number(limit);
  const visible = rows.slice(0, end < 0 ? Math.max(rows.length + end, 0) : end);
  return {
    schemaVersion: 1,
    scopes: visible.map((row2) => scopeMetadata(scopeDto(db, row2))),
    truncated: rows.length > visible.length
  };
}
function authorizeWrite(db, payload) {
  verifyHash(payload, ["commandId", "scopeId", "expectedRevision", "contentSha256", "requestedBy"]);
  const row2 = db.get(
    "SELECT request_sha256,result_json FROM memory_write_grants WHERE command_id=?",
    [payload.commandId]
  );
  if (row2 !== null) {
    if (!pyEquals(row2.request_sha256, pyItem(payload, "requestSha256"))) fail11("memory_command_conflict");
    return decodedStored(row2.result_json);
  }
  const scope = scopeRecord(db, payload.scopeId);
  if (!pyEquals(scope.current_revision, payload.expectedRevision)) fail11("memory_revision_conflict");
  const result = {
    schemaVersion: 1,
    commandId: payload.commandId,
    scopeId: payload.scopeId,
    expectedRevision: payload.expectedRevision,
    contentSha256: payload.contentSha256,
    requestedBy: payload.requestedBy,
    authorizedAtUtc: pyItem(payload, "authorizedAtUtc")
  };
  db.run("INSERT INTO memory_write_grants (command_id,scope_id,expected_revision,content_sha256,requested_by,authorized_at_utc,request_sha256,result_json) VALUES (?,?,?,?,?,?,?,?)", [
    payload.commandId,
    payload.scopeId,
    payload.expectedRevision,
    payload.contentSha256,
    payload.requestedBy,
    payload.authorizedAtUtc,
    pyItem(payload, "requestSha256"),
    encoded2(result)
  ]);
  return result;
}
function writeScope(db, payload) {
  verifyHash(payload, ["scopeId", "expectedRevision", "entries", "operationId", "commandId", "actorId"]);
  if (!pyEquals(valueSha256(payload.entries), pyItem(payload, "contentSha256"))) fail11("memory_invalid_input");
  const replay = operationReplay(db, payload.operationId, "write", pyItem(payload, "requestSha256"));
  if (replay !== null) return replay;
  const grant = db.get("SELECT scope_id,expected_revision,content_sha256,consumed_operation_id FROM memory_write_grants WHERE command_id=?", [payload.commandId]);
  if (grant === null) fail11("memory_authorization_required");
  if (!pyEquals(grant.scope_id, payload.scopeId) || !pyEquals(grant.expected_revision, payload.expectedRevision) || !pyEquals(grant.content_sha256, payload.contentSha256)) {
    fail11("memory_authorization_mismatch");
  }
  if (grant.consumed_operation_id !== null) fail11("memory_authorization_consumed");
  const scope = scopeRecord(db, payload.scopeId);
  if (!pyEquals(scope.current_revision, payload.expectedRevision)) fail11("memory_revision_conflict");
  const nextRevision = pyIntOperand(payload.expectedRevision) + 1;
  try {
    db.run("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)", [
      payload.scopeId,
      nextRevision,
      payload.contentSha256,
      encoded2(payload.entries),
      payload.actorId,
      pyItem(payload, "updatedAtUtc")
    ]);
    const updated = db.run(
      "UPDATE memory_scopes SET current_revision=? WHERE scope_id=? AND current_revision=?",
      [nextRevision, payload.scopeId, payload.expectedRevision]
    );
    if (updated.changes !== 1) fail11("memory_revision_conflict");
    const consumed = db.run(
      "UPDATE memory_write_grants SET consumed_operation_id=?,consumed_at_utc=? WHERE command_id=? AND consumed_operation_id IS NULL",
      [payload.operationId, payload.updatedAtUtc, payload.commandId]
    );
    if (consumed.changes !== 1) fail11("memory_authorization_consumed");
  } catch (error) {
    if (isIntegrityError(error)) fail11("memory_revision_conflict");
    throw error;
  }
  const result = {
    schemaVersion: 1,
    operationId: payload.operationId,
    commandId: payload.commandId,
    scopeId: payload.scopeId,
    previousRevision: payload.expectedRevision,
    revision: nextRevision,
    sha256: payload.contentSha256,
    // actorId is attribution only; the consumed control grant is write authority.
    author: payload.actorId,
    updatedAtUtc: payload.updatedAtUtc
  };
  db.run(
    "INSERT INTO memory_operations VALUES (?,?,?,?)",
    [payload.operationId, "write", payload.requestSha256, encoded2(result)]
  );
  return result;
}
function readPair(db, payload) {
  const project = db.get(
    `SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE kind='project' AND project_id=?`,
    [pyItem(payload, "projectId")]
  );
  const quarter = db.get(
    `SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE kind='quarter' AND project_id=? AND quarter_id=?`,
    [payload.projectId, pyItem(payload, "quarterId")]
  );
  if (project === null || quarter === null) fail11("memory_scope_not_found");
  return { project: scopeDto(db, project), quarter: scopeDto(db, quarter) };
}
function readScopeSet(db, payload) {
  const scopeIds = pyItem(payload, "scopeIds");
  if (!Array.isArray(scopeIds) || scopeIds.length > 128) fail11("memory_invalid_input");
  const scopes = [];
  for (const scopeId of scopeIds) {
    const row2 = db.get(`SELECT ${SCOPE_COLUMNS} FROM memory_scopes WHERE scope_id=?`, [scopeId]);
    if (row2 !== null) scopes.push(scopeDto(db, row2));
  }
  return { schemaVersion: 1, scopes };
}
function readDocument(db, payload) {
  const row2 = db.get("SELECT revision,value_json FROM memory_documents WHERE key=?", [pyItem(payload, "key")]);
  if (row2 === null) return null;
  return { revision: row2.revision, value: decodedStored(row2.value_json) };
}
function compareAndSwapDocument(db, payload) {
  const row2 = db.get("SELECT revision FROM memory_documents WHERE key=?", [pyItem(payload, "key")]);
  const current = row2 === null ? 0 : row2.revision;
  if (!pyEquals(current, pyItem(payload, "expectedRevision"))) return false;
  const nextRevision = current + 1;
  const serialized = encoded2(pyItem(payload, "value"));
  if (row2 === null) {
    db.run("INSERT INTO memory_documents VALUES (?,?,?)", [payload.key, nextRevision, serialized]);
  } else {
    const updated = db.run(
      "UPDATE memory_documents SET revision=?,value_json=? WHERE key=? AND revision=?",
      [nextRevision, serialized, payload.key, current]
    );
    if (updated.changes !== 1) return false;
  }
  return true;
}
var IMPORT_ROWS2 = {
  scopes: (db, row2) => db.run(
    "INSERT INTO memory_scopes VALUES (?,?,?,?,?,?)",
    [row2.scopeId, row2.kind, row2.projectId, row2.quarterId, row2.title, row2.currentRevision]
  ),
  revisions: (db, row2) => {
    if (!pyEquals(valueSha256(row2.entries), row2.contentSha256)) fail11("memory_identity_conflict");
    db.run(
      "INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
      [row2.scopeId, row2.revision, row2.contentSha256, encoded2(row2.entries), row2.author, row2.updatedAtUtc]
    );
  },
  operations: (db, row2) => db.run(
    "INSERT INTO memory_operations VALUES (?,?,?,?)",
    [row2.operationId, row2.operationKind, row2.requestSha256, encoded2(row2.result)]
  ),
  grants: (db, row2) => db.run(
    "INSERT INTO memory_write_grants VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      row2.commandId,
      row2.scopeId,
      row2.expectedRevision,
      row2.contentSha256,
      row2.requestedBy,
      row2.authorizedAtUtc,
      row2.requestSha256,
      encoded2(row2.result),
      row2.consumedOperationId,
      row2.consumedAtUtc
    ]
  ),
  documents: (db, row2) => db.run(
    "INSERT INTO memory_documents VALUES (?,?,?)",
    [row2.key, row2.revision, encoded2(row2.value)]
  )
};
function importRows2(db, payload) {
  const insert = IMPORT_ROWS2[pyItem(payload, "table")];
  const rows = pyItem(payload, "rows");
  if (insert === void 0 || !Array.isArray(rows) || rows.some((row2) => !isDict(row2))) fail11("memory_invalid_input");
  try {
    for (const row2 of rows) insert(db, row2);
  } catch (error) {
    if (isIntegrityError(error)) fail11("memory_identity_conflict");
    throw error;
  }
  return { schemaVersion: 1, imported: rows.length };
}
var READ_COMMANDS = /* @__PURE__ */ new Set(["read-scope", "list-scopes", "read-pair", "read-scope-set", "read-document"]);
var OPERATIONS2 = {
  "create-scope": createScope,
  "copy-project": copyProject,
  "copy-project-from": copyProjectFrom,
  "import-rows": importRows2,
  "read-scope": readScope,
  "list-scopes": listScopes,
  "authorize-write": authorizeWrite,
  write: writeScope,
  "read-pair": readPair,
  "read-scope-set": readScopeSet,
  "read-document": readDocument,
  "compare-and-swap-document": compareAndSwapDocument
};
var MAX_PAYLOAD_BYTES2 = 524288;
function run2(sqlite, database, command, payload) {
  if (command !== "init" && !Object.hasOwn(OPERATIONS2, command)) fail11("memory_invalid_input");
  if (!isDict(payload)) fail11("memory_invalid_input");
  const db = new NodeSqliteConnection(sqlite, database, { timeoutMs: 1e4 });
  try {
    db.exec(command === "init" ? "PRAGMA foreign_keys=OFF" : "PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=10000");
    db.exec("PRAGMA synchronous=FULL");
    if (command === "init") db.exec("PRAGMA journal_mode=WAL");
    db.exec(READ_COMMANDS.has(command) ? "BEGIN" : "BEGIN IMMEDIATE");
    let result;
    try {
      if (command === "init") {
        initialize2(db);
        result = { schemaVersion: 1, ready: true };
      } else {
        if (db.value("PRAGMA user_version") !== SCHEMA_VERSION) fail11("memory_unsupported_schema");
        result = OPERATIONS2[command](db, payload);
      }
    } catch (error) {
      db.rollback();
      throw error;
    }
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
function errorCode2(error) {
  if (error instanceof MemoryFailure) return error.code;
  if (isPythonInputError(error)) return "memory_invalid_input";
  return "memory_unavailable";
}
function bridgeFailure2(command, code, detail = "") {
  const error = new Error(`SQLite bridge '${command}' failed: ${code}${detail ? ` (${detail})` : ""}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}
`;
  return error;
}
var NodeProjectMemoryBridge = class {
  #closed = false;
  constructor({ databasePath, sqlite }) {
    if (!databasePath || typeof sqlite?.DatabaseSync !== "function") {
      throw new Error("NodeProjectMemoryBridge requires databasePath and node:sqlite");
    }
    this.databasePath = path8.resolve(databasePath);
    this.sqlite = sqlite;
    this.sqliteBackend = "node";
  }
  async invoke(command, payload = {}) {
    if (this.#closed) throw bridgeFailure2(command, "memory_unavailable", "closed");
    let result;
    try {
      const request = jsonTransport(payload);
      if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > MAX_PAYLOAD_BYTES2) fail11("memory_limit_exceeded");
      result = run2(this.sqlite, this.databasePath, command, request);
    } catch (error) {
      throw bridgeFailure2(command, errorCode2(error));
    }
    return sortedTransport(result);
  }
  /** Nothing stays open between requests; later calls fail as after the bridge closed. */
  async close() {
    this.#closed = true;
  }
};

// orchestrator/src/project-memory-split.mjs
import { createHash as createHash9 } from "node:crypto";
import path9 from "node:path";
var CATALOG_KEY2 = "memory-agents-v1";
var ARCHIVE_KEY2 = "memory-project-archive-v1";
var APPROVALS_PREFIX = "memory-document-approvals-v1:";
var MERGED = /* @__PURE__ */ new Set([CATALOG_KEY2, ARCHIVE_KEY2]);
var SCOPE_COMMANDS = /* @__PURE__ */ new Set(["read-scope", "authorize-write", "write"]);
var MEMORY_FILE = "memory.sqlite";
var sha2566 = (value) => createHash9("sha256").update(value).digest("hex");
var compare3 = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compare3).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function failure(command, code) {
  const error = new Error(`Split store '${command}' failed: ${code}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}
`;
  return error;
}
function scopeOrder(a, b) {
  return compare3(a.projectId, b.projectId) || (a.kind === "project" ? 0 : 1) - (b.kind === "project" ? 0 : 1) || compare3(a.quarterId ?? "", b.quarterId ?? "") || compare3(a.scopeId, b.scopeId);
}
var SplitProjectMemoryBridge = class {
  #root;
  #sqlite;
  #bridges = /* @__PURE__ */ new Map();
  #scopes = /* @__PURE__ */ new Map();
  constructor({ controllerRoot, sqlite }) {
    if (!controllerRoot || typeof sqlite?.DatabaseSync !== "function") {
      throw new Error("SplitProjectMemoryBridge requires controllerRoot and node:sqlite");
    }
    this.#root = controllerRoot;
    this.#sqlite = sqlite;
    this.sqliteBackend = "node";
  }
  /**
   * The bridge of a project's database; a new project gets its folder and
   * database. Calls at the same time share one opening.
   */
  async #bridge(projectId, { create = false } = {}) {
    const bridge = await this.#opening(projectId, create);
    if (bridge === null && create) {
      this.#bridges.delete(projectId);
      return this.#opening(projectId, true);
    }
    return bridge;
  }
  #opening(projectId, create) {
    if (!this.#bridges.has(projectId)) {
      const opening = (async () => {
        const folder = await projectStoreFolder(this.#root, projectId, { create });
        if (folder === null) return null;
        const bridge = new NodeProjectMemoryBridge({ databasePath: path9.join(folder, MEMORY_FILE), sqlite: this.#sqlite });
        await bridge.invoke("init", {});
        return bridge;
      })();
      this.#bridges.set(projectId, opening);
      opening.then(
        (bridge) => {
          if (bridge === null) this.#bridges.delete(projectId);
        },
        () => this.#bridges.delete(projectId)
      );
    }
    return this.#bridges.get(projectId);
  }
  async #world() {
    return this.#bridge(WORLD_PROJECT_ID, { create: true });
  }
  /** Every mounted project's bridge, the world first, then by projectId. */
  async #all() {
    const world = await this.#world();
    const result = [[WORLD_PROJECT_ID, world]];
    for (const { projectId } of await mountedProjects(this.#root)) {
      if (projectId !== WORLD_PROJECT_ID) result.push([projectId, await this.#bridge(projectId)]);
    }
    return result;
  }
  /** Which project holds each scope; read again when a scope is not known (another process may have made it). */
  async #refreshScopes() {
    this.#scopes.clear();
    for (const [projectId] of await this.#all()) {
      const folder = await projectStoreFolder(this.#root, projectId);
      const db = openReadOnlyDatabase(this.#sqlite, path9.join(folder, MEMORY_FILE));
      try {
        for (const row2 of db.prepare("SELECT scope_id FROM memory_scopes").all()) this.#scopes.set(row2.scope_id, projectId);
      } finally {
        db.close();
      }
    }
  }
  async #projectOfScope(scopeId) {
    if (!this.#scopes.has(scopeId)) await this.#refreshScopes();
    return this.#scopes.get(scopeId) ?? null;
  }
  /**
   * The project whose database recorded an operation id. One database keeps
   * operation ids unique for the whole instance; the split layout checks every
   * database, so a replay goes where the operation is and a reused id conflicts.
   */
  async #projectOfOperation(operationId) {
    if (typeof operationId !== "string") return null;
    for (const [projectId] of await this.#all()) {
      const folder = await projectStoreFolder(this.#root, projectId);
      const db = openReadOnlyDatabase(this.#sqlite, path9.join(folder, MEMORY_FILE));
      try {
        if (db.prepare("SELECT 1 AS present FROM memory_operations WHERE operation_id=?").get(operationId)) return projectId;
      } finally {
        db.close();
      }
    }
    return null;
  }
  /** The operation's database when it is recorded; a conflict when it is recorded for another project. */
  async #operationTarget(command, operationId, projectId) {
    const owner = await this.#projectOfOperation(operationId);
    if (owner !== null && projectId !== null && owner !== projectId) throw failure(command, "memory_operation_conflict");
    return owner;
  }
  async #catalogAgents() {
    const merged = await this.#mergedRead(CATALOG_KEY2);
    return Array.isArray(merged?.value?.agents) ? merged.value.agents : [];
  }
  /** The project a document belongs to (docs/project-package.md §3.2); the world for any other key. */
  async #documentOwner(key) {
    if (key.startsWith("workspace-")) {
      const hash2 = key.slice("workspace-".length);
      for (const { projectId } of await mountedProjects(this.#root)) if (sha2566(projectId) === hash2) return projectId;
      return WORLD_PROJECT_ID;
    }
    for (const [prefix, keyOf] of [
      [ACTION_JOURNAL_PREFIX, journalKeyOf],
      [NAMES_PREFIX, namesKeyOf],
      [TASKS_PREFIX, tasksKeyOf],
      [CHANGES_PREFIX, changesKeyOf]
    ]) {
      if (!key.startsWith(prefix)) continue;
      for (const { projectId } of await mountedProjects(this.#root)) if (keyOf(projectId) === key) return projectId;
      return WORLD_PROJECT_ID;
    }
    if (key.startsWith(APPROVALS_PREFIX) || key.startsWith("agent-artifacts-")) {
      for (const agent of await this.#catalogAgents()) {
        if (typeof agent?.agentId !== "string") continue;
        if (key === `${APPROVALS_PREFIX}${sha2566(agent.agentId).slice(0, 32)}` || key === artifactsKeyOf(agent.agentId)) {
          return await this.#bridge(agent.projectId) === null ? WORLD_PROJECT_ID : agent.projectId;
        }
      }
    }
    return WORLD_PROJECT_ID;
  }
  async #parts(key) {
    const parts = /* @__PURE__ */ new Map();
    for (const [projectId, bridge] of await this.#all()) {
      const document = await bridge.invoke("read-document", { key });
      if (document !== null) parts.set(projectId, document);
    }
    return parts;
  }
  async #mergedRead(key) {
    const parts = await this.#parts(key);
    if (parts.size === 0) return null;
    const revision2 = [...parts.values()].reduce((sum, part) => sum + part.revision, 0);
    const values = [...parts.values()].map((part) => part.value);
    if (key === CATALOG_KEY2) {
      const { agents: ignored, ...rest2 } = values[0] ?? {};
      const agents = values.flatMap((value) => Array.isArray(value?.agents) ? value.agents : []).map((agent, index) => ({ agent, index })).sort((a, b) => compare3(String(a.agent?.createdAtUtc ?? ""), String(b.agent?.createdAtUtc ?? "")) || a.index - b.index).map(({ agent }) => agent);
      return { revision: revision2, value: { ...rest2, agents } };
    }
    const { projects: ignoredProjects, quarters: ignoredQuarters, ...rest } = values[0] ?? {};
    return { revision: revision2, value: {
      ...rest,
      projects: Object.assign({}, ...values.map((value) => value?.projects ?? {})),
      quarters: Object.assign({}, ...values.map((value) => value?.quarters ?? {}))
    } };
  }
  /** Splits a merged document into each project's part. */
  #split(key, value) {
    const groups = /* @__PURE__ */ new Map();
    const group = (projectId) => {
      if (!groups.has(projectId)) groups.set(projectId, key === CATALOG_KEY2 ? [] : { projects: {}, quarters: {} });
      return groups.get(projectId);
    };
    if (key === CATALOG_KEY2) {
      const { agents, ...rest2 } = value;
      for (const agent of Array.isArray(agents) ? agents : []) group(agent?.projectId ?? WORLD_PROJECT_ID).push(agent);
      return { rest: rest2, groups, build: (agentsOf) => ({ ...rest2, agents: agentsOf ?? [] }) };
    }
    const { projects, quarters, ...rest } = value;
    for (const [projectId, entry] of Object.entries(projects ?? {})) group(projectId).projects[projectId] = entry;
    for (const [quarterKey, entry] of Object.entries(quarters ?? {})) group(quarterKey.split("/")[0]).quarters[quarterKey] = entry;
    return { rest, groups, build: (part) => ({ ...rest, projects: part?.projects ?? {}, quarters: part?.quarters ?? {} }) };
  }
  async #mergedSwap(key, expectedRevision, value) {
    const parts = await this.#parts(key);
    const current = [...parts.values()].reduce((sum, part) => sum + part.revision, 0);
    if (current !== expectedRevision) return false;
    const { groups, build } = this.#split(key, value);
    const changed = [];
    for (const projectId2 of /* @__PURE__ */ new Set([...parts.keys(), ...groups.keys()])) {
      const next = build(groups.get(projectId2));
      const before = parts.get(projectId2);
      if (before === void 0 && !groups.has(projectId2)) continue;
      if (before === void 0 || canonical(before.value) !== canonical(next)) changed.push(projectId2);
    }
    if (changed.length === 0) changed.push(WORLD_PROJECT_ID);
    if (changed.length > 1) throw failure("compare-and-swap-document", "memory_cross_project_change");
    const [projectId] = changed;
    const bridge = await this.#bridge(projectId);
    if (bridge === null) throw failure("compare-and-swap-document", "memory_scope_not_found");
    return bridge.invoke(
      "compare-and-swap-document",
      { key, expectedRevision: parts.get(projectId)?.revision ?? 0, value: build(groups.get(projectId)) }
    );
  }
  async #copyProject(payload) {
    if (await this.#operationTarget("copy-project", payload.operationId, payload.targetProjectId) !== null) {
      return (await this.#bridge(payload.targetProjectId)).invoke("copy-project-from", { ...payload, sources: [] });
    }
    const source = await this.#bridge(payload.sourceProjectId);
    const listed = source === null ? { scopes: [], truncated: false } : await source.invoke("list-scopes", { projectId: payload.sourceProjectId, limit: 513 });
    if (listed.truncated) throw failure("copy-project", "memory_limit_exceeded");
    if (listed.scopes.length === 0) throw failure("copy-project", "memory_project_scope_required");
    for (const target2 of [payload.targetProjectScopeId, ...Object.values(payload.quarterScopeIds ?? {})]) {
      const owner = await this.#projectOfScope(target2);
      if (owner !== null && owner !== payload.targetProjectId) throw failure("copy-project", "memory_scope_conflict");
    }
    const dtos = /* @__PURE__ */ new Map();
    const ids = listed.scopes.map((scope) => scope.scopeId);
    for (let index = 0; index < ids.length; index += 128) {
      const set = await source.invoke("read-scope-set", { scopeIds: ids.slice(index, index + 128) });
      for (const dto of set.scopes) dtos.set(dto.scopeId, dto);
    }
    const sources = listed.scopes.map((scope) => {
      const dto = dtos.get(scope.scopeId);
      return {
        scopeId: dto.scopeId,
        kind: dto.kind,
        projectId: dto.projectId,
        quarterId: dto.quarterId,
        title: dto.title,
        revision: dto.revision,
        sha256: dto.sha256,
        entries: dto.entries
      };
    });
    const target = await this.#bridge(payload.targetProjectId, { create: true });
    const result = await target.invoke("copy-project-from", { ...payload, sources });
    for (const scope of result.scopes ?? []) this.#scopes.set(scope.targetScopeId, payload.targetProjectId);
    await this.#registerNewProject(payload.targetProjectId, sources.find((scope) => scope.kind === "project")?.title);
    return result;
  }
  /**
   * A project made here goes into the world registry at once, so other PCs know it
   * (docs/project-package.md §7): its title, this PC as its place, an empty summary.
   * A project the registry knows already is left as it is.
   * The store is the truth; a registry that could not be written is repaired from the
   * mounted projects (project-mount.mjs recordMountedProjects), so this never fails the change.
   */
  async #registerNewProject(projectId, title) {
    if (projectId === WORLD_PROJECT_ID) return;
    try {
      if (Object.hasOwn((await readWorldRegistry(this.#root)).projects, projectId)) return;
      const machine = await readThisMachine(this.#root);
      await recordWorldProjects(this.#root, [{
        projectId,
        ...typeof title === "string" ? { title } : {},
        location: machine === null ? null : { machineId: machine.machineId, atUtc: (/* @__PURE__ */ new Date()).toISOString() },
        summary: { agents: 0, quarters: 0, tasksOpen: 0, lastActivityUtc: null }
      }]);
    } catch {
    }
  }
  async invoke(command, payload = {}) {
    switch (command) {
      case "init":
        await this.#world();
        await this.#refreshScopes();
        return { schemaVersion: 1, ready: true };
      case "create-scope": {
        await this.#operationTarget(command, payload.operationId, payload.projectId);
        const owner = await this.#projectOfScope(payload.scopeId);
        if (owner !== null && owner !== payload.projectId) throw failure(command, "memory_scope_conflict");
        const bridge = await this.#bridge(payload.projectId, { create: payload.kind === "project" }) ?? await this.#world();
        const result = await bridge.invoke(command, payload);
        this.#scopes.set(payload.scopeId, payload.projectId);
        if (payload.kind === "project") await this.#registerNewProject(payload.projectId, payload.title);
        return result;
      }
      case "copy-project":
        return this.#copyProject(payload);
      case "list-scopes": {
        if (payload.projectId !== null && payload.projectId !== void 0) {
          const bridge = await this.#bridge(payload.projectId);
          return bridge === null ? { schemaVersion: 1, scopes: [], truncated: false } : bridge.invoke(command, payload);
        }
        const scopes = [];
        let truncated = false;
        for (const [, bridge] of await this.#all()) {
          const listed = await bridge.invoke(command, payload);
          scopes.push(...listed.scopes);
          truncated ||= listed.truncated;
        }
        scopes.sort(scopeOrder);
        const limit = payload.limit;
        return { schemaVersion: 1, scopes: scopes.slice(0, limit), truncated: truncated || scopes.length > limit };
      }
      case "read-pair": {
        const bridge = await this.#bridge(payload.projectId);
        if (bridge === null) throw failure(command, "memory_scope_not_found");
        return bridge.invoke(command, payload);
      }
      case "read-scope-set": {
        const byProject = /* @__PURE__ */ new Map();
        for (const scopeId of payload.scopeIds ?? []) {
          const owner = await this.#projectOfScope(scopeId);
          if (owner === null) continue;
          if (!byProject.has(owner)) byProject.set(owner, []);
          byProject.get(owner).push(scopeId);
        }
        const found = /* @__PURE__ */ new Map();
        for (const [projectId, scopeIds] of byProject) {
          const set = await (await this.#bridge(projectId)).invoke(command, { ...payload, scopeIds });
          for (const scope of set.scopes) found.set(scope.scopeId, scope);
        }
        return { schemaVersion: 1, scopes: (payload.scopeIds ?? []).filter((id5) => found.has(id5)).map((id5) => found.get(id5)) };
      }
      case "read-document":
        if (MERGED.has(payload.key)) return this.#mergedRead(payload.key);
        return (await this.#bridge(await this.#documentOwner(payload.key))).invoke(command, payload);
      case "compare-and-swap-document": {
        if (MERGED.has(payload.key)) return this.#mergedSwap(payload.key, payload.expectedRevision, payload.value);
        const bound2 = payload.value?.projectId;
        if (payload.key.startsWith("workspace-") && typeof bound2 === "string" && payload.key === `workspace-${sha2566(bound2)}`) {
          return (await this.#bridge(bound2, { create: true })).invoke(command, payload);
        }
        return (await this.#bridge(await this.#documentOwner(payload.key))).invoke(command, payload);
      }
      default: {
        if (!SCOPE_COMMANDS.has(command)) throw failure(command, "memory_invalid_input");
        const owner = await this.#projectOfScope(payload.scopeId) ?? WORLD_PROJECT_ID;
        if (command === "write") await this.#operationTarget(command, payload.operationId, owner);
        return (await this.#bridge(owner)).invoke(command, payload);
      }
    }
  }
  /** The project a conversation's thread belongs to, through the catalog; null when no agent has it. */
  async projectOfThread(threadId) {
    for (const agent of await this.#catalogAgents()) {
      if (agent?.binding?.threadId === threadId && typeof agent.projectId === "string") return agent.projectId;
    }
    return null;
  }
  async close() {
    for (const opening of this.#bridges.values()) {
      const bridge = await opening.catch(() => null);
      if (bridge !== null) await bridge.close();
    }
  }
};

// orchestrator/src/provider-mutation-lease-store.mjs
import path10 from "node:path";
import {
  lstat as lstat6,
  mkdir as mkdir6,
  open,
  readFile as readFile7,
  readdir as readdir4,
  realpath as realpath3,
  rename as rename7,
  unlink
} from "node:fs/promises";

// orchestrator/src/rename-over.mjs
import { rename as rename6 } from "node:fs/promises";
var HELD = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY"]);
async function renameOver(from, to, {
  attempts = 12,
  firstDelayMs = 10,
  maximumDelayMs = 250,
  renameImpl = rename6
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (!HELD.has(error?.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(firstDelayMs * 2 ** (attempt - 1), maximumDelayMs)));
    }
  }
}

// orchestrator/src/provider-mutation-lease.mjs
var OWNER_KEYS = Object.freeze([
  "sourceId",
  "runtimeInstanceId",
  "threadId",
  "operation",
  "operationId",
  "correlationId"
]);
var RECORD_KEYS = Object.freeze([
  "owner",
  "intentSha256",
  "leaseId",
  "state",
  "outcome",
  "receiptSha256",
  "acquiredAtUtc",
  "renewedAtUtc",
  "expiresAtUtc",
  "settledAtUtc",
  "fencingRevision",
  "revision"
]);
var DOCUMENT_KEYS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "projectId",
  "revision",
  "archivedRecordCount",
  "archivedThroughRevision",
  "records"
]);
var LEGACY_DOCUMENT_KEYS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "projectId",
  "revision",
  "records"
]);
var MAX_RECORD_BYTES = 4 * 1024;

// orchestrator/src/provider-mutation-lease-store.mjs
var ID7 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
var MAX_CONTRACT_BYTES = 64 * 1024;
var MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
var MAX_SETTLEMENT_BYTES = 8 * 1024;
var ProviderMutationLeaseStoreError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderMutationLeaseStoreError";
    this.code = code;
  }
};
function fail12(code, message) {
  throw new ProviderMutationLeaseStoreError(code, message);
}
function boundedId(value, label) {
  if (typeof value !== "string" || !ID7.test(value)) fail12("invalid_identity", `${label} is invalid`);
  return value;
}
async function readBoundedJson(filePath, maximumBytes, { optional = false } = {}) {
  let metadata;
  try {
    metadata = await lstat6(filePath);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    fail12("store_unavailable", `Cannot inspect ${path10.basename(filePath)}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    fail12("invalid_store_file", `${path10.basename(filePath)} is not a bounded regular file`);
  }
  const bytes = await readFile7(filePath);
  if (bytes.byteLength > maximumBytes) fail12("invalid_store_file", "Store file changed beyond its bound");
  try {
    const parsed2 = JSON.parse(bytes.toString("utf8"));
    if (!parsed2 || typeof parsed2 !== "object" || Array.isArray(parsed2)) throw new Error("shape");
    return parsed2;
  } catch {
    fail12("invalid_store_json", `${path10.basename(filePath)} is not valid JSON`);
  }
}
async function resolveProviderMutationProjectId(controllerRoot) {
  const contract = await readBoundedJson(
    path10.join(controllerRoot, ".orchestrator", "contract.json"),
    MAX_CONTRACT_BYTES,
    { optional: true }
  );
  if (contract === null) {
    const version2 = await readBoundedJson(path10.join(controllerRoot, "project-version.json"), MAX_CONTRACT_BYTES);
    return boundedId(version2.projectName, "projectName");
  }
  return boundedId(contract.sourceId, "sourceId");
}

// orchestrator/src/project-package-import.mjs
var MANIFEST2 = "project.af.json";
var DESK2 = ".desk";
var MEMORY_SCHEMA2 = 2;
var ARCHIVE_SCHEMAS2 = /* @__PURE__ */ new Set([null, 1, 2]);
var MEMORY_CHUNK_BYTES = 384 * 1024;
var ARCHIVE_CHUNK_BYTES = 1536 * 1024;
function fail13(code, detail) {
  throw new ProjectPackageError(code, detail);
}
var sha2567 = (value) => createHash10("sha256").update(value).digest("hex");
var compare4 = (a, b) => a < b ? -1 : a > b ? 1 : 0;
async function exists3(target) {
  return lstat7(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
async function readJson2(target, fallback = null) {
  if (!await exists3(target)) return fallback;
  try {
    return JSON.parse(await readFile8(target, "utf8"));
  } catch {
    return fail13("package_invalid", path11.basename(target));
  }
}
async function filesUnder(folder) {
  const found = [];
  const walk = async (current, relative) => {
    for (const entry of await readdir5(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail13("package_link_refused", rel);
      if (entry.isDirectory()) await walk(path11.join(current, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  if (await exists3(folder)) await walk(folder, "");
  return found.sort(compare4);
}
var lines = (text3) => text3.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
function chunks(rows, limit) {
  const result = [];
  let current = [];
  let size = 0;
  for (const row2 of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row2), "utf8");
    if (bytes > limit) fail13("package_record_too_large");
    if (current.length > 0 && size + bytes > limit) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(row2);
    size += bytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}
function packagePlacement(relative, paths) {
  const parts = relative.split("/");
  const rest = (from) => parts.slice(from);
  const join = (base, list) => {
    if (list.length === 0 || list.some((part) => part === "" || part === "." || part === "..")) fail13("package_path_invalid", relative);
    return path11.join(base, ...list);
  };
  switch (parts[0]) {
    case "memory":
    case "archive":
    case "layout.json":
      return null;
    case "sessions":
      if (parts[1] === "claude") return join(paths.claudeSessions, rest(2));
      if (parts[1] === "acp") return join(paths.acpSessions, rest(2));
      if (parts[1] === "claude-sdk") return join(path11.join(paths.claudeConfigDir, "projects"), rest(2));
      if (parts[1] === "dsh") return join(path11.join(paths.dshHome, "sessions"), rest(2));
      if (parts[1] === "dsh-projcache") return join(path11.join(paths.dshHome, "storages", "session_projcache", "sessions"), rest(2));
      break;
    case "desk":
      if (parts[1] === "agents" && parts.length > 3) return join(path11.join(paths.deskAgents, deskSourceIdOf(parts[2])), rest(3));
      if (parts[1] === "tasks" && parts[2] === "dispatched") return join(paths.dispatched, rest(3));
      if (parts[1] === "tasks" && parts[2] === "definitions") return join(paths.definitions, rest(3));
      if (parts[1] === "tasks" && parts[2] === "returns") return join(paths.returns, rest(3));
      if (parts[1] === "reports") return join(paths.reports, rest(2));
      if (parts[1] === "acceptances") return join(paths.acceptances, rest(2));
      break;
    default:
      break;
  }
  return fail13("package_path_unknown", relative);
}
async function readProjectPackage(packageDir) {
  const manifest = await readJson2(path11.join(packageDir, MANIFEST2));
  if (manifest === null || manifest.schema !== PROJECT_PACKAGE_SCHEMA) fail13("package_invalid", MANIFEST2);
  if (typeof manifest.projectId !== "string") fail13("package_invalid", "projectId");
  if (manifest.storeSchemas?.memory !== MEMORY_SCHEMA2) fail13("package_schema_newer", `memory ${manifest.storeSchemas?.memory}`);
  if (!ARCHIVE_SCHEMAS2.has(manifest.storeSchemas?.archive ?? null)) fail13("package_schema_newer", "archive");
  const listed = Object.keys(manifest.files ?? {}).sort(compare4);
  const present = (await filesUnder(path11.join(packageDir, DESK2))).map((name) => `${DESK2}/${name}`);
  if (listed.length !== present.length || listed.some((name, index) => name !== present[index])) {
    fail13("package_files_mismatch");
  }
  const bytes = /* @__PURE__ */ new Map();
  for (const name of listed) {
    const content = await readFile8(path11.join(packageDir, ...name.split("/")));
    const expected = manifest.files[name];
    if (content.length !== expected.bytes || sha2567(content) !== expected.sha256) fail13("package_hash_mismatch", name);
    bytes.set(name.slice(DESK2.length + 1), content);
  }
  return { manifest, files: bytes };
}
async function storeIsEmpty(folder) {
  const sqlite = await loadNodeSqlite();
  const database = path11.join(folder, "memory.sqlite");
  if (!await exists3(database)) return true;
  const db = openReadOnlyDatabase(sqlite, database);
  try {
    return ["memory_scopes", "memory_documents", "memory_operations", "memory_write_grants"].every((table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === 0);
  } finally {
    db.close();
  }
}
async function importProject({ controllerRoot, packageDir, claudeConfigDir, dshHome }) {
  const root = await realpath4(controllerRoot);
  if ((await resolveStoreLayout(root, { env: {} })).layout !== "split") fail13("store_layout_single", "migrate the instance first");
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) fail13("memory_sqlite_required");
  if (await gatewayRunning(path11.join(root, ".project-local", "application-gateway", "status.v1.json"))) fail13("gateway_running");
  const { manifest, files } = await readProjectPackage(path11.resolve(packageDir));
  const projectId = manifest.projectId;
  const instance = await readJson2(path11.join(root, "instance.json"), {});
  if (typeof manifest.worldId === "string" && typeof instance?.instanceId === "string" && manifest.worldId !== instance.instanceId) fail13("package_world_mismatch", manifest.worldId);
  const controllerId = await resolveProviderMutationProjectId(root);
  const text3 = (name) => files.has(name) ? files.get(name).toString("utf8") : "";
  const memory = {
    scopes: lines(text3("memory/scopes.jsonl")),
    revisions: lines(text3("memory/revisions.jsonl")),
    grants: lines(text3("memory/grants.jsonl")),
    operations: lines(text3("memory/operations.jsonl")),
    documents: lines(text3("memory/documents.jsonl"))
  };
  if (memory.scopes.some((scope) => scope.projectId !== projectId)) fail13("package_invalid", "scope of another project");
  const conversations = lines(text3("archive/conversations.jsonl"));
  if (conversations.some((conversation) => conversation.binding?.projectId !== controllerId)) {
    fail13("package_world_mismatch", "controller");
  }
  const entries = conversations.flatMap((conversation) => lines(
    text3(`archive/entries/${conversation.conversationId.replace(/^conversation:/u, "")}.jsonl`)
  ).map((entry) => ({ ...entry, conversationId: conversation.conversationId })));
  const checkpoints = conversations.filter((conversation) => conversation.importCheckpoint !== null).map((conversation) => ({ conversationId: conversation.conversationId, ...conversation.importCheckpoint }));
  const hint = manifest.workspace?.boundPathHint;
  if (typeof hint === "string" && typeof manifest.workspace?.workspaceKey === "string") {
    memory.documents.push({
      key: `workspace-${sha2567(projectId)}`,
      revision: 1,
      value: { projectId, workspacePath: hint, workspaceKey: manifest.workspace.workspaceKey }
    });
    memory.documents.sort((a, b) => compare4(a.key, b.key));
  }
  const existing = await projectStoreFolder(root, projectId);
  if (existing !== null && !(projectId === WORLD_PROJECT_ID && await storeIsEmpty(existing))) {
    fail13("project_already_mounted", projectId);
  }
  const paths = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  const writes = [];
  let identical = 0;
  for (const [name, content] of files) {
    const target = packagePlacement(name, paths);
    if (target === null) continue;
    if (await exists3(target)) {
      if (!(await readFile8(target)).equals(content)) fail13("import_file_conflict", target);
      identical += 1;
    } else {
      writes.push({ target, content });
    }
  }
  const folder = await projectStoreFolder(root, projectId, { create: true });
  const written = [];
  try {
    const store = new NodeProjectMemoryBridge({ databasePath: path11.join(folder, "memory.sqlite"), sqlite });
    await store.invoke("init", {});
    for (const table of ["scopes", "revisions", "grants", "operations", "documents"]) {
      for (const rows of chunks(memory[table], MEMORY_CHUNK_BYTES)) await store.invoke("import-rows", { table, rows });
    }
    if (conversations.length > 0) {
      const archive = new NodeConversationArchiveBridge({ databasePath: path11.join(folder, "archive.sqlite"), sqlite });
      await archive.invoke("init", { projectId: controllerId });
      const tables = {
        conversations: conversations.map(({ conversationId, binding }) => ({ conversationId, binding })),
        entries,
        checkpoints
      };
      for (const [table, rows] of Object.entries(tables)) {
        for (const chunk of chunks(rows, ARCHIVE_CHUNK_BYTES)) {
          await archive.invoke("import-rows", { projectId: controllerId, table, rows: chunk });
        }
      }
    }
    if (files.has("layout.json")) await writeFile6(path11.join(folder, "layout.json"), files.get("layout.json"));
    for (const { target, content } of writes) {
      await mkdir7(path11.dirname(target), { recursive: true });
      await writeFile6(target, content, { flag: "wx" });
      written.push(target);
    }
  } catch (error) {
    for (const target of written) await rm6(target, { force: true });
    await rm6(folder, { recursive: true, force: true });
    throw error instanceof ProjectPackageError ? error : new ProjectPackageError("import_failed", String(error?.code ?? error?.message ?? error).slice(0, 200));
  }
  return {
    projectId,
    folder,
    scopes: memory.scopes.length,
    documents: memory.documents.length,
    conversations: conversations.length,
    entries: entries.length,
    files: { written: written.length, identical },
    workspace: typeof hint === "string" ? await exists3(hint) ? "bound" : "missing" : "none"
  };
}
async function deskTree(folder) {
  const tree = /* @__PURE__ */ new Map();
  for (const name of await filesUnder(path11.join(folder, DESK2))) {
    tree.set(name, sha2567(await readFile8(path11.join(folder, DESK2, ...name.split("/")))));
  }
  return tree;
}
async function singleProjects(root) {
  const sqlite = await loadNodeSqlite();
  const db = openReadOnlyDatabase(sqlite, singleMemoryDatabase(root));
  try {
    const ids = /* @__PURE__ */ new Set([WORLD_PROJECT_ID, ...db.prepare("SELECT DISTINCT project_id FROM memory_scopes").all().map((row2) => row2.project_id)]);
    const document = (key) => {
      const row2 = db.prepare("SELECT value_json FROM memory_documents WHERE key=?").get(key);
      return row2 ? JSON.parse(row2.value_json) : null;
    };
    for (const agent of document("memory-agents-v1")?.agents ?? []) if (typeof agent?.projectId === "string") ids.add(agent.projectId);
    const flags = document("memory-project-archive-v1");
    for (const key of Object.keys(flags?.projects ?? {})) ids.add(key);
    for (const key of Object.keys(flags?.quarters ?? {})) ids.add(key.split("/")[0]);
    const totals = {};
    for (const [name, table] of [
      ["scopes", "memory_scopes"],
      ["revisions", "memory_revisions"],
      ["operations", "memory_operations"],
      ["grants", "memory_write_grants"]
    ]) {
      totals[name] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    }
    totals.agents = (document("memory-agents-v1")?.agents ?? []).length;
    return { ids: [...ids].sort(compare4), totals };
  } finally {
    db.close();
  }
}
var canonical2 = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical2).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compare4).map((key) => `${JSON.stringify(key)}:${canonical2(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
async function verifyDocuments(root) {
  const sqlite = await loadNodeSqlite();
  const db = openReadOnlyDatabase(sqlite, singleMemoryDatabase(root));
  let rows;
  try {
    rows = db.prepare("SELECT key, value_json FROM memory_documents").all();
  } finally {
    db.close();
  }
  const split = new SplitProjectMemoryBridge({ controllerRoot: root, sqlite });
  try {
    await split.invoke("init", {});
    for (const row2 of rows) {
      const before = JSON.parse(row2.value_json);
      const after = (await split.invoke("read-document", { key: row2.key }))?.value ?? null;
      let same;
      if (row2.key === "memory-agents-v1") {
        const byId = (value) => new Map((value?.agents ?? []).map((agent) => [agent.agentId, canonical2(agent)]));
        const [a, b] = [byId(before), byId(after)];
        same = a.size === b.size && [...a].every(([id5, text3]) => b.get(id5) === text3);
      } else if (row2.key === "memory-project-archive-v1") {
        same = canonical2(before?.projects ?? {}) === canonical2(after?.projects ?? {}) && canonical2(before?.quarters ?? {}) === canonical2(after?.quarters ?? {});
      } else {
        same = canonical2(before) === canonical2(after);
      }
      if (!same) fail13("store_layout_verify_failed", `document ${row2.key}`);
    }
  } finally {
    await split.close();
  }
  return rows.length;
}
async function archiveTotals(root) {
  const database = path11.join(root, ".project-local", "orchestration", "conversation-archive", "archive.v1.sqlite");
  if (!await exists3(database)) return { conversations: 0, entries: 0 };
  const sqlite = await loadNodeSqlite();
  const db = openReadOnlyDatabase(sqlite, database);
  try {
    return {
      conversations: db.prepare("SELECT count(*) AS n FROM conversations").get().n,
      entries: db.prepare("SELECT count(*) AS n FROM entries").get().n
    };
  } finally {
    db.close();
  }
}
async function migrateToSplitLayout({ controllerRoot, now = () => /* @__PURE__ */ new Date(), claudeConfigDir, dshHome }) {
  const root = await realpath4(controllerRoot);
  if ((await resolveStoreLayout(root, { env: {} })).layout === "split") fail13("store_layout_already_split");
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) fail13("memory_sqlite_required");
  const projectsFolder = projectsRoot(root);
  if (await exists3(projectsFolder) && (await readdir5(projectsFolder)).length > 0) fail13("store_layout_projects_present", projectsFolder);
  if (!await exists3(singleMemoryDatabase(root))) {
    await writeStoreLayoutMarker(root, { now });
    return { migrated: false, layout: "split", projects: [] };
  }
  const instanceFile = path11.join(root, "instance.json");
  const instance = await readJson2(instanceFile, {});
  if (typeof instance?.instanceId !== "string") {
    const temporary = `${instanceFile}.${process.pid}.${randomUUID6()}.tmp`;
    await writeFile6(temporary, `${JSON.stringify({ ...instance, instanceId: randomUUID6() }, null, 2)}
`, "utf8");
    await rename8(temporary, instanceFile);
  }
  const stamp3 = now().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  const work = path11.join(root, ".project-local", "backups", `split-${stamp3}`);
  if (await exists3(work)) fail13("store_layout_backup_exists", work);
  const stores = path11.join(work, "stores");
  await mkdir7(stores, { recursive: true });
  for (const source of [
    singleMemoryDatabase(root),
    path11.join(root, ".project-local", "orchestration", "conversation-archive", "archive.v1.sqlite")
  ]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (await exists3(`${source}${suffix}`)) await copyFile(`${source}${suffix}`, path11.join(stores, `${path11.basename(source)}${suffix}`));
    }
  }
  const { ids, totals } = await singleProjects(root);
  const archived = await archiveTotals(root);
  const exported = [];
  for (const projectId of ids) {
    const out = path11.join(work, "packages", projectFolderName(projectId));
    const result = await exportProject({ controllerRoot: root, projectId, out, now, claudeConfigDir, dshHome }).catch((error) => {
      if (error?.code === "project_not_found") return null;
      throw error;
    });
    if (result !== null) exported.push({ projectId, out, counts: result.counts });
  }
  const sum = (name) => exported.reduce((total, item) => total + (item.counts[name] ?? 0), 0);
  const expected = { ...totals, ...archived };
  const found = {
    scopes: sum("scopes"),
    revisions: sum("revisions"),
    operations: sum("operations"),
    grants: sum("grants"),
    agents: sum("agents"),
    conversations: sum("conversations"),
    entries: sum("entries")
  };
  for (const name of Object.keys(found)) {
    if (found[name] !== expected[name]) fail13("store_layout_export_incomplete", `${name}: ${found[name]} of ${expected[name]}`);
  }
  await writeStoreLayoutMarker(root, { now });
  try {
    const ordered = [...exported].sort((a, b) => a.projectId === WORLD_PROJECT_ID ? -1 : b.projectId === WORLD_PROJECT_ID ? 1 : compare4(a.projectId, b.projectId));
    for (const item of ordered) await importProject({ controllerRoot: root, packageDir: item.out, claudeConfigDir, dshHome });
    for (const item of ordered) {
      const again = path11.join(work, "verify", projectFolderName(item.projectId));
      await exportProject({ controllerRoot: root, projectId: item.projectId, out: again, now, claudeConfigDir, dshHome });
      const [before, after] = [await deskTree(item.out), await deskTree(again)];
      const same = before.size === after.size && [...before].every(([name, hash2]) => after.get(name) === hash2);
      if (!same) fail13("store_layout_verify_failed", item.projectId);
    }
    found.documents = await verifyDocuments(root);
    const entries = [];
    const machine = await readThisMachine(root);
    for (const item of exported.filter((entry) => entry.projectId !== WORLD_PROJECT_ID)) {
      const manifest = await readJson2(path11.join(item.out, MANIFEST2));
      entries.push({
        projectId: item.projectId,
        title: manifest.title,
        policy: manifest.policy,
        location: machine === null ? null : { machineId: machine.machineId, atUtc: now().toISOString() }
      });
    }
    if (entries.length > 0) await recordWorldProjects(root, entries);
  } catch (error) {
    await rm6(path11.join(projectsFolder, STORE_LAYOUT_MARKER), { force: true });
    for (const name of await readdir5(projectsFolder).catch(() => [])) {
      await rm6(path11.join(projectsFolder, name), { recursive: true, force: true });
    }
    throw error;
  }
  return {
    migrated: true,
    layout: "split",
    work,
    singleDatabaseKept: singleMemoryDatabase(root),
    projects: exported.map((item) => ({ projectId: item.projectId, counts: item.counts })),
    totals: found
  };
}

// orchestrator/src/instance-relocate.mjs
import { createHash as createHash14, randomUUID as randomUUID9 } from "node:crypto";
import { copyFile as copyFile2, lstat as lstat10, mkdir as mkdir10, readdir as readdir7, readFile as readFile10, realpath as realpath8, rename as rename10, writeFile as writeFile8 } from "node:fs/promises";
import path18 from "node:path";

// orchestrator/src/project-memory-store.mjs
import { createHash as createHash12 } from "node:crypto";
import path15 from "node:path";
import { lstat as lstat8, mkdir as mkdir8, realpath as realpath5 } from "node:fs/promises";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// orchestrator/src/sqlite-control-store.mjs
import path13 from "node:path";
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath } from "node:url";

// orchestrator/src/sqlite-control-store-node.mjs
import { randomUUID as randomUUID7, createHash as createHash11 } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path12 from "node:path";
import { gzipSync } from "node:zlib";
var FORMAT_VERSION = 4;
var ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
var ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
var SHA256_PATTERN = /^[a-f0-9]{64}$/u;
var REPORT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
var CONTROL_MODES = /* @__PURE__ */ new Set(["running", "paused", "draining", "emergency_stopped"]);
var ITEM_STATES = /* @__PURE__ */ new Set([
  "queued",
  "leased",
  "review_running",
  "decision_validating",
  "accepted",
  "reviewed",
  "integrating",
  "integrated",
  "waiting",
  "blocked",
  "cancelling",
  "cancelled",
  "stop_unconfirmed",
  "recovery_required",
  "failed"
]);
var ACTIVE_STATES = [
  "leased",
  "review_running",
  "decision_validating",
  "integrating",
  "cancelling",
  "recovery_required"
];
var TERMINAL_STATES = /* @__PURE__ */ new Set(["accepted", "integrated", "cancelled", "failed"]);
var FINAL_STATES = [...TERMINAL_STATES, "reviewed"];
var RETRYABLE_STATES = /* @__PURE__ */ new Set(["cancelled", "failed", "recovery_required", "stop_unconfirmed"]);
var DECISIONS = /* @__PURE__ */ new Set(["accepted", "rejected", "deferred", "superseded"]);
var CORRECTION_EVIDENCE_KINDS = /* @__PURE__ */ new Set(["report-correction", "corrected-progress", "corrected-execution-summary"]);
var AGENT_STATES = /* @__PURE__ */ new Set([
  "registered",
  "starting",
  "running",
  "waiting",
  "blocked",
  "cancellation_requested",
  "interrupted",
  "completed",
  "failed",
  "stop_unconfirmed",
  "stale"
]);
var WORKER_TASK_STATES = /* @__PURE__ */ new Set([
  "accepted",
  "running",
  "waiting",
  "blocked",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "stop_unconfirmed"
]);
var valueError = (message) => new PythonError("ValueError", message);
var inSet = (set, value) => typeof value === "string" && set.has(value);
function boundedText(value, maximum = 2048) {
  if (value === null || value === void 0) return null;
  const text3 = pyStr(value);
  if (text3.length <= maximum || pyLength(text3) <= maximum) return text3;
  return `${pySlice(text3, maximum - 15)}...<truncated>`;
}
var jsonText = (value) => pythonJson(value);
function loads2(text3) {
  if (typeof text3 !== "string") {
    throw new PythonError("TypeError", `the JSON object must be str, bytes or bytearray, not ${pyTypeName(text3)}`);
  }
  try {
    return JSON.parse(text3);
  } catch (error) {
    throw new PythonError("JSONDecodeError", error.message);
  }
}
function jsonValue(value, fallback) {
  if (!pyTruthy(value)) return fallback;
  return loads2(value);
}
function requireSha256(value, label) {
  const text3 = pyStr(pyOr(value, "")).toLowerCase();
  if (!SHA256_PATTERN.test(text3)) throw valueError(`Invalid ${label}`);
  return text3;
}
function mergeReportCorrectionEvidence(current, incoming, state) {
  if (!Array.isArray(current) || !Array.isArray(incoming)) throw valueError("Queue evidence must be an array");
  const currentText = new Set(current.map(jsonText));
  const incomingText = new Set(incoming.map(jsonText));
  if (incomingText.size !== incoming.length) throw valueError("Queue evidence cannot contain duplicate entries");
  if ([...incomingText].every((text3) => currentText.has(text3))) return current;
  const preserved = new Set(current.map(jsonText));
  if (![...preserved].every((text3) => incomingText.has(text3))) {
    throw valueError("Existing immutable report evidence cannot be removed or replaced");
  }
  const additions = incoming.filter((entry) => !currentText.has(jsonText(entry)));
  const additionKinds = additions.filter(isDict).map((entry) => pyGet(entry, "kind"));
  const incomplete = () => {
    if (!(state === "queued" || inSet(RETRYABLE_STATES, state)) || additions.length !== 3) return true;
    const kindKeys = new Set(additionKinds.map(pyHashKey));
    const expectedKinds = new Set([...CORRECTION_EVIDENCE_KINDS].map(pyHashKey));
    return kindKeys.size !== expectedKinds.size || [...kindKeys].some((key) => !expectedKinds.has(key)) || kindKeys.size !== 3;
  };
  if (incomplete()) {
    throw valueError("Only one complete immutable report-correction evidence set may augment a queued report");
  }
  const existingCorrections = current.filter((entry) => isDict(entry) && inSet(CORRECTION_EVIDENCE_KINDS, pyGet(entry, "kind")));
  if (existingCorrections.length > 0) throw valueError("A different immutable report correction already exists");
  for (const entry of additions) {
    if (!isDict(entry)) throw valueError("Report-correction evidence entries must be objects");
    requireSha256(pyGet(entry, "sha256"), `${pyStr(pyGet(entry, "kind"))} evidence sha256`);
    if (typeof pyGet(entry, "path") !== "string" || !entry.path) {
      throw valueError("Report-correction evidence requires a path");
    }
  }
  return incoming;
}
function agentStatistics(value) {
  if (value === null || value === void 0) return {};
  if (!isDict(value)) throw valueError("Agent statistics must be an object");
  if (pyTruthy(value) && !pyEquals(pyGet(value, "schemaVersion"), 1)) {
    throw valueError("Agent statistics require schemaVersion 1");
  }
  if (utf8(jsonText(value)).length > 128 * 1024) throw valueError("Agent statistics exceed the 128 KiB storage budget");
  return value;
}
function mapping(value) {
  if (!isDict(value)) throw new PythonError("TypeError", `'${pyTypeName(value)}' object is not a mapping`);
  return value;
}
function dictItems(value) {
  if (!isDict(value)) throw new PythonError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'items'`);
  return Object.entries(value);
}
function mergeAgentStatistics(current, incoming) {
  const left = agentStatistics(current);
  const right = agentStatistics(incoming);
  if (!pyTruthy(left)) return right;
  if (!pyTruthy(right)) return left;
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (!["tokens", "cost", "limitations", "timing"].includes(key)) merged[key] = value;
  }
  if (pyEquals(pyGet(pyGet(right, "tokens", {}), "status"), "available") || !pyTruthy(pyGet(left, "tokens"))) {
    merged.tokens = pyGet(right, "tokens");
  }
  if (pyEquals(pyGet(pyGet(right, "cost", {}), "status"), "estimated") || !pyTruthy(pyGet(left, "cost"))) {
    merged.cost = pyGet(right, "cost");
  }
  const timing = { ...mapping(pyOr(pyGet(left, "timing"), {})) };
  for (const [key, value] of dictItems(pyOr(pyGet(right, "timing"), {}))) {
    if (value !== null) timing[key] = value;
  }
  merged.timing = timing;
  const seen = /* @__PURE__ */ new Set();
  const limitations = [];
  for (const entry of [...pyIter(pyOr(pyGet(left, "limitations"), [])), ...pyIter(pyOr(pyGet(right, "limitations"), []))]) {
    const key = pyHashKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    limitations.push(entry);
  }
  merged.limitations = limitations.slice(0, 20);
  return agentStatistics(merged);
}
function requireId(value, label) {
  const text3 = pyStr(pyOr(value, ""));
  if (!ID_PATTERN.test(text3)) throw valueError(`Invalid ${label}: ${pyRepr(text3)}`);
  return text3;
}
function requireItemId(value, label = "itemId") {
  const text3 = pyStr(pyOr(value, ""));
  if (!ITEM_ID_PATTERN.test(text3)) throw valueError(`Invalid ${label}: ${pyRepr(text3)}`);
  return text3;
}
function requireReportId(value) {
  const text3 = pyStr(pyOr(value, ""));
  if (!REPORT_ID_PATTERN.test(text3)) throw valueError(`Invalid reportId: ${pyRepr(text3)}`);
  return text3;
}
function resolvedDatabasePath(databasePath) {
  let existing = path12.resolve(databasePath);
  const rest = [];
  while (!existsSync(existing)) {
    const parent = path12.dirname(existing);
    if (parent === existing) return path12.resolve(databasePath);
    rest.unshift(path12.basename(existing));
    existing = parent;
  }
  let real;
  try {
    real = realpathSync.native(existing);
  } catch {
    real = existing;
  }
  return path12.join(real, ...rest);
}
function connect(sqlite, databasePath) {
  const resolved = resolvedDatabasePath(databasePath);
  mkdirSync(path12.dirname(resolved), { recursive: true });
  const connection = new NodeSqliteConnection(sqlite, resolved, { timeoutMs: 3e4 });
  try {
    connection.exec("PRAGMA journal_mode=WAL");
    connection.exec("PRAGMA synchronous=FULL");
    connection.exec("PRAGMA foreign_keys=ON");
    connection.exec("PRAGMA busy_timeout=30000");
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}
var SCHEMA = `
        CREATE TABLE IF NOT EXISTS control_state (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          mode TEXT NOT NULL,
          reason TEXT,
          updated_at_utc TEXT NOT NULL
        );

        INSERT OR IGNORE INTO control_state(singleton_id, mode, reason, updated_at_utc)
        VALUES (1, 'running', NULL, '1970-01-01T00:00:00Z');

        CREATE TABLE IF NOT EXISTS queue_items (
          item_id TEXT PRIMARY KEY,
          report_key TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          title TEXT NOT NULL,
          report_status TEXT NOT NULL,
          report_sha256 TEXT NOT NULL,
          task_sha256 TEXT,
          source_revision TEXT NOT NULL,
          report_path TEXT NOT NULL,
          task_path TEXT,
          decision_path TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          dispatch_sequence INTEGER NOT NULL DEFAULT 0,
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          plan_json TEXT NOT NULL DEFAULT '[]',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          state TEXT NOT NULL,
          phase TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          final_decision TEXT,
          decision_reference TEXT,
          thread_id TEXT,
          turn_id TEXT,
          lease_token TEXT,
          lease_owner TEXT,
          lease_expires_at_utc TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at_utc TEXT NOT NULL,
          updated_at_utc TEXT NOT NULL,
          started_at_utc TEXT,
          finished_at_utc TEXT,
          UNIQUE(source_id, task_id)
        );

        CREATE INDEX IF NOT EXISTS idx_queue_state_order
          ON queue_items(state, priority DESC, dispatch_sequence ASC, created_at_utc ASC);

        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          parent_agent_id TEXT,
          kind TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT,
          state TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          last_completed TEXT,
          next_action TEXT,
          blockers_json TEXT NOT NULL DEFAULT '[]',
          thread_id TEXT,
          turn_id TEXT,
          can_interrupt INTEGER NOT NULL DEFAULT 0,
          started_at_utc TEXT,
          last_heartbeat_utc TEXT,
          statistics_json TEXT NOT NULL DEFAULT '{}',
          updated_at_utc TEXT NOT NULL,
          FOREIGN KEY(item_id) REFERENCES queue_items(item_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_agents_item ON agents(item_id);

        CREATE TABLE IF NOT EXISTS worker_tasks (
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          phase TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          plan_json TEXT NOT NULL DEFAULT '[]',
          workflow_json TEXT NOT NULL DEFAULT '{}',
          timing_json TEXT NOT NULL DEFAULT '{}',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          stop_events_json TEXT NOT NULL DEFAULT '[]',
          progress_sequence INTEGER NOT NULL DEFAULT 0,
          progress_sha256 TEXT NOT NULL,
          progress_path TEXT NOT NULL,
          started_at_utc TEXT,
          updated_at_utc TEXT NOT NULL,
          PRIMARY KEY(source_id, task_id)
        );

        CREATE TABLE IF NOT EXISTS worker_agents (
          agent_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          parent_agent_id TEXT,
          kind TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT,
          state TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          last_completed TEXT,
          next_action TEXT,
          blockers_json TEXT NOT NULL DEFAULT '[]',
          can_interrupt INTEGER NOT NULL DEFAULT 0,
          started_at_utc TEXT,
          last_heartbeat_utc TEXT,
          semantic_updated_at_utc TEXT,
          statistics_json TEXT NOT NULL DEFAULT '{}',
          updated_at_utc TEXT NOT NULL,
          FOREIGN KEY(source_id, task_id) REFERENCES worker_tasks(source_id, task_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_worker_agents_task ON worker_agents(source_id, task_id);

        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          at_utc TEXT NOT NULL,
          event_type TEXT NOT NULL,
          item_id TEXT,
          agent_id TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_events_item_sequence ON events(item_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_events_at ON events(at_utc);
        `;
function columns(connection, table) {
  return new Set(connection.all(`PRAGMA table_info(${table})`).map((row2) => row2.name));
}
function migrate(connection) {
  const previousVersion = connection.value("PRAGMA user_version");
  if (previousVersion > FORMAT_VERSION) {
    throw new PythonError("RuntimeError", `Unsupported control queue database version: ${previousVersion}`);
  }
  connection.exec(SCHEMA);
  const workerTaskColumns = columns(connection, "worker_tasks");
  if (!workerTaskColumns.has("workflow_json")) {
    connection.exec("ALTER TABLE worker_tasks ADD COLUMN workflow_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!workerTaskColumns.has("timing_json")) {
    connection.exec("ALTER TABLE worker_tasks ADD COLUMN timing_json TEXT NOT NULL DEFAULT '{}'");
  }
  const workerAgentColumns = columns(connection, "worker_agents");
  if (!workerAgentColumns.has("semantic_updated_at_utc")) {
    connection.exec("ALTER TABLE worker_agents ADD COLUMN semantic_updated_at_utc TEXT");
  }
  if (!workerAgentColumns.has("statistics_json")) {
    connection.exec("ALTER TABLE worker_agents ADD COLUMN statistics_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns(connection, "agents").has("statistics_json")) {
    connection.exec("ALTER TABLE agents ADD COLUMN statistics_json TEXT NOT NULL DEFAULT '{}'");
  }
  connection.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
  const version2 = connection.value("PRAGMA user_version");
  if (version2 !== FORMAT_VERSION) {
    throw new PythonError("RuntimeError", `Unsupported control queue database version: ${version2}`);
  }
}
function addEvent(connection, eventType, { itemId = null, agentId = null, payload = null, atUtc = null } = {}) {
  const inserted = connection.run(`
        INSERT INTO events(at_utc, event_type, item_id, agent_id, payload_json)
        VALUES (?, ?, ?, ?, ?)
        `, [pyTruthy(atUtc) ? atUtc : utcNow(), eventType, itemId, agentId, jsonText(pyOr(payload, {}))]);
  return inserted.lastInsertRowid;
}
function itemFromRow(row2) {
  if (row2 === null) return null;
  return {
    itemId: row2.item_id,
    reportKey: row2.report_key,
    sourceId: row2.source_id,
    taskId: row2.task_id,
    reportId: row2.report_id,
    title: row2.title,
    reportStatus: row2.report_status,
    reportSha256: row2.report_sha256,
    taskSha256: row2.task_sha256,
    sourceRevision: row2.source_revision,
    reportPath: row2.report_path,
    taskPath: row2.task_path,
    decisionPath: row2.decision_path,
    priority: row2.priority,
    dispatchSequence: row2.dispatch_sequence,
    dependencies: jsonValue(row2.dependencies_json, []),
    plan: jsonValue(row2.plan_json, []),
    blockers: jsonValue(row2.blockers_json, []),
    evidence: jsonValue(row2.evidence_json, []),
    state: row2.state,
    phase: row2.phase,
    currentAction: row2.current_action,
    summary: row2.summary,
    finalDecision: row2.final_decision,
    decisionReference: row2.decision_reference,
    threadId: row2.thread_id,
    turnId: row2.turn_id,
    leaseToken: row2.lease_token,
    leaseOwner: row2.lease_owner,
    leaseExpiresAtUtc: row2.lease_expires_at_utc,
    attempts: row2.attempts,
    error: row2.error,
    createdAtUtc: row2.created_at_utc,
    updatedAtUtc: row2.updated_at_utc,
    startedAtUtc: row2.started_at_utc,
    finishedAtUtc: row2.finished_at_utc
  };
}
function agentFromRow(row2) {
  return {
    agentId: row2.agent_id,
    itemId: row2.item_id,
    parentAgentId: row2.parent_agent_id,
    kind: row2.kind,
    role: row2.role,
    provider: row2.provider,
    state: row2.state,
    currentAction: row2.current_action,
    lastCompleted: row2.last_completed,
    nextAction: row2.next_action,
    blockers: jsonValue(row2.blockers_json, []),
    threadId: row2.thread_id,
    turnId: row2.turn_id,
    canInterrupt: pyTruthy(row2.can_interrupt),
    startedAtUtc: row2.started_at_utc,
    lastHeartbeatUtc: row2.last_heartbeat_utc,
    statistics: jsonValue(row2.statistics_json, {}),
    updatedAtUtc: row2.updated_at_utc
  };
}
function eventFromRow(row2) {
  return {
    sequence: row2.sequence,
    atUtc: row2.at_utc,
    type: row2.event_type,
    itemId: row2.item_id,
    agentId: row2.agent_id,
    data: jsonValue(row2.payload_json, {})
  };
}
function workerTaskFromRow(row2) {
  return {
    sourceId: row2.source_id,
    taskId: row2.task_id,
    title: row2.title,
    state: row2.state,
    phase: row2.phase,
    summary: jsonValue(row2.summary_json, {}),
    plan: jsonValue(row2.plan_json, []),
    workflow: jsonValue(row2.workflow_json, {}),
    timing: jsonValue(row2.timing_json, {}),
    blockers: jsonValue(row2.blockers_json, []),
    evidence: jsonValue(row2.evidence_json, []),
    stopEvents: jsonValue(row2.stop_events_json, []),
    progressSequence: row2.progress_sequence,
    progressSha256: row2.progress_sha256,
    progressPath: row2.progress_path,
    startedAtUtc: row2.started_at_utc,
    updatedAtUtc: row2.updated_at_utc
  };
}
function workerAgentFromRow(row2) {
  return {
    agentId: row2.agent_id,
    sourceId: row2.source_id,
    taskId: row2.task_id,
    parentAgentId: row2.parent_agent_id,
    kind: row2.kind,
    role: row2.role,
    provider: row2.provider,
    state: row2.state,
    currentAction: row2.current_action,
    lastCompleted: row2.last_completed,
    nextAction: row2.next_action,
    blockers: jsonValue(row2.blockers_json, []),
    canInterrupt: pyTruthy(row2.can_interrupt),
    startedAtUtc: row2.started_at_utc,
    lastHeartbeatUtc: row2.last_heartbeat_utc,
    semanticUpdatedAtUtc: row2.semantic_updated_at_utc,
    statistics: jsonValue(row2.statistics_json, {}),
    updatedAtUtc: row2.updated_at_utc
  };
}
function immediate(connection, body) {
  connection.exec("BEGIN IMMEDIATE");
  let result;
  try {
    result = body();
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
  return result;
}
var commit = (connection, result) => {
  connection.exec("COMMIT");
  return result;
};
function commandInit(connection) {
  const control = connection.get("SELECT * FROM control_state WHERE singleton_id = 1");
  return { formatVersion: FORMAT_VERSION, mode: (control ?? undefinedRow()).mode };
}
function undefinedRow() {
  throw new PythonError("TypeError", "'NoneType' object is not subscriptable");
}
function commandEnqueue(connection, payload) {
  const sourceId = requireId(pyGet(payload, "sourceId"), "sourceId");
  const taskId = requireId(pyGet(payload, "taskId"), "taskId");
  const reportId = requireReportId(pyOr(pyGet(payload, "reportId"), `${taskId}-report`));
  const reportSha = requireSha256(pyGet(payload, "reportSha256"), "reportSha256");
  let taskSha = pyGet(payload, "taskSha256");
  if (pyTruthy(taskSha)) taskSha = requireSha256(taskSha, "taskSha256");
  let itemId = pyOr(pyGet(payload, "itemId"), `${sourceId}:${taskId}:${reportSha.slice(0, 12)}`);
  itemId = requireItemId(itemId);
  const dependencies = pyIter(pyGet(payload, "dependencies", [])).map((item) => requireId(item, "dependency"));
  const now = utcNow();
  const reportKey = `${sourceId}:${taskId}:${reportSha}`;
  return immediate(connection, () => {
    let existingTask = connection.get(
      "SELECT * FROM queue_items WHERE source_id = ? AND task_id = ?",
      [sourceId, taskId]
    );
    if (existingTask !== null) {
      if (existingTask.report_sha256 !== reportSha) {
        throw valueError(`Task ${sourceId}/${taskId} already has a different immutable report`);
      }
      const mergedEvidence = mergeReportCorrectionEvidence(
        jsonValue(existingTask.evidence_json, []),
        pyGet(payload, "evidence", []),
        existingTask.state
      );
      if (!pyEquals(mergedEvidence, jsonValue(existingTask.evidence_json, []))) {
        connection.run(
          "UPDATE queue_items SET evidence_json = ?, updated_at_utc = ? WHERE item_id = ?",
          [jsonText(mergedEvidence), now, existingTask.item_id]
        );
        addEvent(connection, "queue.item_evidence_augmented", {
          itemId: existingTask.item_id,
          payload: { kinds: [...CORRECTION_EVIDENCE_KINDS].sort(pyKeyCompare) },
          atUtc: now
        });
        existingTask = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [existingTask.item_id]);
      }
      return commit(connection, { created: false, item: itemFromRow(existingTask) });
    }
    connection.run(`
            INSERT INTO queue_items(
              item_id, report_key, source_id, task_id, report_id, title,
              report_status, report_sha256, task_sha256, source_revision,
              report_path, task_path, decision_path, priority, dispatch_sequence,
              dependencies_json, plan_json, blockers_json, evidence_json,
              state, phase, current_action, summary, created_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
      itemId,
      reportKey,
      sourceId,
      taskId,
      reportId,
      boundedText(pyOr(pyGet(payload, "title"), taskId), 256),
      boundedText(pyOr(pyGet(payload, "reportStatus"), "completed"), 32),
      reportSha,
      taskSha,
      boundedText(pyOr(pyGet(payload, "sourceRevision"), "unknown"), 256),
      boundedText(pyOr(pyGet(payload, "reportPath"), ""), 2048),
      boundedText(pyGet(payload, "taskPath"), 2048),
      boundedText(pyGet(payload, "decisionPath"), 2048),
      pyInt(pyGet(payload, "priority", 0)),
      pyInt(pyGet(payload, "dispatchSequence", 0)),
      jsonText(dependencies),
      jsonText(pyGet(payload, "plan", [])),
      jsonText(pyGet(payload, "blockers", [])),
      jsonText(pyGet(payload, "evidence", [])),
      "queued",
      "intake",
      "Waiting for serialized review",
      boundedText(pyOr(pyGet(payload, "summary"), ""), 2048),
      now,
      now
    ]);
    addEvent(connection, "queue.item_enqueued", {
      itemId,
      payload: { sourceId, taskId, reportSha256: reportSha },
      atUtc: now
    });
    const row2 = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { created: true, item: itemFromRow(row2) });
  });
}
function dependenciesSatisfied(connection, dependencies) {
  for (const taskId of pyIter(dependencies)) {
    const row2 = connection.get(
      "SELECT state, final_decision FROM queue_items WHERE task_id = ? ORDER BY created_at_utc DESC LIMIT 1",
      [taskId]
    );
    if (row2 === null || !["accepted", "reviewed", "integrated"].includes(row2.state) || row2.final_decision !== "accepted") return false;
  }
  return true;
}
function leaseSeconds(payload) {
  return pyClampInt(pyGet(payload, "leaseSeconds", 120), 15, 3600);
}
function commandClaim(connection, payload) {
  const owner = boundedText(pyOr(pyGet(payload, "owner"), `process-${process.pid}`), 128);
  let requestedSource = pyGet(payload, "sourceId");
  let requestedTask = pyGet(payload, "taskId");
  if (pyTruthy(requestedSource) !== pyTruthy(requestedTask)) {
    throw valueError("sourceId and taskId must be supplied together for a targeted claim");
  }
  if (pyTruthy(requestedSource)) {
    requestedSource = requireId(requestedSource, "sourceId");
    requestedTask = requireId(requestedTask, "taskId");
  }
  const seconds = leaseSeconds(payload);
  const nowMicros = nowMicroseconds();
  const now = isoFromMicroseconds(nowMicros);
  const expires = isoFromMicroseconds(nowMicros + seconds * 1e6);
  return immediate(connection, () => {
    const control = connection.get("SELECT * FROM control_state WHERE singleton_id = 1");
    if (control.mode !== "running") {
      return commit(connection, { item: null, reason: `control-${pyStr(control.mode)}` });
    }
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const active = connection.get(
      `SELECT * FROM queue_items WHERE state IN (${placeholders}) ORDER BY updated_at_utc LIMIT 1`,
      ACTIVE_STATES
    );
    if (active !== null) {
      return commit(connection, { item: null, reason: "active-review", active: itemFromRow(active) });
    }
    const candidates = pyTruthy(requestedSource) ? connection.all(`
                SELECT * FROM queue_items
                WHERE state = 'queued' AND source_id = ? AND task_id = ?
                ORDER BY priority DESC, dispatch_sequence ASC, created_at_utc ASC, item_id ASC
                `, [requestedSource, requestedTask]) : connection.all(`
                SELECT * FROM queue_items
                WHERE state = 'queued'
                ORDER BY priority DESC, dispatch_sequence ASC, created_at_utc ASC, item_id ASC
                `);
    let selected = null;
    for (const candidate of candidates) {
      if (dependenciesSatisfied(connection, jsonValue(candidate.dependencies_json, []))) {
        selected = candidate;
        break;
      }
    }
    if (selected === null) {
      connection.exec("COMMIT");
      let reason;
      if (pyTruthy(requestedSource)) {
        const existing = connection.get(
          "SELECT state FROM queue_items WHERE source_id = ? AND task_id = ?",
          [requestedSource, requestedTask]
        );
        reason = existing !== null ? `requested-item-${pyStr(existing.state)}` : "requested-item-not-found";
        if (candidates.length > 0) reason = "dependencies-not-ready";
      } else {
        reason = candidates.length > 0 ? "dependencies-not-ready" : "queue-empty";
      }
      return { item: null, reason };
    }
    const leaseToken = randomUUID7();
    connection.run(`
            UPDATE queue_items
            SET state = 'leased', phase = 'review-starting', current_action = ?,
                lease_token = ?, lease_owner = ?, lease_expires_at_utc = ?,
                attempts = attempts + 1, started_at_utc = COALESCE(started_at_utc, ?),
                updated_at_utc = ?
            WHERE item_id = ? AND state = 'queued'
            `, ["Starting serialized review", leaseToken, owner, expires, now, now, selected.item_id]);
    addEvent(connection, "queue.item_claimed", {
      itemId: selected.item_id,
      payload: { owner, leaseExpiresAtUtc: expires },
      atUtc: now
    });
    const claimed = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [selected.item_id]);
    return commit(connection, { item: itemFromRow(claimed), reason: "claimed" });
  });
}
function commandAccept(connection, payload) {
  const sourceId = requireId(pyGet(payload, "sourceId"), "sourceId");
  const taskId = requireId(pyGet(payload, "taskId"), "taskId");
  const reportSha = requireSha256(pyGet(payload, "reportSha256"), "reportSha256");
  const evidence = pyOr(pyGet(payload, "evidence"), []);
  if (!Array.isArray(evidence)) throw valueError("Acceptance evidence must be an array");
  const acceptanceEvidence = evidence.filter((entry) => isDict(entry) && pyEquals(pyGet(entry, "kind"), "acceptance"));
  if (acceptanceEvidence.length !== 1) {
    throw valueError("Deterministic acceptance requires exactly one acceptance evidence reference");
  }
  requireSha256(pyGet(acceptanceEvidence[0], "sha256"), "acceptance evidence sha256");
  const summary2 = boundedText(pyOr(pyGet(payload, "summary"), "Deterministic acceptance passed"), 2048);
  const plan = pyGet(payload, "plan");
  const now = utcNow();
  return immediate(connection, () => {
    const row2 = connection.get("SELECT * FROM queue_items WHERE source_id = ? AND task_id = ?", [sourceId, taskId]);
    if (row2 === null) throw valueError(`Queue item does not exist: ${sourceId}/${taskId}`);
    if (row2.report_sha256 !== reportSha) throw valueError(`Report SHA-256 changed for ${sourceId}/${taskId}`);
    if (row2.state === "accepted" && row2.final_decision === "accepted") {
      return commit(connection, { accepted: true, idempotent: true, item: itemFromRow(row2) });
    }
    if (row2.state !== "queued") {
      throw valueError(`Queue item ${sourceId}/${taskId} cannot be accepted from state ${pyStr(row2.state)}`);
    }
    const control = connection.get("SELECT mode FROM control_state WHERE singleton_id = 1");
    if (control.mode !== "running") {
      throw valueError(`Control is ${pyStr(control.mode)}; deterministic acceptance is not allowed`);
    }
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const active = connection.get(
      `SELECT item_id FROM queue_items WHERE state IN (${placeholders}) LIMIT 1`,
      ACTIVE_STATES
    );
    if (active !== null) throw valueError(`Another serialized operation is active: ${pyStr(active.item_id)}`);
    if (row2.report_status !== "completed") {
      throw valueError(`Only a completed child report can be accepted, got ${pyStr(row2.report_status)}`);
    }
    if (pyTruthy(jsonValue(row2.blockers_json, []))) {
      throw valueError("A report with unresolved blockers cannot be accepted");
    }
    if (!dependenciesSatisfied(connection, jsonValue(row2.dependencies_json, []))) {
      throw valueError("Report dependencies are not ready for deterministic acceptance");
    }
    const completedPlan = Array.isArray(plan) ? plan : pyIter(jsonValue(row2.plan_json, [])).filter(isDict).map((step) => ({ ...step, state: "completed" }));
    connection.run(`
            UPDATE queue_items
            SET state = 'accepted', phase = 'complete', current_action = ?, summary = ?,
                final_decision = 'accepted', evidence_json = ?, plan_json = ?,
                lease_token = NULL, lease_owner = NULL, lease_expires_at_utc = NULL,
                finished_at_utc = COALESCE(finished_at_utc, ?), updated_at_utc = ?
            WHERE item_id = ? AND state = 'queued'
            `, [
      "Verified child report accepted without model review",
      summary2,
      jsonText(evidence),
      jsonText(completedPlan),
      now,
      now,
      row2.item_id
    ]);
    addEvent(connection, "queue.item_accepted", {
      itemId: row2.item_id,
      payload: { sourceId, taskId, reportSha256: reportSha, method: "deterministic" },
      atUtc: now
    });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [row2.item_id]);
    return commit(connection, { accepted: true, idempotent: false, item: itemFromRow(updated) });
  });
}
var PATCH_COLUMNS = {
  phase: ["phase", (value) => boundedText(value, 64)],
  currentAction: ["current_action", (value) => boundedText(value, 512)],
  summary: ["summary", (value) => boundedText(value, 2048)],
  threadId: ["thread_id", (value) => boundedText(value, 256)],
  turnId: ["turn_id", (value) => boundedText(value, 256)],
  error: ["error", (value) => boundedText(value, 2048)],
  finalDecision: ["final_decision", (value) => boundedText(value, 32)],
  decisionReference: ["decision_reference", (value) => boundedText(value, 2048)],
  leaseExpiresAtUtc: ["lease_expires_at_utc", (value) => boundedText(value, 64)],
  finishedAtUtc: ["finished_at_utc", (value) => boundedText(value, 64)],
  plan: ["plan_json", jsonText],
  blockers: ["blockers_json", jsonText],
  evidence: ["evidence_json", jsonText]
};
function pyContains(container, value) {
  if (typeof container === "string") {
    if (typeof value !== "string") {
      throw new PythonError("TypeError", `'in <string>' requires string as left operand, not ${pyTypeName(value)}`);
    }
    return container.includes(value);
  }
  if (isDict(container)) return Object.hasOwn(container, pyStr(value)) && typeof value === "string";
  return pyIter(container).some((entry) => pyEquals(entry, value));
}
function commandTransition(connection, payload) {
  const itemId = requireItemId(pyGet(payload, "itemId"));
  const target = pyStr(pyOr(pyGet(payload, "toState"), ""));
  if (!ITEM_STATES.has(target)) throw valueError(`Unsupported queue state: ${target}`);
  let expected = pyOr(pyGet(payload, "fromStates"), []);
  if (typeof expected === "string") expected = [expected];
  if (pyIter(expected).some((state) => pyHashKey(state) && !inSet(ITEM_STATES, state))) {
    throw valueError("fromStates contains an unsupported state");
  }
  const patch = pyOr(pyGet(payload, "patch"), {});
  const leaseToken = pyGet(payload, "leaseToken");
  const now = utcNow();
  return immediate(connection, () => {
    const row2 = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    if (row2 === null) throw valueError(`Queue item does not exist: ${itemId}`);
    if (pyTruthy(expected) && !pyContains(expected, row2.state)) {
      throw valueError(`Queue item ${itemId} is ${pyStr(row2.state)}, expected one of ${pyStr(expected)}`);
    }
    if (pyTruthy(leaseToken) && !pyEquals(row2.lease_token, leaseToken)) {
      throw valueError(`Lease token does not own queue item ${itemId}`);
    }
    const assignments = ["state = ?", "updated_at_utc = ?"];
    const values = [target, now];
    for (const [key, value] of dictItems(patch)) {
      if (!Object.hasOwn(PATCH_COLUMNS, key)) throw valueError(`Unsupported transition patch field: ${key}`);
      const [column, converter] = PATCH_COLUMNS[key];
      if (key === "finalDecision" && value !== null && pyHashKey(value) && !inSet(DECISIONS, value)) {
        throw valueError(`Unsupported final decision: ${pyStr(value)}`);
      }
      assignments.push(`${column} = ?`);
      values.push(converter(value));
    }
    if (TERMINAL_STATES.has(target) || target === "reviewed" || target === "stop_unconfirmed") {
      assignments.push("lease_token = NULL", "lease_owner = NULL", "lease_expires_at_utc = NULL");
    }
    if (TERMINAL_STATES.has(target) || target === "stop_unconfirmed") {
      assignments.push("finished_at_utc = COALESCE(finished_at_utc, ?)");
      values.push(now);
    }
    values.push(itemId);
    connection.run(`UPDATE queue_items SET ${assignments.join(", ")} WHERE item_id = ?`, values);
    addEvent(connection, "queue.state_changed", {
      itemId,
      payload: { from: row2.state, to: target, patchKeys: Object.keys(patch).sort(pyKeyCompare) },
      atUtc: now
    });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { item: itemFromRow(updated) });
  });
}
function commandHeartbeat(connection, payload) {
  const itemId = requireItemId(pyGet(payload, "itemId"));
  const leaseToken = pyGet(payload, "leaseToken");
  const seconds = leaseSeconds(payload);
  const nowMicros = nowMicroseconds();
  const now = isoFromMicroseconds(nowMicros);
  const expires = isoFromMicroseconds(nowMicros + seconds * 1e6);
  const row2 = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
  if (row2 === null) throw valueError(`Queue item does not exist: ${itemId}`);
  if (pyTruthy(leaseToken) && !pyEquals(row2.lease_token, leaseToken)) {
    throw valueError(`Lease token does not own queue item ${itemId}`);
  }
  connection.run(`
        UPDATE queue_items
        SET lease_expires_at_utc = ?, current_action = COALESCE(?, current_action), updated_at_utc = ?
        WHERE item_id = ?
        `, [expires, boundedText(pyGet(payload, "currentAction"), 512), now, itemId]);
  addEvent(connection, "queue.heartbeat", { itemId, payload: { leaseExpiresAtUtc: expires }, atUtc: now });
  return { item: itemFromRow(connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId])) };
}
function commandSetMode(connection, payload) {
  const mode = pyStr(pyOr(pyGet(payload, "mode"), ""));
  if (!CONTROL_MODES.has(mode)) throw valueError(`Unsupported control mode: ${mode}`);
  const reason = boundedText(pyGet(payload, "reason"), 1024);
  const now = utcNow();
  return immediate(connection, () => {
    const previous = connection.get("SELECT * FROM control_state WHERE singleton_id = 1");
    connection.run(
      "UPDATE control_state SET mode = ?, reason = ?, updated_at_utc = ? WHERE singleton_id = 1",
      [mode, reason, now]
    );
    if (mode === "emergency_stopped") {
      const placeholders = ACTIVE_STATES.map(() => "?").join(",");
      connection.run(`
                UPDATE queue_items
                SET state = 'cancelling', phase = 'emergency-stop',
                    current_action = 'Emergency stop requested', updated_at_utc = ?
                WHERE state IN (${placeholders})
                `, [now, ...ACTIVE_STATES]);
      connection.run(`
                UPDATE agents
                SET state = 'cancellation_requested', current_action = 'Emergency stop requested',
                    updated_at_utc = ?
                WHERE state IN ('starting', 'running', 'waiting', 'blocked')
                `, [now]);
      connection.run(`
                UPDATE worker_tasks
                SET state = 'cancelling', phase = 'emergency-stop',
                    summary_json = ?, updated_at_utc = ?
                WHERE state IN ('accepted', 'running', 'waiting', 'blocked')
                `, [jsonText({
        now: "Emergency stop requested",
        done: [],
        next: [],
        blockers: [pyOr(reason, "Emergency stop requested")]
      }), now]);
      connection.run(`
                UPDATE worker_agents
                SET state = 'cancellation_requested', current_action = 'Emergency stop requested',
                    updated_at_utc = ?
                WHERE state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                `, [now]);
    }
    addEvent(connection, "control.mode_changed", {
      payload: { from: (previous ?? undefinedRow()).mode, to: mode, reason },
      atUtc: now
    });
    return commit(connection, { mode, reason, updatedAtUtc: now });
  });
}
function commandUpsertProgress(connection, payload) {
  const sourceId = requireId(pyGet(payload, "sourceId"), "sourceId");
  const taskId = requireId(pyGet(payload, "taskId"), "taskId");
  const state = pyStr(pyOr(pyGet(payload, "state"), "running"));
  if (!WORKER_TASK_STATES.has(state)) throw valueError(`Unsupported worker task state: ${state}`);
  const progressSha = requireSha256(pyGet(payload, "progressSha256"), "progressSha256");
  const progressSequence = pyAtLeast(pyGet(payload, "sequence", 0), 0);
  const summary2 = pyOr(pyGet(payload, "summary"), {});
  if (!isDict(summary2)) throw valueError("Worker progress summary must be an object");
  const agents = pyOr(pyGet(payload, "agents"), []);
  if (!Array.isArray(agents) || agents.length > 256) throw valueError("Worker progress agents must be a bounded array");
  const now = utcNow();
  const updated = boundedText(pyOr(pyGet(payload, "updatedAtUtc"), now), 64);
  return immediate(connection, () => {
    const existing = connection.get(
      "SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?",
      [sourceId, taskId]
    );
    if (existing !== null && pyInt(existing.progress_sequence) > progressSequence) {
      return commit(connection, { updated: false, reason: "older-sequence", task: workerTaskFromRow(existing) });
    }
    const changed = existing === null || existing.progress_sha256 !== progressSha;
    const incomingTiming = pyOr(pyGet(payload, "timing"), {});
    const existingTiming = existing !== null ? jsonValue(existing.timing_json, {}) : {};
    const incomingSemanticAt = pyGet(incomingTiming, "semanticUpdatedAtUtc");
    const semanticChanged = changed && (existing === null || !pyTruthy(incomingSemanticAt) || !pyEquals(pyGet(existingTiming, "semanticUpdatedAtUtc"), incomingSemanticAt));
    connection.run(`
            INSERT INTO worker_tasks(
              source_id, task_id, title, state, phase, summary_json, plan_json,
              workflow_json, timing_json, blockers_json, evidence_json, stop_events_json, progress_sequence,
              progress_sha256, progress_path, started_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, task_id) DO UPDATE SET
              title = excluded.title,
              state = excluded.state,
              phase = excluded.phase,
              summary_json = excluded.summary_json,
              plan_json = excluded.plan_json,
              workflow_json = excluded.workflow_json,
              timing_json = excluded.timing_json,
              blockers_json = excluded.blockers_json,
              evidence_json = excluded.evidence_json,
              stop_events_json = excluded.stop_events_json,
              progress_sequence = excluded.progress_sequence,
              progress_sha256 = excluded.progress_sha256,
              progress_path = excluded.progress_path,
              started_at_utc = COALESCE(worker_tasks.started_at_utc, excluded.started_at_utc),
              updated_at_utc = excluded.updated_at_utc
            `, [
      sourceId,
      taskId,
      boundedText(pyOr(pyGet(payload, "title"), taskId), 256),
      state,
      boundedText(pyOr(pyGet(payload, "phase"), "execution"), 64),
      jsonText(summary2),
      jsonText(pyOr(pyGet(payload, "plan"), [])),
      jsonText(pyOr(pyGet(payload, "workflow"), {})),
      jsonText(pyOr(pyGet(payload, "timing"), {})),
      jsonText(pyOr(pyOr(pyGet(payload, "blockers"), pyGet(summary2, "blockers")), [])),
      jsonText(pyOr(pyGet(payload, "evidence"), [])),
      jsonText(pyOr(pyGet(payload, "stopEvents"), [])),
      progressSequence,
      progressSha,
      boundedText(pyOr(pyGet(payload, "progressPath"), ""), 2048),
      boundedText(pyGet(payload, "startedAtUtc"), 64),
      updated
    ]);
    const incomingAgentIds = [];
    for (const agent of agents) {
      const agentId = requireId(pyGet(agent, "agentId"), "agentId");
      incomingAgentIds.push(agentId);
      const agentState = pyStr(pyOr(pyGet(agent, "state"), "running"));
      if (!AGENT_STATES.has(agentState)) throw valueError(`Unsupported worker agent state: ${agentState}`);
      let parent = pyGet(agent, "parentAgentId");
      if (pyTruthy(parent)) parent = requireId(parent, "parentAgentId");
      const existingAgent = connection.get("SELECT statistics_json FROM worker_agents WHERE agent_id = ?", [agentId]);
      const statistics = mergeAgentStatistics(
        existingAgent !== null ? jsonValue(existingAgent.statistics_json, {}) : {},
        Object.hasOwn(agent, "statistics") && agent.statistics !== void 0 ? agent.statistics : {}
      );
      connection.run(`
                INSERT INTO worker_agents(
                  agent_id, source_id, task_id, parent_agent_id, kind, role, provider,
                  state, current_action, last_completed, next_action, blockers_json,
                  can_interrupt, started_at_utc, last_heartbeat_utc, semantic_updated_at_utc,
                  statistics_json, updated_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                  source_id = excluded.source_id,
                  task_id = excluded.task_id,
                  parent_agent_id = excluded.parent_agent_id,
                  kind = excluded.kind,
                  role = excluded.role,
                  provider = excluded.provider,
                  state = CASE
                    WHEN worker_agents.state = 'cancellation_requested'
                     AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    THEN worker_agents.state
                    ELSE excluded.state
                  END,
                  current_action = CASE
                    WHEN worker_agents.state = 'cancellation_requested'
                     AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    THEN worker_agents.current_action
                    ELSE excluded.current_action
                  END,
                  last_completed = excluded.last_completed,
                  next_action = excluded.next_action,
                  blockers_json = excluded.blockers_json,
                  can_interrupt = excluded.can_interrupt,
                  started_at_utc = COALESCE(worker_agents.started_at_utc, excluded.started_at_utc),
                  last_heartbeat_utc = excluded.last_heartbeat_utc,
                  semantic_updated_at_utc = excluded.semantic_updated_at_utc,
                  statistics_json = excluded.statistics_json,
                  updated_at_utc = excluded.updated_at_utc
                `, [
        agentId,
        sourceId,
        taskId,
        parent,
        boundedText(pyOr(pyGet(agent, "kind"), "primary"), 32),
        boundedText(pyOr(pyGet(agent, "role"), "child-project-agent"), 128),
        boundedText(pyGet(agent, "provider"), 64),
        agentState,
        boundedText(pyOr(pyGet(agent, "currentAction"), ""), 512),
        boundedText(pyGet(agent, "lastCompleted"), 512),
        boundedText(pyGet(agent, "nextAction"), 512),
        jsonText(pyOr(pyGet(agent, "blockers"), [])),
        pyTruthy(pyGet(agent, "canInterrupt")) ? 1 : 0,
        boundedText(pyGet(agent, "startedAtUtc"), 64),
        boundedText(pyOr(pyGet(agent, "lastHeartbeatUtc"), updated), 64),
        boundedText(pyOr(pyOr(pyGet(agent, "semanticUpdatedAtUtc"), pyGet(agent, "updatedAtUtc")), updated), 64),
        jsonText(statistics),
        boundedText(pyOr(pyGet(agent, "updatedAtUtc"), updated), 64)
      ]);
    }
    if (incomingAgentIds.length > 0) {
      const placeholders = incomingAgentIds.map(() => "?").join(",");
      connection.run(
        `DELETE FROM worker_agents WHERE source_id = ? AND task_id = ? AND agent_id NOT IN (${placeholders})`,
        [sourceId, taskId, ...incomingAgentIds]
      );
    } else {
      connection.run("DELETE FROM worker_agents WHERE source_id = ? AND task_id = ?", [sourceId, taskId]);
    }
    if (semanticChanged) {
      addEvent(connection, "worker.progress_updated", {
        payload: { sourceId, taskId, state, sequence: progressSequence },
        atUtc: pyOr(incomingSemanticAt, updated)
      });
    }
    const row2 = connection.get("SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?", [sourceId, taskId]);
    return commit(connection, {
      updated: changed,
      semanticUpdated: semanticChanged,
      reason: "stored",
      task: workerTaskFromRow(row2)
    });
  });
}
function commandRequestCancel(connection, payload) {
  let itemId = pyGet(payload, "itemId");
  let taskId = pyGet(payload, "taskId");
  let agentId = pyGet(payload, "agentId");
  let sourceId = pyGet(payload, "sourceId");
  if (pyTruthy(sourceId)) sourceId = requireId(sourceId, "sourceId");
  let targetAgent = null;
  let workerTask = null;
  let workerAgent = null;
  if (pyTruthy(itemId)) {
    itemId = requireItemId(itemId);
  } else if (pyTruthy(taskId)) {
    taskId = requireId(taskId, "taskId");
    const queueRows = connection.all(
      "SELECT item_id FROM queue_items WHERE task_id = ? AND (? IS NULL OR source_id = ?) ORDER BY created_at_utc DESC",
      [taskId, sourceId, sourceId]
    );
    if (!pyTruthy(sourceId) && queueRows.length > 1) {
      throw valueError(`Task ID ${pyRepr(taskId)} is ambiguous; provide sourceId`);
    }
    const row2 = queueRows[0] ?? null;
    itemId = row2 !== null ? row2.item_id : null;
    if (!pyTruthy(itemId)) {
      const workerRows = connection.all(
        "SELECT * FROM worker_tasks WHERE task_id = ? AND (? IS NULL OR source_id = ?) ORDER BY updated_at_utc DESC",
        [taskId, sourceId, sourceId]
      );
      if (!pyTruthy(sourceId) && workerRows.length > 1) {
        throw valueError(`Worker task ID ${pyRepr(taskId)} is ambiguous; provide sourceId`);
      }
      workerTask = workerRows[0] ?? null;
    }
  } else if (pyTruthy(agentId)) {
    agentId = requireId(agentId, "agentId");
    targetAgent = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
    itemId = targetAgent !== null ? targetAgent.item_id : null;
    if (!pyTruthy(itemId)) {
      workerAgent = connection.get("SELECT * FROM worker_agents WHERE agent_id = ?", [agentId]);
      if (workerAgent !== null) {
        workerTask = connection.get(
          "SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?",
          [workerAgent.source_id, workerAgent.task_id]
        );
      }
    }
  } else {
    throw valueError("Cancellation requires itemId, taskId, or agentId");
  }
  if (!pyTruthy(itemId) && workerTask === null) throw valueError("Cancellation target does not exist");
  const reason = boundedText(pyOr(pyGet(payload, "reason"), "Cancellation requested"), 1024);
  const now = utcNow();
  return immediate(connection, () => {
    if (workerTask !== null) {
      const terminalWorkerStates = ["cancelled", "completed", "failed"];
      let targetState2;
      if (workerAgent !== null) {
        const terminalAgentStates = ["interrupted", "completed", "failed", "stop_unconfirmed"];
        const targetAgentState = terminalAgentStates.includes(workerAgent.state) ? workerAgent.state : "cancellation_requested";
        connection.run(`
                    UPDATE worker_agents SET state = ?, current_action = ?, updated_at_utc = ?
                    WHERE agent_id = ?
                    `, [targetAgentState, reason, now, agentId]);
        targetState2 = workerTask.state;
      } else {
        targetState2 = terminalWorkerStates.includes(workerTask.state) ? workerTask.state : "cancelling";
        const summary2 = jsonValue(workerTask.summary_json, {});
        if (Array.isArray(summary2)) {
          throw new PythonError("TypeError", "list indices must be integers or slices, not str");
        }
        if (!isDict(summary2)) {
          throw new PythonError("TypeError", `'${pyTypeName(summary2)}' object does not support item assignment`);
        }
        summary2.now = reason;
        connection.run(`
                    UPDATE worker_tasks
                    SET state = ?, phase = 'cancellation', summary_json = ?, updated_at_utc = ?
                    WHERE source_id = ? AND task_id = ?
                    `, [targetState2, jsonText(summary2), now, workerTask.source_id, workerTask.task_id]);
        connection.run(`
                    UPDATE worker_agents
                    SET state = 'cancellation_requested', current_action = ?, updated_at_utc = ?
                    WHERE source_id = ? AND task_id = ?
                      AND state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    `, [reason, now, workerTask.source_id, workerTask.task_id]);
      }
      addEvent(connection, "control.external_cancellation_requested", {
        agentId,
        payload: {
          scope: pyTruthy(agentId) ? "agent" : "task",
          sourceId: workerTask.source_id,
          taskId: workerTask.task_id,
          reason,
          state: targetState2
        },
        atUtc: now
      });
      return commit(connection, {
        item: null,
        external: true,
        sourceId: workerTask.source_id,
        taskId: workerTask.task_id,
        agentId,
        state: targetState2
      });
    }
    const row2 = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    if (row2 === null) throw valueError(`Queue item does not exist: ${pyStr(itemId)}`);
    let targetState;
    if (pyTruthy(agentId)) {
      if (targetAgent === null) throw valueError(`Agent does not exist: ${pyStr(agentId)}`);
      const terminalAgentStates = ["interrupted", "completed", "failed", "stop_unconfirmed"];
      const targetAgentState = terminalAgentStates.includes(targetAgent.state) ? targetAgent.state : "cancellation_requested";
      connection.run(`
                UPDATE agents SET state = ?, current_action = ?, updated_at_utc = ?
                WHERE agent_id = ?
                `, [targetAgentState, reason, now, agentId]);
      targetState = row2.state;
    } else {
      if (TERMINAL_STATES.has(row2.state)) targetState = row2.state;
      else if (["queued", "waiting", "blocked"].includes(row2.state)) targetState = "cancelled";
      else targetState = "cancelling";
      connection.run(`
                UPDATE queue_items
                SET state = ?, phase = 'cancellation', current_action = ?, updated_at_utc = ?,
                    finished_at_utc = CASE WHEN ? = 'cancelled' THEN COALESCE(finished_at_utc, ?) ELSE finished_at_utc END
                WHERE item_id = ?
                `, [targetState, reason, now, targetState, now, itemId]);
      connection.run(`
                UPDATE agents SET state = 'cancellation_requested', current_action = ?, updated_at_utc = ?
                WHERE item_id = ? AND state IN ('starting', 'running', 'waiting', 'blocked')
                `, [reason, now, itemId]);
    }
    addEvent(connection, "control.cancellation_requested", {
      itemId,
      agentId,
      payload: { scope: pyTruthy(agentId) ? "agent" : "task", reason, state: targetState },
      atUtc: now
    });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { item: itemFromRow(updated), agentId });
  });
}
function commandRetry(connection, payload) {
  const itemId = requireItemId(pyGet(payload, "itemId"));
  const now = utcNow();
  return immediate(connection, () => {
    const control = connection.get("SELECT mode FROM control_state WHERE singleton_id = 1");
    if (control.mode === "emergency_stopped") throw valueError("Resume control before retrying an item");
    const row2 = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    if (row2 === null) throw valueError(`Queue item does not exist: ${itemId}`);
    if (!inSet(RETRYABLE_STATES, row2.state)) {
      throw valueError(`Queue item ${itemId} is not retryable from state ${pyStr(row2.state)}`);
    }
    connection.run(`
            UPDATE queue_items
            SET state = 'queued', phase = 'retry-queued', current_action = 'Waiting for retry',
                thread_id = NULL, turn_id = NULL, lease_token = NULL, lease_owner = NULL,
                lease_expires_at_utc = NULL, error = NULL, final_decision = NULL,
                decision_reference = NULL, finished_at_utc = NULL, updated_at_utc = ?
            WHERE item_id = ?
            `, [now, itemId]);
    connection.run("DELETE FROM agents WHERE item_id = ?", [itemId]);
    addEvent(connection, "queue.item_retried", { itemId, atUtc: now });
    const updated = connection.get("SELECT * FROM queue_items WHERE item_id = ?", [itemId]);
    return commit(connection, { item: itemFromRow(updated) });
  });
}
function commandFinalizeStop(connection, payload) {
  const reason = boundedText(pyOr(pyGet(payload, "reason"), "Stop confirmation timed out"), 1024);
  const now = utcNow();
  return immediate(connection, () => {
    const queueRows = connection.all("SELECT item_id FROM queue_items WHERE state = 'cancelling'");
    connection.run(`
            UPDATE queue_items
            SET state = 'stop_unconfirmed', phase = 'stopped', current_action = ?,
                lease_token = NULL, lease_owner = NULL, lease_expires_at_utc = NULL,
                finished_at_utc = COALESCE(finished_at_utc, ?), updated_at_utc = ?
            WHERE state = 'cancelling'
            `, [reason, now, now]);
    connection.run(`
            UPDATE agents
            SET state = 'stop_unconfirmed', current_action = ?, can_interrupt = 0, updated_at_utc = ?
            WHERE state = 'cancellation_requested'
            `, [reason, now]);
    const workerRows = connection.all("SELECT source_id, task_id FROM worker_tasks WHERE state = 'cancelling'");
    connection.run(`
            UPDATE worker_tasks
            SET state = 'stop_unconfirmed', phase = 'stopped', updated_at_utc = ?
            WHERE state = 'cancelling'
            `, [now]);
    connection.run(`
            UPDATE worker_agents
            SET state = 'stop_unconfirmed', current_action = ?, can_interrupt = 0, updated_at_utc = ?
            WHERE state = 'cancellation_requested'
            `, [reason, now]);
    const queueItems = queueRows.map((row2) => row2.item_id);
    const workerTasks = workerRows.map((row2) => `${pyStr(row2.source_id)}:${pyStr(row2.task_id)}`);
    addEvent(connection, "control.stop_confirmation_timed_out", {
      payload: { reason, queueItems, workerTasks: [...workerTasks] },
      atUtc: now
    });
    return commit(connection, { queueItems: [...queueItems], workerTasks, reason });
  });
}
function commandRecover(connection) {
  const nowMicros = nowMicroseconds();
  const now = isoFromMicroseconds(nowMicros);
  const recovered = [];
  return immediate(connection, () => {
    const rows = connection.all(`
            SELECT * FROM queue_items
            WHERE state IN ('leased', 'review_running', 'decision_validating', 'integrating', 'cancelling')
              AND lease_expires_at_utc IS NOT NULL
            `);
    for (const row2 of rows) {
      const expires = parseUtcMicroseconds(row2.lease_expires_at_utc);
      if (expires === null || expires > nowMicros) continue;
      let target;
      let action;
      if (row2.state === "leased" && !pyTruthy(row2.thread_id)) {
        target = "queued";
        action = "Recovered expired pre-turn lease";
      } else if (row2.state === "cancelling") {
        target = "stop_unconfirmed";
        action = "Cancellation lease expired without provider confirmation";
      } else {
        target = "recovery_required";
        action = "Provider reconciliation required after lease expiry";
      }
      connection.run(`
                UPDATE queue_items
                SET state = ?, phase = 'recovery', current_action = ?, lease_token = NULL,
                    lease_owner = NULL, lease_expires_at_utc = NULL, updated_at_utc = ?
                WHERE item_id = ?
                `, [target, action, now, row2.item_id]);
      addEvent(connection, "queue.lease_recovered", {
        itemId: row2.item_id,
        payload: { from: row2.state, to: target },
        atUtc: now
      });
      recovered.push({ itemId: row2.item_id, from: row2.state, to: target });
    }
    return commit(connection, { recovered });
  });
}
function commandUpsertAgent(connection, payload) {
  const agentId = requireId(pyGet(payload, "agentId"), "agentId");
  const itemId = requireItemId(pyGet(payload, "itemId"));
  let parent = pyGet(payload, "parentAgentId");
  if (pyTruthy(parent)) parent = requireId(parent, "parentAgentId");
  const state = pyStr(pyOr(pyGet(payload, "state"), "registered"));
  if (!AGENT_STATES.has(state)) throw valueError(`Unsupported agent state: ${state}`);
  const now = utcNow();
  const starting = state === "starting" || state === "running";
  const started = pyOr(pyGet(payload, "startedAtUtc"), starting ? now : null);
  const heartbeat = pyOr(pyGet(payload, "lastHeartbeatUtc"), starting ? now : null);
  const existingAgent = connection.get("SELECT statistics_json FROM agents WHERE agent_id = ?", [agentId]);
  const statistics = mergeAgentStatistics(
    existingAgent !== null ? jsonValue(existingAgent.statistics_json, {}) : {},
    Object.hasOwn(payload, "statistics") && payload.statistics !== void 0 ? payload.statistics : {}
  );
  connection.run(`
        INSERT INTO agents(
          agent_id, item_id, parent_agent_id, kind, role, provider, state,
          current_action, last_completed, next_action, blockers_json,
          thread_id, turn_id, can_interrupt, started_at_utc,
          last_heartbeat_utc, statistics_json, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          item_id = excluded.item_id,
          parent_agent_id = COALESCE(excluded.parent_agent_id, agents.parent_agent_id),
          kind = excluded.kind,
          role = excluded.role,
          provider = excluded.provider,
          state = CASE
            WHEN agents.state = 'cancellation_requested'
             AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
            THEN agents.state
            ELSE excluded.state
          END,
          current_action = CASE
            WHEN agents.state = 'cancellation_requested'
             AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
            THEN agents.current_action
            ELSE excluded.current_action
          END,
          last_completed = excluded.last_completed,
          next_action = excluded.next_action,
          blockers_json = excluded.blockers_json,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          can_interrupt = excluded.can_interrupt,
          started_at_utc = COALESCE(agents.started_at_utc, excluded.started_at_utc),
          last_heartbeat_utc = excluded.last_heartbeat_utc,
          statistics_json = excluded.statistics_json,
          updated_at_utc = excluded.updated_at_utc
        `, [
    agentId,
    itemId,
    parent,
    boundedText(pyOr(pyGet(payload, "kind"), "primary"), 32),
    boundedText(pyOr(pyGet(payload, "role"), "worker"), 128),
    boundedText(pyGet(payload, "provider"), 64),
    state,
    boundedText(pyOr(pyGet(payload, "currentAction"), ""), 512),
    boundedText(pyGet(payload, "lastCompleted"), 512),
    boundedText(pyGet(payload, "nextAction"), 512),
    jsonText(pyGet(payload, "blockers", [])),
    boundedText(pyGet(payload, "threadId"), 256),
    boundedText(pyGet(payload, "turnId"), 256),
    pyTruthy(pyGet(payload, "canInterrupt")) ? 1 : 0,
    started,
    heartbeat,
    jsonText(statistics),
    now
  ]);
  addEvent(connection, "agent.preview_updated", {
    itemId,
    agentId,
    payload: { state, currentAction: boundedText(pyOr(pyGet(payload, "currentAction"), ""), 256) },
    atUtc: now
  });
  const row2 = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
  return { agent: agentFromRow(row2) };
}
function commandUpsertAgentStatistics(connection, payload) {
  const agentId = requireId(pyGet(payload, "agentId"), "agentId");
  const incoming = agentStatistics(pyGet(payload, "statistics"));
  const row2 = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
  if (row2 === null) throw valueError(`Agent does not exist: ${agentId}`);
  const merged = mergeAgentStatistics(jsonValue(row2.statistics_json, {}), incoming);
  const now = utcNow();
  connection.run("UPDATE agents SET statistics_json = ? WHERE agent_id = ?", [jsonText(merged), agentId]);
  addEvent(connection, "agent.statistics_updated", {
    itemId: row2.item_id,
    agentId,
    payload: {
      tokenStatus: pyGet(pyGet(merged, "tokens", {}), "status", "unavailable"),
      costStatus: pyGet(pyGet(merged, "cost", {}), "status", "unavailable")
    },
    atUtc: now
  });
  const updated = connection.get("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
  return { agent: agentFromRow(updated) };
}
function commandAddEvent(connection, payload) {
  let itemId = pyGet(payload, "itemId");
  let agentId = pyGet(payload, "agentId");
  if (pyTruthy(itemId)) itemId = requireItemId(itemId);
  if (pyTruthy(agentId)) agentId = requireId(agentId, "agentId");
  const eventType = boundedText(pyOr(pyGet(payload, "type"), "custom.event"), 128);
  const sequence = addEvent(connection, eventType, { itemId, agentId, payload: pyOr(pyGet(payload, "data"), {}) });
  return { sequence };
}
function commandSnapshot(connection, payload) {
  const eventLimit = pyClampInt(pyGet(payload, "eventLimit", 200), 0, 1e3);
  const control = connection.get("SELECT * FROM control_state WHERE singleton_id = 1") ?? undefinedRow();
  const items = connection.all(`
        SELECT * FROM queue_items
        ORDER BY
          CASE WHEN state IN ('leased','review_running','decision_validating','integrating','cancelling','recovery_required')
               THEN 0 WHEN state = 'queued' THEN 1 ELSE 2 END,
          priority DESC, dispatch_sequence ASC, created_at_utc ASC
        `).map(itemFromRow);
  const agents = connection.all("SELECT * FROM agents ORDER BY item_id, parent_agent_id, agent_id").map(agentFromRow);
  const workerTasks = connection.all("SELECT * FROM worker_tasks ORDER BY updated_at_utc DESC, source_id, task_id").map(workerTaskFromRow);
  const workerAgents = connection.all("SELECT * FROM worker_agents ORDER BY source_id, task_id, parent_agent_id, agent_id").map(workerAgentFromRow);
  const eventRows = connection.all("SELECT * FROM events ORDER BY sequence DESC LIMIT ?", [eventLimit]);
  const events = eventRows.reverse().map(eventFromRow);
  const sequence = connection.value("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events");
  const counts = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return {
    formatVersion: FORMAT_VERSION,
    sequence: pyInt(sequence),
    control: { mode: control.mode, reason: control.reason, updatedAtUtc: control.updated_at_utc },
    counts,
    items,
    agents,
    workerTasks,
    workerAgents,
    events
  };
}
function expandUser(text3) {
  return /^~(?:$|[\/])/u.test(text3) ? path12.join(homedir(), text3.slice(1)) : text3;
}
function compactStamp(microseconds) {
  return new Date(Math.floor(microseconds / 1e3)).toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").concat("Z");
}
function commandCompact(connection, payload) {
  const retentionDays = pyClampInt(pyGet(payload, "retentionDays", 30), 1, 3650);
  const archiveRoot = resolvedDatabasePath(expandUser(pyStr(pyOr(pyGet(payload, "archiveRoot"), ""))) || ".");
  mkdirSync(archiveRoot, { recursive: true });
  const cutoff = isoFromMicroseconds(nowMicroseconds() - retentionDays * 864e8);
  const terminalPlaceholders = FINAL_STATES.map(() => "?").join(",");
  const rows = connection.all(`
        SELECT events.* FROM events
        LEFT JOIN queue_items ON queue_items.item_id = events.item_id
        WHERE events.at_utc < ?
          AND (events.item_id IS NULL OR queue_items.state IN (${terminalPlaceholders}))
        ORDER BY events.sequence
        `, [cutoff, ...FINAL_STATES]);
  if (rows.length === 0) return { archivedEvents: 0, cutoffUtc: cutoff, archive: null };
  const firstSequence = rows[0].sequence;
  const lastSequence = rows.at(-1).sequence;
  const stamp3 = compactStamp(nowMicroseconds());
  const fileName = `control-events-${firstSequence}-${lastSequence}-${stamp3}.jsonl.gz`;
  const archivePath = path12.join(archiveRoot, fileName);
  const lines2 = rows.map((row2) => `${pythonJson(eventFromRow(row2))}
`).join("");
  const uncompressed = utf8(lines2);
  writeFileSync(archivePath, gzipSync(uncompressed, { level: 9 }));
  const compressedHash = createHash11("sha256").update(readFileSync(archivePath)).digest("hex");
  const manifest = {
    schemaVersion: 1,
    archiveFile: fileName,
    eventCount: rows.length,
    firstSequence,
    lastSequence,
    uncompressedSha256: createHash11("sha256").update(uncompressed).digest("hex"),
    compressedSha256: compressedHash,
    createdAtUtc: utcNow()
  };
  const manifestPath = `${archivePath}.manifest.json`;
  const manifestText = `${JSON.stringify(manifest, null, 2)}
`;
  writeFileSync(manifestPath, process.platform === "win32" ? manifestText.replaceAll("\n", "\r\n") : manifestText, "utf8");
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.run("DELETE FROM events WHERE sequence >= ? AND sequence <= ?", [firstSequence, lastSequence]);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    for (const file of [archivePath, manifestPath]) {
      try {
        unlinkSync(file);
      } catch {
      }
    }
    throw error;
  }
  connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { archivedEvents: rows.length, cutoffUtc: cutoff, archive: manifest };
}
var CONTROL_COMMANDS = Object.freeze({
  init: commandInit,
  enqueue: commandEnqueue,
  claim: commandClaim,
  accept: commandAccept,
  transition: commandTransition,
  heartbeat: commandHeartbeat,
  "set-mode": commandSetMode,
  "upsert-progress": commandUpsertProgress,
  "request-cancel": commandRequestCancel,
  "finalize-stop": commandFinalizeStop,
  retry: commandRetry,
  recover: commandRecover,
  "upsert-agent": commandUpsertAgent,
  "upsert-agent-statistics": commandUpsertAgentStatistics,
  "add-event": commandAddEvent,
  snapshot: commandSnapshot,
  compact: commandCompact
});
function runControlCommand(sqlite, databasePath, command, payload) {
  try {
    if (typeof command !== "string" || !Object.hasOwn(CONTROL_COMMANDS, command)) {
      const names = Object.keys(CONTROL_COMMANDS).sort();
      const error = new PythonError("SystemExit", [
        "usage: sqlite-control-store.py [-h] --database DATABASE",
        `${" ".repeat(31)}{${names.join(",")}}`,
        `sqlite-control-store.py: error: argument command: invalid choice: ${pyRepr(pyStr(command))} (choose from ${names.join(", ")})`
      ].join("\n"));
      error.exitCode = 2;
      throw error;
    }
    const request = jsonTransport(payload);
    if (!isDict(request)) throw valueError("Command payload must be a JSON object");
    const connection = connect(sqlite, databasePath);
    try {
      migrate(connection);
      return CONTROL_COMMANDS[command](connection, request);
    } finally {
      connection.close();
    }
  } catch (error) {
    error.exitCode ??= 1;
    error.pythonMessage ??= error instanceof PythonError ? error.message : String(error?.message ?? error);
    throw error;
  }
}

// orchestrator/src/sqlite-control-store.mjs
var CURRENT_DIRECTORY = path13.dirname(fileURLToPath(import.meta.url));
var DEFAULT_BRIDGE = path13.join(CURRENT_DIRECTORY, "sqlite-control-store.py");
var MAX_BRIDGE_OUTPUT_BYTES = 4 * 1024 * 1024;
var NODE_IMPLEMENTED_BRIDGE = "sqlite-control-store.py";
function commandParts(value) {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["python"];
}
function bridgeError(command, code, stderr, stdout) {
  let detail = stderr.trim();
  try {
    const parsed2 = JSON.parse(detail.split(/\r?\n/).filter(Boolean).at(-1));
    if (parsed2?.error) detail = parsed2.error;
  } catch {
  }
  const error = new Error(`SQLite control store '${command}' failed (${code}): ${detail || "no error detail"}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.exitCode = code;
  error.stderr = stderr;
  error.stdout = stdout;
  return error;
}
var PYTHON_NEWLINE = process.platform === "win32" ? "\r\n" : "\n";
function invokeInNode(sqlite, databasePath, command, payload) {
  try {
    return runControlCommand(sqlite, databasePath, command, payload);
  } catch (error) {
    const message = String(error.pythonMessage ?? error.message);
    const text3 = error.exitCode === 2 ? message : `{"ok": false, "error": ${JSON.stringify(message)}}`;
    throw bridgeError(command, error.exitCode ?? 1, `${text3.replaceAll("\n", PYTHON_NEWLINE)}${PYTHON_NEWLINE}`, "");
  }
}
var SqliteControlStore = class {
  #backend = null;
  /**
   * `sqliteBackend` ("node" | "python") overrides AGENTS_FACTORY_SQLITE and
   * the default (node:sqlite when this runtime has it, else Python).
   */
  constructor({
    databasePath,
    pythonCommand = process.env.PYTHON || "python",
    bridgePath = DEFAULT_BRIDGE,
    timeoutMs = 3e4,
    sqliteBackend
  }) {
    if (!databasePath) throw new Error("SqliteControlStore requires databasePath");
    this.databasePath = path13.resolve(databasePath);
    this.pythonCommand = commandParts(pythonCommand);
    this.bridgePath = path13.resolve(bridgePath);
    this.timeoutMs = timeoutMs;
    this.requestedSqliteBackend = path13.basename(this.bridgePath) === NODE_IMPLEMENTED_BRIDGE ? sqliteBackendOption(sqliteBackend) : "python";
  }
  /** "node" or "python": the implementation this store's calls use. */
  async sqliteBackend() {
    return (await this.#resolved()).backend;
  }
  #resolved() {
    this.#backend ??= resolveSqliteBackend({ backend: this.requestedSqliteBackend ?? void 0 });
    return this.#backend;
  }
  initialize() {
    return this.invoke("init");
  }
  enqueue(item) {
    return this.invoke("enqueue", item);
  }
  claim(options = {}) {
    return this.invoke("claim", options);
  }
  accept(options) {
    return this.invoke("accept", options);
  }
  transition(itemId, toState, { fromStates = [], leaseToken, patch = {} } = {}) {
    return this.invoke("transition", { itemId, toState, fromStates, leaseToken, patch });
  }
  heartbeat(itemId, options = {}) {
    return this.invoke("heartbeat", { itemId, ...options });
  }
  setMode(mode, reason = null) {
    return this.invoke("set-mode", { mode, reason });
  }
  upsertProgress(progress) {
    return this.invoke("upsert-progress", progress);
  }
  requestCancel(target, reason = null) {
    return this.invoke("request-cancel", { ...target, reason });
  }
  finalizeStop(reason = null) {
    return this.invoke("finalize-stop", { reason });
  }
  retry(itemId) {
    return this.invoke("retry", { itemId });
  }
  recover() {
    return this.invoke("recover");
  }
  upsertAgent(agent) {
    return this.invoke("upsert-agent", agent);
  }
  upsertAgentStatistics(agentId, statistics) {
    return this.invoke("upsert-agent-statistics", { agentId, statistics });
  }
  addEvent(type, { itemId, agentId, data = {} } = {}) {
    return this.invoke("add-event", { type, itemId, agentId, data });
  }
  snapshot(options = {}) {
    return this.invoke("snapshot", options);
  }
  compact({ retentionDays = 30, archiveRoot }) {
    return this.invoke("compact", { retentionDays, archiveRoot });
  }
  async invoke(command, payload = {}) {
    const { backend, sqlite } = await this.#resolved();
    if (backend === "node") return invokeInNode(sqlite, this.databasePath, command, payload);
    return this.#invokePython(command, payload);
  }
  #invokePython(command, payload) {
    return new Promise((resolve, reject) => {
      const [executable, ...prefixArguments] = this.pythonCommand;
      const child = spawn2(executable, [
        ...prefixArguments,
        this.bridgePath,
        "--database",
        this.databasePath,
        command
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1" }
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        const error = new Error(`SQLite control store '${command}' timed out after ${this.timeoutMs} ms`);
        error.code = "CONTROL_STORE_BRIDGE_TIMEOUT";
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();
      const append2 = (current, chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_BRIDGE_OUTPUT_BYTES) {
          child.kill();
          throw new Error(`SQLite control store '${command}' exceeded output budget`);
        }
        return current + chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk) => {
        try {
          stdout = append2(stdout, chunk);
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
          stderr = append2(stderr, chunk);
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
        error.code = error.code ?? "CONTROL_STORE_BRIDGE_START_FAILED";
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(bridgeError(command, code, stderr, stdout));
          return;
        }
        try {
          const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
          const response = JSON.parse(line);
          if (!response?.ok) throw new Error(response?.error || "SQLite bridge returned no result");
          resolve(response.result);
        } catch (error) {
          error.code = "CONTROL_STORE_BRIDGE_RESPONSE_INVALID";
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }
      });
      child.stdin.end(`${JSON.stringify(payload)}
`, "utf8");
    });
  }
};

// orchestrator/src/sqlite-bridge-server.mjs
import path14 from "node:path";
import { spawn as spawn3 } from "node:child_process";
var MAX_LINE_BYTES = 8 * 1024 * 1024;
function commandParts2(value) {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["python"];
}
function failure2(command, code, detail = "") {
  const error = new Error(`SQLite bridge '${command}' failed: ${code}${detail ? ` (${detail})` : ""}`);
  error.code = "CONTROL_STORE_BRIDGE_FAILED";
  error.stderr = `${JSON.stringify({ error: code })}
`;
  return error;
}
var PersistentSqliteBridge = class {
  #child = null;
  #pending = /* @__PURE__ */ new Map();
  #order = [];
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #closed = false;
  constructor({
    databasePath,
    bridgePath,
    pythonCommand = process.env.PYTHON || "python",
    timeoutMs = 3e4,
    unavailableCode = "bridge_unavailable"
  }) {
    if (!databasePath || !bridgePath) throw new Error("PersistentSqliteBridge requires databasePath and bridgePath");
    this.databasePath = path14.resolve(databasePath);
    this.bridgePath = path14.resolve(bridgePath);
    this.pythonCommand = commandParts2(pythonCommand);
    this.timeoutMs = timeoutMs;
    this.unavailableCode = unavailableCode;
  }
  #start() {
    const [executable, ...prefix] = this.pythonCommand;
    const child = spawn3(executable, [...prefix, this.bridgePath, "--database", this.databasePath, "--serve"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" }
    });
    this.#child = child;
    this.#buffer = "";
    this.#stderr = "";
    child.stdout.on("data", (chunk) => this.#read(child, chunk));
    child.stderr.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4096);
    });
    const gone = (reason) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#failAll(reason);
    };
    child.on("error", (error) => gone(error?.code ?? "spawn_failed"));
    child.on("close", (code) => gone(`exit ${code}`));
    child.stdin.on("error", () => {
    });
    return child;
  }
  #read(child, chunk) {
    if (this.#child !== child) return;
    this.#buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
      this.#kill("answer_too_large");
      return;
    }
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let answer;
      try {
        answer = JSON.parse(line);
      } catch {
        this.#kill("answer_invalid");
        return;
      }
      const request = this.#pending.get(answer?.id);
      if (!request) continue;
      this.#settle(answer.id);
      if (answer.ok === true) request.resolve(answer.result);
      else request.reject(failure2(request.command, typeof answer.error === "string" ? answer.error : this.unavailableCode));
    }
  }
  #settle(id5) {
    const request = this.#pending.get(id5);
    if (!request) return;
    clearTimeout(request.timer);
    this.#pending.delete(id5);
    this.#order = this.#order.filter((entry) => entry !== id5);
    this.#hold();
  }
  /** The process keeps Node alive only while a call waits for it. */
  #hold() {
    const child = this.#child;
    if (child === null) return;
    const busy = this.#pending.size > 0;
    for (const handle of [child, child.stdout, child.stderr, child.stdin]) {
      try {
        busy ? handle.ref?.() : handle.unref?.();
      } catch {
      }
    }
  }
  #failAll(reason) {
    for (const id5 of [...this.#order]) {
      const request = this.#pending.get(id5);
      this.#settle(id5);
      request?.reject(failure2(request.command, this.unavailableCode, `${reason}${this.#stderr ? `: ${this.#stderr.trim().slice(-300)}` : ""}`));
    }
  }
  #kill(reason) {
    const child = this.#child;
    this.#child = null;
    try {
      child?.kill();
    } catch {
    }
    this.#failAll(reason);
  }
  invoke(command, payload = {}) {
    if (this.#closed) return Promise.reject(failure2(command, this.unavailableCode, "closed"));
    return new Promise((resolve, reject) => {
      let child = this.#child;
      try {
        child ??= this.#start();
      } catch (error) {
        reject(failure2(command, this.unavailableCode, error?.message ?? "spawn_failed"));
        return;
      }
      const id5 = this.#nextId++;
      const timer = setTimeout(() => this.#kill(`timeout after ${this.timeoutMs} ms`), this.timeoutMs);
      timer.unref?.();
      this.#pending.set(id5, { command, resolve, reject, timer });
      this.#order.push(id5);
      this.#hold();
      child.stdin.write(`${JSON.stringify({ id: id5, command, payload })}
`, "utf8");
    });
  }
  /**
   * No new calls; the ones already sent finish (within their timeout), then
   * the process ends. A database folder can be removed after this resolves.
   */
  async close() {
    this.#closed = true;
    const waiting = [...this.#pending.values()].map((request) => new Promise((resolve) => {
      const { resolve: done, reject: failed } = request;
      request.resolve = (value) => {
        resolve();
        done(value);
      };
      request.reject = (error) => {
        resolve();
        failed(error);
      };
    }));
    await Promise.all(waiting);
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    for (const handle of [child, child.stdout, child.stderr, child.stdin]) {
      try {
        handle.ref?.();
      } catch {
      }
    }
    await new Promise((resolve) => {
      const force = setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        resolve();
      }, 3e3);
      force.unref?.();
      child.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        clearTimeout(force);
        resolve();
      }
    });
  }
};
var persistentSqliteBridgeEnabled = () => process.env.ORCHESTRATOR_SQLITE_BRIDGE !== "spawn";

// orchestrator/src/project-memory-store.mjs
var PROJECT_MEMORY_LIMITS = Object.freeze({
  entries: 64,
  contentBytes: 64 * 1024,
  listScopes: 512,
  documentBytes: 256 * 1024
});
var ID8 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
var SHA256 = /^[a-f0-9]{64}$/;
var FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
var SENSITIVE_TEXT = Object.freeze([
  /data:(?:image|audio|video)\//iu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u
]);
var BRIDGE_ERRORS = /* @__PURE__ */ new Set([
  "memory_authorization_consumed",
  "memory_authorization_mismatch",
  "memory_authorization_required",
  "memory_command_conflict",
  "memory_cross_project_change",
  "memory_identity_conflict",
  "memory_invalid_input",
  "memory_limit_exceeded",
  "memory_operation_conflict",
  "memory_project_scope_required",
  "memory_revision_conflict",
  "memory_revision_not_found",
  "memory_scope_conflict",
  "memory_scope_not_found",
  "memory_unsupported_schema"
]);
var ProjectMemoryStoreError = class extends Error {
  constructor(code) {
    super(code);
    this.name = "ProjectMemoryStoreError";
    this.code = code;
  }
};
function fail14(code = "memory_invalid_input") {
  throw new ProjectMemoryStoreError(code);
}
function exact(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail14();
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  if (required.some((field) => !Object.hasOwn(value, field)) || Object.keys(value).some((field) => !allowed.has(field))) fail14();
}
function identifier(value) {
  if (typeof value !== "string" || !ID8.test(value)) fail14();
  return value;
}
function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 56320 && next <= 57343)) return true;
      index += 1;
    } else if (unit >= 56320 && unit <= 57343) {
      return true;
    }
  }
  return false;
}
function boundedText2(value, { allowEmpty = false, maximumBytes = 65536 } = {}) {
  if (typeof value !== "string" || !allowEmpty && value.length === 0 || FORBIDDEN_CONTROL.test(value) || hasUnpairedSurrogate(value) || SENSITIVE_TEXT.some((pattern) => pattern.test(value))) fail14();
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail14("memory_limit_exceeded");
  return value;
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}
function canonicalJson2(value) {
  return JSON.stringify(canonicalValue(value));
}
function hash(value) {
  return createHash12("sha256").update(canonicalJson2(value), "utf8").digest("hex");
}
function revision(value, { allowZero = false, incrementable = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || incrementable && value >= Number.MAX_SAFE_INTEGER) fail14();
  return value;
}
function timestamp(value) {
  if (typeof value !== "string" || value.length > 32 || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) fail14("memory_unavailable");
  return value;
}
function normalizeEntries(value) {
  if (!Array.isArray(value) || value.length > PROJECT_MEMORY_LIMITS.entries) fail14();
  const ids = /* @__PURE__ */ new Set();
  const entries = value.map((entry) => {
    exact(entry, ["id", "title", "text"]);
    const normalized = {
      id: identifier(entry.id),
      title: boundedText2(entry.title, { maximumBytes: 512 }),
      text: boundedText2(entry.text, { allowEmpty: true })
    };
    if (ids.has(normalized.id)) fail14();
    ids.add(normalized.id);
    return normalized;
  });
  if (Buffer.byteLength(canonicalJson2(entries), "utf8") > PROJECT_MEMORY_LIMITS.contentBytes) {
    fail14("memory_limit_exceeded");
  }
  return entries;
}
var PROJECT_MEMORY_SCOPE_KINDS = Object.freeze(["project", "quarter", "agent"]);
function normalizeScope(value) {
  exact(value, ["scopeId", "kind", "projectId", "quarterId", "title", "operationId"]);
  if (!PROJECT_MEMORY_SCOPE_KINDS.includes(value.kind)) fail14();
  const scope = {
    scopeId: identifier(value.scopeId),
    kind: value.kind,
    projectId: identifier(value.projectId),
    quarterId: value.quarterId === null ? null : identifier(value.quarterId),
    title: boundedText2(value.title, { maximumBytes: 512 }),
    operationId: identifier(value.operationId)
  };
  if (scope.kind === "project" !== (scope.quarterId === null)) fail14();
  return scope;
}
function validateJson(value, state = { depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.depth > 24 || state.nodes > 8192) fail14("memory_limit_exceeded");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail14();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") return boundedText2(value, {
    allowEmpty: true,
    maximumBytes: PROJECT_MEMORY_LIMITS.documentBytes
  });
  if (!value || typeof value !== "object") fail14();
  const childState = { ...state, depth: state.depth + 1 };
  if (Array.isArray(value)) {
    if (value.length > 2048) fail14("memory_limit_exceeded");
    const result2 = value.map((item) => validateJson(item, childState));
    state.nodes = childState.nodes;
    return result2;
  }
  const keys = Object.keys(value);
  if (Object.getPrototypeOf(value) !== Object.prototype || keys.length > 512) fail14();
  const result = {};
  for (const key of keys) {
    if (!key || Buffer.byteLength(key, "utf8") > 256 || FORBIDDEN_CONTROL.test(key)) fail14();
    result[key] = validateJson(value[key], childState);
  }
  state.nodes = childState.nodes;
  return result;
}
function normalizeDocumentValue(value) {
  const normalized = validateJson(value);
  if (Buffer.byteLength(canonicalJson2(normalized), "utf8") > PROJECT_MEMORY_LIMITS.documentBytes) {
    fail14("memory_limit_exceeded");
  }
  return normalized;
}
function validateMetadata(value) {
  exact(value, [
    "schemaVersion",
    "scopeId",
    "kind",
    "projectId",
    "quarterId",
    "title",
    "revision",
    "sha256",
    "author",
    "updatedAtUtc"
  ]);
  if (value.schemaVersion !== 1 || !PROJECT_MEMORY_SCOPE_KINDS.includes(value.kind) || value.kind === "project" !== (value.quarterId === null)) fail14("memory_unavailable");
  identifier(value.scopeId);
  identifier(value.projectId);
  if (value.quarterId !== null) identifier(value.quarterId);
  boundedText2(value.title, { maximumBytes: 512 });
  revision(value.revision);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) fail14("memory_unavailable");
  identifier(value.author);
  timestamp(value.updatedAtUtc);
  return structuredClone(value);
}
function validateScopeDto(value) {
  exact(value, [
    "schemaVersion",
    "scopeId",
    "kind",
    "projectId",
    "quarterId",
    "title",
    "revision",
    "sha256",
    "entries",
    "author",
    "updatedAtUtc"
  ]);
  const metadata = validateMetadata(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "entries")));
  const entries = normalizeEntries(value.entries);
  if (hash(entries) !== metadata.sha256) fail14("memory_unavailable");
  return { ...metadata, entries };
}
function validateWriteReceipt(value) {
  exact(value, [
    "schemaVersion",
    "operationId",
    "commandId",
    "scopeId",
    "previousRevision",
    "revision",
    "sha256",
    "author",
    "updatedAtUtc"
  ]);
  if (value.schemaVersion !== 1) fail14("memory_unavailable");
  for (const field of ["operationId", "commandId", "scopeId", "author"]) identifier(value[field]);
  revision(value.previousRevision);
  revision(value.revision);
  if (value.revision !== value.previousRevision + 1 || !SHA256.test(value.sha256)) {
    fail14("memory_unavailable");
  }
  timestamp(value.updatedAtUtc);
  return structuredClone(value);
}
function validateGrant(value) {
  exact(value, [
    "schemaVersion",
    "commandId",
    "scopeId",
    "expectedRevision",
    "contentSha256",
    "requestedBy",
    "authorizedAtUtc"
  ]);
  if (value.schemaVersion !== 1 || !SHA256.test(value.contentSha256)) fail14("memory_unavailable");
  for (const field of ["commandId", "scopeId", "requestedBy"]) identifier(value[field]);
  revision(value.expectedRevision);
  timestamp(value.authorizedAtUtc);
  return structuredClone(value);
}
function nowUtc2(now) {
  let value;
  try {
    value = now().toISOString();
  } catch {
    fail14("memory_unavailable");
  }
  return timestamp(value);
}
function bridgeValue(validate) {
  try {
    return validate();
  } catch {
    fail14("memory_unavailable");
  }
}
var ProjectMemoryStore = class {
  constructor({ store, now = () => /* @__PURE__ */ new Date() }) {
    if (!store || typeof store.invoke !== "function" || typeof now !== "function") fail14();
    this.store = store;
    this.now = now;
  }
  async #invoke(command, payload = {}) {
    try {
      return await this.store.invoke(command, payload);
    } catch (error) {
      let code;
      try {
        code = JSON.parse(error.stderr.trim().split(/\r?\n/u).at(-1)).error;
      } catch {
      }
      fail14(BRIDGE_ERRORS.has(code) ? code : "memory_unavailable");
    }
  }
  async createScope(value) {
    const scope = normalizeScope(value);
    const requestSha256 = hash(scope);
    const result = await this.#invoke("create-scope", {
      ...scope,
      requestSha256,
      contentSha256: hash([]),
      updatedAtUtc: nowUtc2(this.now)
    });
    return bridgeValue(() => validateScopeDto(result));
  }
  async copyProject(value) {
    exact(value, [
      "sourceProjectId",
      "targetProjectId",
      "targetProjectScopeId",
      "quarterScopeIds",
      "operationId"
    ]);
    const sourceProjectId = identifier(value.sourceProjectId);
    const targetProjectId = identifier(value.targetProjectId);
    if (sourceProjectId === targetProjectId) fail14();
    if (!value.quarterScopeIds || typeof value.quarterScopeIds !== "object" || Array.isArray(value.quarterScopeIds) || Object.keys(value.quarterScopeIds).length > PROJECT_MEMORY_LIMITS.listScopes - 1) fail14();
    const quarterScopeIds = Object.fromEntries(Object.entries(value.quarterScopeIds).map(([quarterId, scopeId]) => [identifier(quarterId), identifier(scopeId)]));
    const scopeIds = [identifier(value.targetProjectScopeId), ...Object.values(quarterScopeIds)];
    if (new Set(scopeIds).size !== scopeIds.length) fail14();
    const request = {
      sourceProjectId,
      targetProjectId,
      targetProjectScopeId: scopeIds[0],
      quarterScopeIds,
      operationId: identifier(value.operationId)
    };
    const result = await this.#invoke("copy-project", {
      ...request,
      requestSha256: hash(request),
      copiedAtUtc: nowUtc2(this.now)
    });
    return bridgeValue(() => {
      exact(result, [
        "schemaVersion",
        "outcome",
        "sourceProjectId",
        "targetProjectId",
        "operationId",
        "scopes",
        "copiedAtUtc"
      ]);
      if (result.schemaVersion !== 1 || result.outcome !== "complete" || result.sourceProjectId !== sourceProjectId || result.targetProjectId !== targetProjectId || result.operationId !== request.operationId || !Array.isArray(result.scopes) || result.scopes.length !== scopeIds.length) fail14("memory_unavailable");
      for (const scope of result.scopes) {
        exact(scope, [
          "sourceScopeId",
          "targetScopeId",
          "kind",
          "quarterId",
          "sourceRevision",
          "sourceSha256",
          "targetRevision",
          "targetSha256"
        ]);
        identifier(scope.sourceScopeId);
        if (!scopeIds.includes(identifier(scope.targetScopeId)) || !["project", "quarter"].includes(scope.kind) || scope.quarterId !== null && !Object.hasOwn(quarterScopeIds, identifier(scope.quarterId)) || !Number.isInteger(scope.sourceRevision) || scope.sourceRevision < 1 || scope.targetRevision !== 1 || !SHA256.test(scope.sourceSha256) || scope.sourceSha256 !== scope.targetSha256) fail14("memory_unavailable");
      }
      return result;
    });
  }
  async readScope(value) {
    exact(value, ["scopeId"], ["revision"]);
    const requestedRevision = Object.hasOwn(value, "revision") ? revision(value.revision) : null;
    const result = await this.#invoke("read-scope", {
      scopeId: identifier(value.scopeId),
      revision: requestedRevision
    });
    return bridgeValue(() => validateScopeDto(result));
  }
  /**
   * Ends the store's bridge process after the calls already sent
   * (sqlite-bridge-server.mjs); with node:sqlite, only later calls fail.
   */
  async close() {
    if (typeof this.store.close === "function") await this.store.close();
  }
  async listScopes(value = {}) {
    exact(value, [], ["projectId"]);
    const result = await this.#invoke("list-scopes", {
      projectId: Object.hasOwn(value, "projectId") ? identifier(value.projectId) : null,
      limit: PROJECT_MEMORY_LIMITS.listScopes
    });
    try {
      exact(result, ["schemaVersion", "scopes", "truncated"]);
      if (result.schemaVersion !== 1 || !Array.isArray(result.scopes) || result.scopes.length > PROJECT_MEMORY_LIMITS.listScopes || typeof result.truncated !== "boolean") fail14("memory_unavailable");
      return {
        schemaVersion: 1,
        scopes: result.scopes.map(validateMetadata),
        truncated: result.truncated
      };
    } catch (error) {
      if (error instanceof ProjectMemoryStoreError && error.code === "memory_unavailable") throw error;
      fail14("memory_unavailable");
    }
  }
  async authorizeWrite(value) {
    exact(value, ["commandId", "scopeId", "expectedRevision", "entries", "requestedBy"]);
    const grant = {
      commandId: identifier(value.commandId),
      scopeId: identifier(value.scopeId),
      expectedRevision: revision(value.expectedRevision, { incrementable: true }),
      contentSha256: hash(normalizeEntries(value.entries)),
      requestedBy: identifier(value.requestedBy)
    };
    const result = await this.#invoke("authorize-write", {
      ...grant,
      requestSha256: hash(grant),
      authorizedAtUtc: nowUtc2(this.now)
    });
    return bridgeValue(() => validateGrant(result));
  }
  async write(value) {
    exact(value, [
      "scopeId",
      "expectedRevision",
      "entries",
      "operationId",
      "commandId",
      "actorId"
    ]);
    const request = {
      scopeId: identifier(value.scopeId),
      expectedRevision: revision(value.expectedRevision, { incrementable: true }),
      entries: normalizeEntries(value.entries),
      operationId: identifier(value.operationId),
      commandId: identifier(value.commandId),
      actorId: identifier(value.actorId)
    };
    const result = await this.#invoke("write", {
      ...request,
      contentSha256: hash(request.entries),
      requestSha256: hash(request),
      updatedAtUtc: nowUtc2(this.now)
    });
    return bridgeValue(() => validateWriteReceipt(result));
  }
  /** Current versions of the named scopes that exist, in one store call. */
  async readScopes(value) {
    exact(value, ["scopeIds"]);
    if (!Array.isArray(value.scopeIds) || value.scopeIds.length > 128) fail14();
    const scopeIds = [...new Set(value.scopeIds.map(identifier))];
    if (scopeIds.length === 0) return [];
    const result = await this.#invoke("read-scope-set", { scopeIds });
    return bridgeValue(() => {
      exact(result, ["schemaVersion", "scopes"]);
      if (result.schemaVersion !== 1 || !Array.isArray(result.scopes)) fail14("memory_unavailable");
      const scopes = result.scopes.map(validateScopeDto);
      if (scopes.some((scope) => !scopeIds.includes(scope.scopeId))) fail14("memory_unavailable");
      return scopes;
    });
  }
  async readPair(value) {
    exact(value, ["projectId", "quarterId"]);
    const result = await this.#invoke("read-pair", {
      projectId: identifier(value.projectId),
      quarterId: identifier(value.quarterId)
    });
    try {
      exact(result, ["project", "quarter"]);
      const pair = {
        project: validateScopeDto(result.project),
        quarter: validateScopeDto(result.quarter)
      };
      if (pair.project.kind !== "project" || pair.quarter.kind !== "quarter" || pair.project.projectId !== value.projectId || pair.quarter.projectId !== value.projectId || pair.quarter.quarterId !== value.quarterId) fail14("memory_unavailable");
      return pair;
    } catch (error) {
      if (error instanceof ProjectMemoryStoreError && error.code === "memory_unavailable") throw error;
      fail14("memory_unavailable");
    }
  }
  async readDocument(value) {
    exact(value, ["key"]);
    const result = await this.#invoke("read-document", { key: identifier(value.key) });
    if (result === null) return null;
    try {
      exact(result, ["revision", "value"]);
      const normalized = normalizeDocumentValue(result.value);
      return { revision: revision(result.revision), value: normalized };
    } catch {
      fail14("memory_unavailable");
    }
  }
  async compareAndSwapDocument(value) {
    exact(value, ["key", "expectedRevision", "value"]);
    const result = await this.#invoke("compare-and-swap-document", {
      key: identifier(value.key),
      expectedRevision: revision(value.expectedRevision, { allowZero: true, incrementable: true }),
      value: normalizeDocumentValue(value.value)
    });
    if (typeof result !== "boolean") fail14("memory_unavailable");
    return result;
  }
  transactionDocument(value) {
    return this.compareAndSwapDocument(value);
  }
  async initialize() {
    const result = await this.#invoke("init");
    if (result?.schemaVersion !== 1 || result?.ready !== true || Object.keys(result).length !== 2) fail14("memory_unavailable");
  }
};
async function checkedBridgePath(value) {
  if (typeof value !== "string" || !value) fail14();
  const resolved = path15.resolve(value);
  const info = await lstat8(resolved).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink()) fail14("memory_identity_conflict");
  const canonical3 = await realpath5(resolved);
  if (path15.relative(resolved, canonical3) !== "") fail14("memory_identity_conflict");
  return canonical3;
}
async function openSplitMemoryBridge(controllerRoot, sqliteBackend) {
  if (typeof controllerRoot !== "string" || !controllerRoot) fail14();
  let layout;
  try {
    layout = await resolveStoreLayout(controllerRoot);
  } catch {
    fail14("memory_identity_conflict");
  }
  if (layout.layout !== "split") return null;
  const { backend, sqlite } = await resolveSqliteBackend({ backend: sqliteBackend });
  if (backend !== "node") fail14("memory_sqlite_required");
  return new SplitProjectMemoryBridge({ controllerRoot: layout.root, sqlite });
}
async function checkedDatabaseDirectory(controllerRoot) {
  if (typeof controllerRoot !== "string" || !controllerRoot) fail14();
  let root;
  try {
    root = await realpath5(controllerRoot);
  } catch {
    fail14("memory_identity_conflict");
  }
  let directory = root;
  for (const segment of [".project-local", "orchestration", "project-memory"]) {
    const candidate = path15.join(directory, segment);
    const existing = await lstat8(candidate).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing === null) await mkdir8(candidate);
    else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      fail14("memory_identity_conflict");
    }
    const canonical3 = await realpath5(candidate);
    const relative = path15.relative(root, canonical3);
    if (path15.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path15.sep}`)) {
      fail14("memory_identity_conflict");
    }
    directory = canonical3;
  }
  return directory;
}
async function rejectLinkedDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const info = await lstat8(`${databasePath}${suffix}`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (info !== null && (!info.isFile() || info.isSymbolicLink())) {
      fail14("memory_identity_conflict");
    }
  }
}
async function createProjectMemoryStore({
  controllerRoot,
  now = () => /* @__PURE__ */ new Date(),
  pythonCommand,
  bridgePath = fileURLToPath2(new URL("project-memory-store.py", import.meta.url)),
  sqliteBackend
}) {
  if (typeof now !== "function") fail14();
  try {
    sqliteBackendOption(sqliteBackend);
  } catch {
    fail14();
  }
  const split = await openSplitMemoryBridge(controllerRoot, sqliteBackend);
  if (split !== null) {
    const memory2 = new ProjectMemoryStore({ now, store: split });
    Object.defineProperty(memory2, "sqliteBackend", { value: "node" });
    await memory2.initialize();
    return memory2;
  }
  const directory = await checkedDatabaseDirectory(controllerRoot);
  const databasePath = path15.join(directory, "project-memory.v1.sqlite");
  await rejectLinkedDatabase(databasePath);
  const { backend, sqlite } = await resolveSqliteBackend({ backend: sqliteBackend });
  let store;
  if (backend === "node") {
    store = new NodeProjectMemoryBridge({ databasePath, sqlite });
  } else {
    const canonicalBridge = await checkedBridgePath(bridgePath);
    store = persistentSqliteBridgeEnabled() ? new PersistentSqliteBridge({
      databasePath,
      pythonCommand,
      bridgePath: canonicalBridge,
      unavailableCode: "memory_unavailable"
    }) : new SqliteControlStore({ databasePath, pythonCommand, bridgePath: canonicalBridge });
  }
  const memory = new ProjectMemoryStore({ now, store });
  Object.defineProperty(memory, "sqliteBackend", { value: backend });
  await memory.initialize();
  return memory;
}

// orchestrator/src/project-rebind.mjs
import { randomUUID as randomUUID8 } from "node:crypto";
import { lstat as lstat9, mkdir as mkdir9, readdir as readdir6, readFile as readFile9, realpath as realpath7, rename as rename9, writeFile as writeFile7 } from "node:fs/promises";
import path17 from "node:path";

// orchestrator/src/project-workspace-binding.mjs
import path16 from "node:path";
import { stat, realpath as realpath6 } from "node:fs/promises";
import { createHash as createHash13 } from "node:crypto";
function fail15(code) {
  throw Object.assign(new Error(code), { code });
}
function workspaceDocumentKey(projectId) {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(projectId)) {
    fail15("memory_invalid_input");
  }
  return `workspace-${createHash13("sha256").update(projectId).digest("hex")}`;
}
async function workspaceIdentity(workspacePath) {
  if (typeof workspacePath !== "string" || !path16.isAbsolute(workspacePath)) fail15("memory_invalid_input");
  const root = await realpath6(workspacePath);
  if (!(await stat(root)).isDirectory()) fail15("memory_invalid_input");
  const identity = process.platform === "win32" ? root.toLowerCase() : root;
  return { workspacePath: root, workspaceKey: createHash13("sha256").update(identity).digest("hex") };
}
async function bindProjectWorkspace(store, input) {
  if (!input || Object.keys(input).sort().join() !== "projectId,workspacePath") fail15("memory_invalid_input");
  const documentKey = workspaceDocumentKey(input.projectId);
  const value = { projectId: input.projectId, ...await workspaceIdentity(input.workspacePath) };
  const existing = await store.readDocument({ key: documentKey });
  if (existing) {
    if (existing.value.workspaceKey !== value.workspaceKey) fail15("memory_workspace_conflict");
  } else if (!await store.compareAndSwapDocument({ key: documentKey, expectedRevision: 0, value })) {
    return bindProjectWorkspace(store, input);
  }
  return { projectId: input.projectId, workspaceKey: value.workspaceKey, configured: true };
}
var AGENTS_KEY = "memory-agents-v1";
async function rebindProjectWorkspace(store, input) {
  if (!input || Object.keys(input).sort().join() !== "projectId,workspacePath") fail15("memory_invalid_input");
  const documentKey = workspaceDocumentKey(input.projectId);
  const value = { projectId: input.projectId, ...await workspaceIdentity(input.workspacePath) };
  const existing = await store.readDocument({ key: documentKey });
  if (!existing) return bindProjectWorkspace(store, input);
  if (existing.value.workspaceKey === value.workspaceKey) {
    return { projectId: input.projectId, workspaceKey: value.workspaceKey, configured: true, changed: false };
  }
  const agents = ((await store.readDocument({ key: AGENTS_KEY }))?.value?.agents ?? []).filter((agent) => agent.projectId === input.projectId);
  const worked = (agent) => Array.isArray(agent.operations) && agent.operations.length > 0;
  if (agents.some((agent) => agent.state !== "archived" || worked(agent))) fail15("memory_workspace_in_use");
  if (!await store.compareAndSwapDocument({ key: documentKey, expectedRevision: existing.revision, value })) {
    fail15("memory_contention");
  }
  return { projectId: input.projectId, workspaceKey: value.workspaceKey, configured: true, changed: true };
}
async function readProjectWorkspace(store, input) {
  if (!input || Object.keys(input).join() !== "projectId") fail15("memory_invalid_input");
  const record = await store.readDocument({ key: workspaceDocumentKey(input.projectId) });
  if (!record) return { projectId: input.projectId, configured: false };
  let available = true;
  try {
    available = (await workspaceIdentity(record.value.workspacePath)).workspaceKey === record.value.workspaceKey;
  } catch {
    available = false;
  }
  return { projectId: input.projectId, configured: true, workspacePath: record.value.workspacePath, available };
}

// orchestrator/src/project-rebind.mjs
var RECEIPTS = path17.join(".project-local", "rebind-receipts");
function fail16(code, detail) {
  throw new ProjectPackageError(code, detail);
}
async function exists4(target) {
  return lstat9(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
function claudeProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/gu, "-");
}
function dshSessionSlug(cwd) {
  if (!/^[A-Za-z0-9_.:\\/-]+$/u.test(cwd)) return null;
  return `--${cwd.replace(/:/gu, "").replace(/[\\/]/gu, "-")}--`;
}
async function writeJsonOver(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID8()}.tmp`;
  await writeFile7(temporary, `${JSON.stringify(value)}
`, "utf8");
  await rename9(temporary, target);
}
async function rebindWorkedProject({
  controllerRoot,
  store,
  projectId,
  workspacePath,
  confirm,
  now = () => /* @__PURE__ */ new Date(),
  claudeConfigDir,
  dshHome
}) {
  if (confirm !== projectId) fail16("rebind_confirmation_required", projectId);
  const root = await realpath7(controllerRoot);
  const current = await readProjectWorkspace(store, { projectId });
  if (!current.configured) return rebindProjectWorkspace(store, { projectId, workspacePath });
  const target = await realpath7(workspacePath).catch(() => fail16("rebind_folder_missing", workspacePath));
  if (current.workspacePath.toLowerCase() === target.toLowerCase()) {
    return rebindProjectWorkspace(store, { projectId, workspacePath: target });
  }
  const catalog = await store.readDocument({ key: "memory-agents-v1" });
  const agents = (catalog?.value?.agents ?? []).filter((agent) => agent.projectId === projectId);
  const worked = agents.some((agent) => agent.state !== "archived" || (agent.operations ?? []).length > 0);
  if (!worked) return rebindProjectWorkspace(store, { projectId, workspacePath: target });
  if (agents.some((agent) => agent.currentOperationId)) fail16("rebind_project_busy", projectId);
  const paths = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  if (await gatewayRunning(paths.gatewayStatus)) fail16("gateway_running");
  const moves = [];
  const journals = [];
  const caches = [];
  for (const agent of agents) {
    const threadId = agent.binding?.threadId;
    if (typeof threadId !== "string") continue;
    for (const folder of [paths.claudeSessions, paths.acpSessions]) {
      const journal = path17.join(folder, threadId, "session.json");
      if (!await exists4(journal)) continue;
      const session = JSON.parse(await readFile9(journal, "utf8"));
      if (typeof session.cwd !== "string" || session.cwd.toLowerCase() !== current.workspacePath.toLowerCase()) {
        fail16("rebind_session_elsewhere", `${threadId}: ${session.cwd}`);
      }
      journals.push({ journal, session, threadId });
      const oldCwd = session.cwd;
      const claudeProjects = path17.join(paths.claudeConfigDir, "projects");
      for (const name of [`${threadId}.jsonl`, threadId]) {
        for (const slug of await readdir6(claudeProjects).catch(() => [])) {
          const from = path17.join(claudeProjects, slug, name);
          if (!await exists4(from)) continue;
          if (slug !== claudeProjectSlug(oldCwd)) fail16("rebind_provider_folder_unknown", from);
          const to = path17.join(claudeProjects, claudeProjectSlug(target), name);
          if (await exists4(to)) fail16("rebind_target_exists", to);
          moves.push({ from, to });
        }
      }
      const dshSessions = path17.join(paths.dshHome, "sessions");
      for (const slug of await readdir6(dshSessions).catch(() => [])) {
        const from = path17.join(dshSessions, slug, threadId);
        if (!await exists4(from)) continue;
        const newSlug = dshSessionSlug(target);
        if (slug !== dshSessionSlug(oldCwd) || newSlug === null) fail16("rebind_provider_folder_unknown", from);
        const to = path17.join(dshSessions, newSlug, threadId);
        if (await exists4(to)) fail16("rebind_target_exists", to);
        moves.push({ from, to });
      }
      const cache = path17.join(paths.dshHome, "storages", "session_projcache", "sessions", `${threadId}.json`);
      if (await exists4(cache)) caches.push(cache);
    }
  }
  const done = [];
  try {
    for (const move of moves) {
      await mkdir9(path17.dirname(move.to), { recursive: true });
      await rename9(move.from, move.to);
      done.push(move);
    }
    for (const { journal, session } of journals) await writeJsonOver(journal, { ...session, cwd: target });
    for (const cache of caches) {
      const value = JSON.parse(await readFile9(cache, "utf8"));
      if (value?.identity && typeof value.identity.cwd === "string") {
        await writeJsonOver(cache, { ...value, identity: { ...value.identity, cwd: target } });
      }
    }
    const identity = await workspaceIdentity(target);
    const keyed = { ...catalog.value, agents: catalog.value.agents.map((agent) => agent.projectId === projectId ? { ...agent, workspaceKey: identity.workspaceKey } : agent) };
    if (!await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: catalog.revision, value: keyed })) {
      fail16("rebind_contention");
    }
    const bindingKey = workspaceDocumentKey(projectId);
    const binding = await store.readDocument({ key: bindingKey });
    if (!await store.compareAndSwapDocument({
      key: bindingKey,
      expectedRevision: binding?.revision ?? 0,
      value: { projectId, ...identity }
    })) {
      const back = await store.readDocument({ key: "memory-agents-v1" });
      await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: back.revision, value: catalog.value });
      fail16("rebind_contention");
    }
  } catch (error) {
    for (const move of done.reverse()) await rename9(move.to, move.from).catch(() => {
    });
    for (const { journal, session } of journals) await writeJsonOver(journal, session).catch(() => {
    });
    throw error;
  }
  const receipt = {
    schemaVersion: 1,
    projectId,
    from: current.workspacePath,
    to: target,
    agents: agents.map((agent) => agent.agentId),
    sessions: journals.map((item) => item.threadId),
    moved: moves.map((move) => ({ from: path17.relative(root, move.from), to: path17.relative(root, move.to) })),
    rebasedAtUtc: now().toISOString()
  };
  const file = path17.join(root, RECEIPTS, `${receipt.rebasedAtUtc.replace(/[-:.]/gu, "")}-${projectId.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`);
  await mkdir9(path17.dirname(file), { recursive: true });
  await writeFile7(file, `${JSON.stringify(receipt, null, 2)}
`, "utf8");
  return { ...receipt, configured: true, changed: true, receipt: file };
}

// orchestrator/src/instance-relocate.mjs
var CONFIGS = [
  [".project-local", "application-gateway", "claude-provider.json"],
  [".project-local", "application-gateway", "acp-provider.json"],
  [".project-local", "orchestration", "control-cycle.json"],
  [".project-local", "source-bindings.json"]
];
var SKIP_SCAN = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "backups",
  "projects",
  "claude-account",
  "dsh-home",
  "claude-sessions",
  "acp-sessions",
  "conversation-archive",
  "project-memory",
  "relocate-receipts",
  "move-receipts",
  "rebind-receipts"
]);
function fail17(code, detail) {
  throw new ProjectPackageError(code, detail);
}
async function exists5(target) {
  return lstat10(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
function instancePathHash(root) {
  const resolved = path18.resolve(root);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash14("sha256").update(JSON.stringify({ workspaceRoot: normalized })).digest("hex");
}
function moved(value, from, to) {
  if (typeof value !== "string" || !path18.isAbsolute(value)) return null;
  const relative = path18.relative(from, value);
  if (relative.startsWith("..") || path18.isAbsolute(relative)) return null;
  return relative === "" ? to : path18.join(to, relative);
}
function rewrite(value, from, to, counter) {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, from, to, counter));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, from, to, counter)]));
  }
  const next = moved(value, from, to);
  if (next === null) return value;
  counter.count += 1;
  return next;
}
async function writeJsonOver2(target, value, spaces) {
  const temporary = `${target}.${process.pid}.${randomUUID9()}.tmp`;
  await writeFile8(temporary, `${JSON.stringify(value, null, spaces)}
`, "utf8");
  await rename10(temporary, target);
}
async function filesNaming(root, from) {
  const needles = [from, from.replace(/\\/gu, "/"), from.replace(/\\/gu, "\\\\")].map((item) => item.toLowerCase());
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir7(current, { withFileTypes: true }).catch(() => [])) {
      if (SKIP_SCAN.has(entry.name)) continue;
      const full = path18.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const info = await lstat10(full);
        if (info.size > 2 * 1024 * 1024) continue;
        const text3 = (await readFile10(full, "utf8")).toLowerCase();
        if (needles.some((needle) => text3.includes(needle))) found.push(path18.relative(root, full));
      }
    }
  };
  await walk(root);
  return found.sort();
}
async function relocateAtlas(atlasConfig, from, to) {
  const config = JSON.parse(await readFile10(atlasConfig, "utf8"));
  const oldHash = instancePathHash(from);
  const newHash = instancePathHash(to);
  if (typeof config.controllerRoot === "string" && path18.resolve(config.controllerRoot).toLowerCase() !== path18.resolve(from).toLowerCase()) {
    fail17("relocate_atlas_other_instance", config.controllerRoot);
  }
  const next = {
    ...config,
    controllerRoot: to,
    expectedWorkspace: { ...config.expectedWorkspace ?? {}, workspaceRootSha256: newHash }
  };
  await writeJsonOver2(atlasConfig, next, 2);
  const userData = path18.join(path18.dirname(path18.dirname(atlasConfig)), "user-data");
  const result = { config: atlasConfig, layout: "none", view: "none", seenTurns: "none" };
  for (const [key, suffix] of [["layout", ".json"], ["view", ".view.json"]]) {
    const [oldFile, newFile] = [`live-${oldHash.slice(0, 16)}${suffix}`, `live-${newHash.slice(0, 16)}${suffix}`].map((name) => path18.join(userData, "layouts", name));
    if (!await exists5(oldFile)) continue;
    if (await exists5(newFile)) result[key] = "kept-existing";
    else {
      await copyFile2(oldFile, newFile);
      result[key] = "copied";
    }
  }
  const seen = path18.join(userData, "seen-turns.json");
  if (await exists5(seen)) {
    const value = JSON.parse(await readFile10(seen, "utf8"));
    const [oldKey, newKey] = [`live-${oldHash.slice(0, 16)}`, `live-${newHash.slice(0, 16)}`];
    let changed = false;
    for (const section of ["environments", "answers"]) {
      if (value?.[section]?.[oldKey] && !value[section][newKey]) {
        value[section][newKey] = value[section][oldKey];
        changed = true;
      }
    }
    if (changed) {
      await writeJsonOver2(seen, value, 0);
      result.seenTurns = "copied";
    }
  }
  return result;
}
async function relocateInstance({ controllerRoot, from, confirm, atlasConfig = null, now = () => /* @__PURE__ */ new Date() }) {
  if (typeof from !== "string" || !path18.isAbsolute(from)) fail17("relocate_from_invalid");
  if (confirm !== from) fail17("relocate_confirmation_required", from);
  const root = await realpath8(controllerRoot);
  const old = path18.resolve(from);
  if (old.toLowerCase() === root.toLowerCase()) fail17("relocate_same_path");
  if (await gatewayRunning(path18.join(root, ".project-local", "application-gateway", "status.v1.json"))) fail17("gateway_running");
  const configs = [];
  for (const parts of CONFIGS) {
    const file2 = path18.join(root, ...parts);
    if (!await exists5(file2)) continue;
    const text3 = await readFile10(file2, "utf8");
    const counter = { count: 0 };
    const value = rewrite(JSON.parse(text3), old, root, counter);
    if (counter.count > 0) {
      await writeJsonOver2(file2, value, text3.includes("\n  ") ? 2 : 0);
      configs.push({ file: parts.join("/"), paths: counter.count });
    }
  }
  const rebound = [];
  const store = await createProjectMemoryStore({ controllerRoot: root });
  try {
    const projects = /* @__PURE__ */ new Set(["world", ...(await store.listScopes()).scopes.map((scope) => scope.projectId)]);
    for (const projectId of [...projects].sort()) {
      const binding = await readProjectWorkspace(store, { projectId });
      if (!binding.configured) continue;
      const target = moved(binding.workspacePath, old, root);
      if (target === null) continue;
      if (!await exists5(target)) {
        rebound.push({ projectId, from: binding.workspacePath, to: target, state: "folder-missing" });
        continue;
      }
      const receipt2 = await rebindWorkedProject({ controllerRoot: root, store, projectId, workspacePath: target, confirm: projectId, now });
      rebound.push({ projectId, from: binding.workspacePath, to: target, state: "rebound", sessions: receipt2.sessions ?? [] });
    }
  } finally {
    await store.close();
  }
  const atlas = atlasConfig ? await relocateAtlas(path18.resolve(atlasConfig), old, root) : null;
  const receipt = {
    schemaVersion: 1,
    from: old,
    to: root,
    configs,
    rebound,
    atlas,
    stillNamingOldPath: await filesNaming(root, old),
    relocatedAtUtc: now().toISOString()
  };
  const file = path18.join(root, ".project-local", "relocate-receipts", `${receipt.relocatedAtUtc.replace(/[-:.]/gu, "")}.json`);
  await mkdir10(path18.dirname(file), { recursive: true });
  await writeFile8(file, `${JSON.stringify(receipt, null, 2)}
`, "utf8");
  return { ...receipt, receipt: file, gatewayHash: instancePathHash(root) };
}

// orchestrator/src/instance-move.mjs
var GATEWAY = [".project-local", "application-gateway"];
var DEAD_GATEWAY_RECORDS = ["status.v1.json", "monitor-owner.v1.json", "monitor-status.v1.json"];
var DESCRIPTOR = "connection.v1.json";
var MOVED_FILE = path19.join(".project-local", "moved-to.json");
function fail18(code, detail) {
  throw new ProjectPackageError(code, detail);
}
async function exists6(target) {
  return lstat11(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
var stamp = (now) => now().toISOString().replace(/[-:.]/gu, "");
var inside = (parent, child) => {
  const relative = path19.relative(parent, child);
  return relative === "" || !relative.startsWith("..") && !path19.isAbsolute(relative);
};
async function movedTo(controllerRoot) {
  try {
    const value = JSON.parse(await readFile11(path19.join(controllerRoot, MOVED_FILE), "utf8"));
    return typeof value?.to === "string" ? value.to : null;
  } catch {
    return null;
  }
}
async function assertNotMovedAway(controllerRoot) {
  const to = await movedTo(controllerRoot);
  if (to !== null) fail18("instance_moved_away", to);
}
async function copyTree(from, to, root, target, counts) {
  await mkdir11(to, { recursive: true });
  for (const entry of await readdir8(from, { withFileTypes: true })) {
    const source = path19.join(from, entry.name);
    const destination = path19.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(source);
      const absolute = path19.isAbsolute(link) ? link : null;
      const pointed = absolute !== null && inside(root, absolute) ? path19.join(target, path19.relative(root, absolute)) : link;
      const kind2 = await stat2(source).then((info) => info.isDirectory() ? "dir" : "file", () => "dir");
      try {
        await symlink(pointed, destination, process.platform === "win32" ? kind2 === "dir" ? "junction" : "file" : void 0);
      } catch (error) {
        fail18("move_link_not_copied", `${path19.relative(root, source)}: ${error.code ?? "failed"}`);
      }
      counts.links += 1;
    } else if (entry.isDirectory()) {
      await copyTree(source, destination, root, target, counts);
      counts.folders += 1;
    } else if (entry.isFile()) {
      await copyFile3(source, destination);
      counts.files += 1;
      counts.bytes += (await lstat11(source)).size;
    }
  }
}
async function setAsideDeadGateway(root, backup) {
  const folder = path19.join(root, ...GATEWAY);
  const status = path19.join(folder, "status.v1.json");
  const moved2 = [];
  const put = async (name) => {
    const file = path19.join(folder, name);
    if (!await exists6(file)) return;
    await mkdir11(backup, { recursive: true });
    await rename11(file, path19.join(backup, name));
    moved2.push(name);
  };
  let terminal = true;
  try {
    terminal = JSON.parse(await readFile11(status, "utf8"))?.terminal === true;
  } catch {
    terminal = true;
  }
  if (!terminal) for (const name of DEAD_GATEWAY_RECORDS) await put(name);
  await put(DESCRIPTOR);
  return moved2;
}
async function claudeSignIn(root) {
  let configDir = path19.join(root, ".project-local", "claude-account");
  try {
    const provider = JSON.parse(await readFile11(path19.join(root, ...GATEWAY, "claude-provider.json"), "utf8"));
    if (typeof provider?.claudeConfigDir === "string") configDir = provider.claudeConfigDir;
  } catch {
  }
  return { claudeConfigDir: configDir, credentialsFile: await exists6(path19.join(configDir, ".credentials.json")) };
}
async function moveInstance({
  controllerRoot,
  to,
  confirm,
  atlasConfig = null,
  machine = null,
  now = () => /* @__PURE__ */ new Date()
}) {
  if (typeof to !== "string" || !path19.isAbsolute(to)) fail18("move_target_invalid");
  if (confirm !== to) fail18("move_confirmation_required", to);
  const root = await realpath9(controllerRoot);
  const target = path19.resolve(to);
  if (inside(root, target) || inside(target, root)) fail18("move_target_overlaps", target);
  if (await exists6(target)) {
    if (!(await lstat11(target)).isDirectory() || (await readdir8(target)).length > 0) fail18("move_target_not_empty", target);
  }
  if (await movedTo(root) !== null) fail18("instance_moved_away", await movedTo(root));
  if (await gatewayRunning(path19.join(root, ...GATEWAY, "status.v1.json"))) fail18("gateway_running");
  if (machine !== null && typeof machine.machineId !== "string") fail18("machine_id_invalid");
  const startedAtUtc = now().toISOString();
  const counts = { files: 0, folders: 0, links: 0, bytes: 0 };
  await copyTree(root, target, root, target, counts);
  const copy = await realpath9(target);
  let step = "gateway-records";
  let setAside;
  let relocated;
  let migrated = null;
  let atlas = null;
  try {
    setAside = await setAsideDeadGateway(copy, path19.join(copy, ".project-local", "backups", `move-${stamp(now)}`));
    step = "machine";
    if (machine !== null) await setThisMachine(copy, machine);
    step = "paths";
    relocated = await relocateInstance({ controllerRoot: copy, from: root, confirm: root, now });
    step = "split-layout";
    if ((await resolveStoreLayout(copy, { env: {} })).layout !== "split") {
      migrated = { projects: ((await migrateToSplitLayout({ controllerRoot: copy, now })).projects ?? []).map((item) => item?.projectId ?? item) };
    }
    step = "atlas";
    if (atlasConfig !== null) atlas = await relocateAtlas(path19.resolve(atlasConfig), root, copy);
  } catch (error) {
    fail18("move_incomplete", `${step}: ${error?.message || error?.code || "failed"} — the copy in ${copy} is not complete (delete it); ${root} is unchanged`);
  }
  await writeFile9(path19.join(root, MOVED_FILE), `${JSON.stringify({ schemaVersion: 1, to: copy, movedAtUtc: now().toISOString() }, null, 2)}
`, "utf8");
  const receipt = {
    schemaVersion: 1,
    from: root,
    to: copy,
    startedAtUtc,
    copied: counts,
    gatewayRecordsSetAside: setAside,
    machine: (await readThisMachine(copy))?.machineId ?? null,
    migratedToSplit: migrated,
    configs: relocated.configs,
    rebound: relocated.rebound,
    atlas,
    stillNamingOldPath: relocated.stillNamingOldPath,
    signIn: await claudeSignIn(copy),
    sourceMarked: MOVED_FILE.replace(/\\/gu, "/"),
    movedAtUtc: now().toISOString()
  };
  const file = path19.join(copy, ".project-local", "move-receipts", `${stamp(now)}.json`);
  await mkdir11(path19.dirname(file), { recursive: true });
  await writeFile9(file, `${JSON.stringify(receipt, null, 2)}
`, "utf8");
  return { ...receipt, receipt: file, gatewayHash: relocated.gatewayHash };
}

// orchestrator/src/sync-engine.mjs
import { createHash as createHash18, randomUUID as randomUUID11 } from "node:crypto";
import { lstat as lstat17, mkdir as mkdir15, readFile as readFile18, realpath as realpath11, rename as rename14, rm as rm10, writeFile as writeFile12 } from "node:fs/promises";
import path27 from "node:path";

// orchestrator/src/project-mount.mjs
import { readdir as readdir10, readFile as readFile17, realpath as realpath10, rm as rm9, rmdir } from "node:fs/promises";
import path26 from "node:path";

// orchestrator/src/world-task-board.mjs
import { createHash as createHash17 } from "node:crypto";
import { lstat as lstat16, readdir as readdir9, readFile as readFile16 } from "node:fs/promises";
import path25 from "node:path";

// orchestrator/src/desk-agent-sources.mjs
import { createHash as createHash16, randomUUID as randomUUID10 } from "node:crypto";
import { lstat as lstat15, mkdir as mkdir14, readFile as readFile15, rename as rename13, rm as rm8, writeFile as writeFile11 } from "node:fs/promises";
import path23 from "node:path";

// orchestrator/src/desk-agent-source-validation.mjs
import { lstat as lstat12, readFile as readFile12 } from "node:fs/promises";
import path20 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var DESK_AGENT_ROUTE = "claude-desk-agent";
var DESK_AGENT_PROFILE = "claude-desk";
function check(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
}
async function readJson3(file) {
  for (let cursor = file; cursor !== path20.dirname(cursor); cursor = path20.dirname(cursor)) {
    const info2 = await lstat12(cursor).catch(() => null);
    check(info2 !== null, "desk_source_missing_file");
    check(!info2.isSymbolicLink(), "desk_source_linked_path");
  }
  const info = await lstat12(file);
  check(info.isFile() && info.size <= 1024 * 1024, "desk_source_invalid_file");
  return JSON.parse(await readFile12(file, "utf8"));
}
async function validateDeskAgentSource(source, workspacePath) {
  check(
    source.providerRoute === DESK_AGENT_ROUTE && source.executionAdapter === DESK_AGENT_ROUTE && source.coordinationProfile === DESK_AGENT_PROFILE && source.executorState === "installed",
    "desk_source_route_mismatch"
  );
  check(typeof source.deskAgentId === "string" && source.deskAgentId.length > 0, "desk_source_agent_missing");
  check(
    !source.workspaceLauncher && (source.workspaceRelativeSourceRoot ?? ".") === "." && source.taskInbox === ".orchestrator/tasks/inbox" && source.reportOutbox === ".orchestrator/reports/outbox",
    "desk_source_paths_mismatch"
  );
  const contract = await readJson3(path20.join(workspacePath, ".orchestrator", "contract.json"));
  check(contract.sourceId === source.id && contract.kitProfile === DESK_AGENT_PROFILE && contract.executorState === "installed", "desk_source_contract_mismatch");
  const record = await readJson3(path20.join(workspacePath, ".orchestrator", "desk-agent.json"));
  check(
    record.schemaVersion === 1 && record.sourceId === source.id && record.agentId === source.deskAgentId,
    "desk_source_record_mismatch"
  );
  return { status: "valid", routeId: DESK_AGENT_ROUTE, sourceId: source.id, agentId: record.agentId };
}
if (process.argv[1] && path20.basename(process.argv[1]) === "desk-agent-source-validation.mjs" && path20.resolve(process.argv[1]) === fileURLToPath3(import.meta.url)) {
  try {
    const [controlRoot, sourceId, workspacePath, ...rest] = process.argv.slice(2);
    check(!rest.length && path20.isAbsolute(controlRoot) && path20.isAbsolute(workspacePath), "desk_source_arguments");
    const registry = await readJson3(path20.join(controlRoot, "config", "source-registry.json"));
    const sources = registry.sources.filter((source) => source.id === sourceId);
    check(sources.length === 1, "desk_source_identity");
    process.stdout.write(`${JSON.stringify(await validateDeskAgentSource(sources[0], workspacePath))}
`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "invalid", problem: error.code ?? "desk_source_invalid_document" })}
`);
    process.exitCode = 1;
  }
}

// orchestrator/src/desk-task-controller.mjs
import { lstat as lstat14, mkdir as mkdir13, readFile as readFile14, stat as stat4 } from "node:fs/promises";
import path22 from "node:path";

// orchestrator/src/desk-task-common.mjs
import { createHash as createHash15 } from "node:crypto";
import { appendFile, copyFile as copyFile4, lstat as lstat13, mkdir as mkdir12, readFile as readFile13, rename as rename12, rm as rm7, stat as stat3, writeFile as writeFile10 } from "node:fs/promises";
import os from "node:os";
import path21 from "node:path";
var CRLF = "\r\n";
var DeskTaskError = class extends Error {
  constructor(message, code = "desk_task_refused") {
    super(message);
    this.code = code;
  }
};
function refuse(message, code) {
  throw new DeskTaskError(message, code);
}
var PS_CUSTOM_OBJECT = Symbol.for("agents-factory.desk-task.ps-custom-object");
function psCustomObject(value) {
  Object.defineProperty(value, PS_CUSTOM_OBJECT, { value: true, enumerable: false });
  return value;
}
var AUTOMATION_NULL = Object.freeze({ [Symbol.for("agents-factory.desk-task.automation-null")]: true });
function functionOutput(items) {
  if (items.length === 0) return AUTOMATION_NULL;
  return items.length === 1 ? items[0] : [...items];
}
function psArray(value) {
  if (value === AUTOMATION_NULL || value === void 0) return [];
  return Array.isArray(value) ? value : [value];
}
function psString(value) {
  if (value === null || value === void 0 || value === AUTOMATION_NULL) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return formatNumber(value);
  if (Array.isArray(value)) return value.map(psString).join(" ");
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0 ? "" : `@{${entries.map(([key, item]) => `${key}=${psString(item)}`).join("; ")}}`;
  }
  return String(value);
}
function psBool(value) {
  if (value === null || value === void 0 || value === AUTOMATION_NULL) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length === 0 ? false : value.length === 1 ? psBool(value[0]) : true;
  return true;
}
var truthy = psBool;
function property(object, name) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return void 0;
  if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  const lower = name.toLowerCase();
  const key = Object.keys(object).find((item) => item.toLowerCase() === lower);
  return key === void 0 ? void 0 : object[key];
}
function hasProperty(object, name) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return false;
  const lower = name.toLowerCase();
  return Object.keys(object).some((item) => item.toLowerCase() === lower);
}
var NLS_TABLE = "0:,1:!0312,2:!0412,3:!0512,4:!0612,5:!0712,6:!0812,7:!0912,8:!0a12,9:0705,a:0706,b:0707,c:0708,d:0709,e:!0b12,f:!0c12,10:!0d12,11:!0e12,12:!0f12,13:!1012,14:!1112,15:!1212,16:!1312,17:!1412,18:!1512,19:!1612,1a:!1712,1b:!1812,1c:!1912,1d:!1a12,1e:!1b12,1f:!1c12,20:0702,21:071c,22:071d,23:071f,24:0721,25:0723,26:0725,27:!8012,28:0727,29:072a,2a:072d,2b:0803,2c:072f,2d:!8212,2e:0733,2f:0735,30:0d03,31:0d1a,32:0d1c,33:0d1e,34:0d20,35:0d22,36:0d24,37:0d26,38:0d28,39:0d2a,3a:0737,3b:073a,3c:080e,3d:0812,3e:0814,3f:073c,40:073e,41:0e02,42:0e09,43:0e0a,44:0e1a,45:0e21,46:0e23,47:0e25,48:0e2c,49:0e32,4a:0e35,4b:0e36,4c:0e48,4d:0e51,4e:0e70,4f:0e7c,50:0e7e,51:0e89,52:0e8a,53:0e91,54:0e99,55:0e9f,56:0ea2,57:0ea4,58:0ea6,59:0ea7,5a:0ea9,5b:073f,5c:0741,5d:0742,5e:0743,5f:0744,60:0748,61:0e02,62:0e09,63:0e0a,64:0e1a,65:0e21,66:0e23,67:0e25,68:0e2c,69:0e32,6a:0e35,6b:0e36,6c:0e48,6d:0e51,6e:0e70,6f:0e7c,70:0e7e,71:0e89,72:0e8a,73:0e91,74:0e99,75:0e9f,76:0ea2,77:0ea4,78:0ea6,79:0ea7,7a:0ea9,7b:074a,7c:074c,7d:074e,7e:0750,7f:!1d12,80:0cfa/1d,81:0cfa/1e,82:0cfa/1f,83:0cfa/20,84:0cfa/21,85:0cfa/22,86:0cfa/23,87:0cfa/24,88:0cfa/25,89:0cfa/26,8a:0cfa/27,8b:0cfa/28,8c:0cfa/29,8d:0cfa/2a,8e:0cfa/2b,8f:0cfa/2c,90:0cfa/2d,91:0cfa/2e,92:0cfa/2f,93:0cfa/30,94:0cfa/31,95:0cfa/32,96:0cfa/33,97:0cfa/34,98:0cfa/35,99:0cfa/36,9a:0cfa/37,9b:0cfa/38,9c:0cfa/39,9d:0cfa/3a,9e:0cfa/3b,9f:0cfa/3c,a0:0704,a1:0751,a2:0797,a3:0798,a4:0799,a5:079a,a6:0752,a7:0a06,a8:0753,a9:0a07,aa:0e02/03|06,ab:0818,ac:0a08,ad:,ae:0a09,af:0754,b0:0a0a,b1:0817,b2:0d1c|06,b3:0d1e|06,b4:0755,b5:0a0b,b6:0a0c,b7:0a0d,b8:0756,b9:0d1a|06,ba:0e7c/03|06,bb:081a,bc:0d0d,bd:0d11,be:0d15,bf:0757,c0:0e02/0f,c1:0e02/0e,c2:0e02/12,c3:0e02/19,c4:0e02/13,c5:0e02/1a,c6:0e020e21,c7:0e0a/1c,c8:0e21/0f,c9:0e21/0e,ca:0e21/12,cb:0e21/13,cc:0e32/0f,cd:0e32/0e,ce:0e32/12,cf:0e32/13,d0:0e1a/68,d1:0e70/19,d2:0e7c/0f,d3:0e7c/0e,d4:0e7c/12,d5:0e7c/19,d6:0e7c/13,d7:081c,d8:0e7c/21,d9:0e9f/0f,da:0e9f/0e,db:0e9f/12,dc:0e9f/13,dd:0ea7/0e,de:0e990e2c,df:0e910e91,e0:0e02/0f,e1:0e02/0e,e2:0e02/12,e3:0e02/19,e4:0e02/13,e5:0e02/1a,e6:0e020e21,e7:0e0a/1c,e8:0e21/0f,e9:0e21/0e,ea:0e21/12,eb:0e21/13,ec:0e32/0f,ed:0e32/0e,ee:0e32/12,ef:0e32/13,f0:0e1a/68,f1:0e70/19,f2:0e7c/0f,f3:0e7c/0e,f4:0e7c/12,f5:0e7c/19,f6:0e7c/13,f7:081d,f8:0e7c/21,f9:0e9f/0f,fa:0e9f/0e,fb:0e9f/12,fc:0e9f/13,fd:0ea7/0e,fe:0e990e2c,ff:0ea7/13,400:1014/0f,401:1014/13,402:1011,403:100a/0e,404:1019,405:1020,406:1026,407:1026/13,408:102c,409:1034,40a:1044,40b:105d,40c:102e/0e,40d:1022/0f,40e:1063/15,40f:1081,410:1002,411:1006,412:1008,413:100a,414:100f,415:1014,416:101b,417:101e,418:1022,419:1022/15,41a:102e,41b:1032,41c:1038,41d:103a,41e:1048,41f:104f,420:1051,421:1053,422:1057,423:1063,424:106c,425:106f,426:1075,427:1078,428:1084,429:1087,42a:108a,42b:108d,42c:1096,42d:109c,42e:10a2,42f:10a5,430:1002,431:1006,432:1008,433:100a,434:100f,435:1014,436:101b,437:101e,438:1022,439:1022/15,43a:102e,43b:1032,43c:1038,43d:103a,43e:1048,43f:104f,440:1051,441:1053,442:1057,443:1063,444:106c,445:106f,446:1075,447:1078,448:1084,449:1087,44a:108a,44b:108d,44c:1096,44d:109c,44e:10a2,44f:10a5,450:1014/0f,451:1014/13,452:1011,453:100a/0e,454:1019,455:1020,456:1026,457:1026/13,458:102c,459:1034,45a:1044,45b:105d,45c:102e/0e,45d:1022/0f,45e:1063/15,45f:1081,2000:070c,2001:070d,2002:070c,2003:070d,2004:070e,2005:070f,2006:0710,2007:0711,2008:0712,2009:0713,200a:0714,200b:0715,200c:,200d:,200e:,200f:,2010:!8412,2011:!8512,2012:!8812,2013:!8912,2014:!9012,2015:!9212,2016:0777,2017:0778,2018:0779,2019:077a,201a:077b,201b:077c,201c:077d,201d:077e,201e:077f,201f:0780,2020:0b25,2021:0b26,2022:0b27,2023:0b28,2024:0733,2025:0a0f,2026:0a10,2027:!8612,2028:0717,2029:0718,202a:,202b:,202c:,202d:,202e:,202f:0702/0a,2030:0b2c/0c,2031:0b2c/0e,2032:0781,2033:0781/14,2034:0781/28,2035:0784,2036:0781/19,2037:0781/2d,2038:0787,2039:0788,203a:0789,203b:0b2e,203c:071c/14,203d:078b,203e:078c,203f:078d,2040:0b2f,2041:0b30,2042:0b31,2043:!8712,2044:0807,2045:073f/1c,2046:0742/1c,2047:073c/64,2048:073c/c8,2049:071c/c8,204a:0787,204b:0725,204c:0724,204d:071d,204e:071e,204f:0723,2050:0722,2051:072d/64,2052:0721,2053:0788,2054:0720,2055:071a/15,2056:071a/1f,2057:071f,2058:071a/29,2059:071a/33,205a:071a/3d,205b:071a/47,205c:0c02,205d:0c03,205e:0c04,205f:0702,2060:,2061:,2062:,2063:,2064:,2065:,2066:,2067:,2068:,2069:,206a:,206b:,206c:,206d:,206e:,206f:,20a0:079d,20a1:07ab,20a2:07a8,20a3:079e,20a4:079f,20a5:07a0,20a6:07a1,20a7:07a2,20a8:07a3,20a9:07a4,20aa:07b6,20ab:07b7,20ac:07a9,20ad:07a0,20ae:07a7,20af:07a5,20b0:07a6,20b1:079b,20b2:07b2,20b3:07b3,20b4:07b4,20b5:07b5,20b6:,20b7:,20b8:,20b9:07bf,20ba:07c0,20bb:,20bc:,20bd:,20be:,20bf:,20c0:,20c1:,20c2:,20c3:,20c4:,20c5:,20c6:,20c7:,20c8:,20c9:,20ca:,20cb:,20cc:,20cd:,20ce:,20cf:,2100:0e05,2101:0e06/04,2102:0e0a/04,2103:0e0a/05,2104:0e13,2105:0e18,2106:0e19,2107:0e22/c8,2108:0e92/0a,2109:0e23/04,210a:0e25/04,210b:0e2c/04,210c:0e2c/07,210d:0e2c/06,210e:0e2c/05,210f:0e2c/68,2110:0e32/05,2111:0e32/06,2112:0e48/04,2113:0e48/04,2114:0e49,2115:0e70/04,2116:0e71,2117:0afa,2118:0e7e/04,2119:0e7e/03,211a:0e89/03,211b:0e8a/05,211c:0e8a/06,211d:0e8a/04,211e:0e8b,211f:0e8c,2120:0e93,2121:0e9a,2122:0e9c,2123:0ea3,2124:0ea9/04,2125:0ea9/63,2126:0f32,2127:0f32/03,2128:0ea9/05,2129:0f32/05,212a:0e36,212b:0e02/1a,212c:0e09/04,212d:0e0a/06,212e:0e21/05,212f:0e21/04,2130:0e21/04,2131:0e23/05,2132:0e23/03,2133:0e51/04,2134:0e7c/04,2135:2802|06,2136:2803|06,2137:2804|06,2138:2805|06,2139:0e33/f0,213a:0e89/08,213b:0b02,213c:0f22,213d:0f06/05,213e:0f06/05,213f:0f22/05,2140:0e21/08,2141:0e25/0a,2142:0e48/0c,2143:0e48/0d,2144:0ea7/0d,2145:0e1a/04,2146:0e1a/04,2147:0e21/06,2148:0e32/07,2149:0e35/05,214a:0b4d,214b:070a/0a,214c:0c64,214d:0c65,214e:0e23/03,214f:0cfd,2150:0d0a,2151:0d08,2152:0d07,2153:0d0e,2154:0d14,2155:0d0c,2156:0d10,2157:0d12,2158:0d16,2159:0d0b,215a:0d17,215b:0d09,215c:0d0f,215d:0d13,215e:0d18,215f:0da6/e6";
var bytesOf = (hex) => hex ? [...Buffer.from(hex, "hex")] : [];
var NLS = new Map(NLS_TABLE.split(",").map((entry) => {
  const [code, rest] = entry.split(":");
  const match = /^([0-9a-f]*)(?:\/([0-9a-f]+))?(?:\|([0-9a-f]+))?(?:!([0-9a-f]+))?$/u.exec(rest);
  const primary = bytesOf(match[1]);
  const units = [];
  for (let index = 0; index < primary.length; index += 2) units.push([primary[index], primary[index + 1]]);
  return [Number.parseInt(code, 16), {
    units,
    diacritics: bytesOf(match[2]),
    cases: bytesOf(match[3]),
    special: bytesOf(match[4])
  }];
}));
function nlsEntry(code) {
  const known = NLS.get(code);
  if (known) return known;
  return { units: [[240, code >> 8 & 255], [240, code & 255]], diacritics: [], cases: [], special: [] };
}
function nlsSortKey(value) {
  if (value.length === 0) return Buffer.alloc(0);
  const primary = [];
  const diacritics = [];
  const cases = [];
  const special = [];
  let units = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entry = nlsEntry(value.charCodeAt(index));
    if (entry.special.length > 0) {
      const position = 65535 - units;
      special.push(position >> 8 & 255, position & 255, ...entry.special);
      continue;
    }
    entry.units.forEach((unit, unitIndex) => {
      primary.push(...unit);
      diacritics.push(entry.diacritics[unitIndex] ?? 2);
      cases.push(entry.cases[unitIndex] ?? 2);
    });
    units += entry.units.length;
  }
  const trim = (list) => {
    while (list.length && list[list.length - 1] === 2) list.pop();
    return list;
  };
  return Buffer.from([...primary, 1, ...trim(diacritics), 1, ...trim(cases), 1, 1, ...special, 0]);
}
function nlsCompare(left, right) {
  return Buffer.compare(nlsSortKey(String(left)), nlsSortKey(String(right)));
}
function psEquals(left, right) {
  const a = psString(left);
  const b = psString(right);
  return a === b || nlsCompare(a, b) === 0;
}
function psIn(value, list) {
  return list.some((item) => psEquals(value, item));
}
function psSort(items, key = (item) => item) {
  return [...items].sort((left, right) => nlsCompare(key(left), key(right)));
}
function formatNumber(value) {
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return Object.is(value, -0) ? "0" : String(value);
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  if (exponent >= 15 || exponent < -5) {
    return `${mantissa.toUpperCase()}E${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return String(value);
}
var JSON_ESCAPES = /* @__PURE__ */ new Map([[8, "\\b"], [9, "\\t"], [10, "\\n"], [12, "\\f"], [13, "\\r"], [34, '\\"'], [92, "\\\\"]]);
function jsonString(value) {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const escape = JSON_ESCAPES.get(code);
    if (escape) output += escape;
    else if (code < 32 || code === 39 || code === 60 || code === 62 || code === 38 || code === 133 || code === 8232 || code === 8233) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += value[index];
  }
  return `${output}"`;
}
function compactJson(value) {
  if (value === null || value === void 0) return "null";
  if (value === AUTOMATION_NULL) return "{}";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return jsonString(value);
  if (value instanceof Date) return `"\\/Date(${value.getTime()})\\/"`;
  if (Array.isArray(value)) return `[${value.map(compactJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${jsonString(key)}:${compactJson(item)}`).join(",")}}`;
  }
  return jsonString(String(value));
}
function appendString(json, index, output) {
  for (let position = index; position < json.length; position += 1) {
    output.push(json[position]);
    if (json[position] === "\\") {
      output.push(json[position + 1]);
      position += 1;
    } else if (json[position] === '"') return position;
  }
  return json.length - 1;
}
function convertList(json, index, output, pad, spaces) {
  output.push(CRLF);
  const newPad = `${pad}${" ".repeat(spaces)}    `;
  let headChar = true;
  for (let position = index; position < json.length; position += 1) {
    const character = json[position];
    if (character === "{") {
      output.push(newPad, character);
      position = convertDictionary(json, position + 1, output, newPad, 0);
      headChar = false;
    } else if (character === "[") {
      output.push(newPad, character);
      position = convertList(json, position + 1, output, newPad, 0);
      headChar = false;
    } else if (character === "]") {
      output.push(CRLF, pad, " ".repeat(spaces), character);
      return position;
    } else if (character === '"') {
      if (headChar) output.push(newPad);
      output.push(character);
      position = appendString(json, position + 1, output);
      headChar = false;
    } else if (character === ",") {
      output.push(character, CRLF);
      headChar = true;
    } else {
      if (headChar) output.push(newPad);
      output.push(character);
      headChar = false;
    }
  }
  return json.length - 1;
}
function convertDictionary(json, index, output, pad, spaces) {
  output.push(CRLF);
  const newPad = `${pad}${" ".repeat(spaces)}    `;
  let beforeQuote = true;
  let keyWidth = 0;
  for (let position = index; position < json.length; position += 1) {
    const character = json[position];
    if (character === "{") {
      output.push(character);
      position = convertDictionary(json, position + 1, output, newPad, keyWidth);
    } else if (character === "[") {
      output.push(character);
      position = convertList(json, position + 1, output, newPad, keyWidth);
    } else if (character === "}") {
      output.push(CRLF, pad, " ".repeat(spaces), character);
      return position;
    } else if (character === '"') {
      if (beforeQuote) output.push(newPad);
      output.push(character);
      const end = appendString(json, position + 1, output);
      if (beforeQuote) keyWidth = end - position + 1 + 3;
      beforeQuote = false;
      position = end;
    } else if (character === ":") {
      output.push(character, "  ");
      beforeQuote = false;
    } else if (character === ",") {
      output.push(character, CRLF);
      beforeQuote = true;
    } else output.push(character);
  }
  return json.length - 1;
}
function psJson(value, { compress = false } = {}) {
  const json = compactJson(value);
  if (compress || !(json.startsWith("{") || json.startsWith("["))) return json;
  const output = [json[0]];
  if (json[0] === "{") convertDictionary(json, 1, output, "", 0);
  else convertList(json, 1, output, "", 0);
  return output.join("");
}
var NET_SPACE = "[\\f\\n\\r\\t\\v\\x85\\p{Z}]";
var NET_WHITE_CLASS = "	\n\v\f\r    - \u2028\u2029  　";
var NET_WHITE = new RegExp(`^[${NET_WHITE_CLASS}]*$`, "u");
var NET_TRIM = new RegExp(`^[${NET_WHITE_CLASS}]+|[${NET_WHITE_CLASS}]+$`, "gu");
function isNullOrWhiteSpace(value) {
  return value === null || value === void 0 || value === AUTOMATION_NULL || NET_WHITE.test(psString(value));
}
function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    return bytes.subarray(3).toString("utf8");
  }
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8");
}
async function readAllText(file) {
  return decodeText(await readFile13(file));
}
async function readJson4(file) {
  return JSON.parse(await readAllText(file));
}
function netMatch(pattern, value, { ignoreCase = true } = {}) {
  const expression = new RegExp(pattern, `u${ignoreCase ? "i" : ""}`);
  const text3 = String(value);
  if (expression.test(text3)) return true;
  return /\$$/u.test(pattern) && text3.endsWith("\n") && expression.test(text3.slice(0, -1));
}
var INLINE_MEDIA = new RegExp(`data${NET_SPACE}*:${NET_SPACE}*(image|audio|video)/[^,${NET_SPACE.slice(1, -1)}]+(?:;[^,${NET_SPACE.slice(1, -1)}]+)*,`, "iu");
var CONTROL_ABSOLUTE = new RegExp(`(^|[${NET_SPACE.slice(1, -1)}"'(<\\[])${NET_SPACE}*(?:file:/+|[a-z]:[\\\\/]|\\\\\\\\[^\\\\/${NET_SPACE.slice(1, -1)}]+[\\\\/])`, "iu");
var ORCHESTRATED_ABSOLUTE = new RegExp(`(^|[${NET_SPACE.slice(1, -1)}"'(])(?:[a-z]:[\\\\/]|\\\\\\\\[^\\\\/${NET_SPACE.slice(1, -1)}]+[\\\\/])`, "iu");
function hasInlineMedia(text3) {
  return Boolean(text3) && INLINE_MEDIA.test(String(text3));
}
function assertControlTextSafety(text3, description = "content") {
  if (truthy(text3) && hasInlineMedia(text3)) {
    refuse(`Inline media is forbidden in ${description}. Use a project-relative artifact path.`);
  }
}
function assertControlDurableText(text3, description = "durable content") {
  assertControlTextSafety(text3, description);
  if (truthy(text3) && CONTROL_ABSOLUTE.test(String(text3))) {
    refuse(`Machine-local absolute paths are forbidden in ${description}. Use a project-relative reference.`);
  }
}
function assertControlRelativeReference(value, description) {
  if (isNullOrWhiteSpace(value)) refuse(`${description} must not be empty.`);
  const text3 = String(value);
  if (isPathRooted(text3)) refuse(`${description} must be project-relative: '${text3}'.`);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(text3)) refuse(`${description} must be project-relative, not a URI: '${text3}'.`);
  if (/(^|[\\/])\.\.([\\/]|$)/u.test(text3)) refuse(`${description} may not traverse above the project: '${text3}'.`);
  assertControlTextSafety(text3, description);
}
function isPathRooted(value) {
  const text3 = String(value);
  return /^[\\/]/u.test(text3) || /^[a-zA-Z]:/u.test(text3) || path21.isAbsolute(text3);
}
function fullPath(value) {
  return path21.resolve(String(value));
}
function startsInside(candidate, root) {
  const base = fullPath(root).replace(/[\\/]+$/u, "") + path21.sep;
  return candidate.toLowerCase().startsWith(base.toLowerCase());
}
async function resolveControlRelativePath(basePath, relativePath, { allowMissing = false } = {}) {
  if (isNullOrWhiteSpace(relativePath)) refuse("Relative path must not be empty.");
  if (isPathRooted(relativePath)) refuse(`Expected a relative path, received '${relativePath}'.`);
  if (/(^|[\\/])\.\.([\\/]|$)/u.test(relativePath)) refuse(`Relative path may not traverse above its root: '${relativePath}'.`);
  const resolved = path21.resolve(fullPath(basePath).replace(/[\\/]+$/u, ""), relativePath);
  if (!startsInside(resolved, basePath)) refuse(`Resolved path escapes its root: '${relativePath}'.`);
  if (!allowMissing && !await exists7(resolved)) refuse(`Resolved path does not exist: ${resolved}`);
  return resolved;
}
async function exists7(file) {
  return Boolean(await lstat13(file).catch(() => null));
}
async function isFile(file) {
  return Boolean((await stat3(file).catch(() => null))?.isFile());
}
async function isDirectory(file) {
  return Boolean((await stat3(file).catch(() => null))?.isDirectory());
}
var sha256Bytes = (bytes) => createHash15("sha256").update(bytes).digest("hex");
async function sha256File2(file) {
  return sha256Bytes(await readFile13(file));
}
async function writeTextUtf8NoBom(file, text3) {
  await mkdir12(path21.dirname(file), { recursive: true });
  await writeFile10(file, Buffer.from(text3, "utf8"));
}
async function writeLinesUtf8NoBom(file, lines2) {
  await writeTextUtf8NoBom(file, lines2.map((line) => `${line}${CRLF}`).join(""));
}
async function writePsJson(file, value) {
  await writeTextUtf8NoBom(file, psJson(value));
}
async function moveItem(source, destination, { force = false } = {}) {
  if (!force && await exists7(destination)) {
    refuse(`Cannot create a file when that file already exists: ${destination}`, "desk_task_destination_exists");
  }
  await renameOver(source, destination);
}
async function copyItem(source, destination) {
  await copyFile4(source, destination);
}
async function removeQuietly(file) {
  await rm7(file, { recursive: true, force: true }).catch(() => void 0);
}
var utcStamp = (date) => date.toISOString();
var compactStamp2 = (date) => date.toISOString().replace(/[-:]/gu, "").replace(".", "");
var guidN = () => globalThis.crypto.randomUUID().replaceAll("-", "");
var MAX_REPORT_STRING = 16384;
function trimReportString(value, maximum = MAX_REPORT_STRING) {
  if (value === null || value === void 0) return null;
  if (maximum <= 0 || value.length <= maximum) return value;
  const prefix = Math.min(Math.floor(maximum * 0.7), value.length);
  const suffix = Math.min(maximum - prefix, value.length - prefix);
  return `${value.slice(0, prefix)}
...<truncated ${value.length - (prefix + suffix)} chars>...
${value.slice(value.length - suffix)}`;
}
function serializableData(value, depth = 10) {
  if (value === null || value === void 0 || value === AUTOMATION_NULL) return null;
  if (depth < 0) return "<max-depth-exceeded>";
  if (value instanceof Date) return utcStamp(value);
  if (typeof value === "string") return trimReportString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 128).map((item) => serializableData(item, depth - 1));
    if (value.length >= 128) items.push("<truncated_items>");
    return items;
  }
  const keys = Object.keys(value);
  if (value[PS_CUSTOM_OBJECT]) {
    if (keys.length === 0) return value;
    const result2 = {};
    for (const key of keys.slice(0, 128)) result2[key] = serializableData(value[key], depth - 1);
    if (keys.length > 128) result2["<truncated_properties>"] = keys.length - 128;
    return result2;
  }
  const sorted = psSort(keys).slice(0, 128);
  const result = {};
  for (const key of sorted) result[key] = serializableData(value[key], depth - 1);
  if (keys.length > sorted.length) result["<truncated_keys>"] = keys.length - sorted.length;
  return result;
}
async function readProjectManifest(root) {
  const manifestPath = path21.join(fullPath(root), "project-version.json");
  if (!await isFile(manifestPath)) refuse(`Project version manifest was not found: ${manifestPath}`);
  try {
    return await readJson4(manifestPath);
  } catch (error) {
    return refuse(`Failed to parse project version manifest: ${manifestPath}. ${error.message}`);
  }
}
async function componentVersion(root, name) {
  const manifest = await readProjectManifest(root);
  const versions = property(manifest, "componentVersions");
  if (!truthy(versions)) refuse("componentVersions is missing in project-version.json");
  const version2 = property(versions, name);
  if (version2 === void 0) refuse(`No version entry was found for component '${name}' in project-version.json`);
  return psString(version2);
}
function machineInfo() {
  return {
    computerName: process.env.COMPUTERNAME ?? os.hostname(),
    userName: process.env.USERNAME ?? process.env.USER ?? os.userInfo().username,
    osPlatform: process.platform === "win32" ? "Win32NT" : "Unix",
    osVersion: os.release(),
    isWindows: process.platform === "win32",
    psEdition: "Node.js",
    psVersion: process.versions.node
  };
}
async function startToolRun({ root, toolName, parameters, output }) {
  const repoRoot = fullPath(root);
  const logs = path21.join(repoRoot, "logs");
  const old = path21.join(logs, "old");
  await mkdir12(old, { recursive: true });
  const timestamp2 = compactStamp2(/* @__PURE__ */ new Date());
  const fileResults = [];
  for (const fileName of [`${toolName}.log`, `${toolName}.report.json`]) {
    const source = path21.join(logs, fileName);
    if (!await isFile(source)) continue;
    const archived = path21.join(old, fileName.endsWith(".report.json") ? `${toolName}-${timestamp2}.report.json` : `${toolName}-${timestamp2}${path21.extname(fileName)}`);
    try {
      await rename12(source, archived);
      fileResults.push({ fileName, fresh: false });
    } catch {
      try {
        await copyFile4(source, archived);
        fileResults.push({ fileName, fresh: true, locked: true });
      } catch {
        fileResults.push({ fileName, fresh: true, blocked: true });
      }
    }
  }
  const rotated = fileResults.some((item) => item.fresh);
  const fresh = (name) => rotated && fileResults.find((item) => item.fileName === name)?.fresh;
  const logPath = path21.join(logs, fresh(`${toolName}.log`) ? `${toolName}-${timestamp2}.log` : `${toolName}.log`);
  const reportPath = path21.join(logs, fresh(`${toolName}.report.json`) ? `${toolName}-${timestamp2}.report.json` : `${toolName}.report.json`);
  const manifest = await readProjectManifest(repoRoot);
  const context2 = {
    toolName,
    toolVersion: await componentVersion(repoRoot, toolName),
    projectName: psString(manifest.projectName),
    projectVersion: psString(manifest.projectVersion),
    repoRoot,
    startedAt: /* @__PURE__ */ new Date(),
    logPath,
    reportPath,
    parameters: serializableData(parameters),
    output,
    firstLine: output.lines.length
  };
  await writeTextUtf8NoBom(logPath, `Agents Factory desk task log (Node.js ${process.versions.node})${CRLF}Tool: ${toolName}${CRLF}`);
  output.host(`tool_name: ${context2.toolName}`);
  output.host(`tool_version: ${context2.toolVersion}`);
  output.host(`project_version: ${context2.projectVersion}`);
  output.host(`repo_root: ${repoRoot}`);
  output.host(`started_at_utc: ${utcStamp(context2.startedAt)}`);
  if (fresh(`${toolName}.log`)) output.host("tool_log_rotation: timestamped-active-log");
  if (fresh(`${toolName}.report.json`)) output.host("tool_report_rotation: timestamped-active-report");
  return context2;
}
function errorRecord(error) {
  const message = String(error?.message ?? error);
  return {
    message,
    exceptionType: "System.Management.Automation.RuntimeException",
    category: "OperationStopped",
    fullyQualifiedErrorId: message,
    scriptStackTrace: trimReportString(String(error?.stack ?? ""), 8192),
    invocationInfo: { scriptName: "", line: 0, offsetInLine: 0, positionMessage: "", lineText: "" }
  };
}
async function stopToolRun(context2, status, exitCode, result, error = null) {
  const finishedAt = /* @__PURE__ */ new Date();
  const report = {
    formatVersion: 1,
    toolName: context2.toolName,
    toolVersion: context2.toolVersion,
    projectName: context2.projectName,
    projectVersion: context2.projectVersion,
    status,
    exitCode,
    startedAtUtc: utcStamp(context2.startedAt),
    finishedAtUtc: utcStamp(finishedAt),
    durationMs: Math.round(finishedAt - context2.startedAt),
    repoRoot: context2.repoRoot,
    logPath: context2.logPath,
    reportPath: context2.reportPath,
    transcriptStartAttempts: 1,
    machine: machineInfo(),
    parameters: context2.parameters,
    result: serializableData(result)
  };
  if (error) report.error = errorRecord(error);
  await writePsJson(context2.reportPath, report);
  const { output } = context2;
  output.host("report_serialization: full-report-written");
  output.host(`tool_status: ${status}`);
  output.host(`exit_code: ${exitCode}`);
  output.host(`tool_log: ${context2.logPath}`);
  output.host(`tool_report: ${context2.reportPath}`);
  const lines2 = output.lines.slice(context2.firstLine);
  await appendFile(context2.logPath, `${lines2.map((line) => `${line}${CRLF}`).join("")}` + (error ? `ERROR: ${error.message}${CRLF}` : ""));
  return report;
}
async function withToolRun({ root, toolName, parameters, output }, action) {
  const context2 = await startToolRun({ root, toolName, parameters, output });
  let result = {};
  const keep = (value) => {
    result = value;
  };
  try {
    const returned = await action(keep, context2);
    if (returned !== void 0) result = returned;
    await stopToolRun(context2, "success", 0, result ?? {});
    return result;
  } catch (error) {
    await stopToolRun(context2, "failed", 1, result ?? {}, error).catch(() => void 0);
    throw error;
  }
}

// orchestrator/src/desk-task-controller.mjs
var COORDINATOR_ID = "agents-factory-control";
var SOURCE_ID_PATTERN = "^[a-z0-9][a-z0-9-]{1,63}$";
async function readRegistry(controlRoot) {
  const registryPath2 = path22.join(controlRoot, "config", "source-registry.json");
  if (!await isFile(registryPath2)) refuse(`Source registry was not found: ${registryPath2}`);
  return readJson4(registryPath2);
}
async function readBindings(controlRoot) {
  const bindingsPath = path22.join(controlRoot, ".project-local", "source-bindings.json");
  if (!await isFile(bindingsPath)) refuse(`Machine-local source bindings were not found: ${bindingsPath}`);
  return readJson4(bindingsPath);
}
async function readSourceDefinition(controlRoot, sourceId) {
  const registry = await readRegistry(controlRoot);
  const matches = psArray(registry.sources).filter((source) => psEquals(property(source, "id"), sourceId));
  if (matches.length !== 1) refuse(`Expected exactly one registered source '${sourceId}'; found ${matches.length}.`);
  return matches[0];
}
async function resolveControlSourceWorkspace(controlRoot, sourceId) {
  const source = await readSourceDefinition(controlRoot, sourceId);
  const bindings = await readBindings(controlRoot);
  const sources = bindings.sources && typeof bindings.sources === "object" ? bindings.sources : null;
  const bindingKey = sources ? Object.keys(sources).find((key) => key.toLowerCase() === String(sourceId).toLowerCase()) : void 0;
  if (bindingKey === void 0) refuse(`No machine-local binding exists for source '${sourceId}'.`);
  const binding = sources[bindingKey];
  const boundWorkspace = property(binding, "workspacePath");
  const legacy = property(binding, "path");
  let workspacePath = truthy(boundWorkspace) ? psString(boundWorkspace) : truthy(legacy) ? psString(legacy) : null;
  if (isNullOrWhiteSpace(workspacePath)) refuse(`Binding '${sourceId}' requires workspacePath (or legacy path).`);
  workspacePath = fullPath(workspacePath);
  if (!await isDirectory(workspacePath)) refuse(`Bound workspace does not exist for '${sourceId}': ${workspacePath}`);
  const configuredRoot = property(source, "workspaceRelativeSourceRoot");
  const sourceRelativeRoot = truthy(configuredRoot) ? psString(configuredRoot) : ".";
  const boundSource = property(binding, "sourcePath");
  const sourcePath = truthy(boundSource) ? fullPath(psString(boundSource)) : sourceRelativeRoot === "." ? workspacePath : await resolveControlRelativePath(workspacePath, sourceRelativeRoot);
  if (!await isDirectory(sourcePath)) refuse(`Bound implementation source does not exist for '${sourceId}': ${sourcePath}`);
  const route = psString(property(source, "providerRoute"));
  if (route !== DESK_AGENT_ROUTE) {
    refuse(
      `Source '${sourceId}' is not on the Claude desk route; its tools are the controller's PowerShell scripts.`,
      "desk_task_route_unsupported"
    );
  }
  try {
    const registry = await readRegistry(controlRoot);
    const exact2 = psArray(registry.sources).filter((item) => item?.id === sourceId);
    if (exact2.length !== 1) throw Object.assign(new Error("desk_source_identity"), { code: "desk_source_identity" });
    const validation = await validateDeskAgentSource(exact2[0], workspacePath);
    if (validation.status !== "valid" || validation.routeId !== route) refuse("desk_source_result_mismatch");
  } catch (error) {
    if (error?.code === "desk_task_refused") throw error;
    refuse(`Desk agent source validation failed for '${sourceId}': ${JSON.stringify({
      status: "invalid",
      problem: error?.code ?? "desk_source_invalid_document"
    })}`);
  }
  const taskInbox = truthy(property(source, "taskInbox")) ? psString(property(source, "taskInbox")) : ".orchestrator/tasks/inbox";
  const reportOutbox = truthy(property(source, "reportOutbox")) ? psString(property(source, "reportOutbox")) : ".orchestrator/reports/outbox";
  const adapter = property(source, "executionAdapter");
  return {
    sourceId,
    definition: source,
    binding,
    workspacePath,
    sourcePath,
    launcherPath: null,
    launcherRelativePath: null,
    runtimePath: path22.join(workspacePath, ".project-runtime"),
    taskInboxPath: await resolveControlRelativePath(workspacePath, taskInbox, { allowMissing: true }),
    taskInboxRelativePath: taskInbox.replaceAll("\\", "/"),
    reportOutboxPath: await resolveControlRelativePath(workspacePath, reportOutbox, { allowMissing: true }),
    reportOutboxRelativePath: reportOutbox.replaceAll("\\", "/"),
    executionAdapter: truthy(adapter) ? psString(adapter) : "handoff-file"
  };
}
function taskStrings(value, name, { relativePaths = false } = {}) {
  const items = [];
  for (const entry of psArray(value)) {
    if (entry === null) continue;
    let item = psString(entry);
    if (isNullOrWhiteSpace(item)) refuse(`Task field '${name}' may not contain an empty value.`);
    assertControlDurableText(item, `task field '${name}'`);
    if (relativePaths) {
      assertControlRelativeReference(item, `task field '${name}'`);
      item = item.replaceAll("\\", "/");
    }
    items.push(item);
  }
  return functionOutput(items);
}
function propertyValue(object, name, fallback = null) {
  const value = hasProperty(object, name) ? property(object, name) : fallback;
  return Array.isArray(value) ? functionOutput(value) : value;
}
function taskContractVersion(definition) {
  const declared = psString(propertyValue(definition, "contractVersion"));
  if (declared) return declared;
  if (hasProperty(definition, "workflowPolicy") || hasProperty(definition, "intentConfirmation")) return "v0.3.0";
  if (hasProperty(definition, "intent") || hasProperty(definition, "desiredOutcomes")) return "v0.2.0";
  return "v0.1.0";
}
function supportedTaskContracts(contract) {
  const versions = ["v0.1.0"];
  if (hasProperty(contract, "supportedTaskContractVersions")) {
    for (const version2 of psArray(property(contract, "supportedTaskContractVersions"))) {
      const item = psString(version2);
      if (item && !versions.includes(item)) versions.push(item);
    }
  }
  const current = psString(propertyValue(contract, "taskContractVersion"));
  if (current && !versions.includes(current)) versions.push(current);
  return versions;
}
var isDateTime = (value) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?)?(Z|[+-]\d{2}:\d{2})?$/u.test(value) && !Number.isNaN(Date.parse(value));
function markdownList(lines2, title, values) {
  lines2.push(`## ${title}`, "");
  const items = psArray(values);
  if (items.length === 0) lines2.push("- None specified.");
  else for (const value of items) lines2.push(`- ${psString(value)}`);
  lines2.push("");
}
function taskMarkdownLines(task) {
  const field = (name) => psString(property(task, name));
  const lines2 = [
    `# Orchestrated Task: ${field("title")}`,
    "",
    `- Task ID: \`${field("taskId")}\``,
    `- Target: \`${field("targetId")}\``,
    `- Contract: \`${field("contractVersion")}\``,
    `- Priority: \`${field("priority")}\``,
    `- Dispatched: \`${field("dispatchedAtUtc")}\``,
    `- Execution adapter: \`${field("executionAdapter")}\``,
    ""
  ];
  const version2 = field("contractVersion");
  const intentFirst = psIn(version2, ["v0.2.0", "v0.3.0"]);
  if (intentFirst) {
    lines2.push("## Intent", "", field("intent"), "");
    markdownList(lines2, "Desired Outcomes", property(task, "desiredOutcomes"));
    if (psEquals(version2, "v0.3.0")) {
      const confirmation = property(task, "intentConfirmation");
      lines2.push(
        "## Confirmed Workflow",
        "",
        `- Policy: \`${field("workflowPolicy")}\``,
        `- Intent confirmed by: \`${psString(property(confirmation, "confirmedBy"))}\``,
        `- Intent confirmed at: \`${psString(property(confirmation, "confirmedAtUtc"))}\``,
        "- Implementation remains locked until the child plan is separately confirmed.",
        ""
      );
    }
  } else {
    lines2.push("## Objective", "", field("objective"), "");
  }
  lines2.push("## Responsibility Boundary", "", field("responsibilityBoundary"), "");
  if (intentFirst) {
    lines2.push("## Execution Authority", "", "The target project owns concrete file selection, implementation, local architecture, and local validation. The coordinator owns intent, external constraints, and cross-project acceptance.", "");
    markdownList(lines2, "Required Reading", property(task, "requiredReading"));
    markdownList(lines2, "Forbidden Paths", property(task, "forbiddenPaths"));
    markdownList(lines2, "Constraints", property(task, "constraints"));
    markdownList(lines2, "Deliverables", property(task, "deliverables"));
  } else {
    markdownList(lines2, "Acceptance Criteria", property(task, "acceptanceCriteria"));
    markdownList(lines2, "Required Reading", property(task, "requiredReading"));
    markdownList(lines2, "Allowed Paths (Maximum Safety Boundary)", property(task, "allowedPaths"));
    markdownList(lines2, "Forbidden Paths", property(task, "forbiddenPaths"));
    markdownList(lines2, "Constraints", property(task, "constraints"));
    markdownList(lines2, "Deliverables", property(task, "deliverables"));
  }
  lines2.push(
    "## Completion Protocol",
    "",
    "1. Invoke `$execute-orchestrated-task` and validate this task against the local owner scope.",
    "2. Acknowledge the task with the bundled `accept_task.ps1` script.",
    "3. Inspect the current project and choose the implementation files and local validation plan inside the target's owner boundary."
  );
  if (psEquals(version2, "v0.3.0")) {
    lines2.push(
      "4. Publish the proposed plan, stop, and record explicit user confirmation with `confirm_task_plan.ps1`.",
      "5. Record the pre-implementation checkpoint before changing source or behavior.",
      "6. Submit an immutable report with `submit_report.ps1`.",
      "7. Do not edit this task packet or plan approval after creation."
    );
  } else {
    lines2.push("4. Submit an immutable report with `submit_report.ps1`.", "5. Do not edit this task packet after dispatch.");
  }
  lines2.push("");
  return lines2;
}
async function writeTaskPackage(directory, task) {
  await mkdir13(directory, { recursive: true });
  const taskJsonPath = path22.join(directory, "task.json");
  await writePsJson(taskJsonPath, task);
  await writeLinesUtf8NoBom(path22.join(directory, "task.md"), taskMarkdownLines(task));
  const hash2 = await sha256File2(taskJsonPath);
  await writeTextUtf8NoBom(path22.join(directory, "task.sha256"), `${hash2}  task.json
`);
  return hash2;
}
async function dispatchChildTask(parameters, { output, clock = () => /* @__PURE__ */ new Date() }) {
  const sourceIdParameter = psString(parameters.SourceId);
  if (!parameters.SourceId) refuse("Cannot process command because of one or more missing mandatory parameters: SourceId.");
  if (!parameters.TaskDefinitionPath) {
    refuse("Cannot process command because of one or more missing mandatory parameters: TaskDefinitionPath.");
  }
  if (!netMatch(SOURCE_ID_PATTERN, sourceIdParameter)) {
    refuse(`Cannot validate argument on parameter 'SourceId'. The argument "${sourceIdParameter}" does not match the "${SOURCE_ID_PATTERN}" pattern. Supply an argument that matches "${SOURCE_ID_PATTERN}" and try the command again.`);
  }
  if (psBool(parameters.OpenWorkspace)) refuse("OpenWorkspace is not available for a desk agent.", "desk_task_input_invalid");
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  const sourceId = sourceIdParameter;
  return withToolRun({ root, toolName: "dispatch_child_task", output, parameters: {
    SourceId: sourceId,
    TaskDefinitionPath: psString(parameters.TaskDefinitionPath),
    OpenWorkspace: false,
    NoOpenTaskFile: psBool(parameters.NoOpenTaskFile),
    WhatIf: false,
    RepoRoot: psString(parameters.RepoRoot)
  } }, async () => {
    const definitionPath = fullPath(parameters.TaskDefinitionPath);
    if (!await exists7(definitionPath)) refuse(`Cannot find path '${definitionPath}' because it does not exist.`);
    if ((await stat4(definitionPath)).size > 1048576) refuse("Task definition exceeds the 1 MiB limit.");
    const definitionText = await readAllText(definitionPath);
    assertControlDurableText(definitionText, "task definition");
    const definition = JSON.parse(definitionText);
    const definitionHash = await sha256File2(definitionPath);
    const version2 = taskContractVersion(definition);
    if (!psIn(version2, ["v0.1.0", "v0.2.0", "v0.3.0"])) refuse(`Unsupported task definition contract '${version2}'.`);
    const taskId = psString(propertyValue(definition, "taskId"));
    if (!netMatch("^[a-z0-9][a-z0-9.-]{2,95}$", taskId)) refuse("taskId must match ^[a-z0-9][a-z0-9.-]{2,95}$");
    const targetId = psString(hasProperty(definition, "targetId") ? propertyValue(definition, "targetId") : sourceId);
    if (!psEquals(targetId, sourceId)) refuse(`Task targetId '${targetId}' does not match requested source '${sourceId}'.`);
    const title = psString(propertyValue(definition, "title"));
    const responsibilityBoundary = psString(propertyValue(definition, "responsibilityBoundary"));
    if (isNullOrWhiteSpace(title) || isNullOrWhiteSpace(responsibilityBoundary)) {
      refuse("Task definition requires non-empty title and responsibilityBoundary.");
    }
    for (const item of [title, responsibilityBoundary]) assertControlDurableText(item, "task text");
    const source = await resolveControlSourceWorkspace(root, sourceId);
    const contractPath = path22.join(source.workspacePath, ".orchestrator", "contract.json");
    if (!await isFile(contractPath)) {
      refuse(`Child coordination kit is not installed for '${sourceId}'. Run tools/install_child_coordination_kit.bat first.`);
    }
    const childContract = await readJson4(contractPath);
    if (!psEquals(property(childContract, "sourceId"), sourceId)) refuse(`Child contract sourceId does not match '${sourceId}'.`);
    const supported = supportedTaskContracts(childContract);
    if (!psIn(version2, supported)) {
      refuse(`Child '${sourceId}' does not support task contract '${version2}'; supported: ${supported.join(", ")}.`);
    }
    const artifactReferences = [];
    for (const artifact of psArray(propertyValue(definition, "artifactReferences", []))) {
      const kind2 = psString(propertyValue(artifact, "kind"));
      const artifactPath = psString(propertyValue(artifact, "path"));
      if (!psIn(kind2, ["file", "image", "audio", "video", "directory", "log"])) refuse(`Unsupported artifact kind '${kind2}'.`);
      assertControlRelativeReference(artifactPath, "artifact path");
      const sha25610 = psString(propertyValue(artifact, "sha256"));
      if (sha25610 && !netMatch("^[a-fA-F0-9]{64}$", sha25610)) refuse("Artifact sha256 must contain 64 hexadecimal characters.");
      artifactReferences.push(psCustomObject({
        kind: kind2,
        path: artifactPath.replaceAll("\\", "/"),
        sha256: sha25610 ? sha25610.toLowerCase() : null
      }));
    }
    const priority = psString(hasProperty(definition, "priority") ? propertyValue(definition, "priority") : "normal");
    if (!psIn(priority, ["low", "normal", "high", "critical"])) refuse("Task priority must be low, normal, high, or critical.");
    const list = (name, options) => taskStrings(hasProperty(definition, name) ? propertyValue(definition, name) : AUTOMATION_NULL, name, options);
    const requiredReading = list("requiredReading", { relativePaths: true });
    const forbiddenPaths = list("forbiddenPaths", { relativePaths: true });
    const constraints = list("constraints");
    const deliverables = list("deliverables");
    if (psArray(deliverables).length === 0) refuse("Task definition requires at least one deliverable.");
    let executionProfile = null;
    const requestedProfile = propertyValue(definition, "executionProfile");
    if (truthy(requestedProfile)) {
      if (psEquals(version2, "v0.1.0")) refuse("Legacy task contract v0.1.0 does not support executionProfile.");
      const profileProvider = psString(propertyValue(requestedProfile, "provider"));
      const profileModel = psString(propertyValue(requestedProfile, "model"));
      const profileEffort = psString(propertyValue(requestedProfile, "reasoningEffort"));
      const profileFallback = psString(propertyValue(requestedProfile, "fallbackPolicy"));
      const expectedProvider = "anthropic";
      if (!psEquals(profileProvider, expectedProvider)) refuse(`executionProfile.provider must be '${expectedProvider}'.`);
      if (isNullOrWhiteSpace(profileModel)) refuse("executionProfile.model is required.");
      if (isNullOrWhiteSpace(profileEffort)) refuse("executionProfile.reasoningEffort is required.");
      if (!psEquals(profileFallback, "deny")) refuse("executionProfile.fallbackPolicy must be 'deny'.");
      for (const item of [profileModel, profileEffort]) assertControlDurableText(item, "execution profile");
      executionProfile = {
        provider: expectedProvider,
        model: profileModel,
        reasoningEffort: profileEffort,
        fallbackPolicy: "deny"
      };
    }
    const allowSubagents = psBool(hasProperty(definition, "allowSubagents") ? propertyValue(definition, "allowSubagents") : true);
    let task;
    if (psIn(version2, ["v0.2.0", "v0.3.0"])) {
      if (hasProperty(definition, "objective") || hasProperty(definition, "acceptanceCriteria") || hasProperty(definition, "allowedPaths")) {
        refuse(`Task definition ${version2} must use intent and desiredOutcomes and must not prescribe objective, acceptanceCriteria, or allowedPaths.`);
      }
      const intent = psString(propertyValue(definition, "intent"));
      const desiredOutcomes = list("desiredOutcomes");
      if (isNullOrWhiteSpace(intent) || psArray(desiredOutcomes).length === 0) {
        refuse(`Task definition ${version2} requires non-empty intent and desiredOutcomes.`);
      }
      assertControlDurableText(intent, "task intent");
      const head2 = { schemaVersion: 1, contractVersion: version2 };
      if (psEquals(version2, "v0.3.0")) {
        const workflowPolicy = psString(propertyValue(definition, "workflowPolicy"));
        const confirmation = propertyValue(definition, "intentConfirmation");
        if (!psEquals(workflowPolicy, "intent-confirm-plan-v1")) {
          refuse("Task definition v0.3.0 requires workflowPolicy 'intent-confirm-plan-v1'.");
        }
        if (!truthy(confirmation) || !psEquals(property(confirmation, "status"), "confirmed")) {
          refuse("Task definition v0.3.0 requires an explicit confirmed intentConfirmation.");
        }
        const confirmedBy = psString(propertyValue(confirmation, "confirmedBy"));
        const confirmedAtUtc = psString(propertyValue(confirmation, "confirmedAtUtc"));
        const note = psString(propertyValue(confirmation, "note"));
        if (isNullOrWhiteSpace(confirmedBy) || isNullOrWhiteSpace(confirmedAtUtc)) {
          refuse("Task definition v0.3.0 requires confirmedBy and confirmedAtUtc.");
        }
        if (!isDateTime(confirmedAtUtc)) refuse("Task definition v0.3.0 confirmedAtUtc is not a valid date-time.");
        for (const item of [confirmedBy, note]) if (item) assertControlDurableText(item, "intent confirmation");
        Object.assign(head2, { workflowPolicy, intentConfirmation: {
          status: "confirmed",
          confirmedBy,
          confirmedAtUtc,
          note: note ? note : null
        } });
      }
      task = {
        ...head2,
        taskId,
        coordinatorId: COORDINATOR_ID,
        targetId: sourceId,
        title,
        intent,
        desiredOutcomes,
        responsibilityBoundary,
        priority,
        requiredReading,
        forbiddenPaths,
        constraints,
        deliverables,
        artifactReferences,
        allowSubagents,
        executionAuthority: {
          implementationOwner: "target",
          localValidationOwner: "target",
          crossProjectAcceptanceOwner: "coordinator"
        }
      };
      if (executionProfile) task.executionProfile = executionProfile;
    } else {
      const objective = psString(propertyValue(definition, "objective"));
      const acceptanceCriteria = list("acceptanceCriteria");
      if (isNullOrWhiteSpace(objective) || psArray(acceptanceCriteria).length === 0) {
        refuse("Legacy task definition requires non-empty objective and acceptanceCriteria.");
      }
      assertControlDurableText(objective, "legacy task objective");
      task = {
        schemaVersion: 1,
        contractVersion: "v0.1.0",
        taskId,
        coordinatorId: COORDINATOR_ID,
        targetId: sourceId,
        title,
        objective,
        responsibilityBoundary,
        priority,
        acceptanceCriteria,
        requiredReading,
        allowedPaths: list("allowedPaths", { relativePaths: true }),
        forbiddenPaths,
        constraints,
        deliverables,
        artifactReferences,
        allowSubagents
      };
    }
    Object.assign(task, {
      definitionSha256: definitionHash,
      dispatchedAtUtc: utcStamp(clock()),
      executionAdapter: source.executionAdapter,
      executionState: "awaiting-child-agent-acceptance",
      agentTurnStarted: false,
      reportContract: {
        version: psString(property(childContract, "reportContractVersion")),
        outbox: source.reportOutboxRelativePath,
        requiredSkill: "execute-orchestrated-task"
      }
    });
    const controlTaskDirectory = path22.join(root, "coordination", "tasks", "dispatched", taskId);
    const controlTaskJsonPath = path22.join(controlTaskDirectory, "task.json");
    let controlAction;
    let taskHash = null;
    if (await isFile(controlTaskJsonPath)) {
      const existing = await readJson4(controlTaskJsonPath);
      if (!psEquals(existing.definitionSha256, definitionHash) || !psEquals(existing.targetId, sourceId)) {
        refuse(`Task ID '${taskId}' already exists with a different definition or target. Dispatched tasks are immutable.`);
      }
      taskHash = await sha256File2(controlTaskJsonPath);
      controlAction = "already-dispatched";
    } else {
      const temporary = `${controlTaskDirectory}.tmp-${guidN()}`;
      try {
        taskHash = await writeTaskPackage(temporary, task);
        await mkdir13(path22.dirname(controlTaskDirectory), { recursive: true });
        if (await exists7(controlTaskDirectory)) refuse(`Cannot create a file when that file already exists: ${controlTaskDirectory}`);
        await moveItem(temporary, controlTaskDirectory);
      } finally {
        await removeQuietly(temporary);
      }
      controlAction = "dispatched";
    }
    const childTaskDirectory = path22.join(source.taskInboxPath, taskId);
    let childAction;
    if (await isFile(path22.join(childTaskDirectory, "task.json"))) {
      const childHash = await sha256File2(path22.join(childTaskDirectory, "task.json"));
      if (taskHash && childHash !== taskHash) refuse(`Child inbox contains a conflicting immutable task '${taskId}'.`);
      childAction = "already-delivered";
    } else {
      const temporary = `${childTaskDirectory}.tmp-${guidN()}`;
      try {
        await mkdir13(temporary, { recursive: true });
        for (const name of ["task.json", "task.md", "task.sha256"]) {
          await copyItem(path22.join(controlTaskDirectory, name), path22.join(temporary, name));
        }
        await mkdir13(path22.dirname(childTaskDirectory), { recursive: true });
        if (await exists7(childTaskDirectory)) refuse(`Cannot create a file when that file already exists: ${childTaskDirectory}`);
        await moveItem(temporary, childTaskDirectory);
      } finally {
        await removeQuietly(temporary);
      }
      childAction = "delivered";
    }
    const model = executionProfile ? executionProfile.model : null;
    const effort = executionProfile ? executionProfile.reasoningEffort : null;
    output.host(`task_id: ${taskId}`);
    output.host(`task_contract_version: ${version2}`);
    output.host(`task_control_action: ${controlAction}`);
    output.host(`task_child_action: ${childAction}`);
    output.host("task_open_action: not-requested");
    output.host(`task_execution_adapter: ${source.executionAdapter}`);
    output.host(`task_execution_model: ${model ?? "inherit-ui"}`);
    output.host(`task_execution_effort: ${effort ?? "inherit-ui"}`);
    output.host("task_agent_turn_started: false");
    return {
      SourceId: sourceId,
      TaskId: taskId,
      ContractVersion: version2,
      DefinitionSha256: definitionHash,
      TaskSha256: taskHash,
      ControlTaskDirectory: controlTaskDirectory,
      ChildTaskDirectory: childTaskDirectory,
      ControlAction: controlAction,
      ChildAction: childAction,
      OpenAction: "not-requested",
      ExecutionAdapter: source.executionAdapter,
      ExecutionState: "awaiting-child-agent-acceptance",
      AgentTurnStarted: false,
      ExecutionModel: model,
      ExecutionEffort: effort
    };
  });
}
async function resolveInsideRoot(root, relativePath) {
  if (isPathRooted(relativePath) || String(relativePath).split(/[\\/]/u).includes("..")) {
    refuse(`Unsafe child kit path '${relativePath}'.`);
  }
  const resolvedRoot = fullPath(root).replace(/[\\/]+$/u, "");
  const candidate = path22.resolve(resolvedRoot, relativePath);
  if (!startsInside(candidate, resolvedRoot)) refuse(`Child kit path escaped its root: '${relativePath}'.`);
  for (let ancestor = candidate; ; ancestor = path22.dirname(ancestor)) {
    const info = await lstat14(ancestor).catch(() => null);
    if (info?.isSymbolicLink()) refuse(`Child kit path contains a reparse point: '${relativePath}'.`);
    if (path22.dirname(ancestor) === ancestor) break;
  }
  return candidate;
}
async function writeUtf8Atomic(file, textValue) {
  await mkdir13(path22.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${guidN()}.tmp`;
  try {
    await writeTextUtf8NoBom(temporary, textValue);
    await moveItem(temporary, file, { force: true });
  } finally {
    await removeQuietly(temporary);
  }
}
var upperHash = async (file) => (await sha256File2(file)).toUpperCase();
async function installChildCoordinationKit(parameters, { output }) {
  const sourceId = psString(parameters.SourceId);
  if (!parameters.SourceId) refuse("Cannot process command because of one or more missing mandatory parameters: SourceId.");
  if (!netMatch(SOURCE_ID_PATTERN, sourceId)) {
    refuse(`Cannot validate argument on parameter 'SourceId'. The argument "${sourceId}" does not match the "${SOURCE_ID_PATTERN}" pattern. Supply an argument that matches "${SOURCE_ID_PATTERN}" and try the command again.`);
  }
  if (parameters.WorkspaceRoot || parameters.CoordinationProfile || parameters.ExpectedKitManifestSha256) {
    refuse("The unregistered selection mode is not available for a desk agent.", "desk_task_input_invalid");
  }
  const planOnly = psBool(parameters.PlanOnly);
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  return withToolRun({
    root,
    toolName: "install_child_coordination_kit",
    output,
    parameters: { SourceId: sourceId, SelectionMode: "Registered" }
  }, async () => {
    const registry = await readJson4(path22.join(root, "config", "source-registry.json"));
    const bindings = await readJson4(path22.join(root, ".project-local", "source-bindings.json"));
    const sources = psArray(registry.sources).filter((source2) => psEquals(property(source2, "id"), sourceId));
    if (sources.length !== 1) refuse(`Source '${sourceId}' must occur exactly once in the controller registry.`);
    const source = sources[0];
    const bindingKey = Object.keys(bindings.sources ?? {}).find((key) => key.toLowerCase() === sourceId.toLowerCase());
    if (bindingKey === void 0) refuse(`Source '${sourceId}' has no machine-local binding.`);
    const binding = bindings.sources[bindingKey];
    let workspaceText = psString(property(binding, "workspacePath"));
    if (isNullOrWhiteSpace(workspaceText)) workspaceText = psString(property(binding, "path"));
    if (isNullOrWhiteSpace(workspaceText)) refuse(`Source '${sourceId}' binding has no workspace path.`);
    const workspaceRoot = fullPath(workspaceText);
    if (!await isDirectory(workspaceRoot)) refuse(`Source '${sourceId}' workspace does not exist.`);
    const versionPath = await resolveInsideRoot(workspaceRoot, "project-version.json");
    const versionBefore = await readFile14(versionPath);
    const projectVersion = JSON.parse(await readAllText(versionPath));
    await resolveInsideRoot(workspaceRoot, ".orchestrator/contract.json");
    await resolveInsideRoot(workspaceRoot, ".orchestrator/kit-manifest.json");
    const kitRoot = path22.join(root, "coordination", "child-agent-kit");
    const manifestPath = path22.join(kitRoot, "kit-manifest.json");
    const manifest = await readJson4(manifestPath);
    if (Number(manifest.schemaVersion) !== 1 || psArray(manifest.files).length === 0 || !truthy(manifest.profiles) || !truthy(manifest.componentVersions)) {
      refuse("Child coordination kit manifest is incompatible.");
    }
    let profileId = hasProperty(source, "coordinationProfile") ? psString(property(source, "coordinationProfile")) : null;
    if (isNullOrWhiteSpace(profileId) && psEquals(property(source, "executionAdapter"), "claude-code-workspace-handoff-v1")) {
      profileId = "claude-handoff";
    }
    if (isNullOrWhiteSpace(profileId) || psEquals(profileId, "codex")) {
      refuse(
        "The Codex coordination profile left the product; the source needs a Claude Code profile.",
        "desk_task_route_unsupported"
      );
    }
    if (!hasProperty(manifest.profiles, profileId)) refuse(`Child coordination profile '${profileId}' is unavailable.`);
    if (psEquals(profileId, "foreign-provider-handoff")) {
      refuse("The foreign provider profile is installed by the controller's PowerShell tool.", "desk_task_route_unsupported");
    }
    const profile = property(manifest.profiles, profileId);
    const sourceExecutorState = hasProperty(source, "executorState") ? psString(property(source, "executorState")) : null;
    if (sourceExecutorState && !psEquals(sourceExecutorState, property(profile, "executorState"))) {
      refuse(`Source executor state does not match coordination profile '${profileId}'.`);
    }
    const excluded = [...psArray(manifest.commonExcludedFiles), ...psArray(property(profile, "excludedFiles"))].map(psString);
    const selected = psArray(manifest.files).filter((file) => !psIn(psString(file), excluded));
    const copies = [];
    for (const relative of selected) {
      const portable = psString(relative).replaceAll("/", "\\");
      const sourcePath = await resolveInsideRoot(kitRoot, portable.replaceAll("\\", path22.sep));
      const destinationPath = await resolveInsideRoot(workspaceRoot, portable.replaceAll("\\", path22.sep));
      if (!await isFile(sourcePath)) refuse(`Child kit source is missing: ${psString(relative)}`);
      copies.push({ relative: psString(relative), source: sourcePath, destination: destinationPath });
    }
    const apply = !planOnly;
    let backupRoot = null;
    if (apply) {
      backupRoot = path22.join(root, ".project-local", "child-kit-backups", sourceId, guidN());
      const backupEntries = [];
      for (const relative of [
        ...copies.map((copy) => copy.relative),
        "project-version.json",
        ".orchestrator/contract.json",
        ".orchestrator/kit-manifest.json"
      ]) {
        const original = await resolveInsideRoot(workspaceRoot, relative);
        if (!await isFile(original)) continue;
        const saved = await resolveInsideRoot(backupRoot, relative);
        await mkdir13(path22.dirname(saved), { recursive: true });
        await copyItem(original, saved);
        const originalHash = await sha256File2(original);
        if (await sha256File2(saved) !== originalHash) refuse(`Child kit backup verification failed: ${relative}`);
        backupEntries.push({ path: relative, sha256: originalHash });
      }
      await writeUtf8Atomic(path22.join(backupRoot, "backup.json"), `${psJson({
        schemaVersion: 1,
        sourceId,
        workspaceRoot,
        kitVersion: psString(manifest.kitVersion),
        files: backupEntries
      })}
`);
    }
    let copied = 0;
    let unchanged = 0;
    const deferred = [];
    for (const copy of copies) {
      const sourceHash = await upperHash(copy.source);
      const destinationHash = await isFile(copy.destination) ? await upperHash(copy.destination) : null;
      if (sourceHash === destinationHash) {
        unchanged += 1;
        continue;
      }
      if (apply) {
        await mkdir13(path22.dirname(copy.destination), { recursive: true });
        const temporary = `${copy.destination}.${process.pid}.tmp`;
        try {
          await copyItem(copy.source, temporary);
          if (await upperHash(temporary) !== sourceHash) refuse(`Child kit copy hash mismatch: ${copy.relative}`);
          await moveItem(temporary, copy.destination, { force: true });
        } finally {
          await removeQuietly(temporary);
        }
        copied += 1;
      } else deferred.push(copy.destination);
    }
    if (!hasProperty(projectVersion, "componentVersions")) projectVersion.componentVersions = {};
    let versionChanged = false;
    for (const [name, value] of Object.entries(manifest.componentVersions)) {
      const versions = projectVersion.componentVersions;
      const key = Object.keys(versions).find((item) => item.toLowerCase() === name.toLowerCase());
      if (key === void 0 || !psEquals(versions[key], value)) {
        versions[key ?? name] = psString(value);
        versionChanged = true;
      }
    }
    let versionUpdateApplied = false;
    if (versionChanged && apply) {
      if (!(await readFile14(versionPath)).equals(versionBefore)) {
        refuse("Owner project version changed during kit installation; inspect the preserved backup before recovery.");
      }
      await writeUtf8Atomic(versionPath, `${psJson(projectVersion)}
`);
      versionUpdateApplied = true;
    }
    const contract = {
      schemaVersion: 1,
      sourceId,
      kitVersion: psString(manifest.kitVersion),
      kitProfile: profileId,
      executorState: psString(property(profile, "executorState")),
      taskContractVersion: psString(manifest.taskContractVersion),
      supportedTaskContractVersions: psArray(manifest.supportedTaskContractVersions),
      reportContractVersion: psString(manifest.reportContractVersion),
      taskInbox: psString(property(source, "taskInbox")),
      reportOutbox: psString(property(source, "reportOutbox")),
      coordinatorId: COORDINATOR_ID
    };
    const contractPath = path22.join(workspaceRoot, ".orchestrator", "contract.json");
    const childManifestPath = path22.join(workspaceRoot, ".orchestrator", "kit-manifest.json");
    const expectedManifestSha256 = await sha256File2(manifestPath);
    const desiredCanonical = psJson(contract, { compress: true });
    const existingCanonical = await isFile(contractPath) ? psJson(await readJson4(contractPath), { compress: true }) : null;
    const contractChanged = existingCanonical === null || !psEquals(existingCanonical, desiredCanonical);
    const manifestChanged = !await isFile(childManifestPath) || await sha256File2(childManifestPath) !== expectedManifestSha256;
    let contractApplied = !contractChanged;
    let manifestApplied = !manifestChanged;
    if (contractChanged && apply) {
      await writeUtf8Atomic(contractPath, `${psJson(contract)}
`);
      contractApplied = true;
    }
    if (manifestChanged && apply) {
      const temporary = `${childManifestPath}.${process.pid}.${guidN()}.tmp`;
      try {
        await copyItem(manifestPath, temporary);
        if (await sha256File2(temporary) !== expectedManifestSha256) refuse("Copied child kit manifest hash mismatch.");
        await moveItem(temporary, childManifestPath, { force: true });
      } finally {
        await removeQuietly(temporary);
      }
      manifestApplied = true;
    }
    if (contractApplied && !psEquals(psJson(await readJson4(contractPath), { compress: true }), desiredCanonical)) {
      refuse("Installed child coordination contract failed verification.");
    }
    if (manifestApplied && await sha256File2(childManifestPath) !== expectedManifestSha256) {
      refuse("Installed child kit manifest failed verification.");
    }
    for (const copy of copies) {
      if (deferred.includes(copy.destination)) continue;
      if (await upperHash(copy.source) !== await upperHash(copy.destination)) {
        refuse(`Installed child kit failed verification: ${copy.relative}`);
      }
    }
    output.host(`child_source_id: ${sourceId}`);
    output.host(`child_kit_version: ${psString(manifest.kitVersion)}`);
    output.host(`child_kit_profile: ${profileId}`);
    output.host(`child_executor_state: ${psString(property(profile, "executorState"))}`);
    output.host(`child_kit_files: ${copies.length}`);
    output.host(`child_kit_copied: ${copied}`);
    output.host(`child_kit_unchanged: ${unchanged}`);
    return {
      SourceId: sourceId,
      SelectionMode: "Registered",
      BackupRoot: backupRoot,
      ProviderStarted: false,
      RegistrationChanged: false,
      WorkspaceRoot: workspaceRoot,
      KitVersion: psString(manifest.kitVersion),
      KitProfile: profileId,
      ExecutorState: psString(property(profile, "executorState")),
      FileCount: copies.length,
      CopiedCount: copied,
      UnchangedCount: unchanged,
      DeferredCount: deferred.length,
      ComponentVersionsUpdated: versionUpdateApplied,
      ContractUpdated: contractChanged && contractApplied,
      ManifestUpdated: manifestChanged && manifestApplied,
      ContractPath: contractPath,
      ManifestSha256: expectedManifestSha256
    };
  });
}
var CONTROLLER_TOOLS = Object.freeze({
  dispatch_child_task: dispatchChildTask,
  install_child_coordination_kit: installChildCoordinationKit
});

// orchestrator/src/desk-agent-sources.mjs
var DESK_AGENT_FOLDER = path23.join(".project-local", "desk-agents");
function fail19(code) {
  throw Object.assign(new Error(code), { code });
}
var sha2568 = (value) => createHash16("sha256").update(value).digest("hex");
function deskAgentSourceId(agentId) {
  if (typeof agentId !== "string" || !agentId) fail19("desk_source_agent_invalid");
  return /^[a-z0-9][a-z0-9-]{0,47}$/u.test(agentId) ? `desk-${agentId}` : `desk-${sha2568(agentId).slice(0, 16)}`;
}
async function readJson5(file, fallback = void 0) {
  let text3;
  try {
    text3 = await readFile15(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== void 0) return structuredClone(fallback);
    throw error;
  }
  return JSON.parse(text3);
}
async function readDeskAgentSource({ controllerRoot, agentId }) {
  const root = path23.resolve(controllerRoot);
  const sourceId = deskAgentSourceId(agentId);
  const registry = await readJson5(path23.join(root, "config", "source-registry.json"), { schemaVersion: 2, sources: [] });
  const source = (registry.sources ?? []).find((item) => item?.id === sourceId && item.deskAgentId === agentId);
  if (!source) return null;
  const folder = path23.join(root, DESK_AGENT_FOLDER, sourceId);
  try {
    await validateDeskAgentSource(source, folder);
  } catch {
    return null;
  }
  const bindings = await readJson5(path23.join(root, ".project-local", "source-bindings.json"), { sources: {} });
  const projectFolder = bindings.sources?.[sourceId]?.sourcePath ?? null;
  return { sourceId, agentId, folder, projectFolder: typeof projectFolder === "string" ? projectFolder : null };
}

// orchestrator/src/desk-task-index.mjs
import path24 from "node:path";
var DESK_TASK_RETURNS_DIRECTORY = path24.join(".project-local", "orchestration", "desk-task-returns");
var MAX_RECORD_BYTES2 = 1024 * 1024;

// orchestrator/src/world-task-board.mjs
var TASK_BOARD_LIMITS = Object.freeze({ sources: 128, tasks: 200, tasksPerSource: 512, text: 400 });
var TASK_STAGES2 = Object.freeze([
  "dispatched",
  "started",
  "accepted",
  "planned",
  "in-progress",
  "reported",
  "accepted-by-code",
  "declined"
]);
var TASK_ID = /^[a-z0-9][a-z0-9.-]{2,95}$/u;
var ID9 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var MAX_FILE_BYTES = 1024 * 1024;
var IMPLEMENTING = /* @__PURE__ */ new Set(["implementation", "validation", "reporting", "complete"]);
var PLANNING = /* @__PURE__ */ new Set(["planning", "awaiting_confirmation"]);
var WORKING_STATES = /* @__PURE__ */ new Set([
  "running",
  "in_progress",
  "working",
  "validating",
  "completed",
  "failed",
  "blocked",
  "cancelling",
  "cancelled"
]);
function fail20(code) {
  throw Object.assign(new Error(code), { code });
}
async function readBounded(file) {
  const info = await lstat16(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
  return readFile16(file).catch(() => null);
}
async function readJson6(file) {
  const bytes = await readBounded(file);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8").replace(/^﻿/u, ""));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
var sha2569 = (bytes) => createHash17("sha256").update(bytes).digest("hex");
var text = (value, limit = TASK_BOARD_LIMITS.text) => typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, limit) : null;
var token = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value) ? value : null;
var time = (value) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
var integer = (value) => Number.isSafeInteger(value) ? value : null;
function taskStageOf(task) {
  if (task.acknowledgement !== null && task.acknowledgement.decision !== "accepted" || task.start?.declined === true) {
    return "declined";
  }
  if (task.acceptance !== null) return "accepted-by-code";
  if (task.report !== null) return "reported";
  const progress = task.progress;
  if (progress !== null) {
    if (IMPLEMENTING.has(progress.lifecycleStage)) return "in-progress";
    if (PLANNING.has(progress.lifecycleStage) || ["awaiting_confirmation", "confirmed"].includes(progress.planStatus)) {
      return "planned";
    }
    if (progress.lifecycleStage === null && WORKING_STATES.has(progress.state)) return "in-progress";
  }
  if (task.acknowledgement !== null || progress !== null) return "accepted";
  if (task.start !== null) return "started";
  return "dispatched";
}
async function readSources(root) {
  const registry = await readJson6(path25.join(root, "config", "source-registry.json"));
  const entries = Array.isArray(registry?.sources) ? registry.sources : [];
  const sources = [];
  for (const entry of entries) {
    if (sources.length >= TASK_BOARD_LIMITS.sources) break;
    if (typeof entry?.deskAgentId !== "string" || !ID9.test(entry.deskAgentId) || typeof entry.id !== "string") continue;
    const found = await readDeskAgentSource({ controllerRoot: root, agentId: entry.deskAgentId }).catch(() => null);
    sources.push({
      agentId: entry.deskAgentId,
      sourceId: entry.id,
      valid: found !== null && found.sourceId === entry.id
    });
  }
  return sources;
}
async function readTask(root, source, taskId) {
  const folder = path25.join(root, DESK_AGENT_FOLDER, source.sourceId, ".orchestrator");
  const inboxBytes = await readBounded(path25.join(folder, "tasks", "inbox", taskId, "task.json"));
  if (inboxBytes === null) return null;
  let packet;
  try {
    packet = JSON.parse(inboxBytes.toString("utf8").replace(/^﻿/u, ""));
  } catch {
    return null;
  }
  if (packet?.taskId !== taskId) return null;
  const dispatchedBytes = await readBounded(path25.join(root, "coordination", "tasks", "dispatched", taskId, "task.json"));
  const acknowledgement = await readJson6(path25.join(folder, "tasks", "acknowledged", `${taskId}.json`));
  const progress = await readJson6(path25.join(folder, "progress", "outbox", taskId, "progress.json"));
  const report = await readJson6(path25.join(folder, "reports", "outbox", taskId, "report.json"));
  const returned = await readJson6(path25.join(root, DESK_TASK_RETURNS_DIRECTORY, `${taskId}.json`));
  const start = returned !== null && returned.agentId === source.agentId ? returned : null;
  const acceptanceFile = await readJson6(path25.join(
    root,
    "coordination",
    "acceptances",
    source.sourceId,
    taskId,
    "acceptance.json"
  ));
  const recorded = start?.operationResult?.acceptance ?? null;
  const acceptance = acceptanceFile !== null && acceptanceFile.taskId === taskId ? { result: token(acceptanceFile.result), evaluatedAtUtc: time(acceptanceFile.evaluatedAtUtc) } : recorded !== null && typeof recorded === "object" ? { result: "passed", evaluatedAtUtc: null } : null;
  const decision = start?.operationResult?.decision ?? null;
  const definition = await lstat16(path25.join(root, ".project-local", "desk-coordinator", "definitions", `${taskId}.json`)).catch(() => null);
  const task = {
    taskId,
    title: text(packet.title, 200),
    sourceId: source.sourceId,
    agentId: source.agentId,
    contractVersion: token(packet.contractVersion),
    priority: token(packet.priority),
    dispatchedAtUtc: time(packet.dispatchedAtUtc),
    verified: dispatchedBytes !== null && sha2569(dispatchedBytes) === sha2569(inboxBytes),
    dispatchedByCoordinator: definition?.isFile() === true,
    start: start === null ? null : {
      startedAtUtc: time(start.startedAtUtc),
      coordinatorAgentId: typeof start.coordinatorAgentId === "string" && ID9.test(start.coordinatorAgentId) ? start.coordinatorAgentId : null,
      reportOperation: token(start.reportOperation),
      continuationPolicy: token(start.continuationPolicy),
      returnState: token(start.returnState),
      declined: start.declined !== void 0 && start.declined !== null
    },
    acknowledgement: acknowledgement === null || acknowledgement.taskId !== taskId ? null : {
      decision: token(acknowledgement.decision),
      reason: text(acknowledgement.reason),
      acknowledgedAtUtc: time(acknowledgement.acknowledgedAtUtc)
    },
    progress: progress === null || progress.taskId !== taskId ? null : {
      state: token(progress.state),
      lifecycleStage: token(progress.workflow?.lifecycleStage ?? progress.lifecycleStage ?? null),
      planStatus: token(progress.workflow?.plan?.status ?? null),
      planRevision: integer(progress.workflow?.plan?.revision ?? null),
      now: text(progress.summary?.now, 200),
      updatedAtUtc: time(progress.updatedAtUtc)
    },
    report: report === null || report.taskId !== taskId ? null : {
      status: token(report.status),
      summary: text(report.summary),
      reportedAtUtc: time(report.reportedAtUtc)
    },
    acceptance,
    review: decision === null || typeof decision !== "object" ? null : { outcome: token(decision.outcome) }
  };
  return { ...task, stage: taskStageOf(task) };
}
async function readWorldTaskBoard({ controllerRoot, agentId = null }) {
  if (typeof controllerRoot !== "string" || !path25.isAbsolute(controllerRoot)) fail20("memory_invalid_input");
  if (agentId !== null && (typeof agentId !== "string" || !ID9.test(agentId))) fail20("memory_invalid_input");
  const root = path25.resolve(controllerRoot);
  const sources = await readSources(root);
  const tasks = [];
  let truncated = false;
  for (const source of sources) {
    if (agentId !== null && source.agentId !== agentId) continue;
    const inbox = path25.join(root, DESK_AGENT_FOLDER, source.sourceId, ".orchestrator", "tasks", "inbox");
    const names = (await readdir9(inbox, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && TASK_ID.test(entry.name)).map((entry) => entry.name).sort();
    if (names.length > TASK_BOARD_LIMITS.tasksPerSource) truncated = true;
    for (const taskId of names.slice(-TASK_BOARD_LIMITS.tasksPerSource)) {
      const task = await readTask(root, source, taskId);
      if (task !== null) tasks.push(task);
    }
  }
  for (const index of await readWorldTaskIndexes(root).catch(() => [])) {
    for (const entry of index.sources) {
      const listed = sources.find((source) => source.sourceId === entry.sourceId);
      if (listed) listed.availability = "not-here";
      else if (sources.length < TASK_BOARD_LIMITS.sources && entry.agentId && entry.sourceId) {
        sources.push({ agentId: entry.agentId, sourceId: entry.sourceId, valid: false, availability: "not-here" });
      }
    }
    for (const entry of index.tasks) {
      if (agentId !== null && entry.agentId !== agentId) continue;
      if (!TASK_ID.test(entry.taskId ?? "") || tasks.some((task) => task.taskId === entry.taskId)) continue;
      tasks.push({
        taskId: entry.taskId,
        title: null,
        sourceId: entry.sourceId,
        agentId: entry.agentId,
        contractVersion: null,
        priority: null,
        dispatchedAtUtc: time(entry.dispatchedAtUtc),
        verified: false,
        dispatchedByCoordinator: false,
        start: null,
        acknowledgement: null,
        progress: null,
        report: null,
        acceptance: null,
        review: null,
        stage: TASK_STAGES2.includes(entry.stage) ? entry.stage : "dispatched",
        availability: "not-here",
        projectTitle: text(index.title, 200)
      });
    }
  }
  tasks.sort((left, right) => String(right.dispatchedAtUtc ?? "").localeCompare(String(left.dispatchedAtUtc ?? "")) || left.taskId.localeCompare(right.taskId));
  if (tasks.length > TASK_BOARD_LIMITS.tasks) truncated = true;
  return { schemaVersion: 1, sources, tasks: tasks.slice(0, TASK_BOARD_LIMITS.tasks), truncated };
}

// orchestrator/src/project-mount.mjs
function fail21(code, detail) {
  throw new ProjectPackageError(code, detail);
}
async function removeEmptyParents(file, stopAt) {
  let folder = path26.dirname(file);
  const stops = new Set(stopAt.map((item) => path26.resolve(item).toLowerCase()));
  while (!stops.has(path26.resolve(folder).toLowerCase())) {
    const entries = await readdir10(folder).catch(() => null);
    if (entries === null || entries.length > 0) return;
    await rmdir(folder).catch(() => {
    });
    folder = path26.dirname(folder);
  }
}
async function holdsFiles(folder) {
  for (const entry of await readdir10(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || await holdsFiles(path26.join(folder, entry.name))) return true;
  }
  return false;
}
var documentValue = (files, key) => {
  const text3 = files.get("memory/documents.jsonl")?.toString("utf8") ?? "";
  for (const line of text3.split("\n")) {
    if (line === "") continue;
    const record = JSON.parse(line);
    if (record.key === key) return record.value;
  }
  return null;
};
async function interactionStoresOf(root, threadIds) {
  const base = path26.join(root, ".project-local", "orchestration", "provider-interactions");
  const found = [];
  for (const entry of await readdir10(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const records = path26.join(base, entry.name, "records.v1");
    let mine = false;
    let open4 = false;
    for (const name of await readdir10(records).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      let record;
      try {
        record = JSON.parse(await readFile17(path26.join(records, name), "utf8"));
      } catch {
        fail21("unmount_interaction_unreadable", path26.join(records, name));
      }
      if (!threadIds.has(record?.providerRequest?.threadId)) continue;
      mine = true;
      if (record.state !== "resolved") open4 = true;
    }
    if (mine) found.push({ folder: path26.join(base, entry.name), open: open4 });
  }
  return found;
}
var jsonLinesOf = (files, name) => (files.get(name)?.toString("utf8") ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
var packageSummary = (files, projectId, tasks) => projectSummary({
  projectId,
  agents: documentValue(files, "memory-agents-v1")?.agents ?? [],
  scopes: jsonLinesOf(files, "memory/scopes.jsonl"),
  archive: documentValue(files, "memory-project-archive-v1"),
  tasks
});
async function unmountProject({
  controllerRoot,
  projectId,
  out,
  confirm,
  now = () => /* @__PURE__ */ new Date(),
  policy = null,
  claudeConfigDir,
  dshHome
}) {
  if (confirm !== projectId) fail21("unmount_confirmation_required", projectId);
  if (projectId === WORLD_PROJECT_ID) fail21("unmount_world_refused");
  const root = await realpath10(controllerRoot);
  if ((await resolveStoreLayout(root, { env: {} })).layout !== "split") fail21("store_layout_single", "migrate the instance first");
  const folder = await projectStoreFolder(root, projectId);
  if (folder === null) fail21("project_not_mounted", projectId);
  const board = await readWorldTaskBoard({ controllerRoot: root });
  const exported = await exportProject({ controllerRoot: root, projectId, out, now, policy, claudeConfigDir, dshHome });
  const { manifest, files } = await readProjectPackage(out);
  const catalog = documentValue(files, "memory-agents-v1")?.agents ?? [];
  const agents = catalog.map((agent) => agent.agentId);
  const interactions = await interactionStoresOf(
    root,
    new Set(catalog.map((agent) => agent.binding?.threadId).filter((threadId) => typeof threadId === "string"))
  );
  if (interactions.some((store) => store.open)) fail21("unmount_interactions_open", projectId);
  const paths = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  const removals = [];
  for (const [name, content] of files) {
    const target = packagePlacement(name, paths);
    if (target === null) continue;
    const present = await readFile17(target).catch(() => null);
    if (present === null || !present.equals(content)) fail21("unmount_file_changed", target);
    removals.push(target);
  }
  const archived = documentValue(files, "memory-project-archive-v1");
  const sources = new Set(agents.map(deskSourceIdOf));
  await recordWorldProjects(root, [{
    projectId,
    title: manifest.title,
    policy: manifest.policy,
    archived: Object.hasOwn(archived?.projects ?? {}, projectId),
    location: { machineId: null, atUtc: now().toISOString() },
    summary: packageSummary(files, projectId, board.tasks.filter((task) => sources.has(task.sourceId)))
  }]);
  await writeWorldTaskIndex(root, projectId, {
    sources: board.sources.filter((source) => sources.has(source.sourceId)),
    tasks: board.tasks.filter((task) => sources.has(task.sourceId))
  });
  await rm9(folder, { recursive: true, force: true });
  const bases = [
    paths.claudeSessions,
    paths.acpSessions,
    path26.join(paths.claudeConfigDir, "projects"),
    path26.join(paths.dshHome, "sessions"),
    path26.join(paths.dshHome, "storages", "session_projcache", "sessions"),
    paths.deskAgents,
    paths.dispatched,
    paths.definitions,
    paths.returns,
    paths.reports,
    paths.acceptances
  ];
  const anchors = /* @__PURE__ */ new Set();
  for (const target of removals) {
    await rm9(target, { force: true });
    const base = bases.find((item) => !path26.relative(item, target).startsWith("..") && !path26.isAbsolute(path26.relative(item, target)));
    if (base !== void 0) {
      const parts = path26.relative(base, target).split(path26.sep);
      if (parts.length > 1) anchors.add(path26.join(base, parts[0]));
      if (parts.length > 2) anchors.add(path26.join(base, parts[0], parts[1]));
    }
    await removeEmptyParents(target, bases);
  }
  for (const anchor of [...anchors].sort((a, b) => b.length - a.length)) {
    if (!await holdsFiles(anchor)) await rm9(anchor, { recursive: true, force: true });
  }
  for (const sourceId of sources) await rm9(path26.join(paths.deskAgents, sourceId), { recursive: true, force: true });
  for (const store of interactions) await rm9(store.folder, { recursive: true, force: true });
  return {
    projectId,
    package: out,
    revision: exported.revision,
    removedFiles: removals.length,
    removedInteractionStores: interactions.length,
    tasksIndexed: board.tasks.filter((task) => sources.has(task.sourceId)).length
  };
}
async function mountProject({ controllerRoot, packageDir, claudeConfigDir, dshHome, now = () => /* @__PURE__ */ new Date() }) {
  const root = await realpath10(controllerRoot);
  const imported = await importProject({ controllerRoot: root, packageDir, claudeConfigDir, dshHome });
  const { manifest, files } = await readProjectPackage(packageDir);
  const archived = documentValue(files, "memory-project-archive-v1");
  const sources = new Set((documentValue(files, "memory-agents-v1")?.agents ?? []).filter((agent) => agent.projectId === manifest.projectId).map((agent) => deskSourceIdOf(agent.agentId)));
  const board = await readWorldTaskBoard({ controllerRoot: root });
  const machine = await readThisMachine(root);
  await recordWorldProjects(root, [{
    projectId: manifest.projectId,
    title: manifest.title,
    policy: manifest.policy,
    archived: Object.hasOwn(archived?.projects ?? {}, manifest.projectId),
    location: machine === null ? null : { machineId: machine.machineId, atUtc: now().toISOString() },
    summary: packageSummary(files, manifest.projectId, board.tasks.filter((task) => sources.has(task.sourceId)))
  }]);
  await removeWorldTaskIndex(root, manifest.projectId);
  return imported;
}

// orchestrator/src/sync-git.mjs
import { execFile } from "node:child_process";
var MAX_OUTPUT = 16 * 1024 * 1024;
function fail22(code, detail) {
  throw new ProjectPackageError(code, detail);
}
function git(cwd, args, { timeoutMs = 18e4, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C" }
    }, (error, stdout, stderr) => {
      const code = error ? typeof error.code === "number" ? error.code : -1 : 0;
      if (code !== 0 && !allowFail) {
        const line = String(stderr || error?.message || "").trim().split(/\r?\n/u).at(-1) ?? "";
        reject(new ProjectPackageError("sync_git_failed", `git ${args[0]}: ${line.slice(0, 300)}`));
        return;
      }
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
async function isRepo(dir) {
  const result = await git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true }).catch(() => ({ code: 1 }));
  return result.code === 0;
}
async function ensureRepo(dir, { branch, author, remotes }) {
  if (!await isRepo(dir)) await git(dir, ["init", "-b", branch]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await git(dir, ["config", "core.safecrlf", "false"]);
  await git(dir, ["config", "user.name", author.name]);
  await git(dir, ["config", "user.email", author.email]);
  const present = new Set((await git(dir, ["remote"])).stdout.split(/\r?\n/u).filter(Boolean));
  for (const remote of remotes) {
    if (present.has(remote.name)) await git(dir, ["remote", "set-url", remote.name, remote.url]);
    else await git(dir, ["remote", "add", remote.name, remote.url]);
  }
}
async function fetchBranch(dir, remote, branch) {
  const listed = await git(dir, ["ls-remote", "--heads", remote, branch], { timeoutMs: 6e4 });
  if (listed.stdout.trim() === "") return false;
  await git(dir, ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  return true;
}
async function showFile(dir, ref, file) {
  const result = await git(dir, ["show", `${ref}:${file}`], { allowFail: true });
  return result.code === 0 ? result.stdout : null;
}
async function head(dir) {
  const result = await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
  return result.code === 0 ? result.stdout.trim() : null;
}
async function localChanges(dir) {
  return (await git(dir, ["status", "--porcelain", "--untracked-files=all"])).stdout.split(/\r?\n/u).filter(Boolean);
}
async function fastForward(dir, remote, branch) {
  const target = `refs/remotes/${remote}/${branch}`;
  if (await head(dir) === null) {
    await git(dir, ["checkout", "-B", branch, target]);
    return;
  }
  const merged = await git(dir, ["merge", "--ff-only", target], { allowFail: true });
  if (merged.code !== 0) fail22("sync_diverged", `${branch} of ${remote}`);
}
async function stageAll(dir) {
  await git(dir, ["add", "-A"]);
  return (await git(dir, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
}
async function commit2(dir, message) {
  const staged = (await git(dir, ["diff", "--cached", "--name-only"])).stdout.trim();
  if (staged === "") return false;
  await git(dir, ["commit", "-q", "-m", message]);
  return true;
}
async function pushAll(dir, remotes, branch) {
  const primary = remotes.find((remote) => remote.primary);
  const pushed = await git(dir, ["push", "--porcelain", primary.name, `HEAD:refs/heads/${branch}`], { allowFail: true });
  if (pushed.code !== 0) {
    if (/rejected|non-fast-forward|fetch first/iu.test(pushed.stdout + pushed.stderr)) fail22("sync_race", primary.name);
    fail22("sync_push_failed", `${primary.name}: ${(pushed.stderr.trim().split(/\r?\n/u).at(-1) ?? "").slice(0, 300)}`);
  }
  const mirrors = [];
  for (const remote of remotes.filter((item) => !item.primary)) {
    const result = await git(dir, ["push", "--porcelain", remote.name, `HEAD:refs/heads/${branch}`], { allowFail: true });
    mirrors.push({ remote: remote.name, pushed: result.code === 0 });
  }
  return { primary: primary.name, mirrors };
}
async function cloneRepo(parent, dir, primary, branch) {
  await git(parent, [
    "clone",
    "-q",
    "-c",
    "core.autocrlf=false",
    "--origin",
    primary.name,
    "--branch",
    branch,
    primary.url,
    dir
  ], { timeoutMs: 6e5 });
}

// orchestrator/src/sync-engine.mjs
var CONFIG_FILE = path27.join(".project-local", "sync.json");
var STATE_FILE = path27.join(".project-local", "sync-state.json");
var LOCK_FILE = "sync-lock.json";
var WORLD_PACKAGE = path27.join(".world", "package");
var NAME = /^[a-z][a-z0-9-]{0,31}$/u;
var ID10 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var NO_POLICY = Object.freeze({ homeOnly: false, allowedMachines: null });
function fail23(code, detail) {
  throw new ProjectPackageError(code, detail);
}
async function exists8(target) {
  return lstat17(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
async function writeJsonOver3(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID11()}.tmp`;
  await writeFile12(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename14(temporary, target);
}
function remotesOf(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) fail23("sync_config_invalid", `${label}.remotes`);
  const names = /* @__PURE__ */ new Set();
  const remotes = value.map((remote) => {
    if (!remote || typeof remote !== "object" || typeof remote.url !== "string" || remote.url.trim() === "" || typeof remote.name !== "string" || !NAME.test(remote.name) || names.has(remote.name)) {
      fail23("sync_config_invalid", `${label}.remotes`);
    }
    names.add(remote.name);
    return { name: remote.name, url: remote.url, primary: remote.primary === true, home: remote.home === true };
  });
  if (remotes.filter((remote) => remote.primary).length !== 1) fail23("sync_config_invalid", `${label}: one primary remote`);
  return remotes;
}
async function readSyncConfig(controllerRoot) {
  let value;
  try {
    value = JSON.parse(await readFile18(path27.join(controllerRoot, CONFIG_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail23("sync_config_invalid", "sync.json");
  }
  return syncConfigOf(value);
}
var INSTANCE_MODES = Object.freeze(["local", "synced"]);
async function recordedMode(root) {
  try {
    const mode = JSON.parse(await readFile18(path27.join(root, "instance.json"), "utf8"))?.mode;
    return INSTANCE_MODES.includes(mode) ? mode : null;
  } catch {
    return null;
  }
}
function syncConfigOf(value) {
  if (value?.schemaVersion !== 1) fail23("sync_config_invalid", "schemaVersion");
  const branch = value.branch ?? "main";
  if (typeof branch !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(branch)) fail23("sync_config_invalid", "branch");
  if (typeof value.packagesRoot !== "string" || !path27.isAbsolute(value.packagesRoot)) fail23("sync_config_invalid", "packagesRoot");
  if (typeof value.author?.name !== "string" || typeof value.author?.email !== "string" || value.author.name.trim() === "" || !/^[^\s@]+@[^\s@]+$/u.test(value.author.email)) {
    fail23("sync_config_invalid", "author");
  }
  const projects = {};
  for (const [projectId, entry] of Object.entries(value.projects ?? {})) {
    if (!ID10.test(projectId) || projectId === WORLD_PROJECT_ID) fail23("sync_config_invalid", `projects.${projectId}`);
    projects[projectId] = { remotes: remotesOf(entry?.remotes, projectId) };
  }
  return {
    branch,
    packagesRoot: value.packagesRoot,
    author: { name: value.author.name, email: value.author.email },
    world: { remotes: remotesOf(value.world?.remotes, "world") },
    projects
  };
}
async function syncBegun(root) {
  return await exists8(path27.join(root, STATE_FILE)) || await isRepo(root);
}
async function readSyncState(controllerRoot) {
  try {
    const value = JSON.parse(await readFile18(path27.join(controllerRoot, STATE_FILE), "utf8"));
    if (value?.schemaVersion === 1) return { world: { held: false, releasedSha256: null, ...value.world }, projects: value.projects ?? {} };
  } catch (error) {
    if (error?.code !== "ENOENT") fail23("sync_state_invalid", "sync-state.json");
  }
  return { world: { held: false, releasedSha256: null }, projects: {} };
}
async function writeSyncState(root, state) {
  await writeJsonOver3(path27.join(root, STATE_FILE), { schemaVersion: 1, ...state });
}
function lockOf(text3, label) {
  if (text3 === null) return null;
  let value;
  try {
    value = JSON.parse(text3);
  } catch {
    fail23("sync_lock_invalid", label);
  }
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !(value.holder === null || typeof value.holder === "string" && value.holder !== "")) fail23("sync_lock_invalid", label);
  return value;
}
async function remoteLock(dir, remote, branch, label) {
  return lockOf(await showFile(dir, `refs/remotes/${remote.name}/${branch}`, LOCK_FILE), label);
}
async function writeLock(dir, lock) {
  await writeFile12(path27.join(dir, LOCK_FILE), `${JSON.stringify({ schemaVersion: 1, ...lock }, null, 2)}
`, "utf8");
}
async function packageHash(dir) {
  const manifest = JSON.parse(await readFile18(path27.join(dir, "project.af.json"), "utf8"));
  return createHash18("sha256").update(canonicalJson(manifest.files ?? {})).digest("hex");
}
var SECRET_FILES = /* @__PURE__ */ new Set([".credentials.json", ".claude.json", "connection.v1.json"]);
var SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/u,
  /\bsk-[A-Za-z0-9]{32,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /"(?:accessToken|refreshToken)"\s*:\s*"[^"]{8,}"/u
];
async function scanStaged(dir, files) {
  for (const name of files) {
    if (SECRET_FILES.has(path27.basename(name))) fail23("sync_secret_found", name);
    const full = path27.join(dir, name);
    const info = await lstat17(full).catch(() => null);
    if (info === null || !info.isFile() || info.size > 32 * 1024 * 1024) continue;
    const content = await readFile18(full);
    if (content.includes(0)) continue;
    const text3 = content.toString("utf8");
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text3))) fail23("sync_secret_found", name);
  }
}
async function commitAndPush(dir, remotes, branch, message) {
  await scanStaged(dir, await stageAll(dir));
  const committed = await commit2(dir, message);
  return { committed, ...await pushAll(dir, remotes, branch) };
}
function mayHold(policy, machine) {
  if (policy.homeOnly && machine.home !== true) return false;
  if (Array.isArray(policy.allowedMachines) && !policy.allowedMachines.includes(machine.machineId)) return false;
  return true;
}
function onlyHere(policy, machine, machines) {
  if (Array.isArray(policy.allowedMachines)) return policy.allowedMachines.length === 1 && policy.allowedMachines[0] === machine.machineId;
  if (!policy.homeOnly) return false;
  return !Object.entries(machines).some(([machineId, item]) => machineId !== machine.machineId && item.home === true);
}
async function context(controllerRoot, { needGatewayStopped = true } = {}) {
  const root = await realpath11(controllerRoot);
  if (await recordedMode(root) === "local") fail23("sync_mode_local", "agents-factory instance mode --set synced");
  const config = await readSyncConfig(root);
  if (config === null) fail23("sync_not_configured", CONFIG_FILE);
  const machine = await readThisMachine(root);
  if (machine === null) fail23("sync_machine_unnamed", "agents-factory machine set");
  if (needGatewayStopped && await gatewayRunning(path27.join(root, ".project-local", "application-gateway", "status.v1.json"))) {
    fail23("gateway_running");
  }
  return { root, config, machine, machines: await readMachines(root), state: await readSyncState(root) };
}
var stamp2 = (now) => now().toISOString().replace(/[-:.]/gu, "");
var primaryOf = (remotes) => remotes.find((remote) => remote.primary);
async function recordHeldProjects(root, machine, now) {
  const sqlite = await loadNodeSqlite();
  if (sqlite === null) return [];
  const board = await readWorldTaskBoard({ controllerRoot: root });
  const entries = [];
  for (const { projectId, folder } of await mountedProjects(root)) {
    if (projectId === WORLD_PROJECT_ID) continue;
    const db = openReadOnlyDatabase(sqlite, path27.join(folder, "memory.sqlite"));
    let agents = [];
    let archive = null;
    let scopes = [];
    try {
      for (const row2 of db.prepare("SELECT key, value_json FROM memory_documents WHERE key IN ('memory-agents-v1', 'memory-project-archive-v1')").all()) {
        const value = JSON.parse(row2.value_json);
        if (row2.key === "memory-agents-v1") agents = value?.agents ?? [];
        else archive = value;
      }
      scopes = db.prepare("SELECT kind, project_id AS projectId, quarter_id AS quarterId FROM memory_scopes").all();
    } finally {
      db.close();
    }
    const sources = new Set(agents.map((agent) => deskSourceIdOf(agent.agentId)));
    entries.push({
      projectId,
      location: { machineId: machine.machineId, atUtc: now().toISOString() },
      summary: projectSummary({ projectId, agents, scopes, archive, tasks: board.tasks.filter((task) => sources.has(task.sourceId)) })
    });
  }
  if (entries.length > 0) await recordWorldProjects(root, entries);
  return entries.map((entry) => entry.projectId);
}
async function initWorld({ controllerRoot, now = () => /* @__PURE__ */ new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  await ensureRepo(root, { branch: config.branch, author: config.author, remotes: config.world.remotes });
  const primary = primaryOf(config.world.remotes);
  if (await fetchBranch(root, primary.name, config.branch)) fail23("sync_already_initialized", primary.name);
  await recordHeldProjects(root, machine, now);
  await exportProject({ controllerRoot: root, projectId: WORLD_PROJECT_ID, out: path27.join(root, WORLD_PACKAGE), now });
  const releasedSha256 = await packageHash(path27.join(root, WORLD_PACKAGE));
  await writeLock(root, { holder: machine.machineId, sequence: 1, changedAtUtc: now().toISOString(), releasedSha256 });
  const pushed = await commitAndPush(root, config.world.remotes, config.branch, `world: first push from ${machine.machineId}`);
  state.world = { held: true, releasedSha256 };
  await writeSyncState(root, state);
  return { target: "world", action: "initialized", holder: machine.machineId, ...pushed };
}
async function releaseWorld({ controllerRoot, now = () => /* @__PURE__ */ new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  await ensureRepo(root, { branch: config.branch, author: config.author, remotes: config.world.remotes });
  const primary = primaryOf(config.world.remotes);
  if (!await fetchBranch(root, primary.name, config.branch)) fail23("sync_not_initialized", "world");
  const lock = await remoteLock(root, primary, config.branch, "world");
  if (lock?.holder !== machine.machineId) fail23("sync_not_holder", lock?.holder ?? "free");
  await fastForward(root, primary.name, config.branch);
  const held = await recordHeldProjects(root, machine, now);
  await exportProject({ controllerRoot: root, projectId: WORLD_PROJECT_ID, out: path27.join(root, WORLD_PACKAGE), now });
  const releasedSha256 = await packageHash(path27.join(root, WORLD_PACKAGE));
  await writeLock(root, { holder: null, sequence: lock.sequence + 1, changedAtUtc: now().toISOString(), releasedSha256 });
  const pushed = await commitAndPush(root, config.world.remotes, config.branch, `world: released by ${machine.machineId}`);
  state.world = { held: false, releasedSha256 };
  await writeSyncState(root, state);
  return { target: "world", action: "released", sequence: lock.sequence + 1, recorded: held, ...pushed };
}
async function checkLocalWorld(root, state, incomingSha256, now) {
  const store = await projectStoreFolder(root, WORLD_PROJECT_ID);
  if (store === null) return null;
  const backup = path27.join(root, ".project-local", "backups", `take-${stamp2(now)}`, "world");
  await exportProject({ controllerRoot: root, projectId: WORLD_PROJECT_ID, out: backup, now });
  const here = await packageHash(backup);
  if (here === incomingSha256) return { backup, same: true, store };
  if (here !== state.world.releasedSha256) fail23("sync_world_changed_here", backup);
  return { backup, same: false, store };
}
async function replaceWorldStore(root, local) {
  if (local !== null && local.same) return false;
  if (local !== null) {
    const paths = await instancePaths(root, WORLD_PROJECT_ID);
    const { files } = await readProjectPackage(local.backup);
    for (const [name] of files) {
      const target = packagePlacement(name, paths);
      if (target !== null) await rm10(target, { force: true });
    }
    await rm10(local.store, { recursive: true, force: true });
  }
  await importProject({ controllerRoot: root, packageDir: path27.join(root, WORLD_PACKAGE) });
  return true;
}
async function takeWorld({ controllerRoot, now = () => /* @__PURE__ */ new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  await ensureRepo(root, { branch: config.branch, author: config.author, remotes: config.world.remotes });
  const primary = primaryOf(config.world.remotes);
  if (!await fetchBranch(root, primary.name, config.branch)) fail23("sync_not_initialized", "world");
  const lock = await remoteLock(root, primary, config.branch, "world");
  if (lock === null) fail23("sync_lock_invalid", "world: no lock");
  if (lock.holder !== null && lock.holder !== machine.machineId) fail23("sync_held_elsewhere", lock.holder);
  if (lock.holder === machine.machineId && state.world.held) return { target: "world", action: "already-held" };
  const own = `machine/${machine.machineId}.json`;
  const changes = (await localChanges(root)).filter((line) => line.slice(3).replace(/^"|"$/gu, "") !== own);
  if (changes.length > 0) fail23("sync_local_changes", changes.slice(0, 5).join("; "));
  if ((await resolveStoreLayout(root, { env: {} })).layout !== "split") {
    if (await exists8(singleMemoryDatabase(root))) fail23("store_layout_single", "migrate the instance first");
    await writeStoreLayoutMarker(root, { now });
  }
  const local = await checkLocalWorld(root, state, lock.releasedSha256, now);
  await fastForward(root, primary.name, config.branch);
  let pushed = null;
  if (lock.holder !== machine.machineId) {
    await writeLock(root, {
      holder: machine.machineId,
      sequence: lock.sequence + 1,
      changedAtUtc: now().toISOString(),
      releasedSha256: lock.releasedSha256
    });
    pushed = await commitAndPush(root, config.world.remotes, config.branch, `world: taken by ${machine.machineId}`);
  }
  const replaced = await replaceWorldStore(root, local);
  state.world = { held: true, releasedSha256: lock.releasedSha256 };
  await writeSyncState(root, state);
  return { target: "world", action: "taken", replaced, backup: local?.backup ?? null, ...pushed ?? {} };
}
async function projectPolicyOf(root, projectId) {
  return (await readWorldRegistry(root)).projects[projectId]?.policy ?? NO_POLICY;
}
function projectRemotes(config, projectId, policy) {
  const entry = config.projects[projectId];
  if (entry === void 0) fail23("sync_project_not_configured", projectId);
  if (policy.homeOnly && entry.remotes.some((remote) => !remote.home)) fail23("sync_remote_not_home", projectId);
  return entry.remotes;
}
async function pushWorkspace(root, projectId) {
  const store = await createProjectMemoryStore({ controllerRoot: root });
  let workspace;
  try {
    workspace = await readProjectWorkspace(store, { projectId });
  } finally {
    await store.close?.();
  }
  if (!workspace.configured) return { workspace: "none" };
  const folder = workspace.workspacePath;
  if (!await exists8(folder) || !await isRepo(folder)) return { workspace: "not-synced", folder };
  if ((await localChanges(folder)).length > 0) fail23("sync_workspace_not_pushed", `${folder}: uncommitted changes`);
  const upstream = await git(folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
  if (upstream.code !== 0) fail23("sync_workspace_not_pushed", `${folder}: no upstream`);
  const ahead = Number((await git(folder, ["rev-list", "--count", "@{u}..HEAD"])).stdout.trim());
  if (ahead > 0) {
    const pushed = await git(folder, ["push", "--porcelain"], { allowFail: true });
    if (pushed.code !== 0) fail23("sync_workspace_not_pushed", `${folder}: push refused`);
  }
  return { workspace: "pushed", folder, commits: ahead };
}
async function packageRepo(config, projectId, remotes) {
  const dir = path27.join(config.packagesRoot, projectId);
  await mkdir15(dir, { recursive: true });
  await ensureRepo(dir, { branch: config.branch, author: config.author, remotes });
  return dir;
}
async function releaseProject({ controllerRoot, projectId, now = () => /* @__PURE__ */ new Date() }) {
  const { root, config, machine, machines, state } = await context(controllerRoot);
  const policy = await projectPolicyOf(root, projectId);
  const remotes = projectRemotes(config, projectId, policy);
  if (await projectStoreFolder(root, projectId) === null) fail23("project_not_mounted", projectId);
  const dir = await packageRepo(config, projectId, remotes);
  const primary = primaryOf(remotes);
  const known = await fetchBranch(dir, primary.name, config.branch);
  const lock = known ? await remoteLock(dir, primary, config.branch, projectId) : null;
  if (lock?.holder && lock.holder !== machine.machineId) fail23("sync_held_elsewhere", lock.holder);
  if (known) await fastForward(dir, primary.name, config.branch);
  const stays = onlyHere(policy, machine, machines);
  let workspace = null;
  if (stays) {
    await exportProject({ controllerRoot: root, projectId, out: dir, now, policy });
  } else {
    workspace = await pushWorkspace(root, projectId);
    await unmountProject({ controllerRoot: root, projectId, out: dir, confirm: projectId, now, policy });
  }
  const releasedSha256 = await packageHash(dir);
  const sequence = (lock?.sequence ?? 0) + 1;
  await writeLock(dir, { holder: stays ? machine.machineId : null, sequence, changedAtUtc: now().toISOString(), releasedSha256 });
  const pushed = await commitAndPush(
    dir,
    remotes,
    config.branch,
    `${projectId}: ${stays ? "backup" : "released"} by ${machine.machineId}`
  );
  state.projects[projectId] = { held: stays, releasedSha256 };
  await writeSyncState(root, state);
  return { target: projectId, action: stays ? "backed-up" : "released", sequence, workspace, ...pushed };
}
async function takeProject({ controllerRoot, projectId, now = () => /* @__PURE__ */ new Date() }) {
  const { root, config, machine, state } = await context(controllerRoot);
  const policy = await projectPolicyOf(root, projectId);
  if (!mayHold(policy, machine)) fail23("sync_policy_denied", projectId);
  const remotes = projectRemotes(config, projectId, policy);
  const dir = path27.join(config.packagesRoot, projectId);
  const primary = primaryOf(remotes);
  if (!await exists8(dir)) {
    await mkdir15(config.packagesRoot, { recursive: true });
    await cloneRepo(config.packagesRoot, dir, primary, config.branch);
  }
  await ensureRepo(dir, { branch: config.branch, author: config.author, remotes });
  if (!await fetchBranch(dir, primary.name, config.branch)) fail23("sync_not_initialized", projectId);
  const lock = await remoteLock(dir, primary, config.branch, projectId);
  if (lock === null) fail23("sync_lock_invalid", `${projectId}: no lock`);
  if (lock.holder !== null && lock.holder !== machine.machineId) fail23("sync_held_elsewhere", lock.holder);
  const changes = await localChanges(dir);
  if (changes.length > 0) fail23("sync_local_changes", `${projectId}: ${changes.slice(0, 5).join("; ")}`);
  await fastForward(dir, primary.name, config.branch);
  let pushed = null;
  if (lock.holder !== machine.machineId) {
    await writeLock(dir, {
      holder: machine.machineId,
      sequence: lock.sequence + 1,
      changedAtUtc: now().toISOString(),
      releasedSha256: lock.releasedSha256
    });
    pushed = await commitAndPush(dir, remotes, config.branch, `${projectId}: taken by ${machine.machineId}`);
  }
  const mounted = await projectStoreFolder(root, projectId) !== null;
  const result = mounted ? null : await mountProject({ controllerRoot: root, packageDir: dir, now });
  state.projects[projectId] = { held: true, releasedSha256: lock.releasedSha256 };
  await writeSyncState(root, state);
  return { target: projectId, action: mounted ? "already-mounted" : "taken", mounted: result !== null, ...pushed ?? {} };
}
async function releaseAll({ controllerRoot, now = () => /* @__PURE__ */ new Date() }) {
  const { root, config } = await context(controllerRoot);
  const results = [];
  const local = [];
  for (const { projectId } of await mountedProjects(root)) {
    if (projectId === WORLD_PROJECT_ID) continue;
    if (config.projects[projectId] === void 0) {
      local.push(projectId);
      continue;
    }
    results.push(await releaseProject({ controllerRoot: root, projectId, now }));
  }
  results.push(await releaseWorld({ controllerRoot: root, now }));
  return { results, stayLocal: local };
}
async function takeAll({ controllerRoot, now = () => /* @__PURE__ */ new Date() }) {
  const results = [await takeWorld({ controllerRoot, now })];
  const { root, config, machine } = await context(controllerRoot);
  const registry = await readWorldRegistry(root);
  const skipped = [];
  for (const projectId of Object.keys(config.projects).sort()) {
    const policy = registry.projects[projectId]?.policy ?? NO_POLICY;
    if (!mayHold(policy, machine)) {
      skipped.push({ projectId, reason: "sync_policy_denied" });
      continue;
    }
    try {
      results.push(await takeProject({ controllerRoot: root, projectId, now }));
    } catch (error) {
      if (!(error instanceof ProjectPackageError) || !["sync_held_elsewhere", "sync_not_initialized"].includes(error.code)) throw error;
      skipped.push({ projectId, reason: error.code });
    }
  }
  return { results, skipped };
}
async function syncStatus({ controllerRoot, remote = false }) {
  const root = await realpath11(controllerRoot);
  const recorded = await recordedMode(root);
  const config = await readSyncConfig(root);
  if (config === null || recorded === "local") return { configured: config !== null, mode: recorded ?? "local" };
  const machine = await readThisMachine(root);
  const machines = await readMachines(root);
  const state = await readSyncState(root);
  const mounted = new Set((await mountedProjects(root)).map((project) => project.projectId));
  const registry = await readWorldRegistry(root);
  const lockAt = async (dir, remotes, label) => {
    if (!remote || !await exists8(dir) || !await isRepo(dir)) return null;
    try {
      const primary = primaryOf(remotes);
      if (!await fetchBranch(dir, primary.name, config.branch)) return { reachable: true, holder: null, initialized: false };
      const lock = await remoteLock(dir, primary, config.branch, label);
      return { reachable: true, initialized: true, holder: lock?.holder ?? null, sequence: lock?.sequence ?? null };
    } catch (error) {
      return { reachable: false, code: error?.code ?? "sync_git_failed" };
    }
  };
  const projects = [];
  for (const projectId of [.../* @__PURE__ */ new Set([...Object.keys(config.projects), ...[...mounted].filter((id5) => id5 !== WORLD_PROJECT_ID)])].sort()) {
    const policy = registry.projects[projectId]?.policy ?? NO_POLICY;
    const entry = config.projects[projectId];
    projects.push({
      projectId,
      configured: entry !== void 0,
      mounted: mounted.has(projectId),
      held: state.projects[projectId]?.held === true,
      policy,
      mayHold: machine === null ? null : mayHold(policy, machine),
      onlyHere: machine === null ? null : onlyHere(policy, machine, machines),
      remote: entry === void 0 ? null : await lockAt(path27.join(config.packagesRoot, projectId), entry.remotes, projectId)
    });
  }
  return { configured: true, mode: "synced", machine, machines, world: {
    held: state.world.held === true,
    remote: await lockAt(root, config.world.remotes, "world")
  }, projects };
}
var ownMachineFile = (machine) => `machine/${machine.machineId}.json`;
var changedPath = (line) => line.slice(3).replace(/^"|"$/gu, "");
async function lastOwnStep(dir, ref, label, machineId) {
  const steps = /* @__PURE__ */ new Map([
    [`${label}: released by ${machineId}`, "released"],
    [`${label}: taken by ${machineId}`, "taken"],
    [`${label}: backup by ${machineId}`, "backed-up"],
    [`${label}: first push from ${machineId}`, "initialized"]
  ]);
  for (const line of (await git(dir, ["log", "--format=%H%x09%s", ref])).stdout.split(/\r?\n/u)) {
    const [sha, subject] = line.split("	");
    if (steps.has(subject)) return { step: steps.get(subject), lock: lockOf(await showFile(dir, sha, LOCK_FILE), label) };
  }
  return null;
}
var countOf = async (dir, range) => Number((await git(dir, ["rev-list", "--count", range])).stdout.trim());
async function recoverTarget(ctx, target, { apply, now }) {
  const { root, config, machine, state } = ctx;
  const { dir, remotes, label, world } = target;
  const findings = [];
  const note = (kind2, detail, action, hint = null) => {
    const finding = { target: label, kind: kind2, detail, action, ...hint === null ? {} : { hint } };
    findings.push(finding);
    return finding;
  };
  const record = () => (world ? state.world : state.projects[label]) ?? { held: false, releasedSha256: null };
  const setRecord = async (value) => {
    if (world) state.world = value;
    else state.projects[label] = value;
    await writeSyncState(root, state);
  };
  if (!await exists8(dir) || !await isRepo(dir)) return findings;
  const primary = primaryOf(remotes);
  const ref = `refs/remotes/${primary.name}/${config.branch}`;
  let initialized;
  try {
    initialized = await fetchBranch(dir, primary.name, config.branch);
  } catch (error) {
    note("unreachable", `${primary.name}: ${error.message}`, null, "check the connection and run sync recover again");
    return findings;
  }
  const dirty = (await localChanges(dir)).filter((line) => !world || changedPath(line) !== ownMachineFile(machine));
  let lockRef = initialized ? ref : null;
  let unpushed = false;
  if (await head(dir) !== null) {
    const ahead = await countOf(dir, initialized ? `${ref}..HEAD` : "HEAD");
    const behind = initialized ? await countOf(dir, `HEAD..${ref}`) : 0;
    if (ahead > 0 && behind === 0) {
      unpushed = true;
      const finding = note("unpushed", `${ahead} commit(s) of this PC are not in ${primary.name}`, "push");
      if (apply) {
        finding.result = await pushAll(dir, remotes, config.branch);
        await fetchBranch(dir, primary.name, config.branch);
        lockRef = ref;
      } else {
        lockRef = "HEAD";
      }
    } else if (ahead > 0) {
      const subjects = (await git(dir, ["log", "--format=%s", `${ref}..HEAD`])).stdout.split(/\r?\n/u).filter(Boolean);
      const lost = subjects.every((subject) => subject === `${label}: taken by ${machine.machineId}`);
      if (!lost || dirty.length > 0) {
        note(
          "diverged",
          `${ahead} commit(s) here, ${behind} in ${primary.name}: ${subjects.slice(0, 3).join("; ")}`,
          null,
          "both sides hold work: settle it in git by hand, nothing was changed"
        );
        return findings;
      }
      const finding = note("lost-race", `this PC's take lost to ${primary.name}`, "drop-local");
      if (apply) {
        const kept = `refs/agents-factory/recover-${stamp2(now)}`;
        await git(dir, ["update-ref", kept, "HEAD"]);
        await git(dir, ["reset", "-q", "--keep", ref]);
        if (world && await showFile(dir, kept, ownMachineFile(machine)) !== null) {
          await git(dir, ["checkout", kept, "--", ownMachineFile(machine)]);
          await git(dir, ["reset", "-q", "--", ownMachineFile(machine)]);
        }
        finding.kept = kept;
      }
    }
  }
  const lock = lockRef === null ? null : lockOf(await showFile(dir, lockRef, LOCK_FILE), label);
  const held = record().held === true;
  const mounted = world || (await mountedProjects(root)).some((project) => project.projectId === label);
  if (!world && !mounted && dirty.length > 0 && (lock === null || lock.holder === machine.machineId)) {
    const finding = note("release-not-finished", "the project left this PC but its release was not pushed", "finish-release");
    if (apply) {
      await readProjectPackage(dir);
      await ensureRepo(dir, { branch: config.branch, author: config.author, remotes });
      const releasedSha256 = await packageHash(dir);
      await writeLock(dir, { holder: null, sequence: (lock?.sequence ?? 0) + 1, changedAtUtc: now().toISOString(), releasedSha256 });
      finding.result = await commitAndPush(dir, remotes, config.branch, `${label}: released by ${machine.machineId}`);
      await setRecord({ held: false, releasedSha256 });
    }
    return findings;
  }
  if (lock === null) return findings;
  if (dirty.length > 0 && !held) {
    const finding = note("changed-without-lock", dirty.slice(0, 5).map(changedPath).join("; "), "set-aside");
    if (apply) {
      const message = `agents-factory recover ${stamp2(now)}`;
      await git(dir, [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        message,
        "--",
        ".",
        ...world ? [`:(exclude)${ownMachineFile(machine)}`] : []
      ]);
      finding.stash = message;
    }
  }
  if (held && lock.holder !== machine.machineId) {
    const last = await lastOwnStep(dir, lockRef, label, machine.machineId);
    if (last?.step === "released" && last.lock !== null) {
      const finding = note("release-not-recorded", `${primary.name} has this PC's release; this PC still counts it held`, "record-release");
      if (apply) await setRecord({ held: false, releasedSha256: last.lock.releasedSha256 });
    } else {
      note(
        "held-elsewhere",
        `this PC counts it held, ${primary.name} names ${lock.holder ?? "nobody"}`,
        null,
        "no release of this PC explains it: ask on the other PC before changing anything"
      );
    }
  } else if (!held && lock.holder === machine.machineId) {
    const finding = note("take-not-finished", `${primary.name} names this PC, the store did not arrive`, "finish-take");
    if (apply) {
      try {
        finding.result = world ? await takeWorld({ controllerRoot: root, now }) : await takeProject({ controllerRoot: root, projectId: label, now });
      } catch (error) {
        if (!(error instanceof ProjectPackageError)) throw error;
        finding.error = error.code;
      }
      Object.assign(state, await readSyncState(root));
    }
  }
  if (unpushed) return findings;
  for (const mirror of remotes.filter((remote) => !remote.primary)) {
    let present;
    try {
      present = await fetchBranch(dir, mirror.name, config.branch);
    } catch {
      note("mirror-unreachable", mirror.name, null, "it catches up on the next push once it is reachable");
      continue;
    }
    const mirrorRef = `refs/remotes/${mirror.name}/${config.branch}`;
    if (present && await countOf(dir, `${mirrorRef}..${ref}`) === 0) continue;
    if (present && await countOf(dir, `${ref}..${mirrorRef}`) > 0) {
      note("mirror-diverged", `${mirror.name} has commits ${primary.name} lacks`, null, "the primary is the truth: compare them by hand");
      continue;
    }
    const finding = note("mirror-behind", `${mirror.name} lacks commits of ${primary.name}`, "push-mirror");
    if (apply) {
      const pushed = await git(dir, ["push", "--porcelain", mirror.name, `${ref}:refs/heads/${config.branch}`], { allowFail: true });
      finding.result = { pushed: pushed.code === 0 };
    }
  }
  return findings;
}
async function recoverSync({ controllerRoot, apply = false, now = () => /* @__PURE__ */ new Date() }) {
  const ctx = await context(controllerRoot, { needGatewayStopped: apply });
  const targets = [{ dir: ctx.root, remotes: ctx.config.world.remotes, label: WORLD_PROJECT_ID, world: true }];
  for (const projectId of Object.keys(ctx.config.projects).sort()) {
    const policy = await projectPolicyOf(ctx.root, projectId);
    let remotes;
    try {
      remotes = projectRemotes(ctx.config, projectId, policy);
    } catch (error) {
      if (!(error instanceof ProjectPackageError)) throw error;
      continue;
    }
    targets.push({ dir: path27.join(ctx.config.packagesRoot, projectId), remotes, label: projectId, world: false });
  }
  const findings = [];
  for (const target of targets) {
    try {
      findings.push(...await recoverTarget(ctx, target, { apply, now }));
    } catch (error) {
      if (!(error instanceof ProjectPackageError)) throw error;
      findings.push({ target: target.label, kind: "failed", detail: error.message, action: null, error: error.code });
    }
  }
  return {
    applied: apply,
    machineId: ctx.machine.machineId,
    findings,
    needsPerson: findings.some((finding) => finding.action === null || finding.error !== void 0)
  };
}
async function assertWorldHeld(controllerRoot) {
  const root = await realpath11(controllerRoot);
  if (await recordedMode(root) === "local" || await readSyncConfig(root) === null) return;
  if (!await syncBegun(root)) return;
  if ((await readSyncState(root)).world.held !== true) fail23("sync_world_not_held", "take the world first (agents-factory sync take)");
}

// orchestrator/src/agents-factory-gateway.mjs
var GATEWAY_PROVIDERS = Object.freeze(["claude"]);
var PROJECT_ID2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
var MONITOR_STALE_MS = 15e3;
var GATEWAY_STALE_MS = 3e4;
var SAFE_CODE = /^[a-z][a-z0-9_:-]{0,95}$/u;
function spawnDetached(file, args, { cwd, env, stdoutFile = null, stderrFile = null }) {
  const descriptors = [];
  const target = (file_) => {
    if (file_ === null) return "ignore";
    const descriptor = openSync(file_, "a");
    descriptors.push(descriptor);
    return descriptor;
  };
  try {
    const child = spawn4(file, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", target(stdoutFile), target(stderrFile)]
    });
    let exitCode = null;
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 : -1);
    });
    child.on("error", () => {
      exitCode = exitCode ?? -1;
    });
    child.unref();
    return { pid: child.pid ?? null, exitCode: () => exitCode };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}
var VISIBLE_SCRIPT = `$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath $env:AF_MONITOR_FILE -ArgumentList $env:AF_MONITOR_ARGS -WorkingDirectory $env:AF_MONITOR_CWD -PassThru
[Console]::Out.Write([string]$p.Id)`;
function visibleMonitorCommand({ file, args, cwd, env }) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return {
    file: path28.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(VISIBLE_SCRIPT, "utf16le").toString("base64")
    ],
    env: {
      ...env,
      AF_MONITOR_FILE: file,
      AF_MONITOR_ARGS: windowsCommandLine(args[0], args.slice(1)),
      AF_MONITOR_CWD: cwd
    }
  };
}
function createDefaultLauncher(executor = defaultExecutor) {
  return Object.freeze({
    spawnDetached,
    async openVisible(file, args, { cwd, env }) {
      const command = visibleMonitorCommand({ file, args, cwd, env });
      const result = await executor.run(command.file, command.args, { env: command.env, timeoutMs: 3e4 });
      const pid = Number(result.stdout.trim());
      if (result.status !== 0 || !Number.isSafeInteger(pid) || pid < 1) {
        fail("observability_unavailable", "The visible monitor window did not open");
      }
      return { pid, exitCode: () => isProcessAlive(pid) ? null : -1 };
    }
  });
}
async function readRecord(file) {
  return readJsonFile(file, { invalidCode: "gateway_runtime_record_invalid" });
}
async function readRecordOrNull(file) {
  try {
    return await readRecord(file);
  } catch {
    return null;
  }
}
async function createGatewayContext({
  layout,
  options = {},
  env = process.env,
  platform = process.platform,
  executor = defaultExecutor,
  launcher = null,
  keyStore = null
}) {
  const root = layout.instanceDir;
  if (await pathKind(root) !== "directory") {
    fail("instance_missing", `No controller instance at ${root}; run setup first`);
  }
  let projectId = options["project-id"] ?? null;
  if (projectId === null) {
    const version2 = await readJsonFile(layout.projectVersion, { invalidCode: "gateway_project_identity_unavailable" });
    projectId = typeof version2?.projectName === "string" ? version2.projectName : null;
    if (projectId === null) fail("gateway_project_identity_unavailable", "project-version.json names no project");
  }
  if (!PROJECT_ID2.test(projectId)) fail("gateway_project_identity_invalid", "The project identity is not a bounded identifier");
  const cli = await pathKind(layout.installedGatewayCli) === "file" ? layout.installedGatewayCli : await pathKind(layout.sourceGatewayCli) === "file" ? layout.sourceGatewayCli : null;
  const node = options.node ? path28.resolve(options.node) : process.execPath;
  return {
    layout,
    root,
    projectId,
    cli,
    node,
    platform,
    env,
    executor,
    launcher: launcher ?? createDefaultLauncher(executor),
    keyStore
  };
}
function requireCli(context2) {
  if (context2.cli === null) fail("gateway_cli_unavailable", "The instance has no Gateway runtime (.orchestrator/runtime/application-gateway-cli.mjs)");
  return context2.cli;
}
function failureCode(stderr) {
  for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
    try {
      const record = JSON.parse(line);
      if (record?.status === "failed" && typeof record.code === "string" && SAFE_CODE.test(record.code)) {
        return { causeCode: record.code, ...typeof record.detailCode === "string" && SAFE_CODE.test(record.detailCode) ? { detailCode: record.detailCode } : {} };
      }
    } catch {
    }
  }
  return null;
}
async function runGatewayCli(context2, command, extra = [], { timeoutMs = 9e4 } = {}) {
  const cli = requireCli(context2);
  const result = await context2.executor.run(context2.node, [
    cli,
    command,
    "--repo-root",
    context2.root,
    "--project-id",
    context2.projectId,
    "--json",
    ...extra
  ], {
    cwd: context2.root,
    timeoutMs,
    env: nodeChildEnvironment(context2.env, { nodePath: context2.node, omit: ["ANTHROPIC_API_KEY"] })
  });
  if (result.status !== 0) {
    fail(`gateway_${command.replaceAll("-", "_")}_failed`, `Gateway ${command} failed`, { detail: failureCode(result.stderr) });
  }
  try {
    return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  } catch {
    return fail(`gateway_${command.replaceAll("-", "_")}_response_invalid`, `Gateway ${command} returned no JSON`);
  }
}
function gatewayProcessId(status) {
  return status?.identity?.process?.processId ?? null;
}
async function monitorSummary(layout) {
  const [owner, record] = await Promise.all([readRecordOrNull(layout.monitorOwner), readRecordOrNull(layout.monitorStatus)]);
  const source = record ?? owner;
  if (source === null) return null;
  return {
    monitorId: source.monitorId ?? null,
    processId: source.processId ?? null,
    running: isProcessAlive(source.processId),
    health: record?.health ?? null,
    heartbeatAtUtc: record?.heartbeatAtUtc ?? null,
    fresh: record !== null && ageMs(record.heartbeatAtUtc) <= MONITOR_STALE_MS
  };
}
async function waitMonitorReady(context2, monitorId, { timeoutMs, handle = null }) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    const record = await readRecordOrNull(context2.layout.monitorStatus);
    if (record?.monitorId === monitorId && record.state === "ready" && isProcessAlive(record.processId) && ageMs(record.heartbeatAtUtc) <= MONITOR_STALE_MS) {
      return record;
    }
    if (handle !== null && handle.exitCode() !== null) {
      fail(
        "observability_unavailable",
        "The Gateway monitor exited before it was ready",
        { detail: { phase: "monitor-startup", exitCode: handle.exitCode() } }
      );
    }
    if (Date.now() >= deadline) {
      fail("observability_unavailable", "The Gateway monitor did not become ready", { detail: { phase: "monitor-startup" } });
    }
    await sleep(100);
  }
}
async function releaseDeadMonitor(context2, owner) {
  if (!owner?.monitorId || !Number.isSafeInteger(owner.processId)) {
    fail("gateway_monitor_identity_uncertain", "The monitor ownership record is not readable");
  }
  await runGatewayCli(context2, "release-monitor", [
    "--monitor-id",
    owner.monitorId,
    "--expected-process-id",
    String(owner.processId)
  ]);
}
async function rotate(file) {
  if (await pathKind(file) !== "file") return;
  await rename15(file, `${file}.previous`).catch(() => {
  });
}
async function ensureMonitor(context2, { visible, timeoutMs }) {
  const { layout } = context2;
  const owner = await readRecord(layout.monitorOwner).catch(() => fail(
    "gateway_monitor_identity_uncertain",
    "The monitor ownership record is not readable"
  ));
  if (owner !== null) {
    if (isProcessAlive(owner.processId)) {
      try {
        const record2 = await waitMonitorReady(context2, owner.monitorId, { timeoutMs });
        return { record: record2, launched: false, visible: null };
      } catch {
        fail("gateway_monitor_identity_uncertain", "A monitor process is alive but not ready");
      }
    }
    await releaseDeadMonitor(context2, owner);
  } else {
    const record2 = await readRecordOrNull(layout.monitorStatus);
    if (record2 !== null && isProcessAlive(record2.processId) && record2.state === "ready" && ageMs(record2.heartbeatAtUtc) <= MONITOR_STALE_MS) {
      return { record: record2, launched: false, visible: null };
    }
  }
  const monitorId = randomUUID12();
  const args = [
    requireCli(context2),
    "watch",
    "--repo-root",
    context2.root,
    "--project-id",
    context2.projectId,
    "--monitor-id",
    monitorId,
    "--refresh-ms",
    "1000"
  ];
  const env = nodeChildEnvironment(context2.env, { nodePath: context2.node, omit: ["ANTHROPIC_API_KEY"] });
  await mkdir16(layout.logsDir, { recursive: true });
  let handle;
  if (visible) {
    if (context2.platform !== "win32") fail("visible_monitor_unsupported", "--visible-monitor opens a console window on Windows only", { exitCode: 2 });
    handle = await context2.launcher.openVisible(context2.node, args, { cwd: context2.root, env });
  } else {
    await rotate(layout.monitorErrorLog);
    handle = context2.launcher.spawnDetached(context2.node, args, { cwd: context2.root, env, stderrFile: layout.monitorErrorLog });
  }
  if (!handle.pid) fail("observability_unavailable", "The Gateway monitor could not be started", { detail: { phase: "monitor-spawn" } });
  const record = await waitMonitorReady(context2, monitorId, { timeoutMs, handle });
  return { record, launched: true, visible };
}
async function recoverStale(context2, status, { waitForStaleMs = 0 } = {}) {
  const processId = gatewayProcessId(status);
  if (isProcessAlive(processId)) fail("gateway_recovery_process_alive", "The Gateway process is still alive");
  const waitUntil = Date.now() + waitForStaleMs;
  while (ageMs(status.heartbeatAtUtc) <= GATEWAY_STALE_MS) {
    if (Date.now() >= waitUntil) {
      fail(
        "gateway_recovery_not_stale",
        "The Gateway stopped less than 30 seconds ago; retry shortly",
        { detail: { retryAfterSeconds: Math.max(1, Math.ceil((GATEWAY_STALE_MS - ageMs(status.heartbeatAtUtc)) / 1e3) + 1) } }
      );
    }
    await sleep(250);
  }
  const result = await runGatewayCli(context2, "recover", [
    "--expected-instance-id",
    String(status.identity?.instanceId),
    "--expected-process-id",
    String(processId),
    "--expected-process-started-at-utc",
    String(status.identity?.process?.startedAtUtc)
  ]);
  if (result.status !== "recovered" && result.status !== "already-terminal") {
    fail("gateway_recovery_unconfirmed", "The Gateway did not confirm the recovery");
  }
  return readRecord(context2.layout.gatewayStatus);
}
async function clearDeadDescriptor(context2) {
  const file = path28.join(context2.layout.gatewayRuntime, "connection.v1.json");
  let info;
  try {
    info = await stat5(file);
  } catch {
    return false;
  }
  if (Date.now() - info.mtimeMs <= GATEWAY_STALE_MS) {
    fail("gateway_descriptor_fresh", "A connection descriptor was written moments ago: another start may be under way; retry shortly");
  }
  await rm11(file, { force: true });
  return true;
}
function startPlan(context2, { provider, visible }) {
  return {
    command: "gateway start",
    planOnly: true,
    instance: context2.root,
    projectId: context2.projectId,
    provider,
    visibleMonitor: visible,
    gatewayCli: context2.cli,
    node: context2.node,
    sequence: [
      "inspect-exact-gateway",
      "recover-exact-dead-stale-if-needed",
      "clear-dead-connection-descriptor",
      visible ? "open-visible-monitor" : "start-headless-monitor",
      "verify-monitor-readiness",
      "launch-hidden-gateway-if-terminal-or-absent",
      "verify-ready-instance",
      "verify-monitor-binding"
    ],
    logs: {
      stdout: context2.layout.gatewayLog,
      stderr: context2.layout.gatewayErrorLog,
      monitorStderr: context2.layout.monitorErrorLog
    },
    broadKill: false
  };
}
async function gatewayStart(context2, {
  provider = "claude",
  visible = false,
  timeoutMs = 3e4,
  monitorTimeoutMs = 15e3,
  planOnly = false
} = {}) {
  if (!GATEWAY_PROVIDERS.includes(provider)) fail("invalid_arguments", "--provider is claude (the Codex path left the product)", { exitCode: 2 });
  if (visible && context2.platform !== "win32") {
    fail("visible_monitor_unsupported", "--visible-monitor opens a console window on Windows only", { exitCode: 2 });
  }
  if (planOnly) return startPlan(context2, { provider, visible });
  const { layout } = context2;
  requireCli(context2);
  try {
    await assertNotMovedAway(context2.root);
    await assertWorldHeld(context2.root);
  } catch (error) {
    if (String(error?.code ?? "").startsWith("sync_") || error?.code === "instance_moved_away") fail(error.code, error.message);
    throw error;
  }
  let status = await readRecord(layout.gatewayStatus);
  let running = null;
  let recovered = false;
  if (status !== null && status.terminal !== true) {
    if (isProcessAlive(gatewayProcessId(status))) {
      if (ageMs(status.heartbeatAtUtc) > GATEWAY_STALE_MS) fail("live_gateway_unhealthy", "The Gateway process is alive but its heartbeat is stale");
      running = status;
    } else {
      status = await recoverStale(context2, status, { waitForStaleMs: GATEWAY_STALE_MS + 2e3 });
      recovered = true;
    }
  }
  if (running === null && await clearDeadDescriptor(context2)) recovered = true;
  if (running === null && provider === "claude" && await pathKind(layout.claudeProvider) !== "file") {
    fail("claude_provider_config_missing", "The instance has no .project-local/application-gateway/claude-provider.json; run setup");
  }
  const monitor = await ensureMonitor(context2, { visible, timeoutMs: monitorTimeoutMs });
  let handle = null;
  let apiKeySource = null;
  let apiKeyReason = null;
  if (running === null) {
    const apiKey = context2.keyStore ? await resolveApiKey({ env: context2.env, store: context2.keyStore }) : { source: "none", key: null, reasonCode: "key_store_not_configured" };
    apiKeySource = apiKey.source;
    apiKeyReason = apiKey.reasonCode;
    const env = nodeChildEnvironment(context2.env, { nodePath: context2.node });
    if (apiKey.key !== null) env.ANTHROPIC_API_KEY = apiKey.key;
    await mkdir16(layout.logsDir, { recursive: true });
    await rotate(layout.gatewayLog);
    await rotate(layout.gatewayErrorLog);
    handle = context2.launcher.spawnDetached(
      context2.node,
      [
        requireCli(context2),
        "run",
        "--repo-root",
        context2.root,
        "--project-id",
        context2.projectId,
        "--monitor-id",
        monitor.record.monitorId,
        "--provider",
        provider
      ],
      { cwd: context2.root, env, stdoutFile: layout.gatewayLog, stderrFile: layout.gatewayErrorLog }
    );
    if (!handle.pid) fail("gateway_start_failed", "The Gateway process could not be started");
  }
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    status = await readRecordOrNull(layout.gatewayStatus);
    const processId2 = gatewayProcessId(status);
    const exact2 = handle === null || processId2 === handle.pid;
    if (exact2 && status?.lifecycle === "ready" && isProcessAlive(processId2)) break;
    if (handle !== null && (handle.exitCode() !== null || exact2 && status?.terminal === true)) {
      const errorText = await readFile19(layout.gatewayErrorLog, "utf8").catch(() => "");
      fail(
        "gateway_start_failed",
        "The Gateway exited during startup; see gateway logs",
        { detail: { exitCode: handle.exitCode(), ...failureCode(errorText) ?? {} } }
      );
    }
    if (Date.now() >= deadline) {
      fail(
        "gateway_start_timeout",
        "The Gateway did not become ready in time; see gateway logs",
        { detail: { processId: handle?.pid ?? processId2 } }
      );
    }
    await sleep(100);
  }
  const instanceId = status.identity.instanceId;
  const processId = gatewayProcessId(status);
  let bound2 = null;
  while (bound2 === null) {
    const record = await readRecordOrNull(layout.monitorStatus);
    if (record?.monitorId === monitor.record.monitorId && record.state === "ready" && ageMs(record.heartbeatAtUtc) <= MONITOR_STALE_MS && record.gatewayInstanceId === instanceId && record.gatewayProcessId === processId && record.health === "gateway-ready") {
      bound2 = record;
      break;
    }
    if (Date.now() >= deadline + MONITOR_STALE_MS) {
      fail("observability_unavailable", "The monitor did not bind to the ready Gateway", { detail: { phase: "monitor-binding" } });
    }
    await sleep(100);
  }
  return {
    command: "gateway start",
    state: "ready",
    launched: handle !== null,
    recovered,
    instance: context2.root,
    projectId: context2.projectId,
    provider: running === null ? provider : null,
    instanceId,
    processId,
    monitorId: bound2.monitorId,
    monitorProcessId: bound2.processId,
    monitorLaunched: monitor.launched,
    monitorVisible: monitor.visible,
    apiKeySource,
    ...apiKeyReason && apiKeySource === "none" ? { apiKeyReasonCode: apiKeyReason } : {}
  };
}
async function closeMonitor(context2, { waitMs = 5e3 } = {}) {
  const { layout } = context2;
  const owner = await readRecordOrNull(layout.monitorOwner);
  if (owner === null) {
    const record = await readRecordOrNull(layout.monitorStatus);
    return record !== null && isProcessAlive(record.processId) ? { state: "unowned-running", monitorId: record.monitorId ?? null } : { state: "absent", monitorId: null };
  }
  if (isProcessAlive(owner.processId)) {
    const until = Date.now() + waitMs;
    while (isProcessAlive(owner.processId) && Date.now() < until) await sleep(100);
  }
  if (isProcessAlive(owner.processId)) {
    const currentOwner = await readRecordOrNull(layout.monitorOwner);
    if (currentOwner !== null) {
      const record = await readRecordOrNull(layout.monitorStatus);
      if (currentOwner.monitorId !== owner.monitorId || record?.monitorId !== owner.monitorId || record.processId !== owner.processId || record.projectId !== context2.projectId || ageMs(record.heartbeatAtUtc) > MONITOR_STALE_MS) {
        fail("gateway_monitor_identity_uncertain", "The live monitor could not be identified exactly; it was left running");
      }
    }
    try {
      process.kill(owner.processId);
    } catch {
    }
    const until = Date.now() + 5e3;
    while (isProcessAlive(owner.processId) && Date.now() < until) await sleep(100);
    if (isProcessAlive(owner.processId)) fail("gateway_monitor_close_unconfirmed", "The monitor did not exit");
  }
  const remaining = await readRecordOrNull(layout.monitorOwner);
  if (remaining?.monitorId === owner.monitorId) await releaseDeadMonitor(context2, owner);
  return { state: "closed", monitorId: owner.monitorId };
}
async function gatewayStop(context2, { timeoutMs = 15e3, planOnly = false } = {}) {
  if (planOnly) {
    return {
      command: "gateway stop",
      planOnly: true,
      instance: context2.root,
      projectId: context2.projectId,
      exactInstanceRequired: true,
      closesMonitor: true,
      broadKill: false
    };
  }
  requireCli(context2);
  const status = await readRecord(context2.layout.gatewayStatus);
  let result;
  if (status === null) result = { state: "absent", instanceId: null, lifecycle: null };
  else if (status.terminal === true) {
    result = { state: "already-terminal", instanceId: status.identity?.instanceId ?? null, lifecycle: status.lifecycle };
  } else if (!isProcessAlive(gatewayProcessId(status))) {
    fail("gateway_process_unavailable", "The Gateway process is gone without a terminal status; run gateway recover");
  } else {
    const stopped = await runGatewayCli(
      context2,
      "stop",
      ["--timeout-ms", String(Math.min(6e4, Math.max(1e3, timeoutMs)))],
      { timeoutMs: timeoutMs + 3e4 }
    );
    if (stopped.status !== "stopped" && stopped.status !== "already-terminal" && stopped.status !== "absent") {
      fail("gateway_stop_unconfirmed", "The Gateway did not confirm the stop");
    }
    result = {
      state: stopped.status,
      instanceId: stopped.instanceId ?? status.identity?.instanceId ?? null,
      lifecycle: stopped.lifecycle ?? null
    };
  }
  const monitor = await closeMonitor(context2);
  return { command: "gateway stop", instance: context2.root, projectId: context2.projectId, ...result, monitor };
}
async function gatewayStatus(context2) {
  const assessed = await runGatewayCli(context2, "status");
  return {
    command: "gateway status",
    instance: context2.root,
    projectId: context2.projectId,
    availability: assessed.availability,
    reasonCode: assessed.reasonCode,
    ready: assessed.ready === true,
    lifecycle: assessed.gateway?.lifecycle ?? null,
    instanceId: assessed.gateway?.instanceId ?? null,
    processId: assessed.gateway?.processId ?? null,
    startedAtUtc: assessed.gateway?.startedAtUtc ?? null,
    heartbeatAtUtc: assessed.gateway?.heartbeatAtUtc ?? null,
    monitor: await monitorSummary(context2.layout)
  };
}
async function gatewayRecover(context2, { planOnly = false } = {}) {
  if (planOnly) {
    return {
      command: "gateway recover",
      planOnly: true,
      instance: context2.root,
      projectId: context2.projectId,
      exactDeadInstanceRequired: true,
      minimumStaleSeconds: GATEWAY_STALE_MS / 1e3,
      broadKill: false
    };
  }
  requireCli(context2);
  const status = await readRecord(context2.layout.gatewayStatus);
  let result;
  if (status === null) result = { state: "absent", instanceId: null, restartAllowed: true, changed: false };
  else if (status.terminal === true) {
    result = { state: status.lifecycle, instanceId: status.identity?.instanceId ?? null, restartAllowed: true, changed: false };
  } else {
    const recovered = await recoverStale(context2, status);
    result = {
      state: recovered?.lifecycle ?? "uncertain",
      instanceId: status.identity?.instanceId ?? null,
      restartAllowed: true,
      changed: true
    };
  }
  const owner = await readRecordOrNull(context2.layout.monitorOwner);
  let monitor = { state: owner === null ? "absent" : "running", monitorId: owner?.monitorId ?? null };
  if (owner !== null && !isProcessAlive(owner.processId)) {
    await releaseDeadMonitor(context2, owner);
    monitor = { state: "released", monitorId: owner.monitorId };
  }
  return { command: "gateway recover", instance: context2.root, projectId: context2.projectId, ...result, monitor };
}
var LOG_STREAMS = Object.freeze([["stdout", "gatewayLog"], ["stderr", "gatewayErrorLog"], ["monitor-stderr", "monitorErrorLog"]]);
async function tail(file, lines2) {
  let handle;
  try {
    handle = await open2(file, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, lines: [] };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const all = buffer.toString("utf8").split(/\r?\n/u);
    if (all.at(-1) === "") all.pop();
    if (length < size) all.shift();
    return { exists: true, sizeBytes: size, lines: all.slice(-lines2) };
  } finally {
    await handle.close();
  }
}
async function gatewayLogs(layout, { lines: lines2 = 50 } = {}) {
  const files = [];
  for (const [stream, key] of LOG_STREAMS) files.push({ stream, path: layout[key], ...await tail(layout[key], lines2) });
  return { command: "gateway logs", instance: layout.instanceDir, files };
}
async function followGatewayLogs(layout, { write = (text3) => process.stdout.write(text3), signal = null, intervalMs = 500 } = {}) {
  const offsets = /* @__PURE__ */ new Map();
  for (const [, key] of LOG_STREAMS) offsets.set(key, (await stat5(layout[key]).catch(() => null))?.size ?? 0);
  while (signal === null || !signal.aborted) {
    for (const [stream, key] of LOG_STREAMS) {
      const size = (await stat5(layout[key]).catch(() => null))?.size ?? 0;
      let offset = offsets.get(key);
      if (size < offset) offset = 0;
      if (size > offset) {
        const handle = await open2(layout[key], "r");
        try {
          const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
          await handle.read(buffer, 0, buffer.length, offset);
          offset += buffer.length;
          for (const line of buffer.toString("utf8").split(/\r?\n/u)) if (line !== "") write(`[${stream}] ${line}
`);
        } finally {
          await handle.close();
        }
      }
      offsets.set(key, offset);
    }
    await sleep(intervalMs);
  }
}

// orchestrator/src/agents-factory-migrate.mjs
import { copyFile as copyFile5, mkdir as mkdir18, readdir as readdir11 } from "node:fs/promises";
import path30 from "node:path";

// orchestrator/src/instance-mode.mjs
import { mkdir as mkdir17, readFile as readFile20, realpath as realpath12, rename as rename16, writeFile as writeFile13 } from "node:fs/promises";
import { randomUUID as randomUUID13 } from "node:crypto";
import path29 from "node:path";
var SYNC_CONFIG = path29.join(".project-local", "sync.json");
function fail24(code, detail) {
  throw new ProjectPackageError(code, detail);
}
async function writeJsonOver4(target, value) {
  await mkdir17(path29.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID13()}.tmp`;
  await writeFile13(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename16(temporary, target);
}
async function readInstanceMode(controllerRoot) {
  const root = await realpath12(controllerRoot);
  const recorded = await recordedMode(root);
  let config = null;
  let configProblem = null;
  try {
    config = await readSyncConfig(root);
  } catch (error) {
    configProblem = error?.code ?? "sync_config_invalid";
  }
  const mode = recorded ?? (config !== null || configProblem !== null ? "synced" : "local");
  const missing = [];
  if (mode === "synced") {
    if (configProblem !== null) missing.push(configProblem);
    else if (config === null) missing.push("sync_not_configured");
    if (await readThisMachine(root) === null) missing.push("sync_machine_unnamed");
  }
  return { mode, recorded: recorded !== null, missing, begun: await syncBegun(root) };
}
async function setInstanceMode({
  controllerRoot,
  mode,
  confirm,
  syncConfig = null,
  machine = null,
  now = () => /* @__PURE__ */ new Date()
}) {
  if (!INSTANCE_MODES.includes(mode)) fail24("mode_invalid", String(mode));
  if (confirm !== mode) fail24("mode_confirmation_required", mode);
  const root = await realpath12(controllerRoot);
  const recordFile = path29.join(root, "instance.json");
  let record;
  try {
    record = JSON.parse(await readFile20(recordFile, "utf8"));
  } catch {
    record = null;
  }
  if (record === null || typeof record !== "object") fail24("instance_not_initialized", "instance.json");
  const previous = await readInstanceMode(root);
  if (mode === "local") {
    if (previous.begun && (await readSyncState(root)).world.held !== true) {
      fail24("mode_world_elsewhere", "take the world first (agents-factory sync take)");
    }
  } else {
    let candidate = null;
    if (syncConfig !== null) {
      try {
        candidate = JSON.parse(await readFile20(syncConfig, "utf8"));
      } catch {
        fail24("sync_config_invalid", syncConfig);
      }
      syncConfigOf(candidate);
    } else if (await readSyncConfig(root) === null) {
      fail24("sync_not_configured", "--sync-config <file>");
    }
    if (machine !== null) await setThisMachine(root, machine);
    if (await readThisMachine(root) === null) fail24("sync_machine_unnamed", "--machine-id <id>");
    if (candidate !== null) await writeJsonOver4(path29.join(root, SYNC_CONFIG), candidate);
  }
  await writeJsonOver4(recordFile, { ...record, mode, updatedAtUtc: now().toISOString() });
  return { previous: previous.mode, ...await readInstanceMode(root) };
}

// orchestrator/src/agents-factory-migrate.mjs
var INSTANCE_KIND = "agents-factory-instance";
var INSTANCE_SCHEMA_VERSION = 2;
var INSTANCE_MIGRATIONS = Object.freeze([
  {
    // Plan 4.3 / 5.1 (docs/project-package.md §6.6, §14.9): one memory database per project, as a
    // project package needs; the export, import and comparison of migrate-layout, the single database
    // kept. The mode the instance had (synced with a sync.json, else local) is recorded.
    id: "split-store-and-mode",
    from: 1,
    to: 2,
    description: "One memory database per project (the split layout); the instance's mode recorded",
    async apply({ instanceDir }) {
      if ((await resolveStoreLayout(instanceDir, { env: {} })).layout !== "split") {
        await migrateToSplitLayout({ controllerRoot: instanceDir });
      }
      const mode = await readInstanceMode(instanceDir);
      if (!mode.recorded) {
        const file = path30.join(instanceDir, "instance.json");
        await writeJsonAtomic(file, { ...await readJsonFile(file), mode: mode.mode });
      }
    }
  }
]);
var DATABASE = /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/iu;
var CONFIG_FILES = Object.freeze([
  "instance.json",
  "project-version.json",
  path30.join(".project-local", "application-gateway", "claude-provider.json"),
  path30.join(".project-local", "orchestration", "control-cycle.json"),
  path30.join(".project-local", "source-bindings.json")
]);
function newInstanceRecord({ createdBy, now = nowUtc(), schemaVersion = INSTANCE_SCHEMA_VERSION }) {
  return { schemaVersion, kind: INSTANCE_KIND, createdAtUtc: now, createdBy, updatedAtUtc: now };
}
async function readInstanceRecord(layout) {
  const record = await readJsonFile(layout.instanceRecord, { invalidCode: "instance_record_invalid" });
  if (record === null) return null;
  if (record.kind !== INSTANCE_KIND || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) {
    fail("instance_record_invalid", "instance.json is not an Agents Factory instance record");
  }
  return record;
}
function validateMigrations(migrations) {
  let expected = null;
  for (const migration of migrations) {
    if (typeof migration?.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,95}$/u.test(migration.id) || !Number.isSafeInteger(migration.from) || migration.to !== migration.from + 1 || typeof migration.apply !== "function" || expected !== null && migration.from !== expected) {
      fail("migration_list_invalid", "The migration list is not one ordered chain");
    }
    expected = migration.to;
  }
}
async function walkDatabases(directory, root, found, skip) {
  const entries = await readdir11(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path30.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!skip.has(full)) await walkDatabases(full, root, found, skip);
    } else if (entry.isFile() && DATABASE.test(entry.name)) {
      found.push(path30.relative(root, full));
    }
  }
}
async function backupInstance(layout, { now = /* @__PURE__ */ new Date() } = {}) {
  const stamp3 = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  let directory = path30.join(layout.backupsDir, `migrate-${stamp3}`);
  for (let suffix = 1; await pathKind(directory) !== null; suffix += 1) {
    directory = path30.join(layout.backupsDir, `migrate-${stamp3}-${suffix}`);
  }
  const relativeFiles = [];
  for (const file of CONFIG_FILES) {
    if (await pathKind(path30.join(layout.instanceDir, file)) === "file") relativeFiles.push(file);
  }
  const configDirectory = path30.join(layout.instanceDir, "config");
  for (const entry of await readdir11(configDirectory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith(".json")) relativeFiles.push(path30.join("config", entry.name));
  }
  await walkDatabases(
    path30.join(layout.instanceDir, ".project-local"),
    layout.instanceDir,
    relativeFiles,
    /* @__PURE__ */ new Set([layout.backupsDir])
  );
  const files = [];
  for (const relative of relativeFiles) {
    const source = path30.join(layout.instanceDir, relative);
    const target = path30.join(directory, "files", relative);
    await mkdir18(path30.dirname(target), { recursive: true });
    await copyFile5(source, target);
    files.push({ path: relative.split(path30.sep).join("/"), sha256: await sha256File(target) });
  }
  await writeJsonAtomic(path30.join(directory, "backup-manifest.json"), {
    schemaVersion: 1,
    kind: "agents-factory-migration-backup",
    createdAtUtc: now.toISOString(),
    files
  });
  return { path: directory, files: files.length };
}
async function gatewayRunning2(layout) {
  const status = await readJsonFile(layout.gatewayStatus).catch(() => null);
  return status !== null && status.terminal !== true && isProcessAlive(status.identity?.process?.processId);
}
async function migrateInstance({
  layout,
  dryRun = false,
  migrations = INSTANCE_MIGRATIONS,
  targetVersion = migrations.length === 0 ? INSTANCE_SCHEMA_VERSION : migrations.at(-1).to,
  now = () => /* @__PURE__ */ new Date()
}) {
  validateMigrations(migrations);
  if (await pathKind(layout.instanceDir) !== "directory") fail("instance_missing", `No controller instance at ${layout.instanceDir}`);
  const record = await readInstanceRecord(layout);
  if (record === null) fail("instance_not_initialized", "The instance has no instance.json; run setup");
  if (record.schemaVersion > targetVersion) {
    fail("instance_newer_than_cli", `The instance schema ${record.schemaVersion} is newer than this CLI (${targetVersion})`);
  }
  const pending = migrations.filter((migration) => migration.from >= record.schemaVersion && migration.to <= targetVersion);
  if (pending.length > 0 && pending[0].from !== record.schemaVersion) {
    fail("migration_list_invalid", `No migration starts at schema ${record.schemaVersion}`);
  }
  const summary2 = {
    command: "migrate",
    instance: layout.instanceDir,
    dryRun,
    schemaVersion: record.schemaVersion,
    targetSchemaVersion: targetVersion,
    pending: pending.map(({ id: id5, from, to, description }) => ({ id: id5, from, to, description: description ?? null }))
  };
  if (dryRun || pending.length === 0) {
    return { ...summary2, state: pending.length === 0 ? "current" : "pending", applied: [], backup: null };
  }
  if (await gatewayRunning2(layout)) fail("gateway_running", "Stop the Gateway before migrating (gateway stop)");
  const backup = await backupInstance(layout, { now: now() });
  const applied = [];
  let current = record;
  for (const migration of pending) {
    await migration.apply({ instanceDir: layout.instanceDir, layout });
    current = { ...await readInstanceRecord(layout) ?? current, schemaVersion: migration.to, updatedAtUtc: now().toISOString() };
    await writeJsonAtomic(layout.instanceRecord, current);
    applied.push(migration.id);
  }
  const verified = await readInstanceRecord(layout);
  if (verified?.schemaVersion !== targetVersion) fail("migration_unverified", "instance.json does not show the target schema");
  return { ...summary2, state: "migrated", schemaVersion: verified.schemaVersion, applied, backup };
}

// orchestrator/src/agents-factory-sdk.mjs
import { createHash as createHash19, randomUUID as randomUUID14 } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir as mkdir20, readdir as readdir12, readFile as readFile21, rm as rm12 } from "node:fs/promises";
import path32 from "node:path";

// orchestrator/src/agents-factory-tar.mjs
import { createReadStream as createReadStream2 } from "node:fs";
import { chmod, mkdir as mkdir19, open as open3 } from "node:fs/promises";
import path31 from "node:path";
import { createGunzip } from "node:zlib";
var BLOCK = 512;
var WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu;
function refuse2(reason) {
  fail("archive_unsafe", `The package archive was refused: ${reason}`, { detail: { reason } });
}
function text2(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}
function octal(buffer, start, length) {
  if (buffer[start] & 128) {
    let value = 0;
    for (let index = start + 1; index < start + length; index += 1) value = value * 256 + buffer[index];
    if (!Number.isSafeInteger(value)) refuse2("size");
    return value;
  }
  const raw = text2(buffer, start, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/u.test(raw)) refuse2("header");
  return Number.parseInt(raw, 8);
}
function checksumValid(header) {
  const expected = octal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
  return sum === expected;
}
function parsePax(buffer) {
  const values = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space === -1) break;
    const length = Number.parseInt(buffer.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > buffer.length) refuse2("pax header");
    const record = buffer.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}
function safeEntryParts(name, stripComponents = 1) {
  if (typeof name !== "string" || name.length > 4096) refuse2("name");
  if (/[\u0000-\u001f\\:]/u.test(name)) refuse2("name characters");
  if (name.startsWith("/")) refuse2("absolute name");
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) refuse2("parent reference");
  if (parts.some((part) => WINDOWS_RESERVED.test(part) || /[. ]$/u.test(part) || part.length > 255)) refuse2("name");
  return parts.slice(stripComponents);
}
async function extractTarGz(file, destination, {
  stripComponents = 1,
  maxBytes = 2 * 1024 * 1024 * 1024,
  maxEntries = 1e5,
  platform = process.platform
} = {}) {
  const root = path31.resolve(destination);
  await mkdir19(root, { recursive: true });
  const inside2 = (parts) => {
    const target = path31.resolve(root, ...parts);
    const relative = path31.relative(root, target);
    if (relative === "" || relative.startsWith("..") || path31.isAbsolute(relative)) refuse2("outside destination");
    return target;
  };
  const created = /* @__PURE__ */ new Set([root]);
  const ensureDirectory = async (target) => {
    if (created.has(target)) return;
    await mkdir19(target, { recursive: true });
    created.add(target);
  };
  let header = Buffer.alloc(0);
  let state = { kind: "header" };
  let pending = {};
  let ended = false;
  let entries = 0;
  let bytes = 0;
  let files = 0;
  let directories = 0;
  const startEntry = async (block) => {
    if (block.every((byte) => byte === 0)) {
      ended = true;
      return { kind: "end" };
    }
    if (!checksumValid(block)) refuse2("header checksum");
    entries += 1;
    if (entries > maxEntries) refuse2("too many entries");
    const type = String.fromCharCode(block[156] || 48);
    const size = octal(block, 124, 12);
    const padding = (BLOCK - size % BLOCK) % BLOCK;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > 1024 * 1024) refuse2("extended header size");
      return { kind: "meta", type, remaining: size, padding, chunks: [] };
    }
    const magic = text2(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? text2(block, 345, 155) : "";
    const headerName = prefix ? `${prefix}/${text2(block, 0, 100)}` : text2(block, 0, 100);
    const name = pending.path ?? headerName;
    const finalSize = pending.size !== void 0 ? Number(pending.size) : size;
    pending = {};
    if (type === "1" || type === "2") refuse2("link entry");
    if (type !== "0" && type !== "7" && type !== "5") refuse2(`entry type ${JSON.stringify(type)}`);
    if (!Number.isSafeInteger(finalSize) || finalSize < 0) refuse2("size");
    const finalPadding = (BLOCK - finalSize % BLOCK) % BLOCK;
    const parts = safeEntryParts(name, stripComponents);
    if (type === "5") {
      if (parts.length > 0) {
        await ensureDirectory(inside2(parts));
        directories += 1;
      }
      return finalSize > 0 ? { kind: "skip", remaining: finalSize + finalPadding } : { kind: "header" };
    }
    if (parts.length === 0) return { kind: "skip", remaining: finalSize + finalPadding };
    bytes += finalSize;
    if (bytes > maxBytes) refuse2("unpacked size");
    const target = inside2(parts);
    await ensureDirectory(path31.dirname(target));
    const handle = await open3(target, "w", 420);
    files += 1;
    const mode = octal(block, 100, 8);
    if (finalSize === 0) {
      await handle.close();
      if (platform !== "win32" && mode & 73) await chmod(target, 493);
      return { kind: "header" };
    }
    return { kind: "file", handle, target, mode, remaining: finalSize, padding: finalPadding };
  };
  const consume = async (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (state.kind === "end") return;
      if (state.kind === "header") {
        const take = Math.min(BLOCK - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length === BLOCK) {
          const block = header;
          header = Buffer.alloc(0);
          state = await startEntry(block);
        }
        continue;
      }
      if (state.kind === "skip") {
        const take = Math.min(state.remaining, chunk.length - offset);
        offset += take;
        state.remaining -= take;
        if (state.remaining === 0) state = { kind: "header" };
        continue;
      }
      if (state.kind === "meta") {
        const take = Math.min(state.remaining, chunk.length - offset);
        state.chunks.push(chunk.subarray(offset, offset + take));
        offset += take;
        state.remaining -= take;
        if (state.remaining === 0) {
          const data = Buffer.concat(state.chunks);
          if (state.type === "x") {
            const values = parsePax(data);
            if (values.path !== void 0) pending.path = values.path;
            if (values.size !== void 0) pending.size = values.size;
            if (values.linkpath !== void 0) pending.linkpath = values.linkpath;
          } else if (state.type === "L") {
            pending.path = text2(data, 0, data.length);
          }
          state = state.padding > 0 ? { kind: "skip", remaining: state.padding } : { kind: "header" };
        }
        continue;
      }
      if (state.kind === "file") {
        const take = Math.min(state.remaining, chunk.length - offset);
        await state.handle.write(chunk.subarray(offset, offset + take));
        offset += take;
        state.remaining -= take;
        if (state.remaining === 0) {
          await state.handle.close();
          if (platform !== "win32" && state.mode & 73) await chmod(state.target, 493);
          state = state.padding > 0 ? { kind: "skip", remaining: state.padding } : { kind: "header" };
        }
      }
    }
  };
  const source = createReadStream2(file);
  const stream = createGunzip();
  source.on("error", (error) => stream.destroy(error));
  source.pipe(stream);
  try {
    for await (const chunk of stream) {
      await consume(chunk);
      if (state.kind === "end") break;
    }
  } catch (error) {
    if (state.kind === "file") await state.handle.close().catch(() => {
    });
    if (error?.code === "archive_unsafe") throw error;
    if (typeof error?.code === "string" && error.code.startsWith("Z_")) refuse2("not gzip");
    throw error;
  } finally {
    source.destroy();
    stream.destroy();
  }
  if (state.kind === "file") {
    await state.handle.close().catch(() => {
    });
    refuse2("truncated");
  }
  if (!ended && (state.kind !== "header" || header.length !== 0)) refuse2("truncated");
  return { files, directories, bytes };
}

// orchestrator/src/agents-factory-sdk.mjs
var CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
var DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
var SDK_MANIFEST = "agents-factory-sdk.json";
var PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,113}$/u;
var VERSION_DIR = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,64})?$/u;
var MAX_PACKAGES = 64;
function parseVersion(text3) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(String(text3).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : []
  };
}
function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === void 0) return -1;
    if (y === void 0) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/u.test(x);
    const yNumber = /^\d+$/u.test(y);
    if (xNumber && yNumber) return Number(x) < Number(y) ? -1 : 1;
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function partial(text3) {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text3);
  if (!match) return null;
  const number = (value) => value === void 0 || /^[xX*]$/u.test(value) ? null : Number(value);
  const major = number(match[1]);
  const minor = major === null ? null : number(match[2]);
  const patch = minor === null ? null : number(match[3]);
  return { major, minor, patch, pre: match[4] && patch !== null ? match[4].split(".") : [] };
}
var version = (major, minor, patch, pre = []) => ({ major, minor, patch, pre });
var ceiling = (major, minor, patch) => version(major, minor, patch, ["0"]);
function comparatorsOf(token2) {
  const match = /^(>=|<=|>|<|=|\^|~>?)?(.*)$/u.exec(token2);
  const operator = match[1] ?? "";
  const value = partial(match[2]);
  if (value === null) return null;
  const { major, minor, patch, pre } = value;
  if (major === null) return operator === "<" || operator === ">" ? [{ op: "<", v: version(0, 0, 0, ["0"]) }] : [];
  const low = version(major, minor ?? 0, patch ?? 0, pre);
  if (operator === "^") {
    if (major > 0 || minor === null) return [{ op: ">=", v: low }, { op: "<", v: ceiling(major + 1, 0, 0) }];
    if (minor > 0 || patch === null) return [{ op: ">=", v: low }, { op: "<", v: ceiling(0, minor + 1, 0) }];
    return [{ op: ">=", v: low }, { op: "<", v: ceiling(0, 0, patch + 1) }];
  }
  if (operator === "~" || operator === "~>") {
    if (minor === null) return [{ op: ">=", v: low }, { op: "<", v: ceiling(major + 1, 0, 0) }];
    return [{ op: ">=", v: low }, { op: "<", v: ceiling(major, minor + 1, 0) }];
  }
  const upperOfPartial = minor === null ? ceiling(major + 1, 0, 0) : ceiling(major, minor + 1, 0);
  if (operator === "" || operator === "=") {
    if (patch === null) return [{ op: ">=", v: low }, { op: "<", v: upperOfPartial }];
    return [{ op: "=", v: low }];
  }
  if (operator === ">=") return [{ op: ">=", v: low }];
  if (operator === "<") return [{ op: "<", v: patch === null ? version(major, minor ?? 0, 0, ["0"]) : low }];
  if (operator === ">") return patch === null ? [{ op: ">=", v: upperOfPartial }] : [{ op: ">", v: low }];
  if (operator === "<=") return patch === null ? [{ op: "<", v: upperOfPartial }] : [{ op: "<=", v: low }];
  return null;
}
function parseRangeSet(text3) {
  const trimmed = text3.trim();
  if (trimmed === "" || trimmed === "*" || /^[xX]$/u.test(trimmed) || trimmed === "latest") return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(trimmed);
  if (hyphen) {
    const from = comparatorsOf(`>=${hyphen[1]}`);
    const to = partial(hyphen[2]);
    if (from === null || to === null) return null;
    const upper = to.patch !== null ? [{ op: "<=", v: version(to.major, to.minor, to.patch, to.pre) }] : comparatorsOf(`<=${hyphen[2]}`);
    return upper === null ? null : [...from, ...upper];
  }
  const tokens = trimmed.replace(/(>=|<=|>|<|=|\^|~>?)\s+/gu, "$1").split(/\s+/u);
  const result = [];
  for (const token2 of tokens) {
    const comparators = comparatorsOf(token2);
    if (comparators === null) return null;
    result.push(...comparators);
  }
  return result;
}
function satisfies(versionText, range) {
  const candidate = parseVersion(versionText);
  if (candidate === null) return false;
  for (const set of String(range).split("||")) {
    const comparators = parseRangeSet(set);
    if (comparators === null) continue;
    const ok = comparators.every(({ op, v }) => {
      const order = compareVersions(candidate, v);
      return op === "=" ? order === 0 : op === ">=" ? order >= 0 : op === ">" ? order > 0 : op === "<" ? order < 0 : order <= 0;
    });
    if (!ok) continue;
    if (candidate.pre.length === 0) return true;
    if (comparators.some(({ v }) => v.pre.length > 0 && v.pre[0] !== "0" && v.major === candidate.major && v.minor === candidate.minor && v.patch === candidate.patch)) return true;
  }
  return false;
}
function normalizeRegistry(text3) {
  let url;
  try {
    url = new URL(text3);
  } catch {
    fail("registry_invalid", "The npm registry is not a URL", { exitCode: 2 });
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("registry_insecure", "The npm registry must be HTTPS (plain HTTP only on loopback)", { exitCode: 2 });
  }
  return url.href.replace(/\/+$/u, "");
}
function checkDownloadUrl(text3) {
  let url;
  try {
    url = new URL(text3);
  } catch {
    fail("claude_sdk_metadata_invalid", "A tarball URL is invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("claude_sdk_download_insecure", "A tarball URL is not HTTPS");
  }
  return url.href;
}
async function fetchMetadata(registry, name, fetchImpl) {
  if (!PACKAGE_NAME.test(name)) fail("claude_sdk_metadata_invalid", `Package name refused: ${name}`);
  const url = `${registry}/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
      signal: AbortSignal.timeout(12e4)
    });
  } catch {
    fail("claude_sdk_registry_unreachable", `The npm registry did not answer for ${name}`);
  }
  if (response.status === 404) fail("claude_sdk_package_not_found", `${name} is not in the registry`);
  if (!response.ok) fail("claude_sdk_registry_failed", `The npm registry answered ${response.status} for ${name}`);
  const text3 = await response.text();
  if (text3.length > 128 * 1024 * 1024) fail("claude_sdk_metadata_invalid", "Registry metadata is too large");
  let metadata;
  try {
    metadata = JSON.parse(text3);
  } catch {
    fail("claude_sdk_metadata_invalid", `Registry metadata of ${name} is not JSON`);
  }
  if (!metadata || typeof metadata.versions !== "object" || metadata.versions === null) {
    fail("claude_sdk_metadata_invalid", `Registry metadata of ${name} lists no versions`);
  }
  return metadata;
}
function pickVersion(metadata, spec) {
  const tags = metadata["dist-tags"] ?? {};
  if (typeof tags[spec] === "string" && metadata.versions[tags[spec]]) return tags[spec];
  if (metadata.versions[spec]) return spec;
  const candidates = Object.keys(metadata.versions).filter((value) => parseVersion(value) && satisfies(value, spec));
  if (candidates.length === 0) return null;
  if (typeof tags.latest === "string" && candidates.includes(tags.latest)) return tags.latest;
  return candidates.sort((a, b) => compareVersions(b, a))[0];
}
function sha512Of(integrity) {
  const entry = String(integrity ?? "").split(/\s+/u).find((item) => item.startsWith("sha512-"));
  return entry ? entry.slice("sha512-".length) : null;
}
async function download(url, file, integrity, fetchImpl, maxBytes) {
  const expected = sha512Of(integrity);
  if (expected === null) fail("claude_sdk_integrity_missing", "The registry gives no sha512 integrity for a tarball");
  let response;
  try {
    response = await fetchImpl(checkDownloadUrl(url), { signal: AbortSignal.timeout(60 * 6e4) });
  } catch (error) {
    if (error?.code && String(error.code).startsWith("claude_sdk_")) throw error;
    fail("claude_sdk_download_failed", "A tarball download failed");
  }
  if (!response.ok || response.body === null) fail("claude_sdk_download_failed", `A tarball download answered ${response.status}`);
  checkDownloadUrl(response.url || url);
  const digest = createHash19("sha512");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const output = createWriteStream(file, { flags: "wx" });
    output.on("error", reject);
    output.on("finish", resolve);
    (async () => {
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw Object.assign(new Error("too large"), { code: "claude_sdk_download_too_large" });
          digest.update(chunk);
          if (!output.write(chunk)) await new Promise((drain) => output.once("drain", drain));
        }
        output.end();
      } catch (error) {
        output.destroy();
        reject(error);
      }
    })();
  }).catch((error) => {
    if (error?.code === "claude_sdk_download_too_large") fail("claude_sdk_download_too_large", "A tarball is larger than allowed");
    fail("claude_sdk_download_failed", "A tarball download was interrupted");
  });
  if (digest.digest("base64") !== expected) {
    await rm12(file, { force: true });
    fail("claude_sdk_integrity_mismatch", "A downloaded tarball does not match its registry integrity");
  }
  return bytes;
}
function sdkPlatformPackage(platform = process.platform, arch = process.arch) {
  return `${CLAUDE_SDK_PACKAGE}-${platform}-${arch}`;
}
function packageDirectory(root, name) {
  return path32.join(root, "node_modules", ...name.split("/"));
}
async function resolveSdkPackages({ registry, requested, fetchImpl, platform, arch }) {
  const metadataCache = /* @__PURE__ */ new Map();
  const metadataOf = async (name) => {
    if (!metadataCache.has(name)) metadataCache.set(name, await fetchMetadata(registry, name, fetchImpl));
    return metadataCache.get(name);
  };
  const resolved = /* @__PURE__ */ new Map();
  const queue = [{ name: CLAUDE_SDK_PACKAGE, range: requested, by: null }];
  let platformPackage = null;
  while (queue.length > 0) {
    const { name, range, by } = queue.shift();
    if (!PACKAGE_NAME.test(name)) fail("claude_sdk_metadata_invalid", `Package name refused: ${name}`);
    const existing = resolved.get(name);
    if (existing) {
      if (existing.version !== range && !satisfies(existing.version, range)) {
        fail("claude_sdk_dependency_conflict", `${name}@${existing.version} does not satisfy ${range} (needed by ${by})`);
      }
      continue;
    }
    const metadata = await metadataOf(name);
    const chosen = pickVersion(metadata, range);
    if (chosen === null) fail(
      name === CLAUDE_SDK_PACKAGE ? "claude_sdk_version_not_found" : "claude_sdk_dependency_unresolved",
      `No version of ${name} matches ${range}`
    );
    if (!VERSION_DIR.test(chosen)) fail("claude_sdk_metadata_invalid", `Version refused: ${chosen}`);
    const manifest = metadata.versions[chosen];
    if (!manifest?.dist?.tarball) fail("claude_sdk_metadata_invalid", `${name}@${chosen} has no tarball`);
    resolved.set(name, { name, version: chosen, tarball: manifest.dist.tarball, integrity: manifest.dist.integrity ?? null });
    if (resolved.size > MAX_PACKAGES) fail("claude_sdk_dependency_tree_too_large", "The SDK needs more packages than allowed");
    if (name === CLAUDE_SDK_PACKAGE) {
      const optional = manifest.optionalDependencies ?? {};
      const platformNames = Object.keys(optional).filter((item) => item.startsWith(`${CLAUDE_SDK_PACKAGE}-`));
      const wanted = sdkPlatformPackage(platform, arch);
      if (optional[wanted] !== void 0) {
        platformPackage = wanted;
        queue.push({ name: wanted, range: optional[wanted], by: `${name}@${chosen}` });
      } else if (platformNames.length > 0) {
        fail("claude_sdk_platform_unsupported", `The SDK ships no program for ${platform}-${arch}`);
      }
    }
    for (const [dependency, dependencyRange] of Object.entries(manifest.dependencies ?? {})) {
      queue.push({ name: dependency, range: dependencyRange, by: `${name}@${chosen}` });
    }
    const peerMeta = manifest.peerDependenciesMeta ?? {};
    for (const [peer, peerRange] of Object.entries(manifest.peerDependencies ?? {})) {
      if (peerMeta[peer]?.optional === true) continue;
      queue.push({ name: peer, range: peerRange, by: `${name}@${chosen}` });
    }
  }
  return { packages: [...resolved.values()], platformPackage };
}
async function readManifest(directory) {
  const manifest = await readJsonFile(path32.join(directory, SDK_MANIFEST), { invalidCode: "claude_sdk_manifest_invalid" }).catch(() => null);
  if (manifest?.schemaVersion !== 1 || manifest.kind !== "claude-agent-sdk" || typeof manifest.version !== "string") return null;
  return manifest;
}
function describeInstall(directory, manifest) {
  const sdkPath = packageDirectory(directory, CLAUDE_SDK_PACKAGE);
  return {
    version: manifest.version,
    directory,
    sdkPath,
    platformPackage: manifest.platformPackage ?? null,
    programPath: manifest.program ? path32.join(directory, ...manifest.program.split("/")) : null,
    packages: manifest.packages ?? [],
    installedAtUtc: manifest.installedAtUtc ?? null
  };
}
async function listInstalledSdks(layout) {
  const entries = await readdir12(layout.sdkRoot, { withFileTypes: true }).catch(() => []);
  const installs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name)) continue;
    const directory = path32.join(layout.sdkRoot, entry.name);
    const manifest = await readManifest(directory);
    if (manifest === null || manifest.version !== entry.name) continue;
    const described = describeInstall(directory, manifest);
    installs.push({
      ...described,
      sdkPresent: await pathKind(path32.join(described.sdkPath, "sdk.mjs")) === "file",
      programPresent: described.programPath !== null && await pathKind(described.programPath) === "file"
    });
  }
  return installs.sort((a, b) => compareVersions(b.version, a.version));
}
var PINNED_CLAUDE_SDK_VERSION = "0.3.288";
async function installClaudeSdk({
  layout,
  requested = PINNED_CLAUDE_SDK_VERSION,
  registry = DEFAULT_NPM_REGISTRY,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  arch = process.arch,
  maxDownloadBytes = 1024 * 1024 * 1024
}) {
  const registryUrl = normalizeRegistry(registry);
  if (typeof requested !== "string" || requested.trim() === "" || requested.length > 128) {
    fail("invalid_arguments", "--version names a version, range or dist-tag", { exitCode: 2 });
  }
  if (VERSION_DIR.test(requested)) {
    const existing2 = await readManifest(path32.join(layout.sdkRoot, requested));
    if (existing2?.version === requested) {
      return { state: "already-installed", requested, ...describeInstall(path32.join(layout.sdkRoot, requested), existing2) };
    }
  }
  const { packages, platformPackage } = await resolveSdkPackages({ registry: registryUrl, requested, fetchImpl, platform, arch });
  const sdkVersion = packages[0].version;
  const target = path32.join(layout.sdkRoot, sdkVersion);
  const existing = await readManifest(target);
  if (existing?.version === sdkVersion) return { state: "already-installed", requested, ...describeInstall(target, existing) };
  await mkdir20(layout.sdkRoot, { recursive: true });
  const staging = path32.join(layout.sdkRoot, `.staging-${randomUUID14()}`);
  const downloads = path32.join(staging, ".downloads");
  try {
    await mkdir20(downloads, { recursive: true });
    let downloadedBytes = 0;
    for (const [index, item] of packages.entries()) {
      const archive = path32.join(downloads, `${index}.tgz`);
      downloadedBytes += await download(item.tarball, archive, item.integrity, fetchImpl, maxDownloadBytes);
      const directory = packageDirectory(staging, item.name);
      await extractTarGz(archive, directory, { platform });
      const manifest = await readJsonFile(path32.join(directory, "package.json"), { invalidCode: "claude_sdk_package_mismatch" });
      if (manifest?.name !== item.name || manifest.version !== item.version) {
        fail("claude_sdk_package_mismatch", `The tarball of ${item.name}@${item.version} holds another package`);
      }
      await rm12(archive, { force: true });
    }
    await rm12(downloads, { recursive: true, force: true });
    if (await pathKind(path32.join(packageDirectory(staging, CLAUDE_SDK_PACKAGE), "sdk.mjs")) !== "file") {
      fail("claude_sdk_package_mismatch", "The SDK package has no sdk.mjs");
    }
    let program = null;
    if (platformPackage !== null) {
      const name = platform === "win32" ? "claude.exe" : "claude";
      const candidate = path32.join(packageDirectory(staging, platformPackage), name);
      if (await pathKind(candidate) === "file") program = ["node_modules", ...platformPackage.split("/"), name].join("/");
    }
    await writeJsonAtomic(path32.join(staging, SDK_MANIFEST), {
      schemaVersion: 1,
      kind: "claude-agent-sdk",
      version: sdkVersion,
      requested,
      registry: new URL(registryUrl).origin,
      platform: `${platform}-${arch}`,
      platformPackage,
      program,
      packages: packages.map(({ name, version: packageVersion, integrity }) => ({ name, version: packageVersion, integrity })),
      downloadedBytes,
      installedAtUtc: nowUtc()
    });
    if (await pathKind(target) !== null) {
      const trash = path32.join(layout.sdkRoot, `.trash-${randomUUID14()}`);
      await renameWithRetry(target, trash);
      await rm12(trash, { recursive: true, force: true });
    }
    await renameWithRetry(staging, target);
  } catch (error) {
    await rm12(staging, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
  return { state: "installed", requested, ...describeInstall(target, await readManifest(target)) };
}
async function inspectSdkPath(sdkPath, { platform = process.platform, arch = process.arch } = {}) {
  if (typeof sdkPath !== "string" || !path32.isAbsolute(sdkPath)) return { sdkPath: sdkPath ?? null, present: false, version: null, programPresent: false };
  const manifest = await readJsonFile(path32.join(sdkPath, "package.json")).catch(() => null);
  const program = path32.join(path32.dirname(sdkPath), `claude-agent-sdk-${platform}-${arch}`, platform === "win32" ? "claude.exe" : "claude");
  return {
    sdkPath,
    present: await pathKind(path32.join(sdkPath, "sdk.mjs")) === "file",
    version: typeof manifest?.version === "string" ? manifest.version : null,
    programPath: program,
    programPresent: await pathKind(program) === "file"
  };
}

// orchestrator/src/agents-factory-doctor.mjs
async function nearestExisting(target) {
  let probe = target;
  while (await pathKind(probe) === null && path33.dirname(probe) !== probe) probe = path33.dirname(probe);
  return probe;
}
async function check2(id5, action) {
  try {
    return { id: id5, ...await action() };
  } catch (error) {
    return {
      id: id5,
      status: "error",
      code: typeof error?.code === "string" ? error.code : "check_failed",
      hint: typeof error?.message === "string" ? error.message.slice(0, 300) : null
    };
  }
}
function loopbackAvailable() {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function runDoctor({
  layout,
  options = {},
  env = process.env,
  platform = process.platform,
  executor,
  keyStore,
  serviceManager = null
}) {
  const checks = [];
  const add = async (id5, action) => checks.push(await check2(id5, action));
  await add("runtime", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const sqlite = isBuiltin("node:sqlite");
    const ok = (major > 22 || major === 22 && minor >= 13) && sqlite;
    return {
      status: ok ? "ok" : "warning",
      node: process.version,
      electron: process.versions.electron ?? null,
      sqlite,
      ...ok ? {} : { hint: "Node 22.13 or newer (or Atlas's Electron Node) is needed for node:sqlite" }
    };
  });
  await add("git", async () => {
    const result = await executor.run("git", ["--version"], { env, timeoutMs: 15e3 });
    const version2 = /git version (\S+)/u.exec(result.stdout)?.[1] ?? null;
    return result.status === 0 ? { status: "ok", version: version2 } : { status: "warning", version: null, hint: "Install git: agents commit their work to the project's git" };
  });
  await add("data-dir", async () => {
    const probe = await nearestExisting(layout.dataDir);
    let writable = true;
    try {
      await access(probe, constants.W_OK);
    } catch {
      writable = false;
    }
    return {
      status: writable ? "ok" : "error",
      path: layout.dataDir,
      exists: await pathKind(layout.dataDir) === "directory",
      writable,
      ...writable ? {} : { hint: `No write access to ${probe}` }
    };
  });
  await add("disk", async () => {
    const info = await statfs(await nearestExisting(layout.dataDir));
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    return {
      status: freeBytes >= 2 * 1024 * 1024 * 1024 ? "ok" : "warning",
      freeBytes,
      ...freeBytes >= 2 * 1024 * 1024 * 1024 ? {} : { hint: "Less than 2 GB free: the SDK alone needs about 250 MB per version" }
    };
  });
  const instanceExists = await pathKind(layout.instanceDir) === "directory";
  await add("instance", async () => {
    if (!instanceExists) return { status: "error", path: layout.instanceDir, hint: "Run agents-factory setup --template <folder>" };
    const record = await readInstanceRecord(layout);
    const version2 = await readJsonFile(layout.projectVersion).catch(() => null);
    const cli = await pathKind(layout.installedGatewayCli) === "file" || await pathKind(layout.sourceGatewayCli) === "file";
    const ok = record !== null && cli && typeof version2?.projectName === "string";
    return {
      status: ok ? "ok" : "error",
      path: layout.instanceDir,
      schemaVersion: record?.schemaVersion ?? null,
      projectId: version2?.projectName ?? null,
      projectVersion: version2?.projectVersion ?? null,
      gatewayRuntime: cli,
      ...ok ? {} : { hint: record === null ? "No instance.json: run agents-factory setup" : "The instance lacks its Gateway runtime or project identity" }
    };
  });
  if (instanceExists && await pathKind(layout.instanceRecord) === "file") {
    await add("instance-schema", async () => {
      const plan = await migrateInstance({ layout, dryRun: true });
      return {
        status: plan.pending.length === 0 ? "ok" : "warning",
        schemaVersion: plan.schemaVersion,
        targetSchemaVersion: plan.targetSchemaVersion,
        pending: plan.pending.map((item) => item.id),
        ...plan.pending.length === 0 ? {} : { hint: "Run agents-factory migrate" }
      };
    });
    await add("mode", async () => {
      const mode = await readInstanceMode(layout.instanceDir);
      return {
        status: mode.missing.length === 0 ? "ok" : "warning",
        mode: mode.mode,
        recorded: mode.recorded,
        missing: mode.missing,
        ...mode.missing.length === 0 ? {} : { hint: "agents-factory instance mode --set synced --confirm synced --sync-config <file> --machine-id <id>" }
      };
    });
  }
  let providerConfig = null;
  await add("claude-provider", async () => {
    providerConfig = await readJsonFile(layout.claudeProvider, { invalidCode: "claude_provider_config_invalid" });
    if (providerConfig === null) return { status: "warning", path: layout.claudeProvider, hint: "Run agents-factory setup (it writes claude-provider.json)" };
    const valid = providerConfig.schemaVersion === 1 && typeof providerConfig.sdkPath === "string" && path33.isAbsolute(providerConfig.sdkPath);
    return {
      status: valid ? providerConfig.keepProviderVariables === true ? "ok" : "warning" : "error",
      path: layout.claudeProvider,
      keepProviderVariables: providerConfig.keepProviderVariables === true,
      ...valid ? providerConfig.keepProviderVariables === true ? {} : { hint: "keepProviderVariables is false: turns ignore the API key" } : { hint: "claude-provider.json is not valid schema 1" }
    };
  });
  let program = null;
  await add("claude-sdk", async () => {
    const installed = await listInstalledSdks(layout);
    const configured = providerConfig?.sdkPath ? await inspectSdkPath(providerConfig.sdkPath, { platform }) : null;
    program = configured?.programPresent ? configured.programPath : null;
    const ok = configured?.present === true && configured.programPresent === true;
    return {
      status: ok ? "ok" : configured?.present ? "warning" : "error",
      installed: installed.map((item) => item.version),
      configured,
      ...ok ? {} : { hint: configured?.present ? "The SDK has no Claude Code program for this platform" : "Run agents-factory claude install, then setup" }
    };
  });
  let hasKey = false;
  await add("api-key", async () => {
    const status = await keyStatus({ env, store: keyStore });
    hasKey = status.hasKey || status.environmentOverride;
    return {
      status: hasKey ? "ok" : "warning",
      ...status,
      ...hasKey ? {} : { hint: "Run agents-factory key set (the key is read from stdin)" }
    };
  });
  await add("claude-login", async () => {
    if (program === null) return { status: "skipped", reasonCode: "claude_program_missing" };
    const childEnv = { ...env };
    if (providerConfig?.keepProviderVariables === true && !childEnv.ANTHROPIC_API_KEY && hasKey) {
      const key = await keyStore.get().catch(() => null);
      if (key) childEnv.ANTHROPIC_API_KEY = key;
    }
    if (providerConfig?.keepProviderVariables !== true) delete childEnv.ANTHROPIC_API_KEY;
    const result = await executor.run(program, ["auth", "status", "--json"], { env: childEnv, timeoutMs: 2e4 });
    let parsed2 = null;
    try {
      parsed2 = JSON.parse(result.stdout);
    } catch {
      parsed2 = null;
    }
    const word = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : null;
    if (parsed2 === null) return { status: "warning", loggedIn: null, hint: "claude auth status gave no answer" };
    return {
      status: parsed2.loggedIn === true ? "ok" : "warning",
      loggedIn: parsed2.loggedIn === true,
      authMethod: word(parsed2.authMethod),
      apiProvider: word(parsed2.apiProvider),
      ...parsed2.loggedIn === true ? {} : { hint: "Claude Code is not signed in: store an API key with agents-factory key set" }
    };
  });
  await add("control-cycle", async () => {
    const present = await pathKind(layout.controlCycle) === "file";
    return { status: present ? "ok" : "warning", path: layout.controlCycle, ...present ? {} : { hint: "Run agents-factory setup" } };
  });
  await add("gateway", async () => {
    if (!instanceExists) return { status: "skipped", reasonCode: "instance_missing" };
    const context2 = await createGatewayContext({ layout, options, env, platform, executor });
    if (context2.cli === null) return { status: "error", reasonCode: "gateway_cli_unavailable" };
    const status = await gatewayStatus(context2);
    return {
      status: status.availability === "available" ? "ok" : "warning",
      availability: status.availability,
      reasonCode: status.reasonCode,
      lifecycle: status.lifecycle,
      ...status.availability === "available" ? {} : { hint: status.availability === "stale" ? "Run agents-factory gateway recover, then gateway start" : "Run agents-factory gateway start" }
    };
  });
  await add("loopback", async () => {
    const available = await loopbackAvailable();
    return { status: available ? "ok" : "error", ...available ? {} : { hint: "Cannot listen on 127.0.0.1: the Gateway binds loopback only" } };
  });
  if (serviceManager !== null) {
    await add("service", async () => {
      const status = await serviceManager.status();
      return { status: "ok", installed: status.installed, mechanism: status.mechanism };
    });
  }
  const errors = checks.filter((item) => item.status === "error").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  return { command: "doctor", instance: layout.instanceDir, dataDir: layout.dataDir, healthy: errors === 0, errors, warnings, checks };
}

// orchestrator/src/agents-factory-paths.mjs
import { existsSync as existsSync2 } from "node:fs";
import os2 from "node:os";
import path34 from "node:path";
var AGENTS_FACTORY_INSTANCE_ENV = "AGENTS_FACTORY_HOME";
var AGENTS_FACTORY_DATA_ENV = "AGENTS_FACTORY_DATA_DIR";
function pathApi(platform = process.platform) {
  return platform === "win32" ? path34.win32 : path34.posix;
}
function agentsFactoryDataDir({
  env = process.env,
  platform = process.platform,
  homeDir = os2.homedir()
} = {}) {
  const api = pathApi(platform);
  if (typeof env[AGENTS_FACTORY_DATA_ENV] === "string" && env[AGENTS_FACTORY_DATA_ENV].trim() !== "") {
    return api.resolve(env[AGENTS_FACTORY_DATA_ENV]);
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA && api.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : api.join(homeDir, "AppData", "Local");
    return api.join(local, "AgentsFactory");
  }
  if (platform === "darwin") return api.join(homeDir, "Library", "Application Support", "AgentsFactory");
  const xdg = env.XDG_DATA_HOME && api.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : api.join(homeDir, ".local", "share");
  return api.join(xdg, "agents-factory");
}
function instanceOfCli(cliPath, { platform = process.platform, exists: exists9 = existsSync2 } = {}) {
  if (typeof cliPath !== "string" || cliPath === "") return null;
  const api = pathApi(platform);
  const runtime = api.dirname(api.resolve(cliPath));
  const orchestrator = api.dirname(runtime);
  const same = (a, b) => platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(api.basename(cliPath), "agents-factory.mjs") || !same(api.basename(runtime), "runtime") || !same(api.basename(orchestrator), ".orchestrator")) return null;
  const instance = api.dirname(orchestrator);
  return exists9(api.join(instance, "instance.json")) ? instance : null;
}
function agentsFactoryLayout({ dataDir, instanceDir, platform = process.platform }) {
  const api = pathApi(platform);
  const runtime = api.join(instanceDir, ".project-local", "application-gateway");
  return Object.freeze({
    dataDir,
    instanceDir,
    secretsDir: api.join(dataDir, "secrets"),
    dpapiKeyFile: api.join(dataDir, "secrets", "anthropic-api-key.dpapi.json"),
    sdkRoot: api.join(dataDir, "runtime", "claude-agent-sdk"),
    serviceDir: api.join(dataDir, "service"),
    instanceRecord: api.join(instanceDir, "instance.json"),
    projectVersion: api.join(instanceDir, "project-version.json"),
    installedGatewayCli: api.join(instanceDir, ".orchestrator", "runtime", "application-gateway-cli.mjs"),
    sourceGatewayCli: api.join(instanceDir, "orchestrator", "src", "application-gateway-cli.mjs"),
    installedCli: api.join(instanceDir, ".orchestrator", "runtime", "agents-factory.mjs"),
    gatewayRuntime: runtime,
    gatewayStatus: api.join(runtime, "status.v1.json"),
    monitorStatus: api.join(runtime, "monitor-status.v1.json"),
    monitorOwner: api.join(runtime, "monitor-owner.v1.json"),
    claudeProvider: api.join(runtime, "claude-provider.json"),
    controlCycle: api.join(instanceDir, ".project-local", "orchestration", "control-cycle.json"),
    controlCycleExample: api.join(instanceDir, "config", "control-cycle.example.json"),
    logsDir: api.join(instanceDir, "logs"),
    gatewayLog: api.join(instanceDir, "logs", "application_gateway.log"),
    gatewayErrorLog: api.join(instanceDir, "logs", "application_gateway.error.log"),
    monitorErrorLog: api.join(instanceDir, "logs", "application_gateway.monitor.error.log"),
    backupsDir: api.join(instanceDir, ".project-local", "backups")
  });
}
function resolveLayout({
  options = {},
  env = process.env,
  platform = process.platform,
  homeDir = os2.homedir(),
  cliPath = null,
  exists: exists9 = existsSync2
} = {}) {
  const api = pathApi(platform);
  const dataDir = options["data-dir"] ? api.resolve(options["data-dir"]) : agentsFactoryDataDir({ env, platform, homeDir });
  const instanceDir = options.instance ? api.resolve(options.instance) : typeof env[AGENTS_FACTORY_INSTANCE_ENV] === "string" && env[AGENTS_FACTORY_INSTANCE_ENV].trim() !== "" ? api.resolve(env[AGENTS_FACTORY_INSTANCE_ENV]) : instanceOfCli(cliPath, { platform, exists: exists9 }) ?? api.join(dataDir, "controller");
  return agentsFactoryLayout({ dataDir, instanceDir, platform });
}

// orchestrator/src/agents-factory-service.mjs
import { createHash as createHash20 } from "node:crypto";
import { mkdir as mkdir21, readFile as readFile22, rm as rm13, writeFile as writeFile14 } from "node:fs/promises";
import os3 from "node:os";
import path35 from "node:path";
var SERVICE_MECHANISMS = Object.freeze(["task-scheduler", "hkcu-run", "launch-agent", "systemd-user"]);
var RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
var UNSAFE_FOR_CMD = /["%^&|<>!\r\n]/u;
function serviceIdentity(instanceDir, platform = process.platform) {
  const normalized = platform === "win32" ? instanceDir.toLowerCase() : instanceDir;
  const hash2 = createHash20("sha256").update(normalized).digest("hex").slice(0, 10);
  return {
    hash: hash2,
    windowsName: `AgentsFactory-Gateway-${hash2}`,
    launchdLabel: `com.agentsfactory.gateway.${hash2}`,
    systemdUnit: `agents-factory-gateway-${hash2}.service`
  };
}
function xml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}
function systemdQuote(value) {
  const text3 = String(value);
  if (/[\r\n]/u.test(text3)) fail("service_path_unsupported", "A path has a line break", { exitCode: 2 });
  return `"${text3.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/%/gu, "%%").replace(/\$/gu, "$$$$")}"`;
}
function serviceCommand({ nodePath, cliPath, instanceDir, provider = "claude", electron = false }) {
  const args = [cliPath, "gateway", "start", "--instance", instanceDir, "--provider", provider, "--json"];
  return { nodePath, args, electron };
}
function windowsAction(command, env) {
  if (!command.electron) return { file: command.nodePath, args: command.args };
  for (const value of [command.nodePath, ...command.args]) {
    if (UNSAFE_FOR_CMD.test(value)) fail("service_path_unsupported", "A path has characters cmd.exe cannot pass safely", { exitCode: 2 });
  }
  const cmd = path35.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "cmd.exe");
  const inner = [command.nodePath, ...command.args].map((value) => `"${value}"`).join(" ");
  return { file: cmd, args: ["/d", "/c", `set ELECTRON_RUN_AS_NODE=1&& ${inner}`], verbatim: true };
}
function windowsTaskXml({ name, action, userId, workingDirectory, description }) {
  const argumentsText = action.verbatim ? action.args.join(" ") : action.args.map(quoteWindowsArgument).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(description)}</Description>
    <URI>\\${xml(name)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId)}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(action.file)}</Command>
      <Arguments>${xml(argumentsText)}</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}
function launchAgentPlist({ label, command, workingDirectory, logFile }) {
  const strings = [command.nodePath, ...command.args].map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const environment = command.electron ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>${environment}
</dict>
</plist>
`;
}
function systemdUnit({ command, workingDirectory, instanceDir }) {
  const start = [command.nodePath, ...command.args].map(systemdQuote).join(" ");
  const stopArgs = [command.args[0], "gateway", "stop", "--instance", instanceDir, "--json"];
  const stop = [command.nodePath, ...stopArgs].map(systemdQuote).join(" ");
  return `[Unit]
Description=Agents Factory Gateway (${instanceDir.replace(/[\r\n]/gu, " ")})

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${systemdQuote(workingDirectory)}
${command.electron ? "Environment=ELECTRON_RUN_AS_NODE=1\n" : ""}ExecStart=${start}
ExecStop=${stop}
TimeoutStartSec=180
TimeoutStopSec=90

[Install]
WantedBy=default.target
`;
}
var realFiles = Object.freeze({
  async write(file, content, encoding) {
    await mkdir21(path35.dirname(file), { recursive: true });
    await writeFile14(file, content, encoding === "utf16le" ? { encoding: null } : { encoding: "utf8" });
  },
  async remove(file) {
    await rm13(file, { force: true });
  },
  async read(file) {
    return readFile22(file, "utf8").catch(() => null);
  },
  async exists(file) {
    return await pathKind(file) === "file";
  }
});
function utf16(content) {
  return Buffer.concat([Buffer.from([255, 254]), Buffer.from(content, "utf16le")]);
}
function createServiceManager({
  platform = process.platform,
  env = process.env,
  homeDir = os3.homedir(),
  executor = defaultExecutor,
  files = realFiles,
  layout,
  userId = null,
  uid = null
}) {
  const api = pathApi(platform);
  const identity = serviceIdentity(layout.instanceDir, platform);
  const windowsUser = userId ?? `${env.USERDOMAIN ? `${env.USERDOMAIN}\\` : ""}${env.USERNAME ?? os3.userInfo().username}`;
  const launchdUid = uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const plistPath = api.join(homeDir, "Library", "LaunchAgents", `${identity.launchdLabel}.plist`);
  const configHome = env.XDG_CONFIG_HOME && api.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : api.join(homeDir, ".config");
  const unitPath = api.join(configHome, "systemd", "user", identity.systemdUnit);
  const schtasks = api.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "schtasks.exe");
  const reg = api.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "reg.exe");
  function windowsTaskPlan(command) {
    const action = windowsAction(command, env);
    const content = windowsTaskXml({
      name: identity.windowsName,
      action,
      userId: windowsUser,
      workingDirectory: layout.instanceDir,
      description: `${identity.windowsName} starts the Agents Factory Gateway of ${layout.instanceDir} at logon`
    });
    const xmlFile = api.join(layout.serviceDir, `${identity.windowsName}.xml`);
    return {
      mechanism: "task-scheduler",
      name: identity.windowsName,
      userId: windowsUser,
      actions: [
        { kind: "write-file", path: xmlFile, encoding: "utf16le", content },
        { kind: "run", file: schtasks, args: ["/Create", "/TN", identity.windowsName, "/XML", xmlFile, "/F"] },
        { kind: "remove-file", path: xmlFile }
      ]
    };
  }
  function runKeyPlan(command) {
    const action = windowsAction(command, env);
    const value = action.verbatim ? `${quoteWindowsArgument(action.file)} ${action.args.join(" ")}` : windowsCommandLine(action.file, action.args);
    return {
      mechanism: "hkcu-run",
      name: identity.windowsName,
      commandLine: value,
      ...value.length > 260 ? { warning: "run_command_long" } : {},
      actions: [{ kind: "run", file: reg, args: ["add", RUN_KEY, "/v", identity.windowsName, "/t", "REG_SZ", "/d", value, "/f"] }]
    };
  }
  function launchAgentPlan(command) {
    const content = launchAgentPlist({
      label: identity.launchdLabel,
      command,
      workingDirectory: layout.instanceDir,
      logFile: api.join(layout.instanceDir, "logs", "agents-factory-service.log")
    });
    return {
      mechanism: "launch-agent",
      name: identity.launchdLabel,
      path: plistPath,
      actions: [{ kind: "write-file", path: plistPath, encoding: "utf8", content }]
    };
  }
  function systemdPlan(command) {
    const content = systemdUnit({ command, workingDirectory: layout.instanceDir, instanceDir: layout.instanceDir });
    return {
      mechanism: "systemd-user",
      name: identity.systemdUnit,
      path: unitPath,
      actions: [
        { kind: "write-file", path: unitPath, encoding: "utf8", content },
        { kind: "run", file: "systemctl", args: ["--user", "daemon-reload"] },
        { kind: "run", file: "systemctl", args: ["--user", "enable", identity.systemdUnit] }
      ]
    };
  }
  async function perform(plan) {
    const cleanup = plan.actions.filter((action) => action.kind === "remove-file");
    try {
      for (const action of plan.actions) {
        if (action.kind === "write-file") {
          await files.write(action.path, action.encoding === "utf16le" ? utf16(action.content) : action.content, action.encoding);
        } else if (action.kind === "run") {
          const result = await executor.run(action.file, action.args, { env, timeoutMs: 6e4 });
          if (result.status !== 0) {
            return {
              ok: false,
              status: result.status,
              errorCode: result.errorCode ?? null,
              accessDenied: /access is denied|0x80070005|denied/iu.test(`${result.stdout}
${result.stderr}`)
            };
          }
        }
      }
      return { ok: true };
    } finally {
      for (const action of cleanup) await files.remove(action.path).catch(() => {
      });
    }
  }
  function plansFor(command, mechanism) {
    if (platform === "win32") {
      if (mechanism === "hkcu-run") return [runKeyPlan(command)];
      if (mechanism === "task-scheduler") return [windowsTaskPlan(command)];
      return [windowsTaskPlan(command), runKeyPlan(command)];
    }
    if (platform === "darwin") return [launchAgentPlan(command)];
    if (platform === "linux") return [systemdPlan(command)];
    return fail("service_platform_unsupported", `No user service for ${platform}`);
  }
  async function status() {
    if (platform === "win32") {
      const task = await executor.run(schtasks, ["/Query", "/TN", identity.windowsName, "/XML"], { env, timeoutMs: 3e4 });
      const run3 = await executor.run(reg, ["query", RUN_KEY, "/v", identity.windowsName], { env, timeoutMs: 3e4 });
      const mechanisms = [];
      if (task.status === 0) mechanisms.push("task-scheduler");
      if (run3.status === 0) mechanisms.push("hkcu-run");
      return { installed: mechanisms.length > 0, mechanism: mechanisms[0] ?? null, mechanisms, name: identity.windowsName };
    }
    if (platform === "darwin") {
      const present2 = await files.exists(plistPath);
      const loaded = await executor.run("/bin/launchctl", ["print", `gui/${launchdUid}/${identity.launchdLabel}`], { env, timeoutMs: 3e4 });
      return {
        installed: present2,
        mechanism: present2 ? "launch-agent" : null,
        mechanisms: present2 ? ["launch-agent"] : [],
        name: identity.launchdLabel,
        path: plistPath,
        loaded: loaded.status === 0
      };
    }
    const present = await files.exists(unitPath);
    const enabled = await executor.run("systemctl", ["--user", "is-enabled", identity.systemdUnit], { env, timeoutMs: 3e4 });
    return {
      installed: present,
      mechanism: present ? "systemd-user" : null,
      mechanisms: present ? ["systemd-user"] : [],
      name: identity.systemdUnit,
      path: unitPath,
      enabled: enabled.status === 0 && enabled.stdout.trim() === "enabled"
    };
  }
  return Object.freeze({
    identity,
    plan(command, { mechanism = "auto" } = {}) {
      const plans = plansFor(command, mechanism);
      return {
        command: "service install",
        planOnly: true,
        platform,
        primary: plans[0],
        fallback: plans[1] ?? null,
        activatesAt: "next-logon"
      };
    },
    async install(command, { mechanism = "auto" } = {}) {
      const plans = plansFor(command, mechanism);
      let fallbackFrom = null;
      for (const [index, plan] of plans.entries()) {
        const outcome = await perform(plan);
        if (outcome.ok) {
          return {
            command: "service install",
            platform,
            installed: true,
            mechanism: plan.mechanism,
            name: plan.name,
            path: plan.path ?? null,
            activatesAt: "next-logon",
            fallbackFrom,
            commandLine: [command.nodePath, ...command.args]
          };
        }
        if (index + 1 < plans.length && plan.mechanism === "task-scheduler") {
          fallbackFrom = { mechanism: plan.mechanism, status: outcome.status, accessDenied: outcome.accessDenied };
          continue;
        }
        fail(
          "service_install_failed",
          `${plan.mechanism} registration failed`,
          { detail: { mechanism: plan.mechanism, status: outcome.status, errorCode: outcome.errorCode } }
        );
      }
      return fail("service_install_failed", "No registration succeeded");
    },
    async uninstall({ planOnly = false } = {}) {
      const actions = [];
      if (platform === "win32") {
        actions.push({ kind: "run", file: schtasks, args: ["/Delete", "/TN", identity.windowsName, "/F"], present: "task-scheduler" });
        actions.push({ kind: "run", file: reg, args: ["delete", RUN_KEY, "/v", identity.windowsName, "/f"], present: "hkcu-run" });
      } else if (platform === "darwin") {
        actions.push({ kind: "run", file: "/bin/launchctl", args: ["bootout", `gui/${launchdUid}/${identity.launchdLabel}`], optional: true });
        actions.push({ kind: "remove-file", path: plistPath });
      } else {
        actions.push({ kind: "run", file: "systemctl", args: ["--user", "disable", identity.systemdUnit], present: "systemd-user" });
        actions.push({ kind: "remove-file", path: unitPath });
        actions.push({ kind: "run", file: "systemctl", args: ["--user", "daemon-reload"], optional: true });
      }
      if (planOnly) return { command: "service uninstall", planOnly: true, platform, actions };
      const before = await status();
      for (const action of actions) {
        if (action.kind === "remove-file") {
          await files.remove(action.path);
          continue;
        }
        if (action.present && !before.mechanisms.includes(action.present)) continue;
        const result = await executor.run(action.file, action.args, { env, timeoutMs: 6e4 });
        if (result.status !== 0 && !action.optional) {
          fail(
            "service_uninstall_failed",
            `${path35.basename(action.file)} could not remove the registration`,
            { detail: { status: result.status } }
          );
        }
      }
      return { command: "service uninstall", platform, removed: before.installed, mechanisms: before.mechanisms, name: before.name };
    },
    async status() {
      return { command: "service status", platform, ...await status() };
    }
  });
}

// orchestrator/src/agents-factory-setup.mjs
import { randomUUID as randomUUID15 } from "node:crypto";
import { copyFile as copyFile6, mkdir as mkdir22, readdir as readdir13, rm as rm14, rmdir as rmdir2, statfs as statfs2, writeFile as writeFile15 } from "node:fs/promises";
import path36 from "node:path";
var DEFAULT_CLAUDE_MODELS = Object.freeze([
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", efforts: ["default"], defaultEffort: "default" }
]);
async function isEmptyDirectory(directory) {
  return (await readdir13(directory)).length === 0;
}
async function copyTree2(source, target) {
  await mkdir22(target, { recursive: true });
  for (const entry of await readdir13(source, { withFileTypes: true })) {
    const from = path36.join(source, entry.name);
    const to = path36.join(target, entry.name);
    if (entry.isSymbolicLink()) fail("template_link_refused", `The template contains a link: ${from}`);
    if (entry.isDirectory()) await copyTree2(from, to);
    else if (entry.isFile()) await copyFile6(from, to);
    else fail("template_entry_refused", `The template contains a special file: ${from}`);
  }
}
async function validateTemplate(template) {
  if (!template) fail("template_required", "A new instance needs --template <folder>", { exitCode: 2 });
  const root = path36.resolve(template);
  if (await pathKind(root) !== "directory") fail("template_invalid", `The template is not a folder: ${root}`);
  const version2 = await readJsonFile(path36.join(root, "project-version.json"), { invalidCode: "template_invalid" });
  if (typeof version2?.projectName !== "string") fail("template_invalid", "The template has no project-version.json with projectName");
  if (await pathKind(path36.join(root, ".orchestrator", "runtime", "application-gateway-cli.mjs")) !== "file") {
    fail("template_invalid", "The template has no .orchestrator/runtime/application-gateway-cli.mjs");
  }
  return root;
}
async function instanceStep(layout, { template, cliVersion }) {
  const createdBy = `agents-factory ${cliVersion}`;
  const kind2 = await pathKind(layout.instanceDir);
  if (kind2 === "directory" && await pathKind(layout.instanceRecord) === "file") {
    const record = await readInstanceRecord(layout);
    return { step: "instance", status: "existing", path: layout.instanceDir, schemaVersion: record.schemaVersion };
  }
  if (kind2 === "directory" && !await isEmptyDirectory(layout.instanceDir)) {
    if (await pathKind(layout.projectVersion) === "file" && await pathKind(layout.installedGatewayCli) === "file") {
      const record = newInstanceRecord({ createdBy, schemaVersion: 1 });
      await writeJsonAtomic(layout.instanceRecord, record);
      return { step: "instance", status: "adopted", path: layout.instanceDir, schemaVersion: record.schemaVersion };
    }
    fail("instance_folder_not_empty", `The instance folder is not empty and is not a controller: ${layout.instanceDir}`);
  }
  if (kind2 !== null && kind2 !== "directory") fail("instance_folder_invalid", `The instance path is not a folder: ${layout.instanceDir}`);
  const source = await validateTemplate(template);
  const relative = path36.relative(source, layout.instanceDir);
  if (relative === "" || !relative.startsWith("..") && !path36.isAbsolute(relative)) {
    fail("instance_inside_template", "The instance cannot be inside its template", { exitCode: 2 });
  }
  const parent = path36.dirname(layout.instanceDir);
  await mkdir22(parent, { recursive: true });
  const staging = path36.join(parent, `.${path36.basename(layout.instanceDir)}.staging-${randomUUID15()}`);
  try {
    await copyTree2(source, staging);
    const record = newInstanceRecord({ createdBy });
    await writeJsonAtomic(path36.join(staging, "instance.json"), record);
    await writeStoreLayoutMarker(staging);
    if (kind2 === "directory") await rmdir2(layout.instanceDir);
    await renameWithRetry(staging, layout.instanceDir);
    return { step: "instance", status: "created", path: layout.instanceDir, template: source, schemaVersion: record.schemaVersion };
  } catch (error) {
    await rm14(staging, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
}
async function sdkStep(layout, options, { fetchImpl, env, platform }) {
  if (options["sdk-path"]) {
    const sdkPath = path36.resolve(options["sdk-path"]);
    if (await pathKind(path36.join(sdkPath, "sdk.mjs")) !== "file") {
      fail("sdk_path_invalid", `No Claude Agent SDK (sdk.mjs) at ${sdkPath}`, { exitCode: 2 });
    }
    return { step: "claude-sdk", status: "provided", sdkPath, version: null };
  }
  if (options["install-sdk"]) {
    const installed2 = await installClaudeSdk({
      layout,
      requested: options["sdk-version"] ?? PINNED_CLAUDE_SDK_VERSION,
      registry: options.registry ?? env.AGENTS_FACTORY_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY,
      fetchImpl,
      platform
    });
    return { step: "claude-sdk", status: installed2.state, sdkPath: installed2.sdkPath, version: installed2.version };
  }
  const existing = await readJsonFile(layout.claudeProvider, { invalidCode: "claude_provider_config_invalid" });
  if (typeof existing?.sdkPath === "string" && path36.isAbsolute(existing.sdkPath) && await pathKind(path36.join(existing.sdkPath, "sdk.mjs")) === "file") {
    return { step: "claude-sdk", status: "configured", sdkPath: existing.sdkPath, version: null };
  }
  const installed = (await listInstalledSdks(layout)).find((item) => item.sdkPresent);
  if (installed) return { step: "claude-sdk", status: "found", sdkPath: installed.sdkPath, version: installed.version };
  return { step: "claude-sdk", status: "skipped", reasonCode: "sdk_not_installed", sdkPath: null, version: null };
}
async function providerStep(layout, sdkPath) {
  const existing = await readJsonFile(layout.claudeProvider, { invalidCode: "claude_provider_config_invalid" });
  if (existing !== null) {
    if (typeof existing !== "object" || Array.isArray(existing) || existing.schemaVersion !== 1) {
      fail("claude_provider_config_invalid", "claude-provider.json is not schema 1; it was left unchanged");
    }
    const next = { ...existing, ...sdkPath ? { sdkPath } : {}, keepProviderVariables: true };
    if (typeof next.sdkPath !== "string") return { step: "claude-provider", status: "skipped", reasonCode: "sdk_not_installed", path: layout.claudeProvider };
    if (JSON.stringify(next) === JSON.stringify(existing)) {
      return { step: "claude-provider", status: "unchanged", path: layout.claudeProvider, sdkPath: next.sdkPath, keepProviderVariables: true };
    }
    await writeJsonAtomic(layout.claudeProvider, next);
    return { step: "claude-provider", status: "updated", path: layout.claudeProvider, sdkPath: next.sdkPath, keepProviderVariables: true };
  }
  if (!sdkPath) return { step: "claude-provider", status: "skipped", reasonCode: "sdk_not_installed", path: layout.claudeProvider };
  await writeJsonAtomic(layout.claudeProvider, {
    schemaVersion: 1,
    sdkPath,
    claudeConfigDir: null,
    keepProviderVariables: true,
    models: DEFAULT_CLAUDE_MODELS.map((model) => ({ ...model })),
    settingSources: ["project", "local"],
    permissionMode: "acceptEdits"
  });
  return { step: "claude-provider", status: "created", path: layout.claudeProvider, sdkPath, keepProviderVariables: true };
}
async function configureClaudeProvider(layout, sdkPath) {
  return providerStep(layout, sdkPath);
}
async function controlCycleStep(layout) {
  if (await pathKind(layout.controlCycle) === "file") return { step: "control-cycle", status: "existing", path: layout.controlCycle };
  if (await pathKind(layout.controlCycleExample) !== "file") {
    return { step: "control-cycle", status: "skipped", reasonCode: "control_cycle_example_missing", path: layout.controlCycle };
  }
  const example = await readJsonFile(layout.controlCycleExample, { invalidCode: "control_cycle_example_invalid" });
  await writeJsonAtomic(layout.controlCycle, example);
  return { step: "control-cycle", status: "created", path: layout.controlCycle, from: layout.controlCycleExample };
}
async function atlasStep(layout, options) {
  const file = options["atlas-config"] ? path36.resolve(options["atlas-config"]) : null;
  if (file === null) return { step: "atlas-config", status: "skipped", reasonCode: "not_requested" };
  if (options.headless) return { step: "atlas-config", status: "skipped", reasonCode: "headless", path: file };
  const status = await readJsonFile(layout.gatewayStatus, { invalidCode: "gateway_status_invalid" });
  const workspace = status?.identity?.workspace;
  if (!workspace) return { step: "atlas-config", status: "skipped", reasonCode: "gateway_status_missing", path: file };
  if (typeof workspace.projectId !== "string" || !/^[a-f0-9]{64}$/u.test(workspace.workspaceRootSha256 ?? "")) {
    fail("gateway_status_invalid", "status.v1.json carries no workspace identity");
  }
  const expectedWorkspace = { projectId: workspace.projectId, workspaceRootSha256: workspace.workspaceRootSha256 };
  const existing = await readJsonFile(file, { invalidCode: "atlas_config_invalid" });
  const same = existing !== null && typeof existing.controllerRoot === "string" && path36.resolve(existing.controllerRoot) === layout.instanceDir && existing.expectedWorkspace?.projectId === expectedWorkspace.projectId && existing.expectedWorkspace?.workspaceRootSha256 === expectedWorkspace.workspaceRootSha256;
  if (same) return { step: "atlas-config", status: "unchanged", path: file, controllerRoot: layout.instanceDir, expectedWorkspace };
  const configured = existing !== null && typeof existing.controllerRoot === "string" && !existing.controllerRoot.trim().startsWith("<");
  if (configured && !options["replace-atlas-config"]) {
    fail("atlas_config_conflict", "The Atlas config names another controller; pass --replace-atlas-config to switch");
  }
  const base = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  await writeJsonAtomic(file, { ...base, controllerRoot: layout.instanceDir, expectedWorkspace });
  return {
    step: "atlas-config",
    status: existing === null ? "created" : "updated",
    path: file,
    controllerRoot: layout.instanceDir,
    expectedWorkspace
  };
}
async function launcherStep(layout, options, platform) {
  const file = path36.join(layout.instanceDir, ".project-local", "launch.cmd");
  if (platform !== "win32") return { step: "launcher", status: "skipped", reasonCode: "not_windows" };
  if (!options["atlas-config"] || options.headless) return { step: "launcher", status: "skipped", reasonCode: "no_atlas" };
  const atlas = path36.dirname(path36.dirname(path36.resolve(options["atlas-config"])));
  if (await pathKind(file) !== null) return { step: "launcher", status: "kept", path: file };
  await mkdir22(path36.dirname(file), { recursive: true });
  const lines2 = [
    "@rem This PC's paths for start-atlas.bat and claude-login.bat (machine-local, never synced).",
    "@rem Written by agents-factory setup; edit freely, setup keeps it.",
    `@set "NODE=${process.execPath}"`,
    `@set "ATLAS=${atlas}"`,
    ""
  ];
  await writeFile15(file, lines2.join("\r\n"), "utf8");
  return { step: "launcher", status: "created", path: file, node: process.execPath, atlas };
}
async function environmentStep(layout) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const warnings = [];
  if (major < 22 || major === 22 && minor < 13) warnings.push("node_older_than_22_13");
  let freeBytes = null;
  try {
    let probe = layout.dataDir;
    while (await pathKind(probe) === null && path36.dirname(probe) !== probe) probe = path36.dirname(probe);
    const info = await statfs2(probe);
    freeBytes = Number(info.bavail) * Number(info.bsize);
    if (freeBytes < 2 * 1024 * 1024 * 1024) warnings.push("disk_space_low");
  } catch {
    warnings.push("disk_space_unknown");
  }
  return {
    step: "environment",
    status: warnings.length === 0 ? "ok" : "warning",
    node: process.version,
    electron: process.versions.electron ?? null,
    freeBytes,
    warnings
  };
}
async function modeStep(layout, options) {
  try {
    if (typeof options.mode !== "string") {
      const current = await readInstanceMode(layout.instanceDir);
      return { step: "mode", status: "kept", mode: current.mode, missing: current.missing };
    }
    const result = await setInstanceMode({
      controllerRoot: layout.instanceDir,
      mode: options.mode,
      confirm: options.mode,
      syncConfig: typeof options["sync-config"] === "string" ? path36.resolve(options["sync-config"]) : null,
      machine: typeof options["machine-id"] === "string" ? {
        machineId: options["machine-id"],
        title: typeof options["machine-title"] === "string" ? options["machine-title"] : null,
        home: options.home === true ? true : null
      } : null
    });
    return {
      step: "mode",
      status: result.previous === result.mode ? "kept" : "set",
      mode: result.mode,
      previous: result.previous,
      missing: result.missing
    };
  } catch (error) {
    if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
    throw error;
  }
}
async function runSetup({
  layout,
  options = {},
  env = process.env,
  platform = process.platform,
  executor,
  launcher = null,
  keyStore = null,
  fetchImpl = globalThis.fetch,
  cliVersion
}) {
  const steps = [];
  const run3 = async (name, action) => {
    try {
      const result = await action();
      steps.push(result);
      return result;
    } catch (error) {
      const code = error instanceof AgentsFactoryError ? error.code : "setup_step_failed";
      steps.push({ step: name, status: "failed", code, ...error?.detail ? { detail: error.detail } : {} });
      throw new AgentsFactoryError(code, error?.message ?? code, {
        exitCode: error?.exitCode ?? 1,
        detail: { failedStep: name, steps }
      });
    }
  };
  await run3("environment", () => environmentStep(layout));
  await run3("instance", () => instanceStep(layout, { template: options.template, cliVersion }));
  await run3("instance-schema", async () => {
    const migrated = await migrateInstance({ layout });
    return {
      step: "instance-schema",
      status: migrated.state,
      schemaVersion: migrated.schemaVersion,
      applied: migrated.applied,
      backup: migrated.backup?.path ?? null
    };
  });
  await run3("mode", () => modeStep(layout, options));
  const sdk = await run3("claude-sdk", () => sdkStep(layout, options, { fetchImpl, env, platform }));
  const provider = await run3("claude-provider", () => providerStep(layout, sdk.sdkPath));
  await run3("control-cycle", () => controlCycleStep(layout));
  const gatewayProvider = options.provider ?? "claude";
  await run3("gateway", async () => {
    if (options["no-start"]) return { step: "gateway", status: "skipped", reasonCode: "no_start" };
    if (gatewayProvider === "claude" && provider.status === "skipped") {
      return { step: "gateway", status: "skipped", reasonCode: "claude_provider_not_configured" };
    }
    const context2 = await createGatewayContext({ layout, options, env, platform, executor, launcher, keyStore });
    const started = await gatewayStart(context2, {
      provider: gatewayProvider,
      timeoutMs: options["timeout-seconds"] ? Number(options["timeout-seconds"]) * 1e3 : 3e4
    });
    return {
      step: "gateway",
      status: started.launched ? "started" : "already-running",
      instanceId: started.instanceId,
      processId: started.processId,
      monitorId: started.monitorId,
      apiKeySource: started.apiKeySource
    };
  });
  await run3("atlas-config", () => atlasStep(layout, options));
  await run3("launcher", () => launcherStep(layout, options, platform));
  return { command: "setup", instance: layout.instanceDir, dataDir: layout.dataDir, steps };
}

// orchestrator/src/agents-factory-commands.mjs
var AGENTS_FACTORY_CLI_VERSION = "v0.2.0";
var GLOBAL_OPTIONS = Object.freeze({
  instance: "value",
  "data-dir": "value",
  json: "flag",
  yes: "flag",
  "non-interactive": "flag",
  node: "value"
});
var COMMANDS2 = Object.freeze({
  "gateway start": { provider: "value", "visible-monitor": "flag", "project-id": "value", "timeout-seconds": "value", "plan-only": "flag" },
  "gateway stop": { "project-id": "value", "timeout-seconds": "value", "plan-only": "flag" },
  "gateway status": { "project-id": "value" },
  "gateway recover": { "project-id": "value", "plan-only": "flag" },
  "gateway logs": { lines: "value", follow: "flag" },
  "service install": { "plan-only": "flag", provider: "value", mechanism: "value", cli: "value" },
  "service uninstall": { "plan-only": "flag" },
  "service status": {},
  "key set": {},
  "key status": {},
  "key remove": {},
  "claude install": { version: "value", registry: "value", configure: "flag" },
  "claude status": {},
  "project export": { project: "value", out: "value", "home-only": "flag", "only-on": "value", machine: "value" },
  "project import": { package: "value" },
  "project migrate-layout": {},
  "project unmount": { project: "value", out: "value", confirm: "value", "home-only": "flag", "only-on": "value" },
  "project mount": { package: "value" },
  "instance move": {
    to: "value",
    confirm: "value",
    "atlas-config": "value",
    "machine-id": "value",
    "machine-title": "value",
    home: "flag"
  },
  "instance relocate": { from: "value", confirm: "value", "atlas-config": "value" },
  "instance mode": {
    set: "value",
    confirm: "value",
    "sync-config": "value",
    "machine-id": "value",
    "machine-title": "value",
    home: "flag"
  },
  "machine set": { id: "value", title: "value", home: "flag" },
  "machine status": {},
  "sync status": { remote: "flag" },
  "sync init": { confirm: "value" },
  "sync take": { world: "flag", project: "value", confirm: "value" },
  "sync release": { world: "flag", project: "value", confirm: "value" },
  "sync recover": { apply: "flag", confirm: "value" },
  setup: {
    template: "value",
    "atlas-config": "value",
    "replace-atlas-config": "flag",
    "install-sdk": "flag",
    "sdk-version": "value",
    "sdk-path": "value",
    registry: "value",
    "no-start": "flag",
    provider: "value",
    headless: "flag",
    "timeout-seconds": "value",
    "project-id": "value",
    mode: "value",
    "sync-config": "value",
    "machine-id": "value",
    "machine-title": "value",
    home: "flag"
  },
  doctor: {},
  migrate: { "dry-run": "flag" },
  version: {},
  help: {}
});
var GROUPS = /* @__PURE__ */ new Set(["gateway", "service", "key", "claude", "project", "instance", "machine", "sync"]);
function policyOption(options) {
  const onlyOn = typeof options["only-on"] === "string" ? options["only-on"].split(",").map((item) => item.trim()).filter(Boolean) : null;
  if (options["home-only"] !== true && onlyOn === null) return null;
  try {
    return projectPolicy({ homeOnly: options["home-only"] === true, allowedMachines: onlyOn });
  } catch {
    return usage("--only-on needs machine ids (letters, digits, '-' or '_'), separated by commas");
  }
}
var HELP_TEXT = `agents-factory ${AGENTS_FACTORY_CLI_VERSION}

Usage: agents-factory <command> [options] [--instance <folder>] [--data-dir <folder>] [--json]

  gateway start [--provider claude] [--visible-monitor] [--timeout-seconds N] [--plan-only]
  gateway stop [--timeout-seconds N] [--plan-only]
  gateway status
  gateway recover [--plan-only]
  gateway logs [--lines N] [--follow]
  service install [--plan-only] [--provider claude] [--mechanism auto|task-scheduler|hkcu-run]
  service uninstall [--plan-only]
  service status
  key set            (the key is read from stdin, never from arguments)
  key status
  key remove
  claude install [--version <version|range|tag>, default 0.3.288] [--registry <url>] [--configure]
  claude status
  project export --project <id> --out <package folder> [--home-only] [--only-on <machine>[,<machine>]] [--machine <id>]
  project import --package <package folder>      (split layout only)
  project migrate-layout                         (one memory DB per project; Gateway stopped)
  project unmount --project <id> --out <package folder> --confirm <id> [--home-only] [--only-on <machine>[,...]]
                                                 (export, then off this PC)
  project mount --package <package folder>       (back on this PC)
  instance move --to <new folder> --confirm <new folder> [--atlas-config <file>]
               [--machine-id <id> [--machine-title <text>] [--home]]
                                                 (copy, rewrite paths, split layout; the old folder stays as the
                                                 backup and its Gateway no longer starts; Gateway stopped)
  instance relocate --from <old folder> --confirm <old folder> [--atlas-config <file>]
                                                 (after the instance folder moved; Gateway stopped)
  instance mode [--set local|synced --confirm <mode>] [--sync-config <file>] [--machine-id <id> [--machine-title <text>] [--home]]
                                                 (local: all on this PC; synced: the world and projects between PCs)
  machine set --id <id> [--title <text>] [--home]   (this PC's name in the world; --home: the home PC)
  machine status
  sync status [--remote]                       (what this PC holds; --remote: each lock in its primary remote)
  sync init --confirm <machine id>             (the instance becomes the world repo, first push, held here)
  sync take [--world | --project <id>] --confirm <machine id>
  sync release [--world | --project <id>] --confirm <machine id>
                                               (between PCs, Gateway stopped; docs/project-package.md §14)
  sync recover [--apply --confirm <machine id>] (stuck sync states: lists them; --apply settles what is safe,
                                               Gateway stopped; §14.10)
  setup [--template <folder>] [--atlas-config <file>] [--replace-atlas-config] [--install-sdk]
        [--sdk-version <v>] [--sdk-path <folder>] [--registry <url>] [--no-start] [--provider claude] [--headless]
        [--mode local|synced [--sync-config <file>] [--machine-id <id> [--machine-title <text>] [--home]]]
  doctor
  migrate [--dry-run]
  version

The instance defaults to AGENTS_FACTORY_HOME, else the instance this CLI is
installed in (<instance>/.orchestrator/runtime), else <data>/controller; the
data folder defaults to the OS's (AGENTS_FACTORY_DATA_DIR overrides).
`;
var FLAG_NAMES = new Set([GLOBAL_OPTIONS, ...Object.values(COMMANDS2)].flatMap((spec) => Object.entries(spec)).filter(([, kind2]) => kind2 === "flag").map(([name]) => name));
function parseCommandLine(argv) {
  const words = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token2 = argv[index];
    if (!token2.startsWith("--")) {
      words.push(token2);
      continue;
    }
    const equals = token2.indexOf("=");
    const key = token2.slice(2, equals === -1 ? void 0 : equals);
    if (key === "" || Object.hasOwn(options, key)) usage(`Repeated or empty option: ${token2}`);
    let value = equals === -1 ? null : token2.slice(equals + 1);
    if (value === null && !FLAG_NAMES.has(key) && index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      value = argv[index + 1];
      index += 1;
    }
    options[key] = value;
  }
  if (words.length === 0) return { command: "help", options: { json: options.json === null || options.json === "true" } };
  const grouped = GROUPS.has(words[0]);
  if (grouped && words.length < 2) usage(`${words[0]} needs a command`);
  const command = grouped ? words.slice(0, 2).join(" ") : words[0];
  if (words.length > (grouped ? 2 : 1)) usage(`Unexpected argument: ${words.at(-1)}`);
  const spec = COMMANDS2[command];
  if (!spec) usage(`Unknown command: ${command}`);
  const allowed = { ...GLOBAL_OPTIONS, ...spec };
  const parsed2 = {};
  for (const [key, value] of Object.entries(options)) {
    const kind2 = allowed[key];
    if (!kind2) usage(`Unknown option for ${command}: --${key}`);
    if (kind2 === "flag") {
      if (value !== null && !["true", "false"].includes(value)) usage(`--${key} takes no value`);
      parsed2[key] = value !== "false";
    } else {
      if (value === null || value === "") usage(`--${key} needs a value`);
      parsed2[key] = value;
    }
  }
  return { command, options: parsed2 };
}
function integerOption(options, key, fallback, minimum, maximum) {
  if (options[key] === void 0) return fallback;
  const value = Number(options[key]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) usage(`--${key} must be an integer ${minimum}..${maximum}`);
  return value;
}
function providerOption(options) {
  const provider = options.provider ?? "claude";
  if (provider !== "claude") usage("--provider is claude (the Codex path left the product)");
  return provider;
}
async function readStdin(stdin, limit = 8192) {
  const chunks2 = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > limit) fail("key_invalid", "The key input is too long");
    chunks2.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks2).toString("utf8");
}
async function readHiddenLine(stdin, stderr) {
  stderr.write("Anthropic API key: ");
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (data) => {
      for (const character of data.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "") return finish(new AgentsFactoryError("key_input_cancelled", "Cancelled"));
        if (character === "" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
      return void 0;
    };
    stdin.on("data", onData);
  });
}
function cliScriptPath() {
  return path37.resolve(process.argv[1] ?? "agents-factory.mjs");
}
async function claudeStatus({ layout, env, keyStore, platform }) {
  const installed = await listInstalledSdks(layout);
  const config = await readJsonFile(layout.claudeProvider, { invalidCode: "claude_provider_config_invalid" }).catch(() => null);
  const configured = config?.sdkPath ? await inspectSdkPath(config.sdkPath, { platform }) : null;
  const environmentKey = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "";
  let storedKey = false;
  let keyStoreReason = null;
  try {
    storedKey = await keyStore.has();
  } catch (error) {
    keyStoreReason = error?.code ?? "key_store_unavailable";
  }
  const apiKeySource = environmentKey ? "environment" : storedKey ? "key-store" : "none";
  const keep = config?.keepProviderVariables === true;
  return {
    command: "claude status",
    sdk: {
      root: layout.sdkRoot,
      installed: installed.map(({ version: version2, sdkPath, sdkPresent, programPresent }) => ({ version: version2, sdkPath, sdkPresent, programPresent })),
      configured: configured === null ? null : { ...configured, managed: configured.sdkPath.startsWith(layout.sdkRoot + path37.sep) }
    },
    provider: { path: layout.claudeProvider, present: config !== null, keepProviderVariables: keep },
    auth: {
      method: keep && apiKeySource !== "none" ? "api-key" : "claude-code-login",
      apiKeySource,
      ...keyStoreReason ? { keyStoreReasonCode: keyStoreReason } : {}
    }
  };
}
async function versionInfo({ layout }) {
  const instanceExists = await pathKind(layout.instanceDir) === "directory";
  let instance = { path: layout.instanceDir, exists: instanceExists };
  if (instanceExists) {
    const record = await readInstanceRecord(layout).catch(() => null);
    const projectVersion = await readJsonFile(layout.projectVersion).catch(() => null);
    const gatewayCli = await pathKind(layout.installedGatewayCli) === "file" ? layout.installedGatewayCli : null;
    instance = {
      ...instance,
      schemaVersion: record?.schemaVersion ?? null,
      projectId: projectVersion?.projectName ?? null,
      projectVersion: projectVersion?.projectVersion ?? null,
      gatewayRuntime: gatewayCli === null ? null : { path: gatewayCli, sha256: await sha256File(gatewayCli) }
    };
  }
  const config = await readJsonFile(layout.claudeProvider).catch(() => null);
  const configured = config?.sdkPath ? await inspectSdkPath(config.sdkPath) : null;
  return {
    command: "version",
    cli: { version: AGENTS_FACTORY_CLI_VERSION, path: cliScriptPath() },
    node: process.version,
    electron: process.versions.electron ?? null,
    platform: process.platform,
    arch: process.arch,
    instance,
    sdk: { configuredVersion: configured?.version ?? null, installed: (await listInstalledSdks(layout)).map((item) => item.version) }
  };
}
async function executeCommand(command, options, io) {
  const { env, platform, executor } = io;
  const layout = resolveLayout({ options, env, platform, homeDir: io.homeDir, cliPath: io.cliPath ?? null });
  const keyStore = io.keyStore ?? createKeyStore({ platform, layout, executor, env });
  const gatewayContext = () => createGatewayContext({ layout, options, env, platform, executor, launcher: io.launcher ?? null, keyStore });
  const timeout = (fallback) => integerOption(options, "timeout-seconds", fallback, 1, 600) * 1e3;
  switch (command) {
    case "help":
      return { command: "help", text: HELP_TEXT };
    case "version":
      return versionInfo({ layout });
    case "gateway start": {
      const settings = {
        provider: providerOption(options),
        visible: options["visible-monitor"] === true,
        timeoutMs: timeout(30),
        planOnly: options["plan-only"] === true
      };
      return gatewayStart(await gatewayContext(), settings);
    }
    case "gateway stop": {
      const settings = { timeoutMs: timeout(15), planOnly: options["plan-only"] === true };
      return gatewayStop(await gatewayContext(), settings);
    }
    case "gateway status":
      return gatewayStatus(await gatewayContext());
    case "gateway recover":
      return gatewayRecover(await gatewayContext(), { planOnly: options["plan-only"] === true });
    case "gateway logs": {
      const lines2 = integerOption(options, "lines", 50, 1, 5e3);
      if (options.follow) {
        if (options.json) usage("--follow prints lines as they come; it has no --json form");
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        const logs = await gatewayLogs(layout, { lines: lines2 });
        for (const file of logs.files) for (const line of file.lines) io.stdout.write(`[${file.stream}] ${line}
`);
        await followGatewayLogs(layout, { write: (text3) => io.stdout.write(text3), signal: controller.signal });
        return null;
      }
      return gatewayLogs(layout, { lines: lines2 });
    }
    case "service install":
    case "service uninstall":
    case "service status": {
      const manager = io.serviceManager ?? createServiceManager({ platform, env, homeDir: io.homeDir, executor, layout });
      if (command === "service status") return manager.status();
      if (command === "service uninstall") return manager.uninstall({ planOnly: options["plan-only"] === true });
      const mechanism = options.mechanism ?? "auto";
      if (!["auto", "task-scheduler", "hkcu-run"].includes(mechanism)) usage("--mechanism is auto, task-scheduler or hkcu-run");
      if (mechanism !== "auto" && platform !== "win32") usage("--mechanism applies to Windows only");
      const provider = providerOption(options);
      if (await pathKind(layout.instanceDir) !== "directory") fail("instance_missing", `No controller instance at ${layout.instanceDir}`);
      const nodePath = options.node ? path37.resolve(options.node) : process.execPath;
      const cliPath = options.cli ? path37.resolve(options.cli) : await pathKind(layout.installedCli) === "file" ? layout.installedCli : cliScriptPath();
      const commandLine = serviceCommand({
        nodePath,
        cliPath,
        instanceDir: layout.instanceDir,
        provider,
        electron: Boolean(process.versions.electron) && nodePath === process.execPath
      });
      return options["plan-only"] ? manager.plan(commandLine, { mechanism }) : manager.install(commandLine, { mechanism });
    }
    case "key set": {
      const text3 = io.stdin.isTTY && !options.json ? await readHiddenLine(io.stdin, io.stderr) : await readStdin(io.stdin);
      await keyStore.set(normalizeApiKey(text3));
      return { command: "key set", stored: true, store: keyStore.kind };
    }
    case "key status":
      return { command: "key status", ...await keyStatus({ env, store: keyStore }) };
    case "key remove":
      return { command: "key remove", removed: await keyStore.remove(), store: keyStore.kind };
    case "claude install": {
      const installed = await installClaudeSdk({
        layout,
        requested: options.version ?? PINNED_CLAUDE_SDK_VERSION,
        registry: options.registry ?? env.AGENTS_FACTORY_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY,
        fetchImpl: io.fetch,
        platform
      });
      const result = { command: "claude install", ...installed };
      if (options.configure) {
        if (await pathKind(layout.instanceDir) !== "directory") fail("instance_missing", `No controller instance at ${layout.instanceDir}`);
        result.provider = await configureClaudeProvider(layout, installed.sdkPath);
      }
      return result;
    }
    case "claude status":
      return claudeStatus({ layout, env, keyStore, platform });
    case "setup":
      if (options.provider) providerOption(options);
      if (options["timeout-seconds"]) integerOption(options, "timeout-seconds", 30, 1, 600);
      if (options.mode !== void 0 && options.mode !== "local" && options.mode !== "synced") usage("setup: --mode is local or synced");
      if (options.mode === void 0 && (options["sync-config"] !== void 0 || options["machine-id"] !== void 0)) {
        usage("setup: --sync-config and --machine-id go with --mode synced");
      }
      return runSetup({
        layout,
        options,
        env,
        platform,
        executor,
        launcher: io.launcher ?? null,
        keyStore,
        fetchImpl: io.fetch,
        cliVersion: AGENTS_FACTORY_CLI_VERSION
      });
    case "doctor": {
      const serviceManager = io.serviceManager ?? createServiceManager({ platform, env, homeDir: io.homeDir, executor, layout });
      return runDoctor({ layout, options, env, platform, executor, keyStore, serviceManager });
    }
    case "migrate":
      return migrateInstance({ layout, dryRun: options["dry-run"] === true });
    case "project export": {
      if (typeof options.project !== "string") usage("project export needs --project <id>");
      if (typeof options.out !== "string") usage("project export needs --out <package folder>");
      try {
        return { command, ...await exportProject({
          controllerRoot: layout.instanceDir,
          projectId: options.project,
          out: path37.resolve(options.out),
          machineId: typeof options.machine === "string" ? options.machine : (await readThisMachine(layout.instanceDir))?.machineId ?? null,
          policy: policyOption(options)
        }) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "machine set":
    case "machine status": {
      if (command === "machine status") {
        return { command, machine: await readThisMachine(layout.instanceDir), machines: await readMachines(layout.instanceDir) };
      }
      if (typeof options.id !== "string") usage("machine set needs --id <id>");
      try {
        return { command, machine: await setThisMachine(layout.instanceDir, {
          machineId: options.id,
          title: typeof options.title === "string" ? options.title : null,
          home: options.home === true ? true : null
        }) };
      } catch (error) {
        if (typeof error?.code === "string" && error.code.startsWith("machine_")) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "sync status":
    case "sync init":
    case "sync take":
    case "sync release":
    case "sync recover": {
      try {
        if (command === "sync status") return { command, ...await syncStatus({ controllerRoot: layout.instanceDir, remote: options.remote === true }) };
        if (command === "sync recover" && options.apply !== true) {
          if (options.confirm !== void 0) usage("sync recover: --confirm goes with --apply");
          return { command, ...await recoverSync({ controllerRoot: layout.instanceDir }) };
        }
        const machine = await readThisMachine(layout.instanceDir);
        if (machine === null) throw new AgentsFactoryError("sync_machine_unnamed", "agents-factory machine set --id <id> first");
        if (options.confirm !== machine.machineId) usage(`${command} needs --confirm ${machine.machineId} (this PC)`);
        if (command === "sync recover") return { command, ...await recoverSync({ controllerRoot: layout.instanceDir, apply: true }) };
        if (options.world === true && typeof options.project === "string") usage("--world or --project, not both");
        const controllerRoot = layout.instanceDir;
        if (command === "sync init") return { command, ...await initWorld({ controllerRoot }) };
        const take = command === "sync take";
        if (options.world === true) return { command, ...await (take ? takeWorld : releaseWorld)({ controllerRoot }) };
        if (typeof options.project === "string") {
          return { command, ...await (take ? takeProject : releaseProject)({ controllerRoot, projectId: options.project }) };
        }
        return { command, ...await (take ? takeAll : releaseAll)({ controllerRoot }) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "instance move": {
      if (typeof options.to !== "string") usage("instance move needs --to <new folder> --confirm <new folder>");
      if (typeof options["machine-id"] !== "string" && (options["machine-title"] !== void 0 || options.home === true)) {
        usage("instance move: --machine-title and --home go with --machine-id");
      }
      try {
        return { command, ...await moveInstance({
          controllerRoot: layout.instanceDir,
          to: path37.resolve(options.to),
          confirm: typeof options.confirm === "string" ? path37.resolve(options.confirm) : null,
          atlasConfig: typeof options["atlas-config"] === "string" ? path37.resolve(options["atlas-config"]) : null,
          machine: typeof options["machine-id"] === "string" ? {
            machineId: options["machine-id"],
            title: typeof options["machine-title"] === "string" ? options["machine-title"] : null,
            home: options.home === true ? true : null
          } : null
        }) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "instance mode": {
      if (options.set === void 0 && (options.confirm !== void 0 || options["sync-config"] !== void 0 || options["machine-id"] !== void 0)) {
        usage("instance mode: --confirm, --sync-config and --machine-id go with --set");
      }
      try {
        if (options.set === void 0) return { command, ...await readInstanceMode(layout.instanceDir) };
        return { command, ...await setInstanceMode({
          controllerRoot: layout.instanceDir,
          mode: options.set,
          confirm: typeof options.confirm === "string" ? options.confirm : null,
          syncConfig: typeof options["sync-config"] === "string" ? path37.resolve(options["sync-config"]) : null,
          machine: typeof options["machine-id"] === "string" ? {
            machineId: options["machine-id"],
            title: typeof options["machine-title"] === "string" ? options["machine-title"] : null,
            home: options.home === true ? true : null
          } : null
        }) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "instance relocate": {
      if (typeof options.from !== "string") usage("instance relocate needs --from <old folder> --confirm <old folder>");
      try {
        return { command, ...await relocateInstance({
          controllerRoot: layout.instanceDir,
          from: path37.resolve(options.from),
          confirm: typeof options.confirm === "string" ? path37.resolve(options.confirm) : null,
          atlasConfig: typeof options["atlas-config"] === "string" ? path37.resolve(options["atlas-config"]) : null
        }) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "project unmount":
    case "project mount": {
      const unmount = command === "project unmount";
      if (unmount && (typeof options.project !== "string" || typeof options.out !== "string")) {
        usage("project unmount needs --project <id> --out <package folder> --confirm <id>");
      }
      if (!unmount && typeof options.package !== "string") usage("project mount needs --package <folder>");
      try {
        const result = unmount ? await unmountProject({
          controllerRoot: layout.instanceDir,
          projectId: options.project,
          out: path37.resolve(options.out),
          confirm: typeof options.confirm === "string" ? options.confirm : null,
          policy: policyOption(options)
        }) : await mountProject({ controllerRoot: layout.instanceDir, packageDir: path37.resolve(options.package) });
        return { command, ...result };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "project import":
    case "project migrate-layout": {
      if (command === "project import" && typeof options.package !== "string") usage("project import needs --package <folder>");
      try {
        const result = command === "project import" ? await importProject({ controllerRoot: layout.instanceDir, packageDir: path37.resolve(options.package) }) : await migrateToSplitLayout({ controllerRoot: layout.instanceDir });
        return { command, ...result };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    default:
      return usage(`Unknown command: ${command}`);
  }
}
function errorRecord2(error) {
  if (error instanceof AgentsFactoryError) {
    return {
      record: { ok: false, code: error.code, message: error.message, ...error.detail ? { detail: error.detail } : {} },
      exitCode: error.exitCode
    };
  }
  const code = typeof error?.code === "string" && /^[A-Z]{2,}[A-Z_]*$/u.test(error.code) ? `io_${error.code.toLowerCase()}` : "unexpected_failure";
  return { record: { ok: false, code, message: "The command failed unexpectedly" }, exitCode: 1 };
}
async function runCli(argv, io = {}) {
  const context2 = {
    env: io.env ?? process.env,
    platform: io.platform ?? process.platform,
    homeDir: io.homeDir ?? os4.homedir(),
    // The script node runs: a CLI installed in an instance works on that instance (agents-factory-paths.mjs).
    cliPath: io.cliPath ?? null,
    executor: io.executor ?? defaultExecutor,
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    fetch: io.fetch ?? globalThis.fetch,
    launcher: io.launcher ?? null,
    keyStore: io.keyStore ?? null,
    serviceManager: io.serviceManager ?? null
  };
  let json = argv.includes("--json");
  try {
    const { command, options } = parseCommandLine(argv);
    json = options.json === true;
    const result = await executeCommand(command, options, context2);
    if (result === null) return 0;
    if (command === "help" && !json) context2.stdout.write(result.text);
    else if (command === "gateway logs" && !json) {
      for (const file of result.files) {
        context2.stdout.write(`== ${file.stream}: ${file.path}${file.exists ? "" : " (missing)"}
`);
        for (const line of file.lines) context2.stdout.write(`${line}
`);
      }
    } else context2.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, json ? void 0 : 2)}
`);
    return 0;
  } catch (error) {
    const { record, exitCode } = errorRecord2(error);
    if (json) context2.stdout.write(`${JSON.stringify(record)}
`);
    else context2.stderr.write(`agents-factory: ${record.code}: ${record.message}
`);
    return exitCode;
  }
}

// orchestrator/src/agents-factory-cli.mjs
process.exitCode = await runCli(process.argv.slice(2), { cliPath: process.argv[1] ?? null });

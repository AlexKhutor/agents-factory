import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { defaultExecutor, fail, nowUtc, pathKind, writeJsonAtomic } from "./agents-factory-common.mjs";

// The Anthropic API key in the store of the OS. It is never printed, never put
// on a command line and never written in plain text: Windows keeps it as a
// DPAPI (CurrentUser) blob in the data folder, macOS in the login Keychain
// (`security`), Linux in the Secret Service (`secret-tool`, libsecret). Only the
// Gateway's environment receives it (agents-factory-gateway.mjs).

export const KEY_SERVICE = "agents-factory";
export const KEY_ACCOUNT = "anthropic-api-key";
export const KEY_LABEL = "Agents Factory Anthropic API key";
const DPAPI_ENTROPY = "AgentsFactory.AnthropicApiKey.v1";
// Printable, no quotes, spaces or backslashes: Anthropic keys are sk-ant-...
const KEY_PATTERN = /^[A-Za-z0-9_\-.:+/=]{16,512}$/u;

export function keyStoreKind(platform = process.platform) {
  if (platform === "win32") return "windows-dpapi";
  if (platform === "darwin") return "macos-keychain";
  return "linux-secret-service";
}

export function normalizeApiKey(text) {
  const key = typeof text === "string" ? text.trim() : "";
  if (!KEY_PATTERN.test(key)) fail("key_invalid", "The API key is empty or has characters an Anthropic key does not have");
  return key;
}

function windowsPowerShell(env) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function encodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// Input and output are Base64 on stdin/stdout: no encoding surprises, no newline.
const PROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Array]::Clear($plain, 0, $plain.Length)
[Console]::Out.Write([Convert]::ToBase64String($cipher))`;

const UNPROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$cipher = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
[Array]::Clear($plain, 0, $plain.Length)`;

async function runPowerShell(executor, env, script, input) {
  const result = await executor.run(windowsPowerShell(env), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodedCommand(script),
  ], { input, env, timeoutMs: 60_000 });
  if (result.status !== 0) fail("key_store_unavailable", "Windows DPAPI (PowerShell) did not complete");
  return result.stdout.trim();
}

function base64(text) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) fail("key_store_unavailable", "The key store returned an unexpected answer");
  return text;
}

/**
 * The key store of one OS. `executor.run(file, args, { input, env })` is the
 * only way out of the process, so tests replace it.
 */
export function createKeyStore({ platform = process.platform, layout, executor = defaultExecutor, env = process.env } = {}) {
  const kind = keyStoreKind(platform);
  if (kind === "windows-dpapi") {
    const file = layout.dpapiKeyFile;
    return Object.freeze({
      kind,
      async has() { return (await pathKind(file)) === "file"; },
      async set(key) {
        const value = normalizeApiKey(key);
        const ciphertext = base64(await runPowerShell(executor, env, PROTECT_SCRIPT, Buffer.from(value, "utf8").toString("base64")));
        await writeJsonAtomic(file, { schemaVersion: 1, kind: "dpapi-current-user", entropyId: DPAPI_ENTROPY,
          ciphertext, storedAtUtc: nowUtc() }, { mode: 0o600 });
      },
      async get() {
        if ((await pathKind(file)) !== "file") return null;
        let record;
        try { record = JSON.parse(await readFile(file, "utf8")); } catch { fail("key_store_invalid", "The stored key record is unreadable"); }
        if (record?.schemaVersion !== 1 || record.kind !== "dpapi-current-user" || typeof record.ciphertext !== "string") {
          fail("key_store_invalid", "The stored key record is not supported");
        }
        const plain = base64(await runPowerShell(executor, env, UNPROTECT_SCRIPT, base64(record.ciphertext)));
        return normalizeApiKey(Buffer.from(plain, "base64").toString("utf8"));
      },
      async remove() {
        const existed = (await pathKind(file)) === "file";
        await rm(file, { force: true });
        return existed;
      },
    });
  }
  if (kind === "macos-keychain") {
    const security = "/usr/bin/security";
    const identity = ["-s", KEY_SERVICE, "-a", KEY_ACCOUNT];
    return Object.freeze({
      kind,
      async has() {
        const result = await executor.run(security, ["find-generic-password", ...identity], { env, timeoutMs: 30_000 });
        if (result.status === 0) return true;
        if (result.status === 44) return false;
        return fail("key_store_unavailable", "The macOS Keychain did not answer");
      },
      async set(key) {
        const value = normalizeApiKey(key);
        // `security -i` reads the command from stdin, so the key never reaches argv.
        const command = `add-generic-password -U -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -l "${KEY_LABEL}" -w "${value}"\n`;
        const result = await executor.run(security, ["-i"], { input: command, env, timeoutMs: 30_000 });
        if (result.status !== 0) fail("key_store_unavailable", "The macOS Keychain did not store the key");
      },
      async get() {
        const result = await executor.run(security, ["find-generic-password", ...identity, "-w"], { env, timeoutMs: 30_000 });
        if (result.status === 44) return null;
        if (result.status !== 0) fail("key_store_unavailable", "The macOS Keychain did not answer");
        return normalizeApiKey(result.stdout);
      },
      async remove() {
        const result = await executor.run(security, ["delete-generic-password", ...identity], { env, timeoutMs: 30_000 });
        if (result.status === 0) return true;
        if (result.status === 44) return false;
        return fail("key_store_unavailable", "The macOS Keychain did not remove the key");
      },
    });
  }
  const attributes = ["service", KEY_SERVICE, "account", KEY_ACCOUNT];
  const secretTool = "secret-tool";
  const unavailable = (result) => result.errorCode === "ENOENT"
    ? fail("key_store_unavailable", "secret-tool (libsecret) is not installed")
    : fail("key_store_unavailable", "The Secret Service did not answer");
  return Object.freeze({
    kind,
    async has() {
      const result = await executor.run(secretTool, ["lookup", ...attributes], { env, timeoutMs: 30_000 });
      if (result.status === 0) return result.stdout.trim() !== "";
      if (result.status === 1 && result.errorCode === null) return false;
      return unavailable(result);
    },
    async set(key) {
      const value = normalizeApiKey(key);
      const result = await executor.run(secretTool, ["store", `--label=${KEY_LABEL}`, ...attributes],
        { input: value, env, timeoutMs: 30_000 });
      if (result.status !== 0) unavailable(result);
    },
    async get() {
      const result = await executor.run(secretTool, ["lookup", ...attributes], { env, timeoutMs: 30_000 });
      if (result.status === 1 && result.errorCode === null) return null;
      if (result.status !== 0) unavailable(result);
      return result.stdout.trim() === "" ? null : normalizeApiKey(result.stdout);
    },
    async remove() {
      const existed = await this.has();
      const result = await executor.run(secretTool, ["clear", ...attributes], { env, timeoutMs: 30_000 });
      if (result.status !== 0 && existed) unavailable(result);
      return existed;
    },
  });
}

/**
 * The key the Gateway gets: ANTHROPIC_API_KEY of the environment first, else
 * the store. A store that cannot answer is reported, not fatal: Claude Code
 * may still be signed in its own way.
 */
export async function resolveApiKey({ env = process.env, store }) {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "") {
    return { source: "environment", key: env.ANTHROPIC_API_KEY, reasonCode: null };
  }
  try {
    const key = await store.get();
    return key === null ? { source: "none", key: null, reasonCode: "key_not_stored" }
      : { source: "key-store", key, reasonCode: null };
  } catch (error) {
    return { source: "none", key: null, reasonCode: typeof error?.code === "string" ? error.code : "key_store_unavailable" };
  }
}

export async function keyStatus({ env = process.env, store }) {
  return {
    hasKey: await store.has(),
    store: store.kind,
    environmentOverride: typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "",
  };
}

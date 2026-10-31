import path from "node:path";
import { lstat, readFile } from "node:fs/promises";

import { normalizeAcpModels } from "./acp-session-host.mjs";

// The machine-local config of the ACP provider of a controller: which agent
// program to start (DeepSeek Harness `dsh --profile acp`, say), its data
// folder, its environment, the models the desk offers and the MCP servers
// every session gets. Secrets are never in the file: `secretEnv` names files
// whose content becomes an environment variable of the agent process only.

export const ACP_PROVIDER_CONFIG_VERSION = "v0.1.0";
export const ACP_PROVIDER_CONFIG_PATH = path.join(".project-local", "application-gateway", "acp-provider.json");

const CONFIG_FIELDS = new Set(["schemaVersion", "command", "args", "home", "env", "secretEnv", "models",
  "mcpServers", "agentCommits", "permissionMode", "deskPolicy", "enforcesWriteZones", "turnSilenceMinutes"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
// Telemetry stays off whatever the file says (acpEnvironment sets these).
const RESERVED_ENV = /^(DSH_HOME|DSH_TELEMETRY_.*)$/iu;
const PERMISSION_MODES = new Set(["read-only", "workspace-write"]);

function invalid(code = "acp_provider_config_invalid") { throw Object.assign(new Error(code), { code }); }

function envMap(value, check) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) invalid();
  for (const [name, entry] of Object.entries(value)) {
    if (!ENV_NAME.test(name) || RESERVED_ENV.test(name) || typeof entry !== "string" || entry.length > 4096) invalid();
    check(entry);
  }
  return { ...value };
}

/** One MCP server as ACP's session/new takes it: stdio (command, args, env) or http (url, headers). */
function mcpServer(value) {
  if (!value || typeof value !== "object" || typeof value.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.name)) {
    invalid();
  }
  const pairs = (list) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 64
        || list.some((pair) => typeof pair?.name !== "string" || typeof pair?.value !== "string")) invalid();
    return list.map((pair) => ({ name: pair.name, value: pair.value }));
  };
  if (value.type === "http") {
    if (typeof value.url !== "string" || !/^https?:\/\//u.test(value.url)) invalid();
    return { type: "http", name: value.name, url: value.url, headers: pairs(value.headers) };
  }
  if (value.type !== undefined && value.type !== "stdio") invalid();
  if (typeof value.command !== "string" || !path.isAbsolute(value.command)) invalid();
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) invalid();
  return { name: value.name, command: value.command, args: [...(value.args ?? [])], env: pairs(value.env) };
}

/** Validates the machine-local ACP provider config; returns it normalized. */
export function normalizeAcpProviderConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1
      || Object.keys(value).some((key) => !CONFIG_FIELDS.has(key))) invalid();
  if (typeof value.command !== "string" || !path.isAbsolute(value.command)) invalid();
  if (!Array.isArray(value.args) || value.args.length > 32 || value.args.some((arg) => typeof arg !== "string")) invalid();
  if (typeof value.home !== "string" || !path.isAbsolute(value.home)) invalid();
  const env = envMap(value.env, () => {});
  const secretEnv = envMap(value.secretEnv, (file) => { if (!path.isAbsolute(file)) invalid(); });
  const mcpServers = value.mcpServers ?? [];
  if (!Array.isArray(mcpServers) || mcpServers.length > 16) invalid();
  if (value.agentCommits !== undefined && typeof value.agentCommits !== "boolean") invalid();
  const permissionMode = value.permissionMode ?? "workspace-write";
  if (!PERMISSION_MODES.has(permissionMode)) invalid();
  // The desk's own decisions on writes and commands (acp-desk-policy.mjs); the agent's profile
  // must load dsh-desk-gate-plugin.mjs, or it never asks.
  const deskPolicy = value.deskPolicy ?? null;
  if (deskPolicy !== null && (typeof deskPolicy !== "object" || Array.isArray(deskPolicy)
      || Object.keys(deskPolicy).some((key) => key !== "forbiddenPorts")
      || (deskPolicy.forbiddenPorts !== undefined && (!Array.isArray(deskPolicy.forbiddenPorts)
        || deskPolicy.forbiddenPorts.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535))))) invalid();
  // Write zones count as held only when the policy is on and the person says it was proven live.
  if (value.enforcesWriteZones !== undefined && typeof value.enforcesWriteZones !== "boolean") invalid();
  if (value.enforcesWriteZones === true && deskPolicy === null) invalid();
  // How long a turn may hear nothing from the agent before it ends as "the model does not answer"
  // (acp-session-host.mjs); 0: no limit. Not given: ten minutes.
  const silence = value.turnSilenceMinutes ?? null;
  if (silence !== null && (!Number.isSafeInteger(silence) || silence < 0 || silence > 24 * 60)) invalid();
  return { command: value.command, args: [...value.args], home: value.home, env, secretEnv,
    models: normalizeAcpModels(value.models), mcpServers: mcpServers.map(mcpServer),
    agentCommits: value.agentCommits !== false, permissionMode,
    deskPolicy: deskPolicy === null ? null : { forbiddenPorts: [...(deskPolicy.forbiddenPorts ?? [])] },
    enforcesWriteZones: value.enforcesWriteZones === true,
    turnSilenceMinutes: silence };
}

/** Reads `.project-local/application-gateway/acp-provider.json` of a controller; null when there is none. */
export async function readAcpProviderConfig(repoRoot) {
  const file = path.join(repoRoot, ACP_PROVIDER_CONFIG_PATH);
  const info = await lstat(file).catch(() => null);
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) invalid();
  let parsed;
  try { parsed = JSON.parse(await readFile(file, "utf8")); } catch { invalid(); }
  return normalizeAcpProviderConfig(parsed);
}

// What the agent process inherits from the Gateway: enough for Windows and
// Node to run, nothing else (no provider keys, no proxies the person set for
// other tools).
const INHERITED = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "PATH", "Path", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles",
  "ProgramFiles(x86)", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "HOME", "LANG", "TERM"];

/**
 * The whole environment of the agent process: the inherited minimum, the
 * config's plain variables, the secrets read from their files, and the
 * settings that keep its data local (DSH_HOME, telemetry off).
 */
export async function acpEnvironment(config, { base = process.env, read = (file) => readFile(file, "utf8") } = {}) {
  const env = {};
  // Windows names are case-insensitive (PATH and Path are one variable): each is taken once.
  const taken = new Set();
  for (const name of INHERITED) {
    if (typeof base[name] !== "string" || taken.has(name.toUpperCase())) continue;
    taken.add(name.toUpperCase());
    env[name] = base[name];
  }
  Object.assign(env, config.env);
  for (const [name, file] of Object.entries(config.secretEnv)) {
    let secret;
    try { secret = String(await read(file)).trim(); } catch { invalid("acp_secret_unavailable"); }
    if (!secret || secret.length > 4096 || /[\r\n]/u.test(secret)) invalid("acp_secret_unavailable");
    env[name] = secret;
  }
  return { ...env, DSH_HOME: config.home, DSH_PERMISSION_MODE: config.permissionMode,
    DSH_TELEMETRY_DISABLED: "1", DSH_TELEMETRY_MODE: "DISABLED",
    // Should anything still try to export, it goes nowhere.
    DSH_TELEMETRY_OTLP_URL: "http://127.0.0.1:9/v1/logs" };
}

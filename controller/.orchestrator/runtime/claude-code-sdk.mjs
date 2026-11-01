import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The Claude Agent SDK is not bundled: it ships the Claude Code program as a
// native executable in a platform package next to it. The Gateway loads it
// from the folder it is installed in, named by the machine-local config.

export const CLAUDE_CODE_SDK_SUPPORT_VERSION = "v0.2.0";

/**
 * The built-in tools of a desk agent, always the same set. Without a fixed set
 * Claude Code adds tools of the person's account, and that set differs from
 * one process start to the next; a different tool list is a different start
 * of the prompt, so the whole context is written to the cache again at full
 * price (measured live 2026-10-01). Sub-agents (Agent/Task) are left out.
 */
export const CLAUDE_AGENT_TOOLS = Object.freeze([
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit",
  "TodoWrite", "WebFetch", "WebSearch", "AskUserQuestion", "ExitPlanMode",
]);

export const CLAUDE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** How Claude Code names a tool of the desk's in-process MCP server ("desk"). */
export const claudeDeskToolName = (name) => `mcp__desk__${name}`;
/** The desk's memory-document tool, as Claude Code names it. */
export const CLAUDE_DESK_TOOL = claudeDeskToolName("write_memory_from_document");

function fail(code) { throw Object.assign(new Error(code), { code }); }

export async function loadClaudeSdk(sdkPath) {
  if (typeof sdkPath !== "string" || !path.isAbsolute(sdkPath)) fail("claude_sdk_path_invalid");
  let sdk;
  try { sdk = await import(pathToFileURL(path.join(sdkPath, "sdk.mjs")).href); }
  catch { fail("claude_sdk_unavailable"); }
  if (typeof sdk.query !== "function") fail("claude_sdk_unavailable");
  return sdk;
}

/** zod, in which the SDK's tool definitions are written: the copy installed beside the SDK. */
export function loadClaudeZod(sdkPath) {
  const zod = createRequire(path.join(sdkPath, "package.json"))("zod");
  return zod.z ?? zod;
}

/** The Claude Code program the SDK starts: inside the SDK's platform package. */
export function claudeProgramOf(sdkPath, platform = process.platform, arch = process.arch) {
  return path.join(path.dirname(sdkPath), `claude-agent-sdk-${platform}-${arch}`,
    platform === "win32" ? "claude.exe" : "claude");
}

function runProgram(file, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(file, args, { env: env ?? process.env, timeout: timeoutMs, windowsHide: true,
      maxBuffer: 256 * 1024 }, (error, stdout) => resolve({ error, stdout: String(stdout ?? "") }));
  });
}

/**
 * Which account Claude Code is signed in to, from its own read-only
 * `claude auth status --json`, run with the environment of the turns. No
 * session is started: stopping Claude Code while it renews its sign-in can
 * leave it signed out (seen 2026-10-01), so a session is never started just to
 * ask. Personal details (e-mail, organization) are not returned.
 */
export async function readClaudeAccount({ program, env = null, timeoutMs = 20_000, run = runProgram }) {
  const { error, stdout } = await run(program, ["auth", "status", "--json"], { env, timeoutMs });
  let status;
  try { status = JSON.parse(stdout); } catch {
    return { state: "failed", reasonCode: error ? "claude_status_failed" : "claude_status_invalid" };
  }
  const text = (value) => typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : null;
  if (status?.loggedIn !== true) return { state: "signed-out", authMethod: text(status?.authMethod) };
  return { state: "signed-in", authMethod: text(status.authMethod), apiProvider: text(status.apiProvider),
    subscriptionType: text(status.subscriptionType) };
}

/**
 * The environment of a Claude Code process: the Gateway's own, with an
 * optional account folder (CLAUDE_CONFIG_DIR). Variables that would bill
 * another account or route through another provider are removed unless the
 * machine-local config keeps them on purpose (an organization that signs in
 * through Bedrock or Vertex, say), so by default a turn runs on the sign-in
 * `auth status` reported.
 */
export const CLAUDE_PROVIDER_VARIABLES = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]);

export function claudeEnvironment({ base = process.env, configDir = null, keepProviderVariables = false } = {}) {
  const env = { ...base };
  if (keepProviderVariables !== true) for (const name of CLAUDE_PROVIDER_VARIABLES) delete env[name];
  if (configDir !== null) {
    if (typeof configDir !== "string" || !path.isAbsolute(configDir)) fail("claude_config_dir_invalid");
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}

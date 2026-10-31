import path from "node:path";
import { lstat, readFile } from "node:fs/promises";

import { normalizeClaudeModels } from "./claude-code-session-host.mjs";

// The machine-local config of the Claude Code provider of a controller: where
// the SDK is, which Claude Code config folder and models to use. The Gateway's
// desk agents and the controller's one-off service turns (review, summary)
// read the same file.

export const CLAUDE_PROVIDER_CONFIG_VERSION = "v0.1.0";
export const CLAUDE_PROVIDER_CONFIG_PATH = path.join(".project-local", "application-gateway", "claude-provider.json");

const CONFIG_FIELDS = new Set(["schemaVersion", "sdkPath", "claudeConfigDir", "keepProviderVariables",
  "models", "settingSources", "permissionMode", "agentCommits", "webFetchHosts"]);
const WEB_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const SETTING_SOURCES = new Set(["user", "project", "local"]);
// The provider's mode, which agents without their own run in; bypassing every
// check is only ever an agent's own mode, chosen by the person for that agent.
const PERMISSION_MODES = new Set(["default", "acceptEdits", "auto", "plan", "dontAsk"]);

function invalid(code) { throw Object.assign(new Error(code), { code }); }

/** Validates the machine-local Claude provider config; returns it normalized. */
export function normalizeClaudeProviderConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1
      || Object.keys(value).some((key) => !CONFIG_FIELDS.has(key))) invalid("claude_provider_config_invalid");
  if (typeof value.sdkPath !== "string" || !path.isAbsolute(value.sdkPath)) invalid("claude_provider_config_invalid");
  if (value.claudeConfigDir !== undefined && value.claudeConfigDir !== null
      && (typeof value.claudeConfigDir !== "string" || !path.isAbsolute(value.claudeConfigDir))) {
    invalid("claude_provider_config_invalid");
  }
  const settingSources = value.settingSources ?? ["project", "local"];
  if (!Array.isArray(settingSources) || settingSources.some((source) => !SETTING_SOURCES.has(source))) {
    invalid("claude_provider_config_invalid");
  }
  const permissionMode = value.permissionMode ?? "acceptEdits";
  if (!PERMISSION_MODES.has(permissionMode)) invalid("claude_provider_config_invalid");
  if (value.keepProviderVariables !== undefined && typeof value.keepProviderVariables !== "boolean") {
    invalid("claude_provider_config_invalid");
  }
  // Each turn's work is committed to the git of its project folder unless this is false.
  if (value.agentCommits !== undefined && typeof value.agentCommits !== "boolean") invalid("claude_provider_config_invalid");
  // Hosts agents may fetch from without asking the person (each covers its subdomains); none given: the
  // built-in documentation hosts (agent-secret-paths.mjs), [] : every fetch asks.
  const webFetchHosts = value.webFetchHosts ?? null;
  if (webFetchHosts !== null && (!Array.isArray(webFetchHosts) || webFetchHosts.length > 64
      || webFetchHosts.some((host) => typeof host !== "string" || !WEB_HOST.test(host)))) invalid("claude_provider_config_invalid");
  return { sdkPath: value.sdkPath, claudeConfigDir: value.claudeConfigDir ?? null,
    keepProviderVariables: value.keepProviderVariables === true, models: normalizeClaudeModels(value.models),
    settingSources: [...new Set(settingSources)], permissionMode, agentCommits: value.agentCommits !== false,
    webFetchHosts: webFetchHosts === null ? null : [...new Set(webFetchHosts)] };
}

/** Reads `.project-local/application-gateway/claude-provider.json` of a controller. */
export async function readClaudeProviderConfig(repoRoot) {
  const file = path.join(repoRoot, CLAUDE_PROVIDER_CONFIG_PATH);
  const info = await lstat(file).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    invalid("claude_provider_config_missing");
  }
  let parsed;
  try { parsed = JSON.parse(await readFile(file, "utf8")); } catch { invalid("claude_provider_config_invalid"); }
  return normalizeClaudeProviderConfig(parsed);
}

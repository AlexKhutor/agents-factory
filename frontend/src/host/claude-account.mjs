// Which Claude account the controller's agents work under, for the window's
// header.
//
// The Gateway contract deliberately carries no account e-mail or organization,
// so the host asks Claude Code itself, on this machine: the same program and the
// same environment the Gateway gives its turns (the controller's
// claude-provider.json names the SDK and an optional account folder). It runs
// the read-only `claude auth status --json`; no session is started and no
// message is sent. The answer stays on this machine.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { claudeProgramOf, readClaudeAccount } from "../direct/claude-driver.mjs";

const CACHE_MS = 60_000;
// "Not signed in" and "could not ask" are kept only briefly: a sign-in made meanwhile shows within seconds.
const RETRY_MS = 10_000;

// The same list the backend removes (claude-code-sdk.mjs): variables that
// would bill another account or route through another provider.
const PROVIDER_VARIABLES = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]);

/** The program and environment of the controller's Claude turns, or null with a reason. */
export async function claudeSetupOf(controllerRoot, base = process.env) {
  const file = path.join(controllerRoot, ".project-local", "application-gateway", "claude-provider.json");
  let config;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { ok: false, reasonCode: "claude_provider_config_unreadable" };
  }
  if (typeof config?.sdkPath !== "string" || !path.isAbsolute(config.sdkPath)) {
    return { ok: false, reasonCode: "claude_sdk_path_invalid" };
  }
  const env = { ...base };
  if (config.keepProviderVariables !== true) for (const name of PROVIDER_VARIABLES) delete env[name];
  if (typeof config.claudeConfigDir === "string" && path.isAbsolute(config.claudeConfigDir)) {
    env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
  }
  return { ok: true, program: claudeProgramOf(config.sdkPath), env };
}

/**
 * `read({ force })` gives `{ state, email, organization, subscriptionType,
 * authMethod }`; state is "known", "signed-out" or "failed". A known account is kept
 * for a minute (the header asks on every refresh), any other answer for ten seconds;
 * `force` (the person's "Refresh") asks Claude Code again at once.
 */
export function createClaudeAccountReader({ controllerRoot, now = () => Date.now(), readAccount = readClaudeAccount }) {
  let cached = null;
  let pending = null;
  return {
    async read({ force = false } = {}) {
      if (!force && cached !== null && now() - cached.at < (cached.value.state === "known" ? CACHE_MS : RETRY_MS)) {
        return cached.value;
      }
      if (pending !== null) return pending;
      pending = (async () => {
        const setup = await claudeSetupOf(controllerRoot);
        const value = setup.ok
          ? await readAccount({ program: setup.program, env: setup.env })
          : { state: "failed", reason: setup.reasonCode };
        cached = { at: now(), value };
        return value;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}

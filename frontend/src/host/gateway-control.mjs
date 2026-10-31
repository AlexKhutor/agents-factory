// The controller's Gateway, the Anthropic API key and the Gateway's autostart,
// run from Atlas through the agents-factory CLI (agents-factory-cli.mjs).
//
// What the page can do here is a fixed list of host actions, each one CLI
// command with arguments the host builds:
//   gateway status | start | stop | recover --instance <controllerRoot> --json
//   key status | set | remove                --instance <controllerRoot> --json
//   service status | install | uninstall     --instance <controllerRoot> --json
//   project unmount | mount ...              --instance <controllerRoot> --json
//
// The project commands are not the page's: trusted-actions.mjs builds them after
// the person confirmed, and runs them through whileStopped - the Gateway is
// stopped for them (the backend refuses while it runs) and started again after,
// if it ran before.
//
// The API key arrives from the page once, goes to `key set` through stdin and is
// not kept: not in this module, not in the journal, not in any answer. The page
// learns only {hasKey}, read back from `key status`.
//
// Changes follow the host's rules: without a confirmation surface none is made;
// removing the key and turning autostart on (it changes the operating system's
// login items) are confirmed in Atlas's own window; the rest is the button the
// person pressed. One change runs at a time, and each leaves one journal entry
// with no target and no text.

import {
  cliLauncher, parseAgentsFactoryOutput, resolveAgentsFactoryCli, runAgentsFactory,
} from "./agents-factory-cli.mjs";
import { tx } from "./i18n.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const id = (value) => (typeof value === "string" && ID.test(value) ? value : null);
const word = (value) => (typeof value === "string" && WORD.test(value) ? value : null);
const utc = (value) => (typeof value === "string" && UTC.test(value) ? value : null);
const bool = (value) => (typeof value === "boolean" ? value : null);

export const GATEWAY_CONTROL_TIMEOUTS = Object.freeze({
  status: 20_000, start: 180_000, stop: 90_000, recover: 60_000, key: 30_000, service: 60_000,
  // Writing and checking a project package; a project with years of conversations takes a while.
  project: 600_000,
  // A take or a release between PCs: exports, git pushes and pulls of the world and its projects.
  sync: 900_000, syncStatus: 120_000,
});

// The CLI itself accepts 16 to 512 characters; it is the authority on the format.
export const API_KEY_LIMITS = Object.freeze({ minLength: 16, maxLength: 512 });

/**
 * Why a key cannot be handed to the CLI, or null. The reason never says
 * anything about the key's text: not a character, not a prefix.
 */
export function apiKeyProblem(key) {
  if (typeof key !== "string") return "api_key_invalid";
  const trimmed = key.trim();
  if (trimmed === "") return "api_key_empty";
  if (trimmed.length < API_KEY_LIMITS.minLength || trimmed.length > API_KEY_LIMITS.maxLength) {
    return "api_key_length_invalid";
  }
  // Printable ASCII without spaces: a key pasted with a line break or a
  // non-Latin character inside is refused here, before it reaches any store.
  if (!/^[\x21-\x7E]+$/u.test(trimmed)) return "api_key_characters_invalid";
  return null;
}

/**
 * One word for the Gateway's state, from `gateway status` - the fields the
 * application gateway CLI reports (availability, reasonCode, lifecycle, ready).
 * Nothing is guessed: what does not fit is "unknown".
 */
export function gatewayStateOf({ availability = null, lifecycle = null, reasonCode = null, ready = null } = {}) {
  if (availability === "available") {
    if (lifecycle === "stop-requested") return "stopping";
    if (ready === true || lifecycle === "ready") return "running";
    return "starting";
  }
  if (availability === "terminal") {
    const terminal = lifecycle ?? reasonCode;
    if (terminal === "stopped") return "stopped";
    if (terminal === "failed") return "failed";
    return "uncertain";
  }
  if (availability === "stale") return "stale";
  if (availability === "unavailable" && reasonCode === "status_missing") return "absent";
  return "unknown";
}

/** The bounded view of `gateway status`: states, codes and identifiers only. */
export function gatewaySummary(value) {
  const nested = value?.gateway !== null && typeof value?.gateway === "object" ? value.gateway : {};
  const availability = word(value?.availability);
  const lifecycle = word(value?.lifecycle) ?? word(nested.lifecycle);
  const reasonCode = word(value?.reasonCode);
  const ready = bool(value?.ready);
  return {
    state: gatewayStateOf({ availability, lifecycle, reasonCode, ready }),
    availability,
    lifecycle,
    reasonCode,
    ready,
    instanceId: id(value?.instanceId) ?? id(nested.instanceId),
    heartbeatAtUtc: utc(value?.heartbeatAtUtc) ?? utc(nested.heartbeatAtUtc),
  };
}

// What the autostart confirmation says it changes, by operating system.
const AUTOSTART_MECHANISM = Object.freeze({
  win32: tx("a Windows Task Scheduler task for this user"),
  darwin: tx("a LaunchAgent for this user on macOS"),
  linux: tx("a systemd --user service for this user"),
});

const unavailableError = (reasonCode) => ({ ok: false, error: { code: "unavailable", reasonCode } });

/**
 * Gateway control where there is none to run: the controller is not
 * configured, or the kit delivery was rejected. Status says why; every change
 * is refused with the same reason.
 */
export function unavailableGatewayControl(reasonCode) {
  const refuse = async () => unavailableError(reasonCode);
  return {
    status: async () => ({
      ok: true,
      data: {
        supported: true, cli: { available: false, source: null, reasonCode },
        action: null, gateway: null, error: null, checkedAtUtc: new Date().toISOString(),
      },
    }),
    start: refuse, stop: refuse, recover: refuse,
    keyStatus: refuse, setKey: refuse, removeKey: refuse,
    autostartStatus: refuse, installAutostart: refuse, uninstallAutostart: refuse,
    projectCommand: refuse, whileStopped: refuse, syncCommand: refuse,
  };
}

/**
 * @param controllerRoot  the configured controller; the CLI's --instance
 * @param cli             {script, nodeExecutable} from config/local.json (both optional)
 * @param applicationRoot the frontend folder (for the development build)
 * @param development     whether the backend's development build may be run
 * @param fixture         the development fixture: the source is called so
 * @param confirm         Atlas's own confirmation window, or null (no changes then)
 * @param journal         this run's read journal, or null
 * @param run             the CLI runner (tests replace it to observe calls)
 */
export function createGatewayControl({
  controllerRoot, cli = {}, applicationRoot = null, development = false, fixture = false,
  confirm = null, journal = null, platform = process.platform,
  timeouts = GATEWAY_CONTROL_TIMEOUTS, run = runAgentsFactory,
}) {
  const launcher = cliLauncher(cli?.nodeExecutable ?? null);
  const canChange = typeof confirm === "function";
  let inflight = null;

  const locate = () => resolveAgentsFactoryCli({
    controllerRoot, configured: cli?.script ?? null, applicationRoot, development,
  });

  /** One CLI command. `secret` goes to its stdin and nowhere else. */
  async function invoke(command, { timeoutMs, secret = null }) {
    const found = await locate();
    if (!found.found) return { ok: false, error: { code: "cli_unavailable", reasonCode: found.reasonCode } };
    const result = await run({
      launcher, script: found.script, cwd: controllerRoot, secret, timeoutMs,
      args: [...command, "--instance", controllerRoot, "--json"],
    });
    return parseAgentsFactoryOutput(result);
  }

  async function status() {
    const found = await locate();
    const cliInfo = {
      available: found.found,
      source: found.found && fixture ? "fixture" : found.source,
      reasonCode: found.found ? null : found.reasonCode,
    };
    // A change still running is reported, so a page that opens meanwhile shows it.
    const action = inflight === null ? null : { ...inflight };
    const checkedAtUtc = new Date().toISOString();
    if (!found.found) {
      return { ok: true, data: { supported: true, cli: cliInfo, action, gateway: null, error: null, checkedAtUtc } };
    }
    const parsed = await invoke(["gateway", "status"], { timeoutMs: timeouts.status });
    return {
      ok: true,
      data: {
        supported: true, cli: cliInfo, action, checkedAtUtc,
        gateway: parsed.ok ? gatewaySummary(parsed.value) : null,
        error: parsed.ok ? null : parsed.error,
      },
    };
  }

  async function keyStatus() {
    const parsed = await invoke(["key", "status"], { timeoutMs: timeouts.key });
    if (!parsed.ok) return parsed;
    return { ok: true, data: { hasKey: bool(parsed.value.hasKey) } };
  }

  async function autostartStatus() {
    const parsed = await invoke(["service", "status"], { timeoutMs: timeouts.service });
    if (!parsed.ok) return parsed;
    return { ok: true, data: { installed: bool(parsed.value.installed) } };
  }

  // After a change, the state is read back from the CLI rather than assumed.
  const readBack = async (read, field) => {
    const after = await read();
    return { ok: true, data: { [field]: after.ok ? after.data[field] : null } };
  };

  async function start() {
    const parsed = await invoke(["gateway", "start"], { timeoutMs: timeouts.start });
    if (!parsed.ok) return parsed;
    return { ok: true, data: { state: word(parsed.value.state), instanceId: id(parsed.value.instanceId) } };
  }

  async function stop() {
    const parsed = await invoke(["gateway", "stop"], { timeoutMs: timeouts.stop });
    if (!parsed.ok) return parsed;
    return { ok: true, data: { state: word(parsed.value.state) } };
  }

  async function recover() {
    const parsed = await invoke(["gateway", "recover"], { timeoutMs: timeouts.recover });
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      data: { state: word(parsed.value.state), restartAllowed: bool(parsed.value.restartAllowed) },
    };
  }

  // The key is read from the payload here and passed on; nothing keeps it.
  async function setKey(input) {
    const problem = apiKeyProblem(input?.key);
    if (problem !== null) return { ok: false, error: { code: "invalid_input", reasonCode: problem } };
    const parsed = await invoke(["key", "set"], { timeoutMs: timeouts.key, secret: input.key.trim() });
    if (!parsed.ok) return parsed;
    return readBack(keyStatus, "hasKey");
  }

  async function removeKey() {
    const confirmed = await confirm({
      title: tx("Remove API key"),
      message: tx("Remove the Anthropic API key from the system key store?"),
      detail: tx("Atlas keeps no copy of the key: to get it back, you will have to enter the key again."),
      confirmLabel: tx("Remove key"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const parsed = await invoke(["key", "remove"], { timeoutMs: timeouts.key });
    if (!parsed.ok) return parsed;
    return readBack(keyStatus, "hasKey");
  }

  async function installAutostart() {
    const mechanism = AUTOSTART_MECHANISM[platform] ?? tx("an autostart entry for this user");
    const confirmed = await confirm({
      title: tx("Gateway autostart"),
      message: tx("Start the Gateway when you sign in?"),
      detail: tx("This will create {mechanism}. The Gateway will start at every sign-in, even when Atlas is closed. ", { mechanism })
        + tx("You can turn it off right here."),
      confirmLabel: tx("Turn on autostart"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const parsed = await invoke(["service", "install"], { timeoutMs: timeouts.service });
    if (!parsed.ok) return parsed;
    return readBack(autostartStatus, "installed");
  }

  async function uninstallAutostart() {
    const parsed = await invoke(["service", "uninstall"], { timeoutMs: timeouts.service });
    if (!parsed.ok) return parsed;
    return readBack(autostartStatus, "installed");
  }

  /** One project command (trusted-actions.mjs builds it); the parsed answer of the CLI. */
  async function projectCommand(args) {
    if (!Array.isArray(args) || args[0] !== "project" || !args.every((item) => typeof item === "string")) {
      return { ok: false, error: { code: "invalid_input", reasonCode: "project_command_invalid" } };
    }
    return invoke(args, { timeoutMs: timeouts.project });
  }

  /** One sync command between PCs (trusted-actions.mjs builds it): status reads; take and release change. */
  async function syncCommand(args) {
    if (!Array.isArray(args) || args[0] !== "sync" || !["status", "take", "release"].includes(args[1])
        || !args.every((item) => typeof item === "string")) {
      return { ok: false, error: { code: "invalid_input", reasonCode: "sync_command_invalid" } };
    }
    return invoke(args, { timeoutMs: args[1] === "status" ? timeouts.syncStatus : timeouts.sync });
  }

  /**
   * Runs `work` with the Gateway stopped: stops it if it runs or starts, runs
   * the work, and starts it again if it ran before - whatever the work answered.
   * The answer is the work's, with `gateway: { paused, restarted }`. Counts as
   * a change: one at a time, and only with a confirmation surface (the trusted
   * action that calls it has asked the person already).
   */
  async function whileStopped(work) {
    const before = await status();
    const state = before.ok ? before.data.gateway?.state ?? null : null;
    const paused = state === "running" || state === "starting";
    if (paused) {
      const stopped = await stop();
      if (!stopped.ok) return stopped;
    }
    let result;
    let restarted = false;
    try {
      result = await work();
    } finally {
      // Started again whatever the work answered, a failure included.
      if (paused) restarted = (await start()).ok === true;
    }
    return { ...result, gateway: { paused, restarted } };
  }

  /**
   * A change: refused without a confirmation surface, one at a time, and
   * journalled with no target - the input (the key among it) is never looked at
   * here and never recorded.
   */
  const change = (kind, action) => async (input = {}) => {
    const entry = journal?.beginTrusted(kind, {}) ?? null;
    let result;
    if (!canChange) {
      result = unavailableError("confirmation_surface_unavailable");
    } else if (inflight !== null) {
      result = { ok: false, error: { code: "busy", reasonCode: `${inflight.kind}_in_progress` } };
    } else {
      inflight = { kind, startedAtUtc: new Date().toISOString() };
      try {
        result = await action(input);
      } catch {
        // A host fault carries no message: it could hold the input.
        result = { ok: false, error: { code: "host_error", reasonCode: "gateway_control_failed", uncertain: true } };
      } finally {
        inflight = null;
      }
    }
    if (entry !== null) journal.completeTrusted(entry, result);
    return result;
  };

  return {
    status,
    keyStatus,
    autostartStatus,
    start: change("gateway-start", start),
    stop: change("gateway-stop", stop),
    recover: change("gateway-recover", recover),
    setKey: change("api-key-set", setKey),
    removeKey: change("api-key-remove", removeKey),
    installAutostart: change("autostart-install", installAutostart),
    uninstallAutostart: change("autostart-uninstall", uninstallAutostart),
    projectCommand,
    syncCommand,
    whileStopped: change("gateway-pause", whileStopped),
  };
}

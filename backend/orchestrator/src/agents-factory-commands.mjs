import os from "node:os";
import path from "node:path";

import {
  AgentsFactoryError, defaultExecutor, fail, pathKind, readJsonFile, sha256File, usage,
} from "./agents-factory-common.mjs";
import { runDoctor } from "./agents-factory-doctor.mjs";
import {
  createGatewayContext, followGatewayLogs, gatewayLogs, gatewayRecover, gatewayStart, gatewayStatus, gatewayStop,
} from "./agents-factory-gateway.mjs";
import { createKeyStore, keyStatus, normalizeApiKey } from "./agents-factory-key.mjs";
import { migrateInstance, readInstanceRecord } from "./agents-factory-migrate.mjs";
import { resolveLayout } from "./agents-factory-paths.mjs";
import { PINNED_CLAUDE_SDK_VERSION,
  DEFAULT_NPM_REGISTRY, inspectSdkPath, installClaudeSdk, listInstalledSdks,
} from "./agents-factory-sdk.mjs";
import { createServiceManager, serviceCommand } from "./agents-factory-service.mjs";
import { configureClaudeProvider, runSetup } from "./agents-factory-setup.mjs";
import { exportProject, ProjectPackageError } from "./project-package-export.mjs";
import { importProject, migrateToSplitLayout } from "./project-package-import.mjs";
import { mountProject, unmountProject } from "./project-mount.mjs";
import { readInstanceMode, setInstanceMode } from "./instance-mode.mjs";
import { moveInstance } from "./instance-move.mjs";
import { relocateInstance } from "./instance-relocate.mjs";
import { projectPolicy, readMachines, readThisMachine, setThisMachine } from "./machine-identity.mjs";
import {
  initWorld, recoverSync, releaseAll, releaseProject, releaseWorld, syncStatus, takeAll, takeProject, takeWorld,
} from "./sync-engine.mjs";

// `agents-factory <group> <command> [--instance <folder>] [--json]`
// (docs/distribution/stage-0.md). With --json stdout carries exactly one JSON
// object: { "ok": true, ... } or { "ok": false, "code", "message" }. Exit codes:
// 0 success, 1 failure, 2 invalid arguments.

export const AGENTS_FACTORY_CLI_VERSION = "v0.2.0";

const GLOBAL_OPTIONS = Object.freeze({
  instance: "value", "data-dir": "value", json: "flag", yes: "flag", "non-interactive": "flag", node: "value",
});

const COMMANDS = Object.freeze({
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
  "instance move": { to: "value", confirm: "value", "atlas-config": "value", "machine-id": "value", "machine-title": "value",
    home: "flag" },
  "instance relocate": { from: "value", confirm: "value", "atlas-config": "value" },
  "instance mode": { set: "value", confirm: "value", "sync-config": "value", "machine-id": "value", "machine-title": "value",
    home: "flag" },
  "machine set": { id: "value", title: "value", home: "flag" },
  "machine status": {},
  "sync status": { remote: "flag" },
  "sync init": { confirm: "value" },
  "sync take": { world: "flag", project: "value", confirm: "value" },
  "sync release": { world: "flag", project: "value", confirm: "value" },
  "sync recover": { apply: "flag", confirm: "value" },
  setup: {
    template: "value", "atlas-config": "value", "replace-atlas-config": "flag", "install-sdk": "flag",
    "sdk-version": "value", "sdk-path": "value", registry: "value", "no-start": "flag", provider: "value",
    headless: "flag", "timeout-seconds": "value", "project-id": "value", mode: "value", "sync-config": "value",
    "machine-id": "value", "machine-title": "value", home: "flag",
  },
  doctor: {},
  migrate: { "dry-run": "flag" },
  version: {},
  help: {},
});

const GROUPS = new Set(["gateway", "service", "key", "claude", "project", "instance", "machine", "sync"]);

/** --home-only and --only-on as a project policy, or null when neither is given. */
function policyOption(options) {
  const onlyOn = typeof options["only-on"] === "string"
    ? options["only-on"].split(",").map((item) => item.trim()).filter(Boolean) : null;
  if (options["home-only"] !== true && onlyOn === null) return null;
  try {
    return projectPolicy({ homeOnly: options["home-only"] === true, allowedMachines: onlyOn });
  } catch {
    return usage("--only-on needs machine ids (letters, digits, '-' or '_'), separated by commas");
  }
}

export const HELP_TEXT = `agents-factory ${AGENTS_FACTORY_CLI_VERSION}

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

The instance defaults to AGENTS_FACTORY_HOME, else <data>/controller; the data
folder defaults to the OS's (AGENTS_FACTORY_DATA_DIR overrides).
`;

const FLAG_NAMES = new Set([GLOBAL_OPTIONS, ...Object.values(COMMANDS)]
  .flatMap((spec) => Object.entries(spec)).filter(([, kind]) => kind === "flag").map(([name]) => name));

export function parseCommandLine(argv) {
  const words = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    if (key === "" || Object.hasOwn(options, key)) usage(`Repeated or empty option: ${token}`);
    let value = equals === -1 ? null : token.slice(equals + 1);
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
  const spec = COMMANDS[command];
  if (!spec) usage(`Unknown command: ${command}`);
  const allowed = { ...GLOBAL_OPTIONS, ...spec };
  const parsed = {};
  for (const [key, value] of Object.entries(options)) {
    const kind = allowed[key];
    if (!kind) usage(`Unknown option for ${command}: --${key}`);
    if (kind === "flag") {
      if (value !== null && !["true", "false"].includes(value)) usage(`--${key} takes no value`);
      parsed[key] = value !== "false";
    } else {
      if (value === null || value === "") usage(`--${key} needs a value`);
      parsed[key] = value;
    }
  }
  return { command, options: parsed };
}

function integerOption(options, key, fallback, minimum, maximum) {
  if (options[key] === undefined) return fallback;
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
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > limit) fail("key_invalid", "The key input is too long");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
      if (error) reject(error); else resolve(value);
    };
    const onData = (data) => {
      for (const character of data.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new AgentsFactoryError("key_input_cancelled", "Cancelled"));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
      return undefined;
    };
    stdin.on("data", onData);
  });
}

function cliScriptPath() {
  return path.resolve(process.argv[1] ?? "agents-factory.mjs");
}

async function claudeStatus({ layout, env, keyStore, platform }) {
  const installed = await listInstalledSdks(layout);
  const config = await readJsonFile(layout.claudeProvider, { invalidCode: "claude_provider_config_invalid" }).catch(() => null);
  const configured = config?.sdkPath ? await inspectSdkPath(config.sdkPath, { platform }) : null;
  const environmentKey = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "";
  let storedKey = false;
  let keyStoreReason = null;
  try { storedKey = await keyStore.has(); } catch (error) { keyStoreReason = error?.code ?? "key_store_unavailable"; }
  const apiKeySource = environmentKey ? "environment" : storedKey ? "key-store" : "none";
  const keep = config?.keepProviderVariables === true;
  return {
    command: "claude status",
    sdk: {
      root: layout.sdkRoot,
      installed: installed.map(({ version, sdkPath, sdkPresent, programPresent }) => ({ version, sdkPath, sdkPresent, programPresent })),
      configured: configured === null ? null : { ...configured, managed: configured.sdkPath.startsWith(layout.sdkRoot + path.sep) },
    },
    provider: { path: layout.claudeProvider, present: config !== null, keepProviderVariables: keep },
    auth: {
      method: keep && apiKeySource !== "none" ? "api-key" : "claude-code-login",
      apiKeySource,
      ...(keyStoreReason ? { keyStoreReasonCode: keyStoreReason } : {}),
    },
  };
}

async function versionInfo({ layout }) {
  const instanceExists = (await pathKind(layout.instanceDir)) === "directory";
  let instance = { path: layout.instanceDir, exists: instanceExists };
  if (instanceExists) {
    const record = await readInstanceRecord(layout).catch(() => null);
    const projectVersion = await readJsonFile(layout.projectVersion).catch(() => null);
    const gatewayCli = (await pathKind(layout.installedGatewayCli)) === "file" ? layout.installedGatewayCli : null;
    instance = { ...instance, schemaVersion: record?.schemaVersion ?? null, projectId: projectVersion?.projectName ?? null,
      projectVersion: projectVersion?.projectVersion ?? null,
      gatewayRuntime: gatewayCli === null ? null : { path: gatewayCli, sha256: await sha256File(gatewayCli) } };
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
    sdk: { configuredVersion: configured?.version ?? null, installed: (await listInstalledSdks(layout)).map((item) => item.version) },
  };
}

/**
 * Runs one command. `io` carries everything the outside world provides, so
 * tests can run commands in-process with fakes.
 */
export async function executeCommand(command, options, io) {
  const { env, platform, executor } = io;
  const layout = resolveLayout({ options, env, platform, homeDir: io.homeDir });
  const keyStore = io.keyStore ?? createKeyStore({ platform, layout, executor, env });
  const gatewayContext = () => createGatewayContext({ layout, options, env, platform, executor, launcher: io.launcher ?? null, keyStore });
  const timeout = (fallback) => integerOption(options, "timeout-seconds", fallback, 1, 600) * 1000;
  switch (command) {
    case "help": return { command: "help", text: HELP_TEXT };
    case "version": return versionInfo({ layout });
    case "gateway start": {
      const settings = { provider: providerOption(options), visible: options["visible-monitor"] === true,
        timeoutMs: timeout(30), planOnly: options["plan-only"] === true };
      return gatewayStart(await gatewayContext(), settings);
    }
    case "gateway stop": {
      const settings = { timeoutMs: timeout(15), planOnly: options["plan-only"] === true };
      return gatewayStop(await gatewayContext(), settings);
    }
    case "gateway status": return gatewayStatus(await gatewayContext());
    case "gateway recover": return gatewayRecover(await gatewayContext(), { planOnly: options["plan-only"] === true });
    case "gateway logs": {
      const lines = integerOption(options, "lines", 50, 1, 5000);
      if (options.follow) {
        if (options.json) usage("--follow prints lines as they come; it has no --json form");
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        const logs = await gatewayLogs(layout, { lines });
        for (const file of logs.files) for (const line of file.lines) io.stdout.write(`[${file.stream}] ${line}\n`);
        await followGatewayLogs(layout, { write: (text) => io.stdout.write(text), signal: controller.signal });
        return null;
      }
      return gatewayLogs(layout, { lines });
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
      if ((await pathKind(layout.instanceDir)) !== "directory") fail("instance_missing", `No controller instance at ${layout.instanceDir}`);
      const nodePath = options.node ? path.resolve(options.node) : process.execPath;
      const cliPath = options.cli ? path.resolve(options.cli)
        : (await pathKind(layout.installedCli)) === "file" ? layout.installedCli : cliScriptPath();
      const commandLine = serviceCommand({ nodePath, cliPath, instanceDir: layout.instanceDir, provider,
        electron: Boolean(process.versions.electron) && nodePath === process.execPath });
      return options["plan-only"] ? manager.plan(commandLine, { mechanism }) : manager.install(commandLine, { mechanism });
    }
    case "key set": {
      const text = io.stdin.isTTY && !options.json ? await readHiddenLine(io.stdin, io.stderr) : await readStdin(io.stdin);
      await keyStore.set(normalizeApiKey(text));
      return { command: "key set", stored: true, store: keyStore.kind };
    }
    case "key status": return { command: "key status", ...(await keyStatus({ env, store: keyStore })) };
    case "key remove": return { command: "key remove", removed: await keyStore.remove(), store: keyStore.kind };
    case "claude install": {
      const installed = await installClaudeSdk({ layout, requested: options.version ?? PINNED_CLAUDE_SDK_VERSION,
        registry: options.registry ?? env.AGENTS_FACTORY_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY, fetchImpl: io.fetch, platform });
      const result = { command: "claude install", ...installed };
      if (options.configure) {
        if ((await pathKind(layout.instanceDir)) !== "directory") fail("instance_missing", `No controller instance at ${layout.instanceDir}`);
        result.provider = await configureClaudeProvider(layout, installed.sdkPath);
      }
      return result;
    }
    case "claude status": return claudeStatus({ layout, env, keyStore, platform });
    case "setup":
      if (options.provider) providerOption(options);
      if (options["timeout-seconds"]) integerOption(options, "timeout-seconds", 30, 1, 600);
      if (options.mode !== undefined && options.mode !== "local" && options.mode !== "synced") usage("setup: --mode is local or synced");
      if (options.mode === undefined && (options["sync-config"] !== undefined || options["machine-id"] !== undefined)) {
        usage("setup: --sync-config and --machine-id go with --mode synced");
      }
      return runSetup({ layout, options, env, platform, executor, launcher: io.launcher ?? null, keyStore,
        fetchImpl: io.fetch, cliVersion: AGENTS_FACTORY_CLI_VERSION });
    case "doctor": {
      const serviceManager = io.serviceManager ?? createServiceManager({ platform, env, homeDir: io.homeDir, executor, layout });
      return runDoctor({ layout, options, env, platform, executor, keyStore, serviceManager });
    }
    case "migrate": return migrateInstance({ layout, dryRun: options["dry-run"] === true });
    case "project export": {
      // docs/project-package.md §6.4: read-only on the instance, writes only the package's
      // .desk/ and project.af.json. Refuses while the Gateway runs.
      if (typeof options.project !== "string") usage("project export needs --project <id>");
      if (typeof options.out !== "string") usage("project export needs --out <package folder>");
      try {
        return { command, ...(await exportProject({
          controllerRoot: layout.instanceDir, projectId: options.project, out: path.resolve(options.out),
          machineId: typeof options.machine === "string" ? options.machine
            : (await readThisMachine(layout.instanceDir))?.machineId ?? null,
          policy: policyOption(options),
        })) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "machine set":
    case "machine status": {
      // This PC's name in the world (machine-identity.mjs): where projects are shown to live, and
      // what --only-on names.
      if (command === "machine status") {
        return { command, machine: await readThisMachine(layout.instanceDir), machines: await readMachines(layout.instanceDir) };
      }
      if (typeof options.id !== "string") usage("machine set needs --id <id>");
      try {
        return { command, machine: await setThisMachine(layout.instanceDir, { machineId: options.id,
          title: typeof options.title === "string" ? options.title : null, home: options.home === true ? true : null }) };
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
      // docs/project-package.md §14: the world and projects between PCs. Every change names this PC
      // (--confirm), as the person confirmed it; status only reads (--remote fetches each lock), and so
      // does recover without --apply.
      try {
        if (command === "sync status") return { command, ...(await syncStatus({ controllerRoot: layout.instanceDir, remote: options.remote === true })) };
        if (command === "sync recover" && options.apply !== true) {
          if (options.confirm !== undefined) usage("sync recover: --confirm goes with --apply");
          return { command, ...(await recoverSync({ controllerRoot: layout.instanceDir })) };
        }
        const machine = await readThisMachine(layout.instanceDir);
        if (machine === null) throw new AgentsFactoryError("sync_machine_unnamed", "agents-factory machine set --id <id> first");
        if (options.confirm !== machine.machineId) usage(`${command} needs --confirm ${machine.machineId} (this PC)`);
        if (command === "sync recover") return { command, ...(await recoverSync({ controllerRoot: layout.instanceDir, apply: true })) };
        if (options.world === true && typeof options.project === "string") usage("--world or --project, not both");
        const controllerRoot = layout.instanceDir;
        if (command === "sync init") return { command, ...(await initWorld({ controllerRoot })) };
        const take = command === "sync take";
        if (options.world === true) return { command, ...(await (take ? takeWorld : releaseWorld)({ controllerRoot })) };
        if (typeof options.project === "string") {
          return { command, ...(await (take ? takeProject : releaseProject)({ controllerRoot, projectId: options.project })) };
        }
        return { command, ...(await (take ? takeAll : releaseAll)({ controllerRoot })) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "instance move": {
      // docs/project-package.md §10a: run on the instance as it is, naming the new folder twice.
      if (typeof options.to !== "string") usage("instance move needs --to <new folder> --confirm <new folder>");
      if (typeof options["machine-id"] !== "string" && (options["machine-title"] !== undefined || options.home === true)) {
        usage("instance move: --machine-title and --home go with --machine-id");
      }
      try {
        return { command, ...(await moveInstance({ controllerRoot: layout.instanceDir, to: path.resolve(options.to),
          confirm: typeof options.confirm === "string" ? path.resolve(options.confirm) : null,
          atlasConfig: typeof options["atlas-config"] === "string" ? path.resolve(options["atlas-config"]) : null,
          machine: typeof options["machine-id"] === "string" ? { machineId: options["machine-id"],
            title: typeof options["machine-title"] === "string" ? options["machine-title"] : null,
            home: options.home === true ? true : null } : null })) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "instance mode": {
      // docs/project-package.md §14.9: without --set, what the mode is and what a synced instance lacks.
      if (options.set === undefined && (options.confirm !== undefined || options["sync-config"] !== undefined
          || options["machine-id"] !== undefined)) {
        usage("instance mode: --confirm, --sync-config and --machine-id go with --set");
      }
      try {
        if (options.set === undefined) return { command, ...(await readInstanceMode(layout.instanceDir)) };
        return { command, ...(await setInstanceMode({ controllerRoot: layout.instanceDir, mode: options.set,
          confirm: typeof options.confirm === "string" ? options.confirm : null,
          syncConfig: typeof options["sync-config"] === "string" ? path.resolve(options["sync-config"]) : null,
          machine: typeof options["machine-id"] === "string" ? { machineId: options["machine-id"],
            title: typeof options["machine-title"] === "string" ? options["machine-title"] : null,
            home: options.home === true ? true : null } : null })) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "instance relocate": {
      // docs/project-package.md §10: run in the new place, naming the old one twice.
      if (typeof options.from !== "string") usage("instance relocate needs --from <old folder> --confirm <old folder>");
      try {
        return { command, ...(await relocateInstance({ controllerRoot: layout.instanceDir, from: path.resolve(options.from),
          confirm: typeof options.confirm === "string" ? path.resolve(options.confirm) : null,
          atlasConfig: typeof options["atlas-config"] === "string" ? path.resolve(options["atlas-config"]) : null })) };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "project unmount":
    case "project mount": {
      // docs/project-package.md §7: unmount writes and checks the package before it takes anything off.
      const unmount = command === "project unmount";
      if (unmount && (typeof options.project !== "string" || typeof options.out !== "string")) {
        usage("project unmount needs --project <id> --out <package folder> --confirm <id>");
      }
      if (!unmount && typeof options.package !== "string") usage("project mount needs --package <folder>");
      try {
        const result = unmount
          ? await unmountProject({ controllerRoot: layout.instanceDir, projectId: options.project,
            out: path.resolve(options.out), confirm: typeof options.confirm === "string" ? options.confirm : null,
            policy: policyOption(options) })
          : await mountProject({ controllerRoot: layout.instanceDir, packageDir: path.resolve(options.package) });
        return { command, ...result };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    case "project import":
    case "project migrate-layout": {
      // docs/project-package.md §6.5-§6.6. The migration exports, imports and compares;
      // anything short of equal is undone, the single database is never changed.
      if (command === "project import" && typeof options.package !== "string") usage("project import needs --package <folder>");
      try {
        const result = command === "project import"
          ? await importProject({ controllerRoot: layout.instanceDir, packageDir: path.resolve(options.package) })
          : await migrateToSplitLayout({ controllerRoot: layout.instanceDir });
        return { command, ...result };
      } catch (error) {
        if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
        throw error;
      }
    }
    default: return usage(`Unknown command: ${command}`);
  }
}

function errorRecord(error) {
  if (error instanceof AgentsFactoryError) {
    return { record: { ok: false, code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) },
      exitCode: error.exitCode };
  }
  const code = typeof error?.code === "string" && /^[A-Z]{2,}[A-Z_]*$/u.test(error.code) ? `io_${error.code.toLowerCase()}` : "unexpected_failure";
  return { record: { ok: false, code, message: "The command failed unexpectedly" }, exitCode: 1 };
}

export async function runCli(argv, io = {}) {
  const context = {
    env: io.env ?? process.env,
    platform: io.platform ?? process.platform,
    homeDir: io.homeDir ?? os.homedir(),
    executor: io.executor ?? defaultExecutor,
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    fetch: io.fetch ?? globalThis.fetch,
    launcher: io.launcher ?? null,
    keyStore: io.keyStore ?? null,
    serviceManager: io.serviceManager ?? null,
  };
  let json = argv.includes("--json");
  try {
    const { command, options } = parseCommandLine(argv);
    json = options.json === true;
    const result = await executeCommand(command, options, context);
    if (result === null) return 0;
    if (command === "help" && !json) context.stdout.write(result.text);
    else if (command === "gateway logs" && !json) {
      for (const file of result.files) {
        context.stdout.write(`== ${file.stream}: ${file.path}${file.exists ? "" : " (missing)"}\n`);
        for (const line of file.lines) context.stdout.write(`${line}\n`);
      }
    } else context.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, json ? undefined : 2)}\n`);
    return 0;
  } catch (error) {
    const { record, exitCode } = errorRecord(error);
    if (json) context.stdout.write(`${JSON.stringify(record)}\n`);
    else context.stderr.write(`agents-factory: ${record.code}: ${record.message}\n`);
    return exitCode;
  }
}

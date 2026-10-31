import os from "node:os";
import path from "node:path";

// Where Agents Factory keeps its data (docs/distribution/stage-0.md):
// Windows %LOCALAPPDATA%\AgentsFactory (not Documents: OneDrive may sync it and
// damage SQLite), macOS ~/Library/Application Support/AgentsFactory, Linux
// $XDG_DATA_HOME/agents-factory. The controller instance defaults to
// AGENTS_FACTORY_HOME, else <data>/controller. AGENTS_FACTORY_DATA_DIR moves
// the data folder itself (keys, SDK runtimes), for tests and portable setups.

export const AGENTS_FACTORY_INSTANCE_ENV = "AGENTS_FACTORY_HOME";
export const AGENTS_FACTORY_DATA_ENV = "AGENTS_FACTORY_DATA_DIR";

export function pathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function agentsFactoryDataDir({
  env = process.env, platform = process.platform, homeDir = os.homedir(),
} = {}) {
  const api = pathApi(platform);
  if (typeof env[AGENTS_FACTORY_DATA_ENV] === "string" && env[AGENTS_FACTORY_DATA_ENV].trim() !== "") {
    return api.resolve(env[AGENTS_FACTORY_DATA_ENV]);
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA && api.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA : api.join(homeDir, "AppData", "Local");
    return api.join(local, "AgentsFactory");
  }
  if (platform === "darwin") return api.join(homeDir, "Library", "Application Support", "AgentsFactory");
  const xdg = env.XDG_DATA_HOME && api.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : api.join(homeDir, ".local", "share");
  return api.join(xdg, "agents-factory");
}

export function defaultInstanceDir(options = {}) {
  const { env = process.env, platform = process.platform } = options;
  const api = pathApi(platform);
  if (typeof env[AGENTS_FACTORY_INSTANCE_ENV] === "string" && env[AGENTS_FACTORY_INSTANCE_ENV].trim() !== "") {
    return api.resolve(env[AGENTS_FACTORY_INSTANCE_ENV]);
  }
  return api.join(agentsFactoryDataDir(options), "controller");
}

/** Every path the CLI reads or writes, from the data folder and the instance. */
export function agentsFactoryLayout({ dataDir, instanceDir, platform = process.platform }) {
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
    backupsDir: api.join(instanceDir, ".project-local", "backups"),
  });
}

export function resolveLayout({ options = {}, env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const api = pathApi(platform);
  const dataDir = options["data-dir"] ? api.resolve(options["data-dir"]) : agentsFactoryDataDir({ env, platform, homeDir });
  const instanceDir = options.instance
    ? api.resolve(options.instance)
    : (typeof env[AGENTS_FACTORY_INSTANCE_ENV] === "string" && env[AGENTS_FACTORY_INSTANCE_ENV].trim() !== ""
      ? api.resolve(env[AGENTS_FACTORY_INSTANCE_ENV]) : api.join(dataDir, "controller"));
  return agentsFactoryLayout({ dataDir, instanceDir, platform });
}

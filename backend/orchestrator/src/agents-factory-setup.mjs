import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm, rmdir, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentsFactoryError, fail, pathKind, readJsonFile, renameWithRetry, writeJsonAtomic } from "./agents-factory-common.mjs";
import { createGatewayContext, gatewayStart } from "./agents-factory-gateway.mjs";
import { migrateInstance, newInstanceRecord, readInstanceRecord } from "./agents-factory-migrate.mjs";
import { DEFAULT_NPM_REGISTRY, PINNED_CLAUDE_SDK_VERSION, installClaudeSdk, listInstalledSdks } from "./agents-factory-sdk.mjs";
import { readInstanceMode, setInstanceMode } from "./instance-mode.mjs";
import { ProjectPackageError } from "./project-package-export.mjs";
import { writeStoreLayoutMarker } from "./project-store-layout.mjs";

// `setup`: everything the first-run wizard did by hand, idempotent, one JSON
// result per step (product-changes.md, section 4). A second run changes
// nothing that is already right; a step that would replace something the
// person set up differently refuses instead.

// The same models as the controller template's claude-provider.example.json.
export const DEFAULT_CLAUDE_MODELS = Object.freeze([
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", efforts: ["default"], defaultEffort: "default" },
]);

async function isEmptyDirectory(directory) {
  return (await readdir(directory)).length === 0;
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) fail("template_link_refused", `The template contains a link: ${from}`);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else fail("template_entry_refused", `The template contains a special file: ${from}`);
  }
}

async function validateTemplate(template) {
  if (!template) fail("template_required", "A new instance needs --template <folder>", { exitCode: 2 });
  const root = path.resolve(template);
  if ((await pathKind(root)) !== "directory") fail("template_invalid", `The template is not a folder: ${root}`);
  const version = await readJsonFile(path.join(root, "project-version.json"), { invalidCode: "template_invalid" });
  if (typeof version?.projectName !== "string") fail("template_invalid", "The template has no project-version.json with projectName");
  if ((await pathKind(path.join(root, ".orchestrator", "runtime", "application-gateway-cli.mjs"))) !== "file") {
    fail("template_invalid", "The template has no .orchestrator/runtime/application-gateway-cli.mjs");
  }
  return root;
}

async function instanceStep(layout, { template, cliVersion }) {
  const createdBy = `agents-factory ${cliVersion}`;
  const kind = await pathKind(layout.instanceDir);
  if (kind === "directory" && (await pathKind(layout.instanceRecord)) === "file") {
    const record = await readInstanceRecord(layout);
    return { step: "instance", status: "existing", path: layout.instanceDir, schemaVersion: record.schemaVersion };
  }
  if (kind === "directory" && !(await isEmptyDirectory(layout.instanceDir))) {
    // A controller installed before instance.json existed (patch installs): schema 1, its
    // migrations bring it to the split layout.
    if ((await pathKind(layout.projectVersion)) === "file" && (await pathKind(layout.installedGatewayCli)) === "file") {
      const record = newInstanceRecord({ createdBy, schemaVersion: 1 });
      await writeJsonAtomic(layout.instanceRecord, record);
      return { step: "instance", status: "adopted", path: layout.instanceDir, schemaVersion: record.schemaVersion };
    }
    fail("instance_folder_not_empty", `The instance folder is not empty and is not a controller: ${layout.instanceDir}`);
  }
  if (kind !== null && kind !== "directory") fail("instance_folder_invalid", `The instance path is not a folder: ${layout.instanceDir}`);
  const source = await validateTemplate(template);
  const relative = path.relative(source, layout.instanceDir);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail("instance_inside_template", "The instance cannot be inside its template", { exitCode: 2 });
  }
  const parent = path.dirname(layout.instanceDir);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(layout.instanceDir)}.staging-${randomUUID()}`);
  try {
    await copyTree(source, staging);
    const record = newInstanceRecord({ createdBy });
    await writeJsonAtomic(path.join(staging, "instance.json"), record);
    // A new instance keeps one memory database per project from the start (schema 2).
    await writeStoreLayoutMarker(staging);
    if (kind === "directory") await rmdir(layout.instanceDir);
    await renameWithRetry(staging, layout.instanceDir);
    return { step: "instance", status: "created", path: layout.instanceDir, template: source, schemaVersion: record.schemaVersion };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function sdkStep(layout, options, { fetchImpl, env, platform }) {
  if (options["sdk-path"]) {
    const sdkPath = path.resolve(options["sdk-path"]);
    if ((await pathKind(path.join(sdkPath, "sdk.mjs"))) !== "file") {
      fail("sdk_path_invalid", `No Claude Agent SDK (sdk.mjs) at ${sdkPath}`, { exitCode: 2 });
    }
    return { step: "claude-sdk", status: "provided", sdkPath, version: null };
  }
  if (options["install-sdk"]) {
    const installed = await installClaudeSdk({ layout, requested: options["sdk-version"] ?? PINNED_CLAUDE_SDK_VERSION,
      registry: options.registry ?? env.AGENTS_FACTORY_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY, fetchImpl, platform });
    return { step: "claude-sdk", status: installed.state, sdkPath: installed.sdkPath, version: installed.version };
  }
  const existing = await readJsonFile(layout.claudeProvider, { invalidCode: "claude_provider_config_invalid" });
  if (typeof existing?.sdkPath === "string" && path.isAbsolute(existing.sdkPath)
      && (await pathKind(path.join(existing.sdkPath, "sdk.mjs"))) === "file") {
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
    const next = { ...existing, ...(sdkPath ? { sdkPath } : {}), keepProviderVariables: true };
    if (typeof next.sdkPath !== "string") return { step: "claude-provider", status: "skipped", reasonCode: "sdk_not_installed", path: layout.claudeProvider };
    if (JSON.stringify(next) === JSON.stringify(existing)) {
      return { step: "claude-provider", status: "unchanged", path: layout.claudeProvider, sdkPath: next.sdkPath, keepProviderVariables: true };
    }
    await writeJsonAtomic(layout.claudeProvider, next);
    return { step: "claude-provider", status: "updated", path: layout.claudeProvider, sdkPath: next.sdkPath, keepProviderVariables: true };
  }
  if (!sdkPath) return { step: "claude-provider", status: "skipped", reasonCode: "sdk_not_installed", path: layout.claudeProvider };
  await writeJsonAtomic(layout.claudeProvider, {
    schemaVersion: 1, sdkPath, claudeConfigDir: null, keepProviderVariables: true,
    models: DEFAULT_CLAUDE_MODELS.map((model) => ({ ...model })), settingSources: ["project", "local"],
    permissionMode: "acceptEdits",
  });
  return { step: "claude-provider", status: "created", path: layout.claudeProvider, sdkPath, keepProviderVariables: true };
}

/** Points claude-provider.json at an SDK, keeping the person's other settings. */
export async function configureClaudeProvider(layout, sdkPath) {
  return providerStep(layout, sdkPath);
}

async function controlCycleStep(layout) {
  if ((await pathKind(layout.controlCycle)) === "file") return { step: "control-cycle", status: "existing", path: layout.controlCycle };
  if ((await pathKind(layout.controlCycleExample)) !== "file") {
    return { step: "control-cycle", status: "skipped", reasonCode: "control_cycle_example_missing", path: layout.controlCycle };
  }
  const example = await readJsonFile(layout.controlCycleExample, { invalidCode: "control_cycle_example_invalid" });
  await writeJsonAtomic(layout.controlCycle, example);
  return { step: "control-cycle", status: "created", path: layout.controlCycle, from: layout.controlCycleExample };
}

async function atlasStep(layout, options) {
  const file = options["atlas-config"] ? path.resolve(options["atlas-config"]) : null;
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
  const same = existing !== null && typeof existing.controllerRoot === "string"
    && path.resolve(existing.controllerRoot) === layout.instanceDir
    && existing.expectedWorkspace?.projectId === expectedWorkspace.projectId
    && existing.expectedWorkspace?.workspaceRootSha256 === expectedWorkspace.workspaceRootSha256;
  if (same) return { step: "atlas-config", status: "unchanged", path: file, controllerRoot: layout.instanceDir, expectedWorkspace };
  const configured = existing !== null && typeof existing.controllerRoot === "string"
    && !existing.controllerRoot.trim().startsWith("<");
  // Trust on first use: another controller is replaced only on request.
  if (configured && !options["replace-atlas-config"]) {
    fail("atlas_config_conflict", "The Atlas config names another controller; pass --replace-atlas-config to switch");
  }
  const base = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  await writeJsonAtomic(file, { ...base, controllerRoot: layout.instanceDir, expectedWorkspace });
  return { step: "atlas-config", status: existing === null ? "created" : "updated", path: file,
    controllerRoot: layout.instanceDir, expectedWorkspace };
}

/**
 * This PC's paths for the launchers of a source install (start-atlas.bat, claude-login.bat; plan
 * 4.3): `.project-local/launch.cmd` with the Node that runs this CLI and the Atlas folder of
 * `--atlas-config`. Machine-local, never synced; one the person already has is kept. Windows only.
 */
async function launcherStep(layout, options, platform) {
  const file = path.join(layout.instanceDir, ".project-local", "launch.cmd");
  if (platform !== "win32") return { step: "launcher", status: "skipped", reasonCode: "not_windows" };
  if (!options["atlas-config"] || options.headless) return { step: "launcher", status: "skipped", reasonCode: "no_atlas" };
  const atlas = path.dirname(path.dirname(path.resolve(options["atlas-config"])));
  if ((await pathKind(file)) !== null) return { step: "launcher", status: "kept", path: file };
  await mkdir(path.dirname(file), { recursive: true });
  const lines = ["@rem This PC's paths for start-atlas.bat and claude-login.bat (machine-local, never synced).",
    "@rem Written by agents-factory setup; edit freely, setup keeps it.",
    `@set "NODE=${process.execPath}"`, `@set "ATLAS=${atlas}"`, ""];
  await writeFile(file, lines.join("\r\n"), "utf8");
  return { step: "launcher", status: "created", path: file, node: process.execPath, atlas };
}

async function environmentStep(layout) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const warnings = [];
  if (major < 22 || (major === 22 && minor < 13)) warnings.push("node_older_than_22_13");
  let freeBytes = null;
  try {
    let probe = layout.dataDir;
    while ((await pathKind(probe)) === null && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const info = await statfs(probe);
    freeBytes = Number(info.bavail) * Number(info.bsize);
    if (freeBytes < 2 * 1024 * 1024 * 1024) warnings.push("disk_space_low");
  } catch { warnings.push("disk_space_unknown"); }
  return { step: "environment", status: warnings.length === 0 ? "ok" : "warning", node: process.version,
    electron: process.versions.electron ?? null, freeBytes, warnings };
}

/**
 * Local or synced (plan 5.1): `--mode` sets it (synced with `--sync-config` and `--machine-id`);
 * without it the mode stays as it is and the step says which it is.
 */
async function modeStep(layout, options) {
  try {
    if (typeof options.mode !== "string") {
      const current = await readInstanceMode(layout.instanceDir);
      return { step: "mode", status: "kept", mode: current.mode, missing: current.missing };
    }
    const result = await setInstanceMode({ controllerRoot: layout.instanceDir, mode: options.mode, confirm: options.mode,
      syncConfig: typeof options["sync-config"] === "string" ? path.resolve(options["sync-config"]) : null,
      machine: typeof options["machine-id"] === "string" ? { machineId: options["machine-id"],
        title: typeof options["machine-title"] === "string" ? options["machine-title"] : null,
        home: options.home === true ? true : null } : null });
    return { step: "mode", status: result.previous === result.mode ? "kept" : "set", mode: result.mode,
      previous: result.previous, missing: result.missing };
  } catch (error) {
    if (error instanceof ProjectPackageError) throw new AgentsFactoryError(error.code, error.message);
    throw error;
  }
}

export async function runSetup({
  layout, options = {}, env = process.env, platform = process.platform, executor, launcher = null, keyStore = null,
  fetchImpl = globalThis.fetch, cliVersion,
}) {
  const steps = [];
  const run = async (name, action) => {
    try {
      const result = await action();
      steps.push(result);
      return result;
    } catch (error) {
      const code = error instanceof AgentsFactoryError ? error.code : "setup_step_failed";
      steps.push({ step: name, status: "failed", code, ...(error?.detail ? { detail: error.detail } : {}) });
      throw new AgentsFactoryError(code, error?.message ?? code, {
        exitCode: error?.exitCode ?? 1, detail: { failedStep: name, steps },
      });
    }
  };
  await run("environment", () => environmentStep(layout));
  await run("instance", () => instanceStep(layout, { template: options.template, cliVersion }));
  await run("instance-schema", async () => {
    const migrated = await migrateInstance({ layout });
    return { step: "instance-schema", status: migrated.state, schemaVersion: migrated.schemaVersion,
      applied: migrated.applied, backup: migrated.backup?.path ?? null };
  });
  await run("mode", () => modeStep(layout, options));
  const sdk = await run("claude-sdk", () => sdkStep(layout, options, { fetchImpl, env, platform }));
  const provider = await run("claude-provider", () => providerStep(layout, sdk.sdkPath));
  await run("control-cycle", () => controlCycleStep(layout));
  const gatewayProvider = options.provider ?? "claude";
  await run("gateway", async () => {
    if (options["no-start"]) return { step: "gateway", status: "skipped", reasonCode: "no_start" };
    if (gatewayProvider === "claude" && provider.status === "skipped") {
      return { step: "gateway", status: "skipped", reasonCode: "claude_provider_not_configured" };
    }
    const context = await createGatewayContext({ layout, options, env, platform, executor, launcher, keyStore });
    const started = await gatewayStart(context, { provider: gatewayProvider,
      timeoutMs: options["timeout-seconds"] ? Number(options["timeout-seconds"]) * 1000 : 30_000 });
    return { step: "gateway", status: started.launched ? "started" : "already-running", instanceId: started.instanceId,
      processId: started.processId, monitorId: started.monitorId, apiKeySource: started.apiKeySource };
  });
  await run("atlas-config", () => atlasStep(layout, options));
  await run("launcher", () => launcherStep(layout, options, platform));
  return { command: "setup", instance: layout.instanceDir, dataDir: layout.dataDir, steps };
}

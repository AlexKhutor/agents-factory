import { constants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { createServer } from "node:net";
import path from "node:path";

import { pathKind, readJsonFile } from "./agents-factory-common.mjs";
import { createGatewayContext, gatewayStatus } from "./agents-factory-gateway.mjs";
import { keyStatus } from "./agents-factory-key.mjs";
import { migrateInstance, readInstanceRecord } from "./agents-factory-migrate.mjs";
import { readInstanceMode } from "./instance-mode.mjs";
import { inspectSdkPath, listInstalledSdks } from "./agents-factory-sdk.mjs";

// `doctor`: read-only checks, each with an exact hint. It never writes a file,
// never starts the Gateway and never starts a Claude session; the only program
// of Claude it runs is the read-only `claude auth status --json`.

async function nearestExisting(target) {
  let probe = target;
  while ((await pathKind(probe)) === null && path.dirname(probe) !== probe) probe = path.dirname(probe);
  return probe;
}

async function check(id, action) {
  try {
    return { id, ...(await action()) };
  } catch (error) {
    return { id, status: "error", code: typeof error?.code === "string" ? error.code : "check_failed",
      hint: typeof error?.message === "string" ? error.message.slice(0, 300) : null };
  }
}

function loopbackAvailable() {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function runDoctor({ layout, options = {}, env = process.env, platform = process.platform, executor,
  keyStore, serviceManager = null }) {
  const checks = [];
  const add = async (id, action) => checks.push(await check(id, action));
  await add("runtime", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const sqlite = isBuiltin("node:sqlite");
    const ok = (major > 22 || (major === 22 && minor >= 13)) && sqlite;
    return { status: ok ? "ok" : "warning", node: process.version, electron: process.versions.electron ?? null,
      sqlite, ...(ok ? {} : { hint: "Node 22.13 or newer (or Atlas's Electron Node) is needed for node:sqlite" }) };
  });
  await add("git", async () => {
    const result = await executor.run("git", ["--version"], { env, timeoutMs: 15_000 });
    const version = /git version (\S+)/u.exec(result.stdout)?.[1] ?? null;
    return result.status === 0 ? { status: "ok", version }
      : { status: "warning", version: null, hint: "Install git: agents commit their work to the project's git" };
  });
  await add("data-dir", async () => {
    const probe = await nearestExisting(layout.dataDir);
    let writable = true;
    try { await access(probe, constants.W_OK); } catch { writable = false; }
    return { status: writable ? "ok" : "error", path: layout.dataDir, exists: (await pathKind(layout.dataDir)) === "directory",
      writable, ...(writable ? {} : { hint: `No write access to ${probe}` }) };
  });
  await add("disk", async () => {
    const info = await statfs(await nearestExisting(layout.dataDir));
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    return { status: freeBytes >= 2 * 1024 * 1024 * 1024 ? "ok" : "warning", freeBytes,
      ...(freeBytes >= 2 * 1024 * 1024 * 1024 ? {} : { hint: "Less than 2 GB free: the SDK alone needs about 250 MB per version" }) };
  });
  const instanceExists = (await pathKind(layout.instanceDir)) === "directory";
  await add("instance", async () => {
    if (!instanceExists) return { status: "error", path: layout.instanceDir, hint: "Run agents-factory setup --template <folder>" };
    const record = await readInstanceRecord(layout);
    const version = await readJsonFile(layout.projectVersion).catch(() => null);
    const cli = (await pathKind(layout.installedGatewayCli)) === "file" || (await pathKind(layout.sourceGatewayCli)) === "file";
    const ok = record !== null && cli && typeof version?.projectName === "string";
    return { status: ok ? "ok" : "error", path: layout.instanceDir, schemaVersion: record?.schemaVersion ?? null,
      projectId: version?.projectName ?? null, projectVersion: version?.projectVersion ?? null, gatewayRuntime: cli,
      ...(ok ? {} : { hint: record === null ? "No instance.json: run agents-factory setup" : "The instance lacks its Gateway runtime or project identity" }) };
  });
  if (instanceExists && (await pathKind(layout.instanceRecord)) === "file") {
    await add("instance-schema", async () => {
      const plan = await migrateInstance({ layout, dryRun: true });
      return { status: plan.pending.length === 0 ? "ok" : "warning", schemaVersion: plan.schemaVersion,
        targetSchemaVersion: plan.targetSchemaVersion, pending: plan.pending.map((item) => item.id),
        ...(plan.pending.length === 0 ? {} : { hint: "Run agents-factory migrate" }) };
    });
    // Local or synced (plan 5.1): a synced instance names what it still lacks.
    await add("mode", async () => {
      const mode = await readInstanceMode(layout.instanceDir);
      return { status: mode.missing.length === 0 ? "ok" : "warning", mode: mode.mode, recorded: mode.recorded,
        missing: mode.missing, ...(mode.missing.length === 0 ? {} : { hint: "agents-factory instance mode --set synced --confirm synced "
          + "--sync-config <file> --machine-id <id>" }) };
    });
  }
  let providerConfig = null;
  await add("claude-provider", async () => {
    providerConfig = await readJsonFile(layout.claudeProvider, { invalidCode: "claude_provider_config_invalid" });
    if (providerConfig === null) return { status: "warning", path: layout.claudeProvider, hint: "Run agents-factory setup (it writes claude-provider.json)" };
    const valid = providerConfig.schemaVersion === 1 && typeof providerConfig.sdkPath === "string" && path.isAbsolute(providerConfig.sdkPath);
    return { status: valid ? (providerConfig.keepProviderVariables === true ? "ok" : "warning") : "error",
      path: layout.claudeProvider, keepProviderVariables: providerConfig.keepProviderVariables === true,
      ...(valid ? (providerConfig.keepProviderVariables === true ? {} : { hint: "keepProviderVariables is false: turns ignore the API key" })
        : { hint: "claude-provider.json is not valid schema 1" }) };
  });
  let program = null;
  await add("claude-sdk", async () => {
    const installed = await listInstalledSdks(layout);
    const configured = providerConfig?.sdkPath ? await inspectSdkPath(providerConfig.sdkPath, { platform }) : null;
    program = configured?.programPresent ? configured.programPath : null;
    const ok = configured?.present === true && configured.programPresent === true;
    return { status: ok ? "ok" : (configured?.present ? "warning" : "error"),
      installed: installed.map((item) => item.version), configured,
      ...(ok ? {} : { hint: configured?.present ? "The SDK has no Claude Code program for this platform"
        : "Run agents-factory claude install, then setup" }) };
  });
  let hasKey = false;
  await add("api-key", async () => {
    const status = await keyStatus({ env, store: keyStore });
    hasKey = status.hasKey || status.environmentOverride;
    return { status: hasKey ? "ok" : "warning", ...status,
      ...(hasKey ? {} : { hint: "Run agents-factory key set (the key is read from stdin)" }) };
  });
  await add("claude-login", async () => {
    if (program === null) return { status: "skipped", reasonCode: "claude_program_missing" };
    const childEnv = { ...env };
    if (providerConfig?.keepProviderVariables === true && !childEnv.ANTHROPIC_API_KEY && hasKey) {
      const key = await keyStore.get().catch(() => null);
      if (key) childEnv.ANTHROPIC_API_KEY = key;
    }
    if (providerConfig?.keepProviderVariables !== true) delete childEnv.ANTHROPIC_API_KEY;
    const result = await executor.run(program, ["auth", "status", "--json"], { env: childEnv, timeoutMs: 20_000 });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
    const word = (value) => (typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : null);
    if (parsed === null) return { status: "warning", loggedIn: null, hint: "claude auth status gave no answer" };
    return { status: parsed.loggedIn === true ? "ok" : "warning", loggedIn: parsed.loggedIn === true,
      authMethod: word(parsed.authMethod), apiProvider: word(parsed.apiProvider),
      ...(parsed.loggedIn === true ? {} : { hint: "Claude Code is not signed in: store an API key with agents-factory key set" }) };
  });
  await add("control-cycle", async () => {
    const present = (await pathKind(layout.controlCycle)) === "file";
    return { status: present ? "ok" : "warning", path: layout.controlCycle, ...(present ? {} : { hint: "Run agents-factory setup" }) };
  });
  await add("gateway", async () => {
    if (!instanceExists) return { status: "skipped", reasonCode: "instance_missing" };
    const context = await createGatewayContext({ layout, options, env, platform, executor });
    if (context.cli === null) return { status: "error", reasonCode: "gateway_cli_unavailable" };
    const status = await gatewayStatus(context);
    return { status: status.availability === "available" ? "ok" : "warning", availability: status.availability,
      reasonCode: status.reasonCode, lifecycle: status.lifecycle,
      ...(status.availability === "available" ? {} : { hint: status.availability === "stale"
        ? "Run agents-factory gateway recover, then gateway start" : "Run agents-factory gateway start" }) };
  });
  await add("loopback", async () => {
    const available = await loopbackAvailable();
    return { status: available ? "ok" : "error", ...(available ? {} : { hint: "Cannot listen on 127.0.0.1: the Gateway binds loopback only" }) };
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

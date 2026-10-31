import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  ageMs, defaultExecutor, fail, isProcessAlive, nodeChildEnvironment, pathKind, readJsonFile, sleep,
  windowsCommandLine,
} from "./agents-factory-common.mjs";
import { resolveApiKey } from "./agents-factory-key.mjs";
import { assertNotMovedAway } from "./instance-move.mjs";
import { assertWorldHeld } from "./sync-engine.mjs";

// The Gateway lifecycle without PowerShell, with the semantics of
// backend/tools/application_gateway.ps1: a monitor (`watch`) proves the Gateway
// observed before any turn runs (application-gateway-runtime.mjs refuses model
// work without its fresh heartbeat), then `run` starts hidden with its output
// in logs/application_gateway(.error).log, and Start waits for `ready` and for
// the monitor to bind to that exact instance. Stop goes through the Gateway's
// own exact-instance stop request; nothing is killed broadly.

export const GATEWAY_PROVIDERS = Object.freeze(["claude"]);
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MONITOR_STALE_MS = 15_000;
const GATEWAY_STALE_MS = 30_000;
const SAFE_CODE = /^[a-z][a-z0-9_:-]{0,95}$/u;

/** Starts a detached, windowless process with its output in files. */
function spawnDetached(file, args, { cwd, env, stdoutFile = null, stderrFile = null }) {
  const descriptors = [];
  const target = (file_) => {
    if (file_ === null) return "ignore";
    const descriptor = openSync(file_, "a");
    descriptors.push(descriptor);
    return descriptor;
  };
  try {
    const child = spawn(file, args, {
      cwd, env, detached: true, windowsHide: true, stdio: ["ignore", target(stdoutFile), target(stderrFile)],
    });
    let exitCode = null;
    child.on("exit", (code, signal) => { exitCode = code ?? (signal ? 128 : -1); });
    child.on("error", () => { exitCode = exitCode ?? -1; });
    child.unref();
    return { pid: child.pid ?? null, exitCode: () => exitCode };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

// Start-Process opens a console app in its own console window, as the
// PowerShell lifecycle did for its monitor. Values travel in the environment,
// so no path is ever spliced into script text.
const VISIBLE_SCRIPT = `$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath $env:AF_MONITOR_FILE -ArgumentList $env:AF_MONITOR_ARGS -WorkingDirectory $env:AF_MONITOR_CWD -PassThru
[Console]::Out.Write([string]$p.Id)`;

export function visibleMonitorCommand({ file, args, cwd, env }) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return {
    file: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(VISIBLE_SCRIPT, "utf16le").toString("base64")],
    env: { ...env, AF_MONITOR_FILE: file, AF_MONITOR_ARGS: windowsCommandLine(args[0], args.slice(1)),
      AF_MONITOR_CWD: cwd },
  };
}

export function createDefaultLauncher(executor = defaultExecutor) {
  return Object.freeze({
    spawnDetached,
    async openVisible(file, args, { cwd, env }) {
      const command = visibleMonitorCommand({ file, args, cwd, env });
      const result = await executor.run(command.file, command.args, { env: command.env, timeoutMs: 30_000 });
      const pid = Number(result.stdout.trim());
      if (result.status !== 0 || !Number.isSafeInteger(pid) || pid < 1) {
        fail("observability_unavailable", "The visible monitor window did not open");
      }
      return { pid, exitCode: () => (isProcessAlive(pid) ? null : -1) };
    },
  });
}

async function readRecord(file) {
  return readJsonFile(file, { invalidCode: "gateway_runtime_record_invalid" });
}

async function readRecordOrNull(file) {
  try { return await readRecord(file); } catch { return null; }
}

/** Resolves the instance, its project identity and its Gateway runtime. */
export async function createGatewayContext({
  layout, options = {}, env = process.env, platform = process.platform, executor = defaultExecutor,
  launcher = null, keyStore = null,
}) {
  const root = layout.instanceDir;
  if ((await pathKind(root)) !== "directory") {
    fail("instance_missing", `No controller instance at ${root}; run setup first`);
  }
  let projectId = options["project-id"] ?? null;
  if (projectId === null) {
    const version = await readJsonFile(layout.projectVersion, { invalidCode: "gateway_project_identity_unavailable" });
    projectId = typeof version?.projectName === "string" ? version.projectName : null;
    if (projectId === null) fail("gateway_project_identity_unavailable", "project-version.json names no project");
  }
  if (!PROJECT_ID.test(projectId)) fail("gateway_project_identity_invalid", "The project identity is not a bounded identifier");
  const cli = (await pathKind(layout.installedGatewayCli)) === "file" ? layout.installedGatewayCli
    : (await pathKind(layout.sourceGatewayCli)) === "file" ? layout.sourceGatewayCli : null;
  const node = options.node ? path.resolve(options.node) : process.execPath;
  return {
    layout, root, projectId, cli, node, platform, env, executor,
    launcher: launcher ?? createDefaultLauncher(executor), keyStore,
  };
}

function requireCli(context) {
  if (context.cli === null) fail("gateway_cli_unavailable", "The instance has no Gateway runtime (.orchestrator/runtime/application-gateway-cli.mjs)");
  return context.cli;
}

function failureCode(stderr) {
  for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
    try {
      const record = JSON.parse(line);
      if (record?.status === "failed" && typeof record.code === "string" && SAFE_CODE.test(record.code)) {
        return { causeCode: record.code, ...(typeof record.detailCode === "string" && SAFE_CODE.test(record.detailCode)
          ? { detailCode: record.detailCode } : {}) };
      }
    } catch { /* not a diagnostic line */ }
  }
  return null;
}

/** Runs one command of the instance's own Gateway CLI and returns its JSON. */
export async function runGatewayCli(context, command, extra = [], { timeoutMs = 90_000 } = {}) {
  const cli = requireCli(context);
  const result = await context.executor.run(context.node, [cli, command, "--repo-root", context.root,
    "--project-id", context.projectId, "--json", ...extra], {
    cwd: context.root, timeoutMs,
    env: nodeChildEnvironment(context.env, { nodePath: context.node, omit: ["ANTHROPIC_API_KEY"] }),
  });
  if (result.status !== 0) {
    fail(`gateway_${command.replaceAll("-", "_")}_failed`, `Gateway ${command} failed`, { detail: failureCode(result.stderr) });
  }
  try {
    return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  } catch {
    return fail(`gateway_${command.replaceAll("-", "_")}_response_invalid`, `Gateway ${command} returned no JSON`);
  }
}

function gatewayProcessId(status) {
  return status?.identity?.process?.processId ?? null;
}

async function monitorSummary(layout) {
  const [owner, record] = await Promise.all([readRecordOrNull(layout.monitorOwner), readRecordOrNull(layout.monitorStatus)]);
  const source = record ?? owner;
  if (source === null) return null;
  return {
    monitorId: source.monitorId ?? null,
    processId: source.processId ?? null,
    running: isProcessAlive(source.processId),
    health: record?.health ?? null,
    heartbeatAtUtc: record?.heartbeatAtUtc ?? null,
    fresh: record !== null && ageMs(record.heartbeatAtUtc) <= MONITOR_STALE_MS,
  };
}

async function waitMonitorReady(context, monitorId, { timeoutMs, handle = null }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readRecordOrNull(context.layout.monitorStatus);
    if (record?.monitorId === monitorId && record.state === "ready" && isProcessAlive(record.processId)
        && ageMs(record.heartbeatAtUtc) <= MONITOR_STALE_MS) {
      return record;
    }
    if (handle !== null && handle.exitCode() !== null) {
      fail("observability_unavailable", "The Gateway monitor exited before it was ready",
        { detail: { phase: "monitor-startup", exitCode: handle.exitCode() } });
    }
    if (Date.now() >= deadline) {
      fail("observability_unavailable", "The Gateway monitor did not become ready", { detail: { phase: "monitor-startup" } });
    }
    await sleep(100);
  }
}

async function releaseDeadMonitor(context, owner) {
  if (!owner?.monitorId || !Number.isSafeInteger(owner.processId)) {
    fail("gateway_monitor_identity_uncertain", "The monitor ownership record is not readable");
  }
  await runGatewayCli(context, "release-monitor", ["--monitor-id", owner.monitorId,
    "--expected-process-id", String(owner.processId)]);
}

async function rotate(file) {
  if ((await pathKind(file)) !== "file") return;
  await rename(file, `${file}.previous`).catch(() => {});
}

/** A ready monitor for this instance: the live one, or a new one. */
async function ensureMonitor(context, { visible, timeoutMs }) {
  const { layout } = context;
  const owner = await readRecord(layout.monitorOwner).catch(() => fail("gateway_monitor_identity_uncertain",
    "The monitor ownership record is not readable"));
  if (owner !== null) {
    if (isProcessAlive(owner.processId)) {
      try {
        const record = await waitMonitorReady(context, owner.monitorId, { timeoutMs });
        return { record, launched: false, visible: null };
      } catch {
        fail("gateway_monitor_identity_uncertain", "A monitor process is alive but not ready");
      }
    }
    await releaseDeadMonitor(context, owner);
  } else {
    const record = await readRecordOrNull(layout.monitorStatus);
    if (record !== null && isProcessAlive(record.processId) && record.state === "ready"
        && ageMs(record.heartbeatAtUtc) <= MONITOR_STALE_MS) {
      return { record, launched: false, visible: null };
    }
  }
  const monitorId = randomUUID();
  const args = [requireCli(context), "watch", "--repo-root", context.root, "--project-id", context.projectId,
    "--monitor-id", monitorId, "--refresh-ms", "1000"];
  const env = nodeChildEnvironment(context.env, { nodePath: context.node, omit: ["ANTHROPIC_API_KEY"] });
  await mkdir(layout.logsDir, { recursive: true });
  let handle;
  if (visible) {
    if (context.platform !== "win32") fail("visible_monitor_unsupported", "--visible-monitor opens a console window on Windows only", { exitCode: 2 });
    handle = await context.launcher.openVisible(context.node, args, { cwd: context.root, env });
  } else {
    await rotate(layout.monitorErrorLog);
    handle = context.launcher.spawnDetached(context.node, args, { cwd: context.root, env, stderrFile: layout.monitorErrorLog });
  }
  if (!handle.pid) fail("observability_unavailable", "The Gateway monitor could not be started", { detail: { phase: "monitor-spawn" } });
  const record = await waitMonitorReady(context, monitorId, { timeoutMs, handle });
  return { record, launched: true, visible };
}

/** Terminalizes the exact dead, stale instance (as Invoke-StaleGatewayRecovery). */
async function recoverStale(context, status, { waitForStaleMs = 0 } = {}) {
  const processId = gatewayProcessId(status);
  if (isProcessAlive(processId)) fail("gateway_recovery_process_alive", "The Gateway process is still alive");
  const waitUntil = Date.now() + waitForStaleMs;
  while (ageMs(status.heartbeatAtUtc) <= GATEWAY_STALE_MS) {
    if (Date.now() >= waitUntil) {
      fail("gateway_recovery_not_stale", "The Gateway stopped less than 30 seconds ago; retry shortly",
        { detail: { retryAfterSeconds: Math.max(1, Math.ceil((GATEWAY_STALE_MS - ageMs(status.heartbeatAtUtc)) / 1000) + 1) } });
    }
    await sleep(250);
  }
  const result = await runGatewayCli(context, "recover", [
    "--expected-instance-id", String(status.identity?.instanceId),
    "--expected-process-id", String(processId),
    "--expected-process-started-at-utc", String(status.identity?.process?.startedAtUtc),
  ]);
  if (result.status !== "recovered" && result.status !== "already-terminal") {
    fail("gateway_recovery_unconfirmed", "The Gateway did not confirm the recovery");
  }
  return readRecord(context.layout.gatewayStatus);
}

/**
 * A Gateway that died without its last words (a reboot, a killed process) can leave its connection
 * descriptor behind, and a new Gateway never writes over one (`gateway_process_collision`). Called
 * only when no live Gateway is recorded: a descriptor older than a heartbeat is that dead Gateway's
 * and is removed unread, as `gateway recover` does; a fresh one may be another start under way.
 */
async function clearDeadDescriptor(context) {
  const file = path.join(context.layout.gatewayRuntime, "connection.v1.json");
  let info;
  try { info = await stat(file); } catch { return false; }
  if (Date.now() - info.mtimeMs <= GATEWAY_STALE_MS) {
    fail("gateway_descriptor_fresh", "A connection descriptor was written moments ago: another start may be under way; retry shortly");
  }
  await rm(file, { force: true });
  return true;
}

function startPlan(context, { provider, visible }) {
  return {
    command: "gateway start", planOnly: true, instance: context.root, projectId: context.projectId, provider,
    visibleMonitor: visible, gatewayCli: context.cli, node: context.node,
    sequence: ["inspect-exact-gateway", "recover-exact-dead-stale-if-needed", "clear-dead-connection-descriptor",
      visible ? "open-visible-monitor" : "start-headless-monitor", "verify-monitor-readiness",
      "launch-hidden-gateway-if-terminal-or-absent", "verify-ready-instance", "verify-monitor-binding"],
    logs: { stdout: context.layout.gatewayLog, stderr: context.layout.gatewayErrorLog,
      monitorStderr: context.layout.monitorErrorLog },
    broadKill: false,
  };
}

export async function gatewayStart(context, {
  provider = "claude", visible = false, timeoutMs = 30_000, monitorTimeoutMs = 15_000, planOnly = false,
} = {}) {
  if (!GATEWAY_PROVIDERS.includes(provider)) fail("invalid_arguments", "--provider is claude (the Codex path left the product)", { exitCode: 2 });
  if (visible && context.platform !== "win32") {
    fail("visible_monitor_unsupported", "--visible-monitor opens a console window on Windows only", { exitCode: 2 });
  }
  if (planOnly) return startPlan(context, { provider, visible });
  const { layout } = context;
  requireCli(context);
  // A synced instance runs its Gateway only on the PC that holds the world (docs/project-package.md §14.3),
  // and a moved one only in its new folder (§10a).
  try {
    await assertNotMovedAway(context.root);
    await assertWorldHeld(context.root);
  } catch (error) {
    if (String(error?.code ?? "").startsWith("sync_") || error?.code === "instance_moved_away") fail(error.code, error.message);
    throw error;
  }
  let status = await readRecord(layout.gatewayStatus);
  let running = null;
  let recovered = false;
  if (status !== null && status.terminal !== true) {
    if (isProcessAlive(gatewayProcessId(status))) {
      if (ageMs(status.heartbeatAtUtc) > GATEWAY_STALE_MS) fail("live_gateway_unhealthy", "The Gateway process is alive but its heartbeat is stale");
      running = status;
    } else {
      status = await recoverStale(context, status, { waitForStaleMs: GATEWAY_STALE_MS + 2_000 });
      recovered = true;
    }
  }
  if (running === null && await clearDeadDescriptor(context)) recovered = true;
  if (running === null && provider === "claude" && (await pathKind(layout.claudeProvider)) !== "file") {
    fail("claude_provider_config_missing", "The instance has no .project-local/application-gateway/claude-provider.json; run setup");
  }
  const monitor = await ensureMonitor(context, { visible, timeoutMs: monitorTimeoutMs });
  let handle = null;
  let apiKeySource = null;
  let apiKeyReason = null;
  if (running === null) {
    const apiKey = context.keyStore ? await resolveApiKey({ env: context.env, store: context.keyStore })
      : { source: "none", key: null, reasonCode: "key_store_not_configured" };
    apiKeySource = apiKey.source;
    apiKeyReason = apiKey.reasonCode;
    const env = nodeChildEnvironment(context.env, { nodePath: context.node });
    if (apiKey.key !== null) env.ANTHROPIC_API_KEY = apiKey.key;
    await mkdir(layout.logsDir, { recursive: true });
    await rotate(layout.gatewayLog);
    await rotate(layout.gatewayErrorLog);
    handle = context.launcher.spawnDetached(context.node, [requireCli(context), "run", "--repo-root", context.root,
      "--project-id", context.projectId, "--monitor-id", monitor.record.monitorId, "--provider", provider],
    { cwd: context.root, env, stdoutFile: layout.gatewayLog, stderrFile: layout.gatewayErrorLog });
    if (!handle.pid) fail("gateway_start_failed", "The Gateway process could not be started");
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    status = await readRecordOrNull(layout.gatewayStatus);
    const processId = gatewayProcessId(status);
    const exact = handle === null || processId === handle.pid;
    if (exact && status?.lifecycle === "ready" && isProcessAlive(processId)) break;
    if (handle !== null && (handle.exitCode() !== null || (exact && status?.terminal === true))) {
      const errorText = await readFile(layout.gatewayErrorLog, "utf8").catch(() => "");
      fail("gateway_start_failed", "The Gateway exited during startup; see gateway logs",
        { detail: { exitCode: handle.exitCode(), ...(failureCode(errorText) ?? {}) } });
    }
    if (Date.now() >= deadline) {
      fail("gateway_start_timeout", "The Gateway did not become ready in time; see gateway logs",
        { detail: { processId: handle?.pid ?? processId } });
    }
    await sleep(100);
  }
  const instanceId = status.identity.instanceId;
  const processId = gatewayProcessId(status);
  let bound = null;
  while (bound === null) {
    const record = await readRecordOrNull(layout.monitorStatus);
    if (record?.monitorId === monitor.record.monitorId && record.state === "ready"
        && ageMs(record.heartbeatAtUtc) <= MONITOR_STALE_MS && record.gatewayInstanceId === instanceId
        && record.gatewayProcessId === processId && record.health === "gateway-ready") {
      bound = record;
      break;
    }
    if (Date.now() >= deadline + MONITOR_STALE_MS) {
      fail("observability_unavailable", "The monitor did not bind to the ready Gateway", { detail: { phase: "monitor-binding" } });
    }
    await sleep(100);
  }
  return {
    command: "gateway start",
    state: "ready",
    launched: handle !== null,
    recovered,
    instance: context.root,
    projectId: context.projectId,
    provider: running === null ? provider : null,
    instanceId,
    processId,
    monitorId: bound.monitorId,
    monitorProcessId: bound.processId,
    monitorLaunched: monitor.launched,
    monitorVisible: monitor.visible,
    apiKeySource,
    ...(apiKeyReason && apiKeySource === "none" ? { apiKeyReasonCode: apiKeyReason } : {}),
  };
}

/** Closes this instance's monitor once its Gateway is down (as CloseMonitor). */
async function closeMonitor(context, { waitMs = 5_000 } = {}) {
  const { layout } = context;
  const owner = await readRecordOrNull(layout.monitorOwner);
  if (owner === null) {
    const record = await readRecordOrNull(layout.monitorStatus);
    return record !== null && isProcessAlive(record.processId) ? { state: "unowned-running", monitorId: record.monitorId ?? null }
      : { state: "absent", monitorId: null };
  }
  if (isProcessAlive(owner.processId)) {
    const until = Date.now() + waitMs;
    while (isProcessAlive(owner.processId) && Date.now() < until) await sleep(100);
  }
  if (isProcessAlive(owner.processId)) {
    // A monitor that released its ownership has finished; one in a console
    // window can linger only because its keyboard input is still open.
    const currentOwner = await readRecordOrNull(layout.monitorOwner);
    if (currentOwner !== null) {
      const record = await readRecordOrNull(layout.monitorStatus);
      if (currentOwner.monitorId !== owner.monitorId || record?.monitorId !== owner.monitorId
          || record.processId !== owner.processId || record.projectId !== context.projectId
          || ageMs(record.heartbeatAtUtc) > MONITOR_STALE_MS) {
        fail("gateway_monitor_identity_uncertain", "The live monitor could not be identified exactly; it was left running");
      }
    }
    try { process.kill(owner.processId); } catch { /* exited meanwhile */ }
    const until = Date.now() + 5_000;
    while (isProcessAlive(owner.processId) && Date.now() < until) await sleep(100);
    if (isProcessAlive(owner.processId)) fail("gateway_monitor_close_unconfirmed", "The monitor did not exit");
  }
  const remaining = await readRecordOrNull(layout.monitorOwner);
  if (remaining?.monitorId === owner.monitorId) await releaseDeadMonitor(context, owner);
  return { state: "closed", monitorId: owner.monitorId };
}

export async function gatewayStop(context, { timeoutMs = 15_000, planOnly = false } = {}) {
  if (planOnly) {
    return { command: "gateway stop", planOnly: true, instance: context.root, projectId: context.projectId,
      exactInstanceRequired: true, closesMonitor: true, broadKill: false };
  }
  requireCli(context);
  const status = await readRecord(context.layout.gatewayStatus);
  let result;
  if (status === null) result = { state: "absent", instanceId: null, lifecycle: null };
  else if (status.terminal === true) {
    result = { state: "already-terminal", instanceId: status.identity?.instanceId ?? null, lifecycle: status.lifecycle };
  } else if (!isProcessAlive(gatewayProcessId(status))) {
    fail("gateway_process_unavailable", "The Gateway process is gone without a terminal status; run gateway recover");
  } else {
    const stopped = await runGatewayCli(context, "stop", ["--timeout-ms", String(Math.min(60_000, Math.max(1_000, timeoutMs)))],
      { timeoutMs: timeoutMs + 30_000 });
    if (stopped.status !== "stopped" && stopped.status !== "already-terminal" && stopped.status !== "absent") {
      fail("gateway_stop_unconfirmed", "The Gateway did not confirm the stop");
    }
    result = { state: stopped.status, instanceId: stopped.instanceId ?? status.identity?.instanceId ?? null,
      lifecycle: stopped.lifecycle ?? null };
  }
  const monitor = await closeMonitor(context);
  return { command: "gateway stop", instance: context.root, projectId: context.projectId, ...result, monitor };
}

export async function gatewayStatus(context) {
  const assessed = await runGatewayCli(context, "status");
  return {
    command: "gateway status",
    instance: context.root,
    projectId: context.projectId,
    availability: assessed.availability,
    reasonCode: assessed.reasonCode,
    ready: assessed.ready === true,
    lifecycle: assessed.gateway?.lifecycle ?? null,
    instanceId: assessed.gateway?.instanceId ?? null,
    processId: assessed.gateway?.processId ?? null,
    startedAtUtc: assessed.gateway?.startedAtUtc ?? null,
    heartbeatAtUtc: assessed.gateway?.heartbeatAtUtc ?? null,
    monitor: await monitorSummary(context.layout),
  };
}

export async function gatewayRecover(context, { planOnly = false } = {}) {
  if (planOnly) {
    return { command: "gateway recover", planOnly: true, instance: context.root, projectId: context.projectId,
      exactDeadInstanceRequired: true, minimumStaleSeconds: GATEWAY_STALE_MS / 1000, broadKill: false };
  }
  requireCli(context);
  const status = await readRecord(context.layout.gatewayStatus);
  let result;
  if (status === null) result = { state: "absent", instanceId: null, restartAllowed: true, changed: false };
  else if (status.terminal === true) {
    result = { state: status.lifecycle, instanceId: status.identity?.instanceId ?? null, restartAllowed: true, changed: false };
  } else {
    const recovered = await recoverStale(context, status);
    result = { state: recovered?.lifecycle ?? "uncertain", instanceId: status.identity?.instanceId ?? null,
      restartAllowed: true, changed: true };
  }
  const owner = await readRecordOrNull(context.layout.monitorOwner);
  let monitor = { state: owner === null ? "absent" : "running", monitorId: owner?.monitorId ?? null };
  if (owner !== null && !isProcessAlive(owner.processId)) {
    await releaseDeadMonitor(context, owner);
    monitor = { state: "released", monitorId: owner.monitorId };
  }
  return { command: "gateway recover", instance: context.root, projectId: context.projectId, ...result, monitor };
}

const LOG_STREAMS = Object.freeze([["stdout", "gatewayLog"], ["stderr", "gatewayErrorLog"], ["monitor-stderr", "monitorErrorLog"]]);

async function tail(file, lines) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, lines: [] };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const all = buffer.toString("utf8").split(/\r?\n/u);
    if (all.at(-1) === "") all.pop();
    if (length < size) all.shift();
    return { exists: true, sizeBytes: size, lines: all.slice(-lines) };
  } finally {
    await handle.close();
  }
}

export async function gatewayLogs(layout, { lines = 50 } = {}) {
  const files = [];
  for (const [stream, key] of LOG_STREAMS) files.push({ stream, path: layout[key], ...(await tail(layout[key], lines)) });
  return { command: "gateway logs", instance: layout.instanceDir, files };
}

/** Prints new log lines until the process is interrupted. */
export async function followGatewayLogs(layout, { write = (text) => process.stdout.write(text), signal = null, intervalMs = 500 } = {}) {
  const offsets = new Map();
  for (const [, key] of LOG_STREAMS) offsets.set(key, (await stat(layout[key]).catch(() => null))?.size ?? 0);
  while (signal === null || !signal.aborted) {
    for (const [stream, key] of LOG_STREAMS) {
      const size = (await stat(layout[key]).catch(() => null))?.size ?? 0;
      let offset = offsets.get(key);
      if (size < offset) offset = 0;
      if (size > offset) {
        const handle = await open(layout[key], "r");
        try {
          const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
          await handle.read(buffer, 0, buffer.length, offset);
          offset += buffer.length;
          for (const line of buffer.toString("utf8").split(/\r?\n/u)) if (line !== "") write(`[${stream}] ${line}\n`);
        } finally {
          await handle.close();
        }
      }
      offsets.set(key, offset);
    }
    await sleep(intervalMs);
  }
}

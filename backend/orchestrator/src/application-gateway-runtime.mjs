import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { captureGatewayFileFacts } from "./application-gateway-diagnostics.mjs";

import { applicationCanonicalJson, applicationCanonicalSha256 } from "./application-contract.mjs";
import { validateApplicationGatewayLifecycleStatus } from "./application-gateway-lifecycle.mjs";

export const APPLICATION_GATEWAY_RUNTIME_VERSION = "v0.1.6";
export const APPLICATION_GATEWAY_RUNTIME_LIMITS = Object.freeze({
  monitorStaleAfterMs: 15_000,
  gatewayStaleAfterMs: 30_000,
  stopTimeoutMs: 15_000,
});
export const APPLICATION_GATEWAY_LOG_ERROR_CODES = Object.freeze([
  "application_gateway_failed",
  "gateway_already_running",
  "gateway_monitor_already_owned",
  "gateway_monitor_owner_mismatch",
  "gateway_process_still_alive",
  "gateway_process_unavailable",
  "gateway_recovery_descriptor_mismatch",
  "gateway_recovery_identity_mismatch",
  "gateway_recovery_not_stale",
  "gateway_stop_unconfirmed",
  "gateway_workspace_mismatch",
  "invalid_argument",
  "invalid_stop_request",
  "mismatched_stop_request",
  "missing_argument",
  "observability_unavailable",
  "stale_gateway_requires_recovery",
  "unsupported_command",
]);
const SAFE_LOG_ERROR_CODES = new Set(APPLICATION_GATEWAY_LOG_ERROR_CODES);
// A refusal of the memory CLI keeps its code: they are fixed identifiers our own
// code throws (memory_*), never text. A list of them went out of date with each
// new refusal (the archive, the folder binding), and the person saw only
// application_gateway_failed.
const MEMORY_LOG_CODE = /^memory_[a-z0-9_]{1,64}$/u;
// A desk agent's registration as a controller source (register-desk-source,
// desk-agent-sources.mjs) refuses with its own fixed codes; they are kept the
// same way, so Atlas can say why in words.
const DESK_SOURCE_LOG_CODE = /^(?:desk_source_[a-z0-9_]{1,64}|controller_registry_incompatible|duplicate_source_id)$/u;
// So do the refusals of a project's folder change (project-rebind.mjs) and of
// where a project may be kept: Atlas pauses the Gateway on gateway_running and
// retries; with application_gateway_failed in its place it could not.
const PROJECT_LOG_CODE = /^(?:rebind_[a-z0-9_]{1,64}|settle_[a-z0-9_]{1,64}|gateway_running|project_not_found|policy_invalid)$/u;
const MEMORY_PHASES = new Set(["root", "input-read", "input-validate", "store-open",
  "authorize", "write", "bind-workspace", "operation",
  "archive-project", "restore-project", "archive-quarter", "restore-quarter", "list-archived-projects",
  "read-workspace", "rebind-workspace", "settle-send"]);
const FILE_CAUSES = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EBUSY", "EIO"]);
const MONITOR_CHECKS = new Set([
  'monitor_missing', 'monitor_read_failed', 'monitor_identity_mismatch',
  'monitor_not_ready', 'monitor_project_mismatch', 'monitor_workspace_mismatch',
  'monitor_process_unavailable', 'monitor_stale', 'monitor_clock_invalid',
]);

export function assertApplicationGatewayMonitorReady(monitor, {
  monitorId, projectId, workspaceRootSha256, nowMs = Date.now(), isProcessAlive,
}) {
  const age = nowMs - Date.parse(monitor?.heartbeatAtUtc);
  const check = monitor === null ? 'monitor_missing'
    : monitor.monitorId !== monitorId ? 'monitor_identity_mismatch'
    : monitor.state !== 'ready' ? 'monitor_not_ready'
    : monitor.projectId !== projectId ? 'monitor_project_mismatch'
    : monitor.workspaceRootSha256 !== workspaceRootSha256 ? 'monitor_workspace_mismatch'
    : !isProcessAlive(monitor.processId) ? 'monitor_process_unavailable'
    : !Number.isFinite(age) || age < -5000 ? 'monitor_clock_invalid'
    : age > APPLICATION_GATEWAY_RUNTIME_LIMITS.monitorStaleAfterMs ? 'monitor_stale' : null;
  if (check) throw Object.assign(new Error('observability_unavailable'), { monitorCheck: check });
  return monitor;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MONITOR_STATES = new Set(["ready", "stopped"]);
const MONITOR_HEALTH = new Set([
  "waiting-for-gateway", "gateway-ready", "gateway-stopping", "gateway-terminal",
  "gateway-stale",
]);

export class ApplicationGatewayRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationGatewayRuntimeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationGatewayRuntimeError(code, message);
}

export function createApplicationGatewayFailureLogRecord(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const family = /^(invalid_argument|missing_argument):/u.exec(message)?.[1] ?? null;
  const memoryPhase = MEMORY_PHASES.has(error?.memoryPhase) ? error.memoryPhase : null;
  const code = family ?? (memoryPhase && typeof error?.code === "string"
    && [MEMORY_LOG_CODE, DESK_SOURCE_LOG_CODE, PROJECT_LOG_CODE].some((pattern) => pattern.test(error.code))
    ? error.code : null)
    ?? (SAFE_LOG_ERROR_CODES.has(message)
    ? message
    : "application_gateway_failed");
  const detail = code === 'observability_unavailable' && MONITOR_CHECKS.has(error?.monitorCheck)
    ? { phase: 'monitor-startup', detailCode: error.monitorCheck } : {};
  return Object.freeze({ status: "failed", code, ...detail,
    ...(memoryPhase ? { phase: `memory-${memoryPhase}` } : {}),
    ...(memoryPhase && FILE_CAUSES.has(error?.code) ? { causeCode: error.code } : {}),
    ...(memoryPhase && UUID.test(error?.diagnosticId ?? "")
      && typeof error?.diagnosticPersisted === "boolean"
      ? { diagnosticId: error.diagnosticId, diagnosticPersisted: error.diagnosticPersisted } : {}),
  });
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_runtime_record", `${label} must be an object`);
  }
  return value;
}

function exact(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail("invalid_runtime_record", `${label} contains unsupported fields`);
  }
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_runtime_record", `${label} must be a UTC timestamp`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("invalid_runtime_record", `${label} must be a lowercase UUID`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_runtime_record", `${label} must be a bounded identifier`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_runtime_record", `${label} must be lowercase SHA-256`);
  }
  return value;
}

export function applicationGatewayRuntimePaths(repoRoot) {
  const root = path.resolve(repoRoot);
  const runtime = path.join(root, ".project-local", "application-gateway");
  return Object.freeze({
    runtime,
    status: path.join(runtime, "status.v1.json"),
    descriptor: path.join(runtime, "connection.v1.json"),
    stopRequest: path.join(runtime, "stop-request.v1.json"),
    monitor: path.join(runtime, "monitor-status.v1.json"),
    monitorOwner: path.join(runtime, "monitor-owner.v1.json"),
  });
}

export function applicationGatewayWorkspaceHash(repoRoot) {
  const resolved = path.resolve(repoRoot);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return applicationCanonicalSha256({ workspaceRoot: normalized });
}

export function validateApplicationGatewayMonitorStatus(value) {
  object(value, "monitorStatus");
  exact(value, [
    "schemaVersion", "contractVersion", "monitorId", "processId", "projectId",
    "workspaceRootSha256", "state", "health", "startedAtUtc", "updatedAtUtc",
    "heartbeatAtUtc", "gatewayInstanceId", "gatewayProcessId",
  ], "monitorStatus");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_GATEWAY_RUNTIME_VERSION
      || !MONITOR_STATES.has(value.state) || !MONITOR_HEALTH.has(value.health)) {
    fail("unsupported_runtime_record", "Gateway monitor status is unsupported");
  }
  uuid(value.monitorId, "monitorId");
  identifier(value.projectId, "projectId");
  hash(value.workspaceRootSha256, "workspaceRootSha256");
  if (!Number.isSafeInteger(value.processId) || value.processId < 1) {
    fail("invalid_runtime_record", "monitor processId is invalid");
  }
  const started = utc(value.startedAtUtc, "startedAtUtc");
  const updated = utc(value.updatedAtUtc, "updatedAtUtc");
  const heartbeat = utc(value.heartbeatAtUtc, "heartbeatAtUtc");
  if (Date.parse(updated) < Date.parse(started) || Date.parse(heartbeat) !== Date.parse(updated)) {
    fail("invalid_runtime_record", "monitor timeline is invalid");
  }
  const hasGateway = value.gatewayInstanceId !== null;
  if (hasGateway) uuid(value.gatewayInstanceId, "gatewayInstanceId");
  if (hasGateway !== (value.gatewayProcessId !== null)
      || (value.gatewayProcessId !== null
        && (!Number.isSafeInteger(value.gatewayProcessId) || value.gatewayProcessId < 1))) {
    fail("invalid_runtime_record", "monitor gateway identity is incomplete");
  }
  return structuredClone(value);
}

export function validateApplicationGatewayStopRequest(value) {
  object(value, "stopRequest");
  exact(value, [
    "schemaVersion", "contractVersion", "requestId", "projectId",
    "workspaceRootSha256", "instanceId", "requestedAtUtc",
  ], "stopRequest");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_GATEWAY_RUNTIME_VERSION) {
    fail("unsupported_runtime_record", "Gateway Stop request is unsupported");
  }
  identifier(value.requestId, "requestId");
  identifier(value.projectId, "projectId");
  hash(value.workspaceRootSha256, "workspaceRootSha256");
  uuid(value.instanceId, "instanceId");
  utc(value.requestedAtUtc, "requestedAtUtc");
  return structuredClone(value);
}

export function createApplicationGatewayMonitorStatus({
  monitorId,
  processId,
  projectId,
  workspaceRootSha256,
  startedAtUtc,
  updatedAtUtc,
  state = "ready",
  health,
  gatewayStatus = null,
}) {
  return validateApplicationGatewayMonitorStatus({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_RUNTIME_VERSION,
    monitorId,
    processId,
    projectId,
    workspaceRootSha256,
    state,
    health,
    startedAtUtc,
    updatedAtUtc,
    heartbeatAtUtc: updatedAtUtc,
    gatewayInstanceId: gatewayStatus?.identity.instanceId ?? null,
    gatewayProcessId: gatewayStatus?.identity.process.processId ?? null,
  });
}

export function createApplicationGatewayStopRequest({
  requestId = `gateway-stop-${randomUUID()}`,
  projectId,
  workspaceRootSha256,
  instanceId,
  requestedAtUtc,
}) {
  return validateApplicationGatewayStopRequest({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_RUNTIME_VERSION,
    requestId,
    projectId,
    workspaceRootSha256,
    instanceId,
    requestedAtUtc,
  });
}

function processAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

export function assessApplicationGatewayRuntime({
  status,
  monitorStatus = null,
  observedAtUtc,
  isProcessAlive = processAlive,
  staleAfterMs = APPLICATION_GATEWAY_RUNTIME_LIMITS.gatewayStaleAfterMs,
}) {
  const observed = utc(observedAtUtc, "observedAtUtc");
  if (status === null) {
    return Object.freeze({ availability: "unavailable", reasonCode: "status_missing" });
  }
  let gateway;
  try {
    gateway = validateApplicationGatewayLifecycleStatus(status);
  } catch {
    return Object.freeze({ availability: "unavailable", reasonCode: "status_invalid" });
  }
  const summary = {
    instanceId: gateway.identity.instanceId,
    processId: gateway.identity.process.processId,
    lifecycle: gateway.lifecycle,
    startedAtUtc: gateway.startedAtUtc,
    heartbeatAtUtc: gateway.heartbeatAtUtc,
    terminal: gateway.terminal,
  };
  if (gateway.terminal) {
    return Object.freeze({ availability: "terminal", reasonCode: gateway.lifecycle, gateway: summary });
  }
  if (!isProcessAlive(summary.processId)
      || Date.parse(observed) - Date.parse(summary.heartbeatAtUtc) > staleAfterMs) {
    return Object.freeze({ availability: "stale", reasonCode: "gateway_stale", gateway: summary });
  }
  let monitor = null;
  if (monitorStatus !== null) {
    try {
      monitor = validateApplicationGatewayMonitorStatus(monitorStatus);
    } catch {
      return Object.freeze({ availability: "stale", reasonCode: "monitor_invalid", gateway: summary });
    }
    if (monitor.state !== "ready"
        || Date.parse(observed) - Date.parse(monitor.heartbeatAtUtc)
          > APPLICATION_GATEWAY_RUNTIME_LIMITS.monitorStaleAfterMs
        || monitor.gatewayInstanceId !== summary.instanceId
        || monitor.gatewayProcessId !== summary.processId) {
      return Object.freeze({ availability: "stale", reasonCode: "monitor_stale", gateway: summary });
    }
  }
  return Object.freeze({
    availability: "available",
    reasonCode: gateway.ready ? "gateway_ready" : "gateway_transitioning",
    ready: gateway.ready,
    gateway: summary,
    monitor: monitor === null ? null : {
      monitorId: monitor.monitorId,
      processId: monitor.processId,
      health: monitor.health,
      heartbeatAtUtc: monitor.heartbeatAtUtc,
    },
  });
}

// How often a status file is renamed into place on Windows while a reader (Atlas, the monitor,
// an antivirus scan) holds the old one open: 8 attempts back off over about 0.7 s, well inside
// one heartbeat. Three attempts in 75 ms were not enough on a busy desktop (2026-10-25).
export const GATEWAY_RENAME_ATTEMPTS = 8;

/**
 * `onContention({ filePath, attempt, code, elapsedMs, final })` hears every
 * rename that Windows refused (a reader holds the old file); `final` marks the
 * one after which the write fails. A diagnostic only.
 */
export async function writeGatewayJsonAtomic(filePath, value, {
  renameFile = rename, wait = delay, platform = process.platform, onContention = null,
} = {}) {
  const started = performance.now();
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let stage = "mkdir";
  let renameAttempts = 0;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    stage = "write";
    await writeFile(temporaryPath, `${applicationCanonicalJson(value)}\n`, {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    stage = "rename";
    for (;;) {
      renameAttempts++;
      try { await renameFile(temporaryPath, filePath); break; }
      catch (error) {
        const contended = platform === "win32" && ["EPERM", "EBUSY"].includes(error?.code);
        if (contended && typeof onContention === "function") {
          try {
            onContention({ filePath, attempt: renameAttempts, code: error.code,
              elapsedMs: Math.round(performance.now() - started), final: renameAttempts >= GATEWAY_RENAME_ATTEMPTS });
          } catch { /* a diagnostic never changes the write */ }
        }
        if (!contended || renameAttempts >= GATEWAY_RENAME_ATTEMPTS) throw error;
        await wait(25 * renameAttempts);
      }
    }
  } catch (error) {
    error.runtimeStage = stage;
    if (stage === "rename") error.renameAttempts = renameAttempts;
    error.publicationElapsedMs = Math.round(performance.now() - started);
    error.fileFactsAfterFailure = await captureGatewayFileFacts(filePath, temporaryPath);
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export class ApplicationGatewayRuntimeFiles {
  #onContention;

  /** `onContention`: see writeGatewayJsonAtomic; heard for the status and monitor files. */
  constructor({ repoRoot, onContention = null }) {
    this.paths = applicationGatewayRuntimePaths(repoRoot);
    this.#onContention = onContention;
  }

  async readStatus() {
    const value = await readJson(this.paths.status);
    return value === null ? null : validateApplicationGatewayLifecycleStatus(value);
  }

  async writeStatus(value) {
    const status = validateApplicationGatewayLifecycleStatus(value);
    await writeGatewayJsonAtomic(this.paths.status, status, { onContention: this.#onContention });
    return status;
  }

  async readMonitor() {
    const value = await readJson(this.paths.monitor);
    return value === null ? null : validateApplicationGatewayMonitorStatus(value);
  }

  async writeMonitor(value) {
    const status = validateApplicationGatewayMonitorStatus(value);
    await writeGatewayJsonAtomic(this.paths.monitor, status, { onContention: this.#onContention });
    return status;
  }

  async readMonitorLog(monitorId) {
    uuid(monitorId, "monitorId");
    const value = await readJson(path.join(this.paths.runtime, `monitor-log-${monitorId}.v1.json`));
    if (value === null) return null;
    if (value.schemaVersion !== 1 || value.monitorId !== monitorId
        || !Array.isArray(value.events) || value.events.length > 32
        || !ID.test(value.projectId ?? "") || !SHA256.test(value.workspaceRootSha256 ?? "")
        || !Number.isSafeInteger(value.processId) || value.processId < 1
        || value.events.some((event) => !MONITOR_HEALTH.has(event.health)
          || typeof event.atUtc !== "string" || !Number.isFinite(Date.parse(event.atUtc))
          || (event.reasonCode !== null && !/^[a-z][a-z0-9_]{0,95}$/u.test(event.reasonCode)))) {
      fail("invalid_runtime_record", "Gateway monitor log is invalid");
    }
    return value;
  }

  async recordMonitorTransition(monitorValue, gatewayValue, health, atUtc) {
    const monitor = validateApplicationGatewayMonitorStatus(monitorValue);
    if (!MONITOR_HEALTH.has(health)) fail("invalid_runtime_record", "Monitor health is invalid");
    utc(atUtc, "monitor transition time");
    const gateway = gatewayValue === null ? null : validateApplicationGatewayLifecycleStatus(gatewayValue);
    const ownerValue = await readJson(this.paths.monitorOwner);
    if (ownerValue === null) fail("gateway_monitor_owner_mismatch", "Monitor owner is missing");
    const owner = validateApplicationGatewayMonitorStatus(ownerValue);
    if (owner.monitorId !== monitor.monitorId || owner.processId !== monitor.processId
        || owner.projectId !== monitor.projectId
        || owner.workspaceRootSha256 !== monitor.workspaceRootSha256) {
      fail("gateway_monitor_owner_mismatch", "Monitor owner does not match");
    }
    const previous = await this.readMonitorLog(monitor.monitorId);
    if (previous !== null && (previous.projectId !== monitor.projectId
        || previous.workspaceRootSha256 !== monitor.workspaceRootSha256
        || previous.processId !== monitor.processId)) {
      fail("gateway_monitor_owner_mismatch", "Monitor log identity does not match");
    }
    const event = { atUtc, health, lifecycle: gateway?.lifecycle ?? null,
      gatewayInstanceId: gateway?.identity.instanceId ?? null,
      gatewayProcessId: gateway?.identity.process.processId ?? null,
      reasonCode: gateway?.failure?.reasonCode ?? null };
    const events = previous?.events ?? [];
    const last = events.at(-1);
    if (last && Object.keys(event).every((key) => key === "atUtc" || last[key] === event[key])) {
      return previous;
    }
    if (last && Date.parse(atUtc) < Date.parse(last.atUtc)) {
      fail("invalid_runtime_record", "Monitor log time regressed");
    }
    const record = { schemaVersion: 1, monitorId: monitor.monitorId,
      processId: monitor.processId, projectId: monitor.projectId,
      workspaceRootSha256: monitor.workspaceRootSha256,
      events: [...events, event].slice(-32) };
    await writeGatewayJsonAtomic(path.join(this.paths.runtime,
      `monitor-log-${monitor.monitorId}.v1.json`), record);
    return record;
  }

  async claimMonitor(value) {
    const record = validateApplicationGatewayMonitorStatus(value);
    await mkdir(this.paths.runtime, { recursive: true });
    try {
      await writeFile(this.paths.monitorOwner, `${applicationCanonicalJson(record)}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
    } catch (error) {
      if (error.code === "EEXIST") fail("gateway_monitor_already_owned", "gateway_monitor_already_owned");
      throw error;
    }
  }

  async releaseMonitor(expectedMonitorId, expectedProcessId) {
    const value = await readJson(this.paths.monitorOwner);
    if (value === null) return;
    const owner = validateApplicationGatewayMonitorStatus(value);
    if (owner.monitorId !== expectedMonitorId || owner.processId !== expectedProcessId) {
      fail("gateway_monitor_owner_mismatch", "gateway_monitor_owner_mismatch");
    }
    // Clear the projection before releasing ownership, never after a new claim.
    await this.clearMonitor(expectedMonitorId);
    await rm(this.paths.monitorOwner);
  }

  async readStopRequest() {
    const value = await readJson(this.paths.stopRequest);
    return value === null ? null : validateApplicationGatewayStopRequest(value);
  }

  async writeStopRequest(value) {
    const request = validateApplicationGatewayStopRequest(value);
    await writeGatewayJsonAtomic(this.paths.stopRequest, request);
    return request;
  }

  async clearStopRequest() {
    await rm(this.paths.stopRequest, { force: true });
  }

  async clearMonitor(expectedMonitorId) {
    const current = await this.readMonitor().catch(() => null);
    if (current?.monitorId === expectedMonitorId) await rm(this.paths.monitor, { force: true });
  }
}

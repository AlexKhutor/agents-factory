#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { persistGatewayFailureDiagnostic, persistGatewayAgentReadDiagnostic } from "./application-gateway-diagnostics.mjs";
import { createApplicationOperationJournal } from "./application-operation-journal.mjs";

import { createApplicationGatewayBackend } from "./application-gateway-backend.mjs";
import {
  createApplicationGatewayReadRuntime,
} from "./application-gateway-read-runtime.mjs";
import { ApplicationGatewayDescriptorStore } from "./application-gateway-descriptor.mjs";
import { recoverCrashedApplicationGatewayLifecycle } from "./application-gateway-lifecycle.mjs";
import {
  APPLICATION_GATEWAY_RUNTIME_LIMITS,
  ApplicationGatewayRuntimeFiles,
  applicationGatewayWorkspaceHash,
  assessApplicationGatewayRuntime,
  assertApplicationGatewayMonitorReady,
  createApplicationGatewayFailureLogRecord,
  createApplicationGatewayMonitorStatus,
  createApplicationGatewayStopRequest,
} from "./application-gateway-runtime.mjs";
import { ApplicationGatewayServer } from "./application-gateway-server.mjs";
import { readClaudeProviderConfig } from "./application-gateway-claude-runtime.mjs";
import { createAcpProviderFactory, readAcpProviderConfig } from "./application-gateway-acp-runtime.mjs";
import { listWindowsFileLockers } from "./windows-file-lockers.mjs";
import { runProjectMemoryCommand } from "./project-memory-cli.mjs";

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new Error(`invalid_argument:${token}`);
    const key = token.slice(2);
    if (key === "json") options.json = true;
    else {
      if (index + 1 >= tokens.length) throw new Error(`missing_argument:${key}`);
      options[key] = tokens[index += 1];
    }
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`missing_argument:${key}`);
  return value;
}

function integer(options, key, fallback, minimum, maximum) {
  if (options[key] === undefined) return fallback;
  const value = Number(options[key]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_argument:${key}`);
  }
  return value;
}

function alive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function output(value, asJson = false) {
  if (asJson) console.log(JSON.stringify(value));
  else console.log(JSON.stringify(value, null, 2));
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

// When Windows refuses to replace a status file, every refused attempt is
// logged (stderr: the gateway's or the monitor's error log), and the processes
// that hold the file open are named, at most once a minute (windows-file-lockers.mjs).
const LOCKER_PROBE_INTERVAL_MS = 60_000;
let lockerProbeAtMs = 0;
function logContention(record) {
  const atUtc = new Date().toISOString();
  process.stderr.write(JSON.stringify({ schemaVersion: 1, component: "gateway-status-file", phase: "rename-contention",
    atUtc, processId: process.pid, file: path.basename(record.filePath), attempt: record.attempt, code: record.code,
    elapsedMs: record.elapsedMs, final: record.final }) + "\n");
  if (Date.now() - lockerProbeAtMs < LOCKER_PROBE_INTERVAL_MS) return;
  lockerProbeAtMs = Date.now();
  listWindowsFileLockers(record.filePath).then((lockers) => {
    process.stderr.write(JSON.stringify({ schemaVersion: 1, component: "gateway-status-file", phase: "lockers",
      atUtc, observedAtUtc: new Date().toISOString(), processId: process.pid, file: path.basename(record.filePath),
      lockers }) + "\n");
  }).catch(() => {});
}

function context(options) {
  const repoRoot = path.resolve(required(options, "repo-root"));
  return {
    repoRoot,
    projectId: required(options, "project-id"),
    sourceId: options["source-id"] ?? "orchestrator-development",
    workspaceRootSha256: applicationGatewayWorkspaceHash(repoRoot),
    files: new ApplicationGatewayRuntimeFiles({ repoRoot, onContention: logContention }),
  };
}

async function statusCommand(options) {
  const current = context(options);
  const [status, monitorStatus] = await Promise.all([
    current.files.readStatus().catch(() => null),
    current.files.readMonitor().catch(() => null),
  ]);
  return assessApplicationGatewayRuntime({
    status,
    monitorStatus,
    observedAtUtc: new Date().toISOString(),
  });
}

async function descriptorStatusCommand(options) {
  const current = context(options);
  let lifecycleStatus;
  try {
    lifecycleStatus = await current.files.readStatus();
  } catch {
    return {
      schemaVersion: 1,
      command: "descriptor-status",
      availability: "unavailable",
      reasonCode: "status_invalid",
      ready: false,
    };
  }
  if (lifecycleStatus === null) {
    return {
      schemaVersion: 1,
      command: "descriptor-status",
      availability: "unavailable",
      reasonCode: "status_missing",
      ready: false,
    };
  }
  const store = new ApplicationGatewayDescriptorStore({
    descriptorPath: current.files.paths.descriptor,
  });
  const resolved = await store.read({
    lifecycleStatus,
    observedAtUtc: new Date().toISOString(),
  });
  if (resolved.status !== "available") {
    return {
      schemaVersion: 1,
      command: "descriptor-status",
      availability: "unavailable",
      reasonCode: resolved.reasonCode,
      ready: false,
    };
  }
  const descriptor = resolved.descriptor;
  return {
    schemaVersion: 1,
    command: "descriptor-status",
    availability: "available",
    reasonCode: resolved.reasonCode,
    ready: true,
    projectId: descriptor.workspace.projectId,
    instanceId: descriptor.instance.instanceId,
    descriptorId: descriptor.descriptorId,
    contractVersion: descriptor.contractVersion,
    transportId: descriptor.transportId,
    publishedAtUtc: descriptor.publishedAtUtc,
    validUntilUtc: descriptor.validUntilUtc,
    exposedOperationCount: descriptor.exposedOperations.length,
  };
}

async function assertMonitorReady(current, monitorId) {
  const monitor = await current.files.readMonitor().catch(() => {
    throw Object.assign(new Error('observability_unavailable'), { monitorCheck: 'monitor_read_failed' });
  });
  return assertApplicationGatewayMonitorReady(monitor, {
    monitorId, projectId: current.projectId, workspaceRootSha256: current.workspaceRootSha256,
    isProcessAlive: alive,
  });
}

async function runCommand(options) {
  const current = context(options);
  const monitorId = required(options, "monitor-id");
  await assertMonitorReady(current, monitorId);
  const previous = await current.files.readStatus().catch(() => null);
  if (previous !== null && !previous.terminal) {
    if (alive(previous.identity.process.processId)) throw new Error("gateway_already_running");
    throw new Error("stale_gateway_requires_recovery");
  }
  await current.files.clearStopRequest();
  // Desk agents run on Claude Code, configured by the controller's machine-local
  // .project-local/application-gateway/claude-provider.json. --provider stays for the callers that name it;
  // "claude" is the only provider (the Codex App Server path left the product, roadmap step 1).
  const providerKind = options.provider ?? "claude";
  if (providerKind !== "claude") throw new Error("invalid_argument:provider");
  const claude = await readClaudeProviderConfig(current.repoRoot);
  // Beside Claude Code, desk agents may run on an ACP agent (DeepSeek Harness) when the controller has
  // .project-local/application-gateway/acp-provider.json (application-gateway-acp-runtime.mjs).
  const acp = await readAcpProviderConfig(current.repoRoot);
  const instanceId = randomUUID();
  const startedAtUtc = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
  const publishedAtUtc = new Date().toISOString();
  const readRuntime = await createApplicationGatewayReadRuntime({
    repoRoot: current.repoRoot,
    sourceId: current.sourceId,
    instanceId,
    provider: providerKind,
    claude,
    extraProviders: acp === null ? null : [createAcpProviderFactory(acp)],
    onProviderDiagnostic: (record) => {
      process.stderr.write(JSON.stringify({ ...record, instanceId }) + "\n");
    },
    onDiagnostic: async (record) => {
      process.stderr.write(JSON.stringify({ ...record, instanceId }) + "\n");
      try {
        await persistGatewayAgentReadDiagnostic(path.join(current.files.paths.runtime, "diagnostics"), instanceId, record);
      } catch {
        process.stderr.write(JSON.stringify({ code: "diagnostic_persistence_failed",
          instanceId, phase: "agent-read-evidence" }) + "\n");
      }
    },
  });
  let operationJournal;
  try {
    operationJournal = await createApplicationOperationJournal({
      directory: path.join(current.files.paths.runtime, "diagnostics"), instanceId,
      handlers: readRuntime.handlers,
      onPersistenceError: (record) => process.stderr.write(JSON.stringify(record) + "\n"),
    });
  } catch (error) { await readRuntime.close(); throw error; }
  const backend = createApplicationGatewayBackend({
    sourceId: current.sourceId,
    sequence: previous?.identity.generation ?? 0,
    publishedAtUtc,
    streamId: "application-global",
    epoch: `gateway-${instanceId}`,
    providerStates: readRuntime.providerStates,
    authenticationStates: readRuntime.authenticationStates,
    operationHandlers: operationJournal.handlers,
  });
  const descriptorStore = new ApplicationGatewayDescriptorStore({
    descriptorPath: current.files.paths.descriptor,
  });
  const server = new ApplicationGatewayServer({
    instanceId,
    generation: previous === null ? 1 : previous.identity.generation + 1,
    restartOf: previous?.identity.instanceId ?? null,
    workspace: {
      projectId: current.projectId,
      sourceId: current.sourceId,
      workspaceRootSha256: current.workspaceRootSha256,
    },
    process: {
      processId: process.pid,
      startedAtUtc,
      executableSha256: await sha256File(process.execPath),
    },
    descriptorStore,
    invokeApplication: backend.invokeApplication,
    readEvents: backend.readEvents,
    exposedOperations: backend.exposedOperations,
    writeStatus: (value) => current.files.writeStatus(value),
    writeDiagnostic: async (record) => {
      process.stderr.write(`${JSON.stringify(record)}\n`);
      try {
        await persistGatewayFailureDiagnostic(path.join(current.files.paths.runtime, "diagnostics"), record);
      } catch {
        process.stderr.write(JSON.stringify({ status: "failed", code: "diagnostic_persistence_failed",
          instanceId, phase: "failure-evidence" }) + "\n");
      }
    },
  });

  let shuttingDown = null;
  const stop = (requestId) => {
    if (shuttingDown === null) {
      shuttingDown = server.stop(requestId).finally(() => current.files.clearStopRequest());
    }
    return shuttingDown;
  };
  process.once("SIGINT", () => { stop("gateway-signal-interrupt").catch(() => {}); });
  process.once("SIGTERM", () => { stop("gateway-signal-terminate").catch(() => {}); });
  try {
    await server.start();
    output({
      schemaVersion: 1,
      command: "run",
      state: "ready",
      instanceId: server.status.identity.instanceId,
      processId: process.pid,
      projectId: current.projectId,
      monitorId,
      provider: readRuntime.provider,
      providerStatus: readRuntime.providerStatus,
      ownerChatStatus: readRuntime.ownerChatStatus,
    }, true);

    const pollIntervalMs = integer(options, "poll-ms", 250, 50, 5_000);
    while (!server.status.terminal) {
      await sleep(pollIntervalMs);
      let request;
      try {
        request = await current.files.readStopRequest();
      } catch {
        await stop("gateway-invalid-stop-request");
        throw new Error("invalid_stop_request");
      }
      if (request === null) continue;
      if (request.projectId !== current.projectId
          || request.workspaceRootSha256 !== current.workspaceRootSha256
          || request.instanceId !== server.status.identity.instanceId) {
        await stop("gateway-mismatched-stop-request");
        throw new Error("mismatched_stop_request");
      }
      await stop(request.requestId);
    }
    await shuttingDown;
    return server.status;
  } finally {
    try { await readRuntime.close(); } finally { await operationJournal.close(); }
  }
}

async function stopCommand(options) {
  const current = context(options);
  const status = await current.files.readStatus();
  if (status === null) return { status: "absent" };
  if (status.identity.workspace.workspaceRootSha256 !== current.workspaceRootSha256
      || status.identity.workspace.projectId !== current.projectId) {
    throw new Error("gateway_workspace_mismatch");
  }
  if (status.terminal) return { status: "already-terminal", lifecycle: status.lifecycle };
  if (!alive(status.identity.process.processId)) throw new Error("gateway_process_unavailable");
  const request = createApplicationGatewayStopRequest({
    projectId: current.projectId,
    workspaceRootSha256: current.workspaceRootSha256,
    instanceId: status.identity.instanceId,
    requestedAtUtc: new Date().toISOString(),
  });
  await current.files.writeStopRequest(request);
  const timeoutMs = integer(
    options,
    "timeout-ms",
    APPLICATION_GATEWAY_RUNTIME_LIMITS.stopTimeoutMs,
    1_000,
    60_000,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await current.files.readStatus().catch(() => null);
    if (observed?.identity.instanceId === status.identity.instanceId && observed.terminal) {
      return {
        status: "stopped",
        requestId: request.requestId,
        instanceId: status.identity.instanceId,
        lifecycle: observed.lifecycle,
      };
    }
    if (!alive(status.identity.process.processId)) break;
    await sleep(100);
  }
  throw new Error("gateway_stop_unconfirmed");
}

async function recoverCommand(options) {
  const current = context(options);
  const expectedInstanceId = required(options, "expected-instance-id");
  const expectedProcessId = integer(
    options, "expected-process-id", null, 1, Number.MAX_SAFE_INTEGER,
  );
  if (expectedProcessId === null) throw new Error("missing_argument:expected-process-id");
  const expectedProcessStartedAtUtc = required(options, "expected-process-started-at-utc");
  const status = await current.files.readStatus();
  if (status === null) return { status: "absent" };
  if (status.identity.workspace.workspaceRootSha256 !== current.workspaceRootSha256
      || status.identity.workspace.projectId !== current.projectId
      || status.identity.instanceId !== expectedInstanceId
      || status.identity.process.processId !== expectedProcessId
      || status.identity.process.startedAtUtc !== expectedProcessStartedAtUtc) {
    throw new Error("gateway_recovery_identity_mismatch");
  }
  if (status.terminal) {
    return { status: "already-terminal", lifecycle: status.lifecycle };
  }
  const observedAtUtc = new Date().toISOString();
  if (Date.parse(observedAtUtc) - Date.parse(status.heartbeatAtUtc)
      <= APPLICATION_GATEWAY_RUNTIME_LIMITS.gatewayStaleAfterMs) {
    throw new Error("gateway_recovery_not_stale");
  }
  if (alive(expectedProcessId)) throw new Error("gateway_process_still_alive");
  const descriptorStore = new ApplicationGatewayDescriptorStore({
    descriptorPath: current.files.paths.descriptor,
  });
  const removed = await descriptorStore.remove({ expectedInstanceId });
  if (removed.status !== "removed" && removed.status !== "absent") {
    throw new Error("gateway_recovery_descriptor_mismatch");
  }
  const recovered = recoverCrashedApplicationGatewayLifecycle(status, {
    observedAtUtc,
    reasonCode: "process_terminated",
  });
  await current.files.writeStatus(recovered);
  await current.files.clearStopRequest();
  return {
    status: "recovered",
    instanceId: recovered.identity.instanceId,
    lifecycle: recovered.lifecycle,
    restartAllowed: true,
  };
}

function monitorHealth(status, now) {
  if (status === null) return "waiting-for-gateway";
  if (status.terminal) return "gateway-terminal";
  if (!alive(status.identity.process.processId)
      || Date.parse(now) - Date.parse(status.heartbeatAtUtc)
        > APPLICATION_GATEWAY_RUNTIME_LIMITS.gatewayStaleAfterMs) {
    return "gateway-stale";
  }
  if (status.lifecycle === "stop-requested") return "gateway-stopping";
  return status.ready ? "gateway-ready" : "waiting-for-gateway";
}

function renderMonitor(projectId, monitorId, status, health, now) {
  const age = status === null ? null : Math.max(0, Math.round(
    (Date.parse(now) - Date.parse(status.heartbeatAtUtc)) / 1000,
  ));
  console.clear();
  console.log("Application Gateway Status");
  console.log(`Project: ${projectId}`);
  console.log(`Monitor: ${monitorId}`);
  console.log(`Health: ${health}`);
  console.log(`Lifecycle: ${status?.lifecycle ?? "not-started"}`);
  console.log(`Instance: ${status?.identity.instanceId ?? "n/a"}`);
  console.log(`Process: ${status?.identity.process.processId ?? "n/a"}`);
  console.log(`Heartbeat age: ${age === null ? "n/a" : `${age}s`}`);
  console.log("\nQ, Escape or Ctrl+C closes this monitor only.");
  console.log("Use stop_application_gateway.bat to stop the gateway engine.");
}

async function watchCommand(options) {
  const current = context(options);
  const monitorId = options["monitor-id"] ?? randomUUID();
  const startedAtUtc = new Date().toISOString();
  const refreshMs = integer(options, "refresh-ms", 1_000, 250, 10_000);
  const previousMonitor = await current.files.readMonitor();
  if (previousMonitor !== null && alive(previousMonitor.processId)) {
    throw new Error("gateway_monitor_already_owned");
  }
  await current.files.claimMonitor(createApplicationGatewayMonitorStatus({
    monitorId, processId: process.pid, projectId: current.projectId,
    workspaceRootSha256: current.workspaceRootSha256,
    startedAtUtc, updatedAtUtc: startedAtUtc, health: "waiting-for-gateway",
    gatewayStatus: null,
  }));
  let closing = false;
  const close = () => { closing = true; };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      if (data[0] === 3 || data[0] === 27 || data.toString("utf8").toLowerCase() === "q") close();
    });
  }
  try {
    let observedActiveInstanceId = null;
    while (!closing) {
      const now = new Date().toISOString();
      const status = await current.files.readStatus().catch(() => null);
      const health = monitorHealth(status, now);
      if (health === "gateway-ready" || health === "gateway-stopping") {
        observedActiveInstanceId = status.identity.instanceId;
      }
      const monitor = createApplicationGatewayMonitorStatus({
        monitorId,
        processId: process.pid,
        projectId: current.projectId,
        workspaceRootSha256: current.workspaceRootSha256,
        startedAtUtc,
        updatedAtUtc: now,
        health,
        gatewayStatus: status,
      });
      await current.files.writeMonitor(monitor);
      await current.files.recordMonitorTransition(monitor, status, health, now);
      renderMonitor(current.projectId, monitorId, status, health, now);
      if (status?.terminal && status.identity.instanceId === observedActiveInstanceId) {
        closing = true;
        continue;
      }
      await sleep(refreshMs);
    }
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    // An open keyboard stream keeps the process alive after the Gateway stops:
    // a visible monitor would stay on screen.
    process.stdin.pause();
    await current.files.releaseMonitor(monitorId, process.pid);
  }
  return { status: "monitor-closed", monitorId };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "release-monitor") {
    const current = context(options);
    const monitorId = required(options, "monitor-id");
    const processId = integer(options, "expected-process-id", null, 1, Number.MAX_SAFE_INTEGER);
    if (processId === null) throw new Error("missing_argument:expected-process-id");
    if (alive(processId)) throw new Error("gateway_process_still_alive");
    await current.files.releaseMonitor(monitorId, processId);
    return output({ status: "monitor-released", monitorId }, true);
  }
  if (command === "memory") return output(await runProjectMemoryCommand(options), options.json);
  if (command === "status") return output(await statusCommand(options), options.json);
  if (command === "descriptor-status") {
    return output(await descriptorStatusCommand(options), options.json);
  }
  if (command === "stop") return output(await stopCommand(options), options.json);
  if (command === "recover") return output(await recoverCommand(options), options.json);
  if (command === "run") return output(await runCommand(options), options.json);
  if (command === "watch") return output(await watchCommand(options), options.json);
  throw new Error("unsupported_command");
}

main().catch((error) => {
  console.error(JSON.stringify(createApplicationGatewayFailureLogRecord(error)));
  process.exitCode = 1;
});

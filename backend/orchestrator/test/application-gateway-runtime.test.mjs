import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import {
  ApplicationGatewayRuntimeFiles,
  assessApplicationGatewayRuntime,
  createApplicationGatewayMonitorStatus,
  createApplicationGatewayStopRequest,
  validateApplicationGatewayMonitorStatus,
  validateApplicationGatewayStopRequest,
  assertApplicationGatewayMonitorReady,
  createApplicationGatewayFailureLogRecord,
  writeGatewayJsonAtomic,
  GATEWAY_RENAME_ATTEMPTS,
} from "../src/application-gateway-runtime.mjs";

const MONITOR_ID = "11111111-1111-4111-8111-111111111111";
const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_HASH = "1".repeat(64);

test("Windows status rename retries only bounded transient contention", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-status-rename-"));
  const target = path.join(root, "status.json");
  await writeFile(target, "old\n");
  let attempts = 0;
  await writeGatewayJsonAtomic(target, { status: "new" }, {
    platform: "win32", wait: async () => {},
    renameFile: async (source, destination) => {
      if (++attempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      await rename(source, destination);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { status: "new" });
  assert.deepEqual(await readdir(root), ["status.json"]);
});

test("persistent Windows rename EPERM preserves old status and fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-status-rename-fail-"));
  const target = path.join(root, "status.json");
  await writeFile(target, "old\n");
  let attempts = 0;
  await assert.rejects(writeGatewayJsonAtomic(target, { status: "new" }, {
    platform: "win32", wait: async () => {},
    renameFile: async () => { attempts++; throw Object.assign(new Error("locked"), { code: "EPERM" }); },
  }), (error) => error.code === "EPERM" && error.renameAttempts === GATEWAY_RENAME_ATTEMPTS
    && error.runtimeStage === "rename");
  assert.equal(attempts, GATEWAY_RENAME_ATTEMPTS);
  assert.equal(await readFile(target, "utf8"), "old\n");
  assert.deepEqual(await readdir(root), ["status.json"]);
});

test("memory CLI failures preserve closed diagnostic codes without private payloads", () => {
  for (const code of ["memory_revision_conflict", "memory_invalid_input", "memory_unavailable"]) {
    const error = Object.assign(new Error("private memory text"), { code, memoryPhase: "write" });
    assert.deepEqual(createApplicationGatewayFailureLogRecord(error), {
      status: "failed", code, phase: "memory-write",
    });
  }
  assert.deepEqual(createApplicationGatewayFailureLogRecord(Object.assign(new Error("private path"),
    { code: "EACCES", memoryPhase: "input-read" })), {
    status: "failed", code: "application_gateway_failed", phase: "memory-input-read", causeCode: "EACCES",
  });
  assert.deepEqual(createApplicationGatewayFailureLogRecord(Object.assign(new Error("private"),
    { code: "memory_private_secret", memoryPhase: "private path" })), {
    status: "failed", code: "application_gateway_failed",
  });
  // The archive's and the binding's refusals keep their code: Atlas tells the
  // person why (open agents, a folder already bound) instead of a bare
  // application_gateway_failed.
  for (const [code, phase] of [["memory_project_has_agents", "archive-project"],
    ["memory_quarter_has_agents", "archive-quarter"], ["memory_project_archived", "restore-quarter"],
    ["memory_project_not_found", "restore-project"], ["memory_contention", "list-archived-projects"],
    ["memory_workspace_conflict", "bind-workspace"], ["memory_invalid_input", "read-workspace"]]) {
    assert.deepEqual(createApplicationGatewayFailureLogRecord(Object.assign(new Error(code), { code, memoryPhase: phase })), {
      status: "failed", code, phase: `memory-${phase}`,
    });
  }
  // A folder change's refusals too, the folder in their message never: on
  // gateway_running Atlas pauses the Gateway and runs the change again.
  for (const [code, phase] of [["gateway_running", "rebind-workspace"], ["rebind_folder_missing", "rebind-workspace"],
    ["rebind_target_exists", "rebind-workspace"], ["settle_not_uncertain", "settle-send"],
    ["project_not_found", "input-validate"],
    ["policy_invalid", "input-validate"]]) {
    const error = Object.assign(new Error(`${code}: W:\\private\\folder`), { code, memoryPhase: phase });
    assert.deepEqual(createApplicationGatewayFailureLogRecord(error), {
      status: "failed", code, phase: `memory-${phase}`,
    });
  }
});

test("startup diagnostics identify the exact failed monitor check without private data", () => {
  const expected = { monitorId: MONITOR_ID, projectId: 'isolateVsCode',
    workspaceRootSha256: WORKSPACE_HASH, nowMs: Date.parse('2026-08-30T21:00:12.000Z'),
    isProcessAlive: () => true };
  assertApplicationGatewayMonitorReady(monitor(), expected);
  for (const [record, changes, detailCode] of [
    [null, {}, 'monitor_missing'],
    [monitor(), { monitorId: 'different' }, 'monitor_identity_mismatch'],
    [monitor(), { projectId: 'foreign' }, 'monitor_project_mismatch'],
    [monitor(), { workspaceRootSha256: 'f'.repeat(64) }, 'monitor_workspace_mismatch'],
    [monitor(), { isProcessAlive: () => false }, 'monitor_process_unavailable'],
    [monitor(), { nowMs: Date.parse('2026-08-30T22:00:00.000Z') }, 'monitor_stale'],
    [monitor(), { nowMs: Date.parse('2026-08-30T20:00:00.000Z') }, 'monitor_clock_invalid'],
  ]) {
    assert.throws(() => assertApplicationGatewayMonitorReady(record, { ...expected, ...changes }), error => {
      assert.deepEqual(createApplicationGatewayFailureLogRecord(error), {
        status: 'failed', code: 'observability_unavailable', phase: 'monitor-startup', detailCode,
      });
      return true;
    });
  }
  assert.deepEqual(createApplicationGatewayFailureLogRecord(Object.assign(new Error('secret'),
    { monitorCheck: 'secret bearer' })), { status: 'failed', code: 'application_gateway_failed' });
});

function gatewayStatus() {
  const lifecycle = new ApplicationGatewayLifecycle({
    instanceId: INSTANCE_ID,
    workspace: {
      projectId: "isolateVsCode",
      sourceId: "orchestrator-development",
      workspaceRootSha256: WORKSPACE_HASH,
    },
    process: {
      processId: 4100,
      startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64),
    },
  });
  return lifecycle.markReady("2026-08-30T21:00:01.000Z");
}

function monitor(status = gatewayStatus(), changes = {}) {
  return createApplicationGatewayMonitorStatus({
    monitorId: MONITOR_ID,
    processId: 4200,
    projectId: "isolateVsCode",
    workspaceRootSha256: WORKSPACE_HASH,
    startedAtUtc: "2026-08-30T21:00:02.000Z",
    updatedAtUtc: "2026-08-30T21:00:10.000Z",
    health: "gateway-ready",
    gatewayStatus: status,
    ...changes,
  });
}

test("monitor and Stop records contain bounded exact project identity", () => {
  const status = monitor();
  assert.deepEqual(validateApplicationGatewayMonitorStatus(status), status);
  assert.equal(JSON.stringify(status).includes("E:\\"), false);
  const request = createApplicationGatewayStopRequest({
    requestId: "gateway-stop-test",
    projectId: "isolateVsCode",
    workspaceRootSha256: WORKSPACE_HASH,
    instanceId: INSTANCE_ID,
    requestedAtUtc: "2026-08-30T21:00:11.000Z",
  });
  assert.deepEqual(validateApplicationGatewayStopRequest(request), request);
  assert.throws(() => validateApplicationGatewayStopRequest({
    ...request, broadKill: true,
  }));
});

test("runtime assessment requires live fresh gateway and matching monitor", () => {
  const status = gatewayStatus();
  const available = assessApplicationGatewayRuntime({
    status,
    monitorStatus: monitor(status),
    observedAtUtc: "2026-08-30T21:00:12.000Z",
    isProcessAlive: () => true,
  });
  assert.equal(available.availability, "available");
  assert.equal(available.ready, true);
  assert.equal(available.monitor.monitorId, MONITOR_ID);

  assert.equal(assessApplicationGatewayRuntime({
    status,
    monitorStatus: monitor(status, { updatedAtUtc: "2026-08-30T21:00:02.000Z" }),
    observedAtUtc: "2026-08-30T21:00:20.000Z",
    isProcessAlive: () => true,
  }).reasonCode, "monitor_stale");
  assert.equal(assessApplicationGatewayRuntime({
    status,
    observedAtUtc: "2026-08-30T21:00:12.000Z",
    isProcessAlive: () => false,
  }).reasonCode, "gateway_stale");
});

test("runtime files preserve validated status, monitor and one exact Stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-gateway-runtime-"));
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot: root });
  const status = gatewayStatus();
  const monitorStatus = monitor(status);
  const stopRequest = createApplicationGatewayStopRequest({
    projectId: "isolateVsCode",
    workspaceRootSha256: WORKSPACE_HASH,
    instanceId: INSTANCE_ID,
    requestedAtUtc: "2026-08-30T21:00:11.000Z",
  });
  await files.writeStatus(status);
  await files.writeMonitor(monitorStatus);
  await files.writeStopRequest(stopRequest);
  assert.deepEqual(await files.readStatus(), status);
  assert.deepEqual(await files.readMonitor(), monitorStatus);
  assert.deepEqual(await files.readStopRequest(), stopRequest);
  await files.clearStopRequest();
  assert.equal(await files.readStopRequest(), null);
  await files.clearMonitor("33333333-3333-4333-8333-333333333333");
  assert.deepEqual(await files.readMonitor(), monitorStatus);
  await files.clearMonitor(MONITOR_ID);
  assert.equal(await files.readMonitor(), null);
});

test("only one monitor owns publication; contention and foreign release preserve its record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-monitor-owner-"));
  const first = new ApplicationGatewayRuntimeFiles({ repoRoot: root });
  const second = new ApplicationGatewayRuntimeFiles({ repoRoot: root });
  const owner = monitor();
  const contender = monitor(undefined, {
    monitorId: "33333333-3333-4333-8333-333333333333", processId: 4300,
  });
  const claims = await Promise.allSettled([
    first.claimMonitor(owner), second.claimMonitor(contender),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = claims.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "gateway_monitor_already_owned");
  const winner = claims[0].status === "fulfilled" ? owner : contender;
  const loser = winner === owner ? contender : owner;
  await first.writeMonitor(winner);
  await assert.rejects(first.releaseMonitor(loser.monitorId, loser.processId),
    { code: "gateway_monitor_owner_mismatch" });
  assert.deepEqual(await second.readMonitor(), winner);
  await first.releaseMonitor(winner.monitorId, winner.processId);
  await second.claimMonitor(loser);
  await second.releaseMonitor(loser.monitorId, loser.processId);
});

test("owned monitor retains bounded lifecycle transitions after release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-monitor-retained-"));
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot: root });
  const owner = monitor();
  await files.claimMonitor(owner);
  const ready = gatewayStatus();
  await files.recordMonitorTransition(owner, ready, "gateway-ready", "2026-08-30T21:00:10.000Z");
  const lifecycle = new ApplicationGatewayLifecycle({ instanceId: INSTANCE_ID,
    workspace: { projectId: "isolateVsCode", sourceId: "orchestrator-development",
      workspaceRootSha256: WORKSPACE_HASH },
    process: { processId: 4100, startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64) } });
  lifecycle.markReady("2026-08-30T21:00:01.000Z");
  lifecycle.requestStop("fixture-stop", "2026-08-30T21:00:11.000Z");
  const terminal = lifecycle.markStopped("2026-08-30T21:00:12.000Z");
  await files.recordMonitorTransition(owner, terminal, "gateway-terminal", "2026-08-30T21:00:13.000Z");
  await files.releaseMonitor(MONITOR_ID, owner.processId);
  const log = await files.readMonitorLog(MONITOR_ID);
  assert.equal(log.events.length, 2);
  assert.equal(log.events.at(-1).lifecycle, "stopped");
  assert.equal(log.events.at(-1).health, "gateway-terminal");
  assert.equal(log.monitorId, MONITOR_ID);
  assert.doesNotMatch(JSON.stringify(log), /bearer|endpoint|E:\\/i);
  await assert.rejects(files.recordMonitorTransition(owner, terminal, "gateway-terminal",
    "2026-08-30T21:00:14.000Z"), { code: "gateway_monitor_owner_mismatch" });
});

test("every refused Windows rename is reported, the last one as final", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-status-contention-"));
  const target = path.join(root, "status.json");
  await writeFile(target, "old\n");
  const heard = [];
  let attempts = 0;
  await writeGatewayJsonAtomic(target, { status: "new" }, {
    platform: "win32", wait: async () => {}, onContention: (record) => heard.push(record),
    renameFile: async (source, destination) => {
      if (++attempts < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      await rename(source, destination);
    },
  });
  assert.deepEqual(heard.map((record) => [record.attempt, record.code, record.final]), [[1, "EBUSY", false], [2, "EBUSY", false]]);
  heard.length = 0;
  await assert.rejects(writeGatewayJsonAtomic(target, { status: "newer" }, {
    platform: "win32", wait: async () => {}, onContention: (record) => { heard.push(record); throw new Error("ignored"); },
    renameFile: async () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); },
  }), { code: "EPERM" });
  assert.equal(heard.length, GATEWAY_RENAME_ATTEMPTS);
  assert.equal(heard.at(-1).final, true);
  assert.equal(heard.at(-1).filePath, target);
});

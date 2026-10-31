import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import { applicationGatewayWorkspaceHash } from "../src/application-gateway-runtime.mjs";
import {
  createDefaultLauncher, createGatewayContext, gatewayStart, gatewayStop, visibleMonitorCommand,
} from "../src/agents-factory-gateway.mjs";
import { agentsFactoryLayout } from "../src/agents-factory-paths.mjs";
import {
  buildFakeSdk, buildTemplate, cliBundle, isAlive, parseJsonOutput, runCliProcess, temporaryRoot, testEnvironment,
} from "./fixtures/agents-factory/helpers.mjs";

// The real Gateway bundle runs here, only inside a temporary instance built by
// the test, with an SDK folder that has no `query`: the Claude provider reports
// claude_sdk_unavailable and no Claude process is ever started.

const PROJECT_ID = "agents-factory-gateway-fixture";

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

function cleanupProcesses(t, instance) {
  t.after(async () => {
    const runtime = path.join(instance, ".project-local", "application-gateway");
    const pids = new Set();
    const status = await readJson(path.join(runtime, "status.v1.json"));
    if (status && status.terminal !== true) pids.add(status.identity?.process?.processId);
    for (const file of ["monitor-status.v1.json", "monitor-owner.v1.json"]) {
      const record = await readJson(path.join(runtime, file));
      if (record?.processId) pids.add(record.processId);
    }
    for (const pid of pids) {
      if (Number.isSafeInteger(pid) && pid !== process.pid && isAlive(pid)) {
        try { process.kill(pid); } catch { /* gone */ }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

async function setupInstance(t, root, { start, atlas = null, cli } = {}) {
  const template = await buildTemplate(root, { projectId: PROJECT_ID });
  const sdk = await buildFakeSdk(root);
  const instance = path.join(root, "instance");
  cleanupProcesses(t, instance);
  const env = testEnvironment(root);
  const args = ["setup", "--instance", instance, "--template", template, "--sdk-path", sdk, "--json"];
  if (!start) args.push("--no-start");
  if (atlas) args.push("--atlas-config", atlas);
  const result = await runCliProcess(args, { env, cli });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { instance, env, setup: parseJsonOutput(result) };
}

async function waitDead(pid, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  return !isAlive(pid);
}

function staleStatus(instance, { processId = 2_147_480_000, instanceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } = {}) {
  const startedAtUtc = new Date(Date.now() - 600_000).toISOString();
  const lifecycle = new ApplicationGatewayLifecycle({
    instanceId,
    workspace: { projectId: PROJECT_ID, sourceId: "orchestrator-development",
      workspaceRootSha256: applicationGatewayWorkspaceHash(instance) },
    process: { processId, startedAtUtc, executableSha256: "c".repeat(64) },
  });
  return lifecycle.markReady(new Date(Date.now() - 590_000).toISOString());
}

test("setup starts the real Gateway; status, start again, logs, stop and recover behave as the PowerShell lifecycle", async (t) => {
  const root = await temporaryRoot(t, "af-gateway-");
  const atlas = path.join(root, "atlas.json");
  const { instance, env, setup } = await setupInstance(t, root, { start: true, atlas, cli: cliBundle });
  const steps = Object.fromEntries(setup.steps.map((step) => [step.step, step]));
  assert.equal(steps.gateway.status, "started");
  assert.equal(steps.gateway.apiKeySource, "none");
  const runtime = path.join(instance, ".project-local", "application-gateway");
  const status = await readJson(path.join(runtime, "status.v1.json"));
  assert.equal(status.lifecycle, "ready");
  assert.equal(status.identity.instanceId, steps.gateway.instanceId);
  assert.deepEqual(steps["atlas-config"].expectedWorkspace, {
    projectId: PROJECT_ID, workspaceRootSha256: status.identity.workspace.workspaceRootSha256 });
  assert.equal(JSON.parse(await readFile(atlas, "utf8")).controllerRoot, instance);

  const current = parseJsonOutput(await runCliProcess(["gateway", "status", "--instance", instance, "--json"], { env }));
  assert.equal(current.ok, true);
  assert.equal(current.availability, "available");
  assert.equal(current.reasonCode, "gateway_ready");
  assert.equal(current.ready, true);
  assert.equal(current.lifecycle, "ready");
  assert.equal(current.instanceId, steps.gateway.instanceId);
  assert.equal(current.monitor.running, true);
  assert.equal(current.monitor.health, "gateway-ready");

  const again = parseJsonOutput(await runCliProcess(["gateway", "start", "--instance", instance, "--json"], { env }));
  assert.equal(again.ok, true);
  assert.equal(again.state, "ready");
  assert.equal(again.launched, false);
  assert.equal(again.monitorLaunched, false);
  assert.equal(again.instanceId, steps.gateway.instanceId);
  assert.equal(again.monitorId, steps.gateway.monitorId);

  const logs = parseJsonOutput(await runCliProcess(["gateway", "logs", "--instance", instance, "--json"], { env }));
  const stdout = logs.files.find((file) => file.stream === "stdout");
  assert.equal(stdout.exists, true);
  const run = JSON.parse(stdout.lines.find((line) => line.includes("\"command\":\"run\"")));
  assert.equal(run.instanceId, steps.gateway.instanceId);
  assert.deepEqual(run.providerStatus, { status: "unavailable", reasonCode: "claude_sdk_unavailable" });

  const monitorPid = current.monitor.processId;
  const stopped = parseJsonOutput(await runCliProcess(["gateway", "stop", "--instance", instance, "--json"], { env }));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.lifecycle, "stopped");
  assert.equal(stopped.monitor.state, "closed");
  assert.equal(await waitDead(monitorPid), true, "the monitor exits with its Gateway");
  assert.equal(await waitDead(current.processId), true, "the Gateway process exits");

  const after = parseJsonOutput(await runCliProcess(["gateway", "status", "--instance", instance, "--json"], { env }));
  assert.equal(after.availability, "terminal");
  assert.equal(after.reasonCode, "stopped");
  assert.equal(after.ready, false);
  const recover = parseJsonOutput(await runCliProcess(["gateway", "recover", "--instance", instance, "--json"], { env }));
  assert.equal(recover.state, "stopped");
  assert.equal(recover.changed, false);
  const stopAgain = parseJsonOutput(await runCliProcess(["gateway", "stop", "--instance", instance, "--json"], { env }));
  assert.equal(stopAgain.state, "already-terminal");
  assert.equal(stopAgain.monitor.state, "absent");
});

test("a dead stale Gateway is recovered exactly; start recovers it and passes the key to the Gateway only", async (t) => {
  const root = await temporaryRoot(t, "af-gateway-stale-");
  const { instance, env } = await setupInstance(t, root, { start: false });
  const runtime = path.join(instance, ".project-local", "application-gateway");
  await writeFile(path.join(runtime, "status.v1.json"), JSON.stringify(staleStatus(instance)));
  const stale = parseJsonOutput(await runCliProcess(["gateway", "status", "--instance", instance, "--json"], { env }));
  assert.equal(stale.availability, "stale");
  const refused = await runCliProcess(["gateway", "stop", "--instance", instance, "--json"], { env });
  assert.equal(refused.status, 1);
  assert.equal(parseJsonOutput(refused).code, "gateway_process_unavailable");
  const plan = parseJsonOutput(await runCliProcess(["gateway", "recover", "--plan-only", "--instance", instance, "--json"], { env }));
  assert.equal(plan.planOnly, true);
  assert.equal(plan.broadKill, false);
  const recovered = parseJsonOutput(await runCliProcess(["gateway", "recover", "--instance", instance, "--json"], { env }));
  assert.equal(recovered.changed, true);
  assert.equal(recovered.state, "uncertain");
  assert.equal((await readJson(path.join(runtime, "status.v1.json"))).failure.reasonCode, "process_terminated");

  await writeFile(path.join(runtime, "status.v1.json"),
    JSON.stringify(staleStatus(instance, { instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })));
  const layout = agentsFactoryLayout({ dataDir: path.join(root, "data"), instanceDir: instance });
  const real = createDefaultLauncher();
  const spawned = [];
  const launcher = {
    ...real,
    spawnDetached(file, args, options) {
      spawned.push({ command: args[1], key: options.env.ANTHROPIC_API_KEY ?? null });
      return real.spawnDetached(file, args, options);
    },
  };
  const keyStore = { kind: "fixture", has: async () => true, get: async () => "sk-ant-fixture-key-not-real-0000", remove: async () => true };
  const context = await createGatewayContext({ layout, env, launcher, keyStore });
  const started = await gatewayStart(context, { provider: "claude" });
  assert.equal(started.recovered, true);
  assert.equal(started.launched, true);
  assert.equal(started.apiKeySource, "key-store");
  assert.deepEqual(spawned, [{ command: "watch", key: null }, { command: "run", key: "sk-ant-fixture-key-not-real-0000" }]);
  const status = await readJson(path.join(runtime, "status.v1.json"));
  assert.equal(status.identity.restartOf, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const stopped = await gatewayStop(context);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.monitor.state, "closed");
  assert.equal(await waitDead(started.processId), true);
});

test("start refuses without a provider config; plans and the visible monitor never launch anything here", async (t) => {
  const root = await temporaryRoot(t, "af-gateway-plan-");
  const template = await buildTemplate(root, { projectId: PROJECT_ID });
  const instance = path.join(root, "instance");
  cleanupProcesses(t, instance);
  const env = testEnvironment(root);
  assert.equal((await runCliProcess(["setup", "--instance", instance, "--template", template, "--json"], { env })).status, 0);
  const missing = await runCliProcess(["gateway", "start", "--instance", instance, "--json"], { env });
  assert.equal(missing.status, 1);
  assert.equal(parseJsonOutput(missing).code, "claude_provider_config_missing");
  const plan = parseJsonOutput(await runCliProcess(["gateway", "start", "--plan-only", "--visible-monitor", "--instance", instance, "--json"], { env }));
  if (process.platform === "win32") {
    assert.equal(plan.planOnly, true);
    assert.ok(plan.sequence.includes("open-visible-monitor"));
  } else {
    // The visible monitor is a console window of Windows; elsewhere the plan is refused, not faked.
    assert.equal(plan.code, "visible_monitor_unsupported");
  }
  assert.equal(await readJson(path.join(instance, ".project-local", "application-gateway", "monitor-status.v1.json")), null);
  const command = visibleMonitorCommand({ file: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\My Controller\\.orchestrator\\runtime\\application-gateway-cli.mjs", "watch", "--repo-root", "C:\\My Controller"],
    cwd: "C:\\My Controller", env: { SystemRoot: "C:\\Windows" } });
  assert.equal(command.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(command.env.AF_MONITOR_ARGS,
    "\"C:\\My Controller\\.orchestrator\\runtime\\application-gateway-cli.mjs\" watch --repo-root \"C:\\My Controller\"");
  assert.equal(command.args.includes("-EncodedCommand"), true);
  const noInstance = await runCliProcess(["gateway", "status", "--instance", path.join(root, "absent"), "--json"], { env });
  assert.equal(noInstance.status, 1);
  assert.equal(parseJsonOutput(noInstance).code, "instance_missing");
});

test("the Gateway of an instance moved to another folder does not start: it names the new folder", async (t) => {
  const root = await temporaryRoot(t, "af-gateway-moved-");
  const template = await buildTemplate(root, { projectId: PROJECT_ID });
  const instance = path.join(root, "instance");
  cleanupProcesses(t, instance);
  const env = testEnvironment(root);
  assert.equal((await runCliProcess(["setup", "--instance", instance, "--template", template, "--json"], { env })).status, 0);
  const to = path.join(root, "moved");
  await writeFile(path.join(instance, ".project-local", "moved-to.json"), JSON.stringify({ schemaVersion: 1, to }));
  const refused = await runCliProcess(["gateway", "start", "--instance", instance, "--json"], { env });
  assert.equal(refused.status, 1);
  assert.equal(parseJsonOutput(refused).code, "instance_moved_away");
  assert.ok(parseJsonOutput(refused).message.includes(to));
  assert.equal(await readJson(path.join(instance, ".project-local", "application-gateway", "status.v1.json")), null);
});

test("start clears a dead Gateway's connection descriptor and refuses a fresh one", async (t) => {
  const root = await temporaryRoot(t, "af-gateway-descriptor-");
  const template = await buildTemplate(root, { projectId: PROJECT_ID });
  const instance = path.join(root, "instance");
  cleanupProcesses(t, instance);
  const env = testEnvironment(root);
  assert.equal((await runCliProcess(["setup", "--instance", instance, "--template", template, "--json"], { env })).status, 0);
  const runtime = path.join(instance, ".project-local", "application-gateway");
  const descriptor = path.join(runtime, "connection.v1.json");
  await mkdir(runtime, { recursive: true });
  // Written moments ago: maybe another start under way - left alone.
  await writeFile(descriptor, "{}");
  const fresh = await runCliProcess(["gateway", "start", "--instance", instance, "--json"], { env });
  assert.equal(parseJsonOutput(fresh).code, "gateway_descriptor_fresh");
  assert.equal(await readFile(descriptor, "utf8"), "{}");
  // Left by a Gateway that died (a reboot): no live Gateway recorded, older than a heartbeat - removed.
  const old = new Date(Date.now() - 5 * 60_000);
  await utimes(descriptor, old, old);
  const cleared = await runCliProcess(["gateway", "start", "--instance", instance, "--json"], { env });
  assert.equal(parseJsonOutput(cleared).code, "claude_provider_config_missing", "the start went on past the descriptor");
  await assert.rejects(readFile(descriptor), { code: "ENOENT" });
});

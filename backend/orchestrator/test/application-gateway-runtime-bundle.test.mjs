import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ApplicationGatewayDescriptorStore } from "../src/application-gateway-descriptor.mjs";
import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import { createConversationArchive } from "../src/conversation-archive.mjs";
import { loadNodeSqlite } from "../src/sqlite-backend.mjs";
import {
  ApplicationGatewayRuntimeFiles,
  applicationGatewayWorkspaceHash,
} from "../src/application-gateway-runtime.mjs";
import {
  bindApplicationGatewayEndpoint,
  buildApplicationGatewaySecurityPolicy,
  hashApplicationGatewayBearerToken,
} from "../src/application-gateway-security.mjs";

const orchestratorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(orchestratorRoot, "..");
const bundlePath = path.join(orchestratorRoot, "dist", "application-gateway-cli.bundle.mjs");

test("distributed archive bridge works outside the source checkout and is required", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-archive-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".orchestrator"));
  await writeFile(path.join(root, ".orchestrator", "contract.json"), JSON.stringify({ sourceId: "controller" }));
  const bridgePath = path.join(root, "conversation-archive-store.py");
  await copyFile(path.join(orchestratorRoot, "dist", "conversation-archive-store.py"), bridgePath);
  const archive = await createConversationArchive({ controllerRoot: root, projectId: "controller", bridgePath,
    sqliteBackend: "python" });
  const binding = { projectId: "controller", sourceId: "child", providerId: "test", threadId: "opaque" };
  await archive.append(binding, { recordId: "one", kind: "message", role: "assistant", state: "completed",
    text: "Standalone archive", providerTurnId: null, providerItemId: null, requestId: null,
    occurredAtUtc: null, omissions: [] });
  assert.equal((await archive.read(binding)).items[0].record.text, "Standalone archive");
  await assert.rejects(createConversationArchive({ controllerRoot: root, projectId: "controller",
    bridgePath: path.join(root, "not-installed.py"), sqliteBackend: "python" }), { code: "archive_unavailable" });
  // node:sqlite, the default where the runtime has it, needs no bridge script.
  if (await loadNodeSqlite()) {
    const inProcess = await createConversationArchive({ controllerRoot: root, projectId: "controller",
      bridgePath: path.join(root, "not-installed.py"), sqliteBackend: "node" });
    assert.equal(inProcess.sqliteBackend, "node");
    assert.equal((await inProcess.read(binding)).items[0].record.text, "Standalone archive");
  }
});

test("checked-in Application Gateway bundle matches source", () => {
  const result = spawnSync(process.execPath, [
    path.join(orchestratorRoot, "scripts", "build-application-gateway-runtime.mjs"),
    "--verify",
  ], {
    cwd: orchestratorRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /application_gateway_runtime_bundle_parity: passed/);
});

test("bundled Gateway status emits one provider-neutral JSON result", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "application-gateway-bundle-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    bundlePath,
    "status",
    "--repo-root", fixture,
    "--project-id", "controller-fixture",
    "--json",
  ], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    availability: "unavailable",
    reasonCode: "status_missing",
  });
});

test("bundled descriptor status is bounded when no gateway is ready", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-descriptor-bundle-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    bundlePath,
    "descriptor-status",
    "--repo-root", fixture,
    "--project-id", "controller-fixture",
    "--json",
  ], {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: "descriptor-status",
    availability: "unavailable",
    reasonCode: "status_missing",
    ready: false,
  });
  assert.equal(result.stdout.includes("bearer"), false);
});

// The Codex owner chat left with the Codex path: its status command is gone.
test("bundled CLI no longer knows the Codex owner chat status", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-owner-chat-bundle-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    bundlePath, "owner-chat-status", "--repo-root", fixture, "--project-id", "controller-fixture", "--json",
  ], { cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stderr), { status: "failed", code: "unsupported_command" });
});

test("bundled descriptor status verifies matching live descriptor without secrets", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-descriptor-ready-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const now = Date.now();
  const lifecycle = new ApplicationGatewayLifecycle({
    instanceId: "11111111-1111-4111-8111-111111111111",
    workspace: {
      projectId: "controller-fixture",
      sourceId: "orchestrator-development",
      workspaceRootSha256: applicationGatewayWorkspaceHash(fixture),
    },
    process: {
      processId: process.pid,
      startedAtUtc: new Date(now - 2_000).toISOString(),
      executableSha256: "2".repeat(64),
    },
  });
  const status = lifecycle.markReady(new Date(now - 1_000).toISOString());
  const token = "A".repeat(43);
  const policy = buildApplicationGatewaySecurityPolicy({
    lifecycleStatus: status,
    sessionId: "22222222-2222-4222-8222-222222222222",
    bearerSha256: hashApplicationGatewayBearerToken(token),
    issuedAtUtc: new Date(now - 2_000).toISOString(),
    expiresAtUtc: new Date(now + 60_000).toISOString(),
  });
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot: fixture });
  await files.writeStatus(status);
  await new ApplicationGatewayDescriptorStore({
    descriptorPath: files.paths.descriptor,
  }).publish({
    lifecycleStatus: status,
    securityPolicy: policy,
    endpoint: bindApplicationGatewayEndpoint(policy, 49152),
    bearerToken: token,
    publishedAtUtc: new Date(now).toISOString(),
  });
  const result = spawnSync(process.execPath, [
    bundlePath, "descriptor-status", "--repo-root", fixture,
    "--project-id", "controller-fixture", "--json",
  ], { cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.availability, "available");
  assert.equal(output.ready, true);
  assert.equal(output.instanceId, status.identity.instanceId);
  assert.equal(output.exposedOperationCount, 1);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stdout.includes("authorization"), false);
});

test("Gateway wrapper prefers the installed runtime and keeps source fallback", async () => {
  const wrapper = await readFile(path.join(repoRoot, "tools", "application_gateway.ps1"), "utf8");
  const installed = wrapper.indexOf(".orchestrator\\runtime\\application-gateway-cli.mjs");
  const source = wrapper.indexOf("orchestrator\\src\\application-gateway-cli.mjs");
  assert.ok(installed >= 0);
  assert.ok(source > installed);
  assert.match(wrapper, /Test-Path -LiteralPath \$installedCli -PathType Leaf/);
});

import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { INSTANCE_SCHEMA_VERSION, migrateInstance } from "../src/agents-factory-migrate.mjs";
import { agentsFactoryLayout } from "../src/agents-factory-paths.mjs";
import {
  buildFakeSdk, buildTemplate, integrityOf, packageTarball, parseJsonOutput, runCliProcess, startFakeRegistry, temporaryRoot,
  testEnvironment,
} from "./fixtures/agents-factory/helpers.mjs";

function stepsByName(result) {
  return Object.fromEntries(result.steps.map((step) => [step.step, step]));
}

async function snapshot(directory) {
  const entries = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      entries.push(path.relative(directory, full));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(directory);
  return entries.sort();
}

test("setup creates the instance from the template, writes configs and is idempotent", async (t) => {
  const root = await temporaryRoot(t, "af-setup-");
  const template = await buildTemplate(root);
  const sdk = await buildFakeSdk(root);
  const instance = path.join(root, "data", "controller");
  const env = testEnvironment(root);
  const first = await runCliProcess(["setup", "--template", template, "--sdk-path", sdk, "--no-start", "--json"], { env });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const result = parseJsonOutput(first);
  assert.equal(result.ok, true);
  assert.equal(result.instance, instance);
  const steps = stepsByName(result);
  assert.deepEqual(result.steps.map((step) => step.step),
    ["environment", "instance", "instance-schema", "mode", "claude-sdk", "claude-provider", "control-cycle", "gateway", "atlas-config",
      "launcher"]);
  assert.equal(steps.instance.status, "created");
  assert.equal(steps["instance-schema"].status, "current");
  assert.equal(steps["claude-sdk"].status, "provided");
  assert.equal(steps["claude-provider"].status, "created");
  assert.equal(steps["control-cycle"].status, "created");
  assert.deepEqual(steps.gateway, { step: "gateway", status: "skipped", reasonCode: "no_start" });
  assert.deepEqual(steps["atlas-config"], { step: "atlas-config", status: "skipped", reasonCode: "not_requested" });
  const record = JSON.parse(await readFile(path.join(instance, "instance.json"), "utf8"));
  assert.equal(record.schemaVersion, INSTANCE_SCHEMA_VERSION);
  assert.equal(record.kind, "agents-factory-instance");
  const provider = JSON.parse(await readFile(path.join(instance, ".project-local", "application-gateway", "claude-provider.json"), "utf8"));
  assert.equal(provider.schemaVersion, 1);
  assert.equal(provider.sdkPath, sdk);
  assert.equal(provider.keepProviderVariables, true);
  assert.ok(provider.models.length > 0);
  const cycle = JSON.parse(await readFile(path.join(instance, ".project-local", "orchestration", "control-cycle.json"), "utf8"));
  assert.equal(cycle.schemaVersion, 1);
  assert.ok((await readdir(path.join(instance, ".orchestrator", "runtime"))).includes("application-gateway-cli.mjs"));
  assert.deepEqual((await readdir(path.join(root, "data"))).filter((name) => name.includes("staging")), []);

  const before = await snapshot(instance);
  const second = parseJsonOutput(await runCliProcess(["setup", "--no-start", "--json"], { env }));
  const again = stepsByName(second);
  assert.equal(again.instance.status, "existing");
  assert.equal(again["claude-sdk"].status, "configured");
  assert.equal(again["claude-provider"].status, "unchanged");
  assert.equal(again["control-cycle"].status, "existing");
  assert.deepEqual(await snapshot(instance), before, "a second setup changes nothing");
});

test("setup keeps the person's provider settings and refuses foreign folders", async (t) => {
  const root = await temporaryRoot(t, "af-setup-keep-");
  const template = await buildTemplate(root);
  const sdk = await buildFakeSdk(root);
  const env = testEnvironment(root);
  const instance = path.join(root, "instance");
  const providerFile = path.join(instance, ".project-local", "application-gateway", "claude-provider.json");
  assert.equal((await runCliProcess(["setup", "--instance", instance, "--template", template, "--no-start", "--json"], { env })).status, 0);
  const skipped = parseJsonOutput(await runCliProcess(["setup", "--instance", instance, "--no-start", "--json"], { env }));
  assert.equal(stepsByName(skipped)["claude-provider"].reasonCode, "sdk_not_installed");
  await mkdir(path.dirname(providerFile), { recursive: true });
  await writeFile(providerFile, JSON.stringify({ schemaVersion: 1, sdkPath: path.join(root, "elsewhere"), keepProviderVariables: false,
    models: [{ id: "claude-custom-model" }], permissionMode: "plan" }));
  const updated = parseJsonOutput(await runCliProcess(["setup", "--instance", instance, "--sdk-path", sdk, "--no-start", "--json"], { env }));
  assert.equal(stepsByName(updated)["claude-provider"].status, "updated");
  const provider = JSON.parse(await readFile(providerFile, "utf8"));
  assert.deepEqual(provider, { schemaVersion: 1, sdkPath: sdk, keepProviderVariables: true,
    models: [{ id: "claude-custom-model" }], permissionMode: "plan" });

  const foreign = path.join(root, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "notes.txt"), "not a controller");
  const refused = await runCliProcess(["setup", "--instance", foreign, "--template", template, "--json"], { env });
  assert.equal(refused.status, 1);
  const failure = parseJsonOutput(refused);
  assert.equal(failure.code, "instance_folder_not_empty");
  assert.equal(failure.detail.failedStep, "instance");
  const noTemplate = await runCliProcess(["setup", "--instance", path.join(root, "new"), "--json"], { env });
  assert.equal(noTemplate.status, 2);
  assert.equal(parseJsonOutput(noTemplate).code, "template_required");
});

test("setup writes the Atlas config from status.v1.json on first use and refuses to switch silently", async (t) => {
  const root = await temporaryRoot(t, "af-setup-atlas-");
  const template = await buildTemplate(root, { projectId: "atlas-fixture" });
  const env = testEnvironment(root);
  const instance = path.join(root, "instance");
  const atlas = path.join(root, "atlas", "config", "local.json");
  const args = ["setup", "--instance", instance, "--template", template, "--no-start", "--atlas-config", atlas, "--json"];
  const missing = parseJsonOutput(await runCliProcess(args, { env }));
  assert.equal(stepsByName(missing)["atlas-config"].reasonCode, "gateway_status_missing");
  // A source install on Windows gets this PC's launcher paths; the person's own file is kept after that.
  if (process.platform === "win32") {
    assert.equal(stepsByName(missing).launcher.status, "created");
    const launch = await readFile(path.join(instance, ".project-local", "launch.cmd"), "utf8");
    assert.ok(launch.includes(`@set "ATLAS=${path.join(root, "atlas")}"\r\n`) && launch.includes('@set "NODE='));
  }
  const workspace = { projectId: "atlas-fixture", sourceId: "orchestrator-development", workspaceRootSha256: "a".repeat(64) };
  await mkdir(path.join(instance, ".project-local", "application-gateway"), { recursive: true });
  await writeFile(path.join(instance, ".project-local", "application-gateway", "status.v1.json"),
    JSON.stringify({ schemaVersion: 1, identity: { workspace }, lifecycle: "stopped", terminal: true }));
  const second = stepsByName(parseJsonOutput(await runCliProcess(args, { env })));
  const created = second["atlas-config"];
  assert.equal(created.status, "created");
  if (process.platform === "win32") assert.equal(second.launcher.status, "kept");
  const config = JSON.parse(await readFile(atlas, "utf8"));
  assert.deepEqual(config, { controllerRoot: instance, expectedWorkspace: { projectId: "atlas-fixture", workspaceRootSha256: "a".repeat(64) } });
  assert.equal(stepsByName(parseJsonOutput(await runCliProcess(args, { env })))["atlas-config"].status, "unchanged");

  await writeFile(atlas, JSON.stringify({ controllerRoot: path.join(root, "other"), expectedWorkspace: { projectId: "other",
    workspaceRootSha256: "b".repeat(64) }, gatewayCli: { nodeExecutable: "node" } }));
  const conflict = await runCliProcess(args, { env });
  assert.equal(conflict.status, 1);
  assert.equal(parseJsonOutput(conflict).code, "atlas_config_conflict");
  const replaced = parseJsonOutput(await runCliProcess([...args, "--replace-atlas-config"], { env }));
  assert.equal(stepsByName(replaced)["atlas-config"].status, "updated");
  assert.deepEqual(JSON.parse(await readFile(atlas, "utf8")), { controllerRoot: instance,
    expectedWorkspace: { projectId: "atlas-fixture", workspaceRootSha256: "a".repeat(64) }, gatewayCli: { nodeExecutable: "node" } });
});

test("setup --install-sdk installs from the registry and points the provider at it", async (t) => {
  const root = await temporaryRoot(t, "af-setup-sdk-");
  const template = await buildTemplate(root);
  const sdkName = "@anthropic-ai/claude-agent-sdk";
  const platformName = `${sdkName}-${process.platform}-${process.arch}`;
  const program = process.platform === "win32" ? "claude.exe" : "claude";
  const sdkTarball = packageTarball(sdkName, "3.1.4", { "sdk.mjs": "export const fixture = true;\n" });
  const registry = await startFakeRegistry({
    [sdkName]: { distTags: { latest: "3.1.4" }, versions: { "3.1.4": { tarball: sdkTarball, integrity: integrityOf(sdkTarball),
      manifest: { optionalDependencies: { [platformName]: "3.1.4" } } } } },
    [platformName]: { distTags: { latest: "3.1.4" }, versions: { "3.1.4": {
      tarball: packageTarball(platformName, "3.1.4", { [program]: "fixture\n" }), manifest: {} } } },
  });
  t.after(() => registry.close());
  const env = testEnvironment(root);
  const result = parseJsonOutput(await runCliProcess(["setup", "--template", template, "--install-sdk", "--registry", registry.url, "--sdk-version", "latest",
    "--no-start", "--json"], { env }));
  const steps = stepsByName(result);
  assert.equal(steps["claude-sdk"].status, "installed");
  assert.equal(steps["claude-sdk"].version, "3.1.4");
  const expected = path.join(root, "data", "runtime", "claude-agent-sdk", "3.1.4", "node_modules", "@anthropic-ai", "claude-agent-sdk");
  assert.equal(steps["claude-provider"].sdkPath, expected);
  const status = parseJsonOutput(await runCliProcess(["claude", "status", "--json"], { env }));
  assert.equal(status.sdk.configured.present, true);
  assert.equal(status.sdk.configured.programPresent, true);
  assert.equal(status.sdk.configured.managed, true);
  assert.equal(status.provider.keepProviderVariables, true);
});

test("migrations run in order behind a backup, once, and refuse broken chains", async (t) => {
  const root = await temporaryRoot(t, "af-migrate-");
  const template = await buildTemplate(root);
  const env = testEnvironment(root);
  const instance = path.join(root, "instance");
  assert.equal((await runCliProcess(["setup", "--instance", instance, "--template", template, "--no-start", "--json"], { env })).status, 0);
  const dry = parseJsonOutput(await runCliProcess(["migrate", "--dry-run", "--instance", instance, "--json"], { env }));
  assert.deepEqual({ state: dry.state, pending: dry.pending, backup: dry.backup },
    { state: "current", pending: [], backup: null });
  const layout = agentsFactoryLayout({ dataDir: path.join(root, "data"), instanceDir: instance });
  await mkdir(path.join(instance, ".project-local", "memory"), { recursive: true });
  await writeFile(path.join(instance, ".project-local", "memory", "project-memory.v1.sqlite"), "sqlite bytes");
  const order = [];
  const base = INSTANCE_SCHEMA_VERSION;
  const migrations = [
    { id: "one-to-two", from: base, to: base + 1, description: "fixture", apply: async () => { order.push("one-to-two"); } },
    { id: "two-to-three", from: base + 1, to: base + 2, description: "fixture", apply: async () => { order.push("two-to-three"); } },
  ];
  const planned = await migrateInstance({ layout, dryRun: true, migrations });
  assert.deepEqual(planned.pending.map((item) => item.id), ["one-to-two", "two-to-three"]);
  assert.deepEqual(order, []);
  const migrated = await migrateInstance({ layout, migrations });
  assert.equal(migrated.state, "migrated");
  assert.equal(migrated.schemaVersion, base + 2);
  assert.deepEqual(order, ["one-to-two", "two-to-three"]);
  const manifest = JSON.parse(await readFile(path.join(migrated.backup.path, "backup-manifest.json"), "utf8"));
  const backedUp = manifest.files.map((item) => item.path);
  assert.ok(backedUp.includes("instance.json"));
  assert.ok(backedUp.includes(".project-local/memory/project-memory.v1.sqlite"));
  assert.ok(backedUp.includes(".project-local/application-gateway/claude-provider.json") === false);
  assert.ok(backedUp.includes(".project-local/orchestration/control-cycle.json"));
  const again = await migrateInstance({ layout, migrations });
  assert.equal(again.state, "current");
  assert.deepEqual(order, ["one-to-two", "two-to-three"], "applied migrations do not run again");
  await assert.rejects(migrateInstance({ layout }), { code: "instance_newer_than_cli" });
  await assert.rejects(migrateInstance({ layout, migrations: [{ id: "gap", from: base, to: base + 2, apply: async () => {} }] }),
    { code: "migration_list_invalid" });
  await mkdir(layout.gatewayRuntime, { recursive: true });
  await writeFile(layout.gatewayStatus, JSON.stringify({ terminal: false, identity: { process: { processId: process.pid } } }));
  await assert.rejects(migrateInstance({ layout, migrations: [...migrations,
    { id: "three-to-four", from: base + 2, to: base + 3, apply: async () => {} }] }), { code: "gateway_running" });
});

test("setup sets the mode: local unless asked, synced with a checked sync.json and this PC's name", async (t) => {
  const root = await temporaryRoot(t, "af-setup-mode-");
  const template = await buildTemplate(root);
  const env = testEnvironment(root);
  const instance = path.join(root, "instance");
  const first = parseJsonOutput(await runCliProcess(["setup", "--instance", instance, "--template", template, "--no-start", "--json"], { env }));
  assert.deepEqual({ status: stepsByName(first).mode.status, mode: stepsByName(first).mode.mode }, { status: "kept", mode: "local" });
  const wrong = await runCliProcess(["setup", "--instance", instance, "--mode", "server", "--no-start", "--json"], { env });
  assert.equal(wrong.status, 2);
  const config = path.join(root, "sync.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, branch: "main", packagesRoot: path.join(root, "packages"),
    author: { name: "Test", email: "test@example.com" },
    world: { remotes: [{ name: "hub", url: path.join(root, "world.git"), primary: true }] }, projects: {} }));
  const synced = parseJsonOutput(await runCliProcess(["setup", "--instance", instance, "--mode", "synced", "--sync-config", config,
    "--machine-id", "home", "--machine-title", "Home", "--home", "--no-start", "--json"], { env }));
  const step = stepsByName(synced).mode;
  assert.deepEqual({ status: step.status, mode: step.mode, previous: step.previous, missing: step.missing },
    { status: "set", mode: "synced", previous: "local", missing: [] });
  const shown = parseJsonOutput(await runCliProcess(["instance", "mode", "--instance", instance, "--json"], { env }));
  assert.deepEqual({ mode: shown.mode, recorded: shown.recorded }, { mode: "synced", recorded: true });
  const doctor = parseJsonOutput(await runCliProcess(["doctor", "--instance", instance, "--json"], { env }));
  assert.deepEqual(doctor.checks.find((item) => item.id === "mode")?.mode, "synced");
  const local = parseJsonOutput(await runCliProcess(["instance", "mode", "--instance", instance, "--set", "local", "--confirm", "local",
    "--json"], { env }));
  assert.deepEqual({ previous: local.previous, mode: local.mode }, { previous: "synced", mode: "local" });
});

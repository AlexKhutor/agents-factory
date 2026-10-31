import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseCommandLine, runCli } from "../src/agents-factory-commands.mjs";
import { INSTANCE_SCHEMA_VERSION } from "../src/agents-factory-migrate.mjs";
import { agentsFactoryDataDir, defaultInstanceDir, resolveLayout } from "../src/agents-factory-paths.mjs";
import {
  buildFakeSdk, buildTemplate, cliBundle, fakeExecutor, orchestratorRoot, parseJsonOutput, runCliProcess, temporaryRoot,
  testEnvironment,
} from "./fixtures/agents-factory/helpers.mjs";

test("data folders follow stage-0.md per OS; AGENTS_FACTORY_HOME names the instance", () => {
  assert.equal(agentsFactoryDataDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local" }, homeDir: "C:\\Users\\p" }),
    "C:\\Users\\p\\AppData\\Local\\AgentsFactory");
  assert.equal(agentsFactoryDataDir({ platform: "win32", env: {}, homeDir: "C:\\Users\\p" }), "C:\\Users\\p\\AppData\\Local\\AgentsFactory");
  assert.equal(agentsFactoryDataDir({ platform: "darwin", env: {}, homeDir: "/Users/p" }), "/Users/p/Library/Application Support/AgentsFactory");
  assert.equal(agentsFactoryDataDir({ platform: "linux", env: {}, homeDir: "/home/p" }), "/home/p/.local/share/agents-factory");
  assert.equal(agentsFactoryDataDir({ platform: "linux", env: { XDG_DATA_HOME: "/data/xdg" }, homeDir: "/home/p" }), "/data/xdg/agents-factory");
  assert.equal(agentsFactoryDataDir({ platform: "linux", env: { XDG_DATA_HOME: "relative" }, homeDir: "/home/p" }), "/home/p/.local/share/agents-factory");
  assert.equal(defaultInstanceDir({ platform: "darwin", env: {}, homeDir: "/Users/p" }), "/Users/p/Library/Application Support/AgentsFactory/controller");
  assert.equal(defaultInstanceDir({ platform: "linux", env: { AGENTS_FACTORY_HOME: "/srv/af" }, homeDir: "/home/p" }), "/srv/af");
  assert.equal(agentsFactoryDataDir({ platform: "linux", env: { AGENTS_FACTORY_DATA_DIR: "/tmp/af-data" }, homeDir: "/home/p" }), "/tmp/af-data");
  const layout = resolveLayout({ options: { instance: "/srv/one" }, env: { AGENTS_FACTORY_HOME: "/srv/two" }, platform: "linux", homeDir: "/home/p" });
  assert.equal(layout.instanceDir, "/srv/one");
  assert.equal(layout.sdkRoot, "/home/p/.local/share/agents-factory/runtime/claude-agent-sdk");
  assert.equal(layout.dpapiKeyFile, "/home/p/.local/share/agents-factory/secrets/anthropic-api-key.dpapi.json");
});

test("arguments: groups, options anywhere, flags without values, exit code 2 for misuse", async () => {
  assert.deepEqual(parseCommandLine(["gateway", "start", "--provider", "codex", "--json"]),
    { command: "gateway start", options: { provider: "codex", json: true } });
  assert.deepEqual(parseCommandLine(["--json", "gateway", "status", "--instance=/x"]),
    { command: "gateway status", options: { json: true, instance: "/x" } });
  assert.deepEqual(parseCommandLine([]), { command: "help", options: { json: false } });
  for (const argv of [["gateway"], ["gateway", "dance"], ["setup", "extra"], ["key", "set", "sk-ant-in-argv"],
    ["gateway", "start", "--provider"], ["gateway", "start", "--bogus"], ["migrate", "--dry-run=maybe"],
    ["gateway", "start", "--json", "--json"]]) {
    assert.throws(() => parseCommandLine(argv), (error) => error.code === "invalid_arguments" && error.exitCode === 2, argv.join(" "));
  }
  const output = [];
  const io = { env: {}, stdout: { write: (text) => output.push(text) }, stderr: { write: () => {} }, executor: fakeExecutor() };
  // Claude is the only provider: the Codex path left the product (roadmap step 1).
  for (const provider of ["gemini", "codex"]) {
    assert.equal(await runCli(["gateway", "start", "--provider", provider, "--json", "--instance", "/nowhere"], io), 2);
    assert.deepEqual(JSON.parse(output.at(-1)), { ok: false, code: "invalid_arguments",
      message: "--provider is claude (the Codex path left the product)" });
  }
  assert.equal(await runCli(["gateway", "logs", "--follow", "--json", "--instance", "/nowhere"], io), 2);
  // sync recover only lists without --apply; naming this PC belongs to the settling form.
  assert.equal(await runCli(["sync", "recover", "--confirm", "home", "--json", "--instance", "/nowhere"], io), 2);
  assert.deepEqual(JSON.parse(output.at(-1)), { ok: false, code: "invalid_arguments", message: "sync recover: --confirm goes with --apply" });
});

test("version and help answer without an instance", async (t) => {
  const root = await temporaryRoot(t, "af-cli-version-");
  const env = testEnvironment(root);
  const version = parseJsonOutput(await runCliProcess(["version", "--json"], { env }));
  assert.equal(version.ok, true);
  assert.equal(version.command, "version");
  assert.match(version.cli.version, /^v\d+\.\d+\.\d+$/u);
  assert.equal(version.node, process.version);
  assert.deepEqual(version.instance, { path: path.join(root, "data", "controller"), exists: false });
  assert.deepEqual(version.sdk, { configuredVersion: null, installed: [] });
  const help = await runCliProcess([], { env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /gateway start/u);
  const human = await runCliProcess(["gateway", "status"], { env });
  assert.equal(human.status, 1);
  assert.match(human.stderr, /^agents-factory: instance_missing: /u);
  assert.deepEqual(await readdir(root), [], "nothing is written by version, help or a refused status");
});

test("doctor only reads: it reports the instance, SDK, key and Gateway without writing", async (t) => {
  const root = await temporaryRoot(t, "af-cli-doctor-");
  const template = await buildTemplate(root);
  const sdk = await buildFakeSdk(root);
  const env = testEnvironment(root);
  const instance = path.join(root, "instance");
  assert.equal((await runCliProcess(["setup", "--instance", instance, "--template", template, "--sdk-path", sdk, "--no-start",
    "--json"], { env })).status, 0);
  const walk = async (directory) => {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
      found.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
    return found.sort();
  };
  const before = await walk(root);
  const output = [];
  const executor = {
    calls: [],
    async run(file, args, options) {
      this.calls.push([path.basename(file), args[1] ?? args[0]]);
      if (file === "git") return { status: 0, stdout: "git version 2.50.0\n", stderr: "", errorCode: null };
      const { runProcess } = await import("../src/agents-factory-common.mjs");
      return runProcess(file, args, options);
    },
  };
  const serviceManager = { status: async () => ({ installed: false, mechanism: null }) };
  const code = await runCli(["doctor", "--instance", instance, "--json"], { env, executor, serviceManager,
    stdout: { write: (text) => output.push(text) }, stderr: { write: () => {} } });
  assert.equal(code, 0);
  const report = JSON.parse(output.join(""));
  const checks = Object.fromEntries(report.checks.map((item) => [item.id, item]));
  assert.equal(report.ok, true);
  assert.equal(checks.git.version, "2.50.0");
  assert.equal(checks.instance.status, "ok");
  assert.equal(checks.instance.schemaVersion, INSTANCE_SCHEMA_VERSION);
  assert.equal(checks["claude-provider"].status, "ok");
  assert.equal(checks["claude-sdk"].status, "warning", "the fixture SDK has no Claude Code program");
  assert.equal(checks["claude-login"].status, "skipped");
  assert.equal(checks["api-key"].status, "warning");
  assert.equal(checks.gateway.reasonCode, "status_missing");
  assert.equal(checks.loopback.status, "ok");
  assert.equal(checks.service.installed, false);
  assert.equal(report.healthy, report.errors === 0);
  assert.deepEqual(await walk(root), before, "doctor writes nothing");
  assert.ok(executor.calls.every(([file]) => file !== "claude" && file !== "claude.exe"));
});

test("checked-in agents-factory CLI bundle matches source and has no npm dependencies", () => {
  const result = spawnSync(process.execPath, [path.join(orchestratorRoot, "scripts", "build-agents-factory-cli.mjs"), "--verify"], {
    cwd: orchestratorRoot, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /agents_factory_cli_bundle_parity: passed/u);
  const imports = spawnSync(process.execPath, ["-e", `const s=require("fs").readFileSync(${JSON.stringify(cliBundle)},"utf8");`
    + "const m=[...s.matchAll(/^import .* from \"([^\"]+)\";$/gm)].map(x=>x[1]).filter(x=>!x.startsWith(\"node:\"));"
    + "process.stdout.write(JSON.stringify(m));"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(imports.stdout), []);
});

import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { agentsFactoryLayout } from "../src/agents-factory-paths.mjs";
import { createServiceManager, serviceCommand, serviceIdentity } from "../src/agents-factory-service.mjs";
import { fakeExecutor, parseJsonOutput, runCliProcess, temporaryRoot, testEnvironment } from "./fixtures/agents-factory/helpers.mjs";

// Every test here uses a fake executor or --plan-only: nothing is registered
// with Task Scheduler, the registry, launchd or systemd of this machine.

const WINDOWS_ENV = Object.freeze({ SystemRoot: "C:\\Windows", USERDOMAIN: "EXAMPLE", USERNAME: "person" });

function windowsLayout() {
  return agentsFactoryLayout({ dataDir: "C:\\Users\\person\\AppData\\Local\\AgentsFactory",
    instanceDir: "C:\\Users\\person\\AppData\\Local\\AgentsFactory\\controller", platform: "win32" });
}

function memoryFiles() {
  const written = new Map();
  return {
    written,
    removed: [],
    async write(file, content) { written.set(file, content); },
    async remove(file) { this.removed.push(file); written.delete(file); },
    async read(file) { return written.get(file) ?? null; },
    async exists(file) { return written.has(file); },
  };
}

const windowsCommand = serviceCommand({ nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliPath: "C:\\Users\\person\\AppData\\Local\\AgentsFactory\\controller\\.orchestrator\\runtime\\agents-factory.mjs",
  instanceDir: "C:\\Users\\person\\AppData\\Local\\AgentsFactory\\controller" });

test("Windows plan: a logon task of this user only, least privilege, Run key as fallback", () => {
  const executor = fakeExecutor();
  const manager = createServiceManager({ platform: "win32", env: WINDOWS_ENV, homeDir: "C:\\Users\\person",
    executor, files: memoryFiles(), layout: windowsLayout() });
  const plan = manager.plan(windowsCommand);
  assert.equal(executor.calls.length, 0);
  assert.equal(plan.primary.mechanism, "task-scheduler");
  assert.equal(plan.fallback.mechanism, "hkcu-run");
  const xml = plan.primary.actions[0].content;
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>EXAMPLE\\person<\/UserId>/u);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/u);
  assert.match(xml, /<Arguments>C:\\Users\\person\\AppData\\Local\\AgentsFactory\\controller\\.orchestrator\\runtime\\agents-factory.mjs gateway start --instance C:\\Users\\person\\AppData\\Local\\AgentsFactory\\controller --provider claude --json<\/Arguments>/u);
  assert.deepEqual(plan.primary.actions[1].args.slice(0, 3), ["/Create", "/TN", serviceIdentity(windowsLayout().instanceDir, "win32").windowsName]);
  assert.equal(plan.fallback.actions[0].args[0], "add");
  assert.equal(plan.fallback.actions[0].args[1], "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
  assert.match(plan.fallback.commandLine, /^"C:\\Program Files\\nodejs\\node.exe" /u);
});

test("Windows install registers the task and removes its XML; a refusal falls back to the Run key", async () => {
  const files = memoryFiles();
  const executor = fakeExecutor();
  const manager = createServiceManager({ platform: "win32", env: WINDOWS_ENV, homeDir: "C:\\Users\\person",
    executor, files, layout: windowsLayout() });
  const installed = await manager.install(windowsCommand);
  assert.equal(installed.mechanism, "task-scheduler");
  assert.equal(installed.fallbackFrom, null);
  assert.equal(executor.calls.length, 1);
  assert.equal(path.win32.basename(executor.calls[0].file), "schtasks.exe");
  assert.equal(files.written.size, 0, "the task XML is removed after registration");
  assert.equal(files.removed.length, 1);

  const refusing = fakeExecutor((file) => (path.win32.basename(file) === "schtasks.exe"
    ? { status: 1, stderr: "ERROR: Access is denied.\r\n" } : { status: 0 }));
  const fallbackManager = createServiceManager({ platform: "win32", env: WINDOWS_ENV, homeDir: "C:\\Users\\person",
    executor: refusing, files: memoryFiles(), layout: windowsLayout() });
  const fallback = await fallbackManager.install(windowsCommand);
  assert.equal(fallback.mechanism, "hkcu-run");
  assert.deepEqual(fallback.fallbackFrom, { mechanism: "task-scheduler", status: 1, accessDenied: true });
  assert.deepEqual(refusing.calls.map((call) => path.win32.basename(call.file)), ["schtasks.exe", "reg.exe"]);
  assert.equal(refusing.calls[1].args[6], "/d");
  assert.match(refusing.calls[1].args[7], /gateway start --instance/u);

  const forced = fakeExecutor(() => ({ status: 1 }));
  const forcedManager = createServiceManager({ platform: "win32", env: WINDOWS_ENV, executor: forced, files: memoryFiles(),
    layout: windowsLayout() });
  await assert.rejects(forcedManager.install(windowsCommand, { mechanism: "task-scheduler" }), { code: "service_install_failed" });
  assert.equal(forced.calls.length, 1, "a forced mechanism does not fall back");
});

test("Windows status and uninstall touch only what is registered", async () => {
  const executor = fakeExecutor((file, args) => {
    if (path.win32.basename(file) === "schtasks.exe" && args[0] === "/Query") return { status: 0, stdout: "<Task/>" };
    if (path.win32.basename(file) === "reg.exe" && args[0] === "query") return { status: 1 };
    return { status: 0 };
  });
  const manager = createServiceManager({ platform: "win32", env: WINDOWS_ENV, executor, files: memoryFiles(), layout: windowsLayout() });
  const status = await manager.status();
  assert.equal(status.installed, true);
  assert.deepEqual(status.mechanisms, ["task-scheduler"]);
  const removed = await manager.uninstall();
  assert.equal(removed.removed, true);
  const deletes = executor.calls.filter((call) => call.args[0] === "/Delete" || call.args[0] === "delete");
  assert.deepEqual(deletes.map((call) => call.args[0]), ["/Delete"]);
});

test("Windows under Electron passes ELECTRON_RUN_AS_NODE through cmd.exe", () => {
  const command = serviceCommand({ nodePath: "C:\\Program Files\\Agents Factory\\Agents Factory.exe",
    cliPath: "C:\\Program Files\\Agents Factory\\resources\\agents-factory.mjs", instanceDir: "C:\\Data\\controller", electron: true });
  const manager = createServiceManager({ platform: "win32", env: WINDOWS_ENV, executor: fakeExecutor(), files: memoryFiles(),
    layout: agentsFactoryLayout({ dataDir: "C:\\Data", instanceDir: "C:\\Data\\controller", platform: "win32" }) });
  const xml = manager.plan(command).primary.actions[0].content;
  assert.match(xml, /<Command>C:\\Windows\\System32\\cmd.exe<\/Command>/u);
  assert.match(xml, /set ELECTRON_RUN_AS_NODE=1&amp;&amp; &quot;C:\\Program Files\\Agents Factory\\Agents Factory.exe&quot;/u);
  const unsafe = serviceCommand({ nodePath: "C:\\A&B\\electron.exe", cliPath: "C:\\cli.mjs", instanceDir: "C:\\i", electron: true });
  assert.throws(() => manager.plan(unsafe), { code: "service_path_unsupported" });
});

test("macOS writes a LaunchAgent for the next login and boots it out on uninstall", async (t) => {
  const root = await temporaryRoot(t, "af-service-mac-");
  const home = path.join(root, "home");
  const executor = fakeExecutor((file, args) => (args[0] === "print" ? { status: 113 } : { status: 0 }));
  const layout = agentsFactoryLayout({ dataDir: path.join(root, "data"), instanceDir: path.join(root, "data", "controller"), platform: "darwin" });
  const manager = createServiceManager({ platform: "darwin", env: {}, homeDir: home, executor, layout, uid: 501 });
  const command = serviceCommand({ nodePath: "/usr/local/bin/node", cliPath: "/opt/af/agents-factory.mjs", instanceDir: layout.instanceDir });
  const installed = await manager.install(command);
  assert.equal(installed.mechanism, "launch-agent");
  assert.equal(executor.calls.length, 0, "nothing is loaded now: launchd loads LaunchAgents at login");
  const plist = await readFile(installed.path, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/u);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/opt\/af\/agents-factory.mjs<\/string>\s*<string>gateway<\/string>\s*<string>start<\/string>/u);
  assert.equal(installed.path, path.posix.join(home, "Library", "LaunchAgents", `${manager.identity.launchdLabel}.plist`));
  const status = await manager.status();
  assert.equal(status.installed, true);
  assert.equal(status.loaded, false);
  const removed = await manager.uninstall();
  assert.equal(removed.removed, true);
  assert.deepEqual(executor.calls.at(-1).args, ["bootout", `gui/501/${manager.identity.launchdLabel}`]);
  assert.equal((await manager.status()).installed, false);
});

test("Linux writes a systemd --user unit, reloads and enables it", async (t) => {
  const root = await temporaryRoot(t, "af-service-linux-");
  const home = path.join(root, "home");
  const unitDirectory = path.posix.join(home, ".config", "systemd", "user");
  const executor = fakeExecutor((file, args) => (args[1] === "is-enabled" ? { status: 0, stdout: "enabled\n" } : { status: 0 }));
  const layout = agentsFactoryLayout({ dataDir: path.join(root, "data"), instanceDir: path.join(root, "my data", "controller"), platform: "linux" });
  const manager = createServiceManager({ platform: "linux", env: {}, homeDir: home, executor, layout });
  const command = serviceCommand({ nodePath: "/usr/bin/node", cliPath: "/opt/af/agents-factory.mjs", instanceDir: layout.instanceDir });
  const plan = manager.plan(command);
  assert.equal(plan.primary.mechanism, "systemd-user");
  const installed = await manager.install(command);
  assert.equal(installed.mechanism, "systemd-user");
  const unit = await readFile(installed.path, "utf8");
  assert.match(unit, /^Type=oneshot$/mu);
  assert.match(unit, /^RemainAfterExit=yes$/mu);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/af\/agents-factory.mjs" "gateway" "start" "--instance" ".*my data.*controller"/mu);
  assert.match(unit, /^ExecStop=.*"gateway" "stop"/mu);
  assert.match(unit, /^WantedBy=default.target$/mu);
  assert.deepEqual(executor.calls.map((call) => call.args), [["--user", "daemon-reload"], ["--user", "enable", manager.identity.systemdUnit]]);
  assert.deepEqual(await readdir(unitDirectory), [manager.identity.systemdUnit]);
  assert.equal((await manager.status()).enabled, true);
  await manager.uninstall();
  assert.deepEqual(await readdir(unitDirectory), []);
  assert.deepEqual(executor.calls.slice(-2).map((call) => call.args), [["--user", "disable", manager.identity.systemdUnit],
    ["--user", "daemon-reload"]]);
});

test("service install --plan-only through the CLI registers nothing", async (t) => {
  const root = await temporaryRoot(t, "af-service-cli-");
  const env = testEnvironment(root);
  const instance = path.join(root, "instance");
  await mkdir(instance);
  const result = await runCliProcess(["service", "install", "--plan-only", "--instance", instance, "--json"], { env });
  assert.equal(result.status, 0, result.stderr);
  const plan = parseJsonOutput(result);
  assert.equal(plan.ok, true);
  assert.equal(plan.planOnly, true);
  assert.equal(plan.activatesAt, "next-logon");
  assert.ok(["task-scheduler", "launch-agent", "systemd-user"].includes(plan.primary.mechanism));
  assert.deepEqual(await readdir(root), ["instance"], "plan-only writes nothing");
  const bad = await runCliProcess(["service", "install", "--plan-only", "--mechanism", "cron", "--instance", instance, "--json"], { env });
  assert.equal(bad.status, 2);
});

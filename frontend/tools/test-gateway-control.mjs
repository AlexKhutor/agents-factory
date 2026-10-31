// Regression test for Gateway control from Atlas: the agents-factory CLI the
// host runs for the Gateway, the Anthropic API key and autostart.
//
// It runs the real modules - real spawn, real argument arrays, real stdin - against
// the fixture's fake CLI (src/dev/fake-agents-factory-cli.mjs) in a throwaway
// controller root, and small scripts for the runner's edge cases. No Gateway is
// started, no key is stored anywhere, no autostart is installed.
//
// What it holds the host to:
//   - the key goes to the CLI through stdin only - never argv, never the
//     environment - and appears in no answer, journal entry, file or log;
//   - the page sees {hasKey} read back from `key status`, never the key;
//   - a failure carries the CLI's exact code and never its free text;
//   - removing the key and turning autostart on are confirmed; nothing changes
//     without a confirmation surface; one change runs at a time;
//   - the CLI is found where the configuration says, else in the controller,
//     else (source checkout only) in the backend's build - never guessed further.

import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  AGENTS_FACTORY_CLI, cliLauncher, developmentBuildAllowed, parseAgentsFactoryOutput,
  resolveAgentsFactoryCli, runAgentsFactory,
} from "../src/host/agents-factory-cli.mjs";
import {
  apiKeyProblem, createGatewayControl, gatewayStateOf, gatewaySummary, unavailableGatewayControl,
} from "../src/host/gateway-control.mjs";
import { CHANNEL_NAMES, createChannels } from "../src/host/ipc.mjs";
import { createReadJournal } from "../src/host/read-journal.mjs";
import { createSession } from "../src/host/session.mjs";
import {
  FAKE_AGENTS_FACTORY_STATE, prepareDevAgentsFactory, writeFakeAgentsFactoryState,
} from "../src/dev/dev-agents-factory.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const panel = require("../src/renderer/gateway-panel.js");

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const scratch = await mkdtemp(path.join(os.tmpdir(), "atlas-gateway-control-"));
// A key-shaped text that is not a key. Every place it must never reach is searched for it.
const FAKE_KEY = `sk-ant-test-${"k7".repeat(24)}-not-a-real-key`;

/** Every file under a folder, as text, to search for the key. */
async function allText(folder) {
  const out = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    out.push(await readFile(full, "utf8").catch(() => ""));
  }
  return out.join("\n");
}

async function fixtureRoot(name, state = {}) {
  const root = path.join(scratch, name);
  await mkdir(root, { recursive: true });
  await prepareDevAgentsFactory(root, { startDelayMs: 0, ...state });
  return root;
}

async function readFakeState(root) {
  return JSON.parse(await readFile(path.join(root, FAKE_AGENTS_FACTORY_STATE), "utf8"));
}

/** A control over the fake CLI whose runner records every call it makes. */
function controlFor(root, { answer = true, confirm = undefined, journal = null } = {}) {
  const asked = [];
  const calls = [];
  const control = createGatewayControl({
    controllerRoot: root, fixture: true, journal,
    confirm: confirm === undefined ? async (request) => { asked.push(request); return answer; } : confirm,
    run: async (options) => {
      calls.push({ args: options.args, env: options.launcher.env, secret: options.secret, script: options.script });
      return runAgentsFactory(options);
    },
  });
  return { control, asked, calls };
}

// --- where the CLI is found, and how it is started ------------------------------------

{
  const root = path.join(scratch, "resolve");
  const app = path.join(root, "app", "frontend");
  const controller = path.join(root, "controller");
  await mkdir(app, { recursive: true });
  await mkdir(controller, { recursive: true });
  const none = await resolveAgentsFactoryCli({ controllerRoot: controller, applicationRoot: app, development: true });
  const built = path.resolve(app, AGENTS_FACTORY_CLI.developmentRelative);
  await mkdir(path.dirname(built), { recursive: true });
  await writeFile(built, "// build\n");
  const development = await resolveAgentsFactoryCli({ controllerRoot: controller, applicationRoot: app, development: true });
  const packaged = await resolveAgentsFactoryCli({ controllerRoot: controller, applicationRoot: app, development: false });
  const inController = path.join(controller, AGENTS_FACTORY_CLI.controllerRelative);
  await mkdir(path.dirname(inController), { recursive: true });
  await writeFile(inController, "// controller\n");
  const controllerFirst = await resolveAgentsFactoryCli({ controllerRoot: controller, applicationRoot: app, development: true });
  const configuredMissing = await resolveAgentsFactoryCli({
    controllerRoot: controller, configured: "tools/missing-cli.mjs", applicationRoot: app, development: true,
  });
  const configuredRelative = path.join(controller, "tools", "agents-factory.mjs");
  await mkdir(path.dirname(configuredRelative), { recursive: true });
  await writeFile(configuredRelative, "// configured\n");
  const configured = await resolveAgentsFactoryCli({
    controllerRoot: controller, configured: "tools/agents-factory.mjs", applicationRoot: app, development: true,
  });
  check("cli-is-found-by-configuration-then-controller-then-development-build",
    none.found === false && none.reasonCode === "agents_factory_cli_missing"
      && development.found === true && development.source === "development" && development.script === built
      && packaged.found === false
      && controllerFirst.source === "controller" && controllerFirst.script === inController
      && configuredMissing.found === false && configuredMissing.source === "configured"
      && configured.source === "configured" && configured.script === configuredRelative,
    { none, development, packaged, controllerFirst, configuredMissing, configured });
  check("development-build-only-outside-a-packaged-application",
    developmentBuildAllowed(PROJECT_ROOT) === true
      && developmentBuildAllowed(path.join("C:", "Program Files", "Atlas", "resources", "app.asar")) === false
      && developmentBuildAllowed(null) === false,
    { here: developmentBuildAllowed(PROJECT_ROOT) });
  const electron = cliLauncher(null);
  const node = cliLauncher("C:/tools/node.exe");
  check("cli-runs-under-electron-as-node-unless-a-node-is-configured",
    electron.executable === process.execPath && electron.env.ELECTRON_RUN_AS_NODE === "1"
      && node.executable === "C:/tools/node.exe" && node.env.ELECTRON_RUN_AS_NODE === process.env.ELECTRON_RUN_AS_NODE,
    { electron: electron.executable, node: node.executable });
}

// --- the state word, from what `gateway status` reports ----------------------------------

{
  const table = [
    [{ availability: "available", ready: true, lifecycle: "ready" }, "running"],
    [{ availability: "available", ready: false, lifecycle: "starting" }, "starting"],
    [{ availability: "available", ready: false, lifecycle: "stop-requested" }, "stopping"],
    [{ availability: "terminal", lifecycle: "stopped", reasonCode: "stopped" }, "stopped"],
    [{ availability: "terminal", reasonCode: "failed" }, "failed"],
    [{ availability: "terminal", lifecycle: "uncertain" }, "uncertain"],
    [{ availability: "stale", reasonCode: "gateway_stale" }, "stale"],
    [{ availability: "unavailable", reasonCode: "status_missing" }, "absent"],
    [{ availability: "unavailable", reasonCode: "status_invalid" }, "unknown"],
    [{}, "unknown"],
  ];
  const wrong = table.filter(([input, expected]) => gatewayStateOf(input) !== expected);
  // The application gateway CLI nests the instance under `gateway`; both shapes are read.
  const nested = gatewaySummary({ availability: "available", reasonCode: "gateway_ready", ready: true,
    gateway: { lifecycle: "ready", instanceId: "gw-1", heartbeatAtUtc: "2026-10-20T10:00:00.000Z" } });
  const hostile = gatewaySummary({ availability: "available", reasonCode: "C:\\Users\\x\\secret path", lifecycle: "ready",
    instanceId: "../../escape" });
  check("gateway-state-is-read-not-guessed",
    wrong.length === 0 && nested.state === "running" && nested.lifecycle === "ready" && nested.instanceId === "gw-1"
      && hostile.reasonCode === null && hostile.instanceId === null,
    { wrong, nested, hostile });
}

// --- the key's own checks: refused before any CLI, the reason says nothing of it -----------

{
  const reasons = [apiKeyProblem(""), apiKeyProblem("   "), apiKeyProblem("short"), apiKeyProblem(`${FAKE_KEY} x`),
    apiKeyProblem(`${FAKE_KEY}\n${FAKE_KEY}`), apiKeyProblem(`${FAKE_KEY}κλειδί`), apiKeyProblem(42), apiKeyProblem(FAKE_KEY),
    apiKeyProblem(`  ${FAKE_KEY}\n`)];
  check("key-checks-name-a-reason-not-the-text",
    reasons.join() === ["api_key_empty", "api_key_empty", "api_key_length_invalid", "api_key_characters_invalid",
      "api_key_characters_invalid", "api_key_characters_invalid", "api_key_invalid", null, null].join(),
    reasons);
}

// --- the whole flow against the fixture CLI ------------------------------------------------

const root = await fixtureRoot("flow", { failOnce: { "gateway start": "gateway_start_timeout" } });
const journal = createReadJournal({ header: { runId: "gateway-control-test" } });
const { control, asked, calls } = controlFor(root, { journal });

{
  const status = await control.status();
  const key = await control.keyStatus();
  const autostart = await control.autostartStatus();
  check("fresh-state-is-read-from-the-cli",
    status.ok && status.data.cli.available === true && status.data.cli.source === "fixture"
      && status.data.gateway.state === "absent" && status.data.gateway.reasonCode === "status_missing"
      && status.data.action === null
      && key.ok && key.data.hasKey === false && autostart.ok && autostart.data.installed === false
      && calls.every((call) => call.args.at(-3) === "--instance" && call.args.at(-2) === root && call.args.at(-1) === "--json"),
    { status, key, autostart, args: calls.map((call) => call.args) });
}

{
  const refused = await control.start();
  check("start-failure-carries-the-exact-code-and-no-text",
    refused.ok === false && refused.error.code === "cli_failed" && refused.error.reasonCode === "gateway_start_timeout"
      && refused.error.exitCode === 1 && !JSON.stringify(refused).includes("fixture:"),
    refused);
}

{
  const before = calls.length;
  const short = await control.setKey({ key: "sk-ant-short" });
  const spaced = await control.setKey({ key: `${FAKE_KEY} ${FAKE_KEY}` });
  const missing = await control.setKey({});
  check("invalid-key-never-reaches-the-cli",
    short.error?.reasonCode === "api_key_length_invalid" && spaced.error?.reasonCode === "api_key_characters_invalid"
      && missing.error?.reasonCode === "api_key_invalid" && calls.length === before
      && !JSON.stringify([short, spaced]).includes("sk-ant"),
    { short, spaced, missing });
}

let setResult = null;
{
  const before = calls.length;
  setResult = await control.setKey({ key: `  ${FAKE_KEY}\n` });
  const made = calls.slice(before);
  const setCall = made.find((call) => call.args[0] === "key" && call.args[1] === "set");
  const others = made.filter((call) => call !== setCall);
  check("key-goes-through-stdin-only-and-comes-back-as-has-key",
    setResult.ok === true && JSON.stringify(setResult.data) === JSON.stringify({ hasKey: true })
      && setCall !== undefined && setCall.secret === FAKE_KEY
      && !setCall.args.some((arg) => arg.includes(FAKE_KEY))
      && !Object.values(setCall.env).some((value) => String(value).includes(FAKE_KEY))
      && others.length === 1 && others[0].args[1] === "status" && others[0].secret === null,
    { setResult, made: made.map((call) => ({ args: call.args, hasSecret: call.secret !== null })) });
}

{
  // The second change is asked for while the first is still running.
  const started = control.start();
  const busy = await control.stop();
  const result = await started;
  const status = await control.status();
  check("start-runs-alone-and-ends-running",
    busy.ok === false && busy.error.code === "busy" && busy.error.reasonCode === "gateway-start_in_progress"
      && result.ok === true && result.data.state === "ready" && typeof result.data.instanceId === "string"
      && status.data.gateway.state === "running" && status.data.action === null,
    { busy, result, status: status.data.gateway });
}

{
  // Progress: while a start runs, status names it and the Gateway passes "starting".
  const slow = await fixtureRoot("progress", { hasKey: true, startDelayMs: 2000 });
  const { control: slowControl } = controlFor(slow);
  const started = slowControl.start();
  await new Promise((done) => setTimeout(done, 700));
  const during = await slowControl.status();
  await started;
  check("a-running-start-is-reported-with-its-lifecycle",
    during.data.action?.kind === "gateway-start" && typeof during.data.action.startedAtUtc === "string"
      && during.data.gateway?.state === "starting" && during.data.gateway.lifecycle === "starting",
    during.data);
}

{
  const stopped = await control.stop();
  const afterStop = await control.status();
  await writeFakeAgentsFactoryState(root, { ...(await readFakeState(root)), lifecycle: "stale" });
  const stale = await control.status();
  const recovered = await control.recover();
  const afterRecover = await control.status();
  check("stop-and-recover-report-what-the-cli-did",
    stopped.ok && stopped.data.state === "stopped" && afterStop.data.gateway.state === "stopped"
      && stale.data.gateway.state === "stale"
      && recovered.ok && recovered.data.state === "failed" && recovered.data.restartAllowed === true
      && afterRecover.data.gateway.state === "failed",
    { stopped, afterStop: afterStop.data.gateway, stale: stale.data.gateway, recovered, afterRecover: afterRecover.data.gateway });
}

{
  const before = asked.length;
  const callsBefore = calls.length;
  const { control: declining, asked: declined, calls: declinedCalls } = controlFor(root, { answer: false });
  const no = await declining.installAutostart();
  const stillOff = await control.autostartStatus();
  const yes = await control.installAutostart();
  const uninstallAsked = asked.length;
  const off = await control.uninstallAutostart();
  check("autostart-is-confirmed-before-install-and-not-before-uninstall",
    no.ok === false && no.error.code === "user_declined" && declined.length === 1 && declinedCalls.length === 0
      && declined[0].title === "Gateway autostart" && declined[0].confirmLabel === "Turn on autostart"
      && stillOff.data.installed === false
      && yes.ok && yes.data.installed === true && asked.length === before + 1
      && off.ok && off.data.installed === false && asked.length === uninstallAsked
      && calls.slice(callsBefore).some((call) => call.args[0] === "service" && call.args[1] === "install"),
    { no, yes, off, declined: declined.map((item) => item.title) });
}

{
  const { control: declining } = controlFor(root, { answer: false });
  const kept = await declining.removeKey();
  const stillThere = await control.keyStatus();
  const removed = await control.removeKey();
  check("removing-the-key-is-confirmed-and-read-back",
    kept.ok === false && kept.error.code === "user_declined" && stillThere.data.hasKey === true
      && removed.ok === true && removed.data.hasKey === false
      && asked.at(-1)?.title === "Remove API key" && asked.at(-1)?.confirmLabel === "Remove key",
    { kept, removed });
}

{
  const snapshot = JSON.stringify(journal.snapshot());
  const entries = journal.snapshot().entries.filter((entry) => entry.operationId?.startsWith("trusted."));
  const actions = entries.map((entry) => `${entry.operationId}:${entry.status}`);
  const files = await allText(root);
  check("the-key-is-in-no-answer-journal-or-file",
    !snapshot.includes(FAKE_KEY) && !files.includes(FAKE_KEY) && !JSON.stringify(setResult).includes(FAKE_KEY)
      && actions.includes("trusted.gateway-start:failure") && actions.includes("trusted.api-key-set:success")
      && actions.includes("trusted.api-key-set:not-attempted") && actions.includes("trusted.autostart-install:success")
      && entries.every((entry) => Object.values(entry.target ?? {}).every((value) => value === null)),
    { actions, targets: entries.map((entry) => entry.target) });
}

// --- no confirmation surface, no CLI ---------------------------------------------------------

{
  const headlessRoot = await fixtureRoot("headless");
  const headless = createGatewayControl({ controllerRoot: headlessRoot, fixture: true, confirm: null });
  const status = await headless.status();
  const refusals = await Promise.all([headless.start(), headless.stop(), headless.recover(),
    headless.setKey({ key: FAKE_KEY }), headless.removeKey(), headless.installAutostart(), headless.uninstallAutostart()]);
  const state = await readFakeState(headlessRoot);
  check("without-a-confirmation-surface-nothing-changes",
    status.ok && status.data.gateway.state === "absent"
      && refusals.every((result) => result.ok === false && result.error.reasonCode === "confirmation_surface_unavailable")
      && state.hasKey !== true && state.lifecycle === undefined,
    { refusals, state });

  const empty = path.join(scratch, "no-cli");
  await mkdir(empty, { recursive: true });
  const { control: missing } = controlFor(empty);
  const missingStatus = await missing.status();
  const missingStart = await missing.start();
  const unavailable = unavailableGatewayControl("local_config_missing");
  const unconfigured = await unavailable.status();
  const unconfiguredStart = await unavailable.start();
  check("a-missing-cli-or-controller-is-named",
    missingStatus.ok && missingStatus.data.cli.available === false
      && missingStatus.data.cli.reasonCode === "agents_factory_cli_missing" && missingStatus.data.gateway === null
      && missingStart.ok === false && missingStart.error.code === "cli_unavailable"
      && missingStart.error.reasonCode === "agents_factory_cli_missing"
      && unconfigured.data.cli.reasonCode === "local_config_missing"
      && unconfiguredStart.error.reasonCode === "local_config_missing",
    { missingStatus, missingStart, unconfigured, unconfiguredStart });
}

// --- project commands, with the Gateway paused -------------------------------------------------
//
// The CLI refuses a project command while the Gateway runs. whileStopped stops
// it, runs the work and starts it again (only if it ran); a stopped Gateway
// stays stopped. Only `project ...` goes through projectCommand, and the pause
// is a change: nothing without a confirmation surface.

{
  const root = await fixtureRoot("pause", { lifecycle: "ready", instanceId: "fixture-gateway-before" });
  const { control, calls } = controlFor(root);
  const out = path.join(root, "package");
  const direct = await control.projectCommand(["project", "unmount", "--project", "alpha", "--out", out, "--confirm", "alpha"]);
  const paused = await control.whileStopped(() => control.projectCommand(["project", "unmount", "--project", "alpha",
    "--out", out, "--confirm", "alpha", "--home-only"]));
  const after = await readFakeState(root);
  const stoppedRoot = await fixtureRoot("pause-stopped", { lifecycle: "stopped" });
  const { control: idle } = controlFor(stoppedRoot);
  const notPaused = await idle.whileStopped(() => idle.projectCommand(["project", "mount", "--package", out]));
  const idleState = await readFakeState(stoppedRoot);
  const foreign = await control.projectCommand(["gateway", "stop"]);
  const headless = createGatewayControl({ controllerRoot: root, fixture: true, confirm: null });
  const refused = await headless.whileStopped(async () => ({ ok: true }));
  check("project-commands-run-with-the-gateway-paused",
    direct.ok === false && direct.error.reasonCode === "gateway_running"
      && paused.ok === true && paused.value.removedFiles === 3
      && paused.gateway.paused === true && paused.gateway.restarted === true
      && after.lifecycle === "ready" && after.projectCalls.length === 1 && after.projectCalls[0].homeOnly === true
      && notPaused.ok === true && notPaused.gateway.paused === false && idleState.lifecycle === "stopped"
      && foreign.ok === false && foreign.error.reasonCode === "project_command_invalid"
      && refused.ok === false && refused.error.reasonCode === "confirmation_surface_unavailable"
      && calls.every((call) => call.args.at(-3) === "--instance" && call.args.at(-1) === "--json"),
    { direct, paused, after, notPaused, idleState, foreign, refused });
}

// --- sync between PCs (block 3) ----------------------------------------------------------------
//
// Only `sync status | take | release` go through syncCommand. Status reads with
// the Gateway running; a take or a release is refused by the CLI while it runs
// and passes with the Gateway paused.

{
  const root = await fixtureRoot("sync", { lifecycle: "ready", instanceId: "fixture-gateway-sync" });
  const { control } = controlFor(root);
  const status = await control.syncCommand(["sync", "status", "--remote"]);
  const direct = await control.syncCommand(["sync", "release", "--confirm", "home"]);
  const paused = await control.whileStopped(() => control.syncCommand(["sync", "release", "--world", "--confirm", "home"]));
  const after = await readFakeState(root);
  const foreign = await control.syncCommand(["project", "mount", "--package", root]);
  const other = await control.syncCommand(["sync", "init", "--confirm", "home"]);
  check("sync-commands-only-sync-and-paused-for-changes",
    status.ok === true && status.value.configured === true && status.value.world.remote.holder === "home"
      && direct.ok === false && direct.error.reasonCode === "gateway_running"
      && paused.ok === true && paused.value.results.at(-1).target === "world" && paused.gateway.paused === true
      && after.sync.worldHolder === null && after.syncCalls.length === 1 && after.syncCalls[0].world === true
      && foreign.ok === false && foreign.error.reasonCode === "sync_command_invalid"
      && other.ok === false && other.error.reasonCode === "sync_command_invalid",
    { status, direct, paused, after, foreign, other });
}

// --- the runner's edges ------------------------------------------------------------------------

{
  const scripts = path.join(scratch, "scripts");
  await mkdir(scripts, { recursive: true });
  const write = async (name, body) => {
    const file = path.join(scripts, name);
    await writeFile(file, body);
    return file;
  };
  const launcher = cliLauncher(null);
  const runScript = (script, extra = {}) => runAgentsFactory({ launcher, script, args: [], cwd: scripts, timeoutMs: 5000, ...extra });

  const echo = await write("echo.mjs", `let t = ""; process.stdin.setEncoding("utf8");
for await (const c of process.stdin) t += c;
process.stdout.write(JSON.stringify({ ok: true, echoed: t }) + "\\n");`);
  const echoed = parseAgentsFactoryOutput(await runScript(echo, { secret: FAKE_KEY }));

  const pretty = await write("pretty.mjs", `process.stdout.write(JSON.stringify({ ok: true, hasKey: false }, null, 2) + "\\n");`);
  const prettyParsed = parseAgentsFactoryOutput(await runScript(pretty));

  const prose = await write("prose.mjs", `process.stdout.write(JSON.stringify({ ok: false, code: "store_failed",
  message: "Could not write C:\\\\Users\\\\someone\\\\key.bin" }) + "\\n"); process.stderr.write("trace at C:\\\\x\\n"); process.exitCode = 1;`);
  const proseParsed = parseAgentsFactoryOutput(await runScript(prose));

  const usage = await write("usage.mjs", `process.stderr.write("usage: agents-factory <group> <command>\\n"); process.exitCode = 2;`);
  const usageParsed = parseAgentsFactoryOutput(await runScript(usage));

  const garbled = await write("garbled.mjs", `process.stdout.write("started\\n");`);
  const garbledParsed = parseAgentsFactoryOutput(await runScript(garbled));

  const slow = await write("slow.mjs", `setTimeout(() => process.stdout.write("{}"), 10000);`);
  const slowParsed = parseAgentsFactoryOutput(await runScript(slow, { timeoutMs: 400 }));

  // A CLI that leaves a background process holding its output pipes (as a
  // Gateway start may): the answer is read when the CLI exits, not when the
  // background process does.
  const holder = await write("holder.mjs", `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"],
  { stdio: "inherit", env: process.env, cwd: ${JSON.stringify(os.tmpdir())} });
child.unref();
process.stdout.write(JSON.stringify({ ok: true, state: "ready" }) + "\\n");`);
  const heldAt = Date.now();
  const heldParsed = parseAgentsFactoryOutput(await runScript(holder));
  const heldMs = Date.now() - heldAt;

  const nowhere = parseAgentsFactoryOutput(await runAgentsFactory({
    launcher: { executable: path.join(scripts, "no-such-node.exe"), env: process.env },
    script: echo, args: [], cwd: scripts, timeoutMs: 2000,
  }));

  check("runner-drops-an-echoed-key-and-keeps-only-codes",
    echoed.ok === false && echoed.error.code === "cli_output_rejected" && echoed.error.reasonCode === "secret_echoed"
      && !JSON.stringify(echoed).includes(FAKE_KEY)
      && prettyParsed.ok === true && prettyParsed.value.hasKey === false
      && proseParsed.ok === false && proseParsed.error.reasonCode === "store_failed" && !JSON.stringify(proseParsed).includes("C:")
      && usageParsed.ok === false && usageParsed.error.reasonCode === "agents_factory_arguments_rejected"
      && garbledParsed.ok === false && garbledParsed.error.code === "cli_response_invalid" && garbledParsed.error.uncertain === true
      && slowParsed.ok === false && slowParsed.error.reasonCode === "timeout" && slowParsed.error.uncertain === true
      && heldParsed.ok === true && heldParsed.value.state === "ready" && heldMs < 2500
      && nowhere.ok === false && nowhere.error.reasonCode === "spawn_failed" && nowhere.error.uncertain === false,
    { echoed, prettyParsed, proseParsed, usageParsed, garbledParsed, slowParsed, heldParsed, heldMs, nowhere });
}

// --- the channels and the bridge ---------------------------------------------------------------

{
  const seen = [];
  const fakeControl = {
    status: async () => ({ ok: true, data: { supported: true } }),
    setKey: async (input) => {
      seen.push(Object.keys(input).join());
      return { ok: true, data: { hasKey: true } };
    },
  };
  const channels = createChannels({ session: { mode: "live", gatewayControl: fakeControl }, appVersion: "0" });
  const set = await channels["atlas:api-key-set"]({ key: FAKE_KEY, path: "C:/elsewhere", executable: "cmd.exe" });
  const bare = createChannels({ session: { mode: "direct" }, appVersion: "0" });
  const unsupported = await bare["atlas:gateway-start"]({});
  const bridge = await readFile(path.join(PROJECT_ROOT, "src", "preload", "bridge.cjs"), "utf8");
  const names = ["atlas:gateway-status", "atlas:gateway-start", "atlas:gateway-stop", "atlas:gateway-recover",
    "atlas:api-key-status", "atlas:api-key-set", "atlas:api-key-remove",
    "atlas:autostart-status", "atlas:autostart-install", "atlas:autostart-uninstall"];
  const missing = names.filter((name) => !CHANNEL_NAMES.includes(name) || !bridge.includes(`"${name}"`)
    || typeof channels[name] !== "function");
  check("channels-pass-only-the-key-and-modes-without-control-say-so",
    set.ok && JSON.stringify(set.data) === JSON.stringify({ hasKey: true }) && seen.join("|") === "key"
      && unsupported.ok === false && unsupported.error.code === "unsupported_in_mode"
      && unsupported.error.reasonCode === "direct" && missing.length === 0,
    { set, seen, unsupported, missing });
}

// --- the fixture session ------------------------------------------------------------------------

{
  const session = await createSession({
    projectRoot: PROJECT_ROOT, mode: "dev-fixture", confirm: async () => false, chooseDirectory: async () => null,
  });
  const status = await session.gatewayControl.status();
  const headless = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
  const refused = await headless.gatewayControl.start();
  check("fixture-session-runs-the-fake-cli-and-only-it",
    status.ok && status.data.cli.source === "fixture" && status.data.gateway?.state === "absent"
      && refused.ok === false && refused.error.reasonCode === "confirmation_surface_unavailable",
    { status, refused });
}

// --- what the panel shows -------------------------------------------------------------------------

{
  const view = panel.gatewayPanelView;
  const status = (gateway, extra = {}) => ({ supported: true, cli: { available: true, source: "controller" },
    action: null, gateway, error: null, ...extra });
  const enabled = (result) => ["start", "stop", "recover"].filter((name) => result.buttons[name].enabled).join();
  const running = view({ status: status({ state: "running", lifecycle: "ready", reasonCode: "gateway_ready", instanceId: "gw-1" }),
    key: { hasKey: true }, autostart: { installed: true } });
  const absent = view({ status: status({ state: "absent", lifecycle: null, reasonCode: "status_missing", instanceId: null }),
    key: { hasKey: false }, autostart: { installed: false } });
  const stale = view({ status: status({ state: "stale", lifecycle: "ready", reasonCode: "gateway_stale", instanceId: "gw-1" }) });
  const unread = view({ status: status(null, { error: { code: "cli_unavailable", reasonCode: "timeout" } }) });
  const starting = view({ status: status({ state: "starting", lifecycle: "starting", reasonCode: "gateway_transitioning" }),
    pending: { kind: "gateway-start", since: 1_000 }, now: 8_500 });
  const hostAction = view({ status: status({ state: "starting", lifecycle: "starting", reasonCode: "gateway_transitioning" },
    { action: { kind: "gateway-start", startedAtUtc: "2026-10-20T10:00:00.000Z" } }),
  now: Date.parse("2026-10-20T10:00:03.000Z") });
  const failed = view({ status: status({ state: "stopped", lifecycle: "stopped", reasonCode: "stopped" }),
    failure: { kind: "gateway-start", code: "cli_failed", reasonCode: "gateway_start_timeout" } });
  const uncertain = view({ status: status({ state: "stopped" }), failure: { kind: "gateway-start", code: "cli_unavailable",
    reasonCode: "timeout", uncertain: true } });
  const declined = view({ status: status({ state: "running" }), failure: { kind: "autostart-install", code: "user_declined" } });
  const noCli = view({ status: { supported: true, cli: { available: false, source: null, reasonCode: "agents_factory_cli_missing" },
    action: null, gateway: null, error: null } });
  const replacing = view({ status: status({ state: "running" }), key: { hasKey: true }, keyFormOpen: true });
  const hidden = view({ status: { supported: false } });
  check("panel-buttons-follow-the-state-and-progress-shows-the-start",
    enabled(running) === "stop" && enabled(absent) === "start" && enabled(stale) === "start,stop,recover"
      && enabled(unread) === "start,stop,recover" && enabled(starting) === "" && enabled(noCli) === ""
      && running.gateway.title === "Gateway: running" && running.gateway.chip === "gateway_ready"
      && absent.gateway.title === "Gateway: never started"
      && starting.buttons.start.label === "Starting…" && starting.progress === "Starting… 7 s · lifecycle starting"
      && hostAction.busy === true && hostAction.progress === "Starting… 3 s · lifecycle starting",
    { running: enabled(running), absent: enabled(absent), stale: enabled(stale), starting, hostAction: hostAction.progress });
  check("panel-shows-the-exact-code-of-a-failure",
    failed.failure.lead === "Gateway not started" && failed.failure.code === "gateway_start_timeout" && failed.failure.uncertain === false
      && uncertain.failure.uncertain === true && declined.failure === null
      && noCli.gateway.chip === "agents_factory_cli_missing" && noCli.gateway.detail.includes("agents-factory")
      && unread.gateway.detail === "State not read: timeout.",
    { failed: failed.failure, uncertain: uncertain.failure, noCli: noCli.gateway, unread: unread.gateway });
  check("panel-key-and-autostart-rows",
    running.key.chip === "saved" && running.key.form === false && running.key.actions === true
      && absent.key.chip === "not set" && absent.key.form === true && absent.key.cancel === false
      && replacing.key.form === true && replacing.key.cancel === true && replacing.key.actions === false
      && running.autostart.checked === true && absent.autostart.checked === false && absent.autostart.enabled === true
      && starting.autostart.enabled === false && starting.key.enabled === false
      && running.cliLine === "agents-factory CLI: from the controller" && hidden.visible === false,
    { running: running.key, absent: absent.key, replacing: replacing.key });
  const panelSource = await readFile(path.join(PROJECT_ROOT, "src", "renderer", "gateway-panel.js"), "utf8");
  check("panel-field-is-masked-and-the-key-is-never-kept",
    panelSource.includes('input.type = "password"') && panelSource.includes('input.autocomplete = "off"')
      && /setApiKey\(\{ key: takeKey\(\) \}\)/u.test(panelSource)
      && !/panelState\.\w+\s*=\s*[^;]*input\.value/u.test(panelSource)
      && !/(localStorage|sessionStorage|writeUiState)/u.test(panelSource),
    "gateway-panel.js");
}

// --- the panel in a stand-in document: the key leaves the field once ------------------------------
//
// No window is started (another Electron would disturb the UI pack): the panel's
// own code runs against a minimal document and a recorded bridge.

{
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.className = "";
      this.dataset = {};
      this.listeners = {};
      this.disabled = false;
      this.value = "";
      this.type = "";
      this.checked = false;
      this.attributes = {};
    }
    get classList() {
      const names = () => new Set(this.className.split(/\s+/u).filter(Boolean));
      const store = (set) => { this.className = [...set].join(" "); };
      return {
        toggle: (name, force) => {
          const set = names();
          if (force ?? !set.has(name)) set.add(name); else set.delete(name);
          store(set);
        },
        add: (name) => store(names().add(name)),
        contains: (name) => names().has(name),
      };
    }
    append(...nodes) { this.children.push(...nodes.map((node) => (typeof node === "string" ? { textContent: node } : node))); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    set textContent(value) { this.children = [{ textContent: String(value) }]; }
    get textContent() { return this.children.map((child) => child.textContent).join(""); }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    dispatch(type, extra = {}) { for (const handler of this.listeners[type] ?? []) handler({ preventDefault() {}, ...extra }); }
    click() {
      if (this.disabled) return;
      if (this.type === "checkbox") {
        this.checked = !this.checked;
        this.dispatch("change");
      } else this.dispatch("click");
    }
    focus() {}
    setAttribute(name, value) { this.attributes[name] = value; }
    find(name) {
      if (this.dataset?.gateway === name) return this;
      for (const child of this.children) {
        const found = child instanceof Node ? child.find(name) : null;
        if (found !== null) return found;
      }
      return null;
    }
  }
  const host = new Node("div");
  host.className = "gateway-panel hidden";
  const readiness = new Node("aside");
  const document = {
    createElement: (tag) => new Node(tag),
    getElementById: (name) => (name === "gatewayPanel" ? host : name === "readinessPanel" ? readiness : null),
  };
  const sent = [];
  const logged = [];
  let refreshes = 0;
  let gateway = { state: "absent", availability: "unavailable", lifecycle: null, reasonCode: "status_missing", instanceId: null };
  let hasKey = false;
  let installed = false;
  let nextStart = null;
  let answerInstall = true;
  const statusData = () => ({ supported: true, cli: { available: true, source: "fixture", reasonCode: null },
    action: null, gateway, error: null });
  const atlas = {
    gatewayStatus: async (payload) => { sent.push(["gatewayStatus", payload]); return { ok: true, data: statusData() }; },
    apiKeyStatus: async () => ({ ok: true, data: { hasKey } }),
    autostartStatus: async () => ({ ok: true, data: { installed } }),
    setApiKey: async (payload) => {
      sent.push(["setApiKey", payload]);
      hasKey = true;
      return { ok: true, data: { hasKey } };
    },
    gatewayStart: () => new Promise((resolve) => { nextStart = resolve; }),
    gatewayStop: async () => ({ ok: true, data: { state: "stopped" } }),
    gatewayRecover: async () => ({ ok: true, data: { state: "unchanged" } }),
    removeApiKey: async () => ({ ok: true, data: { hasKey: false } }),
    installAutostart: async () => {
      if (!answerInstall) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
      installed = true;
      return { ok: true, data: { installed } };
    },
    uninstallAutostart: async () => ({ ok: true, data: { installed: false } }),
  };
  const atlasState = { busy: false, connection: { available: false } };
  const context = vm.createContext({
    document, window: { atlas }, atlasState, setTimeout, clearTimeout, setInterval, clearInterval,
    atlasRecord: (kind, what, detail) => logged.push({ kind, what, detail }),
    refresh: async () => { refreshes += 1; atlasState.connection = { available: gateway.state === "running" }; },
  });
  // As the window loads them: the words first (English: the keys), then the panel.
  vm.runInContext(await readFile(path.join(PROJECT_ROOT, "src", "renderer", "i18n-core.js"), "utf8"), context);
  vm.runInContext(await readFile(path.join(PROJECT_ROOT, "src", "renderer", "gateway-panel.js"), "utf8"), context);
  const until = async (test, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await new Promise((done) => setTimeout(done, 20));
    }
    return false;
  };
  const part = (name) => host.find(name);
  const text = (name) => part(name)?.textContent ?? "";

  context.atlasGatewayPanelOpen();
  await until(() => text("key-chip") === "not set");
  const opened = { hidden: host.classList.contains("hidden"), title: text("gateway-title"),
    start: part("start").disabled, stop: part("stop").disabled, form: part("key-input") !== null };

  const input = part("key-input");
  input.value = FAKE_KEY;
  part("key-save").click();
  const clearedAtOnce = input.value === "";
  await until(() => text("key-chip") === "saved");
  const keyPayloads = sent.filter(([name]) => name === "setApiKey").map(([, payload]) => payload);

  part("start").click();
  const progress = text("progress");
  const startDisabledWhileRunning = part("start").disabled && part("stop").disabled && part("key-replace").disabled;
  gateway = { state: "running", availability: "available", lifecycle: "ready", reasonCode: "gateway_ready", instanceId: "gw-1" };
  nextStart({ ok: true, data: { state: "ready", instanceId: "gw-1" } });
  await until(() => text("gateway-title") === "Gateway: running" && refreshes > 0 && atlasState.connection.available);
  const afterStart = { title: text("gateway-title"), start: part("start").disabled, stop: part("stop").disabled,
    progressHidden: part("progress").classList.contains("hidden"), refreshes };

  part("start").disabled = false;
  part("start").click();
  nextStart({ ok: false, error: { code: "cli_failed", reasonCode: "gateway_start_timeout", exitCode: 1 } });
  await until(() => text("failure").includes("gateway_start_timeout"));
  const failure = text("failure");

  answerInstall = false;
  part("autostart").click();
  await until(() => logged.some((entry) => entry.detail === "undone"));
  const declinedChecked = part("autostart").checked;
  answerInstall = true;
  part("autostart").click();
  await until(() => part("autostart").checked && !part("autostart").disabled);
  await until(() => !text("progress"));

  const everything = JSON.stringify({ tree: host.textContent, logged, statusCalls: sent.filter(([name]) => name !== "setApiKey") });
  check("panel-in-a-document-sends-the-key-once-and-keeps-nothing",
    opened.hidden === false && opened.title === "Gateway: never started" && opened.start === false && opened.stop === true
      && opened.form && input.type === "password" && clearedAtOnce
      && keyPayloads.length === 1 && JSON.stringify(keyPayloads[0]) === JSON.stringify({ key: FAKE_KEY })
      && !everything.includes(FAKE_KEY)
      && progress.startsWith("Starting… 0 s") && startDisabledWhileRunning
      && afterStart.title === "Gateway: running" && afterStart.start === true && afterStart.stop === false
      && afterStart.progressHidden && afterStart.refreshes > 0
      && failure === "Gateway not started: gateway_start_timeout"
      && declinedChecked === false && part("autostart").checked === true
      && logged.some((entry) => entry.what === "Gateway started" && entry.detail === "ready · gw-1")
      && logged.some((entry) => entry.what === "API key saved" && entry.detail === "")
      && logged.some((entry) => entry.what === "Gateway not started" && entry.detail === "gateway_start_timeout")
      && logged.some((entry) => entry.what === "Gateway autostart on"),
    { opened, clearedAtOnce, keyPayloads: keyPayloads.length, progress, startDisabledWhileRunning, afterStart, failure,
      declinedChecked, logged });
}

await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "gateway-control",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

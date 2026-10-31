// DEVELOPMENT ONLY. A stand-in for the agents-factory CLI (stage 0, workstream B).
//
// It answers the commands Atlas runs - gateway status|start|stop|recover,
// key status|set|remove, service status|install|uninstall, project
// unmount|mount, sync status|take|release, each with
// --instance <folder> --json - in the documented shape: one JSON object on
// stdout, {ok: true, ...} or {ok: false, code, message}, exit 0 / 1 / 2. The
// fields follow backend/orchestrator/src/agents-factory-*.mjs as of 2026-10-20
// (a subset: what Atlas reads, and a little more); the real CLI is the contract.
// Its whole world is one state file in the instance folder: no process is
// started, no key is stored (only the fact that one was given), nothing is
// installed.
//
// Fixture rules, so every panel state can be shown:
//   - `gateway start` passes through "starting" for `startDelayMs` before "ready";
//     like the real one it needs no key (`apiKeySource` says where one came from);
//   - `fail` in the state file maps "group command" to a code to fail with, and
//     `failOnce` does the same for the next run only (the --dev-fixture window
//     starts with one failed start, to show how a failure looks);
//   - lifecycle "stale" stands for a Gateway whose process is gone;
//   - project commands refuse while the Gateway starts or runs (gateway_running),
//     as the real ones do, and are recorded in `projectCalls`; nothing is moved;
//   - sync: this PC is "home"; `sync` in the state file holds who has the world and
//     the fixture projects; take and release refuse while the Gateway runs, want
//     --confirm home and are recorded in `syncCalls`.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// The same path as FAKE_AGENTS_FACTORY_STATE in dev-agents-factory.mjs: this
// file is copied into a controller folder and run there, so it imports nothing.
const STATE_RELATIVE = path.join(".project-local", "atlas-dev-agents-factory.json");
const INITIAL_STATE = Object.freeze({
  lifecycle: null, instanceId: null, hasKey: false, serviceInstalled: false, startDelayMs: 1500,
  fail: {}, failOnce: {},
});

const COMMANDS = Object.freeze({
  gateway: ["status", "start", "stop", "recover"],
  key: ["status", "set", "remove"],
  service: ["status", "install", "uninstall"],
  project: ["unmount", "mount"],
  sync: ["status", "take", "release"],
});
const PROJECT_VALUES = Object.freeze(["--project", "--out", "--confirm", "--package"]);
const SYNC_MACHINES = Object.freeze({ home: { title: "Home", home: true }, office: { title: "Office", home: false } });
const SYNC_INITIAL = Object.freeze({ worldHolder: "home", projects: {
  "atlas-dev-fixture": { holder: "home", mounted: true, homeOnly: false },
  "atlas-dev-fixture-home": { holder: "home", mounted: true, homeOnly: true },
  "atlas-dev-fixture-office": { holder: null, mounted: false, homeOnly: false },
} });

class Refusal extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const [group, command, ...tokens] = argv;
  if (!Object.hasOwn(COMMANDS, group ?? "") || !COMMANDS[group].includes(command)) {
    throw new Refusal("invalid_arguments", 2);
  }
  const options = { json: false, instance: null };
  const project = {};
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "--json") options.json = true;
    else if (tokens[index] === "--instance" && index + 1 < tokens.length) options.instance = tokens[index += 1];
    else if (group === "sync" && ["--project", "--confirm"].includes(tokens[index]) && index + 1 < tokens.length) {
      project[tokens[index].slice(2)] = tokens[index += 1];
    } else if (group === "sync" && ["--world", "--remote"].includes(tokens[index])) project[tokens[index].slice(2)] = true;
    else if (group === "project" && PROJECT_VALUES.includes(tokens[index]) && index + 1 < tokens.length) {
      project[tokens[index].slice(2)] = tokens[index += 1];
    } else if (group === "project" && tokens[index] === "--home-only") project.homeOnly = true;
    else throw new Refusal("invalid_arguments", 2);
  }
  if (!options.json || options.instance === null) throw new Refusal("invalid_arguments", 2);
  return { group, command, instance: path.resolve(options.instance), project };
}

async function readState(statePath) {
  try {
    return { ...INITIAL_STATE, ...JSON.parse(await readFile(statePath, "utf8")) };
  } catch {
    return { ...INITIAL_STATE };
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function gatewayStatus(state) {
  const now = new Date().toISOString();
  if (state.lifecycle === null) return { availability: "unavailable", reasonCode: "status_missing" };
  if (state.lifecycle === "starting") {
    return { availability: "available", reasonCode: "gateway_transitioning", ready: false,
      lifecycle: "starting", instanceId: state.instanceId, heartbeatAtUtc: now };
  }
  if (state.lifecycle === "ready") {
    return { availability: "available", reasonCode: "gateway_ready", ready: true,
      lifecycle: "ready", instanceId: state.instanceId, heartbeatAtUtc: now };
  }
  if (state.lifecycle === "stale") {
    return { availability: "stale", reasonCode: "gateway_stale", lifecycle: "ready", instanceId: state.instanceId };
  }
  return { availability: "terminal", reasonCode: state.lifecycle, lifecycle: state.lifecycle,
    instanceId: state.instanceId };
}

async function run() {
  const { group, command, instance, project } = parseArguments(process.argv.slice(2));
  const statePath = path.join(instance, STATE_RELATIVE);
  const state = await readState(statePath);
  const name = `${group} ${command}`;
  const failWith = state.fail?.[name];
  if (typeof failWith === "string") throw new Refusal(failWith);
  const failOnce = state.failOnce?.[name];
  if (typeof failOnce === "string") {
    const rest = { ...state.failOnce };
    delete rest[name];
    await writeState(statePath, { ...state, failOnce: rest });
    throw new Refusal(failOnce);
  }

  if (group === "gateway" && command === "status") return gatewayStatus(state);
  if (group === "gateway" && command === "start") {
    if (state.lifecycle === "ready") {
      return { command: "gateway start", state: "ready", launched: false, instanceId: state.instanceId,
        provider: null, apiKeySource: null };
    }
    const instanceId = `fixture-gateway-${randomUUID()}`;
    await writeState(statePath, { ...state, lifecycle: "starting", instanceId });
    await new Promise((done) => setTimeout(done, Math.max(0, Number(state.startDelayMs) || 0)));
    await writeState(statePath, { ...(await readState(statePath)), lifecycle: "ready", instanceId });
    return { command: "gateway start", state: "ready", launched: true, recovered: state.lifecycle === "stale",
      instanceId, processId: process.pid, monitorId: `fixture-monitor-${randomUUID()}`, provider: "claude",
      apiKeySource: state.hasKey ? "key-store" : "none", ...(state.hasKey ? {} : { apiKeyReasonCode: "key_not_stored" }) };
  }
  if (group === "gateway" && command === "stop") {
    if (!["starting", "ready", "stale"].includes(state.lifecycle)) {
      return { command: "gateway stop", state: state.lifecycle === null ? "absent" : "already-terminal",
        instanceId: state.instanceId, lifecycle: state.lifecycle };
    }
    await writeState(statePath, { ...state, lifecycle: "stopped" });
    return { command: "gateway stop", state: "stopped", instanceId: state.instanceId, lifecycle: "stopped" };
  }
  if (group === "gateway" && command === "recover") {
    if (state.lifecycle === null) {
      return { command: "gateway recover", state: "absent", restartAllowed: true, changed: false };
    }
    if (["starting", "ready"].includes(state.lifecycle)) throw new Refusal("gateway_recovery_process_alive");
    if (state.lifecycle !== "stale") {
      return { command: "gateway recover", state: state.lifecycle, instanceId: state.instanceId,
        restartAllowed: true, changed: false };
    }
    await writeState(statePath, { ...state, lifecycle: "failed" });
    return { command: "gateway recover", state: "failed", instanceId: state.instanceId,
      restartAllowed: true, changed: true };
  }

  if (group === "project") {
    if (["starting", "ready"].includes(state.lifecycle)) throw new Refusal("gateway_running");
    await writeState(statePath, { ...state, projectCalls: [...(state.projectCalls ?? []), { command, ...project }] });
    if (command === "unmount") {
      if (project.confirm !== project.project) throw new Refusal("unmount_confirmation_required");
      return { command: "project unmount", projectId: project.project, package: project.out, revision: 1,
        removedFiles: 3, tasksIndexed: 0 };
    }
    return { command: "project mount", projectId: "fixture-mounted", folder: "fixture-mounted", scopes: 2,
      documents: 1, conversations: 0, entries: 0, files: { written: 3, identical: 0 }, workspace: "bound" };
  }

  if (group === "sync") {
    const sync = structuredClone(state.sync ?? SYNC_INITIAL);
    const view = () => ({ command: "sync status", configured: true, machine: { machineId: "home", ...SYNC_MACHINES.home },
      machines: SYNC_MACHINES, world: { held: sync.worldHolder === "home",
        remote: project.remote ? { reachable: true, initialized: true, holder: sync.worldHolder } : null },
      projects: Object.entries(sync.projects).map(([projectId, item]) => ({ projectId, configured: true, mounted: item.mounted,
        held: item.holder === "home", policy: { homeOnly: item.homeOnly, allowedMachines: null }, mayHold: true,
        onlyHere: item.homeOnly, remote: project.remote ? { reachable: true, initialized: true, holder: item.holder } : null })) });
    if (command === "status") return view();
    if (["starting", "ready"].includes(state.lifecycle)) throw new Refusal("gateway_running");
    if (project.confirm !== "home") throw new Refusal("invalid_arguments", 2);
    const results = [];
    const targets = project.world ? [] : project.project ? [project.project] : Object.keys(sync.projects);
    if (command === "release") {
      for (const projectId of targets) {
        const item = sync.projects[projectId];
        if (item === undefined || !item.mounted) continue;
        if (item.homeOnly) results.push({ target: projectId, action: "backed-up" });
        else { item.mounted = false; item.holder = null; results.push({ target: projectId, action: "released" }); }
      }
      if (project.world || !project.project) { sync.worldHolder = null; results.push({ target: "world", action: "released" }); }
    } else {
      if (project.world || !project.project) {
        if (sync.worldHolder !== null && sync.worldHolder !== "home") throw new Refusal("sync_held_elsewhere");
        sync.worldHolder = "home"; results.push({ target: "world", action: "taken" });
      }
      for (const projectId of targets) {
        const item = sync.projects[projectId];
        if (item === undefined || (item.holder !== null && item.holder !== "home")) continue;
        results.push({ target: projectId, action: item.mounted ? "already-mounted" : "taken" });
        item.mounted = true; item.holder = "home";
      }
    }
    await writeState(statePath, { ...state, sync, syncCalls: [...(state.syncCalls ?? []), { command, ...project }] });
    return { command: `sync ${command}`, results, skipped: [], stayLocal: [] };
  }

  if (group === "key" && command === "status") {
    return { command: "key status", hasKey: state.hasKey === true, store: "fixture", environmentOverride: false };
  }
  if (group === "key" && command === "set") {
    // The key is read, checked for being there, and dropped: the fixture keeps
    // only that one was given. It is never written and never printed.
    if (!/^[A-Za-z0-9_\-.:+/=]{16,512}$/u.test((await readStdin()).trim())) throw new Refusal("key_invalid");
    await writeState(statePath, { ...state, hasKey: true });
    return { command: "key set", stored: true, store: "fixture" };
  }
  if (group === "key" && command === "remove") {
    await writeState(statePath, { ...state, hasKey: false });
    return { command: "key remove", removed: state.hasKey === true, store: "fixture" };
  }

  const service = { platform: process.platform, mechanism: "fixture", name: "AgentsFactory-Gateway-fixture" };
  if (group === "service" && command === "status") {
    return { command: "service status", ...service, installed: state.serviceInstalled === true };
  }
  if (group === "service" && command === "install") {
    await writeState(statePath, { ...state, serviceInstalled: true });
    return { command: "service install", ...service, installed: true, activatesAt: "next-logon" };
  }
  await writeState(statePath, { ...state, serviceInstalled: false });
  return { command: "service uninstall", ...service, removed: state.serviceInstalled === true };
}

run().then((value) => {
  process.stdout.write(`${JSON.stringify({ ok: true, ...value })}\n`);
}, (error) => {
  const code = error instanceof Refusal ? error.code : "fixture_failed";
  process.stdout.write(`${JSON.stringify({ ok: false, code, message: `fixture: ${code}` })}\n`);
  process.exitCode = error instanceof Refusal ? error.exitCode : 1;
});

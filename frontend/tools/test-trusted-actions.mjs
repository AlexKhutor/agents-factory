// Regression test for the trusted host actions, against the fixture CLI.
//
// It runs the real module - real spawn, real argument array, real input file
// inside a controller root - and checks the behaviour the delivery requires:
// a declined confirmation writes nothing, a stale revision is a conflict rather
// than an overwrite, and the same edit returns its original receipt instead of
// being applied twice.

import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustedActions } from "../src/host/trusted-actions.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];

function check(caseId, condition, detail) {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
}

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-trusted-test-"));
  const runtime = path.join(root, ".orchestrator", "runtime");
  await mkdir(runtime, { recursive: true });
  await mkdir(path.join(root, ".project-local"), { recursive: true });
  await copyFile(
    path.join(PROJECT_ROOT, "src", "dev", "fake-gateway-cli.mjs"),
    path.join(runtime, "application-gateway-cli.mjs"),
  );
  return root;
}

function actionsFor(root, { answer = true, folder = null, gateway = null } = {}) {
  const asked = [];
  const purposes = [];
  const actions = createTrustedActions({
    config: {
      controllerRoot: root,
      gatewayCli: {
        nodeExecutable: "node",
        scriptRelativePath: ".orchestrator/runtime/application-gateway-cli.mjs",
      },
    },
    confirm: async (request) => { asked.push(request); return answer; },
    chooseDirectory: async (purpose) => { purposes.push(purpose); return folder; },
    gateway,
  });
  return { actions, asked, purposes };
}

const root = await createRoot();
const entries = [{ id: "rules", title: "Rules", text: "First version." }];

// 1. A declined confirmation must not write.
{
  const { actions, asked } = actionsFor(root, { answer: false });
  const declined = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  check("declined-confirmation-writes-nothing",
    declined.ok === false && declined.error.code === "user_declined" && asked.length === 1,
    declined);
}

// 2. A confirmed edit writes once and returns a receipt.
let firstReceipt = null;
{
  const { actions } = actionsFor(root);
  const saved = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  firstReceipt = saved.ok ? saved.data.response : null;
  check("confirmed-edit-is-written",
    saved.ok === true && firstReceipt.status === "written" && firstReceipt.revision === 2
      && saved.data.identity.operationId.startsWith("atlas-memory-"),
    saved);
}

// 2a. A CLI failure keeps the diagnostics the CLI reported - bounded, by name -
//     and says null, not false or 0, for what it did not report. A free-text
//     reason is not carried: only a token-like reason code is.
//     The fixture CLI's diagnostic failure is a model of the backend's
//     announced output (R5 in docs/backend-requirements-20260923.md), not a
//     confirmed contract.
{
  const { actions } = actionsFor(root);
  const failed = await actions.saveMemoryEdit({
    scopeId: "atlas-dev-fixture-cli-diagnostic", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  const error = failed.ok ? null : failed.error;
  check("cli-failure-keeps-its-diagnostics",
    failed.ok === false && error.code === "cli_failed" && error.reasonCode === "store_write_failed"
      && typeof error.diagnosticId === "string" && error.diagnosticId.startsWith("fixture-diagnostic-")
      && error.diagnosticPersisted === true && error.phase === "execution"
      && error.reason === "fixture_simulated" && typeof failed.identity?.operationId === "string",
    failed);

  const prose = await actions.saveMemoryEdit({
    scopeId: "atlas-dev-fixture-cli-prose", expectedRevision: 1, entries, actorId: "atlas-test",
  });
  const plain = prose.ok ? null : prose.error;
  check("cli-failure-without-diagnostics-is-null-not-false",
    prose.ok === false && plain.code === "cli_failed"
      && plain.diagnosticId === null && plain.diagnosticPersisted === null && plain.phase === null
      && plain.reason === null && plain.reasonOmitted === true
      && !JSON.stringify(plain).includes("C:\\"),
    prose);
}

// 3. Writing again against the old revision is a conflict, not an overwrite.
{
  const { actions } = actionsFor(root);
  const stale = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 1,
    entries: [{ id: "rules", title: "Rules", text: "Conflicting version." }], actorId: "atlas-test",
  });
  check("stale-revision-is-a-conflict",
    stale.ok === false && stale.error.reasonCode === "stale_revision"
      && typeof stale.identity.operationId === "string",
    stale);
}

// 4. Input validation happens before any confirmation is shown.
{
  const { actions, asked } = actionsFor(root);
  const tooMany = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 2,
    entries: Array.from({ length: 65 }, (_, index) => ({ id: `e${index}`, title: "x", text: "y" })),
    actorId: "atlas-test",
  });
  const badScope = await actions.saveMemoryEdit({
    scopeId: "../escape", expectedRevision: 2, entries, actorId: "atlas-test",
  });
  const missingId = await actions.saveMemoryEdit({
    scopeId: "test-scope", expectedRevision: 2,
    entries: [{ title: "Rules", text: "No identity." }], actorId: "atlas-test",
  });
  check("invalid-input-never-reaches-a-confirmation",
    tooMany.ok === false && tooMany.error.reasonCode === "entries_too_many"
      && badScope.ok === false && badScope.error.reasonCode === "scope_id_invalid"
      && missingId.ok === false && missingId.error.reasonCode === "entry_id_invalid"
      && asked.length === 0,
    { tooMany, badScope, missingId, asked: asked.length });
}

// 5. The renderer cannot supply a path: binding needs a selection from the picker.
{
  const { actions } = actionsFor(root, { folder: null });
  const withoutSelection = await actions.bindWorkspace({
    projectId: "test-project", selectionId: "made-up",
  });
  check("binding-requires-a-host-side-selection",
    withoutSelection.ok === false && withoutSelection.error.reasonCode === "selection_unknown",
    withoutSelection);
}

// 6. A chosen folder binds once, and binding again replays the same fingerprint.
{
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const { actions } = actionsFor(root, { folder: workspace });
  const chosen = await actions.chooseWorkspace();
  const bound = await actions.bindWorkspace({
    projectId: "test-project", selectionId: chosen.data.selectionId,
  });
  const secondChoice = await actions.chooseWorkspace();
  const again = await actions.bindWorkspace({
    projectId: "test-project", selectionId: secondChoice.data.selectionId,
  });
  check("folder-binding-is-confirmed-and-idempotent",
    bound.ok === true && bound.data.response.status === "bound"
      && again.ok === true && again.data.response.replay === true
      && bound.data.response.workspaceFingerprint === again.data.response.workspaceFingerprint
      && chosen.data.displayPath === workspace,
    { bound, again });
}

// 6b. The window learns which folder a project works in, without a
// confirmation; binding a bound project to another folder names the refusal.
{
  const other = path.join(root, "other-workspace");
  await mkdir(other, { recursive: true });
  const { actions, asked } = actionsFor(root, { folder: other });
  const unbound = await actions.readProjectFolder({ projectId: "never-bound" });
  const bound = await actions.readProjectFolder({ projectId: "test-project" });
  const chosen = await actions.chooseWorkspace();
  const refused = await actions.bindWorkspace({ projectId: "test-project", selectionId: chosen.data.selectionId });
  const invalidId = await actions.readProjectFolder({ projectId: "../escape" });
  check("project-folder-is-readable-and-a-second-folder-is-refused",
    unbound.ok === true && unbound.data.configured === false
      && bound.ok === true && bound.data.configured === true && bound.data.available === true
      && bound.data.workspacePath === path.join(root, "workspace")
      && refused.ok === false && refused.error.reasonCode === "memory_workspace_conflict"
      && invalidId.ok === false && asked.length === 1,
    { unbound, bound, refused, invalidId, asked: asked.length });
}

// 6c. A project without quarters and agents moves to another folder after the
// person confirms both folders; a project with them is refused by name.
{
  const other = path.join(root, "other-workspace");
  const { actions, asked } = actionsFor(root, { folder: other });
  const chosen = await actions.chooseWorkspace();
  const moved = await actions.rebindWorkspace({ projectId: "test-project", selectionId: chosen.data.selectionId });
  const after = await actions.readProjectFolder({ projectId: "test-project" });
  const busyChoice = await actions.chooseWorkspace();
  const busy = await actions.rebindWorkspace({ projectId: "atlas-dev-fixture-busy-project", selectionId: busyChoice.data.selectionId });
  const stale = await actions.rebindWorkspace({ projectId: "test-project", selectionId: chosen.data.selectionId });
  check("empty-project-moves-to-another-folder-after-confirmation",
    moved.ok === true && moved.data.response.changed === true
      && after.ok === true && after.data.workspacePath === other
      && busy.ok === false && busy.error.reasonCode === "memory_workspace_in_use"
      && stale.ok === false && asked.length === 2
      && asked[0].detail.includes(path.join(root, "workspace")) && asked[0].detail.includes(other),
    { moved, after, busy, stale, asked });
}

// 6c-2. Plan R36: a project whose agents worked moves with its sessions, which
// needs the Gateway stopped. The first try is refused (gateway_running); the
// same rebind runs again inside the Gateway control's pause, and the answer
// says the Gateway was paused. Without a Gateway control the refusal stays.
{
  const statusFile = path.join(root, ".project-local", "application-gateway", "status.v1.json");
  await mkdir(path.dirname(statusFile), { recursive: true });
  await writeFile(statusFile, JSON.stringify({ terminal: false }));
  const target = path.join(root, "worked-new");
  await mkdir(target, { recursive: true });
  const pauses = [];
  const gateway = {
    projectCommand: async () => ({ ok: false, error: { code: "unexpected" } }),
    whileStopped: async (work) => {
      pauses.push("stop");
      await writeFile(statusFile, JSON.stringify({ terminal: true }));
      try {
        return { ...(await work()), gateway: { paused: true, restarted: true } };
      } finally {
        await writeFile(statusFile, JSON.stringify({ terminal: false }));
        pauses.push("start");
      }
    },
  };
  const { actions, asked } = actionsFor(root, { folder: target, gateway });
  const chosen = await actions.chooseWorkspace();
  const moved = await actions.rebindWorkspace({ projectId: "atlas-dev-fixture-worked-project", selectionId: chosen.data.selectionId });
  const { actions: plain } = actionsFor(root, { folder: target });
  const again = await plain.chooseWorkspace();
  const refused = await plain.rebindWorkspace({ projectId: "atlas-dev-fixture-worked-project", selectionId: again.data.selectionId });
  check("worked-project-rebinds-with-the-gateway-paused",
    moved.ok === true && moved.data.gateway?.paused === true && pauses.join() === "stop,start"
      && asked.length === 1 && asked[0].detail.includes("move with the binding") && asked[0].detail.includes(target)
      && refused.ok === false && refused.error.reasonCode === "gateway_running",
    { moved, pauses, refused, asked: asked.map((item) => item.detail) });
  await rm(path.dirname(statusFile), { recursive: true, force: true });
}

// 6c-2b. An uncertain send is checked only after the person confirms, always
// with the Gateway paused (the backend refuses a running one); the answer says
// whether the message went, and the cause the backend recorded.
{
  const statusFile = path.join(root, ".project-local", "application-gateway", "status.v1.json");
  await mkdir(path.dirname(statusFile), { recursive: true });
  await writeFile(statusFile, JSON.stringify({ terminal: false }));
  const pauses = [];
  const gateway = {
    projectCommand: async () => ({ ok: false, error: { code: "unexpected" } }),
    whileStopped: async (work) => {
      pauses.push("stop");
      await writeFile(statusFile, JSON.stringify({ terminal: true }));
      try {
        return { ...(await work()), gateway: { paused: true, restarted: true } };
      } finally {
        await writeFile(statusFile, JSON.stringify({ terminal: false }));
        pauses.push("start");
      }
    },
  };
  const { actions, asked } = actionsFor(root, { gateway });
  const freed = await actions.settleSend({ agentId: "agent-1", operationId: "atlas-send-1" });
  const went = await actions.settleSend({ agentId: "agent-1", operationId: "atlas-send-2-went" });
  const { actions: declining } = actionsFor(root, { gateway, answer: false });
  const declined = await declining.settleSend({ agentId: "agent-1", operationId: "atlas-send-3" });
  const bad = await actions.settleSend({ agentId: "agent 1", operationId: "atlas-send-4" });
  check("uncertain-send-is-settled-with-the-gateway-paused",
    freed.ok === true && freed.data.went === false && freed.data.operationState === "failed"
      && freed.data.causeCode === "claude_journal_unavailable" && freed.data.gateway?.paused === true
      && went.ok === true && went.data.went === true && went.data.operationState === "completed"
      && pauses.join() === "stop,start,stop,start" && asked.length === 2 && asked[0].detail.includes("session journal")
      && declined.ok === false && declined.error.code === "user_declined"
      && bad.ok === false,
    { freed, went, declined, bad, pauses });
  await rm(path.dirname(statusFile), { recursive: true, force: true });
}

// 6c-2c. Sync between PCs (block 3): status reads; a release names in its
// confirmation what leaves, what is backed up and what stays local, runs with
// the Gateway paused and does not start it; a take of the world starts it.
{
  const view = { ok: true, value: { configured: true, machine: { machineId: "home", title: "Home", home: true },
    machines: { home: { title: "Home", home: true }, office: { title: "Office", home: false } },
    world: { held: true, remote: { reachable: true, initialized: true, holder: "home" } },
    projects: [
      { projectId: "open", configured: true, mounted: true, held: true, policy: { homeOnly: false }, mayHold: true, onlyHere: false },
      { projectId: "inzoi", configured: true, mounted: true, held: true, policy: { homeOnly: true }, mayHold: true, onlyHere: true },
      { projectId: "scratch", configured: false, mounted: true, held: false, policy: { homeOnly: false }, mayHold: true, onlyHere: false },
    ] } };
  const calls = [];
  const gateway = {
    projectCommand: async () => ({ ok: false, error: { code: "unexpected" } }),
    syncCommand: async (args) => {
      calls.push(args);
      if (args[1] === "status") return view;
      return { ok: true, value: { results: [{ target: "world", action: args[1] === "take" ? "taken" : "released" }], skipped: [], stayLocal: [] } };
    },
    whileStopped: async (work) => ({ ...(await work()), gateway: { paused: false, restarted: false } }),
    start: async () => { calls.push(["gateway", "start"]); return { ok: true }; },
  };
  const { actions, asked } = actionsFor(root, { gateway });
  const status = await actions.syncStatus({ remote: true });
  const released = await actions.syncRelease({ target: "all" });
  const taken = await actions.syncTake({ target: "world" });
  const { actions: declining } = actionsFor(root, { gateway, answer: false });
  const declined = await declining.syncRelease({ target: "open" });
  const bad = await actions.syncTake({ target: "no such project" });
  const changes = calls.filter((args) => args[1] !== "status");
  check("sync-confirms-what-goes-where-and-starts-the-gateway-after-a-world-take",
    status.ok === true && status.data.projects.find((item) => item.projectId === "inzoi").onlyHere === true
      && released.ok === true && taken.ok === true && taken.data.gateway.started === true
      && asked[0].detail.includes("open") && asked[0].detail.includes("inzoi") && asked[0].detail.includes("scratch")
      && asked[0].detail.includes("does not start") && asked[1].message.includes("\"Home\"")
      && changes.length === 3 && changes[0].join(" ") === "sync release --confirm home"
      && changes[1].join(" ") === "sync take --world --confirm home" && changes[2].join(" ") === "gateway start"
      && declined.ok === false && declined.error.code === "user_declined"
      && bad.ok === false,
    { status, released, taken, declined, bad, calls, asked: asked.map((item) => item.detail) });
  // The mode (plan 5.1): an older CLI that names none is synced when configured; a local instance shows nothing more.
  const { actions: local } = actionsFor(root, { gateway: { ...gateway,
    syncCommand: async () => ({ ok: true, value: { configured: true, mode: "local" } }) } });
  const localStatus = await local.syncStatus();
  check("sync-status-says-the-mode",
    status.data.mode === "synced" && localStatus.ok === true && localStatus.data.mode === "local"
      && localStatus.data.configured === true && localStatus.data.world === undefined,
    { mode: status.data.mode, localStatus });
}

// 6c-3. Projects not on this PC. A single instance lists none (split: false)
// and refuses to take one off without asking. In a split instance the list
// comes from the memory CLI; taking a project off and bringing it back run the
// agents-factory command inside the Gateway pause, after the person confirmed
// the project and the package folder. The package path is not in the answer.
{
  const packageDir = path.join(root, "package-alpha");
  await mkdir(packageDir, { recursive: true });
  const commands = [];
  const gateway = {
    projectCommand: async (args) => {
      commands.push(args);
      return args[1] === "unmount"
        ? { ok: true, value: { projectId: "alpha", revision: 3, removedFiles: 7, tasksIndexed: 1, package: packageDir } }
        : { ok: true, value: { projectId: "alpha", folder: "alpha", scopes: 2, conversations: 1, workspace: "missing" } };
    },
    whileStopped: async (work) => ({ ...(await work()), gateway: { paused: true, restarted: true } }),
  };
  const { actions, asked, purposes } = actionsFor(root, { folder: packageDir, gateway });
  const single = await actions.listAwayProjects();
  const chosen = await actions.chooseWorkspace({ purpose: "package" });
  const singleRefused = await actions.unmountProject({ projectId: "alpha", selectionId: chosen.data.selectionId });
  const singleCommands = commands.length;
  const singleAsked = asked.length;
  const marker = path.join(root, ".project-local", "projects", "store-layout.v1.json");
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, layout: "split" }));
  const statePath = path.join(root, ".project-local", "atlas-dev-cli-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, JSON.stringify({ ...state,
    thisMachine: { machineId: "office", title: "Office", home: false },
    machines: { office: { title: "Office", home: false }, home: { title: "Home", home: true } },
    worldProjects: {
      home: { title: "Home", archived: false, here: false, policy: { homeOnly: true, allowedMachines: null },
        location: { machineId: "home", atUtc: "2026-10-26T10:00:00.000Z" },
        summary: { agents: 2, quarters: 1, tasksOpen: 1, lastActivityUtc: "2026-10-26T09:00:00.000Z" } },
      alpha: { title: "Alpha", archived: false, here: true, policy: { homeOnly: false, allowedMachines: null }, location: null, summary: null },
    } }));
  const away = await actions.listAwayProjects();
  // Stricter: only this PC, without asking. Looser: asked first, and a "no" keeps it.
  const stricter = await actions.setProjectPolicy({ projectId: "alpha", choice: "this-pc" });
  const askedAfterStricter = asked.length;
  const { actions: declining, asked: declinedAsk } = actionsFor(root, { answer: false, gateway });
  const looser = await declining.setProjectPolicy({ projectId: "alpha", choice: "anywhere" });
  const kept = JSON.parse(await readFile(statePath, "utf8")).worldProjects.alpha.policy;
  const world = await actions.unmountProject({ projectId: "world", selectionId: chosen.data.selectionId });
  const badChoice = await actions.unmountProject({ projectId: "alpha", selectionId: chosen.data.selectionId, choice: "nowhere" });
  const unmounted = await actions.unmountProject({ projectId: "alpha", selectionId: chosen.data.selectionId, choice: "home" });
  const recorded = JSON.parse(await readFile(statePath, "utf8")).worldProjects.alpha.policy;
  check("where-a-project-may-be-kept",
    stricter.ok === true && stricter.data.changed === true && askedAfterStricter === 0
      && JSON.stringify(kept) === JSON.stringify({ homeOnly: false, allowedMachines: ["office"] })
      && looser.ok === false && looser.error.code === "user_declined" && declinedAsk.length === 1
      && declinedAsk[0].detail.includes("only on PC: Office")
      && badChoice.ok === false && badChoice.error.reasonCode === "policy_choice_invalid"
      && JSON.stringify(recorded) === JSON.stringify({ homeOnly: true, allowedMachines: null }),
    { stricter, looser, kept, badChoice, recorded, declined: declinedAsk.map((item) => item.detail) });
  await writeFile(path.join(packageDir, "project.af.json"), JSON.stringify({ projectId: "alpha", title: "Alpha" }));
  const pick = await actions.chooseWorkspace({ purpose: "package" });
  const wrong = await actions.mountProject({ selectionId: pick.data.selectionId, projectId: "beta" });
  const mounted = await actions.mountProject({ selectionId: pick.data.selectionId, projectId: "alpha" });
  check("single-instance-has-no-projects-away",
    single.ok === true && single.data.split === false && single.data.projects.length === 0
      && singleRefused.ok === false && singleRefused.error.reasonCode === "store_layout_single" && singleCommands === 0 && singleAsked === 0,
    { single, singleRefused });
  check("project-goes-off-this-pc-and-back-through-the-gateway-pause",
    away.ok === true && away.data.split === true && away.data.projects.length === 1 && away.data.known.length === 2
      && away.data.thisMachine.title === "Office"
      && away.data.projects[0].projectId === "home" && away.data.projects[0].policy.homeOnly === true
      && away.data.projects[0].location.title === "Home" && away.data.projects[0].summary.agents === 2
      && world.ok === false && world.error.reasonCode === "project_id_invalid"
      && unmounted.ok === true && unmounted.data.removedFiles === 7 && unmounted.data.gateway.paused === true
      && JSON.stringify(commands[0]) === JSON.stringify(["project", "unmount", "--project", "alpha", "--out", packageDir,
        "--confirm", "alpha"])
      && !JSON.stringify(unmounted).includes("package-alpha")
      && asked[0].detail.includes(packageDir) && asked[0].detail.includes("home only")
      && asked[0].detail.includes("was: only on PC: Office")
      && wrong.ok === false && wrong.error.reasonCode === "package_other_project"
      && mounted.ok === true && mounted.data.projectId === "alpha" && mounted.data.workspace === "missing"
      && JSON.stringify(commands[1]) === JSON.stringify(["project", "mount", "--package", packageDir])
      && asked.length === 2 && asked[1].message.includes("alpha") && purposes.every((item) => item === "package"),
    { away, world, unmounted, wrong, mounted, commands, asked: asked.map((item) => item.message) });
  await rm(path.dirname(marker), { recursive: true, force: true });
}

// 6d. An agent's permission mode: "bypass" only after the person confirms, the
// others at once; a declined bypass changes nothing; the read names each own mode.
{
  const { actions: declining, asked: declinedAsk } = actionsFor(root, { answer: false });
  const declined = await declining.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "bypassPermissions" });
  const { actions, asked } = actionsFor(root);
  const before = await actions.readPermissionModes();
  const auto = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "auto" });
  const bypass = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "bypassPermissions" });
  const after = await actions.readPermissionModes();
  const invalid = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: "yolo" });
  const reset = await actions.setAgentPermissionMode({ agentId: "agent-mode", permissionMode: null });
  const cleared = await actions.readPermissionModes();
  check("permission-mode-bypass-asks-first-others-do-not",
    declined.ok === false && declined.error.code === "user_declined" && declinedAsk.length === 1
      && before.ok === true && before.data.defaultMode === "acceptEdits" && before.data.agents.length === 0
      && auto.ok === true && auto.data.permissionMode === "auto" && auto.data.changed === true
      && bypass.ok === true && bypass.data.permissionMode === "bypassPermissions" && asked.length === 1
      && after.data.agents.some((item) => item.agentId === "agent-mode" && item.permissionMode === "bypassPermissions")
      && invalid.ok === false && invalid.error.reasonCode === "permission_mode_invalid"
      && reset.ok === true && reset.data.permissionMode === null && cleared.data.agents.length === 0,
    { declined, before, auto, bypass, after, invalid, reset, cleared, asked });
}

// 6e. A memory document: the preview names what it writes; the approval shows
// it in the confirmation and approves exactly that hash; declined writes nothing.
{
  const { actions: declining } = actionsFor(root, { answer: false });
  const declined = await declining.approveMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md",
    target: "project", apply: true });
  const { actions, asked } = actionsFor(root);
  const preview = await actions.previewMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md", target: "project" });
  const approved = await actions.approveMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md",
    target: "project", apply: false });
  const written = await actions.approveMemoryDocument({ agentId: "agent-doc", path: "docs/memory/project.md",
    target: { kind: "project" }, apply: true });
  const missing = await actions.previewMemoryDocument({ agentId: "agent-doc", path: "docs/memory/missing.md", target: "agent" });
  const outside = await actions.previewMemoryDocument({ agentId: "agent-doc", path: "../secret.md", target: "agent" });
  check("memory-document-preview-then-approve-exactly-it",
    declined.ok === false && declined.error.code === "user_declined"
      && preview.ok === true && preview.data.entries.map((entry) => entry.title).join() === "Goal,Rules"
      && /^[a-f0-9]{64}$/.test(preview.data.contentSha256) && preview.data.target.revision === 1
      && approved.ok === true && approved.data.applied === false
      && written.ok === true && written.data.applied === true && written.data.revision === 2
      && asked.length === 2 && asked[0].message.includes("docs/memory/project.md") && asked[0].detail.includes("· Goal")
      && missing.ok === false && missing.error.reasonCode === "memory_document_missing"
      && outside.ok === false && outside.error.reasonCode === "document_path_invalid",
    { declined, preview, approved, written, missing, outside, asked });
}

// 6f. The agent's commits: none while the folder is not under git; the folder becomes
// a repository only after the person agreed; then the agent's commits are listed.
{
  const { actions: declining } = actionsFor(root, { answer: false });
  const { actions, asked } = actionsFor(root);
  const before = await actions.readAgentCommits({ agentId: "agent-git" });
  const declined = await declining.initProjectGit({ projectId: "test-project" });
  const stillNot = await actions.readAgentCommits({ agentId: "agent-git" });
  const init = await actions.initProjectGit({ projectId: "test-project" });
  const after = await actions.readAgentCommits({ agentId: "agent-git" });
  check("agent-commits-and-git-init-after-confirmation",
    before.ok === true && before.data.versioned === false && before.data.commits.length === 0
      && declined.ok === false && declined.error.code === "user_declined" && stillNot.data.versioned === false
      && init.ok === true && init.data.initialised === true && asked.length === 1 && asked[0].detail.includes("git init")
      && after.ok === true && after.data.versioned === true && after.data.commits.length === 1
      && after.data.commits[0].subject.startsWith("agent-git: "),
    { before, declined, stillNot, init, after, asked });
}

// 6a. A project is archived only after the person confirms; restoring does not
// ask; the archive lists what was archived; a project with open agents stays.
{
  const declinedRun = actionsFor(root, { answer: false });
  const declined = await declinedRun.actions.archiveProject({ projectId: "atlas-archive-demo" });
  const emptyList = await declinedRun.actions.listArchivedProjects();
  const { actions, asked } = actionsFor(root);
  const archived = await actions.archiveProject({ projectId: "atlas-archive-demo" });
  const listed = await actions.listArchivedProjects();
  const askedBeforeRestore = asked.length;
  const restored = await actions.restoreProject({ projectId: "atlas-archive-demo" });
  const askedByRestore = asked.length - askedBeforeRestore;
  const after = await actions.listArchivedProjects();
  const busy = await actions.archiveProject({ projectId: "atlas-dev-fixture-busy-project" });
  const invalid = await actions.archiveProject({ projectId: "not a project" });
  check("project-archive-is-confirmed-and-restorable",
    declined.ok === false && declined.error.code === "user_declined"
      && emptyList.ok === true && emptyList.data.projects.length === 0
      && archived.ok === true && archived.data.response.archived === true
      && asked[0]?.title === "Archive project"
      && listed.ok === true && listed.data.projects.map((item) => item.projectId).join() === "atlas-archive-demo"
      && restored.ok === true && restored.data.response.changed === true && askedByRestore === 0
      && after.ok === true && after.data.projects.length === 0
      && busy.ok === false && busy.error.code === "cli_failed" && busy.error.reasonCode === "memory_project_has_agents"
      && invalid.ok === false,
    { declined, archived, listed, restored, after, busy, invalid, asked: asked.map((item) => item.title) });
}

// 6b. A quarter is archived the same way: asked first, restored without asking,
// listed in the archive while it is there.
{
  const { actions, asked } = actionsFor(root);
  const archived = await actions.archiveQuarter({ projectId: "atlas-archive-demo", quarterId: "q1" });
  const listed = await actions.listArchivedProjects();
  const askedBefore = asked.length;
  const restored = await actions.restoreQuarter({ projectId: "atlas-archive-demo", quarterId: "q1" });
  const askedByRestore = asked.length - askedBefore;
  const after = await actions.listArchivedProjects();
  const invalid = await actions.archiveQuarter({ projectId: "atlas-archive-demo", quarterId: "not a quarter" });
  check("quarter-archive-is-confirmed-and-restorable",
    archived.ok === true && archived.data.response.archived === true
      && asked[0]?.title === "Archive quarter"
      && listed.ok === true && listed.data.quarters.map((item) => `${item.projectId}/${item.quarterId}`).join()
        === "atlas-archive-demo/q1"
      && restored.ok === true && restored.data.response.changed === true && askedByRestore === 0
      && after.ok === true && after.data.quarters.length === 0
      && invalid.ok === false,
    { archived, listed, restored, after, invalid, asked: asked.map((item) => item.title) });
}

// 6c. The history of changes: archive and restore are recorded; "Undo" asks first,
// with the entry as the backend has it, and reverses the change by a new entry; an
// undone entry and an undo are not undone again; the recipe never reaches the window.
{
  const project = "atlas-history-demo";
  const { actions, asked } = actionsFor(root);
  await actions.archiveProject({ projectId: project });
  await actions.restoreProject({ projectId: project });
  const history = await actions.readActionJournal({ projectId: project });
  const [restored, archived] = history.ok ? history.data.entries : [];
  const { actions: declining } = actionsFor(root, { answer: false });
  const declined = await declining.undoAction({ projectId: project, entryId: restored?.entryId });
  const askedBefore = asked.length;
  const undone = await actions.undoAction({ projectId: project, entryId: restored?.entryId });
  const dialog = asked[askedBefore];
  const after = await actions.readActionJournal({ projectId: project });
  const listed = await actions.listArchivedProjects();
  const again = await actions.undoAction({ projectId: project, entryId: restored?.entryId });
  const ofUndo = await actions.undoAction({ projectId: project, entryId: undone.ok ? undone.data.undo.entryId : "x" });
  const invalid = await actions.undoAction({ projectId: project, entryId: "not-an-entry" });
  check("history-is-read-and-a-change-is-undone-after-confirmation",
    history.ok && history.data.entries.length === 2 && restored.action === "project.restore" && restored.undoable === true
      && !("undo" in restored) && archived.action === "project.archive"
      && declined.ok === false && declined.error.code === "user_declined"
      && undone.ok === true && undone.data.undo.undoes === restored.entryId
      && dialog?.title === "Undo change" && dialog.message.includes("Restored project atlas-history-demo")
      && after.ok && after.data.entries[0].entryId === undone.data.undo.entryId && after.data.entries[1].undoable === false
      && after.data.entries[1].undoneBy === undone.data.undo.entryId
      && listed.ok && listed.data.projects.some((item) => item.projectId === project)
      && again.ok === false && again.error.reasonCode === "journal_not_undoable"
      && ofUndo.ok === false && ofUndo.error.reasonCode === "journal_not_undoable"
      && invalid.ok === false,
    { history, declined, undone, after, again, ofUndo, invalid, dialog });
}

// 6d. Names: renaming does not ask (the ID stays, the history can undo it), the
// names are read back by project, null brings the ID back, an unknown object is
// refused with the backend's code, and the rename is in the history.
{
  const project = "atlas-names-demo";
  const { actions, asked } = actionsFor(root);
  const before = await actions.readNames();
  const named = await actions.renameObject({ projectId: project, kind: "project", objectId: project, name: "  Payment   gateway " });
  const agent = await actions.renameObject({ projectId: project, kind: "agent", objectId: "studio", name: "Nova" });
  const after = await actions.readNames();
  const cleared = await actions.renameObject({ projectId: project, kind: "agent", objectId: "studio", name: null });
  const final = await actions.readNames();
  const missing = await actions.renameObject({ projectId: project, kind: "agent", objectId: "atlas-dev-fixture-missing", name: "x" });
  const invalid = await actions.renameObject({ projectId: project, kind: "user", objectId: "studio", name: "x" });
  const tooLong = await actions.renameObject({ projectId: project, kind: "agent", objectId: "studio", name: "x".repeat(121) });
  const history = await actions.readActionJournal({ projectId: project });
  check("names-are-renamed-read-and-journaled",
    before.ok === true && before.data.projects[project] === undefined
      && named.ok === true && named.data.response.name === "Payment gateway" && agent.ok === true
      && after.ok === true && after.data.projects[project].project === "Payment gateway"
      && after.data.projects[project].agents.studio === "Nova"
      && cleared.ok === true && cleared.data.response.previous === "Nova" && final.data.projects[project].agents.studio === undefined
      && missing.ok === false && missing.error.reasonCode === "name_object_not_found"
      && invalid.ok === false && tooLong.ok === false && asked.length === 0
      && history.ok === true && history.data.entries.filter((entry) => entry.action === "object.rename").length === 3,
    { before, named, after, cleared, final, missing, invalid, tooLong, history, asked });
}

// 6g. The task board is read without asking; an agent becomes a desk agent only
// after the person confirms (the confirmation says it is permanent); a refusal
// keeps its own code; registering again changes nothing.
{
  const { actions: declining, asked: declinedAsk } = actionsFor(root, { answer: false });
  const declined = await declining.registerDeskAgent({ agentId: "mobile-ui-1" });
  const { actions, asked } = actionsFor(root);
  const before = await actions.readTaskBoard();
  const one = await actions.readTaskBoard({ agentId: "core-scheduler-1" });
  const registered = await actions.registerDeskAgent({ agentId: "mobile-ui-1" });
  const again = await actions.registerDeskAgent({ agentId: "mobile-ui-1" });
  const after = await actions.readTaskBoard();
  const conflict = await actions.registerDeskAgent({ agentId: "mobile-ui-3" });
  const closed = await actions.registerDeskAgent({ agentId: "core-watch-1" });
  const invalidId = await actions.registerDeskAgent({ agentId: "not an agent" });
  const stages = new Set(before.ok ? before.data.tasks.map((task) => task.stage) : []);
  check("desk-agent-is-registered-after-confirmation-and-shown-on-the-board",
    declined.ok === false && declined.error.code === "user_declined" && declinedAsk.length === 1
      && declinedAsk[0].detail.includes("The registration is permanent")
      && before.ok === true && !before.data.sources.some((item) => item.agentId === "mobile-ui-1")
      && ["dispatched", "started", "accepted", "planned", "in-progress", "reported", "accepted-by-code", "declined"]
        .every((stage) => stages.has(stage))
      && one.ok === true && one.data.tasks.length > 0 && one.data.tasks.every((task) => task.agentId === "core-scheduler-1")
      && registered.ok === true && registered.data.status === "registered" && registered.data.sourceId === "desk-mobile-ui-1"
      && again.ok === true && again.data.status === "already-registered"
      && after.ok === true && after.data.sources.some((item) => item.agentId === "mobile-ui-1" && item.valid)
      && conflict.ok === false && conflict.error.code === "cli_failed" && conflict.error.reasonCode === "desk_source_binding_conflict"
      && closed.ok === false && closed.error.reasonCode === "memory_agent_closed"
      && invalidId.ok === false && invalidId.error.reasonCode === "agent_id_invalid"
      && asked.length === 4 && asked.every((item) => item.title === "Take tasks (desk agent)"),
    { declined, registered, again, conflict, closed, invalidId, asked: asked.map((item) => item.title),
      sources: after.data?.sources });
}

// 6h. The world lead in one confirmed flow: the person confirms once (the
// controller folder and the role are named), the world project is bound to
// the controller root, and the coordinator role is given only with that
// confirmation's flowId, to that agent, once.
{
  const { actions: declining } = actionsFor(root, { answer: false });
  const declined = await declining.prepareWorldLead({ agentId: "world-lead-test" });
  const unbound = await declining.readProjectFolder({ projectId: "world" });
  const { actions, asked } = actionsFor(root);
  const prepared = await actions.prepareWorldLead({ agentId: "world-lead-test", model: "claude-sonnet-5-5" });
  const bound = await actions.readProjectFolder({ projectId: "world" });
  const controllerRoot = await realpath(root);
  const noFlow = await actions.assignWorldLead({ agentId: "world-lead-test", flowId: "made-up", expectedRevision: 0 });
  const otherAgent = await actions.assignWorldLead({ agentId: "someone-else", flowId: prepared.data?.flowId,
    expectedRevision: 0 });
  const assigned = await actions.assignWorldLead({ agentId: "world-lead-test", flowId: prepared.data?.flowId,
    expectedRevision: 0 });
  const reused = await actions.assignWorldLead({ agentId: "world-lead-test", flowId: prepared.data?.flowId,
    expectedRevision: 1 });
  const again = await actions.prepareWorldLead({ agentId: "world-lead-test" });
  check("world-lead-one-confirmation-binds-the-controller-root-and-gives-the-role-once",
    declined.ok === false && declined.error.code === "user_declined"
      && unbound.ok === true && unbound.data.configured === false
      && prepared.ok === true && prepared.data.newlyBound === true && typeof prepared.data.flowId === "string"
      && prepared.data.projectId === "world" && prepared.data.quarterId === "hq"
      && asked[0].title === "World lead" && asked[0].detail.includes(controllerRoot)
      && asked[0].detail.includes("The binding is permanent") && asked[0].detail.includes("claude-sonnet-5-5")
      && bound.ok === true && bound.data.configured === true && bound.data.workspacePath === controllerRoot
      && noFlow.ok === false && noFlow.error.code === "world_flow_expired"
      && otherAgent.ok === false && otherAgent.error.code === "world_flow_expired"
      && assigned.ok === true && assigned.data.role === "coordinator" && assigned.data.revision === 1
      && reused.ok === false && reused.error.code === "world_flow_expired"
      && again.ok === true && again.data.newlyBound === false && asked[1].detail.includes("already bound"),
    { declined, unbound, prepared, bound, noFlow, otherAgent, assigned, reused, again, asked });
}

// 6i. A world project bound to another folder is refused before asking anything.
{
  const otherRoot = await createRoot();
  const elsewhere = path.join(otherRoot, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  const { actions, asked } = actionsFor(otherRoot, { folder: elsewhere });
  const chosen = await actions.chooseWorkspace();
  await actions.bindWorkspace({ projectId: "world", selectionId: chosen.data.selectionId });
  const askedBefore = asked.length;
  const refused = await actions.prepareWorldLead({ agentId: "world-lead-test" });
  check("world-project-bound-elsewhere-is-refused-without-asking",
    refused.ok === false && refused.error.code === "world_folder_conflict" && asked.length === askedBefore,
    { refused, asked: asked.map((item) => item.title) });
  await rm(otherRoot, { recursive: true, force: true });
}

// 7. No input file is left behind in the controller's private directory.
{
  const remaining = await readdir(path.join(root, ".project-local", "atlas-input"))
    .catch(() => []);
  check("input-files-are-removed", remaining.length === 0, remaining);
}

await rm(root, { recursive: true, force: true });

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "trusted-actions",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

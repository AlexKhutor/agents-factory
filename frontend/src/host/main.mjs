// Electron main process: the trusted host.
//
// The window it creates has no Node integration, no filesystem and no network
// path to the gateway. Everything it can do is the channel list in ipc.mjs.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { resolveMode } from "./config.mjs";
import { createSession } from "./session.mjs";
import { createInstanceLayoutStore } from "./layout-split.mjs";
import { createLayoutStore } from "./layout-store.mjs";
import { createUiStateStore } from "./ui-state.mjs";
import { createTurnSeenStore } from "./turn-seen.mjs";
import { createChannels } from "./ipc.mjs";
import { callPath } from "./read-journal.mjs";
import { openConfirmWindow } from "./confirm-window.mjs";
import { currentLocale } from "./i18n.mjs";
import { tx } from "./i18n.mjs";

const HOST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HOST_DIRECTORY, "..", "..");
const PRELOAD = path.join(PROJECT_ROOT, "src", "preload", "bridge.cjs");
const RENDERER = path.join(PROJECT_ROOT, "src", "renderer", "index.html");
const CONFIRM_PRELOAD = path.join(PROJECT_ROOT, "src", "preload", "confirm.cjs");
const CONFIRM_PAGE = path.join(PROJECT_ROOT, "src", "renderer", "confirm.html");
const LOCALES = path.join(PROJECT_ROOT, "locales");
const USER_DATA = path.join(PROJECT_ROOT, "user-data");

// The window's language, asked by its preload before any script runs (i18n.mjs). Read each time, so a
// language the person chose applies when the window reloads.
const windowLocale = () => currentLocale({ directory: LOCALES, uiStateFile: path.join(USER_DATA, "ui-state.json"),
  system: app.getLocale() });
ipcMain.on("atlas:locale", (event) => {
  try { event.returnValue = windowLocale(); } catch { event.returnValue = { language: "en", available: ["en"], table: {} }; }
});

/**
 * The application's own version: `projectVersion` in project-version.json,
 * shown without its "v". It is independent of the kit and of every contract
 * version; package.json `version` mirrors it only because npm requires one.
 */
async function appVersion() {
  try {
    const passport = JSON.parse(await readFile(path.join(PROJECT_ROOT, "project-version.json"), "utf8"));
    return String(passport.projectVersion).replace(/^v/u, "");
  } catch {
    return "0.0.0";
  }
}

function registerChannels(channels) {
  for (const [channel, handler] of Object.entries(channels)) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        // The journal says how a call arrived: from the window, or from an
        // unattended capture scene driving it.
        const via = process.argv.includes("--capture") ? "capture" : "ui-ipc";
        return await callPath.run(via, () => handler(payload ?? {}));
      } catch {
        // Host faults never cross the bridge as stacks or messages.
        return { ok: false, error: { code: "host_error", message: channel } };
      }
    });
  }
}

let mainWindow = null;

/**
 * The confirmation surface for trusted actions: a modal drawn by the operating
 * system, outside the page. It bounds what the renderer can do on its own - the
 * page cannot press this button. It is not a defence against automation of the
 * desktop itself, which is a different threat boundary and is not claimed here.
 */
// A fixture capture scene that exercises a confirmed change answers the
// confirmation itself - only with --dev-fixture and --capture together, and only
// for the scenes named here. A live run always asks the person.
const AUTO_CONFIRM_SCENES = Object.freeze(["ui-a17-editor-save-conflict", "ui-a18-copy-with-memory",
  "ui-a19-copy-target-choice", "ui-a26-permission-mode", "ui-a28-tabs-keep-memory-document",
  "ui-a29-agent-commits", "ui-a31-gateway-panel", "ui-a33-world-lead-create", "ui-a34-desk-agent", "ui-a40-history"]);
const autoConfirmed = [];
function autoConfirmScene() {
  if (!process.argv.includes("--dev-fixture") || !process.argv.includes("--capture")) return false;
  const index = process.argv.indexOf("--capture-scene");
  return index !== -1 && AUTO_CONFIRM_SCENES.includes(process.argv[index + 1]);
}

async function confirm({ title, message, detail, confirmLabel }) {
  if (autoConfirmScene()) {
    autoConfirmed.push(title);
    return true;
  }
  // Atlas's own confirmation window (confirm-window.mjs): the main window's page
  // cannot reach it, as it could not reach the system dialog it replaces.
  return openConfirmWindow({
    parent: mainWindow, page: CONFIRM_PAGE, preload: CONFIRM_PRELOAD,
    request: { title, message, detail, confirmLabel },
  });
}

async function chooseDirectory(purpose = "workspace") {
  const options = {
    // A project package: where a project goes when it is taken off this PC, or comes back from.
    title: purpose === "package" ? "Choose the project package folder" : "Choose the existing project folder",
    properties: ["openDirectory"],
    buttonLabel: "Use this folder",
  };
  const { canceled, filePaths } = mainWindow === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  return canceled || filePaths.length === 0 ? null : filePaths[0];
}

/**
 * Where this run's read evidence goes. `--evidence-dir <folder>` names it for an
 * automated check; otherwise the person picks it in a native dialog. Either way
 * the path stays in this process and is checked again by the export itself.
 */
async function chooseEvidenceDirectory() {
  const flag = process.argv.indexOf("--evidence-dir");
  if (flag !== -1) {
    const given = process.argv[flag + 1];
    if (typeof given !== "string" || given.startsWith("--")) {
      return { ok: false, error: { code: "evidence_directory_invalid", reasonCode: "flag_without_folder" } };
    }
    return { ok: true, data: { path: path.resolve(given) } };
  }
  const options = {
    title: "Choose where to write this run's evidence",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Write evidence here",
  };
  const { canceled, filePaths } = mainWindow === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  return canceled || filePaths.length === 0
    ? { ok: true, data: { cancelled: true } }
    : { ok: true, data: { path: filePaths[0] } };
}

/** Writes the window's activity log where the person points a native dialog. */
async function saveText(text, defaultName = null) {
  const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  const json = defaultName !== null && defaultName.endsWith(".json");
  const options = {
    title: json ? "Export the map layout" : "Save the activity log",
    defaultPath: defaultName ?? `atlas-activity-${stamp}.txt`,
    filters: json
      ? [{ name: "JSON", extensions: ["json"] }]
      : [{ name: "Text", extensions: ["txt"] }],
  };
  const { canceled, filePath } = mainWindow === null
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(mainWindow, options);
  if (canceled || !filePath) return { ok: true, data: { saved: false } };
  await writeFile(filePath, text, "utf8");
  // The window learns that it was saved and under what name, not where.
  return { ok: true, data: { saved: true, fileName: path.basename(filePath) } };
}

/** Reads one text file the person picked. Nothing else on disk is reachable. */
async function openText() {
  const options = {
    title: "Import a map layout",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const { canceled, filePaths } = mainWindow === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  if (canceled || filePaths.length === 0) return { ok: true, data: { opened: false } };
  const text = await readFile(filePaths[0], "utf8");
  if (text.length > 1_048_576) {
    return { ok: false, error: { code: "layout_invalid", reasonCode: "too_large" } };
  }
  return { ok: true, data: { opened: true, text, fileName: path.basename(filePaths[0]) } };
}

function createWindow(mode) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#181c19",
    title: mode === "dev-fixture" ? "Agents Factory Atlas - FIXTURE DATA" : mode === "paperclip" ? "Agents Factory Atlas - Paperclip" : mode === "direct" ? "Agents Factory Atlas - Claude Code" : "Agents Factory Atlas",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      // A capture keeps its animation frames even when covered (see --capture below).
      backgroundThrottling: !process.argv.includes("--capture"),
    },
  });
  window.removeMenu();
  window.loadFile(RENDERER);
  mainWindow = window;
  // Closing the window (its X) must also write what is pending - the layout and
  // the view are written a moment after the last move. Without this the window
  // was gone before before-quit could ask it, and the last changes were lost.
  let written = false;
  window.on("close", (event) => {
    if (written || window.webContents.isDestroyed()) return;
    event.preventDefault();
    written = true;
    const close = () => { if (!window.isDestroyed()) window.close(); };
    ipcMain.once("atlas:flushed", close);
    setTimeout(close, 800);
    window.webContents.send("atlas:flush");
  });
  window.on("closed", () => { mainWindow = null; });
  return window;
}

function lockDownNavigation() {
  app.on("web-contents-created", (_event, contents) => {
    // Nothing in this application navigates anywhere, and no page opens a second
    // window (the confirmation window is the host's own, see confirm-window.mjs).
    // An external link, if one ever appears in backend text, goes to the
    // operating system rather than into this renderer.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/**
 * Development aid only, and only alongside --capture: a fixed list of views to
 * photograph. Each entry is a literal snippet, never anything taken from argv.
 */
// One fixture agent's chat, scrolled to its end. The agent id is a literal of this file.
const chatAgentScene = (agentId) => `(async () => {
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents.find((item) => item.agentId === ${JSON.stringify(agentId)}) ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    await new Promise((done) => setTimeout(done, 3000));
    const feed = document.getElementById("chatFeed");
    const answered = document.querySelector(".feed-question.answered");
    if (answered) answered.scrollIntoView({ block: "center" });
    else if (feed) feed.scrollTop = feed.scrollHeight;
    return { agent: a.agentId, questions: document.querySelectorAll(".chat-question").length,
      options: document.querySelectorAll(".chat-option").length, answered: document.querySelectorAll(".feed-question.answered").length };
  })()`;

// PROTOTYPE: the sample chat turn of the "chat-sample" scenes, with its work folded or open.
const chatSampleScene = (open) => `(async () => {
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents[1] ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    await new Promise((done) => setTimeout(done, 2500));
    const ref = (id) => ({ authority: { externalId: id } });
    const item = (n, contentClass, text, extra = {}) => ({ contentClass, text, visibility: "user-visible", omissionReason: null,
      observedAtUtc: new Date().toISOString(), itemRef: ref("sample:" + n), turnRef: ref("sample"), ...extra });
    const answer = [tx("## What was checked"), "", tx("Project and quarter memory can be read, **no errors**. File \`notes.md\` created."), "",
      tx("| Check | Action | Result |"), "| --- | --- | --- |", tx("| Project memory | open “Memory” | \`PASS\` |"),
      tx("| Quarter memory | open “Memory” | \`PASS\` |"), tx("| Second agent | switch | \`NOT RUN\` |"), "",
      tx("1. First step done."), tx("2. Second — *in progress*."), tx("   - nested item"), "", "\`\`\`bash", "git status --short", "\`\`\`", "",
      tx("> So far I have only studied the samples; I have not changed any files.")].join("\\n");
    const items = [
      item(1, "user-message", tx("Check the memory and make a table.")),
      item(2, "tool-summary", "Thinking\\n\\nFirst I will look at what is in the folder, then check the **quarter memory** against what was passed."),
      item(3, "assistant-message", tx("Looking at the project folder.")),
      item(4, "tool-summary", "$ ls -la\\n\\nnotes.md\\nREADME.md"),
      item(5, "change-summary", "Write notes.md\\n\\nFile created"),
      item(6, "omitted", null, { visibility: "omitted", omissionReason: "hidden_reasoning" }),
      item(7, "assistant-message", answer),
      item(8, "tool-summary", "Internal · Paperclip: task status → done"),
    ];
    const turn = { state: "completed", startedAtUtc: "2026-09-30T10:00:00Z", completedAtUtc: "2026-09-30T10:01:11Z" };
    const feed = document.getElementById("chatFeed");
    feed.replaceChildren();
    for (const open of [${open}]) {
      const box = el("section", "feed-turn");
      box.append(el("div", "feed-turn-head", open ? tx("Sample: work expanded") : tx("Sample: work collapsed")));
      for (const segment of liveTurnSegments(items, turn.state)) {
        if (segment.kind === "work") { const work = liveWork(segment.items, turn, false); work.open = open; box.append(work); }
        else box.append(liveRecord(segment.item, { answer: segment.kind === "answer" }));
      }
      feed.append(box);
    }
    feed.scrollTop = 0;
    return { segments: liveTurnSegments(items, turn.state).map((segment) => segment.kind) };
  })()`;

const CAPTURE_SCENES = Object.freeze({
  // Regression pack A1-A8 (tools/test-ui-scenes.mjs): each returns the facts it checked.
  "ui-a1-fit-expand": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    goProject("platform-core"); await settle();
    sceneCompactProject("platform-core");
    const compacted = { ...scene.layout.projects["platform-core"] };
    const coveredAfterCompact = covered("platform-core");
    const start = quarterAt("platform-core", "core-q1");
    pointer("pointerdown", start);
    pointer("pointermove", { x: start.x + 120, y: start.y + 80 });
    pointer("pointermove", { x: start.x + 220, y: start.y + 160 });
    pointer("pointerup", { x: start.x + 220, y: start.y + 160 });
    await pause(200);
    const grown = scene.layout.projects["platform-core"];
    const grew = grown.width > compacted.width || grown.height > compacted.height;
    const coveredAfterDrag = covered("platform-core");
    return { pass: !coveredAfterCompact && grew && !coveredAfterDrag, coveredAfterCompact, grew, coveredAfterDrag }; })()`,
  "ui-a2-world-level": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    goWorld(); await settle();
    const boxes = Object.entries(scene.layout.projects);
    const overlapping = [];
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i][1]; const b = boxes[j][1];
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) overlapping.push(boxes[i][0] + "/" + boxes[j][0]);
    }
    const level = currentLevel();
    return { pass: level === LEVEL.world && overlapping.length === 0, level, overlapping }; })()`,
  "ui-a3-quarter-menu": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    goProject("platform-core"); await settle();
    const at = quarterAt("platform-core", "core-q1");
    scene.canvas.dispatchEvent(new MouseEvent("contextmenu", { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    await pause(150);
    const items = [...document.querySelectorAll("#contextMenu button")].map((button) => button.textContent);
    const enter = [...document.querySelectorAll("#contextMenu button")].find((button) => button.textContent === tx("Enter quarter"));
    const before = { x: scene.camera.x, y: scene.camera.y, scale: scene.camera.scale };
    if (enter) enter.click();
    await settle(); await pause(200);
    const level = currentLevel();
    const still = scene.camera.x === before.x && scene.camera.y === before.y && scene.camera.scale === before.scale;
    const sheet = !document.getElementById("sheet").classList.contains("hidden") && document.getElementById("sheetTitle").textContent.includes("core-q1");
    return { pass: enter !== undefined && still && sheet && level === LEVEL.project, items, scope: { ...scene.scope }, level, still, sheet }; })()`,
  "ui-a4-identifier": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    openCreateScopeSheet("quarter", "platform-core"); await pause(100);
    const input = document.querySelector("#sheetBody input.identifier-input");
    const hint = document.querySelector("#sheetBody .identifier-hint");
    input.value = tx("quarter creation test"); input.dispatchEvent(new Event("input", { bubbles: true }));
    const badShown = hint.classList.contains("bad");
    [...document.querySelectorAll("#sheetBody button")].find((button) => button.textContent === tx("Create")).click();
    await pause(150);
    const refusal = [...document.querySelectorAll("#sheetBody .error")].map((node) => node.textContent).join(" ");
    input.value = "test-quarter"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const goodShown = !hint.classList.contains("bad");
    return { pass: badShown && refusal.includes(tx("Does not match the format")) && goodShown, badShown, refusal, goodShown }; })()`,
  "ui-a5-zoom-closes-workspace": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "platform-core", quarterId: "core-q1", agentId: "core-scheduler-1" });
    await settle(); await pause(200);
    const openBefore = isWorkspaceOpen();
    goWorld(); await settle(); await pause(200);
    const level = currentLevel();
    return { pass: openBefore && !isWorkspaceOpen() && level === LEVEL.world, openBefore, openAfter: isWorkspaceOpen(), level }; })()`,
  "ui-a6-switch-agent": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "platform-core", quarterId: "core-q1", agentId: "core-scheduler-1" });
    await settle(); await pause(300);
    const at = agentAt("platform-core", "core-q1", "core-scheduler-2");
    const cameraBefore = { ...scene.target };
    pointer("pointerdown", at); pointer("pointerup", at);
    await pause(300);
    // A single click on another agent closes the open window and selects it; the camera stays.
    const afterClick = workspaceState.node ? workspaceState.node.agentId : null;
    const selected = scene.selection?.agentId ?? null;
    const cameraStayed = Math.abs(scene.target.x - cameraBefore.x) < 0.5 && Math.abs(scene.target.scale - cameraBefore.scale) < 0.001;
    // A double click opens the other agent's window.
    scene.canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    await pause(300);
    const afterDouble = workspaceState.node ? workspaceState.node.agentId : null;
    return { pass: afterClick === null && selected === "core-scheduler-2" && cameraStayed
      && afterDouble === "core-scheduler-2", afterClick, selected, cameraStayed, afterDouble }; })()`,
  "ui-a7-sheet-inspector": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    goProject("platform-core"); await settle();
    selectNode({ kind: "project", projectId: "platform-core", quarterId: null, agentId: null });
    await pause(150);
    const inspectorBefore = !document.getElementById("inspector").classList.contains("hidden");
    await openMemorySheet("platform-core-memory", tx("Project memory · platform-core"));
    const inspectorAfter = !document.getElementById("inspector").classList.contains("hidden");
    const sheet = !document.getElementById("sheet").classList.contains("hidden");
    return { pass: inspectorBefore && !inspectorAfter && sheet, inspectorBefore, inspectorAfter, sheet }; })()`,
  "ui-a8-archived-send": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "data-pipeline", quarterId: "data-q2", agentId: "data-enrich-1" });
    await settle(); await pause(400);
    const send = document.getElementById("chatSend");
    const reason = document.getElementById("chatSendReason");
    const disabled = send !== null && send.disabled;
    const reasonText = reason ? reason.textContent : "";
    document.querySelector(".chat-compose textarea").value = tx("check");
    send.disabled = false; send.click(); await pause(300);
    const refusal = [...document.querySelectorAll(".chat-result .error")].map((node) => node.textContent).join(" ");
    return { pass: disabled && reasonText.includes(tx("archived")) && refusal.includes(tx("archived")), disabled, reasonText, refusal }; })()`,
  "ui-a9-live-chat": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "data-pipeline", quarterId: "data-q1", agentId: "data-ingest-1" });
    const ready = await until(() => workspaceState.live !== null && workspaceState.live.data !== null && document.querySelectorAll("#chatFeed .feed-message").length > 0, 8000);
    const status = document.getElementById("chatStatus").textContent;
    const gaps = [...document.querySelectorAll("#chatFeed .feed-gap, #chatFeed .feed-service, #chatFeed .feed-thinking.hidden-text")].map((node) => node.textContent).join(" ");
    const turns = document.querySelectorAll("#chatFeed .feed-turn").length;
    return { pass: ready && workspaceState.chatSource === "live" && status.includes(tx("live")) && status.includes(tx("on events")) && gaps.includes(tx("the provider did not pass")) && turns === 3, ready, source: workspaceState.chatSource, status, gaps, turns }; })()`,
  "ui-a10-archive-and-unavailable": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "data-pipeline", quarterId: "data-q2", agentId: "data-enrich-1" });
    const archived = await until(() => workspaceState.chatSource === "archive" && workspaceState.feed !== null && workspaceState.feed.readAt !== null, 8000);
    const archivedStatus = document.getElementById("chatStatus").textContent;
    const archivedMessages = document.querySelectorAll("#chatFeed .feed-message").length;
    closeWorkspace(); await settle();
    atlasOpenWorkspace({ kind: "agent", projectId: "platform-core", quarterId: "core-q3", agentId: "core-watch-1" });
    const failed = await until(() => workspaceState.live !== null && workspaceState.live.data !== null && workspaceState.feed !== null && workspaceState.feed.readAt !== null, 8000);
    const failedStatus = document.getElementById("chatStatus").textContent;
    return { pass: archived && archivedStatus.includes(tx("main::archived")) && archivedMessages > 0 && failed && workspaceState.chatSource === "archive" && failedStatus.includes(tx("the provider is unavailable right now")), archived, archivedStatus, archivedMessages, failed, failedStatus }; })()`,
  "ui-a11-project-files": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "data-pipeline", quarterId: "data-q1", agentId: "data-ingest-1" }, { tab: "files" });
    const listed = await until(() => workspaceState.files !== null && workspaceState.files.listing !== null, 6000);
    const find = (label) => [...document.querySelectorAll(".file-row button, .workspace-body button")].find((node) => node.textContent === label);
    find("logs/").click();
    const inLogs = await until(() => !workspaceState.files.loading && workspaceState.files.listing !== null && workspaceState.files.listing.path === "logs", 6000);
    find("drain-trace.log").click();
    const read = await until(() => workspaceState.files.file !== null && !workspaceState.files.file.loading && workspaceState.files.file.pages.length === 1, 6000);
    const firstPage = document.querySelector(".file-text").textContent.length;
    find(tx("Next 64 KB")).click();
    const second = await until(() => !workspaceState.files.file.loading && workspaceState.files.file.pages.length === 2, 6000);
    const shown = document.querySelector(".workspace-body").textContent;
    return { pass: listed && inLogs && read && firstPage === 65536 && second && shown.includes(tx("shown")) && shown.includes(tx("Folders are not walked on their own")), listed, inLogs, read, firstPage, second }; })()`,
  "ui-a12-artifacts": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "data-pipeline", quarterId: "data-q1", agentId: "data-ingest-1" }, { tab: "artifacts" });
    const listed = await until(() => workspaceState.artifacts !== null && workspaceState.artifacts.catalog !== null, 6000);
    const openNext = () => [...document.querySelectorAll(".workspace-body .entry button")].find((node) => node.textContent === tx("Open"));
    const settled = (count) => until(() => workspaceState.artifacts.opened.size === count && [...workspaceState.artifacts.opened.values()].every((item) => !item.loading), 6000);
    openNext().click(); const one = await settled(1);
    openNext().click(); const two = await settled(2);
    const body = document.querySelector(".workspace-body").textContent;
    const texts = document.querySelectorAll(".workspace-body pre.file-text").length;
    return { pass: listed && one && two && body.includes(tx("matches the registered hash")) && body.includes(tx("changed after registration")) && texts === 1 && body.includes(tx("not the whole work result")), listed, one, two, texts }; })()`,
  "ui-a13-attention-profile": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "platform-core", quarterId: "core-q2", agentId: "core-storage-2" }, { tab: "tasks" });
    await settle(); await pause(300);
    const tasks = document.querySelector(".workspace-body").textContent;
    workspaceState.tab = "context"; renderWorkspace();
    const context = document.querySelector(".workspace-body").textContent;
    closeWorkspace(); await settle();
    const recovery = (atlasState.world.attention || []).some((item) => item.kind === "recovery" && item.agentId === "core-scheduler-2");
    atlasOpenAttention(null); await pause(200);
    const panel = document.getElementById("attentionList").textContent;
    return { pass: tasks.includes(tx("no data")) && tasks.includes(tx("not reported by the catalog")) && !tasks.includes(tx("questions waiting0")) && context.includes(tx("Requested profile")) && context.includes(tx("denied")) && context.includes(tx("does not report")) && recovery && panel.includes(tx("recovery")), recovery, tasksHasNoData: tasks.includes(tx("no data")) }; })()`,
  "ui-a14-paste-mode": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    selectNode({ kind: "project", projectId: "data-pipeline", quarterId: null, agentId: null });
    atlasCopyBlueprint(); atlasPasteBlueprint(); await pause(200);
    const sheet = document.getElementById("sheetBody");
    const run = [...sheet.querySelectorAll("button")].find((node) => node.textContent === tx("Create with confirmation"));
    const before = run.disabled;
    const waitingForMode = sheet.textContent.includes(tx("Choose what to copy"));
    const radios = [...sheet.querySelectorAll("input[name=pasteMode]")];
    const checkedBefore = radios.some((radio) => radio.checked);
    radios[0].checked = true; radios[0].dispatchEvent(new Event("change")); await pause(100);
    const after = run.disabled;
    const steps = [...sheet.querySelectorAll(".entry-text")].map((node) => node.textContent).join(" | ");
    return { pass: before && waitingForMode && !checkedBefore && !after && !steps.includes(tx("agent ")) && steps.includes(tx("project")) && sheet.textContent.includes(tx("Agents in the blueprint")), before, waitingForMode, checkedBefore, after, steps }; })()`,
  "ui-a15-file-search-edit-blocked": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "data-pipeline", quarterId: "data-q1", agentId: "data-ingest-1" }, { tab: "files" });
    await until(() => workspaceState.files !== null && workspaceState.files.listing !== null, 6000);
    const find = (label) => [...document.querySelectorAll(".workspace-body button")].find((node) => node.textContent === label);
    find("logs/").click();
    await until(() => !workspaceState.files.loading && workspaceState.files.listing !== null && workspaceState.files.listing.path === "logs", 6000);
    find("drain-trace.log").click();
    await until(() => workspaceState.files.file !== null && !workspaceState.files.file.loading && workspaceState.files.file.pages.length === 1, 6000);
    const field = document.querySelector(".file-search input");
    field.value = "state=empty"; field.dispatchEvent(new Event("input"));
    const summary = field.parentElement.nextElementSibling.textContent;
    const edit = find(tx("Edit"));
    const editReason = edit ? edit.title : "";
    find(tx("Next 64 KB")).click();
    const second = await until(() => !workspaceState.files.file.loading && workspaceState.files.file.pages.length === 2 && workspaceState.files.file.error === null, 6000);
    return { pass: summary.startsWith(tx("Found")) && summary.includes(tx("loaded")) && edit !== undefined && edit.disabled && editReason.includes(tx("the whole file")) && second, summary, editDisabled: edit ? edit.disabled : null, editReason, second }; })()`,
  "ui-a16-unconfigured-controller": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    await until(() => typeof atlasState !== "undefined" && atlasState.info !== null && atlasState.connection !== null, 8000);
    renderHeader();
    const chip = document.getElementById("connectionChip");
    atlasOpenReadiness(); await pause(300);
    const readiness = document.getElementById("readinessBody").textContent;
    const shown = chip.textContent + " " + chip.title + " " + readiness;
    const slash = String.fromCharCode(92);
    const hasPath = [...shown].some((ch, i) => ch === ":" && (shown[i + 1] === "/" || shown[i + 1] === slash) && /[A-Za-z]/.test(shown[i - 1] || ""));
    const meta = document.getElementById("scopeMeta").textContent;
    return { pass: meta === tx("world not read") && chip.textContent.startsWith(tx("not configured")) && chip.title.includes("config/local.json") && readiness.includes(tx("Controller not configured")) && readiness.includes("local.example.json") && !hasPath && atlasState.info.mode === "live" && atlasState.connection.available === false, chip: chip.textContent, readinessHasTitle: readiness.includes(tx("Controller not configured")), hasPath, meta, mode: atlasState.info.mode }; })()`,
  "ui-a17-editor-save-conflict": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    atlasOpenWorkspace({ kind: "agent", projectId: "data-pipeline", quarterId: "data-q1", agentId: "data-ingest-1" }, { tab: "files" });
    await until(() => workspaceState.files !== null && workspaceState.files.listing !== null, 6000);
    const find = (label) => [...document.querySelectorAll(".workspace-body button")].find((node) => node.textContent === label);
    find("README.md").click();
    await until(() => workspaceState.files.file !== null && !workspaceState.files.file.loading && workspaceState.files.file.pages.length === 1, 6000);
    const edit = find(tx("Edit"));
    const editableBefore = edit !== undefined && !edit.disabled;
    edit.click(); await pause(100);
    const area = document.querySelector(".file-editor");
    area.value = area.value + String.fromCharCode(10) + tx("Scene A17 edit.") + String.fromCharCode(10); area.dispatchEvent(new Event("input"));
    const dirtyShown = document.querySelector(".editor-dirty").textContent.includes(tx("not saved"));
    const base = workspaceState.files.file.baseSha256;
    const other = await window.atlas.saveProjectFile({ projectId: "data-pipeline", path: "README.md", expectedSha256: base, text: tx("external edit") + String.fromCharCode(10) });
    find(tx("Save with confirmation")).click();
    const conflict = await until(() => workspaceState.files.file.outcome && workspaceState.files.file.outcome.tone === "conflict", 6000);
    const draftKept = workspaceState.files.file.editing === true && workspaceState.files.file.draft.includes(tx("Scene A17 edit")) && document.querySelector(".editor-dirty").textContent.includes(tx("not saved"));
    find(tx("Reread the file, keep the edit")).click();
    const rebased = await until(() => workspaceState.files.file.baseSha256 !== base && workspaceState.files.file.outcome && workspaceState.files.file.outcome.title.startsWith(tx("New version reread")), 6000);
    find(tx("Save with confirmation")).click();
    const saved = await until(() => workspaceState.files.file.editing === false && workspaceState.files.file.outcome && workspaceState.files.file.outcome.title.startsWith(tx("Saved")), 8000);
    const details = saved ? workspaceState.files.file.outcome.details.join(" ") : "";
    const text = workspaceState.files.file.pages.map((page) => page.text).join("");
    return { pass: editableBefore && dirtyShown && other.ok === true && conflict && draftKept && rebased && saved && details.includes(tx("matches the receipt")) && details.includes("atlas-save-") && text.includes(tx("Scene A17 edit")), editableBefore, dirtyShown, otherOk: other.ok, conflict, draftKept, rebased, saved, details }; })()`,
  "ui-a18-copy-with-memory": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    selectNode({ kind: "project", projectId: "data-pipeline", quarterId: null, agentId: null });
    atlasCopyBlueprint(); atlasPasteBlueprint(); await pause(200);
    const sheet = document.getElementById("sheetBody");
    const radios = [...sheet.querySelectorAll("input[name=pasteMode]")];
    radios[1].checked = true; radios[1].dispatchEvent(new Event("change")); await pause(100);
    const run = [...sheet.querySelectorAll("button")].find((node) => node.textContent === tx("Create with confirmation"));
    const enabled = run !== undefined && !run.disabled;
    const oneOperation = sheet.textContent.includes(tx("in one operation"));
    run.click();
    const done = await until(() => sheet.textContent.includes(tx("Result: complete")), 8000);
    await until(() => atlasState.world !== null && atlasState.world.status === "ready" && atlasState.world.projection.projects.some((project) => project.projectId === "data-pipeline-copy"), 8000);
    const text = sheet.textContent;
    const copy = atlasState.world.projection.projects.find((project) => project.projectId === "data-pipeline-copy");
    const quarters = copy ? copy.quarters.map((quarter) => quarter.quarterId) : [];
    const agents = copy ? copy.quarters.reduce((sum, quarter) => sum + quarter.agents.length, 0) : -1;
    return { pass: enabled && oneOperation && done && text.includes("data-pipeline-copy-memory") && text.includes(tx("revision 1")) && quarters.length === 3 && agents === 0 && !text.includes(tx("partial")), enabled, oneOperation, done, quarters, agents }; })()`,
  "ui-a19-copy-target-choice": `(async () => { const pause = (ms) => new Promise((done) => setTimeout(done, ms)); const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; }; const settle = () => until(() => !scene.animating, 4000); const client = (x, y) => { const rect = scene.canvas.getBoundingClientRect(); const point = worldToScreen(scene.camera, scene.size, x, y); return { x: point.x + rect.left, y: point.y + rect.top }; }; const quarterAt = (projectId, quarterId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; return client(p.x + q.x + q.width - 24, p.y + q.y + q.height - 24); }; const agentAt = (projectId, quarterId, agentId) => { const p = scene.layout.projects[projectId]; const q = scene.layout.quarters[projectId][quarterId]; const a = scene.layout.agents[agentId]; return client(p.x + q.x + a.x, p.y + q.y + a.y); }; const pointer = (type, at) => { scene.canvas.setPointerCapture = () => {}; scene.canvas.releasePointerCapture = () => {}; scene.canvas.hasPointerCapture = () => false; scene.canvas.dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 })); }; const covered = (projectId) => Object.values(scene.layout.quarters[projectId] ?? {}).some((q) => overlapsHeadquarters(scene.layout.projects[projectId], q)); 
    selectNode({ kind: "project", projectId: "data-pipeline", quarterId: null, agentId: null });
    atlasCopyBlueprint(); atlasPasteBlueprint(); await pause(200);
    const sheet = document.getElementById("sheetBody");
    const field = sheet.querySelector("input.paste-target");
    if (!field) return { pass: false, reason: "no-target-field", suggestedOnly: sheet.textContent.includes("data-pipeline-copy"), canChooseExactTarget: false };
    const run = [...sheet.querySelectorAll("button")].find((node) => node.textContent === tx("Create with confirmation"));
    const radios = [...sheet.querySelectorAll("input[name=pasteMode]")];
    radios[1].checked = true; radios[1].dispatchEvent(new Event("change")); await pause(100);
    const suggestion = field.value;
    const projectsBefore = atlasState.world.projection.projects.length;
    const put = async (value) => { field.value = value; field.dispatchEvent(new Event("input")); await pause(80); return { disabled: run.disabled, note: sheet.querySelector(".paste-target-note").textContent }; };
    const occupied = await put("research-lab");
    const invalid = await put("bad id!");
    const same = await put("data-pipeline");
    run.click(); await pause(300);
    const noWrite = atlasState.world.projection.projects.length === projectsBefore && !sheet.textContent.includes(tx("Result:"));
    const exact = await put("codex-r2-s4-copy-target-20260926");
    const summary = sheet.querySelector(".paste-summary").textContent;
    run.click();
    const done = await until(() => sheet.textContent.includes(tx("Result: complete")), 8000);
    await until(() => atlasState.world.projection.projects.some((project) => project.projectId === "codex-r2-s4-copy-target-20260926"), 8000);
    const copy = atlasState.world.projection.projects.find((project) => project.projectId === "codex-r2-s4-copy-target-20260926");
    const receipt = sheet.textContent;
    closeSheet(); await pause(100);
    selectNode({ kind: "quarter", projectId: "data-pipeline", quarterId: "data-q2", agentId: null });
    atlasCopyBlueprint(); atlasPasteBlueprint(); await pause(200);
    const qsheet = document.getElementById("sheetBody");
    const qfield = qsheet.querySelector("input.paste-target");
    const qradios = [...qsheet.querySelectorAll("input[name=pasteMode]")];
    const qmemoryDisabled = qradios[1].disabled;
    qradios[0].checked = true; qradios[0].dispatchEvent(new Event("change")); await pause(80);
    const qsuggestion = qfield.value;
    qfield.value = "data-q2-exact"; qfield.dispatchEvent(new Event("input")); await pause(80);
    const qsummary = qsheet.querySelector(".paste-summary").textContent;
    [...qsheet.querySelectorAll("button")].find((node) => node.textContent === tx("Create with confirmation")).click();
    const qdone = await until(() => qsheet.textContent.includes(tx("Result: complete")), 8000);
    await until(() => atlasState.world.projection.projects.some((project) => project.projectId === "data-pipeline" && project.quarters.some((quarter) => quarter.quarterId === "data-q2-exact")), 8000);
    const qcreated = atlasState.world.projection.projects.find((project) => project.projectId === "data-pipeline").quarters.some((quarter) => quarter.quarterId === "data-q2-exact");
    return { pass: suggestion === "data-pipeline-copy" && occupied.disabled && occupied.note.includes(tx("taken")) && invalid.disabled && invalid.note.includes(tx("Invalid")) && same.disabled && same.note.includes(tx("source")) && noWrite && !exact.disabled && summary.includes("data-pipeline") && summary.includes("codex-r2-s4-copy-target-20260926") && summary.includes(tx("Structure and memory")) && done && copy !== undefined && copy.quarters.length === 3 && copy.quarters.every((quarter) => quarter.agents.length === 0) && receipt.includes("codex-r2-s4-copy-target-20260926-memory") && qsuggestion === "data-q2-copy" && qmemoryDisabled && qsummary.includes("data-q2-exact") && qsummary.includes(tx("Structure only")) && qdone && qcreated, suggestion, occupied, invalid, same, noWrite, exact, summary, done, copyQuarters: copy ? copy.quarters.length : null, qsuggestion, qmemoryDisabled, qsummary, qdone, qcreated }; })()`,
  // PROTOTYPE: the chat of the second agent on the map (the first one when there is only one).
  "chat-second": `(async () => {
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents[1] ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    await new Promise((done) => setTimeout(done, 2500));
  })()`,
  // PROTOTYPE: how one finished turn looks as chat - a typed message, the folded
  // work (an action, reasoning, a change, a backend call) and an answer with
  // markdown. The sample is painted by the same functions as a real turn; nothing
  // is read from or sent to an agent.
  "chat-sample": chatSampleScene(false),
  "chat-sample-open": chatSampleScene(true),
  // Kit v0.21.0: the trace tab, the headquarters with its lead, and a message queued for the turn's end.
  "trace-tab": `(async () => {
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents[1] ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId }, { tab: "trace" });
    await new Promise((done) => setTimeout(done, 1500));
    return { records: workspaceState.trace?.records.length ?? 0, tab: workspaceState.tab };
  })()`,
  "chat-open": `(async () => {
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents[1] ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    const opened = { scale: scene.target.scale, reference: scene.reference, width: document.getElementById("workspace").getBoundingClientRect().width,
      size: scene.size.width, ui: JSON.stringify(atlasState.ui) };
    await new Promise((done) => setTimeout(done, 3000));
    opened.after = { scale: scene.camera.scale, level: currentLevel(), raw: levelFor(scene.camera, scene.size, scene.reference, false) };
    window.__opened = opened;
    for (const work of document.querySelectorAll(".feed-work")) work.open = true;
    const feed = document.getElementById("chatFeed");
    if (feed) feed.scrollTop = feed.scrollHeight;
    return { agent: a.agentId, segments: document.querySelectorAll(".feed-turn").length, open: isWorkspaceOpen(),
      opened: window.__opened, log: atlasState.log.slice(-8).map((entry) => entry.what + ": " + entry.detail.slice(0, 60)) };
  })()`,
  // The agent's question with its options as a list, and an answered question
  // kept in the chat history ("· question → answer").
  "chat-question": chatAgentScene("billing-invoice-1"),
  "chat-answered": chatAgentScene("data-ingest-1"),
  // A lead's chat (entering a quarter, the project lead in the headquarters)
  // leaves the camera where it is and stays open at the world level; an
  // ordinary agent's chat still brings the camera to the agent.
  "ui-a20-lead-chat-camera": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    goLevel(LEVEL.world);
    await pause(1500);
    const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    const lead = q.agents[0];
    lead.settings = { ...(lead.settings ?? {}), role: "quarter-lead" };
    const at = () => ({ x: scene.camera.x, y: scene.camera.y, scale: scene.camera.scale });
    const still = (a, b) => a.x === b.x && a.y === b.y && a.scale === b.scale;
    const before = at();
    atlasEnterQuarter(p.projectId, q.quarterId);
    await pause(1500);
    const quarterLead = { open: isWorkspaceOpen(), agent: workspaceState.node?.agentId ?? null, still: still(before, at()),
      level: currentLevel() };
    closeWorkspace();
    await pause(300);
    const before2 = at();
    atlasOpenWorkspace({ kind: "agent", projectId: p.projectId, quarterId: HEADQUARTERS_QUARTER, agentId: lead.agentId });
    await pause(1500);
    const projectLead = { open: isWorkspaceOpen(), still: still(before2, at()) };
    closeWorkspace();
    await pause(300);
    const before3 = at();
    atlasOpenWorkspace({ kind: "agent", projectId: p.projectId, quarterId: q.quarterId, agentId: q.agents[q.agents.length - 1].agentId });
    await pause(1500);
    const agent = { open: isWorkspaceOpen(), moved: !still(before3, at()) };
    return { pass: quarterLead.open && quarterLead.still && quarterLead.agent === lead.agentId
      && quarterLead.level === LEVEL.world && projectLead.open && projectLead.still && agent.open && agent.moved,
    quarterLead, projectLead, agent };
  })()`,
  // Corner handles: a selected quarter shrinks by its bottom-right handle (its
  // agents stay inside) and one undo step brings it back; the headquarters of a
  // selected project shrinks by its own handle, in its proportions; an agent
  // shrinks by its corner and, dropped at the quarter's corner, snaps onto the first grid intersection.
  "ui-a21-corner-resize": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const settle = async () => { const end = Date.now() + 4000; while (Date.now() < end && scene.animating) await pause(60); };
    const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    goProject(p.projectId, { instant: true });
    await pause(300);
    scene.canvas.setPointerCapture = () => {};
    scene.canvas.releasePointerCapture = () => {};
    scene.canvas.hasPointerCapture = () => false;
    const client = (x, y) => {
      const rect = scene.canvas.getBoundingClientRect();
      const point = worldToScreen(scene.camera, scene.size, x, y);
      return { x: point.x + rect.left, y: point.y + rect.top };
    };
    // Screen points are computed only once the camera, the canvas (an inspector
    // opening resizes it) and the layout of this project have stopped changing;
    // the layout is read fresh after that, never kept from an earlier step.
    const steady = async () => {
      await settle();
      let last = null; let same = 0;
      for (const end = Date.now() + 4000; Date.now() < end && same < 3;) {
        const rect = scene.canvas.getBoundingClientRect();
        const now = JSON.stringify([rect.left, rect.top, rect.width, rect.height, scene.size, scene.camera,
          scene.layout.projects[p.projectId], scene.layout.quarters[p.projectId][q.quarterId],
          q.agents.map((agent) => scene.layout.agents[agent.agentId])]);
        same = now === last ? same + 1 : 0; last = now;
        await pause(60);
      }
    };
    const pointer = (type, at) => scene.canvas.dispatchEvent(new PointerEvent(type,
      { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
    const drag = async (from, to) => {
      pointer("pointerdown", from);
      for (let step = 1; step <= 6; step += 1) {
        pointer("pointermove", { x: from.x + (to.x - from.x) * step / 6, y: from.y + (to.y - from.y) * step / 6 });
        await pause(16);
      }
      await pause(32);
      pointer("pointerup", to);
      await pause(100);
    };
    const projectBox = () => scene.layout.projects[p.projectId];
    const quarterBox = () => scene.layout.quarters[p.projectId][q.quarterId];
    selectNode({ kind: "quarter", projectId: p.projectId, quarterId: q.quarterId, agentId: null });
    await pause(100); await steady();
    const before = { ...quarterBox() };
    {
      const project = projectBox(); const box = quarterBox();
      await drag(client(project.x + box.x + box.width, project.y + box.y + box.height),
        client(project.x + box.x + box.width - 150, project.y + box.y + box.height - 86));
    }
    const shrunk = { ...quarterBox() };
    const agentsInside = q.agents.every((agent) => {
      const spot = scene.layout.agents[agent.agentId];
      return spot.x > 0 && spot.x < shrunk.width && spot.y > 0 && spot.y < shrunk.height;
    });
    undoLocal();
    const undone = { ...quarterBox() };
    redoLocal();
    selectNode({ kind: "project", projectId: p.projectId, quarterId: null, agentId: null });
    await pause(100); await steady();
    {
      const project = projectBox(); const hq = headquartersBox(project);
      await drag(client(project.x + hq.x + hq.width, project.y + hq.y + hq.height),
        client(project.x + hq.x + hq.width - 76, project.y + hq.y + hq.height - 68));
    }
    const hqScale = projectBox().hqScale ?? 1;
    // An agent by its corner, then the agent itself right up to the corner of its quarter.
    const agentId = q.agents[0].agentId;
    const agentAt = () => {
      const project = projectBox(); const box = quarterBox(); const spot = scene.layout.agents[agentId];
      return { x: project.x + box.x + spot.x, y: project.y + box.y + spot.y };
    };
    selectNode({ kind: "agent", projectId: p.projectId, quarterId: q.quarterId, agentId });
    await pause(100); await steady();
    {
      const at = agentAt();
      await drag(client(at.x + 17, at.y + 14), client(at.x + 8.5, at.y + 7));
    }
    const agentScale = scene.layout.agents[agentId].scale ?? 1;
    await steady();
    {
      const at = agentAt(); const project = projectBox(); const box = quarterBox();
      await drag(client(at.x, at.y), client(project.x + box.x - 60, project.y + box.y - 60));
    }
    const atEdge = { ...scene.layout.agents[agentId] };
    // Dropped at the corner, it snaps onto the first grid intersection its icon fits at.
    const range = pointRange({ scale: agentScale }, quarterBox().width);
    const edge = { x: range.left, y: range.top };
    selectNode({ kind: "agent", projectId: p.projectId, quarterId: q.quarterId, agentId });
    goProject(p.projectId);
    await settle();
    return { pass: shrunk.width < before.width && shrunk.height < before.height && agentsInside
      && undone.width === before.width && undone.height === before.height && hqScale >= 0.55 && hqScale < 0.7
      && agentScale >= 0.45 && agentScale <= 0.55
      && Math.abs(atEdge.x - edge.x) < 0.01 && Math.abs(atEdge.y - edge.y) < 0.01,
    before, shrunk, agentsInside, undone, hqScale, agentScale, atEdge, edge };
  })()`,
  // The agent window (level 1) closes on any click on the map that is not that
  // agent, and the level buttons below close it and go to their level.
  "ui-a22-workspace-closes": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const settle = async () => { const end = Date.now() + 4000; while (Date.now() < end && scene.animating) await pause(60); };
    scene.canvas.setPointerCapture = () => {};
    scene.canvas.releasePointerCapture = () => {};
    scene.canvas.hasPointerCapture = () => false;
    const client = (x, y) => {
      const rect = scene.canvas.getBoundingClientRect();
      const point = worldToScreen(scene.camera, scene.size, x, y);
      return { x: point.x + rect.left, y: point.y + rect.top };
    };
    const click = async (at) => {
      for (const type of ["pointerdown", "pointerup"]) {
        scene.canvas.dispatchEvent(new PointerEvent(type,
          { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
      }
      await pause(150);
    };
    const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    const agent = q.agents[0];
    const node = { kind: "agent", projectId: p.projectId, quarterId: q.quarterId, agentId: agent.agentId };
    const agentAt = () => {
      const project = scene.layout.projects[p.projectId];
      const box = scene.layout.quarters[p.projectId][q.quarterId];
      const spot = scene.layout.agents[agent.agentId];
      return client(project.x + box.x + spot.x, project.y + box.y + spot.y);
    };
    atlasOpenWorkspace(node);
    await settle(); await pause(300);
    await click(agentAt());
    const onAgent = isWorkspaceOpen();
    const rect = scene.canvas.getBoundingClientRect();
    await click({ x: rect.left + 30, y: rect.top + rect.height - 40 });
    const outside = isWorkspaceOpen();
    atlasOpenWorkspace(node);
    await settle(); await pause(300);
    document.querySelector('[data-level="2"]').click();
    await settle(); await pause(300);
    const byButton = { open: isWorkspaceOpen(), level: currentLevel() };
    return { pass: onAgent === true && outside === false && byButton.open === false && byButton.level === LEVEL.quarter,
      onAgent, outside, byButton };
  })()`,
  // A bound folder changes only while nothing holds it: agents that worked keep it
  // for good; open agents that never worked are listed to be archived first; a
  // project without them offers the change. Quarters do not count.
  // Plan R36: the folder can be changed after the agents worked too (their sessions move
  // along); not while an agent of the project runs a turn.
  "ui-a23-folder-hold": `(async () => {
    const agentsOf = (p) => p.quarters.flatMap((q) => q.agents);
    const worked = (agent) => (agent.lastOperation ?? null) !== null;
    const busy = (agent) => Boolean(agent.currentOperationId);
    const projects = atlasState.world.projection.projects;
    const running = projects.find((p) => agentsOf(p).some(busy));
    const workedFree = projects.find((p) => agentsOf(p).some(worked) && !agentsOf(p).some(busy)) ?? null;
    const idle = projects.find((p) => agentsOf(p).length > 0 && !agentsOf(p).some(worked) && !agentsOf(p).some(busy));
    const created = await window.atlas.createScope({ kind: "project", projectId: "ui-a23-empty", title: tx("Empty") });
    await refresh();
    const quarter = await window.atlas.createScope({ kind: "quarter", projectId: "ui-a23-empty", quarterId: "ui-a23-q",
      title: tx("No agents") });
    await refresh();
    const look = (projectId) => {
      const box = document.createElement("div");
      folderHold(box, projectId, "C:/fixture");
      return { text: box.textContent, buttons: [...box.querySelectorAll("button")].map((b) => b.textContent) };
    };
    const wait = look(running.projectId);
    const after = workedFree === null ? null : look(workedFree.projectId);
    const before = look(idle.projectId);
    const free = look("ui-a23-empty");
    const body = openSheet(tx("Project folder · ") + running.projectId, tx("scene"));
    const box = document.createElement("div");
    body.append(box);
    folderHold(box, running.projectId, "C:/fixture");
    await new Promise((done) => setTimeout(done, 300));
    const changeOnly = (view) => view.buttons.length === 1 && view.buttons[0] === tx("Change folder…");
    return { pass: created.ok === true && quarter.ok === true
      && wait.text.includes(tx("The folder cannot be changed now")) && wait.buttons.length === 0
      && (after === null || (changeOnly(after) && after.text.includes("move with the binding")))
      && changeOnly(before) && before.text.includes("have not worked in this folder yet") && before.text.includes("Gateway")
      && changeOnly(free) && free.text.includes("has no agents yet"),
    running: running.projectId, workedFree: workedFree?.projectId ?? null, idle: idle.projectId, wait, after, before, free };
  })()`,
  // Thinking is its own block, not an action's window, and a going turn says what
  // the agent does now (runs a command, thinks); the agent window's text size and
  // zoom change the text and the content, not the panel's width.
  "ui-a25-chat-thinking-scale": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents[1] ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    await pause(2500);
    const ref = (id) => ({ authority: { externalId: id } });
    const item = (n, contentClass, text) => ({ contentClass, text, visibility: "user-visible", omissionReason: null,
      observedAtUtc: new Date().toISOString(), itemRef: ref("a25:" + n), turnRef: ref("a25") });
    const turn = { state: "active", startedAtUtc: new Date(Date.now() - 83000).toISOString(), completedAtUtc: null };
    const running = [
      item(1, "user-message", tx("Explore the project folder.")),
      item(2, "tool-summary", "Thinking\\n\\nFirst I will look at the top level, then find nested repositories."),
      item(3, "assistant-message", tx("Looking at what is in the folder.")),
      item(4, "tool-summary", tx("$ find . -name .git · running")),
    ];
    const thinking = [...running.slice(0, 3), item(5, "tool-summary", "$ ls -la\\n\\nREADME.md"),
      item(6, "tool-summary", "Thinking\\n\\nNo nested repositories; now I will check the README against the project memory.")];
    const feed = document.getElementById("chatFeed");
    feed.replaceChildren();
    const paint = (items, title) => {
      const box = el("section", "feed-turn");
      box.append(el("div", "feed-turn-head", title));
      for (const segment of liveTurnSegments(items, "active")) {
        if (segment.kind === "work") box.append(liveWork(segment.items, turn, true));
        else box.append(liveRecord(segment.item, { answer: segment.kind === "answer" }));
      }
      box.append(livePulse(items, turn));
      feed.append(box);
      return box;
    };
    const first = paint(running, tx("Sample: running a command"));
    const second = paint(thinking, tx("Sample: thinking"));
    const pulseOf = (box) => ({ word: box.querySelector(".feed-pulse-word")?.textContent ?? null,
      what: box.querySelector(".feed-pulse-what")?.textContent ?? null, time: box.querySelector(".feed-pulse-time")?.textContent ?? null,
      running: box.querySelector(".feed-pulse")?.classList.contains("running") ?? false });
    const thoughts = feed.querySelectorAll(".feed-thinking").length;
    const thoughtsAsActions = feed.querySelectorAll(".feed-activity .feed-thinking-text, .feed-activity.feed-thinking").length;
    const panel = document.getElementById("workspace");
    const width = panel.getBoundingClientRect().width;
    const textBefore = parseFloat(getComputedStyle(feed.querySelector(".feed-note")).fontSize);
    setChatScale("chatText", 80);
    await pause(100);
    const textAfter = parseFloat(getComputedStyle(feed.querySelector(".feed-note")).fontSize);
    setChatScale("chatZoom", 90);
    await pause(200);
    const zoom = getComputedStyle(document.querySelector(".workspace-body")).zoom;
    const widthAfter = panel.getBoundingClientRect().width;
    document.getElementById("chatScaleButton").click();
    await pause(300);
    const menu = { open: !document.querySelector(".chat-scale-menu").hidden,
      text: document.getElementById("chatTextValue")?.textContent, zoom: document.getElementById("chatZoomValue")?.textContent };
    const one = pulseOf(first); const two = pulseOf(second);
    return { pass: thoughts === 3 && thoughtsAsActions === 0
      && one.running && one.word === tx("Running") && one.what === "$ find . -name .git" && /^turn running 1:2\\d$/.test(one.time ?? "")
      && !two.running && two.word === tx("Thinking…")
      && Math.abs(textAfter - textBefore * 0.8) < 0.2 && zoom === "0.9" && Math.abs(widthAfter - width) < 1
      && atlasState.ui.chatText === 80 && atlasState.ui.chatZoom === 90 && menu.open && menu.text === "80%" && menu.zoom === "90%",
    thoughts, thoughtsAsActions, one, two, textBefore, textAfter, zoom, width, widthAfter, menu };
  })()`,
  // The agent's permission mode at its input, as in Claude Code: the provider's
  // marked as the default, Shift+Tab to the next one, "bypass" after a confirmation.
  "ui-a26-permission-mode": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents.find((item) => item.state === "active") ?? agents[0];
    // The fixture controller outlives a run: the agent starts in the provider's mode.
    await window.atlas.setPermissionMode({ agentId: a.agentId, permissionMode: null });
    workspaceState.permissionModes = null;
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    await until(() => document.getElementById("chatPermission")?.disabled === false, 8000);
    const select = () => document.getElementById("chatPermission");
    const label = () => select().selectedOptions[0]?.textContent ?? null;
    const first = { value: select().value, label: label() };
    const text = document.querySelector(".chat-compose textarea");
    text.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    await until(() => select().disabled === false && select().value === "auto", 8000);
    const cycled = { value: select().value, label: label() };
    select().value = "bypassPermissions";
    select().dispatchEvent(new Event("change"));
    await until(() => select().disabled === false && select().dataset.current === "bypassPermissions", 8000);
    const note = document.querySelector(".chat-result")?.textContent ?? "";
    const read = await window.atlas.permissionModes();
    await window.atlas.setPermissionMode({ agentId: a.agentId, permissionMode: null });
    return { pass: first.value === "acceptEdits" && first.label === tx("Accept edits · default")
      && cycled.value === "auto" && cycled.label === tx("Auto")
      && select().value === "bypassPermissions" && note.includes(tx("Bypass permissions"))
      && read.ok && read.data.agents.some((item) => item.agentId === a.agentId && item.permissionMode === "bypassPermissions"),
    agent: a.agentId, first, cycled, after: select().value, note, read };
  })()`,
  // Text in the chat is selected and copied (Ctrl+C is not the map's blueprint,
  // the feed is not repainted under a selection); several options of a question
  // stay chosen through a refresh; the plan usage menu; a project lead's
  // attention on the headquarters.
  "ui-a27-copy-choices-usage-lead": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const raw = atlasState.world.projection;
    const project = raw.projects[0];
    const a = project.quarters[0].agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    await until(() => document.querySelectorAll("#chatFeed .feed-message").length > 0, 8000);
    const feed = document.getElementById("chatFeed");
    const text = feed.querySelector(".feed-text");
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const key = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(key);
    const marker = document.createElement("i");
    marker.id = "a27-marker";
    feed.append(marker);
    paintChat();
    const keptUnderSelection = document.getElementById("a27-marker") !== null;
    getSelection().removeAllRanges();
    await pause(150);
    const repaintedAfter = document.getElementById("a27-marker") === null;
    // A question with several options, painted again by a refresh.
    workspaceState.chatQuestions = { agentId: a.agentId, records: [{ interactionId: "a27-q", display: { kind: "user-input",
      fields: { questions: [{ id: "q1", header: tx("Parts"), question: tx("Which parts should be checked?"), multiSelect: true,
        options: [{ label: tx("Hull"), description: "" }, { label: tx("Tracks"), description: "" }, { label: tx("Turret"), description: "" }] }] } } }],
      loading: false, failed: false, key: "a27" };
    paintChatQuestions(a);
    const options = () => [...document.querySelectorAll("#chatQuestions .chat-option")].filter((node) => node.tagName === "BUTTON");
    options()[0].click();
    options()[2].click();
    paintChatQuestions(a);
    const chosen = options().filter((node) => node.classList.contains("chosen")).map((node) => node.querySelector(".chat-option-label").textContent);
    const submitEnabled = !document.querySelector("#chatQuestions .chat-question button.primary").disabled;
    const severalTag = document.querySelector("#chatQuestions .chat-question-tag.several")?.textContent ?? null;
    // The usage menu with a reading as the Gateway keeps it.
    const menu = document.getElementById("usageMenu");
    menu.classList.remove("hidden");
    renderUsageMenu(menu, { state: "known", usage: { observedAtUtc: new Date().toISOString(), available: true, subscriptionType: "max",
      windows: [{ id: "five_hour", label: tx("Session (5 h)"), utilization: 14, resetsAtUtc: new Date(Date.now() + 2 * 3600e3).toISOString(), status: null },
        { id: "seven_day", label: tx("Week (7 days)"), utilization: 33, resetsAtUtc: new Date(Date.now() + 2 * 86400e3).toISOString(), status: null },
        { id: "model:Fable", label: tx("Fable · limit"), utilization: 0, resetsAtUtc: new Date(Date.now() + 2 * 86400e3).toISOString(), status: null }] } });
    const usageRows = [...menu.querySelectorAll(".usage-row")].map((row) => row.textContent);
    const usageShot = menu.textContent;
    menu.classList.add("hidden");
    // A project lead (in the headquarters quarter, not on the map) with a finished turn.
    const lead = { ...structuredClone(a), agentId: "a27-project-lead", quarterId: "hq", currentOperationId: null,
      settings: { role: "project-lead", writeZone: null, revision: 1, updatedAtUtc: null } };
    project.quarters.push({ ...structuredClone(project.quarters[0]), quarterId: "hq", agents: [lead] });
    atlasState.world.attention = [...(atlasState.world.attention ?? []),
      { kind: "turn-finished", agentId: lead.agentId, projectId: project.projectId, quarterId: "hq", operationId: "a27-op", outcome: "completed" }];
    closeWorkspace();
    goProject(project.projectId, { instant: true });
    await pause(600);
    const leadBadge = (scene.badges ?? []).some((badge) => badge.node?.agentId === lead.agentId);
    menu.classList.remove("hidden");
    renderUsageMenu(menu, { state: "known", usage: { observedAtUtc: new Date().toISOString(), available: true, subscriptionType: "max",
      windows: [{ id: "five_hour", label: tx("Session (5 h)"), utilization: 14, resetsAtUtc: new Date(Date.now() + 2 * 3600e3).toISOString(), status: null },
        { id: "seven_day", label: tx("Week (7 days)"), utilization: 33, resetsAtUtc: new Date(Date.now() + 2 * 86400e3).toISOString(), status: null },
        { id: "model:Fable", label: tx("Fable · limit"), utilization: 0, resetsAtUtc: new Date(Date.now() + 2 * 86400e3).toISOString(), status: null }] } });
    await pause(200);
    return { pass: key.defaultPrevented === false && keptUnderSelection && repaintedAfter
      && chosen.join() === tx("Hull,Turret") && submitEnabled && severalTag === tx("you can choose several")
      && usageRows.length === 3 && usageShot.includes(tx("Fable · limit")) && usageShot.includes(tx("resets in 2 h")) && leadBadge,
    copyPrevented: key.defaultPrevented, keptUnderSelection, repaintedAfter, chosen, submitEnabled, severalTag, usageRows, leadBadge };
  })()`,
  // A refresh of the world does not rebuild a tab that does not show the catalog
  // (its scroll and its elements stay); a memory document is previewed, then
  // approved and written in the live mode (confirmed by the scene).
  "ui-a28-tabs-keep-memory-document": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents.find((item) => item.state === "active") ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId }, { tab: "context" });
    await until(() => document.querySelector("#workspace .workspace-body .section-title") !== null, 8000);
    const body = () => document.querySelector("#workspace .workspace-body");
    const marker = document.createElement("i");
    marker.id = "a28-marker";
    body().append(marker);
    body().scrollTop = 120;
    const before = body().scrollTop;
    refreshWorkspace();
    await refresh();
    await pause(200);
    const kept = document.getElementById("a28-marker") !== null && body().scrollTop === before;
    const section = [...document.querySelectorAll("#workspace .section-title")].some((node) => node.textContent === tx("Memory document"));
    const show = [...document.querySelectorAll("#workspace button")].find((button) => button.textContent === tx("Show document"));
    const path = [...document.querySelectorAll("#workspace input.field")].find((input) => input.placeholder.startsWith("docs/memory/"));
    path.value = "docs/memory/project.md";
    show.click();
    await until(() => [...document.querySelectorAll("#workspace button")].some((button) => button.textContent === tx("Approve and write")), 8000);
    const entries = [...document.querySelectorAll("#workspace .entry-title")].map((node) => node.textContent);
    [...document.querySelectorAll("#workspace button")].find((button) => button.textContent === tx("Approve and write")).click();
    await until(() => /Written/.test(document.querySelector("#workspace").textContent), 8000);
    const written = /Written: .*revision 2/.test(document.querySelector("#workspace").textContent);
    const ownMemory = [...document.querySelectorAll("#workspace button")].some((button) => button.textContent === tx("Open agent memory"));
    body().scrollTop = body().scrollHeight;
    return { pass: kept && section && entries.includes(tx("Goal")) && entries.includes(tx("Rules")) && written
      && (typeof a.agentScopeId !== "string" || ownMemory),
    kept, before, section, entries, written, ownMemory, agentScopeId: a.agentScopeId ?? null };
  })()`,
  // The agent's history in the Files tab: a folder not under git offers to become
  // a repository (confirmed by the scene); then the agent's commits are listed.
  "ui-a29-agent-commits": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents.find((item) => item.state === "active") ?? agents[0];
    workspaceState.commitsOpen = true;
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId }, { tab: "files" });
    const summary = () => document.querySelector("#workspace .agent-commits summary")?.textContent ?? "";
    await until(() => !summary().includes(tx("reading")), 8000);
    const first = summary();
    const init = [...document.querySelectorAll("#workspace .agent-commits button")].find((button) => button.textContent === tx("Create a git repository…"));
    if (init) {
      init.click();
      await until(() => /commit/.test(summary()) && !summary().includes(tx("not under git")), 8000);
    }
    const after = summary();
    const rows = [...document.querySelectorAll("#workspace .agent-commits .entry-title")].map((node) => node.textContent);
    return { pass: /commit/.test(after) && rows.length === 1 && rows[0].startsWith(a.agentId + ": "),
      first, offered: init !== undefined, after, rows };
  })()`,
  // An archived agent leaves the map, as archived projects and quarters do; the
  // Archive lists it, and its chat opens from there to be read.
  "ui-a30-archived-agent-off-map": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const raw = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const archived = raw.filter((agent) => agent.state === "archived").map((agent) => agent.agentId);
    const onMap = projectionOf().projects.flatMap((p) => p.quarters.flatMap((q) => q.agents)).map((agent) => agent.agentId);
    await atlasOpenProjectArchive();
    await until(() => [...document.querySelectorAll("#sheet .section-title")].some((node) => node.textContent.startsWith(tx("Agents"))), 8000);
    const heading = [...document.querySelectorAll("#sheet .section-title")].find((node) => node.textContent.startsWith(tx("Agents")))?.textContent ?? null;
    const listed = [...document.querySelectorAll("#sheet .entry-title")].map((node) => node.textContent);
    const read = [...document.querySelectorAll("#sheet button")].find((button) => button.textContent === tx("Conversation"));
    read?.click();
    await until(() => isWorkspaceOpen(), 5000);
    return { pass: archived.length > 0 && archived.every((id) => !onMap.includes(id)) && archived.every((id) => listed.includes(id))
      && heading === tx("Agents · ") + archived.length && isWorkspaceOpen() && archived.includes(workspaceState.node?.agentId),
    archived, heading, listed, opened: workspaceState.node?.agentId ?? null };
  })()`,
  // An agent's name is not reused, an archived agent's either: the form says the
  // name is taken before anything is sent, and a lead gets the first free name.
  "ui-a24-agent-name-taken": `(async () => {
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const archived = agents.find((agent) => agent.state === "archived");
    const open = agents.find((agent) => agent.state !== "archived");
    openCreateAgentSheet(archived.projectId, archived.quarterId);
    await new Promise((done) => setTimeout(done, 800));
    const input = document.querySelector("#sheet input.identifier-input");
    const type = (value) => { input.value = value; input.dispatchEvent(new Event("input")); return document.querySelector("#sheet .identifier-hint").textContent; };
    const onArchived = type(archived.agentId);
    const onOpen = type(open.agentId);
    const onFree = type("ui-a24-free-name");
    const free = freeAgentId(archived.agentId);
    type(archived.agentId);
    await new Promise((done) => setTimeout(done, 300));
    return { pass: onArchived.includes(tx("main::archived")) && onOpen.includes(tx("already exists")) && onFree === tx("Matches the format.")
      && free === archived.agentId + "-2" && freeAgentId("ui-a24-free-name") === "ui-a24-free-name",
    archived: archived.agentId, onArchived, onOpen, onFree, free };
  })()`,
  // The world headquarters: the main base of the world, left of the projects and
  // bigger than a project's headquarters; Backspace selects it and centres it
  // (StarCraft II's "base" key); a click opens its sheet - the world lead, the
  // tasks it gave out with their steps, the desk agents; entering the world
  // opens the lead's chat where the camera is.
  "ui-a32-world-hq": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    goLevel(LEVEL.world);
    await pause(1200);
    const box = worldHqBox();
    const projects = projectionOf().projects.map((project) => scene.layout.projects[project.projectId]).filter(Boolean);
    const leftOfProjects = box !== null && projects.length > 0 && projects.every((other) => box.x + box.width <= other.x);
    const bigger = box !== null && box.width > GEOMETRY.hqWidth && box.height > GEOMETRY.hqHeight;
    const onMapAsProject = projectionOf().projects.some((project) => project.projectId === WORLD_PROJECT);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await pause(400);
    await until(() => !scene.animating, 5000);
    const centred = box !== null && Math.abs(scene.camera.x - (box.x + box.width / 2)) < 2
      && Math.abs(scene.camera.y - (box.y + box.height / 2)) < 2;
    const selected = scene.selection?.kind === "world";
    await until(() => document.getElementById("inspector").textContent.includes(tx("desk agents")), 8000);
    const inspector = document.getElementById("inspector").textContent;
    commitClick(worldHqNode());
    await until(() => document.querySelectorAll("#sheetBody .task-entry").length > 0, 8000);
    await pause(300);
    const sheet = document.getElementById("sheetBody").textContent;
    const entries = document.querySelectorAll("#sheetBody .task-entry").length;
    const current = [...document.querySelectorAll("#sheetBody .task-step.current")].map((node) => node.textContent);
    const declined = document.querySelectorAll("#sheetBody .task-step.declined").length;
    const shot = sheet.slice(0, 400);
    closeSheet();
    await until(() => !scene.animating, 5000);
    const before = { x: scene.camera.x, y: scene.camera.y, scale: scene.camera.scale };
    enterNode(worldHqNode());
    await pause(1200);
    const still = before.x === scene.camera.x && before.y === scene.camera.y && before.scale === scene.camera.scale;
    const chat = { open: isWorkspaceOpen(), agent: workspaceState.node?.agentId ?? null,
      eyebrow: document.querySelector("#workspace .eyebrow")?.textContent ?? null,
      tabs: [...document.querySelectorAll("#workspace .workspace-tabs button")].map((button) => button.textContent) };
    return { pass: leftOfProjects && bigger && !onMapAsProject && centred && selected
      && inspector.includes("world-lead") && sheet.includes(tx("World lead")) && sheet.includes("world-lead")
      && entries === 8 && declined === 1 && current.includes(tx("in progress")) && current.includes(tx("plan"))
      && sheet.includes("desk-core-scheduler-1") && still && chat.open && chat.agent === "world-lead"
      && chat.eyebrow === tx("WORLD LEAD") && chat.tabs.includes(tx("World")),
    box, leftOfProjects, bigger, onMapAsProject, centred, selected, entries, current, declined, still, chat, shot };
  })()`,
  // “Create world lead…” in one confirmed flow (the confirmation is
  // answered by the scene): the world without a lead offers it in its sheet,
  // the form names what will be done, then the world project is bound to the
  // controller folder, the agent is created in the world headquarters, gets the
  // coordinator role, and its chat opens where the camera is.
  "ui-a33-world-lead-create": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    goLevel(LEVEL.world);
    await pause(1000);
    // The fixture's world lead steps aside in this window only: the world has no lead now.
    const fixtureLead = worldLeadOf();
    fixtureLead.settings = { ...fixtureLead.settings, role: "feature" };
    atlasOpenWorldHeadquarters();
    await pause(300);
    const offered = [...document.querySelectorAll("#sheetBody button")].map((button) => button.textContent);
    const hint = document.getElementById("sheetBody").textContent;
    await openCreateWorldLeadSheet();
    await until(() => /already bound|will be bound permanently/.test(document.getElementById("sheetBody").textContent), 8000);
    const form = document.getElementById("sheetBody").textContent;
    const suggested = document.querySelector("#sheetBody input").value;
    // A name of its own for this run: the fixture's controller keeps roles between runs.
    const name = "world-lead-" + Date.now().toString(36);
    const input = document.querySelector("#sheetBody input");
    input.value = name;
    input.dispatchEvent(new Event("input"));
    await until(() => !scene.animating, 5000);
    const before = { x: scene.camera.x, y: scene.camera.y, scale: scene.camera.scale };
    [...document.querySelectorAll("#sheetBody button")].find((button) => button.textContent === tx("Create with confirmation")).click();
    await until(() => (isWorkspaceOpen() && workspaceState.node?.agentId === name)
      || document.querySelector("#sheetBody .error") !== null, 20000);
    await pause(600);
    const still = before.x === scene.camera.x && before.y === scene.camera.y && before.scale === scene.camera.scale;
    const failure = document.querySelector("#sheetBody .error")?.textContent ?? null;
    const logged = atlasState.log.map((entry) => entry.what);
    return { pass: offered.includes(tx("Create world lead…")) && offered.includes(tx("Make world lead…"))
      && hint.includes(tx("one coordinator over all projects")) && suggested === "world-lead-2"
      && form.includes(tx("world lead (the controller's coordinator)")) && form.includes(tx("will be created in the World HQ"))
      && failure === null && isWorkspaceOpen() && workspaceState.node?.agentId === name
      && workspaceState.node?.projectId === WORLD_PROJECT && still && logged.includes(tx("world lead")),
    offered, suggested, name, failure, still, logged: logged.slice(-6), form: form.slice(0, 600) };
  })()`,
  // A desk agent from Atlas: a registered agent says so permanently (inspector)
  // and is offered nothing; another agent is offered “Take tasks
  // (desk agent)…” in its inspector and its menu, is registered after the
  // confirmation (answered by the scene) and then says so; a refusal is a sentence.
  "ui-a34-desk-agent": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    goLevel(LEVEL.world);
    await until(() => atlasState.taskBoard !== null && atlasState.taskBoard.failed === false, 10000);
    const board = atlasState.taskBoard;
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const nodeOf = (agent) => ({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId });
    const registered = agents.find((agent) => board.sources.some((source) => source.agentId === agent.agentId && source.valid));
    const candidate = agents.find((agent) => deskRegistrationState(agent, boardForState()).offer && agent.agentId !== "mobile-ui-3");
    selectNode(nodeOf(registered));
    await pause(300);
    const registeredText = document.getElementById("inspector").textContent;
    const registeredOffers = [...document.querySelectorAll("#inspector button")].some((button) => button.textContent.startsWith(tx("Take tasks")));
    selectNode(nodeOf(candidate));
    await pause(300);
    const offerButton = [...document.querySelectorAll("#inspector button")].some((button) => button.textContent === tx("Take tasks (desk agent)…"));
    atlasOpenContextMenu(nodeOf(candidate), { x: 400, y: 300 });
    const menu = [...document.querySelectorAll("#contextMenu button")].map((button) => button.textContent);
    document.getElementById("contextMenu").classList.add("hidden");
    const press = async (label) => {
      await until(() => [...document.querySelectorAll("#sheetBody button")].some((button) => button.textContent === label), 5000);
      [...document.querySelectorAll("#sheetBody button")].find((button) => button.textContent === label)?.click();
    };
    openDeskAgentSheet(candidate);
    await press(tx("Take tasks — with confirmation"));
    await until(() => /The agent takes tasks|already takes tasks/.test(document.getElementById("sheetBody").textContent), 15000);
    await pause(300);
    const after = document.getElementById("sheetBody").textContent;
    const offeredAfter = [...document.querySelectorAll("#sheetBody button")].some((button) => button.textContent.startsWith(tx("Take tasks")));
    openDeskAgentSheet(agents.find((agent) => agent.agentId === "mobile-ui-3"));
    await press(tx("Take tasks — with confirmation"));
    await until(() => document.querySelector("#sheetBody .error") !== null, 15000);
    const refusal = document.querySelector("#sheetBody .error")?.textContent ?? "";
    return { pass: registeredText.includes(tx("yes · source desk-")) && registeredText.includes(tx("The registration is permanent"))
      && !registeredOffers && offerButton && menu.includes(tx("Take tasks (desk agent)…"))
      && after.includes(tx("yes · source desk-") + candidate.agentId) && !offeredAfter
      && refusal.includes(tx("to another folder")) && !refusal.includes("desk_source_binding_conflict"),
    registered: registered?.agentId ?? null, candidate: candidate?.agentId ?? null, offerButton, menu,
    after: after.slice(0, 500), offeredAfter, refusal };
  })()`,
  // The Tasks tab: an agent's own controller tasks with their steps and whether
  // it takes tasks; the world lead's tab lists every task it gave out.
  "ui-a35-tasks-tab": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const agent = agents.find((item) => item.agentId === "core-scheduler-1");
    atlasOpenWorkspace({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId }, { tab: "tasks" });
    await until(() => document.querySelectorAll("#workspace .task-entry").length > 0
      && document.getElementById("workspace").textContent.includes(tx("yes · source")), 8000);
    const own = [...document.querySelectorAll("#workspace .task-entry .task-id")].map((node) => node.textContent);
    const ownText = document.getElementById("workspace").textContent;
    const ownCurrent = [...document.querySelectorAll("#workspace .task-step.current")].map((node) => node.textContent);
    closeWorkspace();
    await pause(400);
    const lead = worldLeadOf();
    atlasOpenWorkspace({ kind: "agent", projectId: lead.projectId, quarterId: lead.quarterId, agentId: lead.agentId },
      { tab: "tasks", camera: false });
    await until(() => document.querySelectorAll("#workspace .task-entry").length === 8, 8000);
    const leadText = document.getElementById("workspace").textContent;
    const leadEntries = document.querySelectorAll("#workspace .task-entry").length;
    return { pass: own.join() === "sched-drain-003,sched-metrics-002" && ownText.includes(tx("yes · source desk-core-scheduler-1"))
      && ownText.includes(tx("Tasks from the world lead")) && ownCurrent.join() === tx("in progress,report")
      && leadText.includes(tx("Tasks given out")) && leadEntries === 8 && leadText.includes(tx("Agent chat")),
    own, ownCurrent, leadEntries };
  })()`,
  // Block 3: the sync chip says where the world is; the sync sheet lists each
  // project with what a release does to it (hand-off, backup, nothing) and offers
  // "Hand over all…" while the world is here.
  "ui-a36-sync-sheet": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    refreshSync();
    const chip = await until(() => !document.getElementById("syncToggle").classList.contains("hidden"), 8000);
    const chipText = document.getElementById("syncToggle").textContent;
    document.getElementById("syncToggle").click();
    const sheet = document.getElementById("sheet");
    await until(() => sheet.textContent.includes("atlas-dev-fixture-office"), 8000);
    const text = sheet.textContent;
    const buttons = [...sheet.querySelectorAll("button")].map((button) => button.textContent);
    // With the world given away the map is empty: the line above it says why and what to press.
    const here = atlasState.sync;
    paintSyncToggle({ ...here, world: { held: false, remote: { reachable: true, initialized: true, holder: "office" } } });
    const away = document.getElementById("dataNotice");
    const notice = away.classList.contains("hidden") ? "" : away.textContent;
    paintSyncToggle(here);
    const back = document.getElementById("dataNotice");
    const restored = back.classList.contains("hidden") ? "" : back.textContent;
    // "Readiness" names the mode (plan 5.1); a local instance has no chip.
    closeSheet();
    atlasOpenReadiness();
    const readiness = document.getElementById("readinessBody").textContent;
    closeReadiness();
    paintSyncToggle({ configured: true, mode: "local" });
    const localChip = !document.getElementById("syncToggle").classList.contains("hidden");
    paintSyncToggle(here);
    return { pass: chip && chipText.includes('here') && text.includes('Sync between PCs')
      && readiness.includes('Mode: synced') && readiness.includes('This PC — "Home"') && !localChip
      && text.includes('this PC only: "Hand over" makes a backup') && text.includes('held by: this PC')
      && text.includes('held by: nobody (free)') && buttons.includes('Hand over…') && buttons.includes('Back up…')
      && buttons.includes('Take…') && buttons.includes('Hand over all…') && !buttons.includes('Take all…')
      && notice.includes('The world was handed over from this PC') && notice.includes('"Office"') && notice.includes('"Take all…"')
      && !restored.includes('World handed over'),
    chipText, buttons, notice };
  })()`,
  // The trace tab is read again every 2.5 s: a block the person opened stays open
  // (and one they closed stays closed), and nothing is rebuilt when no record came.
  "ui-a37-trace-keeps-open": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents[1] ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId }, { tab: "trace" });
    const listed = await until(() => document.querySelectorAll("#traceList details").length >= 3, 8000);
    const details = [...document.querySelectorAll("#traceList details")];
    const thinking = details.find((node) => node.querySelector("summary")?.textContent === tx("thinking text"));
    const input = details.find((node) => node.querySelector("summary")?.textContent === tx("input"));
    const closedBefore = thinking?.open === false && input?.open === true;
    thinking.open = true;
    input.open = false;
    thinking.dataset.probe = "kept";
    await pause(6500);
    const sameNode = thinking.isConnected && thinking.dataset.probe === "kept";
    const stillOpen = thinking.open === true && input.open === false;
    // A rebuilt list (another agent's tab and back) restores both by the record's key.
    closeWorkspace();
    await pause(300);
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId }, { tab: "trace" });
    await until(() => document.querySelectorAll("#traceList details").length >= 3, 8000);
    const again = [...document.querySelectorAll("#traceList details")];
    const thinkingAgain = again.find((node) => node.querySelector("summary")?.textContent === tx("thinking text"));
    const inputAgain = again.find((node) => node.querySelector("summary")?.textContent === tx("input"));
    const restored = thinkingAgain?.open === true && inputAgain?.open === false;
    closeWorkspace();
    return { pass: listed && closedBefore && sameNode && stillOpen && restored, listed, closedBefore, sameNode, stillOpen, restored };
  })()`,
  // Block 3: grey frames of projects not on this PC. One stands where the world part puts it, one
  // with no place yet goes to a column right of the others; the ticks of "Not on this PC" hide all
  // of them or one, as a setting of this PC's window; the world's bounds (the minimap, "Whole
  // world") hold the frames shown. The buttons at the top right keep their words on one line
  // and a sheet opens below them. The fixture's instance is not split, so the world's list is the
  // scene's own.
  "ui-a38-away-frames": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const saved = { away: atlasState.away, frames: atlasState.ui.awayFrames, hidden: atlasState.ui.awayHidden };
    const awayButton = document.getElementById("awayToggle");
    const awayButtonHidden = awayButton.classList.contains("hidden");
    refreshSync();
    awayButton.classList.remove("hidden");
    await until(() => !document.getElementById("syncToggle").classList.contains("hidden"), 8000);
    const office = { machineId: "office", title: tx("Office"), atUtc: "2026-10-27T09:00:00.000Z" };
    const summary = { agents: 2, quarters: 1, tasksOpen: 0, lastActivityUtc: "2026-10-27T08:59:00.000Z" };
    atlasState.away = { split: true, thisMachine: { machineId: "home", title: tx("Home"), home: true },
      machines: { office: { title: tx("Office"), home: false } }, known: [], projects: [
        { projectId: "away-placed", title: tx("With a place"), archived: false, location: office,
          policy: { homeOnly: false, allowedMachines: ["office"] }, summary },
        { projectId: "away-new", title: tx("Without a place"), archived: false, location: office,
          policy: { homeOnly: false, allowedMachines: null }, summary }] };
    setPanel("awayFrames", true);
    setPanel("awayHidden", []);
    scene.layout.projects["away-placed"] = { x: -2400, y: -1600, width: 500, height: 260 };
    const ids = () => awayBoxes().map(({ item }) => item.projectId).join();
    const boxes = awayBoxes();
    const placed = boxes.find(({ item }) => item.projectId === "away-placed")?.box;
    const fresh = boxes.find(({ item }) => item.projectId === "away-new")?.box;
    const others = Object.entries(scene.layout.projects).filter(([id, box]) => id !== "away-new" && Number.isFinite(box?.x));
    const besideAll = fresh !== undefined && fresh.width === 420
      && others.every(([, box]) => fresh.x >= box.x + box.width + 59);
    const rightOf = (bounds) => bounds.x + bounds.width;
    const inBounds = fresh !== undefined && rightOf(worldBounds()) >= fresh.x + fresh.width;
    const body = openSheet(tx("Not on this PC"), tx("trusted action"));
    const list = document.createElement("div");
    body.append(list);
    paintAwayList(list, document.createElement("div"), async () => {});
    await pause(200);
    const buttons = [...document.querySelectorAll("#stateHud .hud-row button")].filter((button) => !button.classList.contains("hidden"));
    const oneLine = buttons.length >= 6 && buttons.every((button) => button.getBoundingClientRect().height < 40);
    const hudBottom = document.getElementById("stateHud").getBoundingClientRect().bottom;
    const sheetTop = document.getElementById("sheet").getBoundingClientRect().top;
    const below = sheetTop >= hudBottom;
    const ticks = () => [...list.querySelectorAll("input[type=checkbox]")];
    const labels = [...list.querySelectorAll(".check-row")].map((row) => row.textContent);
    // A tick is a small box with its words beside it, and nothing runs off the sheet's edge.
    const row = list.querySelector(".check-row");
    const tick = row.querySelector("input").getBoundingClientRect();
    const words = row.querySelector("span").getBoundingClientRect();
    const tidy = tick.width < 40 && words.left > tick.right - 1 && words.top < tick.bottom
      && list.scrollWidth <= list.clientWidth + 1;
    ticks()[2].click();
    const oneHidden = ids();
    ticks()[0].click();
    const allHidden = ids();
    const outOfBounds = fresh !== undefined && rightOf(worldBounds()) < fresh.x;
    const disabled = ticks().slice(1).every((input) => input.disabled);
    ticks()[0].click();
    const back = ids();
    await pause(300);
    const stored = (await window.atlas.readUiState()).data;
    const text = list.textContent;
    const restoreButton = () => [...list.querySelectorAll("button")].find((button) => button.textContent.startsWith("Show hidden frames"));
    const offered = restoreButton()?.textContent ?? "";
    restoreButton()?.click();
    const restored = ids();
    const gone = restoreButton() === undefined;
    closeSheet();
    delete scene.layout.projects["away-placed"];
    atlasState.away = saved.away;
    setPanel("awayFrames", saved.frames);
    setPanel("awayHidden", saved.hidden);
    if (awayButtonHidden) awayButton.classList.add("hidden");
    requestRender();
    return { pass: placed?.x === -2400 && placed?.width === 500 && besideAll && inBounds && outOfBounds
      && oneLine && below
      && labels[0].includes('Show grey frames') && labels.length === 3 && tidy
      && labels[1].includes("This project's frame on the map")
      && text.includes('on PC "Office"') && text.includes('only on PC: Office') && text.includes('agents: 2')
      && oneHidden === "away-placed" && allHidden === "" && disabled && back === "away-placed"
      && stored?.awayFrames === true && stored?.awayHidden?.join() === "away-new"
      && offered.includes("(1)") && restored === "away-placed,away-new" && gone,
    fresh, inBounds, outOfBounds, oneLine, below, hudBottom, sheetTop,
    buttons: buttons.map((button) => [button.textContent.trim(), Math.round(button.getBoundingClientRect().height)]),
    labels, tidy, tick: { width: tick.width, left: tick.left }, words: { left: words.left, top: words.top },
    oneHidden, allHidden, disabled, back, offered, restored, gone,
    stored: { frames: stored?.awayFrames, hidden: stored?.awayHidden } };
  })()`,
  // Owner 31.10: what is connected. "Readiness" lists the model servers (the fixture's office Qwen is off,
  // this PC's answers) with "Check now"; a model's name in a list says when it does not answer.
  "ui-a39-model-health": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    await refreshModelHealth({ force: true });
    atlasOpenReadiness();
    await pause(200);
    const rows = [...document.querySelectorAll("#readinessBody .ready-row")].map((row) => row.textContent);
    const office = rows.find((row) => row.includes("Qwen (office)")) ?? "";
    const local = rows.find((row) => row.includes("Qwen (this PC)")) ?? "";
    const button = document.getElementById("modelHealthCheck");
    const suffix = modelStateSuffix("fixture-qwen-office");
    const quiet = modelStateSuffix("fixture-qwen-local");
    closeReadiness();
    return { pass: office.includes("not answering") && office.includes("office-pc:8080") && local.includes("answers")
      && button !== null && button.textContent === "Check now" && suffix === " — not answering" && quiet === "",
    office, local, suffix, quiet };
  })()`,
  // The history of changes: an archived and restored project shows both changes; "Undo" on
  // the restore (confirmed) archives it again by a new entry, and the restore says it is undone.
  "ui-a40-history": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    const project = "ui-a40-history-demo";
    await window.atlas.archiveProject({ projectId: project });
    await window.atlas.restoreProject({ projectId: project });
    await atlasOpenHistory(project);
    // The fixture keeps its journal between runs: what counts is one entry more after the undo.
    // An entry is one line; a click on it opens its details with "Undo".
    const count = () => document.querySelectorAll("#sheet .history-entry").length;
    await until(() => count() >= 2, 8000);
    const titles = () => [...document.querySelectorAll("#sheet .history-title")].map((node) => node.textContent);
    const before = titles();
    const listed = count();
    const first = document.querySelector("#sheet .history-entry");
    const closed = first.querySelector(".history-details").classList.contains("hidden");
    first.querySelector(".history-row").click();
    const opened = !first.querySelector(".history-details").classList.contains("hidden");
    const undo = first.querySelector(".history-details button");
    const label = undo?.textContent ?? null;
    undo?.click();
    await until(() => count() === listed + 1, 8000);
    const after = titles();
    const rows = [...document.querySelectorAll("#sheet .history-entry")].map((node) => node.textContent);
    const archived = await window.atlas.archivedProjects();
    await window.atlas.restoreProject({ projectId: project });
    return { pass: before[0] === "Project " + project + " restored" && before[1] === "Project " + project + " archived"
      && closed && opened && label === tx("Undo") && after[0] === "Undo · Project " + project + " archived"
      && rows[1].includes(tx("undone")) && rows[0].includes(tx("This is an undo: to repeat the change, make it again."))
      && archived.ok && archived.data.projects.some((item) => item.projectId === project),
    before, after, label };
  })()`,
  // Names: an agent renamed in its sheet is shown by its name (the ID beside it in the
  // tooltip); a create form proposes an ID made from the name; null brings the ID back.
  "ui-a41-names": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    await until(() => atlasState.trusted?.available === true, 8000);
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const agent = agents.find((item) => item.state !== "archived");
    openRenameSheet("agent", agent.projectId, agent.agentId);
    await pause(200);
    document.querySelector("#sheet input").value = "Nova the planner";
    [...document.querySelectorAll("#sheet button")].find((button) => button.textContent === tx("Save name"))?.click();
    await until(() => displayName("agent", agent.projectId, agent.agentId) === "Nova the planner", 8000);
    selectNode({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId });
    atlasShowTooltip({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId }, { x: 300, y: 300 });
    const tooltip = document.querySelector("#tooltip strong")?.textContent ?? null;
    await pause(400);
    atlasHideTooltip();
    openCreateAgentSheet(agent.projectId, agent.quarterId);
    await until(() => document.querySelectorAll("#sheet input").length >= 2, 5000);
    const [nameField, idField] = document.querySelectorAll("#sheet input");
    nameField.value = "Payment gateway";
    nameField.dispatchEvent(new Event("input"));
    const proposed = idField.value;
    closeSheet();
    await window.atlas.rename({ projectId: agent.projectId, kind: "agent", objectId: agent.agentId, name: null });
    await loadNames({ force: true });
    return { pass: tooltip === "Nova the planner · " + agent.agentId && /^payment-gateway-[0-9a-z]{4}$/u.test(proposed)
      && displayName("agent", agent.projectId, agent.agentId) === agent.agentId, tooltip, proposed, agentId: agent.agentId };
  })()`,
  // Double-click on an attention badge, as the mouse does it: a number opens the list of
  // what is behind it (even for one agent); a "?" - one question - opens the agent's chat.
  "ui-a42-badge-double-click": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    goLevel(LEVEL.world);
    await pause(1200);
    const rect = scene.canvas.getBoundingClientRect();
    const doubleClick = (badge) => scene.canvas.dispatchEvent(new MouseEvent("dblclick",
      { clientX: rect.left + badge.x, clientY: rect.top + badge.y, bubbles: true }));
    const counted = scene.badges.find((item) => item.signal.count > 1);
    doubleClick(counted);
    await pause(500);
    const listOpened = atlasState.ui.attentionOpen === true && !isWorkspaceOpen();
    const listScope = atlasState.attentionScope;
    setPanel("attentionOpen", false);
    await pause(300);
    const question = scene.badges.find((item) => item.signal.count === 1 && item.signal.severity === 1);
    doubleClick(question);
    await pause(1500);
    const chatOpened = isWorkspaceOpen();
    const chatAgent = workspaceState.node?.agentId ?? null;
    if (chatOpened) closeWorkspace();
    return { pass: listOpened && listScope?.projectId === counted.node.projectId && chatOpened,
      counted: counted.signal.count, listOpened, listScope, question: question?.node ?? null, chatOpened, chatAgent };
  })()`,
  "hq-lead": `(async () => {
    const project = atlasState.world.projection.projects[0];
    goProject(project.projectId, { instant: true });
    atlasOpenHeadquarters(project.projectId);
    await new Promise((done) => setTimeout(done, 600));
    return { sheet: document.getElementById("sheet").textContent.includes(tx("Project lead")) };
  })()`,
  "chat-queued": `(async () => {
    const agents = atlasState.world.projection.projects.flatMap((p) => p.quarters.flatMap((q) => q.agents));
    const a = agents.find((item) => item.state === "active" && item.currentOperationId === null) ?? agents[0];
    atlasOpenWorkspace({ kind: "agent", projectId: a.projectId, quarterId: a.quarterId, agentId: a.agentId });
    await new Promise((done) => setTimeout(done, 1500));
    const first = await window.atlas.steer({ agentId: a.agentId, text: tx("Start with the project memory."), mode: "steer" });
    await refresh({ silent: true });
    const queued = await window.atlas.steer({ agentId: a.agentId, text: tx("Then check the README."), mode: "queue" });
    workspaceState.queued.set(a.agentId, [{ operationId: queued.data.identity.operationId, text: tx("Then check the README.") }]);
    renderWorkspace();
    await new Promise((done) => setTimeout(done, 800));
    return { first: first.data?.output?.delivery ?? null, queued: queued.data?.output?.delivery ?? null,
      steer: document.getElementById("chatSteer")?.checked ?? null, model: document.getElementById("chatModel")?.value ?? null };
  })()`,
  world: "goLevel(LEVEL.world)",
  // PROTOTYPE: the direct mode once Claude Code has named its account (it is asked in the background).
  "direct-account": "(async () => { const end = Date.now() + 30000; while (Date.now() < end && (atlasState.runtime?.claudeAccount?.state ?? 'checking') === 'checking') { await new Promise((done) => setTimeout(done, 250)); } await refresh({ silent: true }); goLevel(LEVEL.world); })()",
  // PROTOTYPE: an agent's Memory tab in the direct mode - its own notes and its write zone.
  "direct-agent-notes": tx("(async () => { const p = atlasState.world.projection.projects[0]; const q = p.quarters[0]; atlasOpenWorkspace({ kind: 'agent', projectId: p.projectId, quarterId: q.quarterId, agentId: q.agents[0].agentId }); await new Promise((done) => setTimeout(done, 1200)); workspaceState.tab = 'context'; renderWorkspace(); await new Promise((done) => setTimeout(done, 1200)); const panel = document.getElementById('workspace'); const title = [...panel.querySelectorAll('.section-title')].find((node) => node.textContent === 'Agent memory'); if (title) title.scrollIntoView(); })()"),
  project: "goProject(atlasState.world.projection.projects[0].projectId)",
  quarter: `(() => { const p = atlasState.world.projection.projects[0];
    goQuarter(p.projectId, p.quarters[0].quarterId); })()`,
  agent: `(() => { const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    atlasOpenWorkspace({ kind: "agent", projectId: p.projectId, quarterId: q.quarterId,
      agentId: q.agents[0].agentId }); })()`,
  skills: `(() => { const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    const node = { kind: "agent", projectId: p.projectId, quarterId: q.quarterId,
      agentId: q.agents[0].agentId };
    atlasOpenWorkspace(node); atlasOpenSkills(node); })()`,
  "attention-world": `(async () => {
    goLevel(LEVEL.world);
    await new Promise((done) => setTimeout(done, 900));
    const badge = scene.badges.find((item) => item.node.scopeKind === "project");
    if (badge) atlasShowTooltip(badge.node, { x: badge.x, y: badge.y });
  })()`,
  "attention-project": `(async () => {
    goProject("platform-core");
    await new Promise((done) => setTimeout(done, 900));
    const badge = scene.badges.find((item) => item.node.scopeKind === "quarter");
    if (badge) atlasShowTooltip(badge.node, { x: badge.x, y: badge.y });
  })()`,
  "attention-quarter": `(async () => {
    goQuarter("platform-core", "core-q1");
    await new Promise((done) => setTimeout(done, 900));
    const badge = scene.badges.find((item) => item.node.scopeKind === "agent");
    if (badge) atlasShowTooltip(badge.node, { x: badge.x, y: badge.y });
  })()`,
  chat: `(async () => {
    const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    atlasOpenWorkspace({ kind: "agent", projectId: p.projectId, quarterId: q.quarterId,
      agentId: q.agents[0].agentId });
    await new Promise((done) => setTimeout(done, 1500));
    const first = document.querySelector("#chatFeed details.feed-activity");
    if (first) first.open = true;
    document.getElementById("chatFeed").scrollTop = 0;
  })()`,
  "quarter-context": `(async () => {
    const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    const node = { kind: "agent", projectId: p.projectId, quarterId: q.quarterId, agentId: q.agents[0].agentId };
    atlasOpenWorkspace(node);
    await new Promise((done) => setTimeout(done, 1500));
    closeWorkspace();
    await new Promise((done) => setTimeout(done, 1200));
    selectNode(node);
    $("inspector").classList.add("hidden");
  })()`,
  readiness: `(async () => {
    goLevel(LEVEL.world);
    await new Promise((done) => setTimeout(done, 600));
    atlasOpenReadiness();
    await new Promise((done) => setTimeout(done, 600));
  })()`,
  "readiness-expected": `(async () => {
    goLevel(LEVEL.world);
    await new Promise((done) => setTimeout(done, 600));
    atlasOpenReadiness();
    await new Promise((done) => setTimeout(done, 900));
    document.getElementById("readinessBody").scrollTop = 100000;
  })()`,
  // The Gateway panel on the fixture's fake agents-factory CLI: a start refused
  // with its exact code (the fixture's first start fails once), the key typed into a masked field and never
  // seen again, a start with progress, then running and the window reconnected;
  // autostart turned on through the host's confirmation (answered by the scene).
  "ui-a31-gateway-panel": `(async () => {
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await pause(60); } return false; };
    goLevel(LEVEL.world);
    await pause(500);
    atlasOpenReadiness();
    const panel = document.getElementById("gatewayPanel");
    const part = (name) => panel.querySelector('[data-gateway="' + name + '"]');
    const text = (name) => part(name)?.textContent ?? "";
    await until(() => !panel.classList.contains("hidden") && text("key-chip") === tx("not set"), 10000);
    const first = { title: text("gateway-title"), chip: text("gateway-chip"), start: part("start").disabled,
      stop: part("stop").disabled, recover: part("recover").disabled };
    part("start").click();
    await until(() => text("failure").includes("gateway_start_timeout"), 10000);
    const refused = text("failure");
    const fakeKey = "sk-ant-fixture-" + "0123456789".repeat(4);
    const input = part("key-input");
    const masked = input.type === "password";
    input.value = fakeKey;
    part("key-save").click();
    const cleared = input.value === "";
    await until(() => text("key-chip") === tx("saved"), 10000);
    part("start").click();
    await until(() => text("progress").startsWith(tx("Starting")), 5000);
    const progress = text("progress");
    await until(() => text("gateway-title") === tx("Gateway: running") && !part("stop").disabled, 15000);
    const running = { title: text("gateway-title"), chip: text("gateway-chip"), start: part("start").disabled,
      stop: part("stop").disabled, recover: part("recover").disabled };
    await until(() => atlasState.connection?.available === true && !atlasState.busy, 5000);
    const box = part("autostart");
    box.click();
    await until(() => box.checked && !box.disabled, 10000);
    const leaked = [document.body.innerHTML, logText(), JSON.stringify(atlasState.ui), JSON.stringify(atlasState.log)]
      .some((value) => value.includes(fakeKey));
    const logged = atlasState.log.map((entry) => entry.what);
    return { pass: first.title === tx("Gateway: never started") && first.start === false && first.stop === true
      && refused === tx("Gateway not started: gateway_start_timeout") && masked && cleared && progress.startsWith(tx("Starting"))
      && running.chip === "gateway_ready" && running.start === true && running.stop === false
      && atlasState.connection?.available === true && box.checked && !leaked
      && logged.includes(tx("Gateway started")) && logged.includes(tx("API key saved"))
      && logged.includes(tx("Gateway autostart on")),
    first, refused, masked, cleared, progress, running, autostart: box.checked, leaked, logged };
  })()`,
  "attention-between": `(async () => {
    goProject("mobile-client");
    await new Promise((done) => setTimeout(done, 700));
    sceneZoomBy(1 / 1.8);
    await new Promise((done) => setTimeout(done, 700));
  })()`,
  "attention-list": `(async () => {
    goProject("platform-core");
    await new Promise((done) => setTimeout(done, 900));
    const badge = scene.badges.find((item) => item.node.scopeKind === "quarter");
    if (badge) commitClick(badge.node);
  })()`,
  paste: `(() => { const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    goProject(p.projectId);
    selectNode({ kind: "quarter", projectId: p.projectId, quarterId: q.quarterId, agentId: null });
    atlasCopyBlueprint(); atlasPasteBlueprint(); })()`,
  tasks: `(() => { const p = atlasState.world.projection.projects[0];
    const q = p.quarters[0];
    atlasOpenWorkspace({ kind: "agent", projectId: p.projectId, quarterId: q.quarterId,
      agentId: q.agents[0].agentId });
    workspaceState.tab = "tasks"; renderWorkspace(); })()`,
  // The create-agent form's lists as the backend sent them: the provider, the
  // models, and for each model the efforts its list offers. Nothing is created.
  "create-agent-profile": `(async () => {
    const p = atlasState.world?.projection?.projects?.[0];
    const q = p?.quarters?.[0];
    await openCreateAgentSheet(p?.projectId ?? "project", q?.quarterId ?? "quarter");
    const lists = [...document.querySelectorAll("#sheetBody select.field")];
    const [provider, model, effort] = lists;
    const values = (select) => [...(select?.options ?? [])].map((option) => option.value);
    const models = values(model);
    const efforts = {};
    for (const id of models) {
      model.value = id; model.dispatchEvent(new Event("change"));
      efforts[id] = values(effort);
    }
    if (models.length > 0) { model.value = models[0]; model.dispatchEvent(new Event("change")); }
    return { pass: lists.length === 3 && models.length > 0, provider: values(provider), models, efforts,
      selected: { model: model?.value ?? null, effort: effort?.value ?? null } };
  })()`,
});

// An unattended capture never shares the Chromium profile (cache, GPU cache)
// with a window the owner has open, nor with a previous capture that is still
// shutting down - both made the GPU process fail and the camera stop. Each
// capture gets its own profile under the system temp folder. Map layouts are
// not in this profile; they live in the application's own user-data.
if (process.argv.includes("--capture")) {
  app.setPath("userData", path.join(os.tmpdir(), `atlas-capture-${process.pid}`));
  // A capture window covered by another window counted as hidden on Windows
  // (native occlusion), and a hidden page gets no animation frames: the camera
  // stopped mid-flight and scenes that need it failed. Captures keep frames
  // coming whatever covers them.
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
}

const mode = resolveMode(process.argv);
lockDownNavigation();

// Electron evaluates an ESM entry point before it emits "ready". Awaiting
// app.whenReady() at the top level therefore deadlocks: the module waits for an
// event that cannot be emitted until the module finishes. All startup work
// belongs inside this callback.
app.whenReady().then(async () => {
  const session = await createSession({ projectRoot: PROJECT_ROOT, mode, confirm, chooseDirectory });
  if (session.delivery?.status !== "verified") {
    // The window still opens, to say so; nothing in it can connect or change anything.
    process.stderr.write(`atlas: frontend kit delivery rejected (${session.delivery?.reasonCode ?? "unknown"})\n`);
  }
  const userData = USER_DATA;
  // The host's own texts in the window's language from the start (dialogs, confirmations).
  windowLocale();
  // A split instance keeps the map beside its stores (layout-split.mjs); otherwise Atlas's own file.
  const layoutStore = createInstanceLayoutStore({
    controllerRoot: session.controllerRoot ?? null,
    legacy: createLayoutStore({ directory: userData, environment: session.environment }),
    directory: userData,
    environment: session.environment,
  });
  const uiStateStore = createUiStateStore({ directory: userData });
  const turnSeenStore = createTurnSeenStore({ directory: userData, environment: session.environment });
  registerChannels(createChannels({
    session, appVersion: await appVersion(), saveText, openText, layoutStore, uiStateStore,
    turnSeenStore, chooseEvidenceDirectory,
  }));
  const window = createWindow(mode);

  // Development aid: --capture <file> renders the window once, writes a PNG and
  // quits. It is a screenshot, nothing more - no data leaves this process by it.
  // --capture-scene picks one of the fixed scenes below; nothing outside this
  // list can be executed, so the flag cannot become a way to run arbitrary code.
  const captureIndex = process.argv.indexOf("--capture");
  if (captureIndex !== -1 && process.argv[captureIndex + 1] !== undefined) {
    const target = path.resolve(process.argv[captureIndex + 1]);
    const sceneIndex = process.argv.indexOf("--capture-scene");
    const sceneName = sceneIndex === -1 ? "world" : process.argv[sceneIndex + 1];
    // --scene-result <file> also writes what the scene checked, as JSON: the
    // regression pack (tools/test-ui-scenes.mjs) reads facts, not pictures.
    const resultIndex = process.argv.indexOf("--scene-result");
    const resultPath = resultIndex === -1 || process.argv[resultIndex + 1] === undefined
      ? null : path.resolve(process.argv[resultIndex + 1]);
    // Whatever happens inside the page, an unattended capture ends.
    const watchdog = setTimeout(() => app.exit(3), 60_000);
    window.webContents.once("did-finish-load", async () => {
      const report = { scene: sceneName, ready: false, result: null, error: null, capture: "not-attempted" };
      // Wait until the world has been read - not a fixed delay - but not forever.
      const readyBy = Date.now() + 15_000;
      while (Date.now() < readyBy) {
        const ready = await window.webContents.executeJavaScript(
          "typeof atlasState !== 'undefined' && atlasState.world !== null && atlasState.started === true",
        ).catch(() => false);
        if (ready) {
          report.ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const script = CAPTURE_SCENES[sceneName];
      if (script === undefined) {
        report.error = "unknown_scene";
      } else {
        try {
          report.result = await window.webContents.executeJavaScript(script);
        } catch (error) {
          report.error = String(error?.message ?? error).slice(0, 300);
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      // capturePage can reject (the GPU process may be gone); that is reported,
      // and the process still quits instead of hanging.
      try {
        const image = await window.webContents.capturePage();
        await writeFile(target, image.toPNG());
        report.capture = "written";
      } catch (error) {
        report.capture = "failed";
        process.stderr.write(`capture failed: ${String(error?.message ?? error).slice(0, 200)}\n`);
      }
      report.autoConfirmed = autoConfirmed.slice();
      if (resultPath !== null) {
        await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
      }
      clearTimeout(watchdog);
      app.quit();
    });
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(mode);
});

// The window may hold an unwritten change - a note being typed, a node just
// dragged. Closing asks it to write first, and quits either when it reports back
// or after a short grace period, so a crash in the page cannot hold the app open.
let flushing = false;
app.on("before-quit", (event) => {
  if (flushing || mainWindow === null || mainWindow.isDestroyed()) return;
  event.preventDefault();
  flushing = true;
  mainWindow.webContents.send("atlas:flush");
  ipcMain.once("atlas:flushed", () => app.quit());
  setTimeout(() => app.quit(), 800);
});

app.on("window-all-closed", () => {
  // Closing the window closes this client only. It never stops the gateway.
  app.quit();
});

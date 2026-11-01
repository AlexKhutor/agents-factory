"use strict";

// A test run that is seen without being in the way (the owner's check of 01.11: the
// checks ran in the background and nothing showed whether they were running).
//
//   electron tools/test-monitor.cjs --status-file <file> [--label <words>]
//
// One small window per PC, with a taskbar button: Windows fills the button's progress
// bar as the run goes (red once something failed), its title says how far it is and
// what runs now, and hovering the button shows the list. The window itself opens past
// the right edge of the displays, inactive: it never comes up over the person's windows
// and never takes the focus. When the person clicks its taskbar button it comes onto the
// screen. A second launch hands its status file to the window already open. The window
// reads the run's status file (tools/ui-run-status.mjs format) every half second and goes
// away a while after the run ends.

const { app, BrowserWindow, screen } = require("electron");
const { readFileSync } = require("node:fs");
const path = require("node:path");

// After the run: a passed one closes soon (the person saw it end), a failed or stopped one stays
// for a while so what failed can be read; the person may close it any time.
const PASSED_LINGER_MS = 10 * 1000;
const LINGER_MS = 15 * 60 * 1000;
const POLL_MS = 500;
// A run whose status has not changed for this long has stopped without saying so (its runner died).
const STALE_MS = 5 * 60 * 1000;
const stale = (status) => status !== null && status.phase !== "finished" && status.updatedAtUtc
  && Date.now() - Date.parse(status.updatedAtUtc) > STALE_MS;

const argument = (argv, name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
};

app.setPath("userData", path.join(require("node:os").tmpdir(), "atlas-test-monitor"));
let watched = { file: argument(process.argv, "--status-file"), label: argument(process.argv, "--label") ?? "Checks" };
// A second launch hands its run over through the lock's own data: Chromium adds its switches to
// the command line the first instance sees, so the arguments there are not the launch's own.
if (!app.requestSingleInstanceLock({ file: watched.file, label: watched.label })) app.exit(0);

let window = null;
let finishedAt = null;
let lastSequence = -1;

app.on("second-instance", (_event, _argv, _directory, data) => {
  if (typeof data?.file !== "string" || !data.file) return;
  watched = { file: data.file, label: typeof data.label === "string" && data.label ? data.label : "Checks" };
  finishedAt = null;
  lastSequence = -1;
});

function readStatus() {
  try { return JSON.parse(readFileSync(watched.file, "utf8")); } catch { return null; }
}

function titleOf(status) {
  if (status === null) return `${watched.label} · waiting`;
  const done = status.counts.passed + status.counts.failed + (status.counts.skipped ?? 0);
  const failed = status.counts.failed > 0 ? ` · ${status.counts.failed} failed` : "";
  if (status.phase === "finished") return `${watched.label} · ${status.status} ${done}/${status.total}${failed}`;
  if (stale(status)) return `${watched.label} · stopped at ${done}/${status.total}${failed}`;
  return `${watched.label} · ${done}/${status.total}${failed} · ${status.current?.name ?? ""}`;
}

function update() {
  if (window === null || window.isDestroyed()) return;
  const status = readStatus();
  if (status !== null && status.sequence !== lastSequence) {
    lastSequence = status.sequence;
    window.webContents.executeJavaScript(`render(${JSON.stringify({ label: watched.label, status })})`).catch(() => {});
  }
  window.setTitle(titleOf(status));
  if (status !== null) {
    const done = status.counts.passed + status.counts.failed + (status.counts.skipped ?? 0);
    const mode = status.counts.failed > 0 ? "error" : "normal";
    window.setProgressBar(status.total > 0 ? Math.max(0.02, done / status.total) : 2, { mode });
    if ((status.phase === "finished" || stale(status)) && finishedAt === null) finishedAt = Date.now();
  }
  const passed = status?.phase === "finished" && status.counts.failed === 0 && status.status !== "failed";
  if (finishedAt !== null && Date.now() - finishedAt > (passed ? PASSED_LINGER_MS : LINGER_MS)) app.quit();
}

app.whenReady().then(async () => {
  const right = Math.max(...screen.getAllDisplays().map(({ bounds }) => bounds.x + bounds.width));
  window = new BrowserWindow({
    width: 460, height: 560, x: right + 200, y: 0, show: false, title: watched.label,
    backgroundColor: "#1b2017", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.removeMenu();
  // The person clicked the taskbar button: the window comes onto the screen, at the bottom right.
  window.on("focus", () => {
    const area = screen.getPrimaryDisplay().workArea;
    const [width, height] = window.getSize();
    const bounds = window.getBounds();
    const seen = screen.getAllDisplays().some(({ bounds: display }) => bounds.x < display.x + display.width
      && bounds.x + bounds.width > display.x);
    if (!seen) window.setPosition(area.x + area.width - width - 16, area.y + area.height - height - 16);
  });
  await window.loadFile(path.join(__dirname, "test-monitor.html"));
  window.showInactive();
  update();
  setInterval(update, POLL_MS);
});

app.on("window-all-closed", () => app.quit());

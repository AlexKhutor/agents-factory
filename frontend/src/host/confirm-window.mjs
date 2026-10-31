// The confirmation a person answers before a change: a small window of its own,
// in Atlas's colours, owned by this host process.
//
// It replaces the operating system's dialog and keeps what that dialog
// guaranteed: renderer code of the main window cannot press its button. The
// main window's page has no channel to it, and an answer is accepted only from
// this window's own contents and only with this request's token. Closing the
// window, Escape or any failure answers "no".

import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import { tx } from "./i18n.mjs";

const CHANNEL = "atlas-confirm";
const WIDTH = 500;

/**
 * Opens one confirmation and resolves true only when the person pressed its
 * confirm button. `onShown(window)` is a development aid for captures.
 */
export function openConfirmWindow({ parent = null, page, preload, request, onShown = null }) {
  return new Promise((resolve) => {
    const token = randomUUID();
    const owner = parent !== null && !parent.isDestroyed() ? parent : null;
    const window = new BrowserWindow({
      ...(owner === null ? {} : { parent: owner, modal: true }),
      width: WIDTH,
      height: 260,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      skipTaskbar: owner !== null,
      backgroundColor: "#222720",
      title: String(request.title ?? tx("Confirmation")),
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    window.removeMenu();

    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(CHANNEL, onMessage);
      if (!window.isDestroyed()) window.destroy();
      resolve(accepted === true);
    };

    // Windows gives a frameless, non-resizable window less than it
    // asked for (500×261 becomes 484×253): the text wraps onto an extra
    // line, and the buttons go past the edge. So the actual size is compared
    // with the needed one, and the shortfall is made up.
    const fit = (reported) => {
      const height = Number.isFinite(reported) ? Math.min(Math.max(Math.ceil(reported), 140), 640) : 260;
      window.setContentSize(WIDTH, height);
      const [width, actual] = window.getContentSize();
      if (width !== WIDTH || actual !== height) {
        window.setContentSize(WIDTH * 2 - width, height * 2 - actual);
      }
    };

    function onMessage(event, message) {
      if (window.isDestroyed() || event.sender.id !== window.webContents.id) return;
      if (message === null || typeof message !== "object" || message.token !== token) return;
      if (message.kind === "size") {
        fit(message.height);
      } else if (message.kind === "ready") {
        fit(message.height);
        if (owner !== null) {
          const bounds = owner.getBounds();
          const [width, outerHeight] = window.getSize();
          window.setPosition(Math.round(bounds.x + (bounds.width - width) / 2),
            Math.round(bounds.y + (bounds.height - outerHeight) / 2));
        } else {
          window.center();
        }
        window.show();
        window.focus();
        if (typeof onShown === "function") onShown(window);
      } else if (message.kind === "answer") {
        finish(message.accepted === true);
      }
    }

    ipcMain.on(CHANNEL, onMessage);
    window.on("closed", () => finish(false));
    window.webContents.once("did-finish-load", () => {
      if (window.isDestroyed()) return;
      window.webContents.send(`${CHANNEL}:request`, {
        token,
        title: String(request.title ?? tx("Confirmation")),
        message: String(request.message ?? ""),
        detail: request.detail === undefined || request.detail === null ? "" : String(request.detail),
        confirmLabel: String(request.confirmLabel ?? tx("Confirm")),
        cancelLabel: tx("Cancel"),
      });
    });
    window.loadFile(page).catch(() => finish(false));
  });
}

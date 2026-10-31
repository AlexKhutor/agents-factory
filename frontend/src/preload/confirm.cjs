// The only opening of the confirmation window (src/host/confirm-window.mjs).
//
// Its page shows one request and gives one answer. The request's token stays in
// this file: the page can only say yes or no to the request it was shown.

const { contextBridge, ipcRenderer } = require("electron");

let token = null;

// The window's language, as the main window's (host/i18n.mjs): renderer/i18n-core.js reads atlas.locale.
contextBridge.exposeInMainWorld("atlas", { locale: ipcRenderer.sendSync("atlas:locale") });

contextBridge.exposeInMainWorld("atlasConfirm", {
  onRequest(handler) {
    if (typeof handler !== "function") return;
    ipcRenderer.on("atlas-confirm:request", (_event, request) => {
      token = request?.token ?? null;
      const { title, message, detail, confirmLabel, cancelLabel } = request ?? {};
      handler({ title, message, detail, confirmLabel, cancelLabel });
    });
  },
  ready(height) {
    if (token !== null) ipcRenderer.send("atlas-confirm", { token, kind: "ready", height: Number(height) });
  },
  // The height changed after showing (lines wrap differently at another width).
  resize(height) {
    if (token !== null) ipcRenderer.send("atlas-confirm", { token, kind: "size", height: Number(height) });
  },
  answer(accepted) {
    if (token === null) return;
    ipcRenderer.send("atlas-confirm", { token, kind: "answer", accepted: accepted === true });
    token = null;
  },
});

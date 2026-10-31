"use strict";

// The Gateway panel in “Readiness”: the state of the controller's Gateway, “Start” /
// “Stop” / “Recover”, the Anthropic API key and autostart when the user signs in to the
// system. The host does all of it through the agents-factory CLI (gateway-control.mjs);
// the page names no commands and no paths.
//
// API key: a masked input field; the text goes to the host once, the field
// is cleared at that same moment, and no page variable, journal or window
// state keeps it. All the page learns back is { hasKey }.
//
// The pure part (gatewayPanelView) is tested without a window; the DOM part
// runs only in the window and uses the shared functions of app.js (atlasRecord,
// refresh, atlasState) at call time.

(function (root, factory) {
  const node = typeof module === "object" && module !== null && module.exports;
  const api = factory(node ? require("./i18n-core.js") : root);
  if (node) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis === "undefined" ? this : globalThis, function (i18n) {
  const { tx } = i18n;
  const STATE_WORDS = Object.freeze({
    running: tx("running"), starting: tx("starting"), stopping: tx("stopping"), stopped: tx("stopped"),
    failed: tx("stopped by a failure"), uncertain: tx("state unknown"), stale: tx("not responding"),
    absent: tx("never started"), unknown: tx("gateway-panel::not reported"),
  });
  const STATE_TONES = Object.freeze({ running: "ok", starting: "wait", stopping: "wait", unknown: "wait" });

  // Which buttons make sense in which state. The CLI decides anyway: starting
  // a running Gateway changes nothing, stopping and recovering touch
  // only their own instance. An unknown state locks no button.
  const BUTTONS = Object.freeze({
    running: { start: false, stop: true, recover: false },
    starting: { start: false, stop: true, recover: false },
    stopping: { start: false, stop: false, recover: false },
    stopped: { start: true, stop: false, recover: false },
    failed: { start: true, stop: false, recover: false },
    uncertain: { start: true, stop: false, recover: false },
    absent: { start: true, stop: false, recover: false },
    stale: { start: true, stop: true, recover: true },
    unknown: { start: true, stop: true, recover: true },
  });

  const SOURCE_WORDS = Object.freeze({
    controller: tx("from the controller"), configured: tx("from the setting"), development: tx("development build"), fixture: tx("fixture"),
  });

  const PROGRESS_WORDS = Object.freeze({
    "gateway-start": tx("Starting…"), "gateway-stop": tx("Stopping…"), "gateway-recover": tx("Recovering…"),
    "api-key-set": tx("Saving the key…"), "api-key-remove": tx("Removing the key…"),
    "autostart-install": tx("Turning autostart on…"), "autostart-uninstall": tx("Turning autostart off…"),
  });
  const DONE_WORDS = Object.freeze({
    "gateway-start": tx("Gateway started"), "gateway-stop": tx("Gateway stopped"), "gateway-recover": tx("Gateway recovered"),
    "api-key-set": tx("API key saved"), "api-key-remove": tx("API key removed"),
    "autostart-install": tx("Gateway autostart on"), "autostart-uninstall": tx("Gateway autostart off"),
  });
  const FAILED_WORDS = Object.freeze({
    "gateway-start": tx("Gateway not started"), "gateway-stop": tx("Gateway not stopped"), "gateway-recover": tx("Gateway not recovered"),
    "api-key-set": tx("API key not saved"), "api-key-remove": tx("API key not removed"),
    "autostart-install": tx("Autostart not turned on"), "autostart-uninstall": tx("Autostart not turned off"),
  });

  const codeOf = (error) => error?.reasonCode ?? error?.code ?? "unknown";

  /** Why the Gateway cannot be controlled from here - in words, with the code in the badge. */
  function unavailableDetail(reasonCode) {
    if (reasonCode === "agents_factory_cli_missing") {
      return tx("agents-factory CLI not found: neither in the controller's .orchestrator/runtime nor at the path set by ")
        + tx("agentsFactoryCli in config/local.json.");
    }
    if (typeof reasonCode === "string" && reasonCode.startsWith("delivery_")) {
      return tx("Kit delivery not accepted: Gateway control is disabled.");
    }
    return tx("Controller not configured: fill in config/local.json and restart the window.");
  }

  /**
   * What the panel shows, from what the host reported. Nothing is filled in:
   * what the host did not report is “not reported” or “checking”, not zero and not “no”.
   *
   * @param status      the atlas:gateway-status answer (data), or null until read
   * @param key         { hasKey } | { error } | null
   * @param autostart   { installed } | { error } | null
   * @param pending     { kind, since } - an action started by this window, or null
   * @param failure     { kind, code, reasonCode, uncertain } - the last refusal, or null
   */
  function gatewayPanelView({
    status = null, key = null, autostart = null, pending = null, failure = null, keyFormOpen = false,
    now = Date.now(),
  } = {}) {
    if (status !== null && status.supported === false) return { visible: false };
    const cli = status?.cli ?? null;
    const usable = cli?.available === true;
    const hostAction = status?.action ?? null;
    const running = pending ?? (hostAction === null ? null
      : { kind: hostAction.kind, since: Date.parse(hostAction.startedAtUtc) });
    const busy = running !== null;

    let gateway;
    let allowed = { start: false, stop: false, recover: false };
    if (status === null) {
      gateway = { title: tx("Gateway: checking"), detail: null, tone: "wait", chip: tx("checking") };
    } else if (!usable) {
      gateway = { title: tx("Gateway: control unavailable"), detail: unavailableDetail(cli?.reasonCode ?? null),
        tone: "bad", chip: cli?.reasonCode ?? tx("unavailable") };
    } else if (status.gateway === null || status.gateway === undefined) {
      gateway = { title: tx("Gateway: not read"), detail: tx("State not read: {value}.", { value: codeOf(status.error) }),
        tone: "wait", chip: tx("gateway-panel::unknown") };
      allowed = BUTTONS.unknown;
    } else {
      const summary = status.gateway;
      const state = Object.hasOwn(STATE_WORDS, summary.state) ? summary.state : "unknown";
      gateway = {
        title: tx("Gateway: {value}", { value: STATE_WORDS[state] }),
        detail: [tx("lifecycle {value}", { value: summary.lifecycle ?? tx("gateway-panel2::not reported") }),
          summary.instanceId === null || summary.instanceId === undefined ? null : tx("instance {instanceId}", { instanceId: summary.instanceId })]
          .filter((part) => part !== null).join(" · "),
        tone: STATE_TONES[state] ?? "bad",
        chip: summary.reasonCode ?? state,
      };
      allowed = BUTTONS[state];
    }

    const seconds = busy && Number.isFinite(running.since) ? Math.max(0, Math.floor((now - running.since) / 1000)) : null;
    const lifecycle = status?.gateway?.lifecycle ?? null;
    const progress = !busy ? null
      : [tx("{value}{value2}", { value: PROGRESS_WORDS[running.kind] ?? tx("Running…"), value2: seconds === null ? "" : tx(" {seconds} s", { seconds }) }),
        running.kind === "gateway-start" && lifecycle !== null ? tx("lifecycle {lifecycle}", { lifecycle }) : null]
        .filter((part) => part !== null).join(" · ");

    const shownFailure = failure === null || failure.code === "user_declined" ? null : {
      lead: FAILED_WORDS[failure.kind] ?? tx("Failed"),
      code: failure.reasonCode ?? failure.code ?? "unknown",
      uncertain: failure.uncertain === true,
    };

    let keyRow;
    if (!usable) keyRow = { detail: null, tone: "wait", chip: tx("unavailable") };
    else if (key === null) keyRow = { detail: null, tone: "wait", chip: tx("checking") };
    else if (key.error !== undefined) keyRow = { detail: tx("Not read: {value}.", { value: codeOf(key.error) }), tone: "wait", chip: tx("gateway-panel::unknown") };
    else if (key.hasKey === true) {
      keyRow = { detail: tx("In the system key store. Atlas neither keeps nor shows it."), tone: "ok", chip: tx("saved") };
    } else if (key.hasKey === false) {
      keyRow = { detail: tx("The Gateway takes the key from ANTHROPIC_API_KEY, otherwise from here."), tone: "bad", chip: tx("not set") };
    } else keyRow = { detail: null, tone: "wait", chip: tx("gateway-panel::unknown") };

    const keyStored = key !== null && key.hasKey === true;
    return {
      visible: true,
      busy,
      gateway,
      progress,
      buttons: {
        start: { enabled: usable && !busy && allowed.start === true,
          label: running?.kind === "gateway-start" ? tx("Starting…") : tx("Start") },
        stop: { enabled: usable && !busy && allowed.stop === true,
          label: running?.kind === "gateway-stop" ? tx("Stopping…") : tx("Stop") },
        recover: { enabled: usable && !busy && allowed.recover === true,
          label: running?.kind === "gateway-recover" ? tx("Recovering…") : tx("Recover") },
      },
      failure: shownFailure,
      key: {
        title: tx("Anthropic API key"), ...keyRow,
        form: usable && key !== null && (keyFormOpen || !keyStored),
        cancel: keyFormOpen && keyStored,
        actions: usable && keyStored && !keyFormOpen,
        enabled: usable && !busy,
      },
      autostart: {
        checked: autostart !== null && autostart.installed === true,
        enabled: usable && !busy && autostart !== null,
        note: autostart !== null && autostart.error !== undefined
          ? tx("Autostart state not read: {value}.", { value: codeOf(autostart.error) }) : null,
      },
      cliLine: usable ? tx("agents-factory CLI: {value}", { value: SOURCE_WORDS[cli.source] ?? cli.source ?? tx("gateway-panel2::not reported") }) : null,
    };
  }

  // --- window ---------------------------------------------------------------------

  const panelState = {
    status: null, key: null, autostart: null, pending: null, failure: null, keyFormOpen: false,
    nodes: null, ticker: null, ticks: 0, loading: null, reload: false,
  };

  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const record = (kind, what, detail) => {
    if (typeof atlasRecord === "function") atlasRecord(kind, what, detail);
  };

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function readyRow(name) {
    const row = make("div", "ready-row");
    const text = make("div", "ready-text");
    const title = make("div", "ready-title");
    const detail = make("div", "ready-detail");
    const chip = make("span", "ready-chip wait");
    title.dataset.gateway = `${name}-title`;
    chip.dataset.gateway = `${name}-chip`;
    text.append(title, detail);
    row.append(text, chip);
    return { row, title, detail, chip };
  }

  function button(label, name, primary = false, hint = null) {
    const node = make("button", primary ? "small primary" : "small", label);
    node.type = "button";
    node.dataset.gateway = name;
    if (hint !== null) node.title = hint;
    return node;
  }

  /** The panel is built once: a redraw changes the text and states but leaves the key field alone. */
  function build() {
    if (panelState.nodes !== null) return panelState.nodes;
    const root = document.getElementById("gatewayPanel");
    if (root === null) return null;
    const gateway = readyRow("gateway");
    const progress = make("div", "gateway-progress hidden");
    progress.dataset.gateway = "progress";
    const start = button(tx("Start"), "start", true);
    const stop = button(tx("Stop"), "stop", false, tx("Stop this controller's Gateway. Atlas disconnects until the next start."));
    const recover = button(tx("Recover"), "recover", false,
      tx("Clear a stuck instance if its process has already exited. A live Gateway is left alone."));
    const actions = make("div", "gateway-actions");
    actions.append(start, stop, recover);
    const failure = make("div", "gateway-failure hidden");
    failure.dataset.gateway = "failure";

    const key = readyRow("key");
    const form = make("div", "gateway-key-form");
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "sk-ant-…";
    input.setAttribute("aria-label", tx("Anthropic API key"));
    input.dataset.gateway = "key-input";
    const save = button(tx("Save"), "key-save", true);
    const cancel = button(tx("Cancel"), "key-cancel");
    form.append(input, save, cancel);
    const keyActions = make("div", "gateway-actions");
    const replace = button(tx("Replace"), "key-replace");
    const remove = button(tx("gateway-panel::Remove"), "key-remove");
    keyActions.append(replace, remove);

    const autostartLabel = make("label", "gateway-autostart");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.gateway = "autostart";
    autostartLabel.append(box, make("span", null, tx("Start the Gateway when you sign in")));
    const autostartNote = make("div", "ready-detail hidden");
    const cliLine = make("div", "gateway-cli muted");

    root.replaceChildren(make("div", "section-title", tx("gateway-panel::Gateway")), gateway.row, progress, actions, failure,
      key.row, form, keyActions, autostartLabel, autostartNote, cliLine);

    start.addEventListener("click", () => gatewayAction("gateway-start", () => window.atlas.gatewayStart()));
    stop.addEventListener("click", () => gatewayAction("gateway-stop", () => window.atlas.gatewayStop()));
    recover.addEventListener("click", () => gatewayAction("gateway-recover", () => window.atlas.gatewayRecover()));
    save.addEventListener("click", () => saveKey());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveKey();
      }
    });
    cancel.addEventListener("click", () => {
      input.value = "";
      panelState.keyFormOpen = false;
      render();
    });
    replace.addEventListener("click", () => {
      panelState.keyFormOpen = true;
      render();
      input.focus();
    });
    remove.addEventListener("click", () => runAction("api-key-remove", () => window.atlas.removeApiKey(), (response) => {
      if (response.ok) panelState.key = { hasKey: response.data.hasKey };
    }));
    box.addEventListener("change", () => {
      const wanted = box.checked;
      // The checkbox shows what the CLI reported, not the click: until the answer it stays as it was.
      box.checked = !wanted;
      runAction(wanted ? "autostart-install" : "autostart-uninstall",
        () => (wanted ? window.atlas.installAutostart() : window.atlas.uninstallAutostart()), (response) => {
          if (response.ok) panelState.autostart = { installed: response.data.installed };
        });
    });

    panelState.nodes = {
      root, gateway, progress, start, stop, recover, failure, key, form, input, save, cancel, keyActions,
      replace, remove, box, autostartNote, cliLine,
    };
    return panelState.nodes;
  }

  function paintRow(row, { title, detail, tone, chip }) {
    row.title.textContent = title;
    row.detail.textContent = detail ?? "";
    row.detail.classList.toggle("hidden", detail === null || detail === undefined);
    row.chip.textContent = chip;
    row.chip.className = `ready-chip ${tone}`;
  }

  function render() {
    const nodes = build();
    if (nodes === null) return;
    const view = gatewayPanelView({ ...panelState, now: Date.now() });
    nodes.root.classList.toggle("hidden", !view.visible);
    if (!view.visible) return;
    paintRow(nodes.gateway, view.gateway);
    nodes.progress.textContent = view.progress ?? "";
    nodes.progress.classList.toggle("hidden", view.progress === null);
    for (const name of ["start", "stop", "recover"]) {
      nodes[name].disabled = !view.buttons[name].enabled;
      nodes[name].textContent = view.buttons[name].label;
    }
    nodes.failure.replaceChildren();
    if (view.failure !== null) {
      nodes.failure.append(`${view.failure.lead}: `, make("span", "mono", view.failure.code));
      if (view.failure.uncertain) nodes.failure.append(tx(" · outcome unknown, check the state"));
    }
    nodes.failure.classList.toggle("hidden", view.failure === null);
    paintRow(nodes.key, view.key);
    nodes.form.classList.toggle("hidden", !view.key.form);
    nodes.cancel.classList.toggle("hidden", !view.key.cancel);
    nodes.keyActions.classList.toggle("hidden", !view.key.actions);
    for (const name of ["input", "save", "cancel", "replace", "remove"]) nodes[name].disabled = !view.key.enabled;
    nodes.box.checked = view.autostart.checked;
    nodes.box.disabled = !view.autostart.enabled;
    nodes.autostartNote.textContent = view.autostart.note ?? "";
    nodes.autostartNote.classList.toggle("hidden", view.autostart.note === null);
    nodes.cliLine.textContent = view.cliLine ?? "";
    nodes.cliLine.classList.toggle("hidden", view.cliLine === null);
    keepTicking();
  }

  // While an action runs (its own, or one started before the window opened), the panel counts
  // seconds and rereads the Gateway state.
  function keepTicking() {
    const active = panelState.pending !== null || (panelState.status?.action ?? null) !== null;
    if (active && panelState.ticker === null) {
      panelState.ticks = 0;
      panelState.ticker = setInterval(() => {
        panelState.ticks += 1;
        if (panelState.ticks % 2 === 0) loadStatus();
        else render();
      }, 1000);
    } else if (!active && panelState.ticker !== null) {
      clearInterval(panelState.ticker);
      panelState.ticker = null;
    }
  }

  // One read at a time; a request during a read means one more read after it,
  // so that after an action the panel is not left with a state read before it.
  async function loadStatus() {
    if (typeof window.atlas?.gatewayStatus !== "function") return;
    if (panelState.loading !== null) {
      panelState.reload = true;
      await panelState.loading;
      return;
    }
    panelState.loading = (async () => {
      do {
        panelState.reload = false;
        const response = await window.atlas.gatewayStatus();
        if (response.ok) panelState.status = response.data;
        else if (response.error?.code === "unsupported_in_mode") panelState.status = { supported: false };
        else {
          panelState.status = { supported: true, action: null, gateway: null, error: null,
            cli: { available: false, source: null, reasonCode: codeOf(response.error) } };
        }
      } while (panelState.reload);
    })();
    try {
      await panelState.loading;
    } catch {
      // The host did not answer: the previous state stays, the next read will try again.
    } finally {
      panelState.loading = null;
    }
    render();
  }

  async function loadAll() {
    await loadStatus();
    if (panelState.status?.cli?.available !== true) return;
    const failed = () => ({ ok: false, error: { code: "host_error" } });
    const [key, autostart] = await Promise.all([window.atlas.apiKeyStatus().catch(failed),
      window.atlas.autostartStatus().catch(failed)]);
    panelState.key = key.ok ? { hasKey: key.data.hasKey } : { error: key.error ?? { code: "unknown" } };
    panelState.autostart = autostart.ok ? { installed: autostart.data.installed }
      : { error: autostart.error ?? { code: "unknown" } };
    render();
  }

  /** One host action: one at a time, with progress, the exact refusal code and a journal entry. */
  async function runAction(kind, call, onDone = null) {
    if (panelState.pending !== null) return null;
    panelState.pending = { kind, since: Date.now() };
    panelState.failure = null;
    render();
    let response;
    try {
      response = await call();
    } catch {
      response = { ok: false, error: { code: "host_error" } };
    }
    panelState.pending = null;
    // The host runs one action at a time: this was it, and it has finished.
    if (panelState.status !== null && panelState.status.action !== undefined) {
      panelState.status = { ...panelState.status, action: null };
    }
    if (response.ok) {
      record("ok", DONE_WORDS[kind], [response.data?.state, response.data?.instanceId]
        .filter((part) => typeof part === "string").join(" · "));
    } else {
      const error = response.error ?? {};
      panelState.failure = { kind, code: error.code ?? "unknown", reasonCode: error.reasonCode ?? null,
        uncertain: error.uncertain === true };
      const lead = FAILED_WORDS[kind] ?? tx("gateway-panel::failed");
      record(error.code === "user_declined" ? "info" : "bad", lead,
        error.code === "user_declined" ? tx("undone") : codeOf(error));
    }
    if (typeof onDone === "function") await onDone(response);
    render();
    return response;
  }

  /** Start, stop, recover; then the window rereads the Gateway and reconnects. */
  async function gatewayAction(kind, call) {
    const response = await runAction(kind, call);
    if (response === null) return;
    await loadStatus();
    await reconnect(kind === "gateway-start" && response.ok ? 4 : 1);
  }

  // A new instance means a new descriptor: the usual “Refresh” (refresh in app.js)
  // rereads the connection with force. After a start - several attempts, until
  // the descriptor appears.
  async function reconnect(attempts) {
    if (typeof refresh !== "function" || typeof atlasState !== "object") return;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const until = Date.now() + 5000;
      while (atlasState.busy && Date.now() < until) await pause(100);
      await refresh({ silent: true });
      if (atlasState.connection?.available === true) return;
      if (attempt + 1 < attempts) await pause(1000);
    }
  }

  // The key text leaves the field once, straight into the call: the field is cleared at once,
  // and no page variable holds it.
  function takeKey() {
    const input = panelState.nodes.input;
    const value = input.value;
    input.value = "";
    return value;
  }

  async function saveKey() {
    const nodes = build();
    if (nodes === null || panelState.pending !== null) return;
    if (nodes.input.value.trim() === "") {
      panelState.failure = { kind: "api-key-set", code: "invalid_input", reasonCode: "api_key_empty", uncertain: false };
      render();
      nodes.input.focus();
      return;
    }
    await runAction("api-key-set", () => window.atlas.setApiKey({ key: takeKey() }), (response) => {
      if (response.ok) {
        panelState.key = { hasKey: response.data.hasKey };
        panelState.keyFormOpen = false;
      }
    });
  }

  /** “Readiness” is open: reread everything. */
  function atlasGatewayPanelOpen() {
    if (build() === null) return;
    render();
    loadAll();
  }

  /** A window refresh while “Readiness” is open: only the Gateway state, not the key or autostart. */
  function atlasGatewayPanelRefresh() {
    const panel = document.getElementById("readinessPanel");
    if (panel === null || panel.classList.contains("hidden") || panelState.pending !== null) return;
    loadStatus();
  }

  return {
    gatewayPanelView,
    GATEWAY_PANEL_WORDS: Object.freeze({ STATE_WORDS, PROGRESS_WORDS, DONE_WORDS, FAILED_WORDS, SOURCE_WORDS }),
    atlasGatewayPanelOpen,
    atlasGatewayPanelRefresh,
  };
}));

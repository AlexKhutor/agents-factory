"use strict";

// Data, panels and commands. The map is in scene.js, the agent workspace is in
// workspace.js. This file holds everything that talks to the backend: reads, confirmed
// operations, the journal, and the local annotations of the person, labeled as local.

const atlasState = {
  info: null,
  runtime: null,
  connection: null,
  operations: [],
  world: null,
  trusted: { available: false, reasonCode: tx("not checked") },
  log: [],
  drafts: new Map(),
  // Whether the servers of the agents' models answer (host/model-health.mjs); null until read.
  modelHealth: null,
  // The names the person gave projects, quarters and agents ({ projects: { [projectId]: names } }); null until read.
  names: null,
  namesAt: 0,
  ui: { attentionOpen: false, logOpen: false, trayOpen: false, watch: true, workspaceFull: false, workspaceWidth: null,
    steer: true },
  clipboard: null,
  toastTimer: null,
  attentionScope: null,
  expected: null,
  // The last captured message of the agent, if its conversation has already been read:
  // the card on the map shows it in the agent's own words rather than as a guess.
  lastMessages: new Map(),
  lastAvailability: null,
  watch: false,
  watchTimer: null,
  layoutTimer: null,
  layoutDirty: false,
  busy: false,
  // The controller's task board (desk agents and the world lead's tasks): null - not
  // read yet; { sources, tasks, truncated, failed: false, readAt } or { failed: true, reason, readAt }.
  taskBoard: null,
  sheetOwner: null,
  // The world's projects not on this PC: split - the instance is split (only then
  // can a project be disconnected), projects - their names.
  away: { split: false, projects: [] },
};

const $ = (id) => document.getElementById(id);

// index.html is written in English; data-i18n (its own text) and data-i18n-title name the key, so the
// page shows it in the window's language (i18n-core.js). Only the element's own text changes, not its
// children (a count beside a label).
(function applyPageLocale() {
  document.documentElement.lang = currentLanguage();
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const own = [...node.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim() !== "");
    if (own) own.textContent = own.textContent.replace(own.textContent.trim(), tx(node.dataset.i18n));
  }
  for (const node of document.querySelectorAll("[data-i18n-title]")) node.title = tx(node.dataset.i18nTitle);
}());

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

function infoRow(key, value) {
  const row = el("div", "info-row");
  row.append(el("div", "key", key));
  const cell = el("div", "value mono");
  if (value === null || value === undefined) {
    cell.classList.add("muted");
    cell.textContent = tx("not reported");
  } else if (typeof value === "object") cell.textContent = JSON.stringify(value);
  else cell.textContent = String(value);
  row.append(cell);
  return row;
}

const noteBlock = (className, text) => el("div", className, text);

// --- identifier: the same format the host and the backend check ---------------
//
// mutations.mjs and host/ipc.mjs reject anything that does not match this same
// pattern, but until now the person learned about it only after a refusal. A name
// like “quarter creation test” never matches this pattern: spaces
// and non-Latin letters are forbidden. The field explains the format at once and live-checks the same
// rule, instead of a round trip to the host just to get “invalid_input”.

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const IDENTIFIER_HINT = tx("1-160 Latin letters and digits; a dot, underscore, ")
  + tx("colon and hyphen are allowed; the first character is a letter or digit. No spaces or non-Latin letters.");

/** null - matches the format; otherwise the reason as a string. */
function identifierProblem(value) {
  const trimmed = value.trim();
  if (trimmed === "") return tx("The identifier is not entered yet.");
  if (!IDENTIFIER_PATTERN.test(trimmed)) return tx("Does not match the format. {IDENTIFIER_HINT}", { IDENTIFIER_HINT });
  return null;
}

/**
 * Identifier field with a live hint: `input.value` - what was typed,
 * `problem()` - the current reason for refusal, or null if it can be sent.
 * `taken(value)` - what already holds this name, or null; `set(value)` - fill in a value.
 */
function identifierField(placeholder, { taken = null } = {}) {
  const input = el("input", "identifier-input");
  input.placeholder = placeholder;
  const hint = el("div", "identifier-hint muted", IDENTIFIER_HINT);
  const problemOf = () => identifierProblem(input.value) ?? (taken === null ? null : taken(input.value.trim()));
  const paint = () => {
    const problem = problemOf();
    hint.textContent = input.value.trim() === "" ? IDENTIFIER_HINT : (problem ?? tx("Matches the format."));
    hint.classList.toggle("bad", problem !== null && input.value.trim() !== "");
  };
  input.addEventListener("input", paint);
  paint();
  const set = (value) => {
    input.value = value;
    paint();
  };
  return { input, hint, problem: problemOf, set };
}

/** The agent with this identifier - open or archived; null if the map has no such agent. */
function agentNamed(agentId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  for (const project of world.projection.projects) {
    for (const quarter of project.quarters) {
      const found = quarter.agents.find((agent) => agent.agentId === agentId);
      if (found) return found;
    }
  }
  return null;
}

// An agent name is never reused: its conversation stays under it, and the backend
// refuses a new agent with a taken name (memory_identity_conflict).
function agentIdTaken(agentId) {
  const found = agentNamed(agentId);
  if (found === null) return null;
  return found.state === "archived"
    ? tx("The name is taken by the archived agent {agentId}: agent names are not reused, its conversation stays under the name.", { agentId })
    : tx("The name is taken: agent {agentId} already exists ({projectId} / {quarterId}).", { agentId, projectId: found.projectId, quarterId: found.quarterId });
}

// --- names ---------------------------------------------------------------------
// The names the person gave projects, quarters and agents (the backend's
// object-names.mjs). The ID never changes; an object without a name is shown by
// its ID. Read through the trusted host in the background, no more often than
// NAMES_TTL_MS, and at once after a rename.
const NAMES_TTL_MS = 30_000;

/** The name an object is shown by: its own, or its ID. */
function displayName(kind, projectId, objectId) {
  const names = atlasState.names?.projects?.[projectId] ?? null;
  const own = kind === "project" ? names?.project : names?.[`${kind}s`]?.[objectId];
  return typeof own === "string" && own !== "" ? own : objectId;
}

/** "Name · ID" where the object has a name of its own; the ID alone where it has none. */
function nameWithId(kind, projectId, objectId) {
  const name = displayName(kind, projectId, objectId);
  return name === objectId ? objectId : `${name} · ${objectId}`;
}

async function loadNames({ force = false } = {}) {
  if (typeof window.atlas?.names !== "function" || atlasState.trusted?.available !== true) return;
  if (!force && atlasState.names !== null && Date.now() - atlasState.namesAt < NAMES_TTL_MS) return;
  atlasState.namesAt = Date.now();
  const response = await window.atlas.names();
  if (response.ok) atlasState.names = response.data;
}

/**
 * A create form's name field above its ID field: while the person has not
 * typed an ID, it follows the name (id-core.js: "Billing" → billing-7f3k, not
 * one `taken` says is used). `name()` - the trimmed name, "" when none.
 */
function nameAndIdFields(idField, placeholder, taken) {
  const input = el("input");
  input.placeholder = placeholder;
  input.maxLength = 120;
  let typedId = false;
  idField.input.addEventListener("input", () => { typedId = true; });
  input.addEventListener("input", () => {
    if (typedId) return;
    const name = input.value.trim();
    if (name !== "") idField.set(newObjectIdOf(name, { taken }) ?? "");
  });
  return { input, name: () => input.value.replace(/\s+/gu, " ").trim() };
}

/** After a creation: the name the person gave, when it is not the ID itself. A failure is said, the object stays. */
async function nameCreated(result, kind, projectId, objectId, name) {
  if (name === "" || name === objectId || typeof window.atlas?.rename !== "function") return;
  const named = await window.atlas.rename({ projectId, kind, objectId, name });
  if (!named.ok) {
    const reason = named.error?.reasonCode || named.error?.code || tx("no code");
    result.append(noteBlock("error", tx("Created, but the name is not saved: {reason}. Rename it from the map.", { reason })));
    return;
  }
  await loadNames({ force: true });
}

/**
 * Rename sheet: the name is free text and can change at any time; the ID
 * stays. Empty brings the ID back as the name. Journaled with an undo
 * (“History”), so it does not ask.
 */
function openRenameSheet(kind, projectId, objectId) {
  const words = { project: tx("project"), quarter: tx("quarter"), agent: tx("agent") };
  const body = openSheet(tx("Rename {kind} · {objectId}", { kind: words[kind], objectId }), tx("trusted action"));
  const input = el("input");
  input.value = displayName(kind, projectId, objectId) === objectId ? "" : displayName(kind, projectId, objectId);
  input.placeholder = objectId;
  input.maxLength = 120;
  body.append(el("div", "section-title", tx("Name")), input,
    el("div", "muted", tx("ID: {objectId} — it does not change: agents, folders and history refer to it.", { objectId })));
  const result = el("div");
  const save = trustedButton(tx("Save name"), async () => {
    const name = input.value.replace(/\s+/gu, " ").trim();
    save.disabled = true;
    const response = await window.atlas.rename({ projectId, kind, objectId, name: name === "" ? null : name });
    save.disabled = false;
    if (!response.ok) {
      const reason = response.error?.reasonCode || response.error?.code || tx("no code");
      atlasRecord("bad", tx("rename"), `${objectId}: ${reason}`);
      result.replaceChildren(noteBlock("error", tx("Not renamed: {reason}.", { reason })));
      return;
    }
    atlasRecord("ok", tx("renamed"), `${objectId} → ${name === "" ? objectId : name}`);
    await loadNames({ force: true });
    closeSheet();
    requestRender();
    if (scene.selection !== null && !$("inspector").classList.contains("hidden")) atlasOnSelection(scene.selection);
  }, { primary: true });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") save.click(); });
  const actions = el("div", "actions");
  actions.append(save);
  body.append(actions, result);
  input.focus();
}

/** The first free name: base, base-2, base-3… */
function freeAgentId(base) {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (agentNamed(candidate) === null) return candidate;
  }
  return base;
}

// --- journal ------------------------------------------------------------------

function atlasRecord(kind, what, detail) {
  atlasState.log.push({
    at: new Date().toISOString(), kind, what,
    detail: detail === undefined || detail === null ? "" : String(detail),
  });
  if (atlasState.log.length > 500) atlasState.log.shift();
  renderLog();
}

function renderLog() {
  const list = $("activityList");
  if (list === null) return;
  list.replaceChildren();
  for (const entry of atlasState.log) {
    const line = el("div", `log-line ${entry.kind}`);
    line.append(el("span", "at", entry.at.slice(11, 19)));
    line.append(el("span", "what", entry.what));
    line.append(el("span", "detail", entry.detail));
    list.append(line);
  }
  list.scrollTop = list.scrollHeight;
  $("activityCount").textContent = tx("{length} entries", { length: atlasState.log.length });
}

const logText = () => atlasState.log
  .map((entry) => `${entry.at}  ${entry.what}  ${entry.detail}`).join("\n");

// --- operation availability ---------------------------------------------------

function operationStatus(operationId) {
  return atlasState.operations.find((entry) => entry.operationId === operationId) ?? null;
}

function actionButton(label, operationId, handler, { primary = false } = {}) {
  const button = el("button", `small${primary ? " primary" : ""}`, label);
  const status = operationId === null ? { status: "available" } : operationStatus(operationId);
  if (status === null || status.status !== "available") {
    button.disabled = true;
    button.title = status === null
      ? tx("{operationId}: not checked", { operationId })
      : `${operationId}: ${status.status} (${status.reasonCode})`;
  } else {
    button.addEventListener("click", handler);
  }
  return button;
}

function trustedButton(label, handler, { primary = false } = {}) {
  const button = el("button", `small${primary ? " primary" : ""}`, label);
  if (!atlasState.trusted.available) {
    button.disabled = true;
    button.title = tx("trusted actions unavailable: {reasonCode}", { reasonCode: atlasState.trusted.reasonCode });
  } else {
    button.addEventListener("click", handler);
  }
  return button;
}

function outcomeMessage(response, successText) {
  if (response.ok) {
    const identity = response.data.identity ?? {};
    atlasRecord("ok", successText,
      `${response.data.outcome}${identity.operationId ? ` — ${identity.operationId}` : ""}`);
    return { kind: "note", text: tx("{successText} Outcome: {outcome}.", { successText, outcome: response.data.outcome }) };
  }
  if (response.error.code === "user_declined") {
    atlasRecord("info", tx("confirmation declined"), successText);
    return { kind: "note", text: tx("Nothing was done: the confirmation was declined.") };
  }
  if (response.error.code === "uncertain_outcome") {
    const operationId = response.identity ? response.identity.operationId : tx("unknown");
    atlasRecord("bad", tx("uncertain outcome"), tx("{successText} operation {operationId} — not retried", { successText, operationId }));
    return {
      kind: "error",
      text: tx("Uncertain outcome of operation {operationId}. Do not retry: read the receipt.", { operationId }),
    };
  }
  atlasRecord("bad", tx("refused"), `${successText} ${response.error.code}`);
  return {
    kind: "error",
    text: `${response.error.code}${response.error.reasonCode ? ` (${response.error.reasonCode})` : ""}`,
  };
}

// --- layout -------------------------------------------------------------------

async function loadLayout() {
  const response = await window.atlas.readLayout();
  if (!response.ok) {
    sceneSetLayout(null, { status: "invalid" });
    atlasRecord("bad", tx("layout not read"), response.error.reasonCode);
    showNotice(tx("Layout not read: {reasonCode}", { reasonCode: response.error.reasonCode }));
    return;
  }
  sceneSetLayout(response.data.layout, { status: response.data.status });
  if (response.data.status === "recovered") {
    atlasRecord("bad", tx("layout restored from backup"), response.data.reasonCode);
    showNotice(tx("Layout restored from backup"));
  } else if (response.data.status === "loaded") {
    atlasRecord("info", tx("layout loaded"), response.data.environment);
  }
}

/**
 * Whose agent (agentId -> projectId), by the world as read: a split instance
 * puts an agent's place in its project's part. World not read - empty, and the store
 * keeps the agents where they were.
 */
function layoutMembership() {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return {};
  return Object.fromEntries(world.projection.projects.flatMap((project) => project.quarters
    .flatMap((quarter) => quarter.agents.map((agent) => [agent.agentId, project.projectId]))));
}

async function writeLayout() {
  atlasState.layoutDirty = false;
  const layout = sceneGetLayout();
  if (layout === null) return;
  layout.view = sceneCurrentView();
  const response = await window.atlas.writeLayout({ layout, membership: layoutMembership() });
  if (!response.ok) {
    atlasRecord("bad", tx("layout not saved"), response.error.reasonCode || response.error.code);
    showNotice(tx("Layout not saved: {code}", { code: response.error.reasonCode || response.error.code }));
    return;
  }
  // The project's part on disk is newer than the window (the project was connected): it is kept as
  // it is, and the window's map is read again to take it.
  if ((response.data.reloadProjects ?? []).length > 0) {
    const fresh = await window.atlas.readLayout();
    if (fresh.ok) {
      sceneSetLayout(fresh.data.layout, { status: fresh.data.status });
      atlasRecord("info", tx("layout read again"), tx("project parts: {value}", { value: response.data.reloadProjects.join(", ") }));
    }
  }
}

/**
 * The map again from disk. "Take" and "Hand over" change its parts under the window (a project's
 * place that came from another PC): a window holding the old map would overwrite them
 * on its next write.
 */
async function reloadLayoutFromDisk(reason) {
  if (atlasState.layoutTimer !== null) {
    clearTimeout(atlasState.layoutTimer);
    atlasState.layoutTimer = null;
  }
  atlasState.layoutDirty = false;
  const fresh = await window.atlas.readLayout();
  if (!fresh.ok) return;
  sceneSetLayout(fresh.data.layout, { status: fresh.data.status });
  atlasRecord("info", tx("layout read again"), reason);
}

function scheduleLayoutWrite(delay) {
  atlasState.layoutDirty = true;
  if (atlasState.layoutTimer !== null) clearTimeout(atlasState.layoutTimer);
  atlasState.layoutTimer = setTimeout(() => {
    atlasState.layoutTimer = null;
    writeLayout();
  }, delay);
}

function atlasOnLayoutChanged({ immediate = false } = {}) {
  if (immediate) {
    atlasState.layoutDirty = true;
    if (atlasState.layoutTimer !== null) clearTimeout(atlasState.layoutTimer);
    atlasState.layoutTimer = null;
    writeLayout();
    return;
  }
  scheduleLayoutWrite(600);
}

const atlasOnViewSettled = () => scheduleLayoutWrite(1200);

async function flushPending() {
  if (atlasState.layoutTimer !== null) {
    clearTimeout(atlasState.layoutTimer);
    atlasState.layoutTimer = null;
  }
  if (atlasState.layoutDirty) await writeLayout();
  await window.atlas.writeUiState(atlasState.ui);
}

// --- panels -------------------------------------------------------------------

function applyUiState() {
  $("attentionPanel").classList.toggle("hidden", !atlasState.ui.attentionOpen);
  $("logDrawer").classList.toggle("hidden", !atlasState.ui.logOpen);
  $("tray").classList.toggle("hidden", !atlasState.ui.trayOpen);
  // An open bottom drawer (the journal or the tray) would cover the minimap if it stayed in
  // its usual place at the bottom edge: a class on mapStage lifts it above
  // the drawer instead of hiding it underneath.
  $("mapStage").classList.toggle("drawer-open", atlasState.ui.logOpen || atlasState.ui.trayOpen);
}

/**
 * The panels on the right (inspector, attention, readiness, sheets) sit below the buttons at the top
 * right, whatever their height: there are more buttons, the row wraps, a line may appear
 * above the map. Without this a panel covers the buttons.
 */
function placePanelsUnderHud() {
  const hud = $("stateHud");
  if (hud.offsetParent === null) return;
  const bottom = hud.getBoundingClientRect().bottom - $("mapStage").getBoundingClientRect().top;
  $("mapStage").style.setProperty("--panel-top", `${Math.max(150, Math.ceil(bottom) + 12)}px`);
}
new ResizeObserver(placePanelsUnderHud).observe($("stateHud"));

/**
 * Any action outside the current object clears extra information from
 * the screen: the inspector, the attention list, the context menu and forms. The map must
 * stay clean, as in the prototype.
 */
function atlasDismissPanels({ keepInspector = false } = {}) {
  if (!keepInspector) $("inspector").classList.add("hidden");
  closeReadiness();
  $("contextMenu").classList.add("hidden");
  $("sheet").classList.add("hidden");
  atlasHideTooltip();
  if (atlasState.ui.attentionOpen) {
    atlasState.ui.attentionOpen = false;
    $("attentionPanel").classList.add("hidden");
    window.atlas.writeUiState(atlasState.ui);
  }
}

function atlasShowTooltip(node, pointer) {
  const tooltip = $("tooltip");
  const { project, quarter, agent } = findNode(node);
  let title = nameWithId("project", node.projectId, node.projectId);
  let tag = tx("project");
  let foot = node.kind === "agent" ? tx("Click — details · double-click — workspace · right-click — actions")
    : tx("Click — details · double-click — enter · right-click — actions");
  const lines = [];
  if (node.kind === "attention") {
    // An attention badge tells exactly what is behind it, at the level
    // of grouping at which the person is looking at the map right now.
    const items = attentionItemsFor(node);
    title = node.agentId ?? node.quarterId ?? node.projectId;
    tag = node.scopeKind === "agent" ? tx("agent · attention")
      : node.scopeKind === "quarter" ? tx("quarter · attention") : tx("project · attention");
    lines.push(tx("need attention: {length}", { length: items.length }));
    for (const item of items.slice(0, 5)) {
      lines.push(node.scopeKind === "agent"
        ? attentionLine(item) : `${item.agentId} — ${attentionLine(item)}`);
    }
    if (items.length > 5) lines.push(tx("and {value} more", { value: items.length - 5 }));
    // What a double-click does (atlasOpenAttentionTarget): a question - the chat; anything else - the list.
    foot = items.length === 1 && attentionSeverity(items[0]) === 1
      ? tx("Double-click — answer in the chat") : tx("Double-click — the list of problems");
  } else if (node.kind === "hq") {
    tag = tx("HQ");
    lines.push(tx("Goal, team and decisions of the project"));
  } else if (node.kind === "world") {
    title = tx("World HQ");
    tag = tx("main base");
    const lead = worldLeadOf();
    lines.push(lead === null ? tx("World lead not assigned") : tx("world lead · {agentId} · {value}", { agentId: lead.agentId, value: leadStateWords(lead) }));
    const board = atlasState.taskBoard ?? null;
    if (board !== null && !board.failed) {
      lines.push(tx("desk agents: {length} · tasks: {length2}", { length: board.sources.length, length2: board.tasks.length }));
    }
    foot = tx("Click — World HQ · double-click — {value}", { value: lead === null ? tx("app::World HQ") : tx("world lead chat") })
      + tx(" · Backspace — to the World HQ · right-click — actions");
  } else if (node.kind === "away") {
    // Grey frame: the project is not on this PC - only where it is and a summary without texts.
    const item = awayProjectOf(node.projectId);
    title = item?.title ? `${node.projectId} · ${item.title}` : node.projectId;
    tag = tx("not on this PC");
    lines.push(placeText(item?.location), summaryText(item?.summary));
    foot = tx("Click — summary and connect · right-click — actions");
  } else if (node.kind === "agent" && agent !== null) {
    title = nameWithId("agent", agent.projectId, agent.agentId);
    tag = tx("agent");
    lines.push(tx("{state} · delivery {deliveryState}", { state: agent.state, deliveryState: agent.deliveryState }));
    if (agent.problemCode !== null) lines.push(tx("problem: {value}", { value: problemWords(agent.problemCode) }));
  } else if (node.kind === "quarter" && quarter !== null) {
    title = nameWithId("quarter", node.projectId, quarter.quarterId);
    tag = tx("quarter");
    lines.push(tx("{value} · memory rev. {revision}", { value: countWords(quarter.agents.length, AGENT_FORMS), revision: quarter.memory.revision }));
  } else if (project !== null) {
    lines.push(tx("{value} · memory rev. {revision}", { value: countWords(project.quarters.length, QUARTER_FORMS), revision: project.memory.revision }));
  }
  const annotation = sceneAnnotationOf(node);
  if (annotation.role) lines.push(tx("role (yours): {role}", { role: annotation.role }));
  if (annotation.note) lines.push(tx("note (yours): {value}", { value: annotation.note.slice(0, 120) }));

  tooltip.replaceChildren();
  const top = el("div", "tooltip-top");
  top.append(el("strong", null, title));
  top.append(el("span", "tag", tag.toUpperCase()));
  tooltip.append(top);
  for (const line of lines) tooltip.append(el("div", "tooltip-meta", line));
  tooltip.append(el("div", "tooltip-foot", foot));
  tooltip.classList.remove("hidden");
  const stage = $("mapStage").getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let x = pointer.x + 18;
  let y = pointer.y + 19;
  if (x + width > stage.width - 12) x = pointer.x - width - 15;
  if (y + height > stage.height - 12) y = pointer.y - height - 12;
  tooltip.style.left = `${Math.max(10, x)}px`;
  tooltip.style.top = `${Math.max(10, y)}px`;
}

const atlasHideTooltip = () => $("tooltip").classList.add("hidden");

function atlasOnToolChanged(tool) {
  $("selectTool").classList.toggle("active", tool === "select");
  $("panTool").classList.toggle("active", tool === "pan");
}

function setPanel(name, open) {
  atlasState.ui[name] = open;
  applyUiState();
  window.atlas.writeUiState(atlasState.ui);
}

function showNotice(text) {
  const notice = $("dataNotice");
  notice.textContent = text;
  notice.classList.remove("hidden");
}

const hideNotice = () => $("dataNotice").classList.add("hidden");

/**
 * The line above the map. The world was handed over from this PC (block 3): the Gateway does not start here and
 * the map is empty - the line says why and what to press, not "world not read".
 * Otherwise - what the data lacks, if anything.
 */
function paintDataNotice(incomplete = atlasState.dataIncomplete ?? []) {
  atlasState.dataIncomplete = incomplete;
  const sync = atlasState.sync;
  if (sync?.configured === true && sync.world?.held === false) {
    const holder = sync.world.remote?.holder ?? null;
    showNotice(tx("The world was handed over from this PC: the Gateway does not start here, so the map is empty. Nothing was deleted.")
      + (holder === null ? "" : tx(" The world is now held by {value}.", { value: syncHolderText(sync, holder) }))
      + tx(" To work here: \"World: handed over\" → \"Take all…\"."));
    return;
  }
  if (incomplete.length > 0) showNotice(tx("Data incomplete: {value}", { value: incomplete.join("; ") })); else hideNotice();
}

/** A short message about what the person has just done. It disappears by itself. */
function atlasToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  if (atlasState.toastTimer !== null) clearTimeout(atlasState.toastTimer);
  atlasState.toastTimer = setTimeout(() => {
    atlasState.toastTimer = null;
    toast.classList.add("hidden");
  }, 4200);
}

// --- header and HUD -------------------------------------------------------------

/**
 * Which Claude account the agents work under, as Claude Code itself reports it
 * on this machine: in direct mode the desktop reports it, in live mode the host
 * (claude-account.mjs). The Gateway does not pass it on.
 */
const claudeAccountOf = () => atlasState.runtime?.claudeAccount ?? atlasState.claudeAccount ?? null;

const SUBSCRIPTION_WORDS = Object.freeze({ max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" });

/** The account line in the header and its tooltip. */
function accountLine() {
  const account = claudeAccountOf();
  if (account === null || account.state === "checking") return { text: tx("Claude · account…"), tone: "", title: "" };
  if (account.state === "signed-out") {
    return { text: tx("Claude · not signed in"), tone: "bad",
      title: tx("Claude Code on this machine is not signed in: the agents cannot work.") };
  }
  if (account.state !== "known") {
    return { text: tx("Claude · account unknown"), tone: "bad",
      title: tx("Claude Code did not answer the sign-in check{value}.", { value: account.reason ? ` (${account.reason})` : "" }) };
  }
  const plan = SUBSCRIPTION_WORDS[account.subscriptionType] ?? account.subscriptionType ?? null;
  const name = account.email ?? account.organization ?? tx("signed in without email");
  return {
    text: plan === null ? `Claude · ${name}` : `Claude · ${name} · ${plan}`,
    tone: "ok",
    title: [tx("The Claude Code account the agents work under (checked on this machine)."),
      account.email ? tx("Email: {email}", { email: account.email }) : null,
      account.organization ? tx("Organization: {organization}", { organization: account.organization }) : null,
      plan ? tx("Plan: {plan}", { plan }) : null,
      account.authMethod ? tx("Sign-in: {authMethod}", { authMethod: account.authMethod }) : null,
      tx("Click — plan usage: session, week, model limits.")].filter(Boolean).join("\n"),
  };
}

/** Live mode: the account is read in the background and does not delay the world refresh. */
function loadClaudeAccount({ force = false } = {}) {
  if (atlasState.info?.mode !== "live" || atlasState.info?.fixture) return;
  window.atlas.claudeAccount({ force }).then((response) => {
    const previous = atlasState.claudeAccount?.email ?? null;
    atlasState.claudeAccount = response.ok ? response.data : { state: "failed", reason: response.error?.code };
    const account = atlasState.claudeAccount;
    if (account.state === "known" && account.email !== previous) {
      atlasRecord("ok", tx("Claude account"), [account.email, account.organization].filter(Boolean).join(" · ") || tx("no email"));
    }
    renderHeader();
  });
}

// --- plan usage -------------------------------------------------------------------
//
// Like the account menu in Claude Code: the plan windows - session (5 h), week and limits
// per model, with the share used and the time until reset. The Gateway measures them during
// agent turns (no session is opened and no model is called just for that), so the
// menu always has a measurement time: between turns it shows the last one.

function resetWords(resetsAtUtc) {
  const ms = Date.parse(resetsAtUtc ?? "") - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return tx("already reset");
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return tx("resets in {minutes} min", { minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? tx("resets in {hours} h", { hours }) : tx("resets in {value} d", { value: Math.round(hours / 24) });
}

const USAGE_STATUS_WORDS = Object.freeze({ allowed_warning: tx("close to the limit"), rejected: tx("limit reached") });

/** The “Usage” menu: account, plan windows, measurement time. */
function renderUsageMenu(menu, answer) {
  menu.replaceChildren(el("div", "usage-title", tx("Usage")));
  const account = claudeAccountOf();
  if (account?.state === "known") {
    const plan = SUBSCRIPTION_WORDS[account.subscriptionType] ?? account.subscriptionType ?? null;
    menu.append(el("div", "usage-account", [account.email ?? account.organization, plan].filter(Boolean).join(" · ")));
  }
  if (answer.state === "none") {
    menu.append(el("div", "usage-foot", tx("Quotas are not measured yet: the Gateway gets them from Claude Code during an agent turn ")
      + tx("and keeps them here. No session is opened just to measure them.")));
  } else if (answer.state !== "known") {
    menu.append(el("div", "usage-foot", tx("Quotas not read: {value}.", { value: answer.reason ?? tx("no code") })));
  } else if (!answer.usage.available && answer.usage.windows.length === 0) {
    menu.append(el("div", "usage-foot", tx("The Claude plan reports no quotas: signed in with an API key or through a cloud provider.")));
  } else {
    for (const window of answer.usage.windows) {
      const tone = window.status === "rejected" || (window.utilization ?? 0) >= 90 ? " bad"
        : window.status === "allowed_warning" || (window.utilization ?? 0) >= 75 ? " warn" : "";
      const row = el("div", `usage-row${tone}`);
      const head = el("div", "usage-row-head");
      // The backend's labels are English; a model's own window keeps its name ("Fable · limit").
      const model = typeof window.id === "string" && window.id.startsWith("model:") ? window.id.slice(6) : null;
      const name = el("span", null, model !== null ? tx("{name} · limit", { name: model }) : tx(window.label));
      if (window.status && USAGE_STATUS_WORDS[window.status]) {
        name.append(el("span", "usage-status", USAGE_STATUS_WORDS[window.status]));
      }
      head.append(name, el("span", null, window.utilization === null ? "—" : `${Math.round(window.utilization)}%`));
      const bar = el("div", "usage-bar");
      const fill = el("span");
      fill.style.width = `${window.utilization ?? 0}%`;
      bar.append(fill);
      row.append(head, bar);
      const reset = resetWords(window.resetsAtUtc);
      if (reset !== null) row.append(el("div", "usage-reset", reset));
      menu.append(row);
    }
    const at = answer.usage.observedAtUtc ?? answer.usage.statusObservedAtUtc;
    menu.append(el("div", "usage-foot", at === null ? tx("Measurement time not reported.")
      : tx("Measured {value}", { value: new Date(at).toLocaleString(dateLocale(), { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) })
        + tx(" — during an agent turn. Updates while agents are working.")));
  }
  const actions = el("div", "usage-actions");
  const again = el("button", "small", tx("Reread"));
  again.addEventListener("click", () => loadUsageMenu(menu));
  actions.append(again);
  menu.append(actions);
}

async function loadUsageMenu(menu) {
  if (typeof window.atlas?.claudeUsage !== "function") {
    renderUsageMenu(menu, { state: "failed", reason: "unsupported" });
    return;
  }
  const response = await window.atlas.claudeUsage();
  renderUsageMenu(menu, response.ok ? response.data : { state: "failed", reason: response.error?.reasonCode || response.error?.code });
}

// While the menu is open, the measurement rereads itself: the Gateway updates it during an agent turn.
const USAGE_MENU_REFRESH_MS = 20_000;
let usageMenuTimer = null;

function toggleUsageMenu() {
  const menu = $("usageMenu");
  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }
  menu.classList.remove("hidden");
  menu.replaceChildren(el("div", "usage-title", tx("Usage")), el("div", "muted", tx("Reading…")));
  loadUsageMenu(menu);
  clearInterval(usageMenuTimer);
  usageMenuTimer = setInterval(() => {
    if (menu.classList.contains("hidden")) {
      clearInterval(usageMenuTimer);
      usageMenuTimer = null;
      return;
    }
    loadUsageMenu(menu);
  }, USAGE_MENU_REFRESH_MS);
}

function renderHeader() {
  const info = atlasState.info;
  $("appVersion").textContent = info
    ? tx("v{appVersion} · kit {value}", { appVersion: info.appVersion, value: info.kit ? info.kit.version : tx("not accepted") }) : tx("loading");
  const fixture = Boolean(info && info.fixture);
  // The mode badge is shown only where Atlas works without the controller.
  const badge = $("modeBadge");
  const modeWord = fixture ? tx("fixture") : info?.mode === "paperclip" ? "paperclip"
    : info?.mode === "direct" ? tx("direct mode") : null;
  badge.textContent = modeWord ?? "";
  badge.className = `badge ${fixture ? "fixture" : "live"}${modeWord === null ? " hidden" : ""}`;
  const account = accountLine();
  const accountChip = $("accountChip");
  accountChip.textContent = account.text;
  accountChip.title = account.title;
  accountChip.className = `chip account ${account.tone}`;
  accountChip.classList.toggle("hidden", fixture);
  $("fixtureBanner").classList.toggle("hidden", !fixture);
  // The kit delivery failed its check: the host created neither a connection nor
  // any changes. The window says so plainly and does not try to fix anything.
  const delivery = info?.delivery ?? null;
  const rejected = delivery !== null && delivery.status !== "verified";
  $("deliveryBanner").classList.toggle("hidden", !rejected);
  if (rejected) {
    $("deliveryBanner").textContent = tx("The kit delivery failed its check ({reasonCode}). ", { reasonCode: delivery.reasonCode })
      + tx("The connection and all changes are disabled. The kit files are not repaired automatically, and no other version ")
      + tx("is loaded: the accepted delivery {releaseId} is required.", { releaseId: delivery.releaseId });
  }

  // The connection is an indicator: a dot and one word; details are in the tooltip and in “Readiness”.
  const chip = $("connectionChip");
  const connection = atlasState.connection;
  if (connection && connection.available) {
    const remaining = Date.parse(connection.validUntilUtc) - Date.now();
    chip.textContent = tx("connected");
    chip.title = [tx("Controller Gateway {projectId}, generation {generation}.", { projectId: connection.projectId, generation: connection.generation }),
      remaining > 0 ? tx("The connection key is valid for {value} more min and renews itself.", { value: Math.floor(remaining / 60000) })
        : tx("The connection key has expired: refresh.")].join("\n");
    chip.className = "chip status ok";
  } else {
    const runtime = atlasState.runtime || {};
    const reason = (connection && connection.error && (connection.error.reasonCode || connection.error.code))
      || runtime.reasonCode || runtime.lifecycle || tx("unavailable");
    // A wrong controller setup is described in words, not only by a code.
    const configuration = describeConfiguration(info?.configuration ?? null);
    const misconfigured = configuration !== null && configuration.tone !== "note";
    chip.textContent = misconfigured ? tx("not configured") : tx("unavailable");
    chip.title = misconfigured ? [configuration.title, ...configuration.details].join("\n")
      : tx("The controller Gateway is unavailable: {reason}.", { reason });
    chip.className = "chip status bad";
  }

  $("kitLine").textContent = !info ? ""
    : info.kit
      ? tx("release {releaseId} · kit {version} · client {clientVersion} · contract {contractVersion}", { releaseId: info.kit.releaseId, version: info.kit.version, clientVersion: info.kit.clientVersion, contractVersion: info.kit.contractVersion })
      : tx("kit not accepted: {value}", { value: info.delivery?.reasonCode ?? tx("app::unknown") });
  const available = atlasState.operations.filter((entry) => entry.status === "available").length;
  $("operationsLine").textContent = atlasState.operations.length > 0
    ? tx("operations: {available}/{length}", { available, length: atlasState.operations.length }) : "";
}

const LEVEL_TITLES = Object.freeze({
  4: tx("04 / STRATEGIC WORLD"),
  3: tx("03 / PROJECT TERRITORY"),
  2: tx("02 / FEATURE QUARTER"),
  1: tx("01 / WORKSPACE"),
});

const LEVEL_HINTS = Object.freeze({
  4: tx("Wheel — zoom · drag the background — pan · double-click a project — go inside. ")
    + tx("The World HQ is left of the projects — the world lead and its tasks."),
  3: tx("Move quarters around: the project grows to fit them. The HQ in the top left corner holds the goal, team and decisions; quarters do not overlap it."),
  2: tx("Move agents around inside the quarter. Double-click an agent — workspace."),
  1: tx("The agent workspace is open over the map. Esc — back to the map."),
});

/** The world without the service world project: it is not counted as a project in the counters and the navigator. */
function projectsOnly(world) {
  if (world === null || world === undefined || world.status !== "ready") return world;
  return { ...world, projection: { ...world.projection,
    projects: world.projection.projects.filter((project) => project.projectId !== WORLD_PROJECT) } };
}

function atlasOnHudChanged() {
  const level = sceneLevel();
  const scope = sceneScope();
  const world = atlasState.world !== null && atlasState.world.status === "ready" ? atlasState.world : null;
  const project = world === null ? null
    : world.projection.projects.find((item) => item.projectId === scope.projectId) ?? null;
  const quarter = project === null ? null
    : project.quarters.find((item) => item.quarterId === scope.quarterId) ?? null;

  $("scopeEyebrow").textContent = LEVEL_TITLES[level] ?? LEVEL_TITLES[4];
  $("scopeName").textContent = level >= 4 ? tx("Project map")
    : level === 3 ? (project?.projectId ?? tx("No project selected"))
      : (quarter?.quarterId ?? project?.projectId ?? tx("No quarter selected"));

  $("scopeMeta").textContent = level >= 4
    ? worldCountLine(projectsOnly(world))
    : level === 3 && project !== null
      ? `${countWords(project.quarters.length, QUARTER_FORMS)} · ${countWords(project.quarters.reduce((sum, q) => sum + q.agents.length, 0), AGENT_FORMS)}`
      : quarter !== null ? countWords(quarter.agents.length, AGENT_FORMS) : "";
  $("scopeDescription").textContent = LEVEL_HINTS[level] ?? "";

  for (const button of document.querySelectorAll("[data-level]")) {
    button.classList.toggle("active", Number(button.dataset.level) === level);
  }
  // The minimap title names the place the person has entered: the project name must not
  // disappear from it when going inside.
  $("minimapScope").textContent = level >= 4 || project === null
    ? tx("WORLD") : (quarter !== null && level <= 2 ? `${project.projectId} / ${quarter.quarterId}` : project.projectId);
  $("mapHint").innerHTML = tx("Wheel or + and − — zoom · drag the background or Space — pan · right-click — actions<br>")
    + tx("1–4 — levels · F — fit the selection · Backspace — World HQ · corner of the selected quarter, HQ or agent — size · ")
    + tx("Ctrl+C / Ctrl+V — blueprint · Esc — back");
  renderCrumbs(level, project, quarter);
  renderNavigator();
}

function renderCrumbs(level, project, quarter) {
  const bar = $("mapCrumbs");
  bar.replaceChildren();
  const crumb = (label, handler, current) => {
    const button = el("button", `small crumb${current ? " active" : ""}`, label);
    button.addEventListener("click", handler);
    return button;
  };
  bar.append(crumb(tx("World"), () => goLevel(LEVEL.world), level >= 4));
  if (project !== null) {
    bar.append(crumb(project.projectId, () => goProject(project.projectId), level === 3));
  }
  if (quarter !== null && level <= 2) {
    bar.append(crumb(quarter.quarterId,
      () => goQuarter(project.projectId, quarter.quarterId), level === 2));
  }
}

function atlasOnScopeChanged() {
  atlasOnHudChanged();
}

function atlasOnHistoryChanged() {
  const history = sceneHistory();
  if (history === null) return;
  $("mapUndo").disabled = !history.canUndo;
  $("mapRedo").disabled = !history.canRedo;
  $("mapUndo").title = history.undoLabel ?? tx("Nothing to undo");
}

// --- world navigator --------------------------------------------------------------

function renderNavigator() {
  const list = $("worldNavList");
  if (list === null) return;
  const raw = atlasState.world !== null && atlasState.world.status === "ready" ? atlasState.world : null;
  const world = projectsOnly(raw);
  const attention = aggregateAttention(raw);
  const scope = sceneScope();
  list.replaceChildren();
  if (world === null) {
    list.append(el("div", "empty", tx("World not read.")));
    $("worldNavSummary").textContent = "";
    return;
  }
  // World HQ first, above the projects: the main base is always at hand.
  const lead = worldLeadOf();
  const hq = el("button", `nav-project world${scene.selection?.kind === "world" ? " active" : ""}`);
  hq.append(el("span", "nav-symbol", "★"));
  hq.append(el("span", "nav-name", tx("World HQ")));
  const leadSignal = lead === null ? undefined : attention.byAgent.get(lead.agentId);
  if (leadSignal !== undefined) hq.append(el("span", `nav-badge severity-${leadSignal.severity}`, `! ${leadSignal.count}`));
  else hq.append(el("span", "nav-sub", lead === null ? tx("no lead") : leadStateWords(lead)));
  hq.title = tx("World HQ — Backspace");
  hq.addEventListener("click", () => {
    selectNode(worldHqNode(), { focus: true });
    if (leadSignal !== undefined) atlasOpenAttention({ projectId: lead.projectId, quarterId: lead.quarterId, agentId: lead.agentId });
  });
  list.append(hq);
  const agents = world.projection.projects
    .reduce((sum, item) => sum + item.quarters.reduce((inner, q) => inner + q.agents.length, 0), 0);
  $("worldNavSummary").textContent = `${countWords(world.projection.projects.length, PROJECT_FORMS)} · ${countWords(agents, AGENT_FORMS)}`;
  if (world.projection.projects.length === 0) {
    list.append(el("div", "empty", tx("No projects. Right-click the map → create a project.")));
    return;
  }
  for (const project of world.projection.projects) {
    const button = el("button", `nav-project${project.projectId === scope.projectId ? " active" : ""}`);
    const symbol = sceneGetLayout()?.projects[project.projectId]?.symbol
      ?? project.projectId.slice(0, 2).toUpperCase();
    button.append(el("span", "nav-symbol", symbol));
    button.append(el("span", "nav-name", project.projectId));
    const signal = attention.byProject.get(project.projectId);
    if (signal === undefined) button.append(el("span", "nav-sub", "—"));
    else button.append(el("span", `nav-badge severity-${signal.severity}`, `! ${signal.count}`));
    button.addEventListener("click", () => {
      goProject(project.projectId);
      // A project where something waits for the person also opens its list at once.
      if (signal !== undefined) atlasOpenAttention({ projectId: project.projectId, quarterId: null, agentId: null });
    });
    list.append(button);
  }
}

// --- attention ----------------------------------------------------------------

/** One line about what exactly the person is expected to do. */
const TURN_FINISHED_WORDS = Object.freeze({
  completed: tx("turn finished — the answer is waiting for you"),
  interrupted: tx("turn stopped — waiting for you"),
  failed: tx("turn failed"),
});

/**
 * The turn of the agent ended while nobody was looking at its conversation: attention stays until
 * the conversation is opened (turn-seen.mjs in the host). An open chat clears
 * the mark at once, without waiting for the next reread.
 */
function atlasMarkTurnSeen(agentId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready" || !Array.isArray(world.attention)) return;
  const finished = world.attention.filter((item) => item.kind === "turn-finished" && item.agentId === agentId);
  if (finished.length === 0) return;
  world.attention = world.attention.filter((item) => !finished.includes(item));
  for (const item of finished) window.atlas.turnSeen({ agentId, operationId: item.operationId });
  if (atlasState.ui.attentionOpen) renderAttention();
  requestRender();
}

/** A problem code in words where the person can act on it; any other code as it is. */
const PROBLEM_WORDS = Object.freeze({
  model_unreachable: tx("the agent's model does not answer — its server is off or unreachable; clears after the first successful turn"),
  claude_signed_out: tx("Claude signed out of the account — sign in again (claude-login.bat in the instance folder) and press \"Refresh\"; ")
    + tx("clears after the first successful turn"),
});
const problemWords = (code) => PROBLEM_WORDS[code] ?? code;

const attentionLine = (item) => (item.kind === "interaction"
  ? tx("question: {interactionId}{value}", { interactionId: item.title || item.interactionId, value: item.state ? ` (${item.state})` : "" })
  : item.kind === "turn-finished" ? TURN_FINISHED_WORDS[item.outcome] ?? tx("turn finished")
  : item.kind === "asks-you" ? tx("waiting for your answer: “{question}”", { question: item.question })
  : item.kind === "refused" ? tx("action refused{value} — the agent waits for what to do", { value: item.count > 1 ? ` (${item.count})` : "" })
  : item.kind === "problem" ? tx("problem: {value}", { value: problemWords(item.problemCode) })
    : item.kind === "recovery" ? tx("recovery needed: {count} (according to the catalog)", { count: item.count })
      : item.kind === "captured-pending"
        ? tx("catalog: questions {questions}, approvals {approvals}; pending ones read: {visible}", { questions: item.questions, approvals: item.approvals, visible: item.visible })
        : tx("state: {field} — {value}", { field: item.field, value: item.value }));

const attentionSeverity = (item) => (item.kind === "problem" ? 3
  : item.kind === "state" || item.kind === "recovery" || item.kind === "refused"
    || (item.kind === "turn-finished" && item.outcome === "failed") ? 2 : 1);

/**
 * Attention signals that belong to a scope: an agent, a quarter or a whole
 * project. It is the same grouping as the badges on the map, only in words.
 */
function attentionItemsFor(scope) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return [];
  const items = world.attention ?? [];
  if (scope === null || scope === undefined) return items;
  if (scope.agentId) return items.filter((item) => item.agentId === scope.agentId);
  if (scope.quarterId) {
    return items.filter((item) => item.projectId === scope.projectId
      && item.quarterId === scope.quarterId);
  }
  if (scope.projectId) return items.filter((item) => item.projectId === scope.projectId);
  return items;
}

const scopeTitle = (scope) => (scope === null || scope === undefined ? tx("across all projects")
  : scope.agentId ? tx("agent {agentId}", { agentId: scope.agentId })
    : scope.quarterId ? tx("quarter {quarterId}", { quarterId: scope.quarterId }) : tx("project {projectId}", { projectId: scope.projectId }));

/** Open the attention list, narrowed to what was clicked on the map. */
function atlasOpenAttention(scope = null) {
  // The inspector, the attention list and readiness share one place on the right:
  // only one of them is open.
  $("inspector").classList.add("hidden");
  closeReadiness();
  atlasState.attentionScope = scope === null || scope === undefined ? null : {
    projectId: scope.projectId ?? null,
    quarterId: scope.quarterId ?? null,
    agentId: scope.agentId ?? null,
  };
  renderAttention();
  setPanel("attentionOpen", true);
}

function renderAttention() {
  const list = $("attentionList");
  const world = atlasState.world;
  const ready = world !== null && world.status === "ready";
  const items = ready ? world.attention : [];
  const scope = ready ? atlasState.attentionScope : null;
  const shown = ready ? attentionItemsFor(scope) : [];
  const counter = $("attentionCount");
  counter.textContent = String(items.length);
  counter.classList.toggle("calm", items.length === 0);
  $("attentionToggle").classList.toggle("quiet", items.length === 0);
  $("attentionTitle").textContent = items.length > 0
    ? tx("Need attention · {length}", { length: items.length }) : tx("No attention requests");
  $("attentionSubtitle").textContent = items.length > 0
    ? tx("Open the list for all projects") : tx("Open the list and check the conditions");
  $("attentionSummary").textContent = scope === null
    ? tx("{length} total", { length: items.length }) : tx("{length} of {length2}", { length: shown.length, length2: items.length });

  const incomplete = [];
  if (ready) {
    if (world.projection.truncated) incomplete.push(tx("memory catalog truncated"));
    if (world.interactions && world.interactions.status === "partial") {
      incomplete.push(tx("some questions not read"));
    }
  } else if (world !== null) incomplete.push(tx("world not read"));
  paintDataNotice(incomplete);

  list.replaceChildren();
  if (scope !== null) {
    // The list is narrowed by a click on a map badge — this is visible, and there is a way out of it.
    const row = el("div", "attention-scope");
    row.append(el("span", null, tx("showing: {value}", { value: scopeTitle(scope) })));
    const all = el("button", "small", tx("All projects"));
    all.addEventListener("click", () => atlasOpenAttention(null));
    row.append(all);
    list.append(row);
  }
  if (shown.length === 0) {
    list.append(el("div", "empty", scope === null
      ? tx("Nothing observed that needs a person.")
      : tx("Nothing here is waiting for a person. For other scopes — “All projects”.")));
    return;
  }
  // In brief: one line per agent - project · quarter · agent, what happened, and the chat.
  for (const entry of attentionByAgent(shown)) {
    const box = el("div", `attention-item attention-brief severity-${entry.severity}`);
    box.append(el("div", "attention-kind", attentionPlace(entry.first)));
    box.append(el("div", null, entry.first.agentId));
    box.append(el("div", "muted", entry.what));
    const open = el("button", "small primary", tx("Open chat"));
    open.addEventListener("click", () => atlasOpenAttentionChat(entry.first));
    const actions = el("div", "actions");
    actions.append(open);
    box.append(actions);
    list.append(box);
  }
}

// What happened - in two or three words (details are in the agent's chat).
const ATTENTION_BRIEF = Object.freeze({
  interaction: tx("waiting for your decision"), "captured-pending": tx("waiting for your decision"), "asks-you": tx("asked a question"),
  refused: tx("action refused"), problem: tx("problem"), state: tx("failed"), recovery: tx("recovery needed"),
});

/** the signal's "project · quarter"; leads are in the HQ. */
const attentionPlace = (item) => (item.projectId === WORLD_PROJECT ? tx("World HQ")
  : item.quarterId === HEADQUARTERS_QUARTER ? tx("{projectId} · HQ", { projectId: item.projectId })
    : `${item.projectId} · ${item.quarterId}`);

/** The signals, gathered by agent, in the order they first appeared. */
function attentionByAgent(items) {
  const byAgent = new Map();
  for (const item of items) {
    const entry = byAgent.get(item.agentId) ?? { first: item, severity: 0, words: [] };
    entry.severity = Math.max(entry.severity, attentionSeverity(item));
    const word = item.kind === "turn-finished" ? TURN_FINISHED_WORDS[item.outcome] ?? tx("turn finished")
      : ATTENTION_BRIEF[item.kind] ?? item.kind;
    if (!entry.words.includes(word)) entry.words.push(word);
    byAgent.set(item.agentId, entry);
  }
  return [...byAgent.values()].map((entry) => ({ ...entry, what: entry.words.join(", ") }));
}

/** Open the chat of the agent the signal is about. */
function atlasOpenAttentionChat(item) {
  const node = { kind: "agent", projectId: item.projectId, quarterId: item.quarterId, agentId: item.agentId };
  // A lead's chat opens where the camera is: on the map a lead is the HQ building.
  const role = findNode(node).agent?.settings?.role ?? null;
  const lead = role === "project-lead" || role === "quarter-lead" || role === "coordinator";
  if (atlasState.ui.attentionOpen) setPanel("attentionOpen", false);
  atlasOpenWorkspace(node, lead ? { camera: false } : undefined);
}

/**
 * Double-click on an attention badge. A “?” - one question waiting for the
 * person - opens that agent's chat, where it is answered. A number or a “!” -
 * problems, refusals, several signals - opens the list of what is behind the
 * badge, even when it is one agent: the person sees the problems first.
 */
function atlasOpenAttentionTarget(scope) {
  const items = attentionItemsFor(scope);
  const agents = attentionByAgent(items);
  const question = items.length === 1 && attentionSeverity(items[0]) === 1;
  if (agents.length === 1 && question) atlasOpenAttentionChat(agents[0].first);
  else atlasOpenAttention(scope);
}

function atlasOnTrayChanged(tray) {
  const list = $("trayList");
  $("trayCount").textContent = String(tray.length);
  $("trayToggle").classList.toggle("has-items", tray.length > 0);
  if (list === null) return;
  list.replaceChildren();
  if (tray.length === 0) {
    list.append(el("div", "empty", tx("Empty: everything the backend returned is placed on the map.")));
    return;
  }
  for (const item of tray) {
    const row = el("div", "tray-item");
    row.append(el("div", "tray-kind",
      item.kind === "agent" ? tx("agent") : item.kind === "quarter" ? tx("quarter") : tx("project")));
    row.append(el("div", null, item.id));
    row.append(el("div", "muted", item.reason));
    list.append(row);
  }
}

// --- inspector ------------------------------------------------------------------

function findNode(node) {
  const world = atlasState.world;
  const projection = world !== null && world.status === "ready" ? world.projection : { projects: [] };
  const project = projection.projects.find((item) => item.projectId === node.projectId) ?? null;
  const quarter = project === null ? null
    : project.quarters.find((item) => item.quarterId === node.quarterId) ?? null;
  const agent = quarter === null ? null
    : quarter.agents.find((item) => item.agentId === node.agentId) ?? null;
  return { project, quarter, agent };
}

function atlasOnSelection(node) {
  const panel = $("inspector");
  panel.replaceChildren();
  updateSelectionBar(node);
  if (node === null) {
    // Nothing is selected — no panel should be on the screen.
    panel.classList.add("hidden");
    return;
  }
  if (isWorkspaceOpen() && node.kind === "agent" && node.agentId === workspaceState.node?.agentId) {
    // The workspace of this agent is already open — a second panel is not needed.
    panel.classList.add("hidden");
    return;
  }
  if (atlasState.ui.attentionOpen) setPanel("attentionOpen", false);
  closeReadiness();
  panel.classList.remove("hidden");
  const head = el("div", "float-head");
  const heading = el("div");
  heading.append(el("div", "kind", node.kind === "agent" ? tx("agent")
    : node.kind === "quarter" ? tx("quarter") : node.kind === "world" ? tx("app::World HQ") : tx("project")));
  // The name the person gave (the ID under it, small, where they differ).
  const kind = node.kind === "agent" ? "agent" : node.kind === "quarter" ? "quarter" : "project";
  const objectId = node.agentId ?? node.quarterId ?? node.projectId;
  heading.append(el("h3", null, node.kind === "world" ? tx("World") : displayName(kind, node.projectId, objectId)));
  if (node.kind !== "world" && displayName(kind, node.projectId, objectId) !== objectId) {
    heading.append(el("div", "muted", tx("ID {objectId}", { objectId })));
  }
  head.append(heading);
  head.append(el("div", "spacer"));
  const close = el("button", "icon-btn flat", "×");
  close.addEventListener("click", () => selectNode(null));
  head.append(close);
  panel.append(head);
  const body = el("div");
  panel.append(body);
  const { project, quarter, agent } = findNode(node);
  if (node.kind === "world") renderWorldInspector(body);
  else if (node.kind === "project" && project !== null) renderProjectInspector(body, project);
  else if (node.kind === "quarter" && quarter !== null) renderQuarterInspector(body, project, quarter);
  else if (node.kind === "agent" && agent !== null) renderAgentInspector(body, project, quarter, agent);
  else body.append(noteBlock("error", tx("This object is no longer in the catalog.")));
  renderAnnotations(body, node);
}

function updateSelectionBar(node) {
  const bar = $("selectionBar");
  if (node === null) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("selectionCount").textContent = node.kind === "world" ? tx("World HQ") : node.agentId ?? node.quarterId ?? node.projectId;
}

function renderAnnotations(container, node) {
  container.append(el("div", "section-title", tx("Your annotations")));
  const current = sceneAnnotationOf(node);
  const role = el("input");
  role.value = current.role;
  role.maxLength = 64;
  role.placeholder = tx("Role");
  role.addEventListener("change", () => sceneSetAnnotation(node, { role: role.value }));
  const note = el("textarea");
  note.rows = 3;
  note.value = current.note;
  note.placeholder = tx("Note");
  note.addEventListener("change", () => sceneSetAnnotation(node, { note: note.value }));
  container.append(role, note);
  container.append(noteBlock("local",
    tx("Role, note, position, symbol and color are your local data. The backend does not know them.")));
}

function renderProjectInspector(body, project) {
  body.append(infoRow(tx("memory, rev."), project.memory.revision));
  body.append(infoRow(tx("quarters"), project.quarters.length));
  body.append(infoRow(tx("agents"), project.quarters.reduce((sum, q) => sum + q.agents.length, 0)));

  const actions = el("div", "actions");
  const hq = el("button", "small primary", tx("Project HQ"));
  hq.addEventListener("click", () => atlasOpenHeadquarters(project.projectId));
  actions.append(hq);
  actions.append(actionButton(tx("Memory"), "query.memory.scope.read",
    () => openMemorySheet(project.memory.scopeId, tx("Project memory · {projectId}", { projectId: project.projectId }))));
  actions.append(actionButton(tx("Create quarter…"), "mutation.memory.scope.create",
    () => openCreateScopeSheet("quarter", project.projectId)));
  body.append(actions);
  projectFolderSection(body, project.projectId);

  body.append(el("div", "section-title", tx("Appearance")));
  const symbol = el("input");
  symbol.maxLength = 3;
  symbol.placeholder = tx("Symbol, up to 3 characters");
  symbol.value = sceneGetLayout()?.projects[project.projectId]?.symbol ?? "";
  symbol.addEventListener("change", () => {
    sceneSetAppearance(project.projectId, { symbol: symbol.value });
    renderNavigator();
  });
  body.append(symbol);
  const compact = el("button", "small", tx("Fit bounds"));
  compact.addEventListener("click", () => sceneCompactProject(project.projectId));
  body.append(compact);
}

function renderQuarterInspector(body, project, quarter) {
  body.append(infoRow(tx("project"), project.projectId));
  body.append(infoRow(tx("memory, rev."), quarter.memory.revision));
  body.append(infoRow(tx("agents"), quarter.agents.length));
  const actions = el("div", "actions");
  actions.append(actionButton(tx("Memory"), "query.memory.scope.read",
    () => openMemorySheet(quarter.memory.scopeId, tx("Quarter memory · {quarterId}", { quarterId: quarter.quarterId }))));
  actions.append(actionButton(tx("Create agent…"), "mutation.memory.agent.create",
    () => openCreateAgentSheet(project.projectId, quarter.quarterId), { primary: true }));
  body.append(actions);
}

function renderAgentInspector(body, project, quarter, agent) {
  if (agent.settings?.role === "coordinator") body.append(infoRow(tx("role"), tx("world lead")));
  body.append(infoRow(tx("state"), agent.state));
  body.append(infoRow(tx("memory content"), agent.contentState));
  body.append(infoRow(tx("delivery"), agent.deliveryState));
  body.append(infoRow(tx("problem code"), agent.problemCode));
  body.append(infoRow(tx("current operation"), agent.currentOperationId));
  body.append(infoRow(tx("task progress"), agent.taskProgress));
  body.append(noteBlock("note",
    tx("The backend does not report progress or the attention flag — the fields stay empty until an exact join exists.")));

  const result = el("div");
  const actions = el("div", "actions");
  const node = {
    kind: "agent", projectId: project.projectId, quarterId: quarter.quarterId, agentId: agent.agentId,
  };
  const open = el("button", "small primary", tx("Workspace"));
  open.addEventListener("click", () => atlasOpenWorkspace(node));
  actions.append(open);
  const skills = el("button", "small", tx("Skills · {length}", { length: sceneSkillsOf(node).length }));
  skills.addEventListener("click", () => atlasOpenSkills(node));
  actions.append(skills);

  const stop = actionButton(tx("Stop turn"), "mutation.agent-control.interrupt", async () => {
    const response = await window.atlas.interrupt({
      agentId: agent.agentId, operationId: agent.currentOperationId,
    });
    const shown = outcomeMessage(response, tx("Stop requested: accepted does not mean finished."));
    result.replaceChildren(noteBlock(shown.kind === "error" ? "error" : "note", shown.text));
    await refresh();
  });
  if (agent.currentOperationId === null) {
    stop.disabled = true;
    stop.title = tx("The agent has no current operation");
  }
  actions.append(stop);

  const close = actionButton(tx("Archive agent"), "mutation.memory.agent.close", async () => {
    const response = await window.atlas.closeAgent({ agentId: agent.agentId });
    const shown = outcomeMessage(response, tx("The agent is archived: its conversation stays available for reading."));
    result.replaceChildren(noteBlock(shown.kind === "error" ? "error" : "note", shown.text));
    await refresh();
    refreshArchiveCount();
  });
  if (agent.state === "archived") {
    close.disabled = true;
    close.title = tx("Already archived");
  }
  actions.append(close);
  body.append(actions, result);
  // Whether the agent takes controller tasks is a permanent state, always visible here.
  deskAgentSection(body, agent);
}

// --- readiness ----------------------------------------------------------------------

const OPERATION_TITLES = Object.freeze({
  "query.memory.scopes.list": tx("Memory list"),
  "query.memory.scope.read": tx("Memory read"),
  "query.memory.agents.list": tx("Agent list"),
  "query.memory.agent.read": tx("Agent details"),
  "query.memory.agent.context": tx("Agent memory"),
  "query.memory.agent.archive": tx("Archived conversation"),
  "query.agent-control.interactions": tx("Agent questions"),
  "query.agent-conversation.resolve": tx("Agent-to-conversation binding"),
  "query.agent-conversation.read": tx("Live conversation (read)"),
  "query.project-workspace.list": tx("Project folders"),
  "query.project-workspace.read": tx("Project files (read)"),
  "query.agent-artifacts.list": tx("Agent artifacts"),
  "query.agent-artifacts.read": tx("Artifact read"),
  "query.agent-events.read": tx("Agent events"),
  "mutation.project-workspace.save": tx("Project file save"),
  "mutation.memory.project.copy": tx("Project copy with memory"),
  "receipt.memory.agent.send": tx("Send receipt"),
  "mutation.memory.scope.create": tx("Project and quarter creation"),
  "mutation.memory.agent.create": tx("Agent creation"),
  "mutation.memory.agent.send": tx("Sending to an agent"),
  "mutation.memory.agent.close": tx("Agent closing"),
  "approval.agent-control.respond": tx("Answer to a question"),
  "mutation.agent-control.interrupt": tx("Turn stop"),
});

/**
 * What the desktop expects from the backend. Ordered by usefulness to the person. Items without
 * operations cannot be detected today: their contract is not published yet, and the desktop
 * guesses neither the field name nor the stream identifier.
 */
const EXPECTED_TITLES = Object.freeze({
  "several-sources": [tx("Several agents at once"),
    tx("Right now the Gateway starts for one source, and switching to another needs a restart. Without this, live chat works for only one agent.")],
  "owner-chat": [tx("Write to the agent thread directly"),
    tx("The desktop already reads the live conversation by the agent binding, but still writes through agent memory.")],
  "provider-interactions": [tx("Provider questions and approvals"),
    tx("Provider requests, separate from the questions that now come through agent memory.")],
});

async function loadExpected() {
  if (typeof window.atlas.expected !== "function") return;
  const response = await window.atlas.expected();
  atlasState.expected = response.ok ? response.data : null;
}

const expectedOf = (capabilityId) => (atlasState.expected ?? [])
  .find((item) => item.capabilityId === capabilityId) ?? null;

function readinessRow(title, detail, state, stateLabel, hint = null) {
  const row = el("div", "ready-row");
  const text = el("div", "ready-text");
  text.append(el("div", "ready-title", title));
  if (detail) text.append(el("div", "ready-detail", detail));
  const chip = el("span", `ready-chip ${state}`, stateLabel);
  if (hint) chip.title = hint;
  row.append(text, chip);
  return row;
}

// --- whether the agents' models answer (host/model-health.mjs) ---------------------------------------

const MODEL_STATE_WORDS = Object.freeze({
  answers: tx("answers"), "not-answering": tx("not answering"), error: tx("server error"), "not-checked": tx("not checked"),
});
const MODEL_HEALTH_EVERY_MS = 60_000;

/** The last check of a model by its id, or null when it is not one the host checks. */
function modelCheck(modelId) {
  const models = atlasState.modelHealth?.state === "known" ? atlasState.modelHealth.models : [];
  return models.find((item) => item.id === modelId) ?? null;
}

/** " — not answering" after a model's name in a list while its server is known to be off. */
function modelStateSuffix(modelId) {
  const state = modelCheck(modelId)?.state;
  return state === "not-answering" || state === "error" ? ` — ${MODEL_STATE_WORDS[state]}` : "";
}

/** The model of an agent whose server is known not to answer now, or null. */
function modelDown(agent) {
  const check = agent?.profile?.model ? modelCheck(agent.profile.model) : null;
  return check !== null && (check.state === "not-answering" || check.state === "error") ? check : null;
}

/** The line under an open chat's field: the agent's model does not answer now. */
function atlasPaintModelNote() {
  const note = $("chatModelNote");
  if (note === null) return;
  const down = modelDown(agentOf());
  note.classList.toggle("bad", down !== null);
  note.textContent = down === null ? "" : tx("The model {name} is not answering now (checked at {time}): a message may end as \"the model does not answer\".",
    { name: down.name, time: clockOf(down.checkedAtUtc) });
}

const clockOf = (atUtc) => (atUtc ? new Date(atUtc).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" }) : "?");

async function refreshModelHealth({ force = false } = {}) {
  const answer = typeof window.atlas.modelHealth === "function" ? await window.atlas.modelHealth({ force }) : null;
  atlasState.modelHealth = answer?.ok ? answer.data : null;
  if (!$("readinessPanel").classList.contains("hidden")) renderReadiness();
  atlasPaintModelNote();
}

/** "Readiness" → "Models": each checked model server, its state and when it was asked; "Check now". */
function modelHealthRows(body) {
  const health = atlasState.modelHealth;
  if (health?.state !== "known" || health.models.length === 0) return;
  body.append(el("div", "section-title", tx("Models")));
  for (const model of health.models) {
    const detail = model.state === "not-checked"
      ? tx("No address to check: give this model \"check\" in acp-provider.json.")
      : tx("{address} · checked at {time}", { address: model.address ?? "?", time: clockOf(model.checkedAtUtc) })
        + (model.httpStatus === null ? "" : ` · HTTP ${model.httpStatus}`);
    body.append(readinessRow(model.name, detail, model.state === "answers" ? "ok" : model.state === "not-checked" ? "wait" : "bad",
      MODEL_STATE_WORDS[model.state] ?? model.state));
  }
  const again = el("button", "small", tx("Check now"));
  again.id = "modelHealthCheck";
  again.addEventListener("click", () => refreshModelHealth({ force: true }));
  body.append(again);
}

/** A language's own name, capitalized ("English"; Russian in Russian), from the system, not from a list here. */
function languageName(code) {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

/**
 * The window's language (i18n-core.js): the languages with a locale file, the current one chosen. The choice is
 * this PC's window setting (ui-state.json); the window then reloads in it, after writing what it has pending.
 */
function languageRow() {
  const row = el("div", "ready-row");
  const text = el("div", "ready-text");
  text.append(el("div", "ready-title", tx("Language")),
    el("div", "ready-detail", tx("The window's language on this PC. Another language is a locale file in frontend/locales.")));
  const select = el("select", "language-select");
  select.id = "languageSelect";
  for (const code of window.atlas?.locale?.available ?? ["en"]) {
    const option = el("option", null, languageName(code));
    option.value = code;
    option.selected = code === currentLanguage();
    select.append(option);
  }
  select.addEventListener("change", async () => {
    atlasState.ui.language = select.value;
    await window.atlas.writeUiState(atlasState.ui);
    await flushPending();
    location.reload();
  });
  row.append(text, select);
  return row;
}

const GATEWAY_STATE_WORDS = Object.freeze({
  ready: tx("ready"), expired: tx("session expired"), stale: tx("descriptor stale"), uncertain: tx("state unknown"),
  stopped: tx("stopped"), starting: tx("starting"), unknown: tx("app::not reported"),
});

function renderReadiness() {
  const body = $("readinessBody");
  if (body === null) return;
  // The Gateway panel (gateway-panel.js) comes first and is not rebuilt: someone
  // may be typing an API key in it.
  for (const child of [...body.children]) if (child.id !== "gatewayPanel") child.remove();
  const connection = atlasState.connection;
  const connected = Boolean(connection && connection.available);

  body.append(languageRow());
  modelHealthRows(body);

  // The delivery is checked first: without an accepted kit nothing else starts.
  body.append(el("div", "section-title", tx("Delivery")));
  const delivery = atlasState.info?.delivery ?? null;
  if (delivery !== null && delivery.status === "verified") {
    body.append(readinessRow(tx("Kit {version} · release {releaseId}", { version: delivery.version, releaseId: delivery.releaseId }),
      tx("manifest {value}… · files checked: {filesChecked}. ", { value: delivery.manifestSha256.slice(0, 16), filesChecked: delivery.filesChecked })
        + tx("These are only the kit files: the check says nothing about the Gateway readiness."),
      "ok", tx("accepted")));
  } else {
    body.append(readinessRow(tx("Kit"), delivery === null ? tx("Delivery state not read.")
      : tx("The connection and changes are disabled until a delivery is accepted."),
    "bad", delivery === null ? tx("app::unknown") : delivery.reasonCode));
  }

  body.append(el("div", "section-title", tx("Controller")));
  const configuration = describeConfiguration(atlasState.info?.configuration ?? null);
  if (configuration === null) {
    body.append(readinessRow(tx("Fixture"), tx("The controller is not used: the data is synthetic."), "wait", tx("fixture")));
  } else {
    body.append(readinessRow(configuration.title, configuration.details.join(" "),
      configuration.tone === "note" ? "ok" : "bad", configuration.tone === "note" ? tx("configured") : tx("setup error")));
  }
  // The instance's mode (plan 5.1): everything on this PC, or the world and projects between PCs.
  const sync = atlasState.sync;
  if (sync?.mode === "synced" && sync.configured === true) {
    const pc = sync.machine?.title ?? sync.machine?.machineId ?? null;
    body.append(readinessRow(tx("Mode: synced"),
      tx("The world and projects move between PCs: \"Take\" and \"Hand over\" are in the \"World\" chip.") + " "
        + (pc === null ? tx("This PC has no name: agents-factory machine set.") : tx("This PC — \"{pc}\".", { pc }))
        + (sync.world?.held ? tx(" The world is here.") : tx(" The world is handed over.")),
      pc === null ? "bad" : "ok", sync.world?.held ? tx("world here") : tx("world handed over")));
  } else if (sync?.mode === "local") {
    body.append(readinessRow(tx("Mode: local"),
      tx("Everything on this PC, no repositories. To work on several PCs: agents-factory instance mode --set synced."), "ok", tx("local")));
  }

  if (atlasState.info?.mode === "direct") {
    body.append(el("div", "section-title", "Claude Code"));
    const account = claudeAccountOf();
    if (account === null || account.state === "checking") {
      body.append(readinessRow(tx("Account"), tx("Claude Code is asked when the desktop opens, with no message and no usage."), "wait", tx("checking")));
    } else if (account.state === "signed-out") {
      body.append(readinessRow(tx("Account: not signed in"),
        tx("Claude Code on this computer is not signed in to an account: the agents cannot work. Sign in from a terminal: claude auth login — then click “Refresh”."),
        "bad", tx("not signed in")));
    } else if (account.state === "known") {
      const byKey = account.authMethod !== null && /api.?key/iu.test(account.authMethod);
      body.append(readinessRow(tx("Account: {value}", { value: account.email ?? tx("no email") }),
        [account.organization === null ? null : tx("organization {organization}", { organization: account.organization }),
          account.subscriptionType === null ? null : tx("subscription {subscriptionType}", { subscriptionType: account.subscriptionType }),
          byKey ? tx("billed by API key ({authMethod})", { authMethod: account.authMethod }) : tx("sign-in: {value}", { value: account.authMethod ?? tx("app::Claude account") })]
          .filter((part) => part !== null).join(" · ")
          + tx(". The agents work under it and use up its limits."),
        byKey ? "wait" : "ok", byKey ? tx("API key") : tx("signed in")));
    } else {
      body.append(readinessRow(tx("Account"), tx("Could not ask Claude Code: {value}.", { value: account.reason ?? tx("no reason given") }), "bad", tx("app2::unknown")));
    }
  }

  body.append(el("div", "section-title", tx("Connection")));
  // The Gateway state comes only from the host summary and the connection result.
  const gateway = gatewayState({ runtime: atlasState.runtime, connection });
  const runtime = atlasState.runtime ?? {};
  body.append(readinessRow(tx("Gateway: {value}", { value: GATEWAY_STATE_WORDS[gateway] ?? gateway }),
    tx("lifecycle {value} · monitor {value2} · ", { value: runtime.lifecycle ?? tx("app2::not reported"), value2: runtime.monitorState ?? tx("app2::not reported") })
      + tx("heartbeat {value}. Renewing the descriptor of the same instance is not a restart.", { value: runtime.heartbeatAtUtc ?? tx("app2::not reported") }),
    gateway === "ready" ? "ok" : gateway === "unknown" ? "wait" : "bad", gateway));
  if (connected) {
    const remaining = Date.parse(connection.validUntilUtc) - Date.now();
    body.append(readinessRow(tx("Gateway · {projectId}", { projectId: connection.projectId }),
      tx("generation {generation} · {value}", { generation: connection.generation, value: remaining > 0 ? tx("connection key for {value} more min, renews itself", { value: Math.floor(remaining / 60000) }) : tx("connection key expired") }),
      "ok", tx("connected")));
  } else {
    const reason = (connection?.error && (connection.error.reasonCode || connection.error.code))
      || atlasState.runtime?.reasonCode || tx("app::unknown");
    body.append(readinessRow(tx("app::Gateway"), tx("Without a connection nothing listed below works."), "bad", reason));
  }

  const operations = atlasState.operations;
  const available = operations.filter((entry) => entry.status === "available").length;
  body.append(el("div", "section-title", tx("Desktop operations · {available} of {length}", { available, length: operations.length })));
  if (operations.length === 0) body.append(el("div", "empty", tx("Gateway not read — the operation status is unknown.")));
  for (const entry of operations) {
    const ok = entry.status === "available";
    body.append(readinessRow(OPERATION_TITLES[entry.operationId] ?? entry.operationId, entry.operationId,
      ok ? "ok" : "bad", ok ? tx("available") : (entry.reasonCode ?? entry.status)));
  }

  body.append(el("div", "section-title", tx("Trusted actions")));
  const trusted = atlasState.trusted;
  body.append(readinessRow(tx("Folder binding and memory saving"),
    trusted.acl === "not-hardened" ? tx("directory permissions not hardened: {value}", { value: trusted.aclReasonCode ?? "" }) : null,
    trusted.available ? "ok" : "bad", trusted.available ? tx("app::available") : (trusted.reasonCode ?? tx("app::unavailable"))));

  body.append(el("div", "section-title", tx("Expected from the backend")));
  for (const [capabilityId, [title, detail]] of Object.entries(EXPECTED_TITLES)) {
    const found = expectedOf(capabilityId);
    let state = "wait";
    let label = tx("expected");
    let hint = tx("The contract does not say yet how to detect this.");
    if (found !== null && found.detectable) {
      hint = found.operations.map((entry) => `${entry.operationId}: ${entry.status}`
        + (entry.reasonCode ? ` (${entry.reasonCode})` : "")).join("\n");
      if (found.advertised) {
        state = "ok";
        label = tx("advertised");
      } else {
        label = tx("not advertised");
      }
    } else if (found === null && connected) {
      label = tx("not read");
      hint = tx("The status of the expected capabilities is not read.");
    }
    body.append(readinessRow(title, detail, state, label, hint));
  }
  const route = chatRouteFor(null);
  body.append(noteBlock("note", tx("The conversation currently works like this: {title}. {reason}", { title: route.title, reason: route.reason })));
  $("readinessSummary").textContent = connected ? tx("{available} of {length} operations", { available, length: operations.length }) : tx("no connection");
}

/**
 * Which route the conversation with an agent takes. Sending always goes through agent memory:
 * the backend has not advertised writing to the thread directly yet. The conversation is read by the
 * binding the backend keeps (query.agent-conversation.*): the desktop does not
 * guess the thread. If live reading is not advertised, the captured archive remains.
 */
function chatRouteFor(agent) {
  const liveRead = ["query.agent-conversation.resolve", "query.agent-conversation.read"]
    .every((operationId) => operationStatus(operationId)?.status === "available");
  if (!liveRead) {
    const via = tx("agent memory and the captured archive");
    return { kind: "memory", via, title: tx("sending via {via}", { via }),
      reason: tx("The Gateway has not advertised reading the live conversation by the agent binding.") };
  }
  const via = tx("agent memory, reading the live conversation by binding");
  return { kind: "memory-live", via, title: tx("sending via {via}", { via }),
    reason: agent === null || agent === undefined
      ? tx("The agent binding in the backend decides which thread to read; an archived agent is read from the archive.")
      : tx("The agent binding in the backend sets the thread; the desktop does not guess it.") };
}

function atlasOpenReadiness() {
  $("inspector").classList.add("hidden");
  if (atlasState.ui.attentionOpen) setPanel("attentionOpen", false);
  $("readinessPanel").classList.remove("hidden");
  renderReadiness();
  atlasGatewayPanelOpen();
  loadExpected().then(renderReadiness);
}

const closeReadiness = () => $("readinessPanel").classList.add("hidden");

// --- agent skills -------------------------------------------------------------------

/**
 * Agent skills are a tab of its workspace, not a separate window next to it.
 * The library of installed skills will come with the next backend; for now it is your
 * list: it is kept next to the layout, goes nowhere and by itself changes nothing in
 * the work of the agent. redraw redraws whatever the list is placed in.
 */
function renderSkillsInto(body, node, redraw) {
  const skills = sceneSkillsOf(node);
  body.append(el("div", "section-title", tx("Installed · {length}", { length: skills.length })));
  if (skills.length === 0) body.append(el("div", "empty", tx("No skills yet.")));
  skills.forEach((name, index) => {
    const row = el("div", "skill-row");
    row.append(el("span", "skill-name", name));
    const remove = el("button", "small", tx("Remove"));
    remove.addEventListener("click", () => {
      const next = skills.slice();
      next.splice(index, 1);
      sceneSetSkills(node, next);
      atlasRecord("info", tx("skill removed from the list"), `${node.agentId}: ${name}`);
      redraw();
    });
    row.append(remove);
    body.append(row);
  });

  const add = el("div", "skill-add");
  const field = el("input");
  field.maxLength = 64;
  field.placeholder = tx("Skill name");
  const submit = el("button", "small primary", tx("Add"));
  const commit = () => {
    const value = field.value.trim();
    if (value === "") return;
    if (skills.length >= 32) {
      body.append(noteBlock("error", tx("The list already has 32 skills — that is the limit.")));
      return;
    }
    sceneSetSkills(node, skills.concat(value));
    atlasRecord("info", tx("skill added to the list"), `${node.agentId}: ${value}`);
    redraw();
  };
  submit.addEventListener("click", commit);
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commit();
  });
  add.append(field, submit);
  body.append(add);
  body.append(noteBlock("local",
    tx("This is your list. The backend does not report skills yet and does nothing with them: ")
    + tx("the library of installed skills will appear in its next version.")));
}

/** Agent skills open as a tab of its workspace. */
function atlasOpenSkills(node) {
  atlasOpenWorkspace(node, { tab: "skills" });
}

// --- blueprint: Ctrl+C and Ctrl+V -----------------------------------------------------

function blueprintCount(blueprint) {
  const root = blueprint.root;
  const quarters = blueprint.kind === "project" ? root.children.length
    : blueprint.kind === "quarter" ? 1 : 0;
  const agents = blueprint.kind === "agent" ? 1
    : blueprint.kind === "quarter" ? root.children.length
      : root.children.reduce((sum, item) => sum + item.children.length, 0);
  return { quarters, agents };
}

const KIND_NAMES = Object.freeze({ project: tx("project"), quarter: tx("quarter"), agent: tx("agent") });

function atlasCopyBlueprint() {
  if (scene.selection?.kind === "world") {
    atlasToast(tx("The World HQ is not copied: there is only one for the whole world."));
    return;
  }
  const blueprint = sceneCopyBlueprint(scene.selection);
  if (blueprint === null) {
    atlasToast(tx("Nothing to copy: first select an object on the map."));
    return;
  }
  atlasState.clipboard = blueprint;
  const { quarters, agents } = blueprintCount(blueprint);
  const inside = blueprint.kind === "agent" ? ""
    : tx(" (quarters: {quarters}, agents: {agents})", { quarters, agents });
  atlasRecord("info", tx("blueprint copied"), `${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId}${inside}`);
  atlasToast(tx("Blueprint taken: {value} {sourceId}{inside}. Ctrl+V — show what will be created.", { value: KIND_NAMES[blueprint.kind], sourceId: blueprint.root.sourceId, inside }));
}

function knownIdentifiers() {
  const world = atlasState.world;
  const projects = new Set();
  const quarters = new Set();
  const agents = new Set();
  if (world !== null && world.status === "ready") {
    for (const project of world.projection.projects) {
      projects.add(project.projectId);
      for (const quarter of project.quarters) {
        quarters.add(quarter.quarterId);
        for (const agent of quarter.agents) agents.add(agent.agentId);
      }
    }
  }
  return { projects, quarters, agents };
}

/**
 * The paste plan for the current world (outcome-core.js buildPastePlan). Nothing
 * runs until the person clicks “Create”; `rootId` - the ID they chose for the
 * new copy, otherwise the suggestion “…-copy”.
 */
const pastePlanFor = (blueprint, rootId = null) => buildPastePlan(blueprint, scenePasteTarget(), knownIdentifiers(), { rootId });

const PASTE_MODE_WORDS = Object.freeze({
  "structure-only": tx("Structure only"),
  "structure-and-memory": tx("Structure and memory"),
});

function atlasPasteBlueprint() {
  const blueprint = atlasState.clipboard;
  if (blueprint === null || blueprint === undefined) {
    atlasToast(tx("No blueprint: select an object and press Ctrl+C."));
    return;
  }
  const body = openSheet(tx("Paste blueprint · {value}", { value: KIND_NAMES[blueprint.kind] }), tx("backend operations"));
  if (blueprint.kind === "agent") {
    // An agent is not copied: a new agent has its own conversation and its own provider
    // session, and the contract forbids carrying them or the binding over.
    body.append(noteBlock("error",
      tx("Agents are not copied: neither the conversation, nor the folder binding, nor the provider session is carried over. ")
      + tx("Create a new agent in the quarter you need (right-click the quarter).")));
    return;
  }
  let plan = pastePlanFor(blueprint);
  if (plan.into === null) {
    body.append(noteBlock("error", tx("Nowhere to paste: point at a project or enter it.")));
    return;
  }

  body.append(infoRow(tx("from"), `${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId}`));
  body.append(infoRow(tx("to"), plan.into));
  const skippedAgents = plan.steps.filter((step) => step.kind === "agent").length;
  if (skippedAgents > 0) {
    body.append(noteBlock("note",
      tx("Agents in the blueprint: {skippedAgents}. They are not copied — they are created anew if needed.", { skippedAgents })));
  }

  // ID of the new copy (U07). The auto suffix is only a suggestion: the person sees it and
  // can replace it before confirming. An empty, invalid, source-equal
  // or taken ID is refused here, before any write; the last
  // guard against a race is the backend.
  const rootWord = blueprint.kind === "project" ? tx("projects") : tx("app::quarters");
  const validate = (value) => validateCopyTarget({
    value, kind: blueprint.kind, sourceId: blueprint.root.sourceId, projectId: plan.projectId, taken: knownIdentifiers(),
  });
  body.append(el("div", "section-title", tx("ID of the new copy (unique among {rootWord})", { rootWord })));
  const field = el("input", "paste-target");
  field.value = plan.suggestedRootId;
  field.maxLength = 160;
  field.spellcheck = false;
  const targetNote = el("div", "paste-target-note muted");
  body.append(field, targetNote);
  let target = validate(field.value);

  // “Structure and memory” (Kit v0.16.1) is one atomic operation that copies a project
  // with its quarters and their memory. A quarter has no such operation: structure only.
  const copyStatus = operationStatus("mutation.memory.project.copy");
  const memoryBlocked = blueprint.kind !== "project"
    ? tx("the contract has no atomic memory copy for a quarter — structure only")
    : copyStatus?.status !== "available"
      ? tx("atomic copy unavailable ({value})", { value: copyStatus ? copyStatus.reasonCode ?? copyStatus.status : tx("not checked") }) : null;
  const quarterIds = blueprint.kind === "project" ? blueprint.root.children.map((part) => part.sourceId) : [];

  // The mode is named explicitly, and none is chosen by default: until the person
  // chooses, there is nothing to create.
  let mode = null;
  const modes = el("div", "paste-modes");
  const list = el("div");
  const summary = el("div", "paste-summary");
  const run = el("button", "small primary", tx("Create with confirmation"));
  const paintTarget = () => {
    targetNote.textContent = target.ok
      ? (target.id === plan.suggestedRootId
        ? tx("Suggestion: {suggestedRootId}. You can replace it before confirming.", { suggestedRootId: plan.suggestedRootId })
        : tx("Free: the copy {id} will be created.", { id: target.id }))
      : target.text;
    targetNote.classList.toggle("error-text", !target.ok);
  };
  const paintSummary = () => {
    summary.textContent = tx("Source: {value} {sourceId} → new copy: ", { value: KIND_NAMES[blueprint.kind], sourceId: blueprint.root.sourceId })
      + tx("{value} · mode: {value2}", { value: target.ok ? target.id : tx("app::not set"), value2: mode === null ? tx("not chosen") : PASTE_MODE_WORDS[mode] });
  };
  const drawSteps = () => {
    list.replaceChildren();
    if (!target.ok) {
      list.append(el("div", "empty", tx("Enter a valid ID for the new copy.")));
      return;
    }
    if (mode === "structure-and-memory") {
      list.append(el("div", "entry-text",
        tx("project {id}: the project, quarters {value} and their memory — in one operation, all or nothing", { id: target.id, value: quarterIds.join(", ") || "—" })));
      return;
    }
    const steps = pasteSteps(plan.steps, { mode });
    if (steps === null) {
      list.append(el("div", "empty", tx("Choose what to copy.")));
      return;
    }
    for (const step of steps) list.append(el("div", "entry-text", tx("{label} — pending", { label: step.label })));
  };
  body.append(el("div", "section-title", tx("What to copy")));
  for (const [value, label] of Object.entries(PASTE_MODE_WORDS)) {
    const option = el("label", "paste-mode");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "pasteMode";
    if (value === "structure-and-memory" && memoryBlocked !== null) {
      radio.disabled = true;
      option.title = memoryBlocked;
    }
    radio.addEventListener("change", () => {
      mode = value;
      target = validate(field.value);
      drawSteps();
      paintSummary();
      paintRun();
    });
    option.append(radio, el("span", null, label));
    modes.append(option);
  }
  body.append(modes);
  if (memoryBlocked !== null) body.append(el("div", "muted", tx("“Structure and memory”: {memoryBlocked}.", { memoryBlocked })));
  body.append(summary);
  body.append(el("div", "section-title", tx("Steps")));
  body.append(list);

  const result = el("div");
  const actions = el("div", "actions");
  const scopeStatus = operationStatus("mutation.memory.scope.create");
  const structureBlocked = scopeStatus?.status !== "available"
    ? tx("scope creation unavailable ({value})", { value: scopeStatus ? scopeStatus.reasonCode : tx("not checked") }) : null;
  const paintRun = () => {
    const blocked = !target.ok ? target.text
      : mode === null ? tx("First choose what to copy")
        : mode === "structure-and-memory" ? memoryBlocked : structureBlocked;
    run.disabled = blocked !== null;
    run.title = blocked ?? "";
  };
  field.addEventListener("input", () => {
    target = validate(field.value);
    if (target.ok) plan = pastePlanFor(blueprint, target.id);
    paintTarget();
    drawSteps();
    paintSummary();
    paintRun();
  });
  paintTarget();
  drawSteps();
  paintSummary();
  paintRun();
  if (structureBlocked !== null) body.append(noteBlock("error", tx("Structure only: {structureBlocked}.", { structureBlocked })));
  run.addEventListener("click", async () => {
    if (run.disabled || mode === null) return;
    // The world may have changed after the input: the target is checked again on fresh data.
    const fresh = validate(field.value);
    if (!fresh.ok) {
      target = fresh;
      paintTarget();
      drawSteps();
      paintSummary();
      paintRun();
      return;
    }
    run.disabled = true;
    field.disabled = true;
    for (const radio of modes.querySelectorAll("input")) radio.disabled = true;
    plan = pastePlanFor(blueprint, fresh.id);
    atlasRecord("info", tx("paste: target chosen"),
      `${KIND_NAMES[blueprint.kind]} ${blueprint.root.sourceId} → ${fresh.id} (${PASTE_MODE_WORDS[mode]})`);
    if (mode === "structure-and-memory") await runAtomicCopy(blueprint, fresh.id, list, result);
    else await runPastePlan({ ...plan, steps: pasteSteps(plan.steps, { mode }), mode }, list, result);
  });
  actions.append(run);
  body.append(actions, result);
  body.append(noteBlock("note",
    tx("“Structure only” creates projects and quarters step by step, with empty memory; a refusal at a step keeps ")
    + tx("what was created and is visible per step. “Structure and memory” copies the project, all its quarters and their memory in one ")
    + tx("atomic operation: on refusal nothing is created. Agents, conversations, the folder binding and the provider ")
    + tx("session are never copied; existing objects are not renamed; nothing is deleted ")
    + tx("by itself or retried blindly.")));
}

/**
 * An atomic copy of a project with memory (mutation.memory.project.copy) into the exactly
 * chosen ID. A complete outcome gives a receipt for each memory; a refusal means “nothing
 * was created”; an unknown outcome is reconciled only by the same request with the same
 * identifier.
 */
async function runAtomicCopy(blueprint, targetProjectId, list, result) {
  list.replaceChildren(el("div", "entry-text", tx("project copy {targetProjectId} — running…", { targetProjectId })));
  const show = async (response) => {
    const described = describeCopyOutcome(response);
    list.replaceChildren(el("div", "entry-text", tx("project copy {targetProjectId} — {outcome}", { targetProjectId,
      outcome: described.outcome === "complete" ? tx("done") : described.outcome === "uncertain" ? tx("outcome unknown") : tx("not done") })));
    result.replaceChildren(outcomeBlock({ tone: described.outcome === "complete" ? "note" : "error",
      title: described.title, details: described.details }));
    atlasRecord(described.outcome === "complete" ? "ok" : "bad", tx("project copy with memory"),
      `${blueprint.root.sourceId} → ${targetProjectId}: ${described.title}`);
    if (described.reconcile && response.identity?.operationId) {
      const again = el("button", "small", tx("Reconcile with the same request"));
      again.addEventListener("click", async () => {
        again.disabled = true;
        await show(await window.atlas.reconcileProjectCopy({ operationId: response.identity.operationId }));
      });
      result.append(again);
    }
    if (response.ok) {
      // Quarters in the copy keep their identifiers; only the placement
      // and your annotations of the project and quarters are carried over.
      const copied = new Set(response.data.quarterIds ?? []);
      const created = [{ node: { kind: "project", projectId: targetProjectId, quarterId: null, agentId: null }, part: blueprint.root }];
      for (const part of blueprint.root.children) {
        if (copied.has(part.sourceId)) {
          created.push({ node: { kind: "quarter", projectId: targetProjectId, quarterId: part.sourceId, agentId: null }, part });
        }
      }
      await finishPaste(created);
    } else if (!described.reconcile) {
      await refresh();
    }
  };
  await show(await window.atlas.copyProject({ sourceProjectId: blueprint.root.sourceId, targetProjectId }));
}

/** One receipt line of a step: what came out and with which identifiers. */
function receiptLine(step, verdict, response) {
  const identity = response?.ok ? response.data?.identity : response?.identity;
  const parts = [`${step.label}: ${verdict.state}`];
  if (identity?.operationId) parts.push(tx("operation {operationId}", { operationId: identity.operationId }));
  if (identity?.commandId) parts.push(tx("command {commandId}", { commandId: identity.commandId }));
  const revision = response?.ok ? response.data?.response?.revision : null;
  if (revision !== null && revision !== undefined) parts.push(tx("revision {revision}", { revision }));
  return parts.join(" · ");
}

/**
 * Carrying over one memory: the pinned content of the source is written to the new
 * memory over its current revision, as a trusted action with confirmation.
 * An empty memory is not carried over.
 */
async function copyMemoryStep(step, createdScopes, pinned) {
  const target = createdScopes.get(step.forStepId);
  if (target === undefined) return { ok: false, error: { code: "target_missing" } };
  const source = pinned.get(step.sourceScopeId);
  if (source === undefined) return { ok: false, error: { code: "source_not_pinned" } };
  if (source.entries.length === 0) return { ok: true, empty: true };
  const fresh = await window.atlas.readScope({ scopeId: target });
  if (!fresh.ok || fresh.result.outcome !== "succeeded") {
    return { ok: false, error: { code: "target_unreadable", reasonCode: fresh.ok ? fresh.result.error?.code : fresh.error?.code } };
  }
  return window.atlas.saveMemory({ scopeId: target, expectedRevision: fresh.result.output.revision, entries: source.entries });
}

async function runPastePlan(plan, list, result) {
  list.replaceChildren();
  const created = [];
  const createdScopes = new Map();
  const receipts = [];
  const lines = plan.steps.map((step) => {
    const line = el("div", "entry-text", tx("{label} — pending", { label: step.label }));
    list.append(line);
    return line;
  });
  const showReceipts = (tone, title, summary) => {
    result.replaceChildren(noteBlock(tone, title));
    if (summary) result.append(outcomeBlock({ tone: summary.outcome === "complete" ? "note" : "error",
      title: summary.title, details: summary.details }));
    const box = el("div", "paste-receipts");
    box.append(el("div", "section-title", tx("Receipts · mode “{value}”", { value: PASTE_MODE_WORDS[plan.mode] })));
    for (const line of receipts) box.append(el("div", "entry-text", line));
    result.append(box);
  };

  // The sources are read and pinned before the first write: exactly the content
  // whose revision is named here is carried over, even if the source changes later.
  let pinned = new Map();
  if (plan.mode === "structure-and-memory") {
    const reads = new Map();
    for (const step of plan.steps.filter((item) => item.kind === "memory")) {
      const response = await window.atlas.readScope({ scopeId: step.sourceScopeId });
      reads.set(step.sourceScopeId, response.ok && response.result.outcome === "succeeded"
        ? { ok: true, revision: response.result.output.revision,
          entries: (response.result.output.entries ?? []).map(({ id, title, text }) => ({ id, title, text })) }
        : { ok: false, code: response.ok ? (response.result.error?.code ?? response.result.outcome) : response.error?.code });
    }
    const pin = pinSources(plan.steps, reads);
    if (!pin.ok) {
      const named = pin.problems.map((problem) => `${problem.scopeId} (${problem.code})`).join(", ");
      result.replaceChildren(noteBlock("error", tx("Sources not read: {named}. Nothing was created or written.", { named })));
      atlasRecord("bad", tx("paste not started"), named);
      return;
    }
    pinned = pin.pinned;
    for (const [scopeId, source] of pinned) {
      receipts.push(tx("source {scopeId}: revision {revision} pinned, entries {length}", { scopeId, revision: source.revision, length: source.entries.length }));
    }
  }

  for (const [index, step] of plan.steps.entries()) {
    const line = lines[index];
    line.textContent = tx("{label} — {value}", { label: step.label, value: step.kind === "memory" ? tx("copying…") : tx("creating…") });
    let response;
    if (step.kind === "memory") {
      response = await copyMemoryStep(step, createdScopes, pinned);
    } else if (step.kind === "project") {
      response = await window.atlas.createScope({ kind: "project", projectId: step.id, title: step.part.sourceId });
    } else {
      response = await window.atlas.createScope({
        kind: "quarter", projectId: step.projectId, quarterId: step.id, title: step.part.sourceId,
      });
    }
    const verdict = pasteStepVerdict(step, response);
    line.textContent = `${step.label} — ${verdict.state}`;
    receipts.push(receiptLine(step, verdict, response));
    atlasRecord(verdict.proceed ? "ok" : "bad", tx("paste"), receiptLine(step, verdict, response));
    if (!verdict.proceed) {
      const why = step.kind === "memory" && (response.error?.code?.startsWith("cli_") || response.error?.code === "user_declined")
        ? describeSaveFailure(response.error, response.identity ?? null).title
        : outcomeMessage(response, tx("Paste: {label}.", { label: step.label })).text;
      const stoppedAt = index;
      const done = plan.steps.slice(0, stoppedAt).length;
      const uncertain = response?.error?.code === "uncertain_outcome" || response?.error?.uncertain === true;
      showReceipts("error", tx("{why} The remaining steps were not run.", { why }),
        pasteSummary(plan.steps, { done, stoppedAt, uncertain }));
      await finishPaste(created);
      return;
    }
    if (step.kind !== "memory") {
      createdScopes.set(step.id, response.data.output?.scopeId ?? response.data.identity?.scopeId);
      created.push(step);
    }
  }
  showReceipts("note", tx("Objects created: {length}. Placement and annotations carried over.", { length: created.length }),
    pasteSummary(plan.steps, { done: plan.steps.length, stoppedAt: null, uncertain: false }));
  await finishPaste(created);
}

async function finishPaste(created) {
  await refresh();
  for (const step of created) sceneApplyBlueprintPart(step.node, step.part);
  requestRender();
}

// --- sheet with forms -------------------------------------------------------------

function openSheet(title, kind) {
  // The inspector, the attention list, readiness and the sheet share one place on the right:
  // only one of them is open, otherwise one covers another with no way to see it.
  $("inspector").classList.add("hidden");
  if (atlasState.ui.attentionOpen) setPanel("attentionOpen", false);
  closeReadiness();
  // Whose sheet this is: the World HQ marks itself so that a task board that finishes reading
  // repaints it, not a sheet opened after it.
  atlasState.sheetOwner = null;
  $("sheetTitle").textContent = title;
  $("sheetKind").textContent = kind;
  $("sheet").classList.remove("hidden");
  const body = $("sheetBody");
  body.replaceChildren();
  return body;
}

const closeSheet = () => $("sheet").classList.add("hidden");

/** An outcome block from outcome-core: a title and detail lines. */
function outcomeBlock(described) {
  const block = noteBlock(described.tone === "note" ? "note" : "error", described.title);
  for (const line of described.details) block.append(el("div", "outcome-line", line));
  return block;
}

/**
 * The memory sheet. notice - the outcome of the previous attempt, shown above the fresh read;
 * draft - an unsent edit that the person merges by hand after a conflict or
 * an unknown outcome: it is not written, only shown alongside.
 */
async function openMemorySheet(scopeId, title, { notice = null, draft = null } = {}) {
  const body = openSheet(title, tx("memory"));
  body.append(el("div", "empty", tx("app::Reading…")));
  const response = await window.atlas.readScope({ scopeId });
  body.replaceChildren();
  if (notice !== null) body.append(outcomeBlock(notice));
  let dirty = false;
  let disarm = () => {};
  const touched = () => {
    dirty = true;
    disarm();
  };
  if (!response.ok || response.result.outcome !== "succeeded") {
    const failure = response.ok ? response.result.error : response.error;
    body.append(noteBlock("error", tx("Memory not read: {value}", { value: failure ? failure.code : tx("app::unknown") })));
    return;
  }
  const output = response.result.output;
  const entries = (output.entries ?? []).map((entry) => ({
    id: entry.id, title: entry.title, text: entry.text,
  }));
  body.append(infoRow(tx("revision"), output.revision));
  if (draft !== null) {
    const kept = noteBlock("local", tx("Your earlier edit - not written, for comparison:"));
    for (const entry of draft) kept.append(el("div", "outcome-line", tx("{value}: {text}", { value: entry.title || tx("(untitled)"), text: entry.text })));
    body.append(kept);
  }

  const list = el("div");
  const draw = () => {
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const box = el("div", "entry");
      const heading = el("input");
      heading.value = entry.title;
      heading.maxLength = 512;
      heading.placeholder = tx("Title");
      heading.addEventListener("input", () => { entry.title = heading.value; touched(); });
      const text = el("textarea");
      text.rows = 4;
      text.value = entry.text;
      text.placeholder = tx("Text");
      text.addEventListener("input", () => { entry.text = text.value; touched(); });
      const remove = el("button", "small", tx("Delete entry"));
      remove.addEventListener("click", () => {
        entries.splice(index, 1);
        touched();
        draw();
      });
      box.append(heading, text, remove);
      list.append(box);
    });
    if (entries.length === 0) list.append(el("div", "empty", tx("Empty. An empty memory is allowed.")));
  };
  draw();
  body.append(list);

  const result = el("div");
  const actions = el("div", "actions");
  const add = el("button", "small", tx("Add entry"));
  add.addEventListener("click", () => {
    if (entries.length >= 64) return;
    entries.push({ id: `entry-${window.crypto.randomUUID()}`, title: "", text: "" });
    touched();
    draw();
  });
  // Leaving without saving. Memory edits live only in this sheet until they are
  // confirmed, so closing writes nothing — but it also does not silently close what
  // the person has already typed.
  const discard = el("button", "small", tx("Close without saving"));
  let armed = false;
  disarm = () => {
    if (!armed) return;
    armed = false;
    discard.textContent = tx("Close without saving");
    discard.classList.remove("danger");
  };
  discard.addEventListener("click", () => {
    if (!dirty || armed) {
      atlasRecord("info", tx("memory closed without saving"), tx("{scopeId}{value}", { scopeId, value: dirty ? tx(" — edits discarded") : "" }));
      closeSheet();
      return;
    }
    armed = true;
    discard.textContent = tx("Close anyway? The edits will be lost");
    discard.classList.add("danger");
    result.replaceChildren(noteBlock("note",
      tx("Your edits to this memory are not saved. Click again to discard them, ")
      + tx("or “Save with confirmation” to write them.")));
  });
  const save = trustedButton(tx("Save with confirmation"), async () => {
    // An entry that cannot be sent is named before the write - with its number and
    // the reason; the host checks the same thing again.
    const problems = entryProblems(entries);
    if (problems.length > 0) {
      result.replaceChildren(outcomeBlock({
        tone: "error", title: tx("Not sent: fix the entries."), details: problems.map(describeProblem),
      }));
      return;
    }
    save.disabled = true;
    const saved = await window.atlas.saveMemory({ scopeId, expectedRevision: output.revision, entries });
    if (saved.ok) {
      const receipt = saved.data.response ?? {};
      dirty = false;
      disarm();
      atlasRecord("ok", tx("memory saved"),
        tx("{scopeId} rev. {value} · {value2}", { scopeId, value: receipt.revision ?? "?", value2: saved.data.identity?.operationId ?? "?" }));
      await refresh();
      // The sheet reopens from a fresh read: otherwise the next edit would go out
      // with the old revision and run into a conflict.
      await openMemorySheet(scopeId, title, { notice: describeSaveSuccess(saved.data) });
      return;
    }
    const described = describeSaveFailure(saved.error, saved.identity ?? null);
    atlasRecord(described.tone === "note" ? "info" : "bad", tx("memory not saved"),
      `${scopeId}: ${saved.error.code} ${saved.error.reasonCode ?? ""}`.trim());
    result.replaceChildren(outcomeBlock(described));
    if (described.tone === "conflict" || described.tone === "uncertain") {
      const reread = el("button", "small", tx("Reread"));
      const pending = entries.map((entry) => ({ ...entry }));
      reread.addEventListener("click", () => openMemorySheet(scopeId, title, { notice: described, draft: pending }));
      result.append(reread);
    }
    save.disabled = !described.mayRetry;
  }, { primary: true });
  actions.append(add, save, discard);
  body.append(actions, result);
  body.append(noteBlock("note",
    tx("Saving opens an operating system confirmation: your answer there is the permission to write. ")
    + tx("Until you save, the edits live only in this window — closing it discards them.")));
}

// --- leads -------------------------------------------------------------------------
//
// A project and a quarter can each have a lead agent: you talk to it about the
// project or the quarter as a whole. The project lead lives in the HQ's service quarter
// (HEADQUARTERS_QUARTER, scene.js), which is not on the map — the HQ building
// stands in for it. “Enter project” and “Enter quarter” open its chat.

/** The lead of the project (quarterId === null) or of the quarter; null if there is none. */
function leadOf(projectId, quarterId = null) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  const project = world.projection.projects.find((item) => item.projectId === projectId) ?? null;
  const role = quarterId === null ? "project-lead" : "quarter-lead";
  for (const quarter of project?.quarters ?? []) {
    if (quarterId !== null && quarter.quarterId !== quarterId) continue;
    const found = quarter.agents.find((agent) => agent.settings?.role === role && agent.state !== "archived");
    if (found) return found;
  }
  return null;
}

const leadNode = (agent) => ({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId });

// Entering a project or a quarter opens the chat of its lead where the camera is:
// zooming in on a double-click is only for agents.
function atlasEnterProject(projectId) {
  const lead = leadOf(projectId);
  if (lead !== null) atlasOpenWorkspace(leadNode(lead), { camera: false });
  else atlasOpenHeadquarters(projectId);
}

function atlasEnterQuarter(projectId, quarterId) {
  const lead = leadOf(projectId, quarterId);
  if (lead !== null) atlasOpenWorkspace(leadNode(lead), { camera: false });
  else atlasOpenQuarterSheet(projectId, quarterId);
}

/**
 * The project lead is created in the HQ's service quarter: if the quarter does not
 * exist yet, it is created automatically (without confirmation, like any quarter).
 */
async function atlasCreateProjectLead(projectId) {
  const { project } = findNode({ kind: "project", projectId, quarterId: null, agentId: null });
  if (project === null) return;
  if (!project.quarters.some((quarter) => quarter.quarterId === HEADQUARTERS_QUARTER)) {
    const response = await window.atlas.createScope({ kind: "quarter", projectId, quarterId: HEADQUARTERS_QUARTER,
      title: tx("app::HQ") });
    if (!response.ok) {
      atlasRecord("bad", tx("HQ quarter not created"), response.error?.reasonCode || response.error?.code || "");
      const body = openSheet(tx("Project lead · {projectId}", { projectId }), tx("backend operation"));
      body.append(noteBlock("error", tx("The HQ service quarter was not created: {value}.", { value: response.error?.code ?? tx("error") })));
      return;
    }
    await refresh();
  }
  openCreateAgentSheet(projectId, HEADQUARTERS_QUARTER, { role: "project-lead" });
}

/** The lead row in the HQ or quarter window: who it is and a button to its chat — or to creating one. */
function leadSection(body, projectId, quarterId) {
  const lead = leadOf(projectId, quarterId);
  const words = LEAD_WORDS[quarterId === null ? "project-lead" : "quarter-lead"];
  body.append(el("div", "section-title", words.title));
  const actions = el("div", "actions");
  if (lead !== null) {
    body.append(infoRow(tx("agent"), lead.agentId));
    body.append(infoRow(tx("model"), lead.lastOperation?.observedModel ?? lead.profile?.model ?? tx("app3::not reported")));
    body.append(infoRow(tx("state"), lead.currentOperationId ? tx("working") : lead.state));
    const open = el("button", "small primary", tx("Open chat"));
    open.addEventListener("click", () => {
      closeSheet();
      atlasOpenWorkspace(leadNode(lead), { camera: false });
    });
    actions.append(open);
  } else {
    body.append(el("div", "muted", words.hint));
    actions.append(actionButton(tx("Create {value} lead…", { value: quarterId === null ? tx("app::project") : tx("app::quarter") }),
      "mutation.memory.agent.create", () => (quarterId === null ? atlasCreateProjectLead(projectId)
        : openCreateAgentSheet(projectId, quarterId, { role: "quarter-lead" }))));
  }
  body.append(actions);
}

/** The quarter window: its lead, memory and agents. “Enter quarter” opens it when there is no lead. */
function atlasOpenQuarterSheet(projectId, quarterId) {
  const { quarter } = findNode({ kind: "quarter", projectId, quarterId, agentId: null });
  if (quarter === null) return;
  const body = openSheet(tx("Quarter · {quarterId}", { quarterId }), projectId);
  leadSection(body, projectId, quarterId);
  body.append(el("div", "section-title", tx("Quarter")));
  body.append(infoRow(tx("quarter memory"), quarter.memory.scopeId));
  const actions = el("div", "actions");
  actions.append(actionButton(tx("Open memory"), "query.memory.scope.read",
    () => openMemorySheet(quarter.memory.scopeId, tx("Quarter memory · {quarterId}", { quarterId }))));
  actions.append(actionButton(tx("Create agent…"), "mutation.memory.agent.create",
    () => openCreateAgentSheet(projectId, quarterId)));
  body.append(actions);
  body.append(el("div", "section-title", tx("Agents · {length}", { length: quarter.agents.length })));
  if (quarter.agents.length === 0) body.append(el("div", "empty", tx("The quarter has no agents yet.")));
  for (const agent of quarter.agents) {
    const row = el("div", "entry");
    row.append(el("div", "entry-title", agent.agentId));
    row.append(el("div", "entry-text", [agent.settings?.role === "quarter-lead" ? tx("lead") : null,
      agent.profile?.model ?? null, agent.currentOperationId ? tx("working") : agent.state].filter(Boolean).join(" · ")));
    const open = el("button", "small", tx("Chat"));
    open.addEventListener("click", () => {
      closeSheet();
      atlasOpenWorkspace({ kind: "agent", projectId, quarterId, agentId: agent.agentId });
    });
    row.append(open);
    body.append(row);
  }
}

function atlasOpenHeadquarters(projectId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return;
  const project = world.projection.projects.find((item) => item.projectId === projectId) ?? null;
  if (project === null) return;
  const body = openSheet(tx("HQ · {projectId}", { projectId }), tx("goal, team, decisions"));
  leadSection(body, projectId, null);

  body.append(el("div", "section-title", tx("Goal")));
  body.append(infoRow(tx("project memory"), project.memory.scopeId));
  body.append(infoRow(tx("revision"), project.memory.revision));
  projectFolderSection(body, projectId);
  const goal = el("div", "actions");
  goal.append(actionButton(tx("Open memory"), "query.memory.scope.read",
    () => openMemorySheet(project.memory.scopeId, tx("Project memory · {projectId}", { projectId }))));
  goal.append(actionButton(tx("Create quarter…"), "mutation.memory.scope.create",
    () => openCreateScopeSheet("quarter", projectId)));
  goal.append(trustedButton(tx("Archive project…"), () => atlasArchiveProject(projectId)));
  // A project can be disconnected only in a split instance (each project has its own store).
  if (atlasState.away.split === true && projectId !== WORLD_PROJECT) {
    goal.append(trustedButton(tx("Disconnect from this PC…"), () => atlasUnmountProject(projectId)));
  }
  body.append(goal);
  projectPlaceSection(body, projectId);

  body.append(el("div", "section-title", tx("Team")));
  const mapQuarters = project.quarters.filter((quarter) => quarter.quarterId !== HEADQUARTERS_QUARTER);
  body.append(infoRow(tx("quarters"), mapQuarters.length));
  body.append(infoRow(tx("agents"), project.quarters.reduce((sum, item) => sum + item.agents.length, 0)));
  for (const quarter of mapQuarters) {
    const lead = leadOf(projectId, quarter.quarterId);
    body.append(infoRow(quarter.quarterId, tx("agents: {length}{value}", { length: quarter.agents.length, value: lead ? tx(" · lead {agentId}", { agentId: lead.agentId }) : "" })));
  }

  body.append(el("div", "section-title", tx("Decisions")));
  const pending = (world.attention ?? []).filter((item) => item.projectId === projectId);
  if (pending.length === 0) body.append(el("div", "empty", tx("No decisions are waiting for a person.")));
  for (const item of pending) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title", item.agentId));
    box.append(el("div", "entry-text", attentionLine(item)));
    const go = el("button", "small", tx("Go to agent"));
    go.addEventListener("click", () => selectNode({
      kind: "agent", projectId: item.projectId, quarterId: item.quarterId, agentId: item.agentId,
    }, { focus: true }));
    box.append(go);
    body.append(box);
  }
  body.append(noteBlock("note",
    tx("The HQ is the way into the goal, team and decisions of the project, and into a conversation with its lead.")));
}

// --- world lead and desk agents -------------------------------------------------------
//
// One controller - one world. World lead - the only coordinator
// of the controller (the coordinator role in the backend): it sees all projects and gives tasks
// to project leads and desk agents under the task contract (task package → plan →
// progress → report → acceptance by code). It lives in the service world project
// (WORLD_PROJECT, bound to the controller folder), in the HQ quarter; on the map it
// is replaced by the World HQ building. Its chat, like the chat of any lead, opens
// where the camera is. A desk agent is an agent recorded as a task source of the
// controller; the backend has no way to undo this entry, so it is permanent.

/** World lead: an open agent with the coordinator role, wherever it lives; null - there is none. */
function worldLeadOf() {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  for (const project of world.projection.projects) {
    for (const quarter of project.quarters) {
      const found = quarter.agents.find((agent) => agent.settings?.role === "coordinator" && agent.state !== "archived");
      if (found) return found;
    }
  }
  return null;
}

/** Open agents of the World HQ without the lead role: this happens if the role was not assigned. */
function worldHeadquartersAgents() {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return [];
  const project = world.projection.projects.find((item) => item.projectId === WORLD_PROJECT) ?? null;
  return (project?.quarters ?? []).filter((quarter) => quarter.quarterId === HEADQUARTERS_QUARTER)
    .flatMap((quarter) => quarter.agents)
    .filter((agent) => agent.state !== "archived" && agent.settings?.role !== "coordinator");
}

/** Entering the world (double-click on the World HQ): the world lead chat where the camera is, or the HQ sheet. */
function atlasEnterWorld() {
  const lead = worldLeadOf();
  if (lead !== null) atlasOpenWorkspace(leadNode(lead), { camera: false });
  else atlasOpenWorldHeadquarters();
}

const WORLD_LEAD_HINT = tx("World lead — one coordinator over all projects. It sees every project, its ")
  + tx("lead and agents, and gives tasks to project leads and desk agents under the task contract: task package → ")
  + tx("plan → progress → report → acceptance by code. It does not do the agents' work itself and changes files only in ")
  + tx("coordination/drafts/. It works in the controller folder: the world project “world” is bound to it.");

// Task board: which agents take controller tasks and where each task is.
// Read by the trusted host (memory CLI read-task-board) - no more than once per
// TASK_BOARD_TTL_MS; on the “Refresh tasks” button and after a registration - at once.
const TASK_BOARD_TTL_MS = 30_000;
let taskBoardLoading = null;

const BOARD_FAILURE_WORDS = Object.freeze({
  task_board_not_supported: tx("in this mode the controller has no tasks for desk agents"),
  cli_missing: tx("controller's Gateway CLI not found"),
  cli_not_a_file: tx("controller's Gateway CLI not found"),
  timeout: tx("controller did not answer in time"),
  spawn_failed: tx("controller's Gateway CLI did not start"),
  unsupported_command: tx("the installed controller Gateway CLI has no task board yet — it needs a controller patch that adds it"),
});

/** Why the board was not read - in words. */
function boardFailureText(error) {
  const reason = error?.reasonCode || error?.code || null;
  return BOARD_FAILURE_WORDS[reason] ?? tx("controller did not answer ({value})", { value: reason ?? tx("no code") });
}

/** Task board: from the cache if it is fresh, otherwise read again. Never returns null. */
async function loadTaskBoard({ force = false } = {}) {
  const board = atlasState.taskBoard ?? null;
  if (!force && board !== null && Date.now() - board.readAt < TASK_BOARD_TTL_MS) return board;
  if (taskBoardLoading !== null) return taskBoardLoading;
  if (typeof window.atlas?.taskBoard !== "function" || atlasState.trusted?.available !== true) {
    atlasState.taskBoard = { failed: true, reason: tx("trusted actions unavailable"), readAt: Date.now() };
    return atlasState.taskBoard;
  }
  taskBoardLoading = window.atlas.taskBoard({}).then((response) => {
    atlasState.taskBoard = response.ok ? { ...response.data, failed: false, readAt: Date.now() }
      : { failed: true, reason: boardFailureText(response.error), readAt: Date.now() };
    return atlasState.taskBoard;
  }).finally(() => { taskBoardLoading = null; });
  return taskBoardLoading;
}

/** The board in the shape that deskRegistrationState (outcome-core.js) understands. */
const boardForState = () => {
  const board = atlasState.taskBoard ?? null;
  return board === null ? null : board.failed ? { failed: true, reason: board.reason } : board;
};

/** One task: the contract steps, where it is now, and the way to the agent. */
function taskEntry(task, { showAgent = true } = {}) {
  const box = el("div", "entry task-entry");
  const title = el("div", "entry-title");
  title.append(el("span", null, task.title ?? task.taskId), el("span", "task-id", task.taskId));
  box.append(title);
  const steps = el("div", "task-steps");
  for (const step of taskStageSteps(task)) steps.append(el("span", `task-step ${step.state}`, step.label));
  box.append(steps);
  box.append(el("div", "entry-text", taskStateLine(task)));
  const facts = [showAgent ? tx("agent {agentId}", { agentId: task.agentId }) : null,
    task.dispatchedAtUtc ? tx("dispatched {value}", { value: task.dispatchedAtUtc.slice(0, 16).replace("T", " ") }) : null,
    task.start?.coordinatorAgentId ? tx("started by {coordinatorAgentId}", { coordinatorAgentId: task.start.coordinatorAgentId }) : null,
    task.start?.reportOperation ? tx("on report: {reportOperation}", { reportOperation: task.start.reportOperation }) : null].filter(Boolean);
  if (facts.length > 0) box.append(el("div", "muted", facts.join(" · ")));
  if (!task.verified) {
    box.append(noteBlock("error", tx("The agent's task package does not match what the controller dispatched: ")
      + tx("this needs to be sorted out before the task can be trusted.")));
  }
  if (showAgent) {
    const found = agentNamed(task.agentId);
    const actions = el("div", "actions");
    const open = el("button", "small", tx("Agent chat"));
    open.disabled = found === null;
    if (found === null) open.title = tx("Agent not in the catalog");
    open.addEventListener("click", () => {
      closeSheet();
      const role = found.settings?.role ?? null;
      const lead = role === "project-lead" || role === "quarter-lead" || role === "coordinator";
      atlasOpenWorkspace(leadNode(found), lead ? { camera: false } : undefined);
    });
    actions.append(open);
    box.append(actions);
  }
  return box;
}

/**
 * The board's task list in a container: all tasks (for the world lead) or those of one
 * agent. Rereads the board by TTL and on the button; while reading, it says so.
 */
function taskBoardList(container, { agentId = null, showAgent = true, empty }) {
  const list = el("div");
  const paint = () => {
    const board = atlasState.taskBoard ?? null;
    list.replaceChildren();
    if (board === null) {
      list.append(el("div", "muted", tx("Reading tasks…")));
      return;
    }
    if (board.failed) {
      list.append(noteBlock("error", tx("Tasks not read: {reason}.", { reason: board.reason })));
      return;
    }
    const tasks = board.tasks.filter((task) => agentId === null || task.agentId === agentId);
    if (tasks.length === 0) list.append(el("div", "empty", empty));
    for (const task of tasks) list.append(taskEntry(task, { showAgent }));
    if (board.truncated) list.append(noteBlock("note", tx("Not all tasks are shown: the controller returned only the latest ones.")));
  };
  const actions = el("div", "actions");
  const reread = el("button", "small", tx("Refresh tasks"));
  reread.addEventListener("click", async () => {
    reread.disabled = true;
    await loadTaskBoard({ force: true });
    reread.disabled = false;
    paint();
  });
  actions.append(reread);
  container.append(actions, list);
  paint();
  loadTaskBoard().then(paint);
  return paint;
}

/**
 * Whether the agent takes controller tasks is a permanent state, in plain view; and
 * “Take tasks (desk agent)…” while it applies.
 */
function deskAgentSection(body, agent) {
  body.append(el("div", "section-title", tx("Controller tasks")));
  const box = el("div");
  body.append(box);
  const paint = () => {
    const state = deskRegistrationState(agent, boardForState());
    box.replaceChildren(infoRow(tx("takes tasks"), state.text));
    if (state.kind === "registered" || state.kind === "invalid") {
      box.append(noteBlock("note", tx("The registration is permanent: Atlas cannot remove it — the backend has no way to cancel a ")
        + tx("registration. The world lead gives the agent its tasks.")));
    }
    if (state.offer) {
      const actions = el("div", "actions");
      actions.append(trustedButton(tx("Take tasks (desk agent)…"), () => openDeskAgentSheet(agent)));
      box.append(actions);
    }
  };
  paint();
  loadTaskBoard().then(paint);
}

/** The “agent takes tasks” sheet: what it means, its current state and the confirmed action. */
function openDeskAgentSheet(agent) {
  const body = openSheet(tx("Desk agent · {agentId}", { agentId: agent.agentId }), tx("trusted action"));
  body.append(infoRow(tx("agent"), `${agent.agentId} · ${agent.projectId} / ${agent.quarterId}`));
  const state = el("div");
  body.append(state);
  body.append(noteBlock("note", tx("A desk agent takes controller tasks: the world lead dispatches to it an immutable ")
    + tx("task package, the agent publishes a plan and waits for your confirmation in its chat, works in its zone, ")
    + tx("reports progress and hands in a report, and the controller accepts it by code. The controller creates a coordination ")
    + tx("folder with a task set for the agent and records the agent as a task source. This entry cannot be removed from Atlas: ")
    + tx("the backend has no way to cancel a registration.")));
  const result = el("div");
  const actions = el("div", "actions");
  body.append(actions, result);
  const paint = () => {
    const current = deskRegistrationState(agent, boardForState());
    state.replaceChildren(infoRow(tx("takes tasks"), current.text));
    actions.replaceChildren();
    if (!current.offer) return;
    actions.append(trustedButton(tx("Take tasks — with confirmation"), async () => {
      result.replaceChildren(el("div", "muted", tx("Registering: the controller is setting up a task set for the agent…")));
      const response = await window.atlas.registerDeskAgent({ agentId: agent.agentId });
      const described = describeDeskRegistration(response);
      if (response.ok) atlasRecord("ok", tx("desk agent"), tx("{agentId} · {value}", { agentId: agent.agentId, value: response.data.sourceId ?? tx("source not reported") }));
      else if (response.error?.code !== "user_declined") {
        atlasRecord("bad", tx("desk agent not registered"), `${agent.agentId} · ${described.text}`);
      }
      result.replaceChildren(noteBlock(described.tone === "note" ? "note" : "error", described.text));
      await loadTaskBoard({ force: true });
      paint();
    }, { primary: true }));
  };
  paint();
  loadTaskBoard().then(paint);
}

/** The lead's state line: what it is doing, according to the catalog. */
function leadStateWords(agent) {
  if (agent.currentOperationId) return tx("working");
  const activity = agent.activity?.state ?? null;
  return activity === "waiting-for-person" ? tx("waiting for you") : activity === "idle" ? tx("idle") : agent.state;
}

/** The World HQ sheet: the world lead, the tasks it dispatched, and the desk agents. */
function atlasOpenWorldHeadquarters() {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return;
  const body = openSheet(tx("World HQ"), tx("world lead · tasks · desk agents"));
  atlasState.sheetOwner = "world";
  const lead = worldLeadOf();
  body.append(el("div", "section-title", tx("World lead")));
  const actions = el("div", "actions");
  if (lead !== null) {
    body.append(infoRow(tx("agent"), lead.agentId));
    body.append(infoRow(tx("model"), lead.lastOperation?.observedModel ?? lead.profile?.model ?? tx("app3::not reported")));
    body.append(infoRow(tx("state"), leadStateWords(lead)));
    if (lead.projectId !== WORLD_PROJECT) {
      body.append(noteBlock("note", tx("World lead lives in project {projectId}, not in the World HQ: it was ", { projectId: lead.projectId })
        + tx("assigned before the World HQ existed. It works the same way.")));
    }
    const open = el("button", "small primary", tx("Open chat"));
    open.addEventListener("click", () => {
      closeSheet();
      atlasOpenWorkspace(leadNode(lead), { camera: false });
    });
    actions.append(open);
    body.append(actions);
  } else {
    body.append(el("div", "muted", WORLD_LEAD_HINT));
    const waiting = worldHeadquartersAgents();
    if (waiting.length > 0) {
      body.append(noteBlock("note", tx("The World HQ has an agent without the lead role: it was created, but the role was not ")
        + tx("assigned. It can be made the world lead.")));
      for (const agent of waiting) {
        const row = el("div", "entry");
        row.append(el("div", "entry-title", agent.agentId));
        row.append(el("div", "entry-text", [agent.profile?.model ?? null, agent.state].filter(Boolean).join(" · ")));
        const result = el("div");
        const appoint = trustedButton(tx("Make world lead…"), () => appointWorldLead(agent, result));
        row.append(appoint, result);
        body.append(row);
      }
    }
    const create = actionButton(tx("Create world lead…"), "mutation.memory.agent.create",
      () => openCreateWorldLeadSheet(), { primary: true });
    if (atlasState.trusted.available !== true) {
      create.disabled = true;
      create.title = tx("trusted actions unavailable: {reasonCode}", { reasonCode: atlasState.trusted.reasonCode });
    }
    actions.append(create);
    body.append(actions);
  }

  body.append(el("div", "section-title", tx("Tasks")));
  const tasksBox = el("div");
  body.append(tasksBox);
  taskBoardList(tasksBox, { empty: tx("No tasks have been given out to desk agents yet.") });

  body.append(el("div", "section-title", tx("Desk agents")));
  const sourcesBox = el("div");
  body.append(sourcesBox);
  const paintSources = () => {
    const board = atlasState.taskBoard ?? null;
    sourcesBox.replaceChildren();
    if (board === null) sourcesBox.append(el("div", "muted", tx("Reading…")));
    else if (board.failed) sourcesBox.append(noteBlock("error", tx("Not read: {reason}.", { reason: board.reason })));
    else if (board.sources.length === 0) {
      sourcesBox.append(el("div", "empty", tx("No agent takes controller tasks yet.")));
    }
    for (const source of board?.failed ? [] : board?.sources ?? []) {
      const row = el("div", "entry");
      const found = agentNamed(source.agentId);
      row.append(el("div", "entry-title", source.agentId));
      row.append(el("div", "entry-text", [found === null ? tx("not in the catalog") : `${found.projectId} / ${found.quarterId}`,
        tx("source {sourceId}", { sourceId: source.sourceId }), source.valid ? tx("takes tasks")
          : tx("coordination folder fails the check")].join(" · ")));
      sourcesBox.append(row);
    }
    sourcesBox.append(noteBlock("note", tx("An agent is made a desk agent from its card (the inspector or the “Tasks” tab ")
      + tx("of the workspace): “Take tasks (desk agent)…”. The registration is permanent.")));
  };
  paintSources();
  loadTaskBoard().then(() => {
    if (atlasState.sheetOwner === "world" && !$("sheet").classList.contains("hidden")) paintSources();
  });
}

/** A new world lead: a name and a model, and everything else with one confirmation. */
async function openCreateWorldLeadSheet() {
  const body = openSheet(tx("World lead"), tx("one confirmation"));
  body.append(noteBlock("note", WORLD_LEAD_HINT));
  const agentId = identifierField(tx("world lead identifier"), { taken: agentIdTaken });
  agentId.set(freeAgentId("world-lead"));
  body.append(el("div", "section-title", tx("Identifier")), agentId.input, agentId.hint);
  const profileBox = el("div");
  profileBox.append(el("div", "muted", tx("Reading the model list from the backend…")));
  body.append(profileBox);
  const steps = el("div");
  body.append(el("div", "section-title", tx("What will be done")), steps);
  const result = el("div");
  const actions = el("div", "actions");
  body.append(actions, result);
  const catalog = await window.atlas.models();
  const readProfile = catalog.ok
    ? renderProfileLists(profileBox, catalog.data)
    : renderProfileFields(profileBox, catalog.error);
  const { project } = findNode({ kind: "project", projectId: WORLD_PROJECT, quarterId: null, agentId: null });
  const hq = project?.quarters.find((quarter) => quarter.quarterId === HEADQUARTERS_QUARTER) ?? null;
  const folder = el("div");
  steps.append(infoRow(tx("world project"), project === null ? tx("{WORLD_PROJECT} · will be created", { WORLD_PROJECT }) : tx("{WORLD_PROJECT} · exists", { WORLD_PROJECT })),
    folder,
    infoRow(tx("app::World HQ"), hq === null ? tx("will be created") : tx("exists")),
    infoRow(tx("agent"), tx("will be created in the World HQ")),
    infoRow(tx("role"), tx("world lead (the controller's coordinator)")));
  folder.append(infoRow(tx("world project folder"), tx("checking…")));
  window.atlas.projectFolder({ projectId: WORLD_PROJECT }).then((response) => {
    folder.replaceChildren(infoRow(tx("world project folder"), !response.ok
      ? tx("not checked: {value}", { value: boardFailureText(response.error) })
      : response.data.configured ? tx("{workspacePath} · already bound", { workspacePath: response.data.workspacePath })
        : tx("controller folder · will be bound permanently")));
  });
  steps.append(noteBlock("note", tx("There is one confirmation — in an Atlas window: it names the controller folder, the agent and the role. ")
    + tx("The world project, its HQ and the agent are created without separate questions, like any project, quarter and agent.")));
  const create = actionButton(tx("Create with confirmation"), "mutation.memory.agent.create", async () => {
    const problem = agentId.problem();
    if (problem !== null) {
      result.replaceChildren(noteBlock("error", problem));
      return;
    }
    create.disabled = true;
    await createWorldLead({ agentId: agentId.input.value.trim(), profile: readProfile(), result });
    create.disabled = false;
  }, { primary: true });
  if (atlasState.trusted.available !== true) {
    create.disabled = true;
    create.title = tx("trusted actions unavailable: {reasonCode}", { reasonCode: atlasState.trusted.reasonCode });
  }
  actions.append(create);
}

/**
 * World lead in one confirmed flow: the confirmation and the binding
 * of the world project to the controller folder (host), the world project and its HQ if they
 * do not exist, the agent, its role (host, only with this flow's confirmation) - and its chat
 * where the camera is. Every refusal is named in words; what is already done stays.
 */
async function createWorldLead({ agentId, profile, result }) {
  const say = (kind, text) => result.replaceChildren(noteBlock(kind, text));
  say("note", tx("Waiting for confirmation…"));
  const prepared = await window.atlas.prepareWorldLead({ agentId, model: profile.model || null });
  if (!prepared.ok) {
    const text = describeWorldLeadRefusal(prepared.error);
    if (prepared.error?.code !== "user_declined") atlasRecord("bad", tx("world lead not created"), text);
    say(prepared.error?.code === "user_declined" ? "note" : "error", text);
    return false;
  }
  const scopeStep = async (kind, quarterId, title) => {
    const { project, quarter } = findNode({ kind, projectId: WORLD_PROJECT, quarterId, agentId: null });
    if ((kind === "project" ? project : quarter) !== null) return true;
    const created = await window.atlas.createScope(kind === "project"
      ? { kind: "project", projectId: WORLD_PROJECT, title }
      : { kind: "quarter", projectId: WORLD_PROJECT, quarterId, title });
    const described = describeCreateOutcome(kind, kind === "project" ? WORLD_PROJECT : quarterId, created);
    if (described.reread) await refresh();
    if (!created.ok) {
      result.replaceChildren(outcomeBlock(described));
      return false;
    }
    return true;
  };
  say("note", tx("Controller folder bound. Creating the world project and the World HQ…"));
  if (!await scopeStep("project", null, tx("World"))) return false;
  if (!await scopeStep("quarter", HEADQUARTERS_QUARTER, tx("World HQ"))) return false;
  say("note", tx("Creating agent {agentId}…", { agentId }));
  const created = await window.atlas.createAgent({ agentId, projectId: WORLD_PROJECT, quarterId: HEADQUARTERS_QUARTER,
    profile });
  const described = describeCreateOutcome("agent", agentId, created);
  if (described.reread) await refresh();
  if (!created.ok) {
    result.replaceChildren(outcomeBlock(described));
    atlasRecord("bad", tx("world lead not created"), [described.title, ...described.details].join(" "));
    return false;
  }
  const assigned = await window.atlas.assignWorldLead({ agentId, flowId: prepared.data.flowId, expectedRevision: 0 });
  await refresh();
  if (!assigned.ok) {
    const text = tx("Agent {agentId} was created in the World HQ, but did not get the world lead role: ", { agentId })
      + `${describeWorldLeadRefusal(assigned.error)}`;
    atlasRecord("bad", tx("world lead role not assigned"), text);
    say("error", text);
    return false;
  }
  atlasRecord("ok", tx("world lead"), tx("{agentId} · project {WORLD_PROJECT} in the controller folder", { agentId, WORLD_PROJECT }));
  closeSheet();
  atlasOpenWorkspace({ kind: "agent", projectId: WORLD_PROJECT, quarterId: HEADQUARTERS_QUARTER, agentId },
    { camera: false });
  return true;
}

/** An agent of the World HQ without a role becomes the world lead: the same one confirmation, then the role. */
async function appointWorldLead(agent, result) {
  const say = (kind, text) => result.replaceChildren(noteBlock(kind, text));
  const prepared = await window.atlas.prepareWorldLead({ agentId: agent.agentId, model: agent.profile?.model ?? null });
  if (!prepared.ok) {
    say(prepared.error?.code === "user_declined" ? "note" : "error", describeWorldLeadRefusal(prepared.error));
    return;
  }
  const assigned = await window.atlas.assignWorldLead({ agentId: agent.agentId, flowId: prepared.data.flowId,
    expectedRevision: agent.settings?.revision ?? 0 });
  await refresh();
  if (!assigned.ok) {
    say("error", describeWorldLeadRefusal(assigned.error));
    return;
  }
  atlasRecord("ok", tx("world lead"), agent.agentId);
  closeSheet();
  atlasOpenWorkspace(leadNode(agent), { camera: false });
}

/** The World HQ inspector: the lead, a summary of tasks and desk agents, the way into the sheet and the chat. */
function renderWorldInspector(body) {
  const lead = worldLeadOf();
  body.append(infoRow(tx("world lead"), lead === null ? tx("not assigned") : lead.agentId));
  if (lead !== null) {
    body.append(infoRow(tx("model"), lead.lastOperation?.observedModel ?? lead.profile?.model ?? tx("app3::not reported")));
    body.append(infoRow(tx("state"), leadStateWords(lead)));
  }
  const summary = el("div");
  body.append(summary);
  const paint = () => {
    const board = atlasState.taskBoard ?? null;
    if (board === null) {
      summary.replaceChildren(infoRow(tx("tasks"), tx("checking…")));
      return;
    }
    if (board.failed) {
      summary.replaceChildren(infoRow(tx("tasks"), tx("not read: {reason}", { reason: board.reason })));
      return;
    }
    const count = (stages) => board.tasks.filter((task) => stages.includes(task.stage)).length;
    summary.replaceChildren(
      infoRow(tx("desk agents"), board.sources.length),
      infoRow(tx("app::tasks"), tx("{length}: in progress {value}, ", { length: board.tasks.length, value: count(["started", "accepted", "planned", "in-progress"]) })
        + tx("reported {value}, accepted by code {value}, declined {value}", { value: count(["reported"]) })),
    );
  };
  paint();
  loadTaskBoard().then(paint);
  const actions = el("div", "actions");
  const sheet = el("button", "small primary", tx("World HQ"));
  sheet.addEventListener("click", () => atlasOpenWorldHeadquarters());
  actions.append(sheet);
  if (lead !== null) {
    const chat = el("button", "small", tx("World lead chat"));
    chat.addEventListener("click", () => atlasOpenWorkspace(leadNode(lead), { camera: false }));
    actions.append(chat);
  } else {
    actions.append(trustedButton(tx("Create world lead…"), () => openCreateWorldLeadSheet()));
  }
  body.append(actions);
}

/**
 * Project archive. Archiving asks for a system confirmation; nothing is
 * deleted: the project leaves the map together with its quarters and closed agents and
 * comes back from the “Project archive” exactly as it was.
 */
async function atlasArchiveProject(projectId) {
  const response = await window.atlas.archiveProject({ projectId });
  if (response.ok) {
    atlasRecord("ok", tx("project archived"), tx("{projectId} · can be restored from the “Project archive”", { projectId }));
    atlasToast(tx("Project “{projectId}” is archived. You can bring it back with the “Archive” button at the top right.", { projectId }));
    refreshArchiveCount();
    closeSheet();
    await refresh();
    return;
  }
  if (response.error?.code === "user_declined") return;
  const reason = response.error?.reasonCode || response.error?.code || tx("no code");
  if (reason === "memory_project_has_agents") {
    const text = tx("Project {projectId} has open agents. Archive them, then the project: the agent history is kept.", { projectId });
    atlasRecord("bad", tx("project archiving"), text);
    archiveBlockedSheet(projectId, null, text);
    return;
  }
  const text = tx("Project {projectId} not archived: {reason}.", { projectId, reason });
  atlasRecord("bad", tx("project archiving"), text);
  const body = openSheet(tx("Archiving · {projectId}", { projectId }), tx("trusted action"));
  body.append(noteBlock("error", text));
}

/** The open agents of a project (including the lead in the HQ) or of one of its quarters. */
function openAgentsOf(projectId, quarterId = null) {
  const world = atlasState.world;
  const project = world?.status === "ready"
    ? world.projection.projects.find((item) => item.projectId === projectId) ?? null : null;
  return (project?.quarters ?? []).filter((quarter) => quarterId === null || quarter.quarterId === quarterId)
    .flatMap((quarter) => quarter.agents).filter((agent) => agent.state !== "archived");
}

/**
 * Archiving failed because of open agents: they are listed here, each one can be
 * archived (with confirmation), and when none are left - the project or the quarter itself.
 */
function archiveBlockedSheet(projectId, quarterId, text) {
  const body = openSheet(tx("Archiving · {value}", { value: quarterId ?? projectId }), tx("trusted action"));
  body.append(noteBlock("error", text));
  const list = el("div");
  body.append(list);
  const render = () => {
    const agents = openAgentsOf(projectId, quarterId);
    list.replaceChildren(el("div", "section-title", tx("Open agents · {length}", { length: agents.length })));
    if (agents.length === 0) {
      list.append(el("div", "muted", tx("No open agents are left.")));
      const again = el("button", "small primary", quarterId === null ? tx("Archive project…") : tx("Archive quarter…"));
      again.addEventListener("click", () => (quarterId === null ? atlasArchiveProject(projectId)
        : atlasArchiveQuarter(projectId, quarterId)));
      list.append(again);
      return;
    }
    for (const agent of agents) {
      const row = el("div", "entry");
      row.append(el("div", "entry-title", agent.agentId));
      row.append(el("div", "entry-text", [agent.quarterId === HEADQUARTERS_QUARTER ? tx("project lead") : agent.quarterId,
        agent.currentOperationId ? tx("working") : agent.state].join(" · ")));
      const archive = el("button", "small", tx("Archive…"));
      archive.addEventListener("click", async () => {
        await atlasArchiveAgent(agent.agentId);
        render();
      });
      row.append(archive);
      list.append(row);
    }
  };
  render();
}

/** A quarter goes to the archive after confirmation; it can be restored from the “Archive”. */
async function atlasArchiveQuarter(projectId, quarterId) {
  const response = await window.atlas.archiveQuarter({ projectId, quarterId });
  if (response.ok) {
    atlasRecord("ok", tx("quarter archived"), tx("{projectId}/{quarterId} · can be restored from the “Archive”", { projectId, quarterId }));
    atlasToast(tx("Quarter “{quarterId}” is archived. You can bring it back with the “Archive” button at the top right.", { quarterId }));
    refreshArchiveCount();
    closeSheet();
    await refresh();
    return;
  }
  if (response.error?.code === "user_declined") return;
  const reason = response.error?.reasonCode || response.error?.code || tx("no code");
  if (reason === "memory_quarter_has_agents") {
    const text = tx("Quarter {quarterId} has open agents. Archive them, then the quarter: the agent history is kept.", { quarterId });
    atlasRecord("bad", tx("quarter archiving"), text);
    archiveBlockedSheet(projectId, quarterId, text);
    return;
  }
  const text = tx("Quarter {quarterId} not archived: {reason}.", { quarterId, reason });
  atlasRecord("bad", tx("quarter archiving"), text);
  openSheet(tx("Archiving · {quarterId}", { quarterId }), tx("trusted action")).append(noteBlock("error", text));
}

/** An agent goes to the archive (closing) after confirmation. Its conversation stays readable. */
async function atlasArchiveAgent(agentId) {
  const response = await window.atlas.closeAgent({ agentId });
  if (response.ok) {
    atlasRecord("ok", tx("agent archived"), agentId);
    // The agent leaves the map: the selection moves to its quarter, the “Archive” counter grows.
    const selected = scene.selection;
    if (selected?.kind === "agent" && selected.agentId === agentId) {
      selectNode({ kind: "quarter", projectId: selected.projectId, quarterId: selected.quarterId, agentId: null });
    }
    await refresh();
    refreshArchiveCount();
    return;
  }
  if (response.error?.code === "user_declined") return;
  const reason = response.error?.reasonCode || response.error?.code || tx("no code");
  const text = reason === "writer_busy"
    ? tx("Agent {agentId} is working now: wait for the turn to end or stop it, then archive.", { agentId })
    : reason === "conflict"
      ? tx("Agent {agentId} not archived: the backend refused the closing (conflict) - the request does not match ", { agentId })
        + tx("what is recorded about it.")
      : tx("Agent {agentId} not archived: {reason}.", { agentId, reason });
  atlasRecord("bad", tx("agent archiving"), text);
  openSheet(tx("Archiving · {agentId}", { agentId }), tx("backend operation")).append(noteBlock("error", text));
}

/** How many projects and quarters are archived - shown on the “Archive” button in the map corner. */
function showArchiveCount(count) {
  $("archiveCount").textContent = String(count);
}

/** Archived agents come from the catalog: they are not on the map, their conversations are read from the “Archive”. */
function archivedAgents() {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return [];
  return world.projection.projects.flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents))
    .filter((agent) => agent.state === "archived");
}

function refreshArchiveCount() {
  if (typeof window.atlas?.archivedProjects !== "function" || atlasState.trusted?.available !== true) {
    showArchiveCount(archivedAgents().length);
    return;
  }
  window.atlas.archivedProjects().then((response) => {
    if (response.ok) {
      showArchiveCount(response.data.projects.length + (response.data.quarters ?? []).length + archivedAgents().length);
    }
  });
}

/** Why the backend did not undo a change, in words (its codes, action-journal-undo.mjs). */
function undoRefusal(reason) {
  const words = {
    journal_undo_stale: tx("Something changed after it: undo the later change first."),
    journal_undo_agent_worked: tx("The agent has already worked: close it instead."),
    journal_undo_model_unavailable: tx("That model is no longer offered by the provider."),
    journal_undo_file_not_here: tx("The previous version of the file is not on this PC: it was saved on another one, or long ago."),
    journal_already_undone: tx("It is already undone."),
    journal_not_undoable: tx("This change cannot be undone."),
    memory_quarter_has_agents: tx("The quarter has open agents: close them first."),
    memory_project_has_agents: tx("The project has open agents: close them first."),
    memory_role_taken: tx("Another agent holds that role now."),
    memory_project_archived: tx("Its project is archived: restore it first."),
    memory_quarter_archived: tx("Its quarter is archived: restore it first."),
  };
  return words[reason] ?? tx("Not undone: {reason}.", { reason });
}

/** Why an entry has no “Undo” (the backend's noUndo). */
function noUndoReason(reason) {
  const words = {
    undo_entry: tx("This is an undo: to repeat the change, make it again."),
    file_not_kept: tx("Not undone here: the previous version of the file was not kept."),
    binding_not_undone: tx("Not undone here: bind the folder again to change it."),
    git_not_undone: tx("Not undone here: the git repository stays in the folder."),
    desk_source_not_undone: tx("Not undone here: the agent keeps taking controller tasks."),
    approval_without_write: tx("Nothing was written yet: the agent writes the approved document itself."),
  };
  return words[reason] ?? tx("Not undone here.");
}

/**
 * The history of changes (the backend's action journal): who changed what and
 * when, in the world or in one project, newest first; a change that can be
 * undone has “Undo” (a trusted action the person confirms).
 */
/** A history entry in a few words: what happened, to which object (by its name). */
function historyTitle(entry) {
  const agent = entry.agentId === null ? "?" : displayName("agent", entry.projectId, entry.agentId);
  const quarter = entry.quarterId === null ? "?" : displayName("quarter", entry.projectId, entry.quarterId);
  const project = displayName("project", entry.projectId, entry.projectId);
  const titles = {
    "agent.create": () => tx("Agent {name} created", { name: agent }),
    "agent.close": () => tx("Agent {name} closed", { name: agent }),
    "agent.reopen": () => tx("Agent {name} back to work", { name: agent }),
    "agent.profile": () => tx("Model of agent {name}", { name: agent }),
    "agent.settings": () => tx("Role of agent {name}", { name: agent }),
    "agent.permission-mode": () => tx("Permissions of agent {name}", { name: agent }),
    "agent.desk-source": () => tx("{name} takes tasks", { name: agent }),
    "scope.create": () => (entry.quarterId === null ? tx("Project {name} created", { name: project })
      : tx("Quarter {name} created", { name: quarter })),
    "memory.write": () => tx("Memory changed · {name}", { name: entry.agentId !== null ? agent
      : entry.quarterId !== null ? quarter : project }),
    "memory.approve": () => tx("Memory document approved · {name}", { name: agent }),
    "project.archive": () => tx("Project {name} archived", { name: project }),
    "project.restore": () => tx("Project {name} restored", { name: project }),
    "quarter.archive": () => tx("Quarter {name} archived", { name: quarter }),
    "quarter.restore": () => tx("Quarter {name} restored", { name: quarter }),
    "project.copy": () => tx("Project copy {name}", { name: project }),
    "project.policy": () => tx("Where project {name} is kept", { name: project }),
    "project.bind": () => tx("Folder of project {name}", { name: project }),
    "project.rebind": () => tx("Folder of project {name}", { name: project }),
    "project.git-init": () => tx("Git in the folder of {name}", { name: project }),
    "project.file-save": () => tx("File saved · {name}", { name: project }),
    "object.rename": () => tx("Renamed · {name}", { name: entry.agentId !== null ? agent
      : entry.quarterId !== null ? quarter : project }),
  };
  const title = titles[entry.action]?.() ?? entry.action;
  return entry.undoes === null ? title : tx("Undo · {title}", { title });
}

async function atlasOpenHistory(projectId = null) {
  const body = openSheet(projectId === null ? tx("History of changes")
    : tx("History · {projectId}", { projectId: displayName("project", projectId, projectId) }), tx("trusted action"));
  const list = el("div");
  body.append(el("div", "muted history-hint", tx("Click an entry for details and “Undo”.")), list);
  const when = (value) => (typeof value === "string" ? `${value.slice(0, 16).replace("T", " ")} UTC` : tx("app::not reported"));
  // In the list: the time today, the day and the time before (this PC's clock).
  const today = new Date().toDateString();
  const short = (value) => {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) return "?";
    return at.toDateString() === today ? at.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })
      : at.toLocaleString(dateLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const undoButton = (box, entry) => trustedButton(tx("Undo"), async () => {
    const done = await window.atlas.undoAction({ projectId: entry.projectId, entryId: entry.entryId });
    if (done.ok) {
      atlasRecord("ok", tx("change undone"), entry.summary);
      refreshArchiveCount();
      await refresh();
      await render();
      return;
    }
    if (done.error?.code === "user_declined") return;
    const reason = done.error?.reasonCode || done.error?.code || tx("no code");
    atlasRecord("bad", tx("undo change"), `${entry.summary}: ${reason}`);
    box.append(noteBlock("error", undoRefusal(reason)));
  });
  const render = async () => {
    list.replaceChildren(el("div", "muted", tx("Reading the history…")));
    const response = await window.atlas.actionJournal({ projectId, limit: 200 });
    if (!response.ok) {
      list.replaceChildren(noteBlock("error",
        tx("History not read: {value}.", { value: response.error?.reasonCode || response.error?.code || tx("no code") })));
      return;
    }
    const { entries } = response.data;
    list.replaceChildren(el("div", "section-title", tx("Changes · {length}", { length: entries.length })));
    if (entries.length === 0) list.append(el("div", "empty", tx("No changes recorded yet.")));
    // One line per change; a click opens its details: the full record, who and where, “Undo”.
    for (const entry of entries) {
      const box = el("div", "history-entry");
      const row = el("button", "history-row");
      row.append(el("span", "history-when", short(entry.atUtc)), el("span", "history-title", historyTitle(entry)));
      if (entry.undoneBy !== null) row.append(el("span", "history-mark", tx("undone")));
      const details = el("div", "history-details hidden");
      details.append(el("div", "entry-text", entry.summary));
      const who = entry.actor.kind === "agent"
        ? tx("agent {agentId}", { agentId: entry.actor.id === null ? "?" : displayName("agent", entry.projectId, entry.actor.id) })
        : tx("you");
      const where = entry.quarterId === null ? displayName("project", entry.projectId, entry.projectId)
        : `${displayName("project", entry.projectId, entry.projectId)} / ${entry.quarterId === HEADQUARTERS_QUARTER ? tx("HQ")
          : displayName("quarter", entry.projectId, entry.quarterId)}`;
      details.append(el("div", "muted", `${when(entry.atUtc)} · ${who} · ${where}`));
      if (entry.undoneBy !== null) details.append(el("div", "muted", tx("Undone {value}.", { value: when(entry.undoneAtUtc) })));
      else if (entry.undoable) {
        const actions = el("div", "actions");
        actions.append(undoButton(details, entry));
        details.append(actions);
      } else if (entry.noUndo !== null) details.append(el("div", "muted", noUndoReason(entry.noUndo)));
      row.addEventListener("click", () => {
        details.classList.toggle("hidden");
        box.classList.toggle("open", !details.classList.contains("hidden"));
      });
      box.append(row, details);
      list.append(box);
    }
  };
  await render();
}

/** Archive: projects and quarters. Each one returns to the map without confirmation - nothing is lost. */
async function atlasOpenProjectArchive() {
  const body = openSheet(tx("app::Archive"), tx("trusted action"));
  const list = el("div");
  body.append(list, noteBlock("note",
    tx("An archived project or quarter is not visible on the map, but intact: memory, folder binding and closed agents ")
    + tx("are kept. Restoring puts it back on the map exactly as it was and asks for no confirmation. ")
    + tx("An archived agent also leaves the map; its conversation can be read from here, and “History” brings it back to work (undo of its closing).")));
  const since = (item) => (item.archivedAtUtc
    ? `${item.archivedAtUtc.slice(0, 16).replace("T", " ")} UTC` : tx("app::not reported"));
  const restoreButton = (box, label, restore) => trustedButton(tx("Restore to map"), async () => {
    const restored = await restore();
    if (restored.ok) {
      atlasRecord("ok", tx("restored from archive"), label);
      refreshArchiveCount();
      await refresh();
      await render();
      return;
    }
    const reason = restored.error?.reasonCode || restored.error?.code || tx("no code");
    atlasRecord("bad", tx("restore from archive"), `${label}: ${reason}`);
    box.append(noteBlock("error", tx("Not restored: {reason}.", { reason })));
  });
  const render = async () => {
    list.replaceChildren(el("div", "muted", tx("Reading the archive…")));
    const response = await window.atlas.archivedProjects();
    if (!response.ok) {
      list.replaceChildren(noteBlock("error",
        tx("Archive not read: {value}.", { value: response.error?.reasonCode || response.error?.code || tx("no code") })));
      return;
    }
    const { projects, quarters = [] } = response.data;
    const agents = archivedAgents();
    showArchiveCount(projects.length + quarters.length + agents.length);
    list.replaceChildren(el("div", "section-title", tx("Projects · {length}", { length: projects.length })));
    if (projects.length === 0) list.append(el("div", "empty", tx("No projects in the archive.")));
    for (const item of projects) {
      const box = el("div", "entry");
      box.append(el("div", "entry-title", item.title ? `${item.projectId} · ${item.title}` : item.projectId));
      box.append(el("div", "entry-text",
        tx("quarters: {value} · archived since {value2}", { value: item.quarterCount ?? tx("app::not reported"), value2: since(item) })));
      box.append(restoreButton(box, item.projectId, () => window.atlas.restoreProject({ projectId: item.projectId })));
      list.append(box);
    }
    list.append(el("div", "section-title", tx("Quarters · {length}", { length: quarters.length })));
    if (quarters.length === 0) list.append(el("div", "empty", tx("No quarters in the archive.")));
    for (const item of quarters) {
      const box = el("div", "entry");
      box.append(el("div", "entry-title", `${item.projectId} / ${item.quarterId}${item.title ? ` · ${item.title}` : ""}`));
      box.append(el("div", "entry-text", tx("archived since {value}", { value: since(item) })));
      box.append(restoreButton(box, `${item.projectId}/${item.quarterId}`,
        () => window.atlas.restoreQuarter({ projectId: item.projectId, quarterId: item.quarterId })));
      list.append(box);
    }
    // An archived agent's conversation and memory remain: they can be read; "History" brings it back to work.
    list.append(el("div", "section-title", tx("Agents · {length}", { length: agents.length })));
    if (agents.length === 0) list.append(el("div", "empty", tx("No agents in the archive.")));
    for (const agent of agents) {
      const box = el("div", "entry");
      box.append(el("div", "entry-title", agent.agentId));
      box.append(el("div", "entry-text", tx("{projectId} / {quarterId}", { projectId: agent.projectId, quarterId: agent.quarterId === HEADQUARTERS_QUARTER ? tx("HQ") : agent.quarterId })
        + tx(" · archived since {value}", { value: since(agent) })));
      const read = el("button", "small", tx("Conversation"));
      read.addEventListener("click", () => {
        closeSheet();
        atlasOpenWorkspace({ kind: "agent", projectId: agent.projectId, quarterId: agent.quarterId,
          agentId: agent.agentId }, { camera: false });
      });
      box.append(read);
      list.append(box);
    }
  };
  await render();
}

// --- projects not on this PC -----------------------------------------------

/** The world by its registry: projects not on this PC (grey frames on the map), this PC, the "where it may be kept" rules. */
function refreshAwayProjects() {
  if (typeof window.atlas?.awayProjects !== "function" || atlasState.trusted?.available !== true) return;
  window.atlas.awayProjects().then((response) => {
    if (!response.ok) return;
    atlasState.away = response.data;
    $("awayToggle").classList.toggle("hidden", response.data.split !== true);
    $("awayCount").textContent = String(response.data.projects.length);
    requestRender();
  });
}

const awayProjectOf = (projectId) => (atlasState.away.projects ?? []).find((item) => item.projectId === projectId) ?? null;
const knownProjectOf = (projectId) => (atlasState.away.known ?? []).find((item) => item.projectId === projectId) ?? null;

/** Where the project is now: on which PC, or in a package. */
function placeText(location) {
  if (location === null || location === undefined) return tx("where it is now — unknown");
  return location.machineId === null ? tx("in a package (on no PC)") : tx("on PC \"{title}\"", { title: location.title });
}

/** Where the project may be kept - in words. */
function policyText(policy) {
  if (policy?.homeOnly) return tx("home only");
  if (Array.isArray(policy?.allowedMachines)) {
    const machines = atlasState.away.machines ?? {};
    return tx("only on PC: {value}", { value: policy.allowedMachines.map((id) => machines[id]?.title ?? id).join(", ") });
  }
  return tx("on any PC");
}

/** A summary without texts: how many agents, quarters, open tasks, and when the last work was. */
function summaryText(summary) {
  if (summary === null || summary === undefined) return tx("no summary");
  const when = summary.lastActivityUtc ? `${summary.lastActivityUtc.slice(0, 16).replace("T", " ")} UTC` : tx("app::none yet");
  return tx("agents: {value} · quarters: {value2} · open tasks: ", { value: summary.agents ?? "?", value2: summary.quarters ?? "?" })
    + tx("{value} · last work: {when}", { value: summary.tasksOpen ?? "?", when });
}

/** The "where the project may be kept" choice; the current one is selected. "Only on this PC" - when the PC has a name. */
function policySelect(policy) {
  const select = el("select");
  const thisMachine = atlasState.away.thisMachine ?? null;
  const current = policy?.homeOnly ? "home"
    : Array.isArray(policy?.allowedMachines) ? (thisMachine !== null && policy.allowedMachines.length === 1
      && policy.allowedMachines[0] === thisMachine.machineId ? "this-pc" : "other") : "anywhere";
  const options = [["anywhere", tx("on any PC")], ["home", tx("home only")],
    ["this-pc", thisMachine === null ? tx("only on this PC (the PC has no name yet)") : tx("only on this PC (\"{title}\")", { title: thisMachine.title })]];
  if (current === "other") options.push(["other", tx("{value} (as now)", { value: policyText(policy) })]);
  for (const [value, label] of options) {
    const option = el("option", null, label);
    option.value = value;
    option.disabled = value === "this-pc" && thisMachine === null;
    option.selected = value === current;
    select.append(option);
  }
  return select;
}

/** "Where the project is kept" in the HQ: where it is and where it may be kept (split instance). */
function projectPlaceSection(body, projectId) {
  if (atlasState.away.split !== true || projectId === WORLD_PROJECT) return;
  const known = knownProjectOf(projectId);
  body.append(el("div", "section-title", tx("Where it is kept")));
  body.append(infoRow(tx("now"), atlasState.away.thisMachine ? tx("on this PC (\"{title}\")", { title: atlasState.away.thisMachine.title }) : tx("on this PC")));
  body.append(infoRow(tx("may be kept"), policyText(known?.policy)));
  const select = policySelect(known?.policy);
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(select, trustedButton(tx("Save"), async () => {
    if (select.value === "other") return;
    const response = await window.atlas.setProjectPolicy({ projectId, choice: select.value });
    if (response.ok) {
      atlasRecord("ok", tx("where to keep the project"), `${projectId}: ${policyText(response.data.policy)}`);
      result.replaceChildren(noteBlock("note", response.data.changed
        ? tx("Saved: {value}. The project package gets it with its next export.", { value: policyText(response.data.policy) })
        : tx("Already recorded so.")));
      refreshAwayProjects();
      return;
    }
    if (response.error?.code === "user_declined") {
      result.replaceChildren(noteBlock("note", tx("Not changed: the confirmation was declined.")));
      return;
    }
    const reason = response.error?.reasonCode || response.error?.code || tx("no code");
    result.replaceChildren(noteBlock("error", reason === "machine_not_named"
      ? tx("This PC has no name yet: agents-factory machine set --id <id> --title <title>.")
      : tx("Not changed: {reason}.", { reason })));
  }));
  body.append(actions, result);
  body.append(noteBlock("note", tx("For now this is a mark: it starts refusing connection on other PCs with the world's sync (block 3).")));
}

/** Why the project was not disconnected or connected - in words, by the refusal's code. */
function mountRefusalText(error) {
  const reason = error?.reasonCode || error?.code || tx("no code");
  const texts = {
    project_not_quiescent: tx("A project agent is working now. Wait for the turn to end and try again."),
    unmount_interactions_open: tx("A project agent has a question or a permission request without an answer. Answer it in the agent's ")
      + tx("window and try again. Nothing was removed from this PC."),
    package_folder_not_empty: tx("The chosen folder already holds other files. Choose an empty folder or this project's package folder."),
    package_other_project: tx("The chosen folder holds another project's package."),
    package_unreadable: tx("The chosen folder has no project package (project.af.json)."),
    unmount_file_changed: tx("A project file changed while the package was written. Nothing was removed from this PC: try again."),
    project_already_mounted: tx("This project is already on this PC."),
    package_world_mismatch: tx("A package from another world: it cannot be connected to this instance."),
    gateway_running: tx("The Gateway is running and could not be stopped. Stop it in the Gateway panel and try again."),
    store_layout_single: tx("The instance is not split by project yet: projects can be disconnected after ")
      + "agents-factory project migrate-layout.",
    machine_not_named: tx("This PC has no name yet: agents-factory machine set --id <id> --title <title>."),
  };
  if (error?.code === "busy") return tx("The Gateway is busy with another action ({reason}). Try again when it is over.", { reason });
  return texts[reason] ?? tx("Not done: {reason}.", { reason });
}

/** The Gateway stopped for the action - and whether it started again. */
function gatewayPauseText(gateway) {
  if (gateway?.paused !== true) return null;
  return gateway.restarted
    ? tx("The Gateway stopped for that time and was started again.")
    : tx("The Gateway stopped for that time and did not start again: start it in the Gateway panel.");
}

/**
 * Disconnect the project from this PC: the package is written to a folder the person
 * chooses, checked, and only then the project's memory, conversations and tasks
 * leave the PC. The project folder with its files is not touched. The confirmation is in
 * a system window, with the project, the package folder and where the package may be kept.
 */
async function atlasUnmountProject(projectId) {
  const body = openSheet(tx("Disconnect from this PC · {projectId}", { projectId }), tx("trusted action"));
  body.append(noteBlock("note",
    tx("The project goes into a package: its memory, conversations, tasks and place on the map are written to the package folder, checked, ")
    + tx("and only then leave this PC. A grey frame stays on the map. The project folder with its files is not touched. ")
    + tx("The project comes back with a click on the frame or with \"Not on this PC\" at the top right, choosing the same package ")
    + tx("folder. The package needs an empty folder or this project's earlier package folder.")));
  const select = policySelect(knownProjectOf(projectId)?.policy);
  const row = el("div", "actions");
  row.append(el("span", "muted", tx("Where the package may be kept:")), select);
  body.append(row);
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(trustedButton(tx("Choose the package folder and disconnect…"), async () => {
    const chosen = await window.atlas.chooseWorkspace({ purpose: "package" });
    if (!chosen.ok) {
      atlasRecord("bad", tx("folder not chosen"), chosen.error.reasonCode || chosen.error.code);
      return;
    }
    if (!chosen.data.chosen) return;
    // The project's place on the map goes in its package: first write what is not written yet.
    await flushPending();
    result.replaceChildren(el("div", "muted", tx("Writing the package and disconnecting the project…")));
    const response = await window.atlas.unmountProject({
      projectId, selectionId: chosen.data.selectionId, choice: select.value === "other" ? null : select.value,
    });
    if (response.ok) {
      atlasRecord("ok", tx("project disconnected from this PC"), tx("{projectId} · package {displayPath}", { projectId, displayPath: chosen.data.displayPath }));
      result.replaceChildren(noteBlock("note", [tx("Project \"{projectId}\" disconnected. Package: {displayPath}.", { projectId, displayPath: chosen.data.displayPath }),
        gatewayPauseText(response.data.gateway)].filter(Boolean).join(" ")));
      refreshAwayProjects();
      refreshArchiveCount();
      await refresh();
      return;
    }
    if (response.error?.code === "user_declined") {
      result.replaceChildren(noteBlock("note", tx("Nothing was done: the confirmation was declined.")));
      return;
    }
    atlasRecord("bad", tx("project not disconnected"), `${projectId}: ${response.error?.reasonCode || response.error?.code}`);
    result.replaceChildren(noteBlock("error", [mountRefusalText(response.error),
      gatewayPauseText(response.gateway)].filter(Boolean).join(" ")));
  }, { primary: true }));
  body.append(actions, result);
}

/**
 * Connect a project from a package: the person chooses the package folder, the confirmation is
 * in a system window. done(ok) - so that the window it was connected from refreshes.
 */
async function atlasMountAway(projectId, status, done = null) {
  const chosen = await window.atlas.chooseWorkspace({ purpose: "package" });
  if (!chosen.ok) {
    atlasRecord("bad", tx("folder not chosen"), chosen.error.reasonCode || chosen.error.code);
    return;
  }
  if (!chosen.data.chosen) return;
  await flushPending();
  status.replaceChildren(el("div", "muted", tx("Connecting {projectId}…", { projectId })));
  const response = await window.atlas.mountProject({ selectionId: chosen.data.selectionId, projectId });
  if (response.ok) {
    atlasRecord("ok", tx("project connected to this PC"), projectId);
    const missing = response.data.workspace === "missing"
      ? tx("Its folder is not on this PC: change it in the project's HQ (\"Change folder…\").") : null;
    status.replaceChildren(noteBlock("note", [tx("Project \"{projectId}\" is on this PC again.", { projectId }), missing,
      gatewayPauseText(response.data.gateway)].filter(Boolean).join(" ")));
    refreshAwayProjects();
    refreshArchiveCount();
    await refresh();
    if (done) await done(true);
    return;
  }
  if (response.error?.code === "user_declined") {
    status.replaceChildren();
    return;
  }
  atlasRecord("bad", tx("project not connected"), `${projectId}: ${response.error?.reasonCode || response.error?.code}`);
  status.replaceChildren(noteBlock("error", [mountRefusalText(response.error), gatewayPauseText(response.gateway)]
    .filter(Boolean).join(" ")));
}

/** The lines about a project not on this PC: where it is, where it may be kept, a summary without texts. */
function awayDetails(item) {
  const box = el("div");
  box.append(infoRow(tx("where it is now"), placeText(item.location)));
  box.append(infoRow(tx("may be kept"), policyText(item.policy)));
  box.append(infoRow(tx("summary"), summaryText(item.summary)));
  if (item.location?.atUtc) box.append(infoRow(tx("since when"), `${item.location.atUtc.slice(0, 16).replace("T", " ")} UTC`));
  if (item.archived) box.append(infoRow(tx("archive"), tx("project archived")));
  return box;
}

/** A grey frame on the map: the project is not on this PC. Only the summary and "Connect…". */
function atlasOpenAwayProject(projectId) {
  const item = awayProjectOf(projectId);
  if (item === null) return;
  const body = openSheet(tx("Not on this PC · {value}", { value: item.title ? `${projectId} · ${item.title}` : projectId }), tx("view only"));
  body.append(awayDetails(item));
  body.append(noteBlock("note", tx("The project's memory, conversations and tasks are not on this PC: only the summary is here. ")
    + tx("You cannot write to the project's agents or change it from here. A hidden frame comes back with its tick in \"Not on this PC\".")));
  body.append(awayCheck(tx("This project's frame on the map"), true, (on) => { setAwayShown(projectId, on); if (!on) closeSheet(); }));
  const status = el("div");
  const actions = el("div", "actions");
  actions.append(trustedButton(tx("Connect…"), () => atlasMountAway(projectId, status, async () => closeSheet())));
  body.append(actions, status);
}

/** A tick of the "Not on this PC" sheet: what this PC's map shows (not sent to the world). */
function awayCheck(label, checked, onChange) {
  const row = el("label", "check-row");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  row.append(input, el("span", null, label));
  return row;
}

/** A project's grey frame on this PC's map: shown, or hidden by the person. */
function setAwayShown(projectId, on) {
  const next = new Set(atlasState.ui.awayHidden ?? []);
  if (on) next.delete(projectId); else next.add(projectId);
  setPanel("awayHidden", [...next].sort());
  requestRender();
}

/** The list of the "Not on this PC" sheet from atlasState.away: map ticks, summary, "Connect…". */
function paintAwayList(list, status, reload) {
  const { projects } = atlasState.away;
  list.replaceChildren(el("div", "section-title", tx("Projects · {length}", { length: projects.length })));
  const repaint = () => paintAwayList(list, status, reload);
  const hidden = new Set(atlasState.ui.awayHidden ?? []);
  const hiddenHere = projects.filter((item) => hidden.has(item.projectId)).map((item) => item.projectId);
  if (projects.length === 0) list.append(el("div", "empty", tx("All the world's projects are on this PC.")));
  else {
    list.append(awayCheck(tx("Show grey frames of projects not on this PC on the map"), atlasState.ui.awayFrames !== false,
      (on) => { setPanel("awayFrames", on); requestRender(); repaint(); }));
  }
  if (hiddenHere.length > 0) {
    const restore = el("button", null, tx("Show hidden frames on the map ({length})", { length: hiddenHere.length }));
    restore.addEventListener("click", () => {
      setPanel("awayHidden", (atlasState.ui.awayHidden ?? []).filter((projectId) => !hiddenHere.includes(projectId)));
      if (atlasState.ui.awayFrames === false) setPanel("awayFrames", true);
      requestRender();
      repaint();
    });
    list.append(restore);
  }
  for (const item of projects) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title", item.title ? `${item.projectId} · ${item.title}` : item.projectId));
    box.append(awayDetails(item));
    const shown = awayCheck(tx("This project's frame on the map"), !hidden.has(item.projectId), (on) => {
      setAwayShown(item.projectId, on);
      repaint();
    });
    if (atlasState.ui.awayFrames === false) shown.querySelector("input").disabled = true;
    box.append(shown);
    box.append(trustedButton(tx("Connect…"), () => atlasMountAway(item.projectId, status, reload)));
    list.append(box);
  }
}

/**
 * The world's projects that are not on this PC. Only the name, place and summary are here -
 * memory, conversations and tasks are in a package or on another PC. "Connect…" takes
 * the package from a folder the person chooses.
 */
async function atlasOpenAwayProjects() {
  const body = openSheet(tx("Not on this PC"), tx("trusted action"));
  const status = el("div");
  const list = el("div");
  body.append(status, list, noteBlock("note",
    tx("These projects are not on this PC: their memory, conversations and tasks are in the project's package or on another PC; here are only ")
    + tx("the name, place and summary. On the map they are grey frames. To bring a project back, press \"Connect…\" and choose ")
    + tx("its package folder. The Gateway stops for that time and starts again.")));
  const render = async () => {
    list.replaceChildren(el("div", "muted", tx("Reading the list…")));
    const response = await window.atlas.awayProjects();
    if (!response.ok) {
      list.replaceChildren(noteBlock("error",
        tx("List not read: {value}.", { value: response.error?.reasonCode || response.error?.code || tx("no code") })));
      return;
    }
    atlasState.away = response.data;
    $("awayCount").textContent = String(response.data.projects.length);
    requestRender();
    paintAwayList(list, status, render);
  };
  await render();
}

// --- the world and projects between PCs (block 3) ---------------------------

atlasState.sync = { configured: false };

/** Whose world: by this PC's record, without the network. The full picture with repositories is in the sync window. */
function refreshSync() {
  if (typeof window.atlas?.syncStatus !== "function" || atlasState.trusted?.available !== true) return;
  window.atlas.syncStatus({ remote: false }).then((response) => {
    if (!response.ok) return;
    paintSyncToggle(response.data);
  });
}

function paintSyncToggle(view) {
  atlasState.sync = view;
  // The chip only in synced mode: in local mode work does not move between PCs.
  const configured = view.configured === true && view.mode !== "local";
  $("syncToggle").classList.toggle("hidden", !configured);
  if (configured) $("syncState").textContent = view.world.held ? tx("here") : tx("handed over");
  paintDataNotice();
}

const syncHolderText = (view, holder) => (holder === null || holder === undefined ? tx("nobody (free)")
  : holder === view.machine?.machineId ? tx("this PC") : tx("\"{name}\"", { name: view.machines?.[holder]?.title ?? holder }));

const SYNC_ACTION_TEXT = Object.freeze({
  released: tx("handed over"), "backed-up": tx("backed up, stays here"), taken: tx("app::taken"), "already-mounted": tx("already here"),
  "already-held": tx("already here"), initialized: tx("first push"),
});

/** Why a take or hand-over did not work - in words, by the refusal's code. */
function syncRefusalText(error) {
  const reason = error?.reasonCode || error?.code || tx("no code");
  const texts = {
    gateway_running: tx("The Gateway is running and could not be stopped. Stop it in the Gateway panel and try again."),
    sync_held_elsewhere: tx("Another PC holds it: press \"Hand over\" there first."),
    sync_not_holder: tx("This PC does not hold it: nothing to hand over."),
    sync_world_changed_here: tx("The world on this PC changed while it was handed over. Nothing was replaced; a copy of what is here, ")
      + tx("is kept in .project-local\\backups."),
    sync_local_changes: tx("The instance folder has changes the repository does not. Nothing was taken."),
    sync_diverged: tx("The history here and in the repository diverged. Nothing was taken."),
    sync_race: tx("Another PC was first. Refresh the state and try again."),
    sync_policy_denied: tx("This project may not be held on this PC (\"Where it is kept\")."),
    sync_remote_not_home: tx("The project is \"home only\", and one of its repositories is not at home. Nothing was pushed."),
    sync_workspace_not_pushed: tx("The project folder is not pushed to its repository: commit and push it, then try again."),
    sync_secret_found: tx("Something that looks like a secret was found in the files to push. The push was stopped."),
    sync_push_failed: tx("The repository did not take the push (no connection or no access). Nothing was lost, try again later."),
    sync_git_failed: tx("Git could not do a step (no connection or no access). Try again later."),
    sync_not_configured: tx("Sync is not set up on this PC (.project-local\\sync.json)."),
    sync_not_initialized: tx("The repository is still empty: first push from the PC that has everything."),
    unmount_interactions_open: tx("A project agent has a question or a permission request without an answer. Answer it and try again."),
    project_not_quiescent: tx("A project agent is working now. Wait for the turn to end and try again."),
  };
  if (error?.code === "busy") return tx("The Gateway is busy with another action ({reason}). Try again when it is over.", { reason });
  return texts[reason] ?? tx("app::Not done: {reason}.", { reason });
}

async function atlasOpenSync() {
  const body = openSheet(tx("Sync between PCs"), tx("trusted action"));
  const list = el("div");
  const result = el("div");
  body.append(list, result, noteBlock("note",
    tx("The world and projects work on one PC at a time. \"Hand over\" pushes them to their repositories and frees them for another PC, ")
    + tx("\"Take\" brings them here. A project that may be held only on this PC goes nowhere: on \"Hand over\" a backup goes to its ")
    + tx("repository. The Gateway runs only on the PC that has the world.")));
  const change = async (kind, target) => {
    await flushPending();
    result.replaceChildren(noteBlock("note", kind === "take" ? tx("Taking: repositories, then connecting…") : tx("Handing over: export, then repositories…")));
    const response = await (kind === "take" ? window.atlas.syncTake : window.atlas.syncRelease)({ target });
    if (response.ok) {
      const data = response.data;
      const lines = data.steps.map((step) => tx("{target}: {action}", { target: step.target === "world" ? tx("world") : step.target, action: SYNC_ACTION_TEXT[step.action] ?? step.action }));
      for (const item of data.skipped) lines.push(tx("{projectId}: skipped ({value})", { projectId: item.projectId, value: item.reason === "sync_policy_denied" ? tx("not for this PC") : tx("held by another PC") }));
      for (const projectId of data.stayLocal) lines.push(tx("{projectId}: not synced, stays here", { projectId }));
      if (data.gateway?.started === true) lines.push(tx("Gateway started"));
      else if (kind === "release" && (target === "all" || target === "world")) lines.push(tx("Gateway stopped: world handed over"));
      atlasRecord("ok", kind === "take" ? tx("taken from another PC") : tx("handed over to another PC"), lines.join("; "));
      result.replaceChildren(noteBlock("note", lines.join(" · ")));
      await reloadLayoutFromDisk(kind === "take" ? tx("after \"Take\"") : tx("after \"Hand over\""));
      await refresh();
      refreshAwayProjects();
    } else if (response.error?.code === "user_declined") {
      result.replaceChildren(noteBlock("note", tx("Nothing was done: the confirmation was declined.")));
    } else {
      atlasRecord("bad", kind === "take" ? tx("not taken") : tx("not handed over"), response.error?.reasonCode || response.error?.code);
      result.replaceChildren(noteBlock("error", syncRefusalText(response.error)));
    }
    await render();
  };
  const render = async () => {
    list.replaceChildren(el("div", "muted", tx("Reading the state and repositories…")));
    const response = await window.atlas.syncStatus({ remote: true });
    if (!response.ok) {
      list.replaceChildren(noteBlock("error", tx("State not read: {value}.", { value: response.error?.reasonCode || response.error?.code || tx("no code") })));
      return;
    }
    const view = response.data;
    paintSyncToggle(view);
    if (!view.configured || view.mode === "local") {
      list.replaceChildren(noteBlock("note", view.mode === "local"
        ? tx("The instance is in local mode: the world and projects do not move between PCs (agents-factory instance mode).")
        : tx("Sync is not set up on this PC (.project-local\\sync.json).")));
      return;
    }
    const unreachable = view.world.remote?.reachable === false ? tx(" · the world's repository is unreachable") : "";
    list.replaceChildren(infoRow(tx("this PC"), view.machine?.title ?? view.machine?.machineId ?? tx("no name")),
      infoRow(tx("world"), tx("{where} · held by: {holder}", { where: view.world.held ? tx("here") : tx("not here"),
        holder: syncHolderText(view, view.world.remote?.holder ?? (view.world.held ? view.machine?.machineId : null)) })
        + unreachable),
      el("div", "section-title", tx("Projects · {length}", { length: view.projects.length })));
    for (const item of view.projects) {
      const box = el("div", "entry");
      box.append(el("div", "entry-title", item.projectId));
      box.append(el("div", "muted", [
        item.mounted ? tx("on this PC") : tx("not here"),
        !item.configured ? tx("not synced") : item.onlyHere ? tx("this PC only: \"Hand over\" makes a backup")
          : item.mayHold ? tx("held by: {value}", { value: syncHolderText(view, item.remote?.holder ?? (item.held ? view.machine?.machineId : null)) })
            : tx("not for this PC"),
      ].join(" · ")));
      if (item.configured && item.mounted) {
        box.append(trustedButton(item.onlyHere ? tx("Back up…") : tx("Hand over…"), () => change("release", item.projectId)));
      }
      if (item.configured && !item.mounted && item.mayHold && view.world.held) {
        box.append(trustedButton(tx("Take…"), () => change("take", item.projectId)));
      }
      list.append(box);
    }
    const actions = el("div", "actions");
    if (view.world.held) actions.append(trustedButton(tx("Hand over all…"), () => change("release", "all"), { primary: true }));
    else actions.append(trustedButton(tx("Take all…"), () => change("take", "all"), { primary: true }));
    list.append(actions);
  };
  await render();
}

/** Why the folder was not bound or changed - in words, by the refusal's code. */
function bindRefusalText(projectId, error) {
  const reason = error?.reasonCode || error?.code || tx("no code");
  if (reason === "memory_workspace_conflict") {
    return tx("Project {projectId} is already bound to another folder. The folder is shown in the project HQ; you can change it ", { projectId })
      + tx("there too.");
  }
  if (reason === "memory_workspace_in_use") {
    return tx("The folder of project {projectId} is held by its agents. It cannot be changed.", { projectId });
  }
  const texts = {
    rebind_project_busy: tx("An agent of project {projectId} is working now. Wait for the turn to end and try again.", { projectId }),
    gateway_running: tx("The Gateway is running and could not be stopped. Stop it in the Gateway panel and try again."),
    rebind_folder_missing: tx("The chosen folder is not on the disk."),
    rebind_session_elsewhere: tx("One agent's session was not recorded in the project's old folder. Nothing was changed."),
    rebind_provider_folder_unknown: tx("The provider's folder of the agent's sessions was not found. Nothing was changed."),
    rebind_target_exists: tx("The new place already has sessions with the same names. Nothing was changed."),
    rebind_contention: tx("The project's agent list changed during the move. The move was cancelled, try again."),
  };
  if (error?.code === "busy") return tx("The Gateway is busy with another action ({reason}). Try again when it is over.", { reason });
  return texts[reason] ?? tx("app::Not done: {reason}.", { reason });
}

/**
 * The project's agents and the folder (R36): who already worked in it (their conversations and sessions
 * move with the binding), who is bound to it (an open agent or
 * one that worked: then the Gateway stops for the change, as the backend decides in
 * project-rebind.mjs) and who works right now (while it works, the folder cannot
 * be changed). null - the world is not read yet.
 */
function folderHolders(projectId) {
  const world = atlasState.world;
  const project = world?.status === "ready"
    ? world.projection.projects.find((item) => item.projectId === projectId) ?? null : null;
  if (project === null) return null;
  const agents = project.quarters.flatMap((quarter) => quarter.agents);
  const worked = (agent) => (agent.lastOperation ?? null) !== null;
  return {
    worked: agents.filter(worked),
    bound: agents.filter((agent) => agent.state !== "archived" || worked(agent)),
    busy: agents.filter((agent) => agent.currentOperationId),
  };
}

/**
 * Another folder for the project (R36): the choice, both folders in view, the confirmation.
 * If the agents already worked, their conversations and sessions move with the
 * binding; the person moves the project's files.
 */
async function rebindFolder(projectId, current) {
  const chosen = await window.atlas.chooseWorkspace();
  if (!chosen.ok) {
    atlasRecord("bad", tx("folder not chosen"), chosen.error.reasonCode || chosen.error.code);
    return;
  }
  if (!chosen.data.chosen) return;
  const holders = folderHolders(projectId);
  const worked = (holders?.worked ?? []).length > 0;
  const bound = (holders?.bound ?? []).length > 0;
  const body = openSheet(tx("Folder change · {projectId}", { projectId }),
    worked ? tx("with the agents' sessions moved") : bound ? tx("the agents have not worked yet") : tx("no agents yet"));
  body.append(infoRow(tx("now"), current));
  body.append(infoRow(tx("will be"), chosen.data.displayPath));
  body.append(noteBlock("note", worked
    ? tx("The project's agents already worked in the old folder: their conversations and sessions move with the binding, and in the new ")
      + tx("folder they go on from the same place. Atlas does not move the project's files: move them to the new folder yourself. ")
      + tx("The Gateway stops for the move and starts again.")
    : bound
      ? tx("The project's agents have not worked yet: they have no conversations or sessions; with the binding only the agents' ")
        + tx("folder changes. The Gateway stops for that time and starts again. Files of the old folder are not moved.")
      : tx("The project has no agents yet: only the binding changes. Files of the old folder are not moved.")));
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(trustedButton(tx("Change with confirmation"), async () => {
    await flushPending();
    const response = await window.atlas.rebindWorkspace({ projectId, selectionId: chosen.data.selectionId });
    if (response.ok) {
      atlasRecord("ok", tx("project folder changed"), `${projectId} · ${chosen.data.displayPath}`);
      result.replaceChildren(noteBlock("note", [tx("Changed: the project works in the folder {displayPath}.", { displayPath: chosen.data.displayPath }),
        gatewayPauseText(response.data.gateway)].filter(Boolean).join(" ")));
      await refresh();
    } else if (response.error.code === "user_declined") {
      result.replaceChildren(noteBlock("note", tx("app::Not changed: the confirmation was declined.")));
    } else {
      atlasRecord("bad", tx("project folder not changed"), response.error.reasonCode || response.error.code);
      result.replaceChildren(noteBlock("error", [bindRefusalText(projectId, response.error),
        gatewayPauseText(response.gateway)].filter(Boolean).join(" ")));
    }
  }, { primary: true }));
  body.append(actions, result);
}

/** Whether the bound folder can be changed now (R36): not only while a project agent works. */
function folderHold(box, projectId, path) {
  const holders = folderHolders(projectId);
  if (holders === null) {
    box.replaceChildren();
    return;
  }
  if (holders.busy.length > 0) {
    box.replaceChildren(noteBlock("note", tx("The folder cannot be changed now: working is ")
      + tx("{value}. Wait for the turn to end.", { value: holders.busy.map((agent) => agent.agentId).join(", ") })));
    return;
  }
  const actions = el("div", "actions");
  actions.append(trustedButton(tx("Change folder…"), () => rebindFolder(projectId, path)));
  box.replaceChildren(noteBlock("note", holders.worked.length > 0
    ? tx("The project's agents already worked in this folder. It can be changed: their conversations and sessions move with ")
      + tx("the binding, and the project's files you move yourself.")
    : holders.bound.length > 0
      ? tx("The project's agents have not worked in this folder yet: it can be changed, the Gateway stops for that time.")
      : tx("The project has no agents yet: the folder can be changed.")), actions);
}

/**
 * Project folder: which folder it is bound to - or a “Bind” button if there is no folder
 * yet. The path is read by the trusted host of this window (the Gateway does not give out paths).
 */
function projectFolderSection(body, projectId) {
  const box = el("div");
  box.append(infoRow(tx("project folder"), tx("checking…")));
  body.append(box);
  if (typeof window.atlas?.projectFolder !== "function" || atlasState.trusted?.available !== true) {
    box.replaceChildren(infoRow(tx("project folder"), tx("not checked: trusted actions unavailable")));
    return;
  }
  window.atlas.projectFolder({ projectId }).then((response) => {
    if (!response.ok) {
      box.replaceChildren(infoRow(tx("project folder"),
        tx("not checked: {value}", { value: response.error?.reasonCode || response.error?.code || tx("no code") })));
      return;
    }
    if (response.data.configured) {
      const path = response.data.workspacePath;
      box.replaceChildren(infoRow(tx("project folder"), path));
      if (!response.data.available) {
        box.append(noteBlock("error", tx("This folder is no longer on disk: the project agents cannot work in it ")
          + tx("until it is back in place.")));
      }
      const hold = el("div");
      box.append(hold);
      folderHold(hold, projectId, path);
      return;
    }
    box.replaceChildren(infoRow(tx("project folder"), tx("not bound")));
    const actions = el("div", "actions");
    actions.append(trustedButton(tx("Bind folder…"), () => bindFolder(projectId), { primary: true }));
    box.append(actions);
  });
}

async function bindFolder(projectId) {
  const chosen = await window.atlas.chooseWorkspace();
  if (!chosen.ok) {
    atlasRecord("bad", tx("folder not chosen"), chosen.error.reasonCode || chosen.error.code);
    return;
  }
  if (!chosen.data.chosen) return;
  const body = openSheet(tx("Folder binding · {projectId}", { projectId }), tx("irreversible"));
  body.append(infoRow(tx("chosen folder"), chosen.data.displayPath));
  body.append(noteBlock("note",
    tx("The binding is permanent: it cannot be changed later. All quarters of the project work in this folder.")));
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(trustedButton(tx("Bind with confirmation"), async () => {
    const response = await window.atlas.bindWorkspace({ projectId, selectionId: chosen.data.selectionId });
    if (response.ok) {
      atlasRecord("ok", tx("folder bound"), `${projectId} · ${chosen.data.displayPath}`);
      result.replaceChildren(noteBlock("note", tx("Bound: the project works in the folder {displayPath}.", { displayPath: chosen.data.displayPath })));
    } else if (response.error.code === "user_declined") {
      result.replaceChildren(noteBlock("note", tx("Not bound: the confirmation was declined.")));
    } else {
      atlasRecord("bad", tx("folder not bound"), response.error.reasonCode || response.error.code);
      result.replaceChildren(noteBlock("error", bindRefusalText(projectId, response.error)));
    }
  }, { primary: true }));
  body.append(actions, result);
}

// “default” passes no level: Claude Code uses the default level of
// the chosen model. The other levels are shown the way Claude Code names them.
const EFFORT_LABELS = Object.freeze({ default: tx("default — the default level of the model") });

function profileSelect(entries) {
  const select = el("select", "field");
  for (const [value, label] of entries) {
    const option = el("option", null, label);
    option.value = value;
    select.append(option);
  }
  return select;
}

/**
 * A profile from the lists the backend sent: the Gateway provider, its models and
 * the reasoning levels of the chosen model. The backend accepts no other values, so
 * they can be neither typed nor chosen. Returns a reader of the chosen profile.
 */
function renderProfileLists(box, catalog) {
  // The Gateway may run agents of several providers (Claude Code and DeepSeek Harness):
  // models show only for the chosen provider.
  const providers = catalog.providers ?? [{ provider: catalog.provider, models: catalog.models }];
  const provider = profileSelect(providers.map((item) => [item.provider.profileProvider, item.provider.label]));
  const model = el("select", "field");
  const modelsOf = () => (providers.find((item) => item.provider.profileProvider === provider.value) ?? providers[0]).models;
  const fillModels = () => {
    model.replaceChildren(...modelsOf().map((item) => {
      const option = el("option", null, `${item.name} · ${item.id}${modelStateSuffix(item.id)}`);
      option.value = item.id;
      return option;
    }));
    fillEfforts();
  };
  const effort = el("select", "field");
  const effortNote = el("div", "muted");
  const fillEfforts = () => {
    const chosen = modelsOf().find((item) => item.id === model.value) ?? modelsOf()[0];
    effort.replaceChildren(...chosen.efforts.map((value) => {
      const option = el("option", null, EFFORT_LABELS[value] ?? value);
      option.value = value;
      return option;
    }));
    effort.value = chosen.defaultEffort;
    effortNote.textContent = chosen.efforts.length === 1 && chosen.efforts[0] === "default"
      ? tx("This model does not support choosing a reasoning effort.")
      : "";
  };
  model.addEventListener("change", fillEfforts);
  provider.addEventListener("change", fillModels);
  fillModels();
  box.replaceChildren(
    el("div", "section-title", tx("Provider")), provider,
    el("div", "section-title", tx("Model")), model,
    el("div", "section-title", tx("Reasoning effort")), effort, effortNote,
    noteBlock("note", tx("The providers, models and levels came from the backend: these are the lists of the controller's claude-provider.json ")
      + (providers.length > 1 ? tx("and acp-provider.json ") : "") + tx("by which it checks a new agent's profile.")
      + (providers.length > 1 ? tx(" An agent of any provider may take any role.") : tx(" One provider — the one the Gateway runs on."))
      + (catalog.complete ? "" : tx(" The backend sent only part of the list."))),
  );
  return () => ({ provider: provider.value, model: model.value, reasoningEffort: effort.value });
}

/** The old input fields: in prototype modes where the backend sends no model list. */
function renderProfileFields(box, failure) {
  // On Paperclip the provider is the adapter (claude, codex or the full adapter
  // type), the model is its identifier at the provider, the effort is default, low,
  // medium, high, xhigh or max. When working with Claude Code directly, there is one provider.
  const onDirect = atlasState.info?.mode === "direct";
  const onPaperclip = atlasState.info?.mode === "paperclip" || onDirect;
  const provider = el("input");
  provider.value = "claude";
  provider.placeholder = tx("provider");
  const model = el("input");
  model.value = onPaperclip ? "claude-sonnet-5" : "claude-sonnet-5-5";
  model.placeholder = tx("model");
  const effort = el("input");
  effort.value = "default";
  effort.placeholder = tx("effort");
  box.replaceChildren(
    el("div", "section-title", onPaperclip ? tx("Profile: provider, model, effort") : tx("Profile from the catalog")),
    provider, model, effort,
    noteBlock("note", onDirect
      ? tx("Provider: claude. The model and effort are passed to Claude Code as is; “default” leaves the choice to Claude Code.")
      : onPaperclip
      ? tx("Provider: claude or codex. The model and effort are passed to the Paperclip adapter as is; “default” leaves the choice to the adapter. The project folder must be bound before the agent is created.")
      : tx("The backend did not send the model list ({value}). ", { value: failure?.reasonCode || failure?.code || tx("no code") })
        + tx("The profile must be declared by the backend catalog; switching to another model is not allowed.")),
  );
  return () => ({
    provider: provider.value.trim(), model: model.value.trim(), reasoningEffort: effort.value.trim(),
  });
}

const LEAD_WORDS = Object.freeze({
  "project-lead": { title: tx("Project lead"), hint: tx("Responsible for the whole project: knows its memory, quarters and the agents in them ")
    + tx("(the role and model of each). You talk to it about the project as a whole. It can change the whole project folder, ")
    + tx("so while it works, the other agents of this folder wait.") },
  "quarter-lead": { title: tx("Quarter lead"), hint: tx("Responsible for the quarter: knows its memory and the agents of the quarter ")
    + tx("(role, model, write zone). You talk to it about the quarter as a whole. It can change the zones of the agents of its ")
    + tx("quarter and docs/memory/.") },
});

/**
 * A new agent. With `role` it is a project lead (in the HQ's service quarter)
 * or a quarter lead: right after creation it gets its role, and its chat opens.
 */
async function openCreateAgentSheet(projectId, quarterId, { role = null } = {}) {
  const lead = LEAD_WORDS[role] ?? null;
  const body = openSheet(lead === null ? tx("New agent · {quarterId}", { quarterId })
    : `${lead.title} · ${role === "project-lead" ? projectId : quarterId}`, tx("backend operation"));
  if (lead !== null) body.append(noteBlock("note", lead.hint));
  const agentId = identifierField(tx("agent identifier"), { taken: agentIdTaken });
  // The default lead name is the first free one: a previous lead may have been archived under the same name.
  if (lead !== null) agentId.set(freeAgentId(`${role === "project-lead" ? projectId : quarterId}-lead`));
  const naming = nameAndIdFields(agentId, tx("agent name"), (candidate) => agentNamed(candidate) !== null);
  body.append(el("div", "section-title", tx("Name")), naming.input,
    el("div", "section-title", tx("ID (does not change)")), agentId.input, agentId.hint);
  const profileBox = el("div");
  profileBox.append(el("div", "muted", tx("Reading the model list from the backend…")));
  body.append(profileBox);
  const catalog = await window.atlas.models();
  const readProfile = catalog.ok
    ? renderProfileLists(profileBox, catalog.data)
    : renderProfileFields(profileBox, catalog.error);
  const linksBox = el("div");
  body.append(el("div", "section-title", tx("Agent links")), linksBox);
  const result = el("div");
  const actions = el("div", "actions");
  const canCreate = operationStatus("mutation.memory.agent.create")?.status === "available";
  const create = actionButton(tx("Create"), "mutation.memory.agent.create", async () => {
    const problem = agentId.problem();
    if (problem !== null) {
      result.replaceChildren(noteBlock("error", problem));
      return;
    }
    create.disabled = true;
    const newAgentId = agentId.input.value.trim();
    const response = await window.atlas.createAgent({
      agentId: newAgentId, projectId, quarterId, profile: readProfile(),
    });
    create.disabled = false;
    showCreateOutcome(result, "agent", newAgentId, response);
    if (describeCreateOutcome("agent", "", response).reread) await refresh();
    // Created — the form has done its job: it closes, and the agent itself opens,
    // the one you now work with. On a refusal or an unknown outcome the form
    // stays with an explanation.
    if (response.ok) {
      const node = { kind: "agent", projectId, quarterId, agentId: newAgentId };
      await nameCreated(result, "agent", projectId, newAgentId, naming.name());
      if (lead !== null) {
        // The role is set right after creation: the agent has not started working yet.
        const assigned = await window.atlas.setAgentRole({ agentId: newAgentId, role, expectedRevision: 0 });
        if (!assigned.ok) {
          const reason = assigned.error?.reasonCode || assigned.error?.code || tx("no code");
          result.append(noteBlock("error", reason === "memory_role_taken"
            ? tx("The agent is created, but the role is not assigned: the {value} already has a lead.", { value: role === "project-lead" ? tx("app::project") : tx("app::quarter") })
            : tx("The agent is created, but the role is not assigned: {reason}.", { reason })));
          await refresh();
          return;
        }
        atlasRecord("ok", lead.title.toLowerCase(), newAgentId);
        await refresh();
      }
      if (findNode(node).agent !== null) {
        closeSheet();
        atlasOpenWorkspace(node);
      }
    }
  }, { primary: true });
  actions.append(create);
  body.append(actions, result);

  // The agent lives in this project and quarter: its links are the project memory, the quarter
  // memory and the project folder (Claude Code works in it). They are checked
  // here, when the form opens, rather than discovered by a refusal during creation;
  // the button is available when all of them are in place.
  const checkLinks = async () => {
    const { project, quarter } = findNode({ kind: "quarter", projectId, quarterId, agentId: null });
    const projectMemory = project?.memory?.scopeId ?? null;
    const quarterMemory = quarter?.memory?.scopeId ?? null;
    linksBox.replaceChildren(el("div", "muted", tx("Checking links…")));
    const files = await window.atlas.projectFiles({ projectId, path: "" });
    const folder = files.ok ? "bound"
      : files.error?.reasonCode === "workspace_not_bound" ? "unbound" : "unknown";
    const rows = [
      infoRow(tx("project memory"), projectMemory === null ? tx("no") : tx("yes · {projectMemory}", { projectMemory })),
      infoRow(tx("quarter memory"), quarterMemory === null ? tx("no") : tx("yes · {quarterMemory}", { quarterMemory })),
      infoRow(tx("project folder"), folder === "bound" ? tx("bound")
        : folder === "unbound" ? tx("not bound")
        : tx("not checked: {value}", { value: files.error?.reasonCode || files.error?.code || tx("no code") })),
    ];
    linksBox.replaceChildren(...rows);
    if (folder === "unbound") {
      linksBox.append(noteBlock("error",
        tx("A Claude Code agent works in the project folder, and it is not bound. Bind the folder — the binding is permanent.")));
      const bind = trustedButton(tx("Bind folder…"), async () => {
        const chosen = await window.atlas.chooseWorkspace();
        if (!chosen.ok || !chosen.data.chosen) return;
        const bound = await window.atlas.bindWorkspace({ projectId, selectionId: chosen.data.selectionId });
        if (bound.ok) {
          atlasRecord("ok", tx("folder bound"), projectId);
          await checkLinks();
        } else if (bound.error?.code !== "user_declined") {
          linksBox.append(noteBlock("error", bindRefusalText(projectId, bound.error)));
        }
      }, { primary: true });
      const row = el("div", "actions");
      row.append(bind);
      linksBox.append(row);
    }
    const ready = projectMemory !== null && quarterMemory !== null && folder === "bound";
    if (canCreate) {
      create.disabled = !ready;
      create.title = ready ? "" : tx("All agent links are needed first");
    }
  };
  await checkLinks();
}

/**
 * The creation receipt under the form: target, host operation, outcome. After a success and
 * after an unknown outcome the world is reread; an unknown outcome is not retried.
 */
function showCreateOutcome(result, kind, targetId, response) {
  const described = describeCreateOutcome(kind, targetId, response);
  result.replaceChildren(outcomeBlock(described));
  atlasRecord(described.tone === "note" ? "ok" : "bad", tx("creation"), [described.title, ...described.details].join(" "));
}

function openCreateScopeSheet(kind, projectId) {
  const body = openSheet(kind === "project" ? tx("New project") : tx("New quarter · {projectId}", { projectId }),
    tx("backend operation"));
  // “world” - the service project of the World HQ: an ordinary project cannot have this name.
  const idField = identifierField(kind === "project" ? tx("project identifier") : tx("quarter identifier"),
    { taken: kind === "project" ? (value) => (value === WORLD_PROJECT
      ? tx("The name “world” is taken: it is the name of the World HQ's service project.") : null) : null });
  const naming = nameAndIdFields(idField, kind === "project" ? tx("project name") : tx("quarter name"),
    (candidate) => (kind === "project" ? projectOf(candidate) !== null
      : projectOf(projectId)?.quarters.some((quarter) => quarter.quarterId === candidate) === true));
  body.append(el("div", "section-title", tx("Name")), naming.input,
    el("div", "section-title", tx("ID (does not change)")), idField.input, idField.hint);
  body.append(noteBlock("note", tx("{value} is created at once, without ", { value: kind === "project" ? tx("The project") : tx("The quarter") })
    + tx("confirmation, with empty memory. One you do not need goes to the archive (with confirmation) and comes back from there intact.")));
  const result = el("div");
  const actions = el("div", "actions");
  actions.append(actionButton(tx("Create"),
    "mutation.memory.scope.create", async () => {
    const problem = idField.problem();
    if (problem !== null) {
      result.replaceChildren(noteBlock("error", problem));
      return;
    }
    const newId = idField.input.value.trim();
    const title = naming.name() || newId;
    const response = await window.atlas.createScope(kind === "project"
      ? { kind: "project", projectId: newId, title }
      : { kind: "quarter", projectId, quarterId: newId, title });
    showCreateOutcome(result, kind, newId, response);
    if (response.ok) await nameCreated(result, kind, kind === "project" ? newId : projectId, newId, naming.name());
    if (describeCreateOutcome(kind, "", response).reread) await refresh();
  }, { primary: true }));
  body.append(actions, result);
}

// --- context menu -------------------------------------------------------------

function atlasOpenContextMenu(node, point) {
  const menu = $("contextMenu");
  menu.replaceChildren();
  const add = (label, handler, enabled = true) => {
    const button = el("button", null, label);
    button.disabled = !enabled;
    button.addEventListener("click", () => {
      menu.classList.add("hidden");
      handler();
    });
    menu.append(button);
  };
  const canScope = operationStatus("mutation.memory.scope.create")?.status === "available";
  const canAgent = operationStatus("mutation.memory.agent.create")?.status === "available";
  const canRead = operationStatus("query.memory.scope.read")?.status === "available";
  const hasClipboard = atlasState.clipboard !== null && atlasState.clipboard !== undefined;
  // An attention badge behaves like the object behind it, plus a separate
  // item with the list of requests.
  const badge = node !== null && node.kind === "attention" ? node : null;
  if (badge !== null) {
    node = {
      kind: badge.scopeKind, projectId: badge.projectId,
      quarterId: badge.quarterId, agentId: badge.agentId,
    };
  }
  const { project, quarter } = node === null || node.kind === "away" ? { project: null, quarter: null } : findNode(node);
  if (badge !== null) add(tx("Attention list · {length}", { length: attentionItemsFor(badge).length }), () => atlasOpenAttention(badge));
  // The menu opens for the object under the cursor, at any zoom:
  // the choice of target does not depend on how far the person has zoomed in.
  const copyHere = () => {
    selectNode(node);
    atlasCopyBlueprint();
  };

  const canArchive = atlasState.trusted.available === true;
  const worldLead = worldLeadOf();
  if (node === null) {
    add(tx("Create project…"), () => openCreateScopeSheet("project", null), canScope);
    add(tx("Paste blueprint"), () => atlasPasteBlueprint(), hasClipboard);
    add(tx("app::Archive…"), () => atlasOpenProjectArchive(), canArchive);
    add(tx("History of changes…"), () => atlasOpenHistory(), canArchive);
    if (atlasState.away.split === true) add(tx("Not on this PC…"), () => atlasOpenAwayProjects(), canArchive);
    add(tx("World HQ"), () => atlasOpenWorldHeadquarters());
    add(tx("Whole world"), () => goLevel(LEVEL.world));
  } else if (node.kind === "away") {
    // Grey frame: the project is not on this PC; you can only see its summary and connect it.
    add(tx("Summary and connect…"), () => atlasOpenAwayProject(node.projectId), canArchive);
    add(tx("Not on this PC…"), () => atlasOpenAwayProjects(), canArchive);
  } else if (node.kind === "world") {
    add(tx("World HQ"), () => atlasOpenWorldHeadquarters());
    if (worldLead !== null) {
      add(tx("World lead chat"), () => atlasOpenWorkspace(leadNode(worldLead), { camera: false }));
    } else {
      add(tx("Create world lead…"), () => openCreateWorldLeadSheet(), canAgent && canArchive);
    }
    add(tx("Whole world"), () => goLevel(LEVEL.world));
  } else if (node.kind === "project" || node.kind === "hq") {
    add(tx("Project HQ"), () => atlasOpenHeadquarters(node.projectId));
    add(tx("Enter project"), () => atlasEnterProject(node.projectId));
    add(tx("Project memory"), () => openMemorySheet(project.memory.scopeId,
      tx("Project memory · {projectId}", { projectId: node.projectId })), canRead && project !== null);
    add(tx("Create quarter…"), () => openCreateScopeSheet("quarter", node.projectId), canScope);
    add(tx("Copy blueprint (Ctrl+C)"), copyHere);
    add(tx("Paste blueprint (Ctrl+V)"), () => atlasPasteBlueprint(), hasClipboard);
    add(tx("Fit bounds"), () => sceneCompactProject(node.projectId));
    add(tx("Rename…"), () => openRenameSheet("project", node.projectId, node.projectId), canArchive);
    add(tx("History of the project…"), () => atlasOpenHistory(node.projectId), canArchive);
    add(tx("Archive project…"), () => atlasArchiveProject(node.projectId), canArchive);
    if (atlasState.away.split === true && node.projectId !== WORLD_PROJECT) {
      add(tx("Disconnect from this PC…"), () => atlasUnmountProject(node.projectId), canArchive);
    }
  } else if (node.kind === "quarter") {
    add(tx("Enter quarter"), () => atlasEnterQuarter(node.projectId, node.quarterId));
    add(tx("Create quarter lead…"), () => openCreateAgentSheet(node.projectId, node.quarterId,
      { role: "quarter-lead" }), canAgent && leadOf(node.projectId, node.quarterId) === null);
    add(tx("Quarter memory"), () => openMemorySheet(quarter.memory.scopeId,
      tx("Quarter memory · {quarterId}", { quarterId: node.quarterId })), canRead && quarter !== null);
    add(tx("Create agent…"), () => openCreateAgentSheet(node.projectId, node.quarterId), canAgent);
    add(tx("Copy blueprint (Ctrl+C)"), copyHere);
    add(tx("Paste blueprint (Ctrl+V)"), () => atlasPasteBlueprint(), hasClipboard);
    add(tx("Fit project bounds"), () => sceneCompactProject(node.projectId));
    add(tx("Rename…"), () => openRenameSheet("quarter", node.projectId, node.quarterId), canArchive);
    add(tx("Archive quarter…"), () => atlasArchiveQuarter(node.projectId, node.quarterId), canArchive);
  } else {
    const canClose = operationStatus("mutation.memory.agent.close")?.status === "available";
    add(tx("Agent workspace"), () => atlasOpenWorkspace(node));
    add(tx("Agent skills"), () => atlasOpenSkills(node));
    add(tx("Show in inspector"), () => selectNode(node));
    // Only while it applies: an open agent, not the world lead, not yet recorded as a task source.
    const agent = findNode(node).agent;
    if (agent !== null && deskRegistrationState(agent, boardForState()).offer && canArchive) {
      add(tx("Take tasks (desk agent)…"), () => openDeskAgentSheet(agent));
    }
    add(tx("Copy blueprint (Ctrl+C)"), copyHere);
    add(tx("Paste blueprint (Ctrl+V)"), () => atlasPasteBlueprint(), hasClipboard);
    add(tx("Rename…"), () => openRenameSheet("agent", node.projectId, node.agentId), canArchive);
    add(tx("Archive agent…"), () => atlasArchiveAgent(node.agentId), canClose);
  }
  menu.classList.remove("hidden");
  const stage = $("mapStage").getBoundingClientRect();
  menu.style.left = `${Math.min(point.x - stage.left, stage.width - 230)}px`;
  menu.style.top = `${Math.min(point.y - stage.top, stage.height - 160)}px`;
}

function atlasEscape() {
  if (!$("sheet").classList.contains("hidden")) {
    closeSheet();
    return;
  }
  if (!$("contextMenu").classList.contains("hidden")) {
    $("contextMenu").classList.add("hidden");
    return;
  }
  if (atlasState.ui.attentionOpen) {
    setPanel("attentionOpen", false);
    return;
  }
  if (!$("readinessPanel").classList.contains("hidden")) {
    closeReadiness();
    return;
  }
  if (!$("workspace").classList.contains("hidden")) {
    closeWorkspace();
    return;
  }
  if (scene.selection !== null) {
    selectNode(null);
    return;
  }
  goLevel(Math.min(LEVEL.world, sceneLevel() + 1));
}

// --- reading ------------------------------------------------------------------

async function refresh({ silent = false } = {}) {
  if (atlasState.busy) return;
  atlasState.busy = true;
  $("refresh").disabled = true;
  try {
    const [info, runtime, connection, trusted] = await Promise.all([
      window.atlas.appInfo(), window.atlas.runtime(), window.atlas.connection({ force: true }),
      window.atlas.trusted(),
    ]);
    atlasState.info = info.ok ? info.data : null;
    atlasState.runtime = runtime.ok ? runtime.data : null;
    // "Refresh" asks Claude Code again at once; the live view - no more often than the answer is kept.
    loadClaudeAccount({ force: !silent });
    // The Claude account is checked in the background when the desktop opens: reread when the answer arrives.
    const account = claudeAccountOf();
    if (account !== null && account.state === "checking" && atlasState.accountTimer === undefined) {
      atlasState.accountTimer = setTimeout(() => { atlasState.accountTimer = undefined; refresh({ silent: true }); }, 2500);
    } else if (account !== null && account.state === "known" && atlasState.accountSeen !== account.email) {
      atlasState.accountSeen = account.email;
      atlasRecord("ok", tx("app::Claude account"), [account.email, account.organization].filter(Boolean).join(" · ") || tx("no email"));
    }
    atlasState.trusted = trusted.ok ? trusted.data : { available: false, reasonCode: "host_error" };
    if (atlasState.trusted.acl === "not-hardened") {
      showNotice(tx("Permissions of the input files directory are not hardened — see the journal"));
      atlasRecord("bad", tx("directory permissions not hardened"), atlasState.trusted.aclReasonCode ?? "");
    }

    const previous = atlasState.connection;
    atlasState.connection = connection.ok ? connection.data : { available: false, error: connection.error };
    // A new descriptor of the same instance means the connection was renewed, not
    // restarted: what is open stays open. A restart is a different instance.
    const change = connectionChange(previous, atlasState.connection);
    if (change === "restarted") {
      atlasRecord("bad", tx("Gateway restarted"),
        tx("generation {generation}: everything reread, nothing replayed", { generation: atlasState.connection.generation }));
      closeSheet();
      closeWorkspace({ keepDraft: true });
    } else if (change === "renewed") {
      atlasRecord("ok", tx("connection renewed"),
        tx("same instance, generation {generation}; valid until {validUntilUtc}", { generation: atlasState.connection.generation, validUntilUtc: atlasState.connection.validUntilUtc }));
    } else if (change === "lost") {
      atlasRecord("bad", tx("connection lost"), tx("nothing open is closed; the data will be reread on recovery"));
    }

    if (atlasState.connection.available) {
      const operations = await window.atlas.operations({ force: true });
      atlasState.operations = operations.ok ? operations.data : [];
      await loadExpected();
      const world = await window.atlas.world({});
      atlasState.world = world.ok ? world.data : null;
      // Task board (desk agents, the world lead's tasks) - in the background and no more often than the TTL:
      // from it the agent menu knows whether to offer “Take tasks”.
      loadTaskBoard().then(() => requestRender());
      // The names of projects, quarters and agents - in the background too, no more often than their TTL.
      loadNames().then(() => requestRender());
      // The person already sees the answer of the agent whose conversation is open now.
      if (typeof isWorkspaceOpen === "function" && isWorkspaceOpen() && workspaceState.tab === "chat") {
        atlasMarkTurnSeen(workspaceState.node.agentId);
      }
    } else {
      atlasState.operations = [];
      atlasState.expected = null;
      atlasState.world = null;
    }

    const availability = atlasState.connection.available
      ? tx("connected · {projectId}", { projectId: atlasState.connection.projectId })
      : tx("unavailable · {value}", { value: atlasState.connection.error ? (atlasState.connection.error.reasonCode || atlasState.connection.error.code) : tx("app::unknown") });
    if (!silent || availability !== atlasState.lastAvailability) {
      atlasRecord(atlasState.connection.available ? "ok" : "bad", tx("read"), availability);
    }
    atlasState.lastAvailability = availability;

    renderHeader();
    renderAttention();
    sceneWorldUpdated();
    atlasOnHudChanged();
    // The inspector is redrawn only if it is on screen: when it opens, it
    // takes the place on the right, and in live view every refresh would close
    // the attention list or readiness right before the eyes of the person.
    if (scene.selection !== null && !$("inspector").classList.contains("hidden")) atlasOnSelection(scene.selection);
    if (!$("readinessPanel").classList.contains("hidden")) renderReadiness();
    atlasGatewayPanelRefresh();
    refreshWorkspace();
  } finally {
    atlasState.busy = false;
    $("refresh").disabled = false;
  }
}

function setWatch(on) {
  atlasState.watch = on;
  const button = $("watch");
  button.textContent = tx("Live: {value}", { value: on ? tx("on") : tx("off") });
  button.classList.toggle("primary", on);
  if (atlasState.watchTimer !== null) {
    clearInterval(atlasState.watchTimer);
    atlasState.watchTimer = null;
  }
  if (on) {
    atlasState.watchTimer = setInterval(() => {
      if (!atlasState.busy) refresh({ silent: true });
    }, 10000);
  }
  atlasRecord("info", on ? tx("live view on") : tx("live view off"),
    on ? tx("rereading every 10 seconds") : "");
  if (atlasState.ui.watch !== on) setPanel("watch", on);
}

// --- startup ------------------------------------------------------------------

async function start() {
  const uiState = await window.atlas.readUiState();
  if (uiState.ok) atlasState.ui = uiState.data;
  applyUiState();
  renderLog();

  await loadLayout();
  initScene();
  await refresh();
  // Live view is on until the person turns it off. An automatic snapshot
  // of the window (--capture) works with its own rereads and without it.
  if (atlasState.ui.watch !== false && atlasState.info?.automated !== true) setWatch(true);
  refreshArchiveCount();
  refreshAwayProjects();
  refreshSync();
  // The model servers are asked now and every minute: the person sees what is connected before sending.
  await refreshModelHealth();
  setInterval(() => refreshModelHealth(), MODEL_HEALTH_EVERY_MS);

  const layout = sceneGetLayout();
  if (layout !== null && layout.view !== undefined && layout.view !== null) sceneRestoreView(layout.view);
  else goLevel(LEVEL.world);
  atlasOnHistoryChanged();
  atlasOnHudChanged();
  // Startup is finished: the saved view is restored (--capture snapshots wait for this,
  // otherwise the restored camera would close the agent panel they opened).
  atlasState.started = true;
}

$("refresh").addEventListener("click", () => refresh());
$("watch").addEventListener("click", () => setWatch(!atlasState.watch));
$("accountChip").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleUsageMenu();
});
$("usageMenu").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => $("usageMenu").classList.add("hidden"));
$("attentionToggle").addEventListener("click", () => {
  if (atlasState.ui.attentionOpen) {
    setPanel("attentionOpen", false);
    return;
  }
  atlasOpenAttention(null);
});
$("attentionClose").addEventListener("click", () => setPanel("attentionOpen", false));
$("trayToggle").addEventListener("click", () => setPanel("trayOpen", !atlasState.ui.trayOpen));
$("trayClose").addEventListener("click", () => setPanel("trayOpen", false));
$("logToggle").addEventListener("click", () => setPanel("logOpen", !atlasState.ui.logOpen));
$("archiveToggle").addEventListener("click", () => atlasOpenProjectArchive());
$("historyToggle").addEventListener("click", () => atlasOpenHistory());
$("awayToggle").addEventListener("click", () => atlasOpenAwayProjects());
$("syncToggle").addEventListener("click", () => atlasOpenSync());
$("readinessToggle").addEventListener("click", () => {
  if ($("readinessPanel").classList.contains("hidden")) atlasOpenReadiness();
  else closeReadiness();
});
$("readinessClose").addEventListener("click", closeReadiness);
$("logClose").addEventListener("click", () => setPanel("logOpen", false));
$("sheetClose").addEventListener("click", closeSheet);
$("clearLog").addEventListener("click", () => { atlasState.log = []; renderLog(); });
$("saveLog").addEventListener("click", async () => {
  const response = await window.atlas.saveLog({ text: logText() });
  if (response.ok && response.data.saved) atlasRecord("ok", tx("journal saved"), response.data.fileName);
  else if (response.ok) atlasRecord("info", tx("saving canceled"), "");
  else atlasRecord("bad", tx("journal not saved"), response.error.code);
});
$("exportEvidence").addEventListener("click", async () => {
  const response = await window.atlas.exportEvidence();
  if (response.ok && response.data.saved) {
    const state = response.data.complete ? tx("complete") : tx("INCOMPLETE (unfinished calls or truncation)");
    atlasRecord(response.data.complete ? "ok" : "bad", tx("evidence exported"),
      `${response.data.directoryName} · ${state} · SHA256SUMS ${response.data.sumsSha256}`);
  } else if (response.ok) {
    atlasRecord("info", tx("evidence export canceled"), "");
  } else {
    atlasRecord("bad", tx("evidence not exported"), `${response.error.code} ${response.error.reasonCode ?? ""}`);
  }
});
$("mapUndo").addEventListener("click", () => undoLocal());
$("mapRedo").addEventListener("click", () => redoLocal());
$("mapCompact").addEventListener("click", () => {
  const scope = sceneScope();
  const projectId = scene.selection?.projectId ?? scope.projectId;
  if (projectId !== null && projectId !== undefined) sceneCompactProject(projectId);
});
$("mapExport").addEventListener("click", async () => {
  const response = await window.atlas.exportLayout({ layout: sceneGetLayout() });
  if (response.ok && response.data.saved) atlasRecord("ok", tx("layout exported"), response.data.fileName);
  else if (response.ok) atlasRecord("info", tx("export canceled"), "");
  else atlasRecord("bad", tx("layout not exported"), response.error.reasonCode || response.error.code);
});
$("mapImport").addEventListener("click", async () => {
  const response = await window.atlas.importLayout();
  if (!response.ok) {
    atlasRecord("bad", tx("layout not imported"), response.error.reasonCode || response.error.code);
    return;
  }
  if (response.data.imported !== true) return;
  sceneReplaceLayout(response.data.layout);
  atlasRecord("ok", tx("layout imported from file"), response.data.fileName);
});
for (const button of document.querySelectorAll("[data-level]")) {
  button.addEventListener("click", () => {
    const level = Number(button.dataset.level);
    if (level === LEVEL.workspace) {
      if (scene.selection?.kind === "agent") atlasOpenWorkspace(scene.selection);
      return;
    }
    goLevel(level);
  });
}
$("selectTool").addEventListener("click", () => sceneSetTool("select"));
$("panTool").addEventListener("click", () => sceneSetTool("pan"));
$("clearSelection").addEventListener("click", () => selectNode(null));
$("navAttention").addEventListener("click", () => atlasOpenAttention(null));
$("mapStage").addEventListener("pointerdown", (event) => {
  if (!$("contextMenu").classList.contains("hidden") && event.target.closest("#contextMenu") === null) {
    $("contextMenu").classList.add("hidden");
  }
}, true);

if (typeof window.atlas === "undefined") {
  $("connectionChip").textContent = tx("bridge unavailable");
  $("connectionChip").className = "chip status bad";
} else {
  window.atlas.onFlush(flushPending);
  start();
}

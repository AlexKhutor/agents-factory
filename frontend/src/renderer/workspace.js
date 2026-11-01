"use strict";

// Agent workspace: a right-hand panel over the map, as in the prototype. The map
// stays visible on the left, the camera moves the agent into the free part of the screen, and
// closing returns to its quarter.
//
// Typed text is kept as a draft: a Gateway restart invalidates
// permissions and questions, but does not erase what was written and never sends it on its own.

const workspaceState = {
  node: null,
  // The camera moves the agent into the free part of the map, and closing returns to its
  // quarter, only for an agent opened as an agent. A lead's chat (entering a
  // project or quarter, the project lead in the HQ) does not touch the camera.
  camera: true,
  tab: "chat",
  feed: null,
  feedTimer: null,
  // Which agent's feed is in the DOM right now: only then does an update
  // repaint it in place, without touching the input field.
  chatMounted: null,
  openActivities: new Set(),
  questions: null,
  lastSend: null,
  // Live conversation by the agent's binding (Kit v0.15.0) and where the feed is read from now:
  // "live" or "archive". null means not decided yet.
  live: null,
  chatSource: null,
  // The first event poll after opening takes a new snapshot.
  eventsRestart: true,
  files: null,
  artifacts: null,
  // “After the turn” messages sent from this window: agent → [{ operationId, text }].
  queued: new Map(),
  // Pending questions of the agent for the conversation: { agentId, records, loading, failed, key }.
  chatQuestions: null,
  trace: null,
  // The agents' tasks from task mode (the backend's agent-tasks.mjs): agentId -> { readAt, tasks, error }.
  tasks: new Map(),
  // The open agent's pending memory changes (the backend's memory-changes.mjs): { agentId, changes, failed }.
  memoryChanges: null,
};

const isWorkspaceOpen = () => workspaceState.node !== null;
/** The open workspace drives the camera: an agent opened as an agent, not a lead's chat. */
const workspaceFollowsCamera = () => workspaceState.node !== null && workspaceState.camera;

const draftFor = (agentId) => atlasState.drafts.get(agentId) ?? "";

function setDraft(agentId, text) {
  if (text.trim() === "") atlasState.drafts.delete(agentId);
  else atlasState.drafts.set(agentId, text);
}

function atlasOpenWorkspace(node, { tab = "chat", camera = true } = {}) {
  atlasDismissPanels();
  workspaceState.node = node;
  // The project lead is not on the map (its HQ is the project building), and neither is an archived agent:
  // the camera does not fly to them, and the window opens where the camera is.
  const onMap = projectionOf().projects.some((project) => project.projectId === node.projectId
    && project.quarters.some((quarter) => quarter.quarterId === node.quarterId
      && quarter.agents.some((agent) => agent.agentId === node.agentId)));
  workspaceState.camera = camera && node.quarterId !== HEADQUARTERS_QUARTER && onMap;
  workspaceState.tab = TABS.some(([id]) => id === tab) ? tab : "chat";
  if (workspaceState.feed !== null && workspaceState.feed.agentId !== node.agentId) {
    workspaceState.feed = null;
    workspaceState.openActivities = new Set();
  }
  if (workspaceState.live !== null && workspaceState.live.agentId !== node.agentId) {
    workspaceState.live = null;
    workspaceState.chatSource = null;
    workspaceState.artifacts = null;
  }
  if (workspaceState.files !== null && workspaceState.files.projectId !== node.projectId) workspaceState.files = null;
  workspaceState.eventsRestart = true;
  workspaceState.questions = null;
  workspaceState.lastSend = null;
  document.getElementById("workspace").classList.remove("hidden");
  document.getElementById("mapStage").classList.add("with-workspace");
  selectNode(node);
  sceneWorkspaceCamera(node);
  atlasRecord("info", tx("workspace opened"), node.agentId);
  renderWorkspace();
  startFeedTimer();
  atlasOnHudChanged();
}

function closeWorkspace({ keepDraft = true, keepCamera = false } = {}) {
  const node = workspaceState.node;
  if (node === null) return;
  if (!keepDraft) atlasState.drafts.delete(node.agentId);
  workspaceState.node = null;
  workspaceState.chatMounted = null;
  stopFeedTimer();
  stopTraceTimer();
  document.getElementById("workspace").classList.add("hidden");
  document.getElementById("mapStage").classList.remove("with-workspace");
  // The camera returns to the quarter only if it has not been moved since: if
  // the person has already moved away to the world, closing the panel must not drag them back.
  // Closed by a click on the map: the camera stays where it was. The person clicked on
  // what they see, and the second click of a double click must land on the same spot.
  if (keepCamera) sceneLeaveWorkspace(null);
  else sceneLeaveWorkspace(node);
  atlasOnHudChanged();
}

/**
 * World data was updated. The open feed is repainted in place: a full
 * rebuild would reset the focus and the cursor in the input field in the middle of typing.
 */
function refreshWorkspace() {
  const node = workspaceState.node;
  if (node === null) return;
  const agent = agentOf();
  if (workspaceState.tab === "chat" && workspaceState.chatMounted === node.agentId && agent !== null) {
    paintChat();
    return;
  }
  // The other tabs do not show the agent catalog: files, trace, memory,
  // tasks and questions read their own data. They are not rebuilt on a world update:
  // a rebuild would reset the scroll of an open file, what is expanded in the trace and
  // the cursor in the editor. The window is rebuilt only when what it is made of has
  // changed: the agent is not in the catalog or has another role (other tabs).
  if (agent === null || workspaceState.renderedAgentId !== node.agentId
      || workspaceState.renderedRole !== (agent.settings?.role ?? null)) {
    renderWorkspace();
    return;
  }
  paintWorkspaceHead(agent);
  if (workspaceState.tab === "scope") {
    // What the lead is responsible for comes from the catalog: repaint with the same scroll.
    const top = document.querySelector("#workspace .workspace-body")?.scrollTop ?? 0;
    renderWorkspace();
    const body = document.querySelector("#workspace .workspace-body");
    if (body !== null) body.scrollTop = top;
  }
}

/** The head of the agent window: model and state from a fresh catalog, without rebuilding the tab. */
function paintWorkspaceHead(agent) {
  const status = document.getElementById("workspaceAgentStatus");
  if (status !== null) status.textContent = tx("{state} · delivery {deliveryState}", { state: agent.state, deliveryState: agent.deliveryState });
  const modelLine = document.getElementById("workspaceModel");
  if (modelLine !== null) modelLine.textContent = modelWords(agent);
}

function agentOf() {
  const node = workspaceState.node;
  if (node === null) return null;
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  const project = world.projection.projects.find((item) => item.projectId === node.projectId);
  const quarter = project?.quarters.find((item) => item.quarterId === node.quarterId);
  return quarter?.agents.find((item) => item.agentId === node.agentId) ?? null;
}

const TABS = Object.freeze([
  ["chat", tx("Conversation")],
  ["plan", tx("Plan")],
  ["trace", tx("Trace")],
  ["tasks", tx("Tasks")],
  ["questions", tx("Questions")],
  ["files", tx("Files")],
  ["artifacts", tx("Artifacts")],
  ["context", tx("Memory")],
  ["skills", tx("Skills")],
  ["notes", tx("Notes")],
]);

function renderWorkspace() {
  const node = workspaceState.node;
  const panel = document.getElementById("workspace");
  if (node === null || panel === null) return;
  const agent = agentOf();
  workspaceState.chatMounted = null;
  workspaceState.renderedAgentId = node.agentId;
  workspaceState.renderedRole = agent?.settings?.role ?? null;
  panel.replaceChildren();

  const head = el("div", "workspace-head");
  const top = el("div", "workspace-top");
  const ident = el("div");
  const eyebrow = agent?.settings?.role === "coordinator" ? tx("WORLD LEAD")
    : agent?.settings?.role === "project-lead" ? tx("PROJECT LEAD / {projectId}", { projectId: node.projectId })
      : agent?.settings?.role === "quarter-lead" ? tx("QUARTER LEAD / {quarterId}", { quarterId: node.quarterId })
        : tx("AGENT / {quarterId}", { quarterId: node.quarterId });
  ident.append(el("div", "eyebrow", eyebrow));
  // The agent's name (app.js displayName), the ID beside it where they differ.
  ident.append(el("h3", null, typeof nameWithId === "function" ? nameWithId("agent", node.projectId, node.agentId) : node.agentId));
  // Who the conversation is with: the model and reasoning level of the agent, as in Codex and
  // Claude Code — in plain view, not in the “Memory” tab.
  const modelLine = el("div", "workspace-model", agent === null ? "" : modelWords(agent));
  modelLine.id = "workspaceModel";
  ident.append(modelLine);
  const agentStatus = el("div", "muted", agent === null
    ? tx("agent not in the catalog")
    : tx("{state} · delivery {deliveryState}", { state: agent.state, deliveryState: agent.deliveryState }));
  agentStatus.id = "workspaceAgentStatus";
  ident.append(agentStatus);
  top.append(ident);
  top.append(el("div", "spacer"));
  top.append(chatScaleControl());
  // One button: expand the conversation to the whole window and return it to the side panel.
  const full = atlasState.ui.workspaceFull === true;
  const expand = el("button", "icon-btn flat", full ? "⤡" : "⤢");
  expand.id = "workspaceExpand";
  expand.title = full ? tx("Back to the side panel") : tx("Full screen");
  expand.addEventListener("click", () => setWorkspaceFull(!full));
  top.append(expand);
  const close = el("button", "icon-btn flat", "×");
  close.title = tx("Back to the quarter · Esc");
  close.addEventListener("click", () => closeWorkspace());
  top.append(close);
  head.append(top);

  const tabs = el("nav", "workspace-tabs");
  // A lead also has a tab for what it is responsible for: the world, the project or the quarter.
  const role = agent?.settings?.role ?? null;
  const scopeTab = { coordinator: tx("World"), "project-lead": tx("Project"), "quarter-lead": tx("Quarter") }[role] ?? null;
  const tabList = scopeTab === null ? TABS : [...TABS.slice(0, 2), ["scope", scopeTab], ...TABS.slice(2)];
  if (workspaceState.tab === "scope" && scopeTab === null) workspaceState.tab = "chat";
  for (const [id, title] of tabList) {
    // Skills are a workspace tab, not a window beside it; their count is shown on the tab.
    // The Plan tab is marked while the agent's task waits for the person.
    const label = id === "skills" ? `${title} · ${sceneSkillsOf(node).length}` : id === "plan" ? planTabLabel(node.agentId) : title;
    const button = el("button", workspaceState.tab === id ? "active" : null, label);
    button.dataset.tab = id;
    if (id === "plan" && taskWaitsForPerson(node.agentId)) button.classList.add("waiting");
    button.addEventListener("click", () => {
      workspaceState.tab = id;
      // The artifact list is read again each time its tab opens: a finished task may have added to it.
      if (id === "artifacts") workspaceState.artifacts = null;
      renderWorkspace();
    });
    tabs.append(button);
  }
  head.append(tabs);
  panel.append(head);

  const body = el("div", "workspace-body");
  panel.append(body);
  if (agent !== null && workspaceState.tab !== "plan" && tasksOf(agent.agentId) === null) {
    loadAgentTasks(node).then(() => { if (workspaceState.node?.agentId === node.agentId) paintPlanTabLabel(); });
  }

  if (agent === null) {
    body.append(noteBlock("error",
      tx("This agent is not in the current catalog. It may be closed, or the catalog is incomplete.")));
  } else if (workspaceState.tab === "chat") {
    renderChat(body, agent);
    // The conversation is on screen, so the agent's answer has been read.
    atlasMarkTurnSeen(agent.agentId);
  } else if (workspaceState.tab === "plan") {
    renderPlan(body, agent);
  } else if (workspaceState.tab === "trace") {
    renderTrace(body, agent);
  } else if (workspaceState.tab === "scope") {
    renderLeadScope(body, agent);
  } else if (workspaceState.tab === "tasks") {
    renderTasks(body, agent);
  } else if (workspaceState.tab === "questions") {
    renderQuestions(body, agent);
  } else if (workspaceState.tab === "files") {
    renderFiles(body, agent);
  } else if (workspaceState.tab === "artifacts") {
    renderArtifacts(body, agent);
  } else if (workspaceState.tab === "context") {
    renderContext(body, agent);
  } else if (workspaceState.tab === "skills") {
    renderSkillsInto(body, node, () => renderWorkspace());
  } else {
    renderAnnotations(body, node);
  }

  const foot = el("div", "workspace-foot");
  foot.append(el("span", null, atlasState.info?.fixture ? tx("FIXTURE · no provider")
    : atlasState.info?.mode === "paperclip" ? "Paperclip" : "Claude Code"));
  foot.append(el("span", null, tx("Esc — back to the quarter")));
  panel.append(foot);
  panel.append(workspaceResizer(panel));
  applyWorkspaceSize();
}

// --- agent questions right in the conversation -----------------------------------------
//
// An agent question (the Claude Code question tool, a permission for a command or for a
// file edit) holds its turn: until it is answered, the agent stands still, and it reads even
// a steered message only after the answer. That is why the question
// is shown where the person is already looking: in the conversation above the input field, with
// option buttons and a field for a custom answer, as in Claude Code.

const RESPONSE_WORDS = Object.freeze({
  accept: tx("Allow"), decline: tx("Decline"), cancel: tx("Stop turn"), grant: tx("Allow"), deny: tx("Deny"),
});

/** Key of the agent's pending questions from world data: when it changes, read them again. */
function interactionKeyOf(agentId) {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return "";
  return (world.attention ?? []).filter((item) => (item.kind === "interaction" || item.kind === "captured-pending")
    && item.agentId === agentId).map((item) => item.interactionId ?? item.kind).sort().join(",");
}

async function loadChatQuestions(agent) {
  const state = workspaceState.chatQuestions;
  if (state === null || state.agentId !== agent.agentId || state.loading) return;
  state.loading = true;
  state.key = interactionKeyOf(agent.agentId);
  const response = await window.atlas.interactions({ agentId: agent.agentId, limit: 16 });
  state.loading = false;
  const delivered = response.ok && response.result?.outcome === "succeeded";
  state.records = delivered ? (response.result.output.records ?? []).filter((record) => record.state === "awaiting-owner") : [];
  state.failed = !delivered;
  if (workspaceState.chatQuestions === state) paintChatQuestions(agent);
}

/**
 * The card of one question. A question with options: a click on an option answers
 * at once (if there is only one question); otherwise options are chosen and sent with the
 * “Answer” button; a custom answer goes in the field. A permission: buttons of its allowed responses.
 */
function questionCard(agent, record, onAnswered) {
  const card = el("div", "chat-question");
  const kind = record.display?.kind ?? tx("question");
  const fields = record.display?.fields ?? {};
  const outcome = el("div", "chat-question-outcome");
  const send = async (selectedResponse, answers = null) => {
    for (const button of card.querySelectorAll("button, input")) button.disabled = true;
    const response = await window.atlas.respond({ agentId: agent.agentId, interactionId: record.interactionId,
      selectedResponse, ...(answers === null ? {} : { answers }) });
    if (response.ok) {
      atlasRecord("ok", tx("answer to the agent"), `${agent.agentId}: ${selectedResponse}`);
      outcome.replaceChildren(noteBlock("note", tx("Answer sent: the agent continues its turn.")));
      onAnswered?.();
      return;
    }
    const shown = outcomeMessage(response, tx("Answer sent."));
    outcome.replaceChildren(noteBlock("error", response.error?.reasonCode === "answer_missing"
      ? tx("Answer every question.") : shown.text));
    for (const button of card.querySelectorAll("button, input")) button.disabled = false;
  };
  if (kind === "user-input" && Array.isArray(fields.questions)) {
    card.append(el("div", "chat-question-head", tx("The agent asks")));
    const chosen = {};
    const single = fields.questions.length === 1;
    const submit = el("button", "small primary", tx("Answer"));
    const ready = () => { submit.disabled = !fields.questions.every((question) => (chosen[question.id] ?? "").trim() !== ""); };
    for (const question of fields.questions) {
      const block = el("div", "chat-question-block");
      if (question.header) block.append(el("span", "chat-question-tag", question.header));
      // A question where several options can be chosen, as in Claude Code: a click
      // checks and unchecks an option, the answer goes with the “Answer” button, options joined by “, ”.
      const several = question.multiSelect === true;
      if (several) block.append(el("span", "chat-question-tag several", tx("you can choose several")));
      block.append(el("div", "chat-question-text", question.question ?? ""));
      // Options as a numbered list, each with its description below; the last
      // item is a custom answer. This is how Claude Code shows a question.
      const options = el("ol", "chat-question-options");
      const choices = question.options ?? [];
      choices.forEach((option, index) => {
        const button = el("button", "chat-option");
        button.type = "button";
        const body = el("span", "chat-option-body");
        body.append(el("span", "chat-option-label", option.label));
        if (option.description) body.append(el("span", "chat-option-description", option.description));
        button.append(el("span", "chat-option-number", `${index + 1}.`), body);
        button.addEventListener("click", () => {
          if (several) {
            button.classList.toggle("chosen");
            const own = block.querySelector(".chat-question-own");
            if (own) own.value = "";
            chosen[question.id] = [...options.querySelectorAll(".chat-option.chosen .chat-option-label")]
              .map((label) => label.textContent).join(", ");
            ready();
            return;
          }
          chosen[question.id] = option.label;
          for (const other of options.querySelectorAll(".chat-option")) other.classList.toggle("chosen", other === button);
          if (single) send("submit-text", { [question.id]: option.label });
          else ready();
        });
        const row = el("li");
        row.append(button);
        options.append(row);
      });
      if (question.isOther !== false) {
        const own = el("input", "field chat-question-own");
        own.placeholder = choices.length > 0 ? tx("Your own answer…") : tx("Your answer…");
        own.maxLength = 4096;
        own.addEventListener("input", () => {
          chosen[question.id] = own.value;
          for (const other of options.querySelectorAll(".chat-option")) other.classList.remove("chosen");
          ready();
        });
        own.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing && !submit.disabled) {
            event.preventDefault();
            submit.click();
          }
        });
        const row = el("li", "chat-option own");
        if (choices.length > 0) row.append(el("span", "chat-option-number", `${choices.length + 1}.`));
        row.append(own);
        options.append(row);
      }
      block.append(options);
      card.append(block);
    }
    submit.addEventListener("click", () => send("submit-text", Object.fromEntries(fields.questions
      .map((question) => [question.id, (chosen[question.id] ?? "").trim()]))));
    ready();
    card.append(submit);
  } else {
    card.append(el("div", "chat-question-head", kind === "command-approval" ? tx("The agent asks permission to run a command")
      : kind === "file-change-approval" ? tx("The agent asks permission to edit") : tx("The agent asks for permission")));
    const what = fields.command ?? fields.reason ?? record.display?.title ?? record.interactionId;
    card.append(el("pre", "chat-question-what", String(what)));
    const choices = el("div", "chat-question-options");
    for (const choice of record.interactionRequest?.allowedResponses ?? []) {
      const button = el("button", choice === "accept" || choice === "grant" ? "small primary" : "small",
        RESPONSE_WORDS[choice] ?? choice);
      button.addEventListener("click", () => send(choice));
      choices.append(button);
    }
    card.append(choices);
  }
  card.append(outcome);
  return card;
}

function paintChatQuestions(agent) {
  const box = document.getElementById("chatQuestions");
  const state = workspaceState.chatQuestions;
  if (box === null || state === null || state.agentId !== agent.agentId) return;
  const records = state.records ?? [];
  // Same questions, same cards: a repaint on a world update (live view)
  // would reset the checked options and the typed answer.
  const signature = `${agent.agentId}|${records.map((record) => record.interactionId).join("|")}`;
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.replaceChildren();
  box.hidden = records.length === 0;
  for (const record of records) {
    box.append(questionCard(agent, record, async () => {
      await refresh();
      if (workspaceState.chatSource === "live") readLive(agent);
      setTimeout(() => loadChatQuestions(agent), 400);
    }));
  }
  if (records.length > 0) {
    box.append(el("div", "chat-compose-note",
      tx("The agent is waiting for an answer to the question above: its turn is on hold, and it will read messages from the input field only after the answer.")));
  }
}

/** Questions hold the turn: on every world update, check whether new ones have appeared. */
function syncChatQuestions(agent) {
  if (workspaceState.chatQuestions === null || workspaceState.chatQuestions.agentId !== agent.agentId) {
    workspaceState.chatQuestions = { agentId: agent.agentId, records: [], loading: false, failed: false, key: null };
  }
  const state = workspaceState.chatQuestions;
  const key = interactionKeyOf(agent.agentId);
  if (state.key !== key || (key !== "" && state.records.length === 0 && !state.failed)) loadChatQuestions(agent);
  else paintChatQuestions(agent);
}

// --- what the lead is responsible for ------------------------------------------------

/**
 * The world lead's World tab: each project, its lead and agents - the same as what
 * it gets as an overview - and the way into the World HQ with its tasks.
 */
function renderWorldScope(body) {
  const world = atlasState.world;
  const projects = world?.status === "ready"
    ? world.projection.projects.filter((project) => project.projectId !== WORLD_PROJECT) : [];
  body.append(el("div", "section-title", tx("World · {value}", { value: countWords(projects.length, PROJECT_FORMS) })));
  const actions = el("div", "actions");
  const hq = el("button", "small primary", tx("World HQ: tasks and desk agents"));
  hq.addEventListener("click", () => atlasOpenWorldHeadquarters());
  actions.append(hq);
  body.append(actions);
  if (projects.length === 0) body.append(el("div", "empty", tx("No projects yet.")));
  for (const project of projects) {
    const lead = leadOf(project.projectId);
    const agents = project.quarters.flatMap((quarter) => quarter.agents).filter((other) => other.state !== "archived");
    const row = el("div", "entry");
    row.append(el("div", "entry-title", project.projectId));
    row.append(el("div", "entry-text", [lead === null ? tx("no project lead") : tx("lead {agentId}", { agentId: lead.agentId }),
      countWords(agents.length, AGENT_FORMS)].join(" · ")));
    const go = el("button", "small", lead === null ? tx("Project HQ") : tx("Lead chat"));
    go.addEventListener("click", () => (lead === null ? atlasOpenHeadquarters(project.projectId)
      : atlasOpenWorkspace(leadNode(lead), { camera: false })));
    row.append(go);
    body.append(row);
  }
}

/** The project (quarters and their agents) or quarter (its agents) of a lead: in brief, as the lead sees it. */
function renderLeadScope(body, agent) {
  if (agent.settings?.role === "coordinator") {
    renderWorldScope(body);
    return;
  }
  const world = atlasState.world;
  const project = world?.status === "ready"
    ? world.projection.projects.find((item) => item.projectId === agent.projectId) ?? null : null;
  if (project === null) {
    body.append(noteBlock("error", tx("The project has not been read.")));
    return;
  }
  const agentLine = (other) => [other.settings?.role === "quarter-lead" ? tx("quarter lead")
    : other.settings?.role === "project-lead" ? tx("project lead") : null,
  modelOf(other.profile?.model)?.name ?? other.profile?.model ?? null,
  other.currentOperationId ? tx("working") : other.state].filter(Boolean).join(" · ");
  const agentRow = (other) => {
    const row = el("div", "entry");
    row.append(el("div", "entry-title", other.agentId));
    row.append(el("div", "entry-text", agentLine(other)));
    const open = el("button", "small", tx("Chat"));
    open.addEventListener("click", () => atlasOpenWorkspace({ kind: "agent", projectId: other.projectId,
      quarterId: other.quarterId, agentId: other.agentId }));
    row.append(open);
    return row;
  };
  if (agent.settings?.role === "project-lead") {
    body.append(el("div", "section-title", tx("Project · {projectId}", { projectId: project.projectId })));
    const actions = el("div", "actions");
    actions.append(actionButton(tx("Project memory"), "query.memory.scope.read",
      () => openMemorySheet(project.memory.scopeId, tx("Project memory · {projectId}", { projectId: project.projectId }))));
    body.append(actions);
    for (const quarter of project.quarters.filter((item) => item.quarterId !== HEADQUARTERS_QUARTER)) {
      body.append(el("div", "section-title", tx("Quarter {quarterId} · {value}", { quarterId: quarter.quarterId, value: countWords(quarter.agents.length, AGENT_FORMS) })));
      if (quarter.agents.length === 0) body.append(el("div", "empty", tx("No agents.")));
      for (const other of quarter.agents) body.append(agentRow(other));
    }
    return;
  }
  const quarter = project.quarters.find((item) => item.quarterId === agent.quarterId) ?? null;
  body.append(el("div", "section-title", tx("Quarter · {quarterId}", { quarterId: agent.quarterId })));
  const actions = el("div", "actions");
  if (quarter !== null) {
    actions.append(actionButton(tx("Quarter memory"), "query.memory.scope.read",
      () => openMemorySheet(quarter.memory.scopeId, tx("Quarter memory · {quarterId}", { quarterId: agent.quarterId }))));
  }
  actions.append(actionButton(tx("Create agent…"), "mutation.memory.agent.create",
    () => openCreateAgentSheet(agent.projectId, agent.quarterId)));
  body.append(actions);
  const others = (quarter?.agents ?? []).filter((other) => other.agentId !== agent.agentId);
  if (others.length === 0) body.append(el("div", "empty", tx("No other agents in the quarter.")));
  for (const other of others) body.append(agentRow(other));
}

// --- trace --------------------------------------------------------------------------
//
// Everything the agent's turns did, in full: the text sent to the agent (with memory and
// role), steered and queued messages, answers, thinking, every tool call
// with its input and output, edit diffs, the turn result with model, time,
// tokens and cost. The conversation shows a readable summary; here is what is behind it.

const TRACE_POLL_MS = 2500;

const emptyTrace = (agentId) => ({ agentId, records: [], beforeCursor: null, afterCursor: null,
  exhausted: false, loading: false, error: null, timer: null, older: false, toggled: new Map() });

/** A trace record is the same in every redraw (the "Earlier" page shifts the numbers). */
const traceKey = (record) => [record.atUtc ?? "", record.type, record.turnId ?? "", record.toolUseId ?? record.tool ?? ""].join("|");

/**
 * What the person expanded or collapsed stays so after a redraw: the trace
 * is read every 2.5 s, and an expanded block used to collapse by itself.
 */
function keepTraceToggle(node, key, byDefault) {
  const toggled = workspaceState.trace?.toggled ?? null;
  node.open = key !== null && toggled?.has(key) ? toggled.get(key) : byDefault;
  node.addEventListener("toggle", () => { if (key !== null) toggled?.set(key, node.open); });
}

async function readTrace(agent, { older = false } = {}) {
  const trace = workspaceState.trace;
  if (trace === null || trace.agentId !== agent.agentId || trace.loading) return;
  trace.loading = true;
  const request = older ? { agentId: agent.agentId, before: trace.beforeCursor }
    : trace.afterCursor === null ? { agentId: agent.agentId } : { agentId: agent.agentId, after: trace.afterCursor };
  const response = await window.atlas.trace(request);
  trace.loading = false;
  if (!response.ok || response.result?.outcome !== "succeeded") {
    trace.error = response.error?.code ?? response.result?.error?.code ?? "trace_unavailable";
  } else {
    const page = response.result.output;
    trace.error = null;
    if (older) {
      trace.records = [...page.records, ...trace.records];
      trace.beforeCursor = page.beforeCursor;
      trace.exhausted = page.exhausted;
    } else if (trace.afterCursor === null) {
      trace.records = page.records;
      trace.beforeCursor = page.beforeCursor;
      trace.afterCursor = page.afterCursor;
      trace.exhausted = page.exhausted;
    } else {
      trace.records.push(...page.records);
      trace.afterCursor = page.afterCursor ?? trace.afterCursor;
    }
    trace.queued = page.queued ?? [];
  }
  if (workspaceState.tab === "trace" && workspaceState.node?.agentId === agent.agentId) paintTrace();
}

function stopTraceTimer() {
  if (workspaceState.trace?.timer) clearInterval(workspaceState.trace.timer);
  if (workspaceState.trace) workspaceState.trace.timer = null;
}

function renderTrace(body, agent) {
  if (workspaceState.trace === null || workspaceState.trace.agentId !== agent.agentId) {
    stopTraceTimer();
    workspaceState.trace = emptyTrace(agent.agentId);
  }
  const trace = workspaceState.trace;
  body.classList.add("trace-mode");
  const bar = el("div", "trace-bar");
  const older = el("button", "small", tx("Earlier"));
  older.id = "traceOlder";
  older.addEventListener("click", () => readTrace(agent, { older: true }));
  const status = el("span", "muted");
  status.id = "traceStatus";
  bar.append(older, status, el("div", "spacer"),
    el("span", "muted", tx("Full turn records: memory, assignments, tool input and output, diffs.")));
  const list = el("div", "trace-list");
  list.id = "traceList";
  body.append(bar, list);
  paintTrace();
  if (trace.records.length === 0 && trace.afterCursor === null) readTrace(agent);
  stopTraceTimer();
  trace.timer = setInterval(() => {
    if (workspaceState.tab !== "trace" || workspaceState.node?.agentId !== agent.agentId) { stopTraceTimer(); return; }
    if (document.visibilityState === "visible") readTrace(agent);
  }, TRACE_POLL_MS);
}

const TRACE_LABELS = Object.freeze({
  turn_started: tx("turn started"), session: tx("session"), user_input: tx("you → agent"), user_queued: tx("queued"),
  user_cancelled: tx("withdrawn"), assistant: tx("agent"), thinking: tx("workspace::thinking"), tool_use: tx("tool"),
  tool_result: tx("result"), compacted: tx("context compacted"), turn_finished: tx("workspace::turn finished"),
});

function traceTime(record) {
  const at = Date.parse(record.atUtc ?? "");
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString(dateLocale()) : "";
}

function traceBlock(title, text, { open = false, className = "", key = null } = {}) {
  const node = el("details", `trace-details ${className}`.trim());
  keepTraceToggle(node, key, open);
  node.append(el("summary", null, title));
  node.append(el("pre", "trace-pre", text));
  return node;
}

function traceDiff(diff, key = null) {
  const pre = el("pre", "trace-pre trace-diff");
  for (const line of diff.split("\n")) {
    pre.append(el("div", line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del"
      : line.startsWith("@@") ? "diff-hunk" : null, line || " "));
  }
  const node = el("details", "trace-details");
  keepTraceToggle(node, key, true);
  node.append(el("summary", null, tx("diff")), pre);
  return node;
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text ?? ""); }
}

function traceRecord(record) {
  const row = el("div", `trace-row trace-${record.type}`);
  const head = el("div", "trace-head");
  head.append(el("span", "trace-time", traceTime(record)));
  head.append(el("span", "trace-type", TRACE_LABELS[record.type] ?? record.type));
  const words = [];
  if (record.type === "turn_started") words.push([record.model, record.effort && record.effort !== "default" ? record.effort : null].filter(Boolean).join(" · "));
  if (record.type === "session") words.push([record.claudeCodeVersion ? `Claude Code ${record.claudeCodeVersion}` : null, record.model, record.cwd].filter(Boolean).join(" · "));
  if (record.type === "tool_use") words.push(record.tool ?? "");
  if (record.type === "tool_result") words.push(record.isError ? tx("error") : tx("ok"));
  if (record.type === "user_input" || record.type === "user_queued") words.push(record.delivery === "steer" ? "steer" : record.delivery === "queue" ? tx("after the turn") : "");
  if (record.type === "user_cancelled") words.push(record.reason === "turn_stopped" ? tx("turn stopped") : tx("by you"));
  if (record.type === "compacted") words.push([record.trigger, record.preTokens ? tx("{preTokens} tokens before compaction", { preTokens: record.preTokens }) : null].filter(Boolean).join(" · "));
  if (record.type === "assistant" && record.model) words.push(record.model);
  if (record.type === "turn_finished") {
    const usage = record.usage ?? null;
    words.push([record.status, record.failure, record.durationMs ? tx("{value} s", { value: (record.durationMs / 1000).toFixed(1) }) : null,
      usage ? tx("in {cacheReadInputTokens} (cache {cacheReadInputTokens2}) · out {outputTokens}", { cacheReadInputTokens: usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens, cacheReadInputTokens2: usage.cacheReadInputTokens, outputTokens: usage.outputTokens }) : null,
      typeof record.costUsd === "number" ? `$${record.costUsd.toFixed(4)}` : null,
      record.models ? Object.keys(record.models).join(", ") : null].filter(Boolean).join(" · "));
  }
  if (words.some(Boolean)) head.append(el("span", "trace-words", words.filter(Boolean).join(" · ")));
  row.append(head);
  const key = traceKey(record);
  if (record.type === "turn_started") {
    if (record.displayText) row.append(el("div", "trace-text", record.displayText));
    if (record.text) row.append(traceBlock(tx("full text sent to the agent (memory, role, assignment)"), record.text, { key: `${key}|text` }));
  } else if (record.type === "user_input" || record.type === "user_queued") {
    row.append(el("div", "trace-text", record.displayText ?? record.text ?? ""));
  } else if (record.type === "assistant") {
    row.append(markdownNode(record.text ?? "", "trace-text"));
  } else if (record.type === "thinking") {
    row.append(traceBlock(tx("thinking text"), record.text ?? "", { key: `${key}|text` }));
  } else if (record.type === "tool_use") {
    row.append(traceBlock(tx("input"), prettyJson(record.input), { open: true, key: `${key}|input` }));
  } else if (record.type === "tool_result") {
    if (record.output) row.append(traceBlock(tx("output"), record.output, { open: record.isError === true, key: `${key}|output` }));
    if (record.diff) row.append(traceDiff(record.diff, `${key}|diff`));
  }
  return row;
}

/** Appends records to the list with turn headings; returns the last one's turn. */
function appendTraceRecords(list, records, lastTurn) {
  let turn = lastTurn;
  for (const record of records) {
    if (record.turnId && record.turnId !== turn) {
      turn = record.turnId;
      list.append(el("div", "trace-turn", tx("turn {value}", { value: turn.slice(0, 8) })));
    }
    list.append(traceRecord(record));
  }
  return turn;
}

/**
 * The trace list. A poll every 2.5 s most often brings nothing: then
 * the list is not touched. New records are appended at the end; it is rebuilt
 * only on the "Earlier" page and in a new window - what was expanded comes back by
 * the record's key, the scroll stays in the same place.
 */
function paintTrace() {
  const trace = workspaceState.trace;
  const list = document.getElementById("traceList");
  if (trace === null || list === null) return;
  const status = document.getElementById("traceStatus");
  const older = document.getElementById("traceOlder");
  if (older) older.disabled = trace.exhausted || trace.beforeCursor === null || trace.loading;
  if (status) {
    status.textContent = trace.error ? tx("trace not read: {error}", { error: trace.error })
      : trace.loading && trace.records.length === 0 ? tx("reading…")
        : tx("{length} records{value}", { length: trace.records.length, value: trace.exhausted ? tx(" · from the start") : "" });
  }
  if (trace.records.length === 0) {
    list.replaceChildren(el("div", "empty", trace.error ? tx("Trace unavailable: the backend did not return it.")
      : trace.loading ? tx("Reading the trace…") : tx("No records yet: they will appear with the first turn after the backend update.")));
    delete list.dataset.count;
    return;
  }
  const first = traceKey(trace.records[0]);
  const shown = list.dataset.count === undefined ? 0 : Number(list.dataset.count);
  const sameStart = shown > 0 && list.dataset.first === first;
  if (sameStart && shown === trace.records.length) return;
  const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  let lastTurn;
  if (sameStart && shown < trace.records.length) {
    lastTurn = appendTraceRecords(list, trace.records.slice(shown), list.dataset.lastTurn || null);
  } else {
    const fromBottom = list.scrollHeight - list.scrollTop;
    list.replaceChildren();
    lastTurn = appendTraceRecords(list, trace.records, null);
    if (shown > 0 && !nearBottom) list.scrollTop = list.scrollHeight - fromBottom;
  }
  list.dataset.count = String(trace.records.length);
  list.dataset.first = first;
  list.dataset.lastTurn = lastTurn ?? "";
  if (shown === 0 || nearBottom) list.scrollTop = list.scrollHeight;
}

// --- agent model ------------------------------------------------------------------

// The backend model catalog is read once per window lifetime: with it, the model
// of the agent is shown by its name, not by its identifier.
let modelCatalog = null;
let modelCatalogLoading = false;

function loadModelCatalog() {
  if (modelCatalog !== null || modelCatalogLoading || typeof window.atlas?.models !== "function") return;
  modelCatalogLoading = true;
  window.atlas.models().then((response) => {
    modelCatalog = response;
    modelCatalogLoading = false;
    const line = document.getElementById("workspaceModel");
    const agent = agentOf();
    if (line !== null && agent !== null) line.textContent = modelWords(agent);
    // The model picker by the input field gets the list in place: the typed text is not touched.
    if (agent !== null) replaceModelPicker(agent, document.querySelector(".chat-result"));
  });
}

const modelOf = (id) => (modelCatalog?.ok ? modelCatalog.data.models.find((item) => item.id === id) ?? null : null);

/** “Claude Code · Claude Opus 5.5 · reasoning high”. */
function modelWords(agent) {
  loadModelCatalog();
  const profile = agent?.profile ?? null;
  if (profile === null) return tx("model not reported");
  const name = modelOf(profile.model)?.name ?? profile.model;
  const effort = profile.reasoningEffort === "default" ? tx("default reasoning") : tx("reasoning {reasoningEffort}", { reasoningEffort: profile.reasoningEffort });
  const provider = { claude: "Claude Code", acp: "DeepSeek Harness" }[profile.provider] ?? profile.provider;
  return `${provider} · ${name} · ${effort}`;
}

// --- panel size -------------------------------------------------------------------

const WORKSPACE_MIN_WIDTH = 380;

window.addEventListener("resize", () => {
  if (isWorkspaceOpen()) applyWorkspaceSize();
});

// --- text size and zoom of the agent window --------------------------------------
//
// Font changes only the text size (--chat-text in the conversation rules), zoom changes
// the whole panel content (--chat-zoom): head, tabs, conversation, input field.
// The panel width does not change with it. Both numbers belong to each person and
// survive a restart (ui-state).

const CHAT_SCALES = Object.freeze({
  chatText: { title: tx("Font"), min: 70, max: 150, step: 10 },
  chatZoom: { title: tx("Zoom"), min: 50, max: 150, step: 10 },
});

function chatScaleOf(name) {
  const value = atlasState.ui?.[name];
  return Number.isInteger(value) ? value : 100;
}

function applyChatScale() {
  const panel = document.getElementById("workspace");
  if (panel === null) return;
  panel.style.setProperty("--chat-text", String(chatScaleOf("chatText") / 100));
  panel.style.setProperty("--chat-zoom", String(chatScaleOf("chatZoom") / 100));
  for (const name of Object.keys(CHAT_SCALES)) {
    const output = document.getElementById(`${name}Value`);
    if (output !== null) output.textContent = `${chatScaleOf(name)}%`;
  }
}

function setChatScale(name, value) {
  const scale = CHAT_SCALES[name];
  const next = Math.min(scale.max, Math.max(scale.min, Math.round(value)));
  if (next === chatScaleOf(name)) return;
  setPanel(name, next);
  applyChatScale();
}

/** The “Aa” button in the head: font and zoom of the agent window, in steps of 10 %, and a reset. */
function chatScaleControl() {
  const wrap = el("div", "chat-scale-wrap");
  const button = el("button", "icon-btn flat", "Aa");
  button.id = "chatScaleButton";
  button.title = tx("Text size and zoom of the agent window · Ctrl+wheel over the window zooms");
  const menu = el("div", "chat-scale-menu");
  menu.hidden = true;
  for (const [name, scale] of Object.entries(CHAT_SCALES)) {
    const row = el("div", "chat-scale-row");
    const less = el("button", "small", "−");
    less.addEventListener("click", () => setChatScale(name, chatScaleOf(name) - scale.step));
    const value = el("output", null, `${chatScaleOf(name)}%`);
    value.id = `${name}Value`;
    const more = el("button", "small", "+");
    more.addEventListener("click", () => setChatScale(name, chatScaleOf(name) + scale.step));
    row.append(el("span", null, scale.title), less, value, more);
    menu.append(row);
  }
  const reset = el("button", "small", tx("Reset"));
  reset.addEventListener("click", () => {
    setChatScale("chatText", 100);
    setChatScale("chatZoom", 100);
  });
  menu.append(reset, el("div", "chat-scale-hint", tx("Ctrl+wheel over the agent window zooms it.")));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  wrap.append(button, menu);
  return wrap;
}

// A click outside the “Aa” menu closes it.
document.addEventListener("click", () => {
  for (const menu of document.querySelectorAll(".chat-scale-menu")) menu.hidden = true;
});

// Ctrl+wheel over the agent window zooms that window, not the whole Atlas window.
document.getElementById("workspace")?.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setChatScale("chatZoom", chatScaleOf("chatZoom") + (event.deltaY < 0 ? 1 : -1) * CHAT_SCALES.chatZoom.step);
}, { passive: false });

/** Width and the “full screen” mode come from the window state; without its own width, the old default. */
function applyWorkspaceSize() {
  const panel = document.getElementById("workspace");
  if (panel === null) return;
  applyChatScale();
  panel.classList.toggle("full", atlasState.ui.workspaceFull === true);
  const width = atlasState.ui.workspaceWidth;
  const stage = document.getElementById("mapStage").getBoundingClientRect().width;
  panel.style.width = Number.isInteger(width) && stage > 0
    ? `${Math.min(Math.max(width, WORKSPACE_MIN_WIDTH), Math.max(WORKSPACE_MIN_WIDTH, stage - 160))}px` : "";
}

function setWorkspaceFull(full) {
  setPanel("workspaceFull", full);
  renderWorkspace();
  // Back in the side panel, the camera again moves the agent into the free part of the map.
  if (!full && workspaceState.node !== null) sceneWorkspaceCamera(workspaceState.node);
}

/** The grip at the left edge: drag it to change the width; release it and the width is remembered. */
function workspaceResizer(panel) {
  const grip = el("div", "workspace-resizer");
  grip.title = tx("Drag to change the width");
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("active");
    const stage = document.getElementById("mapStage").getBoundingClientRect();
    const move = (moveEvent) => {
      const width = Math.round(stage.right - moveEvent.clientX);
      atlasState.ui.workspaceWidth = Math.min(Math.max(width, WORKSPACE_MIN_WIDTH), Math.max(WORKSPACE_MIN_WIDTH, stage.width - 160));
      applyWorkspaceSize();
    };
    const up = () => {
      grip.classList.remove("active");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      setPanel("workspaceWidth", atlasState.ui.workspaceWidth);
      if (workspaceState.node !== null) sceneWorkspaceCamera(workspaceState.node);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  // A double click on the grip restores the default width.
  grip.addEventListener("dblclick", () => {
    setPanel("workspaceWidth", null);
    applyWorkspaceSize();
    if (workspaceState.node !== null) sceneWorkspaceCamera(workspaceState.node);
  });
  return grip;
}

// --- tabs -----------------------------------------------------------------------

/**
 * Agent tasks. First the controller tasks under the contract (the task board of
 * the trusted host): for the world lead, all it gave out; for an agent, those
 * given to it, and whether it takes tasks at all. Then what the catalog shows:
 * the running operation, the last one, pending questions and what the person asked
 * the agent to do in the conversation. The progress field in the catalog is always empty, and it must not be made up.
 */
function renderTasks(body, agent) {
  if (agent.settings?.role === "coordinator") {
    body.append(el("div", "section-title", tx("Tasks given out")));
    const tasks = el("div");
    body.append(tasks);
    taskBoardList(tasks, { empty: tx("The world lead has not given desk agents any tasks yet.") });
  } else {
    deskAgentSection(body, agent);
    body.append(el("div", "section-title", tx("Tasks from the world lead")));
    const tasks = el("div");
    body.append(tasks);
    taskBoardList(tasks, { agentId: agent.agentId, showAgent: false,
      empty: tx("This agent has not been given any controller tasks.") });
  }
  body.append(el("div", "section-title", tx("Now")));
  body.append(infoRow(tx("running operation"), agent.currentOperationId));
  body.append(infoRow(tx("last operation"), agent.lastOperation === null
    ? null : `${agent.lastOperation.operationId} · ${agent.lastOperation.state}`));
  body.append(infoRow(tx("state"), agent.state));
  body.append(infoRow(tx("task progress"), agent.taskProgress));
  renderAttentionFacts(body, agent.attention);

  // A separate read of the agent card (query.memory.agent.read), not a catalog row.
  const card = el("div");
  const read = actionButton(tx("Read agent details"), "query.memory.agent.read", async () => {
    read.disabled = true;
    const response = await window.atlas.agentRead({ agentId: agent.agentId });
    read.disabled = false;
    if (!response.ok) {
      card.replaceChildren(noteBlock("error", tx("Not read: {code}", { code: response.error.code })));
      return;
    }
    const envelope = response.result;
    if (envelope.outcome !== "succeeded") {
      card.replaceChildren(noteBlock("error", tx("Read: {outcome} ({value})", { outcome: envelope.outcome, value: envelope.error?.code ?? tx("no code") })));
      return;
    }
    const fresh = envelope.output;
    card.replaceChildren(
      infoRow(tx("read at"), envelope.completedAtUtc),
      infoRow(tx("state"), fresh.state),
      infoRow(tx("delivery"), fresh.deliveryState),
      infoRow(tx("memory"), fresh.contentState),
      infoRow(tx("archive coverage"), fresh.coverage),
    );
  });
  const readActions = el("div", "actions");
  readActions.append(read);
  body.append(readActions, card);

  const result = el("div");
  if (agent.currentOperationId !== null) {
    const actions = el("div", "actions");
    actions.append(receiptButton(
      { agentId: agent.agentId, operationId: agent.currentOperationId }, result,
    ));
    body.append(actions, result);
  }
  body.append(noteBlock("note",
    tx("“Running” does not mean “the task is being done”: the backend reports the life cycle of the operation, ")
    + tx("not the progress of the work. Progress stays empty until it starts being reported.")));

  const world = atlasState.world;
  const pending = world !== null && world.status === "ready"
    ? world.attention.filter((item) => item.agentId === agent.agentId && item.kind === "interaction")
    : [];
  body.append(el("div", "section-title", tx("Waiting for an answer · {length}", { length: pending.length })));
  if (pending.length === 0) body.append(el("div", "empty", tx("No questions are waiting for you.")));
  for (const item of pending) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title", item.title || item.interactionId));
    box.append(el("div", "entry-text", tx("due {value}", { value: item.deadlineAtUtc ?? tx("workspace::not reported") })));
    const go = el("button", "small", tx("Go to questions"));
    go.addEventListener("click", () => {
      workspaceState.tab = "questions";
      renderWorkspace();
    });
    box.append(go);
    body.append(box);
  }

  body.append(el("div", "section-title", tx("What was assigned")));
  const feed = workspaceState.feed;
  if (feed === null || feed.agentId !== agent.agentId || feed.readAt === null) {
    const actions = el("div", "actions");
    actions.append(actionButton(tx("Read conversation"), "query.memory.agent.archive", async () => {
      await readFeed(agent);
      renderWorkspace();
    }));
    body.append(actions);
    body.append(el("div", "empty",
      feed?.error ? tx("Conversation not read: {error}.", { error: feed.error })
        : tx("Assignments are visible from the captured conversation, so read it first.")));
    return;
  }
  const asked = feedEntries(feed).filter((entry) => entry.record.kind === "submission"
    || entry.record.role === "user");
  if (asked.length === 0) {
    body.append(el("div", "empty", tx("No assignments are visible in the captured part of the conversation.")));
  }
  for (const entry of asked.slice(-12).reverse()) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title",
      `${timeOf(entry.record) ?? ""} · ${RECORD_STATE_LABELS[entry.record.state] ?? entry.record.state}`));
    box.append(el("div", "entry-text", entry.record.text ?? tx("(text not captured)")));
    body.append(box);
  }
  body.append(noteBlock("note",
    tx("These are records the backend captured, not a task list: which of the assigned work is done, ")
    + tx("it does not report.")));
}

/** Captured attention from the catalog: null means “no data”, never 0. */
function renderAttentionFacts(body, attention) {
  const facts = attentionFacts(attention);
  body.append(el("div", "section-title", tx("Attention in the catalog")));
  body.append(infoRow(tx("questions waiting"), facts.questions));
  body.append(infoRow(tx("approvals waiting"), facts.approvals));
  body.append(infoRow(tx("recovery needed"), facts.recovery));
  body.append(infoRow(tx("observed"), facts.observedAtUtc ?? tx("no data")));
  body.append(el("div", "muted", facts.summary));
}

function renderContext(body, agent) {
  body.append(el("div", "section-title", tx("Requested profile")));
  if (agent.profile === null || agent.profile === undefined) {
    body.append(el("div", "empty", tx("The catalog did not report a profile.")));
  } else {
    body.append(infoRow(tx("provider"), agent.profile.provider));
    body.append(infoRow(tx("model"), agent.profile.model));
    body.append(infoRow(tx("effort"), agent.profile.reasoningEffort));
    body.append(infoRow(tx("model fallback"), agent.profile.fallbackPolicy === "deny" ? tx("denied") : agent.profile.fallbackPolicy));
    body.append(noteBlock("note",
      tx("This is the profile requested when the agent was created. What effort the provider actually applied, ")
      + tx("the backend does not report, and it does not follow from this.")));
  }
  body.append(el("div", "section-title", tx("Memory")));
  // Whether the agent changes its own memory without asking (the person's setting, memory-changes.mjs).
  const autonomy = el("label", "memory-autonomy");
  const tick = el("input");
  tick.type = "checkbox";
  tick.id = "memoryAutonomy";
  tick.disabled = true;
  autonomy.append(tick, el("span", null, tx("Changes its own memory without asking")));
  autonomy.title = tx("Off: each change of its own memory waits for you in the chat. On: written at once, in the History with Undo. ")
    + tx("Changes of a quarter's or a project's memory always wait for you.");
  body.append(autonomy);
  readPermissionModes().then((modes) => {
    tick.checked = modes?.memoryAutonomy?.get(agent.agentId) === true;
    tick.disabled = modes === null;
  });
  tick.addEventListener("change", async () => {
    const wanted = tick.checked;
    tick.disabled = true;
    const response = await window.atlas.setMemoryAutonomy({ agentId: agent.agentId, allowed: wanted });
    const modes = await readPermissionModes({ force: true });
    tick.checked = modes?.memoryAutonomy?.get(agent.agentId) === true;
    tick.disabled = modes === null;
    if (!response.ok && response.error?.reasonCode !== "declined") {
      autonomy.after(noteBlock("error", tx("Not changed: {code}.", { code: response.error?.reasonCode || response.error?.code })));
    }
  });
  body.append(infoRow(tx("project"), agent.projectId));
  body.append(infoRow(tx("quarter"), agent.quarterId));
  body.append(infoRow(tx("current operation"), agent.currentOperationId));
  body.append(infoRow(tx("required memory"), agent.requiredManifest
    ? tx("project rev. {revision}, quarter rev. {revision2}", { revision: agent.requiredManifest.project.revision, revision2: agent.requiredManifest.quarter.revision })
    : null));
  body.append(infoRow(tx("delivered memory"), agent.deliveredManifest
    ? tx("project rev. {revision}, quarter rev. {revision2}", { revision: agent.deliveredManifest.project.revision, revision2: agent.deliveredManifest.quarter.revision })
    : null));
  if (agent.deliveredManifest === null) {
    body.append(noteBlock("note",
      tx("Memory has not been delivered yet. Edits apply to the next send; a running turn keeps its own.")));
  }
  const actions = el("div", "actions");
  const shown = el("div");
  actions.append(actionButton(tx("Read agent memory"), "query.memory.agent.context", async () => {
    const response = await window.atlas.agentContext({ agentId: agent.agentId });
    shown.replaceChildren();
    if (!response.ok || response.result.outcome !== "succeeded") {
      shown.append(noteBlock("error", tx("Agent memory not read. It is unknown, not empty.")));
      return;
    }
    const output = response.result.output;
    shown.append(infoRow(tx("content state"), output.contentState));
    shown.append(infoRow(tx("delivery"), output.deliveryState));
    shown.append(infoRow(tx("manifest fingerprint"), String(output.manifestHash ?? "").slice(0, 16)));
    // The third one is the agent's own memory: only the agent receives it.
    const scopes = [[tx("Project memory"), output.project], [tx("Quarter memory"), output.quarter],
      ...(output.agent ? [[tx("Agent's own memory"), output.agent]] : [])];
    for (const [title, scope] of scopes) {
      shown.append(el("div", "section-title", tx("{title} · {value}", { title, value: scope ? scope.scopeId : tx("workspace2::not reported") })));
      if (!scope) continue;
      // The person edits any memory here by hand - an entry's title and text, removing or adding one
      // (the owner looked for it, 01.11): the same sheet as the memory buttons below.
      if (atlasState.info?.mode !== "direct") {
        const edit = actionButton(tx("Edit"), "query.memory.scope.read", () => openMemorySheet(scope.scopeId, title));
        edit.classList.add("memory-edit");
        shown.append(edit);
      }
      shown.append(infoRow(tx("revision"), scope.revision));
      const entries = scope.entries ?? [];
      if (entries.length === 0) shown.append(el("div", "empty", tx("Empty. An empty memory is allowed.")));
      for (const entry of entries) {
        const box = el("div", "entry");
        box.append(el("div", "entry-title", entry.title || entry.id));
        box.append(el("div", "entry-text", entry.text));
        shown.append(box);
      }
    }
  }));
  if (atlasState.info?.mode !== "direct" && typeof agent.agentScopeId === "string") {
    // The agent's own memory is edited with the same sheet as project and quarter memory.
    actions.append(actionButton(tx("Edit agent memory"), "query.memory.scope.read",
      () => openMemorySheet(agent.agentScopeId, tx("Agent memory · {agentId}", { agentId: agent.agentId }))));
  }
  body.append(actions, shown);
  if (atlasState.info?.mode === "direct") renderAgentNotes(body, agent);
  else renderLiveMemoryDocument(body, agent);
  body.append(noteBlock("note",
    tx("“Context” here is the memory the agent works with: the entries of the project memory, ")
    + tx("the quarter memory and its own memory, and which revision of them was delivered to it. This is not the context window of the model, ")
    + tx("not the conversation and not the files it opened: the backend does not report those.")));
}

const DOCUMENT_REFUSALS = Object.freeze({
  memory_document_missing: tx("no document at this path"),
  memory_document_path_invalid: tx("the path must lead to a file inside the project folder"),
  memory_document_not_a_file: tx("this path is not a file"),
  memory_document_empty: tx("the document has no “## …” entries"),
  memory_document_too_large: tx("the document is too large"),
  memory_document_too_many_entries: tx("the document has more entries than memory can hold"),
  memory_document_changed: tx("the document changed while you were approving it — show it again"),
  memory_document_target_denied: tx("this agent may not write to this memory"),
  memory_revision_conflict: tx("this memory has changed — show the document again"),
  memory_workspace_required: tx("the project has no folder bound"),
  memory_agent_closed: tx("agent archived"),
  document_path_invalid: tx("the path must lead to a file inside the project folder"),
});
const documentRefusal = (error) => DOCUMENT_REFUSALS[error?.reasonCode] ?? DOCUMENT_REFUSALS[error?.code]
  ?? error?.reasonCode ?? error?.code ?? tx("no code");

/** Where a memory goes as a document of the project folder, by default. */
const defaultDocumentPath = (agent, kind) => (kind === "project" ? "docs/memory/project.md"
  : kind === "quarter" ? `docs/memory/${agent.quarterId}.md` : `docs/memory/${agent.agentId}.md`);

/**
 * Live mode: a memory in a text editor (the owner's choice of 01.11). Atlas writes the chosen memory
 * as a Markdown file of the project folder (“## …” headings are its entries) and opens it in the
 * person's editor; “Load back” shows what the edited file changes, and approving writes exactly
 * that text (its SHA-256). An agent may write such a document too, for a long rewrite.
 */
function renderLiveMemoryDocument(body, agent) {
  body.append(el("div", "section-title", tx("Memory in a text editor")));
  body.append(el("div", "muted", tx("Open a memory as a Markdown file of the project folder in your text editor: each “## …” heading is one entry. ")
    + tx("Edit it, save it, then press “Load back”: you see what changes and approve it.")));
  body.append(el("div", "muted", tx("An agent may write such a file too, for a long rewrite: enter its path and press “Load back”. ")
    + tx("The agent's usual memory changes come as cards in its chat and need no file.")));
  const role = agent.settings?.role ?? "feature";
  const targets = [["agent", tx("Agent's own memory")]];
  if (role === "project-lead") targets.unshift(["project", tx("Project memory")]);
  if (role === "quarter-lead") targets.unshift(["quarter", tx("Quarter memory")]);
  workspaceState.documentPaths ??= new Map();
  const target = el("select", "field");
  for (const [value, label] of targets) {
    const option = el("option", null, label);
    option.value = value;
    target.append(option);
  }
  const pathInput = el("input", "field");
  pathInput.placeholder = defaultDocumentPath(agent, target.value);
  pathInput.value = workspaceState.documentPaths.get(agent.agentId) ?? defaultDocumentPath(agent, target.value);
  pathInput.addEventListener("input", () => workspaceState.documentPaths.set(agent.agentId, pathInput.value));
  // Another memory chosen: its own file, unless the person typed a path of their own.
  target.addEventListener("change", () => {
    pathInput.placeholder = defaultDocumentPath(agent, target.value);
    if (!workspaceState.documentPaths.has(agent.agentId)) pathInput.value = defaultDocumentPath(agent, target.value);
  });
  const shown = el("div");
  const result = el("div");
  const openInEditor = async () => {
    result.replaceChildren();
    shown.replaceChildren(el("div", "muted", tx("Writing the file…")));
    const answer = await window.atlas.exportMemoryDocument({ agentId: agent.agentId, projectId: agent.projectId,
      path: pathInput.value.trim(), target: target.value });
    shown.replaceChildren();
    if (!answer.ok) {
      if (answer.error?.code === "user_declined") return;
      shown.append(noteBlock("error", tx("Not opened: {value}.", { value: documentRefusal(answer.error) })));
      return;
    }
    const { path, state, opened } = answer.data;
    const said = { written: tx("Wrote “{path}” from the memory.", { path }),
      same: tx("“{path}” is the memory as it is.", { path }),
      replaced: tx("Replaced “{path}” with the memory as it is.", { path }),
      kept: tx("“{path}” is kept as it is, with its edits.", { path }) }[state] ?? path;
    shown.append(noteBlock("note", `${said} ${opened ? tx("It is open in your text editor: edit it, save it, then press “Load back”.")
      : tx("The editor did not open: open the file in the project folder yourself, then press “Load back”.")}`));
  };
  const showPreview = async () => {
    result.replaceChildren();
    if (pathInput.value.trim() === "") {
      shown.replaceChildren(noteBlock("note", tx("Enter the path of the file: the one Atlas opened, or the one the agent named in its chat.")));
      return;
    }
    shown.replaceChildren(el("div", "muted", tx("Reading the document…")));
    const answer = await window.atlas.previewMemoryDocument({ agentId: agent.agentId, path: pathInput.value.trim(),
      target: target.value });
    shown.replaceChildren();
    if (!answer.ok) {
      shown.append(noteBlock("error", tx("Document not read: {value}.", { value: documentRefusal(answer.error) })));
      return;
    }
    const data = answer.data;
    const into = targets.find(([value]) => value === data.target.kind)?.[1] ?? data.target.kind;
    shown.append(infoRow(tx("document"), data.path));
    shown.append(infoRow(tx("to"), tx("{into}{value}", { into, value: data.target.revision === null ? "" : tx(" · now rev. {revision}", { revision: data.target.revision }) })));
    shown.append(infoRow(tx("size"), data.bytes === null ? null : tx("{bytes} bytes", { bytes: data.bytes })));
    shown.append(infoRow("SHA-256", `${data.contentSha256.slice(0, 16)}…`));
    // What approving changes, entry by entry: + added, ~ changed, − removed, = the same.
    const changes = Array.isArray(data.changes) && data.changes.length > 0 ? data.changes : null;
    const changed = changes === null ? null : changes.filter((item) => item.change !== "same").length;
    shown.append(el("div", "section-title", changes === null ? tx("Entries · {length}", { length: data.entries.length })
      : tx("Entries · {length} · changes · {changed}", { length: data.entries.length, changed })));
    if (changed === 0) shown.append(noteBlock("note", tx("Nothing changes: the file is the memory as it is.")));
    for (const entry of changes ?? data.entries) {
      const row = el("div", `entry${entry.change ? ` memory-change-${entry.change}` : ""}`);
      const mark = { added: "+", changed: "~", removed: "−", same: "=" }[entry.change] ?? null;
      const title = el("div", "entry-title", entry.title || tx("(no heading)"));
      if (mark !== null) title.prepend(el("span", "plan-step-mark", mark));
      row.append(title);
      if (entry.change) row.append(el("div", "entry-text", { added: tx("will be added"), changed: tx("will change"),
        removed: tx("will be removed"), same: tx("stays the same") }[entry.change]));
      else if (entry.characters !== null) row.append(el("div", "entry-text", tx("{characters} chars", { characters: entry.characters })));
      shown.append(row);
    }
    if (data.excerpt !== "") {
      const start = el("details");
      start.append(el("summary", null, tx("Start of the document")), el("pre", "feed-activity-text", data.excerpt));
      shown.append(start);
    }
    const approve = (apply) => async () => {
      const done = await window.atlas.approveMemoryDocument({ agentId: agent.agentId, path: data.path,
        target: data.target.kind, apply });
      if (!done.ok) {
        if (done.error?.code === "user_declined") return;
        atlasRecord("bad", tx("memory document not approved"), `${agent.agentId} · ${documentRefusal(done.error)}`);
        result.replaceChildren(noteBlock("error", tx("Not approved: {value}.", { value: documentRefusal(done.error) })));
        return;
      }
      atlasRecord("ok", done.data.applied ? tx("memory document written") : tx("memory document approved"),
        tx("{agentId} · {path}{value}", { agentId: agent.agentId, path: data.path, value: done.data.applied ? tx(" · revision {revision}", { revision: done.data.revision }) : "" }));
      result.replaceChildren(noteBlock("note", done.data.applied
        ? tx("Written: {value}, revision {revision}. The agent will get it with the next message.", { value: into.toLowerCase(), revision: done.data.revision })
        : tx("Approved. The agent will write exactly this text with its write_memory_from_document tool.")));
      await refresh();
    };
    const buttons = el("div", "actions");
    const approveOnly = trustedButton(tx("Approve"), approve(false));
    approveOnly.title = tx("The agent will write this document to memory itself with its tool — exactly this text.");
    const approveWrite = trustedButton(tx("Approve and write"), approve(true), { primary: true });
    approveWrite.title = tx("Write to memory now, without an agent turn.");
    buttons.append(approveOnly, approveWrite);
    shown.append(buttons);
  };
  const actions = el("div", "actions");
  actions.append(trustedButton(tx("Open in text editor"), openInEditor, { primary: true }), trustedButton(tx("Load back"), showPreview));
  body.append(target, pathInput, actions, shown, result);
}

/**
 * Direct mode: the agent's own memory (notes that only it receives) and
 * its write zone. The person writes them (with confirmation), like the two other memories.
 * The desk code holds the zone: Claude Code will not edit a file outside it.
 */
function renderAgentNotes(body, agent) {
  body.append(el("div", "section-title", tx("Agent memory")));
  const box = el("div");
  box.append(el("div", "muted", tx("workspace::Reading…")));
  body.append(box);
  window.atlas.agentNotes({ agentId: agent.agentId }).then((response) => {
    box.replaceChildren();
    if (!response.ok) {
      box.append(noteBlock("error", tx("Agent memory not read: {value}. It is unknown, not empty.", { value: response.error?.reasonCode ?? response.error?.code ?? tx("no code") })));
      return;
    }
    const notes = response.data;
    const draft = workspaceState.notesDraft?.agentId === agent.agentId ? workspaceState.notesDraft.text : null;
    box.append(infoRow(tx("revision"), notes.revision === 0 ? tx("not saved yet") : notes.revision));
    box.append(infoRow(tx("delivery"), notes.delivered ? tx("the agent has received it") : tx("goes with the next message")));
    box.append(el("div", "muted", tx("Notes: what this agent works on and how. Only this agent receives them.")));
    const text = el("textarea");
    text.rows = 10;
    text.value = [notes.entries.map((entry) => entry.text).join("\n\n"), draft]
      .filter((part) => typeof part === "string" && part.trim() !== "").join("\n\n");
    text.placeholder = tx("Its feature, key files, how things work, agreements with other agents.");
    box.append(text);
    box.append(el("div", "muted", tx("Write zone: where the agent may change files, one path per line, from the root of the project folder. Empty means the whole folder.")));
    const zone = el("textarea");
    zone.rows = 4;
    zone.value = notes.writeZone.join("\n");
    zone.placeholder = "tools/jointsolver/**";
    box.append(zone);
    box.append(noteBlock("note",
      tx("The desk itself refuses a file edit outside the zone, before it happens; the agent can read everything. ")
      + tx("While a zone is set, the agent runs every terminal command only with your permission: a command could change a file bypassing the zone.")));
    if (draft !== null) box.append(noteBlock("note", tx("The agent's answer was added to the end of the notes. Check it and save.")));
    const result = el("div");
    const actions = el("div", "actions");
    const save = el("button", "primary", tx("Save agent memory"));
    save.addEventListener("click", async () => {
      save.disabled = true;
      const written = text.value.trim();
      const entries = written === "" ? [] : [{ id: "agent-notes", title: tx("Agent notes"), text: written }];
      const writeZone = zone.value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
      const saved = await window.atlas.saveAgentNotes({ agentId: agent.agentId, expectedRevision: notes.revision, entries, writeZone });
      save.disabled = false;
      if (!saved.ok) {
        if (saved.error?.code === "user_declined") return;
        result.replaceChildren(noteBlock("error", saved.error?.code === "stale_revision"
          ? tx("Agent memory has already changed: reread the tab. Nothing was overwritten.")
          : tx("Not saved: {value}.", { value: saved.error?.reasonCode ?? saved.error?.code ?? tx("no code") })));
        return;
      }
      if (workspaceState.notesDraft?.agentId === agent.agentId) workspaceState.notesDraft = null;
      atlasRecord("ok", tx("agent memory saved"), tx("{agentId} · revision {revision}", { agentId: agent.agentId, revision: saved.data.revision }));
      renderWorkspace();
    });
    actions.append(save);
    box.append(actions, result);
    renderAgentRole(box, agent, notes);
    renderMemoryDocument(box, agent, notes);
  });
}

const ROLE_LABELS = Object.freeze([["feature", tx("feature agent")], ["quarter-lead", tx("workspace::quarter lead")], ["project-lead", tx("workspace::project lead")]]);

/** Agent role: a feature agent or a lead, of the project (the whole project) or of a quarter (a tool and its agents). */
function renderAgentRole(box, agent, notes) {
  box.append(el("div", "section-title", tx("Role")));
  const select = el("select");
  for (const [value, label] of ROLE_LABELS) {
    const option = el("option", null, label);
    option.value = value;
    select.append(option);
  }
  select.value = notes.role;
  const result = el("div");
  const save = el("button", null, tx("Save role"));
  save.addEventListener("click", async () => {
    save.disabled = true;
    const saved = await window.atlas.setAgentRole({ agentId: agent.agentId, role: select.value });
    save.disabled = false;
    if (!saved.ok) {
      if (saved.error?.code === "user_declined") return;
      result.replaceChildren(noteBlock("error", saved.error?.reasonCode === "lead_taken"
        ? tx("A lead already exists: {value}. Make it a feature agent first.", { value: saved.error.message ?? "" })
        : tx("Role not saved: {value}.", { value: saved.error?.reasonCode ?? saved.error?.code ?? tx("no code") })));
      return;
    }
    atlasRecord("ok", tx("agent role"), `${agent.agentId} · ${ROLE_LABELS.find(([value]) => value === saved.data.role)?.[1] ?? saved.data.role}`);
    renderWorkspace();
  });
  const row = el("div", "actions");
  row.append(select, save);
  box.append(row, result);
  box.append(noteBlock("note",
    tx("The project lead receives the memory of all quarters; a quarter lead receives the notes and zones of the agents of its quarter. ")
    + tx("A lead does not change code: by default its zone is docs/memory/, where it writes memory documents.")));
}

/**
 * Memory document: the agent writes notes into a project file, you read it in the
 * “Files” tab and approve it here. Code writes it to memory — the agent's tool or
 * your button — and only the text you approved.
 */
function renderMemoryDocument(box, agent, notes) {
  box.append(el("div", "section-title", tx("Memory document")));
  box.append(el("div", "muted",
    tx("Path to the document from the root of the project folder. “## …” headings become separate memory entries.")));
  const pathInput = el("input");
  pathInput.placeholder = notes.role === "feature" ? tx("tools/my-feature/NOTES.md") : "docs/memory/project.md";
  const target = el("select");
  for (const item of notes.targets) {
    const option = el("option", null, item.title);
    option.value = `${item.kind}:${item.id}`;
    target.append(option);
  }
  box.append(pathInput, target);
  const result = el("div");
  const approve = (apply) => async () => {
    const [kind, ...rest] = target.value.split(":");
    const answer = await window.atlas.approveMemoryDocument({ agentId: agent.agentId, path: pathInput.value.trim(), target: { kind, id: rest.join(":") }, apply });
    if (!answer.ok) {
      if (answer.error?.code === "user_declined") return;
      const why = {
        document_missing: tx("no document at this path"), document_path_invalid: tx("the path must lead to a file inside the project folder"),
        document_empty: tx("the document is empty"), document_changed: tx("the document changed while you were approving it — open it again"),
        memory_changed: tx("this memory has changed — approve the document again"), memory_target_not_allowed: tx("this agent may not write to this memory"),
      }[answer.error?.reasonCode] ?? (answer.error?.reasonCode ?? answer.error?.code ?? tx("no code"));
      result.replaceChildren(noteBlock("error", tx("Not approved: {why}.", { why })));
      return;
    }
    atlasRecord("ok", answer.data.applied ? tx("memory document written") : tx("memory document approved"),
      tx("{agentId} · {value}{value2}", { agentId: agent.agentId, value: pathInput.value.trim(), value2: answer.data.applied ? tx(" · revision {revision}", { revision: answer.data.revision }) : "" }));
    renderWorkspace();
  };
  const actions = el("div", "actions");
  const approveOnly = el("button", null, tx("Approve"));
  approveOnly.title = tx("The agent will write this document to memory itself with its tool — exactly this text.");
  approveOnly.addEventListener("click", approve(false));
  const approveWrite = el("button", "primary", tx("Approve and write"));
  approveWrite.title = tx("Write to memory now, without an agent turn.");
  approveWrite.addEventListener("click", approve(true));
  actions.append(approveOnly, approveWrite);
  box.append(actions, result);
  if (notes.grants.length > 0) {
    box.append(el("div", "muted", tx("Approvals of this agent")));
    for (const grant of [...notes.grants].reverse()) {
      const state = grant.writtenRevision !== null ? tx("written, revision {writtenRevision}", { writtenRevision: grant.writtenRevision })
        : grant.supersededAtUtc !== null ? tx("replaced by a newer approval") : tx("approved, waiting to be written");
      box.append(infoRow(`${grant.path} → ${grant.targetTitle}`, state));
    }
  }
}

// --- conversation: feed -------------------------------------------------------
//
// The feed is built from the archive the backend captured. The contract does not set the order
// of pages, but every record has an identifier and sequence numbers: a record
// is kept in its latest state (the highest `sequence`) and shown in the
// order of its first appearance (`firstSequence`). This keeps the feed correct for any
// backend design.

const FEED_PAGE_LIMIT = 50;
// How many pages are read per update: the archive is reread from the start,
// and the limit keeps a very long history from turning every update into a full
// read. “Read the whole archive” lifts it once.
const FEED_LIVE_PAGES = 10;
const FEED_FULL_PAGES = 200;
const FEED_REFRESH_MS = 5000;
// While a turn runs - more often: the answer in the chat must not lag behind the trace (read every 2.5 s).
const FEED_RUNNING_MS = 1500;

const RECORD_STATE_LABELS = Object.freeze({
  requested: tx("workspace::requested"), accepted: tx("workspace::accepted"), started: tx("workspace::started"), completed: tx("workspace::completed"),
  failed: tx("failed"), interrupted: tx("workspace::interrupted"), uncertain: tx("workspace::uncertain"), unknown: tx("workspace::unknown"),
});

const OMISSION_LABELS = Object.freeze({
  hidden_reasoning: tx("hidden reasoning — not kept"),
  unsupported_content: tx("content the archive cannot store"),
  oversized_content: tx("too large — not captured"),
  inline_media: tx("inline images"),
  private_content: tx("private content"),
  content_not_provided: tx("the provider did not supply the content"),
  history_not_imported: tx("history before recording started was not imported"),
  provider_unavailable: tx("the provider was unavailable — not captured"),
  private_provider_payload: tx("private provider data"),
  unsafe_content: tx("unsafe content — not shown"),
  media_bytes: tx("binary data and images"),
  raw_log: tx("raw log — not shown"),
});

const LIVE_REASON_WORDS = Object.freeze({
  agent_unbound: tx("the agent is not bound to a conversation thread"),
  agent_archived: tx("the agent is archived — showing the captured archive"),
  provider_unavailable: tx("the provider is unavailable right now"),
  provider_identity_mismatch: tx("the thread belongs to another provider instance"),
});

const liveReadAvailable = () => ["query.agent-conversation.resolve", "query.agent-conversation.read"]
  .every((operationId) => operationStatus(operationId)?.status === "available");
const eventsAvailable = () => operationStatus("query.agent-events.read")?.status === "available";

const emptyLive = (agentId) => ({ agentId, loading: false, data: null, error: null, readAt: null, eventsNote: null });

// The last read conversation snapshot of each agent: a chat opened again
// shows it at once, while a fresh snapshot is being read (live.cached).
const liveCache = new Map();

function cachedLive(agentId) {
  const live = emptyLive(agentId);
  const cached = liveCache.get(agentId);
  if (cached !== undefined) Object.assign(live, { data: cached.data, readAt: cached.readAt, cached: true });
  return live;
}

/**
 * Live conversation by the agent's binding. The backend picks the thread; an archived agent
 * goes to the archive; an unavailable live read is “unavailable”, not
 * an empty chat. The host reads pages to the end or honestly says “partial” and
 * “stale”: here this is only shown.
 */
async function readLive(agent, { maxPages = null } = {}) {
  if (!liveReadAvailable()) {
    workspaceState.chatSource = "archive";
    return;
  }
  if (workspaceState.live === null || workspaceState.live.agentId !== agent.agentId) {
    workspaceState.live = emptyLive(agent.agentId);
  }
  const live = workspaceState.live;
  if (live.loading) return;
  live.loading = true;
  paintChat();
  const response = await window.atlas.conversation({ agentId: agent.agentId, ...(maxPages === null ? {} : { maxPages }) });
  live.loading = false;
  if (!response.ok) {
    if (live.error !== response.error.code) {
      atlasRecord("bad", tx("live conversation not read"), `${agent.agentId} ${response.error.code}`);
    }
    live.error = response.error.code;
  } else {
    live.data = response.data;
    live.error = null;
    live.readAt = new Date();
    live.cached = false;
    if (response.data.route === "live" && response.data.traversal?.status === "complete") {
      liveCache.set(agent.agentId, { data: response.data, readAt: live.readAt });
    }
    if (response.data.route !== "live") workspaceState.chatSource = "archive";
    else if (workspaceState.chatSource === null) workspaceState.chatSource = "live";
  }
  if (workspaceState.chatSource === "archive") {
    const feed = workspaceState.feed;
    if (feed === null || feed.agentId !== agent.agentId || (feed.readAt === null && !feed.loading)) readFeed(agent);
  }
  paintChat();
}

/**
 * Events are only a “read again” signal. The host keeps the head cursor taken before the snapshot and
 * continues from it; after a break or a restart it asks for a new snapshot.
 * A send, an answer or a change is never repeated from here.
 */
async function pollAgentEvents(agent) {
  const live = workspaceState.live;
  const restart = workspaceState.eventsRestart;
  workspaceState.eventsRestart = false;
  const response = await window.atlas.agentEvents({ agentId: agent.agentId, restart });
  if (live !== null && live.agentId === agent.agentId) {
    live.eventsNote = response.ok ? null : tx("events not read: {code}", { code: response.error.code });
  }
  if (!response.ok) {
    // Without events a snapshot is still needed: the conversation is read directly.
    if (live !== null && live.agentId === agent.agentId && (live.data === null || live.data.traversal === null)) {
      await readLive(agent);
    }
    paintChatStatus();
    return;
  }
  const { action, invalidate } = response.data;
  if (action === "snapshot") {
    workspaceState.questions = null;
    await readLive(agent);
    return;
  }
  if (action !== "invalidate") return;
  if (invalidate.includes("conversation")) {
    await readLive(agent);
    await refreshAgentTasks(agent);
    // A turn may have asked to change a memory.
    if (workspaceState.tab === "chat") await loadMemoryChanges(agent);
  }
  if (invalidate.includes("interactions") || invalidate.includes("attention")) {
    workspaceState.questions = null;
    await refresh();
  }
}

// --- markdown → page nodes ---------------------------------------------------------------
//
// Parsing is in markdown-core.js. Here the tree becomes nodes only through
// textContent: the agent's text cannot become page markup.

function markdownInline(tokens, parent) {
  for (const token of tokens) {
    if (token.kind === "text") {
      parent.append(token.text);
    } else if (token.kind === "code") {
      parent.append(el("code", "md-code", token.text));
    } else if (token.kind === "link") {
      // A link is not opened from the window: its text is shown, the address is in the tooltip.
      const link = el("span", "md-link");
      markdownInline(token.children, link);
      link.title = token.href;
      parent.append(link);
    } else {
      const node = el(token.kind === "strong" ? "strong" : "em");
      markdownInline(token.children, node);
      parent.append(node);
    }
  }
}

function markdownBlocks(blocks, parent) {
  for (const block of blocks) {
    if (block.kind === "heading") {
      const node = el("div", `md-heading md-h${Math.min(block.level, 4)}`);
      markdownInline(block.inline, node);
      parent.append(node);
    } else if (block.kind === "paragraph") {
      const node = el("p", "md-p");
      markdownInline(block.inline, node);
      parent.append(node);
    } else if (block.kind === "code") {
      const node = el("pre", "md-pre");
      if (block.language !== "") node.append(el("span", "md-pre-language", block.language));
      node.append(el("code", null, block.text));
      parent.append(node);
    } else if (block.kind === "rule") {
      parent.append(el("hr", "md-rule"));
    } else if (block.kind === "quote") {
      const node = el("blockquote", "md-quote");
      markdownBlocks(block.blocks, node);
      parent.append(node);
    } else if (block.kind === "list") {
      const list = el("div", "md-list");
      for (const item of block.items) {
        const row = el("div", `md-li md-depth-${item.depth}`);
        row.append(el("span", "md-marker", item.marker));
        const body = el("span", "md-li-text");
        markdownInline(item.inline, body);
        row.append(body);
        list.append(row);
      }
      parent.append(list);
    } else if (block.kind === "table") {
      const wrap = el("div", "md-table-wrap");
      const table = el("table", "md-table");
      const head = el("tr");
      for (const cell of block.head) {
        const th = el("th");
        markdownInline(cell, th);
        head.append(th);
      }
      const thead = el("thead");
      thead.append(head);
      const tbody = el("tbody");
      for (const row of block.rows) {
        const tr = el("tr");
        for (const cell of row) {
          const td = el("td");
          markdownInline(cell, td);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      parent.append(wrap);
    }
  }
}

function markdownNode(text, className) {
  const node = el("div", className ? `md ${className}` : "md");
  markdownBlocks(parseMarkdown(text), node);
  return node;
}

/** The expanded state of a block survives a feed repaint. */
function rememberOpen(node, key, openByDefault = false) {
  const flipped = workspaceState.openActivities.has(key);
  node.open = openByDefault ? !flipped : flipped;
  node.addEventListener("toggle", () => {
    if (node.open !== openByDefault) workspaceState.openActivities.add(key);
    else workspaceState.openActivities.delete(key);
  });
}

function liveRecord(item, { answer = false } = {}) {
  const kind = liveItemKind(item);
  const id = item.itemRef.authority.externalId;
  if (kind === "omission") return omissionMarker([item.omissionReason]);
  if (kind === "hidden-reasoning") {
    const node = el("details", "feed-thinking hidden-text");
    const summary = el("summary");
    summary.append(el("span", "feed-thinking-mark", "✻"), el("span", "feed-thinking-word", tx("workspace::thinking")),
      el("span", "feed-thinking-first", tx("the provider did not pass its text")));
    node.append(summary);
    summary.addEventListener("click", (event) => event.preventDefault());
    return node;
  }
  if (kind === "service") return el("div", "feed-service", liveItemBody(item));
  const time = chatTime(item.observedAtUtc) ?? "";
  if (kind === "reasoning") {
    // As in Claude Code: thinking is not an action window but muted italics
    // with its own label; collapsed to the first line, it expands in full.
    const node = el("details", "feed-thinking");
    rememberOpen(node, `live:${id}`);
    const summary = el("summary");
    summary.append(el("span", "feed-thinking-mark", "✻"), el("span", "feed-thinking-word", tx("workspace::thinking")),
      el("span", "feed-thinking-first", firstPlainLine(liveItemBody(item))));
    node.append(summary, markdownNode(liveItemBody(item), "feed-thinking-text"));
    return node;
  }
  if (kind === "action" || kind === "change") {
    const node = el("details", "feed-activity");
    rememberOpen(node, `live:${id}`);
    const summary = el("summary");
    summary.append(el("span", "feed-activity-kind", kind === "change" ? tx("change") : tx("action")));
    summary.append(el("span", "feed-activity-first", item.text.split(/\r?\n/u)[0]));
    node.append(summary, el("pre", "feed-activity-text", item.text));
    return node;
  }
  if (kind === "question") {
    const node = el("div", "feed-question");
    const asked = questionEntries(item.text);
    if (asked !== null) {
      // The agent's question and the person's answer, as in Claude Code: “· question → answer”.
      // A pending question waits for an answer in the card below the feed.
      node.classList.add(asked.state);
      const head = el("div", "feed-author");
      head.append(el("span", null, asked.head), el("time", null, time));
      const list = el("ul", "feed-question-list");
      for (const entry of asked.entries) {
        const row = el("li");
        row.append(el("div", "feed-question-text", entry.question));
        if (entry.answer !== null) row.append(el("div", "feed-question-answer", `→ ${entry.answer}`));
        list.append(row);
      }
      node.append(head, list);
      return node;
    }
    node.append(el("div", "feed-author", tx("Agent question")));
    node.append(el("div", "feed-text", item.text));
    const go = el("button", "small", tx("Go to questions"));
    go.addEventListener("click", () => {
      workspaceState.tab = "questions";
      renderWorkspace();
    });
    node.append(go);
    return node;
  }
  if (kind === "agent" && !answer) {
    // A remark during the work: what the agent said between actions.
    return markdownNode(item.text, "feed-note");
  }
  const mine = kind === "user";
  const node = el("div", `feed-message ${mine ? "mine" : "agent"}`);
  const head = el("div", "feed-author");
  head.append(el("span", null, mine ? tx("You") : tx("Agent")));
  head.append(el("time", null, time));
  // Your own text is shown as typed; the agent's answer is shown with markup.
  node.append(head, mine ? el("div", "feed-text", item.text) : markdownNode(item.text, "feed-text"));
  if (!mine && answer && atlasState.info?.mode === "direct" && workspaceState.node !== null) {
    // The agent's answer about its feature can go into its memory: the person saves it on the “Memory” tab.
    const keep = el("button", "small", tx("Add to agent memory"));
    keep.title = tx("Add this answer to the notes of the agent. Only the agent receives them; you save them.");
    const agentId = workspaceState.node.agentId;
    keep.addEventListener("click", () => {
      workspaceState.notesDraft = { agentId, text: item.text };
      workspaceState.tab = "context";
      renderWorkspace();
    });
    node.append(keep);
  }
  return node;
}

/** Collapsed work of the turn: actions, thinking, remarks along the way. While the turn is running, it is expanded. */
function liveWork(items, turn, going) {
  const node = el("details", "feed-work");
  rememberOpen(node, `work:${items[0].itemRef.authority.externalId}`, going);
  const summary = el("summary");
  const duration = going ? null : durationWords(turn?.startedAtUtc, turn?.completedAtUtc);
  summary.append(el("span", "feed-work-title", going ? tx("The agent is working") : tx("Work log")));
  const words = [workSummary(items), duration].filter((part) => part !== null && part !== "").join(" · ");
  if (words !== "") summary.append(el("span", "feed-work-words", words));
  const body = el("div", "feed-work-body");
  for (const item of items) body.append(liveRecord(item));
  node.append(summary, body);
  return node;
}

function paintLive(container) {
  const live = workspaceState.live;
  const data = live?.data ?? null;
  if (data === null) {
    container.append(el("div", "empty", live?.error
      ? tx("Live conversation not read: {error}. It is unknown, not empty.", { error: live.error })
      : tx("Reading the live conversation…")));
    return;
  }
  const traversal = data.traversal;
  if (traversal === null) {
    container.append(el("div", "empty", tx("Reading the live conversation…")));
    return;
  }
  if (traversal.status === "stale") {
    container.append(el("div", "empty",
      tx("The conversation changed while it was being read. Different snapshots are not stitched together — read it again.")));
    return;
  }
  if (traversal.status === "invalid") {
    container.append(el("div", "empty", tx("The backend returned a page of another conversation — it is not shown.")));
    return;
  }
  if (traversal.status === "failed") {
    container.append(el("div", "empty",
      tx("Live conversation not read: {value}. It is unknown, not empty.", { value: traversal.code ?? traversal.reasonCode ?? tx("error") })));
    return;
  }
  if (data.content.length === 0) {
    container.append(el("div", "empty", tx("No records in the conversation yet.")));
    return;
  }
  const turns = new Map(data.turns.map((turn) => [turn.turnRef.authority.externalId, turn]));
  const groups = [];
  for (const item of data.content) {
    const turnId = item.turnRef.authority.externalId;
    if (groups.length === 0 || groups[groups.length - 1].turnId !== turnId) groups.push({ turnId, items: [] });
    groups[groups.length - 1].items.push(item);
  }
  groups.forEach((group, index) => {
    const box = el("section", "feed-turn");
    const turn = turns.get(group.turnId);
    const state = turn?.state;
    const head = el("div", "feed-turn-head", tx("Turn {value}", { value: index + 1 }));
    if (state && state !== "completed") head.append(el("span", `feed-state state-${state}`, RECORD_STATE_LABELS[state] ?? state));
    box.append(head);
    // As in Codex: message, collapsed work, answer. The split is in feed-core.js.
    const going = state === "active" || state === "pending";
    for (const segment of liveTurnSegments(group.items, state)) {
      if (segment.kind === "work") box.append(liveWork(segment.items, turn, going));
      else box.append(liveRecord(segment.item, { answer: segment.kind === "answer" }));
    }
    if (going) box.append(livePulse(group.items, turn));
    container.append(box);
  });
}

/**
 * What the agent is doing right now, while the turn is running, like the “✻ Thinking…” line of
 * Claude Code: running a command (the last action is still running), waiting for an answer to a
 * question, or thinking. Records arrive whole, so without this line
 * thinking that is still going on is not visible at all. The time is how long the turn has been running.
 */
function livePulse(items, turn) {
  const last = items[items.length - 1] ?? null;
  const kind = last === null ? null : liveItemKind(last);
  const firstLine = last === null ? "" : String(last.text ?? "").split(/\r?\n/u)[0];
  const running = kind === "action" && firstLine.includes(tx(" · running"));
  const waiting = kind === "question" && questionEntries(last.text ?? "")?.state === "asking";
  const node = el("div", `feed-pulse${running ? " running" : waiting ? " waiting" : ""}`);
  node.append(el("span", "feed-pulse-mark", running ? "⏵" : waiting ? "?" : "✻"));
  node.append(el("span", "feed-pulse-word", running ? tx("Running") : waiting ? tx("Waiting for your answer") : tx("Thinking…")));
  const time = el("span", "feed-pulse-time");
  const since = Date.parse(turn?.startedAtUtc ?? items[0]?.observedAtUtc ?? "");
  time.dataset.since = String(Number.isFinite(since) ? since : Date.now());
  time.textContent = tx("turn running {value}", { value: elapsedWords(Date.now() - Number(time.dataset.since)) });
  node.append(time);
  if (running) node.append(el("span", "feed-pulse-what", firstLine.replace(tx(" · running"), "")));
  tickPulses();
  return node;
}

/** «0:42», «12:05», «1:02:03». */
function elapsedWords(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// The time on the line of a running turn ticks on its own, without a feed repaint.
let pulseTimer = null;
function tickPulses() {
  const pulses = document.querySelectorAll(".feed-pulse-time");
  for (const time of pulses) time.textContent = tx("turn running {value}", { value: elapsedWords(Date.now() - Number(time.dataset.since)) });
  if (pulseTimer === null) {
    pulseTimer = setInterval(() => {
      if (document.querySelector(".feed-pulse-time") === null) {
        clearInterval(pulseTimer);
        pulseTimer = null;
        return;
      }
      tickPulses();
    }, 1000);
  }
}

const emptyFeed = (agentId) => ({
  agentId, records: new Map(), revision: null, coverage: null, exhausted: false,
  restarted: false, loading: false, error: null, readAt: null,
});

// The feed is assembled in feed-core.js: there it is tested without a window.
const feedEntries = (feed) => orderedFeedEntries(feed.records);

/** The last captured message of the agent, for the card on the map. */
function rememberLastMessage(agentId, feed) {
  const last = lastAgentMessage(feedEntries(feed));
  if (last !== null) atlasState.lastMessages.set(agentId, last);
}

async function readFeed(agent, { maxPages = FEED_LIVE_PAGES } = {}) {
  if (workspaceState.feed === null || workspaceState.feed.agentId !== agent.agentId) {
    workspaceState.feed = emptyFeed(agent.agentId);
  }
  const feed = workspaceState.feed;
  if (feed.loading) return;
  feed.loading = true;
  paintChat();

  const incoming = [];
  let cursor = null;
  let pages = 0;
  let revision = null;
  let coverage = null;
  let failure = null;
  let movedDuringRead = false;
  do {
    const response = await window.atlas.agentArchive({ agentId: agent.agentId, cursor, limit: FEED_PAGE_LIMIT });
    if (!response.ok || response.result.outcome !== "succeeded") {
      const error = response.ok ? response.result.error : response.error;
      failure = error ? error.code : tx("workspace::unknown");
      break;
    }
    const output = response.result.output;
    if (revision !== null && output.revision !== revision) {
      // The archive changed revision in the middle of a read: two snapshots must not be mixed.
      movedDuringRead = true;
      break;
    }
    revision = output.revision;
    coverage = output.coverage;
    incoming.push(...(output.items ?? []));
    cursor = output.nextCursor ?? null;
    pages += 1;
  } while (cursor !== null && pages < maxPages);

  feed.loading = false;
  if (failure !== null) {
    if (feed.error !== failure) atlasRecord("bad", tx("conversation not read"), `${agent.agentId} ${failure}`);
    feed.error = failure;
  } else if (movedDuringRead) {
    feed.restarted = true;
  } else {
    const newSnapshot = feed.revision !== null && feed.revision !== revision;
    if (newSnapshot) feed.records = new Map();
    mergeFeedEntries(feed.records, incoming);
    feed.revision = revision;
    feed.coverage = coverage;
    feed.exhausted = cursor === null;
    feed.restarted = newSnapshot;
    feed.error = null;
    feed.readAt = new Date();
    rememberLastMessage(agent.agentId, feed);
    requestRender();
  }
  paintChat();
}

function omissionMarker(omissions) {
  const marker = el("div", "feed-gap");
  marker.append(el("span", "feed-gap-label", tx("omitted")));
  marker.append(el("span", null, omissions.map((code) => OMISSION_LABELS[code] ?? code).join(" · ")));
  return marker;
}

const stateChip = (state) => (state === "completed" ? null
  : el("span", `feed-state state-${state}`, RECORD_STATE_LABELS[state] ?? state));

/** A chat record's time: "14:05" today, "27.10 11:28" on another day. */
function chatTime(atUtc) {
  const at = new Date(atUtc ?? "");
  if (!Number.isFinite(at.getTime())) return null;
  const clock = at.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return clock;
  return `${at.toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" })} ${clock}`;
}

function timeOf(record) {
  if (!record.occurredAtUtc) return null;
  return chatTime(record.occurredAtUtc);
}

function feedRecord(entry) {
  const record = entry.record;
  const omissions = record.omissions ?? [];
  if (record.kind === "omission") return omissionMarker(omissions);

  const text = typeof record.text === "string" ? record.text : null;
  let node;
  if (record.kind === "activity" || (record.kind === "message" && record.role === "tool")) {
    // An agent action: a command and its output. Collapsed so that the feed reads well;
    // expanded blocks stay expanded on update.
    node = el("details", "feed-activity");
    if (workspaceState.openActivities.has(record.recordId)) node.open = true;
    node.addEventListener("toggle", () => {
      if (node.open) workspaceState.openActivities.add(record.recordId);
      else workspaceState.openActivities.delete(record.recordId);
    });
    const summary = el("summary");
    summary.append(el("span", "feed-activity-kind", tx("action")));
    summary.append(el("span", "feed-activity-first",
      text === null ? tx("output not captured") : text.split(/\r?\n/u)[0]));
    const chip = stateChip(record.state);
    if (chip) summary.append(chip);
    node.append(summary);
    if (text !== null) node.append(el("pre", "feed-activity-text", text));
  } else if (record.kind === "delivery") {
    node = el("div", "feed-system");
    node.append(el("span", null, tx("delivery · {state}", { state: RECORD_STATE_LABELS[record.state] ?? record.state })));
    if (text !== null) node.append(el("span", "muted", ` — ${text}`));
  } else if (record.kind === "interaction") {
    node = el("div", "feed-question");
    const head = el("div", "feed-author");
    head.append(el("span", null, tx("Agent question")));
    const chip = stateChip(record.state);
    if (chip) head.append(chip);
    node.append(head);
    node.append(el("div", "feed-text", text ?? tx("(text not captured)")));
    const go = el("button", "small", tx("Go to questions"));
    go.addEventListener("click", () => {
      workspaceState.tab = "questions";
      renderWorkspace();
    });
    node.append(go);
  } else if (record.role === "system") {
    node = el("div", "feed-system", text ?? tx("(text not captured)"));
  } else {
    const mine = record.kind === "submission" || record.role === "user";
    node = el("div", `feed-message ${mine ? "mine" : "agent"}`);
    const head = el("div", "feed-author");
    head.append(el("span", null, mine ? tx("You") : tx("Agent")));
    const time = timeOf(record);
    if (time) head.append(el("time", null, time));
    const chip = stateChip(record.state);
    if (chip) head.append(chip);
    node.append(head);
    node.append(el("div", "feed-text", text ?? tx("(text not captured)")));
  }
  if (omissions.length === 0) return node;
  const wrap = el("div");
  wrap.append(node, omissionMarker(omissions));
  return wrap;
}

/** Whether text is selected inside the node (the person selects text to copy it). */
function selectionInside(node) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return node.contains(selection.getRangeAt(0).commonAncestorContainer);
}

// While text is selected in the conversation, it is not repainted: a repaint would drop
// the selection, and it could not be copied. Once the selection is gone, the feed catches up.
let feedPaintDeferred = false;
document.addEventListener("selectionchange", () => {
  if (!feedPaintDeferred) return;
  const container = document.getElementById("chatFeed");
  if (container !== null && selectionInside(container)) return;
  feedPaintDeferred = false;
  paintChat();
});

function paintFeed(container) {
  if (selectionInside(container)) {
    feedPaintDeferred = true;
    return;
  }
  const feed = workspaceState.feed;
  const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 32;
  const firstPaint = container.childElementCount === 0;
  const previousTop = container.scrollTop;
  container.replaceChildren();
  if (workspaceState.chatSource === "live") {
    paintLive(container);
    if (firstPaint || nearBottom) container.scrollTop = container.scrollHeight;
    else container.scrollTop = previousTop;
    return;
  }
  if (workspaceState.chatSource === null && liveReadAvailable()) {
    // While the binding is being read, the previous conversation of this agent is shown, if it
    // was read before: opening does not start with an empty window.
    if (workspaceState.live?.cached === true && workspaceState.live.data !== null) {
      paintLive(container);
      container.scrollTop = container.scrollHeight;
      return;
    }
    container.append(el("div", "empty", tx("Reading the agent's binding to the conversation…")));
    return;
  }
  if (feed === null || (feed.records.size === 0 && feed.readAt === null)) {
    container.append(el("div", "empty", feed?.error
      ? tx("Conversation not read: {error}. It is unknown, not empty.", { error: feed.error })
      : tx("Reading the conversation…")));
    return;
  }
  if (feed.records.size === 0) {
    container.append(el("div", "empty", tx("The backend has not captured anything in this conversation yet.")));
    return;
  }
  for (const group of groupFeedByTurn(feedEntries(feed))) {
    const box = el("section", "feed-turn");
    if (group.number !== null) box.append(el("div", "feed-turn-head", tx("Turn {number}", { number: group.number })));
    for (const entry of group.entries) box.append(feedRecord(entry));
    container.append(box);
  }
  if (firstPaint || nearBottom) container.scrollTop = container.scrollHeight;
  else container.scrollTop = previousTop;
}

/** The status line of the live conversation: where from, when, whether complete. */
function paintLiveStatus(status) {
  const live = workspaceState.live;
  const data = live?.data ?? null;
  let state = "";
  if (live?.loading) state = tx("reading…");
  else if (live?.error) state = tx("not read: {error}", { error: live.error });
  else if (live?.readAt) {
    state = tx("read at {value} · ", { value: live.readAt.toLocaleTimeString(dateLocale()) })
      + (eventsAvailable() ? tx("refreshes on events") : tx("refreshes every {value} s", { value: FEED_REFRESH_MS / 1000 }));
  }
  status.append(el("span", "chat-state muted", state));
  if (live?.eventsNote) status.append(el("span", "chat-note", live.eventsNote));
  if (data === null || data.traversal === null) return;
  if (data.completeness !== null && data.completeness.status !== "complete") {
    const chip = el("span", "chat-coverage", data.completeness.status === "partial" ? tx("incomplete") : tx("metadata only"));
    chip.title = tx("The backend marked the pages as {status}: {value}.", { status: data.completeness.status, value: data.completeness.reasonCodes.join(", ") || tx("workspace::no reason given") });
    status.append(chip);
  }
  if (data.traversal.status === "partial") {
    status.append(el("span", "chat-note", tx("pages read: {pageCount} — not to the end", { pageCount: data.traversal.pageCount })));
    const more = el("button", "small", tx("Read the rest"));
    more.addEventListener("click", () => {
      const agent = agentOf();
      if (agent !== null) readLive(agent, { maxPages: 32 });
    });
    status.append(more);
  }
  if (data.traversal.status === "stale" || data.traversal.status === "failed") {
    const again = el("button", "small", tx("Reread"));
    again.addEventListener("click", () => {
      const agent = agentOf();
      if (agent !== null) readLive(agent);
    });
    status.append(again);
  }
}

function paintChatStatus() {
  const status = document.getElementById("chatStatus");
  const feed = workspaceState.feed;
  if (status === null) return;
  status.replaceChildren();
  const route = chatRouteFor(agentOf());
  const routeLine = el("span", "chat-route", tx("via {via}", { via: route.via }));
  routeLine.title = route.reason;
  status.append(routeLine);

  const live = workspaceState.live;
  const binding = live?.data?.binding ?? null;
  if (live?.data?.route === "live") {
    // There is a live thread: you can switch to the captured archive and back.
    for (const [source, label] of [["live", tx("live")], ["archive", tx("archive")]]) {
      const button = el("button", `small${workspaceState.chatSource === source ? " primary" : ""}`, label);
      button.addEventListener("click", () => {
        workspaceState.chatSource = source;
        const agent = agentOf();
        if (agent !== null && source === "archive" && (feed === null || feed.readAt === null)) readFeed(agent);
        paintChat();
      });
      status.append(button);
    }
  } else if (binding !== null) {
    const note = el("span", "chat-note", tx("live read unavailable: {reasonCode}", { reasonCode: LIVE_REASON_WORDS[binding.reasonCode] ?? binding.reasonCode }));
    status.append(note);
  }
  if (workspaceState.chatSource === "live") {
    paintLiveStatus(status);
    return;
  }
  if (feed === null) return;
  let state = "";
  if (feed.loading) state = tx("reading…");
  else if (feed.error) state = tx("not read: {error}", { error: feed.error });
  else if (feed.readAt) {
    state = tx("updated at {value} · refreshes every {value2} s", { value: feed.readAt.toLocaleTimeString(dateLocale()), value2: FEED_REFRESH_MS / 1000 });
  }
  status.append(el("span", "chat-state muted", state));
  if (feed.coverage) {
    const coverage = el("span", "chat-coverage", tx("captured only"));
    coverage.title = tx("Coverage “captured-only”: what the backend managed to capture, not the full history of the provider.");
    status.append(coverage);
  }
  if (feed.restarted) {
    status.append(el("span", "chat-note", tx("the archive changed revision — showing the new snapshot")));
  }
  if (!feed.loading && feed.readAt && !feed.exhausted) {
    const more = el("button", "small", tx("Read the whole archive"));
    more.title = tx("One update reads {FEED_LIVE_PAGES} pages of {FEED_PAGE_LIMIT} records", { FEED_LIVE_PAGES, FEED_PAGE_LIMIT });
    more.addEventListener("click", () => {
      const agent = agentOf();
      if (agent !== null) readFeed(agent, { maxPages: FEED_FULL_PAGES });
    });
    status.append(more);
  }
}

/** Repaint what depends on data, without touching the input field. */
function paintChat() {
  const node = workspaceState.node;
  if (node === null || workspaceState.tab !== "chat" || workspaceState.chatMounted !== node.agentId) return;
  const container = document.getElementById("chatFeed");
  if (container !== null) paintFeed(container);
  paintChatStatus();
  const stop = document.getElementById("chatStop");
  const agent = agentOf();
  if (stop !== null && agent !== null && operationStatus("mutation.agent-control.interrupt")?.status === "available") {
    stop.disabled = agent.currentOperationId === null;
    stop.title = agent.currentOperationId === null ? tx("The agent has no current operation") : "";
  }
  const send = document.getElementById("chatSend");
  const sendReason = document.getElementById("chatSendReason");
  if (send !== null && sendReason !== null) paintSendAvailability(send, sendReason, agent);
  const status = document.getElementById("workspaceAgentStatus");
  if (status !== null && agent !== null) status.textContent = tx("{state} · delivery {deliveryState}", { state: agent.state, deliveryState: agent.deliveryState });
  const queued = document.getElementById("chatQueued");
  if (queued !== null && agent !== null) paintQueued(queued, agent);
  if (agent !== null) syncChatQuestions(agent);
  const modelLine = document.getElementById("workspaceModel");
  if (modelLine !== null && agent !== null) modelLine.textContent = modelWords(agent);
}

function renderChat(body, agent) {
  body.classList.add("chat-mode");
  const status = el("div", "chat-status");
  status.id = "chatStatus";
  const feed = el("div", "chat-feed");
  feed.id = "chatFeed";
  // Agent questions that hold its turn go between the conversation and the input field.
  const questions = el("div", "chat-questions");
  questions.id = "chatQuestions";
  questions.hidden = true;
  // The agent's memory changes waiting for the person go there too.
  const memoryChanges = el("div", "chat-questions");
  memoryChanges.id = "chatMemoryChanges";
  memoryChanges.hidden = true;
  body.append(status, feed, questions, memoryChanges, renderCompose(agent));
  workspaceState.chatMounted = agent.agentId;
  syncChatQuestions(agent);
  paintMemoryChanges(agent);
  loadMemoryChanges(agent);
  if (workspaceState.feed === null || workspaceState.feed.agentId !== agent.agentId) {
    workspaceState.feed = emptyFeed(agent.agentId);
  }
  if (!liveReadAvailable()) workspaceState.chatSource = "archive";
  paintFeed(feed);
  paintChatStatus();
  if (workspaceState.chatSource === "archive") {
    if (workspaceState.feed.readAt === null && !workspaceState.feed.loading) readFeed(agent);
    return;
  }
  const live = workspaceState.live;
  if (live === null || live.agentId !== agent.agentId) {
    workspaceState.live = cachedLive(agent.agentId);
    openChat(agent);
  } else if ((live.cached === true && live.openStarted !== true)
      || (live.data === null && !live.loading && live.error === null)) {
    openChat(agent);
  }
}

/**
 * Opening the conversation: first only the agent's binding. It decides the route
 * (chatOpenPlan): an archived or unbound agent goes to the archive and reads neither
 * events nor pages; for a live thread, the events head cursor is taken before the snapshot.
 */
async function openChat(agent) {
  if (!liveReadAvailable()) {
    workspaceState.chatSource = "archive";
    readFeed(agent);
    return;
  }
  if (workspaceState.live === null || workspaceState.live.agentId !== agent.agentId) {
    workspaceState.live = emptyLive(agent.agentId);
  }
  const live = workspaceState.live;
  if (live.loading) return;
  live.loading = true;
  live.openStarted = true;
  paintChat();
  const response = await window.atlas.conversation({ agentId: agent.agentId, bindingOnly: true });
  live.loading = false;
  if (!response.ok) {
    live.error = response.error.code;
    atlasRecord("bad", tx("conversation binding not read"), `${agent.agentId} ${response.error.code}`);
    workspaceState.chatSource = "archive";
    readFeed(agent);
    paintChat();
    return;
  }
  // The previous snapshot stays on screen until a fresh one is read: a binding without
  // content would replace it with the “reading” label.
  if (!(live.cached === true && response.data.route === "live")) live.data = response.data;
  const steps = chatOpenPlan({ liveReadAvailable: true, eventsAvailable: eventsAvailable(), route: response.data.route });
  if (steps[0] === "archive") {
    workspaceState.chatSource = "archive";
    live.readAt = new Date();
    readFeed(agent);
    paintChat();
    return;
  }
  if (workspaceState.chatSource === null) workspaceState.chatSource = "live";
  paintChat();
  if (steps[0] === "events-head") await pollAgentEvents(agent);
  else await readLive(agent);
}

/** The send button and the reason under it come from sendAvailability; a send in progress keeps the button disabled. */
function paintSendAvailability(button, reasonNode, agent) {
  const verdict = sendAvailability(agent, operationStatus("mutation.memory.agent.send"));
  button.disabled = !verdict.allowed || button.dataset.busy === "1";
  button.title = verdict.reason ?? "";
  reasonNode.textContent = verdict.reason ?? "";
  reasonNode.hidden = verdict.allowed;
}

/**
 * A send whose outcome the Gateway does not know and that has no turn: it holds the agent,
 * its project's folder and the provider's Gateway until the person checks it. null - there is none.
 */
function stuckSend(agent) {
  const last = agent?.lastOperation ?? null;
  return last !== null && last.state === "uncertain" && agent.currentOperationId === last.operationId ? last : null;
}

/** Why the Gateway answered writer_busy: who holds the agent or the project folder. null - not visible. */
function writerBusyText(agent) {
  if (stuckSend(agent) !== null) {
    return tx("The Gateway does not know whether the previous message reached this agent, and does not let a new one through. Press \"Check the send…\" above.");
  }
  const world = atlasState.world;
  if (world?.status !== "ready") return null;
  const project = world.projection.projects.find((item) => item.projectId === agent.projectId) ?? null;
  const holders = (project?.quarters ?? []).flatMap((quarter) => quarter.agents)
    .filter((other) => other.agentId !== agent.agentId && other.currentOperationId);
  if (holders.length === 0) return null;
  return holders.map((other) => (stuckSend(other) !== null
    ? tx("The project folder is held by {agentId}: the Gateway does not know whether its last message arrived. ", { agentId: other.agentId })
      + tx("Open {agentId} and press \"Check the send…\".", { agentId: other.agentId })
    : tx("The project folder is taken now by {agentId}: it is working. Wait for its turn to end.", { agentId: other.agentId }))).join(" ");
}

/** Checking a stuck send by the agent's session journal (trusted host, the Gateway stops for that time). */
function paintStuckSend(box, agent) {
  const last = stuckSend(agent);
  if (last === null || typeof window.atlas?.settleSend !== "function") {
    box.replaceChildren();
    return;
  }
  const result = el("div");
  const check = trustedButton(tx("Check the send…"), async () => {
    const response = await window.atlas.settleSend({ agentId: agent.agentId, operationId: last.operationId });
    if (response.ok) {
      const data = response.data;
      atlasRecord("ok", tx("send checked"), tx("{agentId} · {value}", { agentId: agent.agentId, value: data.went ? tx("arrived") : tx("was not sent") }));
      result.replaceChildren(noteBlock("note", data.went
        ? tx("The message arrived: the send has a turn, its outcome — {value}.", { value: data.operationState ?? tx("workspace2::unknown") })
        : tx("The message was not sent") + (data.causeCode ? tx(" (cause: {causeCode})", { causeCode: data.causeCode }) : "")
          + tx(": the send is marked as a failure, the agent is free. Send the message again.")));
      await refresh();
    } else if (response.error.code === "user_declined") {
      result.replaceChildren(noteBlock("note", tx("Not checked: the confirmation was declined.")));
    } else {
      atlasRecord("bad", tx("send not checked"), response.error.reasonCode || response.error.code);
      result.replaceChildren(noteBlock("error", tx("Not checked: {code}.", { code: response.error.reasonCode || response.error.code })));
    }
  });
  box.replaceChildren(noteBlock("error", tx("The Gateway does not know whether the last message reached this agent. Until this is ")
    + tx("checked, the agent is busy and the other agents of its project cannot work in the shared folder.")), check, result);
}

function renderCompose(agent) {
  const compose = el("div", "chat-compose");
  const stuck = el("div", "chat-stuck");
  paintStuckSend(stuck, agent);
  compose.append(stuck);
  const text = el("textarea");
  text.rows = 3;
  text.maxLength = 16384;
  text.placeholder = tx("Message to the agent");
  text.value = draftFor(agent.agentId);
  text.addEventListener("input", () => setDraft(agent.agentId, text.value));
  compose.append(text);

  // “After the turn” messages go above the input field, as in Codex: they are visible, and each
  // can be withdrawn until the turn ends.
  const queuedBox = el("div", "chat-queued");
  queuedBox.id = "chatQueued";
  compose.prepend(queuedBox);
  paintQueued(queuedBox, agent);

  const result = el("div", "chat-result");
  const actions = el("div", "actions chat-actions");
  // Not actionButton: a declared operation is not enough, the agent must also be in the
  // active state (sendAvailability). The check is repeated in the handler itself, against
  // a fresh catalog, so a refusal does not depend on whether the button has been disabled yet.
  const send = el("button", "small primary", tx("Send"));
  send.id = "chatSend";
  const sendReason = el("div", "chat-compose-note");
  sendReason.id = "chatSendReason";
  const freshAgent = () => {
    const current = agentOf();
    return current !== null && current.agentId === agent.agentId ? current : null;
  };
  // Steer: the message goes into the running turn at once; unchecked, it waits for the end of the turn.
  // While the agent is idle, there is no difference. The choice is remembered.
  const steering = operationStatus("mutation.memory.agent.steer")?.status === "available";
  const steerBox = el("label", "chat-steer");
  const steerCheck = el("input");
  steerCheck.type = "checkbox";
  steerCheck.id = "chatSteer";
  steerCheck.checked = atlasState.ui.steer !== false;
  steerCheck.disabled = !steering;
  steerCheck.addEventListener("change", () => setPanel("steer", steerCheck.checked));
  steerBox.append(steerCheck, el("span", null, "Steer"));
  steerBox.title = steering
    ? tx("On: the message goes to the agent at once, and it reads it after the current action.\n")
      + tx("Off: the message waits for the end of the turn and goes on its own; until then you can withdraw it.")
    : tx("The backend cannot feed a message into a running turn: the agent will get it when it is idle.");
  paintSendAvailability(send, sendReason, agent);
  send.addEventListener("click", async () => {
    if (send.dataset.busy === "1") return;
    send.dataset.busy = "1";
    send.disabled = true;
    const typed = text.value;
    // The agent's model server does not answer now (host/model-health.mjs): the person decides.
    const down = modelDown(freshAgent() ?? agent);
    if (down !== null && !window.confirm(tx("The model {name} is not answering now ({address}). The turn may end as \"the model does not answer\". Send anyway?",
      { name: down.name, address: down.address ?? "?" }))) {
      delete send.dataset.busy;
      paintSendAvailability(send, sendReason, freshAgent());
      return;
    }
    if (taskModeOf(agent.agentId)) {
      const started = await startTaskFromChat(freshAgent(), typed);
      if (!started.ok) {
        result.replaceChildren(noteBlock("error", started.text));
      } else {
        result.replaceChildren(noteBlock("note", tx("The task is given: the agent answers with a plan first. Approve it on the Plan tab.")));
        atlasState.drafts.delete(agent.agentId);
        text.value = "";
        paintPlanTabLabel();
        await refresh();
        if (workspaceState.chatSource === "live") await readLive(agent);
        else await readFeed(agent);
      }
      delete send.dataset.busy;
      paintSendAvailability(send, sendReason, freshAgent());
      return;
    }
    const mode = steerCheck.checked ? "steer" : "queue";
    const outcome = await guardedSend({
      agent: freshAgent(),
      operation: operationStatus(steering ? "mutation.memory.agent.steer" : "mutation.memory.agent.send"),
      send: (target) => (steering
        ? window.atlas.steer({ agentId: target.agentId, text: typed, mode })
        : window.atlas.send({ agentId: target.agentId, text: typed })),
    });
    if (outcome.sent && outcome.response.ok && outcome.response.data.output?.delivery === "queued") {
      const list = workspaceState.queued.get(agent.agentId) ?? [];
      list.push({ operationId: outcome.response.data.identity.operationId, text: typed });
      workspaceState.queued.set(agent.agentId, list);
      paintQueued(queuedBox, freshAgent() ?? agent);
    }
    if (!outcome.sent) {
      result.replaceChildren(noteBlock("error", outcome.reason));
      delete send.dataset.busy;
      paintSendAvailability(send, sendReason, freshAgent());
      return;
    }
    const response = outcome.response;
    // A successful send is visible in the conversation itself; under the field only
    // a refusal or an unknown outcome remains.
    const shown = outcomeMessage(response, tx("Sent."));
    // A bare writer_busy says nothing: Atlas names who holds the agent or the folder.
    const busy = !response.ok && response.error?.code === "writer_busy" ? writerBusyText(freshAgent() ?? agent) : null;
    result.replaceChildren(...(response.ok ? []
      : [noteBlock(shown.kind === "error" ? "error" : "note", busy === null ? shown.text : `${shown.text}. ${busy}`)]));
    const identity = response.ok ? response.data.identity : response.identity;
    if (identity !== undefined && identity !== null) workspaceState.lastSend = identity;
    if (response.ok) {
      atlasState.drafts.delete(agent.agentId);
      text.value = "";
      await refresh();
      if (workspaceState.chatSource === "live") await readLive(agent);
      else await readFeed(agent);
    }
    delete send.dataset.busy;
    paintSendAvailability(send, sendReason, freshAgent());
  });

  const stop = actionButton(tx("Stop turn"), "mutation.agent-control.interrupt", async () => {
    const response = await window.atlas.interrupt({
      agentId: agent.agentId, operationId: agent.currentOperationId,
    });
    const shown = outcomeMessage(response, tx("Stop requested: accepted does not mean finished."));
    result.replaceChildren(noteBlock(shown.kind === "error" ? "error" : "note", shown.text));
    await refresh();
  });
  stop.id = "chatStop";
  if (agent.currentOperationId === null) {
    stop.disabled = true;
    stop.title = tx("The agent has no current operation");
  }
  // Question or task: a task is planned first and worked on after the person approves the plan.
  const modeBox = el("div", "chat-mode");
  modeBox.id = "chatMode";
  modeBox.title = tx("Question: the agent answers and may act as usual.\nTask: the agent answers with a plan first, ")
    + tx("changes nothing, and works after you approve the plan on the Plan tab.");
  for (const [task, label] of [[false, tx("Question")], [true, tx("Task")]]) {
    const button = el("button", `small flat${taskModeOf(agent.agentId) === task ? " active" : ""}`, label);
    button.dataset.mode = task ? "task" : "question";
    button.addEventListener("click", () => {
      setTaskMode(agent.agentId, task);
      for (const other of modeBox.querySelectorAll("button")) other.classList.toggle("active", other === button);
      text.placeholder = task ? tx("The task for the agent: it answers with a plan first") : tx("Message to the agent");
    });
    modeBox.append(button);
  }
  if (taskModeOf(agent.agentId)) text.placeholder = tx("The task for the agent: it answers with a plan first");
  actions.prepend(modeBox, ...renderModelPicker(agent, result), renderPermissionPicker(agent, result),
    el("div", "spacer"), steerBox);
  actions.append(stop);
  // “Send” goes on the right, last, as in Claude Code.
  actions.append(send);
  // Whether the agent's model answers now: a line under the field, kept fresh (atlasPaintModelNote).
  const modelNote = el("div", "chat-compose-note");
  modelNote.id = "chatModelNote";
  compose.append(actions, sendReason, modelNote, result);
  atlasPaintModelNote();
  // Enter sends, Shift+Enter makes a new line, as in Claude Code and Codex.
  // While text is composed with an IME, Enter belongs to the composition. Shift+Tab
  // switches to the next permission mode, as in Claude Code (“bypass permissions” only from the list).
  text.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cyclePermissionMode();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!send.disabled && text.value.trim() !== "") send.click();
  });
  compose.append(el("div", "chat-compose-note",
    tx("Enter — send · Shift+Enter — new line · Shift+Tab — permission mode. ")
      + tx("Sending starts a turn and uses quota.")));
  return compose;
}

// --- the agent's own memory changes (the backend's memory-changes.mjs) -------------------
//
// An agent asks to add, change or remove entries of a memory with its desk tool; the
// change waits for the person as a card in the agent's chat: what changes, line by
// line, and why, with Approve and Reject. Approved, it is written at once, exactly as
// shown; the History can undo it.

/** What memory a change is about, in the window's words. */
function memoryTargetWords(change) {
  switch (change.target.kind) {
    case "own": return tx("its own memory");
    case "quarter": return tx("the quarter's memory");
    case "project": return tx("the project's memory");
    default: return tx("the memory of {name}", { name: displayName("agent", change.projectId, change.target.agentId ?? "?") });
  }
}

/** Reads the open agent's pending memory changes and paints them. */
async function loadMemoryChanges(agent) {
  if (typeof window.atlas?.memoryChanges !== "function") return;
  const response = await window.atlas.memoryChanges({ projectId: agent.projectId, agentId: agent.agentId, states: ["pending"] });
  workspaceState.memoryChanges = { agentId: agent.agentId, changes: response.ok ? response.data.changes : [],
    failed: response.ok ? null : response.error?.reasonCode || response.error?.code || "error" };
  if (workspaceState.node?.agentId === agent.agentId) paintMemoryChanges(agent);
}

function paintMemoryChanges(agent) {
  const box = document.getElementById("chatMemoryChanges");
  const state = workspaceState.memoryChanges;
  if (box === null) return;
  const changes = state !== null && state.agentId === agent.agentId ? state.changes : [];
  box.hidden = changes.length === 0;
  box.replaceChildren(...changes.map((change) => memoryChangeCard(agent, change)));
}

function memoryChangeCard(agent, change) {
  const card = el("div", "chat-question memory-change");
  card.dataset.changeId = change.changeId;
  card.append(el("div", "chat-question-head", tx("Asks to change {memory}", { memory: memoryTargetWords(change) })));
  if (change.reason) card.append(el("div", "memory-change-reason", change.reason));
  const list = el("div", "memory-change-lines");
  for (const line of change.diff) {
    const row = el("div", `memory-change-line change-${line.change}`);
    row.append(el("span", "memory-change-mark", line.change === "added" ? "+" : line.change === "removed" ? "−" : "~"),
      el("span", "memory-change-title", line.title));
    if (line.change === "changed" && line.previous !== null) row.append(el("div", "memory-change-previous", line.previous));
    if (line.text !== null) row.append(el("div", "memory-change-text", line.text));
    list.append(row);
  }
  card.append(list);
  // Its own result line: the chat's "chat-result" is the input field's.
  const result = el("div", "memory-change-result");
  const actions = el("div", "actions");
  const decide = async (approve) => {
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    const response = approve
      ? await window.atlas.approveMemoryChange({ projectId: change.projectId, changeId: change.changeId })
      : await window.atlas.rejectMemoryChange({ projectId: change.projectId, changeId: change.changeId });
    if (!response.ok) {
      const code = response.error?.reasonCode || response.error?.code || "error";
      result.replaceChildren(noteBlock("error", code === "memory_change_stale"
        ? tx("The memory changed since the agent asked: nothing was written. Ask the agent again.")
        : tx("Not done: {code}.", { code })));
      for (const button of actions.querySelectorAll("button")) button.disabled = false;
      if (code === "memory_change_stale") await loadMemoryChanges(agent);
      return;
    }
    await loadMemoryChanges(agent);
    await refresh({ silent: true });
  };
  const approve = el("button", "small primary", tx("Approve"));
  approve.dataset.action = "approve-memory-change";
  approve.addEventListener("click", () => decide(true));
  const reject = el("button", "small", tx("Reject"));
  reject.dataset.action = "reject-memory-change";
  reject.addEventListener("click", () => decide(false));
  actions.append(approve, reject);
  card.append(actions, result);
  return card;
}

// --- task mode and the Plan tab ------------------------------------------------------
//
// A message sent in task mode (the owner's decisions of 01.11,
// docs/personal/plans/01_11_2026_task-mode-and-plan.md) becomes a task: the
// agent plans first and changes nothing, and the Plan tab shows its plan - what it
// understood, its questions, its steps - with Approve, Revise and Cancel. Only an
// approved plan is worked on; approving does not widen the agent's rights. The
// records are the backend's (agent-tasks.mjs), read through the trusted host; the
// task board will show the same ones.

const TASK_READ_TTL_MS = 15_000;

/** Whether this agent's chat is in task mode (kept per agent until switched back). */
const taskModeOf = (agentId) => (atlasState.ui.taskModeAgents ?? []).includes(agentId);

function setTaskMode(agentId, on) {
  const others = (atlasState.ui.taskModeAgents ?? []).filter((id) => id !== agentId);
  setPanel("taskModeAgents", on ? [...others, agentId] : others);
}

/** The agent's tasks as last read: { readAt, tasks, error }; null before the first read. */
const tasksOf = (agentId) => workspaceState.tasks.get(agentId) ?? null;

/** Reads an agent's tasks (newest first); a fresh read is kept for a while unless `force`. */
async function loadAgentTasks(node, { force = false } = {}) {
  const known = tasksOf(node.agentId);
  if (!force && known !== null && Date.now() - known.readAt < TASK_READ_TTL_MS) return known;
  if (typeof window.atlas?.tasks !== "function") return null;
  const response = await window.atlas.tasks({ projectId: node.projectId, agentId: node.agentId, limit: 20 });
  const read = response.ok ? { readAt: Date.now(), tasks: response.data.tasks, error: null }
    : { readAt: Date.now(), tasks: known?.tasks ?? [], error: response.error?.reasonCode || response.error?.code || "error" };
  workspaceState.tasks.set(node.agentId, read);
  return read;
}

/** Whether the agent's current task waits for the person (its plan, or a stopped turn). */
function taskWaitsForPerson(agentId) {
  const task = currentTask(tasksOf(agentId)?.tasks ?? []);
  return task !== null && task.waitingFor === "person";
}

/** Re-reads the open agent's tasks after its conversation changed (a turn ended), and repaints what shows them. */
async function refreshAgentTasks(agent) {
  const node = workspaceState.node;
  if (node === null || node.agentId !== agent.agentId) return;
  const before = JSON.stringify(currentTask(tasksOf(agent.agentId)?.tasks ?? []));
  await loadAgentTasks(node, { force: true });
  const after = JSON.stringify(currentTask(tasksOf(agent.agentId)?.tasks ?? []));
  if (before !== after && workspaceState.node?.agentId === agent.agentId
    && (workspaceState.tab === "plan" || workspaceState.tab === "chat")) {
    if (workspaceState.tab === "plan") renderWorkspace();
    else paintPlanTabLabel();
  }
}

/** The Plan tab's label: a mark while the task waits for the person. */
function planTabLabel(agentId) {
  return taskWaitsForPerson(agentId) ? `${tx("Plan")} ●` : tx("Plan");
}

function paintPlanTabLabel() {
  const button = document.querySelector("#workspace .workspace-tabs [data-tab=\"plan\"]");
  const node = workspaceState.node;
  if (button === null || node === null) return;
  button.textContent = planTabLabel(node.agentId);
  button.classList.toggle("waiting", taskWaitsForPerson(node.agentId));
}

/**
 * Sends a message for a task step, the way the chat sends one: steered into a
 * running turn where the backend can, else a plain send. The message is what the
 * chat shows; the agent gets the task's instruction with it (the backend).
 */
async function sendTaskMessage(agent, text) {
  const steering = operationStatus("mutation.memory.agent.steer")?.status === "available";
  const outcome = await guardedSend({
    agent,
    operation: operationStatus(steering ? "mutation.memory.agent.steer" : "mutation.memory.agent.send"),
    send: (target) => (steering
      ? window.atlas.steer({ agentId: target.agentId, text, mode: "queue" })
      : window.atlas.send({ agentId: target.agentId, text })),
  });
  if (!outcome.sent) return { ok: false, text: outcome.reason };
  if (!outcome.response.ok) return { ok: false, text: outcomeMessage(outcome.response, tx("Sent.")).text };
  const identity = outcome.response.data?.identity;
  if (identity !== undefined && identity !== null) workspaceState.lastSend = identity;
  return { ok: true };
}

/** Why a task step cannot be sent now, or null: the agent must be idle and active. */
function taskSendBlocked(agent) {
  if (agent === null) return tx("The agent is not in the catalog.");
  if (agent.state !== "active") return tx("The agent is not active.");
  if (agent.currentOperationId !== null) return tx("The agent is busy with a turn: try again when it is idle.");
  return null;
}

/** The chat's task-mode send: the task is made, then its text goes as the planning turn's message. */
async function startTaskFromChat(agent, typed) {
  const blocked = taskSendBlocked(agent);
  if (blocked !== null) return { ok: false, text: blocked };
  const started = await window.atlas.startTask({ agentId: agent.agentId, text: typed });
  if (!started.ok) {
    const code = started.error?.reasonCode || started.error?.code || "error";
    return { ok: false, text: code === "task_agent_busy"
      ? tx("This agent already has an open task: see the Plan tab.") : tx("The task was not started: {code}.", { code }) };
  }
  const tasks = tasksOf(agent.agentId)?.tasks ?? [];
  workspaceState.tasks.set(agent.agentId, { readAt: Date.now(), tasks: [started.data.task, ...tasks], error: null });
  const sent = await sendTaskMessage(agent, typed);
  if (!sent.ok) {
    return { ok: false, text: tx("The task {taskId} is saved, but its message did not go: {reason} The next message to this agent starts its plan.",
      { taskId: started.data.task.taskId, reason: sent.text }) };
  }
  return { ok: true };
}

/** Which plan cards are open, by task (and task#revision), while the window is open. */
const planCardsOpen = new Map();

/**
 * A plan as one card (the owner's check of 01.11): closed, it says in a line what the task is
 * about; a click on its top line opens the whole plan and closes it again. It is only shown or
 * hidden, never drawn again: answers being typed stay. `title` is a text or a node.
 */
function planCard({ key, title, summary, openByDefault, fill, nested = false }) {
  const card = el("div", `plan-card${nested ? " nested" : ""}`);
  const head = el("div", "plan-card-head toggles");
  const chevron = el("span", "plan-chevron");
  head.append(chevron, typeof title === "string" ? el("div", "section-title", title) : title);
  const inside = el("div", "plan-body");
  const show = (open) => {
    card.classList.toggle("open", open);
    card.classList.toggle("closed", !open);
    chevron.textContent = open ? "▾" : "▸";
    head.title = open ? tx("Close the plan") : tx("Open the whole plan");
  };
  head.addEventListener("click", () => {
    const open = !card.classList.contains("open");
    planCardsOpen.set(key, open);
    show(open);
  });
  show(planCardsOpen.get(key) ?? openByDefault);
  card.append(head);
  if (summary) card.append(el("div", "plan-summary", summary));
  card.append(inside);
  fill(inside);
  return { card, head };
}

/** What a closed plan says: what the task is about, briefly, and how many steps it has. */
function planSummary(revision, steps) {
  const about = String(revision?.understanding || revision?.raw || "").replace(/\s+/gu, " ").trim();
  const brief = about.length > 220 ? `${about.slice(0, 219).trimEnd()}…` : about;
  const done = steps.filter((step) => step.status === "done").length;
  const count = steps.some((step) => step.status)
    ? tx("steps done: {done} of {total}", { done, total: steps.length })
    : txn("{count} steps", steps.length);
  return brief ? `${brief} · ${count}` : count;
}

/** A step as the whole plan shows it: its short name in bold, then what exactly. */
function planStepText(text) {
  const parts = stepParts(text);
  const node = el("span", "plan-step-text");
  if (parts.named) node.append(el("span", "plan-step-name", parts.name), el("span", "plan-step-detail", ` — ${parts.detail}`));
  else node.textContent = text;
  return node;
}

/** The understanding and steps of a plan read later (an earlier revision or task): nothing to answer. */
function fillPlanRecord(inside, revision, { steps = null, answers = [], remarks = [] } = {}) {
  if (!revision.formatted) {
    inside.append(el("div", "plan-raw", revision.raw ?? ""));
  } else {
    if (revision.understanding) {
      inside.append(el("div", "plan-label", tx("Understanding")), el("div", "plan-understanding", revision.understanding));
    }
    if (revision.questions.length > 0) {
      inside.append(el("div", "plan-label", tx("Questions")));
      revision.questions.forEach((question, index) => {
        const row = el("div", "plan-question");
        row.append(el("div", "plan-question-text", `${index + 1}. ${question}`));
        if (answers[index]) row.append(el("div", "plan-answer-given", answers[index]));
        inside.append(row);
      });
    }
    inside.append(el("div", "plan-label", tx("Steps")));
    const list = el("ol", "plan-steps");
    for (const step of steps ?? revision.steps.map((text) => ({ text }))) {
      const item = el("li", `plan-step${step.status ? ` status-${step.status}` : ""}`);
      if (step.status === "done") item.append(el("span", "plan-step-mark", "✓"));
      item.append(planStepText(step.text));
      list.append(item);
    }
    inside.append(list);
  }
  for (const remark of remarks) {
    inside.append(el("div", "plan-label", tx("Your remarks")), el("div", "plan-understanding", remark.text));
  }
}

/** Why a listed result is not among the agent's artifacts, in the window's words. */
function resultProblemWords(code) {
  switch (code) {
    case "outside_project": return tx("it is outside the project folder");
    case "source_unavailable": return tx("the file is not there");
    case "access_denied": return tx("it is not a text file, or it is a private one");
    case "conflict": return tx("the artifact list is full, or holds another file under this name");
    case "stale_revision": return tx("the file changed while it was read");
    default: return tx("not registered ({code})", { code: code ?? "unknown" });
  }
}

/**
 * The files the agent listed as its finished task's results (agent-tasks.mjs results): each one in
 * its Artifacts, with the hash it had then, or why not. The task board's card shows the same.
 */
function taskResultsCard(task) {
  const card = el("div", "plan-card plan-results");
  card.append(el("div", "section-title", tx("Results · {count}", { count: task.results.length })));
  if (task.results.length === 0) card.append(el("div", "empty", tx("The agent listed no files as results.")));
  for (const result of task.results) {
    const row = el("div", "plan-result-row");
    row.append(el("div", "plan-result-path", result.path));
    if (result.note) row.append(el("div", "plan-result-note", result.note));
    if (result.artifactId) {
      const go = el("button", "small plan-result-artifact", tx("Open in Artifacts"));
      go.addEventListener("click", () => {
        workspaceState.artifacts = null;
        workspaceState.tab = "artifacts";
        renderWorkspace();
      });
      row.append(go);
    } else {
      row.append(el("div", "plan-result-problem", tx("Not in Artifacts: {why}.", { why: resultProblemWords(result.problem) })));
    }
    card.append(row);
  }
  return card;
}

function renderPlan(body, agent) {
  const node = workspaceState.node;
  const known = tasksOf(agent.agentId);
  if (known === null) {
    body.append(el("div", "empty", tx("Reading the agent's tasks...")));
    loadAgentTasks(node).then(() => {
      if (workspaceState.node?.agentId === agent.agentId && workspaceState.tab === "plan") renderWorkspace();
    });
    return;
  }
  if (Date.now() - known.readAt >= TASK_READ_TTL_MS) {
    loadAgentTasks(node).then(() => {
      if (workspaceState.node?.agentId === agent.agentId && workspaceState.tab === "plan") renderWorkspace();
    });
  }
  if (known.error !== null) body.append(noteBlock("error", tx("Tasks not read: {code}.", { code: known.error })));
  const task = currentTask(known.tasks);
  if (task === null) {
    body.append(el("div", "empty", tx("This agent has no tasks yet.")));
    body.append(noteBlock("note", tx("Switch the chat to “Task” and write the task: the agent answers with a plan first, ")
      + tx("changes nothing, and starts the work only after you approve the plan here.")));
    return;
  }
  const result = el("div", "plan-result");
  const act = async (run, sendText) => {
    const fresh = agentOf();
    for (const button of body.querySelectorAll("button")) button.disabled = true;
    const blocked = sendText === null ? null : taskSendBlocked(fresh);
    if (blocked !== null) {
      result.replaceChildren(noteBlock("error", blocked));
      for (const button of body.querySelectorAll("button")) button.disabled = false;
      return;
    }
    const response = await run();
    if (!response.ok) {
      const code = response.error?.reasonCode || response.error?.code || "error";
      if (code !== "declined") result.replaceChildren(noteBlock("error", tx("Not done: {code}.", { code })));
      for (const button of body.querySelectorAll("button")) button.disabled = false;
      return;
    }
    if (sendText !== null) {
      const sent = await sendTaskMessage(fresh, sendText);
      if (!sent.ok) result.replaceChildren(noteBlock("error", sent.text));
    }
    await loadAgentTasks(node, { force: true });
    await refresh({ silent: true });
    if (workspaceState.node?.agentId === agent.agentId && workspaceState.tab === "plan") renderWorkspace();
  };

  const head = el("div", "plan-head");
  head.append(el("div", "eyebrow", tx("TASK {taskId}", { taskId: task.taskId })));
  head.append(el("div", `plan-stage stage-${task.stage}${task.waitingFor === "person" ? " waiting" : ""}`, taskStageWords(task)));
  body.append(head);
  body.append(el("div", "plan-task", task.text));

  const revision = task.revisions.at(-1) ?? null;
  if (task.stage === "planning") {
    body.append(noteBlock("note", task.revisions.length === 0
      ? tx("The agent reads the project and prepares the plan. It changes nothing until you approve it.")
      : tx("The agent is preparing revision {revision} after your remarks.", { revision: (revision?.revision ?? 0) + 1 })));
  }
  const shown = task.stage === "in-progress" || task.stage === "done"
    ? task.revisions.find((item) => item.revision === task.approved?.revision) ?? revision : revision;
  const answers = [];
  if (shown !== null) {
    const working = task.stage === "in-progress" || task.stage === "done";
    const previous = task.revisions.find((item) => item.revision === shown.revision - 1) ?? null;
    const rows = working
      ? task.steps.map((step) => ({ text: step.text, change: "same", status: step.status }))
      : (previous === null ? shown.steps.map((text) => ({ text, change: "same" })) : stepDiff(previous.steps, shown.steps));
    // Open while the person has to read it (planning, waiting for approval); closed once it is at work or done.
    const { card, head } = planCard({ key: task.taskId, title: tx("Plan · revision {revision}", { revision: shown.revision }),
      summary: planSummary(shown, rows), openByDefault: !working, fill: (inside) => {
        if (!shown.formatted) {
          inside.append(noteBlock("note", tx("The agent did not answer in the plan's form. Its answer as it is:")));
          inside.append(el("div", "plan-raw", shown.raw ?? ""));
          return;
        }
        if (shown.understanding) {
          inside.append(el("div", "plan-label", tx("Understanding")));
          inside.append(el("div", "plan-understanding", shown.understanding));
        }
        if (shown.questions.length > 0) {
          inside.append(el("div", "plan-label", tx("Questions")));
          const asked = task.stage === "awaiting-approval" && shown === revision;
          shown.questions.forEach((question, index) => {
            const row = el("div", "plan-question");
            row.append(el("div", "plan-question-text", `${index + 1}. ${question}`));
            if (asked) {
              const input = el("input", "plan-answer");
              input.type = "text";
              input.maxLength = 2000;
              input.placeholder = tx("Your answer");
              answers.push(input);
              row.append(input);
            } else {
              const given = task.approved?.answers?.[index] ?? "";
              if (given) row.append(el("div", "plan-answer-given", given));
            }
            inside.append(row);
          });
        }
        inside.append(el("div", "plan-label", tx("Steps")));
        const list = el("ol", "plan-steps");
        for (const step of rows) {
          const item = el("li", `plan-step change-${step.change}${step.status ? ` status-${step.status}` : ""}`);
          const mark = step.status === "done" ? "✓" : step.status === "in-progress" ? "▸"
            : step.change === "added" ? "+" : step.change === "removed" ? "−" : "";
          if (mark) item.append(el("span", "plan-step-mark", mark));
          item.append(planStepText(step.text));
          list.append(item);
        }
        inside.append(list);
        if (previous !== null && !working) {
          inside.append(el("div", "chat-compose-note", tx("Marked against revision {revision}: + added, − removed.",
            { revision: previous.revision })));
        }
        // The plan's earlier revisions, each one a card of its own, closed, with the remarks that followed it.
        const earlierRevisions = task.revisions.filter((item) => item.revision !== shown.revision).reverse();
        if (earlierRevisions.length > 0) {
          inside.append(el("div", "plan-label", tx("Earlier revisions · {count}", { count: earlierRevisions.length })));
          for (const item of earlierRevisions) {
            inside.append(planCard({ key: `${task.taskId}#${item.revision}`, nested: true,
              title: tx("Revision {revision}", { revision: item.revision }),
              summary: planSummary(item, item.steps.map((text) => ({ text }))), openByDefault: false,
              fill: (box) => fillPlanRecord(box, item, { remarks: task.remarks.filter((remark) => remark.afterRevision === item.revision) }),
            }).card);
          }
        }
      } });
    head.id = "planToggle";
    body.append(card);
  }
  if (Array.isArray(task.results)) body.append(taskResultsCard(task));

  if (task.stage === "awaiting-approval" && revision !== null) {
    const actions = el("div", "actions plan-actions");
    const approve = el("button", "small primary", tx("Approve plan"));
    approve.id = "planApprove";
    approve.disabled = !revision.formatted;
    if (!revision.formatted) approve.title = tx("There are no steps to approve: ask for the plan's form first.");
    approve.addEventListener("click", () => act(() => window.atlas.approveTask({ agentId: agent.agentId, taskId: task.taskId,
      revision: revision.revision, answers: answers.map((input) => input.value) }), approvalMessage(revision.revision)));
    const revise = el("button", "small", tx("Revise…"));
    revise.id = "planRevise";
    const remarksBox = el("div", "plan-remarks hidden");
    const remarks = el("textarea");
    remarks.rows = 3;
    remarks.maxLength = 8000;
    remarks.placeholder = tx("What to change in the plan");
    const sendRemarks = el("button", "small primary", tx("Send remarks"));
    sendRemarks.id = "planSendRemarks";
    sendRemarks.addEventListener("click", () => {
      const text = remarks.value.trim();
      if (!text) { remarks.focus(); return; }
      act(() => window.atlas.reviseTask({ agentId: agent.agentId, taskId: task.taskId, remarks: text,
        answers: answers.map((input) => input.value) }), text);
    });
    remarksBox.append(remarks, sendRemarks);
    revise.addEventListener("click", () => {
      remarksBox.classList.toggle("hidden");
      if (!remarksBox.classList.contains("hidden")) remarks.focus();
    });
    actions.append(approve, revise);
    if (!revision.formatted) {
      const form = el("button", "small", tx("Ask for the plan's form"));
      form.addEventListener("click", () => act(() => window.atlas.reviseTask({ agentId: agent.agentId, taskId: task.taskId,
        remarks: formRemark() }), formRemark()));
      actions.append(form);
    }
    body.append(actions, remarksBox);
  }
  if (task.stopped !== null && task.stage === "in-progress") {
    body.append(noteBlock("note", tx("Send the agent a message in the chat to go on with the plan, or cancel the task.")));
  }
  if (isOpenTask(task)) {
    const cancelRow = el("div", "actions");
    const cancel = el("button", "small", tx("Cancel the task"));
    cancel.id = "planCancel";
    cancel.addEventListener("click", () => act(() => window.atlas.cancelTask({ agentId: agent.agentId, taskId: task.taskId }), null));
    cancelRow.append(cancel);
    body.append(cancelRow);
  }
  body.append(result);

  const earlier = known.tasks.filter((item) => item !== task);
  if (earlier.length > 0) {
    body.append(el("div", "section-title", tx("Earlier tasks · {count}", { count: earlier.length })));
    // Each earlier task opens to its plan (the approved revision, else the last) and its results.
    for (const item of earlier.slice(0, 10)) {
      const row = el("div", "plan-earlier");
      row.append(el("span", "plan-earlier-id", item.taskId), el("span", "plan-earlier-stage", taskStageWords(item)),
        el("span", "plan-earlier-text", item.text.split(/\r?\n/u)[0].slice(0, 120)));
      const plan = item.revisions.find((one) => one.revision === item.approved?.revision) ?? item.revisions.at(-1) ?? null;
      const { card } = planCard({ key: item.taskId, title: row, nested: true, openByDefault: false, fill: (inside) => {
        inside.append(el("div", "plan-task", item.text));
        if (plan === null) inside.append(el("div", "empty", tx("The agent gave no plan for this task.")));
        else {
          inside.append(el("div", "section-title", tx("Plan · revision {revision}", { revision: plan.revision })));
          fillPlanRecord(inside, plan, { steps: item.steps.length > 0 ? item.steps : null, answers: item.approved?.answers ?? [] });
        }
        if (Array.isArray(item.results)) inside.append(taskResultsCard(item));
      } });
      card.classList.add("plan-earlier-card");
      body.append(card);
    }
  }
}

// --- permission mode -------------------------------------------------------------
//
// As in Claude Code: manual (the agent asks about edits and commands that change things),
// accept edits, auto (the Claude Code classifier decides on its own and asks
// when it is not sure) and bypass permissions. The mode is the person's decision: the
// trusted host changes it, and it applies from the next turn.

const PERMISSION_MODE_WORDS = Object.freeze({
  default: { label: tx("Manual"),
    hint: tx("the agent asks you before file edits and commands that change something; reading needs no asking.") },
  acceptEdits: { label: tx("Accept edits"),
    hint: tx("file edits in the project folder go through on their own; commands that change something go through you.") },
  auto: { label: tx("Auto"),
    hint: tx("the Claude Code classifier approves or declines each action; when it is not sure, it asks you.") },
  bypassPermissions: { label: tx("Bypass permissions"),
    hint: tx("the agent asks nothing: any commands and edits in the project folder.") },
});
// Shift+Tab cycles through three; “bypass permissions” is chosen only explicitly, from the list.
const CYCLED_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto"]);
const PERMISSION_MODES_TTL_MS = 30_000;

/** The modes of all agents and the provider mode are held by the trusted host; null if they cannot be read. */
async function readPermissionModes({ force = false } = {}) {
  const known = workspaceState.permissionModes ?? null;
  if (!force && known !== null && Date.now() - known.readAt < PERMISSION_MODES_TTL_MS) return known;
  if (typeof window.atlas?.permissionModes !== "function" || atlasState.trusted?.available !== true) return null;
  const response = await window.atlas.permissionModes();
  if (!response.ok) return null;
  workspaceState.permissionModes = { readAt: Date.now(), defaultMode: response.data.defaultMode,
    byAgent: new Map(response.data.agents.map((item) => [item.agentId, item.permissionMode])),
    memoryAutonomy: new Map(response.data.agents.map((item) => [item.agentId, item.ownMemoryWithoutAsking === true])) };
  return workspaceState.permissionModes;
}

/** The mode list by the input field: the agent's own mode, or without one the provider mode with a mark. */
function renderPermissionPicker(agent, result) {
  const select = el("select", "field chat-permission");
  select.id = "chatPermission";
  for (const [value, words] of Object.entries(PERMISSION_MODE_WORDS)) {
    const option = el("option", null, words.label);
    option.value = value;
    select.append(option);
  }
  select.disabled = true;
  select.title = tx("Permission mode: reading…");
  const paint = (modes) => {
    if (modes === null) {
      select.title = tx("Permission mode unavailable: the trusted actions of this window do not work.");
      return;
    }
    const own = modes.byAgent.get(agent.agentId) ?? null;
    const current = own ?? modes.defaultMode ?? "acceptEdits";
    for (const option of select.options) {
      option.textContent = PERMISSION_MODE_WORDS[option.value].label
        + (own === null && option.value === current ? tx(" · default") : "");
    }
    select.value = current;
    select.dataset.current = current;
    select.disabled = agent.state === "archived";
    select.title = tx("Permission mode: {hint}\nShift+Tab in the input field: next mode.", { hint: PERMISSION_MODE_WORDS[current].hint });
  };
  readPermissionModes().then(paint);
  select.addEventListener("change", async () => {
    const mode = select.value;
    select.disabled = true;
    const response = await window.atlas.setPermissionMode({ agentId: agent.agentId, permissionMode: mode });
    if (response.ok) {
      atlasRecord("ok", tx("permission mode"), `${agent.agentId}: ${mode}`);
      result.replaceChildren(noteBlock("note",
        tx("From the next turn — “{label}”: {hint}", { label: PERMISSION_MODE_WORDS[mode].label, hint: PERMISSION_MODE_WORDS[mode].hint })));
    } else if (response.error?.code !== "user_declined") {
      atlasRecord("bad", tx("permission mode"), `${agent.agentId}: ${response.error?.reasonCode || response.error?.code}`);
      result.replaceChildren(noteBlock("error",
        tx("Mode not changed: {value}.", { value: response.error?.reasonCode || response.error?.code || tx("error") })));
    }
    const modes = await readPermissionModes({ force: true });
    if (modes === null) select.value = select.dataset.current ?? mode;
    paint(modes);
  });
  return select;
}

function cyclePermissionMode() {
  const select = document.getElementById("chatPermission");
  if (select === null || select.disabled) return;
  const index = CYCLED_PERMISSION_MODES.indexOf(select.value);
  select.value = CYCLED_PERMISSION_MODES[(index + 1) % CYCLED_PERMISSION_MODES.length];
  select.dispatchEvent(new Event("change"));
}

/**
 * Messages waiting for the end of the turn. When the turn ends, they go on their own (or do not,
 * if the turn was stopped), and the list empties: after that they are visible in the conversation.
 */
function paintQueued(box, agent) {
  const list = workspaceState.queued.get(agent.agentId) ?? [];
  if (agent.currentOperationId === null && list.length > 0) workspaceState.queued.delete(agent.agentId);
  const shown = workspaceState.queued.get(agent.agentId) ?? [];
  box.replaceChildren();
  box.hidden = shown.length === 0;
  for (const item of shown) {
    const row = el("div", "chat-queued-item");
    row.append(el("span", "chat-queued-mark", tx("after the turn")));
    row.append(el("span", "chat-queued-text", item.text.split(/\r?\n/u)[0]));
    const take = el("button", "icon-btn flat", "×");
    take.title = tx("Withdraw the message: it will not be sent");
    take.addEventListener("click", async () => {
      take.disabled = true;
      const response = await window.atlas.unqueue({ agentId: agent.agentId, operationId: item.operationId });
      const cancelled = response.ok && response.data.output?.cancelled === true;
      const left = (workspaceState.queued.get(agent.agentId) ?? []).filter((entry) => entry !== item);
      if (left.length > 0) workspaceState.queued.set(agent.agentId, left);
      else workspaceState.queued.delete(agent.agentId);
      if (cancelled) {
        // The text returns to the input field: it can be fixed and sent again.
        const input = box.parentElement?.querySelector("textarea");
        if (input && input.value.trim() === "") {
          input.value = item.text;
          setDraft(agent.agentId, item.text);
        }
        atlasRecord("info", tx("message withdrawn"), agent.agentId);
      } else {
        atlasRecord("info", tx("message already sent to the agent"), agent.agentId);
      }
      paintQueued(box, agentOf() ?? agent);
    });
    row.append(take);
    box.append(row);
  }
}

/** Draws the model picker by the input field again, in place: the typed text is not touched. */
function replaceModelPicker(agent, result) {
  const picker = document.getElementById("chatModel");
  if (picker === null) return;
  const [model, effort] = renderModelPicker(agent, result);
  document.getElementById("chatEffort")?.replaceWith(effort);
  picker.replaceWith(model);
}

/**
 * The model and reasoning level of the next turns, right by the input field, as in
 * Claude Code and Codex. The conversation stays the same; with a new model the prompt cache
 * starts over, so the first turn after a switch costs more.
 */
function renderModelPicker(agent, result) {
  const profile = agent.profile ?? null;
  const available = operationStatus("mutation.memory.agent.profile")?.status === "available";
  // Only a model of the same provider can be chosen: the agent's provider does not change.
  const models = modelCatalog?.ok ? modelCatalog.data.models
    .filter((item) => item.provider === undefined || item.provider === profile?.provider) : [];
  const model = el("select", "field chat-model");
  model.id = "chatModel";
  const effort = el("select", "field chat-effort");
  effort.id = "chatEffort";
  if (profile === null || models.length === 0 || !available) {
    model.disabled = true;
    effort.disabled = true;
    model.title = !available ? tx("The backend does not offer model switching") : tx("The model list has not been read yet");
  }
  const known = models.some((item) => item.id === profile?.model);
  for (const item of known || profile === null ? models : [{ id: profile.model, name: profile.model }, ...models]) {
    const option = el("option", null, (item.name ?? item.id) + modelStateSuffix(item.id));
    option.value = item.id;
    model.append(option);
  }
  if (profile !== null) model.value = profile.model;
  const fillEfforts = () => {
    const chosen = models.find((item) => item.id === model.value);
    const efforts = chosen?.efforts ?? [profile?.reasoningEffort ?? "default"];
    effort.replaceChildren(...efforts.map((value) => {
      const option = el("option", null, value === "default" ? tx("default") : value);
      option.value = value;
      return option;
    }));
    effort.value = efforts.includes(profile?.reasoningEffort) && model.value === profile?.model
      ? profile.reasoningEffort : chosen?.defaultEffort ?? efforts[0];
  };
  fillEfforts();
  effort.title = tx("Reasoning level of the next turns");
  const apply = async () => {
    if (profile === null || (model.value === profile.model && effort.value === profile.reasoningEffort)) return;
    model.disabled = true;
    effort.disabled = true;
    const response = await window.atlas.setProfile({ agentId: agent.agentId, provider: profile.provider,
      model: model.value, reasoningEffort: effort.value });
    if (response.ok) {
      result.replaceChildren(noteBlock("note",
        tx("From the next turn — a new model. The conversation is the same; the first turn after the switch reads it without cache and costs more.")));
      atlasRecord("ok", tx("agent model"), `${agent.agentId}: ${model.value} · ${effort.value}`);
      const chosen = { ...profile, model: model.value, reasoningEffort: effort.value };
      await refresh();
      // The picker is drawn again for the agent as it is now (the owner could not switch back, 02.11):
      // the old one stayed locked and still took the old model for the current one, so choosing
      // it again changed nothing. The backend has exactly the chosen profile now.
      replaceModelPicker({ ...(agentOf() ?? agent), profile: chosen }, result);
    } else {
      result.replaceChildren(noteBlock("error", tx("Model not changed: {value}.", { value: response.error?.code ?? tx("error") })));
      model.value = profile.model;
      fillEfforts();
      model.disabled = false;
      effort.disabled = false;
    }
  };
  model.addEventListener("change", () => { fillEfforts(); apply(); });
  effort.addEventListener("change", apply);
  return [model, effort];
}

/** A turn the chat still shows as running. */
const liveShowsRunning = (live) => (live?.data?.turns ?? []).some((turn) => turn.state === "active" || turn.state === "pending");

/**
 * Events are only a "read again" signal: one that did not come (the window behind other windows,
 * a missed notification) must not leave a finished turn "running".
 * The agent's record, which the world reads every few seconds, knows that
 * its turn is over: then the conversation is read directly.
 */
function catchUpFinishedTurn(agent) {
  const live = workspaceState.live;
  if (live === null || live.agentId !== agent.agentId || live.loading || !liveShowsRunning(live)) return false;
  if (agent.currentOperationId !== null && agent.currentOperationId !== undefined) return false;
  if (live.readAt !== null && Date.now() - live.readAt.getTime() < 3000) return false;
  readLive(agent);
  return true;
}

/** One refresh step of the open chat: on the timer and when the window is visible again. */
function tickChat() {
  if (workspaceState.node === null || workspaceState.tab !== "chat") return;
  if (document.visibilityState !== "visible") return;
  const agent = agentOf();
  if (agent === null) return;
  if (workspaceState.chatSource === "live") {
    if (catchUpFinishedTurn(agent)) return;
    if (eventsAvailable()) pollAgentEvents(agent);
    else readLive(agent);
  } else if (workspaceState.chatSource === "archive") {
    readFeed(agent);
  }
}

// While the window was hidden the chat did not refresh: back, it looks at once, not after the interval.
document.addEventListener("visibilitychange", tickChat);

/** The agent's turn runs: the chat asks more often, so as not to lag behind the trace. */
function chatBusy() {
  const agent = agentOf();
  if (agent === null) return false;
  return (agent.currentOperationId !== null && agent.currentOperationId !== undefined) || liveShowsRunning(workspaceState.live);
}

// The next step is set after the current one: the interval depends on whether a turn runs.
function startFeedTimer() {
  stopFeedTimer();
  const arm = () => {
    const handle = setTimeout(() => {
      if (workspaceState.feedTimer !== handle) return;
      tickChat();
      arm();
    }, chatBusy() ? FEED_RUNNING_MS : FEED_REFRESH_MS);
    workspaceState.feedTimer = handle;
  };
  arm();
}

function stopFeedTimer() {
  if (workspaceState.feedTimer === null) return;
  clearTimeout(workspaceState.feedTimer);
  workspaceState.feedTimer = null;
}

function receiptButton(identity, target) {
  return actionButton(tx("Operation receipt"), "receipt.memory.agent.send", async () => {
    const response = await window.atlas.sendReceipt(identity);
    if (response.ok) {
      const record = response.data.output;
      atlasRecord("ok", tx("receipt read"),
        `${identity.operationId}: ${record.state} / ${record.observation}`);
      target.append(noteBlock("note",
        tx("Receipt: state {state}, observation {observation}. Retrying is not allowed.", { state: record.state, observation: record.observation })));
    } else {
      atlasRecord("bad", tx("receipt not read"), response.error.code);
      target.append(noteBlock("error", tx("Receipt unavailable: {code}", { code: response.error.code })));
    }
  });
}

// --- project files and artifacts: read only ------------------------------------

const FILE_REASON_WORDS = Object.freeze({
  artifact_not_registered: tx("artifact not registered"),
  file_changed: tx("the file changed after the first page — pages of different versions are not stitched together, open it again"),
  content_sha256_changed: tx("the file changed after the first page — open it again"),
  cursor_invalid: tx("the page cursor is outdated — open the file again"),
  stale_revision: tx("the file changed — open it again"),
});

/**
 * A refusal in words. For source_unavailable, only the three published reasons
 * (describeWorkspaceRefusal); without a reason it is unknown and is not guessed.
 */
const failureWords = (error) => {
  if (error === null || error === undefined) return tx("error");
  if (error.code === "source_unavailable") return describeWorkspaceRefusal(error).title;
  const reason = FILE_REASON_WORDS[error.reasonCode] ?? FILE_REASON_WORDS[error.code] ?? error.reasonCode;
  return reason ? `${error.code}: ${reason}` : error.code;
};

const sizeWords = (bytes) => (bytes === null || bytes === undefined ? tx("size not reported")
  : bytes < 1024 ? tx("{bytes} B", { bytes }) : tx("{value} KB", { value: (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) }));

const fileDirty = (file) => file !== null && file.editing === true && file.draft !== file.original;

/** An unsaved edit is not lost on navigation: save it or cancel it first. */
function leaveBlocked(state) {
  if (!fileDirty(state.file)) return false;
  state.file.outcome = { tone: "conflict", keepDirty: true, reconcile: false,
    title: tx("There is an unsaved edit."), details: [tx("Save it or cancel it first — navigating away does not discard it.")] };
  renderWorkspace();
  return true;
}

/** Open a folder with a click: show that it is being read, and read it. */
function openProjectDirectory(state, path) {
  if (leaveBlocked(state)) return undefined;
  state.path = path;
  state.file = null;
  state.loading = true;
  renderWorkspace();
  return fetchProjectDirectory(state, path);
}

// Reads one folder; does not draw until the answer, so it can also be called from rendering.
async function fetchProjectDirectory(state, path) {
  const response = await window.atlas.projectFiles({ projectId: state.projectId, path });
  state.loading = false;
  state.listing = response.ok ? response.data : null;
  state.error = response.ok ? null : response.error;
  if (!response.ok) atlasRecord("bad", tx("folder not read"), `${state.projectId}/${path} ${response.error.code}`);
  if (workspaceState.tab === "files") renderWorkspace();
}

/** Images the Files tab shows itself (project-images.mjs): the Gateway reads text only. */
const PROJECT_IMAGE = /\.(?:png|jpe?g|gif|webp|bmp)$/iu;

/** An image of the project folder, read by the trusted host and shown reduced. */
async function openProjectImage(state, path) {
  if (leaveBlocked(state)) return;
  state.file = { path, pages: [], image: null, error: null, loading: true, search: "" };
  const file = state.file;
  renderWorkspace();
  const response = await window.atlas.projectImage({ projectId: state.projectId, path });
  file.loading = false;
  if (response.ok) file.image = response.data;
  else file.error = response.error;
  if (workspaceState.tab === "files") renderWorkspace();
}

async function openProjectFile(state, path, cursor = null) {
  if (cursor === null && PROJECT_IMAGE.test(path)) return openProjectImage(state, path);
  if (cursor === null && leaveBlocked(state)) return;
  if (cursor === null) state.file = { path, pages: [], error: null, loading: true, search: "" };
  const file = state.file;
  file.loading = true;
  renderWorkspace();
  // A continuation names the version it continues: a page of a changed
  // file is rejected by the host, not glued to the old text.
  const expectedSha256 = cursor === null ? null : file.pages[0]?.contentSha256 ?? null;
  const response = await window.atlas.projectFile({ projectId: state.projectId, path, cursor, expectedSha256 });
  file.loading = false;
  if (response.ok) file.pages.push(response.data);
  else file.error = response.error;
  if (workspaceState.tab === "files") renderWorkspace();
}

/**
 * Read the whole file again (all pages of one version). The edit, if there
 * is one, stays in the editor: only the version to save against changes.
 */
async function rereadWholeFile(state, file) {
  const pages = [];
  let cursor = null;
  do {
    const response = await window.atlas.projectFile({ projectId: state.projectId, path: file.path, cursor,
      expectedSha256: pages[0]?.contentSha256 ?? null });
    if (!response.ok) return { ok: false, error: response.error };
    pages.push(response.data);
    cursor = response.data.nextCursor;
  } while (cursor !== null && pages.length < 16);
  if (cursor !== null) return { ok: false, error: { code: "file_too_large" } };
  return { ok: true, pages };
}

/**
 * Project files of the agent. Each folder opens with a click by the person: the desk
 * does not walk through anything on its own. A file is read in pages of up to 64 KB; over 1 MB the backend does
 * not return it at all. A text file read in full can be edited and saved
 * (Kit v0.16.1), only against the hash it was read with.
 */
/**
 * Agent history: its commits in the project folder. The Gateway commits the work of each
 * turn itself, on behalf of the agent and only the files of that turn. A folder without git
 * is offered to become a repository (with confirmation; nothing is committed).
 */
function renderAgentCommits(body, agent) {
  if (typeof window.atlas?.agentCommits !== "function" || atlasState.trusted?.available !== true) return;
  const box = el("details", "agent-commits");
  box.open = workspaceState.commitsOpen === true;
  box.addEventListener("toggle", () => { workspaceState.commitsOpen = box.open; });
  const summary = el("summary", "section-title", tx("Agent history · reading…"));
  box.append(summary);
  body.append(box);
  window.atlas.agentCommits({ agentId: agent.agentId }).then((response) => {
    const rows = el("div");
    box.replaceChildren(summary, rows);
    if (!response.ok) {
      summary.textContent = tx("Agent history");
      rows.append(noteBlock("error", tx("Commits not read: {value}.", { value: response.error?.reasonCode || response.error?.code || tx("no code") })));
      return;
    }
    const { versioned, commits } = response.data;
    if (!versioned) {
      summary.textContent = tx("Agent history · folder not under git");
      rows.append(noteBlock("note", tx("The project folder is not under git, so the work of agents is not committed. Make it a ")
        + tx("repository: from then on each agent turn becomes a separate commit on its behalf, with only the files of that turn.")));
      const actions = el("div", "actions");
      actions.append(trustedButton(tx("Create a git repository…"), async () => {
        const done = await window.atlas.initProjectGit({ projectId: agent.projectId });
        if (done.ok) {
          atlasRecord("ok", tx("git for the project folder"), agent.projectId);
          workspaceState.commitsOpen = true;
          renderWorkspace();
        } else if (done.error?.code !== "user_declined") {
          rows.append(noteBlock("error", tx("Repository not created: {value}.", { value: done.error?.reasonCode || done.error?.code || tx("no code") })));
        }
      }));
      rows.append(actions);
      return;
    }
    summary.textContent = tx("Agent history · {length} {value}", { length: commits.length, value: commits.length === 1 ? tx("commit") : tx("commits") });
    if (commits.length === 0) {
      rows.append(el("div", "empty", tx("This agent has no commits yet: they will appear after a turn in which it changes something.")));
    }
    for (const commit of commits.slice(0, 20)) {
      const row = el("div", "entry");
      const when = commit.atUtc ? new Date(commit.atUtc).toLocaleString(dateLocale(),
        { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      row.append(el("div", "entry-title", commit.subject || commit.sha.slice(0, 8)));
      row.append(el("div", "entry-text", [commit.sha.slice(0, 8), when,
        commit.files === null ? null : tx("files: {files}", { files: commit.files })].filter(Boolean).join(" · ")));
      rows.append(row);
    }
  });
}

function renderFiles(body, agent) {
  renderAgentCommits(body, agent);
  const status = operationStatus("query.project-workspace.list");
  if (status?.status !== "available") {
    body.append(noteBlock("error", tx("Project files unavailable: {value}.", { value: status ? status.reasonCode ?? status.status : tx("not checked") })));
    return;
  }
  let state = workspaceState.files;
  if (state === null || state.projectId !== agent.projectId) {
    state = { projectId: agent.projectId, path: "", listing: null, error: null, loading: true, file: null };
    workspaceState.files = state;
    fetchProjectDirectory(state, "");
  }
  body.append(el("div", "section-title", tx("Project {projectId} · /{path}", { projectId: state.projectId, path: state.path })));
  const nav = el("div", "actions");
  if (state.path !== "") {
    const up = el("button", "small", tx("Up one level"));
    up.addEventListener("click", () => openProjectDirectory(state, state.path.split("/").slice(0, -1).join("/")));
    nav.append(up);
  }
  const reload = el("button", "small", tx("Reread folder"));
  reload.addEventListener("click", () => openProjectDirectory(state, state.path));
  nav.append(reload);
  body.append(nav);

  if (state.loading) body.append(el("div", "empty", tx("Reading the folder…")));
  else if (state.error !== null) {
    body.append(noteBlock("error", tx("Folder not read. {value} It is unknown, not empty.", { value: failureWords(state.error) })));
  } else if (state.listing !== null) {
    const listing = state.listing;
    if (listing.entries.length === 0) body.append(el("div", "empty", tx("The folder is empty.")));
    for (const entry of listing.entries) {
      const row = el("div", "file-row");
      const child = state.path === "" ? entry.name : `${state.path}/${entry.name}`;
      const open = el("button", "small", entry.kind === "directory" ? `${entry.name}/` : entry.name);
      if (child.length > 256) {
        open.disabled = true;
        open.title = tx("Path longer than 256 characters — the contract does not accept it");
      } else if (entry.kind === "directory") {
        open.addEventListener("click", () => openProjectDirectory(state, child));
      } else {
        open.addEventListener("click", () => openProjectFile(state, child));
      }
      row.append(open, el("span", "muted", entry.kind === "directory" ? tx("folder") : sizeWords(entry.sizeBytes)));
      body.append(row);
    }
    if (listing.truncated || listing.omissionCount > 0) {
      body.append(noteBlock("note",
        tx("Showing {length} of {totalEntries}, {omissionCount} omitted.", { length: listing.entries.length, totalEntries: listing.totalEntries, omissionCount: listing.omissionCount })));
    }
    body.append(el("div", "muted", tx("read at {observedAtUtc}", { observedAtUtc: listing.observedAtUtc })));
  }

  const file = state.file;
  if (file !== null) {
    body.append(el("div", "section-title", tx("File {path}", { path: file.path })));
    if (file.image) {
      const image = file.image;
      body.append(infoRow(tx("size"), sizeWords(image.sizeBytes)));
      if (image.width !== null) {
        body.append(infoRow(tx("picture"), image.shownWidth < image.width
          ? tx("{width}×{height}, shown reduced to {shownWidth}×{shownHeight}", image)
          : tx("{width}×{height}", image)));
      }
      const picture = el("img", "file-image");
      picture.src = image.dataUrl;
      picture.alt = file.path;
      body.append(picture);
    }
    const last = file.pages[file.pages.length - 1] ?? null;
    if (last !== null) {
      const shown = last.range.offsetBytes + last.range.returnedBytes;
      body.append(infoRow(tx("shown"), tx("{value} of {value2}", { value: sizeWords(shown), value2: sizeWords(last.range.totalBytes) })));
      body.append(infoRow(tx("file fingerprint"), `${last.contentSha256.slice(0, 16)}…`));
      const loaded = file.pages.map((page) => page.text).join("");
      if (file.editing === true) {
        renderEditor(body, state, file);
      } else {
        body.append(el("pre", "file-text", loaded));
        renderFileSearch(body, file, loaded, last);
        renderEditEntry(body, file, loaded, last);
      }
      if (last.nextCursor !== null) {
        const more = el("button", "small", tx("Next 64 KB"));
        more.disabled = file.loading;
        more.addEventListener("click", () => openProjectFile(state, file.path, last.nextCursor));
        body.append(more);
      }
    }
    if (file.outcome) renderFileOutcome(body, state, file);
    if (file.loading) body.append(el("div", "empty", tx("Reading the file…")));
    if (file.error !== null) {
      // The Gateway reads text only: another file is "access_denied" there, which says too little.
      const words = { image_missing: tx("the file is not there"), image_too_large: tx("the picture is over 40 MB"),
        image_path_invalid: tx("the path is not one Atlas reads"), image_type_unsupported: tx("not a picture Atlas shows"),
        project_folder_unavailable: tx("the project's folder is not bound on this PC, or it is gone") }[file.error.code]
        ?? (file.error.code === "access_denied" ? tx("not a text file (or a private one): only text files and pictures are shown here")
          : failureWords(file.error));
      body.append(noteBlock("error", tx("File not read: {value}.", { value: words })));
    }
  }
  body.append(noteBlock("note",
    tx("Folders are not walked on their own: each one opens with your click. A path is up to 256 characters, a page up to 64 KB, ")
    + tx("a file up to 1 MB. Only a whole text file is saved, and only over the version that was read.")
    + tx(" Pictures (PNG, JPEG, GIF, WebP, BMP, up to 40 MB) are shown, reduced when wide.")));
}

/** Search in the open file covers the loaded pages, and says so. */
function renderFileSearch(body, file, loaded, last) {
  const row = el("div", "file-search");
  const field = el("input");
  field.placeholder = tx("Find in file");
  field.value = file.search ?? "";
  const summary = el("div", "muted");
  const paint = () => {
    file.search = field.value;
    const found = findInText(loaded, field.value);
    const shown = last.range.offsetBytes + last.range.returnedBytes;
    const scope = shown < last.range.totalBytes ? tx(" (in the loaded {value} of {value2})", { value: sizeWords(shown), value2: sizeWords(last.range.totalBytes) }) : "";
    summary.textContent = field.value.trim() === "" ? ""
      : found.count === 0 ? tx("Not found{scope}.", { scope })
        : tx("Found: {count}{value}{scope}; lines {value2}{value3}.", { count: found.count, value: found.truncated ? "+" : "", scope, value2: found.matches.slice(0, 20).map((match) => match.line).join(", "), value3: found.count > 20 ? "…" : "" });
  };
  field.addEventListener("input", paint);
  row.append(field);
  body.append(row, summary);
  paint();
}

/** The “Edit” button: only for a whole file that was read, and only when saving is declared. */
function renderEditEntry(body, file, loaded, last) {
  const verdict = canEditFile(file.pages, operationStatus("mutation.project-workspace.save"));
  const edit = el("button", "small", tx("Edit"));
  edit.disabled = !verdict.allowed;
  edit.title = verdict.reason ?? "";
  edit.addEventListener("click", () => {
    if (!verdict.allowed) return;
    file.editing = true;
    file.original = loaded;
    file.draft = loaded;
    file.baseSha256 = last.contentSha256;
    file.outcome = null;
    renderWorkspace();
  });
  const row = el("div", "actions");
  row.append(edit);
  if (!verdict.allowed) row.append(el("span", "muted", verdict.reason));
  body.append(row);
}

/**
 * Editor. “not saved” is always visible while the text differs from what was read.
 * Saving requires OS confirmation and goes only against the hash of the version
 * that was read; after a refusal or an unknown outcome the edit stays here.
 */
function renderEditor(body, state, file) {
  const dirtyLine = el("div", "editor-dirty");
  const paintDirty = () => {
    const dirty = fileDirty(file);
    dirtyLine.textContent = dirty ? tx("● not saved") : tx("no changes");
    dirtyLine.classList.toggle("dirty", dirty);
    save.disabled = !dirty || file.saving === true;
  };
  const area = el("textarea", "file-editor");
  area.value = file.draft;
  area.spellcheck = false;
  area.addEventListener("input", () => {
    file.draft = area.value;
    paintDirty();
  });
  body.append(infoRow(tx("edit base"), `${file.baseSha256.slice(0, 16)}…`), dirtyLine, area);
  const actions = el("div", "actions");
  const save = el("button", "small primary", tx("Save with confirmation"));
  save.addEventListener("click", async () => {
    if (!fileDirty(file) || file.saving) return;
    file.saving = true;
    paintDirty();
    const response = await window.atlas.saveProjectFile({
      projectId: state.projectId, path: file.path, expectedSha256: file.baseSha256, text: file.draft,
    });
    file.saving = false;
    await afterSave(state, file, response);
  });
  const discard = el("button", "small", file.discardArmed ? tx("Really discard the edit") : tx("Cancel edit"));
  discard.addEventListener("click", () => {
    if (fileDirty(file) && !file.discardArmed) {
      file.discardArmed = true;
      renderWorkspace();
      return;
    }
    file.editing = false;
    file.discardArmed = false;
    file.draft = null;
    file.outcome = null;
    renderWorkspace();
  });
  actions.append(save, discard);
  body.append(actions);
  paintDirty();
}

/** Save outcome: a success is checked by reading again, a refusal keeps the edit. */
async function afterSave(state, file, response) {
  const described = describeSaveFileOutcome(response);
  file.outcome = described;
  file.lastOperationId = response.ok ? response.data.receipt.operationId : response.identity?.operationId ?? null;
  atlasRecord(described.tone === "note" ? "ok" : "bad", tx("file save"),
    `${state.projectId}/${file.path}: ${described.title} ${file.lastOperationId ?? ""}`);
  if (response.ok) {
    const fresh = await rereadWholeFile(state, file);
    const receipt = response.data.receipt;
    if (fresh.ok) {
      const matches = fresh.pages[0].contentSha256 === receipt.contentSha256;
      file.pages = fresh.pages;
      file.editing = false;
      file.draft = null;
      file.outcome = { ...described, details: [...described.details, matches
        ? tx("Reread: the file matches the receipt.")
        : tx("Reread: the file no longer matches the receipt — it was changed after saving.")] };
    } else {
      file.outcome = { ...described, details: [...described.details, tx("Could not reread: {value}.", { value: failureWords(fresh.error) })] };
    }
  }
  renderWorkspace();
}

/** The outcome of the last file action and honest next steps. */
function renderFileOutcome(body, state, file) {
  const outcome = file.outcome;
  body.append(outcomeBlock(outcome));
  const actions = el("div", "actions");
  if (outcome.reconcile && file.lastOperationId) {
    const check = el("button", "small", tx("Check by reading the file"));
    check.addEventListener("click", async () => {
      const response = await window.atlas.reconcileFileSave({ operationId: file.lastOperationId });
      if (!response.ok) {
        file.outcome = { tone: "error", keepDirty: true, reconcile: true, title: tx("Check failed: {value}.", { value: failureWords(response.error) }), details: [] };
      } else if (response.data.state === "applied") {
        file.outcome = { tone: "note", keepDirty: false, reconcile: false, title: tx("Checked: the write happened."),
          details: [tx("The file contains exactly the sent text.")] };
        const fresh = await rereadWholeFile(state, file);
        if (fresh.ok) {
          file.pages = fresh.pages;
          file.editing = false;
          file.draft = null;
        }
      } else if (response.data.state === "not-applied") {
        file.outcome = { tone: "uncertain", keepDirty: true, reconcile: false, resend: true,
          title: tx("Checked: the write did not happen, the file is unchanged."),
          details: [tx("The edit is in the editor. The same request can be sent again — with the same identifier and the same base.")] };
      } else {
        file.outcome = { tone: "conflict", keepDirty: true, reconcile: false,
          title: tx("Checked: the file was changed by someone else."), details: [tx("The edit stayed in the editor; reread the file and decide for yourself.")] };
      }
      renderWorkspace();
    });
    actions.append(check);
  }
  if (outcome.resend && file.lastOperationId) {
    const again = el("button", "small", tx("Send the same request"));
    again.addEventListener("click", async () => {
      const response = await window.atlas.resendFileSave({ operationId: file.lastOperationId });
      await afterSave(state, file, response);
    });
    actions.append(again);
  }
  if (outcome.tone === "conflict" && file.editing) {
    const reread = el("button", "small", tx("Reread the file, keep the edit"));
    reread.addEventListener("click", async () => {
      const fresh = await rereadWholeFile(state, file);
      if (!fresh.ok) {
        file.outcome = { tone: "error", keepDirty: true, reconcile: false, title: tx("Not reread: {value}.", { value: failureWords(fresh.error) }), details: [] };
      } else {
        file.pages = fresh.pages;
        file.original = fresh.pages.map((page) => page.text).join("");
        file.baseSha256 = fresh.pages[0].contentSha256;
        file.outcome = { tone: "note", keepDirty: true, reconcile: false, title: tx("New version reread; the edit stayed."),
          details: [tx("The base is now {value}… — saving will replace this version with your text.", { value: file.baseSha256.slice(0, 16) })] };
      }
      renderWorkspace();
    });
    actions.append(reread);
  }
  if (actions.childElementCount > 0) body.append(actions);
}

// Reads the artifact list; draws only on the answer, so it is called from rendering.
async function loadArtifacts(agent) {
  workspaceState.artifacts = { agentId: agent.agentId, loading: true, catalog: null, error: null, opened: new Map() };
  const response = await window.atlas.artifacts({ agentId: agent.agentId });
  const state = workspaceState.artifacts;
  if (state === null || state.agentId !== agent.agentId) return;
  state.loading = false;
  state.catalog = response.ok ? response.data : null;
  state.error = response.ok ? null : response.error;
  if (workspaceState.tab === "artifacts") renderWorkspace();
}

/**
 * Artifacts are registered links with a hash, not the whole work result and
 * not saved copies. The text is shown only if the file is still the one that
 * was registered.
 */
function renderArtifacts(body, agent) {
  const status = operationStatus("query.agent-artifacts.list");
  if (status?.status !== "available") {
    body.append(noteBlock("error", tx("Artifacts unavailable: {value}.", { value: status ? status.reasonCode ?? status.status : tx("not checked") })));
    return;
  }
  if (workspaceState.artifacts === null || workspaceState.artifacts.agentId !== agent.agentId) loadArtifacts(agent);
  const state = workspaceState.artifacts;
  if (state.loading) {
    body.append(el("div", "empty", tx("Reading the artifact list…")));
    return;
  }
  if (state.error !== null) {
    body.append(noteBlock("error", tx("List not read: {value}. It is unknown, not empty.", { value: failureWords(state.error) })));
    return;
  }
  const catalog = state.catalog;
  body.append(el("div", "section-title", tx("Registered · {length} · revision {revision}", { length: catalog.records.length, revision: catalog.revision })));
  const reread = el("button", "small", tx("Reread list"));
  reread.addEventListener("click", () => {
    workspaceState.artifacts = null;
    renderWorkspace();
  });
  const rereadRow = el("div", "actions");
  rereadRow.append(reread);
  body.append(rereadRow);
  if (catalog.records.length === 0) body.append(el("div", "empty", tx("The agent has not registered any artifacts.")));
  for (const record of catalog.records) {
    const box = el("div", "entry");
    box.append(el("div", "entry-title", record.path));
    // A task's result (agent-tasks.mjs): its artifact is named after the task.
    const fromTask = /^(task-[A-Za-z0-9]+)\.\d+$/u.exec(record.artifactId ?? "");
    if (fromTask) box.append(el("div", "muted", tx("a result of task {taskId}", { taskId: fromTask[1] })));
    box.append(el("div", "entry-text",
      tx("{value} · registered {registeredAtUtc} · hash {value2}…", { value: sizeWords(record.sizeBytes), registeredAtUtc: record.registeredAtUtc, value2: record.sha256.slice(0, 12) })));
    const opened = state.opened.get(record.artifactId);
    const actions = el("div", "actions");
    const open = actionButton(opened ? tx("Reread") : tx("Open"), "query.agent-artifacts.read", async () => {
      state.opened.set(record.artifactId, { loading: true });
      renderWorkspace();
      const response = await window.atlas.artifact({ agentId: agent.agentId, artifactId: record.artifactId });
      state.opened.set(record.artifactId, response.ok ? response.data : { error: response.error });
      if (workspaceState.tab === "artifacts") renderWorkspace();
    });
    actions.append(open);
    box.append(actions);
    if (opened?.loading) box.append(el("div", "empty", tx("workspace2::Reading…")));
    else if (opened?.error) box.append(noteBlock("error", tx("Not read: {value}.", { value: failureWords(opened.error) })));
    else if (opened?.verification === "hash-matches") {
      box.append(el("div", "muted", tx("matches the registered hash · read at {observedAtUtc}", { observedAtUtc: opened.observedAtUtc })));
      box.append(el("pre", "file-text", opened.text));
    } else if (opened?.verification === "hash-mismatch") {
      box.append(noteBlock("error",
        tx("The file changed after registration: the hash does not match, it is no longer the same artifact. Content not shown.")));
    } else if (opened?.verification === "incomplete") {
      box.append(noteBlock("note", tx("The artifact was not read to the end — the hash cannot be checked, content not shown.")));
    }
    body.append(box);
  }
  body.append(noteBlock("note",
    tx("These are registered links to files with a hash — not the whole work result and not saved copies. ")
    + tx("Coverage: registered only.")));
}

function renderQuestions(body, agent) {
  const state = workspaceState.questions;
  if (state === null || state.agentId !== agent.agentId) {
    const actions = el("div", "actions");
    actions.append(actionButton(tx("Read questions"), "query.agent-control.interactions", async () => {
      const response = await window.atlas.interactions({ agentId: agent.agentId, limit: 32 });
      const delivered = response.ok && response.result.outcome === "succeeded";
      workspaceState.questions = {
        agentId: agent.agentId,
        records: delivered ? (response.result.output.records ?? []) : [],
        failed: !delivered,
        truncated: delivered ? (response.result.output.truncated ?? null) : null,
        omissionCount: delivered ? (response.result.output.omissionCount ?? null) : null,
        // The catalog is reread after the questions, so that the counters are not older than the questions.
        attention: response.attention ?? null,
      };
      renderWorkspace();
    }, { primary: true }));
    body.append(actions);
    return;
  }
  if (state.failed) {
    body.append(noteBlock("error", tx("Question list not read. It is unknown, not empty.")));
    return;
  }
  renderAttentionFacts(body, state.attention);
  if (state.truncated === true || (state.omissionCount ?? 0) > 0) {
    body.append(noteBlock("note",
      tx("Not all recent questions are shown: {value} omitted. ", { value: state.omissionCount ?? tx("an unknown number") })
      + tx("No completeness is claimed for the visible records.")));
  } else if (state.truncated === null) {
    body.append(el("div", "muted", tx("The backend did not report whether this list is complete.")));
  }
  const pending = state.records.filter((record) => record.state === "awaiting-owner");
  if (pending.length === 0) {
    body.append(el("div", "empty", tx("No question is waiting for an answer.")));
    return;
  }
  for (const record of pending) {
    // The same card as in the conversation: options as buttons and a custom answer.
    body.append(el("div", "muted",
      tx("requested {requestedAtUtc} · {value}", { requestedAtUtc: record.requestedAtUtc, value: record.deadlineAtUtc ? tx("deadline {deadlineAtUtc}", { deadlineAtUtc: record.deadlineAtUtc }) : tx("no deadline") })));
    body.append(questionCard(agent, record, async () => {
      workspaceState.questions = null;
      await refresh();
    }));
  }
  body.append(noteBlock("note",
    tx("Options come from the record itself. An outdated or already answered question cannot be revived.")));
}

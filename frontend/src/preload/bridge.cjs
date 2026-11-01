// The only opening between the renderer and the host.
//
// It exposes named calls, not a channel string the page can choose, so the page
// cannot reach a channel that is not listed here. No Node API, no filesystem, no
// gateway credentials pass through this file.

const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload ?? {});

// The one message the host sends inward: "the window is closing, write what you
// have". It carries no payload and cannot be used for anything else.
const onFlush = (handler) => {
  if (typeof handler !== "function") return;
  ipcRenderer.on("atlas:flush", async () => {
    try {
      await handler();
    } finally {
      ipcRenderer.send("atlas:flushed");
    }
  });
};

contextBridge.exposeInMainWorld("atlas", {
  // The window's language and its texts, asked once before any script runs (host/i18n.mjs):
  // the scripts' word tables are built as they load.
  locale: ipcRenderer.sendSync("atlas:locale"),
  appInfo: call("atlas:app-info"),
  runtime: call("atlas:runtime"),
  connection: call("atlas:connection"),
  operations: call("atlas:operations"),
  expected: call("atlas:expected"),
  world: call("atlas:world"),
  // The connected provider and its models, for the create-agent form's lists.
  models: call("atlas:models"),
  // The Claude account of the controller's agents, read on this machine.
  claudeAccount: call("atlas:claude-account"),
  claudeUsage: call("atlas:claude-usage"),
  // Whether the servers of the agents' models answer now (host/model-health.mjs).
  modelHealth: call("atlas:model-health"),
  // The person saw the last finished turn of an agent (its chat is open).
  turnSeen: call("atlas:turn-seen"),
  readScope: call("atlas:scope-read"),
  agentRead: call("atlas:agent-read"),
  agentContext: call("atlas:agent-context"),
  agentArchive: call("atlas:agent-archive"),
  interactions: call("atlas:interactions"),

  // The agent's workspace: bound conversation, project files, registered
  // artifacts and observed events. Read-only.
  conversation: call("atlas:conversation"),
  projectFiles: call("atlas:project-files"),
  projectFile: call("atlas:project-file"),
  artifacts: call("atlas:artifacts"),
  artifact: call("atlas:artifact"),
  agentEvents: call("atlas:agent-events"),

  // Trusted local actions. Each one opens a native confirmation the person
  // answers; the page cannot confirm on their behalf.
  trusted: call("atlas:trusted"),
  chooseWorkspace: call("atlas:choose-workspace"),
  bindWorkspace: call("atlas:bind-workspace"),
  saveMemory: call("atlas:save-memory"),
  // The project archive: archiving asks the person natively; restoring does not.
  archiveProject: call("atlas:archive-project"),
  restoreProject: call("atlas:restore-project"),
  archivedProjects: call("atlas:archived-projects"),
  actionJournal: call("atlas:action-journal"),
  undoAction: call("atlas:undo-action"),
  names: call("atlas:names"),
  rename: call("atlas:rename"),
  tasks: call("atlas:tasks"),
  startTask: call("atlas:start-task"),
  reviseTask: call("atlas:revise-task"),
  approveTask: call("atlas:approve-task"),
  cancelTask: call("atlas:cancel-task"),
  memoryChanges: call("atlas:memory-changes"),
  approveMemoryChange: call("atlas:approve-memory-change"),
  rejectMemoryChange: call("atlas:reject-memory-change"),
  setMemoryAutonomy: call("atlas:set-memory-autonomy"),
  projectFolder: call("atlas:project-folder"),
  projectImage: call("atlas:project-image"),
  exportMemoryDocument: call("atlas:export-memory-document"),
  rebindWorkspace: call("atlas:rebind-workspace"),
  settleSend: call("atlas:settle-send"),
  // Projects not on this PC: the list; taking one off and back, each confirmed natively.
  awayProjects: call("atlas:away-projects"),
  unmountProject: call("atlas:unmount-project"),
  mountProject: call("atlas:mount-project"),
  syncStatus: call("atlas:sync-status"),
  syncTake: call("atlas:sync-take"),
  syncRelease: call("atlas:sync-release"),
  setProjectPolicy: call("atlas:set-project-policy"),
  setPermissionMode: call("atlas:set-permission-mode"),
  permissionModes: call("atlas:permission-modes"),
  archiveQuarter: call("atlas:archive-quarter"),
  restoreQuarter: call("atlas:restore-quarter"),
  // PROTOTYPE, direct mode: the agent's own notes and write zone.
  agentNotes: call("atlas:agent-notes"),
  saveAgentNotes: call("atlas:save-agent-notes"),
  setAgentRole: call("atlas:set-agent-role"),
  approveMemoryDocument: call("atlas:approve-memory-document"),
  previewMemoryDocument: call("atlas:preview-memory-document"),
  agentCommits: call("atlas:agent-commits"),
  initProjectGit: call("atlas:init-project-git"),
  // The world lead and desk agents: the task board (read-only), an agent made a
  // desk agent (confirmed), and the world lead's confirmed flow - binding, then role.
  taskBoard: call("atlas:task-board"),
  registerDeskAgent: call("atlas:register-desk-agent"),
  prepareWorldLead: call("atlas:prepare-world-lead"),
  assignWorldLead: call("atlas:assign-world-lead"),

  // The Gateway from Atlas: the host runs the agents-factory CLI. The API key is
  // handed to the host once; the page only ever gets back whether one is stored.
  gatewayStatus: call("atlas:gateway-status"),
  gatewayStart: call("atlas:gateway-start"),
  gatewayStop: call("atlas:gateway-stop"),
  gatewayRecover: call("atlas:gateway-recover"),
  apiKeyStatus: call("atlas:api-key-status"),
  setApiKey: call("atlas:api-key-set"),
  removeApiKey: call("atlas:api-key-remove"),
  autostartStatus: call("atlas:autostart-status"),
  installAutostart: call("atlas:autostart-install"),
  uninstallAutostart: call("atlas:autostart-uninstall"),

  // Gateway mutations. Each confirms with the person and carries a host-minted
  // identity, so an ambiguous outcome is reconciled instead of repeated.
  createScope: call("atlas:create-scope"),
  createAgent: call("atlas:create-agent"),
  send: call("atlas:send"),
  sendReceipt: call("atlas:send-receipt"),
  respond: call("atlas:respond"),
  interrupt: call("atlas:interrupt"),
  closeAgent: call("atlas:close-agent"),
  // Kit v0.21.0: a message while the agent works, taking a queued one back,
  // the model of the next turns, and the trace of everything the turns did.
  steer: call("atlas:steer"),
  unqueue: call("atlas:unqueue"),
  setProfile: call("atlas:set-profile"),
  trace: call("atlas:trace"),
  // Kit v0.16.1: save a project file against the hash it was read with, and
  // copy a project with its memory atomically; unknown outcomes are reconciled.
  saveProjectFile: call("atlas:save-project-file"),
  reconcileFileSave: call("atlas:reconcile-file-save"),
  resendFileSave: call("atlas:resend-file-save"),
  copyProject: call("atlas:copy-project"),
  reconcileProjectCopy: call("atlas:reconcile-project-copy"),

  // Saves the window's activity log through a native save dialog.
  saveLog: call("atlas:save-log"),
  // Writes this run's read journal into a folder the host asks the person for.
  exportEvidence: call("atlas:evidence-export"),
  onFlush,

  // Map geometry: this machine's own drawing, kept in a local file.
  readUiState: call("atlas:ui-state-read"),
  writeUiState: call("atlas:ui-state-write"),
  readLayout: call("atlas:layout-read"),
  writeLayout: call("atlas:layout-write"),
  exportLayout: call("atlas:layout-export"),
  importLayout: call("atlas:layout-import"),
});

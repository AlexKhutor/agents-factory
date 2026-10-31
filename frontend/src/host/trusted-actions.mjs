// The two bounded local actions the delivery allows a frontend to perform:
// binding a project to an existing folder, and saving a memory edit the user
// confirmed. Both run the installed Gateway CLI.
//
// Rules this module exists to keep:
//   - the renderer never supplies a filesystem path and never names an
//     executable: it passes a selection token from a picker the host opened;
//   - arguments go as an array, so no user text can become shell syntax;
//   - input files are written to the controller's private directory, with the
//     directory's Windows permissions tightened to this user, and removed after;
//   - a commandId is minted only after a real human answered a native dialog;
//   - a stale revision is reported as a conflict. Nothing is overwritten, and a
//     fresh operation ID is never issued to disguise one.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { isSplitInstance } from "./layout-split.mjs";
import { tx } from "./i18n.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
// An entry of the backend's action journal (a UUID).
const JOURNAL_ENTRY_ID = /^[a-f0-9-]{36}$/;
// The world (Atlas): the reserved project of the world lead, bound to the
// controller root, and its headquarters quarter. The world lead is the
// controller's one coordinator (memory CLI role "coordinator").
export const WORLD_PROJECT = "world";
export const WORLD_HQ_QUARTER = "hq";
// How long the person's confirmation of a world lead covers the role step.
const WORLD_FLOW_MS = 15 * 60_000;
// Registering a desk agent installs the task kit into its coordination folder.
const REGISTRATION_TIMEOUT_MS = 180_000;
const TASK_STAGES = Object.freeze(["dispatched", "started", "accepted", "planned", "in-progress", "reported",
  "accepted-by-code", "declined"]);
// Claude Code's permission modes an agent may have (the memory CLI's
// AGENT_PERMISSION_MODES), and those the provider's own may be.
const AGENT_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto", "bypassPermissions"]);
const PROVIDER_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "auto", "plan", "dontAsk"]);
const MAX_ENTRIES = 64;
const MAX_TITLE = 512;
const MAX_TEXT = 65536;
const MAX_OUTPUT_BYTES = 1_048_576;
const TIMEOUT_MS = 60_000;

function invalid(reasonCode, message) {
  return { ok: false, error: { code: "invalid_input", reasonCode, message } };
}

function validateEntries(entries) {
  if (!Array.isArray(entries)) return "entries_not_an_array";
  if (entries.length > MAX_ENTRIES) return "entries_too_many";
  const seen = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") return "entry_not_an_object";
    // Every entry carries its own identity in the contract; a missing or
    // repeated one would be rejected by the store after the user confirmed.
    if (typeof entry.id !== "string" || !ID.test(entry.id)) return "entry_id_invalid";
    if (seen.has(entry.id)) return "entry_id_duplicated";
    seen.add(entry.id);
    if (typeof entry.title !== "string" || entry.title.length < 1
        || entry.title.length > MAX_TITLE) return "entry_title_invalid";
    if (typeof entry.text !== "string" || entry.text.length > MAX_TEXT) return "entry_text_invalid";
    if (Object.keys(entry).some((key) => !["id", "title", "text"].includes(key))) {
      return "entry_has_unsupported_fields";
    }
  }
  return null;
}

function runCli(executable, args, cwd, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: "timeout" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish({ status: "output_too_large" });
      }
    });
    // The CLI writes one bounded failure record - {status, code} with no paths -
    // to stderr and exits 1. Keep a little of it, never more.
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ status: "spawn_failed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ status: "exited", exitCode: code, stdout, stderr });
    });
  });
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/**
 * The CLI's own failure record, from the last JSON line it wrote (stderr, then
 * stdout). Only named fields are kept, and only in their expected shape:
 * identifiers and token-like codes, a boolean. A reason in free text - which may
 * carry a path or input - is dropped and marked as omitted. What the CLI did not
 * report stays null: never false, never 0.
 */
function failureRecord(stderr, stdout) {
  const lastJson = (text) => {
    const line = String(text ?? "").trim().split(/\r?\n/).at(-1) ?? "";
    try {
      const value = JSON.parse(line);
      return value !== null && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  };
  const record = lastJson(stderr) ?? lastJson(stdout) ?? {};
  const token = (value) => (typeof value === "string" && TOKEN.test(value) ? value : null);
  const hasReason = typeof record.reason === "string" && record.reason !== "";
  return {
    reasonCode: token(record.code),
    diagnosticId: typeof record.diagnosticId === "string" && ID.test(record.diagnosticId)
      ? record.diagnosticId : null,
    diagnosticPersisted: typeof record.diagnosticPersisted === "boolean" ? record.diagnosticPersisted : null,
    phase: token(record.phase),
    reason: token(record.reason),
    reasonOmitted: hasReason && token(record.reason) === null,
  };
}

function parseCliJson(result) {
  if (result.status !== "exited") {
    // A CLI that was running and had to be stopped (timeout, oversized output)
    // may already have written: the outcome is unknown, not a failure. One that
    // never started wrote nothing.
    const uncertain = result.status === "timeout" || result.status === "output_too_large";
    return { ok: false, error: { code: "cli_unavailable", reasonCode: result.status, uncertain } };
  }
  if (result.exitCode !== 0) {
    const record = failureRecord(result.stderr, result.stdout);
    return {
      ok: false,
      error: {
        code: "cli_failed",
        ...record,
        reasonCode: record.reasonCode ?? "application_gateway_failed",
        exitCode: result.exitCode,
      },
    };
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: { code: "cli_response_invalid", reasonCode: "not_json", exitCode: result.exitCode },
    };
  }
  return { ok: true, exitCode: result.exitCode, value };
}

/**
 * Tightens the input directory to the current user and reports what actually
 * happened. On Windows a file mode is not proof of anything - Node maps it to
 * the read-only attribute and not to owner/group/other - so the access control
 * list is set explicitly and the result is surfaced rather than assumed.
 */
async function hardenDirectory(directory) {
  if (process.platform !== "win32") return { state: "not-applicable", reasonCode: "not_windows" };
  const user = process.env.USERNAME;
  if (typeof user !== "string" || user.trim() === "") {
    return { state: "unknown", reasonCode: "user_unknown" };
  }
  const result = await runCli("icacls", [
    directory, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`,
  ], undefined);
  if (result.status !== "exited" || result.exitCode !== 0) {
    return { state: "not-hardened", reasonCode: result.status === "exited" ? "icacls_failed" : result.status };
  }
  return { state: "hardened", reasonCode: "hardened" };
}

/**
 * @param confirm  async ({title, message, detail}) => boolean - a native dialog
 *                 answered by the person at this machine. Never a page element.
 *                 It bounds what the renderer can do; it is not a defence
 *                 against automation of the desktop itself.
 * @param chooseDirectory async () => string | null
 */
export function createTrustedActions({ config, confirm, chooseDirectory, journal = null, gateway = null }) {
  const cliScript = path.join(config.controllerRoot, config.gatewayCli.scriptRelativePath);
  // The CLI only accepts an input file that resolves inside the controller root,
  // is a real file, not a symlink, and is at most 256 KB. This is that private,
  // untracked directory - never an agent's project folder.
  const inputRelativeDirectory = path.posix.join(".project-local", "atlas-input");
  const inputDirectory = path.join(config.controllerRoot, ".project-local", "atlas-input");
  const selections = new Map();

  let acl = null;

  async function availability() {
    try {
      const info = await stat(cliScript);
      if (!info.isFile()) return { available: false, reasonCode: "cli_not_a_file" };
    } catch {
      return { available: false, reasonCode: "cli_missing" };
    }
    if (acl === null) {
      await mkdir(inputDirectory, { recursive: true });
      acl = await hardenDirectory(inputDirectory);
    }
    return { available: true, reasonCode: "available", acl: acl.state, aclReasonCode: acl.reasonCode };
  }

  async function withInputFile(payload, run) {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > 240 * 1024) {
      return invalid("input_too_large", "The edit exceeds the accepted input size");
    }
    await mkdir(inputDirectory, { recursive: true });
    if (acl === null) acl = await hardenDirectory(inputDirectory);
    const name = `${randomUUID()}.json`;
    const inputPath = path.join(inputDirectory, name);
    // The mode is set for platforms where it means something; on Windows the
    // directory's access control list above is what actually bounds access.
    await writeFile(inputPath, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      return await run(path.posix.join(inputRelativeDirectory, name));
    } finally {
      await rm(inputPath, { force: true });
    }
  }

  /** Opens the native folder picker (a project folder, or a project package's). The path stays in this process. */
  async function chooseWorkspace({ purpose = "workspace" } = {}) {
    const chosen = await chooseDirectory(purpose);
    if (chosen === null) return { ok: true, data: { chosen: false } };
    let info;
    try {
      info = await stat(chosen);
    } catch {
      return invalid("workspace_unreadable", "The chosen folder cannot be read");
    }
    if (!info.isDirectory()) return invalid("workspace_not_a_directory", "Not a folder");
    const selectionId = randomUUID();
    selections.set(selectionId, chosen);
    return {
      ok: true,
      data: { chosen: true, selectionId, displayPath: chosen, folderName: path.basename(chosen) },
    };
  }

  async function bindWorkspace({ projectId, selectionId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const workspacePath = selections.get(selectionId);
    if (workspacePath === undefined) {
      return invalid("selection_unknown", "Choose the folder again");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }

    const confirmed = await confirm({
      title: tx("Bind project folder"),
      message: tx("Bind project “{projectId}” to this folder?", { projectId }),
      detail: tx("{workspacePath}\n\nThe binding is permanent: you cannot change it later. All quarters of the project work in this folder, and the project agents change files in it.", { workspacePath }),
      confirmLabel: tx("Bind"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };

    const result = await withInputFile({ projectId, workspacePath }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", "bind-workspace",
        "--input-file", inputPath,
        "--confirm-project", projectId,
        "--json",
      ],
      config.controllerRoot,
    ));
    selections.delete(selectionId);
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    // The response carries a fingerprint, not a path: keep it that way.
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /**
   * One confirmed edit. operationId and commandId are minted here and returned,
   * so an ambiguous outcome can be reconciled with the same identity instead of
   * being resent under a new one.
   */
  async function saveMemoryEdit({ scopeId, expectedRevision, entries, actorId } = {}) {
    if (typeof scopeId !== "string" || !ID.test(scopeId)) return invalid("scope_id_invalid", "scopeId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return invalid("revision_invalid", "expectedRevision");
    }
    const entriesProblem = validateEntries(entries);
    if (entriesProblem !== null) return invalid(entriesProblem, "entries");
    if (typeof actorId !== "string" || !ID.test(actorId)) return invalid("actor_invalid", "actorId");

    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }

    const confirmed = await confirm({
      title: tx("Save memory"),
      message: tx("Save the entries ({length}) to “{scopeId}”?", { length: entries.length, scopeId }),
      detail: tx("Expected revision {expectedRevision}. The new memory applies from the next message; turns already running keep the previous one.", { expectedRevision }),
      confirmLabel: tx("Save"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };

    const operationId = `atlas-memory-${randomUUID()}`;
    const commandId = `atlas-command-${randomUUID()}`;
    const payload = { scopeId, expectedRevision, entries, operationId, commandId, actorId };

    const result = await withInputFile(payload, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", "save-user-edit",
        "--input-file", inputPath,
        "--confirm-user-command", commandId,
        "--json",
      ],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    // The identity travels with the failure too: an ambiguous outcome is
    // reconciled under the same operationId, never resent under a new one.
    if (!parsed.ok) return { ...parsed, identity: { operationId, commandId } };
    return {
      ok: true,
      data: {
        exitCode: parsed.exitCode,
        identity: { operationId, commandId, scopeId, expectedRevision },
        response: parsed.value,
      },
    };
  }

  /** One project action of the memory CLI, named again by --confirm-project. */
  async function projectCli(action, projectId) {
    const result = await withInputFile({ projectId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", action,
        "--input-file", inputPath,
        "--confirm-project", projectId,
        "--json",
      ],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /**
   * Archives a project after the person confirms. Nothing of it is deleted: it
   * leaves the map and can be restored. A project with open agents is refused
   * by the backend (memory_project_has_agents).
   */
  async function archiveProject({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const confirmed = await confirm({
      title: tx("Archive project"),
      message: tx("Send project “{projectId}” to the archive?", { projectId }),
      detail: tx("The project leaves the map together with its quarters. Nothing is deleted: memory, the folder binding and closed agents are kept, and the project can be restored from the archive. A project with open agents is not archived: archive them first."),
      confirmLabel: tx("Archive"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    return projectCli("archive-project", projectId);
  }

  /** Brings an archived project back unchanged. Nothing is lost by it, so it does not ask. */
  async function restoreProject({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    return projectCli("restore-project", projectId);
  }

  /**
   * Makes an agent the lead of its project or quarter, or an ordinary agent
   * again. The role is the person's decision, made where they create the lead
   * (the headquarters or the quarter window): it does not ask a second time. The
   * backend refuses a second lead of the same project or quarter
   * (memory_role_taken) and a stale settings revision.
   */
  async function setAgentRole({ agentId, role, expectedRevision } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (!["feature", "project-lead", "quarter-lead"].includes(role)) return invalid("role_invalid", "role");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return invalid("revision_invalid", "expectedRevision");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const commandId = `atlas-role-${randomUUID()}`;
    const result = await withInputFile({ agentId, expectedRevision, role, writeZone: null, commandId },
      (inputPath) => runCli(
        config.gatewayCli.nodeExecutable,
        [
          cliScript, "memory",
          "--repo-root", config.controllerRoot,
          "--action", "set-agent-settings",
          "--input-file", inputPath,
          "--confirm-user-command", commandId,
          "--json",
        ],
        config.controllerRoot,
      ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /** One quarter action of the memory CLI, named again by --confirm-project and --confirm-quarter. */
  async function quarterCli(action, projectId, quarterId) {
    const result = await withInputFile({ projectId, quarterId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [
        cliScript, "memory",
        "--repo-root", config.controllerRoot,
        "--action", action,
        "--input-file", inputPath,
        "--confirm-project", projectId,
        "--confirm-quarter", quarterId,
        "--json",
      ],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value } };
  }

  /** Archives a quarter after the person confirms; like a project, it is restorable and nothing is deleted. */
  async function archiveQuarter({ projectId, quarterId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (typeof quarterId !== "string" || !ID.test(quarterId)) return invalid("quarter_id_invalid", "quarterId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const confirmed = await confirm({
      title: tx("Archive quarter"),
      message: tx("Send quarter “{quarterId}” of project “{projectId}” to the archive?", { quarterId, projectId }),
      detail: tx("The quarter leaves the map. Nothing is deleted: its memory and closed agents are kept, and the quarter can be restored from the archive. A quarter with open agents is not archived: archive them first."),
      confirmLabel: tx("Archive"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    return quarterCli("archive-quarter", projectId, quarterId);
  }

  /** Brings an archived quarter back unchanged, without asking. */
  async function restoreQuarter({ projectId, quarterId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (typeof quarterId !== "string" || !ID.test(quarterId)) return invalid("quarter_id_invalid", "quarterId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    return quarterCli("restore-quarter", projectId, quarterId);
  }

  /**
   * Moves a project to another folder after the person confirms both folders
   * (plan R36). Before its agents worked only the binding changes; after, their
   * sessions and conversations move along (backend project-rebind.mjs), which
   * needs no agent of the project working and the Gateway stopped: on
   * gateway_running the same rebind runs again with the Gateway paused. The
   * project's files are the person's to move.
   */
  async function rebindWorkspace({ projectId, selectionId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const workspacePath = selections.get(selectionId);
    if (workspacePath === undefined) {
      return invalid("selection_unknown", "Choose the folder again");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const current = await readProjectFolder({ projectId });
    const was = !current.ok ? tx("could not be read") : current.data.configured ? current.data.workspacePath : tx("not bound");
    const confirmed = await confirm({
      title: tx("Change project folder"),
      message: tx("Move project “{projectId}” to another folder?", { projectId }),
      detail: tx("Now: {was}\nWill be: {workspacePath}\n\n", { was, workspacePath })
        + tx("Atlas does not move the project's files: move them to the new folder yourself. If the project's agents have ")
        + tx("already worked, their conversations and sessions move with the binding; for that no agent of the project may ")
        + tx("be working, and the Gateway stops for that time and starts again."),
      confirmLabel: tx("Change folder"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const rebind = async () => {
      const result = await withInputFile({ projectId, workspacePath }, (inputPath) => runCli(
        config.gatewayCli.nodeExecutable,
        [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "rebind-workspace",
          "--input-file", inputPath, "--confirm-project", projectId, "--json"],
        config.controllerRoot,
      ));
      return result?.ok === false ? result : parseCliJson(result);
    };
    let parsed = await rebind();
    if (!parsed.ok && parsed.error?.reasonCode === "gateway_running" && typeof gateway?.whileStopped === "function") {
      parsed = await gateway.whileStopped(rebind);
    }
    selections.delete(selectionId);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { exitCode: parsed.exitCode, response: parsed.value, gateway: parsed.gateway ?? null } };
  }

  /**
   * Checks a send whose outcome is uncertain, after the person confirms
   * (backend project-send-settle.mjs). Until it is checked the agent is busy,
   * the project's folder taken and the provider lease held. The agent's
   * session journal decides: no turn for the message - it never went, the
   * agent is free; a turn - it went and keeps that turn. The Gateway is
   * paused for the check and started again.
   */
  async function settleSend({ agentId, operationId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (typeof operationId !== "string" || !ID.test(operationId)) return invalid("operation_id_invalid", "operationId");
    if (typeof gateway?.whileStopped !== "function") {
      return { ok: false, error: { code: "unavailable", reasonCode: "gateway_control_unavailable" } };
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const confirmed = await confirm({
      title: tx("Check the send"),
      message: tx("Check whether the last message reached agent \"{agentId}\"?", { agentId }),
      detail: tx("The Gateway does not know how this send ended. Until it is checked, the agent is busy and the other agents ")
        + tx("of its project cannot work in the shared folder.\n\n")
        + tx("Atlas will look at the agent's session journal. If there is no turn for this message, it was not sent: ")
        + tx("the send becomes \"failure\", the agent is free, and the message can be sent again. If there is a turn, the message ")
        + tx("arrived, and the send gets that turn's outcome.\n\n")
        + tx("The Gateway stops for the check and starts again."),
      confirmLabel: tx("trusted-actions::Check"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const result = await gateway.whileStopped(async () => {
      const run = await withInputFile({ agentId, operationId }, (inputPath) => runCli(
        config.gatewayCli.nodeExecutable,
        [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "settle-send",
          "--input-file", inputPath, "--confirm-agent", agentId, "--json"],
        config.controllerRoot,
      ));
      return run?.ok === false ? run : parseCliJson(run);
    });
    if (!result.ok) return result;
    const value = result.value ?? {};
    const token = (item) => (typeof item === "string" && ID.test(item) ? item : null);
    return { ok: true, data: { agentId, operationId, went: value.found !== null && value.found !== undefined,
      operationState: token(value.operationState), leaseOutcome: token(value.leaseOutcome),
      causeCode: token(value.causeCode), gateway: result.gateway ?? null } };
  }

  /**
   * The folder a project works in, for the person's own window: whether the
   * project is bound, the folder and whether it still exists. Read-only, no
   * confirmation. The path goes only to this window, never to the journal.
   */
  async function readProjectFolder({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) {
      return invalid("project_id_invalid", "projectId");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile({ projectId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-workspace",
        "--input-file", inputPath, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const value = parsed.value ?? {};
    return {
      ok: true,
      data: value.configured === true && typeof value.workspacePath === "string"
        ? { projectId, configured: true, workspacePath: value.workspacePath.slice(0, 1024), available: value.available === true }
        : { projectId, configured: false },
    };
  }

  /**
   * How an agent's tool calls are approved, as Claude Code's permission modes;
   * null goes back to the provider's mode. The person's decision, like the
   * role: "bypass" (nothing is asked) is confirmed first, the others are not -
   * choosing them in the window is the decision. Applies from the next turn.
   */
  async function setAgentPermissionMode({ agentId, permissionMode } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (permissionMode !== null && !AGENT_PERMISSION_MODES.includes(permissionMode)) {
      return invalid("permission_mode_invalid", "permissionMode");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    if (permissionMode === "bypassPermissions") {
      const confirmed = await confirm({
        title: tx("“Bypass permissions” mode"),
        message: tx("Let agent “{agentId}” work without permission prompts?", { agentId }),
        detail: tx("It runs any commands and edits files in the project folder on its own, without asking. ")
          + tx("Edits outside its write zone are still refused. The mode applies from the next turn; ")
          + tx("you can switch back at any time."),
        confirmLabel: tx("Bypass permissions"),
      });
      if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    }
    const result = await withInputFile({ agentId, permissionMode }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "set-permission-mode",
        "--input-file", inputPath, "--confirm-agent", agentId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const mode = parsed.value?.permissionMode;
    return { ok: true, data: { agentId, permissionMode: AGENT_PERMISSION_MODES.includes(mode) ? mode : null,
      changed: parsed.value?.changed === true } };
  }

  /** A memory document's target, as the memory CLI names it: "agent", "project" or "quarter". */
  const documentTarget = (target) => {
    const kind = typeof target === "string" ? target : target?.kind;
    return ["agent", "project", "quarter"].includes(kind) ? kind : null;
  };
  // A path from the root of the project folder, forward slashes, nothing above it.
  const documentPathOk = (value) => typeof value === "string" && value.length >= 1 && value.length <= 512
    && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

  /**
   * What approving a memory document would write: the document's hash and size,
   * the memory it goes to (with its revision) and the entries its "## …"
   * headings make. Read-only, no confirmation.
   */
  async function previewMemoryDocument({ agentId, path: documentPath, target } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (!documentPathOk(documentPath)) return invalid("document_path_invalid", "path");
    const kind = documentTarget(target);
    if (kind === null) return invalid("document_target_invalid", "target");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile({ agentId, path: documentPath, target: kind }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "preview-memory-document",
        "--input-file", inputPath, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const value = parsed.value ?? {};
    if (typeof value.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentSha256)) {
      return { ok: false, error: { code: "cli_response_invalid", reasonCode: "preview_invalid" } };
    }
    return {
      ok: true,
      data: {
        agentId, path: typeof value.path === "string" ? value.path.slice(0, 512) : documentPath,
        contentSha256: value.contentSha256, bytes: Number.isSafeInteger(value.bytes) ? value.bytes : null,
        target: { kind, scopeId: typeof value.target?.scopeId === "string" ? value.target.scopeId : null,
          revision: Number.isSafeInteger(value.target?.revision) ? value.target.revision : null },
        entries: (Array.isArray(value.entries) ? value.entries : []).slice(0, MAX_ENTRIES).map((entry) => ({
          id: typeof entry?.id === "string" ? entry.id.slice(0, 160) : "",
          title: typeof entry?.title === "string" ? entry.title.slice(0, MAX_TITLE) : "",
          characters: Number.isSafeInteger(entry?.characters) ? entry.characters : null,
        })),
        excerpt: typeof value.excerpt === "string" ? value.excerpt.slice(0, 1200) : "",
      },
    };
  }

  /**
   * The person approves one exact memory document for one memory, after
   * seeing what it writes: the host reads it again, shows its entries and the
   * memory in the confirmation, and approves exactly that SHA-256. `apply`
   * writes it at once; otherwise the agent writes it with its desk tool.
   */
  async function approveMemoryDocument({ agentId, path: documentPath, target, apply = false } = {}) {
    if (typeof apply !== "boolean") return invalid("apply_invalid", "apply");
    const preview = await previewMemoryDocument({ agentId, path: documentPath, target });
    if (!preview.ok) return preview;
    const { data } = preview;
    const words = { agent: tx("the memory of agent {agentId} itself", { agentId }), project: tx("project memory"), quarter: tx("quarter memory") };
    const lines = data.entries.slice(0, 12).map((entry) => tx("· {value}", { value: entry.title || tx("(no title)") })
      + (entry.characters === null ? "" : tx(" — {characters} chars.", { characters: entry.characters })));
    if (data.entries.length > 12) lines.push(tx("… and {value} more", { value: data.entries.length - 12 }));
    const confirmed = await confirm({
      title: tx("Approve memory document"),
      message: tx("Write “{path}” into {value}?", { path: data.path, value: words[data.target.kind] }),
      detail: [tx("Entries: {length} (they replace the current entries of this memory, revision {value}).", { length: data.entries.length, value: data.target.revision ?? "?" }),
        ...lines, "",
        apply ? tx("It is written at once.") : tx("The agent will write exactly this text itself, with its own tool."),
        tx("Document SHA-256: {value}…", { value: data.contentSha256.slice(0, 16) })].join("\n"),
      confirmLabel: apply ? tx("Approve and write") : tx("Approve"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const commandId = `atlas-document-${randomUUID()}`;
    const result = await withInputFile({ commandId, agentId, path: data.path, target: data.target.kind,
      expectedSha256: data.contentSha256, apply }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "approve-memory-document",
        "--input-file", inputPath, "--confirm-user-command", commandId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const write = parsed.value?.write ?? null;
    return { ok: true, data: { commandId, path: data.path, target: data.target, entries: data.entries.length,
      applied: write !== null, revision: Number.isSafeInteger(write?.revision) ? write.revision : null } };
  }

  /**
   * The agent's commits in its project folder (the Gateway commits each turn's
   * work, agent-turn-commits.mjs), newest first; `versioned: false` when the
   * folder is not under git. Read-only.
   */
  async function readAgentCommits({ agentId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile({ agentId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-agent-commits",
        "--input-file", inputPath, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const commits = Array.isArray(parsed.value?.commits) ? parsed.value.commits : [];
    return {
      ok: true,
      data: {
        agentId, versioned: parsed.value?.versioned === true,
        commits: commits.filter((item) => typeof item?.sha === "string" && /^[a-f0-9]{40,64}$/u.test(item.sha))
          .slice(0, 100).map((item) => ({ sha: item.sha, atUtc: typeof item.atUtc === "string" ? item.atUtc : null,
            subject: typeof item.subject === "string" ? item.subject.slice(0, 200) : "",
            files: Number.isSafeInteger(item.files) ? item.files : null })),
      },
    };
  }

  /**
   * The project folder becomes a git repository, after the person agreed:
   * `git init`, nothing committed. From then on each turn's work is a commit.
   */
  async function initProjectGit({ projectId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const folder = await readProjectFolder({ projectId });
    const where = folder.ok && folder.data.configured ? folder.data.workspacePath : tx("project folder");
    const confirmed = await confirm({
      title: tx("Git for the project folder"),
      message: tx("Make the folder of project “{projectId}” a git repository?", { projectId }),
      detail: tx("{where}\n\nOnly git init runs: nothing is committed and nothing is sent anywhere. ", { where })
        + tx("From then on, the work of each agent turn lands as a separate commit on behalf of the agent — only the files of that turn."),
      confirmLabel: tx("Create repository"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const result = await withInputFile({ projectId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "init-project-git",
        "--input-file", inputPath, "--confirm-project", projectId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { projectId, initialised: parsed.value?.initialised === true } };
  }

  /** Every agent's own permission mode (null: the provider's) and the provider's. Read-only. */
  async function readPermissionModes() {
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-permission-modes", "--json"],
      config.controllerRoot,
    );
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const agents = Array.isArray(parsed.value?.agents) ? parsed.value.agents : [];
    const defaultMode = parsed.value?.defaultMode;
    return {
      ok: true,
      data: {
        defaultMode: PROVIDER_PERMISSION_MODES.includes(defaultMode) ? defaultMode : null,
        agents: agents.filter((item) => typeof item?.agentId === "string" && ID.test(item.agentId)).slice(0, 512)
          .map((item) => ({ agentId: item.agentId,
            permissionMode: AGENT_PERMISSION_MODES.includes(item.permissionMode) ? item.permissionMode : null })),
      },
    };
  }

  /**
   * One entry of the action journal as the window may see it: who, what, when,
   * whether it can be undone - not how (the recipe stays with the backend).
   */
  function journalEntry(item) {
    const text = (value, length) => (typeof value === "string" ? value.slice(0, length) : null);
    const optionalId = (value) => (typeof value === "string" && ID.test(value) ? value : null);
    if (typeof item?.entryId !== "string" || !JOURNAL_ENTRY_ID.test(item.entryId)
        || typeof item.projectId !== "string" || !ID.test(item.projectId)) return null;
    return {
      entryId: item.entryId,
      atUtc: text(item.atUtc, 40),
      actor: { kind: item.actor?.kind === "agent" ? "agent" : "person", id: optionalId(item.actor?.id) },
      action: text(item.action, 64),
      projectId: item.projectId,
      quarterId: optionalId(item.quarterId),
      agentId: optionalId(item.agentId),
      summary: text(item.summary, 300) ?? "",
      undoable: item.undo !== null && typeof item.undo === "object" && item.undoneBy === null,
      noUndo: text(item.noUndo, 64),
      undoes: typeof item.undoes === "string" && JOURNAL_ENTRY_ID.test(item.undoes) ? item.undoes : null,
      undoneBy: typeof item.undoneBy === "string" && JOURNAL_ENTRY_ID.test(item.undoneBy) ? item.undoneBy : null,
      undoneAtUtc: text(item.undoneAtUtc, 40),
    };
  }

  /** The action journal (the backend's action-journal.mjs), of one project or all, newest first. Read-only. */
  async function readActionJournal({ projectId = null, limit = 200 } = {}) {
    if (projectId !== null && (typeof projectId !== "string" || !ID.test(projectId))) {
      return invalid("project_id_invalid", "projectId");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return invalid("limit_invalid", "limit");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile(projectId === null ? { limit } : { projectId, limit }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-journal",
        "--input-file", inputPath, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const entries = Array.isArray(parsed.value?.entries) ? parsed.value.entries : [];
    return { ok: true, data: { entries: entries.slice(0, 1000).map(journalEntry).filter((entry) => entry !== null) } };
  }

  /**
   * Undoes one journal entry after the person confirms it. The dialog shows
   * the entry as the backend has it (read again here), not a text from the
   * window; the backend refuses when a later change stands in the way.
   */
  async function undoAction({ projectId, entryId } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (typeof entryId !== "string" || !JOURNAL_ENTRY_ID.test(entryId)) return invalid("entry_id_invalid", "entryId");
    const journal = await readActionJournal({ projectId, limit: 1000 });
    if (!journal.ok) return journal;
    const entry = journal.data.entries.find((item) => item.entryId === entryId);
    if (!entry) return { ok: false, error: { code: "conflict", reasonCode: "journal_entry_not_found" } };
    if (!entry.undoable) return { ok: false, error: { code: "conflict", reasonCode: "journal_not_undoable" } };
    const confirmed = await confirm({
      title: tx("Undo change"),
      message: tx("Undo “{summary}”?", { summary: entry.summary }),
      detail: tx("The change is reversed by a new entry of the history; nothing of the history is deleted. If something changed after it, nothing is undone and you are told what stands in the way."),
      confirmLabel: tx("Undo"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const result = await withInputFile({ projectId, entryId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "undo-action",
        "--input-file", inputPath, "--confirm-entry", entryId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { undo: journalEntry(parsed.value?.undo) } };
  }

  /**
   * The names the person gave projects, quarters and agents (the backend's
   * object-names.mjs), by project: { [projectId]: { project, quarters, agents } }.
   * An object without a name is named by its ID. Read-only.
   */
  async function readNames() {
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-names", "--json"],
      config.controllerRoot,
    );
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const text = (value) => (typeof value === "string" && value.length <= 120 ? value : null);
    const map = (value) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
      .filter(([key, name]) => ID.test(key) && text(name) !== null).slice(0, 2000));
    const projects = {};
    for (const [projectId, names] of Object.entries(parsed.value?.projects ?? {}).slice(0, 1000)) {
      if (!ID.test(projectId)) continue;
      projects[projectId] = { project: text(names?.project), quarters: map(names?.quarters), agents: map(names?.agents) };
    }
    return { ok: true, data: { projects } };
  }

  /**
   * Renames a project, quarter or agent (null: back to its ID). Nothing is lost
   * by it - the ID stays, and the backend journals it with an undo - so it does
   * not ask.
   */
  async function renameObject({ projectId, kind, objectId, name } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (!["project", "quarter", "agent"].includes(kind)) return invalid("kind_invalid", "kind");
    if (typeof objectId !== "string" || !ID.test(objectId)) return invalid("object_id_invalid", "objectId");
    if (name !== null && (typeof name !== "string" || name.trim() === "" || name.length > 120)) {
      return invalid("name_invalid", "name");
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await withInputFile({ projectId, kind, objectId, name }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "rename",
        "--input-file", inputPath, "--confirm-project", projectId, "--json"],
      config.controllerRoot,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { response: parsed.value } };
  }

  /** The archived projects and quarters, newest first. Read-only. */
  async function listArchivedProjects() {
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const result = await runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "list-archived-projects", "--json"],
      config.controllerRoot,
    );
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const projects = Array.isArray(parsed.value?.projects) ? parsed.value.projects : [];
    const quarters = Array.isArray(parsed.value?.quarters) ? parsed.value.quarters : [];
    const title = (value) => (typeof value === "string" ? value.slice(0, 512) : null);
    const at = (value) => (typeof value === "string" ? value : null);
    return {
      ok: true,
      data: {
        projects: projects.filter((item) => typeof item?.projectId === "string" && ID.test(item.projectId))
          .slice(0, 200)
          .map((item) => ({
            projectId: item.projectId,
            title: title(item.title),
            quarterCount: Number.isSafeInteger(item.quarterCount) ? item.quarterCount : null,
            archivedAtUtc: at(item.archivedAtUtc),
          })),
        quarters: quarters.filter((item) => typeof item?.projectId === "string" && ID.test(item.projectId)
          && typeof item?.quarterId === "string" && ID.test(item.quarterId))
          .slice(0, 400)
          .map((item) => ({
            projectId: item.projectId, quarterId: item.quarterId,
            title: title(item.title), archivedAtUtc: at(item.archivedAtUtc),
          })),
      },
    };
  }

  // --- projects not on this PC -------------------------------------------------
  //
  // A split instance (one store per project) can take a project off this PC into
  // a package folder and bring it back (backend project-mount.mjs, agents-factory
  // CLI `project unmount | mount`). The Gateway must be stopped for both: they
  // run through the Gateway control's whileStopped. Paths stay in this process
  // and in the confirmation; the journal names the project only.

  const gatewayPause = () => (typeof gateway?.whileStopped === "function" && typeof gateway?.projectCommand === "function"
    ? null : { ok: false, error: { code: "unavailable", reasonCode: "gateway_control_unavailable" } });
  const splitOnly = async () => (await isSplitInstance(config.controllerRoot)
    ? null : { ok: false, error: { code: "unavailable", reasonCode: "store_layout_single" } });
  const projectAnswer = (result, fields) => {
    if (!result.ok) return result;
    const value = result.value ?? {};
    const field = (item) => (typeof item === "string" && ID.test(item) ? item : Number.isSafeInteger(item) ? item : null);
    return {
      ok: true,
      data: { ...Object.fromEntries(fields.map((name) => [name, field(value[name])])), gateway: result.gateway ?? null },
    };
  };

  // Where a project may be kept (backend machine-identity.mjs): the person picks
  // one of three; the world records it, the package carries it (enforced from block 3).
  const MACHINE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  const POLICY_CHOICES = Object.freeze(["anywhere", "home", "this-pc"]);
  const utcOf = (value) => (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null);
  const countOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const machineTitle = (value, fallback) => (typeof value === "string" && value.trim() !== "" ? value.slice(0, 80) : fallback);
  const policyOf = (value) => ({
    homeOnly: value?.homeOnly === true,
    allowedMachines: Array.isArray(value?.allowedMachines)
      ? value.allowedMachines.filter((id) => typeof id === "string" && MACHINE.test(id)).slice(0, 16) : null,
  });
  const samePolicy = (a, b) => a.homeOnly === b.homeOnly
    && JSON.stringify([...(a.allowedMachines ?? [])].sort()) === JSON.stringify([...(b.allowedMachines ?? [])].sort())
    && (a.allowedMachines === null) === (b.allowedMachines === null);
  // A change that lets the project onto PCs it was kept off.
  const relaxes = (before, after) => (before.homeOnly && !after.homeOnly)
    || (before.allowedMachines !== null && (after.allowedMachines === null
      || after.allowedMachines.some((id) => !before.allowedMachines.includes(id))));
  const policyFor = (choice, thisMachine) => {
    if (choice === "anywhere") return { homeOnly: false, allowedMachines: null };
    if (choice === "home") return { homeOnly: true, allowedMachines: null };
    return thisMachine === null ? null : { homeOnly: false, allowedMachines: [thisMachine.machineId] };
  };
  const describePolicy = (policy, machines) => {
    if (policy.homeOnly) return tx("home only");
    if (policy.allowedMachines !== null) {
      return tx("only on PC: {value}", { value: policy.allowedMachines.map((id) => machines[id]?.title ?? id).join(", ") });
    }
    return tx("on any PC");
  };

  /**
   * Every project the world knows (identity, where it may be kept, where it is,
   * a summary without text, here or not), this PC and the PCs the world knows.
   * Read-only; a single-database instance has no world registry.
   */
  async function readWorldView() {
    if (!await isSplitInstance(config.controllerRoot)) {
      return { ok: true, data: { split: false, thisMachine: null, machines: {}, projects: [] } };
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const parsed = parseCliJson(await runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-world-registry", "--json"],
      config.controllerRoot,
    ));
    if (!parsed.ok) return parsed;
    const value = parsed.value ?? {};
    const machines = {};
    for (const [machineId, item] of Object.entries(value.machines ?? {}).slice(0, 32)) {
      if (MACHINE.test(machineId)) machines[machineId] = { title: machineTitle(item?.title, machineId), home: item?.home === true };
    }
    const here = value.thisMachine;
    const thisMachine = typeof here?.machineId === "string" && MACHINE.test(here.machineId)
      ? { machineId: here.machineId, title: machineTitle(here.title, here.machineId), home: here.home === true } : null;
    const projects = Object.entries(value.projects ?? {}).filter(([projectId]) => ID.test(projectId)).slice(0, 400)
      .map(([projectId, item]) => {
        const location = item?.location;
        const at = location?.machineId === null || (typeof location?.machineId === "string" && MACHINE.test(location.machineId));
        return {
          projectId,
          title: typeof item?.title === "string" ? item.title.slice(0, MAX_TITLE) : null,
          archived: item?.archived === true,
          here: item?.here === true,
          policy: policyOf(item?.policy),
          location: at ? { machineId: location.machineId,
            title: location.machineId === null ? null : machines[location.machineId]?.title ?? location.machineId,
            atUtc: utcOf(location.atUtc) } : null,
          summary: item?.summary ? { agents: countOf(item.summary.agents), quarters: countOf(item.summary.quarters),
            tasksOpen: countOf(item.summary.tasksOpen), lastActivityUtc: utcOf(item.summary.lastActivityUtc) } : null,
        };
      });
    return { ok: true, data: { split: true, thisMachine, machines, projects } };
  }

  /** The world as above; `projects` are the ones not on this PC, `known` all of them. */
  async function listAwayProjects() {
    const view = await readWorldView();
    if (!view.ok) return view;
    return { ok: true, data: { ...view.data, projects: view.data.projects.filter((item) => !item.here), known: view.data.projects } };
  }

  /** Writes where a project may be kept (memory CLI set-project-policy, the project named twice). */
  async function writePolicy(projectId, policy) {
    const result = await withInputFile({ projectId, policy }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "set-project-policy",
        "--input-file", inputPath, "--confirm-project", projectId, "--json"],
      config.controllerRoot,
    ));
    return result?.ok === false ? result : parseCliJson(result);
  }

  /** The person's choice for a project and the policy it means, or a refusal. */
  async function policyChange(projectId, choice) {
    if (!POLICY_CHOICES.includes(choice)) return invalid("policy_choice_invalid", "choice");
    const view = await readWorldView();
    if (!view.ok) return view;
    if (!view.data.split) return { ok: false, error: { code: "unavailable", reasonCode: "store_layout_single" } };
    const policy = policyFor(choice, view.data.thisMachine);
    if (policy === null) return invalid("machine_not_named", "Name this PC first: agents-factory machine set --id <id>");
    const before = view.data.projects.find((item) => item.projectId === projectId)?.policy
      ?? { homeOnly: false, allowedMachines: null };
    return { ok: true, policy, before, machines: view.data.machines, thisMachine: view.data.thisMachine };
  }

  /**
   * Where a project may be kept: anywhere, only at home, or only on this PC. A
   * change that lets it onto more PCs is confirmed first; a stricter one is the
   * button the person pressed.
   */
  async function setProjectPolicy({ projectId, choice } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId) || projectId === WORLD_PROJECT) {
      return invalid("project_id_invalid", "projectId");
    }
    const change = await policyChange(projectId, choice);
    if (!change.ok) return change;
    if (samePolicy(change.before, change.policy)) return { ok: true, data: { projectId, policy: change.policy, changed: false } };
    if (relaxes(change.before, change.policy)) {
      const confirmed = await confirm({
        title: tx("Where to keep the project"),
        message: tx("Allow keeping project \"{projectId}\" {value}?", { projectId, value: describePolicy(change.policy, change.machines) }),
        detail: tx("Now: {value}.\n\nAfter this the project's memory, conversations and tasks ", { value: describePolicy(change.before, change.machines) })
          + tx("may also end up on other PCs (when connected and synced)."),
        confirmLabel: tx("Allow"),
      });
      if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    }
    const written = await writePolicy(projectId, change.policy);
    if (!written.ok) return written;
    return { ok: true, data: { projectId, policy: change.policy, changed: true } };
  }

  /**
   * Takes a project off this PC after the person confirms the project, the
   * package folder and where the package may be kept (`choice`, or as recorded):
   * the package is written and checked first, then the project's memory,
   * conversations and desk tasks leave the instance. The project's own folder
   * with its files is not touched.
   */
  async function unmountProject({ projectId, selectionId, choice = null } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId) || projectId === WORLD_PROJECT) {
      return invalid("project_id_invalid", "projectId");
    }
    const out = selections.get(selectionId);
    if (out === undefined) return invalid("selection_unknown", "Choose the folder again");
    const refused = gatewayPause() ?? await splitOnly();
    if (refused !== null) return refused;
    let change = null;
    if (choice !== null) {
      change = await policyChange(projectId, choice);
      if (!change.ok) return change;
    }
    const keep = change === null ? null : samePolicy(change.before, change.policy) ? null : change;
    const confirmed = await confirm({
      title: tx("Disconnect the project from this PC"),
      message: tx("Disconnect project \"{projectId}\" from this PC?", { projectId }),
      detail: tx("The project package will be written and checked in the folder:\n{out}\n\n", { out })
        + tx("Then the project's memory, conversations and tasks leave this PC. The project becomes a grey frame on the map and is ")
        + tx("listed under \"Not on this PC\"; it can be brought back from there by choosing the same package folder. The project folder with its ")
        + tx("files is not touched.\n\n")
        + (keep === null ? "" : tx("Where it may be kept: {value}", { value: describePolicy(keep.policy, keep.machines) })
          + tx("{value}.\n\n", { value: relaxes(keep.before, keep.policy) ? tx(" (was: {value})", { value: describePolicy(keep.before, keep.machines) }) : "" }))
        + tx("No agent of the project may be working. The Gateway stops for that time and starts again."),
      confirmLabel: tx("Disconnect"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    if (keep !== null) {
      const written = await writePolicy(projectId, keep.policy);
      if (!written.ok) return written;
    }
    const args = ["project", "unmount", "--project", projectId, "--out", out, "--confirm", projectId];
    const result = await gateway.whileStopped(() => gateway.projectCommand(args));
    selections.delete(selectionId);
    return projectAnswer(result, ["projectId", "revision", "removedFiles", "tasksIndexed"]);
  }

  /** The project a package folder holds, from its manifest; null if there is none to read. */
  async function packageIdentity(folder) {
    try {
      const text = await readFile(path.join(folder, "project.af.json"), "utf8");
      if (text.length > 256 * 1024) return null;
      const manifest = JSON.parse(text);
      if (typeof manifest?.projectId !== "string" || !ID.test(manifest.projectId)) return null;
      return {
        projectId: manifest.projectId,
        title: typeof manifest.title === "string" ? manifest.title.slice(0, MAX_TITLE) : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Brings a project back onto this PC from its package folder, after the
   * person confirms the project the package names. With `projectId` the
   * package must be that project's.
   */
  async function mountProject({ selectionId, projectId = null } = {}) {
    if (projectId !== null && (typeof projectId !== "string" || !ID.test(projectId))) {
      return invalid("project_id_invalid", "projectId");
    }
    const packageDir = selections.get(selectionId);
    if (packageDir === undefined) return invalid("selection_unknown", "Choose the folder again");
    const refused = gatewayPause() ?? await splitOnly();
    if (refused !== null) return refused;
    const identity = await packageIdentity(packageDir);
    if (identity === null) return invalid("package_unreadable", "No project package in this folder");
    if (projectId !== null && identity.projectId !== projectId) {
      return { ok: false, error: { code: "invalid_input", reasonCode: "package_other_project" } };
    }
    const confirmed = await confirm({
      title: tx("Connect the project to this PC"),
      message: tx("Connect project \"{projectId}\"{value} from the package?", { projectId: identity.projectId, value: identity.title ? ` (${identity.title})` : "" }),
      detail: tx("{packageDir}\n\nThe project's memory, conversations and tasks from the package appear on this PC, the project returns ", { packageDir })
        + tx("to the map. The package itself does not change. The Gateway stops for that time and starts again."),
      confirmLabel: tx("Connect"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const result = await gateway.whileStopped(() => gateway.projectCommand(["project", "mount", "--package", packageDir]));
    selections.delete(selectionId);
    const answer = projectAnswer(result, ["projectId", "scopes", "conversations"]);
    // Whether the project's folder is on this PC: "missing" means it is to be rebound (R36).
    if (answer.ok) {
      const workspace = result.value?.workspace;
      answer.data.workspace = ["bound", "missing", "none"].includes(workspace) ? workspace : null;
    }
    return answer;
  }

  // --- the world and projects between PCs (block 3) -----------------------------
  //
  // backend sync-engine.mjs, CLI `agents-factory sync`. Status only reads (with
  // `remote`, each lock in its primary remote). A take or a release runs after
  // the person confirmed what goes where, with the Gateway stopped: a release
  // leaves it stopped (this PC no longer holds the world, it would refuse to
  // start), a take of the world starts it.

  const syncId = (value) => (typeof value === "string" && ID.test(value) ? value : null);
  const syncTitle = (value) => (typeof value === "string" && value.trim() !== "" ? value.slice(0, MAX_TITLE) : null);
  const syncRemote = (value) => (value === null || typeof value !== "object" ? null : {
    reachable: value.reachable === true, initialized: value.initialized === true,
    holder: syncId(value.holder), code: typeof value.code === "string" && TOKEN.test(value.code) ? value.code : null,
  });

  /** The CLI's sync status in the shape the window reads; anything else dropped. */
  function syncView(value) {
    // Local or synced (plan 5.1); an older CLI says neither: synced when sync is configured.
    const mode = value?.mode === "local" || value?.mode === "synced" ? value.mode
      : value?.configured === true ? "synced" : "local";
    if (value?.configured !== true || mode === "local") return { configured: value?.configured === true, mode };
    const machine = value.machine && syncId(value.machine.machineId)
      ? { machineId: value.machine.machineId, title: syncTitle(value.machine.title), home: value.machine.home === true } : null;
    const machines = {};
    for (const [machineId, item] of Object.entries(value.machines ?? {})) {
      if (syncId(machineId) !== null) machines[machineId] = { title: syncTitle(item?.title), home: item?.home === true };
    }
    const projects = (Array.isArray(value.projects) ? value.projects : []).filter((item) => syncId(item?.projectId) !== null)
      .map((item) => ({ projectId: item.projectId, configured: item.configured === true, mounted: item.mounted === true,
        held: item.held === true, homeOnly: item.policy?.homeOnly === true, mayHold: item.mayHold !== false,
        onlyHere: item.onlyHere === true, remote: syncRemote(item.remote) }));
    return { configured: true, mode, machine, machines,
      world: { held: value.world?.held === true, remote: syncRemote(value.world?.remote) }, projects };
  }

  const syncReady = () => (typeof gateway?.syncCommand === "function" && typeof gateway?.whileStopped === "function"
    ? null : { ok: false, error: { code: "unavailable", reasonCode: "gateway_control_unavailable" } });

  async function syncStatus({ remote = false } = {}) {
    const refused = syncReady();
    if (refused !== null) return refused;
    const result = await gateway.syncCommand(["sync", "status", ...(remote === true ? ["--remote"] : [])]);
    if (!result.ok) return result;
    return { ok: true, data: syncView(result.value) };
  }

  const pcName = (view, machineId) => (machineId === null ? tx("nobody")
    : tx("\"{name}\"", { name: view.machines[machineId]?.title ?? machineId }));
  const listOr = (items, none) => (items.length === 0 ? none : items.join(", "));

  /** What a take or a release will do, in words, for the confirmation. */
  function syncConfirmation(kind, target, view) {
    const here = pcName(view, view.machine.machineId);
    const projects = target === "all" ? view.projects
      : target === "world" ? [] : view.projects.filter((item) => item.projectId === target);
    const world = target === "all" || target === "world";
    if (kind === "release") {
      const leave = projects.filter((item) => item.configured && item.mounted && !item.onlyHere).map((item) => item.projectId);
      const backup = projects.filter((item) => item.configured && item.mounted && item.onlyHere).map((item) => item.projectId);
      const local = projects.filter((item) => !item.configured && item.mounted).map((item) => item.projectId);
      return {
        title: tx("Hand over the work from this PC"),
        message: tx("Hand over {value} from PC {here}?", { value: world ? tx("the world and projects") : tx("project \"{target}\"", { target }), here }),
        detail: [tx("Go to their repositories and become free for another PC: {value}.", { value: listOr(leave, tx("none")) }),
          tx("Stay here, a backup goes to their repository: {value}.", { value: listOr(backup, tx("none")) }),
          ...(local.length > 0 ? [tx("Not synced, stay on this PC only: {value}.", { value: local.join(", ") })] : []),
          ...(world ? [tx("Then the world. The Gateway stops and does not start here until this PC takes the world again.")]
            : [tx("The Gateway stops for that time and starts again.")]),
        ].join("\n\n"),
        confirmLabel: tx("Hand over"),
      };
    }
    const free = projects.filter((item) => item.configured && item.mayHold && !item.mounted
      && (item.remote === null || item.remote.holder === null || item.remote.holder === view.machine.machineId)).map((item) => item.projectId);
    const denied = projects.filter((item) => item.configured && !item.mayHold).map((item) => item.projectId);
    return {
      title: tx("Take the work to this PC"),
      message: tx("Take {value} to PC {here}?", { value: world ? tx("the world and free projects") : tx("project \"{target}\"", { target }), here }),
      detail: [...(world ? [tx("The world is now held by: {value}.", { value: pcName(view, view.world.remote?.holder ?? null) })] : []),
        tx("To be taken: {value}.", { value: listOr(free, tx("none")) }),
        ...(denied.length > 0 ? [tx("Not for this PC, not downloaded: {value}.", { value: denied.join(", ") })] : []),
        world ? tx("Then the Gateway starts here.") : tx("The Gateway stops for that time and starts again."),
      ].join("\n\n"),
      confirmLabel: tx("Take"),
    };
  }

  async function syncChange(kind, { target = "all" } = {}) {
    const refused = syncReady();
    if (refused !== null) return refused;
    if (target !== "all" && target !== "world" && syncId(target) === null) return invalid("sync_target_invalid", "target");
    const current = await syncStatus({ remote: true });
    if (!current.ok) return current;
    const view = current.data;
    if (!view.configured) return { ok: false, error: { code: "unavailable", reasonCode: "sync_not_configured" } };
    if (view.machine === null) return { ok: false, error: { code: "unavailable", reasonCode: "sync_machine_unnamed" } };
    if (!await confirm(syncConfirmation(kind, target, view))) {
      return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    }
    const args = ["sync", kind, ...(target === "world" ? ["--world"] : target === "all" ? [] : ["--project", target]),
      "--confirm", view.machine.machineId];
    const result = await gateway.whileStopped(() => gateway.syncCommand(args));
    if (!result.ok) return result;
    // The world was not held here before a take, so the pause did not stop a Gateway: start it now.
    let started = null;
    if (kind === "take" && (target === "all" || target === "world") && result.gateway?.paused !== true) {
      started = (await gateway.start?.())?.ok === true;
    }
    const value = result.value ?? {};
    const steps = (Array.isArray(value.results) ? value.results : [value]).filter((item) => syncId(item?.target) !== null)
      .map((item) => ({ target: item.target, action: typeof item.action === "string" && TOKEN.test(item.action) ? item.action : null }));
    return { ok: true, data: { kind, target, steps,
      skipped: (Array.isArray(value.skipped) ? value.skipped : []).filter((item) => syncId(item?.projectId) !== null)
        .map((item) => ({ projectId: item.projectId, reason: typeof item.reason === "string" && TOKEN.test(item.reason) ? item.reason : null })),
      stayLocal: (Array.isArray(value.stayLocal) ? value.stayLocal : []).filter((item) => syncId(item) !== null),
      gateway: { ...(result.gateway ?? {}), started } } };
  }

  const syncTake = (input) => syncChange("take", input);
  const syncRelease = (input) => syncChange("release", input);

  // --- the world lead and desk agents ------------------------------------------
  //
  // A desk agent takes controller tasks once it is registered as a controller
  // source (memory CLI register-desk-source). The world lead is the one
  // coordinator of the controller, in the reserved project WORLD_PROJECT bound
  // to the controller root. The task board is read-only.

  const boardText = (value, limit) => (typeof value === "string" && value.trim() !== "" ? value.slice(0, limit) : null);
  const boardToken = (value) => (typeof value === "string" && TOKEN.test(value) ? value : null);
  const boardTime = (value) => (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value : null);
  const boardId = (value) => (typeof value === "string" && ID.test(value) ? value : null);

  /** One task of the board, in the shape the CLI promises; anything else is dropped or null. */
  function boardTask(task) {
    const taskId = typeof task?.taskId === "string" && /^[a-z0-9][a-z0-9.-]{2,95}$/u.test(task.taskId) ? task.taskId : null;
    if (taskId === null || boardId(task.agentId) === null || !TASK_STAGES.includes(task.stage)) return null;
    const part = (value, build) => (value !== null && typeof value === "object" && !Array.isArray(value) ? build(value) : null);
    return {
      taskId, title: boardText(task.title, 200), agentId: task.agentId, sourceId: boardToken(task.sourceId),
      contractVersion: boardToken(task.contractVersion), priority: boardToken(task.priority),
      dispatchedAtUtc: boardTime(task.dispatchedAtUtc), verified: task.verified === true,
      dispatchedByCoordinator: task.dispatchedByCoordinator === true, stage: task.stage,
      start: part(task.start, (start) => ({ startedAtUtc: boardTime(start.startedAtUtc),
        coordinatorAgentId: boardId(start.coordinatorAgentId), reportOperation: boardToken(start.reportOperation),
        continuationPolicy: boardToken(start.continuationPolicy), returnState: boardToken(start.returnState),
        declined: start.declined === true })),
      acknowledgement: part(task.acknowledgement, (ack) => ({ decision: boardToken(ack.decision),
        reason: boardText(ack.reason, 400), acknowledgedAtUtc: boardTime(ack.acknowledgedAtUtc) })),
      progress: part(task.progress, (progress) => ({ state: boardToken(progress.state),
        lifecycleStage: boardToken(progress.lifecycleStage), planStatus: boardToken(progress.planStatus),
        planRevision: Number.isSafeInteger(progress.planRevision) ? progress.planRevision : null,
        now: boardText(progress.now, 200), updatedAtUtc: boardTime(progress.updatedAtUtc) })),
      report: part(task.report, (report) => ({ status: boardToken(report.status), summary: boardText(report.summary, 400),
        reportedAtUtc: boardTime(report.reportedAtUtc) })),
      acceptance: part(task.acceptance, (acceptance) => ({ result: boardToken(acceptance.result),
        evaluatedAtUtc: boardTime(acceptance.evaluatedAtUtc) })),
      review: part(task.review, (review) => ({ outcome: boardToken(review.outcome) })),
    };
  }

  /**
   * The task board: the desk agents that take controller tasks (each with
   * whether its source still validates) and the tasks dispatched to them, of
   * one agent when `agentId` is given. Read-only, no confirmation.
   */
  async function readTaskBoard({ agentId = null } = {}) {
    if (agentId !== null && (typeof agentId !== "string" || !ID.test(agentId))) return invalid("agent_id_invalid", "agentId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const args = [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "read-task-board", "--json"];
    const result = agentId === null
      ? await runCli(config.gatewayCli.nodeExecutable, args, config.controllerRoot)
      : await withInputFile({ agentId }, (inputPath) => runCli(config.gatewayCli.nodeExecutable,
        [...args, "--input-file", inputPath], config.controllerRoot));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const sources = Array.isArray(parsed.value?.sources) ? parsed.value.sources : [];
    const tasks = Array.isArray(parsed.value?.tasks) ? parsed.value.tasks : [];
    return {
      ok: true,
      data: {
        agentId,
        sources: sources.filter((item) => boardId(item?.agentId) !== null && boardToken(item?.sourceId) !== null)
          .slice(0, 256).map((item) => ({ agentId: item.agentId, sourceId: item.sourceId, valid: item.valid === true })),
        tasks: tasks.slice(0, 400).map(boardTask).filter((task) => task !== null),
        truncated: parsed.value?.truncated === true,
      },
    };
  }

  /**
   * Makes an agent a desk agent: it takes controller tasks from then on. The
   * person confirms; the backend creates its coordination folder with the task
   * kit and records it as a controller source. There is no unregistering in
   * the backend, so the confirmation says it is permanent.
   */
  async function registerDeskAgent({ agentId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const confirmed = await confirm({
      title: tx("Take tasks (desk agent)"),
      message: tx("Let agent “{agentId}” take controller tasks?", { agentId }),
      detail: tx("The controller will create a coordination folder with a task kit for it (.project-local/desk-agents/) ")
        + tx("and record it as a source in config/source-registry.json. The world lead will be able to give it tasks ")
        + tx("under the contract: task package → plan → progress → report → acceptance; the agent carries out a plan only after ")
        + tx("you confirm it in its chat.\n\nThe registration is permanent: it cannot be removed from Atlas — the backend has no ")
        + tx("way to unregister."),
      confirmLabel: tx("Take tasks"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    const result = await withInputFile({ agentId }, (inputPath) => runCli(
      config.gatewayCli.nodeExecutable,
      [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "register-desk-source",
        "--input-file", inputPath, "--confirm-agent", agentId, "--json"],
      config.controllerRoot, REGISTRATION_TIMEOUT_MS,
    ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    const status = parsed.value?.status;
    return { ok: true, data: { agentId,
      status: status === "registered" || status === "already-registered" ? status : null,
      sourceId: boardToken(parsed.value?.sourceId) } };
  }

  const samePath = (left, right) => (process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right));
  // A confirmed world lead: flowId → { agentId, expiresAt }. Only these may get the coordinator role.
  const worldFlows = new Map();

  /**
   * The first step of “Create world lead…”: the person confirms the
   * whole thing once - the world project bound to the controller folder (a
   * permanent binding), the agent and its role - and the world project is
   * bound. The answer carries a flowId: the role step accepts the coordinator
   * role only with it, for this agent, within WORLD_FLOW_MS.
   */
  async function prepareWorldLead({ agentId, model = null } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (model !== null && (typeof model !== "string" || !ID.test(model))) return invalid("model_invalid", "model");
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    let root;
    try { root = await realpath(config.controllerRoot); } catch {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: "controller_root_unreadable" } };
    }
    const current = await readProjectFolder({ projectId: WORLD_PROJECT });
    if (!current.ok) return current;
    const bound = current.data.configured === true;
    if (bound && !samePath(current.data.workspacePath, root)) {
      return { ok: false, error: { code: "world_folder_conflict", reasonCode: "world_folder_conflict" } };
    }
    const confirmed = await confirm({
      title: tx("World lead"),
      message: tx("Create world lead “{agentId}”?", { agentId }),
      detail: tx("The world lead is the coordinator over all projects: it gives tasks to project leads and ")
        + tx("desk agents under the task contract (task package → plan → progress → report → acceptance), does not do ")
        + tx("their work itself and changes files only in coordination/drafts/. The controller has only one coordinator.\n\n")
        + (bound ? tx("The world project “{WORLD_PROJECT}” is already bound to the controller folder:\n{root}\n\n", { WORLD_PROJECT, root })
          : tx("The world project “{WORLD_PROJECT}” will be bound to the controller folder:\n{root}\nThe binding is permanent.\n\n", { WORLD_PROJECT, root }))
        + tx("Agent \"{agentId}\"{value} will be created in the World HQ, ", { agentId, value: model === null ? "" : ` (${model})` })
        + tx("and it will be given the world lead role."),
      confirmLabel: tx("Create"),
    });
    if (!confirmed) return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
    if (!bound) {
      const result = await withInputFile({ projectId: WORLD_PROJECT, workspacePath: root }, (inputPath) => runCli(
        config.gatewayCli.nodeExecutable,
        [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "bind-workspace",
          "--input-file", inputPath, "--confirm-project", WORLD_PROJECT, "--json"],
        config.controllerRoot,
      ));
      if (result?.ok === false) return result;
      const parsed = parseCliJson(result);
      if (!parsed.ok) return parsed;
    }
    for (const [flowId, flow] of worldFlows) if (flow.expiresAt < Date.now()) worldFlows.delete(flowId);
    const flowId = randomUUID();
    worldFlows.set(flowId, { agentId, expiresAt: Date.now() + WORLD_FLOW_MS });
    return { ok: true, data: { flowId, agentId, projectId: WORLD_PROJECT, quarterId: WORLD_HQ_QUARTER,
      newlyBound: !bound } };
  }

  /**
   * The last step: the agent the person confirmed becomes the world lead (the
   * coordinator role). Without that confirmation's flowId - or for another
   * agent, or after WORLD_FLOW_MS - it is refused, so the role is never given
   * outside the confirmed flow. `expectedRevision` is the settings revision.
   */
  async function assignWorldLead({ agentId, flowId, expectedRevision } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return invalid("revision_invalid", "expectedRevision");
    }
    const flow = typeof flowId === "string" ? worldFlows.get(flowId) : undefined;
    if (flow === undefined || flow.agentId !== agentId || flow.expiresAt < Date.now()) {
      return { ok: false, error: { code: "world_flow_expired", reasonCode: "world_flow_expired" } };
    }
    const ready = await availability();
    if (!ready.available) {
      return { ok: false, error: { code: "cli_unavailable", reasonCode: ready.reasonCode } };
    }
    const commandId = `atlas-world-lead-${randomUUID()}`;
    const result = await withInputFile({ agentId, expectedRevision, role: "coordinator", writeZone: null, commandId },
      (inputPath) => runCli(
        config.gatewayCli.nodeExecutable,
        [cliScript, "memory", "--repo-root", config.controllerRoot, "--action", "set-agent-settings",
          "--input-file", inputPath, "--confirm-user-command", commandId, "--json"],
        config.controllerRoot,
      ));
    if (result?.ok === false) return result;
    const parsed = parseCliJson(result);
    if (!parsed.ok) return parsed;
    // Used: the confirmation covered exactly this one role.
    worldFlows.delete(flowId);
    return { ok: true, data: { agentId, role: "coordinator",
      revision: Number.isSafeInteger(parsed.value?.settings?.revision) ? parsed.value.settings.revision : null } };
  }

  // Each trusted action leaves one journal entry: identifiers only - never the
  // folder path, never the memory entries.
  const journalled = (action, run, targetOf) => async (input = {}) => {
    const entry = journal?.beginTrusted(action, targetOf(input)) ?? null;
    const result = await run(input);
    if (entry !== null) journal.completeTrusted(entry, result);
    return result;
  };
  return {
    availability,
    chooseWorkspace,
    bindWorkspace: journalled("bind-workspace", bindWorkspace, ({ projectId }) => ({ projectId })),
    rebindWorkspace: journalled("rebind-workspace", rebindWorkspace, ({ projectId }) => ({ projectId })),
    settleSend: journalled("settle-send", settleSend, ({ agentId }) => ({ agentId })),
    saveMemoryEdit: journalled("save-user-edit", saveMemoryEdit,
      ({ scopeId, expectedRevision }) => ({ scopeId, expectedRevision })),
    archiveProject: journalled("archive-project", archiveProject, ({ projectId }) => ({ projectId })),
    restoreProject: journalled("restore-project", restoreProject, ({ projectId }) => ({ projectId })),
    archiveQuarter: journalled("archive-quarter", archiveQuarter,
      ({ projectId, quarterId }) => ({ projectId, quarterId })),
    restoreQuarter: journalled("restore-quarter", restoreQuarter,
      ({ projectId, quarterId }) => ({ projectId, quarterId })),
    setAgentRole: journalled("set-agent-settings", setAgentRole, ({ agentId, role }) => ({ agentId, role })),
    setAgentPermissionMode: journalled("set-permission-mode", setAgentPermissionMode,
      ({ agentId, permissionMode }) => ({ agentId, permissionMode })),
    readPermissionModes,
    readAgentCommits,
    initProjectGit: journalled("init-project-git", initProjectGit, ({ projectId }) => ({ projectId })),
    previewMemoryDocument,
    approveMemoryDocument: journalled("approve-memory-document", approveMemoryDocument,
      ({ agentId }) => ({ agentId })),
    readProjectFolder,
    readActionJournal,
    undoAction: journalled("undo-action", undoAction, ({ projectId, entryId }) => ({ projectId, entryId })),
    readNames,
    renameObject: journalled("rename", renameObject, ({ projectId, kind, objectId }) => ({ projectId, kind, objectId })),
    listArchivedProjects,
    listAwayProjects,
    setProjectPolicy: journalled("set-project-policy", setProjectPolicy, ({ projectId }) => ({ projectId })),
    unmountProject: journalled("unmount-project", unmountProject, ({ projectId }) => ({ projectId })),
    mountProject: journalled("mount-project", mountProject, ({ projectId }) => ({ projectId: projectId ?? null })),
    syncStatus,
    syncTake: journalled("sync-take", syncTake, ({ target }) => ({ target: syncId(target) ?? "all" })),
    syncRelease: journalled("sync-release", syncRelease, ({ target }) => ({ target: syncId(target) ?? "all" })),
    readTaskBoard,
    registerDeskAgent: journalled("register-desk-source", registerDeskAgent, ({ agentId }) => ({ agentId })),
    prepareWorldLead: journalled("bind-workspace", prepareWorldLead, ({ agentId }) => ({ projectId: WORLD_PROJECT, agentId })),
    assignWorldLead: journalled("set-agent-settings", assignWorldLead,
      ({ agentId }) => ({ agentId, role: "coordinator" })),
  };
}

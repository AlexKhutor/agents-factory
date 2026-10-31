import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { renameOver } from "./rename-over.mjs";
import path from "node:path";

import { DESK_AGENT_PROFILE, DESK_AGENT_ROUTE, validateDeskAgentSource } from "./desk-agent-source-validation.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";
import { installDeskAgentKit } from "./desk-task-controller.mjs";

// Desk agents as controller sources (one agent model, claude-code-controller.md):
// the controller's task workflow reaches an agent of the desk the way it
// reaches a child workspace. Its coordination files (task inbox, progress and
// report outboxes, the child kit) live in a controller-owned folder per agent,
// never in the project folder the agent works in and shares with others.

export const DESK_AGENT_SOURCES_VERSION = "v0.3.0";
export const DESK_AGENT_FOLDER = path.join(".project-local", "desk-agents");

function fail(code) { throw Object.assign(new Error(code), { code }); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** The controller source ID of a desk agent: readable when the agent ID allows it. */
export function deskAgentSourceId(agentId) {
  if (typeof agentId !== "string" || !agentId) fail("desk_source_agent_invalid");
  return /^[a-z0-9][a-z0-9-]{0,47}$/u.test(agentId) ? `desk-${agentId}` : `desk-${sha256(agentId).slice(0, 16)}`;
}

function sourceEntry(sourceId, agentId) {
  return {
    id: sourceId,
    ownerRole: `desk agent ${agentId}`,
    workspaceRelativeSourceRoot: ".",
    taskInbox: ".orchestrator/tasks/inbox",
    reportOutbox: ".orchestrator/reports/outbox",
    progressOutbox: ".orchestrator/progress/outbox",
    executionAdapter: DESK_AGENT_ROUTE,
    providerRoute: DESK_AGENT_ROUTE,
    coordinationProfile: DESK_AGENT_PROFILE,
    executorState: "installed",
    requiredDocuments: [],
    reportInbox: `knowledge/reports/inbox/${sourceId}`,
    deskAgentId: agentId,
  };
}

const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const samePath = (left, right) => typeof left === "string" && typeof right === "string"
  && (process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right));

async function readJson(file, fallback = undefined) {
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
  return JSON.parse(text);
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameOver(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Registers a desk agent as a controller source. A trusted local command (the
 * memory CLI after the person's confirmation): it changes the controller's
 * source registry. Idempotent: the same agent again verifies what exists;
 * anything that differs is a conflict, never overwritten.
 */
export async function registerDeskAgentSource({ controllerRoot, service, agentId,
  // The kit is installed in this process (desk-task-controller.mjs, the same files
  // install_child_coordination_kit.ps1 writes), so registration needs no PowerShell.
  installKit = installDeskAgentKit,
  now = () => new Date() } = {}) {
  if (typeof controllerRoot !== "string" || !path.isAbsolute(controllerRoot)) fail("desk_source_root_invalid");
  const root = path.resolve(controllerRoot);
  const agent = await service.readAgent({ agentId });
  if (agent.state !== "active") fail("memory_agent_closed");
  const project = await resolveProjectWorkspace(service.store, agent.projectId);
  const sourceId = deskAgentSourceId(agentId);
  const folder = path.join(root, DESK_AGENT_FOLDER, sourceId);
  const desired = sourceEntry(sourceId, agentId);
  const desiredBinding = { workspacePath: folder, sourcePath: project.workspacePath };

  const stateRoot = path.join(root, ".project-local", "orchestration");
  await mkdir(stateRoot, { recursive: true });
  // The same global lock as the controller's other registrations.
  const lock = path.join(stateRoot, "desk-source-registration.lock");
  try { await mkdir(lock); } catch (error) {
    if (error.code === "EEXIST") fail("desk_source_registration_busy");
    throw error;
  }
  try {
    const registryPath = path.join(root, "config", "source-registry.json");
    const bindingsPath = path.join(root, ".project-local", "source-bindings.json");
    const registry = await readJson(registryPath);
    const bindings = await readJson(bindingsPath, { schemaVersion: 2, sources: {} });
    if (registry.schemaVersion !== 2 || !Array.isArray(registry.sources)
        || ![1, 2].includes(bindings.schemaVersion) || !bindings.sources || typeof bindings.sources !== "object") {
      fail("controller_registry_incompatible");
    }
    const existing = registry.sources.filter((item) => item?.id === sourceId);
    if (existing.length > 1) fail("duplicate_source_id");
    if (existing[0] && canonical(existing[0]) !== canonical(desired)) fail("desk_source_conflict");
    const bound = bindings.sources[sourceId] ?? null;
    if (bound && !(samePath(bound.workspacePath, folder) && samePath(bound.sourcePath, project.workspacePath))) {
      fail("desk_source_binding_conflict");
    }
    for (const [otherId, binding] of Object.entries(bindings.sources)) {
      if (otherId !== sourceId && samePath(binding?.workspacePath ?? binding?.path, folder)) fail("desk_source_folder_conflict");
    }

    // The coordination folder: the owner's version file the kit installer
    // updates, and the record naming the agent the source belongs to.
    await mkdir(path.join(folder, ".orchestrator"), { recursive: true });
    const versionPath = path.join(folder, "project-version.json");
    if (!(await lstat(versionPath).catch(() => null))) {
      await writeJsonAtomic(versionPath, { formatVersion: 1, projectName: sourceId, projectVersion: "v0.1.0",
        componentVersions: {} });
    }
    const recordPath = path.join(folder, ".orchestrator", "desk-agent.json");
    const record = { schemaVersion: 1, sourceId, agentId, projectId: agent.projectId, quarterId: agent.quarterId };
    const existingRecord = await readJson(recordPath, null);
    if (existingRecord === null) {
      await writeJsonAtomic(recordPath, { ...record, registeredAtUtc: now().toISOString() });
    } else if (Object.entries(record).some(([key, value]) => existingRecord[key] !== value)) {
      fail("desk_source_record_conflict");
    }

    if (!bound) {
      await writeJsonAtomic(bindingsPath, { ...bindings, schemaVersion: 2,
        sources: { ...bindings.sources, [sourceId]: desiredBinding } });
    }
    if (!existing[0]) {
      await writeJsonAtomic(registryPath, { ...registry, sources: [...registry.sources, desired] });
    }

    const installed = await installKit(root, sourceId);
    if (installed.code !== 0) {
      // The installer's own words, bounded, for the operator; never retried here.
      throw Object.assign(new Error("desk_source_kit_install_failed"), { code: "desk_source_kit_install_failed",
        output: String(installed.output ?? "").slice(-4000) });
    }
    const validation = await validateDeskAgentSource(desired, folder);
    return { status: existing[0] && bound ? "already-registered" : "registered", sourceId, agentId,
      route: validation.routeId, coordinationFolder: path.relative(root, folder).replaceAll(path.sep, "/") };
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The registered source of a desk agent, or null. */
export async function readDeskAgentSource({ controllerRoot, agentId }) {
  const root = path.resolve(controllerRoot);
  const sourceId = deskAgentSourceId(agentId);
  const registry = await readJson(path.join(root, "config", "source-registry.json"), { schemaVersion: 2, sources: [] });
  const source = (registry.sources ?? []).find((item) => item?.id === sourceId && item.deskAgentId === agentId);
  if (!source) return null;
  const folder = path.join(root, DESK_AGENT_FOLDER, sourceId);
  try { await validateDeskAgentSource(source, folder); } catch { return null; }
  // The agent's project folder (the binding's sourcePath): its git state is the task's revision.
  const bindings = await readJson(path.join(root, ".project-local", "source-bindings.json"), { sources: {} });
  const projectFolder = bindings.sources?.[sourceId]?.sourcePath ?? null;
  return { sourceId, agentId, folder, projectFolder: typeof projectFolder === "string" ? projectFolder : null };
}

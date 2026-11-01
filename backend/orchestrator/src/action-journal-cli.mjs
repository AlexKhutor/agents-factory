import { isDeepStrictEqual } from "node:util";

import { readActions, readProjectActions, recordActionQuietly } from "./action-journal.mjs";
import { memoryWrite } from "./action-journal-gateway.mjs";
import { archivedSets } from "./project-archive.mjs";
import { WORLD_PROJECT_ID } from "./project-store-layout.mjs";
import { readWorldRegistry } from "./world-registry.mjs";

// The memory CLI's trusted actions in the action journal (action-journal.mjs).
// The trusted host (Atlas) runs them after the person confirmed them, so the
// actor is the person. `journalBefore` looks at what an action is about to
// change; `journalAfter` records an entry when something did change. Neither
// ever fails the action.

export const ACTION_JOURNAL_CLI_VERSION = "v0.1.0";

const PERSON = Object.freeze({ kind: "person", id: null });
const AGENTS_KEY = "memory-agents-v1";
const DEFAULT_POLICY = Object.freeze({ homeOnly: false, allowedMachines: null });

async function quietly(read) {
  try { return await read(); } catch { return null; }
}

async function agentsOf(store) {
  return (await store.readDocument({ key: AGENTS_KEY }))?.value?.agents ?? [];
}

async function agentOf(store, agentId) {
  return (await agentsOf(store)).find((agent) => agent.agentId === agentId) ?? null;
}

const settingsOf = (agent) => ({ role: agent?.settings?.role ?? "feature", writeZone: agent?.settings?.writeZone ?? null,
  revision: agent?.settings?.revision ?? 0 });

/** What a journaled action is about to change; null when there is nothing to look at. */
export async function journalBefore(action, input, { store, root }) {
  return quietly(async () => {
    switch (action) {
      case "save-user-edit": return store.readScope({ scopeId: input.scopeId });
      case "set-agent-settings":
      case "set-permission-mode": return agentOf(store, input.agentId);
      case "archive-project": case "restore-project": case "archive-quarter": case "restore-quarter":
        return archivedSets(store);
      case "set-project-policy":
        return (await readWorldRegistry(root)).projects[input.projectId]?.policy ?? DEFAULT_POLICY;
      default: return null;
    }
  });
}

async function entryOf(action, input, result, before, { store }) {
  switch (action) {
    case "save-user-edit": {
      if (before === null || result?.previousRevision !== before.revision) return null;
      return memoryWrite(await store.readScope({ scopeId: input.scopeId }), result, PERSON);
    }
    case "approve-memory-document": {
      const agent = await agentOf(store, input.agentId);
      if (agent === null) return null;
      if (result?.write) {
        const scope = await store.readScope({ scopeId: result.write.scopeId });
        return { ...memoryWrite(scope, { previousRevision: result.write.revision - 1, revision: result.write.revision }, PERSON),
          agentId: agent.agentId };
      }
      return { action: "memory.approve", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId,
        summary: `Approved ${result?.path ?? "a document"} of ${agent.agentId} for the ${result?.kind ?? ""} memory`,
        noUndo: "approval_without_write" };
    }
    case "set-agent-settings": {
      if (before === null) return null;
      const agent = await agentOf(store, input.agentId);
      const was = settingsOf(before), now = settingsOf(agent);
      if (now.revision === was.revision) return null;
      return { action: "agent.settings", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId,
        summary: `Role of ${agent.agentId}: ${was.role} → ${now.role}${now.writeZone ? " (write zone set)" : ""}`,
        undo: { kind: "set-settings", agentId: agent.agentId, role: was.role, writeZone: was.writeZone,
          expectRevision: now.revision } };
    }
    case "set-permission-mode": {
      if (before === null || result?.changed !== true) return null;
      const was = before.permissionMode ?? null;
      return { action: "agent.permission-mode", projectId: before.projectId, quarterId: before.quarterId,
        agentId: before.agentId,
        summary: `Permission mode of ${before.agentId}: ${was ?? "the provider's"} → ${input.permissionMode ?? "the provider's"}`,
        undo: { kind: "set-permission-mode", agentId: before.agentId, permissionMode: was, expect: input.permissionMode } };
    }
    case "archive-project":
    case "restore-project": {
      const archiving = action === "archive-project";
      if (before === null || before.projects.has(input.projectId) === archiving) return null;
      return { action: archiving ? "project.archive" : "project.restore", projectId: input.projectId,
        summary: `${archiving ? "Archived" : "Restored"} project ${input.projectId}`,
        undo: { kind: archiving ? "restore-project" : "archive-project", projectId: input.projectId } };
    }
    case "archive-quarter":
    case "restore-quarter": {
      const archiving = action === "archive-quarter";
      if (before === null || before.quarters.has(`${input.projectId}/${input.quarterId}`) === archiving) return null;
      return { action: archiving ? "quarter.archive" : "quarter.restore", projectId: input.projectId,
        quarterId: input.quarterId, summary: `${archiving ? "Archived" : "Restored"} quarter ${input.quarterId}`,
        undo: { kind: archiving ? "restore-quarter" : "archive-quarter", projectId: input.projectId,
          quarterId: input.quarterId } };
    }
    case "set-project-policy": {
      if (before === null || isDeepStrictEqual(before, result?.policy)) return null;
      return { action: "project.policy", projectId: input.projectId,
        summary: `Where ${input.projectId} may be kept: ${result.policy.homeOnly ? "home only"
          : result.policy.allowedMachines ? result.policy.allowedMachines.join(", ") : "any PC"}`,
        undo: { kind: "set-project-policy", projectId: input.projectId, policy: before, expect: result.policy } };
    }
    case "bind-workspace":
    case "rebind-workspace":
      return { action: action === "bind-workspace" ? "project.bind" : "project.rebind", projectId: input.projectId,
        summary: action === "bind-workspace" ? `Bound project ${input.projectId} to its folder`
          : `Moved project ${input.projectId} to another folder`, noUndo: "binding_not_undone" };
    case "rename": {
      if (result?.previous === result?.name) return null;
      const shown = (value) => `"${value ?? input.objectId}"`;
      return { action: "object.rename", projectId: input.projectId,
        ...(input.kind === "quarter" ? { quarterId: input.objectId } : {}),
        ...(input.kind === "agent" ? { agentId: input.objectId } : {}),
        summary: `Renamed ${input.kind} ${input.objectId}: ${shown(result.previous)} → ${shown(result.name)}`,
        undo: { kind: "rename", projectId: input.projectId, objectKind: input.kind, objectId: input.objectId,
          name: result.previous, expect: result.name } };
    }
    case "init-project-git":
      return { action: "project.git-init", projectId: input.projectId,
        summary: `Started a git repository in the folder of ${input.projectId}`, noUndo: "git_not_undone" };
    // Task mode (agent-tasks.mjs): each step of a task is the person's, and goes forward only (a task is cancelled, not undone).
    case "start-task": case "revise-task": case "approve-task": case "cancel-task": {
      const task = action === "cancel-task" ? result?.task : result;
      if (typeof task?.taskId !== "string") return null;
      const summary = {
        "start-task": `Gave task ${task.taskId} to ${task.agentId}: a plan first`,
        "revise-task": `Asked ${task.agentId} to change the plan of task ${task.taskId}`,
        "approve-task": `Approved revision ${task.approved?.revision ?? "?"} of the plan of task ${task.taskId}`,
        "cancel-task": `Cancelled task ${task.taskId} of ${task.agentId}`,
      }[action];
      return { action: `task.${action.slice(0, -"-task".length)}`, projectId: task.projectId, quarterId: task.quarterId,
        agentId: task.agentId, summary, noUndo: "task_not_undone" };
    }
    // An agent's memory change the person approved: written as the person's, with the memory's undo.
    case "approve-memory-change": {
      if (result?.state !== "approved" || !Number.isSafeInteger(result.writtenRevision)) return null;
      const scope = await store.readScope({ scopeId: result.target.scopeId });
      return { ...memoryWrite(scope, { previousRevision: result.writtenRevision - 1, revision: result.writtenRevision }, PERSON),
        agentId: result.target.agentId ?? result.agentId };
    }
    case "set-memory-autonomy": {
      if (result?.changed !== true) return null;
      const agent = await agentOf(store, input.agentId);
      return agent === null ? null : { action: "agent.memory-autonomy", projectId: agent.projectId, quarterId: agent.quarterId,
        agentId: agent.agentId, summary: input.allowed ? `${agent.agentId} changes its own memory without asking`
          : `${agent.agentId} asks before changing its own memory`, noUndo: "setting_not_undone" };
    }
    case "register-desk-source": {
      const agent = await agentOf(store, input.agentId);
      return agent === null ? null : { action: "agent.desk-source", projectId: agent.projectId,
        quarterId: agent.quarterId, agentId: agent.agentId, summary: `${agent.agentId} takes controller tasks`,
        noUndo: "desk_source_not_undone" };
    }
    default: return null;
  }
}

/** Records the action's entry when it changed something; never throws. */
export async function journalAfter(action, input, result, before, { store, root, now = () => new Date(),
  onDiagnostic = () => {} } = {}) {
  const entry = await quietly(() => entryOf(action, input, result, before, { store, root }));
  if (entry !== null) await recordActionQuietly(store, { actor: PERSON, ...entry }, { now, onDiagnostic });
}

/**
 * The journal for the trusted host: one project's entries, or all the
 * projects this store holds and the world's, newest first.
 */
export async function readJournal(store, input) {
  const keys = Object.keys(input ?? {});
  if (keys.some((key) => !["projectId", "limit"].includes(key))) throw Object.assign(new Error("memory_invalid_input"),
    { code: "memory_invalid_input" });
  const limit = input?.limit ?? 200;
  if (typeof input?.projectId === "string") {
    return { schemaVersion: 1, entries: await readProjectActions(store, { projectId: input.projectId, limit }) };
  }
  const projectIds = [...new Set([...(await store.listScopes({})).scopes.map((scope) => scope.projectId),
    WORLD_PROJECT_ID])];
  return { schemaVersion: 1, entries: await readActions(store, { projectIds, limit }) };
}

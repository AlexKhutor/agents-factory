import { isDeepStrictEqual } from "node:util";

import { ActionJournalError, findAction, recordAction } from "./action-journal.mjs";
import { restoreKeptFile } from "./action-journal-files.mjs";
import { readAcpProviderConfig } from "./acp-provider-config.mjs";
import { readClaudeProviderConfig } from "./claude-provider-config.mjs";
import { archiveProject, archiveQuarter, archivedSets, restoreProject, restoreQuarter } from "./project-archive.mjs";
import { readWorldRegistry, recordWorldProjects } from "./world-registry.mjs";
import { readNames, setName } from "./object-names.mjs";

// The undo of one journal entry (action-journal.mjs): a trusted host action
// (the memory CLI's `undo-action`, after the person confirmed it), never an
// operation of the Gateway's HTTP surface. It first checks that what the
// entry changed is still as the entry left it - otherwise a later change
// stands in the way and is undone first ("journal_undo_stale") - then does the
// inverse through the same service and store calls as the action itself, and
// records it as a new entry that `undoes` the first. An undo is not undone in
// turn: the person does the action again instead.

export const ACTION_JOURNAL_UNDO_VERSION = "v0.1.0";

function fail(code) { throw new ActionJournalError(code); }

/** The person who confirmed the undo in the trusted host. */
const PERSON = Object.freeze({ kind: "person", id: null });

async function agentOf(service, agentId) {
  return service.find((await service.catalog()).value, agentId);
}

/** A profile the provider no longer offers is not brought back (the agent would fail its next turn). */
async function requireOfferedModel(controllerRoot, profile) {
  let models = [];
  if (profile.provider === "claude") models = (await readClaudeProviderConfig(controllerRoot)).models;
  else if (profile.provider === "acp") models = (await readAcpProviderConfig(controllerRoot))?.models ?? [];
  if (!models.some((model) => model.id === profile.model)) fail("journal_undo_model_unavailable");
}

const UNDO = {
  /** Undo of a created agent: closed while it has done nothing; once it worked, the person closes it. */
  async "close-agent"({ service, recipe, entry }) {
    const agent = await agentOf(service, recipe.agentId);
    if (agent.state !== "active") fail("journal_undo_stale");
    if (agent.operations.length > 0) fail("journal_undo_agent_worked");
    await service.closeAgent({ agentId: agent.agentId, operationId: `undo-${entry.entryId}` });
    return { action: "agent.close", agentId: agent.agentId, quarterId: agent.quarterId,
      summary: `Closed agent ${agent.agentId} (its creation undone)` };
  },
  async "reopen-agent"({ service, recipe }) {
    const agent = await agentOf(service, recipe.agentId);
    if (agent.state !== "archived") fail("journal_undo_stale");
    await service.reopenAgent({ agentId: agent.agentId });
    return { action: "agent.reopen", agentId: agent.agentId, quarterId: agent.quarterId,
      summary: `Reopened agent ${agent.agentId}` };
  },
  async "set-profile"({ service, controllerRoot, recipe }) {
    const agent = await agentOf(service, recipe.agentId);
    if (!isDeepStrictEqual(agent.profile, recipe.expect)) fail("journal_undo_stale");
    if (agent.state !== "active") fail("journal_undo_stale");
    await requireOfferedModel(controllerRoot, recipe.profile);
    await service.change((doc) => {
      const current = service.find(doc, agent.agentId);
      if (!isDeepStrictEqual(current.profile, recipe.expect) || current.state !== "active") fail("journal_undo_stale");
      current.profile = structuredClone(recipe.profile);
      current.profileChangedAtUtc = service.now().toISOString();
    });
    return { action: "agent.profile", agentId: agent.agentId, quarterId: agent.quarterId,
      summary: `Model of ${agent.agentId} back to ${recipe.profile.model} (${recipe.profile.reasoningEffort})` };
  },
  async "set-settings"({ service, recipe }) {
    const agent = await agentOf(service, recipe.agentId);
    try {
      await service.setAgentSettings({ agentId: agent.agentId, expectedRevision: recipe.expectRevision,
        role: recipe.role, writeZone: recipe.writeZone });
    } catch (error) {
      if (error?.code === "memory_revision_conflict") fail("journal_undo_stale");
      throw error;
    }
    return { action: "agent.settings", agentId: agent.agentId, quarterId: agent.quarterId,
      summary: `Role of ${agent.agentId} back to ${recipe.role}` };
  },
  async "set-permission-mode"({ service, recipe }) {
    const agent = await agentOf(service, recipe.agentId);
    if ((agent.permissionMode ?? null) !== recipe.expect) fail("journal_undo_stale");
    await service.setAgentPermissionMode({ agentId: agent.agentId, permissionMode: recipe.permissionMode });
    return { action: "agent.permission-mode", agentId: agent.agentId, quarterId: agent.quarterId,
      summary: `Permission mode of ${agent.agentId} back to ${recipe.permissionMode ?? "the provider's"}` };
  },
  async "archive-project"({ store, recipe }) {
    if ((await archivedSets(store)).projects.has(recipe.projectId)) fail("journal_undo_stale");
    await archiveProject({ store, projectId: recipe.projectId });
    return { action: "project.archive", summary: `Archived project ${recipe.projectId}` };
  },
  async "restore-project"({ store, recipe }) {
    if (!(await archivedSets(store)).projects.has(recipe.projectId)) fail("journal_undo_stale");
    await restoreProject({ store, projectId: recipe.projectId });
    return { action: "project.restore", summary: `Restored project ${recipe.projectId}` };
  },
  async "archive-quarter"({ store, recipe }) {
    if ((await archivedSets(store)).quarters.has(`${recipe.projectId}/${recipe.quarterId}`)) fail("journal_undo_stale");
    await archiveQuarter({ store, projectId: recipe.projectId, quarterId: recipe.quarterId });
    return { action: "quarter.archive", quarterId: recipe.quarterId,
      summary: `Archived quarter ${recipe.quarterId}` };
  },
  async "restore-quarter"({ store, recipe }) {
    if (!(await archivedSets(store)).quarters.has(`${recipe.projectId}/${recipe.quarterId}`)) fail("journal_undo_stale");
    await restoreQuarter({ store, projectId: recipe.projectId, quarterId: recipe.quarterId });
    return { action: "quarter.restore", quarterId: recipe.quarterId,
      summary: `Restored quarter ${recipe.quarterId}` };
  },
  /** A memory goes back to the revision before the change, as a new revision; the later ones stay in its history. */
  async "memory-revision"({ store, recipe, entry }) {
    const current = await store.readScope({ scopeId: recipe.scopeId });
    if (current.revision !== recipe.expectRevision) fail("journal_undo_stale");
    const previous = await store.readScope({ scopeId: recipe.scopeId, revision: recipe.revision });
    const commandId = `undo-${entry.entryId}`;
    await store.authorizeWrite({ commandId, scopeId: recipe.scopeId, expectedRevision: current.revision,
      entries: previous.entries, requestedBy: "project-owner" });
    const receipt = await store.write({ scopeId: recipe.scopeId, expectedRevision: current.revision,
      entries: previous.entries, operationId: commandId, commandId, actorId: "project-owner" });
    return { action: "memory.write", quarterId: current.quarterId,
      summary: `Memory "${current.title}" back to revision ${recipe.revision} (now revision ${receipt.revision})` };
  },
  /** A file saved from Atlas back to the version before the save, kept on this PC (action-journal-files.mjs). */
  async "restore-file"({ controllerRoot, store, recipe }) {
    await restoreKeptFile({ controllerRoot, store, projectId: recipe.projectId, relativePath: recipe.path,
      sha256: recipe.sha256, expectSha256: recipe.expect });
    return { action: "project.file-save", summary: `${recipe.path} back to the version before the save` };
  },
  /** A name back to the one before (null: the object's ID). */
  async rename({ store, recipe }) {
    const names = await readNames(store, recipe.projectId);
    const current = recipe.objectKind === "project" ? names.project : names[`${recipe.objectKind}s`][recipe.objectId] ?? null;
    if (current !== recipe.expect) fail("journal_undo_stale");
    await setName(store, { projectId: recipe.projectId, kind: recipe.objectKind, objectId: recipe.objectId,
      name: recipe.name });
    return { action: "object.rename", ...(recipe.objectKind === "quarter" ? { quarterId: recipe.objectId } : {}),
      ...(recipe.objectKind === "agent" ? { agentId: recipe.objectId } : {}),
      summary: `Name of ${recipe.objectKind} ${recipe.objectId} back to "${recipe.name ?? recipe.objectId}"` };
  },
  async "set-project-policy"({ controllerRoot, recipe }) {
    const current = (await readWorldRegistry(controllerRoot)).projects[recipe.projectId]?.policy ?? null;
    if (!isDeepStrictEqual(current, recipe.expect)) fail("journal_undo_stale");
    await recordWorldProjects(controllerRoot, [{ projectId: recipe.projectId, policy: recipe.policy }]);
    return { action: "project.policy", summary: `Where ${recipe.projectId} may be kept: back to the previous rule` };
  },
};

/**
 * Undoes one entry of a project's journal. Returns the new entry (the undo)
 * and the entry it undid.
 */
export async function undoAction({ controllerRoot, store, service, projectId, entryId, now = () => new Date() }) {
  const entry = await findAction(store, { projectId, entryId });
  if (entry === null) fail("journal_entry_not_found");
  if (entry.undoneBy !== null) fail("journal_already_undone");
  if (entry.undo === null) fail("journal_not_undoable");
  const inverse = UNDO[entry.undo.kind];
  if (!inverse) fail("journal_not_undoable");
  const done = await inverse({ controllerRoot, store, service, recipe: entry.undo, entry });
  const undo = await recordAction(store, { action: done.action, actor: PERSON, projectId,
    quarterId: done.quarterId ?? entry.quarterId, agentId: done.agentId ?? entry.agentId,
    summary: done.summary, undo: null, undoes: entry.entryId }, { now });
  return { schemaVersion: 1, undo, undone: { ...entry, undoneBy: undo.entryId, undoneAtUtc: undo.atUtc } };
}

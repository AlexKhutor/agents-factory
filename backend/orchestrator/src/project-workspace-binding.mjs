import path from "node:path";
import { stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";

function fail(code) { throw Object.assign(new Error(code), { code }); }
export function workspaceDocumentKey(projectId) {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(projectId)) {
    fail("memory_invalid_input");
  }
  return `workspace-${createHash("sha256").update(projectId).digest("hex")}`;
}
export async function workspaceIdentity(workspacePath) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) fail("memory_invalid_input");
  const root = await realpath(workspacePath);
  if (!(await stat(root)).isDirectory()) fail("memory_invalid_input");
  const identity = process.platform === "win32" ? root.toLowerCase() : root;
  return { workspacePath: root, workspaceKey: createHash("sha256").update(identity).digest("hex") };
}

// Trusted host/operator only. This function is deliberately not an HTTP handler.
export async function bindProjectWorkspace(store, input) {
  if (!input || Object.keys(input).sort().join() !== "projectId,workspacePath") fail("memory_invalid_input");
  const documentKey = workspaceDocumentKey(input.projectId);
  const value = { projectId: input.projectId, ...await workspaceIdentity(input.workspacePath) };
  const existing = await store.readDocument({ key: documentKey });
  if (existing) {
    if (existing.value.workspaceKey !== value.workspaceKey) fail("memory_workspace_conflict");
  } else if (!await store.compareAndSwapDocument({ key: documentKey, expectedRevision: 0, value })) {
    return bindProjectWorkspace(store, input);
  }
  return { projectId: input.projectId, workspaceKey: value.workspaceKey, configured: true };
}

// The agent catalog (project-memory-service.mjs): an agent of the project, in
// any state, has worked or works in its folder.
const AGENTS_KEY = "memory-agents-v1";

/**
 * Moves a project to another folder - only while nothing depends on the folder
 * yet, else memory_workspace_in_use: no open agent of the project (its session
 * is pinned to the old folder; one that never worked can be closed first) and
 * no closed agent that ever worked (its history was made in the old folder).
 * Quarters do not count: a quarter without agents does not depend on the
 * folder. An ordinary binding never does this; this is its own action, which
 * the trusted host runs after the person confirmed the exact project and both
 * folders. An unbound project is simply bound.
 */
export async function rebindProjectWorkspace(store, input) {
  if (!input || Object.keys(input).sort().join() !== "projectId,workspacePath") fail("memory_invalid_input");
  const documentKey = workspaceDocumentKey(input.projectId);
  const value = { projectId: input.projectId, ...await workspaceIdentity(input.workspacePath) };
  const existing = await store.readDocument({ key: documentKey });
  if (!existing) return bindProjectWorkspace(store, input);
  if (existing.value.workspaceKey === value.workspaceKey) {
    return { projectId: input.projectId, workspaceKey: value.workspaceKey, configured: true, changed: false };
  }
  const agents = ((await store.readDocument({ key: AGENTS_KEY }))?.value?.agents ?? [])
    .filter((agent) => agent.projectId === input.projectId);
  // Worked: anything was ever sent to it (the catalog keeps its operations).
  const worked = (agent) => Array.isArray(agent.operations) && agent.operations.length > 0;
  if (agents.some((agent) => agent.state !== "archived" || worked(agent))) fail("memory_workspace_in_use");
  if (!await store.compareAndSwapDocument({ key: documentKey, expectedRevision: existing.revision, value })) {
    fail("memory_contention");
  }
  return { projectId: input.projectId, workspaceKey: value.workspaceKey, configured: true, changed: true };
}

/**
 * The trusted host's read of a project's binding, for the person's own window:
 * whether the project is bound, to which folder, and whether that folder still
 * exists. Trusted host/operator only, like binding: the Gateway never exposes
 * the path.
 */
export async function readProjectWorkspace(store, input) {
  if (!input || Object.keys(input).join() !== "projectId") fail("memory_invalid_input");
  const record = await store.readDocument({ key: workspaceDocumentKey(input.projectId) });
  if (!record) return { projectId: input.projectId, configured: false };
  let available = true;
  try {
    available = (await workspaceIdentity(record.value.workspacePath)).workspaceKey === record.value.workspaceKey;
  } catch {
    available = false;
  }
  return { projectId: input.projectId, configured: true, workspacePath: record.value.workspacePath, available };
}

export async function resolveProjectWorkspace(store, projectId) {
  const record = await store.readDocument({ key: workspaceDocumentKey(projectId) });
  if (!record) fail("memory_workspace_required");
  const current = await workspaceIdentity(record.value.workspacePath);
  if (current.workspaceKey !== record.value.workspaceKey || record.value.projectId !== projectId) {
    fail("memory_workspace_conflict");
  }
  return current;
}

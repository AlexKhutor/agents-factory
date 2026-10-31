import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { gatewayRunning, instancePaths, ProjectPackageError } from "./project-package-export.mjs";
import {
  readProjectWorkspace, rebindProjectWorkspace, workspaceDocumentKey, workspaceIdentity,
} from "./project-workspace-binding.mjs";

// Rebinding a project whose agents already worked to another folder (plan
// R36, docs/project-package.md §10). The folder is part of every agent's
// identity: its workspaceKey, its session journal's cwd, and the folder its
// provider files the session under (Claude Code and DeepSeek Harness name it
// after the cwd). A rebind moves all of that together, only on the person's
// confirmation, with the Gateway stopped and no agent of the project working,
// and leaves a receipt. A provider folder that is not where its known naming
// rule puts it refuses the rebind: nothing is guessed.

const RECEIPTS = path.join(".project-local", "rebind-receipts");

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

/** The folder Claude Code files a session's transcript under: every non-alphanumeric character a dash. */
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/gu, "-");
}

/** The folder DeepSeek Harness files a session under; null for a path it was not seen to name. */
export function dshSessionSlug(cwd) {
  if (!/^[A-Za-z0-9_.:\\/-]+$/u.test(cwd)) return null;
  return `--${cwd.replace(/:/gu, "").replace(/[\\/]/gu, "-")}--`;
}

async function writeJsonOver(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, target);
}

/**
 * Rebinds `projectId` to `workspacePath`. `confirm` must name the project.
 * Returns the receipt (also written under .project-local/rebind-receipts).
 */
export async function rebindWorkedProject({ controllerRoot, store, projectId, workspacePath, confirm,
  now = () => new Date(), claudeConfigDir, dshHome }) {
  if (confirm !== projectId) fail("rebind_confirmation_required", projectId);
  const root = await realpath(controllerRoot);
  const current = await readProjectWorkspace(store, { projectId });
  if (!current.configured) return rebindProjectWorkspace(store, { projectId, workspacePath });
  const target = await realpath(workspacePath).catch(() => fail("rebind_folder_missing", workspacePath));
  if (current.workspacePath.toLowerCase() === target.toLowerCase()) {
    return rebindProjectWorkspace(store, { projectId, workspacePath: target });
  }
  const catalog = await store.readDocument({ key: "memory-agents-v1" });
  const agents = (catalog?.value?.agents ?? []).filter((agent) => agent.projectId === projectId);
  // Before any agent worked the plain rebind is enough (and keeps its rules).
  const worked = agents.some((agent) => agent.state !== "archived" || (agent.operations ?? []).length > 0);
  if (!worked) return rebindProjectWorkspace(store, { projectId, workspacePath: target });
  if (agents.some((agent) => agent.currentOperationId)) fail("rebind_project_busy", projectId);
  const paths = await instancePaths(root, projectId, { claudeConfigDir, dshHome });
  if (await gatewayRunning(paths.gatewayStatus)) fail("gateway_running");

  // Every move is planned and checked before the first one.
  const moves = [];
  const journals = [];
  const caches = [];
  for (const agent of agents) {
    const threadId = agent.binding?.threadId;
    if (typeof threadId !== "string") continue;
    for (const folder of [paths.claudeSessions, paths.acpSessions]) {
      const journal = path.join(folder, threadId, "session.json");
      if (!await exists(journal)) continue;
      const session = JSON.parse(await readFile(journal, "utf8"));
      if (typeof session.cwd !== "string" || session.cwd.toLowerCase() !== current.workspacePath.toLowerCase()) {
        fail("rebind_session_elsewhere", `${threadId}: ${session.cwd}`);
      }
      journals.push({ journal, session, threadId });
      const oldCwd = session.cwd;
      const claudeProjects = path.join(paths.claudeConfigDir, "projects");
      for (const name of [`${threadId}.jsonl`, threadId]) {
        for (const slug of await readdir(claudeProjects).catch(() => [])) {
          const from = path.join(claudeProjects, slug, name);
          if (!await exists(from)) continue;
          if (slug !== claudeProjectSlug(oldCwd)) fail("rebind_provider_folder_unknown", from);
          const to = path.join(claudeProjects, claudeProjectSlug(target), name);
          if (await exists(to)) fail("rebind_target_exists", to);
          moves.push({ from, to });
        }
      }
      const dshSessions = path.join(paths.dshHome, "sessions");
      for (const slug of await readdir(dshSessions).catch(() => [])) {
        const from = path.join(dshSessions, slug, threadId);
        if (!await exists(from)) continue;
        const newSlug = dshSessionSlug(target);
        if (slug !== dshSessionSlug(oldCwd) || newSlug === null) fail("rebind_provider_folder_unknown", from);
        const to = path.join(dshSessions, newSlug, threadId);
        if (await exists(to)) fail("rebind_target_exists", to);
        moves.push({ from, to });
      }
      const cache = path.join(paths.dshHome, "storages", "session_projcache", "sessions", `${threadId}.json`);
      if (await exists(cache)) caches.push(cache);
    }
  }

  const done = [];
  try {
    for (const move of moves) {
      await mkdir(path.dirname(move.to), { recursive: true });
      await rename(move.from, move.to);
      done.push(move);
    }
    for (const { journal, session } of journals) await writeJsonOver(journal, { ...session, cwd: target });
    for (const cache of caches) {
      const value = JSON.parse(await readFile(cache, "utf8"));
      if (value?.identity && typeof value.identity.cwd === "string") {
        await writeJsonOver(cache, { ...value, identity: { ...value.identity, cwd: target } });
      }
    }
    // Every agent's key, then the binding, in the store; a failed binding puts the keys back.
    const identity = await workspaceIdentity(target);
    const keyed = { ...catalog.value, agents: catalog.value.agents.map((agent) => (agent.projectId === projectId
      ? { ...agent, workspaceKey: identity.workspaceKey } : agent)) };
    if (!await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: catalog.revision, value: keyed })) {
      fail("rebind_contention");
    }
    const bindingKey = workspaceDocumentKey(projectId);
    const binding = await store.readDocument({ key: bindingKey });
    if (!await store.compareAndSwapDocument({ key: bindingKey, expectedRevision: binding?.revision ?? 0,
      value: { projectId, ...identity } })) {
      const back = await store.readDocument({ key: "memory-agents-v1" });
      await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: back.revision, value: catalog.value });
      fail("rebind_contention");
    }
  } catch (error) {
    for (const move of done.reverse()) await rename(move.to, move.from).catch(() => {});
    for (const { journal, session } of journals) await writeJsonOver(journal, session).catch(() => {});
    throw error;
  }
  const receipt = { schemaVersion: 1, projectId, from: current.workspacePath, to: target,
    agents: agents.map((agent) => agent.agentId), sessions: journals.map((item) => item.threadId),
    moved: moves.map((move) => ({ from: path.relative(root, move.from), to: path.relative(root, move.to) })),
    rebasedAtUtc: now().toISOString() };
  const file = path.join(root, RECEIPTS, `${receipt.rebasedAtUtc.replace(/[-:.]/gu, "")}-${projectId.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { ...receipt, configured: true, changed: true, receipt: file };
}

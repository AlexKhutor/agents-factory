import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createProjectMemoryStore } from "./project-memory-store.mjs";
import { gatewayRunning, ProjectPackageError } from "./project-package-export.mjs";
import { rebindWorkedProject } from "./project-rebind.mjs";
import { readProjectWorkspace } from "./project-workspace-binding.mjs";

// Moving an instance to another path (docs/project-package.md §10): after the
// instance folder was copied or moved, this rewrites what names the old path -
// the provider and control configs, the folder bindings of projects that live
// inside the instance (the world's included, with their agents' sessions, as a
// rebind does), and, when asked, Atlas's config and map - and lists the other
// files that still name it. Gateway stopped; `confirm` repeats the old path.

const CONFIGS = [
  [".project-local", "application-gateway", "claude-provider.json"],
  [".project-local", "application-gateway", "acp-provider.json"],
  [".project-local", "orchestration", "control-cycle.json"],
  [".project-local", "source-bindings.json"],
];
// Receipts name the old path by design: they record the moves.
const SKIP_SCAN = new Set([".git", "node_modules", "backups", "projects", "claude-account", "dsh-home", "claude-sessions",
  "acp-sessions", "conversation-archive", "project-memory", "relocate-receipts", "move-receipts", "rebind-receipts"]);

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

async function exists(target) {
  return lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}

/** The Gateway's and Atlas's identity of an instance path (application-gateway-runtime.mjs). */
export function instancePathHash(root) {
  const resolved = path.resolve(root);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(JSON.stringify({ workspaceRoot: normalized })).digest("hex");
}

/** A path under `from` as the same path under `to`; null for any other value. */
function moved(value, from, to) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  const relative = path.relative(from, value);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative === "" ? to : path.join(to, relative);
}

function rewrite(value, from, to, counter) {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, from, to, counter));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, from, to, counter)]));
  }
  const next = moved(value, from, to);
  if (next === null) return value;
  counter.count += 1;
  return next;
}

async function writeJsonOver(target, value, spaces) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, spaces)}\n`, "utf8");
  await rename(temporary, target);
}

async function filesNaming(root, from) {
  const needles = [from, from.replace(/\\/gu, "/"), from.replace(/\\/gu, "\\\\")].map((item) => item.toLowerCase());
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (SKIP_SCAN.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const info = await lstat(full);
        if (info.size > 2 * 1024 * 1024) continue;
        const text = (await readFile(full, "utf8")).toLowerCase();
        if (needles.some((needle) => text.includes(needle))) found.push(path.relative(root, full));
      }
    }
  };
  await walk(root);
  return found.sort();
}

/** Atlas's config of this instance and its map, keyed by the path hash, follow the move. */
export async function relocateAtlas(atlasConfig, from, to) {
  const config = JSON.parse(await readFile(atlasConfig, "utf8"));
  const oldHash = instancePathHash(from);
  const newHash = instancePathHash(to);
  if (typeof config.controllerRoot === "string" && path.resolve(config.controllerRoot).toLowerCase() !== path.resolve(from).toLowerCase()) {
    fail("relocate_atlas_other_instance", config.controllerRoot);
  }
  const next = { ...config, controllerRoot: to,
    expectedWorkspace: { ...(config.expectedWorkspace ?? {}), workspaceRootSha256: newHash } };
  await writeJsonOver(atlasConfig, next, 2);
  const userData = path.join(path.dirname(path.dirname(atlasConfig)), "user-data");
  const result = { config: atlasConfig, layout: "none", view: "none", seenTurns: "none" };
  // The map of a single-database instance, and the camera (a split instance keeps its map inside).
  for (const [key, suffix] of [["layout", ".json"], ["view", ".view.json"]]) {
    const [oldFile, newFile] = [`live-${oldHash.slice(0, 16)}${suffix}`, `live-${newHash.slice(0, 16)}${suffix}`]
      .map((name) => path.join(userData, "layouts", name));
    if (!await exists(oldFile)) continue;
    if (await exists(newFile)) result[key] = "kept-existing";
    else { await copyFile(oldFile, newFile); result[key] = "copied"; }
  }
  const seen = path.join(userData, "seen-turns.json");
  if (await exists(seen)) {
    const value = JSON.parse(await readFile(seen, "utf8"));
    const [oldKey, newKey] = [`live-${oldHash.slice(0, 16)}`, `live-${newHash.slice(0, 16)}`];
    let changed = false;
    for (const section of ["environments", "answers"]) {
      if (value?.[section]?.[oldKey] && !value[section][newKey]) { value[section][newKey] = value[section][oldKey]; changed = true; }
    }
    if (changed) { await writeJsonOver(seen, value, 0); result.seenTurns = "copied"; }
  }
  return result;
}

/**
 * Rewrites what names `from` in the instance now at `controllerRoot`. Run once
 * the folder is in its new place. Returns what changed and what still names
 * the old path (for the person to look at).
 */
export async function relocateInstance({ controllerRoot, from, confirm, atlasConfig = null, now = () => new Date() }) {
  if (typeof from !== "string" || !path.isAbsolute(from)) fail("relocate_from_invalid");
  if (confirm !== from) fail("relocate_confirmation_required", from);
  const root = await realpath(controllerRoot);
  const old = path.resolve(from);
  if (old.toLowerCase() === root.toLowerCase()) fail("relocate_same_path");
  if (await gatewayRunning(path.join(root, ".project-local", "application-gateway", "status.v1.json"))) fail("gateway_running");

  const configs = [];
  for (const parts of CONFIGS) {
    const file = path.join(root, ...parts);
    if (!await exists(file)) continue;
    const text = await readFile(file, "utf8");
    const counter = { count: 0 };
    const value = rewrite(JSON.parse(text), old, root, counter);
    if (counter.count > 0) {
      await writeJsonOver(file, value, text.includes("\n  ") ? 2 : 0);
      configs.push({ file: parts.join("/"), paths: counter.count });
    }
  }

  // Projects bound to a folder inside the instance follow it, with their sessions.
  const rebound = [];
  const store = await createProjectMemoryStore({ controllerRoot: root });
  try {
    const projects = new Set(["world", ...(await store.listScopes()).scopes.map((scope) => scope.projectId)]);
    for (const projectId of [...projects].sort()) {
      const binding = await readProjectWorkspace(store, { projectId });
      if (!binding.configured) continue;
      const target = moved(binding.workspacePath, old, root);
      if (target === null) continue;
      if (!await exists(target)) { rebound.push({ projectId, from: binding.workspacePath, to: target, state: "folder-missing" }); continue; }
      const receipt = await rebindWorkedProject({ controllerRoot: root, store, projectId, workspacePath: target, confirm: projectId, now });
      rebound.push({ projectId, from: binding.workspacePath, to: target, state: "rebound", sessions: receipt.sessions ?? [] });
    }
  } finally {
    await store.close();
  }
  const atlas = atlasConfig ? await relocateAtlas(path.resolve(atlasConfig), old, root) : null;
  const receipt = { schemaVersion: 1, from: old, to: root, configs, rebound, atlas,
    stillNamingOldPath: await filesNaming(root, old), relocatedAtUtc: now().toISOString() };
  const file = path.join(root, ".project-local", "relocate-receipts", `${receipt.relocatedAtUtc.replace(/[-:.]/gu, "")}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { ...receipt, receipt: file, gatewayHash: instancePathHash(root) };
}

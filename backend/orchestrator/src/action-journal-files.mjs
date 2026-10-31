import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { assertPublicApplicationProjectPath } from "./application-resource-reader.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";

// The previous version of a project file the person saved from Atlas, kept so
// that the save can be undone (action-journal.mjs, the plan's step J3). A copy
// is kept by its SHA-256 in this PC's journal folder
// (.project-local/journal-files/<project hash>/<sha256>), never in the project
// folder; the newest copies of a project are kept (KEPT_FILES), so an old save
// or one made on another PC says its previous version is not here.

export const ACTION_JOURNAL_FILES_VERSION = "v0.1.0";

const MAX_FILE_BYTES = 1_048_576;
const KEPT_FILES = 200;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(code) { throw Object.assign(new Error(code), { code }); }
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function keptFolder(controllerRoot, projectId) {
  return path.join(controllerRoot, ".project-local", "journal-files", sha256(projectId).slice(0, 32));
}

/** The project file at a public path, refused when a part of the path is a link or it leaves the folder. */
async function projectFile(store, projectId, relativePath) {
  assertPublicApplicationProjectPath(relativePath);
  const workspace = await resolveProjectWorkspace(store, projectId);
  const root = await realpath(workspace.workspacePath);
  let candidate = root;
  for (const segment of relativePath.split("/")) {
    candidate = path.join(candidate, segment);
    const info = await lstat(candidate).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (info?.isSymbolicLink()) fail("journal_file_refused");
  }
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("journal_file_refused");
  return candidate;
}

async function readSmallFile(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) fail("journal_file_refused");
  return readFile(file);
}

/** Keeps at most KEPT_FILES copies of a project, the newest. */
async function prune(folder) {
  const names = (await readdir(folder)).filter((name) => SHA256.test(name));
  if (names.length <= KEPT_FILES) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(folder, name))).mtimeMs })));
  dated.sort((a, b) => a.at - b.at);
  for (const { name } of dated.slice(0, dated.length - KEPT_FILES)) await rm(path.join(folder, name), { force: true });
}

/**
 * Keeps the file's current bytes when they are the version `expectedSha256`
 * names (the one a save is about to replace). Returns its SHA-256, or null
 * when nothing was kept (another version, no file, too large).
 */
export async function keepPreviousFile({ controllerRoot, store, projectId, relativePath, expectedSha256 }) {
  const file = await projectFile(store, projectId, relativePath);
  const bytes = await readSmallFile(file);
  const hash = sha256(bytes);
  if (hash !== expectedSha256) return null;
  const folder = keptFolder(controllerRoot, projectId);
  await mkdir(folder, { recursive: true });
  const target = path.join(folder, hash);
  const exists = await stat(target).then(() => true, () => false);
  if (!exists) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  }
  await prune(folder);
  return hash;
}

/**
 * Puts the kept version `sha256` back while the file is still the version
 * `expectSha256` the save left (journal_undo_stale otherwise). The kept copy
 * stays (it may be wanted again).
 */
export async function restoreKeptFile({ controllerRoot, store, projectId, relativePath, sha256: kept, expectSha256 }) {
  if (!SHA256.test(kept) || !SHA256.test(expectSha256)) fail("journal_invalid_entry");
  const file = await projectFile(store, projectId, relativePath);
  const current = await readSmallFile(file);
  if (sha256(current) !== expectSha256) fail("journal_undo_stale");
  const copy = await readFile(path.join(keptFolder(controllerRoot, projectId), kept))
    .catch((error) => (error.code === "ENOENT" ? fail("journal_undo_file_not_here") : Promise.reject(error)));
  if (sha256(copy) !== kept) fail("journal_undo_file_not_here");
  const mode = (await stat(file)).mode & 0o777;
  const temporary = path.join(path.dirname(file), `.journal-undo-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(copy); await handle.sync(); } finally { await handle.close(); }
    // The file is checked once more just before it is replaced.
    if (sha256(await readSmallFile(file)) !== expectSha256) fail("journal_undo_stale");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return { path: relativePath, sha256: kept };
}

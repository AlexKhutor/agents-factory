import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { ApplicationContractError, validateApplicationPayloadPrivacy } from "./application-contract.mjs";
import { assertPublicApplicationProjectPath } from "./application-resource-reader.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";

export const APPLICATION_PROJECT_WORKSPACE_SAVE_VERSION = "v0.1.0";
export const APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION = "mutation.project-workspace.save";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 1_048_576;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

function fail(code) { throw new ApplicationContractError(code, "Project file save refused"); }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function inputValue(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join() !== "expectedSha256,operationId,path,projectId,text"
      || !ID.test(value.projectId ?? "") || !ID.test(value.operationId ?? "")
      || !SHA256.test(value.expectedSha256 ?? "")) fail("conflict");
  assertPublicApplicationProjectPath(value.path);
  if (value.path.length > 256 || typeof value.text !== "string"
      || Buffer.byteLength(value.text, "utf8") > MAX_FILE_BYTES
      || CONTROL.test(value.text)) fail("access_denied");
  const bytes = Buffer.from(value.text, "utf8");
  // The byte-order mark a read keeps is saved back as it was.
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== value.text) {
    fail("access_denied");
  }
  validateApplicationPayloadPrivacy(value, { zone: "request-input",
    operationId: APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION });
  return bytes;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function fileIdentity(root, relativePath) {
  const canonicalRoot = await realpath(root);
  let candidate = canonicalRoot;
  for (const segment of relativePath.split("/")) {
    candidate = path.join(candidate, segment);
    if ((await lstat(candidate)).isSymbolicLink()) fail("access_denied");
  }
  const canonical = await realpath(candidate);
  if (!inside(canonicalRoot, canonical) || !(await lstat(candidate)).isFile()) {
    fail("access_denied");
  }
  return { candidate, canonical };
}

async function currentBytes(root, relativePath) {
  const target = await fileIdentity(root, relativePath);
  const before = await lstat(target.candidate);
  if (before.size > MAX_FILE_BYTES) fail("access_denied");
  const bytes = await readFile(target.candidate);
  const after = await lstat(target.candidate);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || (await realpath(target.candidate)) !== target.canonical) fail("stale_revision");
  return { target: target.candidate, bytes, mode: before.mode };
}

function safeError(error) {
  if (error instanceof ApplicationContractError) return error;
  const code = ["EACCES", "EPERM", "ELOOP"].includes(error?.code) ? "access_denied"
    : ["EBUSY", "EEXIST"].includes(error?.code) ? "writer_busy" : "source_unavailable";
  return new ApplicationContractError(code, "Project file save refused");
}

export function createApplicationProjectWorkspaceSaveHandler({ store, readProject,
  now = () => new Date() } = {}) {
  if (!store || typeof readProject !== "function" || typeof now !== "function") {
    throw new TypeError("Project workspace save requires store, read path and clock");
  }
  const writers = new Set();
  return async (request) => {
    let key = null, temporary = null, claimed = false;
    try {
      const input = request?.input;
      const bytes = inputValue(input);
      const workspace = await resolveProjectWorkspace(store, input.projectId);
      key = `${workspace.workspaceKey}:${input.path.toLowerCase()}`;
      if (writers.has(key)) fail("writer_busy");
      writers.add(key);
      claimed = true;
      const read = await readProject({ input: { projectId: input.projectId, path: input.path },
        requestId: request?.requestId, correlationId: request?.correlationId });
      if (read.contentSha256 !== input.expectedSha256) fail("stale_revision");
      const prior = await currentBytes(workspace.workspacePath, input.path);
      if (digest(prior.bytes) !== input.expectedSha256) fail("stale_revision");
      temporary = path.join(path.dirname(prior.target), `.r2-save-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", prior.mode & 0o777);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const beforeReplace = await currentBytes(workspace.workspacePath, input.path);
      if (beforeReplace.target !== prior.target
          || digest(beforeReplace.bytes) !== input.expectedSha256
          || (await resolveProjectWorkspace(store, input.projectId)).workspaceKey !== workspace.workspaceKey) {
        fail("stale_revision");
      }
      await rename(temporary, prior.target);
      temporary = null;
      if (digest((await currentBytes(workspace.workspacePath, input.path)).bytes) !== digest(bytes)) {
        fail("uncertain_outcome");
      }
      const receipt = { schemaVersion: 1, contractVersion: APPLICATION_PROJECT_WORKSPACE_SAVE_VERSION,
        projectId: input.projectId, path: input.path, operationId: input.operationId,
        previousSha256: input.expectedSha256, contentSha256: digest(bytes),
        bytesWritten: bytes.length, completedAtUtc: now().toISOString() };
      validateApplicationPayloadPrivacy(receipt, { zone: "result-output",
        operationId: APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION });
      return receipt;
    } catch (error) { throw safeError(error); }
    finally {
      if (temporary !== null) await rm(temporary, { force: true }).catch(() => {});
      if (claimed) writers.delete(key);
    }
  };
}

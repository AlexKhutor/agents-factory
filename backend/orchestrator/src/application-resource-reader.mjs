import { createHash } from "node:crypto";
import path from "node:path";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";

import { applicationCanonicalJson, ApplicationContractError } from "./application-contract.mjs";
import { validateApplicationArtifactResourceQuery } from "./application-artifact-resource.mjs";
import { validateApplicationProjectResourceQuery } from "./application-project-resource.mjs";
import { createApplicationResourceReadResult } from "./application-resource-read-result.mjs";
import {
  assertApplicationResourcePolicy,
  createApplicationResourceReadPolicy,
} from "./application-resource-read-policy.mjs";

export const APPLICATION_RESOURCE_READER_VERSION = "v0.4.0";
export const APPLICATION_RESOURCE_READER_LIMITS = Object.freeze({
  maxFileBytes: 1_048_576,
  maxDirectoryEntries: 4_096,
});

const FORBIDDEN_SEGMENTS = new Set([
  ".git", ".project-context", ".project-local", ".project-runtime", "node_modules",
]);
const FORBIDDEN_NAMES = [
  /^\.env(?:\.|$)/iu,
  /^(?:auth|credentials?|secrets?|tokens?)\.json$/iu,
  /^(?:state(?:_\d+)?\.sqlite|session_index\.jsonl)$/iu,
  /^rollout-.*\.jsonl$/iu,
  /\.(?:key|p12|pfx|pem)$/iu,
];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/u,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u,
  /data:(?:image|audio|video)\//iu,
];
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(code, message, details = {}) {
  throw new ApplicationContractError(code, message, details);
}

export function normalizeApplicationResourceReadError(error) {
  if (error instanceof ApplicationContractError) return error;
  if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
    return new ApplicationContractError(
      "source_unavailable",
      "resource is deleted, renamed, or otherwise unavailable",
    );
  }
  if (["EACCES", "EPERM"].includes(error?.code)) {
    return new ApplicationContractError("access_denied", "resource is inaccessible");
  }
  if (["EBUSY", "EMFILE", "ENFILE"].includes(error?.code)) {
    return new ApplicationContractError("source_unavailable", "resource reader is temporarily unavailable");
  }
  return error;
}

async function normalizedRead(operation) {
  try {
    return await operation();
  } catch (error) {
    throw normalizeApplicationResourceReadError(error);
  }
}

function portable(value) {
  return value.split(path.sep).join("/");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512
      || path.isAbsolute(value) || value.includes("\\") || value.includes(":")
      || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("access_denied", "resource path must be a safe project-relative path");
  }
  const segments = value.toLowerCase().split("/");
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))
      || FORBIDDEN_NAMES.some((pattern) => pattern.test(segments.at(-1)))) {
    fail("access_denied", "resource path is in a private or secret-bearing store");
  }
  return value;
}

function decodeText(bytes) {
  let text;
  try {
    // A byte-order mark stays in the text: the text is exactly its bytes (a file saved by Notepad
    // begins with one, and a stripped mark left the read refused against its own byte range).
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("access_denied", "resource is not valid UTF-8 text");
  }
  if (/\u0000/u.test(text) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    fail("access_denied", "binary or control-character content is not readable");
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("access_denied", "secret or inline private content is not readable");
  }
  return text;
}

function mediaType(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if ([".md", ".markdown"].includes(extension)) return "text/markdown";
  return "text/plain";
}

function statIdentity(value) {
  return [value.dev, value.ino, value.size, value.mtimeMs].join(":");
}

async function resolveRegisteredPath(policy, relativePath, expectedKind, allowRoot = false) {
  if (!(allowRoot && relativePath === "")) safeRelative(relativePath);
  let candidate = policy.canonicalRoot;
  for (const segment of relativePath === "" ? [] : relativePath.split("/")) {
    candidate = path.join(candidate, segment);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) fail("access_denied", "symbolic or reparse paths are not readable");
  }
  const canonical = await realpath(candidate);
  if (!inside(policy.canonicalRoot, canonical)) fail("access_denied", "resource escapes its registered root");
  const info = await lstat(candidate);
  if ((expectedKind === "file" && !info.isFile())
      || (expectedKind === "directory" && !info.isDirectory())) {
    fail("source_unavailable", `resource is not a ${expectedKind}`);
  }
  return { candidate, canonical, info };
}

async function readStableFile(policy, relativePath) {
  const resolved = await resolveRegisteredPath(policy, relativePath, "file");
  if (resolved.info.size > APPLICATION_RESOURCE_READER_LIMITS.maxFileBytes) {
    fail("access_denied", "resource exceeds the bounded file size");
  }
  const handle = await open(resolved.candidate, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(resolved.info)) {
      fail("stale_revision", "resource changed while it was opened");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) fail("stale_revision", "resource ended during the bounded read");
      offset += read.bytesRead;
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(resolved.candidate);
    const afterCanonical = await realpath(resolved.candidate);
    if (statIdentity(afterHandle) !== statIdentity(opened)
        || statIdentity(afterPath) !== statIdentity(opened)
        || afterCanonical !== resolved.canonical) {
      fail("stale_revision", "resource changed during the bounded read");
    }
    return { bytes, size: opened.size, sha256: digest(bytes) };
  } finally {
    await handle.close();
  }
}

async function readStableDirectory(policy, relativePath, publicOnly = false) {
  const resolved = await resolveRegisteredPath(policy, relativePath, "directory", publicOnly);
  const collect = async () => {
    const items = await readdir(resolved.candidate, { withFileTypes: true });
    if (items.length > APPLICATION_RESOURCE_READER_LIMITS.maxDirectoryEntries) {
      fail("access_denied", "directory exceeds the bounded entry count");
    }
    const entries = []; let omissionCount = 0;
    for (const item of items.sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ))) {
      if (publicOnly) {
        try { assertPublicApplicationProjectPath(item.name); }
        catch { omissionCount++; continue; }
      }
      if (item.isSymbolicLink()) fail("access_denied", "directory contains a symbolic or reparse entry");
      if (!item.isFile() && !item.isDirectory()) fail("access_denied", "directory contains an unsupported entry");
      const child = await lstat(path.join(resolved.candidate, item.name));
      if (child.isSymbolicLink()) fail("access_denied", "directory entry changed to a link");
      entries.push({
        name: item.name,
        kind: item.isDirectory() ? "directory" : "file",
        sizeBytes: item.isFile() ? child.size : null,
        contentSha256: null,
      });
    }
    return { entries, omissionCount };
  };
  const collected = await collect();
  const repeated = await collect();
  if (applicationCanonicalJson(collected) !== applicationCanonicalJson(repeated)
      || statIdentity(await lstat(resolved.candidate)) !== statIdentity(resolved.info)
      || (await realpath(resolved.candidate)) !== resolved.canonical) {
    fail("stale_revision", "directory changed during the bounded read");
  }
  const bytes = Buffer.from(applicationCanonicalJson(publicOnly ? collected : collected.entries), "utf8");
  return { ...collected, bytes, sha256: digest(bytes) };
}

// Project workspace browsing is stricter than registered controller resources:
// no hidden configuration/store segments or Windows trailing-dot/space aliases.
export function assertPublicApplicationProjectPath(value) {
  safeRelative(value);
  if (value.split("/").some((segment) => segment.startsWith(".") || /[. ]$/u.test(segment))) {
    fail("access_denied", "private or aliased project path is not readable");
  }
  return value;
}

export async function readPublicApplicationProjectDirectory(rootPath, relativePath = "") {
  return normalizedRead(async () => {
    if (relativePath !== "") assertPublicApplicationProjectPath(relativePath);
    const info = await lstat(rootPath);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("access_denied", "project root is not a real directory");
    const canonicalRoot = await realpath(rootPath);
    const result = await readStableDirectory({ canonicalRoot }, relativePath, true);
    if ((await realpath(rootPath)) !== canonicalRoot) fail("stale_revision", "project root changed");
    return { entries: result.entries, omissionCount: result.omissionCount, contentSha256: result.sha256 };
  });
}

function verifyContentIdentity(request, actualSha256) {
  if (!SHA256.test(actualSha256)) fail("source_unavailable", "resource content hash is unavailable");
  const expected = request.resource.contentSha256;
  if ((expected !== undefined && expected !== actualSha256)
      || (request.resource.revision.kind === "sha256"
        && request.resource.revision.value !== actualSha256)) {
    fail("stale_revision", "resource content differs from the requested revision");
  }
}

function readAt(now) {
  const value = now().toISOString();
  if (!value.endsWith("Z")) fail("source_unavailable", "reader clock is not UTC");
  return value;
}

export class ApplicationResourceReader {
  static async create({ policies, now = () => new Date() } = {}) {
    if (!Array.isArray(policies) || policies.length < 1 || policies.length > 32) {
      fail("access_denied", "resource reader requires bounded registered policies");
    }
    const resolved = [];
    for (const definition of policies) resolved.push(await createApplicationResourceReadPolicy(definition));
    const identities = new Set();
    for (const policy of resolved) {
      const identity = `${policy.scope}:${policy.rootId}:${policy.readPolicyId}`;
      if (identities.has(identity)) fail("access_denied", "resource read policy is duplicated");
      identities.add(identity);
    }
    return new ApplicationResourceReader({ policies: resolved, now });
  }

  constructor({ policies, now }) {
    this.policies = policies;
    this.now = now;
  }

  #artifactPolicy(request) {
    const matches = this.policies.filter((policy) => policy.scope === "artifact"
      && policy.authorityTypes.includes(request.resource.authority.authorityType));
    if (matches.length !== 1) fail("access_denied", "artifact root policy is unavailable or ambiguous");
    return assertApplicationResourcePolicy(matches[0], request);
  }

  #projectPolicy(request) {
    const matches = this.policies.filter((policy) => policy.scope === "project"
      && policy.rootId === request.rootId && policy.readPolicyId === request.readPolicyId);
    if (matches.length !== 1) fail("access_denied", "project root policy is unavailable or ambiguous");
    return assertApplicationResourcePolicy(matches[0], request);
  }

  async readArtifact(request) {
    return normalizedRead(async () => {
      validateApplicationArtifactResourceQuery(request);
      const policy = this.#artifactPolicy(request);
      const observed = await readStableFile(policy, request.resource.nativeId);
      verifyContentIdentity(request, observed.sha256);
      const text = decodeText(observed.bytes);
      return createApplicationResourceReadResult(request, {
        sourceBinding: policy.sourceBinding,
        contentSha256: observed.sha256,
        mediaType: mediaType(request.resource.nativeId),
        encoding: "utf-8",
        range: { offsetBytes: 0, returnedBytes: observed.size, totalBytes: observed.size },
        page: { unit: "bytes", offset: 0, returned: observed.size, total: observed.size },
        truncated: false,
        readAtUtc: readAt(this.now),
        payload: { kind: "text", text },
      });
    });
  }

  async readProject(request) {
    return this.readProjectPage(request);
  }

  async readProjectPage(request, page = {}) {
    return normalizedRead(async () => {
      if (!page || typeof page !== "object" || Array.isArray(page)
          || Object.keys(page).some((field) => !["offsetBytes", "entryIndex"].includes(field))) {
        fail("access_denied", "resource page contains unsupported fields");
      }
      validateApplicationProjectResourceQuery(request);
      if (request.resource.authority.authorityType !== "child-workspace") {
        fail("unsupported_capability", "filesystem reads require child-workspace authority");
      }
      const policy = this.#projectPolicy(request);
      if (request.resource.resourceKind === "project-directory") {
        if (page.offsetBytes !== undefined) fail("access_denied", "directory page cannot use byte offset");
        const entryIndex = page.entryIndex ?? 0;
        if (!Number.isSafeInteger(entryIndex) || entryIndex < 0) {
          fail("access_denied", "directory entry cursor is invalid");
        }
        return this.#readProjectDirectory(request, policy, entryIndex);
      }
      const observed = await readStableFile(policy, request.resource.nativeId);
      verifyContentIdentity(request, observed.sha256);
      const text = decodeText(observed.bytes);
      if (request.view === "metadata") {
        if (Object.keys(page).length > 0) fail("access_denied", "metadata reads cannot be paged");
        return createApplicationResourceReadResult(request, {
          sourceBinding: policy.sourceBinding,
          contentSha256: observed.sha256,
          mediaType: "application/vnd.isolate-vscode.metadata+json",
          encoding: "none",
          range: { offsetBytes: 0, returnedBytes: 0, totalBytes: observed.size },
          page: { unit: "bytes", offset: 0, returned: 0, total: observed.size },
          truncated: observed.size > 0,
          readAtUtc: readAt(this.now),
          payload: { kind: "metadata" },
        });
      }
      if (page.entryIndex !== undefined) fail("access_denied", "file page cannot use entry cursor");
      const maximumBytes = request.slice.maximumBytes;
      const offsetBytes = page.offsetBytes ?? request.slice.offsetBytes;
      if (!Number.isSafeInteger(offsetBytes) || offsetBytes < request.slice.offsetBytes) {
        fail("access_denied", "file page cannot precede the requested byte offset");
      }
      if (offsetBytes > observed.size) fail("stale_revision", "slice offset exceeds resource size");
      let end = Math.min(observed.size, offsetBytes + maximumBytes);
      while (end < observed.size && end > offsetBytes && (observed.bytes[end] & 0xc0) === 0x80) end--;
      if (end === offsetBytes && offsetBytes < observed.size) {
        fail("access_denied", "slice bound cannot hold the next UTF-8 code point");
      }
      const slice = observed.bytes.subarray(offsetBytes, end);
      const sliceText = decodeText(slice);
      return createApplicationResourceReadResult(request, {
        sourceBinding: policy.sourceBinding,
        contentSha256: observed.sha256,
        mediaType: mediaType(request.resource.nativeId),
        encoding: "utf-8",
        range: { offsetBytes, returnedBytes: slice.length, totalBytes: observed.size },
        page: { unit: "bytes", offset: offsetBytes, returned: slice.length, total: observed.size },
        truncated: offsetBytes + slice.length < observed.size,
        readAtUtc: readAt(this.now),
        payload: { kind: "text", text: sliceText },
      });
    });
  }

  async #readProjectDirectory(request, policy, entryIndex) {
    const observed = await readStableDirectory(policy, request.resource.nativeId);
    verifyContentIdentity(request, observed.sha256);
    if (entryIndex > observed.entries.length) {
      fail("stale_revision", "directory cursor exceeds the current entry count");
    }
    const entries = observed.entries.slice(entryIndex, entryIndex + (request.maxEntries ?? 0));
    const returnedBytes = Buffer.byteLength(applicationCanonicalJson(entries), "utf8");
    return createApplicationResourceReadResult(request, {
      sourceBinding: policy.sourceBinding,
      contentSha256: observed.sha256,
      mediaType: "application/vnd.isolate-vscode.directory+json",
      encoding: "utf-8",
      range: { offsetBytes: 0, returnedBytes, totalBytes: observed.bytes.length },
      page: {
        unit: "entries",
        offset: entryIndex,
        returned: entries.length,
        total: observed.entries.length,
      },
      truncated: entryIndex + entries.length < observed.entries.length,
      readAtUtc: readAt(this.now),
      payload: { kind: "directory-summary", entries },
    });
  }
}

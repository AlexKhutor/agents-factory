import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

// Memory documents: an agent writes notes into a file of its project folder,
// the person reads the exact file and approves it in the desk, and then the
// notes go into a memory exactly as approved.
//
// The approval is the memory store's own grant (authorize-write): which scope,
// at which revision, and the hash of the exact entries; the write happens only
// while the document and the memory are still what was approved, and a grant
// is used once. Code does the writing - the agent's tool or the person's
// button only start it.

export const MEMORY_DOCUMENTS_VERSION = "v0.1.0";
export const MEMORY_DOCUMENT_LIMITS = Object.freeze({ bytes: 256 * 1024, entries: 64, entryBytes: 65_536, pathLength: 512 });

function fail(code) { throw Object.assign(new Error(code), { code }); }

/** A document path from the root of the project folder: forward slashes, no "./", no way out. */
export function normalizeDocumentPath(value) {
  if (typeof value !== "string") fail("memory_document_path_invalid");
  const relative = value.trim().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
  if (relative === "" || relative.length > MEMORY_DOCUMENT_LIMITS.pathLength
      || /[\u0000-\u001f\u007f]/u.test(relative) || /^[A-Za-z]:/u.test(relative) || relative.startsWith("/")
      || relative.split("/").some((part) => part === ".." || part === "")) fail("memory_document_path_invalid");
  return relative;
}

/** Reads a document of the project folder; never follows a link out of it. */
export async function readMemoryDocument(root, value) {
  const relative = normalizeDocumentPath(value);
  const canonicalRoot = await realpath(root);
  const target = path.resolve(canonicalRoot, ...relative.split("/"));
  let info;
  try { info = await lstat(target); } catch { fail("memory_document_missing"); }
  if (!info.isFile() || info.isSymbolicLink()) fail("memory_document_not_a_file");
  if (info.size > MEMORY_DOCUMENT_LIMITS.bytes) fail("memory_document_too_large");
  const canonical = await realpath(target);
  const inside = path.relative(canonicalRoot, canonical);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) fail("memory_document_path_invalid");
  const bytes = await readFile(canonical);
  return { path: relative, text: bytes.toString("utf8"), bytes: bytes.length,
    contentSha256: createHash("sha256").update(bytes).digest("hex") };
}

// Stores no document is written into: the same the Gateway's reader keeps closed.
const PRIVATE_SEGMENTS = new Set([".git", ".project-context", ".project-local", ".project-runtime", "node_modules"]);

/**
 * A memory as a document: a "# title" line, then each entry as "## title" and its text. A line of
 * an entry's text that would read as a heading gets one space before it, which reading it back
 * takes away: the document reads back into the same entries (entriesFromDocument).
 */
export function documentFromEntries(title, entries) {
  const lines = [`# ${title}`, ""];
  for (const entry of entries) {
    lines.push(`## ${String(entry.title ?? "").replace(/\s+/gu, " ").trim() || "Entry"}`);
    for (const line of String(entry.text ?? "").replace(/\r\n?/gu, "\n").split("\n")) {
      lines.push(/^#/u.test(line) ? ` ${line}` : line);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Writes a memory document (a .md file) into the project folder for the person's text editor:
 * never through a link, never out of the folder or into a private store. A file already there is
 * kept unless it is the same text or `replace` is set (memory_document_exists). Returns
 * { path, state: "written" | "same" | "replaced", contentSha256, bytes, filePath }.
 */
export async function writeMemoryDocument(root, value, text, { replace = false } = {}) {
  const relative = normalizeDocumentPath(value);
  const parts = relative.split("/");
  if (!/\.md$/iu.test(relative) || parts.some((part) => PRIVATE_SEGMENTS.has(part.toLowerCase()))) {
    fail("memory_document_path_invalid");
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MEMORY_DOCUMENT_LIMITS.bytes) fail("memory_document_too_large");
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let info = null;
    try { info = await lstat(current); } catch { /* made just below */ }
    if (info === null) await mkdir(current);
    else if (!info.isDirectory() || info.isSymbolicLink()) fail("memory_document_path_invalid");
  }
  const target = path.join(current, parts.at(-1));
  let existing = null;
  let info = null;
  try { info = await lstat(target); } catch { /* a new file */ }
  if (info !== null) {
    if (!info.isFile() || info.isSymbolicLink()) fail("memory_document_not_a_file");
    existing = await readFile(target);
  }
  const answer = (state) => ({ path: relative, state, contentSha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length, filePath: target });
  if (existing !== null && existing.equals(bytes)) return answer("same");
  if (existing !== null && !replace) fail("memory_document_exists");
  await writeFile(target, bytes);
  return answer(existing === null ? "written" : "replaced");
}

/**
 * The document as memory entries: every "## heading" starts an entry with that
 * title; text before the first one is an entry titled after the file. A
 * "# title" line names the document and is not an entry of its own.
 */
export function entriesFromDocument(text, fallbackTitle) {
  const parts = [];
  let title = null;
  let body = [];
  const flush = () => {
    const said = body.join("\n").trim();
    if (said !== "") parts.push({ title: title ?? fallbackTitle, text: said });
  };
  for (const line of String(text).replace(/\r\n/gu, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null) {
      flush();
      title = heading[1];
      body = [];
    } else if (!/^#\s+/u.test(line)) {
      // " #..." is a line of text that would read as a heading (documentFromEntries).
      body.push(line.replace(/^ (?=#)/u, ""));
    }
  }
  flush();
  if (parts.length === 0) fail("memory_document_empty");
  if (parts.length > MEMORY_DOCUMENT_LIMITS.entries) fail("memory_document_too_many_entries");
  return parts.map((part, index) => {
    if (Buffer.byteLength(part.text, "utf8") > MEMORY_DOCUMENT_LIMITS.entryBytes) fail("memory_document_too_large");
    return { id: `part-${index + 1}`, title: part.title.slice(0, 512) || fallbackTitle, text: part.text };
  });
}

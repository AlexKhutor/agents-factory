import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { documentFromEntries, entriesFromDocument, normalizeDocumentPath, readMemoryDocument, writeMemoryDocument }
  from "../src/memory-documents.mjs";

test("a memory document becomes one entry per second-level heading", () => {
  assert.deepEqual(entriesFromDocument("# Solver\nIntro line.\n\n## Owners\nme\r\n## Style ##\nshort\n", "solver.md"), [
    { id: "part-1", title: "solver.md", text: "Intro line." },
    { id: "part-2", title: "Owners", text: "me" },
    { id: "part-3", title: "Style", text: "short" },
  ]);
  assert.throws(() => entriesFromDocument("# Only a title\n\n## Empty\n", "x.md"), { code: "memory_document_empty" });
  const many = Array.from({ length: 65 }, (_, index) => `## E${index}\ntext`).join("\n");
  assert.throws(() => entriesFromDocument(many, "x.md"), { code: "memory_document_too_many_entries" });
});

test("a memory written as a document reads back into the same entries", () => {
  const entries = [{ title: "Owners", text: "Solver: solver.\n# not a heading\n## nor this" }, { title: "Style", text: "Short." }];
  const text = documentFromEntries("Memory of agent nova", entries);
  assert.match(text, /^# Memory of agent nova\n\n## Owners\n/u);
  assert.match(text, /\n # not a heading\n ## nor this\n/u, "a line that would read as a heading gets a space");
  assert.deepEqual(entriesFromDocument(text, "nova.md").map(({ title, text: said }) => ({ title, text: said })), entries);
});

test("a memory document is written into the project folder for the person's editor, a different file kept", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-document-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await writeMemoryDocument(root, "docs/memory/nova.md", "# M\n\n## A\ntext\n");
  assert.deepEqual([first.path, first.state, first.bytes], ["docs/memory/nova.md", "written", 15]);
  assert.equal(await readFile(path.join(root, "docs", "memory", "nova.md"), "utf8"), "# M\n\n## A\ntext\n");
  assert.equal((await writeMemoryDocument(root, "docs/memory/nova.md", "# M\n\n## A\ntext\n")).state, "same");
  await writeFile(path.join(root, "docs", "memory", "nova.md"), "## A\nedited by hand\n");
  await assert.rejects(writeMemoryDocument(root, "docs/memory/nova.md", "# M\n"), { code: "memory_document_exists" });
  assert.equal(await readFile(path.join(root, "docs", "memory", "nova.md"), "utf8"), "## A\nedited by hand\n", "kept");
  assert.equal((await writeMemoryDocument(root, "docs/memory/nova.md", "# M\n", { replace: true })).state, "replaced");
  for (const broken of ["docs/memory/nova.txt", ".git/memory.md", "../out.md", "node_modules/x.md"]) {
    await assert.rejects(writeMemoryDocument(root, broken, "# M\n"), { code: "memory_document_path_invalid" }, broken);
  }
  const outside = await mkdtemp(path.join(os.tmpdir(), "memory-document-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  let linked = true;
  try { await symlink(outside, path.join(root, "linked"), "junction"); } catch { linked = false; }
  if (linked) await assert.rejects(writeMemoryDocument(root, "linked/x.md", "# M\n"), { code: "memory_document_path_invalid" });
});

test("a document path stays inside the project folder", async (t) => {
  assert.equal(normalizeDocumentPath(" .\\docs\\memory\\a.md "), "docs/memory/a.md");
  for (const broken of ["", "../a.md", "docs/../../a.md", "C:/a.md", "/etc/a.md", "docs//a.md", 7]) {
    assert.throws(() => normalizeDocumentPath(broken), { code: "memory_document_path_invalid" }, String(broken));
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-document-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "a.md"), "## A\ntext\n");
  const document = await readMemoryDocument(root, "docs/a.md");
  assert.equal(document.bytes, 10);
  assert.match(document.contentSha256, /^[0-9a-f]{64}$/u);
  await assert.rejects(readMemoryDocument(root, "docs/missing.md"), { code: "memory_document_missing" });
  await assert.rejects(readMemoryDocument(root, "docs"), { code: "memory_document_not_a_file" });
  await writeFile(path.join(root, "docs", "big.md"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(readMemoryDocument(root, "docs/big.md"), { code: "memory_document_too_large" });
});

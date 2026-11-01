import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { bindProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { createApplicationProjectWorkspaceHandlers } from "../src/application-project-workspace.mjs";
import { createApplicationProjectWorkspaceSaveHandler } from "../src/application-project-workspace-save.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-workspace-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "notes.md"), "first\n");
  const docs = new Map();
  const store = { async readDocument({ key }) { return structuredClone(docs.get(key) ?? null); },
    async compareAndSwapDocument({ key, expectedRevision, value }) {
      if ((docs.get(key)?.revision ?? 0) !== expectedRevision) return false;
      docs.set(key, { revision: expectedRevision + 1, value: structuredClone(value) }); return true;
    } };
  await bindProjectWorkspace(store, { projectId: "project-a", workspacePath: root });
  const reads = createApplicationProjectWorkspaceHandlers({ store, sourceId: "controller",
    instanceId: "runtime-one" });
  const read = (file) => reads["query.project-workspace.read"]({ input: {
    projectId: "project-a", path: file } });
  const save = createApplicationProjectWorkspaceSaveHandler({ store,
    readProject: reads["query.project-workspace.read"] });
  return { root, store, read, save, input: { projectId: "project-a", path: "docs/notes.md",
    operationId: "save-one" } };
}

test("existing UTF-8 file saves only against its exact read hash and returns a bounded receipt", async (t) => {
  const f = await fixture(t);
  const old = await f.read("docs/notes.md");
  const input = { ...f.input, expectedSha256: old.contentSha256, text: "changed\n" };
  const receipt = await f.save({ input });
  assert.equal(receipt.operationId, "save-one");
  assert.equal(receipt.previousSha256, old.contentSha256);
  assert.equal(receipt.contentSha256, (await f.read("docs/notes.md")).contentSha256);
  assert.equal(await readFile(path.join(f.root, "docs", "notes.md"), "utf8"), "changed\n");
  assert.doesNotMatch(JSON.stringify(receipt), /changed|project-workspace-save-/);
  await assert.rejects(f.save({ input }), { code: "stale_revision" });
  await writeFile(path.join(f.root, "docs", "notes.md"), "external edit\n");
  await assert.rejects(f.save({ input: { ...input, expectedSha256: receipt.contentSha256 } }),
    { code: "stale_revision" });
  assert.equal(await readFile(path.join(f.root, "docs", "notes.md"), "utf8"), "external edit\n");
});

test("a file that begins with a UTF-8 byte-order mark reads and saves with the mark kept", async (t) => {
  const f = await fixture(t);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await writeFile(path.join(f.root, "docs", "notes.md"), Buffer.concat([bom, Buffer.from("hello\r\n")]));
  const old = await f.read("docs/notes.md");
  assert.equal(old.text, "\ufeffhello\r\n");
  await f.save({ input: { ...f.input, expectedSha256: old.contentSha256, text: "\ufeffchanged\r\n" } });
  assert.deepEqual(await readFile(path.join(f.root, "docs", "notes.md")),
    Buffer.concat([bom, Buffer.from("changed\r\n")]));
});

test("save rejects unsafe path, reparse, binary and oversized source before writer entry", async (t) => {
  const f = await fixture(t);
  const old = await f.read("docs/notes.md");
  const input = { ...f.input, expectedSha256: old.contentSha256, text: "replacement" };
  for (const name of ["../notes.md", ".env", "docs/../notes.md", "C:/secret"]) {
    await assert.rejects(f.save({ input: { ...input, path: name } }), { code: "access_denied" });
  }
  await symlink(path.join(f.root, "docs"), path.join(f.root, "link"), "junction");
  await assert.rejects(f.save({ input: { ...input, path: "link/notes.md" } }),
    { code: "access_denied" });
  await writeFile(path.join(f.root, "docs", "binary.txt"), Buffer.from([0, 1, 2]));
  await assert.rejects(f.save({ input: { ...input, path: "docs/binary.txt" } }),
    { code: "access_denied" });
  await writeFile(path.join(f.root, "docs", "large.txt"), "x".repeat(1_048_577));
  await assert.rejects(f.save({ input: { ...input, path: "docs/large.txt" } }),
    { code: "access_denied" });
  assert.equal(await readFile(path.join(f.root, "docs", "notes.md"), "utf8"), "first\n");
});

test("portable save schema accepts its real receipt and rejects missing preconditions", async (t) => {
  const f = await fixture(t);
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL(
    "../schemas/application-project-workspace-save.schema.json", import.meta.url), "utf8"));
  ajv.addSchema(schema);
  const requestCheck = ajv.compile({ $ref: `${schema.$id}#/$defs/request` });
  const receiptCheck = ajv.compile({ $ref: `${schema.$id}#/$defs/receipt` });
  const input = { ...f.input, expectedSha256: (await f.read(f.input.path)).contentSha256,
    text: "updated" };
  const request = { schemaVersion: 1, contractVersion: "v0.1.0",
    operationId: "mutation.project-workspace.save", input };
  assert.equal(requestCheck(request), true, JSON.stringify(requestCheck.errors));
  assert.equal(requestCheck({ ...request, input: { ...input, expectedSha256: null } }), false);
  assert.equal(receiptCheck(await f.save({ input })), true, JSON.stringify(receiptCheck.errors));
});

test("a rejected concurrent save cannot release the first writer's lock", async (t) => {
  const f = await fixture(t);
  const input = { ...f.input, expectedSha256: (await f.read(f.input.path)).contentSha256,
    text: "one writer" };
  let entered, unblock, calls = 0;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  const save = createApplicationProjectWorkspaceSaveHandler({ store: f.store,
    readProject: async () => { calls++; if (calls === 1) { entered(); await gate; }
      return f.read(f.input.path); } });
  const first = save({ input });
  await enteredPromise;
  await assert.rejects(save({ input: { ...input, operationId: "second" } }),
    { code: "writer_busy" });
  await assert.rejects(save({ input: { ...input, operationId: "third" } }),
    { code: "writer_busy" });
  assert.equal(calls, 1);
  unblock();
  assert.equal((await first).operationId, "save-one");
});

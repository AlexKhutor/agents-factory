import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplicationArtifactResourceQuery } from "../src/application-artifact-resource.mjs";
import { createApplicationProjectResourceQuery } from "../src/application-project-resource.mjs";
import {
  issueApplicationResourceContinuation,
  verifyApplicationResourceContinuation,
} from "../src/application-resource-continuation.mjs";
import { ApplicationResourceLastKnownGoodStore } from "../src/application-resource-last-known-good.mjs";
import {
  APPLICATION_RESOURCE_READER_LIMITS,
  ApplicationResourceReader,
  normalizeApplicationResourceReadError,
} from "../src/application-resource-reader.mjs";

const SNAPSHOT = "working-tree-snapshot-1";
const NOW = () => new Date("2026-08-30T18:00:00.000Z");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "orchestrator", "src");
  const reportDir = path.join(root, "knowledge", "reports", "inbox", "worker-one");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await mkdir(path.join(root, ".project-runtime"), { recursive: true });
  const source = Buffer.from("alpha\nbeta\ngamma\n", "utf8");
  const report = Buffer.from("# Immutable report\n\nComplete.\n", "utf8");
  await writeFile(path.join(sourceDir, "example.mjs"), source);
  await writeFile(path.join(sourceDir, "second.mjs"), "export {};\n", "utf8");
  await writeFile(path.join(reportDir, "task-one-report.md"), report);
  await writeFile(path.join(root, ".project-runtime", "auth.json"), "{}", "utf8");
  const policies = [
    {
      scope: "artifact",
      rootId: "controller-workspace",
      rootPath: root,
      readPolicyId: "artifact-owner-read-v1",
      sourceId: "controller",
      authorityTypes: ["child-workspace", "coordination-core"],
      allowedPrefixes: ["knowledge/reports/inbox", "coordination"],
      revision: null,
    },
    {
      scope: "project",
      rootId: "controller-workspace",
      rootPath: root,
      readPolicyId: "project-owner-read-v1",
      sourceId: "orchestrator-repository",
      authorityTypes: ["child-workspace"],
      allowedPrefixes: ["orchestrator/src", ".project-runtime"],
      revision: { schemaVersion: 1, kind: "opaque", value: SNAPSHOT },
    },
  ];
  const reader = await ApplicationResourceReader.create({ policies, now: NOW });
  return { root, reader, source, report };
}

function authority(authorityType, sourceId, sha256) {
  return {
    schemaVersion: 1,
    authorityType,
    sourceId,
    externalId: "resource-owner",
    contractVersion: "v0.1.0",
    ...(sha256 === undefined ? {} : { artifactSha256: sha256 }),
  };
}

function artifactRequest(bytes) {
  const sha256 = digest(bytes);
  return createApplicationArtifactResourceQuery({
    artifactKind: "report",
    resource: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      resourceKind: "artifact",
      sourceId: "worker-one",
      nativeId: "knowledge/reports/inbox/worker-one/task-one-report.md",
      authority: authority("child-workspace", "worker-one", sha256),
      revision: { schemaVersion: 1, kind: "sha256", value: sha256 },
      contentSha256: sha256,
    },
    requestedAtUtc: "2026-08-30T17:59:00.000Z",
  });
}

function projectRequest(view = "text-slice", overrides = {}) {
  const directory = view === "directory-summary";
  return createApplicationProjectResourceQuery({
    rootId: "controller-workspace",
    readPolicyId: "project-owner-read-v1",
    resource: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      resourceKind: directory ? "project-directory" : "project-file",
      sourceId: "orchestrator-repository",
      nativeId: directory ? "orchestrator/src" : "orchestrator/src/example.mjs",
      authority: authority("child-workspace", "orchestrator-repository"),
      revision: { schemaVersion: 1, kind: "opaque", value: SNAPSHOT },
      ...overrides,
    },
    view,
    slice: view === "text-slice" ? { offsetBytes: 0, maximumBytes: 6 } : null,
    maxEntries: directory ? 1 : null,
    requestedAtUtc: "2026-08-30T17:59:00.000Z",
  });
}

test("A3.5 reads an exact immutable artifact through its registered owner policy", async (t) => {
  const context = await fixture(t);
  const result = await context.reader.readArtifact(artifactRequest(context.report));
  assert.equal(result.payload.text, context.report.toString("utf8"));
  assert.equal(result.contentSha256, digest(context.report));
  assert.equal(result.relativePath.startsWith("knowledge/reports/inbox/"), true);
  assert.equal(JSON.stringify(result).includes(context.root), false);
  assert.equal(result.sourceBinding.readPolicyId, "artifact-owner-read-v1");
  assert.match(result.requestSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.representationSha256, /^[a-f0-9]{64}$/u);
});

test("A3.5 reads bounded project slices, metadata, and directory summaries", async (t) => {
  const context = await fixture(t);
  const slice = await context.reader.readProject(projectRequest());
  assert.equal(slice.payload.text, "alpha\n");
  assert.equal(slice.range.returnedBytes, 6);
  assert.equal(slice.truncated, true);

  const metadata = await context.reader.readProject(projectRequest("metadata"));
  assert.equal(metadata.payload.kind, "metadata");
  assert.equal(metadata.range.returnedBytes, 0);
  assert.equal(metadata.range.totalBytes, context.source.length);

  const directory = await context.reader.readProject(projectRequest("directory-summary"));
  assert.equal(directory.payload.entries.length, 1);
  assert.equal(directory.truncated, true);
  assert.equal(directory.payload.entries[0].name, "example.mjs");
});

test("A3.5 reads a file that begins with a UTF-8 byte-order mark, the mark kept", async (t) => {
  const context = await fixture(t);
  await writeFile(path.join(context.root, "orchestrator", "src", "bom.txt"),
    Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("hello\r\n", "utf8")]));
  const slice = await context.reader.readProject(projectRequest("text-slice",
    { nativeId: "orchestrator/src/bom.txt" }));
  assert.equal(slice.payload.text, "\ufeffhel");
  assert.equal(slice.range.returnedBytes, 6);
});

test("A3.5 rejects private stores, binary, secret, and oversized content", async (t) => {
  const context = await fixture(t);
  const privateRequest = projectRequest("metadata", {
    nativeId: ".project-runtime/auth.json",
  });
  await assert.rejects(context.reader.readProject(privateRequest), { code: "access_denied" });

  const binaryPath = path.join(context.root, "orchestrator", "src", "binary.dat");
  await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
  const binaryRequest = projectRequest("text-slice", { nativeId: "orchestrator/src/binary.dat" });
  await assert.rejects(context.reader.readProject(binaryRequest), { code: "access_denied" });

  await writeFile(binaryPath, "Bearer abcdefghijklmnopqrstuvwxyz123456", "utf8");
  await assert.rejects(context.reader.readProject(binaryRequest), { code: "access_denied" });

  await writeFile(
    binaryPath,
    Buffer.alloc(APPLICATION_RESOURCE_READER_LIMITS.maxFileBytes + 1, 65),
  );
  await assert.rejects(context.reader.readProject(binaryRequest), { code: "access_denied" });
});

test("A3.5 rejects links before reading through them", async (t) => {
  const context = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "application-reader-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "outside.mjs"), "export const privateValue = true;\n", "utf8");
  const linkPath = path.join(context.root, "orchestrator", "src", "linked");
  await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  const linked = projectRequest("text-slice", {
    nativeId: "orchestrator/src/linked/outside.mjs",
  });
  await assert.rejects(context.reader.readProject(linked), { code: "access_denied" });
});

test("A3.7 rejects a continuation after the resource changes between pages", async (t) => {
  const context = await fixture(t);
  const input = projectRequest();
  const first = await context.reader.readProject(input);
  const issued = issueApplicationResourceContinuation({
    secret: Buffer.alloc(32, 4),
    backendInstanceId: "backend-instance-1",
    request: input,
    result: first,
    now: NOW,
  });
  await writeFile(
    path.join(context.root, "orchestrator", "src", "example.mjs"),
    "changed\ncontent\n",
    "utf8",
  );
  const changed = await context.reader.readProject(input);
  assert.notEqual(changed.contentSha256, first.contentSha256);
  assert.throws(() => verifyApplicationResourceContinuation({
    token: issued.token,
    secret: Buffer.alloc(32, 4),
    backendInstanceId: "backend-instance-1",
    request: input,
    currentSourceBinding: changed.sourceBinding,
    currentContentSha256: changed.contentSha256,
    now: NOW,
  }), { code: "stale_revision" });
});

test("A3.7 maps deleted and renamed resources to bounded unavailable errors", async (t) => {
  const deleted = await fixture(t);
  const deletedPath = path.join(deleted.root, "orchestrator", "src", "example.mjs");
  await unlink(deletedPath);
  await assert.rejects(deleted.reader.readProject(projectRequest()), {
    name: "ApplicationContractError",
    code: "source_unavailable",
  });

  const moved = await fixture(t);
  const source = path.join(moved.root, "orchestrator", "src", "example.mjs");
  await rename(source, path.join(moved.root, "orchestrator", "src", "renamed.mjs"));
  await assert.rejects(moved.reader.readProject(projectRequest()), {
    name: "ApplicationContractError",
    code: "source_unavailable",
  });
});

test("A3.7 rejects stale hashes, inaccessible files, and unsupported encoding", async (t) => {
  const context = await fixture(t);
  const stale = projectRequest("text-slice", { contentSha256: "f".repeat(64) });
  await assert.rejects(context.reader.readProject(stale), { code: "stale_revision" });

  const inaccessible = Object.assign(new Error("private operating-system detail"), { code: "EACCES" });
  const normalized = normalizeApplicationResourceReadError(inaccessible);
  assert.equal(normalized.name, "ApplicationContractError");
  assert.equal(normalized.code, "access_denied");
  assert.equal(normalized.message.includes("private operating-system detail"), false);

  await writeFile(
    path.join(context.root, "orchestrator", "src", "invalid.txt"),
    Buffer.from([0xc3, 0x28]),
  );
  const invalid = projectRequest("text-slice", { nativeId: "orchestrator/src/invalid.txt" });
  await assert.rejects(context.reader.readProject(invalid), { code: "access_denied" });
});

test("A3.7 retains last-known-good metadata but never serves a stale body", async (t) => {
  const context = await fixture(t);
  const input = projectRequest();
  const current = await context.reader.readProject(input);
  const store = new ApplicationResourceLastKnownGoodStore({
    maximumEntries: 2,
    now: () => new Date("2026-08-30T18:00:01.000Z"),
  });
  const recorded = store.record(input, current);
  await unlink(path.join(context.root, "orchestrator", "src", "example.mjs"));
  await assert.rejects(context.reader.readProject(input), { code: "source_unavailable" });

  const evidence = store.lookup(input);
  assert.deepEqual(evidence, recorded);
  assert.equal(evidence.status, "available");
  assert.equal(evidence.usableAsCurrent, false);
  assert.equal(evidence.contentSha256, current.contentSha256);
  assert.equal(Object.hasOwn(evidence, "payload"), false);
  assert.equal(Object.hasOwn(evidence, "text"), false);
  assert.equal(JSON.stringify(evidence).includes(context.root), false);

  const other = projectRequest("text-slice", { nativeId: "orchestrator/src/second.mjs" });
  assert.deepEqual(store.lookup(other).status, "unavailable");
});

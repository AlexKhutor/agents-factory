import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { applicationCanonicalSha256 } from "../src/application-contract.mjs";
import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { agentMemoryScopeId } from "../src/project-memory-service.mjs";
import { artifactsKeyOf, deskSourceIdOf, exportProject, ProjectPackageError } from "../src/project-package-export.mjs";
import { fixedNow, fixture, lines, put, sha, skip, treeOf } from "./fixtures/project-package-fixture.mjs";

test("a project's export holds its records and files and nothing of another project", { skip }, async () => {
  const root = await fixture();
  try {
    const out = path.join(root, "packages", "alpha");
    const result = await exportProject({ controllerRoot: root, projectId: "alpha", out, now: fixedNow });
    assert.deepEqual(result.unassignedDocuments, ["mystery-doc"]);
    const tree = await treeOf(out);
    const desk = (relative) => tree.get(`.desk/${relative}`);
    assert.deepEqual(lines(desk("memory/scopes.jsonl")).map((s) => s.scopeId).sort(),
      ["alpha-memory", "alpha-q1-memory", agentMemoryScopeId("alpha-agent")].sort());
    assert.deepEqual(lines(desk("memory/revisions.jsonl")).map((r) => `${r.scopeId}@${r.revision}`).sort(),
      [`${agentMemoryScopeId("alpha-agent")}@1`, "alpha-memory@1", "alpha-memory@2", "alpha-q1-memory@1"].sort());
    assert.deepEqual(lines(desk("memory/operations.jsonl")).map((o) => o.operationId).sort(),
      [`op-${agentMemoryScopeId("alpha-agent")}`, "op-alpha-memory", "op-alpha-q1-memory", "write-alpha"].sort());
    assert.deepEqual(lines(desk("memory/grants.jsonl")).map((g) => g.commandId), ["cmd-alpha"]);
    const documents = lines(desk("memory/documents.jsonl"));
    const catalog = documents.find((d) => d.key === "memory-agents-v1");
    assert.deepEqual(catalog.value.agents.map((a) => a.agentId), ["alpha-agent", "alpha-acp"]);
    const archived = documents.find((d) => d.key === "memory-project-archive-v1");
    assert.deepEqual(archived.value.projects, {});
    assert.deepEqual(Object.keys(archived.value.quarters), ["alpha/q1"]);
    assert.equal(documents.length, 4);
    const conversations = lines(desk("archive/conversations.jsonl"));
    assert.equal(conversations.length, 1);
    const entryFile = `archive/entries/${conversations[0].conversationId.replace(/^conversation:/u, "")}.jsonl`;
    assert.deepEqual(lines(desk(entryFile)).map((e) => e.record.text), ["alpha says hi", "alpha again"]);
    for (const file of [
      "sessions/claude/th-alpha/session.json", "sessions/claude/th-alpha/turns/t1.json",
      "sessions/acp/th-alpha-acp/session.json", "sessions/claude-sdk/C--x-alpha/th-alpha.jsonl",
      "sessions/dsh/--x-alpha--/th-alpha-acp/session.v3.jsonl.zstd", "sessions/dsh-projcache/th-alpha-acp.json",
      "desk/agents/alpha-agent/tasks/inbox/task-1/task.json", "desk/tasks/dispatched/task-1/task.json",
      "desk/tasks/definitions/task-1.json", "desk/tasks/returns/task-1.json",
      "desk/reports/desk-alpha-agent/2026-10-25-task-1.md", "desk/acceptances/desk-alpha-agent/task-1/acceptance.json",
    ]) assert.ok(desk(file), `missing ${file}`);
    for (const [name, bytes] of tree) {
      assert.ok(!name.includes("logs/"), `machine log exported: ${name}`);
      assert.ok(!name.includes("credentials"), `login exported: ${name}`);
      for (const other of ["th-beta", "beta-agent", "beta says hi", "task-2"]) {
        assert.ok(!bytes.toString("utf8").includes(other), `${name} holds ${other}`);
      }
    }
    const manifest = JSON.parse(tree.get("project.af.json").toString("utf8"));
    assert.equal(manifest.projectId, "alpha");
    assert.equal(manifest.title, "Alpha");
    assert.equal(manifest.worldId, "world-1");
    assert.equal(manifest.workspace.external, true);
    assert.equal(manifest.workspace.boundPathHint, path.join(root, "alpha-ws"));
    assert.equal(manifest.export.revision, 1);
    for (const [name, info] of Object.entries(manifest.files)) {
      assert.equal(info.sha256, sha(tree.get(name)), name);
      assert.equal(info.bytes, tree.get(name).length, name);
    }
    assert.equal(Object.keys(manifest.files).length, [...tree.keys()].filter((n) => n !== "project.af.json").length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an export of unchanged data is byte-identical, the manifest included; a change moves the revision", { skip }, async () => {
  const root = await fixture();
  try {
    const out = path.join(root, "packages", "alpha");
    const first = await exportProject({ controllerRoot: root, projectId: "alpha", out, now: fixedNow });
    const before = await treeOf(out);
    const second = await exportProject({ controllerRoot: root, projectId: "alpha", out,
      now: () => new Date("2026-10-26T08:00:00.000Z") });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    const after = await treeOf(out);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [name, bytes] of before) assert.ok(bytes.equals(after.get(name)), `${name} changed`);

    const store = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "node", now: fixedNow });
    const entries = [{ id: "e2", title: "More", text: "alpha grows" }];
    await store.authorizeWrite({ commandId: "cmd-alpha-2", scopeId: "alpha-memory", expectedRevision: 2,
      entries, requestedBy: "owner" });
    await store.write({ scopeId: "alpha-memory", expectedRevision: 2, entries, operationId: "write-alpha-2",
      commandId: "cmd-alpha-2", actorId: "owner" });
    await store.close();
    const third = await exportProject({ controllerRoot: root, projectId: "alpha", out, now: fixedNow });
    assert.equal(third.changed, true);
    assert.equal(third.revision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export refuses a busy agent, an unknown project and a folder it does not own", { skip }, async () => {
  const root = await fixture();
  try {
    const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;
    await assert.rejects(exportProject({ controllerRoot: root, projectId: "gamma", out: path.join(root, "p", "gamma") }),
      refused("project_not_found"));
    const out = path.join(root, "packages", "alpha");
    await exportProject({ controllerRoot: root, projectId: "alpha", out, now: fixedNow });
    await assert.rejects(exportProject({ controllerRoot: root, projectId: "beta", out }), refused("package_other_project"));
    const foreign = path.join(root, "foreign");
    await put(foreign, "something.txt", "not a package");
    await assert.rejects(exportProject({ controllerRoot: root, projectId: "beta", out: foreign }),
      refused("package_folder_not_empty"));

    const store = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "node", now: fixedNow });
    const catalog = await store.readDocument({ key: "memory-agents-v1" });
    const value = structuredClone(catalog.value);
    value.agents.find((a) => a.agentId === "beta-agent").currentOperationId = "send-1";
    assert.equal(await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: catalog.revision, value }), true);
    await store.close();
    await assert.rejects(exportProject({ controllerRoot: root, projectId: "beta", out: path.join(root, "p", "beta") }),
      refused("project_not_quiescent"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the exporter names desk folders and artifact documents as their owners do", async () => {
  const { deskAgentSourceId } = await import("../src/desk-agent-sources.mjs");
  for (const agentId of ["alpha-agent", "Qwen.Agent:1", "a".repeat(60), "x"]) {
    assert.equal(deskSourceIdOf(agentId), deskAgentSourceId(agentId), agentId);
    assert.equal(artifactsKeyOf(agentId), `agent-artifacts-${applicationCanonicalSha256(agentId)}`, agentId);
  }
});

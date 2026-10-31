import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applicationCanonicalSha256 } from "../../src/application-contract.mjs";
import { createConversationArchive } from "../../src/conversation-archive.mjs";
import { createProjectMemoryStore } from "../../src/project-memory-store.mjs";
import { agentMemoryScopeId } from "../../src/project-memory-service.mjs";
import { bindProjectWorkspace } from "../../src/project-workspace-binding.mjs";
import { loadNodeSqlite } from "../../src/sqlite-backend.mjs";

// A single-DB instance with two projects and every kind of record a project
// package carries (project-package-export / -import tests).
export const CONTROLLER = "fixture-controller";
export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const binding = (threadId, providerId) => ({ projectId: CONTROLLER, sourceId: "fixture-gw", providerId, threadId });
export const fixedNow = () => new Date("2026-10-25T20:00:00.000Z");
export const nodeSqlite = await loadNodeSqlite();
export const skip = nodeSqlite === null ? "node:sqlite is not available" : false;

export async function put(root, relative, text) {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

// Two projects in one single-DB instance, with every kind of record the
// exporter splits: "alpha" (two agents, claude + acp) and "beta" (one agent).
export async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-package-")));
  await put(root, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: CONTROLLER }));
  await put(root, "instance.json", JSON.stringify({ schemaVersion: 1, instanceId: "world-1" }));
  const store = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "node", now: fixedNow });
  const scope = (scopeId, kind, projectId, quarterId, title) =>
    store.createScope({ scopeId, kind, projectId, quarterId, title, operationId: `op-${scopeId}` });
  await scope("alpha-memory", "project", "alpha", null, "Alpha");
  await scope("alpha-q1-memory", "quarter", "alpha", "q1", "Alpha Q1");
  await scope(agentMemoryScopeId("alpha-agent"), "agent", "alpha", "q1", "alpha-agent");
  await scope("beta-memory", "project", "beta", null, "Beta");
  await scope("beta-q1-memory", "quarter", "beta", "q1", "Beta Q1");
  const entries = [{ id: "e1", title: "Note", text: "alpha only" }];
  await store.authorizeWrite({ commandId: "cmd-alpha", scopeId: "alpha-memory", expectedRevision: 1,
    entries, requestedBy: "owner" });
  await store.write({ scopeId: "alpha-memory", expectedRevision: 1, entries, operationId: "write-alpha",
    commandId: "cmd-alpha", actorId: "owner" });
  const agent = (agentId, projectId, threadId, providerId, extra = {}) => ({ agentId, projectId, quarterId: "q1",
    state: "active", binding: binding(threadId, providerId), operations: [], currentOperationId: null, ...extra });
  const documents = {
    "memory-agents-v1": { agents: [
      agent("alpha-agent", "alpha", "th-alpha", "claude-code"),
      agent("beta-agent", "beta", "th-beta", "claude-code"),
      agent("alpha-acp", "alpha", "th-alpha-acp", "acp"),
    ] },
    "memory-project-archive-v1": { schemaVersion: 1, projects: { beta: { archivedAtUtc: "2026-10-01T00:00:00.000Z" } },
      quarters: { "alpha/q1": { archivedAtUtc: "2026-10-02T00:00:00.000Z" } } },
    [`memory-document-approvals-v1:${sha("alpha-agent").slice(0, 32)}`]: { approvals: [{ scopeId: "alpha-memory" }] },
    [`agent-artifacts-${applicationCanonicalSha256("alpha-agent")}`]: { agentId: "alpha-agent", projectId: "alpha", records: [] },
    [`memory-document-approvals-v1:${sha("beta-agent").slice(0, 32)}`]: { approvals: [{ scopeId: "beta-memory" }] },
    "mystery-doc": { anything: true },
  };
  for (const [key, value] of Object.entries(documents)) {
    assert.equal(await store.compareAndSwapDocument({ key, expectedRevision: 0, value }), true);
  }
  await mkdir(path.join(root, "alpha-ws"));
  await bindProjectWorkspace(store, { projectId: "alpha", workspacePath: path.join(root, "alpha-ws") });
  await store.close();

  const archive = await createConversationArchive({ controllerRoot: root, projectId: CONTROLLER, sqliteBackend: "node",
    now: fixedNow });
  const record = (recordId, text) => ({ recordId, kind: "message", role: "assistant", state: "completed", text,
    providerTurnId: null, providerItemId: null, requestId: null, occurredAtUtc: "2026-10-25T19:00:00.000Z", omissions: [] });
  await archive.append(binding("th-alpha", "claude-code"), record("r1", "alpha says hi"));
  await archive.append(binding("th-beta", "claude-code"), record("r2", "beta says hi"));
  await archive.append(binding("th-alpha", "claude-code"), record("r3", "alpha again"));
  await archive.close();

  const local = ".project-local";
  await put(root, `${local}/orchestration/claude-sessions/th-alpha/session.json`, '{"cwd":"x"}');
  await put(root, `${local}/orchestration/claude-sessions/th-alpha/turns/t1.json`, "{}");
  await put(root, `${local}/orchestration/claude-sessions/th-beta/session.json`, '{"cwd":"y"}');
  await put(root, `${local}/orchestration/acp-sessions/th-alpha-acp/session.json`, '{"cwd":"x"}');
  await put(root, `${local}/claude-account/.credentials.json`, '{"never":"exported"}');
  await put(root, `${local}/claude-account/projects/C--x-alpha/th-alpha.jsonl`, '{"t":1}\n');
  await put(root, `${local}/claude-account/projects/C--y-beta/th-beta.jsonl`, '{"t":2}\n');
  await put(root, `${local}/dsh-home/sessions/--x-alpha--/th-alpha-acp/session.v3.jsonl.zstd`, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  await put(root, `${local}/dsh-home/storages/session_projcache/sessions/th-alpha-acp.json`, '{"identity":{}}');
  await put(root, `${local}/desk-agents/desk-alpha-agent/tasks/inbox/task-1/task.json`, '{"taskId":"task-1"}');
  await put(root, `${local}/desk-agents/desk-alpha-agent/logs/run.log`, "machine log");
  await put(root, "coordination/tasks/dispatched/task-1/task.json", '{"taskId":"task-1","targetId":"desk-alpha-agent"}');
  await put(root, "coordination/tasks/dispatched/task-2/task.json", '{"taskId":"task-2","targetId":"desk-beta-agent"}');
  await put(root, `${local}/desk-coordinator/definitions/task-1.json`, '{"targetId":"desk-alpha-agent"}');
  await put(root, `${local}/orchestration/desk-task-returns/task-1.json`, '{"agentId":"alpha-agent","sourceId":"desk-alpha-agent"}');
  await put(root, `${local}/orchestration/desk-task-returns/task-2.json`, '{"agentId":"beta-agent","sourceId":"desk-beta-agent"}');
  await put(root, "knowledge/reports/inbox/desk-alpha-agent/2026-10-25-task-1.md", "# report");
  await put(root, "coordination/acceptances/desk-alpha-agent/task-1/acceptance.json", "{}");
  return root;
}

export async function treeOf(folder) {
  const files = new Map();
  const walk = async (current, relative) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else files.set(rel, await readFile(path.join(current, entry.name)));
    }
  };
  await walk(folder, "");
  return files;
}

export const lines = (buffer) => buffer.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

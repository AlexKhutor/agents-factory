import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplicationGatewayFailureLogRecord } from "../src/application-gateway-runtime.mjs";
import { runProjectMemoryCommand } from "../src/project-memory-cli.mjs";
import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { ProjectPackageError } from "../src/project-package-export.mjs";
import { claudeProjectSlug, dshSessionSlug, rebindWorkedProject } from "../src/project-rebind.mjs";
import { bindProjectWorkspace, resolveProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { put, skip } from "./fixtures/project-package-fixture.mjs";

const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;
const keyOf = (folder) => createHash("sha256").update(folder.toLowerCase()).digest("hex");

test("the provider folder names follow what Claude Code and DeepSeek Harness were seen to use", () => {
  assert.equal(claudeProjectSlug("w:\\af-dev"), "w--af-dev");
  assert.equal(claudeProjectSlug("e:\\work_dir\\later"), "e--work-dir-later");
  assert.equal(dshSessionSlug("E:\\work_dir\\later\\game-mods"), "--E-work_dir-later-game-mods--");
  assert.equal(dshSessionSlug("C:\\Users\\littl\\AppData\\Local\\Temp\\claude\\z--test-mcp-later\\1d914f07-8425-4279-a869-8f968172f1f2\\scratchpad\\acp-live-ws"),
    "--C-Users-littl-AppData-Local-Temp-claude-z--test-mcp-later-1d914f07-8425-4279-a869-8f968172f1f2-scratchpad-acp-live-ws--");
  assert.equal(dshSessionSlug("C:\\Program Files\\x"), null);
});

/** A project bound to work-a whose two agents (Claude, ACP) worked there. */
async function instance(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-rebind-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: "rebind-fixture" }));
  const a = path.join(root, "work-a");
  const b = path.join(root, "work-b");
  await mkdir(a);
  await mkdir(b);
  const store = await createProjectMemoryStore({ controllerRoot: root, sqliteBackend: "node" });
  t.after(() => store.close());
  await store.createScope({ scopeId: "p-memory", kind: "project", projectId: "p", quarterId: null, title: "P", operationId: "op-p" });
  await bindProjectWorkspace(store, { projectId: "p", workspacePath: a });
  const worked = (agentId, threadId, providerId) => ({ agentId, projectId: "p", quarterId: "q", state: "active",
    workspaceKey: keyOf(a), binding: { projectId: "rebind-fixture", sourceId: "gw", providerId, threadId },
    operations: [{ operationId: `op-${agentId}`, state: "completed" }], currentOperationId: null });
  await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: 0,
    value: { agents: [worked("claude-agent", "th-c", "claude-code"), worked("acp-agent", "th-a", "acp")] } });
  const local = path.join(root, ".project-local");
  await put(local, "orchestration/claude-sessions/th-c/session.json", JSON.stringify({ sessionId: "th-c", cwd: a }));
  await put(local, "orchestration/acp-sessions/th-a/session.json", JSON.stringify({ sessionId: "th-a", cwd: a }));
  await put(local, `claude-account/projects/${claudeProjectSlug(a)}/th-c.jsonl`, '{"line":1}\n');
  await put(local, `claude-account/projects/${claudeProjectSlug(a)}/th-c/subagents/s1.jsonl`, '{"line":2}\n');
  await put(local, `dsh-home/sessions/${dshSessionSlug(a)}/th-a/session.v3.jsonl.zstd`, "zstd");
  await put(local, "dsh-home/storages/session_projcache/sessions/th-a.json", JSON.stringify({ identity: { cwd: a } }));
  return { root, store, a, b, local };
}

test("a project whose agents worked moves to another folder with its sessions, on confirmation", { skip }, async (t) => {
  const { root, store, a, b, local } = await instance(t);
  await assert.rejects(rebindWorkedProject({ controllerRoot: root, store, projectId: "p", workspacePath: b }),
    refused("rebind_confirmation_required"));
  const receipt = await rebindWorkedProject({ controllerRoot: root, store, projectId: "p", workspacePath: b, confirm: "p" });
  assert.equal(receipt.from, a);
  assert.equal(receipt.to, b);
  assert.deepEqual(receipt.sessions.sort(), ["th-a", "th-c"]);
  assert.ok((await stat(receipt.receipt)).isFile());

  const json = async (relative) => JSON.parse(await readFile(path.join(local, relative), "utf8"));
  assert.equal((await json("orchestration/claude-sessions/th-c/session.json")).cwd, b);
  assert.equal((await json("orchestration/acp-sessions/th-a/session.json")).cwd, b);
  assert.equal((await json("dsh-home/storages/session_projcache/sessions/th-a.json")).identity.cwd, b);
  assert.equal(await readFile(path.join(local, `claude-account/projects/${claudeProjectSlug(b)}/th-c.jsonl`), "utf8"), '{"line":1}\n');
  assert.ok((await readdir(path.join(local, `claude-account/projects/${claudeProjectSlug(b)}/th-c/subagents`))).includes("s1.jsonl"));
  assert.ok((await readdir(path.join(local, `dsh-home/sessions/${dshSessionSlug(b)}/th-a`))).includes("session.v3.jsonl.zstd"));
  await assert.rejects(stat(path.join(local, `claude-account/projects/${claudeProjectSlug(a)}/th-c.jsonl`)), { code: "ENOENT" });

  // A send finds the agents' key and the binding in agreement (project-memory-claude.mjs).
  const bound = await resolveProjectWorkspace(store, "p");
  const agents = (await store.readDocument({ key: "memory-agents-v1" })).value.agents;
  assert.ok(agents.every((agent) => agent.workspaceKey === bound.workspaceKey));
  assert.equal(bound.workspacePath, b);
});

test("a rebind refuses a busy agent, a running Gateway, a taken target and an unknown provider folder, moving nothing", { skip }, async (t) => {
  const { root, store, a, b, local } = await instance(t);
  const before = await readdir(path.join(local, "claude-account/projects"), { recursive: true });

  await put(local, `claude-account/projects/${claudeProjectSlug(b)}/th-c.jsonl`, "taken");
  await assert.rejects(rebindWorkedProject({ controllerRoot: root, store, projectId: "p", workspacePath: b, confirm: "p" }),
    refused("rebind_target_exists"));
  await rm(path.join(local, `claude-account/projects/${claudeProjectSlug(b)}`), { recursive: true });
  assert.deepEqual(await readdir(path.join(local, "claude-account/projects"), { recursive: true }), before);

  await put(local, "application-gateway/status.v1.json", JSON.stringify({ terminal: false,
    identity: { process: { processId: process.pid } } }));
  await assert.rejects(rebindWorkedProject({ controllerRoot: root, store, projectId: "p", workspacePath: b, confirm: "p" }),
    refused("gateway_running"));
  // Through the memory CLI Atlas sees the same code (and pauses the Gateway), not application_gateway_failed.
  await writeFile(path.join(root, "rebind-input.json"), JSON.stringify({ projectId: "p", workspacePath: b }));
  await assert.rejects(runProjectMemoryCommand({ "repo-root": root, action: "rebind-workspace",
    "input-file": "rebind-input.json", "confirm-project": "p" }),
  (error) => createApplicationGatewayFailureLogRecord(error).code === "gateway_running");
  await rm(path.join(local, "application-gateway"), { recursive: true });

  const catalog = await store.readDocument({ key: "memory-agents-v1" });
  const busy = structuredClone(catalog.value);
  busy.agents[0].currentOperationId = "send-1";
  await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: catalog.revision, value: busy });
  await assert.rejects(rebindWorkedProject({ controllerRoot: root, store, projectId: "p", workspacePath: b, confirm: "p" }),
    refused("rebind_project_busy"));
  const again = await store.readDocument({ key: "memory-agents-v1" });
  await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: again.revision, value: catalog.value });

  await put(local, "claude-account/projects/somewhere-else/th-c.jsonl", "stray");
  await assert.rejects(rebindWorkedProject({ controllerRoot: root, store, projectId: "p", workspacePath: b, confirm: "p" }),
    refused("rebind_provider_folder_unknown"));
  assert.equal((await resolveProjectWorkspace(store, "p")).workspacePath, a);
});

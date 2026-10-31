import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applicationGatewayWorkspaceHash } from "../src/application-gateway-runtime.mjs";
import { instancePathHash, relocateInstance } from "../src/instance-relocate.mjs";
import { createProjectMemoryStore } from "../src/project-memory-store.mjs";
import { ProjectPackageError } from "../src/project-package-export.mjs";
import { claudeProjectSlug } from "../src/project-rebind.mjs";
import { bindProjectWorkspace, resolveProjectWorkspace } from "../src/project-workspace-binding.mjs";
import { put, skip } from "./fixtures/project-package-fixture.mjs";

const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;
// As project-workspace-binding.mjs: a folder's identity ignores case only where the file system does.
const keyOf = (folder) => createHash("sha256").update(process.platform === "win32" ? folder.toLowerCase() : folder).digest("hex");

test("the instance path hash is the Gateway's", () => {
  for (const root of ["W:\\af-world\\instance", "E:\\Agents-factory\\instance-home"]) {
    assert.equal(instancePathHash(root), applicationGatewayWorkspaceHash(root));
  }
});

test("a moved instance follows its new path: configs, inner bindings with their sessions, Atlas", { skip }, async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-relocate-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = path.join(base, "old-home");
  const b = path.join(base, "new-home");
  const atlas = path.join(base, "atlas");
  await mkdir(path.join(a, "workspace"), { recursive: true });
  await put(a, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: "relocate-fixture" }));
  await put(a, "start-atlas.bat", `@echo off\r\nset INSTANCE=${a}\r\n`);
  const local = path.join(a, ".project-local");
  await put(local, "application-gateway/claude-provider.json", JSON.stringify({
    claudeConfigDir: path.join(local, "claude-account"), sdkPath: "C:\\sdk\\claude", keepProviderVariables: false }, null, 2));
  const store = await createProjectMemoryStore({ controllerRoot: a, sqliteBackend: "node" });
  for (const [scopeId, kind, projectId, quarterId] of [["world-memory", "project", "world", null], ["p-memory", "project", "p", null]]) {
    await store.createScope({ scopeId, kind, projectId, quarterId, title: scopeId, operationId: `op-${scopeId}` });
  }
  await bindProjectWorkspace(store, { projectId: "world", workspacePath: a });
  await bindProjectWorkspace(store, { projectId: "p", workspacePath: path.join(a, "workspace") });
  const worked = (agentId, projectId, folder) => ({ agentId, projectId, quarterId: "q", state: "active", workspaceKey: keyOf(folder),
    binding: { projectId: "relocate-fixture", sourceId: "gw", providerId: "claude-code", threadId: `th-${agentId}` },
    operations: [{ operationId: `op-${agentId}`, state: "completed" }], currentOperationId: null });
  await store.compareAndSwapDocument({ key: "memory-agents-v1", expectedRevision: 0,
    value: { agents: [worked("lead", "world", a), worked("worker", "p", path.join(a, "workspace"))] } });
  await store.close();
  for (const [agentId, folder] of [["lead", a], ["worker", path.join(a, "workspace")]]) {
    await put(local, `orchestration/claude-sessions/th-${agentId}/session.json`, JSON.stringify({ cwd: folder }));
    await put(local, `claude-account/projects/${claudeProjectSlug(folder)}/th-${agentId}.jsonl`, `${agentId}\n`);
  }
  const oldKey = `live-${instancePathHash(a).slice(0, 16)}`;
  await put(atlas, "config/local.json", JSON.stringify({ controllerRoot: a,
    expectedWorkspace: { projectId: "relocate-fixture", workspaceRootSha256: instancePathHash(a) } }, null, 2));
  await put(atlas, `user-data/layouts/${oldKey}.json`, JSON.stringify({ schemaVersion: 1, projects: { world: { x: 1, y: 2 } } }));
  await put(atlas, "user-data/seen-turns.json", JSON.stringify({ schemaVersion: 1, environments: { [oldKey]: { lead: "op-1" } }, answers: {} }));

  await cp(a, b, { recursive: true });
  await assert.rejects(relocateInstance({ controllerRoot: b, from: a }), refused("relocate_confirmation_required"));
  const result = await relocateInstance({ controllerRoot: b, from: a, confirm: a, atlasConfig: path.join(atlas, "config/local.json") });

  const provider = JSON.parse(await readFile(path.join(b, ".project-local/application-gateway/claude-provider.json"), "utf8"));
  assert.equal(provider.claudeConfigDir, path.join(b, ".project-local", "claude-account"));
  assert.equal(provider.sdkPath, "C:\\sdk\\claude");
  assert.deepEqual(result.rebound.map((item) => `${item.projectId}:${item.state}`), ["p:rebound", "world:rebound"]);
  const reopened = await createProjectMemoryStore({ controllerRoot: b, sqliteBackend: "node" });
  t.after(() => reopened.close());
  assert.equal((await resolveProjectWorkspace(reopened, "world")).workspacePath, b);
  assert.equal((await resolveProjectWorkspace(reopened, "p")).workspacePath, path.join(b, "workspace"));
  const agents = (await reopened.readDocument({ key: "memory-agents-v1" })).value.agents;
  assert.equal(agents.find((agent) => agent.agentId === "worker").workspaceKey, keyOf(path.join(b, "workspace")));
  for (const [agentId, folder] of [["lead", b], ["worker", path.join(b, "workspace")]]) {
    const session = JSON.parse(await readFile(path.join(b, `.project-local/orchestration/claude-sessions/th-${agentId}/session.json`), "utf8"));
    assert.equal(session.cwd, folder);
    assert.equal(await readFile(path.join(b, `.project-local/claude-account/projects/${claudeProjectSlug(folder)}/th-${agentId}.jsonl`), "utf8"), `${agentId}\n`);
  }

  const atlasConfig = JSON.parse(await readFile(path.join(atlas, "config/local.json"), "utf8"));
  assert.equal(atlasConfig.controllerRoot, b);
  assert.equal(atlasConfig.expectedWorkspace.workspaceRootSha256, applicationGatewayWorkspaceHash(b));
  assert.equal(atlasConfig.expectedWorkspace.projectId, "relocate-fixture");
  const newKey = `live-${applicationGatewayWorkspaceHash(b).slice(0, 16)}`;
  assert.ok((await readdir(path.join(atlas, "user-data/layouts"))).includes(`${newKey}.json`));
  assert.deepEqual(JSON.parse(await readFile(path.join(atlas, "user-data/seen-turns.json"), "utf8")).environments[newKey], { lead: "op-1" });
  assert.equal(result.atlas.layout, "copied");
  assert.ok(result.stillNamingOldPath.includes("start-atlas.bat"));
  assert.ok(!result.stillNamingOldPath.some((file) => file.includes("claude-provider")));
});

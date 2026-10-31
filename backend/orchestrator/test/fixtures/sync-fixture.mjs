import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { setThisMachine } from "../../src/machine-identity.mjs";
import { createProjectMemoryService } from "../../src/project-memory-service.mjs";
import { ProjectPackageError } from "../../src/project-package-export.mjs";
import { writeStoreLayoutMarker } from "../../src/project-store-layout.mjs";
import { recordWorldProjects } from "../../src/world-registry.mjs";
import { put } from "./project-package-fixture.mjs";

// Block 3 (docs/project-package.md §14) between two instances on one disk: "home" and "office",
// with bare repos for remotes. The home-only project never reaches the office (R5, R37).

export const SOURCE = "sync-controller";
export const CANARY = "HOME-ONLY-CANARY-5512";
const profile = { provider: "fixture", model: "m", reasoningEffort: "max", fallbackPolicy: "deny" };
export const refused = (code) => (error) => error instanceof ProjectPackageError && error.code === code;
export const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

export async function service(root) {
  return createProjectMemoryService({ controllerRoot: root, provider: { preflight: async () => {}, capture: async () => {},
    create: async (agent) => ({ projectId: SOURCE, sourceId: SOURCE, providerId: "fixture", threadId: `thread-${agent.agentId}` }) } });
}

/** Bare remotes, the home instance (world, an open project, a home-only one) and both PCs' sync settings. */
export async function setup(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "af-sync-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remotes = path.join(base, "remotes");
  for (const name of ["world", "world-mirror", "open", "homep"]) {
    await mkdir(path.join(remotes, `${name}.git`), { recursive: true });
    gitIn(path.join(remotes, `${name}.git`), "init", "-q", "--bare", "-b", "main");
  }
  const home = path.join(base, "home");
  await put(home, ".gitignore", ".project-local/*\nlogs/*\n");
  await put(home, "project-version.json", JSON.stringify({ formatVersion: 1, projectName: SOURCE }));
  await put(home, "instance.json", JSON.stringify({ schemaVersion: 1, instanceId: "world-sync" }));
  await writeStoreLayoutMarker(home);
  const memory = await service(home);
  for (const [scopeId, kind, projectId, quarterId, title] of [
    ["world-memory", "project", "world", null, "World"], ["world-hq-memory", "quarter", "world", "hq", "HQ"],
    ["open-memory", "project", "open", null, "Open project"], ["open-q-memory", "quarter", "open", "q", "Q"],
    ["homep-memory", "project", "homep", null, "Home project"], ["homep-q-memory", "quarter", "homep", "q", "Q"]]) {
    await memory.store.createScope({ scopeId, kind, projectId, quarterId, title, operationId: `op-${scopeId}` });
  }
  const entries = [{ id: "e1", title: "Mods", text: `${CANARY} lives in the home memory` }];
  await memory.store.authorizeWrite({ commandId: "cmd", scopeId: "homep-memory", expectedRevision: 1, entries, requestedBy: "owner" });
  await memory.store.write({ scopeId: "homep-memory", expectedRevision: 1, entries, operationId: "w1", commandId: "cmd", actorId: "owner" });
  await memory.createAgent({ agentId: "lead", projectId: "world", quarterId: "hq", operationId: "create-lead", profile });
  await memory.createAgent({ agentId: "open-agent", projectId: "open", quarterId: "q", operationId: "create-open", profile });
  await memory.createAgent({ agentId: "home-agent", projectId: "homep", quarterId: "q", operationId: "create-home", profile });
  await memory.close();
  await recordWorldProjects(home, [{ projectId: "homep", policy: { homeOnly: true, allowedMachines: null } }]);
  await setThisMachine(home, { machineId: "home", title: "Home", home: true });

  const settings = (packagesRoot, projects) => JSON.stringify({ schemaVersion: 1, branch: "main", packagesRoot,
    author: { name: "Test", email: "test@example.com" },
    world: { remotes: [{ name: "hub", url: path.join(remotes, "world.git"), primary: true },
      { name: "mirror", url: path.join(remotes, "world-mirror.git") }] }, projects });
  await put(home, ".project-local/sync.json", settings(path.join(base, "packages-home"), {
    open: { remotes: [{ name: "hub", url: path.join(remotes, "open.git"), primary: true }] },
    homep: { remotes: [{ name: "gitea", url: path.join(remotes, "homep.git"), primary: true, home: true }] },
  }));
  return { base, remotes, home, settings };
}

/** The office: a clone of the world repo with its own settings and name; it lists the home-only project too. */
export async function office({ base, remotes, settings }) {
  const dir = path.join(base, "office");
  gitIn(base, "clone", "-q", "-c", "core.autocrlf=false", "--origin", "hub", path.join(remotes, "world.git"), dir);
  await put(dir, ".project-local/sync.json", settings(path.join(base, "packages-office"), {
    open: { remotes: [{ name: "hub", url: path.join(remotes, "open.git"), primary: true }] },
    homep: { remotes: [{ name: "gitea", url: path.join(remotes, "homep.git"), primary: true, home: true }] },
  }));
  await setThisMachine(dir, { machineId: "office", title: "Office", home: false });
  return dir;
}

export const lockOf = (remotes, repo) => JSON.parse(gitIn(path.join(remotes, `${repo}.git`), "show", "main:sync-lock.json"));

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A controller fixture for the desk task chain: the controller's own
// PowerShell tools (for the parity runs), the current child kit, a desk agent
// registered the way registerDeskAgentSource registers it, and a knowledge
// folder. Snapshots of a folder let a parity test run the same step twice,
// once with PowerShell and once with Node, in the same place.

export const backendRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const orchestratorRoot = path.join(backendRoot, "orchestrator");
// The three controller-only scripts live in the repository's controller template (read only).
export const controllerTemplateRoot = path.resolve(backendRoot, "..", "controller");

export const CONTROLLER_TOOLS = [
  ["orchestrator/coordination-kit/controller/tools/dispatch_child_task.ps1", "tools/dispatch_child_task.ps1"],
  ["orchestrator/coordination-kit/controller/tools/install_child_coordination_kit.ps1", "tools/install_child_coordination_kit.ps1"],
  ["orchestrator/coordination-kit/controller/tools/collect_child_reports_v2.ps1", "tools/collect_child_reports_v2.ps1"],
  ["tools/project_tooling_common.ps1", "tools/project_tooling_common.ps1"],
  ["tools/orchestration_common.ps1", "tools/orchestration_common.ps1"],
  ["orchestrator/src/desk-agent-source-validation.mjs", ".orchestrator/runtime/desk-agent-source-validation.mjs"],
];
export const CONTROLLER_ONLY_TOOLS = ["collect_child_reports.ps1", "import_agent_report.ps1", "rebuild_knowledge_catalog.ps1"];

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** The controller with its tools, the kit and an empty registry. */
export async function createController(controller, { powershellTools = true } = {}) {
  await writeJson(path.join(controller, "project-version.json"), {
    formatVersion: 1, projectName: "fixture-controller", projectVersion: "v0.1.0",
    componentVersions: {
      install_child_coordination_kit: "v0.3.1", dispatch_child_task: "v0.6.0", collect_child_reports_v2: "v0.3.0",
      collect_child_reports: "v0.2.0", import_agent_report: "v0.3.0", rebuild_knowledge_catalog: "v0.1.0",
    },
  });
  await writeJson(path.join(controller, ".orchestrator", "contract.json"), { schemaVersion: 1, sourceId: "controller" });
  await writeJson(path.join(controller, "config", "source-registry.json"), { schemaVersion: 2, sources: [] });
  await writeJson(path.join(controller, ".project-local", "source-bindings.json"), { schemaVersion: 2, sources: {} });
  if (powershellTools) {
    for (const [source, target] of CONTROLLER_TOOLS) {
      await mkdir(path.dirname(path.join(controller, target)), { recursive: true });
      await copyFile(path.join(backendRoot, source), path.join(controller, target));
    }
    for (const name of CONTROLLER_ONLY_TOOLS) {
      await copyFile(path.join(controllerTemplateRoot, "tools", name), path.join(controller, "tools", name));
    }
  }
  const kit = path.join(controller, "coordination", "child-agent-kit");
  await cp(path.join(controllerTemplateRoot, "coordination", "child-agent-kit"), kit,
    { recursive: true });
  await copyFile(path.join(orchestratorRoot, "coordination-kit/controller/coordination/child-agent-kit/kit-manifest.json"),
    path.join(kit, "kit-manifest.json"));
  await createKnowledge(path.join(controller, "knowledge"));
}

/** A knowledge folder whose names exercise the catalog's culture-aware order. */
export async function createKnowledge(knowledge) {
  await writeJson(path.join(knowledge, "document-registry.json"), {
    schemaVersion: 1,
    documents: [
      { id: "control.readme", path: "README.md", type: "readme", status: "active" },
      { id: "control.contract.lifecycle", path: "contracts/agent-task-lifecycle.md", type: "contract", status: "active" },
      { id: "control.adr.authority", path: "decisions/ADR-0001-authority-boundaries.md", type: "decision", status: "accepted" },
    ],
  });
  await writeText(path.join(knowledge, "README.md"), "# Knowledge\r\n\r\nThe controller's knowledge.\r\n");
  await writeText(path.join(knowledge, "contracts", "agent-task-lifecycle.md"), "# Agent Task Lifecycle\n\nText.\n");
  await writeText(path.join(knowledge, "decisions", "ADR-0001-authority-boundaries.md"),
    "﻿#   Authority Boundaries  \n\nWith a byte order mark.\n");
  await writeText(path.join(knowledge, "notes", "a_b.md"), "No title here.\n");
  await writeText(path.join(knowledge, "notes", "a-b.md"), "## Not a title\n# Hyphen Note\n");
  await writeText(path.join(knowledge, "notes", "ab.txt"), "plain\n");
  await writeText(path.join(knowledge, "notes", "a.b.yaml"), "key: value\n");
  await writeText(path.join(knowledge, "notes", "Заметка.md"), "# Заметка о решении\n");
  await writeText(path.join(knowledge, "notes", "zeta 2.json"), "{}\n");
  await writeText(path.join(knowledge, "reports", "inbox", "README.md"), "# Report Inbox\n");
  await writeText(path.join(knowledge, "reports", "inbox", "desk-solver", ".gitkeep"), "");
  await writeText(path.join(knowledge, ".obsidian", "workspace.bin"), "ignored");
}

/** What registerDeskAgentSource writes before it installs the kit (desk-agent-sources.mjs). */
export async function registerDeskAgentFiles(controller, { agentId = "solver", projectFolder,
  registeredAtUtc = "2026-10-20T08:00:00.000Z" } = {}) {
  const sourceId = `desk-${agentId}`;
  const folder = path.join(controller, ".project-local", "desk-agents", sourceId);
  await mkdir(path.join(folder, ".orchestrator"), { recursive: true });
  await mkdir(projectFolder, { recursive: true });
  await writeJson(path.join(folder, "project-version.json"), { formatVersion: 1, projectName: sourceId,
    projectVersion: "v0.1.0", componentVersions: {} });
  await writeJson(path.join(folder, ".orchestrator", "desk-agent.json"), { schemaVersion: 1, sourceId, agentId,
    projectId: "robotarm", quarterId: "tools", registeredAtUtc });
  await writeJson(path.join(controller, ".project-local", "source-bindings.json"), { schemaVersion: 2,
    sources: { [sourceId]: { workspacePath: folder, sourcePath: projectFolder } } });
  await writeJson(path.join(controller, "config", "source-registry.json"), { schemaVersion: 2, sources: [{
    id: sourceId, ownerRole: `desk agent ${agentId}`, workspaceRelativeSourceRoot: ".",
    taskInbox: ".orchestrator/tasks/inbox", reportOutbox: ".orchestrator/reports/outbox",
    progressOutbox: ".orchestrator/progress/outbox", executionAdapter: "claude-desk-agent",
    providerRoute: "claude-desk-agent", coordinationProfile: "claude-desk", executorState: "installed",
    requiredDocuments: [], reportInbox: `knowledge/reports/inbox/${sourceId}`, deskAgentId: agentId,
  }] });
  return { sourceId, folder };
}

/**
 * The environment without PowerShell 7 on the PATH. The controller's scripts
 * start their nested scripts with pwsh when it exists (Get-ControlPowerShellExecutable),
 * and PowerShell 7 writes other JSON (two-space indents, no escapes of < > & ')
 * and turns ISO times into local DateTime values. The Node port follows
 * Windows PowerShell 5.1, which runs the desk agent's kit and the dispatch;
 * the parity runs keep every script on 5.1.
 */
export function windowsPowerShellOnlyEnv(env = process.env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const kept = String(env[key] ?? "").split(path.delimiter)
    .filter((directory) => directory && !existsSync(path.join(directory, "pwsh.exe")));
  return { ...env, [key]: kept.join(path.delimiter) };
}

/** Runs a PowerShell script file with arguments (Windows PowerShell 5.1 only); the result of spawnSync. */
export function runPowerShellFile(script, args, { cwd } = {}) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000,
    env: windowsPowerShellOnlyEnv() });
  if (result.error) throw result.error;
  return result;
}

/**
 * Every file and folder under a folder: relative path (forward slashes) ->
 * bytes, or null for a folder (its name ends with a slash).
 */
export async function snapshot(root) {
  const files = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        files.set(`${relative}/`, null);
        await walk(full);
      } else if (entry.isFile()) files.set(relative, await readFile(full));
    }
  }
  await walk(root);
  return files;
}

/** Puts a folder back to a snapshot: removes everything, writes the snapshot's files. */
export async function restore(root, files) {
  for (const entry of await readdir(root).catch(() => [])) {
    await rm(path.join(root, entry), { recursive: true, force: true, maxRetries: 5 });
  }
  for (const [relative, bytes] of files) {
    const file = path.join(root, ...relative.split("/"));
    if (bytes === null) {
      await mkdir(file, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

export async function exists(file) { return Boolean(await lstat(file).catch(() => null)); }

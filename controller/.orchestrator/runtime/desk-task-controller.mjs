import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { DESK_AGENT_ROUTE, validateDeskAgentSource } from "./desk-agent-source-validation.mjs";
import {
  AUTOMATION_NULL, assertControlDurableText, assertControlRelativeReference, copyItem, exists, fullPath,
  functionOutput, guidN, hasProperty, isDirectory, isFile, isNullOrWhiteSpace, isPathRooted, moveItem, netMatch,
  property, psArray, psBool, psCustomObject, psEquals, psIn, psJson, psString, readAllText, readJson, refuse,
  removeQuietly, resolveControlRelativePath, runInProcess, sha256File, startsInside, truthy, utcStamp, withToolRun,
  writeLinesUtf8NoBom, writePsJson, writeTextUtf8NoBom,
} from "./desk-task-common.mjs";

// The controller's side of the desk task chain in Node: resolving a source's
// workspace (orchestration_common.ps1), dispatching an immutable task packet
// (dispatch_child_task.ps1) and installing the child kit into a desk agent's
// coordination folder (install_child_coordination_kit.ps1), with the same
// checks, files and hashes as the scripts. Only the Claude desk route
// (claude-desk-agent) runs here; other routes keep the PowerShell tools.

export const DESK_TASK_CONTROLLER_VERSION = "v0.1.0";
const COORDINATOR_ID = "agents-factory-control";
const SOURCE_ID_PATTERN = "^[a-z0-9][a-z0-9-]{1,63}$";

// ---------------------------------------------------------------------------
// orchestration_common.ps1

async function readRegistry(controlRoot) {
  const registryPath = path.join(controlRoot, "config", "source-registry.json");
  if (!(await isFile(registryPath))) refuse(`Source registry was not found: ${registryPath}`);
  return readJson(registryPath);
}

async function readBindings(controlRoot) {
  const bindingsPath = path.join(controlRoot, ".project-local", "source-bindings.json");
  if (!(await isFile(bindingsPath))) refuse(`Machine-local source bindings were not found: ${bindingsPath}`);
  return readJson(bindingsPath);
}

/** Get-ControlSourceDefinition. */
export async function readSourceDefinition(controlRoot, sourceId) {
  const registry = await readRegistry(controlRoot);
  const matches = psArray(registry.sources).filter((source) => psEquals(property(source, "id"), sourceId));
  if (matches.length !== 1) refuse(`Expected exactly one registered source '${sourceId}'; found ${matches.length}.`);
  return matches[0];
}

/** Whether a registered source is a desk agent of the Claude desk route. */
export async function isDeskRouteSource(controlRoot, sourceId) {
  try {
    const registry = await readJson(path.join(fullPath(controlRoot), "config", "source-registry.json"));
    const matches = psArray(registry.sources).filter((source) => psEquals(property(source, "id"), sourceId));
    return matches.length === 1 && psString(property(matches[0], "providerRoute")) === DESK_AGENT_ROUTE;
  } catch {
    return false;
  }
}

/**
 * Resolve-ControlSourceWorkspace for a desk agent: the binding, the desk
 * route's validation (in-process, where the script runs node.exe on
 * desk-agent-source-validation.mjs), the inbox and outbox paths.
 */
export async function resolveControlSourceWorkspace(controlRoot, sourceId) {
  const source = await readSourceDefinition(controlRoot, sourceId);
  const bindings = await readBindings(controlRoot);
  const sources = bindings.sources && typeof bindings.sources === "object" ? bindings.sources : null;
  const bindingKey = sources ? Object.keys(sources).find((key) => key.toLowerCase() === String(sourceId).toLowerCase()) : undefined;
  if (bindingKey === undefined) refuse(`No machine-local binding exists for source '${sourceId}'.`);
  const binding = sources[bindingKey];
  const boundWorkspace = property(binding, "workspacePath");
  const legacy = property(binding, "path");
  let workspacePath = truthy(boundWorkspace) ? psString(boundWorkspace) : truthy(legacy) ? psString(legacy) : null;
  if (isNullOrWhiteSpace(workspacePath)) refuse(`Binding '${sourceId}' requires workspacePath (or legacy path).`);
  workspacePath = fullPath(workspacePath);
  if (!(await isDirectory(workspacePath))) refuse(`Bound workspace does not exist for '${sourceId}': ${workspacePath}`);
  const configuredRoot = property(source, "workspaceRelativeSourceRoot");
  const sourceRelativeRoot = truthy(configuredRoot) ? psString(configuredRoot) : ".";
  const boundSource = property(binding, "sourcePath");
  const sourcePath = truthy(boundSource) ? fullPath(psString(boundSource))
    : sourceRelativeRoot === "." ? workspacePath : await resolveControlRelativePath(workspacePath, sourceRelativeRoot);
  if (!(await isDirectory(sourcePath))) refuse(`Bound implementation source does not exist for '${sourceId}': ${sourcePath}`);
  const route = psString(property(source, "providerRoute"));
  if (route !== DESK_AGENT_ROUTE) {
    refuse(`Source '${sourceId}' is not on the Claude desk route; its tools are the controller's PowerShell scripts.`,
      "desk_task_route_unsupported");
  }
  try {
    // The validator reads the registry entry with this exact ID, as its command line does.
    const registry = await readRegistry(controlRoot);
    const exact = psArray(registry.sources).filter((item) => item?.id === sourceId);
    if (exact.length !== 1) throw Object.assign(new Error("desk_source_identity"), { code: "desk_source_identity" });
    const validation = await validateDeskAgentSource(exact[0], workspacePath);
    if (validation.status !== "valid" || validation.routeId !== route) refuse("desk_source_result_mismatch");
  } catch (error) {
    if (error?.code === "desk_task_refused") throw error;
    refuse(`Desk agent source validation failed for '${sourceId}': ${JSON.stringify({ status: "invalid",
      problem: error?.code ?? "desk_source_invalid_document" })}`);
  }
  const taskInbox = truthy(property(source, "taskInbox")) ? psString(property(source, "taskInbox")) : ".orchestrator/tasks/inbox";
  const reportOutbox = truthy(property(source, "reportOutbox")) ? psString(property(source, "reportOutbox"))
    : ".orchestrator/reports/outbox";
  const adapter = property(source, "executionAdapter");
  return {
    sourceId, definition: source, binding, workspacePath, sourcePath, launcherPath: null, launcherRelativePath: null,
    runtimePath: path.join(workspacePath, ".project-runtime"),
    taskInboxPath: await resolveControlRelativePath(workspacePath, taskInbox, { allowMissing: true }),
    taskInboxRelativePath: taskInbox.replaceAll("\\", "/"),
    reportOutboxPath: await resolveControlRelativePath(workspacePath, reportOutbox, { allowMissing: true }),
    reportOutboxRelativePath: reportOutbox.replaceAll("\\", "/"),
    executionAdapter: truthy(adapter) ? psString(adapter) : "handoff-file",
  };
}

// ---------------------------------------------------------------------------
// dispatch_child_task.ps1

/** Convert-ToTaskStringArray, with the function output PowerShell assigns (see AUTOMATION_NULL). */
function taskStrings(value, name, { relativePaths = false } = {}) {
  const items = [];
  for (const entry of psArray(value)) {
    if (entry === null) continue;
    let item = psString(entry);
    if (isNullOrWhiteSpace(item)) refuse(`Task field '${name}' may not contain an empty value.`);
    assertControlDurableText(item, `task field '${name}'`);
    if (relativePaths) {
      assertControlRelativeReference(item, `task field '${name}'`);
      item = item.replaceAll("\\", "/");
    }
    items.push(item);
  }
  return functionOutput(items);
}

/** What Get-ControlObjectPropertyValue hands to a parameter: an array's items unrolled. */
function propertyValue(object, name, fallback = null) {
  const value = hasProperty(object, name) ? property(object, name) : fallback;
  return Array.isArray(value) ? functionOutput(value) : value;
}

function taskContractVersion(definition) {
  const declared = psString(propertyValue(definition, "contractVersion"));
  if (declared) return declared;
  if (hasProperty(definition, "workflowPolicy") || hasProperty(definition, "intentConfirmation")) return "v0.3.0";
  if (hasProperty(definition, "intent") || hasProperty(definition, "desiredOutcomes")) return "v0.2.0";
  return "v0.1.0";
}

function supportedTaskContracts(contract) {
  const versions = ["v0.1.0"];
  if (hasProperty(contract, "supportedTaskContractVersions")) {
    for (const version of psArray(property(contract, "supportedTaskContractVersions"))) {
      const item = psString(version);
      if (item && !versions.includes(item)) versions.push(item);
    }
  }
  const current = psString(propertyValue(contract, "taskContractVersion"));
  if (current && !versions.includes(current)) versions.push(current);
  return versions;
}

const isDateTime = (value) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?)?(Z|[+-]\d{2}:\d{2})?$/u.test(value)
  && !Number.isNaN(Date.parse(value));

function markdownList(lines, title, values) {
  lines.push(`## ${title}`, "");
  const items = psArray(values);
  if (items.length === 0) lines.push("- None specified.");
  else for (const value of items) lines.push(`- ${psString(value)}`);
  lines.push("");
}

/** Get-TaskMarkdownLines: task.md of a packet. */
export function taskMarkdownLines(task) {
  const field = (name) => psString(property(task, name));
  const lines = [`# Orchestrated Task: ${field("title")}`, "", `- Task ID: \`${field("taskId")}\``,
    `- Target: \`${field("targetId")}\``, `- Contract: \`${field("contractVersion")}\``,
    `- Priority: \`${field("priority")}\``, `- Dispatched: \`${field("dispatchedAtUtc")}\``,
    `- Execution adapter: \`${field("executionAdapter")}\``, ""];
  // The script's "Execution Profile" section asks the packet's PSObject for an
  // executionProfile property; the packet is an ordered dictionary there, whose
  // keys are no such properties, so task.md never has that section.
  const version = field("contractVersion");
  const intentFirst = psIn(version, ["v0.2.0", "v0.3.0"]);
  if (intentFirst) {
    lines.push("## Intent", "", field("intent"), "");
    markdownList(lines, "Desired Outcomes", property(task, "desiredOutcomes"));
    if (psEquals(version, "v0.3.0")) {
      const confirmation = property(task, "intentConfirmation");
      lines.push("## Confirmed Workflow", "", `- Policy: \`${field("workflowPolicy")}\``,
        `- Intent confirmed by: \`${psString(property(confirmation, "confirmedBy"))}\``,
        `- Intent confirmed at: \`${psString(property(confirmation, "confirmedAtUtc"))}\``,
        "- Implementation remains locked until the child plan is separately confirmed.", "");
    }
  } else {
    lines.push("## Objective", "", field("objective"), "");
  }
  lines.push("## Responsibility Boundary", "", field("responsibilityBoundary"), "");
  if (intentFirst) {
    lines.push("## Execution Authority", "", "The target project owns concrete file selection, implementation, local"
      + " architecture, and local validation. The coordinator owns intent, external constraints, and cross-project"
      + " acceptance.", "");
    markdownList(lines, "Required Reading", property(task, "requiredReading"));
    markdownList(lines, "Forbidden Paths", property(task, "forbiddenPaths"));
    markdownList(lines, "Constraints", property(task, "constraints"));
    markdownList(lines, "Deliverables", property(task, "deliverables"));
  } else {
    markdownList(lines, "Acceptance Criteria", property(task, "acceptanceCriteria"));
    markdownList(lines, "Required Reading", property(task, "requiredReading"));
    markdownList(lines, "Allowed Paths (Maximum Safety Boundary)", property(task, "allowedPaths"));
    markdownList(lines, "Forbidden Paths", property(task, "forbiddenPaths"));
    markdownList(lines, "Constraints", property(task, "constraints"));
    markdownList(lines, "Deliverables", property(task, "deliverables"));
  }
  lines.push("## Completion Protocol", "",
    "1. Invoke `$execute-orchestrated-task` and validate this task against the local owner scope.",
    "2. Acknowledge the task with the bundled `accept_task.ps1` script.",
    "3. Inspect the current project and choose the implementation files and local validation plan inside the target's"
      + " owner boundary.");
  if (psEquals(version, "v0.3.0")) {
    lines.push("4. Publish the proposed plan, stop, and record explicit user confirmation with `confirm_task_plan.ps1`.",
      "5. Record the pre-implementation checkpoint before changing source or behavior.",
      "6. Submit an immutable report with `submit_report.ps1`.",
      "7. Do not edit this task packet or plan approval after creation.");
  } else {
    lines.push("4. Submit an immutable report with `submit_report.ps1`.", "5. Do not edit this task packet after dispatch.");
  }
  lines.push("");
  return lines;
}

/** Write-TaskPackage: task.json, task.md and task.sha256; the packet's hash. */
async function writeTaskPackage(directory, task) {
  await mkdir(directory, { recursive: true });
  const taskJsonPath = path.join(directory, "task.json");
  await writePsJson(taskJsonPath, task);
  await writeLinesUtf8NoBom(path.join(directory, "task.md"), taskMarkdownLines(task));
  const hash = await sha256File(taskJsonPath);
  await writeTextUtf8NoBom(path.join(directory, "task.sha256"), `${hash}  task.json\n`);
  return hash;
}

/**
 * Dispatches a task definition to a desk agent: the immutable packet in
 * coordination/tasks/dispatched and the same bytes in the agent's inbox.
 * Parameters as the script's: SourceId, TaskDefinitionPath, RepoRoot
 * (OpenWorkspace and WhatIf are not offered on this route).
 */
export async function dispatchChildTask(parameters, { output, clock = () => new Date() }) {
  const sourceIdParameter = psString(parameters.SourceId);
  if (!parameters.SourceId) refuse("Cannot process command because of one or more missing mandatory parameters: SourceId.");
  if (!parameters.TaskDefinitionPath) {
    refuse("Cannot process command because of one or more missing mandatory parameters: TaskDefinitionPath.");
  }
  if (!netMatch(SOURCE_ID_PATTERN, sourceIdParameter)) {
    refuse(`Cannot validate argument on parameter 'SourceId'. The argument "${sourceIdParameter}" does not match the`
      + ` "${SOURCE_ID_PATTERN}" pattern. Supply an argument that matches "${SOURCE_ID_PATTERN}" and try the command again.`);
  }
  if (psBool(parameters.OpenWorkspace)) refuse("OpenWorkspace is not available for a desk agent.", "desk_task_input_invalid");
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  const sourceId = sourceIdParameter;
  return withToolRun({ root, toolName: "dispatch_child_task", output, parameters: { SourceId: sourceId,
    TaskDefinitionPath: psString(parameters.TaskDefinitionPath), OpenWorkspace: false,
    NoOpenTaskFile: psBool(parameters.NoOpenTaskFile), WhatIf: false, RepoRoot: psString(parameters.RepoRoot) } }, async () => {
    const definitionPath = fullPath(parameters.TaskDefinitionPath);
    if (!(await exists(definitionPath))) refuse(`Cannot find path '${definitionPath}' because it does not exist.`);
    if ((await stat(definitionPath)).size > 1_048_576) refuse("Task definition exceeds the 1 MiB limit.");
    const definitionText = await readAllText(definitionPath);
    assertControlDurableText(definitionText, "task definition");
    const definition = JSON.parse(definitionText);
    const definitionHash = await sha256File(definitionPath);
    const version = taskContractVersion(definition);
    if (!psIn(version, ["v0.1.0", "v0.2.0", "v0.3.0"])) refuse(`Unsupported task definition contract '${version}'.`);
    const taskId = psString(propertyValue(definition, "taskId"));
    if (!netMatch("^[a-z0-9][a-z0-9.-]{2,95}$", taskId)) refuse("taskId must match ^[a-z0-9][a-z0-9.-]{2,95}$");
    const targetId = psString(hasProperty(definition, "targetId") ? propertyValue(definition, "targetId") : sourceId);
    if (!psEquals(targetId, sourceId)) refuse(`Task targetId '${targetId}' does not match requested source '${sourceId}'.`);
    const title = psString(propertyValue(definition, "title"));
    const responsibilityBoundary = psString(propertyValue(definition, "responsibilityBoundary"));
    if (isNullOrWhiteSpace(title) || isNullOrWhiteSpace(responsibilityBoundary)) {
      refuse("Task definition requires non-empty title and responsibilityBoundary.");
    }
    for (const item of [title, responsibilityBoundary]) assertControlDurableText(item, "task text");

    const source = await resolveControlSourceWorkspace(root, sourceId);
    const contractPath = path.join(source.workspacePath, ".orchestrator", "contract.json");
    if (!(await isFile(contractPath))) {
      refuse(`Child coordination kit is not installed for '${sourceId}'. Run tools/install_child_coordination_kit.bat first.`);
    }
    const childContract = await readJson(contractPath);
    if (!psEquals(property(childContract, "sourceId"), sourceId)) refuse(`Child contract sourceId does not match '${sourceId}'.`);
    const supported = supportedTaskContracts(childContract);
    if (!psIn(version, supported)) {
      refuse(`Child '${sourceId}' does not support task contract '${version}'; supported: ${supported.join(", ")}.`);
    }

    const artifactReferences = [];
    for (const artifact of psArray(propertyValue(definition, "artifactReferences", []))) {
      const kind = psString(propertyValue(artifact, "kind"));
      const artifactPath = psString(propertyValue(artifact, "path"));
      if (!psIn(kind, ["file", "image", "audio", "video", "directory", "log"])) refuse(`Unsupported artifact kind '${kind}'.`);
      assertControlRelativeReference(artifactPath, "artifact path");
      const sha256 = psString(propertyValue(artifact, "sha256"));
      if (sha256 && !netMatch("^[a-fA-F0-9]{64}$", sha256)) refuse("Artifact sha256 must contain 64 hexadecimal characters.");
      artifactReferences.push(psCustomObject({ kind, path: artifactPath.replaceAll("\\", "/"),
        sha256: sha256 ? sha256.toLowerCase() : null }));
    }
    const priority = psString(hasProperty(definition, "priority") ? propertyValue(definition, "priority") : "normal");
    if (!psIn(priority, ["low", "normal", "high", "critical"])) refuse("Task priority must be low, normal, high, or critical.");
    const list = (name, options) => taskStrings(hasProperty(definition, name) ? propertyValue(definition, name)
      : AUTOMATION_NULL, name, options);
    const requiredReading = list("requiredReading", { relativePaths: true });
    const forbiddenPaths = list("forbiddenPaths", { relativePaths: true });
    const constraints = list("constraints");
    const deliverables = list("deliverables");
    if (psArray(deliverables).length === 0) refuse("Task definition requires at least one deliverable.");

    let executionProfile = null;
    const requestedProfile = propertyValue(definition, "executionProfile");
    if (truthy(requestedProfile)) {
      if (psEquals(version, "v0.1.0")) refuse("Legacy task contract v0.1.0 does not support executionProfile.");
      const profileProvider = psString(propertyValue(requestedProfile, "provider"));
      const profileModel = psString(propertyValue(requestedProfile, "model"));
      const profileEffort = psString(propertyValue(requestedProfile, "reasoningEffort"));
      const profileFallback = psString(propertyValue(requestedProfile, "fallbackPolicy"));
      // Every source runs on Claude Code: the Codex sources ("openai") left with the Codex path.
      const expectedProvider = "anthropic";
      if (!psEquals(profileProvider, expectedProvider)) refuse(`executionProfile.provider must be '${expectedProvider}'.`);
      if (isNullOrWhiteSpace(profileModel)) refuse("executionProfile.model is required.");
      if (isNullOrWhiteSpace(profileEffort)) refuse("executionProfile.reasoningEffort is required.");
      if (!psEquals(profileFallback, "deny")) refuse("executionProfile.fallbackPolicy must be 'deny'.");
      for (const item of [profileModel, profileEffort]) assertControlDurableText(item, "execution profile");
      executionProfile = { provider: expectedProvider, model: profileModel, reasoningEffort: profileEffort,
        fallbackPolicy: "deny" };
    }

    const allowSubagents = psBool(hasProperty(definition, "allowSubagents") ? propertyValue(definition, "allowSubagents") : true);
    let task;
    if (psIn(version, ["v0.2.0", "v0.3.0"])) {
      if (hasProperty(definition, "objective") || hasProperty(definition, "acceptanceCriteria")
          || hasProperty(definition, "allowedPaths")) {
        refuse(`Task definition ${version} must use intent and desiredOutcomes and must not prescribe objective,`
          + " acceptanceCriteria, or allowedPaths.");
      }
      const intent = psString(propertyValue(definition, "intent"));
      const desiredOutcomes = list("desiredOutcomes");
      if (isNullOrWhiteSpace(intent) || psArray(desiredOutcomes).length === 0) {
        refuse(`Task definition ${version} requires non-empty intent and desiredOutcomes.`);
      }
      assertControlDurableText(intent, "task intent");
      const head = { schemaVersion: 1, contractVersion: version };
      if (psEquals(version, "v0.3.0")) {
        const workflowPolicy = psString(propertyValue(definition, "workflowPolicy"));
        const confirmation = propertyValue(definition, "intentConfirmation");
        if (!psEquals(workflowPolicy, "intent-confirm-plan-v1")) {
          refuse("Task definition v0.3.0 requires workflowPolicy 'intent-confirm-plan-v1'.");
        }
        if (!truthy(confirmation) || !psEquals(property(confirmation, "status"), "confirmed")) {
          refuse("Task definition v0.3.0 requires an explicit confirmed intentConfirmation.");
        }
        const confirmedBy = psString(propertyValue(confirmation, "confirmedBy"));
        const confirmedAtUtc = psString(propertyValue(confirmation, "confirmedAtUtc"));
        const note = psString(propertyValue(confirmation, "note"));
        if (isNullOrWhiteSpace(confirmedBy) || isNullOrWhiteSpace(confirmedAtUtc)) {
          refuse("Task definition v0.3.0 requires confirmedBy and confirmedAtUtc.");
        }
        if (!isDateTime(confirmedAtUtc)) refuse("Task definition v0.3.0 confirmedAtUtc is not a valid date-time.");
        for (const item of [confirmedBy, note]) if (item) assertControlDurableText(item, "intent confirmation");
        Object.assign(head, { workflowPolicy, intentConfirmation: { status: "confirmed", confirmedBy, confirmedAtUtc,
          note: note ? note : null } });
      }
      task = { ...head, taskId, coordinatorId: COORDINATOR_ID, targetId: sourceId, title, intent, desiredOutcomes,
        responsibilityBoundary, priority, requiredReading, forbiddenPaths, constraints, deliverables,
        artifactReferences, allowSubagents,
        executionAuthority: { implementationOwner: "target", localValidationOwner: "target",
          crossProjectAcceptanceOwner: "coordinator" } };
      if (executionProfile) task.executionProfile = executionProfile;
    } else {
      const objective = psString(propertyValue(definition, "objective"));
      const acceptanceCriteria = list("acceptanceCriteria");
      if (isNullOrWhiteSpace(objective) || psArray(acceptanceCriteria).length === 0) {
        refuse("Legacy task definition requires non-empty objective and acceptanceCriteria.");
      }
      assertControlDurableText(objective, "legacy task objective");
      task = { schemaVersion: 1, contractVersion: "v0.1.0", taskId, coordinatorId: COORDINATOR_ID, targetId: sourceId,
        title, objective, responsibilityBoundary, priority, acceptanceCriteria, requiredReading,
        allowedPaths: list("allowedPaths", { relativePaths: true }), forbiddenPaths, constraints, deliverables,
        artifactReferences, allowSubagents };
    }
    Object.assign(task, { definitionSha256: definitionHash, dispatchedAtUtc: utcStamp(clock()),
      executionAdapter: source.executionAdapter, executionState: "awaiting-child-agent-acceptance", agentTurnStarted: false,
      reportContract: { version: psString(property(childContract, "reportContractVersion")),
        outbox: source.reportOutboxRelativePath, requiredSkill: "execute-orchestrated-task" } });

    const controlTaskDirectory = path.join(root, "coordination", "tasks", "dispatched", taskId);
    const controlTaskJsonPath = path.join(controlTaskDirectory, "task.json");
    let controlAction;
    let taskHash = null;
    if (await isFile(controlTaskJsonPath)) {
      const existing = await readJson(controlTaskJsonPath);
      if (!psEquals(existing.definitionSha256, definitionHash) || !psEquals(existing.targetId, sourceId)) {
        refuse(`Task ID '${taskId}' already exists with a different definition or target. Dispatched tasks are immutable.`);
      }
      taskHash = await sha256File(controlTaskJsonPath);
      controlAction = "already-dispatched";
    } else {
      const temporary = `${controlTaskDirectory}.tmp-${guidN()}`;
      try {
        taskHash = await writeTaskPackage(temporary, task);
        await mkdir(path.dirname(controlTaskDirectory), { recursive: true });
        if (await exists(controlTaskDirectory)) refuse(`Cannot create a file when that file already exists: ${controlTaskDirectory}`);
        await moveItem(temporary, controlTaskDirectory);
      } finally {
        await removeQuietly(temporary);
      }
      controlAction = "dispatched";
    }

    const childTaskDirectory = path.join(source.taskInboxPath, taskId);
    let childAction;
    if (await isFile(path.join(childTaskDirectory, "task.json"))) {
      const childHash = await sha256File(path.join(childTaskDirectory, "task.json"));
      if (taskHash && childHash !== taskHash) refuse(`Child inbox contains a conflicting immutable task '${taskId}'.`);
      childAction = "already-delivered";
    } else {
      const temporary = `${childTaskDirectory}.tmp-${guidN()}`;
      try {
        await mkdir(temporary, { recursive: true });
        for (const name of ["task.json", "task.md", "task.sha256"]) {
          await copyItem(path.join(controlTaskDirectory, name), path.join(temporary, name));
        }
        await mkdir(path.dirname(childTaskDirectory), { recursive: true });
        if (await exists(childTaskDirectory)) refuse(`Cannot create a file when that file already exists: ${childTaskDirectory}`);
        await moveItem(temporary, childTaskDirectory);
      } finally {
        await removeQuietly(temporary);
      }
      childAction = "delivered";
    }
    const model = executionProfile ? executionProfile.model : null;
    const effort = executionProfile ? executionProfile.reasoningEffort : null;
    output.host(`task_id: ${taskId}`);
    output.host(`task_contract_version: ${version}`);
    output.host(`task_control_action: ${controlAction}`);
    output.host(`task_child_action: ${childAction}`);
    output.host("task_open_action: not-requested");
    output.host(`task_execution_adapter: ${source.executionAdapter}`);
    output.host(`task_execution_model: ${model ?? "inherit-ui"}`);
    output.host(`task_execution_effort: ${effort ?? "inherit-ui"}`);
    output.host("task_agent_turn_started: false");
    return { SourceId: sourceId, TaskId: taskId, ContractVersion: version, DefinitionSha256: definitionHash,
      TaskSha256: taskHash, ControlTaskDirectory: controlTaskDirectory, ChildTaskDirectory: childTaskDirectory,
      ControlAction: controlAction, ChildAction: childAction, OpenAction: "not-requested",
      ExecutionAdapter: source.executionAdapter, ExecutionState: "awaiting-child-agent-acceptance", AgentTurnStarted: false,
      ExecutionModel: model, ExecutionEffort: effort };
  });
}

// ---------------------------------------------------------------------------
// install_child_coordination_kit.ps1 (registered mode)

/** Resolve-InsideRoot: a relative path inside a root, with no linked folder on the way. */
async function resolveInsideRoot(root, relativePath) {
  if (isPathRooted(relativePath) || String(relativePath).split(/[\\/]/u).includes("..")) {
    refuse(`Unsafe child kit path '${relativePath}'.`);
  }
  const resolvedRoot = fullPath(root).replace(/[\\/]+$/u, "");
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!startsInside(candidate, resolvedRoot)) refuse(`Child kit path escaped its root: '${relativePath}'.`);
  for (let ancestor = candidate; ; ancestor = path.dirname(ancestor)) {
    const info = await lstat(ancestor).catch(() => null);
    if (info?.isSymbolicLink()) refuse(`Child kit path contains a reparse point: '${relativePath}'.`);
    if (path.dirname(ancestor) === ancestor) break;
  }
  return candidate;
}

/** Write-Utf8Atomic of the installer. */
async function writeUtf8Atomic(file, textValue) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${guidN()}.tmp`;
  try {
    await writeTextUtf8NoBom(temporary, textValue);
    await moveItem(temporary, file, { force: true });
  } finally {
    await removeQuietly(temporary);
  }
}

const upperHash = async (file) => (await sha256File(file)).toUpperCase();

/**
 * Installs (or verifies) the child kit in a registered source's workspace,
 * for the desk agent's coordination folder: the kit files of its profile,
 * the component versions, contract.json and the kit manifest, with a
 * verified backup first. Parameters: SourceId, RepoRoot, PlanOnly.
 */
export async function installChildCoordinationKit(parameters, { output }) {
  const sourceId = psString(parameters.SourceId);
  if (!parameters.SourceId) refuse("Cannot process command because of one or more missing mandatory parameters: SourceId.");
  if (!netMatch(SOURCE_ID_PATTERN, sourceId)) {
    refuse(`Cannot validate argument on parameter 'SourceId'. The argument "${sourceId}" does not match the`
      + ` "${SOURCE_ID_PATTERN}" pattern. Supply an argument that matches "${SOURCE_ID_PATTERN}" and try the command again.`);
  }
  if (parameters.WorkspaceRoot || parameters.CoordinationProfile || parameters.ExpectedKitManifestSha256) {
    refuse("The unregistered selection mode is not available for a desk agent.", "desk_task_input_invalid");
  }
  const planOnly = psBool(parameters.PlanOnly);
  const root = fullPath(parameters.RepoRoot ?? process.cwd());
  return withToolRun({ root, toolName: "install_child_coordination_kit", output,
    parameters: { SourceId: sourceId, SelectionMode: "Registered" } }, async () => {
    const registry = await readJson(path.join(root, "config", "source-registry.json"));
    const bindings = await readJson(path.join(root, ".project-local", "source-bindings.json"));
    const sources = psArray(registry.sources).filter((source) => psEquals(property(source, "id"), sourceId));
    if (sources.length !== 1) refuse(`Source '${sourceId}' must occur exactly once in the controller registry.`);
    const source = sources[0];
    const bindingKey = Object.keys(bindings.sources ?? {}).find((key) => key.toLowerCase() === sourceId.toLowerCase());
    if (bindingKey === undefined) refuse(`Source '${sourceId}' has no machine-local binding.`);
    const binding = bindings.sources[bindingKey];
    let workspaceText = psString(property(binding, "workspacePath"));
    if (isNullOrWhiteSpace(workspaceText)) workspaceText = psString(property(binding, "path"));
    if (isNullOrWhiteSpace(workspaceText)) refuse(`Source '${sourceId}' binding has no workspace path.`);
    const workspaceRoot = fullPath(workspaceText);
    if (!(await isDirectory(workspaceRoot))) refuse(`Source '${sourceId}' workspace does not exist.`);
    const versionPath = await resolveInsideRoot(workspaceRoot, "project-version.json");
    const versionBefore = await readFile(versionPath);
    const projectVersion = JSON.parse(await readAllText(versionPath));
    await resolveInsideRoot(workspaceRoot, ".orchestrator/contract.json");
    await resolveInsideRoot(workspaceRoot, ".orchestrator/kit-manifest.json");

    const kitRoot = path.join(root, "coordination", "child-agent-kit");
    const manifestPath = path.join(kitRoot, "kit-manifest.json");
    const manifest = await readJson(manifestPath);
    if (Number(manifest.schemaVersion) !== 1 || psArray(manifest.files).length === 0 || !truthy(manifest.profiles)
        || !truthy(manifest.componentVersions)) {
      refuse("Child coordination kit manifest is incompatible.");
    }
    let profileId = hasProperty(source, "coordinationProfile") ? psString(property(source, "coordinationProfile")) : null;
    if (isNullOrWhiteSpace(profileId)
        && psEquals(property(source, "executionAdapter"), "claude-code-workspace-handoff-v1")) {
      profileId = "claude-handoff";
    }
    // A source without a profile was a Codex child: that kit left with the Codex path.
    if (isNullOrWhiteSpace(profileId) || psEquals(profileId, "codex")) {
      refuse("The Codex coordination profile left the product; the source needs a Claude Code profile.",
        "desk_task_route_unsupported");
    }
    if (!hasProperty(manifest.profiles, profileId)) refuse(`Child coordination profile '${profileId}' is unavailable.`);
    if (psEquals(profileId, "foreign-provider-handoff")) {
      refuse("The foreign provider profile is installed by the controller's PowerShell tool.", "desk_task_route_unsupported");
    }
    const profile = property(manifest.profiles, profileId);
    const sourceExecutorState = hasProperty(source, "executorState") ? psString(property(source, "executorState")) : null;
    if (sourceExecutorState && !psEquals(sourceExecutorState, property(profile, "executorState"))) {
      refuse(`Source executor state does not match coordination profile '${profileId}'.`);
    }
    const excluded = [...psArray(manifest.commonExcludedFiles), ...psArray(property(profile, "excludedFiles"))].map(psString);
    const selected = psArray(manifest.files).filter((file) => !psIn(psString(file), excluded));
    const copies = [];
    for (const relative of selected) {
      const portable = psString(relative).replaceAll("/", "\\");
      const sourcePath = await resolveInsideRoot(kitRoot, portable.replaceAll("\\", path.sep));
      const destinationPath = await resolveInsideRoot(workspaceRoot, portable.replaceAll("\\", path.sep));
      if (!(await isFile(sourcePath))) refuse(`Child kit source is missing: ${psString(relative)}`);
      copies.push({ relative: psString(relative), source: sourcePath, destination: destinationPath });
    }
    const apply = !planOnly;
    let backupRoot = null;
    if (apply) {
      backupRoot = path.join(root, ".project-local", "child-kit-backups", sourceId, guidN());
      const backupEntries = [];
      for (const relative of [...copies.map((copy) => copy.relative), "project-version.json", ".orchestrator/contract.json",
        ".orchestrator/kit-manifest.json"]) {
        const original = await resolveInsideRoot(workspaceRoot, relative);
        if (!(await isFile(original))) continue;
        const saved = await resolveInsideRoot(backupRoot, relative);
        await mkdir(path.dirname(saved), { recursive: true });
        await copyItem(original, saved);
        const originalHash = await sha256File(original);
        if (await sha256File(saved) !== originalHash) refuse(`Child kit backup verification failed: ${relative}`);
        backupEntries.push({ path: relative, sha256: originalHash });
      }
      await writeUtf8Atomic(path.join(backupRoot, "backup.json"), `${psJson({ schemaVersion: 1, sourceId, workspaceRoot,
        kitVersion: psString(manifest.kitVersion), files: backupEntries })}\n`);
    }
    let copied = 0;
    let unchanged = 0;
    const deferred = [];
    for (const copy of copies) {
      const sourceHash = await upperHash(copy.source);
      const destinationHash = await isFile(copy.destination) ? await upperHash(copy.destination) : null;
      if (sourceHash === destinationHash) { unchanged += 1; continue; }
      if (apply) {
        await mkdir(path.dirname(copy.destination), { recursive: true });
        const temporary = `${copy.destination}.${process.pid}.tmp`;
        try {
          await copyItem(copy.source, temporary);
          if (await upperHash(temporary) !== sourceHash) refuse(`Child kit copy hash mismatch: ${copy.relative}`);
          await moveItem(temporary, copy.destination, { force: true });
        } finally {
          await removeQuietly(temporary);
        }
        copied += 1;
      } else deferred.push(copy.destination);
    }
    if (!hasProperty(projectVersion, "componentVersions")) projectVersion.componentVersions = {};
    let versionChanged = false;
    for (const [name, value] of Object.entries(manifest.componentVersions)) {
      const versions = projectVersion.componentVersions;
      const key = Object.keys(versions).find((item) => item.toLowerCase() === name.toLowerCase());
      if (key === undefined || !psEquals(versions[key], value)) {
        versions[key ?? name] = psString(value);
        versionChanged = true;
      }
    }
    let versionUpdateApplied = false;
    if (versionChanged && apply) {
      if (!(await readFile(versionPath)).equals(versionBefore)) {
        refuse("Owner project version changed during kit installation; inspect the preserved backup before recovery.");
      }
      await writeUtf8Atomic(versionPath, `${psJson(projectVersion)}\n`);
      versionUpdateApplied = true;
    }
    const contract = {
      schemaVersion: 1, sourceId, kitVersion: psString(manifest.kitVersion), kitProfile: profileId,
      executorState: psString(property(profile, "executorState")), taskContractVersion: psString(manifest.taskContractVersion),
      supportedTaskContractVersions: psArray(manifest.supportedTaskContractVersions),
      reportContractVersion: psString(manifest.reportContractVersion), taskInbox: psString(property(source, "taskInbox")),
      reportOutbox: psString(property(source, "reportOutbox")), coordinatorId: COORDINATOR_ID,
    };
    const contractPath = path.join(workspaceRoot, ".orchestrator", "contract.json");
    const childManifestPath = path.join(workspaceRoot, ".orchestrator", "kit-manifest.json");
    const expectedManifestSha256 = await sha256File(manifestPath);
    const desiredCanonical = psJson(contract, { compress: true });
    const existingCanonical = await isFile(contractPath) ? psJson(await readJson(contractPath), { compress: true }) : null;
    const contractChanged = existingCanonical === null || !psEquals(existingCanonical, desiredCanonical);
    const manifestChanged = !(await isFile(childManifestPath)) || await sha256File(childManifestPath) !== expectedManifestSha256;
    let contractApplied = !contractChanged;
    let manifestApplied = !manifestChanged;
    if (contractChanged && apply) {
      await writeUtf8Atomic(contractPath, `${psJson(contract)}\n`);
      contractApplied = true;
    }
    if (manifestChanged && apply) {
      const temporary = `${childManifestPath}.${process.pid}.${guidN()}.tmp`;
      try {
        await copyItem(manifestPath, temporary);
        if (await sha256File(temporary) !== expectedManifestSha256) refuse("Copied child kit manifest hash mismatch.");
        await moveItem(temporary, childManifestPath, { force: true });
      } finally {
        await removeQuietly(temporary);
      }
      manifestApplied = true;
    }
    if (contractApplied && !psEquals(psJson(await readJson(contractPath), { compress: true }), desiredCanonical)) {
      refuse("Installed child coordination contract failed verification.");
    }
    if (manifestApplied && await sha256File(childManifestPath) !== expectedManifestSha256) {
      refuse("Installed child kit manifest failed verification.");
    }
    for (const copy of copies) {
      if (deferred.includes(copy.destination)) continue;
      if (await upperHash(copy.source) !== await upperHash(copy.destination)) {
        refuse(`Installed child kit failed verification: ${copy.relative}`);
      }
    }
    output.host(`child_source_id: ${sourceId}`);
    output.host(`child_kit_version: ${psString(manifest.kitVersion)}`);
    output.host(`child_kit_profile: ${profileId}`);
    output.host(`child_executor_state: ${psString(property(profile, "executorState"))}`);
    output.host(`child_kit_files: ${copies.length}`);
    output.host(`child_kit_copied: ${copied}`);
    output.host(`child_kit_unchanged: ${unchanged}`);
    return { SourceId: sourceId, SelectionMode: "Registered", BackupRoot: backupRoot, ProviderStarted: false,
      RegistrationChanged: false, WorkspaceRoot: workspaceRoot, KitVersion: psString(manifest.kitVersion), KitProfile: profileId,
      ExecutorState: psString(property(profile, "executorState")), FileCount: copies.length, CopiedCount: copied,
      UnchangedCount: unchanged, DeferredCount: deferred.length, ComponentVersionsUpdated: versionUpdateApplied,
      ContractUpdated: contractChanged && contractApplied, ManifestUpdated: manifestChanged && manifestApplied,
      ContractPath: contractPath, ManifestSha256: expectedManifestSha256 };
  });
}

// ---------------------------------------------------------------------------
// The controller tools by name: the call shapes of the PowerShell runners

/**
 * The kit installer in the shape registerDeskAgentSource expects of its
 * `installKit(root, sourceId)`: { code, output }.
 */
export function installDeskAgentKit(controllerRoot, sourceId) {
  return runInProcess((output) => installChildCoordinationKit({ SourceId: sourceId, RepoRoot: controllerRoot }, { output }));
}

/** Named arguments of a -File command line ("-Name value", "-Switch"). */
function namedArguments(args) {
  const parameters = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (!token.startsWith("-")) return null;
    const next = args[index + 1];
    if (next === undefined || String(next).startsWith("-")) parameters[token.slice(1)] = true;
    else {
      parameters[token.slice(1)] = String(next);
      index += 1;
    }
  }
  return parameters;
}

const CONTROLLER_TOOLS = Object.freeze({
  dispatch_child_task: dispatchChildTask,
  install_child_coordination_kit: installChildCoordinationKit,
});

/**
 * Runs a controller tool in-process in the call shape of the coordinator's
 * PowerShell runner (desk-coordinator-tools.mjs): the script's path, its
 * -File arguments; the answer { code, output }.
 */
export async function runDeskControllerTool(script, args, { clock } = {}) {
  const name = path.basename(String(script)).replace(/\.ps1$/iu, "");
  const implementation = CONTROLLER_TOOLS[name];
  const parameters = namedArguments(args ?? []);
  if (!implementation || parameters === null) return { code: 1, output: `ERROR: No in-process tool for '${name}'.` };
  if (!parameters.RepoRoot) parameters.RepoRoot = path.resolve(path.dirname(String(script)), "..");
  return runInProcess((output) => implementation(parameters, { output, ...(clock ? { clock } : {}) }));
}

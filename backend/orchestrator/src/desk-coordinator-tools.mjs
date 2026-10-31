import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { readDeskAgentSource } from "./desk-agent-sources.mjs";
import { runDeskControllerTool } from "./desk-task-controller.mjs";
import {
  DESK_CONTINUATION_POLICIES, DESK_REPORT_OPERATIONS, deskTaskId, readDeskTaskStatus, readDispatchedDeskTask,
  startDeskTask,
} from "./desk-tasks.mjs";

// The coordinator's desk tools (claude-code-controller.md): the main
// orchestrator of the controller is a desk agent with role coordinator. These
// tools give it the controller's task workflow - which agents can take tasks,
// dispatch through the controller's own dispatch tool, start, status, report -
// without shell access for its bookkeeping. They answer in plain text.

export const DESK_COORDINATOR_TOOLS_VERSION = "v0.3.0";

function runPowerShellFile(script, args, { cwd, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, ...args], { cwd, windowsHide: true });
    let output = "";
    const collect = (chunk) => { if (output.length < 64 * 1024) output += chunk; };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, output }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

function said(output, lines = 30) {
  return String(output ?? "").replace(/\r/gu, "").split("\n")
    .filter((line) => line.trim() && !/^\s*(\+|At |CategoryInfo|FullyQualifiedErrorId|#< CLIXML)/u.test(line))
    .slice(-lines).join("\n").slice(-6000);
}

const reasons = {
  desk_task_not_dispatched: "no such task was dispatched",
  desk_task_target_not_desk_agent: "the task's target is not a registered desk agent",
  desk_task_inbox_mismatch: "the agent's inbox does not hold the dispatched packet",
  desk_task_return_conflict: "this task was already started with another return contract",
  desk_task_operation_unsupported: "the report operation must be accept, show, import-only, summarize or review",
  desk_task_continuation_invalid: "the continuation must be stop-after-report or require-user-decision",
  desk_task_id_invalid: "that is not a task ID",
  memory_agent_busy: "the agent is working on another message; start the task when it is free",
  memory_workspace_busy: "another agent of the same folder is working and their zones may meet; start later",
  memory_agent_closed: "the agent is closed",
  memory_provider_unavailable: "Claude Code is not available for the agent (signed out?)",
  observability_unavailable: "the Gateway's visible monitor is not running",
};

// The controller's own dispatch tool runs in this process (desk-task-controller.mjs,
// byte for byte what dispatch_child_task.ps1 writes); `runPowerShellFile` stays for
// a caller that passes it explicitly.
export function createDeskCoordinatorTools({ controllerRoot, service, run = runDeskControllerTool, now = () => new Date() }) {
  const root = path.resolve(controllerRoot);
  const answer = (action) => async (args) => {
    try { return await action(args ?? {}); } catch (error) {
      return `Nothing done: ${reasons[error?.code] ?? error?.code ?? "the desk refused"}.`;
    }
  };
  return (coordinator) => [
    {
      name: "controller_agents",
      description: "Lists the desk agents: project, quarter, role, write zone, whether they are busy or free, and"
        + " whether they are registered to take controller tasks (their source ID).",
      inputSchema: () => ({}),
      handler: answer(async () => {
        const agents = await service.listActivity();
        const lines = [];
        for (const agent of agents.filter((item) => item.state !== "archived")) {
          const source = await readDeskAgentSource({ controllerRoot: root, agentId: agent.agentId });
          const zone = agent.settings.role === "feature" ? (agent.settings.writeZone?.join(", ") ?? "whole folder")
            : agent.settings.role;
          lines.push(`${agent.agentId} | ${agent.projectId}/${agent.quarterId} | ${agent.settings.role} | zone: ${zone}`
            + ` | ${agent.activity.state} | ${source ? `source ${source.sourceId}` : "not registered for tasks"}`);
        }
        return lines.length ? lines.join("\n") : "No desk agents.";
      }),
    },
    {
      name: "controller_dispatch",
      description: "Dispatches a task the person confirmed to a desk agent through the controller's own dispatch"
        + " tool; the packet becomes immutable. The definition is JSON with taskId, targetId (the agent's source ID,"
        + " see controller_agents), title, intent, desiredOutcomes (list), responsibilityBoundary, priority (low,"
        + " normal, high), requiredReading, forbiddenPaths, constraints, deliverables, artifactReferences (lists)"
        + " and allowSubagents. It is sent as task contract v0.3.0: the agent publishes its plan and waits for the"
        + " person's confirmation before it implements. Confirm intent, outcomes, boundary and the return contract"
        + " with the person first; this tool records that confirmation.",
      inputSchema: (z) => ({ definition: z.string().describe("The task definition as JSON text") }),
      handler: answer(async (args) => {
        let definition;
        try { definition = JSON.parse(String(args.definition ?? "")); } catch { return "Nothing done: the definition is not JSON."; }
        const taskId = deskTaskId(definition?.taskId);
        if (typeof definition.targetId !== "string" || !/^desk-[a-z0-9-]{1,59}$/u.test(definition.targetId)) {
          return "Nothing done: targetId must be a desk agent's source ID.";
        }
        // Desk agents always get the v0.3.0 workflow (intent confirmed, plan confirmed before implementation):
        // the coordinator dispatches only what the person confirmed in its conversation.
        Object.assign(definition, { contractVersion: "v0.3.0", workflowPolicy: "intent-confirm-plan-v1",
          intentConfirmation: { status: "confirmed", confirmedBy: "project-owner", confirmedAtUtc: now().toISOString(),
            note: "Confirmed with the coordinator in the desk." } });
        const file = path.join(root, ".project-local", "desk-coordinator", "definitions", `${taskId}.json`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(definition, null, 2)}\n`, "utf8");
        const result = await run(path.join(root, "tools", "dispatch_child_task.ps1"),
          ["-SourceId", definition.targetId, "-TaskDefinitionPath", file, "-RepoRoot", root], { cwd: root });
        return `${result.code === 0 ? "Dispatched." : `Refused (exit ${result.code}).`}\n${said(result.output)}`;
      }),
    },
    {
      name: "controller_start_task",
      description: "Starts a dispatched task: the agent gets it as one message (never twice). reportOperation is what"
        + " runs when the report arrives (accept, show, import-only, summarize, or review by the controller's"
        + " reviewer) and continuation what you do then"
        + " (stop-after-report or require-user-decision) - both as confirmed with the person.",
      inputSchema: (z) => ({ taskId: z.string(), reportOperation: z.enum([...DESK_REPORT_OPERATIONS]).optional(),
        continuation: z.enum([...DESK_CONTINUATION_POLICIES]).optional() }),
      handler: answer(async (args) => {
        const started = await startDeskTask({ controllerRoot: root, service, taskId: args.taskId,
          coordinatorAgentId: coordinator.agentId, reportOperation: args.reportOperation ?? "accept",
          continuationPolicy: args.continuation ?? "stop-after-report" });
        const state = started.operation?.state ?? "unknown";
        return `Started ${started.taskId} on ${started.agentId} (message ${state}). You will get a message when its`
          + " report arrives.";
      }),
    },
    {
      name: "controller_task_status",
      description: "Shows a dispatched task: its agent, whether it was started, the agent's latest progress"
        + " (state, lifecycle stage, what it does now) and its report status.",
      inputSchema: (z) => ({ taskId: z.string() }),
      handler: answer(async (args) => JSON.stringify(await readDeskTaskStatus({ controllerRoot: root,
        taskId: args.taskId }), null, 2)),
    },
    {
      name: "controller_read_report",
      description: "Reads the report an agent submitted for a task (its report.md).",
      inputSchema: (z) => ({ taskId: z.string() }),
      handler: answer(async (args) => {
        const dispatched = await readDispatchedDeskTask({ controllerRoot: root, taskId: args.taskId });
        const { readFile } = await import("node:fs/promises");
        const file = path.join(dispatched.folder, ".orchestrator", "reports", "outbox", dispatched.task.taskId, "report.md");
        try { return (await readFile(file, "utf8")).slice(0, 32_768); } catch { return "No report yet."; }
      }),
    },
  ];
}

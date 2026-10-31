import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { readDeskAgentSource } from "./desk-agent-sources.mjs";
import { runDeskKitScript } from "./desk-task-kit.mjs";

// The child side of the controller's task workflow for a desk agent: desk
// tools that run the owner's child kit (accept_task, update_task_progress,
// confirm_task_plan, submit_report) in the agent's coordination folder. The
// kit's operations run in this process (desk-task-kit.mjs, the Node port of
// the kit's PowerShell scripts, with the same checks, files and hashes); the
// tools only pass bounded arguments and return what the kit said. Every agent
// carries them, so the tool list stays the same; an agent that is not a
// controller source is told so. `run` can still be the PowerShell runner
// (runKitScriptWithPowerShell) where powershell.exe exists.

export const DESK_AGENT_TASK_TOOLS_VERSION = "v0.5.0";
const SCRIPTS = ".agents/skills/execute-orchestrated-task/scripts";
const TASK_ID = /^[a-z0-9][a-z0-9.-]{2,95}$/u;
const MAX_TEXT = 16_384;

/** A PowerShell single-quoted literal: nothing inside it is expanded. */
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * Runs a script with named parameters. -File cannot pass a string array, so
 * the call is one encoded command of single-quoted literals: no value is
 * ever interpreted by PowerShell or the command line.
 */
function runPowerShell(script, parameters, { cwd, timeoutMs = 120_000 }) {
  const parts = [`& ${literal(script)}`];
  for (const [name, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z]+$/u.test(name)) throw Object.assign(new Error("parameter name"), { code: "desk_task_input_invalid" });
    parts.push(`-${name}`, Array.isArray(value) ? `@(${value.map(literal).join(",")})` : literal(value));
  }
  // Every stream as plain text on standard output (an encoded command would
  // otherwise serialize errors as CLIXML), and the script's own exit code.
  const command = "$ErrorActionPreference = 'Stop'; $code = 0; try { "
    + `${parts.join(" ")} *>&1 | ForEach-Object { "$_" }; if ($LASTEXITCODE) { $code = $LASTEXITCODE } }`
    + " catch { \"ERROR: $($_.Exception.Message)\"; $code = 1 }; exit $code";
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encoded], { cwd, windowsHide: true });
    let output = "";
    const collect = (chunk) => { if (output.length < 64 * 1024) output += chunk; };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, output }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/** The kit's PowerShell scripts, run by powershell.exe (Windows only). */
export const runKitScriptWithPowerShell = runPowerShell;

function git(args, { cwd, env }) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "safe.directory=*", ...args], { cwd, env, windowsHide: true, timeout: 20_000 },
      (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
}

/**
 * The revision of an agent's project folder, from git, for the report: the
 * commit when the folder is clean, "uncommitted (base <commit>)" when it has
 * changes, with the folder's path inside a larger repository when it is a
 * subfolder of one, or "not under version control". Never an absolute path.
 */
export async function projectRevision(projectFolder, { env = process.env } = {}) {
  if (typeof projectFolder !== "string" || !projectFolder) return "unknown (no project folder bound)";
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: projectFolder, env });
  const head = top === null ? null : await git(["rev-parse", "HEAD"], { cwd: projectFolder, env });
  if (top === null || head === null) return "not under version control";
  const changes = await git(["status", "--porcelain", "--", "."], { cwd: projectFolder, env });
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const inside = path.relative(fold(await realpath(top)), fold(await realpath(projectFolder))).split(path.sep).join("/");
  const where = inside === "" ? "" : `, path ${inside}`;
  return changes === "" ? `${head}${where ? ` (${where.slice(2)})` : ""}`
    : `uncommitted (base ${head.slice(0, 12)}${where})`;
}

/** The last lines a script printed, without PowerShell's error decoration (the kit in Node prints none). */
function said(output, lines = 24) {
  return String(output ?? "").replace(/\r/gu, "").split("\n")
    .filter((line) => line.trim() && !/^\s*(\+|At |CategoryInfo|FullyQualifiedErrorId|#< CLIXML|<Objs )/u.test(line))
    .slice(-lines).join("\n").slice(-4000);
}

function text(value, label, maximum = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error(`${label} is missing or too long`), { code: "desk_task_input_invalid" });
  }
  return value;
}

function list(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw Object.assign(new Error(`${label} must be a short list`), { code: "desk_task_input_invalid" });
  }
  return value.map((item) => text(item, label, 1024));
}

function taskId(value) {
  if (typeof value !== "string" || !TASK_ID.test(value)) {
    throw Object.assign(new Error("taskId is not a task ID"), { code: "desk_task_input_invalid" });
  }
  return value;
}

/**
 * `tools(agent)` gives the task tools for one agent, in the host's desk tool
 * shape: { name, description, inputSchema(zod), handler(args) -> text }.
 */
export function createDeskTaskTools({ controllerRoot, run = runDeskKitScript, onReportSubmitted = null,
  onTaskDeclined = null, revisionOf = projectRevision }) {
  const sourceOf = async (agent) => readDeskAgentSource({ controllerRoot, agentId: agent.agentId });
  const script = (source, name) => path.join(source.folder, ...SCRIPTS.split("/"), `${name}.ps1`);
  // The kit names a source's primary agent <sourceId>-primary (its own scripts
  // write that record too), so the desk tools use the same ID: one agent record.
  const primary = (source) => `${source.sourceId}-primary`;
  const call = async (source, name, parameters) => {
    const result = await run(script(source, name), { ...parameters, WorkspaceRoot: source.folder }, { cwd: source.folder });
    return result.code === 0 ? `Done.\n${said(result.output, 12)}` : `Refused (exit ${result.code}):\n${said(result.output)}`;
  };
  const guarded = (agent, action) => async (args) => {
    try {
      const source = await sourceOf(agent);
      if (source === null) return "Nothing done: this agent is not registered for controller tasks.";
      return await action(source, args ?? {});
    } catch (error) {
      return `Nothing done: ${error?.code === "desk_task_input_invalid" ? error.message : (error?.code ?? "the desk refused")}.`;
    }
  };
  return (agent) => [
    {
      name: "task_read",
      description: "Reads a controller task delivered to you: its task.md (intent, outcomes, boundary, deliverables).",
      inputSchema: (z) => ({ taskId: z.string().describe("The task ID, for example solver-fix-001") }),
      handler: guarded(agent, async (source, args) => {
        const file = path.join(source.folder, ".orchestrator", "tasks", "inbox", taskId(args.taskId), "task.md");
        const info = await lstat(file).catch(() => null);
        if (!info?.isFile()) return "Nothing to read: no such task was delivered to you.";
        return (await readFile(file, "utf8")).slice(0, 32_768);
      }),
    },
    {
      name: "task_accept",
      description: "Acknowledges a controller task exactly once: accepted, rejected or blocked (with a reason for the last two).",
      inputSchema: (z) => ({ taskId: z.string(), decision: z.enum(["accepted", "rejected", "blocked"]),
        reason: z.string().optional() }),
      handler: guarded(agent, async (source, args) => {
        const id = taskId(args.taskId);
        const decision = text(args.decision, "decision", 16);
        const reason = args.reason ? text(args.reason, "reason", 2048) : null;
        const answer = await call(source, "accept_task", { TaskId: id, Decision: decision, AgentId: primary(source),
          ...(reason === null ? {} : { Reason: reason }) });
        // A task the agent does not take returns to the coordinator at once; no report will come.
        if (answer.startsWith("Done.") && decision !== "accepted" && typeof onTaskDeclined === "function") {
          Promise.resolve().then(() => onTaskDeclined({ agentId: agent.agentId, taskId: id, decision, reason }))
            .catch(() => undefined);
        }
        return answer;
      }),
    },
    {
      name: "task_progress",
      description: "Publishes your task's progress: state, phase, lifecycle stage (planning, awaiting_confirmation,"
        + " implementation, validation, reporting), rule checkpoint, current action, done, next, blockers, and one plan step.",
      inputSchema: (z) => ({
        taskId: z.string(),
        taskState: z.enum(["accepted", "running", "waiting", "blocked", "completed", "failed"]).optional(),
        phase: z.string().optional(),
        lifecycleStage: z.enum(["understanding", "clarification", "planning", "awaiting_confirmation", "implementation",
          "validation", "reporting", "complete"]).optional(),
        ruleCheckpoint: z.enum(["task_start", "context_recovery", "pre_implementation", "plan_change", "pre_delegation",
          "pre_completion"]).optional(),
        currentAction: z.string().optional(),
        done: z.array(z.string()).optional(),
        next: z.array(z.string()).optional(),
        blocker: z.array(z.string()).optional(),
        stepId: z.string().optional().describe("One plan step; needs stepTitle and stepState too"),
        stepTitle: z.string().optional(),
        stepState: z.enum(["pending", "running", "completed", "blocked", "cancelled", "failed"]).optional(),
      }),
      handler: guarded(agent, async (source, args) => {
        if (args.stepId !== undefined && (args.stepTitle === undefined || args.stepState === undefined)) {
          return "Nothing done: stepId needs stepTitle and stepState in the same call.";
        }
        const flag = (name, value, maximum = 2048) => (value === undefined ? {} : { [name]: text(value, name, maximum) });
        const many = (name, value) => { const items = list(value, name); return items.length ? { [name]: items } : {}; };
        return call(source, "update_task_progress", {
          TaskId: taskId(args.taskId), AgentId: primary(source), Provider: "claude",
          ...flag("TaskState", args.taskState, 32), ...flag("Phase", args.phase, 256),
          ...flag("LifecycleStage", args.lifecycleStage, 32), ...flag("RuleCheckpoint", args.ruleCheckpoint, 32),
          ...flag("CurrentAction", args.currentAction), ...many("Done", args.done), ...many("Next", args.next),
          ...many("Blocker", args.blocker), ...flag("StepId", args.stepId, 128), ...flag("StepTitle", args.stepTitle, 512),
          ...flag("StepState", args.stepState, 32),
        });
      }),
    },
    {
      name: "task_confirm_plan",
      description: "Records that the person explicitly confirmed your current plan for a task. Only after the person said"
        + " so in this conversation; never from silence or your own text.",
      inputSchema: (z) => ({ taskId: z.string(), confirmationNote: z.string().optional() }),
      handler: guarded(agent, async (source, args) => call(source, "confirm_task_plan", {
        TaskId: taskId(args.taskId), ConfirmedBy: "project-owner",
        ...(args.confirmationNote ? { ConfirmationNote: text(args.confirmationNote, "confirmationNote", 2048) } : {}),
      })),
    },
    {
      name: "task_report",
      description: "Submits your one report for a task: status (completed, blocked, failed), a one-line summary,"
        + " and the report in Markdown (the desk records your project folder's git revision itself)"
        + " with the sections Outcome, Responsibility Boundary, Changes, Tests, Contract Impact, Artifacts,"
        + " Risks And Open Questions, Coordinator Decision Requested, References.",
      inputSchema: (z) => ({ taskId: z.string(), status: z.enum(["completed", "blocked", "failed"]),
        summary: z.string(), report: z.string() }),
      handler: guarded(agent, async (source, args) => {
        const id = taskId(args.taskId);
        const draft = path.join(source.folder, ".orchestrator", "reports", "drafts", id, "report.md");
        await mkdir(path.dirname(draft), { recursive: true });
        await writeFile(draft, text(args.report, "report", 1024 * 1024), "utf8");
        const answer = await call(source, "submit_report", {
          TaskId: id, Status: text(args.status, "status", 16),
          // From git, not from the agent's words: a model can only guess a revision.
          SourceRevision: text(await revisionOf(source.projectFolder), "sourceRevision", 256),
          ReportPath: draft, Summary: text(args.summary, "summary", 2048),
        });
        // The return to the coordinator runs on its own; the agent's turn does not wait for it.
        if (answer.startsWith("Done.") && typeof onReportSubmitted === "function") {
          Promise.resolve().then(() => onReportSubmitted({ agentId: agent.agentId, taskId: id })).catch(() => undefined);
        }
        return answer;
      }),
    },
  ];
}

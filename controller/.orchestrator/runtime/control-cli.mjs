#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SqliteControlStore } from "./sqlite-control-store.mjs";
import { SerializedControlCycle } from "./control-cycle.mjs";
import { FakeReviewProvider } from "./control-review-provider.mjs";
import {
  CLAUDE_CODE_SERVICE_PROVIDER_ID, createClaudeReportSummarizer, createClaudeReviewProvider,
} from "./claude-code-service-client.mjs";
import { readClaudeProviderConfig } from "./claude-provider-config.mjs";
// A desk agent's reports are collected in-process (desk-task-collect.mjs);
// other sources with the configured collector command.
import { collectAllReportsByRoute, collectReportsByRoute } from "./desk-task-collect.mjs";
import {
  clearWorkerEmergencyStop,
  collectWorkerProgress,
  deliverWorkerCancellation,
} from "./control-worker-bridge.mjs";
import { compactToolRunHistory, createToolRun, readProjectVersions } from "./tool-run.mjs";
import { ServiceReviewRegistry } from "./service-review-registry.mjs";
import { ReportPresentationService } from "./report-presentation.mjs";
import { ReportOperationService, validateReportOperation } from "./report-operations.mjs";

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

function parseArguments(argv) {
  const [command = "status", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function resolveFrom(root, value, fallback) {
  return path.resolve(root, value || fallback);
}

// Claude Code reviews the reports and writes their summaries ("fake" only in
// tests). The Codex App Server reviewer, with its own CODEX_HOME and executable
// found in the isolated VS Code extensions, left with the Codex path; an old
// configuration that still names it is refused with that reason. An old
// "interactiveCodexHome" key is ignored.
const DEFAULT_REVIEW_PROVIDER = Object.freeze({ type: CLAUDE_CODE_SERVICE_PROVIDER_ID });

function reviewProvider(configuration) {
  const provider = configuration.provider ?? DEFAULT_REVIEW_PROVIDER;
  if (provider.type === "codex-app-server") {
    throw new Error("Unsupported review provider: codex-app-server (the Codex path left the product; use claude-code)");
  }
  return provider;
}

export async function loadConfiguration(configPath, { requireProvider = true } = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const configuration = await loadJson(resolvedConfigPath);
  if (configuration.schemaVersion !== 1) throw new Error("Control cycle configuration requires schemaVersion 1");
  const controllerRoot = path.resolve(configuration.controllerRoot || process.cwd());
  const runtimeRoot = resolveFrom(controllerRoot, configuration.runtimeRoot, ".project-local/orchestration");
  const publicationIntervalMs = Number(configuration.publicationIntervalMs ?? 15_000);
  if (!Number.isInteger(publicationIntervalMs) || publicationIntervalMs < 10_000 || publicationIntervalMs > 15_000) {
    throw new Error("publicationIntervalMs must be an integer between 10000 and 15000");
  }
  const provider = reviewProvider(configuration);
  if (requireProvider && provider.type === CLAUDE_CODE_SERVICE_PROVIDER_ID) {
    // A missing or broken Claude Code config is found before a queue item is
    // claimed, not by a failed review.
    await readClaudeProviderConfig(controllerRoot);
  }
  return {
    ...configuration,
    provider,
    configPath: resolvedConfigPath,
    controllerRoot,
    runtimeRoot,
    databasePath: resolveFrom(controllerRoot, configuration.databasePath, ".project-local/orchestration/control-queue.db"),
    backendCapabilitiesPath: resolveFrom(
      controllerRoot,
      configuration.backendCapabilitiesPath,
      ".project-local/projections/backend-capabilities.v1.json",
    ),
    projectionPath: resolveFrom(controllerRoot, configuration.projectionPath, ".project-local/projections/control-status.v1.json"),
    attentionProjectionPath: resolveFrom(
      controllerRoot,
      configuration.attentionProjectionPath,
      ".project-local/projections/attention-status.v1.json",
    ),
    executionSummaryRoot: resolveFrom(
      controllerRoot,
      configuration.executionSummaryRoot,
      ".project-local/execution-summaries",
    ),
    archiveRoot: resolveFrom(controllerRoot, configuration.archiveRoot, ".project-local/orchestration/archives"),
    acceptanceRoot: resolveFrom(controllerRoot, configuration.acceptanceRoot, "coordination/acceptances"),
    reportPresentationCacheRoot: resolveFrom(
      controllerRoot,
      configuration.reportPresentationCacheRoot,
      ".project-local/report-presentations",
    ),
    serviceReviewIndexPath: resolveFrom(
      controllerRoot,
      configuration.serviceReviewIndexPath,
      ".project-local/orchestration/service-review-index.v1.json",
    ),
    publicationIntervalMs,
  };
}

function waitForInterval(milliseconds, stopState) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    stopState.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function monitorProjections({ cycle, configuration }) {
  const requestedIterations = Number.parseInt(String(configuration.monitorIterations ?? ""), 10);
  const maximumIterations = Number.isInteger(requestedIterations) && requestedIterations > 0
    ? requestedIterations
    : Number.POSITIVE_INFINITY;
  const stopState = { requested: false, signal: null, wake: null };
  const requestStop = (signal) => {
    stopState.requested = true;
    stopState.signal = signal;
    stopState.wake?.();
  };
  const onSigint = () => requestStop("SIGINT");
  const onSigterm = () => requestStop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let refreshCount = 0;
  let lastProjection = null;
  try {
    while (!stopState.requested && refreshCount < maximumIterations) {
      if (configuration.workerProgress?.enabled) {
        const progress = await collectWorkerProgress({ controllerRoot: configuration.controllerRoot });
        if (progress.length > 0) await cycle.observeWorkerProgress(progress, { writeProjection: false });
        lastProjection = await cycle.writeProjection();
      } else {
        lastProjection = await cycle.writeProjection();
      }
      if (!lastProjection) lastProjection = await cycle.writeProjection();
      refreshCount += 1;
      process.stdout.write(
        `projection_refresh: ${refreshCount} published_at_utc=${lastProjection.publication.publishedAtUtc} next_due_at_utc=${lastProjection.publication.nextPublicationDueAtUtc}\n`,
      );
      if (refreshCount >= maximumIterations || stopState.requested) break;
      await waitForInterval(configuration.publicationIntervalMs, stopState);
      stopState.wake = null;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  return {
    status: stopState.requested ? "stopped_by_signal" : "iteration_limit_reached",
    signal: stopState.signal,
    refreshCount,
    publicationIntervalMs: configuration.publicationIntervalMs,
    lastPublishedAtUtc: lastProjection?.publication?.publishedAtUtc ?? null,
  };
}

export function createProvider(configuration) {
  const provider = reviewProvider(configuration);
  if (provider.type === "fake") {
    if (!configuration.allowFakeProvider) throw new Error("Fake provider requires allowFakeProvider=true");
    return new FakeReviewProvider({
      result: provider.result ?? "completed",
      delayMs: provider.delayMs ?? 25,
      spawnSubagent: Boolean(provider.spawnSubagent),
    });
  }
  if (provider.type !== CLAUDE_CODE_SERVICE_PROVIDER_ID) {
    throw new Error(`Unsupported review provider: ${provider.type}`);
  }
  // Claude Code reads its machine-local config (SDK, models) from the controller when a review starts.
  return createClaudeReviewProvider({ controllerRoot: configuration.controllerRoot, provider });
}

function runConfiguredCommand(specification, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(specification.command, specification.args ?? [], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timeoutMs = specification.timeoutMs ?? 300_000;
    const timer = setTimeout(() => {
      fail(new Error(`Integration command timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    const append = (current, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        throw new Error("Integration command output exceeded the bounded output budget");
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { fail(error); }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { fail(error); }
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Integration command failed (${code}): ${stderr.trim().slice(0, 4096)}`));
        return;
      }
      resolve({ exitCode: code, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) });
    });
  });
}

function createIntegrator(configuration, logger) {
  const specification = configuration.integrator;
  if (!specification?.command) return null;
  const allowed = new Set(specification.autoIntegrateOutcomes ?? []);
  const integrate = async ({ item, decision }) => {
    if (!allowed.has(decision.outcome)) {
      throw new Error(`Automatic integration is not enabled for outcome '${decision.outcome}'`);
    }
    if (decision.humanApprovalRequired) throw new Error("Decision requires human approval");
    await logger("control_integration_command_started", { taskId: item.taskId, outcome: decision.outcome });
    const result = await runConfiguredCommand(specification, {
      cwd: configuration.controllerRoot,
      env: {
        ORCHESTRATION_TASK_ID: item.taskId,
        ORCHESTRATION_SOURCE_ID: item.sourceId,
        ORCHESTRATION_DECISION_PATH: item.decisionPath || "",
        ORCHESTRATION_DECISION_OUTCOME: decision.outcome,
      },
    });
    await logger("control_integration_command_completed", { taskId: item.taskId, ...result });
    return { decisionReference: decision.decisionDocument ?? item.decisionPath };
  };
  integrate.shouldIntegrate = ({ decision }) => (
    allowed.has(decision.outcome) && !decision.humanApprovalRequired
  );
  return integrate;
}

function controlCommand(command, options) {
  const common = {
    requestedBy: options["requested-by"] || process.env.USERNAME || process.env.USER || "operator",
    requestedAtUtc: new Date().toISOString(),
    reason: options.reason || null,
  };
  switch (command) {
    case "pause": return { ...common, command: "pause" };
    case "drain": return { ...common, command: "drain" };
    case "resume": return { ...common, command: "resume" };
    case "emergency-stop": return { ...common, command: "emergency-stop-all" };
    case "mark-stop-unconfirmed": return { ...common, command: "mark-stop-unconfirmed" };
    case "cancel-task":
      if (!options["task-id"]) throw new Error("cancel-task requires --task-id <id>");
      return {
        ...common,
        command: "cancel-task",
        taskId: options["task-id"],
        sourceId: options["source-id"] || null,
      };
    case "cancel-agent":
      if (!options["agent-id"]) throw new Error("cancel-agent requires --agent-id <id>");
      return { ...common, command: "cancel-agent", agentId: options["agent-id"] };
    case "retry":
      if (!options["item-id"]) throw new Error("retry requires --item-id <id>");
      return { ...common, command: "retry-item", itemId: options["item-id"] };
    default: return null;
  }
}

function humanStatus(projection) {
  const active = projection.tasks.find((task) => task.taskId === projection.activeTaskId);
  const pending = projection.tasks.filter((task) => task.state === "queued");
  return [
    `mode: ${projection.mode}`,
    `health: ${projection.health}`,
    `sequence: ${projection.sequence}`,
    `active: ${active ? `${active.taskId} [${active.state}] ${active.summary.now}` : "none"}`,
    `pending: ${pending.length}`,
    `agents: ${projection.agents.length}`,
    `operator_interventions: ${projection.interventions?.length ?? 0}`,
    `publication_interval_seconds: ${projection.publication?.intervalSeconds ?? "unknown"}`,
    `next_publication_due_at_utc: ${projection.publication?.nextPublicationDueAtUtc ?? "unknown"}`,
    `updated_at_utc: ${projection.generatedAtUtc}`,
  ].join("\n");
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const selectedReportOperation = command === "report"
    ? validateReportOperation(options.operation || "import-only")
    : null;
  const providerRequired = command === "cycle"
    || command === "report-models"
    || (command === "report" && ["summarize", "review"].includes(selectedReportOperation));
  const configPath = options.config
    || process.env.ORCHESTRATION_CONTROL_CONFIG
    || path.join(process.cwd(), ".project-local", "orchestration", "control-cycle.json");
  const configuration = await loadConfiguration(configPath, { requireProvider: providerRequired });
  const versions = await readProjectVersions(configuration.controllerRoot);
  const tool = await createToolRun({
    repoRoot: configuration.controllerRoot,
    toolName: "serialized_control_cycle",
    toolVersion: versions.componentVersions.serialized_control_cycle ?? "v0.1.0",
    projectVersion: versions.projectVersion,
    operation: command,
    parameters: {
      configPath: path.relative(configuration.controllerRoot, configuration.configPath).replaceAll(path.sep, "/"),
      taskId: options["task-id"] ?? null,
      sourceId: options["source-id"] ?? null,
      agentId: options["agent-id"] ?? null,
      itemId: options["item-id"] ?? null,
      reportOperation: selectedReportOperation,
    },
  });
  const logger = (event, data) => tool.log(event, data);
  // node:sqlite in this process unless "sqliteBackend": "python" in the
  // configuration or AGENTS_FACTORY_SQLITE=python; the Python bridge below is
  // the fallback.
  const store = new SqliteControlStore({
    databasePath: configuration.databasePath,
    pythonCommand: configuration.pythonCommand ?? "python",
    bridgePath: configuration.sqliteBridgePath
      ? resolveFrom(configuration.controllerRoot, configuration.sqliteBridgePath)
      : path.join(CURRENT_DIRECTORY, "sqlite-control-store.py"),
    sqliteBackend: configuration.sqliteBackend,
  });
  const serviceReviewRegistry = new ServiceReviewRegistry({ indexPath: configuration.serviceReviewIndexPath });
  const cycle = new SerializedControlCycle({
    store,
    provider: command === "cycle" || selectedReportOperation === "review"
      ? createProvider(configuration)
      : null,
    controllerRoot: configuration.controllerRoot,
    backendCapabilitiesPath: configuration.backendCapabilitiesPath,
    projectionPath: configuration.projectionPath,
    attentionProjectionPath: configuration.attentionProjectionPath,
    executionSummaryRoot: configuration.executionSummaryRoot,
    leaseSeconds: configuration.leaseSeconds ?? 120,
    publicationIntervalMs: configuration.publicationIntervalMs,
    serviceReviewRegistry,
    integrator: createIntegrator(configuration, logger),
    logger,
  });
  const summaryConfiguration = configuration.reportOperations?.summary ?? {};
  const summarizer = providerRequired && configuration.provider.type === CLAUDE_CODE_SERVICE_PROVIDER_ID
    ? createClaudeReportSummarizer({
      controllerRoot: configuration.controllerRoot,
      turnTimeoutMs: summaryConfiguration.turnTimeoutMs ?? 600_000,
    })
    : null;
  const presentation = new ReportPresentationService({
    controllerRoot: configuration.controllerRoot,
    projectionPath: configuration.projectionPath,
    cacheRoot: configuration.reportPresentationCacheRoot,
    summarizer,
  });
  const reportOperations = new ReportOperationService({
    cycle,
    controllerRoot: configuration.controllerRoot,
    collector: configuration.collector,
    presentation,
    collectReports: collectReportsByRoute,
    logger,
  });

  try {
    await cycle.initialize();
    let result;
    const requestedControlCommand = controlCommand(command, options);
    if (requestedControlCommand) {
      result = await cycle.applyCommand(requestedControlCommand);
      if (configuration.workerProgress?.enabled && command === "emergency-stop") {
        result.workerCancellations = await deliverWorkerCancellation({
          controllerRoot: configuration.controllerRoot,
          scope: "all",
          reason: requestedControlCommand.reason,
          requestedBy: requestedControlCommand.requestedBy,
        });
      } else if (configuration.workerProgress?.enabled && command === "resume") {
        result.archivedWorkerEmergencyStops = await clearWorkerEmergencyStop({
          controllerRoot: configuration.controllerRoot,
        });
      } else if (configuration.workerProgress?.enabled && result?.external) {
        result.workerCancellations = await deliverWorkerCancellation({
          controllerRoot: configuration.controllerRoot,
          scope: command === "cancel-agent" ? "agent" : "task",
          sourceId: result.sourceId,
          taskId: result.taskId,
          agentId: result.agentId,
          reason: requestedControlCommand.reason,
          requestedBy: requestedControlCommand.requestedBy,
        });
      }
    } else if (command === "cycle") {
      if (configuration.workerProgress?.enabled) {
        const progress = await collectWorkerProgress({ controllerRoot: configuration.controllerRoot, logger });
        if (progress.length > 0) await cycle.observeWorkerProgress(progress);
      }
      const reports = await collectAllReportsByRoute({
        controllerRoot: configuration.controllerRoot,
        collector: configuration.collector,
        logger,
      });
      if (reports.length > 0) await cycle.enqueueReports(reports);
      result = await cycle.runOnce();
      if (configuration.archiveAfterCycle !== false) {
        result.retention = await cycle.archive({
          retentionDays: Number(configuration.retentionDays ?? 30),
          archiveRoot: configuration.archiveRoot,
        });
      }
    } else if (command === "enqueue") {
      if (!options.file) throw new Error("enqueue requires --file <json>");
      const value = await loadJson(path.resolve(options.file));
      result = await cycle.enqueueReports(Array.isArray(value) ? value : [value]);
    } else if (command === "report") {
      if (!options["source-id"] || !options["task-id"]) {
        throw new Error("report requires --source-id <id> and --task-id <id>");
      }
      result = await reportOperations.execute(selectedReportOperation, {
        sourceId: options["source-id"],
        taskId: options["task-id"],
        includeContent: Boolean(options["include-content"]),
        model: options.model || summaryConfiguration.model,
        reasoningEffort: options["reasoning-effort"] || summaryConfiguration.reasoningEffort,
        language: options.language || summaryConfiguration.language || "English",
        refresh: Boolean(options.refresh),
        acceptanceRoot: configuration.acceptanceRoot,
      });
    } else if (command === "report-models") {
      result = await reportOperations.listModels();
    } else if (command === "archive") {
      result = await cycle.archive({
        retentionDays: Number(options.days ?? configuration.retentionDays ?? 30),
        archiveRoot: configuration.archiveRoot,
      });
    } else if (command === "monitor") {
      configuration.monitorIterations = options.iterations;
      result = await monitorProjections({ cycle, configuration });
    } else if (command === "status") {
      result = await cycle.writeProjection();
    } else if (command === "diagnostics") {
      const limit = Number.parseInt(String(options.limit ?? "100"), 10);
      result = {
        schemaVersion: 1,
        records: await serviceReviewRegistry.list({
          sourceId: options["source-id"],
          taskId: options["task-id"],
          serviceRunId: options["service-run-id"],
          limit: Number.isInteger(limit) ? limit : 100,
        }),
      };
    } else {
      throw new Error(`Unsupported control command: ${command}`);
    }
    const logRetention = await compactToolRunHistory({
      repoRoot: configuration.controllerRoot,
      toolName: "serialized_control_cycle",
      maxLooseFiles: configuration.logRetention?.maxLooseFiles ?? 120,
      retainLooseFiles: configuration.logRetention?.retainLooseFiles ?? 60,
      maxBundleBytes: configuration.logRetention?.maxBundleBytes ?? 20 * 1024 * 1024,
    });
    await tool.log("control_log_retention_completed", logRetention);
    const loggedResult = result?.content === undefined ? result : { ...result, content: "[omitted-from-tool-log]" };
    await tool.finish("success", loggedResult);
    if (command === "status" && !options.json) process.stdout.write(`${humanStatus(result)}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    await tool.finish("failed", {}, error);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

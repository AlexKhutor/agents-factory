import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { SerializedControlCycle } from "../src/control-cycle.mjs";
import {
  normalizeCollectorReports,
  verifyCatalogRefresh,
} from "../src/control-report-collector.mjs";
import { FakeReviewProvider } from "../src/control-review-provider.mjs";
import {
  ServiceReportSummarizer,
  ReportPresentationService,
  resolveSummaryModelProfile,
} from "../src/report-presentation.mjs";
import { ReportOperationService } from "../src/report-operations.mjs";
import { SqliteControlStore } from "../src/sqlite-control-store.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeArtifact(root, relativePath, value, { json = true } = {}) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(json ? `${JSON.stringify(value, null, 2)}\n` : String(value), "utf8");
  await writeFile(filePath, bytes);
  return { path: relativePath.replaceAll(path.sep, "/"), sha256: sha256(bytes) };
}

async function fixture(t, taskId = "report-operation-task") {
  const root = await mkdtemp(path.join(tmpdir(), "report-operations-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sourceId = "worker-one";
  const sourceRevision = "commit:test-revision";
  const task = await writeArtifact(root, `coordination/tasks/dispatched/${taskId}/task.json`, {
    schemaVersion: 1,
    taskId,
    targetId: sourceId,
  });
  const report = await writeArtifact(
    root,
    `knowledge/reports/inbox/${sourceId}/${taskId}.md`,
    `# Child Task Report\n\nTask ID: ${taskId}\nStatus: completed\n`,
    { json: false },
  );
  const progress = await writeArtifact(root, `knowledge/reports/inbox/${sourceId}/${taskId}.progress.json`, {
    schemaVersion: 1,
    contractVersion: "v0.3.0",
    sequence: 4,
    sourceId,
    taskId,
    state: "completed",
    summary: { now: "Complete", done: ["Done"], next: [], blockers: [] },
    blockers: [],
    plan: [{ id: "work", title: "Complete work", state: "completed" }],
    agents: [],
    workflow: {
      policy: "intent-confirm-plan-v1",
      lifecycleStage: "complete",
      plan: { status: "confirmed" },
    },
  });
  const executionSummary = await writeArtifact(
    root,
    `knowledge/reports/inbox/${sourceId}/${taskId}.execution-summary.json`,
    {
      schemaVersion: 1,
      stage: "child-execution",
      sourceId,
      taskId,
      outcome: "completed",
      summary: "Complete",
      completedSteps: ["Complete work"],
      remainingSteps: [],
      blockers: [],
      agentResults: [],
      stopEvents: [],
      sourceRevision,
    },
  );
  const item = {
    sourceId,
    taskId,
    reportId: `${taskId}-report`,
    title: "Report operation test",
    reportStatus: "completed",
    reportSha256: report.sha256,
    taskSha256: task.sha256,
    sourceRevision,
    reportPath: report.path,
    taskPath: task.path,
    decisionPath: `coordination/reviews/${taskId}/decision.json`,
    priority: 0,
    dispatchSequence: 1,
    dependencies: [],
    plan: [
      { id: "verify-integrity", title: "Verify integrity", state: "pending" },
      { id: "apply-operation", title: "Apply operation", state: "pending" },
    ],
    blockers: [],
    summary: "Waiting for operation",
    evidence: [
      { kind: "report", ...report },
      { kind: "artifact", ...task },
      { kind: "progress", ...progress },
      { kind: "execution-summary", ...executionSummary },
    ],
  };
  const store = new SqliteControlStore({ databasePath: path.join(root, "control.db") });
  return { root, sourceId, taskId, item, store };
}

async function prepareOneStepCorrection(context, { broaden = false } = {}) {
  const progressEntry = context.item.evidence.find((entry) => entry.kind === "progress");
  const summaryEntry = context.item.evidence.find((entry) => entry.kind === "execution-summary");
  const originalProgress = JSON.parse(await readFile(path.join(context.root, progressEntry.path), "utf8"));
  const originalSummary = JSON.parse(await readFile(path.join(context.root, summaryEntry.path), "utf8"));
  originalProgress.plan[0].state = "running";
  originalSummary.completedSteps = [];
  originalSummary.remainingSteps = [originalProgress.plan[0].title];
  const rewrittenProgress = await writeArtifact(context.root, progressEntry.path, originalProgress);
  const rewrittenSummary = await writeArtifact(context.root, summaryEntry.path, originalSummary);
  Object.assign(progressEntry, rewrittenProgress);
  Object.assign(summaryEntry, rewrittenSummary);

  const correctedProgress = structuredClone(originalProgress);
  correctedProgress.plan[0].state = "completed";
  if (broaden) correctedProgress.summary.now = "Substantive rewrite is forbidden";
  const correctedSummary = structuredClone(originalSummary);
  correctedSummary.completedSteps = [correctedProgress.plan[0].title];
  correctedSummary.remainingSteps = [];
  const correctedProgressArtifact = await writeArtifact(
    context.root,
    `knowledge/reports/inbox/${context.sourceId}/${context.taskId}.corrected-progress.json`,
    correctedProgress,
  );
  const correctedSummaryArtifact = await writeArtifact(
    context.root,
    `knowledge/reports/inbox/${context.sourceId}/${context.taskId}.corrected-execution-summary.json`,
    correctedSummary,
  );
  const correctionArtifact = await writeArtifact(
    context.root,
    `knowledge/reports/inbox/${context.sourceId}/${context.taskId}.correction.json`,
    {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      kind: "terminal-plan-step-state-correction",
      correctionId: `${context.taskId}-completion-correction`,
      taskId: context.taskId,
      sourceId: context.sourceId,
      sourceRevision: context.item.sourceRevision,
      reasonCode: "completed-plan-step-state-omission",
      step: {
        id: originalProgress.plan[0].id,
        title: originalProgress.plan[0].title,
        fromState: "running",
        toState: "completed",
      },
      original: {
        reportMetadataSha256: "f".repeat(64),
        reportSha256: context.item.reportSha256,
        progressSha256: rewrittenProgress.sha256,
        executionSummarySha256: rewrittenSummary.sha256,
      },
      corrected: {
        progressFile: "progress.json",
        progressSha256: correctedProgressArtifact.sha256,
        executionSummaryFile: "execution-summary.json",
        executionSummarySha256: correctedSummaryArtifact.sha256,
      },
      authorization: { confirmedBy: "project-owner", note: "Correct the proven bookkeeping omission." },
      createdAtUtc: "2026-09-14T08:00:00.000Z",
    },
  );
  return {
    originalHashes: { progress: rewrittenProgress.sha256, summary: rewrittenSummary.sha256 },
    evidence: [
      { kind: "report-correction", ...correctionArtifact },
      { kind: "corrected-progress", ...correctedProgressArtifact },
      { kind: "corrected-execution-summary", ...correctedSummaryArtifact },
    ],
  };
}

function cycleFor({ root, store, provider = null, decisionValidator } = {}) {
  return new SerializedControlCycle({
    store,
    provider,
    controllerRoot: root,
    projectionPath: path.join(root, ".project-local/projections/control-status.v1.json"),
    attentionProjectionPath: path.join(root, ".project-local/projections/attention-status.v1.json"),
    executionSummaryRoot: path.join(root, ".project-local/execution-summaries"),
    decisionValidator,
  });
}

test("collector normalizes PowerShell single-item report output", () => {
  const report = { SourceId: "worker-one", TaskId: "single-report" };
  assert.deepEqual(normalizeCollectorReports(report), [report]);
  assert.deepEqual(normalizeCollectorReports([report]), [report]);
  assert.deepEqual(normalizeCollectorReports(null), []);
  assert.throws(
    () => normalizeCollectorReports("invalid"),
    /must be an object or array/,
  );
});

function serviceFor({ root, cycle, item, presentation }) {
  return new ReportOperationService({
    cycle,
    controllerRoot: root,
    collector: {},
    presentation,
    collectReports: async () => [item],
  });
}

test("import-only and show do not invoke a model or change acceptance state", async (t) => {
  const context = await fixture(t);
  const cycle = cycleFor(context);
  await cycle.initialize();
  let modelCalls = 0;
  const presentation = new ReportPresentationService({
    controllerRoot: context.root,
    projectionPath: cycle.projectionPath,
    summarizer: { async summarize() { modelCalls += 1; throw new Error("unexpected model call"); } },
  });
  const service = serviceFor({ ...context, cycle, presentation });
  const imported = await service.execute("import-only", context);
  assert.equal(imported.action, "imported");
  assert.equal(imported.report.state, "queued");
  const shown = await service.execute("show", { ...context, includeContent: true });
  assert.equal(shown.action, "shown");
  assert.match(shown.content, /Child Task Report/);
  assert.equal(modelCalls, 0);
  assert.equal((await context.store.snapshot()).items[0].state, "queued");
});

test("a task report operation requests only its exact source and task", async (t) => {
  const context = await fixture(t, "exact-collector-task");
  const cycle = cycleFor(context);
  await cycle.initialize();
  let collectionRequest;
  const service = new ReportOperationService({
    cycle,
    controllerRoot: context.root,
    collector: {},
    collectReports: async (request) => {
      collectionRequest = request;
      return [context.item];
    },
  });
  await service.execute("import-only", context);
  assert.equal(collectionRequest.sourceId, context.sourceId);
  assert.equal(collectionRequest.taskId, context.taskId);
});

test("accept deterministically validates companions, is idempotent, and unblocks dependencies", async (t) => {
  const context = await fixture(t, "base-task");
  const cycle = cycleFor(context);
  await cycle.initialize();
  const service = serviceFor({ ...context, cycle });
  const accepted = await service.execute("accept", context);
  assert.equal(accepted.action, "accepted");
  assert.equal(accepted.idempotent, false);
  assert.equal(accepted.report.state, "accepted");
  assert.ok(accepted.acceptance.path.endsWith("acceptance.json"));
  const artifact = JSON.parse(await readFile(path.join(context.root, accepted.acceptance.path), "utf8"));
  assert.equal(artifact.result, "passed");
  assert.equal(artifact.reportSha256, context.item.reportSha256);

  const repeated = await service.execute("accept", context);
  assert.equal(repeated.idempotent, true);
  await context.store.enqueue({
    ...context.item,
    taskId: "dependent-task",
    reportId: "dependent-task-report",
    reportSha256: "d".repeat(64),
    dependencies: ["base-task"],
  });
  const claimed = await context.store.claim({ owner: "test" });
  assert.equal(claimed.item.taskId, "dependent-task");
});

test("a hash-bound one-step correction preserves originals and permits deterministic acceptance", async (t) => {
  const context = await fixture(t, "corrected-report-task");
  const correction = await prepareOneStepCorrection(context);
  const cycle = cycleFor(context);
  await cycle.initialize();
  const service = serviceFor({ ...context, cycle });

  await assert.rejects(
    service.execute("accept", context),
    (error) => error.code === "PROGRESS_INCOMPLETE",
  );
  context.item.evidence.push(...correction.evidence);
  const imported = await service.execute("import-only", context);
  assert.equal(imported.report.state, "queued");
  const queued = (await context.store.snapshot()).items[0];
  assert.equal(queued.evidence.filter((entry) => entry.kind.includes("correct")).length, 3);

  const accepted = await service.execute("accept", context);
  assert.equal(accepted.report.state, "accepted");
  const artifact = JSON.parse(await readFile(path.join(context.root, accepted.acceptance.path), "utf8"));
  assert.equal(artifact.contractVersion, "v0.2.0");
  assert.equal(artifact.correctionSha256, correction.evidence[0].sha256);
  assert.equal(accepted.checks.find((check) => check.id === "narrow-report-correction").stepId, "work");

  const progressEntry = context.item.evidence.find((entry) => entry.kind === "progress");
  const summaryEntry = context.item.evidence.find((entry) => entry.kind === "execution-summary");
  assert.equal(sha256(await readFile(path.join(context.root, progressEntry.path))), correction.originalHashes.progress);
  assert.equal(sha256(await readFile(path.join(context.root, summaryEntry.path))), correction.originalHashes.summary);
});

test("a correction that changes any additional progress field fails closed", async (t) => {
  const context = await fixture(t, "broad-correction-task");
  const correction = await prepareOneStepCorrection(context, { broaden: true });
  context.item.evidence.push(...correction.evidence);
  const cycle = cycleFor(context);
  await cycle.initialize();
  const service = serviceFor({ ...context, cycle });
  await assert.rejects(
    service.execute("accept", context),
    (error) => error.code === "REPORT_CORRECTION_SCOPE_EXCEEDED",
  );
  assert.equal((await context.store.snapshot()).items[0].state, "queued");
});

test("summarize caches an identical derivative and review remains explicit", async (t) => {
  const context = await fixture(t);
  let summaryCalls = 0;
  const summarizer = {
    async summarize() {
      summaryCalls += 1;
      return {
        summary: "Compact report summary",
        model: "catalog-model",
        reasoningEffort: "low",
        codexVersion: "test",
        statistics: null,
      };
    },
  };
  const cycle = cycleFor(context);
  await cycle.initialize();
  const presentation = new ReportPresentationService({
    controllerRoot: context.root,
    projectionPath: cycle.projectionPath,
    summarizer,
  });
  const service = serviceFor({ ...context, cycle, presentation });
  const request = { ...context, model: "catalog-model", reasoningEffort: "low", language: "Russian" };
  const first = await service.execute("summarize", request);
  const second = await service.execute("summarize", request);
  assert.equal(first.derivative.cache.hit, false);
  assert.equal(second.derivative.cache.hit, true);
  assert.equal(summaryCalls, 1);
  assert.equal((await context.store.snapshot()).items[0].state, "queued");

  const reviewCycle = cycleFor({
    ...context,
    provider: new FakeReviewProvider({ delayMs: 1 }),
    decisionValidator: async (item) => ({
      decision: {
        outcome: "accepted",
        summary: "Explicit review accepted",
        risks: [],
        humanApprovalRequired: false,
      },
      decisionReference: item.decisionPath,
      decisionSha256: "e".repeat(64),
    }),
  });
  const reviewService = serviceFor({ ...context, cycle: reviewCycle, presentation });
  const reviewed = await reviewService.execute("review", context);
  assert.equal(reviewed.action, "reviewed");
  assert.equal((await context.store.snapshot()).items[0].state, "reviewed");
});

test("model and reasoning selection must match the provider catalog before a turn", async () => {
  const catalog = {
    data: [{
      id: "catalog-model",
      model: "catalog-model",
      hidden: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    }],
  };
  assert.deepEqual(
    resolveSummaryModelProfile(catalog, { model: "catalog-model", reasoningEffort: "high" }).reasoningEffort,
    "high",
  );
  assert.throws(() => resolveSummaryModelProfile(catalog, {}), { code: "MODEL_SELECTION_REQUIRED" });
  assert.throws(
    () => resolveSummaryModelProfile(catalog, { model: "missing", reasoningEffort: "low" }),
    { code: "MODEL_UNAVAILABLE" },
  );
  assert.throws(
    () => resolveSummaryModelProfile(catalog, { model: "catalog-model", reasoningEffort: "medium" }),
    { code: "REASONING_EFFORT_UNAVAILABLE" },
  );
});

test("Codex summarizer discovers the catalog before starting an explicit profile", async () => {
  const calls = [];
  const client = {
    async connect() { calls.push("connect"); return { serverInfo: { version: "test-codex" } }; },
    async listModels() {
      calls.push("model/list");
      return { data: [{ id: "catalog-model", model: "catalog-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] };
    },
    async startThread(options) { calls.push(["thread/start", options]); return { thread: { id: "summary-thread", model: options.model } }; },
    async setThreadName() {},
    async startTurn() { calls.push("turn/start"); return { turn: { id: "summary-turn" } }; },
    async waitForTurn() {
      return { turn: { id: "summary-turn", status: "completed", items: [{ type: "assistantMessage", text: "Summary" }] } };
    },
    async readThreadUsage() { return null; },
    async close() { calls.push("close"); },
  };
  const summarizer = new ServiceReportSummarizer({
    cwd: process.cwd(),
    providerId: "test-provider",
    clientFactory: () => client,
  });
  const result = await summarizer.summarize({ sourceId: "worker-one", taskId: "task-one", sha256: "a".repeat(64), text: "Report" }, {
    model: "catalog-model",
    reasoningEffort: "low",
    language: "Russian",
  });
  assert.equal(result.summary, "Summary");
  assert.deepEqual(calls.slice(0, 3).map((entry) => Array.isArray(entry) ? entry[0] : entry), ["connect", "model/list", "thread/start"]);
  assert.equal(calls[2][1].config.model_reasoning_effort, "low");
  assert.equal(calls[2][1].allowProviderModelFallback, false);
});

test("catalog refresh must index every imported report companion", async (t) => {
  const context = await fixture(t, "catalog-refresh-task");
  const metadata = await writeArtifact(context.root, `${context.item.reportPath}.meta.json`, {
    documentId: context.item.reportId,
    documentPath: context.item.reportPath.replace("knowledge/", ""),
  });
  const correction = await writeArtifact(context.root, `${context.item.reportPath}.correction.json`, { correction: true });
  const correctedProgress = await writeArtifact(context.root, `${context.item.reportPath}.corrected-progress.json`, { corrected: true });
  const correctedSummary = await writeArtifact(context.root, `${context.item.reportPath}.corrected-execution-summary.json`, { corrected: true });
  const indexed = [
    context.item.evidence.find((entry) => entry.kind === "report"),
    metadata,
    context.item.evidence.find((entry) => entry.kind === "progress"),
    context.item.evidence.find((entry) => entry.kind === "execution-summary"),
    correction,
    correctedProgress,
    correctedSummary,
  ];
  const catalogValue = {
    schemaVersion: 1,
    documentCount: indexed.length,
    totalBytes: 1234,
    contentSetSha256: "c".repeat(64),
    documents: indexed.map((entry) => ({ path: entry.path.slice("knowledge/".length) })),
  };
  const catalog = await writeArtifact(context.root, "knowledge/catalog.json", catalogValue);
  const collected = [{
    ImportedPath: path.join(context.root, context.item.reportPath),
    ProgressPath: path.join(
      context.root,
      context.item.evidence.find((entry) => entry.kind === "progress").path,
    ),
    ExecutionSummaryPath: path.join(
      context.root,
      context.item.evidence.find((entry) => entry.kind === "execution-summary").path,
    ),
    CorrectionPath: path.join(context.root, correction.path),
    CorrectedProgressPath: path.join(context.root, correctedProgress.path),
    CorrectedExecutionSummaryPath: path.join(context.root, correctedSummary.path),
  }];
  const result = { CatalogRefresh: {
    Status: "success",
    CatalogPath: path.join(context.root, catalog.path),
    CatalogSha256: catalog.sha256,
    DocumentCount: catalogValue.documentCount,
    TotalBytes: catalogValue.totalBytes,
    ContentSetSha256: catalogValue.contentSetSha256,
  } };
  const verified = await verifyCatalogRefresh(context.root, result, collected);
  assert.equal(verified.documentCount, 7);

  const staleValue = { ...catalogValue, documentCount: 6, documents: catalogValue.documents.slice(0, 6) };
  const staleCatalog = await writeArtifact(context.root, "knowledge/catalog.json", staleValue);
  result.CatalogRefresh.CatalogSha256 = staleCatalog.sha256;
  result.CatalogRefresh.DocumentCount = 6;
  await assert.rejects(
    verifyCatalogRefresh(context.root, result, collected),
    /Imported corrected execution summary is missing from knowledge\/catalog\.json/,
  );
});

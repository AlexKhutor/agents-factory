import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { SerializedControlCycle } from "../src/control-cycle.mjs";
import { createControlProjection } from "../src/control-read-model.mjs";
import { ServiceReviewProvider, FakeReviewProvider } from "../src/control-review-provider.mjs";
import { SqliteControlStore } from "../src/sqlite-control-store.mjs";
import { compactToolRunHistory } from "../src/tool-run.mjs";
import { collectWorkerProgress } from "../src/control-worker-bridge.mjs";
import { sqliteBackendOf, sqliteBackendTest } from "./fixtures/sqlite-backends/helpers.mjs";

function runPythonScript(script, argumentsList = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python", ["-c", script, ...argumentsList], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Python fixture failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "serialized-control-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sqliteBackend = sqliteBackendOf(t);
  const store = new SqliteControlStore({ databasePath: path.join(root, "control.db"), sqliteBackend });
  assert.equal(await store.sqliteBackend(), sqliteBackend);
  await store.initialize();
  return { root, store };
}

sqliteBackendTest("SQLite format v1 migrates workflow, timing, and agent statistics without losing progress", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "serialized-control-migration-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const databasePath = path.join(root, "control.db");
  await runPythonScript(String.raw`
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.executescript("""
CREATE TABLE worker_tasks (
  source_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  plan_json TEXT NOT NULL DEFAULT '[]',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  stop_events_json TEXT NOT NULL DEFAULT '[]',
  progress_sequence INTEGER NOT NULL DEFAULT 0,
  progress_sha256 TEXT NOT NULL,
  progress_path TEXT NOT NULL,
  started_at_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY(source_id, task_id)
);
CREATE TABLE worker_agents (
  agent_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  parent_agent_id TEXT,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT,
  state TEXT NOT NULL,
  current_action TEXT NOT NULL DEFAULT '',
  last_completed TEXT,
  next_action TEXT,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  can_interrupt INTEGER NOT NULL DEFAULT 0,
  started_at_utc TEXT,
  last_heartbeat_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  FOREIGN KEY(source_id, task_id) REFERENCES worker_tasks(source_id, task_id) ON DELETE CASCADE
);
INSERT INTO worker_tasks VALUES (
  'worker-one', 'migration-task', 'Migration task', 'waiting', 'planning',
  '{"now":"Waiting","done":[],"next":[],"blockers":[]}', '[]', '[]', '[]', '[]',
  1, '${"f".repeat(64)}', 'worker-one:.orchestrator/progress/outbox/migration-task/progress.json',
  '2026-08-17T18:00:00.000Z', '2026-08-17T18:01:00.000Z'
);
INSERT INTO worker_agents VALUES (
  'worker-one-primary', 'worker-one', 'migration-task', NULL, 'primary', 'worker', 'codex',
  'waiting', 'Waiting', NULL, 'Continue', '[]', 1,
  '2026-08-17T18:00:00.000Z', '2026-08-17T18:01:00.000Z', '2026-08-17T18:01:00.000Z'
);
PRAGMA user_version = 1;
""")
connection.commit()
connection.close()
`, [databasePath]);

  const store = new SqliteControlStore({ databasePath, sqliteBackend: sqliteBackendOf(t) });
  const initialized = await store.initialize();
  assert.equal(initialized.formatVersion, 4);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.workerTasks.length, 1);
  assert.equal(snapshot.workerTasks[0].taskId, "migration-task");
  assert.deepEqual(snapshot.workerTasks[0].workflow, {});
  assert.deepEqual(snapshot.workerTasks[0].timing, {});
  assert.equal(snapshot.workerAgents[0].semanticUpdatedAtUtc, null);
  assert.deepEqual(snapshot.workerAgents[0].statistics, {});
});

test("worker collection permits an empty registry but requires bindings for configured sources", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "serialized-control-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registryPath = path.join(root, "config", "source-registry.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({ schemaVersion: 2, sources: [] }, null, 2)}\n`, "utf8");
  assert.deepEqual(await collectWorkerProgress({ controllerRoot: root }), []);

  await writeFile(registryPath, `${JSON.stringify({
    schemaVersion: 2,
    sources: [{ id: "worker-one", progressOutbox: ".orchestrator/progress/outbox" }],
  }, null, 2)}\n`, "utf8");
  await assert.rejects(
    collectWorkerProgress({ controllerRoot: root }),
    /source-bindings\.json/,
  );
});

function report(taskId, overrides = {}) {
  return {
    sourceId: overrides.sourceId ?? "worker-one",
    taskId,
    reportId: `${taskId}-report`,
    title: overrides.title ?? taskId,
    reportStatus: "completed",
    reportSha256: overrides.reportSha256 ?? "a".repeat(64),
    taskSha256: "b".repeat(64),
    sourceRevision: "local-test-revision",
    reportPath: `knowledge/reports/${taskId}.md`,
    taskPath: `coordination/tasks/${taskId}.json`,
    decisionPath: `coordination/reviews/${taskId}/decision.json`,
    priority: overrides.priority ?? 0,
    dispatchSequence: overrides.dispatchSequence ?? 0,
    dependencies: overrides.dependencies ?? [],
    plan: [
      { id: "verify", title: "Verify report", state: "pending" },
      { id: "decide", title: "Record decision", state: "pending" },
    ],
    evidence: overrides.evidence ?? [],
    summary: "Waiting for review",
  };
}

function acceptedDecision(item) {
  return {
    decision: {
      schemaVersion: 1,
      taskId: item.taskId,
      sourceId: item.sourceId,
      reportSha256: item.reportSha256,
      outcome: "accepted",
      summary: `Accepted ${item.taskId}`,
      acceptanceChecks: [{ criterion: "bounded test", status: "passed", evidence: "test fixture" }],
      risks: [],
      requiredFollowUps: [],
      humanApprovalRequired: false,
      decisionDocument: null,
      decidedAtUtc: new Date().toISOString(),
    },
    decisionPath: path.join("unused", `${item.taskId}.json`),
    decisionReference: item.decisionPath,
  };
}

function workerProgress(taskId, overrides = {}) {
  const now = overrides.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    contractVersion: "v0.2.0",
    sequence: overrides.sequence ?? 1,
    sourceId: overrides.sourceId ?? "worker-one",
    taskId,
    title: overrides.title ?? taskId,
    state: overrides.state ?? "waiting",
    phase: overrides.phase ?? "manual-stop",
    summary: overrides.summary ?? {
      now: "Waiting for operator input",
      done: ["Started child task"],
      next: ["Continue work"],
      blockers: [],
    },
    plan: overrides.plan ?? [{
      id: "active-step",
      title: "Continue work",
      state: "running",
      startedAtUtc: now,
    }],
    agents: overrides.agents ?? [{
      agentId: `${overrides.sourceId ?? "worker-one"}-primary`,
      parentAgentId: null,
      kind: "primary",
      role: "worker",
      provider: "codex",
      state: "waiting",
      currentAction: "Waiting for operator input",
      lastCompleted: "Started child task",
      nextAction: "Continue work",
      blockers: [],
      canInterrupt: true,
      startedAtUtc: now,
      lastHeartbeatUtc: now,
      updatedAtUtc: now,
    }],
    evidence: [],
    stopEvents: [],
    startedAtUtc: now,
    updatedAtUtc: now,
    progressSha256: "f".repeat(64),
    progressPath: `${overrides.sourceId ?? "worker-one"}:.orchestrator/progress/outbox/${taskId}/progress.json`,
  };
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for test condition");
}

sqliteBackendTest("SQLite queue grants only one concurrent active lease", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(report("task-one"));
  await store.enqueue(report("task-two", { reportSha256: "c".repeat(64) }));
  const claims = await Promise.all([
    store.claim({ owner: "claimant-one" }),
    store.claim({ owner: "claimant-two" }),
  ]);
  assert.equal(claims.filter((claim) => claim.item).length, 1);
  assert.equal(claims.filter((claim) => claim.reason === "active-review").length, 1);
});

sqliteBackendTest("an existing report accepts only one complete immutable correction evidence set", async (t) => {
  const { store } = await fixture(t);
  const baseEvidence = [
    { kind: "report", path: "knowledge/report.md", sha256: "1".repeat(64) },
    { kind: "progress", path: "knowledge/progress.json", sha256: "2".repeat(64) },
    { kind: "execution-summary", path: "knowledge/summary.json", sha256: "3".repeat(64) },
  ];
  const correctionEvidence = [
    { kind: "report-correction", path: "knowledge/correction.json", sha256: "4".repeat(64) },
    { kind: "corrected-progress", path: "knowledge/corrected-progress.json", sha256: "5".repeat(64) },
    { kind: "corrected-execution-summary", path: "knowledge/corrected-summary.json", sha256: "6".repeat(64) },
  ];
  const original = report("correction-evidence-task", { evidence: baseEvidence });
  await store.enqueue(original);
  await assert.rejects(
    store.enqueue({ ...original, evidence: [...baseEvidence, correctionEvidence[0]] }),
    /complete immutable report-correction/,
  );
  const augmented = await store.enqueue({ ...original, evidence: [...baseEvidence, ...correctionEvidence] });
  assert.equal(augmented.created, false);
  assert.deepEqual(augmented.item.evidence, [...baseEvidence, ...correctionEvidence]);
  const repeated = await store.enqueue({ ...original, evidence: [...baseEvidence, ...correctionEvidence] });
  assert.deepEqual(repeated.item.evidence, augmented.item.evidence);

  await assert.rejects(
    store.enqueue({
      ...original,
      evidence: [
        { ...baseEvidence[0], sha256: "9".repeat(64) },
        ...baseEvidence.slice(1),
        ...correctionEvidence,
      ],
    }),
    /cannot be removed or replaced/,
  );
});

sqliteBackendTest("report ids remain valid for the maximum task-id length", async (t) => {
  const { store } = await fixture(t);
  const taskId = `t${"a".repeat(95)}`;
  const queued = await store.enqueue(report(taskId));
  assert.equal(queued.item.reportId, `${taskId}-report`);
});

sqliteBackendTest("task cancellation requires source identity when task ids collide", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(report("shared-task", { sourceId: "worker-one" }));
  await store.enqueue(report("shared-task", { sourceId: "worker-two", reportSha256: "c".repeat(64) }));
  await assert.rejects(
    store.requestCancel({ taskId: "shared-task" }, "ambiguous stop"),
    /ambiguous; provide sourceId/,
  );
  const cancelled = await store.requestCancel(
    { sourceId: "worker-two", taskId: "shared-task" },
    "targeted stop",
  );
  assert.equal(cancelled.item.sourceId, "worker-two");
  assert.equal(cancelled.item.state, "cancelled");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.items.find((item) => item.sourceId === "worker-one").state, "queued");
});

sqliteBackendTest("accepted reviewed dependencies unblock deterministic queue order", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(report("base-task", { priority: 0 }));
  await store.enqueue(report("dependent-task", {
    reportSha256: "d".repeat(64),
    priority: 100,
    dependencies: ["base-task"],
  }));
  const first = await store.claim({ owner: "test" });
  assert.equal(first.item.taskId, "base-task");
  await store.transition(first.item.itemId, "reviewed", {
    fromStates: ["leased"],
    leaseToken: first.item.leaseToken,
    patch: { finalDecision: "accepted", summary: "accepted" },
  });
  const second = await store.claim({ owner: "test" });
  assert.equal(second.item.taskId, "dependent-task");
});

sqliteBackendTest("control cycle reviews at most one queued report per invocation", async (t) => {
  const { root, store } = await fixture(t);
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider({ delayMs: 30 }),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    decisionValidator: async (item) => acceptedDecision(item),
  });
  await cycle.initialize();
  await cycle.enqueueReports([
    report("first-report"),
    report("second-report", { reportSha256: "e".repeat(64) }),
  ]);
  const result = await cycle.runOnce();
  assert.equal(result.action, "reviewed");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.counts.reviewed, 1);
  assert.equal(snapshot.counts.queued, 1);
  const reviewedProjection = result.projection.tasks.find((task) => task.taskId === "first-report");
  assert.equal(reviewedProjection.progress.completed, 2);
  assert.equal(reviewedProjection.progress.total, 2);
  assert.deepEqual(reviewedProjection.summary.next, []);
  assert.equal(reviewedProjection.evidence.at(-1).kind, "decision");
  assert.equal(snapshot.items.find((item) => item.taskId === "first-report").finalDecision, "accepted");
  assert.ok(snapshot.items.find((item) => item.taskId === "first-report").finishedAtUtc);
  const attention = JSON.parse(await readFile(path.join(
    root,
    ".project-local",
    "projections",
    "attention-status.v1.json",
  ), "utf8"));
  assert.equal(attention.source.controlSequence, result.projection.sequence);
  assert.equal(attention.modelVersion, "v0.1.0");
  const capabilities = JSON.parse(await readFile(path.join(
    root,
    ".project-local",
    "projections",
    "backend-capabilities.v1.json",
  ), "utf8"));
  assert.equal(capabilities.contractVersion, "v0.1.0");
  assert.equal(capabilities.features.commandAdapter, true);
  assert.equal(capabilities.commandAdapter.contractVersion, "v0.1.0");
  assert.equal(capabilities.artifacts.control.path, "projection.json");
});

sqliteBackendTest("integration runs only when the configured predicate accepts the decision", async (t) => {
  const { root, store } = await fixture(t);
  let integrationCalls = 0;
  const integrator = async () => {
    integrationCalls += 1;
    return {};
  };
  integrator.shouldIntegrate = () => false;
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider({ delayMs: 20 }),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    decisionValidator: async (item) => acceptedDecision(item),
    integrator,
  });
  await cycle.initialize();
  await cycle.enqueueReports([report("integration-gated")]);
  const result = await cycle.runOnce();
  assert.equal(result.action, "reviewed");
  assert.equal(integrationCalls, 0);
});

sqliteBackendTest("targeted subagent cancellation does not cancel the parent review", async (t) => {
  const { root, store } = await fixture(t);
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider({ delayMs: 1_500, spawnSubagent: true }),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    decisionValidator: async (item) => acceptedDecision(item),
  });
  await cycle.initialize();
  await cycle.enqueueReports([report("targeted-stop")]);
  const running = cycle.runOnce();
  const child = await waitFor(async () => {
    const snapshot = await store.snapshot({ eventLimit: 0 });
    return snapshot.agents.find((agent) => agent.kind === "subagent") ?? null;
  });
  await store.requestCancel({ agentId: child.agentId }, "Stop only delegated evidence check");
  const result = await running;
  assert.equal(result.action, "reviewed");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.items[0].state, "reviewed");
  assert.equal(snapshot.agents.find((agent) => agent.agentId === child.agentId).state, "interrupted");
  assert.equal(snapshot.agents.find((agent) => agent.kind === "reviewer").state, "completed");
});

sqliteBackendTest("task cancellation leaves no fake reviewer or subagent active", async (t) => {
  const { root, store } = await fixture(t);
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider({ delayMs: 1_500, spawnSubagent: true }),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    decisionValidator: async (item) => acceptedDecision(item),
  });
  await cycle.initialize();
  await cycle.enqueueReports([report("task-stop-with-subagent")]);
  const running = cycle.runOnce();
  await waitFor(async () => {
    const snapshot = await store.snapshot({ eventLimit: 0 });
    return snapshot.agents.some((agent) => agent.kind === "subagent");
  });
  await cycle.applyCommand({
    command: "cancel-task",
    taskId: "task-stop-with-subagent",
    sourceId: "worker-one",
    reason: "Stop the full review tree",
    requestedBy: "test",
  });
  const result = await running;
  assert.equal(result.action, "cancelled");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.items[0].state, "cancelled");
  assert.deepEqual(
    snapshot.agents.map((agent) => agent.state).sort(),
    ["interrupted", "interrupted"],
  );
  assert.equal(result.projection.agents.some((agent) => agent.capabilities.canInterrupt), false);
});

test("Codex provider preserves a targeted subagent terminal state after parent completion", async () => {
  class FakeAppServerClient extends EventEmitter {
    async connect() {}
    async listModels() {
      return { data: [{ id: "test-model", model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] };
    }
    async startThread() { return { thread: { id: "root-thread" } }; }
    async setThreadName() {}
    async startTurn() {
      queueMicrotask(() => this.emit("notification", {
        method: "thread/started",
        params: {
          threadId: "child-thread",
          turnId: "child-turn",
          thread: { id: "child-thread", parentThreadId: "root-thread" },
        },
      }));
      return { turn: { id: "root-turn" } };
    }
    async waitForTurn(turnId) {
      if (turnId === "child-turn") return { turn: { id: turnId, status: "interrupted" } };
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { turn: { id: turnId, status: "completed" } };
    }
    async listDescendantThreads() { return { data: [] }; }
    async interruptTurn() {}
    async close() {}
  }

  const states = new Map();
  let targetAgentId = null;
  const provider = new ServiceReviewProvider({
    providerId: "test-provider",
    cwd: process.cwd(),
    model: "test-model",
    reasoningEffort: "low",
    pollIntervalMs: 5,
    clientFactory: () => new FakeAppServerClient(),
  });
  const item = { ...report("provider-targeted-stop"), itemId: "worker-one:provider-targeted-stop:a", attempts: 1 };
  const result = await provider.runReview(item, {
    onAgent: async (agent) => {
      states.set(agent.agentId, agent.state);
      if (agent.kind === "subagent") targetAgentId = agent.agentId;
    },
    shouldCancel: async () => (targetAgentId ? {
      scope: "agent",
      agentId: targetAgentId,
      threadId: "child-thread",
      turnId: "child-turn",
    } : null),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.interrupted, false);
  assert.equal(states.get(targetAgentId), "interrupted");
});

test("Codex provider polls cancellation frequently without persisting every poll as a heartbeat", async () => {
  class SlowFakeAppServerClient extends EventEmitter {
    async connect() {}
    async listModels() {
      return { data: [{ id: "test-model", model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] };
    }
    async startThread() { return { thread: { id: "heartbeat-thread" } }; }
    async setThreadName() {}
    async startTurn() { return { turn: { id: "heartbeat-turn" } }; }
    async waitForTurn() {
      await new Promise((resolve) => setTimeout(resolve, 85));
      return { turn: { id: "heartbeat-turn", status: "completed" } };
    }
    async close() {}
  }

  let cancellationPolls = 0;
  let heartbeats = 0;
  const provider = new ServiceReviewProvider({
    providerId: "test-provider",
    cwd: process.cwd(),
    model: "test-model",
    reasoningEffort: "low",
    pollIntervalMs: 5,
    heartbeatIntervalMs: 30,
    clientFactory: () => new SlowFakeAppServerClient(),
  });
  await provider.runReview(
    { ...report("provider-heartbeats"), itemId: "worker-one:provider-heartbeats:a", attempts: 1 },
    {
      shouldCancel: async () => { cancellationPolls += 1; return null; },
      onHeartbeat: async () => { heartbeats += 1; },
    },
  );
  assert.ok(cancellationPolls >= 8, `expected frequent cancellation polls, got ${cancellationPolls}`);
  assert.ok(heartbeats >= 2 && heartbeats <= 4, `expected bounded heartbeats, got ${heartbeats}`);
});

sqliteBackendTest("emergency stop persists before interrupting the active review", async (t) => {
  const { root, store } = await fixture(t);
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider({ delayMs: 250 }),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    decisionValidator: async (item) => acceptedDecision(item),
  });
  await cycle.initialize();
  await cycle.enqueueReports([report("emergency-stop")]);
  const running = cycle.runOnce();
  await waitFor(async () => (await store.snapshot({ eventLimit: 0 })).agents.length > 0);
  await cycle.applyCommand({
    command: "emergency-stop-all",
    reason: "test stop",
    requestedBy: "test",
  });
  const result = await running;
  assert.equal(result.action, "cancelled");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.control.mode, "emergency_stopped");
  assert.equal(snapshot.items[0].state, "cancelled");
});

sqliteBackendTest("a provider result completing after emergency stop is discarded", async (t) => {
  const { root, store } = await fixture(t);
  let releaseProvider;
  const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
  let validationCalls = 0;
  const provider = {
    async runReview(item, callbacks) {
      await callbacks.onStarted?.({
        threadId: "completion-race-thread",
        turnId: "completion-race-turn",
        agentId: "completion-race-agent",
      });
      await callbacks.onAgent?.({
        agentId: "completion-race-agent",
        itemId: item.itemId,
        parentAgentId: null,
        kind: "reviewer",
        role: "completion-race-reviewer",
        provider: "fake",
        state: "running",
        currentAction: "Completing while stop is requested",
        threadId: "completion-race-thread",
        turnId: "completion-race-turn",
        canInterrupt: true,
      });
      await providerReleased;
      return {
        threadId: "completion-race-thread",
        turnId: "completion-race-turn",
        status: "completed",
        interrupted: false,
        stopUnconfirmed: false,
      };
    },
  };
  const cycle = new SerializedControlCycle({
    store,
    provider,
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    decisionValidator: async (item) => {
      validationCalls += 1;
      return acceptedDecision(item);
    },
  });
  await cycle.initialize();
  await cycle.enqueueReports([report("emergency-stop-completion-race")]);
  const running = cycle.runOnce();
  await waitFor(async () => (await store.snapshot({ eventLimit: 0 })).agents.length > 0);
  await cycle.applyCommand({
    command: "emergency-stop-all",
    reason: "test completion race",
    requestedBy: "test",
  });
  releaseProvider();
  const result = await running;
  assert.equal(result.action, "cancelled");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.control.mode, "emergency_stopped");
  assert.equal(snapshot.items[0].state, "cancelled");
  assert.equal(validationCalls, 0);
});

sqliteBackendTest("expired pre-turn lease is safely requeued", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(report("expired-lease"));
  const claimed = await store.claim({ owner: "crashed-owner" });
  await store.transition(claimed.item.itemId, "leased", {
    fromStates: ["leased"],
    leaseToken: claimed.item.leaseToken,
    patch: { leaseExpiresAtUtc: "2000-01-01T00:00:00Z" },
  });
  const recovery = await store.recover();
  assert.deepEqual(recovery.recovered.map((item) => item.to), ["queued"]);
});

sqliteBackendTest("expired active review requires explicit provider reconciliation", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(report("expired-active-review"));
  const claimed = await store.claim({ owner: "crashed-reviewer" });
  await store.transition(claimed.item.itemId, "review_running", {
    fromStates: ["leased"],
    leaseToken: claimed.item.leaseToken,
    patch: {
      threadId: "thread-expired",
      turnId: "turn-expired",
      leaseExpiresAtUtc: "2000-01-01T00:00:00Z",
    },
  });

  const recovery = await store.recover();
  assert.deepEqual(recovery.recovered, [{
    itemId: claimed.item.itemId,
    from: "review_running",
    to: "recovery_required",
  }]);
  const snapshot = await store.snapshot({ eventLimit: 0 });
  assert.equal(snapshot.items[0].state, "recovery_required");
  assert.equal(snapshot.items[0].leaseToken, null);
  assert.equal(snapshot.items[0].threadId, "thread-expired");
  assert.equal(snapshot.items[0].turnId, "turn-expired");
});

sqliteBackendTest("unconfirmed emergency timeout cannot leave a queue item in cancelling", async (t) => {
  const { store } = await fixture(t);
  await store.enqueue(report("unconfirmed-stop"));
  await store.claim({ owner: "missing-owner" });
  await store.setMode("emergency_stopped", "test timeout");
  const finalized = await store.finalizeStop("provider did not confirm");
  assert.equal(finalized.queueItems.length, 1);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.items[0].state, "stop_unconfirmed");
  assert.equal(snapshot.items[0].leaseToken, null);
});

sqliteBackendTest("worker progress becomes a provider-neutral task and agent projection", async (t) => {
  const { store } = await fixture(t);
  const now = new Date().toISOString();
  await store.upsertProgress({
    schemaVersion: 1,
    contractVersion: "v0.2.0",
    sequence: 1,
    sourceId: "worker-one",
    taskId: "worker-progress",
    title: "Worker progress",
    state: "running",
    phase: "tests",
    summary: { now: "Running tests", done: ["Implemented"], next: ["Report"], blockers: [] },
    plan: [{ id: "tests", title: "Run tests", state: "running", startedAtUtc: now }],
    agents: [{
      agentId: "worker-one-primary",
      parentAgentId: null,
      kind: "primary",
      role: "worker",
      provider: "codex",
      state: "running",
      currentAction: "Running tests",
      lastCompleted: "Implemented",
      nextAction: "Report",
      blockers: [],
      canInterrupt: true,
      startedAtUtc: now,
      lastHeartbeatUtc: now,
      updatedAtUtc: now,
    }],
    evidence: [],
    stopEvents: [],
    startedAtUtc: now,
    updatedAtUtc: now,
    progressSha256: "f".repeat(64),
    progressPath: "worker-one:.orchestrator/progress/outbox/worker-progress/progress.json",
  });
  const projection = createControlProjection(await store.snapshot(), { now: new Date(now) });
  assert.equal(projection.tasks[0].origin, "worker");
  assert.equal(projection.tasks[0].summary.now, "Running tests");
  assert.equal(projection.tasks[0].progress.mode, "steps");
  assert.equal(projection.agents[0].currentAction, "Running tests");
  assert.deepEqual(projection.interventions, []);
});

sqliteBackendTest("v0.3 worker progress keeps semantic age separate from heartbeat and publication", async (t) => {
  const { store } = await fixture(t);
  const semanticAt = "2026-08-17T18:18:48.000Z";
  const heartbeatAt = "2026-08-17T18:19:18.000Z";
  const plan = [{ id: "implementation", title: "Implement confirmed behavior", state: "running", startedAtUtc: semanticAt }];
  const planSha256 = createHash("sha256")
    .update(JSON.stringify(plan.map(({ id, title }) => ({ id, title }))))
    .digest("hex");
  const progress = {
    schemaVersion: 1,
    contractVersion: "v0.3.0",
    sequence: 1,
    sourceId: "worker-one",
    taskId: "confirmed-plan",
    title: "Confirmed plan",
    state: "running",
    phase: "implementation",
    summary: { now: "Implementing", done: [], next: ["Validate"], blockers: [] },
    plan,
    workflow: {
      policy: "intent-confirm-plan-v1",
      lifecycleStage: "implementation",
      intent: {
        statement: "Implement the user-confirmed behavior.",
        desiredOutcomes: ["The behavior is observable."],
        status: "confirmed",
        confirmedBy: "project-owner",
        confirmedAtUtc: semanticAt,
      },
      plan: {
        revision: 1,
        sha256: planSha256,
        status: "confirmed",
        approvalPath: ".orchestrator/tasks/approvals/confirmed-plan/approval-1.json",
        confirmedBy: "project-owner",
        confirmedAtUtc: semanticAt,
      },
      lastRuleCheckpoint: { kind: "pre_implementation", policy: "intent-confirm-plan-v1", planRevision: 1, recordedAtUtc: semanticAt },
      ruleCheckpoints: [],
    },
    timing: {
      semanticUpdatedAtUtc: semanticAt,
      lastHeartbeatUtc: heartbeatAt,
      heartbeatIntervalSeconds: 60,
      nextHeartbeatDueAtUtc: "2026-08-17T18:20:18.000Z",
    },
    agents: [{
      agentId: "worker-one-primary",
      parentAgentId: null,
      kind: "primary",
      role: "worker",
      provider: "codex",
      state: "running",
      currentAction: "Implementing",
      lastCompleted: null,
      nextAction: "Validate",
      blockers: [],
      canInterrupt: true,
      startedAtUtc: semanticAt,
      lastHeartbeatUtc: heartbeatAt,
      semanticUpdatedAtUtc: semanticAt,
      updatedAtUtc: semanticAt,
    }],
    evidence: [],
    stopEvents: [],
    startedAtUtc: semanticAt,
    updatedAtUtc: heartbeatAt,
    progressSha256: "a".repeat(64),
    progressPath: "worker-one:.orchestrator/progress/outbox/confirmed-plan/progress.json",
  };
  await store.upsertProgress(progress);
  await store.upsertProgress({
    ...progress,
    sequence: 2,
    progressSha256: "b".repeat(64),
  });
  const snapshot = await store.snapshot({ eventLimit: 100 });
  assert.equal(snapshot.events.filter((event) => event.type === "worker.progress_updated").length, 1);
  const projection = createControlProjection(snapshot, { now: new Date(heartbeatAt), publicationIntervalMs: 15_000 });
  assert.equal(projection.tasks[0].intent.statement, "Implement the user-confirmed behavior.");
  assert.equal(projection.tasks[0].workflow.plan.status, "confirmed");
  assert.equal(projection.tasks[0].timing.semanticAgeSeconds, 30);
  assert.equal(projection.tasks[0].timing.heartbeatAgeSeconds, 0);
  assert.equal(projection.agents[0].semanticAgeSeconds, 30);
  assert.equal(projection.publication.intervalSeconds, 15);
});

sqliteBackendTest("an unresolved child UI interruption degrades the backend projection until operator action", async (t) => {
  const { store } = await fixture(t);
  const observedAtUtc = new Date().toISOString();
  const projection = createControlProjection(await store.snapshot(), {
    now: new Date(observedAtUtc),
    interventions: [{
      schemaVersion: 1,
      eventId: "intervention-fixture",
      sourceId: "worker-one",
      taskId: "manual-stop-task",
      threadId: "thread-fixture",
      turnId: "turn-fixture",
      state: "awaiting_operator",
      initiator: "operator-ui",
      actor: { type: "human", id: "local-operator" },
      attribution: "correlated",
      reason: "User stopped the active turn in the managed Codex UI",
      observedAtUtc,
    }],
  });
  assert.equal(projection.health, "degraded");
  assert.equal(projection.counts.awaiting_operator, 1);
  assert.equal(projection.interventions[0].initiator, "operator-ui");
  assert.equal(projection.interventions[0].actor.type, "human");
  assert.deepEqual(projection.interventions[0].availableActions, ["resume", "cancel"]);
});

sqliteBackendTest("a resolved child cancellation reconciles stale worker progress only with terminal provider evidence", async (t) => {
  const { store } = await fixture(t);
  const observedAtUtc = "2026-08-16T18:04:29.784Z";
  const resolvedAtUtc = "2026-08-16T18:05:27.619Z";
  await store.upsertProgress(workerProgress("manual-stop-task", {
    now: "2026-08-16T18:04:16.485Z",
  }));
  const rawSnapshot = await store.snapshot();
  const baseIntervention = {
    schemaVersion: 1,
    eventId: "resolved-intervention-fixture",
    sourceId: "worker-one",
    taskId: "manual-stop-task",
    threadId: "thread-fixture",
    turnId: "turn-fixture",
    state: "resolved",
    initiator: "operator-ui",
    actor: { type: "human", id: "local-operator" },
    attribution: "correlated",
    reason: "User stopped the active turn in the managed Codex UI",
    observedAtUtc,
    availableActions: [],
    resolution: {
      action: "cancel",
      requestedBy: "local-operator",
      reason: "Operator confirmed that the interrupted task should remain cancelled",
      atUtc: resolvedAtUtc,
    },
  };

  const unconfirmed = createControlProjection(rawSnapshot, {
    now: new Date(resolvedAtUtc),
    interventions: [baseIntervention],
  });
  assert.equal(unconfirmed.tasks[0].state, "waiting");
  assert.equal(unconfirmed.counts["worker:waiting"], 1);

  const confirmed = createControlProjection(rawSnapshot, {
    now: new Date(resolvedAtUtc),
    interventions: [{
      ...baseIntervention,
      providerEvent: {
        type: "turn_aborted",
        reason: "interrupted",
        atUtc: observedAtUtc,
      },
    }],
  });
  assert.equal(rawSnapshot.workerTasks[0].state, "waiting");
  assert.equal(confirmed.tasks[0].state, "cancelled");
  assert.equal(confirmed.tasks[0].phase, "cancelled");
  assert.equal(confirmed.tasks[0].freshness, "live");
  assert.equal(confirmed.tasks[0].currentStep, null);
  assert.deepEqual(confirmed.tasks[0].summary.next, []);
  assert.equal(confirmed.tasks[0].capabilities.canCancel, false);
  assert.equal(confirmed.agents[0].state, "interrupted");
  assert.equal(confirmed.agents[0].capabilities.canInterrupt, false);
  assert.equal(confirmed.counts["worker:cancelled"], 1);
  assert.equal(confirmed.counts["worker:waiting"], undefined);
  assert.equal(confirmed.activeTaskId, null);
  assert.equal(confirmed.health, "ready");
  assert.deepEqual(confirmed.interventions, []);
});

sqliteBackendTest("the control cycle reads resolved interventions when writing projections", async (t) => {
  const { root, store } = await fixture(t);
  const taskId = "resolved-cycle-task";
  const observedAtUtc = "2026-08-16T18:04:29.784Z";
  const resolvedAtUtc = "2026-08-16T18:05:27.619Z";
  await store.upsertProgress(workerProgress(taskId, { now: "2026-08-16T18:04:16.485Z" }));
  const interventionDirectory = path.join(
    root,
    ".project-local",
    "orchestration",
    "child-interventions",
  );
  await mkdir(interventionDirectory, { recursive: true });
  await writeFile(path.join(interventionDirectory, "worker-one.json"), `${JSON.stringify({
    schemaVersion: 1,
    eventId: "resolved-cycle-intervention",
    sourceId: "worker-one",
    taskId,
    threadId: "thread-fixture",
    turnId: "turn-fixture",
    state: "resolved",
    initiator: "operator-ui",
    actor: { type: "human", id: "local-operator" },
    attribution: "correlated",
    source: "openai-codex-vscode-ui",
    reason: "User stopped the active turn",
    providerEvent: { type: "turn_aborted", reason: "interrupted", atUtc: observedAtUtc },
    observedAtUtc,
    availableActions: [],
    resolution: {
      action: "cancel",
      requestedBy: "local-operator",
      reason: "Cancellation accepted",
      atUtc: resolvedAtUtc,
    },
  }, null, 2)}\n`, "utf8");
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider(),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
  });

  const projection = await cycle.writeProjection();
  assert.equal(projection.tasks[0].state, "cancelled");
  assert.equal(cycle.lastAttentionProjection.attentionRequired, false);
});

sqliteBackendTest("old tool logs are bundled only after a verified gzip and manifest", async (t) => {
  const { root } = await fixture(t);
  const old = path.join(root, "logs", "old");
  await mkdir(old, { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    await writeFile(path.join(old, `serialized_control_cycle-20260101T00000${index}Z.log`), `line ${index}\n`, "utf8");
  }
  const result = await compactToolRunHistory({
    repoRoot: root,
    toolName: "serialized_control_cycle",
    maxLooseFiles: 4,
    retainLooseFiles: 2,
  });
  assert.equal(result.archivedFiles, 4);
  const archiveNames = await readdir(path.join(old, "archives"));
  const manifestName = archiveNames.find((name) => name.endsWith(".manifest.json"));
  const manifest = JSON.parse(await readFile(path.join(old, "archives", manifestName), "utf8"));
  assert.equal(manifest.archivedFiles.length, 4);
  assert.equal((await readdir(old)).filter((name) => name.endsWith(".log")).length, 2);
});

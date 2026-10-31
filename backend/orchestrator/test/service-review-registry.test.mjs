import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { createProvider, loadConfiguration } from "../src/control-cli.mjs";
import { SerializedControlCycle } from "../src/control-cycle.mjs";
import { FakeReviewProvider } from "../src/control-review-provider.mjs";
import { ServiceReviewRegistry } from "../src/service-review-registry.mjs";
import { SqliteControlStore } from "../src/sqlite-control-store.mjs";

async function fixture(t, prefix = "service-review-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

function report(taskId) {
  return {
    sourceId: "worker-one",
    taskId,
    reportId: `${taskId}-report`,
    title: taskId,
    reportStatus: "completed",
    reportSha256: "a".repeat(64),
    taskSha256: "b".repeat(64),
    sourceRevision: "local-test-revision",
    reportPath: `knowledge/reports/${taskId}.md`,
    taskPath: `coordination/tasks/${taskId}.json`,
    decisionPath: `coordination/reviews/${taskId}/decision.json`,
    priority: 0,
    dispatchSequence: 0,
    dependencies: [],
    plan: [{ id: "review", title: "Review report", state: "pending" }],
    summary: "Waiting for review",
  };
}

async function writeConfiguration(root, extra) {
  const configPath = path.join(root, "control-cycle.json");
  await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1, controllerRoot: root, ...extra }, null, 2)}\n`, "utf8");
  return configPath;
}

// Claude Code reviews the reports: the Codex App Server reviewer, its CODEX_HOME
// and the executable found in the VS Code extensions left with the Codex path.
test("the review provider is Claude Code; a Codex reviewer configuration is refused", async (t) => {
  const root = await fixture(t, "service-review-config-");
  const codex = await writeConfiguration(root, { interactiveCodexHome: ".project-runtime/codex-home",
    provider: { type: "codex-app-server", codexHome: ".project-runtime/reviewer-codex-home" } });
  await assert.rejects(loadConfiguration(codex), /codex-app-server \(the Codex path left the product; use claude-code\)/u);
  await assert.rejects(loadConfiguration(codex, { requireProvider: false }), /the Codex path left the product/u);
  assert.throws(() => createProvider({ controllerRoot: root, provider: { type: "codex-app-server" } }),
    /the Codex path left the product/u);
  assert.throws(() => createProvider({ controllerRoot: root, provider: { type: "other" } }), /Unsupported review provider: other/u);

  // No provider named: Claude Code, whose machine-local config is checked before a queue item is claimed.
  const unnamed = await writeConfiguration(root, { interactiveCodexHome: ".project-runtime/codex-home" });
  await assert.rejects(loadConfiguration(unnamed), { code: "claude_provider_config_missing" });
  const configuration = await loadConfiguration(unnamed, { requireProvider: false });
  assert.deepEqual(configuration.provider, { type: "claude-code" });
  assert.equal(Object.hasOwn(configuration, "reviewerCodexHome"), false);
});

test("service review registry looks for no Codex rollout and still reads an old record", async (t) => {
  const root = await fixture(t, "service-review-rollout-");
  const registry = new ServiceReviewRegistry({
    indexPath: path.join(root, ".project-local", "orchestration", "service-review-index.v1.json"),
  });
  await registry.initialize();
  assert.equal(typeof registry.locateRawTrace, "undefined");
  const old = await registry.upsert({ serviceRunId: "review-old", provider: "codex-app-server", status: "completed",
    rawTrace: { available: true, locator: "sessions/2026/08/17/rollout.jsonl", sha256: "d".repeat(64), bytes: 10,
      archiveState: "live" } });
  assert.equal(old.rawTrace.available, true);
  assert.equal(old.rawTrace.home, "reviewer-codex-home");
  assert.equal((await registry.get("review-old")).rawTrace.locator, "sessions/2026/08/17/rollout.jsonl");
});

test("serialized review publishes only a bounded diagnostic projection", async (t) => {
  const root = await fixture(t, "service-review-cycle-");
  const store = new SqliteControlStore({ databasePath: path.join(root, "control.db") });
  const registry = new ServiceReviewRegistry({
    indexPath: path.join(root, ".project-local", "orchestration", "service-review-index.v1.json"),
  });
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider({ delayMs: 5 }),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    serviceReviewRegistry: registry,
    decisionValidator: async (item) => ({
      decision: {
        schemaVersion: 1,
        taskId: item.taskId,
        sourceId: item.sourceId,
        reportSha256: item.reportSha256,
        outcome: "accepted",
        summary: "Accepted from bounded diagnostic test",
        acceptanceChecks: [{ criterion: "test", status: "passed", evidence: "fixture" }],
        risks: ["One bounded risk"],
        requiredFollowUps: [],
        humanApprovalRequired: false,
        decisionDocument: null,
        decidedAtUtc: new Date().toISOString(),
      },
      decisionPath: path.join(root, "unused.json"),
      decisionReference: item.decisionPath,
      decisionSha256: "c".repeat(64),
    }),
  });
  await cycle.initialize();
  await cycle.enqueueReports([report("diagnostic-review")]);
  const result = await cycle.runOnce();
  const projected = result.projection.tasks.find((task) => task.taskId === "diagnostic-review");
  assert.equal(projected.diagnostics.status, "completed");
  assert.equal(projected.diagnostics.summary, "Accepted from bounded diagnostic test");
  assert.deepEqual(projected.diagnostics.problems, ["One bounded risk"]);
  assert.equal(projected.diagnostics.rawTraceAvailable, false);
  assert.equal(Object.hasOwn(projected.diagnostics, "threadId"), false);
  assert.equal(Object.hasOwn(projected.diagnostics, "rawTrace"), false);
  const projectedReviewAgents = result.projection.agents.filter((agent) => agent.taskId === "diagnostic-review");
  assert.ok(projectedReviewAgents.length > 0);
  for (const agent of projectedReviewAgents) {
    assert.deepEqual(agent.externalReferences, { threadId: null, turnId: null });
  }

  const records = await registry.list({ taskId: "diagnostic-review" });
  assert.equal(records.length, 1);
  assert.equal(records[0].threadId, "fake-thread-diagnostic-review");
  assert.equal(records[0].decision.sha256, "c".repeat(64));
  const persisted = JSON.parse(await readFile(registry.indexPath, "utf8"));
  assert.equal(persisted.records.length, 1);
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAUDE_REVIEW_TOOLS, CLAUDE_SERVICE_JOURNAL_FOLDER, createClaudeReportSummarizer, createClaudeReviewProvider,
  reviewWriteZone,
} from "../src/claude-code-service-client.mjs";
import { createProvider, loadConfiguration } from "../src/control-cli.mjs";
import { validateReviewDecision } from "../src/control-cycle.mjs";
import { FAKE_MODEL, FAKE_ZOD, createFakeClaudeSdk, fakeResult, signedIn } from "./fixtures/fake-claude-sdk.mjs";

const MODELS = [{ id: FAKE_MODEL, displayName: "Claude test", efforts: ["low", "high"], defaultEffort: "low" }];
const TASK = "solver-fix-002";
const DECISION = `coordination/reviews/${TASK}/decision.json`;
const ITEM = { itemId: `desk-solver--${TASK}`, taskId: TASK, sourceId: "desk-solver", attempts: 1,
  reportPath: `knowledge/reports/inbox/${TASK}/report.md`, reportSha256: "a".repeat(64), decisionPath: DECISION,
  evidence: [] };

async function controller(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-service-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const claudeOf = (sdk) => ({ sdk, readAccount: signedIn, models: MODELS });
const init = (sessionId) => ({ type: "system", subtype: "init", session_id: sessionId, model: FAKE_MODEL });
const say = (sessionId, content) => ({ type: "assistant", uuid: randomUUID(), session_id: sessionId,
  parent_tool_use_id: null, message: { content } });

function recorder() {
  const seen = { started: null, agents: [], statistics: [], events: [] };
  return {
    seen,
    callbacks: {
      onStarted: async (value) => { seen.started = value; },
      onAgent: async (agent) => { seen.agents.push(agent); },
      onStatistics: async (value) => { seen.statistics.push(value); },
      onEvent: async (event) => { seen.events.push(event.type); },
    },
  };
}

test("the Claude reviewer writes only its decision, and its turn reads like the Codex reviewer's", async (t) => {
  const root = await controller(t);
  const verdicts = [];
  const answers = [];
  const decision = { schemaVersion: 1, taskId: TASK, sourceId: "desk-solver", reportSha256: "a".repeat(64),
    outcome: "accepted", summary: "Damping matches the reference.", acceptanceChecks: ["Damping matches"],
    risks: [], humanApprovalRequired: false, decidedAtUtc: "2026-10-02T12:00:00.000Z" };
  const sdk = createFakeClaudeSdk({ turns: [async function* review({ sessionId, options, ask }) {
    yield init(sessionId);
    // Every hook runs; the secret hook comes first, then the write zone.
    const hooks = options.hooks.PreToolUse[0].hooks;
    assert.equal(hooks.length, 2);
    for (const file of [path.join(root, "knowledge", "notes.md"), path.join(root, ...DECISION.split("/")),
      path.join(root, "coordination", "reviews", "other-task", "decision.json")]) {
      let verdict = "pass";
      for (const hook of hooks) {
        verdict = (await hook({ tool_name: "Write", tool_input: { file_path: file } })).hookSpecificOutput?.permissionDecision ?? verdict;
      }
      verdicts.push(verdict);
    }
    const secret = await hooks[0]({ tool_name: "Read", tool_input: { file_path: path.join(root, ".project-local", "x", ".credentials.json") } });
    assert.equal(secret.hookSpecificOutput.permissionDecision, "deny");
    // Nobody watches the turn: a read anywhere is allowed, a command never runs.
    answers.push((await ask("Read", { file_path: "Q:/elsewhere/source.md" }, "toolu_read1")).behavior);
    answers.push((await ask("Bash", { command: "git push" }, "toolu_bash1")).behavior);
    const file = path.join(root, ...DECISION.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(decision));
    yield say(sessionId, [{ type: "tool_use", id: "toolu_write1", name: "Write",
      input: { file_path: file, content: "{}" } }]);
    yield { type: "user", session_id: sessionId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_write1", content: "written" }] } };
    yield say(sessionId, [{ type: "text", text: "Decision written." }]);
    yield fakeResult(sessionId);
  }] });
  const provider = createClaudeReviewProvider({ controllerRoot: root, claude: { ...claudeOf(sdk), zod: FAKE_ZOD },
    provider: { model: FAKE_MODEL, reasoningEffort: "high", pollIntervalMs: 10 } });
  assert.equal(provider.describe().provider, "claude-code");
  const { seen, callbacks } = recorder();
  const result = await provider.runReview(ITEM, callbacks);

  assert.equal(result.status, "completed");
  assert.equal(result.interrupted, false);
  assert.equal(result.providerMetadata.provider, "claude-code");
  assert.equal(result.providerMetadata.serviceName, "claude_code_serialized_reviewer");
  assert.equal(result.providerMetadata.model, FAKE_MODEL);
  assert.equal(result.providerMetadata.reasoningEffort, "high");
  assert.equal(seen.started.threadId, result.threadId);
  assert.ok(seen.agents.every((agent) => agent.provider === "claude-code"));
  assert.equal(seen.agents.at(-1).state, "completed");
  assert.ok(seen.events.includes("provider.item/completed"));
  assert.equal(seen.statistics.length, 1);
  assert.equal(seen.statistics[0].statistics.cost.status, "unavailable");

  assert.deepEqual(verdicts, ["deny", "pass", "deny"], "only the item's own review folder");
  assert.deepEqual(answers, ["allow", "deny"]);
  const call = sdk.calls[0];
  assert.deepEqual(call.options.tools, [...CLAUDE_REVIEW_TOOLS]);
  // Its one desk tool hashes a file, read only (it has no shell for the review's SHA-256 checks).
  assert.deepEqual(call.options.allowedTools, ["mcp__desk__file_sha256"]);
  const hashTool = call.options.mcpServers.desk.tools.find((tool) => tool.name === "file_sha256");
  const hashed = await hashTool.handler({ path: DECISION });
  const expected = createHash("sha256").update(await readFile(path.join(root, ...DECISION.split("/")))).digest("hex");
  assert.match(hashed.content[0].text, new RegExp(`^sha256 ${expected} `, "u"));
  assert.match((await hashTool.handler({ path: "nothing/here.md" })).content[0].text, /no such file/u);
  assert.deepEqual(call.options.skills, []);
  assert.equal(call.options.strictMcpConfig, true);
  assert.equal(call.options.permissionMode, "acceptEdits");
  assert.equal(call.options.model, FAKE_MODEL);
  assert.equal(call.options.effort, "high");
  assert.equal(call.options.cwd, root);
  assert.match(call.prompt.message.content, /\.agents\/skills\/review-child-report\/SKILL\.md/u);
  assert.match(call.prompt.message.content, new RegExp(`Write the structured review decision to: ${DECISION}`, "u"));

  // The owner's validator takes the decision; the turn is in the service journal, not the desk's.
  assert.equal((await validateReviewDecision(ITEM, { controllerRoot: root })).decision.outcome, "accepted");
  const journal = path.join(root, ".project-local", "orchestration", CLAUDE_SERVICE_JOURNAL_FOLDER, result.threadId);
  assert.ok((await lstat(path.join(journal, "session.json"))).isFile());
  assert.equal(await lstat(path.join(root, ".project-local", "orchestration", "claude-sessions")).catch(() => null), null);
});

test("a cancelled Claude review stops its turn and says so", async (t) => {
  const root = await controller(t);
  const sdk = createFakeClaudeSdk({ turns: [async function* hold({ sessionId, interrupted }) {
    yield init(sessionId);
    await interrupted;
    yield { type: "result", subtype: "error_during_execution", session_id: sessionId, is_error: true };
  }] });
  const provider = createClaudeReviewProvider({ controllerRoot: root, claude: claudeOf(sdk),
    provider: { model: FAKE_MODEL, reasoningEffort: "low", pollIntervalMs: 10 } });
  const { seen, callbacks } = recorder();
  let asked = 0;
  const result = await provider.runReview(ITEM, { ...callbacks,
    shouldCancel: async () => (++asked >= 2 ? { scope: "task", reason: "Stopped by the person" } : null) });
  assert.equal(result.status, "interrupted");
  assert.equal(result.interrupted, true);
  assert.equal(result.stopUnconfirmed, false);
  assert.equal(sdk.calls[0].interrupted, true);
  assert.ok(seen.events.includes("provider.interrupt_confirmed"));
  assert.equal(seen.agents.at(-1).state, "interrupted");
});

test("the Claude summarizer has no tools and returns what Claude wrote", async (t) => {
  const root = await controller(t);
  const sdk = createFakeClaudeSdk({ turns: [async function* summary({ sessionId }) {
    yield init(sessionId);
    yield say(sessionId, [{ type: "text", text: "Damping tuned; no risks named." }]);
    yield fakeResult(sessionId);
  }] });
  const summarizer = createClaudeReportSummarizer({ controllerRoot: root, claude: claudeOf(sdk) });
  assert.deepEqual((await summarizer.listModels()).data.map((model) => model.id), [FAKE_MODEL]);
  const report = { sourceId: "desk-solver", taskId: TASK, sha256: "b".repeat(64), text: "## Outcome\n\nTuned." };
  const generated = await summarizer.summarize(report, { model: FAKE_MODEL, reasoningEffort: "low", language: "English" });
  assert.equal(generated.summary, "Damping tuned; no risks named.");
  assert.equal(generated.provider, "claude-code");
  assert.equal(generated.serviceName, "claude_code_report_summarizer");
  assert.equal(generated.model, FAKE_MODEL);
  const call = sdk.calls.at(-1);
  assert.deepEqual(call.options.tools, []);
  assert.match(call.options.systemPrompt.append, /read-only report summarizer/u);
  // No write zone; the secret hook goes with every Claude session.
  assert.equal(call.options.hooks.PreToolUse[0].hooks.length, 1);
  assert.match(call.prompt.message.content, /<immutable-report>/u);
  await assert.rejects(summarizer.summarize(report, { model: "claude-unknown", reasoningEffort: "low" }),
    { code: "MODEL_UNAVAILABLE" });
});

test("the controller takes Claude Code as its review provider without a Codex home", async (t) => {
  const root = await controller(t);
  const configPath = path.join(root, "control-cycle.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, controllerRoot: root,
    provider: { type: "claude-code", model: FAKE_MODEL, reasoningEffort: "high" } }));
  await assert.rejects(loadConfiguration(configPath), { code: "claude_provider_config_missing" });
  const statusOnly = await loadConfiguration(configPath, { requireProvider: false });
  assert.equal(statusOnly.provider.type, "claude-code");
  await mkdir(path.join(root, ".project-local", "application-gateway"), { recursive: true });
  await writeFile(path.join(root, ".project-local", "application-gateway", "claude-provider.json"),
    JSON.stringify({ schemaVersion: 1, sdkPath: path.join(root, "sdk", "sdk.mjs"), models: MODELS }));
  const configuration = await loadConfiguration(configPath);
  // No Codex executable is looked for (the Codex path left the product).
  assert.deepEqual(configuration.provider, { type: "claude-code", model: FAKE_MODEL, reasoningEffort: "high" });
  const provider = createProvider(configuration);
  assert.equal(provider.describe().provider, "claude-code");
  assert.equal(provider.describe().model, FAKE_MODEL);
  assert.deepEqual(reviewWriteZone(ITEM), [`coordination/reviews/${TASK}/**`]);
  assert.deepEqual(reviewWriteZone({ taskId: "other-task" }), ["coordination/reviews/other-task/**"]);
});

import { createHash } from "node:crypto";
import {
  mergeAgentStatistics,
  statisticsFromThreadUsage,
  statisticsFromTokenUsage,
} from "./agent-statistics.mjs";
import { listCodexModels, resolveSummaryModelProfile } from "./report-presentation.mjs";

export const REVIEW_PROMPT_TEMPLATE_VERSION = "v1.0.0";
export const REVIEW_SERVICE_NAME = "isolate_vscode_serialized_reviewer";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function activeTurnId(thread) {
  const active = new Set(["inProgress", "running", "active"]);
  return [...(thread?.turns ?? [])].reverse().find((turn) => active.has(turn?.status))?.id ?? null;
}

function stableAgentId(taskId, threadId, kind = "reviewer") {
  const digest = createHash("sha256").update(String(threadId)).digest("hex").slice(0, 12);
  return `${kind}-${taskId}-${digest}`.slice(0, 96).replace(/[^a-z0-9._-]/g, "-");
}

function itemAction(item, completed = false) {
  const kind = item?.type || "provider item";
  const named = item?.name || item?.tool || item?.command?.name || null;
  const suffix = named ? `: ${String(named).slice(0, 128)}` : "";
  return `${completed ? "Completed" : "Running"} ${kind}${suffix}`.slice(0, 512);
}

function codexVersionFromInitialization(initialization) {
  const candidates = [
    initialization?.serverInfo?.version,
    initialization?.serverVersion,
    initialization?.codexVersion,
    initialization?.version,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim()) ?? null;
}

export function buildReviewPrompt(item, {
  reviewSkill = "$review-child-report",
  startPrompt = "start prompt.md",
} = {}) {
  const decisionPath = item.decisionPath || `coordination/reviews/${item.taskId}/decision.json`;
  const progress = item.evidence?.find((entry) => entry.kind === "progress")?.path;
  const executionSummary = item.evidence?.find((entry) => entry.kind === "execution-summary")?.path;
  return [
    "Process exactly one serialized child-report review.",
    `Read ${startPrompt} and use ${reviewSkill}.`,
    `Task packet: ${item.taskPath || `coordination/tasks/dispatched/${item.taskId}/task.md`}`,
    `Imported report: ${item.reportPath}`,
    `Expected report SHA-256: ${item.reportSha256}`,
    ...(progress ? [`Bounded child progress: ${progress}`] : []),
    ...(executionSummary ? [`Bounded child execution summary: ${executionSummary}`] : []),
    `Write the structured review decision to: ${decisionPath}`,
    "Do not collect, review, or comment on any other queued report in this turn.",
    "Do not include raw provider history, media bytes, full logs, or chain-of-thought in the decision.",
    "Stop promptly when the orchestration cancellation contract requests interruption.",
  ].join("\n");
}

// Runs one serialized review on a client of the App Server shape (connect,
// startThread, startTurn, waitForTurn, interruptTurn, usage, notifications).
// The factory makes that client for the item under review: Claude Code's
// (claude-code-service-client.mjs) in the product, a fake one in the tests.
// The Codex App Server client that once was the default left with the Codex path.
export class ServiceReviewProvider {
  constructor({
    cwd,
    model,
    reasoningEffort,
    clientVersion = "0.6.0",
    pollIntervalMs = 500,
    heartbeatIntervalMs = 60_000,
    turnTimeoutMs = 3_600_000,
    interruptConfirmationTimeoutMs = 10_000,
    clientFactory,
    providerId,
    serviceName = REVIEW_SERVICE_NAME,
    promptOptions = {},
  } = {}) {
    if (!cwd) throw new Error("ServiceReviewProvider requires cwd");
    if (typeof clientFactory !== "function") throw new Error("ServiceReviewProvider requires clientFactory");
    if (!providerId) throw new Error("ServiceReviewProvider requires providerId");
    this.cwd = cwd;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.clientVersion = clientVersion;
    this.pollIntervalMs = pollIntervalMs;
    this.heartbeatIntervalMs = Math.max(pollIntervalMs, heartbeatIntervalMs);
    this.turnTimeoutMs = turnTimeoutMs;
    this.interruptConfirmationTimeoutMs = interruptConfirmationTimeoutMs;
    this.clientFactory = clientFactory;
    this.providerId = providerId;
    this.serviceName = serviceName;
    this.promptOptions = promptOptions;
  }

  describe() {
    return {
      provider: this.providerId,
      serviceName: this.serviceName,
      model: this.model ?? null,
      reasoningEffort: this.reasoningEffort ?? null,
      clientVersion: this.clientVersion,
      promptTemplateVersion: REVIEW_PROMPT_TEMPLATE_VERSION,
    };
  }

  async runReview(item, {
    prompt = buildReviewPrompt(item, this.promptOptions),
    shouldCancel = async () => false,
    onStarted = async () => {},
    onHeartbeat = async () => {},
    onAgent = async () => {},
    onStatistics = async () => {},
    onEvent = async () => {},
  } = {}) {
    const client = this.clientFactory(item);
    let eventQueue = Promise.resolve();
    const threadAgents = new Map();
    const agentThreads = new Map();
    const threadParents = new Map();
    let rootThreadId = null;
    let rootTurnId = null;
    let interruptRequested = false;
    let stopUnconfirmed = false;
    const processedAgentCancellations = new Set();
    const preservedTerminalAgents = new Set();
    const pendingStatistics = new Map();

    const publishStatistics = async (threadId, statistics) => {
      const agentId = threadAgents.get(threadId);
      if (!agentId) {
        pendingStatistics.set(
          threadId,
          mergeAgentStatistics(pendingStatistics.get(threadId), statistics),
        );
        return;
      }
      await onStatistics({
        agentId,
        itemId: item.itemId,
        threadId,
        statistics,
      });
    };

    const flushPendingStatistics = async (threadId) => {
      const statistics = pendingStatistics.get(threadId);
      if (!statistics) return;
      pendingStatistics.delete(threadId);
      await publishStatistics(threadId, statistics);
    };

    const queueEvent = (operation) => {
      eventQueue = eventQueue.then(operation, operation);
    };
    client.on("notification", (message) => {
      queueEvent(async () => {
        const params = message.params ?? {};
        const thread = params.thread ?? null;
        const threadId = params.threadId ?? thread?.id ?? null;
        const turnId = params.turnId ?? params.turn?.id ?? null;
        if (message.method === "thread/started" && threadId) {
          const isRoot = threadId === rootThreadId || !thread?.parentThreadId;
          const agentId = stableAgentId(item.taskId, threadId, isRoot ? "reviewer" : "subagent");
          threadAgents.set(threadId, agentId);
          agentThreads.set(agentId, threadId);
          if (thread?.parentThreadId) threadParents.set(threadId, thread.parentThreadId);
          await onAgent({
            agentId,
            itemId: item.itemId,
            parentAgentId: thread?.parentThreadId ? threadAgents.get(thread.parentThreadId) ?? null : null,
            kind: isRoot ? "reviewer" : "subagent",
            role: isRoot ? "child-report-reviewer" : "bounded-review-subagent",
            provider: this.providerId,
            state: "running",
            currentAction: isRoot ? "Reviewing one immutable child report" : "Running bounded delegated review work",
            threadId,
            turnId,
            canInterrupt: true,
          });
          await flushPendingStatistics(threadId);
        }
        if ((message.method === "item/started" || message.method === "item/completed") && threadId) {
          const agentId = threadAgents.get(threadId) ?? stableAgentId(item.taskId, threadId, "agent");
          const completed = message.method === "item/completed";
          await onAgent({
            agentId,
            itemId: item.itemId,
            parentAgentId: threadParents.get(threadId)
              ? threadAgents.get(threadParents.get(threadId)) ?? null
              : null,
            kind: threadId === rootThreadId ? "reviewer" : "subagent",
            role: threadId === rootThreadId ? "child-report-reviewer" : "bounded-review-subagent",
            provider: this.providerId,
            state: "running",
            currentAction: completed ? "Continuing after a completed provider item" : itemAction(params.item, false),
            lastCompleted: completed ? itemAction(params.item, true) : null,
            threadId,
            turnId,
            canInterrupt: true,
          });
        }
        if (message.method === "thread/tokenUsage/updated" && threadId && params.tokenUsage) {
          await publishStatistics(threadId, statisticsFromTokenUsage(params.tokenUsage, {
            source: "codex-app-server-event",
            updatedAtUtc: new Date().toISOString(),
            scope: "agent-task",
          }));
        }
        await onEvent({
          type: `provider.${message.method}`,
          itemId: item.itemId,
          agentId: threadId ? threadAgents.get(threadId) ?? null : null,
          data: { threadId, turnId },
        });
      });
    });

    try {
      const initialization = await client.connect();
      const profile = resolveSummaryModelProfile(await listCodexModels(client), {
        model: this.model,
        reasoningEffort: this.reasoningEffort,
      });
      const started = await client.startThread({
        cwd: this.cwd,
        model: profile.model,
        config: { model_reasoning_effort: profile.reasoningEffort },
        allowProviderModelFallback: false,
        serviceName: this.serviceName,
      });
      rootThreadId = started.thread?.id;
      if (!rootThreadId) throw new Error("Review provider returned no thread id");
      await client.setThreadName(rootThreadId, `[review] ${item.sourceId}/${item.taskId}`);
      const turnResult = await client.startTurn(rootThreadId, prompt);
      rootTurnId = turnResult.turn?.id;
      if (!rootTurnId) throw new Error("Review provider returned no turn id");
      const rootAgentId = stableAgentId(item.taskId, rootThreadId, "reviewer");
      threadAgents.set(rootThreadId, rootAgentId);
      agentThreads.set(rootAgentId, rootThreadId);
      const providerMetadata = {
        ...this.describe(),
        model: started.thread?.model ?? profile.model,
        reasoningEffort: started.thread?.reasoningEffort ?? profile.reasoningEffort,
        codexVersion: codexVersionFromInitialization(initialization),
      };
      await onStarted({
        threadId: rootThreadId,
        turnId: rootTurnId,
        agentId: rootAgentId,
        providerMetadata,
      });
      await onAgent({
        agentId: rootAgentId,
        itemId: item.itemId,
        parentAgentId: null,
        kind: "reviewer",
        role: "child-report-reviewer",
        provider: this.providerId,
        state: "running",
        currentAction: "Reviewing one immutable child report",
        threadId: rootThreadId,
        turnId: rootTurnId,
        canInterrupt: true,
      });
      await flushPendingStatistics(rootThreadId);

      const turnPromise = client.waitForTurn(rootTurnId, this.turnTimeoutMs)
        .then((params) => ({ terminal: true, params }));
      let completed;
      let nextHeartbeatAt = 0;
      while (!completed) {
        completed = await Promise.race([
          turnPromise,
          delay(this.pollIntervalMs).then(() => null),
        ]);
        if (completed) break;
        const cancellation = await shouldCancel();
        if (cancellation?.scope === "agent") {
          if (!processedAgentCancellations.has(cancellation.agentId)) {
            processedAgentCancellations.add(cancellation.agentId);
            const targetThreadId = cancellation.threadId || agentThreads.get(cancellation.agentId);
            if (targetThreadId) {
              const interrupted = await this.#interruptTree(
                client,
                targetThreadId,
                cancellation.turnId,
                threadAgents,
                item,
                onAgent,
              );
              const targetIsRoot = targetThreadId === rootThreadId;
              interruptRequested ||= targetIsRoot;
              stopUnconfirmed ||= targetIsRoot && interrupted.unconfirmed.length > 0;
              for (const target of [...interrupted.requested, ...interrupted.unconfirmed]) {
                const preservedAgentId = threadAgents.get(target.threadId);
                if (preservedAgentId) preservedTerminalAgents.add(preservedAgentId);
              }
              await onEvent({
                type: interrupted.unconfirmed.length > 0
                  ? "provider.agent_stop_unconfirmed"
                  : "provider.agent_interrupt_confirmed",
                itemId: item.itemId,
                agentId: cancellation.agentId,
                data: { requested: interrupted.requested.length, unconfirmed: interrupted.unconfirmed.length },
              });
            }
          }
        } else if (cancellation && !interruptRequested) {
          interruptRequested = true;
          const interrupted = await this.#interruptTree(client, rootThreadId, rootTurnId, threadAgents, item, onAgent);
          stopUnconfirmed = interrupted.unconfirmed.length > 0;
          await onEvent({
            type: stopUnconfirmed ? "provider.stop_unconfirmed" : "provider.interrupt_confirmed",
            itemId: item.itemId,
            agentId: rootAgentId,
            data: {
              requested: interrupted.requested.length,
              unconfirmed: interrupted.unconfirmed.length,
            },
          });
        }
        const now = Date.now();
        if (now >= nextHeartbeatAt) {
          await onHeartbeat({
            itemId: item.itemId,
            currentAction: interruptRequested ? "Waiting for interruption confirmation" : "Review turn is running",
          });
          nextHeartbeatAt = now + this.heartbeatIntervalMs;
        }
      }
      await eventQueue;
      for (const [threadId, agentId] of threadAgents) {
        try {
          const usage = await client.readThreadUsage(threadId);
          if (usage?.threadUsage) {
            await onStatistics({
              agentId,
              itemId: item.itemId,
              threadId,
              statistics: statisticsFromThreadUsage(usage.threadUsage, {
                source: "codex-app-server-query",
                updatedAtUtc: new Date().toISOString(),
              }),
            });
          }
        } catch (error) {
          await onEvent({
            type: "provider.agent_cost_unavailable",
            itemId: item.itemId,
            agentId,
            data: {
              threadId,
              code: typeof error?.code === "string" ? error.code.slice(0, 128) : null,
            },
          });
        }
      }
      const turnStatus = completed.params?.turn?.status ?? "completed";
      for (const [threadId, agentId] of threadAgents) {
        if (threadId === rootThreadId) continue;
        if (preservedTerminalAgents.has(agentId)) continue;
        await onAgent({
          agentId,
          itemId: item.itemId,
          parentAgentId: threadParents.get(threadId)
            ? threadAgents.get(threadParents.get(threadId)) ?? null
            : rootAgentId,
          kind: "subagent",
          role: "bounded-review-subagent",
          provider: this.providerId,
          state: interruptRequested ? "interrupted" : "completed",
          currentAction: interruptRequested ? "Parent review was interrupted" : "Parent review completed",
          threadId,
          turnId: null,
          canInterrupt: false,
        });
      }
      await onAgent({
        agentId: rootAgentId,
        itemId: item.itemId,
        parentAgentId: null,
        kind: "reviewer",
        role: "child-report-reviewer",
        provider: this.providerId,
        state: stopUnconfirmed
          ? "stop_unconfirmed"
          : turnStatus === "interrupted"
            ? "interrupted"
            : ["failed", "error"].includes(turnStatus)
              ? "failed"
              : "completed",
        currentAction: `Review turn ${turnStatus}`,
        lastCompleted: `Review turn finished with status ${turnStatus}`,
        threadId: rootThreadId,
        turnId: rootTurnId,
        canInterrupt: false,
      });
      return {
        threadId: rootThreadId,
        turnId: rootTurnId,
        status: turnStatus,
        interrupted: interruptRequested,
        stopUnconfirmed,
        providerMetadata,
      };
    } finally {
      await eventQueue;
      await client.close();
    }
  }

  async #interruptTree(client, rootThreadId, rootTurnId, threadAgents, item, onAgent) {
    const requested = [];
    const unconfirmed = [];
    let descendants = [];
    try {
      descendants = (await client.listDescendantThreads(rootThreadId, { limit: 500 })).data ?? [];
    } catch {
      // Root interruption remains useful even when hierarchy discovery fails.
    }
    let resolvedRootTurnId = rootTurnId;
    if (!resolvedRootTurnId) {
      try {
        const root = await client.readThread(rootThreadId, true);
        resolvedRootTurnId = activeTurnId(root.thread ?? root);
      } catch {
        // The unconfirmed result below remains visible to the operator.
      }
    }
    const targets = [{ id: rootThreadId, turnId: resolvedRootTurnId }, ...descendants.map((thread) => ({
      id: thread.id,
      turnId: activeTurnId(thread),
    }))];
    const requestedTargets = [];
    for (const target of targets) {
      const agentId = target.id
        ? threadAgents.get(target.id) ?? stableAgentId(item.taskId, target.id, "agent")
        : null;
      if (!target.id || !target.turnId) {
        if (target.id) {
          unconfirmed.push({ threadId: target.id, turnId: null, error: "No active turn id" });
          await onAgent({
            agentId,
            itemId: item.itemId,
            parentAgentId: null,
            kind: target.id === rootThreadId ? "reviewer" : "subagent",
            role: target.id === rootThreadId ? "child-report-reviewer" : "bounded-review-subagent",
            provider: this.providerId,
            state: "stop_unconfirmed",
            currentAction: "No active provider turn was available to confirm interruption",
            threadId: target.id,
            turnId: null,
            canInterrupt: false,
          });
        }
        continue;
      }
      try {
        await client.interruptTurn(target.id, target.turnId);
        requested.push({ threadId: target.id, turnId: target.turnId });
        requestedTargets.push({ ...target, agentId });
        await onAgent({
          agentId,
          itemId: item.itemId,
          parentAgentId: null,
          kind: target.id === rootThreadId ? "reviewer" : "subagent",
          role: target.id === rootThreadId ? "child-report-reviewer" : "bounded-review-subagent",
          provider: this.providerId,
          state: "cancellation_requested",
          currentAction: "Provider interruption requested",
          threadId: target.id,
          turnId: target.turnId,
          canInterrupt: false,
        });
      } catch (error) {
        unconfirmed.push({ threadId: target.id, turnId: target.turnId, error: error.message });
      }
    }
    for (const target of requestedTargets) {
      try {
        const completed = await client.waitForTurn(target.turnId, this.interruptConfirmationTimeoutMs);
        const status = completed?.turn?.status ?? "completed";
        await onAgent({
          agentId: target.agentId,
          itemId: item.itemId,
          parentAgentId: null,
          kind: target.id === rootThreadId ? "reviewer" : "subagent",
          role: target.id === rootThreadId ? "child-report-reviewer" : "bounded-review-subagent",
          provider: this.providerId,
          state: status === "interrupted" ? "interrupted" : "completed",
          currentAction: `Provider stop confirmed with status ${status}`,
          lastCompleted: `Turn finished with status ${status}`,
          threadId: target.id,
          turnId: target.turnId,
          canInterrupt: false,
        });
      } catch (error) {
        unconfirmed.push({ threadId: target.id, turnId: target.turnId, error: error.message });
        await onAgent({
          agentId: target.agentId,
          itemId: item.itemId,
          parentAgentId: null,
          kind: target.id === rootThreadId ? "reviewer" : "subagent",
          role: target.id === rootThreadId ? "child-report-reviewer" : "bounded-review-subagent",
          provider: this.providerId,
          state: "stop_unconfirmed",
          currentAction: "Provider stop confirmation timed out",
          threadId: target.id,
          turnId: target.turnId,
          canInterrupt: false,
        });
      }
    }
    return { requested, unconfirmed };
  }
}

export class FakeReviewProvider {
  constructor({ result = "completed", delayMs = 25, spawnSubagent = false } = {}) {
    this.result = result;
    this.delayMs = delayMs;
    this.spawnSubagent = spawnSubagent;
  }

  describe() {
    return {
      provider: "fake",
      serviceName: "deterministic_fake_reviewer",
      model: "fake",
      codexVersion: null,
      clientVersion: "test",
      promptTemplateVersion: REVIEW_PROMPT_TEMPLATE_VERSION,
    };
  }

  async runReview(item, callbacks = {}) {
    const threadId = `fake-thread-${item.taskId}`;
    const turnId = `fake-turn-${item.attempts}`;
    const rootAgentId = `reviewer-${item.taskId}`.slice(0, 96);
    const childAgentId = `subagent-${item.taskId}`.slice(0, 96);
    let childInterrupted = false;
    const providerMetadata = this.describe();
    await callbacks.onStarted?.({ threadId, turnId, agentId: rootAgentId, providerMetadata });
    await callbacks.onAgent?.({
      agentId: rootAgentId,
      itemId: item.itemId,
      parentAgentId: null,
      kind: "reviewer",
      role: "fake-reviewer",
      provider: "fake",
      state: "running",
      currentAction: "Running deterministic fake review",
      threadId,
      turnId,
      canInterrupt: true,
    });
    if (this.spawnSubagent) {
      await callbacks.onAgent?.({
        agentId: childAgentId,
        itemId: item.itemId,
        parentAgentId: rootAgentId,
        kind: "subagent",
        role: "fake-evidence-checker",
        provider: "fake",
        state: "running",
        currentAction: "Checking bounded evidence",
        threadId: `${threadId}-child`,
        turnId: `${turnId}-child`,
        canInterrupt: true,
      });
    }
    const deadline = Date.now() + this.delayMs;
    while (Date.now() < deadline) {
      const cancellation = await callbacks.shouldCancel?.();
      if (cancellation?.scope === "agent" && cancellation.agentId === childAgentId && !childInterrupted) {
        childInterrupted = true;
        await callbacks.onAgent?.({
          agentId: childAgentId,
          itemId: item.itemId,
          parentAgentId: rootAgentId,
          kind: "subagent",
          role: "fake-evidence-checker",
          provider: "fake",
          state: "interrupted",
          currentAction: "Fake delegated review interrupted",
          threadId: `${threadId}-child`,
          turnId: `${turnId}-child`,
          canInterrupt: false,
        });
        await callbacks.onEvent?.({
          type: "provider.agent_interrupt_confirmed",
          itemId: item.itemId,
          agentId: childAgentId,
          data: { requested: 1, unconfirmed: 0 },
        });
      } else if (cancellation && cancellation.scope !== "agent") {
        if (this.spawnSubagent && !childInterrupted) {
          childInterrupted = true;
          await callbacks.onAgent?.({
            agentId: childAgentId,
            itemId: item.itemId,
            parentAgentId: rootAgentId,
            kind: "subagent",
            role: "fake-evidence-checker",
            provider: "fake",
            state: "interrupted",
            currentAction: "Parent fake review was interrupted",
            threadId: `${threadId}-child`,
            turnId: `${turnId}-child`,
            canInterrupt: false,
          });
        }
        await callbacks.onAgent?.({
          agentId: rootAgentId,
          itemId: item.itemId,
          parentAgentId: null,
          kind: "reviewer",
          role: "fake-reviewer",
          provider: "fake",
          state: "interrupted",
          currentAction: "Fake review interrupted",
          threadId,
          turnId,
          canInterrupt: false,
        });
        return {
          threadId,
          turnId,
          status: "interrupted",
          interrupted: true,
          stopUnconfirmed: false,
          providerMetadata,
        };
      }
      await callbacks.onHeartbeat?.({ itemId: item.itemId, currentAction: "Fake review is running" });
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    }
    await callbacks.onAgent?.({
      agentId: rootAgentId,
      itemId: item.itemId,
      parentAgentId: null,
      kind: "reviewer",
      role: "fake-reviewer",
      provider: "fake",
      state: this.result === "completed" ? "completed" : "failed",
      currentAction: `Fake review ${this.result}`,
      lastCompleted: `Fake review ${this.result}`,
      threadId,
      turnId,
      canInterrupt: false,
    });
    if (this.spawnSubagent && !childInterrupted) {
      await callbacks.onAgent?.({
        agentId: `subagent-${item.taskId}`.slice(0, 96),
        itemId: item.itemId,
        parentAgentId: rootAgentId,
        kind: "subagent",
        role: "fake-evidence-checker",
        provider: "fake",
        state: this.result === "completed" ? "completed" : "failed",
        currentAction: `Fake delegated review ${this.result}`,
        lastCompleted: `Fake delegated review ${this.result}`,
        threadId: `${threadId}-child`,
        turnId: `${turnId}-child`,
        canInterrupt: false,
      });
    }
    return {
      threadId,
      turnId,
      status: this.result,
      interrupted: false,
      stopUnconfirmed: false,
      providerMetadata,
    };
  }
}

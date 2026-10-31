import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createBackendCapabilities } from "./backend-consumer-api.mjs";
import { acceptVerifiedReport } from "./deterministic-report-acceptance.mjs";
import { readChildInterventions } from "./child-intervention-store.mjs";
import { createAttentionProjection } from "./control-attention-model.mjs";
import { createProjectMemoryStore } from "./project-memory-store.mjs";
import { ProjectMemoryService } from "./project-memory-service.mjs";
import { projectsRoot, STORE_LAYOUT_MARKER } from "./project-store-layout.mjs";
import { createControlProjection, createExecutionSummary, writeProjectionAtomic } from "./control-read-model.mjs";
import { createServiceRunId } from "./service-review-registry.mjs";
import { createWorkProjectionV2FromV1 } from "./work-projection-v2-bridge.mjs";
import {
  publishWorkProjectionV2,
  rollbackWorkProjectionV2,
} from "./work-projection-v2-publication.mjs";

const ACTIVE_STATES = new Set([
  "leased",
  "review_running",
  "decision_validating",
  "integrating",
  "cancelling",
  "recovery_required",
]);
const FORBIDDEN_DECISION_KEYS = new Set(["chainOfThought", "reasoning", "rawLog", "transcript", "prompt"]);
const ABSOLUTE_PATH = /(?:^|[\s"'])(?:[a-z]:[\\/]|\\\\|\/[a-z0-9_.-]+\/)/i;
const INLINE_MEDIA = /data:(?:image|audio|video)\//i;

function problemText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  return String(value.summary ?? value.message ?? value.description ?? value.risk ?? JSON.stringify(value));
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveReference(root, reference, label) {
  if (!reference || path.isAbsolute(reference)) throw new Error(`${label} must be project-relative`);
  const resolved = path.resolve(root, reference);
  if (!pathInside(root, resolved)) throw new Error(`${label} escapes the controller workspace`);
  return resolved;
}

function assertDurableValue(value, key = "root", depth = 0) {
  if (depth > 12) throw new Error("Review decision exceeds maximum object depth");
  if (typeof value === "string") {
    if (value.length > 16_384) throw new Error(`Review decision field '${key}' exceeds the text budget`);
    if (INLINE_MEDIA.test(value)) throw new Error(`Review decision field '${key}' contains inline media`);
    if (ABSOLUTE_PATH.test(value)) throw new Error(`Review decision field '${key}' contains a machine-local path`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`Review decision field '${key}' exceeds the item budget`);
    value.forEach((item, index) => assertDurableValue(item, `${key}[${index}]`, depth + 1));
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (FORBIDDEN_DECISION_KEYS.has(childKey)) {
      throw new Error(`Review decision must not contain '${childKey}'`);
    }
    assertDurableValue(childValue, childKey, depth + 1);
  }
}

export async function validateReviewDecision(item, { controllerRoot }) {
  const reference = item.decisionPath || `coordination/reviews/${item.taskId}/decision.json`;
  const decisionPath = resolveReference(path.resolve(controllerRoot), reference, "decisionPath");
  const decisionText = await readFile(decisionPath, "utf8");
  const decision = JSON.parse(decisionText);
  assertDurableValue(decision);
  if (decision.schemaVersion !== 1) throw new Error("Review decision requires schemaVersion 1");
  if (decision.taskId !== item.taskId) throw new Error("Review decision taskId does not match the queue item");
  if (decision.sourceId !== item.sourceId) throw new Error("Review decision sourceId does not match the queue item");
  if (decision.reportSha256 !== item.reportSha256) throw new Error("Review decision report SHA-256 does not match");
  if (!["accepted", "rejected", "deferred", "superseded"].includes(decision.outcome)) {
    throw new Error(`Unsupported review outcome: ${decision.outcome}`);
  }
  if (!String(decision.summary ?? "").trim()) throw new Error("Review decision requires a compact summary");
  if (!Array.isArray(decision.acceptanceChecks) || decision.acceptanceChecks.length === 0) {
    throw new Error("Review decision requires acceptanceChecks");
  }
  if (decision.humanApprovalRequired && decision.outcome === "accepted") {
    throw new Error("A decision requiring human approval cannot be automatically accepted");
  }
  if (!Number.isFinite(Date.parse(decision.decidedAtUtc))) {
    throw new Error("Review decision requires a valid decidedAtUtc timestamp");
  }
  if (decision.decisionDocument) resolveReference(controllerRoot, decision.decisionDocument, "decisionDocument");
  return {
    decision,
    decisionPath,
    decisionReference: reference,
    decisionSha256: createHash("sha256").update(decisionText).digest("hex"),
  };
}

export class SerializedControlCycle {
  constructor({
    store,
    provider,
    controllerRoot,
    backendCapabilitiesPath,
    projectionPath,
    attentionProjectionPath,
    workProjectionV2DescriptorPath,
    workProjectionV2Enabled = true,
    workProjectionV2Translator = createWorkProjectionV2FromV1,
    workProjectionV2Publisher = publishWorkProjectionV2,
    workProjectionV2Rollback = rollbackWorkProjectionV2,
    executionSummaryRoot,
    leaseOwner = `control-cycle-${process.pid}`,
    leaseSeconds = 120,
    publicationIntervalMs = 15_000,
    serviceReviewRegistry = null,
    decisionValidator = validateReviewDecision,
    integrator = null,
    logger = async () => {},
  }) {
    if (!store) throw new Error("SerializedControlCycle requires a store");
    if (!controllerRoot) throw new Error("SerializedControlCycle requires controllerRoot");
    this.store = store;
    this.provider = provider;
    this.controllerRoot = path.resolve(controllerRoot);
    this.backendCapabilitiesPath = path.resolve(backendCapabilitiesPath ?? path.join(
      this.controllerRoot,
      ".project-local",
      "projections",
      "backend-capabilities.v1.json",
    ));
    this.projectionPath = path.resolve(projectionPath ?? path.join(
      this.controllerRoot,
      ".project-local",
      "projections",
      "control-status.v1.json",
    ));
    this.attentionProjectionPath = path.resolve(attentionProjectionPath ?? path.join(
      this.controllerRoot,
      ".project-local",
      "projections",
      "attention-status.v1.json",
    ));
    this.workProjectionV2DescriptorPath = path.resolve(workProjectionV2DescriptorPath ?? path.join(
      this.controllerRoot,
      ".project-local",
      "projections",
      "backend-capabilities.v2.json",
    ));
    this.executionSummaryRoot = path.resolve(executionSummaryRoot ?? path.join(
      this.controllerRoot,
      ".project-local",
      "execution-summaries",
    ));
    this.leaseOwner = leaseOwner;
    this.leaseSeconds = leaseSeconds;
    if (!Number.isInteger(publicationIntervalMs) || publicationIntervalMs < 10_000 || publicationIntervalMs > 15_000) {
      throw new Error("SerializedControlCycle publicationIntervalMs must be between 10000 and 15000");
    }
    this.publicationIntervalMs = publicationIntervalMs;
    this.serviceReviewRegistry = serviceReviewRegistry;
    this.decisionValidator = decisionValidator;
    this.integrator = integrator;
    this.logger = logger;
    this.lastAttentionProjection = null;
    this.workProjectionV2Enabled = workProjectionV2Enabled !== false;
    this.workProjectionV2Translator = workProjectionV2Translator;
    this.workProjectionV2Publisher = workProjectionV2Publisher;
    this.workProjectionV2Rollback = workProjectionV2Rollback;
    this.lastWorkProjectionV2Publication = null;
  }

  async initialize() {
    if (this.serviceReviewRegistry) await this.serviceReviewRegistry.initialize();
    await this.store.initialize();
    const recovery = await this.store.recover();
    await this.logger("control_cycle_initialized", { recovered: recovery.recovered?.length ?? 0 });
    return this.writeProjection();
  }

  async enqueueReports(reports) {
    const results = [];
    for (const report of reports) results.push(await this.store.enqueue(report));
    await this.writeProjection();
    return results;
  }

  async acceptReport({ sourceId, taskId, acceptanceRoot } = {}) {
    await this.store.initialize();
    await this.store.recover();
    const result = await acceptVerifiedReport({
      store: this.store,
      controllerRoot: this.controllerRoot,
      sourceId,
      taskId,
      acceptanceRoot,
    });
    await this.#writeExecutionSummary(result.item.itemId);
    await this.logger("control_report_accepted", {
      itemId: result.item.itemId,
      sourceId,
      taskId,
      reportSha256: result.item.reportSha256,
      idempotent: result.idempotent,
    });
    return { ...result, projection: await this.writeProjection() };
  }

  async observeWorkerProgress(progressRecords, { writeProjection = true } = {}) {
    const results = [];
    for (const progress of progressRecords) results.push(await this.store.upsertProgress(progress));
    if (writeProjection) await this.writeProjection();
    return results;
  }

  async applyCommand(command) {
    let result;
    switch (command.command) {
      case "pause":
        result = await this.store.setMode("paused", command.reason ?? null);
        break;
      case "drain":
        result = await this.store.setMode("draining", command.reason ?? null);
        break;
      case "resume":
        result = await this.store.setMode("running", command.reason ?? null);
        break;
      case "emergency-stop-all":
        result = await this.store.setMode("emergency_stopped", command.reason ?? "Emergency stop requested");
        break;
      case "cancel-task":
        result = await this.store.requestCancel({ taskId: command.taskId, sourceId: command.sourceId }, command.reason);
        break;
      case "cancel-agent":
        result = await this.store.requestCancel({ agentId: command.agentId }, command.reason);
        break;
      case "retry-item":
        result = await this.store.retry(command.itemId);
        break;
      case "mark-stop-unconfirmed":
        result = await this.store.finalizeStop(command.reason);
        break;
      default:
        throw new Error(`Unsupported control command: ${command.command}`);
    }
    await this.store.addEvent("control.command_applied", {
      data: {
        command: command.command,
        requestedBy: command.requestedBy ?? "unknown",
        reason: command.reason ?? null,
      },
    });
    await this.writeProjection();
    return result;
  }

  async runOnce({ sourceId = null, taskId = null } = {}) {
    await this.store.initialize();
    await this.store.recover();
    let snapshot = await this.store.snapshot();
    const active = snapshot.items.find((item) => ACTIVE_STATES.has(item.state));
    if (snapshot.control.mode === "draining" && !active) {
      await this.store.setMode("paused", "Drain completed; explicit resume required");
      return { action: "drained", projection: await this.writeProjection() };
    }
    if (snapshot.control.mode !== "running") {
      return { action: `control-${snapshot.control.mode}`, projection: await this.writeProjection(snapshot) };
    }
    if (active) {
      return {
        action: active.state === "recovery_required" ? "recovery-required" : "active-review-owned-elsewhere",
        item: active,
        projection: await this.writeProjection(snapshot),
      };
    }

    if (!this.provider) throw new Error("A review provider is required for the review operation");
    const claimed = await this.store.claim({
      owner: this.leaseOwner,
      leaseSeconds: this.leaseSeconds,
      sourceId,
      taskId,
    });
    if (!claimed.item) {
      return { action: claimed.reason, projection: await this.writeProjection() };
    }
    let item = claimed.item;
    const leaseToken = item.leaseToken;
    const serviceRunId = this.serviceReviewRegistry ? createServiceRunId() : null;
    let lastLiveProjectionAt = 0;
    let liveProjectionQueue = Promise.resolve();
    const writeLiveProjection = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastLiveProjectionAt < this.publicationIntervalMs) return;
      lastLiveProjectionAt = now;
      liveProjectionQueue = liveProjectionQueue.then(() => this.writeProjection());
      await liveProjectionQueue;
    };
    await this.logger("control_review_claimed", { itemId: item.itemId, taskId: item.taskId });

    try {
      if (serviceRunId) {
        const providerMetadata = this.provider.describe?.() ?? {};
        const startedAtUtc = new Date().toISOString();
        await this.serviceReviewRegistry.upsert({
          serviceRunId,
          sourceId: item.sourceId,
          taskId: item.taskId,
          itemId: item.itemId,
          attempt: item.attempts,
          ...providerMetadata,
          status: "starting",
          resultSummary: "Preparing one serialized child-report review",
          problems: [],
          report: { path: item.reportPath, sha256: item.reportSha256 },
          decision: item.decisionPath ? { path: item.decisionPath, sha256: null } : null,
          threadId: null,
          turnId: null,
          startedAtUtc,
          finishedAtUtc: null,
          rawTrace: {
            available: false,
            // A Claude Code review is kept in the controller's service session
            // journal, not as a raw trace (the Codex reviewer's rollouts left with it).
            archiveState: "not-applicable",
          },
          updatedAtUtc: startedAtUtc,
        });
      }
      const result = await this.provider.runReview(item, {
        shouldCancel: async () => {
          const current = await this.store.snapshot({ eventLimit: 0 });
          const currentItem = current.items.find((candidate) => candidate.itemId === item.itemId);
          if (current.control.mode === "emergency_stopped" || currentItem?.state === "cancelling") {
            return { scope: "task", reason: current.control.reason ?? currentItem?.currentAction ?? "Cancellation requested" };
          }
          const targetAgent = current.agents.find((agent) => (
            agent.itemId === item.itemId && agent.state === "cancellation_requested"
          ));
          if (targetAgent) {
            return {
              scope: "agent",
              agentId: targetAgent.agentId,
              threadId: targetAgent.threadId,
              turnId: targetAgent.turnId,
              reason: targetAgent.currentAction || "Agent cancellation requested",
            };
          }
          return null;
        },
        onStarted: async ({ threadId, turnId, agentId, providerMetadata = {} }) => {
          if (serviceRunId) {
            await this.serviceReviewRegistry.patch(serviceRunId, {
              ...providerMetadata,
              status: "running",
              resultSummary: "Reviewing one immutable child report",
              threadId,
              turnId,
            });
          }
          const beforeStart = await this.store.snapshot({ eventLimit: 0 });
          const currentItem = beforeStart.items.find((candidate) => candidate.itemId === item.itemId);
          const cancellationPending = currentItem?.state === "cancelling"
            || beforeStart.control.mode === "emergency_stopped";
          const transitioned = await this.store.transition(item.itemId, "review_running", {
            fromStates: ["leased", "cancelling"],
            leaseToken,
            patch: {
              phase: cancellationPending ? "cancellation" : "review",
              currentAction: cancellationPending
                ? "Review started while cancellation was pending"
                : "Reviewing one immutable child report",
              threadId,
              turnId,
            },
          });
          item = transitioned.item;
          if (cancellationPending) {
            item = (await this.store.transition(item.itemId, "cancelling", {
              fromStates: ["review_running"],
              leaseToken,
              patch: { phase: "cancellation", currentAction: "Waiting for provider interruption" },
            })).item;
          }
          await this.logger("control_review_started", { itemId: item.itemId, agentId, threadId, turnId });
          await writeLiveProjection(true);
        },
        onHeartbeat: async ({ currentAction }) => {
          await this.store.heartbeat(item.itemId, { leaseToken, leaseSeconds: this.leaseSeconds, currentAction });
          await writeLiveProjection();
        },
        onAgent: async (agent) => {
          await this.store.upsertAgent(agent);
          await writeLiveProjection();
        },
        onStatistics: async ({ agentId, statistics }) => {
          await this.store.upsertAgentStatistics(agentId, statistics);
          await writeLiveProjection();
        },
        onEvent: async (event) => {
          await this.store.addEvent(event.type, event);
        },
      });

      snapshot = await this.store.snapshot();
      item = snapshot.items.find((candidate) => candidate.itemId === item.itemId) ?? item;
      if (result.stopUnconfirmed) {
        item = (await this.store.transition(item.itemId, "stop_unconfirmed", {
          fromStates: ["review_running", "cancelling"],
          patch: { phase: "stopped", currentAction: "Provider stop was not fully confirmed" },
        })).item;
        await this.#finishServiceReview(serviceRunId, {
          item,
          result,
          status: "stop_unconfirmed",
          summary: "Provider stop was not fully confirmed",
          problems: ["Provider interruption could not be confirmed"],
        });
        await this.#writeExecutionSummary(item.itemId);
        return { action: "stop-unconfirmed", itemId: item.itemId, projection: await this.writeProjection() };
      }
      if (result.interrupted || result.status === "interrupted") {
        item = (await this.store.transition(item.itemId, "cancelled", {
          fromStates: ["review_running", "cancelling"],
          patch: { phase: "cancelled", currentAction: "Review was interrupted" },
        })).item;
        await this.#finishServiceReview(serviceRunId, {
          item,
          result,
          status: "interrupted",
          summary: "Review was interrupted",
          problems: [],
        });
        await this.#writeExecutionSummary(item.itemId);
        return { action: "cancelled", itemId: item.itemId, projection: await this.writeProjection() };
      }
      if (["failed", "error"].includes(result.status)) {
        item = (await this.store.transition(item.itemId, "failed", {
          fromStates: ["review_running", "cancelling"],
          patch: { phase: "failed", currentAction: "Review provider failed", error: result.status },
        })).item;
        await this.#finishServiceReview(serviceRunId, {
          item,
          result,
          status: "failed",
          summary: "Review provider failed",
          problems: [result.status],
        });
        await this.#writeExecutionSummary(item.itemId);
        return { action: "failed", itemId: item.itemId, projection: await this.writeProjection() };
      }

      const cancellationRacedWithCompletion = item.state === "cancelling"
        || snapshot.control.mode === "emergency_stopped";
      if (cancellationRacedWithCompletion) {
        item = (await this.store.transition(item.itemId, "cancelled", {
          fromStates: ["review_running", "cancelling"],
          patch: {
            phase: "cancelled",
            currentAction: "Provider completed after cancellation; review result was discarded",
          },
        })).item;
        await this.#finishServiceReview(serviceRunId, {
          item,
          result,
          status: "interrupted",
          summary: "Provider completed after cancellation; review result was discarded",
          problems: [],
        });
        await this.#writeExecutionSummary(item.itemId);
        await this.logger("control_review_result_discarded_after_cancel", {
          itemId: item.itemId,
          taskId: item.taskId,
          providerStatus: result.status,
        });
        return { action: "cancelled", itemId: item.itemId, projection: await this.writeProjection() };
      }

      const validating = await this.store.transition(item.itemId, "decision_validating", {
        fromStates: ["review_running"],
        patch: { phase: "decision", currentAction: "Validating the structured review decision" },
      });
      item = validating.item;
      const validated = await this.decisionValidator(item, { controllerRoot: this.controllerRoot });
      const shouldIntegrate = Boolean(this.integrator) && (
        typeof this.integrator.shouldIntegrate !== "function"
          || await this.integrator.shouldIntegrate({ item, decision: validated.decision })
      );
      const completedPlan = (item.plan ?? []).map((step) => ({
        ...step,
        state: step.state === "cancelled" ? "cancelled" : "completed",
      }));
      const decisionEvidence = [
        ...(item.evidence ?? []).filter((entry) => entry.kind !== "decision"),
        {
          kind: "decision",
          path: validated.decisionReference,
          ...(validated.decisionSha256 ? { sha256: validated.decisionSha256 } : {}),
        },
      ];
      const nextState = shouldIntegrate ? "integrating" : "reviewed";
      const reviewed = await this.store.transition(item.itemId, nextState, {
        fromStates: ["decision_validating"],
        patch: {
          phase: shouldIntegrate ? "integration" : "reviewed",
          currentAction: shouldIntegrate
            ? "Applying accepted coordinator knowledge changes"
            : `Review decision: ${validated.decision.outcome}`,
          summary: validated.decision.summary,
          blockers: validated.decision.risks ?? [],
          finalDecision: validated.decision.outcome,
          decisionReference: validated.decisionReference,
          plan: completedPlan,
          evidence: decisionEvidence,
          finishedAtUtc: shouldIntegrate ? null : new Date().toISOString(),
        },
      });
      item = reviewed.item;

      if (shouldIntegrate) {
        const integration = await this.integrator({ item, decision: validated.decision });
        item = (await this.store.transition(item.itemId, "integrated", {
          fromStates: ["integrating"],
          patch: {
            phase: "complete",
            currentAction: "Review decision integrated",
            decisionReference: integration?.decisionReference ?? item.decisionReference,
          },
        })).item;
      }
      await this.#finishServiceReview(serviceRunId, {
        item,
        result,
        status: "completed",
        summary: validated.decision.summary,
        problems: (validated.decision.risks ?? []).map(problemText),
        decision: {
          path: validated.decisionReference,
          sha256: validated.decisionSha256,
        },
      });
      await this.#writeExecutionSummary(item.itemId);
      await this.logger("control_review_completed", {
        itemId: item.itemId,
        taskId: item.taskId,
        outcome: validated.decision.outcome,
        integrated: item.state === "integrated",
      });
      return {
        action: item.state === "integrated" ? "integrated" : "reviewed",
        item,
        decision: validated.decision,
        projection: await this.writeProjection(),
      };
    } catch (error) {
      const current = await this.store.snapshot({ eventLimit: 0 });
      const failedItem = current.items.find((candidate) => candidate.itemId === item.itemId);
      if (failedItem && !["accepted", "cancelled", "integrated", "failed", "stop_unconfirmed"].includes(failedItem.state)) {
        const targetState = failedItem.state === "cancelling" ? "stop_unconfirmed" : "failed";
        await this.store.transition(item.itemId, targetState, {
          fromStates: [failedItem.state],
          patch: {
            phase: targetState === "stop_unconfirmed" ? "stopped" : "failed",
            currentAction: targetState === "stop_unconfirmed"
              ? "Cancellation could not be confirmed after provider failure"
              : "Serialized review failed",
            error: error.message,
          },
        });
      }
      await this.logger("control_review_failed", { itemId: item.itemId, error });
      if (serviceRunId) {
        try {
          await this.#finishServiceReview(serviceRunId, {
            item: failedItem ?? item,
            result: null,
            status: "failed",
            summary: "Serialized review failed",
            problems: [error.message],
          });
        } catch (registryError) {
          await this.logger("service_review_diagnostic_finalize_failed", {
            itemId: item.itemId,
            serviceRunId,
            error: registryError.message,
          });
        }
      }
      await this.writeProjection();
      throw error;
    }
  }

  async archive({ retentionDays = 30, archiveRoot }) {
    const result = await this.store.compact({ retentionDays, archiveRoot });
    await this.writeProjection();
    return result;
  }

  async writeProjection(snapshot = null) {
    const current = snapshot ?? await this.store.snapshot();
    const serviceReviews = this.serviceReviewRegistry
      ? await this.serviceReviewRegistry.list({ limit: 5_000 })
      : [];
    const interventions = await readChildInterventions(this.controllerRoot, { includeResolved: true });
    const now = new Date();
    const projection = createControlProjection(current, {
      interventions,
      serviceReviews,
      now,
      publicationIntervalMs: this.publicationIntervalMs,
    });
    const previousAttention = await this.#readPreviousAttentionProjection();
    const attentionProjection = createAttentionProjection(projection, {
      previousProjection: previousAttention,
      now,
      deskAgents: await this.#readDeskAgents(),
    });
    await writeProjectionAtomic(this.projectionPath, projection);
    await writeProjectionAtomic(this.attentionProjectionPath, attentionProjection);
    const backendCapabilities = createBackendCapabilities({
      controllerRoot: this.controllerRoot,
      descriptorPath: this.backendCapabilitiesPath,
      controlPath: this.projectionPath,
      attentionPath: this.attentionProjectionPath,
      publicationIntervalMs: this.publicationIntervalMs,
    });
    await writeProjectionAtomic(this.backendCapabilitiesPath, backendCapabilities);
    if (this.workProjectionV2Enabled) {
      await this.#writeWorkProjectionV2(projection, attentionProjection, now);
    }
    this.lastAttentionProjection = attentionProjection;
    return projection;
  }

  async #writeWorkProjectionV2(projection, attentionProjection, now) {
    const relative = (filePath) => path.relative(this.controllerRoot, filePath).replaceAll(path.sep, "/");
    const options = {
      controllerRoot: this.controllerRoot,
      descriptorPath: relative(this.workProjectionV2DescriptorPath),
      fallbackDescriptorPath: relative(this.backendCapabilitiesPath),
      controlPath: relative(this.projectionPath),
      attentionPath: relative(this.attentionProjectionPath),
      control: projection,
      attention: attentionProjection,
      publicationIntervalMs: this.publicationIntervalMs,
      clock: () => new Date(now),
    };
    try {
      const workProjection = this.workProjectionV2Translator({
        control: projection,
        attention: attentionProjection,
        publishedAtUtc: now.toISOString(),
      });
      const published = await this.workProjectionV2Publisher({ ...options, projection: workProjection });
      this.lastWorkProjectionV2Publication = {
        status: "enabled",
        sequence: projection.sequence,
        descriptorPath: published.descriptorPath,
        projectionSha256: workProjection.projectionSha256,
      };
      await this.logger("work_projection_v2_published", {
        sequence: projection.sequence,
        descriptorPath: published.descriptorPath,
        projectionSha256: workProjection.projectionSha256,
        idempotent: published.idempotent,
      });
    } catch (error) {
      const reasonCode = "v2_publication_failed";
      let rollbackStatus = "failed";
      try {
        const rolledBack = await this.workProjectionV2Rollback({ ...options, reasonCode });
        rollbackStatus = rolledBack.idempotent ? "already-fallback" : "fallback-committed";
      } catch (rollbackError) {
        await this.logger("work_projection_v2_rollback_failed", {
          sequence: projection.sequence,
          errorCode: String(rollbackError?.code ?? rollbackError?.name ?? "rollback_failed").slice(0, 80),
        });
      }
      this.lastWorkProjectionV2Publication = {
        status: "fallback",
        sequence: projection.sequence,
        errorCode: String(error?.code ?? error?.name ?? "publication_failed").slice(0, 80),
        rollbackStatus,
      };
      await this.logger("work_projection_v2_fallback", this.lastWorkProjectionV2Publication);
    }
  }

  /**
   * Desk agents (the memory service's catalog) for the attention model's idle
   * agents. Only an existing memory database is read; none means no desk agents.
   * A failed read leaves them out of this projection and is logged.
   */
  async #readDeskAgents() {
    const database = path.join(this.controllerRoot, ".project-local", "orchestration", "project-memory",
      "project-memory.v1.sqlite");
    const split = path.join(projectsRoot(this.controllerRoot), STORE_LAYOUT_MARKER);
    try { await access(database); } catch {
      try { await access(split); } catch { return []; }
    }
    try {
      this.deskAgentService ??= new ProjectMemoryService({ archive: null,
        store: await createProjectMemoryStore({ controllerRoot: this.controllerRoot }) });
      return await this.deskAgentService.listActivity();
    } catch (error) {
      this.deskAgentService = null;
      await this.logger("attention_desk_agents_unavailable", {
        error: String(error?.code ?? error?.message ?? error).slice(0, 128),
      });
      return [];
    }
  }

  async #readPreviousAttentionProjection() {
    try {
      const value = JSON.parse(await readFile(this.attentionProjectionPath, "utf8"));
      return value?.schemaVersion === 1 && value?.modelVersion === "v0.1.0" ? value : null;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await this.logger("attention_projection_previous_ignored", {
          path: path.relative(this.controllerRoot, this.attentionProjectionPath).replaceAll(path.sep, "/"),
          error: String(error?.message ?? error).slice(0, 512),
        });
      }
      return null;
    }
  }

  async #writeExecutionSummary(itemId) {
    const snapshot = await this.store.snapshot({ eventLimit: 1000 });
    const serviceReviews = this.serviceReviewRegistry
      ? await this.serviceReviewRegistry.list({ limit: 5_000 })
      : [];
    const summary = createExecutionSummary(snapshot, itemId, { serviceReviews });
    const item = snapshot.items.find((candidate) => candidate.itemId === itemId);
    const outputPath = path.join(
      this.executionSummaryRoot,
      `${item.sourceId}--${item.taskId}.execution-summary.v1.json`,
    );
    await writeProjectionAtomic(outputPath, summary);
    return { summary, outputPath };
  }

  async #finishServiceReview(serviceRunId, {
    item,
    result,
    status,
    summary,
    problems,
    decision,
  }) {
    if (!serviceRunId || !this.serviceReviewRegistry) return null;
    const current = await this.serviceReviewRegistry.get(serviceRunId);
    const threadId = result?.threadId ?? current?.threadId ?? null;
    const rawTrace = current?.rawTrace ?? { available: false, archiveState: "not-applicable" };
    const providerMetadata = result?.providerMetadata ?? {};
    const finishedAtUtc = new Date().toISOString();
    return this.serviceReviewRegistry.patch(serviceRunId, {
      ...providerMetadata,
      codexVersion: providerMetadata.codexVersion ?? rawTrace.cliVersion ?? current?.codexVersion ?? null,
      status,
      resultSummary: summary,
      problems,
      report: current?.report ?? { path: item.reportPath, sha256: item.reportSha256 },
      decision: decision ?? current?.decision ?? null,
      threadId,
      turnId: result?.turnId ?? current?.turnId ?? null,
      finishedAtUtc,
      rawTrace,
    });
  }
}

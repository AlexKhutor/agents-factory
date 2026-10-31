// DEVELOPMENT. The fixture world at the scale of the prototype.
//
// Six projects, sixteen quarters, about thirty agents in all the
// states the interface must be able to show: ordinary work, a failure with
// a problem code, uncertain delivery, waiting for delivery, archive, pending
// questions of two kinds, and an agent whose ownership the catalog cannot resolve.
//
// Everything here is synthetic. No identifier gives the right to send
// anything, and no value describes real work.

import { createHash } from "node:crypto";

const CONTRACT_VERSION = "v0.1.0";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function scope(scopeId, kind, projectId, quarterId, title, revision, entries) {
  return {
    schemaVersion: 1, scopeId, kind, projectId, quarterId, title, revision,
    sha256: sha256(`${scopeId}:${revision}`), author: "atlas-dev-fixture",
    updatedAtUtc: "2026-09-18T08:00:00.000Z", entries,
  };
}

export function manifest(project, quarter) {
  const part = (item) => ({ scopeId: item.scopeId, revision: item.revision, sha256: item.sha256 });
  return {
    project: part(project), quarter: part(quarter),
    manifestHash: sha256(`${project.scopeId}:${project.revision}:${quarter.scopeId}:${quarter.revision}`),
  };
}

export function agent(overrides) {
  return {
    operationId: "fixture-create",
    profile: {
      provider: "fixture", model: "fixture-model", reasoningEffort: "max", fallbackPolicy: "deny",
    },
    binding: {
      projectId: "atlas-dev-fixture", sourceId: "fixture",
      providerId: "fixture", threadId: `fixture-thread-${overrides.agentId}`,
    },
    deliveredManifest: null, currentOperationId: null, lastOperation: null,
    problemCode: null, contentState: "populated", deliveryState: "delivered",
    state: "active", createdAtUtc: "2026-09-18T08:05:00.000Z", archivedAtUtc: null,
    coverage: "captured-only", ...overrides,
  };
}

// An agent to which sending always returns an uncertain outcome: the path that
// must not be repeated has to be reachable during development.
export const UNCERTAIN_AGENT = "core-scheduler-2";

const PLAN = [
  ["platform-core", "Platform core", [
    ["core-q1", "Scheduler", [
      ["core-scheduler-1", { delivered: true, lastOperationState: "completed" }],
      ["core-scheduler-2", { deliveryState: "uncertain", lastOperationState: "uncertain", current: true }],
    ]],
    ["core-q2", "Storage", [
      ["core-storage-1", { delivered: true }],
      ["core-storage-2", { deliveryState: "pending", contentState: "empty" }],
    ]],
    ["core-q3", "Observability", [
      ["core-watch-1", {
        state: "failed", deliveryState: "failed", problemCode: "memory_provider_unavailable",
      }],
    ]],
  ]],
  ["data-pipeline", "Data pipeline", [
    ["data-q1", "Ingest", [
      ["data-ingest-1", { delivered: true, current: true, lastOperationState: "started" }],
      ["data-ingest-2", { delivered: true }],
    ]],
    ["data-q2", "Enrichment", [
      ["data-enrich-1", { state: "archived", deliveryState: "archived" }],
      ["data-enrich-2", { delivered: true }],
    ]],
    ["data-q3", "Export", [
      ["data-export-1", { delivered: true }],
    ]],
  ]],
  ["mobile-client", "Mobile client", [
    ["mobile-q1", "Screens", [
      ["mobile-ui-1", { delivered: true }],
      ["mobile-ui-2", { delivered: true }],
      ["mobile-ui-3", { deliveryState: "pending", contentState: "empty" }],
    ]],
    ["mobile-q2", "Sync", [
      ["mobile-sync-1", {
        state: "failed", deliveryState: "failed", problemCode: "memory_binding_lost",
      }],
    ]],
  ]],
  ["billing", "Billing", [
    ["billing-q1", "Rates", [
      ["billing-rates-1", { delivered: true }],
    ]],
    ["billing-q2", "Invoices", [
      ["billing-invoice-1", { delivered: true, current: true, lastOperationState: "started" }],
      ["billing-invoice-2", { state: "archived", deliveryState: "archived" }],
    ]],
  ]],
  ["research-lab", "Lab", [
    ["research-q1", "Prototypes", [
      ["lab-proto-1", { delivered: true }],
      ["lab-proto-2", { delivered: true }],
      ["lab-proto-3", { deliveryState: "uncertain", lastOperationState: "uncertain" }],
    ]],
    ["research-q2", "Measurements", [
      ["lab-measure-1", { state: "archived", deliveryState: "archived" }],
    ]],
  ]],
  ["infra-ops", "Infrastructure", [
    ["infra-q1", "Build", [
      ["infra-build-1", { delivered: true }],
      ["infra-build-2", { delivered: true }],
    ]],
    ["infra-q2", "Deployment", [
      ["infra-deploy-1", {
        state: "failed", deliveryState: "failed", problemCode: "memory_write_conflict",
      }],
    ]],
    ["infra-q3", "On-call", [
      ["infra-duty-1", { delivered: true }],
      ["infra-duty-2", { delivered: true }],
    ]],
  ]],
];

export function fixtureWorld() {
  const scopes = [];
  const agents = [];
  const byKey = new Map();

  for (const [projectId, projectTitle, quarters] of PLAN) {
    const projectScope = scope(`${projectId}-memory`, "project", projectId, null, projectTitle, 2, [
      { id: "rules", title: "Project rules", text: "Fixture: project memory text." },
    ]);
    scopes.push(projectScope);
    byKey.set(projectId, projectScope);

    for (const [quarterId, quarterTitle, plan] of quarters) {
      const quarterScope = scope(`${projectId}-${quarterId}-memory`, "quarter", projectId, quarterId,
        quarterTitle, 1, [
          { id: "goal", title: "Quarter goal", text: "Fixture: quarter context." },
        ]);
      scopes.push(quarterScope);
      byKey.set(`${projectId}/${quarterId}`, quarterScope);

      for (const [agentId, options] of plan) {
        const assigned = manifest(projectScope, quarterScope);
        agents.push(agent({
          agentId, projectId, quarterId,
          assignedManifest: assigned,
          requiredManifest: assigned,
          deliveredManifest: options.delivered === true ? structuredClone(assigned) : null,
          state: options.state ?? "active",
          contentState: options.contentState ?? "populated",
          deliveryState: options.deliveryState ?? "delivered",
          problemCode: options.problemCode ?? null,
          currentOperationId: options.current === true ? `fixture-send-${agentId}` : null,
          lastOperation: options.lastOperationState === undefined ? null : {
            schemaVersion: 1, operationId: `fixture-send-${agentId}`, kind: "send",
            state: options.lastOperationState,
            requestedAtUtc: "2026-09-18T09:00:00.000Z",
            updatedAtUtc: "2026-09-18T09:05:00.000Z",
          },
          archivedAtUtc: (options.state ?? "active") === "archived" ? "2026-09-18T08:30:00.000Z" : null,
        }));
      }
    }
  }

  // World: the world lead's service project, bound to the controller folder, and
  // its HQ. The world lead is the controller's only coordinator (the
  // coordinator role); on the map the World HQ building stands in for the project.
  const worldScope = scope("world-memory", "project", "world", null, "World", 1, [
    { id: "goal", title: "World goal", text: "Fixture: what matters across all projects at once." },
  ]);
  const worldHq = scope("world-hq-memory", "quarter", "world", "hq", "World HQ", 1, []);
  scopes.push(worldScope, worldHq);
  const worldManifest = manifest(worldScope, worldHq);
  agents.push(agent({
    agentId: "world-lead", projectId: "world", quarterId: "hq",
    assignedManifest: worldManifest, requiredManifest: worldManifest, deliveredManifest: structuredClone(worldManifest),
    settings: { role: "coordinator", writeZone: null, revision: 1, updatedAtUtc: "2026-10-20T07:55:00.000Z" },
    lastOperation: {
      schemaVersion: 1, operationId: "fixture-send-world-lead", kind: "send", state: "completed",
      requestedAtUtc: "2026-10-20T08:00:00.000Z", updatedAtUtc: "2026-10-20T08:01:00.000Z",
    },
  }));

  // The catalog cannot resolve the ownership of this agent: it must land in
  // the “off the map” area, not vanish silently.
  agents.push(agent({
    agentId: "orphan-agent-1", projectId: "platform-core", quarterId: "core-q9",
    assignedManifest: manifest(byKey.get("platform-core"), byKey.get("platform-core/core-q1")),
    requiredManifest: manifest(byKey.get("platform-core"), byKey.get("platform-core/core-q1")),
  }));

  return { scopes, agents };
}

// Two kinds of questions: approving a command and typing text. Each has its own allowed
// answers — exactly those the backend accepts.
export const INTERACTIONS = Object.freeze({
  "data-ingest-1": [{
    schemaVersion: 1, contractVersion: CONTRACT_VERSION,
    interactionId: "fixture-interaction-command", conversationId: "fixture-conversation-1",
    provider: {
      adapterId: "fixture", adapterVersion: "v0.1.0",
      sourceId: "fixture", runtimeInstanceId: "fixture-runtime",
    },
    providerRequest: {
      method: "item/commandExecution/requestApproval", requestId: "7", requestIdType: "string",
      generation: 1, threadId: "fixture-thread-data-ingest-1", turnId: "fixture-turn-1",
      // The provider's request hash differs from the interaction request's, as
      // on a live Gateway: a response must name the latter.
      itemId: "fixture-item-1", requestSha256: sha256("fixture-interaction-command:provider"),
    },
    interactionRequest: {
      command: "npm test", cwd: "(fixture)",
      requestId: "7", requestSha256: sha256("fixture-interaction-command"), sourceSequence: 1,
      owner: { schemaVersion: 1, actorType: "local-operator", actorId: "fixture-operator" },
      allowedResponses: ["accept", "decline", "cancel"],
    },
    display: {
      kind: "command-approval", title: "Allow command: npm test",
      fields: { command: "npm test" },
    },
    state: "awaiting-owner", response: null, providerResponseSha256: null,
    requestedAtUtc: "2026-09-18T10:02:00.000Z", deadlineAtUtc: "2026-09-18T18:02:00.000Z",
    updatedAtUtc: "2026-09-18T10:02:00.000Z", automaticRetryAllowed: false,
    recordSha256: sha256("fixture-interaction-command-record"),
  }],
  "billing-invoice-1": [{
    schemaVersion: 1, contractVersion: CONTRACT_VERSION,
    interactionId: "fixture-interaction-input", conversationId: "fixture-conversation-2",
    provider: {
      adapterId: "fixture", adapterVersion: "v0.1.0",
      sourceId: "fixture", runtimeInstanceId: "fixture-runtime",
    },
    providerRequest: {
      method: "item/tool/requestUserInput", requestId: "11", requestIdType: "string",
      generation: 1, threadId: "fixture-thread-billing-invoice-1", turnId: "fixture-turn-2",
      itemId: "fixture-item-2", requestSha256: sha256("fixture-interaction-input:provider"),
    },
    interactionRequest: {
      requestId: "11", requestSha256: sha256("fixture-interaction-input"), sourceSequence: 2,
      owner: { schemaVersion: 1, actorType: "local-operator", actorId: "fixture-operator" },
      allowedResponses: ["submit-text", "cancel"],
    },
    display: {
      kind: "user-input", title: "Invoice clarification",
      // A question in the shape the Gateway sends (AskUserQuestion in Claude Code).
      fields: { isBlocking: true, questions: [{ id: "q1", header: "Period", question: "For which period should the invoice be issued?",
        isOther: true, options: [
          { label: "Current month", description: "From the first of the month to today: the invoice goes out at once." },
          { label: "Last month", description: "The full closed month, as in past invoices." },
        ] }] },
    },
    state: "awaiting-owner", response: null, providerResponseSha256: null,
    requestedAtUtc: "2026-09-18T10:20:00.000Z", deadlineAtUtc: "2026-09-18T18:20:00.000Z",
    updatedAtUtc: "2026-09-18T10:20:00.000Z", automaticRetryAllowed: false,
    recordSha256: sha256("fixture-interaction-input-record"),
  }],
});

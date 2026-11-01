import { randomBytes } from "node:crypto";
import path from "node:path";

import { BackendConsumerClient } from "./backend-consumer-api.mjs";
import { createApplicationGatewayReadHandlers } from "./application-gateway-read-bridge.mjs";
import {
  createApplicationGatewayDomainHandlers,
} from "./application-gateway-domain-bridge.mjs";
import { ApplicationResourceReader } from "./application-resource-reader.mjs";
import { ApplicationResourceService } from "./application-resource-service.mjs";
import { WorkProjectionV2Client } from "./work-projection-v2-client.mjs";
import { createProjectMemoryService } from "./project-memory-service.mjs";
import { createApplicationAgentControlHandlers } from "./application-agent-control.mjs";
import { createApplicationAgentConversationHandlers } from "./application-agent-conversation.mjs";
import { combineApplicationAgentEventBridges } from "./application-agent-events.mjs";
import { createApplicationProjectWorkspaceHandlers } from "./application-project-workspace.mjs";
import { APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION,
  createApplicationProjectWorkspaceSaveHandler } from "./application-project-workspace-save.mjs";
import { createAgentArtifactService, createApplicationAgentArtifactHandlers } from "./application-agent-artifacts.mjs";
import { createApplicationProjectMemoryHandlers } from "./application-project-memory.mjs";
import { APPLICATION_PROJECT_COPY_OPERATION,
  createApplicationProjectCopyHandler } from "./application-project-copy.mjs";
import { ApplicationGatewayRuntimeFiles, applicationGatewayWorkspaceHash } from "./application-gateway-runtime.mjs";
import { createClaudeProviderRuntime } from "./application-gateway-claude-runtime.mjs";
import { createProjectMemoryProviderRouter } from "./project-memory-provider-router.mjs";
import { journalGatewayHandlers } from "./action-journal-gateway.mjs";

export const APPLICATION_GATEWAY_READ_RUNTIME_VERSION = "v0.14.0";
// Desk agents run on Claude Code, and beside it on further providers (ACP). The Codex App Server runtime
// and its owner chat left the product (roadmap step 1, owner 30.10): a future Codex comes as a provider.
export const APPLICATION_GATEWAY_PROVIDERS = Object.freeze(["claude"]);

const READ_PERMISSIONS = Object.freeze({
  "query.provider.models.list": "allowed",
  "query.provider.threads.list": "allowed",
  "query.provider.thread.read": "allowed",
  "subscription.provider.turn.stream": "allowed",
  "query.provider.usage.read": "allowed",
});
const DOMAIN_AUTHORITY_FIELDS = new Set([
  "interactionAuthority", "reviewCommentAuthority", "keepCoordinator", "receiptAuthority",
]);

function invalid(message) {
  const error = new Error(message);
  error.code = "source_unavailable";
  throw error;
}

function domainConfiguration(value) {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !DOMAIN_AUTHORITY_FIELDS.has(field))) {
    invalid("gateway domain authority configuration is invalid");
  }
  return { ...value };
}

function clock(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("runtime clock is invalid");
  return value;
}

async function resourceService({ repoRoot, sourceId, instanceId, now }) {
  const reader = await ApplicationResourceReader.create({
    now,
    policies: [
      {
        scope: "artifact",
        rootId: "controller-workspace",
        rootPath: repoRoot,
        readPolicyId: "artifact-owner-read-v1",
        sourceId,
        authorityTypes: ["child-workspace", "coordination-core"],
        allowedPrefixes: [
          "knowledge/reports/inbox",
          "coordination/acceptances",
          "coordination/drafts/incidents",
          "coordination/reviews",
        ],
        revision: null,
      },
      {
        scope: "project",
        rootId: "controller-workspace",
        rootPath: repoRoot,
        readPolicyId: "project-owner-read-v1",
        sourceId,
        authorityTypes: ["child-workspace"],
        allowedPrefixes: [
          "orchestrator/src", "orchestrator/docs", "docs",
          "CHANGELOG.md", "project-version.json",
        ],
        revision: {
          schemaVersion: 1,
          kind: "opaque",
          value: `gateway-instance:${instanceId}`,
        },
      },
    ],
  });
  return new ApplicationResourceService({
    reader,
    backendInstanceId: instanceId,
    continuationSecret: randomBytes(32),
    now,
  });
}

// Model-backed work runs only while the Gateway's visible monitor proves this
// exact Gateway process ready (operator-observability.md).
function gatewayVisibility({ repoRoot, instanceId, projectId, now }) {
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot });
  return async () => {
    const monitor = await files.readMonitor();
    const age = monitor ? clock(now).getTime() - Date.parse(monitor.heartbeatAtUtc) : Infinity;
    if (!monitor || monitor.state !== "ready" || monitor.gatewayInstanceId !== instanceId
        || monitor.gatewayProcessId !== process.pid || monitor.projectId !== projectId
        || monitor.workspaceRootSha256 !== applicationGatewayWorkspaceHash(repoRoot)
        || !Number.isFinite(age) || age < -5000 || age > 15000) invalid("observability_unavailable");
    try { process.kill(monitor.processId, 0); } catch { invalid("observability_unavailable"); }
  };
}

export async function createApplicationGatewayReadRuntime({
  repoRoot,
  sourceId,
  instanceId,
  now = () => new Date(),
  domainAuthorities = null,
  provider: providerKind = "claude",
  claude = null,
  // Factories of further desk-agent providers routed beside Claude Code
  // (application-gateway-acp-runtime.mjs).
  extraProviders = null,
  onDiagnostic = () => {},
  onProviderDiagnostic = () => {},
} = {}) {
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)
      || typeof sourceId !== "string" || sourceId.length < 1
      || typeof instanceId !== "string" || instanceId.length < 1
      || typeof now !== "function"
      || !APPLICATION_GATEWAY_PROVIDERS.includes(providerKind)
      || !claude || typeof claude !== "object") {
    invalid("gateway read runtime configuration is invalid");
  }
  const configuredDomainAuthorities = domainConfiguration(domainAuthorities);
  let memoryService = null;
  try { memoryService = await createProjectMemoryService({ controllerRoot: repoRoot, sourceId, now }); }
  catch { /* Memory availability does not disable existing independent read resources. */ }
  const workProjectionClient = new WorkProjectionV2Client({
    controllerRoot: repoRoot,
    now,
  });
  const backendConsumerClient = new BackendConsumerClient({
    controllerRoot: repoRoot,
    now,
  });
  const resource = await resourceService({ repoRoot, sourceId, instanceId, now });
  const assertVisible = memoryService ? gatewayVisibility({ repoRoot, instanceId,
    projectId: memoryService.archive.projectId, now }) : async () => invalid("observability_unavailable");
  // Further desk-agent providers beside Claude Code (agents of several
  // providers in one Gateway): each factory returns its memory provider,
  // conversation route and event bridge, and the router picks per agent.
  const extraFactories = memoryService ? (extraProviders ?? []) : [];
  const extras = [];
  for (const factory of extraFactories) {
    extras.push(await factory({ repoRoot, sourceId, instanceId, now, memoryService, assertVisible,
      readPermissions: READ_PERMISSIONS, onDiagnostic: onProviderDiagnostic }));
  }
  const routedExtras = extras.filter((extra) => extra?.memoryProvider);
  const provider = await createClaudeProviderRuntime({
    repoRoot, sourceId, instanceId, now, claude, memoryService, assertVisible,
    readPermissions: READ_PERMISSIONS, onDiagnostic: onProviderDiagnostic, attach: routedExtras.length === 0,
  });
  let agentEventHandlers = provider.agentEventHandlers;
  let conversationOptions = provider.conversationProvider ?? {};
  let closeRouted = async () => {};
  if (routedExtras.length > 0) {
    const members = [{ providerId: provider.conversationRoute?.providerId, memoryProvider: provider.memoryProvider,
      conversationRoute: provider.conversationRoute, agentEventBridge: provider.agentEventBridge }, ...routedExtras]
      .filter((member) => member.memoryProvider && member.conversationRoute?.providerId);
    memoryService.provider = createProjectMemoryProviderRouter(Object.fromEntries(members
      .map((member) => [member.conversationRoute.providerId, member.memoryProvider])));
    const events = combineApplicationAgentEventBridges({ service: memoryService,
      bridges: members.map((member) => ({ providerId: member.conversationRoute.providerId,
        bridge: member.agentEventBridge })) });
    agentEventHandlers = events.handlers;
    conversationOptions = { routes: members.map((member) => member.conversationRoute) };
    closeRouted = async () => { for (const extra of extras) await extra.close?.(); };
  } else {
    closeRouted = async () => { for (const extra of extras) await extra?.close?.(); };
  }
  const readHandlers = createApplicationGatewayReadHandlers({
    workProjectionClient,
    backendConsumerClient,
    resourceService: resource,
    conversationReader: provider.conversationReader,
    extraConversationReaders: routedExtras.map((extra) => extra.conversationRoute?.reader).filter(Boolean),
    executionProvider: provider.executionProvider,
  });
  const domainHandlers = createApplicationGatewayDomainHandlers({
    conversationReader: provider.conversationReader,
    ...configuredDomainAuthorities,
  });
  const projectResources = createApplicationProjectWorkspaceHandlers({ store: memoryService?.store,
    sourceId, instanceId, now, onDiagnostic });
  const projectSave = memoryService ? {
    [APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION]: createApplicationProjectWorkspaceSaveHandler({
      store: memoryService.store, readProject: projectResources["query.project-workspace.read"], now,
    }),
  } : {};
  const projectCopy = memoryService ? {
    [APPLICATION_PROJECT_COPY_OPERATION]: createApplicationProjectCopyHandler({ store: memoryService.store }),
  } : {};
  const artifacts = memoryService ? createAgentArtifactService({ service: memoryService, now,
    projectRead: projectResources["query.project-workspace.read"] }) : null;
  // The files an agent lists as its task's results become its artifacts (project-memory-service.mjs taskResults).
  if (memoryService) {
    memoryService.artifactRegistry = {
      read: (projectId, filePath) => projectResources["query.project-workspace.read"]({ input: { projectId, path: filePath } }),
      register: (input) => artifacts.register(input),
    };
  }
  // The person's changes through Atlas go into the action journal (action-journal-gateway.mjs).
  const handlers = Object.freeze(journalGatewayHandlers({
    ...projectResources,
    ...projectSave,
    ...projectCopy,
    ...agentEventHandlers,
    ...createApplicationAgentArtifactHandlers(artifacts),
    ...createApplicationAgentConversationHandlers({ service: memoryService,
      reader: provider.conversationReader, instanceId, now, onDiagnostic,
      ...conversationOptions }),
    ...createApplicationAgentControlHandlers(memoryService),
    ...(memoryService ? createApplicationProjectMemoryHandlers({ service: memoryService }) : {}),
    ...readHandlers,
    ...domainHandlers,
    ...provider.interactionHandlers,
    ...provider.mutationHandlers,
  }, { service: memoryService, controllerRoot: repoRoot, now, onDiagnostic }));
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_READ_RUNTIME_VERSION,
    handlers,
    providerStates: structuredClone([...provider.providerStates, ...extras.flatMap((extra) => extra?.providerStates ?? [])]),
    authenticationStates: structuredClone([...provider.authenticationStates,
      ...extras.flatMap((extra) => extra?.authenticationStates ?? [])]),
    provider: providerKind,
    providerStatus: Object.freeze({
      status: provider.status,
      reasonCode: provider.reasonCode,
    }),
    mutationStatus: Object.freeze(structuredClone(provider.mutationStatus)),
    ownerChatStatus: provider.ownerChatStatus,
    memoryStatus: { storage: memoryService ? "available" : "unavailable",
      execution: memoryService?.provider ? "available" : "unavailable" },
    projectResourceBinding: Object.freeze({
      rootId: "controller-workspace",
      readPolicyId: "project-owner-read-v1",
      sourceId,
      revision: Object.freeze({
        schemaVersion: 1,
        kind: "opaque",
        value: `gateway-instance:${instanceId}`,
      }),
    }),
    close: async () => {
      await provider.close();
      await closeRouted();
    },
  });
}

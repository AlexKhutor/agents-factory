import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ApplicationContractError, validateApplicationPayloadPrivacy } from "./application-contract.mjs";
import { conversationArchiveIdentity } from "./conversation-archive.mjs";
import { validateProviderConversationThreadReadResult } from "./provider-conversation-reader.mjs";

export const APPLICATION_AGENT_CONVERSATION_VERSION = "v0.1.0";
export const APPLICATION_AGENT_CONVERSATION_OPERATIONS = Object.freeze({
  resolve: "query.agent-conversation.resolve", read: "query.agent-conversation.read",
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const REASONS = new Set(["identity_mismatch", "concurrent_update", "provider_revision_unavailable",
  "thread_not_found", "invalid_provider_payload", "provider_payload_too_large", "access_denied",
  "stale_revision", "conflict", "source_unavailable", "privacy_violation"]);
function fail(code) { throw new ApplicationContractError(code, "Agent conversation read unavailable"); }
function input(value, read) {
  const keys = read ? ["agentId", "cursor", "limit"] : ["agentId"];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).some((key) => !keys.includes(key))
      || typeof value.agentId !== "string" || !ID.test(value.agentId)) fail("conflict");
  const limit = value.limit === undefined ? 50 : value.limit, cursor = value.cursor ?? null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 128
      || (cursor !== null && (typeof cursor !== "string" || !cursor.length || cursor.length > 2048))) fail("conflict");
  return { agentId: value.agentId, limit, cursor };
}
function errorCode(error) {
  if (["concurrent_update", "stale_revision"].includes(error?.code)) return "stale_revision";
  if (["access_denied", "privacy_violation"].includes(error?.code)) return "access_denied";
  return error?.code === "conflict" ? "conflict" : "source_unavailable";
}

/**
 * One reader (`reader`, `providerId`, `adapterId`), or several: `routes` is
 * [{ providerId, adapterId, reader }] and an agent is read by the route of its
 * binding's provider (agents of several providers in one Gateway).
 */
export function createApplicationAgentConversationHandlers({ service, reader = null, instanceId,
  now = () => new Date(), onDiagnostic = () => {}, providerId = "codex", adapterId = "codex-app-server",
  routes = null } = {}) {
  if (!service) return Object.freeze({});
  if (typeof service.readAgent !== "function" || !ID.test(instanceId ?? "")) throw new TypeError("Invalid agent reader configuration");
  const table = (routes ?? [{ providerId, adapterId, reader }]).filter((route) => route && route.providerId);
  const routeOf = (binding) => table.find((route) => route.providerId === binding?.providerId) ?? null;
  const anyReader = table.some((route) => route.reader);
  const secret = randomBytes(32);
  const seal = (value) => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
  };
  const unseal = (cursor) => {
    try {
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.length < 29 || bytes.toString("base64url") !== cursor) fail("stale_revision");
      const cipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
    } catch { fail("stale_revision"); }
  };
  const resolve = async (agentId) => {
    const agent = await service.readAgent({ agentId });
    if (agent.agentId !== agentId) fail("source_unavailable");
    const binding = agent.binding;
    const conversationId = binding ? conversationArchiveIdentity(binding) : null;
    const route = binding ? routeOf(binding) : null;
    const identity = route?.reader?.descriptor?.identity;
    const reasonCode = !binding ? "agent_unbound" : agent.state === "archived" ? "agent_archived"
      : !route ? (anyReader ? "provider_identity_mismatch" : "provider_unavailable")
      : !route.reader ? "provider_unavailable"
      : binding.projectId !== service.archive?.projectId
        || binding.sourceId !== identity?.sourceId || identity?.adapterId !== route.adapterId
        ? "provider_identity_mismatch" : "available";
    return { agent, reader: route?.reader ?? null, view: { schemaVersion: 1, contractVersion: APPLICATION_AGENT_CONVERSATION_VERSION,
      agentId, conversationId, archiveCoverage: "captured-only",
      liveRead: { status: reasonCode === "available" ? "available" : "unavailable", reasonCode } } };
  };
  const wrap = (operationId, action) => async (request) => {
    let phase = "input";
    try {
      const options = input(request?.input, operationId === APPLICATION_AGENT_CONVERSATION_OPERATIONS.read);
      validateApplicationPayloadPrivacy(request.input, { zone: "request-input", operationId });
      const result = await action(options, (value) => { phase = value; });
      phase = "output";
      validateApplicationPayloadPrivacy(result, { zone: "result-output", operationId });
      return structuredClone(result);
    } catch (error) {
      const code = errorCode(error);
      const diagnostic = { schemaVersion: 1, component: "agent-conversation", operationId, phase,
        atUtc: now().toISOString(), reasonCode: REASONS.has(error?.code) ? error.code : "source_unavailable",
        code, requestId: ID.test(request?.requestId ?? "") ? request.requestId : null,
        correlationId: ID.test(request?.correlationId ?? "") ? request.correlationId : null };
      try { await onDiagnostic(diagnostic); } catch { /* Diagnostics cannot authorize or retry reads. */ }
      throw Object.assign(new ApplicationContractError(code, "Agent conversation read unavailable"),
        { agentConversationDiagnostic: diagnostic });
    }
  };
  const operations = APPLICATION_AGENT_CONVERSATION_OPERATIONS;
  const handlers = { [operations.resolve]: wrap(operations.resolve, async ({ agentId }, phase) => {
    phase("binding"); return (await resolve(agentId)).view;
  }) };
  if (anyReader) handlers[operations.read] = wrap(operations.read, async (options, phase) => {
    phase("binding");
    const { agent, view, reader } = await resolve(options.agentId);
    if (view.liveRead.status !== "available") {
      fail(view.liveRead.reasonCode === "agent_archived" ? "conflict" : "source_unavailable");
    }
    const provider = reader.descriptor.identity;
    const threadRef = { schemaVersion: 1, kind: "provider-thread", relationship: "provider-owner",
      authority: { schemaVersion: 1, authorityType: "provider", sourceId: provider.sourceId,
        externalId: agent.binding.threadId, contractVersion: provider.adapterVersion } };
    phase("continuation");
    const previous = options.cursor === null ? null : unseal(options.cursor);
    if (previous && (previous.agentId !== options.agentId || previous.conversationId !== view.conversationId
        || previous.instanceId !== instanceId || previous.limit !== options.limit)) fail("stale_revision");
    phase("provider-read");
    const read = structuredClone(await reader.readThread({ threadRef, includeContent: true,
      limit: options.limit, cursor: previous?.providerCursor ?? null }));
    validateProviderConversationThreadReadResult(read);
    const returned = read.threadRead.data.thread.threadRef;
    if (read.provider.sourceId !== provider.sourceId || read.provider.adapterId !== provider.adapterId
        || read.provider.adapterVersion !== provider.adapterVersion
        || read.provider.runtimeInstanceId !== provider.runtimeInstanceId
        || returned.authority.externalId !== agent.binding.threadId
        || returned.authority.sourceId !== provider.sourceId) fail("source_unavailable");
    const revision = read.threadRead.data.thread.updatedAtUtc;
    if (!revision || (previous && previous.revision !== revision)) fail("stale_revision");
    phase("binding-recheck");
    const current = await resolve(options.agentId);
    if (current.view.conversationId !== view.conversationId || current.view.liveRead.status !== "available") fail("conflict");
    const providerCursor = read.threadRead.data.completeness.nextCursor;
    if (providerCursor !== read.contentCompleteness.nextCursor) fail("source_unavailable");
    const nextCursor = providerCursor === null ? null : seal({ agentId: options.agentId,
      conversationId: view.conversationId, instanceId, limit: options.limit, revision, providerCursor });
    // The application page has its own continuation contract, not a mutated provider envelope.
    return { schemaVersion: 1, contractVersion: APPLICATION_AGENT_CONVERSATION_VERSION,
      agentId: options.agentId, conversationId: view.conversationId,
      mode: "provider-read", revision, nextCursor, observedAtUtc: read.threadRead.observedAtUtc,
      thread: read.threadRead.data.thread, turns: read.threadRead.data.turns, content: read.content,
      completeness: { status: read.contentCompleteness.status, reasonCode: read.contentCompleteness.reasonCode } };
  });
  return Object.freeze(handlers);
}

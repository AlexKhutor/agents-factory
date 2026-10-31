import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { ApplicationContractError, validateApplicationPayloadPrivacy } from "./application-contract.mjs";
import { conversationArchiveIdentity } from "./conversation-archive.mjs";
import { normalizeApplicationProjectMemoryError } from "./application-project-memory.mjs";

export const APPLICATION_AGENT_EVENTS_VERSION = "v0.1.0";
export const APPLICATION_AGENT_EVENTS_OPERATION = "query.agent-events.read";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
function validId(value) { return typeof value === "string" && ID.test(value); }
function fail(code) { throw new ApplicationContractError(code, "Agent event read refused"); }

// Bounded metadata already observed by the supervised Gateway client. No timer,
// worker, provider call, execution receipt or hidden long-running read is created.
export function createApplicationAgentEventBridge({ service, client, providerSourceId, instanceId,
  now = () => new Date(), providerId = "codex" } = {}) {
  if (!service || !client) return { handlers: {}, close() {} };
  const key = randomBytes(32), listeners = [], retained = [];
  let sequence = 0, unavailable = false;
  const sign = (body) => createHmac("sha256", key).update(body).digest();
  const cursor = (agentId, conversationId, after) => {
    const body = Buffer.from(JSON.stringify({ agentId, conversationId, instanceId, after })).toString("base64url");
    return body + "." + sign(body).toString("base64url");
  };
  const decode = (value) => {
    try {
      if (typeof value !== "string" || value.length > 2048) return null;
      const [body, signature, extra] = value.split("."), supplied = Buffer.from(signature, "base64url");
      const expected = sign(body);
      if (extra !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch { return null; }
  };
  const on = (name, handler) => { client.on(name, handler); listeners.push([name, handler]); };
  const append = (kind, threadId, turnId, itemId) => {
    if (unavailable) return;
    if (!validId(threadId) || (turnId !== null && !validId(turnId)) || (itemId !== null && !validId(itemId))) {
      unavailable = true; return;
    }
    retained.push({ sequence: ++sequence, threadId, turnId, itemId, kind, observedAtUtc: now().toISOString() });
    if (retained.length > 256) retained.shift();
  };
  for (const [method, kind] of [["turn/started", "turn-started"], ["turn/completed", "turn-completed"],
    ["item/started", "item-started"], ["item/completed", "item-completed"]]) {
    on(method, (params) => {
      if (unavailable) return;
      const threadId = params?.threadId, turnId = params?.turnId ?? params?.turn?.id,
        itemId = params?.item?.id ?? null;
      if (!validId(threadId) || !validId(turnId) || (itemId !== null && !validId(itemId))) {
        unavailable = true; return;
      }
      append(kind, threadId, turnId, itemId);
    });
  }
  for (const name of ["exit", "close", "disconnect"]) on(name, () => { unavailable = true; });
  const read = async ({ input }) => {
    try {
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || !validId(input.agentId)
          || Object.keys(input).some((key) => !["agentId", "cursor", "limit"].includes(key))) fail("conflict");
      const limit = input.limit === undefined ? 32 : input.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 64) fail("conflict");
      if (unavailable) fail("source_unavailable");
      const agent = await service.readAgent({ agentId: input.agentId }), binding = agent.binding;
      if (unavailable || agent.agentId !== input.agentId || !binding || binding.providerId !== providerId
          || binding.projectId !== service.archive.projectId || binding.sourceId !== providerSourceId) fail("source_unavailable");
      const conversationId = conversationArchiveIdentity(binding), head = sequence;
      let mode = "resumed", reasonCode = null, after = head;
      if (input.cursor == null) { mode = "snapshot-required"; reasonCode = "initial_snapshot_required"; }
      else {
        const claims = decode(input.cursor);
        if (!claims || claims.agentId !== input.agentId || claims.conversationId !== conversationId
            || claims.instanceId !== instanceId || !Number.isSafeInteger(claims.after) || claims.after < 0 || claims.after > head) {
          mode = "resync-required"; reasonCode = "cursor_invalid";
        } else if (retained.length && claims.after < retained[0].sequence - 1) {
          mode = "resync-required"; reasonCode = "replay_gap";
        } else after = claims.after;
      }
      const pending = mode === "resumed" ? retained.filter((event) => event.sequence > after
        && event.sequence <= head && event.threadId === binding.threadId) : [];
      const events = pending.slice(0, limit).map(({ threadId, ...event }) => event);
      const hasMore = pending.length > limit;
      const result = { schemaVersion: 1, contractVersion: APPLICATION_AGENT_EVENTS_VERSION,
        agentId: input.agentId, conversationId, mode, reasonCode, coverage: "observed-only", events, hasMore,
        nextCursor: cursor(input.agentId, conversationId, hasMore ? events.at(-1).sequence : head), observedAtUtc: now().toISOString() };
      validateApplicationPayloadPrivacy(result, { zone: "result-output", operationId: APPLICATION_AGENT_EVENTS_OPERATION });
      return result;
    } catch (error) { throw normalizeApplicationProjectMemoryError(error); }
  };
  return { read, handlers: { [APPLICATION_AGENT_EVENTS_OPERATION]: read },
    interactionChanged: ({ threadId, turnId, itemId }) => append("interaction-changed", threadId, turnId, itemId),
    close() {
    unavailable = true;
    for (const [name, handler] of listeners) client.off(name, handler);
    listeners.length = 0; retained.length = 0;
  } };
}

/**
 * Agents of several providers in one Gateway: one bridge per provider client
 * ({ providerId, bridge }), and the read goes to the bridge of the agent's
 * binding. Each bridge still checks the binding itself.
 */
export function combineApplicationAgentEventBridges({ service, bridges }) {
  const table = (bridges ?? []).filter((entry) => entry?.bridge?.read);
  if (!service || table.length === 0) return { handlers: {}, close() {} };
  if (table.length === 1) return table[0].bridge;
  const read = async (request) => {
    try {
      const agentId = request?.input?.agentId;
      if (!validId(agentId)) fail("conflict");
      const agent = await service.readAgent({ agentId });
      const entry = table.find((item) => item.providerId === agent.binding?.providerId);
      if (!entry) fail("source_unavailable");
      return await entry.bridge.read(request);
    } catch (error) { throw normalizeApplicationProjectMemoryError(error); }
  };
  return {
    read, handlers: { [APPLICATION_AGENT_EVENTS_OPERATION]: read },
    close() { for (const entry of table) entry.bridge.close(); },
  };
}

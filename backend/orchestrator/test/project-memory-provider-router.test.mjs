import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMemoryProviderRouter } from "../src/project-memory-provider-router.mjs";
import { ProjectMemoryService } from "../src/project-memory-service.mjs";
import { createApplicationAgentConversationHandlers } from "../src/application-agent-conversation.mjs";
import { combineApplicationAgentEventBridges, APPLICATION_AGENT_EVENTS_OPERATION } from "../src/application-agent-events.mjs";

function fakeProvider(id, flags = {}) {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return `${id}:${name}`; };
  return {
    calls, ...flags,
    preflight: record("preflight"), resolveWorkspace: record("resolveWorkspace"), create: record("create"),
    send: record("send"), observe: record("observe"), interrupt: record("interrupt"), trace: record("trace"),
    capture: record("capture"), listInteractions: record("listInteractions"),
    queued: (agent) => [`${id}:${agent.agentId}`],
    close: async () => { calls.push(["close"]); },
  };
}

const agent = (agentId, providerId, settings) => ({
  agentId, projectId: "p", quarterId: "q", state: "active",
  profile: { provider: providerId, model: "m", reasoningEffort: "default", fallbackPolicy: "deny" },
  binding: { projectId: "p", sourceId: "s", providerId, threadId: `${agentId}-thread` },
  ...(settings ? { settings } : {}),
});

test("the router hands every call to the provider of the agent", async () => {
  const claude = fakeProvider("claude", { enforcesWriteZones: true, memoryDocuments: true });
  const acp = fakeProvider("acp");
  const router = createProjectMemoryProviderRouter({ claude, acp });
  assert.deepEqual(router.providers, ["claude", "acp"]);
  assert.equal(await router.send({ agent: agent("a", "acp"), text: "x" }), "acp:send");
  assert.equal(await router.observe({ agent: agent("b", "claude") }), "claude:observe");
  assert.equal(await router.trace(agent("a", "acp"), {}), "acp:trace");
  assert.deepEqual(router.queued(agent("a", "acp")), ["acp:a"]);
  // Before an agent exists it belongs to the provider its profile names.
  const unbound = { ...agent("c", "acp"), binding: null };
  assert.equal(await router.create(unbound), "acp:create");
  assert.equal(await router.resolveWorkspace(unbound), "acp:resolveWorkspace");
  assert.equal(await router.preflight(unbound.profile), "acp:preflight");
  assert.equal(await router.memoryDeliveryKey(agent("a", "acp")), null);
  // Flags are per agent now.
  assert.equal(router.flagFor(agent("b", "claude"), "enforcesWriteZones"), true);
  assert.equal(router.flagFor(agent("a", "acp"), "enforcesWriteZones"), false);
  await router.close();
  assert.deepEqual(claude.calls.at(-1), ["close"]);
  assert.deepEqual(acp.calls.at(-1), ["close"]);
});

test("an unknown provider or a missing operation is refused", async () => {
  const router = createProjectMemoryProviderRouter({ claude: fakeProvider("claude") });
  await assert.rejects(router.send({ agent: agent("x", "openai") }), { code: "memory_provider_unavailable" });
  await assert.rejects(router.steer({ agent: agent("y", "claude") }), { code: "memory_provider_unavailable" });
  assert.throws(() => createProjectMemoryProviderRouter({}), { code: "memory_provider_unavailable" });
  assert.deepEqual(router.queued(agent("x", "openai")), []);
});

test("two agents may share a folder only when both providers hold zones", () => {
  const router = createProjectMemoryProviderRouter({
    claude: fakeProvider("claude", { enforcesWriteZones: true }), acp: fakeProvider("acp"),
  });
  const service = new ProjectMemoryService({ store: null, provider: router, archive: null });
  const zoned = (id, providerId, zone) => agent(id, providerId, { role: "feature", writeZone: [zone], revision: 1 });
  const left = zoned("l", "claude", "mods/clothes/**");
  assert.equal(service.mayCollide(left, zoned("r", "claude", "mods/cars/**")), false);
  assert.equal(service.mayCollide(left, zoned("r", "acp", "mods/cars/**")), true);
  assert.equal(service.providerFlag(left, "enforcesWriteZones"), true);
});

test("agent conversations are read through the route of the agent's provider", async () => {
  const reader = (sourceId, adapterId) => ({ descriptor: { identity: { sourceId, adapterId } }, readThread: async () => null });
  const agents = { a: agent("a", "claude"), b: agent("b", "acp"), c: agent("c", "openai") };
  const service = { archive: { projectId: "p" }, readAgent: async ({ agentId }) => agents[agentId] };
  const handlers = createApplicationAgentConversationHandlers({ service, instanceId: "instance-1", routes: [
    { providerId: "claude", adapterId: "claude-code-sdk", reader: reader("s", "claude-code-sdk") },
    { providerId: "acp", adapterId: "acp-stdio", reader: reader("s", "acp-stdio") },
  ] });
  const resolve = (agentId) => handlers["query.agent-conversation.resolve"]({ input: { agentId } });
  assert.equal((await resolve("a")).liveRead.reasonCode, "available");
  assert.equal((await resolve("b")).liveRead.reasonCode, "available");
  assert.equal((await resolve("c")).liveRead.reasonCode, "provider_identity_mismatch");
  assert.equal(typeof handlers["query.agent-conversation.read"], "function");
});

test("agent events go to the bridge of the agent's provider", async () => {
  const agents = { a: agent("a", "claude"), b: agent("b", "acp") };
  const service = { readAgent: async ({ agentId }) => agents[agentId] };
  const bridge = (name) => ({ read: async () => name, close: () => {} });
  const combined = combineApplicationAgentEventBridges({ service, bridges: [
    { providerId: "claude", bridge: bridge("claude-events") }, { providerId: "acp", bridge: bridge("acp-events") },
  ] });
  const read = combined.handlers[APPLICATION_AGENT_EVENTS_OPERATION];
  assert.equal(await read({ input: { agentId: "a" } }), "claude-events");
  assert.equal(await read({ input: { agentId: "b" } }), "acp-events");
  // One bridge stays as it is.
  const single = bridge("only");
  assert.equal(combineApplicationAgentEventBridges({ service, bridges: [{ providerId: "claude", bridge: single }] }), single);
});

// Agents of several providers in one Gateway: the ProjectMemoryService
// provider that hands every call to the provider of the agent it is about.
//
// An agent belongs to the provider of its binding (binding.providerId) once it
// exists, and to the provider its profile names (profile.provider) while it is
// being created. Each provider keeps its own contract (project-memory-claude.mjs,
// project-memory-acp.mjs); the router adds nothing but the choice. Flags that
// used to describe the whole Gateway (enforcesWriteZones, memoryDocuments,
// controllerTasks) are asked per agent through flagFor.

export const PROJECT_MEMORY_PROVIDER_ROUTER_VERSION = "v0.1.0";

function fail(code) { throw Object.assign(new Error(code), { code }); }

/** `providers`: { [providerId]: memory provider } with at least one entry. */
export function createProjectMemoryProviderRouter(providers) {
  const table = new Map(Object.entries(providers ?? {}).filter(([, provider]) => provider));
  if (table.size === 0) fail("memory_provider_unavailable");
  const providerIdOf = (agent) => agent?.binding?.providerId ?? agent?.profile?.provider ?? null;
  const forProfile = (profile) => table.get(profile?.provider) ?? fail("memory_provider_unavailable");
  const forAgent = (agent) => table.get(providerIdOf(agent)) ?? fail("memory_provider_unavailable");
  // Async, so a refusal reaches the caller as a rejection like the providers' own.
  const call = (name) => async (args) => {
    const provider = forAgent(args?.agent);
    if (typeof provider[name] !== "function") fail("memory_provider_unavailable");
    return provider[name](args);
  };
  const callAgent = (name) => async (agent, ...rest) => {
    const provider = forAgent(agent);
    if (typeof provider[name] !== "function") fail("memory_provider_unavailable");
    return provider[name](agent, ...rest);
  };
  return {
    providers: Object.freeze([...table.keys()]),
    /** A provider flag for this agent's provider (false when the provider lacks it). */
    flagFor(agent, name) { return table.get(providerIdOf(agent))?.[name] === true; },
    async preflight(profile) { return forProfile(profile).preflight(profile); },
    async resolveWorkspace(agent) {
      const provider = forAgent(agent);
      if (typeof provider.resolveWorkspace !== "function") fail("memory_provider_unavailable");
      return provider.resolveWorkspace(agent);
    },
    async create(agent) { return forProfile(agent?.profile).create(agent); },
    async memoryDeliveryKey(agent) {
      const provider = forAgent(agent);
      return typeof provider.memoryDeliveryKey === "function" ? provider.memoryDeliveryKey(agent) : null;
    },
    send: call("send"),
    observe: call("observe"),
    steer: call("steer"),
    unqueue: call("unqueue"),
    interrupt: call("interrupt"),
    queued(agent) {
      const provider = table.get(providerIdOf(agent));
      return typeof provider?.queued === "function" ? provider.queued(agent) : [];
    },
    trace: callAgent("trace"),
    capture: callAgent("capture"),
    interactionSummary: callAgent("interactionSummary"),
    listInteractions: callAgent("listInteractions"),
    respondInteraction: callAgent("respondInteraction"),
    async close() {
      for (const provider of table.values()) await provider.close?.();
    },
  };
}

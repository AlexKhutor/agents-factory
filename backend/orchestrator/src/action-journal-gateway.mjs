import { isDeepStrictEqual } from "node:util";

import { recordActionQuietly } from "./action-journal.mjs";
import { keepPreviousFile } from "./action-journal-files.mjs";

// The Gateway's mutations in the action journal (action-journal.mjs). The
// person acts through Atlas, so the actor is the person. Each wrapped handler
// looks at the state it is about to change, runs the operation unchanged, and
// records an entry only when something did change: a retried operation (the
// same operationId answered again) adds nothing. A journal that cannot be
// written never fails the operation.

export const ACTION_JOURNAL_GATEWAY_VERSION = "v0.1.0";

const PERSON = Object.freeze({ kind: "person", id: null });

/** Never throws: what a snapshot cannot read is null, and the operation reports its own failure. */
async function quietly(read) {
  try { return await read(); } catch { return null; }
}

async function agentOf(service, agentId) {
  return quietly(async () => service.find((await service.catalog()).value, agentId));
}

async function scopeOf(store, scopeId) {
  return quietly(() => store.readScope({ scopeId }));
}

const JOURNALED = {
  "mutation.memory.agent.create": {
    before: ({ service, input }) => agentOf(service, input?.agentId),
    async entry({ service, input, before }) {
      if (before !== null) return null;
      const agent = await agentOf(service, input.agentId);
      if (agent === null) return null;
      return { action: "agent.create", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId,
        summary: `Created agent ${agent.agentId} (${agent.profile.model})`,
        undo: { kind: "close-agent", agentId: agent.agentId } };
    },
  },
  "mutation.memory.agent.close": {
    before: ({ service, input }) => agentOf(service, input?.agentId),
    async entry({ service, input, before }) {
      if (before === null || before.state === "archived") return null;
      const agent = await agentOf(service, input.agentId);
      if (agent?.state !== "archived") return null;
      return { action: "agent.close", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId,
        summary: `Closed agent ${agent.agentId}`, undo: { kind: "reopen-agent", agentId: agent.agentId } };
    },
  },
  "mutation.memory.agent.profile": {
    before: ({ service, input }) => agentOf(service, input?.agentId),
    async entry({ service, input, before }) {
      if (before === null) return null;
      const agent = await agentOf(service, input.agentId);
      if (agent === null || isDeepStrictEqual(agent.profile, before.profile)) return null;
      return { action: "agent.profile", projectId: agent.projectId, quarterId: agent.quarterId, agentId: agent.agentId,
        summary: `Model of ${agent.agentId}: ${before.profile.model} (${before.profile.reasoningEffort}) → `
          + `${agent.profile.model} (${agent.profile.reasoningEffort})`,
        undo: { kind: "set-profile", agentId: agent.agentId, profile: before.profile, expect: agent.profile } };
    },
  },
  "mutation.memory.scope.create": {
    before: ({ service, input }) => scopeOf(service.store, input?.scopeId),
    async entry({ service, input, before }) {
      if (before !== null) return null;
      const scope = await scopeOf(service.store, input.scopeId);
      if (scope === null || !["project", "quarter"].includes(scope.kind)) return null;
      return scope.kind === "project"
        ? { action: "scope.create", projectId: scope.projectId, summary: `Created project "${scope.title}"`,
          undo: { kind: "archive-project", projectId: scope.projectId } }
        : { action: "scope.create", projectId: scope.projectId, quarterId: scope.quarterId,
          summary: `Created quarter "${scope.title}"`,
          undo: { kind: "archive-quarter", projectId: scope.projectId, quarterId: scope.quarterId } };
    },
  },
  "mutation.memory.scope.write": {
    before: ({ service, input }) => scopeOf(service.store, input?.scopeId),
    async entry({ output, before }) {
      // A replayed write answers its old receipt: the memory was then already past it.
      if (before === null || output?.previousRevision !== before.revision) return null;
      return memoryWrite(before, output, PERSON);
    },
  },
  "mutation.memory.project.copy": {
    before: ({ service, input }) => quietly(async () => (await service.store.listScopes({ projectId: input.targetProjectId }))
      .scopes.length),
    async entry({ input, before }) {
      if (before !== 0) return null;
      return { action: "project.copy", projectId: input.targetProjectId,
        summary: `Copied project ${input.sourceProjectId} as ${input.targetProjectId}`,
        undo: { kind: "archive-project", projectId: input.targetProjectId } };
    },
  },
  // The version a save replaces is kept on this PC first (action-journal-files.mjs), so the save can be undone.
  "mutation.project-workspace.save": {
    before: ({ service, input, controllerRoot }) => (controllerRoot === null ? null : keepPreviousFile({ controllerRoot,
      store: service.store, projectId: input.projectId, relativePath: input.path, expectedSha256: input.expectedSha256 })),
    async entry({ input, before, output }) {
      if (typeof output?.contentSha256 !== "string") return null;
      return { action: "project.file-save", projectId: input.projectId, summary: `Saved ${input.path}`,
        ...(before === null ? { noUndo: "file_not_kept" } : { undo: { kind: "restore-file", projectId: input.projectId,
          path: input.path, sha256: before, expect: output.contentSha256 } }) };
    },
  },
};

/** The entry of a memory write: back to the revision before it. */
export function memoryWrite(scope, receipt, actor) {
  return { action: "memory.write", actor, projectId: scope.projectId, quarterId: scope.quarterId,
    ...(actor.kind === "agent" ? { agentId: actor.id } : {}),
    summary: `Memory "${scope.title}": revision ${receipt.previousRevision} → ${receipt.revision}`,
    undo: { kind: "memory-revision", scopeId: scope.scopeId, revision: receipt.previousRevision,
      expectRevision: receipt.revision } };
}

/** The handlers with the journaled mutations wrapped; the others as they were. */
export function journalGatewayHandlers(handlers, { service, controllerRoot = null, now = () => new Date(),
  onDiagnostic = () => {} } = {}) {
  if (!service?.store) return handlers;
  const wrapped = { ...handlers };
  for (const [operationId, journal] of Object.entries(JOURNALED)) {
    const handler = handlers[operationId];
    if (typeof handler !== "function") continue;
    wrapped[operationId] = async (request) => {
      const input = request?.input ?? null;
      const before = await quietly(() => journal.before({ service, input, controllerRoot }));
      const output = await handler(request);
      const entry = await quietly(() => journal.entry({ service, input, before, output }));
      if (entry !== null) {
        await recordActionQuietly(service.store, { actor: PERSON, ...entry }, { now, onDiagnostic });
      }
      return output;
    };
  }
  return wrapped;
}

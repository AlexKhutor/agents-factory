// The read journal: what this host actually asked the gateway, per run.
//
// Evidence of a read-only acceptance has to rest on the calls that went out, not
// on what the window happened to draw. Every allowlisted read made through the
// gateway module leaves one entry here: when it started and ended, what it
// targeted, which descriptor it ran against, the request and correlation ids
// the kit returned, how it ended, and a few bounded facts about the result.
//
// Nothing is filled in. An id the kit did not return stays null; a refusal
// before the network is "not-attempted", never a request; a call that has not
// ended is "in-progress". Bodies are never kept: no memory text, no
// conversation, no descriptor, no bearer, no endpoint, no error message or
// stack - only identifiers, counts, revisions, states and codes that pass a
// strict pattern. The journal is bounded and says when it dropped anything.

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * How a call reached the host: "ui-ipc" - a person in the window, through the
 * preload bridge; "capture" - an unattended screenshot scene driving the window;
 * "host-direct" - a script or the probe calling host functions without Electron.
 * Only the host's IPC registration sets it; anything else is host-direct.
 */
export const callPath = new AsyncLocalStorage();
const currentPath = () => callPath.getStore() ?? "host-direct";

export const JOURNAL_LIMITS = Object.freeze({ maxEntries: 1000, maxDispatches: 2000, maxSnapshots: 20 });

const id = (value) => (typeof value === "string" && ID.test(value) ? value : null);
const word = (value) => (typeof value === "string" && WORD.test(value) ? value : null);
const utc = (value) => (typeof value === "string" && UTC.test(value) ? value : null);
const hex64 = (value) => (typeof value === "string" && HEX64.test(value) ? value : null);
const num = (value) => (Number.isFinite(value) ? value : null);
const bool = (value) => (typeof value === "boolean" ? value : null);
const count = (value) => (Array.isArray(value) ? value.length : null);

/** Scope facts inside an agent context: identity, revision and size, never the entries. */
const scopeFacts = (scope) => (scope === null || typeof scope !== "object" ? null : {
  scopeId: id(scope.scopeId), revision: num(scope.revision), entryCount: count(scope.entries),
});

/**
 * Bounded facts per read, by allowlist. Anything not named here is not kept,
 * whatever the backend returns.
 */
const FACTS = Object.freeze({
  "query.memory.scopes.list": (o) => ({
    scopeCount: count(o.scopes), truncated: bool(o.truncated), omissionCount: count(o.omissions),
  }),
  "query.memory.scope.read": (o) => ({
    scopeId: id(o.scopeId), kind: word(o.kind), revision: num(o.revision),
    entryCount: count(o.entries), empty: Array.isArray(o.entries) ? o.entries.length === 0 : null,
  }),
  "query.memory.agents.list": (o) => ({
    revision: num(o.revision), agentCount: count(o.agents),
    truncated: bool(o.truncated), omissionCount: count(o.omissions),
  }),
  "query.memory.agent.read": (o) => ({
    agentId: id(o.agentId), state: word(o.state), deliveryState: word(o.deliveryState),
    contentState: word(o.contentState), coverage: word(o.coverage), problemCode: word(o.problemCode),
    currentOperationPresent: o.currentOperationId !== null && o.currentOperationId !== undefined,
    archived: o.archivedAtUtc !== null && o.archivedAtUtc !== undefined,
  }),
  "query.memory.agent.context": (o) => ({
    agentId: id(o.agentId), contentState: word(o.contentState), deliveryState: word(o.deliveryState),
    startBlockedByEmptyMemory: bool(o.startBlockedByEmptyMemory),
    project: scopeFacts(o.project), quarter: scopeFacts(o.quarter),
  }),
  "query.memory.agent.archive": (o) => ({
    agentId: id(o.agentId), revision: num(o.revision), coverage: word(o.coverage),
    itemCount: count(o.items), hasNextCursor: typeof o.nextCursor === "string",
  }),
  "query.agent-control.interactions": (o) => ({
    agentId: id(o.agentId), recordCount: count(o.records), sourceSequence: num(o.sourceSequence),
    truncated: bool(o.truncated), omissionCount: num(o.omissionCount),
  }),
  "query.agent-conversation.resolve": (o) => ({
    agentId: id(o.agentId), conversationPresent: typeof o.conversationId === "string",
    liveStatus: word(o.liveRead?.status), reasonCode: word(o.liveRead?.reasonCode),
  }),
  "query.agent-conversation.read": (o) => ({
    agentId: id(o.agentId), revision: utc(o.revision), turnCount: count(o.turns), contentCount: count(o.content),
    completeness: word(o.completeness?.status), completenessReason: word(o.completeness?.reasonCode),
    hasNextCursor: typeof o.nextCursor === "string",
  }),
  "query.project-workspace.list": (o) => ({
    projectId: id(o.projectId), kind: word(o.kind), entryCount: count(o.entries), totalEntries: num(o.totalEntries),
    omissionCount: num(o.omissionCount), truncated: bool(o.truncated), hasNextCursor: typeof o.nextCursor === "string",
  }),
  "query.project-workspace.read": (o) => ({
    projectId: id(o.projectId), kind: word(o.kind), contentSha256: hex64(o.contentSha256),
    offsetBytes: num(o.range?.offsetBytes), returnedBytes: num(o.range?.returnedBytes), totalBytes: num(o.range?.totalBytes),
    truncated: bool(o.truncated), hasNextCursor: typeof o.nextCursor === "string",
  }),
  "query.agent-artifacts.list": (o) => ({
    agentId: id(o.agentId), revision: num(o.revision), coverage: word(o.coverage), recordCount: count(o.records),
  }),
  "query.agent-artifacts.read": (o) => ({
    agentId: id(o.agentId), artifactId: id(o.artifactId), coverage: word(o.coverage),
    returnedBytes: num(o.page?.range?.returnedBytes), totalBytes: num(o.page?.range?.totalBytes),
    hasNextCursor: typeof o.page?.nextCursor === "string",
  }),
  "query.agent-events.read": (o) => ({
    agentId: id(o.agentId), mode: word(o.mode), reasonCode: word(o.reasonCode),
    eventCount: count(o.events), hasMore: bool(o.hasMore),
  }),
  "receipt.memory.agent.send": (o) => ({ operationId: id(o.operationId), state: word(o.state) }),
  "mutation.memory.scope.create": (o) => ({ scopeId: id(o.scopeId), kind: word(o.kind), revision: num(o.revision) }),
  "mutation.memory.agent.create": (o) => ({ agentId: id(o.agentId), state: word(o.state) }),
  "mutation.memory.agent.send": (o) => ({ operationId: id(o.operationId), state: word(o.state) }),
  "mutation.memory.agent.close": (o) => ({ agentId: id(o.agentId), state: word(o.state) }),
  // A save receipt: hashes and size, never the text.
  "mutation.project-workspace.save": (o) => ({
    projectId: id(o.projectId), operationId: id(o.operationId), previousSha256: hex64(o.previousSha256),
    contentSha256: hex64(o.contentSha256), bytesWritten: num(o.bytesWritten),
  }),
  // A copy receipt: which scopes, with revisions and hashes, never their entries.
  "mutation.memory.project.copy": (o) => ({
    outcome: word(o.outcome), operationId: id(o.operationId), sourceProjectId: id(o.sourceProjectId),
    targetProjectId: id(o.targetProjectId), scopeCount: count(o.scopes),
  }),
  "mutation.agent-control.interrupt": (o) => ({ operationId: id(o.operationId), state: word(o.state) }),
  "approval.agent-control.respond": (o) => ({
    interactionId: id(o.interaction?.interactionId), state: word(o.interaction?.state),
    deliveryState: word(o.receipt?.deliveryState),
  }),
});

/** Facts of a trusted action's receipt: revision and counts, never the edit itself. */
function trustedFacts(response) {
  if (response === null || typeof response !== "object") return null;
  return {
    status: word(response.status), revision: num(response.revision), entryCount: num(response.entryCount),
    replay: bool(response.replay), receiptId: id(response.receiptId),
  };
}

export function readFacts(operationId, output) {
  const extract = FACTS[operationId];
  if (extract === undefined || output === null || typeof output !== "object") return null;
  return extract(output);
}

/** What a read was aimed at. Identifiers only; a cursor is reported as supplied or not. */
function boundTarget(input) {
  const target = {};
  if (input === null || typeof input !== "object") return target;
  if ("scopeId" in input) target.scopeId = id(input.scopeId);
  if ("projectId" in input) target.projectId = id(input.projectId);
  if ("quarterId" in input) target.quarterId = id(input.quarterId);
  if ("kind" in input) target.kind = word(input.kind);
  if ("interactionId" in input) target.interactionId = id(input.interactionId);
  if ("expectedRevision" in input) target.expectedRevision = num(input.expectedRevision);
  if ("agentId" in input) target.agentId = id(input.agentId);
  if ("taskId" in input) target.taskId = id(input.taskId);
  if ("changeId" in input) target.changeId = id(input.changeId);
  if ("operationId" in input) target.operationId = id(input.operationId);
  if ("artifactId" in input) target.artifactId = id(input.artifactId);
  if ("sourceProjectId" in input) target.sourceProjectId = id(input.sourceProjectId);
  if ("targetProjectId" in input) target.targetProjectId = id(input.targetProjectId);
  if ("expectedSha256" in input) target.expectedSha256 = hex64(input.expectedSha256);
  // Which permission mode a trusted action set for an agent (null: the provider's).
  if ("permissionMode" in input) target.permissionMode = word(input.permissionMode);
  // A file path can name private things; only its length is kept.
  if ("path" in input) target.pathLength = typeof input.path === "string" ? input.path.length : null;
  if ("maximumBytes" in input) target.maximumBytes = Number.isSafeInteger(input.maximumBytes) ? input.maximumBytes : null;
  if ("limit" in input) target.limit = Number.isSafeInteger(input.limit) ? input.limit : null;
  if ("cursor" in input) target.cursorSupplied = typeof input.cursor === "string";
  return target;
}

/** Error codes only. Messages are free text from wherever the error came from, so they stay out. */
function boundError(error) {
  if (error === null || typeof error !== "object") return null;
  const out = { code: word(error.code) };
  if ("reasonCode" in error) out.reasonCode = word(error.reasonCode);
  if ("status" in error) out.status = num(error.status) ?? word(error.status);
  if ("retryable" in error) out.retryable = bool(error.retryable);
  if ("phase" in error) out.phase = word(error.phase);
  if ("reason" in error) out.reason = word(error.reason);
  if ("reasonOmitted" in error) out.reasonOmitted = bool(error.reasonOmitted);
  if ("diagnosticId" in error) out.diagnosticId = id(error.diagnosticId);
  if ("diagnosticPersisted" in error) out.diagnosticPersisted = bool(error.diagnosticPersisted);
  if ("exitCode" in error) out.exitCode = num(error.exitCode);
  if ("uncertain" in error) out.uncertain = bool(error.uncertain);
  return out;
}

/** The descriptor a call ran against: identity and validity, never the endpoint or the bearer. */
export function boundIdentity(descriptor) {
  if (descriptor === null || typeof descriptor !== "object") return null;
  return {
    descriptorId: id(descriptor.descriptorId),
    instanceId: id(descriptor.instance?.instanceId),
    generation: num(descriptor.instance?.generation),
    publishedAtUtc: utc(descriptor.publishedAtUtc),
    validUntilUtc: utc(descriptor.validUntilUtc),
    projectId: id(descriptor.workspace?.projectId),
    sourceId: id(descriptor.workspace?.sourceId),
  };
}

export function newRunId(mode, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `atlas-${mode === "dev-fixture" ? "fixture" : "live"}-${stamp}-${randomBytes(3).toString("hex")}`;
}

function git(projectRoot, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: projectRoot, timeout: 5000, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/**
 * The run header: which build ran, against which accepted delivery, in which
 * mode, expecting which workspace. Taken once, when the run starts. What cannot
 * be learned (no git on an installed machine) is recorded as unavailable.
 */
export async function collectRunHeader({ projectRoot, mode, delivery, expectedWorkspace }) {
  const startedAtUtc = new Date().toISOString();
  let projectVersion = null;
  try {
    projectVersion = word(JSON.parse(await readFile(path.join(projectRoot, "project-version.json"), "utf8"))
      .projectVersion);
  } catch { /* stays null: the file could not be read */ }
  const [head, status] = await Promise.all([
    git(projectRoot, ["rev-parse", "HEAD"]),
    git(projectRoot, ["status", "--porcelain=v1"]),
  ]);
  const commit = head === null ? null : head.trim();
  const changed = status === null ? null : status.split("\n").filter((line) => line.trim() !== "").length;
  return {
    startedAtUtc,
    mode: mode === "dev-fixture" ? "dev-fixture" : "live",
    fixture: mode === "dev-fixture",
    application: {
      projectVersion,
      commit: typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
      dirty: changed === null ? null : changed > 0,
      changedPathCount: changed,
      source: head === null || status === null ? "unavailable" : "git",
    },
    delivery: delivery === null || typeof delivery !== "object" ? null : {
      status: word(delivery.status),
      releaseId: id(delivery.releaseId),
      version: word(delivery.version),
      manifestSha256: hex64(delivery.manifestSha256),
      lockSha256: hex64(delivery.lockSha256),
      filesChecked: num(delivery.filesChecked),
    },
    expectedWorkspace: expectedWorkspace === null || typeof expectedWorkspace !== "object" ? null : {
      projectId: id(expectedWorkspace.projectId),
      workspaceRootSha256: hex64(expectedWorkspace.workspaceRootSha256),
    },
  };
}

export function createReadJournal({ header, now = () => new Date(), limits = {} } = {}) {
  const bounds = { ...JOURNAL_LIMITS, ...limits };
  const runId = newRunId(header?.mode, now());
  const runHeader = Object.freeze({ runId, ...structuredClone(header ?? {}) });
  const entries = [];
  const dispatches = [];
  const snapshots = [];
  const dropped = { entries: 0, dispatches: 0, snapshots: 0 };
  const identities = [];
  let serial = 0;
  let dispatchSerial = 0;
  const at = () => now().toISOString();

  const keep = (list, item, max, key) => {
    list.push(item);
    while (list.length > max) {
      list.shift();
      dropped[key] += 1;
    }
    return item;
  };

  function newEntry(operationId, input, kind = "read") {
    serial += 1;
    const changes = kind !== "read" && kind !== "receipt";
    return {
      localEntryId: `local-${String(serial).padStart(4, "0")}`,
      runId,
      entryKind: word(kind),
      via: currentPath(),
      operationId: id(operationId),
      target: boundTarget(input),
      // The operation id the host minted for a change - not a gateway request id.
      mutationOperationId: changes ? id(input?.operationId) : null,
      commandId: null,
      status: "in-progress",
      startedAtUtc: at(),
      completedAtUtc: null,
      identity: null,
      requestId: null,
      correlationId: null,
      envelopeOutcome: null,
      reasonCode: null,
      error: null,
      facts: null,
    };
  }

  const dispatchedFor = (entry) => dispatches.some((item) => item.localEntryId === entry.localEntryId
    && item.operationId === entry.operationId);

  return {
    runId,
    header: runHeader,

    /** A read is about to be made. Until it is completed or failed it stays "in-progress". */
    begin(operationId, input, { kind = "read" } = {}) {
      return keep(entries, newEntry(operationId, input, kind), bounds.maxEntries, "entries");
    },

    /** How many entries this journal has started; tells a caller whether a call reached the gateway. */
    serial: () => serial,

    /** The descriptor seen by a call; each distinct one is kept once, with when it was first seen. */
    noteIdentity(identity) {
      if (identity === null || identity === undefined || identity.descriptorId === null) return;
      if (identities.some((known) => known.descriptorId === identity.descriptorId)) return;
      identities.push({ ...identity, firstSeenUtc: at() });
    },

    /** The kit returned a result envelope. Its ids and outcome are recorded as returned. */
    complete(entry, { identity = null, envelope }) {
      entry.completedAtUtc = at();
      entry.identity = identity;
      entry.requestId = id(envelope?.requestId);
      entry.correlationId = id(envelope?.correlationId);
      entry.envelopeOutcome = word(envelope?.outcome);
      const outcome = envelope?.outcome;
      entry.status = outcome === "succeeded" ? "success" : outcome === "accepted" ? "accepted"
        : outcome === "uncertain" ? "uncertain" : "failure";
      if (outcome === "succeeded" || outcome === "accepted") entry.facts = readFacts(entry.operationId, envelope.output);
      else entry.error = boundError(envelope?.error);
    },

    /**
     * The call threw. If its own request never went out, it was refused before
     * the network and is recorded as not attempted, not as a request.
     */
    fail(entry, { identity = null, error }) {
      entry.completedAtUtc = at();
      entry.identity = identity;
      entry.error = boundError(error);
      entry.reasonCode = word(error?.code);
      entry.status = dispatchedFor(entry) ? "failure" : "not-attempted";
    },

    /** Refused before any request: invalid input, an operation outside the allowlist. */
    notAttempted(operationId, input, reasonCode, { kind = "read" } = {}) {
      const entry = newEntry(operationId, input, kind);
      entry.status = "not-attempted";
      entry.completedAtUtc = entry.startedAtUtc;
      entry.reasonCode = word(reasonCode);
      return keep(entries, entry, bounds.maxEntries, "entries");
    },

    /**
     * A trusted local action (Gateway CLI) begins. Its entry is named
     * "trusted.<action>"; it is not a gateway operation and has no request id.
     */
    beginTrusted(action, target) {
      return keep(entries, newEntry(`trusted.${action}`, target, "trusted-action"), bounds.maxEntries, "entries");
    },

    /**
     * How a trusted action ended. Declined, invalid or never-started means
     * nothing reached the CLI (not-attempted); a CLI that had to be stopped, or
     * answered success unreadably, is uncertain; a CLI error is a failure.
     */
    completeTrusted(entry, result) {
      entry.completedAtUtc = at();
      const identity = result?.ok ? result.data?.identity : result?.identity;
      entry.mutationOperationId = id(identity?.operationId);
      entry.commandId = id(identity?.commandId);
      if (result?.ok) {
        entry.status = "success";
        entry.facts = trustedFacts(result.data?.response);
        return;
      }
      const error = result?.error ?? {};
      entry.error = boundError(error);
      entry.reasonCode = word(error.reasonCode) ?? word(error.code);
      if (error.code === "cli_failed") entry.status = "failure";
      else if (error.uncertain === true || error.code === "cli_response_invalid") entry.status = "uncertain";
      else {
        entry.status = "not-attempted";
        entry.reasonCode = word(error.code === "invalid_input" ? error.reasonCode : error.code) ?? entry.reasonCode;
      }
    },

    /** One request leaving this host, as the host saw it at dispatch. */
    recordDispatch({ localEntryId = null, context = null, operationId, requestId, correlationId }) {
      dispatchSerial += 1;
      return keep(dispatches, {
        dispatchId: `dispatch-${String(dispatchSerial).padStart(4, "0")}`,
        runId,
        atUtc: at(),
        localEntryId: id(localEntryId),
        context: word(context),
        operationId: id(operationId),
        requestId: id(requestId),
        correlationId: id(correlationId),
        httpStatus: null,
        transport: "pending",
      }, bounds.maxDispatches, "dispatches");
    },

    settleDispatch(dispatch, { httpStatus = null, transport }) {
      dispatch.httpStatus = num(httpStatus);
      dispatch.transport = word(transport);
    },

    /** Capability statuses as discovery reported them: a snapshot, kept apart from the calls. */
    recordCapabilities(statuses, identity = null) {
      const operations = statuses.map((entry) => ({
        operationId: id(entry.operationId), status: word(entry.status), reasonCode: word(entry.reasonCode),
      }));
      // A long run with "watch" on sees the same statuses again and again. An
      // identical snapshot of the same descriptor is counted, not stored again,
      // so dropping duplicates never marks the package incomplete.
      const last = snapshots[snapshots.length - 1];
      if (last !== undefined && last.identity?.descriptorId === (identity?.descriptorId ?? undefined)
          && JSON.stringify(last.operations) === JSON.stringify(operations)) {
        last.seenCount += 1;
        last.lastSeenUtc = at();
        return last;
      }
      const atUtc = at();
      return keep(snapshots, {
        runId, atUtc, lastSeenUtc: atUtc, seenCount: 1, identity, operations,
      }, bounds.maxSnapshots, "snapshots");
    },

    snapshot() {
      const counts = { success: 0, accepted: 0, failure: 0, uncertain: 0, "not-attempted": 0, "in-progress": 0 };
      for (const entry of entries) counts[entry.status] += 1;
      const truncated = dropped.entries > 0 || dropped.dispatches > 0 || dropped.snapshots > 0;
      return structuredClone({
        header: runHeader,
        limits: bounds,
        truncation: {
          droppedEntries: dropped.entries,
          droppedDispatches: dropped.dispatches,
          droppedSnapshots: dropped.snapshots,
        },
        completeness: {
          counts,
          inProgress: counts["in-progress"],
          truncated,
          complete: counts["in-progress"] === 0 && !truncated,
        },
        gatewayIdentities: identities,
        capabilitySnapshots: snapshots,
        entries,
        dispatches,
      });
    },
  };
}

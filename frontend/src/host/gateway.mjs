// The one place that talks to the Application gateway.
//
// Everything the renderer ever learns about the connection comes from here, and
// only through the bounded summaries below: no endpoint, no port, no bearer.
//
// The kit client is handed in already verified (see kit.mjs); this module
// imports no kit file of its own. A verified kit is not a ready gateway:
// discovery, the expected workspace and capabilities are checked here, on
// every connection, and an unreachable gateway stays honestly unavailable.

import { AsyncLocalStorage } from "node:async_hooks";
import { ALLOWED_OPERATIONS, EXPECTED_CAPABILITIES, methodFor } from "./operations.mjs";
import { boundIdentity } from "./read-journal.mjs";

/** The ids a request carries, read from its body. Headers - the bearer - are never looked at. */
function requestIdentity(init) {
  try {
    const body = JSON.parse(init?.body);
    return {
      operationId: body?.operation?.operationId ?? null,
      requestId: body?.requestId ?? null,
      correlationId: body?.correlationId ?? null,
    };
  } catch {
    return { operationId: null, requestId: null, correlationId: null };
  }
}

export function createGateway({ kit, resolveDescriptor, expectedWorkspace, fetchImpl, journal = null }) {
  const kitClient = kit.client;

  // With a journal, every request that leaves this host is recorded at dispatch
  // and tied to the call that caused it, even when calls run in parallel. The
  // wrapper passes the request through unchanged and never retries.
  const calls = new AsyncLocalStorage();
  const baseFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const observedFetch = journal === null ? fetchImpl : async (url, init) => {
    const store = calls.getStore();
    const dispatch = journal.recordDispatch({
      localEntryId: store?.localEntryId ?? null, context: store?.context ?? null, ...requestIdentity(init),
    });
    try {
      const response = await baseFetch(url, init);
      journal.settleDispatch(dispatch, { httpStatus: response.status, transport: "responded" });
      return response;
    } catch (error) {
      journal.settleDispatch(dispatch, { transport: "failed" });
      throw error;
    }
  };

  /** Turns a thrown kit error into a bounded record. Stacks never cross the bridge. */
  function describeError(error) {
    if (error instanceof kitClient.ApplicationFrontendClientError) {
      const { reasonCode = null, operationId = null, status = null } = error.details ?? {};
      return { code: error.code, message: error.message, reasonCode, operationId, status };
    }
    return { code: "host_error", message: "The host could not complete the request" };
  }

  const client = new kitClient.ApplicationFrontendClient({
    resolveDescriptor,
    expectedWorkspace,
    ...(observedFetch === undefined ? {} : { fetchImpl: observedFetch }),
  });

  /** The descriptor this call will run against, or null when there is none. No request is made. */
  async function currentIdentity() {
    try {
      const identity = boundIdentity(await client.connect());
      journal?.noteIdentity(identity);
      return identity;
    } catch {
      return null;
    }
  }

  // What kind of entry a call makes in the journal, by the client method it uses.
  const ENTRY_KIND = Object.freeze({ read: "read", receipt: "receipt", mutate: "mutation", approve: "approval" });

  /** Connection identity only. Endpoint and authorization stay in this process. */
  async function connection({ force = false } = {}) {
    try {
      const descriptor = await client.connect({ force });
      return {
        available: true,
        projectId: descriptor.workspace?.projectId ?? null,
        sourceId: descriptor.workspace?.sourceId ?? null,
        descriptorId: descriptor.descriptorId,
        instanceId: descriptor.instance?.instanceId ?? null,
        generation: descriptor.instance?.generation ?? null,
        adapterVersion: descriptor.instance?.adapterVersion ?? null,
        publishedAtUtc: descriptor.publishedAtUtc,
        validUntilUtc: descriptor.validUntilUtc,
        exposedOperationCount: descriptor.exposedOperations.length,
        contractVersion: descriptor.contractVersion,
      };
    } catch (error) {
      return { available: false, error: describeError(error) };
    }
  }

  /** Per-operation availability, as the UI must gate every action on it. */
  async function availability({ force = false } = {}) {
    if (journal === null) return readAvailability({ force });
    return calls.run({ context: "capability-snapshot" }, async () => {
      const entries = await readAvailability({ force });
      journal.recordCapabilities(entries, await currentIdentity());
      return entries;
    });
  }

  async function readAvailability({ force = false } = {}) {
    const entries = [];
    let first = force;
    for (const operationId of Object.keys(ALLOWED_OPERATIONS)) {
      try {
        const status = await client.operationStatus(operationId, { forceDiscovery: first });
        first = false;
        entries.push({
          operationId,
          status: status.status,
          reasonCode: status.reasonCode ?? null,
        });
      } catch (error) {
        entries.push({
          operationId,
          status: "unavailable",
          reasonCode: describeError(error).code,
        });
      }
    }
    return entries;
  }

  /**
   * Whether discovery advertises what the desk is waiting for. Status only:
   * these operations are not allowlisted and `run` refuses every one of them.
   */
  async function expectedAvailability() {
    if (journal === null) return readExpected();
    return calls.run({ context: "expected-snapshot" }, readExpected);
  }

  async function readExpected() {
    const capabilities = [];
    for (const expected of EXPECTED_CAPABILITIES) {
      const operations = [];
      for (const operationId of expected.operations) {
        try {
          const status = await client.operationStatus(operationId, { forceDiscovery: false });
          const needed = expected.resourceKinds ?? [];
          const reaches = needed.every((kind) => (status.resourceKinds ?? []).includes(kind));
          // Available but unable to address the needed resource kind is not
          // support for this capability; say so instead of reporting it available.
          operations.push(status.status === "available" && !reaches
            ? { operationId, status: "unavailable", reasonCode: "resource_kind_not_advertised" }
            : { operationId, status: status.status, reasonCode: status.reasonCode ?? null });
        } catch (error) {
          operations.push({ operationId, status: "unavailable", reasonCode: describeError(error).code });
        }
      }
      const detectable = operations.length > 0;
      capabilities.push({
        capabilityId: expected.capabilityId,
        detectable,
        advertised: detectable && operations.every((entry) => entry.status === "available"),
        operations,
      });
    }
    return capabilities;
  }

  /**
   * The adapter discovery names for a provider-scoped operation, such as
   * "claude-code-sdk", or null when no provider is selectable for it.
   */
  async function providerOf(operationId) {
    try {
      const status = await client.operationStatus(operationId, { forceDiscovery: false });
      return status.status === "available" ? status.provider?.adapterId ?? null : null;
    } catch {
      return null;
    }
  }

  /**
   * The adapters among `adapterIds` that discovery offers for a provider-scoped
   * operation: with desk agents of several providers each is asked by name,
   * since an unnamed request is ambiguous.
   */
  async function providersOf(operationId, adapterIds) {
    const found = [];
    for (const adapterId of adapterIds) {
      try {
        const status = await client.operationStatus(operationId, { provider: { adapterId }, forceDiscovery: false });
        if (status.status === "available" && status.provider?.adapterId === adapterId) found.push(adapterId);
      } catch { /* not offered */ }
    }
    return found;
  }

  /**
   * Invokes one allowlisted operation. Result envelopes - including failed and
   * uncertain outcomes - are returned as data; the caller must not treat a
   * delivered envelope as success.
   */
  async function run(operationId, input = {}, { provider = null } = {}) {
    const method = methodFor(operationId);
    // A provider-scoped read may name the provider it is for (providersOf).
    const options = provider === null ? {} : { provider: { adapterId: String(provider.adapterId) } };
    if (method === null) {
      journal?.notAttempted(operationId, input, "operation_not_allowed");
      return { ok: false, error: { code: "operation_not_allowed", message: operationId } };
    }
    if (journal !== null) {
      const entry = journal.begin(operationId, input, { kind: ENTRY_KIND[method] ?? method });
      return calls.run({ localEntryId: entry.localEntryId }, async () => {
        const identity = await currentIdentity();
        try {
          const result = await client[method](operationId, input, options);
          journal.complete(entry, { identity, envelope: result });
          return { ok: true, result };
        } catch (error) {
          const described = describeError(error);
          journal.fail(entry, { identity, error: described });
          return { ok: false, error: described };
        }
      });
    }
    try {
      return { ok: true, result: await client[method](operationId, input, options) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  return {
    connection, availability, expectedAvailability, providerOf, providersOf, run, disconnect: () => client.disconnect(),
  };
}

// Values the compatibility tests and their worker processes share.

export const COUNTER_KEY = "concurrency-counter";

export const ARCHIVE_BINDING = Object.freeze({
  projectId: "controller", sourceId: "worker", providerId: "test", threadId: "shared-thread",
});

export function archiveRecord(recordId, text) {
  return { recordId, kind: "message", role: "assistant", state: "completed", text,
    providerTurnId: null, providerItemId: null, requestId: null, occurredAtUtc: null, omissions: [] };
}

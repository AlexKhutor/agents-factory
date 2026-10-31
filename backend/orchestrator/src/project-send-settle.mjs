import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { applicationCanonicalSha256 as hash } from "./application-contract.mjs";
import { createClaudeCodeSessionJournal } from "./claude-code-session-journal.mjs";
import { claudeTurnState } from "./claude-code-session-host.mjs";
import { gatewayRunning, ProjectPackageError } from "./project-package-export.mjs";
import { createFileProviderMutationLease, resolveProviderMutationProjectId } from "./provider-mutation-lease-store.mjs";

// A send whose outcome is uncertain and that has no turn keeps its agent busy,
// its project's folder taken and the provider lease (one per instance) held:
// nothing settled it (live check 2026-10-27). The person asks for a check in
// the trusted host, and the agent's session journal decides. A session host
// records a turn before it starts the provider's process, so no turn for the
// send means the message never went: the send failed and the lease is released
// not-applied. A turn for it means it went: the send gets that turn and the
// lease is released applied. Nothing is guessed; the Gateway is stopped, so
// nothing changes meanwhile. A receipt stays under .project-local/settle-receipts.

const AGENTS_KEY = "memory-agents-v1";
const JOURNAL_FOLDERS = Object.freeze({ claude: "claude-sessions", acp: "acp-sessions" });
const RECEIPTS = path.join(".project-local", "settle-receipts");
const TERMINAL = new Set(["completed", "failed", "interrupted"]);

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

/** The turn the session journal recorded for a send (its client message id), or null. */
async function turnOfSend(root, agent, operationId) {
  const folder = JOURNAL_FOLDERS[agent.binding?.providerId];
  if (folder === undefined || typeof agent.binding?.threadId !== "string") fail("settle_unsupported", agent.agentId);
  const journal = await createClaudeCodeSessionJournal({ controllerRoot: root, folder });
  const threadId = agent.binding.threadId;
  const session = await journal.readSession(threadId);
  if (session === null) return null;
  for (const id of session.turnIds) {
    const turn = await journal.readTurn(threadId, id);
    if (turn?.clientUserMessageId === operationId) return turn;
  }
  return null;
}

/**
 * Settles `operationId` of `agentId`, an uncertain send without a turn.
 * `confirm` must name the agent. Returns the receipt.
 */
export async function settleUncertainSend({ controllerRoot, store, agentId, operationId, confirm,
  now = () => new Date() }) {
  if (confirm !== agentId) fail("settle_confirmation_required", agentId);
  const root = await realpath(controllerRoot);
  if (await gatewayRunning(path.join(root, ".project-local", "application-gateway", "status.v1.json"))) {
    fail("gateway_running");
  }
  const catalog = await store.readDocument({ key: AGENTS_KEY });
  const agent = (catalog?.value?.agents ?? []).find((item) => item.agentId === agentId);
  if (agent === undefined) fail("settle_agent_not_found", agentId);
  const operation = agent.operations.find((item) => item.operationId === operationId);
  if (operation === undefined) fail("settle_operation_not_found", operationId);
  if (!["uncertain", "requested"].includes(operation.state) || agent.currentOperationId !== operationId) {
    fail("settle_not_uncertain", operationId);
  }
  if (operation.turnId) fail("settle_turn_known", operationId);

  const turn = await turnOfSend(root, agent, operationId);
  const threadId = agent.binding.threadId;
  const went = turn !== null;
  const state = went ? claudeTurnState(turn) : "failed";

  // The lease first: settling it again replays, so a failed catalog swap can be retried.
  const projectId = await resolveProviderMutationProjectId(root);
  const { lease, store: leases } = await createFileProviderMutationLease({ controllerRoot: root, projectId });
  const record = ((await leases.read(lease.storeKey))?.records ?? [])
    .find((item) => item.owner.operationId === operationId) ?? null;
  let leaseOutcome = null;
  if (record !== null && record.state !== "released") {
    const settled = await lease.reconcile({ owner: record.owner, intentSha256: record.intentSha256,
      leaseId: record.leaseId, outcome: went ? "applied" : "not-applied",
      receiptSha256: went ? hash({ threadId, turnId: turn.id }) : hash({ threadId, refused: "not_started" }) });
    leaseOutcome = settled.record?.outcome ?? (went ? "applied" : "not-applied");
  } else if (record !== null) {
    leaseOutcome = record.outcome;
  }

  const atUtc = now().toISOString();
  const next = structuredClone(catalog.value);
  const stored = next.agents.find((item) => item.agentId === agentId);
  const op = stored.operations.find((item) => item.operationId === operationId);
  if (went) {
    Object.assign(op, { turnId: turn.id, state: state === "unknown" ? "started" : state });
  } else {
    Object.assign(op, { state: "failed", problemCode: "memory_send_not_started" });
  }
  op.settledBy = "person";
  if (TERMINAL.has(op.state)) {
    op.settledAtUtc ??= atUtc;
    if (stored.currentOperationId === operationId) stored.currentOperationId = null;
  }
  if (!await store.compareAndSwapDocument({ key: AGENTS_KEY, expectedRevision: catalog.revision, value: next })) {
    fail("settle_contention");
  }

  const receipt = { schemaVersion: 1, agentId, projectId: agent.projectId, operationId, threadId,
    found: went ? { turnId: turn.id, status: turn.status } : null, operationState: op.state,
    leaseOutcome, causeCode: operation.causeCode ?? null, problemCode: operation.problemCode ?? null, settledAtUtc: atUtc };
  const file = path.join(root, RECEIPTS, `${atUtc.replace(/[-:.]/gu, "")}-${agentId.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { ...receipt, receipt: file };
}

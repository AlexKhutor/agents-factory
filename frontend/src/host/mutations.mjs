// Gateway mutations. Archiving, file saves and copies are behind a confirmation
// the person answered; creating, sending, answering and stopping are not - the
// button the person pressed is the decision.
//
// The rules encoded here, all from the delivery contract:
//   - the host mints and keeps the operation identity, so an ambiguous outcome
//     is reconciled through its receipt instead of being sent again;
//   - an uncertain outcome is never retried and never rendered as success;
//   - an interrupt carries the original SEND operation id, not a new one;
//   - an interaction response copies identity, owner and allowed choice from a
//     fresh read of the record: the window cannot invent any of them;
//   - the execution profile comes from the catalog, with fallback denied.

import { createHash, randomUUID } from "node:crypto";
import { tx } from "./i18n.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_TEXT = 16384;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 1_048_576;
const SAVE_SCHEMA = "application-project-workspace-save.v1.json";
const COPY_SCHEMA = "application-project-copy.schema.json";
const utf8Sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * A project path the backend could accept: relative, forward slashes, no empty,
 * "." or ".." segment, no control character, at most 256 characters. Anything
 * else is refused here, before a confirmation or a request.
 */
function publicPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) return false;
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function invalid(reasonCode, message) {
  return { ok: false, error: { code: "invalid_input", reasonCode, message } };
}

function declined() {
  return { ok: false, error: { code: "user_declined", reasonCode: "declined" } };
}

/** Turns one result envelope into a bounded outcome the renderer can trust. */
function outcomeOf(response, identity) {
  if (!response.ok) return { ...response, identity };
  const { result } = response;
  if (result.outcome === "succeeded" || result.outcome === "accepted") {
    return { ok: true, data: { outcome: result.outcome, output: result.output ?? null, identity } };
  }
  if (result.outcome === "uncertain") {
    return {
      ok: false,
      identity,
      error: {
        code: "uncertain_outcome",
        reasonCode: result.error?.code ?? "uncertain",
        message: "The outcome is unknown. It must be reconciled through its receipt, never sent again.",
      },
    };
  }
  return {
    ok: false,
    identity,
    // The reason is the backend's own public reasonCode when it gives one; the
    // phase is kept apart - it is not a reason, and a window showing
    // reasonCode || code must show the code then ("conflict", not "precondition").
    error: {
      code: result.error?.code ?? "failed", reasonCode: result.error?.reasonCode ?? null,
      phase: result.error?.phase ?? null, message: result.error?.message ?? "",
    },
  };
}

// Which gateway operation each mutation makes, and the kind of journal entry.
const OPERATION_OF = Object.freeze({
  createScope: ["mutation.memory.scope.create", "mutation"],
  createAgent: ["mutation.memory.agent.create", "mutation"],
  send: ["mutation.memory.agent.send", "mutation"],
  sendReceipt: ["receipt.memory.agent.send", "receipt"],
  respond: ["approval.agent-control.respond", "approval"],
  interrupt: ["mutation.agent-control.interrupt", "mutation"],
  closeAgent: ["mutation.memory.agent.close", "mutation"],
  saveProjectFile: ["mutation.project-workspace.save", "mutation"],
  resendProjectFileSave: ["mutation.project-workspace.save", "mutation"],
  copyProject: ["mutation.memory.project.copy", "mutation"],
  reconcileProjectCopy: ["mutation.memory.project.copy", "mutation"],
  steer: ["mutation.memory.agent.steer", "mutation"],
  unqueue: ["mutation.memory.agent.unqueue", "mutation"],
  setProfile: ["mutation.memory.agent.profile", "mutation"],
});

/**
 * A mutation refused here - invalid input, a declined confirmation - never
 * reached the gateway, so the gateway journal has no entry for it. It is
 * recorded as not attempted, with its reason, and without anything the person
 * typed: only identifiers from the input are bounded into the target.
 */
function journalRefusals(mutations, journal) {
  if (journal === null) return mutations;
  return Object.fromEntries(Object.entries(mutations).map(([name, run]) => [name, async (input = {}) => {
    const before = journal.serial();
    const result = await run(input);
    if (!result.ok && journal.serial() === before && OPERATION_OF[name] !== undefined) {
      const [operationId, kind] = OPERATION_OF[name];
      journal.notAttempted(operationId, input, result.error?.reasonCode ?? result.error?.code, { kind });
    }
    return result;
  }]));
}

export function createMutations({ gateway, confirm, journal = null, schemas = null }) {
  return journalRefusals(buildMutations({ gateway, confirm, schemas }), journal);
}

function buildMutations({ gateway, confirm, schemas }) {
  // Writes whose outcome is unknown, by the host-minted operation id: only these
  // may be reconciled, and only with the request exactly as it was sent.
  const unresolved = new Map();
  const schemaProblem = (file, definition, value) => {
    if (schemas === null) return "schemas_unavailable";
    const checked = schemas.check(file, definition, value);
    return checked.ok ? null : (checked.problems[0]?.keyword ?? "schema");
  };
  const uncertain = (identity, reasonCode) => ({
    ok: false, identity, error: { code: "uncertain_outcome", reasonCode, uncertain: true },
  });
  async function createScope({ kind, projectId, quarterId = null, title } = {}) {
    if (kind !== "project" && kind !== "quarter") return invalid("kind_invalid", "kind");
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (kind === "quarter" && (typeof quarterId !== "string" || !ID.test(quarterId))) {
      return invalid("quarter_id_invalid", "quarterId");
    }
    if (typeof title !== "string" || title.length < 1 || title.length > 512) {
      return invalid("title_invalid", "title");
    }
    const scopeId = kind === "project" ? `${projectId}-memory` : `${projectId}-${quarterId}-memory`;
    if (!ID.test(scopeId)) return invalid("scope_id_invalid", "scopeId");

    // A project and a feature are placed like buildings in a strategy game: at
    // once, without a confirmation. Nothing is lost by it - an unwanted one is
    // archived (trusted-actions.mjs, confirmed there) and can be restored.

    const identity = { operationId: `atlas-scope-${randomUUID()}`, scopeId };
    return outcomeOf(await gateway.run("mutation.memory.scope.create", {
      scopeId, kind, projectId, quarterId: kind === "project" ? null : quarterId,
      title, operationId: identity.operationId,
    }), identity);
  }

  async function createAgent({ agentId, projectId, quarterId, profile } = {}) {
    for (const [value, reason] of [[agentId, "agent_id_invalid"], [projectId, "project_id_invalid"],
      [quarterId, "quarter_id_invalid"]]) {
      if (typeof value !== "string" || !ID.test(value)) return invalid(reason, reason);
    }
    if (profile === null || typeof profile !== "object") return invalid("profile_invalid", "profile");
    const { provider, model, reasoningEffort } = profile;
    if ([provider, model, reasoningEffort].some((value) => typeof value !== "string" || !ID.test(value))) {
      return invalid("profile_invalid", "profile");
    }

    // Like a project and a feature, an agent is placed at once: creating it starts
    // no turn and spends no quota. The window checks its links - project and
    // feature memory, the project folder - before it offers the button; archiving
    // the agent (closeAgent) still confirms.

    const identity = { operationId: `atlas-agent-${randomUUID()}`, agentId };
    return outcomeOf(await gateway.run("mutation.memory.agent.create", {
      agentId, projectId, quarterId, operationId: identity.operationId,
      profile: { provider, model, reasoningEffort, fallbackPolicy: "deny" },
    }), identity);
  }

  async function send({ agentId, text } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
      return invalid("text_invalid", "text");
    }

    // No confirmation: the person pressed Send in the chat, as in Codex and
    // Claude Code. The send starts a provider turn that spends quota.
    // The identity is minted before the call and returned with every outcome,
    // so an ambiguous result is looked up, not repeated.
    const identity = { operationId: `atlas-send-${randomUUID()}`, agentId };
    return outcomeOf(await gateway.run("mutation.memory.agent.send", {
      agentId, operationId: identity.operationId, text,
    }), identity);
  }

  /**
   * A message while the agent works, as in Codex and Claude Code: `mode:
   * "steer"` hands it to the running turn at once, `mode: "queue"` holds it
   * for the turn's end. When nothing runs the backend sends it as an ordinary
   * message under the same identity, so the window can always use this.
   */
  async function steer({ agentId, text, mode } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (typeof text !== "string" || text.trim().length < 1 || text.length > MAX_TEXT) {
      return invalid("text_invalid", "text");
    }
    if (mode !== "steer" && mode !== "queue") return invalid("mode_invalid", "mode");
    const identity = { operationId: `atlas-send-${randomUUID()}`, agentId };
    return outcomeOf(await gateway.run("mutation.memory.agent.steer", {
      agentId, operationId: identity.operationId, text, mode,
    }), identity);
  }

  /** Takes back a message queued for the end of the turn (the steer's operation id). */
  async function unqueue({ agentId, operationId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (typeof operationId !== "string" || !ID.test(operationId)) return invalid("operation_id_invalid", "operationId");
    return outcomeOf(await gateway.run("mutation.memory.agent.unqueue", { agentId, operationId }),
      { agentId, operationId });
  }

  /**
   * The model and reasoning effort of the agent's next turns. The provider
   * stays the one the agent was created with; fallback stays denied.
   */
  async function setProfile({ agentId, provider, model, reasoningEffort } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    for (const [field, value] of [["provider", provider], ["model", model], ["reasoningEffort", reasoningEffort]]) {
      if (typeof value !== "string" || !ID.test(value)) return invalid(`${field}_invalid`, field);
    }
    return outcomeOf(await gateway.run("mutation.memory.agent.profile", {
      agentId, profile: { provider, model, reasoningEffort, fallbackPolicy: "deny" },
    }), { agentId });
  }

  async function sendReceipt({ agentId, operationId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (typeof operationId !== "string" || !ID.test(operationId)) {
      return invalid("operation_id_invalid", "operationId");
    }
    return outcomeOf(
      await gateway.run("receipt.memory.agent.send", { agentId, operationId }),
      { agentId, operationId },
    );
  }

  function providerResponseFor(record, selectedResponse, answers) {
    const method = record.providerRequest?.method;
    if (method === "item/commandExecution/requestApproval"
        || method === "item/fileChange/requestApproval") {
      return { ok: true, value: { decision: selectedResponse } };
    }
    if (method === "item/tool/requestUserInput") {
      const questions = record.display?.fields?.questions;
      if (!Array.isArray(questions)) return { ok: false, reasonCode: "questions_unavailable" };
      if (selectedResponse !== "submit-text") return { ok: false, reasonCode: "choice_invalid" };
      const value = { answers: {} };
      for (const question of questions) {
        const answer = answers?.[question.id];
        if (typeof answer !== "string" || answer.length < 1 || answer.length > 4096) {
          return { ok: false, reasonCode: "answer_missing" };
        }
        value.answers[question.id] = { answers: [answer] };
      }
      return { ok: true, value };
    }
    if (method === "item/permissions/requestApproval") {
      if (selectedResponse === "deny") return { ok: true, value: { permissions: {}, scope: "turn" } };
      if (selectedResponse === "grant") {
        const permissions = record.display?.fields?.permissions;
        if (permissions === undefined) return { ok: false, reasonCode: "permissions_unavailable" };
        // A grant equals the request exactly and stays turn-scoped.
        return { ok: true, value: { permissions, scope: "turn" } };
      }
      return { ok: false, reasonCode: "choice_invalid" };
    }
    if (selectedResponse === "accept") {
      return { ok: true, value: { action: "accept", content: record.display?.fields?.content ?? {} } };
    }
    if (selectedResponse === "decline" || selectedResponse === "cancel") {
      return { ok: true, value: { action: selectedResponse } };
    }
    return { ok: false, reasonCode: "choice_invalid" };
  }

  async function respond({ agentId, interactionId, selectedResponse, answers = null } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    if (typeof interactionId !== "string" || !ID.test(interactionId)) {
      return invalid("interaction_id_invalid", "interactionId");
    }

    // Always answer the record as it is now, not as the window last drew it.
    const fresh = await gateway.run("query.agent-control.interactions", { agentId, limit: 32 });
    if (!fresh.ok) return fresh;
    if (fresh.result.outcome !== "succeeded") {
      return { ok: false, error: { code: "interaction_unreadable", reasonCode: fresh.result.outcome } };
    }
    const record = (fresh.result.output?.records ?? [])
      .find((item) => item.interactionId === interactionId) ?? null;
    if (record === null) return invalid("interaction_unknown", "interactionId");
    if (record.state !== "awaiting-owner") {
      return {
        ok: false,
        error: {
          code: "interaction_not_pending", reasonCode: record.state,
          message: "A stale, expired or answered request cannot be revived.",
        },
      };
    }
    const allowed = record.interactionRequest?.allowedResponses;
    if (!Array.isArray(allowed) || !allowed.includes(selectedResponse)) {
      return invalid("choice_not_allowed", "selectedResponse");
    }
    const owner = record.interactionRequest?.owner;
    if (owner === null || typeof owner !== "object") return invalid("owner_unavailable", "operator");
    const payload = providerResponseFor(record, selectedResponse, answers);
    if (!payload.ok) return invalid(payload.reasonCode, "providerResponse");

    // No confirmation: choosing the answer in the window is the decision.
    // The response names the interaction request the backend recorded
    // (interactionRequest.requestSha256), not the provider's own request hash:
    // the Gateway compares that one, and a provider hash is refused as stale.
    const identity = {
      interactionId,
      responseId: `atlas-response-${randomUUID()}`,
      requestSha256: record.interactionRequest?.requestSha256 ?? null,
    };
    if (identity.requestSha256 === null) return invalid("request_hash_unavailable", "requestSha256");

    return outcomeOf(await gateway.run("approval.agent-control.respond", {
      agentId,
      response: {
        interactionId,
        requestSha256: identity.requestSha256,
        responseId: identity.responseId,
        operator: owner,
        selectedResponse,
        providerResponse: payload.value,
        respondedAtUtc: new Date().toISOString(),
      },
    }), identity);
  }

  async function interrupt({ agentId, operationId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    // This is the original send's operation id. A new id would not identify the
    // turn that has to stop.
    if (typeof operationId !== "string" || !ID.test(operationId)) {
      return invalid("operation_id_invalid", "operationId");
    }

    // No confirmation: stopping is what the Stop button says, as in Claude Code.
    return outcomeOf(
      await gateway.run("mutation.agent-control.interrupt", { agentId, operationId }),
      { agentId, operationId },
    );
  }

  async function closeAgent({ agentId } = {}) {
    if (typeof agentId !== "string" || !ID.test(agentId)) return invalid("agent_id_invalid", "agentId");
    const confirmed = await confirm({
      title: tx("Archive agent"),
      message: tx("Send agent “{agentId}” to the archive?", { agentId }),
      detail: tx("Archive finished work. The agent leaves the map, its conversation stays readable; the agent cannot be returned to work."),
      confirmLabel: tx("Archive"),
    });
    if (!confirmed) return declined();
    // The backend keeps the identity a close started with and refuses any other
    // (memory_identity_conflict), so one agent always gets the same one: a close
    // that stopped half-way - after a restart too - is finished by the next try.
    const operationId = `atlas-close-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
    return outcomeOf(await gateway.run("mutation.memory.agent.close", { agentId, operationId }),
      { agentId, operationId });
  }

  // --- project file save (Kit v0.16.1) ------------------------------------------------

  /**
   * Sends one save and judges it. Success needs a schema-valid receipt that
   * matches the request exactly: same project, path and operation, the hash
   * that was read as the previous one, and the hash of the text as the new one.
   * Anything less is not a success; an unknown outcome is remembered for
   * reconciliation and never sent again with a new operation id.
   */
  async function sendSave(input) {
    const identity = { operationId: input.operationId, projectId: input.projectId, path: input.path };
    const outcome = outcomeOf(await gateway.run("mutation.project-workspace.save", input), identity);
    if (!outcome.ok) {
      if (outcome.error.code === "uncertain_outcome") {
        unresolved.set(input.operationId, { kind: "save", input });
        return { ...outcome, error: { ...outcome.error, uncertain: true } };
      }
      return outcome;
    }
    const receipt = outcome.data.output;
    const matches = schemaProblem(SAVE_SCHEMA, "receipt", receipt) === null
      && receipt.projectId === input.projectId && receipt.path === input.path
      && receipt.operationId === input.operationId && receipt.previousSha256 === input.expectedSha256
      && receipt.contentSha256 === utf8Sha256(input.text)
      && receipt.bytesWritten === Buffer.byteLength(input.text, "utf8");
    if (!matches) {
      unresolved.set(input.operationId, { kind: "save", input });
      return uncertain(identity, "receipt_mismatch");
    }
    unresolved.delete(input.operationId);
    return { ok: true, data: { outcome: outcome.data.outcome, receipt, identity } };
  }

  async function saveProjectFile({ projectId, path: filePath, expectedSha256, text } = {}) {
    if (typeof projectId !== "string" || !ID.test(projectId)) return invalid("project_id_invalid", "projectId");
    if (!publicPath(filePath)) return invalid("path_not_public", "path");
    if (typeof expectedSha256 !== "string" || !HEX64.test(expectedSha256)) {
      return invalid("expected_sha256_invalid", "expectedSha256");
    }
    if (typeof text !== "string") return invalid("text_invalid", "text");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_FILE_BYTES) return invalid("file_too_large", "text");
    const input = { projectId, path: filePath, expectedSha256, text, operationId: `atlas-save-${randomUUID()}` };
    const problem = schemaProblem(SAVE_SCHEMA, "request", {
      schemaVersion: 1, contractVersion: "v0.1.0", operationId: "mutation.project-workspace.save", input,
    });
    if (problem !== null) return invalid(`schema_${problem}`, "input");

    const confirmed = await confirm({
      title: tx("Save project file"),
      message: tx("Save “{filePath}” in project “{projectId}”?", { filePath, projectId }),
      detail: tx("Replaces the version you read ({value}…) with {bytes} bytes. If the file changed after it was read, nothing is written, and your text stays in the editor.", { value: expectedSha256.slice(0, 12), bytes }),
      confirmLabel: tx("Save"),
    });
    if (!confirmed) return declined();
    return sendSave(input);
  }

  /**
   * Finds out, by reading the file, what became of a save whose outcome is
   * unknown. The backend does not replay a save by its operation id, so sending
   * it again would not tell: the file's current hash does.
   *   applied            - the file now holds exactly the text that was sent;
   *   not-applied        - it still holds the version the save was based on;
   *   changed-elsewhere  - it holds something else.
   */
  async function reconcileProjectFileSave({ operationId } = {}) {
    const known = typeof operationId === "string" ? unresolved.get(operationId) : undefined;
    if (known === undefined || known.kind !== "save") return invalid("reconcile_unknown", "operationId");
    const { input } = known;
    const identity = { operationId, projectId: input.projectId, path: input.path };
    const read = await gateway.run("query.project-workspace.read", {
      projectId: input.projectId, path: input.path, maximumBytes: 65_536,
    });
    if (!read.ok || read.result.outcome !== "succeeded") {
      const error = read.ok ? read.result.error : read.error;
      return { ok: false, identity, error: { code: error?.code ?? "read_failed", reasonCode: error?.reasonCode ?? null } };
    }
    const current = read.result.output?.contentSha256;
    const state = current === utf8Sha256(input.text) ? "applied"
      : current === input.expectedSha256 ? "not-applied" : "changed-elsewhere";
    // A reconciliation is a read and may be repeated; only the latest one decides
    // whether the unchanged request may be sent again.
    unresolved.set(operationId, { kind: "save", input, notApplied: state === "not-applied" });
    return { ok: true, data: { state, currentSha256: current, identity } };
  }

  /**
   * Sends a save whose reconciliation found it not applied, exactly as it was -
   * same operation id, same base hash, same text - after a new confirmation.
   * The base hash still guards it: if the file changed meanwhile, nothing is written.
   */
  async function resendProjectFileSave({ operationId } = {}) {
    const known = typeof operationId === "string" ? unresolved.get(operationId) : undefined;
    if (known === undefined || known.kind !== "save" || known.notApplied !== true) {
      return invalid("resend_not_reconciled", "operationId");
    }
    const { input } = known;
    const confirmed = await confirm({
      title: tx("Repeat the save"),
      message: tx("Send the unapplied save of “{path}” again?", { path: input.path }),
      detail: tx("The same request with the same operation ID ({operationId}). If the file changed after it was read, nothing is written.", { operationId }),
      confirmLabel: tx("Send again"),
    });
    if (!confirmed) return declined();
    return sendSave(input);
  }

  // --- atomic project copy with memory (Kit v0.16.1) ----------------------------------

  async function sendCopy(input, quarterIds) {
    const identity = { operationId: input.operationId, sourceProjectId: input.sourceProjectId,
      targetProjectId: input.targetProjectId };
    const outcome = outcomeOf(await gateway.run("mutation.memory.project.copy", input), identity);
    if (!outcome.ok) {
      if (outcome.error.code === "uncertain_outcome") {
        unresolved.set(input.operationId, { kind: "copy", input, quarterIds });
        return { ...outcome, error: { ...outcome.error, uncertain: true } };
      }
      return outcome;
    }
    const receipt = outcome.data.output;
    const targets = new Set([input.targetProjectScopeId, ...Object.values(input.quarterScopeIds)]);
    const matches = schemaProblem(COPY_SCHEMA, "receipt", receipt) === null
      && receipt.outcome === "complete" && receipt.operationId === input.operationId
      && receipt.sourceProjectId === input.sourceProjectId && receipt.targetProjectId === input.targetProjectId
      && receipt.scopes.length === targets.size
      && receipt.scopes.every((scope) => targets.has(scope.targetScopeId)
        && scope.targetRevision === 1 && scope.targetSha256 === scope.sourceSha256);
    if (!matches) {
      unresolved.set(input.operationId, { kind: "copy", input, quarterIds });
      return uncertain(identity, "receipt_mismatch");
    }
    unresolved.delete(input.operationId);
    return { ok: true, data: { outcome: outcome.data.outcome, receipt, identity, quarterIds } };
  }

  /**
   * Copies a project, all its quarters and their current memory in one atomic
   * operation. The quarters come from a fresh read of the backend catalog, not
   * from the window: the backend copies every quarter or nothing, and a
   * truncated catalog cannot name every quarter, so it is refused here.
   * Agents, bindings, provider sessions and history are never part of it.
   */
  async function copyProject({ sourceProjectId, targetProjectId } = {}) {
    if (typeof sourceProjectId !== "string" || !ID.test(sourceProjectId)) {
      return invalid("source_project_id_invalid", "sourceProjectId");
    }
    if (typeof targetProjectId !== "string" || !ID.test(targetProjectId) || targetProjectId === sourceProjectId) {
      return invalid("target_project_id_invalid", "targetProjectId");
    }
    const catalog = await gateway.run("query.memory.scopes.list", {});
    if (!catalog.ok || catalog.result.outcome !== "succeeded") {
      return { ok: false, error: { code: "catalog_unreadable", reasonCode: catalog.ok ? catalog.result.outcome : catalog.error?.code } };
    }
    const output = catalog.result.output;
    if (output.truncated === true) return invalid("catalog_truncated", "sourceProjectId");
    const scopes = output.scopes ?? [];
    if (!scopes.some((scope) => scope.kind === "project" && scope.projectId === sourceProjectId)) {
      return invalid("source_project_unknown", "sourceProjectId");
    }
    if (scopes.some((scope) => scope.projectId === targetProjectId)) return invalid("target_project_exists", "targetProjectId");
    const quarterIds = scopes.filter((scope) => scope.kind === "quarter" && scope.projectId === sourceProjectId)
      .map((scope) => scope.quarterId);
    const input = {
      sourceProjectId,
      targetProjectId,
      targetProjectScopeId: `${targetProjectId}-memory`,
      quarterScopeIds: Object.fromEntries(quarterIds.map((quarterId) => [quarterId, `${targetProjectId}-${quarterId}-memory`])),
      operationId: `atlas-copy-${randomUUID()}`,
    };
    const problem = schemaProblem(COPY_SCHEMA, "request", {
      schemaVersion: 1, contractVersion: "v0.1.0", operationId: "mutation.memory.project.copy", input,
    });
    if (problem !== null) return invalid(`schema_${problem}`, "input");

    const confirmed = await confirm({
      title: tx("Copy project with memory"),
      message: tx("Copy project “{sourceProjectId}” to “{targetProjectId}” together with its quarters ({length}) and their memory?", { sourceProjectId, targetProjectId, length: quarterIds.length }),
      detail: tx("One atomic operation: everything or nothing is copied. Agents, folder bindings, provider sessions and history are not copied."),
      confirmLabel: tx("Copy"),
    });
    if (!confirmed) return declined();
    return sendCopy(input, quarterIds);
  }

  /** Sends an unresolved copy again, unchanged: the backend answers a replay with its first result. */
  async function reconcileProjectCopy({ operationId } = {}) {
    const known = typeof operationId === "string" ? unresolved.get(operationId) : undefined;
    if (known === undefined || known.kind !== "copy") return invalid("reconcile_unknown", "operationId");
    const confirmed = await confirm({
      title: tx("Check the copy outcome"),
      message: tx("Ask again how copying “{sourceProjectId}” to “{targetProjectId}” ended?", { sourceProjectId: known.input.sourceProjectId, targetProjectId: known.input.targetProjectId }),
      detail: tx("The same request with the same operation ID ({operationId}); it cannot copy anything else.", { operationId }),
      confirmLabel: tx("Check"),
    });
    if (!confirmed) return declined();
    return sendCopy(known.input, known.quarterIds);
  }

  return {
    createScope, createAgent, send, sendReceipt, respond, interrupt, closeAgent,
    saveProjectFile, reconcileProjectFileSave, resendProjectFileSave, copyProject, reconcileProjectCopy,
    steer, unqueue, setProfile,
  };
}

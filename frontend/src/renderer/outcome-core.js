"use strict";

// What to tell the person after a confirmed change: where it stopped and
// with which identifiers. No DOM and no backend - so it is checked
// by tests without a window.
//
// A memory edit can stop in the window (an entry that cannot be sent),
// be declined by the person, run into a newer revision, fail inside the
// Gateway CLI or end with an unknown outcome. Each case is named in
// its own words; the identifiers of the attempt are always visible; what was not reported
// is called not reported, not printed as false or 0.

(function (root, factory) {
  const node = typeof module === "object" && module !== null && module.exports;
  const api = factory(node ? require("./i18n-core.js") : root);
  if (node) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis === "undefined" ? this : globalThis, function (i18n) {
  const { tx } = i18n;
  const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  const LIMITS = Object.freeze({ entries: 64, title: 512, text: 65536 });

  const PROBLEM_WORDS = Object.freeze({
    title_empty: tx("empty title"),
    title_too_long: tx("title longer than {title} characters", { title: LIMITS.title }),
    text_too_long: tx("text longer than {text} characters", { text: LIMITS.text }),
    id_invalid: tx("invalid entry ID"),
    id_duplicated: tx("duplicate entry ID"),
    too_many: tx("more than {entries} entries", { entries: LIMITS.entries }),
  });

  /** Entries that cannot be sent, with their number (from 1) and the reason. */
  function entryProblems(entries) {
    const problems = [];
    if (entries.length > LIMITS.entries) problems.push({ index: null, problem: "too_many" });
    const seen = new Set();
    entries.forEach((entry, position) => {
      const index = position + 1;
      const title = typeof entry.title === "string" ? entry.title : "";
      if (title.trim() === "") problems.push({ index, problem: "title_empty" });
      else if (title.length > LIMITS.title) problems.push({ index, problem: "title_too_long" });
      if (typeof entry.text === "string" && entry.text.length > LIMITS.text) {
        problems.push({ index, problem: "text_too_long" });
      }
      if (typeof entry.id !== "string" || !ENTRY_ID.test(entry.id)) problems.push({ index, problem: "id_invalid" });
      else if (seen.has(entry.id)) problems.push({ index, problem: "id_duplicated" });
      else seen.add(entry.id);
    });
    return problems;
  }

  const describeProblem = ({ index, problem }) =>
    tx("{value}: {value2}.", { value: index === null ? tx("The whole list") : tx("Item {index}", { index }), value2: PROBLEM_WORDS[problem] ?? problem });

  const identityLines = (identity) => (identity === null || identity === undefined ? [] : [
    tx("Operation: {value}.", { value: identity.operationId ?? tx("outcome-core::not reported") }),
    tx("Command: {value}.", { value: identity.commandId ?? tx("outcome-core::not reported") }),
  ]);

  /**
   * A refused memory save: tone - error, conflict, uncertain or note;
   * mayRetry - whether simply trying again is allowed (not after an unknown outcome).
   */
  function describeSaveFailure(error, identity = null) {
    const code = error?.code ?? "unknown";
    const reasonCode = error?.reasonCode ?? null;
    if (code === "user_declined") {
      return { tone: "note", mayRetry: true, title: tx("Not saved: confirmation declined."),
        details: [tx("Nothing was written.")] };
    }
    if (reasonCode === "stale_revision" || code === "stale_revision") {
      return { tone: "conflict", mayRetry: false,
        title: tx("The memory changed after it was read: nothing was overwritten."),
        details: [tx("Reread the memory and reconcile the versions yourself."), ...identityLines(identity)] };
    }
    if (code === "invalid_input") {
      return { tone: "error", mayRetry: true, title: tx("Not sent: the check before writing refused the edit."),
        details: [tx("Reason: {value}.", { value: reasonCode ?? tx("outcome-core::not reported") }), tx("Nothing was written.")] };
    }
    if (code === "cli_unavailable" && error?.uncertain === true) {
      return { tone: "uncertain", mayRetry: false,
        title: tx("Outcome unknown: the Gateway CLI did not answer; the write may have happened."),
        details: [
          tx("Reason: {value}.", { value: reasonCode ?? tx("outcome-core::not reported") }),
          tx("Reread the memory before saving again. Do not repeat the same edit under a new ID."),
          ...identityLines(identity),
        ] };
    }
    if (code === "cli_unavailable") {
      return { tone: "error", mayRetry: true, title: tx("The Gateway CLI did not start: nothing was written."),
        details: [tx("Reason: {value}.", { value: reasonCode ?? tx("outcome-core::not reported") }), ...identityLines(identity)] };
    }
    if (code === "cli_failed") {
      const persisted = error.diagnosticPersisted === true ? tx("saved on the backend side")
        : error.diagnosticPersisted === false ? tx("not saved on the backend side") : tx("whether it was saved is not reported");
      const reason = error.reason !== null && error.reason !== undefined ? error.reason
        : error.reasonOmitted === true ? tx("omitted: it came as free text") : tx("outcome-core::not reported");
      return { tone: "error", mayRetry: true,
        title: tx("Not saved: the Gateway CLI ended with an error ({value}).", { value: reasonCode ?? tx("reason not reported") }),
        details: [
          tx("CLI: exit code {value}, phase {value2}.", { value: error.exitCode ?? tx("outcome-core2::not reported"), value2: error.phase ?? tx("outcome-core::not reported") }),
          tx("Diagnostics: {value} ({persisted}).", { value: error.diagnosticId ?? tx("outcome-core::not reported"), persisted }),
          tx("Explanation: {reason}.", { reason }),
          ...identityLines(identity),
        ] };
    }
    return { tone: "error", mayRetry: true, title: tx("Not saved: {code}.", { code }),
      details: [tx("Reason: {value}.", { value: reasonCode ?? tx("outcome-core::not reported") }), ...identityLines(identity)] };
  }

  function describeSaveSuccess(data) {
    const receipt = data?.response ?? {};
    return {
      tone: "note",
      title: tx("Saved, revision {value}. The new memory applies from the next send.", { value: receipt.revision ?? tx("outcome-core::not reported") }),
      details: [
        ...identityLines(data?.identity),
        tx("Receipt: {value}{value2}.", { value: receipt.receiptId ?? tx("outcome-core::not reported"), value2: receipt.replay === true ? tx(" (a replay of the same edit)") : "" }),
      ],
    };
  }

  const PASTE_MODES = Object.freeze(["structure-only", "structure-and-memory"]);

  /**
   * Steps of pasting a blueprint. The mode is named explicitly: “structure-only” or
   * “structure-and-memory”; with no mode chosen there are no steps (null). Agents,
   * folder bindings and provider sessions are never copied (Kit v0.15.0) -
   * their steps are dropped. In the mode with memory, each new project or quarter
   * whose source has memory is followed by a step that moves
   * that memory.
   */
  function pasteSteps(steps, { mode }) {
    if (!PASTE_MODES.includes(mode)) return null;
    const out = [];
    for (const step of steps) {
      if (step.kind !== "project" && step.kind !== "quarter") continue;
      out.push(step);
      if (mode === "structure-and-memory" && step.part?.memoryScopeId) {
        out.push({
          kind: "memory", forStepId: step.id, sourceScopeId: step.part.memoryScopeId,
          label: tx("memory of {value} {id}", { value: step.kind === "project" ? tx("outcome-core::project") : tx("outcome-core::quarter"), id: step.id }),
        });
      }
    }
    return out;
  }

  /**
   * Pin the sources before the first write: every memory to be moved must
   * have its revision and content read. If even one source is not read,
   * the paste does not start - nothing is created or written yet.
   * `reads`: Map scopeId → { ok, revision, entries } or { ok: false, code }.
   */
  function pinSources(steps, reads) {
    const pinned = new Map();
    const problems = [];
    for (const step of steps) {
      if (step.kind !== "memory") continue;
      const read = reads.get(step.sourceScopeId);
      if (read === undefined || read.ok !== true || !Number.isSafeInteger(read.revision)) {
        problems.push({ scopeId: step.sourceScopeId, code: read?.code ?? "source_unread" });
        continue;
      }
      pinned.set(step.sourceScopeId, { revision: read.revision, entries: read.entries ?? [] });
    }
    return { ok: problems.length === 0, pinned, problems };
  }

  /**
   * The result of one paste step: what to write in its row and whether to go on.
   * There is no rollback - what was created stays created; so any step that
   * failed, was refused or ended with an unknown outcome stops
   * the paste, while an empty memory is an ordinary outcome.
   */
  function pasteStepVerdict(step, response) {
    if (step.kind === "memory") {
      if (response?.ok && response.empty === true) return { proceed: true, state: tx("empty — nothing to move") };
      if (response?.ok) {
        return { proceed: true, state: tx("moved, revision {value}", { value: response.data?.response?.revision ?? tx("outcome-core::not reported") }) };
      }
      const error = response?.error ?? {};
      if (error.code === "user_declined") return { proceed: false, state: tx("not moved: confirmation declined") };
      if (error.uncertain === true) return { proceed: false, state: tx("outcome unknown") };
      return { proceed: false, state: tx("not moved: {value}", { value: error.code ?? tx("error") }) };
    }
    if (response?.ok) return { proceed: true, state: tx("created") };
    const error = response?.error ?? {};
    if (error.code === "uncertain_outcome") return { proceed: false, state: tx("outcome unknown") };
    if (error.code === "user_declined") return { proceed: false, state: tx("not created: confirmation declined") };
    return { proceed: false, state: tx("not created") };
  }

  const CREATE_WORDS = Object.freeze({ project: tx("Project"), quarter: tx("Quarter"), agent: tx("Agent") });

  /**
   * The receipt of creating a project, quarter or agent: the exact target, the host operation
   * and the outcome. `reread` - whether to reread the world: after a success and after an unknown
   * outcome (to learn what happened), but not after a refusal before the write.
   */
  function describeCreateOutcome(kind, targetId, response) {
    const word = CREATE_WORDS[kind] ?? kind;
    const identity = response?.ok ? response.data?.identity : response?.identity;
    const operation = tx("Operation: {value}.", { value: identity?.operationId ?? tx("outcome-core::not reported") });
    if (response?.ok) {
      return { tone: "note", reread: true, title: tx("{word} {targetId} created.", { word, targetId }),
        details: [tx("Outcome: {value}.", { value: response.data?.outcome ?? tx("outcome-core2::not reported") }), operation] };
    }
    const error = response?.error ?? {};
    if (error.code === "user_declined") {
      return { tone: "note", reread: false, title: tx("Confirmation declined: nothing created."), details: [] };
    }
    if (error.code === "uncertain_outcome" || error.uncertain === true) {
      return { tone: "uncertain", reread: true,
        title: tx("Outcome unknown: {value} {targetId} may have been created.", { value: word.toLowerCase(), targetId }),
        details: [tx("The world is being reread; do not repeat the creation blindly."), operation] };
    }
    if (error.code === "invalid_input") {
      return { tone: "error", reread: false, title: tx("Not sent: the check before writing refused the target."),
        details: [tx("Reason: {value}.", { value: error.reasonCode ?? tx("outcome-core::not reported") })] };
    }
    // For an agent, a conflict almost always means a taken name: it stays with the agent in the archive too,
    // including in an archived quarter that the map does not show.
    const taken = kind === "agent" && error.code === "conflict"
      ? [tx("Most often this is a taken name: agent names are not reused, even after archiving. Choose another one.")]
      : [];
    return { tone: "error", reread: false, title: tx("{word} {targetId} not created: {value}.", { word, targetId, value: error.code ?? tx("error") }),
      details: [tx("Reason: {value}.", { value: error.reasonCode ?? tx("outcome-core::not reported") }), ...taken, operation] };
  }

  /**
   * The overall result of a step-by-step copy: complete, partial, unknown or
   * “nothing created”. What was created in a partial outcome stays and is not
   * deleted by itself; an unknown outcome is not repeated.
   */
  function pasteSummary(steps, { done, stoppedAt, uncertain }) {
    const total = steps.length;
    if (stoppedAt === null || stoppedAt === undefined) {
      return { outcome: "complete", title: tx("Result: complete — {done} of {total} done.", { done, total }), details: [] };
    }
    const at = steps[stoppedAt]?.label ?? tx("step {value}", { value: stoppedAt + 1 });
    if (uncertain) {
      return { outcome: "uncertain", title: tx("Result: unknown — the outcome at step “{at}” was not observed.", { at }),
        details: [tx("Done before it: {done} of {total}.", { done, total }), tx("The step is not repeated: first reread what happened.")] };
    }
    if (done === 0) {
      return { outcome: "none", title: tx("Result: nothing created — stopped at step “{at}”.", { at }), details: [] };
    }
    return { outcome: "partial", title: tx("Result: partial — {done} of {total} done, stopped at step “{at}”.", { done, total, at }),
      details: [tx("What was created stays and is not deleted by itself.")] };
  }

  const CONFIGURATION_WORDS = Object.freeze({
    local_config_missing: tx("Controller not configured: no config/local.json."),
    local_config_unparsable: tx("config/local.json cannot be read as JSON."),
    config_not_an_object: tx("config/local.json must be a JSON object."),
    controller_root_missing: tx("config/local.json does not set controllerRoot."),
    controller_root_not_absolute: tx("controllerRoot in config/local.json must be an absolute path."),
    expected_workspace_missing: tx("config/local.json has no expectedWorkspace."),
    expected_project_id_missing: tx("config/local.json does not set expectedWorkspace.projectId."),
    expected_workspace_hash_invalid: tx("expectedWorkspace.workspaceRootSha256 must be a SHA-256 (64 characters)."),
  });

  /**
   * The state of the one configured controller in the words of the window. No paths:
   * only the reason and what to do, or a safe identity. null - the mode
   * without a controller (the fixture).
   */
  function describeConfiguration(configuration) {
    if (configuration === null || configuration === undefined) return null;
    if (configuration.status === "loaded") {
      const expected = configuration.expectedWorkspace ?? {};
      return { tone: "note", title: tx("Controller configured: project {value}.", { value: expected.projectId ?? tx("outcome-core2::not reported") }),
        details: [tx("Root fingerprint: {value}…", { value: String(expected.workspaceRootSha256 ?? "").slice(0, 16) }),
          tx("One controller is set before launch; there is no switching in the window.")] };
    }
    const code = configuration.reasonCode ?? "unknown";
    return { tone: "error", title: CONFIGURATION_WORDS[code] ?? tx("Controller configuration refused: {code}.", { code }),
      details: [tx("Code: {code}.", { code }),
        tx("Fill in config/local.json after the example in config/local.example.json and restart the window.")] };
  }

  // Kit v0.16.1: the only public reasons a project folder cannot be read.
  const WORKSPACE_REASONS = Object.freeze({
    workspace_not_bound: tx("the project folder is not bound — bind it in the project inspector"),
    workspace_binding_conflict: tx("project folder binding conflict — the binding is ambiguous"),
    workspace_path_missing: tx("the bound folder is no longer on disk"),
  });

  /**
   * A refusal to read a project folder or file, in words. The reason is only one of the three
   * published ones; without it, or with any other one, the reason is unknown. Neither the path nor
   * the exception text is shown.
   */
  function describeWorkspaceRefusal(error) {
    const code = error?.code ?? "unknown";
    const reason = Object.hasOwn(WORKSPACE_REASONS, error?.reasonCode ?? "") ? WORKSPACE_REASONS[error.reasonCode] : null;
    return {
      tone: "error",
      title: reason === null ? tx("Unavailable ({code}): the reason is not reported — unknown.", { code }) : tx("Unavailable: {reason}.", { reason }),
      details: reason === null ? [tx("The backend did not name the reason; the desk does not guess it.")] : [tx("Code: {code} / {reasonCode}.", { code, reasonCode: error.reasonCode })],
    };
  }

  /**
   * The outcome of saving a file. keepDirty - the edit stays in the editor (after any
   * refusal and after an unknown outcome); reconcile - a check by reading the file is needed.
   */
  function describeSaveFileOutcome(response) {
    const identity = response?.ok ? response.data?.identity : response?.identity;
    const operation = tx("Operation: {value}.", { value: identity?.operationId ?? response?.data?.receipt?.operationId ?? tx("outcome-core::not reported") });
    if (response?.ok) {
      const receipt = response.data.receipt;
      return { tone: "note", keepDirty: false, reconcile: false,
        title: tx("Saved: {bytesWritten} bytes.", { bytesWritten: receipt.bytesWritten }),
        details: [tx("Operation: {operationId}.", { operationId: receipt.operationId }), tx("New fingerprint: {value}…", { value: String(receipt.contentSha256).slice(0, 16) })] };
    }
    const error = response?.error ?? {};
    if (error.code === "user_declined") {
      return { tone: "note", keepDirty: true, reconcile: false, title: tx("Confirmation declined: nothing was written."), details: [] };
    }
    if (error.code === "uncertain_outcome" || error.uncertain === true) {
      return { tone: "uncertain", keepDirty: true, reconcile: true,
        title: tx("Outcome unknown: the write may have happened."),
        details: [tx("Reason: {value}.", { value: error.reasonCode ?? tx("outcome-core::not reported") }), tx("The edit stays in the editor. Check by reading the file; do not repeat it blindly."), operation] };
    }
    if (error.code === "stale_revision" || error.code === "conflict") {
      return { tone: "conflict", keepDirty: true, reconcile: false,
        title: tx("The file changed after it was read: nothing was written."),
        details: [tx("The edit stays in the editor. Reread the file and decide whether to save over the new version."), operation] };
    }
    if (error.code === "invalid_input") {
      return { tone: "error", keepDirty: true, reconcile: false, title: tx("Not sent: refused by the check before writing."),
        details: [tx("Reason: {value}.", { value: error.reasonCode ?? tx("outcome-core::not reported") })] };
    }
    return { tone: "error", keepDirty: true, reconcile: false,
      title: tx("Not saved: {value}{value2}.", { value: error.code ?? tx("error"), value2: error.reasonCode ? ` (${error.reasonCode})` : "" }),
      details: [error.code === "access_denied"
        ? tx("The file is outside the project folder, is not UTF-8 text or is larger than 1 MB — the backend does not write it.")
        : tx("The edit stays in the editor."), operation] };
  }

  /**
   * Whether a file can be edited: only one read in full (the base hash is the hash of the whole
   * file) and only when the save operation is declared.
   */
  function canEditFile(pages, saveStatus) {
    const last = Array.isArray(pages) ? pages[pages.length - 1] : undefined;
    if (last === undefined) return { allowed: false, reason: tx("The file has not been read.") };
    if (last.nextCursor !== null || last.range.offsetBytes + last.range.returnedBytes < last.range.totalBytes) {
      return { allowed: false, reason: tx("Read the whole file first: only the whole file can be edited.") };
    }
    if (saveStatus === null || saveStatus === undefined) return { allowed: false, reason: tx("Whether saving is available has not been checked.") };
    if (saveStatus.status !== "available") {
      return { allowed: false, reason: tx("Saving is unavailable: {status}.", { status: saveStatus.reasonCode ?? saveStatus.status }) };
    }
    return { allowed: true, reason: null };
  }

  /**
   * The outcome of an atomic copy of a project with memory: a full copy with a receipt for each
   * memory, or “nothing created” (an atomic refusal - not a partial success),
   * or an unknown outcome, which is checked with the same request.
   */
  function describeCopyOutcome(response) {
    const identity = response?.ok ? response.data?.identity : response?.identity;
    if (response?.ok) {
      const receipt = response.data.receipt;
      return { outcome: "complete", reconcile: false,
        title: tx("Result: complete — project {targetProjectId} and its memories copied in one operation.", { targetProjectId: receipt.targetProjectId }),
        details: [tx("Operation: {operationId}.", { operationId: receipt.operationId }), ...receipt.scopes.map((scope) => (
          tx("{value}: {sourceScopeId} revision {sourceRevision} → {targetScopeId} revision {targetRevision}", { value: scope.kind === "project" ? tx("project") : tx("quarter {quarterId}", { quarterId: scope.quarterId }), sourceScopeId: scope.sourceScopeId, sourceRevision: scope.sourceRevision, targetScopeId: scope.targetScopeId, targetRevision: scope.targetRevision })))] };
    }
    const error = response?.error ?? {};
    if (error.code === "uncertain_outcome" || error.uncertain === true) {
      return { outcome: "uncertain", reconcile: true, title: tx("Result: unknown — the copy may have happened."),
        details: [tx("Operation: {value}.", { value: identity?.operationId ?? tx("outcome-core::not reported") }), tx("Check with the same request; a new copy is not sent.")] };
    }
    if (error.code === "user_declined") return { outcome: "none", reconcile: false, title: tx("Confirmation declined: nothing created."), details: [] };
    return { outcome: "none", reconcile: false,
      title: tx("Result: nothing was created — the copy was refused as a whole ({value}{value2}).", { value: error.code ?? tx("error"), value2: error.reasonCode ? `, ${error.reasonCode}` : "" }),
      details: [tx("The copy is atomic: on a refusal, neither the project nor the quarters appear.")] };
  }

  // --- ID of a new copy (U07): a suggestion the person can replace -------------------

  const COPY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

  /** A free suggested ID: “-copy” (and a number) is added to the original. */
  function freeIdentifier(base, taken) {
    let candidate = `${base}-copy`;
    let index = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-copy-${index}`;
      index += 1;
    }
    taken.add(candidate);
    return candidate;
  }

  /**
   * The paste plan: what will be created and where. The root of the new copy gets
   * `rootId` if the person chose it, otherwise the suggestion `…-copy`.
   * The nested quarters of the project get suggested IDs; agents
   * are listed only to be skipped. `taken` - the sets of taken
   * projects/quarters/agents; the function works on a copy of them.
   */
  function buildPastePlan(blueprint, target, taken, { rootId = null } = {}) {
    const used = {
      projects: new Set(taken.projects), quarters: new Set(taken.quarters), agents: new Set(taken.agents),
    };
    const steps = [];
    const agentSteps = (parts, projectId, quarterId) => {
      for (const part of parts) {
        const id = freeIdentifier(part.sourceId, used.agents);
        steps.push({ kind: "agent", id, projectId, quarterId, part, label: tx("agent {id}", { id }),
          node: { kind: "agent", projectId, quarterId, agentId: id } });
      }
    };
    if (blueprint.kind === "project") {
      const suggestedRootId = freeIdentifier(blueprint.root.sourceId, new Set(used.projects));
      const projectId = rootId ?? suggestedRootId;
      used.projects.add(projectId);
      steps.push({ kind: "project", id: projectId, part: blueprint.root, label: tx("project {projectId}", { projectId }),
        node: { kind: "project", projectId, quarterId: null, agentId: null } });
      for (const quarter of blueprint.root.children) {
        const quarterId = freeIdentifier(quarter.sourceId, used.quarters);
        steps.push({ kind: "quarter", id: quarterId, projectId, part: quarter, label: tx("quarter {quarterId}", { quarterId }),
          node: { kind: "quarter", projectId, quarterId, agentId: null } });
        agentSteps(quarter.children, projectId, quarterId);
      }
      return { steps, into: tx("into the world"), rootKind: "project", suggestedRootId, rootId: projectId, projectId };
    }
    if (blueprint.kind === "quarter") {
      const projectId = target.projectId ?? blueprint.sourceProjectId;
      if (projectId === null || projectId === undefined) return { steps: [], into: null };
      const suggestedRootId = freeIdentifier(blueprint.root.sourceId, new Set(used.quarters));
      const quarterId = rootId ?? suggestedRootId;
      used.quarters.add(quarterId);
      steps.push({ kind: "quarter", id: quarterId, projectId, part: blueprint.root, label: tx("quarter {quarterId}", { quarterId }),
        node: { kind: "quarter", projectId, quarterId, agentId: null } });
      agentSteps(blueprint.root.children, projectId, quarterId);
      return { steps, into: tx("into project {projectId}", { projectId }), rootKind: "quarter", suggestedRootId, rootId: quarterId, projectId };
    }
    const projectId = target.projectId ?? blueprint.sourceProjectId;
    const quarterId = target.quarterId ?? blueprint.sourceQuarterId;
    if (projectId === null || projectId === undefined || quarterId === null || quarterId === undefined) {
      return { steps: [], into: null };
    }
    agentSteps([blueprint.root], projectId, quarterId);
    return { steps, into: tx("into quarter {quarterId} of project {projectId}", { quarterId, projectId }), rootKind: "agent" };
  }

  /**
   * Whether the new copy can have this name. Empty, invalid by the identifier
   * contract, too long for the identifier of its memory, equal to the
   * source or already taken - a refusal before any write and before the confirmation.
   * The last guard against a race stays with the backend.
   */
  function validateCopyTarget({ value, kind, sourceId, projectId = null, taken }) {
    const id = typeof value === "string" ? value.trim() : "";
    const refuse = (reason, text) => ({ ok: false, reason, text, id });
    if (id === "") return refuse("empty", tx("Enter an ID for the new copy."));
    if (!COPY_ID.test(id)) {
      return refuse("invalid", tx("Invalid ID: a letter or digit first, then letters, digits, “.”, “_”, “:”, “-”, up to 160 characters."));
    }
    const scopeId = kind === "project" ? `${id}-memory` : `${projectId}-${id}-memory`;
    if (!COPY_ID.test(scopeId)) {
      return refuse("too_long", tx("Too long: the memory ID of the new copy ({length} characters) is over 160.", { length: scopeId.length }));
    }
    if (id === sourceId) return refuse("same_as_source", tx("Same as the source: the copy needs a new ID."));
    const pool = kind === "project" ? taken.projects : taken.quarters;
    if (pool.has(id)) return refuse("occupied", tx("ID {id} is already taken.", { id }));
    return { ok: true, reason: null, text: null, id };
  }

  // --- the world lead and desk agents ---------------------------------------------
  //
  // A contract task goes through steps: dispatched → accepted by the agent → plan → in progress →
  // report → accepted by code (deterministic acceptance of the report). The agent may not
  // take it (a refusal or a block on acceptance) - then there will be no report. The backend computes the step
  // (world-task-board.mjs, the stage field); here - only the words and the step bar.

  const TASK_STEPS = Object.freeze([
    ["dispatched", tx("dispatched")], ["accepted", tx("accepted")], ["planned", tx("plan")], ["in-progress", tx("in progress")],
    ["reported", tx("report")], ["accepted-by-code", tx("accepted by code")],
  ]);
  const STAGE_REACHED = Object.freeze({
    dispatched: 0, started: 0, accepted: 1, planned: 2, "in-progress": 3, reported: 4, "accepted-by-code": 5,
  });
  const REPORT_STATUS_WORDS = Object.freeze({ completed: tx("completed"), blocked: tx("blocked"), failed: tx("outcome-core::failed") });
  const DECISION_WORDS = Object.freeze({ rejected: tx("refused"), blocked: tx("outcome-core::blocked") });

  /**
   * The task's step bar, like the to-do list in Claude Code: steps passed - done,
   * the last one reached - current, the rest - todo. A task that was not taken
   * stops at the “accepted” step, marked declined.
   */
  function taskStageSteps(task) {
    if (task?.stage === "declined") {
      return TASK_STEPS.map(([id, label], index) => ({ id, label: index === 1 ? tx("outcome-core::not taken") : label,
        state: index === 0 ? "done" : index === 1 ? "declined" : "todo" }));
    }
    const reached = STAGE_REACHED[task?.stage] ?? 0;
    const finished = task?.stage === "accepted-by-code";
    return TASK_STEPS.map(([id, label], index) => ({ id, label,
      state: index < reached || (finished && index === reached) ? "done" : index === reached ? "current" : "todo" }));
  }

  /** One sentence about where the task is now - from what was read, without guesses. */
  function taskStateLine(task) {
    const now = task?.progress?.now ? `: ${task.progress.now}` : "";
    switch (task?.stage) {
      case "dispatched": return tx("Dispatched: the agent has the task package, but the task has not been started yet.");
      case "started": return tx("Started: the agent got the task and has not accepted it yet.");
      case "accepted": return tx("The agent accepted the task and is looking into it{value}", { value: now || "." });
      case "planned": return task.progress?.planStatus === "confirmed"
        ? tx("Plan confirmed: the agent is moving on to the work.")
        : tx("The plan is published and waiting for your confirmation in the agent chat.");
      case "in-progress": return tx("In progress{value}", { value: now || "." });
      case "reported": {
        const status = REPORT_STATUS_WORDS[task.report?.status] ?? task.report?.status ?? tx("status not reported");
        const summary = task.report?.summary ? ` — ${task.report.summary.replace(/[.!…\s]+$/u, "")}` : "";
        return tx("Report: {status}{summary}. Waiting for acceptance.", { status, summary });
      }
      case "accepted-by-code": return tx("Accepted by code: the report checks passed.");
      case "declined": {
        const decision = DECISION_WORDS[task.acknowledgement?.decision] ?? task.acknowledgement?.decision ?? tx("outcome-core::not taken");
        const reason = task.acknowledgement?.reason ?? null;
        return tx("The agent did not take the task ({decision}){value} There will be no report.", { decision, value: reason ? `: ${reason}` : "." });
      }
      default: return tx("Where the task is: not reported.");
    }
  }

  // Refusals of a desk agent registration (memory CLI register-desk-source) - in words.
  const DESK_REGISTRATION_REFUSALS = Object.freeze({
    user_declined: tx("Nothing was done: the confirmation was declined."),
    memory_agent_closed: tx("Only an open agent takes tasks, and this one is archived or not fully created yet."),
    memory_agent_not_found: tx("There is no such agent in the backend catalog."),
    memory_workspace_required: tx("The agent's project has no folder bound: a desk agent works in the folder of its project. Bind it in the project HQ."),
    memory_workspace_conflict: tx("The agent's project folder changed or is gone from the disk: registration not done."),
    memory_invalid_input: tx("The backend did not accept the agent name: registration not done."),
    desk_source_registration_busy: tx("The controller is registering another agent right now. Try again in a minute: nothing was changed."),
    controller_registry_incompatible: tx("The controller's source registry (config/source-registry.json) is of another version: registration not done."),
    duplicate_source_id: tx("This source is recorded twice in the controller's source registry. Fix config/source-registry.json by hand."),
    desk_source_conflict: tx("This agent's source is already recorded in the controller registry with other settings: registration does not overwrite it."),
    desk_source_binding_conflict: tx("This agent's source is already bound on this machine to another folder (.project-local/source-bindings.json): registration does not overwrite that binding."),
    desk_source_folder_conflict: tx("Another controller source already occupies this agent's coordination folder."),
    desk_source_record_conflict: tx("The coordination folder records another agent or another project: registration does not overwrite it."),
    desk_source_kit_install_failed: tx("The task set did not install into the coordination folder. The registry entry stays: registering again continues from the same place."),
    desk_source_root_invalid: tx("The host passed an invalid folder to the controller: registration not done."),
    desk_source_agent_invalid: tx("The host passed an invalid agent name to the controller: registration not done."),
    invalid_argument: tx("The host and the controller disagree on the agent name: registration not done."),
    invalid_input: tx("The agent name failed the check before sending: nothing was done."),
    desk_agents_not_supported: tx("This Atlas mode has no desk agents: they work only with the controller on Claude Code."),
  });
  const DESK_SOURCE_CHECK = /^desk_source_(route_mismatch|agent_missing|paths_mismatch|contract_mismatch|record_mismatch|missing_file|linked_path|invalid_file|invalid_document)$/u;

  /** The outcome of a desk agent registration: tone - note, error or uncertain, text - a sentence for the person. */
  function describeDeskRegistration(response) {
    if (response?.ok) {
      const source = response.data?.sourceId ?? tx("its source");
      return response.data?.status === "already-registered"
        ? { tone: "note", text: tx("The agent already takes tasks ({source}): the task set was checked and its missing parts installed.", { source }) }
        : { tone: "note", text: tx("The agent takes tasks: source {source}. The world lead can now give it tasks.", { source }) };
    }
    const error = response?.error ?? {};
    if (error.code === "cli_unavailable" && error.uncertain === true) {
      return { tone: "uncertain", text: tx("The controller did not answer in time: registration outcome unknown. Refresh the details: ")
        + tx("if the agent is not registered, the registration can be repeated - it does not create anything twice.") };
    }
    if (error.code === "cli_unavailable") {
      return { tone: "error", text: tx("Trusted actions are unavailable ({value}): registration not done.", { value: error.reasonCode ?? tx("no code") }) };
    }
    const reason = error.reasonCode ?? error.code ?? null;
    if (reason !== null && DESK_REGISTRATION_REFUSALS[reason] !== undefined) {
      return { tone: error.code === "user_declined" ? "note" : "error", text: DESK_REGISTRATION_REFUSALS[reason] };
    }
    if (error.code !== undefined && DESK_REGISTRATION_REFUSALS[error.code] !== undefined) {
      return { tone: "error", text: DESK_REGISTRATION_REFUSALS[error.code] };
    }
    if (reason !== null && DESK_SOURCE_CHECK.test(reason)) {
      return { tone: "error", text: tx("The task set is installed, but the source failed the check ({reason}): tasks will not reach the agent yet.", { reason }) };
    }
    return { tone: "error", text: tx("Registration not done: the controller refused with code «{value}».", { value: reason ?? tx("no code") }) };
  }

  /**
   * What to show about an agent's tasks and whether to offer “Take tasks”: only
   * to an open agent that is not the world lead, and while it is not registered. `board` - the task
   * board (null - not read yet, { failed } - not read, with a reason).
   */
  function deskRegistrationState(agent, board) {
    if (board === null || board === undefined) return { kind: "unknown", offer: false, sourceId: null, text: tx("checking…") };
    if (board.failed) {
      return { kind: "unknown", offer: false, sourceId: null, text: tx("outcome-core::not checked: {value}", { value: board.reason ?? tx("no code") }) };
    }
    const source = (board.sources ?? []).find((item) => item.agentId === agent?.agentId) ?? null;
    if (source !== null && source.valid) {
      return { kind: "registered", offer: false, sourceId: source.sourceId, text: tx("yes · source {sourceId}", { sourceId: source.sourceId }) };
    }
    const role = agent?.settings?.role ?? null;
    if (role === "coordinator") {
      return { kind: "not-applicable", offer: false, sourceId: null, text: tx("no: the world lead gives out tasks, it does not take them") };
    }
    if (agent?.state === "archived" || agent?.state === "closing") {
      return { kind: "not-applicable", offer: false, sourceId: source?.sourceId ?? null,
        text: source === null ? tx("no: the agent is archived") : tx("registered ({sourceId}), but the agent is archived", { sourceId: source.sourceId }) };
    }
    if (agent?.state !== "active") {
      return { kind: "not-applicable", offer: false, sourceId: null, text: tx("no: the agent is not ready yet ({value})", { value: agent?.state ?? tx("state not reported") }) };
    }
    if (source !== null) {
      return { kind: "invalid", offer: true, sourceId: source.sourceId,
        text: tx("registered ({sourceId}), but the coordination folder fails the check: tasks will not reach it", { sourceId: source.sourceId }) };
    }
    return { kind: "offer", offer: true, sourceId: null, text: tx("no") };
  }

  // Refusals on the “Create world lead…” path - in words.
  const WORLD_LEAD_REFUSALS = Object.freeze({
    user_declined: tx("Nothing was done: the confirmation was declined."),
    world_folder_conflict: tx("The world project “world” is bound to another folder, while the world lead works only in the controller folder. Nothing was changed."),
    memory_workspace_conflict: tx("The world project “world” is bound to another folder, while the world lead works only in the controller folder. Nothing was changed."),
    memory_role_taken: tx("The world lead already exists: the controller has only one coordinator. This agent did not get the role."),
    memory_revision_conflict: tx("The agent's settings changed in the meantime: the role was not assigned. Refresh the map and assign it again."),
    memory_agent_closed: tx("The agent is archived: it cannot become the world lead."),
    memory_agent_not_found: tx("There is no such agent in the backend catalog: the role was not assigned."),
    world_flow_expired: tx("The confirmation expired (over 15 minutes) or was already used: confirm creating the world lead again."),
    invalid_input: tx("The agent name failed the check before sending: nothing was done."),
    world_lead_not_supported: tx("This Atlas mode has no world lead: it works only with the controller on Claude Code."),
  });

  /** Why a world lead step did not go through - as a sentence, with the code only as an explanation. */
  function describeWorldLeadRefusal(error) {
    const reason = error?.reasonCode ?? error?.code ?? null;
    if (error?.code === "user_declined") return WORLD_LEAD_REFUSALS.user_declined;
    if (error?.code === "cli_unavailable" && error?.uncertain === true) {
      return tx("The controller did not answer in time: outcome unknown. Refresh the map and see what is already done - do not repeat it blindly.");
    }
    if (error?.code === "cli_unavailable") {
      return tx("Trusted actions are unavailable ({value}): nothing was done.", { value: error.reasonCode ?? tx("no code") });
    }
    if (reason !== null && WORLD_LEAD_REFUSALS[reason] !== undefined) return WORLD_LEAD_REFUSALS[reason];
    if (error?.code !== undefined && WORLD_LEAD_REFUSALS[error.code] !== undefined) return WORLD_LEAD_REFUSALS[error.code];
    return tx("Not done: the controller refused with code «{value}».", { value: reason ?? tx("no code") });
  }

  return {
    TASK_STEPS, taskStageSteps, taskStateLine, describeDeskRegistration, deskRegistrationState,
    describeWorldLeadRefusal,
    freeIdentifier, buildPastePlan, validateCopyTarget,
    describeWorkspaceRefusal, describeSaveFileOutcome, canEditFile, describeCopyOutcome,
    entryProblems, describeProblem, describeSaveFailure, describeSaveSuccess, pasteSteps, pasteStepVerdict,
    pinSources, PASTE_MODES, LIMITS, describeCreateOutcome, pasteSummary, describeConfiguration,
  };
}));

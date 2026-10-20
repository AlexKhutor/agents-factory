// What a person is told after a confirmed change: where it stopped and with
// which identifiers - never a bare code.
//
// A memory edit can stop in the window (an entry that cannot be sent), be
// declined, conflict with a newer revision, fail inside the Gateway CLI, or end
// without a known outcome. Each is said differently, the identifiers of the
// attempt are always shown, and what was not reported is said to be not
// reported rather than printed as false or 0.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../src/renderer/outcome-core.js");

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};
const text = (described) => [described.title, ...described.details].join(" | ").toLowerCase();
const identity = { operationId: "atlas-memory-1", commandId: "atlas-command-1" };

{
  const problems = core.entryProblems([
    { id: "a", title: "Rules", text: "ok" },
    { id: "entry-2", title: "", text: "" },
    { id: "a", title: "Duplicate", text: "" },
    { id: "bad id", title: "x", text: "" },
  ]);
  check("check-names-entry-number-and-reason",
    problems.length === 3
      && problems[0].index === 2 && problems[0].problem === "title_empty"
      && problems[1].index === 3 && problems[1].problem === "id_duplicated"
      && problems[2].index === 4 && problems[2].problem === "id_invalid"
      && core.entryProblems([{ id: "a", title: "t", text: "" }]).length === 0,
    problems);
}

{
  const described = core.describeSaveFailure({
    code: "cli_failed", reasonCode: "store_write_failed", exitCode: 1, diagnosticId: "diag-7",
    diagnosticPersisted: true, phase: "execution", reason: "disk_full", reasonOmitted: false,
  }, identity);
  const all = text(described);
  check("cli-failure-shows-boundary-and-diagnostics",
    described.tone === "error" && all.includes("store_write_failed") && all.includes("exit code 1")
      && all.includes("execution") && all.includes("diag-7") && all.includes("saved")
      && all.includes("disk_full") && all.includes("atlas-memory-1") && all.includes("atlas-command-1"),
    described);
}

{
  const described = core.describeSaveFailure({
    code: "cli_failed", reasonCode: "application_gateway_failed", exitCode: 1, diagnosticId: null,
    diagnosticPersisted: null, phase: null, reason: null, reasonOmitted: true,
  }, identity);
  const all = text(described);
  check("unreported-called-unreported-not-false",
    all.includes("not reported") && all.includes("omitted") && !all.includes("false") && !all.includes("null"),
    described);
}

{
  const described = core.describeSaveFailure({ code: "cli_unavailable", reasonCode: "timeout", uncertain: true },
    identity);
  check("cli-timeout-is-unknown-outcome",
    described.tone === "uncertain" && text(described).includes("may have") && described.mayRetry === false,
    described);
  const notStarted = core.describeSaveFailure({ code: "cli_unavailable", reasonCode: "spawn_failed" }, identity);
  check("cli-not-started-wrote-nothing",
    notStarted.tone === "error" && text(notStarted).includes("nothing was written"), notStarted);
}

{
  const stale = core.describeSaveFailure({ code: "cli_failed", reasonCode: "stale_revision", exitCode: 1 }, identity);
  const declined = core.describeSaveFailure({ code: "user_declined" }, null);
  const local = core.describeSaveFailure({ code: "invalid_input", reasonCode: "entry_title_invalid" }, null);
  check("conflict-decline-and-local-check-differ",
    stale.tone === "conflict" && text(stale).includes("reread")
      && declined.tone === "note" && text(declined).includes("nothing was written")
      && local.tone === "error" && text(local).includes("before writing"),
    { stale, declined, local });
}

{
  const described = core.describeSaveSuccess({
    response: { status: "written", revision: 3, receiptId: "r-1", replay: false },
    identity: { operationId: "atlas-memory-1", commandId: "atlas-command-1" },
  });
  check("success-names-revision-and-identifiers",
    text(described).includes("revision 3") && text(described).includes("atlas-memory-1")
      && text(described).includes("atlas-command-1") && text(described).includes("r-1"),
    described);
}

// --- pasting a blueprint: memory is moved before the agents ------------------------

{
  // An agent gets the memory of its project and quarter when it is created. So memory
  // is moved right after the step it belongs to and before the agents, not at the end.
  const part = (sourceId, memoryScopeId) => ({ sourceId, memoryScopeId });
  const steps = [
    { kind: "project", id: "p-copy", part: part("p", "p-memory") },
    { kind: "quarter", id: "q-copy", projectId: "p-copy", part: part("q", "p-q-memory") },
    { kind: "agent", id: "a-copy", part: { sourceId: "a" } },
    { kind: "quarter", id: "empty-copy", projectId: "p-copy", part: part("empty", null) },
  ];
  // Kit v0.15.0: bindings, agents and provider sessions are never copied.
  const withMemory = core.pasteSteps(steps, { mode: "structure-and-memory" })
    .map((step) => `${step.kind}:${step.id ?? step.forStepId}`);
  const structureOnly = core.pasteSteps(steps, { mode: "structure-only" }).map((step) => `${step.kind}:${step.id}`);
  check("memory-moved-after-its-step-agents-not-copied",
    JSON.stringify(withMemory) === JSON.stringify([
      "project:p-copy", "memory:p-copy", "quarter:q-copy", "memory:q-copy", "quarter:empty-copy",
    ]) && JSON.stringify(structureOnly) === JSON.stringify(["project:p-copy", "quarter:q-copy", "quarter:empty-copy"]),
    { withMemory, structureOnly });
}

{
  // Each step decides whether to go on. A memory move that was declined, that
  // failed or that ended with an unknown outcome stops the paste: otherwise
  // the agents would get the wrong memory. Empty memory is not an error.
  const verdict = core.pasteStepVerdict;
  const cases2 = {
    created: verdict({ kind: "project" }, { ok: true, data: { outcome: "succeeded" } }),
    uncertainCreate: verdict({ kind: "agent" }, { ok: false, error: { code: "uncertain_outcome" } }),
    memoryEmpty: verdict({ kind: "memory" }, { ok: true, empty: true }),
    memorySaved: verdict({ kind: "memory" }, { ok: true, data: { response: { revision: 2 } } }),
    memoryDeclined: verdict({ kind: "memory" }, { ok: false, error: { code: "user_declined" } }),
    memoryStopped: verdict({ kind: "memory" }, { ok: false, error: { code: "cli_unavailable", uncertain: true } }),
  };
  check("paste-step-decides-whether-to-go-on",
    cases2.created.proceed && cases2.created.state === "created"
      && !cases2.uncertainCreate.proceed && cases2.uncertainCreate.state === "outcome unknown"
      && cases2.memoryEmpty.proceed && cases2.memoryEmpty.state === "empty — nothing to move"
      && cases2.memorySaved.proceed && cases2.memorySaved.state === "moved, revision 2"
      && !cases2.memoryDeclined.proceed && cases2.memoryDeclined.state === "not moved: confirmation declined"
      && !cases2.memoryStopped.proceed && cases2.memoryStopped.state === "outcome unknown",
    cases2);
}

// --- S1: creation receipts, the copy's overall outcome, configuration words ------------

{
  // Creating a project, a feature or an agent leaves a receipt: exact target,
  // the host's operation id and the outcome. An unknown outcome is not retried
  // and a declined one created nothing.
  const done = core.describeCreateOutcome("project", "p-1", {
    ok: true, data: { outcome: "succeeded", identity: { operationId: "atlas-scope-1", scopeId: "p-1-memory" } },
  });
  const uncertain = core.describeCreateOutcome("agent", "a-1", {
    ok: false, error: { code: "uncertain_outcome" }, identity: { operationId: "atlas-agent-1" },
  });
  const declined = core.describeCreateOutcome("quarter", "q-1", { ok: false, error: { code: "user_declined" } });
  const refused = core.describeCreateOutcome("project", "p-2", {
    ok: false, error: { code: "invalid_input", reasonCode: "project_id_invalid" },
  });
  // An agent's name stays with it in the archive: the backend's conflict is explained.
  const nameTaken = core.describeCreateOutcome("agent", "studio-lead", {
    ok: false, error: { code: "conflict", reasonCode: null }, identity: { operationId: "atlas-agent-2" },
  });
  check("taken-agent-name-explained",
    nameTaken.tone === "error" && text(nameTaken).includes("taken name") && text(nameTaken).includes("atlas-agent-2"),
    nameTaken);
  check("creation-leaves-receipt-and-honest-refusal",
    done.tone === "note" && text(done).includes("p-1") && text(done).includes("atlas-scope-1")
      && text(done).includes("succeeded") && done.reread === true
      && uncertain.tone === "uncertain" && text(uncertain).includes("atlas-agent-1") && text(uncertain).includes("not repeat")
      && uncertain.reread === true
      && declined.tone === "note" && text(declined).includes("nothing created") && declined.reread === false
      && refused.tone === "error" && text(refused).includes("project_id_invalid") && text(refused).includes("before writing"),
    { done, uncertain, declined, refused });
}

{
  const steps = [{ label: "project p" }, { label: "memory of project p" }, { label: "quarter q" }, { label: "memory of quarter q" }];
  const full = core.pasteSummary(steps, { done: 4, stoppedAt: null, uncertain: false });
  const partial = core.pasteSummary(steps, { done: 2, stoppedAt: 2, uncertain: false });
  const unknown = core.pasteSummary(steps, { done: 1, stoppedAt: 1, uncertain: true });
  const none = core.pasteSummary(steps, { done: 0, stoppedAt: 0, uncertain: false });
  check("copy-result-complete-or-partial",
    full.outcome === "complete" && text(full).includes("4 of 4")
      && partial.outcome === "partial" && text(partial).includes("2 of 4") && text(partial).includes("quarter q")
      && text(partial).includes("not deleted")
      && unknown.outcome === "uncertain" && text(unknown).includes("not repeat")
      && none.outcome === "none" && text(none).includes("nothing created"),
    { full, partial, unknown, none });
}

{
  // One controller, configured before start. The window names what is wrong and
  // what to do, shows the safe identity when it is right, and never a path.
  const missing = core.describeConfiguration({ status: "missing", reasonCode: "local_config_missing" });
  const relative = core.describeConfiguration({ status: "invalid", reasonCode: "controller_root_not_absolute" });
  const loaded = core.describeConfiguration({
    status: "loaded", expectedWorkspace: { projectId: "Agents_Factory_Control", workspaceRootSha256: "ab".repeat(32) },
  });
  const fixture = core.describeConfiguration(null);
  check("configuration-error-clear-identity-without-paths",
    missing.tone === "error" && text(missing).includes("config/local.json") && text(missing).includes("local.example.json")
      && relative.tone === "error" && text(relative).includes("absolute")
      && loaded.tone === "note" && text(loaded).includes("agents_factory_control") && text(loaded).includes("abababab")
      && !/[a-z]:\\|\\\\|\/users\//i.test(text(loaded)) && fixture === null,
    { missing, relative, loaded, fixture });
}

// --- S1 finalize: file refusals, save and copy outcomes, when editing is allowed ---------

{
  const refusal = core.describeWorkspaceRefusal;
  const notBound = refusal({ code: "source_unavailable", reasonCode: "workspace_not_bound" });
  const conflict = refusal({ code: "source_unavailable", reasonCode: "workspace_binding_conflict" });
  const missing = refusal({ code: "source_unavailable", reasonCode: "workspace_path_missing" });
  const unknown = refusal({ code: "source_unavailable" });
  const other = refusal({ code: "source_unavailable", reasonCode: "E:\\secret\\path" });
  check("three-folder-refusal-reasons-and-unknown",
    text(notBound).includes("not bound") && text(conflict).includes("conflict")
      && text(missing).includes("no") && text(unknown).includes("unknown")
      && text(other).includes("unknown") && !text(other).includes("secret"),
    { notBound, conflict, missing, unknown, other });
}

{
  const save = core.describeSaveFileOutcome;
  const saved = save({ ok: true, data: { receipt: { operationId: "atlas-save-1", bytesWritten: 12, contentSha256: "ab".repeat(32) } } });
  const stale = save({ ok: false, error: { code: "stale_revision" }, identity: { operationId: "atlas-save-2" } });
  const denied = save({ ok: false, error: { code: "access_denied" }, identity: { operationId: "atlas-save-3" } });
  const lost = save({ ok: false, error: { code: "uncertain_outcome", reasonCode: "receipt_mismatch" }, identity: { operationId: "atlas-save-4" } });
  const declined = save({ ok: false, error: { code: "user_declined" } });
  check("save-outcome-does-not-lose-the-edit",
    saved.tone === "note" && !saved.keepDirty && text(saved).includes("atlas-save-1") && text(saved).includes("12")
      && stale.tone === "conflict" && stale.keepDirty && !stale.reconcile && text(stale).includes("changed")
      && denied.tone === "error" && denied.keepDirty && text(denied).includes("access_denied")
      && lost.tone === "uncertain" && lost.keepDirty && lost.reconcile && text(lost).includes("atlas-save-4")
      && declined.keepDirty && text(declined).includes("nothing was written"),
    { saved, stale, denied, lost, declined });
}

{
  const can = core.canEditFile;
  const whole = [{ range: { offsetBytes: 0, returnedBytes: 10, totalBytes: 10 }, nextCursor: null }];
  const part = [{ range: { offsetBytes: 0, returnedBytes: 10, totalBytes: 20 }, nextCursor: "c" }];
  const available = { status: "available" };
  check("only-a-whole-file-with-declared-operation-is-editable",
    can(whole, available).allowed && !can(part, available).allowed && text({ title: can(part, available).reason, details: [] }).includes("the whole file")
      && !can(whole, { status: "unavailable", reasonCode: "unsupported_capability" }).allowed
      && !can(whole, null).allowed,
    { whole: can(whole, available), part: can(part, available) });
}

{
  const copy = core.describeCopyOutcome;
  const receipt = { outcome: "complete", operationId: "atlas-copy-1", targetProjectId: "t", scopes: [
    { kind: "project", quarterId: null, sourceScopeId: "s-memory", targetScopeId: "t-memory", sourceRevision: 2, targetRevision: 1 },
    { kind: "quarter", quarterId: "q1", sourceScopeId: "s-q1-memory", targetScopeId: "t-q1-memory", sourceRevision: 3, targetRevision: 1 },
  ] };
  const done = copy({ ok: true, data: { receipt } });
  const refused = copy({ ok: false, error: { code: "conflict" }, identity: { operationId: "atlas-copy-2" } });
  const lost = copy({ ok: false, error: { code: "uncertain_outcome" }, identity: { operationId: "atlas-copy-3" } });
  check("copy-outcome-complete-atomic-refusal-or-reconcile",
    done.outcome === "complete" && text(done).includes("t-q1-memory") && text(done).includes("revision 3")
      && refused.outcome === "none" && text(refused).includes("nothing created") && !text(refused).includes("partial")
      && lost.outcome === "uncertain" && lost.reconcile && text(lost).includes("atlas-copy-3"),
    { done, refused, lost });
}

// --- S4 (U07): the ID of a new copy is chosen by the person before confirmation ---------

{
  const part = (sourceId, children = []) => ({ sourceId, memoryScopeId: `${sourceId}-memory`, children, annotation: {} });
  const project = { kind: "project", root: part("src", [part("q1", [part("a1")]), part("q2")]), sourceProjectId: "src" };
  const quarter = { kind: "quarter", root: part("q1", [part("a1")]), sourceProjectId: "src", sourceQuarterId: "q1" };
  const taken = () => ({ projects: new Set(["src", "other"]), quarters: new Set(["q1", "q2"]), agents: new Set(["a1"]) });

  const suggested = core.buildPastePlan(project, {}, taken());
  const exact = core.buildPastePlan(project, {}, taken(), { rootId: "codex-r2-s4-copy-target-20260926" });
  const exactQuarter = core.buildPastePlan(quarter, { projectId: "other" }, taken(), { rootId: "q-exact" });
  check("suggested-id-replaced-by-exact",
    suggested.steps[0].id === "src-copy" && suggested.suggestedRootId === "src-copy"
      && exact.steps[0].id === "codex-r2-s4-copy-target-20260926"
      && exact.steps[0].node.projectId === "codex-r2-s4-copy-target-20260926"
      && exact.steps.filter((step) => step.kind === "quarter").every((step) => step.projectId === "codex-r2-s4-copy-target-20260926")
      && exactQuarter.steps[0].id === "q-exact" && exactQuarter.steps[0].projectId === "other"
      && exactQuarter.into.includes("other"),
    { suggested: suggested.steps.map((step) => step.id), exact: exact.steps.map((step) => step.id),
      exactQuarter: exactQuarter.steps.map((step) => step.id) });

  const verdict = (value, kind = "project", projectId = null) => core.validateCopyTarget({
    value, kind, sourceId: kind === "project" ? "src" : "q1", projectId, taken: taken(),
  });
  const results = {
    empty: verdict("  "), invalid: verdict("bad id!"), same: verdict("src"), occupied: verdict("other"),
    long: verdict("x".repeat(155)), quarterSame: verdict("q1", "quarter", "other"), quarterOccupied: verdict("q2", "quarter", "other"),
    ok: verdict(" codex-r2-s4-copy-target-20260926 "), quarterOk: verdict("q-exact", "quarter", "other"),
  };
  check("empty-invalid-same-as-source-taken-id-refused",
    results.empty.ok === false && results.empty.reason === "empty"
      && results.invalid.reason === "invalid" && results.same.reason === "same_as_source"
      && results.occupied.reason === "occupied" && results.long.reason === "too_long"
      && results.quarterSame.reason === "same_as_source" && results.quarterOccupied.reason === "occupied"
      && results.ok.ok === true && results.ok.id === "codex-r2-s4-copy-target-20260926"
      && results.quarterOk.ok === true && typeof results.occupied.text === "string",
    results);
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "outcomes",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

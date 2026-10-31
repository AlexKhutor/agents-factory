// Evidence of read-only acceptance: what the host really asked the gateway.
//
// A run's evidence has to say which reads went out, to what, with which ids the
// kit returned and how they ended - and it must not dress a refusal before the
// network up as a request, fill ids in, leak a secret or overwrite an earlier
// package. Everything here runs on the development fixture; nothing is live.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";
import { createGateway } from "../src/host/gateway.mjs";
import { CHANNEL_NAMES, createChannels } from "../src/host/ipc.mjs";
import { ALLOWED_OPERATIONS } from "../src/host/operations.mjs";
import { collectRunHeader, createReadJournal } from "../src/host/read-journal.mjs";
import { exportEvidence } from "../src/host/evidence-export.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const kitSession = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
const { createDevGateway } = await import("../src/dev/dev-gateway.mjs");
const fixture = createDevGateway({ kit: kitSession.kit });
const secret = (await fixture.resolveDescriptor()).descriptor;

// The test's own view of the wire, independent of the journal under test.
const wire = [];
const spyFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  wire.push({ operationId: body.operation.operationId, requestId: body.requestId });
  return fixture.fetchImpl(url, init);
};

const header = await collectRunHeader({
  projectRoot: PROJECT_ROOT, mode: "dev-fixture", delivery: kitSession.delivery,
  expectedWorkspace: fixture.workspace,
});
const journal = createReadJournal({ header });
const gateway = createGateway({
  kit: kitSession.kit, resolveDescriptor: fixture.resolveDescriptor,
  expectedWorkspace: fixture.workspace, fetchImpl: spyFetch, journal,
});
const scratch = await mkdtemp(path.join(os.tmpdir(), "atlas-evidence-"));
const channels = createChannels({
  session: { mode: "dev-fixture", fixture: true, gateway, journal, delivery: kitSession.delivery },
  appVersion: "test",
  chooseEvidenceDirectory: async () => ({ ok: true, data: { path: scratch } }),
});
const connection = await gateway.connection();
const entries = () => journal.snapshot().entries;
const last = () => entries()[entries().length - 1];
const ownDispatches = (entry) => journal.snapshot().dispatches
  .filter((item) => item.localEntryId === entry.localEntryId && item.operationId === entry.operationId);

// --- a successful read ----------------------------------------------------------------

const scopes = await gateway.run("query.memory.scopes.list", {});
const scopeId = scopes.result.output.scopes[0].scopeId;
const scopeRead = await channels["atlas:scope-read"]({ scopeId });
{
  const entry = last();
  const output = scopeRead.result.output;
  check("successful-read-with-kit-id-and-run-binding",
    entry.status === "success" && entry.operationId === "query.memory.scope.read"
      && entry.runId === journal.runId && /^local-\d{4}$/.test(entry.localEntryId)
      && entry.target.scopeId === scopeId
      && entry.requestId === scopeRead.result.requestId
      && entry.correlationId === scopeRead.result.correlationId
      && entry.identity.descriptorId === connection.descriptorId
      && entry.identity.generation === connection.generation
      && entry.identity.validUntilUtc === connection.validUntilUtc
      && entry.facts.revision === output.revision && entry.facts.entryCount === output.entries.length
      && typeof entry.startedAtUtc === "string" && typeof entry.completedAtUtc === "string"
      && ownDispatches(entry).length === 1 && ownDispatches(entry)[0].requestId === entry.requestId,
    { entry, dispatches: ownDispatches(entry) });
}

// --- a failed read, through the new bridge channel ----------------------------------

const missing = await channels["atlas:agent-read"]({ agentId: "no-such-agent" });
{
  const entry = last();
  check("failed-read-with-kit-id-and-code",
    missing.ok === true && missing.result.outcome === "failed"
      && entry.status === "failure" && entry.operationId === "query.memory.agent.read"
      && entry.envelopeOutcome === "failed"
      && entry.requestId === missing.result.requestId && entry.correlationId === missing.result.correlationId
      && entry.error.code === "source_unavailable" && !("message" in entry.error)
      && ownDispatches(entry).length === 1,
    entry);
}

// --- refusals before the network ----------------------------------------------------

{
  const before = wire.length;
  const invalid = await channels["atlas:agent-read"]({ agentId: "../outside" });
  const invalidEntry = last();
  const notAllowed = await gateway.run("query.provider.threads.list", {});
  const notAllowedEntry = last();
  const downGateway = createGateway({
    kit: kitSession.kit,
    resolveDescriptor: async () => ({ status: "unavailable", reasonCode: "lifecycle_uncertain" }),
    expectedWorkspace: fixture.workspace, fetchImpl: spyFetch, journal,
  });
  const down = await downGateway.run("query.memory.agents.list", {});
  const downEntry = last();
  const refused = [invalidEntry, notAllowedEntry, downEntry];
  check("refusal-before-network-not-passed-off-as-request",
    invalid.ok === false && notAllowed.ok === false && down.ok === false
      && refused.every((entry) => entry.status === "not-attempted"
        && entry.requestId === null && entry.correlationId === null && ownDispatches(entry).length === 0)
      && invalidEntry.reasonCode === "invalid_input" && invalidEntry.target.agentId === null
      && notAllowedEntry.reasonCode === "operation_not_allowed"
      && downEntry.reasonCode === "descriptor_unavailable" && downEntry.identity === null
      && wire.length === before,
    { refused, wireGrew: wire.length - before });
}

// --- agent.read reachable through the bridge; nothing else opened ------------------

{
  const bridge = await readFile(path.join(PROJECT_ROOT, "src", "preload", "bridge.cjs"), "utf8");
  const exposed = new Map([...bridge.matchAll(/^\s*(\w+): call\("(atlas:[a-z-]+)"\)/gm)]
    .map((match) => [match[1], match[2]]));
  const bridged = new Set(exposed.values());
  const handled = new Set(Object.keys(channels));
  const named = new Set(CHANNEL_NAMES);
  const mutationChannels = ["atlas:bind-workspace", "atlas:rebind-workspace", "atlas:set-permission-mode", "atlas:init-project-git", "atlas:save-memory", "atlas:create-scope",
    "atlas:create-agent", "atlas:send", "atlas:send-receipt", "atlas:respond", "atlas:interrupt",
    "atlas:close-agent", "atlas:save-project-file", "atlas:reconcile-file-save", "atlas:resend-file-save",
    "atlas:copy-project", "atlas:reconcile-project-copy", "atlas:steer", "atlas:unqueue", "atlas:set-profile",
    "atlas:settle-send"];
  const allowed = Object.keys(ALLOWED_OPERATIONS).sort();
  check("agent-read-via-bridge-and-nothing-more",
    exposed.get("agentRead") === "atlas:agent-read" && exposed.get("exportEvidence") === "atlas:evidence-export"
      && [...bridged].every((channel) => named.has(channel) && handled.has(channel))
      && [...named].every((channel) => bridged.has(channel) && handled.has(channel))
      && [...named].filter((channel) => /create|send|respond|interrupt|close|bind|save-memory|save-project-file|file-save|copy-project|project-copy|steer|unqueue|set-profile|set-permission-mode|init-project-git/.test(channel))
        .sort().join() === [...mutationChannels].sort().join()
      // 28 since Kit v0.21.0: steer, unqueue, profile and the trace read; no provider mutation is allowed.
      && allowed.length === 28 && !allowed.some((id) => id.startsWith("mutation.provider."))
      && !/invoke|operationId/.test([...exposed.keys()].join()),
    { exposed: Object.fromEntries(exposed), named: [...named] });
}

// --- export: new folder per run, bounded, no secrets, no overwrite ------------------

const archive = await channels["atlas:agent-archive"]({ agentId: "core-scheduler-1", limit: 5 });
const exported = await channels["atlas:evidence-export"]({});
{
  const folder = path.join(scratch, journal.runId);
  const files = exported.ok ? (await readdir(folder)).sort() : [];
  const text = exported.ok ? await readFile(path.join(folder, "evidence.json"), "utf8") : "";
  const sums = exported.ok ? await readFile(path.join(folder, "SHA256SUMS"), "utf8") : "";
  const archiveTexts = archive.result.output.items
    .map((item) => item.record.text).filter((value) => typeof value === "string" && value.length > 8);
  const memoryText = scopeRead.result.output.entries[0].text;
  const evidence = text === "" ? null : JSON.parse(text);
  check("export-to-new-run-folder-without-secrets",
    exported.ok === true && exported.data.runId === journal.runId
      && JSON.stringify(files) === JSON.stringify(["SHA256SUMS", "evidence.json"])
      && sums.includes(sha256(text)) && exported.data.sumsSha256 === sha256(sums)
      && !text.includes(secret.authorization.bearerToken) && !text.includes(secret.endpoint.authority)
      && !text.includes(memoryText) && archiveTexts.every((value) => !text.includes(value))
      && !/"stack"|Bearer /.test(text)
      && evidence.header.runId === journal.runId && evidence.header.mode === "dev-fixture"
      && evidence.header.delivery.lockSha256 === kitSession.delivery.lockSha256
      && evidence.completeness.inProgress === 0 && evidence.completeness.truncated === false
      && Array.isArray(evidence.capabilitySnapshots) && Array.isArray(evidence.dispatches),
    { exported, files, archiveTexts: archiveTexts.length });

  const again = await channels["atlas:evidence-export"]({});
  const unchanged = exported.ok && sha256(await readFile(path.join(folder, "evidence.json"), "utf8")) === sha256(text);
  check("repeated-export-does-not-overwrite",
    again.ok === false && again.error.code === "evidence_exists" && unchanged, again);
}

// --- export refuses unsafe or unwritable targets, and says so -----------------------

{
  const missingBase = await exportEvidence({ journal, baseDirectory: path.join(scratch, "no-such-folder") });
  const junction = path.join(scratch, "junction");
  const real = path.join(scratch, "real");
  await writeFile(path.join(scratch, "plain-file"), "x");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(real);
  let linked = true;
  try { await symlink(real, junction, "junction"); } catch { linked = false; }
  const viaLink = linked ? await exportEvidence({ journal, baseDirectory: junction }) : null;
  const intoFile = await exportEvidence({ journal, baseDirectory: path.join(scratch, "plain-file") });
  const realAfter = await readdir(real);
  check("export-reports-refusal-and-write-error",
    missingBase.ok === false && intoFile.ok === false
      && (viaLink === null || (viaLink.ok === false && viaLink.error.code === "evidence_path_reparse"))
      && realAfter.length === 0 && linked,
    { missingBase, viaLink, intoFile, linked });
}

// --- truncation and unfinished calls are visible -------------------------------------

{
  const small = createReadJournal({ header, limits: { maxEntries: 2 } });
  small.notAttempted("query.memory.agents.list", {}, "descriptor_unavailable");
  small.notAttempted("query.memory.agents.list", {}, "descriptor_unavailable");
  small.notAttempted("query.memory.agents.list", {}, "descriptor_unavailable");
  small.begin("query.memory.scopes.list", {});
  const view = small.snapshot();
  const base = await mkdtemp(path.join(os.tmpdir(), "atlas-evidence-small-"));
  const out = await exportEvidence({ journal: small, baseDirectory: base });
  const written = out.ok ? JSON.parse(await readFile(path.join(base, small.runId, "evidence.json"), "utf8")) : null;
  check("truncation-and-unfinished-call-visible",
    view.entries.length === 2 && view.truncation.droppedEntries === 2
      && view.completeness.inProgress === 1 && view.completeness.complete === false
      && view.completeness.truncated === true
      && out.ok === true && out.data.complete === false
      && written.completeness.complete === false && written.entries.some((entry) => entry.status === "in-progress"),
    { view: { truncation: view.truncation, completeness: view.completeness }, out });
  await rm(base, { recursive: true, force: true });
}

// --- the diagnostics never write and never retry -------------------------------------

{
  const attempted = entries().filter((entry) => entry.status === "success" || entry.status === "failure");
  const reads = wire.filter((item) => item.operationId !== "discovery.application.capabilities");
  check("diagnostics-without-changes-and-without-retries",
    wire.every((item) => !/^(mutation|approval)\./.test(item.operationId))
      && attempted.every((entry) => ownDispatches(entry).length === 1)
      && reads.length === attempted.length,
    { wire, attempted: attempted.map((entry) => entry.operationId) });
}

// --- changes are journalled too: mutations and trusted actions -----------------------
//
// A separate journal and gateway, so the read-only checks above keep their own
// run. Mutations carry the operation id the host minted; an unknown outcome is
// "uncertain", not a failure; a trusted action that never reached the CLI is
// "not-attempted"; the text of a send never reaches the journal.

{
  const { createMutations } = await import("../src/host/mutations.mjs");
  const { createTrustedActions } = await import("../src/host/trusted-actions.mjs");
  const { callPath } = await import("../src/host/read-journal.mjs");
  const { mkdir, copyFile } = await import("node:fs/promises");
  const changes = createReadJournal({ header });
  const changeWire = [];
  const changeGateway = createGateway({
    kit: kitSession.kit, resolveDescriptor: fixture.resolveDescriptor, expectedWorkspace: fixture.workspace,
    fetchImpl: async (url, init) => {
      changeWire.push(JSON.parse(init.body).operation.operationId);
      return fixture.fetchImpl(url, init);
    },
    journal: changes,
  });
  const mutations = createMutations({ gateway: changeGateway, confirm: async () => true, journal: changes });
  const secretText = "secret task text";

  const created = await callPath.run("ui-ipc", () => mutations.createScope({
    kind: "project", projectId: "evidence-change-project", title: "Evidence",
  }));
  const createEntry = changes.snapshot().entries.find((entry) => entry.operationId === "mutation.memory.scope.create");
  check("change-journaled-with-operation-id",
    created.ok === true && createEntry !== undefined && createEntry.entryKind === "mutation"
      && createEntry.status === "success" && createEntry.mutationOperationId === created.data.identity.operationId
      && createEntry.requestId !== null && createEntry.via === "ui-ipc"
      && createEntry.facts?.scopeId === created.data.identity.scopeId,
    { created, createEntry });

  const sent = await mutations.send({ agentId: "core-scheduler-2", text: secretText });
  const sendEntry = changes.snapshot().entries.find((entry) => entry.operationId === "mutation.memory.agent.send");
  check("unknown-change-outcome-is-uncertain-not-refusal",
    sendEntry?.status === "uncertain" && sendEntry.envelopeOutcome === "uncertain"
      && sendEntry.via === "host-direct" && sendEntry.mutationOperationId === (sent.identity ?? sent.data?.identity)?.operationId,
    { sent, sendEntry });

  const refused = await mutations.send({ agentId: "../bad", text: "x" });
  const refusedEntry = changes.snapshot().entries.at(-1);
  check("change-refusal-before-network-not-passed-off-as-call",
    refused.ok === false && refusedEntry.status === "not-attempted" && refusedEntry.entryKind === "mutation"
      && refusedEntry.operationId === "mutation.memory.agent.send" && refusedEntry.requestId === null,
    refusedEntry);

  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-evidence-cli-"));
  await mkdir(path.join(root, ".orchestrator", "runtime"), { recursive: true });
  await mkdir(path.join(root, ".project-local"), { recursive: true });
  await copyFile(path.join(PROJECT_ROOT, "src", "dev", "fake-gateway-cli.mjs"),
    path.join(root, ".orchestrator", "runtime", "application-gateway-cli.mjs"));
  const trustedFor = (answer) => createTrustedActions({
    config: { controllerRoot: root, gatewayCli: {
      nodeExecutable: "node", scriptRelativePath: ".orchestrator/runtime/application-gateway-cli.mjs" } },
    confirm: async () => answer, chooseDirectory: async () => null, journal: changes,
  });
  const entries = [{ id: "rules", title: "Rules", text: "Memory body that must not reach the journal." }];
  const saved = await trustedFor(true).saveMemoryEdit({ scopeId: "evidence-scope", expectedRevision: 1, entries, actorId: "atlas-test" });
  const failed = await trustedFor(true).saveMemoryEdit({
    scopeId: "atlas-dev-fixture-cli-diagnostic", expectedRevision: 1, entries, actorId: "atlas-test" });
  const declined = await trustedFor(false).saveMemoryEdit({ scopeId: "evidence-scope", expectedRevision: 2, entries, actorId: "atlas-test" });
  const trusted = changes.snapshot().entries.filter((entry) => entry.entryKind === "trusted-action");
  const [ok, bad, no] = trusted;
  check("trusted-action-journaled-with-outcome-and-diagnostics",
    saved.ok && trusted.length === 3
      && ok.status === "success" && ok.mutationOperationId === saved.data.identity.operationId
      && ok.commandId === saved.data.identity.commandId && ok.facts?.revision === 2 && ok.target.scopeId === "evidence-scope"
      && bad.status === "failure" && bad.error.code === "cli_failed" && typeof bad.error.diagnosticId === "string"
      && bad.error.phase === "execution" && bad.commandId === failed.identity.commandId
      && no.status === "not-attempted" && no.reasonCode === "user_declined" && declined.ok === false,
    trusted);

  const snapshot = changes.snapshot();
  const text = JSON.stringify(snapshot);
  const connectionNow = await changeGateway.connection();
  check("gateway-identity-in-header-and-no-texts",
    snapshot.gatewayIdentities.length === 1 && snapshot.gatewayIdentities[0].descriptorId === connectionNow.descriptorId
      && typeof snapshot.gatewayIdentities[0].firstSeenUtc === "string"
      && !text.includes(secretText) && !text.includes("must not reach") && !text.includes(secret.authorization.bearerToken),
    { identities: snapshot.gatewayIdentities });
  await rm(root, { recursive: true, force: true });
}

await rm(scratch, { recursive: true, force: true });

// --- S1: long runs, descriptor renewal, one configured controller -----------------------

{
  // A long run with "watch" on records the same capability statuses over and
  // over. Identical consecutive snapshots are one snapshot with a count, so the
  // package is not marked incomplete for dropping duplicates.
  const journal = createReadJournal({ header: { mode: "live" } });
  const statuses = [{ operationId: "query.memory.scopes.list", status: "available", reasonCode: null }];
  for (let index = 0; index < 30; index += 1) journal.recordCapabilities(statuses, { descriptorId: "d1" });
  journal.recordCapabilities([{ ...statuses[0], status: "unavailable", reasonCode: "descriptor_expired" }], { descriptorId: "d1" });
  const snapshot = journal.snapshot();
  check("identical-capability-snapshots-do-not-flood-journal",
    snapshot.capabilitySnapshots.length === 2 && snapshot.capabilitySnapshots[0].seenCount === 30
      && typeof snapshot.capabilitySnapshots[0].lastSeenUtc === "string"
      && snapshot.truncation.droppedSnapshots === 0 && snapshot.completeness.complete === true,
    { count: snapshot.capabilitySnapshots.length, first: snapshot.capabilitySnapshots[0], truncation: snapshot.truncation });
}

{
  // The backend renews connection material for the same gateway instance. The
  // host picks up the renewed descriptor on the next forced connection, and the
  // journal names both descriptors of the one instance.
  const base = (await fixture.resolveDescriptor()).descriptor;
  let current = base;
  const journal = createReadJournal({ header: { mode: "live" } });
  const gateway = createGateway({
    kit: kitSession.kit, resolveDescriptor: async () => ({ status: "available", descriptor: current }),
    expectedWorkspace: fixture.workspace, fetchImpl: fixture.fetchImpl, journal,
  });
  const before = await gateway.connection({ force: true });
  await gateway.run("query.memory.scopes.list", {});
  // A renewal is published now and moves both the descriptor's and the
  // authorization's expiry; the instance and the session stay.
  const renewedUntil = new Date(Date.now() + 45 * 60_000).toISOString();
  current = {
    ...base,
    descriptorId: `application-gateway:${"e".repeat(64)}`,
    publishedAtUtc: new Date().toISOString(),
    validUntilUtc: renewedUntil,
    authorization: { ...base.authorization, expiresAtUtc: renewedUntil },
  };
  const after = await gateway.connection({ force: true });
  await gateway.run("query.memory.scopes.list", {});
  const identities = journal.snapshot().gatewayIdentities;
  check("renewed-descriptor-picked-up-without-restart",
    before.available && after.available && after.descriptorId === current.descriptorId
      && after.instanceId === before.instanceId && after.validUntilUtc === current.validUntilUtc
      && identities.length === 2 && identities.every((item) => item.instanceId === before.instanceId),
    { before: before.descriptorId, after: after.descriptorId, identities: identities.map((item) => item.descriptorId) });
}

{
  // What the window may learn about the configured controller: status, reason
  // and the expected workspace identity - never the controller root or the
  // path of the configuration file.
  const { loadLocalConfig, safeConfiguration } = await import("../src/host/config.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-config-"));
  const results = {};
  results.missing = safeConfiguration(await loadLocalConfig(root));
  await (await import("node:fs/promises")).mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "config", "local.json"), "{ not json");
  results.unparsable = safeConfiguration(await loadLocalConfig(root));
  await writeFile(path.join(root, "config", "local.json"), JSON.stringify({
    controllerRoot: "relative/controller", expectedWorkspace: { projectId: "p", workspaceRootSha256: "a".repeat(64) },
  }));
  results.relative = safeConfiguration(await loadLocalConfig(root));
  const controllerRoot = path.join(root, "controller");
  await writeFile(path.join(root, "config", "local.json"), JSON.stringify({
    controllerRoot, expectedWorkspace: { projectId: "p", workspaceRootSha256: "a".repeat(64) },
  }));
  results.loaded = safeConfiguration(await loadLocalConfig(root));
  const shown = JSON.stringify(results);
  check("window-gets-safe-controller-identity",
    results.missing.status === "missing" && results.missing.reasonCode === "local_config_missing"
      && results.unparsable.reasonCode === "local_config_unparsable"
      && results.relative.reasonCode === "controller_root_not_absolute"
      && results.loaded.status === "loaded" && results.loaded.expectedWorkspace.projectId === "p"
      && !shown.includes(root.replace(/\\/g, "\\\\")) && !shown.includes("configPath") && !shown.includes("controllerRoot"),
    results);
  await rm(root, { recursive: true, force: true });
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "evidence",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

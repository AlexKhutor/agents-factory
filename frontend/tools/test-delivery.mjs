// The accepted delivery: the application loads exactly the frontend kit the
// backend accepted, verifies it before importing any kit file, and refuses to
// start a connection otherwise - on the normal path and on the fixture path.
//
// Every corruption below is made in a disposable copy under the system temp
// directory. The working vendor/ and delivery/ are only read.

import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_DELIVERY, RETAINED_DELIVERY, loadAcceptedKit, verifyKitDelivery } from "../src/host/kit.mjs";
import { createSession } from "../src/host/session.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT_VERSION = "v0.21.0"; // only to lay out disposable copies; kit.mjs reads it from the lock
const RETAINED_VERSION = "v0.20.0"; // the previous delivery, kept for a deliberate rollback
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};
const temporaries = [];

async function disposableApplication(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `atlas-delivery-${label}-`));
  temporaries.push(root);
  await cp(path.join(PROJECT_ROOT, "delivery"), path.join(root, "delivery"), { recursive: true });
  await cp(path.join(PROJECT_ROOT, "vendor", "frontend-kit", KIT_VERSION),
    path.join(root, "vendor", "frontend-kit", KIT_VERSION), { recursive: true });
  return root;
}

const kitFile = (root, relative, version = KIT_VERSION) =>
  path.join(root, "vendor", "frontend-kit", version, ...relative.split("/"));

async function appendTo(file, text) {
  await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(text, "utf8")]));
}

async function rejectionOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error?.code ?? "no_code";
  }
}

// A kit file that is imported sets this global; a kit that is never imported
// leaves it unset. That is how "blocked before import" is observed.
const SENTINEL = "__atlasKitSentinel";
const sentinelLine = (value) => `\nglobalThis.${SENTINEL} = "${value}";\n`;

// --- the accepted delivery ------------------------------------------------------

{
  const verified = await verifyKitDelivery();
  check("accepted-delivery-is-verified",
    verified.status === "verified" && verified.releaseId === "claude-port-backend-20261003"
      && ACCEPTED_DELIVERY.releaseId === "claude-port-backend-20261003"
      && verified.version === "v0.21.0"
      && verified.manifestSha256 === "7af45f5786001616cd4e1eddb3f107d8da9ee2fc81684bfae55948c0582c817a"
      && verified.lockSha256 === "8db06673b053049d13725697ef4c34111e661f5336bd72af7d61708aff69da35"
      && verified.filesChecked === 73,
    verified);

  // The previous delivery is kept whole for a deliberate rollback: its lock is
  // pinned and its kit still verifies against it. It is never loaded by itself.
  const retained = await verifyKitDelivery({ delivery: RETAINED_DELIVERY });
  check("previous-delivery-kept-for-rollback-and-verified",
    retained.status === "verified" && retained.releaseId === "claude-port-backend-20261002"
      && retained.version === RETAINED_VERSION && retained.filesChecked === 73
      && retained.manifestSha256 === "c4c852201e9a3fc1a171145c1e0fd930ce3c5ce663778a81ee28b6e8bed2f0e1"
      && RETAINED_DELIVERY.lockFile !== ACCEPTED_DELIVERY.lockFile,
    retained);

  const kit = await loadAcceptedKit();
  check("kit-loads-after-verification",
    typeof kit.client.ApplicationFrontendClient === "function"
      && typeof kit.desktop.projectDesktopMemory === "function"
      && kit.summary.contractVersion === "v0.1.0" && kit.summary.releaseId === ACCEPTED_DELIVERY.releaseId,
    kit.summary);

  const session = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
  check("fixture-starts-on-accepted-delivery",
    session.delivery.status === "verified" && session.gateway !== null && session.fixture === true,
    session.delivery);
}

// --- only one module touches the kit ----------------------------------------------

{
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue;
      const relative = path.relative(PROJECT_ROOT, full).replaceAll("\\", "/");
      if (relative === "src/host/kit.mjs" || relative === "tools/test-delivery.mjs") continue;
      const text = await readFile(full, "utf8");
      if (/frontend-kit|KIT_ROOT|KIT_VERSION/.test(text)) offenders.push(relative);
    }
  };
  await walk(path.join(PROJECT_ROOT, "src"));
  await walk(path.join(PROJECT_ROOT, "tools"));
  check("only-kit-mjs-touches-the-kit", offenders.length === 0, offenders);
}

// --- the application version is its own; the kit and contracts are what it consumes --

{
  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const projectVersion = JSON.parse(await readFile(path.join(PROJECT_ROOT, "project-version.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(PROJECT_ROOT, "delivery", "contracts", ACCEPTED_DELIVERY.lockFile), "utf8"));
  const consumes = projectVersion.consumes;
  check("one-app-version-in-package-and-project-version",
    /^v\d+\.\d+\.\d+$/.test(projectVersion.projectVersion)
      && packageJson.version === projectVersion.projectVersion.slice(1),
    { package: packageJson.version, project: projectVersion.projectVersion });
  check("consumed-versions-match-lock",
    consumes.acceptedDeliveryReleaseId === lock.releaseId
      && consumes.acceptedDeliveryLockSha256 === ACCEPTED_DELIVERY.lockSha256
      && consumes.applicationFrontendKit === lock.frontend.version
      && consumes.applicationFrontendKitManifestSha256 === lock.frontend.manifestSha256
      && consumes.applicationContract === lock.frontend.contracts.application
      && consumes.applicationGatewayDescriptor === lock.frontend.contracts.gatewayDescriptor
      && consumes.applicationCapabilities === lock.frontend.contracts.capabilities,
    { consumes, lock: { releaseId: lock.releaseId, frontend: lock.frontend } });
}

// --- a disposable copy that is untouched still verifies ----------------------------

{
  const root = await disposableApplication("clean");
  const verified = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("untouched-copy-is-accepted", verified === null, verified);
}

// --- one changed kit file blocks before import -------------------------------------

{
  const root = await disposableApplication("changed");
  await appendTo(kitFile(root, "client/index.mjs"), sentinelLine("changed"));
  const code = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("changed-kit-file-blocks-before-import",
    code === "payload_hash_mismatch" && globalThis[SENTINEL] === undefined,
    { code, sentinel: globalThis[SENTINEL] });

  // Fixing the file afterwards does not flip the same process to "verified":
  // a rejection stays one until the application is restarted.
  const original = await readFile(path.join(PROJECT_ROOT, "vendor", "frontend-kit", KIT_VERSION, "client", "index.mjs"));
  await writeFile(kitFile(root, "client/index.mjs"), original);
  const again = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("refusal-stays-until-restart", again === "payload_hash_mismatch", again);
}

// --- a missing file, a wrong manifest ------------------------------------------------

{
  const root = await disposableApplication("missing");
  await rm(kitFile(root, "schemas/application-common.v1.json"));
  const code = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("missing-file-blocks", code === "kit_file_missing", code);
}
{
  const root = await disposableApplication("manifest");
  await appendTo(kitFile(root, "manifest.json"), " ");
  const code = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("invalid-manifest-blocks", code === "manifest_hash_mismatch", code);
}

// --- an older (or newer) kit next to it is never a substitute -------------------------

{
  const root = await disposableApplication("old");
  const vendor = path.join(root, "vendor", "frontend-kit");
  await rename(path.join(vendor, KIT_VERSION), path.join(vendor, "v0.16.1"));
  await cp(path.join(vendor, "v0.16.1"), path.join(vendor, "v0.22.0"), { recursive: true });
  await appendTo(kitFile(root, "client/index.mjs", "v0.16.1"), sentinelLine("v0.16.1"));
  await appendTo(kitFile(root, "client/index.mjs", "v0.22.0"), sentinelLine("v0.22.0"));
  const code = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("older-or-newer-kit-nearby-does-not-replace-accepted",
    code === "kit_file_missing" && globalThis[SENTINEL] === undefined,
    { code, sentinel: globalThis[SENTINEL] });
}

// An older kit laid into the accepted directory: its manifest says so, and it is
// not the manifest the backend accepted.
{
  const root = await disposableApplication("older-in-place");
  const manifestPath = kitFile(root, "manifest.json");
  const packagePath = kitFile(root, "package.json");
  const manifest = (await readFile(manifestPath, "utf8"))
    .replace('"kitVersion":"v0.21.0"', '"kitVersion":"v0.16.1"')
    .replace('"packageVersion":"0.21.0"', '"packageVersion":"0.16.1"');
  await writeFile(manifestPath, manifest);
  await writeFile(packagePath, (await readFile(packagePath, "utf8")).replace('"version":"0.21.0"', '"version":"0.16.1"'));
  await appendTo(kitFile(root, "client/index.mjs"), sentinelLine("older-in-place"));
  const code = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("older-kit-in-place-of-accepted-blocks",
    code === "manifest_hash_mismatch" && globalThis[SENTINEL] === undefined,
    { code, sentinel: globalThis[SENTINEL] });
}

// --- the lock and the verifier are pinned ------------------------------------------------

{
  const root = await disposableApplication("lock");
  const lockPath = path.join(root, "delivery", "contracts", ACCEPTED_DELIVERY.lockFile);
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.frontend.manifestSha256 = "0".repeat(64);
  await writeFile(lockPath, JSON.stringify(lock, null, 2));
  const code = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("replaced-lock-is-rejected", code === "lock_hash_mismatch", code);
}
{
  const root = await disposableApplication("verifier");
  await appendTo(path.join(root, "delivery", "scripts", "verify-accepted-delivery.mjs"),
    "\nglobalThis.__atlasVerifierSentinel = true;\n");
  const code = await rejectionOf(loadAcceptedKit({ applicationRoot: root }));
  check("replaced-verifier-is-not-run",
    code === "verifier_hash_mismatch" && globalThis.__atlasVerifierSentinel === undefined,
    { code, sentinel: globalThis.__atlasVerifierSentinel });
}

// --- the check is on the fixture path and on the normal path -----------------------------

{
  const root = await disposableApplication("session");
  await appendTo(kitFile(root, "desktop/index.mjs"), sentinelLine("desktop"));
  const fixture = await createSession({ projectRoot: root, mode: "dev-fixture" });
  const live = await createSession({ projectRoot: root, mode: "live" });
  const refused = await fixture.mutations.send({ agentId: "a", text: "x" });
  const trusted = await fixture.trusted.availability();
  check("fixture-does-not-start-on-rejected-delivery",
    fixture.delivery.status === "rejected" && fixture.gateway === null && fixture.kit === null
      && refused.ok === false && refused.error.reasonCode === "delivery_payload_hash_mismatch"
      && trusted.available === false,
    { delivery: fixture.delivery, refused, trusted });
  check("normal-path-refuses-before-settings-and-gateway",
    live.delivery.status === "rejected" && live.gateway === null
      && live.configuration.status === "delivery_rejected",
    { delivery: live.delivery, configuration: live.configuration });
  check("rejected-kit-never-imported", globalThis[SENTINEL] === undefined, globalThis[SENTINEL]);
}

// --- no gateway: honest unavailable, no fallback, nothing replayed ------------------------

{
  const root = await disposableApplication("nogateway");
  // The retained older kit sits next to the accepted one and must stay untouched:
  // an unavailable gateway is never a reason to fall back to it.
  await cp(path.join(PROJECT_ROOT, "vendor", "frontend-kit", RETAINED_VERSION),
    path.join(root, "vendor", "frontend-kit", RETAINED_VERSION), { recursive: true });
  await appendTo(kitFile(root, "client/index.mjs", RETAINED_VERSION), sentinelLine("fallback"));
  const controllerRoot = path.join(root, "empty-controller");
  await mkdir(controllerRoot, { recursive: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "local.json"), JSON.stringify({
    controllerRoot,
    expectedWorkspace: { projectId: "atlas-delivery-test", workspaceRootSha256: "a".repeat(64) },
    gatewayCli: { nodeExecutable: "node", scriptRelativePath: ".orchestrator/runtime/application-gateway-cli.mjs" },
  }));
  const session = await createSession({ projectRoot: root, mode: "live" });
  const connection = session.gateway === null ? null : await session.gateway.connection({ force: true });
  const second = session.gateway === null ? null : await session.gateway.connection({ force: true });
  check("no-gateway-honestly-unavailable-without-kit-substitution",
    session.delivery.status === "verified" && session.delivery.version === KIT_VERSION
      && session.fixture === false
      && connection !== null && connection.available === false
      && connection.error?.reasonCode === "status_missing"
      && second !== null && second.available === false
      && globalThis[SENTINEL] === undefined,
    { delivery: session.delivery, connection, sentinel: globalThis[SENTINEL] });

  // Nothing is served in place of the gateway: a read does not come back with
  // fixture or cached data, and a send is not queued for later.
  const read = session.gateway === null ? null : await session.gateway.run("query.memory.scopes.list", {});
  const send = await session.mutations.send({ agentId: "a", text: "x" });
  check("no-gateway-no-substituted-data-no-retry",
    read !== null && read.ok === false && read.data === undefined
      && send.ok === false && send.queued === undefined,
    { read, send });
}

for (const root of temporaries) await rm(root, { recursive: true, force: true });

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "delivery",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

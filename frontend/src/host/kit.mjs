// The one door to the Application Frontend Kit. Host process only.
//
// The application loads exactly the frontend kit the backend accepted, and
// nothing else. That acceptance is recorded by two files the backend delivered
// and this project keeps byte for byte in delivery/:
//
//   delivery/contracts/<lock file>                 the lock: release, version, manifest hash
//   delivery/scripts/verify-accepted-delivery.mjs  the backend's own verifier
//
// Exactly one delivery is active. The previous one is retained next to it, whole,
// for a deliberate rollback: switching back is an edit of ACCEPTED_DELIVERY here,
// never something this module does on its own because the active one failed.
//
// Both are trusted parts of this application, not settings and not renderer
// data. Their hashes are pinned below, so neither can be edited into agreeing
// with a different kit. The order is fixed and there is no way around it:
//
//   1. the lock is read and checked against its pinned hash;
//   2. the kit directory is the one the lock names - never the newest, never a
//      fallback, never a search;
//   3. the verifier is checked against its pinned hash, and only then imported;
//   4. every kit file is verified against the accepted manifest;
//   5. only then is any kit module imported.
//
// No other module in this project imports a kit file. A failed verification is
// remembered for the life of the process: nothing is repaired, nothing is
// downloaded, and the desk opens with a local delivery error instead of a
// connection. A verified kit says nothing about the gateway: discovery, the
// expected workspace and capabilities are still checked separately.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APPLICATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The accepted backend delivery. Changing any of these values is the one
 * deliberate act that moves this application to another release; it must come
 * with the new lock and verifier from the backend, never be derived from what
 * happens to be in vendor/.
 */
export const ACCEPTED_DELIVERY = Object.freeze({
  releaseId: "claude-port-backend-20261003",
  lockFile: "accepted-delivery-claude-port-20261003.v1.json",
  lockSha256: "8db06673b053049d13725697ef4c34111e661f5336bd72af7d61708aff69da35",
  verifierSha256: "adc66a1e276e74024bb075e3c893977699b8af1901ecb1375da4ea3673371c70",
});

/**
 * The previous accepted delivery (Kit v0.20.0, the Claude Code port of
 * 2026-10-02), kept whole with its own lock for a controlled rollback; the
 * backend of Kit v0.21.0 still serves it. It is verified by the delivery tests
 * but never loaded: an unavailable or rejected active delivery is not a reason
 * to fall back to it. Older deliveries (Kit v0.16.1, v0.15.0, v0.14.0 and their
 * locks) stay on disk as history only.
 */
export const RETAINED_DELIVERY = Object.freeze({
  releaseId: "claude-port-backend-20261002",
  lockFile: "accepted-delivery-claude-port-20261002.v1.json",
  lockSha256: "321c91c31ae090004f168b7a090380da350cfd6865a632b7f2f711daacd1a494",
  verifierSha256: "adc66a1e276e74024bb075e3c893977699b8af1901ecb1375da4ea3673371c70",
});

export class KitDeliveryError extends Error {
  constructor(code, detail = null) {
    super(`Kit delivery rejected: ${code}`);
    this.name = "KitDeliveryError";
    this.code = code;
    this.detail = detail;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function deliveryPaths(applicationRoot, delivery) {
  return {
    lockPath: path.join(applicationRoot, "delivery", "contracts", delivery.lockFile),
    verifierPath: path.join(applicationRoot, "delivery", "scripts", "verify-accepted-delivery.mjs"),
    vendorRoot: path.join(applicationRoot, "vendor", "frontend-kit"),
  };
}

async function readPinned(filePath, expectedSha256, name) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new KitDeliveryError(`${name}_missing`, error?.code ?? null);
  }
  if (sha256(bytes) !== expectedSha256) throw new KitDeliveryError(`${name}_hash_mismatch`);
  return bytes;
}

/** A filesystem error from the verifier becomes a bounded delivery code. */
function deliveryCodeOf(error) {
  if (error?.code === "ENOENT") return "kit_file_missing";
  if (typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)) return error.code;
  return "invalid_delivery";
}

/**
 * Verifies the kit's files against the accepted delivery. Imports nothing from
 * the kit itself; it is what `npm run verify:kit` runs, and what loadAcceptedKit
 * runs before importing anything.
 */
export async function verifyKitDelivery({ applicationRoot = APPLICATION_ROOT, delivery = ACCEPTED_DELIVERY } = {}) {
  const paths = deliveryPaths(applicationRoot, delivery);
  const lockBytes = await readPinned(paths.lockPath, delivery.lockSha256, "lock");
  const lock = JSON.parse(lockBytes.toString("utf8"));
  if (lock.releaseId !== delivery.releaseId) throw new KitDeliveryError("release_mismatch");
  const version = lock.frontend?.version;
  if (typeof version !== "string" || !/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new KitDeliveryError("lock_version_invalid");
  }
  // Exactly the directory the lock names. If it is missing, the delivery is
  // missing: an older or newer directory next to it is never a substitute.
  const kitRoot = path.join(paths.vendorRoot, version);

  await readPinned(paths.verifierPath, delivery.verifierSha256, "verifier");
  const { verifyAcceptedDelivery } = await import(pathToFileURL(paths.verifierPath).href);
  let result;
  try {
    result = await verifyAcceptedDelivery({ artifact: "frontend", root: kitRoot, lockPath: paths.lockPath });
  } catch (error) {
    throw new KitDeliveryError(deliveryCodeOf(error), error?.message ?? null);
  }
  if (result?.status !== "verified" || result.releaseId !== delivery.releaseId) {
    throw new KitDeliveryError("verification_incomplete");
  }
  return Object.freeze({
    status: "verified",
    releaseId: result.releaseId,
    version: result.version,
    manifestSha256: result.manifestSha256,
    filesChecked: result.filesChecked,
    lockSha256: delivery.lockSha256,
    contracts: Object.freeze({ ...lock.frontend.contracts }),
    kitRoot,
  });
}

const loads = new Map();

/**
 * Verifies the delivery, then - and only then - imports the kit's modules.
 * One verification per application root per process; a rejection stays a
 * rejection until the application is restarted with correct files.
 */
export function loadAcceptedKit({ applicationRoot = APPLICATION_ROOT } = {}) {
  const key = path.resolve(applicationRoot);
  if (!loads.has(key)) loads.set(key, load(key));
  return loads.get(key);
}

async function load(applicationRoot) {
  const release = await verifyKitDelivery({ applicationRoot });
  const inside = (relative) => {
    if (typeof relative !== "string" || path.isAbsolute(relative)
        || relative.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")) {
      throw new KitDeliveryError("unsafe_kit_path");
    }
    return path.join(release.kitRoot, relative);
  };
  const client = await import(pathToFileURL(inside("client/index.mjs")).href);
  const desktop = await import(pathToFileURL(inside("desktop/index.mjs")).href);
  return Object.freeze({
    release,
    client,
    desktop,
    // Only the conformance runner needs the testing export; it is still
    // imported from the verified directory.
    loadTesting: () => import(pathToFileURL(inside("testing/index.mjs")).href),
    // Schema-bound DTO samples of the agent-workspace reads: shapes for tests,
    // never a live conversation or a ready server.
    loadAgentWorkspaceSamples: () => import(pathToFileURL(inside("testing/agent-workspace.mjs")).href),
    // A verified data file of the kit (the fixture reads an example from here).
    readText: (relative) => readFile(inside(relative), "utf8"),
    summary: Object.freeze({
      releaseId: release.releaseId,
      version: release.version,
      manifestSha256: release.manifestSha256,
      lockSha256: release.lockSha256,
      filesChecked: release.filesChecked,
      clientVersion: client.APPLICATION_FRONTEND_CLIENT_VERSION,
      contractVersion: client.APPLICATION_CONTRACT_VERSION,
      descriptorVersion: client.APPLICATION_GATEWAY_DESCRIPTOR_VERSION,
    }),
  });
}

/** A rejection as the renderer may see it: a bounded code, nothing else. */
export function describeDeliveryFailure(error) {
  return {
    status: "rejected",
    reasonCode: error instanceof KitDeliveryError ? error.code : "invalid_delivery",
    releaseId: ACCEPTED_DELIVERY.releaseId,
  };
}

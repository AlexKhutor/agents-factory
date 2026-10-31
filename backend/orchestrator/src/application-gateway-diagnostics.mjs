import { lstat, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOSPC", "EBUSY", "EIO", "EROFS",
  "clock_regressed", "invalid_timestamp", "invalid_timeline", "invalid_state", "invalid_runtime_record"]);
const STAGES = new Set(["mkdir", "write", "rename"]);
const SYSCALLS = new Set(["mkdir", "open", "write", "close", "rename", "unlink"]);

export async function captureGatewayFileFacts(target, temporary) {
  const inspect = async (file) => {
    try {
      const s = await lstat(file);
      return { kind: s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
        mode: s.mode, size: s.size, mtimeMs: s.mtimeMs };
    } catch (error) {
      return { code: CODES.has(error.code) ? error.code : "unclassified" };
    }
  };
  let timer;
  try {
    return await Promise.race([
      Promise.all([inspect(target), inspect(temporary), inspect(path.dirname(target))])
        .then(([targetFacts, temporaryFacts, parent]) => ({ target: targetFacts, temporary: temporaryFacts, parent })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ unavailable: "timeout" }), 250); }),
    ]);
  } finally { clearTimeout(timer); }
}

function boundedFacts(facts) {
  if (!facts) return null;
  if (facts.unavailable === "timeout") return { unavailable: "timeout" };
  return Object.fromEntries(["target", "temporary", "parent"].map((name) => {
    const v = facts[name] ?? {};
    if (v.code) return [name, { code: CODES.has(v.code) ? v.code : "unclassified" }];
    return [name, { kind: ["link", "directory", "file", "other"].includes(v.kind) ? v.kind : null,
      ...Object.fromEntries(["mode", "size", "mtimeMs"].map((key) => [key, Number.isFinite(v[key]) ? v[key] : null])) }];
  }));
}

export function gatewayFailureDiagnostic(error, status, failedAtUtc) {
  return {
    schemaVersion: 1, status: "failed", code: "observability_lost",
    phase: "heartbeat-publication", causeCode: CODES.has(error?.code) ? error.code : "unclassified",
    runtimeStage: STAGES.has(error?.runtimeStage) ? error.runtimeStage : null,
    renameAttempts: Number.isInteger(error?.renameAttempts)
      && error.renameAttempts >= 1 && error.renameAttempts <= 8 ? error.renameAttempts : null,
    syscall: SYSCALLS.has(error?.syscall) ? error.syscall : null,
    errno: Number.isSafeInteger(error?.errno) ? error.errno : null,
    elapsedMs: Number.isFinite(error?.publicationElapsedMs) ? error.publicationElapsedMs : null,
    fileFactsAfterFailure: boundedFacts(error?.fileFactsAfterFailure),
    recordKind: "gateway-status", failedAtUtc,
    instanceId: status.identity.instanceId, generation: status.identity.generation,
    processId: status.identity.process.processId,
    attemptedHeartbeatAtUtc: status.heartbeatAtUtc ?? null,
    runtime: { node: process.versions.node, uv: process.versions.uv,
      platform: process.platform, arch: process.arch, osRelease: os.release() },
  };
}

// Keep the first failure per exact instance. Never rotate or overwrite evidence.
// The caller supplies only the bounded projection, not an Error or descriptor.
export async function persistGatewayFailureDiagnostic(directory, record) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.instanceId)) {
    throw new Error("invalid_diagnostic_identity");
  }
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path.join(directory, record.instanceId + ".failure.json"),
      JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

// One bounded read failure per Gateway instance; independent of lifecycle failures.
export async function persistGatewayAgentReadDiagnostic(directory, instanceId, record) {
  const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
  const components = {
    "agent-conversation": { suffix: "agent-read", operations: ["query.agent-conversation.read", "query.agent-conversation.resolve"],
      phases: ["input", "binding", "continuation", "provider-read", "binding-recheck", "output"] },
    "project-workspace": { suffix: "project-workspace", operations: ["query.project-workspace.list", "query.project-workspace.read"],
      phases: ["input", "workspace-binding", "continuation", "resource-read", "binding-recheck", "output"] },
  };
  const component = Object.hasOwn(components, record?.component ?? "") ? components[record.component] : null;
  const reasons = ["identity_mismatch", "concurrent_update", "provider_revision_unavailable",
    "thread_not_found", "invalid_provider_payload", "provider_payload_too_large", "access_denied",
    "stale_revision", "conflict", "source_unavailable", "privacy_violation",
    "workspace_not_bound", "workspace_binding_conflict", "workspace_path_missing"];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)
      || !component?.phases.includes(record?.phase) || !reasons.includes(record?.reasonCode)
      || !["stale_revision", "access_denied", "conflict", "source_unavailable"].includes(record?.code)
      || !component.operations.includes(record?.operationId)
      || typeof record?.atUtc !== "string" || record.atUtc.length > 32
      || !record.atUtc.endsWith("Z") || !Number.isFinite(Date.parse(record.atUtc))) {
    throw new Error("invalid_diagnostic_record");
  }
  const safe = { schemaVersion: 1, component: record.component, instanceId,
    operationId: record.operationId, phase: record.phase, atUtc: record.atUtc,
    reasonCode: record.reasonCode, code: record.code,
    requestId: typeof record.requestId === "string" && id.test(record.requestId) ? record.requestId : null,
    correlationId: typeof record.correlationId === "string" && id.test(record.correlationId) ? record.correlationId : null };
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path.join(directory, instanceId + "." + component.suffix + ".failure.json"),
      JSON.stringify(safe) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) { if (error.code !== "EEXIST") throw error; }
}

import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  fail, isProcessAlive, nowUtc, pathKind, readJsonFile, sha256File, writeJsonAtomic,
} from "./agents-factory-common.mjs";
import { readInstanceMode } from "./instance-mode.mjs";
import { migrateToSplitLayout } from "./project-package-import.mjs";
import { resolveStoreLayout } from "./project-store-layout.mjs";

// The instance's schema version (instance.json) and the ordered migrations that
// bring an instance to the version this CLI expects, instead of the private
// controller's patch chain (product-changes.md, section 8). Every run that
// changes anything first copies the databases and configs to
// .project-local/backups/migrate-<time>/ with a manifest of hashes. Each
// migration is idempotent and moves exactly one version forward; instance.json
// is rewritten after each, so an interrupted run resumes where it stopped.

export const INSTANCE_KIND = "agents-factory-instance";
export const INSTANCE_SCHEMA_VERSION = 2;

/**
 * { id, from, to, description, apply({ instanceDir, layout }) } in order. A
 * migration may write instance.json itself; the record is read again after it.
 */
export const INSTANCE_MIGRATIONS = Object.freeze([
  {
    // Plan 4.3 / 5.1 (docs/project-package.md §6.6, §14.9): one memory database per project, as a
    // project package needs; the export, import and comparison of migrate-layout, the single database
    // kept. The mode the instance had (synced with a sync.json, else local) is recorded.
    id: "split-store-and-mode",
    from: 1,
    to: 2,
    description: "One memory database per project (the split layout); the instance's mode recorded",
    async apply({ instanceDir }) {
      if ((await resolveStoreLayout(instanceDir, { env: {} })).layout !== "split") {
        await migrateToSplitLayout({ controllerRoot: instanceDir });
      }
      const mode = await readInstanceMode(instanceDir);
      if (!mode.recorded) {
        const file = path.join(instanceDir, "instance.json");
        await writeJsonAtomic(file, { ...(await readJsonFile(file)), mode: mode.mode });
      }
    },
  },
]);

const DATABASE = /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/iu;
const CONFIG_FILES = Object.freeze([
  "instance.json",
  "project-version.json",
  path.join(".project-local", "application-gateway", "claude-provider.json"),
  path.join(".project-local", "orchestration", "control-cycle.json"),
  path.join(".project-local", "source-bindings.json"),
]);

/** A new instance's record; an adopted one (made before instance.json) starts at schema 1 and migrates. */
export function newInstanceRecord({ createdBy, now = nowUtc(), schemaVersion = INSTANCE_SCHEMA_VERSION }) {
  return { schemaVersion, kind: INSTANCE_KIND, createdAtUtc: now, createdBy, updatedAtUtc: now };
}

export async function readInstanceRecord(layout) {
  const record = await readJsonFile(layout.instanceRecord, { invalidCode: "instance_record_invalid" });
  if (record === null) return null;
  if (record.kind !== INSTANCE_KIND || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) {
    fail("instance_record_invalid", "instance.json is not an Agents Factory instance record");
  }
  return record;
}

function validateMigrations(migrations) {
  let expected = null;
  for (const migration of migrations) {
    if (typeof migration?.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,95}$/u.test(migration.id)
        || !Number.isSafeInteger(migration.from) || migration.to !== migration.from + 1
        || typeof migration.apply !== "function" || (expected !== null && migration.from !== expected)) {
      fail("migration_list_invalid", "The migration list is not one ordered chain");
    }
    expected = migration.to;
  }
}

async function walkDatabases(directory, root, found, skip) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!skip.has(full)) await walkDatabases(full, root, found, skip);
    } else if (entry.isFile() && DATABASE.test(entry.name)) {
      found.push(path.relative(root, full));
    }
  }
}

export async function backupInstance(layout, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  let directory = path.join(layout.backupsDir, `migrate-${stamp}`);
  for (let suffix = 1; (await pathKind(directory)) !== null; suffix += 1) {
    directory = path.join(layout.backupsDir, `migrate-${stamp}-${suffix}`);
  }
  const relativeFiles = [];
  for (const file of CONFIG_FILES) {
    if ((await pathKind(path.join(layout.instanceDir, file))) === "file") relativeFiles.push(file);
  }
  const configDirectory = path.join(layout.instanceDir, "config");
  for (const entry of await readdir(configDirectory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith(".json")) relativeFiles.push(path.join("config", entry.name));
  }
  await walkDatabases(path.join(layout.instanceDir, ".project-local"), layout.instanceDir, relativeFiles,
    new Set([layout.backupsDir]));
  const files = [];
  for (const relative of relativeFiles) {
    const source = path.join(layout.instanceDir, relative);
    const target = path.join(directory, "files", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    files.push({ path: relative.split(path.sep).join("/"), sha256: await sha256File(target) });
  }
  await writeJsonAtomic(path.join(directory, "backup-manifest.json"), {
    schemaVersion: 1, kind: "agents-factory-migration-backup", createdAtUtc: now.toISOString(), files,
  });
  return { path: directory, files: files.length };
}

async function gatewayRunning(layout) {
  const status = await readJsonFile(layout.gatewayStatus).catch(() => null);
  return status !== null && status.terminal !== true && isProcessAlive(status.identity?.process?.processId);
}

export async function migrateInstance({ layout, dryRun = false, migrations = INSTANCE_MIGRATIONS,
  targetVersion = migrations.length === 0 ? INSTANCE_SCHEMA_VERSION : migrations.at(-1).to, now = () => new Date() }) {
  validateMigrations(migrations);
  if ((await pathKind(layout.instanceDir)) !== "directory") fail("instance_missing", `No controller instance at ${layout.instanceDir}`);
  const record = await readInstanceRecord(layout);
  if (record === null) fail("instance_not_initialized", "The instance has no instance.json; run setup");
  if (record.schemaVersion > targetVersion) {
    fail("instance_newer_than_cli", `The instance schema ${record.schemaVersion} is newer than this CLI (${targetVersion})`);
  }
  const pending = migrations.filter((migration) => migration.from >= record.schemaVersion && migration.to <= targetVersion);
  if (pending.length > 0 && pending[0].from !== record.schemaVersion) {
    fail("migration_list_invalid", `No migration starts at schema ${record.schemaVersion}`);
  }
  const summary = {
    command: "migrate", instance: layout.instanceDir, dryRun, schemaVersion: record.schemaVersion, targetSchemaVersion: targetVersion,
    pending: pending.map(({ id, from, to, description }) => ({ id, from, to, description: description ?? null })),
  };
  if (dryRun || pending.length === 0) {
    return { ...summary, state: pending.length === 0 ? "current" : "pending", applied: [], backup: null };
  }
  if (await gatewayRunning(layout)) fail("gateway_running", "Stop the Gateway before migrating (gateway stop)");
  const backup = await backupInstance(layout, { now: now() });
  const applied = [];
  let current = record;
  for (const migration of pending) {
    await migration.apply({ instanceDir: layout.instanceDir, layout });
    current = { ...((await readInstanceRecord(layout)) ?? current), schemaVersion: migration.to, updatedAtUtc: now().toISOString() };
    await writeJsonAtomic(layout.instanceRecord, current);
    applied.push(migration.id);
  }
  const verified = await readInstanceRecord(layout);
  if (verified?.schemaVersion !== targetVersion) fail("migration_unverified", "instance.json does not show the target schema");
  return { ...summary, state: "migrated", schemaVersion: verified.schemaVersion, applied, backup };
}

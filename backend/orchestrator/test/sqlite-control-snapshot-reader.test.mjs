import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SqliteControlSnapshotReader } from "../src/sqlite-control-snapshot-reader.mjs";
import { SqliteControlStore } from "../src/sqlite-control-store.mjs";
import { sqliteBackendOf, sqliteBackendTest as test } from "./fixtures/sqlite-backends/helpers.mjs";

const PYTHON = process.env.PYTHON || "python";

function runPythonScript(script, argumentsList = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", script, ...argumentsList], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Python fixture failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function fixture(t, prefix = "control-snapshot-reader-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const databasePath = path.join(root, "control.db");
  const sqliteBackend = sqliteBackendOf(t);
  const store = new SqliteControlStore({ databasePath, sqliteBackend });
  const reader = new SqliteControlSnapshotReader({ databasePath, sqliteBackend });
  assert.equal(await store.sqliteBackend(), sqliteBackend);
  assert.equal(await reader.sqliteBackend(), sqliteBackend);
  return { root, databasePath, store, reader };
}

async function fileState(root) {
  const names = (await readdir(root)).sort();
  const entries = [];
  for (const name of names) {
    const filePath = path.join(root, name);
    const info = await stat(filePath, { bigint: true });
    assert.equal(info.isFile(), true, `${name} must remain a regular file`);
    entries.push([name, {
      bytes: info.size.toString(),
      mtimeNs: info.mtimeNs.toString(),
      sha256: createHash("sha256").update(await readFile(filePath)).digest("hex"),
    }]);
  }
  return Object.fromEntries(entries);
}

function report(taskId = "snapshot-task") {
  return {
    sourceId: "worker-one",
    taskId,
    reportId: `${taskId}-report`,
    title: "Snapshot task",
    reportStatus: "completed",
    reportSha256: "a".repeat(64),
    taskSha256: "b".repeat(64),
    sourceRevision: "snapshot-test",
    reportPath: `knowledge/reports/${taskId}.md`,
    taskPath: `coordination/tasks/${taskId}.json`,
  };
}

async function startWalHolder(databasePath) {
  const script = String.raw`
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute("PRAGMA wal_autocheckpoint = 0")
connection.execute(
    "INSERT INTO events(at_utc, event_type, item_id, agent_id, payload_json) "
    "VALUES (?, ?, NULL, NULL, ?)",
    ("2026-08-30T00:00:00Z", "snapshot.wal_visible", "{}"),
)
connection.commit()
print("ready", flush=True)
sys.stdin.readline()
connection.close()
`;
  const child = spawn(PYTHON, ["-c", script, databasePath], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  let stdout = "";
  let stderr = "";
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Timed out waiting for WAL fixture"));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!settled && stdout.includes("ready")) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`WAL fixture exited early (${code}): ${stderr.trim()}`));
    });
  });
  return child;
}

async function stopWalHolder(child) {
  const closed = once(child, "close");
  child.stdin.end("\n");
  const [code] = await closed;
  assert.equal(code, 0);
}

test("read-only snapshot matches store semantics without changing source files", async (t) => {
  const { root, store, reader } = await fixture(t);
  await store.initialize();
  const queued = await store.enqueue(report());
  await store.addEvent("snapshot.extra", { itemId: queued.item.itemId });
  const expected = await store.snapshot({ eventLimit: 1 });
  const before = await fileState(root);

  const actual = await reader.snapshot({ eventLimit: 1 });

  assert.deepEqual(actual, expected);
  assert.equal(actual.sequence, 2);
  assert.deepEqual(actual.events.map((event) => event.type), ["snapshot.extra"]);
  assert.deepEqual(await fileState(root), before);
});

test("read-only snapshot sees committed WAL data without changing DB, WAL, or SHM", async (t) => {
  const { root, databasePath, store, reader } = await fixture(t, "control-snapshot-wal-");
  await store.initialize();
  const holder = await startWalHolder(databasePath);
  try {
    const before = await fileState(root);
    assert.deepEqual(
      Object.keys(before),
      ["control.db", "control.db-shm", "control.db-wal"],
    );

    const snapshot = await reader.snapshot({ eventLimit: 10 });

    assert.equal(snapshot.sequence, 1);
    assert.equal(snapshot.events[0].type, "snapshot.wal_visible");
    assert.deepEqual(await fileState(root), before);
  } finally {
    await stopWalHolder(holder);
  }
});

test("read-only snapshot fails without creating an absent database or parent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "control-snapshot-absent-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const missingParent = path.join(root, "missing");
  const reader = new SqliteControlSnapshotReader({
    databasePath: path.join(missingParent, "control.db"),
    sqliteBackend: sqliteBackendOf(t),
  });

  await assert.rejects(reader.snapshot(), (error) => {
    assert.equal(error.code, "CONTROL_SNAPSHOT_DATABASE_ABSENT");
    return true;
  });

  assert.deepEqual(await readdir(root), []);
  await assert.rejects(stat(missingParent), { code: "ENOENT" });
});

test("read-only snapshot rejects an unsupported schema without changing it", async (t) => {
  const { root, databasePath, reader } = await fixture(t, "control-snapshot-version-");
  await runPythonScript(String.raw`
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute("PRAGMA user_version = 99")
connection.commit()
connection.close()
`, [databasePath]);
  const before = await fileState(root);

  await assert.rejects(reader.snapshot(), (error) => {
    assert.equal(error.code, "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED");
    assert.match(error.message, /schema version: 99/);
    return true;
  });

  assert.deepEqual(await fileState(root), before);
});

test("read-only snapshot rejects a current-version DB with a missing table", async (t) => {
  const { root, databasePath, store, reader } = await fixture(t, "control-snapshot-table-");
  await store.initialize();
  await runPythonScript(String.raw`
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute("DROP TABLE events")
connection.commit()
connection.close()
`, [databasePath]);
  const before = await fileState(root);

  await assert.rejects(reader.snapshot(), (error) => {
    assert.equal(error.code, "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED");
    assert.match(error.message, /missing tables: events/);
    return true;
  });

  assert.deepEqual(await fileState(root), before);
});

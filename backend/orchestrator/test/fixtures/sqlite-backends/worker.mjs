// A separate Node process using one store file with node:sqlite, as the
// Gateway does while a CLI process (or the Python bridge) uses it too.
// Argument: JSON { kind, databasePath, label, count }. Prints a JSON summary.
import { loadNodeSqlite } from "../../../src/sqlite-backend.mjs";
import { ProjectMemoryStore } from "../../../src/project-memory-store.mjs";
import { NodeProjectMemoryBridge } from "../../../src/project-memory-store-node.mjs";
import { ConversationArchive } from "../../../src/conversation-archive.mjs";
import { NodeConversationArchiveBridge } from "../../../src/conversation-archive-store-node.mjs";
import { SqliteControlStore } from "../../../src/sqlite-control-store.mjs";
import { ARCHIVE_BINDING, COUNTER_KEY, archiveRecord } from "./shared.mjs";

const { kind, databasePath, label, count } = JSON.parse(process.argv[2]);
const sqlite = await loadNodeSqlite();
if (sqlite === null) throw new Error("node:sqlite is not available");

let summary;
if (kind === "memory") {
  const store = new ProjectMemoryStore({ store: new NodeProjectMemoryBridge({ databasePath, sqlite }) });
  let retries = 0;
  for (let index = 0; index < count; index += 1) {
    for (;;) {
      const current = await store.readDocument({ key: COUNTER_KEY });
      const value = { count: current.value.count + 1, writers: [...current.value.writers, label].slice(-8) };
      if (await store.compareAndSwapDocument({ key: COUNTER_KEY, expectedRevision: current.revision, value })) break;
      retries += 1;
    }
  }
  summary = { label, retries };
} else if (kind === "archive") {
  const archive = new ConversationArchive({ projectId: "controller",
    store: new NodeConversationArchiveBridge({ databasePath, sqlite }) });
  const sequences = [];
  for (let index = 0; index < count; index += 1) {
    sequences.push((await archive.append(ARCHIVE_BINDING, archiveRecord(`${label}-${index}`, `${label} ${index}`))).sequence);
    await archive.append(ARCHIVE_BINDING, archiveRecord("shared", "the same observation from every writer"));
  }
  summary = { label, sequences };
} else if (kind === "control") {
  const store = new SqliteControlStore({ databasePath, sqliteBackend: "node" });
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const result = await store.enqueue({ sourceId: "worker-one", taskId: `${label}-${index}`,
      reportSha256: "a".repeat(64), title: `${label} ${index}` });
    created.push(result.created);
  }
  const claim = await store.claim({ owner: label });
  summary = { label, created, claimed: claim.reason };
} else {
  throw new Error(`unknown kind ${kind}`);
}
process.stdout.write(`${JSON.stringify(summary)}\n`);

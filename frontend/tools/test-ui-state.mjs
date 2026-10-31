// The window's settings (ui-state.json): known keys and their bounds, and
// writes in turn - the last of those given in a row stays on the disk.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUiStateStore } from "../src/host/ui-state.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-ui-state-"));
const store = createUiStateStore({ directory });
{
  const empty = await store.read();
  check("no-file-defaults", empty.ok && empty.data.awayFrames === true && empty.data.awayHidden.length === 0, empty.data);
}
{
  await writeFile(store.file, JSON.stringify({ awayFrames: "no", awayHidden: ["test-office", "test-office", "../x", 5], extra: 1 }));
  const read = (await store.read()).data;
  check("unknown-is-dropped", read.awayFrames === true && read.awayHidden.join() === "test-office" && read.extra === undefined, read);
}
{
  // Twenty writes without waiting, like clicks on ticks in a row.
  const writes = [];
  for (let index = 0; index < 20; index += 1) {
    writes.push(store.write({ awayFrames: index % 2 === 0, awayHidden: [`p${index}`] }));
  }
  const results = await Promise.all(writes);
  const last = (await store.read()).data;
  check("writes-in-turn-the-last-on-disk",
    results.every((result) => result.ok) && last.awayFrames === false && last.awayHidden.join() === "p19",
    { failed: results.filter((result) => !result.ok).length, last });
}

await rm(directory, { recursive: true, force: true });

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "ui-state",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = path.join(root, "test");
const files = readdirSync(testRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => entry.name)
  .sort();

// --keep-going runs every file and names all that failed (by default the first failure stops the run);
// --no-monitor keeps the checks window closed. Everything else goes to node --test.
const OWN_FLAGS = new Set(["--keep-going", "--no-monitor"]);
const keepGoing = process.argv.includes("--keep-going");
const passThrough = process.argv.slice(2).filter((flag) => !OWN_FLAGS.has(flag));

// The checks window (frontend/tools/test-monitor.cjs) shows the run on the taskbar when
// Atlas's tools are beside this backend: on Windows, not in CI, unless --no-monitor.
async function monitor() {
  const tools = path.resolve(root, "..", "..", "frontend", "tools");
  const launcher = path.join(tools, "test-monitor-launch.mjs");
  if (!existsSync(launcher) || !existsSync(path.join(tools, "ui-run-status.mjs"))) return null;
  const { monitorStatusFile, monitorWanted, startTestMonitor } = await import(pathToFileURL(launcher).href);
  if (!monitorWanted()) return null;
  const { createRunStatus } = await import(pathToFileURL(path.join(tools, "ui-run-status.mjs")).href);
  const file = monitorStatusFile("backend");
  const run = createRunStatus({ file, runId: `backend-${process.pid}`, command: "backend tests", source: null,
    sceneNames: files });
  run.start();
  startTestMonitor({ statusFile: file, label: "Backend tests" });
  return run;
}

if (files.length === 0 || files.length > 512) {
  process.stderr.write(`Invalid discovered test count: ${files.length}\n`);
  process.exitCode = 1;
} else {
  const run = await monitor().catch(() => null);
  const failed = [];
  for (const [index, file] of files.entries()) {
    process.stdout.write(`[test ${index + 1}/${files.length}] ${file}\n`);
    run?.scene(index, file, 1);
    const result = spawnSync(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-force-exit",
      ...passThrough,
      path.join("test", file),
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
      timeout: 180_000,
      windowsHide: true,
    });
    const passed = !result.error && result.status === 0;
    run?.result(file, passed ? "passed" : "failed");
    if (!passed) {
      if (result.error) {
        process.stderr.write(
          `Test process failed for ${file}: ${result.error.code ?? result.error.message}\n`,
        );
      }
      process.exitCode = result.status ?? 1;
      failed.push(file);
      if (!keepGoing) break;
    }
  }
  if (keepGoing) {
    process.stdout.write(`${files.length - failed.length}/${files.length} files passed`
      + `${failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""}\n`);
  }
  run?.finish({ status: failed.length > 0 ? "failed" : "passed", exitCode: process.exitCode ?? 0 });
}

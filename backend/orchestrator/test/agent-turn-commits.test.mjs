import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { agentCommitEmail, createAgentTurnCommits, initProjectGit, readAgentCommits } from "../src/agent-turn-commits.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", windowsHide: true }).trim();

async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-commits-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "--quiet");
  await writeFile(path.join(root, "README.md"), "project\n");
  await mkdir(path.join(root, "tools"), { recursive: true });
  await writeFile(path.join(root, "tools", "old.py"), "old = 1\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "start");
  return root;
}

const agent = { agentId: "studio-lead-2", projectId: "studio", quarterId: "hq" };

test("a turn's work in the agent's zone becomes one commit by the agent; others' changes stay as they were", async (t) => {
  const root = await repository(t);
  // Left by the person before the turn: an untracked note and a staged README change.
  await writeFile(path.join(root, "notes.txt"), "mine\n");
  await writeFile(path.join(root, "README.md"), "project, staged\n");
  git(root, "add", "README.md");
  const commits = createAgentTurnCommits();
  const before = await commits.snapshot(root);
  // The turn: a new file and a deletion in the zone, a file outside it.
  await writeFile(path.join(root, "tools", "new.py"), "new = 2\n");
  await unlink(path.join(root, "tools", "old.py"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "plan.md"), "# plan\n");
  const outcome = await commits.commitTurn({ folder: root, before, zone: ["tools/**"], agent,
    operationId: "op-1", turnId: "turn-1", displayText: "Разложи инструменты\nподробно" });
  assert.equal(outcome.state, "committed");
  assert.deepEqual(outcome.files, ["tools/new.py", "tools/old.py"]);
  assert.equal(git(root, "log", "-1", "--format=%an <%ae>"), `studio-lead-2 <${agentCommitEmail("studio-lead-2")}>`);
  assert.equal(git(root, "log", "-1", "--format=%cn"), "Atlas Gateway");
  const message = git(root, "log", "-1", "--format=%B");
  assert.match(message, /^studio-lead-2: Разложи инструменты\n/u);
  assert.match(message, /Atlas-Operation: op-1/u);
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split(/\r?\n/u).sort(), ["tools/new.py", "tools/old.py"]);
  // What was not the turn's, or not in its zone, is untouched: still staged, untracked, uncommitted.
  const status = git(root, "status", "--porcelain=v1");
  assert.match(status, /^M  README\.md$/mu);
  assert.match(status, /^\?\? notes\.txt$/mu);
  assert.match(status, /^\?\? docs\/$/mu);
  // The window reads the agent's commits.
  const read = await readAgentCommits({ folder: root, agentId: "studio-lead-2" });
  assert.equal(read.versioned, true);
  assert.equal(read.commits.length, 1);
  assert.equal(read.commits[0].files, 2);
  assert.match(read.commits[0].subject, /^studio-lead-2: /u);
});

test("a turn that changed nothing, or a lead of the whole folder, commits what is due", async (t) => {
  const root = await repository(t);
  const commits = createAgentTurnCommits();
  const idle = await commits.snapshot(root);
  assert.deepEqual(await commits.commitTurn({ folder: root, before: idle, zone: null, agent, operationId: "op-0", turnId: "t0" }),
    { state: "nothing" });
  const before = await commits.snapshot(root);
  await writeFile(path.join(root, "CLAUDE.md"), "# rules\n");
  const whole = await commits.commitTurn({ folder: root, before, zone: null, agent, operationId: "op-2", turnId: "t2" });
  assert.equal(whole.state, "committed");
  assert.deepEqual(whole.files, ["CLAUDE.md"]);
  assert.equal(await readFile(path.join(root, "CLAUDE.md"), "utf8"), "# rules\n");
});

test("a folder without git is reported, and becomes one only when asked, with nothing committed", async (t) => {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-nogit-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const commits = createAgentTurnCommits();
  const before = await commits.snapshot(folder);
  assert.equal(before.versioned, false);
  await writeFile(path.join(folder, "a.txt"), "a\n");
  assert.deepEqual(await commits.commitTurn({ folder, before, zone: null, agent, operationId: "op", turnId: "t" }),
    { state: "not-versioned" });
  assert.deepEqual(await readAgentCommits({ folder, agentId: "studio-lead-2" }), { versioned: false, commits: [] });
  assert.deepEqual(await initProjectGit({ folder }), { initialised: true, versioned: true });
  assert.deepEqual(await initProjectGit({ folder }), { initialised: false, versioned: true });
  assert.deepEqual(await readAgentCommits({ folder, agentId: "studio-lead-2" }), { versioned: true, commits: [] });
  // The first turn after init commits its own file only.
  const first = await commits.snapshot(folder);
  await writeFile(path.join(folder, "b.txt"), "b\n");
  const outcome = await commits.commitTurn({ folder, before: first, zone: null, agent, operationId: "op", turnId: "t" });
  assert.equal(outcome.state, "committed");
  assert.deepEqual(outcome.files, ["b.txt"]);
});

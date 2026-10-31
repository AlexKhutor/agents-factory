import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { unmountProject } from "../src/project-mount.mjs";
import { mountedProjects } from "../src/project-store-layout.mjs";
import { initWorld, readSyncState, recoverSync, releaseWorld, takeProject, takeWorld } from "../src/sync-engine.mjs";
import { skip } from "./fixtures/project-package-fixture.mjs";
import { gitIn, lockOf, office, setup } from "./fixtures/sync-fixture.mjs";

// `sync recover` (docs/project-package.md §14.10): each stuck state is made the way a stopped command
// leaves it, then listed without changes and settled with apply.

const kinds = (result) => result.findings.map((finding) => `${finding.target}:${finding.kind}:${finding.action ?? "person"}`);
const head = (dir, ref = "HEAD") => gitIn(dir, "rev-parse", ref).trim();

/** A lock change committed here and not pushed, as a command leaves it when it stops after its commit. */
async function commitLock(dir, lock, message) {
  await writeFile(path.join(dir, "sync-lock.json"), `${JSON.stringify({ schemaVersion: 1, ...lock }, null, 2)}\n`);
  gitIn(dir, "add", "sync-lock.json");
  gitIn(dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message);
}

test("a release committed but not pushed is pushed and recorded; a mirror behind catches up", { skip }, async (t) => {
  const env = await setup(t);
  const { home, remotes } = env;
  await initWorld({ controllerRoot: home });
  const first = lockOf(remotes, "world");
  await commitLock(home, { holder: null, sequence: first.sequence + 1, changedAtUtc: new Date().toISOString(),
    releasedSha256: first.releasedSha256 }, "world: released by home");

  const listed = await recoverSync({ controllerRoot: home });
  assert.deepEqual(kinds(listed), ["world:unpushed:push", "world:release-not-recorded:record-release"]);
  assert.equal(listed.applied, false);
  assert.equal(lockOf(remotes, "world").holder, "home", "listing changes nothing");
  assert.equal((await readSyncState(home)).world.held, true);

  const settled = await recoverSync({ controllerRoot: home, apply: true });
  assert.deepEqual(kinds(settled), kinds(listed));
  assert.equal(settled.needsPerson, false);
  assert.equal(lockOf(remotes, "world").holder, null);
  assert.equal((await readSyncState(home)).world.held, false);
  assert.equal(head(path.join(remotes, "world-mirror.git"), "main"), head(path.join(remotes, "world.git"), "main"));
  assert.deepEqual((await recoverSync({ controllerRoot: home })).findings, []);

  // A mirror that missed a push (it was unreachable then).
  await commitLock(home, { ...lockOf(remotes, "world"), changedAtUtc: new Date().toISOString() }, "world: note");
  gitIn(home, "push", "-q", "hub", "HEAD:refs/heads/main");
  assert.deepEqual(kinds(await recoverSync({ controllerRoot: home })), ["world:mirror-behind:push-mirror"]);
  await recoverSync({ controllerRoot: home, apply: true });
  assert.equal(head(path.join(remotes, "world-mirror.git"), "main"), head(path.join(remotes, "world.git"), "main"));
});

test("a take that lost the race is dropped and kept aside", { skip }, async (t) => {
  const env = await setup(t);
  const { home, remotes } = env;
  await initWorld({ controllerRoot: home });
  await releaseWorld({ controllerRoot: home });
  const free = lockOf(remotes, "world");
  // Both PCs take the free world; the office's push lands first, home's is refused after its commit.
  await takeWorld({ controllerRoot: await office(env) });
  await commitLock(home, { ...free, holder: "home", sequence: free.sequence + 1 }, "world: taken by home");
  const before = head(home);

  assert.deepEqual(kinds(await recoverSync({ controllerRoot: home })), ["world:lost-race:drop-local"]);
  assert.equal(head(home), before);
  const settled = await recoverSync({ controllerRoot: home, apply: true });
  assert.equal(head(home), head(path.join(remotes, "world.git"), "main"));
  assert.equal(head(home, settled.findings[0].kept), before, "the lost commit stays reachable");
  assert.equal(gitIn(home, "status", "--porcelain").trim(), "");
  assert.equal((await readSyncState(home)).world.held, false);
  assert.deepEqual((await recoverSync({ controllerRoot: home })).findings, []);
});

test("a take stopped after its push is finished; a change made without the lock is set aside", { skip }, async (t) => {
  const env = await setup(t);
  const { home, remotes } = env;
  await initWorld({ controllerRoot: home });
  await releaseWorld({ controllerRoot: home });
  const work = await office(env);
  const free = lockOf(remotes, "world");
  // The office's take pushed its lock (to both remotes) and stopped before the store arrived.
  gitIn(work, "remote", "add", "mirror", path.join(remotes, "world-mirror.git"));
  await commitLock(work, { ...free, holder: "office", sequence: free.sequence + 1 }, "world: taken by office");
  gitIn(work, "push", "-q", "hub", "HEAD:refs/heads/main");
  gitIn(work, "push", "-q", "mirror", "HEAD:refs/heads/main");
  const versionFile = path.join(work, "project-version.json");
  const version = await readFile(versionFile, "utf8");
  await writeFile(versionFile, "{}");

  assert.deepEqual(kinds(await recoverSync({ controllerRoot: work })),
    ["world:changed-without-lock:set-aside", "world:take-not-finished:finish-take"]);
  const settled = await recoverSync({ controllerRoot: work, apply: true });
  assert.equal(settled.needsPerson, false);
  assert.equal(settled.findings[1].result.action, "taken");
  assert.equal(await readFile(versionFile, "utf8"), version);
  assert.match(gitIn(work, "stash", "list"), /agents-factory recover/u);
  assert.equal((await readSyncState(work)).world.held, true);
  assert.ok((await mountedProjects(work)).some((project) => project.projectId === "world"));
  assert.deepEqual((await recoverSync({ controllerRoot: work })).findings, []);
});

test("a first release of a project stopped before its commit is finished; the office can take it", { skip }, async (t) => {
  const env = await setup(t);
  const { home, remotes, base } = env;
  await initWorld({ controllerRoot: home });
  const dir = path.join(base, "packages-home", "open");
  await mkdir(dir, { recursive: true });
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "remote", "add", "hub", path.join(remotes, "open.git"));
  await unmountProject({ controllerRoot: home, projectId: "open", out: dir, confirm: "open" });

  assert.deepEqual(kinds(await recoverSync({ controllerRoot: home })), ["open:release-not-finished:finish-release"]);
  await recoverSync({ controllerRoot: home, apply: true });
  assert.deepEqual({ holder: lockOf(remotes, "open").holder, sequence: lockOf(remotes, "open").sequence }, { holder: null, sequence: 1 });
  assert.equal((await readSyncState(home)).projects.open.held, false);
  assert.deepEqual((await recoverSync({ controllerRoot: home })).findings, []);

  await releaseWorld({ controllerRoot: home });
  const work = await office(env);
  await takeWorld({ controllerRoot: work });
  assert.equal((await takeProject({ controllerRoot: work, projectId: "open" })).action, "taken");
});

test("work on both sides is left to a person, nothing is changed", { skip }, async (t) => {
  const env = await setup(t);
  const { home, remotes, base } = env;
  await initWorld({ controllerRoot: home });
  const held = lockOf(remotes, "world");
  await commitLock(home, { ...held, holder: null, sequence: held.sequence + 1 }, "world: released by home");
  const other = path.join(base, "other");
  gitIn(base, "clone", "-q", "--origin", "hub", path.join(remotes, "world.git"), other);
  await commitLock(other, { ...held, changedAtUtc: "2026-10-30T00:00:00.000Z" }, "world: edited elsewhere");
  gitIn(other, "push", "-q", "hub", "HEAD:refs/heads/main");
  const before = head(home);

  const result = await recoverSync({ controllerRoot: home, apply: true });
  assert.deepEqual(kinds(result), ["world:diverged:person"]);
  assert.equal(result.needsPerson, true);
  assert.equal(head(home), before);
  assert.equal((await readSyncState(home)).world.held, true);
});

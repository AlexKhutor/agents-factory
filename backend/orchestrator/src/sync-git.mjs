import { execFile } from "node:child_process";

import { ProjectPackageError } from "./project-package-export.mjs";

// Git for the block 3 sync (docs/project-package.md §14): no shell, no prompts
// (credentials come from the system's store or the command fails), bounded
// time and output. Line endings are kept as they are in every sync repo
// (core.autocrlf=false): a package is checked byte for byte.

const MAX_OUTPUT = 16 * 1024 * 1024;

function fail(code, detail) { throw new ProjectPackageError(code, detail); }

/** Runs git in `cwd`; `{ code, stdout, stderr }`. A non-zero exit fails unless `allowFail`. */
export function git(cwd, args, { timeoutMs = 180_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      if (code !== 0 && !allowFail) {
        const line = String(stderr || error?.message || "").trim().split(/\r?\n/u).at(-1) ?? "";
        reject(new ProjectPackageError("sync_git_failed", `git ${args[0]}: ${line.slice(0, 300)}`));
        return;
      }
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export async function isRepo(dir) {
  const result = await git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true }).catch(() => ({ code: 1 }));
  return result.code === 0;
}

/** Makes `dir` a repo on `branch` with this author and the given remotes (added or re-pointed). */
export async function ensureRepo(dir, { branch, author, remotes }) {
  if (!await isRepo(dir)) await git(dir, ["init", "-b", branch]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await git(dir, ["config", "core.safecrlf", "false"]);
  await git(dir, ["config", "user.name", author.name]);
  await git(dir, ["config", "user.email", author.email]);
  const present = new Set((await git(dir, ["remote"])).stdout.split(/\r?\n/u).filter(Boolean));
  for (const remote of remotes) {
    if (present.has(remote.name)) await git(dir, ["remote", "set-url", remote.name, remote.url]);
    else await git(dir, ["remote", "add", remote.name, remote.url]);
  }
}

/** Fetches `branch` of a remote; true when the remote has it. No connection fails (R32). */
export async function fetchBranch(dir, remote, branch) {
  const listed = await git(dir, ["ls-remote", "--heads", remote, branch], { timeoutMs: 60_000 });
  if (listed.stdout.trim() === "") return false;
  await git(dir, ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  return true;
}

/** A file of `ref`, or null when it is not there. */
export async function showFile(dir, ref, file) {
  const result = await git(dir, ["show", `${ref}:${file}`], { allowFail: true });
  return result.code === 0 ? result.stdout : null;
}

export async function head(dir) {
  const result = await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Tracked changes and untracked files that are not ignored. */
export async function localChanges(dir) {
  return (await git(dir, ["status", "--porcelain", "--untracked-files=all"])).stdout.split(/\r?\n/u).filter(Boolean);
}

/** Brings the local branch to the remote's: a fast-forward, or the first checkout of an empty repo. */
export async function fastForward(dir, remote, branch) {
  const target = `refs/remotes/${remote}/${branch}`;
  if (await head(dir) === null) {
    await git(dir, ["checkout", "-B", branch, target]);
    return;
  }
  const merged = await git(dir, ["merge", "--ff-only", target], { allowFail: true });
  if (merged.code !== 0) fail("sync_diverged", `${branch} of ${remote}`);
}

/** Stages everything git does not ignore; the staged file names. */
export async function stageAll(dir) {
  await git(dir, ["add", "-A"]);
  return (await git(dir, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
}

export async function commit(dir, message) {
  const staged = (await git(dir, ["diff", "--cached", "--name-only"])).stdout.trim();
  if (staged === "") return false;
  await git(dir, ["commit", "-q", "-m", message]);
  return true;
}

/**
 * Pushes to the primary remote (the lock's truth): a rejected push means
 * another PC moved first (`sync_race`). Then to each mirror; a mirror that
 * fails is reported, not fatal (it catches up on the next push).
 */
export async function pushAll(dir, remotes, branch) {
  const primary = remotes.find((remote) => remote.primary);
  const pushed = await git(dir, ["push", "--porcelain", primary.name, `HEAD:refs/heads/${branch}`], { allowFail: true });
  if (pushed.code !== 0) {
    if (/rejected|non-fast-forward|fetch first/iu.test(pushed.stdout + pushed.stderr)) fail("sync_race", primary.name);
    fail("sync_push_failed", `${primary.name}: ${(pushed.stderr.trim().split(/\r?\n/u).at(-1) ?? "").slice(0, 300)}`);
  }
  const mirrors = [];
  for (const remote of remotes.filter((item) => !item.primary)) {
    const result = await git(dir, ["push", "--porcelain", remote.name, `HEAD:refs/heads/${branch}`], { allowFail: true });
    mirrors.push({ remote: remote.name, pushed: result.code === 0 });
  }
  return { primary: primary.name, mirrors };
}

/** Clones the primary remote into `dir` (which must not exist) with line endings kept. */
export async function cloneRepo(parent, dir, primary, branch) {
  await git(parent, ["clone", "-q", "-c", "core.autocrlf=false", "--origin", primary.name, "--branch", branch,
    primary.url, dir], { timeoutMs: 600_000 });
}

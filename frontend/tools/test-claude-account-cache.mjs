// How long the host remembers Claude's sign-in answer: a known sign-in - a minute,
// "signed out" and "could not ask" - ten seconds (a sign-in made in the
// meantime shows within seconds); "Refresh" asks at once.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaudeAccountReader } from "../src/host/claude-account.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const root = await mkdtemp(path.join(os.tmpdir(), "atlas-claude-account-"));
const gateway = path.join(root, ".project-local", "application-gateway");
await mkdir(gateway, { recursive: true });
await writeFile(path.join(gateway, "claude-provider.json"), JSON.stringify({ schemaVersion: 1,
  sdkPath: path.join(root, "sdk", "node_modules", "@anthropic-ai", "claude-agent-sdk"), keepProviderVariables: false }));

let clock = 0;
let calls = 0;
const answers = [{ state: "signed-out" }, { state: "known", email: "owner@example.com" }, { state: "known", email: "owner@example.com" },
  { state: "known", email: "owner@example.com" }];
const reader = createClaudeAccountReader({ controllerRoot: root, now: () => clock,
  readAccount: async () => answers[Math.min(calls++, answers.length - 1)] });

const at = async (ms, options) => { clock = ms; return (await reader.read(options)).state; };
check("signed-out-is-kept-briefly",
  await at(0) === "signed-out" && await at(5_000) === "signed-out" && calls === 1
    && await at(11_000) === "known" && calls === 2, { calls });
check("known-sign-in-is-kept-a-minute",
  await at(50_000) === "known" && calls === 2 && await at(72_000) === "known" && calls === 3, { calls });
check("refresh-asks-at-once", await at(73_000, { force: true }) === "known" && calls === 4, { calls });

await rm(root, { recursive: true, force: true });

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "claude-account-cache",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

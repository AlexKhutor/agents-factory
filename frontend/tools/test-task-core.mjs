// The Plan tab's pure logic (src/renderer/task-core.js): which task it shows,
// what changed between two revisions of a plan, how far the work is, and the
// words for a task's stage. The task board will use the same.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { currentTask, isOpenTask, stepDiff, stepParts, stepProgress, taskStageWords, approvalMessage } =
  require("../src/renderer/task-core.js");

const cases = [];
const check = (caseId, condition, detail) => cases.push({ caseId, status: condition ? "passed" : "failed",
  ...(condition ? {} : { detail }) });

const done = { taskId: "task-0002", stage: "done" };
const open = { taskId: "task-0001", stage: "awaiting-approval" };
check("the-open-task-is-shown-first", currentTask([done, open]) === open && currentTask([done]) === done
  && currentTask([]) === null && isOpenTask(open) && !isOpenTask(done), { shown: currentTask([done, open]) });

const diff = stepDiff(["Read the code", "Add the button", "Test it"],
  ["Read the code", "Ask the designer", "Add the button", "Commit"]);
check("a-revision-is-marked-against-the-one-before",
  JSON.stringify(diff.map((step) => [step.change, step.text])) === JSON.stringify([
    ["same", "Read the code"], ["added", "Ask the designer"], ["same", "Add the button"],
    ["added", "Commit"], ["removed", "Test it"]]), diff);
check("steps-compare-without-case-or-spaces",
  stepDiff(["Read the code "], ["read the code"]).every((step) => step.change === "same"), stepDiff(["Read the code "], ["read the code"]));

const named = stepParts("**Read the toolbar** \u2014 its code in report-toolbar.js");
const plain = stepParts("Add a test");
const long = stepParts("Go through every report in the folder and rewrite each of their toolbars so that the export button is first");
check("a-step-has-a-short-name-and-what-exactly",
  named.named && named.name === "Read the toolbar" && named.detail === "its code in report-toolbar.js"
  && !plain.named && plain.name === "Add a test" && plain.detail === ""
  && !long.named && long.name.endsWith("\u2026") && long.name.length <= 80 && long.detail.startsWith("Go through"),
{ named, plain, long });

const working = { stage: "in-progress", stopped: null,
  steps: [{ text: "a", status: "done" }, { text: "b", status: "in-progress" }, { text: "c", status: "pending" }] };
const progress = stepProgress(working);
check("progress-names-the-step-at-work", progress.done === 1 && progress.total === 3 && progress.current === 2
  && taskStageWords(working) === "In progress: step 2 of 3", { progress, words: taskStageWords(working) });
check("a-stopped-turn-is-said-first", taskStageWords({ ...working, stopped: "failed" }).includes("failed")
  && taskStageWords({ stage: "awaiting-approval", stopped: null }) === "The plan is waiting for your approval",
{ words: taskStageWords({ ...working, stopped: "failed" }) });
check("the-approval-message-names-the-revision", approvalMessage(2) === "Plan approved (revision 2). Go ahead.",
  approvalMessage(2));

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, suite: "task-core", status: failed.length ? "failed" : "passed",
  failedCount: failed.length, cases }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;

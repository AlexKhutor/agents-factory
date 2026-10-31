// Check of the fixture's contents.
//
// The showcase exists so that the map can be judged as a whole. If it
// ever loses the failed agent, the uncertain delivery, the archive, the “orphan” or
// the question, the interface will look calmer than it really is. This
// suite makes sure that does not happen unnoticed.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERACTIONS, UNCERTAIN_AGENT, fixtureWorld } from "../src/dev/fixture-world.mjs";
import { createSession } from "../src/host/session.mjs";
import { buildWorldView } from "../src/host/memory-view.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const world = fixtureWorld();
const projects = new Set(world.scopes.filter((item) => item.kind === "project").map((item) => item.projectId));
const quarters = world.scopes.filter((item) => item.kind === "quarter");

check("world-at-prototype-scale",
  projects.size >= 6 && quarters.length >= 14 && world.agents.length >= 25,
  { projects: projects.size, quarters: quarters.length, agents: world.agents.length });

const has = (predicate) => world.agents.some(predicate);
check("all-agent-states-present",
  has((a) => a.state === "failed" && typeof a.problemCode === "string")
    && has((a) => a.deliveryState === "uncertain")
    && has((a) => a.state === "archived")
    && has((a) => a.deliveryState === "pending" && a.contentState === "empty")
    && has((a) => a.deliveredManifest !== null),
  world.agents.map((a) => `${a.agentId}:${a.state}/${a.deliveryState}`));

check("uncertain-send-reachable",
  world.agents.some((a) => a.agentId === UNCERTAIN_AGENT),
  UNCERTAIN_AGENT);

check("every-memory-entry-has-an-id",
  world.scopes.every((item) => item.entries.every((entry) => typeof entry.id === "string" && entry.id !== "")),
  world.scopes.filter((item) => item.entries.some((entry) => entry.id === undefined)).map((i) => i.scopeId));

const kinds = Object.values(INTERACTIONS).flat().map((record) => record.display.kind);
check("two-question-kinds-with-allowed-answers",
  kinds.includes("command-approval") && kinds.includes("user-input")
    && Object.values(INTERACTIONS).flat()
      .every((record) => Array.isArray(record.interactionRequest.allowedResponses)
        && record.interactionRequest.allowedResponses.length > 0
        && record.interactionRequest.owner.actorType === "local-operator"),
  kinds);

// The projection is what the window will actually see.
const session = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
const view = await buildWorldView(session.gateway, { desktop: session.kit.desktop });

check("projection-ready", view.status === "ready", view.status);

check("unresolvable-membership-shown-as-omission",
  view.projection.omissions.some((item) => item.kind === "agent" && item.reason === "membership_unavailable"),
  view.projection.omissions);

check("attention-built-from-what-is-observed",
  view.attention.length >= 4
    && view.attention.some((item) => item.kind === "interaction")
    && view.attention.some((item) => item.kind === "problem")
    && view.attention.some((item) => item.kind === "state"),
  view.attention.map((item) => `${item.kind}:${item.agentId}`));

// The world lead: the one coordinator, in the world project's headquarters
// quarter - what the world headquarters on the map stands for.
{
  const worldProject = view.projection.projects.find((project) => project.projectId === "world") ?? null;
  const leads = view.projection.projects.flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents))
    .filter((agent) => agent.settings?.role === "coordinator");
  check("world-with-world-lead",
    worldProject !== null && leads.length === 1 && leads[0].projectId === "world" && leads[0].quarterId === "hq"
      && worldProject.quarters.map((quarter) => quarter.quarterId).join() === "hq",
    { worldProject: worldProject?.quarters.map((quarter) => quarter.quarterId), leads: leads.map((agent) => agent.agentId) });
}

// Progress is never reported, so it stays null. Attention is only what the
// catalog captured (Kit v0.15.0): null, or an object marked captured-only.
check("progress-not-invented-attention-only-captured",
  view.projection.projects.every((project) => project.quarters.every((quarter) => quarter.agents
    .every((agent) => agent.taskProgress === null
      && (agent.attention === null || agent.attention.coverage === "captured-only")))),
  "taskProgress must stay null, attention - null or captured-only");

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "fixture-shape",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

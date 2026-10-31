// A LIVE check before a release (roadmap step 1, track A). It spends a little provider quota: one short turn
// per agent named.
//
// For each agent: a process connects to the running Gateway as the window does (config/local.json, the
// verified kit, the same host modules), sends a short message and exits at once - the window closed in the
// middle of the turn. Then a new connection follows that send to its end and checks that:
//   - the turn finished by itself (the Gateway does not need the window);
//   - it is the same agent with the same provider session (the reconnect finds it, nothing is re-created);
//   - the answer is in the agent's conversation.
// Run it only when the person at this PC has decided these turns may happen.
//
//   node tools/test-gateway-smoke-live.mjs --agent <agentId> [--agent <agentId> ...] [--seconds 300]

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMode } from "../src/host/config.mjs";
import { createSession } from "../src/host/session.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const TEXT = "This is an automatic check of Atlas. Reply with the single word: ok";
const values = (name) => process.argv.flatMap((item, index) => (item === name ? [process.argv[index + 1]] : [])).filter(Boolean);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const session = await createSession({ projectRoot: PROJECT_ROOT, mode: resolveMode(), confirm: async () => true,
    chooseDirectory: async () => null });
  if (session.gateway === null) throw new Error(`no Gateway: ${JSON.stringify(session.configuration)}`);
  return session;
}

async function agentRecord(session, agentId) {
  const read = await session.gateway.run("query.memory.agents.list", {});
  const agents = read.ok && read.result.outcome === "succeeded" ? read.result.output.agents : [];
  return agents.find((agent) => agent.agentId === agentId) ?? null;
}

// --- the first window: send, then go away ---------------------------------------------------------

if (process.argv.includes("--phase-send")) {
  const [agentId] = values("--agent");
  const session = await connect();
  const before = await agentRecord(session, agentId);
  const sent = await session.mutations.send({ agentId, text: TEXT });
  process.stdout.write(`${JSON.stringify({ threadId: before?.binding?.threadId ?? null, sent: sent.ok ? {
    outcome: sent.data.outcome, operationId: sent.data.identity?.operationId ?? null } : { error: sent.error } })}\n`);
  // The process ends here, with its turn still running: as when the window is closed.
  process.exit(0);
}

// --- the check ----------------------------------------------------------------------------------

const agents = values("--agent");
const seconds = Number(values("--seconds")[0] ?? 300);
if (agents.length === 0) {
  process.stderr.write("usage: node tools/test-gateway-smoke-live.mjs --agent <agentId> [--agent <agentId> ...]\n");
  process.exit(2);
}
const checks = [];
const note = (name, ok, detail) => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
};

for (const agentId of agents) {
  const first = await new Promise((resolve) => execFile(process.execPath, [SELF, "--phase-send", "--agent", agentId],
    { cwd: PROJECT_ROOT, windowsHide: true, timeout: 120_000 }, (error, stdout) => {
      try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/u).at(-1))); } catch { resolve({ error: error?.message ?? "no answer" }); }
    }));
  const operationId = first.sent?.operationId ?? null;
  note(`${agentId}: sent, and the sending process is gone`,
    ["accepted", "succeeded"].includes(first.sent?.outcome) && operationId !== null, first);
  if (operationId === null) continue;
  await pause(3000);
  const session = await connect();
  let state = null;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const receipt = await session.mutations.sendReceipt({ agentId, operationId });
    state = receipt.ok ? receipt.data.output : null;
    if (state !== null && state.observation === "terminal") break;
    await pause(2000);
  }
  note(`${agentId}: the turn finished with no window`, state?.state === "completed", state?.state ?? "no receipt");
  const after = await agentRecord(session, agentId);
  note(`${agentId}: the reconnect finds the same agent and session`,
    after !== null && first.threadId !== null && after.binding?.threadId === first.threadId,
    { before: first.threadId, after: after?.binding?.threadId ?? null });
  const page = await session.gateway.run("query.agent-conversation.read", { agentId, limit: 20 });
  const content = page.ok && page.result.outcome === "succeeded" ? page.result.output.content ?? [] : [];
  const answer = content.filter((item) => item.contentClass === "assistant-message").at(-1)?.text ?? "";
  note(`${agentId}: the answer is in the conversation`, /\bok\b/iu.test(answer), answer.slice(0, 80));
}
const failed = checks.filter((check) => !check.ok);
process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);

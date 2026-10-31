// Whether the servers of the agents' models answer (src/host/model-health.mjs, owner 31.10).
//
// A local server stands in for the model servers: it answers 200, 401 (a server asking for its key - it is
// there) and 502 (a proxy whose model is off); a closed port and a server that never answers stand for an
// office PC that is off. The host spends no tokens: one GET per address, kept a little, asked again on
// "Check now".

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModelHealth } from "../src/host/model-health.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const hits = new Map();
const server = createServer((request, response) => {
  hits.set(request.url, (hits.get(request.url) ?? 0) + 1);
  if (request.url === "/silent") return; // never answers
  const status = { "/ok": 200, "/key": 401, "/proxy": 502 }[request.url] ?? 404;
  response.writeHead(status).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const closed = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

const root = await mkdtemp(path.join(tmpdir(), "atlas-model-health-"));
try {
  const config = path.join(root, ".project-local", "application-gateway");
  await mkdir(config, { recursive: true });
  const models = [
    { id: "local", displayName: "Qwen (this PC)", check: `${base}/ok` },
    { id: "keyed", check: `${base}/key` },
    { id: "office", displayName: "Qwen (office)", check: `${base}/proxy` },
    { id: "off", check: `http://127.0.0.1:${closed}/health` },
    { id: "hung", check: `${base}/silent` },
    { id: "twin", check: `${base}/ok` },
    { id: "unchecked" },
  ];
  await writeFile(path.join(config, "acp-provider.json"), JSON.stringify({ schemaVersion: 1, models }));
  let clock = Date.parse("2026-10-31T09:00:00.000Z");
  const health = createModelHealth({ controllerRoot: root, now: () => clock, timeoutMs: 400, keepMs: 30_000 });

  const first = await health.read();
  const state = Object.fromEntries(first.models.map((model) => [model.id, model.state]));
  check("each-server-is-named-by-its-answer", JSON.stringify(state) === JSON.stringify({ local: "answers", keyed: "answers",
    office: "not-answering", off: "not-answering", hung: "not-answering", twin: "answers", unchecked: "not-checked" }), state);
  const byId = (answer, id) => answer.models.find((model) => model.id === id);
  check("what-the-window-shows", byId(first, "local").name === "Qwen (this PC)" && byId(first, "keyed").name === "keyed"
    && byId(first, "office").httpStatus === 502 && byId(first, "hung").reason === "timeout"
    && byId(first, "off").reason === "unreachable" && byId(first, "local").address === `127.0.0.1:${server.address().port}`
    && byId(first, "local").checkedAtUtc === "2026-10-31T09:00:00.000Z" && byId(first, "unchecked").checkedAtUtc === null,
  first.models);
  check("one-request-per-address", hits.get("/ok") === 1, Object.fromEntries(hits));

  clock += 10_000;
  await health.read();
  check("answers-are-kept-a-little", hits.get("/ok") === 1, Object.fromEntries(hits));
  await health.read({ force: true });
  check("check-now-asks-again", hits.get("/ok") === 2, Object.fromEntries(hits));
  clock += 31_000;
  await health.read();
  check("then-asked-again", hits.get("/ok") === 3, Object.fromEntries(hits));

  const none = await createModelHealth({ controllerRoot: path.join(root, "absent") }).read();
  check("no-acp-provider-nothing-to-check", none.state === "none", none);
  await writeFile(path.join(config, "acp-provider.json"), "{ broken");
  check("a-broken-config-is-a-failure-not-a-crash", (await health.read()).state === "failed");
} finally {
  server.closeAllConnections?.();
  server.close();
  await rm(root, { recursive: true, force: true });
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, suite: "model-health", status: failed.length === 0 ? "passed" : "failed",
  failedCount: failed.length, cases }, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

// The layout of a split instance (backend docs/project-package.md §9).
//
// The world's part - the HQ and where each project stands; a project's part - its frame,
// notes, quarters and agents, beside its store, and it goes into the package with
// it. The camera stays on this PC. Of a project that is not on this PC, the world
// keeps only the place and size of the frame: its notes are in its package.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLayoutStore, emptyLayout } from "../src/host/layout-store.mjs";
import {
  createInstanceLayoutStore, createSplitLayoutStore, isSplitInstance, mountedProjectFolders,
} from "../src/host/layout-split.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const base = await mkdtemp(path.join(os.tmpdir(), "atlas-layout-split-"));
const root = path.join(base, "instance");
const userData = path.join(base, "user-data");
const put = async (relative, value) => {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
};
const json = async (relative) => JSON.parse(await readFile(path.join(root, ...relative.split("/")), "utf8"));
await put(".project-local/projects/store-layout.v1.json", { schemaVersion: 1, layout: "split" });
await put(".project-local/projects/alpha/project.json", { schemaVersion: 1, projectId: "alpha" });
await put(".project-local/projects/world/project.json", { schemaVersion: 1, projectId: "world" });
await put(".world/registry.json", { schemaVersion: 1, projects: { alpha: { title: "Alpha" }, home: { title: "Home" } } });

const legacy = createLayoutStore({ directory: userData, environment: "live-test" });
const old = {
  ...emptyLayout(),
  projects: {
    world: { x: -500, y: 0, width: 300, height: 200 },
    alpha: { x: 0, y: 0, width: 400, height: 300, note: "alpha's note", symbol: "\u0410" },
    home: { x: 600, y: 0, width: 400, height: 300, note: "home's note", role: "mods" },
    gone: { x: 900, y: 0, width: 200, height: 200, note: "old project" },
  },
  quarters: { alpha: { q1: { x: 10, y: 40, width: 160, height: 100 } }, home: { q1: { x: 10, y: 40, width: 160, height: 100 } } },
  agents: { "alpha-agent": { x: 20, y: 50, note: "alpha's agent" }, "home-agent": { x: 20, y: 50, note: "home's agent" } },
  view: { x: 1, y: 2, scale: 0.5 },
};
await legacy.write(old);

check("split-instance-marker", await isSplitInstance(root) && !(await isSplitInstance(base)), null);
check("connected-projects", (await mountedProjectFolders(root)).map((item) => item.projectId).sort().join() === "alpha,world", null);

const store = createSplitLayoutStore({ controllerRoot: root, legacy, directory: userData, environment: "live-test" });
{
  const first = await store.read();
  check("first-read-takes-the-old-file", first.ok && first.data.layout.projects.alpha.note === "alpha's note",
    first.data?.source);
}
{
  const membership = { "alpha-agent": "alpha", "home-agent": "home" };
  const saved = await store.write(old, membership);
  check("write-is-split", saved.ok === true && saved.data.reloadProjects.length === 0, saved.error ?? saved.data);
  const world = await json(".world/layout/world.json");
  const alpha = await json(".project-local/projects/alpha/layout.json");
  check("world-holds-projects-places-and-hq",
    world.projects.world.width === 300 && world.projects.alpha.x === 0 && world.projects.alpha.note === undefined,
    world.projects);
  check("project-holds-its-frame-quarters-agents",
    alpha.project.note === "alpha's note" && alpha.project.x === undefined && alpha.quarters.q1.width === 160
      && alpha.agents["alpha-agent"].note === "alpha's agent", alpha);
  const worldText = JSON.stringify(world);
  check("project-not-on-this-pc-has-only-its-place-in-the-world",
    world.projects.home.x === 600 && world.projects.home.width === 400 && !worldText.includes("home's note")
      && !worldText.includes("home's agent") && !worldText.includes("mods"), world);
  check("forgotten-project-is-kept-whole", world.projects.gone.note === "old project", world.projects.gone);
  const view = JSON.parse(await readFile(path.join(userData, "layouts", "live-test.view.json"), "utf8"));
  check("camera-on-this-pc", view.scale === 0.5 && world.view === undefined, view);
}
{
  const back = await store.read();
  const layout = back.data.layout;
  check("read-assembles-the-parts",
    back.ok && back.data.source === "split" && layout.projects.alpha.note === "alpha's note" && layout.projects.alpha.x === 0
      && layout.quarters.alpha.q1.width === 160 && layout.agents["alpha-agent"].note === "alpha's agent"
      && layout.projects.home.note === undefined && layout.view.scale === 0.5, layout);
}
{
  // A project was connected while the window is open: its part from the package is not overwritten
  // by the window's map, and the window is asked to read the map again.
  const membership = { "alpha-agent": "alpha" };
  await put(".project-local/projects/alpha/layout.json", {
    schemaVersion: 1, projectId: "alpha", updatedAtUtc: "2030-01-01T00:00:00.000Z",
    project: { note: "a note from another PC" }, quarters: { q2: { x: 5, y: 40, width: 160, height: 100 } }, agents: {},
  });
  const stale = await store.write(old, membership);
  const kept = await json(".project-local/projects/alpha/layout.json");
  check("connected-project-is-not-overwritten",
    stale.ok && stale.data.reloadProjects.join() === "alpha" && kept.project.note === "a note from another PC"
      && kept.quarters.q1 === undefined, { result: stale.data, kept });
  const fresh = (await store.read()).data.layout;
  const next = await store.write(fresh, membership);
  const after = await json(".project-local/projects/alpha/layout.json");
  check("after-reading-again-writes-as-usual",
    fresh.projects.alpha.note === "a note from another PC" && fresh.projects.alpha.x === 0 && fresh.quarters.alpha.q2.width === 160
      && next.ok && next.data.reloadProjects.length === 0 && after.project.note === "a note from another PC",
    { fresh: fresh.projects.alpha, next: next.data });
}
{
  // The window does not know whose an agent is (the world is not read yet, the Gateway paused): the agent's place
  // stays in its project's part, and an agent of a project not on this PC does not get into the world.
  const layout = (await store.read()).data.layout;
  layout.agents["alpha-agent"] = { x: 21, y: 51, note: "alpha's agent" };
  await store.write(layout, { "alpha-agent": "alpha" });
  layout.agents["alpha-agent"] = { x: 22, y: 52, note: "alpha's agent" };
  layout.agents["home-agent"] = { x: 20, y: 50, note: "home's agent" };
  const blind = await store.write(layout, {});
  const part = await json(".project-local/projects/alpha/layout.json");
  const world = await json(".world/layout/world.json");
  check("agent-without-facts-stays-in-its-project",
    blind.ok && part.agents["alpha-agent"]?.x === 22 && world.agents["alpha-agent"] === undefined
      && !JSON.stringify(world).includes("home's agent"), { part, world });
}
{
  // The window read the map before taking the world brought a project's place from another PC:
  // its write does not erase that place.
  const layout = (await store.read()).data.layout;
  delete layout.projects.home;
  const blind = await store.write(layout, { "alpha-agent": "alpha" });
  const world = await json(".world/layout/world.json");
  check("project-place-from-another-pc-is-not-erased",
    blind.ok && world.projects.home?.x === 600 && world.projects.home?.width === 400 && world.projects.home?.note === undefined,
    world.projects.home);
}
{
  // The instance's store: split - the parts, ordinary - the old file.
  const plain = await createInstanceLayoutStore({ controllerRoot: base, legacy, directory: userData, environment: "live-test" }).read();
  const split = await createInstanceLayoutStore({ controllerRoot: root, legacy, directory: userData, environment: "live-test" }).read();
  check("store-by-instance", plain.ok && plain.data.source !== "split" && split.ok && split.data.source === "split",
    { plain: plain.data?.source, split: split.data?.source });
}
{
  // A project was disconnected while the window is open: its part is not created again.
  await rm(path.join(root, ".project-local", "projects", "alpha"), { recursive: true });
  const registry = await json(".world/registry.json");
  const again = await store.write((await store.read()).data.layout, { "alpha-agent": "alpha" });
  let recreated = true;
  try { await readFile(path.join(root, ".project-local", "projects", "alpha", "layout.json")); } catch { recreated = false; }
  check("disconnected-project-does-not-come-back", again.ok === true && !recreated && registry.projects.alpha !== undefined, again.error);
}

await rm(base, { recursive: true, force: true });

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "map-layout-split",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

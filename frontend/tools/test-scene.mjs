// A check of the map's pure logic.
//
// These are rules the person feels but cannot read off the screen: that
// the level is counted from the reference scale, that each level picks its own target,
// that a growing project moves nothing, that “move back” is not an undo, and
// that the minimap takes you where you aim.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "scene-core.js",
));

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};
const clone = (value) => structuredClone(value);
const viewport = { width: 1400, height: 800 };

// --- levels -------------------------------------------------------------------

{
  const { LEVEL, levelFor, referenceScale } = core;
  const base = referenceScale(viewport);
  const world = levelFor({ x: 0, y: 0, scale: base * 0.4 }, viewport);
  const project = levelFor({ x: 0, y: 0, scale: base * 1.2 }, viewport);
  const quarter = levelFor({ x: 0, y: 0, scale: base * 3 }, viewport);
  const workspace = levelFor({ x: 0, y: 0, scale: base }, viewport, 0, true);
  check("level-counts-from-reference-scale",
    world === LEVEL.world && project === LEVEL.project
      && quarter === LEVEL.quarter && workspace === LEVEL.workspace,
    { base, world, project, quarter, workspace });
}

{
  // Entered a project: its scale becomes the reference, and the same absolute scale
  // now means another level. This is exactly how the prototype switches the level of detail.
  const { LEVEL, levelFor } = core;
  const absolute = 0.5;
  const asWorld = levelFor({ scale: absolute }, viewport, 0);
  const insideProject = levelFor({ scale: absolute }, viewport, 0.2);
  check("entering-project-changes-reference-not-scale",
    asWorld !== insideProject && insideProject === LEVEL.quarter && asWorld === LEVEL.world,
    { asWorld, insideProject });
}

{
  const { LEVEL, selectableAtLevel } = core;
  check("each-level-picks-its-own",
    selectableAtLevel(LEVEL.world) === "project"
      && selectableAtLevel(LEVEL.project) === "quarter"
      && selectableAtLevel(LEVEL.quarter) === "agent",
    [selectableAtLevel(LEVEL.world), selectableAtLevel(LEVEL.project), selectableAtLevel(LEVEL.quarter)]);
}

// --- camera -------------------------------------------------------------------

{
  const { advanceCamera } = core;
  let camera = { x: 0, y: 0, scale: 1 };
  const target = { x: 400, y: -200, scale: 0.25 };
  let frames = 0;
  while (!camera.settled && frames < 600) {
    camera = advanceCamera(camera, target, 16.67);
    frames += 1;
  }
  const instant = advanceCamera({ x: 0, y: 0, scale: 1 }, target, 16.67, { instant: true });
  check("camera-arrives-and-can-jump-instantly",
    camera.settled === true && frames > 5 && frames < 140
      && camera.x === target.x && instant.settled === true && instant.scale === target.scale,
    { frames, camera });
}

// --- geometry -----------------------------------------------------------------

function worldFixture() {
  const layout = { schemaVersion: 1, projects: {}, quarters: {}, agents: {} };
  core.autoPlaceProject(layout, "alpha", 0);
  core.autoPlaceQuarter(layout, "alpha", "q1", 0);
  core.autoPlaceQuarter(layout, "alpha", "q2", 1);
  core.autoPlaceAgent(layout, "agent-1", 0);
  return layout;
}

const projection = () => ({
  projects: [{
    projectId: "alpha",
    quarters: [
      { quarterId: "q1", agents: [{ agentId: "agent-1" }] },
      { quarterId: "q2", agents: [] },
    ],
  }],
});

{
  // The frame hugs the content: a quarter dragged to the right grows the project, and
  // one brought back shrinks it again; the project's origin does not move.
  const layout = worldFixture();
  const before = clone(layout.projects.alpha);
  core.moveQuarter(layout, "alpha", "q1", 900, 0);
  const grown = clone(layout.projects.alpha);
  core.moveQuarter(layout, "alpha", "q1", -900, 0);
  const after = layout.projects.alpha;
  check("frame-hugs-content",
    grown.width > before.width && after.width === before.width
      && after.x === before.x && after.y === before.y,
    { before, grown, after });
}

{
  // A quarter dragged past the left or top edge stops at the border:
  // the project neither moves nor grows to the left or up, the neighbours stay in place.
  const { GEOMETRY, overlapsHeadquarters } = core;
  const layout = worldFixture();
  const otherBefore = clone(layout.quarters.alpha.q1);
  const projectBefore = clone(layout.projects.alpha);
  core.moveQuarter(layout, "alpha", "q2", -900, -900);
  const q2 = layout.quarters.alpha.q2;
  check("quarter-past-edge-does-not-move-project",
    layout.projects.alpha.x === projectBefore.x && layout.projects.alpha.y === projectBefore.y
      && JSON.stringify(layout.quarters.alpha.q1) === JSON.stringify(otherBefore)
      && q2.x >= GEOMETRY.projectPadding && q2.y >= GEOMETRY.projectHeader
      && !overlapsHeadquarters(layout.projects.alpha, q2),
    { projectBefore, project: layout.projects.alpha, q2 });
}

{
  const layout = worldFixture();
  core.moveQuarter(layout, "alpha", "q1", 700, 400);
  const grown = clone(layout.projects.alpha);
  core.moveQuarter(layout, "alpha", "q1", -700, -400);
  core.compactProject(layout, "alpha");
  check("only-fit-shrinks",
    layout.projects.alpha.width < grown.width && layout.projects.alpha.height < grown.height,
    { grown, compacted: layout.projects.alpha });
}

{
  const layout = worldFixture();
  core.moveAgent(layout, "alpha", "q1", "agent-1", 5000, 5000);
  const agent = layout.agents["agent-1"];
  const quarter = layout.quarters.alpha.q1;
  check("agent-stays-inside-quarter",
    agent.x < quarter.width && agent.y < quarter.height && agent.x > 0 && agent.y > 0,
    { agent, quarter });
}

// --- hit testing ------------------------------------------------------------------

{
  const { LEVEL } = core;
  const layout = worldFixture();
  const project = layout.projects.alpha;
  const quarter = layout.quarters.alpha.q1;
  const agent = layout.agents["agent-1"];
  const point = {
    x: project.x + quarter.x + agent.x,
    y: project.y + quarter.y + agent.y,
  };
  const atQuarterLevel = core.hitTest(projection(), layout, point, LEVEL.quarter, {});
  const atProjectLevel = core.hitTest(projection(), layout, point, LEVEL.project, {});
  const atWorldLevel = core.hitTest(projection(), layout, point, LEVEL.world, {});
  // A unit can be reached at any scale: the person must be able to open an agent without
  // hunting for the right zoom.
  check("unit-picked-at-any-level",
    atQuarterLevel.kind === "agent" && atProjectLevel.kind === "agent"
      && atWorldLevel.kind === "agent",
    { atQuarterLevel, atProjectLevel, atWorldLevel });
}

{
  const { LEVEL } = core;
  const layout = worldFixture();
  const project = layout.projects.alpha;
  const quarter = layout.quarters.alpha.q2;
  // A point inside the quarter but away from the agents.
  const point = {
    x: project.x + quarter.x + quarter.width - 12,
    y: project.y + quarter.y + quarter.height - 12,
  };
  const atWorld = core.hitTest(projection(), layout, point, LEVEL.world, {});
  const background = core.hitTest(projection(), layout,
    { x: project.x + 6, y: project.y + 6 }, LEVEL.world, {});
  check("quarter-and-project-told-apart-in-world-too",
    atWorld.kind === "quarter" && atWorld.quarterId === "q2" && background.kind === "project",
    { atWorld, background });
}

{
  const { LEVEL, GEOMETRY } = core;
  const layout = worldFixture();
  const project = layout.projects.alpha;
  const box = core.headquartersBox();
  const centre = { x: project.x + box.x + box.width / 2, y: project.y + box.y + box.height / 2 };
  const hq = core.hitTest(projection(), layout, centre, LEVEL.project, {});
  const fromWorld = core.hitTest(projection(), layout, centre, LEVEL.world, {});
  const outside = core.hitTest(projection(), layout,
    { x: centre.x + GEOMETRY.hqWidth, y: centre.y }, LEVEL.project, {});
  const projectCentre = core.hitTest(projection(), layout,
    { x: project.x + project.width / 2, y: project.y + project.height / 2 }, LEVEL.project, {});
  // The main building is a target at every level, the overview included; it stands in
  // the top left corner of the project, under the title, not in the centre.
  check("hq-is-own-target-in-project-top-left-corner",
    hq.kind === "hq" && fromWorld.kind === "hq" && outside.kind !== "hq" && projectCentre.kind !== "hq"
      && box.x === GEOMETRY.projectPadding && box.y === GEOMETRY.projectHeader,
    { hq, fromWorld, outside, projectCentre, box });
}

{
  const { LEVEL, GEOMETRY } = core;
  const layout = worldFixture();
  const project = layout.projects.alpha;
  const quarter = layout.quarters.alpha.q1;
  const agentNode = { kind: "agent", projectId: "alpha", quarterId: "q1", agentId: "agent-1" };
  const body = {
    x: project.x + quarter.x + quarter.width / 2,
    y: project.y + quarter.y + quarter.height - 10,
  };
  const header = { x: body.x, y: project.y + quarter.y + 10 };
  // What is under the cursor is dragged, at any level: an agent drags the agent, a quarter
  // drags the quarter (by any spot), the HQ and the grounds drag the project.
  const quarterNode = { kind: "quarter", projectId: "alpha", quarterId: "q1", agentId: null };
  const at = (node) => core.hitTest(projection(), layout, node, LEVEL.world);
  const agentPoint = {
    x: project.x + quarter.x + layout.agents["agent-1"].x,
    y: project.y + quarter.y + layout.agents["agent-1"].y,
  };
  const targets = [at(agentPoint), at(body), at(header)].map((node) => core.dragTargetFor(node));
  const hqTarget = core.dragTargetFor({ kind: "hq", projectId: "alpha", quarterId: null, agentId: null });
  check("drags-what-is-under-cursor-at-any-level",
    targets[0]?.kind === "agent" && targets[0].agentId === agentNode.agentId
      && targets[1]?.kind === "quarter" && targets[1].quarterId === quarterNode.quarterId
      && targets[2]?.kind === "quarter" && hqTarget.kind === "project"
      && core.dragTargetFor(null) === null,
    { targets, hqTarget });
}

{
  const layout = worldFixture();
  const project = layout.projects.alpha;
  const quarter = layout.quarters.alpha.q2;
  const inside = {
    x: project.x + quarter.x + quarter.width / 2,
    y: project.y + quarter.y + quarter.height / 2,
  };
  const scope = core.inferScope(projection(), layout, inside, { projectId: null, quarterId: null });
  const empty = core.inferScope(projection(), layout, { x: -9e5, y: -9e5 }, scope);
  check("active-area-found-by-point",
    scope.projectId === "alpha" && scope.quarterId === "q2"
      && empty.projectId === "alpha",
    { scope, empty });
}

// --- history --------------------------------------------------------------------

{
  const layout = worldFixture();
  let state = layout;
  const history = core.createHistory({
    snapshot: () => clone(state),
    restore: (value) => { state = clone(value); },
  });
  const widthBefore = state.projects.alpha.width;
  history.begin("Move quarter");
  core.moveQuarter(state, "alpha", "q1", 900, 0);
  history.commit();
  const widthAfter = state.projects.alpha.width;
  const label = history.undo();
  const restored = state.projects.alpha.width === widthBefore;
  history.redo();
  check("one-gesture-with-growth-undone-in-one-step",
    widthAfter > widthBefore && label === "Move quarter" && restored
      && state.projects.alpha.width === widthAfter,
    { widthBefore, widthAfter, restored });
}

// --- attention and minimap --------------------------------------------------------

{
  const rolled = core.aggregateAttention({
    attention: [
      { kind: "interaction", agentId: "a1", projectId: "alpha", quarterId: "q1" },
      { kind: "problem", agentId: "a2", projectId: "alpha", quarterId: "q1" },
      { kind: "state", agentId: "a3", projectId: "beta", quarterId: "q9" },
    ],
  });
  check("attention-rolls-up-with-worst-severity",
    rolled.total === 3 && rolled.byProject.get("alpha").count === 2
      && rolled.byProject.get("alpha").severity === 3
      && rolled.byQuarter.get("alpha/q1").count === 2,
    [...rolled.byProject.entries()]);
}

{
  // A ready answer is a calm mark; a failed turn waits for the person, like a state failure.
  const rolled = core.aggregateAttention({
    attention: [
      { kind: "turn-finished", outcome: "completed", agentId: "ok", projectId: "alpha", quarterId: "q1" },
      { kind: "turn-finished", outcome: "failed", agentId: "bad", projectId: "alpha", quarterId: "q1" },
    ],
  });
  check("failed-turn-pulses-an-answer-does-not",
    rolled.byAgent.get("ok").urgent === false && rolled.byAgent.get("ok").severity === 1
      && rolled.byAgent.get("bad").urgent === true && rolled.byAgent.get("bad").severity === 2,
    [...rolled.byAgent.entries()]);
}

{
  const bounds = { x: -200, y: -100, width: 1600, height: 900 };
  const transform = core.minimapTransform(bounds, { width: 190, height: 140 });
  const roundTrip = transform.toWorld(...Object.values(transform.toMap(500, 400)));
  const centre = transform.toMap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  check("minimap-converts-both-ways",
    Math.abs(roundTrip.x - 500) < 0.001 && Math.abs(roundTrip.y - 400) < 0.001
      && Math.abs(centre.x - 95) < 0.001 && Math.abs(centre.y - 70) < 0.001,
    { roundTrip, centre });
}

// --- “Fit” does not put the HQ on a quarter ---------------------------------------

{
  // The HQ always stands in the centre of the project. Shrinking a project with one quarter to
  // the size of the quarter means putting the HQ right on it: the cursor then finds
  // the HQ before the quarter, and the whole project is dragged instead of the quarter - “spreading”
  // the project back out becomes impossible.
  const { compactProject, overlapsHeadquarters, autoPlaceProject, autoPlaceQuarter } = core;
  const layout = { projects: {}, quarters: {}, agents: {} };
  autoPlaceProject(layout, "solo", 0);
  autoPlaceQuarter(layout, "solo", "only", 0);
  compactProject(layout, "solo");
  const project = layout.projects.solo;
  const quarter = layout.quarters.solo.only;
  check("fit-leaves-hq-free",
    !overlapsHeadquarters(project, quarter)
      && quarter.x >= 0 && quarter.y >= 0
      && quarter.x + quarter.width <= project.width && quarter.y + quarter.height <= project.height,
    { project, quarter });
}

{
  // And it still shrinks: a project that grew around a quarter dragged far away, after
  // the quarter is brought back and “Fit”, becomes smaller than it was.
  const { compactProject, moveQuarter, autoPlaceProject, autoPlaceQuarter } = core;
  const layout = { projects: {}, quarters: {}, agents: {} };
  autoPlaceProject(layout, "p", 0);
  autoPlaceQuarter(layout, "p", "q1", 0);
  autoPlaceQuarter(layout, "p", "q2", 1);
  moveQuarter(layout, "p", "q2", 900, 700);
  const grown = { ...layout.projects.p };
  moveQuarter(layout, "p", "q2", -900, -700);
  compactProject(layout, "p");
  const compacted = layout.projects.p;
  check("fit-still-shrinks",
    compacted.width < grown.width && compacted.height < grown.height, { grown, compacted });
}

{
  // Auto layout: a third quarter grows the project downward, the project centre shifts, and
  // the HQ landed on the top row - a quarter under the HQ could be neither clicked
  // nor have its menu opened (“Enter quarter” did not appear).
  const { overlapsHeadquarters, autoPlaceProject, autoPlaceQuarter } = core;
  const results = [1, 2, 3, 5, 8].map((count) => {
    const layout = { projects: {}, quarters: {}, agents: {} };
    autoPlaceProject(layout, "p", 0);
    for (let index = 0; index < count; index += 1) autoPlaceQuarter(layout, "p", `q${index}`, index);
    const project = layout.projects.p;
    const covered = Object.entries(layout.quarters.p)
      .filter(([, quarter]) => overlapsHeadquarters(project, quarter)).map(([id]) => id);
    return { count, size: `${project.width}x${project.height}`, covered };
  });
  check("auto-layout-does-not-put-hq-on-quarter",
    results.every((result) => result.covered.length === 0), results);
}

{
  // A quarter never goes onto the HQ, not even for a moment: dragging into the HQ zone puts
  // it at the near edge of the zone, and when the cursor leaves the zone, the quarter follows
  // it again. An agent lives inside its quarter, so it does not land on the HQ either.
  const { placeQuarter, moveQuarter, moveAgent, overlapsHeadquarters, headquartersZone,
    autoPlaceProject, autoPlaceQuarter, autoPlaceAgent } = core;
  const layout = { projects: {}, quarters: {}, agents: {} };
  autoPlaceProject(layout, "p", 0);
  for (const [index, id] of ["q0", "q1", "q2"].entries()) autoPlaceQuarter(layout, "p", id, index);
  autoPlaceAgent(layout, "a1", 0);
  const zone = headquartersZone();
  const path = [];
  const desired = { x: layout.quarters.p.q1.x, y: layout.quarters.p.q1.y };
  for (const [dx, dy] of [[0, -150], [0, -100], [-40, 0], [200, 0], [300, 0]]) {
    desired.x += dx;
    desired.y += dy;
    const { shifted } = placeQuarter(layout, "p", "q1", desired.x, desired.y);
    desired.x += shifted.x;
    desired.y += shifted.y;
    path.push({ ...layout.quarters.p.q1, inZone: overlapsHeadquarters(layout.projects.p, layout.quarters.p.q1) });
  }
  const last = { ...layout.quarters.p.q1 };
  moveQuarter(layout, "p", "q2", -1000, -1000);
  moveAgent(layout, "p", "q2", "a1", -1000, -1000);
  const q2 = layout.quarters.p.q2;
  check("quarter-stays-off-hq-and-catches-up-with-cursor",
    path.every((step) => !step.inZone)
      && last.x === Math.max(desired.x, core.GEOMETRY.projectPadding)
      && last.y === Math.max(desired.y, core.GEOMETRY.projectHeader)
      && !overlapsHeadquarters(layout.projects.p, q2)
      && (q2.x >= zone.x + zone.width || q2.y >= zone.y + zone.height),
    { path, last, desired, q2, zone });
}

{
  // A layout saved when the HQ stood in the centre could put a quarter in
  // the present corner of the HQ. clearHeadquarters moves it to the right or lower - to
  // a place where it touches no neighbours; the other quarters do not move.
  const { clearHeadquarters, overlapsHeadquarters, autoPlaceProject } = core;
  const layout = { projects: {}, quarters: {}, agents: {} };
  autoPlaceProject(layout, "p", 0);
  layout.quarters.p = {
    old: { x: 40, y: 96, width: 300, height: 210 },
    right: { x: 374, y: 96, width: 300, height: 210 },
  };
  const rightBefore = JSON.stringify(layout.quarters.p.right);
  const moved = clearHeadquarters(layout, "p");
  const boxes = Object.values(layout.quarters.p);
  const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  check("old-layout-clears-hq-corner",
    moved === 1 && boxes.every((box) => !overlapsHeadquarters(layout.projects.p, box))
      && !overlap(layout.quarters.p.old, layout.quarters.p.right)
      && JSON.stringify(layout.quarters.p.right) === rightBefore
      && clearHeadquarters(layout, "p") === 0,
    { moved, quarters: layout.quarters.p });
}

{
  // Projects were placed on a grid with the row height of a standard project, and a project with
  // three quarters is taller than standard - so the rows overlapped. After
  // placement, auto projects are laid out by their real size; a project
  // the person moved by hand stays where it is.
  const { autoPlaceProject, autoPlaceQuarter, moveProject, reflowAutoProjects } = core;
  const layout = { projects: {}, quarters: {}, agents: {} };
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  ids.forEach((id, index) => {
    autoPlaceProject(layout, id, index);
    for (let quarter = 0; quarter < (index % 3) + 1; quarter += 1) autoPlaceQuarter(layout, id, `${id}${quarter}`, quarter);
  });
  moveProject(layout, "g", 5000, 5000);
  const userPlaced = { ...layout.projects.g };
  reflowAutoProjects(layout, ids);
  const boxes = ids.map((id) => [id, layout.projects[id]]);
  const overlapping = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [idA, a] = boxes[i];
      const [idB, b] = boxes[j];
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
        overlapping.push(`${idA}/${idB}`);
      }
    }
  }
  check("auto-projects-do-not-overlap",
    overlapping.length === 0 && layout.projects.g.x === userPlaced.x && layout.projects.g.y === userPlaced.y,
    { overlapping, g: layout.projects.g, userPlaced });
}

// --- resizing by the corner and the quarter grid ---------------------------------------------------

{
  // No resizing: a standard HQ and a 300x210 quarter; grid crossings
  // every 30 starting 10 from the corner, the map places agents in rows every 60 starting at (40, 40).
  const { headquartersBox, agentSlot, pointRange, GEOMETRY } = core;
  const hq = headquartersBox({ x: 0, y: 0, width: 760, height: 560 });
  const slots = [0, 1, 2, 3, 4, 7].map((index) => agentSlot(index, 300));
  check("default-size-and-map-rows",
    JSON.stringify(hq) === JSON.stringify(headquartersBox()) && hq.width === 190 && hq.height === 170
      && GEOMETRY.agentGridStep === 30
      && JSON.stringify(slots) === JSON.stringify([{ x: 40, y: 40 }, { x: 100, y: 40 }, { x: 160, y: 40 },
        { x: 220, y: 40 }, { x: 40, y: 100 }, { x: 220, y: 100 }])
      && JSON.stringify(pointRange({}, 300)) === JSON.stringify({ left: 40, right: 250, top: 40 }),
    { hq, slots, range: pointRange({}, 300) });
}

/** A project with a quarter placed by the map, with two map agents in it; `manual` is a third one, placed by the person. */
function resizeWorld({ manual = null } = {}) {
  const { autoPlaceProject, autoPlaceQuarter, autoPlaceAgent, arrangeAgents } = core;
  const layout = { schemaVersion: 1, projects: {}, quarters: {}, agents: {} };
  autoPlaceProject(layout, "p", 0);
  const box = autoPlaceQuarter(layout, "p", "q", 0);
  autoPlaceAgent(layout, "a1", 0, box.width);
  autoPlaceAgent(layout, "a2", 1, box.width);
  if (manual !== null) layout.agents.a3 = { ...manual };
  const ids = manual === null ? ["a1", "a2"] : ["a1", "a2", "a3"];
  arrangeAgents(box, ids.map((id) => layout.agents[id]));
  const start = () => ({ box: { ...layout.quarters.p.q },
    agents: ids.map((agentId) => ({ agentId, ...layout.agents[agentId] })) });
  return { layout, start, ids };
}

const inside = (layout, ids) => ids.every((id) => {
  const box = layout.quarters.p.q;
  const spot = layout.agents[id];
  return spot.x > 0 && spot.x < box.width && spot.y > 0 && spot.y < box.height;
});
const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

{
  // Bottom right corner inward: the quarter gets smaller, the map agents go into its rows for the new width.
  const { resizeQuarter } = core;
  const { layout, start } = resizeWorld();
  const before = { ...layout.quarters.p.q };
  const ok = resizeQuarter(layout, "p", "q", start(), "se", -150, -86);
  const box = layout.quarters.p.q;
  check("quarter-shrinks-by-corner",
    ok && box.x === before.x && box.y === before.y && box.width === 150 && box.height === 124
      && layout.agents.a1.y === layout.agents.a2.y && inside(layout, ["a1", "a2"]) && box.auto === undefined,
    { before, box, a1: layout.agents.a1, a2: layout.agents.a2 });
}

{
  // A quarter does not shrink below what its agents need: in a narrow one, two stand
  // one under the other, and it stays taller.
  const { resizeQuarter, QUARTER_MINIMUM } = core;
  const { layout, start } = resizeWorld();
  resizeQuarter(layout, "p", "q", start(), "se", -1000, -1000);
  const box = layout.quarters.p.q;
  check("quarter-not-smaller-than-agents-need",
    box.width === QUARTER_MINIMUM.width && box.height === 100 + 14 + 16
      && layout.agents.a1.x === layout.agents.a2.x && inside(layout, ["a1", "a2"]),
    { box, a1: layout.agents.a1, a2: layout.agents.a2 });
}

{
  // An agent placed by the person stays where it stands (it fits and touches no one): the
  // quarter is not narrower or lower than its icon with a margin; when the top left corner
  // is dragged, the agents move with it.
  const { resizeQuarter } = core;
  const { layout, start } = resizeWorld({ manual: { x: 200, y: 150 } });
  const placed = { ...layout.agents.a3 };
  resizeQuarter(layout, "p", "q", start(), "se", -1000, -1000);
  const shrunk = { ...layout.quarters.p.q };
  const { layout: second, start: secondStart } = resizeWorld({ manual: { x: 200, y: 150 } });
  const from = { ...second.quarters.p.q };
  resizeQuarter(second, "p", "q", secondStart(), "nw", 20, 10);
  const moved = second.quarters.p.q;
  check("person-placed-agent-keeps-its-place",
    placed.x === 200 && placed.y === 150
      && shrunk.width === 200 + 17 + 16 && shrunk.height === 150 + 14 + 16
      && layout.agents.a3.x === 200 && layout.agents.a3.y === 150
      && moved.x === from.x + 20 && moved.y === from.y + 10
      && second.agents.a3.x === 200 && second.agents.a3.y === 150,
    { placed, shrunk, moved, a3: layout.agents.a3, second: second.agents.a3 });
}

{
  // The left edge of a quarter to the right of the HQ, dragged into the HQ zone, stops at it.
  const { resizeQuarter, headquartersZone } = core;
  const { layout, start } = resizeWorld();
  resizeQuarter(layout, "p", "q", start(), "nw", -1000, 0);
  const box = layout.quarters.p.q;
  const zone = headquartersZone(layout.projects.p);
  check("quarter-does-not-enter-hq", !overlap(box, zone) && box.x === zone.x + zone.width, { box, zone });
}

{
  // HQ by the corner: in its own proportions and within limits; a quarter it ran into
  // moves away, and comes back when the corner is taken back.
  const { resizeHeadquarters, headquartersBox, headquartersZone, hitTest, HQ_SCALE } = core;
  const { layout } = resizeWorld();
  const project = layout.projects.p;
  const quarterStart = { ...layout.quarters.p.q };
  const start = () => ({ ...headquartersBox(project), quarters: structuredClone(layout.quarters.p) });
  const origin = start();
  resizeHeadquarters(layout, "p", origin, -95, -85);
  const half = headquartersBox(project);
  const halfScale = project.hqScale;
  resizeHeadquarters(layout, "p", origin, 600, 600);
  const big = { scale: project.hqScale, quarter: { ...layout.quarters.p.q }, zone: headquartersZone(project) };
  resizeHeadquarters(layout, "p", origin, 0, 0);
  const back = { scale: project.hqScale, quarter: { ...layout.quarters.p.q } };
  resizeHeadquarters(layout, "p", origin, -95, -85);
  const world = { projects: [{ projectId: "p", quarters: [{ quarterId: "q", agents: [] }] }] };
  const outsideSmall = hitTest(world, layout, { x: project.x + 28 + 150, y: project.y + 28 + 140 }, 3);
  const insideSmall = hitTest(world, layout, { x: project.x + 28 + 40, y: project.y + 28 + 40 }, 3);
  check("hq-resizes-by-corner",
    halfScale === 0.5 && half.width === 95 && half.height === 85
      && big.scale === HQ_SCALE.maximum && !overlap(big.quarter, big.zone)
      && back.scale === undefined && JSON.stringify(back.quarter) === JSON.stringify(quarterStart)
      && outsideSmall?.kind !== "hq" && insideSmall?.kind === "hq",
    { halfScale, half, big, back, quarterStart, outsideSmall, insideSmall });
}

{
  // An agent is dragged freely (within the quarter); once released, it stands on
  // the nearest crossing; on a taken one - on the nearest one where the icons do not touch, and
  // the one standing there stays. Map agents go around it. The grid follows the quarter's
  // smallest agent: ordinary agents (34 wide, gap 6) - every 40 from 33 across and 30 down
  // (16 from the corner), so the two stand side by side.
  const { moveAgent, snapAgent, agentBox, GEOMETRY } = core;
  const { layout, ids } = resizeWorld();
  const box = layout.quarters.p.q;
  const spots = () => ids.map((id) => layout.agents[id]);
  moveAgent(layout, "p", "q", "a1", 5000, 5000);
  const dragged = { ...layout.agents.a1 };
  moveAgent(layout, "p", "q", "a1", 161 - layout.agents.a1.x, 107 - layout.agents.a1.y);
  snapAgent(box, spots(), layout.agents.a1);
  const first = { a1: { ...layout.agents.a1 }, a2: { ...layout.agents.a2 } };
  moveAgent(layout, "p", "q", "a2", layout.agents.a1.x + 4 - layout.agents.a2.x, layout.agents.a1.y - layout.agents.a2.y);
  snapAgent(box, spots(), layout.agents.a2);
  const second = { a1: { ...layout.agents.a1 }, a2: { ...layout.agents.a2 } };
  const apart = !overlap(agentBox(second.a1), agentBox(second.a2));
  check("agent-snaps-to-crossing",
    dragged.x === box.width - GEOMETRY.agentInset && dragged.y === box.height - GEOMETRY.agentInset
      && first.a1.x === 153 && first.a1.y === 110 && first.a1.auto === undefined
      && first.a2.x === 40 && first.a2.y === 40
      && second.a1.x === 153 && second.a1.y === 110 && apart && second.a2.auto === undefined
      && second.a2.x === 193 && second.a2.y === 110,
    { dragged, first, second });
}

{
  // Past the quarter edge the agent stays at the edge, and once the cursor is back the agent is under
  // it again: dragging puts it at the cursor point rather than adding up offsets.
  const { placeAgent, GEOMETRY } = core;
  const { layout } = resizeWorld();
  const box = layout.quarters.p.q;
  placeAgent(layout, "p", "q", "a1", 900, -300);
  const outside = { ...layout.agents.a1 };
  placeAgent(layout, "p", "q", "a1", 123, 77);
  const back = { ...layout.agents.a1 };
  check("agent-under-cursor-again-after-edge",
    outside.x === box.width - GEOMETRY.agentInset && outside.y === GEOMETRY.agentInset && back.x === 123 && back.y === 77,
    { outside, back });
}

{
  // The grid follows the quarter's smallest agent (the owner's decisions of 01.11): its
  // width with the gap, never finer than 12, and its first point is where that agent
  // stands 16 from the quarter's corner - no strip of a whole step above the first row.
  // Two small agents stand one small step apart, ordinary ones one ordinary step apart;
  // a big one beside a small one takes several cells.
  const { snapAgent, agentBox, quarterGrid, pointRange, GEOMETRY } = core;
  const box = { x: 0, y: 0, width: 300, height: 210 };
  const grid = (spots) => { const { step, x, y } = quarterGrid(spots); return { step, x, y }; };
  const grids = { small: grid([{ scale: 0.5 }]), normal: grid([{}]), big: grid([{ scale: 1.5 }]),
    mixed: grid([{ scale: 1.5 }, { scale: 0.5 }]), smallest: grid([{ scale: 0.4 }]), empty: grid([]) };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const small = [{ x: 94, y: 92, scale: 0.5 }, { x: 99, y: 92, scale: 0.5 }];
  snapAgent(box, small, small[1]);
  const normal = [{ x: 73, y: 70 }, { x: 78, y: 70 }];
  snapAgent(box, normal, normal[1]);
  const gap = (pair) => Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
  // Big agents: the first row's icons are 16 from the top, not a whole step lower.
  const bigRange = pointRange({ scale: 1.5 }, 300, quarterGrid([{ scale: 1.5 }]));
  check("grid-follows-the-smallest-agent",
    same(grids.small, { step: 23, x: 25, y: 23 }) && same(grids.normal, { step: 40, x: 33, y: 30 })
      && same(grids.big, { step: 57, x: 42, y: 37 }) && same(grids.mixed, grids.small)
      && same(grids.smallest, { step: 20, x: 23, y: 22 })
      && same(grids.empty, { step: GEOMETRY.agentGridStep, x: GEOMETRY.agentGridOrigin, y: GEOMETRY.agentGridOrigin })
      && !overlap(agentBox(small[0]), agentBox(small[1])) && !overlap(agentBox(normal[0]), agentBox(normal[1]))
      && gap(small) === 23 && gap(normal) === 40 && small[0].x === 94 && small[0].y === 92
      && bigRange.top - 21 === 16,
    { grids, small, normal, smallGap: gap(small), normalGap: gap(normal), bigRange });
}

{
  // Three kinds of attention, each its own badge (the owner's decision of 01.11): what does not
  // work, what waits for the person, and an unread answer of an idle agent.
  const { aggregateAttention, attentionGroupOf } = core;
  const at = (kind, extra = {}) => ({ kind, agentId: "a1", projectId: "p", quarterId: "q", ...extra });
  const groups = [at("problem"), at("model-down"), at("state"), at("recovery"), at("turn-finished", { outcome: "failed" }),
    at("task-plan", { stopped: "failed" }), at("interaction"), at("asks-you"), at("captured-pending"), at("refused"),
    at("task-plan"), at("turn-finished", { outcome: "completed" }), at("turn-finished", { outcome: "interrupted" })]
    .map(attentionGroupOf);
  const signal = aggregateAttention({ attention: [at("problem"), at("asks-you"), at("asks-you"), at("turn-finished", { outcome: "completed" })] })
    .byAgent.get("a1");
  check("attention-has-three-kinds",
    JSON.stringify(groups) === JSON.stringify(["broken", "broken", "broken", "broken", "broken", "broken",
      "waiting", "waiting", "waiting", "waiting", "waiting", "done", "done"])
      && signal.count === 4 && signal.groups.broken.count === 1 && signal.groups.waiting.count === 2
      && signal.groups.done.count === 1 && signal.groups.done.urgent === false && signal.groups.waiting.urgent === true,
    { groups, signal });
}

{
  // The owner's quarter of 01.11: Qwen at 1.42 makes the grid, Haiku at 1.5 is a little
  // bigger. Haiku goes into the corner cell and to the right end of the third row: its
  // icon's top left corner lines up with Qwen's cells (it used to miss the first point by
  // a pixel and land a whole step away); Qwen itself stands on the grid's own points.
  const { snapAgent, agentBox, GEOMETRY } = core;
  const box = { x: 0, y: 0, width: 430, height: 256 };
  const qwen = { x: 203, y: 90, scale: 1.42 };
  const haiku = { x: 30, y: 30, scale: 1.5 };
  snapAgent(box, [qwen, haiku], haiku);
  const corner = { x: haiku.x, y: haiku.y };
  Object.assign(haiku, { x: 400, y: 150 });
  snapAgent(box, [qwen, haiku], haiku);
  const rowEnd = { x: haiku.x, y: haiku.y };
  Object.assign(qwen, { x: 30, y: 30 });
  snapAgent(box, [qwen, haiku], qwen);
  const edge = (spot) => agentBox(spot).x + GEOMETRY.agentGap / 2;
  check("a-bigger-agent-fits-the-corner-cell",
    corner.x === 43 && corner.y === 38 && rowEnd.x === 367 && rowEnd.y === 146 && qwen.x === 41 && qwen.y === 36
      && edge({ ...haiku, ...corner }) >= GEOMETRY.agentInset && edge({ ...haiku, ...corner }) - GEOMETRY.agentInset < 2,
    { corner, rowEnd, qwen: { x: qwen.x, y: qwen.y } });
}

{
  // The person's agents stay where they stand when they fit and touch no one - a grid
  // that changed with the smallest agent moves no one; two on one spot - the second one
  // goes to the nearest free crossing, not touching.
  const { arrangeAgents, agentBox } = core;
  const box = { x: 0, y: 0, width: 300, height: 210 };
  const spots = [{ x: 47, y: 43 }, { x: 52, y: 45 }, { x: 250, y: 190, auto: true }];
  const changed = arrangeAgents(box, spots);
  check("placed-agents-stay-overlaps-separate",
    changed && spots[0].x === 47 && spots[0].y === 43 && (spots[1].x !== 52 || spots[1].y !== 45)
      && !overlap(agentBox(spots[0]), agentBox(spots[1])) && !overlap(agentBox(spots[1]), agentBox(spots[2]))
      && spots[2].auto === true,
    { spots });
}

{
  // Agent by the corner: around its centre, in its own proportions, within limits; it grows until
  // it touches the neighbours or the quarter edge.
  const { resizeAgent, AGENT_SCALE } = core;
  const { layout } = resizeWorld();
  const spot = layout.agents.a1;
  const origin = { x: spot.x, y: spot.y, scale: spot.scale, corner: "se", others: [{ ...layout.agents.a2 }] };
  resizeAgent(layout, "p", "q", "a1", origin, -8.5, -7);
  const half = { scale: spot.scale, x: spot.x, y: spot.y };
  resizeAgent(layout, "p", "q", "a1", origin, -500, -500);
  const tiny = spot.scale;
  resizeAgent(layout, "p", "q", "a1", origin, 0, 0);
  const back = spot.scale;
  // At the edge (40 from the corner) it does not grow past 1.41: otherwise the icon is closer than 16 to the edge.
  resizeAgent(layout, "p", "q", "a1", origin, 100, 100);
  const nearEdge = spot.scale;
  // In the middle of an empty quarter - up to the limit.
  layout.agents.a1.x = 150;
  layout.agents.a1.y = 100;
  resizeAgent(layout, "p", "q", "a1", { x: 150, y: 100, scale: undefined, corner: "se", others: [] }, 100, 100);
  const free = spot.scale;
  check("agent-resizes-by-corner",
    half.scale === 0.5 && half.x === origin.x && half.y === origin.y
      && tiny === AGENT_SCALE.minimum && back === undefined
      && nearEdge === 1.41 && free === AGENT_SCALE.maximum,
    { half, tiny, back, nearEdge, free });
}

{
  // The thirteenth map agent (fourth row) does not stick out below the quarter: the quarter grows to fit it.
  const { autoPlaceQuarter, autoPlaceAgent, arrangeAgents } = core;
  const layout = { projects: {}, quarters: {}, agents: {} };
  const box = autoPlaceQuarter(layout, "p", "q", 0);
  const ids = Array.from({ length: 13 }, (_, i) => `x${i}`);
  ids.forEach((id, i) => autoPlaceAgent(layout, id, i, box.width));
  const grew = arrangeAgents(box, ids.map((id) => layout.agents[id]));
  check("quarter-grows-to-fit-agents",
    grew && box.height === 220 + 14 + 16 && ids.every((id) => layout.agents[id].y < box.height),
    { box, last: layout.agents.x12 });
}

// --- “Whole world” --------------------------------------------------------------

{
  // One small project: fitting it whole would naively mean a scale
  // larger than the reference “standard project” - and “Whole world” would itself end up at
  // the project level, not the world level. worldFitScale keeps it under the world threshold.
  const { LEVEL, levelFor, worldFitScale } = core;
  const tinyBounds = { x: 0, y: 0, width: 340, height: 250 };
  const scale = worldFitScale(tinyBounds, viewport);
  check("whole-world-with-small-project-stays-world-level",
    levelFor({ x: 0, y: 0, scale }, viewport) === LEVEL.world,
    { scale, level: levelFor({ x: 0, y: 0, scale }, viewport) });
}

{
  // A large or multi-project world: the same result as before (fitScale * 0.98,
  // no clipping) - the existing behaviour does not change.
  const { fitScale, worldFitScale } = core;
  const wideBounds = { x: -400, y: -300, width: 3000, height: 1800 };
  const naive = fitScale(wideBounds, viewport, { margin: 120 }) * 0.98;
  const clipped = worldFitScale(wideBounds, viewport, { margin: 120 });
  check("whole-world-with-usual-bounds-unchanged",
    Math.abs(naive - clipped) < 1e-9, { naive, clipped });
}

{
  // An empty world (no projects): the same ceiling formula, not a bare 0.5.
  const { LEVEL, levelFor, worldFitScale } = core;
  const scale = worldFitScale(null, viewport);
  check("whole-world-without-projects-also-world-level",
    levelFor({ x: 0, y: 0, scale }, viewport) === LEVEL.world, { scale });
}

{
  // World HQ: the main base left of the projects, bigger than a project HQ; the map
  // places it itself and moves it only when it rearranged the projects itself;
  // once moved by the person, it stays; it is dragged by its corner and keeps its proportions.
  const { autoPlaceWorldHeadquarters, resizeWorldHeadquarters, worldHeadquartersSize, WORLD_HQ_SCALE, GEOMETRY } = core;
  const layout = { projects: { a: { x: 0, y: 0, width: 760, height: 560 }, b: { x: 910, y: 40, width: 760, height: 560 } } };
  const boxes = () => [layout.projects.a, layout.projects.b];
  const created = autoPlaceWorldHeadquarters(layout, "world", boxes());
  const first = { ...layout.projects.world };
  layout.projects.a.x = -300;
  const draggedNeighbour = autoPlaceWorldHeadquarters(layout, "world", boxes());
  const stayed = { ...layout.projects.world };
  autoPlaceWorldHeadquarters(layout, "world", boxes(), { reflow: true });
  const reflowed = { ...layout.projects.world };
  delete layout.projects.world.auto;
  layout.projects.world.x = 5000;
  autoPlaceWorldHeadquarters(layout, "world", boxes(), { reflow: true });
  const moved = { ...layout.projects.world };
  const origin = { width: moved.width, height: moved.height };
  resizeWorldHeadquarters(layout, "world", origin, -160, -140);
  const half = { ...layout.projects.world };
  resizeWorldHeadquarters(layout, "world", origin, 2000, 2000);
  const big = { ...layout.projects.world };
  resizeWorldHeadquarters(layout, "world", origin, 0, 0);
  const back = { ...layout.projects.world };
  const empty = { projects: {} };
  autoPlaceWorldHeadquarters(empty, "world", []);
  check("world-hq-left-of-projects-bigger-than-hq-and-resizes-by-corner",
    created === true && draggedNeighbour === false
      && first.x === -(GEOMETRY.worldHqWidth + GEOMETRY.columnGap) && first.y === 0 && first.auto === true
      && first.width === 320 && first.height === 280
      && GEOMETRY.worldHqWidth > GEOMETRY.hqWidth * 1.5 && GEOMETRY.worldHqHeight > GEOMETRY.hqHeight * 1.5
      && stayed.x === first.x && reflowed.x === -300 - 320 - GEOMETRY.columnGap
      && moved.x === 5000 && moved.auto === undefined
      && half.hqScale === WORLD_HQ_SCALE.minimum && half.width === 160 && half.height === 140 && half.x === 5000
      && big.hqScale === WORLD_HQ_SCALE.maximum && big.width === 480 && big.height === 420
      && back.hqScale === undefined && back.width === 320 && back.height === 280
      && JSON.stringify(worldHeadquartersSize({ hqScale: 9 })) === JSON.stringify({ width: 480, height: 420 })
      && empty.projects.world.x === 0 && empty.projects.world.y === 0,
    { first, stayed, reflowed, moved, half, big, back, empty });
}

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "scene",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

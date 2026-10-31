"use strict";

// Map: canvas rendering, camera, interaction. It knows nothing about the backend
// at all — the state comes as the same projection the rest of the window gets.
//
// Its structure follows the prototype: terrain as the underlay, objects as layered
// buildings, selection with corner brackets, labels in screen coordinates,
// the level from the reference scale, selection of only what belongs to the level.

const scene = {
  layout: null,
  layoutStatus: "not-loaded",
  camera: { x: 0, y: 0, scale: 0.2 },
  target: { x: 0, y: 0, scale: 0.2 },
  reference: 0,
  scope: { projectId: null, quarterId: null },
  selection: null,
  hover: null,
  drag: null,
  spaceDown: false,
  animating: false,
  lastFrame: 0,
  history: null,
  reducedMotion: false,
  tray: [],
  tool: "select",
  pointer: { x: 0, y: 0, inside: false },
  tooltipTimer: null,
  minimap: null,
  canvas: null,
  ctx: null,
  mini: null,
  miniCtx: null,
  size: { width: 0, height: 0 },
  dirty: true,
};

const PALETTE = Object.freeze({
  ground: ["#242a20", "#252b20", "#272c21", "#282e22"],
  debris: "#333a28",
  grid: "rgba(156,172,123,0.03)",
  projectFill: "#303b25",
  projectEdge: "#5b6d43",
  projectShadow: "rgba(17,27,13,0.27)",
  quarterFill: "#414b34",
  quarterEdge: "#677351",
  quarterShadow: "rgba(21,30,16,0.3)",
  hqOuter: "#535d42",
  hqOuterEdge: "#8a9071",
  hqInner: "#7b8266",
  hqCore: "#46533a",
  hqRoof: "#2c3824",
  unitBody: "#929b7b",
  unitEdge: "#3f4e2e",
  unitCore: "#3e5033",
  gold: "#dbbf7c",
  text: "#e8ebdd",
  muted: "#a2a997",
  green: "#9fbb88",
  amber: "#e2b76b",
  red: "#df927a",
});

const emptyLayout = () => ({
  schemaVersion: 1, updatedAtUtc: null, projects: {}, quarters: {}, agents: {},
});

// The HQ's service quarter: the project lead lives in it. On the map it is
// replaced by the HQ building, so the map sees the world without it: it does not draw,
// place or hit-test it. Agent windows, attention and the HQ see it as it is.
// Archived agents do not stand on the map either, like archived projects and quarters:
// their conversation is read from the “Archive”.
const HEADQUARTERS_QUARTER = "hq";
// The world's service project: the world lead lives in it, in the HQ quarter, and it is
// bound to the controller folder. On the map the World HQ building stands in for it - the main
// base of the world, left of the projects. It is not drawn as a project territory on the map.
const WORLD_PROJECT = "world";
const worldHqNode = () => ({ kind: "world", projectId: WORLD_PROJECT, quarterId: null, agentId: null });
const mapViews = new WeakMap();

const worldOf = () => {
  const world = atlasState.world;
  if (world === null || world.status !== "ready") return null;
  let view = mapViews.get(world);
  if (view === undefined) {
    view = {
      ...world,
      projection: { ...world.projection, projects: world.projection.projects
        .filter((project) => project.projectId !== WORLD_PROJECT).map((project) => ({
        ...project, quarters: project.quarters.filter((quarter) => quarter.quarterId !== HEADQUARTERS_QUARTER)
          .map((quarter) => ({ ...quarter, agents: quarter.agents.filter((agent) => agent.state !== "archived") })),
      })) },
    };
    // Attention changes in place (an answer that was read is cleared at once): the view takes it from the world.
    Object.defineProperty(view, "attention", { get: () => world.attention, enumerable: true });
    mapViews.set(world, view);
  }
  return view;
};
// The name an object is shown by on the map (app.js displayName: the person's name, else the ID);
// the ID where the window has no names (the scene tests).
const sceneName = (kind, projectId, objectId) => (typeof displayName === "function" ? displayName(kind, projectId, objectId) : objectId);
const projectionOf = () => (worldOf() === null ? { projects: [] } : worldOf().projection);

function projectOf(projectId) {
  return projectionOf().projects.find((item) => item.projectId === projectId) ?? null;
}

function quarterOf(projectId, quarterId) {
  return projectOf(projectId)?.quarters.find((item) => item.quarterId === quarterId) ?? null;
}

// --- sizes and frames ----------------------------------------------------------

function resizeCanvas() {
  const stage = document.getElementById("mapStage");
  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  scene.size = { width: rect.width, height: rect.height };
  for (const [canvas, width, height] of [[scene.canvas, rect.width, rect.height]]) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  scene.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const miniRect = scene.mini.getBoundingClientRect();
  scene.mini.width = Math.round(miniRect.width * dpr);
  scene.mini.height = Math.round(miniRect.height * dpr);
  scene.miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene.miniSize = { width: miniRect.width, height: miniRect.height };
  requestRender();
}

function requestRender() {
  scene.dirty = true;
  requestFrame();
}

function requestFrame() {
  if (scene.animating) return;
  scene.animating = true;
  scene.lastFrame = performance.now();
  requestAnimationFrame(frame);
}

function frame(now) {
  const delta = now - scene.lastFrame;
  scene.lastFrame = now;
  const next = advanceCamera(scene.camera, scene.target, delta, { instant: scene.reducedMotion });
  const moved = next.x !== scene.camera.x || next.y !== scene.camera.y
    || next.scale !== scene.camera.scale;
  scene.camera = { x: next.x, y: next.y, scale: next.scale };
  if (moved || scene.dirty) {
    draw();
    scene.dirty = false;
  }
  // The level in the header and on the bottom bar is where the camera is now, not where
  // it stopped last time: while it flies, the level changes with it.
  const level = currentLevel();
  if (level !== scene.hudLevel) {
    scene.hudLevel = level;
    atlasOnHudChanged();
  }
  if (!next.settled) {
    requestAnimationFrame(frame);
    return;
  }
  scene.animating = false;
  onCameraSettled();
}

function onCameraSettled() {
  // The active area is determined by what ended up in the centre of the screen: this is how
  // the prototype switches the third level when the person has flown to another project.
  const centre = screenToWorld(scene.camera, scene.size, scene.size.width / 2, scene.size.height / 2);
  const scope = inferScope(projectionOf(), scene.layout ?? emptyLayout(), centre, scene.scope);
  if (scope.projectId !== scene.scope.projectId || scope.quarterId !== scene.scope.quarterId) {
    scene.scope = scope;
    atlasOnScopeChanged();
  }
  atlasOnViewSettled();
  atlasOnHudChanged();
  // An open workspace is its own step regardless of the camera (otherwise it
  // would flicker back and forth during the flight itself), but once the camera has arrived and
  // stopped at the project or world level, there is no reason to keep the panel:
  // the person has clearly moved to another scale. closeWorkspace decides itself whether to drop
  // the raw level then: shifted/rescaled inside sceneLeaveWorkspace already
  // sees a long flight and will not bounce back to the quarter.
  // A lead chat is not driven by the camera: it lives at the level of its project or
  // quarter and is closed only by the person.
  if (typeof workspaceFollowsCamera === "function" && workspaceFollowsCamera()) {
    const rawLevel = levelFor(scene.camera, scene.size, scene.reference, false);
    if (rawLevel === LEVEL.project || rawLevel === LEVEL.world) closeWorkspace();
  }
}

function moveCamera(x, y, scale, { instant = false } = {}) {
  scene.target = { x, y, scale: clamp(scale, 0.01, 6) };
  if (instant || scene.reducedMotion) {
    scene.camera = { ...scene.target };
    draw();
    onCameraSettled();
    return;
  }
  requestFrame();
}

// --- levels and transitions ----------------------------------------------------

// With a lead chat, the level is where the camera stands: the chat itself does not drive it.
const currentLevel = () => levelFor(scene.camera, scene.size, scene.reference, workspaceFollowsCamera());
const currentRatio = () => ratioFor(scene.camera, scene.size, scene.reference);

function projectScaleOf(projectId) {
  const box = scene.layout?.projects[projectId];
  return box === undefined ? referenceScale(scene.size) : fitScale(box, scene.size, { margin: 120 });
}

function quarterScaleOf(projectId, quarterId) {
  const box = scene.layout?.quarters[projectId]?.[quarterId];
  return box === undefined ? referenceScale(scene.size) : fitScale(box, scene.size, { margin: 150 });
}

/**
 * The layout must exist before anyone navigates it: going to a
 * project right after launch must not silently do nothing.
 */
function ensurePlacement() {
  const world = worldOf();
  if (world === null || scene.layout === null) return 0;
  let placed = 0;
  world.projection.projects.forEach((project, index) => {
    if (scene.layout.projects[project.projectId] === undefined) placed += 1;
    autoPlaceProject(scene.layout, project.projectId, index);
    project.quarters.forEach((quarter, quarterIndex) => {
      if (scene.layout.quarters[project.projectId]?.[quarter.quarterId] === undefined) placed += 1;
      const box = autoPlaceQuarter(scene.layout, project.projectId, quarter.quarterId, quarterIndex);
      quarter.agents.forEach((agent, agentIndex) => {
        if (scene.layout.agents[agent.agentId] === undefined) placed += 1;
        autoPlaceAgent(scene.layout, agent.agentId, agentIndex, box.width);
      });
      // Agents go to the cells of the quarter grid (a layout saved before the grid
      // gets aligned); the quarter grows to fit them. The quarter of an agent that
      // is being dragged waits until the agent is released.
      const dragged = scene.drag?.kind === "node" && scene.drag.moved && scene.drag.node.kind === "agent"
        && scene.drag.node.projectId === project.projectId && scene.drag.node.quarterId === quarter.quarterId;
      if (!dragged && arrangeAgents(box, quarter.agents.map((agent) => scene.layout.agents[agent.agentId]))) placed += 1;
    });
  });
  // A layout saved when the HQ stood in the centre of the project could put a
  // quarter in its current corner: such a quarter moves to a free place.
  // The frame of every project wraps its content (an empty project wraps the HQ).
  let cleared = 0;
  for (const project of world.projection.projects) {
    cleared += clearHeadquarters(scene.layout, project.projectId);
    const box = scene.layout.projects[project.projectId];
    const before = box === undefined ? null : `${box.width}x${box.height}`;
    fitProjectToChildren(scene.layout, project.projectId);
    if (box !== undefined && `${box.width}x${box.height}` !== before) cleared += 1;
  }
  if (placed > 0 || cleared > 0) {
    // A project grew to fit its quarters after it took its place on the grid:
    // auto projects are laid out again by their real size so that they do not overlap
    // each other. Only when the map placed something new: a drag by
    // the person never moves anyone's neighbours.
    reflowAutoProjects(scene.layout, world.projection.projects.map((project) => project.projectId));
  }
  // The World HQ always exists - even before the world has a lead: the lead is
  // created in it. Until it is moved, it stands left of the projects and moves
  // only when the map itself rearranged the projects.
  const worldPlaced = autoPlaceWorldHeadquarters(scene.layout, WORLD_PROJECT, world.projection.projects
    .map((project) => scene.layout.projects[project.projectId]).filter((box) => box !== undefined),
  { reflow: placed > 0 || cleared > 0 });
  if (worldPlaced) placed += 1;
  if (placed > 0 || cleared > 0) atlasOnLayoutChanged({ immediate: false });
  return placed;
}

/** The World HQ building in world coordinates, or null while there is no layout. */
function worldHqBox() {
  return scene.layout?.projects[WORLD_PROJECT] ?? null;
}

function worldBounds() {
  ensurePlacement();
  const layout = scene.layout;
  if (layout === null) return null;
  // World bounds are computed from what is in the catalog. A layout entry
  // that is no longer in the catalog shows under “off the map”, but it must not stretch
  // the whole world — and zoom the camera out — it must not. The World HQ with its label is part of the world,
  // as are the grey frames of projects not on this PC, while they are shown.
  const known = projectionOf().projects
    .map((project) => layout.projects[project.projectId])
    .filter((box) => box !== undefined);
  const hq = worldHqBox();
  if (hq !== null) known.push({ ...hq, height: hq.height + GEOMETRY.worldHqLabelHeight });
  for (const { box } of awayBoxes()) known.push(box);
  if (known.length > 0) return boundsOf(known);
  return boundsOf(Object.values(layout.projects));
}

/**
 * To the World HQ, like “go to base” in a strategy game (Backspace in StarCraft II): the camera at
 * world level, the HQ in the middle of the screen. The scale matches “Whole world”.
 */
function focusWorldHeadquarters({ instant = false } = {}) {
  atlasDismissPanels();
  const box = worldHqBox();
  if (box === null) return;
  scene.scope = { projectId: null, quarterId: null };
  scene.reference = 0;
  const centre = centreOf(box);
  moveCamera(centre.x, centre.y, worldFitScale(worldBounds(), scene.size, { margin: 120 }), { instant });
  atlasOnHudChanged();
}

function goWorld({ instant = false } = {}) {
  atlasDismissPanels();
  scene.scope = { projectId: null, quarterId: null };
  scene.reference = 0;
  const bounds = worldBounds();
  if (bounds === null) {
    moveCamera(0, 0, worldFitScale(null, scene.size), { instant });
    return;
  }
  const centre = centreOf(bounds);
  moveCamera(centre.x, centre.y, worldFitScale(bounds, scene.size, { margin: 120 }), { instant });
  atlasOnHudChanged();
}

function goProject(projectId, { instant = false } = {}) {
  atlasDismissPanels();
  ensurePlacement();
  const box = scene.layout?.projects[projectId];
  if (box === undefined) return;
  scene.scope = { projectId, quarterId: null };
  scene.reference = projectScaleOf(projectId);
  const centre = centreOf(box);
  moveCamera(centre.x, centre.y, scene.reference, { instant });
  atlasOnHudChanged();
}

function goQuarter(projectId, quarterId, { instant = false } = {}) {
  atlasDismissPanels();
  ensurePlacement();
  const project = scene.layout?.projects[projectId];
  const quarter = scene.layout?.quarters[projectId]?.[quarterId];
  if (project === undefined || quarter === undefined) return;
  scene.scope = { projectId, quarterId };
  // The reference scale for a quarter is taken smaller than its fit: otherwise entering
  // a quarter would jump straight to the next level.
  scene.reference = Math.min(projectScaleOf(projectId), quarterScaleOf(projectId, quarterId) / 2.8);
  moveCamera(project.x + quarter.x + quarter.width / 2,
    project.y + quarter.y + quarter.height / 2,
    quarterScaleOf(projectId, quarterId), { instant });
  atlasOnHudChanged();
}

function goLevel(level, node = null) {
  // Level 1 is the agent window. Going to the quarter level and above (with the bottom button
  // or a key) closes it first: otherwise the window would hold level 1, and the
  // “Quarter” button would do nothing.
  if (level >= LEVEL.quarter && typeof isWorkspaceOpen === "function" && isWorkspaceOpen()) closeWorkspace();
  if (node !== null) {
    scene.scope = {
      projectId: node.projectId ?? scene.scope.projectId,
      quarterId: node.quarterId ?? null,
    };
  }
  if (level >= LEVEL.world) {
    goWorld();
    return;
  }
  if (level === LEVEL.project) {
    if (scene.scope.projectId === null) goWorld();
    else goProject(scene.scope.projectId);
    return;
  }
  if (level === LEVEL.quarter) {
    if (scene.scope.quarterId === null) goLevel(LEVEL.project);
    else goQuarter(scene.scope.projectId, scene.scope.quarterId);
  }
}

function enterNode(node) {
  if (node === null) return;
  if (node.kind === "attention") {
    // Double-click on a badge: one agent waits for attention - its chat at once;
    // several - a short list for that area. What is under the badge
    // (quarter, project) is not selected and does not open its window.
    atlasOpenAttentionTarget(node);
    return;
  }
  // Entering a project or a quarter opens a conversation with its lead (or
  // offers to create one) without moving the camera: zooming in is only for agents.
  if (node.kind === "project") atlasEnterProject(node.projectId);
  else if (node.kind === "hq") atlasEnterProject(node.projectId);
  else if (node.kind === "world") atlasEnterWorld();
  else if (node.kind === "quarter") atlasEnterQuarter(node.projectId, node.quarterId);
  else atlasOpenWorkspace(node);
}

/**
 * Camera for an open workspace: the panel takes the right part of the screen, and
 * the agent is moved to the free left half of it, as in the prototype.
 */
function sceneWorkspaceCamera(node) {
  // A lead chat does not move the camera: zooming to the agent happens only for an ordinary agent.
  if (typeof workspaceFollowsCamera === "function" && !workspaceFollowsCamera()) {
    scene.workspaceView = null;
    return;
  }
  ensurePlacement();
  const project = scene.layout?.projects[node.projectId];
  const quarter = scene.layout?.quarters[node.projectId]?.[node.quarterId];
  const agent = scene.layout?.agents[node.agentId];
  if (project === undefined || quarter === undefined || agent === undefined) return;
  const worldX = project.x + quarter.x + agent.x;
  const worldY = project.y + quarter.y + agent.y;
  // The agent panel can have any width (it is dragged by its edge): the camera moves
  // the agent into what is still visible of the map.
  const measured = document.getElementById("workspace")?.getBoundingClientRect().width ?? 0;
  const pane = measured > 0 && measured < scene.size.width ? measured : Math.min(810, scene.size.width * 0.64);
  const free = scene.size.width - pane;
  // Not below the quarter level threshold: in a small world (one small project)
  // 1.65 of the quarter scale came out below it, the camera “landed” on the
  // project level, and the rule “moved to the project, no panel needed” closed the chat at once.
  const quarterLevel = LEVEL_THRESHOLDS.project * referenceScale(scene.size, scene.reference) * 1.1;
  const scale = Math.max(2.6, quarterScaleOf(node.projectId, node.quarterId) * 1.65, quarterLevel);
  const target = Math.max(100, free * 0.49);
  scene.scope = { projectId: node.projectId, quarterId: node.quarterId };
  moveCamera(worldX + (scene.size.width / 2 - target) / scale, worldY, scale);
  scene.workspaceView = { x: scene.target.x, y: scene.target.y, scale: scene.target.scale };
}

/**
 * Closing the workspace returns to the quarter only if the camera has not been
 * touched since. If you went from the agent to the world, you stay there: closing the panel must not
 * undo what the person did themselves.
 */
function sceneLeaveWorkspace(node) {
  const opened = scene.workspaceView ?? null;
  scene.workspaceView = null;
  if (opened === null) return;
  // null means the camera stays where it was (the window was closed by a click on the map).
  if (node === null) {
    onCameraSettled();
    return;
  }
  const shifted = Math.hypot(scene.target.x - opened.x, scene.target.y - opened.y)
    * Math.max(opened.scale, 0.001);
  const rescaled = Math.abs(Math.log(scene.target.scale / opened.scale)) > 0.03;
  if (shifted > 14 || rescaled) {
    onCameraSettled();
    return;
  }
  goQuarter(node.projectId, node.quarterId);
}

function focusNode(node, { instant = false } = {}) {
  if (node === null) return;
  if (node.kind === "world") {
    focusWorldHeadquarters({ instant });
    scene.selection = node;
    atlasOnSelection(node);
    return;
  }
  if (node.kind === "agent") {
    goQuarter(node.projectId, node.quarterId, { instant });
    scene.selection = node;
    atlasOnSelection(node);
    return;
  }
  if (node.kind === "quarter") goQuarter(node.projectId, node.quarterId, { instant });
  else goProject(node.projectId, { instant });
  scene.selection = node;
  atlasOnSelection(node);
}

function fitSelection() {
  if (scene.selection === null) goWorld();
  else focusNode(scene.selection);
}

// --- selection -----------------------------------------------------------------

function sameNode(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a.kind === b.kind && a.projectId === b.projectId
    && a.quarterId === b.quarterId && a.agentId === b.agentId;
}

function selectNode(node, { focus = false } = {}) {
  scene.selection = node;
  if (node !== null && focus) {
    focusNode(node);
    return;
  }
  requestRender();
  atlasOnSelection(node);
}

// --- history and saving --------------------------------------------------------

const layoutSnapshot = () => structuredClone(scene.layout);

function layoutRestore(value) {
  scene.layout = structuredClone(value);
  atlasOnLayoutChanged({ immediate: true });
  requestRender();
}

function beginGesture(label) {
  scene.history.begin(label);
}

function commitGesture() {
  if (scene.history.commit()) {
    atlasOnLayoutChanged({ immediate: false });
    atlasOnHistoryChanged();
  }
}

function recordChange(label, action) {
  scene.history.record(label, action);
  atlasOnLayoutChanged({ immediate: true });
  atlasOnHistoryChanged();
  requestRender();
}

function undoLocal() {
  const label = scene.history.undo();
  if (label === null) return;
  atlasRecord("info", tx("undone"), label);
  atlasOnHistoryChanged();
  requestRender();
}

function redoLocal() {
  const label = scene.history.redo();
  if (label === null) return;
  atlasRecord("info", tx("redone"), label);
  atlasOnHistoryChanged();
  requestRender();
}

// --- drawing primitives ---------------------------------------------------------

function rect(x, y, width, height, fill, stroke = null, lineWidth = 1) {
  const ctx = scene.ctx;
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, width, height);
  }
  if (stroke !== null) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth / scene.camera.scale;
    ctx.strokeRect(x, y, width, height);
  }
}

function polyline(points, stroke, lineWidth) {
  const ctx = scene.ctx;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth / scene.camera.scale;
  ctx.beginPath();
  points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
}

/** Corner brackets: how the prototype shows selection and hover. */
function cornerBrackets(x, y, width, height, color, lineWidth, length) {
  polyline([[x, y + length], [x, y], [x + length, y]], color, lineWidth);
  polyline([[x + width - length, y], [x + width, y], [x + width, y + length]], color, lineWidth);
  polyline([[x, y + height - length], [x, y + height], [x + length, y + height]], color, lineWidth);
  polyline([[x + width - length, y + height], [x + width, y + height],
    [x + width, y + height - length]], color, lineWidth);
}

function screenText(text, x, y, size, color, align = "left", weight = 500, blur = 7) {
  const ctx = scene.ctx;
  ctx.save();
  ctx.setTransform(scene.dpr ?? 1, 0, 0, scene.dpr ?? 1, 0, 0);
  ctx.font = `${weight} ${size}px "Segoe UI", Inter, Arial, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(17,22,15,0.85)";
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function monoText(text, x, y, size, color, align = "center") {
  const ctx = scene.ctx;
  ctx.save();
  ctx.setTransform(scene.dpr ?? 1, 0, 0, scene.dpr ?? 1, 0, 0);
  ctx.font = `${size}px Consolas, "SFMono-Regular", monospace`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function hash(x, y) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

// --- rendering ------------------------------------------------------------------

function draw() {
  const ctx = scene.ctx;
  const { width, height } = scene.size;
  if (width === 0 || height === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  scene.dpr = dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(scene.camera.scale, scene.camera.scale);
  ctx.translate(-scene.camera.x, -scene.camera.y);

  drawTerrain();
  const world = worldOf();
  const attention = aggregateAttention(world);
  const level = currentLevel();
  const ratio = currentRatio();

  if (scene.layout !== null && world !== null) {
    ensurePlacement();
    const hq = worldHqBox();
    if (hq !== null && boxInView(hq, 80)) drawWorldHeadquarters(hq);
    drawAwayProjects();
    for (const project of world.projection.projects) {
      const box = scene.layout.projects[project.projectId];
      if (box !== undefined) drawProject(project, box, level, ratio, attention);
    }
    drawResizeHandles();
  }

  ctx.restore();
  if (scene.layout !== null && world !== null) drawAwayLabels();
  drawLabels(level, ratio, attention);
  drawAttentionBadges(level, ratio, attention);
  drawMinimap(attention);
  updateTray();
}

/** A rectangle in world units against what is in the window now. */
function boxInView(box, margin = 0) {
  const scale = scene.camera.scale;
  const halfWidth = scene.size.width / 2 / scale;
  const halfHeight = scene.size.height / 2 / scale;
  return box.x + box.width > scene.camera.x - halfWidth - margin
    && box.x < scene.camera.x + halfWidth + margin
    && box.y + box.height > scene.camera.y - halfHeight - margin
    && box.y < scene.camera.y + halfHeight + margin;
}

function drawTerrain() {
  const ctx = scene.ctx;
  const scale = scene.camera.scale;
  const tile = 96 * Math.max(1, 2 ** Math.ceil(Math.log2(12 / Math.max(0.001, scale * 96))));
  const view = {
    left: scene.camera.x - scene.size.width / 2 / scale,
    right: scene.camera.x + scene.size.width / 2 / scale,
    top: scene.camera.y - scene.size.height / 2 / scale,
    bottom: scene.camera.y + scene.size.height / 2 / scale,
  };
  for (let gy = Math.floor(view.top / tile); gy <= Math.ceil(view.bottom / tile); gy += 1) {
    for (let gx = Math.floor(view.left / tile); gx <= Math.ceil(view.right / tile); gx += 1) {
      const value = hash(gx, gy);
      const shade = PALETTE.ground[Math.min(3, Math.floor(value * 4))];
      ctx.fillStyle = shade;
      ctx.fillRect(gx * tile, gy * tile, tile + 0.4, tile + 0.4);
      if (value > 0.68 && scale > 0.08) {
        const dx = gx * tile + hash(gx + 71, gy) * tile;
        const dy = gy * tile + hash(gx, gy + 37) * tile;
        ctx.fillStyle = PALETTE.debris;
        ctx.fillRect(dx, dy, 9, 3);
        ctx.fillRect(dx + 4, dy - 4, 3, 12);
      }
    }
  }
  const grid = scale < 0.36 ? 384 : 96;
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  for (let x = Math.floor(view.left / grid) * grid; x < view.right; x += grid) {
    ctx.moveTo(x, view.top);
    ctx.lineTo(x, view.bottom);
  }
  for (let y = Math.floor(view.top / grid) * grid; y < view.bottom; y += grid) {
    ctx.moveTo(view.left, y);
    ctx.lineTo(view.right, y);
  }
  ctx.stroke();
}

// --- projects not on this PC ----------------------------------------------------
//
// A project disconnected from this PC (or one that lives on another) stays
// in its place as a grey dashed frame: nothing is inside, it is not moved and
// not opened. The place comes from the world's part of the map.

const AWAY_BOX = Object.freeze({ width: 420, height: 220, gap: 60 });

/**
 * Grey frames of projects not on this PC, [{ item, box }]: in their place from the world's part
 * (written by the PC where the project is), and a project with no place on this map - in a
 * column right of the others, on screen only. The person may hide all frames
 * or some of them (the "Not on this PC" sheet; a setting of this PC's window).
 */
function awayBoxes() {
  if (scene.layout === null || typeof atlasState === "undefined") return [];
  if (atlasState.ui?.awayFrames === false) return [];
  const hidden = new Set(atlasState.ui?.awayHidden ?? []);
  const here = new Set(projectionOf().projects.map((project) => project.projectId));
  const away = (atlasState.away?.projects ?? []).filter((item) => !here.has(item.projectId) && !hidden.has(item.projectId));
  const placed = Object.values(scene.layout.projects).filter((box) => Number.isFinite(box?.x) && Number.isFinite(box?.width));
  const right = placed.length === 0 ? 0 : Math.max(...placed.map((box) => box.x + box.width)) + AWAY_BOX.gap;
  const top = placed.length === 0 ? 0 : Math.min(...placed.map((box) => box.y));
  let row = 0;
  return away.map((item) => {
    const known = scene.layout.projects[item.projectId];
    if (Number.isFinite(known?.x) && Number.isFinite(known?.width)) return { item, box: known };
    const box = { x: right, y: top + row * (AWAY_BOX.height + AWAY_BOX.gap), width: AWAY_BOX.width, height: AWAY_BOX.height };
    row += 1;
    return { item, box };
  });
}

const awayNode = (projectId) => ({ kind: "away", projectId, quarterId: null, agentId: null });

function drawAwayProjects() {
  for (const { item, box } of awayBoxes()) {
    if (!boxInView(box, 40)) continue;
    rect(box.x, box.y, box.width, box.height, "rgba(150,154,140,0.08)");
    scene.ctx.save();
    scene.ctx.setLineDash([14 / scene.camera.scale, 10 / scene.camera.scale]);
    rect(box.x, box.y, box.width, box.height, null, "rgba(176,180,166,0.55)", 1.5);
    scene.ctx.restore();
    if (sameNode(scene.hover, awayNode(item.projectId))) {
      const pad = 14 / scene.camera.scale;
      cornerBrackets(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2,
        "rgba(200,204,190,0.8)", 1.3, 26 / scene.camera.scale);
    }
  }
}

/** The frame's label: the name and where the project is - in screen pixels, like the other labels. */
function drawAwayLabels() {
  for (const { item, box } of awayBoxes()) {
    if (!boxInView(box, 40)) continue;
    const corner = worldToScreen(scene.camera, scene.size, box.x, box.y);
    const width = box.width * scene.camera.scale;
    if (width < 60) continue;
    const place = item.location === null || item.location === undefined ? tx("not on this PC")
      : item.location.machineId === null ? tx("not on this PC · in a package") : tx("not on this PC · \"{title}\"", { title: item.location.title });
    screenText(fitText(item.title ? `${item.projectId} · ${item.title}` : item.projectId, width - 20, 13, 600),
      corner.x + 10, corner.y + 22, 13, "rgba(214,216,204,0.85)", "left", 600);
    screenText(fitText(place, width - 20, 11, 500), corner.x + 10, corner.y + 39, 11, PALETTE.muted, "left", 500);
  }
}

/** The frame of a project not on this PC under the point, or null. */
function awayAt(point) {
  for (const { item, box } of awayBoxes().reverse()) {
    if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
      return awayNode(item.projectId);
    }
  }
  return null;
}

function drawProject(project, box, level, ratio, attention) {
  rect(box.x + 10, box.y + 14, box.width, box.height, PALETTE.projectShadow);
  rect(box.x, box.y, box.width, box.height, PALETTE.projectFill, PALETTE.projectEdge, 1.5);
  // A sparse texture, so that the territory does not look like a flat fill.
  scene.ctx.fillStyle = "rgba(147,168,117,0.07)";
  for (let x = box.x + 38; x < box.x + box.width - 20; x += 94) {
    for (let y = box.y + 30; y < box.y + box.height - 20; y += 100) {
      if (hash(Math.floor(x), Math.floor(y)) > 0.7) scene.ctx.fillRect(x, y, 15, 1);
    }
  }

  for (const quarter of project.quarters) {
    const quarterBox = scene.layout.quarters[project.projectId]?.[quarter.quarterId];
    if (quarterBox !== undefined) {
      drawQuarter(project, quarter, box, quarterBox, level, ratio, attention);
    }
  }
  drawHeadquarters(project, box, ratio);

  const selected = sameNode(scene.selection, { kind: "project", projectId: project.projectId, quarterId: null, agentId: null });
  const hovered = sameNode(scene.hover, { kind: "project", projectId: project.projectId, quarterId: null, agentId: null });
  if (selected || hovered) {
    const pad = 14 / scene.camera.scale;
    cornerBrackets(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2,
      PALETTE.gold, selected ? 1.9 : 1.3, 26 / scene.camera.scale);
  }
  if (box.auto === true) {
    scene.ctx.save();
    scene.ctx.setLineDash([12 / scene.camera.scale, 9 / scene.camera.scale]);
    rect(box.x + 4, box.y + 4, box.width - 8, box.height - 8, null, "rgba(219,191,124,0.35)", 1);
    scene.ctx.restore();
  }
}

function drawHeadquarters(project, box, ratio) {
  // The HQ stands in the top-left corner of the project (headquartersBox); x, y is its centre.
  // The building is drawn at the standard size and scaled down as a whole, per “Sizes”.
  const hq = headquartersBox(box);
  const x = box.x + hq.x + hq.width / 2;
  const y = box.y + hq.y + hq.height / 2;
  const w = hq.width;
  const h = hq.height;
  const ctx = scene.ctx;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(w / GEOMETRY.hqWidth, h / GEOMETRY.hqHeight);
  const W = GEOMETRY.hqWidth;
  const H = GEOMETRY.hqHeight;
  rect(-W / 2 + 7, -H / 2 + 9, W, H, "rgba(17,24,14,0.4)");
  rect(-W / 2, -H / 2, W, H, PALETTE.hqOuter, PALETTE.hqOuterEdge, 2);
  for (let i = 0; i < 5; i += 1) {
    polyline([[-W / 2 + 6, -H / 2 + 9 + i * 32], [W / 2 - 6, -H / 2 + 9 + i * 32]],
      "rgba(114,121,93,0.25)", 1);
  }
  rect(-75, -65, 150, 106, PALETTE.hqInner, "#3c4b2d", 3);
  rect(-62, -52, 124, 75, PALETTE.hqCore, "#b0b193", 1.5);
  rect(-35, -39, 70, 63, PALETTE.hqRoof, "#929773", 2);
  rect(-65, 43, 130, 15, "#27351f");
  for (let i = 0; i < 7; i += 1) rect(-53 + i * 17, 47, 9, 5, "#949f7d");
  ctx.restore();

  const selected = sameNode(scene.selection, { kind: "hq", projectId: project.projectId, quarterId: null, agentId: null });
  const hovered = sameNode(scene.hover, { kind: "hq", projectId: project.projectId, quarterId: null, agentId: null });
  if (selected || hovered) {
    const pad = 9 / scene.camera.scale;
    cornerBrackets(x - w / 2 - pad, y - h / 2 - pad, w + pad * 2, h + pad * 2, PALETTE.gold,
      selected ? 1.8 : 1.2, 13 / scene.camera.scale);
  }
}

/**
 * The World HQ is the main base of the world, like a town hall or a command center in a strategy game:
 * bigger than a project HQ, behind a fortress wall with four towers, with a keep and
 * a gold flag above it. It is drawn at the standard size and scaled down as a whole.
 */
function drawWorldHeadquarters(box) {
  const ctx = scene.ctx;
  const W = GEOMETRY.worldHqWidth;
  const H = GEOMETRY.worldHqHeight;
  ctx.save();
  ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
  ctx.scale(box.width / W, box.height / H);
  rect(-W / 2 + 10, -H / 2 + 13, W, H, "rgba(17,24,14,0.45)");
  // Courtyard behind the wall.
  rect(-W / 2, -H / 2, W, H, "#4b5537", "#b3a571", 2.5);
  for (let i = 0; i < 7; i += 1) {
    polyline([[-W / 2 + 12, -H / 2 + 16 + i * 38], [W / 2 - 12, -H / 2 + 16 + i * 38]], "rgba(170,158,108,0.18)", 1);
  }
  // Wall with battlements along the top.
  rect(-W / 2 + 14, -H / 2 + 14, W - 28, 10, "#6a704f");
  for (let x = -W / 2 + 34; x < W / 2 - 34; x += 18) rect(x, -H / 2 + 8, 9, 7, "#8d8a64");
  // Four towers at the corners.
  const tower = 50;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = sx * (W / 2 - tower / 2 + 8);
    const cy = sy * (H / 2 - tower / 2 + 8);
    rect(cx - tower / 2, cy - tower / 2, tower, tower, "#707856", "#d2c08c", 2);
    rect(cx - tower / 2 + 9, cy - tower / 2 + 9, tower - 18, tower - 18, "#3b4a2c", "#a7a27a", 1.2);
  }
  // Keep: the main building, its roof and entrance.
  rect(-112, -96, 224, 164, PALETTE.hqInner, "#3c4b2d", 3);
  rect(-94, -80, 188, 122, "#3f4d33", "#d6c999", 1.6);
  rect(-50, -64, 100, 88, PALETTE.hqRoof, "#bdb283", 2);
  rect(-25, -42, 50, 44, "#25301d", PALETTE.gold, 1.5);
  // Flag above the keep - the mark of the main base.
  polyline([[0, -42], [0, -112]], PALETTE.gold, 3);
  ctx.beginPath();
  ctx.moveTo(0, -112);
  ctx.lineTo(38, -101);
  ctx.lineTo(0, -90);
  ctx.closePath();
  ctx.fillStyle = PALETTE.gold;
  ctx.fill();
  // Gate in the bottom wall.
  rect(-38, H / 2 - 32, 76, 32, "#27351f", "#d2c08c", 1.5);
  for (let i = 0; i < 6; i += 1) rect(-32 + i * 12, H / 2 - 26, 6, 20, "#949f7d");
  ctx.restore();

  const selected = sameNode(scene.selection, worldHqNode());
  const hovered = sameNode(scene.hover, worldHqNode());
  if (selected || hovered) {
    const pad = 11 / scene.camera.scale;
    cornerBrackets(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2, PALETTE.gold,
      selected ? 2 : 1.3, 18 / scene.camera.scale);
  }
}

function drawQuarter(project, quarter, projectBox, box, level, ratio, attention) {
  const x = projectBox.x + box.x;
  const y = projectBox.y + box.y;
  const ctx = scene.ctx;
  ctx.save();
  if (ratio < 0.6) ctx.globalAlpha = 0.75;
  rect(x + 6, y + 8, box.width, box.height, PALETTE.quarterShadow);
  rect(x, y, box.width, box.height, PALETTE.quarterFill, PALETTE.quarterEdge, 1.5);
  // The grid is only the grid points where agents stand centred: between them
  // it is empty; these are snap points, not an underlay. While an agent is dragged across this
  // quarter, they are more visible; from afar, where they merge (the step on screen is under
  // 14 px), they are not drawn.
  const dragging = scene.drag?.kind === "node" && scene.drag.moved && scene.drag.node.kind === "agent"
    && scene.drag.node.projectId === project.projectId && scene.drag.node.quarterId === quarter.quarterId;
  if (dragging || GEOMETRY.agentGridStep * scene.camera.scale >= 14) {
    const { xs, ys } = gridPoints(box.width, box.height);
    const arm = 3.5 / scene.camera.scale;
    ctx.beginPath();
    for (const gx of xs) {
      for (const gy of ys) {
        ctx.moveTo(x + gx - arm, y + gy);
        ctx.lineTo(x + gx + arm, y + gy);
        ctx.moveTo(x + gx, y + gy - arm);
        ctx.lineTo(x + gx, y + gy + arm);
      }
    }
    ctx.strokeStyle = dragging ? "rgba(219,191,124,0.6)" : "rgba(176,188,146,0.3)";
    ctx.lineWidth = 1 / scene.camera.scale;
    ctx.stroke();
  }
  if (dragging) {
    // The grid point where the agent will stand if it is released now, and
    // the outline of its icon there.
    const spot = scene.layout.agents[scene.drag.node.agentId];
    const others = quarter.agents.map((agent) => scene.layout.agents[agent.agentId])
      .filter((other) => other !== undefined && other !== spot && other.auto !== true);
    if (spot !== undefined) {
      const target = snapPoint(spot, box.width, spot.x, spot.y, others);
      const { halfWidth, halfHeight } = agentExtent(spot);
      ctx.save();
      ctx.setLineDash([4 / scene.camera.scale, 3 / scene.camera.scale]);
      rect(x + target.x - halfWidth, y + target.y - halfHeight, halfWidth * 2, halfHeight * 2,
        "rgba(219,191,124,0.1)", PALETTE.gold, 1.2);
      ctx.restore();
      const dot = 3 / scene.camera.scale;
      rect(x + target.x - dot, y + target.y - dot, dot * 2, dot * 2, PALETTE.gold);
    }
  }
  // The top and bottom “brackets” and the side supports are the recognizable silhouette of a quarter.
  polyline([[x + 4, y + 30], [x + 4, y + 4], [x + box.width - 4, y + 4],
    [x + box.width - 4, y + 30]], "#8e9776", 4);
  polyline([[x + 4, y + box.height - 27], [x + 4, y + box.height - 4],
    [x + box.width - 4, y + box.height - 4], [x + box.width - 4, y + box.height - 27]], "#73835c", 4);
  for (let d = 40; d < box.height - 32; d += 62) {
    rect(x + 2, y + d, 6, 19, "#627750");
    rect(x + box.width - 8, y + d, 6, 19, "#627750");
  }

  // Units are visible at any level: from the overview the person must see where
  // anyone stands at all, and be able to reach them.
  for (const agent of quarter.agents) {
    const placement = scene.layout.agents[agent.agentId];
    if (placement !== undefined) {
      drawAgent(agent, x + placement.x, y + placement.y, ratio, attention, level, agentScaleOf(placement));
    }
  }
  if (level <= LEVEL.project) {
    if (quarter.agents.length === 0) {
      monoText(tx("RIGHT-CLICK → NEW AGENT"),
        worldToScreen(scene.camera, scene.size, x + box.width / 2, y + box.height / 2).x,
        worldToScreen(scene.camera, scene.size, x + box.width / 2, y + box.height / 2).y,
        10, "#adb99b");
    }
  }

  const node = { kind: "quarter", projectId: project.projectId, quarterId: quarter.quarterId, agentId: null };
  const selected = sameNode(scene.selection, node);
  const hovered = sameNode(scene.hover, node);
  if (selected || hovered) {
    const pad = 7 / scene.camera.scale;
    cornerBrackets(x - pad, y - pad, box.width + pad * 2, box.height + pad * 2, PALETTE.gold,
      selected ? 1.8 : 1.2, 15 / scene.camera.scale);
  }
  ctx.restore();
}

function agentColour(agent) {
  if (agent.state === "failed" || agent.deliveryState === "failed") return PALETTE.red;
  if (agent.state === "uncertain" || agent.deliveryState === "uncertain") return PALETTE.amber;
  if (agent.state === "archived") return "#6f7767";
  return PALETTE.green;
}

function drawAgent(agent, x, y, ratio, attention, level, size = 1) {
  const detail = smooth(1.4, 2.5, ratio);
  const scale = scene.camera.scale;
  // From afar a unit would turn into a one-pixel dot: it gets a minimum
  // screen size, otherwise the map looks deserted in the overview. `size` is
  // its own size (it was resized by a corner).
  const w = Math.max(GEOMETRY.agentWidth * size, 7 / scale);
  const h = Math.max(GEOMETRY.agentHeight * size, 6 / scale);
  const plain = GEOMETRY.agentWidth * size * scale < 11;
  const k = size;
  rect(x - w / 2 + 3 / scale, y - h / 2 + 4 / scale, w, h, "rgba(20,29,17,0.4)");
  rect(x - w / 2, y - h / 2, w, h, PALETTE.unitBody, PALETTE.unitEdge, 1.5);
  if (plain) {
    rect(x - w / 2, y + h / 2 - Math.max(2, 2 / scale), w, Math.max(2, 2 / scale), agentColour(agent));
  } else {
    rect(x - w / 2 + 4 * k, y - h / 2 + 3 * k, w - 8 * k, h - 10 * k, PALETTE.unitCore, "#647854", 1);
    rect(x - w / 2 + 2 * k, y + h / 2 - 4 * k, w - 4 * k, 4 * k, "#526740");
    // The state bar is the only thing whose colour tells the state of the agent.
    rect(x - 10 * k, y + h / 2 - 4 * k, 20 * k, 2 * k, agentColour(agent));
  }
  if (!plain && detail > 0.55 && (agent.problemCode !== null || agent.deliveryState === "uncertain")) {
    rect(x - w / 2 - 1, y - h / 2 - 5, 5, 5, PALETTE.amber);
  }

  // An alarm on the unit itself is shown only where attention is counted
  // per agent at all. From afar the quarter or project badge stands for it: two
  // marks about the same thing must not be on the screen.
  const signal = attentionLevelOf(level) === "agent"
    ? attention.byAgent.get(agent.agentId) : undefined;
  if (signal !== undefined) {
    // Attention brackets keep a constant screen size: close up they must not
    // swell around the unit.
    const pad = 5 / scene.camera.scale;
    const colour = signal.severity >= 3 ? PALETTE.red : PALETTE.amber;
    cornerBrackets(x - w / 2 - pad, y - h / 2 - pad, w + pad * 2, h + pad * 2,
      colour, 1.6, 7 / scene.camera.scale);
  }

  const node = { kind: "agent", agentId: agent.agentId, projectId: agent.projectId, quarterId: agent.quarterId };
  const selected = scene.selection !== null && scene.selection.kind === "agent"
    && scene.selection.agentId === agent.agentId;
  const hovered = scene.hover !== null && scene.hover.kind === "agent"
    && scene.hover.agentId === agent.agentId;
  if (selected || hovered) {
    const pad = 8 / scene.camera.scale;
    cornerBrackets(x - w / 2 - pad, y - h / 2 - pad, w + pad * 2, h + pad * 2,
      selected ? "#ecdcaa" : PALETTE.gold, selected ? 2 : 1.2, 7 / scene.camera.scale);
  }
}

/**
 * HQ caption. It is visible at any level but belongs to the map, not to the screen:
 * its size is set by the third level, the project level, and when you zoom out the caption
 * shrinks together with the building. It never gets larger than at the third level,
 * otherwise in the overview the text would hang over the building.
 */
function drawHeadquartersLabel(project, box, ratio, level, contextOf) {
  const k = Math.min(1, ratio);
  const hq = headquartersBox(box);
  const point = worldToScreen(scene.camera, scene.size,
    box.x + hq.x + hq.width / 2, box.y + hq.y + hq.height / 2);
  const centre = {
    x: point.x,
    y: point.y + (hq.height / 2) * scene.camera.scale + 15 * k,
  };
  if (centre.x < -200 || centre.x > scene.size.width + 200) return;
  if (centre.y < -60 || centre.y > scene.size.height + 60) return;
  const selected = sameNode(scene.selection,
    { kind: "hq", projectId: project.projectId, quarterId: null, agentId: null });
  screenText(tx("scene::HQ · {projectId}", { projectId: sceneName("project", project.projectId, project.projectId) }), centre.x, centre.y, 12 * k,
    selected ? PALETTE.gold : "#c8d0b1", "center", 600, 7 * k);
  // The lead lives in the service quarter, which the map does not show: you see the lead by the caption,
  // and what the lead is doing by the frame under it, as for any agent (from the project level and closer).
  const lead = leadOf(project.projectId);
  screenText(lead === null ? tx("Goal · team · decisions") : tx("lead · {agentId}", { agentId: sceneName("agent", lead.projectId, lead.agentId) }),
    centre.x, centre.y + 16 * k, 10 * k, "#98ac83", "center", 500, 7 * k);
  if (lead !== null && level <= LEVEL.project) {
    const context = contextOf(lead);
    drawTag(centre.x, centre.y + 16 * k + 9, context.text, CONTEXT_TONES[context.tone] ?? PALETTE.muted);
  }
}

/**
 * World HQ label: “WORLD HQ” and its lead, and below them what
 * the lead is doing, in a frame, as for an agent. The World HQ is a world-level object,
 * so the frame shows at any level. The label size matches the project plaques.
 */
function drawWorldHeadquartersLabel(ratio, contextOf) {
  const box = worldHqBox();
  if (box === null) return;
  const k = Math.min(1, Math.max(0.6, ratio / 0.3));
  const point = worldToScreen(scene.camera, scene.size, box.x + box.width / 2, box.y + box.height);
  const centre = { x: point.x, y: point.y + 17 * k };
  if (centre.x < -240 || centre.x > scene.size.width + 240) return;
  if (centre.y < -80 || centre.y > scene.size.height + 80) return;
  const selected = sameNode(scene.selection, worldHqNode());
  screenText(tx("WORLD HQ"), centre.x, centre.y, 14 * k, selected ? PALETTE.gold : "#e3d6a6", "center", 700, 7 * k);
  const lead = worldLeadOf();
  screenText(lead === null ? tx("World lead not assigned") : tx("world lead · {agentId}", { agentId: sceneName("agent", lead.projectId, lead.agentId) }),
    centre.x, centre.y + 17 * k, 10.5 * k, "#b8b083", "center", 500, 7 * k);
  if (lead !== null) {
    const context = contextOf(lead);
    drawTag(centre.x, centre.y + 17 * k + 9, context.text, CONTEXT_TONES[context.tone] ?? PALETTE.muted);
  }
}

function drawLabels(level, ratio, attention) {
  scene.plaques = [];
  const world = worldOf();
  if (world === null || scene.layout === null) return;
  const projection = world.projection;
  // How many questions wait for the person at each agent, for the context line.
  const questionsByAgent = new Map();
  // Who has finished a turn whose conversation has not been opened yet (turn-seen.mjs).
  const unread = new Set();
  // Whose answer ends with a question to the person: the agent waits until someone answers.
  const asking = new Set();
  for (const item of world.attention ?? []) {
    if (item.kind === "turn-finished") unread.add(item.agentId);
    if (item.kind === "asks-you") asking.add(item.agentId);
    if (item.kind !== "interaction") continue;
    questionsByAgent.set(item.agentId, (questionsByAgent.get(item.agentId) ?? 0) + 1);
  }
  // Short context of the agent: what it is doing and how its last turn ended; for
  // leads it is the same, only shown at the HQ and in the quarter plaque.
  const contextOf = (agent) => {
    const questions = questionsByAgent.get(agent.agentId) ?? 0;
    return questions === 0 && asking.has(agent.agentId) ? { text: tx("waiting for your answer"), tone: "ask" }
      : questions === 0 && unread.has(agent.agentId) ? { text: tx("answer waiting for you"), tone: "ask" }
        : agentContextLine(agent, questions);
  };

  for (const project of projection.projects) {
    const box = scene.layout.projects[project.projectId];
    if (box !== undefined) drawHeadquartersLabel(project, box, ratio, level, contextOf);
  }
  drawWorldHeadquartersLabel(ratio, contextOf);

  // The project plaque is above its top-left corner, outside the frame, at any
  // level: in the overview the name does not lie on the buildings. From afar, where
  // projects come closer, the plaque shrinks with them.
  const projectPlaqueScale = Math.min(1, Math.max(0.6, ratio / 0.3));
  for (const project of projection.projects) {
    const box = scene.layout.projects[project.projectId];
    if (box === undefined) continue;
    const corner = worldToScreen(scene.camera, scene.size, box.x, box.y);
    if (corner.x < -400 || corner.x > scene.size.width + 40) continue;
    if (corner.y < -40 || corner.y > scene.size.height + 80) continue;
    const node = { kind: "project", projectId: project.projectId, quarterId: null, agentId: null };
    const agents = project.quarters.reduce((sum, quarter) => sum + quarter.agents.length, 0);
    drawPlaque(corner.x, corner.y - 4, sceneName("project", project.projectId, project.projectId),
      `${countWords(project.quarters.length, QUARTER_FORMS)} · ${countWords(agents, AGENT_FORMS)}`,
      16 * projectPlaqueScale, sameNode(scene.selection, node), node);
  }
  // The quarter plaque is outside, at its top-left corner, close to the edge
  // (the overview has none); at the project level it also shows how many agents
  // memory is delivered. Agents' names - at any level: from the overview you also see
  // who is where; there they shrink with the quarter. The state frame under an agent - at the levels
  // quarter and agent levels.
  const quarterPlaqueScale = Math.min(1, ratio);
  for (const project of projection.projects) {
    const projectBox = scene.layout.projects[project.projectId];
    if (projectBox === undefined) continue;

    for (const quarter of project.quarters) {
      const box = scene.layout.quarters[project.projectId]?.[quarter.quarterId];
      if (box === undefined) continue;
      const corner = worldToScreen(scene.camera, scene.size, projectBox.x + box.x, projectBox.y + box.y);
      if (corner.x < -400 || corner.x > scene.size.width + 40) continue;
      if (level < LEVEL.world) {
        const node = { kind: "quarter", projectId: project.projectId, quarterId: quarter.quarterId, agentId: null };
        const delivered = quarter.agents.filter((agent) => agent.deliveryState === "delivered").length;
        // Memory summary only if the plaque with it is not wider than the quarter.
        const roomy = box.width * scene.camera.scale >= 230;
        // From the project level there are no frames under agents: what the quarter lead
        // is doing shows in its plaque.
        const lead = level === LEVEL.project ? leadOf(project.projectId, quarter.quarterId) : null;
        const detail = lead !== null
          ? tx("{value} · lead: {text}", { value: countWords(quarter.agents.length, AGENT_FORMS), text: contextOf(lead).text })
          : level === LEVEL.project && quarter.agents.length > 0 && roomy
            ? tx("{value} · memory {delivered}/{length}", { value: countWords(quarter.agents.length, AGENT_FORMS), delivered, length: quarter.agents.length })
            : countWords(quarter.agents.length, AGENT_FORMS);
        drawPlaque(corner.x, corner.y - 3, sceneName("quarter", project.projectId, quarter.quarterId), detail,
          14 * quarterPlaqueScale, sameNode(scene.selection, node), node);
      }
      for (const agent of quarter.agents) {
        const placement = scene.layout.agents[agent.agentId];
        if (placement === undefined) continue;
        const point = worldToScreen(scene.camera, scene.size,
          projectBox.x + box.x + placement.x, projectBox.y + box.y + placement.y);
        if (point.x < -80 || point.x > scene.size.width + 80) continue;
        if (point.y < -60 || point.y > scene.size.height + 60) continue;
        const selectedAgent = scene.selection !== null && scene.selection.kind === "agent"
          && scene.selection.agentId === agent.agentId;
        // A name is no wider than the step at which the map places agents (but no shorter than 56 px), otherwise
        // the names of neighbours overlap; the selected one is shown in full.
        const room = Math.max(56, GEOMETRY.agentAutoStep * scene.camera.scale - 6);
        // In the overview the name shrinks with the quarter (not smaller than 9 px); closer - 14 px.
        const nameSize = level >= LEVEL.world ? Math.max(9, Math.round(14 * quarterPlaqueScale)) : 14;
        const shown = sceneName("agent", agent.projectId, agent.agentId);
        const label = selectedAgent ? shown : fitText(shown, room, nameSize, 600);
        // Name above the unit, state below it. Labels move away from the unit
        // in proportion to its size on screen, otherwise close up they lie on it.
        const extent = agentExtent(placement);
        const half = Math.max(extent.halfHeight * scene.camera.scale, 3);
        screenText(label, point.x, point.y - half - Math.round(nameSize * 0.55), nameSize,
          selectedAgent ? PALETTE.gold : "#dfe7cc", "center", 600);
        if (level >= LEVEL.project) continue;
        // Short context under the unit, in a frame sized to the text: what the agent
        // is doing and how its last turn ended, only from what the catalog reports.
        const context = contextOf(agent);
        const tagTop = point.y + half + 3;
        const tagHeight = drawTag(point.x, tagTop, selectedAgent ? context.text : fitText(context.text, room - 10, 10, 500),
          CONTEXT_TONES[context.tone] ?? PALETTE.muted);
        if (selectedAgent) {
          // For the selected one, also the last captured message, if
          // the conversation was already read: in the agent's own words, not retold.
          const said = atlasState.lastMessages.get(agent.agentId);
          if (said !== undefined) {
            const firstLine = said.text.split(/\r?\n/u)[0];
            const excerpt = firstLine.length > 46 ? `${firstLine.slice(0, 45)}…` : firstLine;
            screenText(tx("\"{name}\"", { name: excerpt }), point.x, tagTop + tagHeight + 11, 10, "#b9c4a4", "center");
          }
        }
      }
    }
  }
}

/** Text shortened with an ellipsis to `width` px in this font (screen pixels). */
function fitText(text, width, size, weight) {
  const ctx = scene.ctx;
  ctx.save();
  ctx.font = `${weight} ${size}px "Segoe UI", Inter, Arial, sans-serif`;
  let shown = text;
  if (ctx.measureText(shown).width > width) {
    while (shown.length > 1 && ctx.measureText(`${shown}…`).width > width) shown = shown.slice(0, -1);
    shown = `${shown}…`;
  }
  ctx.restore();
  return shown;
}

/**
 * State frame under an agent (“turn finished”, “working”…): as wide as its text,
 * with a small padding, in screen pixels, the same size at any scale.
 * Returns its height.
 */
function drawTag(x, top, text, colour) {
  const ctx = scene.ctx;
  const height = 15;
  ctx.save();
  ctx.setTransform(scene.dpr ?? 1, 0, 0, scene.dpr ?? 1, 0, 0);
  ctx.font = `500 10px "Segoe UI", Inter, Arial, sans-serif`;
  const width = Math.round(ctx.measureText(text).width + 10);
  const left = Math.round(x - width / 2);
  const y = Math.round(top);
  ctx.fillStyle = "rgba(26,31,23,0.9)";
  ctx.fillRect(left, y, width, height);
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, y + 0.5, width - 1, height - 1);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, Math.round(x), y + height / 2 + 0.5);
  ctx.restore();
  return height;
}

/**
 * Name plaque: its bottom-left corner is at point (x, y) on the screen, above
 * the object. It is also a handle: a click or a drag on it takes the object
 * (plaqueAt), so its rectangle is remembered.
 */
function drawPlaque(x, y, title, detail, size, selected, node) {
  if (size < 6) return;
  const ctx = scene.ctx;
  const font = (weight, px) => `${weight} ${px}px "Segoe UI", Inter, Arial, sans-serif`;
  const detailSize = Math.max(8, size * 0.78);
  const padX = Math.round(size * 0.55);
  const gap = Math.round(size * 0.6);
  const height = Math.round(size * 1.7);
  ctx.save();
  ctx.setTransform(scene.dpr ?? 1, 0, 0, scene.dpr ?? 1, 0, 0);
  ctx.font = font(650, size);
  const titleWidth = ctx.measureText(title).width;
  ctx.font = font(500, detailSize);
  const detailWidth = detail ? ctx.measureText(detail).width : 0;
  const width = Math.round(padX * 2 + titleWidth + (detail ? gap + detailWidth : 0));
  const top = Math.round(y - height);
  const left = Math.round(x);
  ctx.fillStyle = "rgba(26,31,23,0.92)";
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = selected ? PALETTE.gold : "rgba(150,160,120,0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
  // Gold strip on the left, like the window sheets have: the plaque belongs to the frame under it.
  ctx.fillStyle = selected ? PALETTE.gold : "#8e9776";
  ctx.fillRect(left, top, 3, height);
  const baseline = top + height / 2 + size * 0.36;
  ctx.textBaseline = "alphabetic";
  ctx.font = font(650, size);
  ctx.fillStyle = selected ? PALETTE.gold : PALETTE.text;
  ctx.fillText(title, left + padX, baseline);
  if (detail) {
    ctx.font = font(500, detailSize);
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText(detail, left + padX + titleWidth + gap, baseline);
  }
  ctx.restore();
  scene.plaques.push({ x: left, y: top, w: width, h: height, node });
}

function plaqueAt(x, y) {
  const plaques = scene.plaques ?? [];
  for (let index = plaques.length - 1; index >= 0; index -= 1) {
    const plaque = plaques[index];
    if (x >= plaque.x && x <= plaque.x + plaque.w && y >= plaque.y && y <= plaque.y + plaque.h) return plaque;
  }
  return null;
}

// The context line is computed in feed-core.js; only its colour is here.
const CONTEXT_TONES = Object.freeze({
  quiet: "#8a927f", bad: PALETTE.red, warn: PALETTE.amber, ask: PALETTE.gold,
  busy: PALETTE.green, plain: "#a9b597",
});

/**
 * Attention badge. It is drawn in screen coordinates, so it does not grow with
 * the scale, and, if it is the main one at this distance, it becomes a target for
 * the cursor: you can hover it, click it and open the list.
 */
// Badges that wait for the person's action pulse smoothly in opacity (period 1.8 s).
const PULSE_PERIOD_MS = 1800;
const PULSE_FRAME_MS = 50;

/** The pulsing badge's opacity now: from 0.45 to 1, by a cosine. */
function pulseOpacity() {
  const phase = (performance.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  return 0.725 + 0.275 * Math.cos(phase * Math.PI * 2);
}

function drawBadge(x, y, signal, opacity = 1, node = null) {
  if (opacity < 0.04) return;
  const ctx = scene.ctx;
  const dpr = scene.dpr ?? 1;
  const radius = signal.count > 9 ? 17 : 15;
  const colour = signal.severity >= 3 ? PALETTE.red : PALETTE.amber;
  const pulsing = signal.urgent === true && !scene.reducedMotion;
  if (pulsing) scene.pulsing = true;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = opacity * (pulsing ? pulseOpacity() : 1);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = signal.severity >= 3 ? "#3a2622" : "#3a3322";
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.font = "bold 17px Consolas, monospace";
  ctx.textAlign = "center";
  // A single signal is shown as a sign: a question to the person is “?”, everything else is “!”.
  ctx.fillText(signal.count === 1 ? (signal.severity === 1 ? "?" : "!") : String(signal.count),
    x, y + 6);
  ctx.restore();
  // Only a badge that is visible almost in full at this distance catches the
  // cursor: otherwise the targets of three levels would overlap each other.
  if (opacity > 0.5 && node !== null) scene.badges.push({ x, y, r: radius + 4, node, signal });
}

/** Whose attention badge this level shows. There is no intermediate state. */
const attentionLevelOf = (level) => (level >= LEVEL.world ? "project"
  : level === LEVEL.project ? "quarter" : "agent");

/**
 * Attention badges belong to the level, not to the distance: the world shows them on
 * projects, the project level on quarters, the quarter level on the agents themselves.
 * Exactly one roll-up is visible at a time, so a badge never hangs between
 * objects and does not distract in empty space. The visible badge is also the one that answers
 * the cursor.
 */
function drawAttentionBadges(level, ratio, attention) {
  scene.badges = [];
  scene.pulsing = false;
  // While a badge pulses on screen, the map redraws itself (~20 times a
  // second) - the canvas only: not through the camera's frame, which on stopping
  // refreshes the panels (they would be rebuilt and flicker under the cursor).
  try { drawAttentionBadgesNow(level, ratio, attention); } finally {
    if (scene.pulsing && !scene.pulseTimer) {
      scene.pulseTimer = setTimeout(() => {
        scene.pulseTimer = null;
        requestAnimationFrame(() => { if (!scene.animating) draw(); });
      }, PULSE_FRAME_MS);
    }
  }
}

function drawAttentionBadgesNow(level, ratio, attention) {
  const world = worldOf();
  if (world === null || scene.layout === null || attention.total === 0) return;
  const showing = attentionLevelOf(level);
  const screen = (x, y) => worldToScreen(scene.camera, scene.size, x, y);
  // A badge sits with its centre exactly on the top right corner of what it is about:
  // the corner is taken in map coordinates, with no offset in them - otherwise
  // the offset grows with the zoom and the badge drifts away from the corner.

  // The world lead is in the World HQ, which is not among the projects: its badge is
  // at the World HQ building, at any level (the World HQ is a world-level object).
  const worldLead = worldLeadOf();
  const worldSignal = worldLead === null ? undefined : attention.byAgent.get(worldLead.agentId);
  const hq = worldHqBox();
  if (worldSignal !== undefined && hq !== null && boxInView(hq, 160)) {
    const point = screen(hq.x + hq.width, hq.y);
    drawBadge(point.x, point.y, worldSignal, 1, {
      kind: "attention", scopeKind: "agent",
      projectId: worldLead.projectId, quarterId: worldLead.quarterId, agentId: worldLead.agentId,
    });
  }

  for (const project of world.projection.projects) {
    if (attention.byProject.get(project.projectId) === undefined) continue;
    const box = scene.layout.projects[project.projectId];
    if (box === undefined) continue;
    // The whole territory is culled, not the badge point: close up the project corner
    // goes off the screen, but the badges of its quarters and agents must stay.
    if (!boxInView(box, 160)) continue;

    if (showing === "project") {
      const point = screen(box.x + box.width, box.y);
      drawBadge(point.x, point.y, attention.byProject.get(project.projectId), 1, {
        kind: "attention", scopeKind: "project",
        projectId: project.projectId, quarterId: null, agentId: null,
      });
      continue;
    }

    // The project lead is in the HQ quarter, which is not on the map: its badge is at the HQ building.
    const lead = leadOf(project.projectId);
    const leadSignal = lead === null ? undefined : attention.byAgent.get(lead.agentId);
    if (leadSignal !== undefined) {
      const hq = headquartersBox(box);
      const point = screen(box.x + hq.x + hq.width, box.y + hq.y);
      drawBadge(point.x, point.y, leadSignal, 1, {
        kind: "attention", scopeKind: "agent",
        projectId: project.projectId, quarterId: lead.quarterId, agentId: lead.agentId,
      });
    }

    for (const quarter of project.quarters) {
      const quarterSignal = attention.byQuarter.get(`${project.projectId}/${quarter.quarterId}`);
      if (quarterSignal === undefined) continue;
      const quarterBox = scene.layout.quarters[project.projectId]?.[quarter.quarterId];
      if (quarterBox === undefined) continue;

      if (showing === "quarter") {
        const point = screen(box.x + quarterBox.x + quarterBox.width, box.y + quarterBox.y);
        drawBadge(point.x, point.y, quarterSignal, 1, {
          kind: "attention", scopeKind: "quarter",
          projectId: project.projectId, quarterId: quarter.quarterId, agentId: null,
        });
        continue;
      }

      for (const agent of quarter.agents) {
        const agentSignal = attention.byAgent.get(agent.agentId);
        if (agentSignal === undefined) continue;
        const placement = scene.layout.agents[agent.agentId];
        if (placement === undefined) continue;
        const extent = agentExtent(placement);
        const point = screen(box.x + quarterBox.x + placement.x + extent.halfWidth,
          box.y + quarterBox.y + placement.y - extent.halfHeight);
        drawBadge(point.x, point.y, agentSignal, 1, {
          kind: "attention", scopeKind: "agent",
          projectId: project.projectId, quarterId: quarter.quarterId, agentId: agent.agentId,
        });
      }
    }
  }
}

// --- minimap ---------------------------------------------------------------------

function drawMinimap(attention) {
  const ctx = scene.miniCtx;
  const size = scene.miniSize;
  if (ctx === null || size === undefined) return;
  ctx.fillStyle = "#202919";
  ctx.fillRect(0, 0, size.width, size.height);
  const bounds = worldBounds();
  const transform = minimapTransform(bounds, size);
  scene.minimap = transform;
  if (transform === null || scene.layout === null) return;

  const projection = projectionOf();
  scene.minimapHits = [];
  const fit = (text, width) => {
    let title = text.length > 20 ? `${text.slice(0, 19)}…` : text;
    while (title.length > 3 && ctx.measureText(title).width > Math.max(26, width - 4)) title = `${title.slice(0, -2)}…`;
    return title;
  };
  // Projects not on this PC - grey dashed frames, as on the map and when on the map
  // (the "Not on this PC" ticks). A click on them moves the view, as on an empty place.
  for (const { item, box } of awayBoxes()) {
    const topLeft = transform.toMap(box.x, box.y);
    const width = box.width * transform.scale;
    const height = box.height * transform.scale;
    ctx.fillStyle = "rgba(150,154,140,0.12)";
    ctx.fillRect(topLeft.x, topLeft.y, width, height);
    ctx.strokeStyle = "rgba(176,180,166,0.7)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(topLeft.x, topLeft.y, width, height);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(214,216,204,0.75)";
    ctx.textAlign = "center";
    ctx.font = `400 9px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(fit(item.projectId, width), topLeft.x + width / 2, topLeft.y + height / 2 + 3);
  }
  // The World HQ on the minimap is a gold square: the main base is visible from there too.
  const hq = worldHqBox();
  if (hq !== null) {
    const corner = transform.toMap(hq.x, hq.y);
    const width = Math.max(6, hq.width * transform.scale);
    const height = Math.max(6, hq.height * transform.scale);
    ctx.fillStyle = "#5a5030";
    ctx.fillRect(corner.x, corner.y, width, height);
    ctx.strokeStyle = PALETTE.gold;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(corner.x, corner.y, width, height);
    scene.minimapHits.push({ x: corner.x, y: corner.y, width, height, projectId: WORLD_PROJECT, world: true });
  }
  for (const project of projection.projects) {
    const box = scene.layout.projects[project.projectId];
    if (box === undefined) continue;
    const topLeft = transform.toMap(box.x, box.y);
    const width = box.width * transform.scale;
    const height = box.height * transform.scale;
    const active = project.projectId === scene.scope.projectId;
    scene.minimapHits.push({
      x: topLeft.x, y: topLeft.y, width, height, projectId: project.projectId,
    });
    ctx.fillStyle = active ? "#455734" : "#35442a";
    ctx.fillRect(topLeft.x, topLeft.y, width, height);
    ctx.strokeStyle = active ? "#b6bd88" : "#7a8e60";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(topLeft.x, topLeft.y, width, height);

    // The project name on the minimap always stays, including for the project
    // the person has entered: otherwise the map loses its labels on the transition.
    ctx.fillStyle = active ? "#f0e6c6" : "#d4dec0";
    ctx.textAlign = "center";
    ctx.font = `${active ? 600 : 400} 9px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(fit(project.projectId, width), topLeft.x + width / 2, topLeft.y + height / 2 + 3);

    const signal = attention.byProject.get(project.projectId);
    if (signal !== undefined && width > 26) {
      const badge = scene.minimapHits[scene.minimapHits.length - 1];
      badge.badge = { x: topLeft.x + width - 6, y: topLeft.y + 7, r: 10 };
      ctx.beginPath();
      ctx.arc(topLeft.x + width - 6, topLeft.y + 7, 8, 0, Math.PI * 2);
      ctx.fillStyle = signal.severity >= 3 ? "#b45a46" : "#b99254";
      ctx.fill();
      ctx.fillStyle = "#172110";
      ctx.font = "bold 11px Consolas, monospace";
      ctx.fillText(String(signal.count), topLeft.x + width - 6, topLeft.y + 11);
    }
  }

  const label = document.getElementById("scaleLabel");
  if (label !== null) label.textContent = `${currentLevel()} / 4 · ${Math.round(scene.camera.scale * 100)}%`;

  const viewWidth = scene.size.width / scene.camera.scale * transform.scale;
  const viewHeight = scene.size.height / scene.camera.scale * transform.scale;
  const centre = transform.toMap(scene.camera.x, scene.camera.y);
  ctx.strokeStyle = "#d9d5b1";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(centre.x - viewWidth / 2, centre.y - viewHeight / 2, viewWidth, viewHeight);
  ctx.setLineDash([]);
}

function onMinimapPointer(event) {
  if (scene.minimap === null) return;
  const rectangle = scene.mini.getBoundingClientRect();
  const x = event.clientX - rectangle.left;
  const y = event.clientY - rectangle.top;
  // A click on a project in the minimap enters it, a click on empty space moves
  // the view without changing the scale. The same as in the prototype.
  const hit = (scene.minimapHits ?? []).find((item) => x >= item.x && x <= item.x + item.width
    && y >= item.y && y <= item.y + item.height);
  if (hit !== undefined && hit.world === true) {
    selectNode(worldHqNode(), { focus: true });
    atlasRecord("info", tx("minimap jump"), tx("scene::World HQ"));
    return;
  }
  if (hit !== undefined) {
    // The attention badge on the minimap opens the list for that project, as in the prototype.
    if (hit.badge !== undefined && Math.hypot(x - hit.badge.x, y - hit.badge.y) <= hit.badge.r) {
      atlasOpenAttention({ projectId: hit.projectId, quarterId: null, agentId: null });
      return;
    }
    goProject(hit.projectId);
    // A project where something waits for the person also opens its list at once.
    if (hit.badge !== undefined) atlasOpenAttention({ projectId: hit.projectId, quarterId: null, agentId: null });
    atlasRecord("info", tx("minimap jump"), hit.projectId);
    return;
  }
  const point = scene.minimap.toWorld(x, y);
  atlasDismissPanels();
  moveCamera(point.x, point.y, scene.camera.scale);
  atlasRecord("info", tx("view moved via minimap"), "");
}

// --- interaction ------------------------------------------------------------------

const pointerWorld = (event) => {
  const rectangle = scene.canvas.getBoundingClientRect();
  return screenToWorld(scene.camera, scene.size,
    event.clientX - rectangle.left, event.clientY - rectangle.top);
};

/** Attention badge under the cursor: it takes the hit first. */
function badgeAt(x, y) {
  const badges = scene.badges ?? [];
  for (let index = badges.length - 1; index >= 0; index -= 1) {
    const badge = badges[index];
    if (Math.hypot(x - badge.x, y - badge.y) <= badge.r) return badge;
  }
  return null;
}

function nodeAt(event) {
  if (scene.layout === null) return null;
  const rectangle = scene.canvas.getBoundingClientRect();
  const badge = badgeAt(event.clientX - rectangle.left, event.clientY - rectangle.top);
  if (badge !== null) return badge.node;
  const plaque = plaqueAt(event.clientX - rectangle.left, event.clientY - rectangle.top);
  if (plaque !== null) return plaque.node;
  // Tolerance in world units: from afar a unit is small on the screen, but the person
  // must still be able to hit it.
  const point = pointerWorld(event);
  const found = hitTest(projectionOf(), scene.layout, point, currentLevel(), scene.scope,
    { tolerance: 5 / scene.camera.scale });
  if (found !== null) return found;
  const away = awayAt(point);
  if (away !== null) return away;
  // The World HQ is drawn under the projects: a project placed on top of it takes the cursor first.
  const hq = worldHqBox();
  return hq !== null && point.x >= hq.x && point.x <= hq.x + hq.width && point.y >= hq.y && point.y <= hq.y + hq.height
    ? worldHqNode() : null;
}

/** What will follow the cursor: what is under it, at any level; null means panning. */
function dragNodeFor(node) {
  if (node === null || scene.layout === null) return null;
  // An attention badge is not a building: it is not dragged. Nor is the frame of a project not on this PC.
  if (node.kind === "attention" || node.kind === "away") return null;
  return dragTargetFor(node);
}

/**
 * A tooltip over a map object appears when the cursor has stopped over it:
 * this long without mouse movement (move events come every 8-16 ms, so
 * 150 ms of quiet is a stop, not slow movement). Right after
 * the stop, as in strategy games, and never on the move.
 */
const TOOLTIP_REST_MS = 150;

function hideSceneTooltip() {
  clearTimeout(scene.tooltipTimer);
  scene.tooltipTimer = null;
  atlasHideTooltip();
}

function showSceneTooltip() {
  scene.tooltipTimer = null;
  if (scene.hover === null || scene.drag !== null || !scene.pointer.inside) return;
  atlasShowTooltip(scene.hover, scene.pointer);
}

// --- resize by a corner --------------------------------------------------------
//
// A selected quarter has handles at its four corners, the HQ of a selected project has
// one, in the bottom-right corner (the top-left corner of the HQ is the project corner). Dragging a handle
// changes the size of only this quarter or this HQ; the whole gesture
// is undone with one Ctrl+Z. A quarter is no smaller than its agents need.

const HANDLE_PX = 10;

/** Resize handles of the selection: `{ kind: "quarter" | "hq", projectId, quarterId, corner, x, y }`, in world coordinates. */
function resizeHandles() {
  const selection = scene.selection;
  if (scene.layout === null || selection === null || scene.tool !== "select") return [];
  const project = scene.layout.projects[selection.projectId];
  if (project === undefined) return [];
  if (selection.kind === "world") {
    // The World HQ has one handle in the bottom-right corner, like a project HQ.
    return [{ kind: "world", projectId: WORLD_PROJECT, quarterId: null, corner: "se",
      x: project.x + project.width, y: project.y + project.height,
      cx: project.x + project.width / 2, cy: project.y + project.height / 2, side: Math.min(project.width, project.height) }];
  }
  if (selection.kind === "quarter") {
    const box = scene.layout.quarters[selection.projectId]?.[selection.quarterId];
    if (box === undefined) return [];
    const left = project.x + box.x;
    const top = project.y + box.y;
    return [["nw", left, top], ["ne", left + box.width, top], ["sw", left, top + box.height],
      ["se", left + box.width, top + box.height]].map(([corner, x, y]) => ({
      kind: "quarter", projectId: selection.projectId, quarterId: selection.quarterId, corner, x, y,
      cx: left + box.width / 2, cy: top + box.height / 2, side: Math.min(box.width, box.height),
    }));
  }
  if (selection.kind === "project" || selection.kind === "hq") {
    const hq = headquartersBox(project);
    return [{ kind: "hq", projectId: selection.projectId, quarterId: null, corner: "se",
      x: project.x + hq.x + hq.width, y: project.y + hq.y + hq.height,
      cx: project.x + hq.x + hq.width / 2, cy: project.y + hq.y + hq.height / 2, side: Math.min(hq.width, hq.height) }];
  }
  if (selection.kind === "agent") {
    const box = scene.layout.quarters[selection.projectId]?.[selection.quarterId];
    const spot = scene.layout.agents[selection.agentId];
    if (box === undefined || spot === undefined) return [];
    const { halfWidth, halfHeight } = agentExtent(spot);
    const x = project.x + box.x + spot.x;
    const y = project.y + box.y + spot.y;
    return [["nw", -1, -1], ["ne", 1, -1], ["sw", -1, 1], ["se", 1, 1]].map(([corner, sx, sy]) => ({
      kind: "agent", projectId: selection.projectId, quarterId: selection.quarterId, agentId: selection.agentId,
      corner, x: x + sx * halfWidth, y: y + sy * halfHeight, cx: x, cy: y, side: 2 * Math.min(halfWidth, halfHeight),
    }));
  }
  return [];
}

/** Handle under the cursor (within HANDLE_PX on the screen), or null. */
function handleAt(event) {
  const rectangle = scene.canvas.getBoundingClientRect();
  const x = event.clientX - rectangle.left;
  const y = event.clientY - rectangle.top;
  for (const handle of resizeHandles()) {
    const point = worldToScreen(scene.camera, scene.size, handle.x, handle.y);
    const centre = worldToScreen(scene.camera, scene.size, handle.cx, handle.cy);
    // A handle takes the click only if the cursor is closer to it than to the centre: on
    // a small agent the handles would otherwise take it entirely, and it could not be dragged.
    const near = Math.hypot(point.x - x, point.y - y);
    if (Math.abs(point.x - x) <= HANDLE_PX && Math.abs(point.y - y) <= HANDLE_PX
        && near < Math.hypot(centre.x - x, centre.y - y)) return handle;
  }
  return null;
}

const handleCursor = (handle) => (handle === null ? ""
  : handle.corner === "nw" || handle.corner === "se" ? "nwse-resize" : "nesw-resize");

function drawResizeHandles() {
  for (const handle of resizeHandles()) {
    // On an agent that is small on the screen, the handles are smaller: they do not cover the agent.
    const size = Math.min(HANDLE_PX, Math.max(5, handle.side * scene.camera.scale * 0.35)) / scene.camera.scale;
    rect(handle.x - size / 2, handle.y - size / 2, size, size, PALETTE.gold, "#24291f", 1.5);
  }
}

/** What the dragged thing was like at the start of the gesture: every step of it is computed from that. */
function resizeStart(handle) {
  if (handle.kind === "agent") {
    const spot = scene.layout.agents[handle.agentId];
    // Neighbours in the quarter: an agent can grow while it does not touch them.
    const quarter = worldOf()?.projection.projects.find((project) => project.projectId === handle.projectId)
      ?.quarters.find((item) => item.quarterId === handle.quarterId) ?? null;
    const others = (quarter?.agents ?? []).filter((agent) => agent.agentId !== handle.agentId)
      .map((agent) => scene.layout.agents[agent.agentId]).filter(Boolean).map((other) => ({ ...other }));
    return { x: spot.x, y: spot.y, scale: spot.scale, corner: handle.corner, others };
  }
  if (handle.kind === "quarter") {
    const box = scene.layout.quarters[handle.projectId][handle.quarterId];
    const quarter = worldOf()?.projection.projects.find((project) => project.projectId === handle.projectId)
      ?.quarters.find((item) => item.quarterId === handle.quarterId) ?? null;
    const agents = (quarter?.agents ?? []).map((agent, index) => ({ agentId: agent.agentId, index,
      ...scene.layout.agents[agent.agentId] })).filter((agent) => Number.isFinite(agent.x) && Number.isFinite(agent.y));
    return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, agents };
  }
  if (handle.kind === "world") {
    const box = scene.layout.projects[WORLD_PROJECT];
    return { width: box.width, height: box.height };
  }
  const hq = headquartersBox(scene.layout.projects[handle.projectId]);
  return { width: hq.width, height: hq.height, quarters: structuredClone(scene.layout.quarters[handle.projectId] ?? {}) };
}

function onPointerDown(event) {
  if (event.button === 2) return;
  scene.canvas.setPointerCapture(event.pointerId);
  const handle = event.button === 0 && !scene.spaceDown ? handleAt(event) : null;
  if (handle !== null) {
    scene.drag = { kind: "resize", handle, start: pointerWorld(event), origin: resizeStart(handle), moved: false };
    return;
  }
  const node = nodeAt(event);
  const start = pointerWorld(event);
  const target = event.button === 1 || scene.spaceDown || scene.tool === "pan"
    ? null : dragNodeFor(node);
  if (target === null) {
    // The middle button only pans: without a move it selects nothing and
    // opens nothing, and the browser's autoscroll does not start on it.
    if (event.button === 1) event.preventDefault();
    scene.drag = {
      kind: "pan", moved: false, panOnly: event.button === 1,
      startX: event.clientX, startY: event.clientY,
      originX: scene.camera.x, originY: scene.camera.y,
    };
    return;
  }
  scene.drag = { kind: "node", node: target, start, moved: false };
}

function onPointerMove(event) {
  const rectangle = scene.canvas.getBoundingClientRect();
  scene.pointer = {
    x: event.clientX - rectangle.left, y: event.clientY - rectangle.top, inside: true,
  };
  const drag = scene.drag;
  if (drag === null) {
    // Over a resize handle, a resize cursor.
    scene.canvas.style.cursor = handleCursor(handleAt(event));
    const node = nodeAt(event);
    // A tooltip only when the cursor has stopped: while the mouse moves, there is none,
    // and any movement removes it and restarts the countdown.
    hideSceneTooltip();
    if (!sameNode(node, scene.hover)) {
      scene.hover = node;
      requestRender();
    }
    if (node !== null) scene.tooltipTimer = setTimeout(showSceneTooltip, TOOLTIP_REST_MS);
    return;
  }
  hideSceneTooltip();
  if (drag.kind === "pan") {
    const dx = (event.clientX - drag.startX) / scene.camera.scale;
    const dy = (event.clientY - drag.startY) / scene.camera.scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    scene.camera = { ...scene.camera, x: drag.originX - dx, y: drag.originY - dy };
    scene.target = { ...scene.camera };
    requestRender();
    return;
  }
  if (drag.kind === "resize") {
    const current = pointerWorld(event);
    const dx = current.x - drag.start.x;
    const dy = current.y - drag.start.y;
    if (!drag.moved) {
      if (Math.abs(dx) * scene.camera.scale < 3 && Math.abs(dy) * scene.camera.scale < 3) return;
      drag.moved = true;
      beginGesture(drag.handle.kind === "quarter" ? tx("Resize quarter")
        : drag.handle.kind === "agent" ? tx("Resize agent")
          : drag.handle.kind === "world" ? tx("Resize World HQ") : tx("Resize HQ"));
    }
    const { handle } = drag;
    if (handle.kind === "quarter") {
      resizeQuarter(scene.layout, handle.projectId, handle.quarterId, drag.origin, handle.corner, dx, dy);
    } else if (handle.kind === "world") {
      resizeWorldHeadquarters(scene.layout, WORLD_PROJECT, drag.origin, dx, dy);
    } else if (handle.kind === "agent") {
      resizeAgent(scene.layout, handle.projectId, handle.quarterId, handle.agentId, drag.origin, dx, dy);
    } else {
      resizeHeadquarters(scene.layout, handle.projectId, drag.origin, dx, dy);
    }
    requestRender();
    return;
  }

  const current = pointerWorld(event);
  const dx = current.x - drag.start.x;
  const dy = current.y - drag.start.y;
  if (!drag.moved) {
    if (Math.abs(dx) * scene.camera.scale < 3 && Math.abs(dy) * scene.camera.scale < 3) return;
    drag.moved = true;
    beginGesture(drag.node.kind === "quarter" ? tx("Move quarter")
      : drag.node.kind === "agent" ? tx("Move agent")
        : drag.node.projectId === WORLD_PROJECT ? tx("Move World HQ") : tx("Move project"));
  }
  drag.start = current;
  const node = drag.node;
  if (node.kind === "agent") {
    // An agent follows the desired point, where the cursor leads it; at the edge
    // of the quarter it stops, and when the cursor comes back it is under it again.
    const spot = scene.layout.agents[node.agentId];
    if (spot !== undefined) {
      drag.desired ??= { x: spot.x, y: spot.y };
      drag.desired.x += dx;
      drag.desired.y += dy;
      placeAgent(scene.layout, node.projectId, node.quarterId, node.agentId, drag.desired.x, drag.desired.y);
    }
  } else if (node.kind === "quarter") {
    // A quarter follows the desired point, where the cursor leads it; in the HQ
    // zone it stops at the zone edge and catches up with the cursor again once the cursor leaves.
    const quarter = scene.layout.quarters[node.projectId]?.[node.quarterId];
    if (quarter !== undefined) {
      drag.desired ??= { x: quarter.x, y: quarter.y };
      drag.desired.x += dx;
      drag.desired.y += dy;
      const placed = placeQuarter(scene.layout, node.projectId, node.quarterId, drag.desired.x, drag.desired.y);
      if (placed !== null) {
        drag.desired.x += placed.shifted.x;
        drag.desired.y += placed.shifted.y;
      }
    }
  } else moveProject(scene.layout, node.projectId, dx, dy);
  requestRender();
}

function onPointerUp(event) {
  const drag = scene.drag;
  scene.drag = null;
  if (drag === null) return;
  if (scene.canvas.hasPointerCapture(event.pointerId)) {
    scene.canvas.releasePointerCapture(event.pointerId);
  }
  if (drag.kind === "pan") {
    if (drag.moved) {
      scene.viewTouched = true;
      onCameraSettled();
      return;
    }
    if (drag.panOnly) return;
    // Panning without movement is an ordinary click: it must select what is under
    // the cursor, not clear the selection. Otherwise a quarter, which is not dragged at its
    // level, could not be clicked.
    commitClick(nodeAt(event));
    return;
  }
  if (drag.kind === "resize") {
    // A click on a handle without movement changes nothing: the selection stays.
    if (drag.moved) {
      commitGesture();
      atlasOnHudChanged();
    }
    requestRender();
    return;
  }
  if (drag.moved) {
    // A quarter does not enter the HQ zone (placeQuarter); the check at the end of the gesture is
    // a safeguard, and it goes into the same undo step.
    if (drag.node.kind === "quarter") clearHeadquarters(scene.layout, drag.node.projectId);
    if (drag.node.kind === "agent") {
      // A released agent goes to the nearest free cell of the grid, in the same undo step.
      const { projectId, quarterId, agentId } = drag.node;
      const box = scene.layout.quarters[projectId]?.[quarterId];
      const quarter = worldOf()?.projection.projects.find((item) => item.projectId === projectId)
        ?.quarters.find((item) => item.quarterId === quarterId) ?? null;
      const spot = scene.layout.agents[agentId];
      if (box !== undefined && quarter !== null && spot !== undefined) {
        snapAgent(box, quarter.agents.map((agent) => scene.layout.agents[agent.agentId]).filter(Boolean), spot);
        fitProjectToChildren(scene.layout, projectId);
      }
    }
    commitGesture();
    requestRender();
    return;
  }
  commitClick(nodeAt(event));
}

/** A click: an HQ opens its sheet, anything else is selected; an attention badge - only with a double-click. */
function commitClick(node) {
  // A single click on an attention badge does nothing: it touches neither what is under it nor
  // the open windows. A badge opens with a double-click.
  if (node?.kind === "attention") return;
  // A click on the map removes the open sheet (HQ, creation, archive): the person
  // has come back to the map. A click on the HQ opens its sheet again at once.
  if (!document.getElementById("sheet").classList.contains("hidden")) closeSheet();
  // An agent window is open: any click outside this agent closes it (and
  // selects what was clicked), and the map is the main thing again.
  const open = typeof isWorkspaceOpen === "function" && isWorkspaceOpen() ? workspaceState.node : null;
  if (open !== null && !(node?.kind === "agent" && node.agentId === open.agentId)) closeWorkspace({ keepCamera: true });
  if (node === null) {
    selectNode(null);
    return;
  }
  // The frame of a project not on this PC: its summary and "Connect…", nothing in it to select.
  if (node.kind === "away") {
    selectNode(null);
    atlasOpenAwayProject(node.projectId);
    return;
  }
  if (node.kind === "hq") {
    selectNode({ kind: "project", projectId: node.projectId, quarterId: null, agentId: null });
    atlasOpenHeadquarters(node.projectId);
    return;
  }
  // The World HQ works like a project HQ: a click selects it (resize handle, drag) and
  // opens its sheet - the world lead, its tasks, the desk agents.
  if (node.kind === "world") {
    selectNode(node);
    atlasOpenWorldHeadquarters();
    return;
  }
  // A single click only selects, also when an agent window is open: the agent
  // window opens and switches to another agent only on a double click,
  // otherwise every click on the map would take the camera to another agent.
  selectNode(node);
}

/**
 * The cursor has left the map, for example into the agent panel on the right. The tooltip and the highlight
 * belong to the map and must disappear with the cursor instead of hanging on top.
 */
function onPointerLeave() {
  scene.pointer = { ...scene.pointer, inside: false };
  hideSceneTooltip();
  if (scene.hover !== null) {
    scene.hover = null;
    requestRender();
  }
}

function onDoubleClick(event) {
  const node = nodeAt(event);
  if (node === null) {
    goWorld();
    return;
  }
  if (node.kind === "away") return;
  enterNode(node);
}

function onWheel(event) {
  event.preventDefault();
  const rectangle = scene.canvas.getBoundingClientRect();
  const pointerX = event.clientX - rectangle.left;
  const pointerY = event.clientY - rectangle.top;
  const before = screenToWorld(scene.target, scene.size, pointerX, pointerY);

  // The area under the cursor becomes active even before the scale changes: this way
  // the third level switches to the project the person is flying to.
  const scope = inferScope(projectionOf(), scene.layout ?? emptyLayout(), before, scene.scope);
  if (scope.projectId !== scene.scope.projectId || scope.quarterId !== scene.scope.quarterId) {
    scene.scope = scope;
    if (scope.projectId !== null) scene.reference = projectScaleOf(scope.projectId);
    atlasOnScopeChanged();
  }

  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  const scale = clamp(scene.target.scale * factor, 0.02, 6);
  scene.target = {
    scale,
    x: before.x - (pointerX - scene.size.width / 2) / scale,
    y: before.y - (pointerY - scene.size.height / 2) / scale,
  };
  // The agent window opens only on a double click: zooming in deep next to
  // a unit no longer opens it by itself.

  if (scene.reducedMotion) {
    scene.camera = { ...scene.target };
    draw();
    onCameraSettled();
    return;
  }
  requestFrame();
  atlasOnHudChanged();
}

function onContextMenu(event) {
  event.preventDefault();
  atlasOpenContextMenu(nodeAt(event), { x: event.clientX, y: event.clientY });
}

function onKeyDown(event) {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
  // In the agent window, sheets and panels, keys belong to them, and selected text
  // is copied as text: the map keys (Ctrl+C for a blueprint, Space, digits, + and -)
  // work only when the map is in focus. Esc still goes back from anywhere.
  const inPanel = event.target instanceof Element
    && event.target.closest("#workspace, #sheet, .drawer, #attentionPanel, #contextMenu, .float-panel") !== null;
  const textSelected = String(window.getSelection?.() ?? "").trim() !== "";
  if ((inPanel || textSelected) && event.key !== "Escape") return;
  if (event.code === "Space") {
    scene.spaceDown = true;
    applyCursor();
    return;
  }
  const holding = event.ctrlKey || event.metaKey || event.altKey;
  // Letter shortcuts go by the physical key (event.code), so they work in any keyboard layout.
  if (!holding && event.code === "KeyV") {
    sceneSetTool("select");
    return;
  }
  if (!holding && event.code === "KeyH") {
    sceneSetTool("pan");
    return;
  }
  const key = event.key;
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redoLocal(); else undoLocal();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "y") {
    event.preventDefault();
    redoLocal();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyC") {
    event.preventDefault();
    atlasCopyBlueprint();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyV") {
    event.preventDefault();
    atlasPasteBlueprint();
    return;
  }
  if (key === "+" || key === "=") {
    sceneZoomBy(1.25);
    return;
  }
  if (key === "-" || key === "_") {
    sceneZoomBy(1 / 1.25);
    return;
  }
  // To the main base, like Backspace in StarCraft II: the World HQ is selected and in the middle of the screen.
  if (key === "Backspace" && !holding) {
    event.preventDefault();
    selectNode(worldHqNode(), { focus: true });
    return;
  }
  if (key === "Home" || key === "4") goLevel(LEVEL.world);
  else if (key === "3") goLevel(LEVEL.project);
  else if (key === "2") goLevel(LEVEL.quarter);
  else if (key === "1" && scene.selection?.kind === "agent") atlasOpenWorkspace(scene.selection);
  else if (event.code === "KeyF") fitSelection();
  else if (key === "Escape") atlasEscape();
}

function onKeyUp(event) {
  if (event.code === "Space") {
    scene.spaceDown = false;
    applyCursor();
  }
}

// --- blueprint: copy and paste -------------------------------------------------------

/**
 * A blueprint is a snapshot of the selection: its makeup, positions and your notes. The objects themselves
 * are created by the backend with its own operations, each with its own confirmation, so
 * pasting does nothing silently: it only prepares the list of what will be created.
 */
function sceneCopyBlueprint(node) {
  if (node === null || scene.layout === null) return null;
  const kind = node.kind === "hq" ? "project" : node.kind;
  const project = projectOf(node.projectId);
  if (project === null) return null;
  const annotation = (target) => {
    const value = sceneAnnotationOf(target);
    return { note: value.note, role: value.role, skills: sceneSkillsOf(target) };
  };
  // The run profile and memory are what the catalog reported about the source at the moment
  // of copying: by the time of pasting, the source agent may no longer exist.
  const agentPlan = (agent, quarterId) => ({
    kind: "agent", sourceId: agent.agentId, quarterId,
    profile: agent.profile ? { ...agent.profile } : null,
    offset: { ...(scene.layout.agents[agent.agentId] ?? { x: 60, y: 90 }) },
    annotation: annotation({ kind: "agent", projectId: node.projectId, quarterId, agentId: agent.agentId }),
  });
  const quarterPlan = (quarter) => {
    const box = scene.layout.quarters[node.projectId]?.[quarter.quarterId];
    return {
      kind: "quarter", sourceId: quarter.quarterId,
      memoryScopeId: quarter.memory?.scopeId ?? null,
      box: box === undefined ? null : { width: box.width, height: box.height },
      annotation: annotation({
        kind: "quarter", projectId: node.projectId, quarterId: quarter.quarterId, agentId: null,
      }),
      children: quarter.agents.map((agent) => agentPlan(agent, quarter.quarterId)),
    };
  };

  if (kind === "agent") {
    const quarter = quarterOf(node.projectId, node.quarterId);
    const agent = quarter?.agents.find((item) => item.agentId === node.agentId) ?? null;
    if (agent === null) return null;
    return {
      kind: "agent", sourceProjectId: node.projectId, sourceQuarterId: node.quarterId,
      root: agentPlan(agent, node.quarterId),
    };
  }
  if (kind === "quarter") {
    const quarter = quarterOf(node.projectId, node.quarterId);
    if (quarter === null) return null;
    return {
      kind: "quarter", sourceProjectId: node.projectId, sourceQuarterId: node.quarterId,
      root: quarterPlan(quarter),
    };
  }
  const box = scene.layout.projects[node.projectId];
  return {
    kind: "project", sourceProjectId: node.projectId, sourceQuarterId: null,
    root: {
      kind: "project", sourceId: node.projectId,
      memoryScopeId: project.memory?.scopeId ?? null,
      box: box === undefined ? null : { width: box.width, height: box.height },
      annotation: annotation({ kind: "project", projectId: node.projectId, quarterId: null, agentId: null }),
      children: project.quarters.map(quarterPlan),
    },
  };
}

/** Where a paste aims: the area under the cursor, otherwise the current area. */
function scenePasteTarget() {
  if (scene.layout === null) return { projectId: scene.scope.projectId, quarterId: scene.scope.quarterId };
  if (!scene.pointer.inside) return { ...scene.scope };
  const point = screenToWorld(scene.camera, scene.size, scene.pointer.x, scene.pointer.y);
  const found = locate(projectionOf(), scene.layout, point);
  if (found === null) return { ...scene.scope };
  return { projectId: found.projectId, quarterId: found.quarterId ?? scene.scope.quarterId };
}

/** Apply the local part of a blueprint to an object that has already been created. */
function sceneApplyBlueprintPart(node, part) {
  recordChange(tx("scene::Paste blueprint"), () => {
    const placement = node.kind === "project" ? scene.layout.projects[node.projectId]
      : node.kind === "quarter" ? scene.layout.quarters[node.projectId]?.[node.quarterId]
        : scene.layout.agents[node.agentId];
    if (placement === undefined || placement === null) return;
    if (part.box !== null && part.box !== undefined && node.kind !== "agent") {
      placement.width = part.box.width;
      placement.height = part.box.height;
    }
    if (part.annotation.note) placement.note = part.annotation.note.slice(0, 4096);
    if (part.annotation.role) placement.role = part.annotation.role.slice(0, 64);
    if (part.annotation.skills.length > 0) placement.skills = part.annotation.skills.slice(0, 32);
    if (node.kind === "project") fitProjectToChildren(scene.layout, node.projectId);
  });
}

// --- external surface --------------------------------------------------------------

function updateTray() {
  const world = worldOf();
  const known = new Set(projectionOf().projects.map((project) => project.projectId));
  const tray = [];
  for (const projectId of Object.keys(scene.layout?.projects ?? {})) {
    // The World HQ entry is its place on the map, not a project: it exists without the catalog too.
    if (projectId === WORLD_PROJECT) continue;
    if (!known.has(projectId)) tray.push({ kind: "project", id: projectId, reason: tx("not in the catalog") });
  }
  for (const omission of world?.projection.omissions ?? []) {
    tray.push({ kind: omission.kind, id: omission.id, reason: omission.reason });
  }
  const changed = tray.length !== scene.tray.length;
  scene.tray = tray;
  if (changed) atlasOnTrayChanged(tray);
}

function sceneSetLayout(layout, { status = "loaded" } = {}) {
  scene.layout = layout ?? emptyLayout();
  scene.layoutStatus = status;
  if (scene.history === null) {
    scene.history = createHistory({ snapshot: layoutSnapshot, restore: layoutRestore });
  }
  requestRender();
}

const sceneGetLayout = () => scene.layout;

function sceneRestoreView(view) {
  if (view === null || view === undefined) {
    goWorld({ instant: true });
    return;
  }
  scene.scope = { projectId: view.scopeProjectId ?? null, quarterId: view.scopeQuarterId ?? null };
  scene.reference = scene.scope.projectId === null ? 0 : projectScaleOf(scene.scope.projectId);
  moveCamera(view.x, view.y, view.scale, { instant: true });
}

const sceneCurrentView = () => ({
  x: scene.camera.x, y: scene.camera.y, scale: scene.camera.scale,
  scopeProjectId: scene.scope.projectId, scopeQuarterId: scene.scope.quarterId,
});

const sceneLevel = () => currentLevel();
const sceneScope = () => ({ ...scene.scope });
const sceneTray = () => scene.tray.slice();
const sceneHistory = () => scene.history;

function sceneSetTool(tool) {
  scene.tool = tool === "pan" ? "pan" : "select";
  applyCursor();
  atlasOnToolChanged(scene.tool);
}

function applyCursor() {
  if (scene.canvas === null) return;
  const panning = scene.tool === "pan" || scene.spaceDown;
  scene.canvas.classList.toggle("mode-pan", panning);
  scene.canvas.classList.toggle("mode-select", !panning);
}

const sceneTool = () => scene.tool;

function sceneZoomBy(factor) {
  const scale = clamp(scene.target.scale * factor, 0.02, 6);
  scene.target = { ...scene.target, scale };
  requestFrame();
  atlasOnHudChanged();
}

function sceneCompactProject(projectId) {
  // The World HQ is not a project territory: there is nothing in it to fit.
  if (projectId === WORLD_PROJECT) return;
  recordChange(tx("Fit project"), () => compactProject(scene.layout, projectId));
}

function sceneSetAppearance(projectId, patch) {
  recordChange(tx("Project appearance"), () => {
    const placement = scene.layout.projects[projectId];
    if (placement === undefined) return;
    if (patch.symbol !== undefined) {
      const value = patch.symbol.slice(0, 3);
      if (value === "") delete placement.symbol;
      else placement.symbol = value;
    }
    if (patch.accent !== undefined) placement.accent = patch.accent;
  });
}

function sceneSetAnnotation(node, patch) {
  recordChange(tx("Note and role"), () => {
    const placement = node.kind === "project" || node.kind === "hq" || node.kind === "world"
      ? scene.layout.projects[node.projectId]
      : node.kind === "quarter" ? scene.layout.quarters[node.projectId]?.[node.quarterId]
        : scene.layout.agents[node.agentId];
    if (placement === undefined || placement === null) return;
    for (const key of ["note", "role"]) {
      if (patch[key] === undefined) continue;
      const value = String(patch[key]);
      if (value.trim() === "") delete placement[key];
      else placement[key] = value.slice(0, key === "role" ? 64 : 4096);
    }
  });
}

function placementOf(node) {
  if (node === null || scene.layout === null) return null;
  const placement = node.kind === "project" || node.kind === "hq" || node.kind === "world"
    ? scene.layout.projects[node.projectId]
    : node.kind === "quarter" ? scene.layout.quarters[node.projectId]?.[node.quarterId]
      : scene.layout.agents[node.agentId];
  return placement ?? null;
}

function sceneAnnotationOf(node) {
  const placement = placementOf(node);
  return { note: placement?.note ?? "", role: placement?.role ?? "" };
}

/**
 * Agent skills are only your list for now. The backend does not know them and does nothing
 * with them: a skill library will come in the next version; until then this is a plan
 * that is stored next to the layout.
 */
const sceneSkillsOf = (node) => (placementOf(node)?.skills ?? []).slice();

function sceneSetSkills(node, skills) {
  recordChange(tx("Skills (your list)"), () => {
    const placement = placementOf(node);
    if (placement === null) return;
    const clean = skills
      .map((item) => String(item).trim())
      .filter((item) => item !== "")
      .slice(0, 32)
      .map((item) => item.slice(0, 64));
    if (clean.length === 0) delete placement.skills;
    else placement.skills = clean;
  });
}

/** World data updated: place new nodes before the first look at the map. */
function sceneWorldUpdated() {
  ensurePlacement();
  requestRender();
}

function sceneReplaceLayout(layout) {
  recordChange(tx("Import layout"), () => { scene.layout = layout; });
  goWorld();
}

function initScene() {
  scene.canvas = document.getElementById("mapCanvas");
  scene.ctx = scene.canvas.getContext("2d");
  scene.mini = document.getElementById("minimapCanvas");
  scene.miniCtx = scene.mini.getContext("2d");
  scene.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  scene.canvas.addEventListener("pointerdown", onPointerDown);
  // The middle button pans the map, it is not Chromium's autoscroll.
  scene.canvas.addEventListener("mousedown", (event) => { if (event.button === 1) event.preventDefault(); });
  scene.canvas.addEventListener("pointermove", onPointerMove);
  scene.canvas.addEventListener("pointerup", onPointerUp);
  scene.canvas.addEventListener("pointercancel", onPointerUp);
  scene.canvas.addEventListener("pointerleave", onPointerLeave);
  scene.canvas.addEventListener("dblclick", onDoubleClick);
  scene.canvas.addEventListener("wheel", onWheel, { passive: false });
  scene.canvas.addEventListener("contextmenu", onContextMenu);
  scene.mini.addEventListener("pointerdown", onMinimapPointer);
  applyCursor();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
}

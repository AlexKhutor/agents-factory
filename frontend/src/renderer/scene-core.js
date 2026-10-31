"use strict";

// Pure map logic: camera, levels, placement and growth, cursor hits,
// local history, attention roll-up, minimap. No DOM and no backend —
// so every rule is checked by tests without a window.
//
// The camera stores the world point at the centre of the screen, not an offset. The level
// is computed not from the absolute scale but from the reference one: the ratio
// `scale / reference` decides whether it is the world, a project or a quarter.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module !== null && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis === "undefined" ? this : globalThis, function () {
  const GEOMETRY = Object.freeze({
    // The width by which auto-layout places quarters in rows, and the initial
    // size of a project before its frame wraps its content.
    projectWidth: 760,
    projectHeight: 560,
    // Padding of the project frame around the HQ and the quarters. Nothing is drawn above the HQ,
    // so the top padding is the same as the left one.
    projectPadding: 28,
    projectHeader: 28,
    quarterWidth: 300,
    quarterHeight: 210,
    quarterGap: 34,
    agentWidth: 34,
    agentHeight: 28,
    // Quarter grid: grid points every agentGridStep from agentGridOrigin (from the quarter
    // corner); an agent stands centred on a grid point; its icon is no closer than
    // agentInset to the quarter edge and no closer than agentGap to neighbouring icons.
    // The map itself places agents in rows every agentAutoStep, starting agentAutoStart from
    // the corner (room for the name above the agent and the state frame below it).
    agentGridStep: 30,
    agentGridOrigin: 10,
    agentInset: 16,
    agentGap: 6,
    agentAutoStep: 60,
    agentAutoStart: 40,
    hqWidth: 190,
    hqHeight: 170,
    // The World HQ is the main base of the whole world, bigger than a project HQ, like the town hall
    // (Town Center) in Age of Empires II next to the houses. It stands apart,
    // to the left of the projects, and its label is built the same way as a project HQ's.
    worldHqWidth: 320,
    worldHqHeight: 280,
    worldHqLabelHeight: 52,
    // The caption under the HQ and the clearance around it: together with the building, this is the HQ zone.
    hqLabelHeight: 40,
    hqClearance: 24,
    columnGap: 150,
    rowGap: 150,
    columns: 3,
  });

  // The HQ size is a fraction of the standard one, set per project (`hqScale` in its
  // layout): the HQ is dragged by its corner and keeps its proportions.
  const HQ_SCALE = Object.freeze({ minimum: 0.4, maximum: 1.5 });
  // The World HQ is dragged by its corner the same way; it never gets smaller than half, otherwise
  // the main base would get lost next to the project HQs.
  const WORLD_HQ_SCALE = Object.freeze({ minimum: 0.5, maximum: 1.5 });
  // A quarter never gets smaller than this, even when empty: its frame and supports must stay readable.
  const QUARTER_MINIMUM = Object.freeze({ width: 120, height: 100 });
  // The agent size is a fraction of the standard one, set per agent (`scale` in its layout).
  const AGENT_SCALE = Object.freeze({ minimum: 0.4, maximum: 1.5 });

  /** Fraction of the standard agent size (from its layout); 1 without it. */
  const agentScaleOf = (spot) => (Number.isFinite(spot?.scale)
    ? clamp(spot.scale, AGENT_SCALE.minimum, AGENT_SCALE.maximum) : 1);

  /** Half-width and half-height of the agent body, at its size. */
  function agentExtent(spot) {
    const scale = agentScaleOf(spot);
    return { halfWidth: (GEOMETRY.agentWidth / 2) * scale, halfHeight: (GEOMETRY.agentHeight / 2) * scale };
  }

  // --- quarter grid -------------------------------------------------------------
  //
  // In a quarter, grid points go every GEOMETRY.agentGridStep; an agent stands
  // centred on a grid point. It takes room by its icon: a small one takes
  // little and can stand on the next grid point. An agent is dragged freely, and
  // when released it snaps to the nearest grid point where its icon does not touch
  // its neighbours (GEOMETRY.agentGap between icons) and is no closer than
  // GEOMETRY.agentInset to the edge.

  const gridStep = () => GEOMETRY.agentGridStep;
  const gridOrigin = () => GEOMETRY.agentGridOrigin;
  /** Nearest grid point along one axis: down, up or to the nearer one. */
  const onGrid = (value, round = Math.round) => gridOrigin() + round((value - gridOrigin()) / gridStep()) * gridStep();

  /** Agent icon at point (x, y) of the quarter with half the gap around it, so neighbours do not touch. */
  function agentBox(spot, x = spot.x, y = spot.y) {
    const { halfWidth, halfHeight } = agentExtent(spot);
    const half = GEOMETRY.agentGap / 2;
    return { x: x - halfWidth - half, y: y - halfHeight - half,
      width: 2 * (halfWidth + half), height: 2 * (halfHeight + half) };
  }

  /** Grid points where an agent of this size fits entirely inside a quarter of width `width`. */
  function pointRange(spot, width) {
    const { halfWidth, halfHeight } = agentExtent(spot);
    const inset = GEOMETRY.agentInset;
    const left = onGrid(inset + halfWidth, Math.ceil);
    const right = Math.max(left, onGrid(width - inset - halfWidth, Math.floor));
    const top = onGrid(inset + halfHeight, Math.ceil);
    return { left, right, top };
  }

  /** Quarter grid points where at least the smallest agent fits: the map draws them. */
  function gridPoints(width, height) {
    const smallest = { scale: AGENT_SCALE.minimum };
    const range = pointRange(smallest, width);
    const bottom = onGrid(height - GEOMETRY.agentInset - agentExtent(smallest).halfHeight, Math.floor);
    const xs = [];
    const ys = [];
    for (let x = range.left; x <= range.right; x += gridStep()) xs.push(x);
    for (let y = range.top; y <= bottom; y += gridStep()) ys.push(y);
    return { xs, ys };
  }

  /**
   * The intersection nearest to (x, y) where agent `spot` fits and does not touch
   * `others`. Below the quarter is allowed too: the quarter then grows.
   */
  function snapPoint(spot, width, x, y, others) {
    const step = gridStep();
    const range = pointRange(spot, width);
    const free = (px, py) => !others.some((other) => intersects(agentBox(spot, px, py), agentBox(other)));
    const cx = clamp(onGrid(x), range.left, range.right);
    const cy = Math.max(range.top, onGrid(y));
    for (let ring = 0; ring < 400; ring += 1) {
      let best = null;
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const px = cx + dx * step;
          const py = cy + dy * step;
          if (px < range.left || px > range.right || py < range.top || !free(px, py)) continue;
          const distance = (px - x) ** 2 + (py - y) ** 2;
          if (best === null || distance < best.distance) best = { x: px, y: py, distance };
        }
      }
      if (best !== null) return { x: best.x, y: best.y };
    }
    return { x: cx, y: cy };
  }

  /** How the map places agents by itself: in rows every GEOMETRY.agentAutoStep, from an intersection. */
  function agentSlot(index, width = GEOMETRY.quarterWidth) {
    const range = pointRange({}, width);
    const step = GEOMETRY.agentAutoStep;
    const left = Math.max(range.left, GEOMETRY.agentAutoStart);
    const top = Math.max(range.top, GEOMETRY.agentAutoStart);
    const columns = Math.max(1, Math.floor((Math.max(left, range.right) - left) / step) + 1);
    return { x: left + (index % columns) * step, y: top + Math.floor(index / columns) * step };
  }

  /** A quarter in which these agents fit (their icons with padding from the edge). */
  function agentsExtent(spots) {
    let width = 0;
    let height = 0;
    for (const spot of spots) {
      const { halfWidth, halfHeight } = agentExtent(spot);
      width = Math.max(width, spot.x + halfWidth + GEOMETRY.agentInset);
      height = Math.max(height, spot.y + halfHeight + GEOMETRY.agentInset);
    }
    return { width: Math.ceil(width), height: Math.ceil(height) };
  }

  /**
   * The quarter agents (`spots` are their places in the layout, in catalog order) go to
   * intersections: one placed by the person goes to the free one nearest to where it
   * stands; ones placed by the map go into its rows, past taken places. The quarter grows
   * so that all of them are inside. Returns whether anything changed.
   */
  function arrangeAgents(box, spots) {
    const placed = [];
    let changed = false;
    const put = (spot, point) => {
      if (spot.x !== point.x || spot.y !== point.y) changed = true;
      spot.x = point.x;
      spot.y = point.y;
      placed.push(spot);
    };
    for (const spot of spots) {
      if (spot.auto !== true) put(spot, snapPoint(spot, box.width, spot.x, spot.y, placed));
    }
    let slot = 0;
    for (const spot of spots) {
      if (spot.auto !== true) continue;
      let point = agentSlot(slot, box.width);
      while (placed.some((other) => intersects(agentBox(spot, point.x, point.y), agentBox(other)))) {
        slot += 1;
        point = agentSlot(slot, box.width);
      }
      put(spot, point);
      slot += 1;
    }
    const need = agentsExtent(spots);
    if (box.width < need.width) { box.width = need.width; changed = true; }
    if (box.height < need.height) { box.height = need.height; changed = true; }
    return changed;
  }

  /**
   * A released agent goes to the free intersection nearest to it: the others
   * placed by the person stay where they were, and the map agents move around it.
   * `spots` are the places of the quarter agents in catalog order, `spot` is the released one.
   */
  function snapAgent(box, spots, spot) {
    const others = spots.filter((other) => other !== spot && other.auto !== true);
    Object.assign(spot, snapPoint(spot, box.width, spot.x, spot.y, others));
    delete spot.auto;
    arrangeAgents(box, spots);
  }

  const LEVEL = Object.freeze({ workspace: 1, quarter: 2, project: 3, world: 4 });
  const LEVEL_THRESHOLDS = Object.freeze({ world: 0.62, project: 2.2 });

  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const lerp = (from, to, amount) => from + (to - from) * amount;

  /** Smooth step: 0 before `from`, 1 after `to`. */
  function smooth(from, to, value) {
    if (value <= from) return 0;
    if (value >= to) return 1;
    const t = (value - from) / (to - from);
    return t * t * (3 - 2 * t);
  }

  function worldToScreen(camera, viewport, x, y) {
    return {
      x: (x - camera.x) * camera.scale + viewport.width / 2,
      y: (y - camera.y) * camera.scale + viewport.height / 2,
    };
  }

  function screenToWorld(camera, viewport, x, y) {
    return {
      x: (x - viewport.width / 2) / camera.scale + camera.x,
      y: (y - viewport.height / 2) / camera.scale + camera.y,
    };
  }

  /**
   * Camera easing towards the target: position linearly, scale logarithmically, so that one
   * wheel click feels the same at any distance.
   */
  function advanceCamera(camera, target, deltaMs, { rate = 0.18, instant = false } = {}) {
    if (instant) return { x: target.x, y: target.y, scale: target.scale, settled: true };
    const amount = 1 - Math.pow(1 - rate, Math.max(deltaMs, 1) / 16.67);
    const next = {
      x: lerp(camera.x, target.x, amount),
      y: lerp(camera.y, target.y, amount),
      scale: Math.exp(lerp(Math.log(Math.max(camera.scale, 1e-4)),
        Math.log(Math.max(target.scale, 1e-4)), amount)),
    };
    const closeEnough = Math.abs(next.x - target.x) * target.scale < 0.5
      && Math.abs(next.y - target.y) * target.scale < 0.5
      && Math.abs(next.scale - target.scale) < target.scale * 0.002;
    if (closeEnough) return { x: target.x, y: target.y, scale: target.scale, settled: true };
    next.settled = false;
    return next;
  }

  /** The scale at which the rectangle fits the window. */
  function fitScale(box, viewport, { margin = 90, maximum = 6 } = {}) {
    if (box === null || viewport.width <= 0) return 1;
    return clamp(Math.min(
      (viewport.width - margin * 2) / Math.max(box.width, 1),
      (viewport.height - margin * 2) / Math.max(box.height, 1),
    ), 0.01, maximum);
  }

  /**
   * Reference scale. Until the person enters a project, it is the scale at which
   * a project of normal size fits the window; after entering, the remembered reference.
   * The level is computed from it, so a grown project does not switch the level.
   */
  function referenceScale(viewport, reference = 0) {
    if (reference > 0) return reference;
    return fitScale(
      { width: GEOMETRY.projectWidth, height: GEOMETRY.projectHeight },
      viewport, { margin: 90 },
    ) * 0.95;
  }

  const ratioFor = ({ scale }, viewport, reference = 0) => scale / referenceScale(viewport, reference);

  /**
   * Scale for “Whole world”: fits all content but never goes
   * past the world level threshold. Without this cap, one small project (or a project
   * that was just “fitted”) would fit so tightly that the resulting
   * scale would end up above the reference “standard project” one, and “Whole
   * world” itself would land at the project or quarter level instead of the world level.
   */
  function worldFitScale(bounds, viewport, { margin = 120, headroom = 0.92 } = {}) {
    const reference = referenceScale(viewport, 0);
    const ceiling = reference * LEVEL_THRESHOLDS.world * headroom;
    if (bounds === null) return Math.min(reference * 0.5, ceiling);
    return Math.min(fitScale(bounds, viewport, { margin }) * 0.98, ceiling);
  }

  function levelFor(camera, viewport, reference = 0, workspaceOpen = false) {
    if (workspaceOpen) return LEVEL.workspace;
    const ratio = ratioFor(camera, viewport, reference);
    if (ratio < LEVEL_THRESHOLDS.world) return LEVEL.world;
    if (ratio < LEVEL_THRESHOLDS.project) return LEVEL.project;
    return LEVEL.quarter;
  }

  // --- geometry ----------------------------------------------------------------

  const projectBox = (layout, projectId) => layout.projects[projectId] ?? null;
  const quarterBox = (layout, projectId, quarterId) => layout.quarters[projectId]?.[quarterId] ?? null;
  const quartersOf = (layout, projectId) => Object.entries(layout.quarters[projectId] ?? {});
  const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;

  /** Fraction of the standard HQ size for this project (from the project layout); 1 without it. */
  const hqScaleOf = (project) => (Number.isFinite(project?.hqScale)
    ? clamp(project.hqScale, HQ_SCALE.minimum, HQ_SCALE.maximum) : 1);

  /**
   * The HQ is the main building of the base, as in a strategy game: it stands in the top-left corner
   * of the project area, under the title, and moves only together with the project.
   * Coordinates are from the project origin; the size is the standard one times the project hqScale.
   */
  function headquartersBox(project = null) {
    const scale = hqScaleOf(project);
    return {
      x: GEOMETRY.projectPadding, y: GEOMETRY.projectHeader,
      width: Math.round(GEOMETRY.hqWidth * scale), height: Math.round(GEOMETRY.hqHeight * scale),
    };
  }

  /** HQ zone: the building, the caption under it and the clearance. A quarter (and with it an agent) does not enter it. */
  function headquartersZone(project = null) {
    const hq = headquartersBox(project);
    const gap = GEOMETRY.hqClearance;
    return {
      x: hq.x - gap, y: hq.y - gap,
      width: hq.width + gap * 2, height: hq.height + GEOMETRY.hqLabelHeight + gap * 2,
    };
  }

  /** Nearest place for a rectangle outside the HQ zone: to the right of it or below it, whichever is closer. */
  function outsideHeadquarters(box, project = null) {
    const zone = headquartersZone(project);
    if (!intersects(zone, box)) return { x: box.x, y: box.y };
    const right = { x: zone.x + zone.width, y: box.y };
    const below = { x: box.x, y: zone.y + zone.height };
    return right.x - box.x <= below.y - box.y ? right : below;
  }

  /**
   * The project frame wraps its content (the HQ with its caption, and the quarters) with
   * padding GEOMETRY.projectPadding: it grows and shrinks to the right and down. The project
   * origin, its top-left corner with the HQ, never moves: a quarter
   * does not go left of or above the padding (from an old layout it returns to it),
   * so dragging a quarter does not shift the project. `shifted` is always zero;
   * it stays in the result for callers that handled the former growth to the left.
   */
  function fitProjectToChildren(layout, projectId) {
    const project = projectBox(layout, projectId);
    if (project === null) return { shifted: { x: 0, y: 0 } };
    const pad = GEOMETRY.projectPadding;
    const quarters = quartersOf(layout, projectId).map(([, box]) => box);
    for (const box of quarters) {
      box.x = Math.max(box.x, pad);
      box.y = Math.max(box.y, GEOMETRY.projectHeader);
    }
    const hq = headquartersBox(project);
    const boxes = [...quarters,
      { x: hq.x, y: hq.y, width: hq.width, height: hq.height + GEOMETRY.hqLabelHeight }];
    project.width = Math.max(...boxes.map((box) => box.x + box.width)) + pad;
    project.height = Math.max(...boxes.map((box) => box.y + box.height)) + pad;
    return { shifted: { x: 0, y: 0 } };
  }

  function moveProject(layout, projectId, dx, dy) {
    const project = projectBox(layout, projectId);
    if (project === null) return false;
    project.x += dx;
    project.y += dy;
    delete project.auto;
    return true;
  }

  /**
   * Places a quarter at point (x, y) of the project, and if that is in the HQ zone, at the nearer
   * edge of the zone, to the right or below: a quarter does not cover the HQ even for a moment. The project
   * grows to fit the quarter. `shifted` is how far the children moved if the project
   * grew left or up: the desired drag point moves by the same amount,
   * so that the quarter does not lag behind the cursor.
   */
  function placeQuarter(layout, projectId, quarterId, x, y) {
    const quarter = quarterBox(layout, projectId, quarterId);
    if (quarter === null) return null;
    // A quarter does not go left of or above the project padding: the project then does not
    // move and does not grow left or up.
    const free = outsideHeadquarters({
      x: Math.max(x, GEOMETRY.projectPadding), y: Math.max(y, GEOMETRY.projectHeader),
      width: quarter.width, height: quarter.height,
    }, projectBox(layout, projectId));
    quarter.x = free.x;
    quarter.y = free.y;
    delete quarter.auto;
    return fitProjectToChildren(layout, projectId);
  }

  function moveQuarter(layout, projectId, quarterId, dx, dy) {
    const quarter = quarterBox(layout, projectId, quarterId);
    if (quarter === null) return false;
    placeQuarter(layout, projectId, quarterId, quarter.x + dx, quarter.y + dy);
    return true;
  }

  /**
   * An agent goes to point (x, y) of the quarter where the cursor leads it (within
   * the quarter). Dragging places it this way, not by offsets: otherwise past the edge
   * of the quarter cursor movement got lost, and the agent fell further and further behind it.
   */
  function placeAgent(layout, projectId, quarterId, agentId, x, y) {
    const agent = layout.agents[agentId];
    const quarter = quarterBox(layout, projectId, quarterId);
    if (agent === undefined || quarter === null) return false;
    const inset = GEOMETRY.agentInset;
    agent.x = clamp(x, inset, quarter.width - inset);
    agent.y = clamp(y, inset, quarter.height - inset);
    delete agent.auto;
    return true;
  }

  function moveAgent(layout, projectId, quarterId, agentId, dx, dy) {
    const agent = layout.agents[agentId];
    const quarter = quarterBox(layout, projectId, quarterId);
    if (agent === undefined || quarter === null) return false;
    // While dragged, it follows the cursor within the quarter; it snaps to a grid intersection
    // when released (snapAgent).
    const inset = GEOMETRY.agentInset;
    agent.x = clamp(agent.x + dx, inset, quarter.width - inset);
    agent.y = clamp(agent.y + dy, inset, quarter.height - inset);
    delete agent.auto;
    return true;
  }

  /**
   * Clears the HQ zone. A quarter found in it (from a layout saved
   * when the HQ stood in the centre of the project, or from a pasted blueprint) moves
   * to the right of the zone or below it, where it does not touch other quarters; if both
   * places are taken, it goes down row by row until a free one. Dragging does not bring it
   * into the zone (placeQuarter), so after a gesture there is usually nothing to do here.
   * Returns how many quarters moved.
   */
  function clearHeadquarters(layout, projectId) {
    const project = projectBox(layout, projectId);
    const entries = quartersOf(layout, projectId);
    if (project === null || entries.length === 0) return 0;
    const zone = headquartersZone(project);
    let moved = 0;
    for (const [quarterId, box] of entries) {
      if (!intersects(zone, box)) continue;
      const others = entries.filter(([otherId]) => otherId !== quarterId).map(([, other]) => other);
      const collides = (spot) => intersects(zone, { ...spot, width: box.width, height: box.height })
        || others.some((other) => intersects({ ...spot, width: box.width, height: box.height }, other));
      const candidates = [{ x: zone.x + zone.width, y: box.y }, { x: box.x, y: zone.y + zone.height }]
        .sort((a, b) => (Math.abs(a.x - box.x) + Math.abs(a.y - box.y))
          - (Math.abs(b.x - box.x) + Math.abs(b.y - box.y)));
      let spot = candidates.find((candidate) => !collides(candidate)) ?? candidates[0];
      for (let guard = 0; collides(spot) && guard < 60; guard += 1) {
        spot = { x: spot.x, y: spot.y + box.height + GEOMETRY.quarterGap };
      }
      box.x = spot.x;
      box.y = spot.y;
      delete box.auto;
      moved += 1;
    }
    if (moved > 0) fitProjectToChildren(layout, projectId);
    return moved;
  }

  /** “Fit”: frame by content and a free HQ zone (the frame is tight after any step anyway). */
  function compactProject(layout, projectId) {
    const result = fitProjectToChildren(layout, projectId);
    clearHeadquarters(layout, projectId);
    return result;
  }

  function autoPlaceProject(layout, projectId, index) {
    if (layout.projects[projectId] !== undefined) return layout.projects[projectId];
    const column = index % GEOMETRY.columns;
    const row = Math.floor(index / GEOMETRY.columns);
    layout.projects[projectId] = {
      x: column * (GEOMETRY.projectWidth + GEOMETRY.columnGap),
      y: row * (GEOMETRY.projectHeight + GEOMETRY.rowGap),
      width: GEOMETRY.projectWidth,
      height: GEOMETRY.projectHeight,
      auto: true,
    };
    return layout.projects[projectId];
  }

  /**
   * Projects that the map placed itself (the person has not moved them) go in rows of
   * GEOMETRY.columns, taking their real size into account. autoPlaceProject places
   * a project on the grid before its quarters go in, and a project with three
   * quarters is taller than standard: without this the rows overlapped.
   * Projects moved by the person (without the auto flag) stay where they were.
   */
  function reflowAutoProjects(layout, projectIds) {
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let inRow = 0;
    for (const projectId of projectIds) {
      const box = layout.projects[projectId];
      if (box === undefined || box.auto !== true) continue;
      if (inRow === GEOMETRY.columns) {
        y += rowHeight + GEOMETRY.rowGap;
        x = 0;
        rowHeight = 0;
        inRow = 0;
      }
      box.x = x;
      box.y = y;
      x += box.width + GEOMETRY.columnGap;
      rowHeight = Math.max(rowHeight, box.height);
      inRow += 1;
    }
  }

  // --- World HQ ------------------------------------------------------------------
  //
  // The World HQ is the world lead's building. Its place and size are kept in
  // the layout as the entry of the world's service project (`layout.projects[worldId]`):
  // { x, y, width, height } of the building, `hqScale` - a fraction of the standard size,
  // `auto` - the map chose the place. It is moved and dragged by its corner, like a project HQ.

  /** The World HQ building size at its fraction. */
  function worldHeadquartersSize(placement = null) {
    const scale = Number.isFinite(placement?.hqScale)
      ? clamp(placement.hqScale, WORLD_HQ_SCALE.minimum, WORLD_HQ_SCALE.maximum) : 1;
    return { width: Math.round(GEOMETRY.worldHqWidth * scale), height: Math.round(GEOMETRY.worldHqHeight * scale) };
  }

  /**
   * Where the World HQ stands until the person moves it: left of the projects, level with
   * their top edge, with the same gap as between project columns -
   * like the main base at the start point in a strategy game. Once placed by the map,
   * it moves only with `reflow` - when the map itself rearranged the projects, not
   * when the person drags a neighbour; once moved by the person (no `auto`), it stays
   * where it is. Returns whether it has just appeared.
   */
  function autoPlaceWorldHeadquarters(layout, worldId, projectBoxes = [], { reflow = false } = {}) {
    const existing = layout.projects[worldId];
    if (existing !== undefined && (existing.auto !== true || !reflow)) return false;
    const size = worldHeadquartersSize(existing ?? null);
    const bounds = boundsOf(projectBoxes);
    const x = bounds === null ? 0 : bounds.x - size.width - GEOMETRY.columnGap;
    const y = bounds === null ? 0 : bounds.y;
    if (existing === undefined) {
      layout.projects[worldId] = { x, y, width: size.width, height: size.height, auto: true };
      return true;
    }
    Object.assign(existing, { x, y, width: size.width, height: size.height });
    return false;
  }

  /**
   * The World HQ by its bottom-right corner, moved by dx, dy from the start of the gesture
   * (`start` - its { width, height } at that time): it keeps its proportions,
   * the top-left corner stays put.
   */
  function resizeWorldHeadquarters(layout, worldId, start, dx, dy) {
    const placement = layout.projects[worldId];
    if (placement === undefined) return false;
    const W = GEOMETRY.worldHqWidth;
    const H = GEOMETRY.worldHqHeight;
    const scale = ((start.width + dx) * W + (start.height + dy) * H) / (W ** 2 + H ** 2);
    const rounded = Math.round(clamp(scale, WORLD_HQ_SCALE.minimum, WORLD_HQ_SCALE.maximum) * 100) / 100;
    if (rounded === 1) delete placement.hqScale;
    else placement.hqScale = rounded;
    Object.assign(placement, worldHeadquartersSize(placement));
    return true;
  }

  /** The top-left corner of the project is taken by the HQ; slots that touch it are skipped. */
  function quarterSlot(project, slot) {
    // Rows are counted by the standard width, not by the frame: the frame wraps
    // the content and is narrow for a new project.
    const perRow = Math.max(1, Math.floor(
      (GEOMETRY.projectWidth - GEOMETRY.projectPadding) / (GEOMETRY.quarterWidth + GEOMETRY.quarterGap),
    ));
    return {
      x: GEOMETRY.projectPadding + (slot % perRow) * (GEOMETRY.quarterWidth + GEOMETRY.quarterGap),
      y: GEOMETRY.projectHeader
        + Math.floor(slot / perRow) * (GEOMETRY.quarterHeight + GEOMETRY.quarterGap),
      width: GEOMETRY.quarterWidth,
      height: GEOMETRY.quarterHeight,
      auto: true,
    };
  }

  /** Whether a rectangle (in project coordinates) touches the HQ zone of this project. */
  function overlapsHeadquarters(project, box) {
    return intersects(headquartersZone(project), box);
  }


  function autoPlaceQuarter(layout, projectId, quarterId, index) {
    if (layout.quarters[projectId] === undefined) layout.quarters[projectId] = {};
    const existing = layout.quarters[projectId][quarterId];
    if (existing !== undefined) return existing;
    const project = autoPlaceProject(layout, projectId, 0);
    const taken = Object.values(layout.quarters[projectId]);
    let slot = index;
    let placement = quarterSlot(project, slot);
    const collides = (box) => taken.some((other) => box.x < other.x + other.width
      && box.x + box.width > other.x && box.y < other.y + other.height
      && box.y + box.height > other.y);
    let guard = 0;
    while ((overlapsHeadquarters(project, placement) || collides(placement)) && guard < 40) {
      slot += 1;
      guard += 1;
      placement = quarterSlot(project, slot);
    }
    layout.quarters[projectId][quarterId] = placement;
    fitProjectToChildren(layout, projectId);
    // The layout the map builds itself never puts a quarter on the HQ.
    clearHeadquarters(layout, projectId);
    return layout.quarters[projectId][quarterId];
  }

  /** A new agent goes into the map rows in a quarter of width `width` (arrangeAgents avoids taken places). */
  function autoPlaceAgent(layout, agentId, index, width = GEOMETRY.quarterWidth) {
    if (layout.agents[agentId] !== undefined) return layout.agents[agentId];
    layout.agents[agentId] = { ...agentSlot(index, width), auto: true };
    return layout.agents[agentId];
  }

  // --- resize by a corner --------------------------------------------------------
  //
  // Quarters and the HQ are resized by a corner. Each step of the gesture is computed from what they
  // were at its start (`start`), not from the previous step: rounding does not pile up, and
  // whatever the gesture moved along the way comes back if the corner is led back.

  /**
   * Quarter by corner `corner` ("nw" | "ne" | "sw" | "se"), moved by dx, dy
   * from the start of the gesture. `start` is the quarter and its agents at that time:
   * `{ box, agents: [{ agentId, x, y, auto, scale }] }` in catalog order.
   * Agents stay on their intersections (they are measured from the quarter corner: when the left or
   * top edge is dragged, they move with it); map agents go into its rows for
   * the new width. The quarter is no smaller than the icons of its agents need, does not enter
   * the HQ zone and does not go past the project padding. Returns whether it worked.
   */
  function resizeQuarter(layout, projectId, quarterId, start, corner, dx, dy) {
    const quarter = quarterBox(layout, projectId, quarterId);
    const project = projectBox(layout, projectId);
    if (quarter === null || project === null) return false;
    const from = start.box;
    const west = corner.includes("w");
    const north = corner.includes("n");

    // The width is at least up to the right edge of the agents placed by the person.
    const manual = start.agents.filter((agent) => agent.auto !== true);
    const minWidth = Math.max(QUARTER_MINIMUM.width, agentsExtent(manual).width);
    let left = from.x + (west ? dx : 0);
    let right = from.x + from.width + (west ? 0 : dx);
    if (west) left = Math.min(left, right - minWidth);
    else right = Math.max(right, left + minWidth);
    left = Math.max(left, GEOMETRY.projectPadding);
    const width = Math.round(right - left);

    // The height is what the agents take at this width (a trial arrangement).
    const trial = { width, height: 0 };
    arrangeAgents(trial, start.agents.map((agent) => ({ ...agent })));
    const minHeight = Math.max(QUARTER_MINIMUM.height, trial.height);
    let top = from.y + (north ? dy : 0);
    let bottom = from.y + from.height + (north ? 0 : dy);
    if (north) top = Math.min(top, bottom - minHeight);
    else bottom = Math.max(bottom, top + minHeight);
    top = Math.max(top, GEOMETRY.projectHeader);

    // An edge led into the HQ zone stops at it: the one that moves less.
    const zone = headquartersZone(project);
    let box = { x: Math.round(left), y: Math.round(top), width, height: Math.round(bottom - top) };
    if (intersects(zone, box) && (west || north)) {
      const options = [];
      if (west) options.push({ ...box, x: zone.x + zone.width, width: box.x + box.width - (zone.x + zone.width) });
      if (north) options.push({ ...box, y: zone.y + zone.height, height: box.y + box.height - (zone.y + zone.height) });
      const fits = options.filter((option) => !intersects(zone, option)
        && option.width >= minWidth && option.height >= minHeight);
      if (fits.length === 0) return false;
      fits.sort((a, b) => (Math.abs(a.x - box.x) + Math.abs(a.y - box.y)) - (Math.abs(b.x - box.x) + Math.abs(b.y - box.y)));
      box = fits[0];
    }

    Object.assign(quarter, box);
    delete quarter.auto;
    const spots = [];
    for (const agent of start.agents) {
      const spot = layout.agents[agent.agentId];
      if (spot === undefined) continue;
      spot.x = agent.x;
      spot.y = agent.y;
      spots.push(spot);
    }
    arrangeAgents(quarter, spots);
    fitProjectToChildren(layout, projectId);
    return true;
  }

  /**
   * HQ by its bottom-right corner (the top-left one is the project corner), moved by
   * dx, dy from the start of the gesture. The HQ keeps its proportions: the fraction is the one closest
   * to where the corner is led, from HQ_SCALE.minimum to maximum. Quarters that
   * it ran over move right or down; if the corner is led back,
   * they return (`start` is `{ width, height, quarters }` at the start of the gesture).
   */
  function resizeHeadquarters(layout, projectId, start, dx, dy) {
    const project = projectBox(layout, projectId);
    if (project === null) return false;
    const width = start.width + dx;
    const height = start.height + dy;
    // The fraction at which the HQ is closest to the rectangle up to the corner.
    const scale = (width * GEOMETRY.hqWidth + height * GEOMETRY.hqHeight)
      / (GEOMETRY.hqWidth ** 2 + GEOMETRY.hqHeight ** 2);
    const rounded = Math.round(clamp(scale, HQ_SCALE.minimum, HQ_SCALE.maximum) * 100) / 100;
    if (rounded === 1) delete project.hqScale;
    else project.hqScale = rounded;
    for (const [quarterId, box] of Object.entries(start.quarters ?? {})) {
      const quarter = quarterBox(layout, projectId, quarterId);
      if (quarter !== null) Object.assign(quarter, box);
    }
    clearHeadquarters(layout, projectId);
    fitProjectToChildren(layout, projectId);
    return true;
  }

  /**
   * Agent by corner `start.corner`, moved by dx, dy from the start of the gesture: it
   * changes around its centre, keeping its proportions; the fraction is the one at which
   * its corner is closest to the cursor, from AGENT_SCALE.minimum to maximum. It can
   * grow while its icon does not touch its neighbours (`start.others`) or the edge
   * of the quarter; it stays on its intersection (`start` is `{ x, y, scale, corner,
   * others }` at the start of the gesture).
   */
  function resizeAgent(layout, projectId, quarterId, agentId, start, dx, dy) {
    const spot = layout.agents[agentId];
    const quarter = quarterBox(layout, projectId, quarterId);
    if (spot === undefined || quarter === null) return false;
    const halfWidth = GEOMETRY.agentWidth / 2;
    const halfHeight = GEOMETRY.agentHeight / 2;
    const from = agentScaleOf(start);
    const across = (start.corner.includes("e") ? 1 : -1) * dx;
    const down = (start.corner.includes("s") ? 1 : -1) * dy;
    const scale = ((halfWidth * from + across) * halfWidth + (halfHeight * from + down) * halfHeight)
      / (halfWidth ** 2 + halfHeight ** 2);
    let rounded = Math.round(clamp(scale, AGENT_SCALE.minimum, AGENT_SCALE.maximum) * 100) / 100;
    const others = start.others ?? [];
    const inset = GEOMETRY.agentInset;
    const fits = (value) => {
      const probe = { scale: value };
      const { halfWidth: hw, halfHeight: hh } = agentExtent(probe);
      return start.x - hw >= inset && start.x + hw <= quarter.width - inset && start.y - hh >= inset
        && start.y + hh <= quarter.height - inset
        && !others.some((other) => intersects(agentBox(probe, start.x, start.y), agentBox(other)));
    };
    // Larger than at the start of the gesture only while it fits.
    while (rounded > from && rounded > AGENT_SCALE.minimum && !fits(rounded)) rounded = Math.round((rounded - 0.01) * 100) / 100;
    if (rounded === 1) delete spot.scale;
    else spot.scale = rounded;
    spot.x = start.x;
    spot.y = start.y;
    return true;
  }

  // --- what can be selected and what is under a point ---------------------------

  /**
   * What is dragged with the mouse at this level: in the world, a whole project; in a project,
   * a quarter; in a quarter, an agent. Selecting an object is not limited by this rule: it
   * is only about dragging, so that a small object does not move instead of a large one.
   */
  function selectableAtLevel(level, scope = {}) {
    if (level >= LEVEL.world) return "project";
    if (level === LEVEL.project) return "quarter";
    return "agent";
  }

  const inside = (box, point) => point.x >= box.x && point.x <= box.x + box.width
    && point.y >= box.y && point.y <= box.y + box.height;

  /** What is at a world point, regardless of the level. */
  function locate(world, layout, point) {
    for (let index = world.projects.length - 1; index >= 0; index -= 1) {
      const project = world.projects[index];
      const box = projectBox(layout, project.projectId);
      if (box === null || !inside(box, point)) continue;
      const local = { x: point.x - box.x, y: point.y - box.y };
      for (const quarter of project.quarters) {
        const quarterPlacement = quarterBox(layout, project.projectId, quarter.quarterId);
        if (quarterPlacement === null || !inside(quarterPlacement, local)) continue;
        const inner = { x: local.x - quarterPlacement.x, y: local.y - quarterPlacement.y };
        for (const agent of quarter.agents) {
          const placement = layout.agents[agent.agentId];
          if (placement === undefined) continue;
          const extent = agentExtent(placement);
          if (Math.abs(inner.x - placement.x) <= extent.halfWidth + 8
              && Math.abs(inner.y - placement.y) <= extent.halfHeight + 10) {
            return {
              kind: "agent", projectId: project.projectId,
              quarterId: quarter.quarterId, agentId: agent.agentId,
            };
          }
        }
        return {
          kind: "quarter", projectId: project.projectId,
          quarterId: quarter.quarterId, agentId: null,
        };
      }
      return { kind: "project", projectId: project.projectId, quarterId: null, agentId: null };
    }
    return null;
  }

  /**
   * What is under a point. The object is found exactly and the same way at any level:
   * from the overview, the main building, a quarter and
   * a single agent must all open too. The order is from small to large: agent, HQ, quarter,
   * project. The tolerance is in world units: the caller computes it
   * from the camera scale so that a small unit stays reachable from afar.
   */
  function hitTest(world, layout, point, level, scope = {}, { tolerance = 0 } = {}) {
    for (let index = world.projects.length - 1; index >= 0; index -= 1) {
      const project = world.projects[index];
      const box = projectBox(layout, project.projectId);
      if (box === null || !inside(box, point)) continue;
      const local = { x: point.x - box.x, y: point.y - box.y };

      for (const quarter of project.quarters) {
        const placement = quarterBox(layout, project.projectId, quarter.quarterId);
        if (placement === null) continue;
        for (const agent of quarter.agents) {
          const spot = layout.agents[agent.agentId];
          if (spot === undefined) continue;
          const extent = agentExtent(spot);
          if (Math.abs(local.x - placement.x - spot.x) <= extent.halfWidth + 8 + tolerance
              && Math.abs(local.y - placement.y - spot.y) <= extent.halfHeight + 10 + tolerance) {
            return {
              kind: "agent", projectId: project.projectId,
              quarterId: quarter.quarterId, agentId: agent.agentId,
            };
          }
        }
      }

      if (inside(headquartersBox(box), local)) {
        return { kind: "hq", projectId: project.projectId, quarterId: null, agentId: null };
      }

      for (const quarter of project.quarters) {
        const placement = quarterBox(layout, project.projectId, quarter.quarterId);
        if (placement === null || !inside(placement, local)) continue;
        return {
          kind: "quarter", projectId: project.projectId,
          quarterId: quarter.quarterId, agentId: null,
        };
      }
      return { kind: "project", projectId: project.projectId, quarterId: null, agentId: null };
    }
    return null;
  }

  /**
   * What will follow the cursor: what is under it, at any level — an agent, a quarter
   * or a project (by its HQ, its plaque or empty ground). Panning is on empty
   * ground, with the middle button, with Space held or with the “Hand” tool.
   */
  function dragTargetFor(node) {
    if (node === null) return null;
    if (node.kind === "agent") return node;
    if (node.kind === "quarter") {
      return { kind: "quarter", projectId: node.projectId, quarterId: node.quarterId, agentId: null };
    }
    return { kind: "project", projectId: node.projectId, quarterId: null, agentId: null };
  }

  /** The area that contains the point: the active project switches by it. */
  function inferScope(world, layout, point, previous = { projectId: null, quarterId: null }) {
    const found = locate(world, layout, point);
    if (found === null) return previous;
    if (found.kind === "project") {
      return { projectId: found.projectId, quarterId: previous.projectId === found.projectId
        ? previous.quarterId : null };
    }
    return { projectId: found.projectId, quarterId: found.quarterId };
  }

  // --- history ------------------------------------------------------------------

  function createHistory({ limit = 40, snapshot, restore } = {}) {
    const past = [];
    const future = [];
    let pending = null;
    return {
      begin(label) { pending = { label, before: snapshot() }; },
      commit() {
        if (pending === null) return false;
        past.push(pending);
        if (past.length > limit) past.shift();
        future.length = 0;
        pending = null;
        return true;
      },
      abandon() { pending = null; },
      record(label, action) {
        const before = snapshot();
        action();
        past.push({ label, before });
        if (past.length > limit) past.shift();
        future.length = 0;
      },
      undo() {
        const entry = past.pop();
        if (entry === undefined) return null;
        future.push({ label: entry.label, before: snapshot() });
        restore(entry.before);
        return entry.label;
      },
      redo() {
        const entry = future.pop();
        if (entry === undefined) return null;
        past.push({ label: entry.label, before: snapshot() });
        restore(entry.before);
        return entry.label;
      },
      get canUndo() { return past.length > 0; },
      get canRedo() { return future.length > 0; },
      get undoLabel() { return past.length > 0 ? past[past.length - 1].label : null; },
    };
  }

  // --- attention -----------------------------------------------------------------

  // recovery and captured-pending are attention captured by the catalog (Kit v0.15.0).
  // refused - an action of the agent was refused (by the person or the desk's rules) in its last turn.
  const SEVERITY = Object.freeze({
    interaction: 1, "captured-pending": 1, "turn-finished": 1, "asks-you": 1, state: 2, recovery: 2, refused: 2, problem: 3,
  });
  // Signals that wait for the person's action pulse; an unread answer does not.
  const CALM = Object.freeze(new Set(["turn-finished"]));

  function aggregateAttention(world) {
    const byAgent = new Map();
    const byQuarter = new Map();
    const byProject = new Map();
    if (world === null) return { byAgent, byQuarter, byProject, total: 0 };
    const bump = (map, key, severity, urgent) => {
      const current = map.get(key) ?? { count: 0, severity: 0, urgent: false };
      map.set(key, { count: current.count + 1, severity: Math.max(current.severity, severity),
        urgent: current.urgent || urgent });
    };
    for (const item of world.attention ?? []) {
      // A turn that failed is not a calm "answer is ready": it waits for the person like a state problem.
      const failedTurn = item.kind === "turn-finished" && item.outcome === "failed";
      const severity = failedTurn ? SEVERITY.state : SEVERITY[item.kind] ?? 1;
      const urgent = failedTurn || !CALM.has(item.kind);
      bump(byAgent, item.agentId, severity, urgent);
      if (item.quarterId) bump(byQuarter, `${item.projectId}/${item.quarterId}`, severity, urgent);
      if (item.projectId) bump(byProject, item.projectId, severity, urgent);
    }
    return { byAgent, byQuarter, byProject, total: (world.attention ?? []).length };
  }

  function boundsOf(boxes) {
    if (boxes.length === 0) return null;
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    return {
      x,
      y,
      width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
      height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
    };
  }

  const centreOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

  // --- minimap --------------------------------------------------------------------

  /** Transform from the world to the minimap and back, so that you can navigate by it. */
  function minimapTransform(bounds, size, { padding = 14, margin = 260 } = {}) {
    if (bounds === null || size.width <= 0) return null;
    const world = {
      x: bounds.x - margin, y: bounds.y - margin,
      width: bounds.width + margin * 2, height: bounds.height + margin * 2,
    };
    const scale = Math.min((size.width - padding * 2) / world.width,
      (size.height - padding * 2) / world.height);
    const offsetX = size.width / 2 - (world.x + world.width / 2) * scale;
    const offsetY = size.height / 2 - (world.y + world.height / 2) * scale;
    return {
      scale,
      offsetX,
      offsetY,
      toMap: (x, y) => ({ x: x * scale + offsetX, y: y * scale + offsetY }),
      toWorld: (x, y) => ({ x: (x - offsetX) / scale, y: (y - offsetY) / scale }),
    };
  }

  return {
    GEOMETRY,
    HQ_SCALE,
    WORLD_HQ_SCALE,
    worldHeadquartersSize,
    autoPlaceWorldHeadquarters,
    resizeWorldHeadquarters,
    QUARTER_MINIMUM,
    AGENT_SCALE,
    agentScaleOf,
    agentExtent,
    agentSlot,
    agentBox,
    pointRange,
    gridPoints,
    snapPoint,
    agentsExtent,
    arrangeAgents,
    snapAgent,
    resizeQuarter,
    resizeHeadquarters,
    resizeAgent,
    LEVEL,
    LEVEL_THRESHOLDS,
    clamp,
    lerp,
    smooth,
    worldToScreen,
    screenToWorld,
    advanceCamera,
    fitScale,
    referenceScale,
    worldFitScale,
    ratioFor,
    levelFor,
    fitProjectToChildren,
    compactProject,
    moveProject,
    moveQuarter,
    placeQuarter,
    moveAgent,
    placeAgent,
    autoPlaceProject,
    autoPlaceQuarter,
    headquartersBox,
    headquartersZone,
    overlapsHeadquarters,
    clearHeadquarters,
    reflowAutoProjects,
    autoPlaceAgent,
    selectableAtLevel,
    locate,
    hitTest,
    dragTargetFor,
    inferScope,
    createHistory,
    aggregateAttention,
    boundsOf,
    centreOf,
    minimapTransform,
  };
}));

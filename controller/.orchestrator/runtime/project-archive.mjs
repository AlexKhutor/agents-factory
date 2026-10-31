// Projects and quarters the person archived.
//
// An archived project leaves the map: its project and quarter scopes are no
// longer listed, nor its agents, and nothing new can be created in it. An
// archived quarter leaves the map the same way inside a project that stays.
// Nothing is deleted - memory and its revisions, the folder binding, closed
// agents and their conversation archives stay exactly as they were - and
// restoring brings the project or the quarter back unchanged. Something is
// archived only once none of its agents is open: an agent is closed first,
// which keeps its history.
//
// Archiving and restoring are trusted host actions (the memory CLI), never
// operations of the Gateway's HTTP surface. The record is one store document,
// changed by compare-and-swap like the agent catalog.

export const PROJECT_ARCHIVE_VERSION = "v0.2.0";

const KEY = "memory-project-archive-v1";
const AGENTS_KEY = "memory-agents-v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAXIMUM_ARCHIVED = 1_000;

function fail(code) { throw Object.assign(new Error(code), { code }); }

function idOf(value) {
  if (typeof value !== "string" || !ID.test(value)) fail("memory_invalid_input");
  return value;
}

const quarterKey = (projectId, quarterId) => `${projectId}/${quarterId}`;

async function readArchive(store) {
  // A store without documents (tests, reduced fixtures) has nothing archived.
  if (typeof store?.readDocument !== "function") return { revision: 0, projects: {}, quarters: {} };
  const record = await store.readDocument({ key: KEY });
  return {
    revision: record?.revision ?? 0,
    projects: { ...(record?.value?.projects ?? {}) },
    quarters: { ...(record?.value?.quarters ?? {}) },
  };
}

/** What is archived: project IDs and "project/quarter" keys. */
export async function archivedSets(store) {
  const archive = await readArchive(store);
  return { projects: new Set(Object.keys(archive.projects)), quarters: new Set(Object.keys(archive.quarters)) };
}

/** The IDs of the archived projects. */
export async function archivedProjectIds(store) {
  return (await archivedSets(store)).projects;
}

/** Applies `change` to the archive; `change` returns null when nothing changes. */
async function update(store, change) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readArchive(store);
    const next = change({ projects: current.projects, quarters: current.quarters });
    if (next === null) return current;
    if (Object.keys(next.projects).length + Object.keys(next.quarters).length > MAXIMUM_ARCHIVED) {
      fail("memory_limit_exceeded");
    }
    if (await store.compareAndSwapDocument({
      key: KEY, expectedRevision: current.revision,
      value: { schemaVersion: 1, projects: next.projects, quarters: next.quarters },
    })) return next;
  }
  return fail("memory_contention");
}

async function projectScopes(store, projectId) {
  return (await store.listScopes({ projectId })).scopes;
}

async function openAgents(store, projectId, quarterId = null) {
  const agents = (await store.readDocument({ key: AGENTS_KEY }))?.value?.agents ?? [];
  return agents.filter((agent) => agent.projectId === projectId && agent.state !== "archived"
    && (quarterId === null || agent.quarterId === quarterId));
}

export async function archiveProject({ store, projectId, now = () => new Date() }) {
  idOf(projectId);
  const scopes = await projectScopes(store, projectId);
  if (!scopes.some((scope) => scope.kind === "project")) fail("memory_project_not_found");
  if ((await openAgents(store, projectId)).length > 0) fail("memory_project_has_agents");
  const archivedAtUtc = now().toISOString();
  const archive = await update(store, (current) => (Object.hasOwn(current.projects, projectId) ? null
    : { ...current, projects: { ...current.projects, [projectId]: { archivedAtUtc } } }));
  return { schemaVersion: 1, projectId, archived: true, archivedAtUtc: archive.projects[projectId].archivedAtUtc };
}

export async function restoreProject({ store, projectId }) {
  idOf(projectId);
  let changed = false;
  await update(store, (current) => {
    if (!Object.hasOwn(current.projects, projectId)) return null;
    changed = true;
    const { [projectId]: _restored, ...projects } = current.projects;
    return { ...current, projects };
  });
  return { schemaVersion: 1, projectId, archived: false, changed };
}

export async function archiveQuarter({ store, projectId, quarterId, now = () => new Date() }) {
  idOf(projectId);
  idOf(quarterId);
  if ((await archivedProjectIds(store)).has(projectId)) fail("memory_project_archived");
  const scopes = await projectScopes(store, projectId);
  if (!scopes.some((scope) => scope.kind === "quarter" && scope.quarterId === quarterId)) {
    fail("memory_quarter_not_found");
  }
  if ((await openAgents(store, projectId, quarterId)).length > 0) fail("memory_quarter_has_agents");
  const key = quarterKey(projectId, quarterId);
  const archivedAtUtc = now().toISOString();
  const archive = await update(store, (current) => (Object.hasOwn(current.quarters, key) ? null
    : { ...current, quarters: { ...current.quarters, [key]: { projectId, quarterId, archivedAtUtc } } }));
  return { schemaVersion: 1, projectId, quarterId, archived: true, archivedAtUtc: archive.quarters[key].archivedAtUtc };
}

export async function restoreQuarter({ store, projectId, quarterId }) {
  idOf(projectId);
  idOf(quarterId);
  const key = quarterKey(projectId, quarterId);
  let changed = false;
  await update(store, (current) => {
    if (!Object.hasOwn(current.quarters, key)) return null;
    changed = true;
    const { [key]: _restored, ...quarters } = current.quarters;
    return { ...current, quarters };
  });
  return { schemaVersion: 1, projectId, quarterId, archived: false, changed };
}

/** The archive, newest first: projects, and quarters of projects that are not archived themselves. */
export async function listArchivedProjects({ store }) {
  const archive = await readArchive(store);
  const projects = [];
  for (const [projectId, record] of Object.entries(archive.projects)) {
    const scopes = await projectScopes(store, projectId);
    const project = scopes.find((scope) => scope.kind === "project") ?? null;
    projects.push({
      projectId,
      title: project?.title ?? null,
      quarterCount: scopes.filter((scope) => scope.kind === "quarter").length,
      archivedAtUtc: record.archivedAtUtc,
    });
  }
  const quarters = [];
  for (const record of Object.values(archive.quarters)) {
    if (Object.hasOwn(archive.projects, record.projectId)) continue;
    const scope = (await projectScopes(store, record.projectId))
      .find((item) => item.kind === "quarter" && item.quarterId === record.quarterId) ?? null;
    quarters.push({ projectId: record.projectId, quarterId: record.quarterId,
      title: scope?.title ?? null, archivedAtUtc: record.archivedAtUtc });
  }
  const newestFirst = (left, right) => right.archivedAtUtc.localeCompare(left.archivedAtUtc);
  return { schemaVersion: 1, projects: projects.sort(newestFirst), quarters: quarters.sort(newestFirst) };
}

/** A scope listing without archived projects and quarters. */
export async function listVisibleScopes(store, input = {}) {
  const archived = await archivedSets(store);
  if (input.projectId !== undefined && archived.projects.has(input.projectId)) {
    return { schemaVersion: 1, scopes: [], truncated: false };
  }
  const listed = await store.listScopes(input);
  if (archived.projects.size === 0 && archived.quarters.size === 0) return listed;
  return { ...listed, scopes: listed.scopes.filter((scope) => !archived.projects.has(scope.projectId)
    && !(scope.quarterId !== null && archived.quarters.has(quarterKey(scope.projectId, scope.quarterId)))) };
}

/** An agent listing without the (closed) agents of archived projects and quarters. */
export async function hideArchivedAgents(store, listed) {
  const archived = await archivedSets(store);
  if (archived.projects.size === 0 && archived.quarters.size === 0) return listed;
  const agents = listed.agents.filter((agent) => !archived.projects.has(agent.projectId)
    && !archived.quarters.has(quarterKey(agent.projectId, agent.quarterId)));
  return { ...listed, agents, totalAgents: agents.length };
}

/** Refuses to create anything in an archived project or quarter. */
export async function requireOpenProject(store, projectId, quarterId = null) {
  const archived = await archivedSets(store);
  if (archived.projects.has(projectId)) fail("memory_project_archived");
  if (quarterId !== null && archived.quarters.has(quarterKey(projectId, quarterId))) fail("memory_quarter_archived");
}

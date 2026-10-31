// Which SQLite implementation a store uses.
//
// "node": SQLite inside this process through node:sqlite (DatabaseSync). It
// exists from Node 22.5 (unflagged from 22.13) and in Electron 41 (Node 24).
// "python": the Python bridge scripts beside these modules, as before.
//
// Node is the default whenever node:sqlite loads. A constructor option
// (`sqliteBackend`) wins, then the environment (AGENTS_FACTORY_SQLITE), then
// the default. The module is loaded with a dynamic import because the Gateway
// bundle targets node20, where it does not exist: a runtime without it falls
// back to Python instead of failing, also when "node" was asked for.

export const SQLITE_BACKENDS = Object.freeze(["node", "python"]);
export const SQLITE_BACKEND_ENVIRONMENT = "AGENTS_FACTORY_SQLITE";

let loading = null;

function experimentalSqliteWarning(warning, rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  const name = type ?? warning?.name;
  const message = typeof warning === "string" ? warning : warning?.message;
  return name === "ExperimentalWarning" && /\bSQLite\b/u.test(String(message ?? ""));
}

async function importNodeSqlite() {
  // Node 22 prints an ExperimentalWarning on the first load. Stores are an
  // internal detail of the Gateway and the CLIs, whose stderr carries their
  // own diagnostics, so only that one warning is dropped while loading.
  const emitWarning = process.emitWarning;
  process.emitWarning = function emitWarningExceptSqlite(warning, ...rest) {
    if (experimentalSqliteWarning(warning, rest)) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    const module = await import("node:sqlite");
    return typeof module?.DatabaseSync === "function" ? module : null;
  } catch {
    return null;
  } finally {
    if (process.emitWarning.name === "emitWarningExceptSqlite") process.emitWarning = emitWarning;
  }
}

/** node:sqlite, or null when this runtime does not have it. Loaded once. */
export function loadNodeSqlite() {
  loading ??= importNodeSqlite();
  return loading;
}

/** The value of an explicit option; an invalid one is a programming error. */
export function sqliteBackendOption(value) {
  if (value === undefined || value === null) return null;
  if (!SQLITE_BACKENDS.includes(value)) {
    const error = new TypeError(`sqliteBackend must be one of ${SQLITE_BACKENDS.join(", ")}`);
    error.code = "SQLITE_BACKEND_INVALID";
    throw error;
  }
  return value;
}

/** The backend asked for by the option, else by the environment, else null. */
export function requestedSqliteBackend(option) {
  const explicit = sqliteBackendOption(option);
  if (explicit !== null) return explicit;
  const environment = String(process.env[SQLITE_BACKEND_ENVIRONMENT] ?? "").trim().toLowerCase();
  return SQLITE_BACKENDS.includes(environment) ? environment : null;
}

/**
 * Resolves to { backend: "node", sqlite } or { backend: "python", sqlite: null }.
 * `load` exists for tests.
 */
export async function resolveSqliteBackend({ backend, load = loadNodeSqlite } = {}) {
  if (requestedSqliteBackend(backend) === "python") return { backend: "python", sqlite: null };
  const sqlite = await load();
  return sqlite ? { backend: "node", sqlite } : { backend: "python", sqlite: null };
}

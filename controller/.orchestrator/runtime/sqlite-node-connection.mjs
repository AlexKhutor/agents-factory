import { PythonError, pyIsInt, pyTypeName, utf8 } from "./sqlite-python-compat.mjs";

// One node:sqlite connection opened the way Python's sqlite3.connect opens
// one, for the store implementations in *-node.mjs. Like the Python bridges,
// a store opens a connection per request and closes it after: the database
// file is not held between requests, and closing the last connection of a WAL
// database checkpoints it, as before.

const SQLITE_CONSTRAINT = 19;

/** sqlite3.IntegrityError: a constraint failed. */
export function isIntegrityError(error) {
  return typeof error?.errcode === "number" && (error.errcode & 0xff) === SQLITE_CONSTRAINT;
}

/** A parameter as Python's sqlite3 binds it: bool and int as INTEGER, float as REAL. */
function bindValue(value, index) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") {
    if (!pyIsInt(value)) return value;
    if (value >= 2 ** 63 || value < -(2 ** 63)) {
      throw new PythonError("OverflowError", "Python int too large to convert to SQLite INTEGER");
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) utf8(value);
    return value;
  }
  if (typeof value === "bigint") {
    if (value >= 2n ** 63n || value < -(2n ** 63n)) {
      throw new PythonError("OverflowError", "Python int too large to convert to SQLite INTEGER");
    }
    return value;
  }
  throw new PythonError("ProgrammingError",
    `Error binding parameter ${index}: type '${pyTypeName(value)}' is not supported`);
}

function bound(parameters) {
  return parameters.map((value, index) => bindValue(value, index + 1));
}

/**
 * Integers are read as Python reads them (any size) and become the number
 * JSON.parse made of the bridge's answer: beyond 2^53 the nearest one.
 */
function prepared(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

function row(value) {
  if (value === undefined || value === null) return null;
  for (const key of Object.keys(value)) {
    if (typeof value[key] === "bigint") value[key] = Number(value[key]);
  }
  return value;
}

/**
 * A plain read-only handle that waits for a busy database like a store
 * connection does. Without the wait a read fails at once ("database is
 * locked") while another process closes its last connection and checkpoints
 * the WAL - every few reads while the Gateway serves Atlas.
 */
export function openReadOnlyDatabase(sqlite, location, { timeoutMs = 10_000 } = {}) {
  const database = new sqlite.DatabaseSync(location, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout=${Math.trunc(timeoutMs)}`);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

export class NodeSqliteConnection {
  /**
   * `timeoutMs` is the busy timeout sqlite3.connect(timeout=...) sets before
   * any statement runs. Foreign keys start off and double-quoted string
   * literals stay allowed, as in Python's sqlite3 (node:sqlite flips both).
   */
  constructor(sqlite, location, { timeoutMs, readOnly = false }) {
    this.database = new sqlite.DatabaseSync(location, {
      readOnly,
      enableForeignKeyConstraints: false,
      enableDoubleQuotedStringLiterals: true,
    });
    try {
      this.database.exec(`PRAGMA busy_timeout=${Math.trunc(timeoutMs)}`);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  /** Statements without parameters, run to completion. */
  exec(sql) {
    this.database.exec(sql);
  }

  get(sql, parameters = []) {
    return row(prepared(this.database, sql).get(...bound(parameters)));
  }

  all(sql, parameters = []) {
    return prepared(this.database, sql).all(...bound(parameters)).map(row);
  }

  /** { changes, lastInsertRowid } of one statement. */
  run(sql, parameters = []) {
    const result = this.database.prepare(sql).run(...bound(parameters));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  /** The first column of the first row (PRAGMA user_version and the like). */
  value(sql, parameters = []) {
    const row = this.get(sql, parameters);
    return row === null ? null : Object.values(row)[0];
  }

  /** Python's Connection.rollback(): only when a transaction is open. */
  rollback() {
    if (typeof this.database.isTransaction === "boolean") {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      return;
    }
    try {
      this.database.exec("ROLLBACK");
    } catch (error) {
      if (!/no transaction is active/u.test(String(error?.message))) throw error;
    }
  }

  close() {
    this.database.close();
  }
}

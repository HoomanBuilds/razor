import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let database: DatabaseSync | undefined;
let transactionDepth = 0;
const databaseScope = new AsyncLocalStorage<{ database: DatabaseSync; transactionDepth: number }>();

export function withDatabase<T>(connection: DatabaseSync, action: () => T): T {
  return databaseScope.run({ database: connection, transactionDepth: 0 }, action);
}

export function createMemoryDatabase(): DatabaseSync {
  const connection = openDatabase(":memory:");
  connection.exec("PRAGMA max_page_count=4096; PRAGMA cache_size=-1024");
  return connection;
}
const startupWait = new Int32Array(new SharedArrayBuffer(4));

function initializeWithRetry(action: () => void, deadline: number) {
  for (;;) {
    try { action(); return; }
    catch (error) {
      const sqlite = error as { code?: string; errcode?: number }, remaining = deadline - Date.now();
      if (sqlite.code !== "ERR_SQLITE_ERROR" || typeof sqlite.errcode !== "number" || ![5, 6].includes(sqlite.errcode & 255) || remaining <= 0) throw error;
      Atomics.wait(startupWait, 0, 0, Math.min(25, remaining));
    }
  }
}

export function getDb(): DatabaseSync {
  const scoped = databaseScope.getStore();
  if (scoped) return scoped.database;
  if (process.env.RAZOR_DATABASE_SCOPE_REQUIRED === "1") throw new Error("An isolated database scope is required");
  if (!database) database = openDatabase(process.env.DATABASE_PATH ?? resolve(".data/razor.sqlite"));
  return database;
}

function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const descriptor = openSync(file, "a", 0o600);
    try { fchmodSync(descriptor, 0o600); }
    finally { closeSync(descriptor); }
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      try { chmodSync(sidecar, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  const connection = new DatabaseSync(file);
  try {
    const deadline = Date.now() + 5000;
    connection.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 100;");
    initializeWithRetry(() => connection.exec("PRAGMA journal_mode = WAL"), deadline);
    const migrations = resolve("db/migrations");
    mkdirSync(migrations, { recursive: true });
    const names = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort();
    initializeWithRetry(() => {
      connection.exec("BEGIN IMMEDIATE");
      try {
        connection.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
        for (const name of names) {
          if (connection.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(name)) continue;
          connection.exec(readFileSync(join(migrations, name), "utf8"));
          connection.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
        }
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    }, deadline);
    connection.exec("PRAGMA busy_timeout = 5000");
  } catch (error) { connection.close(); throw error; }
  return connection;
}

export function transaction<T>(action: (db: DatabaseSync) => T): T {
  const db = getDb();
  const scope = databaseScope.getStore();
  const depth = scope?.transactionDepth ?? transactionDepth;
  const savepoint = `razor_transaction_${depth}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  if (scope) scope.transactionDepth = depth + 1;
  else transactionDepth = depth + 1;
  try {
    const result = action(db);
    if (result instanceof Promise) throw new Error("Database transactions must not contain asynchronous work");
    db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
    if (depth) db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  } finally {
    if (scope) scope.transactionDepth = depth;
    else transactionDepth = depth;
  }
}

export function rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function row<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

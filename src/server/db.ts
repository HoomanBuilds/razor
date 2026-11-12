import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let database: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (database) return database;
  const file = process.env.DATABASE_PATH ?? resolve(".data/float.sqlite");
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const connection = new DatabaseSync(file);
  connection.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  connection.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const migrations = resolve("db/migrations");
  mkdirSync(migrations, { recursive: true });
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    if (connection.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(name)) continue;
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(readFileSync(join(migrations, name), "utf8"));
      connection.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      connection.close();
      throw error;
    }
  }
  database = connection;
  return connection;
}

export function transaction<T>(action: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action(db);
    if (result instanceof Promise) throw new Error("Database transactions must not contain asynchronous work");
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function row<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

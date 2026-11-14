import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, transaction } from "../src/server/db";

process.env.DATABASE_PATH = ":memory:";
const moduleUrl = new URL("../src/server/db.ts", import.meta.url).href;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "razor-db-concurrency-")), file = join(directory, "company.sqlite");
  mkdirSync(join(directory, "db/migrations"), { recursive: true });
  writeFileSync(join(directory, "db/migrations/001-once.sql"), "CREATE TABLE migrated_once(value TEXT PRIMARY KEY); INSERT INTO migrated_once VALUES ('preserved'); CREATE TABLE writers(id TEXT PRIMARY KEY);");
  return { directory, file };
}
function child(source: string, directory: string, file: string, id = "writer") {
  const processChild = spawn(process.execPath, ["--max-old-space-size=192", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: file, RAZOR_DB_TEST_DIRECTORY: directory, RAZOR_DB_TEST_WRITER: id }, stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
  let output = "", errors = "";
  processChild.stdout.on("data", data => { output += data; }); processChild.stderr.on("data", data => { errors += data; });
  const completed = new Promise<{ code: number | null; output: string; errors: string }>((resolve, reject) => { processChild.on("error", reject); processChild.on("close", code => resolve({ code, output, errors })); });
  function waitFor(marker: string) {
    return new Promise<void>((resolve, reject) => {
      const check = () => { if (output.includes(marker)) { processChild.stdout.off("data", check); resolve(); } };
      processChild.stdout.on("data", check); check();
      void completed.then(result => { if (!result.output.includes(marker)) reject(new Error(`Child missed ${marker}: ${result.output} ${result.errors}`)); }, reject);
    });
  }
  return { processChild, completed, waitFor };
}
const prelude = `import { DatabaseSync } from 'node:sqlite'; import { getDb, transaction } from ${JSON.stringify(moduleUrl)}; process.chdir(process.env.RAZOR_DB_TEST_DIRECTORY);`;

test("a rejected real BEGIN does not poison transaction nesting or replay a business callback", () => {
  const db = getDb(), original = db.exec, statements: string[] = []; let calls = 0;
  db.exec = (sql: string) => { statements.push(sql); return original.call(db, sql); };
  try {
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => transaction(() => { calls++; }), /cannot start a transaction/);
    assert.equal(calls, 0); db.exec("ROLLBACK"); statements.length = 0;
    assert.throws(() => transaction(() => { calls++; throw new Error("Business rejection"); }), /Business rejection/);
    assert.equal(statements[0], "BEGIN IMMEDIATE"); assert.equal(calls, 1);
    statements.length = 0;
    assert.equal(transaction(() => transaction(() => { calls++; return "saved"; })), "saved");
    assert.equal(statements[0], "BEGIN IMMEDIATE"); assert.ok(statements.includes("SAVEPOINT razor_transaction_1")); assert.equal(calls, 2);
  } finally { db.exec = original; }
});

test("DELETE-to-WAL initialization retries an actual SQLite lock without resetting existing data", { timeout: 15000 }, async () => {
  const f = fixture(), reader = new DatabaseSync(f.file);
  reader.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('existing'); BEGIN; SELECT * FROM retained");
  const script = `${prelude}
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) { try { return original.call(this, sql); } catch(error) { if(sql.includes('journal_mode') && [5,6].includes(error.errcode & 255)) process.stdout.write('wal-busy\\n'); throw error; } };
    try { const db=getDb(); process.stdout.write(JSON.stringify({mode:db.prepare('PRAGMA journal_mode').get().journal_mode,value:db.prepare('SELECT value FROM retained').get().value})+'\\n'); db.close(); } catch(error) { process.stderr.write(JSON.stringify({code:error.code,errcode:error.errcode,message:error.message})); process.exitCode=1; }
  `;
  const worker = child(script, f.directory, f.file);
  try {
    await worker.waitFor("wal-busy"); reader.exec("COMMIT");
    const result = await worker.completed; assert.equal(result.code, 0, result.errors);
    assert.ok(result.output.includes('"mode":"wal"')); assert.ok(result.output.includes('"value":"existing"'));
  } finally { worker.processChild.kill(); reader.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("two actual processes recheck migration history only after acquiring their shared write lock", { timeout: 15000 }, async () => {
  const f = fixture(), seed = new DatabaseSync(f.file);
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)"); seed.close();
  const script = `${prelude}
    const {readSync}=await import('node:fs'), original=DatabaseSync.prototype.exec; let paused=false;
    DatabaseSync.prototype.exec=function(sql) { if(sql==='BEGIN IMMEDIATE' && !paused) { paused=true; process.stdout.write('begin-ready\\n'); readSync(0,Buffer.alloc(1),0,1,null); } return original.call(this,sql); };
    try { const db=getDb(); transaction(connection=>connection.prepare('INSERT INTO writers VALUES (?)').run(process.env.RAZOR_DB_TEST_WRITER)); process.stdout.write('initialized\\n'); db.close(); } catch(error) { process.stderr.write(JSON.stringify({code:error.code,errcode:error.errcode,message:error.message})); process.exitCode=1; }
  `;
  const writers = [child(script, f.directory, f.file, "first"), child(script, f.directory, f.file, "second")];
  try {
    await Promise.all(writers.map(writer => writer.waitFor("begin-ready")));
    for (const writer of writers) writer.processChild.stdin.end("x");
    for (const writer of writers) { const result = await writer.completed; assert.equal(result.code, 0, result.errors); assert.ok(result.output.includes("initialized")); }
    const verified = new DatabaseSync(f.file);
    try {
      assert.equal(verified.prepare("SELECT COUNT(*) n FROM schema_migrations").get()!.n, 1);
      assert.equal(verified.prepare("SELECT COUNT(*) n FROM migrated_once WHERE value='preserved'").get()!.n, 1);
      assert.equal(verified.prepare("SELECT COUNT(*) n FROM writers").get()!.n, 2);
    } finally { verified.close(); }
  } finally { for (const writer of writers) writer.processChild.kill(); rmSync(f.directory, { recursive: true, force: true }); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const legacy of [false, true]) {
  test(`${legacy ? "existing" : "new"} SQLite data and WAL files stay private under a permissive umask`, { skip: process.platform === "win32" }, () => {
    const directory = mkdtempSync(join(tmpdir(), "razor-database-"));
    const file = join(directory, "private", "company.sqlite");
    const script = `
      import { chmodSync, mkdirSync, statSync } from "node:fs";
      import { dirname } from "node:path";
      import { DatabaseSync } from "node:sqlite";
      import { getDb } from ${JSON.stringify(new URL("../src/server/db.ts", import.meta.url).href)};
      process.umask(0o022);
      const file = process.env.DATABASE_PATH;
      let existing;
      if (${legacy}) {
        mkdirSync(dirname(file), { recursive: true });
        existing = new DatabaseSync(file);
        existing.exec("PRAGMA journal_mode=WAL; CREATE TABLE legacy_record(value TEXT); INSERT INTO legacy_record VALUES ('preserved')");
        for (const path of [file, file + "-wal", file + "-shm"]) chmodSync(path, 0o666);
      }
      const database = getDb();
      const modes = [file, file + "-wal", file + "-shm"].map(path => statSync(path).mode & 0o777);
      const value = ${legacy} ? database.prepare("SELECT value FROM legacy_record").get().value : null;
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='sessions'").all();
      console.log(JSON.stringify({ modes, value, migrated: tables.length === 1, directoryMode: statSync(dirname(file)).mode & 0o777 }));
      database.close();
      existing?.close();
    `;
    try {
      const result = spawnSync(process.execPath, ["--max-old-space-size=192", "--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: file }, encoding: "utf8", timeout: 20_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout.trim());
      assert.deepEqual(output.modes, [0o600, 0o600, 0o600]);
      assert.equal(output.migrated, true);
      if (legacy) assert.equal(output.value, "preserved");
      else assert.equal(output.directoryMode, 0o700);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { billingIssuer } from "../src/server/billing/chain";

test("operator issuer generation writes a private new file and never prints its secret", () => {
  const directory = mkdtempSync(join(tmpdir(), "razor-billing-admin-")), path = join(directory, "issuer.env");
  const args = ["--max-old-space-size=256", "--import", "tsx", "scripts/billing-admin.ts", "issuer-key", "--output", path];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, DATABASE_PATH: join(directory, "billing.sqlite") } });
    const content = readFileSync(path, "utf8"), secret = content.trim().split("=")[1];
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert(!stdout.includes(secret));
    assert.equal(JSON.parse(stdout).publicKey, billingIssuer({ ...process.env, RAZOR_BILLING_ISSUER_PRIVATE_KEY: secret }).publicKey);
    assert.notEqual(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
    assert.equal(readFileSync(path, "utf8"), content);
    const refusal = spawnSync(process.execPath, ["--import", "tsx", "scripts/billing-admin.ts", "prepare-refund", "--id", "not-a-real-refund"], { encoding: "utf8" });
    assert.notEqual(refusal.status, 0); assert.match(refusal.stderr, /--apply/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

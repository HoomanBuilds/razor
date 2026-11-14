import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function moduleBytes(payload: Uint8Array) {
  const name = Buffer.from("fixture"), section = Buffer.concat([Buffer.from([name.length]), name, payload]);
  assert(section.length < 128);
  return Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, section.length]), section]);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "razor-artifact-manifest-"));
  const treasury = moduleBytes(Buffer.from("distinct treasury fixture"));
  const files = { "razor_treasury.wasm": treasury, "razor_clearing.wasm": moduleBytes(Buffer.from("clearing")), "razor_billing.wasm": moduleBytes(Buffer.from("billing")) };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
  const args = ["--max-old-space-size=192", "scripts/contract-manifest.mjs", directory];
  return { directory, files, args };
}

test("shared artifact publication validates modules and records exact hashes without a factory", () => {
  const { directory, files, args } = fixture();
  try {
    execFileSync(process.execPath, args, { env: { ...process.env, WASM_OPT_BUILD_VERSION: "optimizer fixture" }, stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.optimizer, "optimizer fixture"); assert.equal(manifest.artifacts.length, 3); assert.equal(manifest.architecture,"shared_v1");
    assert.equal(manifest.treasuryStateVersion, 3); assert.equal(manifest.clearingStateVersion, 2);
    for (const [name, bytes] of Object.entries(files)) {
      const item = manifest.artifacts.find((entry: { file: string }) => entry.file === name);
      assert.equal(item.bytes, bytes.length);
      assert.equal(item.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid shared modules cannot replace the published manifest", () => {
  const { directory, files, args } = fixture();
  try {
    execFileSync(process.execPath, args, { stdio: "pipe" });
    const original = readFileSync(join(directory, "manifest.json"), "utf8");
    writeFileSync(join(directory, "razor_billing.wasm"), Buffer.from("invalid"));
    const invalid = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Invalid WebAssembly/);
    assert.equal(readFileSync(join(directory, "manifest.json"), "utf8"), original);
    writeFileSync(join(directory, "razor_billing.wasm"), files["razor_billing.wasm"]);
    writeFileSync(join(directory, "razor_treasury.wasm"), Buffer.from("invalid treasury"));
    const changed = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(changed.status, 0); assert.match(changed.stderr, /Invalid WebAssembly/);
    assert.equal(readFileSync(join(directory, "manifest.json"), "utf8"), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

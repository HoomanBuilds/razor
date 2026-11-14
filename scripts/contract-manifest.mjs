import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { base58 } from "@scure/base";

const directory = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL("../.tools/wasm/", import.meta.url);
const artifacts = [
  ["razor_treasury.wasm", "NEAR_TREASURY_CODE_HASH"],
  ["razor_clearing.wasm", "NEAR_CLEARING_CODE_HASH"],
  ["razor_billing.wasm", "RAZOR_BILLING_CODE_HASH"],
  ...(existsSync(new URL("razor_credit.wasm", directory)) ? [["razor_credit.wasm", "NEAR_CREDIT_CODE_HASH"]] : []),
].map(([file, environmentKey]) => {
  const bytes = readFileSync(new URL(file, directory));
  if (!WebAssembly.validate(bytes)) throw new Error(`Invalid WebAssembly artifact: ${file}`);
  const digest = createHash("sha256").update(bytes).digest();
  return { file, bytes: bytes.length, sha256: digest.toString("hex"), codeHash: base58.encode(digest), environmentKey };
});
writeFileSync(new URL("manifest.json", directory), `${JSON.stringify({ architecture: "shared_v1", treasuryStateVersion: 3, clearingStateVersion: 2, ...(artifacts.some(artifact => artifact.file === "razor_credit.wasm") ? { creditStateVersion: 1 } : {}), generatedAt: new Date().toISOString(), optimizer: process.env.WASM_OPT_BUILD_VERSION ?? null, optimization: { rustOptLevel: process.env.CARGO_PROFILE_RELEASE_OPT_LEVEL ?? "z", passes: process.env.WASM_OPT_BUILD_PASSES ?? null }, artifacts }, null, 2)}\n`);
for (const artifact of artifacts) process.stdout.write(`${artifact.environmentKey}=${artifact.codeHash}\n`);
process.stdout.write(`Build metadata saved in ${fileURLToPath(new URL("manifest.json", directory))}\n`);

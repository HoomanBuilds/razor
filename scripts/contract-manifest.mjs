import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { base58 } from "@scure/base";

const directory = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL("../.tools/wasm/", import.meta.url);
const artifacts = [
  ["razor_treasury.wasm", "NEAR_TREASURY_CODE_HASH"],
  ["razor_factory.wasm", "NEAR_FACTORY_CODE_HASH"],
  ["razor_clearing.wasm", "NEAR_CLEARING_CODE_HASH"],
  ["razor_billing.wasm", "RAZOR_BILLING_CODE_HASH"],
].map(([file, environmentKey]) => {
  const bytes = readFileSync(new URL(file, directory));
  if (!WebAssembly.validate(bytes)) throw new Error(`Invalid WebAssembly artifact: ${file}`);
  const digest = createHash("sha256").update(bytes).digest();
  return { file, bytes: bytes.length, sha256: digest.toString("hex"), codeHash: base58.encode(digest), environmentKey };
});
const treasury = readFileSync(new URL("razor_treasury.wasm", directory));
if (!readFileSync(new URL("razor_factory.wasm", directory)).includes(treasury)) throw new Error("The factory must embed the exact optimized treasury artifact");
writeFileSync(new URL("manifest.json", directory), `${JSON.stringify({ generatedAt: new Date().toISOString(), optimizer: process.env.WASM_OPT_BUILD_VERSION ?? null, artifacts }, null, 2)}\n`);
for (const artifact of artifacts) process.stdout.write(`${artifact.environmentKey}=${artifact.codeHash}\n`);
process.stdout.write(`Build metadata saved in ${fileURLToPath(new URL("manifest.json", directory))}\n`);

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";

const directory = new URL("../.tools/wasm/", import.meta.url);
const artifacts = [
  ["razor_treasury.wasm", "NEAR_TREASURY_CODE_HASH"],
  ["razor_factory.wasm", "NEAR_FACTORY_CODE_HASH"],
  ["razor_clearing.wasm", "NEAR_CLEARING_CODE_HASH"],
  ["razor_billing.wasm", "RAZOR_BILLING_CODE_HASH"],
].map(([file, environmentKey]) => {
  const bytes = readFileSync(new URL(file, directory));
  const digest = createHash("sha256").update(bytes).digest();
  return { file, bytes: bytes.length, sha256: digest.toString("hex"), codeHash: base58.encode(digest), environmentKey };
});
writeFileSync(new URL("manifest.json", directory), `${JSON.stringify({ generatedAt: new Date().toISOString(), artifacts }, null, 2)}\n`);
for (const artifact of artifacts) process.stdout.write(`${artifact.environmentKey}=${artifact.codeHash}\n`);
process.stdout.write(`Build metadata saved in ${fileURLToPath(new URL("manifest.json", directory))}\n`);

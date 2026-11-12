import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base58 } from "@scure/base";
import { ApiError } from "./context";

export function reviewedArtifactHash(envName: string, fileName: string): string {
  const configured = process.env[envName];
  if (configured) {
    try { if (base58.decode(configured).length === 32) return configured; } catch {}
    throw new ApiError(503, `${envName} must contain the base58 SHA-256 hash of a reviewed contract`, "CONTRACT_PIN_SETUP_REQUIRED");
  }
  try { return base58.encode(createHash("sha256").update(readFileSync(resolve(".tools/wasm", fileName))).digest()); }
  catch { throw new ApiError(503, `Build the reviewed contracts or configure ${envName}`, "CONTRACT_PIN_SETUP_REQUIRED"); }
}

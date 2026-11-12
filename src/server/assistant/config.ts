import { ApiError } from "../context";

const BASE_URL = "https://cloud-api.near.ai/v1";

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new ApiError(503, `${name} must be an integer from ${minimum} to ${maximum}`, "PRIVATE_AI_SETUP_REQUIRED");
  return Number(value);
}

function hashes(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((hash) => hash.trim().toLowerCase()).filter(Boolean);
}

export function supportedRuntime(version = process.versions.node): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 24 || major === 24 && (minor > 22 || minor === 22 && patch >= 1);
}

export function privateAiConfig() {
  const model = process.env.NEAR_AI_MODEL?.trim() ?? "";
  const apiKey = process.env.NEAR_AI_API_KEY?.trim() ?? "";
  const modelHashes = hashes("NEAR_AI_MODEL_COMPOSE_SHA256");
  const gatewayHashes = hashes("NEAR_AI_GATEWAY_COMPOSE_SHA256");
  const retentionDays = integerSetting("NEAR_AI_RETENTION_DAYS", 7, 0, 30);
  const maxAttestationAgeMs = integerSetting("NEAR_AI_MAX_ATTESTATION_AGE_MS", 120_000, 10_000, 300_000);
  const missing: string[] = [];
  if (!apiKey) missing.push("NEAR_AI_API_KEY");
  if (!model) missing.push("NEAR_AI_MODEL");
  if (!modelHashes.length || modelHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) missing.push("NEAR_AI_MODEL_COMPOSE_SHA256");
  if (!gatewayHashes.length || gatewayHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) missing.push("NEAR_AI_GATEWAY_COMPOSE_SHA256");
  if (!supportedRuntime()) missing.push("Node.js >=24.22.1");
  if (retentionDays && process.env.NODE_ENV === "production" && !process.env.DATA_ENCRYPTION_KEY) missing.push("DATA_ENCRYPTION_KEY");
  return { baseUrl: BASE_URL, model, apiKey, modelHashes, gatewayHashes, retentionDays, maxAttestationAgeMs, missing };
}

export function getAssistantConfig() {
  const config = privateAiConfig();
  return { ready: config.missing.length === 0, provider: "NEAR AI Cloud", model: config.model || null, missing: config.missing, retentionDays: config.retentionDays, requiredVerification: true, fieldEncryption: true, minimumNodeVersion: "24.22.1" };
}

export function requirePrivateAiConfig() {
  const config = privateAiConfig();
  if (config.missing.length) throw new ApiError(503, `Private invoice analysis requires: ${config.missing.join(", ")}`, "PRIVATE_AI_SETUP_REQUIRED");
  return config;
}

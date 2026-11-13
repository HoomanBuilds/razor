import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { NATIVE_USDC } from "../src/lib/native-usdc";
import { privateAiConfig } from "../src/server/assistant/config";
import { setupPreflight } from "../src/server/setup/preflight";

const hashes = { treasury: base58.encode(new Uint8Array(32).fill(1)), factory: base58.encode(new Uint8Array(32).fill(2)), clearing: base58.encode(new Uint8Array(32).fill(3)) };
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_URL: "https://razor.example", DATABASE_PATH: ".data/razor.sqlite", DATA_ENCRYPTION_KEY: "af".repeat(32),
  PRIVY_APP_ID: "app-one", NEXT_PUBLIC_PRIVY_APP_ID: "app-one", PRIVY_JWKS_URL: "https://auth.example/jwks.json", PRIVY_APP_SECRET: "private-profile-secret",
  NEAR_NETWORK: "mainnet", NEAR_FACTORY_ID: "factory.near", NEAR_CLEARING_ID: "clearing.near",
  NEAR_FACTORY_CODE_HASH: hashes.factory, NEAR_TREASURY_CODE_HASH: hashes.treasury, NEAR_CLEARING_CODE_HASH: hashes.clearing,
  NEAR_AI_API_KEY: "private-inference-secret", NEAR_AI_MODEL: "private-model", NEAR_AI_MODEL_COMPOSE_SHA256: "12".repeat(32), NEAR_AI_GATEWAY_COMPOSE_SHA256: "34".repeat(32),
  RAZOR_EXECUTOR_ACCOUNT_ID: "executor.near", RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID: "company.factory.near", RAZOR_EXECUTOR_NETWORK: "mainnet", RAZOR_EXECUTOR_PRIVATE_KEY: `ed25519:${base58.encode(new Uint8Array(64).fill(9))}`,
};
const absentArtifacts = join(tmpdir(), "razor-absent-preflight-artifacts");
const status = (report: Awaited<ReturnType<typeof setupPreflight>>, id: string) => report.checks.find(check => check.id === id)?.status;

function transport(options: { network?: string; factoryCode?: string; uninitialized?: boolean; permission?: unknown } = {}): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(init!.body as string), params = request.params;
    let result: unknown;
    if (request.method === "status") result = { chain_id: options.network || "mainnet" };
    else if (params.request_type === "view_account") result = { code_hash: params.account_id === env.NEAR_FACTORY_ID ? options.factoryCode || hashes.factory : params.account_id === env.NEAR_CLEARING_ID ? hashes.clearing : hashes.treasury };
    else if (params.request_type === "view_access_key") result = { permission: options.permission ?? { FunctionCall: { receiver_id: env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID, method_names: ["execute_payment"], allowance: "1000" } } };
    else if (params.method_name === "get_config") {
      if (options.uninitialized) return Response.json({ error: { message: "RPC error contains private-inference-secret" } });
      const value = params.account_id === env.NEAR_FACTORY_ID
        ? { owner_id: "admin.near", token_contract: NATIVE_USDC.near, treasury_wasm_hash: hashes.treasury, paused: false, minimum_deposit: "300", treasury_funding: "200", factory_storage_fee: "100" }
        : params.account_id === env.NEAR_CLEARING_ID
          ? { factory_id: env.NEAR_FACTORY_ID, token_contract: NATIVE_USDC.near, paused: false }
          : { owner_id: "owner.near", token_contract: NATIVE_USDC.near, paused: false, executors: [env.RAZOR_EXECUTOR_ACCOUNT_ID], approvers: [] };
      result = { result: [...Buffer.from(JSON.stringify(value))] };
    } else throw new Error("Unexpected read-only request");
    return Response.json({ result });
  };
}

test("local preflight does not call providers, create a database or expose secret values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "razor-preflight-"));
  try {
    let calls = 0;
    const report = await setupPreflight({ env: { ...env, DATABASE_PATH: join(directory, "private.sqlite") }, artifactDirectory: directory, nodeVersion: "24.22.1", fetch: async () => { calls++; throw new Error(); } });
    assert.equal(report.configurationReady, true); assert.equal(report.liveWorkflowsVerified, false); assert.equal(report.remoteChecksRequested, false);
    assert.equal(calls, 0); assert.deepEqual(readdirSync(directory), []);
    const output = JSON.stringify(report);
    for (const secret of [env.DATA_ENCRYPTION_KEY, env.PRIVY_APP_SECRET, env.NEAR_AI_API_KEY, env.RAZOR_EXECUTOR_PRIVATE_KEY]) assert(!output.includes(secret!));
    assert.equal(status(report, "email"), "disabled"); assert.equal(status(report, "social-journey"), "not_checked");
  } finally { rmSync(directory, { recursive: true }); }
});

test("incomplete or invalid capability groups remain blocked instead of claiming readiness", async () => {
  const report = await setupPreflight({ env: { ...env, NEXT_PUBLIC_PRIVY_APP_ID: "another-app", PRIVY_APP_SECRET: "", NEAR_NETWORK: "testnet", RAZOR_EXECUTOR_NETWORK: "mainnet", DATA_ENCRYPTION_KEY: "bad", RESEND_API_KEY: "private-mail-secret", NEAR_AI_RETENTION_DAYS: "31" }, artifactDirectory: absentArtifacts, nodeVersion: "22.0.0" });
  for (const id of ["runtime", "social-login", "social-profile", "intents-network", "executor", "encryption", "email", "private-ai"]) assert.equal(status(report, id), "blocked", id);
  assert.equal(report.configurationReady, false); assert(!JSON.stringify(report).includes("private-mail-secret"));
});

test("private inference configuration uses the same supplied environment validation as runtime", () => {
  assert.deepEqual(privateAiConfig(env, "24.22.1").missing, []);
  assert(privateAiConfig({ ...env, NEAR_AI_GATEWAY_COMPOSE_SHA256: "invalid" }, "24.22.1").missing.includes("NEAR_AI_GATEWAY_COMPOSE_SHA256"));
  assert.throws(() => privateAiConfig({ ...env, NEAR_AI_MAX_ATTESTATION_AGE_MS: "9999" }, "24.22.1"));
});

test("configured contract pins cannot silently disagree with local artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "razor-preflight-artifacts-"));
  try {
    const bytes = Buffer.from("reviewed-fixture"); writeFileSync(join(directory, "razor_treasury.wasm"), bytes);
    let report = await setupPreflight({ env, artifactDirectory: directory });
    assert.equal(status(report, "treasury-artifact"), "blocked");
    report = await setupPreflight({ env: { ...env, NEAR_TREASURY_CODE_HASH: base58.encode(createHash("sha256").update(bytes).digest()) }, artifactDirectory: directory });
    assert.equal(status(report, "treasury-artifact"), "pass");
  } finally { rmSync(directory, { recursive: true }); }
});

test("remote preflight refuses another network before checking deployed accounts", async () => {
  const report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({ network: "testnet" }) });
  assert.equal(status(report, "remote-network"), "blocked"); assert.equal(status(report, "remote-factory"), undefined);
});

test("remote contract checks reject different code and uninitialized contract state without leaking errors", async () => {
  let report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({ factoryCode: hashes.treasury }) });
  assert.equal(status(report, "remote-factory"), "blocked"); assert.equal(status(report, "remote-clearing"), "not_checked");
  report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({ uninitialized: true }) });
  assert.equal(status(report, "remote-factory"), "blocked"); assert(!JSON.stringify(report).includes("private-inference-secret"));
});

test("remote success establishes deployment and restricted key state, never completed payment workflows", async () => {
  const report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport() });
  for (const id of ["remote-network", "remote-factory", "remote-clearing", "remote-executor"]) assert.equal(status(report, id), "pass", id);
  assert.equal(report.liveWorkflowsVerified, false); assert.equal(status(report, "settlement-journey"), "not_checked");
});

test("an unrestricted executor key is rejected without signing or broadcasting", async () => {
  const report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({ permission: "FullAccess" }) });
  assert.equal(status(report, "remote-executor"), "blocked");
});

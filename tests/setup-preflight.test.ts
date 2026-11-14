import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NATIVE_USDC } from "../src/lib/native-usdc";
import { privateAiConfig } from "../src/server/assistant/config";
import { setupPreflight } from "../src/server/setup/preflight";

const hashes = { treasury: base58.encode(new Uint8Array(32).fill(1)), factory: base58.encode(new Uint8Array(32).fill(2)), clearing: base58.encode(new Uint8Array(32).fill(3)) };
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_URL: "https://razor.example", DATABASE_PATH: ".data/razor.sqlite", DATA_ENCRYPTION_KEY: "af".repeat(32),
  PRIVY_APP_ID: "app-one", NEXT_PUBLIC_PRIVY_APP_ID: "app-one", PRIVY_JWKS_URL: "https://auth.example/jwks.json", PRIVY_APP_SECRET: "private-profile-secret",
  NEAR_NETWORK: "mainnet", NEAR_TREASURY_ID: "treasury.near", NEAR_CLEARING_ID: "clearing.near",
  NEAR_TREASURY_CODE_HASH: hashes.treasury, NEAR_CLEARING_CODE_HASH: hashes.clearing,
  NEAR_AI_API_KEY: "private-inference-secret", NEAR_AI_MODEL: "private-model", NEAR_AI_MODEL_COMPOSE_SHA256: "12".repeat(32), NEAR_AI_GATEWAY_COMPOSE_SHA256: "34".repeat(32),
  RAZOR_EXECUTOR_ACCOUNT_ID: "executor.near", RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID: "treasury.near", RAZOR_EXECUTOR_COMPANY_ID: "company-one:aaaaaaaaaaaaaaaa", RAZOR_EXECUTOR_NETWORK: "mainnet", RAZOR_EXECUTOR_PRIVATE_KEY: `ed25519:${base58.encode(new Uint8Array(64).fill(9))}`,
};
const absentArtifacts = join(tmpdir(), "razor-absent-preflight-artifacts");
const finalizedBlock = {hash:base58.encode(new Uint8Array(32).fill(5)), height:1234};
const blockResult = {block_hash:finalizedBlock.hash, block_height:finalizedBlock.height};
const upgradeKey = (value: number) => `ed25519:${base58.encode(new Uint8Array(32).fill(value))}`;
const fullAccess = (publicKey: string) => ({public_key:publicKey, access_key:{permission:"FullAccess"}});
function ownerControlledEnvironment(configured: NodeJS.ProcessEnv = env): NodeJS.ProcessEnv {
  const accounts = [configured.NEAR_TREASURY_ID, configured.NEAR_CLEARING_ID, configured.RAZOR_BILLING_CONTRACT_ID].filter((account): account is string => Boolean(account));
  return {...configured, NEAR_CONTRACT_UPGRADE_POLICY:"owner_controlled", NEAR_CONTRACT_UPGRADE_KEYS:JSON.stringify(Object.fromEntries(accounts.map((account, index) => [account, [upgradeKey(index + 10)]])))};
}
const status = (report: Awaited<ReturnType<typeof setupPreflight>>, id: string) => report.checks.find(check => check.id === id)?.status;

function billingEnvironment(): NodeJS.ProcessEnv {
  const seed = new Uint8Array(32).fill(8), publicKey = ed25519.getPublicKey(seed);
  return { ...env, RAZOR_BILLING_MODE: "enforced", RAZOR_BILLING_CONTRACT_ID: "billing.near", RAZOR_BILLING_CODE_HASH: base58.encode(new Uint8Array(32).fill(4)), RAZOR_BILLING_ISSUER_PRIVATE_KEY: `ed25519:${base58.encode(new Uint8Array([...seed, ...publicKey]))}` };
}

test("billing setup validates its isolated contract, actual issuer and local artifact without exposing secrets", async () => {
  const configured = billingEnvironment(), directory = mkdtempSync(join(tmpdir(), "razor-billing-preflight-"));
  try {
    const valid = await setupPreflight({ env: configured, artifactDirectory: directory });
    assert.equal(status(valid, "billing-checkout"), "pass");
    assert(!JSON.stringify(valid).includes(configured.RAZOR_BILLING_ISSUER_PRIVATE_KEY!));
    const reused = await setupPreflight({ env: { ...configured, RAZOR_BILLING_CONTRACT_ID: configured.NEAR_TREASURY_ID }, artifactDirectory: directory });
    assert.equal(status(reused, "billing-checkout"), "blocked");
    const invalid = await setupPreflight({ env: { ...configured, RAZOR_BILLING_ISSUER_PRIVATE_KEY: `ed25519:${base58.encode(new Uint8Array(64).fill(8))}` }, artifactDirectory: directory });
    assert.equal(status(invalid, "billing-checkout"), "blocked");
    writeFileSync(join(directory, "razor_billing.wasm"), new Uint8Array([1, 2, 3]));
    assert.equal(status(await setupPreflight({ env: configured, artifactDirectory: directory }), "billing-checkout"), "blocked");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("remote billing setup binds code, token, issuer and storage to one final block without claiming collection", async () => {
  const configured = billingEnvironment(), seed = new Uint8Array(32).fill(8), issuer = `ed25519:${base58.encode(ed25519.getPublicKey(seed))}`;
  let paused = false, billingReads = 0;
  const fallback = transport();
  const remote: typeof fetch = async (url, init) => {
    const request = JSON.parse(init!.body as string), params = request.params;
    if (request.method === "block") return Response.json({ result: { header: finalizedBlock } });
    const billingStorage = params.account_id === NATIVE_USDC.near && params.method_name === "storage_balance_of" && JSON.parse(Buffer.from(params.args_base64, "base64").toString()).account_id === configured.RAZOR_BILLING_CONTRACT_ID;
    if (params.account_id === configured.RAZOR_BILLING_CONTRACT_ID || billingStorage) {
      assert.equal(params.block_id, finalizedBlock.hash); billingReads++;
      if (params.request_type === "view_account") return Response.json({ result: { ...blockResult, code_hash: configured.RAZOR_BILLING_CODE_HASH } });
      if (params.request_type === "view_access_key_list") return Response.json({ result: { ...blockResult, keys:[] } });
      const value = params.method_name === "storage_balance_of" ? { total: "1000" } : { version: 1, owner_id: "operator.near", network: "mainnet", token_contract: NATIVE_USDC.near, issuer_public_key: issuer, paused };
      return Response.json({ result: { ...blockResult, result: [...Buffer.from(JSON.stringify(value))] } });
    }
    return fallback(url, init);
  };
  const verified = await setupPreflight({ env: configured, artifactDirectory: absentArtifacts, remote: true, fetch: remote });
  assert.equal(status(verified, "remote-billing"), "pass"); assert.equal(billingReads, 4); assert.equal(verified.liveWorkflowsVerified, false);
  paused = true;
  assert.equal(status(await setupPreflight({ env: configured, artifactDirectory: absentArtifacts, remote: true, fetch: remote }), "remote-billing"), "blocked");
});

function transport(options: { network?: string; treasuryCode?: string; uninitialized?: boolean; permission?: unknown; treasuryKeys?: unknown[]; keysByAccount?: Record<string, unknown[]>; responseBlockHash?: string; globalContract?: string } = {}): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(init!.body as string), params = request.params;
    let result: unknown;
    if (request.method === "status") result = { chain_id: options.network || "mainnet" };
    else if (request.method === "block") result = {header:finalizedBlock};
    else if (params.request_type === "view_account") result = { code_hash: params.account_id === env.NEAR_TREASURY_ID ? options.treasuryCode || hashes.treasury : params.account_id === env.NEAR_CLEARING_ID ? hashes.clearing : hashes.treasury, global_contract_account_id:options.globalContract };
    else if (params.request_type === "view_access_key_list") result = {keys:options.keysByAccount?.[params.account_id] ?? (params.account_id === env.NEAR_TREASURY_ID ? options.treasuryKeys ?? [] : [])};
    else if (params.request_type === "view_access_key") result = { permission: options.permission ?? { FunctionCall: { receiver_id: env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID, method_names: ["execute_payment"], allowance: "1000" } } };
    else if (params.method_name === "get_config" || params.method_name === "get_platform_config" || params.method_name === "storage_balance_of") {
      if (options.uninitialized) return Response.json({ error: { message: "RPC error contains private-inference-secret" } });
      const value = params.method_name === "storage_balance_of" ? {total:"1250000000000000000000"}
        : params.method_name === "get_platform_config"
          ? { architecture:"shared_v1",version:1,owner_id: "admin.near", token_contract: NATIVE_USDC.near, paused: false, minimum_registration_deposit:"81920000000000000000000" }
          : params.account_id === env.NEAR_CLEARING_ID
            ? { treasury_id: env.NEAR_TREASURY_ID, token_contract: NATIVE_USDC.near, paused: false }
            : { architecture:"shared_v1",company_id:env.RAZOR_EXECUTOR_COMPANY_ID,owner_id: "owner.near", token_contract: NATIVE_USDC.near, paused: false, executors: [env.RAZOR_EXECUTOR_ACCOUNT_ID], approvers: [] };
      result = { result: [...Buffer.from(JSON.stringify(value))] };
    } else throw new Error("Unexpected read-only request");
    if (request.method === "query") {
      assert.equal(params.block_id, finalizedBlock.hash);
      assert.equal(Object.hasOwn(params, "finality"), false);
      result = {...result as Record<string, unknown>, ...blockResult, block_hash:options.responseBlockHash || finalizedBlock.hash};
    }
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
  const report = await setupPreflight({ env: { ...env, NEXT_PUBLIC_PRIVY_APP_ID: "another-app", PRIVY_APP_SECRET: "", NEAR_NETWORK: "testnet", RAZOR_EXECUTOR_COMPANY_ID: "company-one:aaaaaaaaaaaaaaaa", RAZOR_EXECUTOR_NETWORK: "mainnet", DATA_ENCRYPTION_KEY: "bad", RESEND_API_KEY: "private-mail-secret", NEAR_AI_RETENTION_DAYS: "31" }, artifactDirectory: absentArtifacts, nodeVersion: "22.0.0" });
  for (const id of ["runtime", "social-login", "social-profile", "intents-network", "executor", "encryption", "email", "private-ai"]) assert.equal(status(report, id), "blocked", id);
  assert.equal(report.configurationReady, false); assert(!JSON.stringify(report).includes("private-mail-secret"));
});

test("unconfigured optional AI and automatic execution do not block manual company operations", async () => {
  const configured = { ...env };
  for (const key of ["RAZOR_EXECUTOR_ACCOUNT_ID", "RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID", "RAZOR_EXECUTOR_COMPANY_ID", "RAZOR_EXECUTOR_NETWORK", "RAZOR_EXECUTOR_PRIVATE_KEY", "NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_MODEL_COMPOSE_SHA256", "NEAR_AI_GATEWAY_COMPOSE_SHA256"]) delete configured[key];
  const report = await setupPreflight({ env: configured, artifactDirectory: absentArtifacts, nodeVersion: "24.22.1" });
  assert.equal(status(report, "executor"), "disabled");
  assert.equal(status(report, "private-ai"), "disabled");
  assert.equal(report.configurationReady, true);
  const partial = await setupPreflight({ env: { ...configured, RAZOR_EXECUTOR_ACCOUNT_ID: "executor.near", NEAR_AI_API_KEY: "private-inference-secret" }, artifactDirectory: absentArtifacts, nodeVersion: "24.22.1" });
  assert.equal(status(partial, "executor"), "blocked");
  assert.equal(status(partial, "private-ai"), "blocked");
  assert.equal(partial.configurationReady, false);
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
  assert.equal(status(report, "remote-network"), "blocked"); assert.equal(status(report, "remote-treasury"), undefined);
});

test("remote contract checks reject different code and uninitialized contract state without leaking errors", async () => {
  let report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({ treasuryCode: hashes.clearing }) });
  assert.equal(status(report, "remote-treasury"), "blocked"); assert.equal(status(report, "remote-clearing"), "not_checked");
  report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({ uninitialized: true }) });
  assert.equal(status(report, "remote-treasury"), "blocked"); assert(!JSON.stringify(report).includes("private-inference-secret"));
});

test("remote success establishes deployment and restricted key state, never completed payment workflows", async () => {
  const report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport() });
  for (const id of ["remote-network", "remote-treasury", "remote-clearing", "remote-executor"]) assert.equal(status(report, id), "pass", id);
  assert.equal(report.liveWorkflowsVerified, false); assert.equal(status(report, "settlement-journey"), "not_checked");
});

test("an unrestricted executor key is rejected without signing or broadcasting", async () => {
  const report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({ permission: "FullAccess" }) });
  assert.equal(status(report, "remote-executor"), "blocked");
});

test("shared treasury setup refuses a remaining deployment access key", async () => {
  const report = await setupPreflight({ env, artifactDirectory: absentArtifacts, remote: true, fetch: transport({treasuryKeys:[{public_key:"ed25519:deployment-key",access_key:{permission:"FullAccess"}}]}) });
  assert.equal(status(report,"remote-treasury"),"blocked");
  assert.equal(status(report,"remote-clearing"),"not_checked");
});


test("owner-controlled preflight requires each exact pinned contract key set from the supplied environment", async () => {
  const configured = ownerControlledEnvironment();
  const keysByAccount = {"treasury.near":[fullAccess(upgradeKey(10))], "clearing.near":[fullAccess(upgradeKey(11))]};
  const report = await setupPreflight({env:configured, artifactDirectory:absentArtifacts, remote:true, fetch:transport({keysByAccount})});
  assert.equal(status(report, "contract-upgrade-policy"), "warning");
  for (const id of ["remote-treasury", "remote-clearing", "remote-executor"]) assert.equal(status(report, id), "pass");
  const changed = await setupPreflight({env:configured, artifactDirectory:absentArtifacts, remote:true, fetch:transport({keysByAccount:{...keysByAccount,"clearing.near":[fullAccess(upgradeKey(12))]}})});
  assert.equal(status(changed, "remote-treasury"), "pass");
  assert.equal(status(changed, "remote-clearing"), "blocked");
  const absent = await setupPreflight({env:{...configured, NEAR_CONTRACT_UPGRADE_KEYS:JSON.stringify({"treasury.near":[upgradeKey(10)]})}, artifactDirectory:absentArtifacts});
  assert.equal(status(absent, "contract-upgrade-policy"), "blocked");
});

test("preflight refuses mismatched finalized responses and indirect mutable global code", async () => {
  for (const options of [{responseBlockHash:hashes.clearing}, {globalContract:"mutable-code.near"}]) {
    const report = await setupPreflight({env, artifactDirectory:absentArtifacts, remote:true, fetch:transport(options)});
    assert.equal(status(report, "remote-treasury"), "blocked");
    assert.equal(status(report, "remote-clearing"), "not_checked");
    assert.equal(status(report, "remote-executor"), "blocked");
  }
});

test("billing preflight verifies its own approved upgrade keys before accepting checkout setup", async () => {
  const configured = ownerControlledEnvironment(billingEnvironment());
  const seed = new Uint8Array(32).fill(8), issuer = `ed25519:${base58.encode(ed25519.getPublicKey(seed))}`;
  let billingKeys = [fullAccess(upgradeKey(12))];
  const fallback = transport({keysByAccount:{"treasury.near":[fullAccess(upgradeKey(10))], "clearing.near":[fullAccess(upgradeKey(11))]}});
  const remote: typeof fetch = async (url, init) => {
    const request = JSON.parse(init!.body as string), params = request.params;
    if (params.account_id !== configured.RAZOR_BILLING_CONTRACT_ID) return fallback(url, init);
    assert.equal(params.block_id, finalizedBlock.hash);
    const result = params.request_type === "view_account" ? {code_hash:configured.RAZOR_BILLING_CODE_HASH}
      : params.request_type === "view_access_key_list" ? {keys:billingKeys}
      : {result:[...Buffer.from(JSON.stringify({version:1, owner_id:"operator.near", network:"mainnet", token_contract:NATIVE_USDC.near, issuer_public_key:issuer, paused:false}))]};
    return Response.json({result:{...result,...blockResult}});
  };
  assert.equal(status(await setupPreflight({env:configured, artifactDirectory:absentArtifacts, remote:true, fetch:remote}), "remote-billing"), "pass");
  billingKeys = [fullAccess(upgradeKey(13))];
  assert.equal(status(await setupPreflight({env:configured, artifactDirectory:absentArtifacts, remote:true, fetch:remote}), "remote-billing"), "blocked");
});

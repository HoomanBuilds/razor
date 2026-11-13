import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, row } from "../src/server/db";
import { ApiError } from "../src/server/context";
import { eligibleRetainedTokens, indicativeValue, verifyMetadata } from "../src/server/retained-assets/policy";
import { inspectRetainedWithdrawal } from "../src/server/retained-assets/withdrawal-proof";
import { prepareRetainedDeposit, prepareRetainedPolicy, prepareRetainedWithdrawal, retainedOverview } from "../src/server/retained-assets/service";
import type { RetainedAsset } from "../src/server/retained-assets/types";
import type { FinalTransaction, NearAction } from "../src/server/payments/near";
import type { Token } from "../src/server/payments/intents";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "43".repeat(32);

const token: Token = { assetId: "nep141:wrapped.near", blockchain: "near", contractAddress: "wrapped.near", symbol: "WRAP", decimals: 8, price: "2.5" };
const asset: RetainedAsset = { token_contract: "wrapped.near", asset_id: token.assetId, symbol: "WRAP", decimals: 8, enabled: true, balance: "500000000", in_flight: "0", balance_epoch: "7", confirmed_at_ms: "1800000000000", withdrawal: null };
const config = { organization_id: "fixture", near_account_id: "treasury.near", network: "mainnet" as const, token_contract: "usdc.near" };
const call = (method: string, value: object): NearAction => ({ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(value)).toString("base64") } });

test("retained token identity and indicative values exclude payment cash and preserve integer precision", () => {
  const usdc = { ...token, contractAddress: config.token_contract, assetId: `nep141:${config.token_contract}`, symbol: "USDC", decimals: 6 };
  assert.deepEqual(eligibleRetainedTokens([usdc, token, token, { ...token, blockchain: "eth" }, { ...token, assetId: "forged" }, { ...token, decimals: 1.5 }], config.token_contract), [token]);
  verifyMetadata(token, { spec: "ft-1.0.0", name: "Wrapped token", symbol: "WRAP", decimals: 8 });
  assert.throws(() => verifyMetadata(token, { spec: "ft-1.0.0", name: "Counterfeit", symbol: "WRAP", decimals: 6 }), /metadata/);
  const now = Date.now(), stamp = new Date(now).toISOString();
  assert.equal(indicativeValue("9007199254740993", 8, "2.5", stamp, now), "225179981368524");
  assert.equal(indicativeValue("100000000", 8, "2.5e-2", stamp, now), "25000");
  assert.equal(indicativeValue("0", 8, "2.5", stamp, now), "0");
  assert.equal(indicativeValue("1", 8, "2.5", undefined, now), null);
  assert.equal(indicativeValue("1", 8, "2.5", new Date(now - 300001).toISOString(), now), null);
  assert.equal(indicativeValue("1", 8, "2.5", new Date(now + 60001).toISOString(), now), null);
  assert.equal(indicativeValue("1", 8, "1e101", stamp, now), null);
  assert.equal(indicativeValue((2n ** 128n).toString(), 8, "1", stamp, now), null);
});

test("retained withdrawal recovery requires the exact final source receipt graph", () => {
  const pending: RetainedAsset = { ...asset, balance: "400000000", in_flight: "100000000", withdrawal: { id: "3", receiver_id: "owner.near", amount: "100000000", status: "pending", receipt: null } };
  const event = (standard: string, name: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard, event: name, data: [data] })}`;
  const result: FinalTransaction = {
    final_execution_status: "FINAL", transaction: { hash: "withdrawal-hash", signer_id: "owner.near", receiver_id: config.near_account_id, actions: [call("withdraw_retained_asset", { token_contract: asset.token_contract, receiver_id: "owner.near", amount: "100000000", expected_epoch: "7" })] },
    transaction_outcome: { outcome: { receipt_ids: ["execute"] } },
    receipts: [{ receipt_id: "transfer", receiver_id: asset.token_contract, predecessor_id: config.near_account_id, receipt: { Action: { actions: [call("ft_transfer", { receiver_id: "owner.near", amount: "100000000", memo: "Razor retained withdrawal 3" })] } } }],
    receipts_outcome: [
      { id: "execute", block_hash: "final-block", outcome: { executor_id: config.near_account_id, logs: [event("razor", "retained_withdrawal_started", { token_contract: asset.token_contract, withdrawal_id: "3", receiver_id: "owner.near", amount: "100000000" })], status: { SuccessReceiptId: "transfer" }, receipt_ids: ["transfer"] } },
      { id: "transfer", block_hash: "final-block", outcome: { executor_id: asset.token_contract, logs: [event("nep141", "ft_transfer", { old_owner_id: config.near_account_id, new_owner_id: "owner.near", amount: "100000000" })], status: { SuccessValue: "" }, receipt_ids: [] } },
    ],
  };
  assert.equal(inspectRetainedWithdrawal(result, config, pending).succeeded, true);
  const malformed = structuredClone(result);
  malformed.receipts_outcome![1].outcome.logs.unshift("EVENT_JSON:null", "EVENT_JSON:{\"standard\":\"nep141\",\"event\":\"ft_transfer\",\"data\":[null]}");
  assert.equal(inspectRetainedWithdrawal(malformed, config, pending).succeeded, true);
  assert.throws(() => inspectRetainedWithdrawal({ ...result, final_execution_status: "EXECUTED" }, config, pending), /final/);
  const unrelated = structuredClone(result);
  unrelated.receipts_outcome![0].outcome.receipt_ids = ["another-transfer"];
  assert.throws(() => inspectRetainedWithdrawal(unrelated, config, pending), /matching/);
  const unknown = structuredClone(result);
  unknown.receipts_outcome![1].outcome.status = { SuccessReceiptId: "unresolved-child" };
  assert.throws(() => inspectRetainedWithdrawal(unknown, config, pending), /still execute/);
  const failed = structuredClone(result);
  failed.receipts_outcome![1].outcome.status = { Failure: { ActionError: {} } };
  failed.receipts_outcome![1].outcome.logs = [];
  assert.equal(inspectRetainedWithdrawal(failed, config, pending).succeeded, false);
  assert.throws(() => inspectRetainedWithdrawal(result, config, { ...pending, withdrawal: { ...pending.withdrawal!, id: "4" } }), /bound/);
});

test("owner-only retained operations keep token units outside USDC accounting and hold stale observations", async () => {
  const db = getDb(), organizationId = randomUUID(), now = new Date().toISOString(), userId = randomUUID();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(userId, now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(organizationId, userId, now, now);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(organizationId, config.near_account_id, config.token_contract, now);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,'9000000','1000000',?)").run(organizationId, now);
  db.prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near','owner.near','mainnet',?)").run(randomUUID(), userId, now);
  const access = { organizationId, userId, permissions: ["company:read", "company:manage", "payments:prepare"] };
  const previousFetch = globalThis.fetch, previousPin = process.env.NEAR_TREASURY_CODE_HASH;
  process.env.NEAR_TREASURY_CODE_HASH = "11111111111111111111111111111111";
  let observed = asset.balance, paused = false, registry = [asset], catalog = [token];
  let currentAsset: RetainedAsset | null = asset;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v0/tokens")) return Response.json(catalog);
    const request = JSON.parse(String(init?.body)), params = request.params;
    if (params.request_type === "view_account") return Response.json({ result: { code_hash: process.env.NEAR_TREASURY_CODE_HASH } });
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
    const values: Record<string, unknown> = { get_config: { owner_id: "owner.near", token_contract: config.token_contract, paused, retained_assets_enabled: true, max_retained_assets: 16 }, get_retained_assets: registry, get_retained_asset: currentAsset, ft_metadata: { spec: "ft-1.0.0", name: "Wrapped token", symbol: "WRAP", decimals: 8 }, storage_balance_of: { total: "1" }, ft_balance_of: args.account_id === "owner.near" ? "1000000000" : observed };
    assert(params.method_name in values, `Unexpected retained view ${params.method_name}`);
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(values[params.method_name]))] } });
  };
  try {
    const deposit = await prepareRetainedDeposit(access, { tokenContract: asset.token_contract, senderAccountId: "owner.near", amount: "100000000" });
    assert.equal(deposit.walletActions.at(-1)?.actions[0].params.methodName, "ft_transfer_call");
    assert.equal(deposit.instructions.msg, "razor:retain");
    const withdraw = await prepareRetainedWithdrawal(access, { tokenContract: asset.token_contract, receiverId: "owner.near", amount: "100000000" });
    assert.equal(withdraw.walletActions.at(-1)?.actions[0].params.methodName, "withdraw_retained_asset");
    assert.equal((withdraw.walletActions.at(-1)!.actions[0].params.args as { expected_epoch: string }).expected_epoch, "7");
    const overview = await retainedOverview(access);
    assert.equal(overview.holdings[0].indicativeValueMicroUsd, "12500000");
    assert.equal(overview.holdings[0].priceUpdatedAt, null);
    assert(overview.holdings[0].priceObservedAt);
    observed = "450000000";
    await assert.rejects(() => prepareRetainedWithdrawal(access, { tokenContract: asset.token_contract, receiverId: "owner.near", amount: "1" }), /Refresh/);
    paused = true;
    await assert.rejects(() => prepareRetainedDeposit(access, { tokenContract: asset.token_contract, senderAccountId: "owner.near", amount: "1" }), /paused/);
    paused = false;
    await assert.rejects(() => prepareRetainedPolicy({ ...access, permissions: ["company:read"] }, { tokenContract: asset.token_contract, enabled: true }), (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN");
    observed = asset.balance;
    catalog = [{ ...token, assetId: "nep141:other.near", contractAddress: "other.near" }];
    currentAsset = { ...asset, enabled: false };
    assert.equal((await prepareRetainedWithdrawal(access, { tokenContract: asset.token_contract, receiverId: "owner.near", amount: "1" })).amount, "1");
    await assert.rejects(() => prepareRetainedDeposit(access, { tokenContract: asset.token_contract, senderAccountId: "owner.near", amount: "1" }), (error: unknown) => error instanceof ApiError && error.code === "RETAINED_ASSET_UNSUPPORTED");
    assert.equal((await prepareRetainedPolicy(access, { tokenContract: asset.token_contract, enabled: false })).enabled, false);
    catalog = [token];
    currentAsset = null;
    registry = Array.from({ length: 16 }, (_, index) => ({ ...asset, token_contract: `token${index}.near`, asset_id: `nep141:token${index}.near` }));
    await assert.rejects(() => prepareRetainedPolicy(access, { tokenContract: asset.token_contract, enabled: true }), (error: unknown) => error instanceof ApiError && error.code === "RETAINED_ASSET_LIMIT");
    assert.equal(row<{ balance: string; reserved: string }>("SELECT balance,reserved FROM treasury_balances WHERE organization_id=?", organizationId)?.balance, "9000000");
    assert.equal(row<{ balance: string; reserved: string }>("SELECT balance,reserved FROM treasury_balances WHERE organization_id=?", organizationId)?.reserved, "1000000");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPin === undefined) delete process.env.NEAR_TREASURY_CODE_HASH; else process.env.NEAR_TREASURY_CODE_HASH = previousPin;
  }
});

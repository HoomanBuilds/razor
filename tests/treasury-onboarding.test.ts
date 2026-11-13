import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { getDb, row } from "../src/server/db";
import { ApiError, type AccessContext } from "../src/server/context";
import { NATIVE_USDC } from "../src/server/payments/policy";
import { deriveSharedCompanyId } from "../src/server/payments/near";
import { configureTreasury } from "../src/server/payments/service";
import { creationInput, prepareTreasury, quoteTreasury, reconcileTreasury } from "../src/server/treasury-onboarding/service";

process.env.DATABASE_PATH = ":memory:";
process.env.NEAR_NETWORK = "mainnet";
process.env.NEAR_TREASURY_ID = "shared.near";
const treasuryHash = base58.encode(new Uint8Array(32).fill(2));
process.env.NEAR_TREASURY_CODE_HASH = treasuryHash;
const access: AccessContext = { userId: "verified-owner", organizationId: "company-one", permissions: ["company:manage", "company:read"] };
const terms = { ownerAccount: "owner.near", slug: "payroll", perPaymentLimit: "1000000", dailyLimit: "10000000" };
const companyId = deriveSharedCompanyId(access.organizationId, terms.ownerAccount);
const savedAt = new Date().toISOString();
getDb().prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(access.userId, "Owner", savedAt);
getDb().prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(access.organizationId, "Company", access.userId, savedAt, savedAt);
getDb().prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'mainnet',?)").run("owner-wallet", access.userId, terms.ownerAccount, savedAt);

const registered = new Map<string, { owner_id: string }>();
function mockRpc(wrongCode = false) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(init!.body as string), params = request.params;
    let result: unknown;
    if (request.method === "status") result = { chain_id: "mainnet" };
    else if (params.request_type === "view_account") result = { code_hash: wrongCode ? base58.encode(new Uint8Array(32).fill(3)) : treasuryHash };
    else {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
      const config = { architecture: "shared_v1", owner_id: terms.ownerAccount, token_contract: NATIVE_USDC.near, paused: false, per_payment_limit: terms.perPaymentLimit, daily_limit: terms.dailyLimit };
      let value: unknown;
      if (params.method_name === "get_platform_config") value = config;
      else if (params.method_name === "quote_registration") value = { architecture: "shared_v1", company_id: args.company_id, token_contract: NATIVE_USDC.near, minimum_deposit: "300", storage_bytes: "30" };
      else if (params.method_name === "get_company" || params.method_name === "get_config") value = registered.has(args.company_id) ? { ...config, company_id: args.company_id, ...registered.get(args.company_id) } : null;
      else if (params.method_name === "get_balance") { assert(registered.has(args.company_id)); value = { balance: "0", reserved: "0", available: "0", in_flight: "0", confirmed_at_ms: "1" }; }
      else throw new Error(`Unexpected contract call ${params.method_name}`);
      result = { result: [...Buffer.from(JSON.stringify(value))] };
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  return () => { globalThis.fetch = original; };
}

test("registration binds company, owner, reviewed storage quote and exact limits without deploying code", async () => {
  const restore = mockRpc();
  try {
    const quoted = await quoteTreasury(access, terms);
    const prepared = await prepareTreasury(access, terms, quoted.quote.hash);
    assert.equal(prepared.quote.accountId, "shared.near");
    assert.equal(prepared.quote.companyId, companyId);
    assert.equal(prepared.quote.treasuryFunding, "0");
    const action = prepared.walletActions[0].actions[0].params;
    assert.equal(action.deposit, "300");
    assert.equal(action.methodName, "register_company");
    assert.deepEqual(action.args, { company_id: companyId, per_payment_limit: terms.perPaymentLimit, daily_limit: terms.dailyLimit });
    await assert.rejects(() => prepareTreasury(access, { ...terms, dailyLimit: "20000000" }, quoted.quote.hash), (error: ApiError) => error.code === "CREATION_QUOTE_CHANGED");
    registered.set(companyId, { owner_id: terms.ownerAccount });
    await assert.rejects(() => prepareTreasury(access, terms, quoted.quote.hash), (error: ApiError) => error.code === "CREATION_ALREADY_REQUESTED");
  } finally { restore(); }
});

test("registration refuses unverified owners, invalid limits and unexpected deployed code", async () => {
  let restore = mockRpc();
  try {
    await assert.rejects(() => quoteTreasury(access, { ...terms, ownerAccount: "stranger.near" }), (error: ApiError) => error.code === "TREASURY_OWNER_UNVERIFIED");
    assert.equal(creationInput.safeParse({ ...terms, dailyLimit: "invalid" }).success, false);
    restore(); restore = mockRpc(true);
    await assert.rejects(() => reconcileTreasury(access, terms), (error: ApiError) => error.code === "TREASURY_CODE_MISMATCH");
  } finally { restore(); }
});

test("two companies share one account while retaining distinct immutable ledger bindings", async () => {
  const restore = mockRpc();
  try {
    registered.set(companyId, { owner_id: terms.ownerAccount });
    assert.equal((await reconcileTreasury(access, terms)).configured, true);
    const other = { ...access, organizationId: "company-two" }, otherId = deriveSharedCompanyId(other.organizationId, terms.ownerAccount);
    getDb().prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(other.organizationId, "Other", access.userId, savedAt, savedAt);
    registered.set(otherId, { owner_id: terms.ownerAccount });
    assert.equal((await reconcileTreasury(other, terms)).configured, true);
    const bindings = getDb().prepare("SELECT near_account_id,company_id FROM treasury_config ORDER BY organization_id").all();
    assert.equal(bindings.length, 2);
    assert(bindings.every(binding => binding.near_account_id === "shared.near"));
    assert.notEqual(bindings[0].company_id, bindings[1].company_id);
    const clearing = getDb().prepare("INSERT INTO clearing_companies(organization_id,owner_user_id,treasury_id,owner_account_id,policy_version,network,token_contract,created_at,updated_at) VALUES(?,?,?,?,'1','mainnet',?,?,?)");
    for (const company of [access, other]) clearing.run(company.organizationId, access.userId, "shared.near", terms.ownerAccount, NATIVE_USDC.near, savedAt, savedAt);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS total FROM clearing_companies WHERE treasury_id='shared.near'").get()!.total, 2);
    assert.throws(() => getDb().prepare("UPDATE treasury_config SET company_id=NULL WHERE organization_id=?").run(access.organizationId));
    assert.throws(() => getDb().prepare("UPDATE treasury_config SET company_id=? WHERE organization_id=?").run(otherId, access.organizationId));
    await assert.rejects(() => configureTreasury(other, { nearAccountId: "shared.near", network: "mainnet", tokenContract: NATIVE_USDC.near, companyId }), (error: ApiError) => error.code === "TREASURY_COMPANY_MISMATCH");
  } finally { restore(); }
});

test("a legitimate owner change preserves the original company identity", async () => {
  const restore = mockRpc();
  try {
    getDb().prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'mainnet',?)").run("replacement-wallet", access.userId, "replacement.near", savedAt);
    registered.set(companyId, { owner_id: "replacement.near" });
    assert.equal((await reconcileTreasury(access, { ownerAccount: "replacement.near", slug: "company" })).configured, true);
    assert.equal(row<{company_id:string}>("SELECT company_id FROM treasury_config WHERE organization_id=?", access.organizationId)?.company_id, companyId);
  } finally { restore(); }
});

test("legacy isolated rows cannot silently become shared treasuries", async () => {
  const legacy = { ...access, organizationId: "legacy-company" };
  getDb().prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(legacy.organizationId, "Legacy", access.userId, savedAt, savedAt);
  getDb().prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(legacy.organizationId, "legacy.near", NATIVE_USDC.near, savedAt);
  await assert.rejects(() => configureTreasury(legacy, { nearAccountId: "shared.near", network: "mainnet", tokenContract: NATIVE_USDC.near }), (error: ApiError) => error.code === "TREASURY_CHANGE_REQUIRES_MIGRATION");
  assert.equal(row<{architecture:string}>("SELECT architecture FROM treasury_config WHERE organization_id=?", legacy.organizationId)?.architecture, "isolated_v1");
});

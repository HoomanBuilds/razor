import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ApiError } from "../src/server/context";
import { getDb } from "../src/server/db";
import { deriveSharedCompanyId } from "../src/server/payments/near";
import { companyStorage, prepareCompanyStorage } from "../src/server/treasury-policy";

process.env.DATABASE_PATH = ":memory:";

test("shared storage funding belongs to the selected company and verified owner", async () => {
  const db = getDb(), userId = randomUUID(), first = randomUUID(), second = randomUUID(), stamp = new Date().toISOString();
  const pin = "11111111111111111111111111111111", originalPin = process.env.NEAR_TREASURY_CODE_HASH, originalFetch = globalThis.fetch;
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(userId, stamp);
  for (const id of [first, second]) {
    db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id, userId, stamp, stamp);
    db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,architecture,company_id,created_at) VALUES(?,'shared.near','mainnet','usdc.near','shared_v1',?,?)").run(id, deriveSharedCompanyId(id, "owner.near"), stamp);
  }
  db.prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near','owner.near','mainnet',?)").run(randomUUID(), userId, stamp);
  process.env.NEAR_TREASURY_CODE_HASH = pin;
  let badCode = false, inconsistent = false;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), params = request.params;
    if (params.request_type === "view_account") return Response.json({ result: { code_hash: badCode ? "changed" : pin } });
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
    const expected = [first, second].find(id => args.company_id === deriveSharedCompanyId(id, "owner.near"));
    assert(expected, "Every storage view must name an actual company ledger");
    const credit = expected === first ? "100" : "200";
    const value = params.method_name === "get_config" ? { owner_id: "owner.near" } : { storage_credit: credit, storage_used: "10", storage_available: inconsistent ? credit : (BigInt(credit) - 10n).toString() };
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
  };
  const access = { userId, organizationId: first, permissions: ["company:read", "company:manage"] };
  try {
    const one = await companyStorage(access), two = await companyStorage({ ...access, organizationId: second });
    assert(one.configured && two.configured);
    assert.equal(one.storage.storage_credit, "100"); assert.equal(two.storage.storage_credit, "200");
    const prepared = await prepareCompanyStorage(access, "10000000000000000000000");
    assert.equal(prepared.walletActions[0].receiverId, "shared.near");
    assert.deepEqual(prepared.walletActions[0].actions[0].params.args, { company_id: deriveSharedCompanyId(first, "owner.near") });
    assert.equal(prepared.walletActions[0].actions[0].params.deposit, "10000000000000000000000");
    await assert.rejects(() => prepareCompanyStorage({ ...access, permissions: ["company:read"] }, "1"), (error: ApiError) => error.code === "FORBIDDEN");
    await assert.rejects(() => prepareCompanyStorage({ ...access, userId: "unlinked" }, "1"), (error: ApiError) => error.code === "OWNER_WALLET_REQUIRED");
    badCode = true;
    await assert.rejects(() => prepareCompanyStorage(access, "1"), (error: ApiError) => error.code === "TREASURY_CODE_MISMATCH");
    badCode = false; inconsistent = true;
    await assert.rejects(() => companyStorage(access), (error: ApiError) => error.code === "STORAGE_ACCOUNTING_INVALID");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPin === undefined) delete process.env.NEAR_TREASURY_CODE_HASH; else process.env.NEAR_TREASURY_CODE_HASH = originalPin;
  }
});

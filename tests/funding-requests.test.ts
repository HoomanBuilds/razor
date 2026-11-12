import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getDb, row } from "../src/server/db";
import { ApiError } from "../src/server/context";
import { hashToken } from "../src/server/identity/crypto";
import { PERMISSIONS, getAccess } from "../src/server/identity/session";
import { NATIVE_USDC } from "../src/server/payments/policy";
import { createFundingRequest, getFundingRequest, getPublicFundingRequest, preparePublicQuote, publicFundingRoutes, reconcilePublicFunding, resumePublicQuote, revokeFundingRequest, rotateFundingLink } from "../src/server/funding-requests";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ab".repeat(32);
process.env.APP_URL = "http://localhost:3000";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const rpc = JSON.parse(String(init?.body));
  assert.equal(rpc.method, "query", "Only mocked read-only NEAR queries are allowed");
  const config = row<{ organization_id: string }>("SELECT organization_id FROM treasury_config WHERE near_account_id=?", rpc.params.account_id);
  const owner = config ? row<{ address: string }>("SELECT w.address FROM linked_wallets w JOIN memberships m ON m.user_id=w.user_id WHERE m.organization_id=? AND w.family='near'", config.organization_id)!.address : null;
  const value = rpc.params.method_name === "get_config" ? { owner_id: owner, token_contract: NATIVE_USDC.near, paused: false } : { total: "1250000000000000000000" };
  return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(value))] } }), { headers: { "content-type": "application/json" } });
};
after(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const db = getDb(), id = randomUUID(), ownerId = randomUUID(), roleId = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(ownerId, "Owner", now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Client Company", ownerId, now, now);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(roleId, id, "Owner", JSON.stringify(PERMISSIONS), now);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id, ownerId, roleId, now);
  db.prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'mainnet',?)").run(randomUUID(), ownerId, `owner-${id.slice(0, 8)}.near`, now);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(id, `treasury-${id.slice(0, 8)}.near`, NATIVE_USDC.near, now);
  return { access: getAccess(ownerId, id), input: { amount: "100000000", purpose: "Project deposit", expiresAt: new Date(Date.now() + 86_400_000).toISOString() } };
}

function seedActive(requestId: string, organizationId: string, amount: string) {
  const fundingId = randomUUID(), quoteId = randomUUID(), key = randomUUID(), now = new Date().toISOString(), originAsset = "nep141:eth.omft.near", refund = `0x${"14".repeat(20)}`;
  const request = row<{ treasury_account_id: string; capability_id: string }>("SELECT treasury_account_id,capability_id FROM funding_requests WHERE id=?", requestId)!;
  const token = { assetId: originAsset, symbol: "ETH", blockchain: "eth", decimals: 18, contractAddress: null };
  const quote = { signature: "fixture-only-not-live", quoteRequest: { dry: false, originAsset, refundTo: refund, amount, recipient: request.treasury_account_id, deadline: new Date(Date.now() + 3_600_000).toISOString(), swapType: "EXACT_OUTPUT" }, quote: { amountIn: "1000000000000000", amountOut: amount, depositAddress: `0x${"12".repeat(20)}` } };
  getDb().prepare("INSERT INTO funding_legs(id,organization_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending_deposit',?,?)").run(fundingId, organizationId, `request:${requestId}:${quoteId}`, originAsset, quote.quote.amountIn, amount, JSON.stringify(quote), quote.quote.depositAddress, request.treasury_account_id, now, now);
  getDb().prepare("INSERT INTO funding_request_quotes(id,request_id,key_hash,actor_id,origin_asset,origin_token_json,refund_address,requested_output,funding_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)").run(quoteId, requestId, hashToken(key), `funding-link:${request.capability_id}`, originAsset, JSON.stringify(token), refund, amount, fundingId, now, now);
  return { fundingId, key, originAsset, refund };
}

test("funding authority is scoped to hashed links and public fields omit company finances", async () => {
  const { access, input } = fixture();
  await assert.rejects(() => createFundingRequest({ ...access, permissions: ["company:read"] }, input), (error: ApiError) => error.status === 403);
  const created = await createFundingRequest(access, input);
  const stored = row<{ token_hash: string; purpose_ciphertext: string }>("SELECT token_hash,purpose_ciphertext FROM funding_requests WHERE id=?", created.request.id)!;
  assert.equal(stored.token_hash, hashToken(created.link.token));
  assert.notEqual(stored.token_hash, created.link.token);
  assert.notEqual(stored.purpose_ciphertext, input.purpose);
  const publicView = getPublicFundingRequest(created.link.token);
  assert.deepEqual(Object.keys(publicView).sort(), ["activeFunding", "amount", "companyName", "confirmedAmount", "expiresAt", "id", "purpose", "remainingAmount", "status"].sort());
  assert.ok(!JSON.stringify(publicView).includes(access.organizationId));
  assert.throws(() => getFundingRequest({ ...access, organizationId: randomUUID() }, created.request.id), /not found/);
  const replacement = rotateFundingLink(access, created.request.id);
  assert.throws(() => getPublicFundingRequest(created.link.token), /not available/);
  assert.equal(getPublicFundingRequest(replacement.link.token).companyName, "Client Company");
  const app = new Hono().route("/funding-requests", publicFundingRoutes);
  app.onError((error, c) => c.json({ error: error.message }, error instanceof ApiError ? error.status as 400 : 400));
  const redirect = await app.request("http://localhost:3000/funding-requests/quote", { method: "POST", headers: { origin: process.env.APP_URL!, "content-type": "application/json" }, body: JSON.stringify({ token: replacement.link.token, originAsset: "any-asset", refundAddress: "my-wallet", idempotencyKey: randomUUID(), recipient: "attacker.near" }) });
  assert.equal(redirect.status, 400);
});

test("one active funding leg is idempotent and provider reporting cannot fulfill the request", async () => {
  const { access, input } = fixture(), created = await createFundingRequest(access, input);
  const active = seedActive(created.request.id, access.organizationId, input.amount);
  const first = await preparePublicQuote(created.link.token, { originAsset: active.originAsset, refundAddress: active.refund, idempotencyKey: active.key });
  const second = await preparePublicQuote(created.link.token, { originAsset: active.originAsset, refundAddress: active.refund, idempotencyKey: active.key });
  assert.equal(first.funding.id, second.funding.id);
  assert.equal(resumePublicQuote(created.link.token, active.key).funding.id, active.fundingId);
  await assert.rejects(() => preparePublicQuote(created.link.token, { originAsset: active.originAsset, refundAddress: active.refund, idempotencyKey: randomUUID() }), /still unresolved/);
  await assert.rejects(() => preparePublicQuote(created.link.token, { originAsset: active.originAsset, refundAddress: "another-refund", idempotencyKey: active.key }), /different source terms/);
  await assert.rejects(() => reconcilePublicFunding(created.link.token, { fundingId: active.fundingId, sourceTxHash: "unowned-hash-123" }), (error: ApiError) => error.status === 403);
  assert.throws(() => rotateFundingLink(access, created.request.id), /current funding leg/);
  getDb().prepare("UPDATE funding_legs SET status='confirmed',provider_status='SUCCESS',credited_amount=? WHERE id=?").run(input.amount, active.fundingId);
  assert.equal(getPublicFundingRequest(created.link.token).status, "awaiting_confirmation");
  assert.equal(getPublicFundingRequest(created.link.token).confirmedAmount, "0");
  assert.equal(getPublicFundingRequest(created.link.token).remainingAmount, input.amount);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM funding_legs WHERE organization_id=?", access.organizationId)!.n, 1);
});

test("expired and revoked requests reject new quotes while retaining existing tracking", async () => {
  const { access, input } = fixture(), created = await createFundingRequest(access, input), active = seedActive(created.request.id, access.organizationId, input.amount);
  getDb().prepare("UPDATE funding_requests SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), created.request.id);
  await assert.rejects(() => preparePublicQuote(created.link.token, { originAsset: active.originAsset, refundAddress: active.refund, idempotencyKey: active.key }), /expired/);
  assert.equal(resumePublicQuote(created.link.token, active.key).request.status, "expired");
  const another = await createFundingRequest(access, input);
  revokeFundingRequest(access, another.request.id);
  await assert.rejects(() => preparePublicQuote(another.link.token, { originAsset: active.originAsset, refundAddress: active.refund, idempotencyKey: randomUUID() }), /revoked/);
  assert.equal(getPublicFundingRequest(another.link.token).status, "revoked");
});

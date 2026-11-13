import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { getDb, row } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { ApiError } from "../src/server/context";
import { PERMISSIONS } from "../src/server/identity/session";
import { approvePayment, createPayment, getTreasury, reconcileFunding, reserveApprovedPayment } from "../src/server/payments/service";
import { paymentTermsHash } from "../src/server/client-reserves/accounting";
import { createClientReserve } from "../src/server/client-reserves/service";
import { claimTaskDeposit, closeUnsentFunding, paymentFundingTask, quotePaymentFunding, reserveTaskFunding } from "../src/server/payment-funding";
import { fundingStateAfterProvider } from "../src/server/payment-funding/lifecycle";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { FundingLeg } from "../src/server/payments/types";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ad".repeat(32);
process.env.NEAR_TREASURY_CODE_HASH = "11111111111111111111111111111111";
const originalFetch = globalThis.fetch;
const source = { assetId: "nep141:eth.omft.near", symbol: "ETH", blockchain: "eth", decimals: 18, contractAddress: null };
const destination = { assetId: `nep141:${NATIVE_USDC.near}`, symbol: "USDC", blockchain: "near", decimals: 6, contractAddress: NATIVE_USDC.near };
let quoted: Record<string, unknown> | undefined;
globalThis.fetch = async (url, input) => {
  if (String(url).endsWith("/v0/tokens")) return Response.json([source, destination]);
  if (String(url).endsWith("/v0/quote")) { quoted = JSON.parse(String(input?.body)); return Response.json({ signature: "unsigned-fixture" }); }
  if (String(url).includes("/v0/status?")) return Response.json({ status: "PROCESSING", quoteResponse: { signature: "unsigned-fixture" } });
  const rpc = JSON.parse(String(input?.body));
  assert.equal(rpc.method, "query", "Only read-only NEAR calls are permitted");
  if (rpc.params.request_type === "view_account") return Response.json({ result: { code_hash: process.env.NEAR_TREASURY_CODE_HASH } });
  const config = row<{ organization_id: string }>("SELECT organization_id FROM treasury_config WHERE near_account_id=?", rpc.params.account_id)!;
  const balance = row<{ balance: string }>("SELECT balance FROM treasury_balances WHERE organization_id=?", config.organization_id)!;
  const value = { balance: balance.balance, reserved: "0", available: balance.balance, in_flight: "0", confirmed_at_ms: String(Date.now()) };
  return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
};
after(() => { globalThis.fetch = originalFetch; });

function fixture(cash = "0", fee = "1000000") {
  const id = randomUUID(), recipientId = randomUUID(), savedAt = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Owner", savedAt);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Company", id, savedAt, savedAt);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'vendor','USDC','near',?,'confirmed',?,?,?)").run(recipientId, id, "Supplier", `supplier-${id.slice(0, 8)}.near`, savedAt, savedAt, savedAt);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(id, `treasury-${id.slice(0, 8)}.near`, NATIVE_USDC.near, savedAt);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,?,'0','0',?)").run(id, cash, savedAt);
  const access: AccessContext = { userId: id, organizationId: id, permissions: [...PERMISSIONS] };
  const preparer = { ...access, permissions: ["company:read", "payments:read", "payments:prepare"] };
  const payment = createPayment(access, { recipientId, reference: randomUUID(), amount: "100000000", maxFee: fee });
  return { access, preparer, payment, recipientId };
}
function taskCommit(access: AccessContext, paymentId: string, cash: string) {
  const payment = paymentFundingTask(access, paymentId).payment, savedAt = new Date().toISOString();
  getDb().prepare("INSERT INTO payment_funding_tasks(payment_id,organization_id,terms_hash,cash_committed,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(paymentId, access.organizationId, paymentTermsHash(payment), cash, access.userId, savedAt, savedAt);
}
function leg(access: AccessContext, paymentId: string, amount = "101000000", verified = false) {
  const id = randomUUID(), savedAt = new Date().toISOString(), recipient = getTreasury(access).config!.near_account_id;
  const quote = { quoteRequest: { dry: false, swapType: "EXACT_OUTPUT", originAsset: source.assetId, recipient, recipientType: "DESTINATION_CHAIN", destinationAsset: destination.assetId, refundTo: `0x${"12".repeat(20)}`, amount, depositType: "ORIGIN_CHAIN", deadline: new Date(Date.now() + 3600_000).toISOString() }, quote: { amountIn: "1000000000000000", amountOut: amount, depositAddress: `0x${"13".repeat(20)}` } };
  getDb().prepare("INSERT INTO funding_legs(id,organization_id,payment_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,credited_amount,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, access.organizationId, paymentId, randomUUID(), source.assetId, quote.quote.amountIn, amount, JSON.stringify(quote), quote.quote.depositAddress, recipient, verified ? "confirmed" : "pending_deposit", verified ? amount : "0", savedAt, savedAt);
  if (verified) getDb().prepare("INSERT INTO funding_credit_receipts(id,funding_id,organization_id,network,token_contract,transaction_hash,receipt_id,log_index,data_index,amount,evidence,verified_by,verified_at) VALUES(?,?,?,'mainnet',?,?,?,0,0,?,'{}',?,?)")
    .run(randomUUID(), id, access.organizationId, NATIVE_USDC.near, `tx-${id}`, `receipt-${id}`, amount, access.userId, savedAt);
  return row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", id)!;
}

test("quotes only the remaining approved need and protects committed existing cash if routing fails", async () => {
  const { access, preparer, payment } = fixture("25000000");
  assert.throws(() => reserveApprovedPayment(preparer, payment.id), /approve this obligation/);
  approvePayment(access, payment.id);
  const task = paymentFundingTask(preparer, payment.id);
  assert.equal(task.shortfall, "76000000");
  assert.equal(task.canQuote, true);
  await assert.rejects(() => quotePaymentFunding(preparer, payment.id, { idempotencyKey: randomUUID(), reviewToken: task.reviewToken, originAsset: source.assetId, refundAddress: `0x${"12".repeat(20)}` }), (error: ApiError) => error.code === "QUOTE_SIGNATURE_INVALID");
  assert.equal(quoted?.amount, "76000000");
  assert.equal(quoted?.swapType, "EXACT_OUTPUT");
  assert.equal(quoted?.recipient, task.treasury.config!.near_account_id);
  assert.equal(paymentFundingTask(preparer, payment.id).cashCommitted, "25000000");
  assert.equal(getTreasury(access).linkedFundingReserved, "25000000");
  assert.equal(getTreasury(access).available, "0");
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM funding_legs WHERE organization_id=?", access.organizationId)!.n, 0);
});

test("verified linked funds exchange once for the original approved budget without approver authority", async () => {
  const { access, preparer, payment, recipientId } = fixture("25000000");
  approvePayment(access, payment.id); taskCommit(access, payment.id, "25000000"); leg(access, payment.id, "76000000", true);
  getDb().prepare("UPDATE treasury_balances SET balance='101000000' WHERE organization_id=?").run(access.organizationId);
  assert.equal(getTreasury(access).available, "0");
  const other = createPayment(access, { recipientId, reference: randomUUID(), amount: "1000000", maxFee: "0" });
  assert.equal(approvePayment(access, other.id).status, "approved_unfunded");
  await reserveTaskFunding(preparer, payment.id); await reserveTaskFunding(preparer, payment.id);
  const task = paymentFundingTask(preparer, payment.id);
  assert.equal(task.payment.status, "approved"); assert.equal(task.stage, "ready_for_payout");
  assert.equal(task.payment.approved_by, access.userId); assert.equal(task.payment.reserved_amount, "101000000");
  assert.equal(getTreasury(access).linkedFundingReserved, "0"); assert.equal(getTreasury(access).paymentReserved, "101000000");
  assert.equal(getTreasury(access).available, "0");
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM treasury_ledger WHERE organization_id=? AND entry_type='payment_reserved'", access.organizationId)!.n, 1);
  assert.throws(() => reserveApprovedPayment(preparer, other.id + "missing"), /not found/);
});

test("a final funding receipt with stale contract balance blocks another deposit and requires a refresh", () => {
  const { access, preparer, payment } = fixture(); approvePayment(access, payment.id); taskCommit(access, payment.id, "0");
  leg(access, payment.id, "101000000", true);
  const task = paymentFundingTask(preparer, payment.id);
  assert.equal(task.fundingCredit, "101000000"); assert.equal(task.treasury.balance, "0");
  assert.equal(task.stage, "refresh_treasury"); assert.equal(task.shortfall, "0");
  assert.equal(task.canQuote, false); assert.equal(task.canReserve, false);
  assert.equal(getTreasury(access).reserveDeficit, "101000000");
});

test("persisted source claims and unknown outcomes prevent resend across sessions", async () => {
  const { access, preparer, payment } = fixture(); approvePayment(access, payment.id); const funding = leg(access, payment.id);
  assert.equal(paymentFundingTask(preparer, payment.id).depositAllowed, true);
  claimTaskDeposit(preparer, payment.id, funding.id);
  const resumed = paymentFundingTask({ ...preparer }, payment.id);
  assert.equal(resumed.depositAllowed, false); assert.equal(resumed.canQuote, false); assert.equal(resumed.stage, "reconcile_funding");
  assert.throws(() => claimTaskDeposit(preparer, payment.id, funding.id), /already claimed/);
  await assert.rejects(() => quotePaymentFunding(preparer, payment.id, { idempotencyKey: randomUUID(), reviewToken: resumed.reviewToken, originAsset: source.assetId, refundAddress: `0x${"12".repeat(20)}` }), /existing source transfer/);
  getDb().prepare("UPDATE funding_legs SET source_tx_hash='known-source' WHERE id=?").run(funding.id);
  await assert.rejects(() => closeUnsentFunding(preparer, payment.id, funding.id, true), /known or uncertain source/);
});

test("idempotency resumes the same saved leg and rejects changed source terms", async () => {
  const { access, preparer, payment } = fixture(); approvePayment(access, payment.id); taskCommit(access, payment.id, "0");
  const funding = leg(access, payment.id), idempotencyKey = randomUUID(), terms = paymentTermsHash(paymentFundingTask(access, payment.id).payment), refundAddress = `0x${"12".repeat(20)}`;
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  getDb().prepare("INSERT INTO payment_funding_quotes(id,payment_id,organization_id,request_key,input_hash,terms_hash,state,funding_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?,?)")
    .run(randomUUID(), payment.id, access.organizationId, digest(idempotencyKey), digest({ paymentId: payment.id, terms, originAsset: source.assetId, refundAddress, walletId: null }), terms, funding.id, new Date().toISOString(), new Date().toISOString());
  const input = { idempotencyKey, reviewToken: "outdated-review-can-resume-only", originAsset: source.assetId, refundAddress };
  assert.equal((await quotePaymentFunding(preparer, payment.id, input)).funding!.id, funding.id);
  assert.equal((await quotePaymentFunding(preparer, payment.id, input)).reused, true);
  await assert.rejects(() => quotePaymentFunding(preparer, payment.id, { ...input, originAsset: "another-asset" }), /different source or obligation terms/);
  assert.throws(() => getDb().prepare("INSERT INTO payment_funding_quotes(id,payment_id,organization_id,request_key,input_hash,terms_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'quoting',?,?)").run(randomUUID(), payment.id, access.organizationId, randomUUID(), "hash", terms, new Date().toISOString(), new Date().toISOString()), /UNIQUE/);
});

test("client principal and linked funding remain conserved during a preparer's exact approved reservation", async () => {
  const { access, preparer, payment } = fixture("100000000");
  createClientReserve(access, { idempotencyKey: randomUUID(), amount: payment.amount, purpose: "Already approved client principal", paymentId: payment.id });
  approvePayment(access, payment.id); taskCommit(access, payment.id, "0"); leg(access, payment.id, "1000000", true);
  getDb().prepare("UPDATE treasury_balances SET balance='101000000' WHERE organization_id=?").run(access.organizationId);
  assert.equal(getTreasury(access).clientReserved, "100000000"); assert.equal(getTreasury(access).linkedFundingReserved, "1000000");
  await reserveTaskFunding(preparer, payment.id);
  assert.equal(getTreasury(access).clientReserved, "0"); assert.equal(getTreasury(access).linkedFundingReserved, "0");
  assert.equal(getTreasury(access).paymentReserved, "101000000"); assert.equal(getTreasury(access).available, "0");
});

test("changed approved terms and unverified reported completion cannot authorize new deposits", () => {
  const { access, preparer, payment, recipientId } = fixture(); approvePayment(access, payment.id); taskCommit(access, payment.id, "0");
  const funding = leg(access, payment.id);
  getDb().prepare("UPDATE funding_legs SET status='confirmed',credited_amount='101000000',provider_status='SUCCESS' WHERE id=?").run(funding.id);
  let task = paymentFundingTask(preparer, payment.id);
  assert.equal(task.fundingCredit, "0"); assert.equal(task.stage, "reconcile_funding"); assert.equal(task.canQuote, false);
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(recipientId);
  task = paymentFundingTask(preparer, payment.id);
  assert.equal(task.stage, "terms_changed"); assert.equal(task.depositAllowed, false);
  assert.throws(() => claimTaskDeposit(preparer, payment.id, funding.id), /preferences changed/);
});

test("actual payout source funds are counted once; refunds and excess stay tied to the same budget", () => {
  const { access, preparer, payment } = fixture(); approvePayment(access, payment.id); taskCommit(access, payment.id, "0");
  leg(access, payment.id, "110000000", true);
  getDb().prepare("UPDATE treasury_balances SET balance='110000000' WHERE organization_id=?").run(access.organizationId);
  assert.equal(getTreasury(access).linkedFundingReserved, "101000000"); assert.equal(getTreasury(access).available, "9000000");
  const attemptId = randomUUID(), savedAt = new Date().toISOString();
  getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','unknown','{}','USDC','near','supplier.near','100000000','101000000','deposit.near',?,?)").run(attemptId, payment.id, access.organizationId, savedAt, savedAt);
  getDb().prepare("INSERT INTO payment_source_receipts(attempt_id,organization_id,transaction_hash,receipt_id,evidence,verified_by,verified_at) VALUES(?,?,?,?,?,?,?)").run(attemptId, access.organizationId, "source-tx", "source-receipt", JSON.stringify({ succeeded: true, finality: "FINAL", amount: "101000000", receiver: "deposit.near" }), access.userId, savedAt);
  getDb().prepare("UPDATE payments SET status='in_flight' WHERE id=?").run(payment.id);
  getDb().prepare("UPDATE treasury_balances SET balance='9000000' WHERE organization_id=?").run(access.organizationId);
  assert.equal(getTreasury(access).linkedFundingReserved, "0"); assert.equal(getTreasury(access).reserveDeficit, "0");
  assert.equal(paymentFundingTask(preparer, payment.id).canQuote, false);
  getDb().prepare("UPDATE payout_attempts SET state='refunded_verified' WHERE id=?").run(attemptId);
  getDb().prepare("UPDATE payments SET status='held',total_spent='1000000' WHERE id=?").run(payment.id);
  getDb().prepare("UPDATE treasury_balances SET balance='109000000' WHERE organization_id=?").run(access.organizationId);
  const recovered = paymentFundingTask(preparer, payment.id);
  assert.equal(recovered.required, "100000000"); assert.equal(recovered.shortfall, "0"); assert.equal(recovered.canQuote, false);
  assert.equal(getTreasury(access).linkedFundingReserved, "100000000"); assert.equal(getTreasury(access).available, "9000000");
  getDb().prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(payment.id);
  assert.equal(getTreasury(access).linkedFundingReserved, "0"); assert.equal(paymentFundingTask(preparer, payment.id).stage, "cancelled");
});


test("closed unsent history reopens only after validated provider activity, while refund closure stays immutable", async () => {
  assert.equal(fundingStateAfterProvider({ status: "closed_unsent" }, "PENDING_DEPOSIT"), "closed_unsent");
  assert.equal(fundingStateAfterProvider({ status: "closed_unsent" }, "PROCESSING"), "processing");
  assert.equal(fundingStateAfterProvider({ status: "closed_unsent" }, "SUCCESS"), "reported_delivered");
  assert.equal(fundingStateAfterProvider({ status: "refunded_verified" }, "PROCESSING"), "refunded_verified");
  assert.equal(fundingStateAfterProvider({ status: "refunded_attested" }, "SUCCESS"), "refunded_attested");
  assert.equal(fundingStateAfterProvider({ status: "source_unknown" }, "PENDING_DEPOSIT"), "source_unknown");
  const { access, preparer, payment } = fixture(); approvePayment(access, payment.id); const funding = leg(access, payment.id);
  getDb().prepare("UPDATE funding_legs SET status='closed_unsent' WHERE id=?").run(funding.id);
  await assert.rejects(() => reconcileFunding(preparer, funding.id), (error: ApiError) => error.code === "STATUS_MISMATCH");
  assert.equal(row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", funding.id)!.status, "closed_unsent");
  getDb().prepare("UPDATE funding_legs SET source_tx_hash='late-known-source' WHERE id=?").run(funding.id);
  assert.equal(paymentFundingTask(preparer, payment.id).canQuote, false);
});


test("closed source history changes the review token for a fresh funding quote", () => {
  const { access, payment } = fixture();
  const before = paymentFundingTask(access, payment.id).reviewToken;
  const db = getDb(), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO funding_legs(id,organization_id,payment_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,created_at,updated_at) VALUES(?,?,?,'closed-history','asset','1','1','{}','deposit.near','treasury.near','closed_unsent',?,?)").run(randomUUID(), access.organizationId, payment.id, timestamp, timestamp);
  assert.notEqual(paymentFundingTask(access, payment.id).reviewToken, before);
});

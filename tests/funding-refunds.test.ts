import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { ApiError } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { hashToken } from "../src/server/identity/crypto";
import { refundTerms } from "../src/server/funding-refunds/policy";
import { inspectEvmRefund, inspectSolanaRefund, verifySourceRefund, type EvmRefundReceipt } from "../src/server/funding-refunds/receipts";
import { createFundingRefundService, listFundingRefunds } from "../src/server/funding-refunds/service";
import { createFundingRequest, getPublicAssets, getPublicFundingRequest, reconcilePublicFunding, resumePublicQuote } from "../src/server/funding-requests/service";
import { fundingRefundExport } from "../src/server/funding-refunds/export";
import type { RefundTerms } from "../src/server/funding-refunds/types";
import type { QuoteResponse, StatusResponse, Token } from "../src/server/payments/intents";
import type { FundingLeg } from "../src/server/payments/types";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "64".repeat(32);
const source: Token = { assetId: "nep141:btc.omft.near", symbol: "BTC", blockchain: "btc", decimals: 8, contractAddress: null };
const sourceHash = "11".repeat(32), refundHash = "22".repeat(32), refundTo = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const quote: QuoteResponse = { correlationId: "refund-fixture", timestamp: new Date().toISOString(), signature: "local-fixture-not-a-live-signed-quote", quoteRequest: { dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 50, originAsset: source.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: "nep141:usdc.near", amount: "1000000", recipient: "treasury.near", recipientType: "DESTINATION_CHAIN", refundTo, refundType: "ORIGIN_CHAIN", deadline: new Date(Date.now() + 3600_000).toISOString() }, quote: { amountIn: "100000", amountOut: "1000000", depositAddress: "1CounterpartyDeposit" } };
const provider: StatusResponse = { status: "REFUNDED", quoteResponse: quote, swapDetails: { refundedAmount: "99000", depositedAmount: "100000", amountOut: "0", originChainTxHashes: [{ hash: sourceHash }, { hash: refundHash }] } };
const leg = { id: "fixture", organization_id: "company", reference: "Top-up", origin_asset: source.assetId, amount_in: quote.quote.amountIn, expected_output: quote.quote.amountOut, quote: JSON.stringify(quote), deposit_address: quote.quote.depositAddress!, deposit_memo: null, recipient_address: "treasury.near", status: "recovery_pending", provider_status: "REFUNDED", source_tx_hash: sourceHash, destination_tx_hash: null, credited_amount: "0" } as FundingLeg;
const validTerms = () => refundTerms(leg, quote, provider, source, { transactionHash: refundHash });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("source refund closure binds terminal actual amounts, exact quote and original recovery address", () => {
  assert.equal(validTerms().refundedAmount, "99000");
  for (const status of ["FAILED", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "UNKNOWN"]) assert.throws(() => refundTerms(leg, quote, { ...provider, status }, source, { transactionHash: refundHash }), code("FUNDING_REFUND_NOT_TERMINAL"));
  assert.throws(() => refundTerms(leg, quote, { ...provider, swapDetails: { ...provider.swapDetails, refundedAmount: "0" } }, source, { transactionHash: refundHash }), code("FUNDING_REFUND_AMOUNT_UNPROVEN"));
  assert.throws(() => refundTerms(leg, quote, { ...provider, swapDetails: { ...provider.swapDetails, amountOut: "1" } }, source, { transactionHash: refundHash }), code("FUNDING_REFUND_CONTRADICTION"));
  assert.throws(() => refundTerms(leg, quote, { ...provider, swapDetails: { ...provider.swapDetails, refundedAmount: "100001" } }, source, { transactionHash: refundHash }), code("FUNDING_REFUND_CONTRADICTION"));
  assert.throws(() => refundTerms(leg, quote, provider, source, { transactionHash: sourceHash }), code("FUNDING_REFUND_HASH_UNBOUND"));
  assert.throws(() => refundTerms(leg, quote, provider, source, { transactionHash: "unrelated" }), code("FUNDING_REFUND_HASH_UNBOUND"));
  assert.throws(() => refundTerms({ ...leg, credited_amount: "1" }, quote, provider, source, { transactionHash: refundHash }), code("FUNDING_REFUND_CONTRADICTION"));
  assert.throws(() => refundTerms(leg, quote, { ...provider, quoteResponse: { ...quote, quoteRequest: { ...quote.quoteRequest, refundTo: "attacker" } } }, source, { transactionHash: refundHash }), code("STATUS_TERMS_MISMATCH"));
  assert.throws(() => refundTerms({ ...leg, origin_decimals: 6 }, quote, provider, source, { transactionHash: refundHash }), code("FUNDING_REFUND_ASSET_MISMATCH"));
});

test("final EVM and Solana refund receipts require exact asset, recipient, quantity and finality", () => {
  const receiver = `0x${"33".repeat(20)}` as const, token = `0x${"44".repeat(20)}` as const, sender = `0x${"55".repeat(20)}` as const, hash = `0x${refundHash}` as const;
  const terms: RefundTerms = { ...validTerms(), transactionHash: hash, refundTo: receiver, source: { ...source, blockchain: "base", assetId: "nep141:base-token.omft.near", contractAddress: token } };
  const log = { address: token, logIndex: 2, data: encodeAbiParameters([{ type: "uint256" }], [99000n]), topics: encodeEventTopics({ abi: [{ type: "event", name: "Transfer", inputs: [{ type: "address", name: "from", indexed: true }, { type: "address", name: "to", indexed: true }, { type: "uint256", name: "value" }] }], eventName: "Transfer", args: { from: sender, to: receiver } }).filter((value): value is `0x${string}` => typeof value === "string") };
  const receipt: EvmRefundReceipt = { status: "success", transactionHash: hash, blockNumber: 100n, blockHash: "block", logs: [log] }, tx = { hash, to: token, value: 0n }, finalized = { number: 101n, hash: "later-block" };
  assert.equal(inspectEvmRefund(terms, receipt, tx, finalized, "block").provenance, "final_chain_receipt");
  assert.throws(() => inspectEvmRefund(terms, receipt, tx, { number: 99n, hash: "old" }, "block"), code("FUNDING_REFUND_RECEIPT_UNPROVEN"));
  assert.throws(() => inspectEvmRefund(terms, { ...receipt, status: "reverted" }, tx, finalized, "block"), code("FUNDING_REFUND_RECEIPT_UNPROVEN"));
  assert.throws(() => inspectEvmRefund({ ...terms, refundedAmount: "98000" }, receipt, tx, finalized, "block"), code("FUNDING_REFUND_RECEIPT_UNPROVEN"));
  assert.throws(() => inspectEvmRefund(terms, { ...receipt, logs: [{ ...log, address: sender }] }, tx, finalized, "block"), code("FUNDING_REFUND_RECEIPT_UNPROVEN"));
  const native = { ...terms, source: { ...terms.source, contractAddress: null } };
  assert.equal(inspectEvmRefund(native, { ...receipt, logs: [] }, { hash, to: receiver, value: 99000n }, finalized, "block").provenance, "final_chain_receipt");
  assert.equal(inspectEvmRefund(native, { ...receipt, logs: [] }, tx, finalized, "block").provenance, "funder_or_reporter_attestation");
  const sol = { ...validTerms(), source: { ...source, blockchain: "sol", assetId: "sol-token", contractAddress: "mint" }, refundTo: "sol-receiver" };
  const result = { slot: 1, signatures: [refundHash], accounts: ["payer"], meta: { err: null, fee: 5000, preBalances: [100000], postBalances: [95000], preTokenBalances: [{ accountIndex: 1, mint: "mint", owner: "sol-receiver", uiTokenAmount: { amount: "5", decimals: 8 } }], postTokenBalances: [{ accountIndex: 1, mint: "mint", owner: "sol-receiver", uiTokenAmount: { amount: "99005", decimals: 8 } }] } };
  assert.equal(inspectSolanaRefund(sol, result).provenance, "final_chain_receipt");
  assert.throws(() => inspectSolanaRefund({ ...sol, refundedAmount: "99001" }, result), code("FUNDING_REFUND_RECEIPT_UNPROVEN"));
  assert.throws(() => inspectSolanaRefund(sol, { ...result, meta: { ...result.meta, err: { InstructionError: [] } } }), code("FUNDING_REFUND_RECEIPT_UNPROVEN"));
});

function fixture() {
  const db = getDb(), organizationId = randomUUID(), userId = randomUUID(), fundingId = randomUUID(), requestId = randomUUID(), now = new Date().toISOString(), token = randomUUID().replaceAll("-", "") + "long-token1";
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Reviewer',?)").run(userId, now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(organizationId, userId, now, now);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,'9000000','1000000',?)").run(organizationId, now);
  db.prepare("INSERT INTO funding_legs(id,organization_id,reference,origin_asset,origin_network,origin_decimals,origin_symbol,amount_in,expected_output,quote,deposit_address,recipient_address,status,provider_status,source_tx_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'recovery_pending','REFUNDED',?,?,?)").run(fundingId, organizationId, `Top-up ${fundingId}`, source.assetId, source.blockchain, source.decimals, source.symbol, leg.amount_in, leg.expected_output, leg.quote, leg.deposit_address, leg.recipient_address, sourceHash, now, now);
  db.prepare("INSERT INTO funding_requests(id,organization_id,amount,purpose_ciphertext,expires_at,token_hash,capability_id,treasury_account_id,treasury_owner_id,token_contract,network,created_by,created_at,updated_at) VALUES(?,?,?,'Funding',?,?,?,?,?,?,'mainnet',?,?,?)").run(requestId, organizationId, "1000000", new Date(Date.now() + 3600_000).toISOString(), hashToken(token), randomUUID(), "treasury.near", "owner.near", "usdc.near", userId, now, now);
  db.prepare("INSERT INTO funding_request_quotes(id,request_id,key_hash,actor_id,origin_asset,origin_token_json,refund_address,requested_output,funding_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)").run(randomUUID(), requestId, hashToken("saved-quote-key-12345"), "funder", source.assetId, JSON.stringify(source), refundTo, "1000000", fundingId, now, now);
  return { access: { organizationId, userId, permissions: ["company:read", "payments:read", "payments:prepare", "payments:approve"] }, fundingId, token };
}

test("attested source refund closure is audited and idempotent, preserves USDC and prevents public polling resurrection", async () => {
  const { access, fundingId, token } = fixture();
  let current = structuredClone(provider);
  const service = createFundingRefundService({ status: async () => current, tokens: async () => [], verify: verifySourceRefund });
  const review = await service.prepare(access, fundingId, { transactionHash: refundHash });
  assert.equal(review.requiresAttestation, true);
  await assert.rejects(() => service.confirm(access, fundingId, { reviewId: review.reviewId, reviewToken: review.reviewToken, acknowledged: true }), code("FUNDING_REFUND_ATTESTATION_REQUIRED"));
  current = { ...current, status: "PROCESSING" };
  await assert.rejects(() => service.confirm(access, fundingId, { reviewId: review.reviewId, reviewToken: review.reviewToken, acknowledged: true, evidence: "I verified the source wallet refund." }), code("FUNDING_REFUND_NOT_TERMINAL"));
  current = structuredClone(provider);
  const result = await service.confirm(access, fundingId, { reviewId: review.reviewId, reviewToken: review.reviewToken, acknowledged: true, evidence: "I verified the exact BTC refund at the original source address." });
  assert.equal(result.closure.provenance, "funder_or_reporter_attestation");
  assert.equal(result.companyUsdcCredited, "0");
  assert.equal(row<{ status: string }>("SELECT status FROM funding_legs WHERE id=?", fundingId)?.status, "refunded_attested");
  assert.equal((await service.confirm(access, fundingId, { reviewId: review.reviewId, reviewToken: review.reviewToken, acknowledged: true })).alreadyClosed, true);
  assert.deepEqual({ ...row<{ balance: string; reserved: string }>("SELECT balance,reserved FROM treasury_balances WHERE organization_id=?", access.organizationId) }, { balance: "9000000", reserved: "1000000" });
  assert.equal(listFundingRefunds(access).funding[0].closure?.provenance, "funder_or_reporter_attestation");
  const csv = fundingRefundExport({ ...access, permissions: [...access.permissions, "reports:read"] });
  assert(csv.includes('"0.00099"'));
  assert(csv.includes('"funder_or_reporter_attestation"'));
  assert(csv.includes('"1000"'));
  assert.throws(() => listFundingRefunds({ ...access, permissions: ["company:read"] }), code("FORBIDDEN"));
  const publicResult = await reconcilePublicFunding(token, { fundingId });
  assert.equal(publicResult.funding.status, "refunded_attested");
  assert.equal(getPublicFundingRequest(token).status, "open");
  const resumed = await resumePublicQuote(token, "saved-quote-key-12345");
  assert.equal(resumed.depositAllowed, false);
  assert.equal(row<{ status: string }>("SELECT status FROM funding_legs WHERE id=?", fundingId)?.status, "refunded_attested");
});

test("public linked-obligation requests block new deposits after full, cancelled or partial settlement", async () => {
  const { access, fundingId, token } = fixture(), paymentId = randomUUID(), now = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES(?,?,?,'payment',?,'1000000','0','approved_unfunded',1,'{}',?,?)").run(paymentId, access.organizationId, randomUUID(), paymentId, now, now);
  db.prepare("UPDATE funding_requests SET payment_id=? WHERE organization_id=?").run(paymentId, access.organizationId);
  for (const status of ["paid", "cancelled", "partially_paid"]) {
    db.prepare("UPDATE payments SET status=? WHERE id=?").run(status, paymentId);
    assert.equal(getPublicFundingRequest(token).status, "payment_closed");
    assert.equal(getPublicFundingRequest(token).remainingAmount, "1000000");
    const resumed = await resumePublicQuote(token, "saved-quote-key-12345");
    assert.equal(resumed.depositAllowed, false);
    assert.equal(resumed.funding.source_tx_hash, sourceHash);
    assert.equal(resumed.funding.id, fundingId);
    await assert.rejects(() => getPublicAssets(token), code("FUNDING_REQUEST_CLOSED"));
    await assert.rejects(() => createFundingRequest({ ...access, permissions: [...access.permissions, "company:manage"] }, { paymentId, amount: "1000000", purpose: "Linked obligation", expiresAt: new Date(Date.now() + 3600_000).toISOString() }), code("PAYMENT_NOT_FOUND"));
  }
});

test("refund review rejects another company, unauthorized reporter and changed or replayed refund evidence", async () => {
  const { access, fundingId } = fixture();
  const service = createFundingRefundService({ status: async () => structuredClone(provider), tokens: async () => [source], verify: verifySourceRefund });
  await assert.rejects(() => service.prepare({ ...access, organizationId: randomUUID() }, fundingId, { transactionHash: refundHash }), code("FUNDING_NOT_FOUND"));
  await assert.rejects(() => service.prepare({ ...access, permissions: ["company:read", "payments:read", "payments:prepare"] }, fundingId, { transactionHash: refundHash }), code("FUNDING_REFUND_AUTHORITY_REQUIRED"));
  const review = await service.prepare(access, fundingId, { transactionHash: refundHash });
  getDb().prepare("UPDATE funding_legs SET quote=? WHERE id=?").run(JSON.stringify({ ...quote, correlationId: "changed" }), fundingId);
  await assert.rejects(() => service.confirm(access, fundingId, { reviewId: review.reviewId, reviewToken: review.reviewToken, acknowledged: true, evidence: "The source refund was received." }), code("FUNDING_REFUND_QUOTE_MISMATCH"));
  getDb().prepare("UPDATE funding_legs SET quote=? WHERE id=?").run(leg.quote, fundingId);
  const prior = fixture();
  getDb().prepare("INSERT OR IGNORE INTO funding_refund_events(event_key,funding_id,created_at) VALUES(?,?,?)").run(review.proof.eventKeys[0], prior.fundingId, new Date().toISOString());
  await assert.rejects(() => service.confirm(access, fundingId, { reviewId: review.reviewId, reviewToken: review.reviewToken, acknowledged: true, evidence: "The source refund was received." }), code("FUNDING_REFUND_RECEIPT_REPLAYED"));
  assert.equal(row<{ status: string }>("SELECT status FROM funding_legs WHERE id=?", fundingId)?.status, "recovery_pending");
});

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DIRECT_USDC_ASSET, DIRECT_USDC_TOKEN, isDirectFunding, validateDirectFunding } from "../src/lib/direct-funding";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { PERMISSIONS } from "../src/server/identity/session";
import { deriveSharedCompanyId, type FinalTransaction, type SharedDepositCredit } from "../src/server/payments/near";
import { createDirectFunding, fundingAssetCatalog } from "../src/server/payments/direct-funding";
import { inspectDirectReturn } from "../src/server/payments/direct-return";
import { claimCompanyFunding, claimPublicFunding, createFundingRequest, preparePublicQuote, reconcilePublicFunding } from "../src/server/funding-requests/service";
import { approvePayment, createPayment, getTreasury, prepareFunding, reconcileFunding } from "../src/server/payments/service";
import { claimTaskDeposit, paymentFundingTask, quotePaymentFunding, reconcileTaskFunding } from "../src/server/payment-funding/service";
import { getFundingReceipt, verifyFundingCredit } from "../src/server/reconciliation/funding";
import { validateFundingQuote } from "../src/components/auth/funding-wallet";
import { fundingRefundService } from "../src/server/funding-refunds/service";
import type { FundingLeg, TreasuryConfig } from "../src/server/payments/types";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEAR_TREASURY_CODE_HASH = "11111111111111111111111111111111";
const originalFetch = globalThis.fetch;
const chain = new Map<string, FinalTransaction>();
const credits = new Map<string, SharedDepositCredit>();
const onchainBalances = new Map<string, string>();
let providerRequests = 0;
const log = (standard: string, event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard, event, data: [data] })}`;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("chaindefuser.com")) { providerRequests++; throw new Error("Routing deliberately unavailable"); }
  const request = JSON.parse(String(init?.body));
  if (request.method === "EXPERIMENTAL_tx_status") {
    const tx = chain.get(request.params.tx_hash);
    return tx ? Response.json({ result: tx }) : Response.json({ error: { cause: { name: "UNKNOWN_TRANSACTION" } } });
  }
  assert.equal(request.method, "query", "Only mocked read-only calls permitted");
  if (request.params.request_type === "view_account") return Response.json({ result: { code_hash: process.env.NEAR_TREASURY_CODE_HASH } });
  const args = JSON.parse(Buffer.from(request.params.args_base64, "base64").toString());
  const config = args.company_id ? row<TreasuryConfig>("SELECT * FROM treasury_config WHERE company_id=?", args.company_id) : null;
  let value: unknown;
  if (request.params.method_name === "storage_balance_of") value = { total: "1" };
  else if (request.params.method_name === "get_config") value = { owner_id: `${config!.organization_id}.near`, token_contract: DIRECT_USDC_TOKEN.contractAddress, paused: false };
  else if (request.params.method_name === "get_deposit") value = credits.get(args.credit_id) ?? null;
  else if (request.params.method_name === "get_balance") { const balance = onchainBalances.get(args.company_id) ?? "0"; value = { balance, reserved: "0", available: balance, in_flight: "0", confirmed_at_ms: String(Date.now()) }; }
  else throw new Error(`Unexpected RPC ${request.params.method_name}`);
  return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
};
after(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const id = randomUUID(), at = new Date().toISOString(), role = randomUUID(), owner = `${id}.near`, recipientId = randomUUID();
  const db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Owner", at);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Direct company", id, at, at);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(role, id, "Owner", JSON.stringify(PERMISSIONS), at);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id, id, role, at);
  db.prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'mainnet',?)").run(randomUUID(), id, owner, at);
  const config = { organization_id: id, near_account_id: "shared.near", network: "mainnet", token_contract: DIRECT_USDC_TOKEN.contractAddress!, architecture: "shared_v1", company_id: deriveSharedCompanyId(id, owner) } satisfies TreasuryConfig;
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,architecture,company_id,created_at) VALUES(?,?,?,?,?,?,?)").run(id, config.near_account_id, config.network, config.token_contract, config.architecture, config.company_id, at);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,'0','0','0',?)").run(id, at);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'vendor','USDC','near',?,'confirmed',?,?,?)").run(recipientId, id, "Supplier", `supplier-${id.slice(0, 8)}.near`, at, at, at);
  const access: AccessContext = { userId: id, organizationId: id, permissions: [...PERMISSIONS] };
  return { access, config, owner, recipientId };
}
async function topup(value = "1000000") {
  const f = fixture();
  const funding = await prepareFunding(f.access, { originAsset: DIRECT_USDC_ASSET, amount: value, refundAddress: f.owner, reference: randomUUID() });
  assert.ok("id" in funding);
  return { ...f, funding: funding as FundingLeg };
}
function transfer(funding: FundingLeg, config: TreasuryConfig, returned = false) {
  const instructions = JSON.parse(funding.quote);
  const source = instructions.quoteRequest.refundTo, hash = `source-${randomUUID()}`, tokenReceipt = `token-${randomUUID()}`, callback = `callback-${randomUUID()}`, resolver = `resolve-${randomUUID()}`;
  const credit: SharedDepositCredit = { credit_id: String(credits.size + 1), company_id: config.company_id!, deposit_id: funding.id, token_contract: config.token_contract, sender_id: source, amount: funding.amount_in, kind: "funding", credited_at_ms: String(Date.now()) };
  const result: FinalTransaction = { final_execution_status: "FINAL", status: { SuccessValue: Buffer.from(JSON.stringify(returned ? "0" : funding.amount_in)).toString("base64") }, transaction: { hash, signer_id: source, receiver_id: config.token_contract, actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: Buffer.from(JSON.stringify({ receiver_id: config.near_account_id, amount: funding.amount_in, msg: instructions.quoteRequest.customRecipientMsg })).toString("base64") } }] }, transaction_outcome: { outcome: { receipt_ids: [tokenReceipt] } }, receipts_outcome: [
    { id: tokenReceipt, block_hash: "block", outcome: { executor_id: config.token_contract, logs: [log("nep141", "ft_transfer", { old_owner_id: source, new_owner_id: config.near_account_id, amount: funding.amount_in })], status: { SuccessReceiptId: callback }, receipt_ids: [callback, resolver] } },
    { id: callback, block_hash: "block", outcome: { executor_id: config.near_account_id, logs: returned ? [] : [log("razor", "deposit_credited", credit)], status: returned ? { Failure: { error: "callback rejected" } } : { SuccessValue: "" }, receipt_ids: [resolver] } },
    { id: resolver, block_hash: "block", outcome: { executor_id: config.token_contract, logs: returned ? [log("nep141", "ft_transfer", { old_owner_id: config.near_account_id, new_owner_id: source, amount: funding.amount_in })] : [], status: { SuccessValue: resultValue(returned ? "0" : funding.amount_in) }, receipt_ids: [] } },
  ] };
  chain.set(hash, result);
  if (!returned) { credits.set(credit.credit_id, credit); onchainBalances.set(config.company_id!, funding.amount_in); }
  return { hash, result, credit };
}
function resultValue(value: string) { return Buffer.from(JSON.stringify(value)).toString("base64"); }

test("direct instructions contain no provider signature and reject coerced identities, amounts and dry flags", () => {
  const { config, owner } = fixture();
  const value = createDirectFunding(config, randomUUID(), { amount: "1000000", refundTo: owner, deadline: new Date(Date.now() + 60000).toISOString(), dry: false, swapType: "EXACT_INPUT" });
  assert.equal(isDirectFunding(value), true);
  assert.equal("signature" in value, false);
  assert.equal(value.quote.amountIn, value.quote.amountOut);
  for (const changed of [{ ...value, companyId: 3 }, { ...value, fundingId: 3 }, { ...value, quoteRequest: { ...value.quoteRequest, dry: "false" } }, { ...value, quoteRequest: { ...value.quoteRequest, amount: 1000000 } }, { ...value, network: "testnet" }, { ...value, quoteRequest: { ...value.quoteRequest, amount: String(1n << 128n) } }]) assert.throws(() => validateDirectFunding(changed as never));
  assert.throws(() => validateDirectFunding({ ...value, companyId: deriveSharedCompanyId("other", owner) }));
});

test("company funding and the wallet claim work without any routing call and preserve a pre-sign fence", async () => {
  const before = providerRequests, { access, funding } = await topup();
  assert.equal(providerRequests, before);
  assert.equal(funding.deposit_address, "shared.near");
  await claimCompanyFunding(access, funding.id);
  assert.equal(row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", funding.id)!.status, "source_unknown");
  await assert.rejects(() => claimCompanyFunding(access, funding.id), /already started or uncertain/);
  assert.equal(providerRequests, before);
  assert.equal(getTreasury(access).balance, "0");
});

test("the wallet binds the company tag and rejects mutated token metadata or a plain transfer message", async () => {
  const { funding } = await topup();
  assert.equal(validateFundingQuote(funding, DIRECT_USDC_TOKEN).quote.amountIn, funding.amount_in);
  assert.throws(() => validateFundingQuote(funding, { ...DIRECT_USDC_TOKEN, decimals: 18 }), /native USDC/);
  const changed = JSON.parse(funding.quote);
  changed.quoteRequest.customRecipientMsg = "razor:funding";
  assert.throws(() => validateFundingQuote({ ...funding, quote: changed }, DIRECT_USDC_TOKEN), /missing|match/);
  assert.throws(() => validateFundingQuote({ ...funding, id: randomUUID() }, DIRECT_USDC_TOKEN), /saved funding/);
});

test("routing catalog outage exposes only canonical direct USDC with honest availability", async () => {
  const catalog = await fundingAssetCatalog();
  assert.equal(catalog.routingCatalogAvailable, false);
  assert.deepEqual(catalog.tokens, [DIRECT_USDC_TOKEN]);
});

test("a final native receipt and immutable company credit confirm a direct deposit without provider success", async () => {
  const { access, funding, config } = await topup(), before = providerRequests;
  const tx = transfer(funding, config);
  const result = await reconcileFunding(access, funding.id, tx.hash);
  assert.equal(result.funding?.status, "confirmed");
  assert.equal(result.funding?.provider_status, null);
  assert.equal(result.funding?.credited_amount, funding.amount_in);
  assert.equal(getFundingReceipt(access, funding.id).provenance, "final_near_token_receipt");
  assert.equal((await verifyFundingCredit(access, funding.id)).receipts.length, 1);
  assert.equal(providerRequests, before);
});

test("wrong company or untagged callback cannot establish direct credit or a full return", async () => {
  const { access, funding, config } = await topup();
  const tx = transfer(funding, config);
  tx.result.receipts_outcome![1].outcome.logs = [];
  await assert.rejects(() => reconcileFunding(access, funding.id, tx.hash), (error: ApiError) => error.code === "DIRECT_RETURN_UNPROVEN");
  assert.equal(row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", funding.id)!.status, "recovery_pending");
  assert.equal(getFundingReceipt(access, funding.id).receipts.length, 0);
  const other = fixture();
  await assert.rejects(() => verifyFundingCredit(other.access, funding.id), /not found/);
});

test("unknown source and a changed source signer cannot create credit or reopen deposit signing", async () => {
  const { access, funding, config, owner } = await topup();
  await claimCompanyFunding(access, funding.id);
  await assert.rejects(() => reconcileFunding(access, funding.id, "unseen-source-hash"));
  await assert.rejects(() => claimCompanyFunding(access, funding.id), /already started or uncertain/);
  const tx = transfer(funding, config);
  await assert.rejects(() => verifyFundingCredit(access, funding.id, { transactionHash: tx.hash, senderAccountId: `other-${owner}` }), /original direct-deposit|selected source/);
  assert.equal(getFundingReceipt(access, funding.id).receipts.length, 0);
});

test("full native callback return closes original source units and never credits company cash", async () => {
  const { access, funding, config } = await topup();
  const tx = transfer(funding, config, true), before = providerRequests;
  const result = await reconcileFunding(access, funding.id, tx.hash);
  assert.equal(result.funding?.status, "refunded_verified");
  assert.equal(result.funding?.credited_amount, "0");
  assert.equal(getTreasury(access).balance, "0");
  const proof = getFundingReceipt(access, funding.id);
  assert.equal(proof.provenance, "final_near_unused_token_return");
  assert.equal(proof.returnEvidence.transactionHash, tx.hash);
  assert.equal(proof.receipts.length, 0);
  assert.equal(providerRequests, before);
});

test("partial, disconnected or differently tagged native returns stay unproven", async () => {
  const { funding, config } = await topup();
  const tx = transfer(funding, config, true), instructions = JSON.parse(funding.quote);
  assert.equal(inspectDirectReturn(tx.result, instructions, tx.hash).companyCredit, "0");
  const partial = structuredClone(tx.result);
  partial.status = { SuccessValue: resultValue("1") };
  assert.throws(() => inspectDirectReturn(partial, instructions, tx.hash), /not proven/);
  const disconnected = structuredClone(tx.result);
  disconnected.transaction_outcome!.outcome.receipt_ids = [];
  assert.throws(() => inspectDirectReturn(disconnected, instructions, tx.hash), /not proven/);
  const redirected = structuredClone(tx.result);
  redirected.transaction!.actions![0].FunctionCall!.args = Buffer.from(JSON.stringify({ receiver_id: "other.near", amount: funding.amount_in, msg: instructions.quoteRequest.customRecipientMsg })).toString("base64");
  assert.throws(() => inspectDirectReturn(redirected, instructions, tx.hash), /not proven/);
});

test("public funding preserves direct terms, claims and company confirmation without provider calls", async () => {
  const { access, owner, config } = fixture();
  const created = await createFundingRequest(access, { amount: "2500000", purpose: "Project", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const key = randomUUID(), before = providerRequests;
  const prepared = await preparePublicQuote(created.link.token, { originAsset: DIRECT_USDC_ASSET, refundAddress: owner, idempotencyKey: key });
  assert.equal(JSON.parse(prepared.funding.quote).kind, "direct_near_usdc");
  await claimPublicFunding(created.link.token, { fundingId: prepared.funding.id, idempotencyKey: key });
  const funding = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", prepared.funding.id)!;
  const tx = transfer(funding, config);
  const tracked = await reconcilePublicFunding(created.link.token, { fundingId: funding.id, idempotencyKey: key, sourceTxHash: tx.hash });
  assert.equal(tracked.confirmationRequired, true);
  assert.equal(tracked.request.confirmedAmount, "0");
  await verifyFundingCredit(access, funding.id, { transactionHash: tx.hash });
  const confirmed = await reconcilePublicFunding(created.link.token, { fundingId: funding.id });
  assert.equal(confirmed.request.status, "fulfilled");
  assert.equal(confirmed.request.confirmedAmount, "2500000");
  assert.equal(providerRequests, before);
});

test("a public funding link independently verifies full native return without granting company credit", async () => {
  const { access, owner, config } = fixture();
  const created = await createFundingRequest(access, { amount: "2500000", purpose: "Project", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const key = randomUUID();
  const prepared = await preparePublicQuote(created.link.token, { originAsset: DIRECT_USDC_ASSET, refundAddress: owner, idempotencyKey: key });
  await claimPublicFunding(created.link.token, { fundingId: prepared.funding.id, idempotencyKey: key });
  const funding = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", prepared.funding.id)!;
  const tx = transfer(funding, config, true);
  const returned = await reconcilePublicFunding(created.link.token, { fundingId: funding.id, idempotencyKey: key, sourceTxHash: tx.hash });
  assert.equal(returned.funding.status, "refunded_verified");
  assert.equal(returned.confirmationRequired, false);
  assert.equal(returned.request.confirmedAmount, "0");
  assert.equal(getTreasury(access).balance, "0");
});

test("approved obligation funding quotes only the shortfall through native USDC and resumes exact reservations", async () => {
  const { access, owner, recipientId, config } = fixture();
  const payment = createPayment(access, { recipientId, reference: randomUUID(), amount: "1000000", maxFee: "100000" });
  approvePayment(access, payment.id);
  const task = paymentFundingTask(access, payment.id), before = providerRequests;
  const prepared = await quotePaymentFunding(access, payment.id, { idempotencyKey: randomUUID(), reviewToken: task.reviewToken, originAsset: DIRECT_USDC_ASSET, refundAddress: owner });
  assert.equal(prepared.funding!.amount_in, "1100000");
  assert.equal(isDirectFunding(JSON.parse(prepared.funding!.quote)), true);
  await claimTaskDeposit(access, payment.id, prepared.funding!.id);
  const tx = transfer(prepared.funding!, config);
  const resumed = await reconcileTaskFunding(access, payment.id, { fundingId: prepared.funding!.id, sourceTxHash: tx.hash });
  assert.equal(resumed.stage, "ready_for_payout");
  assert.equal(resumed.payment.reserved_amount, "1100000");
  assert.equal(providerRequests, before);
});

test("direct funding never enters routing-provider refund verification", async () => {
  const { access, funding } = await topup(), before = providerRequests;
  await assert.rejects(() => fundingRefundService.prepare(access, funding.id, { transactionHash: "not-a-provider-refund" }), (error: ApiError) => error.code === "DIRECT_FUNDING_RECONCILIATION_REQUIRED");
  assert.equal(providerRequests, before);
});

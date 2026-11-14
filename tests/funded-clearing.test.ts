import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { base58 } from "@scure/base";
import { ApiError } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { PERMISSIONS, getAccess } from "../src/server/identity/session";
import { createBill, approveBill } from "../src/server/business/service";
import { createRound, offerInvoice, acceptInvoice, previewRound, overview, roundDetail } from "../src/server/clearing/service";
import { monitorFundedRounds, beginFundedAction, cancelFundedReview, createFundedRound, discardFundedProposal, finishFundedWallet, fundedRoundDetail, prepareFundedAction, previewFundedRound, reconcileFundedRound, verifyFundedDeposit } from "../src/server/clearing/funded";
import { fundedBillDischarges, fundedClearingExportRows } from "../src/server/clearing/funded-accounting";
import { fundingMessage } from "../src/server/clearing/funded-receipts";
import type { CashDeposit, CashState, ChainRound, Manifest } from "../src/server/clearing/types";

process.env.DATABASE_PATH = ":memory:"; process.env.DATA_ENCRYPTION_KEY = "97".repeat(32);
process.env.NEAR_NETWORK = "testnet"; process.env.NEAR_CLEARING_ID = "clearing.testnet"; process.env.NEAR_TREASURY_ID = "treasury.testnet";
const codeHash = base58.encode(new Uint8Array(32).fill(8)); process.env.NEAR_CLEARING_CODE_HASH = codeHash; process.env.NEAR_TREASURY_CODE_HASH = codeHash;
const code = (wanted: string) => (error: unknown) => error instanceof ApiError && error.code === wanted;
const companies = new Map<string, { owner: string; company: string }>();
function company() {
  const id = randomUUID(), user = randomUUID(), role = randomUUID(), stamp = new Date().toISOString(), owner = `owner-${user.slice(0, 8)}.testnet`, company = `${id}:aaaaaaaaaaaaaaaa`, db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(user, "Company owner", stamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Company", user, stamp, stamp);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(role, id, "Owner", JSON.stringify(PERMISSIONS), stamp);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?,'active',?)").run(id, user, role, stamp);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,architecture,company_id,created_at) VALUES(?,'treasury.testnet','testnet','usdc.testnet','shared_v1',?,?)").run(id, company, stamp);
  db.prepare("INSERT INTO clearing_companies(organization_id,owner_user_id,treasury_id,owner_account_id,policy_version,network,token_contract,created_at,updated_at) VALUES(?,?,'treasury.testnet',?,'1','testnet','usdc.testnet',?,?)").run(id, user, owner, stamp, stamp);
  db.prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'testnet',?)").run(randomUUID(), user, owner, stamp);
  companies.set(id, { owner, company }); return { access: getAccess(user, id), owner, company, role };
}
function fixture(equal = false, oneDirection = false) {
  const a = company(), b = company(), startsAt = new Date(Date.now() - 60000).toISOString(), expiresAt = new Date(Date.now() + 3600000).toISOString();
  const invoices = [[a, b, "100000000"], [oneDirection ? a : b, oneDirection ? b : a, equal ? "100000000" : "70000000"]] as const;
  const bills = invoices.map(([debtor, creditor, amount]) => {
    const recipientId = randomUUID(), stamp = new Date().toISOString();
    getDb().prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'business','USDC','near',?,'confirmed',?,?,?)").run(recipientId, debtor.access.organizationId, creditor.access.userId, encrypt("Confirmed company"), creditor.owner, stamp, stamp, stamp);
    return createBill(debtor.access, { recipientId, reference: randomUUID(), title: "Accepted company services", amount, maxFee: "1000000" });
  });
  const links = bills.map((bill, index) => { const [debtor, creditor] = invoices[index], link = offerInvoice(debtor.access, { billId: bill.id, creditorId: creditor.access.organizationId, startsAt, expiresAt }); acceptInvoice(creditor.access, link.id, link.terms_hash); return link; });
  const input = { linkIds: links.map(link => link.id), startsAt, expiresAt };
  return { a, b, bills, links, input };
}
function proposed(f: ReturnType<typeof fixture>) { const preview = previewFundedRound(f.a.access, f.input); return createFundedRound(f.a.access, { ...f.input, reviewToken: preview.reviewToken }); }
function ready(round: ReturnType<typeof proposed>): ChainRound {
  const cash: CashState = { stage: "funding", deposits: [], accounts: round.manifest.cash!.positions.map(party => ({ ...party, deposited: "0", credit_available: "0", credit_paid: "0", refund_available: "0", refund_paid: "0", nonce: "0", pending: null, last_transfer: null })) };
  return { manifest: round.manifest, manifest_json: round.manifest_json, hash: round.manifest_hash, status: "ready", consents: [], finalized_at_ms: null, finalized_height: null, cash };
}
interface Remote { round: ChainRound | null; height: number; time: number; enabled?: boolean; tokenStorage?: boolean; ownerStorage?: boolean; sourceBusy?: boolean; transactions: Map<string, unknown>; beforeReply?: (method: string | undefined) => Promise<void> }
async function rpc<T>(remote: Remote, action: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), params = request.params, method = params?.method_name; let result: unknown;
    if (request.method === "status") result = { chain_id: "testnet" };
    else if (request.method === "block") result = { header: { hash: `block-${params.block_id ?? remote.height}`, height: params.block_id ?? remote.height, timestamp_nanosec: String(BigInt(remote.time) * 1000000n) } };
    else if (request.method === "EXPERIMENTAL_tx_status") result = remote.transactions.get(params.tx_hash);
    else if (params.request_type === "view_account") result = { code_hash: codeHash };
    else {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString()); let value: unknown = null;
      if (method === "get_round") value = remote.round;
      else if (method === "get_cash_deposit") value = remote.round?.cash?.deposits.find(deposit => deposit.company_id === args.company_id && deposit.deposit_id === args.deposit_id) ?? null;
      else if (method === "get_config" && params.account_id === "clearing.testnet") value = { treasury_id: "treasury.testnet", token_contract: "usdc.testnet", paused: false, state_version: 2, cash_network: remote.enabled === false ? null : "testnet", max_cash_deposits_per_company: 8 };
      else if (method === "get_platform_config") value = { architecture: "shared_v1", token_contract: "usdc.testnet" };
      else if (method === "get_config") { const party = [...companies.values()].find(party => party.company === args.company_id)!; value = { architecture: "shared_v1", company_id: party.company, owner_id: party.owner, token_contract: "usdc.testnet", paused: false, policy_version: "1" }; }
      else if (method === "get_payment" || method === "get_obligation") value = remote.sourceBusy ? { unresolved: true } : null;
      else if (method === "registration_cost") value = "10000000000000000000000";
      else if (method === "storage_balance_of") value = (args.account_id === "clearing.testnet" ? remote.tokenStorage : remote.ownerStorage) === false ? null : { total: "1250000000000000000000" };
      else if (method === "storage_balance_bounds") value = { min: "1250000000000000000000" };
      else if (method === "ft_balance_of") value = "1000000000";
      result = { result: [...Buffer.from(JSON.stringify(value))] };
    }
    const body = JSON.stringify({ result }); await remote.beforeReply?.(method); return new Response(body, { headers: { "content-type": "application/json" } });
  };
  try { return await action(); } finally { globalThis.fetch = original; }
}
function remote(round: ChainRound | null = null): Remote { return { round, height: 200, time: Date.now(), transactions: new Map() }; }
function accepted(round: ChainRound, companyId: string, depositId: string, amount: string, height: number, at: number) {
  const mine = round.cash!.accounts.find(account => account.company_id === companyId)!;
  const deposit: CashDeposit = { deposit_id: depositId, company_id: companyId, sender_id: mine.destination, submitted: amount, accepted: amount, unused: "0", accepted_at_ms: String(at), accepted_height: String(height) };
  mine.deposited = (BigInt(mine.deposited) + BigInt(amount)).toString(); round.cash!.deposits.push(deposit); return deposit;
}
function receipt(manifest: Manifest, hash: string, transactionHash: string, deposit: CashDeposit) {
  return { final_execution_status: "FINAL", status: { SuccessValue: Buffer.from(JSON.stringify(deposit.accepted)).toString("base64") }, transaction: { hash: transactionHash, signer_id: deposit.sender_id, receiver_id: "usdc.testnet", actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: Buffer.from(JSON.stringify({ receiver_id: "clearing.testnet", amount: deposit.submitted, msg: fundingMessage(manifest.id, hash, deposit.company_id, deposit.deposit_id) })).toString("base64") } }] }, transaction_outcome: { outcome: { receipt_ids: ["token-receipt"] } }, receipts_outcome: [
    { id: "token-receipt", block_hash: "token-block", outcome: { executor_id: "usdc.testnet", status: { SuccessReceiptId: "accept-receipt" }, receipt_ids: ["accept-receipt"], logs: [`EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer", data: [{ old_owner_id: deposit.sender_id, new_owner_id: "clearing.testnet", amount: deposit.submitted }] })}`] } },
    { id: "accept-receipt", block_hash: "accepted-block", outcome: { executor_id: "clearing.testnet", status: { SuccessValue: "" }, logs: [`EVENT_JSON:${JSON.stringify({ standard: "razor-clearing", version: "2.0.0", event: "cash_deposit_accepted", data: [{ round_id: manifest.id, manifest_hash: hash, ...deposit }] })}`] } },
  ] };
}

test("cash-backed preview preserves original nets and uses the same obligation locks as unchanged legacy mode", () => {
  const f = fixture(), preview = previewFundedRound(f.a.access, f.input), legacy = previewRound(f.a.access, f.input);
  assert.equal(preview.totalEscrowRequired, "30000000"); assert.equal(preview.fullObligationValue, "170000000"); assert.equal(legacy.dischargedInvoiceValue, "140000000"); assert.ok(!("cash" in legacy.reviewed));
  assert.equal(preview.positions.find(position => position.company_id === f.a.access.organizationId)!.deposit_due, "30000000");
  const round = createFundedRound(f.a.access, { ...f.input, reviewToken: preview.reviewToken });
  assert.throws(() => approveBill(f.a.access, f.bills[0].id), code("CLEARING_ROUND_LOCKED"));
  assert.throws(() => createRound(f.a.access, { ...f.input, reviewToken: legacy.reviewToken }), /already uses/);
  assert.equal(overview(f.a.access).rounds.length, 0); assert.throws(() => roundDetail(f.a.access, round.id), /not found/);
  const balanced = fixture(true); assert.throws(() => previewFundedRound(balanced.a.access, balanced.input), code("FUNDED_CLEARING_NO_CASH_POSITION"));
  const acyclic = fixture(false, true); assert.equal(previewFundedRound(acyclic.a.access, acyclic.input).totalEscrowRequired, "170000000"); assert.throws(() => previewRound(acyclic.a.access, acyclic.input), code("CLEARING_NO_CYCLE"));
  assert.throws(() => fundedRoundDetail(company().access, round.id), code("FUNDED_CLEARING_NOT_FOUND"));
});

test("pre-sign funding generations are one-use, exact identity retries stay fenced and source uncertainty blocks preparation", async () => {
  const f = fixture(), round = proposed(f), state = remote(ready(round)); state.round!.consents = round.manifest.participants.map(party => party.company_id);
  await rpc(state, async () => {
    state.enabled = false; await assert.rejects(() => prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "fund" }), code("FUNDED_CLEARING_SETUP_REQUIRED")); state.enabled = true;
    state.sourceBusy = true; await assert.rejects(() => prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "fund" }), code("FUNDED_CLEARING_ORIGINAL_SOURCE_BUSY")); state.sourceBusy = false;
    const first = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "fund", amount: "30000000" }); assert.ok(first.requestId && first.reviewGeneration && first.reviewHash);
    const begin = { requestId: first.requestId, reviewGeneration: first.reviewGeneration, reviewHash: first.reviewHash, signerAccount: f.a.owner };
    await beginFundedAction(f.a.access, round.id, begin); await assert.rejects(() => beginFundedAction(f.a.access, round.id, begin), code("FUNDED_CLEARING_REVIEW_STALE"));
    await assert.rejects(() => prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "fund" }), code("FUNDED_CLEARING_WALLET_BUSY"));
    finishFundedWallet(f.a.access, round.id, first.requestId!, first.reviewGeneration!);
    const retry = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "fund", amount: "30000000" }); assert.equal(retry.requestId, first.requestId); assert.equal(retry.identityKey, first.identityKey); assert.deepEqual(retry.walletActions, first.walletActions); assert.equal(retry.retrySameRequest, true);
    await assert.rejects(() => beginFundedAction(f.a.access, round.id, { ...begin, reviewGeneration: retry.reviewGeneration, reviewHash: retry.reviewHash }), code("FUNDED_CLEARING_SAME_IDENTITY_REQUIRED"));
    await beginFundedAction(f.a.access, round.id, { ...begin, reviewGeneration: retry.reviewGeneration, reviewHash: retry.reviewHash, retrySameRequest: true });
    assert.equal(finishFundedWallet(f.a.access, round.id, first.requestId!, first.reviewGeneration!).released, false);
    assert.throws(() => cancelFundedReview(f.a.access, round.id, retry.requestId!, retry.reviewGeneration!), code("FUNDED_CLEARING_SOURCE_HELD"));
    assert.equal(rows("SELECT id FROM clearing_funded_wallet_requests WHERE round_id=? AND operation='fund' AND state='unknown'", round.id).length, 1);
  });
});

test("exact accepted funding and final consent retire whole original liabilities into separate escrow rights without residual payouts", async () => {
  const f = fixture(), round = proposed(f), state = remote(ready(round)); state.round!.consents = round.manifest.participants.map(party => party.company_id);
  await rpc(state, async () => {
    await assert.rejects(() => prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "finalize" }), code("FUNDED_CLEARING_BACKING_REQUIRED"));
    const deposit = accepted(state.round!, f.a.access.organizationId, randomUUID(), "30000000", ++state.height, state.time), txHash = "1".repeat(44);
    await reconcileFundedRound(f.a.access, round.id);
    await assert.rejects(() => prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "finalize" }), code("FUNDED_CLEARING_SOURCES_REQUIRED"));
    state.transactions.set(txHash, receipt(round.manifest, round.manifest_hash, txHash, deposit)); await verifyFundedDeposit(f.a.access, round.id, deposit.deposit_id, txHash);
    const finalize = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "finalize" }); assert.equal(finalize.walletActions[0].actions[0].params.methodName, "finalize_round");
    state.round!.status = "finalized"; state.round!.finalized_at_ms = String(state.time); state.round!.finalized_height = String(++state.height); state.round!.cash!.stage = "credits";
    for (const account of state.round!.cash!.accounts) account.credit_available = account.credit_due;
    const result = await reconcileFundedRound(f.a.access, round.id); assert.equal(result.status, "cleared"); await reconcileFundedRound(f.a.access, round.id);
    assert.equal(rows("SELECT id FROM payments WHERE organization_id IN (?,?)", f.a.access.organizationId, f.b.access.organizationId).length, 2);
    for (const [index, company] of [f.a, f.b].entries()) {
      const bill = row<{ funded_clearing_amount: string; setoff_amount: string; status: string; payment_id: string | null }>("SELECT * FROM bills WHERE id=?", f.bills[index].id)!;
      assert.equal(bill.funded_clearing_amount, f.bills[index].amount); assert.equal(bill.setoff_amount, "0"); assert.equal(bill.status, "cleared"); assert.equal(bill.payment_id, null);
      assert.equal(fundedBillDischarges(company.access.organizationId, f.bills[index].id).length, 1);
      assert.ok(fundedClearingExportRows(company.access.organizationId).some(record => record.record_type === "cash_backed_business_liability_discharge"));
      assert.throws(() => getDb().prepare("UPDATE payments SET status='approved' WHERE id=?").run(f.bills[index].payment_id!), /CLEARED_LIABILITY/);
    }
    assert.equal(rows("SELECT id FROM clearing_setoffs WHERE round_id=?", round.id).length, 0);
    assert.equal(rows("SELECT id FROM payments WHERE organization_id IN (?,?) AND delivered_amount!='0'", f.a.access.organizationId, f.b.access.organizationId).length, 0);
    assert.equal(rows("SELECT organization_id FROM treasury_balances WHERE organization_id IN (?,?)", f.a.access.organizationId, f.b.access.organizationId).length, 0);
    const credit = await prepareFundedAction(f.b.access, round.id, { manifestHash: round.manifest_hash, operation: "credit" }); const args = credit.walletActions[0].actions[0].params.args;
    assert.equal(credit.expectedNonce, "1"); assert.ok(args && typeof args === "object"); assert.ok(!("receiver_id" in args) && !("amount" in args));
  });
});

test("callback uncertainty never creates another withdrawal and stale observations cannot reduce custody counters", async () => {
  const f = fixture(), round = proposed(f), state = remote(ready(round)); state.round!.status = "revoked"; state.round!.cash!.stage = "refunds";
  const deposit = accepted(state.round!, f.a.access.organizationId, randomUUID(), "20000000", state.height, state.time), account = state.round!.cash!.accounts.find(account => account.company_id === deposit.company_id)!; account.refund_available = deposit.accepted;
  await rpc(state, async () => {
    await reconcileFundedRound(f.a.access, round.id); const first = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "refund" });
    await beginFundedAction(f.a.access, round.id, { requestId: first.requestId, reviewGeneration: first.reviewGeneration, reviewHash: first.reviewHash, signerAccount: f.a.owner }); finishFundedWallet(f.a.access, round.id, first.requestId!, first.reviewGeneration!);
    account.nonce = "1"; account.refund_available = "0"; account.pending = { kind: "refund", nonce: "1", amount: deposit.accepted, receiver: f.a.owner }; state.height++;
    await assert.rejects(() => prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "refund" }), code("FUNDED_CLEARING_WITHDRAWAL_PENDING"));
    account.pending = null; account.refund_available = deposit.accepted; account.last_transfer = { kind: "refund", nonce: "1", amount: deposit.accepted, status: "failed" }; state.height++;
    const fresh = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "refund" }); assert.equal(fresh.expectedNonce, "2"); assert.notEqual(fresh.identityKey, first.identityKey);
    state.height--; account.pending = { kind: "refund", nonce: "1", amount: deposit.accepted, receiver: f.a.owner }; account.refund_available = "0"; account.last_transfer = null;
    await assert.rejects(() => reconcileFundedRound(f.a.access, round.id), code("FUNDED_CLEARING_OBSERVATION_STALE"));
    const stored = fundedRoundDetail(f.a.access, round.id).accounts.find(value => value.organization_id === f.a.access.organizationId)!;
    assert.equal(stored.nonce, "1"); assert.equal(stored.refund_available, deposit.accepted); assert.equal(stored.pending, null);
  });
});

test("live role revocation during RPC cannot consume a cash wallet generation", async () => {
  const f = fixture(), round = proposed(f), state = remote(ready(round)); state.round!.consents = round.manifest.participants.map(party => party.company_id);
  await rpc(state, async () => {
    const review = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "fund" }); let changed = false;
    state.beforeReply = async method => { if (method === "ft_balance_of" && !changed) { changed = true; getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(PERMISSIONS.filter(permission => permission !== "payments:approve")), f.a.role); } };
    await assert.rejects(() => beginFundedAction(f.a.access, round.id, { requestId: review.requestId, reviewGeneration: review.reviewGeneration, reviewHash: review.reviewHash, signerAccount: f.a.owner }), code("FORBIDDEN"));
    assert.equal(row<{ review_consumed: number }>("SELECT review_consumed FROM clearing_funded_wallet_requests WHERE id=?", review.requestId!)!.review_consumed, 0);
  });
});

test("fixed-owner token registration is a separate costed review before a fresh refund nonce", async () => {
  const f = fixture(), round = proposed(f), state = remote(ready(round)); state.round!.status = "revoked"; state.round!.cash!.stage = "refunds"; state.ownerStorage = false;
  const deposit = accepted(state.round!, f.a.access.organizationId, randomUUID(), "10000000", state.height, state.time), account = state.round!.cash!.accounts.find(account => account.company_id === deposit.company_id)!; account.refund_available = deposit.accepted;
  await rpc(state, async () => {
    const storage = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "refund" });
    assert.equal(storage.operation, "storage"); assert.equal(storage.walletActions.length, 1); assert.equal(storage.walletActions[0].receiverId, "usdc.testnet");
    assert.deepEqual(storage.walletActions[0].actions[0].params.args, { account_id: f.a.owner, registration_only: true });
    assert.equal(storage.costs?.attachedNearYocto, "1250000000000000000000"); assert.equal(storage.expectedNonce, null);
    await beginFundedAction(f.a.access, round.id, { requestId: storage.requestId, reviewGeneration: storage.reviewGeneration, reviewHash: storage.reviewHash, signerAccount: f.a.owner }); finishFundedWallet(f.a.access, round.id, storage.requestId!, storage.reviewGeneration!);
    state.ownerStorage = true;
    const refund = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "refund" });
    assert.equal(refund.operation, "refund"); assert.equal(refund.expectedNonce, "1"); assert.equal(refund.walletActions[0].receiverId, "clearing.testnet");
    assert.equal(row<{ state: string }>("SELECT state FROM clearing_funded_wallet_requests WHERE id=?", storage.requestId!)!.state, "resolved");
  });
});

test("unsigned local proposals discard for free while started registration keeps its permanent source fence", async () => {
  const f = fixture(), round = proposed(f), state = remote();
  await rpc(state, async () => {
    const review = await prepareFundedAction(f.a.access, round.id, { manifestHash: round.manifest_hash, operation: "register" });
    const original = process.env.NEAR_CLEARING_ID; delete process.env.NEAR_CLEARING_ID;
    try { const discarded = discardFundedProposal(f.a.access, round.id); assert.equal(discarded.localDiscarded, true); assert.equal(discarded.onchainTransactionRequired, false); assert.equal(discarded.status, "revoked"); }
    finally { process.env.NEAR_CLEARING_ID = original; }
    await assert.rejects(() => beginFundedAction(f.a.access, round.id, { requestId: review.requestId, reviewGeneration: review.reviewGeneration, reviewHash: review.reviewHash, signerAccount: f.a.owner }), code("FUNDED_CLEARING_ROUND_CLOSED"));
    assert.ok(previewFundedRound(f.a.access, f.input).reviewToken);
    const pending = proposed(f), registration = await prepareFundedAction(f.a.access, pending.id, { manifestHash: pending.manifest_hash, operation: "register" });
    await beginFundedAction(f.a.access, pending.id, { requestId: registration.requestId, reviewGeneration: registration.reviewGeneration, reviewHash: registration.reviewHash, signerAccount: f.a.owner });
    finishFundedWallet(f.a.access, pending.id, registration.requestId!, registration.reviewGeneration!);
    assert.throws(() => discardFundedProposal(f.a.access, pending.id), code("FUNDED_CLEARING_SOURCE_HELD"));
    assert.throws(() => approveBill(f.a.access, f.bills[0].id), code("CLEARING_ROUND_LOCKED"));
    const cancellation = await prepareFundedAction(f.a.access, pending.id, { manifestHash: pending.manifest_hash, operation: "revoke" });
    assert.deepEqual(cancellation.walletActions[0].actions.map(action => action.params.methodName), ["register_round", "revoke"]);
    assert.equal((cancellation.walletActions[0].actions[0].params.args as { manifest_json: string }).manifest_json, pending.manifest_json);
    assert.ok(BigInt(cancellation.walletActions[0].actions[0].params.deposit) > 0n); assert.equal(fundedRoundDetail(f.a.access, pending.id).status, "prepared");
  });
});

test("a deferred escrow read cannot roll back a newer definitive callback or paid counter", async () => {
  const f = fixture(), round = proposed(f), state = remote(ready(round)); state.round!.status = "revoked"; state.round!.cash!.stage = "refunds";
  const deposit = accepted(state.round!, f.a.access.organizationId, randomUUID(), "10000000", state.height, state.time), account = state.round!.cash!.accounts.find(account => account.company_id === deposit.company_id)!; account.refund_available = deposit.accepted;
  await rpc(state, async () => {
    await reconcileFundedRound(f.a.access, round.id);
    let captured!: () => void, release!: () => void, waiting = true;
    const started = new Promise<void>(resolve => { captured = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
    state.beforeReply = async method => { if (method === "get_round" && waiting) { waiting = false; captured(); await resumed; } };
    const old = reconcileFundedRound(f.a.access, round.id), rejected = assert.rejects(old, code("FUNDED_CLEARING_OBSERVATION_STALE")); await started;
    account.nonce = "1"; account.refund_available = "0"; account.refund_paid = deposit.accepted; account.last_transfer = { kind: "refund", nonce: "1", amount: deposit.accepted, status: "paid" }; state.height++;
    await reconcileFundedRound(f.a.access, round.id); release(); await rejected;
    const saved = fundedRoundDetail(f.a.access, round.id).accounts.find(account => account.organization_id === f.a.access.organizationId)!;
    assert.equal(saved.refund_paid, deposit.accepted); assert.equal(saved.refund_available, "0"); assert.equal(saved.nonce, "1"); assert.equal(saved.lastTransfer?.status, "paid");
  });
});


test("scoped funded clearing monitoring never observes or mutates another company round", async () => {
  const f = fixture(), round = proposed(f), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("An unrelated round must not request network state"); };
  try {
    assert.deepEqual(await monitorFundedRounds(2, randomUUID()), { checked: 0, held: 0 });
    assert.equal(calls, 0);
    assert.equal(row<{cash_checked_at:string|null}>("SELECT cash_checked_at FROM clearing_rounds WHERE id=?", round.id)!.cash_checked_at, null);
  } finally { globalThis.fetch = original; }
  await rpc(remote(ready(round)), async () => {
    assert.deepEqual(await monitorFundedRounds(2, f.a.access.organizationId), { checked: 1, held: 0 });
    assert.ok(row<{cash_checked_at:string|null}>("SELECT cash_checked_at FROM clearing_rounds WHERE id=?", round.id)!.cash_checked_at);
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { createPayrollRun } from "../src/server/business/service";
import { approveReviewedPayrollRun, payrollReview } from "../src/server/payment-management/service";
import { createClientReserve } from "../src/server/client-reserves/service";
import { encrypt } from "../src/server/identity/crypto";
import { getAttempt, getPayment, listAttempts, resumeAttempt } from "../src/server/payments/service";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { Token } from "../src/server/payments/intents";
import { payrollExecutionRoutes } from "../src/server/payroll-execution";
import { BATCH_LIMITS, boundedTransactions, intersectSigners } from "../src/server/payroll-execution/model";
import { beginRunBatch, cancelRunBatch, executionOverview, prepareRunBatch, reconcileRunBatch, reserveRun, type ExecutionDependencies } from "../src/server/payroll-execution/service";
import type { WalletTransaction } from "../src/server/payments/types";
import { nearBatchReceipts, type NearWalletAction } from "../src/lib/near-actions";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "42".repeat(32);
process.env.RAZOR_BILLING_MODE = "pilot";
type Plan = Awaited<ReturnType<typeof resumeAttempt>>;
const tokens: Token[] = [
  { assetId: `nep141:${NATIVE_USDC.near}`, symbol: "USDC", blockchain: "near", decimals: 6, contractAddress: NATIVE_USDC.near },
  { assetId: `nep141:base-usdc`, symbol: "USDC", blockchain: "base", decimals: 6, contractAddress: NATIVE_USDC.base },
];
function fixture(count = 2, balance = "100000000") {
  const organizationId = randomUUID(), db = getDb(), timestamp = new Date().toISOString();
  const access: AccessContext = { userId: organizationId, organizationId, permissions: ["company:read", "payments:read", "payments:prepare", "payments:approve", "payments:execute"] };
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(organizationId, timestamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(organizationId, organizationId, timestamp, timestamp);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,?,'0',?)").run(organizationId, balance, timestamp);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(organizationId, `${organizationId}.near`, NATIVE_USDC.near, timestamp);
  const recipientIds = Array.from({ length: count }, (_, index) => {
    const id = randomUUID();
    db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'employee','near',?,'confirmed',?,?,?)").run(id, organizationId, encrypt(`Employee ${index + 1}`), `employee-${index}.near`, timestamp, timestamp, timestamp);
    return id;
  });
  const run = createPayrollRun(access, { reference: randomUUID(), periodStart: "2026-11-01", periodEnd: "2026-11-30", items: recipientIds.map(recipientId => ({ recipientId, amount: "1000000", maxFee: "1000" })) });
  const approve = () => approveReviewedPayrollRun(access, run.id, payrollReview(access, run.id).reviewToken);
  const paymentIds = run.items.map(item => item.payment_id!);
  return { access, run, paymentIds, recipientIds: run.items.map(item => item.recipient_id), approve };
}

function action(paymentId: string, attemptId: string, methodName = "create_attempt", gas = "100000000000000"): WalletTransaction {
  return { receiverId: "treasury.near", actions: [{ type: "FunctionCall", params: { methodName, args: { payment_id: paymentId, attempt_id: attemptId }, gas, deposit: "0" } }] };
}
function mocks(access: AccessContext) {
  const stages = new Map<string, Plan["stage"]>(), accounts = new Map<string, string[]>(), errors = new Map<string, ApiError>(), methods = new Map<string, number>();
  const calls = { quote: 0, reconcile: 0, resume: 0 };
  let policy = "1";
  function plan(attemptId: string): Plan {
    const attempt = getAttempt(access, attemptId), stage = stages.get(attempt.payment_id) ?? "prepare", eligible = accounts.get(attempt.payment_id) ?? ["owner.near"];
    const actions = Array.from({ length: methods.get(attempt.payment_id) ?? 1 }, (_, index) => action(attempt.payment_id, attemptId, stage === "execute" ? "execute_payment" : stage === "approve" ? index ? "authorize_attempt" : "approve_payment" : index ? "create_attempt" : "propose_payment"));
    const approvals = stage === "prepare" ? null : { policy_version: policy, approval_amount: "1001000", required_approvals: 1, payment_terms_hash: "a".repeat(64), payment_approvals: stage === "execute" ? ["owner.near"] : [], payment_collected: stage === "execute" ? 1 : 0, payment_ready: stage === "execute", attempt_id: attemptId, attempt_terms_hash: "b".repeat(64), attempt_approvals: stage === "execute" ? ["owner.near"] : [], attempt_collected: stage === "execute" ? 1 : 0, attempt_ready: stage === "execute", can_execute: stage === "execute" };
    return { attempt, stage, network: "mainnet", walletActions: stage === "approve" ? [] : actions, approvalActions: stage === "approve" ? actions : [], approvalAccounts: eligible, signerAccounts: eligible, approvals, message: `Next step ${stage}` };
  }
  const dependencies: ExecutionDependencies = {
    tokens: async () => tokens,
    authority: async () => ({ policyVersion: policy, paused: false, signerAccounts: ["owner.near"], approvalAccounts: ["owner.near"] }),
    quote: async (_access, paymentId) => {
      calls.quote++;
      if (errors.has(paymentId)) throw errors.get(paymentId)!;
      const payment = getPayment(access, paymentId), profile = JSON.parse(payment.recipient_snapshot), id = randomUUID(), timestamp = new Date().toISOString();
      const quote = { kind: "direct", network: "near", assetId: tokens[0].assetId, recipient: profile.primary_address, amountIn: payment.amount, amountOut: payment.amount, deadline: new Date(Date.now() + 3600000).toISOString(), authorization: "NEAR treasury approval" };
      getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,destination_decimals,destination_symbol,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','prepared',?,?,'near',?,6,'USDC',?,?,?,?,?)").run(id, paymentId, access.organizationId, JSON.stringify(quote), tokens[0].assetId, profile.primary_address, payment.amount, payment.amount, profile.primary_address, timestamp, timestamp);
      getDb().prepare("UPDATE payments SET status='prepared' WHERE id=?").run(paymentId);
      return { ...plan(id), dry: false };
    },
    resume: async (_access, attemptId) => { calls.resume++; return plan(attemptId); },
    approval: async (_access, attemptId) => plan(attemptId),
    reconcile: async (_access, paymentId) => { calls.reconcile++; return { payment: getPayment(access, paymentId), attempt: listAttempts(access, paymentId).at(-1) ?? null }; },
    close: async () => { throw new ApiError(409, "Keep unknown funds in reconciliation", "PRIOR_ATTEMPT_UNRESOLVED"); },
    receipt: async () => { throw new ApiError(503, "RPC unavailable", "NEAR_UNAVAILABLE"); },
  };
  return { dependencies, stages, accounts, errors, calls, methods, setPolicy: (value: string) => { policy = value; } };
}

test("G03-01/G03-02 run overview binds approved version, entitlement, cash and actionable independent readiness", async () => {
  const f = fixture(), m = mocks(f.access);
  let overview = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.equal(overview.approvedVersion, null);
  assert.equal(overview.totalEntitlements, "2000000");
  assert.ok(overview.lines[0].blocks.some(value => value.code === "RUN_APPROVAL_REQUIRED"));
  f.approve();
  getDb().prepare("UPDATE recipients SET preference_status='pending_confirmation' WHERE id=?").run(f.recipientIds[1]);
  overview = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.ok(overview.approvedVersion?.review_hash.match(/^[a-f0-9]{64}$/));
  assert.equal(overview.lines.find(line => line.paymentId === f.paymentIds[0])?.canPrepare, true);
  assert.ok(overview.lines.find(line => line.paymentId === f.paymentIds[1])?.blocks.some(value => value.code === "RECIPIENT_CONFIRMATION_REQUIRED"));
  assert.equal(overview.maximumCosts, "2000");
  assert.equal(overview.funding.alreadyReserved, "2002000");
  assert.equal(overview.complete, false);
  await assert.rejects(executionOverview({ ...f.access, organizationId: fixture(1).access.organizationId }, f.run.id, m.dependencies), /Pay run not found/);
  await assert.rejects(executionOverview({ ...f.access, permissions: [] }, f.run.id, m.dependencies), /permission/);
});

test("G03-03 aggregate reservation is repeatable, uses linked client cash once and protects another run", () => {
  const f = fixture(2, "0"); f.approve();
  getDb().prepare("UPDATE treasury_balances SET balance='1000000' WHERE organization_id=?").run(f.access.organizationId);
  createClientReserve(f.access, { idempotencyKey: randomUUID(), amount: "1000000", purpose: "Payroll", paymentId: f.paymentIds[0] });
  getDb().prepare("UPDATE treasury_balances SET balance='2002000' WHERE organization_id=?").run(f.access.organizationId);
  reserveRun(f.access, f.run.id);
  assert.equal(getPayment(f.access, f.paymentIds[0]).reserved_amount, "1001000");
  assert.equal(getPayment(f.access, f.paymentIds[1]).reserved_amount, "1001000");
  assert.equal(row<{ reserved: string }>("SELECT reserved FROM treasury_balances WHERE organization_id=?", f.access.organizationId)?.reserved, "2002000");
  assert.equal(row<{ state: string }>("SELECT state FROM client_reserves WHERE payment_id=?", f.paymentIds[0])?.state, "allocated");
  const again = reserveRun(f.access, f.run.id);
  assert.equal(again.funding.unreserved, "0");
  assert.equal(again.funding.available, "0");
  const other = createPayrollRun(f.access, { reference: randomUUID(), periodStart: "2026-12-01", periodEnd: "2026-12-31", items: [{ recipientId: f.recipientIds[0], amount: "1", maxFee: "0" }] });
  approveReviewedPayrollRun(f.access, other.id, payrollReview(f.access, other.id).reviewToken);
  assert.equal(getPayment(f.access, other.items[0].payment_id!).status, "approved_unfunded");
  assert.equal(rows("SELECT id FROM treasury_ledger WHERE organization_id=? AND entry_type='payment_reserved'", f.access.organizationId).length, 2);
});

test("G03-03 interrupted aggregate reservation rolls back all successful intermediate reservations", () => {
  const f = fixture(2, "0"); f.approve();
  getDb().prepare("UPDATE treasury_balances SET balance='2002000' WHERE organization_id=?").run(f.access.organizationId);
  getDb().exec(`CREATE TEMP TRIGGER reject_second_reservation BEFORE UPDATE OF reserved_amount ON payments WHEN NEW.id='${f.paymentIds[1]}' AND NEW.reserved_amount!='0' BEGIN SELECT RAISE(ABORT,'test interruption'); END`);
  try { assert.throws(() => reserveRun(f.access, f.run.id), /test interruption/); } finally { getDb().exec("DROP TRIGGER reject_second_reservation"); }
  assert.equal(getPayment(f.access, f.paymentIds[0]).reserved_amount, "0");
  assert.equal(row<{ reserved: string }>("SELECT reserved FROM treasury_balances WHERE organization_id=?", f.access.organizationId)?.reserved, "0");
});

test("G03-04 gas, size, signer intersection and single transaction fallback respect bounded groups", () => {
  assert.deepEqual(intersectSigners([["alice.near", "owner.near"], ["owner.near"]]), ["owner.near"]);
  assert.deepEqual(intersectSigners([["alice.near"], ["bob.near"]]), []);
  const actions = Array.from({ length: 10 }, () => action("p", "a"));
  assert.equal(boundedTransactions(actions).transactions.length, 8);
  assert.equal(boundedTransactions(actions).remaining, 2);
  assert.equal(boundedTransactions(actions, 1).transactions.length, 1);
  assert.equal(boundedTransactions([action("p", "a", "create_attempt", BATCH_LIMITS.gasPerTransaction)]).gas, BATCH_LIMITS.gasPerTransaction);
  assert.throws(() => boundedTransactions([action("p", "a", "create_attempt", "300000000000001")]), /gas or size/);
  assert.throws(() => boundedTransactions(actions, 9), /one to eight/);
  assert.throws(() => boundedTransactions([{ ...actions[0], receiverId: "x".repeat(13000) }]), /gas or size/);
});

test("G03-07 wallet receipts bind their actual actions instead of partial outcome array positions", () => {
  const transactions = [action("payment-a", "attempt-a"), action("payment-b", "attempt-b")] as NearWalletAction[];
  const outcome = (index: number, signer = "owner.near", status: unknown = { SuccessValue: "" }) => ({ transaction: { hash: String(index + 1).repeat(44), signer_id: signer, receiver_id: transactions[index].receiverId, actions: transactions[index].actions.map(value => ({ FunctionCall: { method_name: value.params.methodName, args: Buffer.from(JSON.stringify(value.params.args)).toString("base64") } })) }, status });
  assert.deepEqual(nearBatchReceipts(transactions, "owner.near", [outcome(1)]), [{ index: 1, hash: "2".repeat(44), succeeded: true }]);
  assert.deepEqual(nearBatchReceipts(transactions, "owner.near", [outcome(1), outcome(0, "other.near")]), [{ index: 1, hash: "2".repeat(44), succeeded: true }]);
  assert.deepEqual(nearBatchReceipts(transactions, "owner.near", [outcome(0, "owner.near", { Failure: {} }), outcome(0)]), [{ index: 0, hash: "1".repeat(44), succeeded: false }]);
  assert.deepEqual(nearBatchReceipts(transactions, "owner.near", [{ transaction: { ...outcome(0).transaction, receiver_id: "wrong.near" } }]), []);
});

test("G03-04/G03-05 a blocked route and different signer do not hide ready exact actions", async () => {
  const f = fixture(3); f.approve(); const m = mocks(f.access);
  m.errors.set(f.paymentIds[1], new ApiError(422, "Unsupported destination", "PRIMARY_UNAVAILABLE"));
  m.accounts.set(f.paymentIds[2], ["another.near"]);
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: f.paymentIds.map(paymentId => ({ paymentId })) }, m.dependencies);
  assert.equal(batch.entries.length, 1);
  assert.equal(batch.transactions.length, 1);
  assert.deepEqual(batch.signerAccounts, ["owner.near"]);
  assert.deepEqual(batch.blocked.map(value => value.code), ["PRIMARY_UNAVAILABLE", "NO_COMMON_SIGNER"]);
  assert.equal(batch.entries[0].entitlement, "1000000");
  assert.equal(batch.entries[0].routeCost, "0");
  assert.ok(batch.entries[0].quoteHash.match(/^[a-f0-9]{64}$/));
  assert.equal(row<{ payload_ciphertext: string }>("SELECT payload_ciphertext FROM payroll_execution_batches WHERE id=?", batch.id)?.payload_ciphertext.startsWith("enc1:"), true);
  await assert.rejects(prepareRunBatch(f.access, f.run.id, { stage: "execute", selections: [{ paymentId: f.paymentIds[0] }] }, m.dependencies), /saved wallet group/);
  cancelRunBatch(f.access, f.run.id, batch.id);
  const resumed = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId: f.paymentIds[0] }] }, m.dependencies);
  assert.equal(resumed.entries[0].attemptId, batch.entries[0].attemptId);
  assert.equal(m.calls.quote, 3);
});

test("G03-05 signing rechecks exact stage, policy, quote and eligible account before setting a durable fence", async () => {
  const f = fixture(1); f.approve(); const m = mocks(f.access), paymentId = f.paymentIds[0];
  const initial = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }] }, m.dependencies);
  await assert.rejects(beginRunBatch(f.access, f.run.id, initial.id, { reviewHash: initial.reviewHash!, signerAccount: "wrong.near" }, m.dependencies), /signing account changed/);
  m.stages.set(paymentId, "execute");
  await assert.rejects(beginRunBatch(f.access, f.run.id, initial.id, { reviewHash: initial.reviewHash!, signerAccount: "owner.near" }, m.dependencies), /Next step execute/);
  cancelRunBatch(f.access, f.run.id, initial.id);
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "execute", selections: [{ paymentId }] }, m.dependencies);
  m.setPolicy("2");
  await assert.rejects(beginRunBatch(f.access, f.run.id, batch.id, { reviewHash: batch.reviewHash!, signerAccount: "owner.near" }, m.dependencies), /quorum changed/);
  m.setPolicy("1");
  const attempts = await Promise.allSettled([beginRunBatch(f.access, f.run.id, batch.id, { reviewHash: batch.reviewHash!, signerAccount: "owner.near" }, m.dependencies), beginRunBatch(f.access, f.run.id, batch.id, { reviewHash: batch.reviewHash!, signerAccount: "owner.near" }, m.dependencies)]);
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(row<{ status: string }>("SELECT status FROM payroll_execution_batches WHERE id=?", batch.id)?.status, "signing");
  assert.throws(() => cancelRunBatch(f.access, f.run.id, batch.id), /source may still deliver/);
});

test("G03-07 wallet rejection and partial preparation reconcile existing attempts before resuming", async () => {
  const f = fixture(1); f.approve(); const m = mocks(f.access), paymentId = f.paymentIds[0];
  m.methods.set(paymentId, 3);
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }], maximumTransactions: 1 }, m.dependencies);
  assert.equal(batch.transactions.length, 1); assert.equal(batch.remainingTransactions, 2);
  await beginRunBatch(f.access, f.run.id, batch.id, { reviewHash: batch.reviewHash!, signerAccount: "owner.near" }, m.dependencies);
  const checked = await reconcileRunBatch(f.access, f.run.id, batch.id, {}, m.dependencies);
  assert.equal(checked.batch.status, "closed"); assert.ok(m.calls.reconcile > 0);
  const next = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }], maximumTransactions: 1 }, m.dependencies);
  assert.equal(next.entries[0].attemptId, batch.entries[0].attemptId);
  assert.equal(m.calls.quote, 1);
});

test("G03-06/G03-07 unknown execution stays fenced across restart until actual attempt evidence arrives", async () => {
  const f = fixture(1); f.approve(); const m = mocks(f.access), paymentId = f.paymentIds[0];
  const prepared = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }] }, m.dependencies);
  cancelRunBatch(f.access, f.run.id, prepared.id); m.stages.set(paymentId, "execute");
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "execute", selections: [{ paymentId }] }, m.dependencies);
  await beginRunBatch(f.access, f.run.id, batch.id, { reviewHash: batch.reviewHash!, signerAccount: "owner.near" }, m.dependencies);
  const unknown = await reconcileRunBatch(f.access, f.run.id, batch.id, {}, m.dependencies);
  assert.equal(unknown.batch.status, "reconciling"); assert.equal(unknown.requiresReceipt, true);
  const afterRestart = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.equal(afterRestart.activeBatch?.id, batch.id); assert.equal(afterRestart.lines[0].state, "unknown");
  await assert.rejects(prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }] }, m.dependencies), /saved wallet group/);
  getDb().prepare("UPDATE payout_attempts SET state='submitted',source_tx_hash=? WHERE id=?").run("1".repeat(44), batch.entries[0].attemptId);
  getDb().prepare("UPDATE payments SET status='in_flight' WHERE id=?").run(paymentId);
  assert.equal((await reconcileRunBatch(f.access, f.run.id, batch.id, {}, m.dependencies)).batch.status, "closed");
  getDb().prepare("UPDATE payout_attempts SET state='delivered' WHERE id=?").run(batch.entries[0].attemptId);
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(paymentId);
  const done = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.equal(done.complete, true); assert.equal(done.lines[0].state, "delivered");
  const repeat = await prepareRunBatch(f.access, f.run.id, { stage: "execute", selections: [{ paymentId }] }, m.dependencies);
  assert.equal(repeat.transactions.length, 0); assert.equal(repeat.blocked[0].code, "ENTITLEMENT_NOT_EXECUTABLE");
});

test("G03-07 receipt hashes are durable, final action identity is verified and failed execution safely resumes", async () => {
  const f = fixture(1); f.approve(); const m = mocks(f.access), paymentId = f.paymentIds[0];
  const prepared = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }] }, m.dependencies);
  cancelRunBatch(f.access, f.run.id, prepared.id); m.stages.set(paymentId, "execute");
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "execute", selections: [{ paymentId }] }, m.dependencies);
  await beginRunBatch(f.access, f.run.id, batch.id, { reviewHash: batch.reviewHash!, signerAccount: "owner.near" }, m.dependencies);
  const hash = "1".repeat(44);
  const unavailable = await reconcileRunBatch(f.access, f.run.id, batch.id, { receipts: [{ index: 0, hash }] }, m.dependencies);
  assert.equal(unavailable.batch.receipts[0].hash, hash); assert.equal(unavailable.batch.status, "reconciling");
  await assert.rejects(reconcileRunBatch(f.access, f.run.id, batch.id, { receipts: [{ index: 0, hash: "2".repeat(44) }] }, m.dependencies), /another transaction hash/);
  m.dependencies.receipt = async () => ({ final_execution_status: "FINAL", status: { Failure: {} }, transaction: { hash, signer_id: "owner.near", receiver_id: "different.near", actions: [{ FunctionCall: { method_name: "execute_payment", gas: "100000000000000", deposit: "0", args: Buffer.from(JSON.stringify({ payment_id: paymentId, attempt_id: batch.entries[0].attemptId })).toString("base64") } }] } });
  assert.equal((await reconcileRunBatch(f.access, f.run.id, batch.id, {}, m.dependencies)).batch.status, "reconciling");
  m.dependencies.receipt = async () => ({ final_execution_status: "FINAL", status: { Failure: {} }, transaction: { hash, signer_id: "owner.near", receiver_id: "treasury.near", actions: [{ FunctionCall: { method_name: "execute_payment", gas: "100000000000000", deposit: "0", args: Buffer.from(JSON.stringify({ payment_id: paymentId, attempt_id: batch.entries[0].attemptId })).toString("base64") } }] } });
  const failed = await reconcileRunBatch(f.access, f.run.id, batch.id, {}, m.dependencies);
  assert.equal(failed.batch.status, "closed"); assert.equal(failed.batch.receipts[0].verified, true); assert.equal(failed.batch.receipts[0].failed, true);
  assert.equal(m.calls.quote, 1);
});

test("G03-02 scheduling and stale quotes show distinct next actions", async () => {
  const f = fixture(1); f.approve(); const m = mocks(f.access), paymentId = f.paymentIds[0];
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }] }, m.dependencies);
  cancelRunBatch(f.access, f.run.id, batch.id);
  const attempt = getAttempt(f.access, batch.entries[0].attemptId), quote = JSON.parse(attempt.quote);
  quote.deadline = new Date(Date.now() - 1000).toISOString();
  getDb().prepare("UPDATE payout_attempts SET quote=? WHERE id=?").run(JSON.stringify(quote), attempt.id);
  getDb().prepare("UPDATE payments SET scheduled_for=? WHERE id=?").run(new Date(Date.now() + 3600000).toISOString(), paymentId);
  const overview = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.equal(overview.lines[0].nextAction, "close");
  assert.ok(overview.lines[0].blocks.some(value => value.code === "QUOTE_EXPIRED"));
  assert.ok(overview.lines[0].blocks.some(value => value.code === "SCHEDULED"));
});

test("G03-02 route support, missing authority and changed policy are separate readiness reasons", async () => {
  const f = fixture(1); f.approve(); const m = mocks(f.access), paymentId = f.paymentIds[0];
  m.dependencies.tokens = async () => [];
  m.dependencies.authority = async () => ({ policyVersion: "2", paused: false, signerAccounts: [], approvalAccounts: [] });
  const unsupported = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.ok(unsupported.lines[0].blocks.some(value => value.code === "UNSUPPORTED_ROUTE"));
  assert.ok(unsupported.lines[0].blocks.some(value => value.code === "MISSING_AUTHORITY"));
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: [{ paymentId }] }, m.dependencies);
  cancelRunBatch(f.access, f.run.id, batch.id);
  getDb().prepare("UPDATE payout_attempts SET reconciliation=? WHERE id=?").run(JSON.stringify({ chain: { policy_version: "1", attempts: [{ id: batch.entries[0].attemptId, approval_policy_version: "1" }] } }), batch.entries[0].attemptId);
  const policy = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.ok(policy.lines[0].blocks.some(value => value.code === "POLICY_CHANGED"));
});

test("G03-06 mixed direct and Intents line projection retains independent delivery and held outcomes", async () => {
  const f = fixture(2); f.approve(); const m = mocks(f.access);
  const batch = await prepareRunBatch(f.access, f.run.id, { stage: "prepare", selections: f.paymentIds.map(paymentId => ({ paymentId })) }, m.dependencies);
  cancelRunBatch(f.access, f.run.id, batch.id);
  const direct = batch.entries.find(value => value.paymentId === f.paymentIds[0])!, intents = batch.entries.find(value => value.paymentId === f.paymentIds[1])!;
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const quote = { correlationId: "local-intents-fixture", quoteRequest: { deadline }, quote: { deadline, amountIn: "1000100", amountOut: "1000000", depositAddress: "deposit.near" } };
  getDb().prepare("UPDATE payout_attempts SET state='delivered' WHERE id=?").run(direct.attemptId);
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(direct.paymentId);
  getDb().prepare("UPDATE payout_attempts SET quote=?,destination_network='base',destination_asset=?,destination_address=?,state='unknown' WHERE id=?").run(JSON.stringify(quote), tokens[1].assetId, `0x${"ab".repeat(20)}`, intents.attemptId);
  getDb().prepare("UPDATE payments SET status='held',hold_reason='Destination evidence requires reconciliation' WHERE id=?").run(intents.paymentId);
  const overview = await executionOverview(f.access, f.run.id, m.dependencies);
  assert.equal(overview.lines.find(line => line.paymentId === direct.paymentId)?.state, "delivered");
  assert.equal(overview.lines.find(line => line.paymentId === intents.paymentId)?.nextAction, "reconcile");
  assert.equal(overview.lines.find(line => line.paymentId === intents.paymentId)?.attempt?.destination_network, "base");
  assert.equal(overview.complete, false);
  assert.equal(m.calls.quote, 2);
});

test("payroll execution routes validate scoped selections and enforce permissions", async () => {
  const f = fixture(1);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("access", { ...f.access, permissions: ["payments:read"] }); await next(); });
  app.route("/payroll/:id/execution", payrollExecutionRoutes);
  app.onError((error, c) => error instanceof ApiError ? c.json({ error: error.message }, error.status as 403) : c.json({ error: error.message }, 500));
  const response = await app.request(`/payroll/${f.run.id}/execution/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "execute", selections: [] }) });
  assert.equal(response.status, 422);
  const denied = await app.request(`/payroll/${f.run.id}/execution/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "execute", selections: [{ paymentId: f.paymentIds[0] }] }) });
  assert.equal(denied.status, 403);
});

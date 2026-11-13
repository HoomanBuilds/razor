import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkedApprovalStatus, requiredApprovals, validateApprovalTiers } from "../src/server/treasury-policy/approvals";
import type { ApprovalStatus } from "../src/server/payments/types";

const tiers = [{ up_to: "100000000", required_approvals: 1 }, { up_to: "1000000000", required_approvals: 2 }];
test("approval tiers use principal plus fee and validate inclusive boundaries", () => {
  validateApprovalTiers(tiers, "1000000000", 2);
  assert.equal(requiredApprovals(tiers, "99000000", "1000000"), 1);
  assert.equal(requiredApprovals(tiers, "100000000", "1"), 2);
  assert.throws(() => validateApprovalTiers(tiers, "1000000000", 1));
  assert.throws(() => validateApprovalTiers([], "1", 1));
  assert.throws(() => validateApprovalTiers([...tiers].reverse(), "1000000000", 2));
  assert.throws(() => validateApprovalTiers([{ up_to: "100", required_approvals: 2 }, { up_to: "1000", required_approvals: 1 }], "1000", 2));
  assert.throws(() => validateApprovalTiers(tiers, "1000000001", 2));
  assert.throws(() => requiredApprovals(tiers, "1000000000", "1"));
});

test("approval views fail closed for duplicate votes, unrelated route signers and incomplete quorum", () => {
  const status: ApprovalStatus = { policy_version: "3", approval_amount: "110", required_approvals: 2, payment_terms_hash: "a".repeat(64), payment_approvals: ["owner.near"], payment_collected: 1, payment_ready: false, attempt_id: "attempt", attempt_terms_hash: "b".repeat(64), attempt_approvals: ["owner.near"], attempt_collected: 1, attempt_ready: false, can_execute: false };
  assert.equal(checkedApprovalStatus(status, "payment", "attempt"), status);
  assert.throws(() => checkedApprovalStatus({ ...status, payment_approvals: ["owner.near", "owner.near"], payment_collected: 2, payment_ready: true }, "payment", "attempt"));
  assert.throws(() => checkedApprovalStatus({ ...status, attempt_approvals: ["attacker.near"] }, "payment", "attempt"));
  assert.throws(() => checkedApprovalStatus({ ...status, can_execute: true }, "payment", "attempt"));
  assert.throws(() => checkedApprovalStatus({ ...status, attempt_terms_hash: null }, "payment", "attempt"));
  assert.throws(() => checkedApprovalStatus(status, "payment", "different-attempt"));
});

test("wallet plans separate preparation, distinct approval and execution, including a scheduled route", async () => {
  process.env.DATABASE_PATH = ":memory:";
  const { getDb } = await import("../src/server/db");
  const { createPayment, resumeAttempt, prepareAttemptApproval, markAttemptSubmitted } = await import("../src/server/payments/service");
  const { createHash } = await import("node:crypto");
  const { NATIVE_USDC } = await import("../src/server/payments/policy");
  const access = { userId: "owner", organizationId: "company", permissions: ["company:read", "payments:prepare", "payments:read", "payments:approve", "payments:execute"] };
  const db = getDb(), now = new Date().toISOString(), asset = `nep141:${NATIVE_USDC.near}`;
  db.prepare("INSERT INTO users(id,name,created_at) VALUES('owner','Owner',?)").run(now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES('company','Company','owner',?,?)").run(now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES('recipient','company','Payee','employee',?,'near','payee.near','confirmed',?,?,?)").run(asset, now, now, now);
  db.prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES('wallet','owner','near','owner.near','mainnet',?)").run(now);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES('company','treasury.near','mainnet',?,?)").run(NATIVE_USDC.near, now);
  const payment = createPayment(access, { recipientId: "recipient", reference: "salary", amount: "1000000", maxFee: "1000" });
  db.prepare("UPDATE payments SET approved_at=?,approved_by='owner',reserved_amount='1001000',status='prepared' WHERE id=?").run(now, payment.id);
  const deadline = String(Date.now() + 3_600_000);
  const quote = JSON.stringify({ kind: "direct", network: "near", assetId: asset, recipient: "payee.near", amountIn: payment.amount, amountOut: payment.amount, deadline: new Date(Number(deadline)).toISOString(), authorization: "NEAR treasury approval" });
  db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES('attempt',?,'company','primary','prepared',?,?,'near','payee.near','1000000','1000000','payee.near',?,?)").run(payment.id, quote, asset, now, now);
  let chain: import("../src/server/payments/types").ChainPayment | null = null;
  const quorum: ApprovalStatus = { policy_version: "1", approval_amount: "1001000", required_approvals: 2, payment_terms_hash: "a".repeat(64), payment_approvals: [], payment_collected: 0, payment_ready: false, attempt_id: "attempt", attempt_terms_hash: "b".repeat(64), attempt_approvals: [], attempt_collected: 0, attempt_ready: false, can_execute: false };
  let registered = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/v0/tokens")) return Response.json([{ assetId: asset, blockchain: "near", symbol: "USDC", decimals: 6, contractAddress: NATIVE_USDC.near }]);
    const rpc = JSON.parse(init!.body as string);
    const results: Record<string, unknown> = { get_payment: chain, get_recipient: { primary: { asset_id: asset, network: "near", address: "payee.near" }, backup: null, backup_consent: false, active: true, version: "1" }, get_obligation: chain ? payment.id : null, get_config: { owner_id: "owner.near", approvers: ["finance.near"], policy_version: quorum.policy_version, paused: false }, get_approval_status: quorum, storage_balance_of: registered ? { total: "1" } : null, storage_balance_bounds: { min: "1250000000000000000000" } };
    assert.ok(rpc.params.method_name in results, `Unexpected view ${rpc.params.method_name}`);
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(results[rpc.params.method_name]))] } });
  };
  try {
    const prepared = await resumeAttempt(access, "attempt");
    assert.equal(prepared.stage, "prepare");
    assert.deepEqual(prepared.walletActions.flatMap((tx) => tx.actions.map((item) => item.params.methodName)), ["propose_payment", "storage_deposit", "create_attempt"]);
    assert.equal(prepared.walletActions[1].actions[0].params.deposit, "1250000000000000000000");
    registered = true;
    chain = { id: payment.id, recipient_id: "recipient", recipient_version: "1", reference: `razor:${payment.id}`, amount: payment.amount, max_fee: payment.max_fee, incurred_cost: "0", reservation: "1001000", expires_at_ms: String(Date.now() + 86_400_000), not_before_ms: "0", policy_version: "1", approvals: [], status: "proposed", attempts: [{ id: "attempt", authorized: false, approvals: [], approval_policy_version: "1", use_backup: false, status: "prepared", refund_amount: "0", receipt: null, route: { kind: "direct", source_receiver: "payee.near", input_amount: "1000000", output_amount: "1000000", quote_id: "direct", quote_hash: createHash("sha256").update(quote).digest("hex"), deadline_ms: deadline } }] };
    const approval = await prepareAttemptApproval({ ...access, permissions: access.permissions.filter((item) => item !== "payments:execute") }, "attempt");
    assert.equal(approval.stage, "approve");
    assert.equal(approval.walletActions.length, 0);
    assert.deepEqual(approval.approvalActions.flatMap((tx) => tx.actions.map((item) => item.params.methodName)), ["approve_payment", "authorize_attempt"]);
    await assert.rejects(() => markAttemptSubmitted(access, "attempt", "not-a-source-receipt"), /has not recorded/);
    quorum.payment_approvals = ["owner.near", "finance.near"]; quorum.payment_collected = 2; quorum.payment_ready = true;
    quorum.attempt_approvals = [...quorum.payment_approvals]; quorum.attempt_collected = 2; quorum.attempt_ready = true; quorum.can_execute = true;
    chain.status = "approved"; chain.attempts[0].authorized = true;
    const execute = await resumeAttempt(access, "attempt");
    assert.equal(execute.stage, "execute");
    assert.deepEqual(execute.walletActions.flatMap((tx) => tx.actions.map((item) => item.params.methodName)), ["execute_payment"]);
    assert.equal(execute.approvalActions.length, 0);
    const scheduled = new Date(Date.now() + 300_000).toISOString();
    db.prepare("UPDATE payments SET scheduled_for=? WHERE id=?").run(scheduled, payment.id);
    chain.not_before_ms = String(Date.parse(scheduled)); quorum.can_execute = false;
    const waiting = await resumeAttempt(access, "attempt");
    assert.equal(waiting.stage, "scheduled");
    assert.equal(waiting.walletActions.length, 0);
    chain.not_before_ms = "0";
    await assert.rejects(() => resumeAttempt(access, "attempt"), /different approved terms or schedule/);
  } finally { globalThis.fetch = original; }
});

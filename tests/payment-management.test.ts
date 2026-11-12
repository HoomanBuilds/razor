import assert from "node:assert/strict";
import { before, test } from "node:test";
import { getDb, row } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { createBill, createPayrollRun } from "../src/server/business/service";
import { setBillTerms } from "../src/server/business/bill-terms";
import { approvePayment, createPayment, getPayment } from "../src/server/payments/service";
import { adjustPayrollItem, approveBillBatch, approveReviewedPayrollRun, cancelManagedPayment, payrollReview, previewBillBatch, replaceCancelledPayment } from "../src/server/payment-management/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "22".repeat(32);
const access: AccessContext = { userId: "finance", organizationId: "org", permissions: ["company:read", "payments:read", "payments:prepare", "payments:approve", "payments:execute", "reports:read"] };
let sequence = 0;
const next = () => String(++sequence);

before(() => {
  const db = getDb(), now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES('finance','Finance',?)").run(now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES('org','Company','finance',?,?)").run(now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES('recipient','org','Employee','employee','near','employee.near','confirmed',?,?,?)").run(now, now, now);
});

function payrun() {
  return createPayrollRun(access, { reference: `run-${next()}`, periodStart: "2026-11-01", periodEnd: "2026-11-30", items: [{ recipientId: "recipient", amount: "1000000", maxFee: "1000" }] });
}

test("draft net adjustments invalidate old approval reviews and lock after approval", () => {
  const created = payrun(), review = payrollReview(access, created.id), item = review.items[0];
  const adjusted = adjustPayrollItem(access, created.id, item.id, { expectedPaymentId: item.payment.id, expectedTermsVersion: 0, baseAmount: "1000000", bonusAmount: "200000", adjustmentAmount: "-50000", maxFee: "1000", note: "Supplied bonus and net correction" });
  assert.equal(adjusted.total, "1150000");
  assert.ok(row<{ note_ciphertext: string }>("SELECT note_ciphertext FROM payroll_item_terms WHERE item_id=?", item.id)?.note_ciphertext.startsWith("enc1:"));
  assert.throws(() => approveReviewedPayrollRun(access, created.id, review.reviewToken), /changed after review/);
  assert.equal(getPayment(access, item.payment.id).status, "draft");
  approveReviewedPayrollRun(access, created.id, adjusted.reviewToken);
  assert.throws(() => adjustPayrollItem(access, created.id, item.id, { expectedPaymentId: item.payment.id, expectedTermsVersion: 1, baseAmount: "1", bonusAmount: "0", adjustmentAmount: "0", maxFee: "0", note: "" }), /never been approved/);
});

test("cancellation and explicit reprepare preserve one pay-period liability and its old immutable profile", async () => {
  const created = payrun(), initial = payrollReview(access, created.id), old = initial.items[0].payment;
  approveReviewedPayrollRun(access, created.id, initial.reviewToken);
  getDb().prepare("UPDATE payments SET total_spent='200' WHERE id=?").run(old.id);
  getDb().prepare("UPDATE recipients SET version=version+1,primary_address='updated.near' WHERE id='recipient'").run();
  assert.throws(() => approveReviewedPayrollRun(access, created.id, payrollReview(access, created.id).reviewToken), /Recipient details|Refresh unapproved/);
  const cancelled = await cancelManagedPayment(access, old.id);
  assert.equal(cancelled.cancellationConfirmed, true);
  assert.equal(cancelled.walletActions.length, 0);
  const replacement = await replaceCancelledPayment(access, old.id, "Recipient confirmed an updated receiving profile");
  assert.notEqual(replacement.payment.id, old.id);
  assert.equal(replacement.payment.amount, old.amount);
  assert.equal(replacement.payment.max_fee, "800");
  assert.equal(replacement.payment.status, "draft");
  assert.equal(JSON.parse(getPayment(access, old.id).recipient_snapshot).primary_address, "employee.near");
  assert.equal(JSON.parse(replacement.payment.recipient_snapshot).primary_address, "updated.near");
  assert.equal(row<{ total: number }>("SELECT COUNT(*) AS total FROM payroll_items WHERE run_id=?", created.id)?.total, 1);
  assert.throws(() => approvePayment(access, replacement.payment.id), /Approve the underlying pay run/);
  const repeated = await replaceCancelledPayment(access, old.id, "Retry the same request");
  assert.equal(repeated.payment.id, replacement.payment.id);
  assert.equal(repeated.alreadyPrepared, true);
  const fresh = payrollReview(access, created.id);
  assert.equal(fresh.items[0].history.length, 2);
  approveReviewedPayrollRun(access, created.id, fresh.reviewToken);
  assert.equal(getPayment(access, old.id).status, "cancelled");
});

test("paid, partial, unknown and active obligations cannot be replaced", async () => {
  for (const status of ["paid", "in_flight", "recovery_pending", "unknown"]) {
    const payment = createPayment(access, { recipientId: "recipient", reference: `blocked-${next()}`, amount: "1000000" });
    getDb().prepare("UPDATE payments SET status=? WHERE id=?").run(status, payment.id);
    await assert.rejects(replaceCancelledPayment(access, payment.id, "Attempt replacement"), /fully cancelled/);
  }
  const partial = createPayment(access, { recipientId: "recipient", reference: `partial-${next()}`, amount: "1000000" });
  getDb().prepare("UPDATE payments SET status='cancelled',delivered_amount='1' WHERE id=?").run(partial.id);
  await assert.rejects(replaceCancelledPayment(access, partial.id, "Attempt partial replacement"), /fully cancelled/);
  const active = createPayment(access, { recipientId: "recipient", reference: `active-${next()}`, amount: "1000000" }), now = new Date().toISOString();
  getDb().prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(active.id);
  getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,'org','primary','unknown','{}','USDC','near','recipient.near','1000000','1000000','deposit.near',?,?)").run(`attempt-${next()}`, active.id, now, now);
  await assert.rejects(replaceCancelledPayment(access, active.id, "Attempt active replacement"), /fully cancelled/);
});

test("batch invoice approval is all-or-none and rejects changed reviewed terms", () => {
  const first = createBill(access, { recipientId: "recipient", reference: `invoice-${next()}`, title: "First work", amount: "1000000", maxFee: "1000" });
  const second = createBill(access, { recipientId: "recipient", reference: `invoice-${next()}`, title: "Second work", amount: "1000000", maxFee: "1000" });
  getDb().prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES('org','100000000','0',?) ON CONFLICT(organization_id) DO UPDATE SET balance='100000000',reserved='0'").run(new Date().toISOString());
  getDb().prepare("UPDATE bills SET status='disputed' WHERE id=?").run(second.id);
  const ids = [first.id, second.id], review = previewBillBatch(access, ids);
  const before = row<{ reserved: string }>("SELECT reserved FROM treasury_balances WHERE organization_id='org'")!.reserved;
  assert.throws(() => approveBillBatch(access, ids, review.reviewToken), /Resolve the dispute/);
  assert.equal(getPayment(access, first.payment_id!).status, "draft");
  assert.equal(row<{ reserved: string }>("SELECT reserved FROM treasury_balances WHERE organization_id='org'")!.reserved, before);
  getDb().prepare("UPDATE bills SET status='draft' WHERE id=?").run(second.id);
  const refreshed = previewBillBatch(access, ids);
  setBillTerms(access, first.id, { paymentAmount: "500000", maxFee: "1000", requiresAcceptance: false });
  assert.throws(() => approveBillBatch(access, ids, refreshed.reviewToken), /changed after review/);
  const final = previewBillBatch(access, ids);
  assert.equal(approveBillBatch(access, ids, final.reviewToken).payments.length, 2);
});

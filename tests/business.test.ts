import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, row, transaction } from "../src/server/db";
import { createBill, approveBill, createPayrollRun, approvePayrollRun } from "../src/server/business/service";
import { approvePayment, getPayment, revalidatePaymentRecipient } from "../src/server/payments";
import { microUsd, usd } from "../src/lib/format";
import { parsePayrollCsv, parsePayrollDetailsCsv } from "../src/lib/csv";
import type { AccessContext } from "../src/server/context";
import { acceptBillMilestone, addBillInstallment, getBillTerms, setBillTerms } from "../src/server/business/bill-terms";
import { listPrivateEvidence, retainPrivateEvidence } from "../src/server/reconciliation/evidence";
import { accountingExport } from "../src/server/reconciliation/export";
import { captureTemplate } from "../src/server/operations/service";
import { cancelManagedPayment, replaceCancelledPayment, payrollReview, approveReviewedPayrollRun } from "../src/server/payment-management/service";
import { encrypt } from "../src/server/identity/crypto";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "a1".repeat(32);

function fixture() {
  const db = getDb(), id = randomUUID(), recipientId = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES (?,?,?)").run(id, "Fixture owner", now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, "Fixture Company", id, now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES (?,?,?,'employee','USDC','base',?,'confirmed',?,?,?)")
    .run(recipientId, id, "Fixture recipient", `0x${"12".repeat(20)}`, now, now, now);
  const preparer: AccessContext = { organizationId: id, userId: id, permissions: ["company:read", "payments:read", "payments:prepare"] };
  const approver = { ...preparer, permissions: ["company:read", "payments:read", "payments:approve"] };
  return { id, recipientId, preparer, approver };
}

test("preparer drafts can be approved by a separate role without preparation authority", () => {
  const { preparer, approver, recipientId } = fixture();
  const input = { recipientId, reference: "INV-1", title: "Private project", amount: "10000000", maxFee: "1000000" };
  const bill = createBill(preparer, input);
  assert.throws(() => approvePayment(approver, bill.payment_id!), /underlying invoice/);
  assert.equal(approveBill(approver, bill.id).status, "approved_unfunded");
  assert.equal(createBill(preparer, input).id, bill.id);
  assert.throws(() => createBill(preparer, { ...input, amount: "20000000" }), /different terms/);
  assert.notEqual(row<{ title: string }>("SELECT title FROM bills WHERE id=?", bill.id)!.title, input.title);
});

test("pay-run approval is atomic and stale recipient details require explicit draft revalidation", () => {
  const { id, preparer, approver, recipientId } = fixture();
  const run = createPayrollRun(preparer, { reference: "PAY-1", periodStart: "2026-11-01", periodEnd: "2026-11-30", items: [{ recipientId, amount: "50000000" }] });
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(recipientId);
  assert.throws(() => approvePayrollRun(approver, run.id), /Recipient details changed/);
  assert.equal(row<{ status: string }>("SELECT status FROM payroll_runs WHERE id=?", run.id)!.status, "draft");
  revalidatePaymentRecipient(preparer, run.items[0].payment_id!);
  const approved = approvePayrollRun(approver, run.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.items[0].payment?.status, "approved_unfunded");
  assert.equal(row<{ n: number }>("SELECT count(*) AS n FROM payments WHERE organization_id=?", id)!.n, 1);
  assert.throws(() => transaction(() => { transaction(() => getDb().prepare("UPDATE payroll_runs SET status='invalid' WHERE id=?").run(run.id)); throw new Error("rollback"); }), /rollback/);
  assert.equal(row<{ status: string }>("SELECT status FROM payroll_runs WHERE id=?", run.id)!.status, "approved");
});

test("USDC and payroll imports preserve precision and reject duplicate recipients", () => {
  assert.equal(microUsd("12.000001"), "12000001");
  assert.equal(microUsd("0", true), "0");
  assert.equal(usd("1"), "$0.000001");
  assert.throws(() => microUsd("1.0000001"));
  assert.throws(() => microUsd("0"));
  const recipients = [{ id: "r1", email: "one@example.test" }];
  assert.deepEqual(parsePayrollCsv('email,amount\r\none@example.test,"1200.50"', recipients), { r1: "1200.50" });
  assert.throws(() => parsePayrollCsv("email,amount\none@example.test,1\none@example.test,2", recipients), /more than once/);
});

test("payroll CSV preserves supplied components, costs and explanations through approval review", () => {
  const { preparer, recipientId } = fixture(), recipients = [{ id: recipientId, email: "employee@example.test" }];
  const parsed = parsePayrollDetailsCsv("email,base_amount,bonus_amount,adjustment_amount,note,max_fee\nemployee@example.test,1200.50,200,-50,Supplied monthly correction,0.025", recipients)[recipientId];
  assert.deepEqual(parsed, { amount: "1350.5", baseAmount: "1200.5", bonusAmount: "200", adjustmentAmount: "-50", note: "Supplied monthly correction", maxFee: "0.025" });
  const run = createPayrollRun(preparer, { reference: "detailed-csv", periodStart: "2026-11-01", periodEnd: "2026-11-30", items: [{ recipientId, amount: microUsd(parsed.amount), baseAmount: microUsd(parsed.baseAmount!, true), bonusAmount: microUsd(parsed.bonusAmount!, true), adjustmentAmount: `-${microUsd(parsed.adjustmentAmount!.slice(1), true)}`, maxFee: microUsd(parsed.maxFee!, true), note: parsed.note }] });
  const review = payrollReview(preparer, run.id).items[0];
  assert.equal(review.amount, "1350500000"); assert.equal(review.maxFee, "25000");
  assert.equal(review.terms.baseAmount, "1200500000"); assert.equal(review.terms.bonusAmount, "200000000"); assert.equal(review.terms.adjustmentAmount, "-50000000"); assert.equal(review.terms.note, parsed.note);
  assert.throws(() => parsePayrollDetailsCsv("email,base_amount,bonus_amount,amount,note\nemployee@example.test,100,10,100,Bonus", recipients), /Row 2: amount differs/);
  assert.throws(() => parsePayrollDetailsCsv("email,amount,bonus\nemployee@example.test,100,10", recipients), /Row 2: provide base_amount/);
  assert.throws(() => parsePayrollDetailsCsv("email,base_amount,adjustment_amount\nemployee@example.test,100,-100", recipients), /Row 2: enter a positive net/);
  assert.throws(() => parsePayrollDetailsCsv("recipient_id,email,amount\n"+recipientId+",different@example.test,1", recipients), /same payee/);
  assert.throws(() => createPayrollRun(preparer, { reference: "mismatch-components", periodStart: "2026-11-01", periodEnd: "2026-11-30", items: [{ recipientId, amount: "100", baseAmount: "100", bonusAmount: "20", note: "Supplied bonus" }] }), /Net pay must equal/);
});

test("milestone acceptance gates release and installments preserve the unpaid invoice liability", () => {
  const { preparer, approver, recipientId } = fixture();
  const bill = createBill(preparer, { recipientId, reference: "MILESTONE-1", title: "Build contract", amount: "1000000000" });
  setBillTerms(preparer, bill.id, { paymentAmount: "200000000", maxFee: "1000000", requiresAcceptance: true });
  assert.throws(() => approveBill(approver, bill.id), /Accept the milestone/);
  acceptBillMilestone(approver, bill.id, "Design deliverable reviewed and accepted");
  approveBill(approver, bill.id);
  assert.throws(() => addBillInstallment(preparer, bill.id, { amount: "800000000", maxFee: "1000000" }), /earlier installment/);
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(bill.payment_id!);
  assert.equal(getBillTerms(preparer, bill.id).remainingLiability, "800000000");
  assert.throws(() => addBillInstallment(preparer, bill.id, { amount: "900000000", maxFee: "1000000" }), /remaining invoice/);
  const next = addBillInstallment(preparer, bill.id, { amount: "800000000", maxFee: "1000000" });
  assert.equal(next.remainingLiability, "800000000");
  assert.equal(next.uncommitted, "0");
  assert.equal(next.installments.length, 2);
  assert.throws(() => approveBill(approver, bill.id), /Accept the milestone/);
});

test("resuming payroll reviews only unresolved employees after a paid profile is reassigned", async () => {
  const { id, preparer, approver, recipientId } = fixture(), db = getDb(), savedAt = new Date().toISOString(), second = randomUUID(), other = randomUUID();
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(id, recipientId);
  db.prepare("INSERT INTO recipient_versions(recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES(?,1,?,?,?)").run(recipientId, encrypt(JSON.stringify({ name: "Paid employee", user_id: id })), id, savedAt);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,'Unpaid employee','employee','USDC','near','unpaid.near','confirmed',?,?,?)").run(second, id, savedAt, savedAt, savedAt);
  const run = createPayrollRun(preparer, { reference: "resume-unpaid", periodStart: "2026-11-01", periodEnd: "2026-11-30", items: [{ recipientId, amount: "100" }, { recipientId: second, amount: "200" }] });
  approvePayrollRun(approver, run.id);
  const paid = run.items.find(item => item.recipient_id === recipientId)!.payment_id!, unpaid = run.items.find(item => item.recipient_id === second)!.payment_id!;
  db.prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(paid);
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Different person',?)").run(other, savedAt);
  db.prepare("UPDATE recipients SET user_id=?,version=2 WHERE id=?").run(other, recipientId);
  await cancelManagedPayment(approver, unpaid);
  const replacement = await replaceCancelledPayment(preparer, unpaid, "Review the remaining unpaid obligation");
  const result = approveReviewedPayrollRun(approver, run.id, payrollReview(approver, run.id).reviewToken);
  assert.equal(result.status, "partially_paid");
  assert.equal(getPayment(preparer, paid).status, "paid");
  assert.equal(getPayment(preparer, replacement.payment.id).status, "approved_unfunded");
  assert.equal(result.items.find(item => item.recipient_id === recipientId)!.remainingLiability, "0");
});

test("a replacement installment preserves its invoice due time", async () => {
  const { preparer, approver, recipientId } = fixture(), dueDate = "2030-12-01T10:00:00.000Z";
  const bill = createBill(preparer, { recipientId, reference: "scheduled-installment", title: "Future supplier payment", amount: "100", dueDate });
  await cancelManagedPayment(approver, bill.payment_id!);
  const next = addBillInstallment(preparer, bill.id, { amount: "40", maxFee: "1" });
  assert.equal(getPayment(preparer, next.payment_id!).scheduled_for, dueDate);
  assert.equal(next.remainingLiability, "100");
});

test("private settlement evidence is encrypted, scoped and committed without plaintext", () => {
  const { preparer, approver, recipientId } = fixture();
  const bill = createBill(preparer, { recipientId, reference: "EVIDENCE-1", title: "Private evidence fixture", amount: "1000000" });
  const attemptId = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','prepared','{}','USDC','base','fixture','1000000','1000000','fixture.near',?,?)")
    .run(attemptId, bill.payment_id!, approver.organizationId, now, now);
  const text = "Private closure note for finance";
  const commitment = retainPrivateEvidence(approver, attemptId, "settlement:delivered", text);
  assert.match(commitment, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(row<{ ciphertext: string }>("SELECT ciphertext FROM private_settlement_evidence WHERE attempt_id=?", attemptId)!.ciphertext, text);
  assert.equal(listPrivateEvidence(approver, attemptId)[0].receipt, text);
  assert.deepEqual(listPrivateEvidence({ ...approver, organizationId: "unrelated" }, attemptId), []);
  getDb().prepare("UPDATE private_settlement_evidence SET expires_at=? WHERE attempt_id=?").run(new Date(Date.now() - 1000).toISOString(), attemptId);
  assert.equal(listPrivateEvidence(approver, attemptId)[0].receipt, null);
});

test("invoice attribution stays private and survives recurring templates and accounting exports", () => {
  const { preparer, approver, recipientId } = fixture();
  const input = { recipientId, reference: "ATTRIBUTED-1", title: "Service", amount: "1000000", projectReference: "  Client rollout  ", costCenterReference: "Operations" };
  const bill = createBill(preparer, input);
  assert.equal(bill.project_reference, "Client rollout");
  assert.equal(bill.cost_center_reference, "Operations");
  const stored = row<{ project_reference: string; cost_center_reference: string }>("SELECT project_reference,cost_center_reference FROM bills WHERE id=?", bill.id)!;
  assert.notEqual(stored.project_reference, bill.project_reference);
  assert.notEqual(stored.cost_center_reference, bill.cost_center_reference);
  assert.equal(createBill(preparer, input).id, bill.id);
  assert.throws(() => createBill(preparer, { ...input, projectReference: "Other project" }), /different terms/);
  approveBill(approver, bill.id);
  const template = captureTemplate(preparer.organizationId, "bill", bill.id);
  assert.equal(template.bill?.projectReference, "Client rollout");
  const exported = accountingExport({ ...approver, permissions: [...approver.permissions, "reports:read"] });
  assert(exported.includes('"project_reference"') && exported.includes('"Client rollout"'));
  assert(!getPayment(preparer, bill.payment_id!).metadata.includes("Client rollout"));
});

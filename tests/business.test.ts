import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, row, transaction } from "../src/server/db";
import { createBill, approveBill, createPayrollRun, approvePayrollRun } from "../src/server/business/service";
import { approvePayment, revalidatePaymentRecipient } from "../src/server/payments";
import { microUsd } from "../src/lib/format";
import { parsePayrollCsv } from "../src/lib/csv";
import type { AccessContext } from "../src/server/context";
import { acceptBillMilestone, addBillInstallment, getBillTerms, setBillTerms } from "../src/server/business/bill-terms";

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
  assert.throws(() => microUsd("1.0000001"));
  assert.throws(() => microUsd("0"));
  const recipients = [{ id: "r1", email: "one@example.test" }];
  assert.deepEqual(parsePayrollCsv('email,amount\r\none@example.test,"1200.50"', recipients), { r1: "1200.50" });
  assert.throws(() => parsePayrollCsv("email,amount\none@example.test,1\none@example.test,2", recipients), /more than once/);
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

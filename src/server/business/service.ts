import { randomUUID } from "node:crypto";
import { getDb, row, rows, transaction } from "../db";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { approvePayment, createPayment, getPayment } from "../payments";
import { decrypt, encrypt } from "../identity/crypto";
import { accountingExport } from "../reconciliation/export";

type Bill = {
  id: string; organization_id: string; recipient_id: string; reference: string; title: string;
  amount: string; max_fee: string; due_date: string | null; status: string;
  line_items: string; evidence: string | null; document_hash: string | null;
  payment_id: string | null; accepted_at: string | null; created_at: string; updated_at: string;
  requires_acceptance: number; milestone_accepted_at: string | null;
};
type PayrollRun = {
  id: string; organization_id: string; reference: string; period_start: string; period_end: string;
  scheduled_for: string | null; status: string; created_by: string; approved_by: string | null;
  created_at: string; updated_at: string;
};
type PayrollItem = { id: string; run_id: string; recipient_id: string; amount: string; max_fee: string; note: string | null; payment_id: string | null };

function readableBill(bill: Bill): Bill {
  return { ...bill, title: decrypt(bill.title), line_items: decrypt(bill.line_items), evidence: bill.evidence ? decrypt(bill.evidence) : null };
}

function amount(value: string, allowZero = false): string {
  if (!/^\d+$/.test(value) || BigInt(value) > 10n ** 30n || (!allowZero && BigInt(value) === 0n)) {
    throw new ApiError(400, "Enter a positive amount in microUSDC", "INVALID_AMOUNT");
  }
  return BigInt(value).toString();
}

function recipient(access: AccessContext, id: string): void {
  if (!row("SELECT id FROM recipients WHERE id = ? AND organization_id = ?", id, access.organizationId)) {
    throw new ApiError(404, "Recipient not found", "NOT_FOUND");
  }
}

export function activity(access: AccessContext, action: string, entityId: string, details: Record<string, unknown> = {}) {
  getDb().prepare("INSERT INTO activity (id, organization_id, actor_id, action, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), access.organizationId, access.userId, action, entityId, JSON.stringify(details), new Date().toISOString());
}

export function listBills(access: AccessContext) {
  requirePermission(access, "payments:read");
  return rows<Bill>("SELECT * FROM bills WHERE organization_id = ? ORDER BY created_at DESC", access.organizationId)
    .map(readableBill).map((bill) => {
      const installments = rows<{ amount: string; status: string }>("SELECT p.amount,p.status FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=?", bill.id);
      const delivered = installments.filter((item) => item.status === "paid").reduce((sum, item) => sum + BigInt(item.amount), 0n);
      const status = bill.status === "disputed" ? "disputed" : delivered === BigInt(bill.amount) ? "paid" : delivered > 0n ? "partially_paid" : bill.status;
      return { ...bill, status, line_items: JSON.parse(bill.line_items), payment: bill.payment_id ? getPayment(access, bill.payment_id) : null, deliveredAmount: delivered.toString(), remainingLiability: (BigInt(bill.amount) - delivered).toString() };
    });
}

export function createBill(access: AccessContext, input: {
  recipientId: string; reference: string; title: string; amount: string; maxFee?: string;
  dueDate?: string; lineItems?: unknown[]; evidence?: string; documentHash?: string;
}) {
  requirePermission(access, "payments:prepare");
  recipient(access, input.recipientId);
  const value = amount(input.amount);
  const fee = amount(input.maxFee ?? "1000000", true);
  const existing = row<Bill>("SELECT * FROM bills WHERE organization_id = ? AND recipient_id = ? AND reference = ?", access.organizationId, input.recipientId, input.reference);
  if (existing) {
    if (existing.amount !== value || existing.max_fee !== fee || decrypt(existing.title) !== input.title || existing.due_date !== (input.dueDate ?? null)) throw new ApiError(409, "This invoice reference already has different terms", "DUPLICATE_INVOICE");
    return readableBill(existing);
  }
  if (input.documentHash && row("SELECT id FROM bills WHERE organization_id = ? AND document_hash = ?", access.organizationId, input.documentHash)) {
    throw new ApiError(409, "This document is already registered", "DUPLICATE_DOCUMENT");
  }
  const id = randomUUID(), now = new Date().toISOString();
  return transaction((db) => {
    db.prepare("INSERT INTO bills (id, organization_id, recipient_id, reference, title, amount, max_fee, due_date, line_items, evidence, document_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, access.organizationId, input.recipientId, input.reference, encrypt(input.title), value, fee, input.dueDate ?? null, encrypt(JSON.stringify(input.lineItems ?? [])), input.evidence ? encrypt(input.evidence) : null, input.documentHash ?? null, access.userId, now, now);
    const payment = createPayment(access, { recipientId: input.recipientId, reference: `bill:${id}`, amount: value, maxFee: fee, kind: "invoice", scheduledFor: input.dueDate, metadata: { billId: id, displayReference: input.reference } });
    db.prepare("UPDATE bills SET payment_id = ? WHERE id = ?").run(payment.id, id);
    activity(access, "bill.created", id);
    return readableBill(row<Bill>("SELECT * FROM bills WHERE id = ?", id)!);
  });
}

export function approveBill(access: AccessContext, id: string) {
  requirePermission(access, "payments:approve");
  const bill = row<Bill>("SELECT * FROM bills WHERE id = ? AND organization_id = ?", id, access.organizationId);
  if (!bill) throw new ApiError(404, "Bill not found", "NOT_FOUND");
  if (bill.status === "disputed") throw new ApiError(409, "Resolve the dispute before approval", "BILL_DISPUTED");
  if (bill.requires_acceptance && !bill.milestone_accepted_at) throw new ApiError(409, "Accept the milestone with evidence before approving release", "MILESTONE_ACCEPTANCE_REQUIRED");
  if (!bill.payment_id) throw new ApiError(409, "Ask the preparer to finish this bill's payment draft", "PAYMENT_DRAFT_REQUIRED");
  return transaction((db) => {
    db.prepare("UPDATE bills SET status = 'approved', accepted_at = COALESCE(accepted_at,?), updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    const approved = approvePayment(access, bill.payment_id!);
    activity(access, "bill.approved", id, { paymentId: bill.payment_id });
    return approved;
  });
}

export function disputeBill(access: AccessContext, id: string, reason: string) {
  requirePermission(access, "payments:approve");
  const bill = row<Bill>("SELECT * FROM bills WHERE id = ? AND organization_id = ?", id, access.organizationId);
  if (!bill) throw new ApiError(404, "Bill not found", "NOT_FOUND");
  if (bill.payment_id && getPayment(access, bill.payment_id).status !== "draft") throw new ApiError(409, "Reconcile the approved payment before changing this bill", "PAYMENT_EXISTS");
  getDb().prepare("UPDATE bills SET status = 'disputed', dispute_reason = ?, updated_at = ? WHERE id = ?").run(encrypt(reason), new Date().toISOString(), id);
  if (bill.payment_id) getDb().prepare("UPDATE payments SET hold_reason = ? WHERE id = ?").run("This invoice is disputed", bill.payment_id);
  activity(access, "bill.disputed", id, { status: "disputed" });
  return { id, status: "disputed" };
}

export function getPayrollRun(access: AccessContext, id: string) {
  requirePermission(access, "payments:read");
  const run = row<PayrollRun>("SELECT * FROM payroll_runs WHERE id = ? AND organization_id = ?", id, access.organizationId);
  if (!run) throw new ApiError(404, "Pay run not found", "NOT_FOUND");
  const items = rows<PayrollItem>("SELECT * FROM payroll_items WHERE run_id = ?", id)
    .map((item) => ({ ...item, payment: item.payment_id ? getPayment(access, item.payment_id) : null }));
  const paid = items.filter((item) => item.payment?.status === "paid").length;
  const status = paid === items.length && paid > 0 ? "paid" : paid > 0 ? "partially_paid" : run.status;
  return { ...run, status, items, total: items.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString(), maxFees: items.reduce((sum, item) => sum + BigInt(item.max_fee), 0n).toString() };
}

export function listPayrollRuns(access: AccessContext) {
  requirePermission(access, "payments:read");
  return rows<PayrollRun>("SELECT * FROM payroll_runs WHERE organization_id = ? ORDER BY created_at DESC", access.organizationId).map((run) => getPayrollRun(access, run.id));
}

export function createPayrollRun(access: AccessContext, input: {
  reference: string; periodStart: string; periodEnd: string; scheduledFor?: string;
  items: { recipientId: string; amount: string; maxFee?: string; note?: string }[];
}) {
  requirePermission(access, "payments:prepare");
  if (!input.items.length || input.items.length > 1000) throw new ApiError(400, "A pay run needs between 1 and 1,000 recipients", "INVALID_RUN");
  if (new Date(input.periodStart).getTime() > new Date(input.periodEnd).getTime()) throw new ApiError(400, "The pay period ends before it starts", "INVALID_PERIOD");
  if (new Set(input.items.map((item) => item.recipientId)).size !== input.items.length) throw new ApiError(400, "A recipient appears more than once", "DUPLICATE_RECIPIENT");
  const old = row<PayrollRun>("SELECT * FROM payroll_runs WHERE organization_id = ? AND reference = ?", access.organizationId, input.reference);
  if (old) throw new ApiError(409, "This pay-run reference already exists", "DUPLICATE_RUN");
  const items = input.items.map((item) => { recipient(access, item.recipientId); return { ...item, amount: amount(item.amount), maxFee: amount(item.maxFee ?? "1000000", true) }; });
  const id = randomUUID(), now = new Date().toISOString();
  transaction((db) => {
    db.prepare("INSERT INTO payroll_runs (id,organization_id,reference,period_start,period_end,scheduled_for,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, access.organizationId, input.reference, input.periodStart, input.periodEnd, input.scheduledFor ?? null, access.userId, now, now);
    for (const item of items) {
      const payment = createPayment(access, { recipientId: item.recipientId, reference: `payroll:${id}:${item.recipientId}`, amount: item.amount, maxFee: item.maxFee, kind: "payroll", scheduledFor: input.scheduledFor, metadata: { runId: id, displayReference: input.reference, periodStart: input.periodStart, periodEnd: input.periodEnd } });
      db.prepare("INSERT INTO payroll_items (id,run_id,recipient_id,amount,max_fee,note,payment_id) VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), id, item.recipientId, item.amount, item.maxFee, item.note ? encrypt(item.note) : null, payment.id);
    }
  });
  activity(access, "payroll.created", id);
  return getPayrollRun(access, id);
}

export function approvePayrollRun(access: AccessContext, id: string) {
  requirePermission(access, "payments:approve");
  const run = getPayrollRun(access, id);
  if (run.status === "cancelled") throw new ApiError(409, "This run is cancelled", "RUN_CANCELLED");
  return transaction((db) => {
    db.prepare("UPDATE payroll_runs SET status = 'approved', approved_by = COALESCE(approved_by,?), updated_at = ? WHERE id = ?")
      .run(access.userId, new Date().toISOString(), id);
    for (const item of run.items) {
      if (!item.payment_id) throw new ApiError(409, "Ask the preparer to finish this pay run's drafts", "PAYMENT_DRAFT_REQUIRED");
      approvePayment(access, item.payment_id);
    }
    activity(access, "payroll.approved", id);
    return getPayrollRun(access, id);
  });
}

export function report(access: AccessContext) {
  return accountingExport(access);
}

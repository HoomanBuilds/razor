import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { createPayment, getPayment, type Payment } from "../payments";
import { activity } from "./service";
import { liabilityPayments } from "../partial-settlement/model";
import { assertSameRecipientOwner } from "../payments/recipient-names";
import { activeClearingRound, assertNoActiveClearing } from "../clearing/locks";
import { acceptedBillCredits } from "../invoice-credits/accounting";
import { fundedBillDischarges } from "../clearing/funded-accounting";

interface TermsBill { id: string; recipient_id: string; amount: string; setoff_amount: string; funded_clearing_amount:string; accepted_credit_amount:string; status: string; due_date: string | null; payment_id: string | null; requires_acceptance: number; milestone_accepted_at: string | null; acceptance_evidence: string | null; dispute_reason: string | null }
function bill(access: AccessContext, id: string): TermsBill {
  const result = row<TermsBill>("SELECT * FROM bills WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!result) throw new ApiError(404, "Invoice not found", "NOT_FOUND");
  return result;
}
function positive(value: string, zero = false): string {
  if (!/^\d+$/.test(value) || BigInt(value) > 10n ** 30n || !zero && BigInt(value) === 0n) throw new ApiError(400, "Enter a valid microUSDC amount", "INVALID_AMOUNT");
  return BigInt(value).toString();
}
export function getBillTerms(access: AccessContext, id: string) {
  requirePermission(access, "payments:read");
  const current = bill(access, id);
  const installments = rows<Payment>("SELECT p.* FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND p.organization_id=? ORDER BY i.created_at", id,access.organizationId);
  const paid = installments.reduce((sum, item) => sum + BigInt(item.status === "paid" ? item.amount : item.delivered_amount), 0n), setoff = BigInt(current.setoff_amount),funded=BigInt(current.funded_clearing_amount),credit=BigInt(current.accepted_credit_amount);
  const committed = installments.filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + BigInt(item.status === "partially_paid" ? item.delivered_amount : item.amount), 0n);
  const clearingSetoffs = rows<{ round_id: string; amount: string; original_payment_id: string; residual_payment_id: string | null; proof_block_hash: string; proof_block_height: string; created_at: string }>("SELECT round_id,amount,original_payment_id,residual_payment_id,proof_block_hash,proof_block_height,created_at FROM clearing_setoffs WHERE bill_id=? AND organization_id=? ORDER BY created_at", id, access.organizationId);
  return { ...current, activeClearingRound: current.payment_id ? activeClearingRound(access.organizationId, current.payment_id) : null, acceptance_evidence: current.acceptance_evidence ? decrypt(current.acceptance_evidence) : null, dispute_reason: current.dispute_reason ? decrypt(current.dispute_reason) : null, installments, clearingSetoffs, fundedClearingDischarges:fundedBillDischarges(access.organizationId,id), paid: paid.toString(), setoffAmount: setoff.toString(), fundedClearingAmount:funded.toString(), acceptedCreditAmount:credit.toString(), acceptedCreditNotes:acceptedBillCredits(access.organizationId,id), remainingLiability: (BigInt(current.amount) - paid - setoff - funded - credit).toString(), uncommitted: (BigInt(current.amount) - committed - setoff - funded - credit).toString() };
}
export function setBillTerms(access: AccessContext, id: string, input: { paymentAmount: string; maxFee: string; requiresAcceptance: boolean }) {
  requirePermission(access, "payments:prepare");
  return transaction((db) => {
    const current = getBillTerms(access, id);
    if((BigInt(current.fundedClearingAmount)>0n||BigInt(current.acceptedCreditAmount)>0n)&&BigInt(current.remainingLiability)<=0n)throw new ApiError(409,"This invoice has no remaining liability after its accepted credits or funded discharge","CLEARED_LIABILITY");
    if (!current.payment_id) throw new ApiError(409, "This invoice has no unpaid installment to change", "TERMS_LOCKED");
    const payment = getPayment(access, current.payment_id);
    assertNoActiveClearing(access.organizationId, payment.id);
    if (current.status === "disputed" || payment.status !== "draft" || payment.approved_at) throw new ApiError(409, "Only an undisputed, unapproved installment can change terms", "TERMS_LOCKED");
    const amount = positive(input.paymentAmount), maxFee = positive(input.maxFee, true);
    if (amount !== payment.amount && liabilityPayments(access.organizationId, payment.id).some(item => item.status === "partially_paid")) throw new ApiError(409, "The partial-settlement remainder keeps its exact unpaid entitlement. Review fees separately", "PARTIAL_REMAINDER_FIXED");
    const replacements = rows<Payment>(`WITH RECURSIVE ancestors(id) AS (
      SELECT ? UNION SELECT r.old_payment_id FROM payment_replacements r JOIN ancestors a ON r.new_payment_id=a.id WHERE r.organization_id=?
    ) SELECT p.* FROM payments p JOIN ancestors a ON a.id=p.id WHERE p.organization_id=? ORDER BY p.created_at,p.id`, payment.id, access.organizationId, access.organizationId);
    if (replacements.length > 1) {
      const original = replacements.find(item => !row("SELECT old_payment_id FROM payment_replacements WHERE new_payment_id=? AND organization_id=?", item.id, access.organizationId))!;
      const remainingFee = BigInt(original.max_fee) - replacements.reduce((sum, item) => sum + BigInt(item.total_spent), 0n);
      if (BigInt(maxFee) > remainingFee) throw new ApiError(409, "The replacement must keep the original routing ceiling after prior costs", "REPLACEMENT_COST_EXHAUSTED");
    }
    if (BigInt(amount) > BigInt(current.uncommitted) + BigInt(payment.amount)) throw new ApiError(409, "The installment exceeds the remaining invoice amount", "INSTALLMENT_EXCEEDS_BALANCE");
    db.prepare("UPDATE payments SET amount=?,max_fee=?,updated_at=? WHERE id=? AND status='draft' AND approved_at IS NULL").run(amount, maxFee, new Date().toISOString(), payment.id);
    db.prepare("UPDATE bills SET requires_acceptance=?,milestone_accepted_at=NULL,milestone_accepted_by=NULL,acceptance_evidence=NULL,updated_at=? WHERE id=?").run(Number(input.requiresAcceptance), new Date().toISOString(), id);
    activity(access, "bill.terms_prepared", id);
    return getBillTerms(access, id);
  });
}
export function acceptBillMilestone(access: AccessContext, id: string, evidence: string) {
  requirePermission(access, "payments:approve");
  const current = bill(access, id);
  if (current.payment_id) assertNoActiveClearing(access.organizationId, current.payment_id);
  if (current.status === "disputed") throw new ApiError(409, "Resolve this dispute before accepting work", "BILL_DISPUTED");
  if (!evidence.trim()) throw new ApiError(400, "Record the acceptance evidence", "ACCEPTANCE_REQUIRED");
  getDb().prepare("UPDATE bills SET milestone_accepted_at=?,milestone_accepted_by=?,acceptance_evidence=?,updated_at=? WHERE id=?").run(new Date().toISOString(), access.userId, encrypt(evidence.trim()), new Date().toISOString(), id);
  activity(access, "bill.milestone_accepted", id);
  return getBillTerms(access, id);
}
export function resolveBillDispute(access: AccessContext, id: string, resolution: string) {
  requirePermission(access, "payments:approve");
  return transaction((db) => {
    const current = bill(access, id);
    if (current.payment_id) assertNoActiveClearing(access.organizationId, current.payment_id);
    if (current.status !== "disputed") throw new ApiError(409, "This invoice is not disputed", "BILL_NOT_DISPUTED");
    db.prepare("UPDATE bills SET status='draft',dispute_reason=?,updated_at=? WHERE id=?").run(encrypt(resolution), new Date().toISOString(), id);
    db.prepare("UPDATE payments SET hold_reason=NULL WHERE id=? AND status='draft'").run(current.payment_id);
    activity(access, "bill.dispute_resolved", id);
    return getBillTerms(access, id);
  });
}
export function addBillInstallment(access: AccessContext, id: string, input: { amount: string; maxFee: string }) {
  requirePermission(access, "payments:prepare");
  return transaction((db) => {
    const current = getBillTerms(access, id);
    if((BigInt(current.fundedClearingAmount)>0n||BigInt(current.acceptedCreditAmount)>0n)&&BigInt(current.remainingLiability)<=0n)throw new ApiError(409,"This invoice has no remaining liability after its accepted credits or funded discharge","CLEARED_LIABILITY");
    if (current.payment_id) assertNoActiveClearing(access.organizationId, current.payment_id);
    if (current.status === "disputed" || current.installments.some((item) => !["paid", "cancelled", "partially_paid"].includes(item.status))) throw new ApiError(409, "Reconcile the earlier installment before preparing another", "PRIOR_INSTALLMENT_UNRESOLVED");
    if (current.installments.some(item => item.status === "partially_paid" && !row("SELECT original_payment_id FROM partial_remainders WHERE original_payment_id=?", item.id))) throw new ApiError(409, "Prepare this terminal partial payment's explicitly reviewed remainder before another installment", "PARTIAL_REMAINDER_REQUIRED");
    for (const payment of current.installments) assertSameRecipientOwner(access.organizationId, payment);
    const amount = positive(input.amount), maxFee = positive(input.maxFee, true);
    if (BigInt(amount) > BigInt(current.uncommitted)) throw new ApiError(409, "The installment exceeds the remaining invoice amount", "INSTALLMENT_EXCEEDS_BALANCE");
    const installmentId = randomUUID();
    const payment = createPayment(access, { recipientId: current.recipient_id, reference: `bill:${id}:${installmentId}`, amount, maxFee, kind: "invoice", scheduledFor: current.due_date, metadata: { billId: id, installmentId } });
    db.prepare("INSERT INTO bill_installments(id,bill_id,payment_id,created_at) VALUES(?,?,?,?)").run(installmentId, id, payment.id, new Date().toISOString());
    db.prepare("UPDATE bills SET payment_id=?,status='draft',accepted_at=NULL,milestone_accepted_at=NULL,milestone_accepted_by=NULL,acceptance_evidence=NULL,updated_at=? WHERE id=?").run(payment.id, new Date().toISOString(), id);
    activity(access, "bill.installment_prepared", id, { paymentId: payment.id });
    return getBillTerms(access, id);
  });
}

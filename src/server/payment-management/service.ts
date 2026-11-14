import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getRecipient, type RecipientRecord } from "../identity/recipients";
import { approveBill, approvePayrollRun, getPayrollRun } from "../business/service";
import { billCommitmentReview } from "../vendor-commitments/service";
import { addBillInstallment } from "../business/bill-terms";
import { cancelPayment, createPayment, getPayment, getTreasury, listAttempts } from "../payments/service";
import { paymentBudget } from "../../lib/payment-budget";
import { view } from "../payments/near";
import type { ChainPayment, Payment, RecipientSnapshot, TreasuryConfig } from "../payments/types";
import { getSupportedTokens, type Token } from "../payments/intents";
import { duplicateInvoiceWarnings } from "../business/duplicate-invoices";
import { recipientRouteReadiness } from "./routing";
import { liabilityPayments } from "../partial-settlement/model";
import { assertSameRecipientOwner, recordedRecipientName } from "../payments/recipient-names";
import { fundingPositions } from "../payment-funding/accounting";
import { activeClearingRound } from "../clearing/locks";

interface Terms { base_amount: string; bonus_amount: string; adjustment_amount: string; note_ciphertext: string | null; version: number }
interface Replacement { old_payment_id: string; new_payment_id: string; liability_kind: string; liability_id: string; reason_ciphertext: string; created_at: string }
interface Run { id: string; reference: string; period_start: string; period_end: string; scheduled_for: string | null; status: string; approved_by: string | null }
interface Item { id: string; run_id: string; recipient_id: string; amount: string; max_fee: string; note: string | null; payment_id: string }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();

function fundingReview(access: AccessContext, payments: Payment[]) {
  const treasury = getTreasury(access);
  const budgets = payments.map(paymentBudget);
  const unreserved = budgets.reduce((sum, value) => sum + value.unreserved, 0n);
  const awaitingReconciliation = budgets.reduce((sum, value) => sum + value.awaitingReconciliation, 0n);
  const alreadyReserved = budgets.reduce((sum, value) => sum + value.remaining - value.unreserved - value.awaitingReconciliation, 0n);
  const positions = new Map(fundingPositions(access.organizationId).map(position => [position.payment.id, position]));
  const protectedFunding = payments.reduce((sum, payment, index) => {
    const position = positions.get(payment.id), held = position ? position.clientCash + position.held : 0n;
    return sum + (held < budgets[index].unreserved ? held : budgets[index].unreserved);
  }, 0n);
  const shortfall = unreserved - protectedFunding - BigInt(treasury.available), deficit = BigInt(treasury.reserveDeficit);
  return { unreserved: unreserved.toString(), alreadyReserved: alreadyReserved.toString(), awaitingReconciliation: awaitingReconciliation.toString(),
    protectedFunding: protectedFunding.toString(), available: treasury.available, shortfall: (shortfall > deficit ? shortfall : deficit).toString(), treasuryConfigured: !!treasury.config, lastSyncedAt: treasury.lastSyncedAt };
}

function audit(access: AccessContext, action: string, entityId: string, details: unknown) {
  getDb().prepare("INSERT INTO payment_management_audit(id,organization_id,actor_id,action,entity_id,details_ciphertext,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), access.organizationId, access.userId, action, entityId, encrypt(JSON.stringify(details)), now());
}

function money(value: string, zero = false, signed = false): bigint {
  if (value.length > 32 || !(signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value)) throw new ApiError(422, "Use integer microUSDC amounts", "INVALID_AMOUNT");
  const amount = BigInt(value);
  if (amount > 10n ** 30n || amount < -(10n ** 30n) || !signed && (amount < 0n || !zero && amount === 0n)) throw new ApiError(422, "The net amount is outside the supported range", "INVALID_AMOUNT");
  return amount;
}

function profile(recipient: RecipientRecord): RecipientSnapshot {
  const { id, primary_asset, primary_network, primary_address, primary_memo, backup_network, backup_address, fallback_consent, version, preference_status, confirmed_at, archived } = recipient;
  return { id, primary_asset, primary_network, primary_address, primary_memo, backup_network, backup_address, fallback_consent, version, preference_status, confirmed_at, archived };
}

function paymentReview(access: AccessContext, payment: Payment) {
  const recipient = getRecipient(access.organizationId, payment.recipient_id);
  const recordedProfile = JSON.parse(payment.recipient_snapshot) as RecipientSnapshot;
  return { payment, activeClearingRound: activeClearingRound(access.organizationId, payment.id), recipientName: recordedRecipientName(access.organizationId, payment), recordedProfile, currentProfile: profile(recipient), profileChanged: payment.recipient_version !== recipient.version };
}

function currentRun(access: AccessContext, runId: string): Run {
  const run = row<Run>("SELECT * FROM payroll_runs WHERE id=? AND organization_id=?", runId, access.organizationId);
  if (!run) throw new ApiError(404, "Pay run not found", "RUN_NOT_FOUND");
  return run;
}

function currentItem(access: AccessContext, runId: string, itemId: string): Item {
  currentRun(access, runId);
  const item = row<Item>("SELECT * FROM payroll_items WHERE id=? AND run_id=?", itemId, runId);
  if (!item) throw new ApiError(404, "Pay-run recipient not found", "PAYROLL_ITEM_NOT_FOUND");
  return item;
}

function itemTerms(item: Item) {
  const terms = row<Terms>("SELECT * FROM payroll_item_terms WHERE item_id=?", item.id);
  return { baseAmount: terms?.base_amount ?? item.amount, bonusAmount: terms?.bonus_amount ?? "0", adjustmentAmount: terms?.adjustment_amount ?? "0", note: terms?.note_ciphertext ? decrypt(terms.note_ciphertext) : item.note ? decrypt(item.note) : "", version: terms?.version ?? 0 };
}

function history(access: AccessContext, kind: string, liabilityId: string, current: Payment) {
  const replacements = rows<Replacement>("SELECT * FROM payment_replacements WHERE organization_id=? AND liability_kind=? AND liability_id=? ORDER BY created_at", access.organizationId, kind, liabilityId);
  const ids = new Set([current.id, ...replacements.flatMap((item) => [item.old_payment_id, item.new_payment_id])]);
  return { replacements, payments: [...ids].map((id) => getPayment(access, id)) };
}

export function payrollReview(access: AccessContext, runId: string) {
  requirePermission(access, "payments:read");
  const run = currentRun(access, runId);
  const items = rows<Item>("SELECT * FROM payroll_items WHERE run_id=? ORDER BY recipient_id,id", runId).map((item) => {
    const payment = getPayment(access, item.payment_id);
    const review = paymentReview(access, payment);
    const old = history(access, "payroll_item", item.id, payment);
    return { id: item.id, recipientId: item.recipient_id, amount: item.amount, maxFee: payment.max_fee, originalFeeBudget: item.max_fee, terms: itemTerms(item), ...review, canAdjust: run.status === "draft" && !run.approved_by && payment.status === "draft" && !payment.approved_at && !listAttempts(access, payment.id).length, history: old.payments.map((entry) => ({ id: entry.id, status: entry.status, amount: entry.amount, maxFee: entry.max_fee, spent: entry.total_spent, recipientVersion: entry.recipient_version, createdAt: entry.created_at })) };
  });
  const result = { run, items, total: items.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString(), maxFees: items.reduce((sum, item) => sum + BigInt(item.maxFee), 0n).toString(), funding: fundingReview(access, items.map(item => item.payment)) };
  return { ...result, reviewToken: digest(result) };
}

export function adjustPayrollItem(access: AccessContext, runId: string, itemId: string, input: { expectedPaymentId: string; expectedTermsVersion: number; baseAmount: string; bonusAmount: string; adjustmentAmount: string; maxFee: string; note: string }) {
  requirePermission(access, "payments:prepare");
  return transaction((db) => {
    const run = currentRun(access, runId), item = currentItem(access, runId, itemId), payment = getPayment(access, item.payment_id), previous = itemTerms(item);
    if (item.payment_id !== input.expectedPaymentId || previous.version !== input.expectedTermsVersion) throw new ApiError(409, "Payroll changed. Refresh its review before editing", "PAYROLL_REVIEW_STALE");
    if (run.status !== "draft" || run.approved_by || payment.status !== "draft" || payment.approved_at || listAttempts(access, payment.id).length) throw new ApiError(409, "Only a pay run that has never been approved can change its net amounts", "PAYROLL_TERMS_LOCKED");
    const base = money(input.baseAmount, true), bonus = money(input.bonusAmount, true), adjustment = money(input.adjustmentAmount, true, true), amount = base + bonus + adjustment, maxFee = money(input.maxFee, true);
    money(amount.toString());
    if ((bonus !== 0n || adjustment !== 0n) && !input.note.trim()) throw new ApiError(422, "Explain the supplied bonus or net adjustment", "ADJUSTMENT_NOTE_REQUIRED");
    db.prepare("UPDATE payroll_items SET amount=?,max_fee=?,note=? WHERE id=?").run(amount.toString(), maxFee.toString(), input.note ? encrypt(input.note.trim()) : null, itemId);
    db.prepare("UPDATE payments SET amount=?,max_fee=?,updated_at=? WHERE id=? AND status='draft' AND approved_at IS NULL").run(amount.toString(), maxFee.toString(), now(), payment.id);
    db.prepare("INSERT INTO payroll_item_terms(item_id,base_amount,bonus_amount,adjustment_amount,note_ciphertext,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET base_amount=excluded.base_amount,bonus_amount=excluded.bonus_amount,adjustment_amount=excluded.adjustment_amount,note_ciphertext=excluded.note_ciphertext,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at").run(itemId, base.toString(), bonus.toString(), adjustment.toString(), input.note ? encrypt(input.note.trim()) : null, previous.version + 1, access.userId, now());
    db.prepare("UPDATE payroll_runs SET updated_at=? WHERE id=?").run(now(), runId);
    audit(access, "payroll.net_terms_changed", itemId, { previous, next: input, amount: amount.toString() });
    return payrollReview(access, runId);
  });
}

function validateReviewedPayment(review: ReturnType<typeof paymentReview>) {
  if (review.activeClearingRound) throw new ApiError(409, "This invoice is committed to an active clearing round. Reconcile or revoke that round before approval", "CLEARING_ROUND_LOCKED");
  if (review.payment.status === "paid") return;
  if (!["draft", "approved_unfunded", "approved"].includes(review.payment.status) || review.payment.delivered_amount !== "0") throw new ApiError(409, "Reconcile or replace the unresolved obligation before approving this review", "PAYMENT_REVIEW_BLOCKED");
  if (review.profileChanged || review.currentProfile.archived || review.currentProfile.preference_status !== "confirmed") throw new ApiError(409, "Refresh unapproved recipient details, or cancel and replace an approved obligation, before approval", "RECIPIENT_REVIEW_CHANGED");
}

export function approveReviewedPayrollRun(access: AccessContext, runId: string, reviewToken: string) {
  requirePermission(access, "payments:approve");
  return transaction((db) => {
    const review = payrollReview(access, runId);
    if (review.reviewToken !== reviewToken) throw new ApiError(409, "Pay-run terms changed after review. Review the exact amounts and routes again", "PAYROLL_REVIEW_STALE");
    for (const item of review.items) validateReviewedPayment(item);
    const run = approvePayrollRun(access, runId);
    db.prepare("INSERT INTO payroll_run_approvals(id,organization_id,run_id,review_hash,approved_by,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), access.organizationId, runId, reviewToken, access.userId, now());
    audit(access, "payroll.review_approved", runId, { reviewToken });
    return run;
  });
}

export function previewBillBatch(access: AccessContext, billIds: string[]) {
  requirePermission(access, "payments:read");
  if (!billIds.length || billIds.length > 100 || new Set(billIds).size !== billIds.length) throw new ApiError(422, "Choose between 1 and 100 distinct invoices", "INVALID_BILL_BATCH");
  const bills = [...billIds].sort().map((id) => {
    const bill = row<{ id: string; reference: string; title: string; amount: string; max_fee: string; payment_id: string; status: string; updated_at: string; requires_acceptance: number; milestone_accepted_at: string | null; acceptance_evidence: string | null }>("SELECT id,reference,title,amount,max_fee,payment_id,status,updated_at,requires_acceptance,milestone_accepted_at,acceptance_evidence FROM bills WHERE id=? AND organization_id=?", id, access.organizationId);
    if (!bill || !bill.payment_id) throw new ApiError(404, "Invoice or its payment draft was not found", "BILL_NOT_FOUND");
    return { ...bill, title: decrypt(bill.title), acceptance_evidence: undefined, acceptanceEvidence: bill.acceptance_evidence ? decrypt(bill.acceptance_evidence) : null, vendorCommitment: billCommitmentReview(access.organizationId, bill.id), ...paymentReview(access, getPayment(access, bill.payment_id)) };
  });
  const selected = new Set(billIds);
  const duplicateWarnings = duplicateInvoiceWarnings(rows<{id:string;recipient_id:string;reference:string;amount:string;created_at:string}>("SELECT id,recipient_id,reference,amount,created_at FROM bills WHERE organization_id=?", access.organizationId)).filter(warning => warning.invoiceIds.some(id => selected.has(id)));
  const result = { bills, duplicateWarnings, total: bills.reduce((sum, bill) => sum + BigInt(bill.payment.amount), 0n).toString(), maxFees: bills.reduce((sum, bill) => sum + BigInt(bill.payment.max_fee), 0n).toString(), funding: fundingReview(access, bills.map(bill => bill.payment)) };
  return { ...result, reviewToken: digest(result) };
}

async function routingContext(access: AccessContext) {
  requirePermission(access, "payments:read");
  let tokens: Token[] | null = null;
  try { tokens = await getSupportedTokens(); } catch {}
  const disabled = new Set(rows<{ network: string }>("SELECT network FROM payment_networks WHERE organization_id=? AND enabled=0", access.organizationId).map(value => value.network));
  return { tokens, disabled, catalog: { status: tokens ? "available" as const : "unavailable" as const, checkedAt: now(), maximumCacheAgeSeconds: 60, previewOnly: true as const } };
}

export async function payrollPreview(access: AccessContext, runId: string) {
  payrollReview(access, runId);
  const routing = await routingContext(access), review = payrollReview(access, runId);
  return { ...review, routingCatalog: routing.catalog, items: review.items.map(item => ({ ...item, routeReadiness: recipientRouteReadiness(item.recordedProfile, routing.tokens, routing.disabled) })) };
}

export async function billBatchPreview(access: AccessContext, billIds: string[]) {
  previewBillBatch(access, billIds);
  const routing = await routingContext(access), review = previewBillBatch(access, billIds);
  return { ...review, routingCatalog: routing.catalog, bills: review.bills.map(bill => ({ ...bill, routeReadiness: recipientRouteReadiness(bill.recordedProfile, routing.tokens, routing.disabled) })) };
}

export function approveBillBatch(access: AccessContext, billIds: string[], reviewToken: string) {
  requirePermission(access, "payments:approve");
  return transaction(() => {
    const review = previewBillBatch(access, billIds);
    if (review.reviewToken !== reviewToken) throw new ApiError(409, "Invoice terms changed after review. Review the batch again", "BILL_REVIEW_STALE");
    for (const bill of review.bills) validateReviewedPayment(bill);
    const payments = review.bills.map((bill) => approveBill(access, bill.id));
    audit(access, "invoices.batch_approved", reviewToken, { billIds });
    return { payments };
  });
}

function assertReplaceable(access: AccessContext, payment: Payment) {
  if (row("SELECT payment_id FROM invoice_credit_retirements WHERE payment_id=? AND organization_id=?",payment.id,access.organizationId)||row("SELECT id FROM clearing_setoffs WHERE original_payment_id=? AND organization_id=?", payment.id,access.organizationId)||row("SELECT id FROM clearing_funded_discharges WHERE original_payment_id=? AND organization_id=?",payment.id,access.organizationId)) throw new ApiError(409, "This obligation was retired by clearing. Review its separately recorded discharge rights and any remaining invoice liability", "CLEARED_LIABILITY");
  if (payment.status !== "cancelled" || BigInt(payment.delivered_amount) > 0n || payment.reserved_amount !== "0" || listAttempts(access, payment.id).some((attempt) => !["closed_unfunded", "refunded_verified"].includes(attempt.state))) throw new ApiError(409, "A replacement needs a fully cancelled, unpaid obligation with all delivery attempts closed", "REPLACEMENT_UNSAFE");
}

async function verifyCancellation(access: AccessContext, payment: Payment) {
  assertReplaceable(access, payment);
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) {
    if (listAttempts(access, payment.id).length) throw new ApiError(409, "Connect the original treasury to verify cancellation", "TREASURY_SETUP_REQUIRED");
    return;
  }
  const chain = await view<ChainPayment | null>(config, "get_payment", { payment_id: payment.id });
  if (chain && (chain.status !== "cancelled" || chain.amount !== payment.amount || chain.recipient_id !== payment.recipient_id || chain.attempts.some((attempt) => !["prepared", "discarded", "refunded", "transfer_failed"].includes(attempt.status)))) throw new ApiError(409, "The original NEAR obligation is not conclusively cancelled", "CANCELLATION_UNCONFIRMED");
}

export async function cancelManagedPayment(access: AccessContext, paymentId: string) {
  requirePermission(access, "payments:approve");
  const original = getPayment(access, paymentId);
  if (BigInt(original.delivered_amount) > 0n) throw new ApiError(409, "Delivered funds cannot be cancelled or replaced", "DELIVERY_ALREADY_RECORDED");
  const result = await cancelPayment(access, paymentId);
  if (result.payment.status === "cancelled") await verifyCancellation(access, result.payment);
  return { ...result, cancellationConfirmed: result.payment.status === "cancelled", treasuryNetwork: row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId)?.network ?? null };
}

export async function replaceCancelledPayment(access: AccessContext, paymentId: string, reason: string) {
  requirePermission(access, "payments:prepare");
  const old = getPayment(access, paymentId);
  if (!reason.trim() || reason.length > 1000) throw new ApiError(422, "Record why a fresh obligation is needed", "REPLACEMENT_REASON_REQUIRED");
  const existing = row<Replacement>("SELECT * FROM payment_replacements WHERE old_payment_id=? AND organization_id=?", paymentId, access.organizationId);
  if (existing) return { payment: getPayment(access, existing.new_payment_id), replacedPaymentId: paymentId, alreadyPrepared: true };
  await verifyCancellation(access, old);
  return transaction((db) => {
    const concurrent = row<Replacement>("SELECT * FROM payment_replacements WHERE old_payment_id=? AND organization_id=?", paymentId, access.organizationId);
    if (concurrent) return { payment: getPayment(access, concurrent.new_payment_id), replacedPaymentId: paymentId, alreadyPrepared: true };
    const previous = getPayment(access, paymentId);
    assertReplaceable(access, previous);
    assertSameRecipientOwner(access.organizationId, previous);
    const item = row<Item>("SELECT i.* FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.payment_id=? AND r.organization_id=?", paymentId, access.organizationId);
    const bill = row<{ id: string; reference: string; requires_acceptance: number; milestone_accepted_at: string | null; acceptance_evidence: string | null }>("SELECT id,reference,requires_acceptance,milestone_accepted_at,acceptance_evidence FROM bills WHERE payment_id=? AND organization_id=?", paymentId, access.organizationId);
    const parent = row<Replacement>("SELECT * FROM payment_replacements WHERE new_payment_id=? AND organization_id=?", paymentId, access.organizationId);
    const kind = item ? "payroll_item" : bill ? "bill_installment" : "payment";
    const liabilityId = parent?.liability_id ?? item?.id ?? paymentId;
    const prior = history(access, kind, liabilityId, previous);
    for (const entry of prior.payments) assertReplaceable(access, entry);
    const newIds = new Set(prior.replacements.map((entry) => entry.new_payment_id));
    const original = prior.payments.find((entry) => !newIds.has(entry.id)) ?? previous;
    const consumedCosts = prior.payments.reduce((sum, entry) => sum + BigInt(entry.total_spent), 0n);
    const remainingFee = BigInt(original.max_fee) - consumedCosts;
    if (remainingFee < 0n) throw new ApiError(409, "Prior costs exceeded the original ceiling. Review the liability budget before replacing it", "REPLACEMENT_COST_EXHAUSTED");
    const metadata = JSON.parse(previous.metadata) as Record<string, unknown>;
    if (!item && metadata.runId || !bill && metadata.billId) throw new ApiError(409, "Only the current payment linked to this invoice or pay-period item can be replaced", "PAYMENT_NOT_CURRENT");
    let replacement: Payment;
    if (bill) {
      const terms = addBillInstallment(access, bill.id, { amount: previous.amount, maxFee: remainingFee.toString() });
      replacement = getPayment(access, terms.payment_id!);
      db.prepare("UPDATE payments SET scheduled_for=?,metadata=?,updated_at=? WHERE id=? AND status='draft' AND approved_at IS NULL").run(previous.scheduled_for, JSON.stringify({ ...JSON.parse(replacement.metadata), replacementOf: previous.id, displayReference: metadata.displayReference ?? bill.reference }), now(), replacement.id);
      replacement = getPayment(access, replacement.id);
    } else {
      if (item && BigInt(item.amount) - liabilityPayments(access.organizationId, previous.id).reduce((sum, entry) => sum + BigInt(entry.delivered_amount), 0n) !== BigInt(previous.amount)) throw new ApiError(409, "The unpaid pay-period liability differs from its cancelled obligation", "PAYROLL_LIABILITY_MISMATCH");
      replacement = createPayment(access, { recipientId: previous.recipient_id, reference: `replacement:${previous.id}`, amount: previous.amount, maxFee: remainingFee.toString(), kind: previous.kind, scheduledFor: previous.scheduled_for, metadata: { ...metadata, replacementOf: previous.id, displayReference: metadata.displayReference ?? previous.reference } });
      if (item) {
        db.prepare("UPDATE payroll_items SET payment_id=? WHERE id=? AND payment_id=?").run(replacement.id, item.id, previous.id);
        db.prepare("UPDATE payroll_runs SET status='draft',updated_at=? WHERE id=?").run(now(), item.run_id);
      }
    }
    db.prepare("INSERT INTO payment_replacements(old_payment_id,new_payment_id,organization_id,liability_kind,liability_id,reason_ciphertext,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)").run(previous.id, replacement.id, access.organizationId, kind, liabilityId, encrypt(reason.trim()), access.userId, now());
    audit(access, "payment.replacement_prepared", replacement.id, { oldPaymentId: previous.id, reason, consumedCosts: consumedCosts.toString(), remainingFee: remainingFee.toString(), priorMilestone: bill ? { required: bill.requires_acceptance, acceptedAt: bill.milestone_accepted_at, evidence: bill.acceptance_evidence ? decrypt(bill.acceptance_evidence) : null } : null });
    return { payment: replacement, replacedPaymentId: paymentId, alreadyPrepared: false };
  });
}

export function managementOverview(access: AccessContext) {
  requirePermission(access, "payments:read");
  const payments = rows<Payment>("SELECT p.* FROM payments p WHERE p.organization_id=? AND p.status!='paid' AND NOT EXISTS(SELECT 1 FROM payment_replacements r WHERE r.old_payment_id=p.id) ORDER BY p.created_at DESC", access.organizationId).map((payment) => paymentReview(access, payment));
  return { payments, runs: rows<Run>("SELECT * FROM payroll_runs WHERE organization_id=? ORDER BY created_at DESC", access.organizationId), bills: rows<{ id: string; reference: string; status: string; payment_id: string }>("SELECT id,reference,status,payment_id FROM bills WHERE organization_id=? ORDER BY created_at DESC", access.organizationId), treasuryNetwork: row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId)?.network ?? null };
}

export function managedPaymentReview(access: AccessContext, paymentId: string) {
  requirePermission(access, "payments:read");
  const payment = getPayment(access, paymentId);
  const link = row<Replacement>("SELECT * FROM payment_replacements WHERE organization_id=? AND (old_payment_id=? OR new_payment_id=?) LIMIT 1", access.organizationId, paymentId, paymentId);
  const item = row<{ id: string; run_id: string }>("SELECT i.id,i.run_id FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.payment_id=? AND r.organization_id=?", paymentId, access.organizationId);
  const bill = row<{ id: string }>("SELECT id FROM bills WHERE payment_id=? AND organization_id=?", paymentId, access.organizationId);
  const kind = link?.liability_kind ?? (item ? "payroll_item" : bill ? "bill_installment" : "payment");
  const liabilityId = link?.liability_id ?? item?.id ?? paymentId;
  const old = history(access, kind, liabilityId, payment);
  const attempts = listAttempts(access, paymentId);
  return { ...paymentReview(access, payment), attempts, history: old.payments, replacements: old.replacements.map((entry) => ({ ...entry, reason: decrypt(entry.reason_ciphertext), reason_ciphertext: undefined })), payrollRunId: item?.run_id ?? null, billId: bill?.id ?? null, canReplace: payment.status === "cancelled" && payment.delivered_amount === "0" && !row("SELECT payment_id FROM invoice_credit_retirements WHERE payment_id=? AND organization_id=?",payment.id,access.organizationId) && !row("SELECT id FROM clearing_setoffs WHERE original_payment_id=? AND organization_id=?", payment.id,access.organizationId) && !row("SELECT id FROM clearing_funded_discharges WHERE original_payment_id=? AND organization_id=?",payment.id,access.organizationId) && attempts.every((attempt) => ["closed_unfunded", "refunded_verified"].includes(attempt.state)), treasuryNetwork: row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId)?.network ?? null };
}

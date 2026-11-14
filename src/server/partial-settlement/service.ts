import { createHash, randomUUID } from "node:crypto";
import { treasuryArgs } from "../payments/near";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, transaction } from "../db";
import { encrypt } from "../identity/crypto";
import { getRecipient } from "../identity/recipients";
import { createPayment, getPayment, reconcilePayment, approvePayment } from "../payments/service";
import { approveBill } from "../business/service";
import { paymentReviewToken } from "../payments/approval";
import { getSupportedTokens, nativeUsdc, type StatusResponse } from "../payments/intents";
import type { Payment, PayoutAttempt, TreasuryConfig, WalletTransaction } from "../payments/types";
import { retainPrivateEvidence } from "../reconciliation/evidence";
import { deliveryOutput, digest, liabilityPayments, validateCredit } from "./model";
import { assertSameRecipientOwner } from "../payments/recipient-names";

const now = () => new Date().toISOString();
interface Settlement { payment_id: string; attempt_id: string; actual_output: string; credited_usdc: string; source_spent_usdc: string; receipt_commitment: string; confirmed_at: string }
interface Remainder { original_payment_id: string; remainder_payment_id: string; remaining_usdc: string; created_at: string }
const settlement = (paymentId: string, organizationId: string) => row<Settlement>("SELECT * FROM partial_settlements WHERE payment_id=? AND organization_id=?", paymentId, organizationId);
const remainder = (paymentId: string, organizationId: string) => row<Remainder>("SELECT * FROM partial_remainders WHERE original_payment_id=? AND organization_id=?", paymentId, organizationId);

export function partialReview(access: AccessContext, paymentId: string) {
  const payment = getPayment(access, paymentId), closed = settlement(payment.id, access.organizationId), prepared = remainder(payment.id, access.organizationId);
  const child = prepared ? currentRemainder(access, prepared.remainder_payment_id) : null;
  const attempt = row<Pick<PayoutAttempt,"id"|"state"|"observed_output"|"expected_output"|"destination_asset"|"destination_network"|"destination_decimals"|"destination_symbol"|"destination_tx_hash">>("SELECT id,state,observed_output,expected_output,destination_asset,destination_network,destination_decimals,destination_symbol,destination_tx_hash FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at DESC,id DESC LIMIT 1",paymentId,access.organizationId) ?? null;
  const currentRecipient = getRecipient(access.organizationId, payment.recipient_id);
  const remaining = closed ? (BigInt(payment.amount) - BigInt(closed.credited_usdc)).toString() : null;
  const result = { payment, attempt, settlement: closed ?? null, remainder: child, remaining, currentRecipientVersion: currentRecipient.version, currentRecipientConfirmed: currentRecipient.preference_status === "confirmed" && !currentRecipient.archived, lineage: liabilityPayments(access.organizationId, payment.id).map(item => ({ id: item.id, amount: item.amount, delivered: item.delivered_amount, spent: item.total_spent, status: item.status })) };
  return { ...result, reviewToken: digest({ paymentId, closed, remaining, childToken: child ? paymentReviewToken(child) : null, currentRecipientVersion: currentRecipient.version }) };
}

function currentRemainder(access: AccessContext, paymentId: string) {
  const seen = new Set<string>();
  let current = paymentId;
  while (!seen.has(current) && seen.size < 64) {
    seen.add(current);
    const next = row<{ new_payment_id: string }>("SELECT new_payment_id FROM payment_replacements WHERE old_payment_id=? AND organization_id=?", current, access.organizationId);
    if (!next) return getPayment(access, current);
    current = next.new_payment_id;
  }
  throw new ApiError(409, "The remainder replacement lineage needs review", "PARTIAL_LINEAGE_INVALID");
}

export async function preparePartialSettlement(access: AccessContext, attemptId: string, input: { creditedUSDC: string; receipt: string; valuationNote: string; routeClosed: boolean; reviewConfirmed: boolean }) {
  requirePermission(access, "payments:approve");
  if (!input.routeClosed || !input.reviewConfirmed || input.receipt.trim().length < 3 || input.receipt.length > 1000 || input.valuationNote.trim().length < 3 || input.valuationNote.length > 400) throw new ApiError(422, "Confirm terminal route closure and record the delivery evidence and agreed USDC valuation", "PARTIAL_REVIEW_REQUIRED");
  const before = row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE id=? AND organization_id=?", attemptId, access.organizationId);
  if (!before) throw new ApiError(404, "Payment attempt not found", "NOT_FOUND");
  const reconciled = await reconcilePayment(access, before.payment_id), payment = reconciled.payment, attempt = reconciled.attempt;
  if (payment.status === "partially_paid") return { ...reconciled, walletActions: [] };
  if (!attempt || attempt.id !== attemptId) throw new ApiError(409, "Only the current unresolved attempt can close as a partial delivery", "PARTIAL_ATTEMPT_STALE");
  const evidence = JSON.parse(attempt.reconciliation || "{}");
  const provider = evidence.provider as StatusResponse | null, measured = deliveryOutput(attempt, provider);
  if (!provider || !["SUCCESS", "REFUNDED", "FAILED"].includes(provider.status) || !measured.partial || !measured.actual || !attempt.destination_tx_hash || !evidence.chain?.attempts?.some((value: { id: string; status: string }) => value.id === attemptId && ["source_sent", "uncertain", "refund_pending"].includes(value.status))) throw new ApiError(409, "A matching terminal provider report, positive short output and confirmed NEAR source are required before partial closure", "PARTIAL_DELIVERY_UNVERIFIED");
  validateCredit(payment, attempt, measured.actual, input.creditedUSDC);
  const tokens = await getSupportedTokens();
  const recordedProfile = JSON.parse(payment.recipient_snapshot) as { primary_asset: string };
  let nativeUSDC = attempt.route === "backup" || recordedProfile.primary_asset === "USDC";
  try { nativeUSDC ||= nativeUsdc(tokens, attempt.destination_network).assetId === attempt.destination_asset; } catch {}
  if (nativeUSDC && input.creditedUSDC !== measured.actual) throw new ApiError(422, "Native USDC delivery must credit the exact USDC amount received", "USDC_CREDIT_MISMATCH");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) throw new ApiError(409, "Connect the original NEAR treasury first", "TREASURY_SETUP_REQUIRED");
  const quoteHash = digestQuote(attempt.quote);
  const proof = { version: 1, paymentId: payment.id, attemptId, quoteHash, actualOutput: measured.actual, creditedUSDC: input.creditedUSDC, destinationTransaction: attempt.destination_tx_hash, routeClosed: true, valuationNote: input.valuationNote.trim(), evidence: input.receipt.trim() };
  const receipt = retainPrivateEvidence(access, attemptId, "terminal_partial_settlement", JSON.stringify(proof));
  transaction(db => {
    const current = getPayment(access, payment.id);
    if (current.status === "partially_paid" || current.status === "paid" || current.recipient_version !== payment.recipient_version) throw new ApiError(409, "The payment changed during partial review", "PARTIAL_REVIEW_STALE");
    db.prepare("INSERT INTO partial_settlement_reviews(id,organization_id,payment_id,attempt_id,actual_output,credited_usdc,destination_tx_hash,receipt_commitment,evidence_ciphertext,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(receipt_commitment) DO NOTHING")
      .run(randomUUID(), access.organizationId, payment.id, attemptId, measured.actual, input.creditedUSDC, attempt.destination_tx_hash, receipt, encrypt(JSON.stringify({ ...proof, provider })), access.userId, now());
  });
  const walletActions: WalletTransaction[] = [{ receiverId: config.near_account_id, actions: [{ type: "FunctionCall", params: { methodName: "report_partial_settlement", args: treasuryArgs(config, { payment_id: payment.id, attempt_id: attemptId, expected_quote_hash: quoteHash, actual_output: measured.actual, credited_amount: input.creditedUSDC, route_closed: true, receipt }), gas: "80000000000000", deposit: "0" } }] }];
  return { ...reconciled, walletActions, network: config.network, creditedUSDC: input.creditedUSDC, actualOutput: measured.actual, remainingUSDC: (BigInt(payment.amount) - BigInt(input.creditedUSDC)).toString(), evidenceCommitment: receipt, requiresReporterAttestation: true };
}

function digestQuote(quote: string) {
  return createHash("sha256").update(quote).digest("hex");
}

function assertNoInvoiceCredit(access:AccessContext,paymentId:string){if(row("SELECT b.id FROM bills b JOIN bill_installments i ON i.bill_id=b.id WHERE i.payment_id=? AND b.organization_id=? AND b.accepted_credit_amount!='0'",paymentId,access.organizationId))throw new ApiError(409,"Credited invoice lineages require a separately reviewed ordinary residual installment, not partial-delivery replacement","CREDIT_PARTIAL_REVIEW_REQUIRED");}

export async function createRemainder(access: AccessContext, paymentId: string, input: { reviewToken: string; maxFee: string }) {
  requirePermission(access, "payments:prepare");
  if (!/^(0|[1-9]\d*)$/.test(input.maxFee) || input.maxFee.length > 31 || BigInt(input.maxFee) > 10n ** 30n) throw new ApiError(422, "Review a valid new routing cost ceiling", "INVALID_AMOUNT");
  assertNoInvoiceCredit(access,paymentId);
  await reconcilePayment(access, paymentId);
  return transaction(db => {
    assertNoInvoiceCredit(access,paymentId);
    const review = partialReview(access, paymentId);
    if (review.remainder) return { payment: review.remainder, alreadyPrepared: true };
    if (review.reviewToken !== input.reviewToken || !review.settlement || review.payment.status !== "partially_paid" || !review.remaining || !review.currentRecipientConfirmed) throw new ApiError(409, "Review the terminal partial settlement and current confirmed recipient before preparing a remainder", "PARTIAL_REMAINDER_NOT_READY");
    const parent = review.payment, metadata = JSON.parse(parent.metadata) as Record<string, unknown>;
    assertSameRecipientOwner(access.organizationId, parent);
    const bill = row<{ id: string; payment_id: string | null }>("SELECT b.id,b.payment_id FROM bills b JOIN bill_installments i ON i.bill_id=b.id WHERE i.payment_id=? AND b.organization_id=?", parent.id, access.organizationId);
    const item = row<{ id: string; run_id: string }>("SELECT i.id,i.run_id FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.payment_id=? AND r.organization_id=?", parent.id, access.organizationId);
    if (metadata.billId && bill?.payment_id !== parent.id || metadata.runId && !item) throw new ApiError(409, "The original liability no longer points to this partial payment", "PARTIAL_LIABILITY_STALE");
    const child = createPayment(access, { recipientId: parent.recipient_id, amount: review.remaining, maxFee: input.maxFee, kind: parent.kind, reference: `remainder:${parent.id}`, scheduledFor: null, metadata: { ...metadata, partialOf: parent.id, partialSettlement: review.settlement.receipt_commitment, displayReference: metadata.displayReference ?? parent.reference } });
    db.prepare("INSERT INTO partial_remainders(original_payment_id,organization_id,remainder_payment_id,remaining_usdc,created_by,created_at) VALUES(?,?,?,?,?,?)").run(parent.id, access.organizationId, child.id, review.remaining, access.userId, now());
    if (bill) { db.prepare("INSERT INTO bill_installments(id,bill_id,payment_id,created_at) VALUES(?,?,?,?)").run(randomUUID(), bill.id, child.id, now()); db.prepare("UPDATE bills SET payment_id=?,status='draft',accepted_at=NULL,updated_at=? WHERE id=?").run(child.id, now(), bill.id); }
    if (item) db.prepare("UPDATE payroll_items SET payment_id=? WHERE id=? AND payment_id=?").run(child.id, item.id, parent.id);
    return { payment: child, alreadyPrepared: false };
  });
}

export function approveRemainder(access: AccessContext, paymentId: string, reviewToken: string) {
  requirePermission(access, "payments:approve");
  assertNoInvoiceCredit(access,paymentId);
  return transaction(() => {
    const review = partialReview(access, paymentId), child = review.remainder;
    if (review.reviewToken !== reviewToken || !child || child.amount !== review.remaining || !review.settlement || child.recipient_version !== review.currentRecipientVersion) throw new ApiError(409, "Review the exact remaining entitlement, new fee ceiling and current recipient terms again", "PARTIAL_APPROVAL_STALE");
    const metadata = JSON.parse(child.metadata) as { billId?: string };
    return { payment: metadata.billId ? approveBill(access, metadata.billId) : approvePayment(access, child.id) };
  });
}

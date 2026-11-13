import { createHash } from "node:crypto";
import { row, rows } from "../db";
import type { Payment, PayoutAttempt } from "../payments/types";
import { liabilityPayments } from "../partial-settlement/model";

export interface ReserveRecord {
  id: string; organization_id: string; request_key: string; creation_fingerprint: string;
  amount: string; purpose_ciphertext: string; client_reference_ciphertext: string | null;
  funding_id: string | null; payment_id: string | null; payment_terms_hash: string | null;
  state: string; release_reason_ciphertext: string | null; created_by: string;
  allocated_at: string | null; released_at: string | null; created_at: string; updated_at: string;
}
export interface ReservePosition {
  reserve: ReserveRecord; payment: Payment | null; state: string;
  activePaymentId: string | null;
  outstanding: bigint; clientReserved: bigint; paymentCovered: bigint; inFlight: bigint;
}
const min = (left: bigint, right: bigint) => left < right ? left : right;

export function paymentTermsHash(payment: Payment) {
  return createHash("sha256").update(JSON.stringify({ id: payment.id, organizationId: payment.organization_id, reference: payment.reference, kind: payment.kind,
    recipientId: payment.recipient_id, recipientVersion: payment.recipient_version, recipientSnapshot: payment.recipient_snapshot,
    amount: payment.amount, maxFee: payment.max_fee, metadata: payment.metadata, scheduledFor: payment.scheduled_for })).digest("hex");
}

export function sourceIsUnresolved(payment: Payment): boolean {
  if (["paid", "cancelled", "partially_paid"].includes(payment.status)) return false;
  const attempt = row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at DESC,id DESC LIMIT 1", payment.id, payment.organization_id);
  if (!attempt || ["closed_unfunded", "refunded_verified", "cancelled"].includes(attempt.state)) return false;
  const receipt = row<{ evidence: string }>("SELECT evidence FROM payment_source_receipts WHERE attempt_id=? AND organization_id=?", attempt.id, payment.organization_id);
  let succeeded: boolean | null = null;
  try {
    const proof = receipt ? JSON.parse(receipt.evidence) as { succeeded?: boolean; amount?: string; receiver?: string; finality?: string } : null;
    if (proof?.finality === "FINAL" && proof.amount === attempt.amount_in && proof.receiver === attempt.deposit_address && typeof proof.succeeded === "boolean") succeeded = proof.succeeded;
  } catch {}
  if (succeeded === false) return false;
  try {
    const evidence = JSON.parse(attempt.reconciliation ?? "{}") as { chain?: { id: string; amount: string; recipient_id: string; attempts: { id: string; status: string; route: { input_amount: string; output_amount: string; source_receiver: string; quote_hash: string } }[] } };
    const chain = evidence.chain, matched = chain?.attempts.find((item) => item.id === attempt.id);
    if (matched && ["refunded", "transfer_failed", "discarded"].includes(matched.status)) return false;
    if (chain?.id === payment.id && chain.amount === payment.amount && chain.recipient_id === payment.recipient_id && matched
      && matched.route.input_amount === attempt.amount_in && matched.route.output_amount === attempt.expected_output
      && matched.route.source_receiver === attempt.deposit_address && matched.route.quote_hash === createHash("sha256").update(attempt.quote).digest("hex")
      && ["sending", "source_sent", "uncertain", "refund_pending", "refund_verifying"].includes(matched.status)) return true;
  } catch {}
  return succeeded === true;
}

export function reservePositions(organizationId: string): ReservePosition[] {
  return rows<ReserveRecord>("SELECT * FROM client_reserves WHERE organization_id=? ORDER BY created_at,id", organizationId).map((reserve) => {
    const principal = BigInt(reserve.amount), payment = reserve.payment_id ? row<Payment>("SELECT * FROM payments WHERE id=? AND organization_id=?", reserve.payment_id, organizationId) ?? null : null;
    const termsMatch = !reserve.payment_id || !!payment && payment.amount === reserve.amount && paymentTermsHash(payment) === reserve.payment_terms_hash;
    const lineage = payment ? liabilityPayments(organizationId, payment.id) : [];
    const active = lineage.filter(item => !["paid", "cancelled", "partially_paid"].includes(item.status));
    const delivered = termsMatch && payment ? min(principal, lineage.reduce((sum, item) => sum + BigInt(item.delivered_amount), 0n)) : 0n;
    const outstanding = principal - delivered;
    const result: ReservePosition = { reserve, payment, activePaymentId: active.length === 1 ? active[0].id : null, state: "held", outstanding, clientReserved: outstanding, paymentCovered: 0n, inFlight: 0n };
    if (reserve.state === "released") return { ...result, state: "released", clientReserved: 0n };
    if (reserve.state === "allocating") return { ...result, state: "allocating", clientReserved: 0n };
    if (!termsMatch) return { ...result, state: "terms_changed" };
    if (active.length > 1) return { ...result, state: "ambiguous_lineage" };
    if (outstanding === 0n) return { ...result, state: "closed", clientReserved: 0n };
    if (payment && payment.status !== "cancelled") {
      result.paymentCovered = min(outstanding, active.reduce((sum,item)=>sum+BigInt(item.reserved_amount),0n));
      result.inFlight = active.some(sourceIsUnresolved) ? outstanding - result.paymentCovered : 0n;
      result.clientReserved = outstanding - result.paymentCovered - result.inFlight;
      result.state = result.inFlight > 0n ? "in_flight" : result.clientReserved === 0n ? "payment_reserved" : "held";
    }
    return result;
  });
}

export function clientReserveTotals(organizationId: string) {
  const positions = reservePositions(organizationId).filter((position) => position.reserve.state !== "released");
  return {
    clientReserved: positions.reduce((sum, item) => sum + item.clientReserved, 0n).toString(),
    clientPrincipalOutstanding: positions.reduce((sum, item) => sum + item.outstanding, 0n).toString(),
    clientPrincipalInFlight: positions.reduce((sum, item) => sum + item.inFlight, 0n).toString(),
    clientPrincipalPaymentReserved: positions.reduce((sum, item) => sum + item.paymentCovered, 0n).toString(),
  };
}

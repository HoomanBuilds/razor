import { createHash } from "node:crypto";
import type { Payment } from "./types";

export function paymentReviewToken(payment: Payment): string {
  return createHash("sha256").update(JSON.stringify({ id: payment.id, company: payment.organization_id, recipient: payment.recipient_id, amount: payment.amount, maxFee: payment.max_fee, kind: payment.kind, reference: payment.reference, scheduledFor: payment.scheduled_for, recipientVersion: payment.recipient_version, snapshot: payment.recipient_snapshot, metadata: payment.metadata })).digest("hex");
}

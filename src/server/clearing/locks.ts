import { ApiError } from "../context";
import { row } from "../db";

export function activeClearingRound(organizationId: string, paymentId: string) {
  return row<{ id: string; status: string }>("SELECT r.id,r.status FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id JOIN payments p ON p.id=l.payment_id WHERE l.payment_id=? AND p.organization_id=? AND r.status IN ('prepared','registered','applying') LIMIT 1", paymentId, organizationId) ?? null;
}

export function assertNoActiveClearing(organizationId: string, paymentId: string) {
  if (activeClearingRound(organizationId, paymentId)) throw new ApiError(409, "This invoice is committed to an active clearing round. Reconcile or revoke that round before changing or paying its original obligation", "CLEARING_ROUND_LOCKED");
}

import { ApiError, type AccessContext } from "../context";
import { getDb, row, rows } from "../db";
import { decrypt } from "../identity/crypto";
import type { CommercialTerms } from "./commercial";

interface Award { id: string; organization_id: string; recipient_id: string; commitment_id: string; commitment_version: number; quote_version: number; terms_hash: string; request_id: string }
interface Match { bill_id: string; award_id: string; quantity: string; terms_hash: string; accepted_at: string | null }

export function receivingTotals(awardId: string) {
  const received = rows<{ kind: string; quantity: string }>("SELECT kind,quantity FROM procurement_receipts WHERE award_id=?", awardId);
  const accepted = received.filter(value => value.kind === "accepted").reduce((sum, value) => sum + BigInt(value.quantity), 0n);
  const returned = received.filter(value => value.kind === "returned").reduce((sum, value) => sum + BigInt(value.quantity), 0n);
  const rejected = received.filter(value => value.kind === "rejected").reduce((sum, value) => sum + BigInt(value.quantity), 0n);
  const invoiced = rows<{ quantity: string }>("SELECT quantity FROM procurement_invoice_matches WHERE award_id=? AND accepted_at IS NOT NULL", awardId).reduce((sum, value) => sum + BigInt(value.quantity), 0n);
  return { accepted: accepted.toString(), returned: returned.toString(), rejected: rejected.toString(), netReceived: (accepted - returned).toString(), invoiced: invoiced.toString(), available: (accepted - returned - invoiced).toString(), discrepancy: accepted - returned < invoiced };
}

export function procurementInvoiceReview(organizationId: string, billId: string) {
  const bill = row<{ id: string; recipient_id: string; amount: string; vendor_commitment_id: string | null }>("SELECT id,recipient_id,amount,vendor_commitment_id FROM bills WHERE id=? AND organization_id=?", billId, organizationId);
  if (!bill) return null;
  const match = row<Match>("SELECT * FROM procurement_invoice_matches WHERE bill_id=?", billId);
  const award = match ? row<Award>("SELECT * FROM procurement_awards WHERE id=? AND organization_id=?", match.award_id, organizationId) : row<Award>("SELECT * FROM procurement_awards WHERE commitment_id=? AND organization_id=?", bill.vendor_commitment_id, organizationId);
  if (!award) return null;
  const request = row<{ quantity: string; state: string }>("SELECT quantity,state FROM procurement_requests WHERE id=?", award.request_id)!;
  const quote = row<{ unit_price: string; total: string; commercial_version: number; commercial_terms_ciphertext: string | null }>("SELECT unit_price,total,commercial_version,commercial_terms_ciphertext FROM procurement_quotes WHERE request_id=? AND recipient_id=? AND version=?", award.request_id, award.recipient_id, award.quote_version)!;
  const commercial = quote.commercial_version === 2 && quote.commercial_terms_ciphertext ? JSON.parse(decrypt(quote.commercial_terms_ciphertext)) as CommercialTerms : null;
  const fullInvoiceRequired = !!commercial && BigInt(commercial.fixedCharges) > 0n;
  const commitment = row<{ current_version: number | null }>("SELECT current_version FROM vendor_commitments WHERE id=?", award.commitment_id)!;
  const totals = receivingTotals(award.id), problems: string[] = [];
  if (!match?.accepted_at) {
    if (!match) problems.push("Record the exact procurement invoice quantity before approval");
    if (bill.vendor_commitment_id !== award.commitment_id || bill.recipient_id !== award.recipient_id) problems.push("Invoice supplier or PO differs from the awarded quote");
    if (commitment.current_version !== award.commitment_version) problems.push("The PO changed from the awarded version. Resolve the procurement agreement before payment");
    if (request.state !== "awarded" || match && match.terms_hash !== award.terms_hash) problems.push("The procurement award or invoice match changed");
    if (match && fullInvoiceRequired && (match.quantity !== request.quantity || bill.amount !== quote.total)) problems.push("Fixed quoted taxes or charges require one full-quantity invoice at the exact complete commercial total. Partial charge allocation is unsupported and remains held");
    if (match && !fullInvoiceRequired && BigInt(match.quantity) * BigInt(quote.unit_price) !== BigInt(bill.amount)) problems.push("Invoice value does not equal the awarded unit price and exact invoice quantity");
    if (match && (BigInt(match.quantity) > BigInt(totals.available) || BigInt(match.quantity) + BigInt(totals.invoiced) > BigInt(request.quantity))) problems.push("Invoice quantity exceeds accepted, unreturned and uninvoiced goods or services");
  }
  return { awardId: award.id, quantity: match?.quantity ?? null, unitPrice: quote.unit_price, quoteTotal: quote.total, fullInvoiceRequired, fixedCharges: commercial?.fixedCharges ?? "0", termsHash: award.terms_hash, acceptedAt: match?.accepted_at ?? null, receiving: totals, problems, evidenceBoundary: "Human receiving assertions; no shipping oracle or delivery verification. Fixed-charge quotes require full invoice matching; estimates and excluded charges are not approved spend." };
}

export function consumeProcurementInvoice(access: AccessContext, billId: string) {
  const review = procurementInvoiceReview(access.organizationId, billId);
  if (!review) return;
  if (review.problems.length) throw new ApiError(409, review.problems.join(". "), "PROCUREMENT_RECEIVING_HOLD");
  getDb().prepare("UPDATE procurement_invoice_matches SET accepted_at=COALESCE(accepted_at,?),accepted_by=COALESCE(accepted_by,?) WHERE bill_id=?").run(new Date().toISOString(), access.userId, billId);
}

export function assertProcurementRematch(organizationId: string, billId: string, nextCommitmentId: string) {
  const linked = row<{ commitment_id: string }>("SELECT a.commitment_id FROM procurement_invoice_matches m JOIN procurement_awards a ON a.id=m.award_id WHERE m.bill_id=? AND a.organization_id=?", billId, organizationId)
    ?? row<{ commitment_id: string }>("SELECT a.commitment_id FROM bills b JOIN procurement_awards a ON a.commitment_id=b.vendor_commitment_id WHERE b.id=? AND b.organization_id=?", billId, organizationId);
  if (linked && linked.commitment_id !== nextCommitmentId) throw new ApiError(409, "A procurement-linked invoice cannot remove or replace its awarded PO", "PROCUREMENT_MATCH_LOCKED");
}

import { z } from "zod";
import { parseUnits } from "../../lib/money";
import { createBill } from "../business/service";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { row, transaction } from "../db";
import { getRecipient } from "../identity/recipients";
import { audit, getAccess } from "../identity/session";

const decimalPattern = /^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/;
const decimal = (zero: boolean) => z.string().trim().regex(decimalPattern).refine(value => {
  if (!decimalPattern.test(value)) return false;
  try { const amount = BigInt(parseUnits(value)); return (zero || amount > 0n) && amount <= 10n ** 30n; } catch { return false; }
}, "Use an exact USDC amount with up to six decimal places");

export const reviewedCompanyInvoiceInput = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceKind: z.enum(["text", "pdf", "png", "jpeg"]),
  recipientId: z.string().min(1).max(128), reference: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240), agreedUSDC: decimal(false), maxFeeUSDC: decimal(true),
  dueDate: z.string().date().optional(), reviewConfirmed: z.literal(true),
}).strict();

export function importCompanyInvoice(access: AccessContext, input: unknown) {
  const current = getAccess(access.userId, access.organizationId);
  for (const permission of ["company:read", "payments:read", "payments:prepare", "documents:manage"]) requirePermission(current, permission);
  const terms = reviewedCompanyInvoiceInput.parse(input), recipient = getRecipient(current.organizationId, terms.recipientId);
  if (recipient.archived || recipient.preference_status !== "confirmed" || !recipient.confirmed_at) throw new ApiError(409, "Choose an active confirmed company payee before importing reviewed fields", "RECIPIENT_CONFIRMATION_REQUIRED");
  return transaction(() => {
    const existing = row<{ id: string }>("SELECT id FROM bills WHERE organization_id=? AND recipient_id=? AND reference=?", current.organizationId, recipient.id, terms.reference);
    const bill = createBill(current, { recipientId: recipient.id, reference: terms.reference, title: terms.title,
      amount: parseUnits(terms.agreedUSDC), maxFee: parseUnits(terms.maxFeeUSDC), dueDate: terms.dueDate ? `${terms.dueDate}T00:00:00.000Z` : undefined,
      documentHash: terms.sourceSha256, evidence: `Company-operated review import; company-supplied ${terms.sourceKind} source SHA-256:${terms.sourceSha256}. Raw source and full extraction were not uploaded through this import. The selected fields are human assertions; no hosted inference or independent verification of their plaintext ran for this import.` });
    if (!existing) audit(current.userId, current.organizationId, "company_private.bill_drafted", bill.id, { sourceKind: terms.sourceKind, sourceSha256: terms.sourceSha256 });
    return { billId: bill.id, created: !existing, message: existing ? "This exact import already has a bill. Open Bills to inspect its current approval and payment status." : "Reviewed bill draft created. Company approval and NEAR payment authority remain separate." };
  });
}

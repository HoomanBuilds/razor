import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { assertNoActiveClearing } from "../clearing/locks";
import { assertProcurementRematch, consumeProcurementInvoice, procurementInvoiceReview } from "../procurement/matching";

export const billCommitmentFields = {
  commitmentReference: z.string().trim().min(1).max(120).optional(),
  commitmentDate: z.string().date().optional(),
  commitmentScopeConfirmed: z.boolean().optional(),
};
export const commitmentInput = z.object({
  recipientId: z.string().min(1), reference: z.string().trim().min(1).max(120),
  settlementUnit: z.literal("USDC"), scope: z.string().trim().min(3).max(3000),
  allowance: z.string().regex(/^[0-9]{1,31}$/).refine(value => /^[0-9]{1,31}$/.test(value) && BigInt(value) > 0n && BigInt(value) <= 10n ** 30n, "Enter a positive allowance up to 10^30 microUSDC"),
  cadence: z.enum(["total", "monthly"]), startsOn: z.string().date(), endsOn: z.string().date(),
  targetState: z.enum(["active", "paused", "cancelled"]).default("active"),
  reason: z.string().trim().min(3).max(3000),
}).strict();
type CommitmentInput = z.infer<typeof commitmentInput>;
export type BillCommitmentInput = z.infer<z.ZodObject<typeof billCommitmentFields>>;
interface Commitment { id: string; organization_id: string; recipient_id: string; reference: string; state: string; current_version: number | null; pending_version: number | null; created_at: string; updated_at: string }
interface Version { commitment_id: string; version: number; settlement_unit: string; supplier_version: number; supplier_user_id: string | null; supplier_name_ciphertext: string; scope_ciphertext: string; allowance: string; cadence: "total" | "monthly"; starts_on: string; ends_on: string; target_state: string; reason_ciphertext: string; proposed_by: string; proposed_at: string; approved_by: string | null; approved_at: string | null; withdrawn_by: string | null; withdrawn_at: string | null }
interface Bill { id: string; recipient_id: string; amount: string; status: string; accepted_at: string | null; vendor_commitment_id: string | null; commitment_date: string | null; commitment_scope_confirmed: number; payment_id: string | null; setoff_amount: string; funded_clearing_amount: string; accepted_credit_amount:string }
interface Use { bill_id: string; commitment_id: string; version: number; period_key: string; amount: string; accepted_by: string; accepted_at: string }
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function audit(access: AccessContext, action: string, id: string, details: Record<string, unknown> = {}) {
  getDb().prepare("INSERT INTO activity(id,organization_id,actor_id,action,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), access.organizationId, access.userId, action, id, JSON.stringify(details), now());
}
function commitment(organizationId: string, id: string) {
  const value = row<Commitment>("SELECT * FROM vendor_commitments WHERE organization_id=? AND id=?", organizationId, id);
  if (!value) throw new ApiError(404, "Purchase commitment not found", "COMMITMENT_NOT_FOUND");
  return value;
}
function version(id: string, number: number) {
  return row<Version>("SELECT * FROM vendor_commitment_versions WHERE commitment_id=? AND version=?", id, number)!;
}
function readable(value: Version) {
  const { scope_ciphertext, reason_ciphertext, supplier_name_ciphertext, ...rest } = value;
  return { ...rest, scope: decrypt(scope_ciphertext), reason: decrypt(reason_ciphertext), supplierName: decrypt(supplier_name_ciphertext) };
}
function supplier(organizationId: string, recipientId: string) {
  const result = row<{ version: number; name: string; user_id: string | null; archived: number }>("SELECT version,name,user_id,archived FROM recipients WHERE organization_id=? AND id=?", organizationId, recipientId);
  if (!result) throw new ApiError(404, "Company supplier not found", "NOT_FOUND");
  return { ...result, name: decrypt(result.name) };
}
function useRows(id: string) { return rows<Use>("SELECT * FROM vendor_commitment_uses WHERE commitment_id=? ORDER BY accepted_at,bill_id", id); }
function periodFor(terms: Version, date: string) { return terms.cadence === "monthly" ? date.slice(0, 7) : "total"; }
function usedIn(id: string, period: string) { return useRows(id).filter(use => use.period_key === period).reduce((sum, use) => sum + BigInt(use.amount), 0n); }
function bill(organizationId: string, id: string) {
  const value = row<Bill>("SELECT * FROM bills WHERE organization_id=? AND id=?", organizationId, id);
  if (!value) throw new ApiError(404, "Invoice not found", "NOT_FOUND");
  return value;
}
function settlement(billId: string) {
  const payments = rows<{ amount: string; delivered_amount: string; status: string }>("SELECT p.amount,p.delivered_amount,p.status FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=?", billId);
  return payments.reduce((sum, payment) => sum + BigInt(payment.status === "paid" ? payment.amount : payment.delivered_amount), 0n);
}

export function getCommitment(access: AccessContext, id: string) {
  requirePermission(access, "payments:read");
  const value = commitment(access.organizationId, id), terms = value.current_version ? version(id, value.current_version) : null;
  const uses = useRows(id).map(use => { const invoice = bill(access.organizationId, use.bill_id); return { ...use, paid: settlement(use.bill_id).toString(), setoff: invoice.setoff_amount, fundedClearingAmount: invoice.funded_clearing_amount, acceptedCredit:invoice.accepted_credit_amount }; });
  const period = terms ? periodFor(terms, today()) : "total", used = usedIn(id, period);
  return { ...value, current: terms ? readable(terms) : null, versions: rows<Version>("SELECT * FROM vendor_commitment_versions WHERE commitment_id=? ORDER BY version DESC", id).map(readable), uses,
    period, used: used.toString(), remaining: terms ? (BigInt(terms.allowance) - used).toString() : "0", totalInvoiced: uses.reduce((sum, use) => sum + BigInt(use.amount), 0n).toString(),
    paid: uses.reduce((sum, use) => sum + BigInt(use.paid), 0n).toString(), setoff: uses.reduce((sum, use) => sum + BigInt(use.setoff), 0n).toString(), fundedClearingAmount: uses.reduce((sum, use) => sum + BigInt(use.fundedClearingAmount), 0n).toString(),
    acceptedCredits: uses.reduce((sum,use)=>sum+BigInt(use.acceptedCredit),0n).toString(), supplierProfile: supplier(access.organizationId, value.recipient_id), policy: "payments:approve", enforcement: "application_review_gate", timeBasis: "UTC invoice service date; calendar-month reset; no rollover", cancellationRule: "Accepted invoice value is retained permanently, including after cancellation, dispute, route failure, setoff or accepted supplier credit. Cancellation blocks new invoice commitments.",
  };
}
export function listCommitments(access: AccessContext, search = "") {
  requirePermission(access, "payments:read");
  return rows<{ id: string }>("SELECT id FROM vendor_commitments WHERE organization_id=? AND instr(lower(reference),lower(?))>0 ORDER BY created_at DESC,id LIMIT 200", access.organizationId, search.trim()).map(value => getCommitment(access, value.id));
}
function validateTerms(input: CommitmentInput) {
  if (input.startsOn > input.endsOn) throw new ApiError(422, "The commitment ends before it starts", "COMMITMENT_DATES_INVALID");
}
function saveVersion(access: AccessContext, id: string, number: number, input: CommitmentInput) {
  const profile = supplier(access.organizationId, input.recipientId);
  getDb().prepare("INSERT INTO vendor_commitment_versions(commitment_id,version,settlement_unit,supplier_version,supplier_user_id,supplier_name_ciphertext,scope_ciphertext,allowance,cadence,starts_on,ends_on,target_state,reason_ciphertext,proposed_by,proposed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, number, input.settlementUnit, profile.version, profile.user_id, encrypt(profile.name), encrypt(input.scope), BigInt(input.allowance).toString(), input.cadence, input.startsOn, input.endsOn, input.targetState, encrypt(input.reason), access.userId, now());
  getDb().prepare("UPDATE vendor_commitments SET pending_version=?,updated_at=? WHERE id=?").run(number, now(), id);
}
export function createCommitment(access: AccessContext, data: CommitmentInput) {
  requirePermission(access, "payments:prepare");
  const input = commitmentInput.parse(data); validateTerms(input);
  if (!row("SELECT id FROM recipients WHERE id=? AND organization_id=? AND archived=0", input.recipientId, access.organizationId)) throw new ApiError(404, "Choose an active company supplier", "NOT_FOUND");
  if (input.targetState !== "active") throw new ApiError(422, "Create an active commitment proposal first", "COMMITMENT_STATE_INVALID");
  return transaction(db => {
    if (row("SELECT id FROM vendor_commitments WHERE organization_id=? AND reference=?", access.organizationId, input.reference)) throw new ApiError(409, "This purchase reference already exists", "COMMITMENT_REFERENCE_EXISTS");
    const id = randomUUID();
    db.prepare("INSERT INTO vendor_commitments(id,organization_id,recipient_id,reference,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, access.organizationId, input.recipientId, input.reference, access.userId, now(), now());
    saveVersion(access, id, 1, input); audit(access, "commitment.proposed", id, { version: 1 });
    return getCommitment(access, id);
  });
}
export function amendCommitment(access: AccessContext, id: string, expectedVersion: number, data: CommitmentInput) {
  requirePermission(access, "payments:prepare");
  const input = commitmentInput.parse(data); validateTerms(input);
  return transaction(() => {
    const value = commitment(access.organizationId, id);
    if (value.state === "cancelled") throw new ApiError(409, "A cancelled commitment cannot be reopened. Create a new reference", "COMMITMENT_CANCELLED");
    if (value.pending_version || (value.current_version ?? 0) !== expectedVersion) throw new ApiError(409, "Review the pending proposal or refresh this commitment before amending", "COMMITMENT_CHANGED");
    const previous = expectedVersion ? version(id, expectedVersion) : null;
    if (value.recipient_id !== input.recipientId || value.reference !== input.reference || previous && (previous.cadence !== input.cadence || previous.starts_on !== input.startsOn)) throw new ApiError(422, "Keep the supplier, reference, allowance period and starting date. Create a new commitment for a new agreement", "COMMITMENT_TERMS_FIXED");
    if (previous) assertAllowance(id, { ...previous, allowance: input.allowance, ends_on: input.endsOn });
    const next = row<{ version: number }>("SELECT MAX(version)+1 AS version FROM vendor_commitment_versions WHERE commitment_id=?", id)!.version;
    saveVersion(access, id, next, input); audit(access, "commitment.amendment_proposed", id, { version: next });
    return getCommitment(access, id);
  });
}
export function withdrawCommitmentProposal(access: AccessContext, id: string, pendingVersion: number, reason: string) {
  requirePermission(access, "payments:prepare");
  const explanation = z.string().trim().min(3).max(3000).parse(reason);
  return transaction(db => {
    const value = commitment(access.organizationId, id);
    if (value.pending_version !== pendingVersion) throw new ApiError(409, "Refresh the current pending proposal", "COMMITMENT_CHANGED");
    db.prepare("UPDATE vendor_commitment_versions SET withdrawn_by=?,withdrawn_at=? WHERE commitment_id=? AND version=? AND approved_at IS NULL").run(access.userId, now(), id, pendingVersion);
    db.prepare("UPDATE vendor_commitments SET pending_version=NULL,updated_at=? WHERE id=?").run(now(), id);
    audit(access, "commitment.proposal_withdrawn", id, { version: pendingVersion, reasonCiphertext: encrypt(explanation) });
    return getCommitment(access, id);
  });
}
function assertAllowance(id: string, terms: Version) {
  const grouped = new Map<string, bigint>();
  for (const use of useRows(id)) {
    const invoice = row<{ commitment_date: string }>("SELECT commitment_date FROM bills WHERE id=?", use.bill_id)!;
    if (invoice.commitment_date < terms.starts_on || invoice.commitment_date > terms.ends_on) throw new ApiError(409, "The amended dates would exclude an accepted invoice", "COMMITMENT_BELOW_USE");
    grouped.set(use.period_key, (grouped.get(use.period_key) ?? 0n) + BigInt(use.amount));
  }
  if ([...grouped.values()].some(use => use > BigInt(terms.allowance))) throw new ApiError(409, "The allowance cannot fall below accepted invoice value in any period", "COMMITMENT_BELOW_USE");
}
export function reviewCommitment(access: AccessContext, id: string) {
  const result = getCommitment(access, id);
  return { ...result, reviewToken: digest({ result, date: today() }) };
}
export function approveCommitment(access: AccessContext, id: string, reviewToken: string) {
  requirePermission(access, "payments:approve");
  return transaction(db => {
    const review = reviewCommitment(access, id);
    if (review.reviewToken !== reviewToken) throw new ApiError(409, "The commitment or its use changed. Review the latest proposal", "COMMITMENT_REVIEW_CHANGED");
    if (!review.pending_version) throw new ApiError(409, "There is no pending commitment proposal", "COMMITMENT_NO_PROPOSAL");
    const terms = version(id, review.pending_version); assertAllowance(id, terms);
    if (review.supplierProfile.archived || review.supplierProfile.version !== terms.supplier_version || review.supplierProfile.user_id !== terms.supplier_user_id) throw new ApiError(409, "Supplier details changed after this proposal. Withdraw it and prepare a new reviewed version", "COMMITMENT_SUPPLIER_CHANGED");
    db.prepare("UPDATE vendor_commitment_versions SET approved_by=?,approved_at=? WHERE commitment_id=? AND version=? AND approved_at IS NULL").run(access.userId, now(), id, terms.version);
    db.prepare("UPDATE vendor_commitments SET current_version=?,pending_version=NULL,state=?,updated_at=? WHERE id=?").run(terms.version, terms.target_state, now(), id);
    audit(access, "commitment.approved", id, { version: terms.version, state: terms.target_state, reviewToken });
    return getCommitment(access, id);
  });
}

export function resolveBillCommitment(access: AccessContext, input: BillCommitmentInput) {
  const parsed = z.object(billCommitmentFields).parse(input);
  if (!parsed.commitmentReference) {
    if (parsed.commitmentDate || parsed.commitmentScopeConfirmed) throw new ApiError(422, "Name the purchase commitment for this invoice", "COMMITMENT_REFERENCE_REQUIRED");
    return { id: null, date: null, confirmed: 0 };
  }
  const value = row<Commitment>("SELECT * FROM vendor_commitments WHERE organization_id=? AND reference=?", access.organizationId, parsed.commitmentReference);
  if (!value) throw new ApiError(409, "The named purchase commitment does not exist in this company. Correct the reference or create and approve it", "COMMITMENT_NOT_FOUND");
  if (!parsed.commitmentDate) throw new ApiError(422, "Record the invoice service date in UTC for the named purchase commitment", "COMMITMENT_DATE_REQUIRED");
  return { id: value.id, date: parsed.commitmentDate, confirmed: Number(parsed.commitmentScopeConfirmed === true) };
}

export function billCommitmentReview(organizationId: string, billId: string) {
  const invoice = bill(organizationId, billId);
  if (!invoice.vendor_commitment_id) return null;
  const value = commitment(organizationId, invoice.vendor_commitment_id), currentTerms = value.current_version ? version(value.id, value.current_version) : null;
  const accepted = row<Use>("SELECT * FROM vendor_commitment_uses WHERE bill_id=?", billId);
  const terms = accepted ? version(value.id, accepted.version) : currentTerms;
  const period = terms && invoice.commitment_date ? periodFor(terms, invoice.commitment_date) : null;
  const used = period ? usedIn(value.id, period) : 0n;
  const problems: string[] = [];
  if (value.recipient_id !== invoice.recipient_id) problems.push("The invoice supplier differs from the named commitment");
  if (!accepted) {
    const profile = supplier(organizationId, value.recipient_id);
    if (terms && (profile.archived || profile.version !== terms.supplier_version || profile.user_id !== terms.supplier_user_id)) problems.push("Supplier details changed since the approved purchase version. Prepare and approve an amendment");
    if (value.state !== "active" || !terms?.approved_at) problems.push("The named commitment must be approved and active");
    if (!invoice.commitment_date || !terms || invoice.commitment_date < terms.starts_on || invoice.commitment_date > terms.ends_on || today() < terms.starts_on || today() > terms.ends_on || invoice.commitment_date > today()) problems.push("The commitment or invoice service date is outside the approved dates");
    if (!invoice.commitment_scope_confirmed) problems.push("Confirm that the invoice matches the approved scope and quantities");
    if (terms && used + BigInt(invoice.amount) > BigInt(terms.allowance)) problems.push("The complete invoice exceeds the remaining purchase allowance. Amend and approve the named commitment");
  }
  const procurement = procurementInvoiceReview(organizationId, billId);
  if (procurement) problems.push(...procurement.problems);
  return { id: value.id, reference: value.reference, state: value.state, version: terms?.version ?? null, currentVersion: value.current_version, allowance: currentTerms?.allowance ?? "0", agreedAllowance: terms?.allowance ?? "0", scope: terms ? decrypt(terms.scope_ciphertext) : null,
    supplierName: terms ? decrypt(terms.supplier_name_ciphertext) : null, supplierVersion: terms?.supplier_version ?? null, settlementUnit: "USDC", period, invoiceDate: invoice.commitment_date, scopeConfirmed: !!invoice.commitment_scope_confirmed, used: used.toString(), priorInvoiced: (used - BigInt(accepted?.amount ?? "0")).toString(), remaining: currentTerms ? (BigInt(currentTerms.allowance) - used).toString() : "0", invoiceValue: invoice.amount,
    acceptedCredits: useRows(value.id).reduce((sum,use)=>sum+BigInt(bill(organizationId,use.bill_id).accepted_credit_amount),0n).toString(), paid: useRows(value.id).reduce((sum, use) => sum + settlement(use.bill_id), 0n).toString(), accepted: accepted ?? null, procurement, problems, enforcement: "application_review_gate", timeBasis: "UTC invoice service date; calendar-month reset; no rollover" };
}

export function consumeBillCommitment(access: AccessContext, billId: string) {
  return transaction(db => {
    const review = billCommitmentReview(access.organizationId, billId);
    if (!review) return null;
    requirePermission(access, "payments:approve");
    if (review.problems.length) throw new ApiError(409, review.problems.join(". "), "COMMITMENT_HOLD");
    consumeProcurementInvoice(access, billId);
    if (review.accepted) return review.accepted;
    db.prepare("INSERT INTO vendor_commitment_uses(bill_id,commitment_id,version,period_key,amount,accepted_by,accepted_at) VALUES(?,?,?,?,?,?,?)").run(billId, review.id, review.version!, review.period!, review.invoiceValue, access.userId, now());
    audit(access, "commitment.invoice_accepted", review.id, { billId, amount: review.invoiceValue, period: review.period, version: review.version });
    return row<Use>("SELECT * FROM vendor_commitment_uses WHERE bill_id=?", billId)!;
  });
}

export function matchBillCommitment(access: AccessContext, billId: string, input: BillCommitmentInput & { reason: string }) {
  requirePermission(access, "payments:prepare");
  const reason = z.string().trim().min(3).max(3000).parse(input.reason);
  return transaction(db => {
    const invoice = bill(access.organizationId, billId), resolved = resolveBillCommitment(access, input);
    if (!resolved.id) throw new ApiError(422, "Name the exact purchase commitment to match", "COMMITMENT_REFERENCE_REQUIRED");
    assertProcurementRematch(access.organizationId, billId, resolved.id);
    if (invoice.vendor_commitment_id && invoice.vendor_commitment_id !== resolved.id) requirePermission(access, "payments:approve");
    if (invoice.payment_id) assertNoActiveClearing(access.organizationId, invoice.payment_id);
    if (invoice.accepted_at || invoice.setoff_amount !== "0" || invoice.funded_clearing_amount !== "0" || invoice.accepted_credit_amount !== "0" || row("SELECT bill_id FROM clearing_funded_discharges WHERE organization_id=? AND bill_id=?", access.organizationId, billId) || row("SELECT bill_id FROM vendor_commitment_uses WHERE bill_id=?", billId) || row("SELECT p.id FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND (p.approved_at IS NOT NULL OR p.status NOT IN ('draft','cancelled') OR p.reserved_amount!='0' OR p.total_spent!='0' OR p.delivered_amount!='0' OR EXISTS(SELECT 1 FROM payout_attempts a WHERE a.payment_id=p.id))", billId)) throw new ApiError(409, "Only an invoice that has never been accepted or funded can change its purchase match", "COMMITMENT_MATCH_LOCKED");
    db.prepare("UPDATE bills SET vendor_commitment_id=?,commitment_date=?,commitment_scope_confirmed=?,updated_at=? WHERE id=?").run(resolved.id, resolved.date, resolved.confirmed, now(), billId);
    audit(access, "commitment.invoice_matched", resolved.id, { billId, previousCommitmentId: invoice.vendor_commitment_id, reasonCiphertext: encrypt(reason) });
    return billCommitmentReview(access.organizationId, billId);
  });
}

export function commitmentExport(access: AccessContext) {
  requirePermission(access, "reports:read");
  const cell = (value: unknown) => {
    let text = String(value ?? "").replaceAll("\u0000", "");
    if (/^[\s\u0000-\u001f\u007f\uFEFF]*[=+@-]/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const headers = ["record_type", "commitment_id", "reference", "supplier_id", "supplier_name", "supplier_profile_version", "version", "state", "allowance_micro_usdc", "cadence", "starts_on_utc", "ends_on_utc", "scope", "reason", "proposed_by", "proposed_at", "approved_by", "approved_at", "withdrawn_by", "withdrawn_at", "bill_id", "period", "invoiced_micro_usdc", "paid_micro_usdc", "setoff_micro_usdc", "classification", "funded_clearing_discharge_micro_usdc", "accepted_supplier_credit_micro_usdc"];
  return transaction(() => {
    const records: Record<string, unknown>[] = [];
    for (const value of rows<Commitment>("SELECT * FROM vendor_commitments WHERE organization_id=? ORDER BY created_at,id", access.organizationId)) {
      const common = { commitment_id: value.id, reference: value.reference, supplier_id: value.recipient_id };
      for (const terms of rows<Version>("SELECT * FROM vendor_commitment_versions WHERE commitment_id=? ORDER BY version", value.id)) {
        records.push({ ...common, record_type: "commitment_version", supplier_name: decrypt(terms.supplier_name_ciphertext), supplier_profile_version: terms.supplier_version, version: terms.version, state: terms.target_state,
          allowance_micro_usdc: terms.allowance, cadence: terms.cadence, starts_on_utc: terms.starts_on, ends_on_utc: terms.ends_on, scope: decrypt(terms.scope_ciphertext), reason: decrypt(terms.reason_ciphertext),
          proposed_by: terms.proposed_by, proposed_at: terms.proposed_at, approved_by: terms.approved_by, approved_at: terms.approved_at, withdrawn_by: terms.withdrawn_by, withdrawn_at: terms.withdrawn_at, classification: "application_review_gate; not cash or delivered payment" });
      }
      for (const use of useRows(value.id)) records.push({ ...common, record_type: "accepted_invoice", version: use.version, state: value.state, approved_by: use.accepted_by, approved_at: use.accepted_at,
        bill_id: use.bill_id, period: use.period_key, invoiced_micro_usdc: use.amount, paid_micro_usdc: settlement(use.bill_id).toString(), setoff_micro_usdc: bill(access.organizationId, use.bill_id).setoff_amount, funded_clearing_discharge_micro_usdc: bill(access.organizationId, use.bill_id).funded_clearing_amount, accepted_supplier_credit_micro_usdc: bill(access.organizationId,use.bill_id).accepted_credit_amount, classification: "permanent commercial use; microUSDC" });
    }
    return [headers.map(cell).join(","), ...records.map(record => headers.map(header => cell(record[header])).join(","))].join("\n");
  });
}

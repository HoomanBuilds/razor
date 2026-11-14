import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getAccess, audit } from "../identity/session";
import { getRecipient } from "../identity/recipients";
import { createCommitment, matchBillCommitment } from "../vendor-commitments/service";
import { procurementInvoiceReview, receivingTotals } from "./matching";
import { commercialInput, commercialParameters, commercialTotals, type CommercialTerms } from "./commercial";

const stamp = () => new Date().toISOString();
const quantity = z.string().regex(/^[1-9]\d{0,11}$/);
const moneyPattern = /^[1-9]\d{0,30}$/;
const money = z.string().regex(moneyPattern).refine(value => moneyPattern.test(value) && BigInt(value) <= 10n ** 30n);
const requestKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const text = z.string().trim().min(3).max(3000);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const purchasingPermissions = (permissions: string[]) => ["payments:prepare", "payments:approve"].every(permission => permissions.includes(permission));
export const requestInput = z.object({ reference: z.string().trim().min(1).max(120), specification: text, quantity, unit: z.string().trim().min(1).max(40), budget: money,
  deliveryFrom: z.string().date(), deliveryTo: z.string().date(), quoteDeadline: z.string().datetime(), evidence: text,
  supplierIds: z.array(z.string().min(1).max(128)).min(1).max(20), approvingRoleId: z.string().min(1).max(128), inventoryItemId: z.string().min(1).max(128).optional() }).strict();
const legacyQuoteInput = z.object({ recipientId: z.string().min(1).max(128), expectedVersion: z.number().int().min(0), unitPrice: money, deliveryDate: z.string().date(), validUntil: z.string().datetime(), terms: text }).strict();
export const quoteInput = z.union([legacyQuoteInput, legacyQuoteInput.extend({ payoutProfileVersion: z.number().int().positive(), commercial: commercialInput }).strict()]);
export const receiptInput = z.object({ requestKey, kind: z.enum(["accepted", "rejected", "returned"]), quantity, evidence: text }).strict();
export const inventoryInput = z.object({ sku: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(120), unit: z.string().trim().min(1).max(40), threshold: quantity,
  reorderQuantity: quantity, reorderBudget: money, supplierIds: z.array(z.string().min(1)).min(1).max(20), approvingRoleId: z.string().min(1) }).strict();
interface RequestRow { id: string; organization_id: string; reference: string; specification_ciphertext: string; quantity: string; unit: string; budget: string; delivery_from: string; delivery_to: string; quote_deadline: string; evidence_ciphertext: string; approving_role_id: string; inventory_item_id: string | null; state: string; created_by: string; created_at: string; updated_at: string }
interface QuoteRow { request_id: string; recipient_id: string; version: number; supplier_version: number; supplier_user_id: string; supplier_snapshot_ciphertext: string; unit_price: string; total: string; delivery_date: string; valid_until: string; terms_ciphertext: string; created_at: string; commercial_version: number; commercial_terms_ciphertext: string | null }
interface AwardRow { id: string; request_id: string; organization_id: string; recipient_id: string; quote_version: number; commitment_id: string; commitment_version: number; terms_hash: string; awarded_by: string; awarded_at: string }
interface ItemRow { id: string; organization_id: string; sku: string; name_ciphertext: string; unit: string; on_hand: string; threshold: string; reorder_quantity: string; reorder_budget: string; supplier_ids: string; approving_role_id: string; generation: number; policy_version: number; reorder_error: string | null }
function accessFor(access: AccessContext, permission: string) { const live = getAccess(access.userId, access.organizationId); requirePermission(live, "company:read"); requirePermission(live, permission); return live; }
function requestFor(organizationId: string, id: string) { const value = row<RequestRow>("SELECT * FROM procurement_requests WHERE organization_id=? AND id=?", organizationId, id); if (!value) throw new ApiError(404, "Purchase request not found", "NOT_FOUND"); return value; }
function roleFor(organizationId: string, id: string) {
  const role = row<{ id: string; name: string; permissions_json: string }>("SELECT id,name,permissions_json FROM organization_roles WHERE id=? AND organization_id=? AND archived_at IS NULL", id, organizationId);
  if (!role || !purchasingPermissions(JSON.parse(role.permissions_json))) throw new ApiError(422, "Choose an active purchasing role with both payment preparation and approval permissions", "PROCUREMENT_ROLE_INVALID");
  return role;
}
function assertReviewer(access: AccessContext, request: RequestRow) {
  const live = accessFor(access, "payments:approve"); roleFor(live.organizationId, request.approving_role_id);
  if (!row("SELECT user_id FROM memberships WHERE organization_id=? AND user_id=? AND role_id=? AND status='active'", live.organizationId, live.userId, request.approving_role_id)) throw new ApiError(403, "The RFQ's selected company role must review this action", "PROCUREMENT_REVIEW_ROLE_REQUIRED");
  return live;
}
function supplierFor(organizationId: string, id: string) {
  const value = getRecipient(organizationId, id);
  if (value.archived || value.kind !== "business" || value.preference_status !== "confirmed" || !value.user_id) throw new ApiError(409, "Choose confirmed business suppliers with a linked recipient account", "PROCUREMENT_SUPPLIER_REQUIRED");
  return value;
}
function eligibleSupplier(userId: string, request: RequestRow, recipientId: string) {
  if (!row("SELECT recipient_id FROM procurement_suppliers WHERE request_id=? AND recipient_id=? AND invited_user_id=?", request.id, recipientId, userId)) throw new ApiError(404, "This purchase request is unavailable", "NOT_FOUND");
  const value = supplierFor(request.organization_id, recipientId);
  if (value.user_id !== userId) throw new ApiError(404, "This purchase request is unavailable", "NOT_FOUND");
  return value;
}
function invitationProblems(request: RequestRow) {
  const invitations = rows<{ recipient_id: string; invited_user_id: string | null; user_id: string | null; archived: number; kind: string; preference_status: string }>("SELECT s.recipient_id,s.invited_user_id,r.user_id,r.archived,r.kind,r.preference_status FROM procurement_suppliers s JOIN recipients r ON r.id=s.recipient_id AND r.organization_id=? WHERE s.request_id=?", request.organization_id, request.id);
  if (!invitations.some(value => !value.invited_user_id || value.invited_user_id !== value.user_id || value.archived || value.kind !== "business" || value.preference_status !== "confirmed")) return [];
  return [request.state === "awarded"
    ? "A supplier invitation identity changed or was not captured. Preserve this awarded agreement's liabilities and history. Review its affected PO controls and create a new reviewed RFQ for new supplier work."
    : "A supplier invitation identity changed or was not captured. Cancel this RFQ and create a new reviewed request for the current supplier account. Existing quotes remain historical records."];
}
function publicRequest(value: RequestRow) { const { specification_ciphertext, evidence_ciphertext, ...rest } = value; return { ...rest, specification: decrypt(specification_ciphertext), evidence: decrypt(evidence_ciphertext) }; }
function legacyQuote(value: QuoteRow) { return { request_id: value.request_id, recipient_id: value.recipient_id, version: value.version, supplier_version: value.supplier_version, supplier_user_id: value.supplier_user_id, unit_price: value.unit_price, total: value.total, delivery_date: value.delivery_date, valid_until: value.valid_until, created_at: value.created_at, supplier: JSON.parse(decrypt(value.supplier_snapshot_ciphertext)) as { name: string; asset: string; network: string }, terms: decrypt(value.terms_ciphertext) }; }
function quoteTerms(value: QuoteRow) {
  const commercial = value.commercial_version === 2 && value.commercial_terms_ciphertext ? JSON.parse(decrypt(value.commercial_terms_ciphertext)) as CommercialTerms : null;
  if (value.commercial_version === 2) {
    if (!commercial || !/^[1-9]\d{0,30}$/.test(commercial.lineSubtotal)) throw new ApiError(409, "The exact stored commercial quote is inconsistent", "PROCUREMENT_QUOTE_CHANGED");
    const checked = commercialTotals("1", commercial.lineSubtotal, commercialParameters(commercial));
    if (checked.commercialTotal !== value.total || commercial.commercialTotal !== checked.commercialTotal || commercial.fixedCharges !== checked.fixedCharges) throw new ApiError(409, "The exact stored commercial quote is inconsistent", "PROCUREMENT_QUOTE_CHANGED");
  }
  return commercial;
}
function quoteHashTerms(value: QuoteRow) { const legacy = legacyQuote(value), commercial = quoteTerms(value); return commercial ? { ...legacy, commercialVersion: 2, commercial } : legacy; }
function publicQuote(value: QuoteRow) { const commercial = quoteTerms(value); return { ...legacyQuote(value), commercialVersion: value.commercial_version, commercial, fullTermsHash: digest(quoteHashTerms(value)), priceBoundary: commercial ? "Exact USDC subtotal plus fixed included charges. Excluded charges and supplier conversion estimates are not part of the PO total or a payment cost ceiling." : "Legacy all-inclusive unit price; detailed tax, charge and delivery breakdown was not captured. Original totals and historical award hashes are preserved." }; }
function quoteFor(requestId: string, recipientId: string, version: number) { const quote = row<QuoteRow>("SELECT * FROM procurement_quotes WHERE request_id=? AND recipient_id=? AND version=?", requestId, recipientId, version); if (!quote) throw new ApiError(404, "Quote version not found", "NOT_FOUND"); return quote; }
function awardFor(organizationId: string, id: string) { const value = row<AwardRow>("SELECT * FROM procurement_awards WHERE id=? AND organization_id=?", id, organizationId); if (!value) throw new ApiError(404, "Purchase award not found", "NOT_FOUND"); return value; }
function itemFor(organizationId: string, id: string) { const value = row<ItemRow>("SELECT * FROM procurement_inventory WHERE id=? AND organization_id=?", id, organizationId); if (!value) throw new ApiError(404, "Inventory item not found", "NOT_FOUND"); return value; }

export function createRequest(access: AccessContext, data: unknown) {
  const live = accessFor(access, "payments:prepare"), input = requestInput.parse(data);
  if (input.deliveryFrom > input.deliveryTo || Date.parse(input.quoteDeadline) <= Date.now() || input.quoteDeadline.slice(0, 10) > input.deliveryTo) throw new ApiError(422, "Choose future quote terms and an ordered delivery window", "PROCUREMENT_DATES_INVALID");
  if (new Set(input.supplierIds).size !== input.supplierIds.length) throw new ApiError(422, "Select each eligible supplier once", "PROCUREMENT_SUPPLIERS_DUPLICATE");
  roleFor(live.organizationId, input.approvingRoleId); const suppliers = input.supplierIds.map(id => supplierFor(live.organizationId, id));
  if (input.inventoryItemId && itemFor(live.organizationId, input.inventoryItemId).unit !== input.unit) throw new ApiError(422, "Use the inventory item's exact unit", "PROCUREMENT_UNIT_MISMATCH");
  return transaction(db => {
    if (row("SELECT id FROM procurement_requests WHERE organization_id=? AND reference=?", live.organizationId, input.reference)) throw new ApiError(409, "This purchase request reference already exists", "PROCUREMENT_REFERENCE_EXISTS");
    const id = randomUUID(), at = stamp();
    db.prepare("INSERT INTO procurement_requests(id,organization_id,reference,specification_ciphertext,quantity,unit,budget,delivery_from,delivery_to,quote_deadline,evidence_ciphertext,approving_role_id,inventory_item_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, live.organizationId, input.reference, encrypt(input.specification), input.quantity, input.unit, input.budget, input.deliveryFrom, input.deliveryTo, input.quoteDeadline, encrypt(input.evidence), input.approvingRoleId, input.inventoryItemId ?? null, live.userId, at, at);
    for (const supplier of suppliers) db.prepare("INSERT INTO procurement_suppliers(request_id,recipient_id,invited_user_id) VALUES(?,?,?)").run(id, supplier.id, supplier.user_id);
    audit(live.userId, live.organizationId, "procurement.request_created", id); return inspectRequest(live, id);
  });
}
export function inspectRequest(access: AccessContext, id: string) {
  const live = accessFor(access, "payments:read"), value = requestFor(live.organizationId, id);
  const quotes = rows<QuoteRow>("SELECT * FROM procurement_quotes WHERE request_id=? ORDER BY recipient_id,version DESC", id).map(publicQuote);
  const award = row<AwardRow>("SELECT * FROM procurement_awards WHERE request_id=?", id);
  const receipts = award ? rows<{ id: string; kind: string; quantity: string; evidence_ciphertext: string; created_by: string; created_at: string }>("SELECT id,kind,quantity,evidence_ciphertext,created_by,created_at FROM procurement_receipts WHERE award_id=? ORDER BY created_at,id", award.id).map(({ evidence_ciphertext, ...receipt }) => ({ ...receipt, evidence: decrypt(evidence_ciphertext) })) : [];
  const roleRecord = row<{ id: string; name: string; archived_at: string | null; permissions_json: string }>("SELECT id,name,archived_at,permissions_json FROM organization_roles WHERE organization_id=? AND id=?", live.organizationId, value.approving_role_id)!;
  const { permissions_json, ...role } = roleRecord;
  const purchase = award ? row<{ reference: string; state: string; current_version: number | null }>("SELECT reference,state,current_version FROM vendor_commitments WHERE id=?", award.commitment_id)! : null;
  const result = { ...publicRequest(value), role, reviewRoleEligible: !role.archived_at && purchasingPermissions(JSON.parse(permissions_json)), invitationProblems: invitationProblems(value), supplierIds: rows<{ recipient_id: string }>("SELECT recipient_id FROM procurement_suppliers WHERE request_id=? ORDER BY recipient_id", id).map(supplier => supplier.recipient_id), quotes, award: award ? { ...award, purchaseReference: purchase!.reference, poState: purchase!.state, poVersion: purchase!.current_version, receiving: receivingTotals(award.id) } : null, receipts };
  return { ...result, reviewToken: digest(result) };
}
export function publishRequest(access: AccessContext, id: string, reviewToken: string) {
  return transaction(db => {
    const value = requestFor(access.organizationId, id), live = assertReviewer(access, value), review = inspectRequest(live, id);
    if (value.state !== "draft" || review.reviewToken !== reviewToken) throw new ApiError(409, "Review the current unpublished request", "PROCUREMENT_REVIEW_CHANGED");
    if (review.invitationProblems.length) throw new ApiError(409, review.invitationProblems.join(". "), "PROCUREMENT_INVITATION_REVIEW_REQUIRED");
    for (const supplier of review.supplierIds) supplierFor(live.organizationId, supplier);
    if (value.quote_deadline <= stamp()) throw new ApiError(409, "The quote deadline passed", "PROCUREMENT_DEADLINE");
    db.prepare("UPDATE procurement_requests SET state='open',updated_at=? WHERE id=?").run(stamp(), id); audit(live.userId, live.organizationId, "procurement.request_published", id); return inspectRequest(live, id);
  });
}
export function cancelRequest(access: AccessContext, id: string, reason: string) {
  const note = text.parse(reason);
  return transaction(db => { const value = requestFor(access.organizationId, id), live = accessFor(access, "payments:read");
    if (!live.permissions.includes("company:manage")) assertReviewer(live, value);
    if (value.state === "awarded") throw new ApiError(409, "An awarded agreement retains its PO, receiving and payment history. Use its dispute and PO controls", "PROCUREMENT_ALREADY_AWARDED");
    db.prepare("UPDATE procurement_requests SET state='cancelled',updated_at=? WHERE id=?").run(stamp(), id); audit(live.userId, live.organizationId, "procurement.request_cancelled", id, { reasonCiphertext: encrypt(note) }); return inspectRequest(live, id); });
}
export function supplierRequests(userId: string) {
  return rows<RequestRow & { recipient_id: string; company_name: string; invitation_active: number }>(`SELECT q.*,s.recipient_id,o.name AS company_name,
    (s.invited_user_id=? AND r.user_id=? AND r.kind='business' AND r.archived=0 AND r.preference_status='confirmed' AND q.state IN ('open','awarded')) AS invitation_active
    FROM procurement_requests q JOIN procurement_suppliers s ON s.request_id=q.id JOIN recipients r ON r.id=s.recipient_id AND r.organization_id=q.organization_id JOIN organizations o ON o.id=q.organization_id
    WHERE (s.invited_user_id=? AND r.user_id=? AND r.kind='business' AND r.archived=0 AND r.preference_status='confirmed' AND q.state IN ('open','awarded'))
    OR EXISTS(SELECT 1 FROM procurement_quotes h WHERE h.request_id=q.id AND h.recipient_id=s.recipient_id AND h.supplier_user_id=?)
    ORDER BY q.created_at DESC,q.id LIMIT 100`, userId, userId, userId, userId, userId).map(value => {
    const { recipient_id, company_name, invitation_active, ...request } = value;
    const role = row<{ permissions_json: string }>("SELECT permissions_json FROM organization_roles WHERE id=? AND organization_id=? AND archived_at IS NULL", request.approving_role_id, request.organization_id);
    const payout = invitation_active ? eligibleSupplier(userId, request, recipient_id) : null;
    return { ...publicRequest(request), recipientId: recipient_id, companyName: company_name, historicalOnly: !invitation_active, reviewerActive: !!role && purchasingPermissions(JSON.parse(role.permissions_json)), payoutProfile: payout ? { recipientId: payout.id, version: payout.version, asset: payout.primary_asset, network: payout.primary_network } : null,
      quotes: rows<QuoteRow>("SELECT * FROM procurement_quotes WHERE request_id=? AND recipient_id=? AND supplier_user_id=? ORDER BY version DESC", request.id, recipient_id, userId).map(publicQuote),
      awardedToYou: !!row("SELECT a.id FROM procurement_awards a JOIN procurement_quotes q ON q.request_id=a.request_id AND q.recipient_id=a.recipient_id AND q.version=a.quote_version WHERE a.request_id=? AND a.recipient_id=? AND q.supplier_user_id=?", request.id, recipient_id, userId),
      visibility: invitation_active ? "Only your quotes are shown. Receiving and payment records remain in your ordinary recipient workspace." : "Historical access to your own quote submissions only. This receiving profile no longer grants new invitation or quoting authority." };
  });
}
export function submitQuote(userId: string, requestId: string, data: unknown) {
  const input = quoteInput.parse(data);
  return transaction(db => {
    const request = row<RequestRow>("SELECT * FROM procurement_requests WHERE id=?", requestId);
    if (!request) throw new ApiError(404, "Purchase request not found", "NOT_FOUND");
    const supplier = eligibleSupplier(userId, request, input.recipientId);
    roleFor(request.organization_id, request.approving_role_id);
    if (request.state !== "open" || request.quote_deadline <= stamp()) throw new ApiError(409, "This RFQ no longer accepts quote revisions", "PROCUREMENT_QUOTES_CLOSED");
    const previous = row<{ version: number }>("SELECT MAX(version) AS version FROM procurement_quotes WHERE request_id=? AND recipient_id=?", requestId, input.recipientId)?.version ?? 0;
    if (previous !== input.expectedVersion) throw new ApiError(409, "Another quote revision was saved. Refresh before revising", "PROCUREMENT_QUOTE_CHANGED");
    if (previous >= 20) throw new ApiError(409, "This supplier reached twenty quote versions for this RFQ. Ask the company to create a new sourcing request", "PROCUREMENT_QUOTE_LIMIT");
    if (input.deliveryDate < request.delivery_from || input.deliveryDate > request.delivery_to) throw new ApiError(422, "The quote delivery date is outside the RFQ window", "PROCUREMENT_DELIVERY_INVALID");
    if (input.validUntil <= stamp() || input.validUntil.slice(0, 10) > request.delivery_to) throw new ApiError(422, "Choose quote validity before the delivery window ends", "PROCUREMENT_QUOTE_EXPIRY");
    const commercial = "commercial" in input ? commercialTotals(request.quantity, input.unitPrice, input.commercial) : null;
    if ("payoutProfileVersion" in input && input.payoutProfileVersion !== supplier.version) throw new ApiError(409, "The actual confirmed payout profile changed. Refresh its asset and network before revising the quote", "PROCUREMENT_PAYOUT_CHANGED");
    const total = commercial ? BigInt(commercial.commercialTotal) : BigInt(request.quantity) * BigInt(input.unitPrice);
    if (total > BigInt(request.budget) || total > 10n ** 30n) throw new ApiError(422, "The all-inclusive quote exceeds the RFQ budget", "PROCUREMENT_BUDGET_EXCEEDED");
    db.prepare("INSERT INTO procurement_quotes(request_id,recipient_id,version,supplier_version,supplier_user_id,supplier_snapshot_ciphertext,unit_price,total,delivery_date,valid_until,terms_ciphertext,created_at,commercial_version,commercial_terms_ciphertext) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(requestId, input.recipientId, previous + 1, supplier.version, userId, encrypt(JSON.stringify({ name: supplier.name, asset: supplier.primary_asset, network: supplier.primary_network })), input.unitPrice, total.toString(), input.deliveryDate, input.validUntil, encrypt(input.terms), stamp(), commercial ? 2 : 1, commercial ? encrypt(JSON.stringify(commercial)) : null);
    audit(userId, request.organization_id, "procurement.quote_submitted", requestId, { recipientId: input.recipientId, version: previous + 1 }); return publicQuote(quoteFor(requestId, input.recipientId, previous + 1));
  });
}
export function awardQuote(access: AccessContext, id: string, data: unknown) {
  const parsed = z.object({ recipientId: z.string().min(1), quoteVersion: z.number().int().positive(), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), purchaseReference: z.string().trim().min(1).max(120), quoteTermsHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), commercialAcknowledged: z.literal(true).optional() }).strict().parse(data);
  return transaction(db => {
    const request = requestFor(access.organizationId, id), live = assertReviewer(access, request); requirePermission(live, "payments:prepare");
    const existing = row<AwardRow>("SELECT * FROM procurement_awards WHERE request_id=?", id);
    if (existing) { if (existing.recipient_id !== parsed.recipientId || existing.quote_version !== parsed.quoteVersion || !row("SELECT id FROM vendor_commitments WHERE id=? AND reference=?", existing.commitment_id, parsed.purchaseReference)) throw new ApiError(409, "This RFQ already has a different award", "PROCUREMENT_ALREADY_AWARDED"); return inspectRequest(live, id); }
    const review = inspectRequest(live, id), quote = quoteFor(id, parsed.recipientId, parsed.quoteVersion), supplier = supplierFor(live.organizationId, parsed.recipientId);
    if (request.state !== "open" || review.reviewToken !== parsed.reviewToken) throw new ApiError(409, "Review the latest RFQ and quotes before award", "PROCUREMENT_REVIEW_CHANGED");
    if (!row("SELECT recipient_id FROM procurement_suppliers WHERE request_id=? AND recipient_id=? AND invited_user_id=?", id, parsed.recipientId, supplier.user_id)) throw new ApiError(409, "Supplier invitation ownership changed or was not captured. Cancel this RFQ and create a new reviewed invitation", "PROCUREMENT_INVITATION_REVIEW_REQUIRED");
    if (quote.valid_until <= stamp() || request.delivery_to < stamp().slice(0, 10)) throw new ApiError(409, "This quote expired before award. Request a new valid revision", "PROCUREMENT_QUOTE_EXPIRED");
    if (quote.version !== row<{ version: number }>("SELECT MAX(version) AS version FROM procurement_quotes WHERE request_id=? AND recipient_id=?", id, parsed.recipientId)!.version || quote.supplier_version !== supplier.version || quote.supplier_user_id !== supplier.user_id) throw new ApiError(409, "Supplier details or quote revision changed", "PROCUREMENT_QUOTE_CHANGED");
    const commercial = quoteTerms(quote), fullHash = digest(quoteHashTerms(quote));
    if (commercial && (parsed.quoteTermsHash !== fullHash || !parsed.commercialAcknowledged)) throw new ApiError(409, "Explicitly review this full commercial quote, exclusions and supplier-only conversion estimate before award", "PROCUREMENT_COMMERCIAL_REVIEW_REQUIRED");
    if (BigInt(quote.total) > BigInt(request.budget) || commercial && (commercialTotals(request.quantity, quote.unit_price, commercialParameters(commercial)).commercialTotal !== quote.total)) throw new ApiError(409, "The quote no longer matches its exact commercial total and RFQ budget", "PROCUREMENT_BUDGET_EXCEEDED");
    const requestTerms = commercial ? { id, quantity: request.quantity, unit: request.unit, budget: request.budget, specification: review.specification, deliveryFrom: request.delivery_from, deliveryTo: request.delivery_to, quoteDeadline: request.quote_deadline, requiredEvidence: review.evidence, organizationId: request.organization_id, approvingRoleId: request.approving_role_id } : { id, quantity: request.quantity, unit: request.unit, budget: request.budget, specification: review.specification };
    const sourceHash = digest({ request: requestTerms, quote: quoteHashTerms(quote) });
    const scope = commercial ? `RFQ ${request.reference}, quote ${quote.version}. Quantity: ${request.quantity} ${request.unit}. Exact commercial total: ${quote.total} microUSDC. Full immutable RFQ and commercial source SHA-256: ${sourceHash}. Review all source conditions in Purchasing. Excluded charges and indicative supplier conversion costs are not included in this PO allowance and require separate commercial approval.\nSpecification: ${review.specification.slice(0, 1000)}` : `${review.specification}\nQuantity: ${request.quantity} ${request.unit}\n${decrypt(quote.terms_ciphertext)}`;
    const commitment = createCommitment(live, { recipientId: parsed.recipientId, reference: parsed.purchaseReference, settlementUnit: "USDC", scope, allowance: quote.total, cadence: "total", startsOn: stamp().slice(0, 10), endsOn: request.delivery_to, targetState: "active", reason: `Human-reviewed award of ${request.reference}, quote ${quote.version}` });
    const termsHash = digest({ request: requestTerms, quote: quoteHashTerms(quote), commitmentId: commitment.id, commitmentVersion: 1 });
    const awardId = randomUUID();
    db.prepare("INSERT INTO procurement_awards(id,request_id,organization_id,recipient_id,quote_version,commitment_id,commitment_version,terms_hash,awarded_by,awarded_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(awardId, id, live.organizationId, parsed.recipientId, parsed.quoteVersion, commitment.id, 1, termsHash, live.userId, stamp());
    db.prepare("UPDATE procurement_requests SET state='awarded',updated_at=? WHERE id=?").run(stamp(), id); audit(live.userId, live.organizationId, "procurement.quote_awarded", awardId, { commitmentId: commitment.id, termsHash }); return inspectRequest(live, id);
  });
}
export function recordReceipt(access: AccessContext, awardId: string, data: unknown) {
  const input = receiptInput.parse(data);
  return transaction(db => {
    const award = awardFor(access.organizationId, awardId), request = requestFor(access.organizationId, award.request_id), live = assertReviewer(access, request);
    const previous = row<{ id: string; award_id: string; kind: string; quantity: string; evidence_ciphertext: string }>("SELECT * FROM procurement_receipts WHERE organization_id=? AND request_key=?", live.organizationId, input.requestKey);
    if (previous) { if (previous.award_id !== awardId || previous.kind !== input.kind || previous.quantity !== input.quantity || decrypt(previous.evidence_ciphertext) !== input.evidence) throw new ApiError(409, "Receipt request identity already has different terms", "PROCUREMENT_RECEIPT_CHANGED"); return inspectRequest(live, request.id); }
    const totals = receivingTotals(awardId);
    if (BigInt(input.quantity) > BigInt(request.quantity) || input.kind === "accepted" && BigInt(totals.netReceived) + BigInt(input.quantity) > BigInt(request.quantity) || input.kind === "returned" && BigInt(input.quantity) > BigInt(totals.netReceived)) throw new ApiError(422, "Receiving or return quantity exceeds the agreed available quantity", "PROCUREMENT_RECEIPT_QUANTITY");
    if (!row("SELECT id FROM vendor_commitments WHERE id=? AND current_version=? AND state='active'", award.commitment_id, award.commitment_version)) throw new ApiError(409, "Approve the exact awarded PO version before receiving", "PROCUREMENT_PO_REQUIRED");
    const id = randomUUID(); db.prepare("INSERT INTO procurement_receipts(id,award_id,organization_id,request_key,kind,quantity,evidence_ciphertext,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, awardId, live.organizationId, input.requestKey, input.kind, input.quantity, encrypt(input.evidence), live.userId, stamp());
    if (request.inventory_item_id && input.kind !== "rejected") changeStock(live, request.inventory_item_id, { requestKey: `receipt:${id}`, delta: input.kind === "returned" ? `-${input.quantity}` : input.quantity, reason: `Human ${input.kind} receiving assertion for ${request.reference}` });
    audit(live.userId, live.organizationId, "procurement.receiving_recorded", id, { awardId, kind: input.kind, quantity: input.quantity }); return inspectRequest(live, request.id);
  });
}
export function matchInvoice(access: AccessContext, awardId: string, data: unknown) {
  const live = accessFor(access, "payments:prepare"), input = z.object({ billId: z.string().min(1), quantity, invoiceDate: z.string().date(), reason: text }).strict().parse(data);
  return transaction(db => {
    const award = awardFor(live.organizationId, awardId), bill = row<{ recipient_id: string; amount: string; accepted_at: string | null }>("SELECT recipient_id,amount,accepted_at FROM bills WHERE id=? AND organization_id=?", input.billId, live.organizationId);
    if (!bill || bill.recipient_id !== award.recipient_id) throw new ApiError(409, "Match this awarded supplier's exact company invoice", "PROCUREMENT_SUPPLIER_MISMATCH");
    const existing = row<{ award_id: string; accepted_at: string | null }>("SELECT award_id,accepted_at FROM procurement_invoice_matches WHERE bill_id=?", input.billId);
    if (bill.accepted_at || existing?.accepted_at || existing && existing.award_id !== awardId) throw new ApiError(409, "An accepted or differently awarded invoice keeps its original match", "PROCUREMENT_MATCH_LOCKED");
    const commitment = row<{ reference: string }>("SELECT reference FROM vendor_commitments WHERE id=?", award.commitment_id)!;
    matchBillCommitment(live, input.billId, { commitmentReference: commitment.reference, commitmentDate: input.invoiceDate, commitmentScopeConfirmed: true, reason: input.reason });
    db.prepare("INSERT INTO procurement_invoice_matches(bill_id,award_id,quantity,terms_hash,matched_by,matched_at) VALUES(?,?,?,?,?,?) ON CONFLICT(bill_id) DO UPDATE SET quantity=excluded.quantity,matched_by=excluded.matched_by,matched_at=excluded.matched_at WHERE procurement_invoice_matches.accepted_at IS NULL")
      .run(input.billId, awardId, input.quantity, award.terms_hash, live.userId, stamp());
    audit(live.userId, live.organizationId, "procurement.invoice_matched", input.billId, { awardId, quantity: input.quantity, reasonCiphertext: encrypt(input.reason) }); return procurementInvoiceReview(live.organizationId, input.billId);
  });
}
function inventoryProjection(value: ItemRow) { const { name_ciphertext, supplier_ids, ...rest } = value; return { ...rest, name: decrypt(name_ciphertext), supplierIds: JSON.parse(supplier_ids) as string[], reorder: row<{ request_id: string }>("SELECT request_id FROM procurement_reorders WHERE item_id=? AND generation=?", value.id, value.generation)?.request_id ?? null }; }
function ensureReorder(access: AccessContext, item: ItemRow) {
  if (BigInt(item.on_hand) >= BigInt(item.threshold) || row("SELECT request_id FROM procurement_reorders WHERE item_id=? AND generation=?", item.id, item.generation)) return;
  try {
    transaction(db => {
      const from = new Date(Date.now() + 86400000).toISOString().slice(0, 10), until = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const request = createRequest(access, { reference: `stock:${item.id}:${item.generation}`, specification: `Replenish ${decrypt(item.name_ciphertext)} (${item.sku})`, quantity: item.reorder_quantity, unit: item.unit, budget: item.reorder_budget, deliveryFrom: from, deliveryTo: until, quoteDeadline: new Date(Date.now() + 7 * 86400000).toISOString(), evidence: "Human receiving confirmation required before invoice approval", supplierIds: JSON.parse(item.supplier_ids), approvingRoleId: item.approving_role_id, inventoryItemId: item.id });
      db.prepare("INSERT INTO procurement_reorders(item_id,generation,request_id) VALUES(?,?,?)").run(item.id, item.generation, request.id); db.prepare("UPDATE procurement_inventory SET reorder_error=NULL WHERE id=?").run(item.id);
    });
  } catch (error) { if (!(error instanceof ApiError)) throw error; getDb().prepare("UPDATE procurement_inventory SET reorder_error=? WHERE id=?").run(error.code, item.id); }
}
export function createInventory(access: AccessContext, data: unknown) {
  const live = accessFor(access, "company:manage"), input = inventoryInput.parse(data); requirePermission(live, "payments:prepare");
  roleFor(live.organizationId, input.approvingRoleId); for (const supplier of input.supplierIds) supplierFor(live.organizationId, supplier);
  return transaction(db => { if (row("SELECT id FROM procurement_inventory WHERE organization_id=? AND sku=?", live.organizationId, input.sku)) throw new ApiError(409, "This SKU already exists", "PROCUREMENT_SKU_EXISTS");
    const id = randomUUID(); db.prepare("INSERT INTO procurement_inventory(id,organization_id,sku,name_ciphertext,unit,threshold,reorder_quantity,reorder_budget,supplier_ids,approving_role_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, live.organizationId, input.sku, encrypt(input.name), input.unit, input.threshold, input.reorderQuantity, input.reorderBudget, JSON.stringify([...new Set(input.supplierIds)]), input.approvingRoleId, live.userId, stamp());
    ensureReorder(live, itemFor(live.organizationId, id)); audit(live.userId, live.organizationId, "procurement.inventory_created", id); return inventoryProjection(itemFor(live.organizationId, id)); });
}
const adjustmentInput = z.object({ requestKey, delta: z.string().regex(/^-?[1-9]\d{0,11}$/), reason: text }).strict();
function changeStock(live: AccessContext, itemId: string, data: unknown) {
  const input = adjustmentInput.parse(data);
  return transaction(db => { const item = itemFor(live.organizationId, itemId), previous = row<{ item_id: string; delta: string; reason_ciphertext: string }>("SELECT * FROM procurement_stock_changes WHERE organization_id=? AND request_key=?", live.organizationId, input.requestKey);
    if (previous) { if (previous.item_id !== itemId || previous.delta !== input.delta || decrypt(previous.reason_ciphertext) !== input.reason) throw new ApiError(409, "This stock adjustment already has different terms", "PROCUREMENT_STOCK_CHANGED"); return inventoryProjection(item); }
    const next = BigInt(item.on_hand) + BigInt(input.delta); if (next < 0n || next > 999999999999n) throw new ApiError(422, "Stock must remain between zero and 999999999999 units", "PROCUREMENT_STOCK_RANGE");
    const generation = item.generation + Number(BigInt(item.on_hand) >= BigInt(item.threshold) && next < BigInt(item.threshold));
    db.prepare("INSERT INTO procurement_stock_changes(id,item_id,organization_id,request_key,delta,reason_ciphertext,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), itemId, live.organizationId, input.requestKey, input.delta, encrypt(input.reason), live.userId, stamp());
    db.prepare("UPDATE procurement_inventory SET on_hand=?,generation=? WHERE id=?").run(next.toString(), generation, itemId); ensureReorder(live, itemFor(live.organizationId, itemId)); audit(live.userId, live.organizationId, "procurement.stock_adjusted", itemId, { delta: input.delta }); return inventoryProjection(itemFor(live.organizationId, itemId)); });
}
export function adjustStock(access: AccessContext, itemId: string, data: unknown) { return changeStock(accessFor(access, "payments:prepare"), itemId, data); }
export function updateInventory(access: AccessContext, itemId: string, data: unknown) {
  const live = accessFor(access, "company:manage"), input = inventoryInput.extend({ expectedVersion: z.number().int().positive() }).parse(data); requirePermission(live, "payments:prepare");
  roleFor(live.organizationId, input.approvingRoleId); for (const supplier of input.supplierIds) supplierFor(live.organizationId, supplier);
  return transaction(db => {
    const item = itemFor(live.organizationId, itemId);
    if (item.policy_version !== input.expectedVersion) throw new ApiError(409, "The inventory policy changed. Refresh before saving", "PROCUREMENT_INVENTORY_CHANGED");
    if (item.sku !== input.sku || item.unit !== input.unit) throw new ApiError(422, "Keep this item's SKU and unit; create another item for a different stock identity", "PROCUREMENT_INVENTORY_IDENTITY");
    const generation = item.generation + Number(BigInt(item.on_hand) >= BigInt(item.threshold) && BigInt(item.on_hand) < BigInt(input.threshold));
    db.prepare("UPDATE procurement_inventory SET name_ciphertext=?,threshold=?,reorder_quantity=?,reorder_budget=?,supplier_ids=?,approving_role_id=?,generation=?,policy_version=policy_version+1 WHERE id=?")
      .run(encrypt(input.name), input.threshold, input.reorderQuantity, input.reorderBudget, JSON.stringify([...new Set(input.supplierIds)]), input.approvingRoleId, generation, itemId);
    ensureReorder(live, itemFor(live.organizationId, itemId)); audit(live.userId, live.organizationId, "procurement.inventory_policy_updated", itemId, { previousVersion: item.policy_version }); return inventoryProjection(itemFor(live.organizationId, itemId));
  });
}
export function overview(access: AccessContext, search = "") {
  const live = accessFor(access, "payments:read");
  const reference = z.string().max(120).parse(search);
  return { requests: rows<RequestRow>("SELECT * FROM procurement_requests WHERE organization_id=? AND instr(lower(reference),lower(?))>0 ORDER BY created_at DESC,id DESC LIMIT 100", live.organizationId, reference).map(publicRequest),
    inventory: rows<ItemRow>("SELECT * FROM procurement_inventory WHERE organization_id=? ORDER BY sku LIMIT 100", live.organizationId).map(inventoryProjection),
    suppliers: rows<{ id: string; name: string }>("SELECT id,name FROM recipients WHERE organization_id=? AND kind='business' AND archived=0 AND preference_status='confirmed' AND user_id IS NOT NULL ORDER BY id", live.organizationId).map(value => ({ ...value, name: decrypt(value.name) })),
    roles: rows<{ id: string; name: string; permissions_json: string }>("SELECT id,name,permissions_json FROM organization_roles WHERE organization_id=? AND archived_at IS NULL ORDER BY name", live.organizationId).filter(role => purchasingPermissions(JSON.parse(role.permissions_json))).map(({ id, name }) => ({ id, name })),
    bills: rows<{ id: string; reference: string; recipient_id: string }>("SELECT id,reference,recipient_id FROM bills WHERE organization_id=? AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 100", live.organizationId),
    evidenceBoundary: "Receiving is a named human assertion. Reorders create unpublished drafts only. No escrow, shipping oracle, automated award or cash settlement is implied." };
}

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { audit, getAccess } from "../identity/session";
import { getRecipient } from "../identity/recipients";
import { documentOriginal, getDocument, reviewDocument, uploadDocument } from "../document-intake/service";
import { documentFilename, validateDocument } from "../document-intake/limits";
import { getBillTerms } from "../business/bill-terms";
import { formatUnits, parseUnits } from "../../lib/money";

const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const amountInput = z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).refine(value => { try { const amount = BigInt(parseUnits(value)); return amount > 0n && amount <= 10n ** 30n; } catch { return false; } }, "Use a positive USDC amount with up to six decimals");
export const expenseInput = z.object({
  merchant: z.string().trim().min(1).max(160), receiptReference: z.string().trim().min(1).max(120),
  expenseDate: z.string().date(), amountUSDC: amountInput, purpose: z.string().trim().min(3).max(2000),
  costCenter: z.string().trim().max(120).default(""), replacesExpenseId: z.string().uuid().optional(),
}).strict();
export const policyInput = z.object({ expectedVersion: z.number().int().nonnegative(), enabled: z.boolean(),
  perExpenseLimitUSDC: amountInput.nullable(), monthlyPersonLimitUSDC: amountInput.nullable(),
  requireCostCenter: z.boolean(), costCenters: z.array(z.string().trim().min(1).max(120)).max(100).refine(values => new Set(values).size === values.length, "Cost centres must be unique"),
}).strict();
type Payload = z.infer<typeof expenseInput>;
interface Expense {
  id: string; organization_id: string; submitted_by: string; recipient_id: string; recipient_version: number;
  recipient_snapshot_ciphertext: string; submitter_name_ciphertext: string; request_key: string; request_hash: string;
  source_hash: string; identity_hash: string; document_id: string | null; amount: string; payload_ciphertext: string;
  status: string; version: number; bill_id: string | null; review_ciphertext: string | null; replaces_expense_id: string | null;
  submitted_at: string; updated_at: string;
}
interface Policy { version: number; enabled: number; per_expense_limit: string | null; monthly_person_limit: string | null; require_cost_center: number; cost_centers_ciphertext: string }
const payload = (expense: Expense): Payload => JSON.parse(decrypt(expense.payload_ciphertext));
const capability = (expense: Expense): AccessContext => ({ userId: expense.submitted_by, organizationId: expense.organization_id, permissions: ["documents:manage"] });
function companyAccess(access: AccessContext, prepare = false) {
  const current = getAccess(access.userId, access.organizationId);
  for (const permission of ["payments:read", "documents:manage", ...(prepare ? ["payments:prepare"] : [])]) requirePermission(current, permission);
  return current;
}
export function eligibleRecipient(userId: string, recipientId: string) {
  const link = row<{ organization_id: string }>("SELECT organization_id FROM recipients WHERE id=? AND user_id=?", recipientId, userId);
  if (!link) throw new ApiError(404, "Choose your own confirmed company receiving profile", "EXPENSE_PROFILE_REQUIRED");
  const recipient = getRecipient(link.organization_id, recipientId);
  if (recipient.archived || !["employee", "contractor"].includes(recipient.kind) || recipient.preference_status !== "confirmed" || !recipient.confirmed_at) throw new ApiError(409, "Expenses require an active confirmed employee or contractor receiving profile", "EXPENSE_PROFILE_REQUIRED");
  return recipient;
}
function stored(organizationId: string, id: string) {
  const value = row<Expense>("SELECT * FROM expense_requests WHERE organization_id=? AND id=?", organizationId, id);
  if (!value) throw new ApiError(404, "Expense not found", "EXPENSE_NOT_FOUND");
  return value;
}
function own(userId: string, id: string) {
  const expense = row<Expense>("SELECT * FROM expense_requests WHERE id=? AND submitted_by=?", id, userId);
  if (!expense) throw new ApiError(404, "Expense not found", "EXPENSE_NOT_FOUND");
  return expense;
}
function readPolicy(organizationId: string) {
  const value = row<Policy>("SELECT * FROM expense_policies WHERE organization_id=?", organizationId);
  return { version: value?.version ?? 0, enabled: value ? !!value.enabled : true, perExpenseLimit: value?.per_expense_limit ?? null, monthlyPersonLimit: value?.monthly_person_limit ?? null, requireCostCenter: !!value?.require_cost_center,
    costCenters: value ? JSON.parse(decrypt(value.cost_centers_ciphertext)) as string[] : [], timeBasis: "UTC calendar month of original submission; no rollover" };
}
export function getExpensePolicy(access: AccessContext) { companyAccess(access); return readPolicy(access.organizationId); }
export function saveExpensePolicy(access: AccessContext, input: unknown) {
  const current = companyAccess(access), parsed = policyInput.parse(input); requirePermission(current, "company:manage");
  return transaction(db => {
    if (readPolicy(current.organizationId).version !== parsed.expectedVersion) throw new ApiError(409, "The expense policy changed. Refresh before saving", "EXPENSE_POLICY_CHANGED");
    const version = parsed.expectedVersion + 1;
    db.prepare("INSERT INTO expense_policies(organization_id,version,enabled,per_expense_limit,monthly_person_limit,require_cost_center,cost_centers_ciphertext,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,per_expense_limit=excluded.per_expense_limit,monthly_person_limit=excluded.monthly_person_limit,require_cost_center=excluded.require_cost_center,cost_centers_ciphertext=excluded.cost_centers_ciphertext,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .run(current.organizationId, version, Number(parsed.enabled), parsed.perExpenseLimitUSDC ? parseUnits(parsed.perExpenseLimitUSDC) : null, parsed.monthlyPersonLimitUSDC ? parseUnits(parsed.monthlyPersonLimitUSDC) : null, Number(parsed.requireCostCenter), encrypt(JSON.stringify(parsed.costCenters)), current.userId, now());
    audit(current.userId, current.organizationId, "expense.policy_updated", current.organizationId, { version });
    return readPolicy(current.organizationId);
  });
}
function monthlyUse(organizationId: string, userId: string, month: string, excludeId = "") {
  return rows<{ amount: string }>("SELECT amount FROM expense_requests WHERE organization_id=? AND submitted_by=? AND substr(submitted_at,1,7)=? AND id<>? AND status NOT IN ('rejected','cancelled')", organizationId, userId, month, excludeId).reduce((sum, value) => sum + BigInt(value.amount), 0n);
}
function assertPolicy(organizationId: string, userId: string, input: Payload, month: string, excludeId = "") {
  const policy = readPolicy(organizationId), amount = BigInt(parseUnits(input.amountUSDC));
  if (!policy.enabled) throw new ApiError(409, "This company paused new expense requests", "EXPENSE_POLICY_HOLD");
  if (policy.requireCostCenter && !input.costCenter || input.costCenter && policy.costCenters.length && !policy.costCenters.includes(input.costCenter)) throw new ApiError(409, "Choose a permitted company cost centre", "EXPENSE_POLICY_HOLD");
  if (policy.perExpenseLimit && amount > BigInt(policy.perExpenseLimit) || policy.monthlyPersonLimit && monthlyUse(organizationId, userId, month, excludeId) + amount > BigInt(policy.monthlyPersonLimit)) throw new ApiError(409, "This expense exceeds the current company claim or monthly person limit. Ask finance to review the policy", "EXPENSE_POLICY_HOLD");
  return policy;
}
function identity(input: Payload) { return hash({ merchant: input.merchant.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " "), reference: input.receiptReference.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " "), date: input.expenseDate }); }
function snapshotVersion(expense: Expense, actor: string) {
  getDb().prepare("INSERT INTO expense_versions(expense_id,version,payload_ciphertext,recipient_snapshot_ciphertext,amount,changed_by,created_at) VALUES(?,?,?,?,?,?,?)").run(expense.id, expense.version, expense.payload_ciphertext, expense.recipient_snapshot_ciphertext, expense.amount, actor, now());
}
function event(expense: Expense, actor: string | null, decision: string, note: string) {
  getDb().prepare("INSERT INTO expense_events(id,expense_id,actor_id,decision,note_ciphertext,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), expense.id, actor, decision, encrypt(note), now());
}
function recoverUploads(organizationId?: string, userId?: string) {
  for (const expense of rows<Expense>("SELECT * FROM expense_requests WHERE status='uploading' AND updated_at<? AND (? IS NULL OR organization_id=?) AND (? IS NULL OR submitted_by=?) LIMIT 100", new Date(Date.now() - 300_000).toISOString(), organizationId ?? null, organizationId ?? null, userId ?? null, userId ?? null)) {
    const source = row<{ id: string }>("SELECT id FROM invoice_documents WHERE organization_id=? AND source_hash=? AND created_by=? AND expires_at>?", expense.organization_id, expense.source_hash, expense.submitted_by, now());
    getDb().prepare("UPDATE expense_requests SET document_id=COALESCE(document_id,?),status=?,version=version+1,updated_at=? WHERE id=? AND status='uploading'").run(source?.id ?? null, source ? "returned" : "receipt_failed", now(), expense.id);
    event(expense, null, "upload_interrupted", "Upload confirmation was interrupted. Confirm the current receiving profile and resubmit the retained request, or retry the original upload if its receipt is unavailable.");
  }
}
function receipt(expense: Expense, text = false) {
  if (!expense.document_id) return null;
  const exists = row("SELECT id FROM invoice_documents WHERE id=? AND organization_id=? AND expires_at>?", expense.document_id, expense.organization_id, now());
  if (!exists) return null;
  const document = getDocument(capability(expense), expense.document_id);
  return { filename: document.filename, mediaType: document.mediaType, bytes: document.bytes, sourceHash: document.sourceHash, revision: document.revision, status: document.status, expiresAt: document.expiresAt, error: document.error, ...(text ? { text: document.text } : {}) };
}
function reimbursement(expense: Expense) {
  if (!expense.bill_id) return null;
  const terms = getBillTerms({ userId: expense.submitted_by, organizationId: expense.organization_id, permissions: ["payments:read"] }, expense.bill_id);
  const paid = BigInt(terms.paid), remaining = BigInt(terms.remainingLiability), latest = terms.installments.at(-1);
  const status = paid >= BigInt(terms.amount) ? "paid" : terms.status === "disputed" ? "disputed" : remaining === 0n ? "discharged_by_setoff" : paid > 0n ? "partially_paid" : latest?.status ?? terms.status;
  return { billId: expense.bill_id, status, billStatus: terms.status, amount: terms.amount, deliveredAmount: terms.paid, setoffAmount: terms.setoffAmount, remainingLiability: terms.remainingLiability,
    installments: terms.installments.map(item => ({ id: item.id, amount: item.amount, deliveredAmount: item.delivered_amount, status: item.status })),
    needsReview: terms.amount !== expense.amount || BigInt(terms.setoffAmount) > 0n || terms.installments.some(item => item.status === "cancelled") };
}
function projection(expense: Expense, sourceText = false) {
  return { id: expense.id, organizationId: expense.organization_id, companyName: row<{ name: string }>("SELECT name FROM organizations WHERE id=?", expense.organization_id)!.name,
    submitterName: decrypt(expense.submitter_name_ciphertext), recipientId: expense.recipient_id, recipientVersion: expense.recipient_version, version: expense.version, amount: expense.amount,
    fields: payload(expense), status: expense.status, billId: expense.bill_id, replacesExpenseId: expense.replaces_expense_id, review: expense.review_ciphertext ? JSON.parse(decrypt(expense.review_ciphertext)) as { note: string; decision: string; at: string; maxFee?: string } : null,
    submittedAt: expense.submitted_at, updatedAt: expense.updated_at, receipt: receipt(expense, sourceText), reimbursement: reimbursement(expense),
    events: rows<{ decision: string; note_ciphertext: string; created_at: string }>("SELECT decision,note_ciphertext,created_at FROM expense_events WHERE expense_id=? ORDER BY created_at,id", expense.id).map(value => ({ decision: value.decision, note: decrypt(value.note_ciphertext), at: value.created_at })) };
}
function verifyCurrentRecipient(expense: Expense) {
  const current = eligibleRecipient(expense.submitted_by, expense.recipient_id);
  if (current.version !== expense.recipient_version) throw new ApiError(409, "Receiving preferences changed. Return this request for the staff member to confirm the current profile", "EXPENSE_PROFILE_CHANGED");
  return current;
}
export function personalExpenseOverview(userId: string, page = 1) {
  recoverUploads(undefined, userId);
  const profiles = rows<{ id: string; organization_id: string; company_name: string }>("SELECT r.id,r.organization_id,o.name AS company_name FROM recipients r JOIN organizations o ON o.id=r.organization_id WHERE r.user_id=? AND r.archived=0 AND r.preference_status='confirmed' AND r.kind IN ('employee','contractor') ORDER BY o.name,r.id", userId).map(value => ({ id: value.id, companyName: value.company_name, name: getRecipient(value.organization_id, value.id).name, policy: readPolicy(value.organization_id) }));
  const total = row<{ total: number }>("SELECT COUNT(*) total FROM expense_requests WHERE submitted_by=?", userId)!.total;
  return { profiles, expenses: rows<Expense>("SELECT * FROM expense_requests WHERE submitted_by=? ORDER BY submitted_at DESC,id DESC LIMIT 25 OFFSET ?", userId, (page - 1) * 25).map(value => projection(value)), page, total, hasMore: page * 25 < total };
}
export function ownExpense(userId: string, id: string) { return projection(own(userId, id)); }
export function ownExpenseOriginal(userId: string, id: string) { const expense = own(userId, id); if (!receipt(expense)) throw new ApiError(404, "This receipt was deleted or its retention period ended", "EXPENSE_RECEIPT_UNAVAILABLE"); return documentOriginal(capability(expense), expense.document_id!); }
export function companyExpenseOriginal(access: AccessContext, id: string) { const current = companyAccess(access); const expense = stored(access.organizationId, id); if (!receipt(expense)) throw new ApiError(404, "This receipt was deleted or its retention period ended", "EXPENSE_RECEIPT_UNAVAILABLE"); return documentOriginal(current, expense.document_id!); }
export function listCompanyExpenses(access: AccessContext, page = 1) {
  const current = companyAccess(access); recoverUploads(current.organizationId);
  const total = row<{ total: number }>("SELECT COUNT(*) total FROM expense_requests WHERE organization_id=?", current.organizationId)!.total;
  return { expenses: rows<Expense>("SELECT * FROM expense_requests WHERE organization_id=? ORDER BY submitted_at DESC,id DESC LIMIT 25 OFFSET ?", current.organizationId, (page - 1) * 25).map(value => projection(value)), policy: readPolicy(current.organizationId), page, total, hasMore: page * 25 < total };
}
export function companyExpense(access: AccessContext, id: string) {
  companyAccess(access); const expense = stored(access.organizationId, id), policy = readPolicy(access.organizationId), details = projection(expense, true);
  const used = monthlyUse(access.organizationId, expense.submitted_by, expense.submitted_at.slice(0, 7));
  return { ...details, reviewToken: hash({ id, version: expense.version, status: expense.status, source: expense.source_hash, sourceRevision: details.receipt?.revision ?? null, amount: expense.amount, recipientVersion: expense.recipient_version, policyVersion: policy.version, monthlyUsed: used.toString() }),
    history: rows<{ version: number; payload_ciphertext: string; amount: string; created_at: string }>("SELECT version,payload_ciphertext,amount,created_at FROM expense_versions WHERE expense_id=? ORDER BY version DESC", id).map(value => ({ version: value.version, fields: JSON.parse(decrypt(value.payload_ciphertext)) as Payload, amount: value.amount, createdAt: value.created_at })) };
}

export async function submitExpense(userId: string, recipientId: string, requestKey: string, input: unknown, file: { filename: string; mediaType: string; bytes: Buffer }) {
  const recipient = eligibleRecipient(userId, recipientId), parsed = expenseInput.parse(input);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)) throw new ApiError(422, "Use a stable expense upload request identity", "EXPENSE_REQUEST_INVALID");
  validateDocument(file.bytes, file.mediaType);
  const sourceHash = hash(file.bytes), fingerprint = hash({ recipientId, input: parsed, sourceHash }), stamp = now();
  const initial = transaction(db => {
    const existing = row<Expense>("SELECT * FROM expense_requests WHERE organization_id=? AND submitted_by=? AND request_key=?", recipient.organization_id, userId, requestKey);
    if (existing) {
      if (existing.request_hash !== fingerprint) throw new ApiError(409, "This request identity already has different expense terms", "EXPENSE_REQUEST_CONFLICT");
      if (existing.status === "receipt_failed") db.prepare("UPDATE expense_requests SET status='uploading',updated_at=? WHERE id=?").run(now(), existing.id);
      return { expense: existing, upload: existing.status === "receipt_failed", duplicate: true };
    }
    if (row<{ count: number }>("SELECT COUNT(*) count FROM expense_requests WHERE submitted_by=? AND substr(submitted_at,1,10)=?", userId, stamp.slice(0, 10))!.count >= 100) throw new ApiError(429, "The daily receipt submission limit is reached. Retry an existing request or return tomorrow", "EXPENSE_SUBMISSION_LIMIT");
    assertPolicy(recipient.organization_id, userId, parsed, stamp.slice(0, 7));
    if (parsed.replacesExpenseId) {
      const old = own(userId, parsed.replacesExpenseId);
      if (old.organization_id !== recipient.organization_id || old.status !== "rejected" || old.bill_id) throw new ApiError(409, "A replacement can reference only your rejected, unpaid request in the same company", "EXPENSE_REPLACEMENT_INVALID");
    }
    if (row("SELECT id FROM expense_requests WHERE organization_id=? AND (source_hash=? OR identity_hash=?)", recipient.organization_id, sourceHash, identity(parsed)) || row("SELECT id FROM invoice_documents WHERE organization_id=? AND source_hash=?", recipient.organization_id, sourceHash) || row("SELECT id FROM bills WHERE organization_id=? AND document_hash=?", recipient.organization_id, sourceHash)) throw new ApiError(409, "This receipt or merchant reference is already recorded. Ask finance to inspect the existing request or invoice", "EXPENSE_DUPLICATE");
    const id = randomUUID(), name = row<{ name: string | null }>("SELECT name FROM users WHERE id=?", userId)?.name || recipient.name;
    db.prepare("INSERT INTO expense_requests(id,organization_id,submitted_by,recipient_id,recipient_version,recipient_snapshot_ciphertext,submitter_name_ciphertext,request_key,request_hash,source_hash,identity_hash,amount,payload_ciphertext,status,replaces_expense_id,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'uploading',?,?,?)")
      .run(id, recipient.organization_id, userId, recipientId, recipient.version, encrypt(JSON.stringify(recipient)), encrypt(name), requestKey, fingerprint, sourceHash, identity(parsed), parseUnits(parsed.amountUSDC), encrypt(JSON.stringify(parsed)), parsed.replacesExpenseId ?? null, stamp, stamp);
    const expense = stored(recipient.organization_id, id); snapshotVersion(expense, userId);
    return { expense, upload: true, duplicate: false };
  });
  if (initial.upload) {
    try {
      const result = await uploadDocument(capability(initial.expense), { ...file, filename: documentFilename(file.filename) });
      const source = row<{ created_by: string }>("SELECT created_by FROM invoice_documents WHERE id=? AND organization_id=?", result.document.id, recipient.organization_id)!;
      if (source.created_by !== userId) throw new ApiError(409, "This receipt is already retained in the company inbox. Ask finance to inspect its existing record", "EXPENSE_DUPLICATE");
      getDb().prepare("UPDATE expense_requests SET document_id=? WHERE id=?").run(result.document.id, initial.expense.id);
      verifyCurrentRecipient(initial.expense);
      getDb().prepare("UPDATE expense_requests SET document_id=?,status='submitted',updated_at=? WHERE id=? AND status IN ('uploading','receipt_failed') AND bill_id IS NULL").run(result.document.id, now(), initial.expense.id);
      audit(userId, recipient.organization_id, "expense.submitted", initial.expense.id);
      event(initial.expense, userId, "submitted", "Receipt and requested USDC amount submitted for company review. No payment authority was granted.");
    } catch (error) { getDb().prepare("UPDATE expense_requests SET status='receipt_failed',updated_at=? WHERE id=? AND status='uploading'").run(now(), initial.expense.id); throw error; }
  }
  return { expense: projection(stored(recipient.organization_id, initial.expense.id)), duplicate: initial.duplicate };
}
export function correctExpense(userId: string, id: string, input: unknown) {
  const parsed = expenseInput.extend({ expectedVersion: z.number().int().positive() }).parse(input);
  return transaction(db => {
    const expense = own(userId, id), recipient = eligibleRecipient(userId, expense.recipient_id);
    if (!["returned", "rejected", "cancelled", "receipt_failed"].includes(expense.status) || expense.bill_id || expense.version !== parsed.expectedVersion) throw new ApiError(409, "Only a current unaccepted request can be revised. Accepted reimbursements keep their original liability", "EXPENSE_CORRECTION_LOCKED");
    if (!receipt(expense)) throw new ApiError(409, "The original receipt is unavailable. Ask finance to reject this request and submit a new receipt linked as its correction", "EXPENSE_RECEIPT_UNAVAILABLE");
    const { expectedVersion: _version, ...fields } = parsed;
    if ((fields.replacesExpenseId ?? null) !== expense.replaces_expense_id) throw new ApiError(409, "Keep the original correction relationship", "EXPENSE_CORRECTION_LOCKED");
    assertPolicy(expense.organization_id, userId, fields, expense.submitted_at.slice(0, 7), expense.id);
    if (row("SELECT id FROM expense_requests WHERE organization_id=? AND identity_hash=? AND id<>?", expense.organization_id, identity(fields), id)) throw new ApiError(409, "This merchant reference already belongs to another request", "EXPENSE_DUPLICATE");
    db.prepare("UPDATE expense_requests SET payload_ciphertext=?,identity_hash=?,amount=?,recipient_version=?,recipient_snapshot_ciphertext=?,version=version+1,status='submitted',review_ciphertext=NULL,updated_at=? WHERE id=?")
      .run(encrypt(JSON.stringify(fields)), identity(fields), parseUnits(fields.amountUSDC), recipient.version, encrypt(JSON.stringify(recipient)), now(), id);
    snapshotVersion(stored(expense.organization_id, id), userId); event(expense, userId, "corrected", "Staff revised and resubmitted the original request. Prior receipt, terms and review history remain linked."); audit(userId, expense.organization_id, "expense.corrected", id);
    return projection(stored(expense.organization_id, id));
  });
}
export function cancelExpense(userId: string, id: string, expectedVersion: number) {
  return transaction(db => {
    const expense = own(userId, id);
    if (expense.bill_id || !["submitted", "returned", "receipt_failed"].includes(expense.status) || expense.version !== expectedVersion) throw new ApiError(409, "Only an unaccepted current request can be cancelled", "EXPENSE_CANCELLATION_LOCKED");
    db.prepare("UPDATE expense_requests SET status='cancelled',version=version+1,updated_at=? WHERE id=?").run(now(), id);
    event(expense, userId, "cancelled", "Staff cancelled the unaccepted request. No reimbursement bill was created.");
    audit(userId, expense.organization_id, "expense.cancelled", id); return projection(stored(expense.organization_id, id));
  });
}
export const reviewExpenseInput = z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["accept", "return", "reject"]), note: z.string().trim().min(3).max(2000), maxFeeUSDC: z.string().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).default("1"), confirmed: z.literal(true) }).strict();
export function reviewExpense(access: AccessContext, id: string, input: unknown) {
  const current = companyAccess(access, true), parsed = reviewExpenseInput.parse(input);
  return transaction(db => {
    const expense = stored(current.organizationId, id);
    if (expense.status === "accepted" && parsed.decision === "accept") {
      const previous = JSON.parse(decrypt(expense.review_ciphertext!)) as { maxFee: string };
      if (previous.maxFee !== parseUnits(parsed.maxFeeUSDC)) throw new ApiError(409, "This accepted expense already has its reimbursement draft. Review that bill's exact fees separately", "EXPENSE_ALREADY_ACCEPTED");
      return companyExpense(current, id);
    }
    if (!["submitted", "returned"].includes(expense.status) || companyExpense(current, id).reviewToken !== parsed.reviewToken) throw new ApiError(409, "The expense, receipt or policy changed. Refresh before review", "EXPENSE_REVIEW_CHANGED");
    if (parsed.decision === "accept") {
      verifyCurrentRecipient(expense); assertPolicy(current.organizationId, expense.submitted_by, payload(expense), expense.submitted_at.slice(0, 7), expense.id);
      const source = receipt(expense);
      if (!source) throw new ApiError(409, "The receipt was deleted or expired. Request a corrected submission before acceptance", "EXPENSE_RECEIPT_UNAVAILABLE");
      const document = getDocument(capability(expense), expense.document_id!);
      db.prepare("UPDATE expense_requests SET status='preparing' WHERE id=?").run(id);
      const fields = payload(expense), bill = reviewDocument(current, expense.document_id!, { revision: document.revision, sourceHash: expense.source_hash, recipientId: expense.recipient_id, reference: `expense:${id}`, title: `Expense reimbursement: ${fields.merchant} - ${fields.purpose}`.slice(0, 240), agreedUSDC: formatUnits(expense.amount, 6), maxFee: parsed.maxFeeUSDC, reviewConfirmed: true });
      db.prepare("UPDATE bills SET cost_center_reference=? WHERE id=? AND organization_id=?").run(fields.costCenter ? encrypt(fields.costCenter) : null, bill.billId, current.organizationId);
      db.prepare("UPDATE expense_requests SET bill_id=? WHERE id=?").run(bill.billId, id);
    }
    db.prepare("UPDATE expense_requests SET status=?,review_ciphertext=?,version=version+1,updated_at=? WHERE id=?")
      .run(parsed.decision === "accept" ? "accepted" : parsed.decision === "return" ? "returned" : "rejected", encrypt(JSON.stringify({ note: parsed.note, decision: parsed.decision, at: now(), ...(parsed.decision === "accept" ? { maxFee: parseUnits(parsed.maxFeeUSDC) } : {}) })), now(), id);
    event(expense, current.userId, parsed.decision, parsed.note);
    audit(current.userId, current.organizationId, `expense.${parsed.decision}`, id, { billId: stored(current.organizationId, id).bill_id });
    return companyExpense(current, id);
  });
}

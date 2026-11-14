import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { audit } from "../identity/session";
import { privateHistoryQuery, privateHistoryWindow } from "../private-history";
import { createBill } from "../business/service";
import { analyzeInvoice } from "../assistant/service";
import { getAssistantConfig, requirePrivateAiConfig } from "../assistant/config";
import { parseUnits } from "../../lib/money";
import { DOCUMENT_LIMITS, documentFilename, documentRetentionDays, mediaTypes, validateDocument, type DocumentKind } from "./limits";
import { documentImages, extractDocumentText, processorReadiness } from "./processor";

interface StoredDocument {
  id: string; organization_id: string; created_by: string; filename_ciphertext: string;
  media_type: string; byte_length: number; source_hash: string; original_ciphertext: string;
  text_ciphertext: string | null; text_hash: string | null; needs_vision: number; analysis_ciphertext: string | null;
  assistant_draft_id: string | null; status: "processing" | "ready" | "needs_review" | "analyzing" | "reviewed";
  error_code: string | null; error_message: string | null; processing_token: string | null;
  revision: number; bill_id: string | null; review_ciphertext: string | null;
  created_at: string; updated_at: string; expires_at: string;
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const activeAnalyses = new Set<string>();
const now = () => new Date().toISOString();
const kindOf = (value: StoredDocument): DocumentKind => value.media_type === mediaTypes.pdf ? "pdf" : value.media_type === mediaTypes.png ? "png" : "jpeg";
const decimal = z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/);
export const documentReviewInput = z.object({
  revision: z.number().int().positive(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  recipientId: z.string().min(1), reference: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240), agreedUSDC: decimal, maxFee: decimal.default("1"),
  dueDate: z.string().date().optional(), reviewConfirmed: z.literal(true),
}).strict();

export function purgeDocumentRetention(at = now()) {
  transaction(db => {
    db.prepare("DELETE FROM assistant_drafts WHERE id IN (SELECT assistant_draft_id FROM invoice_documents WHERE expires_at<=?)").run(at);
    db.prepare("DELETE FROM invoice_documents WHERE expires_at<=?").run(at);
  });
}

function cleanExpired() {
  purgeDocumentRetention();
  getDb().prepare("UPDATE invoice_documents SET status='needs_review',error_code='DOCUMENT_INTERRUPTED',error_message='Processing was interrupted. Retry extraction or review the invoice manually.',processing_token=NULL,revision=revision+1,updated_at=? WHERE status IN ('processing','analyzing') AND updated_at<?")
    .run(now(), new Date(Date.now() - 5 * 60_000).toISOString());
}

function getStored(access: AccessContext, id: string) {
  requirePermission(access, "documents:manage");
  cleanExpired();
  const value = row<StoredDocument>("SELECT * FROM invoice_documents WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!value) throw new ApiError(404, "Invoice file not found or its retention period ended", "DOCUMENT_NOT_FOUND");
  return value;
}

function summary(value: StoredDocument) {
  return { id: value.id, filename: decrypt(value.filename_ciphertext), mediaType: value.media_type, bytes: value.byte_length, sourceHash: value.source_hash, status: value.status, revision: value.revision, billId: value.bill_id, error: value.error_message ? { code: value.error_code, message: value.error_message } : null, createdAt: value.created_at, updatedAt: value.updated_at, expiresAt: value.expires_at };
}

export function documentConfiguration(access: AccessContext) {
  requirePermission(access, "documents:manage");
  return { limits: DOCUMENT_LIMITS, retentionDays: documentRetentionDays(), processor: processorReadiness(), imageUploadReady: true, privateAi: getAssistantConfig(), serverReceivesPlaintext: true };
}

export function listDocuments(access: AccessContext, query: unknown = {}) {
  requirePermission(access, "documents:manage");
  cleanExpired();
  const input = privateHistoryQuery.parse(query), total = row<{ total: number }>("SELECT COUNT(*) AS total FROM invoice_documents WHERE organization_id=?", access.organizationId)!.total;
  const { offset, ...page } = privateHistoryWindow(total, input);
  const records = rows<StoredDocument>("SELECT id,filename_ciphertext,media_type,byte_length,source_hash,status,revision,bill_id,error_code,error_message,created_at,updated_at,expires_at FROM invoice_documents WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", access.organizationId, page.pageSize, offset);
  return { documents: records.map(summary), ...page };
}

export function getDocument(access: AccessContext, id: string) {
  const value = getStored(access, id);
  const similar = value.text_hash ? rows<{ id: string; bill_id: string | null }>("SELECT id,bill_id FROM invoice_documents WHERE organization_id=? AND text_hash=? AND id<>? ORDER BY created_at LIMIT 10", access.organizationId, value.text_hash, value.id) : [];
  return { ...summary(value), text: value.text_ciphertext ? decrypt(value.text_ciphertext) : "", needsVision: value.needs_vision === 1, analysis: value.analysis_ciphertext ? JSON.parse(decrypt(value.analysis_ciphertext)) : null, similarDocumentIds: similar.map(item => item.id), review: value.review_ciphertext ? JSON.parse(decrypt(value.review_ciphertext)) : null };
}

export function documentOriginal(access: AccessContext, id: string) {
  const value = getStored(access, id);
  audit(access.userId, access.organizationId, "document.original_downloaded", id);
  return { filename: decrypt(value.filename_ciphertext), mediaType: value.media_type, bytes: Buffer.from(decrypt(value.original_ciphertext), "base64") };
}

function claim(access: AccessContext, id: string, revision: number, status: "processing" | "analyzing") {
  const value = getStored(access, id);
  if (value.bill_id || value.status === "reviewed") throw new ApiError(409, "This document already has a reviewed bill. Open its bill to continue", "DOCUMENT_ALREADY_REVIEWED");
  if (value.status === "processing" || value.status === "analyzing") throw new ApiError(409, "This document is still processing. Refresh its saved status before another action", "DOCUMENT_BUSY");
  const token = randomUUID(), changed = getDb().prepare("UPDATE invoice_documents SET status=?,processing_token=?,revision=revision+1,error_code=NULL,error_message=NULL,updated_at=? WHERE id=? AND organization_id=? AND revision=? AND status NOT IN ('processing','analyzing','reviewed')")
    .run(status, token, now(), id, access.organizationId, revision);
  if (!changed.changes) throw new ApiError(409, "The invoice file changed. Refresh before continuing", "DOCUMENT_CHANGED");
  return { value, token };
}

function failure(access: AccessContext, id: string, token: string, error: unknown) {
  const known = error instanceof ApiError, message = known ? error.message : "Document processing could not finish. Retry or enter the invoice manually";
  getDb().prepare("UPDATE invoice_documents SET status='needs_review',processing_token=NULL,error_code=?,error_message=?,revision=revision+1,updated_at=? WHERE id=? AND organization_id=? AND processing_token=?")
    .run(known ? error.code : "DOCUMENT_PROCESSING_FAILED", message, now(), id, access.organizationId, token);
}

async function extractSaved(access: AccessContext, value: StoredDocument, token: string) {
  try {
    const bytes = Buffer.from(decrypt(value.original_ciphertext), "base64");
    const result = await extractDocumentText(bytes, kindOf(value));
    const normalized = result.text.toLowerCase().replace(/\s+/g, " ").trim();
    transaction(db => {
      if (value.assistant_draft_id) db.prepare("DELETE FROM assistant_drafts WHERE id=? AND organization_id=?").run(value.assistant_draft_id, access.organizationId);
      db.prepare("UPDATE invoice_documents SET status=?,text_ciphertext=?,text_hash=?,needs_vision=?,analysis_ciphertext=NULL,assistant_draft_id=NULL,error_code=?,error_message=?,processing_token=NULL,revision=revision+1,updated_at=? WHERE id=? AND organization_id=? AND processing_token=?")
        .run(result.needsVision ? "needs_review" : "ready", result.text ? encrypt(result.text) : null, normalized ? hash(normalized) : null, Number(result.needsVision), result.needsVision ? "DOCUMENT_IMAGE_REVIEW" : null, result.needsVision ? "Some or all pages are images. Use verified private image analysis or enter the invoice manually." : null, now(), value.id, access.organizationId, token);
    });
  } catch (error) { failure(access, value.id, token, error); }
  return getDocument(access, value.id);
}

export async function uploadDocument(access: AccessContext, input: { filename: string; mediaType: string; bytes: Buffer }) {
  requirePermission(access, "documents:manage");
  const kind = validateDocument(input.bytes, input.mediaType), sourceHash = hash(input.bytes), days = documentRetentionDays();
  cleanExpired();
  const stored = transaction(db => {
    const existing = row<StoredDocument>("SELECT * FROM invoice_documents WHERE organization_id=? AND source_hash=?", access.organizationId, sourceHash);
    if (existing) return { duplicate: true, value: existing };
    const total = row<{ count: number; bytes: number }>("SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes FROM invoice_documents WHERE organization_id=?", access.organizationId)!;
    if (total.count >= DOCUMENT_LIMITS.companyRecords || total.bytes + input.bytes.length > DOCUMENT_LIMITS.companyBytes) throw new ApiError(422, "This company file inbox is full. Delete unneeded retained files before uploading another", "DOCUMENT_STORAGE_LIMIT");
    const id = randomUUID(), token = randomUUID(), createdAt = now();
    db.prepare("INSERT INTO invoice_documents(id,organization_id,created_by,filename_ciphertext,media_type,byte_length,source_hash,original_ciphertext,status,processing_token,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, access.organizationId, access.userId, encrypt(documentFilename(input.filename)), mediaTypes[kind], input.bytes.length, sourceHash, encrypt(input.bytes.toString("base64")), "processing", token, createdAt, createdAt, new Date(Date.now() + days * 86_400_000).toISOString());
    audit(access.userId, access.organizationId, "document.uploaded", id, { mediaType: mediaTypes[kind], bytes: input.bytes.length });
    return { duplicate: false, value: row<StoredDocument>("SELECT * FROM invoice_documents WHERE id=?", id)! };
  });
  return { duplicate: stored.duplicate, document: stored.duplicate ? getDocument(access, stored.value.id) : await extractSaved(access, stored.value, stored.value.processing_token!) };
}

export async function reprocessDocument(access: AccessContext, id: string, revision: number) {
  const { value, token } = claim(access, id, revision, "processing");
  return extractSaved(access, value, token);
}

export function saveDocumentText(access: AccessContext, id: string, revision: number, text: string) {
  const value = getStored(access, id);
  if (!text.trim() || text.length > DOCUMENT_LIMITS.textCharacters) throw new ApiError(422, "Enter invoice text from 1 to 20,000 characters", "DOCUMENT_TEXT_INVALID");
  if (["processing", "analyzing", "reviewed"].includes(value.status)) throw new ApiError(409, "Wait for processing or open the document's existing bill", "DOCUMENT_BUSY");
  transaction(db => {
    const changed = db.prepare("UPDATE invoice_documents SET status='ready',text_ciphertext=?,text_hash=?,needs_vision=0,analysis_ciphertext=NULL,assistant_draft_id=NULL,error_code=NULL,error_message=NULL,revision=revision+1,updated_at=? WHERE id=? AND organization_id=? AND revision=? AND bill_id IS NULL")
      .run(encrypt(text.trim()), hash(text.toLowerCase().replace(/\s+/g, " ").trim()), now(), id, access.organizationId, revision);
    if (!changed.changes) throw new ApiError(409, "The invoice file changed. Refresh before saving", "DOCUMENT_CHANGED");
    if (value.assistant_draft_id) db.prepare("DELETE FROM assistant_drafts WHERE id=? AND organization_id=?").run(value.assistant_draft_id, access.organizationId);
  });
  audit(access.userId, access.organizationId, "document.text_reviewed", id);
  return getDocument(access, id);
}

export async function analyzeDocument(access: AccessContext, id: string, revision: number) {
  requirePermission(access, "documents:manage");
  requirePrivateAiConfig();
  const existing = getStored(access, id);
  if (existing.revision === revision && existing.analysis_ciphertext && existing.status === "ready") return getDocument(access, id);
  if (activeAnalyses.size >= 1) throw new ApiError(429, "Another file analysis is running. Retry after it completes", "DOCUMENT_ANALYSIS_BUSY");
  const { value, token } = claim(access, id, revision, "analyzing");
  activeAnalyses.add(id);
  try {
    const text = value.text_ciphertext ? decrypt(value.text_ciphertext) : "";
    const useImages = !text || value.needs_vision === 1;
    const images = useImages ? await documentImages(Buffer.from(decrypt(value.original_ciphertext), "base64"), kindOf(value)) : [];
    const result = await analyzeInvoice(access, text || "Read the attached invoice pages. Confirm every amount and recipient observation against the images.", images, value.source_hash);
    const changed = getDb().prepare("UPDATE invoice_documents SET status='ready',analysis_ciphertext=?,assistant_draft_id=?,processing_token=NULL,error_code=NULL,error_message=NULL,revision=revision+1,updated_at=? WHERE id=? AND organization_id=? AND processing_token=?")
      .run(encrypt(JSON.stringify(result)), result.id, now(), id, access.organizationId, token);
    if (!changed.changes) throw new ApiError(409, "This document changed while analysis was running. Refresh its saved status", "DOCUMENT_CHANGED");
    audit(access.userId, access.organizationId, "document.analyzed", id);
    return getDocument(access, id);
  } catch (error) { failure(access, id, token, error); throw error; }
  finally { activeAnalyses.delete(id); }
}

export function reviewDocument(access: AccessContext, id: string, input: z.infer<typeof documentReviewInput>) {
  requirePermission(access, "payments:prepare");
  const parsed = documentReviewInput.parse(input);
  return transaction(db => {
    const value = getStored(access, id);
    if (value.source_hash !== parsed.sourceHash) throw new ApiError(409, "The reviewed source does not match this file", "DOCUMENT_CHANGED");
    const { revision: _revision, ...terms } = parsed;
    if (value.bill_id) {
      if (!value.review_ciphertext || !isDeepStrictEqual(JSON.parse(decrypt(value.review_ciphertext)), terms)) throw new ApiError(409, "This source already has a reviewed bill with different terms", "DOCUMENT_ALREADY_REVIEWED");
      return { document: getDocument(access, id), billId: value.bill_id, duplicate: true };
    }
    if (value.revision !== parsed.revision || ["processing", "analyzing"].includes(value.status)) throw new ApiError(409, "The document changed or is still processing. Refresh before review", "DOCUMENT_CHANGED");
    if (value.text_hash && row("SELECT id FROM invoice_documents WHERE organization_id=? AND text_hash=? AND id<>? AND bill_id IS NOT NULL", access.organizationId, value.text_hash, value.id)) throw new ApiError(409, "A matching invoice source already has a reviewed bill. Inspect that bill before another obligation", "DUPLICATE_DOCUMENT");
    const amount = parseUnits(parsed.agreedUSDC), maxFee = parseUnits(parsed.maxFee);
    const analysis = value.analysis_ciphertext ? JSON.parse(decrypt(value.analysis_ciphertext)) : null;
    const bill = createBill(access, { recipientId: parsed.recipientId, reference: parsed.reference, title: parsed.title, amount, maxFee, dueDate: parsed.dueDate, documentHash: value.source_hash, lineItems: analysis?.draft?.lineItems ?? [], evidence: `Source document sha256:${value.source_hash}; reviewed manually before payment approval` });
    db.prepare("UPDATE invoice_documents SET status='reviewed',bill_id=?,review_ciphertext=?,revision=revision+1,updated_at=? WHERE id=? AND organization_id=?")
      .run(bill.id, encrypt(JSON.stringify(terms)), now(), id, access.organizationId);
    audit(access.userId, access.organizationId, "document.bill_prepared", id, { billId: bill.id });
    return { document: getDocument(access, id), billId: bill.id, duplicate: false };
  });
}

export function deleteDocument(access: AccessContext, id: string, revision: number) {
  return transaction(db => {
    const value = getStored(access, id);
    if (value.status === "analyzing" || value.status === "processing") throw new ApiError(409, "Wait for processing to finish before deleting this source", "DOCUMENT_BUSY");
    const changed = db.prepare("DELETE FROM invoice_documents WHERE id=? AND organization_id=? AND revision=?").run(id, access.organizationId, revision);
    if (!changed.changes) throw new ApiError(409, "The document changed. Refresh before deleting", "DOCUMENT_CHANGED");
    if (value.assistant_draft_id) db.prepare("DELETE FROM assistant_drafts WHERE id=? AND organization_id=?").run(value.assistant_draft_id, access.organizationId);
    audit(access.userId, access.organizationId, "document.deleted", id);
    return { deleted: true, billPreserved: !!value.bill_id };
  });
}

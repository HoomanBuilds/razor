import { createHash, randomUUID } from "node:crypto";
import { completeAiUsage, reserveAiUsage } from "../billing/usage";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { extractPrivateInvoice, type InvoiceImage } from "./client";
import { getAssistantConfig, requirePrivateAiConfig } from "./config";
import { privateHistoryQuery, privateHistoryWindow } from "../private-history";
import type { ExtractedInvoice } from "./extraction";

interface StoredDraft {
  id: string;
  organization_id: string;
  input_ciphertext: string;
  draft_ciphertext: string;
  evidence_ciphertext: string;
  created_at: string;
  expires_at: string;
}

const activeAnalyses = new Set<string>();

function purgeExpired() {
  getDb().prepare("DELETE FROM assistant_drafts WHERE expires_at<=?").run(new Date().toISOString());
}

function audit(access: AccessContext, action: string, draftId: string | null) {
  getDb().prepare("INSERT INTO assistant_audit(id,organization_id,user_id,action,draft_id,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), access.organizationId, access.userId, action, draftId, new Date().toISOString());
}

export function assistantConfiguration(access: AccessContext) {
  requirePermission(access, "documents:manage");
  return getAssistantConfig();
}

export async function analyzeInvoice(access: AccessContext, text: string, images: InvoiceImage[] = [], sourceHash?: string) {
  requirePermission(access, "documents:manage");
  if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new ApiError(422, "Paste invoice text from 1 to 20,000 characters", "INVOICE_TEXT_INVALID");
  const config = requirePrivateAiConfig();
  if (activeAnalyses.has(access.organizationId)) throw new ApiError(429, "A private invoice analysis is already running for this company", "INVOICE_ANALYSIS_BUSY");
  const createdAt = new Date();
  const expiresAt = config.retentionDays ? new Date(createdAt.getTime() + config.retentionDays * 86_400_000).toISOString() : null;
  const draftId = config.retentionDays ? randomUUID() : null;
  if (config.retentionDays) encrypt("private-analysis-readiness");
  const usage = reserveAiUsage(access);
  activeAnalyses.add(access.organizationId);
  try {
    const result = await extractPrivateInvoice(text.trim(), images, sourceHash);
    transaction(() => {
      purgeExpired();
      if (draftId && expiresAt) getDb().prepare("INSERT INTO assistant_drafts(id,organization_id,created_by,input_ciphertext,draft_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(draftId, access.organizationId, access.userId, encrypt(text.trim()), encrypt(JSON.stringify(result.draft)), encrypt(JSON.stringify({ verification: result.verification, ...result.evidence })), createdAt.toISOString(), expiresAt);
      audit(access, "invoice_analyzed", draftId);
    });
    completeAiUsage(usage.id, "completed");
    return { id: draftId, draft: result.draft, verification: result.verification, retained: !!draftId, expiresAt, requiresReview: true };
  } catch (error) {
    completeAiUsage(usage.id, "failed");
    throw error;
  } finally {
    activeAnalyses.delete(access.organizationId);
  }
}

export function invoiceDraftHistory(access:AccessContext,input:unknown={}) {
  requirePermission(access,"documents:manage");
  const query=privateHistoryQuery.parse(input);
  return transaction(()=>{
    purgeExpired();
    const total=row<{total:number}>("SELECT COUNT(*) AS total FROM assistant_drafts WHERE organization_id=?",access.organizationId)!.total,{offset,...page}=privateHistoryWindow(total,query);
    const drafts=rows<StoredDraft>("SELECT id,organization_id,input_ciphertext,draft_ciphertext,evidence_ciphertext,created_at,expires_at FROM assistant_drafts WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",access.organizationId,page.pageSize,offset).map(item=>({id:item.id,documentHash:createHash("sha256").update(decrypt(item.input_ciphertext)).digest("hex"),draft:JSON.parse(decrypt(item.draft_ciphertext)) as ExtractedInvoice,verification:JSON.parse(decrypt(item.evidence_ciphertext)).verification,createdAt:item.created_at,expiresAt:item.expires_at,requiresReview:true}));
    return {drafts,...page};
  });
}

export function listDrafts(access: AccessContext) {
  return invoiceDraftHistory(access,{pageSize:100}).drafts;
}

export function getDraftEvidence(access: AccessContext, draftId: string) {
  requirePermission(access, "documents:manage");
  purgeExpired();
  const item = row<StoredDraft>("SELECT * FROM assistant_drafts WHERE id=? AND organization_id=?", draftId, access.organizationId);
  if (!item) throw new ApiError(404, "Invoice draft not found or retention expired", "ASSISTANT_DRAFT_NOT_FOUND");
  audit(access, "invoice_evidence_viewed", draftId);
  return { id: item.id, documentHash:createHash("sha256").update(decrypt(item.input_ciphertext)).digest("hex"), sourceText:decrypt(item.input_ciphertext), draft: JSON.parse(decrypt(item.draft_ciphertext)), evidence: JSON.parse(decrypt(item.evidence_ciphertext)), createdAt: item.created_at, expiresAt: item.expires_at };
}

export function deleteDraft(access: AccessContext, draftId: string) {
  requirePermission(access, "documents:manage");
  return transaction(() => {
    const result = getDb().prepare("DELETE FROM assistant_drafts WHERE id=? AND organization_id=?").run(draftId, access.organizationId);
    if (!result.changes) throw new ApiError(404, "Invoice draft not found or retention expired", "ASSISTANT_DRAFT_NOT_FOUND");
    audit(access, "invoice_deleted", draftId);
    return { deleted: true };
  });
}

export function purgeAssistantRetention() {
  purgeExpired();
}

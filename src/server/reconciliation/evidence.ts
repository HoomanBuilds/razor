import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows } from "../db";
import { decrypt, encrypt } from "../identity/crypto";

interface Evidence { id: string; organization_id: string; attempt_id: string; evidence_kind: string; content_hash: string; ciphertext: string | null; created_at: string; expires_at: string }

export function retainPrivateEvidence(access: AccessContext, attemptId: string, kind: string, text: string): string {
  requirePermission(access, "payments:approve");
  if (!text.trim() || text.length > 2000) throw new ApiError(400, "Enter a receipt or closure reference up to 2,000 characters", "INVALID_EVIDENCE");
  if (!row("SELECT id FROM payout_attempts WHERE id=? AND organization_id=?", attemptId, access.organizationId)) throw new ApiError(404, "Payment attempt not found", "NOT_FOUND");
  const contentHash = createHash("sha256").update(text.trim()).digest("hex");
  const existing = row<Evidence>("SELECT * FROM private_settlement_evidence WHERE organization_id=? AND attempt_id=? AND evidence_kind=? AND content_hash=?", access.organizationId, attemptId, kind, contentHash);
  if (!existing) {
    const now = new Date(), expiry = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    getDb().prepare("INSERT INTO private_settlement_evidence(id,organization_id,attempt_id,evidence_kind,content_hash,ciphertext,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), access.organizationId, attemptId, kind, contentHash, encrypt(text.trim()), access.userId, now.toISOString(), expiry);
  }
  return `sha256:${contentHash}`;
}

export function listPrivateEvidence(access: AccessContext, attemptId: string) {
  requirePermission(access, "payments:read");
  purgePrivateEvidence(access.organizationId);
  const records = rows<Evidence>("SELECT * FROM private_settlement_evidence WHERE organization_id=? AND attempt_id=? ORDER BY created_at", access.organizationId, attemptId);
  return records.map(({ ciphertext, ...record }) => ({ ...record, receipt: ciphertext ? decrypt(ciphertext) : null, retained: ciphertext !== null }));
}

export function purgePrivateEvidence(organizationId?: string) {
  getDb().prepare("UPDATE private_settlement_evidence SET ciphertext=NULL WHERE expires_at<=? AND ciphertext IS NOT NULL AND (? IS NULL OR organization_id=?)").run(new Date().toISOString(), organizationId ?? null, organizationId ?? null);
}

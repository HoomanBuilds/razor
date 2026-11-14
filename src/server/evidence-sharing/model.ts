import { z } from "zod";
export const SHARE_MAX_BYTES = 8 * 1024 * 1024;
export const SHARE_MAX_ACTIVE = 10;
export const shareSourceKind = z.enum([
  "invoice_analysis",
  "finance_proposal",
  "payment_evidence",
]);
export type ShareSourceKind = z.infer<typeof shareSourceKind>;
export const createShareInput = z
  .object({
    sourceKind: shareSourceKind,
    sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    disclosure: z.enum(["encrypted_wire", "metadata"]),
    ttlMinutes: z.number().int().min(5).max(4320),
    idempotencyKey: z.string().uuid(),
    publicDisclosureAcknowledged: z.literal(true),
  })
  .strict();
export const shareActionInput = z
  .object({ idempotencyKey: z.string().uuid() })
  .strict();
export const deleteShareInput = shareActionInput
  .extend({ deleteSnapshotAcknowledged: z.literal(true) })
  .strict();
export const shareListInput = z
  .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
  .strict();
export interface ShareRecord {
  id: string;
  organization_id: string;
  created_by: string;
  source_kind: ShareSourceKind;
  source_id: string | null;
  disclosure: "encrypted_wire" | "metadata";
  token_hash: string;
  request_key_hash: string;
  request_hash: string;
  packet_ciphertext?: string | null;
  packet_retained?: number;
  packet_sha256: string;
  packet_bytes: number;
  status: "active" | "revoked" | "deleted" | "expired" | "source_unavailable";
  created_at: string;
  expires_at: string;
  source_expires_at: string;
  revoked_at: string | null;
  deleted_at: string | null;
}

import { row } from "../db";
import { decrypt } from "../identity/crypto";
import type { Payment } from "./types";
import { ApiError } from "../context";
import { liabilityPayments } from "../partial-settlement/model";

export function recordedRecipientName(organizationId: string, payment: Pick<Payment, "recipient_id" | "recipient_version">) {
  const recipient = row<{ name: string; version: number; profile_ciphertext: string | null }>("SELECT r.name,r.version,v.profile_ciphertext FROM recipients r LEFT JOIN recipient_versions v ON v.recipient_id=r.id AND v.version=? WHERE r.id=? AND r.organization_id=?", payment.recipient_version, payment.recipient_id, organizationId);
  if (recipient?.profile_ciphertext) return decrypt((JSON.parse(decrypt(recipient.profile_ciphertext)) as { name: string }).name);
  return recipient?.version === payment.recipient_version ? decrypt(recipient.name) : `Recipient version ${payment.recipient_version}`;
}

export function assertSameRecipientOwner(organizationId: string, payment: Payment) {
  const current = row<{ user_id: string | null }>("SELECT user_id FROM recipients WHERE id=? AND organization_id=?", payment.recipient_id, organizationId);
  for (const obligation of liabilityPayments(organizationId, payment.id)) {
    const saved = row<{ profile_ciphertext: string }>("SELECT v.profile_ciphertext FROM recipient_versions v JOIN recipients r ON r.id=v.recipient_id WHERE v.recipient_id=? AND v.version=? AND r.organization_id=?", obligation.recipient_id, obligation.recipient_version, organizationId);
    const owner = saved ? (JSON.parse(decrypt(saved.profile_ciphertext)) as { user_id?: string | null }).user_id : null;
    if (owner && current?.user_id !== owner) throw new ApiError(409, "This recipient profile belongs to a different person. Restore the original recipient identity before refreshing or replacing this liability", "RECIPIENT_OWNER_CHANGED");
  }
}

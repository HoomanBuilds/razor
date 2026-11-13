import { row } from "../db";
import { decrypt } from "../identity/crypto";
import type { Payment } from "./types";

export function recordedRecipientName(organizationId: string, payment: Pick<Payment, "recipient_id" | "recipient_version">) {
  const recipient = row<{ name: string; version: number; profile_ciphertext: string | null }>("SELECT r.name,r.version,v.profile_ciphertext FROM recipients r LEFT JOIN recipient_versions v ON v.recipient_id=r.id AND v.version=? WHERE r.id=? AND r.organization_id=?", payment.recipient_version, payment.recipient_id, organizationId);
  if (recipient?.profile_ciphertext) return decrypt((JSON.parse(decrypt(recipient.profile_ciphertext)) as { name: string }).name);
  return recipient?.version === payment.recipient_version ? decrypt(recipient.name) : `Recipient version ${payment.recipient_version}`;
}

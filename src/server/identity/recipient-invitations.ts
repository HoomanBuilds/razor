import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "./crypto";
import { appOrigin, audit, getAccess } from "./session";

interface InvitationRecipient {
  id: string; organization_id: string; name: string; email: string | null; version: number; archived: number; preference_status: string;
  invitation_token_hash: string | null; invitation_token_ciphertext: string | null; invitation_expires_at: string | null; invitation_version: number | null;
}
interface Delivery {
  id: string; organization_id: string; recipient_id: string; recipient_version: number; token_hash: string; requested_by: string;
  request_key: string; email_ciphertext: string; payload_ciphertext: string | null; state: string; attempts: number;
  first_attempt_at: string | null; created_at: string; lease_owner: string;
}
const now = () => new Date().toISOString();
const cooldown = 60_000;

export function recipientInvitationEmailConfig() {
  const sender = process.env.NOTIFICATION_FROM_EMAIL?.trim();
  if (!process.env.RESEND_API_KEY || !sender) return { configured: false, reason: "email_not_configured" };
  if (/(@resend\.dev)(?:>|\s|$)/i.test(sender) && (process.env.NODE_ENV === "production" || new URL(appOrigin()).hostname !== "localhost" && new URL(appOrigin()).hostname !== "127.0.0.1")) return { configured: false, reason: "sender_verification_required" };
  return { configured: true, reason: null };
}
function recipient(organizationId: string, id: string) {
  const value = row<InvitationRecipient>("SELECT * FROM recipients WHERE organization_id=? AND id=?", organizationId, id);
  if (!value) throw new ApiError(404, "Recipient not found", "RECIPIENT_NOT_FOUND");
  return value;
}
function validToken(value: InvitationRecipient) {
  if (value.archived || value.preference_status === "confirmed" || value.invitation_version !== value.version || !value.invitation_token_ciphertext || !value.invitation_token_hash || !value.invitation_expires_at || value.invitation_expires_at <= now()) return null;
  const token = decrypt(value.invitation_token_ciphertext);
  return hashToken(token) === value.invitation_token_hash ? token : null;
}
function metadata(value: InvitationRecipient) {
  const token = validToken(value), latest = row<Delivery>("SELECT * FROM recipient_invitation_outbox WHERE organization_id=? AND recipient_id=? AND recipient_version=? AND token_hash=? ORDER BY created_at DESC,id DESC LIMIT 1", value.organization_id, value.id, value.version, value.invitation_token_hash ?? "");
  const config = recipientInvitationEmailConfig();
  return {
    invitationUrl: token ? `${appOrigin()}/receive?token=${encodeURIComponent(token)}` : null,
    status: value.archived ? "unavailable" : value.preference_status === "confirmed" ? "confirmed" : token ? "pending" : value.invitation_expires_at && value.invitation_expires_at <= now() ? "expired" : "unavailable",
    expiresAt: value.invitation_expires_at,
    email: { ...config, state: !config.configured && (!latest || latest.state === "queued") ? "unavailable" : latest?.state ?? "not_requested", lastRequestedAt: latest?.created_at ?? null, retryAfterSeconds: latest ? Math.max(0, Math.ceil((Date.parse(latest.created_at) + cooldown - Date.now()) / 1000)) : 0 },
    delivery: latest?.state === "accepted" ? "email_accepted" : "copy_link",
  };
}
export function getRecipientInvitation(access: AccessContext, id: string) {
  requirePermission(access, "recipients:manage");
  return metadata(recipient(access.organizationId, id));
}
export function revokeRecipientInvitation(organizationId: string, id: string) {
  const db = getDb();
  db.prepare("UPDATE recipients SET invitation_token_hash=NULL,invitation_token_ciphertext=NULL,invitation_expires_at=NULL,invitation_version=NULL WHERE id=? AND organization_id=?").run(id, organizationId);
  db.prepare("UPDATE recipient_invitation_outbox SET state='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE recipient_id=? AND organization_id=? AND state IN ('queued','sending')").run(now(), id, organizationId);
}
export function ensureRecipientInvitation(access: AccessContext, id: string) {
  requirePermission(access, "recipients:manage");
  return transaction(db => {
    const current = recipient(access.organizationId, id);
    if (current.archived) throw new ApiError(409, "This recipient has been archived", "RECIPIENT_ARCHIVED");
    if (current.preference_status === "confirmed") return metadata(current);
    if (!validToken(current)) {
      revokeRecipientInvitation(access.organizationId, id);
      const token = newToken();
      db.prepare("UPDATE recipients SET invitation_token_hash=?,invitation_token_ciphertext=?,invitation_expires_at=?,invitation_version=version WHERE organization_id=? AND id=?")
        .run(hashToken(token), encrypt(token), new Date(Date.now() + 7 * 86400_000).toISOString(), access.organizationId, id);
      audit(access.userId, access.organizationId, "recipient.invitation_created", id, { version: current.version });
    }
    return metadata(recipient(access.organizationId, id));
  });
}
export function queueRecipientInvitation(access: AccessContext, id: string, requestKey: string) {
  requirePermission(access, "recipients:manage");
  return transaction(db => {
    ensureRecipientInvitation(access, id);
    const current = recipient(access.organizationId, id);
    if (current.preference_status === "confirmed") throw new ApiError(409, "This recipient already confirmed. Their personal workspace remains available.", "RECIPIENT_ALREADY_CONFIRMED");
    if (!current.email) throw new ApiError(409, "Add the recipient's email before sending an invitation", "RECIPIENT_EMAIL_REQUIRED");
    const previous = row<Delivery>("SELECT * FROM recipient_invitation_outbox WHERE organization_id=? AND recipient_id=? AND request_key=?", access.organizationId, id, requestKey);
    if (previous) {
      if (previous.token_hash !== current.invitation_token_hash || previous.recipient_version !== current.version) throw new ApiError(409, "This request belongs to an older invitation. Refresh and try again.", "INVITATION_REQUEST_CHANGED");
      return metadata(current);
    }
    const latest = row<Delivery>("SELECT * FROM recipient_invitation_outbox WHERE organization_id=? AND recipient_id=? ORDER BY created_at DESC,id DESC LIMIT 1", access.organizationId, id);
    if (latest && Date.parse(latest.created_at) + cooldown > Date.now()) throw new ApiError(429, "Wait one minute before requesting another invitation email", "INVITATION_EMAIL_COOLDOWN");
    const pending = row<Delivery>("SELECT * FROM recipient_invitation_outbox WHERE organization_id=? AND recipient_id=? AND token_hash=? AND state IN ('queued','sending','unknown') ORDER BY created_at DESC LIMIT 1", access.organizationId, id, current.invitation_token_hash!);
    if (pending) {
      if (pending.state === "unknown") throw new ApiError(409, "The previous email's delivery is unconfirmed. Copy the current invitation link instead.", "INVITATION_EMAIL_UNCONFIRMED");
      return metadata(current);
    }
    const at = now();
    db.prepare("INSERT INTO recipient_invitation_outbox(id,organization_id,recipient_id,recipient_version,token_hash,requested_by,request_key,email_ciphertext,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), access.organizationId, id, current.version, current.invitation_token_hash!, access.userId, requestKey, encrypt(decrypt(current.email)), at, at, at);
    audit(access.userId, access.organizationId, "recipient.invitation_email_requested", id, { version: current.version });
    return metadata(current);
  });
}
export function initializeRecipientInvitation(access: AccessContext, id: string) {
  const invitation = ensureRecipientInvitation(access, id), current = recipient(access.organizationId, id);
  if (!current.email || invitation.status !== "pending") return invitation;
  try { return queueRecipientInvitation(access, id, `initial:${current.invitation_token_hash}`); }
  catch (error) { if (error instanceof ApiError && error.code === "INVITATION_EMAIL_COOLDOWN") return metadata(current); throw error; }
}
function authorizedDelivery(delivery: Delivery) {
  const current = recipient(delivery.organization_id, delivery.recipient_id);
  let authority = false;
  try { authority = getAccess(delivery.requested_by, delivery.organization_id).permissions.includes("recipients:manage"); } catch {}
  const token = validToken(current);
  if (!authority || !token || current.version !== delivery.recipient_version || current.invitation_token_hash !== delivery.token_hash || !current.email || decrypt(current.email) !== decrypt(delivery.email_ciphertext)) return null;
  return { current, token };
}
export async function dispatchRecipientInvitations(organizationId?: string, limit = 5) {
  if (!recipientInvitationEmailConfig().configured) return { configured: false, accepted: 0 };
  let accepted = 0;
  for (let index = 0; index < Math.min(limit, 10); index++) {
    const delivery = transaction(db => {
      db.prepare("UPDATE recipient_invitation_outbox SET state='queued',lease_owner=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=?").run(now());
      const item = row<Delivery>("SELECT * FROM recipient_invitation_outbox WHERE state='queued' AND next_attempt_at<=? AND (? IS NULL OR organization_id=?) ORDER BY created_at,id LIMIT 1", now(), organizationId ?? null, organizationId ?? null);
      if (!item) return null;
      item.lease_owner = randomUUID();
      db.prepare("UPDATE recipient_invitation_outbox SET state='sending',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?").run(item.lease_owner, new Date(Date.now() + 120_000).toISOString(), now(), item.id);
      return item;
    });
    if (!delivery) break;
    const valid = authorizedDelivery(delivery);
    if (!valid) {
      getDb().prepare("UPDATE recipient_invitation_outbox SET state='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(now(), delivery.id, delivery.lease_owner);
      continue;
    }
    if (delivery.first_attempt_at && Date.now() - Date.parse(delivery.first_attempt_at) >= 23 * 3600_000) {
      getDb().prepare("UPDATE recipient_invitation_outbox SET state='unknown',lease_owner=NULL,lease_until=NULL,last_error='Provider acceptance window expired',updated_at=? WHERE id=? AND lease_owner=?").run(now(), delivery.id, delivery.lease_owner);
      continue;
    }
    try {
      let payload = delivery.payload_ciphertext ? decrypt(delivery.payload_ciphertext) : null;
      if (!payload) {
        const company = row<{ name: string }>("SELECT name FROM organizations WHERE id=?", delivery.organization_id)!;
        payload = JSON.stringify({ from: process.env.NOTIFICATION_FROM_EMAIL, to: [decrypt(valid.current.email!)], subject: `${company.name} invited you to Razor`, text: `${company.name} invited you to receive payments on Razor.\n\nChoose your receiving asset and wallet, then confirm your preferences. Sign in with this email address to continue.\n\n${appOrigin()}/receive?token=${encodeURIComponent(valid.token)}\n\nThis invitation expires ${valid.current.invitation_expires_at}. Razor will never ask for your wallet recovery phrase or private key.` });
        getDb().prepare("UPDATE recipient_invitation_outbox SET payload_ciphertext=?,first_attempt_at=COALESCE(first_attempt_at,?),updated_at=? WHERE id=? AND lease_owner=? AND state='sending'").run(encrypt(payload), now(), now(), delivery.id, delivery.lease_owner);
      }
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `razor-recipient-invite-${delivery.id}` }, body: payload, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        if ([400, 401, 403, 404, 422].includes(response.status)) {
          getDb().prepare("UPDATE recipient_invitation_outbox SET state='failed',lease_owner=NULL,lease_until=NULL,last_error='Email provider rejected the request; check sender configuration',updated_at=? WHERE id=? AND lease_owner=?").run(now(), delivery.id, delivery.lease_owner);
          continue;
        }
        throw new Error("Email acceptance unconfirmed");
      }
      const result = await response.json() as { id?: string };
      if (!result.id) throw new Error("Email acceptance unconfirmed");
      const updated = getDb().prepare("UPDATE recipient_invitation_outbox SET state='accepted',provider_id=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease_owner=? AND state='sending'").run(result.id, now(), delivery.id, delivery.lease_owner);
      if (updated.changes) accepted++;
    } catch {
      getDb().prepare("UPDATE recipient_invitation_outbox SET state='queued',lease_owner=NULL,lease_until=NULL,last_error='Email acceptance unconfirmed; retry uses the same provider key',next_attempt_at=?,updated_at=? WHERE id=? AND lease_owner=? AND state='sending'").run(new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(delivery.attempts, 7))).toISOString(), now(), delivery.id, delivery.lease_owner);
    }
  }
  return { configured: true, accepted };
}

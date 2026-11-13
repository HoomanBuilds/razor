import { randomUUID } from "node:crypto";
import { ApiError } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { appOrigin } from "../identity/session";

interface Delivery { id: string; source_kind: "company" | "recipient"; source_id: string; organization_id: string; user_id: string; email_ciphertext: string; attempts: number; created_at: string; lease_owner: string }
const now = () => new Date().toISOString();

export function listRecipientNotices(userId: string) {
  return rows("SELECT id,title,body,entity_id,recipient_id,read_at,created_at FROM recipient_notices WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100", userId);
}
export function readRecipientNotice(userId: string, id: string) {
  const updated = getDb().prepare("UPDATE recipient_notices SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?").run(now(), id, userId);
  if (!updated.changes) throw new ApiError(404, "Notification not found", "NOTICE_NOT_FOUND");
  return { read: true };
}
export function notificationPreferences(userId: string) {
  const user = row<{ email: string | null }>("SELECT email FROM users WHERE id=?", userId)!;
  const preference = row<{ email_enabled: number }>("SELECT email_enabled FROM notification_preferences WHERE user_id=?", userId);
  return { emailEnabled: !!preference?.email_enabled, email: user.email, providerConfigured: !!(process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL) };
}
export function saveNotificationPreferences(userId: string, emailEnabled: boolean) {
  if (emailEnabled && !notificationPreferences(userId).email) throw new ApiError(409, "Link a verified Google or email identity before enabling email updates", "VERIFIED_EMAIL_REQUIRED");
  getDb().prepare("INSERT INTO notification_preferences(user_id,email_enabled,enabled_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled_at=CASE WHEN excluded.email_enabled=1 AND email_enabled=0 THEN excluded.enabled_at ELSE enabled_at END,email_enabled=excluded.email_enabled,updated_at=excluded.updated_at").run(userId, Number(emailEnabled), emailEnabled ? now() : null, now());
  if (!emailEnabled) getDb().prepare("UPDATE notification_email_outbox SET state='cancelled',updated_at=? WHERE user_id=? AND state='queued'").run(now(), userId);
  return notificationPreferences(userId);
}

function mayRead(delivery: Pick<Delivery, "source_kind" | "source_id" | "organization_id" | "user_id">) {
  if (delivery.source_kind === "recipient") return !!row("SELECT id FROM recipient_notices WHERE id=? AND user_id=? AND organization_id=?", delivery.source_id, delivery.user_id, delivery.organization_id);
  return !!row(`SELECT n.id FROM notices n JOIN memberships m ON m.organization_id=n.organization_id AND m.user_id=? AND m.status='active'
    JOIN organization_roles r ON r.id=m.role_id AND r.organization_id=m.organization_id
    WHERE n.id=? AND n.organization_id=? AND (n.user_id IS NULL OR n.user_id=?) AND EXISTS(SELECT 1 FROM json_each(r.permissions_json) WHERE value=n.required_permission)`, delivery.user_id, delivery.source_id, delivery.organization_id, delivery.user_id);
}

function enqueueEmails(organizationId?: string) {
  const candidates = rows<{ source_kind: "company" | "recipient"; source_id: string; organization_id: string; user_id: string; email: string }>(`
    SELECT 'company' AS source_kind,n.id AS source_id,n.organization_id,u.id AS user_id,u.email
    FROM notices n JOIN memberships m ON m.organization_id=n.organization_id AND m.status='active'
    JOIN organization_roles r ON r.id=m.role_id AND r.organization_id=m.organization_id JOIN users u ON u.id=m.user_id
    JOIN notification_preferences p ON p.user_id=u.id AND p.email_enabled=1
    WHERE u.email IS NOT NULL AND n.created_at>=p.enabled_at AND n.created_at>? AND (? IS NULL OR n.organization_id=?)
      AND (n.user_id IS NULL OR n.user_id=u.id) AND EXISTS(SELECT 1 FROM json_each(r.permissions_json) WHERE value=n.required_permission)
      AND NOT EXISTS(SELECT 1 FROM notification_email_outbox x WHERE x.source_kind='company' AND x.source_id=n.id AND x.user_id=u.id)
    UNION ALL
    SELECT 'recipient',n.id,n.organization_id,u.id,u.email FROM recipient_notices n JOIN users u ON u.id=n.user_id
    JOIN notification_preferences p ON p.user_id=u.id AND p.email_enabled=1
    WHERE u.email IS NOT NULL AND n.created_at>=p.enabled_at AND n.created_at>? AND (? IS NULL OR n.organization_id=?)
      AND NOT EXISTS(SELECT 1 FROM notification_email_outbox x WHERE x.source_kind='recipient' AND x.source_id=n.id AND x.user_id=u.id)
    LIMIT 100`, new Date(Date.now() - 23 * 3600_000).toISOString(), organizationId ?? null, organizationId ?? null, new Date(Date.now() - 23 * 3600_000).toISOString(), organizationId ?? null, organizationId ?? null);
  transaction(db => {
    for (const item of candidates) db.prepare("INSERT OR IGNORE INTO notification_email_outbox(id,source_kind,source_id,organization_id,user_id,email_ciphertext,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), item.source_kind, item.source_id, item.organization_id, item.user_id, encrypt(item.email), now(), now(), now());
  });
}

export async function dispatchNotifications(organizationId?: string, limit = 5) {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_FROM_EMAIL) return { configured: false, accepted: 0 };
  enqueueEmails(organizationId);
  let accepted = 0;
  for (let index = 0; index < Math.min(limit, 10); index++) {
    const delivery = transaction(db => {
      db.prepare("UPDATE notification_email_outbox SET state='queued',lease_owner=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=?").run(now());
      const item = row<Delivery>("SELECT * FROM notification_email_outbox WHERE state='queued' AND next_attempt_at<=? AND (? IS NULL OR organization_id=?) ORDER BY created_at,id LIMIT 1", now(), organizationId ?? null, organizationId ?? null);
      if (!item) return null;
      item.lease_owner = randomUUID();
      db.prepare("UPDATE notification_email_outbox SET state='sending',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?").run(item.lease_owner, new Date(Date.now() + 120_000).toISOString(), now(), item.id);
      return item;
    });
    if (!delivery) break;
    const current = notificationPreferences(delivery.user_id);
    if (!current.emailEnabled || !mayRead(delivery) || !current.email || current.email !== decrypt(delivery.email_ciphertext)) {
      getDb().prepare("UPDATE notification_email_outbox SET state='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(now(), delivery.id, delivery.lease_owner);
      continue;
    }
    if (Date.now() - Date.parse(delivery.created_at) >= 23 * 3600_000) {
      getDb().prepare("UPDATE notification_email_outbox SET state='unknown',lease_owner=NULL,lease_until=NULL,last_error='Send window expired; provider acceptance may require review',updated_at=? WHERE id=? AND lease_owner=?").run(now(), delivery.id, delivery.lease_owner);
      continue;
    }
    try {
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `razor-notice-${delivery.id}` }, body: JSON.stringify({ from: process.env.NOTIFICATION_FROM_EMAIL, to: [current.email], subject: "An update is available in Razor", text: `An update is available in your Razor account. Sign in to review its current status.\n\n${appOrigin()}${delivery.source_kind === "recipient" ? "/receive" : "/?section=activity"}\n\nPayment amounts, receiving addresses and private documents are available only after sign-in.` }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("The email provider did not confirm acceptance");
      const result = await response.json() as { id?: string };
      if (!result.id) throw new Error("The email provider did not return a message reference");
      getDb().prepare("UPDATE notification_email_outbox SET state='accepted',provider_id=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(result.id, now(), delivery.id, delivery.lease_owner);
      accepted++;
    } catch {
      getDb().prepare("UPDATE notification_email_outbox SET state='queued',lease_owner=NULL,lease_until=NULL,last_error='Email acceptance is unconfirmed; retry uses the same provider key',next_attempt_at=?,updated_at=? WHERE id=? AND lease_owner=?").run(new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(delivery.attempts, 7))).toISOString(), now(), delivery.id, delivery.lease_owner);
    }
  }
  return { configured: true, accepted };
}

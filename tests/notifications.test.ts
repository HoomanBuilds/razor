import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, row } from "../src/server/db";
import { dispatchNotifications, listRecipientNotices, readRecipientNotice, saveNotificationPreferences } from "../src/server/notifications/service";
import { createPayment } from "../src/server/payments/service";
import type { AccessContext } from "../src/server/context";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "62".repeat(32);

function fixture() {
  const id = randomUUID(), receiver = randomUUID(), recipientId = randomUUID(), now = new Date().toISOString();
  const db = getDb();
  db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").run(id, "Owner", null, now);
  db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").run(receiver, "Recipient", "recipient@example.test", now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Company", id, now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'Recipient','employee','USDC','near','recipient.near','confirmed',?,?,?)").run(recipientId, id, receiver, now, now, now);
  const access: AccessContext = { userId: id, organizationId: id, permissions: ["company:read", "payments:prepare", "payments:read"] };
  return { access, receiver, recipientId };
}

test("destination and payment notices are transactional, personal and never report a held payment as delivered", () => {
  const { access, receiver, recipientId } = fixture(), db = getDb();
  db.prepare("UPDATE recipients SET version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), recipientId);
  assert.equal(listRecipientNotices(receiver).length, 1);
  assert.equal(listRecipientNotices(access.userId).length, 0);
  const first = listRecipientNotices(receiver)[0] as { id: string };
  assert.throws(() => readRecipientNotice(access.userId, first.id), /not found/);
  assert.deepEqual(readRecipientNotice(receiver, first.id), { read: true });
  const payment = createPayment(access, { recipientId, reference: "Notice fixture", amount: "1000000" });
  db.prepare("UPDATE payments SET status='unknown',updated_at=? WHERE id=?").run(new Date().toISOString(), payment.id);
  const notices = listRecipientNotices(receiver) as { title: string; body: string }[];
  assert.equal(notices.length, 2);
  assert(notices.some(notice => notice.title === "Payment awaiting company action"));
  assert(!notices.some(notice => notice.title.includes("delivered")));
  assert(!JSON.stringify(notices).includes("1000000"));
  const attempt = randomUUID(), now = new Date().toISOString();
  db.prepare("UPDATE payments SET status='paid',updated_at=? WHERE id=?").run(now, payment.id);
  db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'backup','reported_delivered','{}','USDC','near','recipient.near','1000000','1000000','fixture.near',?,?)").run(attempt, payment.id, access.organizationId, now, now);
  db.prepare("UPDATE payout_attempts SET state='delivered' WHERE id=?").run(attempt);
  assert((listRecipientNotices(receiver) as { title: string }[]).some(notice => notice.title === "Payment delivered using your USDC backup"));
});

test("email notifications require verified opt-in, redact financial details and record provider acceptance once", async () => {
  const { access, receiver, recipientId } = fixture();
  assert.throws(() => saveNotificationPreferences(access.userId, true), /verified/);
  saveNotificationPreferences(receiver, true);
  getDb().prepare("UPDATE recipients SET version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), recipientId);
  const priorFetch = globalThis.fetch, priorKey = process.env.RESEND_API_KEY, priorFrom = process.env.NOTIFICATION_FROM_EMAIL;
  process.env.RESEND_API_KEY = "test-key";
  process.env.NOTIFICATION_FROM_EMAIL = "Razor <notice@example.test>";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.to, ["recipient@example.test"]);
    assert(!payload.text.includes("recipient.near"));
    assert.equal(typeof new Headers(init?.headers).get("Idempotency-Key"), "string");
    return new Response(JSON.stringify({ id: "provider-accepted-fixture" }), { status: 200 });
  };
  try {
    assert.equal((await dispatchNotifications(access.organizationId)).accepted, 1);
    assert.equal((await dispatchNotifications(access.organizationId)).accepted, 0);
    assert.equal(calls, 1);
    const delivery = row<{ state: string; email_ciphertext: string }>("SELECT state,email_ciphertext FROM notification_email_outbox WHERE user_id=?", receiver)!;
    assert.equal(delivery.state, "accepted");
    assert.notEqual(delivery.email_ciphertext, "recipient@example.test");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = priorKey;
    if (priorFrom === undefined) delete process.env.NOTIFICATION_FROM_EMAIL; else process.env.NOTIFICATION_FROM_EMAIL = priorFrom;
  }
});

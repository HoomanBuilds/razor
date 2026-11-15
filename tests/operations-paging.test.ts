import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getDb, row, transaction } from "../src/server/db";
import { PERMISSIONS } from "../src/server/identity/session";
import { encrypt } from "../src/server/identity/crypto";
import { getRecipient, saveVersion } from "../src/server/identity/recipients";
import type { AccessContext } from "../src/server/context";
import { createBill, approveBill } from "../src/server/business/service";
import { jobPage, recurringPage, templatePage, noticePage, overview, readNotice, retryJob, setRecurring } from "../src/server/operations/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "cf".repeat(32);

function fixture() {
  const id = randomUUID(), recipientId = randomUUID(), at = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id, at);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id, id, at, at);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,'Supplier','business','USDC','near','supplier.near','confirmed',?,?,?)").run(recipientId, id, at, at, at);
  const access: AccessContext = { userId: id, organizationId: id, permissions: [...PERMISSIONS] };
  const viewer = { ...access, permissions: ["company:read", "payments:read"] };
  return { access, viewer, recipientId, at };
}

test("older failed work and active templates remain reachable and controllable beyond one hundred rows", () => {
  const { access, viewer, at } = fixture(), db = getDb(), jobs: string[] = [], rules: string[] = [];
  transaction(() => {
    for (let index = 0; index < 105; index++) {
      const job = randomUUID(), rule = randomUUID(), created = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      jobs.push(job); rules.push(rule);
      db.prepare("INSERT INTO operation_jobs(id,organization_id,job_key,kind,entity_id,status,run_at,payload,created_at,updated_at) VALUES(?,?,?,'due_payment',?,'failed',?,'private job payload',?,?)").run(job, access.organizationId, `job-${index}`, `payment-${index}`, at, created, created);
      db.prepare("INSERT INTO recurring_rules(id,organization_id,kind,entity_id,interval_days,next_run_at,created_by,snapshot_ciphertext,created_at,updated_at) VALUES(?,?,'bill',?,30,?,?,'private template snapshot',?,?)").run(rule, access.organizationId, `approved-source-${index}`, at, access.userId, created, created);
    }
  });
  const foreign = fixture();
  db.prepare("INSERT INTO operation_jobs(id,organization_id,job_key,kind,entity_id,run_at,created_at,updated_at) VALUES(?,?,'foreign','due_payment','foreign',?,?,?)").run(randomUUID(), foreign.access.organizationId, at, at, at);
  const seen = new Set<string>();
  for (let page = 1; page <= 5; page++) {
    const result = jobPage(viewer, page, 25, "attention");
    assert.equal(result.total, 105); assert.equal(result.hasMore, page < 5);
    for (const item of result.jobs) { assert.equal(seen.has(item.id), false); assert.equal("payload" in item, false); assert.equal("lease_owner" in item, false); seen.add(item.id); }
  }
  assert.equal(seen.size, 105);
  assert.ok(jobPage(viewer, 5, 25, "attention").jobs.some(item => item.id === jobs[0]));
  assert.throws(() => retryJob(viewer, jobs[0]), /permission/);
  retryJob(access, jobs[0]);
  assert.equal(jobPage(viewer, 1, 25, "attention").total, 104);
  assert.equal(jobPage(viewer, 1, 25, "pending").total, 1);
  const oldRules = recurringPage(viewer, 5, 25, "active");
  assert.equal(oldRules.total, 105); assert.ok(oldRules.recurring.some(rule => rule.id === rules[0]));
  assert.equal("snapshot_ciphertext" in oldRules.recurring[0], false);
  assert.throws(() => setRecurring(viewer, rules[0], false), /permission/);
  setRecurring(access, rules[0], false);
  assert.equal(recurringPage(viewer, 1, 25, "active").total, 104);
  assert.equal(recurringPage(viewer, 1, 25, "paused").total, 1);
  assert.throws(() => jobPage(viewer, 0, 25), /valid operations page/);
  assert.throws(() => recurringPage(viewer, 1, 101), /valid operations page/);
  assert.throws(() => jobPage({ ...viewer, permissions: ["company:read"] }, 1, 25), /permission/);
});

test("recurring source selection reaches approved sources older than the initial catalog", () => {
  const { access, viewer, recipientId } = fixture(), first: string[] = [], db = getDb();
  transaction(() => {
    for (let index = 0; index < 105; index++) {
      const bill = createBill(access, { recipientId, reference: `service-${index}`, title: "Recurring service", amount: "100", maxFee: "1" });
      approveBill(access, bill.id);
      db.prepare("UPDATE bills SET created_at=? WHERE id=?").run(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), bill.id);
      first.push(bill.id);
    }
  });
  const oldest = templatePage(viewer, "bill", 5, 25);
  assert.equal(oldest.total, 105); assert.ok(oldest.templates.some(item => item.id === first[0]));
  assert.equal(templatePage(viewer, "bill", 1, 25).hasMore, true);
  assert.equal(templatePage(viewer, "payroll", 1, 25).total, 0);
});

test("notice authorization precedes paging and older read receipts preserve accurate unread totals", () => {
  const { access, viewer, at } = fixture(), db = getDb(), earliest = randomUUID(), colleague = randomUUID();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Colleague',?)").run(colleague, at);
  transaction(() => {
    for (let index = 0; index < 105; index++) db.prepare("INSERT INTO notices(id,organization_id,title,body,required_permission,created_at) VALUES(?,?,'Due payment','Review current payment','payments:read',?)").run(index === 0 ? earliest : randomUUID(), access.organizationId, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
    for (let index = 0; index < 110; index++) db.prepare("INSERT INTO notices(id,organization_id,title,body,required_permission,created_at) VALUES(?,?,'Private analysis','Document manager only','documents:manage',?)").run(randomUUID(), access.organizationId, at);
    db.prepare("INSERT INTO notices(id,organization_id,user_id,title,body,required_permission,created_at) VALUES(?,?,?,'Personal','Other user only','payments:read',?)").run(randomUUID(), access.organizationId, colleague, at);
  });
  const old = noticePage(viewer, 5, 25);
  assert.equal(old.total, 105); assert.equal(old.unreadTotal, 105); assert.ok(old.notices.some(notice => notice.id === earliest));
  assert.equal(overview(viewer).unread, 105);
  readNotice(viewer, earliest);
  assert.equal(noticePage(viewer, 1, 25, "unread").total, 104);
  assert.ok(row("SELECT notice_id FROM notice_receipts WHERE notice_id=? AND user_id=?", earliest, viewer.userId));
  assert.equal(noticePage({ ...viewer, userId: colleague }, 1, 25).unreadTotal, 106);
  const foreign = fixture(); assert.throws(() => readNotice(foreign.viewer, earliest), /not found/);
  const privateId = row<{ id: string }>("SELECT id FROM notices WHERE organization_id=? AND required_permission='documents:manage'", access.organizationId)!.id;
  assert.throws(() => readNotice(viewer, privateId), /not found/);
});

test("notice payment context uses business labels and respects company and payment access", () => {
  const { access, viewer, recipientId, at } = fixture(), foreign = fixture(), db = getDb();
  db.prepare("UPDATE recipients SET name=? WHERE id=?").run(encrypt("Recorded supplier"), recipientId);
  saveVersion(getRecipient(access.organizationId, recipientId), access.userId);
  const bill = createBill(access, { recipientId, reference: "DESIGN-NOV", title: "Design services", amount: "1250000000", maxFee: "1000000" });
  db.prepare("UPDATE recipients SET name=?,version=version+1 WHERE id=?").run(encrypt("Renamed supplier"), recipientId);
  const otherBill = createBill(foreign.access, { recipientId: foreign.recipientId, reference: "PRIVATE-INVOICE", title: "Private services", amount: "9000000000", maxFee: "1000000" });
  const insert = (id: string, entityId: string | null, permission = "company:read") => db.prepare("INSERT INTO notices(id,organization_id,title,body,entity_id,required_permission,created_at) VALUES(?,?,'Payment update','Review the record',?,?,?)").run(id, access.organizationId, entityId, permission, at);
  insert("local-notice", bill.payment_id);
  insert("foreign-notice", otherBill.payment_id);
  insert("missing-notice", "deleted-payment");
  insert("general-notice", null);
  insert("restricted-notice", bill.payment_id, "documents:manage");
  const notices = new Map(noticePage(viewer, 1, 25).notices.map(notice => [notice.id, notice]));
  assert.deepEqual(notices.get("local-notice")?.payment, { reference: "DESIGN-NOV", recipientName: "Recorded supplier", amount: "1250000000" });
  for (const id of ["foreign-notice", "missing-notice", "general-notice"]) assert.equal(notices.get(id)?.payment, null);
  assert.equal(notices.has("restricted-notice"), false);
  assert.ok(noticePage({ ...viewer, permissions: ["company:read"] }, 1, 25).notices.every(notice => notice.payment === null));
  assert.equal(noticePage(viewer, 2, 25).notices.length, 0);
});

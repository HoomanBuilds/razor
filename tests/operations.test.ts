import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, row, rows } from "../src/server/db";
import { PERMISSIONS, getAccess } from "../src/server/identity/session";
import { approveBill, createBill, createPayrollRun, approvePayrollRun } from "../src/server/business/service";
import { createRecurring, listNotices, readNotice } from "../src/server/operations/service";
import { tickOperations } from "../src/server/operations/worker";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ac".repeat(32);
delete process.env.RAZOR_EXECUTOR_PRIVATE_KEY;

function fixture() {
  const db = getDb(), organizationId = randomUUID(), userId = randomUUID(), roleId = randomUUID(), recipientId = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(userId, "Owner", now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId, "Company", userId, now, now);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(roleId, organizationId, "Owner", JSON.stringify(PERMISSIONS), now);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(organizationId, userId, roleId, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'vendor','USDC','base',?,'confirmed',?,?,?)").run(recipientId, organizationId, "Supplier", `0x${"13".repeat(20)}`, now, now, now);
  const access = getAccess(userId, organizationId);
  const invoice = createBill(access, { recipientId, reference: "template", title: "Recurring service", amount: "10000000", maxFee: "1000000" });
  approveBill(access, invoice.id);
  const due = new Date(Date.now() - 60_000).toISOString();
  return { access, invoice, recipientId, due };
}

test("durable recurring jobs create one unapproved draft across ticks and recovered leases", async () => {
  const { access, invoice, due } = fixture();
  const rule = createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  assert.equal(createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" }).id, rule.id);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  getDb().prepare("UPDATE operation_jobs SET status='running',lease_owner='lost-worker',lease_expires_at=?,run_at=? WHERE organization_id=? AND kind='recurring'").run(due, due, access.organizationId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 2);
  const generated = row<{ status: string; approved_at: string | null }>("SELECT status,approved_at FROM payments WHERE organization_id=? AND id!=?", access.organizationId, invoice.payment_id)!;
  assert.equal(generated.status, "draft");
  assert.equal(generated.approved_at, null);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_occurrences WHERE rule_id=?", rule.id)!.n, 1);
  const notices = listNotices(access);
  const draftNotice = notices.find((notice) => notice.title === "Recurring draft ready")!;
  assert.ok(draftNotice);
  readNotice(access, draftNotice.id);
  const colleagueId = randomUUID();
  getDb().prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(colleagueId, "Colleague", due);
  const colleague = { ...access, userId: colleagueId };
  assert.ok(listNotices(access).find((notice) => notice.id === draftNotice.id)?.read_at);
  assert.equal(listNotices(colleague).find((notice) => notice.id === draftNotice.id)?.read_at, null);
  assert.equal(listNotices({ ...colleague, permissions: ["company:read"] }).length, 0);
});

test("pause blocks new recurring drafts while reconciliation jobs keep running", async () => {
  const { access, invoice, due } = fixture();
  createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  getDb().prepare("UPDATE organizations SET paused=1 WHERE id=?").run(access.organizationId);
  getDb().prepare("UPDATE payments SET status='paid' WHERE id=?").run(invoice.payment_id);
  getDb().prepare("INSERT INTO operation_jobs(id,organization_id,job_key,kind,entity_id,run_at,created_at,updated_at) VALUES(?,?,?,'reconcile_payment',?,?,?,?)").run(randomUUID(), access.organizationId, "reconcile-existing", invoice.payment_id, due, due, due);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 1);
  assert.equal(row<{ status: string }>("SELECT status FROM operation_jobs WHERE organization_id=? AND kind='recurring'", access.organizationId)!.status, "blocked");
  assert.equal(row<{ status: string }>("SELECT status FROM operation_jobs WHERE organization_id=? AND job_key='reconcile-existing'", access.organizationId)!.status, "completed");
  getDb().prepare("UPDATE organizations SET paused=0 WHERE id=?").run(access.organizationId);
  getDb().prepare("UPDATE operation_jobs SET run_at=? WHERE organization_id=? AND status='blocked'").run(due, access.organizationId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 2);
});

test("changed destination versions hold recurring work and partial source invoices are rejected", async () => {
  const { access, invoice, recipientId, due } = fixture();
  const rule = createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(recipientId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ status: string; enabled: number }>("SELECT status,enabled FROM recurring_rules WHERE id=?", rule.id)!.status, "held");
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 1);
  assert.equal(rows("SELECT * FROM recurring_occurrences WHERE rule_id=? AND status='held'", rule.id).length, 1);
  getDb().prepare("UPDATE payments SET amount='5000000' WHERE id=?").run(invoice.payment_id);
  assert.throws(() => createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" }), /partial installments/);
});

test("monthly payroll creates the next calendar entitlement and advances one durable cycle", async () => {
  const { access, recipientId } = fixture();
  const original = createPayrollRun(access, { reference: "monthly-source", periodStart: "2025-12-01", periodEnd: "2025-12-31", scheduledFor: "2026-01-01T09:00:00Z", items: [{ recipientId, amount: "1000000" }] });
  approvePayrollRun(access, original.id);
  const rule = createRecurring(access, { kind: "payroll", entityId: original.id, intervalDays: 1, cadence: "months", intervalMonths: 1, nextRunAt: "2026-02-01T09:00:00Z", maxAmount: "1000000" });
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  const generated = row<{ period_start: string; period_end: string; status: string }>("SELECT period_start,period_end,status FROM payroll_runs WHERE organization_id=? AND id!=?", access.organizationId, original.id)!;
  assert.equal(generated.period_start, "2026-01-01");
  assert.equal(generated.period_end, "2026-01-31");
  assert.equal(generated.status, "draft");
  assert.equal(row<{ next_run_at: string }>("SELECT next_run_at FROM recurring_rules WHERE id=?", rule.id)?.next_run_at, "2026-03-01T09:00:00.000Z");
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_occurrences WHERE rule_id=?", rule.id)?.n, 1);
});

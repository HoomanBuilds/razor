import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ApiError } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { PERMISSIONS, getAccess } from "../src/server/identity/session";
import { approveBill, createBill, createPayrollRun, getPayrollRun } from "../src/server/business/service";
import { createRecurring, setRecurring } from "../src/server/operations/service";
import { tickOperations } from "../src/server/operations/worker";
import { createRound } from "../src/server/clearing/service";
import { analyzeInvoice } from "../src/server/assistant/service";
import { getEntitlements } from "../src/server/billing/entitlements";
import { applyPurchase, quotePurchase } from "../src/server/billing/subscriptions";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "bd".repeat(32);
process.env.RAZOR_BILLING_MODE = "enforced";

function fixture() {
  const id = randomUUID(), at = new Date().toISOString(), role = randomUUID(), recipient = randomUUID(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id, at);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id, id, at, at);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,'Owner',?,1,?)").run(role, id, JSON.stringify(PERMISSIONS), at);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id, id, role, at);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,'Supplier','vendor','USDC','near','supplier.testnet','confirmed',?,?,?)").run(recipient, id, at, at, at);
  return { access: getAccess(id, id), recipient, db };
}
const paidFeature = (error: unknown) => error instanceof ApiError && error.status === 402 && error.code === "BILLING_FEATURE_REQUIRED";

test("Free permits manual obligations and existing payroll while blocking new commercial automation", () => {
  const { access, recipient, db } = fixture();
  const bill = createBill(access, { recipientId: recipient, reference: "manual", title: "Manual bill", amount: "1000000" });
  approveBill(access, bill.id);
  const payroll = { reference: "manual-payroll", periodStart: "2026-11-01", periodEnd: "2026-11-30", items: [{ recipientId: recipient, amount: "1000000" }] };
  const one = createPayrollRun(access, payroll);
  assert.equal(getPayrollRun(access, one.id).status, "draft");
  assert.throws(() => createPayrollRun(access, { ...payroll, reference: "batch", items: [...payroll.items, ...payroll.items] }), paidFeature);
  assert.throws(() => createRecurring(access, { kind: "bill", entityId: bill.id, nextRunAt: new Date().toISOString(), intervalDays: 30, maxAmount: "1000000" }), paidFeature);
  assert.throws(() => createRound(access, { linkIds: [], startsAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60000).toISOString(), reviewToken: "unreviewed" }), paidFeature);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM payroll_runs WHERE organization_id=?", access.organizationId)!.n, 1);
  assert.equal(db.prepare("SELECT status FROM payments WHERE id=?").get(bill.payment_id!)?.status, "approved_unfunded");
});

test("lapsed recurring work waits without losing its cycle and resumes once after renewal", async () => {
  const { access, recipient } = fixture(), due = new Date(Date.now()-60000).toISOString();
  const bill = createBill(access, { recipientId: recipient, reference: "recurring-source", title: "Recurring service", amount: "1000000" });
  approveBill(access, bill.id);
  process.env.RAZOR_BILLING_MODE = "pilot";
  const rule = createRecurring(access, { kind: "bill", entityId: bill.id, nextRunAt: due, intervalDays: 30, maxAmount: "1000000" });
  process.env.RAZOR_BILLING_MODE = "enforced";
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_occurrences WHERE rule_id=?", rule.id)!.n, 0);
  assert.equal(row<{ enabled: number }>("SELECT enabled FROM recurring_rules WHERE id=?", rule.id)!.enabled, 1);
  assert.throws(() => setRecurring(access, rule.id, true), paidFeature);
  const terms = quotePurchase(access.organizationId, "pro-1");
  assert.equal(applyPurchase(access.organizationId, randomUUID(), terms).status, "activated");
  getDb().prepare("UPDATE operation_jobs SET run_at=? WHERE organization_id=? AND kind='recurring'").run(due, access.organizationId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_occurrences WHERE rule_id=? AND status='drafted'", rule.id)!.n, 1);
  setRecurring(access, rule.id, false);
});

test("invalid or unconfigured private AI consumes no company allowance and dispatches nothing", async () => {
  const { access } = fixture(), saved = process.env.NEAR_AI_API_KEY, transport = globalThis.fetch;
  let dispatched = 0;
  process.env.RAZOR_BILLING_MODE = "pilot";
  delete process.env.NEAR_AI_API_KEY;
  globalThis.fetch = async () => { dispatched++; throw new Error("No inference is permitted"); };
  try {
    await assert.rejects(analyzeInvoice(access, ""), /invoice text/);
    await assert.rejects(analyzeInvoice(access, "Confidential invoice"), /NEAR_AI_API_KEY/);
    assert.equal(getEntitlements(access).usage.aiAttempts, 0);
    assert.equal(dispatched, 0);
  } finally {
    globalThis.fetch = transport;
    if (saved === undefined) delete process.env.NEAR_AI_API_KEY; else process.env.NEAR_AI_API_KEY = saved;
    process.env.RAZOR_BILLING_MODE = "enforced";
  }
});

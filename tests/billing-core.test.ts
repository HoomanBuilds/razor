import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row, transaction } from "../src/server/db";
import { PERMISSIONS } from "../src/server/identity/session";
import { getPlanVersion, latestPlan, listPublishedPlans, publishPlanVersion, retirePlanVersion } from "../src/server/billing/catalog";
import { assertFeature, getEntitlements } from "../src/server/billing/entitlements";
import { applyPurchase, cancelSubscription, dependentPurchaseInvoices, getSubscriptionState, nextBillingMonth, quotePurchase, resumeSubscription, revokePurchase, schedulePlanChange } from "../src/server/billing/subscriptions";
import { assertSeatCapacity, completeAiUsage, financeSeatUsage, reserveAiUsage } from "../src/server/billing/usage";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ab".repeat(32);

function fixture() {
  const id = randomUUID(), at = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id, at);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id, id, at, at);
  const roleId = randomUUID();
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,'Owner',?,1,?)").run(roleId, id, JSON.stringify(PERMISSIONS), at);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id, id, roleId, at);
  return { access: { userId: id, organizationId: id, permissions: [...PERMISSIONS] } satisfies AccessContext, roleId, at };
}

function purchase(organizationId: string, code: "pro" | "business", at: string | Date = new Date()) {
  const invoice = randomUUID(), terms = quotePurchase(organizationId, latestPlan(code).id, at), result = applyPurchase(organizationId, invoice, terms, at);
  assert.equal(result.status, "activated");
  return { invoice, terms, result };
}

test("billing catalog stores immutable versions and rejects obsolete offers while honoring frozen invoices", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), original = latestPlan("pro");
  assert.deepEqual(listPublishedPlans().map(plan => plan.code), ["free", "pro", "business"]);
  assert.throws(() => getDb().prepare("UPDATE billing_plan_versions SET monthly_amount='1' WHERE id=?").run(original.id), /IMMUTABLE/);
  assert.throws(() => getDb().prepare("DELETE FROM billing_plan_versions WHERE id=?").run(original.id), /IMMUTABLE/);
  const revised = publishPlanVersion({ code: "pro", name: "Pro next", monthlyAmount: "31000000", features: original.features, limits: original.limits });
  assert.equal(revised.version, original.version + 1);
  assert.throws(() => quotePurchase(access.organizationId, original.id), (error: ApiError) => error.code === "BILLING_PLAN_OFFER_CHANGED");
  const terms = quotePurchase(access.organizationId, revised.id), invoice = randomUUID();
  retirePlanVersion(revised.id);
  assert.equal(getPlanVersion(revised.id).available, false);
  assert.equal(applyPurchase(access.organizationId, invoice, terms).status, "activated");
  assert.equal(getSubscriptionState(access.organizationId).plan.monthlyAmount, "31000000");
  assert.throws(() => retirePlanVersion(original.id), /replacement/);
  assert.throws(() => publishPlanVersion({ code: "free", name: "Bad", monthlyAmount: "00", features: original.features, limits: original.limits }));
  assert.throws(() => publishPlanVersion({ code: "business", name: "Bad", monthlyAmount: "0", features: original.features, limits: original.limits }));
  assert.throws(() => publishPlanVersion({ code: "business", name: "Bad", monthlyAmount: "1000000000001", features: original.features, limits: original.limits }));
});

test("pilot access is complimentary and bounded while enforced companies start on Free", () => {
  const { access } = fixture();
  process.env.RAZOR_BILLING_MODE = "pilot";
  const pilot = getEntitlements(access);
  assert.equal(pilot.pilot, true); assert.equal(pilot.status, "pilot");
  assert.equal(pilot.plan.code, "pro"); assert.equal(pilot.limits.aiAttempts, 50);
  assert.equal(pilot.paidThrough, null); assert.equal(pilot.canManage, true);
  assertFeature(access, "batch_payroll");
  process.env.RAZOR_BILLING_MODE = "enforced";
  const free = getEntitlements(access);
  assert.equal(free.plan.code, "free"); assert.equal(free.limits.financeSeats, 3);
  assert.throws(() => assertFeature(access, "recurring"), (error: ApiError) => error.status === 402 && error.code === "BILLING_FEATURE_REQUIRED");
  assert.throws(() => reserveAiUsage(access), (error: ApiError) => error.code === "BILLING_FEATURE_REQUIRED");
  process.env.RAZOR_BILLING_MODE = "misspelled";
  assert.throws(() => getEntitlements(access), /pilot or enforced/);
});

test("calendar billing retains month-end anchors through short and leap months", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), first = purchase(access.organizationId, "pro", "2028-01-31T08:09:10.000Z");
  assert.equal(first.result.period?.endsAt, "2028-02-29T08:09:10.000Z");
  const second = purchase(access.organizationId, "pro", "2028-02-10T08:09:10.000Z");
  assert.equal(second.result.period?.startsAt, "2028-02-29T08:09:10.000Z");
  assert.equal(second.result.period?.endsAt, "2028-03-31T08:09:10.000Z");
  assert.equal(getSubscriptionState(access.organizationId, "2028-02-20T00:00:00.000Z").currentPeriod?.id, first.result.period?.id);
  assert.equal(getSubscriptionState(access.organizationId, "2028-03-01T00:00:00.000Z").currentPeriod?.id, second.result.period?.id);
  assert.equal(nextBillingMonth("2026-01-31T00:00:00.000Z"), "2026-02-28T00:00:00.000Z");
});

test("early renewal adds a distinct next period without resetting the current allowance", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), first = purchase(access.organizationId, "pro", "2026-05-15T12:00:00.000Z");
  const before = getSubscriptionState(access.organizationId, "2026-05-20T12:00:00.000Z");
  const renewal = purchase(access.organizationId, "pro", "2026-05-20T12:00:00.000Z");
  const after = getSubscriptionState(access.organizationId, "2026-05-20T12:00:00.000Z");
  assert.equal(renewal.terms.kind, "renew"); assert.equal(renewal.terms.amount, "29000000");
  assert.equal(before.period.usageKey, after.period.usageKey);
  assert.equal(after.currentPeriod?.id, first.result.period?.id);
  assert.equal(after.paidThrough, "2026-07-15T12:00:00.000Z");
  assert.notEqual(after.nextPeriod?.usageKey, before.period.usageKey);
});

test("an upgrade prorates only the incremental price, retains the end and shares existing usage", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), first = purchase(access.organizationId, "pro", "2026-04-01T00:00:00.000Z");
  const upgrade = purchase(access.organizationId, "business", "2026-04-16T00:00:00.000Z");
  assert.equal(upgrade.terms.kind, "upgrade"); assert.equal(upgrade.terms.amount, "35000000");
  assert.equal(upgrade.result.period?.endsAt, "2026-05-01T00:00:00.000Z");
  assert.equal(upgrade.result.period?.usageKey, first.result.period?.usageKey);
  assert.equal(getSubscriptionState(access.organizationId, "2026-04-16T01:00:00.000Z").plan.code, "business");
  const almostEnded = fixture(); purchase(almostEnded.access.organizationId, "pro", "2026-04-01T00:00:00.000Z");
  assert.equal(quotePurchase(almostEnded.access.organizationId, latestPlan("business").id, "2026-04-30T23:59:59.999Z").amount, "1");
});

test("cancellation and next-cycle downgrade preserve current and prepaid benefits", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(); purchase(access.organizationId, "business", "2026-05-01T00:00:00.000Z");
  const scheduled = schedulePlanChange(access, latestPlan("pro").id, "2026-05-10T00:00:00.000Z");
  assert.equal(scheduled.plan.code, "business"); assert.equal(scheduled.scheduledPlan?.code, "pro");
  const lower = purchase(access.organizationId, "pro", "2026-05-11T00:00:00.000Z");
  assert.equal(lower.terms.kind, "downgrade"); assert.equal(lower.result.period?.startsAt, "2026-06-01T00:00:00.000Z");
  const canceled = cancelSubscription(access, "2026-05-12T00:00:00.000Z");
  assert.equal(canceled.plan.code, "business"); assert.equal(canceled.paidThrough, "2026-07-01T00:00:00.000Z");
  assert.equal(getSubscriptionState(access.organizationId, "2026-06-02T00:00:00.000Z").plan.code, "pro");
  assert.equal(getSubscriptionState(access.organizationId, "2026-07-01T00:00:00.000Z").plan.code, "free");
  assert.throws(() => quotePurchase(access.organizationId, latestPlan("pro").id, "2026-05-13T00:00:00.000Z"), /Resume/);
  assert.equal(resumeSubscription(access, "2026-05-13T00:00:00.000Z").cancelAtPeriodEnd, false);
});

test("receipt application is idempotent, company bound and preserves stale payments for refund", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), other = fixture(), at = "2026-08-01T00:00:00.000Z";
  const terms = quotePurchase(access.organizationId, latestPlan("pro").id, at), stale = quotePurchase(access.organizationId, latestPlan("business").id, at), invoice = randomUUID();
  const first = applyPurchase(access.organizationId, invoice, terms, at), replay = applyPurchase(access.organizationId, invoice, terms, at);
  assert.equal(first.status, "activated"); assert.equal(replay.alreadyApplied, true);
  assert.equal(first.period?.id, replay.period?.id);
  assert.equal(applyPurchase(access.organizationId, randomUUID(), stale, at).status, "credit_required");
  assert.throws(() => applyPurchase(other.access.organizationId, invoice, terms, at), /another company/);
  assert.throws(() => applyPurchase(other.access.organizationId, randomUUID(), terms, at), /do not match/);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM billing_periods WHERE organization_id=?", access.organizationId)!.count, 1);
});

test("modified terms and confirmation before the offer never create an entitlement", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), at = "2026-08-01T00:00:00.000Z", terms = quotePurchase(access.organizationId, latestPlan("pro").id, at);
  assert.throws(() => applyPurchase(access.organizationId, randomUUID(), { ...terms, amount: "1" }, at), /modified/);
  assert.throws(() => applyPurchase(access.organizationId, randomUUID(), terms, "2026-07-31T23:59:59.000Z"), /precedes/);
  assert.equal(getSubscriptionState(access.organizationId, at).plan.code, "free");
});

test("a fully refunded upgrade restores unexpired lower access without restoring its used quota", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), initial = purchase(access.organizationId, "pro", "2026-09-01T00:00:00.000Z"), upgrade = purchase(access.organizationId, "business", "2026-09-10T00:00:00.000Z");
  const restored = revokePurchase(access.organizationId, upgrade.invoice, "2026-09-11T00:00:00.000Z");
  assert.equal(restored.plan.code, "pro"); assert.equal(restored.period.usageKey, initial.result.period?.usageKey);
  assert.equal(revokePurchase(access.organizationId, upgrade.invoice, "2026-09-11T00:00:00.000Z").revision, restored.revision);
  assert.equal(revokePurchase(access.organizationId, initial.invoice, "2026-09-12T00:00:00.000Z").plan.code, "free");
});

test("only the actual owner may change subscriptions and paid Business wins over pilot Pro", () => {
  const { access } = fixture(), administrator = fixture().access;
  process.env.RAZOR_BILLING_MODE = "pilot";
  const outsider = { ...administrator, organizationId: access.organizationId };
  assert.equal(getEntitlements(outsider).canManage, false);
  assert.throws(() => cancelSubscription(outsider), (error: ApiError) => error.code === "BILLING_OWNER_REQUIRED");
  assert.throws(() => schedulePlanChange(outsider, latestPlan("free").id), /Only/);
  purchase(access.organizationId, "business");
  const paid = getEntitlements(access);
  assert.equal(paid.pilot, false); assert.equal(paid.plan.code, "business"); assert.equal(paid.limits.aiAttempts, 500);
  assert(!("sourceInvoiceId" in paid.period));
});

test("out-of-order base refunds fail closed for dependent upgrades while independent prepaid renewals remain valid", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access } = fixture(), initial = purchase(access.organizationId, "pro", "2026-09-01T00:00:00.000Z");
  const next = purchase(access.organizationId, "pro", "2026-09-02T00:00:00.000Z"), upgrade = purchase(access.organizationId, "business", "2026-09-10T00:00:00.000Z");
  assert.deepEqual(dependentPurchaseInvoices(access.organizationId, initial.invoice), [upgrade.invoice]);
  const refunded = revokePurchase(access.organizationId, initial.invoice, "2026-09-11T00:00:00.000Z");
  assert.equal(refunded.plan.code, "free");
  assert.equal(refunded.nextPeriod?.id, next.result.period?.id);
  assert.equal(getSubscriptionState(access.organizationId, "2026-10-02T00:00:00.000Z").plan.code, "pro");
  assert.deepEqual(dependentPurchaseInvoices(access.organizationId, next.invoice), []);
  assert.equal(revokePurchase(access.organizationId, upgrade.invoice, "2026-09-12T00:00:00.000Z").plan.code, "free");
});

test("AI reservations count failures, reject duplicate dispatch and share one allowance across operations", () => {
  const { access } = fixture(); process.env.RAZOR_BILLING_MODE = "pilot";
  const request = randomUUID(), first = reserveAiUsage(access, request);
  completeAiUsage(first.id, "failed"); completeAiUsage(first.id, "completed");
  assert.throws(() => reserveAiUsage(access, request), (error: ApiError) => error.code === "AI_REQUEST_ALREADY_RECORDED");
  transaction(() => { for (let index = 1; index < 50; index++) completeAiUsage(reserveAiUsage(access, `different-operation-${index}`).id, "completed"); });
  assert.throws(() => reserveAiUsage(access), (error: ApiError) => error.code === "BILLING_AI_LIMIT");
  const usage = getEntitlements(access).usage;
  assert.equal(usage.aiAttempts, 50); assert.equal(usage.aiFailed, 1); assert.equal(usage.aiCompleted, 49);
  assert.equal(getEntitlements(fixture().access).usage.aiAttempts, 0);
  assert.throws(() => reserveAiUsage({ ...access, permissions: ["company:read"] }), /permission/);
});

test("seat capacity counts pending invitations, avoids counting its own acceptance twice and preserves existing members", () => {
  process.env.RAZOR_BILLING_MODE = "enforced";
  const { access, roleId, at } = fixture(), db = getDb(), invitation = randomUUID();
  db.prepare("INSERT INTO organization_invitations(id,organization_id,email,role_id,token_hash,created_by,expires_at,created_at) VALUES(?,?,'first@example.test',?,?,?,?,?)").run(invitation, access.organizationId, roleId, randomUUID(), access.userId, new Date(Date.now() + 60000).toISOString(), at);
  assert.equal(financeSeatUsage(access.organizationId), 2);
  assertSeatCapacity(access);
  db.prepare("INSERT INTO organization_invitations(id,organization_id,email,role_id,token_hash,created_by,expires_at,created_at) VALUES(?,?,'second@example.test',?,?,?,?,?)").run(randomUUID(), access.organizationId, roleId, randomUUID(), access.userId, new Date(Date.now() + 60000).toISOString(), at);
  assert.equal(financeSeatUsage(access.organizationId), 3);
  assert.throws(() => assertSeatCapacity(access), (error: ApiError) => error.code === "BILLING_SEAT_LIMIT");
  assertSeatCapacity(access, { excludeInvitationId: invitation, additional: 1 });
  assertSeatCapacity(access, { existingUserId: access.userId });
  assert.equal(row<{ status: string }>("SELECT status FROM memberships WHERE organization_id=? AND user_id=?", access.organizationId, access.userId)!.status, "active");
});

test("parallel server processes reserve the final AI slot once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "razor-billing-quota-")), company = randomUUID(), invoke = promisify(execFile);
  const env = { ...process.env, DATABASE_PATH: join(directory, "quota.sqlite"), RAZOR_BILLING_MODE: "pilot" };
  const run = (source: string) => invoke(process.execPath, ["--max-old-space-size=192", "--import", "tsx", "--input-type=module", "-e", source], { env, cwd: process.cwd() });
  try {
    await run(`import {getDb} from './src/server/db.ts';import {publishPlanVersion,latestPlan} from './src/server/billing/catalog.ts';const db=getDb(),at=new Date().toISOString(),id=${JSON.stringify(company)};db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id,'Owner',at);db.prepare('INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'Company',id,at,at);const p=latestPlan('pro');publishPlanVersion({code:'pro',name:'Quota fixture',monthlyAmount:p.monthlyAmount,features:p.features,limits:{financeSeats:10,aiAttempts:1}});`);
    const source = `import {reserveAiUsage} from './src/server/billing/usage.ts';const id=${JSON.stringify(company)};try{reserveAiUsage({userId:id,organizationId:id,permissions:['company:read','documents:manage']});process.stdout.write('reserved');}catch(error){if(error.code!=='BILLING_AI_LIMIT')throw error;process.stdout.write(error.code);}`;
    const results = await Promise.all([run(source), run(source)]);
    assert.deepEqual(results.map(result => result.stdout).sort(), ["BILLING_AI_LIMIT", "reserved"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

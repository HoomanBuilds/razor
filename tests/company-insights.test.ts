import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row, transaction } from "../src/server/db";
import { getAccess } from "../src/server/identity/session";
import { insightsRoutes } from "../src/server/insights";
import { aggregateInsights, compareCosts, comparisonInput, insightWindow, type InsightRecords } from "../src/server/insights/model";
import { companyInsights, companyInsightsCsv, compareCompanyCosts } from "../src/server/insights/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "28".repeat(32);
const code = (wanted: string) => (error: unknown) => error instanceof ApiError && error.code === wanted;
const at = new Date("2020-01-15T12:00:00.000Z"), window = { from: "2020-01-01", to: "2020-01-14" };
const empty = (): InsightRecords => ({ payments: [], attempts: [], subscriptions: [], setoffs: [], fundedDischarges: [], truncated: [] });
function finance() {
  const userId = randomUUID(), organizationId = randomUUID(), role = randomUUID(), timestamp = at.toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Private finance user',?)").run(userId, timestamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Private company',?,?,?)").run(organizationId, userId, timestamp, timestamp);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,'Finance',?,1,?)").run(role, organizationId, JSON.stringify(["company:read", "payments:read", "reports:read"]), timestamp);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(organizationId, userId, role, timestamp);
  return { access: getAccess(userId, organizationId), role };
}
function payment(access: AccessContext, options: { createdAt?: string; status?: string; amount?: string; spent?: string; delivered?: string; attempt?: boolean } = {}) {
  const id = randomUUID(), timestamp = options.createdAt ?? "2020-01-05T12:00:00.000Z";
  getDb().prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,total_spent,delivered_amount,created_at,updated_at) VALUES(?,?,?,'payroll',?,?, '0',?,1,?, ?,?,?,?)")
    .run(id, access.organizationId, randomUUID(), `CONFIDENTIAL-SALARY-${id}`, options.amount ?? "100000000", options.status ?? "paid", JSON.stringify({ primary_address: "PRIVATE-OWNER-WALLET" }), options.spent ?? "101000000", options.delivered ?? "100000000", timestamp, at.toISOString());
  if (options.attempt !== false) getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary',? ,?,'USDC','near','PRIVATE-DESTINATION','100000000','101000000','PRIVATE-DEPOSIT',?,?)")
    .run(randomUUID(), id, access.organizationId, options.status === "held" ? "unknown" : "delivered", JSON.stringify({ kind: "direct", rawDocument: "SECRET-PAYROLL-DOCUMENT" }), timestamp, timestamp);
  return id;
}
function comparison() { return { ...window, basis: "observed" as const, sameScopeAcknowledged: true as const, networkScope: "Native NEAR USDC destinations", competitorPercent: "2.5", competitorFixedUSDC: "0.5", subscriptionAllocation: "none" as const }; }

test("UTC windows are inclusive, calendar-valid, bounded and explicit", () => {
  const selected = insightWindow(window, at);
  assert.equal(selected.start, "2020-01-01T00:00:00.000Z"); assert.equal(selected.endExclusive, "2020-01-15T00:00:00.000Z");
  assert.equal(insightWindow({}, at).from, "2019-12-17");
  for (const input of [{ from: "2019-01-01", to: "2020-01-14" }, { from: "2020-01-15", to: "2020-01-14" }, { from: "2020-01-14", to: "2020-01-16" }, { from: "2020-02-30", to: "2020-02-30" }]) assert.throws(() => insightWindow(input, at));
  assert.equal(insightWindow({ from: "2019-10-15", to: "2020-01-15" }, at).from, "2019-10-15");
});

test("empty data has no fabricated success percentage or gas measurement", () => {
  const result = aggregateInsights(empty());
  assert.equal(result.payments.included, 0); assert.equal(result.payments.deliveredPrincipal, "0"); assert.equal(result.payments.attemptedSuccessRate.basisPoints, null);
  assert.equal(result.measurements.nearGas, null); assert.equal(result.measurements.totalAllInCost, null); assert.equal(result.routing.comparisonAvailable, false);
  assert.throws(() => compareCosts(result, comparisonInput.parse(comparison())), code("INSIGHTS_COMPARISON_UNAVAILABLE"));
});

test("exact amounts and outcome denominators keep partial, held, unresolved and retired records separate", () => {
  const values = empty(), large = "9007199254740993000000";
  values.payments = [
    { id: "complete", status: "paid", amount: large, total_spent: "9007199254740993000100", delivered_amount: large },
    { id: "partial", status: "partially_paid", amount: "100", total_spent: "55", delivered_amount: "50" },
    { id: "held", status: "held", amount: "10", total_spent: "0", delivered_amount: "0" },
    { id: "unknown", status: "unknown", amount: "10", total_spent: "0", delivered_amount: "0" },
    { id: "retired", status: "cancelled", amount: "10", total_spent: "0", delivered_amount: "0" },
    { id: "failed", status: "failed", amount: "10", total_spent: "0", delivered_amount: "0" },
    { id: "in-flight", status: "in_flight", amount: "10", total_spent: "0", delivered_amount: "0" },
    { id: "future", status: "future_unrecognized_status", amount: "10", total_spent: "0", delivered_amount: "0" },
    { id: "draft", status: "draft", amount: "10", total_spent: "0", delivered_amount: "0" },
  ];
  values.attempts = [{ payment_id: "complete", state: "delivered", destination_network: "near", execution_kind: "direct" }, { payment_id: "partial", state: "partially_delivered", destination_network: "near", execution_kind: "direct" }];
  values.setoffs = [{ amount: "900" }]; values.fundedDischarges = [{ amount: "700" }]; values.acceptedCredits = [{ amount: "500" }];
  const result = aggregateInsights(values);
  assert.equal(result.payments.deliveredPrincipal, "9007199254740993000050"); assert.equal(result.payments.signedSpread, "105");
  assert.deepEqual(result.payments.outcomes, { successful: 1, partial: 1, held: 1, unresolved: 3, retired: 1, failed: 1, awaiting: 1 });
  assert.deepEqual(result.payments.attemptedSuccessRate, { numerator: 1, denominator: 2, basisPoints: 5000 });
  assert.equal(result.discharge.noncashSetoff, "900"); assert.equal(result.discharge.fundedEscrow, "700"); assert.equal(result.credits.acceptedAmount, "500"); assert.equal(result.credits.acceptedRecords, 1);
});

test("negative spreads, unresolved route records and truncated samples cannot become observed savings", () => {
  const values = empty(); values.payments = [{ id: "one", status: "paid", amount: "100", total_spent: "99", delivered_amount: "100" }];
  values.attempts = [{ payment_id: "one", state: "delivered", destination_network: "near", execution_kind: "direct" }];
  let result = aggregateInsights(values); assert.equal(result.routing.signedSpread, "-1"); assert.equal(result.routing.negativeSpreadPayments, 1);
  assert.throws(() => compareCosts(result, comparisonInput.parse(comparison())), code("INSIGHTS_COMPARISON_UNAVAILABLE"));
  values.payments[0].total_spent = "101"; values.attempts.push({ payment_id: "one", state: "unknown", destination_network: "near", execution_kind: "direct" });
  result = aggregateInsights(values); assert.equal(result.routing.completedMissingMeasurements, 1); assert.equal(result.routing.comparisonAvailable, false);
  values.attempts.pop(); values.truncated = ["payment_cohort"]; assert.equal(aggregateInsights(values).routing.comparisonAvailable, false);
});

test("fee comparison uses exact editable prices and explicit subscriptions without filling unknown gas with zero", () => {
  const values = empty(); values.payments = [{ id: "one", status: "paid", amount: "100000000", total_spent: "101000000", delivered_amount: "100000000" }];
  values.attempts = [{ payment_id: "one", state: "delivered", destination_network: "near", execution_kind: "direct" }]; values.subscriptions = [{ amount: "29000000", refunded_amount: "0", status: "paid" }];
  const result = aggregateInsights(values), compared = compareCosts(result, comparisonInput.parse(comparison()));
  assert.equal(compared.competitorFeeEstimate, "3000000"); assert.equal(compared.razorKnownSubtotal, "1000000"); assert.equal(compared.differenceBeforeUnknownCosts, "2000000"); assert.equal(compared.estimatedDifferenceWithEnteredCosts, null);
  const allocated = compareCosts(result, comparisonInput.parse({ ...comparison(), subscriptionAllocation: "confirmed_window", razorOtherCostsUSDC: "0.25", competitorOtherCostsUSDC: "0" }));
  assert.equal(allocated.allocatedSubscription, "29000000"); assert.equal(allocated.estimatedDifferenceWithEnteredCosts, "-27250000");
  const manual = compareCosts(aggregateInsights(empty()), comparisonInput.parse({ ...comparison(), basis: "manual", manualPrincipalUSDC: "100", manualPaymentCount: 2, manualRazorRoutingUSDC: "1", razorOtherCostsUSDC: "2", competitorOtherCostsUSDC: "0" }));
  assert.equal(manual.routingCostEvidence, "entered_estimate"); assert.equal(manual.estimatedDifferenceWithEnteredCosts, "500000");
  for (const value of ["-1", "1e6", "0.0000001", "", "0x10"]) assert.equal(comparisonInput.safeParse({ ...comparison(), competitorFixedUSDC: value }).success, false);
});

test("current company finance roles and tenant scope gate reports, calculator and exports", () => {
  const a = finance(), b = finance(); payment(a.access); payment(b.access, { amount: "900000000", delivered: "900000000", spent: "999000000" });
  const report = companyInsights(a.access, window, at); assert.equal(report.payments.included, 1); assert.equal(report.payments.deliveredPrincipal, "100000000");
  const csv = companyInsightsCsv(a.access, window), serialized = JSON.stringify(report);
  for (const secret of ["CONFIDENTIAL-SALARY", "PRIVATE-OWNER-WALLET", "PRIVATE-DESTINATION", "SECRET-PAYROLL-DOCUMENT", a.access.organizationId, b.access.organizationId]) { assert.ok(!csv.includes(secret)); assert.ok(!serialized.includes(secret)); }
  assert.match(csv, /unknown, not zero/i); assert.ok(csv.includes("payment_creation_cohort_observed_now"));
  assert.throws(() => companyInsights({ ...a.access, organizationId: b.access.organizationId }, window, at), code("COMPANY_ACCESS_DENIED"));
  getDb().prepare("UPDATE organization_roles SET permissions_json='[\"company:read\",\"payments:read\"]' WHERE id=?").run(a.role);
  for (const action of [() => companyInsights(a.access, window, at), () => companyInsightsCsv(a.access, window), () => compareCompanyCosts(a.access, comparison())]) assert.throws(action, code("FORBIDDEN"));
});

test("SQL creation cohort boundaries exclude adjacent dates and report current outcomes honestly", () => {
  const f = finance(); payment(f.access, { createdAt: "2019-12-31T23:59:59.999Z" }); payment(f.access, { createdAt: "2020-01-01T00:00:00.000Z", status: "held", delivered: "0", spent: "100000000" }); payment(f.access, { createdAt: "2020-01-14T23:59:59.999Z" }); payment(f.access, { createdAt: "2020-01-15T00:00:00.000Z" });
  const report = companyInsights(f.access, window, at); assert.equal(report.payments.included, 2); assert.equal(report.payments.outcomes.held, 1); assert.equal(report.payments.outcomes.successful, 1);
  assert.ok(report.scopes.payments.includes("not settlement-date")); assert.equal(report.window.observedAt, at.toISOString());
});

test("query caps are visible and prevent a complete-cost claim for large cohorts", () => {
  const f = finance(); transaction(() => { for (let index = 0; index < 5001; index++) payment(f.access, { status: "draft", delivered: "0", spent: "0", amount: "1", attempt: false }); });
  const report = companyInsights(f.access, window, at); assert.equal(report.payments.included, 5000); assert.equal(report.coverage.complete, false); assert.deepEqual(report.coverage.truncated, ["payment_cohort"]); assert.equal(report.routing.comparisonAvailable, false);
});

test("read-only router returns private aggregates and calculator requests make no financial writes", async () => {
  const f = finance(); payment(f.access); const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("access", f.access); await next(); }); app.route("/insights", insightsRoutes);
  const before = row<{ count: number }>("SELECT COUNT(*) count FROM treasury_ledger")!.count;
  const response = await app.request("http://localhost/insights?from=2020-01-01&to=2020-01-14"); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const compare = await app.request("http://localhost/insights/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(comparison()) }); assert.equal(compare.status, 200);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM treasury_ledger")!.count, before);
  const csv = await app.request("http://localhost/insights/export?from=2020-01-01&to=2020-01-14"); assert.equal(csv.status, 200); assert.ok((await csv.text()).includes("noncash_setoff"));
});

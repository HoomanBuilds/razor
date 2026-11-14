import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentActivity, proportion } from "../src/lib/payment-activity";

const now = new Date("2026-11-14T12:00:00Z");
test("activity counts creation cohorts while keeping settled, held and retired records separate", () => {
  const result = paymentActivity([
    { created_at: "2026-11-14T01:00:00Z", status: "paid", kind: "payroll" },
    { created_at: "2026-11-14T03:00:00Z", status: "held", kind: "invoice" },
    { created_at: "2026-11-13T23:59:59Z", status: "draft", kind: "manual" },
    { created_at: "2026-10-01T00:00:00Z", status: "cancelled", kind: "invoice" },
  ], now);
  assert.deepEqual(result.states, { settled: 1, open: 1, review: 1, closed: 1 });
  assert.deepEqual(result.kinds, { payroll: 1, invoices: 2, other: 1 });
  assert.deepEqual(result.series.at(-1), { date: "2026-11-14", settled: 1, open: 0, review: 1, closed: 0 });
  assert.equal(result.series.reduce((sum, day) => sum + day.settled + day.open + day.review + day.closed, 0), 3);
  assert.equal(result.total, 4);
});
test("empty cohorts have zero bars and UTC boundaries exclude older and future dates", () => {
  const empty = paymentActivity([], now);
  assert.equal(empty.series.length, 21);
  assert.equal(empty.window.from, "2026-10-25");
  const result = paymentActivity([
    { created_at: "2026-10-25T00:00:00Z", status: "partially_paid", kind: "payroll" },
    { created_at: "2026-10-24T23:59:59Z", status: "paid", kind: "invoice" },
    { created_at: "2026-11-15T00:00:00Z", status: "paid", kind: "invoice" },
    { created_at: "invalid", status: "cancelled", kind: "other" },
  ], now);
  assert.equal(result.series[0].review, 1);
  assert.equal(result.series.reduce((sum, day) => sum + day.settled, 0), 0);
  assert.equal(result.total, 4);
});
test("proportions handle empty budgets, oversized values and large atomic amounts without numeric overflow", () => {
  assert.equal(proportion(0, 0), 0);
  assert.equal(proportion(-1, 5), 0);
  assert.equal(proportion(10, 5), 1);
  assert.equal(proportion("900719925474099300000000000000", "1801439850948198600000000000000"), 0.5);
  assert.equal(proportion("invalid", 5), 0);
});

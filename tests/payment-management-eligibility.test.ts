import test from "node:test";
import assert from "node:assert/strict";
import { canCancelManagedPayment } from "../src/lib/payment-management-eligibility";

const unpaid = { payment: { status: "draft", delivered_amount: "0" }, attempts: [] };

test("cancellation needs a selected record and approval permission", () => {
  assert.equal(canCancelManagedPayment(null, true), false);
  assert.equal(canCancelManagedPayment(unpaid, false), false);
  assert.equal(canCancelManagedPayment(unpaid, true), true);
});

test("clearing and any observed delivery lock cancellation", () => {
  assert.equal(canCancelManagedPayment({ ...unpaid, activeClearingRound: { id: "round" } }, true), false);
  assert.equal(canCancelManagedPayment({ ...unpaid, payment: { ...unpaid.payment, delivered_amount: "1" } }, true), false);
  assert.equal(canCancelManagedPayment({ ...unpaid, payment: { ...unpaid.payment, partial_delivery_observed: 1 } }, true), false);
});

test("terminal and unresolved payment states cannot be cancelled", () => {
  for (const status of ["cancelled", "paid", "partially_paid", "in_flight", "recovery_pending", "unknown"]) {
    assert.equal(canCancelManagedPayment({ ...unpaid, payment: { ...unpaid.payment, status } }, true), false, status);
  }
});

test("unresolved attempts block cancellation even when the payment is held", () => {
  for (const state of ["prepared", "submitted", "processing", "unknown", "recovery_pending", "reported_delivered", "reported_partial"]) {
    assert.equal(canCancelManagedPayment({ ...unpaid, payment: { ...unpaid.payment, status: "held" }, attempts: [{ state }] }, true), false, state);
  }
  assert.equal(canCancelManagedPayment({ ...unpaid, attempts: [{ state: "closed_unfunded" }, { state: "refunded_verified" }] }, true), true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceSourceAmount, sortInvoices } from "../src/lib/invoice-register";

test("outstanding invoices precede settled history and follow due dates", () => {
  const invoices = [
    { id: "paid", remainingLiability: "0", due_date: "2026-01-01" },
    { id: "later", remainingLiability: "900719925474099312345", due_date: "2026-12-01" },
    { id: "undated", remainingLiability: "1", due_date: null },
    { id: "partial", remainingLiability: "123456", due_date: "2026-11-01" },
    { id: "invalid", remainingLiability: "1", due_date: "invalid" },
    { id: "credit", remainingLiability: "0", due_date: "2026-01-02" },
  ];
  assert.deepEqual(sortInvoices(invoices).map(item => item.id), ["partial", "later", "undated", "invalid", "paid", "credit"]);
  assert.equal(invoices[0].id, "paid");
});

test("empty invoice collections and equal due dates retain stable order", () => {
  assert.deepEqual(sortInvoices([]), []);
  const invoices = [{ id: "a", remainingLiability: "1", due_date: "2026-11-15" }, { id: "b", remainingLiability: "2", due_date: "2026-11-15" }];
  assert.deepEqual(sortInvoices(invoices), invoices);
});

test("source amount formatting preserves exact foreign amounts and large decimals", () => {
  assert.equal(invoiceSourceAmount("900719925474099312345.123456789"), "900,719,925,474,099,312,345.123456789");
  assert.equal(invoiceSourceAmount("1350.00"), "1,350.00");
  assert.equal(invoiceSourceAmount("-1000.000001"), "-1,000.000001");
  assert.equal(invoiceSourceAmount("Needs review"), "Needs review");
  assert.equal(invoiceSourceAmount(""), "");
});

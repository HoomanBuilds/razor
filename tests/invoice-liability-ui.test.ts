import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceLiability } from "../src/components/workspace/invoice-liability";

test("invoice review separates reductions from delivered funds at exact USDC precision", () => {
  const html = renderToStaticMarkup(createElement(InvoiceLiability, {
    amount: "100000001", delivered: "20000000", credit: "5000000", setoff: "10000000", funded: "30000000", remaining: "35000001",
  }));
  for (const [label, value] of [
    ["Invoice total", "$100.000001"], ["Delivered funds", "$20.00"], ["Supplier credits", "$5.00"], ["Noncash discharge", "$10.00"], ["Escrow-backed settlement", "$30.00"],
  ]) assert.match(html, new RegExp(`${label}</dt><dd[^>]*>\\${value}</dd>`));
  assert.ok(html.includes("Remaining"));
  assert.ok(html.includes("$35.000001"));
  assert.ok(!html.includes("Paid"));
});

test("an unchanged draft shows its amount once and omits zero reductions", () => {
  const html = renderToStaticMarkup(createElement(InvoiceLiability, { amount: "1350000000", delivered: "0", credit: "0", setoff: "0", funded: "0", remaining: "1350000000" }));
  assert.equal(html.split("$1,350.00").length - 1, 1);
  for (const label of ["Invoice total", "Delivered funds", "Supplier credits", "Noncash discharge", "Escrow-backed settlement"]) assert.ok(!html.includes(label));
});

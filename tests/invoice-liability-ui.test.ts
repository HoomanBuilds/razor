import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceLiability } from "../src/components/workspace/invoice-liability";

test("invoice detail separates credit and escrow reductions from delivered funds at exact USDC precision", () => {
  const html = renderToStaticMarkup(createElement(InvoiceLiability, {
    amount: "100000001",
    delivered: "20000000",
    credit: "5000000",
    setoff: "10000000",
    funded: "30000000",
    remaining: "35000001",
  }));
  for (const [label, value] of [
    ["Original invoice", "$100.000001"],
    ["Delivered funds", "$20.00"],
    ["Accepted supplier credits", "$5.00"],
    ["Noncash debt discharge", "$10.00"],
    ["Escrow-backed settlement", "$30.00"],
    ["Remaining liability", "$35.000001"],
  ]) assert.ok(html.includes(`${label}</dt><dd class="mt-1 break-words text-xl font-semibold tabular-nums">${value}</dd>`));
  assert.ok(html.includes("Escrow credit rights and withdrawals remain separate"));
});

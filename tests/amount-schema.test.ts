import assert from "node:assert/strict";
import { test } from "node:test";
import { grantInput } from "../src/server/standing-mandates/service";
import { paymentDraftInput } from "../src/server/integrations/schemas";
import { quoteInput } from "../src/server/procurement/service";

const quoteAmount = (unitPrice: string) => quoteInput.safeParse({ recipientId: "supplier", expectedVersion: 0, unitPrice, deliveryDate: "2026-11-20", validUntil: "2026-11-15T00:00:00.000Z", terms: "Complete supplier terms" });

test("malformed atomic amounts fail validation without throwing conversion errors", () => {
  const parsers = [(value: string) => grantInput.shape.perPaymentMaxInput.safeParse(value), (value: string) => paymentDraftInput.shape.amount.safeParse(value), quoteAmount];
  for (const parse of parsers) {
    for (const value of ["", "not-money", "1.1", "-1", "+1", "0", "01", "1e3", "0x10", " ", "9".repeat(1000)]) {
      assert.equal(parse(value).success, false, value.slice(0, 30));
    }
    assert.equal(parse("1").success, true);
  }
});

test("financial schemas keep their exact integer upper boundaries", () => {
  const maximum = ((1n << 128n) - 1n).toString(), overflow = (1n << 128n).toString();
  for (const schema of [grantInput.shape.perPaymentMaxInput, paymentDraftInput.shape.amount]) {
    assert.equal(schema.safeParse(maximum).success, true);
    assert.equal(schema.safeParse(overflow).success, false);
  }
  assert.equal(quoteAmount((10n ** 30n).toString()).success, true);
  assert.equal(quoteAmount((10n ** 30n + 1n).toString()).success, false);
});

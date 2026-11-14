import assert from "node:assert/strict";
import { test } from "node:test";
import { grantInput } from "../src/server/standing-mandates/service";
import { paymentDraftInput } from "../src/server/integrations/schemas";
import { quoteInput } from "../src/server/procurement/service";

test("malformed atomic amounts fail validation without throwing conversion errors", () => {
  const schemas = [grantInput.shape.perPaymentMaxInput, paymentDraftInput.shape.amount, quoteInput.shape.unitPrice];
  for (const schema of schemas) {
    for (const value of ["", "not-money", "1.1", "-1", "+1", "0", "01", "1e3", "0x10", " ", "9".repeat(1000)]) {
      assert.equal(schema.safeParse(value).success, false, value.slice(0, 30));
    }
    assert.equal(schema.safeParse("1").success, true);
  }
});

test("financial schemas keep their exact integer upper boundaries", () => {
  const maximum = ((1n << 128n) - 1n).toString(), overflow = (1n << 128n).toString();
  for (const schema of [grantInput.shape.perPaymentMaxInput, paymentDraftInput.shape.amount]) {
    assert.equal(schema.safeParse(maximum).success, true);
    assert.equal(schema.safeParse(overflow).success, false);
  }
  assert.equal(quoteInput.shape.unitPrice.safeParse((10n ** 30n).toString()).success, true);
  assert.equal(quoteInput.shape.unitPrice.safeParse((10n ** 30n + 1n).toString()).success, false);
});

import { z } from "zod";
import { ApiError } from "../context";

const maximum = 10n ** 30n, amountPattern = /^(0|[1-9]\d{0,30})$/;
const amount = z.string().regex(amountPattern).refine(value => amountPattern.test(value) && BigInt(value) <= maximum);
const condition = z.string().trim().min(3).max(500);
export const commercialInput = z.object({
  version: z.literal(2), settlementUnit: z.literal("USDC"), shippingAmount: amount, serviceAmount: amount, taxAmount: amount, otherAmount: amount,
  taxTreatment: z.enum(["included", "excluded", "not_applicable"]), taxConditions: condition, shippingConditions: condition, serviceConditions: condition, deliveryConditions: condition, acceptanceConditions: condition, otherChargeConditions: condition,
  excludedCharges: z.array(z.object({ kind: z.enum(["tax", "shipping", "service", "other"]), description: condition, estimateUSDC: amount.nullable() }).strict()).max(8),
  conversionEstimate: z.object({ amountUSDC: amount, description: condition }).strict().nullable(),
}).strict().superRefine((value, context) => {
  const excludedTax = value.excludedCharges.some(charge => charge.kind === "tax");
  if (value.taxTreatment !== "included" && value.taxAmount !== "0" || value.taxTreatment === "excluded" && !excludedTax || value.taxTreatment !== "excluded" && excludedTax) context.addIssue({ code: "custom", message: "State included tax separately, or explicitly describe excluded tax with a zero included-tax amount", path: ["taxTreatment"] });
});
export type CommercialInput = z.infer<typeof commercialInput>;
export type CommercialTerms = CommercialInput & { lineSubtotal: string; fixedCharges: string; commercialTotal: string };
export function commercialParameters(value: CommercialTerms): CommercialInput { const { lineSubtotal: _subtotal, fixedCharges: _charges, commercialTotal: _total, ...input } = value; return commercialInput.parse(input); }
export function commercialTotals(quantity: string, unitPrice: string, input: CommercialInput): CommercialTerms {
  const value = commercialInput.parse(input), lineSubtotal = BigInt(quantity) * BigInt(unitPrice), fixedCharges = BigInt(value.shippingAmount) + BigInt(value.serviceAmount) + BigInt(value.taxAmount) + BigInt(value.otherAmount), total = lineSubtotal + fixedCharges;
  if (lineSubtotal <= 0n || fixedCharges > maximum || total > maximum) throw new ApiError(422, "The exact commercial quote exceeds the supported total", "PROCUREMENT_BUDGET_EXCEEDED");
  return { ...value, lineSubtotal: lineSubtotal.toString(), fixedCharges: fixedCharges.toString(), commercialTotal: total.toString() };
}

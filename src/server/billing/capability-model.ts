import { z } from "zod";

export const OPTIONAL_CAPABILITIES = [
  "private_tender",
  "financing_request",
  "claim_pool",
  "procurement_rfq",
  "accounting_plan",
  "integration_credential",
] as const;
export type OptionalCapability = (typeof OPTIONAL_CAPABILITIES)[number];
export const capabilityLabels: Record<OptionalCapability, string> = {
  private_tender: "New private tenders",
  financing_request: "New financing requests",
  claim_pool: "New independent claim pools",
  procurement_rfq: "New supplier RFQs",
  accounting_plan: "New accounting posting plans",
  integration_credential: "New integration credentials",
};
const instant = z.iso
  .datetime()
  .transform((value) => new Date(value).toISOString());
const integer = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const positive = integer.refine(
  (value) => BigInt(value) > 0n,
  "Use a positive integer quantity",
);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(5)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const limits = z
  .object(
    Object.fromEntries(
      OPTIONAL_CAPABILITIES.map((key) => [
        key,
        z.number().int().min(0).max(1000000),
      ]),
    ) as Record<OptionalCapability, z.ZodNumber>,
  )
  .strict();
const allocation = z
  .object({ observationId: z.string().uuid(), budgetAtomicUSDC: integer })
  .strict();
export const capabilityPolicyInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pilot"), limits, notice: text(600) }).strict(),
  z
    .object({
      mode: z.literal("calibrated"),
      subsidyBudgetAtomicUSDC: integer,
      allocations: z
        .object(
          Object.fromEntries(
            OPTIONAL_CAPABILITIES.map((key) => [key, allocation]),
          ) as Record<OptionalCapability, typeof allocation>,
        )
        .strict(),
      notice: text(600),
    })
    .strict(),
]);
export const costObservationInput = z
  .object({
    capability: z.enum(OPTIONAL_CAPABILITIES),
    source: text(1000),
    periodStart: instant,
    periodEnd: instant,
    sampleCount: z.number().int().min(1).max(1000000000),
    unit: z.literal("successful_optional_creation"),
    currency: z.enum(["USDC", "USD"]),
    costDecimals: z.literal(6),
    costAtomic: positive,
    allocationMethod: text(1000),
    service: z.enum([
      "hosting",
      "database",
      "storage",
      "provider_api",
      "staff_operations",
    ]),
    valuation: z
      .object({
        usdcAtomicNumerator: positive,
        costAtomicDenominator: positive,
        source: text(1000),
        asOf: instant,
      })
      .strict()
      .optional(),
    excludesNetworkGasAndCustomerFunds: z.literal(true),
    actualServiceCostAcknowledged: z.literal(true),
    reviewed: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.periodEnd <= value.periodStart ||
      Date.parse(value.periodEnd) > Date.now()
    )
      ctx.addIssue({
        code: "custom",
        message: "Use a completed real observation period",
      });
    if (value.currency === "USD" && !value.valuation)
      ctx.addIssue({
        code: "custom",
        message:
          "USD service expenses need an explicit reviewed conversion to USDC units; no peg is assumed",
      });
    if (value.currency === "USDC" && value.valuation)
      ctx.addIssue({
        code: "custom",
        message:
          "USDC expenses use their actual paid units without an exchange rate",
      });
    if (value.valuation && Date.parse(value.valuation.asOf) > Date.now())
      ctx.addIssue({
        code: "custom",
        message: "The reviewed valuation date cannot be in the future",
      });
  });
export type CostObservationInput = z.infer<typeof costObservationInput>;
export type CapabilityPolicyInput = z.infer<typeof capabilityPolicyInput>;
export interface CapabilityPolicy {
  mode: "legacy" | "pilot" | "calibrated";
  limits: Record<OptionalCapability, number | null>;
  notice: string;
  termsHash: string | null;
  calibrated: boolean;
  allocations?: Record<
    OptionalCapability,
    {
      observationId: string;
      budgetAtomicUSDC: string;
      sampleCount: number;
      periodStart: string;
      periodEnd: string;
      unitCostNumerator: string;
      unitCostDenominator: string;
    }
  >;
  subsidyBudgetAtomicUSDC?: string;
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { paymentBudget } from "../../lib/payment-budget";
import { liabilityTotals } from "../reconciliation/liability";
import { computeClearing } from "../clearing/algorithm";
import { cashTerms } from "../clearing/funded-model";
import { NATIVE_USDC } from "../../lib/native-usdc";
export const publicDemoInput = z
  .object({
    scenario: z.enum(["payments", "clearing"]).default("payments"),
    recovery: z.enum(["held", "no_send"]).default("held"),
    clearing: z
      .enum(["debt_only", "cash_backed", "token_delivery"])
      .default("debt_only"),
  })
  .strict();
export type PublicDemoSelection = z.infer<typeof publicDemoInput>;
const companies = [
  { id: "fictional-pine", name: "Pine Studio (fictional)" },
  { id: "fictional-cedar", name: "Cedar Workshop (fictional)" },
  { id: "fictional-harbor", name: "Harbor Services (fictional)" },
];
const invoices = [
  {
    id: "fictional-materials",
    debtor: companies[0].id,
    creditor: companies[1].id,
    amount: "1200000000",
  },
  {
    id: "fictional-shipping",
    debtor: companies[1].id,
    creditor: companies[2].id,
    amount: "900000000",
  },
  {
    id: "fictional-design",
    debtor: companies[2].id,
    creditor: companies[0].id,
    amount: "600000000",
  },
];
const people = [
  {
    id: "fictional-employee",
    role: "Employee payroll",
    name: "Studio teammate (fictional)",
    amount: "2400000000",
    maxFee: "2000000",
    primary: { symbol: "USDC", network: "base" },
    backup: { symbol: "USDC", network: "near" },
  },
  {
    id: "fictional-contractor",
    role: "Contractor invoice",
    name: "Independent designer (fictional)",
    amount: "900000000",
    maxFee: "3000000",
    primary: { symbol: "ETH", network: "eth" },
    backup: { symbol: "USDC", network: "base" },
  },
  {
    id: "fictional-supplier",
    role: "Business supplier invoice",
    name: "Equipment supplier (fictional)",
    amount: "1250000000",
    maxFee: "4000000",
    primary: { symbol: "USDC", network: "sol" },
    backup: { symbol: "USDC", network: "base" },
  },
];
const sum = (values: readonly string[]) =>
  values.reduce((total, value) => total + BigInt(value), 0n).toString();
const serialize = (value: ReturnType<typeof liabilityTotals>) => ({
  delivered: value.delivered.toString(),
  remaining: value.remaining.toString(),
  sourceSpent: value.sourceSpent.toString(),
  activePrincipal: value.activePrincipal.toString(),
  unprepared: value.unprepared.toString(),
});
export function getPublicDemoScenario(input: unknown = {}) {
  const selection = publicDemoInput.parse(input),
    calculation = computeClearing(invoices),
    owners = companies.map((company) => ({
      company_id: company.id,
      owner_id: `${company.name} owner - not a wallet`,
      treasury_id: "Fictional treasury - no deployed account",
      treasury_company_id: `fictional-unregistered-${company.id}`,
      version: "1",
      policy_version: "1",
    })),
    obligations = calculation.obligations.map((item) => ({
      ...item,
      terms_hash: "not-a-signed-or-registered-commitment",
    })),
    cash = cashTerms(
      { participants: owners, obligations },
      "mainnet",
      NATIVE_USDC.near,
    );
  const payments = people.map((person) => {
    const held =
        person.id === "fictional-contractor" && selection.recovery === "held",
      replaced =
        person.id === "fictional-contractor" &&
        selection.recovery === "no_send";
    const original = {
        amount: person.amount,
        max_fee: person.maxFee,
        status: held ? "unknown" : replaced ? "cancelled" : "draft",
        delivered_amount: "0",
        total_spent: "0",
        reserved_amount: "0",
      },
      current = replaced ? { ...original, status: "draft" } : original;
    const budget = paymentBudget(current),
      liability = liabilityTotals(
        person.amount,
        replaced ? [original, current] : [current],
      );
    return {
      ...person,
      hypotheticalState: held
        ? "held_unknown"
        : replaced
          ? "replacement_draft"
          : "draft",
      hypotheticalOriginalState: original.status,
      deliveryAssumption: "0",
      hypotheticalRemaining: liability.remaining.toString(),
      hypotheticalPlanningCeiling: budget.remaining.toString(),
      hypotheticalUnreserved: budget.unreserved.toString(),
      hypotheticalAwaitingReconciliation:
        budget.awaitingReconciliation.toString(),
      backupConsent:
        "Fictional recipient consent only. Live preferences and route support are not loaded.",
      evidence: "unavailable" as const,
    };
  });
  const clearingRows = calculation.obligations.map((edge) => {
    const assumedSetoff =
        selection.clearing === "debt_only" ? edge.reduction : "0",
      assumedEscrowDischarge =
        selection.clearing === "cash_backed" ? edge.original : "0",
      assumedDelivery =
        selection.clearing === "token_delivery" ? edge.original : "0",
      assumedPayments =
        assumedDelivery !== "0"
          ? [
              {
                amount: assumedDelivery,
                delivered_amount: assumedDelivery,
                total_spent: assumedDelivery,
                status: "paid",
              },
            ]
          : [];
    return {
      id: edge.id,
      debtor: edge.debtor,
      creditor: edge.creditor,
      originalFace: edge.original,
      hypotheticalNoncashSetoff: assumedSetoff,
      hypotheticalFundedDischarge: assumedEscrowDischarge,
      hypotheticalTokenDelivery: assumedDelivery,
      liability: serialize(
        liabilityTotals(
          edge.original,
          assumedPayments,
          assumedSetoff,
          assumedEscrowDischarge,
        ),
      ),
    };
  });
  const digest = createHash("sha256")
    .update(JSON.stringify({ selection, companies, invoices, people }))
    .digest("hex");
  return {
    schema: "razor.public-product-demo" as const,
    version: 1 as const,
    fictional: true as const,
    selection,
    datasetSha256: digest,
    calculatedAt: new Date().toISOString(),
    companies,
    payments,
    paymentSummary: {
      originalFace: sum(people.map((item) => item.amount)),
      hypotheticalMaxCost: sum(people.map((item) => item.maxFee)),
      hypotheticalPlanningCeiling: sum(
        payments.map((item) => item.hypotheticalPlanningCeiling),
      ),
      hypotheticalUnreserved: sum(
        payments.map((item) => item.hypotheticalUnreserved),
      ),
      hypotheticalAwaitingReconciliation: sum(
        payments.map((item) => item.hypotheticalAwaitingReconciliation),
      ),
      hypotheticalRemaining: sum(
        payments.map((item) => item.hypotheticalRemaining),
      ),
      observedAvailableBalance: null,
    },
    clearing: {
      rows: clearingRows,
      originalFace: calculation.originalInvoiceValue,
      hypotheticalNoncashSetoff: sum(
        clearingRows.map((item) => item.hypotheticalNoncashSetoff),
      ),
      hypotheticalFundedDischarge: sum(
        clearingRows.map((item) => item.hypotheticalFundedDischarge),
      ),
      hypotheticalTokenDelivery: sum(
        clearingRows.map((item) => item.hypotheticalTokenDelivery),
      ),
      hypotheticalRemaining: sum(
        clearingRows.map((item) => item.liability.remaining),
      ),
      algorithm: calculation.optimization,
      netPositions: calculation.positions,
      residualTransferVolume: calculation.residualTransferVolume,
      minimumStartingLiquidity: calculation.minimumStartingLiquidity,
      minimumLiquidityAssumption: calculation.liquidityAssumption,
      requiredNetEscrowDeposit: sum(
        cash.positions.map((item) => item.deposit_due),
      ),
      hypotheticalEscrowRights: sum(
        cash.positions.map((item) => item.credit_due),
      ),
      positions: cash.positions.map((item) => ({
        companyId: item.company_id,
        requiredDeposit: item.deposit_due,
        hypotheticalCreditRight: item.credit_due,
      })),
      observedEscrowBalance: null,
      actualFeesPaid: null,
    },
    steps:
      selection.scenario === "payments"
        ? [
            {
              title: "Confirm recipients and obligations",
              detail:
                "The fictional employee, contractor and supplier agree a USDC obligation and recipient preferences. Preferences are not token quotes or proof of current route availability.",
            },
            {
              title: "Review the exact spending ceiling",
              detail:
                "The current payment-budget algorithm keeps principal and maximum routing cost together. Maximum cost is an authorization ceiling; actual gas and conversion fees remain unavailable.",
            },
            {
              title: "Preserve unresolved authority",
              detail:
                selection.recovery === "held"
                  ? "The fictional contractor transfer is unknown. Its original budget remains awaiting reconciliation, and the planning calculation does not authorize a second transfer."
                  : "This alternative assumes conclusive original no-send evidence. The original draft is cancelled and a separately reviewed replacement retains the same unpaid entitlement. No such evidence exists in this preview.",
            },
            {
              title: "Verify real delivery separately",
              detail:
                "Only actual final source and destination evidence can establish delivery. Open the real product to create records and the local verifier to inspect independently supplied evidence.",
            },
          ]
        : [
            {
              title: "Start from original accepted invoices",
              detail:
                "Three fictional businesses owe 1200, 900 and 600 USDC. Every projection preserves these original invoice faces.",
            },
            {
              title: "Compare a single settlement branch",
              detail:
                selection.clearing === "debt_only"
                  ? "The current circulation algorithm cancels only conserved cycles, preserving every company's net position. This hypothetical debt setoff does not move tokens."
                  : selection.clearing === "cash_backed"
                    ? "The current funded-clearing net-position helper computes 600 USDC of debtor backing and 600 USDC of creditor rights. Only after real consent, exact funding and verified finalization could invoices retire into these separate rights."
                    : "This alternative assumes each invoice was individually paid in full. The liability helper subtracts the supplied delivery assumption. Actual token delivery and fees have not been observed.",
            },
            {
              title: "Keep rights separate from received money",
              detail:
                "A hypothetical escrow right is not token delivery or shared company cash. An unresolved withdrawal retains its original nonce until its exact callback or recovery evidence is resolved.",
            },
            {
              title: "Inspect the evidence boundary",
              detail:
                "This public preview creates no rounds, approvals, deposits or transfers. Real source code, contract state, final receipts and hardware reports require separate verification.",
            },
          ],
    evidence: [
      {
        claim: "Final source execution",
        status: "unavailable" as const,
        detail:
          "No real signed transaction or finalized execution receipt is supplied.",
      },
      {
        claim: "Actual token delivery",
        status: "unavailable" as const,
        detail:
          "Every delivery number shown is a hypothetical input. No destination receipt or successful transfer is fabricated.",
      },
      {
        claim: "Escrow backing and withdrawal",
        status: "unavailable" as const,
        detail:
          "Net deposit and rights are calculated requirements, not observed funded balances or withdrawable money.",
      },
      {
        claim: "Private inference and hardware identity",
        status: "unavailable" as const,
        detail:
          "No inference was requested. There is no model signature, Intel/NVIDIA report or hardware success claim.",
      },
      {
        claim: "Actual wallet gas and route fees",
        status: "unavailable" as const,
        detail:
          "No chain or provider quote was requested and no charge was incurred.",
      },
    ],
    limitations: [
      "All company, person and invoice examples are purpose-made fiction, independent of customer or research data.",
      "Read-only calculations reuse the current product helpers. They do not create payable records, register clearing rounds, sign transactions, invoke workers or contact an external service.",
      "USDC is the obligation unit. Other symbols are fictional recipient preferences; supported assets and conversions require a current NEAR Intents catalog and quote.",
      "A debt-only projection, a cash-backed projection and a token-delivery projection are alternative paths through the same invoice book. Their reductions cannot be added together.",
    ],
  };
}
export type PublicDemoScenario = ReturnType<typeof getPublicDemoScenario>;

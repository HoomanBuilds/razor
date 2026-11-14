import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../context";
import { getDb, row, rows } from "../db";
import {
  capabilityPolicyInput,
  costObservationInput,
  OPTIONAL_CAPABILITIES,
  type CapabilityPolicy,
  type CostObservationInput,
} from "./capability-model";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function requireCommercialOperator(userId: string) {
  const allowed = (process.env.RAZOR_BILLING_OPERATOR_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !allowed.includes(userId) ||
    !row("SELECT id FROM users WHERE id=?", userId)
  )
    throw new ApiError(
      403,
      "Use an existing explicitly allowlisted billing operator",
      "BILLING_OPERATOR_REQUIRED",
    );
}
export function recordServiceCostObservation(userId: string, input: unknown) {
  requireCommercialOperator(userId);
  const terms = costObservationInput.parse(input),
    id = randomUUID(),
    at = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO billing_service_cost_observations(id,capability,terms_json,reviewed_by,reviewed_at) VALUES(?,?,?,?,?)",
    )
    .run(id, terms.capability, JSON.stringify(terms), userId, at);
  return {
    id,
    ...terms,
    reviewedBy: userId,
    reviewedAt: at,
    independentlyVerified: false,
  };
}
export function listServiceCostObservations(userId: string, page = 1) {
  requireCommercialOperator(userId);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
    throw new ApiError(
      422,
      "Choose a valid cost observation page",
      "BILLING_PAGE_INVALID",
    );
  return {
    page,
    observations: rows<{
      id: string;
      terms_json: string;
      reviewed_by: string;
      reviewed_at: string;
    }>(
      "SELECT * FROM billing_service_cost_observations ORDER BY reviewed_at DESC,id DESC LIMIT 50 OFFSET ?",
      (page - 1) * 50,
    ).map((value) => ({
      id: value.id,
      ...(JSON.parse(value.terms_json) as CostObservationInput),
      reviewedBy: value.reviewed_by,
      reviewedAt: value.reviewed_at,
      independentlyVerified: false,
    })),
  };
}
export function prepareCapabilityPolicy(
  input: unknown,
  monthlyAmount: string,
): CapabilityPolicy {
  const policy = capabilityPolicyInput.parse(input);
  if (policy.mode === "pilot")
    return {
      mode: "pilot",
      limits: policy.limits,
      notice: policy.notice,
      termsHash: null,
      calibrated: false,
    };
  let budget = 0n;
  const limits = {} as CapabilityPolicy["limits"],
    allocations = {} as NonNullable<CapabilityPolicy["allocations"]>;
  for (const capability of OPTIONAL_CAPABILITIES) {
    const allocation = policy.allocations[capability],
      observation = row<{ capability: string; terms_json: string }>(
        "SELECT capability,terms_json FROM billing_service_cost_observations WHERE id=?",
        allocation.observationId,
      );
    if (!observation || observation.capability !== capability)
      throw new ApiError(
        422,
        "Choose a reviewed service-cost observation for each exact optional capability",
        "BILLING_COST_OBSERVATION_REQUIRED",
      );
    const terms = JSON.parse(observation.terms_json) as CostObservationInput;
    const numerator =
        BigInt(terms.costAtomic) *
        BigInt(terms.valuation?.usdcAtomicNumerator ?? "1"),
      denominator =
        BigInt(terms.sampleCount) *
        BigInt(terms.valuation?.costAtomicDenominator ?? "1");
    const capacity =
      (BigInt(allocation.budgetAtomicUSDC) * denominator) / numerator;
    if (capacity > 1000000n)
      throw new ApiError(
        422,
        "Derived capacity exceeds the supported one-million creation publication bound; lower its allocated budget",
        "BILLING_CAPACITY_PUBLICATION_BOUND",
      );
    budget += BigInt(allocation.budgetAtomicUSDC);
    limits[capability] = Number(capacity);
    allocations[capability] = {
      observationId: allocation.observationId,
      budgetAtomicUSDC: allocation.budgetAtomicUSDC,
      sampleCount: terms.sampleCount,
      periodStart: terms.periodStart,
      periodEnd: terms.periodEnd,
      unitCostNumerator: numerator.toString(),
      unitCostDenominator: denominator.toString(),
    };
  }
  if (budget > BigInt(monthlyAmount) + BigInt(policy.subsidyBudgetAtomicUSDC))
    throw new ApiError(
      422,
      "Allocated optional-feature budgets exceed this plan price plus its explicitly reviewed operator subsidy",
      "BILLING_CAPABILITY_BUDGET_INVALID",
    );
  return {
    mode: "calibrated",
    limits,
    allocations,
    subsidyBudgetAtomicUSDC: policy.subsidyBudgetAtomicUSDC,
    notice: policy.notice,
    termsHash: null,
    calibrated: true,
  };
}
export function attachCapabilityPolicy(
  planId: string,
  policy: CapabilityPolicy,
  actorId: string,
) {
  requireCommercialOperator(actorId);
  const terms = JSON.stringify({ ...policy, termsHash: undefined }),
    termsHash = hash(terms);
  getDb()
    .prepare(
      "INSERT INTO billing_capability_policies(plan_version_id,mode,terms_json,terms_hash,published_by,published_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      planId,
      policy.mode,
      terms,
      termsHash,
      actorId,
      new Date().toISOString(),
    );
}
export function getCapabilityPolicy(planId: string): CapabilityPolicy {
  const stored = row<{ terms_json: string; terms_hash: string }>(
    "SELECT terms_json,terms_hash FROM billing_capability_policies WHERE plan_version_id=?",
    planId,
  );
  if (stored)
    return {
      ...(JSON.parse(stored.terms_json) as CapabilityPolicy),
      termsHash: stored.terms_hash,
    };
  if (
    !row(
      "SELECT plan_version_id FROM billing_legacy_capability_plans WHERE plan_version_id=?",
      planId,
    )
  )
    throw new ApiError(
      503,
      "This offer has no published optional-capability policy",
      "BILLING_CAPABILITY_POLICY_REQUIRED",
    );
  return {
    mode: "legacy",
    limits: Object.fromEntries(
      OPTIONAL_CAPABILITIES.map((key) => [key, null]),
    ) as CapabilityPolicy["limits"],
    notice:
      "This existing plan version has no additional commercial creation quota. Independent product safety limits and operating eligibility still apply.",
    termsHash: null,
    calibrated: false,
  };
}

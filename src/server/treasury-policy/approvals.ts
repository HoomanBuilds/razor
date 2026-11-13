import { ApiError } from "../context";
import type { ApprovalStatus, ApprovalTier } from "../payments/types";
import { atomic } from "../../lib/money";

export function validateApprovalTiers(tiers: ApprovalTier[], dailyLimit: string, eligibleCount: number): void {
  if (!tiers.length || tiers.length > 8) throw new ApiError(422, "Choose between one and eight approval tiers", "INVALID_APPROVAL_TIERS");
  let previous = 0n, required = 1;
  for (const tier of tiers) {
    const cap = atomic(tier.up_to);
    if (cap <= previous || !Number.isInteger(tier.required_approvals) || tier.required_approvals < required || tier.required_approvals > 8 || tier.required_approvals > eligibleCount) throw new ApiError(422, "Tier caps must increase, approval counts cannot decrease, and every tier needs enough distinct authorized wallets", "INVALID_APPROVAL_TIERS");
    previous = cap; required = tier.required_approvals;
  }
  if (previous < atomic(dailyLimit)) throw new ApiError(422, "The last approval tier must cover the daily source limit", "INVALID_APPROVAL_TIERS");
}

export function requiredApprovals(tiers: ApprovalTier[], principal: string, maxFee: string): number {
  const total = atomic(principal) + atomic(maxFee, true);
  const tier = tiers.find((item) => total <= atomic(item.up_to));
  if (!tier) throw new ApiError(409, "The approved cost is outside the configured approval tiers", "APPROVAL_POLICY_INCOMPLETE");
  return tier.required_approvals;
}

export function checkedApprovalStatus(value: ApprovalStatus, paymentId: string, attemptId: string): ApprovalStatus {
  if (!value || !/^\d+$/.test(value.policy_version) || !/^[a-f0-9]{64}$/.test(value.payment_terms_hash) || !/^[a-f0-9]{64}$/.test(value.attempt_terms_hash ?? "") || value.attempt_id !== attemptId
    || !Number.isInteger(value.required_approvals) || value.required_approvals < 1 || value.required_approvals > 8
    || typeof value.payment_ready !== "boolean" || typeof value.attempt_ready !== "boolean" || typeof value.can_execute !== "boolean"
    || !Array.isArray(value.payment_approvals) || !Array.isArray(value.attempt_approvals)
    || new Set(value.payment_approvals).size !== value.payment_collected || new Set(value.attempt_approvals).size !== value.attempt_collected
    || value.payment_collected > 17 || value.attempt_collected > value.payment_collected
    || value.attempt_approvals.some((account) => !value.payment_approvals.includes(account))
    || value.payment_ready !== (value.payment_collected >= value.required_approvals)
    || value.attempt_ready && value.attempt_collected < value.required_approvals
    || value.can_execute && (!value.payment_ready || !value.attempt_ready)) throw new ApiError(409, `The treasury approval view is unavailable or incompatible for payment ${paymentId}. Use the reviewed treasury version`, "APPROVAL_VIEW_INVALID");
  return value;
}

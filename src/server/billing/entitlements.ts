import { optionalCapabilityStatus } from "./capabilities";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { row } from "../db";
import { getSubscriptionState } from "./subscriptions";
import { financeSeatUsage, usageForPeriod } from "./usage";
import type { BillingEntitlements, BillingFeature } from "./types";

export function getEntitlements(access: AccessContext): BillingEntitlements {
  requirePermission(access, "company:read");
  const state = getSubscriptionState(access.organizationId);
  const canManage = access.permissions.includes("company:manage") && !!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId);
  return { optionalCapabilities: optionalCapabilityStatus(access), mode: state.mode, pilot: state.pilot, canManage, plan: state.plan, status: state.status, period: state.period, features: state.plan.features, limits: state.plan.limits, usage: { ...usageForPeriod(access.organizationId, state.period.usageKey), financeSeats: financeSeatUsage(access.organizationId) }, paidThrough: state.paidThrough, cancelAtPeriodEnd: state.cancelAtPeriodEnd, scheduledPlan: state.scheduledPlan };
}

export function assertFeature(access: AccessContext, feature: BillingFeature): void {
  requirePermission(access, "company:read");
  const state = getSubscriptionState(access.organizationId);
  if (!state.plan.features[feature]) throw new ApiError(402, "This new operation requires an eligible company plan. Ask the company owner to review Plans & billing. Existing payments, records and recovery stay available.", "BILLING_FEATURE_REQUIRED");
}

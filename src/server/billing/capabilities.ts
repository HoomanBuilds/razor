import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { row, transaction } from "../db";
import { getAccess } from "../identity/session";
import {
  OPTIONAL_CAPABILITIES,
  type OptionalCapability,
} from "./capability-model";
import { getCapabilityPolicy } from "./capability-policy";
export { getCapabilityPolicy } from "./capability-policy";
import { getSubscriptionState } from "./subscriptions";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const permissions: Record<OptionalCapability, string> = {
  private_tender: "payments:prepare",
  financing_request: "company:manage",
  claim_pool: "payments:prepare",
  procurement_rfq: "payments:prepare",
  accounting_plan: "company:manage",
  integration_credential: "company:manage",
};
export function optionalCapabilityStatus(access: AccessContext) {
  const live = getAccess(access.userId, access.organizationId);
  requirePermission(live, "company:read");
  const state = getSubscriptionState(live.organizationId),
    policy = getCapabilityPolicy(state.plan.id);
  const usage = Object.fromEntries(
    OPTIONAL_CAPABILITIES.map((capability) => [
      capability,
      row<{ count: number }>(
        "SELECT COUNT(*) count FROM billing_optional_creation_usage WHERE organization_id=? AND usage_key=? AND capability=?",
        live.organizationId,
        state.period.usageKey,
        capability,
      )!.count,
    ]),
  ) as Record<OptionalCapability, number>;
  return {
    planVersionId: state.plan.id,
    period: state.period,
    policy,
    usage,
    chargeOnUse: false,
    automaticUpgrade: false,
    safetyLimitsSeparate: true,
    notice:
      "Limits apply only to new optional resources. Ownership, existing payments and wages, approvals, exports, key rotation and revocation, reconciliation and fund recovery are never gated by these creation quotas.",
  };
}
export function reserveOptionalCreation(
  access: AccessContext,
  capability: OptionalCapability,
  stableResourceId: string,
) {
  if (
    !OPTIONAL_CAPABILITIES.includes(capability) ||
    typeof stableResourceId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,256}$/.test(stableResourceId)
  )
    throw new ApiError(
      422,
      "Use a fixed supported capability and stable new-resource identity",
      "BILLING_OPTIONAL_ID_INVALID",
    );
  return transaction((db) => {
    const live = getAccess(access.userId, access.organizationId);
    requirePermission(live, "company:read");
    requirePermission(live, permissions[capability]);
    const resourceHash = hash(stableResourceId),
      previous = row<{
        id: string;
        usage_key: string;
        plan_version_id: string;
      }>(
        "SELECT id,usage_key,plan_version_id FROM billing_optional_creation_usage WHERE organization_id=? AND capability=? AND resource_hash=?",
        live.organizationId,
        capability,
        resourceHash,
      );
    if (previous)
      return {
        id: previous.id,
        reused: true,
        usageKey: previous.usage_key,
        planVersionId: previous.plan_version_id,
      };
    const state = getSubscriptionState(live.organizationId),
      policy = getCapabilityPolicy(state.plan.id),
      cap = policy.limits[capability];
    const used = row<{ count: number }>(
      "SELECT COUNT(*) count FROM billing_optional_creation_usage WHERE organization_id=? AND usage_key=? AND capability=?",
      live.organizationId,
      state.period.usageKey,
      capability,
    )!.count;
    if (cap !== null && used >= cap)
      throw new ApiError(
        402,
        "This published plan's optional creation allowance is used or unavailable. Ask the owner to review Plans & billing. No charge or automatic upgrade occurred; existing work and recovery remain available.",
        "BILLING_OPTIONAL_CAPACITY",
      );
    const id = randomUUID();
    db.prepare(
      "INSERT INTO billing_optional_creation_usage(id,organization_id,capability,resource_hash,usage_key,plan_version_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      id,
      live.organizationId,
      capability,
      resourceHash,
      state.period.usageKey,
      state.plan.id,
      live.userId,
      new Date().toISOString(),
    );
    return {
      id,
      reused: false,
      usageKey: state.period.usageKey,
      planVersionId: state.plan.id,
    };
  });
}

export type OptionalCapabilityStatus = ReturnType<
  typeof optionalCapabilityStatus
>;

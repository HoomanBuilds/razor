import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, transaction } from "../db";
import { getSubscriptionState } from "./subscriptions";

export function usageForPeriod(organizationId: string, usageKey: string) {
  const value = row<{ attempts: number; completed: number; failed: number }>("SELECT COUNT(*) AS attempts,COALESCE(SUM(status='completed'),0) AS completed,COALESCE(SUM(status='failed'),0) AS failed FROM billing_usage WHERE organization_id=? AND usage_key=?", organizationId, usageKey)!;
  return { aiAttempts: value.attempts, aiCompleted: value.completed, aiFailed: value.failed };
}

export function financeSeatUsage(organizationId: string, excludeInvitationId?: string) {
  const at = new Date().toISOString();
  const active = row<{ count: number }>("SELECT COUNT(*) AS count FROM memberships m JOIN organization_roles r ON r.id=m.role_id AND r.organization_id=m.organization_id WHERE m.organization_id=? AND m.status='active' AND r.archived_at IS NULL", organizationId)!.count;
  const pending = row<{ count: number }>("SELECT COUNT(*) AS count FROM organization_invitations i JOIN organization_roles r ON r.id=i.role_id AND r.organization_id=i.organization_id WHERE i.organization_id=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>? AND r.archived_at IS NULL AND (? IS NULL OR i.id!=?)", organizationId, at, excludeInvitationId ?? null, excludeInvitationId ?? null)!.count;
  return active + pending;
}

export function reserveAiUsage(access: AccessContext, requestKey: string = randomUUID()) {
  requirePermission(access, "company:read");
  requirePermission(access, "documents:manage");
  if (typeof requestKey !== "string" || !requestKey || requestKey.length > 512) throw new ApiError(422, "Use a bounded analysis request identity", "AI_REQUEST_ID_INVALID");
  return transaction(db => {
    const key = createHash("sha256").update(requestKey).digest("hex");
    if (row("SELECT id FROM billing_usage WHERE organization_id=? AND request_key=?", access.organizationId, key)) throw new ApiError(409, "This analysis request was already recorded. Inspect its result before starting a new attempt.", "AI_REQUEST_ALREADY_RECORDED");
    const state = getSubscriptionState(access.organizationId);
    if (!state.plan.features.private_ai) throw new ApiError(402, "Private AI requires an eligible company plan. Ask the company owner to review Plans & billing.", "BILLING_FEATURE_REQUIRED");
    const usage = usageForPeriod(access.organizationId, state.period.usageKey);
    if (usage.aiAttempts >= state.plan.limits.aiAttempts) throw new ApiError(402, "This company's private-AI attempt allowance is used. The owner can review the plan or wait for the next usage period.", "BILLING_AI_LIMIT");
    const id = randomUUID();
    db.prepare("INSERT INTO billing_usage(id,organization_id,usage_key,request_key,status,created_by,created_at) VALUES(?,?,?,?,'reserved',?,?)").run(id, access.organizationId, state.period.usageKey, key, access.userId, new Date().toISOString());
    return { id, reused: false, status: "reserved" as const };
  });
}

export function completeAiUsage(id: string, outcome: "completed" | "failed") {
  if (outcome !== "completed" && outcome !== "failed") throw new ApiError(422, "Use a final analysis outcome", "AI_USAGE_OUTCOME_INVALID");
  getDb().prepare("UPDATE billing_usage SET status=?,completed_at=? WHERE id=? AND status='reserved'").run(outcome, new Date().toISOString(), id);
}

export function assertSeatCapacity(access: AccessContext, options: { additional?: number; excludeInvitationId?: string; existingUserId?: string } = {}) {
  requirePermission(access, "company:read");
  if (options.existingUserId && row("SELECT user_id FROM memberships WHERE organization_id=? AND user_id=? AND status='active'", access.organizationId, options.existingUserId)) return;
  const additional = options.additional ?? 1;
  if (!Number.isSafeInteger(additional) || additional < 0 || additional > 10000) throw new ApiError(422, "Use a valid additional finance-seat count", "BILLING_SEAT_COUNT_INVALID");
  const state = getSubscriptionState(access.organizationId);
  if (financeSeatUsage(access.organizationId, options.excludeInvitationId) + additional > state.plan.limits.financeSeats) throw new ApiError(402, "This company's finance-seat allowance is full. Existing members keep access; the owner can review Plans & billing before adding another member.", "BILLING_SEAT_LIMIT");
}

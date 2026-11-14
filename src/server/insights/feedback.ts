import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { audit, getAccess } from "../identity/session";
import { insightWindow } from "./model";

export const feedbackInput = z.object({
  workflow: z.enum(["onboarding", "funding", "payroll", "invoices", "receiving", "treasury", "accounting", "other"]),
  category: z.enum(["confusing", "too_many_steps", "cost_unclear", "slow", "unavailable", "recovery"]),
  severity: z.enum(["minor", "difficult", "blocked"]),
  idempotencyKey: z.uuid(),
}).strict();
interface Feedback { id: string; workflow: string; category: string; severity: string; status: string; created_at: string; updated_at: string }
function liveAccess(access: AccessContext) { const live = getAccess(access.userId, access.organizationId); requirePermission(live, "company:read"); return live; }
function expire() { getDb().prepare("DELETE FROM workflow_feedback WHERE created_at<?").run(new Date(Date.now() - 90 * 86400000).toISOString()); }
export function ownFeedback(access: AccessContext) {
  return transaction(() => { const live = liveAccess(access); expire(); return { items: rows<Feedback>("SELECT id,workflow,category,severity,status,created_at,updated_at FROM workflow_feedback WHERE organization_id=? AND user_id=? ORDER BY created_at DESC,id DESC LIMIT 20", live.organizationId, live.userId), retentionDays: 90 }; });
}
export function submitFeedback(access: AccessContext, data: unknown) {
  const input = feedbackInput.parse(data);
  return transaction(db => {
    const live = liveAccess(access); expire();
    const prior = row<Feedback>("SELECT id,workflow,category,severity,status,created_at,updated_at FROM workflow_feedback WHERE organization_id=? AND user_id=? AND idempotency_key=?", live.organizationId, live.userId, input.idempotencyKey);
    if (prior) {
      if (prior.workflow !== input.workflow || prior.category !== input.category || prior.severity !== input.severity) throw new ApiError(409, "This feedback submission identity already has different answers", "FEEDBACK_REPLAY_CONFLICT");
      return { item: prior, replayed: true };
    }
    const recent = row<{ count: number }>("SELECT COUNT(*) AS count FROM workflow_feedback WHERE organization_id=? AND user_id=? AND created_at>=?", live.organizationId, live.userId, new Date(Date.now() - 86400000).toISOString())!;
    if (recent.count >= 20) throw new ApiError(429, "You can submit up to 20 workflow reports per company per day", "FEEDBACK_LIMIT");
    const id = randomUUID(), at = new Date().toISOString();
    db.prepare("INSERT INTO workflow_feedback(id,organization_id,user_id,workflow,category,severity,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, live.organizationId, live.userId, input.workflow, input.category, input.severity, input.idempotencyKey, at, at);
    audit(live.userId, live.organizationId, "workflow_feedback.created", id);
    return { item: row<Feedback>("SELECT id,workflow,category,severity,status,created_at,updated_at FROM workflow_feedback WHERE id=?", id)!, replayed: false };
  });
}
export function manageFeedback(access: AccessContext, id: string, action: "resolve" | "delete") {
  return transaction(db => {
    const live = liveAccess(access); expire();
    const found = row<Feedback>("SELECT id,workflow,category,severity,status,created_at,updated_at FROM workflow_feedback WHERE id=? AND organization_id=? AND user_id=?", id, live.organizationId, live.userId);
    if (!found) throw new ApiError(404, "Workflow report not found", "FEEDBACK_NOT_FOUND");
    if (action === "delete") db.prepare("DELETE FROM workflow_feedback WHERE id=? AND organization_id=? AND user_id=?").run(id, live.organizationId, live.userId);
    else db.prepare("UPDATE workflow_feedback SET status='resolved',updated_at=? WHERE id=? AND organization_id=? AND user_id=?").run(new Date().toISOString(), id, live.organizationId, live.userId);
    audit(live.userId, live.organizationId, `workflow_feedback.${action}`, id);
    return { id, status: action === "delete" ? "deleted" : "resolved" };
  });
}
export function feedbackSummary(access: AccessContext, data: unknown = {}) {
  const window = insightWindow(data);
  return transaction(() => {
    const live = liveAccess(access); requirePermission(live, "reports:read"); expire();
    return { window, groups: rows<{ workflow: string; category: string; severity: string; status: string; count: number }>("SELECT workflow,category,severity,status,COUNT(*) AS count FROM workflow_feedback WHERE organization_id=? AND created_at>=? AND created_at<? GROUP BY workflow,category,severity,status ORDER BY workflow,category,severity,status", live.organizationId, window.start, window.endExclusive), notice: "Voluntary user-reported friction, not independently diagnosed failures or staffed support requests. Aggregates contain no author identities, documents, salaries or wallet addresses. Reports expire after 90 days and can be deleted by their authors." };
  });
}

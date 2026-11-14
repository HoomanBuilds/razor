import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomic } from "../../lib/money";
import { ApiError } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { capabilityPolicyInput } from "./capability-model";
import { attachCapabilityPolicy, getCapabilityPolicy, prepareCapabilityPolicy, requireCommercialOperator } from "./capability-policy";
import { BILLING_FEATURES, type BillingPlan, type PlanCode } from "./types";

interface PlanRow { id: string; code: PlanCode; version: number; name: string; currency: "USDC"; monthly_amount: string; features_json: string; limits_json: string; available: number; created_at: string }
const featureShape = { batch_payroll: z.boolean(), recurring: z.boolean(), private_ai: z.boolean(), clearing: z.boolean() };
const publication = z.object({ code: z.enum(["free", "pro", "business"]), name: z.string().trim().min(1).max(80), monthlyAmount: z.string().refine(value => { try { return atomic(value, true) <= 1_000_000_000_000n; } catch { return false; } }, "Use at most one million USDC in integer base units"), features: z.object(featureShape).strict(), capabilityPolicy: capabilityPolicyInput, limits: z.object({ financeSeats: z.number().int().min(1).max(10000), aiAttempts: z.number().int().min(0).max(1000000) }).strict() }).strict().refine(value => value.code === "free" ? value.monthlyAmount === "0" : value.monthlyAmount !== "0", { message: "Free must cost zero and paid plans must have a positive amount" }).refine(value => !value.features.private_ai || value.limits.aiAttempts > 0, { message: "Private AI requires a bounded positive attempt allowance" });
export type PublishPlanInput = z.infer<typeof publication>;

export function validatePlanPublication(input: unknown): PublishPlanInput {
  return publication.parse(input);
}

function project(value: PlanRow): BillingPlan {
  return { id: value.id, code: value.code, version: value.version, name: value.name, currency: value.currency, monthlyAmount: value.monthly_amount, features: JSON.parse(value.features_json), limits: JSON.parse(value.limits_json), available: value.available === 1, capabilityPolicy: getCapabilityPolicy(value.id), createdAt: value.created_at };
}

export function getPlanVersion(id: string): BillingPlan {
  const value = row<PlanRow>("SELECT * FROM billing_plan_versions WHERE id=?", id);
  if (!value) throw new ApiError(404, "Plan version not found", "BILLING_PLAN_NOT_FOUND");
  return project(value);
}

export function listPublishedPlans(): BillingPlan[] {
  return rows<PlanRow>("SELECT * FROM billing_plan_versions p WHERE available=1 AND version=(SELECT MAX(version) FROM billing_plan_versions n WHERE n.code=p.code AND n.available=1) ORDER BY CASE code WHEN 'free' THEN 0 WHEN 'pro' THEN 1 ELSE 2 END").map(project);
}

export function listPlanVersions(): BillingPlan[] {
  return rows<PlanRow>("SELECT * FROM billing_plan_versions ORDER BY code,version DESC").map(project);
}

export function latestPlan(code: PlanCode): BillingPlan {
  const plan = listPublishedPlans().find(value => value.code === code);
  if (!plan) throw new ApiError(503, `No published ${code} plan is available`, "BILLING_CATALOG_UNAVAILABLE");
  return plan;
}

export function billingEvent(organizationId: string | null, actorId: string | null, action: string, entityId: string | null, details: Record<string, unknown> = {}) {
  getDb().prepare("INSERT INTO billing_core_events(id,organization_id,actor_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), organizationId, actorId, action, entityId, JSON.stringify(details), new Date().toISOString());
}

export function publishPlanVersion(input: unknown, actorId = "local_operator"): BillingPlan {
  const parsed = validatePlanPublication(input);
  requireCommercialOperator(actorId);
  return transaction(db => {
    const policy = prepareCapabilityPolicy(parsed.capabilityPolicy, parsed.monthlyAmount);
    const version = (row<{ version: number }>("SELECT MAX(version) AS version FROM billing_plan_versions WHERE code=?", parsed.code)?.version ?? 0) + 1;
    const id = `${parsed.code}-${version}`, at = new Date().toISOString();
    db.prepare("INSERT INTO billing_plan_versions(id,code,version,name,monthly_amount,features_json,limits_json,created_at,available) VALUES(?,?,?,?,?,?,?,?,0)").run(id, parsed.code, version, parsed.name, parsed.monthlyAmount, JSON.stringify(Object.fromEntries(BILLING_FEATURES.map(key => [key, parsed.features[key]]))), JSON.stringify(parsed.limits), at);
    attachCapabilityPolicy(id, policy, actorId);
    db.prepare("UPDATE billing_plan_versions SET available=1 WHERE id=?").run(id);
    billingEvent(null, actorId, "catalog.published", id, { code: parsed.code, version });
    return getPlanVersion(id);
  });
}

export function retirePlanVersion(id: string, actorId = "local_operator"): BillingPlan {
  return transaction(db => {
    const plan = getPlanVersion(id);
    if (plan.available && !rows("SELECT id FROM billing_plan_versions WHERE code=? AND id!=? AND available=1", plan.code, id).length) throw new ApiError(409, "Publish a replacement before retiring this plan's last available version", "BILLING_LAST_PLAN_VERSION");
    db.prepare("UPDATE billing_plan_versions SET available=0 WHERE id=?").run(id);
    billingEvent(null, actorId, "catalog.retired", id);
    return getPlanVersion(id);
  });
}

export const BILLING_FEATURES = ["batch_payroll", "recurring", "private_ai", "clearing"] as const;
export type BillingFeature = typeof BILLING_FEATURES[number];
export type PlanCode = "free" | "pro" | "business";
export interface BillingLimits { financeSeats: number; aiAttempts: number }
export interface BillingPlan {
  id: string;
  code: PlanCode;
  version: number;
  name: string;
  currency: "USDC";
  monthlyAmount: string;
  features: Record<BillingFeature, boolean>;
  limits: BillingLimits;
  available: boolean;
  createdAt: string;
}
export interface BillingPeriod {
  id: string;
  organizationId: string;
  planVersionId: string;
  startsAt: string;
  endsAt: string;
  usageKey: string;
  anchorDay: number;
  sourceInvoiceId: string;
  replacesPeriodId: string | null;
}
export interface PurchaseTerms {
  version: 1;
  organizationId: string;
  planVersionId: string;
  kind: "start" | "renew" | "upgrade" | "downgrade";
  expectedRevision: number;
  currentPeriodId: string | null;
  quotedAt: string;
  amount: string;
  monthlyAmount: string;
  startsAt: string | null;
  endsAt: string | null;
  anchorDay: number;
}
export interface SubscriptionState {
  organizationId: string;
  revision: number;
  mode: "pilot" | "enforced";
  pilot: boolean;
  status: "pilot" | "free" | "active" | "canceling";
  plan: BillingPlan;
  currentPeriod: BillingPeriod | null;
  nextPeriod: BillingPeriod | null;
  period: { id: string; startsAt: string; endsAt: string; usageKey: string };
  paidThrough: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: BillingPlan | null;
}
export type BillingPlanVersion = BillingPlan;
export interface BillingEntitlements {
  mode: "pilot" | "enforced";
  pilot: boolean;
  canManage: boolean;
  plan: BillingPlan;
  status: SubscriptionState["status"];
  period: SubscriptionState["period"];
  features: BillingPlan["features"];
  limits: BillingLimits;
  usage: { aiAttempts: number; aiCompleted: number; aiFailed: number; financeSeats: number };
  paidThrough: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: BillingPlan | null;
}

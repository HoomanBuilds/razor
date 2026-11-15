export interface OperationJob {
  id: string; organization_id: string; job_key: string; kind: string; entity_id: string;
  status: string; run_at: string; attempts: number; failures: number; lease_owner: string | null;
  lease_expires_at: string | null; last_error: string | null; result: string | null;
  payload: string; created_at: string; updated_at: string;
}
export interface RecurringRule {
  id: string; organization_id: string; kind: "bill" | "payroll"; entity_id: string;
  interval_days: number; next_run_at: string; enabled: number; created_by: string;
  cadence: "days" | "months"; interval_months: number; anchor_day: number | null; month_end: number;
  initial_run_at: string | null;
  max_amount: string | null; status: string; last_result: string | null; last_run_at: string | null;
  snapshot_ciphertext: string | null; created_at: string; updated_at: string | null;
}
export type RecurringRuleView = Omit<RecurringRule, "snapshot_ciphertext">;
export interface Notice {
  id: string; title: string; body: string; entity_id: string | null; read_at: string | null;
  required_permission: string; created_at: string;
  payment?: { reference: string; recipientName: string; amount: string } | null;
}
export interface AgentMandate {
  organization_id: string; executor_account_id: string; max_amount: string; expires_at: string;
  enabled: number; created_by: string; updated_at: string;
}
export interface TemplatePayment {
  recipientId: string; amount: string; maxFee: string; recipientVersion: number;
  baseAmount?: string; bonusAmount?: string; adjustmentAmount?: string; note?: string;
}
export interface TemplateSnapshot {
  fingerprint: string; total: string; payments: TemplatePayment[];
  bill?: { title: string; lineItems: unknown[]; requiresAcceptance: boolean; projectReference?: string; costCenterReference?: string };
  payroll?: { periodStart: string; periodEnd: string; scheduledFor: string | null };
}

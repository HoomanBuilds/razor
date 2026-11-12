import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { view, validNearAccount } from "../payments/near";
import { purgePrivateEvidence } from "../reconciliation/evidence";
import { purgeFinancePlans } from "../assistant/finance";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import type { AgentMandate, Notice, OperationJob, RecurringRule, RecurringRuleView, TemplatePayment, TemplateSnapshot } from "./types";

export const iso = () => new Date().toISOString();
const publicRule = ({ snapshot_ciphertext: _snapshot, ...rule }: RecurringRule): RecurringRuleView => rule;

export function money(value: string): string {
  if (!/^[1-9]\d{0,38}$/.test(value) || BigInt(value) > 10n ** 30n) throw new ApiError(422, "Enter a positive microUSDC amount", "INVALID_AMOUNT");
  return BigInt(value).toString();
}
export function manager(access: AccessContext) { requirePermission(access, "company:manage"); requirePermission(access, "payments:read"); }
export function isPaused(organizationId: string) { return !!row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", organizationId)?.paused; }
export function workerConfiguration(organizationId?: string) {
  const accountId = process.env.FLOAT_EXECUTOR_ACCOUNT_ID || null;
  const treasuryAccountId = process.env.FLOAT_EXECUTOR_TREASURY_ACCOUNT_ID || null;
  const network = process.env.FLOAT_EXECUTOR_NETWORK || null;
  const company = organizationId ? row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", organizationId) : null;
  const matches = !organizationId || !!company && company.near_account_id === treasuryAccountId && company.network === network;
  return { configured: !!(matches && accountId && treasuryAccountId && ["mainnet", "testnet"].includes(network ?? "") && process.env.FLOAT_EXECUTOR_PRIVATE_KEY), accountId: matches ? accountId : null, treasuryAccountId: matches ? treasuryAccountId : null, network: matches ? network : null };
}

export function notify(organizationId: string, key: string, title: string, body: string, entityId?: string, permission = "payments:read", userId?: string) {
  getDb().prepare("INSERT OR IGNORE INTO notices(id,organization_id,user_id,title,body,entity_id,required_permission,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), organizationId, userId ?? null, title, body, entityId ?? null, permission, key, iso());
}

export function listNotices(access: AccessContext): Notice[] {
  requirePermission(access, "company:read");
  return rows<Notice>(`SELECT n.id,n.title,n.body,n.entity_id,n.required_permission,n.created_at,
    COALESCE(r.read_at,CASE WHEN n.user_id IS NOT NULL THEN n.read_at ELSE NULL END) AS read_at
    FROM notices n LEFT JOIN notice_receipts r ON r.notice_id=n.id AND r.user_id=?
    WHERE n.organization_id=? AND (n.user_id IS NULL OR n.user_id=?) ORDER BY n.created_at DESC LIMIT 100`, access.userId, access.organizationId, access.userId)
    .filter((notice) => access.permissions.includes(notice.required_permission));
}
export function readNotice(access: AccessContext, noticeId: string) {
  const notice = listNotices(access).find((item) => item.id === noticeId);
  if (!notice) throw new ApiError(404, "Notice not found", "NOTICE_NOT_FOUND");
  getDb().prepare("INSERT INTO notice_receipts(notice_id,user_id,read_at) VALUES(?,?,?) ON CONFLICT(notice_id,user_id) DO NOTHING").run(noticeId, access.userId, iso());
  return { id: noticeId, read: true };
}

export function listJobs(access: AccessContext) {
  requirePermission(access, "payments:read");
  return rows<Omit<OperationJob, "payload" | "lease_owner">>("SELECT id,organization_id,job_key,kind,entity_id,status,run_at,attempts,failures,lease_expires_at,last_error,result,created_at,updated_at FROM operation_jobs WHERE organization_id=? ORDER BY updated_at DESC LIMIT 100", access.organizationId);
}
export function retryJob(access: AccessContext, jobId: string) {
  manager(access);
  const result = getDb().prepare("UPDATE operation_jobs SET status='queued',failures=0,run_at=?,last_error=NULL,updated_at=? WHERE id=? AND organization_id=? AND status IN ('blocked','failed')").run(iso(), iso(), jobId, access.organizationId);
  if (!result.changes) throw new ApiError(409, "Only a blocked or failed job can be retried", "JOB_NOT_RETRYABLE");
  return { id: jobId, queued: true };
}
export function listRecurring(access: AccessContext) {
  requirePermission(access, "payments:read");
  return rows<RecurringRule>("SELECT * FROM recurring_rules WHERE organization_id=? ORDER BY created_at DESC LIMIT 100", access.organizationId).map(publicRule);
}

export function captureTemplate(organizationId: string, kind: "bill" | "payroll", entityId: string): TemplateSnapshot {
  let payments: TemplatePayment[];
  let source: Record<string, unknown>;
  let bill: TemplateSnapshot["bill"], payroll: TemplateSnapshot["payroll"];
  if (kind === "bill") {
    const invoice = row<{ recipient_id: string; amount: string; max_fee: string; title: string; line_items: string; status: string; payment_id: string | null; requires_acceptance?: number }>("SELECT * FROM bills WHERE id=? AND organization_id=?", entityId, organizationId);
    if (!invoice || invoice.status !== "approved" || !invoice.payment_id) throw new ApiError(409, "Choose an approved bill as the template", "TEMPLATE_NOT_APPROVED");
    const payment = row<{ recipient_version: number; amount: string; max_fee: string; status: string; approved_at: string | null }>("SELECT recipient_version,amount,max_fee,status,approved_at FROM payments WHERE id=? AND organization_id=?", invoice.payment_id, organizationId);
    if (!payment || !payment.approved_at || ["draft", "cancelled"].includes(payment.status)) throw new ApiError(409, "The template payment is no longer approved", "TEMPLATE_CHANGED");
    if (payment.amount !== invoice.amount) throw new ApiError(409, "This bill uses partial installments. Create a dedicated approved bill for the recurring amount, or prepare each installment separately.", "PARTIAL_TEMPLATE_UNSUPPORTED");
    bill = { title: decrypt(invoice.title), lineItems: JSON.parse(decrypt(invoice.line_items)), requiresAcceptance: !!invoice.requires_acceptance };
    payments = [{ recipientId: invoice.recipient_id, amount: payment.amount, maxFee: payment.max_fee, recipientVersion: payment.recipient_version }];
    source = { ...bill, payments };
  } else {
    const run = row<{ status: string; period_start: string; period_end: string; scheduled_for: string | null }>("SELECT * FROM payroll_runs WHERE id=? AND organization_id=?", entityId, organizationId);
    if (!run || run.status !== "approved") throw new ApiError(409, "Choose an approved pay run as the template", "TEMPLATE_NOT_APPROVED");
    const items = rows<{ recipient_id: string; amount: string; max_fee: string; recipient_version: number; payment_amount: string; payment_fee: string; approved_at: string | null; payment_status: string }>(`SELECT i.recipient_id,i.amount,i.max_fee,p.recipient_version,p.amount AS payment_amount,p.max_fee AS payment_fee,p.approved_at,p.status AS payment_status FROM payroll_items i
      JOIN payments p ON p.id=i.payment_id AND p.organization_id=? WHERE i.run_id=? ORDER BY i.recipient_id`, organizationId, entityId);
    const expected = row<{ count: number }>("SELECT COUNT(*) AS count FROM payroll_items WHERE run_id=?", entityId)!.count;
    if (!items.length || items.length !== expected || items.some((item) => item.amount !== item.payment_amount || item.max_fee !== item.payment_fee || !item.approved_at || ["draft", "cancelled"].includes(item.payment_status))) throw new ApiError(409, "The template pay-run terms changed", "TEMPLATE_CHANGED");
    payments = items.map((item) => ({ recipientId: item.recipient_id, amount: item.amount, maxFee: item.max_fee, recipientVersion: item.recipient_version }));
    payroll = { periodStart: run.period_start, periodEnd: run.period_end, scheduledFor: run.scheduled_for };
    source = { ...payroll, payments };
  }
  for (const payment of payments) {
    const recipient = row<{ version: number; archived: number; preference_status: string; confirmed_at: string | null }>("SELECT version,archived,preference_status,confirmed_at FROM recipients WHERE id=? AND organization_id=?", payment.recipientId, organizationId);
    if (!recipient || recipient.version !== payment.recipientVersion || recipient.archived || recipient.preference_status !== "confirmed" || !recipient.confirmed_at) throw new ApiError(409, "A template recipient changed or needs confirmation", "TEMPLATE_RECIPIENT_CHANGED");
  }
  return { fingerprint: createHash("sha256").update(JSON.stringify(source)).digest("hex"), total: payments.reduce((sum, payment) => sum + BigInt(payment.amount), 0n).toString(), payments, ...(bill ? { bill } : { payroll }) };
}

export function createRecurring(access: AccessContext, input: { kind: "bill" | "payroll"; entityId: string; intervalDays: number; nextRunAt: string; maxAmount: string }) {
  manager(access); requirePermission(access, "payments:prepare");
  if (!Number.isInteger(input.intervalDays) || input.intervalDays < 1 || input.intervalDays > 365) throw new ApiError(422, "Choose an interval from 1 to 365 days", "INTERVAL_INVALID");
  const next = new Date(input.nextRunAt);
  if (!Number.isFinite(next.getTime())) throw new ApiError(422, "Choose a valid first occurrence", "DUE_DATE_INVALID");
  const cap = money(input.maxAmount), snapshot = captureTemplate(access.organizationId, input.kind, input.entityId);
  if (BigInt(snapshot.total) > BigInt(cap)) throw new ApiError(422, "The template exceeds the per-cycle ceiling", "TEMPLATE_LIMIT");
  return transaction(() => {
    const existing = row<RecurringRule>("SELECT * FROM recurring_rules WHERE organization_id=? AND kind=? AND entity_id=? AND enabled=1", access.organizationId, input.kind, input.entityId);
    if (existing) {
      if (existing.interval_days !== input.intervalDays || existing.max_amount !== cap || !existing.snapshot_ciphertext || JSON.parse(decrypt(existing.snapshot_ciphertext)).fingerprint !== snapshot.fingerprint) throw new ApiError(409, "Pause the existing template before changing its terms", "TEMPLATE_ALREADY_ACTIVE");
      return publicRule(existing);
    }
    const id = randomUUID(), now = iso();
    getDb().prepare("INSERT INTO recurring_rules(id,organization_id,kind,entity_id,interval_days,next_run_at,created_by,max_amount,snapshot_ciphertext,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)")
      .run(id, access.organizationId, input.kind, input.entityId, input.intervalDays, next.toISOString(), access.userId, cap, encrypt(JSON.stringify(snapshot)), now, now);
    return publicRule(row<RecurringRule>("SELECT * FROM recurring_rules WHERE id=?", id)!);
  });
}

export function setRecurring(access: AccessContext, ruleId: string, enabled: boolean) {
  manager(access);
  const rule = row<RecurringRule>("SELECT * FROM recurring_rules WHERE id=? AND organization_id=?", ruleId, access.organizationId);
  if (!rule) throw new ApiError(404, "Recurring template not found", "TEMPLATE_NOT_FOUND");
  if (enabled) {
    requirePermission(access, "payments:prepare");
    const current = captureTemplate(access.organizationId, rule.kind, rule.entity_id);
    if (!rule.snapshot_ciphertext || current.fingerprint !== JSON.parse(decrypt(rule.snapshot_ciphertext)).fingerprint) throw new ApiError(409, "Create a new template after reviewing the changed terms", "TEMPLATE_CHANGED");
    if (row("SELECT id FROM recurring_rules WHERE organization_id=? AND kind=? AND entity_id=? AND enabled=1 AND id!=?", access.organizationId, rule.kind, rule.entity_id, ruleId)) throw new ApiError(409, "Another template for this source is active", "TEMPLATE_ALREADY_ACTIVE");
  }
  getDb().prepare("UPDATE recurring_rules SET enabled=?,status=?,updated_at=? WHERE id=?").run(Number(enabled), enabled ? "active" : "paused", iso(), ruleId);
  return publicRule(row<RecurringRule>("SELECT * FROM recurring_rules WHERE id=?", ruleId)!);
}

export function getMandate(access: AccessContext) { requirePermission(access, "payments:read"); return row<AgentMandate>("SELECT * FROM agent_mandates WHERE organization_id=?", access.organizationId) ?? null; }
export function pauseMandate(access: AccessContext) {
  manager(access);
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId)) throw new ApiError(403, "The company owner manages execution mandates", "ONLY_COMPANY_OWNER");
  getDb().prepare("UPDATE agent_mandates SET enabled=0,updated_at=? WHERE organization_id=?").run(iso(), access.organizationId);
  return getMandate(access);
}
export function saveMandate(access: AccessContext, input: { enabled: boolean; maxAmount: string; expiresAt: string }) {
  manager(access);
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId)) throw new ApiError(403, "The company owner manages execution mandates", "ONLY_COMPANY_OWNER");
  const worker = workerConfiguration(), cap = money(input.maxAmount), expiry = new Date(input.expiresAt);
  if (!worker.accountId || !validNearAccount(worker.accountId)) throw new ApiError(409, "Configure a dedicated NEAR executor account first", "EXECUTOR_UNCONFIGURED");
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new ApiError(422, "Choose a future mandate expiry", "MANDATE_EXPIRED");
  getDb().prepare("INSERT INTO agent_mandates(organization_id,executor_account_id,max_amount,expires_at,enabled,created_by,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET executor_account_id=excluded.executor_account_id,max_amount=excluded.max_amount,expires_at=excluded.expires_at,enabled=excluded.enabled,created_by=excluded.created_by,updated_at=excluded.updated_at")
    .run(access.organizationId, worker.accountId, cap, expiry.toISOString(), Number(input.enabled), access.userId, iso());
  return getMandate(access);
}
export async function prepareExecutorRole(access: AccessContext, enabled: boolean): Promise<{ walletActions: WalletTransaction[] }> {
  manager(access);
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId)) throw new ApiError(403, "The company owner manages execution permissions", "ONLY_COMPANY_OWNER");
  const worker = workerConfiguration(), config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config || !worker.accountId || worker.treasuryAccountId !== config.near_account_id || worker.network !== config.network) throw new ApiError(409, "Configure the executor for this company treasury first", "EXECUTOR_UNCONFIGURED");
  const chain = await view<{ owner_id: string }>(config, "get_config");
  if (worker.accountId === chain.owner_id || !row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, chain.owner_id, config.network)) throw new ApiError(403, "Verify the treasury owner wallet and use a separate executor account", "TREASURY_OWNER_UNVERIFIED");
  return { walletActions: [{ receiverId: config.near_account_id, actions: [{ type: "FunctionCall", params: { methodName: "set_role", args: { account_id: worker.accountId, role: "executor", enabled }, gas: "50000000000000", deposit: "1" } }] }] };
}

export function purgeRetention(access: AccessContext) {
  requirePermission(access, "documents:manage");
  const result = getDb().prepare("DELETE FROM assistant_drafts WHERE organization_id=? AND expires_at<=?").run(access.organizationId, iso());
  purgePrivateEvidence(access.organizationId);
  purgeFinancePlans();
  return { purged: Number(result.changes) };
}
export function overview(access: AccessContext) {
  requirePermission(access, "payments:read");
  const notices = listNotices(access);
  return { paused: isPaused(access.organizationId), worker: workerConfiguration(access.organizationId), jobs: listJobs(access), recurring: listRecurring(access), notices, unread: notices.filter((notice) => !notice.read_at).length, mandate: getMandate(access), canManage: access.permissions.includes("company:manage"),
    templates: { bills: rows<{ id: string; reference: string; amount: string }>("SELECT id,reference,amount FROM bills WHERE organization_id=? AND status='approved' ORDER BY created_at DESC LIMIT 100", access.organizationId), payroll: rows<{ id: string; reference: string }>("SELECT id,reference FROM payroll_runs WHERE organization_id=? AND status='approved' ORDER BY created_at DESC LIMIT 100", access.organizationId) } };
}

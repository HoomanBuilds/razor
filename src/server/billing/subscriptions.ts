import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { billingEvent, getPlanVersion, latestPlan } from "./catalog";
import type { BillingPeriod, PurchaseTerms, SubscriptionState } from "./types";

type TimeInput = Date | string | number;
interface Settings { revision: number; cancel_at_period_end: number; scheduled_plan_id: string | null }
interface PeriodRow { id: string; organization_id: string; plan_version_id: string; starts_at: string; ends_at: string; usage_key: string; anchor_day: number; source_invoice_id: string; replaces_period_id: string | null }
const rank = { free: 0, pro: 1, business: 2 };

function time(value: TimeInput = new Date()) {
  const date = new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(date.getTime())) throw new ApiError(422, "Use a valid billing time", "BILLING_TIME_INVALID");
  return date.toISOString();
}

export function billingMode(): "pilot" | "enforced" {
  const mode = process.env.RAZOR_BILLING_MODE || "pilot";
  if (mode !== "pilot" && mode !== "enforced") throw new ApiError(503, "RAZOR_BILLING_MODE must be pilot or enforced", "BILLING_SETUP_REQUIRED");
  return mode;
}

export function requireBillingOwner(access: AccessContext) {
  requirePermission(access, "company:manage");
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId)) throw new ApiError(403, "Only this company's owner can manage its subscription", "BILLING_OWNER_REQUIRED");
}

function settings(organizationId: string, at: string): Settings {
  if (!row("SELECT id FROM organizations WHERE id=?", organizationId)) throw new ApiError(404, "Company not found", "BILLING_COMPANY_NOT_FOUND");
  getDb().prepare("INSERT OR IGNORE INTO billing_subscription_settings(organization_id,updated_at) VALUES(?,?)").run(organizationId, at);
  return row<Settings>("SELECT revision,cancel_at_period_end,scheduled_plan_id FROM billing_subscription_settings WHERE organization_id=?", organizationId)!;
}

function project(value: PeriodRow): BillingPeriod {
  return { id: value.id, organizationId: value.organization_id, planVersionId: value.plan_version_id, startsAt: value.starts_at, endsAt: value.ends_at, usageKey: value.usage_key, anchorDay: value.anchor_day, sourceInvoiceId: value.source_invoice_id, replacesPeriodId: value.replaces_period_id };
}

function periodsAt(organizationId: string, at: string): BillingPeriod[] {
  return rows<PeriodRow>("SELECT * FROM billing_periods WHERE organization_id=? AND ends_at>? AND (superseded_at IS NULL OR superseded_at>?) AND (revoked_at IS NULL OR revoked_at>?) ORDER BY starts_at,id", organizationId, at, at, at).map(project);
}

export function nextBillingMonth(value: TimeInput, anchorDay?: number): string {
  const date = new Date(time(value)), day = anchorDay ?? date.getUTCDate();
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new ApiError(422, "Invalid billing month anchor", "BILLING_TIME_INVALID");
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const maximum = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, maximum));
  return date.toISOString();
}

export function getSubscriptionState(organizationId: string, now: TimeInput = new Date()): SubscriptionState {
  const at = time(now), config = settings(organizationId, at), mode = billingMode(), periods = periodsAt(organizationId, at);
  const current = periods.filter(value => value.startsAt <= at).at(-1) ?? null;
  const next = periods.find(value => value.startsAt > at) ?? null;
  const pilot = !current && mode === "pilot", plan = current ? getPlanVersion(current.planVersionId) : latestPlan(pilot ? "pro" : "free");
  const date = new Date(at), startsAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(), endsAt = nextBillingMonth(startsAt, 1);
  const usageKey = `calendar:${organizationId}:${startsAt.slice(0, 7)}`;
  return {
    organizationId, revision: config.revision, mode, pilot,
    status: current ? config.cancel_at_period_end ? "canceling" : "active" : pilot ? "pilot" : "free",
    plan, currentPeriod: current, nextPeriod: next,
    period: current ? { id: current.id, startsAt: current.startsAt, endsAt: current.endsAt, usageKey: current.usageKey } : { id: usageKey, startsAt, endsAt, usageKey },
    paidThrough: periods.length ? periods.reduce((maximum, value) => maximum > value.endsAt ? maximum : value.endsAt, periods[0].endsAt) : null,
    cancelAtPeriodEnd: config.cancel_at_period_end === 1,
    scheduledPlan: config.scheduled_plan_id ? getPlanVersion(config.scheduled_plan_id) : next ? getPlanVersion(next.planVersionId) : null,
  };
}

function quote(organizationId: string, planVersionId: string, now: TimeInput, allowHistorical = false): PurchaseTerms {
  const at = time(now), state = getSubscriptionState(organizationId, at), target = getPlanVersion(planVersionId);
  if (target.code === "free" || target.monthlyAmount === "0") throw new ApiError(422, "Free needs no payment. Schedule the change at the end of paid access.", "BILLING_FREE_PLAN");
  if (!allowHistorical && (!target.available || latestPlan(target.code).id !== target.id)) throw new ApiError(409, "This offer was replaced. Review the currently published plan.", "BILLING_PLAN_OFFER_CHANGED");
  if (state.cancelAtPeriodEnd) throw new ApiError(409, "Resume the subscription before requesting another paid period", "BILLING_CANCELLATION_SCHEDULED");
  let kind: PurchaseTerms["kind"] = "start", amount = target.monthlyAmount, startsAt: string | null = null, endsAt: string | null = null;
  const current = state.currentPeriod;
  let anchorDay = current?.anchorDay ?? new Date(at).getUTCDate();
  if (current && rank[target.code] > rank[state.plan.code] && BigInt(target.monthlyAmount) > BigInt(state.plan.monthlyAmount)) {
    kind = "upgrade";
    const remaining = BigInt(Date.parse(current.endsAt) - Date.parse(at)), duration = BigInt(Date.parse(current.endsAt) - Date.parse(current.startsAt));
    const delta = BigInt(target.monthlyAmount) - BigInt(state.plan.monthlyAmount);
    amount = ((delta * remaining + duration - 1n) / duration).toString();
    endsAt = current.endsAt;
  } else if (state.paidThrough) {
    kind = current && rank[target.code] < rank[state.plan.code] ? "downgrade" : "renew";
    startsAt = state.paidThrough;
    const last = periodsAt(organizationId, at).filter(value => value.endsAt === state.paidThrough).at(-1);
    anchorDay = last?.anchorDay ?? anchorDay;
    endsAt = nextBillingMonth(startsAt, anchorDay);
  }
  return { version: 1, organizationId, planVersionId, kind, expectedRevision: state.revision, currentPeriodId: current?.id ?? null, quotedAt: at, amount, monthlyAmount: target.monthlyAmount, startsAt, endsAt, anchorDay };
}

export function quotePurchase(organizationId: string, planVersionId: string, now: TimeInput = new Date()): PurchaseTerms {
  return quote(organizationId, planVersionId, now);
}

export function applyPurchase(organizationId: string, invoiceId: string, terms: PurchaseTerms, confirmedAt: TimeInput = new Date()) {
  const at = time(confirmedAt);
  return transaction(db => {
    const existing = row<PeriodRow>("SELECT * FROM billing_periods WHERE source_invoice_id=?", invoiceId);
    if (existing) {
      if (existing.organization_id !== organizationId) throw new ApiError(409, "This invoice already belongs to another company", "BILLING_INVOICE_REUSED");
      return { status: "activated" as const, period: project(existing), alreadyApplied: true };
    }
    const stale = (reason: string) => {
      billingEvent(organizationId, null, "purchase.credit_required", invoiceId, { reason });
      return { status: "credit_required" as const, reason };
    };
    if (terms.organizationId !== organizationId || terms.version !== 1 || !invoiceId || invoiceId.length > 128) throw new ApiError(409, "Purchase terms do not match this company invoice", "BILLING_TERMS_MISMATCH");
    const config = settings(organizationId, at);
    if (config.revision !== terms.expectedRevision) return stale("The company subscription changed after checkout. Preserve the payment for refund review.");
    let expected: PurchaseTerms;
    try { expected = quote(organizationId, terms.planVersionId, terms.quotedAt, true); }
    catch { return stale("The quoted subscription period can no longer be applied."); }
    if (Object.keys(expected).some(key => expected[key as keyof PurchaseTerms] !== terms[key as keyof PurchaseTerms])) throw new ApiError(409, "The frozen purchase terms were modified", "BILLING_TERMS_MISMATCH");
    if (at < terms.quotedAt) throw new ApiError(409, "Payment confirmation precedes the invoice offer", "BILLING_TIME_INVALID");
    const startsAt = terms.startsAt ?? at, anchorDay = terms.kind === "start" ? new Date(startsAt).getUTCDate() : terms.anchorDay;
    const endsAt = terms.endsAt ?? nextBillingMonth(startsAt, anchorDay);
    if (endsAt <= at || terms.kind === "upgrade" && !periodsAt(organizationId, at).some(value => value.id === terms.currentPeriodId && value.startsAt <= at)) return stale("The original paid period ended before this purchase was confirmed.");
    const replacing = terms.kind === "upgrade" ? terms.currentPeriodId : null;
    const overlaps = periodsAt(organizationId, startsAt).filter(value => value.id !== replacing && value.startsAt < endsAt && value.endsAt > startsAt);
    if (overlaps.length) return stale("Another prepaid period already covers these dates.");
    const id = randomUUID(), replaced = replacing ? row<PeriodRow>("SELECT * FROM billing_periods WHERE id=? AND organization_id=?", replacing, organizationId) : undefined;
    const usageKey = replaced?.usage_key ?? `window:${id}`;
    if (replacing) db.prepare("UPDATE billing_periods SET superseded_at=? WHERE id=? AND organization_id=? AND superseded_at IS NULL").run(startsAt, replacing, organizationId);
    db.prepare("INSERT INTO billing_periods(id,organization_id,plan_version_id,starts_at,ends_at,usage_key,anchor_day,source_invoice_id,replaces_period_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, organizationId, terms.planVersionId, startsAt, endsAt, usageKey, anchorDay, invoiceId, replacing, at);
    db.prepare("UPDATE billing_subscription_settings SET revision=revision+1,cancel_at_period_end=0,scheduled_plan_id=NULL,updated_at=? WHERE organization_id=?").run(at, organizationId);
    billingEvent(organizationId, null, "purchase.activated", invoiceId, { kind: terms.kind, periodId: id });
    return { status: "activated" as const, period: project(row<PeriodRow>("SELECT * FROM billing_periods WHERE id=?", id)!), alreadyApplied: false };
  });
}

export function cancelSubscription(access: AccessContext, now: TimeInput = new Date()) {
  requireBillingOwner(access);
  return transaction(db => {
    const at = time(now), config = settings(access.organizationId, at);
    if (!config.cancel_at_period_end) {
      db.prepare("UPDATE billing_subscription_settings SET revision=revision+1,cancel_at_period_end=1,scheduled_plan_id=?,updated_at=? WHERE organization_id=?").run(latestPlan("free").id, at, access.organizationId);
      billingEvent(access.organizationId, access.userId, "subscription.cancel_scheduled", null);
    }
    return getSubscriptionState(access.organizationId, at);
  });
}

export function resumeSubscription(access: AccessContext, now: TimeInput = new Date()) {
  requireBillingOwner(access);
  return transaction(db => {
    const at = time(now), config = settings(access.organizationId, at);
    if (config.cancel_at_period_end || config.scheduled_plan_id) {
      db.prepare("UPDATE billing_subscription_settings SET revision=revision+1,cancel_at_period_end=0,scheduled_plan_id=NULL,updated_at=? WHERE organization_id=?").run(at, access.organizationId);
      billingEvent(access.organizationId, access.userId, "subscription.resumed", null);
    }
    return getSubscriptionState(access.organizationId, at);
  });
}

export function schedulePlanChange(access: AccessContext, planVersionId: string, now: TimeInput = new Date()) {
  requireBillingOwner(access);
  const target = getPlanVersion(planVersionId);
  if (!target.available || latestPlan(target.code).id !== target.id) throw new ApiError(409, "Review the currently published plan", "BILLING_PLAN_OFFER_CHANGED");
  if (target.code === "free") return cancelSubscription(access, now);
  return transaction(db => {
    const at = time(now), state = getSubscriptionState(access.organizationId, at);
    if (state.currentPeriod && rank[target.code] >= rank[state.plan.code]) throw new ApiError(422, "Use the exact checkout review for an upgrade or renewal", "BILLING_CHECKOUT_REQUIRED");
    db.prepare("UPDATE billing_subscription_settings SET revision=revision+1,cancel_at_period_end=0,scheduled_plan_id=?,updated_at=? WHERE organization_id=?").run(target.id, at, access.organizationId);
    billingEvent(access.organizationId, access.userId, "subscription.plan_scheduled", target.id);
    return getSubscriptionState(access.organizationId, at);
  });
}

export function revokePurchase(organizationId: string, invoiceId: string, now: TimeInput = new Date()) {
  return transaction(db => {
    const at = time(now), period = row<PeriodRow & { revoked_at: string | null }>("SELECT * FROM billing_periods WHERE organization_id=? AND source_invoice_id=?", organizationId, invoiceId);
    if (!period || period.revoked_at) return getSubscriptionState(organizationId, at);
    db.prepare("UPDATE billing_periods SET revoked_at=? WHERE id=?").run(at, period.id);
    if (period.replaces_period_id && !row("SELECT id FROM billing_periods WHERE replaces_period_id=? AND id!=? AND revoked_at IS NULL", period.replaces_period_id, period.id)) db.prepare("UPDATE billing_periods SET superseded_at=NULL WHERE id=? AND organization_id=?").run(period.replaces_period_id, organizationId);
    db.prepare("UPDATE billing_subscription_settings SET revision=revision+1,updated_at=? WHERE organization_id=?").run(at, organizationId);
    billingEvent(organizationId, null, "purchase.refunded_access_revoked", invoiceId);
    return getSubscriptionState(organizationId, at);
  });
}

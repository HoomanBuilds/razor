import { randomUUID } from "node:crypto";
import { dispatchNotifications } from "../notifications/service";
import {
  addCompanyDays,
  addCompanyMonths,
  companyMonthShift,
  shiftPeriodDate,
  companyCalendarShift,
  InvalidCompanyTime,
} from "../../lib/company-time";
import { ApiError, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { getAccess } from "../identity/session";
import { decrypt } from "../identity/crypto";
import { createBill, createPayrollRun } from "../business/service";
import { reconcileFunding, reconcilePayment } from "../payments/service";
import {
  captureTemplate,
  isPaused,
  iso,
  notify,
  purgeRetention,
} from "./service";
import type { OperationJob, RecurringRule, TemplateSnapshot } from "./types";

const LEASE_MS = 180_000;
type JobResult = {
  status: "completed" | "queued" | "blocked";
  delayMs?: number;
  detail: Record<string, unknown>;
};

function enqueue(
  organizationId: string,
  key: string,
  kind: string,
  entityId: string,
  payload: Record<string, unknown> = {},
) {
  const now = iso();
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO operation_jobs(id,organization_id,job_key,kind,entity_id,payload,run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      organizationId,
      key,
      kind,
      entityId,
      JSON.stringify(payload),
      now,
      now,
      now,
    );
}

export function enqueueOperations(organizationId?: string) {
  const now = iso();
  transaction(() => {
    for (const organization of rows<{ id: string }>(
      "SELECT id FROM organizations WHERE (? IS NULL OR id=?) ORDER BY id",
      organizationId ?? null,
      organizationId ?? null,
    )) {
      for (const rule of rows<RecurringRule>(
        "SELECT * FROM recurring_rules WHERE organization_id=? AND enabled=1 AND next_run_at<=?",
        organization.id,
        now,
      ))
        enqueue(
          organization.id,
          `recurring:${rule.id}:${rule.next_run_at}`,
          "recurring",
          rule.id,
          { dueAt: rule.next_run_at },
        );
      for (const payment of rows<{ id: string }>(
        "SELECT id FROM payments WHERE organization_id=? AND status NOT IN ('paid','cancelled') AND (scheduled_for IS NULL OR scheduled_for<=?)",
        organization.id,
        now,
      ))
        enqueue(
          organization.id,
          `due:${payment.id}`,
          "due_payment",
          payment.id,
        );
      for (const attempt of rows<{
        id: string;
        payment_id: string;
        state: string;
      }>(
        "SELECT id,payment_id,state FROM payout_attempts WHERE organization_id=? AND state IN ('prepared','submitted','processing','unknown','recovery_pending','reported_delivered')",
        organization.id,
      )) {
        enqueue(
          organization.id,
          `reconcile:${attempt.payment_id}`,
          "reconcile_payment",
          attempt.payment_id,
        );
        if (attempt.state === "prepared")
          enqueue(
            organization.id,
            `execute:${attempt.id}`,
            "execute_approved",
            attempt.id,
          );
      }
      for (const funding of rows<{ id: string }>(
        "SELECT id FROM funding_legs WHERE organization_id=? AND status NOT IN ('confirmed','refunded_verified','closed_unsent','cancelled')",
        organization.id,
      ))
        enqueue(
          organization.id,
          `funding:${funding.id}`,
          "reconcile_funding",
          funding.id,
        );
      enqueue(
        organization.id,
        `retention:${now.slice(0, 10)}`,
        "purge_assistant",
        organization.id,
      );
    }
  });
}

export function assertLease(job: OperationJob) {
  if (
    !row(
      "SELECT id FROM operation_jobs WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?",
      job.id,
      job.lease_owner,
      iso(),
    )
  )
    throw new ApiError(
      409,
      "The worker lease expired; a later worker will reconcile this job",
      "LEASE_EXPIRED",
    );
}

export function leaseOperation(
  organizationId?: string,
): OperationJob | undefined {
  return transaction(() => {
    const now = iso();
    getDb()
      .prepare(
        "UPDATE operation_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at<=? AND (? IS NULL OR organization_id=?)",
      )
      .run(now, now, organizationId ?? null, organizationId ?? null);
    const job = row<OperationJob>(
      `SELECT * FROM operation_jobs j WHERE status IN ('queued','blocked') AND run_at<=? AND (? IS NULL OR organization_id=?)
      AND (kind!='execute_approved' OR NOT EXISTS(SELECT 1 FROM operation_jobs x WHERE x.kind='execute_approved' AND x.status='running' AND x.lease_expires_at>?))
      ORDER BY CASE kind WHEN 'recurring' THEN 0 WHEN 'reconcile_payment' THEN 1 WHEN 'reconcile_funding' THEN 2 WHEN 'due_payment' THEN 3 WHEN 'execute_approved' THEN 4 ELSE 5 END,run_at,id LIMIT 1`,
      now,
      organizationId ?? null,
      organizationId ?? null,
      now,
    );
    if (!job) return undefined;
    const lease = randomUUID(),
      until = new Date(Date.now() + LEASE_MS).toISOString();
    getDb()
      .prepare(
        "UPDATE operation_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=?",
      )
      .run(lease, until, now, job.id);
    return row<OperationJob>("SELECT * FROM operation_jobs WHERE id=?", job.id);
  });
}

function ownerAccess(organizationId: string): AccessContext {
  const owner = row<{ owner_id: string }>(
    "SELECT owner_id FROM organizations WHERE id=?",
    organizationId,
  );
  if (!owner) throw new ApiError(404, "Company not found", "COMPANY_NOT_FOUND");
  return getAccess(owner.owner_id, organizationId);
}

function recurringJob(job: OperationJob): JobResult {
  return transaction(() => {
    assertLease(job);
    const rule = row<RecurringRule>(
      "SELECT * FROM recurring_rules WHERE id=? AND organization_id=?",
      job.entity_id,
      job.organization_id,
    );
    const dueAt = JSON.parse(job.payload).dueAt as string;
    const occurrence = row<{ status: string; result: string }>(
      "SELECT status,result FROM recurring_occurrences WHERE rule_id=? AND due_at=?",
      job.entity_id,
      dueAt,
    );
    if (occurrence)
      return {
        status: "completed",
        detail: {
          occurrence: occurrence.status,
          ...JSON.parse(occurrence.result),
        },
      };
    if (!rule?.enabled || rule.next_run_at !== dueAt)
      return {
        status: "completed",
        detail: { skipped: "Template is paused or its cycle already advanced" },
      };
    let current: TemplateSnapshot;
    let next: string;
    const timeZone =
      row<{ timezone: string }>(
        "SELECT timezone FROM organizations WHERE id=?",
        rule.organization_id,
      )?.timezone ?? "UTC";
    try {
      next = rule.cadence === "months" ? addCompanyMonths(dueAt, rule.interval_months, timeZone, rule.anchor_day, !!rule.month_end) : addCompanyDays(dueAt, rule.interval_days, timeZone);
      const creator = getAccess(rule.created_by, rule.organization_id);
      if (
        !["company:manage", "payments:read", "payments:prepare"].every(
          (permission) => creator.permissions.includes(permission),
        )
      )
        throw new Error("Template creator no longer has preparation access");
      current = captureTemplate(
        rule.organization_id,
        rule.kind,
        rule.entity_id,
      );
      if (
        !rule.snapshot_ciphertext ||
        !rule.max_amount ||
        current.fingerprint !==
          (JSON.parse(decrypt(rule.snapshot_ciphertext)) as TemplateSnapshot)
            .fingerprint ||
        BigInt(current.total) > BigInt(rule.max_amount)
      )
        throw new Error("Template terms changed or exceeded the cycle ceiling");
    } catch (error) {
      const message =
        error instanceof InvalidCompanyTime
          ? `${error.message} Review the template schedule.`
          : error instanceof ApiError &&
              error.code === "PARTIAL_TEMPLATE_UNSUPPORTED"
            ? error.message
            : "Template terms, company time zone, recipient preferences or creator access changed. Review and create a new template.";
      getDb()
        .prepare(
          "UPDATE recurring_rules SET enabled=0,status='held',last_result=?,updated_at=? WHERE id=?",
        )
        .run(message, iso(), rule.id);
      getDb()
        .prepare(
          "INSERT INTO recurring_occurrences(rule_id,due_at,status,result,created_at) VALUES(?,?,'held',?,?)",
        )
        .run(rule.id, dueAt, JSON.stringify({ reason: message }), iso());
      notify(
        job.organization_id,
        `template-held:${rule.id}:${dueAt}`,
        "Recurring template needs review",
        message,
        rule.id,
      );
      return { status: "completed", detail: { held: true, reason: message } };
    }
    const access = getAccess(rule.created_by, rule.organization_id);
    const reference = `repeat:${rule.id}:${dueAt.slice(0, 10)}`;
    let entityId: string;
    if (rule.kind === "bill") {
      const payment = current.payments[0];
      const created = createBill(access, {
        recipientId: payment.recipientId,
        reference,
        title: current.bill!.title,
        amount: payment.amount,
        maxFee: payment.maxFee,
        dueDate: dueAt,
        lineItems: current.bill!.lineItems,
        projectReference: current.bill!.projectReference,
        costCenterReference: current.bill!.costCenterReference,
      });
      entityId = created.id;
      if (
        rows<{ name: string }>("PRAGMA table_info(bills)").some(
          (column) => column.name === "requires_acceptance",
        )
      ) {
        getDb()
          .prepare(
            "UPDATE bills SET requires_acceptance=?,milestone_accepted_at=NULL,milestone_accepted_by=NULL,acceptance_evidence=NULL WHERE id=?",
          )
          .run(Number(current.bill!.requiresAcceptance), entityId);
      } else if (current.bill!.requiresAcceptance) {
        throw new ApiError(
          409,
          "Milestone billing must be available before this template can recur",
          "MILESTONE_SETUP_REQUIRED",
        );
      }
    } else {
      const original = current.payroll!;
      const shift =
        companyCalendarShift(
          dueAt,
          original.scheduledFor ?? original.periodEnd,
          timeZone,
        ) * 86_400_000;
      const shiftDate = (date: string) => rule.cadence === "months"
        ? shiftPeriodDate(date, companyMonthShift(dueAt, original.scheduledFor ?? original.periodEnd, timeZone))
        : new Date(Date.parse(`${date}T00:00:00.000Z`) + shift)
          .toISOString()
          .slice(0, 10);
      const created = createPayrollRun(access, {
        reference,
        periodStart: shiftDate(original.periodStart),
        periodEnd: shiftDate(original.periodEnd),
        scheduledFor: dueAt,
        items: current.payments.map((payment) => ({
          recipientId: payment.recipientId,
          amount: payment.amount,
          maxFee: payment.maxFee,
        })),
      });
      entityId = created.id;
    }
    const result = { kind: rule.kind, entityId, approvalRequired: true };
    getDb()
      .prepare(
        "INSERT INTO recurring_occurrences(rule_id,due_at,status,result,created_at) VALUES(?,?,'drafted',?,?)",
      )
      .run(rule.id, dueAt, JSON.stringify(result), iso());
    getDb()
      .prepare(
        "UPDATE recurring_rules SET next_run_at=?,last_run_at=?,last_result=?,updated_at=? WHERE id=?",
      )
      .run(next, dueAt, JSON.stringify(result), iso(), rule.id);
    notify(
      job.organization_id,
      `recurring-draft:${rule.id}:${dueAt}`,
      "Recurring draft ready",
      "A new draft is ready for review. It has no payment approval or signing authority.",
      entityId,
    );
    return { status: "completed", detail: result };
  });
}

async function processJob(job: OperationJob): Promise<JobResult> {
  assertLease(job);
  if (
    ["recurring", "execute_approved", "due_payment"].includes(job.kind) &&
    isPaused(job.organization_id)
  )
    return {
      status: "blocked",
      delayMs: 60_000,
      detail: { reason: "Company payments are paused" },
    };
  if (job.kind === "recurring") return recurringJob(job);
  const access = ownerAccess(job.organization_id);
  if (job.kind === "due_payment") {
    const payment = row<{ status: string; reference: string }>(
      "SELECT status,reference FROM payments WHERE id=? AND organization_id=?",
      job.entity_id,
      job.organization_id,
    );
    if (!payment || ["paid", "cancelled"].includes(payment.status))
      return { status: "completed", detail: { skipped: true } };
    notify(
      job.organization_id,
      `payment-due:${job.entity_id}`,
      "Payment due for review",
      "An unpaid obligation is due. Check its funding, approvals and receiving preferences before execution.",
      job.entity_id,
    );
    return {
      status: "blocked",
      delayMs: 300_000,
      detail: {
        mode: "manual",
        reason: "Review funding and approve the exact route in the NEAR wallet",
        attentionRequired: true,
        paymentId: job.entity_id,
      },
    };
  }
  if (job.kind === "reconcile_payment") {
    const result = await reconcilePayment(access, job.entity_id);
    return {
      status: ["paid", "cancelled"].includes(result.payment.status)
        ? "completed"
        : "queued",
      delayMs: 60_000,
      detail: { paymentId: job.entity_id, status: result.payment.status },
    };
  }
  if (job.kind === "reconcile_funding") {
    const before = row<{ status: string }>("SELECT status FROM funding_legs WHERE id=? AND organization_id=?", job.entity_id, job.organization_id);
    if (before && ["confirmed", "refunded_verified", "closed_unsent", "cancelled"].includes(before.status)) return { status: "completed", detail: { fundingId: job.entity_id, status: before.status } };
    const result = await reconcileFunding(access, job.entity_id);
    const funding = row<{ status: string }>(
      "SELECT status FROM funding_legs WHERE id=? AND organization_id=?",
      job.entity_id,
      job.organization_id,
    );
    return {
      status:
        funding &&
        ["confirmed", "refunded_verified", "closed_unsent", "cancelled"].includes(
          funding.status,
        )
          ? "completed"
          : "queued",
      delayMs: 60_000,
      detail: {
        fundingId: job.entity_id,
        status: funding?.status,
        reconciled: !!result,
      },
    };
  }
  if (job.kind === "purge_assistant") {
    if (!access.permissions.includes("documents:manage"))
      return {
        status: "blocked",
        delayMs: 86_400_000,
        detail: {
          reason: "Document manager access required for retention purge",
        },
      };
    return { status: "completed", detail: purgeRetention(access) };
  }
  if (job.kind === "execute_approved") {
    const { executeApprovedAttempt } = await import("./executor");
    return executeApprovedAttempt(job, access);
  }
  throw new ApiError(422, "Unknown operations job", "JOB_KIND_INVALID");
}

export async function tickOperations(
  input: { organizationId?: string; maxJobs?: number } = {},
) {
  enqueueOperations(input.organizationId);
  const results: { id: string; kind: string; status: string }[] = [];
  const count = Math.max(1, Math.min(20, input.maxJobs ?? 5));
  for (let index = 0; index < count; index++) {
    const job = leaseOperation(input.organizationId);
    if (!job) break;
    try {
      const result = await processJob(job);
      transaction(() => {
        assertLease(job);
        getDb()
          .prepare(
            "UPDATE operation_jobs SET status=?,run_at=?,failures=0,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,result=?,updated_at=? WHERE id=? AND lease_owner=?",
          )
          .run(
            result.status,
            new Date(Date.now() + (result.delayMs ?? 0)).toISOString(),
            JSON.stringify(result.detail),
            iso(),
            job.id,
            job.lease_owner,
          );
      });
      results.push({ id: job.id, kind: job.kind, status: result.status });
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "The job could not finish. Its recorded effects will be reconciled before retry.";
      const failures = job.failures + 1;
      getDb()
        .prepare(
          "UPDATE operation_jobs SET status=?,failures=?,run_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND lease_owner=? AND status='running'",
        )
        .run(
          failures >= 8 ? "failed" : "queued",
          failures,
          new Date(
            Date.now() + Math.min(3_600_000, 15_000 * 2 ** failures),
          ).toISOString(),
          message,
          iso(),
          job.id,
          job.lease_owner,
        );
      notify(
        job.organization_id,
        `job-error:${job.id}:${failures >= 8 ? "failed" : "retry"}`,
        failures >= 8
          ? "Operations job needs review"
          : "Operations retry scheduled",
        message,
        job.entity_id,
      );
      results.push({
        id: job.id,
        kind: job.kind,
        status: failures >= 8 ? "failed" : "queued",
      });
    }
  }
  const notifications = await dispatchNotifications(input.organizationId, 1);
  return { processed: results.length, jobs: results, notifications };
}

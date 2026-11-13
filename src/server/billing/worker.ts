import { randomUUID } from "node:crypto";
import { ApiError } from "../context";
import { getDb, row, transaction } from "../db";
import { reconcileInvoiceForOperator, reconcileRefundForOperator } from "./payments";

interface Job { organization_id: string; kind: "invoice" | "refund"; entity_id: string; lease_id: string; failures: number }

function leaseBilling(organizationId?: string): Job | undefined {
  return transaction(db => {
    const at = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO billing_reconciliation_jobs(organization_id,kind,entity_id,run_at,updated_at)
      SELECT organization_id,'invoice',id,?,? FROM billing_invoices
      WHERE (? IS NULL OR organization_id=?) AND (status IN ('claimed','submitted','credit_required') OR
      status='paid' AND EXISTS(SELECT 1 FROM billing_periods p WHERE p.source_invoice_id=billing_invoices.id AND p.revoked_at IS NULL AND p.ends_at>?))`)
      .run(at, at, organizationId ?? null, organizationId ?? null, at);
    db.prepare(`INSERT OR IGNORE INTO billing_reconciliation_jobs(organization_id,kind,entity_id,run_at,updated_at)
      SELECT organization_id,'refund',id,?,? FROM billing_refund_requests
      WHERE (? IS NULL OR organization_id=?) AND status IN ('prepared','pending')`)
      .run(at, at, organizationId ?? null, organizationId ?? null);
    const job = row<Job>(`SELECT * FROM billing_reconciliation_jobs WHERE run_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)
      AND (? IS NULL OR organization_id=?) ORDER BY run_at,kind,entity_id LIMIT 1`, at, at, organizationId ?? null, organizationId ?? null);
    if (!job) return;
    const lease = randomUUID();
    db.prepare("UPDATE billing_reconciliation_jobs SET lease_id=?,lease_expires_at=?,updated_at=? WHERE kind=? AND entity_id=?")
      .run(lease, new Date(Date.now() + 180_000).toISOString(), at, job.kind, job.entity_id);
    return { ...job, lease_id: lease };
  });
}

export async function tickBilling(organizationId?: string, maxJobs = 2) {
  let checked = 0, retrying = 0;
  for (let index = 0; index < Math.max(1, Math.min(10, maxJobs)); index++) {
    const job = leaseBilling(organizationId);
    if (!job) break;
    try {
      let finished = false;
      if (job.kind === "invoice") {
        const result = await reconcileInvoiceForOperator(job.organization_id, job.entity_id);
        finished = ["refunded", "cancelled"].includes(result.invoice.status) || result.invoice.status === "paid" && !row("SELECT id FROM billing_periods WHERE source_invoice_id=? AND revoked_at IS NULL AND ends_at>?", job.entity_id, new Date().toISOString());
      } else {
        const result = await reconcileRefundForOperator(job.entity_id);
        finished = ["completed", "failed"].includes(result.status);
      }
      if (finished) getDb().prepare("DELETE FROM billing_reconciliation_jobs WHERE kind=? AND entity_id=? AND lease_id=?").run(job.kind, job.entity_id, job.lease_id);
      else getDb().prepare("UPDATE billing_reconciliation_jobs SET lease_id=NULL,lease_expires_at=NULL,failures=0,last_error=NULL,run_at=?,updated_at=? WHERE kind=? AND entity_id=? AND lease_id=?")
        .run(new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), job.kind, job.entity_id, job.lease_id);
      checked++;
    } catch (error) {
      const delay = Math.min(3_600_000, 15_000 * 2 ** Math.min(job.failures + 1, 8));
      getDb().prepare("UPDATE billing_reconciliation_jobs SET lease_id=NULL,lease_expires_at=NULL,failures=failures+1,last_error=?,run_at=?,updated_at=? WHERE kind=? AND entity_id=? AND lease_id=?")
        .run(error instanceof ApiError ? error.message : "Billing verification is unavailable; the original invoice will be retried.", new Date(Date.now() + delay).toISOString(), new Date().toISOString(), job.kind, job.entity_id, job.lease_id);
      retrying++;
    }
  }
  return { checked, retrying };
}

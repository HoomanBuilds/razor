CREATE TABLE billing_reconciliation_jobs (
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 kind TEXT NOT NULL CHECK(kind IN ('invoice','refund')),
 entity_id TEXT NOT NULL,
 run_at TEXT NOT NULL,
 lease_id TEXT,
 lease_expires_at TEXT,
 failures INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(kind,entity_id)
);
CREATE INDEX billing_reconciliation_due ON billing_reconciliation_jobs(run_at,lease_expires_at);

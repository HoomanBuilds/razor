CREATE TABLE finance_plans (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  plan_hash TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  evidence_ciphertext TEXT NOT NULL,
  prepared_run_id TEXT REFERENCES payroll_runs(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX finance_plans_org_expiry ON finance_plans(organization_id,expires_at);

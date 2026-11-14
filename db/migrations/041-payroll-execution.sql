CREATE TABLE payroll_execution_batches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  stage TEXT NOT NULL CHECK(stage IN ('prepare','approve','execute','close')),
  status TEXT NOT NULL CHECK(status IN ('planning','review','signing','reconciling','closed','cancelled')),
  review_hash TEXT,
  payload_ciphertext TEXT NOT NULL,
  signer_account TEXT,
  receipts_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX payroll_execution_active_run ON payroll_execution_batches(organization_id,run_id)
  WHERE status IN ('planning','review','signing','reconciling');
CREATE INDEX payroll_execution_run_history ON payroll_execution_batches(organization_id,run_id,created_at);

ALTER TABLE recurring_rules ADD COLUMN snapshot_ciphertext TEXT;
ALTER TABLE recurring_rules ADD COLUMN max_amount TEXT;
ALTER TABLE recurring_rules ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE recurring_rules ADD COLUMN last_run_at TEXT;
ALTER TABLE recurring_rules ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX recurring_active_source ON recurring_rules(organization_id,kind,entity_id) WHERE enabled=1;

ALTER TABLE notices ADD COLUMN required_permission TEXT NOT NULL DEFAULT 'payments:read';
ALTER TABLE notices ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX notices_dedupe ON notices(organization_id,dedupe_key);
CREATE TABLE notice_receipts (
  notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  read_at TEXT NOT NULL,
  PRIMARY KEY(notice_id,user_id)
);

CREATE TABLE operation_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  job_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,job_key)
);
CREATE INDEX operation_jobs_due ON operation_jobs(status,run_at,lease_expires_at);
CREATE TABLE recurring_occurrences (
  rule_id TEXT NOT NULL REFERENCES recurring_rules(id),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(rule_id,due_at)
);
CREATE TABLE agent_mandates (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  executor_account_id TEXT NOT NULL,
  max_amount TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE operation_submissions (
  attempt_id TEXT PRIMARY KEY REFERENCES payout_attempts(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  executor_account_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  signed_transaction_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

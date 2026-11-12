CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  reference TEXT NOT NULL,
  title TEXT NOT NULL,
  amount TEXT NOT NULL,
  max_fee TEXT NOT NULL DEFAULT '1000000',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  line_items TEXT NOT NULL DEFAULT '[]',
  evidence TEXT,
  document_hash TEXT,
  payment_id TEXT,
  accepted_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, recipient_id, reference)
);
CREATE INDEX IF NOT EXISTS bills_due ON bills(organization_id, status, due_date);
CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  reference TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  scheduled_for TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, reference)
);
CREATE TABLE IF NOT EXISTS payroll_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  amount TEXT NOT NULL,
  max_fee TEXT NOT NULL DEFAULT '1000000',
  note TEXT,
  payment_id TEXT,
  UNIQUE (run_id, recipient_id)
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recurring_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  interval_days INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  last_result TEXT,
  created_at TEXT NOT NULL
);

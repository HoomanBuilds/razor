CREATE TABLE payroll_item_terms (
  item_id TEXT PRIMARY KEY REFERENCES payroll_items(id),
  base_amount TEXT NOT NULL,
  bonus_amount TEXT NOT NULL,
  adjustment_amount TEXT NOT NULL,
  note_ciphertext TEXT,
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE payment_replacements (
  old_payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  new_payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  liability_kind TEXT NOT NULL,
  liability_id TEXT NOT NULL,
  reason_ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX payment_replacement_liability ON payment_replacements(organization_id,liability_kind,liability_id);

CREATE TABLE payment_management_audit (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE payroll_run_approvals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  review_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

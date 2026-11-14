CREATE TABLE expense_policies (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  per_expense_limit TEXT,
  monthly_person_limit TEXT,
  require_cost_center INTEGER NOT NULL DEFAULT 0,
  cost_centers_ciphertext TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE expense_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  recipient_version INTEGER NOT NULL,
  recipient_snapshot_ciphertext TEXT NOT NULL,
  submitter_name_ciphertext TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  document_id TEXT,
  amount TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploading','receipt_failed','submitted','returned','rejected','cancelled','preparing','accepted')),
  version INTEGER NOT NULL DEFAULT 1,
  bill_id TEXT REFERENCES bills(id),
  review_ciphertext TEXT,
  replaces_expense_id TEXT REFERENCES expense_requests(id),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, submitted_by, request_key),
  UNIQUE(organization_id, source_hash),
  UNIQUE(organization_id, identity_hash)
);
CREATE INDEX expense_company_history ON expense_requests(organization_id, submitted_at DESC, id DESC);
CREATE INDEX expense_person_history ON expense_requests(submitted_by, submitted_at DESC, id DESC);
CREATE INDEX expense_source_link ON expense_requests(organization_id, document_id);

CREATE TABLE expense_versions (
  expense_id TEXT NOT NULL REFERENCES expense_requests(id),
  version INTEGER NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  recipient_snapshot_ciphertext TEXT NOT NULL,
  amount TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(expense_id, version)
);

CREATE TABLE expense_events (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expense_requests(id),
  actor_id TEXT REFERENCES users(id),
  decision TEXT NOT NULL,
  note_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX expense_event_history ON expense_events(expense_id,created_at,id);

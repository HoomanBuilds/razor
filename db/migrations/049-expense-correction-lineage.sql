PRAGMA defer_foreign_keys = ON;

CREATE TABLE expense_requests_next (
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
  replaces_expense_id TEXT UNIQUE REFERENCES expense_requests(id),
  superseded_by TEXT UNIQUE REFERENCES expense_requests(id) DEFERRABLE INITIALLY DEFERRED,
  policy_month TEXT NOT NULL CHECK(policy_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, submitted_by, request_key)
);

INSERT INTO expense_requests_next
SELECT e.id,e.organization_id,e.submitted_by,e.recipient_id,e.recipient_version,e.recipient_snapshot_ciphertext,
  e.submitter_name_ciphertext,e.request_key,e.request_hash,e.source_hash,e.identity_hash,e.document_id,e.amount,
  e.payload_ciphertext,e.status,e.version,e.bill_id,e.review_ciphertext,e.replaces_expense_id,
  (SELECT c.id FROM expense_requests c WHERE c.replaces_expense_id=e.id),
  (WITH RECURSIVE ancestors(id,replaces_expense_id,submitted_at) AS (
    SELECT e.id,e.replaces_expense_id,e.submitted_at
    UNION SELECT p.id,p.replaces_expense_id,p.submitted_at FROM expense_requests p JOIN ancestors a ON p.id=a.replaces_expense_id
  ) SELECT substr(submitted_at,1,7) FROM ancestors WHERE replaces_expense_id IS NULL LIMIT 1),
  e.submitted_at,e.updated_at
FROM expense_requests e;

DROP TABLE expense_requests;
ALTER TABLE expense_requests_next RENAME TO expense_requests;

CREATE UNIQUE INDEX expense_tip_source ON expense_requests(organization_id,source_hash) WHERE superseded_by IS NULL;
CREATE UNIQUE INDEX expense_tip_identity ON expense_requests(organization_id,identity_hash) WHERE superseded_by IS NULL;
CREATE INDEX expense_company_history ON expense_requests(organization_id,submitted_at DESC,id DESC);
CREATE INDEX expense_person_history ON expense_requests(submitted_by,submitted_at DESC,id DESC);
CREATE INDEX expense_source_link ON expense_requests(organization_id,document_id);

-- Rebuilding a referenced table leaves deferred DROP counters; validate the final graph before clearing them.
CREATE TEMP TABLE expense_migration_integrity_guard (invalid INTEGER CHECK(invalid=0));
INSERT INTO expense_migration_integrity_guard SELECT 1 FROM pragma_foreign_key_check LIMIT 1;
DROP TABLE expense_migration_integrity_guard;
PRAGMA defer_foreign_keys = OFF;

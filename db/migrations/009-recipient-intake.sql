CREATE TABLE recipient_invoice_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  reference_hash TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  bill_id TEXT REFERENCES bills(id),
  review_ciphertext TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,recipient_id,reference_hash),
  UNIQUE(organization_id,source_fingerprint)
);
CREATE INDEX recipient_intake_user ON recipient_invoice_requests(submitted_by,created_at);
CREATE INDEX recipient_intake_company ON recipient_invoice_requests(organization_id,status,created_at);

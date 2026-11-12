CREATE TABLE private_settlement_evidence (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  attempt_id TEXT NOT NULL REFERENCES payout_attempts(id),
  evidence_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ciphertext TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(organization_id,attempt_id,evidence_kind,content_hash)
);

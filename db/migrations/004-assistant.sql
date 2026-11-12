CREATE TABLE assistant_drafts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  input_ciphertext TEXT NOT NULL,
  draft_ciphertext TEXT NOT NULL,
  evidence_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX assistant_drafts_org_expiry ON assistant_drafts(organization_id, expires_at);

CREATE TABLE assistant_audit (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  draft_id TEXT,
  created_at TEXT NOT NULL
);

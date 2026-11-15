ALTER TABLE recipients ADD COLUMN invitation_token_ciphertext TEXT;
ALTER TABLE recipients ADD COLUMN invitation_version INTEGER;

CREATE TABLE recipient_invitation_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  recipient_version INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  email_ciphertext TEXT NOT NULL,
  payload_ciphertext TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT,
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  provider_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,recipient_id,request_key)
);
CREATE INDEX recipient_invitation_outbox_due ON recipient_invitation_outbox(state,next_attempt_at);
CREATE INDEX recipient_invitation_outbox_recipient ON recipient_invitation_outbox(organization_id,recipient_id,created_at);

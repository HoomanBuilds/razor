CREATE TABLE invoice_channels (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK(provider IN ('telegram','whatsapp','folder')),
  label TEXT NOT NULL,
  config_ciphertext TEXT NOT NULL,
  secrets_ciphertext TEXT,
  credential_hash TEXT UNIQUE,
  binding_hash TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  challenge_verified_at TEXT,
  verified_at TEXT,
  last_received_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX invoice_channels_active_binding ON invoice_channels(provider,binding_hash) WHERE revoked_at IS NULL;
CREATE INDEX invoice_channels_company ON invoice_channels(organization_id,created_at DESC);

CREATE TABLE invoice_channel_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  channel_id TEXT NOT NULL REFERENCES invoice_channels(id),
  event_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  source_ciphertext TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','received','failed','expired','revoked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  processing_token TEXT,
  next_attempt_at TEXT NOT NULL,
  error_code TEXT,
  document_id TEXT REFERENCES invoice_documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(channel_id,event_key)
);
CREATE INDEX invoice_channel_events_retry ON invoice_channel_events(status,next_attempt_at);
CREATE INDEX invoice_channel_events_company ON invoice_channel_events(organization_id,created_at DESC);

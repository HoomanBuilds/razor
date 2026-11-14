CREATE TABLE invoice_documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  filename_ciphertext TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  source_hash TEXT NOT NULL,
  original_ciphertext TEXT NOT NULL,
  text_ciphertext TEXT,
  text_hash TEXT,
  needs_vision INTEGER NOT NULL DEFAULT 0 CHECK(needs_vision IN (0,1)),
  analysis_ciphertext TEXT,
  assistant_draft_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('processing','ready','needs_review','analyzing','reviewed')),
  error_code TEXT,
  error_message TEXT,
  processing_token TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  bill_id TEXT REFERENCES bills(id),
  review_ciphertext TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(organization_id, source_hash)
);
CREATE INDEX invoice_documents_org_history ON invoice_documents(organization_id, created_at DESC, id DESC);
CREATE INDEX invoice_documents_expiry ON invoice_documents(expires_at);
CREATE INDEX invoice_documents_text ON invoice_documents(organization_id, text_hash);

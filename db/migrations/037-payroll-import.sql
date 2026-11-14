CREATE TABLE payroll_import_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name_ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  settings_ciphertext TEXT NOT NULL,
  headers_ciphertext TEXT NOT NULL,
  archived_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX payroll_import_templates_company ON payroll_import_templates(organization_id, archived_at);
CREATE TABLE payroll_import_template_versions (
  template_id TEXT NOT NULL REFERENCES payroll_import_templates(id),
  version INTEGER NOT NULL,
  snapshot_ciphertext TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(template_id, version)
);
CREATE TABLE payroll_import_drafts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  run_id TEXT REFERENCES payroll_runs(id),
  commit_ciphertext TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(organization_id, request_key)
);
CREATE INDEX payroll_import_drafts_company ON payroll_import_drafts(organization_id, updated_at);

CREATE TABLE accounting_connections (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL CHECK(provider IN ('quickbooks','xero')),
 created_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', environment TEXT NOT NULL,
 token_ciphertext TEXT, access_expires_at TEXT, refresh_owner TEXT, refresh_until TEXT,
 entities_ciphertext TEXT, entity_id TEXT, entity_name TEXT, currency TEXT, version INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(organization_id,provider)
);
CREATE TABLE accounting_oauth_states (
 state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES accounting_connections(id), user_id TEXT NOT NULL REFERENCES users(id),
 expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE accounting_catalog (
 connection_id TEXT NOT NULL REFERENCES accounting_connections(id), entity_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
 data_ciphertext TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(connection_id,entity_id,kind,external_id)
);
CREATE TABLE accounting_mappings (
 connection_id TEXT NOT NULL REFERENCES accounting_connections(id), version INTEGER NOT NULL, entity_id TEXT NOT NULL,
 payload_ciphertext TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 PRIMARY KEY(connection_id,version)
);
CREATE TABLE accounting_jobs (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), connection_id TEXT NOT NULL REFERENCES accounting_connections(id),
 entity_id TEXT NOT NULL, connection_version INTEGER NOT NULL, mapping_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('bill','settlement')),
 source_id TEXT NOT NULL, source_hash TEXT NOT NULL, marker TEXT NOT NULL UNIQUE, payload_ciphertext TEXT NOT NULL, review_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'review', created_by TEXT NOT NULL REFERENCES users(id), approved_by TEXT REFERENCES users(id), approved_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, write_started_at TEXT, lease_owner TEXT, lease_until TEXT, external_id TEXT, external_revision TEXT, provider_hash TEXT,
 last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(connection_id,entity_id,kind,source_id)
);
CREATE INDEX accounting_queue ON accounting_jobs(state,updated_at,id);
CREATE TABLE accounting_observations (
 connection_id TEXT NOT NULL REFERENCES accounting_connections(id), entity_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
 revision TEXT NOT NULL, payload_ciphertext TEXT NOT NULL, state TEXT NOT NULL, matching_job_id TEXT REFERENCES accounting_jobs(id), observed_at TEXT NOT NULL,
 PRIMARY KEY(connection_id,entity_id,kind,external_id)
);

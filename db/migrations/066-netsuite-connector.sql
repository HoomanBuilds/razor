CREATE TABLE netsuite_connections (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id), account_domain TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
 token_ciphertext TEXT, expires_at TEXT, refresh_owner TEXT, refresh_until TEXT, catalog_ciphertext TEXT, catalog_hash TEXT, catalog_at TEXT,
 mapping_ciphertext TEXT, mapping_version INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE netsuite_oauth_states (
 state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES netsuite_connections(id), connection_version INTEGER NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL, browser_nonce_hash TEXT NOT NULL, verifier_ciphertext TEXT NOT NULL,
 expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE netsuite_jobs (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), connection_id TEXT NOT NULL REFERENCES netsuite_connections(id),
 connection_version INTEGER NOT NULL, mapping_version INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES accounting_fee_batches(id),
 source_hash TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE, payload_ciphertext TEXT NOT NULL, review_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'review', created_by TEXT NOT NULL REFERENCES users(id), approved_by TEXT REFERENCES users(id), approved_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until TEXT, write_started_at TEXT, provider_id TEXT, provider_hash TEXT,
 observed_ciphertext TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(connection_id,source_id)
);
CREATE INDEX netsuite_queue ON netsuite_jobs(state,updated_at,id);
CREATE TABLE netsuite_fee_uses (
 connection_id TEXT NOT NULL REFERENCES netsuite_connections(id), fee_id TEXT NOT NULL REFERENCES accounting_fee_evidence(id),
 job_id TEXT NOT NULL REFERENCES netsuite_jobs(id), PRIMARY KEY(connection_id,fee_id)
);
CREATE TABLE netsuite_mapping_history (
 connection_id TEXT NOT NULL REFERENCES netsuite_connections(id), version INTEGER NOT NULL, payload_ciphertext TEXT NOT NULL,
 reviewed_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY(connection_id,version)
);

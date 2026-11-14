CREATE TABLE accounting_jobs_next (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), connection_id TEXT NOT NULL REFERENCES accounting_connections(id),
 entity_id TEXT NOT NULL, connection_version INTEGER NOT NULL, mapping_version INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('bill','settlement','credit','fee','fx')),
 source_id TEXT NOT NULL, source_hash TEXT NOT NULL, marker TEXT NOT NULL UNIQUE, payload_ciphertext TEXT NOT NULL, review_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'review', created_by TEXT NOT NULL REFERENCES users(id), approved_by TEXT REFERENCES users(id), approved_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, write_started_at TEXT, lease_owner TEXT, lease_until TEXT, external_id TEXT, external_revision TEXT, provider_hash TEXT,
 last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id,entity_id,kind,source_id)
);
INSERT INTO accounting_jobs_next SELECT * FROM accounting_jobs;
CREATE TABLE accounting_observations_next (
 connection_id TEXT NOT NULL REFERENCES accounting_connections(id), entity_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
 revision TEXT NOT NULL, payload_ciphertext TEXT NOT NULL, state TEXT NOT NULL, matching_job_id TEXT REFERENCES accounting_jobs_next(id), observed_at TEXT NOT NULL,
 PRIMARY KEY(connection_id,entity_id,kind,external_id)
);
INSERT INTO accounting_observations_next SELECT * FROM accounting_observations;
DROP TABLE accounting_observations;
DROP TABLE accounting_jobs;
ALTER TABLE accounting_jobs_next RENAME TO accounting_jobs;
ALTER TABLE accounting_observations_next RENAME TO accounting_observations;
CREATE INDEX accounting_queue ON accounting_jobs(state,updated_at,id);
CREATE TABLE accounting_fee_evidence (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
 transaction_hash TEXT NOT NULL, signer_account TEXT NOT NULL, reference_kind TEXT NOT NULL CHECK(reference_kind IN ('payment','funding')),
 reference_id TEXT NOT NULL, amount_atomic TEXT NOT NULL, asset TEXT NOT NULL CHECK(asset='NEAR'), decimals INTEGER NOT NULL CHECK(decimals=24),
 evidence_ciphertext TEXT NOT NULL, evidence_hash TEXT NOT NULL, reviewed_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(network,transaction_hash)
);
CREATE TABLE accounting_fee_batches (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), network TEXT NOT NULL, amount_atomic TEXT NOT NULL,
 source_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'grouped' CHECK(state IN ('grouped','released')), created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE accounting_fee_batch_items (
 batch_id TEXT NOT NULL REFERENCES accounting_fee_batches(id), fee_id TEXT NOT NULL UNIQUE REFERENCES accounting_fee_evidence(id), PRIMARY KEY(batch_id,fee_id)
);
CREATE TABLE accounting_fx_differences (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), connection_id TEXT NOT NULL REFERENCES accounting_connections(id), entity_id TEXT NOT NULL,
 payment_id TEXT NOT NULL REFERENCES payments(id), settlement_job_id TEXT NOT NULL REFERENCES accounting_jobs(id), basis_hash TEXT NOT NULL,
 payload_ciphertext TEXT NOT NULL, source_hash TEXT NOT NULL, approved_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(connection_id,entity_id,payment_id)
);
CREATE TRIGGER accounting_fee_immutable BEFORE UPDATE ON accounting_fee_evidence BEGIN SELECT RAISE(ABORT,'Preserve exact final fee observations.'); END;
CREATE TRIGGER accounting_fx_immutable BEFORE UPDATE ON accounting_fx_differences BEGIN SELECT RAISE(ABORT,'Preserve the approved FX source and difference.'); END;

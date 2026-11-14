CREATE TABLE claim_distributions (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 reference TEXT NOT NULL,
 request_key TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 payload_ciphertext TEXT NOT NULL,
 plan_ciphertext TEXT,
 plan_hash TEXT,
 stage TEXT NOT NULL DEFAULT 'draft' CHECK(stage IN ('draft','review','signing','observed','voided')),
 total_amount TEXT NOT NULL,
 local_reserved TEXT NOT NULL DEFAULT '0',
 chain_reserved TEXT NOT NULL DEFAULT '0',
 pending_amount TEXT NOT NULL DEFAULT '0',
 paid_amount TEXT NOT NULL DEFAULT '0',
 reclaimed_amount TEXT NOT NULL DEFAULT '0',
 chain_status TEXT,
 source_tx_hash TEXT,
 last_error TEXT,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(organization_id, reference),
 UNIQUE(organization_id, request_key)
);
CREATE TABLE claim_distribution_allocations (
 id TEXT PRIMARY KEY,
 distribution_id TEXT NOT NULL REFERENCES claim_distributions(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 recipient_id TEXT NOT NULL REFERENCES recipients(id),
 bound_user_id TEXT NOT NULL REFERENCES users(id),
 payload_ciphertext TEXT NOT NULL,
 source_unknown INTEGER NOT NULL DEFAULT 0 CHECK(source_unknown IN (0,1)),
 observed_nonce TEXT NOT NULL DEFAULT '0',
 observed_status TEXT,
 source_tx_hash TEXT,
 UNIQUE(distribution_id, recipient_id)
);
CREATE INDEX claim_distributions_company ON claim_distributions(organization_id,created_at,id);
CREATE INDEX claim_distribution_recipient ON claim_distribution_allocations(bound_user_id,distribution_id);

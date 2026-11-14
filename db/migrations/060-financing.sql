CREATE TABLE financing_scopes (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL, label TEXT NOT NULL, eligibility TEXT NOT NULL,
 network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')), contract_id TEXT NOT NULL, token_contract TEXT NOT NULL, treasury_id TEXT NOT NULL, code_hash TEXT NOT NULL,
 allowed_organizations_json TEXT NOT NULL, allowed_lenders_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, published_by TEXT NOT NULL REFERENCES users(id), published_at TEXT NOT NULL
);
CREATE TABLE financing_requests (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), borrower_user_id TEXT NOT NULL REFERENCES users(id), scope_id TEXT NOT NULL REFERENCES financing_scopes(id), scope_version INTEGER NOT NULL, fund_by TEXT NOT NULL,
 request_key TEXT NOT NULL, input_hash TEXT NOT NULL, payload_ciphertext TEXT NOT NULL, scope_ciphertext TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', accepted_offer_id TEXT,
 loan_id TEXT UNIQUE, terms_ciphertext TEXT, terms_hash TEXT, chain_ciphertext TEXT, reconciled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(organization_id,request_key)
);
CREATE INDEX financing_company ON financing_requests(organization_id,created_at,id);
CREATE TABLE financing_offers (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES financing_requests(id), lender_user_id TEXT NOT NULL REFERENCES users(id), lender_account TEXT NOT NULL,
 request_key TEXT NOT NULL, input_hash TEXT NOT NULL, payload_ciphertext TEXT NOT NULL, offer_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL,
 UNIQUE(lender_user_id,request_key)
);
CREATE INDEX financing_offer_request ON financing_offers(request_id,created_at,id);
CREATE TABLE financing_assignments (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES financing_requests(id), organization_id TEXT NOT NULL REFERENCES organizations(id),
 source_organization_id TEXT NOT NULL REFERENCES organizations(id), bill_id TEXT NOT NULL REFERENCES bills(id), claim_hash TEXT NOT NULL, claim_ciphertext TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'held', released_at TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX financing_exclusive_bill ON financing_assignments(bill_id) WHERE state='held';
CREATE TABLE financing_history (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES financing_requests(id), actor_user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, payload_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER financing_offer_terms_immutable BEFORE UPDATE OF request_id,lender_user_id,lender_account,payload_ciphertext,offer_hash,input_hash ON financing_offers BEGIN SELECT RAISE(ABORT,'Financing offer terms are immutable. Submit a separate comparable offer.'); END;
CREATE TRIGGER financing_accepted_terms_immutable BEFORE UPDATE OF terms_ciphertext,terms_hash,accepted_offer_id,loan_id,payload_ciphertext ON financing_requests WHEN OLD.terms_hash IS NOT NULL BEGIN SELECT RAISE(ABORT,'Preserve signed financing authority and exact accepted terms.'); END;
CREATE TRIGGER financing_history_immutable BEFORE UPDATE ON financing_history BEGIN SELECT RAISE(ABORT,'Preserve financing history.'); END;
CREATE TRIGGER financing_history_retained BEFORE DELETE ON financing_history BEGIN SELECT RAISE(ABORT,'Preserve financing history.'); END;

CREATE TABLE financing_actions (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES financing_requests(id), user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL, amount TEXT NOT NULL, deposit_id TEXT NOT NULL, review_hash TEXT NOT NULL, wallet_ciphertext TEXT NOT NULL,
 stage TEXT NOT NULL DEFAULT 'review', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(request_id,deposit_id)
);
CREATE UNIQUE INDEX financing_unresolved_deposit ON financing_actions(request_id,user_id) WHERE stage='signing';
CREATE TABLE financing_advance_credits (
 request_id TEXT PRIMARY KEY REFERENCES financing_requests(id), organization_id TEXT NOT NULL REFERENCES organizations(id),
 network TEXT NOT NULL, treasury_id TEXT NOT NULL, company_id TEXT NOT NULL, credit_id TEXT NOT NULL, token_contract TEXT NOT NULL,
 sender_id TEXT NOT NULL, amount TEXT NOT NULL, receipt_identity TEXT NOT NULL UNIQUE, transaction_hash TEXT NOT NULL,
 metadata_ciphertext TEXT NOT NULL, verified_by TEXT NOT NULL REFERENCES users(id), verified_at TEXT NOT NULL,
 UNIQUE(network,treasury_id,credit_id)
);
CREATE TRIGGER financing_credit_immutable BEFORE UPDATE ON financing_advance_credits BEGIN SELECT RAISE(ABORT,'Preserve immutable verified loan advance credits.'); END;
CREATE TRIGGER financing_credit_retained BEFORE DELETE ON financing_advance_credits BEGIN SELECT RAISE(ABORT,'Preserve verified financing receipt evidence.'); END;

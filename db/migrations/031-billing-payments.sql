CREATE TABLE billing_invoices (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 plan_version_id TEXT NOT NULL REFERENCES billing_plan_versions(id),
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 purchase_json TEXT NOT NULL CHECK(json_valid(purchase_json)),
 amount TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','claimed','submitted','paid','credit_required','refunded','expired','cancelled')),
 network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
 billing_contract TEXT NOT NULL,
 token_contract TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 payer_account TEXT NOT NULL,
 terms_hash TEXT NOT NULL,
 quote_json TEXT NOT NULL CHECK(json_valid(quote_json)),
 signature TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 claimed_at TEXT,
 submitted_hash TEXT,
 transaction_hash TEXT,
 proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
 confirmed_at TEXT,
 refunded_amount TEXT NOT NULL DEFAULT '0',
 credit_reason TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(organization_id,request_key)
);
CREATE UNIQUE INDEX billing_invoice_one_open ON billing_invoices(organization_id) WHERE status IN ('prepared','claimed','submitted');
CREATE INDEX billing_invoice_company_history ON billing_invoices(organization_id,created_at DESC,id DESC);
CREATE TABLE billing_receipt_claims (
 network TEXT NOT NULL,
 transaction_hash TEXT NOT NULL,
 invoice_id TEXT NOT NULL UNIQUE REFERENCES billing_invoices(id),
 PRIMARY KEY(network,transaction_hash)
);
CREATE TABLE billing_refund_requests (
 id TEXT PRIMARY KEY,
 invoice_id TEXT NOT NULL REFERENCES billing_invoices(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 requested_by TEXT NOT NULL REFERENCES users(id),
 reason_ciphertext TEXT NOT NULL,
 amount TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('requested','prepared','pending','completed','failed')),
 proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX billing_refund_one_open ON billing_refund_requests(invoice_id) WHERE status IN ('requested','prepared','pending');
CREATE TABLE billing_payment_audit (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 invoice_id TEXT REFERENCES billing_invoices(id),
 user_id TEXT REFERENCES users(id),
 action TEXT NOT NULL,
 details_json TEXT NOT NULL CHECK(json_valid(details_json)),
 created_at TEXT NOT NULL
);
CREATE TRIGGER billing_invoice_terms_immutable BEFORE UPDATE ON billing_invoices
WHEN NEW.organization_id<>OLD.organization_id OR NEW.created_by<>OLD.created_by OR NEW.plan_version_id<>OLD.plan_version_id OR NEW.amount<>OLD.amount OR NEW.plan_json<>OLD.plan_json OR NEW.purchase_json<>OLD.purchase_json OR NEW.network<>OLD.network OR NEW.billing_contract<>OLD.billing_contract OR NEW.token_contract<>OLD.token_contract OR NEW.code_hash<>OLD.code_hash OR NEW.payer_account<>OLD.payer_account OR NEW.terms_hash<>OLD.terms_hash OR NEW.quote_json<>OLD.quote_json OR NEW.signature<>OLD.signature OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'Billing invoice terms are immutable'); END;
CREATE TABLE billing_invoice_offers (
 quote_hash TEXT PRIMARY KEY,
 invoice_id TEXT NOT NULL REFERENCES billing_invoices(id),
 quote_json TEXT NOT NULL CHECK(json_valid(quote_json)),
 signature TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX billing_offers_invoice ON billing_invoice_offers(invoice_id,created_at DESC,quote_hash);

CREATE TRIGGER billing_signed_offer_immutable BEFORE UPDATE ON billing_invoice_offers BEGIN SELECT RAISE(ABORT,'Billing signed offer history is immutable'); END;
CREATE TRIGGER billing_signed_offer_no_delete BEFORE DELETE ON billing_invoice_offers BEGIN SELECT RAISE(ABORT,'Billing signed offer history is immutable'); END;

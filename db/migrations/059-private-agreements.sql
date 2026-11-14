CREATE TABLE private_tenders (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), reference TEXT NOT NULL,
 current_version INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','open','revealed','closed','awarded','disputed')),
 commitment_id TEXT UNIQUE REFERENCES vendor_commitments(id), created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(organization_id,reference)
);
CREATE TABLE private_tender_versions (
 tender_id TEXT NOT NULL REFERENCES private_tenders(id), version INTEGER NOT NULL, terms_ciphertext TEXT NOT NULL,
 terms_hash TEXT NOT NULL, buyer_public_key TEXT NOT NULL, published_at TEXT, revealed_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 PRIMARY KEY(tender_id,version)
);
CREATE TABLE private_tender_invites (
 id TEXT PRIMARY KEY, tender_id TEXT NOT NULL, tender_version INTEGER NOT NULL,
 recipient_id TEXT NOT NULL REFERENCES recipients(id), supplier_user_id TEXT NOT NULL REFERENCES users(id), supplier_version INTEGER NOT NULL,
 supplier_snapshot_ciphertext TEXT NOT NULL, reply_public_key TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(tender_id,tender_version) REFERENCES private_tender_versions(tender_id,version), UNIQUE(tender_id,tender_version,recipient_id)
);
CREATE INDEX private_tender_supplier ON private_tender_invites(supplier_user_id,tender_id,tender_version);
CREATE TABLE private_sealed_offers (
 id TEXT PRIMARY KEY, invite_id TEXT NOT NULL REFERENCES private_tender_invites(id), revision INTEGER NOT NULL,
 commitment TEXT NOT NULL, binding_json TEXT NOT NULL, envelope_json TEXT,
 status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','withdrawn')), purge_at TEXT NOT NULL, deleted_at TEXT, created_at TEXT NOT NULL,
 UNIQUE(invite_id,revision)
);
CREATE TABLE private_negotiation_mandates (
 id TEXT PRIMARY KEY, invite_id TEXT NOT NULL REFERENCES private_tender_invites(id), terms_ciphertext TEXT NOT NULL, terms_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','revoked')),
 proposed_by TEXT NOT NULL REFERENCES users(id), approved_by TEXT REFERENCES users(id), approved_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE private_negotiation_rounds (
 id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES private_negotiation_mandates(id), sequence INTEGER NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id), actor_role TEXT NOT NULL CHECK(actor_role IN ('company','supplier')),
 commitment TEXT NOT NULL, binding_json TEXT NOT NULL, envelope_json TEXT, purge_at TEXT NOT NULL, deleted_at TEXT, created_at TEXT NOT NULL,
 UNIQUE(mandate_id,sequence)
);
CREATE TABLE private_agreement_versions (
 id TEXT PRIMARY KEY, tender_id TEXT NOT NULL REFERENCES private_tenders(id), tender_version INTEGER NOT NULL, version INTEGER NOT NULL,
 invite_id TEXT NOT NULL REFERENCES private_tender_invites(id), source_kind TEXT NOT NULL CHECK(source_kind IN ('offer','negotiation')), source_id TEXT NOT NULL,
 terms_ciphertext TEXT NOT NULL, terms_hash TEXT NOT NULL, total TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','po_proposed','cancelled','disputed')),
 company_accepted_by TEXT REFERENCES users(id), company_accepted_at TEXT, supplier_accepted_by TEXT REFERENCES users(id), supplier_accepted_at TEXT,
 commitment_id TEXT UNIQUE REFERENCES vendor_commitments(id), proposed_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(tender_id,version)
);
CREATE UNIQUE INDEX private_agreement_one_live ON private_agreement_versions(tender_id) WHERE state IN ('pending','accepted','po_proposed','disputed');
CREATE TABLE private_agreement_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tender_id TEXT NOT NULL REFERENCES private_tenders(id), tender_version INTEGER NOT NULL,
 invite_id TEXT REFERENCES private_tender_invites(id), actor_user_id TEXT NOT NULL REFERENCES users(id), actor_role TEXT NOT NULL,
 kind TEXT NOT NULL, reason_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX private_tenders_company ON private_tenders(organization_id,created_at,id);
CREATE INDEX private_offer_retention ON private_sealed_offers(purge_at) WHERE envelope_json IS NOT NULL;
CREATE INDEX private_round_retention ON private_negotiation_rounds(purge_at) WHERE envelope_json IS NOT NULL;
CREATE TRIGGER private_tender_terms_immutable BEFORE UPDATE OF tender_id,version,terms_ciphertext,terms_hash,buyer_public_key,created_by,created_at ON private_tender_versions BEGIN SELECT RAISE(ABORT,'Append a new tender version.'); END;
CREATE TRIGGER private_agreement_terms_immutable BEFORE UPDATE OF terms_ciphertext,terms_hash,total,invite_id,source_kind,source_id,tender_id,tender_version,version ON private_agreement_versions BEGIN SELECT RAISE(ABORT,'Preserve exact private agreement terms.'); END;
CREATE TRIGGER private_offer_commitment_immutable BEFORE UPDATE OF commitment,binding_json,invite_id,revision ON private_sealed_offers BEGIN SELECT RAISE(ABORT,'Preserve sealed offer identity and commitment.'); END;
CREATE TRIGGER private_round_commitment_immutable BEFORE UPDATE OF commitment,binding_json,mandate_id,sequence,actor_user_id,actor_role ON private_negotiation_rounds BEGIN SELECT RAISE(ABORT,'Preserve negotiated round identity and commitment.'); END;
CREATE TRIGGER private_mandate_terms_immutable BEFORE UPDATE OF invite_id,terms_ciphertext,terms_hash,proposed_by ON private_negotiation_mandates BEGIN SELECT RAISE(ABORT,'A changed mandate requires new independent authorization.'); END;
CREATE TRIGGER private_agreement_event_immutable BEFORE UPDATE ON private_agreement_events BEGIN SELECT RAISE(ABORT,'Preserve private agreement decisions.'); END;
CREATE TRIGGER private_agreement_event_no_delete BEFORE DELETE ON private_agreement_events BEGIN SELECT RAISE(ABORT,'Preserve private agreement decisions.'); END;

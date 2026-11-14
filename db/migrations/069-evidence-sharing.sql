CREATE TABLE evidence_shares (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), created_by TEXT NOT NULL REFERENCES users(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('invoice_analysis','finance_proposal','payment_evidence')), source_id TEXT,
 disclosure TEXT NOT NULL CHECK(disclosure IN ('metadata','encrypted_wire')), token_hash TEXT NOT NULL UNIQUE,
 request_key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 packet_ciphertext TEXT, packet_sha256 TEXT NOT NULL, packet_bytes INTEGER NOT NULL CHECK(packet_bytes BETWEEN 1 AND 8388608),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','deleted','expired','source_unavailable')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, source_expires_at TEXT NOT NULL, revoked_at TEXT, deleted_at TEXT,
 CHECK(status!='active' OR (packet_ciphertext IS NOT NULL AND source_id IS NOT NULL)),
 CHECK(created_at < expires_at AND expires_at <= source_expires_at), UNIQUE(organization_id,created_by,request_key_hash)
);
CREATE INDEX evidence_share_company_history ON evidence_shares(organization_id,created_at,id);
CREATE INDEX evidence_share_expiry ON evidence_shares(status,expires_at);
CREATE TRIGGER evidence_share_terms_immutable BEFORE UPDATE ON evidence_shares
WHEN NEW.id!=OLD.id OR NEW.organization_id!=OLD.organization_id OR NEW.created_by!=OLD.created_by OR NEW.source_kind!=OLD.source_kind
 OR NEW.disclosure!=OLD.disclosure OR NEW.token_hash!=OLD.token_hash OR NEW.request_key_hash!=OLD.request_key_hash OR NEW.request_hash!=OLD.request_hash
 OR NEW.packet_sha256!=OLD.packet_sha256 OR NEW.packet_bytes!=OLD.packet_bytes OR NEW.created_at!=OLD.created_at OR NEW.expires_at!=OLD.expires_at OR NEW.source_expires_at!=OLD.source_expires_at
 OR (NEW.source_id IS NOT OLD.source_id AND NOT (NEW.status='deleted' AND NEW.source_id IS NULL))
 OR (NEW.packet_ciphertext IS NOT OLD.packet_ciphertext AND NEW.packet_ciphertext IS NOT NULL)
 OR (OLD.status!='active' AND NEW.status NOT IN (OLD.status,'deleted'))
BEGIN SELECT RAISE(ABORT,'EVIDENCE_SHARE_IMMUTABLE'); END;
CREATE TRIGGER evidence_share_delete_protected BEFORE DELETE ON evidence_shares BEGIN SELECT RAISE(ABORT,'EVIDENCE_SHARE_REPLAY_PROTECTED'); END;
CREATE TABLE evidence_share_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, share_id TEXT NOT NULL REFERENCES evidence_shares(id),
 actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, request_key_hash TEXT, request_hash TEXT, created_at TEXT NOT NULL,
 UNIQUE(share_id,actor_id,request_key_hash)
);
CREATE TRIGGER evidence_share_event_update_protected BEFORE UPDATE ON evidence_share_events BEGIN SELECT RAISE(ABORT,'EVIDENCE_SHARE_EVENT_IMMUTABLE'); END;
CREATE TRIGGER evidence_share_event_delete_protected BEFORE DELETE ON evidence_share_events BEGIN SELECT RAISE(ABORT,'EVIDENCE_SHARE_EVENT_IMMUTABLE'); END;

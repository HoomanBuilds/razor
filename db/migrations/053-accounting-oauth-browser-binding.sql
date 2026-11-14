ALTER TABLE accounting_oauth_states ADD COLUMN browser_nonce_hash TEXT;
ALTER TABLE accounting_oauth_states ADD COLUMN initiating_session_id TEXT;
UPDATE accounting_oauth_states SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE (browser_nonce_hash IS NULL OR initiating_session_id IS NULL) AND consumed_at IS NULL;

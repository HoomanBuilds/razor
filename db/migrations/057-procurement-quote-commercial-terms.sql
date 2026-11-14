ALTER TABLE procurement_quotes ADD COLUMN commercial_version INTEGER NOT NULL DEFAULT 1 CHECK(commercial_version IN (1,2));
ALTER TABLE procurement_quotes ADD COLUMN commercial_terms_ciphertext TEXT;

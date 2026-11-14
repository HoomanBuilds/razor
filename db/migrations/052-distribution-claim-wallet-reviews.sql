ALTER TABLE claim_distribution_allocations ADD COLUMN review_generation TEXT;
ALTER TABLE claim_distribution_allocations ADD COLUMN review_hash TEXT;
ALTER TABLE claim_distribution_allocations ADD COLUMN review_expires_at TEXT;
ALTER TABLE claim_distribution_allocations ADD COLUMN review_consumed INTEGER NOT NULL DEFAULT 0 CHECK(review_consumed IN (0,1));
ALTER TABLE claim_distribution_allocations ADD COLUMN wallet_lease_generation TEXT;
ALTER TABLE claim_distribution_allocations ADD COLUMN wallet_lease_expires_at TEXT;

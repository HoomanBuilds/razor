ALTER TABLE organization_roles ADD COLUMN archived_at TEXT;

CREATE TABLE organization_invitations_next (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT,
  wallet_family TEXT CHECK(wallet_family IN ('near', 'evm', 'solana')),
  wallet_address TEXT,
  wallet_network TEXT,
  role_id TEXT NOT NULL REFERENCES organization_roles(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (email IS NOT NULL AND wallet_family IS NULL AND wallet_address IS NULL AND wallet_network IS NULL)
    OR (email IS NULL AND wallet_family IS NOT NULL AND wallet_address IS NOT NULL AND wallet_network IS NOT NULL)
  )
);

INSERT INTO organization_invitations_next
  (id,organization_id,email,role_id,token_hash,created_by,expires_at,accepted_at,revoked_at,created_at)
SELECT id,organization_id,email,role_id,token_hash,created_by,expires_at,accepted_at,revoked_at,created_at
FROM organization_invitations;

DROP TABLE organization_invitations;
ALTER TABLE organization_invitations_next RENAME TO organization_invitations;

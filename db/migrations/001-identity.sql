CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE user_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  organization_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  address TEXT NOT NULL,
  network TEXT NOT NULL,
  message TEXT NOT NULL,
  nonce TEXT NOT NULL,
  recipient TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE linked_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  family TEXT NOT NULL,
  address TEXT NOT NULL,
  network TEXT NOT NULL,
  public_key TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(family, address, network)
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  settlement_asset TEXT NOT NULL DEFAULT 'USDC',
  owner_id TEXT NOT NULL REFERENCES users(id),
  paused INTEGER NOT NULL DEFAULT 0,
  treasury_account_id TEXT,
  near_network TEXT NOT NULL DEFAULT 'testnet',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE organization_roles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, name)
);

CREATE TABLE memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES organization_roles(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  PRIMARY KEY(organization_id, user_id)
);

CREATE TABLE organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES organization_roles(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE recipients (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT,
  kind TEXT NOT NULL,
  primary_asset TEXT NOT NULL DEFAULT 'USDC',
  primary_network TEXT NOT NULL,
  primary_address TEXT NOT NULL,
  backup_network TEXT,
  backup_address TEXT,
  fallback_consent INTEGER NOT NULL DEFAULT 0,
  preference_status TEXT NOT NULL DEFAULT 'pending_confirmation',
  version INTEGER NOT NULL DEFAULT 1,
  invitation_token_hash TEXT UNIQUE,
  invitation_expires_at TEXT,
  confirmed_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipient_versions (
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  version INTEGER NOT NULL,
  profile_ciphertext TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(recipient_id, version)
);

CREATE TABLE identity_audit (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX membership_user_idx ON memberships(user_id, status);
CREATE INDEX recipient_org_idx ON recipients(organization_id);
CREATE INDEX session_expiry_idx ON sessions(expires_at);
CREATE INDEX challenge_expiry_idx ON auth_challenges(expires_at);

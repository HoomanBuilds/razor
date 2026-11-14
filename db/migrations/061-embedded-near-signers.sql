CREATE TABLE embedded_near_accounts (
  user_id TEXT NOT NULL REFERENCES users(id),
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  provider_subject TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  public_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  linked_wallet_id TEXT REFERENCES linked_wallets(id) ON DELETE SET NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, network),
  UNIQUE (network, account_id)
);

CREATE TABLE embedded_near_transactions (
  transaction_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  network TEXT NOT NULL,
  account_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unresolved', 'succeeded', 'failed')),
  created_at TEXT NOT NULL,
  observed_at TEXT,
  PRIMARY KEY (network, transaction_hash)
);
CREATE INDEX embedded_near_transactions_user ON embedded_near_transactions(user_id, network, status, created_at);

CREATE TABLE treasury_config_shared (
  organization_id TEXT PRIMARY KEY,
  near_account_id TEXT NOT NULL,
  network TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  architecture TEXT NOT NULL DEFAULT 'isolated_v1' CHECK(architecture IN ('isolated_v1','shared_v1')),
  company_id TEXT,
  created_at TEXT NOT NULL,
  CHECK((architecture='isolated_v1' AND company_id IS NULL) OR (architecture='shared_v1' AND company_id IS NOT NULL AND substr(company_id,1,length(organization_id)+1)=organization_id||':' AND length(company_id)=length(organization_id)+17 AND substr(company_id,-16) NOT GLOB '*[^a-f0-9]*')),
  UNIQUE(network,near_account_id,company_id)
);
INSERT INTO treasury_config_shared(organization_id,near_account_id,network,token_contract,created_at)
SELECT organization_id,near_account_id,network,token_contract,created_at FROM treasury_config;
DROP TABLE treasury_config;
ALTER TABLE treasury_config_shared RENAME TO treasury_config;
CREATE UNIQUE INDEX treasury_isolated_account ON treasury_config(network,near_account_id) WHERE architecture='isolated_v1';
CREATE TABLE clearing_companies_shared (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  treasury_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
  token_contract TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO clearing_companies_shared SELECT * FROM clearing_companies;
DROP TABLE clearing_companies;
ALTER TABLE clearing_companies_shared RENAME TO clearing_companies;
CREATE TABLE shared_refund_receipts (
  network TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  data_index INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  commitment TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(network,token_contract,receipt_id,log_index,data_index)
);

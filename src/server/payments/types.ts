export interface RecipientSnapshot {
  id: string;
  primary_asset: string;
  primary_network: string;
  primary_address: string;
  backup_network: string | null;
  backup_address: string | null;
  fallback_consent: number;
  version: number;
  preference_status?: string;
  confirmed_at?: string | null;
  archived?: number;
}

export interface Payment {
  id: string;
  organization_id: string;
  recipient_id: string;
  kind: string;
  reference: string;
  amount: string;
  max_fee: string;
  status: string;
  scheduled_for: string | null;
  recipient_version: number;
  recipient_snapshot: string;
  metadata: string;
  approved_by: string | null;
  approved_at: string | null;
  reserved_amount: string;
  total_spent: string;
  delivered_amount: string;
  hold_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayoutAttempt {
  id: string;
  payment_id: string;
  organization_id: string;
  route: string;
  state: string;
  quote: string;
  destination_asset: string;
  destination_network: string;
  destination_address: string;
  destination_decimals?: number | null;
  destination_symbol?: string | null;
  expected_output: string;
  amount_in: string;
  deposit_address: string;
  deposit_memo: string | null;
  source_tx_hash: string | null;
  destination_tx_hash: string | null;
  refund_tx_hash: string | null;
  provider_status: string | null;
  reconciliation: string | null;
  created_at: string;
  updated_at: string;
}

export interface FundingLeg {
  id: string;
  organization_id: string;
  payment_id: string | null;
  reference: string;
  origin_asset: string;
  origin_network?: string | null;
  origin_decimals?: number | null;
  origin_symbol?: string | null;
  amount_in: string;
  expected_output: string;
  quote: string;
  deposit_address: string;
  deposit_memo: string | null;
  recipient_address: string;
  status: string;
  source_tx_hash: string | null;
  destination_tx_hash: string | null;
  provider_status: string | null;
  credited_amount: string;
  created_at: string;
  updated_at: string;
}

export interface TreasuryConfig {
  organization_id: string;
  near_account_id: string;
  network: "mainnet" | "testnet";
  token_contract: string;
}

export interface ChainAttempt {
  id: string;
  status: string;
  authorized: boolean;
  approvals: string[];
  approval_policy_version: string;
  use_backup: boolean;
  route: { kind: string; source_receiver: string; input_amount: string; output_amount: string; quote_id: string; quote_hash: string; deadline_ms: string };
  refund_amount: string;
  receipt: string | null;
}

export interface ChainPayment {
  id: string;
  reference: string;
  recipient_id: string;
  amount: string;
  max_fee: string;
  reservation: string;
  incurred_cost: string;
  expires_at_ms: string;
  not_before_ms: string;
  recipient_version: string;
  policy_version: string;
  approvals: string[];
  status: string;
  attempts: ChainAttempt[];
}

export interface WalletTransaction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: unknown; gas: string; deposit: string } }[];
}

export interface ApprovalTier { up_to: string; required_approvals: number }
export interface ApprovalStatus {
  policy_version: string;
  approval_amount: string;
  required_approvals: number;
  payment_terms_hash: string;
  payment_approvals: string[];
  payment_collected: number;
  payment_ready: boolean;
  attempt_id: string | null;
  attempt_terms_hash: string | null;
  attempt_approvals: string[];
  attempt_collected: number;
  attempt_ready: boolean;
  can_execute: boolean;
}

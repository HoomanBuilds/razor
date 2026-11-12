import type { Token } from "../payments/intents";

export interface FundingRequestRecord {
  id: string; organization_id: string; amount: string; purpose_ciphertext: string; expires_at: string;
  token_hash: string; capability_id: string; payment_id: string | null; treasury_account_id: string;
  treasury_owner_id: string; token_contract: string; network: "mainnet" | "testnet";
  status: string; revoked_at: string | null; fulfilled_at: string | null;
  created_by: string; created_at: string; updated_at: string;
}
export interface RequestQuote {
  id: string; request_id: string; key_hash: string; actor_id: string; origin_asset: string;
  origin_token_json: string | null; refund_address: string; requested_output: string;
  funding_id: string | null; state: string; reservation_owner: string | null;
  lease_expires_at: string | null; created_at: string; updated_at: string;
}
export interface PublicFundingLeg {
  id: string; origin_asset: string; amount_in: string; expected_output: string;
  deposit_address: string; deposit_memo: string | null; quote: string;
  status: string; source_tx_hash: string | null;
}
export interface PublicFundingRequest {
  id: string; companyName: string; amount: string; purpose: string; expiresAt: string;
  confirmedAmount: string; remainingAmount: string; status: string;
  activeFunding: { id: string | null; status: string } | null;
}
export interface PublicQuoteResult {
  funding: PublicFundingLeg; token: Token; request: PublicFundingRequest;
}

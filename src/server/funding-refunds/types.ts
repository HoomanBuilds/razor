import type { Token } from "../payments/intents";

export interface RefundInput { transactionHash: string; senderAccountId?: string; sourceTransactionHash?: string }
export interface RefundTerms {
  fundingId: string;
  quoteHash: string;
  source: Token;
  refundTo: string;
  refundedAmount: string;
  reportedDepositedAmount: string | null;
  transactionHash: string;
  senderAccountId: string | null;
  sourceTransactionHash: string | null;
  providerCorrelationId: string;
  providerStatus: "REFUNDED";
}
export interface RefundProof {
  provenance: "final_chain_receipt" | "funder_or_reporter_attestation";
  network: string;
  transactionHash: string;
  amount: string;
  receiver: string;
  eventKeys: string[];
  detail: Record<string, unknown>;
  reason?: string;
}
export interface RefundReview {
  reviewId: string;
  reviewToken: string;
  expiresAt: string;
  terms: RefundTerms;
  proof: RefundProof;
  requiresAttestation: boolean;
  message: string;
}

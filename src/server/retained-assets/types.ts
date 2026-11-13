import type { WalletTransaction } from "../payments/types";

export interface RetainedAsset {
  token_contract: string;
  asset_id: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
  balance: string;
  in_flight: string;
  balance_epoch: string;
  confirmed_at_ms: string;
  withdrawal: { id: string; receiver_id: string; amount: string; status: "pending" | "succeeded" | "failed"; receipt: string | null } | null;
}
export interface TokenMetadata { spec: string; name: string; symbol: string; decimals: number }
export interface RetainedPreview {
  kind: "allow" | "deposit" | "withdraw" | "refresh" | "recovery";
  network: "mainnet" | "testnet";
  signerAccount: string;
  tokenContract: string;
  assetId: string;
  symbol: string;
  decimals: number;
  amount?: string;
  receiver?: string;
  enabled?: boolean;
  expiresAt: string;
  message: string;
  walletActions: WalletTransaction[];
  instructions?: { method: "ft_transfer_call"; receiver_id: string; amount: string; msg: string; attachedYoctoNear: "1"; gas: string };
}

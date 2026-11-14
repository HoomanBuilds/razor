export type EmbeddedNearNetwork = "mainnet" | "testnet";
export interface EmbeddedNearBinding {
  network: EmbeddedNearNetwork;
  providerSubject: string;
  walletAddress: string;
  publicKey: string;
  accountId: string;
  linkedWalletId: string | null;
  generation: number;
  disabled: boolean;
}
export interface EmbeddedNearTransaction {
  hash: string;
  receiverId: string;
  status: "unresolved" | "succeeded" | "failed";
  createdAt: string;
  observedAt: string | null;
}
export interface EmbeddedNearSetup {
  available: boolean;
  network: EmbeddedNearNetwork;
  binding: EmbeddedNearBinding | null;
  chain: {
    status: "unfunded" | "owner_key_ready" | "key_unavailable" | "unavailable";
    nativeBalance: string | null;
    nativeAvailable: string | null;
    storageUsage: number | null;
    storageByteCost: string | null;
    gasPrice: string | null;
    blockHeight: number | null;
  } | null;
  transactions: EmbeddedNearTransaction[];
  sponsored: false;
}

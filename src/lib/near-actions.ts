"use client";

import { api, RequestError } from "./api";

export interface NearWalletAction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[];
}

export async function signNearActions(transactions: NearWalletAction[], expectedNetwork?: string): Promise<string | null> {
  if (!transactions.length) return null;
  const config = await api<{ nearNetwork: "mainnet" | "testnet" }>("/auth/config");
  if (expectedNetwork && config.nearNetwork !== expectedNetwork) throw new RequestError(`This treasury uses NEAR ${expectedNetwork}, while the signer is configured for ${config.nearNetwork}. Use the matching NEAR network before authorizing.`, 409, "SIGNER_NETWORK_MISMATCH");
  const { connectNearWallet } = await import("@/components/auth/wallets");
  const { wallet } = await connectNearWallet();
  const outcomes = await wallet.signAndSendTransactions({ transactions, network: config.nearNetwork });
  const last = outcomes.at(-1);
  if (!last) throw new RequestError("No execution receipt was returned. Reconcile the action before retrying.", 409, "RECEIPT_REQUIRED");
  if (outcomes.some((outcome) => typeof outcome.status === "object" && "Failure" in outcome.status)) throw new RequestError("A NEAR authorization step failed. Refresh the recorded state before resuming.", 409, "AUTHORIZATION_FAILED");
  return last.transaction.hash;
}

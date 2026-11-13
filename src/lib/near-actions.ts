"use client";

import { api, RequestError } from "./api";

export interface NearWalletAction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[];
}

export async function signNearActions(transactions: NearWalletAction[], expectedNetwork?: string, eligibleSigners?: readonly string[]): Promise<string | null> {
  if (!transactions.length) return null;
  const config = await api<{ nearNetwork: "mainnet" | "testnet" }>("/auth/config");
  if (expectedNetwork && config.nearNetwork !== expectedNetwork) throw new RequestError(`This treasury uses NEAR ${expectedNetwork}, while the signer is configured for ${config.nearNetwork}. Use the matching NEAR network before authorizing.`, 409, "SIGNER_NETWORK_MISMATCH");
  const { connectNearWallet } = await import("@/components/auth/wallets");
  if (eligibleSigners && !eligibleSigners.length) throw new RequestError("Link an authorized NEAR signing wallet before continuing.", 403, "SIGNER_ACCOUNT_REQUIRED");
  let connection = await connectNearWallet();
  if (eligibleSigners && !connection.accounts.some(account => eligibleSigners.includes(account.accountId))) connection = await connectNearWallet({ chooseWallet: true });
  const signer = connection.accounts.find(account => !eligibleSigners || eligibleSigners.includes(account.accountId))?.accountId;
  if (!signer) throw new RequestError("Connect one of the verified NEAR accounts authorized for this exact action.", 403, "SIGNER_ACCOUNT_MISMATCH");
  const outcomes = await connection.wallet.signAndSendTransactions({ transactions: transactions.map(transaction => ({ ...transaction, signerId: signer })), signerId: signer, network: config.nearNetwork });
  const last = outcomes.at(-1);
  if (!last) throw new RequestError("No execution receipt was returned. Reconcile the action before retrying.", 409, "RECEIPT_REQUIRED");
  if (outcomes.some(outcome => outcome.transaction.signer_id !== signer)) throw new RequestError("The wallet returned a receipt for another signer. Reconcile the recorded action before retrying.", 409, "SIGNER_ACCOUNT_MISMATCH");
  if (outcomes.some((outcome) => typeof outcome.status === "object" && "Failure" in outcome.status)) throw new RequestError("A NEAR authorization step failed. Refresh the recorded state before resuming.", 409, "AUTHORIZATION_FAILED");
  return last.transaction.hash;
}

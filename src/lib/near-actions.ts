"use client";

import { RequestError } from "./api";

export interface NearWalletAction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[];
}

export async function signNearActions(transactions: NearWalletAction[]): Promise<string | null> {
  if (!transactions.length) return null;
  const { connectNearWallet } = await import("@/components/auth/wallets");
  const { wallet } = await connectNearWallet();
  const outcomes = await wallet.signAndSendTransactions({ transactions });
  const last = outcomes.at(-1);
  if (!last) throw new RequestError("No execution receipt was returned. Reconcile the action before retrying.", 409, "RECEIPT_REQUIRED");
  if (outcomes.some((outcome) => typeof outcome.status === "object" && "Failure" in outcome.status)) throw new RequestError("A NEAR authorization step failed. Refresh the recorded state before resuming.", 409, "AUTHORIZATION_FAILED");
  return last.transaction.hash;
}

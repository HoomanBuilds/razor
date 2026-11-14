"use client";

import { api, RequestError } from "./api";

export interface NearWalletAction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[];
}

export interface NearBatchResult {
  signerAccount: string;
  receipts: { index: number; hash: string; succeeded: boolean }[];
  complete: boolean;
}

export function nearBatchReceipts(transactions: readonly NearWalletAction[], signer: string, outcomes: readonly unknown[]): NearBatchResult["receipts"] {
  const used = new Set<number>();
  return outcomes.flatMap(value => {
    const outcome = value as { transaction?: { signer_id?: string; hash?: string; receiver_id?: string; actions?: { FunctionCall?: { method_name: string; args: string } }[] }; status?: unknown };
    const actual = outcome?.transaction;
    if (actual?.signer_id !== signer || !actual.hash) return [];
    const index = transactions.findIndex((transaction, candidate) => !used.has(candidate) && transaction.receiverId === actual.receiver_id && transaction.actions.length === actual.actions?.length && transaction.actions.every((action, actionIndex) => {
      const recorded = actual.actions?.[actionIndex].FunctionCall;
      try { return !!recorded && recorded.method_name === action.params.methodName && JSON.stringify(JSON.parse(atob(recorded.args))) === JSON.stringify(action.params.args); } catch { return false; }
    }));
    if (index < 0) return [];
    used.add(index);
    return [{ index, hash: actual.hash, succeeded: !!outcome.status && typeof outcome.status === "object" && "SuccessValue" in outcome.status }];
  });
}

export async function signNearActionBatch(transactions: NearWalletAction[], expectedNetwork: string, eligibleSigners: readonly string[], beforeSend: (signer: string) => Promise<void>): Promise<NearBatchResult> {
  if (!transactions.length || transactions.length > 8) throw new RequestError("Review between one and eight wallet transactions.", 409, "BATCH_LIMIT_INVALID");
  const config = await api<{ nearNetwork: "mainnet" | "testnet" }>("/auth/config");
  if (config.nearNetwork !== expectedNetwork) throw new RequestError(`This treasury uses NEAR ${expectedNetwork}. Select the matching signer network before continuing.`, 409, "SIGNER_NETWORK_MISMATCH");
  if (!eligibleSigners.length) throw new RequestError("Link an authorized NEAR signing wallet before continuing.", 403, "SIGNER_ACCOUNT_REQUIRED");
  const { connectNearWallet } = await import("@/components/auth/wallets");
  let connection = await connectNearWallet();
  if (!connection.accounts.some(account => eligibleSigners.includes(account.accountId))) connection = await connectNearWallet({ chooseWallet: true });
  const signer = connection.accounts.find(account => eligibleSigners.includes(account.accountId))?.accountId;
  if (!signer) throw new RequestError("Connect one of the verified accounts eligible for every reviewed action.", 403, "SIGNER_ACCOUNT_MISMATCH");
  if (transactions.length > 1 && !connection.wallet.manifest.features.signAndSendTransactions) throw new RequestError("This wallet supports one transaction at a time. Cancel this unsigned group, select the single transaction option, and resume the same routes.", 409, "WALLET_BATCH_UNSUPPORTED");
  if (transactions.length === 1 && !connection.wallet.manifest.features.signAndSendTransaction) throw new RequestError("Choose a wallet that supports a single NEAR transaction before continuing.", 409, "WALLET_TRANSACTION_UNSUPPORTED");
  await beforeSend(signer);
  const outcomes = transactions.length === 1
    ? [await connection.wallet.signAndSendTransaction({ ...transactions[0], signerId: signer, network: config.nearNetwork })]
    : await connection.wallet.signAndSendTransactions({ transactions: transactions.map(transaction => ({ ...transaction, signerId: signer })), signerId: signer, network: config.nearNetwork });
  const receipts = nearBatchReceipts(transactions, signer, outcomes);
  return { signerAccount: signer, receipts, complete: receipts.length === transactions.length && receipts.every(receipt => receipt.succeeded) };
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

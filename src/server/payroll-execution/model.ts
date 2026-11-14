import { ApiError } from "../context";
import type { WalletTransaction } from "../payments/types";

export type ExecutionStage = "prepare" | "approve" | "execute" | "close";
export const BATCH_LIMITS = { lines: 5, transactions: 8, gasPerTransaction: "300000000000000", gasPerBatch: "800000000000000", bytesPerTransaction: 12_000 } as const;

export function boundedTransactions(transactions: WalletTransaction[], maximum: number = BATCH_LIMITS.transactions) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > BATCH_LIMITS.transactions) throw new ApiError(422, "Choose one to eight wallet transactions", "BATCH_LIMIT_INVALID");
  let gas = 0n;
  const accepted: WalletTransaction[] = [];
  for (const transaction of transactions) {
    const attached = transaction.actions.reduce((sum, action) => sum + BigInt(action.params.gas), 0n);
    if (!transaction.actions.length || attached <= 0n || attached > BigInt(BATCH_LIMITS.gasPerTransaction) || Buffer.byteLength(JSON.stringify(transaction)) > BATCH_LIMITS.bytesPerTransaction) throw new ApiError(409, "A wallet transaction exceeds the conservative gas or size limit", "TRANSACTION_LIMIT_EXCEEDED");
    if (accepted.length === maximum || gas + attached > BigInt(BATCH_LIMITS.gasPerBatch)) break;
    accepted.push(transaction);
    gas += attached;
  }
  return { transactions: accepted, gas: gas.toString(), remaining: transactions.length - accepted.length };
}

export function intersectSigners(accounts: readonly (readonly string[])[]) {
  return accounts.length ? [...new Set(accounts[0])].filter(account => accounts.every(list => list.includes(account))).sort() : [];
}

import { atomic } from "../../lib/money";
import { ApiError } from "../context";
import type { Payment, PayoutAttempt, RecipientSnapshot } from "./types";

export const BACKUP_NETWORKS = ["base", "arb", "pol", "sol", "eth", "near"] as const;

export const NATIVE_USDC: Record<string, string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  arb: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  pol: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  eth: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  sol: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  near: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
};

export function canUseBackup(payment: Payment, recipient: RecipientSnapshot, attempts: PayoutAttempt[]): void {
  if (!recipient.fallback_consent || !recipient.backup_network || !recipient.backup_address) throw new ApiError(409, "The recipient has not confirmed a USDC backup", "BACKUP_NOT_CONFIRMED");
  if (!BACKUP_NETWORKS.includes(recipient.backup_network as typeof BACKUP_NETWORKS[number])) throw new ApiError(409, "The backup network is not enabled", "BACKUP_NETWORK_DISABLED");
  if (recipient.preference_status !== "confirmed" || !recipient.confirmed_at) throw new ApiError(409, "The recipient must confirm their payout preferences", "PREFERENCES_UNCONFIRMED");
  if (recipient.backup_network === recipient.primary_network && recipient.backup_address === recipient.primary_address && recipient.primary_asset === "USDC") throw new ApiError(409, "Choose a distinct backup destination", "BACKUP_DUPLICATE");
  if (payment.status === "paid" || atomic(payment.delivered_amount, true) > 0n) throw new ApiError(409, "Delivery must be reconciled before a further payout", "DELIVERY_ALREADY_RECORDED");
  if (attempts.some((attempt) => !["cancelled", "closed_unfunded", "refunded_verified"].includes(attempt.state))) throw new ApiError(409, "A previous attempt may still deliver. Reconcile it before using backup", "PRIOR_ATTEMPT_UNRESOLVED");
}

export function checkBudget(payment: Pick<Payment, "amount" | "max_fee" | "total_spent">, input: string): void {
  if (atomic(input) + atomic(payment.total_spent, true) > atomic(payment.amount) + atomic(payment.max_fee, true)) throw new ApiError(409, "The quote exceeds the approved total payment cost", "COST_LIMIT_EXCEEDED");
}

export function providerOutcome(status: string): string {
  if (status === "SUCCESS") return "reported_delivered";
  if (status === "REFUNDED" || status === "FAILED" || status === "INCOMPLETE_DEPOSIT") return "recovery_pending";
  if (["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING"].includes(status)) return "processing";
  return "unknown";
}

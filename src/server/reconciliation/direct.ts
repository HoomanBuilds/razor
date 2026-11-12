import { quoteDepositWindow, type QuoteResponse } from "../payments/intents";
import type { ChainPayment, PayoutAttempt } from "../payments/types";

export interface DirectExecution {
  kind: "direct";
  network: "near";
  assetId: string;
  recipient: string;
  amountIn: string;
  amountOut: string;
  deadline: string;
  authorization: "NEAR treasury approval";
}

export type ExecutionRecord = QuoteResponse | DirectExecution;

export function isDirectExecution(value: unknown): value is DirectExecution {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === "direct" && record.network === "near" && record.authorization === "NEAR treasury approval" && !record.quoteRequest && [record.assetId, record.recipient, record.amountIn, record.amountOut, record.deadline].every((field) => typeof field === "string");
}

export function executionTerms(record: ExecutionRecord) {
  return isDirectExecution(record)
    ? { kind: "direct" as const, sourceReceiver: record.recipient, amountIn: record.amountIn, amountOut: record.amountOut, deadline: record.deadline, quoteId: "direct" }
    : { kind: "intents" as const, sourceReceiver: record.quote.depositAddress!, amountIn: record.quote.amountIn, amountOut: record.quote.amountOut, deadline: new Date(quoteDepositWindow(record).startBefore).toISOString(), quoteId: record.correlationId };
}

export function hasProvenPrimaryFailure(attempt: PayoutAttempt): boolean {
  if (attempt.route !== "primary" || !attempt.reconciliation) return false;
  try {
    const evidence = JSON.parse(attempt.reconciliation) as { chain?: ChainPayment };
    return evidence.chain?.attempts.some((item) => item.id === attempt.id && ["refunded", "transfer_failed"].includes(item.status)) ?? false;
  } catch { return false; }
}

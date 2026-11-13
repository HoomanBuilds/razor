import { ApiError } from "../context";
import type { FinalTransaction, NearAction } from "../payments/near";
import type { TreasuryConfig } from "../payments/types";
import type { RetainedAsset } from "./types";

function args(action: NearAction, method: string): Record<string, unknown> | null {
  if (action.FunctionCall?.method_name !== method) return null;
  try { return JSON.parse(Buffer.from(action.FunctionCall.args, "base64").toString()); } catch { return null; }
}
function events(logs: string[]) {
  return logs.filter(log => log.startsWith("EVENT_JSON:")).flatMap(log => {
    try {
      const value = JSON.parse(log.slice(11));
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return [{ ...value, data: Array.isArray(value.data) ? value.data.filter((entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)) : [] }];
    } catch { return []; }
  });
}

export function inspectRetainedWithdrawal(result: FinalTransaction, config: TreasuryConfig, asset: RetainedAsset) {
  const withdrawal = asset.withdrawal;
  if (!withdrawal || withdrawal.status !== "pending" || asset.in_flight !== withdrawal.amount) throw new ApiError(409, "No matching retained withdrawal is unresolved", "RETAINED_RECOVERY_NOT_REQUIRED");
  if (result.final_execution_status !== "FINAL" || !result.transaction?.hash || !result.transaction.signer_id) throw new ApiError(409, "Wait for the original retained withdrawal transaction to become final", "RECEIPT_NOT_FINAL");
  const matches = (action: NearAction) => { const value = args(action, "withdraw_retained_asset"); return value?.token_contract === asset.token_contract && value.receiver_id === withdrawal.receiver_id && value.amount === withdrawal.amount && (config.architecture !== "shared_v1" || value.company_id === config.company_id); };
  const executionIds = new Set(result.receipts?.filter(receipt => receipt.receiver_id === config.near_account_id && receipt.receipt?.Action?.actions.some(matches)).map(receipt => receipt.receipt_id) ?? []);
  if (result.transaction.receiver_id === config.near_account_id && result.transaction.actions?.some(matches)) for (const id of result.transaction_outcome?.outcome.receipt_ids ?? []) executionIds.add(id);
  const sources = new Set(result.receipts_outcome?.filter(item => executionIds.has(item.id) && item.outcome.executor_id === config.near_account_id && !item.outcome.status.Failure && events(item.outcome.logs).some(event => event.standard === "razor" && event.event === "retained_withdrawal_started" && Array.isArray(event.data) && event.data.some((entry: Record<string, unknown>) => entry.token_contract === asset.token_contract && entry.withdrawal_id === withdrawal.id && entry.amount === withdrawal.amount && entry.receiver_id === withdrawal.receiver_id))).flatMap(item => item.outcome.receipt_ids ?? []) ?? []);
  if (!sources.size) throw new ApiError(409, "The final transaction is not bound to this retained withdrawal ID", "RETAINED_SOURCE_UNBOUND");
  const receipts = result.receipts?.filter(receipt => sources.has(receipt.receipt_id) && receipt.receiver_id === asset.token_contract && receipt.predecessor_id === config.near_account_id && receipt.receipt?.Action?.actions.some(action => { const value = args(action, "ft_transfer"); return value?.receiver_id === withdrawal.receiver_id && value.amount === withdrawal.amount && value.memo === `Razor retained withdrawal ${withdrawal.id}`; })) ?? [];
  if (receipts.length !== 1) throw new ApiError(409, "A single matching retained-token transfer receipt is required", "RETAINED_SOURCE_UNPROVEN");
  const receipt = receipts[0], outcome = result.receipts_outcome?.find(item => item.id === receipt.receipt_id && item.outcome.executor_id === asset.token_contract)?.outcome;
  if (!outcome) throw new ApiError(409, "The token transfer receipt has no conclusive final outcome", "RETAINED_SOURCE_UNPROVEN");
  let succeeded = false;
  if ("SuccessValue" in outcome.status) {
    succeeded = events(outcome.logs).some(event => event.standard === "nep141" && event.event === "ft_transfer" && Array.isArray(event.data) && event.data.some((entry: Record<string, unknown>) => entry.old_owner_id === config.near_account_id && entry.new_owner_id === withdrawal.receiver_id && entry.amount === withdrawal.amount));
    if (!succeeded) throw new ApiError(409, "The successful receipt lacks its matching token-transfer event", "RETAINED_SOURCE_UNPROVEN");
  } else if (!("Failure" in outcome.status)) throw new ApiError(409, "The retained withdrawal may still execute. Do not retry it", "RETAINED_SOURCE_UNPROVEN");
  return { transactionHash: result.transaction.hash, senderAccountId: result.transaction.signer_id, tokenReceiptId: receipt.receipt_id, succeeded, finality: "FINAL" as const, tokenContract: asset.token_contract, amount: withdrawal.amount, receiverId: withdrawal.receiver_id, withdrawalId: withdrawal.id };
}

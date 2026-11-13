import { ApiError, requirePermission, type AccessContext } from "../context";
import { createHash } from "node:crypto";
import { getDb, row } from "../db";
import { nearTransactionStatus, view, type FinalTransaction, type NearAction } from "../payments/near";
import { getAttempt, getPayment } from "../payments/service";
import type { ChainAttempt, ChainPayment, TreasuryConfig, WalletTransaction } from "../payments/types";

function args(action: NearAction, method: string): Record<string, unknown> | null {
  if (action.FunctionCall?.method_name !== method) return null;
  try { return JSON.parse(Buffer.from(action.FunctionCall.args, "base64").toString()); } catch { return null; }
}

export function inspectSourceTransfer(result: FinalTransaction, config: TreasuryConfig, paymentId: string, attempt: ChainAttempt) {
  if (result.final_execution_status !== "FINAL") throw new ApiError(409, "Wait for the original source transaction to become final", "RECEIPT_NOT_FINAL");
  const matchesExecution = (action: NearAction) => { const value = args(action, "execute_payment"); return value?.payment_id === paymentId && value.attempt_id === attempt.id; };
  const executionIds = new Set(result.receipts?.filter((receipt) => receipt.receiver_id === config.near_account_id && receipt.receipt?.Action?.actions.some(matchesExecution)).map((receipt) => receipt.receipt_id) ?? []);
  if (result.transaction?.receiver_id === config.near_account_id && result.transaction.actions?.some(matchesExecution)) for (const receiptId of result.transaction_outcome?.outcome.receipt_ids ?? []) executionIds.add(receiptId);
  const sourceIds = new Set(result.receipts_outcome?.filter((outcome) => executionIds.has(outcome.id) && outcome.outcome.executor_id === config.near_account_id && !("Failure" in outcome.outcome.status)).flatMap((outcome) => outcome.outcome.receipt_ids ?? []) ?? []);
  if (!sourceIds.size) throw new ApiError(409, "The source transaction is not bound to this payment attempt", "SOURCE_EXECUTION_UNBOUND");
  const receipts = result.receipts?.filter((receipt) => sourceIds.has(receipt.receipt_id) && receipt.receiver_id === config.token_contract && receipt.predecessor_id === config.near_account_id && receipt.receipt?.Action?.actions.some((action) => { const value = args(action, "ft_transfer"); return value?.receiver_id === attempt.route.source_receiver && value.amount === attempt.route.input_amount; })) ?? [];
  if (receipts.length !== 1) throw new ApiError(409, "A single matching treasury token transfer receipt is required", "SOURCE_RECEIPT_UNPROVEN");
  const receipt = receipts[0];
  const outcome = result.receipts_outcome?.find((item) => item.id === receipt.receipt_id && item.outcome.executor_id === config.token_contract);
  if (!outcome) throw new ApiError(409, "The final source receipt outcome is unavailable", "SOURCE_RECEIPT_UNPROVEN");
  let succeeded = false;
  if ("SuccessValue" in outcome.outcome.status) {
    for (const log of outcome.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event;
      try { event = JSON.parse(log.slice(11)); } catch { continue; }
      if (event.standard === "nep141" && event.event === "ft_transfer" && Array.isArray(event.data) && event.data.some((transfer: Record<string, unknown>) => transfer.old_owner_id === config.near_account_id && transfer.new_owner_id === attempt.route.source_receiver && transfer.amount === attempt.route.input_amount)) succeeded = true;
    }
    if (!succeeded) throw new ApiError(409, "A successful source receipt has no matching token transfer event", "SOURCE_RECEIPT_UNPROVEN");
  } else if (!("Failure" in outcome.outcome.status)) throw new ApiError(409, "The source transfer outcome is not conclusive", "SOURCE_RECEIPT_UNPROVEN");
  return { succeeded, transactionHash: result.transaction!.hash!, senderAccountId: result.transaction!.signer_id!, tokenReceiptId: receipt.receipt_id, amount: attempt.route.input_amount, receiver: attempt.route.source_receiver, finality: "FINAL" as const };
}

export async function prepareSourceRecovery(access: AccessContext, attemptId: string, input: { transactionHash: string; senderAccountId: string }) {
  requirePermission(access, "payments:approve");
  const attempt = getAttempt(access, attemptId);
  const payment = getPayment(access, attempt.payment_id);
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) throw new ApiError(409, "Configure the company treasury first", "TREASURY_SETUP_REQUIRED");
  const chain = await view<ChainPayment | null>(config, "get_payment", { payment_id: payment.id });
  const chainAttempt = chain?.attempts.at(-1);
  if (!chainAttempt || chainAttempt.id !== attemptId || chainAttempt.status !== "sending" || chainAttempt.route.source_receiver !== attempt.deposit_address || chainAttempt.route.input_amount !== attempt.amount_in || chainAttempt.route.output_amount !== attempt.expected_output || chainAttempt.route.quote_hash !== createHash("sha256").update(attempt.quote).digest("hex") || chain?.amount !== payment.amount || chain.recipient_id !== payment.recipient_id || chain.reference !== `razor:${payment.id}`) throw new ApiError(409, "Only a matching source transfer with a missing callback can use source recovery", "SOURCE_RECOVERY_NOT_REQUIRED");
  const result = await nearTransactionStatus(config, input.transactionHash, input.senderAccountId);
  const proof = inspectSourceTransfer(result, config, payment.id, chainAttempt);
  const compact = JSON.stringify({ transaction_hash: proof.transactionHash, receipt_id: proof.tokenReceiptId, outcome: proof.succeeded ? "source_sent" : "source_failed" });
  getDb().prepare("INSERT INTO payment_source_receipts(attempt_id,organization_id,transaction_hash,receipt_id,evidence,verified_by,verified_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET transaction_hash=excluded.transaction_hash,receipt_id=excluded.receipt_id,evidence=excluded.evidence,verified_by=excluded.verified_by,verified_at=excluded.verified_at").run(attemptId, access.organizationId, proof.transactionHash, proof.tokenReceiptId, JSON.stringify(proof), access.userId, new Date().toISOString());
  getDb().prepare("UPDATE payout_attempts SET source_tx_hash=?,updated_at=? WHERE id=? AND organization_id=?").run(proof.transactionHash, new Date().toISOString(), attemptId, access.organizationId);
  const walletActions: WalletTransaction[] = [{ receiverId: config.near_account_id, actions: [{ type: "FunctionCall", params: { methodName: "recover_source_transfer", args: { payment_id: payment.id, attempt_id: attemptId, succeeded: proof.succeeded, receipt: compact }, gas: "60000000000000", deposit: "1" } }] }];
  return { proof, sourceOutcome: proof.succeeded ? "succeeded" : "failed", requiresOwnerSignature: true, walletActions };
}

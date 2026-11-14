import { ApiError } from "../context";
import type { FinalTransaction } from "../payments/near";
import { cashAmount } from "./funded-model";
import type { CashDeposit } from "./types";

export function fundingMessage(roundId: string, manifestHash: string, companyId: string, depositId: string) {
  return JSON.stringify({ kind: "razor_clearing_cash_v1", round_id: roundId, manifest_hash: manifestHash, company_id: companyId, deposit_id: depositId });
}
export function inspectCashDeposit(result: FinalTransaction, target: { transactionHash: string; token: string; clearing: string; roundId: string; manifestHash: string; deposit: CashDeposit }) {
  const fail = () => { throw new ApiError(409, "The final canonical-token receipt does not prove this exact accepted escrow deposit and any unused return", "FUNDED_CLEARING_SOURCE_UNVERIFIED"); };
  const deposit = target.deposit, transaction = result.transaction;
  if (result.final_execution_status !== "FINAL" || transaction?.hash !== target.transactionHash || transaction.signer_id !== deposit.sender_id || transaction.receiver_id !== target.token || transaction.actions?.length !== 1 || !result.status || !("SuccessValue" in result.status)) fail();
  const call = transaction!.actions![0].FunctionCall;
  try {
    const args = JSON.parse(Buffer.from(call!.args, "base64").toString()), used = JSON.parse(Buffer.from(String(result.status!.SuccessValue), "base64").toString());
    if (call?.method_name !== "ft_transfer_call" || args.receiver_id !== target.clearing || args.amount !== deposit.submitted || args.msg !== fundingMessage(target.roundId, target.manifestHash, deposit.company_id, deposit.deposit_id) || used !== deposit.accepted) fail();
  } catch { fail(); }
  const outcomes = new Map((result.receipts_outcome ?? []).map(item => [item.id, item])), reachable = new Set<string>(), work = [...result.transaction_outcome?.outcome.receipt_ids ?? []];
  while (work.length) {
    const id = work.pop()!; if (reachable.has(id)) continue; reachable.add(id);
    const outcome = outcomes.get(id)?.outcome;
    if (!outcome || "Failure" in outcome.status) continue;
    work.push(...outcome.receipt_ids ?? []); if (typeof outcome.status.SuccessReceiptId === "string") work.push(outcome.status.SuccessReceiptId);
  }
  const transfers: { id: string; blockHash: string; from: string; to: string; amount: string }[] = [], credits: { receiptId: string; value: Record<string, unknown> }[] = [];
  for (const receipt of result.receipts_outcome ?? []) {
    if (!reachable.has(receipt.id) || !("SuccessValue" in receipt.outcome.status || "SuccessReceiptId" in receipt.outcome.status)) continue;
    for (const log of receipt.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event; try { event = JSON.parse(log.slice(11)); } catch { continue; }
      if (!Array.isArray(event?.data)) continue;
      if (receipt.outcome.executor_id === target.token && event.standard === "nep141" && event.event === "ft_transfer") for (const entry of event.data) transfers.push({ id: receipt.id, blockHash: receipt.block_hash, from: entry.old_owner_id, to: entry.new_owner_id, amount: entry.amount });
      if (receipt.outcome.executor_id === target.clearing && event.standard === "razor-clearing" && event.version === "2.0.0" && event.event === "cash_deposit_accepted") for (const entry of event.data) credits.push({ receiptId: receipt.id, value: entry });
    }
  }
  const incoming = transfers.filter(item => item.from === deposit.sender_id && item.to === target.clearing && item.amount === deposit.submitted), returns = transfers.filter(item => item.from === target.clearing), accepted = credits.filter(item => item.value.round_id === target.roundId && item.value.manifest_hash === target.manifestHash
    && (["deposit_id", "company_id", "sender_id", "submitted", "accepted", "unused", "accepted_at_ms", "accepted_height"] as const).every(key => item.value[key] === deposit[key]));
  if (incoming.length !== 1 || !incoming[0].id || !incoming[0].blockHash || accepted.length !== 1 || cashAmount(deposit.submitted, false) !== cashAmount(deposit.accepted, false) + cashAmount(deposit.unused)
    || (deposit.unused === "0" ? returns.length !== 0 : returns.length !== 1 || returns[0].to !== deposit.sender_id || returns[0].amount !== deposit.unused)) fail();
  return { transactionHash: target.transactionHash, sourceReceiptId: incoming[0].id, sourceBlockHash: incoming[0].blockHash, acceptanceReceiptId: accepted[0].receiptId, deposit, unusedReturnVerified: deposit.unused !== "0", finality: "FINAL" as const };
}

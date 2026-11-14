import { type DirectFundingInstructions, validateDirectFunding } from "../../lib/direct-funding";
import { ApiError } from "../context";
import { row, transaction } from "../db";
import { fundingInstructions, isDirectFunding } from "./direct-funding";
import { contractCodeHash, nearTransactionStatus, type FinalTransaction } from "./near";
import { reviewedArtifactHash } from "../near-artifacts";
import { NATIVE_USDC } from "./policy";
import type { FundingLeg, TreasuryConfig } from "./types";

export function inspectDirectReturn(result: FinalTransaction, instructions: DirectFundingInstructions, hash: string) {
  validateDirectFunding(instructions);
  const terms = instructions.quoteRequest, source = terms.refundTo;
  const reject = () => { throw new ApiError(409, "A complete return from this direct deposit is not proven. Keep the original transfer held for reconciliation", "DIRECT_RETURN_UNPROVEN"); };
  if (result.final_execution_status !== "FINAL" || result.transaction?.hash !== hash || result.transaction.signer_id !== source || result.transaction.receiver_id !== NATIVE_USDC.near || !result.status || typeof result.status.SuccessValue !== "string") return reject();
  let used: unknown;
  try { used = JSON.parse(Buffer.from(result.status.SuccessValue, "base64").toString()); } catch { return reject(); }
  if (used !== "0") return reject();
  const calls = result.transaction.actions?.filter(action => action.FunctionCall?.method_name === "ft_transfer_call");
  if (calls?.length !== 1) return reject();
  let args: { receiver_id?: string; amount?: string; msg?: string };
  try { args = JSON.parse(Buffer.from(calls[0].FunctionCall!.args, "base64").toString()); } catch { return reject(); }
  if (args.receiver_id !== terms.recipient || args.amount !== terms.amount || args.msg !== terms.customRecipientMsg) return reject();
  const receipts = new Map(result.receipts_outcome?.map(receipt => [receipt.id, receipt]) ?? []);
  const reachable = new Set<string>(), pending = [...result.transaction_outcome?.outcome.receipt_ids ?? []];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const outcome = receipts.get(id)?.outcome;
    if (outcome) {
      pending.push(...outcome.receipt_ids ?? []);
      if (typeof outcome.status.SuccessReceiptId === "string") pending.push(outcome.status.SuccessReceiptId);
    }
  }
  const incoming: string[] = [], returned: string[] = [];
  for (const receipt of result.receipts_outcome ?? []) {
    if (!reachable.has(receipt.id)) continue;
    for (const log of receipt.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event;
      try { event = JSON.parse(log.slice(11)); } catch { continue; }
      if (receipt.outcome.executor_id === terms.recipient && event.standard === "razor" && event.event === "deposit_credited" && Array.isArray(event.data) && event.data.some((credit: {company_id?: string; deposit_id?: string}) => credit.company_id === instructions.companyId && credit.deposit_id === instructions.fundingId)) return reject();
      if (receipt.outcome.executor_id !== NATIVE_USDC.near || event.standard !== "nep141" || event.event !== "ft_transfer" || !Array.isArray(event.data) || !("SuccessValue" in receipt.outcome.status || "SuccessReceiptId" in receipt.outcome.status)) continue;
      for (const transfer of event.data) {
        if (transfer.old_owner_id === source && transfer.new_owner_id === terms.recipient) {
          if (transfer.amount !== terms.amount) return reject();
          incoming.push(receipt.id);
        } else if (transfer.old_owner_id === terms.recipient && transfer.new_owner_id === source) {
          if (transfer.amount !== terms.amount) return reject();
          returned.push(receipt.id);
        } else if ([source, terms.recipient].includes(transfer.old_owner_id) || [source, terms.recipient].includes(transfer.new_owner_id)) return reject();
      }
    }
  }
  if (incoming.length !== 1 || returned.length !== 1 || incoming[0] === returned[0]) return reject();
  return { provenance: "final_near_unused_token_return" as const, transactionHash: hash, sourceAccount: source, treasury: terms.recipient, companyId: instructions.companyId, fundingId: instructions.fundingId, amount: terms.amount, incomingReceipt: incoming[0], returnReceipt: returned[0], companyCredit: "0" };
}

export async function verifyDirectFundingReturn(config: TreasuryConfig, funding: FundingLeg, hash: string) {
  const instructions = fundingInstructions(funding);
  if (!isDirectFunding(instructions) || config.architecture !== "shared_v1" || config.company_id !== instructions.companyId || config.near_account_id !== instructions.quoteRequest.recipient || config.network !== "mainnet" || config.token_contract !== NATIVE_USDC.near || funding.source_tx_hash && funding.source_tx_hash !== hash) throw new ApiError(409, "The direct return does not match this company deposit", "DIRECT_RETURN_UNPROVEN");
  if (await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "Review the shared treasury code before recognizing a direct return", "TREASURY_CODE_MISMATCH");
  const evidence = inspectDirectReturn(await nearTransactionStatus(config, hash, instructions.quoteRequest.refundTo), instructions, hash);
  transaction(db => {
    const latest = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", funding.id, funding.organization_id);
    if (!latest || latest.quote !== funding.quote || latest.source_tx_hash && latest.source_tx_hash !== hash || latest.credited_amount !== "0" || latest.status === "confirmed" || row("SELECT id FROM funding_credit_receipts WHERE funding_id=?", funding.id)) throw new ApiError(409, "Funding credit or source tracking changed during return verification", "DIRECT_RETURN_CONFLICT");
    const previous = row<{transaction_hash:string}>("SELECT transaction_hash FROM direct_funding_returns WHERE funding_id=?", funding.id);
    if (previous && previous.transaction_hash !== hash) throw new ApiError(409, "Another return already closed this direct deposit", "DIRECT_RETURN_CONFLICT");
    db.prepare("INSERT OR IGNORE INTO direct_funding_returns(funding_id,organization_id,transaction_hash,amount,evidence,verified_at) VALUES(?,?,?,?,?,?)").run(funding.id, funding.organization_id, hash, evidence.amount, JSON.stringify(evidence), new Date().toISOString());
    db.prepare("UPDATE funding_legs SET status='refunded_verified',provider_status=NULL,source_tx_hash=COALESCE(source_tx_hash,?),updated_at=? WHERE id=?").run(hash, new Date().toISOString(), funding.id);
    db.prepare("UPDATE funding_request_quotes SET state='closed',updated_at=? WHERE funding_id=?").run(new Date().toISOString(), funding.id);
    db.prepare("UPDATE payment_funding_quotes SET state='closed',updated_at=? WHERE funding_id=?").run(new Date().toISOString(), funding.id);
  });
  return evidence;
}

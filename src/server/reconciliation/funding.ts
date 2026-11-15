import { randomUUID } from "node:crypto";
import { atomic } from "../../lib/money";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { assertSameQuote, checkStatus, type StatusResponse } from "../payments/intents";
import { fundingInstructions, isDirectFunding, supportsDirectFunding } from "../payments/direct-funding";
import { contractCodeHash, sharedFundingMessage, verifySharedDeposit, verifyTokenReceipt } from "../payments/near";
import { reviewedArtifactHash } from "../near-artifacts";
import { NATIVE_USDC } from "../payments/policy";
import { reserveApprovedPayment, getPayment, syncTreasury } from "../payments/service";
import type { FundingLeg, TreasuryConfig } from "../payments/types";

interface ReceiptRow {
  id: string;
  funding_id: string;
  receipt_id: string;
  log_index: number;
  data_index: number;
  amount: string;
  transaction_hash: string;
  evidence: string;
  verified_at: string;
}

function fundingFor(access: AccessContext, fundingId: string): FundingLeg {
  const funding = row<FundingLeg>("SELECT f.*,CASE WHEN f.payment_id IS NOT NULL THEN 'obligation' WHEN EXISTS(SELECT 1 FROM funding_request_quotes q WHERE q.funding_id=f.id) THEN 'funding_request' ELSE 'company' END AS source_context FROM funding_legs f WHERE f.id=? AND f.organization_id=?", fundingId, access.organizationId);
  if (!funding) throw new ApiError(404, "Funding request not found", "FUNDING_NOT_FOUND");
  return funding;
}

export function getFundingReceipt(access: AccessContext, fundingId: string) {
  requirePermission(access, "payments:read");
  const funding = fundingFor(access, fundingId);
  const receipts = rows<ReceiptRow>("SELECT * FROM funding_credit_receipts WHERE funding_id=? AND organization_id=? ORDER BY verified_at", fundingId, access.organizationId);
  const returned = row<{ evidence: string }>("SELECT evidence FROM direct_funding_returns WHERE funding_id=? AND organization_id=?", fundingId, access.organizationId);
  return { funding, receipts: receipts.map((receipt) => ({ ...receipt, evidence: JSON.parse(receipt.evidence) })), returnEvidence: returned ? JSON.parse(returned.evidence) : null, provenance: receipts.length ? "final_near_token_receipt" : returned ? "final_near_unused_token_return" : funding.provider_status === "SUCCESS" ? "provider_report_only" : "unresolved" };
}

export async function verifyFundingCredit(access: AccessContext, fundingId: string, input: { senderAccountId?: string; transactionHash?: string; receiptId?: string } = {}) {
  requirePermission(access, "payments:prepare");
  const funding = fundingFor(access, fundingId);
  if (["refunded_verified", "refunded_attested"].includes(funding.status)) throw new ApiError(409, "This source refund already has an audited closure. Any later credit requires a separate recovery review", "FUNDING_REFUND_CLOSED");
  if (funding.status === "confirmed") return { ...getFundingReceipt(access, fundingId), treasury: await syncTreasury(access) };
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config || config.network !== "mainnet" || config.token_contract !== NATIVE_USDC.near) throw new ApiError(409, "Configure the company native-USDC NEAR mainnet treasury first", "TREASURY_SETUP_REQUIRED");
  if (config.architecture === "shared_v1" && await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "Review the shared treasury code before recognizing a funding credit", "TREASURY_CODE_MISMATCH");
  const stored = fundingInstructions(funding);
  const direct = isDirectFunding(stored);
  let status: StatusResponse | undefined;
  if (direct) {
    if (!supportsDirectFunding(config, funding.origin_asset) || stored.companyId !== config.company_id || stored.quoteRequest.dry) throw new ApiError(409, "The direct deposit does not match this verified company treasury", "FUNDING_COMPANY_MISMATCH");
  } else {
    status = await checkStatus(funding.deposit_address, funding.deposit_memo);
    assertSameQuote(stored, status.quoteResponse);
    if (status.status !== "SUCCESS") throw new ApiError(409, "The provider has not reported a completed funding destination", "FUNDING_NOT_DELIVERED");
  }
  const request = stored.quoteRequest;
  if (request.destinationAsset !== `nep141:${config.token_contract}` || request.recipient !== config.near_account_id || request.recipientType !== "DESTINATION_CHAIN" || funding.recipient_address !== config.near_account_id) throw new ApiError(409, "The signed funding destination is not this native-USDC treasury", "FUNDING_DESTINATION_MISMATCH");
  if (config.architecture === "shared_v1" && request.customRecipientMsg !== sharedFundingMessage(config, funding.id)) throw new ApiError(409, "The signed funding message does not identify this company and funding leg", "FUNDING_COMPANY_MISMATCH");
  const hashes = status?.swapDetails?.destinationChainTxHashes?.map((item) => item.hash) ?? [];
  const txHash = input.transactionHash ?? (direct ? funding.source_tx_hash ?? undefined : hashes.length === 1 ? hashes[0] : undefined);
  if (!txHash || direct && funding.source_tx_hash && txHash !== funding.source_tx_hash || !direct && !hashes.includes(txHash)) throw new ApiError(422, direct ? "Use the original direct-deposit transaction hash" : "Choose a destination transaction returned for this funding leg", "FUNDING_HASH_UNBOUND");
  if (direct && input.senderAccountId && input.senderAccountId !== request.refundTo) throw new ApiError(409, "The direct funding signer differs from the selected source account", "FUNDING_SOURCE_CONFLICT");
  const expected = atomic(status?.swapDetails?.amountOut ?? stored.quote.amountOut).toString();
  const minimum = request.swapType === "EXACT_OUTPUT" ? atomic(request.amount) : atomic(stored.quote.minAmountOut ?? stored.quote.amountOut, true);
  if (atomic(expected) < minimum) throw new ApiError(409, "Reported output is below the signed funding amount", "FUNDING_UNDERPAYS");
  const consumed = rows<ReceiptRow>("SELECT receipt_id,log_index,data_index FROM funding_credit_receipts WHERE network=? AND token_contract=? AND transaction_hash=?", config.network, config.token_contract, txHash).map((receipt) => `${receipt.receipt_id}:${receipt.log_index}:${receipt.data_index}`);
  const proof = await verifyTokenReceipt(config, txHash, direct ? request.refundTo : input.senderAccountId, config.near_account_id, expected, input.receiptId, consumed);
  if (direct && proof.events.some(event => event.sender !== request.refundTo)) throw new ApiError(409, "The direct token receipt was not sent by the selected funding account", "FUNDING_SOURCE_CONFLICT");
  const sharedDeposit = config.architecture === "shared_v1" ? await verifySharedDeposit(config, proof, funding.id) : null;
  transaction(() => {
    const latest = fundingFor(access, fundingId);
    if (["refunded_verified", "refunded_attested"].includes(latest.status)) throw new ApiError(409, "This source refund closed during verification. Review later credit separately", "FUNDING_REFUND_CLOSED");
    if (latest.status === "confirmed") return;
    if (latest.quote !== funding.quote || direct && latest.source_tx_hash && latest.source_tx_hash !== txHash) throw new ApiError(409, "Funding instructions or source tracking changed during verification", "FUNDING_SOURCE_CONFLICT");
    for (const event of proof.events) {
      const used = row("SELECT id FROM funding_credit_receipts WHERE network=? AND token_contract=? AND receipt_id=? AND log_index=? AND data_index=?", config.network, config.token_contract, event.receiptId, event.logIndex, event.dataIndex);
      if (used) throw new ApiError(409, "This token receipt has already been credited to a funding leg", "FUNDING_RECEIPT_REPLAYED");
      getDb().prepare("INSERT INTO funding_credit_receipts(id,funding_id,organization_id,network,token_contract,transaction_hash,receipt_id,log_index,data_index,amount,evidence,verified_by,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), fundingId, access.organizationId, config.network, config.token_contract, txHash, event.receiptId, event.logIndex, event.dataIndex, event.amount, JSON.stringify({ proof, sharedDeposit, ...(direct ? { authorization: "source_wallet_tagged_ft_transfer_call" } : { quoteSignature: stored.signature, providerCorrelationId: status?.quoteResponse.correlationId, providerStatus: status?.status }), linkage: direct ? "source_wallet_and_immutable_company_credit" : sharedDeposit ? "signed_company_deposit_and_final_near_credit" : "provider_destination_hash_and_final_near_receipt" }), access.userId, new Date().toISOString());
    }
    getDb().prepare("UPDATE funding_legs SET status='confirmed',provider_status=?,source_tx_hash=COALESCE(source_tx_hash,?),destination_tx_hash=?,credited_amount=?,updated_at=? WHERE id=?").run(status?.status ?? null, direct ? txHash : null, txHash, proof.amount, new Date().toISOString(), fundingId);
  });
  const treasury = await syncTreasury(access);
  if (funding.payment_id) {
    const payment = getPayment(access, funding.payment_id);
    if (payment.status === "approved_unfunded" && payment.approved_at && payment.approved_by && !row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", access.organizationId)?.paused) reserveApprovedPayment(access, payment.id);
  }
  return { ...getFundingReceipt(access, fundingId), treasury };
}

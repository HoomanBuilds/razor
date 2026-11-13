import { createHash } from "node:crypto";
import { atomic } from "../../lib/money";
import { DestinationError, normalizeDestination } from "../../lib/recipient-destination";
import { ApiError } from "../context";
import { assertSameQuote, type QuoteResponse, type StatusResponse, type Token } from "../payments/intents";
import type { FundingLeg } from "../payments/types";
import type { RefundInput, RefundTerms } from "./types";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const hashQuote = (quote: string) => createHash("sha256").update(quote).digest("hex");
export const REFUND_FINAL_STATES = ["refunded_verified", "refunded_attested"];
const sameHash = (left: string, right: string, network: string) => network === "near" || network === "sol" ? left === right : left.toLowerCase() === right.toLowerCase();

export function refundTerms(funding: FundingLeg, quote: QuoteResponse, status: StatusResponse, source: Token, input: RefundInput): RefundTerms {
  assertSameQuote(quote, status.quoteResponse);
  if (!quote.signature || !quote.correlationId || quote.signature !== status.quoteResponse.signature || quote.correlationId !== status.quoteResponse.correlationId || quote.quoteRequest.originAsset !== funding.origin_asset || quote.quoteRequest.dry || quote.quoteRequest.depositType !== "ORIGIN_CHAIN" || quote.quoteRequest.refundType !== "ORIGIN_CHAIN" || quote.quote.depositAddress !== funding.deposit_address || (quote.quote.depositMemo ?? null) !== funding.deposit_memo || quote.quote.amountIn !== funding.amount_in || quote.quoteRequest.recipient !== funding.recipient_address) throw new ApiError(409, "The original funding quote does not match this source deposit", "FUNDING_REFUND_QUOTE_MISMATCH");
  if (status.status !== "REFUNDED") throw new ApiError(409, "Only a completed provider refund can close this source leg. Failed, incomplete and unknown transfers remain held", "FUNDING_REFUND_NOT_TERMINAL");
  if (funding.status === "confirmed" || funding.provider_status === "SUCCESS" || funding.status === "reported_delivered" || funding.destination_tx_hash || atomic(funding.credited_amount, true) > 0n) throw new ApiError(409, "Destination funding evidence conflicts with a complete source refund. Reconcile the contradiction before closing this leg", "FUNDING_REFUND_CONTRADICTION");
  if (source.assetId !== funding.origin_asset || !source.blockchain || !Number.isInteger(source.decimals) || source.decimals < 0 || source.decimals > 38 || funding.origin_network && funding.origin_network !== source.blockchain || funding.origin_decimals != null && funding.origin_decimals !== source.decimals || funding.origin_symbol && funding.origin_symbol !== source.symbol) throw new ApiError(409, "The source token identity differs from the original funding record", "FUNDING_REFUND_ASSET_MISMATCH");
  let amount: string, deposited: string | null, received: bigint;
  try { amount = atomic(String(status.swapDetails?.refundedAmount)).toString(); deposited = status.swapDetails?.depositedAmount == null ? null : atomic(String(status.swapDetails.depositedAmount)).toString(); received = status.swapDetails?.amountOut == null ? 0n : atomic(status.swapDetails.amountOut, true); } catch { throw new ApiError(409, "The provider has not supplied an exact positive source refund amount", "FUNDING_REFUND_AMOUNT_UNPROVEN"); }
  if (received > 0n || deposited !== null && BigInt(amount) > BigInt(deposited)) throw new ApiError(409, "Reported destination output or refund amounts contradict a complete source refund", "FUNDING_REFUND_CONTRADICTION");
  const refundTo = quote.quoteRequest.refundTo;
  if (typeof refundTo !== "string" || !refundTo || refundTo.length > 256 || /\s/.test(refundTo) || refundTo === funding.deposit_address) throw new ApiError(409, "Review the exact original source-chain recovery address", "FUNDING_REFUND_ADDRESS_MISMATCH");
  try { normalizeDestination(source.blockchain, refundTo); } catch (error) { if (!(error instanceof DestinationError) || error.code !== "DESTINATION_NETWORK_UNVERIFIED") throw new ApiError(409, "The original refund address is invalid on its source network", "FUNDING_REFUND_ADDRESS_MISMATCH"); }
  const hashes = status.swapDetails?.originChainTxHashes?.map(value => value.hash) ?? [];
  const transactionHash = hashes.find(hash => sameHash(hash, input.transactionHash, source.blockchain));
  if (!input.transactionHash || !transactionHash) throw new ApiError(409, "Choose a refund transaction supplied for this exact source leg", "FUNDING_REFUND_HASH_UNBOUND");
  const sourceHash = funding.source_tx_hash ?? input.sourceTransactionHash ?? null;
  if (funding.source_tx_hash && input.sourceTransactionHash && !sameHash(funding.source_tx_hash, input.sourceTransactionHash, source.blockchain)) throw new ApiError(409, "This funding leg already records a different original source transaction", "FUNDING_SOURCE_CONFLICT");
  if (sourceHash && (!hashes.some(hash => sameHash(hash, sourceHash, source.blockchain)) || sameHash(sourceHash, input.transactionHash, source.blockchain))) throw new ApiError(409, "The refund must be a distinct provider-linked transaction from the original deposit", "FUNDING_REFUND_HASH_UNBOUND");
  return { fundingId: funding.id, quoteHash: hashQuote(funding.quote), source: { assetId: source.assetId, blockchain: source.blockchain, symbol: source.symbol, decimals: source.decimals, contractAddress: source.contractAddress }, refundTo, refundedAmount: amount, reportedDepositedAmount: deposited, transactionHash, senderAccountId: input.senderAccountId ?? null, sourceTransactionHash: sourceHash, providerCorrelationId: quote.correlationId, providerStatus: "REFUNDED" };
}

import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { ApiError } from "../context";
import { atomic } from "../../lib/money";
import { NATIVE_USDC } from "./policy";

export interface Token {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
  price?: string | number;
  priceUpdatedAt?: string;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  deadline: string;
  customRecipientMsg?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: {
    amountIn: string;
    amountOut: string;
    minAmountOut?: string;
    minAmountIn?: string;
    depositAddress?: string;
    depositMemo?: string;
    deadline?: string;
    timeWhenInactive?: string;
    timeEstimate?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StatusResponse {
  status: string;
  quoteResponse: QuoteResponse;
  swapDetails?: {
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
    originChainTxHashes?: { hash: string; explorerUrl?: string }[];
    nearTxHashes?: string[];
    refundedAmount?: string;
    amountOut?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const BASE = "https://1click.chaindefuser.com";
let tokenCache: { fetchedAt: number; tokens: Token[] } | undefined;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  if (process.env.NEAR_INTENTS_JWT) headers.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
  const response = await fetch(`${BASE}${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!response.ok) {
    let reason = "The routing service could not complete the request";
    try {
      const payload = await response.json();
      if (typeof payload.message === "string") reason = payload.message.replace(/[\u0000-\u001f]/g, " ").slice(0, 180);
    } catch {}
    throw new ApiError(response.status === 400 ? 422 : 503, reason, "ROUTE_UNAVAILABLE");
  }
  return response.json() as Promise<T>;
}

export async function getSupportedTokens(force = false): Promise<Token[]> {
  if (!force && tokenCache && Date.now() - tokenCache.fetchedAt < 60_000) return tokenCache.tokens;
  const payload = await call<unknown>("/v0/tokens");
  if (!Array.isArray(payload)) throw new ApiError(503, "The asset catalog is unavailable", "CATALOG_UNAVAILABLE");
  const tokens = payload.filter((token): token is Token => !!token && typeof token === "object" && typeof token.assetId === "string" && typeof token.blockchain === "string" && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 38 && typeof token.symbol === "string");
  if (!tokens.length) throw new ApiError(503, "The asset catalog contains no usable assets", "CATALOG_UNAVAILABLE");
  tokenCache = { fetchedAt: Date.now(), tokens };
  return tokens;
}

export function nativeUsdc(tokens: Token[], network: string): Token {
  const address = NATIVE_USDC[network];
  if (!address) throw new ApiError(422, "Choose an enabled native USDC network", "USDC_NETWORK_UNSUPPORTED");
  const token = tokens.find((candidate) => candidate.blockchain === network && candidate.symbol === "USDC" && (network === "sol" ? candidate.contractAddress === address : candidate.contractAddress?.toLowerCase() === address.toLowerCase()) && candidate.decimals === 6);
  if (!token) throw new ApiError(422, "Native USDC is not available on the selected network", "USDC_UNAVAILABLE");
  return token;
}

export async function requestQuote(request: QuoteRequest): Promise<QuoteResponse> {
  atomic(request.amount);
  if (!request.recipient || !request.refundTo) throw new ApiError(422, "Recipient and refund destinations are required", "DESTINATION_REQUIRED");
  const result = await call<QuoteResponse>("/v0/quote", request);
  let valid = false;
  try { valid = await verifyQuoteSignature(result as Parameters<typeof verifyQuoteSignature>[0]); } catch {}
  if (!valid) throw new ApiError(502, "The routing quote signature could not be verified", "QUOTE_SIGNATURE_INVALID");
  const echoed = result.quoteRequest;
  const fields = ["originAsset", "destinationAsset", "depositType", "recipient", "recipientType", "refundTo", "refundType", "amount", "swapType", "dry", "slippageTolerance", "deadline", "customRecipientMsg"] as const;
  if (!echoed || fields.some((field) => echoed[field] !== request[field])) throw new ApiError(502, "The quote does not match the approved request", "QUOTE_TERMS_MISMATCH");
  if (!result.quote?.amountIn || !result.quote.amountOut) throw new ApiError(502, "The quote is missing payment amounts", "QUOTE_INVALID");
  atomic(result.quote.amountIn);
  atomic(result.quote.amountOut);
  if (request.swapType === "EXACT_OUTPUT" && atomic(result.quote.amountOut) < atomic(request.amount)) throw new ApiError(502, "The quote does not satisfy the recipient amount", "QUOTE_UNDERPAYS");
  if (!request.dry && !result.quote.depositAddress) throw new ApiError(502, "The quote is missing a funding destination", "QUOTE_INVALID");
  if (!request.dry) assertCanStartDeposit(result);
  if (!Number.isFinite(Date.parse(result.timestamp)) || Math.abs(Date.now() - Date.parse(result.timestamp)) > 120_000) throw new ApiError(502, "The routing quote is not fresh", "QUOTE_STALE");
  return result;
}

export function quoteDepositWindow(quote: QuoteResponse) {
  const refundDeadline = Date.parse(quote.quote.deadline ?? quote.quoteRequest.deadline);
  const inactiveAt = quote.quote.timeWhenInactive ? Date.parse(quote.quote.timeWhenInactive) : refundDeadline;
  if (!Number.isFinite(refundDeadline) || !Number.isFinite(inactiveAt)) throw new ApiError(502, "The signed quote has invalid deposit timing", "QUOTE_TIMING_INVALID");
  return { startBefore: Math.min(refundDeadline, inactiveAt), refundDeadline };
}

export function assertCanStartDeposit(quote: QuoteResponse, now = Date.now()): void {
  if (quoteDepositWindow(quote).startBefore <= now) throw new ApiError(409, "Refresh the quote before starting a new deposit. Existing transfers must still be reconciled", "QUOTE_DEPOSIT_WINDOW_CLOSED");
}

export async function checkStatus(depositAddress: string, depositMemo?: string | null): Promise<StatusResponse> {
  const params = new URLSearchParams({ depositAddress });
  if (depositMemo) params.set("depositMemo", depositMemo);
  const result = await call<StatusResponse>(`/v0/status?${params}`);
  if (!result || typeof result.status !== "string" || result.quoteResponse?.quote?.depositAddress !== depositAddress) throw new ApiError(502, "The routing status does not match this attempt", "STATUS_MISMATCH");
  let valid = false;
  try { valid = await verifyQuoteSignature(result.quoteResponse as Parameters<typeof verifyQuoteSignature>[0]); } catch {}
  if (!valid) throw new ApiError(502, "The original quote in the status response could not be verified", "STATUS_SIGNATURE_INVALID");
  return result;
}

export async function notifyDeposit(depositAddress: string, txHash: string, depositMemo?: string | null, nearSenderAccount?: string): Promise<void> {
  await call("/v0/deposit/submit", { depositAddress, txHash, ...(depositMemo ? { memo: depositMemo } : {}), ...(nearSenderAccount ? { nearSenderAccount } : {}) });
}

export function assertSameQuote(stored: QuoteResponse, reported: QuoteResponse): void {
  const fields = ["originAsset", "destinationAsset", "amount", "swapType", "recipient", "refundTo", "depositType", "recipientType", "refundType", "deadline", "slippageTolerance", "customRecipientMsg", "dry"] as const;
  if (fields.some((field) => stored.quoteRequest[field] !== reported.quoteRequest[field]) || stored.quote.depositAddress !== reported.quote.depositAddress || stored.quote.depositMemo !== reported.quote.depositMemo || stored.quote.amountIn !== reported.quote.amountIn || stored.quote.amountOut !== reported.quote.amountOut) throw new ApiError(502, "The provider returned another attempt's quote", "STATUS_TERMS_MISMATCH");
}

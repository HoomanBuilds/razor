import { atomic } from "../../lib/money";
import { ApiError } from "../context";
import { validNearAccount } from "../payments/near";
import type { Token } from "../payments/intents";
import type { TokenMetadata } from "./types";

export function eligibleRetainedTokens(tokens: Token[], paymentToken: string): Token[] {
  return tokens.filter((token, index) => token.blockchain === "near" && !!token.contractAddress && validNearAccount(token.contractAddress)
    && token.contractAddress !== paymentToken && token.assetId === `nep141:${token.contractAddress}` && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 38
    && !!token.symbol && token.symbol.length <= 32 && !/[\x00-\x1f\x7f]/.test(token.symbol)
    && tokens.findIndex((other) => other.contractAddress === token.contractAddress && other.blockchain === "near") === index);
}

export function verifyMetadata(token: Token, metadata: TokenMetadata): void {
  if (!metadata || metadata.spec !== "ft-1.0.0" || metadata.decimals !== token.decimals || metadata.symbol !== token.symbol) throw new ApiError(409, "The token contract metadata differs from the live NEAR catalog. Refresh and review its identity before retaining it", "RETAINED_TOKEN_METADATA_MISMATCH");
}

export function indicativeValue(quantity: string, decimals: number, price: Token["price"], updatedAt: string | undefined, now = Date.now()): string | null {
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt)) || now - Date.parse(updatedAt) > 300_000 || Date.parse(updatedAt) - now > 60_000 || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) return null;
  const text = String(price);
  if (text.length > 100) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (Math.abs(exponent) > 100) return null;
  const coefficient = BigInt(match[1] + (match[2] ?? ""));
  if (coefficient <= 0n) return null;
  try {
    const numerator = atomic(quantity, true) * coefficient * 1_000_000n * (exponent > 0 ? 10n ** BigInt(exponent) : 1n);
    const denominator = 10n ** BigInt(decimals) * (exponent < 0 ? 10n ** BigInt(-exponent) : 1n);
    return atomic(numerator / denominator, true).toString();
  } catch { return null; }
}

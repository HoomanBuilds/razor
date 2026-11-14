import { NATIVE_USDC } from "./native-usdc";
import type { QuoteRequest, QuoteResponse, Token } from "../server/payments/intents";

export const DIRECT_USDC_ASSET = `nep141:${NATIVE_USDC.near}`;
export const DIRECT_USDC_TOKEN: Token = { assetId: DIRECT_USDC_ASSET, blockchain: "near", symbol: "USDC", decimals: 6, contractAddress: NATIVE_USDC.near };

export interface DirectFundingInstructions {
  kind: "direct_near_usdc";
  network: "mainnet";
  companyId: string;
  fundingId: string;
  timestamp: string;
  quoteRequest: QuoteRequest;
  quote: QuoteResponse["quote"];
}

export type FundingInstructions = QuoteResponse | DirectFundingInstructions;

export function isDirectFunding(value: unknown): value is DirectFundingInstructions {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "direct_near_usdc";
}

export function validateDirectFunding(value: DirectFundingInstructions, expected?: { id: string; origin_asset: string; amount_in: string; expected_output?: string; deposit_address: string; recipient_address?: string; deposit_memo?: string | null }) {
  const request = value.quoteRequest, quote = value.quote;
  const account = (text: unknown) => typeof text === "string" && text.length >= 2 && text.length <= 64 && /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/.test(text);
  if (value.kind !== "direct_near_usdc" || value.network !== "mainnet" || typeof value.companyId !== "string" || !/^.{1,96}:[a-f0-9]{16}$/.test(value.companyId) || typeof value.fundingId !== "string" || !value.fundingId || value.fundingId.length > 128 || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) || !request || !quote || typeof request.dry !== "boolean" || request.originAsset !== DIRECT_USDC_ASSET || request.destinationAsset !== DIRECT_USDC_ASSET || request.depositType !== "ORIGIN_CHAIN" || request.recipientType !== "DESTINATION_CHAIN" || request.refundType !== "ORIGIN_CHAIN" || !account(request.recipient) || !account(request.refundTo) || request.slippageTolerance !== 0 || !["EXACT_INPUT", "EXACT_OUTPUT"].includes(request.swapType) || typeof request.amount !== "string" || request.amount.length > 39 || !/^[1-9]\d*$/.test(request.amount) || BigInt(request.amount) > (1n << 128n) - 1n || quote.amountIn !== request.amount || quote.amountOut !== request.amount || quote.depositAddress !== request.recipient || quote.depositMemo || typeof request.deadline !== "string" || !Number.isFinite(Date.parse(request.deadline)) || quote.deadline !== request.deadline || typeof request.customRecipientMsg !== "string") throw new Error("The direct USDC instructions are invalid. Review the saved company funding request.");
  let message: unknown;
  try { message = JSON.parse(request.customRecipientMsg ?? ""); } catch { throw new Error("The direct deposit is missing its company message."); }
  const tag = message as { company_id?: unknown; deposit_id?: unknown; kind?: unknown };
  if (!tag || tag.company_id !== value.companyId || tag.deposit_id !== value.fundingId || tag.kind !== "funding") throw new Error("The direct deposit message does not match its company and funding identity.");
  if (expected && (expected.id !== value.fundingId || expected.origin_asset !== DIRECT_USDC_ASSET || expected.amount_in !== request.amount || expected.expected_output !== undefined && expected.expected_output !== request.amount || expected.deposit_address !== request.recipient || expected.recipient_address !== undefined && expected.recipient_address !== request.recipient || expected.deposit_memo)) throw new Error("The direct deposit does not match its saved funding terms.");
  return value;
}

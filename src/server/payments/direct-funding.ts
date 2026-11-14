import { DIRECT_USDC_ASSET, DIRECT_USDC_TOKEN, isDirectFunding, validateDirectFunding, type DirectFundingInstructions, type FundingInstructions } from "../../lib/direct-funding";
import { atomic } from "../../lib/money";
import { ApiError } from "../context";
import { getSupportedTokens, type QuoteRequest, type Token } from "./intents";
import { sharedFundingMessage, treasuryArgs } from "./near";
import { NATIVE_USDC } from "./policy";
import type { FundingLeg, TreasuryConfig } from "./types";

export function supportsDirectFunding(config: TreasuryConfig, asset: string) {
  return asset === DIRECT_USDC_ASSET && config.network === "mainnet" && config.token_contract === NATIVE_USDC.near && config.architecture === "shared_v1";
}

export function createDirectFunding(config: TreasuryConfig, fundingId: string, request: Pick<QuoteRequest, "amount" | "refundTo" | "deadline" | "swapType" | "dry">): DirectFundingInstructions {
  if (!supportsDirectFunding(config, DIRECT_USDC_ASSET)) throw new ApiError(409, "Direct USDC deposits require a verified shared NEAR mainnet treasury", "DIRECT_FUNDING_UNAVAILABLE");
  const amount = atomic(request.amount).toString();
  const instructions: DirectFundingInstructions = {
    kind: "direct_near_usdc", network: "mainnet", companyId: String(treasuryArgs(config).company_id), fundingId, timestamp: new Date().toISOString(),
    quoteRequest: { ...request, amount, originAsset: DIRECT_USDC_ASSET, destinationAsset: DIRECT_USDC_ASSET, depositType: "ORIGIN_CHAIN", recipient: config.near_account_id, recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN", slippageTolerance: 0, customRecipientMsg: sharedFundingMessage(config, fundingId) },
    quote: { amountIn: amount, amountOut: amount, minAmountIn: amount, minAmountOut: amount, depositAddress: config.near_account_id, deadline: request.deadline },
  };
  try { return validateDirectFunding(instructions); }
  catch { throw new ApiError(422, "Use a valid NEAR source account and exact direct funding amount", "DIRECT_FUNDING_INVALID"); }
}

export function fundingInstructions(funding: FundingLeg): FundingInstructions {
  let value: FundingInstructions;
  try { value = JSON.parse(funding.quote); if (!value || typeof value !== "object" || !value.quoteRequest || !value.quote) throw new Error(); if (isDirectFunding(value)) validateDirectFunding(value, funding); }
  catch { throw new ApiError(409, "The saved funding instructions do not match this deposit", "FUNDING_TERMS_INVALID"); }
  return value;
}

export function assertDirectFundingTarget(funding: FundingLeg, config: TreasuryConfig) {
  const instructions = fundingInstructions(funding);
  if (isDirectFunding(instructions) && (!supportsDirectFunding(config, funding.origin_asset) || config.organization_id !== funding.organization_id || instructions.companyId !== config.company_id || instructions.quoteRequest.recipient !== config.near_account_id)) throw new ApiError(409, "The direct deposit's company or treasury binding changed. Review the original funding history before sending", "FUNDING_TARGET_CHANGED");
  return instructions;
}

export async function fundingAssetCatalog(): Promise<{ tokens: Token[]; routingCatalogAvailable: boolean }> {
  try {
    const tokens = await getSupportedTokens();
    return { tokens: [DIRECT_USDC_TOKEN, ...tokens.filter(token => token.assetId !== DIRECT_USDC_ASSET)], routingCatalogAvailable: true };
  } catch { return { tokens: [DIRECT_USDC_TOKEN], routingCatalogAvailable: false }; }
}

export async function fundingTokens(): Promise<Token[]> { return (await fundingAssetCatalog()).tokens; }

export { DIRECT_USDC_ASSET, DIRECT_USDC_TOKEN, isDirectFunding };

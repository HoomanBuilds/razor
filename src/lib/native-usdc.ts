export const NATIVE_USDC: Record<string, string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  arb: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  pol: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  eth: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  sol: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  near: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
};

export interface AssetChoice { assetId: string; symbol: string; blockchain: string; decimals: number; contractAddress?: string | null }

export function nativeUsdcSuggestions<T extends AssetChoice>(tokens: readonly T[]) {
  return ["near", "base", "sol", "arb", "pol"].flatMap(network => {
    const address = NATIVE_USDC[network];
    const token = tokens.find(candidate => candidate.blockchain === network && candidate.symbol === "USDC" && candidate.decimals === 6 &&
      (network === "sol" ? candidate.contractAddress === address : candidate.contractAddress?.toLowerCase() === address));
    return token ? [token] : [];
  });
}

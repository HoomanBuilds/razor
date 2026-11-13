"use client";

import { nativeUsdcSuggestions, type AssetChoice } from "@/lib/native-usdc";

const NETWORK_NAMES: Record<string, string> = { near: "NEAR", base: "Base", sol: "Solana", arb: "Arbitrum", pol: "Polygon" };

export function AssetGuidance({ kind, tokens, selectedAssetId, onSelect, disabled = false, className = "" }: { kind: "funding" | "payout"; tokens: readonly AssetChoice[]; selectedAssetId?: string; onSelect?: (asset: AssetChoice) => void; disabled?: boolean; className?: string }) {
  const suggestions = nativeUsdcSuggestions(tokens);
  return <div className={`space-y-3 rounded-lg bg-muted p-4 ${className}`}>
    <div><p className="text-sm font-medium">{kind === "funding" ? "Fund with any supported asset" : "Choose any supported payout asset"}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{kind === "funding" ? "Choose any source asset in the live NEAR Intents catalog. The recipient chooses their receiving asset separately." : "Your primary payout can use any asset in the live NEAR Intents catalog, on its supported network. It does not need to match your payer's funding asset."}</p></div>
    {suggestions.length > 0 && <div><p className="mb-2 text-xs font-medium">Native USDC options to compare</p><div className="flex flex-wrap gap-2">{suggestions.map(asset => onSelect ? <button key={asset.assetId} type="button" disabled={disabled} aria-pressed={selectedAssetId === asset.assetId} onClick={() => onSelect(asset)} className="rounded-full border bg-card px-3 py-1.5 text-xs aria-pressed:border-primary aria-pressed:text-primary disabled:opacity-50">USDC on {NETWORK_NAMES[asset.blockchain]}</button> : <span key={asset.assetId} className="rounded-full border bg-card px-3 py-1.5 text-xs">USDC on {NETWORK_NAMES[asset.blockchain]}</span>)}</div></div>}
    <p className="text-xs leading-5 text-muted-foreground">{kind === "funding" ? "Native USDC on popular networks can reduce conversion steps and may lower costs. Compare the live quote for conversion and routing costs; source-network gas is separate." : "Native USDC on popular networks can simplify receiving and may reduce conversion costs. Check what your receiving wallet supports. The live quote determines actual route costs, within your payer's approved allowance."} Suggestions keep all other catalog choices available and do not guarantee the cheapest route.</p>
  </div>;
}

export function UsdcBackupGuidance() {
  return <p className="text-xs leading-5 text-muted-foreground">Backup payouts always use native USDC on a curated popular network. Confirm a compatible receiving address and consent separately. A live supported route and the company's approved cost limit are still required.</p>;
}

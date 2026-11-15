"use client";

import { usd } from "@/lib/format";
import { networkIdentity } from "@/lib/asset-identity";
import { AssetIdentity } from "./assets/asset-identity";
import type { CommercialTerms } from "@/server/procurement/commercial";

export interface QuoteAsset { assetId: string; symbol: string; blockchain: string }

export function QuotedPayoutIdentity({ asset, network, assets, size = 28 }: { asset: string; network: string; assets: readonly QuoteAsset[]; size?: number }) {
  const selected = assets.find(value => value.assetId === asset && networkIdentity(value.blockchain).key === networkIdentity(network).key);
  const symbol = selected?.symbol ?? (/^[A-Za-z0-9]{1,12}$/.test(asset) ? asset : "Selected receiving asset");
  return <AssetIdentity symbol={symbol} network={network} assetId={asset} showAssetId={!selected && symbol === "Selected receiving asset"} size={size} />;
}

export function ProcurementCommercialTerms({ terms, compact = false }: { terms: CommercialTerms | null; compact?: boolean }) {
  if (!terms) return compact ? null : <p className="text-xs text-muted-foreground">Legacy all-inclusive unit price. A separate tax, fixed-charge and delivery breakdown was not captured. Historical totals and awards are unchanged.</p>;
  if (compact) return <div className="grid gap-4 text-sm">
    <dl className="grid grid-cols-2 gap-3 text-xs">{[["Subtotal", terms.lineSubtotal], ["Tax", terms.taxAmount], ["Shipping", terms.shippingAmount], ["Service", terms.serviceAmount], ["Other charges", terms.otherAmount]].filter(([label, amount]) => label === "Subtotal" || BigInt(amount) > 0n).map(([label, amount]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 tabular-nums">{usd(amount)}</dd></div>)}</dl>
    {terms.excludedCharges.length > 0 && <section className="rounded-xl bg-amber-50 p-4"><h3 className="mb-3 text-xs font-medium text-amber-900">Not included</h3><div className="grid gap-3">{terms.excludedCharges.map((charge, index) => <div key={index} className="flex items-start justify-between gap-3 text-xs"><div className="min-w-0"><p>{charge.description}</p><p className="mt-1 text-muted-foreground">{charge.kind.replaceAll("_", " ")}</p></div><p className="shrink-0 text-right tabular-nums">{charge.estimateUSDC === null ? "Unpriced" : <>{usd(charge.estimateUSDC)}<span className="mt-1 block text-muted-foreground">estimate</span></>}</p></div>)}</div></section>}
    {terms.conversionEstimate && <div className="flex justify-between gap-4 text-xs"><div><p className="text-muted-foreground">Supplier conversion estimate</p><p className="mt-1">{terms.conversionEstimate.description}</p></div><p className="shrink-0 tabular-nums">{usd(terms.conversionEstimate.amountUSDC)}</p></div>}
    <details className="border-y py-4"><summary className="cursor-pointer text-sm">Commercial terms</summary><dl className="mt-4 grid gap-4 text-xs">{[["Tax treatment", terms.taxTreatment.replaceAll("_", " ")], ["Tax conditions", terms.taxConditions], ["Shipping", terms.shippingConditions], ["Service", terms.serviceConditions], ["Delivery", terms.deliveryConditions], ["Acceptance", terms.acceptanceConditions], ["Other charges", terms.otherChargeConditions]].map(([label, text]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{text}</dd></div>)}</dl></details>
    {terms.fixedCharges !== "0" && <p className="text-xs text-amber-900">Full-quantity invoice required.</p>}
  </div>;
  return <div className="grid min-w-0 grid-cols-1 gap-3 text-xs">
    <dl className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">{[["Line subtotal", terms.lineSubtotal], ["Included tax", terms.taxAmount], ["Included shipping", terms.shippingAmount], ["Included service", terms.serviceAmount], ["Other included fixed charges", terms.otherAmount], ["Exact quoted commercial total", terms.commercialTotal]].filter(([label, amount]) => !compact || label !== "Exact quoted commercial total" && (label === "Line subtotal" || BigInt(amount) > 0n)).map(([label, amount]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{usd(amount)} USDC</dd></div>)}</dl>
    <p>Tax treatment: {terms.taxTreatment.replaceAll("_", " ")}. {terms.taxConditions}</p>
    {[["Shipping", terms.shippingConditions], ["Service", terms.serviceConditions], ["Delivery", terms.deliveryConditions], ["Acceptance", terms.acceptanceConditions], ["Other fixed charges", terms.otherChargeConditions]].map(([label, value]) => <p key={label} className="whitespace-pre-wrap break-words"><strong>{label}: </strong>{value}</p>)}
    <div>{terms.excludedCharges.length ? <><p className="font-medium">Excluded from the quoted total and PO allowance</p>{terms.excludedCharges.map((charge, index) => <p key={index} className="mt-1 break-words">{charge.kind}: {charge.description}. Supplier estimate: {charge.estimateUSDC === null ? "not supplied" : `${usd(charge.estimateUSDC)} USDC`}. Separate commercial approval required.</p>)}</> : compact ? null : <p>No additional excluded commercial charges declared.</p>}</div>
    {(!compact || terms.conversionEstimate) && <p className="text-muted-foreground">{terms.conversionEstimate ? `Indicative supplier conversion estimate: ${usd(terms.conversionEstimate.amountUSDC)} USDC. ${terms.conversionEstimate.description}` : "No supplier conversion estimate supplied."} Supplier estimates are not executable funding quotes, additional PO spend or a payment fee cap. The payer separately reviews live routing costs.</p>}
    {terms.fixedCharges !== "0" && <p className="text-amber-900">Invoice matching requires the full RFQ quantity and this exact complete total. Partial allocation of fixed charges is unsupported and remains held.</p>}
  </div>;
}

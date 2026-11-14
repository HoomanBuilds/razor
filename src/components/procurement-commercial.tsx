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

export function ProcurementCommercialTerms({ terms }: { terms: CommercialTerms | null }) {
  if (!terms) return <p className="text-xs text-muted-foreground">Legacy all-inclusive unit price. A separate tax, fixed-charge and delivery breakdown was not captured. Historical totals and awards are unchanged.</p>;
  return <div className="grid min-w-0 grid-cols-1 gap-3 text-xs">
    <dl className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">{[["Line subtotal", terms.lineSubtotal], ["Included tax", terms.taxAmount], ["Included shipping", terms.shippingAmount], ["Included service", terms.serviceAmount], ["Other included fixed charges", terms.otherAmount], ["Exact quoted commercial total", terms.commercialTotal]].map(([label, amount]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{usd(amount)} USDC</dd></div>)}</dl>
    <p>Tax treatment: {terms.taxTreatment.replaceAll("_", " ")}. {terms.taxConditions}</p>
    {[["Shipping", terms.shippingConditions], ["Service", terms.serviceConditions], ["Delivery", terms.deliveryConditions], ["Acceptance", terms.acceptanceConditions], ["Other fixed charges", terms.otherChargeConditions]].map(([label, value]) => <p key={label} className="whitespace-pre-wrap break-words"><strong>{label}: </strong>{value}</p>)}
    <div>{terms.excludedCharges.length ? <><p className="font-medium">Excluded from the quoted total and PO allowance</p>{terms.excludedCharges.map((charge, index) => <p key={index} className="mt-1 break-words">{charge.kind}: {charge.description}. Supplier estimate: {charge.estimateUSDC === null ? "not supplied" : `${usd(charge.estimateUSDC)} USDC`}. Separate commercial approval required.</p>)}</> : <p>No additional excluded commercial charges declared.</p>}</div>
    <p className="text-muted-foreground">{terms.conversionEstimate ? `Indicative supplier conversion estimate: ${usd(terms.conversionEstimate.amountUSDC)} USDC. ${terms.conversionEstimate.description}` : "No supplier conversion estimate supplied."} Supplier estimates are not executable funding quotes, additional PO spend or a payment fee cap. The payer separately reviews live routing costs.</p>
    {terms.fixedCharges !== "0" && <p className="text-amber-900">Invoice matching requires the full RFQ quantity and this exact complete total. Partial allocation of fixed charges is unsupported and remains held.</p>}
  </div>;
}

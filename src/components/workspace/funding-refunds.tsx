"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, Download, ExternalLink } from "lucide-react";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { api, RequestError } from "@/lib/api";
import { formatUnits } from "@/lib/money";
import type { RefundReview } from "@/server/funding-refunds/types";
import { FundingPagination, type FundingPageInfo } from "./funding-pagination";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Status } from "./shared";
import { TaskDrawer, closeTaskDrawer, openTaskDrawer } from "./task-drawer";

interface Closure { refunded_amount: string; source_network: string; source_asset: string; refund_address: string; transaction_hash: string; provenance: string; confirmed_at: string }
interface Leg { id: string; reference: string; paymentId: string | null; status: string; providerStatus: string | null; sourceAsset: string; sourceSymbol: string | null; sourceDecimals: number | null; sourceNetwork: string | null; refundTo: string; sourceTransactionHash: string | null; closure: Closure | null }
interface Overview extends FundingPageInfo { funding: Leg[]; message: string; canPrepare: boolean }

function RefundAsset({ leg }: { leg: Leg }) {
  return <AssetIdentity symbol={leg.sourceSymbol ?? "Source asset"} network={leg.sourceNetwork ?? "unknown"} assetId={leg.sourceAsset} size={26}/>;
}
function Receipt({ hash, network }: { hash: string; network: string | null }) {
  const explorers: Record<string, string> = { near: "https://nearblocks.io/txns/", eth: "https://etherscan.io/tx/", ethereum: "https://etherscan.io/tx/", base: "https://basescan.org/tx/", arb: "https://arbiscan.io/tx/", arbitrum: "https://arbiscan.io/tx/", pol: "https://polygonscan.com/tx/", polygon: "https://polygonscan.com/tx/", sol: "https://solscan.io/tx/", solana: "https://solscan.io/tx/" };
  const explorer = network ? explorers[network] : undefined;
  return <span className="flex flex-wrap items-center gap-2"><Address value={hash} label="transaction hash"/>{explorer && <a href={explorer + encodeURIComponent(hash)} target="_blank" rel="noreferrer" className="text-primary" aria-label="View transaction in explorer"><ExternalLink size={14}/></a>}</span>;
}
function returnedAmount(leg: Leg) {
  if (!leg.closure) return "Awaiting receipt";
  return leg.sourceDecimals === null ? `${leg.closure.refunded_amount} base units` : `${formatUnits(leg.closure.refunded_amount, leg.sourceDecimals)} ${leg.sourceSymbol ?? "tokens"}`;
}
function refundStatus(leg: Leg) {
  return leg.closure ? leg.closure.provenance === "final_chain_receipt" ? "refund verified" : "refund attested" : "needs review";
}

export function FundingRefundsPanel() {
  const { base, revision, refresh, notify, organization } = useWorkspace(), endpoint = `${base}/funding-refunds`;
  const [page, setPage] = useState(1), [selected, setSelected] = useState(""), [review, setReview] = useState<RefundReview | null>(null);
  const canRead = organization.permissions?.includes("payments:read") === true;
  const resource = useResource<Overview>(canRead ? `${endpoint}?page=${page}&pageSize=25` : null, revision);
  const { busy, error, run, setError } = useAction();
  const data = resource.data, leg = data?.funding.find(value => value.id === selected);
  const canPrepare = !!data?.canPrepare && !!organization.permissions?.some(value => value === "payments:prepare" || value === "payments:approve");
  const locked = !!busy || resource.refreshing || !!resource.error;
  const choose = (id: string) => { setSelected(id); setReview(null); setError(""); };
  const open = (id: string) => { setError(""); openTaskDrawer(id); };
  useEffect(() => { if (review) openTaskDrawer("source-refund-confirm"); }, [review]);
  if (!canRead) return null;
  return <div className="grid min-w-0 gap-5" aria-busy={!!busy}>
    {selected ? <button type="button" disabled={!!busy} className="flex min-h-10 items-center gap-1 justify-self-start text-sm text-primary" onClick={() => choose("")}><ChevronLeft size={16}/>Source refunds</button> : <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Original funding assets</p>{organization.permissions?.includes("reports:read") && <a href={`/api${endpoint}/export`} download className="inline-flex min-h-10 items-center gap-2 text-sm text-primary"><Download size={15}/>Export</a>}</div>}
    {resource.error && <p role="alert" className="text-sm text-destructive">{resource.error}</p>}
    {resource.loading ? <Empty>Loading refunds...</Empty> : data && (!selected ? <>
      <section className="divide-y rounded-3xl border bg-white px-5 sm:px-6">{data.funding.length ? data.funding.map(value => <button key={value.id} type="button" disabled={!!busy} className="flex w-full items-center justify-between gap-4 py-5 text-left" onClick={() => choose(value.id)}><span className="min-w-0"><span className="block text-sm font-medium">{value.reference}</span><span className="mt-2.5 block"><RefundAsset leg={value}/></span></span><span className="min-w-0 text-right"><span className="block break-all text-sm font-medium tabular-nums">{value.closure ? returnedAmount(value) : ""}</span><span className={value.closure ? "mt-2 block" : "block"}><Status value={refundStatus(value)}/></span></span></button>) : <p className="py-12 text-center text-sm text-muted-foreground">No source refunds.</p>}</section>
      {(data.hasMore || page > 1) && <FundingPagination data={data} loading={resource.refreshing || !!busy} onPageChange={setPage} label="Source refund pages"/>}
    </> : leg ? <section className="grid min-w-0 gap-5 rounded-3xl border bg-white p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-xl font-medium">{leg.reference}</h2><Status value={refundStatus(leg)}/></div>
      <RefundAsset leg={leg}/>
      {leg.closure && <div><p className="text-xs text-muted-foreground">Returned amount</p><p className="mt-2 break-all text-3xl font-medium tabular-nums">{returnedAmount(leg)}</p><p className="mt-2 text-xs text-muted-foreground">{new Date(leg.closure.confirmed_at).toLocaleString()}</p></div>}
      <div><p className="mb-2 text-xs text-muted-foreground">Original refund destination</p><Address value={leg.closure?.refund_address ?? leg.refundTo} network={leg.closure?.source_network ?? leg.sourceNetwork ?? undefined} full/></div>
      {!leg.closure && <div className="flex flex-wrap items-center justify-between gap-3 border-y py-3"><p className="text-xs text-muted-foreground">Provider status</p><Status value={leg.providerStatus ?? "not checked"}/></div>}
      {leg.closure ? <><div><p className="mb-2 text-xs text-muted-foreground">Refund transaction</p><Receipt hash={leg.closure.transaction_hash} network={leg.closure.source_network}/></div>{leg.closure.provenance !== "final_chain_receipt" && <p className="text-xs text-amber-900">Receipt attested; transfer not independently verified.</p>}</> : canPrepare && <Action type="button" className="justify-self-start" disabled={locked} onClick={() => open("source-refund-prepare")}>Review refund receipt</Action>}
      <details className="border-t pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Source evidence</summary><dl className="mt-4 grid gap-4"><div><dt>Original asset ID</dt><dd className="mt-2"><Address value={leg.sourceAsset} label="asset ID" full/></dd></div>{leg.sourceTransactionHash && <div><dt>Original deposit transaction</dt><dd className="mt-2"><Receipt hash={leg.sourceTransactionHash} network={leg.sourceNetwork}/></dd></div>}<div><dt>Funding status</dt><dd className="mt-1">{leg.status.replaceAll("_", " ")}</dd></div>{leg.paymentId && <div><dt>Linked payment ID</dt><dd className="mt-2"><Address value={leg.paymentId} label="payment ID"/></dd></div>}</dl></details>
    </section> : <Empty>This source refund is no longer on this page.</Empty>)}
    <TaskDrawer id="source-refund-prepare" title="Review refund receipt" description={leg?.reference}>{leg && !leg.closure && canPrepare && <form key={leg.id} aria-busy={!!busy} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("review-refund", async () => { const result = await api<RefundReview>(`${endpoint}/${leg.id}/prepare`, { transactionHash: values.get("hash"), ...(values.get("sourceHash") ? { sourceTransactionHash: values.get("sourceHash") } : {}), ...(values.get("signer") ? { senderAccountId: values.get("signer") } : {}) }); setReview(result); closeTaskDrawer("source-refund-prepare", true); }); }}><RefundAsset leg={leg}/><Field label="Returned transfer transaction hash"><input name="hash" className={control} required minLength={8} maxLength={160} disabled={locked}/></Field>{!leg.sourceTransactionHash && <Field label="Original deposit transaction hash"><input name="sourceHash" className={control} maxLength={160} disabled={locked}/></Field>}{(leg.sourceNetwork === "near" || !leg.sourceNetwork) && <Field label="NEAR refund transaction signer"><input name="signer" className={control} maxLength={64} required={leg.sourceNetwork === "near"} disabled={locked}/></Field>}<Action busy={busy === "review-refund"} disabled={locked}>Inspect receipt</Action>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</form>}</TaskDrawer>
    <TaskDrawer id="source-refund-confirm" title={review?.requiresAttestation ? "Attest returned funds" : "Confirm source refund"} description={leg?.reference}>{review && canPrepare && <form key={`${review.reviewId}:${review.reviewToken}`} aria-busy={!!busy} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("confirm-refund", async () => { if (Date.parse(review.expiresAt) <= Date.now()) throw new RequestError("Review expired. Inspect the refund receipt again.", 409, "FUNDING_REFUND_REVIEW_EXPIRED"); await api(`${endpoint}/${review.terms.fundingId}/confirm`, { reviewId: review.reviewId, reviewToken: review.reviewToken, acknowledged: true, ...(values.get("evidence") ? { evidence: values.get("evidence") } : {}) }); closeTaskDrawer("source-refund-confirm", true); setReview(null); refresh(); notify("Source refund closure recorded."); }); }}><AssetIdentity symbol={review.terms.source.symbol} network={review.terms.source.blockchain} assetId={review.terms.source.assetId}/><p className="break-all text-3xl font-medium tabular-nums">{formatUnits(review.terms.refundedAmount, review.terms.source.decimals)} <span className="text-sm font-normal">{review.terms.source.symbol}</span></p><div><p className="mb-2 text-xs text-muted-foreground">Refund destination</p><Address value={review.terms.refundTo} network={review.terms.source.blockchain} full/></div><div><p className="mb-2 text-xs text-muted-foreground">Refund transaction</p><Receipt hash={review.terms.transactionHash} network={review.terms.source.blockchain}/></div>{review.requiresAttestation && <><p className="text-sm text-amber-900">Transfer not independently verified.</p><Field label="Evidence of receipt"><textarea className={control} name="evidence" required minLength={12} maxLength={2000} rows={3} disabled={locked}/></Field></>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" required className="mt-1" disabled={locked}/><span>{review.requiresAttestation ? "I confirm receipt of this asset and amount at this address." : "I reviewed this final refund receipt."}</span></label><p className="text-xs text-muted-foreground">Review expires {new Date(review.expiresAt).toLocaleString()}</p><details className="border-t pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Refund evidence</summary><div className="mt-4 grid gap-4"><Address value={review.terms.source.assetId} label="asset ID" full/>{review.proof.reason && <p>{review.proof.reason}</p>}<pre className="max-h-64 overflow-auto rounded-xl bg-muted p-3">{JSON.stringify(review.proof, null, 2)}</pre></div></details><Action busy={busy === "confirm-refund"} disabled={locked}>{review.requiresAttestation ? "Record attested refund" : "Confirm refund"}</Action>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</form>}</TaskDrawer>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

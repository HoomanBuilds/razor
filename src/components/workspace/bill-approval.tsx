"use client";

import { useEffect, useState } from "react";
import { TokenLogo, AssetIdentity } from "@/components/assets/asset-identity";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { billBatchPreview } from "@/server/payment-management/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, Empty, Status } from "./shared";
import { TaskDrawer, openTaskDrawer } from "./task-drawer";
import { PurchaseMatchReview } from "./vendor-commitments";
import type { Bill, Token } from "./types";

type Review = Awaited<ReturnType<typeof billBatchPreview>>;

function blockers(bill: Review["bills"][number]) {
  return [
    ...(bill.activeClearingRound ? ["Held by business clearing"] : []),
    ...(bill.vendorCommitment?.problems ?? []),
    ...(bill.status === "disputed" ? ["Invoice disputed"] : []),
    ...(bill.requires_acceptance && !bill.milestone_accepted_at ? ["Milestone acceptance required"] : []),
    ...(!["draft", "approved_unfunded", "approved"].includes(bill.payment.status) ? [`Payment ${bill.payment.status.replaceAll("_", " ")}`] : []),
    ...(bill.profileChanged ? ["Receiving details changed"] : []),
    ...(bill.currentProfile.preference_status !== "confirmed" ? ["Recipient confirmation required"] : []),
    ...(bill.currentProfile.archived ? ["Payee archived"] : []),
  ];
}

export function BillApproval({ initialBillId = "", onBusyChange }: { initialBillId?: string; onBusyChange?: (busy: boolean) => void }) {
  const { base, revision, refresh, notify, navigate, organization, recipients } = useWorkspace();
  const invoices = useResource<{ bills: Bill[] }>(`${base}/bills`, revision);
  const assets = useResource<{ tokens: Token[] }>("/assets", revision);
  const [selected, setSelected] = useState<string[]>(initialBillId ? [initialBillId] : []);
  const [snapshot, setSnapshot] = useState<{ review: Review; revision: number } | null>(null);
  const [detailId, setDetailId] = useState("");
  const { busy, error, run } = useAction();
  const batch = snapshot?.review;
  const stale = !!snapshot && snapshot.revision !== revision;
  const detail = batch?.bills.find(bill => bill.id === detailId);
  const locked = !!busy || stale || invoices.refreshing || !!invoices.error;
  const canApprove = batch?.bills.length && batch.bills.every(bill => blockers(bill).length === 0);
  const preview = () => run("preview", async () => { const review = await api<Review>(`${base}/payment-management/bills/preview`, { billIds: selected }); setSnapshot({ review, revision }); });
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const symbol = (asset: string) => assets.data?.tokens.find(token => token.assetId === asset)?.symbol ?? (asset === "USDC" ? "USDC" : "Selected asset");
  return <section className="rounded-3xl border bg-white p-5 sm:p-7" aria-busy={!!busy}>
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-medium tracking-tight">{batch ? "Review approval" : "Select invoices"}</h2>{batch && <button type="button" disabled={!!busy} className="min-h-9 text-sm text-primary" onClick={() => setSnapshot(null)}>Change selection</button>}</header>
    {(error || invoices.error) && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 p-4 text-sm text-destructive"><p>{error || invoices.error}</p>{invoices.error && <button type="button" className="underline" disabled={!!busy} onClick={refresh}>Retry</button>}</div>}
    {!batch ? <>
      {invoices.loading ? <Empty>Loading invoices...</Empty> : !invoices.data ? null : !invoices.data.bills.length ? <Empty>No invoices to review.</Empty> : <div className="divide-y border-y">{invoices.data.bills.map(bill => {
        const payee = (bill.payment as Bill["payment"] & { recipientName?: string })?.recipientName ?? recipients.find(recipient => recipient.id === bill.recipient_id)?.name;
        return <label key={bill.id} className="flex cursor-pointer items-center gap-3 py-4"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked={selected.includes(bill.id)} disabled={!!busy || !bill.payment} onChange={event => setSelected(previous => event.target.checked ? [...previous, bill.id] : previous.filter(id => id !== bill.id))} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{bill.reference}</span><span className="mt-1 block text-xs text-muted-foreground">{payee}</span></span><span className="shrink-0 text-right"><span className="mb-2 block text-sm font-medium tabular-nums">{usd(bill.payment?.amount ?? bill.remainingLiability)}</span><Status value={bill.status} /></span></label>;
      })}</div>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-muted-foreground">{selected.length} selected</span><Action type="button" disabled={locked || !selected.length} busy={busy === "preview"} onClick={() => void preview()}>Review selection</Action></div>
    </> : <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-muted-foreground">{batch.bills.length} {batch.bills.length === 1 ? "invoice" : "invoices"}</span><p className="flex items-center gap-2 text-2xl font-semibold tabular-nums"><TokenLogo symbol="USDC" size={23} />{usd(batch.total)}</p></div>
      {batch.duplicateWarnings.length > 0 && <div role="alert" className="grid gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">{batch.duplicateWarnings.map((warning, index) => <p key={index}>{warning.message} {warning.references.join(", ")}</p>)}</div>}
      <div className="border-y py-4 text-sm text-muted-foreground"><p>{usd(batch.funding.available)} available · Costs up to {usd(batch.maxFees)}</p><button type="button" className="mt-2 min-h-8 text-primary" onClick={() => openTaskDrawer("bill-funding-review")}>Funding details</button>{BigInt(batch.funding.shortfall) > 0n && <p className="mt-2 text-amber-900">{usd(batch.funding.shortfall)} still needed for payment. Approval records the obligation.</p>}{!batch.funding.treasuryConfigured && <p className="mt-2 text-amber-900">Connect a company treasury before payment.</p>}</div>
      <div className="divide-y">{batch.bills.map(bill => {
        const issues = blockers(bill);
        return <article key={bill.id} className="flex items-start justify-between gap-4 py-4 first:pt-0"><div className="min-w-0"><p className="text-sm font-medium">{bill.reference}</p><p className="mt-1 text-sm text-muted-foreground">{bill.recipientName}</p><div className="mt-2"><AssetIdentity symbol={symbol(bill.recordedProfile.primary_asset)} network={bill.recordedProfile.primary_network} size={16} /></div>{issues.length > 0 && <p className="mt-2 text-xs text-amber-900">{issues[0]}{issues.length > 1 ? ` +${issues.length - 1}` : ""}</p>}{!issues.length && bill.routeReadiness.exceptions.length > 0 && <p className="mt-2 text-xs text-amber-900">Route needs review</p>}</div><div className="shrink-0 text-right"><p className="font-medium tabular-nums">{usd(bill.payment.amount)}</p><button type="button" className="mt-2 min-h-9 text-sm text-primary" aria-label={`Review ${bill.reference} receiving details`} disabled={!!busy} onClick={() => { setDetailId(bill.id); requestAnimationFrame(() => openTaskDrawer("bill-approval-detail")); }}>Review</button></div></article>;
      })}</div>
      {stale && <p role="alert" className="text-sm text-amber-900">Records changed. Review this selection again.</p>}
      <div className="flex justify-end border-t pt-5">{stale ? <Action type="button" disabled={!!busy} busy={busy === "preview"} onClick={() => void preview()}>Refresh review</Action> : organization.permissions?.includes("payments:approve") && <Action type="button" disabled={locked || !canApprove} busy={busy === "approve"} onClick={() => void run("approve", async () => { await api(`${base}/payment-management/bills/approve`, { billIds: batch.bills.map(bill => bill.id), reviewToken: batch.reviewToken }); setSnapshot(null); setSelected([]); notify("Reviewed invoices approved."); refresh(); })}>Approve {batch.bills.length === 1 ? "invoice" : `${batch.bills.length} invoices`}</Action>}</div>
    </div>}
    <TaskDrawer id="bill-funding-review" title="Funding">{batch && <div className="grid gap-5"><dl className="grid gap-4 text-sm">{[["Available", batch.funding.available], ["Additional reservation", batch.funding.unreserved], ["Already reserved", batch.funding.alreadyReserved], ["Awaiting reconciliation", batch.funding.awaitingReconciliation], ["Protected funds", batch.funding.protectedFunding], ["Shortfall", batch.funding.shortfall]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{usd(value)}</dd></div>)}</dl><p className="text-xs text-muted-foreground">Approval records the obligation. Payment requires confirmed funds and NEAR authorization.</p><button type="button" className="justify-self-start text-sm text-primary" onClick={() => navigate("treasury")}>Open treasury</button></div>}</TaskDrawer>
    <TaskDrawer id="bill-approval-detail" title={detail?.reference ?? "Invoice review"} description={detail?.recipientName}>{detail && <div className="grid gap-5"><p className="text-sm">{detail.title}</p><div className="flex justify-between text-sm"><span className="text-muted-foreground">Net amount</span><strong>{usd(detail.payment.amount)}</strong></div><div className="flex justify-between text-sm"><span className="text-muted-foreground">Cost limit</span><span>{usd(detail.payment.max_fee)}</span></div>{blockers(detail).length > 0 && <ul className="grid gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">{blockers(detail).map(problem => <li key={problem}>{problem}</li>)}</ul>}{[detail.recordedProfile, ...(detail.profileChanged ? [detail.currentProfile] : [])].map((profile, index) => <div key={index} className="grid gap-3 border-t pt-5"><p className="text-sm font-medium">{index ? "Current receiving details" : "Recorded receiving details"}</p><Status value={profile.preference_status ?? "pending_confirmation"} /><AssetIdentity symbol={symbol(profile.primary_asset)} network={profile.primary_network} /><Address value={profile.primary_address} network={profile.primary_network} />{profile.primary_memo != null && <p className="text-xs">Destination tag: {profile.primary_memo}</p>}{profile.backup_address && profile.backup_network ? <div className="grid gap-3 border-t pt-4"><p className="text-xs text-muted-foreground">USDC backup</p><AssetIdentity symbol="USDC" network={profile.backup_network} /><Address value={profile.backup_address} network={profile.backup_network} /><p className="text-xs text-muted-foreground">{profile.fallback_consent ? "Recipient consent confirmed" : "Backup consent required"}</p></div> : <p className="text-xs text-muted-foreground">No backup destination</p>}</div>)}<PurchaseMatchReview value={detail.vendorCommitment} />{detail.requires_acceptance > 0 && <div className="grid gap-2 text-sm"><Status value={detail.milestone_accepted_at ? "accepted" : "acceptance_required"} />{detail.acceptanceEvidence && <p>{detail.acceptanceEvidence}</p>}</div>}{detail.routeReadiness.exceptions.length > 0 && <ul className="grid gap-2 text-sm text-amber-900">{detail.routeReadiness.exceptions.map(reason => <li key={reason}>{reason}</li>)}</ul>}<details className="border-t pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Technical details</summary><div className="mt-4 grid gap-2"><p>Recorded profile version {detail.recordedProfile.version}</p><p className="break-all">{detail.recordedProfile.primary_asset}</p><p>Asset catalog: {batch?.routingCatalog.status}. Checked {batch && new Date(batch.routingCatalog.checkedAt).toLocaleString()}.</p><p>Primary: {detail.routeReadiness.primary.status}. Backup: {detail.routeReadiness.backup.status}.</p><p>{detail.routeReadiness.primary.reason}</p><p>Payable quotes and delivery authority are checked before execution.</p></div></details><div className="flex flex-wrap gap-4 border-t pt-5">{detail.activeClearingRound && <button type="button" className="text-sm text-primary" onClick={() => navigate("clearing")}>Review clearing</button>}<button type="button" className="text-sm text-primary" onClick={() => navigate("payments", detail.payment.id)}>View payment</button></div></div>}</TaskDrawer>
  </section>;
}

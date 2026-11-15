"use client";

import { useEffect, useRef } from "react";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, Empty } from "./shared";
import type { Payment, Token } from "./types";

interface ReviewedPayment extends Payment { recipient_snapshot: string; recipient_version: number; approved_at: string | null }
interface Destination { primary_asset: string; primary_network: string; primary_address: string; primary_memo?: string | null; backup_network: string | null; backup_address: string | null; fallback_consent: number }

export function PaymentApproval({ id, close }: { id: string; close: () => void }) {
  const { base, revision, recipients, refresh, organization } = useWorkspace();
  const { data, loading, error: loadError } = useResource<{ payment: ReviewedPayment; reviewToken: string }>(`${base}/payments/${id}`, revision);
  const { busy, error, run } = useAction();
  const { data: catalog } = useResource<{ tokens: Token[] }>("/assets", revision);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [id, base]);
  const payment = data?.payment;
  const destination = payment ? JSON.parse(payment.recipient_snapshot) as Destination : null;
  const current = recipients.find(recipient => recipient.id === payment?.recipient_id);
  const changed = !!payment && (!current || current.version !== payment.recipient_version);
  const asset = catalog?.tokens.find(token => token.assetId === destination?.primary_asset);
  return <div aria-busy={!!busy} className="grid max-w-3xl gap-5">
    <h3 className="text-lg font-medium">Approve payment</h3>
    {loading ? <Empty>Loading payment terms...</Empty> : payment && destination && data && <>
      <div><p className="text-xs text-muted-foreground">Net pay</p><p className="mt-1 text-2xl font-medium tabular-nums">{usd(payment.amount)} <span className="text-sm font-normal text-muted-foreground">USDC</span></p></div>
      <section className="grid gap-3 rounded-2xl bg-muted/50 p-4 sm:p-5"><p className="text-xs text-muted-foreground">Receiving destination</p><AssetIdentity symbol={asset?.symbol || (destination.primary_asset === "USDC" ? "USDC" : "Receiving asset")} network={destination.primary_network} assetId={destination.primary_asset}/><Address value={destination.primary_address} network={destination.primary_network} full/>{destination.primary_memo && <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">Memo / tag</span><Address value={destination.primary_memo} label="receiving memo" full/></div>}</section>
      <dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Cost limit</dt><dd className="tabular-nums">{usd(payment.max_fee)} USDC</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Total ceiling</dt><dd className="tabular-nums">{usd(BigInt(payment.amount) + BigInt(payment.max_fee))} USDC</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Scheduled</dt><dd className="text-right">{payment.scheduled_for ? new Date(payment.scheduled_for).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: organization.timezone, timeZoneName: "short" }) : "Anytime"}</dd></div></dl>
      <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">USDC backup · {destination.backup_address ? destination.fallback_consent ? "Consented" : "Manual approval only" : "Not configured"}</summary>{destination.backup_network && destination.backup_address && <div className="mt-4 grid gap-3"><AssetIdentity symbol="USDC" network={destination.backup_network}/><Address value={destination.backup_address} network={destination.backup_network} full/></div>}</details>
      {changed && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Receiving details changed. Refresh this draft, or replace the approved payment, before approving.</p>}
      <div className="border-t pt-5"><Action busy={busy === "approve"} disabled={changed || !!busy} onClick={() => void run("approve", async () => { await api(`${base}/payments/${payment.id}/approve`, { reviewToken: data.reviewToken }); refresh(); if (alive.current) close(); })}>{payment.approved_at ? "Reserve funds" : "Approve payment"}</Action><p className="mt-3 text-xs text-muted-foreground">Approval does not send funds.</p></div>
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Approval details</summary><div className="mt-3 grid gap-3 text-muted-foreground"><p>Receiving profile version {payment.recipient_version}</p><p className="break-all">Asset: {destination.primary_asset}</p></div></details>
    </>}
    {(error || loadError) && <p role="alert" className="text-sm text-destructive">{error || loadError}</p>}
  </div>;
}

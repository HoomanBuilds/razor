"use client";

import { api } from "@/lib/api";
import { dateLabel, usd } from "@/lib/format";
import { paymentLabel } from "@/lib/payment-label";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, Empty, Panel, Status } from "./shared";
import type { Payment } from "./types";

interface ReviewedPayment extends Payment { recipient_snapshot: string; recipient_version: number; approved_at: string | null }
interface Destination { primary_asset: string; primary_network: string; primary_address: string; backup_network: string | null; backup_address: string | null; fallback_consent: number }

export function PaymentApproval({ id, close }: { id: string; close: () => void }) {
  const { base, revision, recipients, refresh } = useWorkspace();
  const { data, loading, error: loadError } = useResource<{ payment: ReviewedPayment; reviewToken: string }>(`${base}/payments/${id}`, revision);
  const { busy, error, run } = useAction();
  const payment = data?.payment;
  const destination = payment ? JSON.parse(payment.recipient_snapshot) as Destination : null;
  const current = recipients.find((recipient) => recipient.id === payment?.recipient_id);
  const changed = !!payment && (!current || current.version !== payment.recipient_version);
  return <Panel title="Review fixed payment terms" description="Approval reserves the agreed amount and cost ceiling when funded. The NEAR signer authorizes the executable route separately." action={<button className="text-sm text-primary" disabled={!!busy} onClick={close}>Close</button>}>{loading ? <Empty>Loading exact payment terms...</Empty> : payment && destination && data && <div className="grid gap-5"><div className="grid gap-5 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Reference and payee</p><p className="mt-1 font-semibold">{paymentLabel(payment)}</p><p className="mt-1 text-sm">{current?.name ?? "Payee"}</p></div><div><p className="text-xs text-muted-foreground">Net entitlement</p><p className="mt-1 text-xl font-semibold">{usd(payment.amount)} USDC</p><p className="mt-1 text-xs">Routing costs up to {usd(payment.max_fee)}</p></div><div><p className="text-xs text-muted-foreground">Schedule</p><p className="mt-1 text-sm">{dateLabel(payment.scheduled_for)}</p><p className="mt-1 text-xs text-muted-foreground">Payee profile version {payment.recipient_version}</p></div></div><div className="grid gap-4 sm:grid-cols-2"><div className="rounded-lg border p-4"><p className="mb-2 text-sm font-medium">Primary · {destination.primary_network}</p><Address value={destination.primary_address} network={destination.primary_network} /><p className="mt-3 break-all text-xs text-muted-foreground">Asset: {destination.primary_asset}</p></div><div className="rounded-lg border p-4"><p className="mb-2 text-sm font-medium">USDC backup · {destination.backup_network ?? "Not configured"}</p>{destination.backup_address && <Address value={destination.backup_address} network={destination.backup_network ?? undefined} />}<div className="mt-3"><Status value={destination.fallback_consent ? "consented" : "manual_only"} /></div></div></div>{changed && <p role="alert" className="text-sm text-amber-900">Payee preferences changed. A preparer must refresh an unapproved draft or replace the cancelled approved obligation before a new review.</p>}<div><Action busy={busy === "approve"} disabled={changed || !!busy} onClick={() => void run("approve", async () => { await api(`${base}/payments/${payment.id}/approve`, { reviewToken: data.reviewToken }); refresh(); close(); })}>{payment.approved_at ? "Reserve the approved amount" : "Approve these exact terms"}</Action></div></div>}{(error || loadError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || loadError}</p>}</Panel>;
}

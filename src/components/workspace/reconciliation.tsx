"use client";

import { useState } from "react";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { api, RequestError } from "@/lib/api";
import { microUsd, usd } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./shared";
import type { Payment } from "./types";

interface Attempt { id: string; state: string; destination_network: string; destination_address: string; source_tx_hash: string | null; destination_tx_hash: string | null; provider_status: string | null; amount_in: string }
interface Funding { id: string; reference: string; status: string; provider_status: string | null; origin_asset: string; origin_symbol?: string; origin_network?: string; expected_output: string; credited_amount: string; destination_tx_hash: string | null }
interface Queue { payments: { payment: Payment; attempt: Attempt | null; provenance: string }[]; funding: { funding: Funding; provenance: string }[]; totals: { payments: number; funding: number; unresolvedEntitlementMicroUsdc: string }; page: number; pageSize: number; treasuryNetwork: string | null; more: { payments: boolean; funding: boolean } }
interface Prepared { label: string; paymentId: string; attemptId: string; walletActions: NearWalletAction[]; recordSource: boolean; treasuryNetwork: string }

const provenance: Record<string, string> = {
  unexecuted_obligation: "No source transfer recorded",
  near_native_transfer_callback: "Native NEAR token transfer confirmed",
  near_native_transfer_unresolved: "Direct NEAR transfer needs reconciliation",
  owner_reported_external_delivery: "Company reporter attested external delivery",
  near_refund_reconciled_with_reporter_attestation: "Refund reconciled on NEAR with reporter attestation",
  provider_report_only: "Provider report awaiting receipt confirmation",
  unresolved_route: "Delivery remains unresolved",
  unresolved_funding: "Funding has no verified credit yet",
};

export function Reconciliation() {
  const { base } = useWorkspace();
  return <ReconciliationWorkspace key={base} />;
}

function ReconciliationWorkspace() {
  const { base, revision, refresh, notify, recipients, organization } = useWorkspace();
  const [page, setPage] = useState(1);
  const resource = useResource<Queue>(`${base}/reconciliation?page=${page}`, revision);
  const { busy, error, run } = useAction();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const allowed = (permission: string) => organization.permissions?.includes(permission) ?? organization.role === "owner";
  const prepare = (key: string, label: string, paymentId: string, attemptId: string, path: string, input: object | (() => object) = {}, recordSource = false) => run(key, async () => {
    const treasuryNetwork = resource.data?.treasuryNetwork;
    if (!treasuryNetwork) throw new RequestError("Configure the company NEAR treasury first.", 409, "TREASURY_SETUP_REQUIRED");
    const result = await api<{ walletActions: NearWalletAction[]; sourceOutcome?: string }>(`${base}${path}`, typeof input === "function" ? input() : input);
    if (result.walletActions.length) setPrepared({ label: result.sourceOutcome ? `${label}: ${result.sourceOutcome}` : label, paymentId, attemptId, walletActions: result.walletActions, recordSource, treasuryNetwork });
    else { refresh(); notify("The recorded payment state has been refreshed."); }
  });
  const submit = () => run("sign", async () => {
    if (!prepared) return;
    try {
      const txHash = await signNearActions(prepared.walletActions, prepared.treasuryNetwork);
      if (txHash && prepared.recordSource) await api(`${base}/attempts/${prepared.attemptId}/submitted`, { txHash });
      await api(`${base}/payments/${prepared.paymentId}/reconcile`, {});
      notify("Wallet action recorded. Check the reconciled status before retrying.");
      refresh();
    } finally { setPrepared(null); }
  });
  const queue = resource.data;
  return <div className="grid gap-6">
    <Panel title="Reconciliation" description="Review interrupted delivery, recipient reports and funding receipts before moving money again." action={allowed("reports:read") ? <a className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" href={`/api${base}/reconciliation/export`}><Download size={16} />Export accounting CSV</a> : undefined}>
      {queue && <div className="grid gap-4 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Payments needing review</p><p className="mt-1 text-2xl font-semibold">{queue.totals.payments}</p></div><div><p className="text-xs text-muted-foreground">Unresolved obligations</p><p className="mt-1 text-2xl font-semibold">{usd(queue.totals.unresolvedEntitlementMicroUsdc)}</p></div><div><p className="text-xs text-muted-foreground">Funding legs awaiting verification</p><p className="mt-1 text-2xl font-semibold">{queue.totals.funding}</p></div></div>}
      <p className="mt-4 text-xs text-muted-foreground">The export includes all records. Filter by record type: obligation rows define payment liabilities; invoice, payroll, attempt and receipt rows provide links and evidence. Reservation ledger entries are not transfers.</p>
    </Panel>
    {(error || resource.error) && <p role="alert" className="rounded-lg border border-destructive/20 bg-card p-4 text-sm text-destructive">{error || resource.error}</p>}
    {prepared && <Panel title={prepared.label} description="Review the proposed authorization. Your company owner or appointed signer must confirm in a NEAR wallet." action={<button className="text-sm text-primary" disabled={!!busy} onClick={() => setPrepared(null)}>Close review</button>}>
      <p className="mb-3 text-sm">Treasury network: <strong>{prepared.treasuryNetwork}</strong></p>
      <details><summary className="cursor-pointer text-sm text-muted-foreground">Review wallet actions</summary><pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(prepared.walletActions, null, 2)}</pre></details>
      <Action className="mt-4" busy={busy === "sign"} disabled={!!busy} onClick={() => void submit()}>{busy === "sign" ? "Confirming wallet action..." : "Confirm in NEAR wallet"}</Action>
    </Panel>}
    <Panel title="Payment recovery" description="An unknown outcome blocks another payout. Provider success becomes an external delivery claim until the company reporter confirms it.">
      {resource.loading ? <Empty>Loading payment recovery...</Empty> : !queue?.payments.length ? <Empty>No payment exceptions on this page.</Empty> : <div className="grid gap-4">{queue.payments.map(({ payment, attempt, provenance: source }) => <article key={payment.id} className="rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{payment.reference}</p><p className="mt-1 text-sm text-muted-foreground">{recipients.find((recipient) => recipient.id === payment.recipient_id)?.name ?? "Recipient"} · {usd(payment.amount)} entitlement</p></div><Status value={payment.status} /></div>
        <p className="mt-3 text-xs text-muted-foreground">{provenance[source] ?? source.replaceAll("_", " ")}</p>{payment.hold_reason && <p className="mt-2 text-sm">{payment.hold_reason}</p>}
        {attempt && <div className="mt-3 grid gap-2 text-xs"><p>Destination: {attempt.destination_network}</p><Address value={attempt.destination_address} network={attempt.destination_network} />{attempt.source_tx_hash && <p className="break-all">NEAR source transaction: {attempt.source_tx_hash}</p>}{attempt.destination_tx_hash && <p className="break-all">Reported destination transaction: {attempt.destination_tx_hash}</p>}</div>}
        <div className="mt-4 flex flex-wrap gap-3"><Action busy={busy === `${payment.id}:check`} disabled={!!busy} onClick={() => void run(`${payment.id}:check`, async () => { await api(`${base}/payments/${payment.id}/reconcile`, {}); refresh(); })}><RefreshCw size={14} />Check status</Action>
          {attempt?.state === "prepared" && allowed("payments:execute") && <><Action busy={busy === `${attempt.id}:resume`} disabled={!!busy} onClick={() => void prepare(`${attempt.id}:resume`, "Resume payment authorization", payment.id, attempt.id, `/attempts/${attempt.id}/resume`, {}, true)}>Review remaining steps</Action><button className="text-sm text-primary disabled:opacity-50" disabled={!!busy} onClick={() => void prepare(`${attempt.id}:close`, "Close an unsent route", payment.id, attempt.id, `/attempts/${attempt.id}/close`)}>Close unsent route</button></>}
        </div>
        {attempt && ["unknown", "processing", "submitted"].includes(attempt.state) && allowed("payments:approve") && <details className="mt-4 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Recover a missing NEAR source callback</summary><p className="mt-2 text-xs text-muted-foreground">Use the original wallet transaction. Razor checks its final token receipt and binds the result to this attempt before preparing the owner recovery action.</p><form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void prepare(`${attempt.id}:source`, "Recover final NEAR source outcome", payment.id, attempt.id, `/reconciliation/attempts/${attempt.id}/source`, { senderAccountId: String(values.get("sender")).trim().toLowerCase(), transactionHash: String(values.get("hash")).trim() }); }}><Field label="Original NEAR transaction signer"><input name="sender" className={control} required minLength={2} maxLength={64} autoCapitalize="none" spellCheck={false} placeholder="signer.near" /></Field><Field label="Original NEAR transaction hash"><input name="hash" className={control} required minLength={32} maxLength={64} defaultValue={attempt.source_tx_hash ?? ""} autoCapitalize="none" spellCheck={false} /></Field><div className="sm:col-span-2"><Action disabled={!!busy} busy={busy === `${attempt.id}:source`}>Verify source receipt and review recovery</Action></div></form></details>}
        {attempt?.state === "reported_delivered" && allowed("payments:approve") && <form className="mt-4 grid gap-3 rounded-lg bg-muted p-4" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void prepare(`${attempt.id}:delivery`, "Attest external delivery", payment.id, attempt.id, `/attempts/${attempt.id}/settlement`, { outcome: "delivered", receipt: values.get("receipt") }); }}>
          <Field label="Delivery evidence"><input className={control} name="receipt" required maxLength={2000} defaultValue={attempt.destination_tx_hash ?? ""} placeholder="Checked destination transaction or receipt" /></Field><label className="flex items-start gap-2 text-xs"><input type="checkbox" required className="mt-0.5" /><span>I checked delivery to the confirmed recipient. The treasury will trust this owner or reporter attestation.</span></label><div><Action disabled={!!busy} busy={busy === `${attempt.id}:delivery`}>Review delivery report</Action></div>
        </form>}
        {attempt && ["recovery_pending", "unknown"].includes(attempt.state) && allowed("payments:approve") && <form className="mt-4 grid gap-3 rounded-lg bg-muted p-4" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget), action = values.get("action"); void prepare(`${attempt.id}:refund`, action === "confirm" ? "Confirm recovered funds" : "Report refund pending", payment.id, attempt.id, `/attempts/${attempt.id}/${action === "confirm" ? "refund" : "settlement"}`, () => { let refundAmount = "0"; if (action === "confirm") { try { refundAmount = microUsd(String(values.get("refundAmount")), true); } catch (cause) { throw new RequestError((cause as Error).message, 422, "INVALID_REFUND_AMOUNT"); } } return action === "confirm" ? { refundAmount, receipt: values.get("receipt") } : { outcome: "refund_pending", receipt: values.get("receipt") }; }); }}>
          <Field label="Recovery stage"><select name="action" className={control}><option value="report">1. Report route closed with refund pending</option><option value="confirm">2. Confirm returned funds on NEAR</option></select></Field><div className="grid gap-3 sm:grid-cols-2"><Field label="Recovered USDC" hint="Only the amount actually returned for this attempt."><input name="refundAmount" className={control} inputMode="decimal" defaultValue="0" /></Field><Field label="Refund or closure evidence"><input name="receipt" className={control} required maxLength={2000} placeholder="Verified refund transaction and route closure" /></Field></div><label className="flex items-start gap-2 text-xs"><input type="checkbox" required className="mt-0.5" /><span>I checked that the earlier route cannot deliver. For stage 2, I verified the returned funds. A treasury balance alone does not identify this refund.</span></label><div><Action disabled={!!busy} busy={busy === `${attempt.id}:refund`}>Review recovery authorization</Action></div>
        </form>}
      </article>)}</div>}
    </Panel>
    <Panel title="Funding receipts" description="Provider-linked final NEAR token events confirm each funding leg. Verification never adds a second synthetic treasury credit.">
      {resource.loading ? <Empty>Loading funding receipts...</Empty> : !queue?.funding.length ? <Empty>No unverified funding on this page.</Empty> : <div className="grid gap-4">{queue.funding.map(({ funding, provenance: source }) => <article key={funding.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{funding.reference}</p><p className="mt-1 text-sm text-muted-foreground">Expected {usd(funding.expected_output)} USDC from {funding.origin_symbol ?? "the selected asset"}{funding.origin_network ? ` on ${funding.origin_network}` : ""}</p></div><Status value={funding.status} /></div><p className="mt-3 text-xs text-muted-foreground">{provenance[source] ?? source} · Verified credit: {usd(funding.credited_amount)}</p>{funding.destination_tx_hash && <a className="mt-2 block break-all text-xs text-primary" target="_blank" rel="noreferrer" href={`https://nearblocks.io/txns/${encodeURIComponent(funding.destination_tx_hash)}`}>View NEAR destination transaction</a>}
        {allowed("payments:prepare") && <><Action className="mt-4" busy={busy === `${funding.id}:check`} disabled={!!busy} onClick={() => void run(`${funding.id}:check`, async () => { await api(`${base}/funding/${funding.id}/reconcile`, {}); refresh(); })}>Refresh provider status</Action><form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void run(`${funding.id}:verify`, async () => { const hash = String(values.get("hash") ?? "").trim(); await api(`${base}/reconciliation/funding/${funding.id}/verify`, { senderAccountId: String(values.get("sender") ?? "").trim().toLowerCase() || undefined, ...(hash ? { transactionHash: hash } : {}) }); notify("Final NEAR receipt verified. Funding credit recorded once."); refresh(); }); }}><details className="sm:col-span-2"><summary className="cursor-pointer text-sm">Advanced receipt lookup</summary><div className="mt-3"><Field label="Destination transaction signer (optional)" hint="Only needed if automatic lookup fails. Use the signer shown by the NEAR explorer."><input name="sender" className={control} minLength={2} maxLength={64} autoCapitalize="none" spellCheck={false} placeholder="signer.near" /></Field></div></details><Field label="Destination transaction hash" hint="Optional when the provider returns one destination transaction."><input name="hash" className={control} maxLength={64} defaultValue={funding.destination_tx_hash ?? ""} autoCapitalize="none" spellCheck={false} /></Field><div className="sm:col-span-2"><Action busy={busy === `${funding.id}:verify`} disabled={!!busy}><ShieldCheck size={15} />Verify final funding receipt</Action></div></form></>}
      </article>)}</div>}
    </Panel>
    {queue && (page > 1 || queue.more.payments || queue.more.funding) && <div className="flex items-center justify-between gap-4"><Action disabled={!!busy || page === 1} onClick={() => setPage((value) => value - 1)}>Previous page</Action><span className="text-sm text-muted-foreground">Page {page}</span><Action disabled={!!busy || !queue.more.payments && !queue.more.funding} onClick={() => setPage((value) => value + 1)}>Next page</Action></div>}
  </div>;
}

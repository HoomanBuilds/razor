"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { dateLabel, usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { AssetIdentity } from "@/components/assets/asset-identity";
import type { executionOverview, prepareRunBatch } from "@/server/payroll-execution/service";
import type { ExecutionStage } from "@/server/payroll-execution/model";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./shared";
import { PaymentRecoveryPanel } from "./payment-recovery";
import { PartialSettlementPanel } from "./partial-settlement";

type Overview = Awaited<ReturnType<typeof executionOverview>>;
type Batch = Awaited<ReturnType<typeof prepareRunBatch>>;
const stageLabel = { prepare: "Prepare routes on NEAR", approve: "Add my exact approvals", execute: "Execute approved routes", close: "Close unused routes" };

export function PayrollExecution({ runId, onReview }: { runId: string; onReview: () => void }) {
  const { base, organization, revision, refresh, notify } = useWorkspace();
  const path = `${base}/payment-management/payroll/${runId}/execution`;
  const resource = useResource<Overview>(path, revision);
  const { busy, error, run } = useAction();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [backup, setBackup] = useState<Record<string, boolean>>({});
  const [single, setSingle] = useState(false);
  const [confirmedBatch, setConfirmedBatch] = useState("");
  const [receipt, setReceipt] = useState({ index: "0", hash: "" });
  const [notice, setNotice] = useState("");
  const [recoveryId, setRecoveryId] = useState("");
  const data = resource.data, batch = data?.activeBatch;
  const can = (permission: string) => organization.permissions?.includes(permission) === true;
  const selections = Object.entries(selected).filter(([, value]) => value).map(([paymentId]) => ({ paymentId, useBackup: !!backup[paymentId] }));
  const selectedCount = selections.length;
  const batchPath = batch ? `${path}/batches/${batch.id}` : "";
  const reconcile = async (extra?: { index: number; hash: string }[]) => {
    if (!batch) return;
    let saved: { index: number; hash: string }[] = [];
    try { saved = JSON.parse(sessionStorage.getItem(`payroll-receipts:${batch.id}`) ?? "[]"); } catch {}
    const result = await api<{ batch: Batch; message: string; blocked: { reason: string }[] }>(`${batchPath}/reconcile`, { receipts: extra ?? saved });
    if (result.batch.status === "closed") sessionStorage.removeItem(`payroll-receipts:${batch.id}`);
    setNotice([result.message, ...result.blocked.map(value => value.reason)].join(". "));
    refresh();
  };
  const reviewStage = (stage: ExecutionStage) => run(stage, async () => {
    const result = await api<Batch>(`${path}/batches`, { stage, selections, maximumTransactions: single ? 1 : 8 });
    setConfirmedBatch("");
    setNotice(result.blocked.map(value => `${data?.lines.find(line => line.paymentId === value.paymentId)?.recipientName ?? "Payroll line"}: ${value.reason}`).join(". "));
    refresh();
  });
  const sign = () => run("sign", async () => {
    if (!batch || batch.status !== "review" || confirmedBatch !== batch.id) return;
    let started = false;
    try {
      const result = await signNearActionBatch(batch.transactions.map(value => value.action) as NearWalletAction[], batch.network, batch.signerAccounts, async signerAccount => {
        await api(`${batchPath}/begin`, { reviewHash: batch.reviewHash, signerAccount });
        started = true;
      });
      const returned = result.receipts.map(({ index, hash }) => ({ index, hash }));
      try { sessionStorage.setItem(`payroll-receipts:${batch.id}`, JSON.stringify(returned)); } catch {}
      await reconcile(returned);
      notify(result.complete ? "Wallet results recorded. Each delivery is reconciled independently." : "The wallet returned a partial result. Check the saved attempts before resuming.");
    } catch (cause) {
      if (started) {
        try { await reconcile(); } catch { setNotice("The wallet result is unresolved. Use Reconcile saved wallet group before resuming."); }
      }
      throw cause;
    } finally { setConfirmedBatch(""); refresh(); }
  });
  return <Panel title="Execute pay run" description="Prepare routes, collect exact NEAR approvals, then execute. Receiving-chain deliveries remain independent.">
    {(error || resource.error) && <p role="alert" className="mb-4 text-sm text-destructive">{error || resource.error}</p>}
    {notice && <p role="status" className="mb-4 rounded-lg border bg-muted p-3 text-sm">{notice}</p>}
    {resource.loading ? <Empty>Loading run execution...</Empty> : data ? <div className="grid gap-5">
      <div className="flex flex-wrap justify-between gap-4"><div><h3 className="font-medium">{data.run.reference}</h3><p className="mt-1 text-sm">{dateLabel(data.run.period_start)} - {dateLabel(data.run.period_end)}</p><p className="mt-2 text-xs text-muted-foreground">{data.approvedVersion ? `Approved ${new Date(data.approvedVersion.created_at).toLocaleString()} by ${data.approvedVersion.approvedName}` : "Current version has no reviewed approval"}</p>{data.approvedVersion && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Version {data.approvedVersion.id}<br/>Review {data.approvedVersion.review_hash}</p>}</div><div><p className="font-semibold">{usd(data.totalEntitlements)} net entitlements</p><p className="mt-1 text-sm">Maximum costs {usd(data.maximumCosts)}</p><div className="mt-2"><Status value={data.complete ? "paid" : data.run.status}/></div></div></div>
      <div className="grid gap-3 rounded-lg border bg-muted p-4 text-sm sm:grid-cols-3"><p>Available operating cash<br/><strong>{usd(data.funding.available)}</strong></p><p>Run payment reservations<br/><strong>{usd(data.funding.alreadyReserved)}</strong></p><p>Additional reservation needed<br/><strong>{usd(data.funding.unreserved)}</strong></p><p>Cash protected for these obligations<br/><strong>{usd(data.funding.protectedFunding)}</strong></p><p>Awaiting reconciliation<br/><strong>{usd(data.funding.awaitingReconciliation)}</strong></p><p>Funding shortfall<br/><strong>{usd(data.funding.shortfall)}</strong></p><p className="text-xs text-muted-foreground sm:col-span-3">Principal and maximum permitted costs use existing payment reservations. Other runs, client earmarks and unallocated linked funding remain protected.</p></div>
      <div className="flex flex-wrap gap-3"><button type="button" className="text-sm text-primary" onClick={onReview}>Review amounts and application approval</button>{(can("payments:prepare") || can("payments:approve")) && <Action busy={busy === "reserve"} disabled={!!busy || !!batch || !data.approvedVersion} onClick={() => void run("reserve", async () => { const result = await api<{ blocked: { reason: string }[] }>(`${path}/reserve`, {}); setNotice(result.blocked.map(value => value.reason).join(". ")); refresh(); })}>Reserve available funds</Action>}<Action busy={busy === "status"} disabled={!!busy} onClick={() => void run("status", async () => { const result = await api<{ blocked: { reason: string }[] }>(`${path}/reconcile`, {}); setNotice(result.blocked.map(value => value.reason).join(". ")); refresh(); })}>Check all delivery statuses</Action></div>
      <div className="grid gap-3">{data.lines.map(line => <article key={line.id} className="grid gap-3 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={!!selected[line.paymentId]} disabled={!!busy || !!batch || line.remaining === "0" || !selected[line.paymentId] && selectedCount >= 5} onChange={event => setSelected(value => ({ ...value, [line.paymentId]: event.target.checked }))}/><span className="font-medium">{line.recipientName}</span></label><span className="ml-auto tabular-nums">{usd(line.entitlement)} net</span><Status value={line.state}/></div><p className="text-xs text-muted-foreground">Delivered {usd(line.delivered)}; remaining {usd(line.remaining)}; reserved {usd(line.reserved)}; spent {usd(line.spent)}; cost ceiling {usd(line.maxFee)}.</p>{line.attempt && <div className="grid gap-2 text-xs"><AssetIdentity symbol={line.attempt.destination_symbol ?? "Receiving asset"} network={line.attempt.destination_network} assetId={line.attempt.destination_asset}/><Address value={line.attempt.destination_address} network={line.attempt.destination_network}/><p className="break-all text-muted-foreground">Attempt {line.attempt.id}{line.attempt.source_tx_hash && <> · source transaction {line.attempt.source_tx_hash}</>}{line.attempt.destination_tx_hash && <> · destination transaction {line.attempt.destination_tx_hash}</>}</p>{line.deadline && <p>Route expires {new Date(line.deadline).toLocaleString()}</p>}</div>}<div className="flex flex-wrap items-center gap-3"><p className="text-sm">Next action: {line.nextAction.replaceAll("_", " ")}</p>{line.attempt && line.remaining !== "0" && <button type="button" className="text-xs text-primary" disabled={!!busy} onClick={() => setRecoveryId(value => value === line.paymentId ? "" : line.paymentId)}>Review settlement and recovery</button>}</div>{line.blocks.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{line.blocks.map((block, index) => <li key={`${block.code}:${index}`}>{block.reason}</li>)}</ul>}{line.nextAction === "prepare" && line.route.backup.status === "supported" && <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!!busy || !!batch} checked={!!backup[line.paymentId]} onChange={event => setBackup(value => ({ ...value, [line.paymentId]: event.target.checked }))}/>Request recipient-confirmed native-USDC backup on {line.route.backup.network}. The primary-failure rule still applies.</label>}</article>)}</div>
      {recoveryId && <div className="grid gap-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Settlement and recovery for {data.lines.find(line => line.paymentId === recoveryId)?.recipientName}</h3><button type="button" className="text-xs text-primary" onClick={() => setRecoveryId("")}>Close settlement review</button></div><PaymentRecoveryPanel key={recoveryId} paymentId={recoveryId}/><PartialSettlementPanel key={`partial:${recoveryId}`} paymentId={recoveryId}/></div>}
      {!batch && !data.complete && <div className="grid gap-3 rounded-lg border p-4"><p className="text-sm">Select up to five lines, then review one stage. Ready lines remain visible alongside blocked lines.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={single} onChange={event => setSingle(event.target.checked)}/>One wallet transaction at a time</label><p className="text-xs text-muted-foreground">Use this resumable option when the wallet does not support transaction batches. Each transaction stays below the conservative 300 Tgas limit; groups contain at most eight transactions and 800 Tgas in total.</p><div className="flex flex-wrap gap-3">{(["prepare", "approve", "execute", "close"] as const).map(stage => can(stage === "approve" ? "payments:approve" : "payments:execute") && <Action key={stage} busy={busy === stage} disabled={!!busy || !selectedCount || !data.approvedVersion} onClick={() => void reviewStage(stage)}>Review: {stageLabel[stage]}</Action>)}</div></div>}
      {batch && <div className="grid gap-4 rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">{stageLabel[batch.stage]}</h3><Status value={batch.status}/></div><p className="break-all text-xs text-muted-foreground">Wallet group {batch.id}</p><p className="text-sm">{batch.transactions.length} transactions · {formatUnits(batch.gas, 12)} Tgas attached · NEAR {batch.network}. Wallet network fees and any storage deposits are paid separately by the signer.</p>{batch.remainingTransactions > 0 && <p className="text-xs">{batch.remainingTransactions} further transactions remain outside this group. Resume the same attempts after checking these results.</p>}{batch.entries.map(entry => <div key={entry.paymentId} className="grid gap-2 rounded-lg bg-muted p-3 text-sm"><p className="font-medium">{entry.recipientName} · {usd(entry.entitlement)} net</p><AssetIdentity symbol={entry.symbol ?? "Receiving asset"} network={entry.network} assetId={entry.asset} showAssetId/><Address value={entry.address} network={entry.network}/>{entry.memo && <p>Destination memo: {entry.memo}</p>}<p>Exact receiving amount: {entry.decimals !== null ? formatUnits(entry.output, entry.decimals) : `${entry.output} base units`} {entry.symbol ?? ""}</p><p>Source {usd(entry.amountIn)}; route cost {usd(entry.routeCost)}; maximum permitted cost {usd(entry.maxFee)}.</p><p>Expiry {new Date(entry.deadline).toLocaleString()}</p>{entry.approvals && <p>Policy {entry.approvals.policy_version}: obligation {entry.approvals.payment_collected}/{entry.approvals.required_approvals}, route {entry.approvals.attempt_collected}/{entry.approvals.required_approvals} approvals.</p>}<p className="break-all font-mono text-xs">Attempt {entry.attemptId}<br/>Quote {entry.quoteHash}</p></div>)}{batch.transactions.map((value, index) => <div key={index} className="grid gap-2 text-xs"><p className="font-medium">Transaction {index + 1}: {value.action.actions.map(action => action.params.methodName).join(", ")}</p><Address value={value.action.receiverId} network={batch.network}/><p>Attached gas {formatUnits(value.action.actions.reduce((sum, action) => sum + BigInt(action.params.gas), 0n).toString(), 12)} Tgas; attached deposit {formatUnits(value.action.actions.reduce((sum, action) => sum + BigInt(action.params.deposit), 0n).toString(), 24)} NEAR.</p></div>)}{batch.blocked.map((value, index) => <p key={index} className="text-xs text-muted-foreground">Held: {value.reason}</p>)}{batch.status === "review" ? <><p className="text-xs">One linked account must be eligible for every action: {batch.signerAccounts.join(", ")}. Any policy, route, amount or quorum change requires a fresh review.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmedBatch === batch.id} onChange={event => setConfirmedBatch(event.target.checked ? batch.id : "")}/>I reviewed these exact destinations, amounts, costs, expiry and wallet actions.</label><Action busy={busy === "sign"} disabled={!!busy || confirmedBatch !== batch.id} onClick={() => void sign()}>{stageLabel[batch.stage]}</Action></> : ["signing", "reconciling"].includes(batch.status) ? <><p className="text-sm">The wallet request is fenced until existing attempts are reconciled. An unknown result never authorizes another route or backup.</p><Action busy={busy === "reconcile-batch"} disabled={!!busy} onClick={() => void run("reconcile-batch", () => reconcile())}>Reconcile saved wallet group</Action><form className="grid gap-3 sm:grid-cols-3" onSubmit={event => { event.preventDefault(); void run("receipt", async () => { await reconcile([{ index: Number(receipt.index), hash: receipt.hash.trim() }]); setReceipt(value => ({ ...value, hash: "" })); }); }}><Field label="Transaction"><select className={control} value={receipt.index} onChange={event => setReceipt(value => ({ ...value, index: event.target.value }))}>{batch.transactions.map((_, index) => <option key={index} value={index}>Transaction {index + 1}</option>)}</select></Field><Field label="Wallet transaction hash"><input className={control} required minLength={32} maxLength={64} value={receipt.hash} onChange={event => setReceipt(value => ({ ...value, hash: event.target.value }))}/></Field><Action type="submit" busy={busy === "receipt"} disabled={!!busy}>Verify saved receipt</Action></form></> : <p className="text-sm">Route planning was interrupted before a wallet request. Cancel this planning group and resume the existing attempts.</p>}{["planning", "review"].includes(batch.status) && <button type="button" disabled={!!busy} className="justify-self-start text-sm text-primary disabled:opacity-50" onClick={() => void run("cancel", async () => { await api(`${batchPath}/cancel`, {}); refresh(); })}>Cancel unsigned group</button>}</div>}
      {data.recentBatches.length > 0 && <details className="text-xs text-muted-foreground"><summary>Recent wallet groups</summary><div className="mt-3 grid gap-3">{data.recentBatches.map(value => <p key={value.id} className="break-all">{value.id} · {value.stage} · {value.status}{value.receipts.map(item => <span key={item.index} className="mt-1 block">Transaction {item.index + 1}: {item.hash} ({item.verified ? item.failed ? "failed on NEAR" : "verified on NEAR" : "verification pending"})</span>)}</p>)}</div></details>}
    </div> : <Empty>Run execution is unavailable. {resource.error ? errorMessage(new Error(resource.error)) : "Refresh the payroll workspace."}</Empty>}
  </Panel>;
}

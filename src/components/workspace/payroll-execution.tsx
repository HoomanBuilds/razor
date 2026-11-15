"use client";

import { DemoAction } from "@/components/demo/demo-action";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { dateLabel, usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { networkIdentity } from "@/lib/asset-identity";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { AssetIdentity, NetworkIdentity, TokenLogo } from "@/components/assets/asset-identity";
import type { executionOverview, prepareRunBatch } from "@/server/payroll-execution/service";
import type { ExecutionStage } from "@/server/payroll-execution/model";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./shared";
import { PaymentRecoveryPanel } from "./payment-recovery";
import { PartialSettlementPanel } from "./partial-settlement";
import type { Token } from "./types";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./task-drawer";

type Overview = Awaited<ReturnType<typeof executionOverview>>;
type Batch = Awaited<ReturnType<typeof prepareRunBatch>>;
const stageLabel = { prepare: "Prepare payment routes", approve: "Approve payment routes", execute: "Send payments", close: "Close unused routes" };
function receivingAmount(output: string, decimals: number | null) {
  if (decimals === null) return `${BigInt(output).toLocaleString("en-US")} base units`;
  const [whole, fraction] = formatUnits(output, decimals).split(".");
  return `${BigInt(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export function PayrollExecution({ runId, onReview, active = true }: { runId: string; onReview: () => void; active?: boolean }) {
  const { base, organization, revision, refresh, notify } = useWorkspace();
  const path = `${base}/payment-management/payroll/${runId}/execution`;
  const resource = useResource<Overview>(path, revision);
  const assets = useResource<{ tokens: Token[] }>("/assets", revision);
  const { busy, error, run } = useAction();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [backup, setBackup] = useState<Record<string, boolean>>({});
  const [single, setSingle] = useState(false);
  const [stage, setStage] = useState<ExecutionStage | "">("");
  const [confirmedBatch, setConfirmedBatch] = useState("");
  const [receipt, setReceipt] = useState({ index: "0", hash: "" });
  const [notice, setNotice] = useState("");
  const [recoveryId, setRecoveryId] = useState("");
  const [lineId, setLineId] = useState("");
  const data = resource.data, batch = data?.activeBatch;
  const chosenLine = data?.lines.find(line => line.id === lineId);
  useEffect(() => { if (active && data?.run.id) document.getElementById("payroll-execution")?.scrollIntoView({ block: "start" }); }, [data?.run.id, active]);
  useEffect(() => { if (active && batch?.id) openTaskDrawer("payroll-wallet-review"); else closeTaskDrawer("payroll-wallet-review", true); }, [batch?.id, active]);
  const can = (permission: string) => organization.permissions?.includes(permission) === true;
  const canSignBatch = !!batch && can(batch.stage === "approve" ? "payments:approve" : "payments:execute");
  const selections = Object.entries(selected).filter(([, value]) => value).map(([paymentId]) => ({ paymentId, useBackup: !!backup[paymentId] }));
  const selectedCount = selections.length;
  const stages = (["prepare", "approve", "execute", "close"] as const).filter(value => can(value === "approve" ? "payments:approve" : "payments:execute"));
  const activeStage = stages.find(value => value === stage) ?? stages[0];
  const commonBlocks = data?.lines[0]?.blocks.filter(block => data.lines.every(line => line.blocks.some(value => value.code === block.code && value.reason === block.reason))) ?? [];
  const nextLabels: Record<string, string> = { prepare: "Route preparation", review: "Route review", close: "Unused route", reconcile: "Reconciliation needed", held: "Payment held", complete: "Delivered" };
  const blockLabels: Record<string, string> = { RUN_APPROVAL_REQUIRED: "Pay run approval required", RECIPIENT_CONFIRMATION_REQUIRED: "Receiving details need review", TREASURY_SETUP_REQUIRED: "Treasury setup required", EXECUTOR_REQUIRED: "Payment operator required", AUTHORITY_CHECK_UNAVAILABLE: "NEAR authority unavailable", POLICY_PAUSED: "Treasury paused", MISSING_AUTHORITY: "Authorized wallet required", PAYMENT_UNFUNDED: "Funds need reservation", BATCH_ACTIVE: "Wallet review in progress" };
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
    if (!batch || !canSignBatch || batch.status !== "review" || confirmedBatch !== batch.id) return;
    let started = false;
    try {
      const result = await withTaskDrawerWallet(() => signNearActionBatch(batch.transactions.map(value => value.action) as NearWalletAction[], batch.network, batch.signerAccounts, async signerAccount => {
        await api(`${batchPath}/begin`, { reviewHash: batch.reviewHash, signerAccount });
        started = true;
      }));
      const returned = result.receipts.map(({ index, hash }) => ({ index, hash }));
      try { sessionStorage.setItem(`payroll-receipts:${batch.id}`, JSON.stringify(returned)); } catch {}
      await reconcile(returned);
      notify(result.complete ? "Wallet results recorded." : "Partial wallet result. Review remaining payments.");
    } catch (cause) {
      if (started) {
        try { await reconcile(); } catch { setNotice("The wallet result is unresolved. Use Reconcile saved wallet group before resuming."); }
      }
      throw cause;
    } finally { setConfirmedBatch(""); refresh(); }
  });
  return <><Panel title={data?.run.reference ?? "Pay-run delivery"} description={data ? `${dateLabel(data.run.period_start)} - ${dateLabel(data.run.period_end)}` : undefined} tone="white" action={<button type="button" className="text-sm text-primary" disabled={!!busy} onClick={() => void run("status", async () => { const result = await api<{ blocked: { reason: string }[] }>(`${path}/reconcile`, {}); setNotice(result.blocked.map(value => value.reason).join(". ")); refresh(); })}>{busy === "status" ? "Refreshing..." : "Refresh"}</button>}>
    {(error || resource.error) && <p role="alert" className="mb-4 text-sm text-destructive">{error || resource.error}</p>}
    {notice && <p role="status" className="mb-4 rounded-lg border bg-muted p-3 text-sm">{notice}</p>}
    {resource.loading ? <Empty>Loading run execution...</Empty> : data ? <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div className="flex items-center gap-3 text-sm"><Status value={data.complete ? "paid" : data.run.status} /><span className="text-muted-foreground">{data.lines.filter(line => line.remaining === "0").length} / {data.lines.length} paid</span></div><p className="flex items-center gap-2 text-xl font-semibold"><TokenLogo symbol="USDC" size={22} />{usd(data.totalEntitlements)}</p></div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">{usd(data.funding.available)} available{BigInt(data.funding.shortfall) > 0n && <span className="ml-2 text-amber-900">· {usd(data.funding.shortfall)} shortfall</span>}</p><details><summary className="cursor-pointer text-muted-foreground">Run details</summary><div className="mt-4 grid gap-3 text-xs text-muted-foreground"><dl className="grid gap-2"><div className="flex justify-between gap-4"><dt>Still to reserve</dt><dd>{usd(data.funding.unreserved)}</dd></div><div className="flex justify-between gap-4"><dt>Reserved</dt><dd>{usd(data.funding.alreadyReserved)}</dd></div><div className="flex justify-between gap-4"><dt>Protected funds</dt><dd>{usd(data.funding.protectedFunding)}</dd></div><div className="flex justify-between gap-4"><dt>Awaiting reconciliation</dt><dd>{usd(data.funding.awaitingReconciliation)}</dd></div><div className="flex justify-between gap-4"><dt>Maximum costs</dt><dd>{usd(data.maximumCosts)}</dd></div></dl>{data.approvedVersion && <div className="grid gap-2 border-t pt-3"><p>Approved by {data.approvedVersion.approvedName} · {new Date(data.approvedVersion.created_at).toLocaleString()}</p><p className="break-all font-mono">Version: {data.approvedVersion.id}</p><p className="break-all font-mono">Review: {data.approvedVersion.review_hash}</p></div>}</div></details></div>
      {!data.complete&&data.approvedVersion&&<DemoAction action="settle-payroll" options={{runId}}>Simulate payroll delivery</DemoAction>}
      {commonBlocks.length > 0 && <ul className="space-y-1 text-sm text-amber-900">{commonBlocks.map(block => <li key={block.code}>{blockLabels[block.code] ?? block.reason}</li>)}</ul>}
      <div className="divide-y border-y">{data.lines.map(line => {
        const network = line.attempt?.destination_network ?? line.route.primary.network;
        const assetId = line.attempt?.destination_asset ?? line.route.primary.assetId;
        const symbol = line.attempt?.destination_symbol ?? assets.data?.tokens.find(token => token.assetId === assetId)?.symbol ?? (assetId === "USDC" ? "USDC" : "Selected asset");
        const issues = line.blocks.filter(block => !commonBlocks.some(value => value.code === block.code && value.reason === block.reason));
        return <div key={line.id} className={`flex items-center gap-3 py-4 ${selected[line.paymentId] ? "-mx-3 bg-primary/5 px-3" : ""}`}>{data.approvedVersion && stages.length > 0 ? <input type="checkbox" aria-label={`Select ${line.recipientName} for wallet review`} checked={!!selected[line.paymentId]} disabled={!!busy || !!batch || line.remaining === "0" || !selected[line.paymentId] && selectedCount >= 5} onChange={event => setSelected(value => ({ ...value, [line.paymentId]: event.target.checked }))} /> : <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs text-muted-foreground">{line.recipientName.split(/\s+/).map(part => part[0]).slice(0, 2).join("")}</span>}<div className="min-w-0 flex-1"><p className="text-sm font-medium">{line.recipientName}</p><p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground"><TokenLogo symbol={symbol} network={network} size={16} />{symbol} on {networkIdentity(network).name}</p>{BigInt(line.delivered) > 0n && line.remaining !== "0" && <p className="mt-2 text-xs text-muted-foreground">{usd(line.delivered)} delivered · {usd(line.remaining)} remaining</p>}{issues.length > 0 && <p className="mt-2 text-xs text-amber-900">{blockLabels[issues[0].code] ?? issues[0].reason}{issues.length > 1 ? ` (+${issues.length - 1})` : ""}</p>}</div><div className="shrink-0 text-right"><p className="font-medium tabular-nums">{usd(line.entitlement)}</p><div className="mt-1"><Status value={line.state} /></div><button type="button" aria-label={`Delivery details for ${line.recipientName}`} className="mt-2 text-sm text-primary" disabled={!!busy} onClick={() => { setLineId(line.id); setRecoveryId(""); requestAnimationFrame(() => openTaskDrawer("payroll-line-details")); }}>Details</button></div></div>;
      })}</div>
      {!batch && !data.complete && (!data.approvedVersion ? <div className="flex justify-end"><Action disabled={!!busy} onClick={onReview}>Review pay run</Action></div> : <div className="grid gap-4">{(can("payments:prepare") || can("payments:approve")) && BigInt(data.funding.unreserved) > 0n && <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{usd(data.funding.unreserved)} to reserve</p><Action busy={busy === "reserve"} disabled={!!busy} onClick={() => void run("reserve", async () => { const result = await api<{ blocked: { reason: string }[] }>(`${path}/reserve`, {}); setNotice(result.blocked.map(value => value.reason).join(". ")); refresh(); })}>Reserve funds</Action></div>}{activeStage && <><div className="flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">{selectedCount} / 5 selected</p><label className="flex items-center gap-2"><input type="checkbox" disabled={!!busy} checked={single} onChange={event => setSingle(event.target.checked)} />One transaction at a time</label></div><div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"><select aria-label="Payment stage" className={control} disabled={!!busy} value={activeStage} onChange={event => setStage(event.target.value as ExecutionStage)}>{stages.map(value => <option key={value} value={value}>{stageLabel[value]}</option>)}</select><Action busy={busy === activeStage} disabled={!!busy || !selectedCount} onClick={() => void reviewStage(activeStage)}>Review selected</Action></div></>}</div>)}
      {batch && <div className="flex items-center justify-between gap-4 border-t pt-4"><div><p className="text-sm font-medium">{stageLabel[batch.stage]}</p><p className="mt-1 text-xs text-muted-foreground">{batch.entries.length} recipients · <span className="capitalize">{batch.status}</span></p></div><Action type="button" onClick={() => openTaskDrawer("payroll-wallet-review")}>Review wallet group</Action></div>}
      {data.recentBatches.length > 0 && <details className="text-xs text-muted-foreground"><summary>Recent wallet groups</summary><div className="mt-3 grid gap-3">{data.recentBatches.map(value => <p key={value.id} className="break-all">{value.id} · {value.stage} · {value.status}{value.receipts.map(item => <span key={item.index} className="mt-1 block">Transaction {item.index + 1}: {item.hash} ({item.verified ? item.failed ? "failed on NEAR" : "verified on NEAR" : "verification pending"})</span>)}</p>)}</div></details>}
    </div> : <Empty>Run execution is unavailable. {resource.error ? errorMessage(new Error(resource.error)) : "Refresh the payroll workspace."}</Empty>}
  </Panel><TaskDrawer id="payroll-line-details" title={chosenLine?.recipientName ?? "Payment details"}>
    {chosenLine && <div aria-busy={!!busy} className="grid gap-5">{recoveryId ? <><button type="button" className="justify-self-start text-sm text-primary" onClick={() => setRecoveryId("")}>Back to payment details</button><PaymentRecoveryPanel key={recoveryId} paymentId={recoveryId} focused /><PartialSettlementPanel key={`partial:${recoveryId}`} paymentId={recoveryId} focused /></> : <><div className="flex items-center justify-between gap-3"><Status value={chosenLine.state} /><p className="text-xl font-semibold">{usd(chosenLine.entitlement)}</p></div><p className="text-sm font-medium">{nextLabels[chosenLine.nextAction] ?? chosenLine.nextAction.replaceAll("_", " ")}</p>{chosenLine.blocks.length > 0 && <ul className="space-y-2 text-sm text-amber-900">{chosenLine.blocks.map((block, index) => <li key={`${block.code}:${index}`}>{block.reason}</li>)}</ul>}{chosenLine.attempt && <div className="grid gap-3 border-b pb-4"><AssetIdentity symbol={chosenLine.attempt.destination_symbol ?? "Receiving asset"} network={chosenLine.attempt.destination_network} assetId={chosenLine.attempt.destination_asset} /><Address value={chosenLine.attempt.destination_address} network={chosenLine.attempt.destination_network} />{chosenLine.deadline && <p className="text-sm text-muted-foreground">Expires {new Date(chosenLine.deadline).toLocaleString()}</p>}</div>}<dl className="grid gap-3 text-sm">{[["Delivered", chosenLine.delivered], ["Remaining", chosenLine.remaining], ["Reserved", chosenLine.reserved], ["Spent", chosenLine.spent], ["Cost limit", chosenLine.maxFee]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{usd(value)}</dd></div>)}</dl>{chosenLine.nextAction === "prepare" && chosenLine.route.backup.status === "supported" && can("payments:execute") && <label className="flex items-center gap-3 border-t pt-4 text-sm"><input type="checkbox" disabled={!!busy || !!batch} checked={!!backup[chosenLine.paymentId]} onChange={event => setBackup(value => ({ ...value, [chosenLine.paymentId]: event.target.checked }))} />Use confirmed USDC backup on {networkIdentity(chosenLine.route.backup.network).name}</label>}{chosenLine.attempt && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Delivery evidence</summary><dl className="mt-4 grid gap-3 break-all text-xs text-muted-foreground"><div><dt>Attempt</dt><dd className="mt-1 font-mono">{chosenLine.attempt.id}</dd></div>{chosenLine.attempt.source_tx_hash && <div><dt>Source transaction</dt><dd className="mt-1 font-mono">{chosenLine.attempt.source_tx_hash}</dd></div>}{chosenLine.attempt.destination_tx_hash && <div><dt>Destination transaction</dt><dd className="mt-1 font-mono">{chosenLine.attempt.destination_tx_hash}</dd></div>}</dl></details>}{chosenLine.attempt && chosenLine.remaining !== "0" && <Action type="button" disabled={!!busy} onClick={() => setRecoveryId(chosenLine.paymentId)}>Settlement and recovery</Action>}</>}</div>}
  </TaskDrawer><TaskDrawer id="payroll-wallet-review" title="Review payment">
    {batch && <div aria-busy={!!busy} className="grid gap-5">
      <div className="divide-y">{batch.entries.map(entry => <section key={entry.paymentId} className="grid gap-5 py-5 first:pt-0"><div><p className="text-sm text-muted-foreground">{entry.recipientName} receives</p><p className="mt-3 flex items-center gap-3 text-3xl font-semibold tracking-tight"><TokenLogo symbol={entry.symbol ?? ""} size={32} /><span className="min-w-0 break-words">{receivingAmount(entry.output, entry.decimals)} <span className="text-lg font-medium">{entry.symbol ?? ""}</span></span></p><div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"><NetworkIdentity network={entry.network} /><Address value={entry.address} network={entry.network} /></div>{entry.memo && <p className="mt-2 text-sm">Memo: {entry.memo}</p>}</div>
        <dl className="grid gap-3 border-y py-4 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Source total (USDC)</dt><dd className="text-right font-medium tabular-nums">{usd(entry.amountIn)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Route cost / limit</dt><dd className="text-right tabular-nums">{usd(entry.routeCost)} / {usd(entry.maxFee)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Expires</dt><dd className="text-right">{new Date(entry.deadline).toLocaleString()}</dd></div>{entry.approvals && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Approvals</dt><dd className="text-right">Payment {entry.approvals.payment_collected}/{entry.approvals.required_approvals}<span className="mx-1 text-muted-foreground">·</span>Route {entry.approvals.attempt_collected}/{entry.approvals.required_approvals}</dd></div>}</dl>
      </section>)}</div>
      <div className="flex justify-between gap-4 text-sm"><span className="text-muted-foreground">Wallet fees</span><span>Paid separately in NEAR</span></div>
      {batch.remainingTransactions > 0 && <p className="text-sm text-amber-900">{batch.remainingTransactions} transactions remain after this group.</p>}
      {batch.blocked.map((value, index) => <p key={index} className="text-sm text-amber-900">{value.reason}</p>)}
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Technical details</summary><div className="mt-4 grid gap-4 text-xs text-muted-foreground"><dl className="grid gap-2"><div><dt>Wallet group</dt><dd className="break-all font-mono">{batch.id}</dd></div><div><dt>Signing network</dt><dd>NEAR {batch.network}</dd></div><div><dt>Eligible accounts</dt><dd className="break-all">{batch.signerAccounts.join(", ")}</dd></div><div><dt>Total attached gas</dt><dd>{formatUnits(batch.gas, 12)} Tgas</dd></div></dl>{batch.entries.map(entry => <dl key={entry.paymentId} className="grid gap-2 border-t pt-3"><div><dt className="font-medium text-foreground">{entry.recipientName} · {usd(entry.entitlement)} net obligation</dt><dd className="mt-1 break-all">Asset: {entry.asset}</dd></div><div><dt>Attempt</dt><dd className="break-all font-mono">{entry.attemptId}</dd></div><div><dt>Quote</dt><dd className="break-all font-mono">{entry.quoteHash}</dd></div>{entry.approvals && <p>Policy {entry.approvals.policy_version}</p>}</dl>)}{batch.transactions.map((value, index) => <div key={index} className="grid gap-2 border-t pt-3"><p className="font-medium">Transaction {index + 1}: {value.action.actions.map(action => action.params.methodName).join(", ")}</p><Address value={value.action.receiverId} network={batch.network} /><p>{formatUnits(value.action.actions.reduce((sum, action) => sum + BigInt(action.params.gas), 0n).toString(), 12)} Tgas · {formatUnits(value.action.actions.reduce((sum, action) => sum + BigInt(action.params.deposit), 0n).toString(), 24)} NEAR deposit</p></div>)}</div></details>
      {batch.status === "review" ? canSignBatch ? <><label className="flex items-center gap-3 border-t pt-5 text-sm"><input type="checkbox" disabled={!!busy} checked={confirmedBatch === batch.id} onChange={event => setConfirmedBatch(event.target.checked ? batch.id : "")} />I confirm these payment details</label><Action className="min-h-11" busy={busy === "sign"} disabled={!!busy || confirmedBatch !== batch.id} onClick={() => void sign()}>{stageLabel[batch.stage]}</Action></> : <p className="text-sm text-amber-900">{batch.stage === "approve" ? "Approver required" : "Payment operator required"}</p> : ["signing", "reconciling"].includes(batch.status) ? <><p className="text-sm text-amber-900">Wallet result pending. Reconcile before another transfer.</p><Action busy={busy === "reconcile-batch"} disabled={!!busy} onClick={() => void run("reconcile-batch", () => reconcile())}>Reconcile wallet group</Action><form className="grid gap-3 sm:grid-cols-3" onSubmit={event => { event.preventDefault(); void run("receipt", async () => { await reconcile([{ index: Number(receipt.index), hash: receipt.hash.trim() }]); setReceipt(value => ({ ...value, hash: "" })); }); }}><Field label="Transaction"><select className={control} disabled={!!busy} value={receipt.index} onChange={event => setReceipt(value => ({ ...value, index: event.target.value }))}>{batch.transactions.map((_, index) => <option key={index} value={index}>Transaction {index + 1}</option>)}</select></Field><Field label="Wallet transaction hash"><input className={control} disabled={!!busy} required minLength={32} maxLength={64} value={receipt.hash} onChange={event => setReceipt(value => ({ ...value, hash: event.target.value }))}/></Field><Action type="submit" busy={busy === "receipt"} disabled={!!busy}>Verify saved receipt</Action></form></> : <p className="text-sm text-amber-900">Route planning was interrupted. Cancel this group to resume.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {canSignBatch && ["planning", "review"].includes(batch.status) && <button type="button" disabled={!!busy} className="justify-self-center text-sm text-muted-foreground disabled:opacity-50" onClick={() => void run("cancel", async () => { await api(`${batchPath}/cancel`, {}); refresh(); })}>Discard review</button>}
    </div>}
  </TaskDrawer></>;
}

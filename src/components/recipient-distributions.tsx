"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { WalletButtons } from "@/components/auth/sign-in-panel";
import { AssetIdentity } from "@/components/assets/asset-identity";
import type { ownDistributionClaims, inspectOwnClaim, prepareOwnClaim } from "@/server/distributions/service";
import { useAction, useResource } from "./workspace/hooks";
import { Action, Address, Empty, Panel, Status } from "./workspace/shared";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./workspace/task-drawer";

type Claim = ReturnType<typeof ownDistributionClaims>["claims"][number];
type Plan = Awaited<ReturnType<typeof prepareOwnClaim>>;

export function RecipientDistributions({ revision = 0 }: { revision?: number }) {
  const [refresh, setRefresh] = useState(0), [page, setPage] = useState(1), [selected, setSelected] = useState<Claim | null>(null);
  const [preview, setPreview] = useState<{ claim: Claim; plan: Plan } | null>(null), [confirmed, setConfirmed] = useState(false), [notice, setNotice] = useState("");
  const base = "/recipient-distributions", reload = () => setRefresh(value => value + 1);
  const history = useResource<ReturnType<typeof ownDistributionClaims>>(`${base}?page=${page}`, revision + refresh);
  const detail = useResource<Awaited<ReturnType<typeof inspectOwnClaim>>>(selected ? `${base}/${selected.id}` : null, revision + refresh);
  const { busy, error, run, setError } = useAction();
  const selectedId = useRef(selected?.id); selectedId.current = selected?.id;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const drawer = document.getElementById("recipient-distribution-review");
    const closed = () => { if (drawer?.dataset.walletSuspended !== "true") { setPreview(null); setConfirmed(false); } };
    drawer?.addEventListener("close", closed);
    if (preview) openTaskDrawer("recipient-distribution-review"); else closeTaskDrawer("recipient-distribution-review", true);
    return () => drawer?.removeEventListener("close", closed);
  }, [preview]);
  const blocked = !!busy || detail.refreshing || !!detail.error;
  const current = detail.data, record = history.data?.claims.find(item => item.id === selected?.id) ?? selected;
  function choose(value: Claim | null) { setSelected(value); setPreview(null); setConfirmed(false); setNotice(""); setError(""); }
  async function prepare() {
    if (!selected || blocked) return;
    const claim = selected;
    await run("prepare-claim", async () => {
      const plan = await api<Plan>(`${base}/${claim.id}/prepare`, {});
      if (!mounted.current || selectedId.current !== claim.id) return;
      setConfirmed(false); setPreview({ claim, plan });
    });
  }
  async function sign() {
    if (!preview || !confirmed || blocked) return;
    const { claim, plan } = preview;
    await run("sign-claim", async () => {
      try {
        const result = await withTaskDrawerWallet(() => signNearActionBatch(plan.walletActions as NearWalletAction[], plan.network!, plan.eligibleSigners, signerAccount => api(`${base}/${claim.id}/begin`, { signerAccount, planHash: plan.planHash, reviewGeneration: plan.reviewGeneration, retrySameClaim: plan.retrySameClaim }).then(() => {})));
        if (plan.phase === "claim" && result.receipts[0]?.hash) await api(`${base}/${claim.id}/receipt`, { transactionHash: result.receipts[0].hash, reviewGeneration: plan.reviewGeneration });
        setNotice(plan.phase === "registration" ? "Storage request submitted. Refresh to review the claim once registration is final." : "Wallet response received. Refresh to verify delivery on NEAR.");
      } finally {
        try { await api(`${base}/${claim.id}/finish-wallet`, { reviewGeneration: plan.reviewGeneration }); }
        catch { setNotice("Wallet lease is still active. Refresh this claim after it expires; do not create another payment."); }
        closeTaskDrawer("recipient-distribution-review", true); setPreview(null); setConfirmed(false); reload();
      }
    });
  }
  return <Panel title="Distributions" tone="white">
    <div className="grid min-w-0 gap-5">
      <div className="flex items-center justify-between gap-3">{selected ? <button type="button" disabled={!!busy} className="inline-flex items-center gap-2 text-sm text-muted-foreground" onClick={() => choose(null)}><ArrowLeft size={16}/> All distributions</button> : <AssetIdentity symbol="USDC" network="near"/>}<button type="button" className="text-sm text-primary" disabled={!!busy || history.refreshing || detail.refreshing} onClick={reload}>Refresh</button></div>
      {!selected && <>
        {history.loading ? <Empty>Loading distributions...</Empty> : history.data?.claims.length ? <div className="divide-y overflow-hidden rounded-2xl border bg-white">{history.data.claims.map(item => <button key={item.id} type="button" disabled={!!busy} className="flex w-full items-center gap-4 p-5 text-left hover:bg-muted/50" onClick={() => choose(item)}><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.reference}</p><p className="mt-1 text-xs text-muted-foreground">{item.company}</p></div><div className="text-right"><p className="mb-1 font-medium tabular-nums">{usd(item.amount)}</p><Status value={item.sourceUnknown ? "unknown" : item.status}/></div><ChevronRight size={16}/></button>)}</div> : !history.error && <Empty>No distribution allocations yet.</Empty>}
        {history.data && (page > 1 || history.data.hasMore) && <div className="flex items-center justify-between gap-3 text-sm"><button type="button" disabled={page <= 1 || !!busy || history.refreshing} onClick={() => setPage(value => value - 1)}>Previous</button><span className="text-xs text-muted-foreground">Page {page}</span><button type="button" disabled={!history.data.hasMore || !!busy || history.refreshing} onClick={() => setPage(value => value + 1)}>Next</button></div>}
        {history.error && <p role="alert" className="text-sm text-destructive">{history.error}</p>}
      </>}
      {selected && <>
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-lg font-medium">{selected.reference}</h3><p className="mt-1 text-sm text-muted-foreground">{selected.company}</p></div><Status value={current?.claim?.status ?? record?.status ?? selected.status}/></div>
        {detail.loading ? <Empty>Checking claim...</Empty> : current && <>
          <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs text-muted-foreground">Your allocation</p><p className="mt-1 text-3xl font-medium tabular-nums">{usd(current.amount)}</p></div><AssetIdentity symbol="USDC" network="near"/></div>
          <div className="grid gap-4 rounded-2xl bg-muted/60 p-4 sm:grid-cols-2"><div className="min-w-0"><p className="mb-2 text-xs text-muted-foreground">Fixed receiving account</p><Address value={current.address} network={current.network ?? undefined}/></div><div><p className="text-xs text-muted-foreground">Claim deadline</p><p className="mt-2 text-sm">{new Date(current.deadline ?? selected.deadline).toLocaleString()}</p></div></div>
          {current.problems.length > 0 && <div className="grid gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{current.problems.map(problem => <p key={problem}>{problem}</p>)}</div>}
          {current.sourceUnknown && <p className="text-xs text-amber-900">Original outcome unresolved. Only this same fixed claim can be retried.</p>}
          {!!current.walletLeaseExpiresAt && Date.parse(current.walletLeaseExpiresAt) > Date.now() && <p className="text-xs text-muted-foreground">Wallet review active until {new Date(current.walletLeaseExpiresAt).toLocaleTimeString()}. Finish that wallet request before reviewing again.</p>}
          {current.eligibleSigners.length ? <Action className="justify-self-start" type="button" disabled={blocked || current.problems.length > 0} busy={busy === "prepare-claim"} onClick={() => void prepare()}>{current.sourceUnknown ? "Review same-claim retry" : "Review claim"}</Action> : <div className="grid gap-3"><p className="text-sm">Connect a NEAR wallet to pay claim gas.</p><WalletButtons link onComplete={async () => reload()}/></div>}
          <details className="border-t pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Allocation record</summary><div className="mt-3 grid gap-3"><Address value={selected.id} label="claim ID"/>{record?.reportedTransaction && <><p>Wallet-reported transaction, not delivery evidence</p><Address value={record.reportedTransaction} label="reported transaction hash"/></>}</div></details>
        </>}
        {detail.error && <p role="alert" className="text-sm text-destructive">{detail.error}</p>}
      </>}
      {notice && <p role="status" className="text-sm">{notice}</p>}{error && !preview && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <TaskDrawer id="recipient-distribution-review" title={preview?.plan.phase === "registration" ? "Register receiving account" : preview?.plan.retrySameClaim ? "Retry original claim" : "Review claim"}>
      {preview && <div className="grid min-w-0 gap-5" aria-busy={!!busy}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">{preview.claim.reference}</p><p className="mt-1 text-xs text-muted-foreground">{preview.claim.company}</p></div><AssetIdentity symbol="USDC" network="near"/></div>
        <div><p className="text-xs text-muted-foreground">{preview.plan.phase === "registration" ? "Allocation after registration" : "You receive"}</p><p className="mt-1 text-3xl font-medium tabular-nums">{usd(preview.plan.amount)}</p></div>
        <div><p className="mb-2 text-xs text-muted-foreground">Fixed destination · NEAR {preview.plan.network}</p><Address value={preview.plan.address} network={preview.plan.network ?? undefined} full/></div>
        <dl className="grid grid-cols-2 gap-4 rounded-2xl bg-muted/60 p-4 text-sm"><div><dt className="text-xs text-muted-foreground">Claim deadline</dt><dd className="mt-1">{new Date(preview.plan.deadline ?? preview.claim.deadline).toLocaleString()}</dd></div><div><dt className="text-xs text-muted-foreground">Review expires</dt><dd className="mt-1">{new Date(preview.plan.reviewExpiresAt).toLocaleTimeString()}</dd></div><div><dt className="text-xs text-muted-foreground">Storage deposit</dt><dd className="mt-1">{formatUnits(preview.plan.registrationDeposit, 24)} NEAR</dd></div><div><dt className="text-xs text-muted-foreground">Gas limit</dt><dd className="mt-1">{formatUnits(preview.plan.walletActions.flatMap(transaction => transaction.actions).reduce((total, action) => total + BigInt(action.params.gas), 0n).toString(), 12)} Tgas</dd></div></dl>
        {preview.plan.phase === "registration" && <p className="text-sm">This registers USDC storage only. Review the claim again after confirmation.</p>}
        {preview.plan.retrySameClaim && <p className="rounded-xl bg-amber-50 p-4 text-xs leading-5 text-amber-900">Retry the original claim with additional gas. Pending or paid claims cannot pay twice; the destination stays fixed.</p>}
        <p className="text-xs text-muted-foreground">Your signing wallet pays gas and any storage deposit. The recipient and amount are public on NEAR.</p>
        <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Transaction details</summary><div className="mt-3 grid gap-4">{preview.plan.walletActions.map((transaction, index) => <div key={index} className="grid min-w-0 gap-2"><Address value={transaction.receiverId} network={preview.plan.network ?? undefined} label="contract"/>{transaction.actions.map((action, actionIndex) => <p key={actionIndex} className="break-words">{action.params.methodName} · {formatUnits(action.params.gas, 12)} Tgas · {formatUnits(action.params.deposit, 24)} NEAR attached</p>)}</div>)}<p>The company supplies the token transfer's 1 yoctoNEAR deposit. Gas limit is not the final fee.</p><Address value={preview.plan.planHash} label="plan hash"/></div></details>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)}/>I confirm this fixed allocation, public destination, deadline and wallet costs.</label>
        <Action type="button" disabled={blocked || !confirmed || Date.parse(preview.plan.reviewExpiresAt) <= Date.now()} busy={busy === "sign-claim"} onClick={() => void sign()}>{preview.plan.phase === "registration" ? "Register in wallet" : preview.plan.retrySameClaim ? "Retry in wallet" : "Claim in wallet"}</Action>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>}
    </TaskDrawer>
  </Panel>;
}

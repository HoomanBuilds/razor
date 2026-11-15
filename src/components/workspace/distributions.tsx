"use client";

import { useEffect, useRef, useState } from "react";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./task-drawer";
import { api } from "@/lib/api";
import { microUsd, usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { AssetIdentity } from "@/components/assets/asset-identity";
import type { inspectDistribution, listDistributions, prepareDistribution, prepareDistributionControl } from "@/server/distributions/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Status } from "./shared";

type List = ReturnType<typeof listDistributions>;
type Detail = Awaited<ReturnType<typeof inspectDistribution>>;
type Preview = (Awaited<ReturnType<typeof prepareDistribution>> | Awaited<ReturnType<typeof prepareDistributionControl>>) & { id: string };

export function DistributionsPanel() {
  const { base, organization, session, revision, refresh, navigate } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read"), canPrepare = !!organization.permissions?.includes("payments:prepare");
  const owner = organization.owner_id === session.user.id && !!organization.permissions?.includes("company:manage");
  const [page, setPage] = useState(1), [selected, setSelected] = useState(""), [preview, setPreview] = useState<Preview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [items, setItems] = useState([{ key: "first", recipientId: "", amount: "" }]), [notice, setNotice] = useState("");
  const requestKey = useRef("");
  const resource = useResource<List>(canRead ? `${base}/distributions?page=${page}` : null, revision);
  const detail = useResource<{ distribution: Detail }>(canRead && selected ? `${base}/distributions/${selected}` : null, revision);
  const { busy, error, run, setError } = useAction(), current = detail.data?.distribution;
  const locked = !!busy || resource.refreshing || !!resource.error;
  const selectedLocked = locked || detail.refreshing || !!detail.error;
  const [reviewedPool, setReviewedPool] = useState<Detail | null>(null);
  let draftTotal: string | null = null;
  try { draftTotal = items.reduce((total, item) => total + BigInt(microUsd(item.amount)), 0n).toString(); } catch {}
  const walletCosts = preview?.walletActions.reduce((total, transaction) => transaction.actions.reduce((sum, action) => ({ gas: sum.gas + BigInt(action.params.gas), deposit: sum.deposit + BigInt(action.params.deposit) }), total), { gas: 0n, deposit: 0n });
  const previewTitle = !preview ? "Review distribution" : preview.phase === "fund" ? "Fund distribution" : preview.phase === "recipients" ? "Set up recipients" : preview.phase === "reclaim" ? "Return unclaimed funds" : preview.phase === "approve" ? "Approve distribution" : "Cancel distribution";
  useEffect(() => {
    const dialog = document.getElementById("distribution-wallet-review");
    const close = () => { if (dialog?.dataset.walletSuspended !== "true") { setPreview(null); setConfirmed(false); } };
    dialog?.addEventListener("close", close);
    if (preview) openTaskDrawer("distribution-wallet-review");
    else closeTaskDrawer("distribution-wallet-review", true);
    return () => dialog?.removeEventListener("close", close);
  }, [preview]);
  const review = (value: Preview) => { setReviewedPool(current ?? null); setPreview(value); setConfirmed(false); setNotice(""); };
  const sign = () => run("distribution-sign", async () => {
    if (!preview || !confirmed) return;
    try {
      const result = await withTaskDrawerWallet(() => signNearActionBatch(preview.walletActions as NearWalletAction[], preview.network, preview.eligibleSigners, async signerAccount => {
        if (preview.phase === "fund") await api(`${base}/distributions/${preview.id}/begin`, { signerAccount, planHash: preview.planHash });
      }));
      const reference = result.receipts[0]?.hash;
      if (preview.phase === "fund" && reference) await api(`${base}/distributions/${preview.id}/receipt`, { transactionHash: reference });
      setNotice(result.complete ? "Wallet results returned. Refresh the pool to observe final NEAR state; a wallet result alone is not a claim or delivery receipt." : "The wallet returned an incomplete result. Inspect the existing pool before continuing.");
    } finally { closeTaskDrawer("distribution-wallet-review", true); setPreview(null); setConfirmed(false); refresh(); }
  });
  if (!canRead) return null;
  return <section className="grid min-w-0 gap-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-medium">Distributions</h2>{canPrepare && !selected && <Action type="button" disabled={locked} onClick={() => { setError(""); setNotice(""); openTaskDrawer("distribution-create-flow"); }}>New distribution</Action>}</header>
    <div className="grid min-w-0 grid-cols-1 gap-5">
      {!selected && resource.data && !resource.data.configured && <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><p className="text-muted-foreground">Treasury setup required before funding.</p><button type="button" className="min-h-10 text-primary" onClick={() => navigate("treasury")}>Open treasury</button></div>}
      {canPrepare && <TaskDrawer id="distribution-create-flow" title="New distribution"><div aria-busy={!!busy}><form className="grid min-w-0 grid-cols-1 gap-5" onChange={() => { requestKey.current = ""; }} onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
        void run("create-distribution", async () => {
          requestKey.current ||= crypto.randomUUID();
          const response = await api<{ distribution: { id: string } }>(`${base}/distributions`, { reference: values.get("reference"), deadline: new Date(String(values.get("deadline"))).toISOString(), requestKey: requestKey.current, items: items.map(item => ({ recipientId: item.recipientId, amount: microUsd(item.amount) })) });
          setSelected(response.distribution.id);closeTaskDrawer("distribution-create-flow",true); setNotice("Distribution draft saved."); requestKey.current = ""; setItems([{ key: crypto.randomUUID(), recipientId: "", amount: "" }]); form.reset(); refresh();
        });
      }}>
        <fieldset disabled={locked} className="grid min-w-0 grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2">
          <Field label="Reference"><input name="reference" className={control} required maxLength={100} placeholder="Community grants" /></Field>
          <Field label="Claim deadline (your local time)"><input name="deadline" type="datetime-local" className={control} required /></Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">Public allocations. After the deadline, only unclaimed funds can return to company cash; pending transfers stay protected.</p>
          {items.map((item, index) => <div key={item.key} className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border border-border bg-white p-4 sm:col-span-2 sm:grid-cols-2">
            <Field label={`Recipient ${index + 1}`}><select className={control} required value={item.recipientId} onChange={event => setItems(previous => previous.map(value => value.key === item.key ? { ...value, recipientId: event.target.value } : value))}><option value="">Choose a NEAR recipient</option>{resource.data?.recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></Field>
            <Field label="Amount (USDC)"><input className={control} required inputMode="decimal" value={item.amount} onChange={event => setItems(previous => previous.map(value => value.key === item.key ? { ...value, amount: event.target.value } : value))} /></Field>
            <button type="button" className="w-fit text-xs text-primary disabled:opacity-50" disabled={items.length === 1} onClick={() => { requestKey.current = ""; setItems(previous => previous.filter(value => value.key !== item.key)); }}>Remove</button>
          </div>)}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5 sm:col-span-2"><div><p className="text-xs text-muted-foreground">Total USDC</p><p className="mt-1 text-xl font-medium tabular-nums">{draftTotal === null ? "Enter amounts" : usd(draftTotal)}</p></div><Action type="button" className="bg-transparent text-primary shadow-none hover:bg-muted" disabled={items.length >= 64} onClick={() => { requestKey.current = ""; setItems(previous => [...previous, { key: crypto.randomUUID(), recipientId: "", amount: "" }]); }}>Add recipient</Action><Action busy={busy === "create-distribution"} disabled={locked || !resource.data?.recipients.length || draftTotal === null}>Save draft</Action></div>
        </fieldset>
      </form>{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}</div></TaskDrawer>}
      {!selected ? <>{resource.loading ? <Empty>Loading distributions...</Empty> : resource.data?.distributions.length ? <div className="divide-y rounded-3xl border px-5">{resource.data.distributions.map(value => <button key={value.id} type="button" disabled={selectedLocked} className="flex w-full items-center justify-between gap-4 py-5 text-left" onClick={() => { setSelected(value.id); setPreview(null); setError(""); setNotice(""); }}><span className="min-w-0"><span className="block text-sm font-medium">{value.reference}</span><span className="mt-2 block text-xs text-muted-foreground">{value.payload.items.length} recipients · {new Date(value.payload.deadline).toLocaleDateString()}</span></span><span className="shrink-0 text-right"><span className="mb-2 block font-medium tabular-nums">{usd(value.total_amount)} USDC</span><Status value={value.chain_status ?? value.stage}/></span></button>)}</div> : !resource.error && <Empty>No distributions yet.</Empty>}{resource.data && (page > 1 || resource.data.hasMore) && <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><button type="button" className="min-h-10 text-primary disabled:opacity-50" disabled={locked || page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span className="text-xs">Page {page}</span><button type="button" className="min-h-10 text-primary disabled:opacity-50" disabled={locked || !resource.data.hasMore} onClick={() => setPage(value => value + 1)}>Next</button></div>}</> : <><button type="button" className="w-fit min-h-10 text-sm text-primary" disabled={!!busy} onClick={() => { setSelected(""); setPreview(null); setError(""); setNotice(""); }}>Back to distributions</button>{detail.loading ? <Empty>Loading distribution...</Empty> : !current && !detail.error ? <Empty>Distribution unavailable.</Empty> : null}</>}
      {current && <div className="grid min-w-0 grid-cols-1 gap-4 rounded-2xl border border-border bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="text-xl font-medium">{current.reference}</h3><Status value={current.chain_status ?? current.stage}/></div><AssetIdentity symbol="USDC" network="near"/>
        <div><p className="text-xs text-muted-foreground">Total allocation</p><p className="mt-2 text-3xl font-medium tabular-nums">{usd(current.total_amount)}</p><p className="mt-3 text-xs text-muted-foreground">Claim deadline {new Date(current.payload.deadline).toLocaleString()}</p></div>
        <dl className="grid grid-cols-2 gap-5">{[["Funding reserved", current.local_reserved], ["Unclaimed on NEAR", current.chain_reserved], ["Pending transfers", current.pending_amount], ["Confirmed paid", current.paid_amount], ["Returned to company", current.reclaimed_amount]].filter(([, value]) => BigInt(value) !== 0n).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 font-medium tabular-nums">{usd(value)}</dd></div>)}</dl>
        {current.chain && <p className="text-sm">Approvals {current.chain.approvals.length}/{current.chain.required_approvals}</p>}
        <details className="border-t pt-4 text-xs"><summary className="cursor-pointer">Storage & transaction details</summary><div className="mt-4 grid gap-4">{current.storage && <dl className="grid grid-cols-2 gap-4"><div><dt className="text-muted-foreground">Company storage credit</dt><dd className="mt-1">{formatUnits(current.storage.storage_credit, 24)} NEAR</dd></div><div><dt className="text-muted-foreground">Storage used</dt><dd className="mt-1">{formatUnits(current.storage.storage_used, 24)} NEAR</dd></div></dl>}{current.source_tx_hash && <div><p className="mb-2 text-muted-foreground">Reported creation transaction · unverified</p><Address value={current.source_tx_hash} label="creation transaction hash"/></div>}{current.chain && <div><p className="mb-2 text-muted-foreground">Authorization commitment · policy {current.chain.policy_version}</p><Address value={current.chain.terms_hash} label="authorization commitment"/></div>}<button type="button" className="w-fit min-h-10 text-primary" onClick={() => navigate("treasury")}>Open treasury</button></div></details>
        {current.problems.map(problem => <p key={problem} className="text-sm text-amber-900">{problem}</p>)}
        {current.last_error && <p role="alert" className="text-sm text-amber-900">{current.last_error}</p>}
        <div className="divide-y border-y">{current.payload.items.map(item => <div key={item.claimId} className="grid gap-3 py-4"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="break-words text-sm font-medium">{item.name}</p><div className="mt-2"><Status value={current.chain?.claims.find(claim => claim.allocation.claim_id === item.claimId)?.status ?? "unfunded"}/></div></div><p className="shrink-0 font-medium tabular-nums">{usd(item.amount)}</p></div><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Receiving details</summary><div className="mt-3 grid gap-3"><Address value={item.address} network={current.network ?? organization.near_network} full/><div><p className="mb-2 text-muted-foreground">Claim ID</p><Address value={item.claimId} label="claim ID"/></div></div></details></div>)}</div>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="min-h-10 text-sm text-primary" disabled={!!busy} onClick={refresh}>Refresh status</button>
          {owner && ["draft", "review"].includes(current.stage) && <Action type="button" disabled={selectedLocked} busy={busy === "prepare-pool"} onClick={() => void run("prepare-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistribution>>>(`${base}/distributions/${current.id}/prepare`, {}), id: current.id }))}>Review funding</Action>}
          {canPrepare && current.stage === "draft" && <Action type="button" className="border bg-white text-foreground hover:bg-muted" disabled={selectedLocked} onClick={() => void run("discard-pool", async () => { await api(`${base}/distributions/${current.id}`, undefined, "DELETE"); refresh(); })}>Cancel draft</Action>}
          {owner && current.stage === "review" && !current.chain && <Action type="button" className="border bg-white text-foreground hover:bg-muted" disabled={selectedLocked} onClick={() => void run("release-review", async () => { await api(`${base}/distributions/${current.id}/release-review`, {}); setPreview(null); setNotice("Unsigned review cancelled and its local reservation released without a transaction. This creation identity stays retired."); refresh(); })}>Release unsigned review</Action>}
          {current.chain?.status === "proposed" && organization.permissions?.includes("payments:approve") && session.wallets.filter(wallet => wallet.family === "near" && wallet.network === current.network && current.policy && [current.policy.owner_id, ...current.policy.approvers].includes(wallet.address) && !current.chain!.approvals.includes(wallet.address)).map(wallet => <Action key={wallet.id} type="button" disabled={selectedLocked} onClick={() => void run("approve-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "approve", accountId: wallet.address }), id: current.id }))}>Approve as {wallet.address}</Action>)}
          {owner && current.plan_hash && !current.chain && current.stage === "signing" && <Action type="button" className="border bg-white text-foreground hover:bg-muted" disabled={selectedLocked} onClick={() => void run("void-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "void" }), id: current.id }))}>Cancel pending creation</Action>}
          {owner && current.chain?.status === "proposed" && <Action type="button" className="border bg-white text-foreground hover:bg-muted" disabled={selectedLocked} onClick={() => void run("void-proposal", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "void" }), id: current.id }))}>Cancel proposal</Action>}
          {owner && current.chain && Number(current.chain.deadline_ms) <= Date.now() && BigInt(current.chain.unclaimed) > 0n && <Action type="button" disabled={selectedLocked} onClick={() => void run("reclaim-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "reclaim" }), id: current.id }))}>Return unclaimed funds</Action>}
        </div>
        {current.stage === "signing" && !current.chain && <p className="text-xs text-muted-foreground">Creation unresolved. Funds remain reserved until the original creation is resolved or voided on NEAR.</p>}
      </div>}
      <TaskDrawer id="distribution-wallet-review" title={previewTitle} description={reviewedPool?.reference}>{preview && reviewedPool && <div aria-busy={!!busy} className="grid gap-5">
        <AssetIdentity symbol="USDC" network="near"/><div><p className="text-xs text-muted-foreground">{preview.phase === "reclaim" ? "Unclaimed return" : "Fixed pool entitlement"}</p><p className="mt-2 text-3xl font-medium tabular-nums">{usd(preview.phase === "reclaim" ? reviewedPool.chain?.unclaimed ?? "0" : preview.total)}</p></div>
        <p className="text-sm">Claim deadline {new Date(reviewedPool.payload.deadline).toLocaleString()}</p>
        {preview.phase === "recipients" && <p className="text-xs text-muted-foreground">{preview.remainingProfiles} profiles need setup. This group updates up to five; funding follows separately.</p>}
        {preview.phase === "fund" && <p className="text-xs text-muted-foreground">{preview.requiredApprovals} wallet approvals including the owner. Funding reserves when quorum is complete.</p>}
        <p className="text-xs text-muted-foreground">Allocations are public and fixed. Only unclaimed funds return after the deadline; pending transfers stay protected.</p>
        <div className="divide-y rounded-xl border px-4">{reviewedPool.payload.items.map(item => <div key={item.claimId} className="grid gap-2 py-4"><div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{item.name}</span><span className="tabular-nums">{usd(item.amount)}</span></div><Address value={item.address} network={preview.network} full/></div>)}</div>
        <dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-muted-foreground">Attached gas</dt><dd className="mt-2">{formatUnits((walletCosts?.gas ?? 0n).toString(), 12)} Tgas</dd></div><div><dt className="text-xs text-muted-foreground">Attached deposit</dt><dd className="mt-2 break-all">{formatUnits((walletCosts?.deposit ?? 0n).toString(), 24)} NEAR</dd></div></dl>
        <p className="text-xs text-muted-foreground">Signing and claim wallets pay gas. Company storage must be prepaid; the treasury covers the token call's 1 yoctoNEAR deposit.</p>
        <details className="border-t pt-4 text-xs"><summary className="cursor-pointer">Exact wallet actions · NEAR {preview.network}</summary><pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-muted p-3">{JSON.stringify(preview.walletActions, null, 2)}</pre></details>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={selectedLocked} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/><span>I confirm the allocations, destinations, deadline, public visibility and wallet costs.</span></label>
        <Action type="button" disabled={selectedLocked || !confirmed} busy={busy === "distribution-sign"} onClick={() => void sign()}>Confirm in NEAR wallet</Action>
        {(error || detail.error) && <p role="alert" className="text-sm text-destructive">{error || detail.error}</p>}
      </div>}</TaskDrawer>
      {notice && <p role="status" className="text-sm">{notice}</p>}{(error || resource.error || detail.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error || detail.error}</p>}
    </div>
  </section>;
}

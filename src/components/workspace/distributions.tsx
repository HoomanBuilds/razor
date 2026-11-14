"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { microUsd, usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { AssetIdentity } from "@/components/assets/asset-identity";
import type { inspectDistribution, listDistributions, prepareDistribution, prepareDistributionControl } from "@/server/distributions/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, DataTable, Empty, Field, Panel, Status } from "./shared";

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
  const { busy, error, run } = useAction(), current = detail.data?.distribution;
  const review = (value: Preview) => { setPreview(value); setConfirmed(false); setNotice(""); };
  const sign = () => run("distribution-sign", async () => {
    if (!preview || !confirmed) return;
    try {
      const result = await signNearActionBatch(preview.walletActions as NearWalletAction[], preview.network, preview.eligibleSigners, async signerAccount => {
        if (preview.phase === "fund") await api(`${base}/distributions/${preview.id}/begin`, { signerAccount, planHash: preview.planHash });
      });
      const reference = result.receipts[0]?.hash;
      if (preview.phase === "fund" && reference) await api(`${base}/distributions/${preview.id}/receipt`, { transactionHash: reference });
      setNotice(result.complete ? "Wallet results returned. Refresh the pool to observe final NEAR state; a wallet result alone is not a claim or delivery receipt." : "The wallet returned an incomplete result. Inspect the existing pool before continuing.");
    } finally { setPreview(null); setConfirmed(false); refresh(); }
  });
  if (!canRead) return null;
  return <Panel title="Optional claimable distributions" tone="white" description="Native USDC pools for grants and distributions. Payroll stays separate." help="Create a separate native-USDC grant or distribution pool. Ordinary push payroll stays separate and does not require recipient claim gas.">
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <p className="text-xs leading-5 text-muted-foreground">{resource.data?.privacy ?? "Allocation accounts and amounts are public in NEAR transactions. Claiming always pays the exact approved destination. Cross-chain claims are unavailable."} This does not convert or settle an existing payroll obligation.</p>
      <button type="button" className="w-fit text-sm text-primary" onClick={() => navigate("treasury")}>Open Treasury for funding, authority or company storage top-up</button>
      {resource.data && !resource.data.configured && <p className="text-sm text-muted-foreground">You can prepare a draft now. Native setup, owner authorization, confirmed USDC backing and sufficient company storage are required before claims become available.</p>}
      {canPrepare && <details className="min-w-0 rounded-2xl border border-border bg-white p-5"><summary className="cursor-pointer text-sm font-medium">Create an independent claimable pool</summary><form className="mt-4 grid min-w-0 grid-cols-1 gap-4" onChange={() => { requestKey.current = ""; }} onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
        void run("create-distribution", async () => {
          requestKey.current ||= crypto.randomUUID();
          const response = await api<{ distribution: { id: string } }>(`${base}/distributions`, { reference: values.get("reference"), deadline: new Date(String(values.get("deadline"))).toISOString(), requestKey: requestKey.current, items: items.map(item => ({ recipientId: item.recipientId, amount: microUsd(item.amount) })) });
          setSelected(response.distribution.id); setNotice("Independent distribution draft saved. It has no funded claim authority yet."); requestKey.current = ""; refresh();
        });
      }}>
        <fieldset disabled={!!busy} className="grid min-w-0 grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2">
          <Field label="Distribution reference"><input name="reference" className={control} required maxLength={100} placeholder="COMMUNITY-GRANT-01" /></Field>
          <Field label="Claim deadline (your local time)"><input name="deadline" type="datetime-local" className={control} required /></Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">After this deadline, the owner may return only genuinely unclaimed USDC to company cash. Pending transfers stay protected. Destination and entitlement cannot be edited after authorization.</p>
          {items.map((item, index) => <div key={item.key} className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border border-border bg-white p-4 sm:col-span-2 sm:grid-cols-2">
            <Field label={`Native USDC payee ${index + 1}`}><select className={control} required value={item.recipientId} onChange={event => setItems(previous => previous.map(value => value.key === item.key ? { ...value, recipientId: event.target.value } : value))}><option value="">Choose a confirmed native payee</option>{resource.data?.recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></Field>
            <Field label="Fixed entitlement (USDC)"><input className={control} required inputMode="decimal" value={item.amount} onChange={event => setItems(previous => previous.map(value => value.key === item.key ? { ...value, amount: event.target.value } : value))} /></Field>
            <button type="button" className="w-fit text-xs text-primary disabled:opacity-50" disabled={items.length === 1} onClick={() => setItems(previous => previous.filter(value => value.key !== item.key))}>Remove allocation</button>
          </div>)}
          <div className="flex flex-wrap gap-3 sm:col-span-2"><Action type="button" disabled={items.length >= 64} onClick={() => setItems(previous => [...previous, { key: crypto.randomUUID(), recipientId: "", amount: "" }])}>Add allocation</Action><Action busy={busy === "create-distribution"} disabled={!resource.data?.recipients.length}>Save unfunded distribution draft</Action></div>
        </fieldset>
      </form></details>}
      {resource.loading ? <Empty>Loading distribution history...</Empty> : !resource.data?.distributions.length ? <Empty>No independent claim pools on this page. Use ordinary payroll for push payments.</Empty> : <DataTable columns={["Pool", "Entitlement", "State", "Inspect"]}>{resource.data.distributions.map(value => <tr key={value.id}><td><strong>{value.reference}</strong><p className="text-xs">{value.payload.items.length} allocations</p></td><td>{usd(value.total_amount)} USDC<p className="text-xs">Deadline {new Date(value.payload.deadline).toLocaleString()}</p></td><td><Status value={value.chain_status ?? value.stage} /><p className="text-xs">Locally fenced {usd(value.local_reserved)}</p></td><td><button type="button" className="text-primary" onClick={() => { setSelected(value.id); setPreview(null); }}>Inspect fixed pool</button></td></tr>)}</DataTable>}
      {resource.data && resource.data.total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 text-xs"><Action type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous pools</Action><span>Page {page}</span><Action type="button" disabled={!resource.data.hasMore} onClick={() => setPage(value => value + 1)}>Next pools</Action></div>}
      {detail.loading && <Empty>Checking the selected pool...</Empty>}
      {current && <div className="grid min-w-0 grid-cols-1 gap-4 rounded-2xl border border-border bg-white p-5">
        <h3 className="font-medium">{current.reference}</h3><AssetIdentity symbol="USDC" network="near" /><p className="text-sm">Fixed total {formatUnits(current.total_amount, 6)} USDC ({usd(current.total_amount)}). Deadline {new Date(current.payload.deadline).toLocaleString()}.</p>
        <div className="grid grid-cols-2 gap-3 text-xs"><p>Local funding fence<br />{usd(current.local_reserved)}</p><p>Unclaimed on NEAR<br />{usd(current.chain_reserved)}</p><p>Pending native transfers<br />{usd(current.pending_amount)}</p><p>Paid by token callback<br />{usd(current.paid_amount)}</p><p>Returned to company cash<br />{usd(current.reclaimed_amount)}</p></div>
        {current.storage && <p className="text-xs text-muted-foreground">Company storage credit {formatUnits(current.storage.storage_credit, 24)} NEAR; used {formatUnits(current.storage.storage_used, 24)} NEAR. Pool and receiving-profile storage use this allowance. A large allocation list may require a Treasury storage top-up. Displayed credit is not a guaranteed cost estimate.</p>}
        {current.source_tx_hash && <p className="break-all text-xs">Wallet-reported creation reference, unverified: <code>{current.source_tx_hash}</code>. Pool and delivery status come from the contract, not this reported hash.</p>}
        {current.chain && <p className="text-xs">Policy {current.chain.policy_version}; collected {current.chain.approvals.length}/{current.chain.required_approvals} approvals. The owner and highest configured quorum authorize this exact allocation hash.</p>}
        {current.chain && <details className="min-w-0 text-xs"><summary className="cursor-pointer text-primary">Inspect authorization commitment</summary><p className="mt-2 break-all font-mono">{current.chain.terms_hash}</p><p className="mt-2">The commitment binds this pool, network, treasury, token, allocations, deadline, unused-fund rule and reviewed policy version.</p></details>}
        {current.problems.map(problem => <p key={problem} className="text-sm text-amber-900">{problem}</p>)}
        {current.last_error && <p role="alert" className="text-sm text-amber-900">{current.last_error}</p>}
        {current.payload.items.map(item => <div key={item.claimId} className="grid min-w-0 grid-cols-1 gap-2 rounded-lg bg-muted p-3 text-sm"><strong className="min-w-0 break-words">{item.name} · {formatUnits(item.amount, 6)} USDC ({usd(item.amount)})</strong><Address value={item.address} network={current.network ?? organization.near_network} /><p className="break-all text-xs">Claim {item.claimId}</p><Status value={current.chain?.claims.find(claim => claim.allocation.claim_id === item.claimId)?.status ?? "unfunded"} /></div>)}
        <div className="flex flex-wrap gap-3">
          <Action type="button" disabled={!!busy} onClick={refresh}>Refresh pool and treasury evidence</Action>
          {owner && ["draft", "review"].includes(current.stage) && <Action type="button" disabled={!!busy} busy={busy === "prepare-pool"} onClick={() => void run("prepare-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistribution>>>(`${base}/distributions/${current.id}/prepare`, {}), id: current.id }))}>Review native setup and funding</Action>}
          {canPrepare && current.stage === "draft" && <Action type="button" disabled={!!busy} onClick={() => void run("discard-pool", async () => { await api(`${base}/distributions/${current.id}`, undefined, "DELETE"); refresh(); })}>Cancel unfunded draft without a transaction</Action>}
          {owner && current.stage === "review" && !current.chain && <Action type="button" disabled={!!busy} onClick={() => void run("release-review", async () => { await api(`${base}/distributions/${current.id}/release-review`, {}); setPreview(null); setNotice("Unsigned review cancelled and its local reservation released without a transaction. This creation identity stays retired."); refresh(); })}>Release unsigned funding review without a transaction</Action>}
          {current.chain?.status === "proposed" && organization.permissions?.includes("payments:approve") && session.wallets.filter(wallet => wallet.family === "near" && wallet.network === current.network && current.policy && [current.policy.owner_id, ...current.policy.approvers].includes(wallet.address) && !current.chain!.approvals.includes(wallet.address)).map(wallet => <Action key={wallet.id} type="button" disabled={!!busy} onClick={() => void run("approve-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "approve", accountId: wallet.address }), id: current.id }))}>Review approval as {wallet.address}</Action>)}
          {owner && current.plan_hash && !current.chain && current.stage === "signing" && <Action type="button" disabled={!!busy} onClick={() => void run("void-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "void" }), id: current.id }))}>Cancel pending creation on NEAR</Action>}
          {owner && current.chain?.status === "proposed" && <Action type="button" disabled={!!busy} onClick={() => void run("void-proposal", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "void" }), id: current.id }))}>Cancel unfunded proposal on NEAR</Action>}
          {owner && current.chain && Number(current.chain.deadline_ms) <= Date.now() && BigInt(current.chain.unclaimed) > 0n && <Action type="button" disabled={!!busy} onClick={() => void run("reclaim-pool", async () => review({ ...await api<Awaited<ReturnType<typeof prepareDistributionControl>>>(`${base}/distributions/${current.id}/control`, { action: "reclaim" }), id: current.id }))}>Review return of unclaimed funds</Action>}
        </div>
        {current.stage === "signing" && !current.chain && <p className="text-xs text-muted-foreground">Creation is unresolved and cash remains fenced. Refresh the original creation. An owner-signed cancellation permanently voids this identity if funding has not occurred. It cannot cancel a funded pool or turn a timeout into new spendable cash.</p>}
      </div>}
      {preview && <div className="grid min-w-0 grid-cols-1 gap-4 rounded-2xl border border-border bg-white p-5" role="region" aria-label="Distribution wallet review">
        <h3 className="font-medium">Review {preview.phase === "fund" ? "exact allocation authorization and funding" : preview.phase === "recipients" ? "native receiving-profile setup" : preview.phase}</h3>
        <p className="text-sm">{formatUnits(preview.total, 6)} USDC ({usd(preview.total)}) fixed entitlement. NEAR {preview.network}. {preview.phase === "recipients" ? `${preview.remainingProfiles} receiving profiles need synchronization; this bounded group binds at most five. Then review funding separately.` : "The action cannot replace a recipient, edit a salary or create a new entitlement."}</p>
        {preview.phase === "fund" && <p className="text-xs">Requires {preview.requiredApprovals} distinct approvers in total, including the owner. Funding is reserved atomically only when the complete quorum is collected; local cash remains reserved while approval is pending.</p>}
        <p className="text-xs text-muted-foreground">The signing wallet pays NEAR transaction gas and displayed attached deposits. Claim gas includes the token call and callback; the treasury separately supplies the token transfer's 1 yoctoNEAR deposit. Existing prepaid company storage must cover the new state. No automatic claim relayer or free storage promise is included.</p>
        {preview.walletActions.map((transaction, index) => <div key={index} className="grid min-w-0 grid-cols-1 gap-2 rounded bg-muted p-3 text-xs"><Address value={transaction.receiverId} network={preview.network} />{transaction.actions.map((action, actionIndex) => <p key={actionIndex}>{action.params.methodName} · {formatUnits(action.params.gas, 12)} Tgas · {formatUnits(action.params.deposit, 24)} NEAR attached</p>)}</div>)}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={!!busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I reviewed the exact pool, receiving accounts, amounts, deadline, public allocation visibility, unused-fund rule and wallet costs.</label>
        <div className="flex flex-wrap gap-3"><Action type="button" disabled={!!busy || !confirmed} busy={busy === "distribution-sign"} onClick={() => void sign()}>Connect NEAR wallet and sign reviewed action</Action><Action type="button" disabled={!!busy} onClick={() => { setPreview(null); setConfirmed(false); }}>Close unsigned review</Action></div>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}{(error || resource.error || detail.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error || detail.error}</p>}
    </div>
  </Panel>;
}

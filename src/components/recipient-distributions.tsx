"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { WalletButtons } from "@/components/auth/sign-in-panel";
import { AssetIdentity } from "@/components/assets/asset-identity";
import type { ownDistributionClaims, inspectOwnClaim, prepareOwnClaim } from "@/server/distributions/service";
import { useAction, useResource } from "./workspace/hooks";
import { Action, Address, Empty, Panel, Status } from "./workspace/shared";

export function RecipientDistributions({ revision = 0 }: { revision?: number }) {
  const [refresh, setRefresh] = useState(0), [page, setPage] = useState(1), [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof prepareOwnClaim>> | null>(null), [confirmed, setConfirmed] = useState(false), [notice, setNotice] = useState("");
  const base = "/recipient-distributions", reload = () => setRefresh(value => value + 1);
  const history = useResource<ReturnType<typeof ownDistributionClaims>>(`${base}?page=${page}`, revision + refresh);
  const detail = useResource<Awaited<ReturnType<typeof inspectOwnClaim>>>(selected ? `${base}/${selected}` : null, revision + refresh);
  const { busy, error, run } = useAction();
  return <Panel title="Claimable native-USDC allocations" description="Optional company-funded grants and distributions. Ordinary push payments still arrive without recipient claim gas.">
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <p className="text-xs text-muted-foreground">A claim always pays its fixed approved NEAR account. Another gas-paying wallet can sponsor the call without redirecting the entitlement. Allocation amounts and accounts are public on NEAR; this view exposes only your own rows. Cross-chain claims and automatic gas subsidy are unavailable.</p>
      {history.loading ? <Empty>Loading your claim entitlements...</Empty> : !history.data?.claims.length ? <Empty>No claimable allocations on this page. Ordinary payment history remains separate.</Empty> : history.data.claims.map(item => <article key={item.id} className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4 text-sm"><div className="flex flex-wrap justify-between gap-3"><strong className="min-w-0 break-words">{item.company} · {item.reference}</strong><Status value={item.status} /></div><AssetIdentity symbol="USDC" network="near" /><p>{formatUnits(item.amount, 6)} USDC ({usd(item.amount)}) fixed entitlement</p><Address value={item.address} network={item.network ?? undefined} /><p className="text-xs">Deadline {new Date(item.deadline).toLocaleString()}{item.sourceUnknown ? ". A wallet request remains unresolved; refresh the same entitlement." : ""}</p>{item.reportedTransaction && <p className="break-all text-xs">Wallet-reported transaction, unverified: <code>{item.reportedTransaction}</code>. This reference does not prove delivery.</p>}<Action type="button" disabled={!!busy} onClick={() => { setSelected(item.id); setPreview(null); setConfirmed(false); }}>Inspect my fixed allocation</Action></article>)}
      {history.data && history.data.total > 0 && <div className="flex items-center justify-between gap-3 text-xs"><Action type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous claims</Action><span>Page {page}</span><Action type="button" disabled={!history.data.hasMore} onClick={() => setPage(value => value + 1)}>Next claims</Action></div>}
      {detail.loading && <Empty>Checking the native pool outcome...</Empty>}
      {detail.data && <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4 text-sm"><strong>My entitlement: {formatUnits(detail.data.amount, 6)} USDC ({usd(detail.data.amount)})</strong><Address value={detail.data.address} network={detail.data.network ?? undefined} />
        {detail.data.problems.map(problem => <p key={problem} className="text-amber-900">{problem}</p>)}
        {detail.data.sourceUnknown && <p className="text-xs text-muted-foreground">The wallet outcome is unresolved. A retry can only call this same fixed claim ID; the contract rejects a pending or already paid entitlement. Never create another payable or switch destination as recovery.</p>}
        <div className="flex flex-wrap gap-3"><Action type="button" disabled={!!busy} onClick={reload}>Refresh original claim outcome</Action><Action type="button" disabled={!!busy || detail.data.problems.length > 0} busy={busy === "prepare-claim"} onClick={() => void run("prepare-claim", async () => { setPreview(await api(`${base}/${selected}/prepare`, {})); setConfirmed(false); })}>{detail.data.sourceUnknown ? "Review retry of this same fixed claim" : "Review fixed claim and wallet costs"}</Action></div>
        {detail.data.walletLeaseExpiresAt && new Date(detail.data.walletLeaseExpiresAt).getTime() > Date.now() && <p className="text-xs text-muted-foreground">A wallet dialog owns this review until {new Date(detail.data.walletLeaseExpiresAt).toLocaleTimeString()}. Finish that dialog or wait, then refresh this same entitlement. This short UI lease is not evidence of payment finality.</p>}
        {!detail.data.eligibleSigners.length && <div className="grid gap-3"><p className="text-xs">Link a NEAR wallet to pay claim gas, or ask your company about its ordinary push-payment workflow. Linking a wallet does not change this approved receiving account.</p><WalletButtons link onComplete={reload} /></div>}
      </div>}
      {preview && <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4" aria-label="Fixed native claim review">
        <h3 className="font-medium">{preview.phase === "registration" ? "Register receiving storage before the claim" : preview.retrySameClaim ? "Retry this same fixed claim ID" : "Claim the fixed authorized entitlement"}</h3>
        {preview.retrySameClaim && <p className="text-xs text-muted-foreground">The original wallet result is unresolved, but fresh contract state still shows this exact entitlement as ready. This is a deliberate retry of the same claim ID and amount, with additional gas cost. A pending or paid entitlement cannot be paid again. No new payout or destination is created.</p>}
        <p className="text-sm">Receive exactly {formatUnits(preview.amount, 6)} USDC ({usd(preview.amount)}) at the approved address below on NEAR {preview.network}.</p><Address value={preview.address} network={preview.network ?? undefined} />
        <p className="text-xs text-muted-foreground">Your signing wallet pays transaction gas, including gas attached for the token call and callback. {preview.registrationDeposit === "0" ? "The receiving account already has token storage." : `The receiving account needs ${formatUnits(preview.registrationDeposit, 24)} NEAR attached for native-USDC storage, paid by your gas wallet.`} Razor has no percentage markup on this entitlement. No automatic relayer is configured. The treasury separately supplies the token transfer's 1 yoctoNEAR deposit.</p>
        {preview.walletActions.map((transaction, index) => <div className="grid min-w-0 grid-cols-1 gap-2 rounded bg-muted p-3 text-xs" key={index}><Address value={transaction.receiverId} network={preview.network ?? undefined} />{transaction.actions.map((action, key) => <p key={key}>{action.params.methodName} · {formatUnits(action.params.gas, 12)} Tgas · {formatUnits(action.params.deposit, 24)} NEAR attached</p>)}</div>)}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed my fixed entitlement, receiving account, deadline, public transfer visibility and all gas/storage costs. This calls the same claim ID even after an uncertain result.</label>
        <div className="flex flex-wrap gap-3"><Action type="button" disabled={!!busy || !confirmed} busy={busy === "sign-claim"} onClick={() => void run("sign-claim", async () => {
          try {
            const result = await signNearActionBatch(preview.walletActions as NearWalletAction[], preview.network!, preview.eligibleSigners, signerAccount => api(`${base}/${selected}/begin`, { signerAccount, planHash: preview.planHash, reviewGeneration: preview.reviewGeneration, retrySameClaim: preview.retrySameClaim }).then(() => {}));
            if (preview.phase === "claim" && result.receipts[0]?.hash) await api(`${base}/${selected}/receipt`, { transactionHash: result.receipts[0].hash, reviewGeneration: preview.reviewGeneration });
            setNotice(preview.phase === "registration" ? "Storage wallet results returned. Refresh and review the same entitlement again once registration is final; this step does not claim USDC." : "Wallet results returned. Refresh the original claim; only its native token callback can establish the recorded payout outcome.");
          } finally {
            try { await api(`${base}/${selected}/finish-wallet`, { reviewGeneration: preview.reviewGeneration }); }
            catch { setNotice("The wallet review could not be released immediately. Refresh the same entitlement after the short dialog lease; an uncertain transfer never creates another payment."); }
            setPreview(null); setConfirmed(false); reload();
          }
        })}>{preview.phase === "registration" ? "Connect NEAR wallet and register receiving storage" : preview.retrySameClaim ? "Connect NEAR gas wallet and retry this same claim" : "Connect NEAR gas wallet and sign fixed claim"}</Action><Action type="button" disabled={!!busy} onClick={() => { setPreview(null); setConfirmed(false); }}>Close unsigned review</Action></div>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}{(error || history.error || detail.error) && <p role="alert" className="text-sm text-destructive">{error || history.error || detail.error}</p>}
    </div>
  </Panel>;
}

"use client";

import { useEffect, useState } from "react";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./task-drawer";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { api } from "@/lib/api";
import { dateLabel, microUsd, usd } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import type { StandingGrant, StandingTerms } from "@/server/standing-mandates/model";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Status } from "./shared";

interface GrantView {
  id: string; recipient_id: string; enabled: number; eligible: boolean; supplierName: string; terms: StandingTerms;
  grant: StandingGrant | null; problems: string[]; activationMs: string | null; currentPeriodUsedInput: string; nextResetMs: string | null;
  policy: { owner_id: string; approvers: string[] }; network: string;
}
interface State { grants: GrantView[]; suppliers: { id: string; name: string }[]; usageRule: string; invoiceRule: string }
interface Preview { label?: string; id: string; network: string; ownerAccount: string; walletActions: NearWalletAction[]; terms?: StandingTerms; requiredApprovals?: number }

export function StandingMandatesPanel() {
  const { base, organization, session, revision, refresh, notify } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read");
  const resource = useResource<State>(canRead ? `${base}/standing-mandates` : null, revision);
  const { busy, error, run, setError } = useAction();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState("");
  const locked = !!busy || resource.refreshing || !!resource.error;
  const reviewedGrant = resource.data?.grants.find(value => value.id === preview?.id);
  const reviewedTerms = preview?.terms ?? reviewedGrant?.terms;
  const recipientAction = preview?.walletActions.flatMap(value => value.actions).find(value => value.params.methodName === "set_recipient")?.params.args as { primary?: { address?: unknown } } | undefined;
  const reviewedDestination = typeof recipientAction?.primary?.address === "string" ? recipientAction.primary.address : reviewedGrant?.grant?.destination.address;
  const authorityTime = (value: string) => new Date(Number(value)).toLocaleString("en-US", { timeZone: organization.timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const reviewedSupplier = reviewedGrant?.supplierName ?? resource.data?.suppliers.find(value => value.id === preview?.terms?.recipient_id)?.name;
  useEffect(() => {
    const dialog = document.getElementById("standing-mandate-review");
    const close = () => { if (dialog?.dataset.walletSuspended !== "true") setPreview(null); };
    dialog?.addEventListener("close", close);
    if (preview) openTaskDrawer("standing-mandate-review");
    else closeTaskDrawer("standing-mandate-review", true);
    return () => dialog?.removeEventListener("close", close);
  }, [preview]);
  const owner = organization.owner_id === session.user.id && !!organization.permissions?.includes("company:manage");
  const approve = !!organization.permissions?.includes("payments:approve");
  async function status(value: GrantView, paused: boolean, revoke = false) {
    try { const result = await api<Preview>(`${base}/standing-mandates/${value.id}/status`, { paused, revoke }); setPreview({ ...result, label: revoke ? "Revoke autopay authority" : paused ? "Pause autopay" : "Resume autopay" }); }
    finally { refresh(); }
  }
  if (!canRead) return null;
  return <section aria-label="Native vendor autopay" className="rounded-2xl border bg-white p-5 sm:p-6">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-base font-medium">Native vendor autopay</h3></div>{owner && <Action className="border bg-white text-foreground hover:bg-muted" type="button" disabled={locked} onClick={() => { setError(""); openTaskDrawer("standing-grant-create-flow"); }}>Configure grant</Action>}</div>
    <div className="grid gap-5" aria-busy={!!busy}>
      {owner && <TaskDrawer id="standing-grant-create-flow" title="Configure vendor autopay"><div aria-busy={!!busy}><form className="grid gap-6" onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void run("prepare-native-grant", async () => {const prepared=await api<Preview>(`${base}/standing-mandates/prepare`, {
          recipientId: data.get("supplier"), actorAccountId: data.get("actor"), actorPublicKey: data.get("key"),
          perPaymentMaxInput: microUsd(String(data.get("payment"))), periodMaxInput: microUsd(String(data.get("period"))),
          lifetimeMaxInput: microUsd(String(data.get("lifetime"))), periodDays: Number(data.get("days")),
          validFrom: new Date(String(data.get("start"))).toISOString(), expiresAt: new Date(String(data.get("expiry"))).toISOString(),
        });setPreview(prepared);closeTaskDrawer("standing-grant-create-flow",true);});
      }}>
        <fieldset disabled={locked} className="grid gap-4"><legend className="mb-4 text-sm font-medium">Supplier and executor</legend>
        <Field label="Confirmed native supplier"><select name="supplier" className={control} disabled={resource.loading} required><option value="">Choose supplier</option>{resource.data?.suppliers.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>{!resource.loading && !resource.error && !resource.data?.suppliers.length && <span className="text-xs font-normal leading-5 text-muted-foreground">Confirm a supplier receiving USDC on NEAR to create a grant.</span>}</Field>
        <Field label="Dedicated native executor account"><input name="actor" className={control} required placeholder="vendor-executor.near" /></Field>
        <div><Field label="Restricted executor public key" hint="Function-call key for execute_standing_payment"><input name="key" className={control} required placeholder="ed25519:..." /></Field></div>
        </fieldset>
        <fieldset disabled={locked} className="grid gap-4 border-t pt-5 sm:grid-cols-2"><legend className="pr-3 text-sm font-medium">Spending limits</legend>
        <Field label="Per bill limit (USDC)" hint="Principal and maximum costs"><input name="payment" className={control} inputMode="decimal" required /></Field>
        <Field label="Period limit (USDC)"><input name="period" className={control} inputMode="decimal" required /></Field>
        <Field label="Lifetime limit (USDC)"><input name="lifetime" className={control} inputMode="decimal" required /></Field>
        <Field label="Period length (days)"><input name="days" className={control} type="number" min={1} max={366} defaultValue={30} required /></Field>
        </fieldset>
        <fieldset disabled={locked} className="grid gap-4 border-t pt-5 sm:grid-cols-2"><legend className="pr-3 text-sm font-medium">Validity</legend>
        <Field label="Valid from (your local time)"><input name="start" className={control} type="datetime-local" required /></Field>
        <Field label="Expires at (your local time)"><input name="expiry" className={control} type="datetime-local" required /></Field>
        </fieldset>
        <p className="text-xs text-muted-foreground">USDC on NEAR · Quorum approval · 24-hour supplier delay</p>
        <footer className="flex flex-wrap justify-end gap-3 border-t pt-5"><button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium hover:bg-muted" disabled={locked} onClick={() => closeTaskDrawer("standing-grant-create-flow")}>Close</button><Action disabled={locked || resource.loading || !!resource.error || !resource.data?.suppliers.length} busy={busy === "prepare-native-grant"}>{busy === "prepare-native-grant" ? "Preparing review..." : "Review authority grant"}</Action></footer>
      </form>{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}</div></TaskDrawer>}
      <TaskDrawer id="standing-mandate-review" title={preview?.label ?? "Review autopay authority"} description={reviewedSupplier}>{preview && <div aria-busy={!!busy} className="grid gap-5">
        <AssetIdentity symbol="USDC" network="near"/>
        {reviewedTerms && <dl className="grid grid-cols-2 gap-5"><div><dt className="text-xs text-muted-foreground">Per bill</dt><dd className="mt-2 font-medium tabular-nums">{usd(reviewedTerms.per_payment_max_input)}</dd></div><div><dt className="text-xs text-muted-foreground">Per {String(BigInt(reviewedTerms.period_ms) / 86_400_000n)} days</dt><dd className="mt-2 font-medium tabular-nums">{usd(reviewedTerms.period_max_input)}</dd></div><div><dt className="text-xs text-muted-foreground">Lifetime limit</dt><dd className="mt-2 font-medium tabular-nums">{usd(reviewedTerms.lifetime_max_input)}</dd></div><div><dt className="text-xs text-muted-foreground">Starts</dt><dd className="mt-2 text-sm">{authorityTime(reviewedTerms.valid_from_ms)}</dd></div><div className="col-span-2"><dt className="text-xs text-muted-foreground">Expires · {organization.timezone}</dt><dd className="mt-2 text-sm">{authorityTime(reviewedTerms.expires_at_ms)}</dd></div><div className="col-span-2"><dt className="text-xs text-muted-foreground">Supplier destination</dt><dd className="mt-2">{reviewedDestination ? <Address value={reviewedDestination} network={preview.network} full/> : "Unavailable"}</dd></div><div className="col-span-2"><dt className="text-xs text-muted-foreground">Executor</dt><dd className="mt-2"><Address value={reviewedTerms.actor_id} network={preview.network}/></dd></div></dl>}
        <div><p className="mb-2 text-xs text-muted-foreground">Required signer</p><Address value={preview.ownerAccount} network={preview.network}/></div>
        {preview.terms && <p className="text-xs text-muted-foreground">{preview.requiredApprovals} wallet approvals · 24-hour supplier delay</p>}
        <details className="border-t pt-4 text-xs"><summary className="cursor-pointer">Exact authority & wallet actions</summary><pre className="mt-3 max-h-72 overflow-auto rounded-xl bg-muted p-3">{JSON.stringify({ terms: reviewedTerms, actions: preview.walletActions }, null, 2)}</pre></details>
        <Action disabled={locked || !reviewedTerms || !reviewedDestination} busy={busy === "sign-native"} onClick={() => void run("sign-native", async () => { await withTaskDrawerWallet(() => signNearActions(preview.walletActions, preview.network, [preview.ownerAccount])); setPreview(null); refresh(); notify("Authority submitted. Review the updated grant status."); })}>Confirm in NEAR wallet</Action>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>}</TaskDrawer>
      {resource.loading && <Empty>Loading native grants...</Empty>}
      {selected && <button type="button" className="w-fit min-h-10 text-sm text-primary" disabled={locked} onClick={() => setSelected("")}>Back to grants</button>}
      {resource.data?.grants.filter(value => !selected || value.id === selected).map(value => !selected ? <button key={value.id} type="button" disabled={locked} className="flex w-full items-center justify-between gap-4 border-b py-4 text-left" onClick={() => setSelected(value.id)}><span className="min-w-0"><span className="block text-sm font-medium">{value.supplierName}</span><span className="mt-2 block text-xs text-muted-foreground">{usd(value.terms.per_payment_max_input)} per bill · USDC on NEAR</span></span><Status value={value.eligible ? "active" : value.enabled ? "held" : "disabled"}/></button> : <div key={value.id} className="grid min-w-0 gap-4 rounded-2xl border p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold">{value.supplierName}</h3><Status value={value.eligible ? "active" : value.enabled ? "held" : "disabled"} /></div>
        <dl className="grid gap-4 sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">Per bill limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(value.terms.per_payment_max_input)} USDC</dd></div><div><dt className="text-xs text-muted-foreground">Period limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(value.terms.period_max_input)} USDC</dd></div><div><dt className="text-xs text-muted-foreground">Lifetime limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(value.terms.lifetime_max_input)} USDC</dd></div></dl>
        <details className="text-xs"><summary className="cursor-pointer font-medium">Authority details</summary><dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="mb-2 text-muted-foreground">Grant ID</dt><dd><input aria-label="Grant ID" className={`${control} font-mono text-xs`} readOnly value={value.id} onFocus={event => event.currentTarget.select()} /></dd></div><div><dt className="mb-2 text-muted-foreground">Executor</dt><dd><Address value={value.terms.actor_id} network={value.network} /></dd></div><div className="sm:col-span-2"><dt className="mb-2 text-muted-foreground">Native destination</dt><dd>{value.grant ? <Address value={value.grant.destination.address} network={value.network} /> : "Awaiting owner confirmation"}</dd></div></dl></details>
        {value.grant && <><div className="grid gap-2 text-sm sm:grid-cols-3"><p>Current period usage: {usd(value.currentPeriodUsedInput)}</p><p>Lifetime usage: {usd(value.grant.lifetime_used_input)}</p><p>Pending input commitments: {usd(value.grant.pending_input)}</p></div><p className="text-xs text-muted-foreground">Wallet approvals: {value.grant.approvals.length}/{value.grant.required_approvals}. Activation: {value.activationMs ? dateLabel(new Date(Number(value.activationMs)).toISOString()) : "Unconfirmed"}. Next reset: {value.nextResetMs ? dateLabel(new Date(Number(value.nextResetMs)).toISOString()) : "Unconfirmed"}. Expiry: {dateLabel(new Date(Number(value.terms.expires_at_ms)).toISOString())}.</p></>}
        {value.problems.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-700 dark:text-amber-400">{value.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
        <div className="flex flex-wrap gap-3">
          {approve && value.grant && session.wallets.filter(wallet => wallet.family === "near" && wallet.network === value.network && [value.policy.owner_id, ...value.policy.approvers].includes(wallet.address) && !value.grant!.approvals.includes(wallet.address)).map(wallet => <Action key={wallet.id} disabled={locked} busy={busy === `approve:${value.id}`} onClick={() => void run(`approve:${value.id}`, async () => setPreview(await api<Preview>(`${base}/standing-mandates/${value.id}/approve`, { accountId: wallet.address })))}>Review approval as {wallet.address}</Action>)}
          {owner && <><Action className="border bg-white text-foreground hover:bg-muted" busy={busy === `enable:${value.id}`} disabled={locked || !value.grant || value.problems.length > 0 || !!value.enabled} onClick={() => void run(`enable:${value.id}`, async () => { await api(`${base}/standing-mandates/${value.id}/observe`, {}); refresh(); })}>Enable autopay</Action><Action className="border bg-white text-foreground hover:bg-muted" busy={busy === `pause:${value.id}`} disabled={locked || !value.grant || value.grant.paused || value.grant.revoked} onClick={() => void run(`pause:${value.id}`, () => status(value, true))}>Pause</Action><Action className="border bg-white text-foreground hover:bg-muted" busy={busy === `resume:${value.id}`} disabled={locked || !value.grant || !value.grant.paused || value.grant.revoked} onClick={() => void run(`resume:${value.id}`, () => status(value, false))}>Resume</Action><Action className="border border-destructive/20 bg-white text-destructive hover:bg-red-50" busy={busy === `revoke:${value.id}`} disabled={locked || !value.grant || value.grant.revoked} onClick={() => void run(`revoke:${value.id}`, () => status(value, true, true))}>Revoke authority</Action></>}
        </div>

      </div>)}
      {!resource.loading && !resource.error && resource.data?.grants.length === 0 && <Empty>No autopay grants yet.</Empty>}
      {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}{resource.error && resource.data && <span className="mt-1 block text-xs">Previous grants are shown. Refresh to load current authority.</span>}</p>}
    </div>
  </section>;
}

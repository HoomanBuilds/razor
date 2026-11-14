"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { dateLabel, microUsd, usd } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import type { StandingGrant, StandingTerms } from "@/server/standing-mandates/model";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Empty, Field, Panel, Status } from "./shared";

interface GrantView {
  id: string; recipient_id: string; enabled: number; eligible: boolean; supplierName: string; terms: StandingTerms;
  grant: StandingGrant | null; problems: string[]; activationMs: string | null; currentPeriodUsedInput: string; nextResetMs: string | null;
  policy: { owner_id: string; approvers: string[] }; network: string;
}
interface State { grants: GrantView[]; suppliers: { id: string; name: string }[]; usageRule: string; invoiceRule: string }
interface Preview { id: string; network: string; ownerAccount: string; walletActions: NearWalletAction[]; terms?: StandingTerms; requiredApprovals?: number }

export function StandingMandatesPanel() {
  const { base, organization, session, revision, refresh, navigate, notify } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read");
  const resource = useResource<State>(canRead ? `${base}/standing-mandates` : null, revision);
  const { busy, error, run } = useAction();
  const [preview, setPreview] = useState<Preview | null>(null);
  const owner = organization.owner_id === session.user.id && !!organization.permissions?.includes("company:manage");
  const approve = !!organization.permissions?.includes("payments:approve");
  async function status(value: GrantView, paused: boolean, revoke = false) {
    try { setPreview(await api<Preview>(`${base}/standing-mandates/${value.id}/status`, { paused, revoke })); }
    finally { refresh(); }
  }
  if (!canRead) return null;
  return <Panel title="Optional native vendor autopay" description="Opt in to bounded native NEAR USDC authority. Cross-chain standing payments are unavailable. Ordinary exact-route wallet review remains available.">
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">The owner and the highest company wallet quorum review each grant. Every new grant starts a 24-hour supplier activation delay on NEAR. There is no emergency bypass. A new grant rebinds the supplier and invalidates prior recipient-bound grants and unsigned route approvals. Accepted, approved and funded vendor bills can then execute without another route signature.</p>
      {resource.data && <><p className="text-xs text-muted-foreground">{resource.data.usageRule}</p><p className="text-xs text-muted-foreground">{resource.data.invoiceRule}</p></>}
      <button type="button" className="w-fit text-sm text-primary" onClick={() => navigate("payments")}>Open payments for exact-route review</button>
      {owner && <form className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void run("prepare-native-grant", async () => setPreview(await api<Preview>(`${base}/standing-mandates/prepare`, {
          recipientId: data.get("supplier"), actorAccountId: data.get("actor"), actorPublicKey: data.get("key"),
          perPaymentMaxInput: microUsd(String(data.get("payment"))), periodMaxInput: microUsd(String(data.get("period"))),
          lifetimeMaxInput: microUsd(String(data.get("lifetime"))), periodDays: Number(data.get("days")),
          validFrom: new Date(String(data.get("start"))).toISOString(), expiresAt: new Date(String(data.get("expiry"))).toISOString(),
        })));
      }}>
        <Field label="Confirmed native supplier"><select name="supplier" className={control} required><option value="">Choose supplier</option>{resource.data?.suppliers.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></Field>
        <Field label="Dedicated native executor account"><input name="actor" className={control} required placeholder="vendor-executor.near" /></Field>
        <div className="sm:col-span-2"><Field label="Restricted executor public key" hint="Use a function-call key that permits only execute_standing_payment at this treasury. The worker checks the actual NEAR key permissions."><input name="key" className={control} required placeholder="ed25519:..." /></Field></div>
        <Field label="Maximum input per bill (USDC)" hint="Includes principal plus the full accepted fee ceiling."><input name="payment" className={control} inputMode="decimal" required /></Field>
        <Field label="Maximum input per period (USDC)"><input name="period" className={control} inputMode="decimal" required /></Field>
        <Field label="Maximum lifetime input (USDC)"><input name="lifetime" className={control} inputMode="decimal" required /></Field>
        <Field label="Anchored period length (days)"><input name="days" className={control} type="number" min={1} max={366} defaultValue={30} required /></Field>
        <Field label="Valid from (your local time)"><input name="start" className={control} type="datetime-local" required /></Field>
        <Field label="Expires at (your local time)"><input name="expiry" className={control} type="datetime-local" required /></Field>
        <div className="sm:col-span-2"><Action disabled={!!busy} busy={busy === "prepare-native-grant"}>Review native authority grant</Action></div>
      </form>}
      {preview && <div className="rounded-lg border border-primary/30 p-4"><h3 className="font-semibold">Review the exact native authority</h3><p className="mt-2 text-sm">Signer: {preview.ownerAccount} on NEAR {preview.network}. {preview.requiredApprovals ? `${preview.requiredApprovals} distinct approvals required, including the owner.` : ""}</p><pre className="my-3 max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(preview.terms ?? preview.walletActions.map(value => value.actions.map(action => ({ method: action.params.methodName, args: action.params.args }))), null, 2)}</pre><div className="flex gap-3"><Action disabled={!!busy} busy={busy === "sign-native"} onClick={() => void run("sign-native", async () => {
        await signNearActions(preview.walletActions, preview.network, [preview.ownerAccount]);
        setPreview(null); refresh(); notify("Wallet actions submitted. Inspect the final grant, wait for activation and enable it after its quorum is complete.");
      })}>Confirm with required wallet</Action><button type="button" className="text-sm text-primary" disabled={!!busy} onClick={() => setPreview(null)}>Close review</button></div></div>}
      {resource.loading && <Empty>Loading native grants...</Empty>}
      {resource.data?.grants.map(value => <div key={value.id} className="grid gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold">{value.supplierName}</h3><Status value={value.eligible ? "active" : value.enabled ? "held" : "disabled"} /></div>
        <p className="break-all text-xs text-muted-foreground">Grant {value.id}. Actor {value.terms.actor_id}. Native destination {value.grant?.destination.address ?? "Awaiting owner confirmation"}.</p>
        <div className="grid gap-2 text-sm sm:grid-cols-3"><p>Per bill: {usd(value.terms.per_payment_max_input)}</p><p>Period ceiling: {usd(value.terms.period_max_input)}</p><p>Lifetime ceiling: {usd(value.terms.lifetime_max_input)}</p></div>
        {value.grant && <><div className="grid gap-2 text-sm sm:grid-cols-3"><p>Current period usage: {usd(value.currentPeriodUsedInput)}</p><p>Lifetime usage: {usd(value.grant.lifetime_used_input)}</p><p>Pending input commitments: {usd(value.grant.pending_input)}</p></div><p className="text-xs text-muted-foreground">Wallet approvals: {value.grant.approvals.length}/{value.grant.required_approvals}. Activation: {value.activationMs ? dateLabel(new Date(Number(value.activationMs)).toISOString()) : "Unconfirmed"}. Next reset: {value.nextResetMs ? dateLabel(new Date(Number(value.nextResetMs)).toISOString()) : "Unconfirmed"}. Expiry: {dateLabel(new Date(Number(value.terms.expires_at_ms)).toISOString())}.</p></>}
        {value.problems.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-700 dark:text-amber-400">{value.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
        <div className="flex flex-wrap gap-3">
          {approve && value.grant && session.wallets.filter(wallet => wallet.family === "near" && wallet.network === value.network && [value.policy.owner_id, ...value.policy.approvers].includes(wallet.address) && !value.grant!.approvals.includes(wallet.address)).map(wallet => <Action key={wallet.id} disabled={!!busy} onClick={() => void run(`approve:${value.id}`, async () => setPreview(await api<Preview>(`${base}/standing-mandates/${value.id}/approve`, { accountId: wallet.address })))}>Review approval as {wallet.address}</Action>)}
          {owner && <><Action disabled={!!busy || !value.grant || value.problems.length > 0} onClick={() => void run(`enable:${value.id}`, async () => { await api(`${base}/standing-mandates/${value.id}/observe`, {}); refresh(); })}>Observe and enable</Action><Action disabled={!!busy || !value.grant} onClick={() => void run(`pause:${value.id}`, () => status(value, true))}>Pause locally and review NEAR pause</Action><Action disabled={!!busy || !value.grant || value.grant.revoked} onClick={() => void run(`resume:${value.id}`, () => status(value, false))}>Review NEAR resume</Action><Action disabled={!!busy || !value.grant || value.grant.revoked} onClick={() => void run(`revoke:${value.id}`, () => status(value, true, true))}>Revoke authority</Action></>}
        </div>
        <p className="text-xs text-muted-foreground">Pausing the application takes effect immediately. Complete the owner wallet action to pause or revoke NEAR authority. Existing transfers continue monitoring. Exhausted or failed usage requires a newly reviewed grant to replenish.</p>
      </div>)}
      {!resource.loading && resource.data?.grants.length === 0 && <Empty>No standing authority is enabled. Review ordinary payment routes or create an optional native grant.</Empty>}
      {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}
    </div>
  </Panel>;
}

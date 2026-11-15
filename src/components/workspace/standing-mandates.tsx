"use client";

import { useState } from "react";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer } from "./task-drawer";
import { focusWorkspaceForm } from "./page-metrics";
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
  return <section aria-label="Native vendor autopay" className="rounded-2xl border bg-white p-5 sm:p-6">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-base font-medium">Native vendor autopay</h3><p className="mt-2 text-sm text-muted-foreground">Optional standing authority for supplier payments in USDC on NEAR.</p></div>{owner && <Action className="border bg-white text-foreground hover:bg-muted" type="button" disabled={!!busy} onClick={() => openTaskDrawer("standing-grant-create-flow")}>Configure grant</Action>}</div>
    <div className="grid gap-5" aria-busy={!!busy}>
      <p className="text-xs leading-5 text-muted-foreground">Owner and company quorum approval required, followed by a 24-hour supplier activation delay. Cross-chain standing payments are unavailable.</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Authority, activation and invoice rules</summary><div className="mt-3 space-y-3 leading-5"><p>The owner and the highest company wallet quorum review each grant. Every new grant starts a 24-hour supplier activation delay on NEAR. There is no emergency bypass. A new grant rebinds the supplier and invalidates prior recipient-bound grants and unsigned route approvals. Accepted, approved and funded vendor bills can then execute without another route signature.</p>{resource.data && <><p>{resource.data.usageRule}</p><p>{resource.data.invoiceRule}</p></>}</div></details>
      <button type="button" className="w-fit text-sm text-primary" onClick={() => {navigate("payments");focusWorkspaceForm("payment-queue");}}>Review ordinary payment routes</button>
      {owner && <TaskDrawer id="standing-grant-create-flow" title="Configure native vendor autopay" description="Define one supplier, a restricted executor and exact spending limits."><div aria-busy={!!busy}><form className="grid gap-6" onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void run("prepare-native-grant", async () => {const prepared=await api<Preview>(`${base}/standing-mandates/prepare`, {
          recipientId: data.get("supplier"), actorAccountId: data.get("actor"), actorPublicKey: data.get("key"),
          perPaymentMaxInput: microUsd(String(data.get("payment"))), periodMaxInput: microUsd(String(data.get("period"))),
          lifetimeMaxInput: microUsd(String(data.get("lifetime"))), periodDays: Number(data.get("days")),
          validFrom: new Date(String(data.get("start"))).toISOString(), expiresAt: new Date(String(data.get("expiry"))).toISOString(),
        });setPreview(prepared);closeTaskDrawer("standing-grant-create-flow",true);requestAnimationFrame(()=>document.getElementById("standing-mandate-review")?.scrollIntoView({block:"start"}));});
      }}>
        <fieldset disabled={!!busy} className="grid gap-4"><legend className="mb-4 text-sm font-medium">Supplier and executor</legend>
        <Field label="Confirmed native supplier"><select name="supplier" className={control} disabled={resource.loading} required><option value="">Choose supplier</option>{resource.data?.suppliers.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>{!resource.loading && !resource.error && !resource.data?.suppliers.length && <span className="text-xs font-normal leading-5 text-muted-foreground">Confirm a supplier receiving USDC on NEAR to create a grant.</span>}</Field>
        <Field label="Dedicated native executor account"><input name="actor" className={control} required placeholder="vendor-executor.near" /></Field>
        <div><Field label="Restricted executor public key" hint="Use a function-call key that permits only execute_standing_payment at this treasury. The worker checks the actual NEAR key permissions."><input name="key" className={control} required placeholder="ed25519:..." /></Field></div>
        </fieldset>
        <fieldset disabled={!!busy} className="grid gap-4 border-t pt-5 sm:grid-cols-2"><legend className="pr-3 text-sm font-medium">Spending limits</legend>
        <Field label="Maximum input per bill (USDC)" hint="Includes principal plus the full accepted fee ceiling."><input name="payment" className={control} inputMode="decimal" required /></Field>
        <Field label="Maximum input per period (USDC)"><input name="period" className={control} inputMode="decimal" required /></Field>
        <Field label="Maximum lifetime input (USDC)"><input name="lifetime" className={control} inputMode="decimal" required /></Field>
        <Field label="Anchored period length (days)"><input name="days" className={control} type="number" min={1} max={366} defaultValue={30} required /></Field>
        </fieldset>
        <fieldset disabled={!!busy} className="grid gap-4 border-t pt-5 sm:grid-cols-2"><legend className="pr-3 text-sm font-medium">Validity</legend>
        <Field label="Valid from (your local time)"><input name="start" className={control} type="datetime-local" required /></Field>
        <Field label="Expires at (your local time)"><input name="expiry" className={control} type="datetime-local" required /></Field>
        </fieldset>
        <p className="rounded-xl bg-secondary/50 p-4 text-xs leading-5 text-muted-foreground">NEAR USDC only. The owner and required approvers review the exact grant before a 24-hour activation delay. Preparing a grant does not enable autopay.</p>
        <footer className="flex flex-wrap justify-end gap-3 border-t pt-5"><button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium hover:bg-muted" disabled={!!busy} onClick={() => closeTaskDrawer("standing-grant-create-flow")}>Close</button><Action disabled={!!busy || resource.loading || !!resource.error || !resource.data?.suppliers.length} busy={busy === "prepare-native-grant"}>{busy === "prepare-native-grant" ? "Preparing review..." : "Review authority grant"}</Action></footer>
      </form>{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}</div></TaskDrawer>}
      {preview && <div id="standing-mandate-review" className="scroll-mt-8 rounded-lg border border-primary/30 p-4"><h3 className="font-semibold">Review the exact native authority</h3><p className="mt-3 text-xs leading-5 text-muted-foreground">The owner and the highest company wallet quorum review each grant. Every new grant starts a 24-hour supplier activation delay on NEAR. There is no emergency bypass. A new grant rebinds the supplier and invalidates prior recipient-bound grants and unsigned route approvals. Accepted, approved and funded vendor bills can then execute without another route signature.</p><p className="mt-2 text-sm">Signer: {preview.ownerAccount} on NEAR {preview.network}. {preview.requiredApprovals ? `${preview.requiredApprovals} distinct approvals required, including the owner.` : ""}</p>{preview.terms && <dl className="my-4 grid gap-4 rounded-xl bg-muted/50 p-4 sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">Per bill limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(preview.terms.per_payment_max_input)} USDC</dd></div><div><dt className="text-xs text-muted-foreground">Period limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(preview.terms.period_max_input)} USDC</dd></div><div><dt className="text-xs text-muted-foreground">Lifetime limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(preview.terms.lifetime_max_input)} USDC</dd></div><div className="sm:col-span-3"><dt className="text-xs text-muted-foreground">Executor</dt><dd className="mt-2"><Address value={preview.terms.actor_id} network={preview.network} /></dd></div></dl>}<details className="my-4 rounded-xl border p-4 text-xs"><summary className="cursor-pointer font-medium">Exact authority and wallet actions</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify({ terms: preview.terms, actions: preview.walletActions.map(value => ({ receiverId: value.receiverId, actions: value.actions.map(action => ({ method: action.params.methodName, args: action.params.args })) })) }, null, 2)}</pre></details><div className="flex gap-3"><Action disabled={!!busy} busy={busy === "sign-native"} onClick={() => void run("sign-native", async () => {
        await signNearActions(preview.walletActions, preview.network, [preview.ownerAccount]);
        setPreview(null); refresh(); notify("Wallet actions submitted. Inspect the final grant, wait for activation and enable it after its quorum is complete.");
      })}>Confirm with required wallet</Action><button type="button" className="text-sm text-primary" disabled={!!busy} onClick={() => setPreview(null)}>Close review</button></div></div>}
      {resource.loading && <Empty>Loading native grants...</Empty>}
      {resource.data?.grants.map(value => <div key={value.id} className="grid min-w-0 gap-4 rounded-2xl border p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3"><h3 className="font-semibold">{value.supplierName}</h3><Status value={value.eligible ? "active" : value.enabled ? "held" : "disabled"} /></div>
        <dl className="grid gap-4 sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">Per bill limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(value.terms.per_payment_max_input)} USDC</dd></div><div><dt className="text-xs text-muted-foreground">Period limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(value.terms.period_max_input)} USDC</dd></div><div><dt className="text-xs text-muted-foreground">Lifetime limit</dt><dd className="mt-1 text-sm tabular-nums">{usd(value.terms.lifetime_max_input)} USDC</dd></div></dl>
        <details className="text-xs"><summary className="cursor-pointer font-medium">Authority details</summary><dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="mb-2 text-muted-foreground">Grant ID</dt><dd><input aria-label="Grant ID" className={`${control} font-mono text-xs`} readOnly value={value.id} onFocus={event => event.currentTarget.select()} /></dd></div><div><dt className="mb-2 text-muted-foreground">Executor</dt><dd><Address value={value.terms.actor_id} network={value.network} /></dd></div><div className="sm:col-span-2"><dt className="mb-2 text-muted-foreground">Native destination</dt><dd>{value.grant ? <Address value={value.grant.destination.address} network={value.network} /> : "Awaiting owner confirmation"}</dd></div></dl></details>
        {value.grant && <><div className="grid gap-2 text-sm sm:grid-cols-3"><p>Current period usage: {usd(value.currentPeriodUsedInput)}</p><p>Lifetime usage: {usd(value.grant.lifetime_used_input)}</p><p>Pending input commitments: {usd(value.grant.pending_input)}</p></div><p className="text-xs text-muted-foreground">Wallet approvals: {value.grant.approvals.length}/{value.grant.required_approvals}. Activation: {value.activationMs ? dateLabel(new Date(Number(value.activationMs)).toISOString()) : "Unconfirmed"}. Next reset: {value.nextResetMs ? dateLabel(new Date(Number(value.nextResetMs)).toISOString()) : "Unconfirmed"}. Expiry: {dateLabel(new Date(Number(value.terms.expires_at_ms)).toISOString())}.</p></>}
        {value.problems.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-700 dark:text-amber-400">{value.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
        <div className="flex flex-wrap gap-3">
          {approve && value.grant && session.wallets.filter(wallet => wallet.family === "near" && wallet.network === value.network && [value.policy.owner_id, ...value.policy.approvers].includes(wallet.address) && !value.grant!.approvals.includes(wallet.address)).map(wallet => <Action key={wallet.id} disabled={!!busy} busy={busy === `approve:${value.id}`} onClick={() => void run(`approve:${value.id}`, async () => setPreview(await api<Preview>(`${base}/standing-mandates/${value.id}/approve`, { accountId: wallet.address })))}>Review approval as {wallet.address}</Action>)}
          {owner && <><Action className="border bg-white text-foreground hover:bg-muted" busy={busy === `enable:${value.id}`} disabled={!!busy || !value.grant || value.problems.length > 0} onClick={() => void run(`enable:${value.id}`, async () => { await api(`${base}/standing-mandates/${value.id}/observe`, {}); refresh(); })}>Observe and enable</Action><Action className="border bg-white text-foreground hover:bg-muted" busy={busy === `pause:${value.id}`} disabled={!!busy || !value.grant} onClick={() => void run(`pause:${value.id}`, () => status(value, true))}>Pause and review in NEAR</Action><Action className="border bg-white text-foreground hover:bg-muted" busy={busy === `resume:${value.id}`} disabled={!!busy || !value.grant || value.grant.revoked} onClick={() => void run(`resume:${value.id}`, () => status(value, false))}>Review NEAR resume</Action><Action className="border border-destructive/20 bg-white text-destructive hover:bg-red-50" busy={busy === `revoke:${value.id}`} disabled={!!busy || !value.grant || value.grant.revoked} onClick={() => void run(`revoke:${value.id}`, () => status(value, true, true))}>Revoke authority</Action></>}
        </div>
        <p className="text-xs text-muted-foreground">Pausing the application takes effect immediately. Complete the owner wallet action to pause or revoke NEAR authority. Existing transfers continue monitoring. Exhausted or failed usage requires a newly reviewed grant to replenish.</p>
      </div>)}
      {!resource.loading && !resource.error && resource.data?.grants.length === 0 && <Empty>No standing authority is enabled. Review ordinary payment routes or create an optional native grant.</Empty>}
      {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}{resource.error && resource.data && <span className="mt-1 block text-xs">Previous grants are shown. Refresh to load current authority.</span>}</p>}
    </div>
  </section>;
}

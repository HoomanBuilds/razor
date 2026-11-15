"use client";

import { TimezonePicker } from "./timezone-picker";
import { WalletButtons } from "@/components/auth/sign-in-panel";
import { TeamAccessPanel } from "./team-access";
import { TreasuryPolicyPanel } from "./treasury-policy";
import { IntegrationsPanel } from "./integrations";
import { useIdentity } from "@/components/auth/identity-provider";
import { api } from "@/lib/api";
import { useWorkspace } from "./context";
import { useAction } from "./hooks";
import { Action, Address, control, Empty, Field, Panel } from "./shared";

export function CompanySettings({ view = "profile" }: { view?: "profile" | "wallets" | "policies" | "team" | "integrations" }) {
  const { base, organization, revision, refresh, session } = useWorkspace();
  const { refresh: refreshIdentity } = useIdentity();
  const { busy, error, run } = useAction();
  const manage=!!organization.permissions?.includes("company:manage");
  return <div className="grid gap-6">
    {view === "profile" && <Panel title="Company details" tone="white" description="Your company identity and USDC accounting preferences." help="Company amounts are recorded in USDC. Fund with supported assets and let payees choose their supported payout asset."><form className="grid gap-4 sm:grid-cols-3" onSubmit={(event) => { event.preventDefault(); if(!manage)return; const values = new FormData(event.currentTarget); void run("save", async () => { await api(base, { name: values.get("name"), timezone: values.get("timezone") }, "PATCH"); await refreshIdentity(); refresh(); }); }}><Field label="Company name"><input name="name" className={control} defaultValue={organization.name} required readOnly={!manage} /></Field><Field label="Time zone"><TimezonePicker defaultValue={organization.timezone} disabled={!manage || !!busy}/></Field><Field label="Company accounting unit"><input className={control} value="USDC" readOnly /></Field>{manage?<div className="sm:col-span-3"><Action busy={busy === "save"} disabled={!!busy}>Save company</Action></div>:<p className="text-sm text-muted-foreground sm:col-span-3">Your role can view company details. A company administrator manages these settings.</p>}</form></Panel>}
    {view === "wallets" && <Panel title="Connected wallets" tone="muted" description="Verified wallets for funding and NEAR approvals. Linking moves no funds." help="Link proof of control before selecting a source wallet or NEAR treasury owner. Linking a wallet does not move funds."><div className="grid gap-4 lg:grid-cols-2"><div className="grid content-start gap-3">{session.wallets.length ? session.wallets.map((wallet) => <div key={wallet.id} className="rounded-2xl border border-border bg-white p-5"><div className="mb-2 flex items-center justify-between text-sm"><strong>{wallet.label || `${wallet.family.toUpperCase()} wallet`}</strong><span className="text-xs text-muted-foreground">{wallet.network}</span></div><Address value={wallet.address} network={wallet.network} /></div>) : <Empty>No wallets linked yet.</Empty>}</div><WalletButtons link onComplete={refreshIdentity} /></div><p className="mt-4 text-xs text-muted-foreground">Keep a second verified sign-in method for recovery. Company app access and NEAR signing authority are managed separately.</p></Panel>}
    {view === "policies" && <TreasuryPolicyPanel />}
    {view === "team" && <TeamAccessPanel />}
    {view === "integrations" && <IntegrationsPanel key={organization.id} />}
    {error && <p role="alert" className="rounded-xl border border-destructive/20 bg-white p-4 text-sm text-destructive">{error}</p>}
  </div>;
}

export { ActivityLog } from "./activity-log";
export { Assistant } from "./invoice-assistant";

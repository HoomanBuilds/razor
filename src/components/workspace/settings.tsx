"use client";

import { TaskDrawer, openTaskDrawer } from "./task-drawer";
import { NetworkLogo } from "@/components/assets/asset-identity";
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
    {view === "profile" && <Panel title="Company details" tone="white"><form className="grid gap-5 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); if(!manage)return; const values = new FormData(event.currentTarget); void run("save", async () => { await api(base, { name: values.get("name"), timezone: values.get("timezone") }, "PATCH"); await refreshIdentity(); refresh(); }); }}><Field label="Company name"><input name="name" className={control} defaultValue={organization.name} required readOnly={!manage} /></Field><Field label="Time zone"><TimezonePicker defaultValue={organization.timezone} disabled={!manage || !!busy}/></Field><div className="flex items-center justify-between gap-3 rounded-2xl bg-muted p-4 text-sm sm:col-span-2"><span className="text-muted-foreground">Accounting currency</span><span className="font-medium">USDC</span></div>{manage?<div className="flex justify-end border-t pt-5 sm:col-span-2"><Action busy={busy === "save"} disabled={!!busy}>Save changes</Action></div>:<p className="text-sm text-muted-foreground sm:col-span-3">An administrator can edit these settings.</p>}</form></Panel>}
    {view === "wallets" && <Panel title="Connected wallets" tone="white" action={<Action type="button" onClick={()=>openTaskDrawer("settings-link-wallet")}>Link wallet</Action>}><div className="grid gap-4"><div className="grid content-start gap-3 sm:grid-cols-2">{session.wallets.length ? session.wallets.map((wallet) => <div key={wallet.id} className="rounded-2xl border border-border bg-white p-5"><div className="mb-2 flex items-center justify-between text-sm"><span className="flex items-center gap-2 font-medium"><NetworkLogo network={wallet.family==="near"?"near":wallet.network} size={20}/>{wallet.label || `${wallet.family.toUpperCase()} wallet`}</span><span className="text-xs text-muted-foreground">{wallet.network}</span></div><Address value={wallet.address} network={wallet.network} /></div>) : <Empty>No wallets linked yet.</Empty>}</div><TaskDrawer id="settings-link-wallet" title="Link wallet"><WalletButtons link onComplete={refreshIdentity} /></TaskDrawer></div></Panel>}
    {view === "policies" && <TreasuryPolicyPanel />}
    {view === "team" && <TeamAccessPanel />}
    {view === "integrations" && <IntegrationsPanel key={organization.id} />}
    {error && <p role="alert" className="rounded-xl border border-destructive/20 bg-white p-4 text-sm text-destructive">{error}</p>}
  </div>;
}

export { ActivityLog } from "./activity-log";
export { Assistant } from "./invoice-assistant";

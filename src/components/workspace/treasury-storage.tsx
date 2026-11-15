"use client";

import { useState } from "react";
import { api, RequestError } from "@/lib/api";
import { formatUnits, parseUnits } from "@/lib/money";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { withTaskDrawerWallet } from "./task-drawer";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, Field, control } from "./shared";

interface StorageState { configured: true; network: string; companyId: string; treasuryAccount: string; ownerAccount: string; storage: { storage_credit: string; storage_used: string; storage_available: string } }
interface Prepared extends StorageState { deposit: string; walletActions: NearWalletAction[] }

export function TreasuryStorage() {
  const { base, revision, refresh, organization, notify } = useWorkspace();
  const { data, error: loadError } = useResource<StorageState | { configured: false }>(organization.permissions?.includes("company:read") ? `${base}/treasury-policy/storage` : null, revision);
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("0.01"), [prepared, setPrepared] = useState<Prepared | null>(null), [pending, setPending] = useState<{ companyId: string; credit: string } | null>(null);
  if (!data?.configured) return loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : null;
  const preview = prepared?.companyId === data.companyId ? prepared : null;
  const unresolved = pending?.companyId === data.companyId && BigInt(data.storage.storage_credit) < BigInt(pending.credit);
  const manage = organization.permissions?.includes("company:manage");
  return <section aria-busy={!!busy} className="grid gap-5 border-t pt-5">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Storage</h3>{manage && !editing && !preview && !unresolved && <button type="button" className="text-sm text-primary" onClick={() => setEditing(true)}>Add allowance</button>}</div>
    <dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-muted-foreground">Unused NEAR</dt><dd className="mt-1 font-medium tabular-nums">{formatUnits(data.storage.storage_available, 24)}</dd></div><div><dt className="text-xs text-muted-foreground">Used NEAR</dt><dd className="mt-1 font-medium tabular-nums">{formatUnits(data.storage.storage_used, 24)}</dd></div></dl>
    {manage && editing && !preview && <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void run("prepare", async () => { setPrepared(null); setPrepared(await api<Prepared>(`${base}/treasury-policy/storage/prepare`, { deposit: parseUnits(amount, 24) })); }); }}>
      <Field label="Storage deposit (NEAR)"><input className={control} inputMode="decimal" value={amount} disabled={!!busy || unresolved} onChange={event => { setAmount(event.target.value); setPrepared(null); }}/></Field>
      <div><Action busy={busy === "prepare"} disabled={!!busy || unresolved}>Review deposit</Action></div>
    </form>}
    {preview && manage && <div className="grid gap-4"><button type="button" className="justify-self-start text-sm text-primary" disabled={!!busy} onClick={() => setPrepared(null)}>Edit amount</button><p className="text-2xl font-medium">{formatUnits(preview.deposit, 24)} NEAR</p><dl className="grid gap-4 text-xs"><div><dt className="mb-1 text-muted-foreground">From</dt><dd><Address value={preview.ownerAccount} network={preview.network}/></dd></div><div><dt className="mb-1 text-muted-foreground">Treasury storage</dt><dd><Address value={preview.treasuryAccount} network={preview.network}/></dd></div></dl><p className="text-xs text-muted-foreground">Network gas is additional.</p><Action busy={busy === "authorize"} disabled={!!busy || unresolved} onClick={() => void run("authorize", async () => {
      const fresh = await api<Prepared>(`${base}/treasury-policy/storage/prepare`, { deposit: preview.deposit });
      if (fresh.companyId !== preview.companyId || fresh.ownerAccount !== preview.ownerAccount || JSON.stringify(fresh.walletActions) !== JSON.stringify(preview.walletActions)) { setPrepared(null); throw new RequestError("Company storage instructions changed. Review them again.", 409, "STORAGE_REVIEW_CHANGED"); }
      const expected = (BigInt(fresh.storage.storage_credit) + BigInt(fresh.deposit)).toString();
      await withTaskDrawerWallet(()=>signNearActions(fresh.walletActions, fresh.network, [fresh.ownerAccount]));
      setPending({ companyId: fresh.companyId, credit: expected }); setPrepared(null); setEditing(false); refresh();
      notify("Storage deposit submitted.");
    })}>Confirm in wallet</Action></div>}
    {unresolved && <div className="mt-4 grid gap-3"><p className="text-sm">Storage deposit awaiting confirmation.</p><Action disabled={!!busy} onClick={refresh}>Check status</Action></div>}
    {(error || loadError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || loadError}</p>}
  </section>;
}

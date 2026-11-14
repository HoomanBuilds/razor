"use client";

import { useState } from "react";
import { api, RequestError } from "@/lib/api";
import { formatUnits, parseUnits } from "@/lib/money";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Field, Panel, control } from "./shared";

interface StorageState { configured: true; network: string; companyId: string; treasuryAccount: string; ownerAccount: string; storage: { storage_credit: string; storage_used: string; storage_available: string } }
interface Prepared extends StorageState { deposit: string; walletActions: NearWalletAction[] }

export function TreasuryStorage() {
  const { base, revision, refresh, organization, notify } = useWorkspace();
  const { data, error: loadError } = useResource<StorageState | { configured: false }>(organization.permissions?.includes("company:read") ? `${base}/treasury-policy/storage` : null, revision);
  const { busy, error, run } = useAction();
  const [amount, setAmount] = useState("0.01"), [prepared, setPrepared] = useState<Prepared | null>(null), [pending, setPending] = useState<{ companyId: string; credit: string } | null>(null);
  if (!data?.configured) return loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : null;
  const preview = prepared?.companyId === data.companyId ? prepared : null;
  const unresolved = pending?.companyId === data.companyId && BigInt(data.storage.storage_credit) < BigInt(pending.credit);
  const manage = organization.permissions?.includes("company:manage");
  return <Panel title="Company storage allowance" collapsible description={`${formatUnits(data.storage.storage_available,24)} NEAR unused`} help="Treasury code is deployed once. This allowance funds company records and remains separate from spendable USDC.">
    <p className="text-sm">Unused: {formatUnits(data.storage.storage_available, 24)} NEAR. Used: {formatUnits(data.storage.storage_used, 24)} NEAR. Part of the unused allowance remains reserved for transfer callbacks.</p>
    {manage && <form className="mt-4 grid gap-4" onSubmit={event => { event.preventDefault(); void run("prepare", async () => { setPrepared(null); setPrepared(await api<Prepared>(`${base}/treasury-policy/storage/prepare`, { deposit: parseUnits(amount, 24) })); }); }}>
      <Field label="Add storage allowance in NEAR" hint="This funds company records, not a new contract deployment. Wallet gas is additional."><input className={control} inputMode="decimal" value={amount} disabled={!!busy || unresolved} onChange={event => { setAmount(event.target.value); setPrepared(null); }}/></Field>
      <div><Action busy={busy === "prepare"} disabled={!!busy || unresolved}>Review storage funding</Action></div>
    </form>}
    {preview && manage && <div className="mt-4 grid gap-3 rounded-lg border p-4"><p className="text-sm">Add {formatUnits(preview.deposit, 24)} NEAR on {preview.network} from {preview.ownerAccount} to the storage allowance for this company.</p><Action busy={busy === "authorize"} disabled={!!busy || unresolved} onClick={() => void run("authorize", async () => {
      const fresh = await api<Prepared>(`${base}/treasury-policy/storage/prepare`, { deposit: preview.deposit });
      if (fresh.companyId !== preview.companyId || fresh.ownerAccount !== preview.ownerAccount || JSON.stringify(fresh.walletActions) !== JSON.stringify(preview.walletActions)) { setPrepared(null); throw new RequestError("Company storage instructions changed. Review them again.", 409, "STORAGE_REVIEW_CHANGED"); }
      const expected = (BigInt(fresh.storage.storage_credit) + BigInt(fresh.deposit)).toString();
      await signNearActions(fresh.walletActions, fresh.network, [fresh.ownerAccount]);
      setPending({ companyId: fresh.companyId, credit: expected }); setPrepared(null); refresh();
      notify("Storage funding submitted. The confirmed allowance will update after verification.");
    })}>Authorize storage funding</Action></div>}
    {unresolved && <div className="mt-4 grid gap-3"><p className="text-sm">Waiting for the confirmed company allowance. Check its status before funding again.</p><Action disabled={!!busy} onClick={refresh}>Check confirmed allowance</Action></div>}
    {(error || loadError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || loadError}</p>}
  </Panel>;
}

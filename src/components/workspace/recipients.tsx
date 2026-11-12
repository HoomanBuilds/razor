"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, DataTable, Empty, Field, Panel, Status } from "./shared";
import type { Token } from "./types";

export function Recipients() {
  const { base, recipients, revision, refresh } = useWorkspace();
  const { data: assets, error: assetError } = useResource<{ tokens: Token[] }>("/assets", revision);
  const { busy, error, run } = useAction();
  const [assetId, setAssetId] = useState("");
  const [filter, setFilter] = useState("");
  const [invitation, setInvitation] = useState("");
  const selected = assets?.tokens.find((token) => token.assetId === assetId);
  const tokens = assets?.tokens.filter((token) => `${token.symbol} ${token.blockchain}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <div className="grid gap-6"><Panel title="Add a payee" description="Invite employees, contractors and businesses to confirm their own payment preferences. Adding a profile does not grant spending authority."><form className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget, values = new FormData(form); void run("create", async () => { const result = await api<{ invitationUrl: string }>(`${base}/recipients`, { name: values.get("name"), email: values.get("email") || undefined, kind: values.get("kind"), primaryAsset: assetId, primaryNetwork: selected?.blockchain, primaryAddress: values.get("address"), backupNetwork: values.get("backupNetwork") || undefined, backupAddress: values.get("backupAddress") || undefined }); setInvitation(result.invitationUrl); form.reset(); setAssetId(""); refresh(); }); }}>
    <Field label="Full name or business"><input name="name" className={control} maxLength={160} required /></Field>
    <Field label="Email"><input name="email" type="email" className={control} /></Field>
    <Field label="Relationship"><select name="kind" className={control}><option value="employee">Employee</option><option value="contractor">Contractor or freelancer</option><option value="business">Business or supplier</option></select></Field>
    <Field label="Find receiving asset"><input value={filter} onChange={(event) => setFilter(event.target.value)} className={control} placeholder="USDC, Base, Bitcoin..." /></Field>
    <Field label="Primary asset and network"><select className={control} required value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="">Choose supported asset</option>{tokens.map((token) => <option key={token.assetId} value={token.assetId}>{token.symbol} on {token.blockchain}</option>)}</select></Field>
    <Field label="Primary receiving address"><input name="address" className={control} required autoComplete="off" placeholder={selected ? `Address on ${selected.blockchain}` : "Choose an asset first"} /></Field>
    <Field label="Native USDC backup network"><select name="backupNetwork" className={control}><option value="">Manual payments only for now</option><option value="base">Base</option><option value="arb">Arbitrum</option><option value="pol">Polygon</option><option value="sol">Solana</option><option value="eth">Ethereum</option><option value="near">NEAR</option></select></Field>
    <Field label="USDC backup address" hint="The payee must confirm the address and consent before backup can be used."><input name="backupAddress" className={control} autoComplete="off" /></Field>
    <div className="self-center"><Action busy={busy === "create"} disabled={!assets}>Create and invite payee</Action></div>
  </form>{assetError && <p className="mt-3 text-sm text-amber-800">Asset catalog unavailable. Refresh before adding a destination.</p>}{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}{invitation && <div className="mt-4 rounded-lg bg-secondary p-4 text-sm"><p className="font-medium">Share this secure invitation with the payee</p><input readOnly aria-label="Payee invitation link" value={invitation} className={`${control} mt-2`} onFocus={(event) => event.target.select()} /></div>}</Panel>
  <Panel title="Payee directory" description="Profiles are versioned. Changes after approval require payment revalidation.">{!recipients.length ? <Empty>No payees yet. Add someone above to start a bill or pay run.</Empty> : <DataTable columns={["Payee", "Relationship", "Primary destination", "Backup", "Version"]}>{recipients.map((recipient) => <tr key={recipient.id}><td><div className="font-medium">{recipient.name}</div><p className="mt-1 text-xs text-muted-foreground">{recipient.email}</p></td><td className="capitalize">{recipient.kind}</td><td><div className="mb-1 text-xs uppercase text-muted-foreground">{assets?.tokens.find((token) => token.assetId === recipient.primary_asset)?.symbol ?? "Token"} · {recipient.primary_network}</div><Address value={recipient.primary_address} network={recipient.primary_network} /></td><td>{recipient.backup_network ? <div><div className="mb-1 text-xs">USDC · {recipient.backup_network}</div><Status value={recipient.fallback_consent ? "confirmed" : "awaiting_consent"} /></div> : <Status value="manual_only" />}</td><td>v{recipient.version}</td></tr>)}</DataTable>}</Panel></div>;
}

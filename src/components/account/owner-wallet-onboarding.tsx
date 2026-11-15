"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { authenticateWallet } from "@/components/auth/wallets";
import { useAction, useResource } from "@/components/workspace/hooks";
import { Action, Address, control, Field, Panel } from "@/components/workspace/shared";
import type { AccountStatus } from "./types";
import { EmbeddedNearOnboarding } from "./embedded-near-onboarding";

export function OwnerWalletOnboarding({onChanged,revision:externalRevision=0}:{onChanged?:()=>void;revision?:number}) {
  const [revision,setRevision]=useState(0),{data:status,error:loadError}=useResource<AccountStatus>("/account/status",revision+externalRevision),{busy,error,run}=useAction(),[choice,setChoice]=useState(""),[method,setMethod]=useState("");
  const providerId=choice || status?.onboarding?.wallet_provider || status?.preferredProvider || "",provider=status?.providers.find(value=>value.id===providerId) || status?.providers[0];
  const mode=method || (status?.nativeEmbeddedNear?.available?"embedded":"external");
  function changed(){setRevision(value=>value+1);onChanged?.();}
  return <div className="grid gap-5"><div className="flex w-fit max-w-full gap-1 rounded-full bg-muted p-1" role="group" aria-label="NEAR wallet setup">{[["embedded","Google or email"],["external","My NEAR wallet"]].map(([value,label])=><button type="button" key={value} disabled={!!busy} aria-pressed={mode===value} onClick={()=>setMethod(value)} className={`rounded-full px-4 py-2 text-sm ${mode===value?"bg-white font-medium shadow-sm":"text-muted-foreground"}`}>{label}</button>)}</div><div hidden={mode!=="embedded"}><EmbeddedNearOnboarding account={status} onChanged={changed}/></div><div hidden={mode!=="external"}><Panel title="Connect a NEAR wallet">
    {loadError?<p role="alert" className="text-sm text-destructive">{loadError}</p>:null}
    {status?<div className="grid gap-4"><Field label={`Wallet provider for NEAR ${status.network}`}><select className={control} value={provider?.id || ""} disabled={!!busy} onChange={event=>{setChoice(event.target.value);void run("provider",async()=>{await api("/account/onboarding",{provider:event.target.value},"PUT");changed();});}}>{status.providers.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></Field>
      {provider?<><div className="flex flex-wrap gap-3"><a href={provider.creationUrl} target="_blank" rel="noreferrer" className="rounded-full border px-4 py-2.5 text-sm font-medium hover:bg-muted">Create wallet in {provider.name}</a><Action disabled={!!busy||!status.freshSignIn} busy={busy==="link"} onClick={()=>void run("link",async()=>{await authenticateWallet("near",{link:true,walletId:provider.id});changed();})}>Connect wallet</Action></div><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Wallet recovery</summary><p className="mt-3">{provider.custody}</p><p className="mt-2">{provider.recovery}</p><a href={provider.recoveryUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-primary">Recovery guide</a></details></>:null}
      {!status.freshSignIn?<p className="text-sm text-amber-900">Verify a linked sign-in method again in <a href="/account" className="underline">Account and recovery</a> before linking another wallet.</p>:null}
      {status.ownerWallet&&status.onboarding?.wallet_provider!=="privy-near"?<div className="space-y-3 rounded-lg border p-4"><p className="text-sm font-semibold">Linked owner wallet</p><Address value={status.ownerWallet.address} network={status.ownerWallet.network}/><label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1.5" checked={!!status.backupAcknowledgedAt} disabled={!!busy||!status.freshSignIn} onChange={event=>void run("backup",async()=>{await api("/account/onboarding",{provider:provider?.id,ownerWalletId:status.ownerWallet!.id,backupAcknowledged:event.target.checked},"PUT");changed();})}/>I reviewed recovery and saved my backup. Razor has not verified it.</label>{!status.hasAlternateSignIn?<p className="text-xs text-muted-foreground">Add a second verified sign-in method in Account and recovery so losing one Razor login does not lock you out of your records.</p>:null}</div>:null}

    </div>:<p className="text-sm text-muted-foreground">Loading owner-wallet setup...</p>}{error?<p role="alert" className="mt-4 text-sm text-destructive">{error}</p>:null}
  </Panel></div></div>;
}

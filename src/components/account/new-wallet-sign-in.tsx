"use client";

import { useState } from "react";
import { ExternalLink, Wallet } from "lucide-react";
import { authenticateWallet, walletErrorMessage } from "@/components/auth/wallets";
import { control } from "../workspace/shared";
import { NetworkLogo } from "../assets/asset-identity";
import type { WalletProvider } from "./types";

export function NewWalletSignIn({providers,network,onComplete}:{providers:WalletProvider[];network:string;onComplete:()=>Promise<void>}) {
  const [pending,setPending]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[selected,setSelected]=useState(providers[0]?.id ?? "");
  const provider = providers.find(provider => provider.id === selected) ?? providers[0];
  return <details className="rounded-2xl border border-border bg-muted/40 p-4 text-sm"><summary className="cursor-pointer font-medium">New to NEAR? Create a wallet</summary>
    <div className="mt-4 grid gap-4">{provider ? <>
      <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"><NetworkLogo network="near" size={18}/>Create a NEAR {network} wallet, then connect it here.</p>
      <label className="grid gap-2 text-xs font-medium">Wallet provider<select className={`${control} razor-native-picker`} disabled={pending!==null} value={provider.id} onChange={event=>{setSelected(event.target.value);setError(null);}}>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
      <div className="flex flex-wrap gap-2"><a href={provider.creationUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 text-xs font-medium text-white hover:bg-primary/90">Create wallet<ExternalLink size={13}/></a><button type="button" disabled={pending!==null} aria-busy={pending!==null} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border bg-white px-4 text-xs font-medium hover:bg-muted disabled:opacity-50" onClick={async()=>{if(pending)return;setPending(provider.id);setError(null);try{await authenticateWallet("near",{walletId:provider.id});await onComplete();}catch(error){setError(walletErrorMessage(error));}finally{setPending(null);}}}><Wallet size={14}/>{pending===provider.id?"Confirm in your wallet...":"Connect wallet"}</button></div>
      <details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer">Recovery and provider details</summary><p className="mt-3 leading-5">Razor never receives your recovery phrase or private key. Account creation, recovery and any required funding happen with {provider.name}.</p><p className="mt-2 leading-5">{provider.custody}</p><a href={provider.recoveryUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 underline underline-offset-4">{provider.name} recovery guide<ExternalLink size={11}/></a></details>
    </> : <p className="text-xs leading-5 text-muted-foreground">Wallet setup is unavailable. You can still connect an existing wallet above.</p>}{error?<p role="alert" className="text-xs text-destructive">{error}</p>:null}</div>
  </details>;
}

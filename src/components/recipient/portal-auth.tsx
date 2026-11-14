"use client";

import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";
import { useIdentity } from "../auth/identity-provider";
import { SignInPanel, WalletButtons } from "../auth/sign-in-panel";
import { walletErrorMessage } from "../auth/wallets";

const SocialSignIn=dynamic(()=>import("../auth/social-sign-in"),{ssr:false});

export function PortalAuth({next,children}:{next:string;children:ReactNode}) {
  const {loading,session,error,refresh}=useIdentity();
  const [retrying,setRetrying]=useState(false),[retryError,setRetryError]=useState("");
  async function retry() {
    setRetrying(true);setRetryError("");
    try {await refresh();} catch(cause) {setRetryError(walletErrorMessage(cause));} finally {setRetrying(false);}
  }
  if(loading)return <main className="mx-auto max-w-2xl p-8 text-sm text-muted-foreground">Loading your secure session...</main>;
  if(!session)return <SignInPanel next={next}/>;
  return <>{error && <div role="alert" className="mx-5 my-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 lg:ml-28"><p>{retryError || error}</p><button type="button" disabled={retrying} onClick={()=>void retry()} className="rounded-full border border-amber-300 px-4 py-2 text-xs font-medium disabled:opacity-50">{retrying?"Checking session...":"Retry connection"}</button></div>}{children}</>;
}

export function LinkRecipientIdentity({onComplete,companyInvitation=false}:{onComplete:()=>Promise<void>;companyInvitation?:boolean}) {
  const {config,refresh}=useIdentity();
  async function complete(){await refresh();await onComplete();}
  return <section className="space-y-3 rounded-2xl border border-border bg-muted/50 p-5"><h2 className="font-medium">{companyInvitation?"Verify your invited identity":"Verify the right recipient account"}</h2><p className="text-sm leading-6 text-muted-foreground">{companyInvitation?"Prove control of the exact invited wallet, or link the invited Google or email account. Your company role remains separate from NEAR financial authority.":"Connect the original receiving wallet or link the Google or email account this invitation was sent to. Your company records stay private."}</p><WalletButtons link onComplete={onComplete}/>{config?.socialEnabled&&config.privyAppId?<SocialSignIn appId={config.privyAppId} link onComplete={complete}/>:null}</section>;
}

"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useIdentity } from "../auth/identity-provider";
import { SignInPanel, WalletButtons } from "../auth/sign-in-panel";

const SocialSignIn=dynamic(()=>import("../auth/social-sign-in"),{ssr:false});

export function PortalAuth({next,children}:{next:string;children:ReactNode}) {
  const {loading,session,error}=useIdentity();
  if(loading)return <main className="mx-auto max-w-2xl p-8 text-sm text-muted-foreground">Loading your secure session...</main>;
  if(!session)return <SignInPanel next={next}/>;
  if(error)return <p role="alert" className="p-8 text-sm text-destructive">{error}</p>;
  return children;
}

export function LinkRecipientIdentity({onComplete}:{onComplete:()=>Promise<void>}) {
  const {config,refresh}=useIdentity();
  async function complete(){await refresh();await onComplete();}
  return <section className="space-y-3 rounded-lg border border-border p-4"><h2 className="font-medium">Verify the right recipient account</h2><p className="text-sm leading-6 text-muted-foreground">Connect the original receiving wallet or link the Google or email account this invitation was sent to. Your company records stay private.</p><WalletButtons link onComplete={onComplete}/>{config?.socialEnabled&&config.privyAppId?<SocialSignIn appId={config.privyAppId} link onComplete={complete}/>:null}</section>;
}

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

export function LinkRecipientIdentity({onComplete,companyInvitation=false}:{onComplete:()=>Promise<void>;companyInvitation?:boolean}) {
  const {config,refresh}=useIdentity();
  async function complete(){await refresh();await onComplete();}
  return <section className="space-y-3 rounded-2xl border border-border bg-muted/50 p-5"><h2 className="font-medium">{companyInvitation?"Verify your invited identity":"Verify the right recipient account"}</h2><p className="text-sm leading-6 text-muted-foreground">{companyInvitation?"Prove control of the exact invited wallet, or link the invited Google or email account. Your company role remains separate from NEAR financial authority.":"Connect the original receiving wallet or link the Google or email account this invitation was sent to. Your company records stay private."}</p><WalletButtons link onComplete={onComplete}/>{config?.socialEnabled&&config.privyAppId?<SocialSignIn appId={config.privyAppId} link onComplete={complete}/>:null}</section>;
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useIdentity } from "../auth/identity-provider";
import { identityRequest, walletErrorMessage } from "../auth/wallets";
import { LinkRecipientIdentity } from "./portal-auth";

export function JoinCompany({token}:{token:string}) {
  const {session,refresh}=useIdentity(),router=useRouter(),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[joined,setJoined]=useState(false);
  async function accept() {
    if(pending)return;setPending(true);setError(null);
    try {
      const result=await identityRequest<{organizationId:string}>("/invitations/accept",{token});
      await identityRequest(`/organizations/${result.organizationId}/select`,{});
      await refresh();setJoined(true);router.replace("/");
    } catch(error){setError(walletErrorMessage(error));} finally{setPending(false);}
  }
  return <section className="space-y-6"><header><h1 className="text-2xl font-semibold">Join your company on FLOAT</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Accept the invitation with the verified email address your company invited. Your role determines the company information and payment actions you can access.</p></header><div className="rounded-lg border border-border bg-card p-4 text-sm"><p>Signed in as {session?.user.email || session?.user.name}</p>{!session?.user.email?<p className="mt-2 text-muted-foreground">Link the invited Google or email account before accepting this invitation.</p>:null}</div>{error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}{joined?<p role="status" className="text-sm text-primary">Invitation accepted. Opening your company workspace...</p>:<button type="button" disabled={pending||!session?.user.email} onClick={()=>void accept()} className="rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending?"Accepting invitation...":"Accept invitation"}</button>}{!session?.user.email||error?<LinkRecipientIdentity onComplete={refresh}/>:null}</section>;
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useIdentity } from "../auth/identity-provider";
import { identityRequest, walletErrorMessage } from "../auth/wallets";
import { LinkRecipientIdentity } from "./portal-auth";

interface Preview {company:{id:string;name:string};role:string;target:{email:string|null;wallet:{family:string;address:string;network:string}|null};status:string;canAccept:boolean;identityMatches:boolean}

export function JoinCompany({token}:{token:string}) {
  const {session,refresh}=useIdentity(),router=useRouter(),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[joined,setJoined]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let active=true;setLoading(true);setError(null);setPreview(null);
    void identityRequest<Preview>(`/invitations/${encodeURIComponent(token)}`).then(value=>{if(active)setPreview(value);}).catch(cause=>{if(active)setError(walletErrorMessage(cause));}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[token,session]);
  async function accept() {
    if(pending||!preview?.canAccept)return;setPending(true);setError(null);
    try {
      await identityRequest<{organizationId:string}>("/invitations/accept",{token});
      setJoined(true);await refresh();router.replace("/");
    } catch(error){setError(walletErrorMessage(error));} finally{setPending(false);}
  }
  const target=preview?.target.email || (preview?.target.wallet?`${preview.target.wallet.address} (${preview.target.wallet.family}, ${preview.target.wallet.network})`:null);
  const unavailable=preview&&!["pending","accepted"].includes(preview.status);
  return <section className="workspace-panel space-y-6 p-6 sm:p-8"><header><h1 className="text-3xl font-medium tracking-tight">Join your company on Razor</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Verify the email or wallet your company invited. Your company role controls access to its information and payment actions.</p></header>
    {loading?<p role="status" className="text-sm text-muted-foreground">Checking your invitation...</p>:preview?<div className="space-y-3 rounded-2xl border border-border bg-white p-5 text-sm"><p>Company: <strong>{preview.company.name}</strong></p><p>Role: {preview.role}</p><p className="break-all">Invited identity: {target}</p><p>Signed in as {session?.user.email || session?.user.name}</p>{unavailable?<p className="text-muted-foreground">This invitation is {preview.status}. Ask a company administrator for a new invitation.</p>:!preview.identityMatches?<p className="text-muted-foreground">Link and verify the invited identity on this account before accepting.</p>:preview.status==="accepted"&&!preview.canAccept?<p className="text-muted-foreground">This invitation has already been used and cannot restore company access. Ask for a new invitation.</p>:null}</div>:null}
    {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
    {joined?<p role="status" className="text-sm text-primary">Invitation accepted. Opening your company workspace...</p>:<div className="flex flex-wrap items-center gap-4"><button type="button" disabled={pending||loading||!preview?.canAccept} onClick={()=>void accept()} aria-busy={pending} className="rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending?"Accepting invitation...":preview?.status==="accepted"?"Open company workspace":"Accept invitation"}</button><a href="/" className="text-sm text-primary">Back to Razor</a></div>}
    {preview&&!preview.identityMatches&&!unavailable?<LinkRecipientIdentity onComplete={refresh} companyInvitation/>:null}
  </section>;
}

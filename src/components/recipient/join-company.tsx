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
      setJoined(true);await refresh();router.replace("/app");
    } catch(error){setError(walletErrorMessage(error));} finally{setPending(false);}
  }
  const target=preview?.target.email || (preview?.target.wallet?`${preview.target.wallet.address} (${preview.target.wallet.family}, ${preview.target.wallet.network})`:null);
  const unavailable=preview&&!["pending","accepted"].includes(preview.status);
  return <section className="workspace-panel grid gap-5 p-6 sm:p-8"><header><h1 className="text-3xl font-medium tracking-tight">{preview ? `Join ${preview.company.name}` : "Company invitation"}</h1></header>
    {loading ? <p role="status" className="text-sm text-muted-foreground">Checking invitation...</p> : preview ? <div className="grid gap-4 rounded-2xl bg-muted/50 p-5"><div className="flex items-center justify-between gap-3"><span className="text-sm text-muted-foreground">Company role</span><span className="text-sm font-medium capitalize">{preview.role.replaceAll("_", " ")}</span></div><div><p className="text-xs text-muted-foreground">Invited identity</p><p className="mt-1 break-all text-sm">{target}</p></div><div><p className="text-xs text-muted-foreground">Signed in</p><p className="mt-1 break-all text-sm">{session?.user.email || session?.user.name}</p></div>{unavailable ? <p role="status" className="text-sm text-amber-800">Invitation {preview.status}. Request a new invitation.</p> : !preview.identityMatches ? <p role="status" className="text-sm text-amber-800">Verify the invited identity to continue.</p> : preview.status === "accepted" && !preview.canAccept ? <p role="status" className="text-sm text-amber-800">This invitation was already used. Request a new invitation.</p> : null}</div> : null}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {preview && !preview.identityMatches && !unavailable ? <LinkRecipientIdentity onComplete={refresh} companyInvitation/> : null}
    {joined ? <p role="status" className="text-sm text-emerald-700">Joined. Opening company workspace...</p> : <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-5"><a href="/" className="text-sm text-muted-foreground">Back to Razor</a>{preview?.canAccept && <button type="button" disabled={pending || loading} onClick={() => void accept()} aria-busy={pending} className="rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Joining..." : preview.status === "accepted" ? "Open workspace" : "Accept invitation"}</button>}</div>}
  </section>;
}

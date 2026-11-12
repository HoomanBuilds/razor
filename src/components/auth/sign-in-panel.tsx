"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ShieldCheck, Wallet } from "lucide-react";
import { useIdentity } from "./identity-provider";
import { walletErrorMessage, type WalletFamily } from "./wallets";

const SocialSignIn=dynamic(()=>import("./social-sign-in"),{ssr:false,loading:()=> <p className="text-sm text-slate-500">Loading secure sign-in...</p>});
const WALLETS:Array<{family:WalletFamily;label:string}>=[{family:"near",label:"NEAR wallet"},{family:"evm",label:"Ethereum or EVM wallet"},{family:"solana",label:"Solana wallet"}];

export function WalletButtons({link=false,onComplete}:{link?:boolean;onComplete?:()=>Promise<void>}) {
  const {signInWallet}=useIdentity(),[pending,setPending]=useState<WalletFamily|null>(null),[error,setError]=useState<string|null>(null);
  async function connect(family:WalletFamily) {
    if(pending)return;
    setPending(family);setError(null);
    try {await signInWallet(family,link);await onComplete?.();} catch(error) {setError(walletErrorMessage(error));} finally {setPending(null);}
  }
  return <div className="space-y-3">{WALLETS.map(({family,label})=><button key={family} type="button" disabled={pending!==null} onClick={()=>void connect(family)} className="flex w-full items-center justify-between rounded-lg border border-slate-300 px-4 py-3 text-left font-medium disabled:opacity-50"><span className="flex items-center gap-3"><Wallet size={18}/>{pending===family?"Confirm in your wallet...":`${link?"Link":"Continue with"} ${label}`}</span><ArrowUpRight size={16}/></button>)}{error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}</div>;
}

export function SignInPanel({next="/",link=false}:{next?:string;link?:boolean}) {
  const {config,session,loading,error,refresh}=useIdentity(),router=useRouter();
  const destination=next.startsWith("/")&&!next.startsWith("//")?next:"/";
  useEffect(()=>{if(session&&!link)router.replace(destination);},[session,link,router,destination]);
  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-900"><section className="w-full max-w-md space-y-7 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><div><a href="/" className="text-xl font-bold tracking-tight">FLOAT</a><h1 className="mt-7 text-2xl font-semibold">{link?"Connect your account":"Your business, moving forward"}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{link?"Link a verified wallet or social sign-in to your current FLOAT account.":"Sign in, create your company, and manage payroll, contractors and business payments."}</p></div>{loading?<p aria-live="polite" className="text-sm text-slate-500">Loading sign-in options...</p>:<><WalletButtons link={link}/>{config?.socialEnabled&&config.privyAppId?<><div className="flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200"/>or<span className="h-px flex-1 bg-slate-200"/></div><SocialSignIn appId={config.privyAppId} onComplete={refresh} link={link}/></>:<p className="text-xs text-slate-500">Google and email sign-in are not configured yet. You can continue with your wallet.</p>}</>}{error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}<p className="flex items-start gap-2 border-t border-slate-100 pt-5 text-xs leading-5 text-slate-500"><ShieldCheck size={16} className="mt-0.5 shrink-0"/>Sign-in verifies your account. Payments always require the permissions and wallet approvals set by your company.</p></section></main>;
}

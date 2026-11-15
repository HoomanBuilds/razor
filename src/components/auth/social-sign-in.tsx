"use client";

import { appFetch } from "@/lib/demo-scope";

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { useRef, useState } from "react";
import { identityRequest, walletErrorMessage } from "./wallets";

function SocialButton({onComplete,link=false,reauth=false}:{onComplete:()=>Promise<void>;link?:boolean;reauth?:boolean}) {
  const {getAccessToken,ready,authenticated,logout,user}=usePrivy(),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),lock=useRef(false);
  async function exchange() {
    try {
      const accessToken=await getAccessToken();
      if(!accessToken)throw new Error("Your sign-in expired. Please try again.");
      await identityRequest("/auth/privy",{accessToken,link,reauth});
      await onComplete();
    }catch(error){setError(walletErrorMessage(error));}finally{lock.current=false;setPending(false);}
  }
  const {login}=useLogin({
    onComplete:exchange,
    onError:()=>{setError("Sign-in was cancelled or could not be completed. Please try again.");lock.current=false;setPending(false);},
  });
  async function begin() {
    if(lock.current)return;lock.current=true;setError(null);setPending(true);
    if(authenticated){await exchange();return;}
    try{login({loginMethods:["google","email"]});}catch(error){setError(walletErrorMessage(error));lock.current=false;setPending(false);}
  }
  async function switchAccount() {
    if(lock.current)return;lock.current=true;setPending(true);setError(null);
    try {
      if(!link&&!reauth){const response=await appFetch("/api/auth/logout",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"});if(!response.ok&&response.status!==401)throw new Error("Your Razor session could not be closed. Please try again.");}
      await logout();await onComplete();
    }catch(error){setError(walletErrorMessage(error));}finally{lock.current=false;setPending(false);}
  }
  const account=user?.email?.address || user?.google?.email;
  return <div className="space-y-2"><button type="button" className="flex min-h-13 w-full items-center justify-center gap-3 rounded-full bg-primary px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50" aria-busy={pending} disabled={!ready||pending} onClick={()=>void begin()}><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white"><img src="/brand/google-g.png" alt="" width={18} height={18}/></span><span className="min-w-0 break-words">{pending?"Confirm your sign-in...":reauth?"Verify linked Google or email again":authenticated&&account?`${link?"Link":"Continue as"} ${account}`:link?"Link Google or email":"Continue with Google or email"}</span></button>{authenticated?<button type="button" disabled={pending} onClick={()=>void switchAccount()} className="text-xs underline disabled:opacity-50">{reauth?"Sign out of the provider before signing in again":"Use a different Google or email account"}</button>:null}{error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}</div>;
}

export default function SocialSignIn({appId,onComplete,link,reauth}:{appId:string;onComplete:()=>Promise<void>;link?:boolean;reauth?:boolean}) {
  return appId?<SocialButton onComplete={onComplete} link={link} reauth={reauth}/>:null;
}

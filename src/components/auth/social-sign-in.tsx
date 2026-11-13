"use client";

import { PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import { useRef, useState } from "react";
import { identityRequest, walletErrorMessage } from "./wallets";

function SocialButton({onComplete,link=false}:{onComplete:()=>Promise<void>;link?:boolean}) {
  const {getAccessToken,ready,authenticated,logout,user}=usePrivy(),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),lock=useRef(false);
  async function exchange() {
    try {
      const accessToken=await getAccessToken();
      if(!accessToken)throw new Error("Your sign-in expired. Please try again.");
      await identityRequest("/auth/privy",{accessToken,link});
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
    try{login({loginMethods:["google","email","passkey"]});}catch(error){setError(walletErrorMessage(error));lock.current=false;setPending(false);}
  }
  async function switchAccount() {
    if(lock.current)return;lock.current=true;setPending(true);setError(null);
    try {
      if(!link){const response=await fetch("/api/auth/logout",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"});if(!response.ok&&response.status!==401)throw new Error("Your Razor session could not be closed. Please try again.");}
      await logout();await onComplete();
    }catch(error){setError(walletErrorMessage(error));}finally{lock.current=false;setPending(false);}
  }
  const account=user?.email?.address || user?.google?.email;
  return <div className="space-y-2"><button type="button" className="w-full rounded-lg border border-slate-300 px-4 py-3 font-medium disabled:opacity-50" disabled={!ready||pending} onClick={()=>void begin()}>{pending?"Confirm your sign-in...":authenticated&&account?`${link?"Link":"Continue as"} ${account}`:link?"Link Google or email":"Continue with Google or email"}</button>{authenticated?<button type="button" disabled={pending} onClick={()=>void switchAccount()} className="text-xs underline disabled:opacity-50">Use a different Google or email account</button>:null}{error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}</div>;
}

export default function SocialSignIn({appId,onComplete,link}:{appId:string;onComplete:()=>Promise<void>;link?:boolean}) {
  return <PrivyProvider appId={appId} config={{loginMethods:["google","email","passkey"],appearance:{theme:"light",accentColor:"#2463eb",walletList:[]},embeddedWallets:{ethereum:{createOnLogin:"off"},solana:{createOnLogin:"off"}}}}><SocialButton onComplete={onComplete} link={link}/></PrivyProvider>;
}

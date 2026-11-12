"use client";

import { PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import { useState } from "react";
import { identityRequest, walletErrorMessage } from "./wallets";

function SocialButton({onComplete,link=false}:{onComplete:()=>Promise<void>;link?:boolean}) {
  const {getAccessToken,ready}=usePrivy(),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
  const {login}=useLogin({
    onComplete:async()=>{
      try {
        const accessToken=await getAccessToken();
        if(!accessToken) throw new Error("Your sign-in expired. Please try again.");
        await identityRequest("/auth/privy",{accessToken,link});
        await onComplete();
      } catch(error) {setError(walletErrorMessage(error));} finally {setPending(false);}
    },
    onError:()=>{setError("Sign-in was cancelled or could not be completed. Please try again.");setPending(false);},
  });
  return <div className="space-y-2"><button type="button" className="w-full rounded-lg border border-slate-300 px-4 py-3 font-medium disabled:opacity-50" disabled={!ready||pending} onClick={()=>{setError(null);setPending(true);login({loginMethods:["google","email","passkey"]});}}>{pending?"Confirm your sign-in...":link?"Link Google or email":"Continue with Google or email"}</button>{error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}</div>;
}

export default function SocialSignIn({appId,onComplete,link}:{appId:string;onComplete:()=>Promise<void>;link?:boolean}) {
  return <PrivyProvider appId={appId} config={{loginMethods:["google","email","passkey"],appearance:{theme:"light",accentColor:"#2463eb",walletList:[]},embeddedWallets:{ethereum:{createOnLogin:"off"},solana:{createOnLogin:"off"}}}}><SocialButton onComplete={onComplete} link={link}/></PrivyProvider>;
}

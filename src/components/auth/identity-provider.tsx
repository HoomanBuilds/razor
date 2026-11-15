"use client";

import { appFetch, isPublicDemo } from "@/lib/demo-scope";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ACCESS_CHANGED_EVENT, SESSION_EXPIRED_EVENT } from "@/lib/api";
import { authenticateWallet, identityRequest, walletErrorMessage, type AuthConfig, type WalletFamily } from "./wallets";
import { EmbeddedNearProvider } from "./embedded-near-provider";
import { clearEmbeddedNearBridge } from "@/lib/embedded-near-signer";

export interface IdentitySession {
  user:{id:string;email:string|null;name:string};
  organizations:Array<{id:string;name:string;role:string;permissions:string[];timezone:string;settlement_asset:string;near_network:string;treasury_account_id:string|null}>;
  wallets:Array<{id:string;family:WalletFamily;address:string;network:string;label:string|null}>;
  activeOrganizationId:string|null;
  recipientProfileCount?:number;
  permissions:string[];
}

interface IdentityContextValue {
  config:AuthConfig|null; session:IdentitySession|null; loading:boolean; error:string|null;
  refresh:()=>Promise<void>; signInWallet:(family:WalletFamily,link?:boolean)=>Promise<void>; signOut:()=>Promise<void>;
}

const IdentityContext=createContext<IdentityContextValue|null>(null);

export function IdentityProvider({children}:{children:ReactNode}) {
  const [config,setConfig]=useState<AuthConfig|null>(null),[session,setSession]=useState<IdentitySession|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null);
  const sessionRef=useRef(session),epoch=useRef(0),lastRefresh=useRef(0);
  const pending=useRef<{promise:Promise<void>;controller:AbortController}|null>(null);
  sessionRef.current=session;
  const clearSession=useCallback((expired=false)=>{
    clearEmbeddedNearBridge();
    epoch.current++;
    pending.current?.controller.abort();
    pending.current=null;
    if(expired && sessionRef.current) setError("Your session expired. Sign in again to continue with your saved company records.");
    sessionRef.current=null;
    setSession(null);
  },[]);
  const refresh=useCallback(()=>{
    if(pending.current)return pending.current.promise;
    const version=epoch.current,controller=new AbortController();
    const promise=(async()=>{
      try {
        const response=await appFetch("/api/auth/session",{credentials:"same-origin",cache:"no-store",signal:controller.signal});
        if(version!==epoch.current)return;
        if(response.status===401){clearSession(true);return;}
        const result=await response.json();
        if(!response.ok)throw new Error(result.error?.message || result.message || "Your session could not be loaded.");
        if(version!==epoch.current)return;
        lastRefresh.current=Date.now();
        sessionRef.current=result;
        setSession(result);
        setError(null);
      } catch(cause) {
        if(!controller.signal.aborted)throw cause;
      }
    })().finally(()=>{if(pending.current?.promise===promise)pending.current=null;});
    pending.current={promise,controller};
    return promise;
  },[clearSession]);

  useEffect(()=>{
    const expired=()=>clearSession(true);
    const changed=()=>{void refresh().catch(cause=>setError(walletErrorMessage(cause)));};
    const focus=()=>{if(sessionRef.current && document.visibilityState==="visible" && Date.now()-lastRefresh.current>15000)changed();};
    window.addEventListener(SESSION_EXPIRED_EVENT,expired);
    window.addEventListener(ACCESS_CHANGED_EVENT,changed);
    window.addEventListener("focus",focus);
    document.addEventListener("visibilitychange",focus);
    return()=>{
      window.removeEventListener(SESSION_EXPIRED_EVENT,expired);
      window.removeEventListener(ACCESS_CHANGED_EVENT,changed);
      window.removeEventListener("focus",focus);
      document.removeEventListener("visibilitychange",focus);
    };
  },[clearSession,refresh]);

  useEffect(()=>{
    let active=true;
    Promise.all([identityRequest<AuthConfig>("/auth/config"),refresh()]).then(([result])=>{if(active)setConfig(result);}).catch((error)=>{if(active)setError(walletErrorMessage(error));}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;epoch.current++;pending.current?.controller.abort();pending.current=null;};
  },[refresh]);

  const signInWallet=useCallback(async(family:WalletFamily,link=false)=>{await authenticateWallet(family,{link});await refresh();},[refresh]);
  const signOut=useCallback(async()=>{if(isPublicDemo())throw new Error("Use the demo profile switcher to change accounts.");await identityRequest("/auth/logout",{});clearSession();setError(null);},[clearSession]);

  return <IdentityContext.Provider value={{config,session,loading,error,refresh,signInWallet,signOut}}><EmbeddedNearProvider appId={config?.socialEnabled?config.privyAppId:null} userId={session?.user.id||null} network={config?.nearNetwork||"testnet"} onIdentityChanged={refresh}>{children}</EmbeddedNearProvider></IdentityContext.Provider>;
}

export function useIdentity() {
  const identity=useContext(IdentityContext);
  if(!identity) throw new Error("Render IdentityProvider before using identity actions.");
  return identity;
}

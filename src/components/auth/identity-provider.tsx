"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { authenticateWallet, identityRequest, walletErrorMessage, type AuthConfig, type WalletFamily } from "./wallets";

export interface IdentitySession {
  user:{id:string;email:string|null;name:string};
  organizations:Array<{id:string;name:string;role:string;permissions:string[];timezone:string;settlement_asset:string;near_network:string;treasury_account_id:string|null}>;
  wallets:Array<{id:string;family:WalletFamily;address:string;network:string;label:string|null}>;
  activeOrganizationId:string|null;
  permissions:string[];
}

interface IdentityContextValue {
  config:AuthConfig|null; session:IdentitySession|null; loading:boolean; error:string|null;
  refresh:()=>Promise<void>; signInWallet:(family:WalletFamily,link?:boolean)=>Promise<void>; signOut:()=>Promise<void>;
}

const IdentityContext=createContext<IdentityContextValue|null>(null);

export function IdentityProvider({children}:{children:ReactNode}) {
  const [config,setConfig]=useState<AuthConfig|null>(null),[session,setSession]=useState<IdentitySession|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null);
  const refresh=useCallback(async()=>{
    const response=await fetch("/api/auth/session",{credentials:"same-origin",cache:"no-store"});
    if(response.status===401) {setSession(null);return;}
    const result=await response.json();
    if(!response.ok) throw new Error(result.error?.message || result.message || "Your session could not be loaded.");
    setSession(result);
  },[]);

  useEffect(()=>{
    let active=true;
    Promise.all([identityRequest<AuthConfig>("/auth/config"),refresh()]).then(([result])=>{if(active)setConfig(result);}).catch((error)=>{if(active)setError(walletErrorMessage(error));}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[refresh]);

  const signInWallet=useCallback(async(family:WalletFamily,link=false)=>{await authenticateWallet(family,{link});await refresh();},[refresh]);
  const signOut=useCallback(async()=>{await identityRequest("/auth/logout",{});setSession(null);},[]);

  return <IdentityContext.Provider value={{config,session,loading,error,refresh,signInWallet,signOut}}>{children}</IdentityContext.Provider>;
}

export function useIdentity() {
  const identity=useContext(IdentityContext);
  if(!identity) throw new Error("Render IdentityProvider before using identity actions.");
  return identity;
}

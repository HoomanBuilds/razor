"use client";

import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignMessage, useWallets } from "@privy-io/react-auth/solana";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/api";
import { formatUnits } from "@/lib/money";
import { clearEmbeddedNearBridge, registerEmbeddedNearBridge, type NearSigningReview } from "@/lib/embedded-near-signer";
import type { EmbeddedNearBinding, EmbeddedNearSetup } from "@/lib/embedded-near-types";
import { authenticateWallet } from "./wallets";

interface EmbeddedNearContextValue {
  configured:boolean;ready:boolean;authenticated:boolean;subject:string|null;status:EmbeddedNearSetup|null;error:string;
  wallets:Array<{address:string;recoveryMethod:string}>;
  refresh:()=>Promise<void>;setup:(address?:string)=>Promise<void>;verify:()=>Promise<void>;disconnect:()=>Promise<void>;disable:()=>Promise<void>;
}
const unavailable=async()=>{throw new Error("Embedded signing is not configured. Connect a supported external NEAR wallet.");};
const EmbeddedNearContext=createContext<EmbeddedNearContextValue>({configured:false,ready:false,authenticated:false,subject:null,status:null,error:"",wallets:[],refresh:unavailable,setup:unavailable,verify:unavailable,disconnect:unavailable,disable:unavailable});
export const useEmbeddedNear=()=>useContext(EmbeddedNearContext);
interface Props {appId:string|null;userId:string|null;network:"mainnet"|"testnet";onIdentityChanged:()=>Promise<void>;children:ReactNode}
interface PendingReview {value:NearSigningReview;resolve:()=>void;reject:(error:Error)=>void}

function SigningReview({review,onClose}:{review:PendingReview|null;onClose:(accepted:boolean)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),[acknowledged,setAcknowledged]=useState(false);
  useEffect(()=>{setAcknowledged(false);if(review)dialog.current?.showModal();else dialog.current?.close();},[review]);
  return <dialog ref={dialog} onCancel={event=>{event.preventDefault();onClose(false);}} aria-labelledby="near-signing-title" className="fixed inset-0 z-[100] m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl border bg-card p-5 text-card-foreground shadow-xl backdrop:bg-black/50">
    {review?<div className="space-y-4"><h2 id="near-signing-title" className="text-lg font-semibold">{review.value.kind==="message"?"Verify native NEAR ownership":"Review native NEAR transaction"}</h2><p className="text-sm">NEAR {review.value.network}</p><p className="break-all font-mono text-xs">Signer: {review.value.accountId}</p>
      {review.value.kind==="message"?<><p className="break-all text-sm">Recipient: {review.value.recipient}</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{review.value.message}</pre><p className="text-xs text-muted-foreground">This NEP-413 ownership message does not transfer funds or add an onchain key.</p></>:<><p className="break-all text-sm">Contract or receiver: {review.value.receiverId}</p><ul className="space-y-3">{review.value.actions.map((action,index)=><li key={index} className="min-w-0 rounded-lg border p-3"><p className="text-sm font-medium">{index+1}. {action.type}{action.type==="FunctionCall"?` ${action.params.methodName}`:""}</p><pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(action,null,2)}</pre></li>)}</ul><p className="text-sm">Attached native deposit: {formatUnits(review.value.attachedDeposit,24)} NEAR</p><p className="text-xs text-muted-foreground">Function-call gas budget at the observed gas price: {formatUnits((BigInt(review.value.prepaidGas)*BigInt(review.value.gasPrice)).toString(),24)} NEAR. Transaction, key and action costs are additional. The final charge depends on execution and network pricing. Unused prepaid gas can be refunded. This is paid by the signer; Razor is not sponsoring this transaction.</p><p className="text-xs text-muted-foreground">The provider's next prompt signs an opaque NEAR transaction hash. This review shows the actions bound to that exact hash. Transactions are public on NEAR. No Solana transaction is created.</p></>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} className="mt-1"/>I reviewed the native NEAR account, network and {review.value.kind==="message"?"ownership message":"exact actions, amounts and costs"}.</label><div className="flex flex-wrap gap-3"><button type="button" onClick={()=>onClose(false)} className="rounded-lg border px-4 py-2 text-sm">Cancel</button><button type="button" disabled={!acknowledged} onClick={()=>onClose(true)} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">Continue to provider confirmation</button></div>
    </div>:null}
  </dialog>;
}

function SignerBridge({userId,network,onIdentityChanged,children}:Omit<Props,"appId">) {
  const {ready,authenticated,user,getAccessToken,logout}=usePrivy(),{wallets:connected,ready:walletsReady}=useWallets(),{createWallet}=useCreateWallet(),{signMessage}=useSignMessage();
  const [snapshot,setSnapshot]=useState<{userId:string;network:string;data:EmbeddedNearSetup}|null>(null),[error,setError]=useState(""),[review,setReview]=useState<PendingReview|null>(null);
  const reviewRef=useRef<PendingReview|null>(null),current=useRef({userId,network,authenticated,subject:user?.id,connected,ready,walletsReady}),epoch=useRef(0);
  const callbacks=useRef({getAccessToken,signMessage});
  callbacks.current={getAccessToken,signMessage};
  current.current={userId,network,authenticated,subject:user?.id,connected,ready,walletsReady};
  const status=snapshot?.userId===userId&&snapshot.network===network?snapshot.data:null;
  const connectedAddresses=connected.filter(wallet=>(wallet.standardWallet as {isPrivyWallet?:boolean}).isPrivyWallet===true).map(wallet=>wallet.address).sort().join(",");
  const providerWallets=user?.linkedAccounts.flatMap(value=>value.type==="wallet"&&value.chainType==="solana"&&["privy","privy-v2"].includes(value.walletClientType||"")&&!value.imported&&!value.delegated&&value.userCanSign!==false?[{address:value.address,recoveryMethod:value.recoveryMethod||"provider configured"}]:[])||[];
  const closeReview=useCallback((accepted:boolean)=>{
    const pending=reviewRef.current;reviewRef.current=null;setReview(null);
    if(accepted)pending?.resolve();else pending?.reject(new Error("The NEAR review was cancelled before provider signing. Your company records remain saved; check the original action's status before resuming."));
  },[]);
  const refresh=useCallback(async()=>{
    if(!userId){setSnapshot(null);return;}
    const version=epoch.current,owner=userId,expectedNetwork=network;
    const data=await api<EmbeddedNearSetup>("/account/embedded-near");
    if(version!==epoch.current||current.current.userId!==owner||current.current.network!==expectedNetwork)return;
    if(data.network!==expectedNetwork)throw new Error("The configured NEAR network changed. Reload Account and recovery before continuing.");
    setSnapshot({userId:owner,network:expectedNetwork,data});setError("");
  },[userId,network]);
  useEffect(()=>{
    epoch.current++;clearEmbeddedNearBridge();closeReview(false);setSnapshot(null);setError("");
    void refresh().catch(cause=>setError(errorMessage(cause)));
    return()=>{epoch.current++;clearEmbeddedNearBridge();reviewRef.current?.reject(new Error("The signing account or provider changed. Reopen the saved action after verifying the original signer."));reviewRef.current=null;};
  },[userId,network,user?.id,authenticated,refresh,closeReview]);
  useEffect(()=>{
    if(!userId||!ready||!walletsReady||!authenticated||!user||!status?.binding||status.binding.disabled||user.id!==status.binding.providerSubject)return;
    const binding=status.binding,owner=userId,subject=user.id;
    const same=()=>{
      const now=current.current;
      return now.userId===owner&&now.network===binding.network&&now.authenticated&&now.subject===subject&&now.ready&&now.walletsReady&&now.connected.some(wallet=>wallet.address===binding.walletAddress&&(wallet.standardWallet as {isPrivyWallet?:boolean}).isPrivyWallet===true);
    };
    if(!same())return;
    return registerEmbeddedNearBridge({
      userId:owner,binding,isCurrent:same,
      async authorize() {
        const accessToken=await callbacks.current.getAccessToken();
        if(!same()||!accessToken)throw new Error("Restore the original linked provider session before signing.");
        return api<{binding:EmbeddedNearBinding;linked:boolean}>("/account/embedded-near/authorize",{accessToken});
      },
      async signBytes(bytes) {
        if(!same())throw new Error("The linked signer changed before the signature request.");
        const wallet=current.current.connected.find(value=>value.address===binding.walletAddress&&(value.standardWallet as {isPrivyWallet?:boolean}).isPrivyWallet===true);
        if(!wallet)throw new Error("Restore the original embedded wallet through its provider before signing.");
        const result=await callbacks.current.signMessage({message:new Uint8Array(bytes),wallet,options:{uiOptions:{showWalletUIs:true,isCancellable:true,title:"Confirm native NEAR signature",description:`NEAR ${binding.network}. Sign only after reviewing Razor's native NEAR account and exact actions.`,buttonText:"Sign NEAR payload"}}});
        if(!same())throw new Error("The provider changed during signing. Nothing has been broadcast by this request.");
        return new Uint8Array(result.signature);
      },
      review(value) {
        if(reviewRef.current)return Promise.reject(new Error("Complete the open NEAR review first."));
        if(!same())return Promise.reject(new Error("The signer connection changed. Restore the linked provider."));
        return new Promise<void>((resolve,reject)=>{const pending={value,resolve,reject};reviewRef.current=pending;setReview(pending);});
      },
    });
  },[userId,ready,walletsReady,authenticated,user?.id,connectedAddresses,status?.binding?.accountId,status?.binding?.publicKey,status?.binding?.walletAddress,status?.binding?.providerSubject,status?.binding?.network,status?.binding?.linkedWalletId,status?.binding?.disabled,status?.binding?.generation]);
  async function token() {
    if(!userId||!ready||!authenticated||!user)throw new Error("Sign in to the Google or email identity already linked to this Razor account first.");
    const accessToken=await getAccessToken();
    if(!accessToken)throw new Error("Your provider session expired. Sign in again and resume this same owner-wallet setup.");
    return accessToken;
  }
  async function setup(address?:string) {
    const owner=userId,subject=user?.id,accessToken=await token();
    await api("/account/embedded-near/identity",{accessToken});
    let selected=status?.binding?.walletAddress||address;
    if(!selected&&providerWallets.length===1)selected=providerWallets[0].address;
    if(!selected&&providerWallets.length>1)throw new Error("Select the existing provider wallet to use. Razor will not create a duplicate owner account.");
    if(!selected)selected=(await createWallet()).wallet.address;
    if(current.current.userId!==owner||current.current.subject!==subject)throw new Error("Your sign-in changed. Return to your original account before linking a signer.");
    await api("/account/embedded-near/bind",{accessToken,walletAddress:selected});
    await refresh();
  }
  async function verify() {
    if(!status?.binding||status.binding.disabled)throw new Error("Set up or enable the original provider signer first.");
    await authenticateWallet("near",{link:true,walletId:"privy-near",accountId:status.binding.accountId});
    await api("/account/embedded-near/linked",{accessToken:await token()});
    await refresh();await onIdentityChanged();
  }
  async function disable() {await api("/account/embedded-near/disable",{});clearEmbeddedNearBridge();await refresh();}
  async function disconnect() {clearEmbeddedNearBridge();closeReview(false);await logout();}
  return <EmbeddedNearContext.Provider value={{configured:true,ready:ready&&walletsReady,authenticated,subject:user?.id||null,status,error,wallets:providerWallets,refresh,setup,verify,disconnect,disable}}>{children}<SigningReview review={review} onClose={closeReview}/></EmbeddedNearContext.Provider>;
}

export function EmbeddedNearProvider({appId,children,...props}:Props) {
  if(!appId)return <>{children}</>;
  return <PrivyProvider appId={appId} config={{loginMethods:["google","email","passkey"],appearance:{theme:"light",accentColor:"#2463eb",walletList:[]},embeddedWallets:{showWalletUIs:true,ethereum:{createOnLogin:"off"},solana:{createOnLogin:"off"}}}}><SignerBridge {...props}>{children}</SignerBridge></PrivyProvider>;
}

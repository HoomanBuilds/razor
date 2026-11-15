"use client";

import { requireLiveWallet } from "@/lib/demo-scope";

import type { NearConnector } from "@hot-labs/near-connect";
import type { WalletProvider } from "@/components/account/types";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { walletFailureMessage } from "@/lib/client-errors";
import { api } from "@/lib/api";
import { embeddedNearConnection, type NearWalletConnection } from "@/lib/embedded-near-signer";

export type WalletFamily = "near" | "evm" | "solana";
export interface AuthConfig { socialEnabled:boolean; privyAppId:string|null; nearNetwork:"mainnet"|"testnet"; origin:string; walletFamilies:WalletFamily[];ownerWalletSetup?:{providers:WalletProvider[];preferredProvider:string|null;nativeEmbeddedNear:boolean} }
interface Challenge {challengeId:string;message:string;nonce:string;recipient:string;network:string}
interface SolanaProvider { connect:()=>Promise<{publicKey:{toString:()=>string}}>; signMessage:(message:Uint8Array,encoding?:string)=>Promise<{signature:Uint8Array;publicKey:{toString:()=>string}}> }

let connectorPromise:Promise<NearConnector>|undefined;

export async function identityRequest<T=unknown>(path:string,body?:unknown,method=body===undefined?"GET":"POST"):Promise<T> {
  return api<T>(path,body,method);
}

export async function getNearConnector():Promise<NearConnector> {
  requireLiveWallet();
  if(typeof window==="undefined") throw new Error("Open Razor in your browser to connect a wallet.");
  if(!connectorPromise) {
    connectorPromise=Promise.all([import("@hot-labs/near-connect"),identityRequest<AuthConfig>("/auth/config")]).then(([{NearConnector},config])=>new NearConnector({network:config.nearNetwork,features:{signMessage:true},autoConnect:true}));
    connectorPromise.catch(()=>{connectorPromise=undefined;});
  }
  return connectorPromise;
}

export async function connectNearWallet(options:{walletId?:string;chooseWallet?:boolean;accountId?:string}={}):Promise<NearWalletConnection> {
  requireLiveWallet();
  const embedded=await embeddedNearConnection(options);
  if(embedded)return embedded;
  const connector=await getNearConnector();
  if(options.walletId){
    await connector.whenManifestLoaded;
    const available=connector.availableWallets.find(wallet=>wallet.manifest.id===options.walletId);
    if(!available)throw new Error("This wallet is not available in the current NEAR Connect registry. Choose another supported wallet.");
    const wallet=await connector.connect({walletId:options.walletId}),accounts=await wallet.getAccounts();
    if(!accounts.length)throw new Error("Create or restore an account in this wallet, then return to connect it.");
    return {wallet,accounts};
  }
  if(!options.chooseWallet)try {
    const connected=await connector.getConnectedWallet();
    if(connected.accounts.length) return connected;
  } catch {}
  const walletId=options.chooseWallet?await connector.selectWallet():undefined;
  const wallet=await connector.connect(walletId?{walletId}:{});
  const accounts=await wallet.getAccounts();
  if(!accounts.length) throw new Error("Select a NEAR account in your wallet and try again.");
  return {wallet,accounts};
}

export async function authenticateWallet(family:WalletFamily,options:{link?:boolean;reauth?:boolean;walletId?:string;chooseWallet?:boolean;accountId?:string}={}) {
  requireLiveWallet();
  if(options.link&&options.reauth)throw new Error("Choose wallet linking or fresh verification.");
  const purpose=options.reauth?"reauth":options.link?"link":"login";
  if(family==="near") {
    const {wallet,accounts}=await connectNearWallet(options),address=options.accountId?accounts.find(account=>account.accountId===options.accountId)?.accountId:accounts[0].accountId;
    if(!address)throw new Error("The selected wallet does not expose this NEAR account. Restore it with its provider or choose the correct wallet.");
    const challenge=await identityRequest<Challenge>("/auth/challenge",{family,address,purpose});
    const nonce=Uint8Array.from(challenge.nonce.match(/.{2}/g)!,value=>Number.parseInt(value,16));
    const proof=await wallet.signMessage({message:challenge.message,nonce,recipient:challenge.recipient,signerId:address,network:challenge.network as "mainnet"|"testnet"});
    if(proof.accountId!==address) throw new Error("Your wallet changed accounts. Please try again.");
    return identityRequest("/auth/wallet",{challengeId:challenge.challengeId,signature:proof.signature,publicKey:proof.publicKey});
  }
  if(family==="evm") {
    const provider=(window as unknown as {ethereum?:EIP1193Provider}).ethereum;
    if(!provider) throw new Error("Open an EVM wallet browser or install an EVM wallet, then try again.");
    const client=createWalletClient({transport:custom(provider)}),[account]=await client.requestAddresses();
    if(!account) throw new Error("Select an account in your EVM wallet and try again.");
    if(options.accountId&&account.toLowerCase()!==options.accountId.toLowerCase())throw new Error("Select the linked EVM account you want to verify, then try again.");
    const challenge=await identityRequest<Challenge>("/auth/challenge",{family,address:account,network:"evm",purpose});
    const signature=await client.signMessage({account,message:challenge.message});
    return identityRequest("/auth/wallet",{challengeId:challenge.challengeId,signature});
  }
  const provider=(window as unknown as {solana?:SolanaProvider}).solana;
  if(!provider) throw new Error("Open a Solana wallet browser or install a Solana wallet, then try again.");
  const connection=await provider.connect(),address=connection.publicKey.toString();
  if(options.accountId&&address!==options.accountId)throw new Error("Select the linked Solana account you want to verify, then try again.");
  const challenge=await identityRequest<Challenge>("/auth/challenge",{family,address,network:"solana",purpose});
  const proof=await provider.signMessage(new TextEncoder().encode(challenge.message),"utf8");
  if(proof.publicKey.toString()!==address) throw new Error("Your wallet changed accounts. Please try again.");
  const signature=btoa(String.fromCharCode(...proof.signature));
  return identityRequest("/auth/wallet",{challengeId:challenge.challengeId,signature});
}

export function walletErrorMessage(error:unknown):string {
  return walletFailureMessage(error, "The wallet request could not be completed. Check its saved status before trying again.");
}

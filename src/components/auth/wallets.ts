"use client";

import type { NearConnector } from "@hot-labs/near-connect";
import { createWalletClient, custom, type EIP1193Provider } from "viem";

export type WalletFamily = "near" | "evm" | "solana";
export interface AuthConfig { socialEnabled:boolean; privyAppId:string|null; nearNetwork:"mainnet"|"testnet"; origin:string; walletFamilies:WalletFamily[] }
interface Challenge {challengeId:string;message:string;nonce:string;recipient:string;network:string}
interface SolanaProvider { connect:()=>Promise<{publicKey:{toString:()=>string}}>; signMessage:(message:Uint8Array,encoding?:string)=>Promise<{signature:Uint8Array;publicKey:{toString:()=>string}}> }

let connectorPromise:Promise<NearConnector>|undefined;

export async function identityRequest<T=unknown>(path:string,body?:unknown,method=body===undefined?"GET":"POST"):Promise<T> {
  const response=await fetch(`/api${path}`,{method,credentials:"same-origin",headers:body===undefined?undefined:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error?.message || result.message || (typeof result.error==="string"?result.error:"The request could not be completed. Please try again."));
  return result as T;
}

export async function getNearConnector():Promise<NearConnector> {
  if(typeof window==="undefined") throw new Error("Open FLOAT in your browser to connect a wallet.");
  if(!connectorPromise) {
    connectorPromise=Promise.all([import("@hot-labs/near-connect"),identityRequest<AuthConfig>("/auth/config")]).then(([{NearConnector},config])=>new NearConnector({network:config.nearNetwork,features:{signMessage:true},autoConnect:true}));
    connectorPromise.catch(()=>{connectorPromise=undefined;});
  }
  return connectorPromise;
}

export async function connectNearWallet() {
  const connector=await getNearConnector();
  try {
    const connected=await connector.getConnectedWallet();
    if(connected.accounts.length) return connected;
  } catch {}
  const wallet=await connector.connect();
  const accounts=await wallet.getAccounts();
  if(!accounts.length) throw new Error("Select a NEAR account in your wallet and try again.");
  return {wallet,accounts};
}

export async function authenticateWallet(family:WalletFamily,options:{link?:boolean}={}) {
  const purpose=options.link?"link":"login";
  if(family==="near") {
    const {wallet,accounts}=await connectNearWallet(),address=accounts[0].accountId;
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
    const challenge=await identityRequest<Challenge>("/auth/challenge",{family,address:account,network:"evm",purpose});
    const signature=await client.signMessage({account,message:challenge.message});
    return identityRequest("/auth/wallet",{challengeId:challenge.challengeId,signature});
  }
  const provider=(window as unknown as {solana?:SolanaProvider}).solana;
  if(!provider) throw new Error("Open a Solana wallet browser or install a Solana wallet, then try again.");
  const connection=await provider.connect(),address=connection.publicKey.toString();
  const challenge=await identityRequest<Challenge>("/auth/challenge",{family,address,network:"solana",purpose});
  const proof=await provider.signMessage(new TextEncoder().encode(challenge.message),"utf8");
  if(proof.publicKey.toString()!==address) throw new Error("Your wallet changed accounts. Please try again.");
  const signature=btoa(String.fromCharCode(...proof.signature));
  return identityRequest("/auth/wallet",{challengeId:challenge.challengeId,signature});
}

export function walletErrorMessage(error:unknown):string {
  const candidate=error as {code?:number;name?:string;message?:string;shortMessage?:string};
  if(candidate.code===4001 || /reject|denied|cancel/i.test(candidate.message || "")) return "Request cancelled. Your account has not changed.";
  if(candidate.name==="TypeError" && /fetch/i.test(candidate.message || "")) return "FLOAT could not reach the server. Check your connection and try again.";
  return candidate.shortMessage || candidate.message || "The wallet request could not be completed. Please try again.";
}

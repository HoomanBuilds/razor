import { createHash, timingSafeEqual } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { ApiError } from "../context";
import { reviewedArtifactHash } from "../near-artifacts";
import { validNearAccount } from "../payments/near";
import { NATIVE_USDC } from "../../lib/native-usdc";
import type { BillingCheckoutSettings } from "./payment-types";

export interface BillingOffer {version:1;invoice_id:string;company_id:string;plan_version_id:string;payer_id:string;contract_id:string;network:"mainnet"|"testnet";token_contract:string;amount:string;terms_hash:string;issued_at_ms:string;expires_at_ms:string}
export interface BillingChainConfig {owner_id:string;token_contract:string;network:"mainnet"|"testnet";issuer_public_key:string;paused:boolean;available:string;withdrawal_pending:boolean;version:number}
export interface BillingChainInvoice {invoice_id:string;company_id:string;plan_version_id:string;payer_id:string;amount:string;terms_hash:string;quote_hash:string;paid_at_ms:string;paid_at_height:string;refunded_amount:string;pending_refund:string|null}
export interface BillingChainRefund {id:string;invoice_id:string;amount:string;status:"pending"|"completed"|"failed";nonce:string}
export interface BillingTarget {network:"mainnet"|"testnet";billingContract:string;tokenContract:string;codeHash:string}
interface RpcValue<T> {value:T;blockHash:string;blockHeight:number}
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export const billingQuoteHash=hash;

export function billingIssuer(env:NodeJS.ProcessEnv=process.env) {
  try {
    const input=env.RAZOR_BILLING_ISSUER_PRIVATE_KEY;
    if(!input?.startsWith("ed25519:"))throw new Error();
    const decoded=base58.decode(input.slice(8));if(decoded.length!==64)throw new Error();
    const seed=decoded.slice(0,32),key=ed25519.getPublicKey(seed);
    if(!timingSafeEqual(Buffer.from(key),Buffer.from(decoded.slice(32))))throw new Error();
    return {seed,publicKey:`ed25519:${base58.encode(key)}`};
  }catch{throw new ApiError(503,"Configure a dedicated valid RAZOR_BILLING_ISSUER_PRIVATE_KEY for signed subscription offers","BILLING_ISSUER_SETUP_REQUIRED");}
}
export function billingSettings(env:NodeJS.ProcessEnv=process.env,artifactDirectory?:string):BillingTarget {
  const network=env.NEAR_NETWORK||"testnet",billingContract=env.RAZOR_BILLING_CONTRACT_ID;
  if(network!=="mainnet"&&network!=="testnet")throw new ApiError(503,"Select mainnet or testnet for NEAR billing","BILLING_SETUP_REQUIRED");
  const tokenContract=network==="mainnet"?NATIVE_USDC.near:env.RAZOR_BILLING_TESTNET_TOKEN_CONTRACT;
  if(!billingContract||!validNearAccount(billingContract)||!tokenContract||!validNearAccount(tokenContract)||billingContract===tokenContract)throw new ApiError(503,"Configure a dedicated billing contract and the matching native USDC or testnet token","BILLING_SETUP_REQUIRED");
  return {network,billingContract,tokenContract,codeHash:reviewedArtifactHash("RAZOR_BILLING_CODE_HASH","razor_billing.wasm",env,artifactDirectory)};
}
async function rpc<T>(network:string,method:string,params:unknown):Promise<T> {
  const url=network===(process.env.NEAR_NETWORK||"testnet")?process.env.NEAR_RPC_URL||`https://rpc.${network}.near.org`:`https://rpc.${network}.near.org`;
  const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"razor-billing",method,params}),signal:AbortSignal.timeout(15000),cache:"no-store"});
  if(!response.ok)throw new ApiError(503,"NEAR billing verification is unavailable. Keep the existing invoice and check again.","BILLING_RPC_UNAVAILABLE");
  const payload=await response.json() as {result?:T;error?:unknown};
  if(payload.error||payload.result===undefined)throw new ApiError(503,"NEAR could not verify the billing contract or receipt. Check the original invoice before paying again.","BILLING_CHAIN_UNAVAILABLE");
  return payload.result;
}
async function view<T>(target:BillingTarget,method:string,args:object={},blockHash?:string):Promise<RpcValue<T>> {
  const result=await rpc<{result:number[];block_hash:string;block_height:number}>(target.network,"query",{request_type:"call_function",...(blockHash?{block_id:blockHash}:{finality:"final"}),account_id:target.billingContract,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString("base64")});
  try{return {value:JSON.parse(Buffer.from(result.result).toString()) as T,blockHash:result.block_hash,blockHeight:result.block_height};}catch{throw new ApiError(502,"The billing contract returned invalid data","BILLING_RESPONSE_INVALID");}
}
export async function verifyBillingContract(target:BillingTarget,checkout=false) {
  const status=await rpc<{chain_id:string}>(target.network,"status",[]);
  if(status.chain_id!==target.network)throw new ApiError(503,"The billing RPC belongs to another network","BILLING_NETWORK_MISMATCH");
  const account=await rpc<{code_hash:string;block_hash:string;block_height:number}>(target.network,"query",{request_type:"view_account",finality:"final",account_id:target.billingContract});
  if(account.code_hash!==target.codeHash)throw new ApiError(503,"The billing contract code differs from the reviewed artifact","BILLING_CODE_MISMATCH");
  if(!account.block_hash||!Number.isSafeInteger(account.block_height))throw new ApiError(502,"The billing code response has no final block identity","BILLING_RESPONSE_INVALID");
  const config=(await view<BillingChainConfig>(target,"get_config",{},account.block_hash)).value;
  if(config.version!==1||config.network!==target.network||config.token_contract!==target.tokenContract||!validNearAccount(config.owner_id)||config.owner_id===target.billingContract||typeof config.paused!=="boolean"||!/^\d+$/.test(config.available)||target.network==="mainnet"&&config.token_contract!==NATIVE_USDC.near)throw new ApiError(503,"The initialized billing configuration does not match the expected network, token or owner","BILLING_CONFIG_MISMATCH");
  if(checkout) {
    if(config.paused)throw new ApiError(503,"Subscription collection is paused; existing paid access and recovery remain available","BILLING_COLLECTION_PAUSED");
    if(config.issuer_public_key!==billingIssuer().publicKey)throw new ApiError(503,"The billing offer issuer does not match the contract's approved issuer","BILLING_ISSUER_MISMATCH");
    const token=await rpc<{result:number[]}>(target.network,"query",{request_type:"call_function",block_id:account.block_hash,account_id:target.tokenContract,method_name:"storage_balance_of",args_base64:Buffer.from(JSON.stringify({account_id:target.billingContract})).toString("base64")});
    let storage;try{storage=JSON.parse(Buffer.from(token.result).toString());}catch{}
    if(!storage||!/^\d+$/.test(storage.total)||BigInt(storage.total)===0n)throw new ApiError(503,"Register the billing contract's native USDC token storage before enabling collection","BILLING_TOKEN_STORAGE_REQUIRED");
  }
  return {config,blockHash:account.block_hash,blockHeight:account.block_height};
}
export async function billingCheckoutConfiguration():Promise<BillingCheckoutSettings> {
  const configuredNetwork=process.env.NEAR_NETWORK==="mainnet"?"mainnet":"testnet";
  try {
    const target=billingSettings();billingIssuer();await verifyBillingContract(target,true);
    return {ready:true,network:target.network,billingContract:target.billingContract,tokenContract:target.tokenContract,issuerPublicKey:billingIssuer().publicKey,reason:null,testnet:target.network==="testnet"};
  }catch(error){if(!(error instanceof ApiError))throw error;return {ready:false,network:configuredNetwork,billingContract:process.env.RAZOR_BILLING_CONTRACT_ID||null,tokenContract:configuredNetwork==="mainnet"?NATIVE_USDC.near:process.env.RAZOR_BILLING_TESTNET_TOKEN_CONTRACT||null,issuerPublicKey:null,reason:error.message,code:error.code,testnet:configuredNetwork==="testnet"};}
}
export function offerSignatureMatches(quoteJson:string,signature:string,publicKey:string|null) {
  try {return !!publicKey?.startsWith("ed25519:")&&ed25519.verify(base58.decode(signature),new TextEncoder().encode(quoteJson),base58.decode(publicKey.slice(8)));}catch{return false;}
}
export function signBillingOffer(offer:BillingOffer) {
  const quoteJson=JSON.stringify(offer),issuer=billingIssuer();
  return {quoteJson,signature:base58.encode(ed25519.sign(new TextEncoder().encode(quoteJson),issuer.seed))};
}
export async function readBillingInvoice(target:BillingTarget,invoiceId:string) {
  const verified=await verifyBillingContract(target);
  const invoice=await view<BillingChainInvoice|null>(target,"get_invoice",{invoice_id:invoiceId},verified.blockHash);
  return {...verified,invoice:invoice.value};
}
export async function readBillingRefund(target:BillingTarget,refundId:string) {
  const verified=await verifyBillingContract(target);
  const refund=await view<BillingChainRefund|null>(target,"get_refund",{refund_id:refundId},verified.blockHash);
  return {...verified,refund:refund.value};
}
export async function verifiedBillingTransaction(target:BillingTarget,hashValue:string,payer:string,quoteJson:string,signature:string) {
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hashValue))throw new ApiError(422,"Enter the original NEAR transaction hash","BILLING_HASH_INVALID");
  const response=await rpc<{final_execution_status?:string;status?:{SuccessValue?:string;Failure?:unknown};transaction?:{hash:string;signer_id:string;receiver_id:string;actions:Array<{FunctionCall?:{method_name:string;args:string}}>}}>(target.network,"EXPERIMENTAL_tx_status",{tx_hash:hashValue,sender_account_id:payer,wait_until:"FINAL"});
  if(response.final_execution_status!=="FINAL"||response.transaction?.hash!==hashValue||response.transaction.signer_id!==payer||response.transaction.receiver_id!==target.tokenContract||response.transaction.actions.length!==1||!response.status||!("SuccessValue" in response.status))return false;
  const action=response.transaction.actions[0].FunctionCall;
  if(!action||action.method_name!=="ft_transfer_call")return false;
  try{const args=JSON.parse(Buffer.from(action.args,"base64").toString()),offer=JSON.parse(quoteJson);return JSON.parse(Buffer.from(response.status!.SuccessValue!,"base64").toString())===offer.amount&&args.receiver_id===target.billingContract&&args.amount===offer.amount&&args.msg===JSON.stringify({quote_json:quoteJson,signature});}catch{return false;}
}

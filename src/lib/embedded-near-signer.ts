"use client";

import { Account, actions, JsonRpcProvider, PublicKey, Signer, type Action } from "near-api-js";
import type { Account as WalletAccount, ConnectorAction, NearWalletBase, SignAndSendTransactionParams } from "@hot-labs/near-connect";
import { base58 } from "@scure/base";
import { api } from "./api";
import type { EmbeddedNearBinding, EmbeddedNearSetup } from "./embedded-near-types";

export type NearWalletClient = Pick<NearWalletBase,"signMessage"|"signAndSendTransaction"|"signAndSendTransactions"> & {manifest:Pick<NearWalletBase["manifest"],"id"|"name"|"features">};
export interface NearWalletConnection {wallet:NearWalletClient;accounts:WalletAccount[]}
export type NearSigningReview = {kind:"message";message:string;recipient:string;network:string;accountId:string} | {kind:"transaction";network:string;accountId:string;receiverId:string;actions:ConnectorAction[];gasPrice:string;attachedDeposit:string;prepaidGas:string};
export interface EmbeddedNearBridge {
  userId:string;
  binding:EmbeddedNearBinding;
  isCurrent:()=>boolean;
  authorize:()=>Promise<{binding:EmbeddedNearBinding;linked:boolean}>;
  signBytes:(bytes:Uint8Array)=>Promise<Uint8Array>;
  review:(value:NearSigningReview)=>Promise<void>;
}

let bridge:EmbeddedNearBridge|null=null;
let busy=false;
export function registerEmbeddedNearBridge(value:EmbeddedNearBridge) {bridge=value;return()=>{if(bridge===value)bridge=null;};}
export function clearEmbeddedNearBridge() {bridge=null;}

function assertCurrent(value:EmbeddedNearBridge) {
  if(bridge!==value||!value.isCurrent())throw new Error("Your provider, Razor account or network changed. Return to Account and recovery and reconnect the original NEAR signer.");
}
async function authorize(value:EmbeddedNearBridge,requireLinked:boolean) {
  assertCurrent(value);
  const result=await value.authorize();
  assertCurrent(value);
  const expected=value.binding,actual=result.binding;
  if(actual.disabled||actual.generation!==expected.generation||actual.network!==expected.network||actual.accountId!==expected.accountId||actual.publicKey!==expected.publicKey||actual.providerSubject!==expected.providerSubject||actual.walletAddress!==expected.walletAddress||requireLinked&&!result.linked)throw new Error("The verified NEAR signer binding changed. Complete ownership verification in Account and recovery before continuing.");
}
class ProviderNearSigner extends Signer {
  constructor(private readonly value:EmbeddedNearBridge) {super();}
  async getPublicKey() {return PublicKey.from(this.value.binding.publicKey);}
  protected async signBytes(bytes:Uint8Array) {
    assertCurrent(this.value);
    const expected=new Uint8Array(bytes),signature=new Uint8Array(await this.value.signBytes(new Uint8Array(expected)));
    assertCurrent(this.value);
    // Provider message prefixes or encoding changes must never become NEAR signatures.
    if(signature.length!==64||!(await this.getPublicKey()).verify(expected,signature))throw new Error("The provider could not sign the exact NEAR bytes. Use an external NEAR wallet instead; this action was not broadcast.");
    return signature;
  }
}

const unsignedInteger=(value:string,name:string,max:bigint)=>{
  if(!/^\d{1,39}$/.test(value)||BigInt(value)>max)throw new Error(`The ${name} is outside the supported NEAR range.`);
  return BigInt(value);
};
function nativeAction(input:ConnectorAction):Action {
  const u128=(value:string)=>unsignedInteger(value,"deposit",(1n<<128n)-1n);
  switch(input.type) {
    case "FunctionCall":return actions.functionCall(input.params.methodName,input.params.args,unsignedInteger(input.params.gas,"gas",300000000000000n),u128(input.params.deposit));
    case "Transfer":return actions.transfer(u128(input.params.deposit));
    case "DeleteKey":return actions.deleteKey(PublicKey.from(input.params.publicKey));
    case "AddKey": {
      if(input.params.gasKeyInfo)throw new Error("Use an external NEAR wallet for gas-key setup.");
      const permission=input.params.accessKey.permission,key=PublicKey.from(input.params.publicKey);
      return permission==="FullAccess"?actions.addFullAccessKey(key):actions.addFunctionCallAccessKey(key,permission.receiverId,permission.methodNames||[],permission.allowance===undefined?undefined:u128(permission.allowance));
    }
    default:throw new Error("Use a supported external NEAR wallet for this account-management action.");
  }
}

function connectorActions(input:SignAndSendTransactionParams["actions"]):ConnectorAction[] {
  if(!input.length||input.length>16)throw new Error("Review between one and sixteen NEAR actions in a transaction.");
  return input.map(action=>{
    if(!("type" in action)||typeof action.type!=="string"||!["FunctionCall","Transfer","DeleteKey","AddKey"].includes(action.type))throw new Error("This embedded signer requires an explicit supported NEAR action review. Use an external NEAR wallet for this action.");
    const copy=structuredClone(action) as ConnectorAction;
    nativeAction(copy);
    return copy;
  });
}

async function exclusive<T>(value:EmbeddedNearBridge,task:()=>Promise<T>):Promise<T> {
  if(busy)throw new Error("Complete or cancel the current embedded-wallet review before opening another action.");
  busy=true;
  try {assertCurrent(value);return await task();}finally{busy=false;}
}

export async function embeddedNearConnection(options:{walletId?:string;chooseWallet?:boolean;accountId?:string}={}):Promise<NearWalletConnection|null> {
  const value=bridge;
  const requested=options.walletId==="privy-near";
  if(!value||!value.isCurrent()) {
    if(requested)throw new Error("Sign in to the linked provider and restore your original embedded signer in Account and recovery.");
    return null;
  }
  const candidate=requested;
  if(options.walletId&&!requested||options.accountId&&options.accountId!==value.binding.accountId||options.chooseWallet&&!requested&&!options.accountId)return null;
  if(!candidate&&!value.binding.linkedWalletId)return null;
  await authorize(value,!candidate);
  const signer=new ProviderNearSigner(value);
  async function send(params:SignAndSendTransactionParams) {
    if(params.network&&params.network!==value!.binding.network||params.signerId&&params.signerId!==value!.binding.accountId)throw new Error("Use the exact native NEAR account and network shown in this review.");
    await authorize(value!,true);
    const previous=await api<EmbeddedNearSetup>("/account/embedded-near");
    if(previous.transactions.some(transaction=>transaction.status==="unresolved"))throw new Error("A signed NEAR transaction still needs reconciliation. Open Account and recovery and check its saved hash before signing another transaction.");
    const reviewed=connectorActions(params.actions),network=value!.binding.network;
    const rpc=new JsonRpcProvider({url:process.env.NEXT_PUBLIC_NEAR_RPC_URL||`https://rpc.${network}.near.org`},{retries:0});
    if(await rpc.getNetworkId()!==network)throw new Error("The RPC uses another NEAR network. Check the signer connection before approving.");
    const gasPrice=(await rpc.viewGasPrice()).gas_price;
    const deposit=reviewed.reduce((sum,action)=>sum+(action.type==="FunctionCall"||action.type==="Transfer"?BigInt(action.params.deposit):0n),0n);
    const gas=reviewed.reduce((sum,action)=>sum+(action.type==="FunctionCall"?BigInt(action.params.gas):0n),0n);
    if(gas>300000000000000n)throw new Error("This transaction exceeds NEAR's prepaid gas limit. Use separate reviewed actions.");
    await value!.review({kind:"transaction",network,accountId:value!.binding.accountId,receiverId:params.receiverId,actions:reviewed,gasPrice,attachedDeposit:deposit.toString(),prepaidGas:gas.toString()});
    await authorize(value!,true);
    const account=new Account(value!.binding.accountId,rpc,signer);
    const transaction=await account.createTransaction({receiverId:params.receiverId,actions:reviewed.map(nativeAction),publicKey:await signer.getPublicKey()});
    const signed=await signer.signTransaction(transaction),hash=base58.encode(signed.txHash);
    await authorize(value!,true);
    await api("/account/embedded-near/transactions",{hash,receiverId:params.receiverId,generation:value!.binding.generation});
    assertCurrent(value!);
    try {
      const result=await rpc.sendTransactionUntil(signed.signedTransaction,"FINAL");
      if(result.final_execution_status!=="FINAL"||result.transaction.hash!==hash||result.transaction.signer_id!==value!.binding.accountId||result.transaction.public_key!==value!.binding.publicKey||result.transaction.receiver_id!==params.receiverId)throw new Error("The RPC returned an unverified source receipt.");
      await api(`/account/embedded-near/transactions/${hash}/reconcile`,{});
      return result as unknown as Awaited<ReturnType<NearWalletBase["signAndSendTransaction"]>>;
    }catch {
      throw new Error(`NEAR transaction ${hash} was signed and its final result needs reconciliation. Open Account and recovery to check this exact hash. Do not create a replacement payment. A cancelled connection or timeout does not prove failure.`);
    }
  }
  const wallet:NearWalletClient={
    manifest:{id:"privy-near",name:"Embedded NEAR signer",features:{signMessage:true,signTransaction:false,signAndSendTransaction:true,signAndSendTransactions:true,signInWithoutAddKey:true,signInAndSignMessage:false,signInWithFunctionCallKey:false,signDelegateActions:false,mainnet:true,testnet:true}},
    async signMessage(params) {
      return exclusive(value,async()=>{
        if(params.network&&params.network!==value.binding.network||params.signerId&&params.signerId!==value.binding.accountId)throw new Error("This message belongs to another NEAR signer or network.");
        await authorize(value,false);
        await value.review({kind:"message",message:params.message,recipient:params.recipient,network:value.binding.network,accountId:value.binding.accountId});
        await authorize(value,false);
        const proof=await signer.signNep413Message(value.binding.accountId,{message:params.message,recipient:params.recipient,nonce:new Uint8Array(params.nonce)});
        return {accountId:proof.accountId,publicKey:proof.publicKey.toString(),signature:btoa(String.fromCharCode(...proof.signature))};
      });
    },
    signAndSendTransaction(params) {return exclusive(value,()=>send(params));},
    signAndSendTransactions(params) {
      return exclusive(value,async()=>{
        if(!params.transactions.length||params.transactions.length>8)throw new Error("Review between one and eight NEAR transactions.");
        const results:Awaited<ReturnType<NearWalletBase["signAndSendTransaction"]>>[]=[];
        for(const transaction of params.transactions) {
          const result=await send({...transaction,signerId:params.signerId,network:params.network});
          results.push(result);
          if(typeof result.status==="object"&&"Failure" in result.status)break;
        }
        return results;
      });
    },
  };
  return {wallet,accounts:[{accountId:value.binding.accountId,publicKey:value.binding.publicKey}]};
}

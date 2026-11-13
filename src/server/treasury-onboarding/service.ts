import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { row, rows } from "../db";
import { configureTreasury } from "../payments/service";
import { NATIVE_USDC } from "../payments/policy";
import { validNearAccount } from "../payments/near";
import { atomic } from "../../lib/money";
import { reviewedArtifactHash } from "../near-artifacts";
import type { WalletTransaction } from "../payments/types";

const Account=z.string().refine(validNearAccount,"Enter a valid NEAR account");
const Amount=z.string().refine(value=>{try{atomic(value);return true;}catch{return false;}},"Use a positive microUSDC amount within the supported range");
const creationFields=z.object({ownerAccount:Account,slug:z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/,"Use 1 to 24 lowercase letters, digits or hyphens"),perPaymentLimit:Amount,dailyLimit:Amount});
export const creationInput=creationFields.refine(input=>{try{return atomic(input.dailyLimit)>=atomic(input.perPaymentLimit);}catch{return false;}},{message:"Daily limit must cover the per-payment limit",path:["dailyLimit"]});
export const recoveryInput=creationFields.pick({ownerAccount:true,slug:true});
export type CreationInput=z.infer<typeof creationInput>;
type Network="mainnet"|"testnet";
const Atomic=z.string().refine(value=>{try{atomic(value,true);return true;}catch{return false;}});
const Factory=z.object({owner_id:Account,token_contract:Account,paused:z.boolean(),treasury_wasm_hash:z.string(),minimum_deposit:Atomic,treasury_funding:Atomic,factory_storage_fee:Atomic});
const Quote=Factory.omit({paused:true}).extend({account_id:Account});
const Creation=z.object({account_id:Account,owner_id:Account,slug:z.string(),generation:z.string(),token_contract:Account,per_payment_limit:Atomic,daily_limit:Atomic,status:z.enum(["pending","ready","failed","refunding","refunded"]),treasury_funding:Atomic,factory_storage_fee:Atomic,refund_amount:Atomic,created_at_ms:z.string()});
interface Settings {network:Network;factoryId:string;factoryCodeHash:string;treasuryCodeHash:string}


function settings():Settings {
  const network=process.env.NEAR_NETWORK || "testnet",factoryId=process.env.NEAR_FACTORY_ID;
  if(network!=="mainnet"&&network!=="testnet")throw new ApiError(503,"Choose mainnet or testnet for NEAR_NETWORK","FACTORY_SETUP_REQUIRED");
  if(!factoryId||!validNearAccount(factoryId))throw new ApiError(503,"Configure a deployed NEAR_FACTORY_ID for this network to enable wallet-created treasuries","FACTORY_SETUP_REQUIRED");
  return {network,factoryId,factoryCodeHash:reviewedArtifactHash("NEAR_FACTORY_CODE_HASH","razor_factory.wasm"),treasuryCodeHash:reviewedArtifactHash("NEAR_TREASURY_CODE_HASH","razor_treasury.wasm")};
}

async function rpc<T>(config:Settings,method:string,params:unknown):Promise<T> {
  const response=await fetch(process.env.NEAR_RPC_URL || `https://rpc.${config.network}.near.org`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"razor-onboarding",method,params}),cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new ApiError(503,"NEAR is unavailable. Refresh the creation status before trying again.","NEAR_UNAVAILABLE");
  const result=await response.json();
  if(result.error)throw new ApiError(422,"NEAR could not verify the factory or treasury. Check the configured network and account.","FACTORY_VERIFICATION_FAILED");
  return result.result as T;
}

async function view<T>(config:Settings,account:string,method:string,args:object={}):Promise<T> {
  const response=await rpc<{result:number[]}>(config,"query",{request_type:"call_function",finality:"final",account_id:account,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString("base64")});
  try{return JSON.parse(Buffer.from(response.result).toString()) as T;}catch{throw new ApiError(502,"The factory returned an invalid response","FACTORY_RESPONSE_INVALID");}
}

async function verifiedFactory() {
  const config=settings();
  const [status,account,response]=await Promise.all([rpc<{chain_id:string}>(config,"status",[]),rpc<{code_hash:string}>(config,"query",{request_type:"view_account",finality:"final",account_id:config.factoryId}),view(config,config.factoryId,"get_config")]);
  if(status.chain_id!==config.network)throw new ApiError(503,"The configured NEAR RPC uses a different network","FACTORY_NETWORK_MISMATCH");
  if(account.code_hash!==config.factoryCodeHash)throw new ApiError(503,"The deployed factory code differs from the reviewed factory artifact","FACTORY_CODE_MISMATCH");
  const factory=Factory.parse(response);
  if(factory.treasury_wasm_hash!==config.treasuryCodeHash)throw new ApiError(503,"The factory embeds a different treasury contract than the reviewed artifact","TREASURY_CODE_MISMATCH");
  if(config.network==="mainnet"&&factory.token_contract!==NATIVE_USDC.near)throw new ApiError(503,"Mainnet treasury creation requires verified native USDC on NEAR","SETTLEMENT_TOKEN_MISMATCH");
  if(atomic(factory.minimum_deposit)!==atomic(factory.treasury_funding)+atomic(factory.factory_storage_fee))throw new ApiError(502,"The factory creation deposit components do not match","FACTORY_RESPONSE_INVALID");
  return {config,factory};
}

function verifiedOwner(access:AccessContext,owner:string,network:Network) {
  requirePermission(access,"company:manage");
  if(!row("SELECT id FROM linked_wallets WHERE user_id = ? AND family = 'near' AND address = ? AND network = ?",access.userId,owner,network))throw new ApiError(403,"Link and verify the NEAR wallet that will own this company treasury","TREASURY_OWNER_UNVERIFIED");
}

export function deriveTreasuryAccount(owner:string,slug:string,factory:string):string {
  const suffix=createHash("sha256").update(owner).digest("hex").slice(0,16),account=`${slug}-${suffix}.${factory}`;
  if(!validNearAccount(account))throw new ApiError(422,"This factory and slug produce an account longer than NEAR allows. Choose a shorter slug.","TREASURY_ACCOUNT_TOO_LONG");
  return account;
}

async function creationRecord(config:Settings,ownerAccount:string,slug:string) {
  const response=await view(config,config.factoryId,"get_treasury",{owner_id:ownerAccount,slug});
  if(response===null)return null;
  const creation=Creation.parse(response);
  if(creation.owner_id!==ownerAccount||creation.slug!==slug||creation.account_id!==deriveTreasuryAccount(ownerAccount,slug,config.factoryId))throw new ApiError(502,"The factory creation belongs to a different owner or account","CREATION_TERMS_MISMATCH");
  return creation;
}

function action(factory:string,method:string,args:object,deposit:string,gas:string):WalletTransaction {
  return {receiverId:factory,actions:[{type:"FunctionCall",params:{methodName:method,args,deposit,gas}}]};
}

export async function getOnboardingConfig(access:AccessContext) {
  requirePermission(access,"company:manage");
  const network=process.env.NEAR_NETWORK || "testnet",verifiedWallets=rows<{address:string;network:string}>("SELECT address,network FROM linked_wallets WHERE user_id = ? AND family = 'near' AND network = ?",access.userId,network);
  try {
    const {config,factory}=await verifiedFactory();
    return {ready:!factory.paused,network,factoryId:config.factoryId,verifiedWallets,settlementEnabled:network==="mainnet",factory,reason:factory.paused?"New treasury creation is paused by the factory operator. Existing creation recovery is still available.":null};
  } catch(error) {
    if(!(error instanceof ApiError))throw error;
    return {ready:false,network,factoryId:process.env.NEAR_FACTORY_ID || null,verifiedWallets,settlementEnabled:false,reason:error.message,code:error.code};
  }
}

export async function quoteTreasury(access:AccessContext,input:CreationInput) {
  requirePermission(access,"company:manage");
  const parsed=creationInput.parse(input),{config,factory}=await verifiedFactory();
  verifiedOwner(access,parsed.ownerAccount,config.network);
  if(factory.paused)throw new ApiError(409,"New treasury creation is paused. Recovery and status checks remain available.","FACTORY_PAUSED");
  const accountId=deriveTreasuryAccount(parsed.ownerAccount,parsed.slug,config.factoryId);
  const connected=row<{near_account_id:string;network:string}>("SELECT near_account_id,network FROM treasury_config WHERE organization_id = ?",access.organizationId);
  if(connected&&(connected.near_account_id!==accountId||connected.network!==config.network))throw new ApiError(409,"This company already has a connected treasury. Use it before creating another account.","TREASURY_ALREADY_CONNECTED");
  const [response,creation]=await Promise.all([view(config,config.factoryId,"quote_creation",{owner_id:parsed.ownerAccount,slug:parsed.slug}),creationRecord(config,parsed.ownerAccount,parsed.slug)]);
  const quoted=Quote.parse(response);
  if(quoted.account_id!==accountId||quoted.owner_id!==parsed.ownerAccount||quoted.token_contract!==factory.token_contract||quoted.treasury_wasm_hash!==config.treasuryCodeHash||quoted.minimum_deposit!==factory.minimum_deposit||quoted.treasury_funding!==factory.treasury_funding||quoted.factory_storage_fee!==factory.factory_storage_fee)throw new ApiError(502,"The creation quote does not match the verified factory","CREATION_TERMS_MISMATCH");
  const quote={accountId,ownerAccount:parsed.ownerAccount,slug:parsed.slug,tokenContract:quoted.token_contract,treasuryCodeHash:quoted.treasury_wasm_hash,factoryCodeHash:config.factoryCodeHash,minimumDeposit:quoted.minimum_deposit,treasuryFunding:quoted.treasury_funding,factoryStorageFee:quoted.factory_storage_fee,perPaymentLimit:parsed.perPaymentLimit,dailyLimit:parsed.dailyLimit,network:config.network,factoryId:config.factoryId};
  return {quote:{...quote,hash:createHash("sha256").update(JSON.stringify(quote)).digest("hex")},creation};
}

export async function prepareTreasury(access:AccessContext,input:CreationInput,quoteHash:string) {
  const result=await quoteTreasury(access,input);
  if(result.quote.hash!==quoteHash)throw new ApiError(409,"Creation terms changed. Review a fresh deposit quote before signing.","CREATION_QUOTE_CHANGED");
  if(result.creation&&result.creation.status!=="refunded")throw new ApiError(409,"This wallet and slug already have a creation request. Check its status before retrying.","CREATION_ALREADY_REQUESTED");
  return {...result,walletActions:[action(result.quote.factoryId,"create_treasury",{slug:input.slug,per_payment_limit:result.quote.perPaymentLimit,daily_limit:result.quote.dailyLimit},result.quote.minimumDeposit,"150000000000000")]};
}

export async function reconcileTreasury(access:AccessContext,input:z.infer<typeof recoveryInput>) {
  requirePermission(access,"company:manage");
  const parsed=recoveryInput.parse(input),{config,factory}=await verifiedFactory();
  verifiedOwner(access,parsed.ownerAccount,config.network);
  const creation=await creationRecord(config,parsed.ownerAccount,parsed.slug);
  if(!creation)return {status:"not_requested",creation:null,configured:false};
  if(creation.token_contract!==factory.token_contract)throw new ApiError(409,"This creation uses a different settlement token","CREATION_TERMS_MISMATCH");
  if(creation.status!=="ready")return {status:creation.status,creation,configured:false,recoveryActions:creation.status==="pending"?[action(config.factoryId,"refresh_creation",{owner_id:parsed.ownerAccount,slug:parsed.slug},"0","40000000000000")]:[]};
  const [account,contract]=await Promise.all([rpc<{code_hash:string}>(config,"query",{request_type:"view_account",finality:"final",account_id:creation.account_id}),view<{owner_id:string;token_contract:string;per_payment_limit:string;daily_limit:string}>(config,creation.account_id,"get_config")]);
  if(account.code_hash!==config.treasuryCodeHash||contract.owner_id!==parsed.ownerAccount||contract.token_contract!==factory.token_contract||contract.per_payment_limit!==creation.per_payment_limit||contract.daily_limit!==creation.daily_limit)throw new ApiError(409,"The deployed child does not match the reviewed code, owner, token and policy limits","TREASURY_VERIFICATION_FAILED");
  const treasury=await configureTreasury(access,{nearAccountId:creation.account_id,network:config.network,tokenContract:factory.token_contract});
  return {status:"ready",creation,configured:true,treasury};
}

export async function prepareCreationRefund(access:AccessContext,input:z.infer<typeof recoveryInput>) {
  requirePermission(access,"company:manage");
  const parsed=recoveryInput.parse(input),{config}=await verifiedFactory();
  verifiedOwner(access,parsed.ownerAccount,config.network);
  const creation=await creationRecord(config,parsed.ownerAccount,parsed.slug);
  if(!creation||creation.status!=="failed"||atomic(creation.refund_amount,true)===0n)throw new ApiError(409,"Only a failed creation with an unclaimed refund can be claimed. Reconcile its current status first.","CREATION_REFUND_UNAVAILABLE");
  return {creation,walletActions:[action(config.factoryId,"claim_refund",{slug:parsed.slug},"1","40000000000000")]};
}

import { Hono } from "hono";
import { base58 } from "@scure/base";
import { JsonRpcProvider, keyToImplicitAddress, PublicKey } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { z } from "zod";
import type { EmbeddedNearBinding, EmbeddedNearNetwork, EmbeddedNearSetup } from "@/lib/embedded-near-types";
import { ApiError, type AppEnv } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { verifyPrivy } from "../identity/privy";
import { audit, requireFreshSession } from "../identity/session";

interface BindingRecord {user_id:string;network:EmbeddedNearNetwork;provider_subject:string;wallet_address:string;public_key:string;account_id:string;linked_wallet_id:string|null;disabled_at:string|null;generation:number}
interface TransactionRecord {transaction_hash:string;receiver_id:string;status:"unresolved"|"succeeded"|"failed";created_at:string;observed_at:string|null}
const network = ():EmbeddedNearNetwork => process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
const tokenInput = z.object({accessToken:z.string().min(20).max(12000)});
const hashInput = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const bindingFor=(userId:string)=>row<BindingRecord>("SELECT * FROM embedded_near_accounts WHERE user_id=? AND network=?",userId,network());
const publicBinding=(value:BindingRecord):EmbeddedNearBinding=>({network:value.network,providerSubject:value.provider_subject,walletAddress:value.wallet_address,publicKey:value.public_key,accountId:value.account_id,linkedWalletId:value.linked_wallet_id,disabled:!!value.disabled_at,generation:value.generation});

export function embeddedNearEnabled() {
  return !!((process.env.PRIVY_APP_ID||process.env.NEXT_PUBLIC_PRIVY_APP_ID)&&(process.env.PRIVY_VERIFICATION_KEY||process.env.PRIVY_JWKS_URL)&&process.env.PRIVY_APP_SECRET);
}

async function provider() {
  const rpc=new JsonRpcProvider({url:process.env.NEAR_RPC_URL||`https://rpc.${network()}.near.org`},{retries:0});
  if(await rpc.getNetworkId()!==network())throw new ApiError(503,"The configured RPC uses another NEAR network","NEAR_NETWORK_MISMATCH");
  return rpc;
}

async function verifiedProvider(userId:string,accessToken:string,walletAddress?:string) {
  let profile;
  try{profile=await verifyPrivy(accessToken,true);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(401,"The linked provider session could not be verified. Sign in again and resume this setup.","EMBEDDED_PROVIDER_UNVERIFIED");}
  if(!row("SELECT user_id FROM user_identities WHERE provider='privy' AND subject=? AND user_id=?",profile.subject,userId))throw new ApiError(403,"Sign in with the provider identity linked to this Razor account","EMBEDDED_IDENTITY_MISMATCH");
  const binding=bindingFor(userId),address=walletAddress||binding?.wallet_address;
  const wallet=profile.linkedAccounts.find(value=>value.type==="wallet"&&value.chain_type==="solana"&&value.address===address&&["privy","privy-v2"].includes(value.wallet_client_type||"")&&value.imported!==true&&value.delegated!==true&&value.user_can_sign!==false);
  if(!wallet)throw new ApiError(403,"Restore the original nondelegated embedded wallet in the linked provider. An external wallet or another provider identity cannot replace it.","EMBEDDED_WALLET_MISMATCH");
  if(binding&&(binding.provider_subject!==profile.subject||binding.wallet_address!==address))throw new ApiError(409,"This NEAR signer is bound to another wallet. Restore the original wallet instead of creating another owner account.","EMBEDDED_BINDING_MISMATCH");
  return {profile,binding,address:address!};
}

async function chainState(binding:BindingRecord):Promise<NonNullable<EmbeddedNearSetup["chain"]>> {
  const rpc=await provider();
  let account;
  try {account=await rpc.viewAccount({accountId:binding.account_id,blockQuery:{finality:"final"}});}
  catch(error) {
    if(error instanceof AccountDoesNotExistError)return {status:"unfunded",nativeBalance:"0",nativeAvailable:"0",storageUsage:null,storageByteCost:null,gasPrice:null,blockHeight:null};
    throw error;
  }
  const [keys,protocol,gas]=await Promise.all([
    rpc.query<{keys:Array<{public_key:string;access_key:{permission:unknown}}>}>({request_type:"view_access_key_list",account_id:binding.account_id,block_id:account.block_hash}),
    rpc.experimental_protocolConfig({blockId:account.block_hash}),rpc.viewGasPrice(account.block_hash),
  ]);
  const byteCost=protocol.runtime_config?.storage_amount_per_byte;
  if(!byteCost||!/^\d+$/.test(byteCost))throw new ApiError(503,"The finalized NEAR storage price is unavailable","NEAR_STORAGE_PRICE_UNAVAILABLE");
  const storage=BigInt(account.storage_usage)*BigInt(byteCost),total=account.amount+account.locked;
  const available=total-(account.locked>storage?account.locked:storage);
  return {status:keys.keys.some(value=>value.public_key===binding.public_key&&value.access_key.permission==="FullAccess")?"owner_key_ready":"key_unavailable",nativeBalance:total.toString(),nativeAvailable:(available>0n?available:0n).toString(),storageUsage:account.storage_usage,storageByteCost:byteCost,gasPrice:gas.gas_price,blockHeight:account.block_height};
}

async function setup(userId:string):Promise<EmbeddedNearSetup> {
  const binding=bindingFor(userId);
  let chain:EmbeddedNearSetup["chain"]=null;
  if(binding)try{chain=await chainState(binding);}catch{chain={status:"unavailable",nativeBalance:null,nativeAvailable:null,storageUsage:null,storageByteCost:null,gasPrice:null,blockHeight:null};}
  return {available:embeddedNearEnabled(),network:network(),binding:binding?publicBinding(binding):null,chain,transactions:rows<TransactionRecord>("SELECT transaction_hash,receiver_id,status,created_at,observed_at FROM embedded_near_transactions WHERE user_id=? AND network=? ORDER BY created_at DESC LIMIT 32",userId,network()).map(value=>({hash:value.transaction_hash,receiverId:value.receiver_id,status:value.status,createdAt:value.created_at,observedAt:value.observed_at})),sponsored:false};
}

export const embeddedNearRoutes=new Hono<AppEnv>();
embeddedNearRoutes.get("/",async c=>c.json(await setup(c.get("userId"))));
embeddedNearRoutes.post("/identity",async c=>{
  requireFreshSession(c);
  const input=tokenInput.parse(await c.req.json()),profile=await verifyPrivy(input.accessToken,true);
  if(!row("SELECT user_id FROM user_identities WHERE user_id=? AND provider='privy' AND subject=?",c.get("userId"),profile.subject))throw new ApiError(403,"Use the provider identity already linked to this Razor account before creating a wallet","EMBEDDED_IDENTITY_MISMATCH");
  return c.json({subject:profile.subject});
});
embeddedNearRoutes.post("/bind",async c=>{
  requireFreshSession(c);
  const input=tokenInput.extend({walletAddress:z.string().min(32).max(44)}).parse(await c.req.json()),userId=c.get("userId");
  const {profile,address}=await verifiedProvider(userId,input.accessToken,input.walletAddress);
  let publicKey:PublicKey;
  try {if(base58.decode(address).length!==32)throw new Error();publicKey=PublicKey.from(`ed25519:${address}`);}catch{throw new ApiError(400,"The provider did not return an Ed25519 public key","EMBEDDED_KEY_INVALID");}
  const accountId=keyToImplicitAddress(publicKey),now=new Date().toISOString();
  transaction(db=>{
    if(!row("SELECT user_id FROM user_identities WHERE user_id=? AND provider='privy' AND subject=?",userId,profile.subject))throw new ApiError(403,"The linked provider identity changed","EMBEDDED_IDENTITY_MISMATCH");
    const prior=bindingFor(userId);
    if(prior&&(prior.provider_subject!==profile.subject||prior.wallet_address!==address))throw new ApiError(409,"Restore the original owner wallet before continuing","EMBEDDED_BINDING_MISMATCH");
    const existing=row<{user_id:string}>("SELECT user_id FROM embedded_near_accounts WHERE network=? AND account_id=?",network(),accountId);
    if(existing&&existing.user_id!==userId)throw new ApiError(409,"This owner account is already bound to another Razor account","EMBEDDED_ACCOUNT_IN_USE");
    db.prepare("INSERT INTO embedded_near_accounts (user_id,network,provider_subject,wallet_address,public_key,account_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,network) DO UPDATE SET generation=CASE WHEN embedded_near_accounts.disabled_at IS NULL THEN embedded_near_accounts.generation ELSE embedded_near_accounts.generation+1 END,disabled_at=NULL,updated_at=excluded.updated_at").run(userId,network(),profile.subject,address,publicKey.toString(),accountId,now,now);
    audit(userId,null,"wallet.embedded_near_candidate_saved");
  });
  return c.json(await setup(userId));
});

embeddedNearRoutes.post("/authorize",async c=>{
  const input=tokenInput.parse(await c.req.json()),userId=c.get("userId"),{binding}=await verifiedProvider(userId,input.accessToken);
  if(!binding||binding.disabled_at)throw new ApiError(403,"Enable your original embedded NEAR signer in Account and recovery first","EMBEDDED_SIGNER_DISABLED");
  const chain=await chainState(binding);
  if(chain.status!=="owner_key_ready")throw new ApiError(409,"Fund this native NEAR account and verify its full-access key before signing","EMBEDDED_NEAR_NOT_READY");
  const current=bindingFor(userId);
  if(!row("SELECT user_id FROM user_identities WHERE user_id=? AND provider='privy' AND subject=?",userId,binding.provider_subject)||!current||current.disabled_at||current.generation!==binding.generation)throw new ApiError(403,"The signer binding changed. Review your account setup again.","EMBEDDED_SIGNER_DISABLED");
  const linked=!!row("SELECT id FROM linked_wallets WHERE user_id=? AND id=? AND family='near' AND network=? AND address=? AND public_key=?",userId,binding.linked_wallet_id,binding.network,binding.account_id,binding.public_key);
  return c.json({binding:publicBinding(binding),chain,linked});
});

embeddedNearRoutes.post("/linked",async c=>{
  requireFreshSession(c);
  const input=tokenInput.parse(await c.req.json()),userId=c.get("userId"),{binding}=await verifiedProvider(userId,input.accessToken);
  if(!binding||binding.disabled_at)throw new ApiError(403,"Enable your signer first","EMBEDDED_SIGNER_DISABLED");
  const chain=await chainState(binding);
  if(chain.status!=="owner_key_ready")throw new ApiError(409,"The native NEAR owner key is not ready","EMBEDDED_NEAR_NOT_READY");
  transaction(db=>{
    const current=bindingFor(userId);
    if(!current||current.disabled_at||current.public_key!==binding.public_key||current.generation!==binding.generation)throw new ApiError(409,"Your signer setup changed. Review it again.","EMBEDDED_BINDING_MISMATCH");
    const wallet=row<{id:string;last_verified_at:string|null}>("SELECT id,last_verified_at FROM linked_wallets WHERE user_id=? AND family='near' AND network=? AND address=? AND public_key=?",userId,binding.network,binding.account_id,binding.public_key);
    const age=wallet?.last_verified_at?Date.now()-Date.parse(wallet.last_verified_at):NaN;
    if(!wallet||!Number.isFinite(age)||age<0||age>300000)throw new ApiError(403,"Approve a fresh NEAR ownership message before enabling this owner wallet","FRESH_OWNER_PROOF_REQUIRED");
    db.prepare("UPDATE embedded_near_accounts SET generation=CASE WHEN linked_wallet_id=? THEN generation ELSE generation+1 END,linked_wallet_id=?,updated_at=? WHERE user_id=? AND network=? AND disabled_at IS NULL").run(wallet.id,wallet.id,new Date().toISOString(),userId,network());
    db.prepare("INSERT INTO account_onboarding (user_id,wallet_provider,owner_wallet_id,backup_acknowledged_at,updated_at) VALUES (?,'privy-near',?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET wallet_provider='privy-near',owner_wallet_id=excluded.owner_wallet_id,backup_acknowledged_at=NULL,updated_at=excluded.updated_at").run(userId,wallet.id,new Date().toISOString());
    audit(userId,null,"wallet.embedded_near_owner_enabled",wallet.id);
  });
  return c.json(await setup(userId));
});

embeddedNearRoutes.post("/disable",c=>{
  requireFreshSession(c);
  getDb().prepare("UPDATE embedded_near_accounts SET generation=generation+1,disabled_at=?,updated_at=? WHERE user_id=? AND network=?").run(new Date().toISOString(),new Date().toISOString(),c.get("userId"),network());
  audit(c.get("userId"),null,"wallet.embedded_near_signer_disabled");
  return c.json({disabled:true,onchainKeyRevoked:false});
});

embeddedNearRoutes.post("/transactions",async c=>{
  const input=z.object({hash:hashInput,receiverId:z.string().min(2).max(64),generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).parse(await c.req.json()),userId=c.get("userId"),binding=bindingFor(userId);
  if(!binding||binding.disabled_at||!binding.linked_wallet_id)throw new ApiError(403,"Your embedded owner wallet is not enabled","EMBEDDED_SIGNER_DISABLED");
  transaction(db=>{
    const current=bindingFor(userId);
    if(!current||current.disabled_at||current.generation!==input.generation||current.generation!==binding.generation||!row("SELECT user_id FROM user_identities WHERE user_id=? AND provider='privy' AND subject=?",userId,current.provider_subject))throw new ApiError(403,"The embedded signer was disabled or changed before recording this transaction","EMBEDDED_SIGNER_DISABLED");
    const prior=row<{user_id:string;account_id:string;receiver_id:string;public_key:string}>("SELECT user_id,account_id,receiver_id,public_key FROM embedded_near_transactions WHERE network=? AND transaction_hash=?",network(),input.hash);
    if(prior&&(prior.user_id!==userId||prior.account_id!==binding.account_id||prior.public_key!==binding.public_key||prior.receiver_id!==input.receiverId))throw new ApiError(409,"The recorded transaction does not match this signer","EMBEDDED_TRANSACTION_MISMATCH");
    if(!prior&&row("SELECT transaction_hash FROM embedded_near_transactions WHERE user_id=? AND network=? AND status='unresolved'",userId,network()))throw new ApiError(409,"Reconcile the previously signed transaction before opening another wallet action","EMBEDDED_TRANSACTION_UNRESOLVED");
    db.prepare("INSERT INTO embedded_near_transactions (transaction_hash,user_id,network,account_id,receiver_id,public_key,status,created_at) VALUES (?,?,?,?,?,?,'unresolved',?) ON CONFLICT(network,transaction_hash) DO NOTHING").run(input.hash,userId,network(),binding.account_id,input.receiverId,binding.public_key,new Date().toISOString());
  });
  return c.json({recorded:true,status:"unresolved"});
});

embeddedNearRoutes.post("/transactions/:hash/reconcile",async c=>{
  const hash=hashInput.parse(c.req.param("hash")),userId=c.get("userId"),record=row<{account_id:string;receiver_id:string;status:string;public_key:string}>("SELECT account_id,receiver_id,status,public_key FROM embedded_near_transactions WHERE network=? AND transaction_hash=? AND user_id=?",network(),hash,userId);
  if(!record)throw new ApiError(404,"This transaction is not recorded for your account","EMBEDDED_TRANSACTION_NOT_FOUND");
  if(record.status!=="unresolved")return c.json(await setup(userId));
  const rpc=await provider();
  try {
    const receipt=await rpc.viewTransactionStatus({txHash:hash,accountId:record.account_id,waitUntil:"FINAL"});
    if(receipt.final_execution_status!=="FINAL"||receipt.transaction.hash!==hash||receipt.transaction.signer_id!==record.account_id||receipt.transaction.public_key!==record.public_key||receipt.transaction.receiver_id!==record.receiver_id||typeof receipt.status!=="object")throw new Error("Unverified transaction result");
    const status="SuccessValue" in receipt.status?"succeeded":"Failure" in receipt.status?"failed":null;
    if(status)getDb().prepare("UPDATE embedded_near_transactions SET status=?,observed_at=? WHERE network=? AND transaction_hash=? AND user_id=? AND status='unresolved'").run(status,new Date().toISOString(),network(),hash,userId);
  }catch{throw new ApiError(409,"No authoritative final result is available yet. Keep this transaction hash and reconcile it before starting another embedded-wallet transaction. A timeout does not mean it failed.","EMBEDDED_TRANSACTION_UNRESOLVED");}
  return c.json(await setup(userId));
});

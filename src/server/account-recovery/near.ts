import { ApiError } from "../context";
import { row } from "../db";
import type { RecoveryWallet } from "./state";

type Network="mainnet"|"testnet";
export async function nearRpc<T>(network:Network,method:string,params:unknown):Promise<T> {
  async function call<R>(rpcMethod:string,rpcParams:unknown):Promise<R> {
    const response=await fetch(process.env.NEAR_RPC_URL || `https://rpc.${network}.near.org`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"razor-recovery",method:rpcMethod,params:rpcParams}),cache:"no-store",signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new ApiError(503,"NEAR verification is unavailable. Keep your current credentials and retry.","NEAR_UNAVAILABLE");
    const result=await response.json();
    if(result.error)throw new ApiError(409,"NEAR could not verify the requested account or key. Restore access in your wallet provider first.","RECOVERY_CHAIN_UNVERIFIED");
    return result.result as R;
  }
  if((await call<{chain_id:string}>("status",[])).chain_id!==network)throw new ApiError(503,"The configured RPC uses another NEAR network","NEAR_NETWORK_MISMATCH");
  return call<T>(method,params);
}

export async function verifiedOwnerWallet(userId:string,address:string,network:Network) {
  const wallet=row<RecoveryWallet>("SELECT * FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?",userId,address,network);
  const age=wallet?.last_verified_at?Date.now()-Date.parse(wallet.last_verified_at):NaN;
  if(!wallet?.public_key||!Number.isFinite(age)||age<0||age>900000)throw new ApiError(403,"Verify this linked NEAR owner wallet again before changing treasury access","FRESH_OWNER_PROOF_REQUIRED");
  const key=await nearRpc<{permission:unknown}>(network,"query",{request_type:"view_access_key",finality:"final",account_id:address,public_key:wallet.public_key});
  if(key.permission!=="FullAccess")throw new ApiError(403,"The proved key no longer owns this NEAR account. Restore or rotate it in your wallet provider, then verify again.","OWNER_KEY_REQUIRED");
  return wallet;
}

export async function accountKeys(userId:string,walletId:string) {
  const wallet=row<RecoveryWallet>("SELECT * FROM linked_wallets WHERE id=? AND user_id=? AND family='near'",walletId,userId);
  if(!wallet)throw new ApiError(404,"NEAR wallet not found","WALLET_NOT_FOUND");
  const result=await nearRpc<{keys:Array<{public_key:string;access_key:{permission:unknown}}>}>(wallet.network as Network,"query",{request_type:"view_access_key_list",finality:"final",account_id:wallet.address});
  return {wallet,keys:result.keys};
}

export async function prepareRestrictedKeyRevocation(userId:string,walletId:string,publicKey:string) {
  const {wallet,keys}=await accountKeys(userId,walletId);
  await verifiedOwnerWallet(userId,wallet.address,wallet.network as Network);
  const key=keys.find(value=>value.public_key===publicKey);
  if(!key)throw new ApiError(404,"This key is not present on the NEAR account","KEY_NOT_FOUND");
  if(!key.access_key.permission||typeof key.access_key.permission!=="object"||!("FunctionCall" in key.access_key.permission))throw new ApiError(409,"Razor only revokes restricted function-call keys. Rotate full-access recovery keys in your wallet provider.","RESTRICTED_KEY_ONLY");
  return {signerId:wallet.address,network:wallet.network,publicKey,walletActions:[{receiverId:wallet.address,actions:[{type:"DeleteKey" as const,params:{publicKey}}]}]};
}

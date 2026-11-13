"use client";

import { connectNearWallet, getNearConnector } from "@/components/auth/wallets";

export interface RecoveryActions {signerId:string;network:string;walletActions:Array<{receiverId:string;actions:Array<{type:"FunctionCall";params:{methodName:string;args:object;deposit:string;gas:string}}|{type:"DeleteKey";params:{publicKey:string}}>}>}
export async function signRecoveryActions(prepared:RecoveryActions):Promise<string|null> {
  if(!prepared.walletActions.length)return null;
  const connector=await getNearConnector();
  if(connector.network!==prepared.network)throw new Error("Connect your wallet on the configured NEAR network before signing.");
  const {wallet,accounts}=await connectNearWallet();
  if(!accounts.some(account=>account.accountId===prepared.signerId))throw new Error("Connect the owner wallet shown in this review before signing.");
  const receipts=await wallet.signAndSendTransactions({network:prepared.network as "mainnet"|"testnet",transactions:prepared.walletActions.map(action=>({...action,signerId:prepared.signerId}))});
  const last=receipts.at(-1);
  if(!last)throw new Error("No wallet receipt was returned. Refresh the onchain state before retrying.");
  if(receipts.some(receipt=>typeof receipt.status==="object"&&"Failure" in receipt.status))throw new Error("The wallet action did not complete successfully. Reconcile its recorded state before retrying.");
  return last.transaction.hash;
}

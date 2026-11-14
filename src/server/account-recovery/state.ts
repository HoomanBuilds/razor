import { ApiError } from "../context";
import { row, rows } from "../db";
import { view } from "../payments/near";
import type { TreasuryConfig } from "../payments/types";
import { ownerWalletProviders } from "./providers";
import { embeddedNearEnabled } from "./embedded-near";

export interface RecoveryWallet {id:string;family:string;address:string;network:string;public_key:string|null;last_verified_at:string|null;label:string|null;created_at:string}

export function requireAlternateVerifiedIdentity(userId:string,method:string,removedProvider:string,removedSubject:string) {
  const delimiter=method.indexOf(":"),provider=method.slice(0,delimiter),subject=method.slice(delimiter+1);
  if(delimiter<0||provider===removedProvider&&subject===removedSubject||!row("SELECT user_id FROM user_identities WHERE user_id=? AND provider=? AND subject=?",userId,provider,subject))throw new ApiError(403,"Verify a different linked sign-in method before removing this recovery credential","VERIFY_RECOVERY_METHOD_FIRST");
}

export function accountReadiness(userId:string) {
  const network=process.env.NEAR_NETWORK || "testnet",wallets=rows<RecoveryWallet>("SELECT id,family,address,network,public_key,last_verified_at,label,created_at FROM linked_wallets WHERE user_id=? ORDER BY created_at",userId);
  const onboarding=row<{wallet_provider:string|null;owner_wallet_id:string|null;backup_acknowledged_at:string|null}>("SELECT wallet_provider,owner_wallet_id,backup_acknowledged_at FROM account_onboarding WHERE user_id=?",userId);
  const ownerWallet=wallets.find(wallet=>wallet.id===onboarding?.owner_wallet_id&&wallet.family==="near"&&wallet.network===network) || wallets.find(wallet=>wallet.family==="near"&&wallet.network===network) || null;
  const identities=rows<{provider:string;subject:string}>("SELECT provider,subject FROM user_identities WHERE user_id=?",userId);
  return {network,...ownerWalletProviders(network),onboarding:onboarding || null,wallets,ownerWallet,ownerWalletReady:!!ownerWallet?.public_key&&!!ownerWallet.last_verified_at,recoveryMethodCount:identities.length,hasAlternateSignIn:identities.length>=2,backupAcknowledgedAt:onboarding?.owner_wallet_id===ownerWallet?.id?onboarding?.backup_acknowledged_at || null:null,backupVerified:false,nativeEmbeddedNear:{available:embeddedNearEnabled(),mode:"privy_ed25519_near",reason:"An explicitly created provider Ed25519 wallet can sign native NEAR messages and transactions. Funding, finalized full-access ownership proof and individual approvals are required. Provider setup and recovery must be available."},socialConfigured:!!((process.env.PRIVY_APP_ID||process.env.NEXT_PUBLIC_PRIVY_APP_ID)&&(process.env.PRIVY_VERIFICATION_KEY||process.env.PRIVY_JWKS_URL))};
}

export async function assertWalletDetachable(userId:string,wallet:Pick<RecoveryWallet,"family"|"address"|"network">) {
  if(wallet.family!=="near")return;
  const companies=rows<TreasuryConfig>("SELECT t.* FROM treasury_config t JOIN organizations o ON o.id=t.organization_id WHERE t.network=? AND (o.owner_id=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=o.id AND m.user_id=? AND m.status='active'))",wallet.network,userId,userId);
  for(const company of companies) {
    let config:{owner_id:string};
    try{config=await view(company,"get_config");}catch{throw new ApiError(503,"Treasury ownership could not be checked. Keep this wallet linked and retry before removing it.","OWNER_CHECK_UNAVAILABLE");}
    if(config.owner_id===wallet.address)throw new ApiError(409,"This wallet still owns a company treasury. Restore or rotate its keys in the wallet provider, or complete a verified treasury ownership transfer before unlinking it.","OWNER_WALLET_IN_USE");
  }
}

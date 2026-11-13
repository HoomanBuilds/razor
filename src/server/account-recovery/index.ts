import { Hono } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { audit, currentSession, requireFreshSession, requireUser } from "../identity/session";
import { accountReadiness, requireAlternateVerifiedIdentity } from "./state";
import { OWNER_WALLET_PROVIDERS } from "./providers";
import { accountKeys, prepareRestrictedKeyRevocation } from "./near";

const identityId=(provider:string,subject:string)=>createHash("sha256").update(JSON.stringify([provider,subject])).digest("hex");
export const accountRecoveryRoutes=new Hono<AppEnv>();
accountRecoveryRoutes.use("*",requireUser);
accountRecoveryRoutes.get("/status",c=>{
  const session=currentSession(c)!;
  const age=Date.now()-Date.parse(session.created_at);
  return c.json({...accountReadiness(c.get("userId")),freshSignIn:Number.isFinite(age)&&age>=0&&age<=900000,authenticatedAt:session.created_at,authenticationMethod:session.authentication_method,identities:rows<{provider:string;subject:string;created_at:string}>("SELECT provider,subject,created_at FROM user_identities WHERE user_id=?",c.get("userId")).map(identity=>({id:identityId(identity.provider,identity.subject),provider:identity.provider,createdAt:identity.created_at})),sessions:rows<{id:string;created_at:string;expires_at:string;authentication_method:string}>("SELECT id,created_at,expires_at,authentication_method FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC",c.get("userId"),new Date().toISOString()).map(value=>({...value,current:value.id===session.id}))});
});
accountRecoveryRoutes.put("/onboarding",async c=>{
  const input=z.object({provider:z.enum(["near-mobile","meteor-wallet"]).optional(),ownerWalletId:z.string().uuid().optional(),backupAcknowledged:z.boolean().optional()}).parse(await c.req.json()),userId=c.get("userId");
  if(input.backupAcknowledged!==undefined||input.ownerWalletId)requireFreshSession(c);
  const state=accountReadiness(userId),provider=input.provider || state.onboarding?.wallet_provider || state.preferredProvider;
  if(!OWNER_WALLET_PROVIDERS.some(value=>value.id===provider&&(value.networks as readonly string[]).includes(state.network)))throw new ApiError(400,"Choose a wallet provider available on this NEAR network","WALLET_PROVIDER_UNSUPPORTED");
  const walletId=input.ownerWalletId || state.ownerWallet?.id || null;
  if(walletId&&!state.wallets.some(value=>value.id===walletId&&value.family==="near"&&value.network===state.network))throw new ApiError(403,"Verify a NEAR owner wallet on this network before selecting it","OWNER_WALLET_UNVERIFIED");
  const backup=input.backupAcknowledged===undefined?(state.onboarding?.owner_wallet_id===walletId&&state.onboarding?.wallet_provider===provider?state.onboarding?.backup_acknowledged_at || null:null):input.backupAcknowledged?new Date().toISOString():null;
  if(input.backupAcknowledged&&!walletId)throw new ApiError(400,"Link your owner wallet before acknowledging its recovery backup","OWNER_WALLET_UNVERIFIED");
  getDb().prepare("INSERT INTO account_onboarding (user_id,wallet_provider,owner_wallet_id,backup_acknowledged_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET wallet_provider=excluded.wallet_provider,owner_wallet_id=excluded.owner_wallet_id,backup_acknowledged_at=excluded.backup_acknowledged_at,updated_at=excluded.updated_at").run(userId,provider,walletId,backup,new Date().toISOString());
  audit(userId,null,"account.onboarding_reviewed");
  return c.json(accountReadiness(userId));
});
accountRecoveryRoutes.post("/sessions/revoke-others",c=>{
  const session=requireFreshSession(c),result=getDb().prepare("DELETE FROM sessions WHERE user_id=? AND id!=?").run(c.get("userId"),session.id);
  audit(c.get("userId"),null,"account.other_sessions_revoked");
  return c.json({revoked:Number(result.changes)});
});
accountRecoveryRoutes.delete("/identities/:id",c=>{
  const fresh=requireFreshSession(c);
  const userId=c.get("userId"),identities=rows<{provider:string;subject:string}>("SELECT provider,subject FROM user_identities WHERE user_id=?",userId),identity=identities.find(value=>identityId(value.provider,value.subject)===c.req.param("id"));
  if(!identity)throw new ApiError(404,"Linked identity not found","IDENTITY_NOT_FOUND");
  if(identity.provider==="wallet")throw new ApiError(400,"Remove a wallet through its verified wallet entry so treasury ownership can be checked","USE_WALLET_SECURITY_FLOW");
  if(identities.length<=1)throw new ApiError(409,"Keep another verified sign-in method before removing this identity","RECOVERY_METHOD_REQUIRED");
  requireAlternateVerifiedIdentity(userId,fresh.authentication_method,identity.provider,identity.subject);
  transaction(db=>{
    db.prepare("DELETE FROM user_identities WHERE provider=? AND subject=? AND user_id=?").run(identity.provider,identity.subject,userId);
    if(identity.provider==="privy")db.prepare("UPDATE users SET email=NULL WHERE id=?").run(userId);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND id!=?").run(userId,currentSession(c)!.id);
    audit(userId,null,"account.identity_unlinked");
  });
  return c.json({removed:true});
});
accountRecoveryRoutes.get("/wallets/:id/keys",async c=>c.json(await accountKeys(c.get("userId"),c.req.param("id"))));
accountRecoveryRoutes.post("/wallets/:id/revoke-key",async c=>{
  requireFreshSession(c);
  const input=z.object({publicKey:z.string().min(10).max(150)}).parse(await c.req.json());
  const prepared=await prepareRestrictedKeyRevocation(c.get("userId"),c.req.param("id"),input.publicKey);
  audit(c.get("userId"),null,"wallet.restricted_key_revocation_prepared",c.req.param("id"));
  return c.json(prepared);
});

export { treasuryRecoveryRoutes } from "./treasury-routes";

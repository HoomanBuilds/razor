import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, isAddress, verifyMessage as verifyEvmMessage } from "viem";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { JsonRpcProvider } from "near-api-js";
import { verifyMessage as verifyNearMessage } from "near-api-js/nep413";
import { z } from "zod";
import { verifyPrivy } from "./privy";
import { embeddedNearEnabled } from "../account-recovery/embedded-near";
import { assertWalletDetachable, requireAlternateVerifiedIdentity } from "../account-recovery/state";
import { ownerWalletProviders } from "../account-recovery/providers";
import { getDb, row, rows, transaction } from "../db";
import { ApiError, type AppEnv } from "../context";
import { appOrigin, audit, currentSession, getAccess, issueSession, organizationsFor, requireFreshSession, requireUser, revokeSession, verifyOrigin } from "./session";

const WalletFamily = z.enum(["near", "evm", "solana"]);
const ChallengeInput = z.object({ family: WalletFamily, address: z.string().min(2).max(128), network: z.string().max(40).optional(), purpose: z.enum(["login", "link","reauth"]).default("login") });
const SignatureInput = z.object({ challengeId: z.string().uuid(), signature: z.string().min(8).max(512), publicKey: z.string().max(160).optional() });

interface ChallengeRecord {
  id: string; family: "near" | "evm" | "solana"; address: string; network: string;
  message: string; nonce: string; recipient: string; user_id: string | null; purpose: string; expires_at: string; used_at: string | null;
}

export function normalizeWallet(family: string, address: string): string {
  if (family === "evm") {
    if (!isAddress(address)) throw new ApiError(400, "Enter a valid EVM address", "INVALID_ADDRESS");
    return getAddress(address).toLowerCase();
  }
  if (family === "solana") {
    try { if (base58.decode(address).length !== 32) throw new Error(); } catch { throw new ApiError(400, "Enter a valid Solana address", "INVALID_ADDRESS"); }
    return address;
  }
  if (address.length<2 || address.length>64 || !/^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/.test(address)) throw new ApiError(400, "Enter a valid NEAR account", "INVALID_ADDRESS");
  return address;
}

function walletSubject(challenge: ChallengeRecord): string {
  return `${challenge.family}:${challenge.network}:${challenge.address}`;
}

export async function verifyWalletChallenge(challenge: ChallengeRecord, signature: string, publicKey?: string): Promise<void> {
  if (challenge.used_at || challenge.expires_at <= new Date().toISOString()) throw new ApiError(401, "This challenge has expired or was already used", "CHALLENGE_EXPIRED");
  if (challenge.family === "evm") {
    const verified = await verifyEvmMessage({ address: challenge.address as `0x${string}`, message: challenge.message, signature: signature as `0x${string}` });
    if (!verified) throw new ApiError(401, "Wallet signature was not accepted", "SIGNATURE_REJECTED");
    return;
  }
  if (challenge.family === "solana") {
    let bytes: Uint8Array;
    try { bytes = base58.decode(signature); if(bytes.length!==64) bytes = Buffer.from(signature,"base64"); } catch { bytes = Buffer.from(signature, "base64"); }
    if(bytes.length!==64) throw new ApiError(401,"Wallet signature was not accepted","SIGNATURE_REJECTED");
    if (!ed25519.verify(bytes, new TextEncoder().encode(challenge.message), base58.decode(challenge.address))) throw new ApiError(401, "Wallet signature was not accepted", "SIGNATURE_REJECTED");
    return;
  }
  if (!publicKey?.startsWith("ed25519:")) throw new ApiError(400, "The NEAR wallet must return its public key", "PUBLIC_KEY_REQUIRED");
  const rpc = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || (challenge.network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org") });
  if(await rpc.getNetworkId()!==challenge.network)throw new ApiError(503,"The NEAR RPC uses another network. Ask the operator to correct it before wallet verification.","NEAR_NETWORK_MISMATCH");
  const key = await rpc.query<{ permission: string | object }>({ request_type: "view_access_key", finality: "final", account_id: challenge.address, public_key: publicKey });
  if (key.permission !== "FullAccess") throw new ApiError(403, "Use an owner-controlled NEAR key to link this account", "OWNER_KEY_REQUIRED");
  await verifyNearMessage({ signerAccountId: challenge.address, signerPublicKey: publicKey, signature: new Uint8Array(Buffer.from(signature, "base64")), payload: { message: challenge.message, recipient: challenge.recipient, nonce: new Uint8Array(Buffer.from(challenge.nonce, "hex")) }, provider: rpc });
}


export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/config", (c) => c.json({
  socialEnabled: Boolean((process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID) && (process.env.PRIVY_VERIFICATION_KEY || process.env.PRIVY_JWKS_URL)),
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID || null,
  walletFamilies: ["near", "evm", "solana"], nearNetwork: process.env.NEAR_NETWORK || "testnet", origin: appOrigin(),
  ownerWalletSetup:{...ownerWalletProviders(process.env.NEAR_NETWORK || "testnet"),nativeEmbeddedNear:embeddedNearEnabled()},
}));

authRoutes.post("/challenge", async (c) => {
  verifyOrigin(c);
  const input = ChallengeInput.parse(await c.req.json());
  const address = normalizeWallet(input.family, input.address);
  const session = currentSession(c);
  if (input.purpose !== "login" && !session) throw new ApiError(401, "Sign in before linking or verifying a recovery method", "UNAUTHENTICATED");
  if (input.purpose === "link")requireFreshSession(c);
  const network = input.family === "near" ? process.env.NEAR_NETWORK || "testnet" : input.family === "solana" ? "solana" : "evm";
  const recent = row<{ count: number }>("SELECT count(*) AS count FROM auth_challenges WHERE address = ? AND created_at > ?", address, new Date(Date.now() - 60000).toISOString());
  if ((recent?.count || 0) >= 8) throw new ApiError(429, "Please wait before requesting another sign-in challenge", "RATE_LIMITED");
  const id = randomUUID(), nonce = randomBytes(32).toString("hex"), recipient = new URL(appOrigin()).host;
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const message = `Sign in to Razor\nDomain: ${recipient}\nWallet: ${address}\nNetwork: ${network}\nPurpose: ${input.purpose}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
  getDb().prepare("INSERT INTO auth_challenges (id,family,address,network,message,nonce,recipient,user_id,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,input.family,address,network,message,nonce,recipient,input.purpose !== "login" ? session!.user_id : null,input.purpose,expiresAt,new Date().toISOString());
  return c.json({ id, challengeId: id, message, nonce, recipient, expiresAt, family: input.family, address, network });
});

authRoutes.post("/wallet", async (c) => {
  verifyOrigin(c);
  const input = SignatureInput.parse(await c.req.json());
  const challenge = row<ChallengeRecord>("SELECT * FROM auth_challenges WHERE id = ?", input.challengeId);
  if (!challenge) throw new ApiError(401, "Request a fresh wallet sign-in challenge", "CHALLENGE_NOT_FOUND");
  if (challenge.user_id && currentSession(c)?.user_id !== challenge.user_id) throw new ApiError(403, "Wallet linking session changed", "SESSION_CHANGED");
  if(challenge.purpose==="link")requireFreshSession(c);
  try { await verifyWalletChallenge(challenge, input.signature, input.publicKey); } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "Wallet ownership could not be verified", "SIGNATURE_REJECTED");
  }
  const userId = transaction((db) => {
    const consumed = db.prepare("UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(new Date().toISOString(), challenge.id, new Date().toISOString());
    if (consumed.changes !== 1) throw new ApiError(401, "Challenge already used or expired", "CHALLENGE_EXPIRED");
    const subject = walletSubject(challenge);
    const existing = row<{ user_id: string }>("SELECT user_id FROM user_identities WHERE provider = 'wallet' AND subject = ?", subject);
    if(challenge.purpose==="reauth"&&existing?.user_id!==challenge.user_id)throw new ApiError(403,"Use a wallet already linked to this account for fresh verification","LINKED_IDENTITY_REQUIRED");
    if (existing && challenge.user_id && existing.user_id !== challenge.user_id) throw new ApiError(409, "This wallet is linked to another account", "WALLET_ALREADY_LINKED");
    const id = existing?.user_id || challenge.user_id || randomUUID();
    const now = new Date().toISOString();
    if (!existing && !challenge.user_id) db.prepare("INSERT INTO users (id,name,created_at) VALUES (?,?,?)").run(id, `${challenge.address.slice(0,10)} account`, now);
    if (!existing) {
      db.prepare("INSERT INTO user_identities (provider,subject,user_id,created_at) VALUES ('wallet',?,?,?)").run(subject,id,now);
      db.prepare("INSERT INTO linked_wallets (id,user_id,family,address,network,public_key,created_at,last_verified_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(),id,challenge.family,challenge.address,challenge.network,input.publicKey || null,now,now);
    }
    const previous=row<{id:string;public_key:string|null}>("SELECT id,public_key FROM linked_wallets WHERE user_id=? AND family=? AND address=? AND network=?",id,challenge.family,challenge.address,challenge.network);
    if(previous?.public_key&&input.publicKey&&previous.public_key!==input.publicKey){db.prepare("UPDATE account_onboarding SET backup_acknowledged_at=NULL,updated_at=? WHERE user_id=? AND owner_wallet_id=?").run(now,id,previous.id);audit(id,null,"wallet.owner_key_reverified",previous.id);}
    db.prepare("UPDATE linked_wallets SET public_key=COALESCE(?,public_key),last_verified_at=? WHERE user_id=? AND family=? AND address=? AND network=?").run(input.publicKey||null,now,id,challenge.family,challenge.address,challenge.network);
    audit(id, null, "wallet.verified", undefined, { family: challenge.family, purpose: challenge.purpose });
    return id;
  });
  if (!challenge.user_id||challenge.purpose==="reauth") issueSession(c,userId,`wallet:${walletSubject(challenge)}`);
  return c.json({ user: row("SELECT id,email,name FROM users WHERE id = ?",userId), organizations: organizationsFor(userId) });
});

authRoutes.post("/privy", async (c) => {
  verifyOrigin(c);
  const input = z.object({ accessToken: z.string().min(20).max(12000), link: z.boolean().default(false),reauth:z.boolean().default(false) }).refine(value=>!(value.link&&value.reauth),"Choose linking or fresh verification").parse(await c.req.json());
  let profile;
  try { profile = await verifyPrivy(input.accessToken); } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "Social sign-in could not be verified", "SIGN_IN_REJECTED");
  }
  const current = currentSession(c);
  if ((input.link||input.reauth) && !current) throw new ApiError(401, "Sign in before linking or verifying another identity", "UNAUTHENTICATED");
  if(input.link)requireFreshSession(c);
  const userId = transaction((db) => {
    const existing = row<{ user_id: string }>("SELECT user_id FROM user_identities WHERE provider = 'privy' AND subject = ?", profile.subject);
    if(input.reauth&&existing?.user_id!==current!.user_id)throw new ApiError(403,"Use a social identity already linked to this Razor account","LINKED_IDENTITY_REQUIRED");
    if (existing && input.link && existing.user_id !== current!.user_id) throw new ApiError(409, "This sign-in is already linked to another account", "IDENTITY_ALREADY_LINKED");
    const id = existing?.user_id || (input.link ? current!.user_id : randomUUID());
    if (!existing) {
      const now = new Date().toISOString();
      if (!input.link) db.prepare("INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)").run(id,profile.email,profile.name,now);
      db.prepare("INSERT INTO user_identities (provider,subject,user_id,created_at) VALUES ('privy',?,?,?)").run(profile.subject,id,now);
    }
    if (profile.email) db.prepare("UPDATE users SET email = ? WHERE id = ?").run(profile.email,id);
    return id;
  });
  if (!input.link) issueSession(c,userId,`privy:${profile.subject}`);
  return c.json({ user: row("SELECT id,email,name FROM users WHERE id = ?",userId), organizations: organizationsFor(userId) });
});

authRoutes.get("/session", requireUser, (c) => {
  const userId=c.get("userId");
  const activeOrganizationId=currentSession(c)?.organization_id || null;
  const recipientProfileCount=row<{count:number}>("SELECT count(*) AS count FROM recipients WHERE user_id=?",userId)?.count ?? 0;
  let permissions:string[]=[];
  if(activeOrganizationId) { try { permissions=getAccess(userId,activeOrganizationId).permissions; } catch { getDb().prepare("UPDATE sessions SET organization_id = NULL WHERE id = ?").run(currentSession(c)!.id); } }
  return c.json({ user: row("SELECT id,email,name FROM users WHERE id = ?",userId), organizations: organizationsFor(userId), wallets: rows("SELECT id,family,address,network,label,created_at FROM linked_wallets WHERE user_id = ?",userId), activeOrganizationId: permissions.length?activeOrganizationId:null, permissions, recipientProfileCount });
});

authRoutes.post("/logout", requireUser, (c) => { revokeSession(c); return c.json({ ok: true }); });

authRoutes.delete("/wallets/:walletId", requireUser, async (c) => {
  const userId=c.get("userId"), walletId=c.req.param("walletId");
  const wallet=row<{family:string;address:string;network:string}>("SELECT * FROM linked_wallets WHERE id = ? AND user_id = ?",walletId,userId);
  if (!wallet) throw new ApiError(404,"Wallet not found","NOT_FOUND");
  const fresh=requireFreshSession(c);
  await assertWalletDetachable(userId,wallet);
  transaction((db)=>{
    const count=row<{count:number}>("SELECT count(*) AS count FROM user_identities WHERE user_id = ?",userId)!.count;
    if (count<=1) throw new ApiError(409,"Keep another verified sign-in method before removing this wallet","RECOVERY_METHOD_REQUIRED");
    requireAlternateVerifiedIdentity(userId,fresh.authentication_method,"wallet",`${wallet.family}:${wallet.network}:${wallet.address}`);
    db.prepare("DELETE FROM user_identities WHERE provider = 'wallet' AND subject = ? AND user_id = ?").run(`${wallet.family}:${wallet.network}:${wallet.address}`,userId);
    db.prepare("UPDATE embedded_near_accounts SET generation=generation+1,disabled_at=?,updated_at=? WHERE user_id=? AND linked_wallet_id=?").run(new Date().toISOString(),new Date().toISOString(),userId,walletId);
    db.prepare("DELETE FROM linked_wallets WHERE id = ?").run(walletId);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND id!=?").run(userId,fresh.id);
    audit(userId,null,"account.wallet_unlinked",walletId);
  });
  return c.json({ok:true});
});

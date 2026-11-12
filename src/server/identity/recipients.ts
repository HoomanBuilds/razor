import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "./crypto";
import { normalizeWallet } from "./auth";
import { appOrigin, audit, requireOrganization, requireUser } from "./session";

export interface RecipientRecord {
  id: string; organization_id: string; user_id: string | null; name: string; email: string | null; kind: string;
  primary_asset: string; primary_network: string; primary_address: string; backup_network: string | null; backup_address: string | null;
  fallback_consent: number; preference_status: string; version: number; confirmed_at: string | null; archived: number; created_at: string; updated_at: string;
}

const EVM_NETWORKS = new Set(["eth","base","arb","pol","op","avax","bsc","bnb","gnosis","aurora","bera","plasma","monad"]);
const BACKUP_NETWORKS = ["base","arb","pol","eth","sol","near"] as const;
const NETWORK_ALIASES:Record<string,string>={ethereum:"eth",arbitrum:"arb",polygon:"pol",solana:"sol",optimism:"op",avalanche:"avax",berachain:"bera"};
const canonicalNetwork=(value:string)=>NETWORK_ALIASES[value.toLowerCase()] || value.toLowerCase();
const ProfileInput = z.object({
  name: z.string().trim().min(1).max(120), email: z.email().max(254).nullable().optional(), kind: z.enum(["employee","contractor","business"]),
  primaryAsset: z.string().trim().min(1).max(240).default("USDC"), primaryNetwork: z.string().trim().min(2).max(80), primaryAddress: z.string().trim().min(2).max(200),
  backupNetwork: z.preprocess((value)=>typeof value==="string"?canonicalNetwork(value):value,z.enum(BACKUP_NETWORKS).nullable().optional()), backupAddress: z.string().trim().min(2).max(200).nullable().optional(),
});
const PreferenceInput = ProfileInput.pick({primaryAsset:true,primaryNetwork:true,primaryAddress:true,backupNetwork:true,backupAddress:true}).extend({expectedVersion:z.number().int().positive(),fallbackConsent:z.boolean().default(false)});

function familyFor(network: string): string | undefined {
  if (EVM_NETWORKS.has(network)) return "evm";
  if (network === "sol") return "solana";
  if (network === "near") return "near";
}

function validateRoute<T extends {primaryAsset:string;primaryNetwork:string;primaryAddress:string;backupNetwork?:string|null;backupAddress?:string|null}>(input: T): T {
  input.primaryNetwork = canonicalNetwork(input.primaryNetwork);
  const family = familyFor(input.primaryNetwork);
  if (family) input.primaryAddress = normalizeWallet(family,input.primaryAddress);
  if (Boolean(input.backupNetwork)!==Boolean(input.backupAddress)) throw new ApiError(400,"Choose both the backup network and its receiving address","BACKUP_INCOMPLETE");
  if (input.backupNetwork && input.backupAddress) {
    input.backupAddress=normalizeWallet(familyFor(input.backupNetwork)!,input.backupAddress);
    if (input.primaryAsset.toUpperCase()==="USDC" && input.primaryNetwork===input.backupNetwork && input.primaryAddress===input.backupAddress) throw new ApiError(400,"Choose a distinct backup route so it can help when the primary route is unavailable","BACKUP_EQUALS_PRIMARY");
  }
  return input;
}

function serialize(record: RecipientRecord): RecipientRecord {
  return {...record,name:decrypt(record.name),email:record.email?decrypt(record.email):null};
}

const RECIPIENT_COLUMNS = "id,organization_id,user_id,name,email,kind,primary_asset,primary_network,primary_address,backup_network,backup_address,fallback_consent,preference_status,version,confirmed_at,archived,created_at,updated_at";

export function getRecipient(orgId:string,id:string):RecipientRecord {
  const recipient=row<RecipientRecord>(`SELECT ${RECIPIENT_COLUMNS} FROM recipients WHERE organization_id = ? AND id = ?`,orgId,id);
  if(!recipient) throw new ApiError(404,"Recipient not found","RECIPIENT_NOT_FOUND");
  return serialize(recipient);
}

export function listRecipients(orgId:string):RecipientRecord[] {
  return rows<RecipientRecord>(`SELECT ${RECIPIENT_COLUMNS} FROM recipients WHERE organization_id = ? AND archived = 0 ORDER BY created_at DESC`,orgId).map(serialize);
}

function saveVersion(recipient:RecipientRecord,userId:string) {
  getDb().prepare("INSERT INTO recipient_versions (recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES (?,?,?,?,?)").run(recipient.id,recipient.version,encrypt(JSON.stringify(recipient)),userId,new Date().toISOString());
}

export const recipientRoutes = new Hono<AppEnv>();
recipientRoutes.use("*",requireUser);
recipientRoutes.get("/:orgId/recipients",requireOrganization("recipients:read"),(c)=>c.json({recipients:listRecipients(c.req.param("orgId")),backupAsset:"USDC",backupNetworks:BACKUP_NETWORKS}));

recipientRoutes.post("/:orgId/recipients",requireOrganization("recipients:manage"),async(c)=>{
  const input=validateRoute(ProfileInput.parse(await c.req.json())),orgId=c.req.param("orgId"),id=randomUUID(),token=newToken(),now=new Date().toISOString();
  transaction((db)=>{
    db.prepare("INSERT INTO recipients (id,organization_id,name,email,kind,primary_asset,primary_network,primary_address,backup_network,backup_address,invitation_token_hash,invitation_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,orgId,encrypt(input.name),input.email?encrypt(input.email.toLowerCase()):null,input.kind,input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.backupNetwork??null,input.backupAddress??null,hashToken(token),new Date(Date.now()+7*86400000).toISOString(),now,now);
    saveVersion(getRecipient(orgId,id),c.get("userId"));
    audit(c.get("userId"),orgId,"recipient.created",id,{version:1});
  });
  return c.json({recipient:getRecipient(orgId,id),invitationUrl:`${appOrigin()}/receive?token=${token}`,delivery:"copy_link"},201);
});

recipientRoutes.get("/:orgId/recipients/:recipientId",requireOrganization("recipients:read"),(c)=>c.json({recipient:getRecipient(c.req.param("orgId"),c.req.param("recipientId"))}));

recipientRoutes.patch("/:orgId/recipients/:recipientId",requireOrganization("recipients:manage"),async(c)=>{
  const input=validateRoute(ProfileInput.extend({expectedVersion:z.number().int().positive()}).parse(await c.req.json())),orgId=c.req.param("orgId"),id=c.req.param("recipientId");
  transaction((db)=>{
    const existing=getRecipient(orgId,id);
    if(existing.archived) throw new ApiError(409,"This recipient has been archived","RECIPIENT_ARCHIVED");
    if(existing.version!==input.expectedVersion) throw new ApiError(409,"This recipient changed. Refresh before saving.","RECIPIENT_VERSION_CHANGED");
    const email=input.email?.toLowerCase() || null;
    const identityChanged=existing.email!==email;
    db.prepare("UPDATE recipients SET name = ?,email = ?,kind = ?,primary_asset = ?,primary_network = ?,primary_address = ?,backup_network = ?,backup_address = ?,fallback_consent = 0,preference_status = 'pending_confirmation',confirmed_at = NULL,user_id = CASE WHEN ? THEN NULL ELSE user_id END,version = version + 1,updated_at = ? WHERE id = ? AND organization_id = ? AND version = ?")
      .run(encrypt(input.name),email?encrypt(email):null,input.kind,input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.backupNetwork??null,input.backupAddress??null,Number(identityChanged),new Date().toISOString(),id,orgId,input.expectedVersion);
    saveVersion(getRecipient(orgId,id),c.get("userId"));
    audit(c.get("userId"),orgId,"recipient.updated",id,{version:input.expectedVersion+1});
  });
  return c.json({recipient:getRecipient(orgId,id)});
});

recipientRoutes.post("/:orgId/recipients/:recipientId/invite",requireOrganization("recipients:manage"),(c)=>{
  const orgId=c.req.param("orgId"),id=c.req.param("recipientId"),recipient=getRecipient(orgId,id),token=newToken();
  if(recipient.archived) throw new ApiError(409,"This recipient has been archived","RECIPIENT_ARCHIVED");
  getDb().prepare("UPDATE recipients SET invitation_token_hash = ?,invitation_expires_at = ? WHERE id = ? AND organization_id = ?").run(hashToken(token),new Date(Date.now()+7*86400000).toISOString(),id,orgId);
  return c.json({invitationUrl:`${appOrigin()}/receive?token=${token}`,delivery:"copy_link"});
});

recipientRoutes.delete("/:orgId/recipients/:recipientId",requireOrganization("recipients:manage"),(c)=>{
  const orgId=c.req.param("orgId"),id=c.req.param("recipientId");
  transaction((db)=>{
    getRecipient(orgId,id);
    db.prepare("UPDATE recipients SET archived = 1,version = version + 1,updated_at = ?,invitation_token_hash = NULL WHERE id = ? AND organization_id = ?").run(new Date().toISOString(),id,orgId);
    saveVersion(getRecipient(orgId,id),c.get("userId"));
    audit(c.get("userId"),orgId,"recipient.archived",id);
  });
  return c.json({ok:true});
});

recipientRoutes.get("/:orgId/recipients/:recipientId/versions",requireOrganization("recipients:read"),(c)=>{
  const recipient=getRecipient(c.req.param("orgId"),c.req.param("recipientId"));
  return c.json({versions:rows<{version:number;profile_ciphertext:string;created_at:string}>("SELECT version,profile_ciphertext,created_at FROM recipient_versions WHERE recipient_id = ? ORDER BY version DESC",recipient.id).map(({profile_ciphertext,...version})=>({...version,profile:JSON.parse(decrypt(profile_ciphertext))}))});
});

function invitedRecipient(token:string,userId:string):RecipientRecord {
  const record=row<RecipientRecord>(`SELECT ${RECIPIENT_COLUMNS} FROM recipients WHERE invitation_token_hash = ? AND invitation_expires_at > ? AND archived = 0`,hashToken(token),new Date().toISOString());
  if(!record) throw new ApiError(404,"This recipient link has expired. Ask the payer for a new link.","RECIPIENT_LINK_UNAVAILABLE");
  const recipient=serialize(record);
  if(recipient.user_id===userId) return recipient;
  const user=row<{email:string|null}>("SELECT email FROM users WHERE id = ?",userId)!;
  if(user.email && recipient.email && user.email.toLowerCase()===recipient.email.toLowerCase()) return recipient;
  const family=familyFor(recipient.primary_network);
  const wallet=family && row("SELECT id FROM linked_wallets WHERE user_id = ? AND family = ? AND address = ? AND (? != 'near' OR network = ?)",userId,family,recipient.primary_address,family,process.env.NEAR_NETWORK || "testnet");
  if(wallet) return recipient;
  throw new ApiError(403,"Verify the recipient email or connect the primary receiving wallet to manage these preferences","RECIPIENT_PROOF_REQUIRED");
}

export const recipientPortalRoutes=new Hono<AppEnv>();
recipientPortalRoutes.use("*",requireUser);
recipientPortalRoutes.get("/:token",(c)=>{
  const recipient=invitedRecipient(c.req.param("token"),c.get("userId"));
  return c.json({recipient,organization:row("SELECT id,name FROM organizations WHERE id = ?",recipient.organization_id),backupAsset:"USDC",backupNetworks:BACKUP_NETWORKS});
});
recipientPortalRoutes.post("/:token/confirm",async(c)=>{
  const input=validateRoute(PreferenceInput.parse(await c.req.json())),userId=c.get("userId"),recipient=invitedRecipient(c.req.param("token"),userId);
  if(input.fallbackConsent && (!input.backupNetwork || !input.backupAddress)) throw new ApiError(400,"Choose a complete backup route before consenting to USDC fallback","BACKUP_INCOMPLETE");
  transaction((db)=>{
    const now=new Date().toISOString();
    const result=db.prepare("UPDATE recipients SET user_id = ?,primary_asset = ?,primary_network = ?,primary_address = ?,backup_network = ?,backup_address = ?,fallback_consent = ?,preference_status = 'confirmed',confirmed_at = ?,version = version + 1,updated_at = ? WHERE id = ? AND organization_id = ? AND version = ?")
      .run(userId,input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.backupNetwork??null,input.backupAddress??null,Number(input.fallbackConsent),now,now,recipient.id,recipient.organization_id,input.expectedVersion);
    if(!result.changes) throw new ApiError(409,"Your preferences changed. Refresh before confirming.","RECIPIENT_VERSION_CHANGED");
    saveVersion(getRecipient(recipient.organization_id,recipient.id),userId);
    audit(userId,recipient.organization_id,"recipient.preferences_confirmed",recipient.id,{version:input.expectedVersion+1,fallbackConsent:input.fallbackConsent});
  });
  return c.json({recipient:getRecipient(recipient.organization_id,recipient.id)});
});

import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext, type AppEnv } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "./crypto";
import { normalizeWallet } from "./auth";
import { appOrigin, audit, requireOrganization, requireUser } from "./session";
import { parseCsv } from "../../lib/csv";
import { getSupportedTokens, nativeUsdc, type Token } from "../payments/intents";
import { canonicalNetwork, DestinationError, normalizeDestination } from "../../lib/recipient-destination";

export interface RecipientRecord {
  id: string; organization_id: string; user_id: string | null; name: string; email: string | null; kind: string;
  primary_asset: string; primary_network: string; primary_address: string; primary_memo: string | null; backup_network: string | null; backup_address: string | null;
  fallback_consent: number; preference_status: string; version: number; confirmed_at: string | null; archived: number; created_at: string; updated_at: string;
}

const EVM_NETWORKS = new Set(["eth","base","arb","pol","op","avax","bsc","gnosis","aurora","bera","plasma","monad","xlayer","scroll","adi","hood","hlevm","hypercore"]);
const BACKUP_NETWORKS = ["base","arb","pol","eth","sol","near"] as const;
const ProfileInput = z.object({
  name: z.string().trim().min(1).max(120), email: z.email().max(254).nullable().optional(), kind: z.enum(["employee","contractor","business"]),
  primaryAsset: z.string().trim().min(1).max(240).default("USDC"), primaryNetwork: z.string().trim().min(2).max(80), primaryAddress: z.string().trim().min(2).max(200),
  primaryMemo: z.string().trim().max(120).nullable().optional(),
  backupMemo: z.string().trim().max(0,"USDC backup destinations cannot require a separate receiving memo. Use a personal wallet on an enabled backup network.").nullable().optional(),
  backupNetwork: z.preprocess((value)=>typeof value==="string"?canonicalNetwork(value):value,z.enum(BACKUP_NETWORKS).nullable().optional()), backupAddress: z.string().trim().min(2).max(200).nullable().optional(),
});
export const PreferenceInput = ProfileInput.pick({primaryAsset:true,primaryNetwork:true,primaryAddress:true,primaryMemo:true,backupMemo:true,backupNetwork:true,backupAddress:true}).extend({expectedVersion:z.number().int().positive(),fallbackConsent:z.boolean().default(false)});

function familyFor(network: string): string | undefined {
  if (EVM_NETWORKS.has(network)) return "evm";
  if (network === "sol" || network === "fogo") return "solana";
  if (network === "near") return "near";
}

function validateRoute<T extends {primaryAsset:string;primaryNetwork:string;primaryAddress:string;primaryMemo?:string|null;backupNetwork?:string|null;backupAddress?:string|null}>(input: T): T {
  input.primaryNetwork = canonicalNetwork(input.primaryNetwork);
  try {
    const destination = normalizeDestination(input.primaryNetwork,input.primaryAddress,input.primaryMemo);
    input.primaryAddress = destination.address; input.primaryMemo = destination.memo;
  } catch(error) { if(error instanceof DestinationError)throw new ApiError(400,error.message,error.code);throw error; }
  if (Boolean(input.backupNetwork)!==Boolean(input.backupAddress)) throw new ApiError(400,"Choose both the backup network and its receiving address","BACKUP_INCOMPLETE");
  if (input.backupNetwork && input.backupAddress) {
    input.backupAddress=normalizeWallet(familyFor(input.backupNetwork)!,input.backupAddress);
    if (input.primaryAsset.toUpperCase()==="USDC" && input.primaryNetwork===input.backupNetwork) throw new ApiError(400,"Choose another network for the native USDC backup when your primary is already native USDC","BACKUP_SAME_NETWORK");
  }
  return input;
}

function validateBackupAsset(input:{primaryAsset:string;primaryNetwork:string;backupNetwork?:string|null},tokens:Token[]|null) {
  if(input.primaryNetwork!==input.backupNetwork)return;
  const primary=tokens?.find(token=>token.assetId===input.primaryAsset&&token.blockchain===input.primaryNetwork);
  if(!primary)throw new ApiError(503,"The live catalog cannot identify your saved primary asset. Refresh the catalog or choose a different backup network.","BACKUP_IDENTITY_UNAVAILABLE");
  if(primary.symbol!=="USDC")return;
  let usdc:Token;
  try{usdc=nativeUsdc(tokens!,input.primaryNetwork);}catch{throw new ApiError(503,"Native USDC cannot be verified on this network. Refresh the catalog or choose a different backup network.","BACKUP_IDENTITY_UNAVAILABLE");}
  if(primary.assetId===usdc.assetId)throw new ApiError(400,"Choose another network for the native USDC backup when your primary is already native USDC","BACKUP_SAME_NETWORK");
}

export async function validateProfile<T extends {primaryAsset:string;primaryNetwork:string;primaryAddress:string;primaryMemo?:string|null;backupNetwork?:string|null;backupAddress?:string|null}>(input:T):Promise<T> {
  validateRoute(input);
  if(input.primaryNetwork===input.backupNetwork) {
    let tokens:Token[]|null=null;
    try{tokens=await getSupportedTokens();}catch{}
    validateBackupAsset(input,tokens);
  }
  return input;
}

function serialize(record: RecipientRecord): RecipientRecord {
  return {...record,name:decrypt(record.name),email:record.email?decrypt(record.email):null};
}

const RECIPIENT_COLUMNS = "id,organization_id,user_id,name,email,kind,primary_asset,primary_network,primary_address,primary_memo,backup_network,backup_address,fallback_consent,preference_status,version,confirmed_at,archived,created_at,updated_at";

export function getRecipient(orgId:string,id:string):RecipientRecord {
  const recipient=row<RecipientRecord>(`SELECT ${RECIPIENT_COLUMNS} FROM recipients WHERE organization_id = ? AND id = ?`,orgId,id);
  if(!recipient) throw new ApiError(404,"Recipient not found","RECIPIENT_NOT_FOUND");
  return serialize(recipient);
}

export function listRecipients(orgId:string):RecipientRecord[] {
  return rows<RecipientRecord>(`SELECT ${RECIPIENT_COLUMNS} FROM recipients WHERE organization_id = ? AND archived = 0 ORDER BY created_at DESC`,orgId).map(serialize);
}

export function getRecipientVersion(orgId:string,id:string,version:number):RecipientRecord|null {
  const saved=row<{profile_ciphertext:string}>("SELECT v.profile_ciphertext FROM recipient_versions v JOIN recipients r ON r.id=v.recipient_id WHERE r.organization_id=? AND v.recipient_id=? AND v.version=?",orgId,id,version);
  if(saved){
    const profile=JSON.parse(decrypt(saved.profile_ciphertext)) as RecipientRecord;
    return profile.organization_id===orgId&&profile.id===id&&profile.version===version?profile:null;
  }
  const current=row<{version:number}>("SELECT version FROM recipients WHERE organization_id=? AND id=?",orgId,id);
  return current?.version===version?getRecipient(orgId,id):null;
}

export function saveVersion(recipient:RecipientRecord,userId:string) {
  getDb().prepare("INSERT INTO recipient_versions (recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES (?,?,?,?,?)").run(recipient.id,recipient.version,encrypt(JSON.stringify(recipient)),userId,new Date().toISOString());
}

function importRecipientId(orgId:string,externalId:string):string {
  const bytes=createHash("sha256").update(JSON.stringify(["razor-recipient-import-v1",orgId,externalId])).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

interface ImportResult {row:number;externalId:string;status:"ready"|"created"|"existing"|"error";recipient?:RecipientRecord;invitationUrl?:string;error?:string;code?:string}

export function importRecipientCsv(access:AccessContext,csv:string,tokens:Token[]|null,dryRun=false) {
  requirePermission(access,"recipients:manage");
  let records:Record<string,string>[];
  try{records=parseCsv(csv);}catch(error){throw new ApiError(400,error instanceof Error?error.message:"Check the CSV format","CSV_INVALID");}
  if(records.length>250)throw new ApiError(400,"Import up to 250 payees at a time","CSV_TOO_LARGE");
  const required=["external_id","name","kind","primary_asset","primary_network","primary_address"];
  if(required.some(key=>!(key in records[0])))throw new ApiError(400,`CSV requires these columns: ${required.join(", ")}`,"CSV_COLUMNS_MISSING");
  const seen=new Set<string>();
  const results:ImportResult[]=records.map((record,index):ImportResult=>{
    const externalId=record.external_id;
    try {
      if(!externalId||externalId.length>120)throw new ApiError(400,"Use a stable external_id of 1 to 120 characters","EXTERNAL_ID_REQUIRED");
      if(seen.has(externalId))throw new ApiError(400,"This external_id appears more than once in the file","DUPLICATE_EXTERNAL_ID");
      seen.add(externalId);
      const input=validateRoute(ProfileInput.parse({name:record.name,email:record.email?.toLowerCase()||null,kind:record.kind,primaryAsset:record.primary_asset,primaryNetwork:record.primary_network,primaryAddress:record.primary_address,primaryMemo:record.primary_memo||null,backupMemo:record.backup_memo||null,backupNetwork:record.backup_network||null,backupAddress:record.backup_address||null}));
      const id=importRecipientId(access.organizationId,externalId);
      return transaction((db):ImportResult=>{
        if(row("SELECT id FROM recipients WHERE id = ? AND organization_id = ?",id,access.organizationId)) {
          const recipient=getRecipient(access.organizationId,id);
          if(recipient.archived)throw new ApiError(409,"This source key belongs to an archived payee. Existing history is preserved.","RECIPIENT_ARCHIVED");
          const original=row<{profile_ciphertext:string}>("SELECT profile_ciphertext FROM recipient_versions WHERE recipient_id = ? AND version = 1",id);
          const initial:RecipientRecord=original?JSON.parse(decrypt(original.profile_ciphertext)):recipient;
          if(initial.name!==input.name||initial.email!==(input.email||null)||initial.kind!==input.kind||initial.primary_asset!==input.primaryAsset||initial.primary_network!==input.primaryNetwork||initial.primary_address!==input.primaryAddress||(initial.primary_memo??null)!==(input.primaryMemo??null)||initial.backup_network!==(input.backupNetwork||null)||initial.backup_address!==(input.backupAddress||null))throw new ApiError(409,"This external_id was imported with different details. Edit the existing payee instead.","IMPORT_KEY_CONFLICT");
          return {row:index+2,externalId,status:"existing",recipient};
        }
        if(!tokens)throw new ApiError(503,"The live asset catalog is unavailable. Retry later; existing imported profiles are preserved.","CATALOG_UNAVAILABLE");
        validateBackupAsset(input,tokens);
        const asset=tokens.find(token=>token.assetId===input.primaryAsset);
        if(!asset||asset.blockchain!==input.primaryNetwork)throw new ApiError(400,"Choose a live catalog asset ID on its matching network","ASSET_UNSUPPORTED");
        if(dryRun)return {row:index+2,externalId,status:"ready"};
        const token=newToken(),now=new Date().toISOString();
        db.prepare("INSERT INTO recipients (id,organization_id,name,email,kind,primary_asset,primary_network,primary_address,primary_memo,backup_network,backup_address,invitation_token_hash,invitation_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id,access.organizationId,encrypt(input.name),input.email?encrypt(input.email):null,input.kind,input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.primaryMemo??null,input.backupNetwork??null,input.backupAddress??null,hashToken(token),new Date(Date.now()+7*86400000).toISOString(),now,now);
        const recipient=getRecipient(access.organizationId,id);
        saveVersion(recipient,access.userId);audit(access.userId,access.organizationId,"recipient.imported",id,{version:1});
        return {row:index+2,externalId,status:"created",recipient,invitationUrl:`${appOrigin()}/receive?token=${token}`};
      });
    }catch(error){
      if(error instanceof z.ZodError)return {row:index+2,externalId,status:"error",error:error.issues[0]?.message || "Check this row",code:"INVALID_PROFILE"};
      if(error instanceof ApiError)return {row:index+2,externalId,status:"error",error:error.message,code:error.code};
      throw error;
    }
  });
  return {dryRun,results,summary:{ready:results.filter(item=>item.status==="ready").length,created:results.filter(item=>item.status==="created").length,existing:results.filter(item=>item.status==="existing").length,errors:results.filter(item=>item.status==="error").length}};
}

export const recipientRoutes = new Hono<AppEnv>();
recipientRoutes.use("*",requireUser);
recipientRoutes.get("/:orgId/recipients",requireOrganization("recipients:read"),(c)=>c.json({recipients:listRecipients(c.req.param("orgId")),backupAsset:"USDC",backupNetworks:BACKUP_NETWORKS}));
recipientRoutes.post("/:orgId/recipients/import",requireOrganization("recipients:manage"),async(c)=>{
  const input=z.object({csv:z.string().min(1).max(500000),dryRun:z.boolean().default(false)}).parse(await c.req.json());
  let tokens:Token[]|null=null;
  try{tokens=await getSupportedTokens();}catch{}
  return c.json(importRecipientCsv(c.get("access"),input.csv,tokens,input.dryRun));
});

recipientRoutes.post("/:orgId/recipients",requireOrganization("recipients:manage"),async(c)=>{
  const input=await validateProfile(ProfileInput.parse(await c.req.json())),orgId=c.req.param("orgId"),id=randomUUID(),token=newToken(),now=new Date().toISOString();
  transaction((db)=>{
    db.prepare("INSERT INTO recipients (id,organization_id,name,email,kind,primary_asset,primary_network,primary_address,primary_memo,backup_network,backup_address,invitation_token_hash,invitation_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,orgId,encrypt(input.name),input.email?encrypt(input.email.toLowerCase()):null,input.kind,input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.primaryMemo??null,input.backupNetwork??null,input.backupAddress??null,hashToken(token),new Date(Date.now()+7*86400000).toISOString(),now,now);
    saveVersion(getRecipient(orgId,id),c.get("userId"));
    audit(c.get("userId"),orgId,"recipient.created",id,{version:1});
  });
  return c.json({recipient:getRecipient(orgId,id),invitationUrl:`${appOrigin()}/receive?token=${token}`,delivery:"copy_link"},201);
});

recipientRoutes.get("/:orgId/recipients/:recipientId",requireOrganization("recipients:read"),(c)=>c.json({recipient:getRecipient(c.req.param("orgId"),c.req.param("recipientId"))}));

recipientRoutes.patch("/:orgId/recipients/:recipientId",requireOrganization("recipients:manage"),async(c)=>{
  const input=await validateProfile(ProfileInput.extend({expectedVersion:z.number().int().positive()}).parse(await c.req.json())),orgId=c.req.param("orgId"),id=c.req.param("recipientId");
  transaction((db)=>{
    const existing=getRecipient(orgId,id);
    if(existing.archived) throw new ApiError(409,"This recipient has been archived","RECIPIENT_ARCHIVED");
    if(existing.version!==input.expectedVersion) throw new ApiError(409,"This recipient changed. Refresh before saving.","RECIPIENT_VERSION_CHANGED");
    const email=input.email?.toLowerCase() || null;
    const identityChanged=existing.email!==email;
    db.prepare("UPDATE recipients SET name = ?,email = ?,kind = ?,primary_asset = ?,primary_network = ?,primary_address = ?,primary_memo = ?,backup_network = ?,backup_address = ?,fallback_consent = 0,preference_status = 'pending_confirmation',confirmed_at = NULL,user_id = CASE WHEN ? THEN NULL ELSE user_id END,version = version + 1,updated_at = ? WHERE id = ? AND organization_id = ? AND version = ?")
      .run(encrypt(input.name),email?encrypt(email):null,input.kind,input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.primaryMemo??null,input.backupNetwork??null,input.backupAddress??null,Number(identityChanged),new Date().toISOString(),id,orgId,input.expectedVersion);
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
  if(recipient.user_id)throw new ApiError(403,"This profile is already linked to another Razor account. Sign in with that account to manage its preferences.","RECIPIENT_ACCOUNT_MISMATCH");
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
recipientPortalRoutes.get("/:token/payments",async(c)=>{
  const userId=c.get("userId"),recipient=invitedRecipient(c.req.param("token"),userId);
  if(!row("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'payments'")) throw new ApiError(503,"Payment history is not configured yet. Your saved payout preferences remain available.","PAYMENT_HISTORY_SETUP_REQUIRED");
  if(recipient.user_id!==userId)return c.json({payments:[],amountAsset:"USDC",amountDecimals:6});
  const {ownPayments}=await import("../recipient-workspace/service");
  const payments=ownPayments(userId,recipient.id).slice(0,100).map(payment=>{
    const attempt=payment.attempts.at(-1),updatedAt=row<{updated_at:string}>("SELECT updated_at FROM payments WHERE id=? AND organization_id=?",payment.id,recipient.organization_id)?.updated_at;
    return {id:payment.id,kind:payment.kind,reference:payment.reference,amount:payment.amount,status:payment.status,scheduled_for:payment.scheduled_for,created_at:payment.created_at,updated_at:updatedAt,destination_asset:attempt?.destination_asset??null,destination_network:attempt?.destination_network??null,destination_address:attempt?.destination_address??null,destination_memo:attempt?.destination_memo??null,destination_tx_hash:attempt?.destination_tx_hash??null,route_status:attempt?.state??null};
  });
  return c.json({payments,amountAsset:"USDC",amountDecimals:6});
});

recipientPortalRoutes.post("/:token/confirm",async(c)=>{
  const input=await validateProfile(PreferenceInput.parse(await c.req.json())),userId=c.get("userId"),recipient=invitedRecipient(c.req.param("token"),userId);
  if(input.fallbackConsent && (!input.backupNetwork || !input.backupAddress)) throw new ApiError(400,"Choose a complete backup route before consenting to USDC fallback","BACKUP_INCOMPLETE");
  transaction((db)=>{
    const now=new Date().toISOString();
    const result=db.prepare("UPDATE recipients SET user_id = ?,primary_asset = ?,primary_network = ?,primary_address = ?,primary_memo = ?,backup_network = ?,backup_address = ?,fallback_consent = ?,preference_status = 'confirmed',confirmed_at = ?,version = version + 1,updated_at = ? WHERE id = ? AND organization_id = ? AND version = ? AND archived=0 AND (user_id IS NULL OR user_id=?)")
      .run(userId,input.primaryAsset,input.primaryNetwork,input.primaryAddress,input.primaryMemo??null,input.backupNetwork??null,input.backupAddress??null,Number(input.fallbackConsent),now,now,recipient.id,recipient.organization_id,input.expectedVersion,userId);
    if(!result.changes) throw new ApiError(409,"Your preferences changed. Refresh before confirming.","RECIPIENT_VERSION_CHANGED");
    saveVersion(getRecipient(recipient.organization_id,recipient.id),userId);
    audit(userId,recipient.organization_id,"recipient.preferences_confirmed",recipient.id,{version:input.expectedVersion+1,fallbackConsent:input.fallbackConsent});
  });
  return c.json({recipient:getRecipient(recipient.organization_id,recipient.id)});
});

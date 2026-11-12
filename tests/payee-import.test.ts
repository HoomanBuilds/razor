import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { importRecipientCsv, recipientPortalRoutes } from "../src/server/identity/recipients";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { encrypt, hashToken } from "../src/server/identity/crypto";
import type { Token } from "../src/server/payments/intents";
import { NATIVE_USDC } from "../src/server/payments/policy";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="72".repeat(32);
process.env.APP_URL="http://localhost:3000";
const now=new Date().toISOString(),db=getDb(),access:AccessContext={userId:"import-owner",organizationId:"import-company",permissions:["recipients:manage"]};
db.prepare("INSERT INTO users (id,name,email,created_at) VALUES (?,?,?,?)").run(access.userId,"Owner","owner@example.test",now);
db.prepare("INSERT INTO organizations (id,name,owner_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(access.organizationId,"Company",access.userId,now,now);
const token:Token={assetId:`nep141:${NATIVE_USDC.near}`,symbol:"USDC",decimals:6,blockchain:"near",contractAddress:NATIVE_USDC.near};
const header="external_id,name,email,kind,primary_asset,primary_network,primary_address,backup_network,backup_address";
const csv=`${header}\nemp-1,"Payee, One",payee@example.test,employee,${token.assetId},near,payee.near,base,0x1111111111111111111111111111111111111111`;

test("recipient imports retry without duplicates or clearing later confirmation",()=>{
  const preview=importRecipientCsv(access,csv,[token],true);
  assert.equal(preview.summary.ready,1);
  assert.equal(row<{count:number}>("SELECT count(*) AS count FROM recipients")!.count,0);
  const first=importRecipientCsv(access,csv,[token]);
  assert.equal(first.summary.created,1);assert.ok(first.results[0].invitationUrl);
  const recipient=first.results[0].recipient!;
  assert.equal(recipient.fallback_consent,0);assert.equal(recipient.preference_status,"pending_confirmation");
  db.prepare("UPDATE recipients SET version = 2,name = ?,fallback_consent = 1,preference_status = 'confirmed',confirmed_at = ? WHERE id = ?").run(encrypt("Updated by recipient"),now,recipient.id);
  const retry=importRecipientCsv(access,csv,null);
  assert.equal(retry.summary.existing,1);assert.equal(retry.results[0].invitationUrl,undefined);
  assert.equal(retry.results[0].recipient!.name,"Updated by recipient");assert.equal(retry.results[0].recipient!.fallback_consent,1);
  assert.equal(row<{count:number}>("SELECT count(*) AS count FROM recipients")!.count,1);
});

test("import reports invalid rows and distinguishes catalog outage from an unsupported asset",()=>{
  const bad=`${header}\nbad,Someone,,unknown,${token.assetId},near,payee.near,,`;
  assert.equal(importRecipientCsv(access,bad,[token]).results[0].code,"INVALID_PROFILE");
  const fresh=csv.replace("emp-1","emp-2");
  assert.equal(importRecipientCsv(access,fresh,null).results[0].code,"CATALOG_UNAVAILABLE");
  assert.equal(importRecipientCsv(access,fresh,[]).results[0].code,"ASSET_UNSUPPORTED");
});

test("recipient confirmation refuses a full asset ID with a backup on the same primary network",async()=>{
  const recipient=importRecipientCsv(access,csv.replace("emp-1","emp-3"),[token]).results[0].recipient!;
  const invitationToken="confirmation-token-for-same-network-check";
  db.prepare("UPDATE recipients SET email = ?,invitation_token_hash = ?,invitation_expires_at = ? WHERE id = ?").run(encrypt("owner@example.test"),hashToken(invitationToken),new Date(Date.now()+60000).toISOString(),recipient.id);
  const sessionToken="verified-session-for-confirmation-check";
  db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").run("test-session",access.userId,hashToken(sessionToken),new Date(Date.now()+60000).toISOString(),now);
  const app=new Hono<AppEnv>().route("/",recipientPortalRoutes);
  app.onError((error,c)=>{if(error instanceof ApiError)return c.json({code:error.code},error.status as 400);throw error;});
  const original=globalThis.fetch,other:Token={...token,assetId:"nep141:other-token.near",symbol:"OTHER",contractAddress:"other-token.near"};
  globalThis.fetch=async()=>Response.json([token,other]);
  try {
    const request=(assetId:string)=>app.request(`http://localhost:3000/${invitationToken}/confirm`,{method:"POST",headers:{Origin:"http://localhost:3000",Cookie:`float_session=${sessionToken}`,"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:1,primaryAsset:assetId,primaryNetwork:"near",primaryAddress:"payee.near",backupNetwork:"near",backupAddress:"backup.near",fallbackConsent:true})});
    const response=await request(token.assetId);
    assert.equal(response.status,400);assert.equal((await response.json()).code,"BACKUP_SAME_NETWORK");
    assert.equal((await request(other.assetId)).status,200);
  }finally{globalThis.fetch=original;}
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv, type AccessContext } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { decrypt, hashToken, newToken } from "../src/server/identity/crypto";
import { recipientRoutes, recipientPortalRoutes, importRecipientCsv } from "../src/server/identity/recipients";
import { dispatchRecipientInvitations, ensureRecipientInvitation, getRecipientInvitation, queueRecipientInvitation } from "../src/server/identity/recipient-invitations";
import { ownProfiles } from "../src/server/recipient-workspace/service";
import { approvePayment, createPayment } from "../src/server/payments/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "61".repeat(32);
process.env.APP_URL = "http://localhost:3000";
const app = new Hono<AppEnv>().route("/organizations",recipientRoutes).route("/portal",recipientPortalRoutes);
app.onError((error,c) => { if(error instanceof ApiError)return c.json({code:error.code},error.status as 400);if(error instanceof z.ZodError)return c.json({code:"INVALID_INPUT"},400);throw error; });
function person(email?:string) {
  const id=randomUUID(),token=newToken(),at=new Date().toISOString(),db=getDb();
  db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,'Fixture user',?,?)").run(id,email??null,at);
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),id,hashToken(token),new Date(Date.now()+3600_000).toISOString(),at);
  return {id,cookie:`razor_session=${token}`};
}
function fixture() {
  const owner=person(),manager=person(),viewer=person(),stranger=person(),organizationId=randomUUID(),role=randomUUID(),readRole=randomUUID(),at=new Date().toISOString(),db=getDb();
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Example Co',?,?,?)").run(organizationId,owner.id,at,at);
  const permissions=["company:read","recipients:manage","recipients:read","payments:prepare","payments:approve","payments:read"];
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,created_at) VALUES(?,?,'Manager',?,?)").run(role,organizationId,JSON.stringify(permissions),at);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,created_at) VALUES(?,?,'Viewer',?,?)").run(readRole,organizationId,JSON.stringify(["recipients:read"]),at);
  for(const user of [owner,manager,viewer])db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(organizationId,user.id,user===viewer?readRole:role,at);
  const access:AccessContext={organizationId,userId:owner.id,permissions};
  return {owner,manager,viewer,stranger,organizationId,access,base:`/organizations/${organizationId}/recipients`,db};
}
function request(path:string,user:{cookie:string},body?:unknown,method=body===undefined?"GET":"POST") {
  return app.request(`http://localhost:3000${path}`,{method,headers:{Origin:"http://localhost:3000",Cookie:user.cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
}
async function create(f:ReturnType<typeof fixture>,email=`${randomUUID()}@example.test`) {
  const response=await request(f.base,f.owner,{name:"Maya",email,kind:"employee"});assert.equal(response.status,201);
  return await response.json();
}

test("email-first invitations are encrypted, reusable, tenant scoped and cannot approve payments before confirmation",async()=>{
  const f=fixture(),email=`${randomUUID()}@example.test`,created=await create(f,email),id=created.recipient.id;
  assert.equal(created.recipient.primary_address,"");assert.equal(created.recipient.primary_network,"");assert.equal(created.recipient.preference_status,"pending_confirmation");
  const token=new URL(created.invitationUrl).searchParams.get("token")!,stored=row<{invitation_token_ciphertext:string;invitation_token_hash:string}>("SELECT invitation_token_ciphertext,invitation_token_hash FROM recipients WHERE id=?",id)!;
  assert.notEqual(stored.invitation_token_ciphertext,token);assert.equal(decrypt(stored.invitation_token_ciphertext),token);assert.equal(stored.invitation_token_hash,hashToken(token));
  for(const user of [f.owner,f.manager])assert.equal((await(await request(`${f.base}/${id}/invite`,user)).json()).invitationUrl,created.invitationUrl);
  assert.equal((await(await request(`${f.base}/${id}/invite`,f.owner,{})).json()).invitationUrl,created.invitationUrl);
  assert.equal((await request(`${f.base}/${id}/invite`,f.viewer)).status,403);
  assert.equal((await request(`${f.base}/${id}/invite`,f.stranger)).status,403);
  const other=fixture();assert.equal((await request(`${other.base}/${id}/invite`,other.owner)).status,404);
  assert.equal((await request(`/portal/${token}`,person("different@example.test"))).status,403);
  const receiver=person(email);assert.equal((await request(`/portal/${token}`,receiver)).status,200);
  const payment=createPayment(f.access,{recipientId:id,reference:"Draft salary",amount:"1000000"});
  assert.throws(()=>approvePayment(f.access,payment.id),error=>error instanceof ApiError && error.code==="RECIPIENT_CONFIRMATION_REQUIRED");
  assert.equal((await request(`/portal/${token}/confirm`,receiver,{expectedVersion:1,primaryNetwork:"base",primaryAddress:"",primaryAsset:"USDC"})).status,400);
  const confirmed=await request(`/portal/${token}/confirm`,receiver,{expectedVersion:1,primaryNetwork:"base",primaryAddress:"0x1111111111111111111111111111111111111111",primaryAsset:"USDC",fallbackConsent:false});
  assert.equal(confirmed.status,200);assert.equal((await confirmed.json()).recipientId,id);
  assert.equal((await request(`/portal/${token}`,receiver)).status,404);
  assert.equal((await request(`/portal/${token}/confirm`,receiver,{expectedVersion:2,primaryAsset:"USDC",primaryNetwork:"base",primaryAddress:"0x1111111111111111111111111111111111111111"})).status,404);
  assert.equal(getRecipientInvitation(f.access,id).status,"confirmed");assert.equal(getRecipientInvitation(f.access,id).invitationUrl,null);
  assert.equal(ownProfiles(receiver.id)[0].recipient.id,id);
  assert.equal(row<{state:string}>("SELECT state FROM recipient_invitation_outbox WHERE recipient_id=?",id)!.state,"cancelled");
});

test("expiry, legacy links, profile edits and archive revoke old invitation authority",async()=>{
  const f=fixture(),created=await create(f),id=created.recipient.id,token=new URL(created.invitationUrl).searchParams.get("token")!;
  f.db.prepare("UPDATE recipients SET invitation_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  assert.equal(getRecipientInvitation(f.access,id).status,"expired");
  const renewed=ensureRecipientInvitation(f.access,id);assert.notEqual(renewed.invitationUrl,created.invitationUrl);assert.equal(ensureRecipientInvitation(f.access,id).invitationUrl,renewed.invitationUrl);
  f.db.prepare("UPDATE recipients SET invitation_token_ciphertext=NULL WHERE id=?").run(id);
  const migrated=ensureRecipientInvitation(f.access,id);assert.notEqual(migrated.invitationUrl,renewed.invitationUrl);assert.equal(ensureRecipientInvitation(f.access,id).invitationUrl,migrated.invitationUrl);
  const response=await request(`${f.base}/${id}`,f.owner,{name:"Corrected",email:"new@example.test",kind:"employee",expectedVersion:1,primaryAsset:"",primaryNetwork:"",primaryAddress:""},"PATCH");assert.equal(response.status,200);
  assert.equal(getRecipientInvitation(f.access,id).invitationUrl,null);
  assert.equal((await request(`/portal/${token}`,person("new@example.test"))).status,404);
  const replacement=ensureRecipientInvitation(f.access,id);assert.notEqual(replacement.invitationUrl,migrated.invitationUrl);
  assert.equal((await request(`${f.base}/${id}`,f.owner,undefined,"DELETE")).status,200);
  assert.equal(getRecipientInvitation(f.access,id).status,"unavailable");
  assert.throws(()=>ensureRecipientInvitation(f.access,id),error=>error instanceof ApiError && error.code==="RECIPIENT_ARCHIVED");
});

test("email-only CSV imports preserve row idempotency and expose the stable pending invitation",()=>{
  const f=fixture(),csv="external_id,name,email,kind\nteam-1,Maya,maya@example.test,employee";
  const first=importRecipientCsv(f.access,csv,null),second=importRecipientCsv(f.access,csv,null);
  assert.equal(first.summary.created,1);assert.equal(second.summary.existing,1);assert.equal(second.results[0].invitationUrl,first.results[0].invitationUrl);
  assert.equal(rows("SELECT id FROM recipient_invitation_outbox WHERE organization_id=?",f.organizationId).length,1);
  assert.equal(importRecipientCsv(f.access,"external_id,name,kind\nteam-2,Unknown,employee",null).results[0].code,"RECIPIENT_EMAIL_REQUIRED");
});

test("transactional invite outbox works for unregistered recipients, retries one exact payload and cancels lost authority",async()=>{
  const f=fixture(),originalFetch=globalThis.fetch,previousKey=process.env.RESEND_API_KEY,previousSender=process.env.NOTIFICATION_FROM_EMAIL;
  process.env.RESEND_API_KEY="fixture-key";process.env.NOTIFICATION_FROM_EMAIL="Razor <notifications@example.test>";
  const requests:{key:string;body:string}[]=[];
  globalThis.fetch=async(_input,init)=>{requests.push({key:new Headers(init?.headers).get("Idempotency-Key")!,body:String(init?.body)});if(requests.length===1)throw new Error("ambiguous timeout");return Response.json({id:"fixture-provider-message"});};
  try {
    const created=await create(f,"unregistered@example.test"),id=created.recipient.id;
    assert.equal(row("SELECT id FROM users WHERE email='unregistered@example.test'"),undefined);
    assert.equal((await dispatchRecipientInvitations(f.organizationId,1)).accepted,0);
    f.db.prepare("UPDATE recipient_invitation_outbox SET next_attempt_at=? WHERE recipient_id=?").run(new Date(Date.now()-1000).toISOString(),id);
    assert.equal((await dispatchRecipientInvitations(f.organizationId,1)).accepted,1);
    assert.deepEqual(requests[0],requests[1]);assert(JSON.parse(requests[0].body).text.includes(created.invitationUrl));
    assert.equal(getRecipientInvitation(f.access,id).email.state,"accepted");
    assert.throws(()=>queueRecipientInvitation(f.access,id,randomUUID()),error=>error instanceof ApiError && error.code==="INVITATION_EMAIL_COOLDOWN");
    f.db.prepare("UPDATE recipient_invitation_outbox SET created_at=? WHERE recipient_id=?").run(new Date(Date.now()-61000).toISOString(),id);
    const key=randomUUID();queueRecipientInvitation(f.access,id,key);queueRecipientInvitation(f.access,id,key);
    assert.equal(rows("SELECT id FROM recipient_invitation_outbox WHERE recipient_id=?",id).length,2);
    f.db.prepare("UPDATE memberships SET status='removed' WHERE organization_id=? AND user_id=?").run(f.organizationId,f.owner.id);
    assert.equal((await dispatchRecipientInvitations(f.organizationId,1)).accepted,0);assert.equal(requests.length,2);
    assert.equal(getRecipientInvitation(f.access,id).email.state,"cancelled");
  } finally {globalThis.fetch=originalFetch;if(previousKey===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=previousKey;if(previousSender===undefined)delete process.env.NOTIFICATION_FROM_EMAIL;else process.env.NOTIFICATION_FROM_EMAIL=previousSender;}
});

test("production shared sender is unavailable and cannot dispatch invitation email",async()=>{
  const f=fixture(),previous={url:process.env.APP_URL,key:process.env.RESEND_API_KEY,sender:process.env.NOTIFICATION_FROM_EMAIL},originalFetch=globalThis.fetch;
  try {
    process.env.APP_URL="https://razorfi.xyz";process.env.RESEND_API_KEY="fixture-key";process.env.NOTIFICATION_FROM_EMAIL="Razor <onboarding@resend.dev>";
    const csv="external_id,name,email,kind\nrestricted,Maya,maya@example.test,employee",created=importRecipientCsv(f.access,csv,null).results[0];
    assert.equal(created.invitation?.email.configured,false);assert.equal(created.invitation?.email.state,"unavailable");assert.ok(created.invitationUrl);
    globalThis.fetch=async()=>{throw new Error("Unexpected provider request");};
    assert.deepEqual(await dispatchRecipientInvitations(f.organizationId),{configured:false,accepted:0});
    assert.equal(row<{attempts:number}>("SELECT attempts FROM recipient_invitation_outbox WHERE recipient_id=?",created.recipient!.id)!.attempts,0);
  } finally {globalThis.fetch=originalFetch;for(const [key,value] of Object.entries({APP_URL:previous.url,RESEND_API_KEY:previous.key,NOTIFICATION_FROM_EMAIL:previous.sender})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

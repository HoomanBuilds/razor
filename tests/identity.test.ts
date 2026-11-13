import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ZodError } from "zod";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { identityRoutes } from "../src/server/identity/index";
import { ApiError, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="71".repeat(32);
process.env.APP_URL="http://localhost:3000";

const app=new Hono<AppEnv>().route("/api",identityRoutes);
app.onError((error,c)=>{
  if(error instanceof ApiError)return c.json({error:{code:error.code,message:error.message}},error.status as 400);
  if(error instanceof ZodError)return c.json({error:{message:error.message}},400);
  throw error;
});

async function request(path:string,body?:unknown,cookie?:string,method=body===undefined?"GET":"POST") {
  return app.request(`http://localhost:3000/api${path}`,{method,headers:{Origin:"http://localhost:3000",...(body===undefined?{}:{"Content-Type":"application/json"}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
}

async function signIn() {
  const account=privateKeyToAccount(generatePrivateKey());
  const challenge=await(await request("/auth/challenge",{family:"evm",address:account.address})).json();
  const signature=await account.signMessage({message:challenge.message});
  const response=await request("/auth/wallet",{challengeId:challenge.challengeId,signature});
  assert.equal(response.status,200);
  const cookie=response.headers.get("set-cookie")!.split(";")[0];
  assert.match(response.headers.get("set-cookie")!,/HttpOnly/i);
  return {account,cookie,challenge,signature};
}

test("wallet proofs are origin-bound, reject forged signatures and cannot replay",async()=>{
  const denied=await app.request("http://localhost:3000/api/auth/challenge",{method:"POST",headers:{Origin:"https://other.example","Content-Type":"application/json"},body:JSON.stringify({family:"evm",address:privateKeyToAccount(generatePrivateKey()).address})});
  assert.equal(denied.status,403);
  const signed=await signIn();
  assert.equal((await request("/auth/wallet",{challengeId:signed.challenge.challengeId,signature:signed.signature})).status,401);
  const challenge=await(await request("/auth/challenge",{family:"evm",address:signed.account.address})).json();
  const other=privateKeyToAccount(generatePrivateKey());
  const forged=await other.signMessage({message:challenge.message});
  assert.equal((await request("/auth/wallet",{challengeId:challenge.challengeId,signature:forged})).status,401);
  getDb().prepare("UPDATE auth_challenges SET expires_at = ? WHERE id = ?").run(new Date(Date.now()-1000).toISOString(),challenge.challengeId);
  assert.equal((await request("/auth/wallet",{challengeId:challenge.challengeId,signature:await signed.account.signMessage({message:challenge.message})})).status,401);
  const session=await(await request("/auth/session",undefined,signed.cookie)).json();
  assert.equal(session.wallets[0].address,signed.account.address.toLowerCase());
  const canonical=await(await request("/auth/challenge",{family:"evm",address:signed.account.address,network:"base"})).json();
  assert.equal(canonical.network,"evm");
  getDb().prepare("UPDATE sessions SET created_at=? WHERE user_id=?").run(new Date(Date.now()-2*3600000).toISOString(),session.user.id);
  assert.equal((await request("/auth/challenge",{family:"evm",address:signed.account.address,purpose:"link"},signed.cookie)).status,403);
});

test("social login requires configured verification keys and accepts only correctly scoped signed JWTs",async()=>{
  const previous={id:process.env.PRIVY_APP_ID,key:process.env.PRIVY_VERIFICATION_KEY,jwks:process.env.PRIVY_JWKS_URL,secret:process.env.PRIVY_APP_SECRET};
  delete process.env.PRIVY_APP_SECRET;
  delete process.env.PRIVY_JWKS_URL;
  delete process.env.PRIVY_VERIFICATION_KEY;
  process.env.PRIVY_APP_ID="test-razor-app";
  try {
    assert.equal((await request("/auth/privy",{accessToken:"unverified-token-not-accepted"})).status,503);
    const {publicKey,privateKey}=await generateKeyPair("ES256");
    process.env.PRIVY_VERIFICATION_KEY=await exportSPKI(publicKey);
    const valid=await new SignJWT({}).setProtectedHeader({alg:"ES256"}).setSubject("did:privy:test-user").setIssuer("privy.io").setAudience("test-razor-app").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const signed=await request("/auth/privy",{accessToken:valid});
    assert.equal(signed.status,200);
    assert.match(signed.headers.get("set-cookie")!,/HttpOnly/i);
    const wrong=await new SignJWT({}).setProtectedHeader({alg:"ES256"}).setSubject("did:privy:test-user").setIssuer("privy.io").setAudience("other-app").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    assert.equal((await request("/auth/privy",{accessToken:wrong})).status,401);
  } finally {
    for(const [key,value] of Object.entries({PRIVY_APP_ID:previous.id,PRIVY_VERIFICATION_KEY:previous.key,PRIVY_JWKS_URL:previous.jwks,PRIVY_APP_SECRET:previous.secret})) {if(value===undefined) delete process.env[key];else process.env[key]=value;}
  }
});

test("companies remain isolated and owner authority is preserved",async()=>{
  const owner=await signIn(),stranger=await signIn();
  const created=await request("/organizations",{name:"Acme",timezone:"Asia/Kolkata"},owner.cookie);
  assert.equal(created.status,201);
  const {organization}=await created.json();
  assert.equal((await request(`/organizations/${organization.id}`,undefined,stranger.cookie)).status,403);
  const {roles}=await(await request(`/organizations/${organization.id}/roles`,undefined,owner.cookie)).json();
  assert.equal((await request(`/organizations/${organization.id}/roles/${roles.find((role:{is_owner:number})=>role.is_owner).id}`,{name:"Reduced owner",permissions:[]},owner.cookie,"PATCH")).status,409);
  const {permissions}=await(await request("/auth/session",undefined,owner.cookie)).json();
  assert.ok(permissions.includes("payments:execute"));
});

test("recipient fallback requires recipient proof and confirmation, then resets on payer edits",async()=>{
  const payer=await signIn(),receiver=await signIn(),stranger=await signIn();
  const {organization}=await(await request("/organizations",{name:"Payroll Co"},payer.cookie)).json();
  const profile={name:"Private Recipient",kind:"employee",primaryAsset:"USDC",primaryNetwork:"polygon",primaryAddress:receiver.account.address,backupNetwork:"base",backupAddress:receiver.account.address};
  const created=await request(`/organizations/${organization.id}/recipients`,profile,payer.cookie);
  assert.equal(created.status,201);
  const {recipient,invitationUrl}=await created.json(),token=new URL(invitationUrl).searchParams.get("token");
  assert.equal(recipient.preference_status,"pending_confirmation");
  assert.equal(recipient.fallback_consent,0);
  assert.notEqual(row<{name:string}>("SELECT name FROM recipients WHERE id = ?",recipient.id)!.name,profile.name);
  assert.equal((await request(`/recipient-portal/${token}`,undefined,stranger.cookie)).status,403);
  const confirmed=await request(`/recipient-portal/${token}/confirm`,{...profile,expectedVersion:1,fallbackConsent:true},receiver.cookie);
  assert.equal(confirmed.status,200);
  const confirmedRecipient=(await confirmed.json()).recipient;
  assert.equal(confirmedRecipient.fallback_consent,1);
  assert.equal(confirmedRecipient.preference_status,"confirmed");
  assert.equal(confirmedRecipient.version,2);
  assert.equal((await request(`/recipient-portal/${token}/confirm`,{...profile,expectedVersion:1,fallbackConsent:true},receiver.cookie)).status,409);
  const changed=await request(`/organizations/${organization.id}/recipients/${recipient.id}`,{...profile,name:"Updated Recipient",expectedVersion:2},payer.cookie,"PATCH");
  assert.equal(changed.status,200);
  const updated=(await changed.json()).recipient;
  assert.equal(updated.fallback_consent,0);
  assert.equal(updated.preference_status,"pending_confirmation");
  assert.equal(updated.version,3);
  const versions=await(await request(`/organizations/${organization.id}/recipients/${recipient.id}/versions`,undefined,payer.cookie)).json();
  assert.equal(versions.versions.length,3);
});

test("wallet-targeted invitations require verified ownership and retries cannot change or restore membership",async()=>{
  const owner=await signIn(),member=await signIn(),stranger=await signIn();
  const {organization}=await(await request("/organizations",{name:"Wallet team"},owner.cookie)).json();
  const {roles}=await(await request(`/organizations/${organization.id}/roles`,undefined,owner.cookie)).json();
  const viewer=roles.find((role:{name:string})=>role.name==="Viewer"),operator=roles.find((role:{name:string})=>role.name==="Operator");
  const created=await request(`/organizations/${organization.id}/invitations`,{wallet:{family:"evm",address:member.account.address,network:"base"},roleId:viewer.id},owner.cookie);
  assert.equal(created.status,201);
  const invitation=await created.json(),token=new URL(invitation.invitationUrl).searchParams.get("token")!;
  assert.equal(invitation.invitation.wallet.network,"evm");
  assert.equal((await(await request(`/invitations/${token}`,undefined,stranger.cookie)).json()).canAccept,false);
  assert.equal((await request("/invitations/accept",{token},stranger.cookie)).status,403);
  assert.equal((await(await request(`/invitations/${token}`,undefined,member.cookie)).json()).canAccept,true);
  assert.equal((await request("/invitations/accept",{token},member.cookie)).status,200);
  assert.equal((await request("/invitations/accept",{token},member.cookie)).status,200);
  const memberId=(await(await request("/auth/session",undefined,member.cookie)).json()).user.id;
  await request(`/organizations/${organization.id}/members/${memberId}`,{roleId:operator.id},owner.cookie,"PATCH");
  assert.equal((await request("/invitations/accept",{token},member.cookie)).status,200);
  assert.equal(row<{role_id:string}>("SELECT role_id FROM memberships WHERE organization_id=? AND user_id=?",organization.id,memberId)!.role_id,operator.id);
  await request(`/organizations/${organization.id}/members/${memberId}`,undefined,owner.cookie,"DELETE");
  assert.equal((await request("/invitations/accept",{token},member.cookie)).status,409);
  assert.equal((await request(`/organizations/${organization.id}`,undefined,member.cookie)).status,403);
  const next=await(await request(`/organizations/${organization.id}/invitations`,{wallet:{family:"evm",address:member.account.address},roleId:viewer.id},owner.cookie)).json();
  const nextToken=new URL(next.invitationUrl).searchParams.get("token");
  await request(`/organizations/${organization.id}/invitations/${next.invitation.id}`,undefined,owner.cookie,"DELETE");
  assert.equal((await request("/invitations/accept",{token:nextToken},member.cookie)).status,404);
  const expired=await(await request(`/organizations/${organization.id}/invitations`,{wallet:{family:"evm",address:member.account.address},roleId:viewer.id},owner.cookie)).json();
  getDb().prepare("UPDATE organization_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.invitation.id);
  assert.equal((await request("/invitations/accept",{token:new URL(expired.invitationUrl).searchParams.get("token")},member.cookie)).status,404);
});

test("custom roles require usable permission dependencies and can be archived without deleting access history",async()=>{
  const owner=await signIn(),member=await signIn();
  const {organization}=await(await request("/organizations",{name:"Role lifecycle"},owner.cookie)).json(),base=`/organizations/${organization.id}`;
  assert.equal((await request(`${base}/roles`,{name:"No workspace",permissions:["payments:read"]},owner.cookie)).status,422);
  assert.equal((await request(`${base}/roles`,{name:"Cannot prepare",permissions:["company:read","payments:prepare"]},owner.cookie)).status,422);
  const role=(await(await request(`${base}/roles`,{name:"Temporary viewer",permissions:["company:read","payments:read"]},owner.cookie)).json()).role;
  const invite=await(await request(`${base}/invitations`,{wallet:{family:"evm",address:member.account.address},roleId:role.id},owner.cookie)).json();
  assert.equal((await request(`${base}/roles/${role.id}`,undefined,owner.cookie,"DELETE")).status,409);
  const token=new URL(invite.invitationUrl).searchParams.get("token");
  await request("/invitations/accept",{token},member.cookie);
  const memberId=(await(await request("/auth/session",undefined,member.cookie)).json()).user.id;
  await request(`${base}/members/${memberId}`,undefined,owner.cookie,"DELETE");
  assert.equal((await request(`${base}/roles/${role.id}`,undefined,owner.cookie,"DELETE")).status,200);
  const catalog=await(await request(`${base}/roles`,undefined,owner.cookie)).json();
  assert.ok(!catalog.roles.some((entry:{id:string})=>entry.id===role.id));
  assert.ok(catalog.archivedRoles.some((entry:{id:string})=>entry.id===role.id));
  assert.equal(row<{status:string}>("SELECT status FROM memberships WHERE organization_id=? AND user_id=?",organization.id,memberId)!.status,"removed");
  assert.equal((await request(`${base}/roles/${role.id}/restore`,{name:role.name,permissions:role.permissions},owner.cookie)).status,200);
  assert.equal((await request("/invitations/accept",{token},member.cookie)).status,409);
  assert.equal((await request(`${base}`,undefined,member.cookie)).status,403);
});

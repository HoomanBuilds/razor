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
});

test("social login requires configured verification keys and accepts only correctly scoped signed JWTs",async()=>{
  const previous={id:process.env.PRIVY_APP_ID,key:process.env.PRIVY_VERIFICATION_KEY,jwks:process.env.PRIVY_JWKS_URL,secret:process.env.PRIVY_APP_SECRET};
  delete process.env.PRIVY_APP_SECRET;
  delete process.env.PRIVY_JWKS_URL;
  delete process.env.PRIVY_VERIFICATION_KEY;
  process.env.PRIVY_APP_ID="test-float-app";
  try {
    assert.equal((await request("/auth/privy",{accessToken:"unverified-token-not-accepted"})).status,503);
    const {publicKey,privateKey}=await generateKeyPair("ES256");
    process.env.PRIVY_VERIFICATION_KEY=await exportSPKI(publicKey);
    const valid=await new SignJWT({}).setProtectedHeader({alg:"ES256"}).setSubject("did:privy:test-user").setIssuer("privy.io").setAudience("test-float-app").setIssuedAt().setExpirationTime("5m").sign(privateKey);
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

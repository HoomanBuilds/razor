import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ApiError, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { authRoutes } from "../src/server/identity/auth";
import { accountRecoveryRoutes } from "../src/server/account-recovery";
import { prepareRestrictedKeyRevocation } from "../src/server/account-recovery/near";
import { assertTransferQuorum } from "../src/server/account-recovery/treasury";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="75".repeat(32);
process.env.APP_URL="http://localhost:3000";
const app=new Hono<AppEnv>().route("/auth",authRoutes).route("/account",accountRecoveryRoutes);
app.onError((error,c)=>{if(error instanceof ApiError)return c.json({code:error.code},error.status as 400);throw error;});
async function request(path:string,body?:unknown,cookie?:string,method=body===undefined?"GET":"POST") {
  return app.request(`http://localhost:3000${path}`,{method,headers:{Origin:"http://localhost:3000",...(body?{"Content-Type":"application/json"}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
}
async function proof(account:ReturnType<typeof privateKeyToAccount>,purpose="login",cookie?:string) {
  const challengeResponse=await request("/auth/challenge",{family:"evm",address:account.address,purpose},cookie);
  assert.equal(challengeResponse.status,200);
  const challenge=await challengeResponse.json(),signature=await account.signMessage({message:challenge.message});
  return request("/auth/wallet",{challengeId:challenge.challengeId,signature},cookie);
}

test("fresh verification cannot link a new identity and credential rotation keeps a working alternative",async()=>{
  const a=privateKeyToAccount(generatePrivateKey()),b=privateKeyToAccount(generatePrivateKey()),stranger=privateKeyToAccount(generatePrivateKey());
  const login=await proof(a),cookie=login.headers.get("set-cookie")!.split(";")[0],userId=(await login.json()).user.id;
  assert.equal((await proof(stranger,"reauth",cookie)).status,403);
  assert.equal((await proof(b,"link",cookie)).status,200);
  const walletA=row<{id:string}>("SELECT id FROM linked_wallets WHERE user_id=? AND address=?",userId,a.address.toLowerCase())!;
  let response=await request(`/auth/wallets/${walletA.id}`,undefined,cookie,"DELETE");
  assert.equal(response.status,403);assert.equal((await response.json()).code,"VERIFY_RECOVERY_METHOD_FIRST");
  getDb().prepare("UPDATE sessions SET created_at=? WHERE user_id=?").run(new Date(Date.now()-1200000).toISOString(),userId);
  response=await request("/account/sessions/revoke-others",{},cookie);
  assert.equal(response.status,403);assert.equal((await response.json()).code,"FRESH_SIGN_IN_REQUIRED");
  const another=await proof(a),otherCookie=another.headers.get("set-cookie")!.split(";")[0];
  const fresh=await proof(b,"reauth",cookie),freshCookie=fresh.headers.get("set-cookie")!.split(";")[0];
  assert.equal(fresh.status,200);
  assert.equal((await request(`/auth/wallets/${walletA.id}`,undefined,freshCookie,"DELETE")).status,200);
  assert.equal((await request("/auth/session",undefined,otherCookie)).status,401);
  const walletB=row<{id:string}>("SELECT id FROM linked_wallets WHERE user_id=?",userId)!;
  response=await request(`/auth/wallets/${walletB.id}`,undefined,freshCookie,"DELETE");
  assert.equal(response.status,409);assert.equal((await response.json()).code,"RECOVERY_METHOD_REQUIRED");
  assert.equal((await(await request("/account/status",undefined,freshCookie)).json()).recoveryMethodCount,1);
});

test("restricted key revocation refuses full-access keys, stale proof and foreign wallets",async()=>{
  const userId="near-owner-fixture",walletId=randomUUID(),now=new Date().toISOString(),ownerKey="ed25519:owner-public-key-fixture",restrictedKey="ed25519:restricted-public-key-fixture";
  getDb().prepare("INSERT INTO users (id,name,created_at) VALUES (?,?,?)").run(userId,"Owner",now);
  getDb().prepare("INSERT INTO linked_wallets (id,user_id,family,address,network,public_key,created_at,last_verified_at) VALUES (?,?,'near','owner.testnet','testnet',?,?,?)").run(walletId,userId,ownerKey,now,now);
  const original=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{const input=JSON.parse(init!.body as string);return Response.json({result:input.method==="status"?{chain_id:"testnet"}:input.params.request_type==="view_access_key_list"?{keys:[{public_key:ownerKey,access_key:{permission:"FullAccess"}},{public_key:restrictedKey,access_key:{permission:{FunctionCall:{receiver_id:"treasury.testnet",method_names:["execute_attempt"],allowance:"1"}}}}]}:{permission:"FullAccess"}});};
  try {
    const prepared=await prepareRestrictedKeyRevocation(userId,walletId,restrictedKey);
    assert.equal(prepared.walletActions[0].actions[0].type,"DeleteKey");
    await assert.rejects(()=>prepareRestrictedKeyRevocation(userId,walletId,ownerKey),(error)=>error instanceof ApiError&&error.code==="RESTRICTED_KEY_ONLY");
    await assert.rejects(()=>prepareRestrictedKeyRevocation("someone-else",walletId,restrictedKey),(error)=>error instanceof ApiError&&error.status===404);
    getDb().prepare("UPDATE linked_wallets SET last_verified_at=? WHERE id=?").run(new Date(Date.now()-1200000).toISOString(),walletId);
    await assert.rejects(()=>prepareRestrictedKeyRevocation(userId,walletId,restrictedKey),(error)=>error instanceof ApiError&&error.code==="FRESH_OWNER_PROOF_REQUIRED");
  }finally{globalThis.fetch=original;}
});

test("owner transfer cannot collapse an approval tier into an unreachable quorum",()=>{
  const chain={owner_id:"old.near",approvers:["new.near"],approval_tiers:[{up_to:"1000000",required_approvals:2}]};
  assert.throws(()=>assertTransferQuorum(chain,"new.near"),(error)=>error instanceof ApiError&&error.code==="OWNER_TRANSFER_QUORUM_UNREACHABLE");
  assert.equal(assertTransferQuorum(chain,"other.near"),2);
});

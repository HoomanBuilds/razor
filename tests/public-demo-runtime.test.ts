import assert from "node:assert/strict";
import { test } from "node:test";
import { configurePublicDemoEnvironment } from "../scripts/public-demo/environment";
process.env.PUBLIC_DEMO_ORIGIN="http://localhost:3000";
process.env.PRIVY_APP_SECRET="must-not-survive";
process.env.RESEND_API_KEY="must-not-survive";
process.env.NEAR_TREASURY_PRIVATE_KEY="must-not-survive";
const {tokens,publicOrigin}=configurePublicDemoEnvironment();
const {PublicDemoRuntime}=await import("../scripts/public-demo/runtime");
const {getDb,withDatabase,createMemoryDatabase,transaction}=await import("../src/server/db");
const runtime=new PublicDemoRuntime(tokens,publicOrigin);
async function request(path:string,cookie="",body?:unknown,method=body===undefined?"GET":"POST",profile?:string){
  return runtime.handle(new Request(`${publicOrigin}${path}`,{method,headers:{origin:publicOrigin,cookie,"content-type":"application/json",...(profile?{"x-razor-demo-profile":profile}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
}
async function start(){const response=await request("/state");assert.equal(response.status,200);return {cookie:response.headers.get("set-cookie")!.split(";")[0],state:await response.json()};}

test("public runtime strips credentials, blocks networking and requires isolated database scope",async()=>{
  for(const key of ["PRIVY_APP_SECRET","RESEND_API_KEY","NEAR_TREASURY_PRIVATE_KEY"])assert.equal(process.env[key],undefined);
  assert.throws(()=>getDb(),/isolated database scope/);
  await assert.rejects(()=>fetch("https://rpc.mainnet.near.org"),/blocks external/);
  await assert.rejects(()=>fetch("https://api.resend.com/emails",{method:"POST"}),/blocks external/);
  const a=createMemoryDatabase(),b=createMemoryDatabase();
  try{
    await Promise.all([withDatabase(a,async()=>{await Promise.resolve();assert.equal(getDb(),a);transaction(()=>assert.equal(getDb(),a));}),withDatabase(b,async()=>{await Promise.resolve();assert.equal(getDb(),b);transaction(()=>assert.equal(getDb(),b));})]);
  }finally{a.close();b.close();}
});

test("each visitor gets real seeded dashboards with independent simulated balances and idempotent payout",async()=>{
  const a=await start(),b=await start(),company=a.state.companies[0].id;
  assert.notEqual(a.cookie,b.cookie);assert.equal(a.state.fictional,true);assert.equal(a.state.noBroadcast,true);
  const localApi=`/api/organizations/${company}`;
  const recipients=await(await request(`${localApi}/recipients`,a.cookie)).json();assert(recipients.recipients.length>=7);
  const before=BigInt(a.state.treasury.balance),funded=await request("/action",a.cookie,{action:"fund"});assert.equal(funded.status,200);
  const first=await funded.json();assert.equal(BigInt(first.treasury.balance)-before,5000000000n);
  const repeated=await(await request("/action",a.cookie,{action:"fund"})).json();assert.equal(repeated.treasury.balance,first.treasury.balance);
  assert.equal((await(await request("/state",b.cookie)).json()).treasury.balance,b.state.treasury.balance);
  assert.equal((await request("/action",a.cookie,{action:"settle-payroll"})).status,409);
  assert.equal((await request("/action",a.cookie,{action:"approve-payroll"})).status,200);
  const paid=await request("/action",a.cookie,{action:"settle-payroll"});assert.equal(paid.status,200);
  const settled=await paid.json();assert.equal(settled.settled,true);assert.equal(BigInt(first.treasury.balance)-BigInt(settled.treasury.balance),7000800000n);
  const again=await(await request("/action",a.cookie,{action:"settle-payroll"})).json();assert.equal(again.treasury.balance,settled.treasury.balance);
  const payment=await(await request(`${localApi}/payments/${a.state.paymentIds.maya}`,a.cookie)).json();assert.equal(payment.payment.status,"paid");assert.equal(payment.attempts[0].destination_tx_hash,null);
  assert.match(payment.attempts[0].deposit_address,/DO NOT SEND/);
  await request("/action",a.cookie,{action:"profile",profile:"maya"});
  assert.equal((await request(`${localApi}/treasury`,a.cookie)).status,403);
  const own=await(await request("/api/recipient-workspace/payments",a.cookie)).json();assert(own.payments.some((item:{id:string,status:string})=>item.id===a.state.paymentIds.maya&&item.status==="paid"));
  assert.equal((await request("/action",a.cookie,{action:"fund"})).status,403);
  const reset=await(await request("/action",a.cookie,{action:"reset"})).json();assert.equal(reset.profile,"owner");assert.equal(reset.settled,false);assert.equal(reset.treasury.balance,a.state.treasury.balance);
});

test("funding instructions are nonsendable and exact funding legs credit once",async()=>{
  const visitor=await start(),base=`/api/organizations/${visitor.state.companies[0].id}`,asset=tokens.find(token=>token.symbol==="ETH"&&token.blockchain==="eth")!;
  const response=await request(`${base}/funding`,visitor.cookie,{originAsset:asset.assetId,amount:"1000000000000000000",reference:"Interactive funding"});assert.equal(response.status,201);
  const leg=await response.json();assert.match(leg.deposit_address,/DO NOT SEND/);assert.match(leg.recipient_address,/DO NOT SEND/);
  const first=await(await request("/action",visitor.cookie,{action:"fund",fundingId:leg.id})).json();assert.equal(BigInt(first.treasury.balance)-BigInt(visitor.state.treasury.balance),2000000000n);
  const again=await(await request("/action",visitor.cookie,{action:"fund",fundingId:leg.id})).json();assert.equal(first.treasury.balance,again.treasury.balance);
  assert.equal((await request("/action",visitor.cookie,{action:"settle-payment",paymentId:visitor.state.heldPaymentId})).status,409);
});

test("demo cookies never grant live auth and external/control writes are rejected",async()=>{
  assert.equal((await request("/api/auth/session","razor_session=some-real-session")).status,401);
  const visitor=await start(),session=await(await request("/api/auth/session",`${visitor.cookie}; razor_session=some-real-session`)).json();
  assert.equal(session.user.name,"Alex Morgan");
  for(const path of ["/api/auth/logout","/api/auth/challenge","/api/notifications/preferences","/api/demo/workspace/state"])assert.equal((await request(path,visitor.cookie,{})).status,403);
  const badOrigin=await runtime.handle(new Request(`${publicOrigin}/action`,{method:"POST",headers:{origin:"https://evil.example",cookie:visitor.cookie},body:JSON.stringify({action:"fund"})}));assert.equal(badOrigin.status,403);
  const expiry=await request("/state",`razor_demo_session=${"a".repeat(43)}`);assert.equal(expiry.status,410);
  assert.equal((await request("/action",`razor_demo_session=${"a".repeat(43)}`,{action:"reset"})).status,200);
});

test("email-only demo invitations use persona proof and persistent receiving workspace",async()=>{
  const visitor=await start(),base=`/api/organizations/${visitor.state.companies[0].id}`;
  const response=await request(`${base}/recipients`,visitor.cookie,{name:"Maya demo invite",kind:"employee",email:"maya@northstar.example"});assert.equal(response.status,201);
  const created=await response.json(),token=new URL(created.invitationUrl).searchParams.get("token")!;
  assert.equal(new URL(created.invitationUrl).pathname,"/demo");assert.equal(new URL(created.invitationUrl).searchParams.get("profile"),"maya");
  await request("/action",visitor.cookie,{action:"profile",profile:"leo"});assert.equal((await request(`/api/recipient-portal/${token}`,visitor.cookie)).status,403);
  await request("/action",visitor.cookie,{action:"profile",profile:"maya"});assert.equal((await request(`/api/recipient-portal/${token}`,visitor.cookie)).status,200);
  const confirmed=await request(`/api/recipient-portal/${token}/confirm`,visitor.cookie,{expectedVersion:1,primaryAsset:"USDC",primaryNetwork:"base",primaryAddress:"0x1111111111111111111111111111111111111111"});assert.equal(confirmed.status,200);
  assert.equal((await request(`/api/recipient-portal/${token}`,visitor.cookie)).status,404);
  const profiles=await(await request("/api/recipient-workspace/profiles",visitor.cookie)).json();assert(profiles.profiles.some((item:{recipient:{id:string}})=>item.recipient.id===created.recipient.id));
  assert.equal(created.email.configured,false);
});

test("active demo distributions and personal claims inspect without RPC and preserve ownership",async()=>{
  const visitor=await start(),base=`/api/organizations/${visitor.state.companies[0].id}`;
  const list=await(await request(`${base}/distributions`,visitor.cookie)).json();
  const active=list.distributions.find((item:{chain_status:string})=>item.chain_status==="active");assert(active);
  const detail=await request(`${base}/distributions/${active.id}`,visitor.cookie);assert.equal(detail.status,200);
  const pool=(await detail.json()).distribution;assert.equal(pool.chain.total,"400000000");assert.equal(pool.source_tx_hash,null);assert.equal(pool.simulated,true);
  assert.equal((await request(`${base}/treasury-policy`,visitor.cookie)).status,200);
  const recovery=await request(`${base}/access-recovery/status`,visitor.cookie);assert.equal(recovery.status,200);assert.equal((await recovery.json()).simulated,true);
  await request("/action",visitor.cookie,{action:"profile",profile:"maya"});
  const own=await(await request("/api/recipient-distributions",visitor.cookie)).json();assert(own.claims.length);
  const claim=await request(`/api/recipient-distributions/${own.claims[0].id}`,visitor.cookie);assert.equal(claim.status,200);assert.equal((await claim.json()).amount,"400000000");
  await request("/action",visitor.cookie,{action:"profile",profile:"leo"});
  assert.equal((await request(`/api/recipient-distributions/${own.claims[0].id}`,visitor.cookie)).status,404);
});

test("company and recipient tabs keep request-local personas and company boundaries",async()=>{
  const visitor=await start(),company=visitor.state.companies[0].id,otherCompany=visitor.state.companies[1].id;
  const switched=await request("/action",visitor.cookie,{action:"profile",profile:"maya"},"POST","owner");
  assert.equal((await switched.json()).profile,"maya");
  const [owner,receiver,companyTreasury,forbiddenTreasury,otherTreasury,ownPayments,wrongCompany]=await Promise.all([
    request("/api/auth/session",visitor.cookie,undefined,"GET","owner"),
    request("/api/auth/session",visitor.cookie,undefined,"GET","maya"),
    request(`/api/organizations/${company}/treasury`,visitor.cookie,undefined,"GET","owner"),
    request(`/api/organizations/${company}/treasury`,visitor.cookie,undefined,"GET","maya"),
    request(`/api/organizations/${otherCompany}/treasury`,visitor.cookie,undefined,"GET","maya"),
    request("/api/recipient-workspace/payments",visitor.cookie,undefined,"GET","maya"),
    request(`/api/organizations/${otherCompany}/payments/${visitor.state.paymentIds.maya}`,visitor.cookie,undefined,"GET","owner"),
  ]);
  assert.equal((await owner.json()).user.name,"Alex Morgan");
  assert.equal((await receiver.json()).user.name,"Maya Chen");
  assert.equal(companyTreasury.status,200);assert.equal(forbiddenTreasury.status,403);assert.equal(otherTreasury.status,403);assert.equal(wrongCompany.status,404);
  const payments=await ownPayments.json();assert(payments.payments.some((item:{id:string})=>item.id===visitor.state.paymentIds.maya));assert(!payments.payments.some((item:{id:string})=>item.id===visitor.state.paymentIds.leo));
  const [funded,receiverState]=await Promise.all([
    request("/action",visitor.cookie,{action:"fund"},"POST","owner"),
    request("/state",visitor.cookie,undefined,"GET","maya"),
  ]);
  assert.equal(funded.status,200);assert.equal((await funded.json()).profile,"owner");
  const personal=await receiverState.json();assert.equal(personal.profile,"maya");assert.equal(personal.treasury,null);
  assert.equal((await(await request("/state",visitor.cookie)).json()).profile,"maya");
  assert.equal((await request("/action",visitor.cookie,{action:"fund"},"POST","maya")).status,403);
  const next=await request("/action",visitor.cookie,{action:"profile",profile:"leo"},"POST","owner");assert.equal((await next.json()).profile,"leo");
  assert.equal((await(await request("/state",visitor.cookie)).json()).profile,"leo");
  assert.equal((await(await request("/state",visitor.cookie,undefined,"GET","owner")).json()).profile,"owner");
  assert.equal((await request("/state",visitor.cookie,undefined,"GET","__proto__")).status,400);
});

test("capacity bounds visitor databases without evicting an active session",async()=>{
  const small=new PublicDemoRuntime(tokens,publicOrigin,1);
  try{const first=await small.handle(new Request(`${publicOrigin}/state`));assert.equal(first.status,200);assert.equal((await small.handle(new Request(`${publicOrigin}/state`))).status,503);const cookie=first.headers.get("set-cookie")!.split(";")[0];assert.equal((await small.handle(new Request(`${publicOrigin}/state`,{headers:{cookie}}))).status,200);}finally{small.close();}
});

test.after(()=>runtime.close());

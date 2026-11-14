import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ZodError } from "zod";
import { ApiError, type AppEnv } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { encrypt, hashToken, newToken } from "../src/server/identity/crypto";
import { getRecipient, saveVersion } from "../src/server/identity/recipients";
import { supportRoutes } from "../src/server/support";
import { caseInput, replyInput, type CaseRecord, type SupportContext } from "../src/server/support/model";
import { createSupportCase, deleteSupportCase, expireSupportCases, inspectSupportCase, listSupportCases, operatorInspectCase, operatorListCases, operatorReplyCase, operatorUpdateCase, replySupportCase, updateSupportCase } from "../src/server/support/service";
import { runSupportAdmin } from "../src/server/support/command";
import { helpGuides, HELP_CATEGORIES, searchHelp } from "../src/lib/help/guides";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="b8".repeat(32);
process.env.APP_URL="http://localhost:3000";
const hasCode=(code:string)=>(error:unknown)=>error instanceof ApiError&&error.code===code;
function fixture(){
 const db=getDb(),userId=randomUUID(),recipientUser=randomUUID(),companyId=randomUUID(),roleId=randomUUID(),recipientId=randomUUID(),paymentId=randomUUID(),fundingId=randomUUID(),sessionId=randomUUID(),token=newToken(),at=new Date().toISOString();
 for(const [id,name] of [[userId,"Company member"],[recipientUser,"Payment recipient"]])db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id,name,at);
 db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(companyId,"Support test company",userId,at,at);
 db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?,?,1,?)").run(roleId,companyId,"Owner",JSON.stringify(["company:read","payments:read"]),at);
 db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(companyId,userId,roleId,at);
 db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'employee','USDC','near','recipient.near','confirmed',?,?,?)").run(recipientId,companyId,recipientUser,encrypt("Private payee"),at,at,at);
 saveVersion(getRecipient(companyId,recipientId),recipientUser);
 db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES(?,?,?,'payroll','PRIVATE-PAYROLL-REFERENCE','1000000','0','unknown',1,'{}',?,?)").run(paymentId,companyId,recipientId,at,at);
 db.prepare("INSERT INTO funding_legs(id,organization_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,created_at,updated_at) VALUES(?,?,'PRIVATE-FUNDING-REFERENCE','USDC','1000000','1000000','{}','deposit.near','treasury.near','source_unknown',?,?)").run(fundingId,companyId,at,at);
 db.prepare("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)").run(sessionId,userId,hashToken(token),at,new Date(Date.now()+3600000).toISOString());
 return {userId,recipientUser,companyId,roleId,recipientId,paymentId,fundingId,sessionId,token};
}
const input=(context:SupportContext={})=>({idempotencyKey:randomUUID(),subject:"Funding task needs review",category:"funding" as const,message:"The original task is still unknown. I did not send another transfer.",context,privacyAcknowledged:true as const});
const ticket=(f:ReturnType<typeof fixture>)=>createSupportCase(f.userId,input()).case;

test("authored help searches every requested product topic and links actual local entry points",()=>{
 for(const category of HELP_CATEGORIES)assert.ok(searchHelp("",category).length>0);
 assert.ok(searchHelp("company timezone").some(guide=>guide.id==="connect-accounting"));
 assert.ok(searchHelp("USDC backup").some(guide=>guide.id==="receiving-preferences"));
 assert.equal(searchHelp("not-a-product-feature-never-matches").length,0);
 assert.ok(helpGuides.every(guide=>guide.links.every(link=>/^\/(?:\?|[a-z]|$)/.test(link.href)&&!link.href.includes("research"))));
 assert.ok(helpGuides.some(guide=>guide.sections.some(section=>section.steps.some(step=>step.includes("does not establish staff availability")))));
});

test("sender-private cases encrypt bounded content and replay one exact immutable submission",()=>{
 const f=fixture(),terms=input({organizationId:f.companyId,paymentId:f.paymentId,fundingId:f.fundingId}),created=createSupportCase(f.userId,terms),replay=createSupportCase(f.userId,terms);
 assert.equal(created.created,true);assert.equal(replay.created,false);assert.equal(replay.case.id,created.case.id);
 assert.throws(()=>createSupportCase(f.userId,{...terms,message:"Different request with the reused request key"}),hasCode("SUPPORT_REPLAY_CONFLICT"));
 const stored=row<CaseRecord>("SELECT * FROM support_cases WHERE id=?",created.case.id)!;
 assert.ok(stored.subject_ciphertext!.startsWith("enc1:"));assert.ok(stored.context_ciphertext!.startsWith("enc1:"));
 assert.ok(!JSON.stringify(rows("SELECT * FROM support_messages WHERE case_id=?",created.case.id)).includes(terms.message));
 assert.equal(inspectSupportCase(f.userId,created.case.id).messages[0].body,terms.message);
 assert.ok(!JSON.stringify(created).includes("PRIVATE-PAYROLL-REFERENCE"));assert.ok(!JSON.stringify(created).includes("1000000"));
 assert.ok(!JSON.stringify(rows("SELECT details_json FROM identity_audit WHERE entity_id=?",created.case.id)).includes(terms.subject));
});

test("a company association does not share tickets with coworkers or grant access by knowing an ID",()=>{
 const f=fixture(),other=fixture(),created=createSupportCase(f.userId,input({organizationId:f.companyId})).case;
 getDb().prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(f.companyId,other.userId,f.roleId,new Date().toISOString());
 assert.equal(listSupportCases(other.userId,{organizationId:f.companyId}).cases.length,0);
 for(const action of [()=>inspectSupportCase(other.userId,created.id),()=>replySupportCase(other.userId,created.id,{idempotencyKey:randomUUID(),message:"I know this other user's case reference"}),()=>deleteSupportCase(other.userId,created.id,{idempotencyKey:randomUUID(),expectedVersion:1})])assert.throws(action,hasCode("SUPPORT_NOT_FOUND"));
});

test("company and funding references require fresh permissions and exact company ownership",()=>{
 const f=fixture(),other=fixture();
 for(const context of [{organizationId:other.companyId},{organizationId:f.companyId,paymentId:other.paymentId},{organizationId:f.companyId,fundingId:other.fundingId},{fundingId:f.fundingId}])assert.throws(()=>createSupportCase(f.userId,input(context)),hasCode("SUPPORT_CONTEXT_NOT_FOUND"));
 getDb().prepare("UPDATE organization_roles SET permissions_json='[\"company:read\"]' WHERE id=?").run(f.roleId);
 assert.throws(()=>createSupportCase(f.userId,input({organizationId:f.companyId,paymentId:f.paymentId})),hasCode("SUPPORT_CONTEXT_NOT_FOUND"));
 assert.throws(()=>createSupportCase(f.userId,input({organizationId:f.companyId,fundingId:f.fundingId})),hasCode("SUPPORT_CONTEXT_NOT_FOUND"));
 assert.equal(listSupportCases(f.userId).cases.length,0);
});

test("personal payment context binds exact historical confirmed recipient ownership",()=>{
 const f=fixture(),other=fixture();
 const created=createSupportCase(f.recipientUser,input({paymentId:f.paymentId})).case;
 assert.equal(created.context?.available,true);
 assert.throws(()=>createSupportCase(other.recipientUser,input({paymentId:f.paymentId})),hasCode("SUPPORT_CONTEXT_NOT_FOUND"));
 getDb().prepare("UPDATE recipients SET user_id=?,version=2 WHERE id=?").run(other.recipientUser,f.recipientId);
 saveVersion(getRecipient(f.companyId,f.recipientId),other.recipientUser);
 assert.throws(()=>createSupportCase(other.recipientUser,input({paymentId:f.paymentId})),hasCode("SUPPORT_CONTEXT_NOT_FOUND"));
 assert.equal(inspectSupportCase(f.recipientUser,created.id).case.context?.available,true);
});

test("removed company access hides linked context while preserving the sender's own private conversation",()=>{
 const f=fixture(),created=createSupportCase(f.userId,input({organizationId:f.companyId,paymentId:f.paymentId})).case;
 getDb().prepare("UPDATE memberships SET status='removed' WHERE organization_id=? AND user_id=?").run(f.companyId,f.userId);
 const result=inspectSupportCase(f.userId,created.id);
 assert.equal(result.case.context?.available,false);assert.ok(!JSON.stringify(result.case.context).includes(f.paymentId));assert.equal(result.messages.length,1);
 replySupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),message:"I can no longer access the company. Please keep this as my own support request."});
 assert.throws(()=>createSupportCase(f.userId,input({organizationId:f.companyId})),hasCode("SUPPORT_CONTEXT_NOT_FOUND"));
 assert.throws(()=>listSupportCases(f.userId,{organizationId:f.companyId}),hasCode("SUPPORT_CONTEXT_NOT_FOUND"));
});

test("only explicitly allowlisted existing operators can inspect or reply, and revocation is immediate",()=>{
 const f=fixture(),ops=fixture(),created=ticket(f),previous=process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS;
 try{
  delete process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS;assert.throws(()=>operatorInspectCase(ops.userId,created.id),hasCode("SUPPORT_OPERATOR_REQUIRED"));
  process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS=` ${ops.userId} `;
  assert.equal(operatorListCases(ops.userId).cases.some(item=>item.id===created.id),true);
  const terms={idempotencyKey:randomUUID(),message:"We recorded the reported issue. Keep tracking the original transfer."};
  operatorReplyCase(ops.userId,created.id,terms);operatorReplyCase(ops.userId,created.id,terms);
  const result=inspectSupportCase(f.userId,created.id);assert.equal(result.messages.length,2);assert.equal(result.messages[1].author,"operator");assert.equal(result.case.status,"waiting_for_sender");
  process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS="";assert.throws(()=>operatorInspectCase(ops.userId,created.id),hasCode("SUPPORT_OPERATOR_REQUIRED"));
  process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS="does-not-exist";assert.throws(()=>operatorListCases("does-not-exist"),hasCode("SUPPORT_OPERATOR_REQUIRED"));
 }finally{if(previous===undefined)delete process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS;else process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS=previous;}
});

test("thread replies and status changes are paged, versioned and idempotent",()=>{
 const f=fixture(),created=ticket(f),terms={idempotencyKey:randomUUID(),message:"A specific follow-up for this same original transfer"};
 replySupportCase(f.userId,created.id,terms);replySupportCase(f.userId,created.id,terms);
 assert.throws(()=>replySupportCase(f.userId,created.id,{...terms,message:"Changed content under the original reply key"}),hasCode("SUPPORT_REPLAY_CONFLICT"));
 for(let index=0;index<25;index++)replySupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),message:`Follow-up ${index}: no second source transfer was sent.`});
 const first=inspectSupportCase(f.userId,created.id),second=inspectSupportCase(f.userId,created.id,{messagePage:2,historyPage:2});
 assert.equal(first.messages.length,25);assert.equal(second.messages.length,2);assert.equal(second.history.length,2);assert.equal(new Set([...first.messages,...second.messages].map(item=>item.id)).size,27);
 const status={idempotencyKey:randomUUID(),expectedVersion:first.case.version,status:"resolved"};
 updateSupportCase(f.userId,created.id,status);assert.equal(updateSupportCase(f.userId,created.id,status).replayed,true);
 assert.throws(()=>updateSupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),expectedVersion:1,status:"open"}),hasCode("SUPPORT_VERSION_CHANGED"));
 assert.throws(()=>updateSupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),expectedVersion:28,status:"waiting_for_sender"}),hasCode("SUPPORT_STATUS_FORBIDDEN"));
});

test("case history pages remain sender scoped beyond the first page",()=>{
 const f=fixture(),ids:string[]=[];
 for(let index=0;index<26;index++){
  const created=ticket(f);ids.push(created.id);
  updateSupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),expectedVersion:1,status:"resolved"});
  getDb().prepare("UPDATE support_cases SET created_at=? WHERE id=?").run(new Date(Date.now()-2*86400000-index*1000).toISOString(),created.id);
 }
 const first=listSupportCases(f.userId),second=listSupportCases(f.userId,{page:2});assert.equal(first.cases.length,25);assert.equal(second.cases.length,1);assert.equal(first.hasMore,true);
 assert.deepEqual(new Set([...first.cases,...second.cases].map(item=>item.id)),new Set(ids));
});

test("bounded intake rejects raw fields, credentials, oversized text and excessive submissions without losing saved cases",()=>{
 const f=fixture(),terms=input();
 for(const extra of [{attachments:[]},{rawDocument:"private invoice"},{apiKey:"secret"},{senderId:fixture().userId},{operator:true}])assert.equal(caseInput.safeParse({...terms,...extra}).success,false);
 for(const message of ["short","x".repeat(4001),"-----BEGIN PRIVATE KEY----- do not store this", "recovery phrase: do not store this", "contains a control \u0000 character"])assert.equal(replyInput.safeParse({idempotencyKey:randomUUID(),message}).success,false);
 for(let index=0;index<10;index++)ticket(f);
 assert.throws(()=>ticket(f),hasCode("SUPPORT_RATE_LIMIT"));assert.equal(listSupportCases(f.userId).cases.length,10);
 const next=fixture(),created=ticket(next);getDb().prepare("UPDATE support_rate_limits SET actions=100 WHERE user_id=?").run(next.userId);
 assert.throws(()=>replySupportCase(next.userId,created.id,{idempotencyKey:randomUUID(),message:"A bounded reply after the hourly limit"}),hasCode("SUPPORT_RATE_LIMIT"));
 deleteSupportCase(next.userId,created.id,{idempotencyKey:randomUUID(),expectedVersion:1});
 assert.equal(row<{actions:number}>("SELECT actions FROM support_rate_limits WHERE user_id=?",next.userId)!.actions,100);
});

test("expiry and user deletion remove encrypted content and context without reviving replayed intake",()=>{
 const f=fixture(),terms=input({organizationId:f.companyId,paymentId:f.paymentId}),created=createSupportCase(f.userId,terms).case;
 getDb().prepare("UPDATE support_cases SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(created.id);
 assert.equal(expireSupportCases().redacted,1);
 const expired=inspectSupportCase(f.userId,created.id);assert.equal(expired.case.status,"expired");assert.equal(expired.messages.length,0);assert.equal(expired.case.context,null);
 const stored=row<CaseRecord>("SELECT * FROM support_cases WHERE id=?",created.id)!;assert.equal(stored.subject_ciphertext,null);assert.equal(stored.context_ciphertext,null);assert.equal(stored.organization_id,null);
 assert.throws(()=>createSupportCase(f.userId,terms),hasCode("SUPPORT_CONTENT_REMOVED"));assert.throws(()=>replySupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),message:"Must not revive the expired original case"}),hasCode("SUPPORT_CONTENT_REMOVED"));
 const next=ticket(f);deleteSupportCase(f.userId,next.id,{idempotencyKey:randomUUID(),expectedVersion:1});assert.equal(deleteSupportCase(f.userId,next.id,{idempotencyKey:randomUUID(),expectedVersion:1}).deleted,true);
 assert.equal(inspectSupportCase(f.userId,next.id).messages.length,0);assert.equal(row<{status:string}>("SELECT status FROM payments WHERE id=?",f.paymentId)!.status,"unknown");
});

test("retention is bounded and immutable per case, and invalid setup cannot create a record",()=>{
 const f=fixture(),previous=process.env.RAZOR_SUPPORT_RETENTION_DAYS;
 try{
  process.env.RAZOR_SUPPORT_RETENTION_DAYS="7";const created=ticket(f),duration=Date.parse(created.expiresAt)-Date.parse(created.createdAt);
  assert.ok(duration>=7*86400000&&duration<7*86400000+1000);
  process.env.RAZOR_SUPPORT_RETENTION_DAYS="365";replySupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),message:"A reply must not extend retention for this original case"});
  assert.equal(inspectSupportCase(f.userId,created.id).case.expiresAt,created.expiresAt);
  for(const value of ["0","366","NaN"]){process.env.RAZOR_SUPPORT_RETENTION_DAYS=value;assert.throws(()=>ticket(f),hasCode("SUPPORT_SETUP_REQUIRED"));}
  assert.equal(row<{count:number}>("SELECT COUNT(*) count FROM support_cases WHERE sender_user_id=?",f.userId)!.count,1);
 }finally{if(previous===undefined)delete process.env.RAZOR_SUPPORT_RETENTION_DAYS;else process.env.RAZOR_SUPPORT_RETENTION_DAYS=previous;}
});

test("full conversation capacity preserves reads and permits text deletion without resetting abuse counters",()=>{
 const f=fixture(),created=ticket(f),db=getDb(),at=new Date().toISOString();
 for(let index=0;index<199;index++){
  const eventId=randomUUID();db.prepare("INSERT INTO support_events(id,case_id,actor_user_id,actor_role,kind,idempotency_hash,request_hash,created_at) VALUES(?,?,?,'sender','reply',?,?,?)").run(eventId,created.id,f.userId,randomUUID(),randomUUID(),at);
  db.prepare("INSERT INTO support_messages(id,event_id,case_id,body_ciphertext,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),eventId,created.id,encrypt("Retained historical support message for capacity review"),at);
 }
 assert.throws(()=>replySupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),message:"This request exceeds the conversation capacity"}),hasCode("SUPPORT_CAPACITY"));
 assert.equal(inspectSupportCase(f.userId,created.id).totalMessages,200);
 deleteSupportCase(f.userId,created.id,{idempotencyKey:randomUUID(),expectedVersion:1});
 assert.equal(inspectSupportCase(f.userId,created.id).totalMessages,0);assert.equal(row<{actions:number}>("SELECT actions FROM support_rate_limits WHERE user_id=?",f.userId)!.actions,1);
});

test("actual support routes require a current session, verify mutation origin and expose no remote operator path",async()=>{
 const f=fixture(),app=new Hono<AppEnv>();app.onError((error,c)=>error instanceof ApiError?c.json({code:error.code},error.status as 400):c.json({code:error instanceof ZodError?"INVALID_INPUT":"FAILED"},400));app.route("/support",supportRoutes);
 assert.equal((await app.request("http://localhost:3000/support")).status,401);
 const headers={cookie:`razor_session=${f.token}`,origin:"http://localhost:3000","content-type":"application/json"};
 assert.equal((await app.request("http://localhost:3000/support",{method:"POST",headers:{...headers,origin:"https://attacker.invalid"},body:JSON.stringify(input())})).status,403);
 const response=await app.request("http://localhost:3000/support",{method:"POST",headers,body:JSON.stringify(input())});assert.equal(response.status,201);
 assert.equal(response.headers.get("cache-control"),"private, no-store");
 const oversized=await app.request("http://localhost:3000/support",{method:"POST",headers,body:"x".repeat(32769)});assert.equal(oversized.status,413);
 assert.equal((await app.request("http://localhost:3000/support/operator/list",{headers})).status,404);
 getDb().prepare("DELETE FROM sessions WHERE id=?").run(f.sessionId);assert.equal((await app.request("http://localhost:3000/support",{headers})).status,401);
});

test("local operator CLI handles bounded reply files, stable retries and status without outbound transport",async()=>{
 const f=fixture(),ops=fixture(),created=ticket(f),directory=await mkdtemp(join(tmpdir(),"razor-support-cli-")),previous=process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS,fetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error("No external calls are allowed");};process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS=ops.userId;
 try{
  const path=join(directory,"reply.txt"),key=randomUUID();await writeFile(path,"The case was reviewed. No refund or payment has been authorized.",{mode:0o600});
  await runSupportAdmin(["reply","--operator-user",ops.userId,"--case",created.id,"--message-file",path,"--key",key]);
  await runSupportAdmin(["reply","--operator-user",ops.userId,"--case",created.id,"--message-file",path,"--key",key]);
  assert.equal(inspectSupportCase(f.userId,created.id).messages.length,2);
  const inspected=await runSupportAdmin(["inspect","--operator-user",ops.userId,"--case",created.id]);assert.ok("messages" in inspected);
  await runSupportAdmin(["status","--operator-user",ops.userId,"--case",created.id,"--status","resolved","--version","2","--key",randomUUID()]);
  assert.equal(inspectSupportCase(f.userId,created.id).case.status,"resolved");
  await writeFile(join(directory,"too-large.txt"),"x".repeat(16001));await assert.rejects(()=>runSupportAdmin(["reply","--operator-user",ops.userId,"--case",created.id,"--message-file",join(directory,"too-large.txt"),"--key",randomUUID()]),hasCode("SUPPORT_REPLY_FILE_INVALID"));
  await symlink(path,join(directory,"linked.txt"));await assert.rejects(()=>runSupportAdmin(["reply","--operator-user",ops.userId,"--case",created.id,"--message-file",join(directory,"linked.txt"),"--key",randomUUID()]));
  assert.equal(calls,0);assert.equal((await readFile(path,"utf8")).includes("No refund"),true);
 }finally{globalThis.fetch=fetch;if(previous===undefined)delete process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS;else process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS=previous;await rm(directory,{recursive:true,force:true});}
});

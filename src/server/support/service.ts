import { randomUUID } from "node:crypto";
import { ApiError, requirePermission } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken } from "../identity/crypto";
import { getRecipientVersion } from "../identity/recipients";
import { audit, getAccess } from "../identity/session";
import { caseInput, deleteInput, digest, historyInput, replyInput, retentionDays, statusInput, SUPPORT_PAGE_SIZE, threadInput, type CaseRecord, type SupportContext } from "./model";

interface Actor {userId:string;role:"sender"|"operator"}
const now=()=>new Date().toISOString();
function sender(userId:string):Actor {
 if(!row("SELECT id FROM users WHERE id=?",userId))throw new ApiError(401,"Sign in to use private support","UNAUTHENTICATED");
 return {userId,role:"sender"};
}
function operator(userId:string):Actor {
 const allowed=(process.env.RAZOR_SUPPORT_OPERATOR_USER_IDS??"").split(",").map(value=>value.trim()).filter(Boolean);
 if(!allowed.includes(userId)||!row("SELECT id FROM users WHERE id=?",userId))throw new ApiError(403,"This existing user is not an explicitly allowlisted support operator","SUPPORT_OPERATOR_REQUIRED");
 return {userId,role:"operator"};
}
function verifyContext(userId:string,input:SupportContext) {
 try {
  const company=input.organizationId?getAccess(userId,input.organizationId):null;
  if(company)requirePermission(company,"company:read");
  if(input.paymentId){
   const payment=row<{organization_id:string;recipient_id:string;recipient_version:number}>("SELECT organization_id,recipient_id,recipient_version FROM payments WHERE id=?",input.paymentId);
   if(!payment)throw new Error();
   if(company){requirePermission(company,"payments:read");if(payment.organization_id!==company.organizationId)throw new Error();}
   else {
    const profile=getRecipientVersion(payment.organization_id,payment.recipient_id,payment.recipient_version);
    if(profile?.user_id!==userId||profile.organization_id!==payment.organization_id||profile.id!==payment.recipient_id||profile.preference_status!=="confirmed"||!profile.confirmed_at)throw new Error();
   }
  }
  if(input.fundingId){if(!company)throw new Error();requirePermission(company,"payments:read");if(!row("SELECT id FROM funding_legs WHERE id=? AND organization_id=?",input.fundingId,company.organizationId))throw new Error();}
 } catch {throw new ApiError(404,"One or more references are not available to your current account. Remove them to record a general issue","SUPPORT_CONTEXT_NOT_FOUND");}
 return input;
}
function contextView(ticket:CaseRecord) {
 if(!ticket.context_ciphertext)return null;
 const context=JSON.parse(decrypt(ticket.context_ciphertext)) as SupportContext;
 if(!Object.keys(context).length)return null;
 try {verifyContext(ticket.sender_user_id,context);return {available:true,...context,verifiedAt:ticket.created_at};}
 catch{return {available:false,reason:"The sender no longer has current access to the referenced context"};}
}
function summary(ticket:CaseRecord,actor:Actor) {
 const removed=["deleted","expired"].includes(ticket.status)||ticket.expires_at<=now();
 return {id:ticket.id,...(actor.role==="operator"?{senderId:ticket.sender_user_id}:{}),category:ticket.category,subject:removed?ticket.status==="deleted"?"Deleted case":"Expired case":decrypt(ticket.subject_ciphertext!),status:removed&&ticket.status!=="deleted"?"expired":ticket.status,version:ticket.version,createdAt:ticket.created_at,updatedAt:ticket.updated_at,expiresAt:ticket.expires_at,context:removed?null:contextView(ticket),recordedOnly:true};
}
function redact(ticket:CaseRecord,status:"deleted"|"expired",actor?:Actor) {
 const db=getDb(),at=now();
 db.prepare("DELETE FROM support_messages WHERE case_id=?").run(ticket.id);
 db.prepare("DELETE FROM support_events WHERE case_id=?").run(ticket.id);
 db.prepare("UPDATE support_cases SET organization_id=NULL,subject_ciphertext=NULL,context_ciphertext=NULL,status=?,version=version+1,updated_at=? WHERE id=?").run(status,at,ticket.id);
 db.prepare("INSERT INTO support_events(id,case_id,actor_user_id,actor_role,kind,previous_status,next_status,idempotency_hash,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),ticket.id,actor?.userId??null,actor?.role??"system",status,ticket.status,status,hashToken(status),digest({id:ticket.id,status}),at);
 if(actor)audit(actor.userId,null,`support.case_${status}`,ticket.id);
}
export function expireSupportCases() {
 return transaction(db=>{
  const expired=rows<CaseRecord>("SELECT * FROM support_cases WHERE expires_at<=? AND status NOT IN ('expired','deleted') ORDER BY expires_at LIMIT 1000",now());
  for(const ticket of expired)redact(ticket,"expired");
  db.prepare("DELETE FROM support_rate_limits WHERE hour_bucket<?").run(new Date(Date.now()-2*86400000).toISOString().slice(0,13));
  return {redacted:expired.length,mayHaveMore:expired.length===1000};
 });
}
function ticketFor(actor:Actor,id:string) {
 let ticket=row<CaseRecord>(`SELECT * FROM support_cases WHERE id=?${actor.role==="sender"?" AND sender_user_id=?":""}`,id,...(actor.role==="sender"?[actor.userId]:[]));
 if(!ticket)throw new ApiError(404,"Support case not found","SUPPORT_NOT_FOUND");
 if(ticket.expires_at<=now()&&!["expired","deleted"].includes(ticket.status)){redact(ticket,"expired");ticket=row<CaseRecord>("SELECT * FROM support_cases WHERE id=?",id)!;}
 return ticket;
}
function available(ticket:CaseRecord) {if(["expired","deleted"].includes(ticket.status))throw new ApiError(410,"This case's text and context were removed. Its minimal replay-protection record remains","SUPPORT_CONTENT_REMOVED");}
function rate(actor:Actor) {
 const db=getDb(),hour=now().slice(0,13),count=row<{actions:number}>("SELECT actions FROM support_rate_limits WHERE user_id=? AND hour_bucket=?",actor.userId,hour)?.actions??0;
 if(count>=100)throw new ApiError(429,"Private support has reached its hourly action limit. Retry later","SUPPORT_RATE_LIMIT");
 db.prepare("INSERT INTO support_rate_limits(user_id,hour_bucket,actions) VALUES(?,?,1) ON CONFLICT(user_id,hour_bucket) DO UPDATE SET actions=actions+1").run(actor.userId,hour);
}
function eventReplay(actor:Actor,ticket:CaseRecord,key:string,requestHash:string) {
 const previous=row<{id:string;request_hash:string}>("SELECT id,request_hash FROM support_events WHERE case_id=? AND actor_user_id=? AND idempotency_hash=?",ticket.id,actor.userId,hashToken(key));
 if(previous&&previous.request_hash!==requestHash)throw new ApiError(409,"This request key already has different terms. Review the saved case before submitting again","SUPPORT_REPLAY_CONFLICT");
 return previous;
}
function event(actor:Actor,ticket:CaseRecord,kind:string,next:string,key:string,requestHash:string) {
 if(row<{count:number}>("SELECT COUNT(*) count FROM support_events WHERE case_id=?",ticket.id)!.count>=500||row<{count:number}>("SELECT COUNT(*) count FROM support_events")!.count>=500000)throw new ApiError(429,"Support action history capacity is reached. Saved cases remain readable and can be deleted","SUPPORT_CAPACITY");
 const id=randomUUID();
 getDb().prepare("INSERT INTO support_events(id,case_id,actor_user_id,actor_role,kind,previous_status,next_status,idempotency_hash,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,ticket.id,actor.userId,actor.role,kind,ticket.status,next,hashToken(key),requestHash,now());
 return id;
}
function capacity(ticket?:CaseRecord) {
 const global=row<{count:number}>("SELECT COUNT(*) count FROM support_messages")!.count;
 if(global>=200000||ticket&&row<{count:number}>("SELECT COUNT(*) count FROM support_messages WHERE case_id=?",ticket.id)!.count>=200)throw new ApiError(429,"Support message capacity is reached. Existing cases remain readable","SUPPORT_CAPACITY");
}
export function createSupportCase(userId:string,data:unknown) {
 const actor=sender(userId),input=caseInput.parse(data),requestHash=digest(input);expireSupportCases();
 return transaction(db=>{
  const previous=row<CaseRecord>("SELECT * FROM support_cases WHERE sender_user_id=? AND idempotency_hash=?",userId,hashToken(input.idempotencyKey));
  if(previous){if(previous.request_hash!==requestHash)throw new ApiError(409,"This submission key already has a different request","SUPPORT_REPLAY_CONFLICT");available(previous);return {case:summary(previous,actor),created:false};}
  verifyContext(userId,input.context);
  if(row<{count:number}>("SELECT COUNT(*) count FROM support_cases WHERE sender_user_id=? AND created_at>?",userId,new Date(Date.now()-86400000).toISOString())!.count>=10||row<{count:number}>("SELECT COUNT(*) count FROM support_cases WHERE sender_user_id=? AND status IN ('open','waiting_for_sender','waiting_for_operator') AND expires_at>?",userId,now())!.count>=20)throw new ApiError(429,"You reached the private support intake limit. Review your existing cases or retry later","SUPPORT_RATE_LIMIT");
  if(row<{count:number}>("SELECT COUNT(*) count FROM support_cases WHERE status NOT IN ('deleted','expired')")!.count>=20000)throw new ApiError(429,"Support intake capacity is reached. Existing cases remain available","SUPPORT_CAPACITY");
  capacity();rate(actor);const id=randomUUID(),at=now(),expires=new Date(Date.now()+retentionDays()*86400000).toISOString();
  db.prepare("INSERT INTO support_cases(id,sender_user_id,organization_id,category,subject_ciphertext,context_ciphertext,idempotency_hash,request_hash,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,userId,input.context.organizationId??null,input.category,encrypt(input.subject),encrypt(JSON.stringify(input.context)),hashToken(input.idempotencyKey),requestHash,at,at,expires);
  const ticket=row<CaseRecord>("SELECT * FROM support_cases WHERE id=?",id)!,eventId=event(actor,ticket,"created","open",input.idempotencyKey,requestHash);
  db.prepare("INSERT INTO support_messages(id,event_id,case_id,body_ciphertext,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),eventId,id,encrypt(input.message),at);
  audit(userId,null,"support.case_recorded",id,{category:input.category});return {case:summary(ticket,actor),created:true};
 });
}
function list(actor:Actor,data:unknown) {
 const input=historyInput.parse(data);expireSupportCases();
 if(input.organizationId&&actor.role==="sender")verifyContext(actor.userId,{organizationId:input.organizationId});
 const where=`WHERE ${actor.role==="sender"?"sender_user_id=? AND ":""}(? IS NULL OR organization_id=?)`,params=[...(actor.role==="sender"?[actor.userId]:[]),input.organizationId??null,input.organizationId??null];
 const total=row<{count:number}>(`SELECT COUNT(*) count FROM support_cases ${where}`,...params)!.count;
 return {cases:rows<CaseRecord>(`SELECT * FROM support_cases ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,...params,SUPPORT_PAGE_SIZE,(input.page-1)*SUPPORT_PAGE_SIZE).map(ticket=>summary(ticket,actor)),page:input.page,pageSize:SUPPORT_PAGE_SIZE,total,hasMore:input.page*SUPPORT_PAGE_SIZE<total,retentionDays:retentionDays(),notice:"Recording a case does not promise staff availability, a response time or an outbound notification. Never send keys, recovery phrases, API secrets or raw documents."};
}
function inspect(actor:Actor,id:string,data:unknown) {
 const input=threadInput.parse(data);expireSupportCases();
 return transaction(()=>{
  const ticket=ticketFor(actor,id),totalMessages=row<{count:number}>("SELECT COUNT(*) count FROM support_messages WHERE case_id=?",id)!.count,totalHistory=row<{count:number}>("SELECT COUNT(*) count FROM support_events WHERE case_id=?",id)!.count;
  return {case:summary(ticket,actor),messages:rows<{id:string;body_ciphertext:string;actor_role:string;created_at:string}>("SELECT m.id,m.body_ciphertext,e.actor_role,m.created_at FROM support_messages m JOIN support_events e ON e.id=m.event_id WHERE m.case_id=? ORDER BY m.sequence LIMIT ? OFFSET ?",id,SUPPORT_PAGE_SIZE,(input.messagePage-1)*SUPPORT_PAGE_SIZE).map(item=>({id:item.id,body:decrypt(item.body_ciphertext),author:item.actor_role,createdAt:item.created_at})),history:rows<{id:string;actor_role:string;kind:string;previous_status:string|null;next_status:string|null;created_at:string}>("SELECT id,actor_role,kind,previous_status,next_status,created_at FROM support_events WHERE case_id=? ORDER BY sequence LIMIT ? OFFSET ?",id,SUPPORT_PAGE_SIZE,(input.historyPage-1)*SUPPORT_PAGE_SIZE),messagePage:input.messagePage,historyPage:input.historyPage,totalMessages,totalHistory,pageSize:SUPPORT_PAGE_SIZE};
 });
}
function reply(actor:Actor,id:string,data:unknown) {
 const input=replyInput.parse(data),requestHash=digest({kind:"reply",...input});expireSupportCases();
 return transaction(db=>{
  const ticket=ticketFor(actor,id);available(ticket);
  const replay=eventReplay(actor,ticket,input.idempotencyKey,requestHash);if(replay)return {caseId:id,replayed:true,version:ticket.version};
  if(ticket.status==="closed")throw new ApiError(409,"Reopen this case before adding a reply","SUPPORT_CLOSED");
  capacity(ticket);rate(actor);const next=actor.role==="operator"?"waiting_for_sender":"waiting_for_operator",eventId=event(actor,ticket,"reply",next,input.idempotencyKey,requestHash);
  db.prepare("INSERT INTO support_messages(id,event_id,case_id,body_ciphertext,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),eventId,id,encrypt(input.message),now());
  db.prepare("UPDATE support_cases SET status=?,version=version+1,updated_at=? WHERE id=?").run(next,now(),id);
  audit(actor.userId,null,"support.reply_recorded",id,{role:actor.role});return {caseId:id,replayed:false,version:ticket.version+1};
 });
}
function status(actor:Actor,id:string,data:unknown) {
 const input=statusInput.parse(data),requestHash=digest({kind:"status",...input});expireSupportCases();
 return transaction(db=>{
  const ticket=ticketFor(actor,id);available(ticket);
  if(eventReplay(actor,ticket,input.idempotencyKey,requestHash))return {case:summary(ticket,actor),replayed:true};
  if(actor.role==="sender"&&!["open","resolved","closed"].includes(input.status))throw new ApiError(403,"Only a support operator can set a response-waiting status","SUPPORT_STATUS_FORBIDDEN");
  if(ticket.version!==input.expectedVersion)throw new ApiError(409,"This case changed. Refresh its conversation before changing status","SUPPORT_VERSION_CHANGED");
  rate(actor);event(actor,ticket,"status",input.status,input.idempotencyKey,requestHash);
  db.prepare("UPDATE support_cases SET status=?,version=version+1,updated_at=? WHERE id=?").run(input.status,now(),id);
  audit(actor.userId,null,"support.status_changed",id,{status:input.status,role:actor.role});return {case:summary(row<CaseRecord>("SELECT * FROM support_cases WHERE id=?",id)!,actor),replayed:false};
 });
}
export const listSupportCases=(userId:string,data:unknown={})=>list(sender(userId),data);
export const inspectSupportCase=(userId:string,id:string,data:unknown={})=>inspect(sender(userId),id,data);
export const replySupportCase=(userId:string,id:string,data:unknown)=>reply(sender(userId),id,data);
export const updateSupportCase=(userId:string,id:string,data:unknown)=>status(sender(userId),id,data);
export function deleteSupportCase(userId:string,id:string,data:unknown) {
 const actor=sender(userId),input=deleteInput.parse(data);expireSupportCases();
 return transaction(()=>{const ticket=ticketFor(actor,id);if(ticket.status==="deleted")return {deleted:true};available(ticket);if(ticket.version!==input.expectedVersion)throw new ApiError(409,"This case changed. Refresh before deleting text","SUPPORT_VERSION_CHANGED");redact(ticket,"deleted",actor);return {deleted:true};});
}
export const operatorListCases=(userId:string,data:unknown={})=>list(operator(userId),data);
export const operatorInspectCase=(userId:string,id:string,data:unknown={})=>inspect(operator(userId),id,data);
export const operatorReplyCase=(userId:string,id:string,data:unknown)=>reply(operator(userId),id,data);
export const operatorUpdateCase=(userId:string,id:string,data:unknown)=>status(operator(userId),id,data);

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { encrypt, hashToken } from "../src/server/identity/crypto";
import { getRecipient, saveVersion } from "../src/server/identity/recipients";
import { getAccess } from "../src/server/identity/session";
import { recipientWorkspaceRoutes } from "../src/server/recipient-workspace";
import { companyRequests, ownPayments, ownProfiles, ownRecipient, ownRequests, prepareInvoiceRequest, submitInvoice } from "../src/server/recipient-workspace/service";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="73".repeat(32);
process.env.APP_URL="http://localhost:3000";
const db=getDb(),now=new Date().toISOString(),user="payee-one",other="payee-two",finance="finance-owner",org="payer-company";
for(const id of [user,other,finance])db.prepare("INSERT INTO users (id,name,created_at) VALUES (?,?,?)").run(id,id,now);
db.prepare("INSERT INTO organizations (id,name,owner_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(org,"Payer",finance,now,now);
for(const [id,userId] of [["profile-one",user],["profile-two",other]])db.prepare("INSERT INTO recipients (id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,invitation_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,org,userId,encrypt(id),"contractor","USDC","near",`${id}.near`,"confirmed",now,"2020-01-01T00:00:00.000Z",now,now);
for(const [id,recipient] of [["payment-one","profile-one"],["payment-two","profile-two"]])db.prepare("INSERT INTO payments (id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,org,recipient,"payroll",`payroll:${id}`,"100000000","0","draft",1,"{}",JSON.stringify({displayReference:"November services",periodStart:"2026-11-01",periodEnd:"2026-11-30"}),now,now);
const sessionToken="permanent-recipient-session";
db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").run("recipient-session",user,hashToken(sessionToken),new Date(Date.now()+60000).toISOString(),now);
const access:AccessContext={userId:finance,organizationId:org,permissions:["company:read","payments:read","payments:prepare"]};

test("permanent recipient access survives expired invitations and isolates other payees",async()=>{
  assert.equal(ownProfiles(user).length,1);
  const payments=ownPayments(user);
  assert.equal(payments.length,1);assert.equal(payments[0].reference,"November services");assert.equal(payments[0].periodStart,"2026-11-01");
  assert.throws(()=>getAccess(user,org),(error)=>error instanceof ApiError&&error.status===403);
  const app=new Hono<AppEnv>().route("/",recipientWorkspaceRoutes);
  app.onError((error,c)=>{if(error instanceof ApiError)return c.json({code:error.code},error.status as 400);throw error;});
  const headers={Cookie:`razor_session=${sessionToken}`};
  const response=await app.request("http://localhost:3000/",{headers});
  assert.equal(response.status,200);assert.equal((await response.json()).payments.length,1);
  assert.equal((await app.request("http://localhost:3000/profiles/profile-two",{headers})).status,404);
});

test("private invoice requests are idempotent and create only explicit human-reviewed USDC drafts",()=>{
  const input={recipientId:"profile-one",reference:"INV-PRIVATE-1",amount:"100",currency:"EUR",dueDate:"2026-12-01",lineItems:[{description:"Confidential consulting",quantity:"1",unitPrice:"100"}],text:"Private source invoice"};
  const submitted=submitInvoice(user,input),retry=submitInvoice(user,input);
  assert.equal(retry.id,submitted.id);
  assert.equal(row<{count:number}>("SELECT count(*) AS count FROM bills")!.count,0);
  assert.ok(!row<{payload_ciphertext:string}>("SELECT payload_ciphertext FROM recipient_invoice_requests WHERE id=?",submitted.id)!.payload_ciphertext.includes("Confidential"));
  assert.throws(()=>submitInvoice(other,input),(error)=>error instanceof ApiError&&error.status===404);
  assert.throws(()=>prepareInvoiceRequest({...access,organizationId:"another-company"},submitted.id,{sourceFingerprint:submitted.sourceFingerprint,agreedUSDC:"110",maxFee:"1",reviewConfirmed:true}),(error)=>error instanceof ApiError&&error.status===404);
  const review={sourceFingerprint:submitted.sourceFingerprint,agreedUSDC:"110",maxFee:"1",reviewConfirmed:true as const};
  const prepared=prepareInvoiceRequest(access,submitted.id,review),again=prepareInvoiceRequest(access,submitted.id,review);
  assert.equal(again.bill.id,prepared.bill.id);assert.equal(prepared.bill.amount,"110000000");assert.equal(prepared.bill.status,"draft");
  assert.equal(row<{status:string}>("SELECT status FROM payments WHERE id=?",prepared.bill.payment_id!)!.status,"draft");
  assert.equal(row<{count:number}>("SELECT count(*) AS count FROM bills")!.count,1);
  assert.throws(()=>prepareInvoiceRequest(access,submitted.id,{...review,agreedUSDC:"111"}),(error)=>error instanceof ApiError&&error.code==="INVOICE_REVIEW_CONFLICT");
  assert.throws(()=>submitInvoice(user,{...input,amount:"101",lineItems:[{...input.lineItems[0],unitPrice:"101"}]}),(error)=>error instanceof ApiError&&error.code==="INVOICE_REFERENCE_CONFLICT");
});

test("recipient reassignment preserves original private history without exposing it to the new owner",()=>{
  const id="reassigned-profile";
  db.prepare("INSERT INTO recipients (id,organization_id,user_id,name,email,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,org,user,encrypt("Original supplier"),encrypt("original@example.test"),"contractor","USDC","near","original.near","confirmed",now,now,now);
  saveVersion(getRecipient(org,id),user);
  const input={recipientId:id,reference:"REASSIGNED-OLD-INVOICE",amount:"20",currency:"USDC",lineItems:[{description:"Original private services",quantity:"1",unitPrice:"20"}]};
  const submitted=submitInvoice(user,input);
  function payment(paymentId:string,version:number) {
    db.prepare("INSERT INTO payments (id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(paymentId,org,id,"contractor",paymentId,"20000000","0","draft",version,"{}",now,now);
  }
  payment("original-owner-payment",1);
  db.prepare("UPDATE recipients SET user_id=NULL,name=?,email=?,primary_address='unconfirmed.near',preference_status='pending_confirmation',confirmed_at=NULL,version=2 WHERE id=?").run(encrypt("New supplier"),encrypt("new@example.test"),id);
  saveVersion(getRecipient(org,id),finance);
  payment("unclaimed-profile-payment",2);
  db.prepare("UPDATE recipients SET user_id=?,primary_address='new-owner.near',preference_status='confirmed',confirmed_at=?,version=3 WHERE id=?").run(other,now,id);
  saveVersion(getRecipient(org,id),other);
  payment("new-owner-payment",3);
  assert.ok(ownPayments(user).some(record=>record.id==="original-owner-payment"));
  assert.ok(!ownPayments(user).some(record=>record.id==="new-owner-payment"));
  assert.ok(!ownPayments(other).some(record=>record.id==="original-owner-payment"));
  assert.ok(ownPayments(other).some(record=>record.id==="new-owner-payment"));
  assert.ok(!ownPayments(other).some(record=>record.id==="unclaimed-profile-payment"));
  assert.deepEqual(ownPayments(user,id).map(record=>record.id),["original-owner-payment"]);
  const historical=ownProfiles(user).find(profile=>profile.recipient.id===id)!;
  assert.equal(historical.historicalOnly,true);
  assert.equal(historical.recipient.name,"Original supplier");
  assert.equal(historical.recipient.email,"original@example.test");
  assert.equal(historical.recipient.primary_address,"original.near");
  assert.equal(ownProfiles(other).find(profile=>profile.recipient.id===id)!.historicalOnly,false);
  assert.throws(()=>ownRecipient(user,id),(error)=>error instanceof ApiError&&error.code==="RECIPIENT_NOT_FOUND");
  assert.ok(ownRequests(user).some(record=>record.id===submitted.id));
  assert.ok(!ownRequests(other).some(record=>record.id===submitted.id));
  assert.equal(companyRequests(access).find(record=>record.id===submitted.id)!.recipientName,"Original supplier");
  assert.throws(()=>submitInvoice(other,input),(error)=>error instanceof ApiError&&error.code==="INVOICE_REFERENCE_CONFLICT");
  assert.throws(()=>prepareInvoiceRequest(access,submitted.id,{sourceFingerprint:submitted.sourceFingerprint,agreedUSDC:"20",maxFee:"1",reviewConfirmed:true}),(error)=>error instanceof ApiError&&error.code==="INVOICE_RECIPIENT_CHANGED");
});

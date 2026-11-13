import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getDb, transaction } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { getRecipient, saveVersion } from "../src/server/identity/recipients";
import { companyRequestPage, ownPayment, ownPaymentPage, ownRequestPage } from "../src/server/recipient-workspace/service";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="36".repeat(32);
function fixture() {
  const user=randomUUID(),other=randomUUID(),org=randomUUID(),recipient=randomUUID(),now=new Date().toISOString(),db=getDb();
  for(const id of [user,other])db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Person',?)").run(id,now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(org,user,now,now);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'contractor','USDC','near','recipient.near','confirmed',?,?,?)").run(recipient,org,user,encrypt("Original person"),now,now,now);
  saveVersion(getRecipient(org,recipient),user);
  const payment=(id:string,version=1)=>db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES(?,?,?,'payroll',?,'100000000','1000000','draft',?,'{}',?,?)").run(id,org,recipient,id,version,now,now);
  return {user,other,org,recipient,now,db,payment};
}

test("personal history pages cover older records and apply historical ownership before pagination",()=>{
  const f=fixture();
  transaction(()=>{for(let index=0;index<275;index++)f.payment(`old-${f.user}-${String(index).padStart(3,"0")}`);});
  f.db.prepare("UPDATE recipients SET user_id=?,version=2 WHERE id=?").run(f.other,f.recipient);
  saveVersion(getRecipient(f.org,f.recipient),f.other);
  transaction(()=>{for(let index=0;index<275;index++)f.payment(`new-${f.user}-${String(index).padStart(3,"0")}`,2);});
  const first=ownPaymentPage(f.user,1,50),last=ownPaymentPage(f.user,6,50);
  assert.throws(()=>ownPaymentPage(f.user,0,50),/valid history page/);
  assert.throws(()=>ownRequestPage(f.user,1,101),/valid history page/);
  assert.equal(ownPaymentPage(f.user,7,50).payments.length,0);
  assert.equal(first.total,275);assert.equal(first.payments.length,50);assert.equal(first.hasMore,true);
  assert.equal(last.payments.length,25);assert.equal(last.hasMore,false);
  assert(first.payments.every(payment=>payment.id.startsWith("old-")));
  assert.equal(ownPaymentPage(f.other,1,100).total,275);
  assert.throws(()=>ownPayment(f.other,first.payments[0].id),/not linked/);
  assert.equal(ownPayment(f.user,last.payments[0].id).id,last.payments[0].id);
});

test("invoice request pages retain older submissions without admitting another submitter",()=>{
  const f=fixture(),payload=encrypt(JSON.stringify({reference:"Invoice",amount:"1",currency:"USDC",lineItems:[{description:"Service",quantity:"1",unitPrice:"1"}]}));
  transaction(()=>{for(let index=0;index<251;index++)f.db.prepare("INSERT INTO recipient_invoice_requests(id,organization_id,recipient_id,submitted_by,reference_hash,source_fingerprint,payload_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(),f.org,f.recipient,f.user,`ref-${index}`,`hash-${index}`,payload,f.now,f.now);});
  assert.equal(ownRequestPage(f.user,1,50).total,251);
  assert.equal(ownRequestPage(f.user,6,50).requests.length,1);
  assert.equal(ownRequestPage(f.other,1,50).total,0);
  const access={userId:f.user,organizationId:f.org,permissions:["payments:read"]};
  assert.equal(companyRequestPage(access,6,50).requests.length,1);
  assert.equal(companyRequestPage(access,1,50).total,251);
  assert.throws(()=>companyRequestPage({...access,permissions:["company:read"]},1,50),/permission/);
});

test("terminal partial receipts preserve attested output and decimals independently of provider reports",()=>{
  const f=fixture(),paymentId=randomUUID(),attemptId=randomUUID();f.payment(paymentId);
  f.db.prepare("UPDATE payments SET status='partially_paid',delivered_amount='40000000' WHERE id=?").run(paymentId);
  f.db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,destination_decimals,destination_symbol,expected_output,amount_in,deposit_address,reconciliation,created_at,updated_at) VALUES(?,?,?,'backup','partially_delivered','{}','retired-token','eth','0x1111111111111111111111111111111111111111',18,'ETH','1000000000000000000','100000000','deposit',?,?,?)").run(attemptId,paymentId,f.org,JSON.stringify({provider:{swapDetails:{amountOut:"200000000000000000"}}}),f.now,f.now);
  const reviewId=randomUUID();
  f.db.prepare("INSERT INTO partial_settlement_reviews(id,organization_id,payment_id,attempt_id,actual_output,credited_usdc,destination_tx_hash,receipt_commitment,evidence_ciphertext,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(reviewId,f.org,paymentId,attemptId,"400000000000000000","40000000","fixture-destination","fixture-receipt",encrypt("Fixture evidence"),f.user,f.now);
  f.db.prepare("INSERT INTO partial_settlements(payment_id,attempt_id,organization_id,review_id,actual_output,credited_usdc,source_spent_usdc,receipt_commitment,proof_ciphertext,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(paymentId,attemptId,f.org,reviewId,"400000000000000000","40000000","100000000","fixture-receipt",encrypt("{}"),f.now);
  const result=ownPayment(f.user,paymentId),attempt=result.attempts[0];
  assert.equal(attempt.confirmedOutputAtomic,"400000000000000000");
  assert.equal(attempt.reportedOutputAtomic,"200000000000000000");
  assert.equal(attempt.destination_decimals,18);assert.equal(attempt.destination_symbol,"ETH");
  assert.equal(result.remaining_amount,"60000000");
});

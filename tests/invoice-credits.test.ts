import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { encrypt, hashToken } from "../src/server/identity/crypto";
import { getRecipient, saveVersion } from "../src/server/identity/recipients";
import { supplierCreditRoutes, companyCreditRoutes } from "../src/server/invoice-credits";
import { acceptCredit, companyCredits, issueCredit, rejectCredit, reviseCredit, reviewCredit, supplierBills, supplierCredit, supplierCredits, withdrawCredit } from "../src/server/invoice-credits/service";
import { creditExportRows } from "../src/server/invoice-credits/accounting";
import { approveBill, createBill, listBills } from "../src/server/business/service";
import { addBillInstallment, getBillTerms, setBillTerms } from "../src/server/business/bill-terms";
import { managedPaymentReview, replaceCancelledPayment } from "../src/server/payment-management/service";
import { paymentSummary } from "../src/server/payments/service";
import { projectExport, projectReports } from "../src/server/projects/service";
import { liabilityTotals } from "../src/server/reconciliation/liability";
import { accountingExport } from "../src/server/reconciliation/export";
import { ownPayment, ownRequests } from "../src/server/recipient-workspace/service";
import { financeInsights } from "../src/server/assistant/finance/service";
import { parseCsv } from "../src/lib/csv";
import { approveCommitment, commitmentExport, consumeBillCommitment, createCommitment, getCommitment, reviewCommitment } from "../src/server/vendor-commitments/service";
import { authenticateIntegration, createIntegrationCredential, integrationResource } from "../src/server/integrations/service";
import { resourceOutputs } from "../src/server/integrations/schemas";
import { importCompanyInvoice } from "../src/server/company-private/service";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="e7".repeat(32);
process.env.APP_URL="http://localhost:3000";
const permissions=["company:read","company:manage","payments:read","payments:prepare","payments:approve","reports:read","documents:manage","recipients:read"];
const code=(value:string)=>(error:unknown)=>error instanceof ApiError&&error.code===value;
function fixture(){
 const db=getDb(),id=randomUUID(),supplier=randomUUID(),stranger=randomUUID(),recipientId=randomUUID(),at=new Date().toISOString(),token=randomUUID();
 for(const user of [id,supplier,stranger])db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Finance user',?)").run(user,at);
 db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id,id,at,at);
 db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,'Owner',?,1,?)").run(id,id,JSON.stringify(permissions),at);
 db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id,id,id,at);
 for(const [user,secret] of [[id,token],[supplier,`${token}-supplier`],[stranger,`${token}-stranger`]])db.prepare("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)").run(randomUUID(),user,hashToken(secret),at,new Date(Date.now()+3600000).toISOString());
 db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'business','USDC','near','supplier.near','confirmed',?,?,?)").run(recipientId,id,supplier,encrypt("Original supplier"),at,at,at);
 saveVersion(getRecipient(id,recipientId),id);
 db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,'50000000','0','0',?)").run(id,at);
 const access:AccessContext={userId:id,organizationId:id,permissions};
 const invoice=(amount="100000000",extra={})=>createBill(access,{recipientId,reference:randomUUID(),title:"Original invoice",amount,maxFee:"0",projectReference:"Delivery",costCenterReference:"Operations",...extra});
 return {access,supplier,stranger,recipientId,at,token,invoice};
}
function proposal(f:ReturnType<typeof fixture>,bill:ReturnType<typeof createBill>,amount=bill.amount,extra={}){const input={billId:bill.id,reference:randomUUID(),amount,unit:"USDC",reason:"Agreed correction to the original commercial invoice",idempotencyKey:randomUUID(),...extra};return {...issueCredit(f.supplier,input),input};}
function accepted(f:ReturnType<typeof fixture>,note:ReturnType<typeof issueCredit>["note"]){const review=reviewCredit(f.access.userId,f.access.organizationId,note.id);assert.deepEqual(review.locks,[]);const input={expectedVersion:note.version,reviewHash:review.reviewHash,acknowledgeDraftRetirement:true,idempotencyKey:randomUUID()};return {...acceptCredit(f.access.userId,f.access.organizationId,note.id,input),input,review};}
function request(f:ReturnType<typeof fixture>,bill:ReturnType<typeof createBill>){const id=randomUUID();getDb().prepare("INSERT INTO recipient_invoice_requests(id,organization_id,recipient_id,submitted_by,reference_hash,source_fingerprint,payload_ciphertext,status,bill_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'prepared',?,?,?)").run(id,f.access.organizationId,f.recipientId,f.supplier,randomUUID(),"ab".repeat(32),encrypt(JSON.stringify({recipientId:f.recipientId,reference:bill.reference,amount:"100",currency:"USDC",lineItems:[]})),bill.id,f.at,f.at);return id;}

test("supplier proposal, exact revisions, rejection and withdrawal preserve immutable history without reducing debt",()=>{
 const f=fixture(),bill=f.invoice(),initial=proposal(f,bill,"10000000");assert.equal(initial.note.status,"proposed");assert.equal(getBillTerms(f.access,bill.id).acceptedCreditAmount,"0");
 assert.equal(issueCredit(f.supplier,initial.input).replayed,true);assert.throws(()=>issueCredit(f.supplier,{...initial.input,amount:"2"}),code("CREDIT_REPLAY_CONFLICT"));
 const rejected=rejectCredit(f.access.userId,f.access.organizationId,initial.note.id,{expectedVersion:1,reason:"Please correct the originally agreed credit amount",idempotencyKey:randomUUID()});assert.equal(rejected.note.status,"rejected");
 const revised=reviseCredit(f.supplier,initial.note.id,{expectedVersion:1,amount:"20000000",unit:"USDC",reason:"Updated credit confirmed against delivered service quantity",idempotencyKey:randomUUID()});assert.equal(revised.note.version,2);assert.equal(revised.note.status,"proposed");assert.deepEqual(revised.note.versions.map(v=>v.amount),["10000000","20000000"]);
 const withdrawn=withdrawCredit(f.supplier,revised.note.id,{expectedVersion:2,reason:"Supplier has withdrawn the revised proposed credit",idempotencyKey:randomUUID()});assert.equal(withdrawn.note.status,"withdrawn");assert.equal(withdrawn.note.events.length,4);assert.equal(getBillTerms(f.access,bill.id).remainingLiability,bill.amount);
 assert.throws(()=>getDb().prepare("UPDATE invoice_credit_versions SET amount='1' WHERE note_id=?").run(initial.note.id),/immutable/);assert.throws(()=>getDb().prepare("DELETE FROM invoice_credit_events WHERE note_id=?").run(initial.note.id),/history/);
});

test("credit references are company and original supplier scoped across bills, and all amounts keep exact bounded USDC precision",()=>{
 const f=fixture(),one=f.invoice(),two=f.invoice(),note=proposal(f,one,"1",{reference:" Credit-01 "});
 assert.throws(()=>proposal(f,two,"1",{reference:"credit-01"}),code("CREDIT_REFERENCE_EXISTS"));
 for(const amount of ["0","-1","1.1","01","1e6","",(10n**30n+1n).toString()])assert.throws(()=>proposal(f,one,amount),ZodError);
 assert.throws(()=>proposal(f,one,"1",{unit:"USD"}),ZodError);assert.throws(()=>proposal(f,one,"100000001"),code("CREDIT_EXCEEDS_REMAINDER"));
 assert.throws(()=>supplierCredit(f.stranger,note.note.id),code("CREDIT_NOT_FOUND"));assert.throws(()=>proposal({...f,supplier:f.stranger},one),code("CREDIT_BILL_NOT_FOUND"));
 const other=fixture();assert.throws(()=>reviewCredit(other.access.userId,other.access.organizationId,note.note.id),code("CREDIT_NOT_FOUND"));assert.deepEqual(companyCredits(other.access.userId,other.access.organizationId).notes,[]);
 assert.equal(supplierBills(f.supplier).bills.length,2);assert.equal(supplierCredits(f.supplier).notes.length,1);
 const large=f.invoice("9007199254740993");const exact=accepted(f,proposal(f,large,"9007199254740992").note);assert.equal(exact.remainingLiability,"1");assert.equal(getBillTerms(f.access,large.id).uncommitted,"1");
});

test("full accepted credit retires only the reviewed unsigned draft and never credits cash, delivery, expenses or project revenue",async()=>{
 const f=fixture(),bill=f.invoice(),note=proposal(f,bill),before=JSON.stringify(row("SELECT * FROM treasury_balances WHERE organization_id=?",f.access.organizationId)),result=accepted(f,note.note);
 assert.equal(result.note.status,"accepted");assert.equal(result.remainingLiability,"0");assert.deepEqual(result.retiredPaymentIds,[bill.payment_id]);assert.equal(result.review.draftsToRetire[0].amount,bill.amount);assert.equal(result.review.totals.uncommittedBefore,"0");
 const terms=getBillTerms(f.access,bill.id);assert.equal(terms.amount,bill.amount);assert.equal(terms.paid,"0");assert.equal(terms.acceptedCreditAmount,bill.amount);assert.equal(terms.remainingLiability,"0");assert.equal(terms.setoffAmount,"0");assert.equal(terms.fundedClearingAmount,"0");assert.equal(terms.acceptedCreditNotes[0].id,note.note.id);assert.equal(listBills(f.access)[0].status,"credited");
 const summary=paymentSummary(f.access);assert.equal(summary.openPrincipal,"0");assert.equal(summary.unreservedBudget,"0");assert.equal(summary.paidCount,0);assert.equal(summary.openCount,0);assert.equal(JSON.stringify(row("SELECT * FROM treasury_balances WHERE organization_id=?",f.access.organizationId)),before);
 for(const project of [projectReports(f.access).projects[0],projectReports(f.access).costCenters[0]]){assert.equal(project.acceptedCredits,bill.amount);assert.equal(project.remainingLiability,"0");assert.equal(project.sourceSpent,"0");assert.equal(project.earnedReceipts,"0");assert.equal(project.cashResult,"0");}
 assert.throws(()=>addBillInstallment(f.access,bill.id,{amount:"1",maxFee:"0"}),code("CLEARED_LIABILITY"));assert.throws(()=>setBillTerms(f.access,bill.id,{paymentAmount:"1",maxFee:"0",requiresAcceptance:false}),code("CLEARED_LIABILITY"));assert.throws(()=>approveBill(f.access,bill.id),code("CLEARED_LIABILITY"));assert.equal(managedPaymentReview(f.access,bill.payment_id!).canReplace,false);
 const fetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error("No external action is permitted");};try{await assert.rejects(()=>replaceCancelledPayment(f.access,bill.payment_id!,"This historical draft was retired by supplier credit"),code("CLEARED_LIABILITY"));assert.equal(calls,0);}finally{globalThis.fetch=fetch;}
 assert.equal(acceptCredit(f.access.userId,f.access.organizationId,note.note.id,result.input).replayed,true);
 assert.throws(()=>withdrawCredit(f.supplier,note.note.id,{expectedVersion:1,reason:"An accepted credit cannot be undone by this command",idempotencyKey:randomUUID()}),code("CREDIT_ACCEPTED"));
 const db=getDb();assert.throws(()=>db.prepare("UPDATE payments SET status='draft' WHERE id=?").run(bill.payment_id!),/CLEARED_LIABILITY/);assert.throws(()=>db.prepare("UPDATE bills SET amount='1' WHERE id=?").run(bill.id),/CLEARED_LIABILITY/);assert.throws(()=>db.prepare("UPDATE bills SET payment_id=? WHERE id=?").run(bill.payment_id!,bill.id),/CLEARED_LIABILITY/);assert.throws(()=>db.prepare("INSERT INTO bill_installments(id,bill_id,payment_id,created_at) VALUES(?,?,?,?)").run(randomUUID(),bill.id,bill.payment_id!,f.at),/CLEARED_LIABILITY/);assert.throws(()=>db.prepare("DELETE FROM invoice_credit_retirements WHERE payment_id=?").run(bill.payment_id!),/Preserve/);
});

test("partially delivered invoice can credit only its exact uncommitted remainder, preserving prior paid installment and original purchasing consumption",()=>{
 const f=fixture(),date=new Date().toISOString().slice(0,10),year=Number(date.slice(0,4)),po=createCommitment(f.access,{recipientId:f.recipientId,reference:randomUUID(),settlementUnit:"USDC",scope:"Original commercial service quantity",allowance:"100000000",cadence:"total",startsOn:`${year-1}-01-01`,endsOn:`${year+1}-12-31`,targetState:"active",reason:"Approved original service quantity"});approveCommitment(f.access,po.id,reviewCommitment(f.access,po.id).reviewToken);
 const bill=f.invoice("100000000",{commitmentReference:po.reference,commitmentDate:date,commitmentScopeConfirmed:true});setBillTerms(f.access,bill.id,{paymentAmount:"40000000",maxFee:"0",requiresAcceptance:false});consumeBillCommitment(f.access,bill.id);
 getDb().prepare("UPDATE payments SET status='paid',approved_at=?,approved_by=?,delivered_amount=amount,total_spent='41000000' WHERE id=?").run(f.at,f.access.userId,bill.payment_id!);
 const old=JSON.stringify(row("SELECT * FROM payments WHERE id=?",bill.payment_id!)),next=addBillInstallment(f.access,bill.id,{amount:"60000000",maxFee:"0"}),result=accepted(f,proposal(f,bill,"20000000").note);
 assert.deepEqual(result.retiredPaymentIds,[next.payment_id]);assert.equal(result.remainingLiability,"40000000");assert.equal(JSON.stringify(row("SELECT * FROM payments WHERE id=?",bill.payment_id!)),old);assert.equal(getBillTerms(f.access,bill.id).paid,"40000000");assert.equal(listBills(f.access)[0].status,"partially_settled");
 assert.throws(()=>addBillInstallment(f.access,bill.id,{amount:"40000001",maxFee:"0"}),code("INSTALLMENT_EXCEEDS_BALANCE"));const residual=addBillInstallment(f.access,bill.id,{amount:"40000000",maxFee:"0"});assert.equal(residual.uncommitted,"0");assert.equal(paymentSummary(f.access).openPrincipal,"40000000");
 const commitment=getCommitment(f.access,po.id);assert.equal(commitment.used,"100000000");assert.equal(commitment.remaining,"0");assert.equal(commitment.acceptedCredits,"20000000");assert.equal(commitment.uses[0].acceptedCredit,"20000000");assert.equal(parseCsv(commitmentExport(f.access)).find(item=>item.bill_id===bill.id)!.accepted_supplier_credit_micro_usdc,"20000000");
});

test("simultaneous reviewed proposals cannot over-credit and stale ownership or payment terms invalidate exact approval",async()=>{
 const f=fixture(),bill=f.invoice(),a=proposal(f,bill,"60000000"),b=proposal(f,bill,"60000000"),ra=reviewCredit(f.access.userId,f.access.organizationId,a.note.id),rb=reviewCredit(f.access.userId,f.access.organizationId,b.note.id);
 const results=await Promise.allSettled([a,b].map((item,i)=>Promise.resolve().then(()=>acceptCredit(f.access.userId,f.access.organizationId,item.note.id,{expectedVersion:1,reviewHash:[ra,rb][i].reviewHash,acknowledgeDraftRetirement:true,idempotencyKey:randomUUID()}))));assert.equal(results.filter(result=>result.status==="fulfilled").length,1);assert.equal(getBillTerms(f.access,bill.id).acceptedCreditAmount,"60000000");assert.equal(getBillTerms(f.access,bill.id).remainingLiability,"40000000");
 const another=f.invoice(),note=proposal(f,another,"1"),review=reviewCredit(f.access.userId,f.access.organizationId,note.note.id);getDb().prepare("UPDATE payments SET max_fee='1' WHERE id=?").run(another.payment_id!);assert.throws(()=>acceptCredit(f.access.userId,f.access.organizationId,note.note.id,{expectedVersion:1,reviewHash:review.reviewHash,acknowledgeDraftRetirement:true,idempotencyKey:randomUUID()}),code("CREDIT_REVIEW_CHANGED"));
 assert.throws(()=>acceptCredit(f.access.userId,f.access.organizationId,note.note.id,{expectedVersion:1,reviewHash:review.reviewHash,idempotencyKey:randomUUID()}),ZodError);
});

test("current memberships, approver permissions and supplier ownership are rechecked; original issuer keeps private history after reassignment",()=>{
 const f=fixture(),bill=f.invoice(),note=proposal(f,bill,"1"),db=getDb();db.prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(["company:read","payments:read"]),f.access.userId);assert.throws(()=>accepted(f,note.note),code("FORBIDDEN"));
 db.prepare("UPDATE memberships SET status='revoked' WHERE user_id=? AND organization_id=?").run(f.access.userId,f.access.organizationId);assert.throws(()=>companyCredits(f.access.userId,f.access.organizationId),code("COMPANY_ACCESS_DENIED"));db.prepare("UPDATE memberships SET status='active' WHERE user_id=? AND organization_id=?").run(f.access.userId,f.access.organizationId);db.prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(permissions),f.access.userId);
 db.prepare("UPDATE recipients SET user_id=?,version=2,name=? WHERE id=?").run(f.stranger,encrypt("Changed owner payroll data"),f.recipientId);saveVersion(getRecipient(f.access.organizationId,f.recipientId),f.access.userId);
 const history=supplierCredit(f.supplier,note.note.id);assert.equal(history.bill,null);assert.equal(history.canRevise,false);assert.equal(history.note.reference,note.note.reference);assert.equal(JSON.stringify(history).includes("Changed owner"),false);assert.equal(supplierCredits(f.stranger).notes.length,0);assert.equal(supplierBills(f.stranger).bills.length,0);assert.throws(()=>supplierCredit(f.stranger,note.note.id),code("CREDIT_NOT_FOUND"));assert.throws(()=>proposal({...f,supplier:f.stranger},bill,"1"),code("CREDIT_SUPPLIER_CHANGED"));assert.ok(reviewCredit(f.access.userId,f.access.organizationId,note.note.id).locks.some(lock=>lock.code==="CREDIT_BILL_NOT_FOUND"));
 assert.equal(withdrawCredit(f.supplier,note.note.id,{expectedVersion:1,reason:"Withdraw after company reassigned this historical supplier",idempotencyKey:randomUUID()}).note.status,"withdrawn");assert.equal(getBillTerms(f.access,bill.id).acceptedCreditAmount,"0");
});

function accountingLock(f:ReturnType<typeof fixture>,bill:ReturnType<typeof createBill>,attempts:number,state:string){const id=randomUUID(),db=getDb();db.prepare("INSERT INTO accounting_connections(id,organization_id,provider,created_by,environment,created_at,updated_at) VALUES(?,?,'quickbooks',?,'sandbox',?,?)").run(id,f.access.organizationId,f.access.userId,f.at,f.at);db.prepare("INSERT INTO accounting_jobs(id,organization_id,connection_id,entity_id,connection_version,mapping_version,kind,source_id,source_hash,marker,payload_ciphertext,review_hash,state,attempts,created_by,created_at,updated_at) VALUES(?,?,?,'entity',1,1,'bill',?,'hash',?,'encrypted','review',?,?,?,?,?)").run(randomUUID(),f.access.organizationId,id,bill.id,randomUUID(),state,attempts,f.access.userId,f.at,f.at);}
test("approved, partial, reserved, clearing, worker and externally posted authority hold credit rather than revoke spending or bookkeeping",()=>{
 const scenarios:Array<[string,(f:ReturnType<typeof fixture>,bill:ReturnType<typeof createBill>)=>void]>=[
  ["CREDIT_AUTHORITY_HELD",(f,b)=>{getDb().prepare("UPDATE payments SET approved_at=?,approved_by=? WHERE id=?").run(f.at,f.access.userId,b.payment_id!);} ],
  ["CREDIT_AUTHORITY_HELD",(_f,b)=>{getDb().prepare("UPDATE payments SET status='partially_paid',delivered_amount='1' WHERE id=?").run(b.payment_id!);} ],
  ["CREDIT_CASH_RESERVED",(_f,b)=>{getDb().prepare("UPDATE payments SET chain_reserved='1' WHERE id=?").run(b.payment_id!);} ],
  ["CREDIT_SIGNATURE_HELD",(f,b)=>{getDb().prepare("INSERT INTO operation_jobs(id,organization_id,kind,entity_id,job_key,status,run_at,created_at,updated_at) VALUES(?,?,'payment',?,?,'running',?,?,?)").run(randomUUID(),f.access.organizationId,b.payment_id!,randomUUID(),f.at,f.at,f.at);} ],
  ["CREDIT_CLEARING_LOCKED",(f,b)=>{const creditor=fixture();getDb().prepare("INSERT INTO clearing_links(id,debtor_id,creditor_id,bill_id,payment_id,terms_hash,terms_ciphertext,starts_at,expires_at,status,offered_by,created_at) VALUES(?,?,?,?,?,'hash','encrypted',?,?,'offered',?,?)").run(randomUUID(),f.access.organizationId,creditor.access.organizationId,b.id,b.payment_id!,f.at,new Date(Date.now()-1000).toISOString(),f.access.userId,f.at);} ],
  ["CREDIT_BOOKKEEPING_HELD",(f,b)=>accountingLock(f,b,1,"unknown")],
  ["CREDIT_BOOKKEEPING_HELD",(f,b)=>accountingLock(f,b,0,"queued")],
 ];
 for(const [expected,setup]of scenarios){const f=fixture(),bill=f.invoice(),note=proposal(f,bill,"1");setup(f,bill);const before=JSON.stringify(row("SELECT * FROM payments WHERE id=?",bill.payment_id!)),review=reviewCredit(f.access.userId,f.access.organizationId,note.note.id);assert.ok(review.locks.some(lock=>lock.code===expected),expected);assert.throws(()=>acceptCredit(f.access.userId,f.access.organizationId,note.note.id,{expectedVersion:1,reviewHash:review.reviewHash,acknowledgeDraftRetirement:true,idempotencyKey:randomUUID()}),error=>error instanceof ApiError);assert.equal(getBillTerms(f.access,bill.id).acceptedCreditAmount,"0");assert.equal(JSON.stringify(row("SELECT * FROM payments WHERE id=?",bill.payment_id!)),before);}
});

test("expense-backed invoices refuse supplier credit even if their current payee is a business",()=>{
 const f=fixture(),bill=f.invoice(),db=getDb();db.prepare("INSERT INTO expense_requests(id,organization_id,submitted_by,recipient_id,recipient_version,recipient_snapshot_ciphertext,submitter_name_ciphertext,request_key,request_hash,source_hash,identity_hash,amount,payload_ciphertext,status,bill_id,policy_month,submitted_at,updated_at) VALUES(?,?,?,?,1,'snapshot','name',?,'request','source','identity',?,'fields','accepted',?,?,?,?)").run(randomUUID(),f.access.organizationId,f.supplier,f.recipientId,randomUUID(),bill.amount,bill.id,f.at.slice(0,7),f.at,f.at);assert.throws(()=>proposal(f,bill,"1"),code("CREDIT_EXPENSE_UNSUPPORTED"));
});

test("all financial readers and strict API schemas expose credit separately with original face, no false cash and no reimport reopening",()=>{
 const f=fixture(),source="ac".repeat(32),importTerms={sourceSha256:source,sourceKind:"text",recipientId:f.recipientId,reference:randomUUID(),title:"Company reviewed invoice",agreedUSDC:"100",maxFeeUSDC:"0",reviewConfirmed:true};const created=importCompanyInvoice(f.access,importTerms),bill=row<ReturnType<typeof createBill>>("SELECT * FROM bills WHERE id=?",created.billId)!,requestId=request(f,bill),note=proposal(f,bill),result=accepted(f,note.note);
 assert.equal(importCompanyInvoice(f.access,importTerms).created,false);assert.equal(getBillTerms(f.access,bill.id).acceptedCreditAmount,bill.amount);assert.equal(getBillTerms(f.access,bill.id).payment_id,null);assert.throws(()=>importCompanyInvoice(f.access,{...importTerms,agreedUSDC:"101"}),code("DUPLICATE_INVOICE"));
 const exported=parseCsv(accountingExport(f.access)),invoice=exported.find(item=>item.record_type==="invoice"&&item.bill_id===bill.id)!,credit=creditExportRows(f.access.organizationId)[0],creditRow=exported.find(item=>item.record_type==="accepted_supplier_credit_note")!;
 assert.equal(invoice.entitlement_micro_usdc,bill.amount);assert.equal(invoice.accepted_credit_micro_usdc,bill.amount);assert.equal(invoice.delivered_entitlement_usdc,"0");assert.equal(invoice.setoff_micro_usdc,"0");assert.equal(invoice.funded_discharge_micro_usdc,"0");assert.equal(invoice.remaining_entitlement_usdc,"0");assert.equal(invoice.unprepared_liability_usdc,"0");assert.ok(Object.entries(credit).every(([key,value])=>creditRow[key]===String(value??"")));assert.equal(exported.find(item=>item.record_id===bill.payment_id)!.credit_retirement_note_id,result.note.id);
 const personal=ownPayment(f.supplier,bill.payment_id!),ownRequest=ownRequests(f.supplier).find(item=>item.id===requestId)!;assert.equal(personal.delivered_amount,"0");assert.equal(personal.status,"cancelled");assert.equal(personal.remaining_amount,"0");assert.equal(personal.creditRetirement!.acceptedCreditAmount,bill.amount);assert.equal(personal.creditRetirement!.retiredAmount,bill.amount);assert.equal(ownRequest.acceptedCreditUSDC,bill.amount);assert.equal(ownRequest.remainingUSDC,"0");assert.equal(ownRequest.billStatus,"credited");
 const insights=financeInsights(f.access);assert.equal(insights.coverage.unpreparedInvoiceUSDC,"0");assert.equal(insights.coverage.shortfallUSDC,"0");assert.equal(insights.cash.available,"50000000");
 const key=createIntegrationCredential(f.access,{name:"Accounting reader",principalUserId:f.access.userId,scopes:["invoices:read","payments:read"],expiresAt:new Date(Date.now()+3600000).toISOString()}),principal=authenticateIntegration(`Bearer ${key.secret}`),machine=integrationResource(principal,"invoice",bill.id),payment=integrationResource(principal,"payment",bill.payment_id!);assert.ok(resourceOutputs.invoice.safeParse(machine).success);assert.ok(resourceOutputs.payment.safeParse(payment).success);assert.equal((machine as {acceptedCreditAmount:string}).acceptedCreditAmount,bill.amount);assert.equal((machine as {status:string}).status,"credited");
 const report=projectReports(f.access);assert.equal(report.projects.length,0);assert.ok(projectExport(f.access).split("\r\n")[0].endsWith('"accepted_supplier_credit_micro_usdc"'));
});

test("legacy arithmetic retains zero-credit behavior, and mixed exact reductions never become source spend",()=>{
 const payments=[{amount:"40000000",delivered_amount:"40000000",total_spent:"41000000",status:"paid"}];assert.deepEqual(liabilityTotals("100000000",payments,"10000000","20000000"),liabilityTotals("100000000",payments,"10000000","20000000","0"));const totals=liabilityTotals("100000000",payments,"10000000","20000000","30000000");assert.equal(totals.remaining,0n);assert.equal(totals.sourceSpent,41000000n);assert.equal(totals.delivered,40000000n);assert.equal(totals.netCost,1000000n);
 const f=fixture(),bill=f.invoice();getDb().prepare("UPDATE bills SET setoff_amount='10000000',funded_clearing_amount='20000000' WHERE id=?").run(bill.id);accepted(f,proposal(f,bill,"70000000").note);assert.equal(listBills(f.access)[0].status,"settled");assert.equal(getBillTerms(f.access,bill.id).paid,"0");assert.equal(getBillTerms(f.access,bill.id).acceptedCreditAmount,"70000000");
});

test("actual authenticated routes enforce origin, sessions, current company access and sender-owned notes",async()=>{
 const f=fixture(),bill=f.invoice(),app=new Hono<AppEnv>();app.onError((error,c)=>error instanceof ApiError?c.json({code:error.code},error.status):error instanceof ZodError?c.json({code:"INVALID_INPUT"},422):c.json({code:"INTERNAL",error:error.message},500));app.route("/supplier-invoice-credits",supplierCreditRoutes);app.route("/organizations/:orgId/invoice-credits",companyCreditRoutes);
 const path="http://localhost:3000/supplier-invoice-credits",input={billId:bill.id,reference:randomUUID(),amount:bill.amount,unit:"USDC",reason:"Supplier agreed invoice correction",idempotencyKey:randomUUID()},headers={Cookie:`razor_session=${f.token}-supplier`,Origin:process.env.APP_URL!,"Content-Type":"application/json"};
 assert.equal((await app.request(path,{method:"POST",body:JSON.stringify(input),headers:{...headers,Origin:"https://wrong.invalid"}})).status,403);assert.equal((await app.request(path)).status,401);
 const response=await app.request(path,{method:"POST",headers,body:JSON.stringify(input)});assert.equal(response.status,200,await response.clone().text());const note=(await response.json()).note;
 assert.equal((await app.request(`${path}/${note.id}`,{headers:{Cookie:`razor_session=${f.token}-stranger`}})).status,404);
 const companyPath=`http://localhost:3000/organizations/${f.access.organizationId}/invoice-credits/${note.id}`,reviewResponse=await app.request(`${companyPath}/review`,{headers:{Cookie:`razor_session=${f.token}`}});assert.equal(reviewResponse.status,200);const review=await reviewResponse.json();assert.equal(review.totals.residualLiability,"0");
 getDb().prepare("DELETE FROM sessions WHERE user_id=?").run(f.access.userId);assert.equal((await app.request(`${companyPath}/accept`,{method:"POST",headers:{...headers,Cookie:`razor_session=${f.token}`},body:JSON.stringify({expectedVersion:1,reviewHash:review.reviewHash,acknowledgeDraftRetirement:true,idempotencyKey:randomUUID()})})).status,401);assert.equal(getBillTerms(f.access,bill.id).acceptedCreditAmount,"0");
});

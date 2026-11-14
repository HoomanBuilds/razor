import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { createBill, approveBill, listBills } from "../src/server/business/service";
import { addBillInstallment, getBillTerms, setBillTerms } from "../src/server/business/bill-terms";
import { managedPaymentReview, replaceCancelledPayment } from "../src/server/payment-management/service";
import { paymentSummary } from "../src/server/payments/service";
import { projectExport, projectReports } from "../src/server/projects/service";
import { liabilityTotals } from "../src/server/reconciliation/liability";
import { accountingExport } from "../src/server/reconciliation/export";
import { fundedClearingExportRows } from "../src/server/clearing/funded-accounting";
import { ownPayment, ownRequests } from "../src/server/recipient-workspace/service";
import { financeInsights } from "../src/server/assistant/finance/service";
import { parseCsv } from "../src/lib/csv";
import { approveCommitment, consumeBillCommitment, createCommitment, getCommitment, reviewCommitment } from "../src/server/vendor-commitments/service";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="d6".repeat(32);
const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
function fixture(){
 const db=getDb(),id=randomUUID(),other=randomUUID(),recipientId=randomUUID(),at=new Date().toISOString();
 for(const user of [id,other]){db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(user,at);db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(user,user,at,at);}
 db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'business','USDC','near','supplier.near','confirmed',?,?,?)").run(recipientId,id,other,encrypt("Original supplier"),at,at,at);
 db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,'50000000','0','0',?)").run(id,at);
 const access:AccessContext={userId:id,organizationId:id,permissions:["company:read","company:manage","payments:read","payments:prepare","payments:approve","reports:read"]};
 const invoice=(amount="100000000",extra={})=>createBill(access,{recipientId,reference:randomUUID(),title:"Original invoice",amount,maxFee:"0",projectReference:"Delivery",costCenterReference:"Operations",...extra});
 return {access,other,recipientId,at,invoice};
}
function discharge(f:ReturnType<typeof fixture>,bill:ReturnType<typeof createBill>,amount=bill.amount){
 const db=getDb(),round=randomUUID(),link=randomUUID(),at=new Date().toISOString(),manifest=randomUUID(),block=randomUUID();
 db.prepare("UPDATE payments SET status='cancelled',hold_reason='Retired into funded escrow rights' WHERE id=?").run(bill.payment_id!);
 db.prepare("UPDATE bills SET funded_clearing_amount=?,payment_id=NULL,status='cleared',accepted_at=NULL WHERE id=?").run(amount,bill.id);
 db.prepare("INSERT INTO clearing_rounds(id,manifest_hash,manifest_json,status,network,contract_id,created_by,created_at,expires_at,mode) VALUES(?,?,'{}','cleared','testnet','fixture.testnet',?,?,?,'cash_backed_native_v1')").run(round,manifest,f.access.userId,at,new Date(Date.now()+3600000).toISOString());
 db.prepare("INSERT INTO clearing_links(id,debtor_id,creditor_id,bill_id,payment_id,terms_hash,terms_ciphertext,starts_at,expires_at,status,offered_by,created_at) VALUES(?,?,?,?,?,'fixture',?,?,?,'cleared',?,?)").run(link,f.access.organizationId,f.other,bill.id,bill.payment_id!,encrypt("{}"),at,new Date(Date.now()+3600000).toISOString(),f.access.userId,at);
 db.prepare("INSERT INTO clearing_funded_discharges(id,round_id,link_id,organization_id,bill_id,original_payment_id,amount,mode,manifest_hash,proof_block_hash,proof_block_height,created_at) VALUES(?,?,?,?,?,?,?,'cash_backed_native_v1',?,?,'7',?)").run(randomUUID(),round,link,f.access.organizationId,bill.id,bill.payment_id!,amount,manifest,block,at);
 return {round,link,manifest,block};
}

test("shared liability arithmetic subtracts delivery, noncash setoff and funded discharge independently with a legacy zero default",()=>{
 const payments=[{amount:"20000000",delivered_amount:"20000000",total_spent:"21000000",status:"paid"},{amount:"40000000",delivered_amount:"0",total_spent:"0",status:"draft"}];
 const legacy=liabilityTotals("100000000",payments,"10000000");assert.deepEqual(legacy,liabilityTotals("100000000",payments,"10000000","0"));
 const funded=liabilityTotals("100000000",payments,"10000000","30000000");
 assert.equal(funded.remaining,40000000n);assert.equal(funded.unprepared,0n);assert.equal(funded.delivered,20000000n);assert.equal(funded.sourceSpent,21000000n);assert.equal(funded.netCost,1000000n);
 assert.equal(liabilityTotals("9007199254740993",[],"0","9007199254740992").remaining,1n);
});

test("a funded-cleared invoice keeps face value and separate proof while exposing no new liability or false delivery",()=>{
 const f=fixture(),bill=f.invoice(),before=JSON.stringify(row("SELECT * FROM treasury_balances WHERE organization_id=?",f.access.organizationId)),proof=discharge(f,bill);
 const terms=getBillTerms(f.access,bill.id),listed=listBills(f.access)[0],summary=paymentSummary(f.access);
 assert.equal(terms.amount,"100000000");assert.equal(terms.paid,"0");assert.equal(terms.setoffAmount,"0");assert.equal(terms.fundedClearingAmount,"100000000");assert.equal(terms.remainingLiability,"0");assert.equal(terms.uncommitted,"0");
 assert.equal(terms.fundedClearingDischarges.length,1);assert.equal(terms.fundedClearingDischarges[0].round_id,proof.round);assert.equal(terms.fundedClearingDischarges[0].proof_block_hash,proof.block);
 assert.equal(listed.status,"cleared");assert.equal(listed.deliveredAmount,"0");assert.equal(listed.fundedClearingAmount,"100000000");assert.equal(listed.remainingLiability,"0");
 assert.equal(summary.openPrincipal,"0");assert.equal(summary.uncommittedInvoicePrincipal,"0");assert.equal(summary.unreservedBudget,"0");assert.equal(summary.openCount,0);assert.equal(summary.paidCount,0);assert.deepEqual(summary.attention,[]);
 assert.equal(JSON.stringify(row("SELECT * FROM treasury_balances WHERE organization_id=?",f.access.organizationId)),before);
 const original=row<{amount:string;status:string;delivered_amount:string;total_spent:string}>("SELECT amount,status,delivered_amount,total_spent FROM payments WHERE id=?",bill.payment_id!)!;
 assert.deepEqual({...original},{amount:"100000000",status:"cancelled",delivered_amount:"0",total_spent:"0"});
});

test("fully discharged bills cannot mint installments, change terms, reapprove or replace retired original obligations",async()=>{
 const f=fixture(),bill=f.invoice();discharge(f,bill);const count=row<{count:number}>("SELECT COUNT(*) count FROM payments WHERE organization_id=?",f.access.organizationId)!.count;
 assert.throws(()=>addBillInstallment(f.access,bill.id,{amount:"1",maxFee:"0"}),code("CLEARED_LIABILITY"));
 assert.throws(()=>setBillTerms(f.access,bill.id,{paymentAmount:"1",maxFee:"0",requiresAcceptance:false}),code("CLEARED_LIABILITY"));
 assert.throws(()=>approveBill(f.access,bill.id),code("CLEARED_LIABILITY"));
 assert.equal(managedPaymentReview(f.access,bill.payment_id!).canReplace,false);
 const fetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("A retired invoice must not reach any provider");};
 try{await assert.rejects(()=>replaceCancelledPayment(f.access,bill.payment_id!,"A funded discharge is not a cancelled unpaid liability"),code("CLEARED_LIABILITY"));assert.equal(calls,0);}finally{globalThis.fetch=fetch;}
 assert.equal(row<{count:number}>("SELECT COUNT(*) count FROM payments WHERE organization_id=?",f.access.organizationId)!.count,count);
});

test("mixed delivery and both discharge categories retain exact residual installment bounds and accurate bill statuses",()=>{
 const f=fixture(),bill=f.invoice(),db=getDb();
 db.prepare("UPDATE payments SET amount='20000000',status='paid',delivered_amount='20000000',total_spent='21000000' WHERE id=?").run(bill.payment_id!);
 db.prepare("UPDATE bills SET setoff_amount='10000000',funded_clearing_amount='30000000' WHERE id=?").run(bill.id);
 const terms=getBillTerms(f.access,bill.id);assert.equal(terms.paid,"20000000");assert.equal(terms.setoffAmount,"10000000");assert.equal(terms.fundedClearingAmount,"30000000");assert.equal(terms.remainingLiability,"40000000");assert.equal(terms.uncommitted,"40000000");
 assert.equal(listBills(f.access)[0].status,"partially_settled");assert.equal(paymentSummary(f.access).openPrincipal,"40000000");
 assert.throws(()=>addBillInstallment(f.access,bill.id,{amount:"40000001",maxFee:"0"}),code("INSTALLMENT_EXCEEDS_BALANCE"));
 const next=addBillInstallment(f.access,bill.id,{amount:"40000000",maxFee:"0"});assert.equal(next.uncommitted,"0");
 assert.throws(()=>setBillTerms(f.access,bill.id,{paymentAmount:"40000001",maxFee:"0",requiresAcceptance:false}),code("INSTALLMENT_EXCEEDS_BALANCE"));
 db.prepare("UPDATE payments SET status='paid',delivered_amount=amount,total_spent=amount WHERE id=?").run(next.payment_id!);
 assert.equal(getBillTerms(f.access,bill.id).remainingLiability,"0");assert.equal(listBills(f.access)[0].status,"settled");
});

test("project and cost-center exports distinguish escrow-backed discharge from noncash debt, revenue and source spending",()=>{
 const f=fixture(),bill=f.invoice(),db=getDb();db.prepare("UPDATE bills SET setoff_amount='20000000' WHERE id=?").run(bill.id);const proof=discharge(f,bill,"80000000");
 db.prepare("INSERT INTO clearing_funded_accounts(round_id,organization_id,destination,deposit_due,credit_due,credit_available,pending_json) VALUES(?,?,'owner.testnet','0','90000000','90000000',?)").run(proof.round,f.access.organizationId,JSON.stringify({kind:"credit",amount:"90000000"}));
 const report=projectReports(f.access);
 for(const value of [report.projects[0],report.costCenters[0]]){assert.equal(value.dischargedDebt,"20000000");assert.equal(value.fundedDischargedDebt,"80000000");assert.equal(value.remainingLiability,"0");assert.equal(value.unpreparedLiability,"0");assert.equal(value.earnedReceipts,"0");assert.equal(value.sourceSpent,"0");assert.equal(value.settledPayments,"0");assert.equal(value.cashResult,"0");assert.equal(value.openBudget,"0");}
 const [header,project]=projectExport(f.access).split("\r\n"),columns=header.split(",");assert.equal(columns[8],'"debt_discharged_without_cash_micro_usdc"');assert.equal(columns[columns.length-2],'"escrow_backed_debt_discharge_micro_usdc"');assert.equal(columns.at(-1),'"accepted_supplier_credit_micro_usdc"');assert.ok(project.endsWith(',"80000000","0"'));
 assert.equal(paymentSummary(f.access).treasury.available,"50000000");
});

test("funded proof details and amounts stay company-scoped and do not reuse another company's invoice IDs",()=>{
 const f=fixture(),other=fixture(),bill=f.invoice(),otherBill=other.invoice(),proof=discharge(f,bill),otherProof=discharge(other,otherBill);
 assert.throws(()=>getBillTerms(other.access,bill.id),code("NOT_FOUND"));
 assert.equal(listBills(f.access).length,1);assert.equal(getBillTerms(f.access,bill.id).fundedClearingDischarges.length,1);
 assert.equal(getBillTerms(f.access,bill.id).fundedClearingDischarges[0].round_id,proof.round);assert.notEqual(getBillTerms(f.access,bill.id).fundedClearingDischarges[0].round_id,otherProof.round);
 assert.equal(projectReports(f.access).projects[0].fundedDischargedDebt,"100000000");
});

test("commercial purchase consumption remains permanent and unchanged after a funded discharge",()=>{
 const f=fixture(),date=new Date().toISOString().slice(0,10),year=Number(date.slice(0,4));
 const proposal=createCommitment(f.access,{recipientId:f.recipientId,reference:randomUUID(),settlementUnit:"USDC",scope:"Agreed original service quantity",allowance:"100000000",cadence:"total",startsOn:`${year-1}-01-01`,endsOn:`${year+1}-12-31`,targetState:"active",reason:"Approved purchase scope"});
 const commitment=approveCommitment(f.access,proposal.id,reviewCommitment(f.access,proposal.id).reviewToken);
 const bill=f.invoice("100000000",{commitmentReference:commitment.reference,commitmentDate:date,commitmentScopeConfirmed:true});consumeBillCommitment(f.access,bill.id);
 const uses=JSON.stringify(rows("SELECT * FROM vendor_commitment_uses WHERE bill_id=?",bill.id));discharge(f,bill);
 assert.equal(getCommitment(f.access,commitment.id).used,"100000000");assert.equal(JSON.stringify(rows("SELECT * FROM vendor_commitment_uses WHERE bill_id=?",bill.id)),uses);
 assert.throws(()=>approveBill(f.access,bill.id),code("CLEARED_LIABILITY"));assert.equal(row<{amount:string}>("SELECT amount FROM bills WHERE id=?",bill.id)!.amount,"100000000");
});

test("unfunded legacy invoices preserve zero-funded defaults and ordinary installment eligibility",()=>{
 const f=fixture(),bill=f.invoice();const terms=getBillTerms(f.access,bill.id),listed=listBills(f.access)[0];
 assert.equal(terms.fundedClearingAmount,"0");assert.deepEqual(terms.fundedClearingDischarges,[]);assert.equal(terms.remainingLiability,bill.amount);assert.equal(listed.status,"draft");
 getDb().prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(bill.payment_id!);
 assert.equal(managedPaymentReview(f.access,bill.payment_id!).canReplace,true);
 assert.equal(addBillInstallment(f.access,bill.id,{amount:bill.amount,maxFee:"0"}).installments.length,2);
 assert.equal(projectReports(f.access).projects[0].fundedDischargedDebt,"0");
});

test("root-reader integration preserves funded CSV fields, personal history and finance coverage without inventing cash",()=>{
 const f=fixture(),bill=f.invoice(),proof=discharge(f,bill),db=getDb(),requestId=randomUUID();
 db.prepare("INSERT INTO recipient_invoice_requests(id,organization_id,recipient_id,submitted_by,reference_hash,source_fingerprint,payload_ciphertext,status,bill_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'prepared',?,?,?)").run(requestId,f.access.organizationId,f.recipientId,f.other,randomUUID(),"ab".repeat(32),encrypt(JSON.stringify({recipientId:f.recipientId,reference:bill.reference,amount:"100",currency:"USDC",lineItems:[{description:"Original services",quantity:"1",unitPrice:"100"}]})),bill.id,f.at,f.at);
 db.prepare("INSERT INTO clearing_funded_accounts(round_id,organization_id,destination,deposit_due,credit_due,deposited,refund_available,pending_json) VALUES(?,?,'owner.testnet','10000000','0','10000000','0',?)").run(proof.round,f.access.organizationId,JSON.stringify({kind:"credit",amount:"0"}));
 const exported=parseCsv(accountingExport(f.access)),invoice=exported.find(item=>item.record_type==="invoice"&&item.bill_id===bill.id)!,fundedRows=fundedClearingExportRows(f.access.organizationId);
 const allFundedExportFieldsPreserved=fundedRows.every(expected=>{const actual=exported.find(item=>item.record_type===expected.record_type&&item.clearing_round_id===expected.clearing_round_id);return !!actual&&Object.entries(expected).every(([key,value])=>actual[key]===String(value??""));});
 const personal=ownPayment(f.other,bill.payment_id!) as ReturnType<typeof ownPayment>&{fundedClearing?:{amount:string}},request=ownRequests(f.other).find(item=>item.id===requestId)! as ReturnType<typeof ownRequests>[number]&{fundedDischargeUSDC?:string},insights=financeInsights(f.access);
 assert.deepEqual({csvFunded:invoice.funded_discharge_micro_usdc,csvSetoff:invoice.setoff_micro_usdc,csvDelivered:invoice.delivered_entitlement_usdc,csvRemaining:invoice.remaining_entitlement_usdc,csvUnprepared:invoice.unprepared_liability_usdc,allFundedExportFieldsPreserved,personalFunded:personal.fundedClearing?.amount,personalDelivered:personal.delivered_amount,personalRemaining:personal.remaining_amount,personalStatus:personal.status,requestFunded:request.fundedDischargeUSDC,requestDelivered:request.settledUSDC,requestRemaining:request.remainingUSDC,requestStatus:request.billStatus,unprepared:insights.coverage.unpreparedInvoiceUSDC,shortfall:insights.coverage.shortfallUSDC,available:insights.cash.available},{csvFunded:"100000000",csvSetoff:"0",csvDelivered:"0",csvRemaining:"0",csvUnprepared:"0",allFundedExportFieldsPreserved:true,personalFunded:"100000000",personalDelivered:"0",personalRemaining:"0",personalStatus:"cancelled",requestFunded:"100000000",requestDelivered:"0",requestRemaining:"0",requestStatus:"cleared",unprepared:"0",shortfall:"0",available:"50000000"});
});

import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { getRecipient, saveVersion } from "../src/server/identity/recipients";
import { PERMISSIONS } from "../src/server/identity/session";
import { createBill, createPayrollRun } from "../src/server/business/service";
import { reconciliationQueue } from "../src/server/reconciliation/service";
import { accountingExport } from "../src/server/reconciliation/export";
import { parseCsv } from "../src/lib/csv";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="76".repeat(32);

test("accounting summaries reconcile partial lineage without double-counting transferred debt or changing historical payee names",()=>{
  const db=getDb(),now=new Date().toISOString(),access={userId:"accountant",organizationId:"accounting-company",permissions:PERMISSIONS};
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Accountant',?)").run(access.userId,now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Accounting',?,?,?)").run(access.organizationId,access.userId,now,now);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'contractor','USDC','near','original.near','confirmed',?,?,?)").run("supplier",access.organizationId,access.userId,encrypt("Original supplier"),now,now,now);
  saveVersion(getRecipient(access.organizationId,"supplier"),access.userId);
  const bill=createBill(access,{recipientId:"supplier",reference:"INV-PARTIAL",title:"Services",amount:"100000000",maxFee:"2000000"});
  db.prepare("UPDATE payments SET status='partially_paid',delivered_amount='40000000',total_spent='41000000' WHERE id=?").run(bill.payment_id);
  function remainder(id:string,parent:string,paid=false){
    db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,delivered_amount,total_spent,created_at,updated_at) VALUES(?,?,'supplier','payment',?,'60000000','1000000',?,1,'{}',?,?,?,?)").run(id,access.organizationId,id,paid?"paid":"draft",paid?"60000000":"0",paid?"61000000":"0",now,now);
    db.prepare("INSERT INTO partial_remainders(original_payment_id,organization_id,remainder_payment_id,remaining_usdc,created_by,created_at) VALUES(?,?,?,'60000000',?,?)").run(parent,access.organizationId,id,access.userId,now);
  }
  remainder("invoice-remainder",bill.payment_id!);
  db.prepare("INSERT INTO bill_installments(id,bill_id,payment_id,created_at) VALUES('invoice-remainder-link',?,'invoice-remainder',?)").run(bill.id,now);
  db.prepare("UPDATE bills SET payment_id='invoice-remainder' WHERE id=?").run(bill.id);
  const run=createPayrollRun(access,{reference:"November work",periodStart:"2026-11-01",periodEnd:"2026-11-30",items:[{recipientId:"supplier",amount:"100000000",maxFee:"2000000"}]});
  const original=run.items[0].payment!.id;
  db.prepare("UPDATE payments SET status='partially_paid',delivered_amount='40000000',total_spent='41000000' WHERE id=?").run(original);
  remainder("payroll-remainder",original,true);
  db.prepare("UPDATE payroll_items SET payment_id='payroll-remainder' WHERE id=?").run(run.items[0].id);
  db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_symbol,destination_decimals,destination_network,destination_address,expected_output,observed_output,amount_in,deposit_address,reconciliation,created_at,updated_at) VALUES('partial-output',?,?,'primary','partially_delivered','{}','fixture-token','TEST',8,'base','fixture-address','100000000','95000000','41000000','fixture-deposit',?,?,?)").run(bill.payment_id,access.organizationId,JSON.stringify({provider:{swapDetails:{amountOut:"95000000"}},chain:{attempts:[{id:"partial-output",status:"partially_delivered",actual_output:"95000000",credited_amount:"40000000",receipt:"fixture-commitment"}]}}),now,now);
  db.prepare("UPDATE recipients SET name=?,version=2 WHERE id='supplier'").run(encrypt("New directory name"));
  saveVersion(getRecipient(access.organizationId,"supplier"),access.userId);
  const records=parseCsv(accountingExport({...access,permissions:["reports:read"]}));
  const invoice=records.find(record=>record.record_type==="invoice")!;
  assert.equal(invoice.entitlement_usdc,"100");assert.equal(invoice.delivered_entitlement_usdc,"40");assert.equal(invoice.remaining_entitlement_usdc,"60");assert.equal(invoice.unprepared_liability_usdc,"0");assert.equal(invoice.recorded_source_spent_usdc,"41");assert.equal(invoice.recorded_net_cost_usdc,"1");
  const payroll=records.find(record=>record.record_type==="payroll_item")!;
  assert.equal(payroll.delivered_entitlement_usdc,"100");assert.equal(payroll.remaining_entitlement_usdc,"0");assert.equal(payroll.recorded_source_spent_usdc,"102");assert.equal(payroll.recorded_net_cost_usdc,"2");assert.equal(payroll.period_start,"2026-11-01");
  const retired=records.find(record=>record.record_type==="obligation"&&record.payment_id===bill.payment_id)!;
  assert.equal(retired.remaining_entitlement_usdc,"0");assert.equal(retired.unpaid_recorded_entitlement_usdc,"60");assert.equal(retired.successor_payment_id,"invoice-remainder");assert.equal(retired.recipient_name,"Original supplier");
  const output=records.find(record=>record.record_type==="attempt")!;
  assert.equal(output.destination_decimals,"8");assert.equal(output.quoted_output,"1");assert.equal(output.observed_output,"0.95");assert.equal(output.attested_output,"0.95");assert.equal(output.provider_reported_output,"0.95");
  assert.equal(reconciliationQueue(access).payments.find(record=>record.payment.id==="invoice-remainder")!.payment.recipientName,"Original supplier");
  assert.ok(!records.some(record=>record.recipient_name==="New directory name"));
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { getDb, row } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { PERMISSIONS } from "../src/server/identity/session";
import { createBill, approveBill, createPayrollRun, approvePayrollRun, getPayrollRun } from "../src/server/business/service";
import { getBillTerms, setBillTerms } from "../src/server/business/bill-terms";
import { getPayment, reconcilePayment, prepareSettlement, preparePaymentQuote, revalidatePaymentRecipient, getTreasury } from "../src/server/payments/service";
import { createRemainder, partialReview, approveRemainder } from "../src/server/partial-settlement/service";
import { completeDelivery, deliveryOutput, outputAmount, spentSource } from "../src/server/partial-settlement/model";
import { partialProof } from "../src/server/partial-settlement/proof";
import { cancelManagedPayment, replaceCancelledPayment } from "../src/server/payment-management/service";
import { createClientReserve } from "../src/server/client-reserves/service";
import { reservePositions, clientReserveTotals } from "../src/server/client-reserves/accounting";
import { paymentBudget } from "../src/lib/payment-budget";
import { accountingExport } from "../src/server/reconciliation/export";
import { reconciliationQueue } from "../src/server/reconciliation/service";
import { projectReports } from "../src/server/projects/service";
import { encrypt } from "../src/server/identity/crypto";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { ChainAttempt, ChainPayment, Payment, PayoutAttempt } from "../src/server/payments/types";
import type { StatusResponse } from "../src/server/payments/intents";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "41".repeat(32);
process.env.NEAR_TREASURY_CODE_HASH = "11111111111111111111111111111111";
const originalFetch = globalThis.fetch, chains = new Map<string, ChainPayment>();
globalThis.fetch = async (url, init) => {
  if (String(url).includes("/v0/status?")) return Response.json({ status: "PROCESSING", quoteResponse: {} });
  const request = JSON.parse(String(init?.body)), params = request.params;
  assert.equal(request.method, "query");
  if (params.request_type === "view_account") return Response.json({ result: { code_hash: process.env.NEAR_TREASURY_CODE_HASH } });
  const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
  let value: unknown;
  if (params.method_name === "get_payment") value = chains.get(args.payment_id) ?? null;
  else {
    const company = row<{organization_id:string}>("SELECT organization_id FROM treasury_config WHERE near_account_id=?", params.account_id)!;
    const cash = row<{balance:string}>("SELECT balance FROM treasury_balances WHERE organization_id=?", company.organization_id)!;
    value = {balance:cash.balance,reserved:"0",available:cash.balance,in_flight:"0",confirmed_at_ms:String(Date.now())};
  }
  return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
};
after(() => { globalThis.fetch = originalFetch; });

function fixture(kind: "bill" | "payroll" = "payroll", earmark = false) {
  const id=randomUUID(),recipientId=randomUUID(),savedAt=new Date().toISOString(),db=getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id,savedAt);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id,id,savedAt,savedAt);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'nep141:eth.omft.near','eth','0x1212121212121212121212121212121212121212','confirmed',?,?,?)").run(recipientId,id,"Payee",kind==="payroll"?"employee":"business",savedAt,savedAt,savedAt);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(id,`company-${id.slice(0,8)}.near`,NATIVE_USDC.near,savedAt);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,'1000000000','0','0',?)").run(id,savedAt);
  const access:AccessContext={organizationId:id,userId:id,permissions:[...PERMISSIONS]};
  let paymentId:string,billId:string|null=null,runId:string|null=null;
  if(kind==="bill") {const bill=createBill(access,{recipientId,reference:randomUUID(),title:"Services",amount:"100000000",maxFee:"5000000",projectReference:"Project"});billId=bill.id;paymentId=bill.payment_id!;approveBill(access,bill.id);}
  else {const run=createPayrollRun(access,{reference:randomUUID(),periodStart:"2026-11-01",periodEnd:"2026-11-30",items:[{recipientId,amount:"100000000",maxFee:"5000000"}]});runId=run.id;paymentId=run.items[0].payment_id!;approvePayrollRun(access,run.id);}
  if(earmark)createClientReserve(access,{idempotencyKey:randomUUID(),amount:"100000000",purpose:"Client payroll principal",paymentId});
  const quote={quoteRequest:{originAsset:`nep141:${NATIVE_USDC.near}`,destinationAsset:"nep141:eth.omft.near",amount:"1000000000000000000",swapType:"EXACT_OUTPUT",recipient:"0x"+"12".repeat(20),refundTo:"company.near"},quote:{amountIn:"102000000",amountOut:"1000000000000000000",depositAddress:`solver-${id.slice(0,8)}.near`}};
  const attemptId=randomUUID(),receipt=`sha256:${createHash("sha256").update(attemptId).digest("hex")}`;
  db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,destination_decimals,destination_symbol,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','processing',?,'nep141:eth.omft.near','eth',?,18,'ETH','1000000000000000000','102000000',?,?,?)")
    .run(attemptId,paymentId,id,JSON.stringify(quote),quote.quoteRequest.recipient,quote.quote.depositAddress,savedAt,savedAt);
  db.prepare("UPDATE payments SET status='in_flight',reserved_amount='0',chain_reserved='0' WHERE id=?").run(paymentId);
  db.prepare("UPDATE treasury_balances SET balance='896000000',reserved='0',onchain_reserved='0' WHERE organization_id=?").run(id);
  const chainAttempt:ChainAttempt={id:attemptId,status:"partially_delivered",authorized:true,approvals:[],approval_policy_version:"1",use_backup:false,route:{kind:"intents",source_receiver:quote.quote.depositAddress,input_amount:"102000000",output_amount:quote.quote.amountOut,quote_id:"fixture",quote_hash:createHash("sha256").update(JSON.stringify(quote)).digest("hex"),deadline_ms:String(Date.now()+3600000)},refund_amount:"0",receipt,actual_output:"500000000000000000",credited_amount:"40000000"};
  const chain:ChainPayment={id:paymentId,reference:`razor:${paymentId}`,recipient_id:recipientId,amount:"100000000",max_fee:"5000000",reservation:"0",incurred_cost:"2000000",expires_at_ms:String(Date.now()+3600000),not_before_ms:"0",recipient_version:"1",policy_version:"1",approvals:[],status:"partially_paid",attempts:[chainAttempt]};
  chains.set(paymentId,chain);
  db.prepare("INSERT INTO partial_settlement_reviews(id,organization_id,payment_id,attempt_id,actual_output,credited_usdc,destination_tx_hash,receipt_commitment,evidence_ciphertext,created_by,created_at) VALUES(?,?,?,?,?,'40000000','fixture-destination',?,?,?,?)")
    .run(randomUUID(),id,paymentId,attemptId,chainAttempt.actual_output!,receipt,encrypt("Simulated reviewed partial evidence"),id,savedAt);
  return {access,paymentId,recipientId,attemptId,billId,runId,chain,chainAttempt,attempt:row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE id=?",attemptId)!};
}

function provider(actual?: string):StatusResponse { return {status:"SUCCESS",quoteResponse:{} as StatusResponse["quoteResponse"],swapDetails:actual===undefined?{}:{amountOut:actual}}; }

test("success never implies complete delivery without exact output and full NEAR credit",()=>{
  const f=fixture(),payment=getPayment(f.access,f.paymentId);
  for(const actual of [undefined,"0","1","500000000000000000"])assert.equal(completeDelivery(payment,f.attempt,{...f.chainAttempt,status:"delivered",actual_output:actual,credited_amount:payment.amount},provider(actual),false),false);
  assert.equal(deliveryOutput(f.attempt,provider("9007199254740993")).actual,"9007199254740993");
  assert.equal(outputAmount((1n<<128n).toString()),null);
  assert.equal(completeDelivery(payment,f.attempt,{...f.chainAttempt,status:"delivered",actual_output:f.attempt.expected_output,credited_amount:payment.amount},provider(f.attempt.expected_output),false),true);
  assert.equal(spentSource({...f.chain,status:"in_flight"},f.attempt,{...f.chainAttempt,status:"source_sent"}),"104000000");
});

test("terminal partial proof binds the exact review before atomic credit and immutable source retirement",async()=>{
  const f=fixture(),payment=getPayment(f.access,f.paymentId);
  assert.throws(()=>partialProof(payment,f.attempt,{...f.chain,status:"in_flight"},f.chainAttempt),/authoritatively closed/);
  assert.throws(()=>partialProof(payment,f.attempt,f.chain,{...f.chainAttempt,credited_amount:"50000000"}),/exact terminal/);
  const result=await reconcilePayment(f.access,f.paymentId);
  assert.equal(result.payment.status,"partially_paid");assert.equal(result.payment.delivered_amount,"40000000");assert.equal(result.payment.total_spent,"104000000");
  assert.equal(paymentBudget(result.payment).remaining,0n);
  assert.throws(()=>getDb().prepare("UPDATE payments SET status='approved' WHERE id=?").run(f.paymentId),/PARTIAL_LIABILITY/);
  await assert.rejects(prepareSettlement(f.access,f.attemptId,{outcome:"delivered",receipt:"Cannot over-credit"}),/terminal partial/);
  await assert.rejects(preparePaymentQuote(f.access,f.paymentId,{useBackup:true}),/Approve an unpaid/);
  const queue=reconciliationQueue(f.access);assert.equal(queue.totals.unresolvedEntitlementMicroUsdc,"60000000");
  const csv=accountingExport(f.access);assert.match(csv,/terminal_partial_settlement/);assert.match(csv,/no_automatic_cross_asset_conversion/);
});

test("payroll remainder uses fresh recipient terms, exact approval and full pay-period lineage",async()=>{
  const f=fixture();await reconcilePayment(f.access,f.paymentId);
  getDb().prepare("UPDATE recipients SET version=2,primary_address='0x3434343434343434343434343434343434343434' WHERE id=?").run(f.recipientId);
  const reviewed=partialReview(f.access,f.paymentId),created=await createRemainder(f.access,f.paymentId,{reviewToken:reviewed.reviewToken,maxFee:"1000000"});
  assert.equal(created.payment.amount,"60000000");assert.equal(created.payment.status,"draft");assert.equal(created.payment.recipient_version,2);
  assert.equal((await createRemainder(f.access,f.paymentId,{reviewToken:reviewed.reviewToken,maxFee:"1000000"})).payment.id,created.payment.id);
  const stale=partialReview(f.access,f.paymentId);
  getDb().prepare("UPDATE recipients SET version=3 WHERE id=?").run(f.recipientId);
  assert.throws(()=>approveRemainder(f.access,f.paymentId,stale.reviewToken),/Review the exact/);
  revalidatePaymentRecipient(f.access,created.payment.id);
  const approved=approveRemainder(f.access,f.paymentId,partialReview(f.access,f.paymentId).reviewToken);
  assert.equal(approved.payment.amount,"60000000");assert.ok(approved.payment.approved_at);
  let run=getPayrollRun(f.access,f.runId!);assert.equal(run.items[0].amount,"100000000");assert.equal(run.items[0].deliveredAmount,"40000000");assert.equal(run.items[0].remainingLiability,"60000000");
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount,total_spent='61000000',reserved_amount='0' WHERE id=?").run(created.payment.id);
  run=getPayrollRun(f.access,f.runId!);assert.equal(run.status,"paid");assert.equal(run.items[0].remainingLiability,"0");assert.equal(run.items[0].spent,"165000000");
});

test("canceled payroll and invoice remainders follow fresh replacements without restoring face liability",async()=>{
  for(const kind of ["payroll","bill"] as const){
    const f=fixture(kind);await reconcilePayment(f.access,f.paymentId);
    const child=(await createRemainder(f.access,f.paymentId,{reviewToken:partialReview(f.access,f.paymentId).reviewToken,maxFee:"1000000"})).payment;
    await cancelManagedPayment(f.access,child.id);
    const replacement=await replaceCancelledPayment(f.access,child.id,"Recipient profile requires a freshly reviewed remainder");
    assert.equal(replacement.payment.amount,"60000000");assert.equal(partialReview(f.access,f.paymentId).remainder?.id,replacement.payment.id);
    if(f.billId){
      assert.throws(()=>setBillTerms(f.access,f.billId!,{paymentAmount:"50000000",maxFee:"1000000",requiresAcceptance:false}),/exact unpaid entitlement/);
      assert.throws(()=>setBillTerms(f.access,f.billId!,{paymentAmount:"60000000",maxFee:"2000000",requiresAcceptance:false}),/original routing ceiling/);
      assert.equal(getPayment(f.access,replacement.payment.id).amount,"60000000");assert.equal(getPayment(f.access,replacement.payment.id).max_fee,"1000000");
    }
    approveRemainder(f.access,f.paymentId,partialReview(f.access,f.paymentId).reviewToken);
    if(f.runId)assert.equal(row<{status:string}>("SELECT status FROM payroll_runs WHERE id=?",f.runId)!.status,"draft");
    if(f.billId){const terms=getBillTerms(f.access,f.billId);assert.equal(terms.amount,"100000000");assert.equal(terms.paid,"40000000");assert.equal(terms.uncommitted,"0");assert.equal(projectReports(f.access).projects[0].sourceSpent,"104000000");}
  }
});

test("client principal follows the active remainder without duplicating reservations or in-flight cash",async()=>{
  const f=fixture("payroll",true);await reconcilePayment(f.access,f.paymentId);
  const child=(await createRemainder(f.access,f.paymentId,{reviewToken:partialReview(f.access,f.paymentId).reviewToken,maxFee:"0"})).payment;
  getDb().prepare("UPDATE payments SET status='approved',reserved_amount='60000000' WHERE id=?").run(child.id);
  getDb().prepare("UPDATE treasury_balances SET balance='60000000',reserved='60000000' WHERE organization_id=?").run(f.access.organizationId);
  let position=reservePositions(f.access.organizationId)[0];assert.equal(position.activePaymentId,child.id);assert.equal(position.outstanding,60000000n);assert.equal(position.paymentCovered,60000000n);assert.equal(position.clientReserved,0n);assert.equal(getTreasury(f.access).totalReserved,"60000000");
  const at=randomUUID(),savedAt=new Date().toISOString(),quote="{}",chain={...f.chain,id:child.id,amount:child.amount,status:"in_flight",attempts:[{...f.chainAttempt,id:at,status:"source_sent",actual_output:"0",credited_amount:"0",route:{...f.chainAttempt.route,input_amount:child.amount,output_amount:"600000",source_receiver:"solver.near",quote_hash:createHash("sha256").update(quote).digest("hex")}}]};
  getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,reconciliation,created_at,updated_at) VALUES(?,?,?,'primary','processing',?,'USDC','near','supplier.near','600000',?,'solver.near',?,?,?)").run(at,child.id,f.access.organizationId,quote,child.amount,JSON.stringify({chain}),savedAt,savedAt);
  getDb().prepare("UPDATE payments SET status='in_flight',reserved_amount='0' WHERE id=?").run(child.id);
  getDb().prepare("UPDATE treasury_balances SET balance='0',reserved='0' WHERE organization_id=?").run(f.access.organizationId);
  position=reservePositions(f.access.organizationId)[0];assert.equal(position.inFlight,60000000n);assert.equal(position.clientReserved,0n);assert.equal(clientReserveTotals(f.access.organizationId).clientPrincipalOutstanding,"60000000");
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(child.id);
  assert.equal(clientReserveTotals(f.access.organizationId).clientPrincipalOutstanding,"0");assert.equal(reservePositions(f.access.organizationId)[0].state,"closed");
});

test("a partial remainder cannot adopt another person's reassigned recipient profile",async()=>{
  const f=fixture(),db=getDb(),other=randomUUID(),savedAt=new Date().toISOString();
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(f.access.userId,f.recipientId);
  db.prepare("INSERT INTO recipient_versions(recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES(?,1,?,?,?)").run(f.recipientId,encrypt(JSON.stringify({name:"Payee",user_id:f.access.userId})),f.access.userId,savedAt);
  await reconcilePayment(f.access,f.paymentId);
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Other person',?)").run(other,savedAt);
  db.prepare("UPDATE recipients SET user_id=?,version=2,primary_address='0x3434343434343434343434343434343434343434' WHERE id=?").run(other,f.recipientId);
  await assert.rejects(createRemainder(f.access,f.paymentId,{reviewToken:partialReview(f.access,f.paymentId).reviewToken,maxFee:"1000000"}),/different person/);
  assert.equal(partialReview(f.access,f.paymentId).remainder,null);
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(f.access.userId,f.recipientId);
  const child=await createRemainder(f.access,f.paymentId,{reviewToken:partialReview(f.access,f.paymentId).reviewToken,maxFee:"1000000"});
  assert.equal(child.payment.amount,"60000000");assert.equal(child.payment.recipient_version,2);
});

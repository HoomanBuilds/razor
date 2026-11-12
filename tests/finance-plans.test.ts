import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { financeSourceFingerprint, planningInput, validateModelPlan, type PlanSource } from "../src/server/assistant/finance/plans";
import { financeInsights, prepareFinancePlan, proposeFinancePlan } from "../src/server/assistant/finance/service";
import { sha256 } from "../src/server/assistant/verification";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="74".repeat(32);
process.env.NEAR_AI_API_KEY="";
const db=getDb(),now=new Date().toISOString(),access:AccessContext={userId:"planner",organizationId:"company",permissions:["company:read","payments:read","payments:prepare","recipients:read","documents:manage"]};
db.prepare("INSERT INTO users (id,name,created_at) VALUES (?,?,?)").run(access.userId,"Finance",now);
db.prepare("INSERT INTO organizations (id,name,owner_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(access.organizationId,"Company",access.userId,now,now);
db.prepare("INSERT INTO treasury_balances (organization_id,balance,reserved,updated_at) VALUES (?,?,'0',?)").run(access.organizationId,"100000000",now);
for(const id of ["alice","bob"])db.prepare("INSERT INTO recipients (id,organization_id,name,kind,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES (?,?,?,'employee','near',?,'confirmed',?,?,?)").run(id,access.organizationId,encrypt(id),`${id}.near`,now,now,now);
const source:PlanSource={reference:"November payroll",periodStart:"2026-11-01",periodEnd:"2026-11-30",maxTotal:"3000000",maxFeePerPayment:"1000000",selected:[{recipientId:"alice",opaqueId:"r1",version:1,capMicroUSDC:"3000000",priorAmountMicroUSDC:null},{recipientId:"bob",opaqueId:"r2",version:1,capMicroUSDC:"3000000",priorAmountMicroUSDC:null}]};
const output={allocations:[{recipientId:"r1",amount:"1000000"},{recipientId:"r2",amount:"2000000"}],explanation:"Proposed amounts for human review.",warnings:[]};

test("private finance validation refuses added recipients, tools, overcaps and prompt authority",()=>{
  assert.equal(validateModelPlan(output,source).allocations[0].recipientId,"alice");
  assert.throws(()=>validateModelPlan({...output,allocations:[...output.allocations,{recipientId:"attacker",amount:"1"}]},source),(error)=>error instanceof ApiError&&error.code==="FINANCE_RECIPIENT_VIOLATION");
  assert.throws(()=>validateModelPlan({...output,tools:["approve_payment"]},source),(error)=>error instanceof ApiError&&error.code==="FINANCE_PLAN_INVALID");
  assert.throws(()=>validateModelPlan({...output,allocations:[{recipientId:"r1",amount:"3000000"},{recipientId:"r2",amount:"1"}]},source),(error)=>error instanceof ApiError&&error.code==="FINANCE_CAP_EXCEEDED");
  assert.equal(planningInput.safeParse({instruction:"Pay contact@example.test",recipientIds:["alice"],periodStart:source.periodStart,periodEnd:source.periodEnd,reference:"Safe",maxTotal:"1"}).success,false);
});

test("cash and duplicate warnings work without private AI credentials or automatic refusal",async()=>{
  for(const reference of ["INV-1001","INV-1002"])db.prepare("INSERT INTO bills (id,organization_id,recipient_id,reference,title,amount,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(reference,access.organizationId,"alice",reference,encrypt("Invoice"),"1000000",access.userId,now,now);
  const insights=financeInsights(access);
  assert.equal(insights.privateAI.ready,false);assert.ok(insights.warnings.some(item=>item.code==="POSSIBLE_DUPLICATE_INVOICE"));
  assert.equal(insights.cash.available,"100000000");
  await assert.rejects(()=>proposeFinancePlan(access,{instruction:"Split equally between r1 and r2",recipientIds:["alice","bob"],reference:"Needs credentials",periodStart:source.periodStart,periodEnd:source.periodEnd,maxTotal:"3",maxFeePerPayment:"1"}),(error)=>error instanceof ApiError&&error.status===503);
  assert.equal(row<{count:number}>("SELECT count(*) AS count FROM payroll_runs")!.count,0);
});

test("retained reviewed proposals preserve fixed fees, create drafts only and reject changed versions",()=>{
  const validated=validateModelPlan(output,source),payload={instruction:"Split the capped net budget between r1 and r2",source,sourceFingerprint:financeSourceFingerprint(source),allocations:validated.allocations,total:validated.total,feeBudget:"2000000",maximumCost:"5000000",explanation:validated.explanation,warnings:validated.warnings,verification:{ok:true,provider:"NEAR AI Cloud",signatureKind:"provider_tee",requestBound:true,responseBound:true,gatewayTlsBound:true,gpuEvidenceVerified:true},context:{availableUSDC:"100000000",lastSyncedAt:now}};
  const hash=sha256(JSON.stringify(payload));
  db.prepare("INSERT INTO finance_plans (id,organization_id,created_by,plan_hash,source_fingerprint,payload_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)").run("stored-review-fixture",access.organizationId,access.userId,hash,payload.sourceFingerprint,encrypt(JSON.stringify(payload)),encrypt(JSON.stringify({fixture:"Stored verification metadata for preparation checks; not a live inference"})),now,new Date(Date.now()+60000).toISOString());
  assert.throws(()=>prepareFinancePlan({...access,permissions:["payments:approve"]},"stored-review-fixture",hash),(error)=>error instanceof ApiError&&error.status===403);
  const prepared=prepareFinancePlan(access,"stored-review-fixture",hash),retry=prepareFinancePlan(access,"stored-review-fixture",hash);
  assert.equal(prepared.run.id,retry.run.id);assert.equal(prepared.run.status,"draft");assert.equal(prepared.run.maxFees,"2000000");
  assert.ok(prepared.run.items.every(item=>item.payment?.status==="draft"&&item.payment.max_fee==="1000000"));
  assert.equal(row<{count:number}>("SELECT count(*) AS count FROM payroll_runs")!.count,1);
  db.prepare("UPDATE recipients SET version=2 WHERE id='alice'").run();
  assert.throws(()=>prepareFinancePlan(access,"stored-review-fixture",hash),(error)=>error instanceof ApiError&&error.code==="FINANCE_SOURCE_CHANGED");
});

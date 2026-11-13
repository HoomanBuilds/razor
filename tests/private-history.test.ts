import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { invoiceDraftHistory } from "../src/server/assistant/service";
import { financePlanHistory } from "../src/server/assistant/finance/service";
import { privateHistoryQuery, privateHistoryWindow } from "../src/server/private-history";
import { ApiError } from "../src/server/context";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="78".repeat(32);

const access={userId:"history-owner",organizationId:"history-company",permissions:["company:read","documents:manage","payments:read","payments:prepare","recipients:read"]};
const db=getDb(),now=new Date().toISOString(),expires=new Date(Date.now()+86400000).toISOString();
db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'History owner',?)").run(access.userId,now);
for(const id of [access.organizationId,"other-history-company"])db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'History',?,?,?)").run(id,access.userId,now,now);
const invoice=db.prepare("INSERT INTO assistant_drafts(id,organization_id,created_by,input_ciphertext,draft_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)"),plan=db.prepare("INSERT INTO finance_plans(id,organization_id,created_by,plan_hash,source_fingerprint,payload_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)");
for(let index=0;index<120;index++){
  const id=String(index).padStart(4,"0");
  invoice.run(`invoice-${id}`,access.organizationId,access.userId,encrypt("History fixture source"),encrypt(JSON.stringify({reference:id})),encrypt(JSON.stringify({verification:{fixture:true}})),now,expires);
  plan.run(`proposal-${id}`,access.organizationId,access.userId,"0".repeat(64),"1".repeat(64),encrypt(JSON.stringify({instruction:"History fixture; no inference or preparation",source:{reference:id},allocations:[]})),encrypt("{}"),now,expires);
}
invoice.run("foreign-invoice","other-history-company",access.userId,encrypt("Other company source"),encrypt("{}"),encrypt("{}"),now,expires);
invoice.run("expired-invoice",access.organizationId,access.userId,encrypt("Expired source"),encrypt("{}"),encrypt("{}"),now,"2000-01-01T00:00:00.000Z");
plan.run("foreign-proposal","other-history-company",access.userId,"0".repeat(64),"1".repeat(64),encrypt("{}"),encrypt("{}"),now,expires);

test("retained invoice and finance proposal history remains discoverable beyond the first hundred records",()=>{
  const invoices=new Set<string>(),proposals=new Set<string>();
  for(let page=1;page<=5;page++){
    const drafts=invoiceDraftHistory(access,{page,pageSize:25}),plans=financePlanHistory(access,{page,pageSize:25});
    assert.equal(drafts.total,120);assert.equal(plans.total,120);assert.equal(drafts.totalPages,5);assert.equal(plans.totalPages,5);
    assert.equal(drafts.hasMore,page<5);assert.equal(plans.hasMore,page<5);
    for(const draft of drafts.drafts)invoices.add(draft.id);
    for(const plan of plans.plans)proposals.add(plan.id);
  }
  assert.equal(invoices.size,120);assert.equal(proposals.size,120);
  assert.ok(!invoices.has("foreign-invoice"));assert.ok(!invoices.has("expired-invoice"));assert.ok(!proposals.has("foreign-proposal"));
  assert.equal(invoiceDraftHistory(access,{page:999}).page,5);
  assert.equal(financePlanHistory(access,{page:999}).page,5);
  assert.throws(()=>invoiceDraftHistory({...access,permissions:["company:read"]}),error=>error instanceof ApiError&&error.status===403);
  assert.throws(()=>financePlanHistory({...access,permissions:["company:read","documents:manage"]}),error=>error instanceof ApiError&&error.status===403);
});

test("private history pagination rejects invalid bounds and clamps a purged history to an empty first page",()=>{
  for(const input of [{page:0},{page:1.5},{pageSize:0},{pageSize:101},{page:"invalid"}])assert.equal(privateHistoryQuery.safeParse(input).success,false);
  assert.deepEqual(privateHistoryWindow(0,{page:100,pageSize:25}),{page:1,pageSize:25,total:0,totalPages:1,hasMore:false,offset:0});
});

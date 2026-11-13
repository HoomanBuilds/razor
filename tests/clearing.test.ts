import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { computeClearing } from "../src/server/clearing/algorithm";
import { acceptInvoice, createRound, eligibleTerms, offerInvoice, overview, prepareRoundAction, previewRound, reconcileRound, roundDetail, shareInvoice } from "../src/server/clearing/service";
import { getDb, row } from "../src/server/db";
import { createBill, approveBill, listBills } from "../src/server/business/service";
import { getBillTerms, setBillTerms } from "../src/server/business/bill-terms";
import { accountingExport } from "../src/server/reconciliation/export";
import type { AccessContext } from "../src/server/context";
import type { ChainRound } from "../src/server/clearing/types";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "61".repeat(32);
process.env.NEAR_NETWORK = "testnet";
process.env.NEAR_CLEARING_ID = "clearing.testnet";
process.env.NEAR_FACTORY_ID = "factory.testnet";
const codeHash = base58.encode(new Uint8Array(32).fill(6));
for (const key of ["NEAR_CLEARING_CODE_HASH", "NEAR_FACTORY_CODE_HASH", "NEAR_TREASURY_CODE_HASH"]) process.env[key] = codeHash;
let sequence = 0;
const next = () => String(++sequence);
const permissions = ["company:read", "company:manage", "payments:read", "payments:prepare", "payments:approve", "payments:execute", "reports:read"];
function company(): AccessContext {
  const id = `company-${next()}`, userId = `owner-${next()}`, now = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(userId, userId, now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, id, userId, now, now);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'testnet','usdc.testnet',?)").run(id, `${id}.testnet`, now);
  db.prepare("INSERT INTO clearing_companies(organization_id,owner_user_id,treasury_id,owner_account_id,policy_version,network,token_contract,created_at,updated_at) VALUES(?,?,?,?,'1','testnet','usdc.testnet',?,?)").run(id, userId, `${id}.testnet`, `${userId}.testnet`, now, now);
  return { organizationId: id, userId, permissions };
}
function invoice(access: AccessContext, amount: string, kind = "business", creditor?: AccessContext) {
  const recipientId = `recipient-${next()}`, now = new Date().toISOString();
  getDb().prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'near','business.near','confirmed',?,?,?)").run(recipientId, access.organizationId, creditor?.userId ?? null, "Business", kind, "USDC", now, now, now);
  return createBill(access, { recipientId, reference: `INV-${next()}`, title: "Private company invoice", amount, maxFee: "1000", projectReference: "Private project" });
}
function reciprocal() {
  const a = company(), b = company(), billA = invoice(a, "100000000", "business", b), billB = invoice(b, "70000000", "business", a), startsAt = new Date(Date.now() - 60000).toISOString(), expiresAt = new Date(Date.now() + 3600000).toISOString();
  const linkA = offerInvoice(a, { billId: billA.id, creditorId: b.organizationId, startsAt, expiresAt }), linkB = offerInvoice(b, { billId: billB.id, creditorId: a.organizationId, startsAt, expiresAt });
  acceptInvoice(b, linkA.id, linkA.terms_hash); acceptInvoice(a, linkB.id, linkB.terms_hash);
  const input = { linkIds: [linkA.id, linkB.id], startsAt, expiresAt };
  return { a, b, billA, billB, linkA, linkB, input };
}

test("bigint clearing preserves net positions in reciprocal and multi-company cycles", () => {
  const pair = computeClearing([{ id: "ab", debtor: "a", creditor: "b", amount: "9007199254740993" }, { id: "ba", debtor: "b", creditor: "a", amount: "9007199254740992" }]);
  assert.equal(pair.residualTransferVolume, "1"); assert.ok(pair.positions.every(value => value.before === value.after));
  const cycle = computeClearing([{ id: "ab", debtor: "a", creditor: "b", amount: "100" }, { id: "bc", debtor: "b", creditor: "c", amount: "80" }, { id: "ca", debtor: "c", creditor: "a", amount: "70" }]);
  assert.equal(cycle.dischargedInvoiceValue, "210"); assert.equal(cycle.residualTransferVolume, "40");
  assert.equal(cycle.minimumStartingLiquidity, "30"); assert.ok(cycle.positions.every(value => value.before === value.after));
  assert.throws(() => computeClearing([]));
  assert.throws(() => computeClearing([{ id: "ab", debtor: "a", creditor: "b", amount: (1n << 128n).toString() }, { id: "ba", debtor: "b", creditor: "a", amount: "1" }]));
  const maximum=((1n<<128n)-1n).toString();
  assert.throws(()=>computeClearing([{id:"ab1",debtor:"a",creditor:"b",amount:maximum},{id:"ab2",debtor:"a",creditor:"b",amount:"1"},{id:"ba1",debtor:"b",creditor:"a",amount:maximum},{id:"ba2",debtor:"b",creditor:"a",amount:"1"}]), /u128 range/);
});

test("stale invoices, personal pay and concurrent payment authority cannot enter or mutate a round", () => {
  const fixture = reciprocal(), preview = previewRound(fixture.a, fixture.input);
  setBillTerms(fixture.a, fixture.billA.id, { paymentAmount: "99999999", maxFee: "1000", requiresAcceptance: false });
  assert.throws(() => createRound(fixture.a, { ...fixture.input, reviewToken: preview.reviewToken }), /complete unapproved|changed/);
  assert.equal(row<{ count: number }>("SELECT count(*) AS count FROM clearing_rounds")!.count, 0);
  assert.throws(() => eligibleTerms(fixture.a.organizationId, invoice(fixture.a, "1000000", "employee").id), /only confirmed business/);
  const fresh = reciprocal(), reviewed = previewRound(fresh.a, fresh.input), round = createRound(fresh.a, { ...fresh.input, reviewToken: reviewed.reviewToken });
  assert.throws(() => approveBill(fresh.a, fresh.billA.id), /CLEARING_LOCKED/);
  assert.throws(() => getDb().prepare("UPDATE payments SET reserved_amount='1' WHERE id=?").run(fresh.billB.payment_id!), /CLEARING_LOCKED/);
  assert.throws(() => createRound(fresh.a, { ...fresh.input, reviewToken: reviewed.reviewToken }), /already uses/);
  assert.equal(round.status, "prepared");
  assert.throws(() => roundDetail(company(), round.id), /not found/);
});

test("a three-company cycle needs both counterparties to authorize every additional amount share", () => {
  const a = company(), b = company(), c = company(), parties = [a, b, c], start = new Date(Date.now()-60000).toISOString(), end = new Date(Date.now()+3600000).toISOString();
  const links = parties.map((debtor, index) => {
    const creditor = parties[(index+1)%3], bill = invoice(debtor, String((100-index*10)*1000000), "business", creditor), link = offerInvoice(debtor, { billId: bill.id, creditorId: creditor.organizationId, startsAt: start, expiresAt: end });
    acceptInvoice(creditor, link.id, link.terms_hash); return link;
  });
  const input = { linkIds: links.map(link=>link.id), startsAt: start, expiresAt: end };
  assert.throws(()=>previewRound(a,input), /invitation was not found/);
  for (let index=0;index<3;index++) {
    const debtor=parties[index],creditor=parties[(index+1)%3],third=parties[(index+2)%3];
    shareInvoice(debtor,links[index].id,third.organizationId);
    assert.ok(!overview(third).links.some(link=>link.id===links[index].id));
    shareInvoice(creditor,links[index].id,third.organizationId);
  }
  const preview=previewRound(a,input);
  assert.equal(preview.dischargedInvoiceValue,"240000000");
  const shared=overview(a).links.find(link=>link.debtor_id===b.organizationId&&link.creditor_id===c.organizationId)!;
  assert.equal(shared.terms.reference,undefined); assert.equal(shared.terms.amount,"90000000");
});

test("only complete pinned final NEAR consent permits atomic setoff and ordinary residual drafts", async () => {
  const fixture=reciprocal(),preview=previewRound(fixture.a,fixture.input),local=createRound(fixture.a,{...fixture.input,reviewToken:preview.reviewToken}),original=globalThis.fetch;
  const finalizedAt=String(Date.now());
  let staleOwner=false;
  let chain:ChainRound={manifest:local.manifest,manifest_json:local.manifest_json,hash:local.manifest_hash,status:"ready",consents:[fixture.a.organizationId],finalized_at_ms:null,finalized_height:null};
  globalThis.fetch=async(_url,init)=>{
    const request=JSON.parse(String(init?.body)),params=request.params;let result:unknown;
    if(request.method==="status")result={chain_id:"testnet"};
    else if(request.method==="block")result={header:{hash:params.block_id===99?"fixture-clearing-block-not-live":"fixture-final-block-not-live",height:params.block_id===99?99:100,timestamp_nanosec:String(BigInt(finalizedAt)*1000000n)}};
    else {
      assert.ok(["fixture-final-block-not-live","fixture-clearing-block-not-live"].includes(params.block_id));
      if(params.request_type==="view_account")result={code_hash:codeHash};
      else {
        let value:unknown;
        if(params.method_name==="get_round")value=chain;
        else if(params.account_id==="clearing.testnet")value={factory_id:"factory.testnet",token_contract:"usdc.testnet",paused:false};
        else if(params.method_name==="get_creation")value={account_id:JSON.parse(Buffer.from(params.args_base64,"base64").toString()).account_id,token_contract:"usdc.testnet",status:"ready"};
        else if(params.account_id==="factory.testnet")value={token_contract:"usdc.testnet",treasury_wasm_hash:codeHash};
        else {const party=local.manifest.participants.find(party=>party.treasury_id===params.account_id)!;value={owner_id:staleOwner?"stale-owner.testnet":party.owner_id,token_contract:"usdc.testnet",policy_version:party.policy_version,paused:false};}
        result={result:[...Buffer.from(JSON.stringify(value))]};
      }
    }
    return Response.json({result});
  };
  try {
    await reconcileRound(fixture.a,local.id);
    assert.equal(row<{count:number}>("SELECT count(*) AS count FROM clearing_setoffs WHERE round_id=?",local.id)!.count,0);
    chain={...chain,status:"finalized",finalized_at_ms:finalizedAt,finalized_height:"99"};
    await assert.rejects(reconcileRound(fixture.a,local.id),/complete consent/);
    assert.equal(getBillTerms(fixture.a,fixture.billA.id).setoffAmount,"0");
    chain={...chain,consents:[fixture.a.organizationId,fixture.b.organizationId]};
    staleOwner=true;
    await assert.rejects(reconcileRound(fixture.a,local.id),/current owner/);
    assert.equal(getBillTerms(fixture.a,fixture.billA.id).setoffAmount,"0");
    staleOwner=false;
    const applied=await reconcileRound(fixture.a,local.id);
    assert.equal(applied.status,"cleared");
    const first=getBillTerms(fixture.a,fixture.billA.id),second=getBillTerms(fixture.b,fixture.billB.id);
    assert.equal(first.amount,"100000000");assert.equal(first.setoffAmount,"70000000");assert.equal(first.paid,"0");assert.equal(first.remainingLiability,"30000000");
    assert.equal(second.remainingLiability,"0");assert.equal(second.payment_id,null);
    assert.equal(row<{amount:string;status:string}>("SELECT amount,status FROM payments WHERE id=?",first.payment_id!)!.amount,"30000000");
    assert.throws(()=>getDb().prepare("UPDATE payments SET status='draft' WHERE id=?").run(fixture.billA.payment_id!), /CLEARED_LIABILITY/);
    assert.equal(approveBill(fixture.a,fixture.billA.id).status,"approved_unfunded");
    assert.equal(listBills(fixture.b)[0].status,"cleared");
    await reconcileRound(fixture.a,local.id);
    assert.equal(row<{count:number}>("SELECT count(*) AS count FROM clearing_setoffs WHERE round_id=?",local.id)!.count,2);
    assert.equal(row<{count:number}>("SELECT count(*) AS count FROM treasury_ledger")?.count,0);
    const csv=accountingExport(fixture.a);
    assert.match(csv,/business_debt_setoff/);assert.match(csv,/planned_residual_transfer_volume_usdc/);assert.match(csv,/no_delivered_tokens_or_treasury_credit/);
  } finally {globalThis.fetch=original;}
});


test("a company cannot direct someone else's confirmed business debt into a clearing agreement", () => {
  const payer=company(),actualCreditor=company(),outsider=company();
  const bill=invoice(payer,"1000000","business",actualCreditor),startsAt=new Date().toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
  assert.throws(()=>offerInvoice(payer,{billId:bill.id,creditorId:outsider.organizationId,startsAt,expiresAt}), /receiving company owner/);
  assert.equal(row<{count:number}>("SELECT count(*) AS count FROM clearing_links WHERE bill_id=?",bill.id)!.count,0);
});

test("an unregistered proposal can publish an exact revocation tombstone and expire without releasing debt", async () => {
  const fixture=reciprocal(),preview=previewRound(fixture.a,fixture.input),local=createRound(fixture.a,{...fixture.input,reviewToken:preview.reviewToken}),original=globalThis.fetch;
  getDb().prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'testnet',?)").run(`wallet-${next()}`,fixture.a.userId,`${fixture.a.userId}.testnet`,new Date().toISOString());
  let expired=false;
  globalThis.fetch=async(_url,init)=>{
    const {method,params}=JSON.parse(String(init?.body));let result:unknown;
    if(method==="status")result={chain_id:"testnet"};
    else if(method==="block")result={header:{hash:"fixture-expiry-block-not-live",height:101,timestamp_nanosec:String((expired?BigInt(local.manifest.expires_at_ms):BigInt(Date.now()))*1000000n)}};
    else if(params.request_type==="view_account")result={code_hash:codeHash};
    else {const value=params.method_name==="get_round"?null:params.method_name==="registration_cost"?"20000":params.account_id==="clearing.testnet"?{factory_id:"factory.testnet",token_contract:"usdc.testnet",paused:false}:{token_contract:"usdc.testnet",treasury_wasm_hash:codeHash};result={result:[...Buffer.from(JSON.stringify(value))]};}
    return Response.json({result});
  };
  try {
    const review=await prepareRoundAction(fixture.a,local.id,local.manifest_hash,"revoke");
    assert.equal(review.walletActions.length,1);
    assert.deepEqual(review.walletActions[0].actions.map(action=>action.params.methodName),["register_round","revoke"]);
    assert.equal((review.walletActions[0].actions[0].params.args as {manifest_json:string}).manifest_json,local.manifest_json);
    expired=true;
    assert.equal((await reconcileRound(fixture.a,local.id)).status,"expired");
    assert.equal(getBillTerms(fixture.a,fixture.billA.id).setoffAmount,"0");
    assert.equal(approveBill(fixture.a,fixture.billA.id).status,"approved_unfunded");
  } finally {globalThis.fetch=original;}
});

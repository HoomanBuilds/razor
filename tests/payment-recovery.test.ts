import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../src/server/db";
import { ApiError, type AccessContext } from "../src/server/context";
import { PERMISSIONS } from "../src/server/identity/session";
import { approvePayment, closeUnfundedAttempt, createPayment, prepareAttemptApproval, prepareRefundConfirmation, prepareSettlement } from "../src/server/payments/service";
import { paymentRecoveryOverview } from "../src/server/payments/recovery";
import { getSupportedTokens, type QuoteResponse } from "../src/server/payments/intents";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { ChainPayment } from "../src/server/payments/types";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="52".repeat(32);
process.env.NEAR_TREASURY_CODE_HASH="11111111111111111111111111111111";
const originalFetch=globalThis.fetch;
const near={assetId:`nep141:${NATIVE_USDC.near}`,blockchain:"near",symbol:"USDC",decimals:6,contractAddress:NATIVE_USDC.near};
const base={assetId:"nep141:base-usdc.omft.near",blockchain:"base",symbol:"USDC",decimals:6,contractAddress:NATIVE_USDC.base};
let current:ReturnType<typeof fixture>;
let codeHash=process.env.NEAR_TREASURY_CODE_HASH;
globalThis.fetch=async(url,input)=>{
  if(String(url).endsWith("/v0/tokens"))return Response.json([near,base]);
  if(String(url).includes("/v0/status?"))return Response.json({status:"PROCESSING",quoteResponse:{signature:"unsigned-fixture"}});
  const rpc=JSON.parse(String(input?.body));
  assert.equal(rpc.method,"query","Recovery checks must use read-only RPC calls");
  if(rpc.params.request_type==="view_account")return Response.json({result:{code_hash:codeHash}});
  const values:Record<string,unknown>={get_payment:current.chain,get_config:{owner_id:"owner.near",settlement_reporter:"reporter.near",approvers:["second.near"],executors:["executor.near"],policy_version:"1",paused:false},get_balance:{balance:"101000000",reserved:"101000000",available:"0",in_flight:"0",confirmed_at_ms:"0"},get_obligation:current.payment.id,get_recipient:{primary:{asset_id:base.assetId,network:"base",address:current.address},backup:null,backup_consent:false,active:true,version:"1"},get_approval_status:{policy_version:"1",approval_amount:"101000000",required_approvals:2,payment_terms_hash:"a".repeat(64),payment_approvals:["owner.near"],payment_collected:1,payment_ready:false,attempt_id:current.attemptId,attempt_terms_hash:"b".repeat(64),attempt_approvals:["owner.near"],attempt_collected:1,attempt_ready:false,can_execute:false}};
  assert.ok(rpc.params.method_name in values,`Unexpected method ${rpc.params.method_name}`);
  return Response.json({result:{result:[...Buffer.from(JSON.stringify(values[rpc.params.method_name]))]}});
};
after(()=>{globalThis.fetch=originalFetch;});
function fixture(){
  const userId="recovery-owner",db=getDb(),organizationId=randomUUID(),recipientId=randomUUID(),attemptId=randomUUID(),savedAt=new Date().toISOString(),address=`0x${"12".repeat(20)}`;
  const treasuryAccount=`treasury-${organizationId.slice(0,8)}.near`;
  db.prepare("INSERT OR IGNORE INTO users(id,name,created_at) VALUES(?,?,?)").run(userId,"Owner",savedAt);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId,"Company",userId,savedAt,savedAt);
  for(const account of ["owner.near","second.near"])db.prepare("INSERT OR IGNORE INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'mainnet',?)").run(randomUUID(),userId,account,savedAt);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'vendor',?,'base',?,'confirmed',?,?,?)").run(recipientId,organizationId,"Payee",base.assetId,address,savedAt,savedAt,savedAt);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(organizationId,treasuryAccount,NATIVE_USDC.near,savedAt);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,'101000000','0','0',?)").run(organizationId,savedAt);
  const access:AccessContext={userId,organizationId,permissions:[...PERMISSIONS]};
  const payment=approvePayment(access,createPayment(access,{recipientId,reference:randomUUID(),amount:"100000000",maxFee:"1000000"}).id);
  const quote={correlationId:randomUUID(),timestamp:savedAt,signature:"fixture-not-live",quoteRequest:{dry:false,swapType:"EXACT_OUTPUT",slippageTolerance:50,originAsset:near.assetId,depositType:"ORIGIN_CHAIN",destinationAsset:base.assetId,amount:payment.amount,recipient:address,recipientType:"DESTINATION_CHAIN",refundTo:treasuryAccount,refundType:"ORIGIN_CHAIN",deadline:new Date(Date.now()+3600_000).toISOString()},quote:{amountIn:"101000000",amountOut:"100000000",depositAddress:"deposit.near"}} as QuoteResponse;
  db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','prepared',?,?,'base',?,'100000000','101000000','deposit.near',?,?)").run(attemptId,payment.id,organizationId,JSON.stringify(quote),base.assetId,address,savedAt,savedAt);
  db.prepare("UPDATE payments SET status='prepared' WHERE id=?").run(payment.id);
  const chain:ChainPayment={id:payment.id,reference:`razor:${payment.id}`,recipient_id:recipientId,amount:payment.amount,max_fee:payment.max_fee,reservation:"101000000",incurred_cost:"0",expires_at_ms:String(Date.now()+86400_000),not_before_ms:"0",recipient_version:"1",policy_version:"1",approvals:["owner.near"],status:"approved",attempts:[{id:attemptId,status:"prepared",authorized:false,approvals:["owner.near"],approval_policy_version:"1",use_backup:false,route:{kind:"intents",source_receiver:"deposit.near",input_amount:"101000000",output_amount:"100000000",quote_id:quote.correlationId,quote_hash:createHash("sha256").update(JSON.stringify(quote)).digest("hex"),deadline_ms:String(Date.parse(quote.quoteRequest.deadline))},refund_amount:"0",receipt:null,actual_output:"0"}]};
  return {access,payment,attemptId,quote,chain,address,treasuryAccount};
}

test("recovery exposes only the original route and wallets with its actual NEAR roles",async()=>{
  current=fixture();current.chain.attempts[0].status="sending";
  const owner=await paymentRecoveryOverview(current.access,current.payment.id);
  assert.equal(owner.available,true);if(!owner.available)return;
  assert.equal(owner.canRecoverSource,true);assert.deepEqual(owner.ownerAccounts,["owner.near"]);
  const reader=await paymentRecoveryOverview({...current.access,permissions:["payments:read"]},current.payment.id);
  assert.equal(reader.available,true);if(!reader.available)return;
  assert.equal(reader.canRecoverSource,false);assert.deepEqual(reader.reporterAccounts,[]);
  current.chain.attempts[0].route.quote_hash="c".repeat(64);
  await assert.rejects(()=>paymentRecoveryOverview(current.access,current.payment.id),(error:ApiError)=>error.code==="ONCHAIN_ROUTE_MISMATCH");
});

test("unused-route closure refuses provider activity and still repairs an onchain prepared route after local closure",async()=>{
  current=fixture();
  await assert.rejects(()=>closeUnfundedAttempt(current.access,current.attemptId,async()=>({status:"PROCESSING",quoteResponse:current.quote})),(error:ApiError)=>error.code==="PRIOR_ATTEMPT_UNRESOLVED");
  getDb().prepare("UPDATE payout_attempts SET state='closed_unfunded' WHERE id=?").run(current.attemptId);
  const result=await closeUnfundedAttempt(current.access,current.attemptId,async()=>({status:"PENDING_DEPOSIT",quoteResponse:current.quote}));
  assert.equal(result.walletActions[0].actions[0].params.methodName,"discard_attempt");
  const overview=await paymentRecoveryOverview(current.access,current.payment.id);
  assert.equal(overview.available,true);if(overview.available)assert.equal(overview.canClose,true);
});

test("the next distinct linked approver is selected and upgraded treasury code blocks new approvals",async()=>{
  current=fixture();
  const plan=await prepareAttemptApproval(current.access,current.attemptId);
  assert.equal(plan.stage,"approve");assert.deepEqual(plan.approvalAccounts,["second.near"]);
  codeHash="unreviewed-code";
  try{await assert.rejects(()=>prepareAttemptApproval(current.access,current.attemptId),(error:ApiError)=>error.code==="TREASURY_CODE_MISMATCH");}
  finally{codeHash=process.env.NEAR_TREASURY_CODE_HASH!;}
});

test("an unavailable routing report cannot authorize route closure or recovered-funds confirmation",async()=>{
  current=fixture();current.chain.status="in_flight";current.chain.attempts[0].status="source_sent";
  await assert.rejects(()=>prepareSettlement(current.access,current.attemptId,{outcome:"refund_pending",receipt:"Provider request has not returned"}),(error:ApiError)=>error.code==="REFUND_ROUTE_UNRESOLVED");
  current.chain.status="recovery_pending";current.chain.attempts[0].status="refund_pending";
  await assert.rejects(()=>prepareRefundConfirmation(current.access,current.attemptId,{refundAmount:"101000000",receipt:"Refund has not been observed"}),(error:ApiError)=>error.code==="REFUND_ROUTE_UNRESOLVED");
});

test("service outages stay distinct from an unavailable route",async()=>{
  const mock=globalThis.fetch;globalThis.fetch=async()=>Response.json({message:"Routing service unavailable"},{status:503});
  try{await assert.rejects(()=>getSupportedTokens(true),(error:ApiError)=>error.code==="ROUTING_SERVICE_UNAVAILABLE");}
  finally{globalThis.fetch=mock;}
});

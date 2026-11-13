import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { base58 } from "@scure/base";
import { getDb, row } from "../src/server/db";
import { ApiError, type AccessContext } from "../src/server/context";
import { deriveSharedCompanyId, type FinalTransaction } from "../src/server/payments/near";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { WalletTransaction } from "../src/server/payments/types";
import { assertRecoveryKey, authorizeRecoveryOperator, checkedRecoveryCall, operatorRecoveryInput, runOperatorRecovery, type OperatorRecoveryDependencies, type RecoveryTransport } from "../src/server/reconciliation/operator";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="92".repeat(32);
process.env.NEAR_TREASURY_ID="shared.near";
process.env.NEAR_TREASURY_CODE_HASH=base58.encode(new Uint8Array(32).fill(3));
const originalHash=base58.encode(new Uint8Array(32).fill(4)),savedAt=new Date().toISOString();
getDb().prepare("INSERT INTO users(id,name,created_at) VALUES('operator','Operator',?),('customer','Customer',?),('stranger','Stranger',?)").run(savedAt,savedAt,savedAt);
getDb().prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES('operator-wallet','operator','near','reporter.near','mainnet',?)").run(savedAt);
const permission={FunctionCall:{receiver_id:"shared.near",method_names:["confirm_refund","recover_source_transfer","recover_retained_withdrawal"],allowance:"100000000000000000000000"}};
function fixture(){
  const company=randomUUID(),payment=randomUUID(),attempt=randomUUID(),companyId=deriveSharedCompanyId(company,"owner.near");
  getDb().prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,'customer',?,?)").run(company,"Customer",savedAt,savedAt);
  getDb().prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,architecture,company_id,created_at) VALUES(?,'shared.near','mainnet',?,'shared_v1',?,?)").run(company,NATIVE_USDC.near,companyId,savedAt);
  getDb().prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES(?,?,?,'payment',?,'1000000','0','recovery_pending',1,'{}',?,?)").run(payment,company,randomUUID(),randomUUID(),savedAt,savedAt);
  getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','recovery_pending','{}','USDC','near','recipient.near','1000000','1000000','deposit.near',?,?)").run(attempt,payment,company,savedAt,savedAt);
  const input=operatorRecoveryInput.parse({company,operatorUser:"operator",accountId:"reporter.near",network:"mainnet",kind:"source",attemptId:attempt,transactionHash:originalHash,senderAccountId:"customer.near"});
  let prepares=0,signs=0,throws=true,finalValue=true,completed=true,currentHash="";
  const sent:string[]=[];
  const plan=()=>({eligibleSigners:["reporter.near"],proof:{transactionHash:originalHash,senderAccountId:"customer.near",succeeded:false},walletActions:[{receiverId:"shared.near",actions:[{type:"FunctionCall" as const,params:{methodName:"recover_source_transfer",args:{company_id:companyId,payment_id:payment,attempt_id:attempt,succeeded:false,receipt:JSON.stringify({transaction_hash:originalHash,receipt_id:"token-receipt",outcome:"source_failed"})},deposit:"1",gas:"60000000000000"}}]}]});
  const final=():FinalTransaction=>({final_execution_status:"FINAL",transaction:{hash:currentHash,signer_id:"reporter.near",receiver_id:"shared.near"},status:{SuccessValue:Buffer.from(JSON.stringify(finalValue)).toString("base64")}});
  const transport:RecoveryTransport={publicKey:`ed25519:${base58.encode(new Uint8Array(32).fill(8))}`,permission:async()=>permission,gasPrice:async()=>"100000000",sign:async(call)=>{signs++;currentHash=base58.encode(createHash("sha256").update(`${company}:${signs}`).digest());return{encoded:Buffer.from(JSON.stringify(call)).toString("base64"),hash:currentHash};},validate:(encoded,_hash,call)=>assert.deepEqual(JSON.parse(Buffer.from(encoded,"base64").toString()),call),send:async(encoded)=>{sent.push(encoded);if(throws)throw new Error("fixture connection lost");return final();}};
  const dependencies:OperatorRecoveryDependencies={network:async()=>"mainnet",codeHash:async()=>process.env.NEAR_TREASURY_CODE_HASH!,platform:async()=>({architecture:"shared_v1",token_contract:NATIVE_USDC.near,refund_reporter:"reporter.near"}),company:async()=>({architecture:"shared_v1",company_id:companyId,token_contract:NATIVE_USDC.near}),prepare:async(access)=>{prepares++;assert.equal(access.userId,"operator");assert.equal(access.organizationId,company);assert.deepEqual(access.permissions,["company:read","payments:read","payments:approve"]);return plan();},transport:async()=>transport,lookup:async()=>{throw new Error("fixture outcome unknown");},completed:async()=>completed};
  return {input,dependencies,transport,plan,companyId,company,attempt,counts:()=>({prepares,signs}),sent,final,setNetworkFailure:(value:boolean)=>{throws=value;},setFinalValue:(value:boolean)=>{finalValue=value;},setCompleted:(value:boolean)=>{completed=value;}};
}

test("operator authority is independent of company membership and retains the operator's actual identity",async()=>{
  const value=fixture();
  assert.equal(row("SELECT user_id FROM memberships WHERE organization_id=? AND user_id='operator'",value.company),undefined);
  const result=await runOperatorRecovery(value.input,value.dependencies);
  assert.equal(result.status,"prepared");assert.equal(result.signed,false);assert.equal(result.operatorUser,"operator");
  assert.equal(result.walletActions[0].actions[0].params.deposit,"0");
  assert.equal((result.walletActions[0].actions[0].params.args as Record<string,string>).company_id,value.companyId);
  assert.equal(row<{actor_id:string}>("SELECT actor_id FROM activity WHERE organization_id=? AND action='recovery.operator_prepared'",value.company)?.actor_id,"operator");
  assert.deepEqual(value.counts(),{prepares:1,signs:0});
});

test("unknown users, unrelated wallets, wrong networks and changed company bindings cannot use operator access",async()=>{
  const value=fixture();
  await assert.rejects(()=>authorizeRecoveryOperator({...value.input,operatorUser:"missing"},value.dependencies),(error:ApiError)=>error.code==="RECOVERY_OPERATOR_UNKNOWN");
  await assert.rejects(()=>authorizeRecoveryOperator({...value.input,operatorUser:"stranger"},value.dependencies),(error:ApiError)=>error.code==="RECOVERY_OPERATOR_WALLET_REQUIRED");
  await assert.rejects(()=>authorizeRecoveryOperator({...value.input,network:"testnet"},value.dependencies),(error:ApiError)=>error.code==="RECOVERY_COMPANY_MISMATCH");
  await assert.rejects(()=>authorizeRecoveryOperator(value.input,{...value.dependencies,company:async()=>({architecture:"shared_v1",company_id:deriveSharedCompanyId("another","owner.near"),token_contract:NATIVE_USDC.near})}),(error:ApiError)=>error.code==="RECOVERY_REPORTER_REQUIRED");
  await assert.rejects(()=>authorizeRecoveryOperator(value.input,{...value.dependencies,platform:async()=>({architecture:"shared_v1",token_contract:NATIVE_USDC.near,refund_reporter:"another.near"})}),(error:ApiError)=>error.code==="RECOVERY_REPORTER_REQUIRED");
});

test("only narrowly scoped keys with sufficient bounded gas allowance are accepted",()=>{
  assert.doesNotThrow(()=>assertRecoveryKey(permission,"shared.near","confirm_refund","100000000000000","100000000"));
  for(const key of ["FullAccess",{FunctionCall:{...permission.FunctionCall,method_names:[]}},{FunctionCall:{...permission.FunctionCall,method_names:["confirm_refund","withdraw_available"]}},{FunctionCall:{...permission.FunctionCall,receiver_id:"other.near"}}])assert.throws(()=>assertRecoveryKey(key,"shared.near","confirm_refund","100000000000000","100000000"),(error:ApiError)=>error.code==="RECOVERY_KEY_UNSAFE");
  for(const allowance of [null,"0","100"] )assert.throws(()=>assertRecoveryKey({FunctionCall:{...permission.FunctionCall,allowance}},"shared.near","confirm_refund","100000000000000","100000000"),(error:ApiError)=>error.code==="RECOVERY_KEY_ALLOWANCE");
});

test("send refuses a broad key before creating any recovery attestation or audit",async()=>{
  const value=fixture();
  await assert.rejects(()=>runOperatorRecovery({...value.input,send:true},{...value.dependencies,transport:async()=>({...value.transport,permission:async()=>"FullAccess"})}),(error:ApiError)=>error.code==="RECOVERY_KEY_UNSAFE");
  assert.deepEqual(value.counts(),{prepares:0,signs:0});
  assert.equal(row("SELECT id FROM activity WHERE organization_id=?",value.company),undefined);
  assert.equal(row("SELECT id FROM recovery_operations WHERE organization_id=?",value.company),undefined);
});

test("the operator review rejects foreign companies and arbitrary contract calls",async()=>{
  const value=fixture(),{config}=await authorizeRecoveryOperator(value.input,value.dependencies),plan=value.plan();
  plan.walletActions[0].actions[0].params.args.company_id=deriveSharedCompanyId("foreign","owner.near");
  assert.throws(()=>checkedRecoveryCall(config,value.input,plan),(error:ApiError)=>error.code==="RECOVERY_CALL_INVALID");
  const malicious=value.plan();malicious.walletActions[0].actions[0].params.methodName="withdraw_available";
  assert.throws(()=>checkedRecoveryCall(config,value.input,malicious));
  const evidence=value.plan();evidence.proof.transactionHash=base58.encode(new Uint8Array(32).fill(90));
  assert.throws(()=>checkedRecoveryCall(config,value.input,evidence),(error:ApiError)=>error.code==="RECOVERY_PROOF_MISMATCH");
});

test("unknown outcomes hold the entity and repeat only the original encrypted signature",async()=>{
  const value=fixture(),first=await runOperatorRecovery({...value.input,send:true},value.dependencies);
  assert.equal(first.status,"uncertain");assert.equal(first.held,true);assert.equal(first.sameSignedTransactionOnly,true);
  const signed=row<{signed_transaction_ciphertext:string}>("SELECT signed_transaction_ciphertext FROM recovery_submissions WHERE tx_hash=?",first.transactionHash)!;
  assert(signed.signed_transaction_ciphertext.startsWith("enc1:"));assert(!JSON.stringify(first).includes(signed.signed_transaction_ciphertext));
  const preview=await runOperatorRecovery(value.input,value.dependencies);assert.equal(preview.held,true);assert.equal(preview.transactionHash,first.transactionHash);
  const second=await runOperatorRecovery({...value.input,send:true},value.dependencies);assert.equal(second.transactionHash,first.transactionHash);
  assert.equal(value.sent.length,2);assert.equal(value.sent[0],value.sent[1]);assert.deepEqual(value.counts(),{prepares:1,signs:1});
  await assert.rejects(()=>runOperatorRecovery({...value.input,send:true,retryFinal:true},value.dependencies),(error:ApiError)=>error.code==="RECOVERY_OUTCOME_UNKNOWN");
  const changed={...value.input,transactionHash:base58.encode(new Uint8Array(32).fill(99))};
  await assert.rejects(()=>runOperatorRecovery(changed,value.dependencies),(error:ApiError)=>error.code==="RECOVERY_OUTCOME_UNKNOWN");
});

test("only final transaction plus scoped recovery state marks completion, and later repeats do not sign",async()=>{
  const value=fixture();value.setNetworkFailure(false);
  const first=await runOperatorRecovery({...value.input,send:true},value.dependencies);
  assert.equal(first.status,"confirmed");assert.equal(first.final,true);
  const second=await runOperatorRecovery({...value.input,send:true},value.dependencies);
  assert.equal(second.alreadyReconciled,true);assert.equal(second.transactionHash,first.transactionHash);assert.deepEqual(value.counts(),{prepares:1,signs:1});
});

test("a false callback needs explicit reviewed final retry and preserves the earlier signed submission",async()=>{
  const value=fixture();value.setNetworkFailure(false);value.setFinalValue(false);
  const first=await runOperatorRecovery({...value.input,send:true},value.dependencies);assert.equal(first.status,"failed");
  const held=await runOperatorRecovery({...value.input,send:true},value.dependencies);assert.equal(held.held,true);assert.equal(value.counts().signs,1);
  value.setFinalValue(true);
  const retried=await runOperatorRecovery({...value.input,send:true,retryFinal:true},value.dependencies);assert.equal(retried.status,"confirmed");assert.equal(value.counts().signs,2);
  assert.equal(row<{total:number}>("SELECT COUNT(*) AS total FROM recovery_submissions WHERE operation_id=?",first.operationId)?.total,2);
});

test("a successful outer RPC without matching company recovery state never claims confirmation",async()=>{
  const value=fixture();value.setNetworkFailure(false);value.setCompleted(false);
  const result=await runOperatorRecovery({...value.input,send:true},value.dependencies);assert.notEqual(result.status,"confirmed");
});

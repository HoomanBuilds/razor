import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { getDb } from "../src/server/db";
import { ApiError, type AccessContext } from "../src/server/context";
import { NATIVE_USDC } from "../src/server/payments/policy";
import { creationInput, deriveTreasuryAccount, prepareTreasury, quoteTreasury, reconcileTreasury } from "../src/server/treasury-onboarding/service";

process.env.DATABASE_PATH=":memory:";
process.env.NEAR_NETWORK="mainnet";
process.env.NEAR_FACTORY_ID="factory.near";
const factoryHash=base58.encode(new Uint8Array(32).fill(1)),treasuryHash=base58.encode(new Uint8Array(32).fill(2));
process.env.NEAR_FACTORY_CODE_HASH=factoryHash;
process.env.NEAR_TREASURY_CODE_HASH=treasuryHash;
const access:AccessContext={userId:"verified-owner",organizationId:"company-one",permissions:["company:manage","company:read"]};
const terms={ownerAccount:"owner.near",slug:"payroll",perPaymentLimit:"1000000",dailyLimit:"10000000"};
const now=new Date().toISOString();
getDb().prepare("INSERT INTO users (id,name,created_at) VALUES (?,?,?)").run(access.userId,"Owner",now);
getDb().prepare("INSERT INTO organizations (id,name,owner_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(access.organizationId,"Company",access.userId,now,now);
getDb().prepare("INSERT INTO linked_wallets (id,user_id,family,address,network,created_at) VALUES (?,?,'near',?,'mainnet',?)").run("owner-wallet",access.userId,terms.ownerAccount,now);

function mockRpc(creationStatus:"pending"|"ready"|null,wrongCode=false) {
  const original=globalThis.fetch;
  globalThis.fetch=async(_input,init)=>{
    const request=JSON.parse(init!.body as string),params=request.params;
    let result:unknown;
    if(request.method==="status")result={chain_id:"mainnet"};
    else if(params.request_type==="view_account")result={code_hash:params.account_id===process.env.NEAR_FACTORY_ID?factoryHash:wrongCode?factoryHash:treasuryHash};
    else {
      const factory={owner_id:"factory-owner.near",token_contract:NATIVE_USDC.near,paused:false,treasury_wasm_hash:treasuryHash,minimum_deposit:"300",treasury_funding:"200",factory_storage_fee:"100"};
      let value:unknown;
      if(params.method_name==="get_config")value=params.account_id===process.env.NEAR_FACTORY_ID?factory:{owner_id:terms.ownerAccount,token_contract:NATIVE_USDC.near,per_payment_limit:terms.perPaymentLimit,daily_limit:terms.dailyLimit};
      else if(params.method_name==="quote_creation")value={...factory,owner_id:terms.ownerAccount,account_id:deriveTreasuryAccount(terms.ownerAccount,terms.slug,process.env.NEAR_FACTORY_ID!)};
      else if(params.method_name==="get_treasury")value=creationStatus?{account_id:deriveTreasuryAccount(terms.ownerAccount,terms.slug,process.env.NEAR_FACTORY_ID!),owner_id:terms.ownerAccount,slug:terms.slug,generation:"1",token_contract:NATIVE_USDC.near,per_payment_limit:terms.perPaymentLimit,daily_limit:terms.dailyLimit,status:creationStatus,treasury_funding:"200",factory_storage_fee:"100",refund_amount:"0",created_at_ms:"1"}:null;
      else throw new Error("Unexpected contract call");
      result={result:[...Buffer.from(JSON.stringify(value))]};
    }
    return Response.json({jsonrpc:"2.0",id:request.id,result});
  };
  return ()=>{globalThis.fetch=original;};
}

test("treasury preparation binds the reviewed deposit and refuses duplicate creation",async()=>{
  let restore=mockRpc(null);
  try {
    const quoted=await quoteTreasury(access,terms);
    const prepared=await prepareTreasury(access,terms,quoted.quote.hash);
    assert.equal(prepared.walletActions[0].actions[0].params.deposit,"300");
    assert.equal(prepared.walletActions[0].actions[0].params.methodName,"create_treasury");
    await assert.rejects(()=>prepareTreasury(access,{...terms,dailyLimit:"20000000"},quoted.quote.hash),(error)=>error instanceof ApiError&&error.code==="CREATION_QUOTE_CHANGED");
    restore();restore=mockRpc("pending");
    await assert.rejects(()=>prepareTreasury(access,terms,quoted.quote.hash),(error)=>error instanceof ApiError&&error.code==="CREATION_ALREADY_REQUESTED");
  } finally{restore();}
});

test("unverified owners and altered child code cannot configure a company treasury",async()=>{
  let restore=mockRpc(null);
  try {
    await assert.rejects(()=>quoteTreasury(access,{...terms,ownerAccount:"stranger.near"}),(error)=>error instanceof ApiError&&error.code==="TREASURY_OWNER_UNVERIFIED");
    restore();restore=mockRpc("ready",true);
    await assert.rejects(()=>reconcileTreasury(access,terms),(error)=>error instanceof ApiError&&error.code==="TREASURY_VERIFICATION_FAILED");
    assert.equal(creationInput.safeParse({...terms,dailyLimit:"invalid"}).success,false);
  }finally{restore();}
});

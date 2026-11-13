import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Hono } from "hono";
import { getDb, row } from "../src/server/db";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getSubscriptionState } from "../src/server/billing/subscriptions";
import { billingCheckoutConfiguration, billingIssuer, billingQuoteHash, type BillingChainInvoice, type BillingChainRefund } from "../src/server/billing/chain";
import { billingOverview, claimInvoice, createCheckout, invoiceDetail, invoicePage, reconcileInvoice, refreshInvoice, requestInvoiceRefund, prepareRefundForOperator, reconcileRefundForOperator, operatorBillingInvoices, billingInvoiceReceipt, closeUnusedInvoice, submitInvoice } from "../src/server/billing/payments";
import { billingRoutes } from "../src/server/billing";
import type { BillingInvoiceDetail } from "../src/server/billing/payment-types";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="ab".repeat(32);
process.env.NEAR_NETWORK="testnet";
process.env.NEAR_RPC_URL="https://billing-rpc.invalid";
process.env.RAZOR_BILLING_MODE="enforced";
process.env.RAZOR_BILLING_CONTRACT_ID="billing.testnet";
process.env.RAZOR_BILLING_TESTNET_TOKEN_CONTRACT="usdc.testnet";
process.env.RAZOR_BILLING_CODE_HASH=base58.encode(new Uint8Array(32).fill(3));
const seed=new Uint8Array(32).fill(7),publicKey=ed25519.getPublicKey(seed),secret=`ed25519:${base58.encode(new Uint8Array([...seed,...publicKey]))}`;
process.env.RAZOR_BILLING_ISSUER_PRIVATE_KEY=secret;
const chainInvoices=new Map<string,BillingChainInvoice>(),chainRefunds=new Map<string,BillingChainRefund>();
let contractPaused=false,contractIssuer=`ed25519:${base58.encode(publicKey)}`,codeHash=process.env.RAZOR_BILLING_CODE_HASH,network="testnet",blockTime=Date.now(),transactionResult:unknown=null;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(_input,init)=>{
 const request=JSON.parse(String(init?.body)),p=request.params;
 if(request.method==="status")return Response.json({result:{chain_id:network}});
 if(request.method==="block")return Response.json({result:{header:{hash:"final-block",timestamp_nanosec:String(BigInt(blockTime)*1000000n)}}});
 if(request.method==="EXPERIMENTAL_tx_status")return transactionResult?Response.json({result:transactionResult}):Response.json({error:{name:"UNKNOWN_TRANSACTION"}});
 if(p.request_type==="view_account")return Response.json({result:{code_hash:codeHash,block_hash:"final-block",block_height:500}});
 let value:unknown;
 const args=JSON.parse(Buffer.from(p.args_base64,"base64").toString());
 if(p.method_name==="get_config")value={owner_id:"operator.testnet",token_contract:"usdc.testnet",network:"testnet",issuer_public_key:contractIssuer,paused:contractPaused,available:"999000000",withdrawal_pending:false,version:1};
 else if(p.method_name==="storage_balance_of")value={total:"1000",available:"0"};
 else if(p.method_name==="get_invoice")value=chainInvoices.get(args.invoice_id)??null;
 else if(p.method_name==="get_refund")value=chainRefunds.get(args.refund_id)??null;
 else throw new Error(`Unexpected billing view ${p.method_name}`);
 return Response.json({result:{result:[...Buffer.from(JSON.stringify(value))],block_hash:"final-block",block_height:500}});
};
function company() {
 const user=randomUUID(),organizationId=randomUUID(),at=new Date().toISOString(),payer=`payer-${user.slice(0,8)}.testnet`;
 getDb().prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(user,"Billing owner",at);
 getDb().prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId,"Billing company",user,at,at);
 getDb().prepare("INSERT INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near',?,'testnet',?)").run(randomUUID(),user,payer,at);
 return {access:{userId:user,organizationId,permissions:["company:read","company:manage"]} satisfies AccessContext,payer};
}
async function checkout(value:ReturnType<typeof company>,planVersionId="pro-1") {return createCheckout(value.access,{planVersionId,payerAccount:value.payer,requestKey:randomUUID()});}
function paid(detail:BillingInvoiceDetail,extra:Partial<BillingChainInvoice>={}) {
 const invoice=detail.invoice;
 chainInvoices.set(invoice.id,{invoice_id:invoice.id,company_id:invoice.organizationId,plan_version_id:invoice.plan.id,payer_id:invoice.payerAccount,amount:invoice.amount,terms_hash:invoice.termsHash,quote_hash:billingQuoteHash(invoice.quoteJson),paid_at_ms:String(Date.now()),paid_at_height:"499",refunded_amount:"0",pending_refund:null,...extra});
}

test("checkout records immutable signed invoice terms and returns the same unresolved invoice across request retries",async()=>{
 const value=company(),requestKey=randomUUID(),input={planVersionId:"pro-1",payerAccount:value.payer,requestKey};
 const first=await createCheckout(value.access,input),same=await createCheckout(value.access,input),otherKey=await checkout(value,"business-1");
 assert.equal(first.invoice.id,same.invoice.id);assert.equal(first.invoice.id,otherKey.invoice.id);assert.equal(first.invoice.amount,"29000000");assert.equal(first.canSign,true);
 const action=first.walletActions[0];assert.equal(action.receiverId,"usdc.testnet");assert.equal(action.actions[0].params.methodName,"ft_transfer_call");assert.equal(action.actions[0].params.deposit,"1");
 assert.deepEqual(first.signerAccounts,[value.payer]);assert.equal(JSON.parse(first.invoice.quoteJson).terms_hash,first.invoice.termsHash);
 assert(ed25519.verify(base58.decode(first.invoice.signature),new TextEncoder().encode(first.invoice.quoteJson),publicKey));
 await assert.rejects(createCheckout(value.access,{...input,planVersionId:"business-1"}),(error:unknown)=>error instanceof ApiError&&error.code==="BILLING_CHECKOUT_CHANGED");
 assert.throws(()=>getDb().prepare("UPDATE billing_invoices SET amount='1' WHERE id=?").run(first.invoice.id),/immutable/);
});

test("wallet hashes and generic token transfers do not grant paid access; exact final contract state does",async()=>{
 const value=company(),detail=await checkout(value);
 await claimInvoice(value.access,detail.invoice.id);
 const pending=await submitInvoice(value.access,detail.invoice.id,"1".repeat(44));assert.equal(pending.invoice.status,"submitted");assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"free");
 paid(detail);
 const final=await reconcileInvoice(value.access,detail.invoice.id);assert.equal(final.invoice.status,"paid");assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"pro");assert.equal(final.invoice.transactionHash,null);
 await reconcileInvoice(value.access,detail.invoice.id);assert.equal(row<{count:number}>("SELECT COUNT(*) AS count FROM billing_periods WHERE source_invoice_id=?",detail.invoice.id)?.count,1);
 assert.equal(billingInvoiceReceipt(value.access,detail.invoice.id).verification.invoice.invoice_id,detail.invoice.id);
});

test("company owner and verified payer isolation apply to reads and writes",async()=>{
 const first=company(),second=company(),detail=await checkout(first);
 await assert.rejects(invoiceDetail(second.access,detail.invoice.id),/not found/);
 await assert.rejects(billingOverview({...first.access,userId:second.access.userId}),/owner/);
 await assert.rejects(createCheckout(second.access,{planVersionId:"pro-1",payerAccount:first.payer,requestKey:randomUUID()}),/verify/);
 await assert.rejects(invoiceDetail({...first.access,permissions:["company:read"]},detail.invoice.id),/permission/);
});

test("missing setup, wrong network and changed code fail closed before invoice collection",async()=>{
 const value=company();delete process.env.RAZOR_BILLING_ISSUER_PRIVATE_KEY;
 assert.equal((await billingCheckoutConfiguration()).ready,false);await assert.rejects(checkout(value),/issuer|ISSUER|Configure/);assert.equal(invoicePage(value.access).total,0);
 process.env.RAZOR_BILLING_ISSUER_PRIVATE_KEY=secret;network="mainnet";await assert.rejects(checkout(value),/another network/);network="testnet";
 codeHash="different-code";await assert.rejects(checkout(value),/reviewed/);codeHash=process.env.RAZOR_BILLING_CODE_HASH;
});

test("authoritative payment recovery remains available after issuer rotation and collection pause",async()=>{
 const value=company(),detail=await checkout(value);paid(detail);contractPaused=true;contractIssuer=`ed25519:${base58.encode(new Uint8Array(32).fill(4))}`;delete process.env.RAZOR_BILLING_ISSUER_PRIVATE_KEY;
 const result=await reconcileInvoice(value.access,detail.invoice.id);assert.equal(result.invoice.status,"paid");assert.equal(result.canSign,false);assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"pro");
 contractPaused=false;contractIssuer=`ed25519:${base58.encode(publicKey)}`;process.env.RAZOR_BILLING_ISSUER_PRIVATE_KEY=secret;
});

test("mismatched receipt identity cannot activate a subscription",async()=>{
 const value=company(),detail=await checkout(value);paid(detail,{payer_id:"attacker.testnet"});
 await assert.rejects(reconcileInvoice(value.access,detail.invoice.id),/frozen invoice/);assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"free");
});

test("stale paid terms preserve the received payment as a refund request rather than granting conflicting access",async()=>{
 const value=company(),detail=await checkout(value);getDb().prepare("UPDATE billing_subscription_settings SET revision=revision+1 WHERE organization_id=?").run(value.access.organizationId);paid(detail);
 const result=await reconcileInvoice(value.access,detail.invoice.id);assert.equal(result.invoice.status,"credit_required");assert(result.invoice.refundRequest);assert.equal(result.invoice.refundRequest.amount,"29000000");assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"free");
});

test("full onchain refunds return only to the original payer and revoke paid access after final confirmation",async()=>{
 const value=company(),detail=await checkout(value);paid(detail);await reconcileInvoice(value.access,detail.invoice.id);
 const requested=await requestInvoiceRefund(value.access,detail.invoice.id,"Billing mistake");const refund=requested.invoice.refundRequest!;
 const prepared=await prepareRefundForOperator(refund.id);assert("walletActions" in prepared);assert.equal(prepared.originalPayer,value.payer);assert.equal(prepared.signerAccount,"operator.testnet");assert.equal(prepared.signed,false);
 assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"pro");
 chainRefunds.set(refund.id,{id:refund.id,invoice_id:detail.invoice.id,amount:refund.amount,status:"completed",nonce:"1"});chainInvoices.get(detail.invoice.id)!.refunded_amount=refund.amount;
 const result=await reconcileRefundForOperator(refund.id);assert.equal(result.status,"completed");assert.equal((await invoiceDetail(value.access,detail.invoice.id)).invoice.status,"refunded");assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"free");
});

test("unresolved refunds cannot be prepared a second time or redirected",async()=>{
 const value=company(),detail=await checkout(value);paid(detail);await reconcileInvoice(value.access,detail.invoice.id);const requested=await requestInvoiceRefund(value.access,detail.invoice.id,"Review");const refund=requested.invoice.refundRequest!;
 chainRefunds.set(refund.id,{id:refund.id,invoice_id:detail.invoice.id,amount:refund.amount,status:"pending",nonce:"1"});chainInvoices.get(detail.invoice.id)!.pending_refund=refund.id;
 await assert.rejects(prepareRefundForOperator(refund.id),/pending/);assert.equal(getSubscriptionState(value.access.organizationId).plan.code,"pro");
});

test("same-invoice refresh retains signed offer history and expired closure checks final block time",async()=>{
 const value=company(),detail=await checkout(value);
 await new Promise(resolve=>setTimeout(resolve,3));const refreshed=await refreshInvoice(value.access,detail.invoice.id);assert.equal(refreshed.invoice.id,detail.invoice.id);assert.equal(refreshed.invoice.termsHash,detail.invoice.termsHash);assert.notEqual(refreshed.invoice.quoteJson,detail.invoice.quoteJson);assert.equal(row<{count:number}>("SELECT COUNT(*) AS count FROM billing_invoice_offers WHERE invoice_id=?",detail.invoice.id)?.count,2);
 paid(detail);const recovered=await reconcileInvoice(value.access,detail.invoice.id);assert.equal(recovered.invoice.status,"paid");
 const unused=company(),fresh=await checkout(unused);await assert.rejects(closeUnusedInvoice(unused.access,fresh.invoice.id),/still valid/);
});

test("billing routes mount owner controls and expose bounded history without leaking another company",async()=>{
 const value=company(),detail=await checkout(value);const app=new Hono<AppEnv>();app.use("*",async(c,next)=>{c.set("access",value.access);await next();});app.route("/billing",billingRoutes);
 const response=await app.request("http://localhost/billing");assert.equal(response.status,200);const body=await response.json();assert.equal(body.canManage,true);assert.equal(body.plans.length,3);
 const list=await app.request("http://localhost/billing/invoices?page=1&pageSize=1");assert.equal(list.status,200);assert.equal((await list.json()).invoices[0].id,detail.invoice.id);
 assert.throws(()=>invoicePage(value.access,0),/valid/);assert.equal(operatorBillingInvoices(value.access.organizationId,1,1).total,1);assert.equal(operatorBillingInvoices(value.access.organizationId,2,1).invoices.length,0);
 const receipt=await app.request(`http://localhost/billing/invoices/${detail.invoice.id}/receipt?download=1`);assert.equal(receipt.status,200);assert.match(receipt.headers.get("content-disposition")??"",/attachment/);
});

test("expired unused checkout closes only after the final chain has passed its signed offer window",async t=>{
 const started=Date.now();t.mock.timers.enable({apis:["Date"],now:started});t.after(()=>t.mock.timers.reset());
 const value=company(),detail=await checkout(value),expiresAt=Date.parse(detail.invoice.expiresAt);
 t.mock.timers.setTime(expiresAt+1000);blockTime=expiresAt-1;
 await assert.rejects(closeUnusedInvoice(value.access,detail.invoice.id),/final NEAR block/);
 blockTime=expiresAt+1;const closed=await closeUnusedInvoice(value.access,detail.invoice.id);assert.equal(closed.invoice.status,"cancelled");
 const fresh=await checkout(value);assert.notEqual(fresh.invoice.id,detail.invoice.id);blockTime=Date.now();
});

test.after(()=>{globalThis.fetch=originalFetch;});

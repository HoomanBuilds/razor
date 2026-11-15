import { assertNoActiveClearing } from "../../src/server/clearing/locks";
import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../../src/server/context";
import { getDb, row, rows, transaction } from "../../src/server/db";
import { getRecipient } from "../../src/server/identity/recipients";
import { getPayment, getTreasury, assertPaymentLiabilityApproved } from "../../src/server/payments/service";
import type { Token } from "../../src/server/payments/intents";
import { insert, stamp } from "../demo/seed";
import { demoPrices } from "./environment";

const noDeposit = "SIMULATION ONLY - DO NOT SEND FUNDS";
export function previewDemoFunding(access: AccessContext, tokens: Token[], input: unknown) {
  requirePermission(access,"payments:prepare");
  const value = input as { originAsset?: string; amount?: string; reference?: string };
  const token = tokens.find(item => item.assetId === value?.originAsset);
  if (!token || !value?.amount || !/^[1-9]\d{0,29}$/.test(value.amount) || typeof value.reference !== "string" || !value.reference.trim() || value.reference.length > 200 || !demoPrices[token.symbol]) throw new ApiError(400,"Choose a demo asset, positive amount and reference","DEMO_FUNDING_INVALID");
  const output = BigInt(value.amount) * BigInt(demoPrices[token.symbol]) * 1_000000n / 10n ** BigInt(token.decimals);
  if (output < 1n || output > 1_000000_000000n) throw new ApiError(400,"Use a demo funding value below one million USDC","DEMO_AMOUNT_LIMIT");
  const existing = row<{ id:string; origin_asset:string; amount_in:string }>("SELECT id,origin_asset,amount_in FROM funding_legs WHERE organization_id=? AND reference=?",access.organizationId,value.reference);
  if (existing) {
    if (existing.origin_asset !== token.assetId || existing.amount_in !== value.amount) throw new ApiError(409,"This funding reference already has different terms","DEMO_REFERENCE_CONFLICT");
    return row("SELECT * FROM funding_legs WHERE id=?",existing.id);
  }
  const id = randomUUID(), deadline = new Date(Date.now()+3600_000).toISOString();
  insert(getDb(),"funding_legs",{ id,organization_id:access.organizationId,reference:value.reference,origin_asset:token.assetId,origin_network:token.blockchain,origin_symbol:token.symbol,origin_decimals:token.decimals,amount_in:value.amount,expected_output:output.toString(),quote:JSON.stringify({simulated:true,quoteRequest:{deadline},quote:{amountIn:value.amount,amountOut:output.toString(),deadline}}),deposit_address:noDeposit,recipient_address:noDeposit,status:"pending_deposit",created_at:stamp(),updated_at:stamp() });
  return row("SELECT * FROM funding_legs WHERE id=?",id);
}
export function creditDemoFunding(access: AccessContext, fundingId:string) {
  requirePermission(access,"payments:prepare");
  return transaction(db=>{
    const leg=row<{id:string;status:string;expected_output:string;quote:string}>("SELECT id,status,expected_output,quote FROM funding_legs WHERE id=? AND organization_id=?",fundingId,access.organizationId);
    if(!leg)throw new ApiError(404,"Demo funding not found","DEMO_FUNDING_NOT_FOUND");
    if(!JSON.parse(leg.quote).simulated)throw new ApiError(409,"Only simulated demo funding can be credited","DEMO_ONLY");
    if(leg.status==="confirmed")return;
    if(leg.status!=="pending_deposit")throw new ApiError(409,"This funding leg cannot be credited","DEMO_FUNDING_STATE");
    const current=row<{balance:string;reserved:string}>("SELECT balance,reserved FROM treasury_balances WHERE organization_id=?",access.organizationId)!;
    const after=BigInt(current.balance)+BigInt(leg.expected_output);
    db.prepare("UPDATE treasury_balances SET balance=?,updated_at=? WHERE organization_id=?").run(after.toString(),stamp(),access.organizationId);
    db.prepare("UPDATE funding_legs SET status='confirmed',credited_amount=expected_output,provider_status='SIMULATED_DELIVERED',updated_at=? WHERE id=?").run(stamp(),fundingId);
    insert(db,"treasury_ledger",{id:randomUUID(),organization_id:access.organizationId,reference:`demo-funding:${fundingId}`,entry_type:"funding",amount:leg.expected_output,balance_after:after.toString(),reserved_after:current.reserved,metadata:JSON.stringify({simulated:true,fundingId}),created_at:stamp()});
  });
}
export function settleDemoPayments(access:AccessContext, paymentIds:string[], tokens:Token[]) {
  requirePermission(access,"payments:execute");
  if(!paymentIds.length||paymentIds.length>100)throw new ApiError(400,"Select up to 100 demo payments","DEMO_PAYMENT_LIMIT");
  return transaction(db=>{
    if(row<{paused:number}>("SELECT paused FROM organizations WHERE id=?",access.organizationId)?.paused)throw new ApiError(409,"This company paused payments","DEMO_COMPANY_PAUSED");
    const treasury=getTreasury(access);let spent=0n,released=0n;
    for(const id of [...new Set(paymentIds)]) {
      const payment=getPayment(access,id);
      if(payment.status==="paid")continue;
      assertNoActiveClearing(access.organizationId,id);
      assertPaymentLiabilityApproved(access,payment);
      const recipient=getRecipient(access.organizationId,payment.recipient_id),snapshot=JSON.parse(payment.recipient_snapshot);
      if(!payment.approved_at || !["approved","approved_unfunded"].includes(payment.status) || payment.partial_delivery_observed || BigInt(payment.delivered_amount)>0n || BigInt(payment.total_spent)>0n)throw new ApiError(409,"Approve this payment before simulating delivery. Uncertain outcomes stay held.","DEMO_PAYMENT_NOT_APPROVED");
      if(rows("SELECT id FROM payout_attempts WHERE payment_id=? AND state NOT IN ('closed_unfunded','refunded_verified')",id).length)throw new ApiError(409,"Resolve the existing attempt before another delivery","DEMO_ATTEMPT_EXISTS");
      if(recipient.archived||recipient.preference_status!=="confirmed"||!recipient.confirmed_at||recipient.version!==payment.recipient_version||snapshot.primary_asset!==recipient.primary_asset||snapshot.primary_network!==recipient.primary_network||snapshot.primary_address!==recipient.primary_address||(snapshot.primary_memo??null)!==(recipient.primary_memo??null))throw new ApiError(409,"Receiving details changed. Review this payment again.","DEMO_RECIPIENT_CHANGED");
      const asset=tokens.find(token=>token.assetId===recipient.primary_asset&&token.blockchain===recipient.primary_network);
      if(!asset||!demoPrices[asset.symbol])throw new ApiError(409,"This asset is not available in the demo simulator","DEMO_ASSET_UNSUPPORTED");
      if(row("SELECT network FROM payment_networks WHERE organization_id=? AND network=? AND enabled=0",access.organizationId,asset.blockchain))throw new ApiError(409,"This payout network is disabled","DEMO_NETWORK_DISABLED");
      const fee=BigInt(payment.max_fee)<400000n?BigInt(payment.max_fee):400000n,total=BigInt(payment.amount)+fee,output=BigInt(payment.amount)*10n**BigInt(asset.decimals)/(BigInt(demoPrices[asset.symbol])*1_000000n);
      if(output<=0n)throw new ApiError(409,"The amount is too small for this demo asset","DEMO_AMOUNT_TOO_SMALL");
      spent+=total;released+=BigInt(payment.reserved_amount);
      const attemptId=randomUUID();
      insert(db,"payout_attempts",{id:attemptId,payment_id:id,organization_id:access.organizationId,route:"primary",state:"delivered",quote:JSON.stringify({simulated:true,quote:{amountIn:total.toString(),amountOut:output.toString()}}),destination_asset:asset.assetId,destination_network:asset.blockchain,destination_address:recipient.primary_address,destination_memo:recipient.primary_memo,destination_symbol:asset.symbol,destination_decimals:asset.decimals,expected_output:output.toString(),amount_in:total.toString(),deposit_address:noDeposit,provider_status:"SIMULATED_DELIVERED",reconciliation:JSON.stringify({simulated:true,chain:{attempts:[{id:attemptId,actual_output:output.toString()}]}}),created_at:stamp(),updated_at:stamp()});
      db.prepare("UPDATE payments SET status='paid',delivered_amount=amount,total_spent=?,reserved_amount='0',chain_reserved='0',updated_at=? WHERE id=?").run(total.toString(),stamp(),id);
      insert(db,"activity",{id:randomUUID(),organization_id:access.organizationId,actor_id:access.userId,action:"payment.delivered",entity_id:id,details:JSON.stringify({simulated:true,reference:payment.reference,amount:payment.amount,output:output.toString()}),created_at:stamp()});
    }
    if(!spent)return;
    const current=row<{balance:string;reserved:string}>("SELECT balance,reserved FROM treasury_balances WHERE organization_id=?",access.organizationId)!;
    const after=BigInt(current.balance)-spent,reserved=BigInt(current.reserved)-released;
    if(reserved<0n||after<reserved||spent>BigInt(treasury.available)+released)throw new ApiError(409,"Fund this demo treasury without using other reserved cash","DEMO_INSUFFICIENT_FUNDS");
    db.prepare("UPDATE treasury_balances SET balance=?,reserved=?,updated_at=? WHERE organization_id=?").run(after.toString(),reserved.toString(),stamp(),access.organizationId);
    insert(db,"treasury_ledger",{id:randomUUID(),organization_id:access.organizationId,reference:`demo-payout:${randomUUID()}`,entry_type:"payment",amount:(-spent).toString(),balance_after:after.toString(),reserved_after:reserved.toString(),metadata:JSON.stringify({simulated:true,paymentIds}),created_at:stamp()});
  });
}

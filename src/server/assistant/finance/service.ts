import { randomUUID } from "node:crypto";
import { completeAiUsage, reserveAiUsage } from "../../billing/usage";
import { duplicateInvoiceWarnings } from "../../business/duplicate-invoices";
export { duplicateInvoiceWarnings } from "../../business/duplicate-invoices";
import { liabilityTotals } from "../../reconciliation/liability";
import { paymentBudget } from "../../../lib/payment-budget";
import { ApiError, requirePermission, type AccessContext } from "../../context";
import { getDb, row, rows, transaction } from "../../db";
import { decrypt, encrypt } from "../../identity/crypto";
import { audit } from "../../identity/session";
import { createPayrollRun, getPayrollRun } from "../../business/service";
import { getTreasury } from "../../payments/service";
import { parseUnits } from "../../../lib/money";
import { getAssistantConfig, requirePrivateAiConfig } from "../config";
import { runVerifiedPrivateInference } from "../client";
import { sha256 } from "../verification";
import { createAnalysisPacket } from "../packet";
import { privateHistoryQuery, privateHistoryWindow } from "../../private-history";
import { financeSourceFingerprint, planningInput, validateModelPlan, type PlanningInput, type PlanSource, type SelectedRecipient } from "./plans";

interface OpenPayment {id:string;recipient_id:string;reference:string;kind:string;status:string;amount:string;max_fee:string;total_spent:string;reserved_amount:string;scheduled_for:string|null;hold_reason:string|null;metadata:string;delivered_amount:string}
interface StoredPlan {id:string;organization_id:string;plan_hash:string;source_fingerprint:string;payload_ciphertext:string;evidence_ciphertext:string;prepared_run_id:string|null;created_at:string;expires_at:string}
interface Payload {instruction:string;source:PlanSource;sourceFingerprint:string;allocations:Array<{recipientId:string;opaqueId:string;version:number;amount:string}>;total:string;feeBudget:string;maximumCost:string;explanation:string;warnings:string[];verification:Record<string,unknown>;context:{availableUSDC:string;lastSyncedAt:string|null;openUnreservedUSDC?:string}}
const activePlans=new Set<string>();

function plannerPermission(access:AccessContext) {
  for(const permission of ["company:read","payments:read","payments:prepare","recipients:read","documents:manage"])requirePermission(access,permission);
}


export function financeInsights(access:AccessContext) {
  requirePermission(access,"payments:read");
  const treasury=getTreasury(access),open=rows<OpenPayment>("SELECT id,recipient_id,reference,kind,status,amount,max_fee,total_spent,reserved_amount,scheduled_for,hold_reason,metadata,delivered_amount FROM payments WHERE organization_id=? AND (status NOT IN ('paid','cancelled','partially_paid') OR (status='partially_paid' AND NOT EXISTS(SELECT 1 FROM partial_remainders r WHERE r.original_payment_id=payments.id))) ORDER BY COALESCE(scheduled_for,created_at)",access.organizationId);
  let upcoming=0n,unreserved=0n,drafts=0n,committed=0n,awaitingReconciliation=0n;
  const budgets=open.map(payment=>{
    const missingRemainder=payment.status==="partially_paid",unpaid=BigInt(payment.amount)-BigInt(payment.delivered_amount),budget=missingRemainder?{remaining:unpaid,unreserved:unpaid,awaitingReconciliation:0n}:paymentBudget(payment),cost=budget.remaining,needed=budget.unreserved;
    awaitingReconciliation+=budget.awaitingReconciliation;
    upcoming+=cost;unreserved+=needed;if(payment.status==="draft")drafts+=cost;else committed+=cost;
    const {metadata,...summary}=payment;
    let reference=payment.reference;
    try{const display=JSON.parse(metadata)?.displayReference;if(typeof display==="string")reference=display;}catch{}
    if(/^(bill|payroll):/.test(reference))reference=payment.kind==="payroll"?"Payroll payment":"Invoice payment";
    return {...summary,reference,remainingBudgetUSDC:cost.toString(),unreservedUSDC:needed.toString()};
  });
  const unpreparedInvoices=rows<{id:string;amount:string;setoff_amount:string;funded_clearing_amount:string}>("SELECT id,amount,setoff_amount,funded_clearing_amount FROM bills WHERE organization_id=?",access.organizationId).reduce((sum,bill)=>sum+liabilityTotals(bill.amount,rows<{amount:string;delivered_amount:string;total_spent:string;status:string}>("SELECT p.amount,p.delivered_amount,p.total_spent,p.status FROM payments p JOIN bill_installments i ON i.payment_id=p.id WHERE i.bill_id=? AND p.organization_id=?",bill.id,access.organizationId),bill.setoff_amount,bill.funded_clearing_amount).unprepared,0n);
  const available=BigInt(treasury.available),neededTotal=unreserved+unpreparedInvoices,shortfall=neededTotal>available?neededTotal-available:0n;
  const warnings:Array<Record<string,unknown>>=duplicateInvoiceWarnings(rows<{id:string;recipient_id:string;reference:string;amount:string;created_at:string}>("SELECT id,recipient_id,reference,amount,created_at FROM bills WHERE organization_id=?",access.organizationId));
  for(const payment of open)if(payment.status==="partially_paid")warnings.push({code:"PARTIAL_REMAINDER_REQUIRED",message:"A terminal partial delivery left unpaid entitlement. Prepare a new remainder with current recipient terms and fresh approval; the original cannot retry.",paymentId:payment.id,remainingUSDC:(BigInt(payment.amount)-BigInt(payment.delivered_amount)).toString()});
  if(!treasury.lastSyncedAt||Date.now()-Date.parse(treasury.lastSyncedAt)>300000)warnings.unshift({code:"CASH_SNAPSHOT_STALE",message:"Cash coverage uses the last recorded NEAR treasury snapshot. Sync it before making funding decisions."});
  if(unpreparedInvoices>0n)warnings.unshift({code:"UNPREPARED_INVOICE_LIABILITY",message:"Invoice principal remains without an active installment or remainder. It is included in the coverage gap; future routing fees are not assumed.",amountUSDC:unpreparedInvoices.toString()});
  if(shortfall>0n)warnings.unshift({code:"CASH_SHORTFALL",message:"Recorded available cash is below unreserved payment budgets and unprepared invoice principal. This includes draft proposals; no payment has been blocked or approved by this calculation.",amountUSDC:shortfall.toString()});
  for(const payment of open)if(BigInt(payment.total_spent)>BigInt(payment.amount)+BigInt(payment.max_fee))warnings.push({code:"BUDGET_OVERAGE",message:"Recorded payment spend exceeds its approved amount and fee budget. Review its receipts.",paymentId:payment.id});
  let privateAI:ReturnType<typeof getAssistantConfig>|{ready:false;reason:string;retentionDays:null};
  try{privateAI=getAssistantConfig();}catch(error){privateAI={ready:false,reason:error instanceof Error?error.message:"Private AI configuration needs attention",retentionDays:null};}
  return {cash:{balance:treasury.balance,reserved:treasury.totalReserved,paymentReserved:treasury.paymentReserved,clientReserved:treasury.clientReserved,linkedFundingReserved:treasury.linkedFundingReserved,available:treasury.available,lastSyncedAt:treasury.lastSyncedAt},coverage:{upcomingUSDC:upcoming.toString(),unreservedUSDC:unreserved.toString(),unpreparedInvoiceUSDC:unpreparedInvoices.toString(),draftUSDC:drafts.toString(),committedUSDC:committed.toString(),shortfallUSDC:shortfall.toString(),includesDrafts:true,awaitingReconciliationUSDC:awaitingReconciliation.toString()},upcoming:budgets.slice(0,100),held:budgets.filter(item=>/held|hold|recovery|unknown/.test(item.status)||item.hold_reason).slice(0,100),openCount:open.length,warnings,privateAI};
}

function selectedRecipients(access:AccessContext,input:PlanningInput):SelectedRecipient[] {
  const cap=parseUnits(input.maxTotal,6);
  return input.recipientIds.map((recipientId,index)=>{
    const recipient=row<{version:number;archived:number;preference_status:string;confirmed_at:string|null;kind:string}>("SELECT version,archived,preference_status,confirmed_at,kind FROM recipients WHERE id=? AND organization_id=?",recipientId,access.organizationId);
    if(!recipient||recipient.archived||recipient.preference_status!=="confirmed"||!recipient.confirmed_at||!["employee","contractor"].includes(recipient.kind))throw new ApiError(409,"Select active, confirmed employee or contractor profiles from this company","FINANCE_RECIPIENT_UNAVAILABLE");
    const prior=row<{amount:string}>("SELECT amount FROM payments WHERE organization_id=? AND recipient_id=? AND kind='payroll' AND status='paid' AND NOT EXISTS(SELECT 1 FROM partial_remainders r WHERE r.remainder_payment_id=payments.id) ORDER BY updated_at DESC LIMIT 1",access.organizationId,recipientId);
    return {recipientId,opaqueId:`r${index+1}`,version:recipient.version,capMicroUSDC:cap,priorAmountMicroUSDC:prior?.amount || null};
  });
}

export function purgeFinancePlans() {getDb().prepare("DELETE FROM finance_plans WHERE expires_at<=?").run(new Date().toISOString());}

function readable(item:StoredPlan) {
  const payload=JSON.parse(decrypt(item.payload_ciphertext)) as Payload;
  return {id:item.id,...payload,hash:item.plan_hash,retained:true,createdAt:item.created_at,expiresAt:item.expires_at,preparedRunId:item.prepared_run_id,requiresReview:true};
}

export function financePlanHistory(access:AccessContext,input:unknown={}) {
  plannerPermission(access);
  const query=privateHistoryQuery.parse(input);
  return transaction(()=>{
    purgeFinancePlans();
    const total=row<{total:number}>("SELECT COUNT(*) AS total FROM finance_plans WHERE organization_id=?",access.organizationId)!.total,{offset,...page}=privateHistoryWindow(total,query);
    const plans=rows<StoredPlan>("SELECT * FROM finance_plans WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",access.organizationId,page.pageSize,offset).map(readable);
    return {plans,...page};
  });
}

export function listFinancePlans(access:AccessContext) {
  return financePlanHistory(access,{pageSize:100}).plans;
}

export function financePlanEvidence(access:AccessContext,id:string) {
  plannerPermission(access);purgeFinancePlans();
  const stored=row<StoredPlan>("SELECT * FROM finance_plans WHERE id=? AND organization_id=?",id,access.organizationId);
  if(!stored)throw new ApiError(404,"Finance proposal not found or retention expired","FINANCE_PLAN_NOT_FOUND");
  audit(access.userId,access.organizationId,"finance_plan.evidence_viewed",id);
  return {id,hash:stored.plan_hash,sourceFingerprint:stored.source_fingerprint,payload:JSON.parse(decrypt(stored.payload_ciphertext)),evidence:JSON.parse(decrypt(stored.evidence_ciphertext)),expiresAt:stored.expires_at};
}

export function exportFinancePacket(access: AccessContext, id: string, disclosure: "encrypted_wire" | "metadata") {
  const retained = financePlanEvidence(access, id);
  const packet = createAnalysisPacket({ id, kind: "finance_proposal", evidence: retained.evidence, model: retained.payload.verification?.model }, disclosure);
  audit(access.userId, access.organizationId, "finance_plan.packet_exported", id, { disclosure });
  return packet;
}

export async function proposeFinancePlan(access:AccessContext,data:PlanningInput) {
  plannerPermission(access);
  const input=planningInput.parse(data),config=requirePrivateAiConfig(),selected=selectedRecipients(access,input),cash=getTreasury(access);
  if(activePlans.has(access.organizationId))throw new ApiError(429,"A private payroll proposal is already running for this company","FINANCE_PLAN_BUSY");
  const source:PlanSource={reference:input.reference,periodStart:input.periodStart,periodEnd:input.periodEnd,maxTotal:parseUnits(input.maxTotal,6),maxFeePerPayment:parseUnits(input.maxFeePerPayment,6),selected};
  const feeBudget=(BigInt(source.maxFeePerPayment)*BigInt(selected.length)).toString();
  const coverage=financeInsights(access).coverage,context={availableUSDC:cash.available,lastSyncedAt:cash.lastSyncedAt,openUnreservedUSDC:coverage.unreservedUSDC};
  const modelInput=JSON.stringify({instruction:input.instruction,context:{periodStart:source.periodStart,periodEnd:source.periodEnd,netEntitlementCapMicroUSDC:source.maxTotal,fixedHumanFeeBudgetMicroUSDC:feeBudget,cashSnapshotAvailableMicroUSDC:cash.available,cashSnapshotAt:cash.lastSyncedAt,existingUnreservedBudgetsMicroUSDC:coverage.unreservedUSDC,existingDraftBudgetsMicroUSDC:coverage.draftUSDC,unpreparedInvoicePrincipalMicroUSDC:coverage.unpreparedInvoiceUSDC,recipients:selected.map(item=>({recipientId:item.opaqueId,capMicroUSDC:item.capMicroUSDC,priorPaidMicroUSDC:item.priorAmountMicroUSDC}))}});
  if(config.retentionDays)encrypt("finance-plan-storage-readiness");
  const usage=reserveAiUsage(access);
  activePlans.add(access.organizationId);
  try {
    const inference=await runVerifiedPrivateInference("finance",modelInput),plan=validateModelPlan(inference.content,source),createdAt=new Date().toISOString();
    const payload:Payload={instruction:input.instruction,source,sourceFingerprint:financeSourceFingerprint(source),allocations:plan.allocations,total:plan.total,feeBudget,maximumCost:(BigInt(plan.total)+BigInt(feeBudget)).toString(),explanation:plan.explanation,warnings:plan.warnings,verification:inference.verification,context};
    const planHash=sha256(JSON.stringify(payload)),id=config.retentionDays?randomUUID():null,expiresAt=id?new Date(Date.now()+config.retentionDays*86400000).toISOString():null;
    transaction(db=>{
      purgeFinancePlans();
      if(id&&expiresAt)db.prepare("INSERT INTO finance_plans (id,organization_id,created_by,plan_hash,source_fingerprint,payload_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,access.organizationId,access.userId,planHash,payload.sourceFingerprint,encrypt(JSON.stringify(payload)),encrypt(JSON.stringify(inference.evidence)),createdAt,expiresAt);
      audit(access.userId,access.organizationId,"finance_plan.proposed",id || undefined,{retained:!!id});
    });
    completeAiUsage(usage.id,"completed");
    return {id,...payload,hash:planHash,retained:!!id,createdAt,expiresAt,preparedRunId:null,requiresReview:true};
  }catch(error){completeAiUsage(usage.id,"failed");throw error;}finally{activePlans.delete(access.organizationId);}
}

export function prepareFinancePlan(access:AccessContext,id:string,planHash:string) {
  plannerPermission(access);purgeFinancePlans();
  return transaction(db=>{
    const stored=row<StoredPlan>("SELECT * FROM finance_plans WHERE id=? AND organization_id=?",id,access.organizationId);
    if(!stored)throw new ApiError(404,"Finance proposal not found or its private retention period expired","FINANCE_PLAN_NOT_FOUND");
    const payload=JSON.parse(decrypt(stored.payload_ciphertext)) as Payload;
    if(stored.plan_hash!==planHash||sha256(JSON.stringify(payload))!==planHash||financeSourceFingerprint(payload.source)!==stored.source_fingerprint||payload.sourceFingerprint!==stored.source_fingerprint)throw new ApiError(409,"The reviewed proposal does not match this retained source","FINANCE_PLAN_CHANGED");
    const verification=payload.verification;
    if(verification.ok!==true||verification.provider!=="NEAR AI Cloud"||verification.signatureKind!=="provider_tee"||verification.requestBound!==true||verification.responseBound!==true||verification.gatewayTlsBound!==true||verification.gpuEvidenceVerified!==true)throw new ApiError(409,"A completely verified private NEAR model proposal is required","FINANCE_VERIFICATION_REQUIRED");
    const selected=selectedRecipients(access,planningInput.parse({instruction:payload.instruction,recipientIds:payload.source.selected.map(item=>item.recipientId),reference:payload.source.reference,periodStart:payload.source.periodStart,periodEnd:payload.source.periodEnd,maxTotal:formatDecimal(payload.source.maxTotal),maxFeePerPayment:formatDecimal(payload.source.maxFeePerPayment)}));
    const currentSource={...payload.source,selected};
    if(financeSourceFingerprint(currentSource)!==stored.source_fingerprint)throw new ApiError(409,"Recipient versions or allocation constraints changed. Review a fresh proposal.","FINANCE_SOURCE_CHANGED");
    const validated=validateModelPlan({allocations:payload.allocations.map(item=>({recipientId:item.opaqueId,amount:item.amount})),explanation:payload.explanation,warnings:payload.warnings},currentSource);
    if(JSON.stringify(validated.allocations)!==JSON.stringify(payload.allocations)||validated.total!==payload.total||payload.feeBudget!==(BigInt(payload.source.maxFeePerPayment)*BigInt(selected.length)).toString()||payload.maximumCost!==(BigInt(validated.total)+BigInt(payload.feeBudget)).toString())throw new ApiError(409,"The retained allocations or fee ceilings do not match the reviewed source","FINANCE_PLAN_CHANGED");
    if(stored.prepared_run_id)return {plan:readable(stored),run:getPayrollRun(access,stored.prepared_run_id),alreadyPrepared:true};
    const run=createPayrollRun(access,{reference:payload.source.reference,periodStart:payload.source.periodStart,periodEnd:payload.source.periodEnd,items:validated.allocations.map(item=>({recipientId:item.recipientId,amount:item.amount,maxFee:payload.source.maxFeePerPayment}))});
    db.prepare("UPDATE finance_plans SET prepared_run_id=? WHERE id=? AND organization_id=?").run(run.id,id,access.organizationId);
    audit(access.userId,access.organizationId,"finance_plan.draft_prepared",id,{runId:run.id});
    return {plan:readable(row<StoredPlan>("SELECT * FROM finance_plans WHERE id=?",id)!),run,alreadyPrepared:false};
  });
}

function formatDecimal(value:string):string {const text=value.padStart(7,"0");return `${text.slice(0,-6)}.${text.slice(-6)}`;}

export function deleteFinancePlan(access:AccessContext,id:string) {
  plannerPermission(access);
  const deleted=getDb().prepare("DELETE FROM finance_plans WHERE id=? AND organization_id=?").run(id,access.organizationId);
  if(!deleted.changes)throw new ApiError(404,"Finance proposal not found or retention expired","FINANCE_PLAN_NOT_FOUND");
  audit(access.userId,access.organizationId,"finance_plan.deleted",id);
  return {deleted:true};
}

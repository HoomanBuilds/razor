import { randomUUID } from "node:crypto";
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
import { financeSourceFingerprint, planningInput, validateModelPlan, type PlanningInput, type PlanSource, type SelectedRecipient } from "./plans";

interface OpenPayment {id:string;recipient_id:string;reference:string;kind:string;status:string;amount:string;max_fee:string;total_spent:string;reserved_amount:string;scheduled_for:string|null;hold_reason:string|null;metadata:string}
interface Invoice {id:string;recipient_id:string;reference:string;amount:string;created_at:string}
interface StoredPlan {id:string;organization_id:string;plan_hash:string;source_fingerprint:string;payload_ciphertext:string;evidence_ciphertext:string;prepared_run_id:string|null;created_at:string;expires_at:string}
interface Payload {instruction:string;source:PlanSource;sourceFingerprint:string;allocations:Array<{recipientId:string;opaqueId:string;version:number;amount:string}>;total:string;feeBudget:string;maximumCost:string;explanation:string;warnings:string[];verification:Record<string,unknown>;context:{availableUSDC:string;lastSyncedAt:string|null;openUnreservedUSDC?:string}}
const activePlans=new Set<string>();

function plannerPermission(access:AccessContext) {
  for(const permission of ["company:read","payments:read","payments:prepare","recipients:read","documents:manage"])requirePermission(access,permission);
}

function normalizedReference(value:string) {return value.toLowerCase().replace(/[^a-z0-9]/g,"");}
function nearbyReference(left:string,right:string) {
  if(left===right)return true;
  if(left.length===right.length&&left.length>=5)return [...left].filter((char,index)=>char!==right[index]).length<=1;
  const a=/^(.*?)(\d+)$/.exec(left),b=/^(.*?)(\d+)$/.exec(right);
  if(!a||!b||a[1]!==b[1])return false;
  const distance=BigInt(a[2])-BigInt(b[2]);return distance>=-2n&&distance<=2n;
}

export function duplicateInvoiceWarnings(invoices:Invoice[]) {
  const groups=new Map<string,Invoice[]>(),warnings:Array<{code:string;message:string;invoiceIds:string[];references:string[];recipientId:string;amountUSDC:string}>=[];
  for(const invoice of [...invoices].sort((a,b)=>a.created_at.localeCompare(b.created_at))) {
    const key=`${invoice.recipient_id}:${invoice.amount}`,previous=groups.get(key) || [];
    for(const other of previous.slice(-10)) {
      const left=normalizedReference(other.reference),right=normalizedReference(invoice.reference),days=Math.abs(Date.parse(invoice.created_at)-Date.parse(other.created_at))/86400000;
      if(left===right || days<=31&&nearbyReference(left,right))warnings.push({code:"POSSIBLE_DUPLICATE_INVOICE",message:"The same supplier has equal invoice amounts and similar references. Review the source documents before approving another payment.",invoiceIds:[other.id,invoice.id],references:[other.reference,invoice.reference],recipientId:invoice.recipient_id,amountUSDC:invoice.amount});
    }
    previous.push(invoice);groups.set(key,previous);
  }
  return warnings.slice(-100);
}

export function financeInsights(access:AccessContext) {
  requirePermission(access,"payments:read");
  const treasury=getTreasury(access),open=rows<OpenPayment>("SELECT id,recipient_id,reference,kind,status,amount,max_fee,total_spent,reserved_amount,scheduled_for,hold_reason,metadata FROM payments WHERE organization_id=? AND status NOT IN ('paid','cancelled') ORDER BY COALESCE(scheduled_for,created_at)",access.organizationId);
  let upcoming=0n,unreserved=0n,drafts=0n,committed=0n,awaitingReconciliation=0n;
  const budgets=open.map(payment=>{
    const budget=paymentBudget(payment),cost=budget.remaining,needed=budget.unreserved;
    awaitingReconciliation+=budget.awaitingReconciliation;
    upcoming+=cost;unreserved+=needed;if(payment.status==="draft")drafts+=cost;else committed+=cost;
    const {metadata,...summary}=payment;
    let reference=payment.reference;
    try{const display=JSON.parse(metadata)?.displayReference;if(typeof display==="string")reference=display;}catch{}
    if(/^(bill|payroll):/.test(reference))reference=payment.kind==="payroll"?"Payroll payment":"Invoice payment";
    return {...summary,reference,remainingBudgetUSDC:cost.toString(),unreservedUSDC:needed.toString()};
  });
  const available=BigInt(treasury.available),shortfall=unreserved>available?unreserved-available:0n;
  const warnings:Array<Record<string,unknown>>=duplicateInvoiceWarnings(rows<Invoice>("SELECT id,recipient_id,reference,amount,created_at FROM bills WHERE organization_id=?",access.organizationId));
  if(!treasury.lastSyncedAt||Date.now()-Date.parse(treasury.lastSyncedAt)>300000)warnings.unshift({code:"CASH_SNAPSHOT_STALE",message:"Cash coverage uses the last recorded NEAR treasury snapshot. Sync it before making funding decisions."});
  if(shortfall>0n)warnings.unshift({code:"CASH_SHORTFALL",message:"Recorded available cash is below the unreserved remaining payment budgets. This includes draft proposals; no payment has been blocked or approved by this calculation.",amountUSDC:shortfall.toString()});
  for(const payment of open)if(BigInt(payment.total_spent)>BigInt(payment.amount)+BigInt(payment.max_fee))warnings.push({code:"BUDGET_OVERAGE",message:"Recorded payment spend exceeds its approved amount and fee budget. Review its receipts.",paymentId:payment.id});
  let privateAI:ReturnType<typeof getAssistantConfig>|{ready:false;reason:string;retentionDays:null};
  try{privateAI=getAssistantConfig();}catch(error){privateAI={ready:false,reason:error instanceof Error?error.message:"Private AI configuration needs attention",retentionDays:null};}
  return {cash:{balance:treasury.balance,reserved:treasury.reserved,available:treasury.available,lastSyncedAt:treasury.lastSyncedAt},coverage:{upcomingUSDC:upcoming.toString(),unreservedUSDC:unreserved.toString(),draftUSDC:drafts.toString(),committedUSDC:committed.toString(),shortfallUSDC:shortfall.toString(),includesDrafts:true,awaitingReconciliationUSDC:awaitingReconciliation.toString()},upcoming:budgets.slice(0,100),held:budgets.filter(item=>/held|hold|recovery|unknown/.test(item.status)||item.hold_reason).slice(0,100),openCount:open.length,warnings,privateAI};
}

function selectedRecipients(access:AccessContext,input:PlanningInput):SelectedRecipient[] {
  const cap=parseUnits(input.maxTotal,6);
  return input.recipientIds.map((recipientId,index)=>{
    const recipient=row<{version:number;archived:number;preference_status:string;confirmed_at:string|null;kind:string}>("SELECT version,archived,preference_status,confirmed_at,kind FROM recipients WHERE id=? AND organization_id=?",recipientId,access.organizationId);
    if(!recipient||recipient.archived||recipient.preference_status!=="confirmed"||!recipient.confirmed_at||!["employee","contractor"].includes(recipient.kind))throw new ApiError(409,"Select active, confirmed employee or contractor profiles from this company","FINANCE_RECIPIENT_UNAVAILABLE");
    const prior=row<{amount:string}>("SELECT amount FROM payments WHERE organization_id=? AND recipient_id=? AND kind='payroll' AND status='paid' ORDER BY updated_at DESC LIMIT 1",access.organizationId,recipientId);
    return {recipientId,opaqueId:`r${index+1}`,version:recipient.version,capMicroUSDC:cap,priorAmountMicroUSDC:prior?.amount || null};
  });
}

export function purgeFinancePlans() {getDb().prepare("DELETE FROM finance_plans WHERE expires_at<=?").run(new Date().toISOString());}

function readable(item:StoredPlan) {
  const payload=JSON.parse(decrypt(item.payload_ciphertext)) as Payload;
  return {id:item.id,...payload,hash:item.plan_hash,retained:true,createdAt:item.created_at,expiresAt:item.expires_at,preparedRunId:item.prepared_run_id,requiresReview:true};
}

export function listFinancePlans(access:AccessContext) {
  plannerPermission(access);purgeFinancePlans();
  return rows<StoredPlan>("SELECT * FROM finance_plans WHERE organization_id=? ORDER BY created_at DESC LIMIT 100",access.organizationId).map(readable);
}

export function financePlanEvidence(access:AccessContext,id:string) {
  plannerPermission(access);purgeFinancePlans();
  const stored=row<StoredPlan>("SELECT * FROM finance_plans WHERE id=? AND organization_id=?",id,access.organizationId);
  if(!stored)throw new ApiError(404,"Finance proposal not found or retention expired","FINANCE_PLAN_NOT_FOUND");
  audit(access.userId,access.organizationId,"finance_plan.evidence_viewed",id);
  return {id,hash:stored.plan_hash,sourceFingerprint:stored.source_fingerprint,evidence:JSON.parse(decrypt(stored.evidence_ciphertext)),expiresAt:stored.expires_at};
}

export async function proposeFinancePlan(access:AccessContext,data:PlanningInput) {
  plannerPermission(access);
  const input=planningInput.parse(data),config=requirePrivateAiConfig(),selected=selectedRecipients(access,input),cash=getTreasury(access);
  if(activePlans.has(access.organizationId))throw new ApiError(429,"A private payroll proposal is already running for this company","FINANCE_PLAN_BUSY");
  const source:PlanSource={reference:input.reference,periodStart:input.periodStart,periodEnd:input.periodEnd,maxTotal:parseUnits(input.maxTotal,6),maxFeePerPayment:parseUnits(input.maxFeePerPayment,6),selected};
  const feeBudget=(BigInt(source.maxFeePerPayment)*BigInt(selected.length)).toString();
  const coverage=financeInsights(access).coverage,context={availableUSDC:cash.available,lastSyncedAt:cash.lastSyncedAt,openUnreservedUSDC:coverage.unreservedUSDC};
  const modelInput=JSON.stringify({instruction:input.instruction,context:{periodStart:source.periodStart,periodEnd:source.periodEnd,netEntitlementCapMicroUSDC:source.maxTotal,fixedHumanFeeBudgetMicroUSDC:feeBudget,cashSnapshotAvailableMicroUSDC:cash.available,cashSnapshotAt:cash.lastSyncedAt,existingUnreservedBudgetsMicroUSDC:coverage.unreservedUSDC,existingDraftBudgetsMicroUSDC:coverage.draftUSDC,recipients:selected.map(item=>({recipientId:item.opaqueId,capMicroUSDC:item.capMicroUSDC,priorPaidMicroUSDC:item.priorAmountMicroUSDC}))}});
  if(config.retentionDays)encrypt("finance-plan-storage-readiness");
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
    return {id,...payload,hash:planHash,retained:!!id,createdAt,expiresAt,preparedRunId:null,requiresReview:true};
  }finally{activePlans.delete(access.organizationId);}
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

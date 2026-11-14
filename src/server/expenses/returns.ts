import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { parseUnits } from "@/lib/money";
import { NATIVE_USDC } from "@/lib/native-usdc";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { audit, getAccess } from "../identity/session";
import { getRecipient, getRecipientVersion } from "../identity/recipients";
import { verifiedOwnerWallet } from "../account-recovery/near";
import { reviewedArtifactHash } from "../near-artifacts";
import { createDirectFunding, DIRECT_USDC_ASSET, DIRECT_USDC_TOKEN } from "../payments/direct-funding";
import { contractCodeHash, nearTransactionStatus, sharedFundingMessage, verifySharedDeposit, verifyTokenReceipt, view } from "../payments/near";
import { syncTreasury } from "../payments/service";
import type { ChainPayment, Payment, PayoutAttempt, TreasuryConfig } from "../payments/types";
import { partialProof } from "../partial-settlement/proof";
import { spentSource } from "../partial-settlement/model";

const now=()=>new Date().toISOString();
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const units=z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).transform(value=>parseUnits(value));
const note=z.string().trim().min(3).max(2000);
export const paidCorrectionInput=z.object({requestKey:z.string().uuid(),paymentId:z.string().uuid(),expectedExpenseVersion:z.number().int().positive(),correctedAmountUSDC:units,returnAmountUSDC:units,reason:note,replacesId:z.string().uuid().optional()}).strict();
export const correctionDecisionInput=z.object({expectedVersion:z.number().int().positive(),termsHash:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(["accept","reject","cancel"]),note}).strict();
export const returnPrepareInput=z.object({expectedVersion:z.number().int().positive(),termsHash:z.string().regex(/^[a-f0-9]{64}$/),amountUSDC:units,sourceAccount:z.string().min(2).max(64)}).strict();
export const returnBeginInput=z.object({reviewToken:z.string().uuid(),signerAccount:z.string().min(2).max(64)}).strict();
export const returnReceiptInput=z.object({transactionHash:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)}).strict();
interface Expense {id:string;organization_id:string;submitted_by:string;recipient_id:string;recipient_version:number;version:number;amount:string;bill_id:string|null;status:string;superseded_by:string|null}
interface Correction {id:string;organization_id:string;expense_id:string;payment_id:string;staff_user_id:string;expense_version:number;profile_version:number;proposed_by:string;proposer_role:"staff"|"company";corrected_amount:string;return_amount:string;source_ciphertext:string;source_hash:string;terms_hash:string;reason_ciphertext:string;status:string;version:number;company_consent_by:string|null;staff_consent_by:string|null;replaces_id:string|null;request_key:string;request_hash:string;created_at:string;updated_at:string}
interface Leg {id:string;correction_id:string;amount:string;source_account:string;source_public_key:string;profile_version:number;target_ciphertext:string;instructions_ciphertext:string;state:string;review_token:string;review_expires_at:string;begun_at:string|null;transaction_hash:string|null;reported_transaction_hash:string|null;credit_id:string|null;proof_ciphertext:string|null;confirmed_at:string|null;balance_synced_at:string|null;created_at:string}
interface Source {expenseId:string;expenseVersion:number;originalGross:string;billId:string;paymentId:string;paymentAmount:string;deliveredAmount:string;expenseDelivered:string;sourceSpend:string;routingCost:string;cashExposure:string;recipientId:string;originalProfileVersion:number;profileVersion:number;staffUserId:string;settlementReceipt:string;destinationNetwork:string;destinationAsset:string;destinationOutput:string|null;ledgerFingerprint:string}

function company(access:AccessContext,approve=false) {const current=getAccess(access.userId,access.organizationId);for(const value of ["payments:read","documents:manage",...(approve?["payments:approve"]:[])])requirePermission(current,value);return current;}
function expenseFor(id:string) {const value=row<Expense>("SELECT * FROM expense_requests WHERE id=?",id);if(!value)throw new ApiError(404,"Expense not found","EXPENSE_NOT_FOUND");return value;}
function correctionFor(id:string) {const value=row<Correction>("SELECT * FROM expense_paid_corrections WHERE id=?",id);if(!value)throw new ApiError(404,"Expense correction not found","EXPENSE_CORRECTION_NOT_FOUND");return value;}
function own(userId:string,id:string) {const value=correctionFor(id);if(value.staff_user_id!==userId)throw new ApiError(404,"Expense correction not found","EXPENSE_CORRECTION_NOT_FOUND");return value;}
function scoped(access:AccessContext,id:string,approve=false) {company(access,approve);const value=correctionFor(id);if(value.organization_id!==access.organizationId)throw new ApiError(404,"Expense correction not found","EXPENSE_CORRECTION_NOT_FOUND");return value;}
function liveProfile(expense:Expense) {const profile=getRecipient(expense.organization_id,expense.recipient_id),original=getRecipientVersion(expense.organization_id,expense.recipient_id,expense.recipient_version);if(profile.user_id!==expense.submitted_by||original?.user_id!==expense.submitted_by||!["employee","contractor"].includes(profile.kind)||profile.archived||profile.preference_status!=="confirmed"||!profile.confirmed_at)throw new ApiError(409,"The original staff owner and current confirmed profile must match before agreeing a return","EXPENSE_RETURN_PROFILE_CHANGED");return profile;}
function installments(expense:Expense) {return rows<Payment>("SELECT p.* FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND p.organization_id=? ORDER BY p.id",expense.bill_id,expense.organization_id);}
function fingerprint(expense:Expense) {return digest(installments(expense).map(value=>({id:value.id,status:value.status,amount:value.amount,delivered:value.delivered_amount,spent:value.total_spent,updated:value.updated_at})));}
async function target(org:string,reconciling=false) {
  const config=row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?",org);
  if(!config||config.architecture!=="shared_v1"||config.network!=="mainnet"||config.token_contract!==NATIVE_USDC.near)throw new ApiError(409,"Expense returns currently require the reviewed shared native-USDC NEAR mainnet treasury","EXPENSE_RETURN_NATIVE_ONLY");
  if(await contractCodeHash(config)!==reviewedArtifactHash("NEAR_TREASURY_CODE_HASH","razor_treasury.wasm"))throw new ApiError(409,"Review the company treasury contract pin before accepting a return","TREASURY_CODE_MISMATCH");
  const contract=await view<{company_id:string;token_contract:string;paused:boolean}>(config,"get_config");
  if(contract.company_id!==config.company_id||contract.token_contract!==config.token_contract||!reconciling&&contract.paused)throw new ApiError(409,"The company treasury binding changed or is paused","EXPENSE_RETURN_TARGET_CHANGED");
  if(!reconciling) {
    const storage=await view<{total:string}|null>({...config,near_account_id:config.token_contract},"storage_balance_of",{account_id:config.near_account_id});
    if(!storage||BigInt(storage.total)<=0n)throw new ApiError(409,"The shared treasury must already be registered for native USDC","TREASURY_STORAGE_REQUIRED");
  }
  return config;
}
async function source(expense:Expense,paymentId:string):Promise<Source> {
  if(expense.status!=="accepted"||!expense.bill_id||expense.superseded_by)throw new ApiError(409,"Choose an accepted reimbursement with its original bill and paid portion","EXPENSE_PAID_CORRECTION_REQUIRED");
  const profile=liveProfile(expense),initialFingerprint=fingerprint(expense),payments=installments(expense),payment=payments.find(value=>value.id===paymentId);
  if(!payment||!["paid","partially_paid"].includes(payment.status)||BigInt(payment.delivered_amount)<=0n||payments.some(value=>!["paid","partially_paid","cancelled"].includes(value.status)))throw new ApiError(409,"Reconcile or cancel other active installments first. A return must bind a terminal paid or partial reimbursement","EXPENSE_RETURN_SOURCE_HELD");
  const original=getRecipientVersion(expense.organization_id,payment.recipient_id,payment.recipient_version);
  if(payment.recipient_id!==expense.recipient_id||original?.user_id!==expense.submitted_by)throw new ApiError(409,"The original paid entitlement belongs to another receiving identity","EXPENSE_RETURN_PROFILE_CHANGED");
  const config=await target(expense.organization_id),chain=await view<ChainPayment|null>(config,"get_payment",{payment_id:payment.id}),attempt=rows<PayoutAttempt>("SELECT * FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at DESC,id DESC",payment.id,expense.organization_id)[0],recorded=chain?.attempts.find(value=>value.id===attempt?.id);
  if(!chain||!attempt||!recorded||chain.status!==payment.status||chain.amount!==payment.amount||chain.recipient_id!==payment.recipient_id||chain.recipient_version!==String(payment.recipient_version)||chain.reference!==`razor:${payment.id}`||chain.reservation!=="0"||!recorded.receipt||recorded.route.quote_hash!==createHash("sha256").update(attempt.quote).digest("hex")||recorded.route.input_amount!==attempt.amount_in||recorded.route.output_amount!==attempt.expected_output||recorded.route.source_receiver!==attempt.deposit_address||spentSource(chain,attempt,recorded)!==payment.total_spent||BigInt(payment.total_spent)<=0n)throw new ApiError(409,"The final NEAR reimbursement delivery and actual source spend must match the original recorded payment","EXPENSE_RETURN_SOURCE_UNPROVEN");
  if(payment.status==="partially_paid") {const partial=partialProof(payment,attempt,chain,recorded);if(partial.credited_usdc!==payment.delivered_amount)throw new ApiError(409,"The terminal partial settlement changed","EXPENSE_RETURN_SOURCE_UNPROVEN");}
  else if(recorded.status!=="delivered"||attempt.state!=="delivered"||payment.delivered_amount!==payment.amount)throw new ApiError(409,"The full reimbursement is not authoritatively delivered","EXPENSE_RETURN_SOURCE_UNPROVEN");
  const bill=row<{setoff_amount:string;funded_clearing_amount:string;accepted_credit_amount:string}>("SELECT setoff_amount,funded_clearing_amount,accepted_credit_amount FROM bills WHERE id=? AND organization_id=?",expense.bill_id,expense.organization_id);
  if(!bill||[bill.setoff_amount,bill.funded_clearing_amount,bill.accepted_credit_amount].some(value=>BigInt(value)>0n))throw new ApiError(409,"This reimbursement has noncash or other credit adjustments requiring separate company review","EXPENSE_RETURN_SOURCE_HELD");
  const delivered=payments.reduce((sum,value)=>sum+BigInt(value.delivered_amount),0n),maximum=BigInt(payment.delivered_amount)<BigInt(payment.total_spent)?payment.delivered_amount:payment.total_spent;
  if(fingerprint(expense)!==initialFingerprint)throw new ApiError(409,"The reimbursement changed during final source verification","EXPENSE_RETURN_SOURCE_CHANGED");
  return {expenseId:expense.id,expenseVersion:expense.version,originalGross:expense.amount,billId:expense.bill_id,paymentId:payment.id,paymentAmount:payment.amount,deliveredAmount:payment.delivered_amount,expenseDelivered:delivered.toString(),sourceSpend:payment.total_spent,routingCost:chain.incurred_cost,cashExposure:maximum,recipientId:expense.recipient_id,originalProfileVersion:payment.recipient_version,profileVersion:profile.version,staffUserId:expense.submitted_by,settlementReceipt:recorded.receipt,destinationNetwork:attempt.destination_network,destinationAsset:attempt.destination_asset,destinationOutput:attempt.observed_output||recorded.actual_output||null,ledgerFingerprint:initialFingerprint};
}
function event(value:Correction,actor:string,role:string,decision:string,message:string) {getDb().prepare("INSERT INTO expense_correction_events(id,correction_id,actor_id,actor_role,version,decision,terms_hash,note_ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(),value.id,actor,role,value.version,decision,value.terms_hash,encrypt(message),now());audit(actor,value.organization_id,`expense_return.${decision}`,value.id);}
const legs=(id:string)=>rows<Leg>("SELECT * FROM expense_return_legs WHERE correction_id=? ORDER BY created_at,id",id);
const returned=(id:string)=>legs(id).filter(value=>value.state==="confirmed").reduce((sum,value)=>sum+BigInt(value.amount),0n);
function projection(value:Correction,personal=false) {
  const original=JSON.parse(decrypt(value.source_ciphertext)) as Source,paid=returned(value.id),all=legs(value.id);
  return {id:value.id,expenseId:value.expense_id,paymentId:value.payment_id,status:value.status,version:value.version,termsHash:value.terms_hash,proposerRole:value.proposer_role,correctedAmount:value.corrected_amount,returnAmount:value.return_amount,returnedAmount:paid.toString(),unresolvedReturnAmount:(BigInt(value.return_amount)-paid).toString(),reason:decrypt(value.reason_ciphertext),source:original,companyConsented:!!value.company_consent_by,staffConsented:!!value.staff_consent_by,replacesId:value.replaces_id,createdAt:value.created_at,liabilityAdjustment:"none" as const,
    legs:all.map(leg=>({id:leg.id,amount:leg.amount,state:leg.state,transactionHash:leg.transaction_hash,reportedTransactionHash:leg.reported_transaction_hash,creditId:leg.credit_id,confirmedAt:leg.confirmed_at,balanceSyncedAt:leg.balance_synced_at,createdAt:leg.created_at,...(personal?{sourceAccount:leg.source_account,reviewToken:leg.review_token,reviewExpiresAt:leg.review_expires_at,funding:{id:`expense-return:${leg.id}`,origin_asset:DIRECT_USDC_ASSET,amount_in:leg.amount,deposit_address:(JSON.parse(decrypt(leg.target_ciphertext)) as TreasuryConfig).near_account_id,deposit_memo:null,quote:JSON.parse(decrypt(leg.instructions_ciphertext)),status:leg.state,source_tx_hash:leg.transaction_hash},token:DIRECT_USDC_TOKEN}:{})})),events:rows<{decision:string;actor_role:string;version:number;note_ciphertext:string;created_at:string}>("SELECT decision,actor_role,version,note_ciphertext,created_at FROM expense_correction_events WHERE correction_id=? ORDER BY created_at,id",value.id).map(item=>({decision:item.decision,actorRole:item.actor_role,version:item.version,note:decrypt(item.note_ciphertext),at:item.created_at}))};
}
export function expenseCorrectionSummary(expenseId:string) {return rows<Correction>("SELECT * FROM expense_paid_corrections WHERE expense_id=? ORDER BY created_at DESC,id DESC LIMIT 50",expenseId).map(value=>projection(value));}
export function personalExpenseCorrections(userId:string,expenseId:string) {const expense=expenseFor(expenseId);if(expense.submitted_by!==userId)throw new ApiError(404,"Expense not found","EXPENSE_NOT_FOUND");return {corrections:rows<Correction>("SELECT * FROM expense_paid_corrections WHERE expense_id=? AND staff_user_id=? ORDER BY created_at DESC,id DESC LIMIT 50",expenseId,userId).map(value=>projection(value,true)),linkedNearAccounts:rows<{address:string}>("SELECT address FROM linked_wallets WHERE user_id=? AND family='near' AND network='mainnet' ORDER BY address",userId).map(value=>value.address)};}

export async function proposeExpenseCorrection(actor:string,role:"staff"|"company",expenseId:string,input:unknown,access?:AccessContext) {
  const parsed=paidCorrectionInput.parse(input),expense=expenseFor(expenseId);
  if(role==="company"){if(!access||access.organizationId!==expense.organization_id)throw new ApiError(404,"Expense not found","EXPENSE_NOT_FOUND");company(access,true);}else if(expense.submitted_by!==actor)throw new ApiError(404,"Expense not found","EXPENSE_NOT_FOUND");
  const replay=row<Correction>("SELECT * FROM expense_paid_corrections WHERE proposed_by=? AND request_key=?",actor,parsed.requestKey);
  const requestHash=digest({expenseId,role,...parsed});
  if(replay){if(replay.request_hash!==requestHash)throw new ApiError(409,"This request identity already has different correction terms","EXPENSE_RETURN_REPLAY_CONFLICT");return projection(replay,role==="staff");}
  const original=await source(expense,parsed.paymentId),amount=BigInt(parsed.returnAmountUSDC),corrected=BigInt(parsed.correctedAmountUSDC);
  const overpaid=BigInt(original.expenseDelivered)>corrected?BigInt(original.expenseDelivered)-corrected:0n;
  if(expense.version!==parsed.expectedExpenseVersion||corrected>BigInt(expense.amount)||amount<=0n||amount>overpaid||amount>BigInt(original.cashExposure))throw new ApiError(422,"A return must be positive and no more than the delivered overpayment or original source cash exposure. Original unpaid obligations are not changed","EXPENSE_RETURN_AMOUNT_INVALID");
  return transaction(db=>{
    if(role==="company")company(access!,true);
    const latest=expenseFor(expenseId),profile=liveProfile(latest);
    if(latest.version!==expense.version||profile.version!==original.profileVersion||fingerprint(latest)!==original.ledgerFingerprint)throw new ApiError(409,"The reimbursement changed during review","EXPENSE_RETURN_SOURCE_CHANGED");
    const previous=rows<Correction>("SELECT * FROM expense_paid_corrections WHERE expense_id=? ORDER BY created_at DESC,id DESC",expenseId)[0];
    if(previous&&(!["rejected","cancelled"].includes(previous.status)||parsed.replacesId!==previous.id)||!previous&&parsed.replacesId)throw new ApiError(409,"Continue the existing correction or explicitly replace its rejected/cancelled predecessor","EXPENSE_RETURN_LINEAGE_LOCKED");
    const id=randomUUID(),termsHash=digest({id,expenseId,paymentId:parsed.paymentId,staff:expense.submitted_by,corrected:parsed.correctedAmountUSDC,returned:parsed.returnAmountUSDC,original}),stamp=now();
    db.prepare("INSERT INTO expense_paid_corrections(id,organization_id,expense_id,payment_id,staff_user_id,expense_version,profile_version,proposed_by,proposer_role,corrected_amount,return_amount,source_ciphertext,source_hash,terms_hash,reason_ciphertext,status,company_consent_by,staff_consent_by,replaces_id,request_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?,?,?,?)")
      .run(id,expense.organization_id,expenseId,parsed.paymentId,expense.submitted_by,expense.version,original.profileVersion,actor,role,parsed.correctedAmountUSDC,parsed.returnAmountUSDC,encrypt(JSON.stringify(original)),digest(original),termsHash,encrypt(parsed.reason),role==="company"?actor:null,role==="staff"?actor:null,parsed.replacesId||null,parsed.requestKey,requestHash,stamp,stamp);
    const saved=correctionFor(id);event(saved,actor,role,"proposed",parsed.reason);return projection(saved,role==="staff");
  });
}

export async function decideExpenseCorrection(actor:string,role:"staff"|"company",id:string,input:unknown,access?:AccessContext) {
  const parsed=correctionDecisionInput.parse(input),value=role==="staff"?own(actor,id):scoped(access!,id,true);
  let observed:Source|null=null;
  if(parsed.decision==="accept")observed=await source(expenseFor(value.expense_id),value.payment_id);
  return transaction(db=>{
    const current=role==="staff"?own(actor,id):scoped(access!,id,true);
    if(current.version!==parsed.expectedVersion||current.terms_hash!==parsed.termsHash)throw new ApiError(409,"Refresh the exact correction version before deciding","EXPENSE_RETURN_VERSION_CHANGED");
    if(!["proposed","accepted"].includes(current.status)||legs(id).length)throw new ApiError(409,"Signed, returned or unresolved correction history cannot be cancelled or replaced","EXPENSE_RETURN_LINEAGE_LOCKED");
    if(parsed.decision==="accept"&&(current.status!=="proposed"||!observed||digest(observed)!==current.source_hash||fingerprint(expenseFor(current.expense_id))!==observed.ledgerFingerprint))throw new ApiError(409,"The original reimbursement changed. Cancel this unsent correction and review a linked successor","EXPENSE_RETURN_SOURCE_CHANGED");
    if(parsed.decision==="cancel"&&role!=="company"&&current.proposed_by!==actor)throw new ApiError(403,"Only the company or proposal author can cancel an unsent correction","FORBIDDEN");
    const stamp=now(),status=parsed.decision==="accept"?"accepted":parsed.decision==="reject"?"rejected":"cancelled";
    const column=role==="company"?"company_consent_by":"staff_consent_by";
    if(parsed.decision==="accept"&&current[column])throw new ApiError(409,"Your consent is already recorded. The other party must explicitly review these terms","EXPENSE_RETURN_OTHER_CONSENT_REQUIRED");
    db.prepare(`UPDATE expense_paid_corrections SET status=?,version=version+1,${column}=CASE WHEN ?='accept' THEN ? ELSE ${column} END,updated_at=? WHERE id=? AND version=?`).run(status,parsed.decision,actor,stamp,id,current.version);
    event(correctionFor(id),actor,role,status,parsed.note);return projection(correctionFor(id),role==="staff");
  });
}

export async function prepareExpenseReturn(userId:string,id:string,input:unknown) {
  const parsed=returnPrepareInput.parse(input),value=own(userId,id);
  if(value.status!=="accepted"||!value.company_consent_by||!value.staff_consent_by||value.version!==parsed.expectedVersion||value.terms_hash!==parsed.termsHash)throw new ApiError(409,"Both parties must approve this exact current correction before a voluntary return","EXPENSE_RETURN_CONSENT_REQUIRED");
  const old=legs(id).find(leg=>leg.state!=="confirmed");
  if(old&&(old.state!=="prepared"||old.begun_at||old.transaction_hash))return projection(value,true);
  if(old&&(old.amount!==parsed.amountUSDC||old.source_account!==parsed.sourceAccount))throw new ApiError(409,"The existing prepared transfer keeps its exact source, amount and deposit identity","EXPENSE_RETURN_SOURCE_HELD");
  const original=await source(expenseFor(value.expense_id),value.payment_id);
  if(digest(original)!==value.source_hash)throw new ApiError(409,"The original financial record or receiving profile changed. Review the accepted correction with finance before sending","EXPENSE_RETURN_SOURCE_CHANGED");
  const config=await target(value.organization_id),wallet=await verifiedOwnerWallet(userId,parsed.sourceAccount,"mainnet"),amount=BigInt(parsed.amountUSDC),legId=old?.id||randomUUID(),deadline=new Date(Date.now()+30*60000).toISOString();
  if(old&&(wallet.public_key!==old.source_public_key||digest(config)!==digest(JSON.parse(decrypt(old.target_ciphertext)))))throw new ApiError(409,"The existing prepared source or company target changed","EXPENSE_RETURN_SOURCE_CHANGED");
  const instructions=createDirectFunding(config,`expense-return:${legId}`,{amount:parsed.amountUSDC,refundTo:wallet.address,deadline,swapType:"EXACT_INPUT",dry:false});
  return transaction(db=>{
    const current=own(userId,id);
    if(current.status!=="accepted"||current.version!==parsed.expectedVersion||fingerprint(expenseFor(value.expense_id))!==original.ledgerFingerprint||liveProfile(expenseFor(value.expense_id)).version!==value.profile_version)throw new ApiError(409,"The correction changed during wallet preparation","EXPENSE_RETURN_SOURCE_CHANGED");
    if(old) {
      const renewed=db.prepare("UPDATE expense_return_legs SET instructions_ciphertext=?,review_token=?,review_expires_at=?,updated_at=? WHERE id=? AND state='prepared' AND begun_at IS NULL AND transaction_hash IS NULL AND review_token=?").run(encrypt(JSON.stringify(instructions)),randomUUID(),deadline,now(),old.id,old.review_token);
      if(renewed.changes!==1)throw new ApiError(409,"The previous wallet review changed. Refresh its original transfer","EXPENSE_RETURN_SOURCE_HELD");
      return projection(current,true);
    }
    if(legs(id).some(leg=>leg.state!=="confirmed"))throw new ApiError(409,"Reconcile the existing return leg before another transfer","EXPENSE_RETURN_SOURCE_HELD");
    if(amount<=0n||amount>BigInt(value.return_amount)-returned(id))throw new ApiError(422,"Return no more than this correction's unresolved amount","EXPENSE_RETURN_AMOUNT_INVALID");
    const stamp=now();db.prepare("INSERT INTO expense_return_legs(id,correction_id,amount,source_account,source_public_key,profile_version,target_ciphertext,instructions_ciphertext,state,review_token,review_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?,?,?)").run(legId,id,parsed.amountUSDC,wallet.address,wallet.public_key,value.profile_version,encrypt(JSON.stringify(config)),encrypt(JSON.stringify(instructions)),randomUUID(),deadline,stamp,stamp);
    event(current,userId,"staff","return_prepared","Explicit native NEAR USDC return prepared. No funds have been assumed received; the original delivered entitlement remains delivered.");return projection(current,true);
  });
}

function legFor(correction:Correction,legId:string) {const leg=row<Leg>("SELECT * FROM expense_return_legs WHERE id=? AND correction_id=?",legId,correction.id);if(!leg)throw new ApiError(404,"Return transfer not found","EXPENSE_RETURN_NOT_FOUND");return leg;}
export async function beginExpenseReturn(userId:string,id:string,legId:string,input:unknown) {
  const parsed=returnBeginInput.parse(input),value=own(userId,id),leg=legFor(value,legId),config=await target(value.organization_id),wallet=await verifiedOwnerWallet(userId,leg.source_account,"mainnet");
  if(digest(config)!==digest(JSON.parse(decrypt(leg.target_ciphertext)))||wallet.public_key!==leg.source_public_key||digest(await source(expenseFor(value.expense_id),value.payment_id))!==value.source_hash)throw new ApiError(409,"The signer, company target or original reimbursement changed before signing","EXPENSE_RETURN_SOURCE_CHANGED");
  return transaction(db=>{
    const current=own(userId,id),latest=legFor(current,legId);
    if(current.status!=="accepted"||latest.state!=="prepared"||latest.review_token!==parsed.reviewToken||latest.review_expires_at<=now()||latest.source_account!==parsed.signerAccount||liveProfile(expenseFor(current.expense_id)).version!==latest.profile_version||fingerprint(expenseFor(current.expense_id))!==(JSON.parse(decrypt(current.source_ciphertext)) as Source).ledgerFingerprint)throw new ApiError(409,"This wallet review changed, expired or already began. Reconcile its saved source before another transfer","EXPENSE_RETURN_SOURCE_HELD");
    const changed=db.prepare("UPDATE expense_return_legs SET state='signing',begun_at=?,updated_at=? WHERE id=? AND state='prepared' AND review_token=?").run(now(),now(),legId,parsed.reviewToken);
    if(changed.changes!==1)throw new ApiError(409,"Another wallet review already began","EXPENSE_RETURN_SOURCE_HELD");
    event(current,userId,"staff","return_signing","The staff member explicitly opened the fixed native USDC return. Cancellation or a timeout does not prove that it was not broadcast.");return {begun:true};
  });
}

export async function reconcileExpenseReturn(actor:string,role:"staff"|"company",id:string,legId:string,input:unknown,access?:AccessContext) {
  const parsed=returnReceiptInput.parse(input),value=role==="staff"?own(actor,id):scoped(access!,id,true),leg=legFor(value,legId);
  if(leg.state==="confirmed"){
    if(leg.transaction_hash!==parsed.transactionHash)throw new ApiError(409,"This return already closed with another receipt","EXPENSE_RETURN_RECEIPT_REUSED");
    await syncTreasury({userId:actor,organizationId:value.organization_id,permissions:["company:read"]});
    getDb().prepare("UPDATE expense_return_legs SET balance_synced_at=? WHERE id=? AND state='confirmed'").run(now(),leg.id);
    return projection(value,role==="staff");
  }
  transaction(db=>{
    const latest=legFor(value,legId);
    if(latest.transaction_hash&&latest.transaction_hash!==parsed.transactionHash)throw new ApiError(409,"Keep the original tracked source transaction","EXPENSE_RETURN_SOURCE_HELD");
    db.prepare("UPDATE expense_return_legs SET state='source_unknown',reported_transaction_hash=?,updated_at=? WHERE id=? AND state!='confirmed'").run(parsed.transactionHash,now(),legId);
  });
  const config=JSON.parse(decrypt(leg.target_ciphertext)) as TreasuryConfig,current=await target(value.organization_id,true);
  if(digest(config)!==digest(current))throw new ApiError(409,"The company treasury changed. This source remains held for review","EXPENSE_RETURN_TARGET_CHANGED");
  const result=await nearTransactionStatus(config,parsed.transactionHash,leg.source_account),call=result.transaction?.actions?.[0]?.FunctionCall;
  let args:Record<string,unknown>|null=null;try{if(call)args=JSON.parse(Buffer.from(call.args,"base64").toString());}catch{}
  if(result.transaction?.receiver_id!==config.token_contract||result.transaction.actions?.length!==1||call?.method_name!=="ft_transfer_call"||args?.receiver_id!==config.near_account_id||args.amount!==leg.amount||args.msg!==sharedFundingMessage(config,`expense-return:${leg.id}`))throw new ApiError(409,"The final source does not match the exact token, company, return purpose and amount","EXPENSE_RETURN_RECEIPT_UNPROVEN");
  const proof=await verifyTokenReceipt(config,parsed.transactionHash,leg.source_account,config.near_account_id,leg.amount);
  if(proof.events.length!==1||proof.events.some(item=>item.sender!==leg.source_account))throw new ApiError(409,"The final return token event belongs to another sender or purpose","EXPENSE_RETURN_RECEIPT_UNPROVEN");
  const credit=await verifySharedDeposit(config,proof,`expense-return:${leg.id}`);
  transaction(db=>{
    const latest=legFor(value,legId),correction=correctionFor(id);
    if(role==="company")scoped(access!,id,true);else own(actor,id);
    if(latest.state==="confirmed")return;
    if(latest.transaction_hash&&latest.transaction_hash!==parsed.transactionHash||returned(id)+BigInt(leg.amount)>BigInt(correction.return_amount))throw new ApiError(409,"The exact return amount or source changed during verification","EXPENSE_RETURN_SOURCE_HELD");
    for(const transfer of proof.events) {
      if(row("SELECT id FROM funding_credit_receipts WHERE network=? AND token_contract=? AND receipt_id=? AND log_index=? AND data_index=?",config.network,config.token_contract,transfer.receiptId,transfer.logIndex,transfer.dataIndex))throw new ApiError(409,"This receipt already belongs to another funding purpose","EXPENSE_RETURN_RECEIPT_REUSED");
      if(row("SELECT leg_id FROM expense_return_receipts WHERE network=? AND token_contract=? AND (credit_id=? AND company_id=? OR receipt_id=? AND log_index=? AND data_index=?)",config.network,config.token_contract,credit.credit_id,credit.company_id,transfer.receiptId,transfer.logIndex,transfer.dataIndex))throw new ApiError(409,"This company deposit credit was already consumed","EXPENSE_RETURN_RECEIPT_REUSED");
      db.prepare("INSERT INTO expense_return_receipts(network,token_contract,receipt_id,log_index,data_index,leg_id,credit_id,company_id,amount,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(config.network,config.token_contract,transfer.receiptId,transfer.logIndex,transfer.dataIndex,leg.id,credit.credit_id,credit.company_id,transfer.amount,now());
    }
    db.prepare("UPDATE expense_return_legs SET state='confirmed',transaction_hash=?,credit_id=?,proof_ciphertext=?,confirmed_at=?,updated_at=? WHERE id=? AND state!='confirmed'").run(parsed.transactionHash,credit.credit_id,encrypt(JSON.stringify({proof,credit,termsHash:correction.terms_hash})),now(),now(),legId);
    if(returned(id)===BigInt(correction.return_amount))db.prepare("UPDATE expense_paid_corrections SET status='returned',version=version+1,updated_at=? WHERE id=? AND status='accepted'").run(now(),id);
    event(correctionFor(id),actor,role,"return_verified","The final tagged native USDC token receipt and exact shared-company deposit credit were independently verified. Original delivered payments remain unchanged.");
  });
  // Staff get a scoped return result, never a company's balance or finance capability.
  await syncTreasury({userId:actor,organizationId:value.organization_id,permissions:["company:read"]});
  getDb().prepare("UPDATE expense_return_legs SET balance_synced_at=? WHERE id=? AND state='confirmed'").run(now(),leg.id);
  return projection(correctionFor(id),role==="staff");
}

export function expenseReturnAccounting(organizationId:string) {
  return rows<Correction>("SELECT * FROM expense_paid_corrections WHERE organization_id=? ORDER BY created_at,id",organizationId).map(value=>{const original=JSON.parse(decrypt(value.source_ciphertext)) as Source,paid=returned(value.id);return {correctionId:value.id,expenseId:value.expense_id,paymentId:value.payment_id,status:value.status,originalGross:original.originalGross,deliveredPrincipal:original.deliveredAmount,originalSourceSpend:original.sourceSpend,acceptedCorrectedAmount:value.company_consent_by&&value.staff_consent_by?value.corrected_amount:null,agreedReturnAmount:value.return_amount,actualReturnedUSDC:paid.toString(),unresolvedReturnAmount:(BigInt(value.return_amount)-paid).toString(),liabilityAdjustment:"0",provenance:paid>0n?"final_native_token_and_shared_company_credit":"unverified_no_return",createdAt:value.created_at};});
}

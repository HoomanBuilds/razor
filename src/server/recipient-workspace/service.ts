import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getRecipient, getRecipientVersion, type RecipientRecord } from "../identity/recipients";
import { audit } from "../identity/session";
import { createBill } from "../business/service";
import { billCommitmentFields } from "../vendor-commitments/service";
import { parseUnits } from "../../lib/money";

const Decimal=z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).refine(value=>{try{return BigInt(parseUnits(value,6))>0n;}catch{return false;}},"Enter a positive decimal amount with up to six decimal places");
const DateInput=z.string().date();
export const invoiceInput=z.object({recipientId:z.string().min(1),reference:z.string().trim().min(1).max(120),amount:Decimal,currency:z.string().trim().regex(/^[A-Z]{3,8}$/, "Use an uppercase currency code such as USD, EUR or USDC"),dueDate:DateInput.optional(),lineItems:z.array(z.object({description:z.string().trim().min(1).max(500),quantity:Decimal,unitPrice:Decimal})).min(1).max(100),text:z.string().trim().max(5000).optional(),commitmentReference:billCommitmentFields.commitmentReference,commitmentDate:billCommitmentFields.commitmentDate});
export const reviewInput=z.object({sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),agreedUSDC:Decimal,maxFee:z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).default("1"),title:z.string().trim().min(1).max(240).optional(),dueDate:DateInput.optional(),reviewConfirmed:z.literal(true),...billCommitmentFields});
type InvoiceInput=z.infer<typeof invoiceInput>;
interface Intake {id:string;organization_id:string;recipient_id:string;submitted_by:string;source_fingerprint:string;payload_ciphertext:string;status:string;bill_id:string|null;review_ciphertext:string|null;created_at:string;updated_at:string}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function ownRecipient(userId:string,recipientId:string):RecipientRecord {
  const owned=row<{organization_id:string}>("SELECT organization_id FROM recipients WHERE id = ? AND user_id = ?",recipientId,userId);
  if(!owned)throw new ApiError(404,"This recipient profile is not linked to your verified account","RECIPIENT_NOT_FOUND");
  return getRecipient(owned.organization_id,recipientId);
}

export function ownProfiles(userId:string) {
  const current=rows<{id:string;organization_id:string;company_name:string}>("SELECT r.id,r.organization_id,o.name AS company_name FROM recipients r JOIN organizations o ON o.id=r.organization_id WHERE r.user_id = ? ORDER BY r.created_at DESC",userId).map(profile=>({recipient:getRecipient(profile.organization_id,profile.id),company:{id:profile.organization_id,name:profile.company_name},historicalOnly:false}));
  const profiles=new Map(current.map(profile=>[profile.recipient.id,profile]));
  const historical=rows<{recipient_id:string;organization_id:string;company_name:string;profile_ciphertext:string}>("SELECT v.recipient_id,r.organization_id,o.name AS company_name,v.profile_ciphertext FROM recipient_versions v JOIN recipients r ON r.id=v.recipient_id JOIN organizations o ON o.id=r.organization_id WHERE v.changed_by=? ORDER BY v.version DESC",userId);
  for(const saved of historical){
    if(profiles.has(saved.recipient_id))continue;
    const recipient=JSON.parse(decrypt(saved.profile_ciphertext)) as RecipientRecord;
    if(recipient.user_id!==userId||recipient.id!==saved.recipient_id||recipient.organization_id!==saved.organization_id||recipient.preference_status!=="confirmed"||!recipient.confirmed_at)continue;
    profiles.set(saved.recipient_id,{recipient,company:{id:saved.organization_id,name:saved.company_name},historicalOnly:true});
  }
  return [...profiles.values()];
}

interface PersonalPayment {
  id:string;organization_id:string;recipient_id:string;company_name:string;reference:string;kind:string;amount:string;delivered_amount:string;total_spent:string;status:string;scheduled_for:string|null;created_at:string;recipient_version:number;recipient_snapshot:string;metadata:string;bill_reference:string|null;bill_title:string|null;payroll_reference:string|null;period_start:string|null;period_end:string|null;
}

function authorizedPayments(userId:string,recipientId?:string,paymentId?:string) {
  if(recipientId&&!ownProfiles(userId).some(profile=>profile.recipient.id===recipientId))throw new ApiError(404,"This recipient history is not linked to your verified account","RECIPIENT_NOT_FOUND");
  const payments=rows<PersonalPayment>(`SELECT p.id,p.organization_id,p.recipient_id,o.name AS company_name,p.reference,p.kind,p.amount,p.delivered_amount,p.total_spent,p.status,p.scheduled_for,p.created_at,p.recipient_version,p.recipient_snapshot,p.metadata,b.reference AS bill_reference,b.title AS bill_title,pr.reference AS payroll_reference,pr.period_start,pr.period_end
    FROM payments p JOIN recipients r ON r.id=p.recipient_id AND r.organization_id=p.organization_id JOIN organizations o ON o.id=p.organization_id
    LEFT JOIN bill_installments bi ON bi.payment_id=p.id LEFT JOIN bills b ON b.id=bi.bill_id AND b.organization_id=p.organization_id AND b.recipient_id=r.id
    LEFT JOIN payroll_items pi ON pi.payment_id=p.id AND pi.recipient_id=r.id LEFT JOIN payroll_runs pr ON pr.id=pi.run_id AND pr.organization_id=p.organization_id
    WHERE (r.user_id=? OR EXISTS (SELECT 1 FROM recipient_versions v WHERE v.recipient_id=r.id AND v.version=p.recipient_version AND v.changed_by=?)) ${recipientId?"AND r.id=?":""} ${paymentId?"AND p.id=?":""} ORDER BY p.created_at DESC,p.id DESC`,userId,userId,...(recipientId?[recipientId]:[]),...(paymentId?[paymentId]:[]));
  const ownership=new Map<string,boolean>();
  return payments.filter(payment=>{
    const key=`${payment.organization_id}:${payment.recipient_id}:${payment.recipient_version}`;
    if(!ownership.has(key)){
      const profile=getRecipientVersion(payment.organization_id,payment.recipient_id,payment.recipient_version);
      ownership.set(key,profile?.user_id===userId&&profile.organization_id===payment.organization_id&&profile.id===payment.recipient_id&&profile.preference_status==="confirmed"&&!!profile.confirmed_at);
    }
    return ownership.get(key);
  });
}

function personalPayment(payment:PersonalPayment) {
  let metadata:Record<string,unknown>={},snapshot:Record<string,unknown>={};
  try{metadata=JSON.parse(payment.metadata);snapshot=JSON.parse(payment.recipient_snapshot);}catch{}
  const displayReference=payment.bill_reference || payment.payroll_reference || (typeof metadata.displayReference==="string"?metadata.displayReference:null) || (/^(bill|payroll):/.test(payment.reference)?payment.kind==="payroll"?"Payroll payment":"Invoice payment":payment.reference);
  const attempts=rows<{id:string;route:string;state:string;quote:string;destination_asset:string;destination_network:string;destination_address:string;destination_memo:string|null;destination_symbol:string|null;destination_decimals:number|null;expected_output:string;destination_tx_hash:string|null;source_tx_hash:string|null;reconciliation:string|null}>("SELECT id,route,state,quote,destination_asset,destination_network,destination_address,destination_memo,destination_symbol,destination_decimals,expected_output,destination_tx_hash,source_tx_hash,reconciliation FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at,id",payment.id,payment.organization_id).map(({reconciliation,quote,...attempt})=>{
    let treasuryReceipt:string|null=null,reportedOutputAtomic:string|null=null,confirmedOutputAtomic:string|null=null;
    try{
      const data=JSON.parse(reconciliation || "null"),chain=data?.chain?.attempts?.find((value:{id:string})=>value.id===attempt.id);
      treasuryReceipt=typeof chain?.receipt==="string"?chain.receipt:null;
      const reported=data?.provider?.swapDetails?.amountOut;
      if(typeof reported==="string"&&/^\d+$/.test(reported))reportedOutputAtomic=reported;
      if(attempt.state==="delivered"&&typeof chain?.actual_output==="string"&&/^[1-9]\d*$/.test(chain.actual_output))confirmedOutputAtomic=chain.actual_output;
      if(attempt.state==="delivered"&&JSON.parse(quote).kind==="direct")confirmedOutputAtomic=attempt.expected_output;
    }catch{}
    if(attempt.state==="partially_delivered")confirmedOutputAtomic=row<{actual_output:string}>("SELECT actual_output FROM partial_settlements WHERE payment_id=? AND attempt_id=? AND organization_id=?",payment.id,attempt.id,payment.organization_id)?.actual_output ?? null;
    return {...attempt,treasuryReceipt,reportedOutputAtomic,confirmedOutputAtomic};
  });
  const clearing=row<{round_id:string;amount:string;residual_payment_id:string|null;proof_block_hash:string;proof_block_height:string}>("SELECT round_id,amount,residual_payment_id,proof_block_hash,proof_block_height FROM clearing_setoffs WHERE original_payment_id=? AND organization_id=?",payment.id,payment.organization_id) ?? null;
  const fundedClearing=row<{round_id:string;amount:string;mode:string;proof_block_hash:string;proof_block_height:string}>("SELECT round_id,amount,mode,proof_block_hash,proof_block_height FROM clearing_funded_discharges WHERE original_payment_id=? AND organization_id=?",payment.id,payment.organization_id) ?? null;
  const creditRetirement=row<{noteId:string;billId:string;retiredAmount:string;acceptedCreditAmount:string;remainingLiability:string}>("SELECT r.note_id noteId,r.bill_id billId,r.original_amount retiredAmount,b.accepted_credit_amount acceptedCreditAmount,b.amount remainingLiability FROM invoice_credit_retirements r JOIN bills b ON b.id=r.bill_id AND b.organization_id=r.organization_id WHERE r.payment_id=? AND r.organization_id=?",payment.id,payment.organization_id)??null;
  if(creditRetirement){const bill=row<{amount:string;setoff_amount:string;funded_clearing_amount:string}>("SELECT amount,setoff_amount,funded_clearing_amount FROM bills WHERE id=? AND organization_id=?",creditRetirement.billId,payment.organization_id)!;const paid=rows<{delivered_amount:string}>("SELECT p.delivered_amount FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND p.organization_id=?",creditRetirement.billId,payment.organization_id).reduce((sum,p)=>sum+BigInt(p.delivered_amount),0n);creditRetirement.remainingLiability=(BigInt(bill.amount)-paid-BigInt(bill.setoff_amount)-BigInt(bill.funded_clearing_amount)-BigInt(creditRetirement.acceptedCreditAmount)).toString();}
  const remaining=creditRetirement?0n:BigInt(payment.amount)-BigInt(payment.delivered_amount)-BigInt(fundedClearing?.amount??"0");
  return {clearing,fundedClearing,creditRetirement,id:payment.id,recipient_id:payment.recipient_id,company:{id:payment.organization_id,name:payment.company_name},reference:displayReference,title:payment.bill_title?decrypt(payment.bill_title):null,kind:payment.kind,amount:payment.amount,delivered_amount:payment.delivered_amount,remaining_amount:(remaining>0n?remaining:0n).toString(),total_spent:payment.total_spent,amountAsset:"USDC",amountDecimals:6,status:payment.status,scheduled_for:payment.scheduled_for,created_at:payment.created_at,periodStart:payment.period_start || (typeof metadata.periodStart==="string"?metadata.periodStart:null),periodEnd:payment.period_end || (typeof metadata.periodEnd==="string"?metadata.periodEnd:null),preference:{primaryAsset:snapshot.primary_asset,primaryNetwork:snapshot.primary_network,primaryMemo:snapshot.primary_memo ?? null,backupNetwork:snapshot.backup_network,fallbackConsent:snapshot.fallback_consent===1},attempts};
}

export function ownPayments(userId:string,recipientId?:string) {
  return authorizedPayments(userId,recipientId).map(personalPayment);
}

export function ownPaymentPage(userId:string,page:number,pageSize:number,recipientId?:string) {
  checkPage(page,pageSize);
  const records=authorizedPayments(userId,recipientId),start=(page-1)*pageSize;
  return {payments:records.slice(start,start+pageSize).map(personalPayment),total:records.length,page,pageSize,hasMore:start+pageSize<records.length};
}

export function ownPayment(userId:string,paymentId:string) {
  const payment=authorizedPayments(userId,undefined,paymentId)[0];
  if(!payment)throw new ApiError(404,"This payment is not linked to your verified account","PAYMENT_NOT_FOUND");
  return personalPayment(payment);
}

function readableRequest(request:Intake) {
  const payload=JSON.parse(decrypt(request.payload_ciphertext)) as InvoiceInput;
  const bill=request.bill_id?row<{status:string;amount:string;setoff_amount:string;funded_clearing_amount:string;accepted_credit_amount:string;payment_id:string|null}>("SELECT status,amount,setoff_amount,funded_clearing_amount,accepted_credit_amount,payment_id FROM bills WHERE id=? AND organization_id=? AND recipient_id=?",request.bill_id,request.organization_id,request.recipient_id):null;
  const paymentStatus=bill?.payment_id?row<{status:string}>("SELECT status FROM payments WHERE id=? AND recipient_id=? AND organization_id=?",bill.payment_id,request.recipient_id,request.organization_id)?.status:null;
  const installments=bill?rows<{delivered_amount:string}>("SELECT p.delivered_amount FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND p.organization_id=? AND p.recipient_id=?",request.bill_id!,request.organization_id,request.recipient_id):[];
  const paid=installments.reduce((sum,item)=>sum+BigInt(item.delivered_amount),0n),setoff=BigInt(bill?.setoff_amount ?? "0"),funded=BigInt(bill?.funded_clearing_amount??"0"),credit=BigInt(bill?.accepted_credit_amount??"0"),discharged=setoff+funded+credit,billStatus=bill?(bill.status==="disputed"?"disputed":paid+discharged>=BigInt(bill.amount)?credit>0n?paid+setoff+funded>0n?"settled":"credited":discharged>0n?paid>0n?"settled":"cleared":"paid":discharged>0n?"partially_settled":paid>0n?"partially_paid":bill.status):null;
  return {id:request.id,organizationId:request.organization_id,recipientId:request.recipient_id,sourceFingerprint:request.source_fingerprint,payload,status:request.status,billId:request.bill_id,review:request.review_ciphertext?JSON.parse(decrypt(request.review_ciphertext)):null,billStatus,paymentStatus:paymentStatus || null,settledUSDC:paid.toString(),setoffUSDC:setoff.toString(),fundedDischargeUSDC:funded.toString(),acceptedCreditUSDC:credit.toString(),remainingUSDC:bill?(BigInt(bill.amount)-paid-discharged).toString():null,createdAt:request.created_at,updatedAt:request.updated_at};
}

export function ownRequests(userId:string) {
  return rows<Intake>("SELECT i.* FROM recipient_invoice_requests i JOIN recipients r ON r.id=i.recipient_id AND r.organization_id=i.organization_id WHERE i.submitted_by=? ORDER BY i.created_at DESC,i.id DESC",userId).map(readableRequest);
}

export function ownRequestPage(userId:string,page:number,pageSize:number) {
  checkPage(page,pageSize);
  const total=row<{total:number}>("SELECT COUNT(*) AS total FROM recipient_invoice_requests WHERE submitted_by=?",userId)!.total,start=(page-1)*pageSize;
  const requests=rows<Intake>("SELECT * FROM recipient_invoice_requests WHERE submitted_by=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",userId,pageSize,start).map(readableRequest);
  return {requests,total,page,pageSize,hasMore:start+pageSize<total};
}

function checkPage(page:number,pageSize:number) {
  if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new ApiError(422,"Choose a valid history page and page size","INVALID_INPUT");
}

export function submitInvoice(userId:string,data:InvoiceInput) {
  const input=invoiceInput.parse(data),recipient=ownRecipient(userId,input.recipientId);
  if(recipient.archived||recipient.preference_status!=="confirmed"||!recipient.confirmed_at)throw new ApiError(409,"Confirm your active receiving profile before submitting an invoice","RECIPIENT_CONFIRMATION_REQUIRED");
  if(!["contractor","business"].includes(recipient.kind))throw new ApiError(403,"Invoice requests are available to confirmed contractors and suppliers","SUPPLIER_PROFILE_REQUIRED");
  const total=BigInt(parseUnits(input.amount,6))*1000000n,lineTotal=input.lineItems.reduce((sum,item)=>sum+BigInt(parseUnits(item.quantity,6))*BigInt(parseUnits(item.unitPrice,6)),0n);
  if(total!==lineTotal)throw new ApiError(400,"Line items must total the stated invoice amount exactly","INVOICE_TOTAL_MISMATCH");
  const sourceFingerprint=hash({organizationId:recipient.organization_id,...input}),referenceHash=hash(input.reference);
  return transaction(db=>{
    const old=row<Intake>("SELECT * FROM recipient_invoice_requests WHERE organization_id=? AND recipient_id=? AND reference_hash=?",recipient.organization_id,recipient.id,referenceHash);
    if(old){if(old.submitted_by!==userId)throw new ApiError(409,"This invoice reference is already used by an earlier recipient. Choose a new reference.","INVOICE_REFERENCE_CONFLICT");if(old.source_fingerprint!==sourceFingerprint)throw new ApiError(409,"This invoice reference already contains different terms","INVOICE_REFERENCE_CONFLICT");return readableRequest(old);}
    const id=randomUUID(),now=new Date().toISOString();
    db.prepare("INSERT INTO recipient_invoice_requests (id,organization_id,recipient_id,submitted_by,reference_hash,source_fingerprint,payload_ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,recipient.organization_id,recipient.id,userId,referenceHash,sourceFingerprint,encrypt(JSON.stringify(input)),now,now);
    audit(userId,recipient.organization_id,"invoice_request.submitted",id,{sourceFingerprint});
    return readableRequest(row<Intake>("SELECT * FROM recipient_invoice_requests WHERE id=?",id)!);
  });
}

export function companyRequests(access:AccessContext,page?:{page:number;pageSize:number}) {
  requirePermission(access,"payments:read");
  const query="SELECT * FROM recipient_invoice_requests WHERE organization_id=? ORDER BY created_at DESC,id DESC";
  const records=page?rows<Intake>(`${query} LIMIT ? OFFSET ?`,access.organizationId,page.pageSize,(page.page-1)*page.pageSize):rows<Intake>(query,access.organizationId);
  return records.map(request=>{
    const versions=rows<{version:number}>("SELECT version FROM recipient_versions WHERE recipient_id=? AND created_at<=? ORDER BY version DESC",request.recipient_id,request.created_at);
    const original=versions.map(version=>getRecipientVersion(access.organizationId,request.recipient_id,version.version)).find(profile=>profile?.user_id===request.submitted_by&&profile.preference_status==="confirmed");
    const current=getRecipient(access.organizationId,request.recipient_id);
    const recipientName=original?.name ?? (current.user_id===request.submitted_by?current.name:"Original invoice submitter");
    return {...readableRequest(request),recipientName};
  });
}

export function companyRequestPage(access:AccessContext,page:number,pageSize:number) {
  requirePermission(access,"payments:read");checkPage(page,pageSize);
  const total=row<{total:number}>("SELECT COUNT(*) AS total FROM recipient_invoice_requests WHERE organization_id=?",access.organizationId)!.total;
  return {requests:companyRequests(access,{page,pageSize}),total,page,pageSize,hasMore:page*pageSize<total};
}

export function prepareInvoiceRequest(access:AccessContext,id:string,data:z.infer<typeof reviewInput>) {
  requirePermission(access,"payments:prepare");
  const input=reviewInput.parse(data),agreedAmount=parseUnits(input.agreedUSDC,6),maxFee=parseUnits(input.maxFee,6);
  return transaction(db=>{
    const request=row<Intake>("SELECT * FROM recipient_invoice_requests WHERE id=? AND organization_id=?",id,access.organizationId);
    if(!request)throw new ApiError(404,"Invoice request not found","INVOICE_REQUEST_NOT_FOUND");
    if(request.source_fingerprint!==input.sourceFingerprint)throw new ApiError(409,"The invoice source changed. Review the current request before creating a draft.","INVOICE_SOURCE_CHANGED");
    const payload=JSON.parse(decrypt(request.payload_ciphertext)) as InvoiceInput;
    const title=input.title || `Invoice ${payload.reference}`,dueDate=input.dueDate || payload.dueDate;
    if(payload.commitmentReference&&input.commitmentReference&&payload.commitmentReference!==input.commitmentReference)throw new ApiError(409,"Preserve the supplier's named purchase commitment. Correct a reviewed bill match explicitly with an authorized reason","COMMITMENT_REFERENCE_CHANGED");
    const purchase={commitmentReference:input.commitmentReference??payload.commitmentReference,commitmentDate:input.commitmentDate??payload.commitmentDate,commitmentScopeConfirmed:input.commitmentScopeConfirmed};
    const review={sourceFingerprint:input.sourceFingerprint,agreedUSDC:agreedAmount,maxFee,title,dueDate:dueDate || null,reviewConfirmed:true,...(purchase.commitmentReference?purchase:{})};
    if(request.review_ciphertext&&JSON.stringify(JSON.parse(decrypt(request.review_ciphertext)))!==JSON.stringify(review))throw new ApiError(409,"This request already has a reviewed draft with different agreed terms","INVOICE_REVIEW_CONFLICT");
    const recipient=getRecipient(access.organizationId,request.recipient_id);
    if(recipient.user_id!==request.submitted_by)throw new ApiError(409,"The receiving profile now belongs to a different person. Review the original supplier and create a separate verified profile before preparing this invoice.","INVOICE_RECIPIENT_CHANGED");
    if(recipient.archived||recipient.preference_status!=="confirmed")throw new ApiError(409,"The supplier must confirm an active receiving profile before a draft is prepared","RECIPIENT_CONFIRMATION_REQUIRED");
    const bill=createBill(access,{recipientId:request.recipient_id,reference:payload.reference,title,amount:agreedAmount,maxFee,dueDate:dueDate?`${dueDate}T00:00:00.000Z`:undefined,lineItems:payload.lineItems.map(item=>({...item,currency:payload.currency})),evidence:JSON.stringify({invoiceRequestId:id,sourceFingerprint:request.source_fingerprint,originalAmount:payload.amount,originalCurrency:payload.currency,agreement:"Human finance review confirmed the explicit USDC liability"}),documentHash:request.source_fingerprint,...purchase});
    if(bill.document_hash!==request.source_fingerprint)throw new ApiError(409,"An invoice already uses this reference with a different source. Review the existing invoice instead.","INVOICE_SOURCE_CONFLICT");
    if(request.bill_id&&request.bill_id!==bill.id)throw new ApiError(409,"This source is already bound to a different invoice draft","INVOICE_BINDING_CONFLICT");
    db.prepare("UPDATE recipient_invoice_requests SET status='prepared',bill_id=?,review_ciphertext=?,reviewed_by=?,updated_at=? WHERE id=?").run(bill.id,encrypt(JSON.stringify(review)),access.userId,new Date().toISOString(),id);
    audit(access.userId,access.organizationId,"invoice_request.reviewed",id,{billId:bill.id,sourceFingerprint:request.source_fingerprint});
    return {request:readableRequest(row<Intake>("SELECT * FROM recipient_invoice_requests WHERE id=?",id)!),bill};
  });
}

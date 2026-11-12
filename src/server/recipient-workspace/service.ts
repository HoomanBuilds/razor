import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getRecipient, type RecipientRecord } from "../identity/recipients";
import { audit } from "../identity/session";
import { createBill } from "../business/service";
import { parseUnits } from "../../lib/money";

const Decimal=z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).refine(value=>{try{return BigInt(parseUnits(value,6))>0n;}catch{return false;}},"Enter a positive decimal amount with up to six decimal places");
const DateInput=z.string().date();
export const invoiceInput=z.object({recipientId:z.string().min(1),reference:z.string().trim().min(1).max(120),amount:Decimal,currency:z.string().trim().regex(/^[A-Z]{3,8}$/, "Use an uppercase currency code such as USD, EUR or USDC"),dueDate:DateInput.optional(),lineItems:z.array(z.object({description:z.string().trim().min(1).max(500),quantity:Decimal,unitPrice:Decimal})).min(1).max(100),text:z.string().trim().max(5000).optional()});
export const reviewInput=z.object({sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),agreedUSDC:Decimal,maxFee:z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).default("1"),title:z.string().trim().min(1).max(240).optional(),dueDate:DateInput.optional(),reviewConfirmed:z.literal(true)});
type InvoiceInput=z.infer<typeof invoiceInput>;
interface Intake {id:string;organization_id:string;recipient_id:string;submitted_by:string;source_fingerprint:string;payload_ciphertext:string;status:string;bill_id:string|null;review_ciphertext:string|null;created_at:string;updated_at:string}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function ownRecipient(userId:string,recipientId:string):RecipientRecord {
  const owned=row<{organization_id:string}>("SELECT organization_id FROM recipients WHERE id = ? AND user_id = ?",recipientId,userId);
  if(!owned)throw new ApiError(404,"This recipient profile is not linked to your verified account","RECIPIENT_NOT_FOUND");
  return getRecipient(owned.organization_id,recipientId);
}

export function ownProfiles(userId:string) {
  return rows<{id:string;organization_id:string;company_name:string}>("SELECT r.id,r.organization_id,o.name AS company_name FROM recipients r JOIN organizations o ON o.id=r.organization_id WHERE r.user_id = ? ORDER BY r.created_at DESC",userId).map(profile=>({recipient:getRecipient(profile.organization_id,profile.id),company:{id:profile.organization_id,name:profile.company_name}}));
}

export function ownPayments(userId:string,recipientId?:string) {
  if(recipientId)ownRecipient(userId,recipientId);
  const payments=rows<{id:string;organization_id:string;recipient_id:string;company_name:string;reference:string;kind:string;amount:string;delivered_amount:string;status:string;scheduled_for:string|null;created_at:string;recipient_snapshot:string;metadata:string;bill_reference:string|null;bill_title:string|null;payroll_reference:string|null;period_start:string|null;period_end:string|null}>(
    `SELECT p.id,p.organization_id,p.recipient_id,o.name AS company_name,p.reference,p.kind,p.amount,p.delivered_amount,p.status,p.scheduled_for,p.created_at,p.recipient_snapshot,p.metadata,b.reference AS bill_reference,b.title AS bill_title,pr.reference AS payroll_reference,pr.period_start,pr.period_end
     FROM payments p JOIN recipients r ON r.id=p.recipient_id AND r.organization_id=p.organization_id JOIN organizations o ON o.id=p.organization_id
     LEFT JOIN bill_installments bi ON bi.payment_id=p.id LEFT JOIN bills b ON b.id=bi.bill_id AND b.organization_id=p.organization_id AND b.recipient_id=r.id
     LEFT JOIN payroll_items pi ON pi.payment_id=p.id AND pi.recipient_id=r.id LEFT JOIN payroll_runs pr ON pr.id=pi.run_id AND pr.organization_id=p.organization_id
     WHERE r.user_id = ? ${recipientId?"AND r.id = ?":""} ORDER BY p.created_at DESC LIMIT 250`,...(recipientId?[userId,recipientId]:[userId]));
  return payments.map(payment=>{
    let metadata:Record<string,unknown>={},snapshot:Record<string,unknown>={};
    try{metadata=JSON.parse(payment.metadata);snapshot=JSON.parse(payment.recipient_snapshot);}catch{}
    const displayReference=payment.bill_reference || payment.payroll_reference || (typeof metadata.displayReference==="string"?metadata.displayReference:null) || (/^(bill|payroll):/.test(payment.reference)?payment.kind==="payroll"?"Payroll payment":"Invoice payment":payment.reference);
    const attempts=rows<{id:string;route:string;state:string;destination_asset:string;destination_network:string;destination_address:string;expected_output:string;destination_tx_hash:string|null;source_tx_hash:string|null;reconciliation:string|null}>("SELECT id,route,state,destination_asset,destination_network,destination_address,expected_output,destination_tx_hash,source_tx_hash,reconciliation FROM payout_attempts WHERE payment_id=? AND organization_id=? ORDER BY created_at",payment.id,payment.organization_id).map(({reconciliation,...attempt})=>{
      let treasuryReceipt:string|null=null,reportedOutputAtomic:string|null=null;
      try{const data=JSON.parse(reconciliation || "null");treasuryReceipt=data?.chain?.attempts?.find((value:{id:string})=>value.id===attempt.id)?.receipt || null;const reported=data?.provider?.swapDetails?.amountOut;if(typeof reported==="string"&&/^\d+$/.test(reported))reportedOutputAtomic=reported;}catch{}
      return {...attempt,treasuryReceipt,reportedOutputAtomic};
    });
    return {id:payment.id,recipient_id:payment.recipient_id,company:{id:payment.organization_id,name:payment.company_name},reference:displayReference,title:payment.bill_title?decrypt(payment.bill_title):null,kind:payment.kind,amount:payment.amount,delivered_amount:payment.delivered_amount,amountAsset:"USDC",amountDecimals:6,status:payment.status,scheduled_for:payment.scheduled_for,created_at:payment.created_at,periodStart:payment.period_start || (typeof metadata.periodStart==="string"?metadata.periodStart:null),periodEnd:payment.period_end || (typeof metadata.periodEnd==="string"?metadata.periodEnd:null),preference:{primaryAsset:snapshot.primary_asset,primaryNetwork:snapshot.primary_network,backupNetwork:snapshot.backup_network,fallbackConsent:snapshot.fallback_consent===1},attempts};
  });
}

function readableRequest(request:Intake) {
  const payload=JSON.parse(decrypt(request.payload_ciphertext)) as InvoiceInput;
  const bill=request.bill_id?row<{status:string;amount:string;payment_id:string|null}>("SELECT status,amount,payment_id FROM bills WHERE id=? AND organization_id=? AND recipient_id=?",request.bill_id,request.organization_id,request.recipient_id):null;
  const paymentStatus=bill?.payment_id?row<{status:string}>("SELECT status FROM payments WHERE id=? AND recipient_id=? AND organization_id=?",bill.payment_id,request.recipient_id,request.organization_id)?.status:null;
  const installments=bill?rows<{delivered_amount:string}>("SELECT p.delivered_amount FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND p.organization_id=? AND p.recipient_id=?",request.bill_id!,request.organization_id,request.recipient_id):[];
  const paid=installments.reduce((sum,item)=>sum+BigInt(item.delivered_amount),0n),billStatus=bill?(bill.status==="disputed"?"disputed":paid>=BigInt(bill.amount)?"paid":paid>0n?"partially_paid":bill.status):null;
  return {id:request.id,organizationId:request.organization_id,recipientId:request.recipient_id,sourceFingerprint:request.source_fingerprint,payload,status:request.status,billId:request.bill_id,review:request.review_ciphertext?JSON.parse(decrypt(request.review_ciphertext)):null,billStatus,paymentStatus:paymentStatus || null,settledUSDC:paid.toString(),createdAt:request.created_at,updatedAt:request.updated_at};
}

export function ownRequests(userId:string) {
  return rows<Intake>("SELECT i.* FROM recipient_invoice_requests i JOIN recipients r ON r.id=i.recipient_id AND r.organization_id=i.organization_id WHERE r.user_id=? ORDER BY i.created_at DESC LIMIT 250",userId).map(readableRequest);
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
    if(old){if(old.source_fingerprint!==sourceFingerprint)throw new ApiError(409,"This invoice reference already contains different terms","INVOICE_REFERENCE_CONFLICT");return readableRequest(old);}
    const id=randomUUID(),now=new Date().toISOString();
    db.prepare("INSERT INTO recipient_invoice_requests (id,organization_id,recipient_id,submitted_by,reference_hash,source_fingerprint,payload_ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,recipient.organization_id,recipient.id,userId,referenceHash,sourceFingerprint,encrypt(JSON.stringify(input)),now,now);
    audit(userId,recipient.organization_id,"invoice_request.submitted",id,{sourceFingerprint});
    return readableRequest(row<Intake>("SELECT * FROM recipient_invoice_requests WHERE id=?",id)!);
  });
}

export function companyRequests(access:AccessContext) {
  requirePermission(access,"payments:read");
  return rows<Intake>("SELECT * FROM recipient_invoice_requests WHERE organization_id=? ORDER BY created_at DESC LIMIT 250",access.organizationId).map(request=>({...readableRequest(request),recipientName:getRecipient(access.organizationId,request.recipient_id).name}));
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
    const review={sourceFingerprint:input.sourceFingerprint,agreedUSDC:agreedAmount,maxFee,title,dueDate:dueDate || null,reviewConfirmed:true};
    if(request.review_ciphertext&&JSON.stringify(JSON.parse(decrypt(request.review_ciphertext)))!==JSON.stringify(review))throw new ApiError(409,"This request already has a reviewed draft with different agreed terms","INVOICE_REVIEW_CONFLICT");
    const recipient=getRecipient(access.organizationId,request.recipient_id);
    if(recipient.archived||recipient.preference_status!=="confirmed")throw new ApiError(409,"The supplier must confirm an active receiving profile before a draft is prepared","RECIPIENT_CONFIRMATION_REQUIRED");
    const bill=createBill(access,{recipientId:request.recipient_id,reference:payload.reference,title,amount:agreedAmount,maxFee,dueDate:dueDate?`${dueDate}T00:00:00.000Z`:undefined,lineItems:payload.lineItems.map(item=>({...item,currency:payload.currency})),evidence:JSON.stringify({invoiceRequestId:id,sourceFingerprint:request.source_fingerprint,originalAmount:payload.amount,originalCurrency:payload.currency,agreement:"Human finance review confirmed the explicit USDC liability"}),documentHash:request.source_fingerprint});
    if(bill.document_hash!==request.source_fingerprint)throw new ApiError(409,"An invoice already uses this reference with a different source. Review the existing invoice instead.","INVOICE_SOURCE_CONFLICT");
    if(request.bill_id&&request.bill_id!==bill.id)throw new ApiError(409,"This source is already bound to a different invoice draft","INVOICE_BINDING_CONFLICT");
    db.prepare("UPDATE recipient_invoice_requests SET status='prepared',bill_id=?,review_ciphertext=?,reviewed_by=?,updated_at=? WHERE id=?").run(bill.id,encrypt(JSON.stringify(review)),access.userId,new Date().toISOString(),id);
    audit(access.userId,access.organizationId,"invoice_request.reviewed",id,{billId:bill.id,sourceFingerprint:request.source_fingerprint});
    return {request:readableRequest(row<Intake>("SELECT * FROM recipient_invoice_requests WHERE id=?",id)!),bill};
  });
}

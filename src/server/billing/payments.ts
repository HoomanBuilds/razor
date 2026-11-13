import { createHash, randomUUID } from "node:crypto";
import { ApiError, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { encrypt, decrypt } from "../identity/crypto";
import { csvCell } from "../reconciliation/export";
import { listPublishedPlans, getPlanVersion } from "./catalog";
import { getEntitlements } from "./entitlements";
import { applyPurchase, getSubscriptionState, quotePurchase, requireBillingOwner, revokePurchase } from "./subscriptions";
import { billingCheckoutConfiguration, billingIssuer, billingQuoteHash, billingSettings, readBillingInvoice, readBillingRefund, signBillingOffer, offerSignatureMatches, verifyBillingContract, verifiedBillingTransaction, type BillingTarget, type BillingOffer } from "./chain";
import type { BillingPlan, PurchaseTerms } from "./types";
import type { BillingInvoice, BillingInvoiceDetail, BillingInvoicePage, BillingOverview } from "./payment-types";
import type { WalletTransaction } from "../payments/types";

interface InvoiceRow {id:string;organization_id:string;created_by:string;request_key:string;request_hash:string;plan_version_id:string;plan_json:string;purchase_json:string;amount:string;status:BillingInvoice["status"];network:"mainnet"|"testnet";billing_contract:string;token_contract:string;code_hash:string;payer_account:string;terms_hash:string;quote_json:string;signature:string;expires_at:string;claimed_at:string|null;submitted_hash:string|null;transaction_hash:string|null;proof_json:string|null;confirmed_at:string|null;refunded_amount:string;credit_reason:string|null;created_at:string;updated_at:string}
interface OfferRow {quote_hash:string;invoice_id:string;quote_json:string;signature:string;expires_at:string;created_at:string}
interface RefundRow {id:string;invoice_id:string;organization_id:string;requested_by:string;reason_ciphertext:string;amount:string;status:"requested"|"prepared"|"pending"|"completed"|"failed";proof_json:string|null;created_at:string;updated_at:string}
const now=()=>new Date().toISOString();
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const openStates=["prepared","claimed","submitted","expired"];
function audit(invoice:InvoiceRow,userId:string|null,action:string,details:Record<string,unknown>={}) {getDb().prepare("INSERT INTO billing_payment_audit(id,organization_id,invoice_id,user_id,action,details_json,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(),invoice.organization_id,invoice.id,userId,action,JSON.stringify(details),now());}
function lookup(organizationId:string,id:string) {const invoice=row<InvoiceRow>("SELECT * FROM billing_invoices WHERE id=? AND organization_id=?",id,organizationId);if(!invoice)throw new ApiError(404,"Subscription invoice not found","BILLING_INVOICE_NOT_FOUND");return invoice;}
function latestOffer(invoice:InvoiceRow):OfferRow {return row<OfferRow>("SELECT * FROM billing_invoice_offers WHERE invoice_id=? ORDER BY created_at DESC,quote_hash DESC LIMIT 1",invoice.id)??{invoice_id:invoice.id,quote_hash:billingQuoteHash(invoice.quote_json),quote_json:invoice.quote_json,signature:invoice.signature,expires_at:invoice.expires_at,created_at:invoice.created_at};}
function target(invoice:InvoiceRow):BillingTarget {return {network:invoice.network,billingContract:invoice.billing_contract,tokenContract:invoice.token_contract,codeHash:invoice.code_hash};}
function refundFor(invoice:InvoiceRow) {const refund=row<RefundRow>("SELECT * FROM billing_refund_requests WHERE invoice_id=? ORDER BY created_at DESC,id DESC LIMIT 1",invoice.id);return refund?{id:refund.id,reason:decrypt(refund.reason_ciphertext),amount:refund.amount,status:refund.status,createdAt:refund.created_at}:null;}
function project(invoice:InvoiceRow):BillingInvoice {const offer=latestOffer(invoice);return {id:invoice.id,organizationId:invoice.organization_id,plan:JSON.parse(invoice.plan_json) as BillingPlan,purchase:JSON.parse(invoice.purchase_json) as PurchaseTerms,amount:invoice.amount,currency:"USDC",status:invoice.status,network:invoice.network,billingContract:invoice.billing_contract,tokenContract:invoice.token_contract,payerAccount:invoice.payer_account,termsHash:invoice.terms_hash,quoteJson:offer.quote_json,signature:offer.signature,expiresAt:offer.expires_at,createdAt:invoice.created_at,updatedAt:invoice.updated_at,transactionHash:invoice.transaction_hash,submittedTransactionHash:invoice.submitted_hash,confirmedAt:invoice.confirmed_at,refundedAmount:invoice.refunded_amount,creditReason:invoice.credit_reason,refundRequest:refundFor(invoice)};}
function action(invoice:InvoiceRow):WalletTransaction {const offer=latestOffer(invoice);return {receiverId:invoice.token_contract,actions:[{type:"FunctionCall",params:{methodName:"ft_transfer_call",args:{receiver_id:invoice.billing_contract,amount:invoice.amount,msg:JSON.stringify({quote_json:offer.quote_json,signature:offer.signature})},gas:"100000000000000",deposit:"1"}}]};}
function verifiedPayer(access:AccessContext,payer:string,network:string) {if(!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND network=? AND address=?",access.userId,network,payer))throw new ApiError(403,"Link and verify the NEAR wallet that will pay this subscription","BILLING_PAYER_UNVERIFIED");}
function signOffer(invoiceId:string,organizationId:string,planVersionId:string,payer:string,billing:BillingTarget,amount:string,termsHash:string,createdAt:string,priceExpiresAt:string) {
  const expiresAt=new Date(Math.min(Date.now()+3600000,Date.parse(priceExpiresAt))).toISOString();
  const quote:BillingOffer={version:1,invoice_id:invoiceId,company_id:organizationId,plan_version_id:planVersionId,payer_id:payer,contract_id:billing.billingContract,network:billing.network,token_contract:billing.tokenContract,amount,terms_hash:termsHash,issued_at_ms:String(Date.parse(createdAt)),expires_at_ms:String(Date.parse(expiresAt))};
  const signed=signBillingOffer(quote);return {...signed,expiresAt};
}
export async function billingOverview(access:AccessContext):Promise<BillingOverview> {
  requireBillingOwner(access);
  const checkout=await billingCheckoutConfiguration();
  return {canManage:true,plans:listPublishedPlans(),entitlements:getEntitlements(access),subscriptionState:getSubscriptionState(access.organizationId),checkout,payerAccounts:rows<{address:string}>("SELECT address FROM linked_wallets WHERE user_id=? AND family='near' AND network=? ORDER BY address",access.userId,checkout.network).map(item=>item.address)};
}
export function invoicePage(access:AccessContext,page=1,pageSize=25):BillingInvoicePage {
  requireBillingOwner(access);if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new ApiError(422,"Choose a valid billing page","BILLING_PAGE_INVALID");
  const total=row<{total:number}>("SELECT COUNT(*) AS total FROM billing_invoices WHERE organization_id=?",access.organizationId)!.total;
  return {invoices:rows<InvoiceRow>("SELECT * FROM billing_invoices WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",access.organizationId,pageSize,(page-1)*pageSize).map(project),page,pageSize,total,hasMore:page*pageSize<total};
}
export async function invoiceDetail(access:AccessContext,id:string):Promise<BillingInvoiceDetail> {
  requireBillingOwner(access);const invoice=lookup(access.organizationId,id),checkout=await billingCheckoutConfiguration();
  const owned=!!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND network=? AND address=?",access.userId,invoice.network,invoice.payer_account),offer=latestOffer(invoice);
  const matches=checkout.ready&&checkout.network===invoice.network&&checkout.billingContract===invoice.billing_contract&&checkout.tokenContract===invoice.token_contract&&offerSignatureMatches(offer.quote_json,offer.signature,checkout.issuerPublicKey);
  const canSign=matches&&owned&&openStates.includes(invoice.status)&&Date.parse(offer.expires_at)>Date.now();
  const message=invoice.status==="paid"?"Payment was verified on NEAR and subscription access was applied.":invoice.status==="credit_required"?invoice.credit_reason||"Payment is confirmed and held for refund review; do not pay this invoice again.":invoice.status==="refunded"?"The original payer's refund was verified on NEAR.":!owned?"The original verified payer wallet must be linked before signing. Read-only reconciliation remains available.":!matches?checkout.reason||"This invoice uses another billing deployment. Reconcile its original contract before creating another checkout.":Date.parse(offer.expires_at)<=Date.now()?"The signed offer expired. Refresh this same invoice before opening the wallet; do not create a replacement payment.":"Review the frozen company subscription terms. The contract accepts this invoice only once and returns duplicate or excess transfers.";
  return {invoice:project(invoice),checkout,walletActions:canSign?[action(invoice)]:[],signerAccounts:owned?[invoice.payer_account]:[],network:invoice.network,canSign,message};
}
export async function createCheckout(access:AccessContext,input:{planVersionId:string;payerAccount:string;requestKey:string}):Promise<BillingInvoiceDetail> {
  requireBillingOwner(access);
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(input.requestKey))throw new ApiError(422,"Provide a stable checkout request key","BILLING_REQUEST_KEY_INVALID");
  const requestHash=hash(JSON.stringify({planVersionId:input.planVersionId,payerAccount:input.payerAccount}));
  const repeated=row<InvoiceRow>("SELECT * FROM billing_invoices WHERE organization_id=? AND request_key=?",access.organizationId,input.requestKey);
  if(repeated){if(repeated.request_hash!==requestHash)throw new ApiError(409,"The same checkout key was used with different terms","BILLING_CHECKOUT_CHANGED");return invoiceDetail(access,repeated.id);}
  const open=row<InvoiceRow>("SELECT * FROM billing_invoices WHERE organization_id=? AND status IN ('prepared','claimed','submitted','expired') ORDER BY created_at DESC LIMIT 1",access.organizationId);
  if(open)return invoiceDetail(access,open.id);
  const billing=billingSettings();billingIssuer();verifiedPayer(access,input.payerAccount,billing.network);await verifyBillingContract(billing,true);
  const purchase=quotePurchase(access.organizationId,input.planVersionId),plan=getPlanVersion(input.planVersionId),createdAt=now(),expiresAt=new Date(Math.min(Date.now()+86400000,purchase.kind==="upgrade"&&purchase.endsAt?Date.parse(purchase.endsAt):Number.MAX_SAFE_INTEGER)).toISOString(),id=randomUUID();
  const termsHash=hash(JSON.stringify({version:1,invoiceId:id,purchase,plan,payer:input.payerAccount,network:billing.network,billingContract:billing.billingContract,tokenContract:billing.tokenContract,codeHash:billing.codeHash}));
  const signed=signOffer(id,access.organizationId,plan.id,input.payerAccount,billing,purchase.amount,termsHash,createdAt,expiresAt);
  const invoiceId=transaction(db=>{
    const concurrent=row<InvoiceRow>("SELECT * FROM billing_invoices WHERE organization_id=? AND status IN ('prepared','claimed','submitted','expired') LIMIT 1",access.organizationId);
    if(concurrent)return concurrent.id;
    if(getSubscriptionState(access.organizationId).revision!==purchase.expectedRevision)throw new ApiError(409,"The subscription changed while checkout was prepared. Review it again.","BILLING_CHECKOUT_CHANGED");
    db.prepare("INSERT INTO billing_invoices(id,organization_id,created_by,request_key,request_hash,plan_version_id,plan_json,purchase_json,amount,network,billing_contract,token_contract,code_hash,payer_account,terms_hash,quote_json,signature,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,access.organizationId,access.userId,input.requestKey,requestHash,plan.id,JSON.stringify(plan),JSON.stringify(purchase),purchase.amount,billing.network,billing.billingContract,billing.tokenContract,billing.codeHash,input.payerAccount,termsHash,signed.quoteJson,signed.signature,expiresAt,createdAt,createdAt);
    db.prepare("INSERT INTO billing_invoice_offers(quote_hash,invoice_id,quote_json,signature,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(billingQuoteHash(signed.quoteJson),id,signed.quoteJson,signed.signature,signed.expiresAt,createdAt);
    audit(lookup(access.organizationId,id),access.userId,"checkout.created");return id;
  });
  return invoiceDetail(access,invoiceId);
}
function assertInvoiceChain(invoice:InvoiceRow,chain:NonNullable<Awaited<ReturnType<typeof readBillingInvoice>>["invoice"]>) {
  const accepted=row<OfferRow>("SELECT * FROM billing_invoice_offers WHERE invoice_id=? AND quote_hash=?",invoice.id,chain.quote_hash);
  if(!accepted||chain.invoice_id!==invoice.id||chain.company_id!==invoice.organization_id||chain.plan_version_id!==invoice.plan_version_id||chain.payer_id!==invoice.payer_account||chain.amount!==invoice.amount||chain.terms_hash!==invoice.terms_hash||!/^\d+$/.test(chain.refunded_amount)||BigInt(chain.refunded_amount)>BigInt(invoice.amount)||!/^\d+$/.test(chain.paid_at_ms)||!/^\d+$/.test(chain.paid_at_height))throw new ApiError(409,"The final billing receipt differs from the frozen invoice","BILLING_RECEIPT_MISMATCH");
  const quote=JSON.parse(accepted.quote_json) as BillingOffer;
  if(BigInt(chain.paid_at_ms)<BigInt(quote.issued_at_ms)-60000n||BigInt(chain.paid_at_ms)>=BigInt(quote.expires_at_ms))throw new ApiError(409,"The billing receipt is outside its signed offer window","BILLING_RECEIPT_MISMATCH");
  return accepted;
}
export async function reconcileInvoice(access:AccessContext,id:string) {requireBillingOwner(access);await reconcileInvoiceForOperator(access.organizationId,id,access.userId);return invoiceDetail(access,id);}
export async function reconcileInvoiceForOperator(organizationId:string,id:string,userId:string|null=null) {
  const invoice=lookup(organizationId,id),verified=await readBillingInvoice(target(invoice),id),chain=verified.invoice;
  if(!chain)return {invoice:project(invoice),observed:false};
  const accepted=assertInvoiceChain(invoice,chain);
  const localRefund=row<RefundRow>("SELECT * FROM billing_refund_requests WHERE invoice_id=? AND status IN ('requested','prepared','pending','failed') ORDER BY created_at DESC LIMIT 1",invoice.id);
  let remoteRefund:Awaited<ReturnType<typeof readBillingRefund>>["refund"]=null;
  if(localRefund)try{remoteRefund=(await readBillingRefund(target(invoice),localRefund.id)).refund;}catch{}
  if(remoteRefund&&localRefund&&(remoteRefund.id!==localRefund.id||remoteRefund.invoice_id!==invoice.id||remoteRefund.amount!==localRefund.amount||!["pending","completed","failed"].includes(remoteRefund.status)))throw new ApiError(409,"The recorded refund differs from this invoice request","BILLING_REFUND_MISMATCH");
  let sourceVerified=false;
  if(invoice.submitted_hash)try{sourceVerified=await verifiedBillingTransaction(target(invoice),invoice.submitted_hash,invoice.payer_account,accepted.quote_json,accepted.signature);}catch{}
  transaction(db=>{
    const current=lookup(organizationId,id),proof={network:invoice.network,billingContract:invoice.billing_contract,codeHash:invoice.code_hash,blockHash:verified.blockHash,blockHeight:verified.blockHeight,invoice:chain,sourceTransactionHashVerified:sourceVerified};
    if(BigInt(chain.refunded_amount)<BigInt(current.refunded_amount)||current.proof_json&&verified.blockHeight<Number(JSON.parse(current.proof_json).blockHeight))throw new ApiError(409,"The routing RPC returned older billing state. Keep the last confirmed receipt and check again.","BILLING_STATE_STALE");
    const confirmedAt=new Date(Math.max(Number(chain.paid_at_ms),Date.parse((JSON.parse(invoice.purchase_json) as PurchaseTerms).quotedAt))).toISOString();
    let status=current.status,creditReason=current.credit_reason;
    if(!current.confirmed_at) {
      if(BigInt(chain.refunded_amount)===BigInt(invoice.amount)){status="refunded";}
      else {try{const result=applyPurchase(organizationId,id,JSON.parse(invoice.purchase_json),confirmedAt);status=result.status==="activated"?"paid":"credit_required";creditReason=result.status==="credit_required"?result.reason??"Subscription state changed; refund review is required.":null;}catch(error){if(!(error instanceof ApiError))throw error;status="credit_required";creditReason="The received payment could not be applied to its frozen subscription. The billing operator must review its refund.";}}
    }
    if(BigInt(chain.refunded_amount)===BigInt(invoice.amount)){status="refunded";revokePurchase(organizationId,id);}
    if(sourceVerified&&invoice.submitted_hash){const old=row<{invoice_id:string}>("SELECT invoice_id FROM billing_receipt_claims WHERE network=? AND transaction_hash=?",invoice.network,invoice.submitted_hash);if(old&&old.invoice_id!==id)throw new ApiError(409,"The source transaction is already attributed to another invoice","BILLING_TRANSACTION_REUSED");db.prepare("INSERT OR IGNORE INTO billing_receipt_claims(network,transaction_hash,invoice_id) VALUES(?,?,?)").run(invoice.network,invoice.submitted_hash,id);}
    db.prepare("UPDATE billing_invoices SET status=?,confirmed_at=?,refunded_amount=?,proof_json=?,transaction_hash=COALESCE(?,transaction_hash),credit_reason=?,updated_at=? WHERE id=? AND organization_id=?").run(status,confirmedAt,chain.refunded_amount,JSON.stringify(proof),sourceVerified?invoice.submitted_hash:null,creditReason,now(),id,organizationId);
    audit(current,userId,"invoice.reconciled",{status,sourceVerified,blockHash:verified.blockHash});
    if(remoteRefund&&localRefund)db.prepare("UPDATE billing_refund_requests SET status=?,proof_json=?,updated_at=? WHERE id=?").run(remoteRefund.status,JSON.stringify({blockHash:verified.blockHash,blockHeight:verified.blockHeight,refund:remoteRefund}),now(),localRefund.id);
    if(status==="credit_required"&&!row("SELECT id FROM billing_refund_requests WHERE invoice_id=? AND status IN ('requested','prepared','pending')",id))newRefund(lookup(organizationId,id),current.created_by,creditReason||"Stale paid checkout",(BigInt(invoice.amount)-BigInt(chain.refunded_amount)).toString());
  });
  return {invoice:project(lookup(organizationId,id)),observed:true};
}
export async function claimInvoice(access:AccessContext,id:string) {
  requireBillingOwner(access);await reconcileInvoiceForOperator(access.organizationId,id,access.userId);
  const detail=await invoiceDetail(access,id);
  if(!detail.canSign) return detail;
  verifiedPayer(access,detail.invoice.payerAccount,detail.network);
  transaction(db=>{const invoice=lookup(access.organizationId,id);if(!openStates.includes(invoice.status))return;db.prepare("UPDATE billing_invoices SET status='claimed',claimed_at=COALESCE(claimed_at,?),updated_at=? WHERE id=?").run(now(),now(),id);audit(invoice,access.userId,"checkout.claimed");});
  return invoiceDetail(access,id);
}
export async function submitInvoice(access:AccessContext,id:string,transactionHash:string) {
  requireBillingOwner(access);if(!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(transactionHash))throw new ApiError(422,"Enter the original NEAR transaction hash","BILLING_HASH_INVALID");
  const invoice=lookup(access.organizationId,id);verifiedPayer(access,invoice.payer_account,invoice.network);
  if(!invoice.confirmed_at){getDb().prepare("UPDATE billing_invoices SET submitted_hash=?,status='submitted',updated_at=? WHERE id=? AND organization_id=? AND confirmed_at IS NULL").run(transactionHash,now(),id,access.organizationId);audit(invoice,access.userId,"checkout.hash_recorded");}
  return reconcileInvoice(access,id);
}
export async function refreshInvoice(access:AccessContext,id:string) {
  requireBillingOwner(access);await reconcileInvoiceForOperator(access.organizationId,id,access.userId);
  const invoice=lookup(access.organizationId,id);if(!openStates.includes(invoice.status))return invoiceDetail(access,id);
  if(Date.parse(invoice.expires_at)<=Date.now())throw new ApiError(409,"The original price hold expired. Close this unused invoice after final-chain verification before reviewing a new plan offer.","BILLING_PRICE_HOLD_EXPIRED");
  if(getSubscriptionState(access.organizationId).revision!==(JSON.parse(invoice.purchase_json) as PurchaseTerms).expectedRevision)throw new ApiError(409,"The subscription changed. Close the expired unused invoice or reconcile its original payment before creating another checkout.","BILLING_CHECKOUT_CHANGED");
  verifiedPayer(access,invoice.payer_account,invoice.network);const verified=await verifyBillingContract(target(invoice),true);
  if(verified.config.issuer_public_key!==billingIssuer().publicKey)throw new ApiError(503,"The configured issuer is not approved by this billing contract","BILLING_ISSUER_MISMATCH");
  const issuedAt=now(),signed=signOffer(id,access.organizationId,invoice.plan_version_id,invoice.payer_account,target(invoice),invoice.amount,invoice.terms_hash,issuedAt,invoice.expires_at);
  transaction(db=>{const current=lookup(access.organizationId,id);if(!openStates.includes(current.status))throw new ApiError(409,"The invoice was resolved during refresh","BILLING_CHECKOUT_CHANGED");db.prepare("INSERT INTO billing_invoice_offers(quote_hash,invoice_id,quote_json,signature,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(billingQuoteHash(signed.quoteJson),id,signed.quoteJson,signed.signature,signed.expiresAt,issuedAt);db.prepare("UPDATE billing_invoices SET status='prepared',updated_at=? WHERE id=?").run(issuedAt,id);audit(current,access.userId,"checkout.offer_refreshed");});
  return invoiceDetail(access,id);
}
export async function closeUnusedInvoice(access:AccessContext,id:string) {
  requireBillingOwner(access);const result=await reconcileInvoiceForOperator(access.organizationId,id,access.userId);if(result.observed) return invoiceDetail(access,id);
  const invoice=lookup(access.organizationId,id),offer=latestOffer(invoice),lastExpiry=row<{expires_at:string}>("SELECT MAX(expires_at) AS expires_at FROM billing_invoice_offers WHERE invoice_id=?",invoice.id)?.expires_at??offer.expires_at;
  if(Date.parse(lastExpiry)>Date.now()+60000)throw new ApiError(409,"This signed offer is still valid. Reuse this invoice or wait for its expiry before closing it.","BILLING_OFFER_STILL_VALID");
  const verified=await readBillingInvoice(target(invoice),id);if(verified.invoice)throw new ApiError(409,"An original invoice payment was observed. Reconcile it before closing.","BILLING_PAYMENT_OBSERVED");
  await finalBlockAfter(target(invoice),verified.blockHash,lastExpiry);
  transaction(db=>{const current=lookup(access.organizationId,id);if(current.confirmed_at)throw new ApiError(409,"The original payment was confirmed during closure","BILLING_PAYMENT_OBSERVED");db.prepare("UPDATE billing_invoices SET status='cancelled',updated_at=? WHERE id=? AND organization_id=?").run(now(),id,access.organizationId);audit(current,access.userId,"checkout.unused_closed");});
  return invoiceDetail(access,id);
}
async function finalBlockAfter(billing:BillingTarget,blockHash:string,expiresAt:string) {
  const response=await fetch(billing.network===(process.env.NEAR_NETWORK||"testnet")?process.env.NEAR_RPC_URL||`https://rpc.${billing.network}.near.org`:`https://rpc.${billing.network}.near.org`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"razor-billing-close",method:"block",params:{block_id:blockHash}}),cache:"no-store",signal:AbortSignal.timeout(15000)});
  const payload=await response.json() as {result?:{header?:{hash?:string;timestamp_nanosec?:string}}};
  if(!response.ok||payload.result?.header?.hash!==blockHash||!/^\d+$/.test(payload.result.header.timestamp_nanosec??"")||BigInt(payload.result.header.timestamp_nanosec!)<BigInt(Date.parse(expiresAt))*1000000n)throw new ApiError(409,"The final NEAR block has not passed every signed offer's expiry. Keep this invoice and check again.","BILLING_OFFER_STILL_VALID");
}
function newRefund(invoice:InvoiceRow,userId:string,reason:string,amount:string) {
  const id=randomUUID(),at=now();getDb().prepare("INSERT INTO billing_refund_requests(id,invoice_id,organization_id,requested_by,reason_ciphertext,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'requested',?,?)").run(id,invoice.id,invoice.organization_id,userId,encrypt(reason),amount,at,at);audit(invoice,userId,"refund.requested",{refundId:id});return id;
}
export async function requestInvoiceRefund(access:AccessContext,id:string,reason:string) {
  requireBillingOwner(access);if(!reason.trim()||reason.length>2000)throw new ApiError(422,"Explain the billing refund request in up to 2,000 characters","BILLING_REFUND_REASON_INVALID");
  await reconcileInvoiceForOperator(access.organizationId,id,access.userId);
  transaction(()=>{const invoice=lookup(access.organizationId,id);if(!invoice.confirmed_at||BigInt(invoice.refunded_amount)>=BigInt(invoice.amount))throw new ApiError(409,"A refundable confirmed subscription payment is required","BILLING_REFUND_UNAVAILABLE");if(!row("SELECT id FROM billing_refund_requests WHERE invoice_id=? AND status IN ('requested','prepared','pending')",id))newRefund(invoice,access.userId,reason.trim(),(BigInt(invoice.amount)-BigInt(invoice.refunded_amount)).toString());});return invoiceDetail(access,id);
}
export async function prepareRefundForOperator(refundId:string) {
  const refund=row<RefundRow>("SELECT * FROM billing_refund_requests WHERE id=?",refundId);if(!refund)throw new ApiError(404,"Billing refund request not found","BILLING_REFUND_NOT_FOUND");
  await reconcileInvoiceForOperator(refund.organization_id,refund.invoice_id);
  const invoice=lookup(refund.organization_id,refund.invoice_id),verified=await readBillingInvoice(target(invoice),invoice.id);if(!verified.invoice)throw new ApiError(409,"The original subscription payment is not confirmed","BILLING_REFUND_UNAVAILABLE");assertInvoiceChain(invoice,verified.invoice);
  const previous=await readBillingRefund(target(invoice),refund.id);
  if(previous.refund?.status==="completed")return reconcileRefundForOperator(refund.id);
  if(previous.refund?.status==="pending")throw new ApiError(409,"The original refund is still pending. Reconcile it before signing another action.","BILLING_REFUND_PENDING");
  if(row("WITH RECURSIVE dependent(id) AS (SELECT id FROM billing_periods WHERE organization_id=? AND source_invoice_id=? UNION ALL SELECT p.id FROM billing_periods p JOIN dependent d ON p.replaces_period_id=d.id) SELECT p.id FROM billing_periods p JOIN dependent d ON d.id=p.id WHERE p.source_invoice_id!=? AND p.revoked_at IS NULL AND p.ends_at>? LIMIT 1",refund.organization_id,invoice.id,invoice.id,now()))throw new ApiError(409,"Refund the dependent upgrade before its base subscription payment","BILLING_DEPENDENT_UPGRADE");
  const remaining=BigInt(invoice.amount)-BigInt(verified.invoice.refunded_amount);
  if(BigInt(refund.amount)>remaining||verified.invoice.pending_refund)throw new ApiError(409,"The refund amount or original refund state changed","BILLING_REFUND_CHANGED");
  if(BigInt(verified.config.available)<BigInt(refund.amount))throw new ApiError(409,"The billing operator must top up its refund reserve before authorizing this refund","BILLING_REFUND_RESERVE_REQUIRED");
  getDb().prepare("UPDATE billing_refund_requests SET status='prepared',updated_at=? WHERE id=? AND status IN ('requested','failed','prepared')").run(now(),refund.id);
  const walletActions:WalletTransaction[]=[{receiverId:invoice.billing_contract,actions:[{type:"FunctionCall",params:{methodName:"refund_payment",args:{invoice_id:invoice.id,refund_id:refund.id,amount:refund.amount},gas:"60000000000000",deposit:"1"}}]}];
  return {refundId:refund.id,organizationId:refund.organization_id,invoiceId:invoice.id,amount:refund.amount,originalPayer:invoice.payer_account,network:invoice.network,signerAccount:verified.config.owner_id,walletActions,signed:false};
}
export async function reconcileRefundForOperator(refundId:string) {
  const refund=row<RefundRow>("SELECT * FROM billing_refund_requests WHERE id=?",refundId);if(!refund)throw new ApiError(404,"Billing refund request not found","BILLING_REFUND_NOT_FOUND");
  const invoice=lookup(refund.organization_id,refund.invoice_id),verified=await readBillingRefund(target(invoice),refund.id),chain=verified.refund;
  if(!chain)return {refundId,status:refund.status,observed:false};
  if(chain.id!==refund.id||chain.invoice_id!==invoice.id||chain.amount!==refund.amount||!["pending","completed","failed"].includes(chain.status))throw new ApiError(409,"The final refund differs from the approved original-payer request","BILLING_REFUND_MISMATCH");
  const updated=await reconcileInvoiceForOperator(refund.organization_id,refund.invoice_id);
  if(chain.status==="completed"&&BigInt(updated.invoice.refundedAmount)<BigInt(refund.amount))throw new ApiError(409,"The completed refund is not reflected in the final invoice state","BILLING_REFUND_MISMATCH");
  getDb().prepare("UPDATE billing_refund_requests SET status=?,proof_json=?,updated_at=? WHERE id=?").run(chain.status,JSON.stringify({blockHash:verified.blockHash,blockHeight:verified.blockHeight,refund:chain}),now(),refund.id);
  return {refundId,status:chain.status,observed:true};
}
export function billingInvoiceReceipt(access:AccessContext,id:string) {requireBillingOwner(access);const invoice=lookup(access.organizationId,id);return {invoice:project(invoice),verification:invoice.proof_json?JSON.parse(invoice.proof_json):null,subscription:getSubscriptionState(access.organizationId),financialBoundary:"Subscription charges are separate from payroll principal, client reserves and company treasury balances.",manualRenewal:true};}
export function billingInvoiceCsv(access:AccessContext) {requireBillingOwner(access);const entries=rows<InvoiceRow>("SELECT * FROM billing_invoices WHERE organization_id=? ORDER BY created_at,id",access.organizationId);return [["invoice_id","plan_version_id","network","status","amount_micro_usdc","refunded_micro_usdc","payer_account","billing_contract","confirmed_transaction_hash","confirmed_at"].map(csvCell).join(","),...entries.map(value=>[value.id,value.plan_version_id,value.network,value.status,value.amount,value.refunded_amount,value.payer_account,value.billing_contract,value.transaction_hash,value.confirmed_at].map(csvCell).join(","))].join("\n");}
export function operatorBillingInvoices(organizationId?:string,page=1,pageSize=25) {if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new ApiError(422,"Choose a valid billing history page","BILLING_PAGE_INVALID");const total=row<{total:number}>("SELECT COUNT(*) AS total FROM billing_invoices WHERE (? IS NULL OR organization_id=?)",organizationId??null,organizationId??null)!.total;return {invoices:rows<InvoiceRow>("SELECT * FROM billing_invoices WHERE (? IS NULL OR organization_id=?) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",organizationId??null,organizationId??null,pageSize,(page-1)*pageSize).map(project),page,pageSize,total,hasMore:page*pageSize<total};}

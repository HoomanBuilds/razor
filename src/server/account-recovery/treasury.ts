import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { audit } from "../identity/session";
import { treasuryAction, view } from "../payments/near";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import { nearRpc, verifiedOwnerWallet } from "./near";
import type { RecoveryWallet } from "./state";
import { reviewedArtifactHash } from "../near-artifacts";

interface ChainAccess {owner_id:string;token_contract:string;paused:boolean;policy_version:string;per_payment_limit:string;daily_limit:string;approvers:string[];executors:string[];settlement_reporter:string|null;approval_tiers?:Array<{up_to:string;required_approvals:number}>;retained_assets_enabled?:boolean}
interface Terms {kind:"owner_transfer"|"executor_revoke"|"invalidate_approvals";treasuryAccount:string;network:"mainnet"|"testnet";tokenContract:string;codeHash:string;ownerAccount:string;newOwnerAccount?:string;executorAccount?:string;previousPolicyVersion?:string;chainFingerprint:string;roles:{approvers:string[];executors:string[];settlementReporter:string|null};walletActions:WalletTransaction[]}
interface RequestRow {id:string;organization_id:string;kind:string;terms_hash:string;terms_ciphertext:string;status:string;expires_at:string;transaction_hash:string|null}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const action=(config:TreasuryConfig,methodName:string,args:object):WalletTransaction=>treasuryAction(config,methodName,args,"1","40000000000000");

function companyOwner(access:AccessContext) {
  requirePermission(access,"company:manage");
  if(!row("SELECT id FROM organizations WHERE id=? AND owner_id=?",access.organizationId,access.userId))throw new ApiError(403,"The company owner manages treasury recovery and execution permissions","ONLY_COMPANY_OWNER");
}

async function chainState(access:AccessContext) {
  requirePermission(access,"company:manage");
  const config=row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?",access.organizationId);
  if(!config)throw new ApiError(409,"Connect the company treasury before managing its onchain access","TREASURY_SETUP_REQUIRED");
  const [chain,account]=await Promise.all([view<ChainAccess>(config,"get_config"),nearRpc<{code_hash:string}>(config.network,"query",{request_type:"view_account",finality:"final",account_id:config.near_account_id})]);
  if(account.code_hash!==reviewedArtifactHash("NEAR_TREASURY_CODE_HASH","razor_treasury.wasm"))throw new ApiError(409,"Review the treasury deployment before preparing recovery actions. Its code does not match the approved Razor treasury.","TREASURY_CODE_MISMATCH");
  if(chain.token_contract!==config.token_contract)throw new ApiError(409,"The treasury settlement token no longer matches the company configuration","TREASURY_CONFIG_CHANGED");
  const fingerprint=hash({company:config.company_id,architecture:config.architecture,owner:chain.owner_id,token:chain.token_contract,paused:chain.paused,policyVersion:chain.policy_version,perPaymentLimit:chain.per_payment_limit,dailyLimit:chain.daily_limit,approvers:[...chain.approvers].sort(),executors:[...chain.executors].sort(),reporter:chain.settlement_reporter,tiers:chain.approval_tiers || [],code:account.code_hash});
  return {config,chain,codeHash:account.code_hash,fingerprint};
}

export function assertTransferQuorum(chain:Pick<ChainAccess,"owner_id"|"approvers"|"approval_tiers">,newOwner:string) {
  const available=new Set([newOwner,...chain.approvers]).size;
  if(chain.approval_tiers?.some(tier=>tier.required_approvals>available))throw new ApiError(409,"The new owner overlaps an existing approver and would make a quorum tier unreachable. Add distinct approvers or revise the approval policy first.","OWNER_TRANSFER_QUORUM_UNREACHABLE");
  return available;
}

async function requirePausedAndClear(access:AccessContext,state:Awaited<ReturnType<typeof chainState>>) {
  if(!state.chain.paused)throw new ApiError(409,"Pause the treasury on NEAR and check its confirmed state before transferring ownership","TREASURY_PAUSE_REQUIRED");
  if(row("SELECT r.id FROM clearing_rounds r JOIN clearing_round_participants p ON p.round_id=r.id WHERE p.organization_id=? AND r.status IN ('prepared','registered','applying') LIMIT 1",access.organizationId))throw new ApiError(409,"Reconcile or revoke active business-clearing rounds before transferring the treasury owner","OWNER_TRANSFER_CLEARING_UNRESOLVED");
  const balance=await view<{in_flight:string}>(state.config,"get_balance");
  const active=row<{count:number}>("SELECT count(*) AS count FROM payout_attempts WHERE organization_id=? AND state IN ('prepared','submitted','processing','unknown','recovery_pending','reported_delivered','reported_partial')",access.organizationId)!.count;
  if(BigInt(balance.in_flight)>0n||active)throw new ApiError(409,"Resolve every active payout attempt and in-flight transfer before changing the treasury owner","OWNER_TRANSFER_ROUTES_UNRESOLVED");
  if(state.chain.retained_assets_enabled) {
    const assets=await view<Array<{in_flight:string}>>(state.config,"get_retained_assets");
    if(!Array.isArray(assets)||assets.some(asset=>typeof asset.in_flight!=="string"||!/^\d+$/.test(asset.in_flight)||BigInt(asset.in_flight)>0n))throw new ApiError(409,"Resolve every retained-asset withdrawal before transferring the treasury owner. Missing callbacks remain unresolved.","OWNER_TRANSFER_RETAINED_ASSETS_UNRESOLVED");
  }
}

export async function treasuryRecoveryStatus(access:AccessContext) {
  requirePermission(access,"company:manage");
  if(!row("SELECT organization_id FROM treasury_config WHERE organization_id=?",access.organizationId))return {configured:false as const};
  const state=await chainState(access);
  return {configured:true as const,treasuryAccount:state.config.near_account_id,network:state.config.network,chain:state.chain,codeHash:state.codeHash,companyOwner:!!row("SELECT id FROM organizations WHERE id=? AND owner_id=?",access.organizationId,access.userId),requests:rows<{id:string;kind:string;status:string;created_at:string;confirmed_at:string|null}>("SELECT id,kind,status,created_at,confirmed_at FROM treasury_recovery_requests WHERE organization_id=? ORDER BY created_at DESC LIMIT 20",access.organizationId)};
}

export async function prepareRecoveryPause(access:AccessContext) {
  companyOwner(access);const state=await chainState(access);
  await verifiedOwnerWallet(access.userId,state.chain.owner_id,state.config.network);
  transaction(db=>{db.prepare("UPDATE organizations SET paused=1,updated_at=? WHERE id=?").run(new Date().toISOString(),access.organizationId);db.prepare("UPDATE agent_mandates SET enabled=0,updated_at=? WHERE organization_id=?").run(new Date().toISOString(),access.organizationId);audit(access.userId,access.organizationId,"recovery.company_paused");});
  return {signerId:state.chain.owner_id,network:state.config.network,companyPaused:true,treasuryPaused:state.chain.paused,walletActions:state.chain.paused?[]:[action(state.config,"set_paused",{paused:true})]};
}

function retainRequest(access:AccessContext,terms:Terms) {
  const id=randomUUID(),termsHash=hash(terms),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+300000).toISOString();
  getDb().prepare("INSERT INTO treasury_recovery_requests (id,organization_id,requested_by,kind,terms_hash,terms_ciphertext,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)").run(id,access.organizationId,access.userId,terms.kind,termsHash,encrypt(JSON.stringify(terms)),createdAt,expiresAt);
  audit(access.userId,access.organizationId,"recovery.access_change_prepared",id,{kind:terms.kind});
  return {id,termsHash,terms,createdAt,expiresAt};
}

export async function prepareOwnershipTransfer(access:AccessContext,newOwnerWalletId:string) {
  companyOwner(access);const state=await chainState(access);
  await verifiedOwnerWallet(access.userId,state.chain.owner_id,state.config.network);
  const target=row<RecoveryWallet>("SELECT * FROM linked_wallets WHERE id=? AND user_id=? AND family='near' AND network=?",newOwnerWalletId,access.userId,state.config.network);
  if(!target||target.address===state.chain.owner_id||target.address===state.config.near_account_id)throw new ApiError(400,"Choose a different, freshly verified owner-controlled NEAR wallet on the same network","NEW_OWNER_REQUIRED");
  await verifiedOwnerWallet(access.userId,target.address,state.config.network);
  await requirePausedAndClear(access,state);assertTransferQuorum(state.chain,target.address);
  return retainRequest(access,{kind:"owner_transfer",treasuryAccount:state.config.near_account_id,network:state.config.network,tokenContract:state.config.token_contract,codeHash:state.codeHash,ownerAccount:state.chain.owner_id,newOwnerAccount:target.address,chainFingerprint:state.fingerprint,roles:{approvers:state.chain.approvers,executors:state.chain.executors,settlementReporter:state.chain.settlement_reporter},walletActions:[action(state.config,"transfer_ownership",{new_owner_id:target.address})]});
}

export async function prepareExecutorRevocation(access:AccessContext,executorAccount:string) {
  companyOwner(access);const state=await chainState(access);
  await verifiedOwnerWallet(access.userId,state.chain.owner_id,state.config.network);
  if(!state.chain.executors.includes(executorAccount))throw new ApiError(404,"This account is not a treasury executor","EXECUTOR_NOT_FOUND");
  getDb().prepare("UPDATE agent_mandates SET enabled=0,updated_at=? WHERE organization_id=? AND executor_account_id=?").run(new Date().toISOString(),access.organizationId,executorAccount);
  return retainRequest(access,{kind:"executor_revoke",treasuryAccount:state.config.near_account_id,network:state.config.network,tokenContract:state.config.token_contract,codeHash:state.codeHash,ownerAccount:state.chain.owner_id,executorAccount,chainFingerprint:state.fingerprint,roles:{approvers:state.chain.approvers,executors:state.chain.executors,settlementReporter:state.chain.settlement_reporter},walletActions:[action(state.config,"set_role",{account_id:executorAccount,role:"executor",enabled:false})]});
}

export async function prepareApprovalInvalidation(access:AccessContext) {
  companyOwner(access);const state=await chainState(access);
  await verifiedOwnerWallet(access.userId,state.chain.owner_id,state.config.network);
  if(!state.chain.paused)throw new ApiError(409,"Pause the treasury before invalidating collected approvals","TREASURY_PAUSE_REQUIRED");
  return retainRequest(access,{kind:"invalidate_approvals",treasuryAccount:state.config.near_account_id,network:state.config.network,tokenContract:state.config.token_contract,codeHash:state.codeHash,ownerAccount:state.chain.owner_id,previousPolicyVersion:state.chain.policy_version,chainFingerprint:state.fingerprint,roles:{approvers:state.chain.approvers,executors:state.chain.executors,settlementReporter:state.chain.settlement_reporter},walletActions:[action(state.config,"set_policy",{per_payment_limit:state.chain.per_payment_limit,daily_limit:state.chain.daily_limit})]});
}

function requestFor(access:AccessContext,id:string,termsHash:string) {
  companyOwner(access);
  const request=row<RequestRow>("SELECT * FROM treasury_recovery_requests WHERE id=? AND organization_id=?",id,access.organizationId);
  if(!request)throw new ApiError(404,"Recovery request not found","RECOVERY_REQUEST_NOT_FOUND");
  const terms=JSON.parse(decrypt(request.terms_ciphertext)) as Terms;
  if(request.terms_hash!==termsHash||hash(terms)!==termsHash)throw new ApiError(409,"The access-change review no longer matches this request","RECOVERY_TERMS_CHANGED");
  return {request,terms};
}

export function recoveryRequestReview(access:AccessContext,id:string) {
  companyOwner(access);
  const request=row<RequestRow>("SELECT * FROM treasury_recovery_requests WHERE id=? AND organization_id=?",id,access.organizationId);
  if(!request)throw new ApiError(404,"Recovery request not found","RECOVERY_REQUEST_NOT_FOUND");
  const {terms}=requestFor(access,id,request.terms_hash);
  return {id:request.id,termsHash:request.terms_hash,terms,expiresAt:request.expires_at,status:request.status,transactionHash:request.transaction_hash};
}

export async function authorizeRecoveryRequest(access:AccessContext,id:string,termsHash:string) {
  const {request,terms}=requestFor(access,id,termsHash);
  if(request.expires_at<=new Date().toISOString()||request.status!=="prepared")throw new ApiError(409,"This prepared change expired or was completed. Review a new request before signing.","RECOVERY_REQUEST_EXPIRED");
  const state=await chainState(access);
  await verifiedOwnerWallet(access.userId,terms.ownerAccount,terms.network);
  if(state.fingerprint!==terms.chainFingerprint||state.config.near_account_id!==terms.treasuryAccount||state.config.network!==terms.network)throw new ApiError(409,"Treasury access or policy changed since your review. Prepare a fresh access change.","RECOVERY_CHAIN_CHANGED");
  if(terms.kind==="owner_transfer") {await verifiedOwnerWallet(access.userId,terms.newOwnerAccount!,terms.network);await requirePausedAndClear(access,state);assertTransferQuorum(state.chain,terms.newOwnerAccount!);}
  return {signerId:terms.ownerAccount,network:terms.network,walletActions:terms.walletActions};
}

export async function reconcileRecoveryRequest(access:AccessContext,id:string,termsHash:string,transactionHash?:string) {
  const {request,terms}=requestFor(access,id,termsHash),state=await chainState(access);
  if(state.config.near_account_id!==terms.treasuryAccount||state.config.network!==terms.network||state.codeHash!==terms.codeHash)throw new ApiError(409,"The treasury code or network changed. Review its onchain state before confirming this request.","RECOVERY_CHAIN_CHANGED");
  const confirmed=terms.kind==="owner_transfer"?state.chain.owner_id===terms.newOwnerAccount:terms.kind==="executor_revoke"?!state.chain.executors.includes(terms.executorAccount!):state.chain.owner_id===terms.ownerAccount&&BigInt(state.chain.policy_version)>BigInt(terms.previousPolicyVersion!);
  if(confirmed)getDb().prepare("UPDATE treasury_recovery_requests SET status='confirmed',transaction_hash=COALESCE(?,transaction_hash),confirmed_at=? WHERE id=?").run(transactionHash || null,new Date().toISOString(),request.id);
  if(confirmed&&request.status!=="confirmed")audit(access.userId,access.organizationId,"recovery.access_change_confirmed",id,{kind:terms.kind});
  return {id,status:confirmed?"confirmed":"awaiting_chain_confirmation",chain:state.chain,transactionHash:transactionHash || request.transaction_hash};
}

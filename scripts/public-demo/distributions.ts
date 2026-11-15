import { ApiError, requirePermission, type AccessContext } from "../../src/server/context";
import { row } from "../../src/server/db";
import { decrypt } from "../../src/server/identity/crypto";
import { getRecipient } from "../../src/server/identity/recipients";
import type { Allocation, ChainDistribution, DistributionRow, Payload } from "../../src/server/distributions/model";
import { companies } from "../demo/seed";

export function demoPolicy(organizationId:string) {
  return {owner_id:Object.values(companies).find(company=>company.id===organizationId)?.account??"demo.near",paused:!!row<{paused:number}>("SELECT paused FROM organizations WHERE id=?",organizationId)?.paused,policy_version:"1",per_payment_limit:"1000000000000",daily_limit:"5000000000000",approvers:[],executors:[],approval_tiers:[{up_to:"5000000000000",required_approvals:1}],approval_amount_basis:"principal_plus_max_fee",settlement_reporter:null};
}
function distribution(id:string,organizationId:string){
  const value=row<DistributionRow>("SELECT * FROM claim_distributions WHERE id=? AND organization_id=?",id,organizationId);
  if(!value)throw new ApiError(404,"Demo distribution not found","DISTRIBUTION_NOT_FOUND");
  const {payload_ciphertext,plan_ciphertext,...safe}=value;
  return {value,safe,payload:JSON.parse(decrypt(payload_ciphertext)) as Payload};
}
function changed(organizationId:string,allocation:Allocation){
  const current=getRecipient(organizationId,allocation.recipientId);
  return current.archived||current.preference_status!=="confirmed"||current.version!==allocation.recipientVersion||current.user_id!==allocation.boundUserId||current.primary_address!==allocation.address;
}
export function inspectDemoDistribution(access:AccessContext,id:string,states:Record<string,ChainDistribution>){
  requirePermission(access,"payments:read");
  const {safe,payload}=distribution(id,access.organizationId),chain=states[id]??null,policy=demoPolicy(access.organizationId);
  const heldClaims=payload.items.filter(item=>changed(access.organizationId,item)).map(item=>item.claimId);
  const problems=[...(policy.paused?["Company payments are paused"]:[]),...(heldClaims.length?["A receiving profile changed. Its original allocation remains held."]:[]),...(Date.parse(payload.deadline)<=Date.now()?["The claim deadline passed"]:[])];
  return {...safe,payload,network:chain?.network??null,chain,policy:chain?policy:null,problems,heldClaims,storage:null,eligibleSigners:[],simulated:true};
}
export function inspectDemoClaim(userId:string,id:string,states:Record<string,ChainDistribution>){
  const own=row<{distribution_id:string;organization_id:string;payload_ciphertext:string;source_unknown:number;wallet_lease_expires_at:string|null}>("SELECT a.* FROM claim_distribution_allocations a JOIN claim_distributions d ON d.id=a.distribution_id WHERE a.id=? AND a.bound_user_id=? AND d.chain_status IS NOT NULL",id,userId);
  if(!own)throw new ApiError(404,"Claim entitlement not found","DISTRIBUTION_CLAIM_NOT_FOUND");
  const allocation=JSON.parse(decrypt(own.payload_ciphertext)) as Allocation,{payload}=distribution(own.distribution_id,own.organization_id),chain=states[own.distribution_id]??null,claim=chain?.claims.find(item=>item.allocation.claim_id===id)??null;
  const problems=[...(!chain||chain.status!=="active"?["The pool is not active"]:[]),...(demoPolicy(own.organization_id).paused?["Company payments are paused"]:[]),...(changed(own.organization_id,allocation)?["Your receiving profile changed. This allocation cannot redirect."]:[]),...(Date.parse(payload.deadline)<=Date.now()?["The claim deadline passed"]:[])];
  return {claim,amount:allocation.amount,address:allocation.address,network:chain?.network??null,deadline:payload.deadline,problems,eligibleSigners:[],sourceUnknown:!!own.source_unknown,walletLeaseExpiresAt:own.wallet_lease_expires_at,simulated:true};
}

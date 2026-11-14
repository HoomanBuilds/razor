import { rows } from "../db";
import { decrypt } from "../identity/crypto";
import { digest } from "../accounting/model";
import { valuedAsset, valuationInput } from "../accounting/ledger";
import { isCompanyBinding, validNearAccount } from "../payments/near";
import type { insightWindow } from "./model";

interface Fee {
  id:string;organization_id:string;network:"mainnet"|"testnet";transaction_hash:string;signer_account:string;
  reference_kind:"payment"|"funding";amount_atomic:string;asset:string;decimals:number;evidence_ciphertext:string;evidence_hash:string;created_at:string;
}
interface Member {batch_id:string;id:string;network:string;transaction_hash:string;amount_atomic:string;evidence_hash:string;created_at:string}
interface ApprovedJob {
  id:string;source_id:string;source_hash:string;entity_id:string;connection_version:number;mapping_version:number;review_hash:string;
  payload_ciphertext:string;mapping_ciphertext:string|null;batch_network:string;batch_amount:string;batch_hash:string;approved_at:string;state:string;
}
interface ValidValuation {batchId:string;signature:string;currency:string;cents:bigint;microUSDC:bigint|null;atomic:bigint;transactions:number;rounding:"exact"|"half_even_to_cent";nativeRateDate:string;mappingRateDate:string;posted:boolean}
const integer=(value:unknown,positive=false,maxDigits=39):value is string=>typeof value==="string"&&value.length<=maxDigits&&/^(0|[1-9]\d*)$/.test(value)&&(!positive||BigInt(value)>0n);
const date=(value:unknown):value is string=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
const maximum=(1n<<128n)-1n;

function validFee(value:Fee,organizationId:string) {
  if(value.organization_id!==organizationId||!["mainnet","testnet"].includes(value.network)||value.asset!=="NEAR"||value.decimals!==24||!validNearAccount(value.signer_account)||!integer(value.amount_atomic,true)||BigInt(value.amount_atomic)>maximum)return false;
  try {
    const text=decrypt(value.evidence_ciphertext);
    if(text.length>1_000_000)return false;
    const proof=JSON.parse(text) as {network?:unknown;transactionHash?:unknown;signer?:unknown;companyId?:unknown;companyTreasury?:unknown;amountAtomic?:unknown;asset?:unknown;decimals?:unknown;outcomes?:Array<{id?:unknown;blockHash?:unknown;tokensBurnt?:unknown}>};
    if(digest(proof)!==value.evidence_hash||proof.network!==value.network||proof.transactionHash!==value.transaction_hash||proof.signer!==value.signer_account||proof.amountAtomic!==value.amount_atomic||proof.asset!=="NEAR"||proof.decimals!==24||typeof proof.companyTreasury!=="string"||!validNearAccount(proof.companyTreasury)||proof.companyId!=null&&(typeof proof.companyId!=="string"||!isCompanyBinding(organizationId,proof.companyId))||!Array.isArray(proof.outcomes)||proof.outcomes.length<2||proof.outcomes.length>500)return false;
    const ids=new Set<string>();let total=0n;
    for(const outcome of proof.outcomes) {
      if(typeof outcome.id!=="string"||!outcome.id||outcome.id.length>128||ids.has(outcome.id)||typeof outcome.blockHash!=="string"||!outcome.blockHash||outcome.blockHash.length>128||!integer(outcome.tokensBurnt)||BigInt(outcome.tokensBurnt)>maximum)return false;
      ids.add(outcome.id);total+=BigInt(outcome.tokensBurnt);
    }
    return total===BigInt(value.amount_atomic);
  }catch{return false;}
}

function valuation(job:ApprovedJob,members:Member[],fees:Map<string,Fee>,observedAt:string):ValidValuation|null {
  try {
    if(!job.mapping_ciphertext)return null;
    const posting=JSON.parse(decrypt(job.payload_ciphertext)) as Record<string,unknown>;
    if(digest({jobId:job.id,connectionVersion:job.connection_version,entity:job.entity_id,mappingVersion:job.mapping_version,posting})!==job.review_hash)return null;
    const source=posting.source as Record<string,unknown>,amount=posting.amount as Record<string,unknown>,currency=posting.functionalCurrency;
    if(!source||source.kind!=="fee"||source.sourceId!==job.source_id||source.hash!==job.source_hash||source.asset!=="NEAR"||source.decimals!==24||source.amount!==job.batch_amount||job.batch_network!=="mainnet"||typeof currency!=="string"||!/^[A-Z]{3,6}$/.test(currency)||!integer(job.batch_amount,true)||!members.length||members.length>100)return null;
    const observed=members.map(member=>fees.get(member.id));
    if(observed.some(value=>!value)||members.some((member,index)=>member.network!==job.batch_network||member.amount_atomic!==observed[index]!.amount_atomic||member.evidence_hash!==observed[index]!.evidence_hash||member.transaction_hash!==observed[index]!.transaction_hash)||new Set(members.map(member=>member.id)).size!==members.length)return null;
    const atomic=members.reduce((sum,member)=>sum+BigInt(member.amount_atomic),0n);
    if(atomic.toString()!==job.batch_amount)return null;
    const {hash:_hash,...sourceFields}=source;
    if(digest({source:sourceFields,batchHash:job.batch_hash,fees:members.map(member=>({transaction_hash:member.transaction_hash,evidence_hash:member.evidence_hash}))})!==job.source_hash)return null;
    const rate=valuationInput.parse(posting.nativeFeeValuation),mapping=JSON.parse(decrypt(job.mapping_ciphertext)) as {functionalCurrency?:unknown;fxNumerator?:unknown;fxDenominator?:unknown;fxDate?:unknown};
    if(mapping.functionalCurrency!==currency||!integer(mapping.fxNumerator,true,18)||!integer(mapping.fxDenominator,true,18)||!date(mapping.fxDate)||rate.date>observedAt.slice(0,10)||mapping.fxDate>observedAt.slice(0,10))return null;
    const rounded=valuedAsset(job.batch_amount,24,rate);
    if(!amount||amount.cents!==rounded.cents||amount.text!==rounded.text||amount.residualNumerator!==rounded.residualNumerator||amount.residualDenominator!==rounded.residualDenominator)return null;
    const cents=BigInt(rounded.cents),numerator=cents*BigInt(mapping.fxDenominator)*10_000n,denominator=BigInt(mapping.fxNumerator);
    const microUSDC=numerator%denominator===0n?numerator/denominator:null;
    return {batchId:job.source_id,signature:digest({currency,cents:rounded.cents,rate,mappingNumerator:mapping.fxNumerator,mappingDenominator:mapping.fxDenominator,mappingDate:mapping.fxDate}),currency,cents,microUSDC,atomic,transactions:members.length,rounding:rate.rounding,nativeRateDate:rate.date,mappingRateDate:mapping.fxDate,posted:job.state==="done"};
  }catch{return null;}
}

export function observedCompanyCosts(organizationId:string,window:ReturnType<typeof insightWindow>) {
  const feeLimit=1000,jobLimit=1000,memberLimit=10000,truncated:string[]=[];
  const selected=rows<Fee>("SELECT * FROM accounting_fee_evidence WHERE organization_id=? AND created_at>=? AND created_at<? ORDER BY created_at,id LIMIT ?",organizationId,window.start,window.endExclusive,feeLimit+1);
  if(selected.length>feeLimit)truncated.push("fee_observations");
  const fees=new Map<string,Fee>(),identities=new Map<string,Fee>(),conflicts=new Set<string>();let invalid=0,duplicate=0;
  for(const fee of selected.slice(0,feeLimit)) {
    if(!validFee(fee,organizationId)){invalid++;continue;}
    const key=`${fee.network}:${fee.transaction_hash}`,previous=identities.get(key);
    if(conflicts.has(key)){invalid++;continue;}
    if(previous) {
      if(previous.signer_account===fee.signer_account&&previous.amount_atomic===fee.amount_atomic&&previous.evidence_hash===fee.evidence_hash){duplicate++;continue;}
      identities.delete(key);fees.delete(previous.id);conflicts.add(key);invalid+=2;continue;
    }
    identities.set(key,fee);fees.set(fee.id,fee);
  }
  const networks=(["mainnet","testnet"] as const).map(network=>{
    const values=[...fees.values()].filter(fee=>fee.network===network);
    return {network,asset:"NEAR" as const,decimals:24,transactions:values.length,feePayers:new Set(values.map(value=>value.signer_account)).size,actualBurnAtomic:values.length?values.reduce((sum,value)=>sum+BigInt(value.amount_atomic),0n).toString():null,paymentReferences:values.filter(value=>value.reference_kind==="payment").length,fundingReferences:values.filter(value=>value.reference_kind==="funding").length};
  });
  const jobs=rows<ApprovedJob>(`SELECT j.id,j.source_id,j.source_hash,j.entity_id,j.connection_version,j.mapping_version,j.review_hash,j.payload_ciphertext,j.approved_at,j.state,
    m.payload_ciphertext AS mapping_ciphertext,b.network AS batch_network,b.amount_atomic AS batch_amount,b.source_hash AS batch_hash
    FROM accounting_jobs j JOIN accounting_fee_batches b ON b.id=j.source_id AND b.organization_id=j.organization_id AND b.state='grouped'
    LEFT JOIN accounting_mappings m ON m.connection_id=j.connection_id AND m.entity_id=j.entity_id AND m.version=j.mapping_version
    JOIN accounting_connections c ON c.id=j.connection_id AND c.organization_id=j.organization_id
    WHERE j.organization_id=? AND j.kind='fee' AND j.approved_by IS NOT NULL AND j.approved_at IS NOT NULL AND j.state NOT IN ('review','cancelled')
    AND EXISTS(SELECT 1 FROM accounting_fee_batch_items i JOIN accounting_fee_evidence f ON f.id=i.fee_id WHERE i.batch_id=b.id AND f.organization_id=? AND f.created_at>=? AND f.created_at<?)
    ORDER BY j.approved_at,j.id LIMIT ?`,organizationId,organizationId,window.start,window.endExclusive,jobLimit+1);
  if(jobs.length>jobLimit)truncated.push("approved_fee_valuations");
  const memberRows=rows<Member>(`SELECT i.batch_id,f.id,f.network,f.transaction_hash,f.amount_atomic,f.evidence_hash,f.created_at
    FROM accounting_fee_batch_items i JOIN accounting_fee_evidence f ON f.id=i.fee_id JOIN accounting_fee_batches b ON b.id=i.batch_id AND b.organization_id=f.organization_id
    WHERE b.organization_id=? AND b.state='grouped' AND EXISTS(SELECT 1 FROM accounting_jobs j WHERE j.organization_id=b.organization_id AND j.source_id=b.id AND j.kind='fee' AND j.approved_by IS NOT NULL AND j.approved_at IS NOT NULL AND j.state NOT IN ('review','cancelled'))
    AND EXISTS(SELECT 1 FROM accounting_fee_batch_items active JOIN accounting_fee_evidence observed ON observed.id=active.fee_id WHERE active.batch_id=b.id AND observed.organization_id=? AND observed.created_at>=? AND observed.created_at<?)
    ORDER BY i.batch_id,f.id LIMIT ?`,organizationId,organizationId,window.start,window.endExclusive,memberLimit+1);
  if(memberRows.length>memberLimit)truncated.push("fee_group_memberships");
  const members=new Map<string,Member[]>();
  for(const member of memberRows.slice(0,memberLimit)){const values=members.get(member.batch_id)||[];values.push(member);members.set(member.batch_id,values);}
  const candidates=new Map<string,ApprovedJob[]>();
  for(const job of jobs.slice(0,jobLimit)){const values=candidates.get(job.source_id)||[];values.push(job);candidates.set(job.source_id,values);}
  let invalidValuations=0,boundaryGroups=0,conflictingGroups=0,precisionHeld=0,valuedTransactions=0,postedGroups=0,halfEvenGroups=0,exactGroups=0,estimatedMicro=0n,valuedAtomic=0n;
  const currencies=new Map<string,{currency:string;approvedGroups:number;postedGroups:number;functionalCents:bigint;nativeBurnAtomic:bigint}>(),rateDates=new Set<string>();
  const valuationInspectionComplete=jobs.length<=jobLimit&&memberRows.length<=memberLimit;
  for(const [batchId,views] of candidates) {
    if(!valuationInspectionComplete)break;
    const group=members.get(batchId)||[];
    if(group.some(member=>member.created_at<window.start||member.created_at>=window.endExclusive)){boundaryGroups++;continue;}
    const approved=views.map(job=>valuation(job,group,fees,window.observedAt));
    if(approved.some(value=>!value)){invalidValuations++;continue;}
    const valid=approved as ValidValuation[];
    if(new Set(valid.map(value=>value.signature)).size!==1){conflictingGroups++;continue;}
    const value=valid[0],posted=valid.some(item=>item.posted),currency=currencies.get(value.currency)||{currency:value.currency,approvedGroups:0,postedGroups:0,functionalCents:0n,nativeBurnAtomic:0n};
    currency.approvedGroups++;currency.postedGroups+=Number(posted);currency.functionalCents+=value.cents;currency.nativeBurnAtomic+=value.atomic;currencies.set(value.currency,currency);
    if(value.microUSDC===null){precisionHeld++;continue;}
    estimatedMicro+=value.microUSDC;valuedAtomic+=value.atomic;valuedTransactions+=value.transactions;postedGroups+=Number(posted);
    if(value.rounding==="half_even_to_cent")halfEvenGroups++;else exactGroups++;
    rateDates.add(value.nativeRateDate);rateDates.add(value.mappingRateDate);
  }
  return {
    scope:"Fee evidence first recorded in this inclusive UTC observation window, regardless of transaction date or the original payment creation date. Latest saved approvals are observed now. This is a separate cohort and is never added automatically to route-cohort costs or the comparison calculator.",
    observationBasis:"accounting_fee_evidence.created_at" as const,networks,
    coverage:{includedRecords:Math.min(selected.length,feeLimit),verifiedUniqueTransactions:fees.size,invalidOrConflictingRecords:invalid,duplicateRecordsExcluded:duplicate,truncated,complete:truncated.length===0&&invalid===0,feeLimit,jobLimit,memberLimit},
    valuation:{basis:"Approved native fee valuation plus that job's immutable functional-currency/USDC mapping. Functional cents retain the accountant-approved exact or half-even policy. Inverse FX is included only when exact to microUSDC, with no extra rounding or USD/USDC parity assumption.",
      estimatedMicroUSDC:valuedTransactions?estimatedMicro.toString():null,nativeBurnCoveredAtomic:valuedAtomic.toString(),network:"mainnet" as const,transactionsCovered:valuedTransactions,unvaluedMainnetTransactions:networks[0].transactions-valuedTransactions,approvedGroups:exactGroups+halfEvenGroups,postedGroups,exactGroups,halfEvenToCentGroups:halfEvenGroups,precisionHeldGroups:precisionHeld,conflictingGroups,boundaryGroups,invalidGroups:invalidValuations,inspectionComplete:valuationInspectionComplete,rateDates:[...rateDates].sort(),
      functionalCurrencies:[...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(value=>({...value,functionalCents:value.functionalCents.toString(),nativeBurnAtomic:value.nativeBurnAtomic.toString()})),
      estimated:true,actualUSDCSpend:null},
    unknown:{unobservedNearTransactions:null,otherSourceChainGas:null,destinationChainFees:null,storageLocks:null,attachedDeposits:null,fundingConversionFees:null,totalAllInCost:null},
    limits:"Only existing company-attributed final receipt-bound NEAR burn evidence is included. A zero observation count means no measured sample, not free transactions. Deposits and locked storage are assets or commitments, not token burn. Approved valuations are accounting estimates, not observed USDC fees or verified savings. Third-party payer, relayer, solver and unsupported-chain costs are not inferred.",
  };
}

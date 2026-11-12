import { z } from "zod";
import { ApiError } from "../../context";
import { parseUnits } from "../../../lib/money";
import { sha256 } from "../verification";

export const planningInput=z.object({instruction:z.string().trim().min(1).max(2000),recipientIds:z.array(z.string().min(1).max(100)).min(1).max(100),periodStart:z.string().date(),periodEnd:z.string().date(),reference:z.string().trim().min(1).max(120),maxTotal:z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/),maxFeePerPayment:z.string().trim().regex(/^(0|[1-9]\d{0,23})(?:\.\d{1,6})?$/).default("0")}).superRefine((input,ctx)=>{
  if(input.periodEnd<input.periodStart)ctx.addIssue({code:"custom",message:"Pay period ends before it starts",path:["periodEnd"]});
  if(new Set(input.recipientIds).size!==input.recipientIds.length)ctx.addIssue({code:"custom",message:"Choose each recipient once",path:["recipientIds"]});
  try{if(BigInt(parseUnits(input.maxTotal,6))===0n)throw new Error();}catch{ctx.addIssue({code:"custom",message:"Enter a positive USDC payroll cap",path:["maxTotal"]});}
  if(/[^\s@]+@[^\s@]+\.[^\s@]+|0x[a-f\d]{40}\b|\b[a-z\d._-]+\.(?:near|testnet)\b|https?:\/\/|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/i.test(input.instruction))ctx.addIssue({code:"custom",message:"Use the displayed opaque recipient labels, without emails, wallet addresses or links",path:["instruction"]});
});
export type PlanningInput=z.infer<typeof planningInput>;
export interface SelectedRecipient {recipientId:string;opaqueId:string;version:number;capMicroUSDC:string;priorAmountMicroUSDC:string|null}
export interface PlanSource {reference:string;periodStart:string;periodEnd:string;maxTotal:string;maxFeePerPayment:string;selected:SelectedRecipient[]}
export function financeSourceFingerprint(source:PlanSource):string {
  return sha256(JSON.stringify({reference:source.reference,periodStart:source.periodStart,periodEnd:source.periodEnd,maxTotal:source.maxTotal,maxFeePerPayment:source.maxFeePerPayment,selected:source.selected.map(({recipientId,opaqueId,version,capMicroUSDC})=>({recipientId,opaqueId,version,capMicroUSDC}))}));
}
const ModelPlan=z.object({allocations:z.array(z.object({recipientId:z.string().max(100),amount:z.string().regex(/^[1-9]\d{0,30}$/)}).strict()).min(1).max(100),explanation:z.string().trim().min(1).max(2000),warnings:z.array(z.string().max(500)).max(20)}).strict();

export function validateModelPlan(raw:unknown,source:PlanSource) {
  let parsed:z.infer<typeof ModelPlan>;
  try{parsed=ModelPlan.parse(typeof raw==="string"?JSON.parse(raw):raw);}catch{throw new ApiError(502,"The private model returned an invalid proposal. No payroll draft was created.","FINANCE_PLAN_INVALID");}
  const seen=new Set<string>();
  const allocations=parsed.allocations.map(item=>{
    const selected=source.selected.find(value=>value.opaqueId===item.recipientId);
    if(!selected||seen.has(item.recipientId))throw new ApiError(502,"The proposal changed the recipient allowlist. No draft was accepted.","FINANCE_RECIPIENT_VIOLATION");
    seen.add(item.recipientId);
    if(BigInt(item.amount)>BigInt(selected.capMicroUSDC))throw new ApiError(502,"The proposal exceeded a recipient's allocation cap","FINANCE_CAP_EXCEEDED");
    return {recipientId:selected.recipientId,opaqueId:selected.opaqueId,version:selected.version,amount:item.amount};
  });
  if(seen.size!==source.selected.length)throw new ApiError(502,"The proposal omitted a selected recipient. Review a complete new proposal.","FINANCE_RECIPIENT_VIOLATION");
  const total=allocations.reduce((sum,item)=>sum+BigInt(item.amount),0n);
  if(total>BigInt(source.maxTotal))throw new ApiError(502,"The proposal exceeded the human-defined total cap","FINANCE_CAP_EXCEEDED");
  return {...parsed,allocations,total:total.toString()};
}

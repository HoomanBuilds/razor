import { createHash } from "node:crypto";
import { z } from "zod";
import { HELP_CATEGORIES } from "../../lib/help/guides";
import { ApiError } from "../context";

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const body=z.string().trim().min(10).max(4000).refine(value=>Buffer.byteLength(value)<=16000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),"Use plain text up to 4,000 characters without control codes").refine(value=>!/-----BEGIN[^\n]*PRIVATE KEY-----|(?:seed phrase|recovery phrase|mnemonic)\s*:/i.test(value),"Do not include private keys or recovery phrases");
export const contextInput=z.object({organizationId:id.optional(),paymentId:id.optional(),fundingId:id.optional()}).strict();
export const caseInput=z.object({idempotencyKey:z.string().uuid(),subject:z.string().trim().min(5).max(120).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),category:z.enum(HELP_CATEGORIES),message:body,context:contextInput.default({}),privacyAcknowledged:z.literal(true)}).strict();
export const replyInput=z.object({idempotencyKey:z.string().uuid(),message:body}).strict();
export const statusInput=z.object({idempotencyKey:z.string().uuid(),expectedVersion:z.number().int().positive(),status:z.enum(["open","waiting_for_sender","waiting_for_operator","resolved","closed"])}).strict();
export const deleteInput=z.object({idempotencyKey:z.string().uuid(),expectedVersion:z.number().int().positive()}).strict();
export const historyInput=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),organizationId:id.optional()}).strict();
export const threadInput=z.object({messagePage:z.coerce.number().int().min(1).max(100000).default(1),historyPage:z.coerce.number().int().min(1).max(100000).default(1)}).strict();
export type SupportContext=z.infer<typeof contextInput>;
export interface CaseRecord {id:string;sender_user_id:string;organization_id:string|null;category:string;subject_ciphertext:string|null;context_ciphertext:string|null;status:string;version:number;idempotency_hash:string;request_hash:string;created_at:string;updated_at:string;expires_at:string}
export const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function retentionDays() {const raw=process.env.RAZOR_SUPPORT_RETENTION_DAYS??"90";if(!/^\d+$/.test(raw)||Number(raw)<7||Number(raw)>365)throw new ApiError(503,"The operator must choose support retention from 7 to 365 days","SUPPORT_SETUP_REQUIRED");return Number(raw);}
export const SUPPORT_PAGE_SIZE=25;

export const escalationInput = z
  .object({
    idempotencyKey: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    reason: z.enum([
      "transfer_outcome_unknown",
      "delivery_missing",
      "funding_credit_missing",
      "refund_recovery_held",
    ]),
    noRetryAcknowledged: z.literal(true),
  })
  .strict();
export const escalationActionInput = z
  .object({
    idempotencyKey: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    action: z.enum(["acknowledge", "resolve", "take_over"]),
  })
  .strict();

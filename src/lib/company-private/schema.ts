import { z } from "zod";
import { extractedInvoiceSchema } from "../../server/assistant/extraction";

export const COMPANY_REVIEW_MAX_BYTES = 256 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const companyReviewSchema = z.object({
  schema: z.literal("razor.company-private.invoice"),
  version: z.literal(1),
  processedAt: z.string().datetime(),
  source: z.object({ sha256: hash, kind: z.enum(["text", "pdf", "png", "jpeg"]), bytes: z.number().int().min(1).max(3 * 1024 * 1024) }).strict(),
  draft: extractedInvoiceSchema,
  processing: z.object({
    mode: z.literal("company_operated"), provider: z.literal("NEAR AI Cloud"), model: z.string().min(1).max(240),
    reportedVerifiedAt: z.string().datetime(), reportedGatewayComposeSha256: hash,
    reportedModelComposeSha256: z.array(hash).min(1).max(16),
    reportedRequestWireHash: hash.nullable(), reportedResponseWireHash: hash.nullable(),
  }).strict(),
}).strict();

export type CompanyReview = z.infer<typeof companyReviewSchema>;

export function parseCompanyReview(text: string): CompanyReview {
  if (new TextEncoder().encode(text).byteLength > COMPANY_REVIEW_MAX_BYTES) throw new Error("Choose a company review file no larger than 256 KB");
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error("Choose a valid company-operated review JSON file"); }
  const result = companyReviewSchema.safeParse(input);
  if (!result.success) throw new Error("This company review file has an unsupported format or invalid fields");
  return result.data;
}

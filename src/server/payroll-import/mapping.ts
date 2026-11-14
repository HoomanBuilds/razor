import { z } from "zod";
import { importFields, type ImportSettings } from "../../lib/payroll-import";
import { runVerifiedPrivateInference } from "../assistant/client";
import { requirePrivateAiConfig } from "../assistant/config";
import { completeAiUsage, reserveAiUsage } from "../billing/usage";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getAccess } from "../identity/session";

export const mappingRequestSchema = z.object({
  headers: z.array(z.string().min(1).max(200)).min(1).max(64).refine(headers => new Set(headers).size === headers.length, "Column headers must be unique"),
  requestKey: z.string().min(8).max(120),
}).strict();
const outputSchema = z.object({
  mappings: z.array(z.object({ field: z.enum(importFields), columnId: z.string().regex(/^c\d{1,2}$/), confidence: z.number().min(0).max(1) }).strict()).max(importFields.length),
  warnings: z.array(z.string().max(200)).max(10),
}).strict();
const active = new Set<string>();
type InferenceResult = Pick<Awaited<ReturnType<typeof runVerifiedPrivateInference>>, "content" | "verification">;
type MappingInference = (text: string) => Promise<InferenceResult>;

function currentAccess(access: AccessContext) {
  const live = getAccess(access.userId, access.organizationId);
  for (const permission of ["company:read", "payments:prepare", "payments:read", "documents:manage"]) requirePermission(live, permission);
  return live;
}

export function parseMappingSuggestion(content: string, headers: string[]) {
  if (content.length > 20_000) throw new ApiError(502, "The private column suggestion exceeded its limit. Map columns manually", "IMPORT_SUGGESTION_INVALID");
  let input: unknown;
  try { input = JSON.parse(content); } catch { throw new ApiError(502, "The private column suggestion was invalid. Map columns manually", "IMPORT_SUGGESTION_INVALID"); }
  const parsed = outputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(502, "The private column suggestion contained unsupported fields. Map columns manually", "IMPORT_SUGGESTION_INVALID");
  const mapping: ImportSettings["mapping"] = {}, confidence: Partial<Record<typeof importFields[number], number>> = {}, columns = new Set<string>();
  for (const item of parsed.data.mappings) {
    const index = Number(item.columnId.slice(1)), column = headers[index];
    if (column === undefined || item.columnId !== `c${index}` || mapping[item.field] || columns.has(column)) throw new ApiError(502, "The private column suggestion invented or reused a column. Map columns manually", "IMPORT_SUGGESTION_INVALID");
    mapping[item.field] = column; confidence[item.field] = item.confidence; columns.add(column);
  }
  return { mapping, confidence, warnings: parsed.data.warnings, requiresReview: true as const };
}

export async function suggestImportMapping(access: AccessContext, input: unknown, infer: MappingInference = text => runVerifiedPrivateInference("payroll_mapping", text)) {
  const live = currentAccess(access), parsed = mappingRequestSchema.parse(input);
  try { requirePrivateAiConfig(); }
  catch { throw new ApiError(503, "Private column suggestions are unavailable. Map columns manually or use Match familiar headers", "PRIVATE_AI_SETUP_REQUIRED"); }
  if (active.has(live.organizationId)) throw new ApiError(429, "A private column suggestion is already running for this company. Wait or map manually", "IMPORT_SUGGESTION_BUSY");
  const usage = reserveAiUsage(live, `payroll-columns:${parsed.requestKey}`);
  active.add(live.organizationId);
  try {
    const result = await infer(JSON.stringify({ columns: parsed.headers.map((header, index) => ({ columnId: `c${index}`, header })) }));
    currentAccess(live);
    const suggestion = parseMappingSuggestion(result.content, parsed.headers);
    completeAiUsage(usage.id, "completed");
    return { ...suggestion, verification: result.verification, retained: false as const };
  } catch (error) {
    completeAiUsage(usage.id, "failed");
    throw error;
  } finally { active.delete(live.organizationId); }
}

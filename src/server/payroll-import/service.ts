import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { parseUnits } from "../../lib/money";
import { importFields, previewPayrollImport, validateImportSettings, type ImportField, type ImportSettings, type PayrollImportPreview } from "../../lib/payroll-import";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { encrypt, decrypt } from "../identity/crypto";
import { listRecipients } from "../identity/recipients";
import { createPayrollRun, getPayrollRun } from "../business/service";

const fieldShape = Object.fromEntries(importFields.map(field => [field, z.string().max(2000).optional()])) as Record<ImportField, z.ZodOptional<z.ZodString>>;
const mappingShape = Object.fromEntries(importFields.map(field => [field, z.string().max(200).optional()])) as Record<ImportField, z.ZodOptional<z.ZodString>>;
export const importSettingsSchema = z.object({ delimiter: z.enum([",", ";", "\t", "|"]), decimal: z.enum([".", ","]), thousands: z.enum(["", ",", ".", " ", "'"]), defaultCurrency: z.literal("USDC"), defaultMaxFee: z.string().min(1).max(100), mapping: z.object(mappingShape).strict() }).strict();
const resolutionsSchema = z.record(z.string().regex(/^\d{1,4}$/), z.string().min(1).max(120));
const correctionsSchema = z.record(z.string().regex(/^\d{1,4}$/), z.object(fieldShape).strict());
const payloadSchema = z.object({ source: z.string().min(1).max(500_000), filename: z.string().trim().min(1).max(200), settings: importSettingsSchema, resolutions: resolutionsSchema.default({}), corrections: correctionsSchema.default({}) }).strict();
export const createImportSchema = payloadSchema.extend({ requestKey: z.string().min(8).max(120) });
export const updateImportSchema = payloadSchema.extend({ expectedVersion: z.number().int().positive() });
export const templateSchema = z.object({ name: z.string().trim().min(1).max(120), headers: z.array(z.string().min(1).max(200)).min(1).max(64), settings: importSettingsSchema }).strict();
export const commitImportSchema = z.object({ expectedVersion: z.number().int().positive(), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), reference: z.string().trim().min(1).max(120), periodStart: z.string().date(), periodEnd: z.string().date(), scheduledFor: z.string().datetime().optional(), confirmed: z.literal(true) }).strict();
type Payload = z.infer<typeof payloadSchema>;
interface StoredDraft { id: string; organization_id: string; request_hash: string; payload_ciphertext: string; version: number; run_id: string | null; commit_ciphertext: string | null; created_at: string; updated_at: string; expires_at: string }
interface StoredTemplate { id: string; name_ciphertext: string; version: number; settings_ciphertext: string; headers_ciphertext: string; archived_at: string | null; created_at: string; updated_at: string }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function authorize(access: AccessContext) { requirePermission(access, "payments:prepare"); requirePermission(access, "payments:read"); }
export function purgeExpiredPayrollImports() { getDb().prepare("UPDATE payroll_import_drafts SET payload_ciphertext='' WHERE expires_at<=? AND payload_ciphertext<>''").run(new Date().toISOString()); }
function findDraft(access: AccessContext, id: string) {
  authorize(access); purgeExpiredPayrollImports();
  const draft = row<StoredDraft>("SELECT * FROM payroll_import_drafts WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!draft) throw new ApiError(404, "Payroll import not found", "IMPORT_NOT_FOUND");
  return draft;
}
function payloadOf(draft: StoredDraft): Payload {
  if (!draft.payload_ciphertext || draft.expires_at <= new Date().toISOString()) throw new ApiError(410, "This import's source retention expired. Upload the source again; existing pay runs are preserved.", "IMPORT_EXPIRED");
  return payloadSchema.parse(JSON.parse(decrypt(draft.payload_ciphertext)));
}
function preview(access: AccessContext, payload: Payload): PayrollImportPreview {
  try {
    const result = previewPayrollImport(payload.source, payload.settings as ImportSettings, listRecipients(access.organizationId), payload.resolutions, payload.corrections);
    for (const key of [...Object.keys(payload.resolutions), ...Object.keys(payload.corrections)]) if (!result.rows.some(item => String(item.rowNumber) === key)) throw new Error("A row correction or selected payee no longer belongs to this source. Review the file again.");
    return result;
  } catch (error) { throw new ApiError(422, error instanceof Error ? error.message : "Review the import format", "IMPORT_INVALID"); }
}
function serializeDraft(access: AccessContext, draft: StoredDraft) {
  const payload = payloadOf(draft), result = preview(access, payload);
  return { id: draft.id, version: draft.version, runId: draft.run_id, createdAt: draft.created_at, updatedAt: draft.updated_at, expiresAt: draft.expires_at, ...payload, preview: result, reviewToken: digest({ organization: access.organizationId, draft: draft.id, version: draft.version, payload, preview: result }) };
}

export function listImportDrafts(access: AccessContext) {
  authorize(access); purgeExpiredPayrollImports();
  return rows<StoredDraft>("SELECT * FROM payroll_import_drafts WHERE organization_id=? ORDER BY updated_at DESC LIMIT 30", access.organizationId).map(draft => ({ id: draft.id, filename: draft.payload_ciphertext ? payloadOf(draft).filename : "Source retention expired", version: draft.version, runId: draft.run_id, expired: !draft.payload_ciphertext, updatedAt: draft.updated_at, expiresAt: draft.expires_at }));
}
export function getImportDraft(access: AccessContext, id: string) { return serializeDraft(access, findDraft(access, id)); }
export function createImportDraft(access: AccessContext, input: z.infer<typeof createImportSchema>) {
  authorize(access);
  const { requestKey, ...payload } = createImportSchema.parse(input);
  const requestHash = digest(payload);
  return transaction(() => {
    const previous = row<StoredDraft>("SELECT * FROM payroll_import_drafts WHERE organization_id=? AND request_key=?", access.organizationId, requestKey);
    if (previous) {
      if (previous.request_hash !== requestHash) throw new ApiError(409, "This upload key already has different source terms. Start a new upload.", "IMPORT_KEY_CONFLICT");
      return serializeDraft(access, previous);
    }
    preview(access, payload);
    const id = randomUUID(), now = new Date(), expires = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    getDb().prepare("INSERT INTO payroll_import_drafts(id,organization_id,request_key,request_hash,payload_ciphertext,created_by,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, access.organizationId, requestKey, requestHash, encrypt(JSON.stringify(payload)), access.userId, now.toISOString(), now.toISOString(), expires);
    return getImportDraft(access, id);
  });
}
export function updateImportDraft(access: AccessContext, id: string, input: z.infer<typeof updateImportSchema>) {
  const { expectedVersion, ...payload } = updateImportSchema.parse(input);
  return transaction(() => {
    const draft = findDraft(access, id);
    if (draft.run_id) throw new ApiError(409, "This import already created its pay run. Review that run instead.", "IMPORT_COMMITTED");
    payloadOf(draft);
    if (draft.version !== expectedVersion) throw new ApiError(409, "This import changed. Reload before saving corrections.", "IMPORT_VERSION_CHANGED");
    preview(access, payload);
    getDb().prepare("UPDATE payroll_import_drafts SET payload_ciphertext=?,version=version+1,updated_at=? WHERE id=? AND organization_id=? AND version=?").run(encrypt(JSON.stringify(payload)), new Date().toISOString(), id, access.organizationId, expectedVersion);
    return getImportDraft(access, id);
  });
}
export function deleteImportDraft(access: AccessContext, id: string) {
  const draft = findDraft(access, id);
  if (draft.run_id) getDb().prepare("UPDATE payroll_import_drafts SET payload_ciphertext='',expires_at=? WHERE id=? AND organization_id=?").run(new Date().toISOString(), id, access.organizationId);
  else getDb().prepare("DELETE FROM payroll_import_drafts WHERE id=? AND organization_id=?").run(id, access.organizationId);
  return { deleted: true, runId: draft.run_id };
}

export function commitImportDraft(access: AccessContext, id: string, input: z.infer<typeof commitImportSchema>) {
  const terms = commitImportSchema.parse(input);
  return transaction(() => {
    const draft = findDraft(access, id);
    if (draft.run_id) {
      if (draft.commit_ciphertext && digest(JSON.parse(decrypt(draft.commit_ciphertext))) === digest(terms)) return { run: getPayrollRun(access, draft.run_id), reused: true };
      throw new ApiError(409, "This import already created a pay run with different terms. Open that run.", "IMPORT_COMMITTED");
    }
    const current = serializeDraft(access, draft);
    if (draft.version !== terms.expectedVersion || current.reviewToken !== terms.reviewToken) throw new ApiError(409, "The source, mapping or payees changed. Review the current preview before creating payroll.", "IMPORT_REVIEW_CHANGED");
    if (!current.preview.canCommit) throw new ApiError(422, "Resolve every import error before creating payroll", "IMPORT_ROWS_UNRESOLVED");
    const items = current.preview.rows.map(item => {
      const previous = row<{ id: string }>("SELECT i.id FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE r.organization_id=? AND r.period_start=? AND r.period_end=? AND i.recipient_id=? LIMIT 1", access.organizationId, terms.periodStart, terms.periodEnd, item.recipientId!);
      if (previous) throw new ApiError(409, `A pay run already contains ${item.recipientName ?? "this payee"} for this exact period. Resume or correct the original run.`, "IMPORT_PERIOD_DUPLICATE");
      const values = item.item!, adjustment = values.adjustmentAmount;
      return { recipientId: item.recipientId!, amount: parseUnits(values.amount), maxFee: parseUnits(values.maxFee!), note: values.note, ...(values.baseAmount !== undefined ? { baseAmount: parseUnits(values.baseAmount), bonusAmount: parseUnits(values.bonusAmount ?? "0"), adjustmentAmount: adjustment?.startsWith("-") ? `-${parseUnits(adjustment.slice(1))}` : parseUnits(adjustment ?? "0") } : {}) };
    });
    const run = createPayrollRun(access, { reference: terms.reference, periodStart: terms.periodStart, periodEnd: terms.periodEnd, scheduledFor: terms.scheduledFor, items });
    getDb().prepare("UPDATE payroll_import_drafts SET run_id=?,commit_ciphertext=?,updated_at=? WHERE id=? AND organization_id=?").run(run.id, encrypt(JSON.stringify(terms)), new Date().toISOString(), id, access.organizationId);
    return { run, reused: false };
  });
}

function serializeTemplate(template: StoredTemplate) { return { id: template.id, name: decrypt(template.name_ciphertext), version: template.version, headers: JSON.parse(decrypt(template.headers_ciphertext)) as string[], settings: JSON.parse(decrypt(template.settings_ciphertext)) as ImportSettings, archived: !!template.archived_at, updatedAt: template.updated_at }; }
export function listImportTemplates(access: AccessContext) {
  authorize(access);
  return rows<StoredTemplate>("SELECT * FROM payroll_import_templates WHERE organization_id=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100", access.organizationId).map(serializeTemplate);
}
export function saveImportTemplate(access: AccessContext, input: z.infer<typeof templateSchema>, id?: string, expectedVersion?: number) {
  authorize(access);
  const value = templateSchema.parse(input);
  try { validateImportSettings(value.settings as ImportSettings, value.headers); } catch (error) { throw new ApiError(422, (error as Error).message, "IMPORT_MAPPING_INVALID"); }
  if (new Set(value.headers).size !== value.headers.length) throw new ApiError(422, "Mapping headers must be unique", "IMPORT_MAPPING_INVALID");
  return transaction(() => {
    const previous = id ? row<StoredTemplate>("SELECT * FROM payroll_import_templates WHERE id=? AND organization_id=?", id, access.organizationId) : undefined;
    if (id && !previous) throw new ApiError(404, "Import mapping not found", "IMPORT_MAPPING_NOT_FOUND");
    if (previous && (previous.archived_at || previous.version !== expectedVersion)) throw new ApiError(409, "This mapping changed or was archived. Reload before saving.", "IMPORT_MAPPING_CHANGED");
    if (!previous && row<{ n: number }>("SELECT COUNT(*) AS n FROM payroll_import_templates WHERE organization_id=? AND archived_at IS NULL", access.organizationId)!.n >= 100) throw new ApiError(422, "Archive an unused mapping before adding another", "IMPORT_MAPPING_LIMIT");
    const templateId = previous?.id ?? randomUUID(), version = (previous?.version ?? 0) + 1, now = new Date().toISOString();
    if (previous) getDb().prepare("UPDATE payroll_import_templates SET name_ciphertext=?,version=?,settings_ciphertext=?,headers_ciphertext=?,updated_at=? WHERE id=? AND organization_id=?").run(encrypt(value.name), version, encrypt(JSON.stringify(value.settings)), encrypt(JSON.stringify(value.headers)), now, templateId, access.organizationId);
    else getDb().prepare("INSERT INTO payroll_import_templates(id,organization_id,name_ciphertext,version,settings_ciphertext,headers_ciphertext,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(templateId, access.organizationId, encrypt(value.name), version, encrypt(JSON.stringify(value.settings)), encrypt(JSON.stringify(value.headers)), access.userId, now, now);
    getDb().prepare("INSERT INTO payroll_import_template_versions(template_id,version,snapshot_ciphertext,changed_by,created_at) VALUES(?,?,?,?,?)").run(templateId, version, encrypt(JSON.stringify(value)), access.userId, now);
    return serializeTemplate(row<StoredTemplate>("SELECT * FROM payroll_import_templates WHERE id=? AND organization_id=?", templateId, access.organizationId)!);
  });
}
export function archiveImportTemplate(access: AccessContext, id: string) {
  authorize(access);
  const changed = getDb().prepare("UPDATE payroll_import_templates SET archived_at=COALESCE(archived_at,?),updated_at=? WHERE id=? AND organization_id=?").run(new Date().toISOString(), new Date().toISOString(), id, access.organizationId);
  if (!changed.changes) throw new ApiError(404, "Import mapping not found", "IMPORT_MAPPING_NOT_FOUND");
  return { archived: true };
}

import { Hono, type Context } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { requireUser } from "../identity/session";
import { DOCUMENT_LIMITS, boundedInvoiceRequest, withDocumentIngress } from "../document-intake/limits";
import * as service from "./service";

const page = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) });
const cancel = z.object({ expectedVersion: z.number().int().positive() }).strict();
function originalResponse(c: Context<AppEnv>, source: ReturnType<typeof service.ownExpenseOriginal>) {
  const filename = encodeURIComponent(source.filename).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  c.header("Content-Type", source.mediaType);
  c.header("Content-Disposition", `attachment; filename="expense-receipt"; filename*=UTF-8''${filename}`);
  c.header("Content-Security-Policy", "sandbox; default-src 'none'");
  return c.body(new Uint8Array(source.bytes));
}

export const personalExpenseRoutes = new Hono<AppEnv>();
personalExpenseRoutes.use("*", requireUser);
personalExpenseRoutes.get("/", c => c.json(service.personalExpenseOverview(c.get("userId"), page.parse(c.req.query()).page)));
personalExpenseRoutes.get("/:id", c => c.json({ expense: service.ownExpense(c.get("userId"), c.req.param("id")) }));
personalExpenseRoutes.get("/:id/original", c => originalResponse(c, service.ownExpenseOriginal(c.get("userId"), c.req.param("id"))));
personalExpenseRoutes.put("/:id/correction", async c => c.json({ expense: service.correctExpense(c.get("userId"), c.req.param("id"), await c.req.json()) }));
personalExpenseRoutes.post("/:id/cancel", async c => c.json({ expense: service.cancelExpense(c.get("userId"), c.req.param("id"), cancel.parse(await c.req.json()).expectedVersion) }));
personalExpenseRoutes.post("/profiles/:recipientId/upload", async c => {
  service.eligibleRecipient(c.get("userId"), c.req.param("recipientId"));
  return withDocumentIngress(async () => {
    const request = await boundedInvoiceRequest(c.req.raw, DOCUMENT_LIMITS.requestBytes);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError(422, "Attach one PDF, PNG or JPEG receipt and its reviewed expense fields", "EXPENSE_UPLOAD_INVALID");
    let form: FormData;
    try { form = await request.formData(); } catch { throw new ApiError(422, "The receipt upload was incomplete. Choose the file again", "EXPENSE_UPLOAD_INVALID"); }
    if ([...form.keys()].some(key => !["file", "fields"].includes(key)) || form.getAll("file").length !== 1 || form.getAll("fields").length !== 1) throw new ApiError(422, "Send one receipt and one set of expense fields", "EXPENSE_UPLOAD_INVALID");
    const file = form.get("file"), text = form.get("fields");
    if (!(file instanceof File) || !file.size || file.size > DOCUMENT_LIMITS.fileBytes || typeof text !== "string" || text.length > 8000) throw new ApiError(422, "Use one receipt up to 3 MB and bounded expense fields", "EXPENSE_UPLOAD_INVALID");
    let fields: unknown;
    try { fields = JSON.parse(text); } catch { throw new ApiError(422, "Check the expense fields before uploading", "EXPENSE_UPLOAD_INVALID"); }
    const result = await service.submitExpense(c.get("userId"), c.req.param("recipientId"), c.req.header("X-Expense-Request-Key") ?? "", fields, { filename: file.name, mediaType: file.type || "application/octet-stream", bytes: Buffer.from(await file.arrayBuffer()) });
    return c.json(result, result.duplicate ? 200 : 201);
  });
});

export const companyExpenseRoutes = new Hono<AppEnv>();
companyExpenseRoutes.get("/", c => c.json(service.listCompanyExpenses(c.get("access"), page.parse(c.req.query()).page)));
companyExpenseRoutes.get("/policy", c => c.json({ policy: service.getExpensePolicy(c.get("access")) }));
companyExpenseRoutes.put("/policy", async c => c.json({ policy: service.saveExpensePolicy(c.get("access"), await c.req.json()) }));
companyExpenseRoutes.get("/:id", c => c.json({ expense: service.companyExpense(c.get("access"), c.req.param("id")) }));
companyExpenseRoutes.get("/:id/original", c => originalResponse(c, service.companyExpenseOriginal(c.get("access"), c.req.param("id"))));
companyExpenseRoutes.post("/:id/review", async c => c.json({ expense: service.reviewExpense(c.get("access"), c.req.param("id"), await c.req.json()) }));

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ApiError, requirePermission, type AppEnv } from "../context";
import { DOCUMENT_LIMITS } from "./limits";
import * as service from "./service";

export const documentRoutes = new Hono<AppEnv>();
let activeUploads = 0;
documentRoutes.use("*", async (c, next) => { requirePermission(c.get("access"), "documents:manage"); await next(); });
const revision = z.object({ revision: z.number().int().positive() }).strict();
documentRoutes.get("/config", c => c.json(service.documentConfiguration(c.get("access"))));
documentRoutes.get("/", c => c.json(service.listDocuments(c.get("access"), c.req.query())));
documentRoutes.post("/upload", async (c, next) => {
  if (activeUploads >= 2) throw new ApiError(429, "The file inbox is receiving other uploads. Retry shortly", "DOCUMENT_UPLOAD_BUSY");
  activeUploads++;
  try { await next(); } finally { activeUploads--; }
}, bodyLimit({ maxSize: DOCUMENT_LIMITS.requestBytes, onError: c => c.json({ error: "Choose an invoice file no larger than 3 MB", code: "DOCUMENT_SIZE_INVALID" }, 413) }), async c => {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError(422, "Choose an invoice file using the upload control", "DOCUMENT_FILE_REQUIRED");
  let body: FormData;
  try { body = await c.req.formData(); } catch { throw new ApiError(422, "The file upload was incomplete. Choose the file again", "DOCUMENT_UPLOAD_INVALID"); }
  const file = body.get("file");
  if (!(file instanceof File) || body.getAll("file").length !== 1) throw new ApiError(422, "Choose one PDF, PNG or JPEG invoice", "DOCUMENT_FILE_REQUIRED");
  if (!file.size || file.size > DOCUMENT_LIMITS.fileBytes) throw new ApiError(413, "Choose an invoice file from 1 byte to 3 MB", "DOCUMENT_SIZE_INVALID");
  const result = await service.uploadDocument(c.get("access"), { filename: file.name, mediaType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
  return c.json(result, result.duplicate ? 200 : 201);
});
documentRoutes.get("/:id", c => c.json({ document: service.getDocument(c.get("access"), c.req.param("id")) }));
documentRoutes.get("/:id/original", c => {
  const original = service.documentOriginal(c.get("access"), c.req.param("id"));
  c.header("Content-Type", original.mediaType);
  const filename = encodeURIComponent(original.filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  c.header("Content-Disposition", `attachment; filename="invoice"; filename*=UTF-8''${filename}`);
  c.header("Content-Security-Policy", "sandbox; default-src 'none'");
  return c.body(new Uint8Array(original.bytes));
});
documentRoutes.post("/:id/extract", async c => c.json({ document: await service.reprocessDocument(c.get("access"), c.req.param("id"), revision.parse(await c.req.json()).revision) }));
documentRoutes.post("/:id/analyze", async c => c.json({ document: await service.analyzeDocument(c.get("access"), c.req.param("id"), revision.parse(await c.req.json()).revision) }));
documentRoutes.put("/:id/text", async c => {
  const input = z.object({ revision: z.number().int().positive(), text: z.string().min(1).max(DOCUMENT_LIMITS.textCharacters) }).strict().parse(await c.req.json());
  return c.json({ document: service.saveDocumentText(c.get("access"), c.req.param("id"), input.revision, input.text) });
});
documentRoutes.post("/:id/review", async c => c.json(service.reviewDocument(c.get("access"), c.req.param("id"), service.documentReviewInput.parse(await c.req.json())), 201));
documentRoutes.delete("/:id", async c => c.json(service.deleteDocument(c.get("access"), c.req.param("id"), revision.parse(await c.req.json()).revision)));

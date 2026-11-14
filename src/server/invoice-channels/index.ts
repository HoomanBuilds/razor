import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { DOCUMENT_LIMITS, boundedInvoiceRequest } from "../document-intake/limits";
import * as service from "./service";

export const invoiceChannelRoutes = new Hono<AppEnv>();
invoiceChannelRoutes.get("/", c => c.json(service.listInvoiceChannels(c.get("access"))));
invoiceChannelRoutes.post("/", async c => c.json(service.createInvoiceChannel(c.get("access"), service.connectionInput.parse(await c.req.json())), 201));
invoiceChannelRoutes.put("/:id/credentials", async c => c.json(service.replaceChannelSecrets(c.get("access"), c.req.param("id"), z.object({ botToken: z.string().max(200).optional(), accessToken: z.string().max(4096).optional(), appSecret: z.string().max(200).optional() }).strict().parse(await c.req.json()))));
invoiceChannelRoutes.post("/:id/rotate", c => c.json(service.rotateChannelCredential(c.get("access"), c.req.param("id"))));
invoiceChannelRoutes.delete("/:id", c => c.json(service.revokeInvoiceChannel(c.get("access"), c.req.param("id"))));
invoiceChannelRoutes.post("/events/:id/retry", c => c.json(service.retryInvoiceEvent(c.get("access"), c.req.param("id"))));

export const invoiceIngressRoutes = new Hono<AppEnv>();
const webhookLimit = bodyLimit({ maxSize: 128 * 1024, onError: c => c.json({ error: "The invoice webhook exceeds its size limit", code: "CHANNEL_BODY_LIMIT" }, 413) });
invoiceIngressRoutes.post("/:id/telegram", async (c, next) => {
  service.authenticateProvider(c.req.param("id"), "telegram", c.req.header("X-Telegram-Bot-Api-Secret-Token"));
  return service.withInvoiceIngress(async () => { c.req.raw = await boundedInvoiceRequest(c.req.raw, 128 * 1024); await next(); });
}, webhookLimit, async c => c.json(service.receiveTelegram(c.req.param("id"), c.req.header("X-Telegram-Bot-Api-Secret-Token"), await c.req.json()), 202));
invoiceIngressRoutes.get("/:id/whatsapp", c => c.text(service.verifyWhatsAppChallenge(c.req.param("id"), c.req.query("hub.mode"), c.req.query("hub.verify_token"), c.req.query("hub.challenge"))));
invoiceIngressRoutes.post("/:id/whatsapp", async (c, next) => {
  service.authenticateProvider(c.req.param("id"), "whatsapp");
  return service.withInvoiceIngress(async () => { c.req.raw = await boundedInvoiceRequest(c.req.raw, 128 * 1024); await next(); });
}, webhookLimit, async c => c.json(service.receiveWhatsApp(c.req.param("id"), c.req.header("X-Hub-Signature-256"), Buffer.from(await c.req.arrayBuffer())), 202));
invoiceIngressRoutes.get("/:id/events/:eventKey", c => c.json(service.folderEventStatus(c.req.param("id"), c.req.header("Authorization"), c.req.param("eventKey"))));
invoiceIngressRoutes.post("/:id/upload", async (c, next) => {
  service.authenticateFolder(c.req.param("id"), c.req.header("Authorization"));
  return service.withInvoiceIngress(async () => { c.req.raw = await boundedInvoiceRequest(c.req.raw, DOCUMENT_LIMITS.requestBytes); await next(); });
}, bodyLimit({ maxSize: DOCUMENT_LIMITS.requestBytes, onError: c => c.json({ error: "Choose an invoice file no larger than 3 MB", code: "DOCUMENT_SIZE_INVALID" }, 413) }), async c => {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError(422, "Send one invoice as multipart form data", "DOCUMENT_FILE_REQUIRED");
  let body: FormData;
  try { body = await c.req.formData(); } catch { throw new ApiError(422, "The invoice upload was incomplete", "DOCUMENT_UPLOAD_INVALID"); }
  const file = body.get("file");
  if (!(file instanceof File) || body.getAll("file").length !== 1 || [...body.keys()].some(key => key !== "file")) throw new ApiError(422, "Send one PDF, PNG or JPEG invoice", "DOCUMENT_FILE_REQUIRED");
  if (!file.size || file.size > DOCUMENT_LIMITS.fileBytes) throw new ApiError(413, "Choose an invoice file from 1 byte to 3 MB", "DOCUMENT_SIZE_INVALID");
  const result = await service.receiveFolder(c.req.param("id"), c.req.header("Authorization"), c.req.header("X-Invoice-Event-Id") ?? "", { filename: file.name, mediaType: file.type || "application/octet-stream", bytes: Buffer.from(await file.arrayBuffer()) });
  return c.json(result, 200);
});

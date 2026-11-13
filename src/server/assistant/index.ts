import { Hono } from "hono";
import { ApiError, type AppEnv } from "../context";
import * as service from "./service";

export * from "./service";
export const assistantRoutes = new Hono<AppEnv>();

assistantRoutes.get("/config", (c) => c.json(service.assistantConfiguration(c.get("access"))));
assistantRoutes.get("/drafts", (c) => c.json({ drafts: service.listDrafts(c.get("access")) }));
assistantRoutes.get("/drafts/:id/evidence", (c) => {
  const evidence=service.getDraftEvidence(c.get("access"),c.req.param("id"));
  c.header("Cache-Control","no-store");
  if(c.req.query("download")==="1")c.header("Content-Disposition",'attachment; filename="razor-private-invoice.json"');
  return c.json(evidence);
});
assistantRoutes.delete("/drafts/:id", (c) => c.json(service.deleteDraft(c.get("access"), c.req.param("id"))));
assistantRoutes.post("/analyze", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new ApiError(422, "Send invoice text as JSON", "INVOICE_TEXT_INVALID"); }
  if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") throw new ApiError(422, "Include invoice text", "INVOICE_TEXT_INVALID");
  return c.json(await service.analyzeInvoice(c.get("access"), body.text));
});

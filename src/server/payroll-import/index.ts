import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import * as service from "./service";
import { mappingRequestSchema, suggestImportMapping } from "./mapping";

export const payrollImportRoutes = new Hono<AppEnv>();
payrollImportRoutes.post("/suggest-mapping", async c => c.json({ suggestion: await suggestImportMapping(c.get("access"), mappingRequestSchema.parse(await c.req.json())) }));
payrollImportRoutes.get("/templates", c => c.json({ templates: service.listImportTemplates(c.get("access")) }));
payrollImportRoutes.post("/templates", async c => c.json({ template: service.saveImportTemplate(c.get("access"), service.templateSchema.parse(await c.req.json())) }, 201));
payrollImportRoutes.put("/templates/:id", async c => {
  const { expectedVersion, ...value } = service.templateSchema.extend({ expectedVersion: z.number().int().positive() }).parse(await c.req.json());
  return c.json({ template: service.saveImportTemplate(c.get("access"), value, c.req.param("id"), expectedVersion) });
});
payrollImportRoutes.delete("/templates/:id", c => c.json(service.archiveImportTemplate(c.get("access"), c.req.param("id"))));
payrollImportRoutes.get("/drafts", c => c.json({ drafts: service.listImportDrafts(c.get("access")) }));
payrollImportRoutes.post("/drafts", async c => c.json({ draft: service.createImportDraft(c.get("access"), service.createImportSchema.parse(await c.req.json())) }, 201));
payrollImportRoutes.get("/drafts/:id", c => c.json({ draft: service.getImportDraft(c.get("access"), c.req.param("id")) }));
payrollImportRoutes.put("/drafts/:id", async c => c.json({ draft: service.updateImportDraft(c.get("access"), c.req.param("id"), service.updateImportSchema.parse(await c.req.json())) }));
payrollImportRoutes.delete("/drafts/:id", c => c.json(service.deleteImportDraft(c.get("access"), c.req.param("id"))));
payrollImportRoutes.post("/drafts/:id/commit", async c => c.json(service.commitImportDraft(c.get("access"), c.req.param("id"), service.commitImportSchema.parse(await c.req.json())), 201));

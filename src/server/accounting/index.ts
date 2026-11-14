import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { appOrigin } from "../identity/session";
import { providerSchema } from "./model";
import * as service from "./service";

export const accountingRoutes = new Hono<AppEnv>();
const page = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) });
accountingRoutes.get("/", c => c.json(service.accountingOverview(c.get("access"), page.parse(c.req.query()).page)));
accountingRoutes.post("/connect/:provider", c => c.json(service.beginAccountingConnection(c.get("access"), providerSchema.parse(c.req.param("provider")))));
accountingRoutes.post("/connections/:id/entity", async c => c.json({ connection: await service.selectAccountingEntity(c.get("access"), c.req.param("id"), z.object({ entityId: z.string().min(1).max(128) }).strict().parse(await c.req.json()).entityId) }));
accountingRoutes.post("/connections/:id/disconnect", async c => c.json(await service.disconnectAccounting(c.get("access"), c.req.param("id"))));
accountingRoutes.get("/connections/:id/catalog", c => c.json(service.accountingCatalog(c.get("access"), c.req.param("id"))));
accountingRoutes.post("/connections/:id/catalog", async c => c.json(await service.refreshAccountingCatalog(c.get("access"), c.req.param("id"), z.object({ page: z.number().int().min(1).max(100).default(1) }).strict().parse(await c.req.json()).page)));
accountingRoutes.put("/connections/:id/mapping", async c => c.json({ mapping: service.saveAccountingMapping(c.get("access"), c.req.param("id"), await c.req.json()) }));
accountingRoutes.post("/connections/:id/plans", async c => c.json(service.createAccountingPlan(c.get("access"), c.req.param("id"), await c.req.json()), 201));
accountingRoutes.post("/jobs/:id/approve", async c => c.json(service.approveAccountingPlan(c.get("access"), c.req.param("id"), z.object({ reviewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json()).reviewHash)));
accountingRoutes.post("/jobs/:id/retry-preflight", c => c.json(service.retryAccountingPreflight(c.get("access"), c.req.param("id"))));
accountingRoutes.post("/jobs/:id/reconcile", async c => {
 const input = z.object({ acknowledgeMatchingRevision: z.boolean().default(false) }).strict().parse(await c.req.json());
 return c.json(await service.reconcileAccountingJob(c.get("access"), c.req.param("id"), input.acknowledgeMatchingRevision));
});
accountingRoutes.post("/dispatch", async c => {
 const access = service.accountingAccess(c.get("access"), true);
 return c.json(await service.dispatchAccountingJobs({ organizationId: access.organizationId, maxJobs: 1 }));
});

export const accountingOAuthRoutes = new Hono<AppEnv>();
accountingOAuthRoutes.get("/:provider/callback", async c => {
 const provider = providerSchema.parse(c.req.param("provider"));
 const parsed = z.object({ state: z.string().min(1).max(200), code: z.string().max(4096).optional(), realmId: z.string().max(30).optional(), error: z.string().max(200).optional() }).parse(c.req.query());
 try {
  const result = await service.finishAccountingConnection(provider, parsed);
  const url = new URL(appOrigin()); url.search = new URLSearchParams({ company: result.organizationId, section: "accounting" }).toString();
  return c.redirect(url.toString(), 303);
 } catch (error) {
  if (error instanceof ApiError) throw error;
  throw new ApiError(502, "The accounting consent could not finish. Return to company settings and start a new request", "ACCOUNTING_AUTH_FAILED");
 }
});
export { dispatchAccountingJobs } from "./service";

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireUser } from "../identity/session";
import * as service from "./service";

export const procurementRoutes = new Hono<AppEnv>();
procurementRoutes.get("/", c => c.json(service.overview(c.get("access"), c.req.query("search") ?? "")));
procurementRoutes.post("/requests", async c => c.json({ request: service.createRequest(c.get("access"), await c.req.json()) }, 201));
procurementRoutes.get("/requests/:id", c => c.json({ request: service.inspectRequest(c.get("access"), c.req.param("id")) }));
procurementRoutes.post("/requests/:id/publish", async c => c.json({ request: service.publishRequest(c.get("access"), c.req.param("id"), z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json()).reviewToken) }));
procurementRoutes.post("/requests/:id/cancel", async c => c.json({ request: service.cancelRequest(c.get("access"), c.req.param("id"), z.object({ reason: z.string().trim().min(3).max(3000) }).strict().parse(await c.req.json()).reason) }));
procurementRoutes.post("/requests/:id/award", async c => c.json({ request: service.awardQuote(c.get("access"), c.req.param("id"), await c.req.json()) }));
procurementRoutes.post("/awards/:id/receipts", async c => c.json({ request: service.recordReceipt(c.get("access"), c.req.param("id"), await c.req.json()) }));
procurementRoutes.post("/awards/:id/invoices", async c => c.json({ match: service.matchInvoice(c.get("access"), c.req.param("id"), await c.req.json()) }));
procurementRoutes.post("/inventory", async c => c.json({ item: service.createInventory(c.get("access"), await c.req.json()) }, 201));
procurementRoutes.post("/inventory/:id/adjust", async c => c.json({ item: service.adjustStock(c.get("access"), c.req.param("id"), await c.req.json()) }));
procurementRoutes.put("/inventory/:id", async c => c.json({ item: service.updateInventory(c.get("access"), c.req.param("id"), await c.req.json()) }));

export const supplierProcurementRoutes = new Hono<AppEnv>();
supplierProcurementRoutes.use("*", requireUser);
supplierProcurementRoutes.get("/", c => c.json({ requests: service.supplierRequests(c.get("userId")) }));
supplierProcurementRoutes.post("/requests/:id/quotes", async c => c.json({ quote: service.submitQuote(c.get("userId"), c.req.param("id"), await c.req.json()) }, 201));

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import * as service from "./service";

export * from "./service";
export { clientReserveExportRows } from "./export";
export const clientReserveRoutes = new Hono<AppEnv>();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const entityId = z.string().min(1).max(128);
clientReserveRoutes.get("/", (c) => c.json(service.listClientReserves(c.get("access"))));
clientReserveRoutes.post("/", async (c) => c.json({ reserve: service.createClientReserve(c.get("access"), z.object({ idempotencyKey, amount: z.string().regex(/^[1-9]\d*$/).max(39), purpose: z.string().trim().min(1).max(500), clientReference: z.string().trim().max(200).optional(), fundingId: entityId.optional(), paymentId: entityId.optional() }).strict().parse(await c.req.json())) }, 201));
clientReserveRoutes.get("/:id", (c) => c.json({ reserve: service.getClientReserve(c.get("access"), c.req.param("id")) }));
clientReserveRoutes.post("/:id/allocate", async (c) => c.json({ reserve: service.allocateClientReserve(c.get("access"), c.req.param("id"), z.object({ idempotencyKey, paymentId: entityId.optional() }).strict().parse(await c.req.json())) }));
clientReserveRoutes.post("/:id/release", async (c) => c.json({ reserve: service.releaseClientReserve(c.get("access"), c.req.param("id"), z.object({ idempotencyKey, reason: z.string().trim().min(3).max(2000) }).strict().parse(await c.req.json())) }));

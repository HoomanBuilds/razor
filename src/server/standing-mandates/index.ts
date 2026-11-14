import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { inspectGrant, listGrants, observeGrant, prepareApproval, prepareGrant, prepareStatus } from "./service";

export const standingMandateRoutes = new Hono<AppEnv>();
standingMandateRoutes.get("/", async c => c.json(await listGrants(c.get("access"))));
standingMandateRoutes.post("/prepare", async c => c.json(await prepareGrant(c.get("access"), await c.req.json())));
standingMandateRoutes.get("/:id", async c => c.json(await inspectGrant(c.get("access"), c.req.param("id"))));
standingMandateRoutes.post("/:id/approve", async c => {
  const input = z.object({ accountId: z.string().min(2).max(64) }).parse(await c.req.json());
  return c.json(await prepareApproval(c.get("access"), c.req.param("id"), input.accountId));
});
standingMandateRoutes.post("/:id/observe", async c => c.json(await observeGrant(c.get("access"), c.req.param("id"))));
standingMandateRoutes.post("/:id/status", async c => {
  const input = z.object({ paused: z.boolean(), revoke: z.boolean().default(false) }).parse(await c.req.json());
  return c.json(await prepareStatus(c.get("access"), c.req.param("id"), input.paused, input.revoke));
});

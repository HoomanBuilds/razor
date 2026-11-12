import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { verifyOrigin } from "../identity/session";
import * as service from "./service";

export * from "./service";
export const fundingRequestRoutes = new Hono<AppEnv>();
export const publicFundingRoutes = new Hono<AppEnv>();
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

fundingRequestRoutes.get("/", (c) => c.json({ requests: service.listFundingRequests(c.get("access")) }));
fundingRequestRoutes.post("/", async (c) => c.json(await service.createFundingRequest(c.get("access"), z.object({ amount: z.string().regex(/^[1-9]\d*$/).max(39), purpose: z.string().trim().min(1).max(500), expiresAt: z.string().datetime(), paymentId: z.string().min(1).max(128).optional() }).strict().parse(await c.req.json())), 201));
fundingRequestRoutes.get("/:id", (c) => c.json({ request: service.getFundingRequest(c.get("access"), c.req.param("id")) }));
fundingRequestRoutes.post("/:id/revoke", (c) => c.json({ request: service.revokeFundingRequest(c.get("access"), c.req.param("id")) }));
fundingRequestRoutes.post("/:id/rotate-link", (c) => c.json(service.rotateFundingLink(c.get("access"), c.req.param("id"))));

publicFundingRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) verifyOrigin(c);
  await next();
});
publicFundingRoutes.get("/request", (c) => c.json({ request: service.getPublicFundingRequest(token.parse(c.req.query("token"))) }));
publicFundingRoutes.get("/assets", async (c) => c.json({ tokens: await service.getPublicAssets(token.parse(c.req.query("token"))) }));
publicFundingRoutes.post("/quote", async (c) => {
  const input = z.object({ token, originAsset: z.string().min(1).max(256), refundAddress: z.string().min(1).max(256), idempotencyKey: key }).strict().parse(await c.req.json());
  return c.json(await service.preparePublicQuote(input.token, input));
});
publicFundingRoutes.post("/resume", async (c) => {
  const input = z.object({ token, idempotencyKey: key }).strict().parse(await c.req.json());
  return c.json(service.resumePublicQuote(input.token, input.idempotencyKey));
});
publicFundingRoutes.post("/reconcile", async (c) => {
  const input = z.object({ token, fundingId: z.string().min(1).max(128), idempotencyKey: key.optional(), sourceTxHash: z.string().min(8).max(160).optional() }).strict().parse(await c.req.json());
  return c.json(await service.reconcilePublicFunding(input.token, input));
});

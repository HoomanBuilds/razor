import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import * as service from "./service";
import * as funded from "./funded";

export const clearingRoutes = new Hono<AppEnv>();
const id = z.string().min(1).max(100), digest = z.string().regex(/^[a-f0-9]{64}$/);
const selection = z.object({ linkIds: z.array(id).min(2).max(32), startsAt: z.string().datetime(), expiresAt: z.string().datetime() });
clearingRoutes.get("/", c => c.json(service.overview(c.get("access"))));
clearingRoutes.post("/participation", async c => c.json(await service.setParticipation(c.get("access"), z.object({ enabled: z.boolean() }).parse(await c.req.json()).enabled)));
clearingRoutes.get("/companies/:id", c => c.json(service.lookupCompany(c.get("access"), c.req.param("id"))));
clearingRoutes.post("/invoices", async c => c.json(service.offerInvoice(c.get("access"), z.object({ billId: id, creditorId: id, startsAt: z.string().datetime(), expiresAt: z.string().datetime() }).parse(await c.req.json())), 201));
clearingRoutes.post("/invoices/:id/accept", async c => c.json(service.acceptInvoice(c.get("access"), c.req.param("id"), z.object({ termsHash: digest }).parse(await c.req.json()).termsHash)));
clearingRoutes.post("/invoices/:id/revoke", c => c.json(service.revokeInvoice(c.get("access"), c.req.param("id"))));
clearingRoutes.post("/invoices/:id/share", async c => c.json(service.shareInvoice(c.get("access"), c.req.param("id"), z.object({ companyId: id }).parse(await c.req.json()).companyId)));
clearingRoutes.post("/rounds/preview", async c => c.json(service.previewRound(c.get("access"), selection.parse(await c.req.json()))));
clearingRoutes.post("/rounds", async c => c.json(service.createRound(c.get("access"), selection.extend({ reviewToken: digest }).parse(await c.req.json())), 201));
clearingRoutes.get("/rounds/:id", c => c.json(service.roundDetail(c.get("access"), c.req.param("id"))));
clearingRoutes.post("/rounds/:id/actions", async c => { const input = z.object({ manifestHash: digest, operation: z.enum(["register", "consent", "finalize", "revoke"]) }).parse(await c.req.json()); return c.json(await service.prepareRoundAction(c.get("access"), c.req.param("id"), input.manifestHash, input.operation)); });
clearingRoutes.post("/rounds/:id/reconcile", async c => c.json(await service.reconcileRound(c.get("access"), c.req.param("id"))));

clearingRoutes.get("/funded", c => c.json(funded.fundedOverview(c.get("access"), z.coerce.number().int().min(1).max(100000).default(1).parse(c.req.query("page")))));
clearingRoutes.post("/funded/preview", async c => c.json(funded.previewFundedRound(c.get("access"), selection.strict().parse(await c.req.json()))));
clearingRoutes.post("/funded/rounds", async c => c.json(funded.createFundedRound(c.get("access"), selection.extend({ reviewToken: digest }).strict().parse(await c.req.json())), 201));
clearingRoutes.get("/funded/rounds/:id", c => c.json(funded.fundedRoundDetail(c.get("access"), c.req.param("id"))));
clearingRoutes.post("/funded/rounds/:id/discard", c => c.json(funded.discardFundedProposal(c.get("access"), c.req.param("id"))));
clearingRoutes.post("/funded/rounds/:id/actions", async c => c.json(await funded.prepareFundedAction(c.get("access"), c.req.param("id"), await c.req.json())));
clearingRoutes.post("/funded/rounds/:id/begin", async c => c.json(await funded.beginFundedAction(c.get("access"), c.req.param("id"), await c.req.json())));
clearingRoutes.post("/funded/rounds/:id/finish-wallet", async c => {
  const input = z.object({ requestId: z.string().uuid(), reviewGeneration: z.string().uuid(), transactionHash: z.string().min(32).max(64).optional() }).strict().parse(await c.req.json());
  return c.json(funded.finishFundedWallet(c.get("access"), c.req.param("id"), input.requestId, input.reviewGeneration, input.transactionHash));
});
clearingRoutes.post("/funded/rounds/:id/cancel-review", async c => {
  const input = z.object({ requestId: z.string().uuid(), reviewGeneration: z.string().uuid() }).strict().parse(await c.req.json());
  return c.json(funded.cancelFundedReview(c.get("access"), c.req.param("id"), input.requestId, input.reviewGeneration));
});
clearingRoutes.post("/funded/rounds/:id/verify-deposit", async c => {
  const input = z.object({ depositId: z.string().min(1).max(128), transactionHash: z.string().min(32).max(64) }).strict().parse(await c.req.json());
  return c.json(await funded.verifyFundedDeposit(c.get("access"), c.req.param("id"), input.depositId, input.transactionHash));
});
clearingRoutes.post("/funded/rounds/:id/reconcile", async c => c.json(await funded.reconcileFundedRound(c.get("access"), c.req.param("id"))));

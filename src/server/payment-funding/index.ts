import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import * as service from "./service";

export * from "./service";
export const paymentFundingRoutes = new Hono<AppEnv>();
const text = z.string().trim().min(1).max(200);
const quoteInput = z.object({ idempotencyKey: z.string().min(16).max(128), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), originAsset: text, refundAddress: text, walletId: text.optional() }).strict();
const reconcileInput = z.object({ fundingId: text.optional(), sourceTxHash: text.optional(), senderAccountId: text.optional(), transactionHash: text.optional() }).strict();

paymentFundingRoutes.get("/:paymentId", c => c.json(service.paymentFundingTask(c.get("access"), c.req.param("paymentId"))));
paymentFundingRoutes.post("/:paymentId/quote", async c => c.json(await service.quotePaymentFunding(c.get("access"), c.req.param("paymentId"), quoteInput.parse(await c.req.json()))));
paymentFundingRoutes.post("/:paymentId/reserve", async c => c.json(await service.reserveTaskFunding(c.get("access"), c.req.param("paymentId"))));
paymentFundingRoutes.post("/:paymentId/balance-refresh", async c => c.json(await service.prepareTaskBalanceRefresh(c.get("access"), c.req.param("paymentId"))));
paymentFundingRoutes.post("/:paymentId/reconcile", async c => c.json(await service.reconcileTaskFunding(c.get("access"), c.req.param("paymentId"), reconcileInput.parse(await c.req.json()))));
paymentFundingRoutes.post("/:paymentId/deposit-claim", async c => c.json(await service.claimTaskDeposit(c.get("access"), c.req.param("paymentId"), z.object({ fundingId: text }).strict().parse(await c.req.json()).fundingId)));
paymentFundingRoutes.post("/:paymentId/close-unsent", async c => {
  const input = z.object({ fundingId: text, noTransferConfirmed: z.boolean() }).strict().parse(await c.req.json());
  return c.json(await service.closeUnsentFunding(c.get("access"), c.req.param("paymentId"), input.fundingId, input.noTransferConfirmed));
});

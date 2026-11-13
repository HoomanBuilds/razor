import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { getSupportedTokens } from "./intents";
import * as service from "./service";
import { paymentReviewToken } from "./approval";
import { transaction } from "../db";

export * from "./service";
export type { Payment, PayoutAttempt, FundingLeg } from "./types";

const amount = z.string().regex(/^[1-9]\d*$/).max(39);
const optionalAmount = z.string().regex(/^(0|[1-9]\d*)$/).max(39);
const text = z.string().trim().min(1).max(200);
const quoteInput = z.object({ useBackup: z.boolean().optional(), dry: z.boolean().optional() });
const paymentInput = z.object({ recipientId: text, reference: text, amount, maxFee: optionalAmount.optional(), kind: z.enum(["payment", "payroll", "contractor", "invoice", "vendor", "business"]).optional(), scheduledFor: z.string().datetime().nullish(), metadata: z.record(z.string(), z.unknown()).optional() });
const fundingInput = z.object({ originAsset: text, amount, refundAddress: text, reference: text, paymentId: text.optional(), exactOutput: z.boolean().optional(), dry: z.boolean().optional() });

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try { data = await request.json(); } catch { throw new ApiError(422, "Send a JSON request body", "INVALID_INPUT"); }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? "Invalid request", "INVALID_INPUT");
  return parsed.data;
}

export const paymentsRoutes = new Hono<AppEnv>();
export const assetRoutes = new Hono<AppEnv>();
assetRoutes.get("/", async (c) => {
  const tokens = await getSupportedTokens();
  return c.json({ tokens, chains: [...new Set(tokens.map((token) => token.blockchain))].sort() });
});

paymentsRoutes.get("/assets", async (c) => {
  const tokens = await getSupportedTokens();
  return c.json({ tokens, chains: [...new Set(tokens.map((token) => token.blockchain))].sort() });
});
paymentsRoutes.get("/treasury", (c) => c.json(service.getTreasury(c.get("access"))));
paymentsRoutes.post("/treasury/configure", async (c) => c.json(await service.configureTreasury(c.get("access"), await body(c.req.raw, z.object({ nearAccountId: text, tokenContract: text, network: z.enum(["mainnet", "testnet"]) })))));
paymentsRoutes.post("/treasury/sync", async (c) => c.json(await service.syncTreasury(c.get("access"))));
paymentsRoutes.post("/treasury/setup", async (c) => c.json(await service.prepareTreasurySetup(c.get("access"))));
paymentsRoutes.get("/networks", (c) => c.json({ networks: service.listNetworks(c.get("access")) }));
paymentsRoutes.patch("/networks/:network", async (c) => c.json(service.setNetwork(c.get("access"), c.req.param("network"), (await body(c.req.raw, z.object({ enabled: z.boolean() }))).enabled)));
paymentsRoutes.get("/ledger", (c) => c.json({ ledger: service.listLedger(c.get("access")) }));
paymentsRoutes.get("/funding", (c) => c.json({ funding: service.listFunding(c.get("access")) }));
paymentsRoutes.post("/funding", async (c) => c.json(await service.prepareFunding(c.get("access"), await body(c.req.raw, fundingInput)), 201));
paymentsRoutes.post("/funding/:id/reconcile", async (c) => c.json(await service.reconcileFunding(c.get("access"), c.req.param("id"), (await body(c.req.raw, z.object({ sourceTxHash: text.optional() }))).sourceTxHash)));
paymentsRoutes.get("/payments", (c) => c.json({ payments: service.listPayments(c.get("access")) }));
paymentsRoutes.post("/payments", async (c) => c.json({ payment: service.createPayment(c.get("access"), await body(c.req.raw, paymentInput)) }, 201));
paymentsRoutes.get("/payments/:id", (c) => {
  const payment = service.getPayment(c.get("access"), c.req.param("id"));
  return c.json({ payment, reviewToken: paymentReviewToken(payment), attempts: service.listAttempts(c.get("access"), payment.id) });
});
paymentsRoutes.post("/payments/:id/approve", async (c) => {
  const input = await body(c.req.raw, z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }));
  return c.json(transaction(() => {
    const payment = service.getPayment(c.get("access"), c.req.param("id"));
    const metadata = JSON.parse(payment.metadata) as { runId?: string; billId?: string };
    if (!payment.approved_at && (metadata.runId || metadata.billId)) throw new ApiError(409, "Review and approve the underlying payroll run or invoice first", "SOURCE_REVIEW_REQUIRED");
    if (input.reviewToken !== paymentReviewToken(payment)) throw new ApiError(409, "Payment terms changed. Review the current amount and receiving details before approval", "PAYMENT_REVIEW_CHANGED");
    return { payment: service.approvePayment(c.get("access"), payment.id) };
  }));
});
paymentsRoutes.post("/payments/:id/revalidate", (c) => c.json({ payment: service.revalidatePaymentRecipient(c.get("access"), c.req.param("id")) }));
paymentsRoutes.post("/payments/:id/cancel", async (c) => c.json(await service.cancelPayment(c.get("access"), c.req.param("id"))));
paymentsRoutes.post("/payments/:id/quote", async (c) => c.json(await service.preparePaymentQuote(c.get("access"), c.req.param("id"), await body(c.req.raw, quoteInput))));
paymentsRoutes.post("/payments/:id/reconcile", async (c) => c.json(await service.reconcilePayment(c.get("access"), c.req.param("id"))));
paymentsRoutes.post("/attempts/:id/submitted", async (c) => c.json({ attempt: await service.markAttemptSubmitted(c.get("access"), c.req.param("id"), (await body(c.req.raw, z.object({ txHash: text }))).txHash) }));
paymentsRoutes.post("/attempts/:id/approve", async (c) => c.json(await service.prepareAttemptApproval(c.get("access"), c.req.param("id"))));
paymentsRoutes.post("/attempts/:id/resume", async (c) => c.json(await service.resumeAttempt(c.get("access"), c.req.param("id"))));
paymentsRoutes.post("/attempts/:id/close", async (c) => c.json(await service.closeUnfundedAttempt(c.get("access"), c.req.param("id"))));
paymentsRoutes.post("/attempts/:id/settlement", async (c) => c.json(await service.prepareSettlement(c.get("access"), c.req.param("id"), await body(c.req.raw, z.object({ outcome: z.enum(["delivered", "uncertain", "refund_pending"]), receipt: z.string().min(1).max(2000) })))));
paymentsRoutes.post("/attempts/:id/refund", async (c) => c.json(await service.prepareRefundConfirmation(c.get("access"), c.req.param("id"), await body(c.req.raw, z.object({ refundAmount: optionalAmount, receipt: z.string().min(1).max(2000) })))));

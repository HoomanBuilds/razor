import { Hono } from "hono";
import { listPrivateEvidence } from "./evidence";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { accountingExport } from "./export";
import { getFundingReceipt, verifyFundingCredit } from "./funding";
import { reconciliationQueue } from "./service";
import { prepareSourceRecovery } from "./source";

export { accountingExport } from "./export";
export { getFundingReceipt, verifyFundingCredit } from "./funding";
export { reconciliationQueue } from "./service";
export { prepareSourceRecovery } from "./source";
export const reconciliationRoutes = new Hono<AppEnv>();
reconciliationRoutes.get("/attempts/:id/evidence", (c) => c.json({ evidence: listPrivateEvidence(c.get("access"), c.req.param("id")) }));

reconciliationRoutes.get("/", (c) => {
  const parsed = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, "Choose a valid reconciliation page", "INVALID_PAGINATION");
  return c.json(reconciliationQueue(c.get("access"), parsed.data.page, parsed.data.pageSize));
});
reconciliationRoutes.get("/funding/:id", (c) => c.json(getFundingReceipt(c.get("access"), c.req.param("id"))));
reconciliationRoutes.post("/funding/:id/verify", async (c) => {
  let input: unknown;
  try { input = await c.req.json(); } catch { throw new ApiError(422, "Send the NEAR transaction signer as JSON", "INVALID_RECEIPT_INPUT"); }
  const parsed = z.object({ senderAccountId: z.string().min(2).max(64), transactionHash: z.string().min(32).max(64).optional(), receiptId: z.string().min(32).max(64).optional() }).safeParse(input);
  if (!parsed.success) throw new ApiError(422, "Enter the NEAR destination transaction signer and optional transaction hash", "INVALID_RECEIPT_INPUT");
  return c.json(await verifyFundingCredit(c.get("access"), c.req.param("id"), parsed.data));
});
reconciliationRoutes.get("/export", (c) => {
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="razor-reconciliation.csv"');
  c.header("Cache-Control", "no-store");
  return c.body(accountingExport(c.get("access")));
});
reconciliationRoutes.post("/attempts/:id/source", async (c) => {
  let input: unknown;
  try { input = await c.req.json(); } catch { throw new ApiError(422, "Send the original source transaction details", "INVALID_RECEIPT_INPUT"); }
  const parsed = z.object({ senderAccountId: z.string().min(2).max(64), transactionHash: z.string().min(32).max(64) }).safeParse(input);
  if (!parsed.success) throw new ApiError(422, "Enter the original NEAR transaction hash and signer", "INVALID_RECEIPT_INPUT");
  return c.json(await prepareSourceRecovery(c.get("access"), c.req.param("id"), parsed.data));
});

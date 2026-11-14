import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import * as service from "./service";

export const payrollExecutionRoutes = new Hono<AppEnv>();
const id = z.string().min(1).max(100);
async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let input: unknown;
  try { input = await request.json(); } catch { throw new ApiError(422, "Send a JSON request body", "INVALID_INPUT"); }
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(422, result.error.issues[0]?.message ?? "Invalid input", "INVALID_INPUT");
  return result.data;
}
payrollExecutionRoutes.get("/", async c => c.json(await service.executionOverview(c.get("access"), c.req.param("id")!)));
payrollExecutionRoutes.post("/reserve", c => c.json(service.reserveRun(c.get("access"), c.req.param("id")!)));
payrollExecutionRoutes.post("/reconcile", async c => c.json(await service.reconcileRun(c.get("access"), c.req.param("id")!)));
payrollExecutionRoutes.post("/batches", async c => c.json(await service.prepareRunBatch(c.get("access"), c.req.param("id")!, await body(c.req.raw, z.object({ stage: z.enum(["prepare", "approve", "execute", "close"]), selections: z.array(z.object({ paymentId: id, useBackup: z.boolean().optional() })).min(1).max(5), maximumTransactions: z.number().int().min(1).max(8).optional() })))));
payrollExecutionRoutes.post("/batches/:batchId/begin", async c => c.json(await service.beginRunBatch(c.get("access"), c.req.param("id")!, c.req.param("batchId"), await body(c.req.raw, z.object({ reviewHash: z.string().regex(/^[a-f0-9]{64}$/), signerAccount: z.string().min(2).max(64) })))));
payrollExecutionRoutes.post("/batches/:batchId/reconcile", async c => c.json(await service.reconcileRunBatch(c.get("access"), c.req.param("id")!, c.req.param("batchId"), await body(c.req.raw, z.object({ receipts: z.array(z.object({ index: z.number().int().min(0).max(7), hash: z.string().min(32).max(64) })).max(8).optional() })))));
payrollExecutionRoutes.post("/batches/:batchId/cancel", c => c.json(service.cancelRunBatch(c.get("access"), c.req.param("id")!, c.req.param("batchId"))));

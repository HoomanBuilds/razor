import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import * as service from "./service";

export * from "./service";
export const paymentManagementRoutes = new Hono<AppEnv>();
const micro = z.string().regex(/^(0|[1-9]\d*)$/).max(31);
const signed = z.string().regex(/^-?(0|[1-9]\d*)$/).max(32);
const token = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(z.string().min(1).max(100)).min(1).max(100);

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new ApiError(422, "Send a JSON request body", "INVALID_INPUT"); }
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, result.error.issues[0]?.message ?? "Invalid input", "INVALID_INPUT");
  return result.data;
}

paymentManagementRoutes.get("/", (c) => c.json(service.managementOverview(c.get("access"))));
paymentManagementRoutes.get("/payroll/:id/review", async (c) => c.json(await service.payrollPreview(c.get("access"), c.req.param("id"))));
paymentManagementRoutes.patch("/payroll/:id/items/:itemId", async (c) => c.json(service.adjustPayrollItem(c.get("access"), c.req.param("id"), c.req.param("itemId"), await body(c.req.raw, z.object({ expectedPaymentId: z.string().min(1), expectedTermsVersion: z.number().int().nonnegative(), baseAmount: micro, bonusAmount: micro, adjustmentAmount: signed, maxFee: micro, note: z.string().max(1000) })))));
paymentManagementRoutes.post("/payroll/:id/approve", async (c) => c.json({ run: service.approveReviewedPayrollRun(c.get("access"), c.req.param("id"), (await body(c.req.raw, z.object({ reviewToken: token }))).reviewToken) }));
paymentManagementRoutes.get("/payments/:id", (c) => c.json(service.managedPaymentReview(c.get("access"), c.req.param("id"))));
paymentManagementRoutes.post("/payments/:id/cancel", async (c) => c.json(await service.cancelManagedPayment(c.get("access"), c.req.param("id"))));
paymentManagementRoutes.post("/payments/:id/replace", async (c) => c.json(await service.replaceCancelledPayment(c.get("access"), c.req.param("id"), (await body(c.req.raw, z.object({ reason: z.string().trim().min(3).max(1000) }))).reason)));
paymentManagementRoutes.post("/bills/preview", async (c) => c.json(await service.billBatchPreview(c.get("access"), (await body(c.req.raw, z.object({ billIds: ids }))).billIds)));
paymentManagementRoutes.post("/bills/approve", async (c) => { const input = await body(c.req.raw, z.object({ billIds: ids, reviewToken: token })); return c.json(service.approveBillBatch(c.get("access"), input.billIds, input.reviewToken)); });

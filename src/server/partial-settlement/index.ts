import { Hono } from "hono";
import { z } from "zod";
import { ApiError, type AppEnv } from "../context";
import { approveRemainder, createRemainder, partialReview, preparePartialSettlement } from "./service";

export const partialSettlementRoutes = new Hono<AppEnv>();
const digest = z.string().regex(/^[a-f0-9]{64}$/), amount = z.string().regex(/^[1-9]\d*$/).max(39);
async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const result = schema.safeParse(await request.json());
  if (!result.success) throw new ApiError(422, "Review the partial amount, terminal closure evidence and current remainder terms", "PARTIAL_INPUT_INVALID");
  return result.data;
}
partialSettlementRoutes.get("/payments/:id", c => c.json(partialReview(c.get("access"), c.req.param("id"))));
partialSettlementRoutes.post("/attempts/:id/prepare", async c => c.json(await preparePartialSettlement(c.get("access"), c.req.param("id"), await body(c.req.raw, z.object({ creditedUSDC: amount, receipt: z.string().trim().min(3).max(1000), valuationNote: z.string().trim().min(3).max(400), routeClosed: z.literal(true), reviewConfirmed: z.literal(true) })))));
partialSettlementRoutes.post("/payments/:id/remainder", async c => c.json(await createRemainder(c.get("access"), c.req.param("id"), await body(c.req.raw, z.object({ reviewToken: digest, maxFee: z.string().regex(/^(0|[1-9]\d*)$/).max(31) }))), 201));
partialSettlementRoutes.post("/payments/:id/approve", async c => c.json(approveRemainder(c.get("access"), c.req.param("id"), (await body(c.req.raw, z.object({ reviewToken: digest }))).reviewToken)));

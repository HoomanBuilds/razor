import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { fundingRefundService, listFundingRefunds } from "./service";
import { fundingRefundExport } from "./export";

const hash = z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9:_-]+$/);
export const fundingRefundRoutes = new Hono<AppEnv>();
fundingRefundRoutes.get("/", c => c.json(listFundingRefunds(c.get("access"))));
fundingRefundRoutes.get("/export", c => { c.header("Content-Type", "text/csv; charset=utf-8"); c.header("Content-Disposition", 'attachment; filename="razor-source-refunds.csv"'); c.header("Cache-Control", "no-store"); return c.body(fundingRefundExport(c.get("access"))); });
fundingRefundRoutes.post("/:id/prepare", async c => c.json(await fundingRefundService.prepare(c.get("access"), c.req.param("id"), z.object({ transactionHash: hash, sourceTransactionHash: hash.optional(), senderAccountId: z.string().min(2).max(64).optional() }).parse(await c.req.json()))));
fundingRefundRoutes.post("/:id/confirm", async c => c.json(await fundingRefundService.confirm(c.get("access"), c.req.param("id"), z.object({ reviewId: z.string().uuid(), reviewToken: z.string().regex(/^[a-f0-9]{64}$/), acknowledged: z.literal(true), evidence: z.string().trim().min(12).max(2000).optional() }).parse(await c.req.json()))));

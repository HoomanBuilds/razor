import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import * as service from "./service";

export const vendorCommitmentRoutes = new Hono<AppEnv>();
vendorCommitmentRoutes.get("/", c => c.json({ commitments: service.listCommitments(c.get("access"), z.string().max(120).parse(c.req.query("search") ?? "")) }));
vendorCommitmentRoutes.get("/export", c => {
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="razor-purchase-commitments.csv"');
  return c.body(service.commitmentExport(c.get("access")));
});
vendorCommitmentRoutes.post("/", async c => c.json({ commitment: service.createCommitment(c.get("access"), service.commitmentInput.parse(await c.req.json())) }, 201));
vendorCommitmentRoutes.get("/:id", c => c.json({ commitment: service.reviewCommitment(c.get("access"), c.req.param("id")) }));
vendorCommitmentRoutes.post("/:id/amend", async c => {
  const { expectedVersion, ...input } = service.commitmentInput.extend({ expectedVersion: z.number().int().nonnegative() }).parse(await c.req.json());
  return c.json({ commitment: service.amendCommitment(c.get("access"), c.req.param("id"), expectedVersion, input) }, 201);
});
vendorCommitmentRoutes.post("/:id/withdraw", async c => {
  const input = z.object({ pendingVersion: z.number().int().positive(), reason: z.string().trim().min(3).max(3000) }).parse(await c.req.json());
  return c.json({ commitment: service.withdrawCommitmentProposal(c.get("access"), c.req.param("id"), input.pendingVersion, input.reason) });
});
vendorCommitmentRoutes.post("/:id/approve", async c => c.json({ commitment: service.approveCommitment(c.get("access"), c.req.param("id"), z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await c.req.json()).reviewToken) }));
vendorCommitmentRoutes.post("/match/:billId", async c => c.json({ match: service.matchBillCommitment(c.get("access"), c.req.param("billId"), z.object({ ...service.billCommitmentFields, reason: z.string().trim().min(3).max(3000) }).strict().parse(await c.req.json())) }));

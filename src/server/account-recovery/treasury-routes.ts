import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireFreshSession, requireOrganization, requireUser } from "../identity/session";
import { authorizeRecoveryRequest, prepareApprovalInvalidation, prepareExecutorRevocation, prepareOwnershipTransfer, prepareRecoveryPause, reconcileRecoveryRequest, recoveryRequestReview, treasuryRecoveryStatus } from "./treasury";

const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const treasuryRecoveryRoutes=new Hono<AppEnv>();
treasuryRecoveryRoutes.use("*",requireUser,requireOrganization("company:manage"));
treasuryRecoveryRoutes.get("/status",async c=>c.json(await treasuryRecoveryStatus(c.get("access"))));
treasuryRecoveryRoutes.get("/requests/:id",c=>c.json(recoveryRequestReview(c.get("access"),c.req.param("id"))));
treasuryRecoveryRoutes.post("/pause",async c=>{requireFreshSession(c);return c.json(await prepareRecoveryPause(c.get("access")));});
treasuryRecoveryRoutes.post("/approvals/invalidate",async c=>{requireFreshSession(c);return c.json(await prepareApprovalInvalidation(c.get("access")));});
treasuryRecoveryRoutes.post("/ownership",async c=>{
  requireFreshSession(c);const input=z.object({newOwnerWalletId:z.string().uuid()}).parse(await c.req.json());
  return c.json(await prepareOwnershipTransfer(c.get("access"),input.newOwnerWalletId));
});
treasuryRecoveryRoutes.post("/executors/revoke",async c=>{
  requireFreshSession(c);const input=z.object({accountId:z.string().min(2).max(64)}).parse(await c.req.json());
  return c.json(await prepareExecutorRevocation(c.get("access"),input.accountId));
});
treasuryRecoveryRoutes.post("/requests/:id/authorize",async c=>{
  requireFreshSession(c);const input=z.object({termsHash:Hash,reviewConfirmed:z.literal(true)}).parse(await c.req.json());
  return c.json(await authorizeRecoveryRequest(c.get("access"),c.req.param("id"),input.termsHash));
});
treasuryRecoveryRoutes.post("/requests/:id/reconcile",async c=>{
  requireFreshSession(c);const input=z.object({termsHash:Hash,transactionHash:z.string().max(160).optional()}).parse(await c.req.json());
  return c.json(await reconcileRecoveryRequest(c.get("access"),c.req.param("id"),input.termsHash,input.transactionHash));
});

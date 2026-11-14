import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv } from "../context";
import { requireUser } from "../identity/session";
import * as service from "./service";

const begin = z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/), signerAccount: z.string().min(2).max(64) }).strict();
const reported = z.object({ transactionHash: z.string().min(32).max(64) }).strict();
const claimBegin = begin.extend({ reviewGeneration: z.string().uuid(), retrySameClaim: z.boolean().optional() });
const generation = z.object({ reviewGeneration: z.string().uuid() }).strict();
export const distributionRoutes = new Hono<AppEnv>();
distributionRoutes.get("/", c => c.json(service.listDistributions(c.get("access"), c.req.query())));
distributionRoutes.post("/", async c => c.json({ distribution: service.createDistribution(c.get("access"), await c.req.json()) }, 201));
distributionRoutes.delete("/:id", c => c.json(service.discardDistribution(c.get("access"), c.req.param("id"))));
distributionRoutes.post("/:id/release-review", async c => c.json(await service.releaseUnsignedDistribution(c.get("access"), c.req.param("id"))));
distributionRoutes.get("/:id", async c => c.json({ distribution: await service.inspectDistribution(c.get("access"), c.req.param("id")) }));
distributionRoutes.post("/:id/prepare", async c => c.json(await service.prepareDistribution(c.get("access"), c.req.param("id"))));
distributionRoutes.post("/:id/begin", async c => c.json(await service.beginDistribution(c.get("access"), c.req.param("id"), begin.parse(await c.req.json()))));
distributionRoutes.post("/:id/receipt", async c => c.json(service.recordDistributionWalletReference(c.get("access"), c.req.param("id"), reported.parse(await c.req.json()).transactionHash)));
distributionRoutes.post("/:id/control", async c => {
  const input = z.object({ action: z.enum(["approve", "void", "reclaim"]), accountId: z.string().min(2).max(64).optional() }).strict().parse(await c.req.json());
  return c.json(await service.prepareDistributionControl(c.get("access"), c.req.param("id"), input.action, input.accountId));
});

export const recipientDistributionRoutes = new Hono<AppEnv>();
recipientDistributionRoutes.use("*", requireUser);
recipientDistributionRoutes.get("/", c => c.json(service.ownDistributionClaims(c.get("userId"), c.req.query())));
recipientDistributionRoutes.get("/:id", async c => c.json(await service.inspectOwnClaim(c.get("userId"), c.req.param("id"))));
recipientDistributionRoutes.post("/:id/prepare", async c => c.json(await service.prepareOwnClaim(c.get("userId"), c.req.param("id"))));
recipientDistributionRoutes.post("/:id/begin", async c => c.json(await service.beginOwnClaim(c.get("userId"), c.req.param("id"), claimBegin.parse(await c.req.json()))));
recipientDistributionRoutes.post("/:id/finish-wallet", async c => c.json(service.finishOwnClaimWallet(c.get("userId"), c.req.param("id"), generation.parse(await c.req.json()).reviewGeneration)));
recipientDistributionRoutes.post("/:id/receipt", async c => {
  const input = reported.extend({ reviewGeneration: z.string().uuid() }).parse(await c.req.json());
  return c.json(service.recordOwnClaimWalletReference(c.get("userId"), c.req.param("id"), input.transactionHash, input.reviewGeneration));
});

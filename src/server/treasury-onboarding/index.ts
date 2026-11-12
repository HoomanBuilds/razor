import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireOrganization, requireUser } from "../identity";
import { creationInput, getOnboardingConfig, prepareCreationRefund, prepareTreasury, quoteTreasury, reconcileTreasury, recoveryInput } from "./service";

export const onboardingRoutes=new Hono<AppEnv>();
onboardingRoutes.use("*",requireUser,requireOrganization("company:manage"));
onboardingRoutes.get("/config",async(c)=>c.json(await getOnboardingConfig(c.get("access"))));
onboardingRoutes.post("/quote",async(c)=>c.json(await quoteTreasury(c.get("access"),creationInput.parse(await c.req.json()))));
onboardingRoutes.post("/prepare",async(c)=>{
  const input=creationInput.safeExtend({quoteHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(await c.req.json());
  return c.json(await prepareTreasury(c.get("access"),input,input.quoteHash));
});
onboardingRoutes.post("/reconcile",async(c)=>c.json(await reconcileTreasury(c.get("access"),recoveryInput.parse(await c.req.json()))));
onboardingRoutes.post("/refund",async(c)=>c.json(await prepareCreationRefund(c.get("access"),recoveryInput.parse(await c.req.json()))));

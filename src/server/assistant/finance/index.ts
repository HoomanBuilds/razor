import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { planningInput } from "./plans";
import { deleteFinancePlan, financeInsights, financePlanEvidence, listFinancePlans, prepareFinancePlan, proposeFinancePlan } from "./service";

export const financeRoutes=new Hono<AppEnv>();
financeRoutes.get("/insights",c=>c.json(financeInsights(c.get("access"))));
financeRoutes.get("/plans",c=>c.json({plans:listFinancePlans(c.get("access"))}));
financeRoutes.get("/plans/:id/evidence",c=>{
  const evidence=financePlanEvidence(c.get("access"),c.req.param("id"));
  c.header("Cache-Control","no-store");
  if(c.req.query("download")==="1")c.header("Content-Disposition",'attachment; filename="razor-finance-proposal.json"');
  return c.json(evidence);
});
financeRoutes.post("/plan",async c=>c.json(await proposeFinancePlan(c.get("access"),planningInput.parse(await c.req.json()))));
financeRoutes.post("/plans/:id/prepare",async c=>{
  const input=z.object({planHash:z.string().regex(/^[a-f0-9]{64}$/),reviewConfirmed:z.literal(true)}).parse(await c.req.json());
  return c.json(prepareFinancePlan(c.get("access"),c.req.param("id"),input.planHash));
});
financeRoutes.delete("/plans/:id",c=>c.json(deleteFinancePlan(c.get("access"),c.req.param("id"))));

export { purgeFinancePlans } from "./service";

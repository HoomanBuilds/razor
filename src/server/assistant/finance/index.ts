import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { planningInput } from "./plans";
import { deleteFinancePlan, exportFinancePacket, financeInsights, financePlanEvidence, financePlanHistory, prepareFinancePlan, proposeFinancePlan } from "./service";
import { packetDisclosure } from "../packet";

export const financeRoutes=new Hono<AppEnv>();
financeRoutes.get("/insights",c=>c.json(financeInsights(c.get("access"))));
financeRoutes.get("/plans",c=>c.json(financePlanHistory(c.get("access"),c.req.query())));
financeRoutes.get("/plans/:id/evidence",c=>{
  const evidence=financePlanEvidence(c.get("access"),c.req.param("id"));
  c.header("Cache-Control","no-store");
  if(c.req.query("download")==="1")c.header("Content-Disposition",'attachment; filename="razor-finance-proposal.json"');
  return c.json(evidence);
});
financeRoutes.get("/plans/:id/packet", c => {
  const { disclosure } = packetDisclosure.parse(c.req.query());
  const packet = exportFinancePacket(c.get("access"), c.req.param("id"), disclosure);
  c.header("Cache-Control", "private, no-store");
  c.header("Content-Disposition", 'attachment; filename="razor-finance-evidence-v1.json"');
  return c.json(packet);
});
financeRoutes.post("/plan",async c=>c.json(await proposeFinancePlan(c.get("access"),planningInput.parse(await c.req.json()))));
financeRoutes.post("/plans/:id/prepare",async c=>{
  const input=z.object({planHash:z.string().regex(/^[a-f0-9]{64}$/),reviewConfirmed:z.literal(true)}).parse(await c.req.json());
  return c.json(prepareFinancePlan(c.get("access"),c.req.param("id"),input.planHash));
});
financeRoutes.delete("/plans/:id",c=>c.json(deleteFinancePlan(c.get("access"),c.req.param("id"))));

export { purgeFinancePlans } from "./service";

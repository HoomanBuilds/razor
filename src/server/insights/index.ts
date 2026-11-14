import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../context";
import { companyInsights, companyInsightsCsv, compareCompanyCosts } from "./service";

export const insightsRoutes = new Hono<AppEnv>();
insightsRoutes.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); c.header("Referrer-Policy", "no-referrer"); await next(); });
insightsRoutes.get("/", c => c.json(companyInsights(c.get("access"), c.req.query())));
insightsRoutes.get("/export", c => { c.header("Content-Type", "text/csv; charset=utf-8"); c.header("Content-Disposition", 'attachment; filename="razor-company-insights.csv"'); return c.body(companyInsightsCsv(c.get("access"), c.req.query())); });
insightsRoutes.post("/compare", bodyLimit({ maxSize: 8192 }), async c => c.json(compareCompanyCosts(c.get("access"), await c.req.json())));
export { companyInsights, companyInsightsCsv, compareCompanyCosts } from "./service";
export type { CompanyInsights, CompanyCostComparison } from "./service";

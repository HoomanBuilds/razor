import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { classifyProjectFunding, projectExport, projectReports } from "./service";

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.get("/", c => c.json(projectReports(c.get("access"))));
projectRoutes.post("/classifications", async c => c.json(classifyProjectFunding(c.get("access"), z.object({ fundingId: z.string().min(1), projectReference: z.string().trim().min(1).max(120), costCenterReference: z.string().trim().max(120).optional(), classification: z.enum(["earned_revenue", "client_deposit", "internal_transfer"]), evidence: z.string().trim().min(3).max(2000), expectedVersion: z.number().int().nonnegative() }).parse(await c.req.json()))));
projectRoutes.get("/export", c => { c.header("Content-Type", "text/csv; charset=utf-8"); c.header("Content-Disposition", 'attachment; filename="razor-projects.csv"'); c.header("Cache-Control", "no-store"); return c.body(projectExport(c.get("access"))); });

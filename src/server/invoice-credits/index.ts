import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../context";
import { requireUser } from "../identity/session";
import * as service from "./service";
function router(){const app=new Hono<AppEnv>();app.use("*",async(c,next)=>{c.header("Cache-Control","private, no-store");await next();});app.use("*",requireUser);app.use("*",bodyLimit({maxSize:16384,onError:c=>c.json({error:"Use a credit note request below 16 KB",code:"CREDIT_REQUEST_TOO_LARGE"},413)}));return app;}
export const supplierCreditRoutes=router();
supplierCreditRoutes.get("/bills",c=>c.json(service.supplierBills(c.get("userId"),c.req.query())));
supplierCreditRoutes.get("/",c=>c.json(service.supplierCredits(c.get("userId"),c.req.query())));
supplierCreditRoutes.post("/",async c=>c.json(service.issueCredit(c.get("userId"),await c.req.json())));
supplierCreditRoutes.get("/:id",c=>c.json(service.supplierCredit(c.get("userId"),c.req.param("id"))));
supplierCreditRoutes.post("/:id/revisions",async c=>c.json(service.reviseCredit(c.get("userId"),c.req.param("id"),await c.req.json())));
supplierCreditRoutes.post("/:id/withdraw",async c=>c.json(service.withdrawCredit(c.get("userId"),c.req.param("id"),await c.req.json())));
export const companyCreditRoutes=router();
companyCreditRoutes.get("/",c=>c.json(service.companyCredits(c.get("userId"),c.req.param("orgId")!,c.req.query())));
companyCreditRoutes.get("/:id/review",c=>c.json(service.reviewCredit(c.get("userId"),c.req.param("orgId")!,c.req.param("id"))));
companyCreditRoutes.get("/:id",c=>c.json(service.companyCredit(c.get("userId"),c.req.param("orgId")!,c.req.param("id"))));
companyCreditRoutes.post("/:id/accept",async c=>c.json(service.acceptCredit(c.get("userId"),c.req.param("orgId")!,c.req.param("id"),await c.req.json())));
companyCreditRoutes.post("/:id/reject",async c=>c.json(service.rejectCredit(c.get("userId"),c.req.param("orgId")!,c.req.param("id"),await c.req.json())));

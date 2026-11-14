import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../context";
import { requireUser } from "../identity/session";
import * as service from "./service";

export const supportRoutes=new Hono<AppEnv>();
supportRoutes.use("*",async(c,next)=>{c.header("Cache-Control","private, no-store");c.header("Referrer-Policy","no-referrer");await next();});
supportRoutes.use("*",requireUser);
supportRoutes.use("*",bodyLimit({maxSize:32768,onError:c=>c.json({error:"Use plain support text in a request up to 32 KB; attachments are unsupported",code:"SUPPORT_REQUEST_TOO_LARGE"},413)}));
supportRoutes.get("/",c=>c.json(service.listSupportCases(c.get("userId"),c.req.query())));
supportRoutes.post("/",async c=>{const result=service.createSupportCase(c.get("userId"),await c.req.json());return c.json(result,result.created?201:200);});
supportRoutes.get("/:id",c=>c.json(service.inspectSupportCase(c.get("userId"),c.req.param("id"),c.req.query())));
supportRoutes.post("/:id/replies",async c=>c.json(service.replySupportCase(c.get("userId"),c.req.param("id"),await c.req.json())));
supportRoutes.patch("/:id/status",async c=>c.json(service.updateSupportCase(c.get("userId"),c.req.param("id"),await c.req.json())));
supportRoutes.delete("/:id",async c=>c.json(service.deleteSupportCase(c.get("userId"),c.req.param("id"),await c.req.json())));
export { expireSupportCases } from "./service";

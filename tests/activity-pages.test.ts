import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { getDb, transaction } from "../src/server/db";
import { ApiError, type AppEnv } from "../src/server/context";
import { businessRoutes } from "../src/server/business/routes";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="24".repeat(32);

test("company activity pages expose older events only with reporting access in the same company",async()=>{
  const id=randomUUID(),other=randomUUID(),now=new Date().toISOString(),db=getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id,now);
  for(const org of [id,other])db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(org,id,now,now);
  transaction(()=>{for(let index=0;index<225;index++)db.prepare("INSERT INTO activity(id,organization_id,actor_id,action,entity_id,created_at) VALUES(?,?,?,'payment.reviewed',?,?)").run(randomUUID(),id,id,`record-${index}`,now);});
  db.prepare("INSERT INTO activity(id,organization_id,actor_id,action,entity_id,created_at) VALUES(?,?,?,'private.other','other-company',?)").run(randomUUID(),other,id,now);
  const app=new Hono<AppEnv>();
  app.use("*",async(c,next)=>{c.set("access",{userId:id,organizationId:id,permissions:c.req.header("X-Role")==="reader"?["company:read"]:["company:read","reports:read"]});await next();});
  app.route("/",businessRoutes);
  app.onError((error,c)=>error instanceof ApiError?c.json({error:error.message},error.status as 403):c.json({error:"Failure"},500));
  const response=await app.request("http://localhost/activity?page=5&pageSize=50"),page=await response.json();
  assert.equal(response.status,200);assert.equal(page.total,225);assert.equal(page.activity.length,25);assert.equal(page.hasMore,false);
  assert(page.activity.every((item:{organization_id:string})=>item.organization_id===id));
  assert.equal((await app.request("http://localhost/activity",{headers:{"X-Role":"reader"}})).status,403);
});

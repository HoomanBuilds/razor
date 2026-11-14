import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { getDb } from "../src/server/db";
import { ApiError, type AppEnv } from "../src/server/context";
import { authRoutes } from "../src/server/identity/auth";
import { accountRecoveryRoutes } from "../src/server/account-recovery";
import { issueSession } from "../src/server/identity/session";

process.env.DATABASE_PATH=":memory:";
process.env.DATA_ENCRYPTION_KEY="93".repeat(32);
process.env.APP_URL="http://localhost:3000";
const app=new Hono<AppEnv>().route("/auth",authRoutes).route("/account",accountRecoveryRoutes);
app.onError((error,c)=>{if(error instanceof ApiError)return c.json({code:error.code},error.status as 400);throw error;});
app.get("/fixture/sign-in/:id",c=>{issueSession(c,c.req.param("id"),"privy:fixture");return c.json({signedIn:true});});

async function signIn() {
  const user=randomUUID(),at=new Date().toISOString();
  getDb().prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(user,"Navigation fixture",at);
  const response=await app.request(`http://localhost:3000/fixture/sign-in/${user}`),header=response.headers.get("set-cookie")!;
  assert.match(header,/HttpOnly/i);assert.match(header,/SameSite=Strict/i);assert.match(header,/Path=\//i);
  return {user,cookie:header.split(";")[0]};
}
function request(path:string,cookie:string,method="GET") {
  return app.request(`http://localhost:3000${path}`,{method,headers:{Cookie:cookie,Origin:"http://localhost:3000","Content-Type":"application/json"},...(method==="GET"?{}:{body:"{}"})});
}

test("opening profile and wallet recovery preserves a valid issued session",async()=>{
  const {user,cookie}=await signIn();
  for(const path of ["/auth/session","/account/status","/account/embedded-near","/auth/session"]){const response=await request(path,cookie);assert.equal(response.status,200,path);assert.equal(response.headers.get("set-cookie"),null);}
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=?").get(user)?.count,1);
});

test("security verification expiry does not log out an otherwise valid account",async()=>{
  const {user,cookie}=await signIn();
  getDb().prepare("UPDATE sessions SET created_at=? WHERE user_id=?").run(new Date(Date.now()-20*60000).toISOString(),user);
  const status=await request("/account/status",cookie);assert.equal(status.status,200);assert.equal((await status.json()).freshSignIn,false);
  const protectedAction=await request("/account/sessions/revoke-others",cookie,"POST");assert.equal(protectedAction.status,403);assert.equal((await protectedAction.json()).code,"FRESH_SIGN_IN_REQUIRED");
  assert.equal((await request("/auth/session",cookie)).status,200);
  getDb().prepare("UPDATE sessions SET expires_at=? WHERE user_id=?").run(new Date(Date.now()-1).toISOString(),user);
  assert.equal((await request("/auth/session",cookie)).status,401);
  assert.equal((await request("/account/status",cookie)).status,401);
});

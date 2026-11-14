import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { decrypt, encrypt, hashToken, newToken } from "../src/server/identity/crypto";
import { createAccountingOAuthRoutes, accountingRoutes } from "../src/server/accounting";
import { createBill, approveBill } from "../src/server/business/service";
import { functionalAmount, type Connection, type Job } from "../src/server/accounting/model";
import { providerConfig, type AccountingTransport, type TransportRequest } from "../src/server/accounting/providers";
import { accountingOverview, beginAccountingConnection, finishAccountingConnection, selectAccountingEntity, refreshAccountingCatalog, saveAccountingMapping, createAccountingPlan, approveAccountingPlan, dispatchAccountingJobs, reconcileAccountingJob, retryAccountingPreflight, disconnectAccounting } from "../src/server/accounting/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "a4".repeat(32);
process.env.APP_URL = "http://localhost:3000";
process.env.QUICKBOOKS_CLIENT_ID = "public-client";
process.env.QUICKBOOKS_CLIENT_SECRET = "private-client-secret";
process.env.QUICKBOOKS_ENVIRONMENT = "sandbox";
process.env.XERO_CLIENT_ID = "public-xero";
process.env.XERO_CLIENT_SECRET = "private-xero-secret";
const permissions = ["company:read", "company:manage", "payments:read", "payments:prepare", "payments:approve", "reports:read", "documents:manage", "recipients:read"];
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
function fixture() {
 const id = randomUUID(), recipientId = randomUUID(), sessionId = randomUUID(), sessionToken = newToken(), browserNonce = newToken(), at = new Date().toISOString(), db = getDb();
 db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Finance manager", at);
 db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Books company", id, at, at);
 db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?,?,1,?)").run(id, id, "Owner", JSON.stringify(permissions), at);
 db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id, id, id, at);
 db.prepare("INSERT INTO sessions(id,user_id,organization_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(sessionId,id,id,hashToken(sessionToken),at,new Date(Date.now()+3600000).toISOString());
 db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'business','USDC','near','supplier.near','confirmed',?,?,?)").run(recipientId, id, id, encrypt("Original supplier"), at, at, at);
 return { access: { userId: id, organizationId: id, permissions } as AccessContext, recipientId, sessionId, sessionToken, browserNonce };
}
function provider() {
 const calls: TransportRequest[] = [], bills = new Map<string, Record<string, unknown>>(), settlements = new Map<string, Record<string, unknown>>();
 let loseWrite = false, refresh = 0;
 const transport: AccountingTransport = async request => {
  calls.push(request); const url = new URL(request.url), path = url.pathname;
  if (path.endsWith("/tokens/bearer")) { refresh++; return { status: 200, body: { access_token: `access-secret-${refresh}`, refresh_token: `refresh-secret-${refresh}`, expires_in: 3600, token_type: "Bearer" } }; }
  if (path.endsWith("/tokens/revoke")) return { status: 200, body: null };
  if (path.includes("/companyinfo/")) return { status: 200, body: { CompanyInfo: { Id: "1", CompanyName: "Verified legal company" } } };
  if (path.endsWith("/preferences")) return { status: 200, body: { Preferences: { CurrencyPrefs: { HomeCurrency: { value: "USD" } } } } };
  if (path.endsWith("/query")) {
   const query = url.searchParams.get("query")!;
   if (query.includes("FROM Account")) return { status: 200, body: { QueryResponse: { Account: [{ Id: "expense", Name: "Operations expense", AccountType: "Expense", Active: true }, { Id: "bank", Name: "USDC clearing books", AccountType: "Bank", CurrencyRef: { value: "USD" }, Active: true }] } } };
   if (query.includes("FROM TaxCode")) return { status: 200, body: { QueryResponse: { TaxCode: [{ Id: "zero", Name: "Exempt", Taxable: false, Active: true }] } } };
   if (query.includes("FROM Vendor")) return { status: 200, body: { QueryResponse: { Vendor: [{ Id: "vendor", DisplayName: "Matched vendor", Active: true }] } } };
   const marker = query.match(/DocNumber = '([^']+)'/)?.[1], payment = query.includes("FROM BillPayment"), map = payment ? settlements : bills;
   return { status: 200, body: { QueryResponse: { [payment ? "BillPayment" : "Bill"]: marker && map.has(marker) ? [map.get(marker)] : [] } } };
  }
  if (path.includes("/taxcode/")) return { status: 200, body: { TaxCode: { Id: "zero", Taxable: false, Active: true } } };
  if (path.includes("/vendor/")) return { status: 200, body: { Vendor: { Id: "vendor", Active: true } } };
  if (path.includes("/account/")) return { status: 200, body: { Account: path.endsWith("/bank") ? { Id: "bank", AccountType: "Bank", Active: true, CurrencyRef: { value: "USD" } } : { Id: "expense", AccountType: "Expense", Active: true } } };
  if (request.method === "GET" && path.includes("/bill/")) return { status: 200, body: { Bill: { ...[...bills.values()].find(item => item.Id === path.split("/").at(-1)), Balance: 1000 } } };
  if (request.method === "POST" && (path.endsWith("/bill") || path.endsWith("/billpayment"))) {
   const body = JSON.parse(request.body!) as Record<string, unknown>, payment = path.endsWith("billpayment"), map = payment ? settlements : bills;
   const item = { ...body, Id: `external-${map.size + 1}`, SyncToken: "0", TotalAmt: body.TotalAmt ?? (body.Line as { Amount: number }[])[0].Amount };
   map.set(String(body.DocNumber), item);
   if (loseWrite) { loseWrite = false; throw new Error("lost-response-containing-a-private-token"); }
   return { status: 200, body: { [payment ? "BillPayment" : "Bill"]: item } };
  }
  throw new Error(`Unexpected mock provider path ${path}`);
 };
 return { transport, calls, bills, settlements, loseNextWrite: () => { loseWrite = true; } };
}
async function connected() {
 const f = fixture(), p = provider(), started = beginAccountingConnection(f.access, "quickbooks", f.browserNonce, f.sessionId), state = new URL(started.authorizationUrl).searchParams.get("state")!;
 await finishAccountingConnection("quickbooks", { state, code: "ephemeral-provider-code", realmId: "101" }, f.browserNonce, p.transport);
 await selectAccountingEntity(f.access, started.connectionId, "101", p.transport);
 await refreshAccountingCatalog(f.access, started.connectionId, 1, p.transport);
 const mapping = { expectedVersion: 0, expenseAccountId: "expense", bankAccountId: "bank", taxCodeId: "zero", contacts: [{ recipientId: f.recipientId, externalId: "vendor" }], fxNumerator: "1", fxDenominator: "1", fxSource: "Company finance approved nominal rate", fxDate: new Date().toISOString().slice(0, 10), closedThrough: null, acknowledgement: true as const };
 saveAccountingMapping(f.access, started.connectionId, mapping);
 const bill = createBill(f.access, { recipientId: f.recipientId, reference: randomUUID(), title: "Reviewed business invoice", amount: "20000000", maxFee: "0",dueDate:"2027-01-15T00:00:00.000Z" }); approveBill(f.access, bill.id);
 const plan = createAccountingPlan(f.access, started.connectionId, { kind: "bill", sourceId: bill.id, postingDate: new Date().toISOString().slice(0, 10) });
 return { ...f, ...p, connectionId: started.connectionId, mapping, bill, plan };
}
function approve(f: Awaited<ReturnType<typeof connected>>) { approveAccountingPlan(f.access, f.plan.job.id, f.plan.job.review_hash); }
const writes = (calls: TransportRequest[]) => calls.filter(item => item.method === "POST" && /\/bill(payment)?(?:\?|$)/.test(item.url));

test("exact manual FX never assumes a peg or rounds fractional cents", () => {
 assert.deepEqual(functionalAmount("20000000", "3", "2"), { text: "30.00", value: 30, cents: "3000" });
 for (const value of ["1.1", "-1", "", "1e3", "0"]) assert.throws(() => functionalAmount(value, "1", "1"));
 assert.throws(() => functionalAmount("12345678", "1", "1"), code("ACCOUNTING_PRECISION_REQUIRED"));
 assert.throws(() => functionalAmount("1000000000000000000000000000000", "999999999999999999", "1"), code("ACCOUNTING_AMOUNT_INVALID"));
});

test("OAuth state is one-use, actor/company scoped and secrets never appear in ordinary settings", async () => {
 const f = fixture(), other = fixture(), p = provider(), started = beginAccountingConnection(f.access, "quickbooks", f.browserNonce, f.sessionId), state = new URL(started.authorizationUrl).searchParams.get("state")!;
 assert.ok(!started.authorizationUrl.includes("private-client-secret"));
 assert.equal(row("SELECT state_hash FROM accounting_oauth_states WHERE state_hash=?", state), undefined);
 await finishAccountingConnection("quickbooks", { state, code: "authorization-code", realmId: "101" }, f.browserNonce, p.transport);
 await assert.rejects(() => finishAccountingConnection("quickbooks", { state, code: "replay", realmId: "101" }, f.browserNonce, p.transport), code("ACCOUNTING_STATE_INVALID"));
 const safe = JSON.stringify(accountingOverview(f.access)); assert.ok(!safe.includes("access-secret")); assert.ok(!safe.includes("refresh-secret"));
 assert.notEqual(row<Connection>("SELECT * FROM accounting_connections WHERE id=?", started.connectionId)!.token_ciphertext, "access-secret-1");
 await assert.rejects(() => selectAccountingEntity(other.access, started.connectionId, "101", p.transport), code("ACCOUNTING_NOT_FOUND"));
 await assert.rejects(() => selectAccountingEntity(f.access, started.connectionId, "999", p.transport), code("ACCOUNTING_ENTITY_INVALID"));
});

test("missing setup, stale consent and removed finance access fail without provider requests", async () => {
 const f = fixture(), p = provider(), secret = process.env.QUICKBOOKS_CLIENT_SECRET; delete process.env.QUICKBOOKS_CLIENT_SECRET;
 try { assert.throws(() => beginAccountingConnection(f.access, "quickbooks", f.browserNonce, f.sessionId), code("ACCOUNTING_SETUP_REQUIRED")); } finally { process.env.QUICKBOOKS_CLIENT_SECRET = secret; }
 const started = beginAccountingConnection(f.access, "quickbooks", f.browserNonce, f.sessionId), state = new URL(started.authorizationUrl).searchParams.get("state")!;
 getDb().prepare("UPDATE memberships SET status='removed' WHERE organization_id=?").run(f.access.organizationId);
 await assert.rejects(() => finishAccountingConnection("quickbooks", { state, code: "code", realmId: "101" }, f.browserNonce, p.transport)); assert.equal(p.calls.length, 0);
});

test("OAuth callback rejects a copied authorization URL in another browser before exchanging or storing a token", async () => {
 const f = fixture(), other = fixture(), p = provider(), started = beginAccountingConnection(f.access,"quickbooks",f.browserNonce,f.sessionId);
 const callback = {state:new URL(started.authorizationUrl).searchParams.get("state")!,code:"victim-provider-code",realmId:"101"};
 await assert.rejects(()=>finishAccountingConnection("quickbooks",callback,undefined,p.transport),code("ACCOUNTING_BROWSER_REQUIRED"));
 await assert.rejects(()=>finishAccountingConnection("quickbooks",callback,other.browserNonce,p.transport),code("ACCOUNTING_STATE_INVALID"));
 assert.equal(p.calls.length,0); assert.equal(row<Connection>("SELECT * FROM accounting_connections WHERE id=?",started.connectionId)!.token_ciphertext,null);
 assert.equal(row<{consumed_at:string|null}>("SELECT consumed_at FROM accounting_oauth_states WHERE state_hash=?",hashToken(callback.state))!.consumed_at,null);
 await finishAccountingConnection("quickbooks",callback,f.browserNonce,p.transport);
 assert.ok(row<Connection>("SELECT * FROM accounting_connections WHERE id=?",started.connectionId)!.token_ciphertext);
});

test("OAuth callback requires its original live session even when a shared browser retains its nonce", async () => {
 const f = fixture(), p = provider(), started = beginAccountingConnection(f.access,"quickbooks",f.browserNonce,f.sessionId);
 getDb().prepare("DELETE FROM sessions WHERE id=?").run(f.sessionId); fixture();
 await assert.rejects(()=>finishAccountingConnection("quickbooks",{state:new URL(started.authorizationUrl).searchParams.get("state")!,code:"new-browser-user-provider-code",realmId:"101"},f.browserNonce,p.transport),code("ACCOUNTING_SESSION_EXPIRED"));
 assert.equal(p.calls.length,0); assert.equal(row<Connection>("SELECT * FROM accounting_connections WHERE id=?",started.connectionId)!.token_ciphertext,null);
 assert.throws(()=>beginAccountingConnection(f.access,"quickbooks",f.browserNonce,f.sessionId),code("ACCOUNTING_SESSION_EXPIRED"));
});

test("the actual OAuth routes bind a secure Lax cookie and accept a top-level provider return without a Strict session cookie", async () => {
 const f = fixture(), p = provider(), appOrigin = process.env.APP_URL; process.env.APP_URL = "https://razor.example";
 try {
  const app = new Hono<AppEnv>();
  app.onError((error,c)=>error instanceof ApiError?c.json({code:error.code},error.status as 400):c.json({code:"INTERNAL_ERROR"},500));
  app.use("/company/*",async(c,next)=>{c.set("access",f.access);await next();});
  app.route("/company/accounting",accountingRoutes); app.route("/api/accounting-oauth",createAccountingOAuthRoutes(p.transport));
  const start = await app.request("https://razor.example/company/accounting/connect/quickbooks",{method:"POST",headers:{cookie:`razor_session=${f.sessionToken}`,origin:"https://razor.example"}});
  assert.equal(start.status,200); const payload = await start.json() as {authorizationUrl:string;connectionId:string}, cookie = start.headers.get("set-cookie")!;
  for (const flag of ["__Host-razor_accounting_oauth_quickbooks=","HttpOnly","Secure","SameSite=Lax","Path=/","Max-Age=600"]) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes("Domain=")); const cookiePair = cookie.split(";")[0]; assert.ok(!JSON.stringify(payload).includes(cookiePair.split("=")[1]));
  const callback = `https://razor.example/api/accounting-oauth/quickbooks/callback?${new URLSearchParams({state:new URL(payload.authorizationUrl).searchParams.get("state")!,code:"provider-code",realmId:"101"})}`;
  const copied = await app.request(callback,{headers:{"sec-fetch-site":"cross-site","sec-fetch-mode":"navigate"}});
  assert.equal(copied.status,409); assert.equal(p.calls.length,0);
  const completed = await app.request(callback,{headers:{cookie:cookiePair,"sec-fetch-site":"cross-site","sec-fetch-mode":"navigate"}});
  assert.equal(completed.status,303); assert.ok(completed.headers.get("set-cookie")!.includes("Max-Age=0"));
  assert.equal(row<Connection>("SELECT * FROM accounting_connections WHERE id=?",payload.connectionId)!.status,"select_entity");
 } finally { process.env.APP_URL = appOrigin; }
});

test("catalog-backed mappings require exact company contacts, active accounts and zero tax", async () => {
 const f = await connected();
 assert.throws(() => saveAccountingMapping(f.access, f.connectionId, { ...f.mapping, expectedVersion: 1, contacts: [{ recipientId: fixture().recipientId, externalId: "vendor" }] }), code("ACCOUNTING_MAPPING_INVALID"));
 assert.throws(() => saveAccountingMapping(f.access, f.connectionId, { ...f.mapping, expectedVersion: 0 }), code("ACCOUNTING_MAPPING_CHANGED"));
 assert.equal(writes(f.calls).length, 0);
 assert.equal(f.plan.posting.bankSettlementClaimed, false);
 assert.ok(JSON.stringify(f.plan.posting).includes("microUSDC"));
});

test("invoice maturity is distinct from posting date and preserves future, past-due and company-timezone dates", async () => {
 const f = await connected(), input = {kind:"bill",sourceId:f.bill.id,postingDate:new Date().toISOString().slice(0,10)};
 assert.equal((f.plan.posting.payload as {DueDate:string}).DueDate,"2027-01-15");
 assert.equal(f.plan.posting.source.dueDate,"2027-01-15"); assert.equal(f.plan.posting.source.sourceDueAt,"2027-01-15T00:00:00.000Z");
 getDb().prepare("UPDATE organizations SET timezone='America/Los_Angeles' WHERE id=?").run(f.access.organizationId);
 getDb().prepare("UPDATE bills SET due_date='2027-01-15T00:30:00.000Z' WHERE id=?").run(f.bill.id);
 const boundary = createAccountingPlan(f.access,f.connectionId,input);
 assert.equal((boundary.posting.payload as {DueDate:string}).DueDate,"2027-01-14"); assert.equal(boundary.posting.source.companyTimezone,"America/Los_Angeles");
 assert.throws(()=>createAccountingPlan(f.access,f.connectionId,{...input,dueDate:"2027-01-15"}),code("ACCOUNTING_DUE_DATE_CHANGED"));
 getDb().prepare("UPDATE bills SET due_date='2020-01-02T00:30:00.000Z' WHERE id=?").run(f.bill.id);
 const overdue = createAccountingPlan(f.access,f.connectionId,input);
 assert.equal((overdue.posting.payload as {DueDate:string}).DueDate,"2020-01-01"); assert.equal(writes(f.calls).length,0);
});

test("an unscheduled invoice needs an explicit reviewed provider maturity and changed dates invalidate approval", async () => {
 const f = await connected(), bill = createBill(f.access,{recipientId:f.recipientId,reference:randomUUID(),title:"Unscheduled invoice",amount:"20000000",maxFee:"0"}); approveBill(f.access,bill.id);
 const input = {kind:"bill",sourceId:bill.id,postingDate:new Date().toISOString().slice(0,10)};
 assert.throws(()=>createAccountingPlan(f.access,f.connectionId,input),code("ACCOUNTING_DUE_DATE_REQUIRED"));
 const first = createAccountingPlan(f.access,f.connectionId,{...input,dueDate:"2027-01-20"}), second = createAccountingPlan(f.access,f.connectionId,{...input,dueDate:"2027-01-21"});
 assert.notEqual(first.job.review_hash,second.job.review_hash); assert.equal(second.posting.source.sourceDueAt,null);
 assert.equal(row<{due_date:string|null}>("SELECT due_date FROM bills WHERE id=?",bill.id)!.due_date,null);
 assert.throws(()=>approveAccountingPlan(f.access,first.job.id,first.job.review_hash),code("ACCOUNTING_REVIEW_CHANGED"));
 assert.equal(writes(f.calls).length,0);
});

test("changed source and provider maturity dates are held without rewriting original bill terms", async () => {
 const f = await connected(); approve(f); getDb().prepare("UPDATE bills SET due_date='2027-01-16T00:00:00.000Z' WHERE id=?").run(f.bill.id);
 assert.equal((await dispatchAccountingJobs({organizationId:f.access.organizationId,transport:f.transport})).jobs[0].state,"held"); assert.equal(writes(f.calls).length,0);
 const next = await connected(); approve(next); await dispatchAccountingJobs({organizationId:next.access.organizationId,transport:next.transport});
 const invoice = [...next.bills.values()][0]; invoice.DueDate = "2027-01-16";
 assert.equal((await reconcileAccountingJob(next.access,next.plan.job.id,false,next.transport)).matched,false);
 assert.equal(row<{due_date:string}>("SELECT due_date FROM bills WHERE id=?",next.bill.id)!.due_date,"2027-01-15T00:00:00.000Z");
 assert.equal(writes(next.calls).length,1);
});

test("reviewed accounting writes are idempotent, scoped and do not mutate treasury cash", async () => {
 const f = await connected(), before = row("SELECT * FROM treasury_balances WHERE organization_id=?", f.access.organizationId);
 assert.equal((await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport })).processed, 0);
 approve(f);
 assert.deepEqual((await dispatchAccountingJobs({ organizationId: fixture().access.organizationId, transport: f.transport })).jobs, []);
 const result = await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport }); assert.equal(result.jobs[0].state, "done");
 await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport }); assert.equal(writes(f.calls).length, 1);
 assert.equal(new URL(writes(f.calls)[0].url).searchParams.get("requestid"), f.plan.job.id);
 assert.deepEqual(row("SELECT * FROM treasury_balances WHERE organization_id=?", f.access.organizationId), before);
});

test("unknown writes remain fenced beyond provider cache lifetime and reconcile without another POST", async () => {
 const f = await connected(); approve(f); f.loseNextWrite();
 assert.equal((await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport })).jobs[0].state, "unknown");
 getDb().prepare("UPDATE accounting_jobs SET write_started_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(f.plan.job.id);
 await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport }); assert.equal(writes(f.calls).length, 1);
 assert.throws(() => retryAccountingPreflight(f.access, f.plan.job.id), code("ACCOUNTING_REQUEST_HELD"));
 assert.equal((await reconcileAccountingJob(f.access, f.plan.job.id, false, f.transport)).matched, true); assert.equal(writes(f.calls).length, 1);
 assert.ok(!JSON.stringify(accountingOverview(f.access)).includes("private-token"));
});

test("two workers claim one immutable approved posting", async () => {
 const f = await connected(); approve(f);
 const results = await Promise.all([dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport }), dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport })]);
 assert.equal(results.reduce((total, result) => total + result.processed, 0), 1); assert.equal(writes(f.calls).length, 1);
});

test("changed source or revoked approver access blocks new writes", async () => {
 const f = await connected(); approve(f);
 getDb().prepare("UPDATE bills SET amount='21000000' WHERE id=?").run(f.bill.id);
 assert.equal((await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport })).jobs[0].state, "held"); assert.equal(writes(f.calls).length, 0);
 const next = await connected(); approve(next); getDb().prepare("UPDATE memberships SET status='removed' WHERE organization_id=?").run(next.access.organizationId);
 assert.equal((await dispatchAccountingJobs({ organizationId: next.access.organizationId, transport: next.transport })).jobs[0].state, "held"); assert.equal(writes(next.calls).length, 0);
});

test("external revisions become conflicts, never internal payments or balances", async () => {
 const f = await connected(); approve(f); await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport });
 const item = [...f.bills.values()][0]; item.TotalAmt = 25; item.SyncToken = "1";
 assert.equal((await reconcileAccountingJob(f.access, f.plan.job.id, false, f.transport)).matched, false);
 assert.equal(row<{ amount:string }>("SELECT amount FROM bills WHERE id=?", f.bill.id)!.amount, "20000000");
 assert.equal(row<Job>("SELECT * FROM accounting_jobs WHERE id=?", f.plan.job.id)!.state, "held");
 item.TotalAmt = 20;
 assert.equal((await reconcileAccountingJob(f.access, f.plan.job.id, true, f.transport)).matched, true);
});

test("recording a verified installment requires its reconciled original bill and preserves source amount", async () => {
 const f = await connected(); approve(f); await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport });
 const planInput = { kind: "settlement", sourceId: f.bill.payment_id!, postingDate: new Date().toISOString().slice(0, 10) };
 assert.throws(() => createAccountingPlan(f.access, f.connectionId, planInput), code("ACCOUNTING_SETTLEMENT_UNVERIFIED"));
 const at = new Date().toISOString(); getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(f.bill.payment_id!);
 getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,source_tx_hash,created_at,updated_at) VALUES(?,?,?,'primary','delivered','{}','USDC','near','supplier.near','20000000','20000000','supplier.near','fixture-final-source',?,?)").run(randomUUID(), f.bill.payment_id!, f.access.organizationId, at, at);
 const plan = createAccountingPlan(f.access, f.connectionId, planInput); approveAccountingPlan(f.access, plan.job.id, plan.job.review_hash);
 assert.equal((await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport })).jobs[0].state, "done");
 assert.equal(f.settlements.size, 1);
});

test("refresh rotates encrypted tokens and disconnect stops queued work before provider revocation", async () => {
 const f = await connected(); approve(f);
 getDb().prepare("UPDATE accounting_connections SET access_expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(f.connectionId);
 await refreshAccountingCatalog(f.access, f.connectionId, 1, f.transport);
 const tokens = JSON.parse(decrypt(row<Connection>("SELECT * FROM accounting_connections WHERE id=?", f.connectionId)!.token_ciphertext!)); assert.equal(tokens.refreshToken, "refresh-secret-2");
 const result = await disconnectAccounting(f.access, f.connectionId, f.transport); assert.equal(result.providerRevoked, true);
 await dispatchAccountingJobs({ organizationId: f.access.organizationId, transport: f.transport }); assert.equal(writes(f.calls).length, 0);
 assert.equal(row<Connection>("SELECT * FROM accounting_connections WHERE id=?", f.connectionId)!.token_ciphertext, null);
});

test("Xero uses granular scopes, verifies its tenant and never selects the first connection implicitly", async () => {
 const f = fixture(), started = beginAccountingConnection(f.access, "xero", f.browserNonce, f.sessionId), url = new URL(started.authorizationUrl), tenantId = randomUUID(), connectionId = randomUUID();
 assert.ok(url.searchParams.get("scope")!.includes("accounting.invoices")); assert.ok(!url.searchParams.get("scope")!.includes("accounting.transactions"));
 const transport: AccountingTransport = async request => {
  if (request.url.endsWith("/connect/token")) return { status:200,body:{access_token:"xero-access",refresh_token:"xero-refresh",expires_in:1800} };
  if (request.url.endsWith("/connections")) return {status:200,body:[{id:connectionId,tenantId,tenantName:"Chosen Xero company",tenantType:"ORGANISATION"}]};
  if (request.url.endsWith("/Organisation")) { assert.equal(request.headers["xero-tenant-id"],tenantId);return{status:200,body:{Organisations:[{OrganisationID:tenantId,Name:"Chosen Xero company",BaseCurrency:"GBP"}]}}; }
  throw new Error("Unexpected Xero request");
 };
 await finishAccountingConnection("xero",{state:url.searchParams.get("state")!,code:"xero-code"},f.browserNonce,transport);
 assert.equal(row<Connection>("SELECT * FROM accounting_connections WHERE id=?",started.connectionId)!.entity_id,null);
 await selectAccountingEntity(f.access,started.connectionId,tenantId,transport);assert.equal(row<Connection>("SELECT * FROM accounting_connections WHERE id=?",started.connectionId)!.currency,"GBP");
});

test("Xero posts an exact reviewed draft and fences its lost response with a read-only match", async () => {
 const f = fixture(), started = beginAccountingConnection(f.access, "xero", f.browserNonce, f.sessionId), tenant = randomUUID(), connection = randomUUID(), invoice = randomUUID();
 const calls:TransportRequest[] = []; let stored:Record<string, unknown>|null = null;
 const transport:AccountingTransport = async request => {
  calls.push(request); const url = new URL(request.url), path = url.pathname;
  if (path.endsWith("/connect/token")) return {status:200,body:{access_token:"xero-access",refresh_token:"xero-refresh",expires_in:1800}};
  if (path.endsWith("/connections")) return {status:200,body:[{id:connection,tenantId:tenant,tenantName:"Verified Xero company",tenantType:"ORGANISATION"}]};
  assert.equal(request.headers["xero-tenant-id"],tenant);
  if (path.endsWith("/Organisation")) return {status:200,body:{Organisations:[{OrganisationID:tenant,BaseCurrency:"GBP"}]}};
  const expense = {AccountID:"expense",Code:"400",Name:"Operations",Type:"EXPENSE",Status:"ACTIVE"}, bank = {AccountID:"bank",Code:"100",Name:"USDC clearing",Type:"BANK",CurrencyCode:"GBP",Status:"ACTIVE"};
  if (path.endsWith("/Accounts")) return {status:200,body:{Accounts:[expense,bank]}};
  if (path.endsWith("/Accounts/expense")) return {status:200,body:{Accounts:[expense]}};
  if (path.endsWith("/Accounts/bank")) return {status:200,body:{Accounts:[bank]}};
  if (path.endsWith("/TaxRates")) return {status:200,body:{TaxRates:[{TaxType:"NONE",Name:"No tax",EffectiveRate:0,Status:"ACTIVE"}]}};
  if (path.endsWith("/Contacts") || path.endsWith("/Contacts/vendor")) return {status:200,body:{Contacts:[{ContactID:"vendor",Name:"Mapped company supplier",ContactStatus:"ACTIVE"}]}};
  if ((path.endsWith("/Invoices") || path.endsWith(`/Invoices/${invoice}`)) && request.method === "GET") return {status:200,body:{Invoices:stored?[stored]:[]}};
  if (path.endsWith("/Invoices") && request.method === "POST") {
   assert.ok(request.headers["Idempotency-Key"]); const payload = JSON.parse(request.body!).Invoices[0];
   assert.equal(payload.DueDate,"2027-01-15"); assert.equal(payload.Date,new Date().toISOString().slice(0,10));
   stored = {...payload,InvoiceID:invoice,Total:16,UpdatedDateUTC:"/Date(1700000000000+0000)/"}; throw new Error("response lost after actual fake write");
  }
  throw new Error("Unexpected Xero test path");
 };
 await finishAccountingConnection("xero",{state:new URL(started.authorizationUrl).searchParams.get("state")!,code:"code"},f.browserNonce,transport);
 await selectAccountingEntity(f.access,started.connectionId,tenant,transport); await refreshAccountingCatalog(f.access,started.connectionId,1,transport);
 saveAccountingMapping(f.access,started.connectionId,{expectedVersion:0,expenseAccountId:"expense",bankAccountId:"bank",taxCodeId:"NONE",contacts:[{recipientId:f.recipientId,externalId:"vendor"}],fxNumerator:"4",fxDenominator:"5",fxSource:"Reviewed test FX source",fxDate:new Date().toISOString().slice(0,10),closedThrough:null,acknowledgement:true});
 const bill = createBill(f.access,{recipientId:f.recipientId,reference:randomUUID(),title:"Actual company bill",amount:"20000000",maxFee:"0",dueDate:"2027-01-15T00:00:00.000Z"}); approveBill(f.access,bill.id);
 const plan = createAccountingPlan(f.access,started.connectionId,{kind:"bill",sourceId:bill.id,postingDate:new Date().toISOString().slice(0,10)});
 approveAccountingPlan(f.access,plan.job.id,plan.job.review_hash);
 assert.equal((await dispatchAccountingJobs({organizationId:f.access.organizationId,transport})).jobs[0].state,"unknown");
 assert.equal((await reconcileAccountingJob(f.access,plan.job.id,false,transport)).matched,true);
 assert.equal(row<Job>("SELECT * FROM accounting_jobs WHERE id=?",plan.job.id)!.external_id,invoice);
 assert.equal(calls.filter(item=>item.method==="POST"&&item.url.endsWith("/Invoices")).length,1);
 assert.equal(calls.filter(item=>item.method==="GET"&&item.url.endsWith(`/Invoices/${invoice}`)).length,1);
});

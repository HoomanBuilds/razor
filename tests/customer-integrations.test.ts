import assert from "node:assert/strict";
import { before, test } from "node:test";
import { app } from "../src/server/app";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row, rows, transaction } from "../src/server/db";
import { hashToken } from "../src/server/identity/crypto";
import { acquireIntegrationRequest, authenticateIntegration, canonicalTerms, createIntegrationCredential, createIntegrationDraft, integrationAccess, integrationEvidence, integrationFinancialStatus, integrationRequestStatus, integrationResource, integrationResourcePage, integrationSettings, revokeIntegrationCredential, rotateIntegrationCredential } from "../src/server/integrations/service";
import { createWebhookEndpoint, dispatchIntegrationWebhooks, enqueueIntegrationEvent, inspectWebhookDelivery, publicWebhookAddress, replayWebhookDelivery, setWebhookEnabled, validateWebhookDestination, webhookSettings, webhookSignature, type WebhookSend } from "../src/server/integrations/webhooks";
import { draftReceiptOutput, integrationScopes, resourceOutputs, type IntegrationScope } from "../src/server/integrations/schemas";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "b2".repeat(32);
const permissions = ["company:read", "company:manage", "payments:read", "payments:prepare", "recipients:read", "recipients:manage", "payments:approve", "payments:execute", "reports:read"];
const owner: AccessContext = { userId: "owner", organizationId: "company", permissions };
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
const timestamp = () => new Date().toISOString();
let sequence = 0;
const next = () => String(++sequence);
function key(scopes: IntegrationScope[] = [...integrationScopes], principalUserId = "owner") {
  return createIntegrationCredential(owner, { name: `Key ${next()}`, principalUserId, scopes, expiresAt: new Date(Date.now() + 86400000).toISOString() });
}
function principal(scopes?: IntegrationScope[]) { const issued = key(scopes); return { ...issued, principal: authenticateIntegration(`Bearer ${issued.secret}`) }; }
const draft = () => ({ recipientId: "payee", reference: `payment-${next()}`, amount: "1000000", maxFee: "1000" });
const code = (wanted: string) => (error: unknown) => error instanceof ApiError && error.code === wanted;

before(() => {
  const db = getDb(), now = timestamp();
  for (const id of ["owner", "member", "other"]) db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, id, now);
  for (const [id, user] of [["company", "owner"], ["other-company", "other"]]) {
    db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, id, user, now, now);
    db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?,?,1,?)").run(`${id}-role`, id, "Owner", JSON.stringify(permissions), now);
    db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id, user, `${id}-role`, now);
  }
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES('company','member','company-role',?)").run(now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES('payee','company','Private payee','business','near','supplier.near','confirmed',?,?,?)").run(now, now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_network,primary_address,created_at,updated_at) VALUES('other-payee','other-company','Other payee','business','near','other.near',?,?)").run(now, now);
});

test("credentials are owner managed, hash-only and bound to a live member with explicit scopes", () => {
  assert.throws(() => createIntegrationCredential({ ...owner, userId: "member" }, {}), code("OWNER_REQUIRED"));
  assert.throws(() => createIntegrationCredential(owner, { name: "Invalid", principalUserId: "owner", scopes: ["payments:execute"], expiresAt: new Date(Date.now() + 10000).toISOString() }));
  const issued = principal(["payments:read"]);
  const serialized = JSON.stringify(integrationSettings(owner));
  assert.ok(!serialized.includes(issued.secret)); assert.ok(!serialized.includes(hashToken(issued.secret)));
  assert.equal(row<{ token_hash: string }>("SELECT token_hash FROM integration_credentials WHERE id=?", issued.credential.id)?.token_hash, hashToken(issued.secret));
  assert.deepEqual(integrationAccess(issued.principal, "payments:read").permissions, ["payments:read"]);
  assert.throws(() => createIntegrationDraft(issued.principal, "payment", "request-01", draft()), code("INSUFFICIENT_SCOPE"));
  const delegated = key(["payments:draft"], "member"), delegatedPrincipal = authenticateIntegration(`Bearer ${delegated.secret}`);
  getDb().prepare("UPDATE memberships SET status='suspended' WHERE organization_id='company' AND user_id='member'").run();
  assert.throws(() => integrationAccess(delegatedPrincipal, "payments:draft"), code("COMPANY_ACCESS_DENIED"));
  getDb().prepare("UPDATE memberships SET status='active' WHERE organization_id='company' AND user_id='member'").run();
  getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id='company-role'").run(JSON.stringify(["company:read", "company:manage", "payments:read"]));
  assert.throws(() => integrationAccess(delegatedPrincipal, "payments:draft"), code("FORBIDDEN"));
  getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id='company-role'").run(JSON.stringify(permissions));
});

test("draft creation and immutable idempotency reuse the existing unapproved liability", () => {
  const issued = principal(), input = draft(), idempotencyKey = `request-${next()}`;
  const first = createIntegrationDraft(issued.principal, "payment", idempotencyKey, input);
  draftReceiptOutput.parse(first);
  resourceOutputs.payment.parse(integrationResource(issued.principal, "payment", first.resourceId));
  const repeated = createIntegrationDraft(issued.principal, "payment", idempotencyKey, { ...input });
  assert.equal(repeated.resourceId, first.resourceId); assert.equal(repeated.replayed, true);
  assert.equal(integrationRequestStatus(issued.principal, first.requestId).status, "draft");
  assert.equal(row<{ total: number }>("SELECT COUNT(*) AS total FROM payments WHERE reference=?", input.reference)?.total, 1);
  assert.throws(() => createIntegrationDraft(issued.principal, "payment", idempotencyKey, { ...input, amount: "1000001" }), code("IDEMPOTENCY_CONFLICT"));
  assert.throws(() => createIntegrationDraft(issued.principal, "payment", `request-${next()}`, { ...draft(), amount: "0" }));
  assert.throws(() => createIntegrationDraft(issued.principal, "payment", `request-${next()}`, { ...draft(), amount: (1n << 128n).toString() }));
  assert.throws(() => createIntegrationDraft(issued.principal, "payment", `request-${next()}`, { ...draft(), recipientId: "other-payee" }), code("RECIPIENT_NOT_FOUND"));
  assert.throws(() => createIntegrationDraft(issued.principal, "payment", `request-${next()}`, { ...draft(), approvedBy: "owner" }));
  const invoice = createIntegrationDraft(issued.principal, "invoice", `request-${next()}`, { ...draft(), title: "Reviewed service" });
  resourceOutputs.invoice.parse(integrationResource(issued.principal, "invoice", invoice.resourceId));
  assert.equal(integrationResource(issued.principal, "invoice", invoice.resourceId).status, "draft");
  const recipient = createIntegrationDraft(issued.principal, "recipient", `request-${next()}`, { name: "Proposed payee", kind: "contractor", primaryNetwork: "near", primaryAddress: "proposed.near" });
  resourceOutputs.recipient.parse(integrationResource(issued.principal, "recipient", recipient.resourceId));
  assert.equal(integrationResource(issued.principal, "recipient", recipient.resourceId).status, "pending_confirmation");
  assert.equal(row<{ preference_status: string }>("SELECT preference_status FROM recipients WHERE id='payee'")?.preference_status, "confirmed");
  assert.equal(canonicalTerms({ b: "two", a: 1 }), canonicalTerms({ a: 1, b: "two" }));
  const rotated = rotateIntegrationCredential(owner, issued.credential.id);
  assert.throws(() => authenticateIntegration(`Bearer ${issued.secret}`), code("INVALID_CREDENTIAL"));
  assert.throws(() => integrationRequestStatus(issued.principal, first.requestId), code("INVALID_CREDENTIAL"));
  const newPrincipal = authenticateIntegration(`Bearer ${rotated.secret}`);
  assert.equal(createIntegrationDraft(newPrincipal, "payment", idempotencyKey, input).resourceId, first.resourceId);
  revokeIntegrationCredential(owner, issued.credential.id);
  assert.throws(() => integrationAccess(newPrincipal, "payments:read"), code("INVALID_CREDENTIAL"));
});

test("cursor pages, request status and evidence stay tenant scoped and omit receiving details", () => {
  const issued = principal();
  for (let i = 0; i < 3; i++) createIntegrationDraft(issued.principal, "payment", `request-${next()}`, draft());
  const page = integrationResourcePage(issued.principal, "payment", { limit: 2 });
  assert.equal(page.items.length, 2); assert.ok(page.nextCursor);
  const second = integrationResourcePage(issued.principal, "payment", { limit: 2, after: page.nextCursor });
  assert.ok(!second.items.some(item => page.items.some(first => first.id === item.id)));
  assert.throws(() => integrationResourcePage(issued.principal, "payment", { limit: 101 }));
  assert.throws(() => integrationResourcePage(issued.principal, "recipient", { after: "other-payee" }), code("INVALID_CURSOR"));
  assert.throws(() => integrationResource(issued.principal, "recipient", "other-payee"), code("RECIPIENT_NOT_FOUND"));
  assert.throws(() => integrationEvidence(issued.principal, "other-attempt"), code("NOT_FOUND"));
  assert.ok(!JSON.stringify(page).includes("supplier.near"));
});

test("expiring credentials and durable rate/concurrency limits reject new calls", () => {
  const issued = principal(["payments:read"]), releases = Array.from({ length: 4 }, () => acquireIntegrationRequest(issued.principal));
  assert.throws(() => acquireIntegrationRequest(issued.principal), code("RATE_LIMITED"));
  releases.forEach(release => release());
  getDb().prepare("UPDATE integration_credentials SET rate_count=60,rate_window=? WHERE id=?").run(Math.floor(Date.now() / 60000), issued.credential.id);
  assert.throws(() => acquireIntegrationRequest(issued.principal), code("RATE_LIMITED"));
  getDb().prepare("UPDATE integration_credentials SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), issued.credential.id);
  assert.throws(() => integrationAccess(issued.principal, "payments:read"), code("INVALID_CREDENTIAL"));
});

test("HTTP API schemas, strict errors and official stateless MCP work with isolated tenant identities", async () => {
  const issued = principal(), authorization = `Bearer ${issued.secret}`;
  const schema = await app.request("http://localhost/api/integrations/v1/schema", { headers: { authorization } });
  assert.equal(schema.status, 200); assert.equal((await schema.json()).executionEnabled, false);
  const response = await app.request("http://localhost/api/integrations/v1/payments/drafts", { method: "POST", headers: { authorization, "content-type": "application/json", "idempotency-key": `request-${next()}` }, body: JSON.stringify(draft()) });
  assert.equal(response.status, 201);
  const malformed = await app.request("http://localhost/api/integrations/v1/payments/drafts", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  const forbidden = await app.request("http://localhost/api/integrations/v1/payments", { headers: { authorization, origin: "https://attacker.example" } });
  assert.equal(forbidden.status, 403);
  const mcp = async (method: string, params: unknown, auth = authorization) => {
    const result = await app.request("http://localhost/api/integrations/mcp", { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await result.text();
    const packet = body.startsWith("event:") ? JSON.parse(body.split("data: ")[1].split("\n")[0]) : JSON.parse(body);
    return { status: result.status, packet };
  };
  const initialized = await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.status, 200); assert.ok(initialized.packet.result.serverInfo);
  const listed = await mcp("tools/list", {});
  assert.ok(listed.packet.result.tools.some((tool: { name: string }) => tool.name === "request_payment_draft"));
  assert.ok(!listed.packet.result.tools.some((tool: { name: string }) => /execute|approve/.test(tool.name)));
  const created = await mcp("tools/call", { name: "request_payment_draft", arguments: { idempotencyKey: `request-${next()}`, draft: draft() } });
  assert.ok(!created.packet.result.isError, JSON.stringify(created.packet));
  const other = createIntegrationCredential({ userId: "other", organizationId: "other-company", permissions }, { name: "Other", principalUserId: "other", scopes: ["recipients:read"], expiresAt: new Date(Date.now() + 10000).toISOString() });
  const cross = await mcp("tools/call", { name: "get_recipient", arguments: { id: "payee" } }, `Bearer ${other.secret}`);
  assert.equal(cross.packet.result.isError, true); assert.match(cross.packet.result.content[0].text, /RECIPIENT_NOT_FOUND/);
  revokeIntegrationCredential(owner, issued.credential.id);
  const revoked = await app.request("http://localhost/api/integrations/mcp", { method: "POST", headers: { authorization }, body: "{}" });
  assert.equal(revoked.status, 401);
});

test("webhook validation blocks private, metadata, encoded IPs, mapped IPv6, mixed DNS and credentials", async () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "172.31.2.2", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "::ffff:8.8.8.8", "fc00::1", "2002:0808:0808::1", "2001:db8::1"]) assert.equal(publicWebhookAddress(address), false, address);
  assert.equal(publicWebhookAddress("8.8.8.8"), true); assert.equal(publicWebhookAddress("2606:4700:4700::1111"), true);
  for (const url of ["http://hooks.example.com", "https://user:pass@hooks.example.com", "https://hooks.example.com/?token=secret", "https://hooks.example.com:8080", "https://127.1", "https://2130706433", "https://[::1]", "https://localhost", "https://hooks.example.com/#secret"]) await assert.rejects(validateWebhookDestination(url, publicDns), code("INVALID_WEBHOOK_DESTINATION"));
  await assert.rejects(validateWebhookDestination("https://hooks.example.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]), code("INVALID_WEBHOOK_DESTINATION"));
});

test("real financial transitions enqueue durable minimal signed events with retries, replay, leases and disable", async () => {
  getDb().prepare("UPDATE integration_payment_changes SET published_at=?").run(timestamp());
  getDb().prepare("UPDATE integration_state_changes SET published_at=?").run(timestamp());
  const endpoint = await createWebhookEndpoint(owner, { url: "https://hooks.example.com/events" }, publicDns);
  const issued = principal(), created = createIntegrationDraft(issued.principal, "payment", `request-${next()}`, draft());
  getDb().prepare("UPDATE payments SET status='unknown',updated_at=? WHERE id=?").run(timestamp(), created.resourceId);
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount='1000000',updated_at=? WHERE id=?").run(timestamp(), created.resourceId);
  const received: WebhookSend[] = [];
  await dispatchIntegrationWebhooks({ limit: 10, resolver: publicDns, transport: async request => { received.push(request); return 503; } });
  assert.ok(received.length >= 4);
  const events = received.map(request => JSON.parse(request.body));
  assert.deepEqual(events.filter(event => event.type === "payment.status.changed").sort((a, b) => a.sequence - b.sequence).map(event => event.data.status), ["draft", "unknown", "paid"]);
  for (const request of received) {
    assert.equal(request.headers["Razor-Signature"], webhookSignature(endpoint.secret, request.headers["Razor-Timestamp"], request.body));
    assert.equal(request.address, "8.8.8.8"); assert.ok(!request.body.includes("supplier.near")); assert.ok(!request.body.includes("Private payee"));
  }
  const history = webhookSettings(owner), delivery = history.deliveries.find(item => (item as { endpointId: string }).endpointId === endpoint.endpoint.id) as { id: string; state: string };
  assert.equal(delivery.state, "queued");
  assert.throws(() => replayWebhookDelivery(owner, delivery.id), code("DELIVERY_ACTIVE"));
  getDb().prepare("UPDATE integration_webhook_deliveries SET next_attempt_at=?,cycle_attempts=7 WHERE id=?").run(timestamp(), delivery.id);
  await dispatchIntegrationWebhooks({ limit: 1, resolver: publicDns, transport: async () => 302 });
  const failed = row<{ state: string; last_error: string }>("SELECT state,last_error FROM integration_webhook_deliveries WHERE id=?", delivery.id)!;
  assert.equal(failed.state, "failed"); assert.equal(failed.last_error, "REDIRECT_REJECTED");
  const before = inspectWebhookDelivery(owner, delivery.id).payload;
  replayWebhookDelivery(owner, delivery.id);
  await dispatchIntegrationWebhooks({ limit: 1, resolver: publicDns, transport: async () => 204 });
  assert.equal(row<{ state: string }>("SELECT state FROM integration_webhook_deliveries WHERE id=?", delivery.id)?.state, "delivered");
  assert.deepEqual(inspectWebhookDelivery(owner, delivery.id).payload, before);
  assert.equal(inspectWebhookDelivery(owner, delivery.id).attempts.length, 3);
  replayWebhookDelivery(owner, delivery.id);
  await dispatchIntegrationWebhooks({ limit: 1, resolver: async () => [{ address: "169.254.169.254", family: 4 }], transport: async () => { assert.fail("Private DNS must never reach transport"); } });
  assert.equal(row<{ last_error: string }>("SELECT last_error FROM integration_webhook_deliveries WHERE id=?", delivery.id)?.last_error, "INVALID_WEBHOOK_DESTINATION");
  setWebhookEnabled(owner, endpoint.endpoint.id, false);
  const cancelled = webhookSettings(owner).deliveries.filter(item => (item as { endpointId: string }).endpointId === endpoint.endpoint.id) as { state: string }[];
  assert.ok(cancelled.every(item => item.state === "cancelled" || item.state === "delivered" || item.state === "failed"));
  assert.ok(!JSON.stringify(webhookSettings(owner)).includes(endpoint.secret));
});

test("failed transactions cannot emit events and every captured funding/payroll state has a scoped status reader", async () => {
  const beforeCount = row<{ total: number }>("SELECT COUNT(*) AS total FROM integration_events")!.total;
  assert.throws(() => transaction(() => { enqueueIntegrationEvent("company", "integration.draft.created", `rollback-${next()}`, { resourceId: "test", kind: "payment", status: "draft" }); throw new Error("rollback"); }));
  assert.equal(row<{ total: number }>("SELECT COUNT(*) AS total FROM integration_events")!.total, beforeCount);
  const issued = principal(), now = timestamp(), funding = `funding-${next()}`, payroll = `payroll-${next()}`;
  getDb().prepare("INSERT INTO funding_legs(id,organization_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,created_at,updated_at) VALUES(?,'company',?,'USDC','100','100','{}','deposit.near','treasury.near','processing',?,?)").run(funding, funding, now, now);
  getDb().prepare("UPDATE funding_legs SET status='credited',credited_amount='100',updated_at=? WHERE id=?").run(timestamp(), funding);
  getDb().prepare("INSERT INTO payroll_runs(id,organization_id,reference,period_start,period_end,created_by,created_at,updated_at) VALUES(?,'company',?,'2026-11-01','2026-11-30','owner',?,?)").run(payroll, payroll, now, now);
  getDb().prepare("UPDATE payroll_runs SET status='approved',updated_at=? WHERE id=?").run(timestamp(), payroll);
  assert.equal((integrationFinancialStatus(issued.principal, "funding", funding) as { creditedAmount: string }).creditedAmount, "100");
  assert.equal((integrationFinancialStatus(issued.principal, "payroll", payroll) as { status: string }).status, "approved");
  await dispatchIntegrationWebhooks({ limit: 0, resolver: publicDns, transport: async () => assert.fail("No send expected") });
  const fundingEvents = rows<{ payload: string }>("SELECT payload FROM integration_events WHERE source_key LIKE 'state-change:%'").map(item => JSON.parse(item.payload)).filter(event => event.data.resourceId === funding);
  assert.deepEqual(fundingEvents.map(event => [event.data.status, event.data.creditedAmount]), [["processing", "0"], ["credited", "100"]]);
});

test("expired delivery leases recover without concurrent duplicate claims and live owner access gates each send", async () => {
  const endpoint = await createWebhookEndpoint(owner, { url: "https://leases.example.com/events" }, publicDns);
  const eventId = enqueueIntegrationEvent("company", "integration.draft.created", `lease-event-${next()}`, { resourceId: "lease-resource", kind: "recipient", status: "pending_confirmation" });
  const delivery = row<{ id: string }>("SELECT id FROM integration_webhook_deliveries WHERE endpoint_id=? AND event_id=?", endpoint.endpoint.id, eventId)!;
  getDb().prepare("UPDATE integration_webhook_deliveries SET state='sending',lease_owner='crashed-worker',lease_until=?,attempts=1,cycle_attempts=1 WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), delivery.id);
  getDb().prepare("INSERT INTO integration_webhook_attempts(id,delivery_id,attempt,started_at) VALUES('crashed-worker',?,1,?)").run(delivery.id, timestamp());
  let active = 0, sends = 0;
  const transport = async () => { active++; sends++; assert.equal(active, 1); await new Promise(resolve => setImmediate(resolve)); active--; return 204; };
  await Promise.all([dispatchIntegrationWebhooks({ limit: 1, resolver: publicDns, transport }), dispatchIntegrationWebhooks({ limit: 1, resolver: publicDns, transport })]);
  assert.equal(sends, 1);
  assert.equal(row<{ state: string }>("SELECT state FROM integration_webhook_deliveries WHERE id=?", delivery.id)?.state, "delivered");
  assert.equal(row<{ error: string }>("SELECT error FROM integration_webhook_attempts WHERE id='crashed-worker'")?.error, "LEASE_EXPIRED");
  replayWebhookDelivery(owner, delivery.id);
  await dispatchIntegrationWebhooks({ limit: 1, resolver: publicDns, transport: async () => { throw new Error("Untrusted provider text with secret"); } });
  assert.equal(row<{ last_error: string }>("SELECT last_error FROM integration_webhook_deliveries WHERE id=?", delivery.id)?.last_error, "TRANSPORT_FAILED");
  getDb().prepare("UPDATE integration_webhook_deliveries SET next_attempt_at=? WHERE id=?").run(timestamp(), delivery.id);
  getDb().prepare("UPDATE memberships SET status='suspended' WHERE organization_id='company' AND user_id='owner'").run();
  await dispatchIntegrationWebhooks({ limit: 1, resolver: publicDns, transport: async () => assert.fail("Inactive endpoint owner must prevent sending") });
  assert.equal(row<{ state: string }>("SELECT state FROM integration_webhook_deliveries WHERE id=?", delivery.id)?.state, "cancelled");
  getDb().prepare("UPDATE memberships SET status='active' WHERE organization_id='company' AND user_id='owner'").run();
  setWebhookEnabled(owner, endpoint.endpoint.id, false);
});

test("existing cookie routes retain origin checks and cannot accept integration bearer authority", async () => {
  const issued = principal();
  const bearer = await app.request("http://localhost/api/organizations/company/integrations", { headers: { authorization: `Bearer ${issued.secret}` } });
  assert.equal(bearer.status, 401);
  getDb().prepare("INSERT INTO sessions(id,user_id,token_hash,organization_id,expires_at,created_at) VALUES('owner-session','owner',?,'company',?,?)").run(hashToken("owner-cookie"), new Date(Date.now() + 60000).toISOString(), timestamp());
  const headers = { cookie: "razor_session=owner-cookie", "content-type": "application/json" };
  const settings = await app.request("http://localhost/api/organizations/company/integrations", { headers });
  assert.equal(settings.status, 200);
  const mutation = await app.request("http://localhost/api/organizations/company/integrations/credentials", { method: "POST", headers, body: "{}" });
  assert.equal(mutation.status, 403); assert.equal((await mutation.json()).code, "ORIGIN_REJECTED");
});

test("organization-scoped webhook ticks publish, recover and deliver only that company's work", async () => {
  const other: AccessContext = { userId: "other", organizationId: "other-company", permissions };
  const firstEndpoint = await createWebhookEndpoint(owner, { url: "https://first-company.example.com/events" }, publicDns);
  const otherEndpoint = await createWebhookEndpoint(other, { url: "https://second-company.example.com/events" }, publicDns);
  const firstPrincipal = principal(), firstPayment = createIntegrationDraft(firstPrincipal.principal, "payment", `scope-${next()}`, draft());
  const otherKey = createIntegrationCredential(other, { name: "Scoped worker", principalUserId: "other", scopes: ["payments:draft"], expiresAt: new Date(Date.now() + 60000).toISOString() });
  const otherPayment = createIntegrationDraft(authenticateIntegration(`Bearer ${otherKey.secret}`), "payment", `scope-${next()}`, { ...draft(), recipientId: "other-payee" });
  const now = timestamp(), firstRun = `scoped-payroll-${next()}`, otherRun = `scoped-payroll-${next()}`;
  for (const [id, company, user] of [[firstRun, "company", "owner"], [otherRun, "other-company", "other"]]) getDb().prepare("INSERT INTO payroll_runs(id,organization_id,reference,period_start,period_end,created_by,created_at,updated_at) VALUES(?,?,?,'2026-11-01','2026-11-30',?,?,?)").run(id, company, id, user, now, now);
  const otherDelivery = row<{ id: string }>("SELECT id FROM integration_webhook_deliveries WHERE endpoint_id=?", otherEndpoint.endpoint.id)!;
  const expired = new Date(Date.now() - 1000).toISOString();
  getDb().prepare("UPDATE integration_webhook_deliveries SET state='sending',attempts=1,cycle_attempts=1,lease_owner='other-company-worker',lease_until=? WHERE id=?").run(expired, otherDelivery.id);
  getDb().prepare("INSERT INTO integration_webhook_attempts(id,delivery_id,attempt,started_at) VALUES('other-company-worker',?,1,?)").run(otherDelivery.id, now);
  const sends: Array<{ organizationId: string; data: { resourceId: string } }> = [];
  const transport = async (request: WebhookSend) => { sends.push(JSON.parse(request.body)); return 204; };
  const result = await dispatchIntegrationWebhooks({ organizationId: "company", limit: 10, resolver: publicDns, transport });
  assert.ok(result.published >= 2); assert.ok(result.delivered >= 3);
  assert.ok(sends.every(event => event.organizationId === "company"));
  assert.ok(sends.some(event => event.data.resourceId === firstPayment.resourceId));
  assert.ok(sends.some(event => event.data.resourceId === firstRun));
  assert.equal(row<{ published_at: string | null }>("SELECT published_at FROM integration_payment_changes WHERE payment_id=?", otherPayment.resourceId)?.published_at, null);
  assert.equal(row<{ published_at: string | null }>("SELECT published_at FROM integration_state_changes WHERE resource_id=?", otherRun)?.published_at, null);
  assert.equal(row<{ state: string }>("SELECT state FROM integration_webhook_deliveries WHERE id=?", otherDelivery.id)?.state, "sending");
  assert.equal(row<{ completed_at: string | null }>("SELECT completed_at FROM integration_webhook_attempts WHERE id='other-company-worker'")?.completed_at, null);
  sends.length = 0;
  await dispatchIntegrationWebhooks({ organizationId: "other-company", limit: 10, resolver: publicDns, transport });
  assert.ok(sends.length >= 3); assert.ok(sends.every(event => event.organizationId === "other-company"));
  assert.ok(sends.some(event => event.data.resourceId === otherPayment.resourceId));
  assert.ok(sends.some(event => event.data.resourceId === otherRun));
  assert.equal(row<{ state: string }>("SELECT state FROM integration_webhook_deliveries WHERE id=?", otherDelivery.id)?.state, "delivered");
  assert.equal(row<{ error: string }>("SELECT error FROM integration_webhook_attempts WHERE id='other-company-worker'")?.error, "LEASE_EXPIRED");
  setWebhookEnabled(owner, firstEndpoint.endpoint.id, false);
  setWebhookEnabled(other, otherEndpoint.endpoint.id, false);
});

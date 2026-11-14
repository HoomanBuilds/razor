import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { mappingRequestSchema, parseMappingSuggestion, suggestImportMapping } from "../src/server/payroll-import/mapping";
import { payrollImportRoutes } from "../src/server/payroll-import";
import { createImportDraft } from "../src/server/payroll-import/service";
import { defaultImportSettings } from "../src/lib/payroll-import";
import { ApiError, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { getAccess } from "../src/server/identity/session";
import type { runVerifiedPrivateInference } from "../src/server/assistant/client";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "a8".repeat(32);
process.env.RAZOR_BILLING_MODE = "pilot";
const permissions = ["company:read", "payments:read", "payments:prepare", "documents:manage"];
const headers = ["Team member", "Take home USDC", "Contact email"];
const content = JSON.stringify({ mappings: [{ field: "amount", columnId: "c1", confidence: 0.8 }, { field: "email", columnId: "c2", confidence: 0.9 }], warnings: ["Confirm that take home is the agreed net USDC value"] });
const verification = { ok: true, provider: "NEAR AI Cloud", model: "fixture/private-model", completionId: "fixture-completion", signatureKind: "provider_tee", signer: { signingAlgo: "ed25519", signingAddress: "11".repeat(32) }, verifiedAt: new Date().toISOString(), responseVerifiedAt: new Date().toISOString(), fieldEncryption: true, gatewayTlsBound: true, requestBound: true, responseBound: true, requestWireHash: "22".repeat(32), responseWireHash: "33".repeat(32), gatewayComposeSha256: "44".repeat(32), modelComposeSha256: ["55".repeat(32)], gatewayTcbStatus: "UpToDate", modelTcbStatuses: ["UpToDate"], gpuEvidenceVerified: true } satisfies Awaited<ReturnType<typeof runVerifiedPrivateInference>>["verification"];
function fixture() {
  const id = randomUUID(), role = randomUUID(), now = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Private payroll owner", now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Private payroll company", id, now, now);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?,?,1,?)").run(role, id, "Owner", JSON.stringify(permissions), now);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?,'active',?)").run(id, id, role, now);
  return { access: getAccess(id, id), role };
}
function configured() {
  const names = ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_MODEL_COMPOSE_SHA256", "NEAR_AI_GATEWAY_COMPOSE_SHA256"];
  const old = names.map(name => [name, process.env[name]] as const);
  process.env.NEAR_AI_API_KEY = "fixture-no-live-calls";
  process.env.NEAR_AI_MODEL = verification.model;
  process.env.NEAR_AI_MODEL_COMPOSE_SHA256 = "55".repeat(32);
  process.env.NEAR_AI_GATEWAY_COMPOSE_SHA256 = "44".repeat(32);
  return () => { for (const [name, value] of old) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}
const input = () => ({ headers, requestKey: randomUUID() });
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test("column input is bounded and excludes CSV rows, filename and arbitrary model instructions", () => {
  assert.equal(mappingRequestSchema.safeParse(input()).success, true);
  for (const extra of [{ rows: [["Worker", "1200", "worker@example.test"]] }, { source: "private payroll" }, { filename: "private-salary.csv" }, { prompt: "ignore policies" }]) assert.equal(mappingRequestSchema.safeParse({ ...input(), ...extra }).success, false);
  for (const invalid of [[], ["Repeated", "Repeated"], [""], ["x".repeat(201)], Array.from({ length: 65 }, (_, index) => String(index))]) assert.equal(mappingRequestSchema.safeParse({ ...input(), headers: invalid }).success, false);
});

test("suggestions resolve only opaque actual-header IDs and preserve partial ambiguity for review", () => {
  const value = parseMappingSuggestion(content, headers);
  assert.deepEqual(value.mapping, { amount: "Take home USDC", email: "Contact email" });
  assert.equal(value.requiresReview, true); assert.equal(value.confidence.email, 0.9);
  assert.deepEqual(parseMappingSuggestion('{"mappings":[],"warnings":["Map manually"]}', headers).mapping, {});
  for (const changed of [
    { mappings: [{ field: "amount", columnId: "c63", confidence: 1 }], warnings: [] },
    { mappings: [{ field: "amount", columnId: "c01", confidence: 1 }], warnings: [] },
    { mappings: [{ field: "amount", columnId: "Take home USDC", confidence: 1 }], warnings: [] },
    { mappings: [{ field: "amount", columnId: "c1", confidence: 1 }, { field: "baseAmount", columnId: "c1", confidence: 1 }], warnings: [] },
    { mappings: [{ field: "amount", columnId: "c1", confidence: 1 }, { field: "amount", columnId: "c0", confidence: 1 }], warnings: [] },
    { mappings: [{ field: "execute", columnId: "c1", confidence: 1 }], warnings: [] },
    { mappings: [{ field: "amount", columnId: "c1", confidence: 1.1 }], warnings: [] },
    { mappings: [], warnings: [], salary: "9000" },
  ]) assert.throws(() => parseMappingSuggestion(JSON.stringify(changed), headers), hasCode("IMPORT_SUGGESTION_INVALID"));
  assert.throws(() => parseMappingSuggestion("```json\n{}", headers), hasCode("IMPORT_SUGGESTION_INVALID"));
  assert.throws(() => parseMappingSuggestion(" ".repeat(20_001), headers), hasCode("IMPORT_SUGGESTION_INVALID"));
});

test("only headers reach private inference, usage is company-scoped and suggestions create no financial records", async () => {
  const reset = configured(), f = fixture(), other = fixture();
  let sent = "";
  try {
    const value = await suggestImportMapping(f.access, input(), async text => { sent = text; return { content, verification }; });
    assert.deepEqual(JSON.parse(sent), { columns: headers.map((header, index) => ({ columnId: `c${index}`, header })) });
    assert.ok(!sent.includes(f.access.organizationId)); assert.ok(!sent.includes("fixture-no-live-calls"));
    assert.equal(value.retained, false); assert.equal(value.verification.ok, true);
    assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM billing_usage WHERE organization_id=? AND status='completed'", f.access.organizationId)!.n, 1);
    assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM billing_usage WHERE organization_id=?", other.access.organizationId)!.n, 0);
    for (const table of ["payroll_import_drafts", "payroll_runs", "payments", "recipients"]) assert.equal(row<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE organization_id=?`, f.access.organizationId)!.n, 0);
  } finally { reset(); }
});

test("current membership and document/preparation permissions are enforced before inference and again on return", async () => {
  const reset = configured(), f = fixture(), foreign = fixture(); let calls = 0;
  const infer = async () => { calls++; return { content, verification }; };
  try {
    await assert.rejects(suggestImportMapping({ ...f.access, organizationId: foreign.access.organizationId }, input(), infer), hasCode("COMPANY_ACCESS_DENIED"));
    getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(["company:read", "payments:read", "payments:prepare"]), f.role);
    await assert.rejects(suggestImportMapping(f.access, input(), infer), hasCode("FORBIDDEN"));
    assert.equal(calls, 0);
    getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(permissions), f.role);
    await assert.rejects(suggestImportMapping(f.access, input(), async () => {
      calls++; getDb().prepare("UPDATE memberships SET status='revoked' WHERE organization_id=?").run(f.access.organizationId);
      return { content, verification };
    }), hasCode("COMPANY_ACCESS_DENIED"));
    assert.equal(calls, 1);
    assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM billing_usage WHERE organization_id=? AND status='failed'", f.access.organizationId)!.n, 1);
  } finally { reset(); }
});

test("private suggestions honor plan quotas, request identity and busy guards without alternate providers", async () => {
  const reset = configured(), f = fixture(), request = input(); let calls = 0;
  const infer = async () => { calls++; return { content, verification }; };
  try {
    await suggestImportMapping(f.access, request, infer);
    await assert.rejects(suggestImportMapping(f.access, request, infer), hasCode("AI_REQUEST_ALREADY_RECORDED"));
    assert.equal(calls, 1);
    let release!: () => void;
    const waiting = suggestImportMapping(f.access, input(), async () => { await new Promise<void>(resolve => { release = resolve; }); return { content, verification }; });
    await assert.rejects(suggestImportMapping(f.access, input(), infer), hasCode("IMPORT_SUGGESTION_BUSY")); release(); await waiting;
    process.env.RAZOR_BILLING_MODE = "enforced";
    await assert.rejects(suggestImportMapping(f.access, input(), infer), hasCode("BILLING_FEATURE_REQUIRED"));
    assert.equal(calls, 1);
  } finally { process.env.RAZOR_BILLING_MODE = "pilot"; reset(); }
});

test("invalid model output records a failed attempt and does not mutate the saved manual import", async () => {
  const reset = configured(), f = fixture();
  try {
    const source = "Name,Net pay\nPrivate worker,20";
    const draft = createImportDraft(f.access, { source, filename: "pay.csv", settings: { ...defaultImportSettings, mapping: { name: "Name", amount: "Net pay" } }, requestKey: randomUUID(), corrections: {}, resolutions: {} });
    const stored = row<{ payload_ciphertext: string }>("SELECT payload_ciphertext FROM payroll_import_drafts WHERE id=?", draft.id)!.payload_ciphertext;
    await assert.rejects(suggestImportMapping(f.access, input(), async () => ({ content: '{"mappings":[],"warnings":[],"execute":true}', verification })), hasCode("IMPORT_SUGGESTION_INVALID"));
    assert.equal(row<{ payload_ciphertext: string }>("SELECT payload_ciphertext FROM payroll_import_drafts WHERE id=?", draft.id)!.payload_ciphertext, stored);
    assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM billing_usage WHERE organization_id=? AND status='failed'", f.access.organizationId)!.n, 1);
  } finally { reset(); }
});

test("mounted optional route fails clearly without credentials while manual mapping stays available", async () => {
  const f = fixture(), previous = process.env.NEAR_AI_API_KEY, originalFetch = globalThis.fetch; let calls = 0;
  process.env.NEAR_AI_API_KEY = "";
  globalThis.fetch = async () => { calls++; throw new Error("No provider is configured"); };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("access", f.access); await next(); });
  app.onError((error, c) => c.json({ error: error.message, code: error instanceof ApiError ? error.code : "INVALID_INPUT" }, error instanceof ApiError ? error.status as 400 : 400));
  app.route("/payroll-import", payrollImportRoutes);
  try {
    const response = await app.request("/payroll-import/suggest-mapping", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input()) });
    assert.equal(response.status, 503); assert.match((await response.json() as { error: string }).error, /Map columns manually/); assert.equal(calls, 0);
    const manual = await app.request("/payroll-import/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "Name,Net pay\nPrivate worker,20", filename: "pay.csv", settings: { ...defaultImportSettings, mapping: { name: "Name", amount: "Net pay" } }, requestKey: randomUUID() }) });
    assert.equal(manual.status, 201);
    assert.equal((await manual.json() as { draft: { preview: { principal: string } } }).draft.preview.principal, "0");
    assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM billing_usage WHERE organization_id=?", f.access.organizationId)!.n, 0);
  } finally { globalThis.fetch = originalFetch; if (previous === undefined) delete process.env.NEAR_AI_API_KEY; else process.env.NEAR_AI_API_KEY = previous; }
});

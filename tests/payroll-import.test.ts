import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultImportSettings, normalizePayrollAmount, parsePayrollTable, previewPayrollImport, suggestPayrollColumns, validateImportSettings, type ImportSettings } from "../src/lib/payroll-import";
import { archiveImportTemplate, commitImportDraft, createImportDraft, getImportDraft, listImportTemplates, saveImportTemplate, updateImportDraft } from "../src/server/payroll-import/service";
import { getDb, row } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import type { AccessContext } from "../src/server/context";
import { Hono } from "hono";
import { payrollImportRoutes } from "../src/server/payroll-import";
import { ApiError, type AppEnv } from "../src/server/context";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "a1".repeat(32);
process.env.RAZOR_BILLING_MODE = "pilot";

const normal: ImportSettings = { ...defaultImportSettings, mapping: { email: "Employee email", amount: "Net pay", currency: "Currency" } };
const source = "Employee email,Net pay,Currency\nworker@example.test,1200.50,USDC";
function fixture() {
  const id = randomUUID(), recipientId = randomUUID(), now = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Import owner", now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Import company", id, now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,email,kind,primary_asset,primary_network,primary_address,preference_status,created_at,updated_at) VALUES(?,?,?,?,'employee','USDC','base',?,'pending_confirmation',?,?)").run(recipientId, id, encrypt("Worker"), encrypt("worker@example.test"), `0x${"12".repeat(20)}`, now, now);
  const access: AccessContext = { organizationId: id, userId: id, permissions: ["company:read", "payments:prepare", "payments:read"] };
  return { access, recipientId };
}
function create(access: AccessContext, key = randomUUID()) { return createImportDraft(access, { source, filename: "salary.csv", settings: normal, requestKey: key, corrections: {}, resolutions: {} }); }
function terms(draft: ReturnType<typeof create>, reference = randomUUID()) { return { expectedVersion: draft.version, reviewToken: draft.reviewToken, reference, periodStart: "2026-11-01", periodEnd: "2026-11-30", confirmed: true as const }; }

test("payroll dialect parser preserves quoted headers, multiline cells and BOM while rejecting malformed sources", () => {
  const parsed = parsePayrollTable('\uFEFFEmployee email;Net pay;Note\r\nworker@example.test;"1.200,50";"Two\nlines"', ";");
  assert.deepEqual(parsed.headers, ["Employee email", "Net pay", "Note"]);
  assert.equal(parsed.rows[0]["Net pay"], "1.200,50");
  assert.equal(parsed.rows[0].Note, "Two\nlines");
  assert.throws(() => parsePayrollTable('a,b\n"one"oops,two', ","), /unexpected text/);
  assert.throws(() => parsePayrollTable("a,a\none,two", ","), /unique/);
  assert.throws(() => parsePayrollTable("a,b\none,two,three", ","), /number of columns/);
  assert.throws(() => parsePayrollTable('a,b\n"one,two', ","), /unclosed/);
  assert.throws(() => parsePayrollTable("a\n" + "x\n".repeat(1001), ","), /1,000/);
});

test("locale amounts are exact and reject ambiguous grouping, currencies, overflow and precision loss", () => {
  const eu = { decimal: ",", thousands: "." } as const;
  assert.equal(normalizePayrollAmount("1.234,567891", eu), 1_234_567891n);
  assert.equal(normalizePayrollAmount("-25,50", eu, true, true), -25_500000n);
  assert.equal(normalizePayrollAmount("1 234.5", { decimal: ".", thousands: " " }), 1_234_500000n);
  assert.equal(normalizePayrollAmount("1'234.5", { decimal: ".", thousands: "'" }), 1_234_500000n);
  for (const value of ["1.23,40", "1,000.50", "1,0000001", "EUR 20", "1e3", "-2", "(2)", "9999999999999999999999999999999999999"]) assert.throws(() => normalizePayrollAmount(value, eu), value);
  assert.throws(() => normalizePayrollAmount("0", eu));
  assert.equal(normalizePayrollAmount("0", eu, true), 0n);
});

test("mapping validates actual headers and deterministic suggestions never invent values", () => {
  assert.deepEqual(suggestPayrollColumns(["Employee Email", "Net Pay", "Currency", "Base salary"]), { email: "Employee Email", amount: "Net Pay", baseAmount: "Base salary", currency: "Currency" });
  assert.throws(() => validateImportSettings({ ...normal, mapping: { email: "Missing", amount: "Net pay" } }, ["Employee email", "Net pay"]), /not present/);
  assert.throws(() => validateImportSettings({ ...normal, mapping: { email: "Same", amount: "Same" } }, ["Same"]), /mapped to both/);
  assert.throws(() => validateImportSettings({ ...normal, decimal: ",", thousands: "," }, ["Employee email", "Net pay", "Currency"]), /different/);
});

test("row preview preserves components and isolates unresolved identities, foreign currency and duplicate payees", () => {
  const settings: ImportSettings = { ...normal, delimiter: ";", decimal: ",", thousands: ".", mapping: { email: "Person", baseAmount: "Base", bonusAmount: "Bonus", adjustmentAmount: "Correction", note: "Reason", maxFee: "Fee" } };
  const parsed = previewPayrollImport("Person;Base;Bonus;Correction;Reason;Fee\nworker@example.test;1.200,50;200;-50;Monthly adjustment;0,025", settings, [{ id: "r1", email: "worker@example.test" }]);
  assert.deepEqual(parsed.rows[0].item, { amount: "1350.5", maxFee: "0.025", note: "Monthly adjustment", baseAmount: "1200.5", bonusAmount: "200", adjustmentAmount: "-50" });
  assert.equal(parsed.principal, "1350500000"); assert.equal(parsed.maxFees, "25000"); assert.equal(parsed.canCommit, true);
  const mixed = previewPayrollImport(source + "\nworker@example.test,4,EUR\nunknown@example.test,1,USDC", normal, [{ id: "r1", email: "worker@example.test" }]);
  assert.equal(mixed.ready, 1); assert.equal(mixed.canCommit, false); assert.match(mixed.rows[1].errors.join(" "), /more than once.*not converted/); assert.match(mixed.rows[2].errors[0], /not found/);
  const ambiguous = previewPayrollImport(source, normal, [{ id: "r1", email: "worker@example.test" }, { id: "r2", email: "worker@example.test" }]);
  assert.match(ambiguous.rows[0].errors[0], /several/);
  assert.equal(previewPayrollImport(source, normal, [{ id: "r1", email: "worker@example.test" }], {}, { 2: { amount: "-1" } }).canCommit, false);
});

test("company mapping history is encrypted, versioned, scoped and archived without destroying snapshots", () => {
  const { access } = fixture(), other = fixture().access, headers = parsePayrollTable(source, ",").headers;
  const saved = saveImportTemplate(access, { name: "Monthly payroll", settings: normal, headers });
  const changed = saveImportTemplate(access, { name: "Renamed payroll", settings: normal, headers }, saved.id, saved.version);
  assert.equal(changed.version, 2); assert.equal(changed.name, "Renamed payroll");
  assert.equal(listImportTemplates(other).length, 0);
  assert.throws(() => saveImportTemplate(access, { name: "Stale", settings: normal, headers }, saved.id, 1), /changed/);
  assert.throws(() => saveImportTemplate(other, { name: "Foreign", settings: normal, headers }, saved.id, 2), /not found/);
  const raw = row<{ name_ciphertext: string }>("SELECT name_ciphertext FROM payroll_import_templates WHERE id=?", saved.id)!;
  assert.ok(raw.name_ciphertext.startsWith("enc1:")); assert.ok(!raw.name_ciphertext.includes("Monthly"));
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM payroll_import_template_versions WHERE template_id=?", saved.id)!.n, 2);
  archiveImportTemplate(access, saved.id); assert.equal(listImportTemplates(access).length, 0);
});

test("saved source resumes privately, corrections invalidate old review and foreign or missing rows cannot commit", () => {
  const { access, recipientId } = fixture(), key = randomUUID(), draft = create(access, key);
  assert.equal(create(access, key).id, draft.id);
  assert.throws(() => createImportDraft(access, { source: source.replace("1200.50", "99"), filename: "salary.csv", settings: normal, requestKey: key, corrections: {}, resolutions: {} }), /different source terms/);
  assert.throws(() => getImportDraft(fixture().access, draft.id), /not found/);
  const raw = row<{ payload_ciphertext: string }>("SELECT payload_ciphertext FROM payroll_import_drafts WHERE id=?", draft.id)!;
  assert.ok(raw.payload_ciphertext.startsWith("enc1:")); assert.ok(!raw.payload_ciphertext.includes("worker@example.test"));
  const changed = updateImportDraft(access, draft.id, { source, filename: "salary.csv", settings: normal, resolutions: { 2: recipientId }, corrections: { 2: { amount: "1500.25" } }, expectedVersion: 1 });
  assert.equal(changed.version, 2); assert.equal(changed.preview.principal, "1500250000"); assert.notEqual(changed.reviewToken, draft.reviewToken);
  assert.throws(() => commitImportDraft(access, draft.id, terms(draft)), /changed/);
  assert.throws(() => updateImportDraft(access, draft.id, { source, filename: "salary.csv", settings: normal, resolutions: { 99: recipientId }, corrections: {}, expectedVersion: 2 }), /no longer belongs/);
  assert.throws(() => create({ ...access, permissions: ["payments:read"] }), /permission/);
});

test("import commit preserves exact amounts, retries one run and rejects duplicate exact-period liabilities", () => {
  const { access } = fixture(), draft = create(access), accepted = terms(draft), committed = commitImportDraft(access, draft.id, accepted);
  assert.equal(committed.run.total, "1200500000"); assert.equal(committed.run.status, "draft");
  assert.equal(commitImportDraft(access, draft.id, accepted).run.id, committed.run.id);
  assert.throws(() => commitImportDraft(access, draft.id, { ...accepted, reference: "changed" }), /different terms/);
  const duplicate = create(access);
  assert.throws(() => commitImportDraft(access, duplicate.id, terms(duplicate)), /exact period/);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM payroll_runs WHERE organization_id=?", access.organizationId)!.n, 1);
  assert.equal(getImportDraft(access, draft.id).runId, committed.run.id);
});

test("expired source is purged without deleting an already created run or its retry identity", () => {
  const { access } = fixture(), draft = create(access), accepted = terms(draft), committed = commitImportDraft(access, draft.id, accepted);
  getDb().prepare("UPDATE payroll_import_drafts SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(draft.id);
  assert.throws(() => getImportDraft(access, draft.id), /retention expired/);
  assert.equal(row<{ payload_ciphertext: string }>("SELECT payload_ciphertext FROM payroll_import_drafts WHERE id=?", draft.id)!.payload_ciphertext, "");
  assert.equal(commitImportDraft(access, draft.id, accepted).run.id, committed.run.id);
});

test("mounted import routes preserve company scope and expose reviewed draft creation through the company API", async () => {
  const { access } = fixture(), other = fixture().access;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("access", c.req.header("fixture-other-company") ? other : access); await next(); });
  app.onError((error, c) => c.json({ code: error instanceof ApiError ? error.code : "INVALID_REQUEST" }, error instanceof ApiError ? error.status as 400 : 400));
  app.route("/payroll-import", payrollImportRoutes);
  const response = await app.request("/payroll-import/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, filename: "salary.csv", settings: normal, requestKey: randomUUID() }) });
  assert.equal(response.status, 201);
  const { draft } = await response.json() as { draft: ReturnType<typeof create> };
  assert.equal(draft.preview.principal, "1200500000");
  const foreign = await app.request(`/payroll-import/drafts/${draft.id}`, { headers: { "fixture-other-company": "yes" } });
  assert.equal(foreign.status, 404);
  const saved = await app.request(`/payroll-import/drafts/${draft.id}/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(terms(draft)) });
  assert.equal(saved.status, 201);
  assert.equal((await saved.json() as { run: { total: string } }).run.total, "1200500000");
});

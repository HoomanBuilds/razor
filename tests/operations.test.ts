import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, row, rows } from "../src/server/db";
import { PERMISSIONS, getAccess } from "../src/server/identity/session";
import { approveBill, createBill, createPayrollRun, approvePayrollRun } from "../src/server/business/service";
import { createRecurring, listNotices, readNotice, setRecurring, saveMandate } from "../src/server/operations/service";
import { tickOperations } from "../src/server/operations/worker";
import { executeApprovedAttempt } from "../src/server/operations/executor";
import type { OperationJob } from "../src/server/operations/types";
import { createImportDraft } from "../src/server/payroll-import/service";
import { reviewDocument, uploadDocument } from "../src/server/document-intake/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ac".repeat(32);
delete process.env.RAZOR_EXECUTOR_PRIVATE_KEY;

function fixture() {
  const db = getDb(), organizationId = randomUUID(), userId = randomUUID(), roleId = randomUUID(), recipientId = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(userId, "Owner", now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId, "Company", userId, now, now);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(roleId, organizationId, "Owner", JSON.stringify(PERMISSIONS), now);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(organizationId, userId, roleId, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'vendor','USDC','base',?,'confirmed',?,?,?)").run(recipientId, organizationId, "Supplier", `0x${"13".repeat(20)}`, now, now, now);
  const access = getAccess(userId, organizationId);
  const invoice = createBill(access, { recipientId, reference: "template", title: "Recurring service", amount: "10000000", maxFee: "1000000" });
  approveBill(access, invoice.id);
  const due = new Date(Date.now() - 60_000).toISOString();
  return { access, invoice, recipientId, due };
}

test("scheduled retention removes expired intake sources while preserving their financial records", async () => {
  const { access, invoice, recipientId } = fixture();
  const imported = createImportDraft(access, {
    requestKey: randomUUID(), filename: "retention.csv", source: `recipient_id,amount\n${recipientId},10`,
    settings: { delimiter: ",", decimal: ".", thousands: "", defaultCurrency: "USDC", defaultMaxFee: "1", mapping: { recipientId: "recipient_id", amount: "amount" } },
    corrections: {}, resolutions: {},
  });
  const uploaded = await uploadDocument(access, { filename: "retention.png", mediaType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/amcAAAAASUVORK5CYII=", "base64") });
  const reviewed = reviewDocument(access, uploaded.document.id, { revision: uploaded.document.revision, sourceHash: uploaded.document.sourceHash, recipientId, reference: "retain-bill", title: "Retained financial record", agreedUSDC: "10", maxFee: "1", reviewConfirmed: true });
  const db = getDb();
  db.prepare("UPDATE payroll_import_drafts SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(imported.id);
  db.prepare("UPDATE invoice_documents SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(uploaded.document.id);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ payload_ciphertext: string }>("SELECT payload_ciphertext FROM payroll_import_drafts WHERE id=?", imported.id)!.payload_ciphertext, "");
  assert.equal(row("SELECT id FROM invoice_documents WHERE id=?", uploaded.document.id), undefined);
  assert.ok(row("SELECT id FROM bills WHERE id=?", reviewed.billId));
  assert.equal(row<{ status: string }>("SELECT status FROM bills WHERE id=?", invoice.id)!.status, "approved");
});

test("durable recurring jobs create one unapproved draft across ticks and recovered leases", async () => {
  const { access, invoice, due } = fixture();
  const rule = createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  assert.equal(createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" }).id, rule.id);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  getDb().prepare("UPDATE operation_jobs SET status='running',lease_owner='lost-worker',lease_expires_at=?,run_at=? WHERE organization_id=? AND kind='recurring'").run(due, due, access.organizationId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 2);
  const generated = row<{ status: string; approved_at: string | null }>("SELECT status,approved_at FROM payments WHERE organization_id=? AND id!=?", access.organizationId, invoice.payment_id)!;
  assert.equal(generated.status, "draft");
  assert.equal(generated.approved_at, null);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_occurrences WHERE rule_id=?", rule.id)!.n, 1);
  assert.equal(createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" }).id, rule.id);
  assert.throws(() => createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: new Date(Date.parse(due) + 60_000).toISOString(), maxAmount: "10000000" }), /changing its terms/);
  const notices = listNotices(access);
  const draftNotice = notices.find((notice) => notice.title === "Recurring draft ready")!;
  assert.ok(draftNotice);
  readNotice(access, draftNotice.id);
  const colleagueId = randomUUID();
  getDb().prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(colleagueId, "Colleague", due);
  const colleague = { ...access, userId: colleagueId };
  assert.ok(listNotices(access).find((notice) => notice.id === draftNotice.id)?.read_at);
  assert.equal(listNotices(colleague).find((notice) => notice.id === draftNotice.id)?.read_at, null);
  assert.equal(listNotices({ ...colleague, permissions: ["company:read"] }).length, 0);
});

test("pause blocks new recurring drafts while reconciliation jobs keep running", async () => {
  const { access, invoice, due } = fixture();
  createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  getDb().prepare("UPDATE organizations SET paused=1 WHERE id=?").run(access.organizationId);
  getDb().prepare("UPDATE payments SET status='paid' WHERE id=?").run(invoice.payment_id);
  getDb().prepare("INSERT INTO operation_jobs(id,organization_id,job_key,kind,entity_id,run_at,created_at,updated_at) VALUES(?,?,?,'reconcile_payment',?,?,?,?)").run(randomUUID(), access.organizationId, "reconcile-existing", invoice.payment_id, due, due, due);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 1);
  assert.equal(row<{ status: string }>("SELECT status FROM operation_jobs WHERE organization_id=? AND kind='recurring'", access.organizationId)!.status, "blocked");
  assert.equal(row<{ status: string }>("SELECT status FROM operation_jobs WHERE organization_id=? AND job_key='reconcile-existing'", access.organizationId)!.status, "completed");
  getDb().prepare("UPDATE organizations SET paused=0 WHERE id=?").run(access.organizationId);
  getDb().prepare("UPDATE operation_jobs SET run_at=? WHERE organization_id=? AND status='blocked'").run(due, access.organizationId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 2);
});

test("changed destination versions hold recurring work and partial source invoices are rejected", async () => {
  const { access, invoice, recipientId, due } = fixture();
  const rule = createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(recipientId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ status: string; enabled: number }>("SELECT status,enabled FROM recurring_rules WHERE id=?", rule.id)!.status, "held");
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM bills WHERE organization_id=?", access.organizationId)!.n, 1);
  assert.equal(rows("SELECT * FROM recurring_occurrences WHERE rule_id=? AND status='held'", rule.id).length, 1);
  getDb().prepare("UPDATE payments SET amount='5000000' WHERE id=?").run(invoice.payment_id);
  assert.throws(() => createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" }), /partial installments/);
});

test("a held recurring occurrence requires a new reviewed template instead of a stuck resume", async () => {
  const { access, invoice, recipientId, due } = fixture();
  const rule = createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(recipientId);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  getDb().prepare("UPDATE recipients SET version=version-1 WHERE id=?").run(recipientId);
  assert.throws(() => setRecurring(access, rule.id, true), /held occurrence/);
  setRecurring(access, rule.id, false);
  assert.throws(() => setRecurring(access, rule.id, true), /held occurrence/);
  const replacement = createRecurring(access, { kind: "bill", entityId: invoice.id, intervalDays: 30, nextRunAt: due, maxAmount: "10000000" });
  assert.notEqual(replacement.id, rule.id);
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_occurrences WHERE rule_id=? AND status='drafted'", replacement.id)!.n, 1);
  assert.equal(row<{ enabled: number }>("SELECT enabled FROM recurring_rules WHERE id=?", rule.id)!.enabled, 0);
});

test("executor bounds cannot be attached to another company's configured worker", () => {
  const { access } = fixture();
  const saved = [process.env.RAZOR_EXECUTOR_ACCOUNT_ID, process.env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID, process.env.RAZOR_EXECUTOR_NETWORK];
  Object.assign(process.env, { RAZOR_EXECUTOR_ACCOUNT_ID: "worker.near", RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID: "other-treasury.near", RAZOR_EXECUTOR_NETWORK: "mainnet" });
  try { assert.throws(() => saveMandate(access, { enabled: true, maxAmount: "10000000", expiresAt: new Date(Date.now()+3600000).toISOString() }), /dedicated NEAR executor/); }
  finally { for (const [index, key] of ["RAZOR_EXECUTOR_ACCOUNT_ID", "RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID", "RAZOR_EXECUTOR_NETWORK"].entries()) { if(saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; } }
});

test("monthly payroll creates the next calendar entitlement and advances one durable cycle", async () => {
  const { access, recipientId } = fixture();
  const original = createPayrollRun(access, { reference: "monthly-source", periodStart: "2025-12-01", periodEnd: "2025-12-31", scheduledFor: "2026-01-01T09:00:00Z", items: [{ recipientId, amount: "1000000" }] });
  approvePayrollRun(access, original.id);
  const rule = createRecurring(access, { kind: "payroll", entityId: original.id, intervalDays: 1, cadence: "months", intervalMonths: 1, nextRunAt: "2026-02-01T09:00:00Z", maxAmount: "1000000" });
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  const generated = row<{ period_start: string; period_end: string; status: string }>("SELECT period_start,period_end,status FROM payroll_runs WHERE organization_id=? AND id!=?", access.organizationId, original.id)!;
  assert.equal(generated.period_start, "2026-01-01");
  assert.equal(generated.period_end, "2026-01-31");
  assert.equal(generated.status, "draft");
  assert.equal(row<{ next_run_at: string }>("SELECT next_run_at FROM recurring_rules WHERE id=?", rule.id)?.next_run_at, "2026-03-01T09:00:00.000Z");
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM recurring_occurrences WHERE rule_id=?", rule.id)?.n, 1);
});

test("recurring payroll preserves the approved net components and supplied explanation", async () => {
  const { access, recipientId, due } = fixture();
  const source = createPayrollRun(access, { reference: "component-template", periodStart: "2026-10-01", periodEnd: "2026-10-31", items: [{ recipientId, amount: "115", baseAmount: "100", bonusAmount: "20", adjustmentAmount: "-5", note: "Approved supplied correction", maxFee: "1" }] });
  approvePayrollRun(access, source.id);
  createRecurring(access, { kind: "payroll", entityId: source.id, intervalDays: 30, nextRunAt: due, maxAmount: "115" });
  await tickOperations({ organizationId: access.organizationId, maxJobs: 20 });
  const terms = row<{ base_amount: string; bonus_amount: string; adjustment_amount: string; note_ciphertext: string }>("SELECT t.* FROM payroll_item_terms t JOIN payroll_items i ON i.id=t.item_id JOIN payroll_runs r ON r.id=i.run_id WHERE r.organization_id=? AND r.id!=?", access.organizationId, source.id)!;
  assert.equal(terms.base_amount, "100"); assert.equal(terms.bonus_amount, "20"); assert.equal(terms.adjustment_amount, "-5");
  assert.ok(terms.note_ciphertext.startsWith("enc1:"));
});

test("the restricted worker refuses changed treasury code before parsing or broadcasting its signer", async () => {
  const { access, invoice } = fixture(), db = getDb(), at = new Date().toISOString(), attemptId = randomUUID(), account = `treasury-${access.organizationId.slice(0,8)}.testnet`;
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'testnet','usdc.testnet',?)").run(access.organizationId, account, at);
  db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','prepared','{}','USDC','near','supplier.testnet','10000000','10000000','solver.testnet',?,?)").run(attemptId, invoice.payment_id!, access.organizationId, at, at);
  db.prepare("INSERT INTO agent_mandates(organization_id,executor_account_id,max_amount,expires_at,enabled,created_by,updated_at) VALUES(?,'executor.testnet','11000000',?,1,?,?)").run(access.organizationId, new Date(Date.now()+3600000).toISOString(), access.userId, at);
  const keys = ["RAZOR_EXECUTOR_ACCOUNT_ID", "RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID", "RAZOR_EXECUTOR_NETWORK", "RAZOR_EXECUTOR_PRIVATE_KEY", "NEAR_TREASURY_CODE_HASH"], saved = keys.map(key=>process.env[key]), fetch = globalThis.fetch;
  Object.assign(process.env, { RAZOR_EXECUTOR_ACCOUNT_ID: "executor.testnet", RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID: account, RAZOR_EXECUTOR_NETWORK: "testnet", RAZOR_EXECUTOR_PRIVATE_KEY: "unusable-fixture-key", NEAR_TREASURY_CODE_HASH: "11111111111111111111111111111111" });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); assert.equal(request.method, "query");
    const params = request.params;
    if (params.request_type === "view_account") return Response.json({ result: { code_hash: "unreviewed-code-not-live" } });
    const value = params.method_name === "get_payment" ? { attempts: [{ id: attemptId, status: "prepared", authorized: true }], status: "approved" } : {};
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
  };
  try {
    const result = await executeApprovedAttempt({ organization_id: access.organizationId, entity_id: attemptId } as OperationJob, access);
    assert.equal(result.status, "blocked"); assert.match(String((result.detail as { reason: string }).reason), /treasury code changed/);
    assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM operation_submissions WHERE attempt_id=?", attemptId)!.count, 0);
  } finally { globalThis.fetch = fetch; for (const [index,key] of keys.entries()) { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; } }
});

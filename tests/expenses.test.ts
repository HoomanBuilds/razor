import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { decrypt, encrypt, hashToken } from "../src/server/identity/crypto";
import { getAccess, PERMISSIONS } from "../src/server/identity/session";
import { getRecipient, saveVersion } from "../src/server/identity/recipients";
import { deleteDocument, getDocument, reviewDocument, saveDocumentText, uploadDocument } from "../src/server/document-intake/service";
import { assertOrdinaryExpenseDocumentReview, assertOrdinaryExpenseSourceReview } from "../src/server/expenses/guard";
import { personalExpenseRoutes } from "../src/server/expenses";
import { cancelExpense, companyExpense, companyExpenseOriginal, correctExpense, expenseInput, getExpensePolicy, listCompanyExpenses, ownExpense, ownExpenseOriginal, personalExpenseOverview, reviewExpense, saveExpensePolicy, submitExpense } from "../src/server/expenses/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "73".repeat(32);
process.env.APP_URL = "http://localhost:3000";
process.env.NEAR_AI_API_KEY = "";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/amcAAAAASUVORK5CYII=", "base64");
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
function fixture() {
  const db = getDb(), organizationId = randomUUID(), owner = randomUUID(), staff = randomUUID(), other = randomUUID(), recipientId = randomUUID(), stamp = new Date().toISOString();
  for (const [id, name] of [[owner, "Finance owner"], [staff, "Staff one"], [other, "Staff two"]]) db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, name, stamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId, "Expense company", owner, stamp, stamp);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,'Owner',?,1,?)").run(owner, organizationId, JSON.stringify(PERMISSIONS), stamp);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(organizationId, owner, owner, stamp);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'employee','USDC','near','employee.near','confirmed',?,?,?)")
    .run(recipientId, organizationId, staff, encrypt("Confirmed employee"), stamp, stamp, stamp);
  saveVersion(getRecipient(organizationId, recipientId), staff);
  const token = randomUUID();
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), staff, hashToken(token), new Date(Date.now() + 3600000).toISOString(), stamp);
  return { organizationId, owner, staff, other, recipientId, access: getAccess(owner, organizationId), cookie: `razor_session=${token}` };
}
function input(changes = {}) { return { merchant: "Train Company", receiptReference: randomUUID(), expenseDate: new Date().toISOString().slice(0, 10), amountUSDC: "12.345678", purpose: "Approved client visit travel", costCenter: "Sales", ...changes }; }
function file() { return { filename: "private-receipt.png", mediaType: "image/png", bytes: Buffer.concat([png, Buffer.from(randomUUID())]) }; }
async function submitted(f = fixture(), changes = {}) {
  const fields = input(changes), source = file(), result = await submitExpense(f.staff, f.recipientId, randomUUID(), fields, source);
  return { ...f, fields, source, expense: result.expense };
}
function review(f: Awaited<ReturnType<typeof submitted>>, decision: "accept" | "return" | "reject", note = "Finance checked this receipt", maxFeeUSDC = "1") {
  return reviewExpense(f.access, f.expense.id, { reviewToken: companyExpense(f.access, f.expense.id).reviewToken, decision, note, maxFeeUSDC, confirmed: true });
}

test("staff uploads reuse encrypted document storage without granting company access or leaking another person's receipts", async () => {
  const f = await submitted(), raw = row<{ payload_ciphertext: string; recipient_snapshot_ciphertext: string; document_id: string }>("SELECT * FROM expense_requests WHERE id=?", f.expense.id)!;
  assert.equal(f.expense.status, "submitted"); assert.equal(f.expense.amount, "12345678"); assert.equal(f.expense.receipt!.filename, "private-receipt.png");
  assert.notEqual(raw.payload_ciphertext, JSON.stringify(f.fields)); assert.equal(JSON.parse(decrypt(raw.payload_ciphertext)).purpose, f.fields.purpose);
  assert.equal(row<{ created_by: string }>("SELECT created_by FROM invoice_documents WHERE id=?", raw.document_id)!.created_by, f.staff);
  assert.throws(() => getAccess(f.staff, f.organizationId), hasCode("COMPANY_ACCESS_DENIED"));
  assert.equal(personalExpenseOverview(f.staff).expenses.length, 1); assert.equal(personalExpenseOverview(f.other).expenses.length, 0);
  assert.throws(() => ownExpense(f.other, f.expense.id), hasCode("EXPENSE_NOT_FOUND")); assert.throws(() => ownExpenseOriginal(f.other, f.expense.id), hasCode("EXPENSE_NOT_FOUND"));
  assert.deepEqual(ownExpenseOriginal(f.staff, f.expense.id).bytes, f.source.bytes);
  assert.equal(listCompanyExpenses(f.access).expenses[0].id, f.expense.id);
  companyExpenseOriginal(f.access, f.expense.id);
  assert.equal(row<{ user_id: string }>("SELECT user_id FROM identity_audit WHERE action='document.original_downloaded' AND entity_id=? ORDER BY rowid DESC LIMIT 1", raw.document_id)!.user_id, f.owner);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.organizationId)!.count, 0);
});

test("exact upload retries are idempotent and immutable receipt content or normalized identities cannot create another request", async () => {
  const f = fixture(), fields = input(), source = file(), key = randomUUID();
  const first = await submitExpense(f.staff, f.recipientId, key, fields, source), repeated = await submitExpense(f.staff, f.recipientId, key, fields, source);
  assert.equal(repeated.expense.id, first.expense.id); assert.equal(repeated.duplicate, true);
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, key, { ...fields, amountUSDC: "1" }, source), hasCode("EXPENSE_REQUEST_CONFLICT"));
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), input(), source), hasCode("EXPENSE_DUPLICATE"));
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), { ...fields, merchant: "  TRAIN   COMPANY  ", receiptReference: fields.receiptReference.toUpperCase() }, file()), hasCode("EXPENSE_DUPLICATE"));
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM expense_requests WHERE organization_id=?", f.organizationId)!.count, 1);
});

test("an ordinary reviewed invoice owns its source before expense intake can reserve or expose it", async () => {
  const f = fixture(), source = file(), original = await uploadDocument(f.access, source);
  reviewDocument(f.access, original.document.id, { revision: original.document.revision, sourceHash: original.document.sourceHash, recipientId: f.recipientId, reference: "ALREADY-REVIEWED", title: "Private finance details", agreedUSDC: "12", maxFee: "1", reviewConfirmed: true });
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), input(), source), hasCode("EXPENSE_DUPLICATE"));
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM expense_requests WHERE organization_id=?", f.organizationId)!.count, 0);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.organizationId)!.count, 1);
});

test("expense policy is persisted and concurrent requests cannot exceed the original UTC submission-month limit", async () => {
  const f = fixture();
  saveExpensePolicy(f.access, { expectedVersion: 0, enabled: true, perExpenseLimitUSDC: "40", monthlyPersonLimitUSDC: "50", requireCostCenter: true, costCenters: ["Sales"] });
  assert.equal(getExpensePolicy(f.access).version, 1);
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), input({ amountUSDC: "41" }), file()), hasCode("EXPENSE_POLICY_HOLD"));
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), input({ costCenter: "Unknown" }), file()), hasCode("EXPENSE_POLICY_HOLD"));
  const attempts = await Promise.allSettled([submitExpense(f.staff, f.recipientId, randomUUID(), input({ amountUSDC: "30", expenseDate: "2020-01-01" }), file()), submitExpense(f.staff, f.recipientId, randomUUID(), input({ amountUSDC: "30", expenseDate: "2021-01-01" }), file())]);
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1); assert.equal(personalExpenseOverview(f.staff).expenses.length, 1);
  assert.throws(() => saveExpensePolicy(f.access, { expectedVersion: 0, enabled: true, perExpenseLimitUSDC: null, monthlyPersonLimitUSDC: null, requireCostCenter: false, costCenters: [] }), hasCode("EXPENSE_POLICY_CHANGED"));
});

test("return, correction and resubmission preserve receipt, prior amount and decision history", async () => {
  const f = await submitted(), returned = review(f, "return", "Explain the exact business purpose");
  const corrected = correctExpense(f.staff, f.expense.id, { ...f.fields, amountUSDC: "10", purpose: "Clarified client visit purpose", expectedVersion: returned.version });
  assert.equal(corrected.id, f.expense.id); assert.equal(corrected.amount, "10000000"); assert.equal(corrected.status, "submitted");
  assert.equal(corrected.receipt!.sourceHash, f.expense.receipt!.sourceHash); assert.ok(corrected.events.some(value => value.note === "Explain the exact business purpose"));
  const history = companyExpense(f.access, f.expense.id).history; assert.equal(history.length, 2); assert.equal(history[1].amount, "12345678");
  assert.throws(() => correctExpense(f.staff, f.expense.id, { ...f.fields, expectedVersion: returned.version }), hasCode("EXPENSE_CORRECTION_LOCKED"));
});

test("a reviewed expense creates one exact bill draft and never transfers its request approval into payment authority", async () => {
  const f = await submitted(), accepted = review(f, "accept", "Reviewed staff expense", "1.5");
  assert.equal(accepted.status, "accepted"); assert.ok(accepted.billId);
  const bill = row<{ amount: string; max_fee: string; status: string; payment_id: string; cost_center_reference: string }>("SELECT * FROM bills WHERE id=?", accepted.billId!)!;
  assert.equal(bill.amount, "12345678"); assert.equal(bill.max_fee, "1500000"); assert.equal(bill.status, "draft"); assert.equal(decrypt(bill.cost_center_reference), "Sales");
  const payment = row<{ status: string; approved_by: string | null; recipient_id: string }>("SELECT * FROM payments WHERE id=?", bill.payment_id)!;
  assert.equal(payment.status, "draft"); assert.equal(payment.approved_by, null); assert.equal(payment.recipient_id, f.recipientId);
  assert.equal(review(f, "accept", "Repeated review request", "1.5").billId, accepted.billId);
  assert.throws(() => review(f, "accept", "Changed fee", "2"), hasCode("EXPENSE_ALREADY_ACCEPTED"));
  assert.throws(() => cancelExpense(f.staff, f.expense.id, accepted.version), hasCode("EXPENSE_CANCELLATION_LOCKED"));
  assert.throws(() => correctExpense(f.staff, f.expense.id, { ...f.fields, expectedVersion: accepted.version }), hasCode("EXPENSE_CORRECTION_LOCKED"));
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.organizationId)!.count, 1);
});

test("changed source, policy or recipient invalidates stale review and profile reassignment never transfers prior staff history", async () => {
  const f = await submitted(), detail = companyExpense(f.access, f.expense.id), documentId = row<{ document_id: string }>("SELECT document_id FROM expense_requests WHERE id=?", f.expense.id)!.document_id;
  const document = getDocument(f.access, documentId); saveDocumentText(f.access, documentId, document.revision, "Staff original receipt reviewed text");
  assert.throws(() => reviewExpense(f.access, f.expense.id, { reviewToken: detail.reviewToken, decision: "accept", note: "Stale source", confirmed: true }), hasCode("EXPENSE_REVIEW_CHANGED"));
  const beforePolicy = companyExpense(f.access, f.expense.id).reviewToken;
  saveExpensePolicy(f.access, { expectedVersion: 0, enabled: true, perExpenseLimitUSDC: "10", monthlyPersonLimitUSDC: null, requireCostCenter: false, costCenters: [] });
  assert.throws(() => reviewExpense(f.access, f.expense.id, { reviewToken: beforePolicy, decision: "accept", note: "Stale policy", confirmed: true }), hasCode("EXPENSE_REVIEW_CHANGED"));
  assert.throws(() => review(f, "accept"), hasCode("EXPENSE_POLICY_HOLD"));
  saveExpensePolicy(f.access, { expectedVersion: 1, enabled: true, perExpenseLimitUSDC: null, monthlyPersonLimitUSDC: null, requireCostCenter: false, costCenters: [] });
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(f.recipientId);
  assert.throws(() => review(f, "accept"), hasCode("EXPENSE_PROFILE_CHANGED"));
  getDb().prepare("UPDATE recipients SET user_id=? WHERE id=?").run(f.other, f.recipientId);
  assert.equal(ownExpense(f.staff, f.expense.id).id, f.expense.id); assert.deepEqual(ownExpenseOriginal(f.staff, f.expense.id).bytes, f.source.bytes);
  assert.throws(() => ownExpense(f.other, f.expense.id), hasCode("EXPENSE_NOT_FOUND")); assert.equal(personalExpenseOverview(f.other).expenses.length, 0);
  review(f, "return"); assert.throws(() => correctExpense(f.staff, f.expense.id, { ...f.fields, expectedVersion: ownExpense(f.staff, f.expense.id).version }), hasCode("EXPENSE_PROFILE_REQUIRED"));
});

test("partial payment, cancellation and retention preserve the original reimbursement liability without a second full payout", async () => {
  const f = await submitted(), accepted = review(f, "accept"), bill = row<{ payment_id: string }>("SELECT payment_id FROM bills WHERE id=?", accepted.billId!)!;
  getDb().prepare("UPDATE payments SET status='partially_paid',delivered_amount='345678',total_spent='345678' WHERE id=?").run(bill.payment_id);
  const partial = ownExpense(f.staff, f.expense.id); assert.equal(partial.reimbursement!.status, "partially_paid"); assert.equal(partial.reimbursement!.deliveredAmount, "345678"); assert.equal(partial.reimbursement!.remainingLiability, "12000000");
  getDb().prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(bill.payment_id);
  assert.equal(ownExpense(f.staff, f.expense.id).reimbursement!.needsReview, true); assert.equal(review(f, "accept").billId, accepted.billId);
  const documentId = row<{ document_id: string }>("SELECT document_id FROM expense_requests WHERE id=?", f.expense.id)!.document_id, document = getDocument(f.access, documentId);
  deleteDocument(f.access, documentId, document.revision);
  assert.throws(() => ownExpenseOriginal(f.staff, f.expense.id), hasCode("EXPENSE_RECEIPT_UNAVAILABLE")); assert.equal(ownExpense(f.staff, f.expense.id).billId, accepted.billId);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.organizationId)!.count, 1);
});

test("expired receipt prevents acceptance but retains personal metadata and permits an explicit rejection", async () => {
  const f = await submitted();
  getDb().prepare("UPDATE invoice_documents SET expires_at=? WHERE id=(SELECT document_id FROM expense_requests WHERE id=?)").run("2020-01-01T00:00:00.000Z", f.expense.id);
  assert.equal(ownExpense(f.staff, f.expense.id).receipt, null); assert.throws(() => review(f, "accept"), hasCode("EXPENSE_RECEIPT_UNAVAILABLE"));
  assert.equal(review(f, "reject", "Receipt unavailable; submit corrected source").status, "rejected");
});

test("the ordinary document guard protects the source-hash extraction window before the document link exists", async () => {
  const f = fixture(), promise = submitExpense(f.staff, f.recipientId, randomUUID(), input(), file());
  const pending = row<{ document_id: string | null; source_hash: string }>("SELECT document_id,source_hash FROM expense_requests WHERE organization_id=?", f.organizationId)!;
  assert.equal(pending.document_id, null);
  const source = row<{ id: string }>("SELECT id FROM invoice_documents WHERE organization_id=? AND source_hash=?", f.organizationId, pending.source_hash)!;
  assert.throws(() => assertOrdinaryExpenseDocumentReview(f.access, source.id), hasCode("EXPENSE_REVIEW_REQUIRED"));
  assert.throws(() => assertOrdinaryExpenseSourceReview(f.access, pending.source_hash), hasCode("EXPENSE_REVIEW_REQUIRED"));
  const result = await promise;
  assert.throws(() => assertOrdinaryExpenseDocumentReview(f.access, source.id), hasCode("EXPENSE_REVIEW_REQUIRED"));
  review({ ...f, fields: input(), source: file(), expense: result.expense }, "accept");
  assert.throws(() => assertOrdinaryExpenseSourceReview(f.access, pending.source_hash), hasCode("EXPENSE_REVIEW_REQUIRED"));
});

test("linked replacement is the only active correction and preserves the original policy month while uploading a real new receipt", async () => {
  const f = await submitted(), rejected = review(f, "reject", "Original source needs replacement"), stamp = "2020-01-15T00:00:00.000Z";
  getDb().prepare("UPDATE expense_requests SET submitted_at=?,policy_month='2020-01' WHERE id=?").run(stamp, f.expense.id);
  const replacementFields = { ...f.fields, replacesExpenseId: f.expense.id }, replacementFile = file(), key = randomUUID();
  const replacement = await submitExpense(f.staff, f.recipientId, key, replacementFields, replacementFile);
  assert.notEqual(replacement.expense.id, f.expense.id); assert.equal(replacement.expense.policyMonth, "2020-01"); assert.equal(replacement.expense.submittedAt.slice(0, 4), new Date().toISOString().slice(0, 4));
  const parent = ownExpense(f.staff, f.expense.id); assert.equal(parent.supersededBy, replacement.expense.id); assert.equal(parent.canReplace, false); assert.ok(parent.events.some(value => value.decision === "superseded"));
  assert.throws(() => correctExpense(f.staff, f.expense.id, { ...f.fields, expectedVersion: parent.version }), hasCode("EXPENSE_LINEAGE_LOCKED"));
  assert.throws(() => review(f, "accept"), hasCode("EXPENSE_LINEAGE_LOCKED"));
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), { ...replacementFields, receiptReference: randomUUID() }, file()), hasCode("EXPENSE_LINEAGE_LOCKED"));
  getDb().prepare("UPDATE expense_requests SET status='preparing' WHERE id=?").run(replacement.expense.id);
  assert.doesNotThrow(() => assertOrdinaryExpenseSourceReview(f.access, replacement.expense.receipt!.sourceHash));
  assert.throws(() => assertOrdinaryExpenseSourceReview(f.access, f.expense.receipt!.sourceHash), hasCode("EXPENSE_REVIEW_REQUIRED"));
  getDb().prepare("UPDATE expense_requests SET status='submitted' WHERE id=?").run(replacement.expense.id);
  const child = { ...f, fields: replacementFields, source: replacementFile, expense: replacement.expense }, accepted = review(child, "accept");
  const paymentId = row<{ payment_id: string }>("SELECT payment_id FROM bills WHERE id=?", accepted.billId!)!.payment_id;
  getDb().prepare("UPDATE payments SET status='partially_paid',delivered_amount='1000000' WHERE id=?").run(paymentId);
  assert.throws(() => correctExpense(f.staff, f.expense.id, { ...f.fields, expectedVersion: parent.version }), hasCode("EXPENSE_LINEAGE_LOCKED"));
  assert.throws(() => reviewExpense(f.access, f.expense.id, { reviewToken: companyExpense(f.access, f.expense.id).reviewToken, decision: "accept", note: "Try a second full claim", confirmed: true }), hasCode("EXPENSE_LINEAGE_LOCKED"));
  assert.equal((await submitExpense(f.staff, f.recipientId, key, replacementFields, replacementFile)).expense.billId, accepted.billId);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.organizationId)!.count, 1);
  assert.equal(rejected.status, "rejected");
});

test("an expired original can be explicitly reuploaded with the same hash and reference without restoring another person's data", async () => {
  const f = await submitted(); review(f, "reject", "Expired receipt needs a fresh retained upload");
  const originalId = row<{ document_id: string }>("SELECT document_id FROM expense_requests WHERE id=?", f.expense.id)!.document_id;
  getDb().prepare("UPDATE invoice_documents SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(originalId);
  const replacement = await submitExpense(f.staff, f.recipientId, randomUUID(), { ...f.fields, replacesExpenseId: f.expense.id }, f.source);
  assert.ok(replacement.expense.receipt); assert.equal(replacement.expense.receipt.sourceHash, f.expense.receipt!.sourceHash);
  assert.notEqual(row<{ document_id: string }>("SELECT document_id FROM expense_requests WHERE id=?", replacement.expense.id)!.document_id, originalId);
  assert.equal(ownExpense(f.staff, f.expense.id).receipt, null); assert.deepEqual(ownExpenseOriginal(f.staff, replacement.expense.id).bytes, f.source.bytes);
  assert.throws(() => assertOrdinaryExpenseSourceReview(f.access, f.expense.receipt!.sourceHash), hasCode("EXPENSE_REVIEW_REQUIRED"));
});

test("replacement caps use the family's original month and accepted ancestors cannot be hidden behind a rejected child", async () => {
  const f = await submitted({ ...fixture() }, { amountUSDC: "8" }); review(f, "reject", "Correct the original receipt");
  getDb().prepare("UPDATE expense_requests SET policy_month='2020-01' WHERE id=?").run(f.expense.id);
  const other = await submitExpense(f.staff, f.recipientId, randomUUID(), input({ amountUSDC: "8" }), file());
  getDb().prepare("UPDATE expense_requests SET policy_month='2020-01' WHERE id=?").run(other.expense.id);
  saveExpensePolicy(f.access, { expectedVersion: 0, enabled: true, perExpenseLimitUSDC: "10", monthlyPersonLimitUSDC: "10", requireCostCenter: false, costCenters: [] });
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), { ...f.fields, replacesExpenseId: f.expense.id }, file()), hasCode("EXPENSE_POLICY_HOLD"));
  cancelExpense(f.staff, other.expense.id, other.expense.version);
  const child = await submitExpense(f.staff, f.recipientId, randomUUID(), { ...f.fields, replacesExpenseId: f.expense.id }, file());
  review({ ...f, expense: child.expense }, "reject", "Child source rejected");
  const ordinary = await uploadDocument(f.access, file());
  const unrelated = reviewDocument(f.access, ordinary.document.id, { revision: ordinary.document.revision, sourceHash: ordinary.document.sourceHash, recipientId: f.recipientId, reference: "INDEPENDENT-ANCESTOR-FIXTURE", title: "Existing reimbursement", agreedUSDC: "8", maxFee: "1", reviewConfirmed: true });
  getDb().prepare("UPDATE expense_requests SET bill_id=? WHERE id=?").run(unrelated.billId, f.expense.id);
  assert.throws(() => correctExpense(f.staff, child.expense.id, { ...f.fields, replacesExpenseId: f.expense.id, expectedVersion: ownExpense(f.staff, child.expense.id).version }), hasCode("EXPENSE_LINEAGE_LOCKED"));
  await assert.rejects(() => submitExpense(f.staff, f.recipientId, randomUUID(), { ...f.fields, replacesExpenseId: child.expense.id }, file()), hasCode("EXPENSE_LINEAGE_LOCKED"));
});

test("actual concurrent database writers cannot branch the same rejected receipt into two reimbursement requests", async () => {
  const f = await submitted(); review(f, "reject", "Original receipt needs replacement");
  const directory = mkdtempSync(join(tmpdir(), "razor-expense-race-")), filename = join(directory, "race.sqlite");
  getDb().exec(`VACUUM INTO '${filename.replaceAll("'", "''")}'`);
  const modulePath = new URL("../src/server/expenses/service.ts", import.meta.url).href;
  function child() {
    const fields = { ...f.fields, replacesExpenseId: f.expense.id }, source = file();
    const code = `import {submitExpense} from ${JSON.stringify(modulePath)};try{await submitExpense(${JSON.stringify(f.staff)},${JSON.stringify(f.recipientId)},${JSON.stringify(randomUUID())},${JSON.stringify(fields)},{filename:'receipt.png',mediaType:'image/png',bytes:Buffer.from(${JSON.stringify(source.bytes.toString("base64"))},'base64')});console.log('submitted')}catch(error){console.log(error.code??error.message)}`;
    return new Promise<string>((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, ["--max-old-space-size=256", "--import", "tsx", "--input-type=module", "-e", code], { cwd: globalThis.process.cwd(), env: { ...globalThis.process.env, DATABASE_PATH: filename }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", error = ""; process.stdout.on("data", value => { output += value; }); process.stderr.on("data", value => { error += value; }); process.on("error", reject); process.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
    });
  }
  try {
    assert.deepEqual((await Promise.all([child(), child()])).sort(), ["EXPENSE_LINEAGE_LOCKED", "submitted"]);
    const db = new DatabaseSync(filename); try {
      assert.equal((db.prepare("SELECT COUNT(*) count FROM expense_requests WHERE replaces_expense_id=?").get(f.expense.id) as { count: number }).count, 1);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("lineage migration preserves legacy expense rows, version history, decisions and foreign-key targets inside the real migration transaction", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE recipients(id TEXT PRIMARY KEY); CREATE TABLE bills(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES('o'); INSERT INTO users VALUES('u'); INSERT INTO recipients VALUES('r');");
    db.exec(readFileSync("db/migrations/047-expenses.sql", "utf8"));
    const insert = db.prepare("INSERT INTO expense_requests(id,organization_id,submitted_by,recipient_id,recipient_version,recipient_snapshot_ciphertext,submitter_name_ciphertext,request_key,request_hash,source_hash,identity_hash,amount,payload_ciphertext,status,replaces_expense_id,submitted_at,updated_at) VALUES(?,'o','u','r',1,'snapshot','name',?,'request',?,?,'1','fields','rejected',?,?,?)");
    insert.run("parent", "parent-key", "parent-source", "parent-identity", null, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    insert.run("child", "child-key", "child-source", "child-identity", "parent", "2020-02-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z");
    db.prepare("INSERT INTO expense_versions VALUES('parent',1,'fields','snapshot','1','u','2020-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO expense_events VALUES('event','parent','u','rejected','note','2020-01-01T00:00:00.000Z')").run();
    db.exec("BEGIN IMMEDIATE"); db.exec(readFileSync("db/migrations/049-expense-correction-lineage.sql", "utf8")); db.exec("COMMIT");
    assert.equal((db.prepare("SELECT superseded_by FROM expense_requests WHERE id='parent'").get() as { superseded_by: string }).superseded_by, "child");
    assert.equal((db.prepare("SELECT policy_month FROM expense_requests WHERE id='child'").get() as { policy_month: string }).policy_month, "2020-01");
    assert.equal((db.prepare("SELECT payload_ciphertext FROM expense_versions WHERE expense_id='parent'").get() as { payload_ciphertext: string }).payload_ciphertext, "fields");
    assert.equal((db.prepare("SELECT note_ciphertext FROM expense_events WHERE expense_id='parent'").get() as { note_ciphertext: string }).note_ciphertext, "note");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("current company permissions are rechecked and another company cannot inspect expense records", async () => {
  const f = await submitted(), stranger = fixture();
  assert.throws(() => companyExpense(stranger.access, f.expense.id), hasCode("EXPENSE_NOT_FOUND"));
  getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(["company:read", "payments:read"]), f.owner);
  assert.throws(() => listCompanyExpenses(f.access), hasCode("FORBIDDEN")); assert.throws(() => review(f, "accept"), hasCode("FORBIDDEN"));
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.organizationId)!.count, 0);
});

test("cancelled unaccepted requests resume their original identity and stale uploads recover without creating money", async () => {
  const f = await submitted(), cancelled = cancelExpense(f.staff, f.expense.id, f.expense.version);
  const resumed = correctExpense(f.staff, f.expense.id, { ...f.fields, expectedVersion: cancelled.version });
  assert.equal(resumed.id, f.expense.id); assert.equal(resumed.status, "submitted"); assert.ok(resumed.events.some(value => value.decision === "cancelled"));
  getDb().prepare("UPDATE expense_requests SET status='uploading',updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", f.expense.id);
  const recovered = personalExpenseOverview(f.staff).expenses.find(value => value.id === f.expense.id)!;
  assert.equal(recovered.status, "returned"); assert.ok(recovered.receipt); assert.ok(recovered.events.some(value => value.decision === "upload_interrupted"));
  assert.equal(row<{ actor_id: string | null }>("SELECT actor_id FROM expense_events WHERE expense_id=? AND decision='upload_interrupted'", f.expense.id)!.actor_id, null);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.organizationId)!.count, 0);
});

test("receipt routes deny an unlinked sender before buffering and validate actual bytes with a confirmed staff session", async () => {
  const f = fixture(), app = new Hono<AppEnv>();
  app.onError((error, c) => c.json({ error: error.message, code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" }, error instanceof ApiError ? error.status as 400 : 500));
  app.route("/personal-expenses", personalExpenseRoutes);
  const body = new FormData(); body.set("fields", JSON.stringify(input())); body.set("file", new File([new Uint8Array(png)], "receipt.png", { type: "image/png" }));
  const denied = await app.request("http://localhost:3000/personal-expenses/profiles/not-owned/upload", { method: "POST", headers: { cookie: f.cookie, origin: "http://localhost:3000", "content-length": String(10 * 1024 * 1024) }, body });
  assert.equal(denied.status, 404);
  const invalid = new FormData(); invalid.set("fields", JSON.stringify(input())); invalid.set("file", new File(["not a receipt"], "receipt.png", { type: "image/png" }));
  const response = await app.request(`http://localhost:3000/personal-expenses/profiles/${f.recipientId}/upload`, { method: "POST", headers: { cookie: f.cookie, origin: "http://localhost:3000", "X-Expense-Request-Key": randomUUID() }, body: invalid });
  assert.equal(response.status, 422); assert.equal((await response.json()).code, "DOCUMENT_TYPE_UNSUPPORTED");
  const excessive = await app.request(`http://localhost:3000/personal-expenses/profiles/${f.recipientId}/upload`, { method: "POST", headers: { cookie: f.cookie, origin: "http://localhost:3000", "content-length": "1", "content-type": "multipart/form-data; boundary=fixture" }, body: new Uint8Array(3 * 1024 * 1024 + 65537) });
  assert.equal(excessive.status, 413);
  for (const amount of ["0", "-1", "1.0000001", "1e4", "", "1000000000000000000000000000000"]) assert.equal(expenseInput.safeParse(input({ amountUSDC: amount })).success, false);
});

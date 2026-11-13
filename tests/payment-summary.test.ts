import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getDb, transaction } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { PERMISSIONS } from "../src/server/identity/session";
import { encrypt } from "../src/server/identity/crypto";
import { createPayment, getPayment, listPayments, paymentPage, paymentSummary } from "../src/server/payments/service";
import { createClientReserve } from "../src/server/client-reserves/service";
import { NATIVE_USDC } from "../src/server/payments/policy";
import { createBill } from "../src/server/business/service";
import { addBillInstallment, setBillTerms } from "../src/server/business/bill-terms";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "b2".repeat(32);

function fixture(cash = "0") {
  const id = randomUUID(), recipientId = randomUUID(), savedAt = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id, savedAt);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id, id, savedAt, savedAt);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'employee','USDC','near','recipient.near','confirmed',?,?,?)").run(recipientId, id, encrypt("Original recipient"), savedAt, savedAt, savedAt);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,?,'0','0',?)").run(id, cash, savedAt);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(id, `company-${id.slice(0, 8)}.near`, NATIVE_USDC.near, savedAt);
  const access: AccessContext = { userId: id, organizationId: id, permissions: [...PERMISSIONS] };
  const create = (amount = "100", maxFee = "0") => createPayment(access, { recipientId, reference: randomUUID(), amount, maxFee });
  return { access, recipientId, savedAt, create };
}

function remainder(f: ReturnType<typeof fixture>, parentId: string, cancelled = false) {
  getDb().prepare("UPDATE payments SET status='partially_paid',delivered_amount='40' WHERE id=?").run(parentId);
  const child = f.create("60", "1");
  getDb().prepare("INSERT INTO partial_remainders(original_payment_id,organization_id,remainder_payment_id,remaining_usdc,created_by,created_at) VALUES(?,?,?,'60',?,?)").run(parentId, f.access.organizationId, child.id, f.access.userId, f.savedAt);
  if (cancelled) getDb().prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(child.id);
  return child;
}

test("all payment pages and exact summary include more than a full thousand-recipient pay run", () => {
  const f = fixture(), principal = 9007199254740993n;
  transaction(() => { for (let index = 0; index < 1001; index++) f.create(principal.toString(), "1"); });
  const other = fixture(); other.create("999999");
  assert.equal(listPayments(f.access).length, 1001);
  const seen = new Set<string>();
  for (let page = 1; page <= 11; page++) {
    const result = paymentPage(f.access, page, 100);
    assert.equal(result.total, 1001);
    assert.equal(result.hasMore, page < 11);
    for (const payment of result.payments) { assert.equal(seen.has(payment.id), false); seen.add(payment.id); }
  }
  assert.equal(seen.size, 1001);
  assert.equal(paymentPage(f.access, 12, 100).payments.length, 0);
  assert.throws(() => paymentPage(f.access, 0, 100), /valid payment page/);
  assert.throws(() => paymentPage(f.access, 1, 101), /valid payment page/);
  const summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, (principal * 1001n).toString());
  assert.equal(summary.unreservedBudget, ((principal + 1n) * 1001n).toString());
  assert.equal(summary.fundingGap, summary.unreservedBudget);
  assert.equal(summary.openCount, 1001); assert.equal(summary.paymentCount, 1001);
  assert.equal(summary.attention.length, 8);
  assert.throws(() => paymentSummary({ ...f.access, permissions: ["company:read"] }), /permission/);
});

test("a cancelled remainder preserves the original unpaid entitlement without duplicate principal", () => {
  const f = fixture(), parent = f.create(), child = remainder(f, parent.id, true);
  const ignored = f.create("300"); getDb().prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(ignored.id);
  const summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, "60"); assert.equal(summary.unreservedBudget, "60");
  assert.equal(summary.openCount, 1); assert.equal(summary.paidCount, 0);
  assert.equal(summary.attention[0].payment.id, child.id);
  assert.equal(summary.attention[0].rootPaymentId, parent.id);
  assert.equal(summary.attention[0].state, "needs_replacement");
});

test("earmarked cash covers its own remaining liability and fees stay separate", () => {
  const f = fixture("100"), parent = f.create();
  createClientReserve(f.access, { idempotencyKey: randomUUID(), amount: parent.amount, purpose: "Protected payroll", paymentId: parent.id });
  const child = remainder(f, parent.id);
  getDb().prepare("UPDATE treasury_balances SET balance='60' WHERE organization_id=?").run(f.access.organizationId);
  let summary = paymentSummary(f.access);
  assert.equal(summary.treasury.available, "0"); assert.equal(summary.unreservedBudget, "61"); assert.equal(summary.fundingGap, "1");
  getDb().prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(child.id);
  summary = paymentSummary(f.access);
  assert.equal(summary.fundingGap, "0"); assert.equal(summary.openPrincipal, "60");
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(child.id);
  summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, "0"); assert.equal(summary.openCount, 0); assert.equal(summary.paidCount, 1);
});

test("unresolved source money is not requested twice and recorded recipient versions keep their identity", () => {
  const f = fixture(), payment = f.create();
  getDb().prepare("INSERT INTO recipient_versions(recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES(?,1,?,?,?)").run(f.recipientId, encrypt(JSON.stringify({ name: "Original recipient" })), f.access.userId, f.savedAt);
  getDb().prepare("UPDATE recipients SET name=?,version=2 WHERE id=?").run(encrypt("New profile owner"), f.recipientId);
  getDb().prepare("UPDATE payments SET status='unknown' WHERE id=?").run(payment.id);
  const summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, "100"); assert.equal(summary.unreservedBudget, "0"); assert.equal(summary.fundingGap, "0");
  assert.equal(summary.attention[0].recipientName, "Original recipient");
  assert.equal(paymentPage(f.access, 1, 50).payments[0].recipientName, "Original recipient");
  assert.equal(getPayment(f.access, payment.id).recipientName, "Original recipient");
});

test("invoice face liabilities remain visible beyond a smaller installment without inventing a payable budget", () => {
  const f = fixture(), bill = createBill(f.access, { recipientId: f.recipientId, reference: randomUUID(), title: "Services", amount: "25000000", maxFee: "1000000" });
  setBillTerms(f.access, bill.id, { paymentAmount: "10000000", maxFee: "1000000", requiresAcceptance: false });
  let summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, "25000000"); assert.equal(summary.uncommittedInvoicePrincipal, "15000000");
  assert.equal(summary.unreservedBudget, "11000000"); assert.equal(summary.openCount, 1);
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(bill.payment_id!);
  summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, "15000000"); assert.equal(summary.unreservedBudget, "0");
  assert.equal(summary.openCount, 1); assert.equal(summary.attention[0].state, "needs_installment");
  const installment = addBillInstallment(f.access, bill.id, { amount: "15000000", maxFee: "1000000" });
  summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, "15000000"); assert.equal(summary.uncommittedInvoicePrincipal, "0");
  assert.equal(summary.unreservedBudget, "16000000"); assert.equal(summary.openCount, 1);
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(installment.payment_id!);
  summary = paymentSummary(f.access);
  assert.equal(summary.openPrincipal, "0"); assert.equal(summary.openCount, 0);
});

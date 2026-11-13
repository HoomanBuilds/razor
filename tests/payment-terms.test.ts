import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { getDb } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { PERMISSIONS } from "../src/server/identity/session";
import { createPayment, cancelPayment, getPayment, revalidatePaymentRecipient, approvePayment, assertPaymentLiabilityApproved } from "../src/server/payments/service";
import { createBill } from "../src/server/business/service";
import { NATIVE_USDC } from "../src/server/payments/policy";
import { encrypt } from "../src/server/identity/crypto";
import { replaceCancelledPayment } from "../src/server/payment-management/service";
import { addBillInstallment, setBillTerms } from "../src/server/business/bill-terms";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "c3".repeat(32);
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const id = randomUUID(), recipientId = randomUUID(), savedAt = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id, savedAt);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id, id, savedAt, savedAt);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,'Supplier','business','USDC','near','supplier.near','confirmed',?,?,?)").run(recipientId, id, savedAt, savedAt, savedAt);
  const access: AccessContext = { userId: id, organizationId: id, permissions: [...PERMISSIONS] };
  return { access, recipientId, savedAt };
}

test("a reused payment reference requires the original schedule and complete metadata", () => {
  const f = fixture(), input = { recipientId: f.recipientId, reference: randomUUID(), amount: "100", scheduledFor: "2026-12-01T10:00:00Z", metadata: { project: "A", details: { costCenter: "B", label: "Payroll" } } };
  const payment = createPayment(f.access, input);
  assert.equal(createPayment(f.access, { ...input, metadata: { details: { label: "Payroll", costCenter: "B" }, project: "A" } }).id, payment.id);
  for (const change of [{ scheduledFor: null }, { scheduledFor: "2026-12-02T10:00:00Z" }, { metadata: { ...input.metadata, project: "Other" } }, { metadata: {} }]) assert.throws(() => createPayment(f.access, { ...input, ...change }), /different payment terms/);
  assert.equal(getPayment(f.access, payment.id).scheduled_for, input.scheduledFor);
});

test("a reused invoice reference cannot silently substitute its contents or source evidence", () => {
  const f = fixture(), input = { recipientId: f.recipientId, reference: randomUUID(), title: "Services", amount: "100", lineItems: [{ description: "Engineering", quantity: 2 }], evidence: "Reviewed purchase order", documentHash: "a".repeat(64) };
  const bill = createBill(f.access, input);
  assert.equal(createBill(f.access, { ...input, lineItems: [{ quantity: 2, description: "Engineering" }] }).id, bill.id);
  for (const change of [{ lineItems: [] }, { evidence: "Different purchase order" }, { documentHash: "b".repeat(64) }, { documentHash: undefined }]) assert.throws(() => createBill(f.access, { ...input, ...change }), /different terms/);
});

test("recipient refresh preserves the confirmed owner while allowing that owner's new destination", () => {
  const f = fixture(), db = getDb();
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(f.access.userId, f.recipientId);
  const save = (version: number) => db.prepare("INSERT INTO recipient_versions(recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES(?,?,?,?,?)").run(f.recipientId, version, encrypt(JSON.stringify({ name: "Supplier", user_id: f.access.userId })), f.access.userId, f.savedAt);
  save(1);
  const payment = createPayment(f.access, { recipientId: f.recipientId, reference: randomUUID(), amount: "100" });
  db.prepare("UPDATE recipients SET version=2,primary_address='new-destination.near' WHERE id=?").run(f.recipientId); save(2);
  assert.equal(revalidatePaymentRecipient(f.access, payment.id).recipient_version, 2);
  assert.equal(JSON.parse(getPayment(f.access, payment.id).recipient_snapshot).primary_address, "new-destination.near");
  const differentUser = randomUUID(); db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Other person',?)").run(differentUser, f.savedAt);
  db.prepare("UPDATE recipients SET version=3,user_id=?,primary_address='other-person.near' WHERE id=?").run(differentUser, f.recipientId);
  assert.throws(() => revalidatePaymentRecipient(f.access, payment.id), /different person/);
  assert.equal(getPayment(f.access, payment.id).recipient_version, 2);
});

test("replacement and legacy descendant approval cannot reassign an earlier owner's obligation", async () => {
  const f = fixture(), db = getDb(), newOwner = randomUUID();
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(f.access.userId, f.recipientId);
  db.prepare("INSERT INTO recipient_versions(recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES(?,1,?,?,?)").run(f.recipientId, encrypt(JSON.stringify({ name: "Supplier", user_id: f.access.userId })), f.access.userId, f.savedAt);
  const old = createPayment(f.access, { recipientId: f.recipientId, reference: randomUUID(), amount: "100" });
  db.prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(old.id);
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'New owner',?)").run(newOwner, f.savedAt);
  db.prepare("UPDATE recipients SET user_id=?,version=2 WHERE id=?").run(newOwner, f.recipientId);
  await assert.rejects(replaceCancelledPayment(f.access, old.id, "Refresh preferences"), /different person/);
  const legacy = createPayment(f.access, { recipientId: f.recipientId, reference: randomUUID(), amount: "100" });
  db.prepare("INSERT INTO payment_replacements(old_payment_id,new_payment_id,organization_id,liability_kind,liability_id,reason_ciphertext,created_by,created_at) VALUES(?,?,?,'payment',?,?,?,?)").run(old.id, legacy.id, f.access.organizationId, old.id, encrypt("Legacy replacement"), f.access.userId, f.savedAt);
  assert.throws(() => approvePayment(f.access, legacy.id), /different person/);
  assert.equal(getPayment(f.access, legacy.id).approved_at, null);
  db.prepare("UPDATE payments SET approved_at=?,approved_by=?,status='approved_unfunded' WHERE id=?").run(f.savedAt, f.access.userId, legacy.id);
  assert.throws(() => assertPaymentLiabilityApproved(f.access, getPayment(f.access, legacy.id)), /different person/);
});

test("new installments retain the beneficiary of the existing invoice debt", () => {
  const f = fixture(), db = getDb(), other = randomUUID();
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(f.access.userId, f.recipientId);
  db.prepare("INSERT INTO recipient_versions(recipient_id,version,profile_ciphertext,changed_by,created_at) VALUES(?,1,?,?,?)").run(f.recipientId, encrypt(JSON.stringify({ name: "Supplier", user_id: f.access.userId })), f.access.userId, f.savedAt);
  const bill = createBill(f.access, { recipientId: f.recipientId, reference: randomUUID(), title: "Services", amount: "100" });
  setBillTerms(f.access, bill.id, { paymentAmount: "40", maxFee: "0", requiresAcceptance: false });
  db.prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(bill.payment_id!);
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Other person',?)").run(other, f.savedAt);
  db.prepare("UPDATE recipients SET version=2,user_id=? WHERE id=?").run(other, f.recipientId);
  assert.throws(() => addBillInstallment(f.access, bill.id, { amount: "60", maxFee: "0" }), /different person/);
  db.prepare("UPDATE recipients SET user_id=?,primary_address='new-destination.near' WHERE id=?").run(f.access.userId, f.recipientId);
  assert.ok(addBillInstallment(f.access, bill.id, { amount: "60", maxFee: "0" }).payment_id);
});

test("final or partial delivery recorded during a cancellation RPC cannot be overwritten", async () => {
  for (const state of ["paid", "partially_paid", "reported_partial"] as const) {
    const f = fixture(), payment = createPayment(f.access, { recipientId: f.recipientId, reference: randomUUID(), amount: "100" });
    getDb().prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'mainnet',?,?)").run(f.access.organizationId, `company-${f.access.organizationId.slice(0, 8)}.near`, NATIVE_USDC.near, f.savedAt);
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.params.method_name, "get_payment");
      if (state === "reported_partial") getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','reported_partial','{}','USDC','near','supplier.near','100','100','solver.near',?,?)").run(randomUUID(), payment.id, f.access.organizationId, f.savedAt, f.savedAt);
      else getDb().prepare("UPDATE payments SET status=?,delivered_amount=? WHERE id=?").run(state, state === "paid" ? "100" : "40", payment.id);
      return Response.json({ result: { result: [...Buffer.from("null")] } });
    };
    await assert.rejects(cancelPayment(f.access, payment.id), /delivery changed while cancelling/);
    assert.notEqual(getPayment(f.access, payment.id).status, "cancelled");
  }
});

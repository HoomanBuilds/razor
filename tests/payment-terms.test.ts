import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { getDb } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { PERMISSIONS } from "../src/server/identity/session";
import { createPayment, cancelPayment, getPayment } from "../src/server/payments/service";
import { createBill } from "../src/server/business/service";
import { NATIVE_USDC } from "../src/server/payments/policy";

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

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { getDb, row } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { PERMISSIONS } from "../src/server/identity/session";
import { approvePayment, cancelPayment, createPayment, getTreasury } from "../src/server/payments/service";
import { allocateClientReserve, createClientReserve, getClientReserve, releaseClientReserve } from "../src/server/client-reserves/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ad".repeat(32);
process.env.NEAR_TREASURY_CODE_HASH = "11111111111111111111111111111111";
const previousFetch = globalThis.fetch;
globalThis.fetch = async (_url, input) => {
  const rpc = JSON.parse(String(input?.body));
  assert.equal(rpc.method, "query");
  if (rpc.params.request_type === "view_account") return new Response(JSON.stringify({ result: { code_hash: process.env.NEAR_TREASURY_CODE_HASH } }));
  const config = row<{ organization_id: string }>("SELECT organization_id FROM treasury_config WHERE near_account_id=?", rpc.params.account_id)!;
  const balance = row<{ balance: string }>("SELECT balance FROM treasury_balances WHERE organization_id=?", config.organization_id)!;
  const value = rpc.params.method_name === "get_payment" ? null : { balance: balance.balance, reserved: "0", available: balance.balance, in_flight: "0", confirmed_at_ms: String(Date.now()) };
  return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(value))] } }));
};
after(() => { globalThis.fetch = previousFetch; });

function fixture(balance = "110000000", fee = "1000000") {
  const id = randomUUID(), recipientId = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Owner", now);
  getDb().prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Company", id, now, now);
  getDb().prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'vendor','USDC','near',?,'confirmed',?,?,?)").run(recipientId, id, "Supplier", `supplier-${id.slice(0, 8)}.testnet`, now, now, now);
  getDb().prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,'testnet','usdc.testnet',?)").run(id, `treasury-${id.slice(0, 8)}.testnet`, now);
  getDb().prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,onchain_reserved,updated_at) VALUES(?,?,'0','0',?)").run(id, balance, now);
  const access: AccessContext = { userId: id, organizationId: id, permissions: [...PERMISSIONS] };
  const reserveInput = { idempotencyKey: randomUUID(), amount: "100000000", purpose: "Client supplier principal", clientReference: "Private client" };
  const reserve = createClientReserve(access, reserveInput);
  const payment = createPayment(access, { recipientId, reference: randomUUID(), amount: reserve.amount, maxFee: fee });
  return { access, reserve, reserveInput, payment };
}

test("earmarks conserve cash and exchange atomically for an approved principal reservation", () => {
  const { access, reserve, reserveInput, payment } = fixture("100000000");
  assert.equal(createClientReserve(access, reserveInput).id, reserve.id);
  assert.notEqual(row<{ purpose_ciphertext: string }>("SELECT purpose_ciphertext FROM client_reserves WHERE id=?", reserve.id)!.purpose_ciphertext, reserveInput.purpose);
  assert.equal(getTreasury(access).clientReserved, "100000000");
  assert.equal(getTreasury(access).available, "0");
  const action = { idempotencyKey: randomUUID(), paymentId: payment.id };
  assert.throws(() => allocateClientReserve(access, reserve.id, action), /Approve the underlying obligation/);
  assert.equal(approvePayment(access, payment.id).status, "approved_unfunded");
  assert.throws(() => allocateClientReserve(access, reserve.id, action), /payment costs/);
  assert.equal(getClientReserve(access, reserve.id).disposition, "held");
  assert.equal(getTreasury(access).paymentReserved, "0");
  assert.equal(getTreasury(access).clientReserved, "100000000");
  getDb().prepare("UPDATE treasury_balances SET balance='110000000' WHERE organization_id=?").run(access.organizationId);
  getDb().prepare("UPDATE organizations SET paused=1 WHERE id=?").run(access.organizationId);
  assert.throws(() => allocateClientReserve(access, reserve.id, action), /paused/);
  getDb().prepare("UPDATE organizations SET paused=0 WHERE id=?").run(access.organizationId);
  const allocated = allocateClientReserve(access, reserve.id, action);
  assert.equal(allocated.state, "payment_reserved");
  assert.equal(allocateClientReserve(access, reserve.id, action).id, reserve.id);
  assert.equal(getTreasury(access).balance, "110000000");
  assert.equal(getTreasury(access).paymentReserved, "101000000");
  assert.equal(getTreasury(access).clientReserved, "0");
  assert.equal(getTreasury(access).available, "9000000");
  assert.equal(getClientReserve(access, reserve.id).events.filter((event) => event.action === "allocated").length, 1);
});

test("cancellation restores client cash and retries or explicit releases do not duplicate it", async () => {
  const { access, reserve, payment } = fixture();
  approvePayment(access, payment.id);
  const allocation = { idempotencyKey: randomUUID(), paymentId: payment.id };
  allocateClientReserve(access, reserve.id, allocation);
  await cancelPayment(access, payment.id);
  assert.equal(getClientReserve(access, reserve.id).state, "held");
  assert.equal(getTreasury(access).paymentReserved, "0");
  assert.equal(getTreasury(access).clientReserved, "100000000");
  assert.equal(getTreasury(access).available, "10000000");
  allocateClientReserve(access, reserve.id, allocation);
  assert.equal(getTreasury(access).clientReserved, "100000000");
  assert.throws(() => allocateClientReserve(access, reserve.id, { ...allocation, idempotencyKey: randomUUID() }), /Approve the underlying obligation/);
  assert.throws(() => getClientReserve({ ...access, organizationId: randomUUID() }, reserve.id), /not found/);
  assert.throws(() => releaseClientReserve({ ...access, permissions: ["payments:read"] }, reserve.id, { idempotencyKey: randomUUID(), reason: "Unapproved release" }), /permission/);
  const release = { idempotencyKey: randomUUID(), reason: "Client requested a separate settlement arrangement" };
  releaseClientReserve(access, reserve.id, release);
  releaseClientReserve(access, reserve.id, release);
  assert.equal(getTreasury(access).balance, "110000000");
  assert.equal(getTreasury(access).available, "110000000");
  assert.equal(getClientReserve(access, reserve.id).events.filter((event) => event.action === "released").length, 1);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM treasury_ledger WHERE organization_id=? AND entry_type LIKE '%income%'", access.organizationId)!.count, 0);
});

test("proven source funds are counted once and recovered losses expose an actual cash deficit", () => {
  const { access, reserve, payment } = fixture("105000000", "5000000");
  approvePayment(access, payment.id);
  allocateClientReserve(access, reserve.id, { idempotencyKey: randomUUID(), paymentId: payment.id });
  const id = randomUUID(), quote = "{}", savedAt = new Date().toISOString();
  const chain = { id: payment.id, amount: payment.amount, recipient_id: payment.recipient_id, attempts: [{ id, status: "source_sent", route: { input_amount: "105000000", output_amount: payment.amount, source_receiver: "deposit.testnet", quote_hash: createHash("sha256").update(quote).digest("hex") } }] };
  getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,reconciliation,created_at,updated_at) VALUES(?,?,?,'primary','processing',?,'USDC','near','supplier.testnet',?,'105000000','deposit.testnet',?,?,?)")
    .run(id, payment.id, access.organizationId, quote, payment.amount, JSON.stringify({ chain }), savedAt, savedAt);
  getDb().prepare("UPDATE payments SET status='in_flight',reserved_amount='0',chain_reserved='0' WHERE id=?").run(payment.id);
  getDb().prepare("UPDATE treasury_balances SET balance='0',reserved='0',onchain_reserved='0' WHERE organization_id=?").run(access.organizationId);
  assert.equal(getTreasury(access).clientReserved, "0");
  assert.equal(getTreasury(access).clientPrincipalInFlight, "100000000");
  assert.equal(getTreasury(access).reserveDeficit, "0");
  getDb().prepare("INSERT INTO payment_source_receipts(attempt_id,organization_id,transaction_hash,receipt_id,evidence,verified_by,verified_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, access.organizationId, "fixture-source", "fixture-receipt", JSON.stringify({ succeeded: false, finality: "FINAL", amount: "105000000", receiver: "deposit.testnet" }), access.userId, savedAt);
  assert.equal(getTreasury(access).clientPrincipalInFlight, "0");
  assert.equal(getTreasury(access).clientReserved, "100000000");
  getDb().prepare("DELETE FROM payment_source_receipts WHERE attempt_id=?").run(id);
  getDb().prepare("UPDATE payments SET status='held',total_spent='10000000' WHERE id=?").run(payment.id);
  getDb().prepare("UPDATE payout_attempts SET state='refunded_verified' WHERE id=?").run(id);
  getDb().prepare("UPDATE treasury_balances SET balance='95000000' WHERE organization_id=?").run(access.organizationId);
  assert.equal(getTreasury(access).balance, "95000000");
  assert.equal(getTreasury(access).clientReserved, "100000000");
  assert.equal(getTreasury(access).reserveDeficit, "5000000");
  assert.equal(getTreasury(access).available, "0");
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(payment.id);
  assert.equal(getClientReserve(access, reserve.id).state, "closed");
  assert.equal(getTreasury(access).clientReserved, "0");
});

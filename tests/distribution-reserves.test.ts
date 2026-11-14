import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getDb } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { PERMISSIONS, getAccess } from "../src/server/identity/session";
import { createDistribution } from "../src/server/distributions/service";
import { approvePayment, createPayment, getTreasury } from "../src/server/payments/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "63".repeat(32);

function fixture(balance = "100000000") {
  const id = randomUUID(), recipientId = randomUUID(), roleId = randomUUID(), at = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Owner", at);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Reserve company", id, at, at);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(roleId, id, "Owner", JSON.stringify(PERMISSIONS), at);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?,'active',?)").run(id, id, roleId, at);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'employee','USDC','near','recipient.near','confirmed',?,?,?)")
    .run(recipientId, id, id, encrypt("Recipient"), at, at, at);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,?,'0',?)").run(id, balance, at);
  const access = getAccess(id, id);
  const pool = (amount: string) => createDistribution(access, { reference: randomUUID(), requestKey: randomUUID(), deadline: new Date(Date.now() + 86400000).toISOString(), items: [{ recipientId, amount }] });
  return { access, recipientId, pool };
}

test("a local distribution reservation prevents ordinary payments from reserving the same cash", () => {
  const f = fixture(), pool = f.pool("80000000");
  getDb().prepare("UPDATE claim_distributions SET stage='review',local_reserved='80000000' WHERE id=?").run(pool.id);
  assert.equal(getTreasury(f.access).distributionLocalReserved, "80000000");
  assert.equal(getTreasury(f.access).available, "20000000");
  const payment = createPayment(f.access, { recipientId: f.recipientId, reference: "after-pool", amount: "30000000", maxFee: "0" });
  assert.equal(approvePayment(f.access, payment.id).status, "approved_unfunded");
  assert.equal(getTreasury(f.access).paymentReserved, "0");
  assert.equal(getTreasury(f.access).reserved, "80000000");
});

test("observed pool backing is counted once and stale observations remain conservative", () => {
  const f = fixture(), pool = f.pool("20000000"), pendingPool = f.pool("5000000"), db = getDb();
  const payment = createPayment(f.access, { recipientId: f.recipientId, reference: "reserved-payment", amount: "10000000", maxFee: "0" });
  approvePayment(f.access, payment.id);
  db.prepare("UPDATE payments SET chain_reserved='10000000' WHERE id=?").run(payment.id);
  db.prepare("UPDATE claim_distributions SET stage='observed',chain_reserved='20000000' WHERE id=?").run(pool.id);
  db.prepare("UPDATE claim_distributions SET stage='observed',pending_amount='5000000' WHERE id=?").run(pendingPool.id);
  db.prepare("UPDATE treasury_balances SET onchain_reserved='30000000' WHERE organization_id=?").run(f.access.organizationId);
  let treasury = getTreasury(f.access);
  assert.equal(treasury.distributionChainReserved, "20000000");
  assert.equal(treasury.distributionPending, "5000000");
  assert.equal(treasury.reserved, "30000000");
  assert.equal(treasury.paymentReserved, "10000000");
  assert.equal(treasury.available, "70000000");
  db.prepare("UPDATE treasury_balances SET onchain_reserved='0' WHERE organization_id=?").run(f.access.organizationId);
  treasury = getTreasury(f.access);
  assert.equal(treasury.reserved, "30000000");
  assert.equal(treasury.available, "70000000");
  db.prepare("UPDATE claim_distributions SET chain_reserved='0' WHERE id=?").run(pool.id);
  assert.equal(getTreasury(f.access).available, "90000000");
});

test("distribution reserve sums preserve values above Number precision and company isolation", () => {
  const f = fixture("10000000000000000000000"), other = fixture(), first = 9007199254740993n, second = 9007199254740995n;
  for (const amount of [first, second]) {
    const pool = f.pool(amount.toString());
    getDb().prepare("UPDATE claim_distributions SET stage='review',local_reserved=? WHERE id=?").run(amount.toString(), pool.id);
  }
  const foreignPool = other.pool("99000000");
  getDb().prepare("UPDATE claim_distributions SET local_reserved='99000000' WHERE id=?").run(foreignPool.id);
  const treasury = getTreasury(f.access);
  assert.equal(treasury.distributionReserved, (first + second).toString());
  assert.equal(treasury.available, (10000000000000000000000n - first - second).toString());
});

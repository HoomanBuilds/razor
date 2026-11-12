import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { atomic, formatUnits, parseUnits, usdToToken } from "../src/lib/money";
import { canUseBackup, checkBudget, providerOutcome } from "../src/server/payments/policy";
import type { Payment, PayoutAttempt, RecipientSnapshot } from "../src/server/payments/types";

test("money stays exact beyond Number precision and respects token decimals", () => {
  assert.equal(parseUnits("9007199254.740993"), "9007199254740993");
  assert.equal(formatUnits("9007199254740993"), "9007199254.740993");
  assert.equal(usdToToken("1000000", "3", 6), "333334");
  assert.equal(usdToToken("1000000", "1", 18), "1000000000000000000");
  assert.throws(() => atomic((1n << 128n).toString()));
  assert.throws(() => parseUnits("0.0000001"));
  assert.throws(() => atomic("-1"));
});

test("uncertain delivery and unconfirmed recipient consent prevent backup", () => {
  const payment = { status: "approved", delivered_amount: "0" } as Payment;
  const recipient = { fallback_consent: 1, preference_status: "confirmed", confirmed_at: new Date().toISOString(), primary_network: "eth", primary_address: "primary", primary_asset: "USDC", backup_network: "base", backup_address: "backup" } as RecipientSnapshot;
  for (const state of ["prepared", "submitted", "processing", "unknown", "reported_delivered", "recovery_pending"]) {
    assert.throws(() => canUseBackup(payment, recipient, [{ state } as PayoutAttempt]));
  }
  canUseBackup(payment, recipient, [{ state: "refunded_verified" } as PayoutAttempt]);
  assert.throws(() => canUseBackup(payment, { ...recipient, preference_status: "pending_confirmation" }, []));
  assert.throws(() => canUseBackup({ ...payment, delivered_amount: "1" }, recipient, []));
  assert.equal(providerOutcome("REFUNDED"), "recovery_pending");
  assert.equal(providerOutcome("SUCCESS"), "reported_delivered");
});

test("recovered funds do not reset the approved fee budget", () => {
  const payment = { amount: "100000000", max_fee: "2000000", total_spent: "1000000" };
  checkBudget(payment, "101000000");
  assert.throws(() => checkBudget(payment, "101000001"));
});

test("database prevents concurrent active attempts and duplicate logical obligations", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../db/migrations/002-payments.sql", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("p", "o", "r", "payroll", "payrun:employee:1", "1000000", "100000", "approved", 1, "{}", now, now);
  assert.throws(() => db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("p2", "o", "r", "payroll", "payrun:employee:1", "1000000", "100000", "approved", 1, "{}", now, now));
  const add = db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  add.run("a1", "p", "o", "primary", "unknown", "{}", "USDC", "base", "recipient", "1000000", "1001000", "deposit", now, now);
  assert.throws(() => add.run("a2", "p", "o", "backup", "prepared", "{}", "USDC", "eth", "backup", "1000000", "1001000", "deposit2", now, now));
  db.prepare("UPDATE payout_attempts SET state='refunded_verified' WHERE id='a1'").run();
  add.run("a2", "p", "o", "backup", "prepared", "{}", "USDC", "eth", "backup", "1000000", "1001000", "deposit2", now, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payout_attempts WHERE payment_id='p'").get()?.count, 2);
  db.close();
});

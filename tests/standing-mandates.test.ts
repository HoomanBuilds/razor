import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { createBill, approveBill } from "../src/server/business/service";
import { getRecipient } from "../src/server/identity/recipients";
import { standingProblems, supplierHash, type StandingGrant, type StandingPolicy, type StandingRow, type StandingTerms } from "../src/server/standing-mandates/model";
import { inspectGrant, observeGrant, prepareGrant, prepareStatus } from "../src/server/standing-mandates/service";
import { assertStandingBill, tryExecuteStandingPayment } from "../src/server/standing-mandates/executor";
import { deriveSharedCompanyId } from "../src/server/payments/near";
import type { Payment } from "../src/server/payments/types";
import { closeUnfundedAttempt } from "../src/server/payments/service";
import type { OperationJob } from "../src/server/operations/types";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "81".repeat(32);
process.env.NEAR_TREASURY_CODE_HASH = "11111111111111111111111111111111";
const policy: StandingPolicy = { owner_id: "owner.near", paused: false, policy_version: "3", token_contract: "usdc.near", executors: ["agent.near"], approvers: ["finance.near"], approval_tiers: [{ required_approvals: 1 }, { required_approvals: 2 }] };
const ownerUser = randomUUID();
function fixture() {
  const id = randomUUID(), supplier = randomUUID(), stamp = new Date().toISOString(), db = getDb();
  db.prepare("INSERT OR IGNORE INTO users(id,name,created_at) VALUES(?,?,?)").run(ownerUser, "Owner", stamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Native company", ownerUser, stamp, stamp);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'Supplier','business','USDC','near','supplier.near','confirmed',?,?,?)").run(supplier, id, ownerUser, stamp, stamp, stamp);
  db.prepare("INSERT OR IGNORE INTO linked_wallets(id,user_id,family,address,network,created_at) VALUES(?,?,'near','owner.near','testnet',?)").run(randomUUID(), ownerUser, stamp);
  db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,architecture,company_id,created_at) VALUES(?,'treasury.near','testnet','usdc.near','shared_v1',?,?)").run(id, deriveSharedCompanyId(id, "owner.near"), stamp);
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,'100000000','0',?)").run(id, stamp);
  const access: AccessContext = { organizationId: id, userId: ownerUser, permissions: ["company:read", "company:manage", "payments:read", "payments:prepare", "payments:approve", "payments:execute"] };
  return { access, supplier };
}
function terms(f = fixture()): StandingTerms {
  return { id: randomUUID(), recipient_id: f.supplier, recipient_version: "1", supplier_profile_hash: supplierHash(getRecipient(f.access.organizationId, f.supplier)), actor_id: "agent.near", actor_public_key: "ed25519:11111111111111111111111111111111", per_payment_max_input: "10000000", period_max_input: "20000000", lifetime_max_input: "30000000", period_ms: "86400000", valid_from_ms: String(Date.now() - 2 * 86400000), expires_at_ms: String(Date.now() + 5 * 86400000), invoice_condition: "accepted_vendor_bill_application_gate" };
}
function grant(value: StandingTerms): StandingGrant {
  return { terms: value, destination: { network: "near", asset_id: "nep141:usdc.near", address: "supplier.near" }, policy_version: "3", terms_hash: "a".repeat(64), approvals: ["owner.near", "finance.near"], required_approvals: 2, paused: false, revoked: false, period_index: "2", period_used_input: "0", lifetime_used_input: "0", pending_input: "0" };
}
function save(f: ReturnType<typeof fixture>, value = terms(f)) {
  const stamp = new Date().toISOString();
  getDb().prepare("INSERT INTO standing_mandates(id,organization_id,recipient_id,supplier_profile_hash,supplier_version,terms_json,terms_hash,enabled,created_by,created_at,updated_at) VALUES(?,?,?,?,1,?,?,1,?,?,?)")
    .run(value.id, f.access.organizationId, f.supplier, value.supplier_profile_hash, JSON.stringify(value), "a".repeat(64), f.access.userId, stamp, stamp);
  return row<StandingRow>("SELECT * FROM standing_mandates WHERE id=?", value.id)!;
}
async function rpc<T>(values: { grant?: StandingGrant | null; activation?: string; chain?: unknown }, action: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string), method = request.params?.method_name;
    const result = request.params?.request_type === "view_account" ? { code_hash: process.env.NEAR_TREASURY_CODE_HASH } : { result: [...Buffer.from(JSON.stringify(
      method === "get_config" ? policy : method === "get_standing_mandate" ? values.grant ?? null : method === "get_recipient_activation" ? values.activation ?? String(Date.now() - 1) : method === "get_payment" ? values.chain ?? null : method === "get_recipient" ? { version: values.grant?.terms.recipient_version ?? "7", active: true, primary: { network: "near", asset_id: "nep141:usdc.near", address: "supplier.near" } } : null))] };
    return Response.json({ result });
  };
  try { return await action(); } finally { globalThis.fetch = original; }
}

test("standing limits include fee ceilings, anchored reset, pending input and permanent lifetime charges", () => {
  const value = terms(), current = grant(value), now = Number(value.valid_from_ms) + 2 * 86400000;
  current.period_used_input = "19000000"; current.lifetime_used_input = "29000000"; current.pending_input = "10000000";
  assert.equal(standingProblems(current, policy, String(now), now, "1000000").length, 0);
  assert.ok(standingProblems(current, policy, String(now), now, "1000001").some(value => value.includes("lifetime")));
  assert.ok(standingProblems(current, policy, String(now), now, "1000001").some(value => value.includes("period")));
  assert.ok(standingProblems(current, policy, String(now), now + 86400000, "1000001").every(value => !value.includes("period")));
  assert.ok(standingProblems(current, policy, String(now), now + 86400000, "1000001").some(value => value.includes("lifetime")));
  assert.equal(current.pending_input, "10000000");
  assert.ok(standingProblems(current, policy, String(now + 1), now).some(value => value.includes("activation")));
  assert.ok(standingProblems({ ...current, approvals: ["owner.near"] }, policy, String(now), now).some(value => value.includes("approvers")));
  assert.ok(standingProblems({ ...current, policy_version: "2" }, policy, String(now), now).some(value => value.includes("policy")));
  assert.ok(standingProblems(current, policy, "1", Number(value.expires_at_ms)).some(value => value.includes("expired")));
});

test("owner grants bind the profile and always rebind the receiving version to start a new delay", async () => {
  const f = fixture();
  const prepared = await rpc({}, () => prepareGrant(f.access, { recipientId: f.supplier, actorAccountId: "agent.near", actorPublicKey: "ed25519:11111111111111111111111111111111", perPaymentMaxInput: "100", periodMaxInput: "200", lifetimeMaxInput: "300", periodDays: 30, validFrom: new Date().toISOString(), expiresAt: new Date(Date.now() + 31 * 86400000).toISOString() }));
  assert.equal(prepared.walletActions.length, 2);
  assert.equal(prepared.walletActions[0].actions[0].params.methodName, "set_recipient");
  assert.equal(prepared.terms.recipient_version, "8");
  assert.equal(prepared.terms.supplier_profile_hash, supplierHash(getRecipient(f.access.organizationId, f.supplier)));
  assert.equal(prepared.requiredApprovals, 2);
  assert.equal(row<StandingRow>("SELECT * FROM standing_mandates WHERE id=?", prepared.id)!.enabled, 0);
  await rpc({}, () => assert.rejects(() => observeGrant(f.access, prepared.id), (error: ApiError) => error.code === "STANDING_NOT_ACTIVE"));
  await assert.rejects(() => prepareGrant({ ...f.access, userId: "outsider" }, {}), (error: ApiError) => error.code === "ONLY_COMPANY_OWNER");
});

test("observed quorum and delay activate locally, supplier changes immediately disable and notify", async () => {
  const f = fixture(), stored = save(f), current = grant(JSON.parse(stored.terms_json));
  getDb().prepare("UPDATE standing_mandates SET enabled=0 WHERE id=?").run(stored.id);
  await rpc({ grant: current, activation: String(Date.now() + 1_000_000) }, () => assert.rejects(() => observeGrant(f.access, stored.id), /activation/));
  await rpc({ grant: current }, () => observeGrant(f.access, stored.id));
  assert.equal(row<StandingRow>("SELECT * FROM standing_mandates WHERE id=?", stored.id)!.enabled, 1);
  getDb().prepare("UPDATE recipients SET primary_address='changed.near',version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), f.supplier);
  assert.equal(row<StandingRow>("SELECT * FROM standing_mandates WHERE id=?", stored.id)!.enabled, 0);
  assert.ok(row("SELECT id FROM notices WHERE organization_id=? AND dedupe_key LIKE 'standing-supplier:%'", f.access.organizationId));
  await rpc({ grant: current }, () => assert.rejects(() => observeGrant(f.access, stored.id), /Supplier profile changed/));
  await assert.rejects(() => inspectGrant({ ...f.access, organizationId: fixture().access.organizationId }, stored.id), (error: ApiError) => error.code === "STANDING_NOT_FOUND");
});

test("native execution requires an accepted funded bill and preserves the human approval identity", () => {
  const f = fixture(), stored = save(f), bill = createBill(f.access, { recipientId: f.supplier, reference: "native-bill", title: "Consulting", amount: "1000000", maxFee: "100000" });
  const draft = row<Payment>("SELECT * FROM payments WHERE id=?", bill.payment_id!)!;
  assert.throws(() => assertStandingBill(f.access, draft, stored), (error: ApiError) => error.code === "STANDING_BILL_REQUIRED");
  approveBill(f.access, bill.id);
  const payment = row<Payment>("SELECT * FROM payments WHERE id=?", bill.payment_id!)!;
  assert.doesNotThrow(() => assertStandingBill(f.access, payment, stored));
  assert.equal(payment.approved_by, f.access.userId);
  assert.throws(() => assertStandingBill(f.access, { ...payment, total_spent: "1" }, stored));
  assert.throws(() => assertStandingBill(f.access, { ...payment, scheduled_for: new Date(Date.now() + 86400000).toISOString() }, stored));
  assert.throws(() => assertStandingBill(f.access, { ...payment, reserved_amount: "1000000" }, stored));
  getDb().prepare("UPDATE bills SET setoff_amount='1' WHERE id=?").run(bill.id);
  assert.throws(() => assertStandingBill(f.access, payment, stored));
});

test("eligible native bill holds without a real restricted worker and creates no signed attempt", async () => {
  const f = fixture(), stored = save(f), bill = createBill(f.access, { recipientId: f.supplier, reference: "native-worker", title: "Consulting", amount: "1000000", maxFee: "0" });
  approveBill(f.access, bill.id);
  const job = { organization_id: f.access.organizationId, entity_id: bill.payment_id!, id: randomUUID() } as OperationJob;
  const result = await rpc({ grant: grant(JSON.parse(stored.terms_json)) }, () => tryExecuteStandingPayment(job, f.access));
  assert.equal(result?.status, "blocked");
  assert.match(String(result?.detail.reason), /dedicated native worker/);
  assert.equal(row("SELECT id FROM payout_attempts WHERE payment_id=?", bill.payment_id!), undefined);
  assert.equal(row<Payment>("SELECT * FROM payments WHERE id=?", bill.payment_id!)!.approved_by, f.access.userId);
});

test("restricted native worker signs once, retries identical bytes and monitors after revocation without a fresh owner signature", async () => {
  const { KeyPair, SignedTransaction } = await import("near-api-js");
  const f = fixture(), key = KeyPair.fromRandom("ed25519"), value = terms(f);
  value.actor_public_key = key.getPublicKey().toString();
  const stored = save(f, value), current = grant(value), company = deriveSharedCompanyId(f.access.organizationId, "owner.near");
  const bill = createBill(f.access, { recipientId: f.supplier, reference: "real-signed-native", title: "Consulting", amount: "1000000", maxFee: "100000" });
  approveBill(f.access, bill.id);
  const jobId = randomUUID(), timestamp = new Date().toISOString();
  getDb().prepare("INSERT INTO operation_jobs(id,organization_id,job_key,kind,entity_id,status,run_at,lease_owner,lease_expires_at,created_at,updated_at) VALUES(?,?,?,'due_payment',?,'running',?,'worker',?,?,?)")
    .run(jobId, f.access.organizationId, `test-native:${jobId}`, bill.payment_id!, timestamp, new Date(Date.now() + 600000).toISOString(), timestamp, timestamp);
  const job = row<OperationJob>("SELECT * FROM operation_jobs WHERE id=?", jobId)!;
  const names = ["ACCOUNT_ID", "PRIVATE_KEY", "NETWORK", "TREASURY_ACCOUNT_ID", "COMPANY_ID"].map(name => `RAZOR_STANDING_EXECUTOR_${name}`);
  const old = new Map(names.map(name => [name, process.env[name]]));
  ["agent.near", key.toString(), "testnet", "treasury.near", company].forEach((entry, index) => { process.env[names[index]] = entry; });
  const original = globalThis.fetch, broadcasts: string[] = [];
  let permission: unknown = "FullAccess", chain: Record<string, unknown> | null = null;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string), params = request.params, method = params?.method_name;
    if (request.method === "send_tx") {
      broadcasts.push(params.signed_tx_base64);
      const signed = SignedTransaction.decode(Buffer.from(params.signed_tx_base64, "base64"));
      assert.equal(signed.transaction.signerId, "agent.near");
      assert.equal(signed.transaction.receiverId, "treasury.near");
      assert.equal(signed.transaction.actions.length, 1);
      const call = signed.transaction.actions[0].functionCall!;
      assert.equal(call.methodName, "execute_standing_payment");
      assert.equal(call.deposit, 0n);
      const args = JSON.parse(Buffer.from(call.args).toString());
      assert.equal(args.company_id, company); assert.equal(args.mandate_id, stored.id);
      assert.equal(args.reference, `razor:${bill.payment_id}`); assert.equal(args.amount, "1000000");
      if (broadcasts.length === 1) throw new Error("Simulated unknown transport result");
      chain = { id: bill.payment_id, recipient_id: f.supplier, recipient_version: "1", amount: "1000000", max_fee: "100000", incurred_cost: "0", reservation: "0", reference: args.reference, status: "in_flight", attempts: [{ id: args.attempt_id, status: "sending", route: { kind: "direct", source_receiver: "supplier.near", input_amount: "1000000", output_amount: "1000000", quote_hash: args.execution_hash, deadline_ms: value.expires_at_ms }, actual_output: "0", credited_amount: "0" }] };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { status: { SuccessValue: "" } } });
    }
    let result: unknown;
    if (request.method === "block") result = { header: { hash: "11111111111111111111111111111111" } };
    else if (params.request_type === "view_access_key") result = { nonce: 1, permission };
    else if (params.request_type === "view_account") result = { code_hash: process.env.NEAR_TREASURY_CODE_HASH };
    else {
      const output = method === "get_config" ? policy : method === "get_standing_mandate" ? current : method === "get_recipient_activation" ? "1" : method === "get_payment" ? chain : method === "get_standing_payment" ? stored.id : method === "get_recipient" ? { version: value.recipient_version, active: true, primary: current.destination } : method === "get_balance" ? { balance: "99000000", reserved: "0", available: "99000000", in_flight: chain?.status === "paid" ? "0" : "1000000", confirmed_at_ms: String(Date.now()) } : null;
      result = { result: [...Buffer.from(JSON.stringify(output))] };
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  try {
    const denied = await tryExecuteStandingPayment(job, f.access);
    assert.equal(denied?.status, "blocked"); assert.match(String(denied?.detail.reason), /key must permit only/);
    assert.equal(row("SELECT id FROM payout_attempts WHERE payment_id=?", bill.payment_id!), undefined);
    permission = { FunctionCall: { receiver_id: "treasury.near", method_names: ["execute_standing_payment"], allowance: "1000000000000000000000000" } };
    const unknown = await tryExecuteStandingPayment(job, f.access);
    assert.equal(unknown?.status, "queued");
    assert.equal(unknown?.detail.sameSignedTransactionOnly, true);
    const pendingAttempt = row<{ id: string; source_tx_hash: string; state: string }>("SELECT id,source_tx_hash,state FROM payout_attempts WHERE payment_id=?", bill.payment_id!)!;
    assert.ok(pendingAttempt.source_tx_hash); assert.equal(pendingAttempt.state, "unknown");
    await assert.rejects(() => closeUnfundedAttempt(f.access, pendingAttempt.id), (error: ApiError) => error.code === "PRIOR_ATTEMPT_UNRESOLVED");
    const submitted = await tryExecuteStandingPayment(job, f.access);
    assert.equal(submitted?.status, "completed");
    assert.equal(broadcasts.length, 2); assert.equal(broadcasts[0], broadcasts[1]);
    assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM payout_attempts WHERE payment_id=?", bill.payment_id!)!.count, 1);
    assert.equal(row<Payment>("SELECT * FROM payments WHERE id=?", bill.payment_id!)!.approved_by, f.access.userId);
    assert.equal(row<{ actor_id: string }>("SELECT actor_id FROM activity WHERE entity_id=? AND action='standing.bill_eligible'", bill.payment_id!)!.actor_id, "near:agent.near");
    getDb().prepare("UPDATE standing_mandates SET enabled=0 WHERE id=?").run(stored.id);
    current.revoked = true;
    chain!.status = "paid";
    const attempts = chain!.attempts as { status: string; actual_output: string; credited_amount: string }[];
    attempts[0].status = "delivered"; attempts[0].actual_output = "1000000"; attempts[0].credited_amount = "1000000";
    const monitored = await tryExecuteStandingPayment(job, f.access);
    assert.ok(monitored && "monitored" in monitored.detail);
    assert.equal(monitored.detail.monitored, true);
    assert.equal(row<Payment>("SELECT * FROM payments WHERE id=?", bill.payment_id!)!.status, "paid");
    assert.equal(broadcasts.length, 2);
  } finally {
    globalThis.fetch = original;
    for (const [name, previous] of old) { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  }
});


test("owners disable local authority even when NEAR inspection is unavailable", async () => {
  const f = fixture(), stored = save(f), original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Simulated RPC outage"); };
  try {
    await assert.rejects(() => prepareStatus(f.access, stored.id, true, true), /outage/);
    assert.equal(row<StandingRow>("SELECT * FROM standing_mandates WHERE id=?", stored.id)!.enabled, 0);
  } finally { globalThis.fetch = original; }
});

import assert from "node:assert/strict";
import test from "node:test";
import { getDb, transaction } from "../src/server/db";
import { inspectTokenReceipt, type FinalTransaction } from "../src/server/payments/near";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { ChainAttempt, PayoutAttempt, TreasuryConfig } from "../src/server/payments/types";
import { accountingExport, csvCell } from "../src/server/reconciliation/export";
import { executionTerms, hasProvenPrimaryFailure } from "../src/server/reconciliation/direct";
import { assertCanStartDeposit, quoteDepositWindow, type QuoteResponse } from "../src/server/payments/intents";
import { inspectSourceTransfer } from "../src/server/reconciliation/source";
import { reconciliationQueue } from "../src/server/reconciliation/service";
import { enqueueOperations, tickOperations } from "../src/server/operations/worker";
import { parseCsv } from "../src/lib/csv";

process.env.DATABASE_PATH = ":memory:";
const config: TreasuryConfig = { organization_id: "org", near_account_id: "treasury.near", network: "mainnet", token_contract: NATIVE_USDC.near };
const transferLog = (sender = "intents.near", receiver = "treasury.near", amount = "1000000") => `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: sender, new_owner_id: receiver, amount }] })}`;

function receipt(): FinalTransaction {
  return { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: "tx", signer_id: "solver.near" }, receipts_outcome: [{ id: "receipt", block_hash: "block", outcome: { executor_id: NATIVE_USDC.near, logs: [transferLog()], status: { SuccessReceiptId: "resolve" } } }] };
}

test("funding credit requires final canonical-token events bound to the actual hash and signer", () => {
  const proof = inspectTokenReceipt(receipt(), config, "tx", "solver.near", "treasury.near", "1000000");
  assert.equal(proof.amount, "1000000");
  assert.equal(proof.events[0].receiptId, "receipt");
  assert.throws(() => inspectTokenReceipt(receipt(), config, "tx", "treasury.near", "treasury.near", "1000000"));
  assert.throws(() => inspectTokenReceipt({ ...receipt(), final_execution_status: "EXECUTED_OPTIMISTIC" }, config, "tx", "solver.near", "treasury.near", "1000000"));
  assert.throws(() => inspectTokenReceipt(receipt(), { ...config, token_contract: "fake-usdc.near" }, "tx", "solver.near", "treasury.near", "1000000"));
  assert.throws(() => inspectTokenReceipt(receipt(), config, "tx", "solver.near", "treasury.near", "1000001"));
  assert.throws(() => inspectTokenReceipt(receipt(), config, "tx", "solver.near", "treasury.near", "1000000", undefined, ["receipt:0:0"]));
  const refunded = receipt();
  refunded.receipts_outcome![0].outcome.logs.push(transferLog("treasury.near", "intents.near"));
  assert.throws(() => inspectTokenReceipt(refunded, config, "tx", "solver.near", "treasury.near", "1000000"));
});

test("source callback recovery follows the execute-payment receipt graph and never guesses from a missing event", () => {
  const call = (method_name: string, value: object) => ({ FunctionCall: { method_name, args: Buffer.from(JSON.stringify(value)).toString("base64") } });
  const attempt = { id: "attempt", route: { source_receiver: "deposit.near", input_amount: "1000000" } } as ChainAttempt;
  const result: FinalTransaction = { final_execution_status: "FINAL", status: { Failure: "missing callback" }, transaction: { hash: "source", signer_id: "owner.near", receiver_id: "treasury.near", actions: [call("execute_payment", { payment_id: "payment", attempt_id: "attempt" })] }, transaction_outcome: { outcome: { receipt_ids: ["execute"] } }, receipts: [{ receipt_id: "token", receiver_id: NATIVE_USDC.near, predecessor_id: "treasury.near", receipt: { Action: { actions: [call("ft_transfer", { receiver_id: "deposit.near", amount: "1000000" })] } } }], receipts_outcome: [{ id: "execute", block_hash: "block", outcome: { executor_id: "treasury.near", logs: [], status: { SuccessReceiptId: "callback" }, receipt_ids: ["token", "callback"] } }, { id: "token", block_hash: "block", outcome: { executor_id: NATIVE_USDC.near, logs: [transferLog("treasury.near", "deposit.near")], status: { SuccessValue: "" } } }] };
  assert.equal(inspectSourceTransfer(result, config, "payment", attempt).succeeded, true);
  assert.throws(() => inspectSourceTransfer(result, config, "another-payment", attempt));
  result.receipts_outcome![0].outcome.receipt_ids = ["unrelated"];
  assert.throws(() => inspectSourceTransfer(result, config, "payment", attempt));
  result.receipts_outcome![0].outcome.receipt_ids = ["token"];
  result.receipts_outcome![1].outcome.logs = [];
  assert.throws(() => inspectSourceTransfer(result, config, "payment", attempt));
  result.receipts_outcome![1].outcome.status = { Failure: "ft_transfer failed" };
  assert.equal(inspectSourceTransfer(result, config, "payment", attempt).succeeded, false);
});

test("direct NEAR authorization is explicit and preserves the exact native-token amount", () => {
  assert.deepEqual(executionTerms({ kind: "direct", network: "near", assetId: `nep141:${NATIVE_USDC.near}`, recipient: "recipient.near", amountIn: "9007199254740993", amountOut: "9007199254740993", deadline: "2026-12-01T00:00:00Z", authorization: "NEAR treasury approval" }), { kind: "direct", sourceReceiver: "recipient.near", amountIn: "9007199254740993", amountOut: "9007199254740993", deadline: "2026-12-01T00:00:00Z", quoteId: "direct" });
});

test("discarded primary routes do not prove failure and cold time only gates a new deposit", () => {
  const attempt = (status: string) => ({ id: "a", route: "primary", reconciliation: JSON.stringify({ chain: { attempts: [{ id: "a", status }] } }) }) as PayoutAttempt;
  assert.equal(hasProvenPrimaryFailure(attempt("discarded")), false);
  assert.equal(hasProvenPrimaryFailure(attempt("prepared")), false);
  assert.equal(hasProvenPrimaryFailure(attempt("transfer_failed")), true);
  assert.equal(hasProvenPrimaryFailure(attempt("refunded")), true);
  const current = Date.now();
  const quote = { quoteRequest: { deadline: new Date(current + 2 * 60 * 60_000).toISOString() }, quote: { deadline: new Date(current + 2 * 60 * 60_000).toISOString(), timeWhenInactive: new Date(current + 10 * 60_000).toISOString() } } as QuoteResponse;
  assert.equal(quoteDepositWindow(quote).refundDeadline - current, 2 * 60 * 60_000);
  assert.equal(quoteDepositWindow(quote).startBefore - current, 10 * 60_000);
  assertCanStartDeposit(quote, current);
  assert.throws(() => assertCanStartDeposit(quote, current + 11 * 60_000));
});

test("receipt replay is blocked and complete CSV exports stay scoped and spreadsheet-safe", () => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES('u','Finance',?)").run(now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES('org','Company','u',?,?)").run(now, now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES('other','Other','u',?,?)").run(now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_network,primary_address,created_at,updated_at) VALUES('r','org',?,'employee','near','recipient.near',?,?)").run('=HYPERLINK("https://example.invalid")', now, now);
  transaction(() => {
    const insert = db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES(?,'org','r','payroll',?,'1000000','10000','draft',1,'{}',?,?)");
    for (let index = 0; index < 501; index++) insert.run(`p${index}`, index === 0 ? "+spreadsheet-command" : `reference${index}`, now, now);
    const ledger = db.prepare("INSERT INTO treasury_ledger(id,organization_id,reference,entry_type,amount,balance_after,reserved_after,created_at) VALUES(?,'org',?,'payment_reserved','0','0','0',?)");
    for (let index = 0; index < 1001; index++) ledger.run(`l${index}`, `ledger${index}`, now);
    db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,recipient_version,recipient_snapshot,created_at,updated_at) VALUES('hidden','other','r','payment','PRIVATE_OTHER_ORG','1','0','draft',1,'{}',?,?)").run(now, now);
  });
  const fund = db.prepare("INSERT INTO funding_legs(id,organization_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,created_at,updated_at) VALUES(?,'org',?,'asset','1','1','{}','deposit.near','treasury.near','pending_deposit',?,?)");
  fund.run("fund1", "fund1", now, now); fund.run("fund2", "fund2", now, now);
  const insertReceipt = db.prepare("INSERT INTO funding_credit_receipts(id,funding_id,organization_id,network,token_contract,transaction_hash,receipt_id,log_index,data_index,amount,evidence,verified_by,verified_at) VALUES(?,?,'org','mainnet',?,'tx','receipt',0,0,'1','{}','u',?)");
  insertReceipt.run("proof1", "fund1", NATIVE_USDC.near, now);
  assert.throws(() => insertReceipt.run("proof2", "fund2", NATIVE_USDC.near, now));
  const exported = accountingExport({ userId: "u", organizationId: "org", permissions: ["reports:read"] });
  const records = parseCsv(exported);
  assert.equal(records.filter((record) => record.record_type === "obligation").length, 501);
  assert.equal(records.filter((record) => record.record_type === "treasury_ledger").length, 1001);
  assert.equal(exported.includes("PRIVATE_OTHER_ORG"), false);
  assert.ok(records.some((record) => record.payment_reference === "'+spreadsheet-command"));
  assert.equal(csvCell("\t=1+1"), '"\'\t=1+1"');
  assert.equal(csvCell("-0.5"), '"-0.5"');
});


test("resolved funding leaves reconciliation and existing jobs complete without a provider call", async () => {
  const db = getDb(), created = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES('fund-owner','Owner',?)").run(created);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES('fund-org','Funding company','fund-owner',?,?)").run(created, created);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES('fund-role','fund-org','Owner',?,1,?)").run(JSON.stringify(["company:read","payments:read","payments:prepare"]), created);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES('fund-org','fund-owner','fund-role',?)").run(created);
  const insert = db.prepare("INSERT INTO funding_legs(id,organization_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,created_at,updated_at) VALUES(?,'fund-org',?,'asset','1','1','{}','deposit.near','treasury.near',?,?,?)");
  for (const status of ["confirmed", "refunded_verified", "closed_unsent", "cancelled", "recovery_pending", "refunded"]) insert.run(`status-${status}`, status, status, created, created);
  const access = { userId: "fund-owner", organizationId: "fund-org", permissions: ["payments:read"] };
  const review = reconciliationQueue(access);
  assert.deepEqual(review.funding.map(item => item.funding.status).sort(), ["recovery_pending", "refunded"]);
  assert.equal(review.totals.funding, 2);
  enqueueOperations("fund-org");
  assert.equal(db.prepare("SELECT count(*) AS n FROM operation_jobs WHERE organization_id='fund-org' AND kind='reconcile_funding'").get()!.n, 2);
  db.prepare("DELETE FROM operation_jobs WHERE organization_id='fund-org'").run();
  db.prepare("INSERT INTO operation_jobs(id,organization_id,job_key,kind,entity_id,run_at,created_at,updated_at) VALUES('old-confirmed-job','fund-org','old-confirmed','reconcile_funding','status-confirmed',?,?,?)").run(created, created, created);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Closed funding must not poll a provider"); };
  try {
    await tickOperations({ organizationId: "fund-org", maxJobs: 1 });
    assert.equal(db.prepare("SELECT status FROM operation_jobs WHERE id='old-confirmed-job'").get()!.status, "completed");
  } finally { globalThis.fetch = original; }
});

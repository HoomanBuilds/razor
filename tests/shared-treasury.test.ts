import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/server/context";
import { deriveSharedCompanyId, inspectSharedDeposit, inspectTokenReceipt, sharedFundingMessage, tokenReceiptIdentity, treasuryAction, treasuryArgs, view, verifySharedDeposit, type FinalTransaction } from "../src/server/payments/near";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { TreasuryConfig } from "../src/server/payments/types";
import { assertSameQuote, type QuoteResponse } from "../src/server/payments/intents";

const config: TreasuryConfig = { organization_id: "one", company_id: deriveSharedCompanyId("one", "owner.near"), architecture: "shared_v1", near_account_id: "shared.near", network: "mainnet", token_contract: NATIVE_USDC.near };
const deposit = { company_id: config.company_id!, deposit_id: "deposit-one", token_contract: config.token_contract, sender_id: "intents.near", amount: "1000000", kind: "funding" as const, credited_at_ms: "1" };
const log = (standard: string, event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data: [data] })}`;
function result(): FinalTransaction {
  return { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: "tx", signer_id: "solver.near" }, receipts_outcome: [
    { id: "token-receipt", block_hash: "block", outcome: { executor_id: config.token_contract, logs: [log("nep141", "ft_transfer", { old_owner_id: "intents.near", new_owner_id: "shared.near", amount: deposit.amount })], status: { SuccessReceiptId: "credit-receipt" } } },
    { id: "credit-receipt", block_hash: "block", outcome: { executor_id: config.near_account_id, logs: [log("razor", "deposit_credited", deposit)], status: { SuccessValue: "" } } }
  ] };
}

test("all shared contract calls bind the persisted company while token registration remains global", async () => {
  const args = treasuryArgs(config, { payment_id: "p" });
  assert.equal(args.company_id, config.company_id);
  assert.throws(() => treasuryArgs(config, { company_id: deriveSharedCompanyId("other", "owner.near") }), (error: ApiError) => error.code === "TREASURY_COMPANY_MISMATCH");
  assert.throws(() => treasuryArgs({ ...config, organization_id: "other" }));
  assert.equal((treasuryAction(config, "execute_payment", { payment_id: "p", attempt_id: "a" }).actions[0].params.args as Record<string, string>).company_id, config.company_id);
  assert.deepEqual(treasuryAction({ ...config, near_account_id: config.token_contract }, "storage_deposit", { account_id: config.near_account_id }).actions[0].params.args, { account_id: config.near_account_id });
  const original = globalThis.fetch, requests: {method_name:string;args_base64:string}[] = [];
  globalThis.fetch = async (_url, init) => { const request = JSON.parse(init!.body as string); requests.push(request.params); return Response.json({ result: { result: [...Buffer.from("null")] } }); };
  try { await view(config, "get_balance"); await view(config, "get_platform_config"); }
  finally { globalThis.fetch = original; }
  assert.deepEqual(JSON.parse(Buffer.from(requests[0].args_base64, "base64").toString()), { company_id: config.company_id });
  assert.deepEqual(JSON.parse(Buffer.from(requests[1].args_base64, "base64").toString()), {});
});

test("funding messages and signed provider status cannot be reassigned to another company", () => {
  const message = sharedFundingMessage(config, deposit.deposit_id);
  assert.deepEqual(JSON.parse(message), { company_id: config.company_id, deposit_id: deposit.deposit_id, kind: "funding" });
  const quote = { quoteRequest: { customRecipientMsg: message }, quote: {} } as QuoteResponse;
  assert.throws(() => assertSameQuote(quote, { ...quote, quoteRequest: { ...quote.quoteRequest, customRecipientMsg: sharedFundingMessage({ ...config, organization_id: "two", company_id: deriveSharedCompanyId("two", "owner.near") }, deposit.deposit_id) } }));
  assert.notEqual(deriveSharedCompanyId("one", "attacker.near"), config.company_id);
});

test("funding requires the same final transaction to prove exact company credit and canonical token movement", () => {
  const transaction = result(), proof = inspectTokenReceipt(transaction, config, "tx", "solver.near", config.near_account_id, deposit.amount);
  assert.deepEqual(inspectSharedDeposit(transaction, config, proof, deposit.deposit_id), deposit);
  assert.throws(() => inspectSharedDeposit(transaction, { ...config, organization_id: "two", company_id: deriveSharedCompanyId("two", "owner.near") }, proof, deposit.deposit_id));
  assert.throws(() => inspectSharedDeposit(transaction, config, proof, "another-deposit"));
  assert.throws(() => inspectSharedDeposit(transaction, config, proof, deposit.deposit_id, "retained"));
  const unrelated = result(); unrelated.receipts_outcome![1].outcome.executor_id = "fake-shared.near";
  assert.throws(() => inspectSharedDeposit(unrelated, config, proof));
  const missing = result(); missing.receipts_outcome!.pop();
  assert.throws(() => inspectSharedDeposit(missing, config, proof));
  const disconnected = result(); disconnected.receipts_outcome![0].outcome.status = { SuccessValue: "" };
  assert.throws(() => inspectSharedDeposit(disconnected, config, proof));
  assert.throws(() => inspectSharedDeposit({ ...transaction, final_execution_status: "EXECUTED_OPTIMISTIC" }, config, proof));
  assert.throws(() => inspectSharedDeposit(transaction, config, { ...proof, events: [] }));
  assert.throws(() => inspectSharedDeposit(transaction, config, { ...proof, amount: "999999" }));
  assert.equal(tokenReceiptIdentity(proof), tokenReceiptIdentity({ ...proof, transactionHash: "another-attempt-to-reuse-same-receipts" }));
});

test("a final credit event must also exist unchanged in the company's shared deposit ledger", async () => {
  const transaction = result(), proof = inspectTokenReceipt(transaction, config, "tx", "solver.near", config.near_account_id, deposit.amount), original = globalThis.fetch;
  let stored: unknown = deposit;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    return Response.json({ result: request.method === "EXPERIMENTAL_tx_status" ? transaction : { result: [...Buffer.from(JSON.stringify(stored))] } });
  };
  try {
    assert.deepEqual(await verifySharedDeposit(config, proof, deposit.deposit_id), deposit);
    stored = { ...deposit, company_id: "foreign-company" };
    await assert.rejects(() => verifySharedDeposit(config, proof, deposit.deposit_id));
    stored = null;
    await assert.rejects(() => verifySharedDeposit(config, proof, deposit.deposit_id));
  } finally { globalThis.fetch = original; }
});

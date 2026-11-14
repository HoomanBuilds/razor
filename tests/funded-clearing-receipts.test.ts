import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/server/context";
import type { FinalTransaction } from "../src/server/payments/near";
import { assertCashState, assertCashTerms, cashAmount, cashTerms } from "../src/server/clearing/funded-model";
import { fundingMessage, inspectCashDeposit } from "../src/server/clearing/funded-receipts";
import type { CashDeposit, Manifest } from "../src/server/clearing/types";

const deposit: CashDeposit = { company_id: "company-a", deposit_id: "exact-deposit", sender_id: "owner-a.near", submitted: "35000000", accepted: "30000000", unused: "5000000", accepted_at_ms: "1700000000000", accepted_height: "10" };
const target = { transactionHash: "1".repeat(44), token: "usdc.near", clearing: "clearing.near", roundId: "exact-round", manifestHash: "ab".repeat(32), deposit };
function receipt(): FinalTransaction {
  return { final_execution_status: "FINAL", status: { SuccessValue: Buffer.from(JSON.stringify(deposit.accepted)).toString("base64") }, transaction: { hash: target.transactionHash, signer_id: deposit.sender_id, receiver_id: target.token, actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: Buffer.from(JSON.stringify({ receiver_id: target.clearing, amount: deposit.submitted, msg: fundingMessage(target.roundId, target.manifestHash, deposit.company_id, deposit.deposit_id) })).toString("base64") } }] }, transaction_outcome: { outcome: { receipt_ids: ["token-source"] } }, receipts_outcome: [
    { id: "token-source", block_hash: "source-block", outcome: { executor_id: target.token, status: { SuccessReceiptId: "cash-acceptance" }, receipt_ids: ["cash-acceptance"], logs: [`EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer", data: [{ old_owner_id: deposit.sender_id, new_owner_id: target.clearing, amount: deposit.submitted }] })}`] } },
    { id: "cash-acceptance", block_hash: "acceptance-block", outcome: { executor_id: target.clearing, status: { SuccessValue: "" }, receipt_ids: ["unused-return"], logs: [`EVENT_JSON:${JSON.stringify({ standard: "razor-clearing", version: "2.0.0", event: "cash_deposit_accepted", data: [{ round_id: target.roundId, manifest_hash: target.manifestHash, ...deposit }] })}`] } },
    { id: "unused-return", block_hash: "return-block", outcome: { executor_id: target.token, status: { SuccessValue: "" }, logs: [`EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer", data: [{ old_owner_id: target.clearing, new_owner_id: deposit.sender_id, amount: deposit.unused }] })}`] } },
  ] };
}
test("a partially accepted escrow deposit proves submitted principal, exact acceptance and actual unused token return", () => {
  const proof = inspectCashDeposit(receipt(), target);
  assert.equal(proof.deposit.accepted, "30000000"); assert.equal(proof.deposit.submitted, "35000000"); assert.equal(proof.deposit.unused, "5000000"); assert.equal(proof.unusedReturnVerified, true); assert.equal(proof.sourceReceiptId, "token-source");
  const mutations: ((value: FinalTransaction) => void)[] = [
    value => { value.final_execution_status = "EXECUTED_OPTIMISTIC"; },
    value => { value.transaction!.signer_id = "different.near"; },
    value => { value.transaction!.receiver_id = "different-token.near"; },
    value => { value.transaction!.actions![0].FunctionCall!.args = Buffer.from("{}").toString("base64"); },
    value => { value.status!.SuccessValue = Buffer.from(JSON.stringify(deposit.submitted)).toString("base64"); },
    value => { value.receipts_outcome![0].outcome.executor_id = "other-token.near"; },
    value => { value.receipts_outcome![1].outcome.logs[0] = value.receipts_outcome![1].outcome.logs[0].replace(target.manifestHash, "cd".repeat(32)); },
    value => { value.receipts_outcome![1].outcome.logs.push(value.receipts_outcome![1].outcome.logs[0]); },
    value => { value.receipts_outcome!.pop(); },
    value => { value.receipts_outcome![2].outcome.logs[0] = value.receipts_outcome![2].outcome.logs[0].replace(deposit.sender_id, "attacker.near"); },
    value => { value.receipts_outcome![0].outcome.receipt_ids = []; value.receipts_outcome![0].outcome.status = { SuccessValue: "" }; },
  ];
  for (const mutate of mutations) { const value = receipt(); mutate(value); assert.throws(() => inspectCashDeposit(value, target), (error: unknown) => error instanceof ApiError && error.code === "FUNDED_CLEARING_SOURCE_UNVERIFIED"); }
});

function manifest(): Manifest {
  const participants = ["a", "b"].map(id => ({ company_id: `company-${id}`, treasury_id: "treasury.near", treasury_company_id: `company-${id}:aaaaaaaaaaaaaaaa`, owner_id: `owner-${id}.near`, version: "1", policy_version: "1" }));
  const value: Manifest = { id: "round", asset: "USDC", fee: "0", starts_at_ms: "1", expires_at_ms: "9999999999999", participants, obligations: [{ id: "ab", terms_hash: "11".repeat(32), debtor: "company-a", creditor: "company-b", original: "100000000", reduction: "70000000", residual: "30000000" }, { id: "ba", terms_hash: "22".repeat(32), debtor: "company-b", creditor: "company-a", original: "70000000", reduction: "70000000", residual: "0" }] };
  value.cash = cashTerms(value, "mainnet", "usdc.near"); return value;
}
test("cash positions use original net obligations and strict amounts rather than gross invoice delivery", () => {
  const value = manifest(); assertCashTerms(value, "mainnet", "usdc.near");
  assert.equal(value.cash!.positions[0].deposit_due, "30000000"); assert.equal(value.cash!.positions[1].credit_due, "30000000");
  for (const amount of ["", "-1", "01", "1.0", "1e6", (1n << 128n).toString()]) assert.throws(() => cashAmount(amount));
  assert.equal(cashAmount("9007199254740993"), 9007199254740993n);
  const changed = structuredClone(value); changed.cash!.positions[1].destination = "attacker.near"; assert.throws(() => assertCashTerms(changed, "mainnet", "usdc.near"));
  const extreme = structuredClone(value), maximum = ((1n << 128n) - 1n).toString(); extreme.obligations[0].original = maximum; extreme.obligations[1].original = maximum; extreme.obligations.push({ ...extreme.obligations[0], id: "extra", original: "1" });
  assert.throws(() => cashTerms(extreme, "mainnet", "usdc.near"));
  const accounts = value.cash!.positions.map(party => ({ ...party, deposited: "0", credit_available: "0", credit_paid: "0", refund_available: "0", refund_paid: "0", nonce: "0", pending: null, last_transfer: null }));
  assertCashState(value, { stage: "funding", accounts, deposits: [] });
  assert.throws(() => assertCashState(value, { stage: "credits", accounts, deposits: [] }));
});

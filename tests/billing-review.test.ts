import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBillingReview, billingReviewIdentity, billingWalletActions } from "../src/lib/billing-review";
import type { NearWalletAction } from "../src/lib/near-actions";

function fixture() {
  const walletActions: NearWalletAction[] = [{ receiverId: "usdc.near", actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: { receiver_id: "billing.near", amount: "29000000", msg: "signed-invoice" }, gas: "100000000000000", deposit: "1" } }] }];
  return { invoice: { id: "invoice-one", termsHash: "exact-terms", amount: "29000000", payerAccount: "payer.near", billingContract: "billing.near", tokenContract: "usdc.near" }, network: "mainnet" as const, signerAccounts: ["payer.near"], walletActions };
}

test("subscription confirmation rejects changed commercial and signer bindings", () => {
  const reviewed = fixture();
  assert.doesNotThrow(() => assertBillingReview(reviewed, structuredClone(reviewed)));
  for (const patch of [{ id: "other-invoice" }, { amount: "99000000" }, { termsHash: "new-price" }, { payerAccount: "other.near" }, { billingContract: "other.near" }, { tokenContract: "other.near" }]) assert.throws(() => assertBillingReview(reviewed, { ...reviewed, invoice: { ...reviewed.invoice, ...patch } }), /changed/);
  assert.throws(() => assertBillingReview(reviewed, { ...reviewed, network: "testnet" }), /changed/);
  assert.throws(() => assertBillingReview(reviewed, { ...reviewed, signerAccounts: ["other.near"] }), /changed/);
});

test("subscription review snapshots exact attached amounts, signed offers and contract calls", () => {
  const reviewed = fixture(), identity = billingReviewIdentity(reviewed);
  for (const alter of [
    (calls: NearWalletAction[]) => { calls[0].receiverId = "other.near"; },
    (calls: NearWalletAction[]) => { calls[0].actions[0].params.deposit = "1000000000000000000000000"; },
    (calls: NearWalletAction[]) => { calls[0].actions[0].params.gas = "200000000000000"; },
    (calls: NearWalletAction[]) => { calls[0].actions[0].params.args = { amount: "99000000" }; },
    (calls: NearWalletAction[]) => { calls[0].actions[0].params.methodName = "ft_transfer"; },
  ]) {
    const current = structuredClone(reviewed); alter(current.walletActions);
    assert.throws(() => assertBillingReview(reviewed, current), /changed/);
  }
  reviewed.walletActions[0].actions[0].params.args = { msg: "replacement" };
  assert.notEqual(identity, billingReviewIdentity(reviewed));
});

test("subscription wallet signing permits only the exact one-yocto token transfer call", () => {
  const review = fixture();
  assert.deepEqual(billingWalletActions(review), review.walletActions);
  for (const change of [
    { receiver_id: "another.near", amount: "29000000", msg: "signed-invoice" },
    { receiver_id: "billing.near", amount: "29000001", msg: "signed-invoice" },
    { receiver_id: "billing.near", amount: "29000000", msg: "" },
    "not an object",
  ]) {
    const current = structuredClone(review);
    const raw = current.walletActions[0].actions[0].params as { args: unknown };
    raw.args = change;
    assert.throws(() => billingWalletActions(current), /invalid|changed/);
  }
  const attached = structuredClone(review); attached.walletActions[0].actions[0].params.deposit = "2";
  assert.throws(() => billingWalletActions(attached), /do not match/);
  assert.throws(() => billingWalletActions({ ...review, walletActions: [review.walletActions[0], review.walletActions[0]] }), /do not match/);
  assert.throws(() => billingWalletActions({ ...review, signerAccounts: ["different.near"] }), /exact verified payer/);
});

import { RequestError } from "./api";
import type { NearWalletAction } from "./near-actions";

interface CheckoutReview {
  invoice: { id: string; termsHash: string; amount: string; payerAccount: string; billingContract: string; tokenContract: string };
  network: "mainnet" | "testnet";
  signerAccounts: string[];
  walletActions: { receiverId: string; actions: { type: "FunctionCall"; params: { methodName: string; args: unknown; gas: string; deposit: string } }[] }[];
}

export function billingReviewIdentity(review: CheckoutReview): string {
  return JSON.stringify({ invoice: review.invoice.id, terms: review.invoice.termsHash, amount: review.invoice.amount, payer: review.invoice.payerAccount, receiver: review.invoice.billingContract, token: review.invoice.tokenContract, network: review.network, signers: review.signerAccounts, calls: review.walletActions });
}

export function assertBillingReview(reviewed: CheckoutReview, current: CheckoutReview) {
  if (billingReviewIdentity(reviewed) !== billingReviewIdentity(current)) throw new RequestError("The invoice or wallet calls changed. Review the updated price, period, signer and calls before paying.", 409, "BILLING_REVIEW_CHANGED");
}

export function billingWalletActions(review: CheckoutReview): NearWalletAction[] {
  const transaction = review.walletActions[0], call = transaction?.actions[0];
  if (review.signerAccounts.length !== 1 || review.signerAccounts[0] !== review.invoice.payerAccount) throw new RequestError("The invoice requires its exact verified payer wallet. Refresh the signing review.", 409, "BILLING_CALL_INVALID");
  if (review.walletActions.length !== 1 || !transaction || transaction.actions.length !== 1 || transaction.receiverId !== review.invoice.tokenContract || call?.type !== "FunctionCall" || call.params.methodName !== "ft_transfer_call" || call.params.deposit !== "1" || !/^[1-9]\d{0,14}$/.test(call.params.gas) || BigInt(call.params.gas) > 300_000_000_000_000n) throw new RequestError("Subscription payment calls do not match the reviewed token transfer. Refresh the invoice before signing.", 409, "BILLING_CALL_INVALID");
  const args = call.params.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new RequestError("The subscription transfer arguments are invalid. Refresh the invoice.", 409, "BILLING_CALL_INVALID");
  const values = args as Record<string, unknown>;
  if (values.receiver_id !== review.invoice.billingContract || values.amount !== review.invoice.amount || typeof values.msg !== "string" || !values.msg) throw new RequestError("Subscription amount or receiver changed. Review the saved invoice before signing.", 409, "BILLING_CALL_INVALID");
  return [{ receiverId: transaction.receiverId, actions: [{ type: "FunctionCall", params: { ...call.params, args: values } }] }];
}

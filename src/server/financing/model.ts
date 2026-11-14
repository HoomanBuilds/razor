import { createHash } from "node:crypto";
import { z } from "zod";
import { validNearAccount } from "../payments/near";
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const integer = /^(0|[1-9]\d{0,30})$/;
export const amount = z
  .string()
  .refine(
    (value) => integer.test(value) && BigInt(value) <= 10n ** 30n,
    "Use bounded exact microUSDC",
  );
const positive = amount.refine(
    (value) => integer.test(value) && BigInt(value) > 0n,
  ),
  account = z.string().refine(validNearAccount, "Use a verified NEAR account"),
  id = z.string().uuid(),
  reason = z.string().trim().min(10).max(500);
export const requestInput = z
  .object({
    scopeId: z.string().min(1).max(100),
    principal: positive,
    maxCost: amount,
    collateral: amount,
    tenorDays: z.number().int().min(1).max(366),
    graceDays: z.number().int().min(0).max(30),
    fundBy: z.string().datetime(),
    repaymentSource: reason,
    purpose: reason,
    receivableBillId: id.optional(),
    publicMarketConsent: z.literal(true),
    requestKey: id,
  })
  .strict();
export const offerInput = z
  .object({
    accountId: account,
    interest: amount,
    fee: amount,
    expiresAt: z.string().datetime(),
    requestKey: id,
  })
  .strict();
export const acceptInput = z
  .object({
    offerId: id,
    offerHash: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledgeRisk: z.literal(true),
  })
  .strict();
export const actionInput = z
  .object({
    action: z.enum([
      "register",
      "principal",
      "collateral",
      "advance",
      "repayment",
      "withdraw",
      "cancel",
      "default",
      "dispute",
      "resume",
      "recover_advance",
      "void_deposit",
    ]),
    amount: positive.optional(),
    accountId: account.optional(),
    depositId: id.optional(),
    disputeNonce: z.string().regex(/^\d+$/).optional(),
    creditId: z
      .string()
      .refine(
        (value) =>
          /^[1-9]\d{0,19}$/.test(value) &&
          BigInt(value) <= 18446744073709551615n,
      )
      .optional(),
  })
  .strict();
export const paging = z
  .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
  .strict();
export interface Scope {
  id: string;
  version: number;
  label: string;
  eligibility: string;
  network: "mainnet" | "testnet";
  contract_id: string;
  token_contract: string;
  treasury_id: string;
  code_hash: string;
  allowed_organizations_json: string;
  allowed_lenders_json: string;
  active: number;
  published_by: string;
  published_at: string;
}
export interface RequestRow {
  id: string;
  organization_id: string;
  borrower_user_id: string;
  scope_id: string;
  scope_version: number;
  fund_by: string;
  request_key: string;
  input_hash: string;
  payload_ciphertext: string;
  scope_ciphertext: string;
  state: string;
  accepted_offer_id: string | null;
  loan_id: string | null;
  terms_ciphertext: string | null;
  terms_hash: string | null;
  chain_ciphertext: string | null;
  reconciled_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface OfferRow {
  id: string;
  request_id: string;
  lender_user_id: string;
  lender_account: string;
  request_key: string;
  input_hash: string;
  payload_ciphertext: string;
  offer_hash: string;
  state: string;
  created_at: string;
}
export interface LoanTerms {
  id: string;
  request_id: string;
  company_id: string;
  borrower: string;
  lender: string;
  principal: string;
  interest: string;
  fee: string;
  collateral: string;
  tenor_ms: string;
  grace_ms: string;
  fund_by_ms: string;
  repayment_source: string;
  receivable_hash: string | null;
  waterfall: "principal_interest_fee";
  default_rule: "fixed_bond_only_after_due_plus_grace";
  collateral_rule: "remaining_bond_to_borrower";
  dispute_rule: "bilateral_resume_no_repricing";
}
export interface ChainLoan {
  terms: LoanTerms;
  terms_json: string;
  terms_hash: string;
  stage: string;
  principal_funded: string;
  collateral_funded: string;
  advanced: string;
  principal_paid: string;
  interest_paid: string;
  fee_paid: string;
  cash_repaid: string;
  collateral_applied: string;
  lender_credit: string;
  lender_withdrawn: string;
  borrower_refund: string;
  borrower_withdrawn: string;
  activated_at_ms: string | null;
  due_at_ms: string | null;
  nonce: string;
  pending: {
    kind: string;
    nonce: string;
    amount: string;
    receiver: string;
  } | null;
  disputed: boolean;
  dispute_nonce: string;
  borrower_resumed: boolean;
  lender_resumed: boolean;
  principal_deposits: number;
  collateral_deposits: number;
  repayments: number;
  voided_deposits: number;
}
export interface RequestTerms extends z.infer<typeof requestInput> {}

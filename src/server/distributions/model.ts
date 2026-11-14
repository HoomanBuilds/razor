import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../context";

const MAX = (1n << 128n) - 1n;
const canonicalAmount = /^[1-9]\d{0,38}$/;
export const atomic = z.string().regex(canonicalAmount).refine(value => canonicalAmount.test(value) && BigInt(value) <= MAX);
export const distributionInput = z.object({ reference: z.string().trim().min(1).max(100).refine(value => Buffer.byteLength(value, "utf8") <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value), "Use a short reference without control characters"), deadline: z.iso.datetime(),
  requestKey: z.string().uuid(), items: z.array(z.object({ recipientId: z.string().uuid(), amount: atomic }).strict()).min(1).max(64) }).strict();
export const pageInput = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1) }).strict();
export interface Allocation { claimId: string; recipientId: string; recipientVersion: number; boundUserId: string; name: string; address: string; amount: string }
export interface Payload { reference: string; deadline: string; items: Allocation[] }
export interface DistributionRow {
  id: string; organization_id: string; reference: string; input_hash: string; payload_ciphertext: string; plan_ciphertext: string | null;
  plan_hash: string | null; stage: "draft" | "review" | "signing" | "observed" | "voided"; total_amount: string;
  local_reserved: string; chain_reserved: string; pending_amount: string; paid_amount: string; reclaimed_amount: string;
  chain_status: string | null; source_tx_hash: string | null; last_error: string | null; created_by: string; created_at: string; updated_at: string;
}
export interface ChainClaim { allocation: { claim_id: string; recipient_id: string; recipient_version: string; amount: string }; destination: string; status: "ready" | "pending" | "paid" | "reclaimed"; nonce: string; sent_day: string }
export interface ChainDistribution {
  id: string; reference: string; network: string; token_contract: string; deadline_ms: string; total: string; unclaimed: string; pending: string;
  paid: string; reclaimed: string; policy_version: string; terms_hash: string; required_approvals: number; approvals: string[];
  status: "proposed" | "active" | "complete" | "closed" | "cancelled"; claims: ChainClaim[];
}
export interface Policy { owner_id: string; paused: boolean; policy_version: string; per_payment_limit: string; daily_limit: string; approvers: string[]; approval_tiers: { required_approvals: number }[] }
export interface FrozenPlan { network: string; treasury: string; companyId: string; token: string; owner: string; policyVersion: string;
  requiredApprovals: number; deadlineMs: string; id: string; reference: string; total: string;
  allocations: { claim_id: string; recipient_id: string; recipient_version: string; amount: string; destination: string }[] }
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function sumEntitlements(items: { amount: string }[]) {
  const value = items.reduce((total, item) => total + BigInt(atomic.parse(item.amount)), 0n);
  if (!value || value > MAX) throw new ApiError(422, "The distribution total exceeds its supported amount", "DISTRIBUTION_AMOUNT_INVALID");
  return value.toString();
}
export function distributionTermsHash(plan: FrozenPlan) {
  // NEAR's serde_json preserve_order makes this field order part of the contract commitment.
  const terms = { domain: "razor_native_distribution_v1", treasury: plan.treasury, company_id: plan.companyId, network: plan.network, token: plan.token,
    id: plan.id, reference: plan.reference,
    claims: plan.allocations.map(item => ({ allocation: { claim_id: item.claim_id, recipient_id: item.recipient_id,
      recipient_version: item.recipient_version, amount: item.amount }, destination: item.destination, status: "ready", nonce: "0", sent_day: "0" })),
    total: plan.total, deadline_ms: plan.deadlineMs, unused_policy: "return_unclaimed_to_company_after_deadline",
    policy_version: plan.policyVersion, required_approvals: plan.requiredApprovals };
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}
export function assertChainTerms(value: ChainDistribution, plan: FrozenPlan) {
  if (value.id !== plan.id || value.network !== plan.network || value.token_contract !== plan.token || value.reference !== plan.reference
    || value.total !== plan.total || value.deadline_ms !== plan.deadlineMs || value.policy_version !== plan.policyVersion
    || value.required_approvals !== plan.requiredApprovals || value.terms_hash !== distributionTermsHash(plan)
    || value.claims.length !== plan.allocations.length || value.claims.some((claim, index) => {
      const { destination, ...expected } = plan.allocations[index]; return claim.destination !== destination || canonical(claim.allocation) !== canonical(expected);
    })) throw new ApiError(409, "The onchain pool differs from the exact reviewed distribution", "DISTRIBUTION_TERMS_MISMATCH");
  for (const amount of [value.total, value.unclaimed, value.pending, value.paid, value.reclaimed]) if (!/^\d{1,39}$/.test(amount) || BigInt(amount) > MAX) throw new ApiError(502, "The distribution totals are invalid", "DISTRIBUTION_TOTALS_INVALID");
  if (value.status !== "proposed" && value.status !== "cancelled" && BigInt(value.unclaimed) + BigInt(value.pending) + BigInt(value.paid) + BigInt(value.reclaimed) !== BigInt(value.total)) throw new ApiError(502, "The distribution does not conserve its entitlements", "DISTRIBUTION_TOTALS_INVALID");
}

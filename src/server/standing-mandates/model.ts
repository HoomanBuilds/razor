import { createHash } from "node:crypto";
import type { RecipientRecord } from "../identity/recipients";
import { validNearAccount } from "../payments/near";
import { ApiError } from "../context";

export interface StandingTerms {
  id: string; recipient_id: string; recipient_version: string; supplier_profile_hash: string;
  actor_id: string; actor_public_key: string; per_payment_max_input: string; period_max_input: string;
  lifetime_max_input: string; period_ms: string; valid_from_ms: string; expires_at_ms: string;
  invoice_condition: "accepted_vendor_bill_application_gate";
}
export interface StandingGrant {
  terms: StandingTerms; destination: { asset_id: string; network: string; address: string };
  policy_version: string; terms_hash: string; approvals: string[]; required_approvals: number;
  paused: boolean; revoked: boolean; period_index: string; period_used_input: string;
  lifetime_used_input: string; pending_input: string;
}
export interface StandingRow {
  id: string; organization_id: string; recipient_id: string; supplier_profile_hash: string;
  supplier_version: number; terms_json: string; terms_hash: string | null; enabled: number;
  invalidated_at: string | null; created_by: string; created_at: string; updated_at: string;
}
export interface StandingPolicy {
  owner_id: string; paused: boolean; policy_version: string; token_contract: string;
  executors: string[]; approvers: string[]; approval_tiers: { required_approvals: number }[];
}
export function supplierHash(value: RecipientRecord): string {
  return createHash("sha256").update(JSON.stringify({ id: value.id, company: value.organization_id,
    user: value.user_id, version: value.version, name: value.name, kind: value.kind, asset: value.primary_asset,
    network: value.primary_network, address: value.primary_address, memo: value.primary_memo,
    status: value.preference_status, archived: value.archived })).digest("hex");
}
export function assertNativeSupplier(value: RecipientRecord, token: string) {
  if (value.archived || value.kind !== "business" || value.preference_status !== "confirmed"
    || value.primary_network !== "near" || !["USDC", `nep141:${token}`].includes(value.primary_asset)
    || value.primary_memo || !validNearAccount(value.primary_address)) {
    throw new ApiError(409, "Standing autopay requires a confirmed business supplier receiving native NEAR USDC without a memo. Use exact-route review for other destinations", "STANDING_NATIVE_ONLY");
  }
}
export function standingProblems(grant: StandingGrant, policy: StandingPolicy, activation: string | null, now = Date.now(), amount = "0"): string[] {
  const problems: string[] = [];
  if (policy.paused || grant.paused || grant.revoked) problems.push("The treasury or grant is paused or revoked");
  if (grant.policy_version !== policy.policy_version) problems.push("Company financial policy changed. Review a new grant");
  if (!policy.executors.includes(grant.terms.actor_id) || policy.owner_id === grant.terms.actor_id || policy.approvers.includes(grant.terms.actor_id)) problems.push("The grant actor needs a dedicated executor role");
  const quorum = Math.max(...policy.approval_tiers.map(tier => tier.required_approvals));
  if (!Number.isInteger(grant.required_approvals) || grant.required_approvals !== quorum || !grant.approvals.includes(policy.owner_id)
    || new Set(grant.approvals.filter(account => account === policy.owner_id || policy.approvers.includes(account))).size < quorum) problems.push("The owner and required company approvers must activate the grant");
  if (now < Number(grant.terms.valid_from_ms)) problems.push("The grant has not started");
  if (now >= Number(grant.terms.expires_at_ms)) problems.push("The grant expired");
  if (!activation || now < Number(activation)) problems.push("Supplier receiving details are in the 24-hour activation delay. Exact-route review remains available");
  if (BigInt(amount) > BigInt(grant.terms.per_payment_max_input)) problems.push("The bill exceeds the per-payment maximum input");
  const index = now >= Number(grant.terms.valid_from_ms) ? (BigInt(now) - BigInt(grant.terms.valid_from_ms)) / BigInt(grant.terms.period_ms) : 0n;
  const used = index === BigInt(grant.period_index) ? BigInt(grant.period_used_input) : 0n;
  if (used + BigInt(amount) > BigInt(grant.terms.period_max_input)) problems.push("The anchored period input allowance is exhausted");
  if (BigInt(grant.lifetime_used_input) + BigInt(amount) > BigInt(grant.terms.lifetime_max_input)) problems.push("The lifetime input allowance is exhausted");
  return problems;
}

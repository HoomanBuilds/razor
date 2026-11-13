import { providerOutcome } from "../payments/policy";
import type { FundingLeg } from "../payments/types";

export function fundingStateAfterProvider(current: Pick<FundingLeg, "status">, providerStatus: string) {
  if (["confirmed", "refunded_verified", "refunded_attested"].includes(current.status)) return current.status;
  if (providerStatus === "PENDING_DEPOSIT" && ["source_unknown", "closed_unsent", "cancelled"].includes(current.status)) return current.status;
  return providerOutcome(providerStatus);
}

import { ApiError } from "../context";
import type { ChainLoan } from "./model";
import type { DeploymentAnchor } from "./deployment";

export function requireNotOlder(
  incoming: DeploymentAnchor,
  previous?: DeploymentAnchor | null,
) {
  if (!previous) return;
  if (
    incoming.network !== previous.network ||
    incoming.accountId !== previous.accountId ||
    incoming.codeHash !== previous.codeHash ||
    incoming.blockHeight < previous.blockHeight ||
    (incoming.blockHeight === previous.blockHeight &&
      incoming.blockHash !== previous.blockHash)
  )
    throw new ApiError(
      409,
      "A newer or conflicting finalized loan observation already exists. Refresh the original agreement",
      "FINANCING_OBSERVATION_STALE",
    );
}
export function requireMonotonicLoan(
  previous: ChainLoan | null,
  incoming: ChainLoan,
) {
  if (!incoming.observation)
    throw new ApiError(
      409,
      "A pinned finalized loan observation is required",
      "FINANCING_OBSERVATION_REQUIRED",
    );
  if (!previous) return;
  requireNotOlder(incoming.observation, previous.observation);
  const transitions: Record<string, string[]> = {
    funding: [
      "funding",
      "advance_pending",
      "active",
      "defaulted",
      "repaid",
      "cancelled",
    ],
    advance_pending: [
      "advance_pending",
      "funding",
      "active",
      "defaulted",
      "repaid",
      "cancelled",
    ],
    active: ["active", "defaulted", "repaid"],
    defaulted: ["defaulted", "repaid"],
    repaid: ["repaid"],
    cancelled: ["cancelled"],
  };
  if (!transitions[previous.stage]?.includes(incoming.stage))
    throw new ApiError(
      409,
      "Reconciliation cannot reopen or regress a conclusively settled loan",
      "FINANCING_OBSERVATION_REGRESSION",
    );
  const counters = [
    "principal_funded",
    "collateral_funded",
    "advanced",
    "principal_paid",
    "interest_paid",
    "fee_paid",
    "cash_repaid",
    "collateral_applied",
    "lender_withdrawn",
    "borrower_withdrawn",
    "nonce",
    "dispute_nonce",
    "principal_deposits",
    "collateral_deposits",
    "repayments",
    "voided_deposits",
  ] as const;
  if (
    counters.some((key) => BigInt(incoming[key]) < BigInt(previous[key])) ||
    (previous.advanced !== "0" &&
      (incoming.activated_at_ms !== previous.activated_at_ms ||
        incoming.due_at_ms !== previous.due_at_ms)) ||
    (!previous.pending &&
      incoming.pending &&
      BigInt(incoming.pending.nonce) <= BigInt(previous.nonce)) ||
    (previous.pending &&
      incoming.pending &&
      previous.pending.nonce === incoming.pending.nonce &&
      JSON.stringify(previous.pending) !== JSON.stringify(incoming.pending))
  )
    throw new ApiError(
      409,
      "The finalized snapshot regresses recorded loan money or pending authority",
      "FINANCING_OBSERVATION_REGRESSION",
    );
}

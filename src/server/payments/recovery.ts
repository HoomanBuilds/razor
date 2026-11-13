import { recoveryAuthority } from "../reconciliation/authority";
import { atomic } from "../../lib/money";
import { createHash } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { row, rows } from "../db";
import { reviewedArtifactHash } from "../near-artifacts";
import { isDirectExecution } from "../reconciliation/direct";
import { contractCodeHash, view } from "./near";
import { getPayment, listAttempts } from "./service";
import type { ChainPayment, TreasuryConfig } from "./types";

export async function paymentRecoveryOverview(access: AccessContext, paymentId: string) {
  requirePermission(access, "payments:read");
  const payment = getPayment(access, paymentId), attempt = listAttempts(access, paymentId).at(-1);
  if (!attempt || ["paid", "cancelled", "partially_paid"].includes(payment.status) || ["delivered", "partially_delivered", "refunded_verified"].includes(attempt.state)) return { available: false as const, payment, attempt: attempt ?? null };
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) throw new ApiError(409, "Connect the original company treasury to reconcile this payout", "TREASURY_SETUP_REQUIRED");
  if (await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "Review the treasury deployment before preparing payout recovery", "TREASURY_CODE_MISMATCH");
  const [chain, policy] = await Promise.all([
    view<ChainPayment | null>(config, "get_payment", { payment_id: paymentId }),
    view<{owner_id:string;settlement_reporter:string|null;approvers:string[];executors:string[]}>(config, "get_config"),
  ]);
  const authority = await recoveryAuthority(config, access.userId);
  const chainAttempt = chain?.attempts.find(item => item.id === attempt.id);
  if (chain && (chain.amount !== payment.amount || chain.max_fee !== payment.max_fee || chain.recipient_id !== payment.recipient_id || chain.reference !== `razor:${paymentId}`)) throw new ApiError(409, "The original onchain obligation has different terms", "ONCHAIN_TERMS_MISMATCH");
  if (chainAttempt && (chainAttempt.route.quote_hash !== createHash("sha256").update(attempt.quote).digest("hex") || chainAttempt.route.input_amount !== attempt.amount_in || chainAttempt.route.output_amount !== attempt.expected_output || chainAttempt.route.source_receiver !== attempt.deposit_address)) throw new ApiError(409, "The original onchain route differs from this saved payout", "ONCHAIN_ROUTE_MISMATCH");
  if (attempt.state === "closed_unfunded" && (!chainAttempt || ["discarded", "transfer_failed", "refunded"].includes(chainAttempt.status))) return { available: false as const, payment, attempt };
  const wallets = rows<{address:string}>("SELECT address FROM linked_wallets WHERE user_id=? AND family='near' AND network=?", access.userId, config.network).map(item => item.address);
  const ownerAccounts = access.permissions.includes("payments:approve") ? wallets.filter(account => account === policy.owner_id) : [];
  const reporterAccounts = access.permissions.includes("payments:approve") ? wallets.filter(account => account === policy.owner_id || account === policy.settlement_reporter) : [];
  const refundAccounts = authority.shared ? authority.refundAccounts : reporterAccounts;
  const sourceRecoveryAccounts = [...new Set([...ownerAccounts, ...refundAccounts])];
  const executorAccounts = access.permissions.includes("payments:execute") ? wallets.filter(account => account === policy.owner_id || policy.approvers.includes(account) || policy.executors.includes(account)) : [];
  const quote = JSON.parse(attempt.quote), direct = isDirectExecution(quote);
  const deadline = direct ? quote.deadline : quote.quote.deadline ?? quote.quoteRequest.deadline;
  const observed = BigInt(attempt.observed_output ?? "0") > 0n || BigInt(chainAttempt?.actual_output ?? "0") > 0n;
  const reportable = !!chainAttempt && ["source_sent", "uncertain", "refund_pending"].includes(chainAttempt.status) && reporterAccounts.length > 0 && !direct;
  let provider: {status?:string;swapDetails?:{refundedAmount?:string}} | null = null;
  try { provider = JSON.parse(attempt.reconciliation || "{}").provider ?? null; } catch {}
  let reportedRefundAmount: string | null = null;
  try { if (typeof provider?.swapDetails?.refundedAmount === "string" && atomic(provider.swapDetails.refundedAmount, true) <= BigInt(attempt.amount_in)) reportedRefundAmount = atomic(provider.swapDetails.refundedAmount, true).toString(); } catch {}
  return { available: true as const, payment, attempt, network: config.network, treasuryAccount: config.near_account_id, chainState: chainAttempt?.status ?? "not_registered", ownerAccounts, reporterAccounts, refundAccounts, sourceRecoveryAccounts, executorAccounts,
    providerStatus: provider?.status ?? attempt.provider_status, reportedRefundAmount,
    canRecoverSource: chainAttempt?.status === "sending" && sourceRecoveryAccounts.length > 0,
    canReport: reportable, canReportDelivery: reportable && attempt.state === "reported_delivered", canReportRefund: reportable && !observed,
    canConfirmRefund: chainAttempt?.status === "refund_pending" && !observed && refundAccounts.length > 0,
    canClose: executorAccounts.length > 0 && !observed && !attempt.source_tx_hash && (chainAttempt?.status === "prepared" || !chainAttempt && attempt.state === "prepared" && Date.parse(deadline) <= Date.now()),
    hasObservedDelivery: observed, requiresPlatformRecovery: authority.shared, refundReporter: authority.refundReporter,
    message: chainAttempt?.status === "sending" ? "The source callback is unresolved. The owner can verify the exact final transfer receipt before any retry." : observed && attempt.state !== "reported_delivered" ? "Destination output was observed. Review its actual delivery and any terminal partial settlement; do not resend the original entitlement." : chainAttempt?.status === "refund_pending" ? "The original route is in refund recovery. Confirm the provider's exact returned USDC and the treasury balance before a new route." : "Keep this payout's source, delivery and recovery evidence together. Unknown outcomes never authorize a second transfer." };
}

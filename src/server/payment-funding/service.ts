import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { paymentTermsHash } from "../client-reserves/accounting";
import { assertPaymentLiabilityApproved, getPayment, getTreasury, listAttempts, reconcileFunding, reconcilePayment, reserveApprovedPayment, syncTreasury } from "../payments/service";
import { getSupportedTokens, nativeUsdc, requestQuote, assertCanStartDeposit, quoteDepositWindow, assertSameQuote, checkStatus, type QuoteResponse } from "../payments/intents";
import { normalizeDestination, DestinationError } from "../../lib/recipient-destination";
import type { FundingLeg, WalletTransaction } from "../payments/types";
import { verifyFundingCredit } from "../reconciliation/funding";
import { fundingPositions, verifiedLinkedCredit, type FundingTask } from "./accounting";
import { verifyCompanyFundingTarget } from "../funding-requests/service";
import { recordDepositClaim, requireUnstartedDeposit } from "../funding-requests/deposit";
import { paymentBudget } from "../../lib/payment-budget";

interface Claim { id: string; payment_id: string; organization_id: string; request_key: string; input_hash: string; terms_hash: string; origin_token_json: string | null; state: string; funding_id: string | null; lease_owner: string | null; lease_until: string | null }
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const finalFunding = ["confirmed", "refunded_verified", "refunded_attested", "closed_unsent", "cancelled"];

function running(access: AccessContext) {
  if (row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", access.organizationId)?.paused) throw new ApiError(409, "Company payments are paused. Existing transfers remain available for reconciliation", "PAYMENTS_PAUSED");
}
function currentProfile(access: AccessContext, paymentId: string) {
  const payment = getPayment(access, paymentId);
  const recipient = row<{ version: number; archived: number; preference_status: string; confirmed_at: string | null }>("SELECT version,archived,preference_status,confirmed_at FROM recipients WHERE id=? AND organization_id=?", payment.recipient_id, access.organizationId);
  return !!recipient && !recipient.archived && recipient.preference_status === "confirmed" && !!recipient.confirmed_at && recipient.version === payment.recipient_version;
}
function approved(access: AccessContext, paymentId: string) {
  const payment = getPayment(access, paymentId);
  if (!payment.approved_at || !payment.approved_by) throw new ApiError(409, "Review and approve the exact obligation before funding it", "APPROVAL_REQUIRED");
  if (["paid", "cancelled", "partially_paid"].includes(payment.status)) throw new ApiError(409, "This obligation is already closed. Its source history remains available", "PAYMENT_CLOSED");
  if (!currentProfile(access, paymentId)) throw new ApiError(409, "Receiving preferences changed. Review cancellation and replacement before sending more funds", "RECIPIENT_CHANGED");
  assertPaymentLiabilityApproved(access, payment);
  return payment;
}

export function paymentFundingTask(access: AccessContext, paymentId: string) {
  requirePermission(access, "payments:read");
  return transaction(() => {
    const payment = getPayment(access, paymentId), treasury = getTreasury(access);
    const position = fundingPositions(access.organizationId).find(value => value.payment.id === paymentId)!;
    const attempts = listAttempts(access, paymentId), budget = paymentBudget(payment);
    const sourceTokens = new Map(rows<{ funding_id: string; origin_token_json: string }>("SELECT funding_id,origin_token_json FROM payment_funding_quotes WHERE payment_id=? AND origin_token_json IS NOT NULL AND funding_id IS NOT NULL", paymentId).map(value => [value.funding_id, JSON.parse(value.origin_token_json)]));
    const activeFunding = position.legs.filter(leg => !finalFunding.includes(leg.status) || (leg.status === "confirmed" && verifiedLinkedCredit(access.organizationId, leg) === 0n) || (["closed_unsent", "cancelled"].includes(leg.status) && !!leg.source_tx_hash));
    const preparingQuote = row<Claim>("SELECT * FROM payment_funding_quotes WHERE payment_id=? AND state='quoting' AND lease_until>?", paymentId, now());
    const activeAttempt = attempts.find(attempt => ["prepared", "submitted", "processing", "unknown", "recovery_pending", "reported_delivered", "reported_partial"].includes(attempt.state));
    const ownedCash = position.held + position.clientCash;
    const available = BigInt(treasury.available);
    const required = budget.remaining > BigInt(payment.reserved_amount) ? budget.remaining - BigInt(payment.reserved_amount) : 0n;
    const shortfall = required > ownedCash + available ? required - ownedCash - available : 0n;
    const profileCurrent = currentProfile(access, paymentId);
    let sourceApproved = true;
    try { approved(access, paymentId); } catch { sourceApproved = false; }
    const closed = ["paid", "cancelled", "partially_paid"].includes(payment.status);
    const exhausted = budget.remaining < BigInt(payment.amount) && !closed && BigInt(payment.reserved_amount) === 0n;
    const usableCash = BigInt(treasury.balance) - BigInt(treasury.totalReserved) + ownedCash;
    const creditNeedsRefresh = (position.credit > 0n || position.committed > 0n) && usableCash < required && BigInt(treasury.reserveDeficit) > 0n;
    let stage = "needs_funding", message = "Review the approved amount and quote only its remaining funding need.";
    if (closed) { stage = payment.status; message = payment.status === "partially_paid" ? "This original route is closed with partial delivery. Review its separately approved remainder in Payments; do not fund or resend the full original amount." : payment.status === "paid" ? "Recipient delivery is reconciled. Any source excess remains linked in this history." : "The obligation is cancelled. Continue tracking any existing source transfer; do not send another deposit."; }
    else if (!payment.approved_at) { stage = "needs_approval"; message = "Approve the underlying bill or pay run before starting source funding."; }
    else if (!treasury.config) { stage = "needs_treasury"; message = "Create or connect the company NEAR treasury, then return to fund this saved obligation. Its approval and receiving preferences are preserved."; }
    else if (!profileCurrent || !position.termsMatch || !sourceApproved) { stage = "terms_changed"; message = "Approved terms or receiving preferences changed. Reconcile and review a replacement before sending more money."; }
    else if (activeAttempt && activeAttempt.state !== "prepared") { stage = "reconcile_payout"; message = "A payout may already deliver. Reconcile it before creating another funding or payout attempt."; }
    else if (activeAttempt) { stage = "payout_approvals"; message = "Resume the existing NEAR route preparation, wallet votes or execution. Another source deposit is not requested."; }
    else if (exhausted) { stage = "cost_review"; message = "Prior costs exhausted the approved budget. Financial review is required before any additional funding."; }
    else if (preparingQuote) { stage = "preparing_funding"; message = "A source quote is already being prepared for this exact obligation. Reopen or refresh this task to resume it."; }
    else if (activeFunding.length && shortfall === 0n) { stage = "reconcile_funding"; message = "Cash already covers the remaining approved need. Do not send this source quote. Reconcile or deliberately close its unsent history before continuing."; }
    else if (activeFunding.length) { stage = activeFunding.some(leg => leg.status !== "pending_deposit" || leg.source_tx_hash) ? "reconcile_funding" : "deposit"; message = stage === "deposit" ? "Resume the existing exact source quote. A second payable quote is blocked." : "Track the existing source transfer and verify its final NEAR receipt. Unknown outcomes do not authorize another deposit."; }
    else if (BigInt(payment.reserved_amount) >= budget.remaining && budget.remaining > 0n) { stage = "ready_for_payout"; message = "The approved budget is reserved. Prepare the existing obligation's receiving route and collect its NEAR approvals."; }
    else if (creditNeedsRefresh) { stage = "refresh_treasury"; message = "Source credit or committed cash is not reflected in the treasury balance. Refresh its confirmed balance and reconcile any deficit before sending more money."; }
    else if (shortfall > 0n && treasury.config.network !== "mainnet") { stage = "testnet_funding"; message = "This company treasury is on NEAR testnet. Cross-chain funding uses mainnet; use test tokens for contract testing or configure a separate mainnet company treasury for live funding."; }
    else if (shortfall === 0n) { stage = "reserve_funds"; message = "Confirmed cash can cover the approved obligation. Reserve it without changing its approved terms."; }
    const paused = !!row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", access.organizationId)?.paused;
    const depositAllowed = !paused && stage === "deposit" && access.permissions.includes("payments:prepare") && activeFunding.length === 1;
    const review = { balance: treasury.balance, deficit: treasury.reserveDeficit, terms: paymentTermsHash(payment), remaining: budget.remaining.toString(), reserved: payment.reserved_amount, available: treasury.available, ownedCash: ownedCash.toString(), shortfall: shortfall.toString(), config: treasury.config, profileCurrent, sourceHistory: position.legs.map(leg => ({ id: leg.id, status: leg.status, credited: leg.credited_amount, sourceHash: leg.source_tx_hash, destinationHash: leg.destination_tx_hash })) };
    return { payment, treasury, stage, message, paused, profileCurrent, reviewToken: digest(review), funding: position.legs.map(leg => ({ ...leg, originToken: sourceTokens.get(leg.id) ?? null })), attempts,
      fundingCredit: position.credit.toString(), cashCommitted: position.committed.toString(), linkedCashHeld: position.held.toString(), clientCashHeld: position.clientCash.toString(), required: required.toString(), shortfall: shortfall.toString(),
      excess: (position.credit + position.committed > BigInt(payment.total_spent) + budget.remaining ? position.credit + position.committed - BigInt(payment.total_spent) - budget.remaining : 0n).toString(),
      depositAllowed, canQuote: !paused && stage === "needs_funding" && shortfall > 0n && treasury.config?.network === "mainnet" && access.permissions.includes("payments:prepare"),
      canReserve: !paused && ["reserve_funds", "ready_for_payout"].includes(stage) && (access.permissions.includes("payments:prepare") || access.permissions.includes("payments:approve")) };
  });
}

function ensureTask(access: AccessContext, paymentId: string) {
  const payment = approved(access, paymentId), terms = paymentTermsHash(payment);
  const old = row<FundingTask>("SELECT * FROM payment_funding_tasks WHERE payment_id=? AND organization_id=?", paymentId, access.organizationId);
  if (old && old.terms_hash !== terms) throw new ApiError(409, "The funding task belongs to earlier approved terms", "FUNDING_TERMS_CHANGED");
  if (!old) getDb().prepare("INSERT INTO payment_funding_tasks(payment_id,organization_id,terms_hash,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(paymentId, access.organizationId, terms, access.userId, now(), now());
  return terms;
}

export async function quotePaymentFunding(access: AccessContext, paymentId: string, input: { idempotencyKey: string; reviewToken: string; originAsset: string; refundAddress: string; walletId?: string }) {
  requirePermission(access, "payments:prepare");
  running(access); approved(access, paymentId);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) throw new ApiError(422, "Use a stable funding identifier", "FUNDING_KEY_INVALID");
  const key = digest(input.idempotencyKey), terms = paymentTermsHash(getPayment(access, paymentId));
  const inputHash = digest({ paymentId, terms, originAsset: input.originAsset, refundAddress: input.refundAddress, walletId: input.walletId ?? null });
  const existing = row<Claim>("SELECT * FROM payment_funding_quotes WHERE organization_id=? AND request_key=?", access.organizationId, key);
  if (existing) {
    if (existing.payment_id !== paymentId || existing.input_hash !== inputHash) throw new ApiError(409, "This funding identifier already has different source or obligation terms", "FUNDING_TERMS_CHANGED");
    if (existing.funding_id) return { task: paymentFundingTask(access, paymentId), funding: row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", existing.funding_id, access.organizationId), reused: true };
  }
  const snapshot = paymentFundingTask(access, paymentId);
  if (snapshot.reviewToken !== input.reviewToken) throw new ApiError(409, "Cash, receiving preferences or approved terms changed. Refresh this task before quoting", "FUNDING_REVIEW_STALE");
  if (!snapshot.canQuote) throw new ApiError(409, snapshot.message, "FUNDING_STEP_BLOCKED");
  await syncTreasury(access);
  const tokens = await getSupportedTokens(), token = tokens.find(value => value.assetId === input.originAsset), config = await verifyCompanyFundingTarget(access);
  if (!config || config.network !== "mainnet") throw new ApiError(409, "Configure the company's NEAR mainnet treasury before funding through Intents", "MAINNET_TREASURY_REQUIRED");
  if (!token) throw new ApiError(422, "Choose a currently supported source asset", "ASSET_UNSUPPORTED");
  const destination = nativeUsdc(tokens, "near");
  if (destination.contractAddress !== config.token_contract) throw new ApiError(409, "The settlement token does not match the verified company treasury", "FUNDING_TARGET_CHANGED");
  let refundAddress: string;
  try { refundAddress = normalizeDestination(token.blockchain, input.refundAddress).address; }
  catch (error) { throw new ApiError(422, error instanceof DestinationError ? error.message : "Check the source-chain recovery address", "REFUND_ADDRESS_INVALID"); }
  if (input.walletId && !row("SELECT id FROM linked_wallets WHERE id=? AND user_id=? AND address=? AND (family!='near' OR network='mainnet')", input.walletId, access.userId, refundAddress)) throw new ApiError(403, "Choose a source wallet verified by your account", "FUNDING_WALLET_UNVERIFIED");
  const lease = randomUUID(), quoteId = existing?.id ?? randomUUID();
  const amount = transaction(db => {
    running(access); ensureTask(access, paymentId);
    const current = paymentFundingTask(access, paymentId);
    if (current.reviewToken !== input.reviewToken || !current.canQuote) throw new ApiError(409, "Refresh the current funding need before requesting a source quote", "FUNDING_REVIEW_STALE");
    db.prepare("UPDATE payment_funding_quotes SET state='failed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE payment_id=? AND state='quoting' AND funding_id IS NULL AND lease_until<=?").run(now(), paymentId, now());
    if (row("SELECT id FROM payment_funding_quotes WHERE payment_id=? AND state IN ('quoting','active')", paymentId)) throw new ApiError(409, "An earlier funding quote is still being prepared or tracked", "FUNDING_QUOTE_ACTIVE");
    const commit = BigInt(current.treasury.available);
    const task = row<FundingTask>("SELECT * FROM payment_funding_tasks WHERE payment_id=?", paymentId)!;
    db.prepare("UPDATE payment_funding_tasks SET cash_committed=?,updated_at=? WHERE payment_id=?").run((BigInt(task.cash_committed) + commit).toString(), now(), paymentId);
    db.prepare("INSERT INTO payment_funding_quotes(id,payment_id,organization_id,request_key,input_hash,terms_hash,origin_token_json,state,lease_owner,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'quoting',?,?,?,?) ON CONFLICT(organization_id,request_key) DO UPDATE SET state='quoting',origin_token_json=excluded.origin_token_json,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,updated_at=excluded.updated_at").run(quoteId, paymentId, access.organizationId, key, inputHash, terms, JSON.stringify(token), lease, new Date(Date.now() + 90_000).toISOString(), now(), now());
    return current.shortfall;
  });
  try {
    const quote = await requestQuote({ dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 50, originAsset: token.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: destination.assetId, amount, recipient: config.near_account_id, recipientType: "DESTINATION_CHAIN", refundTo: refundAddress, refundType: "ORIGIN_CHAIN", deadline: new Date(Date.now() + 2 * 3600_000).toISOString(), customRecipientMsg: `razor:payment-funding:${paymentId}` });
    await verifyCompanyFundingTarget(access);
    const funding = transaction(db => {
      running(access); approved(access, paymentId);
      const claim = row<Claim>("SELECT * FROM payment_funding_quotes WHERE id=? AND state='quoting' AND lease_owner=? AND lease_until>?", quoteId, lease, now());
      if (!claim || claim.terms_hash !== paymentTermsHash(getPayment(access, paymentId))) throw new ApiError(409, "The obligation or quote preparation changed. No deposit is authorized", "FUNDING_TERMS_CHANGED");
      const currentConfig = getTreasury(access).config;
      if (!currentConfig || currentConfig.near_account_id !== config.near_account_id || currentConfig.network !== config.network || currentConfig.token_contract !== config.token_contract) throw new ApiError(409, "The company's funding destination changed", "FUNDING_TARGET_CHANGED");
      const id = randomUUID();
      db.prepare("INSERT INTO funding_legs(id,organization_id,payment_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,deposit_memo,recipient_address,status,origin_network,origin_decimals,origin_symbol,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending_deposit',?,?,?,?,?)").run(id, access.organizationId, paymentId, `payment-task:${quoteId}`, token.assetId, quote.quote.amountIn, quote.quote.amountOut, JSON.stringify(quote), quote.quote.depositAddress!, quote.quote.depositMemo ?? null, config.near_account_id, token.blockchain, token.decimals, token.symbol, now(), now());
      db.prepare("UPDATE payment_funding_quotes SET state='active',funding_id=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(id, now(), quoteId);
      return row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", id)!;
    });
    return { task: paymentFundingTask(access, paymentId), funding, reused: false };
  } catch (error) {
    getDb().prepare("UPDATE payment_funding_quotes SET state='failed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='quoting' AND lease_owner=?").run(now(), quoteId, lease);
    throw error;
  }
}

export async function reserveTaskFunding(access: AccessContext, paymentId: string) {
  running(access); approved(access, paymentId);
  await syncTreasury(access);
  transaction(() => { ensureTask(access, paymentId); reserveApprovedPayment(access, paymentId); });
  return paymentFundingTask(access, paymentId);
}

export async function prepareTaskBalanceRefresh(access: AccessContext, paymentId: string) {
  requirePermission(access, "payments:prepare");
  getPayment(access, paymentId);
  const treasury = await syncTreasury(access), config = treasury.config!;
  if (BigInt(treasury.onchain.in_flight) > 0n) throw new ApiError(409, "A NEAR source callback is unresolved. Reconcile it before refreshing the balance", "SOURCE_CALLBACK_PENDING");
  const walletActions: WalletTransaction[] = [{ receiverId: config.near_account_id, actions: [{ type: "FunctionCall", params: { methodName: "refresh_balance", args: {}, gas: "40000000000000", deposit: "0" } }] }];
  return { network: config.network, walletActions };
}

export async function reconcileTaskFunding(access: AccessContext, paymentId: string, input: { fundingId?: string; sourceTxHash?: string; senderAccountId?: string; transactionHash?: string }) {
  requirePermission(access, "payments:read");
  if (input.fundingId || input.sourceTxHash || input.senderAccountId || input.transactionHash) requirePermission(access, "payments:prepare");
  if (!input.fundingId && (input.sourceTxHash || input.senderAccountId || input.transactionHash)) throw new ApiError(422, "Choose the saved source funding leg for this transaction", "FUNDING_ID_REQUIRED");
  getPayment(access, paymentId);
  if (input.fundingId) {
    const leg = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=? AND payment_id=?", input.fundingId, access.organizationId, paymentId);
    if (!leg) throw new ApiError(404, "This funding leg does not belong to the selected obligation", "FUNDING_NOT_FOUND");
    await reconcileFunding(access, leg.id, input.sourceTxHash);
    const reconciled = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", leg.id, access.organizationId)!;
    if (input.senderAccountId || reconciled.status === "reported_delivered") await verifyFundingCredit(access, leg.id, { senderAccountId: input.senderAccountId, transactionHash: input.transactionHash });
  }
  if (listAttempts(access, paymentId).length) await reconcilePayment(access, paymentId);
  await syncTreasury(access);
  const task = paymentFundingTask(access, paymentId);
  if (task.canReserve) reserveApprovedPayment(access, paymentId);
  getDb().prepare("UPDATE payment_funding_quotes SET state='closed',updated_at=? WHERE payment_id=? AND funding_id IN (SELECT id FROM funding_legs WHERE payment_id=? AND status IN ('confirmed','refunded_verified','refunded_attested','cancelled','closed_unsent'))").run(now(), paymentId, paymentId);
  return paymentFundingTask(access, paymentId);
}

export async function closeUnsentFunding(access: AccessContext, paymentId: string, fundingId: string, noTransferConfirmed: boolean) {
  requirePermission(access, "payments:prepare");
  getPayment(access, paymentId);
  if (!noTransferConfirmed) throw new ApiError(422, "Confirm that you never submitted this source transfer", "UNSENT_CONFIRMATION_REQUIRED");
  const leg = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND payment_id=? AND organization_id=?", fundingId, paymentId, access.organizationId);
  if (!leg || leg.source_tx_hash || leg.status !== "pending_deposit") throw new ApiError(409, "A known or uncertain source transfer must be reconciled instead of replaced", "FUNDING_TRANSFER_UNRESOLVED");
  const quote = JSON.parse(leg.quote) as QuoteResponse;
  if (quoteDepositWindow(quote).startBefore > Date.now()) throw new ApiError(409, "The original quote can still accept a deposit. Resume it rather than create another", "FUNDING_QUOTE_ACTIVE");
  const status = await checkStatus(leg.deposit_address, leg.deposit_memo);
  assertSameQuote(quote, status.quoteResponse);
  if (quoteDepositWindow(status.quoteResponse).startBefore > Date.now()) throw new ApiError(409, "The provider still accepts this quote. Continue tracking it before preparing another", "FUNDING_QUOTE_ACTIVE");
  if (status.status !== "PENDING_DEPOSIT") throw new ApiError(409, "The provider has observed source activity. Keep reconciling the original transfer", "FUNDING_TRANSFER_UNRESOLVED");
  transaction(db => {
    const current = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", leg.id, access.organizationId)!;
    if (current.source_tx_hash || current.status !== "pending_deposit") throw new ApiError(409, "Source tracking changed while reviewing this quote", "FUNDING_TRANSFER_UNRESOLVED");
    db.prepare("UPDATE funding_legs SET status='closed_unsent',updated_at=? WHERE id=?").run(now(), leg.id);
    db.prepare("UPDATE payment_funding_quotes SET state='closed',updated_at=? WHERE funding_id=?").run(now(), leg.id);
  });
  return paymentFundingTask(access, paymentId);
}

export async function claimTaskDeposit(access: AccessContext, paymentId: string, fundingId: string, observe = checkStatus) {
  requirePermission(access, "payments:prepare");
  running(access); approved(access, paymentId); ensureTask(access, paymentId);
  await verifyCompanyFundingTarget(access);
  const initial = paymentFundingTask(access, paymentId), leg = initial.funding.find(value => value.id === fundingId);
  if (!initial.depositAllowed || !leg || leg.source_tx_hash || leg.status !== "pending_deposit") throw new ApiError(409, "This source deposit is already claimed or its obligation changed. Reconcile the saved transfer before sending again", "FUNDING_TRANSFER_UNRESOLVED");
  requireUnstartedDeposit(leg, await observe(leg.deposit_address, leg.deposit_memo));
  return transaction(() => {
    running(access); approved(access, paymentId);
    if (!paymentFundingTask(access, paymentId).depositAllowed) throw new ApiError(409, "The funding need changed while opening your wallet. Review the saved obligation", "FUNDING_REVIEW_STALE");
    return recordDepositClaim(leg);
  });
}

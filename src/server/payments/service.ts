import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getDb, row, rows, transaction } from "../db";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { atomic as parseAtomic, usdToToken } from "../../lib/money";
import { assertCanStartDeposit, assertSameQuote, checkStatus, getSupportedTokens, nativeUsdc, notifyDeposit, requestQuote, type QuoteResponse, type Token } from "./intents";
import { BACKUP_NETWORKS, canUseBackup, checkBudget, providerOutcome } from "./policy";
import { contractCodeHash, validNearAccount, view } from "./near";
import { reviewedArtifactHash } from "../near-artifacts";
import type { ApprovalStatus, ChainPayment, FundingLeg, Payment, PayoutAttempt, RecipientSnapshot, TreasuryConfig, WalletTransaction } from "./types";
import { retainPrivateEvidence } from "../reconciliation/evidence";
import { executionTerms, hasProvenPrimaryFailure, isDirectExecution, type DirectExecution, type ExecutionRecord } from "../reconciliation/direct";
import { clientReserveTotals } from "../client-reserves/accounting";
import { DestinationError, normalizeDestination } from "../../lib/recipient-destination";
import { checkedApprovalStatus } from "../treasury-policy/approvals";
import { fundingPositions, linkedFundingTotals } from "../payment-funding/accounting";
import { fundingStateAfterProvider } from "../payment-funding/lifecycle";
import { buildPaymentSummary } from "./summary";
import { recordedRecipientName } from "./recipient-names";

import { completeDelivery, deliveryOutput, liabilityPayments, outputAmount, spentSource } from "../partial-settlement/model";
import { partialProof, recordPartial, type PartialReview } from "../partial-settlement/proof";

const now = () => new Date().toISOString();
const id = () => randomUUID();
const json = (value: unknown) => JSON.stringify(value);
const onchainReference = (payment: Payment) => `razor:${payment.id}`;
function atomic(value: string | bigint, allowZero = false) {
  try { return parseAtomic(value, allowZero); } catch { throw new ApiError(422, "Use a valid unsigned integer token amount within the supported range", "INVALID_AMOUNT"); }
}

const activeStates = ["prepared", "submitted", "processing", "unknown", "recovery_pending", "reported_delivered", "reported_partial"];

function assertRunning(access: AccessContext): void {
  const company = row<{ paused: number }>("SELECT paused FROM organizations WHERE id = ?", access.organizationId);
  if (!company) throw new ApiError(404, "Company not found", "COMPANY_NOT_FOUND");
  if (company.paused) throw new ApiError(409, "Company payments are paused", "PAYMENTS_PAUSED");
}

export function getPayment(access: AccessContext, paymentId: string): Payment {
  requirePermission(access, "payments:read");
  const item = row<Payment>("SELECT * FROM payments WHERE id = ? AND organization_id = ?", paymentId, access.organizationId);
  if (!item) throw new ApiError(404, "Payment not found", "PAYMENT_NOT_FOUND");
  return item;
}

export function listPayments(access: AccessContext, page?: { page: number; pageSize: number }): Payment[] {
  requirePermission(access, "payments:read");
  const query = "SELECT p.*,EXISTS(SELECT 1 FROM payout_attempts a WHERE a.payment_id=p.id AND a.observed_output IS NOT NULL AND a.observed_output!='0') AS partial_delivery_observed FROM payments p WHERE p.organization_id = ? ORDER BY p.created_at DESC,p.id DESC";
  const payments = page ? rows<Payment>(`${query} LIMIT ? OFFSET ?`, access.organizationId, page.pageSize, (page.page - 1) * page.pageSize) : rows<Payment>(query, access.organizationId);
  return payments.map(payment => ({ ...payment, recipientName: recordedRecipientName(access.organizationId, payment) }));
}

export function paymentPage(access: AccessContext, page: number, pageSize: number) {
  requirePermission(access, "payments:read");
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ApiError(422, "Choose a valid payment page and page size", "INVALID_INPUT");
  return transaction(() => {
    const total = row<{ total: number }>("SELECT COUNT(*) AS total FROM payments WHERE organization_id=?", access.organizationId)!.total;
    return { payments: listPayments(access, { page, pageSize }), page, pageSize, total, hasMore: page * pageSize < total };
  });
}

export function paymentSummary(access: AccessContext) {
  requirePermission(access, "payments:read");
  return transaction(() => buildPaymentSummary(access.organizationId, getTreasury(access)));
}

export function listLedger(access: AccessContext) {
  requirePermission(access, "reports:read");
  return rows<Record<string, string>>("SELECT * FROM treasury_ledger WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1000", access.organizationId);
}

function balance(organizationId: string) {
  const current = row<{ balance: string; reserved: string; onchain_reserved: string; updated_at: string }>("SELECT balance,reserved,onchain_reserved,updated_at FROM treasury_balances WHERE organization_id = ?", organizationId) ?? { balance: "0", reserved: "0", onchain_reserved: "0", updated_at: "" };
  const knownChainReserved = rows<{ chain_reserved: string }>("SELECT chain_reserved FROM payments WHERE organization_id=?", organizationId).reduce((sum, payment) => sum + BigInt(payment.chain_reserved), 0n);
  const externalReserved = BigInt(current.onchain_reserved) - knownChainReserved;
  return { ...current, effectiveReserved: (BigInt(current.reserved) + (externalReserved > 0n ? externalReserved : 0n)).toString() };
}

function ledger(organizationId: string, reference: string, entryType: string, amount: string, nextBalance: string, nextReserved: string, metadata: unknown = {}) {
  const db = getDb();
  db.prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET balance=excluded.balance,reserved=excluded.reserved,updated_at=excluded.updated_at").run(organizationId, nextBalance, nextReserved, now());
  db.prepare("INSERT INTO treasury_ledger(id,organization_id,reference,entry_type,amount,balance_after,reserved_after,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id(), organizationId, reference, entryType, amount, nextBalance, nextReserved, json(metadata), now());
}

export function getTreasury(access: AccessContext) {
  requirePermission(access, "company:read");
  const current = balance(access.organizationId);
  const clients = clientReserveTotals(access.organizationId);
  const linked = linkedFundingTotals(access.organizationId);
  const totalReserved = BigInt(current.effectiveReserved) + BigInt(clients.clientReserved) + BigInt(linked.linkedFundingReserved);
  const available = BigInt(current.balance) - totalReserved;
  return { settlementAsset: "USDC", decimals: 6, balance: current.balance, reserved: current.effectiveReserved, paymentReserved: current.effectiveReserved, ...clients, ...linked,
    totalReserved: totalReserved.toString(), reserveDeficit: (available < 0n ? -available : 0n).toString(), available: (available > 0n ? available : 0n).toString(), lastSyncedAt: current.updated_at || null, config: row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id = ?", access.organizationId) ?? null };
}

export function listNetworks(access: AccessContext) {
  requirePermission(access, "company:read");
  const configured = rows<{ network: string; enabled: number }>("SELECT * FROM payment_networks WHERE organization_id=?", access.organizationId);
  return BACKUP_NETWORKS.map((network) => ({ network, enabled: configured.find((item) => item.network === network)?.enabled !== 0 }));
}

export function setNetwork(access: AccessContext, network: string, enabled: boolean) {
  requirePermission(access, "company:manage");
  if (!BACKUP_NETWORKS.includes(network as typeof BACKUP_NETWORKS[number])) throw new ApiError(422, "Choose a supported backup network", "BACKUP_NETWORK_UNSUPPORTED");
  getDb().prepare("INSERT INTO payment_networks(organization_id,network,enabled) VALUES(?,?,?) ON CONFLICT(organization_id,network) DO UPDATE SET enabled=excluded.enabled").run(access.organizationId, network, Number(enabled));
  return { network, enabled };
}

function configFor(access: AccessContext, requireMainnet = false): TreasuryConfig {
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id = ?", access.organizationId);
  if (!config) throw new ApiError(409, "Connect and configure the company NEAR treasury first", "TREASURY_SETUP_REQUIRED");
  if (requireMainnet && config.network !== "mainnet") throw new ApiError(409, "NEAR Intents settlement uses mainnet. Configure a mainnet company treasury for live routes", "MAINNET_TREASURY_REQUIRED");
  return config;
}

export async function configureTreasury(access: AccessContext, input: { nearAccountId: string; network: "mainnet" | "testnet"; tokenContract: string }) {
  requirePermission(access, "company:manage");
  if (!validNearAccount(input.nearAccountId) || !validNearAccount(input.tokenContract)) throw new ApiError(422, "Enter valid NEAR account IDs", "INVALID_ACCOUNT");
  const config: TreasuryConfig = { organization_id: access.organizationId, near_account_id: input.nearAccountId, network: input.network, token_contract: input.tokenContract };
  if (await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "This account does not run the reviewed Razor treasury contract", "TREASURY_CODE_MISMATCH");
  const contract = await view<{ token_contract: string; owner_id: string }>(config, "get_config");
  if (contract.token_contract !== input.tokenContract) throw new ApiError(422, "The treasury contract uses another settlement token", "SETTLEMENT_TOKEN_MISMATCH");
  if (config.network === "mainnet" && config.token_contract !== "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1") throw new ApiError(422, "Live settlement requires native USDC on NEAR", "SETTLEMENT_TOKEN_MISMATCH");
  const wallet = row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, contract.owner_id, config.network);
  if (!wallet) throw new ApiError(403, "Verify the NEAR wallet that owns this treasury before connecting it", "TREASURY_OWNER_UNVERIFIED");
  const existing = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE network=? AND near_account_id=?", input.network, input.nearAccountId);
  if (existing && existing.organization_id !== access.organizationId) throw new ApiError(409, "This treasury is connected to another company", "TREASURY_ALREADY_CONNECTED");
  const current = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (current && (current.near_account_id !== input.nearAccountId || current.network !== input.network || current.token_contract !== input.tokenContract)) throw new ApiError(409, "A connected company treasury cannot be replaced while its ledger is active", "TREASURY_CHANGE_REQUIRES_MIGRATION");
  getDb().prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,created_at) VALUES(?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET near_account_id=excluded.near_account_id,network=excluded.network,token_contract=excluded.token_contract").run(access.organizationId, input.nearAccountId, input.network, input.tokenContract, now());
  return { config, contract, treasury: await syncTreasury(access) };
}

export async function syncTreasury(access: AccessContext) {
  requirePermission(access, "company:read");
  const config = configFor(access);
  if (await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "Treasury code changed. Review the contract before recognizing balances or preparing payments", "TREASURY_CODE_MISMATCH");
  const actual = await view<{ balance: string; reserved: string; available: string; in_flight: string; confirmed_at_ms: string }>(config, "get_balance");
  const confirmed = atomic(actual.balance, true);
  transaction(() => {
    const current = balance(access.organizationId);
    if (confirmed !== BigInt(current.balance)) ledger(access.organizationId, `sync:${id()}`, "onchain_balance_sync", (confirmed - BigInt(current.balance)).toString(), confirmed.toString(), current.reserved, { network: config.network, account: config.near_account_id, contractBalance: actual });
    else getDb().prepare("INSERT INTO treasury_balances(organization_id,balance,reserved,updated_at) VALUES(?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET updated_at=excluded.updated_at").run(access.organizationId, confirmed.toString(), current.reserved, now());
    getDb().prepare("UPDATE treasury_balances SET onchain_reserved=? WHERE organization_id=?").run(atomic(actual.reserved, true).toString(), access.organizationId);
  });
  return { ...getTreasury(access), onchain: actual };
}

export async function prepareTreasurySetup(access: AccessContext) {
  requirePermission(access, "company:manage");
  const config = configFor(access);
  const token = { ...config, near_account_id: config.token_contract };
  const registered = await view<{ total: string; available: string } | null>(token, "storage_balance_of", { account_id: config.near_account_id });
  const actions: WalletTransaction[] = [];
  if (!registered) {
    const bounds = await view<{ min: string }>(token, "storage_balance_bounds");
    actions.push(action({ ...config, near_account_id: config.token_contract }, "storage_deposit", { account_id: config.near_account_id, registration_only: true }, atomic(bounds.min).toString(), "30000000000000"));
  }
  actions.push(action(config, "refresh_balance", {}, "0", "40000000000000"));
  return { config, tokenRegistered: !!registered, walletActions: actions };
}

export interface CreatePaymentInput {
  recipientId: string;
  reference: string;
  amount: string;
  kind?: string;
  maxFee?: string;
  scheduledFor?: string | null;
  metadata?: Record<string, unknown>;
}

export function createPayment(access: AccessContext, input: CreatePaymentInput): Payment {
  requirePermission(access, "payments:prepare");
  const amount = atomic(input.amount).toString();
  const maxFee = atomic(input.maxFee ?? "0", true).toString();
  if (!input.reference.trim() || input.reference.length > 200) throw new ApiError(422, "A stable payment reference is required", "INVALID_REFERENCE");
  if (input.scheduledFor && !Number.isFinite(Date.parse(input.scheduledFor))) throw new ApiError(422, "Invalid scheduled date", "INVALID_DATE");
  return transaction(() => {
    const existing = row<Payment>("SELECT * FROM payments WHERE organization_id = ? AND reference = ?", access.organizationId, input.reference);
    if (existing) {
      if (existing.recipient_id !== input.recipientId || existing.amount !== amount || existing.max_fee !== maxFee || existing.kind !== (input.kind ?? "payment") || existing.scheduled_for !== (input.scheduledFor ?? null) || !isDeepStrictEqual(JSON.parse(existing.metadata), JSON.parse(json(input.metadata ?? {})))) throw new ApiError(409, "This reference is already used with different payment terms", "IDEMPOTENCY_CONFLICT");
      return existing;
    }
    const recipient = row<RecipientSnapshot>("SELECT * FROM recipients WHERE id = ? AND organization_id = ?", input.recipientId, access.organizationId);
    if (!recipient) throw new ApiError(404, "Recipient not found", "RECIPIENT_NOT_FOUND");
    const snapshot = { id: recipient.id, primary_asset: recipient.primary_asset, primary_network: recipient.primary_network, primary_address: recipient.primary_address, primary_memo: recipient.primary_memo ?? null, backup_network: recipient.backup_network, backup_address: recipient.backup_address, fallback_consent: recipient.fallback_consent, version: recipient.version, preference_status: recipient.preference_status, confirmed_at: recipient.confirmed_at, archived: recipient.archived };
    const paymentId = id();
    getDb().prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,scheduled_for,recipient_version,recipient_snapshot,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(paymentId, access.organizationId, input.recipientId, input.kind ?? "payment", input.reference, amount, maxFee, "draft", input.scheduledFor ?? null, recipient.version, json(snapshot), json(input.metadata ?? {}), now(), now());
    return getPayment(access, paymentId);
  });
}

export function revalidatePaymentRecipient(access: AccessContext, paymentId: string): Payment {
  requirePermission(access, "payments:prepare");
  return transaction(() => {
    const payment = getPayment(access, paymentId);
    if (payment.status !== "draft" || payment.approved_at || listAttempts(access, paymentId).length) throw new ApiError(409, "Cancel the approved obligation and prepare a new one before changing its recipient terms", "FRESH_APPROVAL_REQUIRED");
    const recipient = row<RecipientSnapshot>("SELECT * FROM recipients WHERE id=? AND organization_id=? AND archived=0", payment.recipient_id, access.organizationId);
    if (!recipient) throw new ApiError(409, "Choose an active recipient", "RECIPIENT_UNAVAILABLE");
    const snapshot = { id: recipient.id, primary_asset: recipient.primary_asset, primary_network: recipient.primary_network, primary_address: recipient.primary_address, primary_memo: recipient.primary_memo ?? null, backup_network: recipient.backup_network, backup_address: recipient.backup_address, fallback_consent: recipient.fallback_consent, version: recipient.version, preference_status: recipient.preference_status, confirmed_at: recipient.confirmed_at, archived: recipient.archived };
    getDb().prepare("UPDATE payments SET recipient_version=?,recipient_snapshot=?,updated_at=? WHERE id=?").run(recipient.version, json(snapshot), now(), paymentId);
    return getPayment(access, paymentId);
  });
}

export function approvePayment(access: AccessContext, paymentId: string): Payment {
  requirePermission(access, "payments:approve");
  return applyApprovalReservation(access, paymentId, false);
}

export function reserveApprovedPayment(access: AccessContext, paymentId: string): Payment {
  if (!access.permissions.includes("payments:approve")) requirePermission(access, "payments:prepare");
  return applyApprovalReservation(access, paymentId, true);
}

export function assertPaymentLiabilityApproved(access: AccessContext, payment: Payment) {
  const metadata = JSON.parse(payment.metadata) as { billId?: string; runId?: string; partialOf?: string };
  if (metadata.billId) {
    const bill = row<{ status: string }>("SELECT status FROM bills WHERE id=? AND organization_id=? AND payment_id=?", metadata.billId, access.organizationId, payment.id);
    if (!bill || bill.status !== "approved") throw new ApiError(409, "Approve the underlying invoice before approving its payment", "BILL_APPROVAL_REQUIRED");
  }
  if (metadata.runId) {
    const run = row<{ status: string; approved_by: string | null }>("SELECT r.status,r.approved_by FROM payroll_runs r JOIN payroll_items i ON i.run_id=r.id WHERE r.id=? AND r.organization_id=? AND i.payment_id=? AND i.recipient_id=?", metadata.runId, access.organizationId, payment.id, payment.recipient_id);
    const parent = metadata.partialOf && row("SELECT payment_id FROM partial_settlements WHERE payment_id=? AND organization_id=?", metadata.partialOf, access.organizationId);
    const remainder = metadata.partialOf && row<{ remainder_payment_id: string }>("SELECT remainder_payment_id FROM partial_remainders WHERE original_payment_id=? AND organization_id=?", metadata.partialOf, access.organizationId);
    const individualRemainder = !!run?.approved_by && !!parent && !!remainder && liabilityPayments(access.organizationId, remainder.remainder_payment_id).some(entry => entry.id === payment.id);
    if (!run || run.status !== "approved" && !individualRemainder) throw new ApiError(409, "Approve the underlying pay run before approving its payments", "RUN_APPROVAL_REQUIRED");
  }
}

function applyApprovalReservation(access: AccessContext, paymentId: string, existingOnly: boolean): Payment {
  assertRunning(access);
  return transaction(() => {
    const payment = getPayment(access, paymentId);
    if (existingOnly && (!payment.approved_at || !payment.approved_by)) throw new ApiError(409, "Review and approve this obligation before reserving its funding", "APPROVAL_REQUIRED");
    assertPaymentLiabilityApproved(access, payment);
    if (["approved", "prepared", "in_flight", "paid"].includes(payment.status)) return payment;
    if (!["draft", "approved_unfunded", "held"].includes(payment.status)) throw new ApiError(409, "This obligation cannot be approved in its current state", "PAYMENT_STATE_CHANGED");
    const recipient = row<{ version: number; preference_status: string; archived: number }>("SELECT version,preference_status,archived FROM recipients WHERE id = ? AND organization_id = ?", payment.recipient_id, access.organizationId);
    if (!recipient || recipient.version !== payment.recipient_version) throw new ApiError(409, "Recipient details changed. Prepare a new payment for approval", "RECIPIENT_CHANGED");
    if (recipient.archived || recipient.preference_status !== "confirmed") throw new ApiError(409, "Ask the recipient to confirm the payment details before approval", "RECIPIENT_CONFIRMATION_REQUIRED");
    const current = balance(access.organizationId);
    const required = atomic(payment.amount) + atomic(payment.max_fee, true) - atomic(payment.total_spent, true);
    if (required < atomic(payment.amount)) throw new ApiError(409, "The approved fee budget is exhausted", "COST_LIMIT_EXCEEDED");
    const positions = fundingPositions(access.organizationId), own = positions.find(position => position.payment.id === paymentId);
    if (own && !own.termsMatch) throw new ApiError(409, "The obligation changed after funding was committed. Reconcile it before reserving cash", "FUNDING_TERMS_CHANGED");
    const linkedReserved = positions.reduce((sum, position) => sum + position.held, 0n);
    const available = BigInt(current.balance) - BigInt(current.effectiveReserved) - BigInt(clientReserveTotals(access.organizationId).clientReserved) - linkedReserved + BigInt(payment.reserved_amount) + (own?.held ?? 0n) + (existingOnly ? own?.clientCash ?? 0n : 0n);
    const funded = available >= required;
    const reservationDelta = (funded ? required : 0n) - BigInt(payment.reserved_amount);
    if (BigInt(current.reserved) + reservationDelta < 0n) throw new ApiError(409, "Treasury reservations require reconciliation", "RESERVATION_MISMATCH");
    if (reservationDelta !== 0n) ledger(access.organizationId, `reserve:${paymentId}:${id()}`, reservationDelta > 0n ? "payment_reserved" : "reservation_released", (reservationDelta < 0n ? -reservationDelta : reservationDelta).toString(), current.balance, (BigInt(current.reserved) + reservationDelta).toString(), { paymentId, clientPrincipalExchanged: existingOnly ? own?.clientCash.toString() ?? "0" : "0", linkedFundingExchanged: own?.held.toString() ?? "0", classification: existingOnly ? "existing_approved_budget_reservation" : "human_approval" });
    getDb().prepare("UPDATE payments SET status=?,approved_by=COALESCE(approved_by,?),approved_at=COALESCE(approved_at,?),reserved_amount=?,hold_reason=?,updated_at=? WHERE id=?").run(funded ? "approved" : "approved_unfunded", access.userId, now(), funded ? required.toString() : "0", funded ? null : "Fund the payment entitlement and approved costs", now(), paymentId);
    if (funded && existingOnly && own && own.clientCash > 0n) getDb().prepare("UPDATE client_reserves SET state='allocated',allocated_at=COALESCE(allocated_at,?),updated_at=? WHERE organization_id=? AND payment_id=? AND state!='released'").run(now(), now(), access.organizationId, paymentId);
    return getPayment(access, paymentId);
  });
}

export async function cancelPayment(access: AccessContext, paymentId: string) {
  requirePermission(access, "payments:approve");
  const payment = getPayment(access, paymentId);
  if (payment.status === "cancelled") return { payment, walletActions: [] };
  const attempts = listAttempts(access, paymentId);
  if (["paid", "partially_paid"].includes(payment.status) || BigInt(payment.delivered_amount) > 0n || attempts.some((attempt) => activeStates.includes(attempt.state))) throw new ApiError(409, "Reconcile active delivery before cancelling", "ATTEMPT_ACTIVE");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  const chain = config ? await view<ChainPayment | null>(config, "get_payment", { payment_id: paymentId }) : null;
  if (chain && chain.status !== "cancelled") {
    if (!["proposed", "awaiting_approvals", "approved", "retryable", "held"].includes(chain.status)) throw new ApiError(409, "The existing onchain delivery must be reconciled before cancellation", "ONCHAIN_ATTEMPT_UNRESOLVED");
    return { payment, walletActions: [action(config!, "cancel_payment", { payment_id: paymentId }, "1")] };
  }
  transaction(() => {
    const latest = getPayment(access, paymentId);
    if (latest.status === "cancelled") return;
    if (["paid", "partially_paid"].includes(latest.status) || BigInt(latest.delivered_amount) > 0n || row("SELECT id FROM payout_attempts WHERE payment_id=? AND state IN ('prepared','submitted','processing','unknown','recovery_pending','reported_delivered','reported_partial')", paymentId)) throw new ApiError(409, "Payment delivery changed while cancelling. Reconcile it before cancellation", "ATTEMPT_ACTIVE");
    const current = balance(access.organizationId);
    const remaining = BigInt(current.reserved) - BigInt(latest.reserved_amount);
    if (remaining < 0n) throw new ApiError(409, "Treasury reservations require reconciliation", "RESERVATION_MISMATCH");
    if (BigInt(latest.reserved_amount) > 0n) ledger(access.organizationId, `release:${paymentId}`, "reservation_released", latest.reserved_amount, current.balance, remaining.toString(), { paymentId });
    getDb().prepare("UPDATE payments SET status='cancelled',reserved_amount='0',chain_reserved='0',updated_at=? WHERE id=?").run(now(), paymentId);
  });
  if (config) await syncTreasury(access);
  return { payment: getPayment(access, paymentId), walletActions: [] };
}

function ensureRecipient(payment: Payment, access: AccessContext): RecipientSnapshot {
  const current = row<RecipientSnapshot>("SELECT * FROM recipients WHERE id=? AND organization_id=?", payment.recipient_id, access.organizationId);
  if (!current || current.version !== payment.recipient_version) throw new ApiError(409, "Recipient details changed after approval", "RECIPIENT_CHANGED");
  if (current.archived || current.preference_status !== "confirmed" || !current.confirmed_at) throw new ApiError(409, "The recipient must confirm their payout preferences", "PREFERENCES_UNCONFIRMED");
  return JSON.parse(payment.recipient_snapshot) as RecipientSnapshot;
}

function resolveAsset(tokens: Token[], recipient: RecipientSnapshot, backup: boolean): Token {
  if (backup) return nativeUsdc(tokens, recipient.backup_network!);
  if (recipient.primary_asset === "USDC") return nativeUsdc(tokens, recipient.primary_network);
  const token = tokens.find((item) => item.assetId === recipient.primary_asset && item.blockchain === recipient.primary_network);
  if (!token) throw new ApiError(422, "The preferred asset is not currently supported", "PRIMARY_UNAVAILABLE");
  return token;
}

function validatePayoutDestination(network: string, address: string, memo?: string | null) {
  try {
    if (normalizeDestination(network, address, memo).address !== address) throw new ApiError(409, "The recipient must reconfirm the complete encoded receiving address before payment", "DESTINATION_RECONFIRM_REQUIRED");
  } catch (error) { if (error instanceof DestinationError) throw new ApiError(422, error.message, error.code); throw error; }
}

export async function preparePaymentQuote(access: AccessContext, paymentId: string, input: { useBackup?: boolean; dry?: boolean } = {}) {
  requirePermission(access, "payments:execute");
  assertRunning(access);
  const config = configFor(access, true);
  const payment = getPayment(access, paymentId);
  if (!payment.approved_at || ["cancelled", "paid", "partially_paid"].includes(payment.status) || BigInt(payment.delivered_amount) > 0n) throw new ApiError(409, "Approve an unpaid obligation before execution", "APPROVAL_REQUIRED");
  const recipient = ensureRecipient(payment, access);
  const attempts = rows<PayoutAttempt>("SELECT * FROM payout_attempts WHERE payment_id=? ORDER BY created_at", paymentId);
  if (attempts.some((item) => activeStates.includes(item.state))) throw new ApiError(409, "An earlier attempt must be reconciled before preparing another", "ATTEMPT_ACTIVE");
  if (input.useBackup) canUseBackup(payment, recipient, attempts);
  if (input.useBackup && !listNetworks(access).find((network) => network.network === recipient.backup_network)?.enabled) throw new ApiError(409, "The company disabled this backup network", "BACKUP_NETWORK_DISABLED");
  if (payment.reserved_amount === "0") throw new ApiError(409, "Fund and reserve this payment before executing", "PAYMENT_UNFUNDED");
  await syncTreasury(access);
  const tokens = await getSupportedTokens();
  const origin = nativeUsdc(tokens, "near");
  const destination = resolveAsset(tokens, recipient, !!input.useBackup);
  if (input.useBackup && recipient.primary_network === destination.blockchain && (recipient.primary_asset === destination.assetId || recipient.primary_asset === "USDC")) throw new ApiError(409, "A native-USDC backup must use a different receiving network", "BACKUP_NETWORK_DUPLICATE");
  const address = input.useBackup ? recipient.backup_address! : recipient.primary_address;
  if (!address) throw new ApiError(422, "Confirm the receiving destination first", "DESTINATION_REQUIRED");
  validatePayoutDestination(destination.blockchain, address, input.useBackup ? null : recipient.primary_memo);
  const outputFor = (token: Token) => {
    try { return usdToToken(payment.amount, token.symbol === "USDC" ? "1" : token.price ?? "0", token.decimals); } catch { throw new ApiError(422, "A usable valuation is unavailable for the preferred payout asset", "TOKEN_VALUATION_UNAVAILABLE"); }
  };
  const output = outputFor(destination);
  const makeQuote = (token: Token, receivingAddress: string, dry: boolean, memo?: string | null) => {
    validatePayoutDestination(token.blockchain, receivingAddress, memo);
    return requestQuote({ dry, swapType: "EXACT_OUTPUT", slippageTolerance: 50, originAsset: origin.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: token.assetId, amount: outputFor(token), recipient: receivingAddress, recipientType: "DESTINATION_CHAIN", refundTo: config.near_account_id, refundType: "ORIGIN_CHAIN", deadline: new Date(Date.now() + 5 * 60_000).toISOString() });
  };
  if (input.useBackup && !attempts.some(hasProvenPrimaryFailure)) {
    let primaryAvailable = false;
    try {
      const primary = resolveAsset(tokens, recipient, false);
      if (primary.blockchain !== "near" || primary.assetId !== origin.assetId) await makeQuote(primary, recipient.primary_address, true, recipient.primary_memo);
      primaryAvailable = true;
    } catch (error) {
      if (!(error instanceof ApiError) || !["PRIMARY_UNAVAILABLE", "USDC_UNAVAILABLE", "USDC_NETWORK_UNSUPPORTED", "ROUTE_UNAVAILABLE"].includes(error.code)) throw error;
    }
    if (primaryAvailable) throw new ApiError(409, "The preferred payout route is available. Use the preferred destination first", "PRIMARY_AVAILABLE");
  }
  const direct = destination.blockchain === "near" && destination.assetId === origin.assetId;
  const scheduledTime = payment.scheduled_for ? Math.max(0, Date.parse(payment.scheduled_for)) : 0;
  const directDeadline = new Date(Math.max(Date.now(), scheduledTime) + 60 * 60_000).toISOString();
  const quote: ExecutionRecord = direct ? { kind: "direct", network: "near", assetId: destination.assetId, recipient: address, amountIn: payment.amount, amountOut: payment.amount, deadline: directDeadline, authorization: "NEAR treasury approval" } satisfies DirectExecution : await makeQuote(destination, address, !!input.dry, input.useBackup ? null : recipient.primary_memo);
  const terms = executionTerms(quote);
  if (scheduledTime > Date.now() && Date.parse(terms.deadline) < scheduledTime + 60_000) throw new ApiError(409, "The receiving route expires before the scheduled payment. Prepare it closer to the due time, or choose direct native USDC on NEAR", "SCHEDULE_OUTLIVES_ROUTE");
  checkBudget(payment, terms.amountIn);
  if (input.dry) return { quote, dry: true, valuation: destination.symbol === "USDC" ? null : { price: destination.price, priceUpdatedAt: destination.priceUpdatedAt, entitlement: payment.amount } };
  if (!validNearAccount(terms.sourceReceiver) || !isDirectExecution(quote) && quote.quote.depositMemo) throw new ApiError(502, "The NEAR source route returned incompatible funding instructions", "SOURCE_ROUTE_INVALID");
  const attemptId = id();
  const plan = await buildWalletActions(access, config, payment, recipient, attemptId, quote, !!input.useBackup, tokens);
  transaction(() => {
    const latest = getPayment(access, paymentId);
    ensureRecipient(latest, access);
    if (latest.status === "paid" || latest.status === "cancelled") throw new ApiError(409, "Payment is no longer executable", "PAYMENT_CHANGED");
    if (row("SELECT id FROM payout_attempts WHERE payment_id=? AND state IN ('prepared','submitted','processing','unknown','recovery_pending','reported_delivered')", paymentId)) throw new ApiError(409, "Another payout attempt was prepared while quoting", "ATTEMPT_ACTIVE");
    if (latest.reserved_amount === "0") throw new ApiError(409, "This payment no longer has reserved funds", "PAYMENT_UNFUNDED");
    checkBudget(latest, terms.amountIn);
    getDb().prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,deposit_memo,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(attemptId, paymentId, access.organizationId, input.useBackup ? "backup" : "primary", "prepared", json(quote), destination.assetId, destination.blockchain, address, output, terms.amountIn, terms.sourceReceiver, isDirectExecution(quote) ? null : quote.quote.depositMemo ?? null, now(), now());
    getDb().prepare("UPDATE payout_attempts SET destination_decimals=?,destination_symbol=?,destination_memo=? WHERE id=?").run(destination.decimals, destination.symbol, input.useBackup ? null : recipient.primary_memo ?? null, attemptId);
    getDb().prepare("UPDATE payments SET status='prepared',hold_reason=NULL,updated_at=? WHERE id=?").run(now(), paymentId);
  });
  return { attempt: getAttempt(access, attemptId), ...plan, dry: false };
}

function action(config: TreasuryConfig, methodName: string, args: unknown, deposit = "0", gas = "100000000000000"): WalletTransaction {
  return { receiverId: config.near_account_id, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }] };
}

interface ApprovalPlan {
  network: string;
  stage: "prepare" | "approve" | "execute" | "scheduled" | "waiting";
  walletActions: WalletTransaction[];
  approvalActions: WalletTransaction[];
  approvalAccounts: string[];
  approvals: ApprovalStatus | null;
  message: string;
}

async function buildWalletActions(access: AccessContext, config: TreasuryConfig, payment: Payment, recipient: RecipientSnapshot, attemptId: string, quote: ExecutionRecord, backup: boolean, tokens: Token[], approvalOnly = false): Promise<ApprovalPlan> {
  validatePayoutDestination(backup ? recipient.backup_network! : recipient.primary_network, backup ? recipient.backup_address! : recipient.primary_address, backup ? null : recipient.primary_memo);
  const terms = executionTerms(quote);
  const expires = Date.parse(terms.deadline);
  if (expires <= Date.now()) throw new ApiError(409, "This route expired. Close the unused attempt and prepare a new route with fresh approvals", "QUOTE_EXPIRED");
  const scheduledTime = payment.scheduled_for ? Math.max(0, Date.parse(payment.scheduled_for)) : 0;
  if (scheduledTime > Date.now() && expires < scheduledTime + 60_000) throw new ApiError(409, "This route expires before the scheduled payment. Prepare a fresh route closer to the due time", "SCHEDULE_OUTLIVES_ROUTE");
  let primaryAsset = recipient.primary_asset;
  if (primaryAsset === "USDC") primaryAsset = nativeUsdc(tokens, recipient.primary_network).assetId;
  const primary = { asset_id: primaryAsset, network: recipient.primary_network, address: recipient.primary_address };
  const backupDestination = recipient.backup_address ? { asset_id: nativeUsdc(tokens, recipient.backup_network!).assetId, network: recipient.backup_network!, address: recipient.backup_address } : null;
  const [existing, currentRecipient, obligation, policy] = await Promise.all([
    view<ChainPayment | null>(config, "get_payment", { payment_id: payment.id }),
    view<{ primary: typeof primary; backup: typeof backupDestination; backup_consent: boolean; active: boolean; version: string } | null>(config, "get_recipient", { recipient_id: payment.recipient_id }),
    view<string | null>(config, "get_obligation", { reference: onchainReference(payment) }),
    view<{ owner_id: string; approvers: string[]; policy_version: string; paused: boolean }>(config, "get_config"),
  ]);
  if (policy.paused) throw new ApiError(409, "The NEAR treasury is paused", "ONCHAIN_PAUSED");
  if (obligation && obligation !== payment.id) throw new ApiError(409, "The onchain obligation reference is already in use", "ONCHAIN_OBLIGATION_CONFLICT");
  if (existing && (existing.amount !== payment.amount || existing.max_fee !== payment.max_fee || existing.reference !== onchainReference(payment) || existing.recipient_id !== payment.recipient_id || existing.not_before_ms !== String(scheduledTime))) throw new ApiError(409, "The onchain obligation has different approved terms or schedule", "ONCHAIN_TERMS_MISMATCH");
  const sameDestination = (left: typeof primary | null | undefined, right: typeof primary | null | undefined) => !left && !right || !!left && !!right && left.asset_id === right.asset_id && left.network === right.network && left.address === right.address;
  const recipientMatches = currentRecipient?.active && currentRecipient.backup_consent === !!recipient.fallback_consent && sameDestination(currentRecipient.primary, primary) && sameDestination(currentRecipient.backup, backupDestination);
  if (existing && (!recipientMatches || existing.recipient_version !== currentRecipient?.version)) throw new ApiError(409, "The onchain recipient changed after approval. Cancel and prepare a new obligation", "ONCHAIN_RECIPIENT_CHANGED");
  if (existing && !["proposed", "awaiting_approvals", "approved", "held", "retryable"].includes(existing.status)) throw new ApiError(409, "Reconcile the existing onchain delivery before resuming", "ONCHAIN_ATTEMPT_UNRESOLVED");
  const paymentExpiry = existing?.expires_at_ms ?? String(Math.max(Date.parse(payment.approved_at!) + 30 * 86_400_000, scheduledTime + 2 * 60 * 60_000));
  if (BigInt(paymentExpiry) < BigInt(expires)) throw new ApiError(409, "The obligation expires before this route. Cancel and review a new obligation", "APPROVAL_EXPIRED");
  const chainAttempt = existing?.attempts.find((attempt) => attempt.id === attemptId);
  if (existing?.attempts.some((attempt) => attempt.id !== attemptId && !["refunded", "transfer_failed", "discarded"].includes(attempt.status))) throw new ApiError(409, "An earlier onchain source may still deliver", "ONCHAIN_ATTEMPT_UNRESOLVED");
  const route = { kind: terms.kind, source_receiver: terms.sourceReceiver, input_amount: terms.amountIn, output_amount: terms.amountOut, quote_id: terms.quoteId, quote_hash: createHash("sha256").update(json(quote)).digest("hex"), deadline_ms: String(expires) };
  const selected = backup ? backupDestination : primary;
  if (!selected || !sameDestination(selected, { asset_id: isDirectExecution(quote) ? quote.assetId : quote.quoteRequest.destinationAsset, network: selected.network, address: isDirectExecution(quote) ? quote.recipient : quote.quoteRequest.recipient })) throw new ApiError(409, "The signed route has another receiving destination", "ONCHAIN_ROUTE_MISMATCH");
  if (chainAttempt && (chainAttempt.status !== "prepared" || chainAttempt.use_backup !== backup || Object.entries(route).some(([key, value]) => chainAttempt.route[key as keyof typeof route] !== value))) throw new ApiError(409, "This onchain attempt no longer matches the prepared route", "ONCHAIN_ATTEMPT_UNRESOLVED");
  if (isDirectExecution(quote) && (quote.assetId !== `nep141:${config.token_contract}` || terms.amountIn !== payment.amount || terms.amountOut !== payment.amount)) throw new ApiError(409, "Direct NEAR delivery must equal the approved native-USDC entitlement", "DIRECT_TERMS_INVALID");
  const linked = rows<{ address: string }>("SELECT address FROM linked_wallets WHERE user_id=? AND family='near' AND network=?", access.userId, config.network);
  const approvalAccounts = access.permissions.includes("payments:approve") ? linked.map((item) => item.address).filter((account) => account === policy.owner_id || policy.approvers.includes(account)) : [];
  const plan: ApprovalPlan = { network: config.network, stage: "waiting", walletActions: [], approvalActions: [], approvalAccounts, approvals: null, message: "An authorized NEAR approver must review the exact route." };
  if (existing && !chainAttempt && (existing.policy_version !== policy.policy_version || existing.status === "held")) {
    const status = await view<ApprovalStatus>(config, "get_approval_status", { payment_id: payment.id, attempt_id: attemptId });
    if (!status || status.policy_version !== policy.policy_version || !/^[a-f0-9]{64}$/.test(status.payment_terms_hash) || status.approval_amount !== (BigInt(payment.amount) + BigInt(payment.max_fee)).toString()) throw new ApiError(409, "The current obligation approval could not be verified", "APPROVAL_VIEW_INVALID");
    plan.stage = "approve"; plan.approvals = status; plan.message = "Renew this obligation under the current policy before preparing its new exact route.";
    if (approvalAccounts.length) plan.approvalActions = [action(config, "approve_payment", { payment_id: payment.id, expected_policy_version: status.policy_version, expected_terms_hash: status.payment_terms_hash }, "1")];
    return plan;
  }
  if (existing && chainAttempt) {
    plan.approvals = checkedApprovalStatus(await view<ApprovalStatus>(config, "get_approval_status", { payment_id: payment.id, attempt_id: attemptId }), payment.id, attemptId);
    if (plan.approvals.approval_amount !== (BigInt(payment.amount) + BigInt(payment.max_fee)).toString() || plan.approvals.policy_version !== policy.policy_version) throw new ApiError(409, "The approval policy changed while reading this route. Refresh before signing", "POLICY_CHANGED");
    if (approvalAccounts.some((account) => !plan.approvals!.payment_approvals.includes(account) || !plan.approvals!.attempt_approvals.includes(account))) plan.approvalActions = [
      action(config, "approve_payment", { payment_id: payment.id, expected_policy_version: plan.approvals.policy_version, expected_terms_hash: plan.approvals.payment_terms_hash }, "1"),
      action(config, "authorize_attempt", { payment_id: payment.id, attempt_id: attemptId, expected_policy_version: plan.approvals.policy_version, expected_terms_hash: plan.approvals.attempt_terms_hash }, "1"),
    ];
    if (plan.approvals.can_execute && !approvalOnly && access.permissions.includes("payments:execute")) {
      plan.stage = "execute"; plan.message = "The current policy quorum is met. Execute only this approved route.";
      if (isDirectExecution(quote)) {
        const token = { ...config, near_account_id: config.token_contract };
        if (!await view(token, "storage_balance_of", { account_id: terms.sourceReceiver })) {
          const bounds = await view<{ min: string }>(token, "storage_balance_bounds");
          plan.walletActions.push(action(token, "storage_deposit", { account_id: terms.sourceReceiver, registration_only: true }, atomic(bounds.min).toString(), "30000000000000"));
        }
      }
      plan.walletActions.push(action(config, "execute_payment", { payment_id: payment.id, attempt_id: attemptId }));
    } else if (plan.approvals.payment_ready && plan.approvals.attempt_ready && scheduledTime > Date.now()) {
      plan.stage = "scheduled"; plan.message = "The exact route has its quorum. The contract prevents source execution until the scheduled time; a configured restricted worker can execute it before expiry.";
    } else if (plan.approvals.payment_ready && plan.approvals.attempt_ready) {
      plan.stage = "waiting"; plan.message = plan.approvals.can_execute ? "The quorum is met. An authorized executor or configured restricted worker can execute this exact route before expiry." : "The quorum is met, but current treasury funds or spending limits block execution. Reconcile the treasury and refresh before sending.";
    } else {
      plan.stage = "approve"; plan.message = "Each distinct authorized wallet approves both the obligation and this exact route. Approval does not send the source payment.";
    }
    return plan;
  }
  if (approvalOnly) throw new ApiError(409, "A payer must prepare this exact route in the NEAR treasury before collecting approvals", "ROUTE_PREPARATION_REQUIRED");
  requirePermission(access, "payments:execute");
  plan.stage = "prepare"; plan.message = "Prepare and reserve this exact route on NEAR, then collect the required wallet approvals. This step does not execute the source payment.";
  if (backupDestination && await view<string | null>(config, "get_backup_asset", { network: backupDestination.network }) !== backupDestination.asset_id) {
    if (existing) throw new ApiError(409, "The owner must enable this exact native-USDC backup in treasury policy, then renew approvals", "BACKUP_POLICY_REQUIRED");
    plan.walletActions.push(action(config, "set_backup_asset", { network: backupDestination.network, asset_id: backupDestination.asset_id }, "1"));
  }
  if (!recipientMatches) plan.walletActions.push(action(config, "set_recipient", { recipient_id: payment.recipient_id, primary, backup: backupDestination, backup_consent: !!recipient.fallback_consent, active: true }, "1"));
  if (!existing) plan.walletActions.push(action(config, "propose_payment", { payment_id: payment.id, recipient_id: payment.recipient_id, amount: payment.amount, max_fee: payment.max_fee, expires_at_ms: paymentExpiry, not_before_ms: String(scheduledTime), reference: onchainReference(payment) }));
  if (existing && existing.policy_version !== policy.policy_version) throw new ApiError(409, "This obligation uses an earlier policy. Renew its obligation approval before preparing another route", "POLICY_CHANGED");
  if (existing?.status === "held") throw new ApiError(409, "This obligation needs renewed approval and enough confirmed funds before preparing another route", "PAYMENT_HELD");
  if (isDirectExecution(quote)) {
    const token = { ...config, near_account_id: config.token_contract };
    if (!await view(token, "storage_balance_of", { account_id: terms.sourceReceiver })) {
      const bounds = await view<{ min: string }>(token, "storage_balance_bounds");
      plan.walletActions.push(action(token, "storage_deposit", { account_id: terms.sourceReceiver, registration_only: true }, atomic(bounds.min).toString(), "30000000000000"));
    }
  }
  plan.walletActions.push(action(config, "create_attempt", { payment_id: payment.id, attempt_id: attemptId, use_backup: backup, route }));
  return plan;
}

export function getAttempt(access: AccessContext, attemptId: string): PayoutAttempt {
  requirePermission(access, "payments:read");
  const attempt = row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE id=? AND organization_id=?", attemptId, access.organizationId);
  if (!attempt) throw new ApiError(404, "Payment attempt not found", "ATTEMPT_NOT_FOUND");
  return attempt;
}

export function listAttempts(access: AccessContext, paymentId: string): PayoutAttempt[] {
  getPayment(access, paymentId);
  return rows<PayoutAttempt>("SELECT * FROM payout_attempts WHERE payment_id=? ORDER BY created_at", paymentId);
}

export async function resumeAttempt(access: AccessContext, attemptId: string) {
  if (!access.permissions.includes("payments:execute") && !access.permissions.includes("payments:approve")) requirePermission(access, "payments:approve");
  assertRunning(access);
  const attempt = getAttempt(access, attemptId);
  if (attempt.state !== "prepared") throw new ApiError(409, "Reconcile this attempt before resuming", "ATTEMPT_STATE_CHANGED");
  const payment = getPayment(access, attempt.payment_id);
  const recipient = ensureRecipient(payment, access);
  return { attempt, ...await buildWalletActions(access, configFor(access, true), payment, recipient, attemptId, JSON.parse(attempt.quote), attempt.route === "backup", await getSupportedTokens(), !access.permissions.includes("payments:execute")) };
}

export async function prepareAttemptApproval(access: AccessContext, attemptId: string) {
  requirePermission(access, "payments:approve");
  assertRunning(access);
  const attempt = getAttempt(access, attemptId);
  if (attempt.state !== "prepared") throw new ApiError(409, "This attempt is no longer awaiting approvals", "ATTEMPT_STATE_CHANGED");
  const payment = getPayment(access, attempt.payment_id);
  const plan = await buildWalletActions(access, configFor(access, true), payment, ensureRecipient(payment, access), attempt.id, JSON.parse(attempt.quote), attempt.route === "backup", await getSupportedTokens(), true);
  if (!plan.approvalAccounts.length) throw new ApiError(403, "Verify a NEAR wallet that is the treasury owner or an authorized approver on this network", "APPROVER_WALLET_REQUIRED");
  return { attempt, ...plan };
}

export async function markAttemptSubmitted(access: AccessContext, attemptId: string, txHash: string) {
  requirePermission(access, "payments:execute");
  const attempt = getAttempt(access, attemptId);
  if (attempt.source_tx_hash && attempt.source_tx_hash !== txHash) throw new ApiError(409, "This attempt already has another source transaction", "ATTEMPT_ALREADY_SUBMITTED");
  if (!["prepared", "submitted"].includes(attempt.state)) throw new ApiError(409, "This attempt is not awaiting submission", "ATTEMPT_STATE_CHANGED");
  const onchain = await view<ChainPayment | null>(configFor(access), "get_payment", { payment_id: attempt.payment_id });
  const chainAttempt = onchain?.attempts.find((item) => item.id === attemptId);
  if (!chainAttempt || !["sending", "source_sent", "uncertain", "refund_pending", "refund_verifying", "refunded", "delivered", "transfer_failed"].includes(chainAttempt.status) || chainAttempt.route.quote_hash !== createHash("sha256").update(attempt.quote).digest("hex")) throw new ApiError(409, "The treasury has not recorded this authorized attempt. Resume the wallet actions first", "SOURCE_ATTEMPT_UNVERIFIED");
  getDb().prepare("UPDATE payout_attempts SET state='submitted',source_tx_hash=?,updated_at=? WHERE id=?").run(txHash, now(), attemptId);
  getDb().prepare("UPDATE payments SET status='in_flight',updated_at=? WHERE id=?").run(now(), attempt.payment_id);
  if (!isDirectExecution(JSON.parse(attempt.quote))) {
    try { await notifyDeposit(attempt.deposit_address, txHash, attempt.deposit_memo); } catch {}
  }
  await reconcilePayment(access, attempt.payment_id);
  return getAttempt(access, attemptId);
}

export async function reconcilePayment(access: AccessContext, paymentId: string) {
  requirePermission(access, "payments:read");
  const payment = getPayment(access, paymentId);
  const attempt = row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE payment_id=? ORDER BY created_at DESC LIMIT 1", paymentId);
  if (!attempt || ["paid", "cancelled", "partially_paid"].includes(payment.status) || attempt.state === "closed_unfunded") return { payment, attempt: attempt ?? null };
  const config = configFor(access);
  if (await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "Review the current treasury code before recording delivery", "TREASURY_CODE_MISMATCH");
  const chain = await view<ChainPayment | null>(config, "get_payment", { payment_id: paymentId });
  const chainAttempt = chain?.attempts.find((item) => item.id === attempt.id);
  if (chain && (chain.amount !== payment.amount || chain.max_fee !== payment.max_fee || chain.reference !== onchainReference(payment) || chain.recipient_id !== payment.recipient_id)) throw new ApiError(409, "The onchain obligation terms do not match", "ONCHAIN_TERMS_MISMATCH");
  if (chainAttempt && (chainAttempt.route.quote_hash !== createHash("sha256").update(attempt.quote).digest("hex") || chainAttempt.route.input_amount !== attempt.amount_in || chainAttempt.route.output_amount !== attempt.expected_output || chainAttempt.route.source_receiver !== attempt.deposit_address)) throw new ApiError(409, "The onchain route does not match this signed quote", "ONCHAIN_ROUTE_MISMATCH");
  let provider: Awaited<ReturnType<typeof checkStatus>> | null = null;
  let providerError: string | null = null;
  try {
    if (!isDirectExecution(JSON.parse(attempt.quote))) {
    provider = await checkStatus(attempt.deposit_address, attempt.deposit_memo);
    assertSameQuote(JSON.parse(attempt.quote), provider.quoteResponse);
    }
  } catch (error) {
    provider = null;
    providerError = error instanceof ApiError ? error.message : "Routing evidence is temporarily unavailable";
  }
  const measured = deliveryOutput(attempt, provider), outputs = [measured.actual, outputAmount(attempt.observed_output), outputAmount(chainAttempt?.actual_output)].filter((value): value is string => value !== null);
  const observed = outputs.length ? outputs.reduce((left,right)=>BigInt(left)>BigInt(right)?left:right) : null;
  let confirmedPartial: PartialReview | null = null;
  let state = provider ? providerOutcome(provider.status) : "unknown";
  let nextStatus = state === "recovery_pending" ? "recovery_pending" : "in_flight";
  let hold: string | null = state === "reported_delivered" ? "Provider reports delivery. Confirm settlement in the NEAR treasury to close the obligation" : state === "recovery_pending" ? "Verify route closure and recovered funds before retrying" : state === "unknown" ? "Payment outcome requires reconciliation; no backup may execute yet" : null;
  if (!chainAttempt || chainAttempt.status === "prepared") {
    state = !provider || provider.status === "PENDING_DEPOSIT" ? "prepared" : "unknown";
    nextStatus = state === "prepared" ? "prepared" : "in_flight";
    hold = state === "unknown" ? "Routing activity needs review before any source transfer or backup" : providerError;
  }
  if (chainAttempt && ["sending", "source_sent", "uncertain", "refund_pending", "refund_verifying"].includes(chainAttempt.status)) {
    if (["uncertain", "refund_pending", "refund_verifying"].includes(chainAttempt.status)) {
      state = "recovery_pending";
      nextStatus = "recovery_pending";
      hold = "Reconcile the prior route and confirm recovered funds on NEAR before retrying";
    }
  }
  const direct = isDirectExecution(JSON.parse(attempt.quote));
  if (!direct && chainAttempt && (measured.partial || observed !== null && BigInt(observed) > 0n && BigInt(observed) < BigInt(attempt.expected_output))) { state = "reported_partial"; nextStatus = "held"; hold = "A positive short destination output was observed. No full retry or backup is allowed. Verify terminal closure and explicitly review the credited USDC entitlement."; }
  if (!direct && provider?.status === "SUCCESS" && !measured.complete && !measured.partial) { state = "unknown"; nextStatus = "held"; hold = "Provider success has missing, invalid or zero destination output. Delivery remains unverified."; }
  if (chainAttempt?.status === "delivered" && chain?.status === "paid") {
    if (completeDelivery(payment, attempt, chainAttempt, provider, direct)) { state = "delivered"; nextStatus = "paid"; hold = null; }
    else { state = measured.partial ? "reported_partial" : "unknown"; nextStatus = "held"; hold = "The recorded full-delivery claim lacks matching complete output evidence. Reconcile the actual destination amount before any further payment."; }
  }
  if (chainAttempt?.status === "partially_delivered" && chain) { confirmedPartial = partialProof(payment, { ...attempt, observed_output: observed }, chain, chainAttempt); state = "partially_delivered"; nextStatus = "partially_paid"; hold = "Terminal partial delivery recorded. Prepare a separately reviewed and approved remainder; the original cannot retry."; }
  if (chainAttempt?.status === "refunded") { state = "refunded_verified"; nextStatus = chain?.status === "retryable" ? "approved" : "held"; hold = nextStatus === "held" ? "Recovered funds or the approved fee budget do not cover a retry" : null; }
  if (chainAttempt && ["discarded", "transfer_failed"].includes(chainAttempt.status)) { state = "closed_unfunded"; nextStatus = chain?.status === "held" ? "held" : "approved"; hold = null; }
  if (!direct && observed !== null && BigInt(observed) > 0n && ["refunded", "transfer_failed", "discarded"].includes(chainAttempt?.status ?? "")) { state = "reported_partial"; nextStatus = "held"; hold = "Destination delivery was observed despite a route recovery claim. A full retry or backup is blocked until authoritative partial closure."; }
  transaction(() => {
    const latest = getPayment(access, paymentId);
    if (["paid", "partially_paid"].includes(latest.status)) return;
    const current = balance(access.organizationId);
    const reservation = chainAttempt ? atomic(chain!.reservation, true).toString() : latest.reserved_amount;
    const nextReserved = BigInt(current.reserved) - BigInt(latest.reserved_amount) + BigInt(reservation);
    if (nextReserved < 0n) throw new ApiError(409, "Treasury reservations require reconciliation", "RESERVATION_MISMATCH");
    if (reservation !== latest.reserved_amount) ledger(access.organizationId, `reservation-sync:${attempt.id}:${id()}`, "reservation_reconciled", (BigInt(reservation) - BigInt(latest.reserved_amount)).toString(), current.balance, nextReserved.toString(), { paymentId, attemptId: attempt.id, chainStatus: chain?.status });
    if (state === "delivered") ledger(access.organizationId, `paid:${paymentId}`, "payment_delivered", latest.amount, current.balance, nextReserved.toString(), { paymentId, attemptId: attempt.id, destinationReceipt: chainAttempt?.receipt });
    const spent = chain ? spentSource(chain, attempt, chainAttempt) : latest.total_spent;
    const credited = confirmedPartial?.credited_usdc ?? (state === "delivered" ? latest.amount : latest.delivered_amount);
    if (confirmedPartial) ledger(access.organizationId, `partial-paid:${paymentId}`, "payment_partially_delivered", credited, current.balance, nextReserved.toString(), { paymentId, attemptId: attempt.id, actualOutput: confirmedPartial.actual_output, receipt: confirmedPartial.receipt_commitment });
    getDb().prepare("UPDATE payments SET status=?,reserved_amount=?,chain_reserved=?,total_spent=?,delivered_amount=?,hold_reason=?,updated_at=? WHERE id=?").run(nextStatus, reservation, chain?.reservation ?? "0", spent, credited, hold, now(), paymentId);
    if (confirmedPartial && chain) recordPartial(access, latest, attempt, chain, confirmedPartial, spent);
    getDb().prepare("UPDATE payout_attempts SET state=?,provider_status=?,reconciliation=?,destination_tx_hash=?,observed_output=?,updated_at=? WHERE id=?").run(state, provider?.status ?? attempt.provider_status, json({ provider, chain, providerError }), provider?.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? attempt.destination_tx_hash, observed, now(), attempt.id);
  });
  await syncTreasury(access);
  return { payment: getPayment(access, paymentId), attempt: getAttempt(access, attempt.id), providerError };
}

export async function closeUnfundedAttempt(access: AccessContext, attemptId: string) {
  requirePermission(access, "payments:execute");
  const attempt = getAttempt(access, attemptId);
  if (attempt.observed_output && BigInt(attempt.observed_output) > 0n) throw new ApiError(409, "A destination delivery was observed. Close the partial route and prepare only its unpaid remainder", "PARTIAL_DELIVERY_OBSERVED");
  if (["closed_unfunded", "refunded_verified"].includes(attempt.state)) return { attempt, walletActions: [] };
  const config = configFor(access);
  const chain = await view<ChainPayment | null>(config, "get_payment", { payment_id: attempt.payment_id });
  const chainAttempt = chain?.attempts.find((item) => item.id === attemptId);
  if (chainAttempt && ["discarded", "transfer_failed", "refunded"].includes(chainAttempt.status)) return { ...await reconcilePayment(access, attempt.payment_id), walletActions: [] };
  if (chainAttempt?.status === "prepared") return { attempt, walletActions: [action(config, "discard_attempt", { payment_id: attempt.payment_id, attempt_id: attemptId })] };
  const quote = JSON.parse(attempt.quote) as ExecutionRecord;
  const originalDeadline = isDirectExecution(quote) ? quote.deadline : quote.quote.deadline ?? quote.quoteRequest.deadline;
  if (!chainAttempt && attempt.state === "prepared" && Date.parse(originalDeadline) <= Date.now()) {
    transaction(() => {
      getDb().prepare("UPDATE payout_attempts SET state='closed_unfunded',updated_at=? WHERE id=? AND state='prepared'").run(now(), attemptId);
      getDb().prepare("UPDATE payments SET status='approved',hold_reason=NULL,updated_at=? WHERE id=? AND status='prepared'").run(now(), attempt.payment_id);
    });
    return { attempt: getAttempt(access, attemptId), walletActions: [] };
  }
  throw new ApiError(409, "The earlier route may still deliver. Reconcile it before closing", "PRIOR_ATTEMPT_UNRESOLVED");
}

export async function prepareSettlement(access: AccessContext, attemptId: string, input: { outcome: "delivered" | "uncertain" | "refund_pending"; receipt: string }) {
  requirePermission(access, "payments:approve");
  const attempt = getAttempt(access, attemptId);
  const config = configFor(access);
  const reconciled = await reconcilePayment(access, attempt.payment_id);
  if (reconciled.payment.status === "paid") return { ...reconciled, walletActions: [] };
  if (reconciled.payment.status === "partially_paid") throw new ApiError(409, "This terminal partial payment cannot be reported or retried in full", "PARTIAL_LIABILITY");
  const provider = JSON.parse(reconciled.attempt?.reconciliation || "{}").provider as Awaited<ReturnType<typeof checkStatus>> | null;
  const measured = deliveryOutput(attempt, provider);
  if (input.outcome === "delivered" && (provider?.status !== "SUCCESS" || !measured.complete || !reconciled.attempt?.destination_tx_hash)) throw new ApiError(409, "Full delivery needs a matching destination transaction and exact output at least equal to the signed quote. Missing or short output requires reconciliation", "DELIVERY_UNVERIFIED");
  if (input.outcome === "refund_pending" && (measured.positive || reconciled.attempt?.observed_output && BigInt(reconciled.attempt.observed_output) > 0n)) throw new ApiError(409, "Destination delivery was observed. Use explicit terminal partial settlement instead of a full retry", "PARTIAL_DELIVERY_OBSERVED");
  const receipt = retainPrivateEvidence(access, attemptId, `settlement:${input.outcome}`, input.receipt);
  return { ...reconciled, requiresReporterAttestation: true, evidenceCommitment: receipt, walletActions: [action(config, "report_settlement", { payment_id: attempt.payment_id, attempt_id: attemptId, outcome: input.outcome, receipt, actual_output: measured.actual })] };
}

export async function prepareRefundConfirmation(access: AccessContext, attemptId: string, input: { refundAmount: string; receipt: string }) {
  requirePermission(access, "payments:approve");
  const attempt = getAttempt(access, attemptId);
  const config = configFor(access);
  if (attempt.observed_output && BigInt(attempt.observed_output) > 0n) throw new ApiError(409, "A partially delivered route cannot become a full-refund retry", "PARTIAL_DELIVERY_OBSERVED");
  if (atomic(input.refundAmount, true) > atomic(attempt.amount_in)) throw new ApiError(422, "The refund exceeds the original source amount", "REFUND_EXCEEDS_INPUT");
  const chain = await view<ChainPayment | null>(config, "get_payment", { payment_id: attempt.payment_id });
  const chainAttempt = chain?.attempts.find((item) => item.id === attemptId);
  if (chainAttempt?.status !== "refund_pending") throw new ApiError(409, "Report route closure and the pending refund on NEAR first", "REFUND_NOT_REPORTED");
  const receipt = retainPrivateEvidence(access, attemptId, "refund", input.receipt);
  return { attempt, requiresReporterAttestation: true, evidenceCommitment: receipt, walletActions: [action(config, "confirm_refund", { payment_id: attempt.payment_id, attempt_id: attemptId, refund_amount: atomic(input.refundAmount, true).toString(), receipt })] };
}

export async function prepareFunding(access: AccessContext, input: { originAsset: string; amount: string; refundAddress: string; reference: string; paymentId?: string; exactOutput?: boolean; dry?: boolean }) {
  requirePermission(access, "payments:prepare");
  assertRunning(access);
  if (input.paymentId) throw new ApiError(409, "Open this approved obligation's pay-from-wallet task to quote its remaining need", "PAYMENT_FUNDING_TASK_REQUIRED");
  const config = configFor(access, true);
  if (!input.reference.trim() || input.reference.length > 200) throw new ApiError(422, "A stable funding reference is required", "INVALID_REFERENCE");
  const existing = row<FundingLeg>("SELECT * FROM funding_legs WHERE organization_id=? AND reference=?", access.organizationId, input.reference);
  if (existing) {
    const request = (JSON.parse(existing.quote) as QuoteResponse).quoteRequest;
    if (existing.origin_asset !== input.originAsset || existing.payment_id !== (input.paymentId ?? null) || request.amount !== input.amount || request.refundTo !== input.refundAddress || request.swapType !== (input.exactOutput ? "EXACT_OUTPUT" : "EXACT_INPUT")) throw new ApiError(409, "Funding reference already has different terms", "IDEMPOTENCY_CONFLICT");
    if (["refunded_verified", "refunded_attested", "closed_unsent", "cancelled"].includes(existing.status)) throw new ApiError(409, "This funding reference is closed. Its history cannot be reused for another deposit", "FUNDING_CLOSED");
    if (existing.source_tx_hash || existing.status === "confirmed" || existing.provider_status && existing.provider_status !== "PENDING_DEPOSIT") throw new ApiError(409, "This funding leg has already started. Reconcile it before preparing another deposit", "FUNDING_ALREADY_STARTED");
    assertCanStartDeposit(JSON.parse(existing.quote));
    return existing;
  }
  const tokens = await getSupportedTokens();
  const sourceToken = tokens.find((token) => token.assetId === input.originAsset);
  if (!sourceToken) throw new ApiError(422, "The funding asset is not currently supported", "ASSET_UNSUPPORTED");
  const destination = nativeUsdc(tokens, "near");
  const quote = await requestQuote({ dry: !!input.dry, swapType: input.exactOutput ? "EXACT_OUTPUT" : "EXACT_INPUT", slippageTolerance: 50, originAsset: input.originAsset, depositType: "ORIGIN_CHAIN", destinationAsset: destination.assetId, amount: atomic(input.amount).toString(), recipient: config.near_account_id, recipientType: "DESTINATION_CHAIN", refundTo: input.refundAddress, refundType: "ORIGIN_CHAIN", deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString(), customRecipientMsg: "razor:funding" });
  if (input.dry) return { dry: true, quote };
  const fundingId = id();
  getDb().prepare("INSERT INTO funding_legs(id,organization_id,payment_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,deposit_memo,recipient_address,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(fundingId, access.organizationId, input.paymentId ?? null, input.reference, input.originAsset, quote.quote.amountIn, quote.quote.amountOut, json(quote), quote.quote.depositAddress!, quote.quote.depositMemo ?? null, config.near_account_id, "pending_deposit", now(), now());
  getDb().prepare("UPDATE funding_legs SET origin_network=?,origin_decimals=?,origin_symbol=? WHERE id=?").run(sourceToken.blockchain, sourceToken.decimals, sourceToken.symbol, fundingId);
  return row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", fundingId)!;
}

export function listFunding(access: AccessContext): FundingLeg[] {
  requirePermission(access, "company:read");
  return rows<FundingLeg>("SELECT f.*,CASE WHEN f.payment_id IS NOT NULL THEN 'obligation' WHEN EXISTS(SELECT 1 FROM funding_request_quotes q WHERE q.funding_id=f.id) THEN 'funding_request' ELSE 'company' END AS source_context FROM funding_legs f WHERE f.organization_id=? ORDER BY f.created_at DESC LIMIT 250", access.organizationId);
}

export async function reconcileFunding(access: AccessContext, fundingId: string, sourceTxHash?: string) {
  requirePermission(access, "payments:prepare");
  const funding = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", fundingId, access.organizationId);
  if (!funding) throw new ApiError(404, "Funding request not found", "FUNDING_NOT_FOUND");
  if (["confirmed", "refunded_verified", "refunded_attested"].includes(funding.status)) return { funding, treasury: await syncTreasury(access) };
  if (sourceTxHash) {
    if (funding.source_tx_hash && funding.source_tx_hash !== sourceTxHash) throw new ApiError(409, "This funding leg already has another source transaction", "FUNDING_SOURCE_CONFLICT");
    getDb().prepare("UPDATE funding_legs SET source_tx_hash=?,updated_at=? WHERE id=?").run(sourceTxHash, now(), fundingId);
    try {
      const sourceToken = (await getSupportedTokens()).find((token) => token.assetId === funding.origin_asset);
      const sender = sourceToken?.blockchain === "near" ? (JSON.parse(funding.quote) as QuoteResponse).quoteRequest.refundTo : undefined;
      await notifyDeposit(funding.deposit_address, sourceTxHash, funding.deposit_memo, sender);
    } catch {}
  }
  const status = await checkStatus(funding.deposit_address, funding.deposit_memo);
  assertSameQuote(JSON.parse(funding.quote), status.quoteResponse);
  const onchain = await syncTreasury(access);
  const deliveredHash = status.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null;
  getDb().prepare("UPDATE funding_legs SET status=?,provider_status=?,destination_tx_hash=?,updated_at=? WHERE id=? AND status NOT IN ('confirmed','refunded_verified','refunded_attested')").run(fundingStateAfterProvider(funding, status.status), status.status, deliveredHash, now(), fundingId);
  return { funding: row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", fundingId), treasury: onchain };
}

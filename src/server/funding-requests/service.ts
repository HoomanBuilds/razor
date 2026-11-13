import { pageWindow } from "../pagination";
import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt, hashToken, newToken } from "../identity/crypto";
import { atomic } from "../../lib/money";
import { assertSameQuote, assertCanStartDeposit, quoteDepositWindow, checkStatus, getSupportedTokens, nativeUsdc, notifyDeposit, requestQuote, type QuoteResponse, type Token } from "../payments/intents";
import { NATIVE_USDC } from "../payments/policy";
import { contractCodeHash, view } from "../payments/near";
import { reviewedArtifactHash } from "../near-artifacts";
import { requireUnstartedDeposit, recordDepositClaim } from "./deposit";
import { fundingStateAfterProvider } from "../payment-funding/lifecycle";
import { normalizeDestination } from "../../lib/recipient-destination";
import type { FundingLeg, TreasuryConfig } from "../payments/types";
import type { FundingRequestRecord, PublicFundingLeg, PublicFundingRequest, PublicQuoteResult, RequestQuote } from "./types";

const now = () => new Date().toISOString();
function manage(access: AccessContext) { requirePermission(access, "company:manage"); requirePermission(access, "payments:prepare"); }
function requestForCompany(access: AccessContext, requestId: string): FundingRequestRecord {
  const request = row<FundingRequestRecord>("SELECT * FROM funding_requests WHERE id=? AND organization_id=?", requestId, access.organizationId);
  if (!request) throw new ApiError(404, "Funding request not found", "FUNDING_REQUEST_NOT_FOUND");
  return request;
}
function requestForToken(token: string): FundingRequestRecord {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(404, "This funding link is not available", "FUNDING_LINK_INVALID");
  const request = row<FundingRequestRecord>("SELECT * FROM funding_requests WHERE token_hash=?", hashToken(token));
  if (!request) throw new ApiError(404, "This funding link is not available", "FUNDING_LINK_INVALID");
  return request;
}
function legForQuote(quote: RequestQuote): FundingLeg {
  const leg = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", quote.funding_id);
  if (!leg) throw new ApiError(409, "Funding instructions are not ready yet", "FUNDING_QUOTE_PENDING");
  return leg;
}
function activeQuote(requestId: string) {
  return rows<RequestQuote>("SELECT * FROM funding_request_quotes WHERE request_id=? AND state IN ('quoting','active','closed') ORDER BY CASE WHEN state='closed' THEN 0 ELSE 1 END,created_at", requestId).find(quote => {
    if (quote.state !== "closed") return true;
    if (!quote.funding_id) return false;
    const leg = legForQuote(quote);
    if (leg.status === "confirmed") return verifiedAmount(row<FundingRequestRecord>("SELECT * FROM funding_requests WHERE id=?", requestId)!, leg.id) === 0n;
    return !["refunded_verified", "refunded_attested", "closed_unsent", "cancelled"].includes(leg.status) || ["closed_unsent", "cancelled"].includes(leg.status) && !!leg.source_tx_hash;
  });
}
function hasReceiptTable() { return !!row("SELECT name FROM sqlite_master WHERE type='table' AND name='funding_credit_receipts'"); }

function verifiedAmount(request: FundingRequestRecord, fundingId?: string): bigint {
  if (!hasReceiptTable()) return 0n;
  const entries = rows<{ funding_id: string; amount: string; credited_amount: string }>(`SELECT r.funding_id,r.amount,f.credited_amount FROM funding_credit_receipts r
    JOIN funding_legs f ON f.id=r.funding_id JOIN funding_request_quotes q ON q.funding_id=f.id
    WHERE q.request_id=? AND f.organization_id=? AND r.organization_id=? AND f.status='confirmed'
    AND f.recipient_address=? AND r.network=? AND r.token_contract=? AND (? IS NULL OR f.id=?)`, request.id, request.organization_id, request.organization_id, request.treasury_account_id, request.network, request.token_contract, fundingId ?? null, fundingId ?? null);
  const amounts = new Map<string, { proved: bigint; credited: bigint }>();
  for (const entry of entries) {
    const total = amounts.get(entry.funding_id) ?? { proved: 0n, credited: atomic(entry.credited_amount, true) };
    total.proved += atomic(entry.amount); amounts.set(entry.funding_id, total);
  }
  return [...amounts.values()].reduce((sum, value) => sum + (value.proved === value.credited ? value.proved : 0n), 0n);
}

function progress(request: FundingRequestRecord) {
  return transaction(() => {
    const confirmed = verifiedAmount(request);
    getDb().prepare("UPDATE funding_request_quotes SET state='failed',reservation_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE request_id=? AND state='quoting' AND funding_id IS NULL AND lease_expires_at<=?").run(now(), request.id, now());
    for (const quote of rows<RequestQuote>("SELECT * FROM funding_request_quotes WHERE request_id=? AND state='active'", request.id)) {
      if (quote.funding_id && (verifiedAmount(request, quote.funding_id) > 0n || ["refunded_verified", "refunded_attested"].includes(legForQuote(quote).status))) getDb().prepare("UPDATE funding_request_quotes SET state='closed',updated_at=? WHERE id=?").run(now(), quote.id);
    }
    if (confirmed >= atomic(request.amount)) getDb().prepare("UPDATE funding_requests SET status='fulfilled',fulfilled_at=COALESCE(fulfilled_at,?),updated_at=? WHERE id=?").run(now(), now(), request.id);
    return { confirmed, remaining: confirmed >= atomic(request.amount) ? 0n : atomic(request.amount) - confirmed };
  });
}
function state(request: FundingRequestRecord, confirmed: bigint) {
  if (confirmed >= atomic(request.amount)) return "fulfilled";
  if (request.revoked_at) return "revoked";
  if (Date.parse(request.expires_at) <= Date.now()) return "expired";
  if (linkedPaymentClosed(request)) return "payment_closed";
  if (row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", request.organization_id)?.paused) return "paused";
  const active = activeQuote(request.id);
  const leg = active?.funding_id ? legForQuote(active) : null;
  if (leg && ["reported_delivered", "confirmed"].includes(leg.status)) return "awaiting_confirmation";
  return active ? "funding_in_progress" : "open";
}
function publicLegStatus(request: FundingRequestRecord, leg: FundingLeg) {
  return leg.status === "confirmed" && verifiedAmount(request, leg.id) === 0n ? "awaiting_confirmation" : leg.status;
}
function publicView(request: FundingRequestRecord): PublicFundingRequest {
  const { confirmed, remaining } = progress(request), active = activeQuote(request.id);
  const company = row<{ name: string }>("SELECT name FROM organizations WHERE id=?", request.organization_id);
  return { id: request.id, companyName: company?.name ?? "Company", amount: request.amount, purpose: decrypt(request.purpose_ciphertext), expiresAt: request.expires_at,
    confirmedAmount: confirmed.toString(), remainingAmount: remaining.toString(), status: state(request, confirmed), activeFunding: active ? { id: active.funding_id, status: active.funding_id ? publicLegStatus(request, legForQuote(active)) : "quoting" } : null };
}
function assertOpen(request: FundingRequestRecord) {
  const current = publicView(request);
  if (["fulfilled", "revoked", "expired", "paused", "payment_closed"].includes(current.status) || request.fulfilled_at) throw new ApiError(409, `This funding request is ${current.status}`, "FUNDING_REQUEST_CLOSED");
  return current;
}

function linkedPaymentClosed(request: FundingRequestRecord) {
  if (!request.payment_id) return false;
  const payment = row<{ status: string }>("SELECT status FROM payments WHERE id=? AND organization_id=?", request.payment_id, request.organization_id);
  return !payment || ["paid", "cancelled", "partially_paid"].includes(payment.status);
}

async function verifyTarget(config: TreasuryConfig, expectedOwner?: string) {
  if (config.network !== "mainnet" || config.token_contract !== NATIVE_USDC.near) throw new ApiError(409, "Configure a verified native-USDC NEAR mainnet treasury first", "TREASURY_SETUP_REQUIRED");
  const [contract, codeHash] = await Promise.all([view<{ owner_id: string; token_contract: string; paused: boolean }>(config, "get_config"), contractCodeHash(config)]);
  if (codeHash !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "The treasury code changed. Ask the company to review its deployment before sending funds", "TREASURY_CODE_MISMATCH");
  if (contract.paused) throw new ApiError(409, "The company treasury is paused. Track existing transfers before adding funds", "TREASURY_PAUSED");
  if (contract.token_contract !== config.token_contract || expectedOwner && contract.owner_id !== expectedOwner) throw new ApiError(409, "The company treasury ownership or settlement token changed", "FUNDING_TARGET_CHANGED");
  if (!row(`SELECT w.id FROM linked_wallets w JOIN memberships m ON m.user_id=w.user_id
    WHERE m.organization_id=? AND m.status='active' AND w.family='near' AND w.address=? AND w.network=?`, config.organization_id, contract.owner_id, config.network)) throw new ApiError(409, "Verify the current treasury owner wallet for this company first", "TREASURY_OWNER_UNVERIFIED");
  const registration = await view<{ total: string } | null>({ near_account_id: config.token_contract, network: config.network }, "storage_balance_of", { account_id: config.near_account_id });
  if (!registration || atomic(registration.total, true) === 0n) throw new ApiError(409, "Register the company treasury for native USDC before requesting funds", "TREASURY_STORAGE_REQUIRED");
  return contract;
}
export async function verifyCompanyFundingTarget(access: AccessContext) {
  requirePermission(access, "payments:prepare");
  if (row<{paused:number}>("SELECT paused FROM organizations WHERE id=?", access.organizationId)?.paused) throw new ApiError(409, "Company payments are paused. Existing transfers remain available for tracking", "PAYMENTS_PAUSED");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) throw new ApiError(409, "Connect the company NEAR treasury before funding", "TREASURY_SETUP_REQUIRED");
  await verifyTarget(config);
  return config;
}

export async function claimCompanyFunding(access: AccessContext, fundingId: string) {
  const config = await verifyCompanyFundingTarget(access);
  const funding = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", fundingId, access.organizationId);
  if (!funding) throw new ApiError(404, "Source funding leg not found", "FUNDING_NOT_FOUND");
  if (funding.payment_id || row("SELECT id FROM funding_request_quotes WHERE funding_id=?", fundingId)) throw new ApiError(409, "Resume this source transfer through its obligation task or original funding link", "FUNDING_SOURCE_CONTEXT_REQUIRED");
  const quote = JSON.parse(funding.quote) as QuoteResponse;
  if (funding.recipient_address !== config.near_account_id || quote.quoteRequest.recipient !== config.near_account_id || quote.quoteRequest.destinationAsset !== `nep141:${config.token_contract}`) throw new ApiError(409, "The original funding destination differs from this company treasury", "FUNDING_TARGET_CHANGED");
  const status = await checkStatus(funding.deposit_address, funding.deposit_memo);
  requireUnstartedDeposit(funding, status);
  return transaction(() => {
    const current = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
    if (row<{paused:number}>("SELECT paused FROM organizations WHERE id=?", access.organizationId)?.paused || !current || current.near_account_id !== config.near_account_id || current.token_contract !== config.token_contract || current.network !== config.network) throw new ApiError(409, "Company funding settings changed while opening your wallet. Review the saved transfer", "FUNDING_TARGET_CHANGED");
    return recordDepositClaim(funding);
  });
}

async function frozenTarget(request: FundingRequestRecord) {
  if (linkedPaymentClosed(request)) throw new ApiError(409, "This linked obligation is closed. Continue tracking existing deposits without sending another", "FUNDING_REQUEST_CLOSED");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", request.organization_id);
  if (!config || config.near_account_id !== request.treasury_account_id || config.network !== request.network || config.token_contract !== request.token_contract) throw new ApiError(409, "The verified funding destination changed", "FUNDING_TARGET_CHANGED");
  await verifyTarget(config, request.treasury_owner_id);
  return config;
}

export async function createFundingRequest(access: AccessContext, input: { amount: string; purpose: string; expiresAt: string; paymentId?: string }) {
  manage(access);
  let amount: string;
  try { amount = atomic(input.amount).toString(); } catch { throw new ApiError(422, "Enter a positive USDC amount", "INVALID_AMOUNT"); }
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new ApiError(422, "Choose a future funding request expiry", "FUNDING_EXPIRY_INVALID");
  if (!input.purpose.trim() || input.purpose.length > 500) throw new ApiError(422, "Describe the funding purpose in 1 to 500 characters", "FUNDING_PURPOSE_INVALID");
  if (input.paymentId && !row("SELECT id FROM payments WHERE id=? AND organization_id=? AND status NOT IN ('paid','cancelled','partially_paid')", input.paymentId, access.organizationId)) throw new ApiError(404, "Choose an unpaid payment in this company", "PAYMENT_NOT_FOUND");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) throw new ApiError(409, "Connect the company treasury first", "TREASURY_SETUP_REQUIRED");
  const owner = await verifyTarget(config), token = newToken(), id = randomUUID(), createdAt = now();
  getDb().prepare("INSERT INTO funding_requests(id,organization_id,amount,purpose_ciphertext,expires_at,token_hash,capability_id,payment_id,treasury_account_id,treasury_owner_id,token_contract,network,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, access.organizationId, amount, encrypt(input.purpose.trim()), expiry.toISOString(), hashToken(token), randomUUID(), input.paymentId ?? null, config.near_account_id, owner.owner_id, config.token_contract, config.network, access.userId, createdAt, createdAt);
  return { request: companyView(requestForCompany(access, id)), link: { token, path: `/fund?token=${encodeURIComponent(token)}` } };
}
function companyView(request: FundingRequestRecord) {
  const summary = publicView(request);
  const funding = rows<FundingLeg>("SELECT f.* FROM funding_legs f JOIN funding_request_quotes q ON q.funding_id=f.id WHERE q.request_id=? AND f.organization_id=? ORDER BY f.created_at DESC", request.id, request.organization_id);
  return { ...summary, paymentId: request.payment_id, createdAt: request.created_at, revokedAt: request.revoked_at, fulfilledAt: row<{ fulfilled_at: string | null }>("SELECT fulfilled_at FROM funding_requests WHERE id=?", request.id)!.fulfilled_at, treasuryAccountId: request.treasury_account_id, funding };
}
export function listFundingRequests(access: AccessContext) {
  return fundingRequestPage(access, 1, 100).requests;
}
export function fundingRequestPage(access: AccessContext, page = 1, pageSize = 25) {
  requirePermission(access, "payments:read");
  const { offset } = pageWindow(page, pageSize);
  const total = row<{total:number}>("SELECT COUNT(*) AS total FROM funding_requests WHERE organization_id=?", access.organizationId)!.total;
  const requests = rows<FundingRequestRecord>("SELECT * FROM funding_requests WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", access.organizationId, pageSize, offset).map(companyView);
  return { requests, page, pageSize, total, hasMore: offset + requests.length < total };
}
export function getFundingRequest(access: AccessContext, requestId: string) { requirePermission(access, "payments:read"); return companyView(requestForCompany(access, requestId)); }
export function revokeFundingRequest(access: AccessContext, requestId: string) {
  manage(access); const request = requestForCompany(access, requestId);
  getDb().prepare("UPDATE funding_requests SET revoked_at=COALESCE(revoked_at,?),status=CASE WHEN status='fulfilled' THEN status ELSE 'revoked' END,updated_at=? WHERE id=?").run(now(), now(), request.id);
  return companyView(requestForCompany(access, request.id));
}
export function rotateFundingLink(access: AccessContext, requestId: string) {
  manage(access);
  return transaction(() => {
    const request = requestForCompany(access, requestId); assertOpen(request);
    if (activeQuote(request.id)) throw new ApiError(409, "Resolve the current funding leg before replacing its link", "FUNDING_LEG_ACTIVE");
    const token = newToken();
    getDb().prepare("UPDATE funding_requests SET token_hash=?,capability_id=?,updated_at=? WHERE id=?").run(hashToken(token), randomUUID(), now(), request.id);
    return { request: companyView(requestForCompany(access, request.id)), link: { token, path: `/fund?token=${encodeURIComponent(token)}` } };
  });
}
export function getPublicFundingRequest(token: string) { return publicView(requestForToken(token)); }
export async function getPublicAssets(token: string) { assertOpen(requestForToken(token)); return getSupportedTokens(); }

function validateKey(key: string) { if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ApiError(422, "Use a stable funding quote identifier", "FUNDING_KEY_INVALID"); }
function quoteResult(request: FundingRequestRecord, quote: RequestQuote): PublicQuoteResult {
  if (!quote.origin_token_json) throw new ApiError(409, "Funding instructions are not ready yet", "FUNDING_QUOTE_PENDING");
  const leg = legForQuote(quote);
  const funding: PublicFundingLeg = { id: leg.id, origin_asset: leg.origin_asset, amount_in: leg.amount_in, expected_output: leg.expected_output, deposit_address: leg.deposit_address, deposit_memo: leg.deposit_memo, quote: leg.quote, status: publicLegStatus(request, leg), source_tx_hash: leg.source_tx_hash };
  const current = publicView(request), depositAllowed = ["open", "funding_in_progress", "awaiting_confirmation"].includes(current.status) && current.activeFunding?.id === funding.id && funding.status === "pending_deposit" && !funding.source_tx_hash;
  return { funding, token: JSON.parse(quote.origin_token_json) as Token, request: current, depositAllowed, ...(!depositAllowed ? { depositBlockedReason: "This leg already started or its request or linked obligation is closed. Continue tracking existing funds without a new deposit." } : {}) };
}
export async function resumePublicQuote(token: string, idempotencyKey: string): Promise<PublicQuoteResult> {
  const request = requestForToken(token); validateKey(idempotencyKey);
  const quote = row<RequestQuote>("SELECT * FROM funding_request_quotes WHERE request_id=? AND key_hash=? AND funding_id IS NOT NULL", request.id, hashToken(idempotencyKey));
  if (!quote) throw new ApiError(404, "This browser has no saved funding quote", "FUNDING_QUOTE_NOT_FOUND");
  const result = quoteResult(request, quote);
  const requestOpen = !["expired", "revoked", "fulfilled", "paused", "payment_closed"].includes(result.request.status);
  const depositAllowed = requestOpen && result.request.activeFunding?.id === result.funding.id && result.funding.status === "pending_deposit" && !result.funding.source_tx_hash;
  if (!result.funding.source_tx_hash && requestOpen) {
    try { await frozenTarget(request); }
    catch (error) { return { ...result, depositAllowed: false, depositBlockedReason: error instanceof ApiError ? error.message : "The company treasury could not be reverified. Check the existing leg before sending funds." }; }
  }
  if (depositAllowed) { try { assertCanStartDeposit(JSON.parse(result.funding.quote)); } catch (error) { return { ...result, depositAllowed: false, depositBlockedReason: error instanceof Error ? error.message : "The source quote no longer accepts deposits" }; } }
  return { ...result, depositAllowed, ...(!depositAllowed ? { depositBlockedReason: "This leg is tracking an existing transfer or the request is closed. Do not send another deposit." } : {}) };
}

export async function preparePublicQuote(token: string, input: { originAsset: string; refundAddress: string; idempotencyKey: string }): Promise<PublicQuoteResult> {
  const request = requestForToken(token); validateKey(input.idempotencyKey); const initial = assertOpen(request);
  if (!input.refundAddress || input.refundAddress.length > 256 || /\s/.test(input.refundAddress)) throw new ApiError(422, "Enter your refund address on the source network", "REFUND_ADDRESS_INVALID");
  const owner = randomUUID(), keyHash = hashToken(input.idempotencyKey);
  const claim = transaction(() => {
    getDb().prepare("UPDATE funding_request_quotes SET state='failed',reservation_owner=NULL,updated_at=? WHERE request_id=? AND state='quoting' AND funding_id IS NULL AND lease_expires_at<=?").run(now(), request.id, now());
    const existing = row<RequestQuote>("SELECT * FROM funding_request_quotes WHERE request_id=? AND key_hash=?", request.id, keyHash);
    if (existing && (existing.origin_asset !== input.originAsset || existing.refund_address !== input.refundAddress)) throw new ApiError(409, "This quote identifier already has different source terms", "FUNDING_TERMS_CONFLICT");
    if (existing?.funding_id) return { existing };
    const active = activeQuote(request.id);
    if (active) throw new ApiError(409, "An earlier funding leg is still unresolved. Check its settlement before preparing another", "FUNDING_LEG_ACTIVE");
    const id = existing?.id ?? randomUUID(), until = new Date(Date.now() + 90_000).toISOString();
    getDb().prepare("INSERT INTO funding_request_quotes(id,request_id,key_hash,actor_id,origin_asset,refund_address,requested_output,state,reservation_owner,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'quoting',?,?,?,?) ON CONFLICT(request_id,key_hash) DO UPDATE SET state='quoting',actor_id=excluded.actor_id,reservation_owner=excluded.reservation_owner,lease_expires_at=excluded.lease_expires_at,requested_output=excluded.requested_output,updated_at=excluded.updated_at")
      .run(id, request.id, keyHash, `funding-link:${request.capability_id}`, input.originAsset, input.refundAddress, initial.remainingAmount, owner, until, now(), now());
    return { id };
  });
  if (claim.existing) return resumePublicQuote(token, input.idempotencyKey);
  try {
    const config = await frozenTarget(request), tokens = await getSupportedTokens(), origin = tokens.find((item) => item.assetId === input.originAsset), destination = nativeUsdc(tokens, "near");
    if (!origin) throw new ApiError(422, "Choose a live supported source asset", "ASSET_UNSUPPORTED");
    try { normalizeDestination(origin.blockchain, input.refundAddress); } catch { throw new ApiError(422, "Use a complete valid recovery address for the selected source network", "REFUND_ADDRESS_INVALID"); }
    if (destination.contractAddress !== request.token_contract) throw new ApiError(409, "The live catalog's settlement token changed", "FUNDING_TARGET_CHANGED");
    const deadline = new Date(Math.min(Date.now() + 2 * 60 * 60_000, Date.parse(request.expires_at))).toISOString();
    const quote = await requestQuote({ dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 50, originAsset: origin.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: destination.assetId, amount: initial.remainingAmount, recipient: config.near_account_id, recipientType: "DESTINATION_CHAIN", refundTo: input.refundAddress, refundType: "ORIGIN_CHAIN", deadline, customRecipientMsg: `razor:funding-request:${request.id}` });
    if (quote.quote.amountOut !== initial.remainingAmount || Date.parse(quote.quote.deadline ?? deadline) > Date.parse(request.expires_at)) throw new ApiError(502, "The signed quote changed the fixed amount or request expiry", "FUNDING_QUOTE_MISMATCH");
    await frozenTarget(request);
    return transaction(() => {
      const current = requestForToken(token); assertOpen(current);
      const reserved = row<RequestQuote>("SELECT * FROM funding_request_quotes WHERE id=? AND state='quoting' AND reservation_owner=? AND lease_expires_at>?", claim.id!, owner, now());
      if (!reserved) throw new ApiError(409, "This funding preparation was replaced. Refresh the request before funding", "FUNDING_RESERVATION_EXPIRED");
      const fundingId = randomUUID(), savedAt = now();
      getDb().prepare("INSERT INTO funding_legs(id,organization_id,payment_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,deposit_memo,recipient_address,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending_deposit',?,?)")
        .run(fundingId, request.organization_id, request.payment_id, `request:${request.id}:${reserved.id}`, origin.assetId, quote.quote.amountIn, quote.quote.amountOut, JSON.stringify(quote), quote.quote.depositAddress!, quote.quote.depositMemo ?? null, request.treasury_account_id, savedAt, savedAt);
      getDb().prepare("UPDATE funding_request_quotes SET funding_id=?,origin_token_json=?,state='active',reservation_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(fundingId, JSON.stringify(origin), savedAt, reserved.id);
      if (rows<{ name: string }>("PRAGMA table_info(funding_legs)").some((column) => column.name === "origin_network")) getDb().prepare("UPDATE funding_legs SET origin_network=?,origin_decimals=?,origin_symbol=? WHERE id=?").run(origin.blockchain, origin.decimals, origin.symbol, fundingId);
      return quoteResult(current, row<RequestQuote>("SELECT * FROM funding_request_quotes WHERE id=?", reserved.id)!);
    });
  } catch (error) {
    getDb().prepare("UPDATE funding_request_quotes SET state='failed',reservation_owner=NULL,updated_at=? WHERE id=? AND state='quoting' AND funding_id IS NULL AND reservation_owner=?").run(now(), claim.id!, owner);
    throw error;
  }
}

export async function reconcilePublicFunding(token: string, input: { fundingId: string; idempotencyKey?: string; sourceTxHash?: string }, observe = checkStatus) {
  const request = requestForToken(token), quote = row<RequestQuote>("SELECT * FROM funding_request_quotes WHERE request_id=? AND funding_id=?", request.id, input.fundingId);
  if (!quote) throw new ApiError(404, "Funding leg not found for this link", "FUNDING_QUOTE_NOT_FOUND");
  const funding = legForQuote(quote);
  if (["refunded_verified", "refunded_attested"].includes(funding.status)) return { request: publicView(request), funding: { id: funding.id, status: funding.status }, confirmationRequired: false };
  if (input.sourceTxHash) {
    if (!input.idempotencyKey || hashToken(input.idempotencyKey) !== quote.key_hash) throw new ApiError(403, "Resume this browser's funding quote before recording its transfer", "FUNDING_QUOTE_PROOF_REQUIRED");
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(input.sourceTxHash)) throw new ApiError(422, "Enter a valid source transaction hash", "FUNDING_HASH_INVALID");
    if (funding.source_tx_hash && funding.source_tx_hash !== input.sourceTxHash) throw new ApiError(409, "Another source transaction is already recorded for this quote", "FUNDING_SOURCE_CONFLICT");
    const saved = getDb().prepare("UPDATE funding_legs SET source_tx_hash=COALESCE(source_tx_hash,?),updated_at=? WHERE id=? AND (source_tx_hash IS NULL OR source_tx_hash=?)").run(input.sourceTxHash, now(), funding.id, input.sourceTxHash);
    if (!saved.changes) throw new ApiError(409, "Another source transaction is already recorded for this quote", "FUNDING_SOURCE_CONFLICT");
    try { await notifyDeposit(funding.deposit_address, input.sourceTxHash, funding.deposit_memo); } catch {}
  }
  if (verifiedAmount(request, funding.id) === 0n) {
    const status = await observe(funding.deposit_address, funding.deposit_memo);
    assertSameQuote(JSON.parse(funding.quote) as QuoteResponse, status.quoteResponse);
    transaction(db => {
      const latest = legForQuote(quote), next = fundingStateAfterProvider(latest, status.status);
      db.prepare("UPDATE funding_legs SET status=?,provider_status=?,destination_tx_hash=COALESCE(?,destination_tx_hash),updated_at=? WHERE id=? AND status NOT IN ('confirmed','refunded_verified','refunded_attested')")
        .run(next, status.status, status.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null, now(), funding.id);
    });
  }
  return { request: publicView(request), funding: { id: funding.id, status: publicLegStatus(request, row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", funding.id)!) }, confirmationRequired: verifiedAmount(request, funding.id) === 0n };
}

export async function claimPublicFunding(token: string, input: { fundingId: string; idempotencyKey: string }, observe = checkStatus) {
  const request = requestForToken(token); validateKey(input.idempotencyKey); assertOpen(request);
  const quote = row<RequestQuote>("SELECT * FROM funding_request_quotes WHERE request_id=? AND funding_id=? AND key_hash=? AND state='active'", request.id, input.fundingId, hashToken(input.idempotencyKey));
  if (!quote) throw new ApiError(403, "Resume this browser's funding quote before starting its source transfer", "FUNDING_QUOTE_PROOF_REQUIRED");
  if (activeQuote(request.id)?.funding_id !== input.fundingId) throw new ApiError(409, "An earlier funding transfer still needs reconciliation before this deposit", "FUNDING_LEG_ACTIVE");
  await frozenTarget(request);
  const funding = legForQuote(quote), status = await observe(funding.deposit_address, funding.deposit_memo);
  requireUnstartedDeposit(funding, status);
  return transaction(() => { assertOpen(requestForToken(token)); if (activeQuote(request.id)?.funding_id !== funding.id) throw new ApiError(409, "An earlier funding transfer needs reconciliation", "FUNDING_LEG_ACTIVE"); return recordDepositClaim(funding); });
}

export async function closePublicUnsentFunding(token: string, input: { fundingId: string; idempotencyKey: string; noTransferConfirmed: boolean }, observe = checkStatus) {
  const request = requestForToken(token); validateKey(input.idempotencyKey);
  if (!input.noTransferConfirmed) throw new ApiError(422, "Confirm that you never submitted this source transfer", "UNSENT_CONFIRMATION_REQUIRED");
  const quote = row<RequestQuote>("SELECT * FROM funding_request_quotes WHERE request_id=? AND funding_id=? AND key_hash=?", request.id, input.fundingId, hashToken(input.idempotencyKey));
  if (!quote) throw new ApiError(403, "Resume this browser's original quote before closing it", "FUNDING_QUOTE_PROOF_REQUIRED");
  const funding = legForQuote(quote), signed = JSON.parse(funding.quote) as QuoteResponse;
  if (funding.status !== "pending_deposit" || funding.source_tx_hash) throw new ApiError(409, "A submitted or uncertain source transfer must be reconciled", "FUNDING_TRANSFER_UNRESOLVED");
  if (quoteDepositWindow(signed).startBefore > Date.now()) throw new ApiError(409, "The original quote can still accept a deposit. Resume it before preparing another", "FUNDING_QUOTE_ACTIVE");
  const status = await observe(funding.deposit_address, funding.deposit_memo);
  assertSameQuote(signed, status.quoteResponse);
  if (quoteDepositWindow(status.quoteResponse).startBefore > Date.now()) throw new ApiError(409, "The provider still accepts this quote. Continue tracking it before preparing another", "FUNDING_QUOTE_ACTIVE");
  if (status.status !== "PENDING_DEPOSIT") throw new ApiError(409, "The provider has observed source activity. Track the original transfer", "FUNDING_TRANSFER_UNRESOLVED");
  transaction(db => {
    const current = legForQuote(quote);
    if (current.status !== "pending_deposit" || current.source_tx_hash) throw new ApiError(409, "Source tracking changed during this review", "FUNDING_TRANSFER_UNRESOLVED");
    db.prepare("UPDATE funding_legs SET status='closed_unsent',updated_at=? WHERE id=?").run(now(), funding.id);
    db.prepare("UPDATE funding_request_quotes SET state='closed',updated_at=? WHERE id=?").run(now(), quote.id);
  });
  return { request: publicView(requestForToken(token)), fundingId: funding.id };
}

export async function closeCompanyUnsentFunding(access: AccessContext, fundingId: string, noTransferConfirmed: boolean, observe = checkStatus) {
  requirePermission(access, "payments:prepare");
  if (!noTransferConfirmed) throw new ApiError(422, "Confirm that you never submitted this source transfer", "UNSENT_CONFIRMATION_REQUIRED");
  const funding = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", fundingId, access.organizationId);
  if (!funding) throw new ApiError(404, "Source funding leg not found", "FUNDING_NOT_FOUND");
  if (funding.payment_id || row("SELECT id FROM funding_request_quotes WHERE funding_id=?", fundingId)) throw new ApiError(409, "Close this source quote from its obligation task or original funding link", "FUNDING_SOURCE_CONTEXT_REQUIRED");
  if (funding.status !== "pending_deposit" || funding.source_tx_hash) throw new ApiError(409, "A submitted or uncertain source transfer must remain in reconciliation", "FUNDING_TRANSFER_UNRESOLVED");
  const stored = JSON.parse(funding.quote) as QuoteResponse;
  if (quoteDepositWindow(stored).startBefore > Date.now()) throw new ApiError(409, "This quote can still accept a deposit. Resume it before preparing another", "FUNDING_QUOTE_ACTIVE");
  const status = await observe(funding.deposit_address, funding.deposit_memo);
  assertSameQuote(stored, status.quoteResponse);
  if (status.status !== "PENDING_DEPOSIT" || quoteDepositWindow(status.quoteResponse).startBefore > Date.now()) throw new ApiError(409, "The provider has observed source activity or still accepts this quote. Keep tracking it", "FUNDING_TRANSFER_UNRESOLVED");
  return transaction(db => {
    const latest = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", fundingId, access.organizationId)!;
    if (latest.status !== "pending_deposit" || latest.source_tx_hash) throw new ApiError(409, "Source tracking changed during this review", "FUNDING_TRANSFER_UNRESOLVED");
    db.prepare("UPDATE funding_legs SET status='closed_unsent',updated_at=? WHERE id=?").run(now(), fundingId);
    return { funding: row<FundingLeg>("SELECT * FROM funding_legs WHERE id=?", fundingId)! };
  });
}

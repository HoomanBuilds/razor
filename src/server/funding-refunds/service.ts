import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { activity } from "../business/service";
import { checkStatus, getSupportedTokens, type QuoteResponse, type Token } from "../payments/intents";
import type { FundingLeg } from "../payments/types";
import { digest, REFUND_FINAL_STATES, refundTerms } from "./policy";
import { sourceWalletFamily, verifySourceRefund } from "./receipts";
import type { RefundInput, RefundProof, RefundReview, RefundTerms } from "./types";

interface ReviewRow { id: string; funding_id: string; created_by: string; terms_hash: string; terms_ciphertext: string; proof_ciphertext: string; expires_at: string; confirmed_at: string | null }
interface Closure { funding_id: string; review_id: string; source_asset: string; source_network: string; refund_address: string; refunded_amount: string; reported_deposited_amount: string | null; transaction_hash: string; provenance: RefundProof["provenance"]; confirmed_at: string; confirmed_by: string }
interface Dependencies { status: typeof checkStatus; tokens: typeof getSupportedTokens; verify: typeof verifySourceRefund }
const now = () => new Date().toISOString();

function fundingFor(access: AccessContext, id: string) {
  requirePermission(access, "payments:read");
  const funding = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!funding) throw new ApiError(404, "Source funding leg not found", "FUNDING_NOT_FOUND");
  return funding;
}
function closureFor(access: AccessContext, id: string) { return row<Closure>("SELECT funding_id,review_id,source_asset,source_network,refund_address,refunded_amount,reported_deposited_amount,transaction_hash,provenance,confirmed_at,confirmed_by FROM funding_refund_closures WHERE funding_id=? AND organization_id=?", id, access.organizationId); }
function authorize(access: AccessContext, terms: RefundTerms) {
  if (access.permissions.includes("payments:approve")) return "company_reporter";
  requirePermission(access, "payments:prepare");
  const family = sourceWalletFamily(terms.source.blockchain);
  const linked = family && row("SELECT id FROM linked_wallets WHERE user_id=? AND family=? AND address=? AND (family!='near' OR network='mainnet')", access.userId, family, family === "evm" ? terms.refundTo.toLowerCase() : terms.refundTo);
  if (!linked) throw new ApiError(403, "Verify control of the original refund wallet or ask a company payment approver to review the refund", "FUNDING_REFUND_AUTHORITY_REQUIRED");
  return "linked_funder";
}
function assertUncredited(access: AccessContext, funding: FundingLeg) {
  if (["confirmed", "reported_delivered"].includes(funding.status) || funding.credited_amount !== "0" || row("SELECT id FROM funding_credit_receipts WHERE funding_id=? AND organization_id=?", funding.id, access.organizationId)) throw new ApiError(409, "A credited or delivered funding leg cannot be closed as a full source refund", "FUNDING_REFUND_CONTRADICTION");
}
function parseQuote(funding: FundingLeg): QuoteResponse {
  try { const result = JSON.parse(funding.quote); if (!result?.quoteRequest || !result?.quote) throw new Error(); return result; } catch { throw new ApiError(409, "The original source quote is unavailable. Keep this transfer held for manual review", "FUNDING_REFUND_QUOTE_MISMATCH"); }
}
function frozenToken(funding: FundingLeg): Token | null {
  const request = row<{ origin_token_json: string | null }>("SELECT origin_token_json FROM funding_request_quotes WHERE funding_id=?", funding.id);
  const task = row<{ origin_token_json: string | null }>("SELECT origin_token_json FROM payment_funding_quotes WHERE funding_id=? AND organization_id=?", funding.id, funding.organization_id);
  const text = request?.origin_token_json ?? task?.origin_token_json;
  if (!text) return null;
  try {
    const token = JSON.parse(text) as Token;
    if (token.assetId !== funding.origin_asset || typeof token.symbol !== "string" || !token.symbol || typeof token.blockchain !== "string" || !token.blockchain || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 38 || token.contractAddress !== null && typeof token.contractAddress !== "string") throw new Error();
    return token;
  } catch { throw new ApiError(409, "The original source token snapshot cannot be verified", "FUNDING_REFUND_ASSET_MISMATCH"); }
}

export function listFundingRefunds(access: AccessContext) {
  requirePermission(access, "payments:read");
  const funding = rows<FundingLeg>("SELECT * FROM funding_legs WHERE organization_id=? AND (status IN ('recovery_pending','unknown','refunded_verified','refunded_attested') OR provider_status IN ('REFUNDED','FAILED','INCOMPLETE_DEPOSIT')) ORDER BY created_at DESC LIMIT 100", access.organizationId);
  return { funding: funding.map(leg => {
    const quote = parseQuote(leg), closure = closureFor(access, leg.id);
    return { id: leg.id, reference: leg.reference, paymentId: leg.payment_id, status: leg.status, providerStatus: leg.provider_status, sourceAsset: leg.origin_asset, sourceSymbol: leg.origin_symbol ?? null, sourceDecimals: leg.origin_decimals ?? null, sourceNetwork: leg.origin_network ?? null, refundTo: quote.quoteRequest.refundTo, sourceTransactionHash: leg.source_tx_hash, closure: closure ?? null };
  }), message: "Source refunds return the original source asset to the original funder's recovery address. They do not create company USDC or prove a recipient payout.", canPrepare: access.permissions.includes("payments:prepare") || access.permissions.includes("payments:approve") };
}

export function createFundingRefundService(dependencies: Dependencies = { status: checkStatus, tokens: getSupportedTokens, verify: verifySourceRefund }) {
  async function observe(access: AccessContext, fundingId: string, input: RefundInput, expectedSource?: Token) {
    if (!access.permissions.includes("payments:approve")) requirePermission(access, "payments:prepare");
    const funding = fundingFor(access, fundingId);
    assertUncredited(access, funding);
    const quote = parseQuote(funding);
    const source = frozenToken(funding) ?? expectedSource ?? (await dependencies.tokens(true)).find(token => token.assetId === funding.origin_asset);
    if (!source) throw new ApiError(409, "The original source token identity is unavailable. Keep the refund held until it can be verified", "FUNDING_REFUND_ASSET_UNAVAILABLE");
    const status = await dependencies.status(funding.deposit_address, funding.deposit_memo), terms = refundTerms(funding, quote, status, source, input), authority = authorize(access, terms);
    const proof = await dependencies.verify(terms);
    if (proof.transactionHash !== terms.transactionHash || proof.amount !== terms.refundedAmount || proof.receiver !== terms.refundTo || proof.network !== terms.source.blockchain || !proof.eventKeys.length || new Set(proof.eventKeys).size !== proof.eventKeys.length) throw new ApiError(502, "Refund proof does not match the reviewed source terms", "FUNDING_REFUND_RECEIPT_UNPROVEN");
    return { funding, terms, proof, authority, status };
  }
  async function prepare(access: AccessContext, fundingId: string, input: RefundInput): Promise<RefundReview> {
    const observed = await observe(access, fundingId, input);
    if (REFUND_FINAL_STATES.includes(observed.funding.status) || closureFor(access, fundingId)) throw new ApiError(409, "This source refund is already closed. Review its saved history", "FUNDING_REFUND_ALREADY_CLOSED");
    const reviewId = randomUUID(), reviewToken = digest(observed.terms), expiresAt = new Date(Date.now() + 120_000).toISOString();
    getDb().prepare("INSERT INTO funding_refund_reviews(id,organization_id,funding_id,created_by,terms_hash,terms_ciphertext,proof_ciphertext,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(reviewId, access.organizationId, fundingId, access.userId, reviewToken, encrypt(JSON.stringify(observed.terms)), encrypt(JSON.stringify(observed.proof)), expiresAt, now());
    return { reviewId, reviewToken, expiresAt, terms: observed.terms, proof: observed.proof, requiresAttestation: observed.proof.provenance === "funder_or_reporter_attestation", message: observed.proof.provenance === "final_chain_receipt" ? "A final source-chain receipt matches this refund. Confirm closure of this source leg only; company USDC and recipient delivery remain unchanged." : "The provider reports a completed refund, but Razor cannot verify this receipt's transfer. An authorized linked funder or company reporter must explicitly attest receipt of these exact source units. This is not a cryptographically verified recovery." };
  }
  async function confirm(access: AccessContext, fundingId: string, input: { reviewId: string; reviewToken: string; acknowledged: true; evidence?: string }) {
    fundingFor(access, fundingId);
    const review = row<ReviewRow>("SELECT * FROM funding_refund_reviews WHERE id=? AND funding_id=? AND organization_id=? AND created_by=?", input.reviewId, fundingId, access.organizationId, access.userId);
    if (!review || review.terms_hash !== input.reviewToken || !input.acknowledged) throw new ApiError(409, "Review the exact source refund before confirming it", "FUNDING_REFUND_REVIEW_CHANGED");
    const terms = JSON.parse(decrypt(review.terms_ciphertext)) as RefundTerms, preparedProof = JSON.parse(decrypt(review.proof_ciphertext)) as RefundProof;
    if (digest(terms) !== input.reviewToken) throw new ApiError(409, "The saved refund terms changed", "FUNDING_REFUND_REVIEW_CHANGED");
    authorize(access, terms);
    const existing = closureFor(access, fundingId);
    if (existing) {
      if (existing.review_id !== review.id) throw new ApiError(409, "This leg was closed under another reviewed refund", "FUNDING_REFUND_ALREADY_CLOSED");
      return { closure: existing, alreadyClosed: true, companyUsdcCredited: "0" };
    }
    if (review.expires_at <= now()) throw new ApiError(409, "The refund review expired. Recheck current provider and receipt evidence", "FUNDING_REFUND_REVIEW_EXPIRED");
    if (preparedProof.provenance === "funder_or_reporter_attestation" && (!input.evidence?.trim() || input.evidence.trim().length < 12 || input.evidence.length > 2000)) throw new ApiError(422, "Record how you confirmed receipt of the original asset and amount", "FUNDING_REFUND_ATTESTATION_REQUIRED");
    const observed = await observe(access, fundingId, { transactionHash: terms.transactionHash, senderAccountId: terms.senderAccountId ?? undefined, sourceTransactionHash: terms.sourceTransactionHash ?? undefined }, terms.source);
    if (digest(observed.terms) !== input.reviewToken || observed.proof.provenance !== preparedProof.provenance || digest([...observed.proof.eventKeys].sort()) !== digest([...preparedProof.eventKeys].sort())) throw new ApiError(409, "Provider refund terms or receipt identity changed. Keep the original source leg held and review it again", "FUNDING_REFUND_REVIEW_CHANGED");
    transaction(db => {
      const latest = fundingFor(access, fundingId);
      assertUncredited(access, latest);
      if (latest.quote !== observed.funding.quote || latest.source_tx_hash && latest.source_tx_hash !== terms.sourceTransactionHash || closureFor(access, fundingId)) throw new ApiError(409, "Source tracking changed during refund confirmation", "FUNDING_REFUND_REVIEW_CHANGED");
      for (const eventKey of observed.proof.eventKeys) {
        if (row("SELECT funding_id FROM funding_refund_events WHERE event_key=?", eventKey)) throw new ApiError(409, "This refund receipt was already assigned to another source leg", "FUNDING_REFUND_RECEIPT_REPLAYED");
        db.prepare("INSERT INTO funding_refund_events(event_key,funding_id,created_at) VALUES(?,?,?)").run(eventKey, fundingId, now());
      }
      db.prepare("INSERT INTO funding_refund_closures(funding_id,organization_id,review_id,source_asset,source_network,refund_address,refunded_amount,reported_deposited_amount,transaction_hash,provenance,evidence_ciphertext,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(fundingId, access.organizationId, review.id, terms.source.assetId, terms.source.blockchain, terms.refundTo, terms.refundedAmount, terms.reportedDepositedAmount, terms.transactionHash, observed.proof.provenance, encrypt(JSON.stringify({ proof: observed.proof, provider: observed.status, authority: observed.authority, attestation: input.evidence?.trim() ?? null })), access.userId, now());
      const status = observed.proof.provenance === "final_chain_receipt" ? "refunded_verified" : "refunded_attested";
      db.prepare("UPDATE funding_legs SET status=?,provider_status='REFUNDED',source_tx_hash=COALESCE(source_tx_hash,?),updated_at=? WHERE id=? AND organization_id=?").run(status, terms.sourceTransactionHash, now(), fundingId, access.organizationId);
      db.prepare("UPDATE funding_refund_reviews SET confirmed_at=? WHERE id=?").run(now(), review.id);
      db.prepare("UPDATE funding_request_quotes SET state='closed',updated_at=? WHERE funding_id=?").run(now(), fundingId);
      db.prepare("UPDATE payment_funding_quotes SET state='closed',updated_at=? WHERE funding_id=? AND organization_id=?").run(now(), fundingId, access.organizationId);
      activity(access, "funding.source_refund_closed", fundingId, { provenance: observed.proof.provenance });
    });
    return { closure: closureFor(access, fundingId)!, alreadyClosed: false, companyUsdcCredited: "0" };
  }
  return { prepare, confirm };
}

export const fundingRefundService = createFundingRefundService();

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { audit, getAccess } from "../identity/session";
import { getRecipientVersion } from "../identity/recipients";
import {
  contractCodeHash,
  deriveSharedCompanyId,
  tokenReceiptIdentity,
  verifySharedDeposit,
  verifyTokenReceipt,
  view,
} from "../payments/near";
import { syncTreasury } from "../payments/service";
import { reviewedArtifactHash } from "../near-artifacts";
import { NATIVE_USDC } from "../../lib/native-usdc";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import {
  acceptInput,
  actionInput,
  hash,
  offerInput,
  paging,
  requestInput,
  type ChainLoan,
  type LoanTerms,
  type OfferRow,
  type RequestRow,
  type RequestTerms,
  type Scope,
} from "./model";
export type { ChainLoan, LoanTerms } from "./model";
export {
  assertBillUnassigned,
  financingPositions,
  financingExportRows,
} from "./accounting";
const now = () => new Date().toISOString();
const decode = <T>(value: string) => JSON.parse(decrypt(value)) as T;
const invited = (scope: Scope, userId: string) =>
  scope.active === 1 &&
  (JSON.parse(scope.allowed_lenders_json) as string[]).includes(userId);
const scoped = (scope: Scope, org: string) =>
  scope.active === 1 &&
  (JSON.parse(scope.allowed_organizations_json) as string[]).includes(org);
function current(access: AccessContext, owner = false) {
  const live = getAccess(access.userId, access.organizationId);
  requirePermission(live, "company:read");
  requirePermission(live, "payments:read");
  if (owner) {
    requirePermission(live, "payments:approve");
    requirePermission(live, "company:manage");
    if (
      !row(
        "SELECT id FROM organizations WHERE id=? AND owner_id=?",
        live.organizationId,
        live.userId,
      )
    )
      throw new ApiError(
        403,
        "Only the company owner can create or accept borrowing terms",
        "FINANCING_OWNER_REQUIRED",
      );
  }
  return live;
}
function request(id: string) {
  const value = row<RequestRow>(
    "SELECT * FROM financing_requests WHERE id=?",
    id,
  );
  if (!value)
    throw new ApiError(
      404,
      "Financing request not found",
      "FINANCING_NOT_FOUND",
    );
  return value;
}
function own(access: AccessContext, id: string, owner = false) {
  const live = current(access, owner),
    value = request(id);
  if (value.organization_id !== live.organizationId)
    throw new ApiError(
      404,
      "Financing request not found",
      "FINANCING_NOT_FOUND",
    );
  return { live, value };
}
function scopeFor(value: RequestRow) {
  return decode<Scope>(value.scope_ciphertext);
}
function currentScope(value: RequestRow) {
  const scope = row<Scope>(
    "SELECT * FROM financing_scopes WHERE id=?",
    value.scope_id,
  );
  if (
    !scope ||
    scope.version !== value.scope_version ||
    !scoped(scope, value.organization_id)
  )
    throw new ApiError(
      409,
      "The operating scope changed. New funding needs a new company request; existing repayment and withdrawal rights remain separate",
      "FINANCING_SCOPE_CHANGED",
    );
  return scope;
}
function linked(userId: string, network: string, account: string) {
  if (
    !row(
      "SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND network=? AND address=?",
      userId,
      network,
      account,
    )
  )
    throw new ApiError(
      403,
      "Link and verify this exact NEAR account before signing",
      "FINANCING_WALLET_REQUIRED",
    );
}
function event(
  value: RequestRow,
  userId: string,
  kind: string,
  data: unknown = {},
) {
  getDb()
    .prepare(
      "INSERT INTO financing_history(id,request_id,actor_user_id,kind,payload_ciphertext,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      value.id,
      userId,
      kind,
      encrypt(JSON.stringify(data)),
      now(),
    );
  audit(userId, value.organization_id, `financing.${kind}`, value.id);
}
function target(scope: Scope) {
  return { near_account_id: scope.contract_id, network: scope.network };
}
async function configured(scope: Scope) {
  const expected = reviewedArtifactHash(
    "NEAR_CREDIT_CODE_HASH",
    "razor_credit.wasm",
  );
  if (
    scope.code_hash !== expected ||
    (await contractCodeHash(target(scope))) !== expected
  )
    throw new ApiError(
      409,
      "The reviewed native credit contract is not deployed at the published code identity",
      "FINANCING_DEPLOYMENT_REQUIRED",
    );
  const config = await view<{
    version: number;
    network: string;
    token_contract: string;
    treasury_id: string;
    paused: boolean;
    minimum_registration_deposit: string;
  }>(target(scope), "get_config");
  if (
    config.version !== 1 ||
    config.network !== scope.network ||
    config.token_contract !== scope.token_contract ||
    config.treasury_id !== scope.treasury_id ||
    (scope.network === "mainnet" && scope.token_contract !== NATIVE_USDC.near)
  )
    throw new ApiError(
      409,
      "The credit contract configuration differs from the published scope",
      "FINANCING_DEPLOYMENT_MISMATCH",
    );
  return config;
}
function treasury(value: RequestRow, scope: Scope) {
  const config = row<TreasuryConfig>(
    "SELECT * FROM treasury_config WHERE organization_id=?",
    value.organization_id,
  );
  if (
    !config ||
    config.architecture !== "shared_v1" ||
    config.near_account_id !== scope.treasury_id ||
    config.network !== scope.network ||
    config.token_contract !== scope.token_contract
  )
    throw new ApiError(
      409,
      "Activate the matching native NEAR shared company treasury first",
      "FINANCING_TREASURY_REQUIRED",
    );
  return config;
}
async function borrowerTarget(value: RequestRow, scope: Scope) {
  const config = treasury(value, scope);
  if (
    (await contractCodeHash(config)) !==
    reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")
  )
    throw new ApiError(
      409,
      "The shared treasury code identity changed",
      "FINANCING_TREASURY_MISMATCH",
    );
  const live = await view<{
    company_id: string;
    owner_id: string;
    token_contract: string;
    paused: boolean;
  }>(config, "get_config");
  linked(value.borrower_user_id, scope.network, live.owner_id);
  if (
    live.paused ||
    live.token_contract !== scope.token_contract ||
    live.company_id !== config.company_id ||
    deriveSharedCompanyId(value.organization_id, live.owner_id) !==
      config.company_id
  )
    throw new ApiError(
      409,
      "The current treasury owner or company binding requires review",
      "FINANCING_OWNER_CHANGED",
    );
  return { config, owner: live.owner_id };
}
function termsFor(value: RequestRow) {
  if (!value.terms_ciphertext || !value.terms_hash)
    throw new ApiError(
      409,
      "The owner must accept an exact lender offer first",
      "FINANCING_OFFER_REQUIRED",
    );
  return {
    json: decrypt(value.terms_ciphertext),
    terms: decode<LoanTerms>(value.terms_ciphertext),
    hash: value.terms_hash,
  };
}
async function chainFor(value: RequestRow, scope: Scope) {
  await configured(scope);
  if (!value.loan_id) return null;
  const loan = await view<ChainLoan | null>(target(scope), "get_loan", {
    loan_id: value.loan_id,
  });
  if (loan) {
    const frozen = termsFor(value);
    if (
      loan.terms_json !== frozen.json ||
      loan.terms_hash !== frozen.hash ||
      hash(loan.terms_json) !== frozen.hash ||
      JSON.stringify(loan.terms) !== JSON.stringify(frozen.terms)
    )
      throw new ApiError(
        409,
        "The onchain agreement differs from the frozen borrower and lender terms",
        "FINANCING_TERMS_MISMATCH",
      );
  }
  return loan;
}
function visible(userId: string, value: RequestRow) {
  const selected = value.accepted_offer_id
    ? row<OfferRow>(
        "SELECT * FROM financing_offers WHERE id=?",
        value.accepted_offer_id,
      )
    : null;
  if (
    userId === value.borrower_user_id ||
    selected?.lender_user_id === userId ||
    row(
      "SELECT id FROM financing_offers WHERE request_id=? AND lender_user_id=?",
      value.id,
      userId,
    )
  )
    return { selected, borrower: userId === value.borrower_user_id };
  const scope = row<Scope>(
    "SELECT * FROM financing_scopes WHERE id=?",
    value.scope_id,
  );
  if (value.state !== "open" || !scope || !invited(scope, userId))
    throw new ApiError(
      404,
      "This lending opportunity is not available to your account",
      "FINANCING_NOT_FOUND",
    );
  return { selected, borrower: false };
}
function offerView(value: OfferRow) {
  return {
    id: value.id,
    lenderAccount: value.lender_account,
    ...decode<{ interest: string; fee: string; expiresAt: string }>(
      value.payload_ciphertext,
    ),
    offerHash: value.offer_hash,
    state: value.state,
    createdAt: value.created_at,
  };
}
function summary(value: RequestRow, userId: string, company = false) {
  const scope = scopeFor(value),
    {
      requestKey: _key,
      receivableBillId: _bill,
      ...terms
    } = decode<RequestTerms>(value.payload_ciphertext);
  return {
    id: value.id,
    organizationId: value.organization_id,
    companyName: row<{ name: string }>(
      "SELECT name FROM organizations WHERE id=?",
      value.organization_id,
    )!.name,
    state: value.state,
    terms,
    scope: {
      id: scope.id,
      label: scope.label,
      eligibility: scope.eligibility,
      network: scope.network,
      contractId: scope.contract_id,
      tokenContract: scope.token_contract,
      treasuryId: scope.treasury_id,
    },
    agreement: value.terms_ciphertext
      ? decode<LoanTerms>(value.terms_ciphertext)
      : null,
    agreementHash: value.terms_hash,
    loanId: value.loan_id,
    offers: rows<OfferRow>(
      `SELECT * FROM financing_offers WHERE request_id=?${company || userId === value.borrower_user_id ? "" : " AND lender_user_id=?"} ORDER BY created_at,id LIMIT 50`,
      value.id,
      ...(company || userId === value.borrower_user_id ? [] : [userId]),
    ).map(offerView),
    chain: value.chain_ciphertext
      ? decode<ChainLoan>(value.chain_ciphertext)
      : null,
    reconciledAt: value.reconciled_at,
    createdAt: value.created_at,
    unresolvedDeposit:
      row<{ id: string; kind: string; amount: string; deposit_id: string }>(
        "SELECT id,kind,amount,deposit_id FROM financing_actions WHERE request_id=? AND user_id=? AND stage='signing'",
        value.id,
        userId,
      ) ?? null,
    history: rows<{ id: string; kind: string; created_at: string }>(
      "SELECT id,kind,created_at FROM financing_history WHERE request_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
      value.id,
    ),
    assignment: row<{ bill_id: string; claim_hash: string; state: string }>(
      "SELECT bill_id,claim_hash,state FROM financing_assignments WHERE request_id=?",
      value.id,
    )
      ? {
          mode: "receivable_backed",
          exclusiveWithinRazor: true,
          offPlatformLiensVerified: false,
        }
      : null,
  };
}
export type FinancingRequest = ReturnType<typeof summary>;
export interface FinancingAction {
  actionId?: string;
  requestId: string;
  walletActions: WalletTransaction[];
  network: "mainnet" | "testnet";
  eligibleSigners: string[];
  reviewHash: string;
  agreementHash: string;
  warnings: string[];
}
export function listCompanyFinancing(
  access: AccessContext,
  data: unknown = {},
) {
  const live = current(access),
    { page } = paging.parse(data),
    values = rows<RequestRow>(
      "SELECT * FROM financing_requests WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ?",
      live.organizationId,
      (page - 1) * 25,
    );
  return {
    requests: values
      .slice(0, 25)
      .map((value) => summary(value, live.userId, true)),
    page,
    hasMore: values.length > 25,
    scopes: rows<Scope>(
      "SELECT * FROM financing_scopes WHERE active=1 ORDER BY published_at DESC",
    )
      .filter((scope) => scoped(scope, live.organizationId))
      .map((scope) => ({
        id: scope.id,
        label: scope.label,
        eligibility: scope.eligibility,
        network: scope.network,
        version: scope.version,
      })),
    availability:
      "Only operator-published scope is listed. Each action verifies actual deployment; neither lender participation nor funding is guaranteed.",
  };
}
function claimFor(userId: string, billId: string, borrowerOrg: string) {
  const bill = row<{
    id: string;
    organization_id: string;
    recipient_id: string;
    amount: string;
    accepted_at: string | null;
    status: string;
    setoff_amount: string;
    funded_clearing_amount: string;
    accepted_credit_amount: string;
  }>(
    "SELECT b.* FROM bills b JOIN recipients r ON r.id=b.recipient_id AND r.organization_id=b.organization_id WHERE b.id=? AND r.user_id=? AND r.kind='business' AND r.archived=0 AND r.preference_status='confirmed'",
    billId,
    userId,
  );
  if (
    !bill?.accepted_at ||
    bill.status === "disputed" ||
    bill.organization_id === borrowerOrg
  )
    throw new ApiError(
      409,
      "Receivable mode requires your accepted, undisputed business supplier invoice",
      "FINANCING_CLAIM_INELIGIBLE",
    );
  const payments = rows<{
    amount: string;
    delivered_amount: string;
    recipient_version: number;
  }>(
    "SELECT p.amount,p.delivered_amount,p.recipient_version FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND p.organization_id=?",
    bill.id,
    bill.organization_id,
  );
  if (
    !payments.length ||
    payments.some(
      (payment) =>
        getRecipientVersion(
          bill.organization_id,
          bill.recipient_id,
          payment.recipient_version,
        )?.user_id !== userId,
    )
  )
    throw new ApiError(
      409,
      "The captured original supplier identity changed",
      "FINANCING_CLAIM_OWNER_CHANGED",
    );
  const remaining =
    BigInt(bill.amount) -
    BigInt(bill.setoff_amount) -
    BigInt(bill.funded_clearing_amount) -
    BigInt(bill.accepted_credit_amount) -
    payments.reduce(
      (sum, payment) => sum + BigInt(payment.delivered_amount),
      0n,
    );
  if (
    remaining <= 0n ||
    row(
      "SELECT id FROM financing_assignments WHERE bill_id=? AND state='held'",
      bill.id,
    ) ||
    row(
      "SELECT id FROM clearing_links WHERE bill_id=? AND status IN ('offered','accepted')",
      bill.id,
    )
  )
    throw new ApiError(
      409,
      "The invoice is already discharged, assigned or committed to clearing",
      "FINANCING_CLAIM_UNAVAILABLE",
    );
  return {
    billId: bill.id,
    sourceOrganizationId: bill.organization_id,
    recipientId: bill.recipient_id,
    amount: remaining.toString(),
    originalAmount: bill.amount,
    acceptedAt: bill.accepted_at,
    claimLimit:
      "Razor exclusivity only; off-platform liens and actual debtor collection are unverified",
  };
}
export function createFinancingRequest(access: AccessContext, data: unknown) {
  const live = current(access, true),
    input = requestInput.parse(data),
    fingerprint = hash(input),
    scope = row<Scope>(
      "SELECT * FROM financing_scopes WHERE id=?",
      input.scopeId,
    );
  if (!scope || !scoped(scope, live.organizationId))
    throw new ApiError(
      409,
      "No published operating scope covers this company. An operator must publish real eligibility first",
      "FINANCING_SCOPE_REQUIRED",
    );
  if (
    BigInt(input.maxCost) > BigInt(input.principal) ||
    Date.parse(input.fundBy) <= Date.now() ||
    Date.parse(input.fundBy) > Date.now() + 30 * 86400000
  )
    throw new ApiError(
      422,
      "Keep total fixed borrowing cost within principal and funding within thirty days",
      "FINANCING_TERMS_INVALID",
    );
  return transaction((db) => {
    const previous = row<RequestRow>(
      "SELECT * FROM financing_requests WHERE organization_id=? AND request_key=?",
      live.organizationId,
      input.requestKey,
    );
    if (previous) {
      if (previous.input_hash !== fingerprint)
        throw new ApiError(
          409,
          "This request identity names different borrowing terms",
          "FINANCING_REPLAY_CONFLICT",
        );
      return summary(previous, live.userId, true);
    }
    const active = row<{ n: number }>(
      "SELECT COUNT(*) n FROM financing_requests WHERE organization_id=? AND state!='closed'",
      live.organizationId,
    )!.n;
    if (active >= 25)
      throw new ApiError(
        429,
        "Review existing borrowing requests before opening more",
        "FINANCING_CAPACITY",
      );
    if (input.receivableBillId)
      claimFor(live.userId, input.receivableBillId, live.organizationId);
    const id = randomUUID(),
      at = now();
    db.prepare(
      "INSERT INTO financing_requests(id,organization_id,borrower_user_id,scope_id,scope_version,fund_by,request_key,input_hash,payload_ciphertext,scope_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      live.organizationId,
      live.userId,
      scope.id,
      scope.version,
      new Date(input.fundBy).toISOString(),
      input.requestKey,
      fingerprint,
      encrypt(JSON.stringify(input)),
      encrypt(JSON.stringify(scope)),
      at,
      at,
    );
    event(request(id), live.userId, "requested");
    return summary(request(id), live.userId, true);
  });
}
export function marketFinancing(userId: string, data: unknown = {}) {
  const { page } = paging.parse(data),
    scopes = rows<Scope>(
      "SELECT * FROM financing_scopes WHERE active=1",
    ).filter((scope) => invited(scope, userId)),
    ids = scopes.map((scope) => scope.id);
  const values = ids.length
    ? rows<RequestRow>(
        `SELECT * FROM financing_requests WHERE state='open' AND scope_id IN (${ids.map(() => "?").join(",")}) AND borrower_user_id!=? AND fund_by>? ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ?`,
        ...ids,
        userId,
        now(),
        (page - 1) * 25,
      )
    : [];
  return {
    requests: values.slice(0, 25).map((value) => summary(value, userId)),
    page,
    hasMore: values.length > 25,
    availability: scopes.length
      ? "Invited real lenders only. Offers are proposals until exact owner acceptance and verified escrow funding."
      : "No operator-published lending scope currently includes your account.",
  };
}
export function ownFinancing(userId: string, data: unknown = {}) {
  const { page } = paging.parse(data),
    values = rows<RequestRow>(
      "SELECT DISTINCT r.* FROM financing_requests r LEFT JOIN financing_offers o ON o.id=r.accepted_offer_id WHERE r.borrower_user_id=? OR EXISTS(SELECT 1 FROM financing_offers mine WHERE mine.request_id=r.id AND mine.lender_user_id=?) ORDER BY r.created_at DESC,r.id DESC LIMIT 26 OFFSET ?",
      userId,
      userId,
      (page - 1) * 25,
    );
  return {
    requests: values.slice(0, 25).map((value) => summary(value, userId)),
    page,
    hasMore: values.length > 25,
  };
}
export function inspectCompanyFinancing(access: AccessContext, id: string) {
  const { live, value } = own(access, id);
  return summary(value, live.userId, true);
}
export function inspectPersonalFinancing(userId: string, id: string) {
  const value = request(id);
  visible(userId, value);
  return summary(value, userId);
}
export function submitFinancingOffer(
  userId: string,
  id: string,
  data: unknown,
) {
  const input = offerInput.parse(data),
    value = request(id),
    scope = currentScope(value);
  if (!invited(scope, userId) || value.borrower_user_id === userId)
    throw new ApiError(
      403,
      "Only an independently invited lender can make this offer",
      "FINANCING_LENDER_REQUIRED",
    );
  linked(userId, scope.network, input.accountId);
  const requested = decode<RequestTerms>(value.payload_ciphertext);
  if (
    value.state !== "open" ||
    Date.parse(input.expiresAt) <= Date.now() ||
    Date.parse(input.expiresAt) > Date.parse(requested.fundBy) ||
    BigInt(input.interest) + BigInt(input.fee) > BigInt(requested.maxCost)
  )
    throw new ApiError(
      409,
      "Use an unexpired offer within the company's exact fixed cost ceiling",
      "FINANCING_OFFER_INVALID",
    );
  return transaction((db) => {
    const fingerprint = hash({ id, ...input }),
      previous = row<OfferRow>(
        "SELECT * FROM financing_offers WHERE lender_user_id=? AND request_key=?",
        userId,
        input.requestKey,
      );
    if (previous) {
      if (previous.input_hash !== fingerprint)
        throw new ApiError(
          409,
          "This offer identity names different terms",
          "FINANCING_REPLAY_CONFLICT",
        );
      return offerView(previous);
    }
    if (
      row<{ n: number }>(
        "SELECT COUNT(*) n FROM financing_offers WHERE request_id=?",
        id,
      )!.n >= 50
    )
      throw new ApiError(
        429,
        "This request has reached its bounded offer capacity",
        "FINANCING_OFFER_CAPACITY",
      );
    if (
      row<{ n: number }>(
        "SELECT COUNT(*) n FROM financing_offers WHERE request_id=? AND lender_user_id=?",
        id,
        userId,
      )!.n >= 5
    )
      throw new ApiError(
        429,
        "Review your five existing comparable offers before submitting more",
        "FINANCING_LENDER_OFFER_CAPACITY",
      );
    const offerId = randomUUID(),
      payload = {
        interest: input.interest,
        fee: input.fee,
        expiresAt: input.expiresAt,
      },
      offerHash = hash({
        request: value.input_hash,
        lenderUserId: userId,
        lenderAccount: input.accountId,
        ...payload,
      });
    db.prepare(
      "INSERT INTO financing_offers(id,request_id,lender_user_id,lender_account,request_key,input_hash,payload_ciphertext,offer_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      offerId,
      id,
      userId,
      input.accountId,
      input.requestKey,
      fingerprint,
      encrypt(JSON.stringify(payload)),
      offerHash,
      now(),
    );
    event(value, userId, "offer_submitted", { offerId, offerHash });
    return offerView(
      row<OfferRow>("SELECT * FROM financing_offers WHERE id=?", offerId)!,
    );
  });
}
export async function acceptFinancingOffer(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const { live, value } = own(access, id, true),
    input = acceptInput.parse(data),
    scope = currentScope(value),
    deployment = await configured(scope);
  if (deployment.paused)
    throw new ApiError(
      409,
      "New financing is paused by its operator",
      "FINANCING_PAUSED",
    );
  if (value.borrower_user_id !== live.userId)
    throw new ApiError(
      409,
      "The original company owner changed. Publish a new request instead of inheriting borrowing authority",
      "FINANCING_OWNER_CHANGED",
    );
  const destination = await borrowerTarget(value, scope);
  return transaction((db) => {
    const fresh = request(id);
    current(live, true);
    if (fresh.state !== "open" || fresh.terms_hash)
      throw new ApiError(
        409,
        "This request already has an immutable accepted offer",
        "FINANCING_ALREADY_ACCEPTED",
      );
    const offer = row<OfferRow>(
      "SELECT * FROM financing_offers WHERE id=? AND request_id=? AND state='proposed'",
      input.offerId,
      id,
    );
    if (
      !offer ||
      offer.offer_hash !== input.offerHash ||
      !invited(currentScope(fresh), offer.lender_user_id)
    )
      throw new ApiError(
        409,
        "The lender offer or operating scope changed",
        "FINANCING_OFFER_CHANGED",
      );
    linked(offer.lender_user_id, scope.network, offer.lender_account);
    const proposed = decode<{
        interest: string;
        fee: string;
        expiresAt: string;
      }>(offer.payload_ciphertext),
      requested = decode<RequestTerms>(fresh.payload_ciphertext);
    if (
      Date.parse(proposed.expiresAt) <= Date.now() ||
      Date.parse(requested.fundBy) <= Date.now()
    )
      throw new ApiError(
        409,
        "This offer or funding window expired",
        "FINANCING_OFFER_EXPIRED",
      );
    if (offer.lender_account === destination.owner)
      throw new ApiError(
        409,
        "Use a distinct actual lender account",
        "FINANCING_DISTINCT_LENDER_REQUIRED",
      );
    const claim = requested.receivableBillId
        ? claimFor(live.userId, requested.receivableBillId, live.organizationId)
        : null,
      loanId = hash(`${destination.owner}:${id}`),
      terms: LoanTerms = {
        id: loanId,
        request_id: id,
        company_id: destination.config.company_id!,
        borrower: destination.owner,
        lender: offer.lender_account,
        principal: requested.principal,
        interest: proposed.interest,
        fee: proposed.fee,
        collateral: requested.collateral,
        tenor_ms: String(requested.tenorDays * 86400000),
        grace_ms: String(requested.graceDays * 86400000),
        fund_by_ms: String(Date.parse(requested.fundBy)),
        repayment_source: requested.repaymentSource,
        receivable_hash: claim ? hash(claim) : null,
        waterfall: "principal_interest_fee",
        default_rule: "fixed_bond_only_after_due_plus_grace",
        collateral_rule: "remaining_bond_to_borrower",
        dispute_rule: "bilateral_resume_no_repricing",
      },
      wire = JSON.stringify(terms),
      termsHash = hash(wire);
    db.prepare(
      "UPDATE financing_requests SET state='accepted',accepted_offer_id=?,loan_id=?,terms_ciphertext=?,terms_hash=?,updated_at=? WHERE id=? AND state='open'",
    ).run(offer.id, loanId, encrypt(wire), termsHash, now(), id);
    db.prepare(
      "UPDATE financing_offers SET state=CASE WHEN id=? THEN 'accepted' ELSE 'not_selected' END WHERE request_id=?",
    ).run(offer.id, id);
    if (claim)
      db.prepare(
        "INSERT INTO financing_assignments(id,request_id,organization_id,source_organization_id,bill_id,claim_hash,claim_ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        id,
        live.organizationId,
        claim.sourceOrganizationId,
        claim.billId,
        terms.receivable_hash!,
        encrypt(JSON.stringify(claim)),
        now(),
      );
    event(fresh, live.userId, "offer_accepted", {
      offerId: offer.id,
      termsHash,
    });
    return summary(request(id), live.userId, true);
  });
}
export async function reconcileFinancing(
  userId: string,
  id: string,
  access?: AccessContext,
) {
  const value = access ? own(access, id).value : request(id);
  if (!access) visible(userId, value);
  const scope = scopeFor(value),
    loan = await chainFor(value, scope);
  if (loan) {
    for (const action of rows<{ id: string; deposit_id: string }>(
      "SELECT id,deposit_id FROM financing_actions WHERE request_id=? AND stage='signing'",
      id,
    )) {
      if (
        await view<boolean>(target(scope), "deposit_seen", {
          loan_id: value.loan_id,
          deposit_id: action.deposit_id,
        })
      )
        getDb()
          .prepare(
            "UPDATE financing_actions SET stage='observed',updated_at=? WHERE id=? AND stage='signing'",
          )
          .run(now(), action.id);
    }
  }
  return transaction((db) => {
    if (loan) {
      db.prepare(
        "UPDATE financing_requests SET chain_ciphertext=?,reconciled_at=?,state=?,updated_at=? WHERE id=? AND terms_hash=?",
      ).run(
        encrypt(JSON.stringify(loan)),
        now(),
        ["cancelled", "repaid"].includes(loan.stage) ? "closed" : "accepted",
        now(),
        id,
        value.terms_hash,
      );
      if (["cancelled", "repaid"].includes(loan.stage))
        db.prepare(
          "UPDATE financing_assignments SET state='released',released_at=? WHERE request_id=? AND state='held'",
        ).run(now(), id);
      if (
        !value.chain_ciphertext ||
        JSON.stringify(decode<ChainLoan>(value.chain_ciphertext)) !==
          JSON.stringify(loan)
      )
        event(value, userId, "chain_reconciled", {
          stage: loan.stage,
          nonce: loan.nonce,
        });
    }
    return summary(request(id), userId, !!access);
  });
}
function wallet(
  receiverId: string,
  methodName: string,
  args: object,
  deposit = "1",
  gas = "180000000000000",
): WalletTransaction {
  return {
    receiverId,
    actions: [
      { type: "FunctionCall", params: { methodName, args, gas, deposit } },
    ],
  };
}
export async function prepareFinancingAction(
  userId: string,
  id: string,
  data: unknown,
  access?: AccessContext,
): Promise<FinancingAction> {
  const input = actionInput.parse(data),
    value = access
      ? own(
          access,
          id,
          [
            "register",
            "advance",
            "cancel",
            "default",
            "dispute",
            "resume",
          ].includes(input.action),
        ).value
      : request(id);
  if (!access) visible(userId, value);
  const scope = scopeFor(value),
    frozen = termsFor(value),
    config = await configured(scope),
    chain = await chainFor(value, scope),
    selected = row<OfferRow>(
      "SELECT * FROM financing_offers WHERE id=?",
      value.accepted_offer_id!,
    )!;
  const borrowerUser = userId === value.borrower_user_id,
    lenderUser = userId === selected.lender_user_id;
  if (!borrowerUser && !lenderUser)
    throw new ApiError(
      403,
      "Only the original loan parties can sign loan actions",
      "FINANCING_PARTY_REQUIRED",
    );
  const account = borrowerUser ? frozen.terms.borrower : frozen.terms.lender;
  linked(userId, scope.network, account);
  if (input.accountId && input.accountId !== account)
    throw new ApiError(
      403,
      "The loan has an immutable participant destination",
      "FINANCING_SIGNER_MISMATCH",
    );
  if (
    ["register", "principal", "collateral", "advance"].includes(input.action)
  ) {
    const live = currentScope(value);
    if (
      !scoped(live, value.organization_id) ||
      !invited(live, selected.lender_user_id) ||
      config.paused
    )
      throw new ApiError(
        409,
        "New funding is outside the current published scope",
        "FINANCING_SCOPE_CHANGED",
      );
  }
  const actions: WalletTransaction[] = [],
    args = { loan_id: frozen.terms.id, terms_hash: frozen.hash };
  const unresolved = row<{
    id: string;
    kind: string;
    amount: string;
    deposit_id: string;
    review_hash: string;
    wallet_ciphertext: string;
  }>(
    "SELECT * FROM financing_actions WHERE request_id=? AND user_id=? AND stage='signing'",
    id,
    userId,
  );
  if (
    unresolved &&
    ["principal", "collateral", "repayment"].includes(input.action)
  ) {
    if (unresolved.kind !== input.action || unresolved.amount !== input.amount)
      throw new ApiError(
        409,
        "Reconcile or permanently void your original unresolved deposit before changing its amount or purpose",
        "FINANCING_TRANSFER_HELD",
      );
    return {
      actionId: unresolved.id,
      requestId: id,
      walletActions: decode<WalletTransaction[]>(unresolved.wallet_ciphertext),
      network: scope.network,
      eligibleSigners: [account],
      reviewHash: unresolved.review_hash,
      agreementHash: frozen.hash,
      warnings: [
        "This is the original unresolved deposit identity. Repeating it cannot credit the same loan twice. Reconcile its onchain deposit marker or permanently void it before using new deposit terms.",
      ],
    };
  }
  if (input.action === "register") {
    if (!borrowerUser || chain)
      throw new ApiError(
        409,
        "Only the original borrower can register a missing agreement",
        "FINANCING_REGISTRATION_HELD",
      );
    await borrowerTarget(value, scope);
    actions.push(
      wallet(
        scope.contract_id,
        "register_loan",
        { terms_json: frozen.json, terms_hash: frozen.hash },
        config.minimum_registration_deposit,
      ),
    );
  } else if (["principal", "collateral", "repayment"].includes(input.action)) {
    if (!chain || chain.pending)
      throw new ApiError(
        409,
        "Reconcile the existing agreement and pending transfer before funding",
        "FINANCING_PENDING",
      );
    if (
      (input.action === "principal" && !lenderUser) ||
      (input.action !== "principal" && !borrowerUser)
    )
      throw new ApiError(
        403,
        "Use the original fixed lender or borrower account for this deposit",
        "FINANCING_SIGNER_MISMATCH",
      );
    if (!input.amount || !input.depositId)
      throw new ApiError(
        422,
        "Review an exact USDC amount and stable deposit identity",
        "FINANCING_AMOUNT_REQUIRED",
      );
    const remaining =
      input.action === "principal"
        ? BigInt(frozen.terms.principal) - BigInt(chain.principal_funded)
        : input.action === "collateral"
          ? BigInt(frozen.terms.collateral) - BigInt(chain.collateral_funded)
          : debt(chain);
    if (BigInt(input.amount) > remaining || remaining <= 0n)
      throw new ApiError(
        409,
        "The deposit exceeds this loan's exact remaining amount",
        "FINANCING_OVERPAYMENT",
      );
    const tokenTarget = {
      near_account_id: scope.token_contract,
      network: scope.network,
    };
    const storage = await view<unknown>(tokenTarget, "storage_balance_of", {
      account_id: scope.contract_id,
    });
    if (!storage) {
      const bounds = await view<{ min: string }>(
        tokenTarget,
        "storage_balance_bounds",
      );
      if (!/^\d+$/.test(bounds.min))
        throw new ApiError(
          502,
          "Token storage terms are unavailable",
          "FINANCING_TOKEN_STORAGE",
        );
      actions.push(
        wallet(
          scope.token_contract,
          "storage_deposit",
          { account_id: scope.contract_id, registration_only: true },
          bounds.min,
          "20000000000000",
        ),
      );
    }
    actions.push(
      wallet(
        scope.token_contract,
        "ft_transfer_call",
        {
          receiver_id: scope.contract_id,
          amount: input.amount,
          msg: JSON.stringify({
            ...args,
            kind: input.action,
            deposit_id: input.depositId,
          }),
        },
        "1",
        "220000000000000",
      ),
    );
  } else {
    if (!chain) {
      if (input.action !== "cancel" || !borrowerUser)
        throw new ApiError(
          409,
          "Register or authoritatively reconcile the exact agreement first",
          "FINANCING_CHAIN_REQUIRED",
        );
      actions.push(
        wallet(
          scope.contract_id,
          "register_loan",
          { terms_json: frozen.json, terms_hash: frozen.hash },
          config.minimum_registration_deposit,
        ),
      );
    }
    if (input.action === "advance") {
      if (!borrowerUser)
        throw new ApiError(
          403,
          "Only the fixed borrower can advance",
          "FINANCING_BORROWER_REQUIRED",
        );
      const destination = await borrowerTarget(value, scope);
      if (destination.owner !== frozen.terms.borrower)
        throw new ApiError(
          409,
          "The treasury owner changed",
          "FINANCING_OWNER_CHANGED",
        );
    }
    const method = {
      advance: "advance",
      withdraw: "withdraw",
      cancel: "cancel",
      default: "default_loan",
      dispute: "dispute",
      resume: "resume",
      recover_advance: "recover_advance",
      void_deposit: "void_deposit",
    }[
      input.action as
        | "advance"
        | "withdraw"
        | "cancel"
        | "default"
        | "dispute"
        | "resume"
        | "recover_advance"
        | "void_deposit"
    ];
    if (!method)
      throw new ApiError(
        422,
        "Unsupported loan action",
        "FINANCING_ACTION_INVALID",
      );
    actions.push(
      wallet(
        scope.contract_id,
        method,
        {
          ...args,
          ...(input.action === "withdraw"
            ? { expected_nonce: (BigInt(chain!.nonce) + 1n).toString() }
            : {}),
          ...(input.action === "resume"
            ? { dispute_nonce: input.disputeNonce ?? chain!.dispute_nonce }
            : {}),
          ...(input.action === "recover_advance"
            ? { credit_id: input.creditId ?? null }
            : {}),
          ...(input.action === "void_deposit"
            ? { deposit_id: unresolved?.deposit_id ?? input.depositId }
            : {}),
        },
        input.action === "recover_advance" ? "0" : "1",
      ),
    );
  }
  if (input.action === "void_deposit" && !unresolved)
    throw new ApiError(
      409,
      "There is no unresolved deposit identity to void",
      "FINANCING_NO_PENDING_DEPOSIT",
    );
  const warnings = [
    "NEAR transaction data, lender accounts, exact loan amounts and repayment descriptions are public.",
    "No lender, funding, collection or creditworthiness guarantee. Fees are fixed contractual amounts, not an annualized rate.",
    "Repayments use only the fixed borrower's own wallet. This contract cannot debit payroll, client reserves or unrelated treasury funds.",
    "An unresolved transfer stays held. A timeout or wallet hash never releases cash or authorizes a second advance.",
    "Razor receivable exclusivity cannot establish lien priority or collect off-platform invoices.",
  ];
  if (access)
    own(
      access,
      id,
      [
        "register",
        "advance",
        "cancel",
        "default",
        "dispute",
        "resume",
      ].includes(input.action),
    );
  linked(userId, scope.network, account);
  if (
    ["register", "principal", "collateral", "advance"].includes(input.action)
  ) {
    const latest = currentScope(value);
    if (!invited(latest, selected.lender_user_id))
      throw new ApiError(
        409,
        "The invited lender scope changed during review",
        "FINANCING_SCOPE_CHANGED",
      );
  }
  const reviewHash = hash({ id, termsHash: frozen.hash, actions, account });
  let actionId: string | undefined;
  if (["principal", "collateral", "repayment"].includes(input.action)) {
    actionId = randomUUID();
    getDb()
      .prepare(
        "DELETE FROM financing_actions WHERE request_id=? AND user_id=? AND stage='review' AND deposit_id!=?",
      )
      .run(id, userId, input.depositId!);
    getDb()
      .prepare(
        "INSERT INTO financing_actions(id,request_id,user_id,kind,amount,deposit_id,review_hash,wallet_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id,deposit_id) DO NOTHING",
      )
      .run(
        actionId,
        id,
        userId,
        input.action,
        input.amount!,
        input.depositId!,
        reviewHash,
        encrypt(JSON.stringify(actions)),
        now(),
        now(),
      );
    const saved = row<{ id: string; review_hash: string; user_id: string }>(
      "SELECT id,review_hash,user_id FROM financing_actions WHERE request_id=? AND deposit_id=?",
      id,
      input.depositId!,
    )!;
    if (saved.user_id !== userId || saved.review_hash !== reviewHash)
      throw new ApiError(
        409,
        "This deposit identity already names different immutable terms",
        "FINANCING_DEPOSIT_CONFLICT",
      );
    actionId = saved.id;
  }
  return {
    actionId,
    requestId: id,
    walletActions: actions,
    network: scope.network,
    eligibleSigners: [account],
    reviewHash,
    agreementHash: frozen.hash,
    warnings,
  };
}
export function debt(loan: ChainLoan) {
  return (
    BigInt(loan.terms.principal) -
    BigInt(loan.principal_paid) +
    BigInt(loan.terms.interest) -
    BigInt(loan.interest_paid) +
    BigInt(loan.terms.fee) -
    BigInt(loan.fee_paid)
  );
}
export async function financingAdvanceEvidence(
  access: AccessContext,
  id: string,
  data: unknown,
) {
  const { value } = own(access, id),
    input = z
      .object({
        transactionHash: z.string().min(32).max(64),
        signerAccount: z.string().min(2).max(64),
      })
      .strict()
      .parse(data),
    scope = scopeFor(value),
    loan = await chainFor(value, scope);
  if (!loan || loan.advanced !== loan.terms.principal)
    throw new ApiError(
      409,
      "A conclusively advanced matching loan is required",
      "FINANCING_ADVANCE_UNVERIFIED",
    );
  const config = treasury(value, scope),
    proof = await verifyTokenReceipt(
      config,
      input.transactionHash,
      input.signerAccount,
      scope.treasury_id,
      loan.terms.principal,
    );
  if (proof.events.some((event) => event.sender !== scope.contract_id))
    throw new ApiError(
      409,
      "The loan escrow did not supply this treasury deposit",
      "FINANCING_ADVANCE_UNVERIFIED",
    );
  const credit = await verifySharedDeposit(
    config,
    proof,
    `loan:${value.loan_id}`,
  );
  await configured(scope);
  if (
    (await contractCodeHash(config)) !==
    reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")
  )
    throw new ApiError(
      409,
      "The treasury code identity changed while verifying financing credit",
      "FINANCING_TREASURY_MISMATCH",
    );
  const receiptIdentity = tokenReceiptIdentity(proof),
    evidence = {
      loanId: value.loan_id,
      agreementHash: value.terms_hash,
      proof,
      credit,
      classification: "financing_liability_not_revenue",
    };
  const assertCurrent = () => {
    const fresh = own(access, id),
      latest = treasury(fresh.value, scope);
    if (
      fresh.value.terms_hash !== value.terms_hash ||
      fresh.value.loan_id !== value.loan_id ||
      latest.company_id !== config.company_id ||
      latest.near_account_id !== config.near_account_id ||
      latest.token_contract !== config.token_contract ||
      latest.network !== config.network
    )
      throw new ApiError(
        409,
        "Company permissions, accepted agreement or treasury identity changed during verification",
        "FINANCING_CREDIT_REVIEW_CHANGED",
      );
    return fresh;
  };
  const recorded = transaction((db) => {
    assertCurrent();
    const previous = row<{
      receipt_identity: string;
      amount: string;
      credit_id: string;
      company_id: string;
      sender_id: string;
    }>(
      "SELECT receipt_identity,amount,credit_id,company_id,sender_id FROM financing_advance_credits WHERE request_id=?",
      id,
    );
    if (previous) {
      if (
        previous.receipt_identity !== receiptIdentity ||
        previous.amount !== loan.terms.principal ||
        previous.credit_id !== credit.credit_id ||
        previous.company_id !== config.company_id ||
        previous.sender_id !== scope.contract_id
      )
        throw new ApiError(
          409,
          "A different immutable receipt already names this loan advance",
          "FINANCING_CREDIT_CONFLICT",
        );
      return { replayed: true };
    }
    db.prepare(
      "INSERT INTO financing_advance_credits(request_id,organization_id,network,treasury_id,company_id,credit_id,token_contract,sender_id,amount,receipt_identity,transaction_hash,metadata_ciphertext,verified_by,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      value.organization_id,
      scope.network,
      scope.treasury_id,
      config.company_id!,
      credit.credit_id,
      scope.token_contract,
      scope.contract_id,
      loan.terms.principal,
      receiptIdentity,
      input.transactionHash,
      encrypt(JSON.stringify(evidence)),
      access.userId,
      now(),
    );
    event(value, access.userId, "advance_credit_verified", {
      loanId: value.loan_id,
      creditId: credit.credit_id,
      receiptIdentity,
      classification: "financing_liability_not_revenue",
    });
    return { replayed: false };
  });
  const fresh = assertCurrent(),
    synced = await syncTreasury(fresh.live);
  assertCurrent();
  return {
    requestId: value.id,
    loanId: value.loan_id,
    termsHash: value.terms_hash,
    receiptIdentity,
    classification: "financing_liability",
    companyId: config.company_id,
    amount: loan.terms.principal,
    fundingReference: `loan:${value.loan_id}`,
    creditId: credit.credit_id,
    recorded: true,
    replayed: recorded.replayed,
    treasury: synced,
  };
}

export function beginFinancingAction(
  userId: string,
  id: string,
  data: unknown,
  access?: AccessContext,
) {
  const input = z
      .object({
        actionId: z.string().uuid(),
        reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
        signerAccount: z.string().min(2).max(64),
      })
      .strict()
      .parse(data),
    value = access ? own(access, id).value : request(id);
  if (!access) visible(userId, value);
  const scope = scopeFor(value),
    frozen = termsFor(value),
    selected = row<OfferRow>(
      "SELECT * FROM financing_offers WHERE id=?",
      value.accepted_offer_id!,
    )!,
    account =
      userId === value.borrower_user_id
        ? frozen.terms.borrower
        : userId === selected.lender_user_id
          ? frozen.terms.lender
          : null;
  if (!account || input.signerAccount !== account)
    throw new ApiError(
      403,
      "The actual wallet signer must match the fixed loan participant",
      "FINANCING_SIGNER_MISMATCH",
    );
  linked(userId, scope.network, account);
  return transaction((db) => {
    const action = row<{
      id: string;
      review_hash: string;
      stage: string;
      kind: string;
    }>(
      "SELECT id,review_hash,stage,kind FROM financing_actions WHERE id=? AND request_id=? AND user_id=?",
      input.actionId,
      id,
      userId,
    );
    if (
      !action ||
      action.review_hash !== input.reviewHash ||
      !["review", "signing"].includes(action.stage)
    )
      throw new ApiError(
        409,
        "This exact loan deposit review changed or was already observed",
        "FINANCING_REVIEW_CHANGED",
      );
    if (action.kind !== "repayment") {
      const active = currentScope(value);
      if (!invited(active, selected.lender_user_id))
        throw new ApiError(
          409,
          "The financing operating scope changed",
          "FINANCING_SCOPE_CHANGED",
        );
    }
    if (
      row(
        "SELECT id FROM financing_actions WHERE request_id=? AND user_id=? AND stage='signing' AND id!=?",
        id,
        userId,
        action.id,
      )
    )
      throw new ApiError(
        409,
        "Reconcile the original unresolved deposit before another wallet request",
        "FINANCING_TRANSFER_HELD",
      );
    db.prepare(
      "UPDATE financing_actions SET stage='signing',updated_at=? WHERE id=?",
    ).run(now(), action.id);
    if (action.stage !== "signing")
      event(value, userId, "deposit_signing", { actionId: action.id });
    return { claimed: true };
  });
}
export function withdrawFinancingOffer(
  userId: string,
  id: string,
  offerId: string,
) {
  const value = request(id);
  visible(userId, value);
  return transaction((db) => {
    const changed = db
      .prepare(
        "UPDATE financing_offers SET state='withdrawn' WHERE id=? AND request_id=? AND lender_user_id=? AND state='proposed'",
      )
      .run(offerId, id, userId);
    if (changed.changes !== 1)
      throw new ApiError(
        409,
        "Only your own unaccepted offer can be withdrawn",
        "FINANCING_OFFER_LOCKED",
      );
    event(value, userId, "offer_withdrawn", { offerId });
    return { withdrawn: true };
  });
}
export function cancelOpenFinancingRequest(access: AccessContext, id: string) {
  const { live, value } = own(access, id, true);
  if (value.state !== "open" || value.terms_hash)
    throw new ApiError(
      409,
      "An accepted or potentially signed loan needs onchain cancellation",
      "FINANCING_CANCELLATION_HELD",
    );
  getDb()
    .prepare(
      "UPDATE financing_requests SET state='closed',updated_at=? WHERE id=? AND state='open' AND terms_hash IS NULL",
    )
    .run(now(), id);
  event(value, live.userId, "open_request_withdrawn");
  return { withdrawn: true };
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertFeature } from "../billing/entitlements";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { audit, getAccess } from "../identity/session";
import { nearTransactionStatus } from "../payments/near";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import { hash } from "./algorithm";
import { finalContext, readiness, roundEvidence, settings, verifyRegistration } from "./chain";
import { assertCashProgress, assertCashState, assertCashTerms, cashAmount, cashTerms, fundedMode, type StoredCashAccount } from "./funded-model";
import { fundingMessage, inspectCashDeposit } from "./funded-receipts";
import { assertRoundTerms, previewRoundSelection, registration, type PreviewInput } from "./service";
import type { CashAccount, CashDeposit, CashState, ChainRound, FinalEvidence, Manifest, Round } from "./types";

const now = () => new Date().toISOString();
const operations = ["register", "consent", "finalize", "revoke", "expire", "fund", "credit", "refund", "storage"] as const;
type Operation = typeof operations[number];
const amountInput = z.string().refine(value => { try { cashAmount(value, false); return true; } catch { return false; } });
export const fundedActionInput = z.object({ manifestHash: z.string().regex(/^[a-f0-9]{64}$/), operation: z.enum(operations), amount: amountInput.optional() }).strict();
interface WalletRequest { id: string; round_id: string; organization_id: string; user_id: string; operation: Operation; identity_key: string; amount: string | null; expected_nonce: string | null; actions_ciphertext: string; state: "prepared" | "unknown" | "resolved"; review_generation: string; review_hash: string; review_expires_at: string; review_consumed: number; wallet_lease_generation: string | null; wallet_lease_expires_at: string | null; source_transaction_hash: string | null }
function accessFor(access: AccessContext, write = false, allowPaused = false) {
  const live = getAccess(access.userId, access.organizationId);
  for (const permission of ["company:read", "payments:read", ...(write ? ["company:manage", "payments:approve"] : [])]) requirePermission(live, permission);
  const company = row<{ owner_id: string; paused: number }>("SELECT owner_id,paused FROM organizations WHERE id=?", live.organizationId)!;
  if (write && company.owner_id !== live.userId) throw new ApiError(403, "Only the current company owner can authorize fixed-owner escrow actions", "CLEARING_OWNER_REQUIRED");
  if (write && !allowPaused && company.paused) throw new ApiError(409, "Company payments are paused", "PAYMENTS_PAUSED");
  return live;
}
function roundFor(access: AccessContext, id: string) {
  const found = row<Round>("SELECT r.* FROM clearing_rounds r JOIN clearing_round_participants p ON p.round_id=r.id WHERE r.id=? AND p.organization_id=? AND r.mode='cash_backed_native_v1'", id, access.organizationId);
  if (!found) throw new ApiError(404, "Cash-backed clearing round not found for this company", "FUNDED_CLEARING_NOT_FOUND"); return found;
}
function manifestFor(round: Round) {
  const manifest = JSON.parse(round.manifest_json) as Manifest;
  if (hash(round.manifest_json) !== round.manifest_hash || manifest.id !== round.id || !manifest.cash) throw new ApiError(409, "Review the original exact cash-clearing commitment", "FUNDED_CLEARING_TERMS_CHANGED");
  assertCashTerms(manifest, round.network, manifest.cash.token_contract); return manifest;
}
function accountFor(roundId: string, companyId: string) { return row<StoredCashAccount>("SELECT * FROM clearing_funded_accounts WHERE round_id=? AND organization_id=?", roundId, companyId)!; }
function action(receiverId: string, methodName: string, args: object, deposit = "1", gas = "180000000000000"): WalletTransaction { return { receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, deposit, gas } }] }; }

export function previewFundedRound(access: AccessContext, input: PreviewInput) {
  const live = accessFor(access, true), preview = previewRoundSelection(live, input, true), first = registration(preview.reviewed.participants[0].company_id);
  const cash = cashTerms(preview.reviewed, preview.network, first.token_contract), reviewed = { ...preview.reviewed, cash };
  return { reviewed, linkIds: preview.linkIds, reviewToken: hash(reviewed), network: preview.network, fullObligationValue: preview.originalInvoiceValue, totalEscrowRequired: cash.positions.reduce((sum, party) => sum + BigInt(party.deposit_due), 0n).toString(), positions: cash.positions,
    warning: "All selected obligations are retired only after exact owner consents and verified full net-debtor funding. Credit rights stay in clearing escrow until withdrawn to frozen owner wallets. No employee wages or spendable shared treasury cash are created." };
}
export function createFundedRound(access: AccessContext, input: PreviewInput & { reviewToken: string }) {
  const live = accessFor(access, true); assertFeature(live, "clearing"); const config = settings();
  return transaction(db => {
    const preview = previewFundedRound(live, input);
    if (preview.reviewToken !== input.reviewToken || preview.network !== config.network) throw new ApiError(409, "The exact cash-backed clearing proposal changed", "FUNDED_CLEARING_REVIEW_STALE");
    const id = randomUUID(), manifest: Manifest = { id, ...preview.reviewed }, json = JSON.stringify(manifest);
    db.prepare("INSERT INTO clearing_rounds(id,manifest_hash,manifest_json,mode,network,contract_id,created_by,created_at,expires_at) VALUES(?,?,?,'cash_backed_native_v1',?,?,?,?,?)").run(id, hash(json), json, config.network, config.contractId, live.userId, now(), input.expiresAt);
    for (const party of manifest.participants) db.prepare("INSERT INTO clearing_round_participants(round_id,organization_id) VALUES(?,?)").run(id, party.company_id);
    for (const linkId of preview.linkIds) {
      const link = row<{ bill_id: string; payment_id: string }>("SELECT bill_id,payment_id FROM clearing_links WHERE id=?", linkId)!;
      db.prepare("INSERT INTO clearing_round_links(round_id,link_id,bill_id,payment_id) VALUES(?,?,?,?)").run(id, linkId, link.bill_id, link.payment_id);
    }
    for (const party of manifest.cash!.positions) db.prepare("INSERT INTO clearing_funded_accounts(round_id,organization_id,destination,deposit_due,credit_due) VALUES(?,?,?,?,?)").run(id, party.company_id, party.destination, party.deposit_due, party.credit_due);
    audit(live.userId, live.organizationId, "funded_clearing.proposed", id, { manifestHash: hash(json), totalEscrowRequired: preview.totalEscrowRequired }); return fundedRoundDetail(live, id);
  });
}
export function fundedRoundDetail(access: AccessContext, id: string) {
  const live = accessFor(access), round = roundFor(live, id), manifest = manifestFor(round);
  const proof = round.proof_ciphertext ? JSON.parse(decrypt(round.proof_ciphertext)) as FinalEvidence : null;
  const verifiedDeposits = rows<{ organization_id: string; deposit_id: string; submitted: string; accepted: string; unused: string; source_transaction_hash: string; verified_at: string }>("SELECT organization_id,deposit_id,submitted,accepted,unused,source_transaction_hash,verified_at FROM clearing_funded_deposits WHERE round_id=? ORDER BY organization_id,deposit_id", id);
  const unverifiedDeposits = proof?.round?.cash?.deposits.filter(deposit => !verifiedDeposits.some(value => value.organization_id === deposit.company_id && value.deposit_id === deposit.deposit_id)) ?? [];
  return { ...round, proof_ciphertext: undefined, optimization_json: undefined, manifest, proof, locallyDiscarded: round.status === "revoked" && !round.proof_ciphertext,
    accounts: rows<StoredCashAccount & { organization_id: string; observed_block_hash: string | null }>("SELECT * FROM clearing_funded_accounts WHERE round_id=? ORDER BY organization_id", id).map(value => ({ ...value, pending: value.pending_json ? JSON.parse(value.pending_json) as CashAccount["pending"] : null, lastTransfer: value.last_transfer_json ? JSON.parse(value.last_transfer_json) as CashAccount["last_transfer"] : null })),
    verifiedDeposits, unverifiedDeposits,
    walletRequests: rows<WalletRequest>("SELECT * FROM clearing_funded_wallet_requests WHERE round_id=? AND organization_id=? ORDER BY created_at DESC LIMIT 25", id, live.organizationId).map(({ actions_ciphertext: _actions, ...value }) => value),
    accountingBoundary: "Whole selected invoice liabilities become separately recorded escrow-backed company credit rights. These are not noncash debt setoff, delivered employee payments, profit, shared treasury balances or automatically withdrawable bank funds." };
}
export function fundedOverview(access: AccessContext, page = 1) {
  const live = accessFor(access), bounded = Math.max(1, Math.min(100000, page));
  const ids = rows<{ id: string }>("SELECT r.id FROM clearing_rounds r JOIN clearing_round_participants p ON p.round_id=r.id WHERE p.organization_id=? AND r.mode='cash_backed_native_v1' ORDER BY r.created_at DESC,r.id LIMIT 25 OFFSET ?", live.organizationId, (bounded - 1) * 25);
  return { rounds: ids.map(value => fundedRoundDetail(live, value.id)), page: bounded, hasMore: !!row("SELECT r.id FROM clearing_rounds r JOIN clearing_round_participants p ON p.round_id=r.id WHERE p.organization_id=? AND r.mode='cash_backed_native_v1' LIMIT 1 OFFSET ?", live.organizationId, bounded * 25), setup: readiness(), companyId: live.organizationId };
}
export function discardFundedProposal(access: AccessContext, id: string) {
  return transaction(db => {
    const live = accessFor(access); requirePermission(live, "company:manage");
    if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", live.organizationId, live.userId)) throw new ApiError(403, "The current company owner can discard an unsigned proposal", "CLEARING_OWNER_REQUIRED");
    const current = roundFor(live, id);
    if (current.status !== "prepared" || current.proof_ciphertext || row("SELECT round_id FROM clearing_funded_accounts WHERE round_id=? AND (observed_height!='0' OR deposited!='0' OR pending_json IS NOT NULL)", id)
      || row("SELECT id FROM clearing_funded_wallet_requests WHERE round_id=? AND (review_consumed=1 OR state='unknown' OR source_transaction_hash IS NOT NULL OR wallet_lease_generation IS NOT NULL)", id)) throw new ApiError(409, "Registration signing or authoritative escrow evidence already exists. Keep its exact invoice locks until onchain revocation or expiry is verified", "FUNDED_CLEARING_SOURCE_HELD");
    const changed = db.prepare("UPDATE clearing_rounds SET status='revoked',cash_checked_at=? WHERE id=? AND mode='cash_backed_native_v1' AND status='prepared' AND proof_ciphertext IS NULL AND NOT EXISTS(SELECT 1 FROM clearing_funded_wallet_requests w WHERE w.round_id=clearing_rounds.id AND (w.review_consumed=1 OR w.state='unknown' OR w.source_transaction_hash IS NOT NULL OR w.wallet_lease_generation IS NOT NULL))").run(now(), id);
    if (changed.changes !== 1) throw new ApiError(409, "A wallet request began while discarding this proposal. Its original locks remain held", "FUNDED_CLEARING_SOURCE_HELD");
    db.prepare("UPDATE clearing_funded_wallet_requests SET state='resolved',updated_at=? WHERE round_id=? AND review_consumed=0 AND state='prepared'").run(now(), id);
    audit(live.userId, live.organizationId, "funded_clearing.local_proposal_discarded", id, { mode: fundedMode, onchainRevocation: false, noWalletAuthorization: true, invoiceLocksReleased: true, identityRetired: true });
    return { ...fundedRoundDetail(live, id), localDiscarded: true, onchainTransactionRequired: false };
  });
}
function assertSources(round: Round, state: CashState) {
  for (const deposit of state.deposits) {
    const verified = row<{ submitted: string; accepted: string; unused: string; proof_ciphertext: string }>("SELECT submitted,accepted,unused,proof_ciphertext FROM clearing_funded_deposits WHERE round_id=? AND organization_id=? AND deposit_id=?", round.id, deposit.company_id, deposit.deposit_id);
    const proof = verified ? JSON.parse(decrypt(verified.proof_ciphertext)) as { deposit: CashDeposit } : null;
    if (!verified || !proof?.deposit || (["deposit_id", "company_id", "sender_id", "submitted", "accepted", "unused", "accepted_at_ms", "accepted_height"] as const).some(key => proof.deposit[key] !== deposit[key])) throw new ApiError(409, "Each accepted escrow deposit needs its original final native-USDC source receipt before finalization or invoice discharge", "FUNDED_CLEARING_SOURCES_REQUIRED");
  }
}
async function verifyUnusedOriginalSources(context: Awaited<ReturnType<typeof finalContext>>, manifest: Manifest) {
  for (let offset = 0; offset < manifest.obligations.length; offset += 4) {
    await Promise.all(manifest.obligations.slice(offset, offset + 4).map(async edge => {
      const party = manifest.participants.find(party => party.company_id === edge.debtor)!;
      const [payment, obligation] = await Promise.all([context.view<unknown>(party.treasury_id, "get_payment", { company_id: party.treasury_company_id, payment_id: edge.id }), context.view<unknown>(party.treasury_id, "get_obligation", { company_id: party.treasury_company_id, reference: `razor:${edge.id}` })]);
      if (payment || obligation) throw new ApiError(409, "An original shared-treasury payment or source identity exists. Resolve its source uncertainty before cash clearing", "FUNDED_CLEARING_ORIGINAL_SOURCE_BUSY");
    }));
  }
}
function updateCashObservation(round: Round, chain: ChainRound, state: CashState, height: string, blockHash: string) {
  if (state.deposits.some(deposit => BigInt(deposit.accepted_height) > BigInt(height))) throw new ApiError(409, "The deposit evidence belongs to a later block than this custody observation", "FUNDED_CLEARING_OBSERVATION_STALE");
  for (const account of state.accounts) assertCashProgress(accountFor(round.id, account.company_id), account, state.stage, height);
  const db = getDb();
  for (const account of state.accounts) {
    const dbUpdate = "UPDATE clearing_funded_accounts SET deposited=?,credit_available=?,credit_paid=?,refund_available=?,refund_paid=?,nonce=?,pending_json=?,last_transfer_json=?,observed_height=?,observed_block_hash=?,stage=? WHERE round_id=? AND organization_id=?";
    db.prepare(dbUpdate).run(account.deposited, account.credit_available, account.credit_paid, account.refund_available, account.refund_paid, account.nonce, account.pending ? JSON.stringify(account.pending) : null, account.last_transfer ? JSON.stringify(account.last_transfer) : null, height, blockHash, state.stage, round.id, account.company_id);
    for (const request of rows<WalletRequest>("SELECT * FROM clearing_funded_wallet_requests WHERE round_id=? AND organization_id=? AND state!='resolved'", round.id, account.company_id)) {
      const complete = request.operation === "fund" ? state.deposits.some(deposit => deposit.company_id === account.company_id && deposit.deposit_id === request.identity_key)
        : request.operation === "register" ? true : request.operation === "consent" ? chain.consents.includes(account.company_id)
        : request.operation === "finalize" ? chain.status === "finalized" : request.operation === "revoke" || request.operation === "expire" ? ["revoked", "expired", "rejected"].includes(chain.status)
        : ["credit", "refund"].includes(request.operation) && request.expected_nonce ? BigInt(account.nonce) > BigInt(request.expected_nonce) || account.last_transfer?.nonce === request.expected_nonce : false;
      if (complete) db.prepare("UPDATE clearing_funded_wallet_requests SET state='resolved',wallet_lease_generation=NULL,wallet_lease_expires_at=NULL,updated_at=? WHERE id=?").run(now(), request.id);
    }
  }
}

export async function reconcileFundedRound(access: AccessContext, id: string) {
  const live = accessFor(access), before = roundFor(live, id), evidence = await roundEvidence(id);
  if (evidence.round?.status === "finalized" && before.status !== "cleared") {
    const height = Number(evidence.round.finalized_height);
    if (!Number.isSafeInteger(height) || height <= 0) throw new ApiError(409, "The exact finalization height must be verified", "FUNDED_CLEARING_PROOF_INVALID");
    await verifyUnusedOriginalSources(await finalContext(height), manifestFor(before));
  }
  return transaction(db => {
    accessFor(live); const round = roundFor(live, id), manifest = manifestFor(round), chain = evidence.round, config = settings();
    if (round.manifest_hash !== before.manifest_hash || evidence.network !== round.network || evidence.contractId !== round.contract_id || evidence.codeHash !== config.codeHash) throw new ApiError(409, "Cash-clearing deployment or commitment changed", "FUNDED_CLEARING_PROOF_INVALID");
    if (!chain) {
      if (rows<{ observed_height: string }>("SELECT observed_height FROM clearing_funded_accounts WHERE round_id=?", id).some(value => value.observed_height !== "0")) throw new ApiError(409, "The RPC omitted an already observed escrow. Existing rights and unknown requests remain held", "FUNDED_CLEARING_OBSERVATION_STALE");
      if (BigInt(evidence.timestampMs) >= BigInt(manifest.expires_at_ms) && ["prepared", "registered"].includes(round.status)) db.prepare("UPDATE clearing_rounds SET status='expired',proof_ciphertext=? WHERE id=?").run(encrypt(JSON.stringify(evidence)), id);
      return fundedRoundDetail(live, id);
    }
    if (chain.manifest_json !== round.manifest_json || chain.hash !== round.manifest_hash || hash(chain.manifest_json) !== round.manifest_hash) throw new ApiError(409, "The final escrow belongs to another exact manifest", "FUNDED_CLEARING_TERMS_CHANGED");
    const state = assertCashState(manifest, chain.cash);
    updateCashObservation(round, chain, state, evidence.blockHeight, evidence.blockHash);
    if (round.status === "cleared") { db.prepare("UPDATE clearing_rounds SET proof_ciphertext=? WHERE id=?").run(encrypt(JSON.stringify(evidence)), id); return fundedRoundDetail(live, id); }
    if (["revoked", "expired", "rejected"].includes(chain.status)) { db.prepare("UPDATE clearing_rounds SET status=?,proof_ciphertext=? WHERE id=? AND status IN ('prepared','registered')").run(chain.status, encrypt(JSON.stringify(evidence)), id); return fundedRoundDetail(live, id); }
    if (chain.status !== "finalized") { db.prepare("UPDATE clearing_rounds SET status='registered',proof_ciphertext=? WHERE id=? AND status='prepared'").run(encrypt(JSON.stringify(evidence)), id); return fundedRoundDetail(live, id); }
    if (!["prepared", "registered"].includes(round.status) || state.stage !== "credits" || !chain.finalized_height || !chain.finalized_at_ms || BigInt(chain.finalized_at_ms) < BigInt(manifest.starts_at_ms) || BigInt(chain.finalized_at_ms) >= BigInt(manifest.expires_at_ms)
      || chain.consents.length !== manifest.participants.length || new Set(chain.consents).size !== manifest.participants.length || !manifest.participants.every(party => chain.consents.includes(party.company_id)) || state.accounts.some(account => account.deposited !== account.deposit_due)
      || !evidence.authority?.blockHash || evidence.authority.blockHeight !== chain.finalized_height || hash(evidence.authority.participants) !== hash(manifest.participants.map(party => ({ companyId: party.company_id, treasuryId: party.treasury_id, treasuryCompanyId: party.treasury_company_id, ownerId: party.owner_id, policyVersion: party.policy_version })))) throw new ApiError(409, "Exact full cash backing, finalization and company authority must be verified before discharge", "FUNDED_CLEARING_FINALIZATION_UNVERIFIED");
    try { assertSources(round, state); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "FUNDED_CLEARING_SOURCES_REQUIRED") throw error;
      db.prepare("UPDATE clearing_rounds SET status='registered',proof_ciphertext=? WHERE id=? AND status IN ('prepared','registered')").run(encrypt(JSON.stringify(evidence)), id);
      return fundedRoundDetail(live, id);
    }
    const { links } = assertRoundTerms(round, Number(chain.finalized_at_ms));
    db.prepare("UPDATE clearing_rounds SET status='applying' WHERE id=? AND status IN ('prepared','registered')").run(id);
    for (const link of links) {
      const amount = manifest.obligations.find(edge => edge.id === link.payment_id)!.original, stamp = now();
      db.prepare("UPDATE payments SET status='cancelled',hold_reason='Original business liability retired into separately recorded funded escrow rights; no delivered payroll or treasury credit',updated_at=? WHERE id=?").run(stamp, link.payment_id);
      const bill = row<{ funded_clearing_amount: string }>("SELECT funded_clearing_amount FROM bills WHERE id=?", link.bill_id)!;
      db.prepare("UPDATE bills SET funded_clearing_amount=?,payment_id=NULL,status='cleared',accepted_at=NULL,updated_at=? WHERE id=?").run((BigInt(bill.funded_clearing_amount) + BigInt(amount)).toString(), stamp, link.bill_id);
      db.prepare("INSERT INTO clearing_funded_discharges(id,round_id,link_id,organization_id,bill_id,original_payment_id,amount,mode,manifest_hash,proof_block_hash,proof_block_height,created_at) VALUES(?,?,?,?,?,?,?,'cash_backed_native_v1',?,?,?,?)").run(randomUUID(), id, link.id, link.debtor_id, link.bill_id, link.payment_id, amount, round.manifest_hash, evidence.blockHash, evidence.blockHeight, stamp);
      db.prepare("UPDATE clearing_links SET status='cleared' WHERE id=?").run(link.id);
    }
    db.prepare("UPDATE clearing_rounds SET status='cleared',proof_ciphertext=?,applied_at=? WHERE id=?").run(encrypt(JSON.stringify(evidence)), now(), id);
    audit(live.userId, live.organizationId, "funded_clearing.escrow_rights_recorded", id, { manifestHash: round.manifest_hash, mode: fundedMode, noTreasuryCredit: true, noPayrollDelivery: true }); return fundedRoundDetail(live, id);
  });
}

export async function verifyFundedDeposit(access: AccessContext, id: string, depositId: string, transactionHash: string) {
  const live = accessFor(access, true, true), round = roundFor(live, id), manifest = manifestFor(round);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(transactionHash) || !depositId || depositId.length > 128) throw new ApiError(422, "Choose the original deposit ID and NEAR transaction hash", "FUNDED_CLEARING_RECEIPT_INVALID");
  const context = await finalContext(), chain = await context.view<ChainRound | null>(round.contract_id, "get_round", { round_id: id });
  if (context.config.contractId !== round.contract_id || context.config.network !== round.network || chain?.hash !== round.manifest_hash || chain.manifest_json !== round.manifest_json) throw new ApiError(409, "The exact deposited round could not be verified", "FUNDED_CLEARING_TERMS_CHANGED");
  const cash = assertCashState(manifest, chain.cash), deposit = cash.deposits.find(value => value.company_id === live.organizationId && value.deposit_id === depositId);
  if (!deposit) throw new ApiError(409, "The clearing contract has not accepted this company deposit. A wallet reference alone is not backing", "FUNDED_CLEARING_DEPOSIT_NOT_ACCEPTED");
  const target = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", live.organizationId)!;
  const proof = inspectCashDeposit(await nearTransactionStatus(target, transactionHash, deposit.sender_id), { transactionHash, token: manifest.cash!.token_contract, clearing: round.contract_id, roundId: id, manifestHash: round.manifest_hash, deposit });
  return transaction(db => {
    accessFor(live, true, true); const current = roundFor(live, id);
    if (current.manifest_hash !== round.manifest_hash) throw new ApiError(409, "The deposit review changed", "FUNDED_CLEARING_TERMS_CHANGED");
    const existing = row<{ source_transaction_hash: string }>("SELECT source_transaction_hash FROM clearing_funded_deposits WHERE round_id=? AND organization_id=? AND deposit_id=?", id, live.organizationId, depositId);
    if (existing && existing.source_transaction_hash !== transactionHash) throw new ApiError(409, "This accepted deposit already has another verified original source. A duplicate retry is not its original funding", "FUNDED_CLEARING_SOURCE_CONFLICT");
    db.prepare("INSERT OR IGNORE INTO clearing_funded_deposits(round_id,organization_id,deposit_id,submitted,accepted,unused,source_transaction_hash,source_receipt_id,proof_ciphertext,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, live.organizationId, depositId, deposit.submitted, deposit.accepted, deposit.unused, transactionHash, proof.sourceReceiptId, encrypt(JSON.stringify(proof)), now());
    audit(live.userId, live.organizationId, "funded_clearing.deposit_source_verified", id, { depositId, accepted: deposit.accepted, unused: deposit.unused, transactionHash }); return { verified: true, deposit, transactionHash };
  });
}

async function actionPlan(access: AccessContext, id: string, input: z.infer<typeof fundedActionInput>, previous?: WalletRequest) {
  const recovery = ["revoke", "expire", "credit", "refund", "storage"].includes(input.operation), live = accessFor(access, true, recovery), round = roundFor(live, id), manifest = manifestFor(round), party = manifest.participants.find(value => value.company_id === live.organizationId)!;
  if (input.manifestHash !== round.manifest_hash) throw new ApiError(409, "Review the exact cash-clearing manifest", "FUNDED_CLEARING_REVIEW_STALE");
  const context = await finalContext();
  if (context.config.contractId !== round.contract_id || context.config.network !== round.network || context.clearing.state_version !== 3 || context.clearing.cash_network !== round.network || context.clearing.max_cash_deposits_per_company !== 8 || context.clearing.token_contract !== manifest.cash!.token_contract) throw new ApiError(409, "The reviewed native-USDC cash escrow mode must be enabled on this deployment", "FUNDED_CLEARING_SETUP_REQUIRED");
  const chain = await context.view<ChainRound | null>(round.contract_id, "get_round", { round_id: id });
  if (chain && (chain.hash !== round.manifest_hash || chain.manifest_json !== round.manifest_json)) throw new ApiError(409, "The onchain cash commitment changed", "FUNDED_CLEARING_TERMS_CHANGED");
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND network=? AND address=?", live.userId, round.network, party.owner_id)) throw new ApiError(403, "Link the frozen company owner wallet for this exact escrow action", "FUNDED_CLEARING_SIGNER_REQUIRED");
  if (!recovery) {
    if (!["prepared", "registered"].includes(round.status)) throw new ApiError(409, "This local proposal identity is permanently closed. Review a new proposal for any unchanged original invoices", "FUNDED_CLEARING_ROUND_CLOSED");
    if (context.clearing.paused || BigInt(context.timestampMs) >= BigInt(manifest.expires_at_ms)) throw new ApiError(409, "New cash funding and consent are paused or past the fixed deadline", "FUNDED_CLEARING_WINDOW_CLOSED");
    assertRoundTerms(round); await Promise.all(manifest.participants.map(party => verifyRegistration(context, registration(party.company_id))));
    await verifyUnusedOriginalSources(context, manifest);
  }
  const state = chain ? assertCashState(manifest, chain.cash) : null, mine = state?.accounts.find(value => value.company_id === live.organizationId), identity = previous?.identity_key ?? (input.operation === "fund" ? randomUUID() : input.operation), actions: WalletTransaction[] = [];
  let operation = input.operation, amount = previous?.amount ?? null, nonce = previous?.expected_nonce ?? null, complete = false, destinationRegistered: boolean | undefined;
  if (operation === "register") {
    complete = !!chain;
    if (!complete) { const cost = await context.view<string>(round.contract_id, "registration_cost", { manifest_json: round.manifest_json }); cashAmount(cost, false); actions.push(action(round.contract_id, "register_round", { manifest_json: round.manifest_json, manifest_hash: round.manifest_hash }, cost)); }
  } else if (operation === "consent") {
    if (!chain || chain.status !== "ready") throw new ApiError(409, "Wait for the reviewed round to be ready before owner consent", "FUNDED_CLEARING_NOT_READY");
    complete = chain.consents.includes(live.organizationId); if (!complete) actions.push(action(round.contract_id, "consent", { round_id: id, manifest_hash: round.manifest_hash, company_id: live.organizationId }));
  } else if (operation === "finalize") {
    complete = chain?.status === "finalized";
    if (!complete) {
      if (!chain || chain.status !== "ready" || !state || !manifest.participants.every(party => chain.consents.includes(party.company_id)) || chain.consents.length !== manifest.participants.length || state.accounts.some(account => account.deposited !== account.deposit_due) || BigInt(context.timestampMs) < BigInt(manifest.starts_at_ms)) throw new ApiError(409, "All exact company consents, full original net-debtor backing and the settlement window are required", "FUNDED_CLEARING_BACKING_REQUIRED");
      assertSources(round, state); actions.push(action(round.contract_id, "finalize_round", { round_id: id, manifest_hash: round.manifest_hash }));
    }
  } else if (operation === "revoke" || operation === "expire") {
    complete = !!chain && ["revoked", "expired", "rejected"].includes(chain.status);
    if (!complete) {
      if (!chain) {
        if (operation !== "revoke" || !row("SELECT id FROM clearing_funded_wallet_requests WHERE round_id=? AND operation='register' AND (review_consumed=1 OR state='unknown' OR source_transaction_hash IS NOT NULL)", id)) throw new ApiError(409, "Discard an entirely unsigned local proposal for free. Started registration requires an exact onchain cancellation or authoritative expiry", "FUNDED_CLEARING_UNSIGNED_PROPOSAL");
        const cost = await context.view<string>(round.contract_id, "registration_cost", { manifest_json: round.manifest_json }); cashAmount(cost, false);
        const cancellation = action(round.contract_id, "register_round", { manifest_json: round.manifest_json, manifest_hash: round.manifest_hash }, cost);
        cancellation.actions.push({ type: "FunctionCall", params: { methodName: "revoke", args: { round_id: id, manifest_hash: round.manifest_hash }, deposit: "1", gas: "20000000000000" } }); actions.push(cancellation);
      } else {
        if (chain.status === "finalized") throw new ApiError(409, "Finalized credits cannot be revoked", "FUNDED_CLEARING_NOT_READY");
        if (operation === "expire" && BigInt(context.timestampMs) < BigInt(manifest.expires_at_ms)) throw new ApiError(409, "Wait for the exact funding deadline before expiry", "FUNDED_CLEARING_NOT_EXPIRED");
        actions.push(action(round.contract_id, operation, operation === "expire" ? { round_id: id } : { round_id: id, manifest_hash: round.manifest_hash }));
      }
    }
  } else if (operation === "fund") {
    if (!chain || chain.status !== "ready" || state?.stage !== "funding" || !mine || !manifest.participants.every(party => chain.consents.includes(party.company_id)) || new Set(chain.consents).size !== manifest.participants.length) throw new ApiError(409, "Every exact owner consent must be recorded before accepting native-USDC deposits", "FUNDED_CLEARING_CONSENTS_REQUIRED");
    complete = state.deposits.some(deposit => deposit.company_id === live.organizationId && deposit.deposit_id === identity);
    if (!complete) {
      const remaining = BigInt(mine.deposit_due) - BigInt(mine.deposited), deposits = state.deposits.filter(value => value.company_id === live.organizationId).length;
      amount = previous?.amount ?? input.amount ?? remaining.toString(); cashAmount(amount, false);
      if (remaining <= 0n || deposits >= 8 || !previous && BigInt(amount) > remaining || deposits === 7 && BigInt(amount) < remaining) throw new ApiError(409, "Fund the remaining original net debit within eight accepted deposits. The last deposit must cover the whole remaining due; unknown retries keep their original deposit identity", "FUNDED_CLEARING_DEPOSIT_LIMIT");
      if (input.amount && input.amount !== amount) throw new ApiError(409, "An uncertain deposit retry must keep its exact original amount and message", "FUNDED_CLEARING_REVIEW_STALE");
      const [storage, balance] = await Promise.all([context.view<unknown>(manifest.cash!.token_contract, "storage_balance_of", { account_id: round.contract_id }), context.view<string>(manifest.cash!.token_contract, "ft_balance_of", { account_id: party.owner_id })]);
      if (!storage) throw new ApiError(503, "The operator must register the clearing contract for canonical USDC before companies fund escrow", "FUNDED_CLEARING_TOKEN_STORAGE_REQUIRED");
      if (cashAmount(balance) < BigInt(amount)) throw new ApiError(409, "Fund the frozen owner wallet with enough native NEAR USDC before authorizing this deposit", "FUNDED_CLEARING_OWNER_FUNDS_REQUIRED");
      actions.push(action(manifest.cash!.token_contract, "ft_transfer_call", { receiver_id: round.contract_id, amount, msg: fundingMessage(id, round.manifest_hash, live.organizationId, identity) }, "1", "180000000000000"));
    }
  } else {
    if (!chain || !mine || !state || input.operation !== "storage" && (state.stage !== (operation === "credit" ? "credits" : "refunds") || operation === "credit" && chain.status !== "finalized")) throw new ApiError(409, "Only authoritative fixed-owner credit or cancellation refund rights can be withdrawn", "FUNDED_CLEARING_RIGHTS_REQUIRED");
    if (mine.pending) throw new ApiError(409, "The original escrow transfer is pending. A missing callback never authorizes another transfer", "FUNDED_CLEARING_WITHDRAWAL_PENDING");
    const storage = await context.view<unknown>(manifest.cash!.token_contract, "storage_balance_of", { account_id: mine.destination });
    destinationRegistered = !!storage;
    if (!storage || operation === "storage") {
      operation = "storage"; complete = !!storage;
      if (!complete) { const bounds = await context.view<{ min: string }>(manifest.cash!.token_contract, "storage_balance_bounds"); cashAmount(bounds.min, false); if (BigInt(bounds.min) > 10n ** 24n) throw new ApiError(409, "Review the token's storage deposit before registering the fixed owner destination", "FUNDED_CLEARING_STORAGE_INVALID"); amount = previous?.amount ?? bounds.min; if (BigInt(amount) < BigInt(bounds.min)) throw new ApiError(409, "Token storage requirements changed. Resolve the original storage request before reviewing another", "FUNDED_CLEARING_REVIEW_STALE"); actions.push(action(manifest.cash!.token_contract, "storage_deposit", { account_id: mine.destination, registration_only: true }, amount, "30000000000000")); }
    } else {
      amount = operation === "credit" ? mine.credit_available : mine.refund_available; cashAmount(amount, false); nonce = (BigInt(mine.nonce) + 1n).toString();
      if (previous?.expected_nonce && previous.expected_nonce !== nonce) throw new ApiError(409, "A newer escrow nonce resolved or replaced this transfer. Reconcile its fixed identity before another review", "FUNDED_CLEARING_REVIEW_STALE");
      actions.push(action(round.contract_id, "withdraw_cash", { round_id: id, manifest_hash: round.manifest_hash, company_id: live.organizationId, kind: operation, expected_nonce: nonce }, "1", "140000000000000"));
    }
  }
  return { live, round, manifest, context, chain, state, ownerAccount: party.owner_id, operation, identityKey: operation === "storage" ? `storage:${party.owner_id}` : ["credit", "refund"].includes(operation) ? `${operation}:${nonce}` : identity, amount, expectedNonce: nonce, actions, complete, destinationRegistered };
}

export async function prepareFundedAction(access: AccessContext, id: string, data: unknown) {
  const input = fundedActionInput.parse(data), live = accessFor(access, true, true);
  await reconcileFundedRound(live, id);
  const uncertain = row<WalletRequest>("SELECT * FROM clearing_funded_wallet_requests WHERE round_id=? AND organization_id=? AND operation=? AND state!='resolved' ORDER BY created_at DESC LIMIT 1", id, live.organizationId, input.operation);
  if (uncertain?.wallet_lease_expires_at && uncertain.wallet_lease_expires_at > now()) throw new ApiError(409, "The original wallet dialog still owns this exact request. Finish it or wait for its short review lease", "FUNDED_CLEARING_WALLET_BUSY");
  const prepared = await actionPlan(live, id, input, uncertain), generation = randomUUID(), expiresAt = new Date(Date.now() + 300000).toISOString();
  if (prepared.complete) {
    transaction(db => {
      accessFor(live, true, true); const current = roundFor(live, id);
      if (current.manifest_hash !== input.manifestHash) throw new ApiError(409, "The exact round changed during reconciliation", "FUNDED_CLEARING_REVIEW_STALE");
      if (prepared.chain && prepared.state) updateCashObservation(current, prepared.chain, prepared.state, prepared.context.blockHeight, prepared.context.blockHash);
      if (uncertain && prepared.operation === "storage") db.prepare("UPDATE clearing_funded_wallet_requests SET state='resolved',wallet_lease_generation=NULL,wallet_lease_expires_at=NULL,updated_at=? WHERE id=?").run(now(), uncertain.id);
    });
    return { requestId: null, walletActions: [] as WalletTransaction[], operation: prepared.operation, network: prepared.round.network, ownerAccount: prepared.ownerAccount, complete: true };
  }
  const reviewHash = hash({ generation, manifestHash: prepared.round.manifest_hash, operation: prepared.operation, identity: prepared.identityKey, actions: prepared.actions });
  const request = transaction(db => {
    accessFor(live, true, true); const round = roundFor(live, id);
    if (round.manifest_hash !== input.manifestHash || !prepared.chain && round.status !== "prepared") throw new ApiError(409, "The round changed while preparing this wallet review", "FUNDED_CLEARING_REVIEW_STALE");
    if (prepared.chain && prepared.state) updateCashObservation(round, prepared.chain, prepared.state, prepared.context.blockHeight, prepared.context.blockHash);
    if (prepared.destinationRegistered) db.prepare("UPDATE clearing_funded_wallet_requests SET state='resolved',wallet_lease_generation=NULL,wallet_lease_expires_at=NULL,updated_at=? WHERE round_id=? AND organization_id=? AND operation='storage'").run(now(), id, live.organizationId);
    if (prepared.operation === "fund" && row("SELECT id FROM clearing_funded_wallet_requests WHERE round_id=? AND organization_id=? AND operation='fund' AND state!='resolved' AND identity_key!=?", id, live.organizationId, prepared.identityKey)) throw new ApiError(409, "Another reviewed deposit already owns this company funding request. Resume its exact identity or cancel an unsigned review", "FUNDED_CLEARING_SOURCE_HELD");
    const existing = row<WalletRequest>("SELECT * FROM clearing_funded_wallet_requests WHERE round_id=? AND organization_id=? AND operation=? AND identity_key=?", id, live.organizationId, prepared.operation, prepared.identityKey);
    if (existing?.wallet_lease_expires_at && existing.wallet_lease_expires_at > now()) throw new ApiError(409, "Another wallet review owns this fixed request", "FUNDED_CLEARING_WALLET_BUSY");
    if (existing?.state === "resolved") throw new ApiError(409, "This exact request is already resolved. Reconcile before another action", "FUNDED_CLEARING_REVIEW_STALE");
    if (existing?.state === "unknown" && hash(decrypt(existing.actions_ciphertext)) !== hash(JSON.stringify(prepared.actions))) throw new ApiError(409, "An uncertain wallet request keeps its original exact amounts, receivers and arguments", "FUNDED_CLEARING_SAME_IDENTITY_REQUIRED");
    const requestId = existing?.id ?? randomUUID();
    db.prepare("INSERT INTO clearing_funded_wallet_requests(id,round_id,organization_id,user_id,operation,identity_key,amount,expected_nonce,actions_ciphertext,review_generation,review_hash,review_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(round_id,organization_id,operation,identity_key) DO UPDATE SET user_id=excluded.user_id,amount=excluded.amount,expected_nonce=excluded.expected_nonce,actions_ciphertext=excluded.actions_ciphertext,review_generation=excluded.review_generation,review_hash=excluded.review_hash,review_expires_at=excluded.review_expires_at,review_consumed=0,wallet_lease_generation=NULL,wallet_lease_expires_at=NULL,updated_at=excluded.updated_at")
      .run(requestId, id, live.organizationId, live.userId, prepared.operation, prepared.identityKey, prepared.amount, prepared.expectedNonce, encrypt(JSON.stringify(prepared.actions)), generation, reviewHash, expiresAt, now(), now());
    return row<WalletRequest>("SELECT * FROM clearing_funded_wallet_requests WHERE id=?", requestId)!;
  });
  return { requestId: request.id, reviewGeneration: generation, reviewHash, reviewExpiresAt: expiresAt, operation: prepared.operation, identityKey: request.identity_key, amount: prepared.amount, expectedNonce: prepared.expectedNonce, walletActions: prepared.actions, network: prepared.round.network, ownerAccount: prepared.ownerAccount, retrySameRequest: request.state === "unknown", complete: false,
    costs: { sourceToken: prepared.manifest.cash!.token_contract, sourceNetwork: "near", sourceUSDC: prepared.operation === "fund" ? prepared.amount : "0", fixedDestination: prepared.ownerAccount, attachedNearYocto: prepared.actions.reduce((sum, value) => sum + value.actions.reduce((total, item) => total + BigInt(item.params.deposit), 0n), 0n).toString(), gasIsPaidByOwner: true, gasEstimateIsNotActualFee: true },
    warning: prepared.operation === "fund" ? "This moves native USDC directly from your frozen owner wallet into clearing escrow. It does not fund shared treasury. Partial/excess returns require final token receipt verification." : "Review the exact fixed identity and wallet costs. Missing callbacks and unknown source transactions stay held; no owner attestation can mark them paid." };
}
export const beginFundedInput = z.object({ requestId: z.string().uuid(), reviewGeneration: z.string().uuid(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/), signerAccount: z.string().min(2).max(64), retrySameRequest: z.boolean().optional() }).strict();
export async function beginFundedAction(access: AccessContext, id: string, data: unknown) {
  const input = beginFundedInput.parse(data), live = accessFor(access, true, true), previous = row<WalletRequest>("SELECT * FROM clearing_funded_wallet_requests WHERE id=? AND round_id=? AND organization_id=? AND user_id=?", input.requestId, id, live.organizationId, live.userId);
  if (!previous || previous.review_generation !== input.reviewGeneration || previous.review_hash !== input.reviewHash || previous.review_consumed || previous.review_expires_at <= now()) throw new ApiError(409, "The wallet review expired, changed or was already used", "FUNDED_CLEARING_REVIEW_STALE");
  if (previous.state === "unknown" && input.retrySameRequest !== true) throw new ApiError(409, "Explicitly review retrying only the same uncertain deposit or transfer identity and additional wallet costs", "FUNDED_CLEARING_SAME_IDENTITY_REQUIRED");
  const before = roundFor(live, id), prepared = await actionPlan(live, id, { manifestHash: before.manifest_hash, operation: previous.operation, ...(previous.operation === "fund" && previous.amount ? { amount: previous.amount } : {}) }, previous);
  if (prepared.complete || input.signerAccount !== prepared.ownerAccount || hash({ generation: input.reviewGeneration, manifestHash: before.manifest_hash, operation: prepared.operation, identity: prepared.identityKey, actions: prepared.actions }) !== input.reviewHash) throw new ApiError(409, "The exact request, owner wallet or live custody state changed. Reconcile and review again", "FUNDED_CLEARING_REVIEW_STALE");
  return transaction(db => {
    accessFor(live, true, ["revoke", "expire", "credit", "refund", "storage"].includes(prepared.operation)); const current = roundFor(live, id);
    if (current.manifest_hash !== before.manifest_hash || !prepared.chain && current.status !== "prepared") throw new ApiError(409, "The round commitment or observed custody state changed", "FUNDED_CLEARING_REVIEW_STALE");
    if (prepared.chain && prepared.state) updateCashObservation(current, prepared.chain, prepared.state, prepared.context.blockHeight, prepared.context.blockHash);
    const stamp = now(), changed = db.prepare("UPDATE clearing_funded_wallet_requests SET state='unknown',review_consumed=1,wallet_lease_generation=?,wallet_lease_expires_at=?,updated_at=? WHERE id=? AND organization_id=? AND user_id=? AND review_generation=? AND review_hash=? AND review_consumed=0 AND state!='resolved' AND review_expires_at>? AND (wallet_lease_expires_at IS NULL OR wallet_lease_expires_at<=?)")
      .run(input.reviewGeneration, new Date(Date.now() + 120000).toISOString(), stamp, input.requestId, live.organizationId, live.userId, input.reviewGeneration, input.reviewHash, stamp, stamp);
    if (changed.changes !== 1) throw new ApiError(409, "Another dialog consumed or replaced this fixed request review", "FUNDED_CLEARING_REVIEW_STALE");
    audit(live.userId, live.organizationId, "funded_clearing.wallet_started", input.requestId, { roundId: id, operation: prepared.operation, identityKey: prepared.identityKey }); return { fenced: true };
  });
}
export function finishFundedWallet(access: AccessContext, id: string, requestId: string, generation: string, transactionHash?: string) {
  const live = accessFor(access, true, true); roundFor(live, id);
  if (transactionHash && !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(transactionHash)) throw new ApiError(422, "Use the original NEAR transaction reference", "FUNDED_CLEARING_RECEIPT_INVALID");
  return transaction(db => {
    const changed = db.prepare("UPDATE clearing_funded_wallet_requests SET wallet_lease_generation=NULL,wallet_lease_expires_at=NULL,source_transaction_hash=COALESCE(source_transaction_hash,?),updated_at=? WHERE id=? AND round_id=? AND organization_id=? AND user_id=? AND review_generation=? AND wallet_lease_generation=?")
      .run(transactionHash ?? null, now(), requestId, id, live.organizationId, live.userId, generation, generation);
    return { released: changed.changes === 1, verified: false, note: "A wallet reference is not funding or delivery proof. The same uncertain identity remains fenced until authoritative reconciliation." };
  });
}
export function cancelFundedReview(access: AccessContext, id: string, requestId: string, generation: string) {
  const live = accessFor(access, true, true); roundFor(live, id);
  return transaction(db => {
    const changed = db.prepare("UPDATE clearing_funded_wallet_requests SET state='resolved',updated_at=? WHERE id=? AND round_id=? AND organization_id=? AND user_id=? AND review_generation=? AND state='prepared' AND review_consumed=0 AND wallet_lease_generation IS NULL").run(now(), requestId, id, live.organizationId, live.userId, generation);
    if (changed.changes !== 1) throw new ApiError(409, "Only an unstarted review can be discarded. A started or uncertain source keeps its exact identity held", "FUNDED_CLEARING_SOURCE_HELD");
    return { cancelled: true, financialEffect: "No transfer was authorized by this review" };
  });
}
export async function monitorFundedRounds(maxRounds = 2, organizationId?: string) {
  const selected = rows<{ id: string; organization_id: string; owner_id: string }>("SELECT r.id,p.organization_id,o.owner_id FROM clearing_rounds r JOIN clearing_round_participants p ON p.round_id=r.id JOIN organizations o ON o.id=p.organization_id WHERE r.mode='cash_backed_native_v1' AND p.organization_id=(SELECT organization_id FROM clearing_round_participants WHERE round_id=r.id ORDER BY organization_id LIMIT 1) AND (r.status IN ('prepared','registered') OR EXISTS(SELECT 1 FROM clearing_funded_accounts a WHERE a.round_id=r.id AND (a.pending_json IS NOT NULL OR a.credit_available!='0' OR a.refund_available!='0'))) AND (? IS NULL OR EXISTS(SELECT 1 FROM clearing_round_participants scoped WHERE scoped.round_id=r.id AND scoped.organization_id=?)) ORDER BY COALESCE(r.cash_checked_at,r.created_at),r.id LIMIT ?", organizationId ?? null, organizationId ?? null, Math.max(1, Math.min(3, maxRounds)));
  let checked = 0, held = 0;
  for (const item of selected) {
    try { await reconcileFundedRound(getAccess(item.owner_id, item.organization_id), item.id); checked++; }
    catch { held++; }
    finally { getDb().prepare("UPDATE clearing_rounds SET cash_checked_at=? WHERE id=?").run(now(), item.id); }
  }
  return { checked, held };
}

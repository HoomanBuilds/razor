import { randomUUID } from "node:crypto";
import { assertFeature } from "../billing/entitlements";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getRecipient } from "../identity/recipients";
import type { Payment, TreasuryConfig, WalletTransaction } from "../payments/types";
import { computeClearing, describeCommittedClearing, hash, type ClearingOptimization } from "./algorithm";
import { finalContext, readiness, roundEvidence, settings, verifyRegistration } from "./chain";
import type { FinalEvidence, Link, Manifest, Registration, Round } from "./types";
import { consumeBillCommitment } from "../vendor-commitments/service";
import { assertBillUnassigned } from "../financing/accounting";

const now = () => new Date().toISOString();
interface Bill { id: string; organization_id: string; recipient_id: string; reference: string; title: string; amount: string; setoff_amount: string; accepted_credit_amount:string; max_fee: string; payment_id: string | null; status: string; due_date: string | null; requires_acceptance: number; milestone_accepted_at: string | null; project_reference: string | null; cost_center_reference: string | null }

function owner(access: AccessContext) {
  requirePermission(access, "company:manage");
  const organization = row<{ owner_id: string; paused: number }>("SELECT owner_id,paused FROM organizations WHERE id=?", access.organizationId);
  if (organization?.owner_id !== access.userId) throw new ApiError(403, "Only the registered company owner can authorize business clearing", "CLEARING_OWNER_REQUIRED");
  if (organization.paused) throw new ApiError(409, "Unpause the company before new clearing authorizations", "PAYMENTS_PAUSED");
}

export function registration(id: string): Registration {
  const value = row<Registration>("SELECT * FROM clearing_companies WHERE organization_id=? AND enabled=1", id);
  if (!value || row<{ owner_id: string }>("SELECT owner_id FROM organizations WHERE id=?", id)?.owner_id !== value.owner_user_id) throw new ApiError(409, "Every participant must opt in through its current company and treasury owner", "CLEARING_PARTICIPATION_REQUIRED");
  const treasury = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", id);
  if (!treasury || treasury.near_account_id !== value.treasury_id || treasury.network !== value.network || treasury.token_contract !== value.token_contract || treasury.architecture !== "shared_v1" || !treasury.company_id?.startsWith(`${id}:`)) throw new ApiError(409, "A participant's treasury changed after registration", "CLEARING_REGISTRATION_STALE");
  return {...value,treasury_company_id:treasury.company_id};
}

export async function setParticipation(access: AccessContext, enabled: boolean) {
  owner(access);
  if (!enabled) { getDb().prepare("UPDATE clearing_companies SET enabled=0,version=version+1,updated_at=? WHERE organization_id=?").run(now(), access.organizationId); return { enabled: false }; }
  const context = await finalContext(), treasury = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!treasury) throw new ApiError(409, "Connect the company NEAR treasury before opting in", "TREASURY_SETUP_REQUIRED");
  const config = await context.view<{ owner_id: string; policy_version: string }>(treasury.near_account_id, "get_config", {company_id: treasury.company_id});
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, config.owner_id, treasury.network)) throw new ApiError(403, "Verify the NEAR wallet that owns this treasury", "TREASURY_OWNER_UNVERIFIED");
  const record: Registration = { organization_id: access.organizationId, owner_user_id: access.userId, treasury_id: treasury.near_account_id, treasury_company_id:treasury.company_id!, owner_account_id: config.owner_id, policy_version: config.policy_version, token_contract: treasury.token_contract, network: treasury.network, enabled: 1, version: 1 };
  await verifyRegistration(context, record);
  return transaction(db => {
    owner(access);
    db.prepare("INSERT INTO clearing_companies(organization_id,owner_user_id,treasury_id,owner_account_id,policy_version,network,token_contract,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,treasury_id=excluded.treasury_id,owner_account_id=excluded.owner_account_id,policy_version=excluded.policy_version,network=excluded.network,token_contract=excluded.token_contract,enabled=1,version=clearing_companies.version+1,updated_at=excluded.updated_at")
      .run(record.organization_id, record.owner_user_id, record.treasury_id, record.owner_account_id, record.policy_version, record.network, record.token_contract, now(), now());
    return registration(access.organizationId);
  });
}

function activePayment(paymentId: string, exceptRound?: string) {
  return row("SELECT r.id FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id WHERE l.payment_id=? AND r.status IN ('prepared','registered') AND r.id!=?", paymentId, exceptRound ?? "");
}

export function eligibleTerms(organizationId: string, billId: string, exceptRound?: string) {
  assertBillUnassigned(organizationId, billId);
  const bill = row<Bill>("SELECT * FROM bills WHERE id=? AND organization_id=?", billId, organizationId);
  if (!bill?.payment_id) throw new ApiError(409, "Select an invoice with an unpaid payment draft", "CLEARING_BILL_INELIGIBLE");
  const payment = row<Payment>("SELECT * FROM payments WHERE id=? AND organization_id=?", bill.payment_id, organizationId), recipient = getRecipient(organizationId, bill.recipient_id);
  if (bill.accepted_credit_amount !== "0" || !payment || recipient.kind !== "business" || recipient.archived || recipient.preference_status !== "confirmed" || payment.recipient_version !== recipient.version || bill.status !== "draft" || payment.kind !== "invoice" || payment.status !== "draft" || payment.approved_at || payment.reserved_amount !== "0" || payment.total_spent !== "0" || payment.delivered_amount !== "0" || BigInt(payment.amount) !== BigInt(bill.amount) - BigInt(bill.setoff_amount) || bill.requires_acceptance && !bill.milestone_accepted_at) throw new ApiError(409, "Clearing accepts only confirmed business invoices with their complete unapproved, unfunded draft liability and required work acceptance", "CLEARING_BILL_INELIGIBLE");
  if (activePayment(payment.id, exceptRound) || row("SELECT id FROM payout_attempts WHERE payment_id=?", payment.id) || row("SELECT id FROM funding_legs WHERE payment_id=?", payment.id) || row("SELECT id FROM client_reserves WHERE payment_id=? AND state!='released'", payment.id) || row("SELECT p.id FROM bill_installments i JOIN payments p ON p.id=i.payment_id WHERE i.bill_id=? AND (p.approved_at IS NOT NULL OR p.total_spent!='0' OR p.delivered_amount!='0' OR EXISTS(SELECT 1 FROM payout_attempts a WHERE a.payment_id=p.id))", bill.id)) throw new ApiError(409, "A payment, funding leg, cash commitment or clearing round already uses this invoice", "CLEARING_OBLIGATION_BUSY");
  return { billId: bill.id, organizationId, recipientId: recipient.id, recipientUserId: recipient.user_id, reference: bill.reference, title: decrypt(bill.title), amount: payment.amount, originalInvoiceAmount: bill.amount, priorSetoff: bill.setoff_amount, dueDate: bill.due_date, paymentId: payment.id, maxFee: payment.max_fee, recipientVersion: payment.recipient_version, recipientSnapshot: payment.recipient_snapshot, metadata: payment.metadata, requiresAcceptance: bill.requires_acceptance, acceptedAt: bill.milestone_accepted_at, projectReference: bill.project_reference ? decrypt(bill.project_reference) : null, costCenterReference: bill.cost_center_reference ? decrypt(bill.cost_center_reference) : null };
}

function ownLink(access: AccessContext, id: string) {
  requirePermission(access, "payments:read");
  const link = row<Link>("SELECT * FROM clearing_links WHERE id=? AND (debtor_id=? OR creditor_id=?)", id, access.organizationId, access.organizationId);
  if (!link) throw new ApiError(404, "Shared business invoice not found", "NOT_FOUND");
  return link;
}
function assertCounterparty(debtorId: string, billId: string, creditorId: string) {
  const bill = row<{ recipient_id: string }>("SELECT recipient_id FROM bills WHERE id=? AND organization_id=?", billId, debtorId);
  const creditor = registration(creditorId);
  if (!bill || getRecipient(debtorId, bill.recipient_id).user_id !== creditor.owner_user_id) throw new ApiError(409, "The receiving company owner must confirm this business recipient profile before accepting its invoice for clearing", "CLEARING_CREDITOR_UNVERIFIED");
}

function assertLink(link: Link, exceptRound?: string, at = Date.now()) {
  assertCounterparty(link.debtor_id, link.bill_id, link.creditor_id);
  if (link.status !== "accepted" || !link.accepted_by || !link.accepted_at || Date.parse(link.expires_at) <= at || hash(eligibleTerms(link.debtor_id, link.bill_id, exceptRound)) !== link.terms_hash) throw new ApiError(409, "An invoice agreement expired, changed, or has not been accepted by both companies", "CLEARING_LINK_STALE");
  registration(link.debtor_id); registration(link.creditor_id);
}

export function offerInvoice(access: AccessContext, input: { billId: string; creditorId: string; startsAt: string; expiresAt: string }) {
  owner(access);
  if (input.creditorId === access.organizationId || !(Date.parse(input.startsAt) < Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw new ApiError(422, "Choose another opted-in company and a valid future settlement window", "CLEARING_WINDOW_INVALID");
  return transaction(db => {
    const debtor = registration(access.organizationId), creditor = registration(input.creditorId);
    if (debtor.network !== creditor.network || debtor.token_contract !== creditor.token_contract) throw new ApiError(409, "Both companies must use the same network and USDC settlement unit", "CLEARING_ASSET_MISMATCH");
    assertCounterparty(access.organizationId, input.billId, input.creditorId);
    const terms = eligibleTerms(access.organizationId, input.billId), digest = hash(terms);
    consumeBillCommitment(access, input.billId);
    const existing = row<Link>("SELECT * FROM clearing_links WHERE bill_id=? AND payment_id=? AND status IN ('offered','accepted')", input.billId, terms.paymentId);
    if (existing) { if (existing.terms_hash !== digest || existing.creditor_id !== input.creditorId || existing.starts_at !== input.startsAt || existing.expires_at !== input.expiresAt) throw new ApiError(409, "Revoke the existing agreement before offering different terms", "CLEARING_OFFER_EXISTS"); return { ...existing, terms }; }
    const id = randomUUID(); db.prepare("INSERT INTO clearing_links(id,debtor_id,creditor_id,bill_id,payment_id,terms_hash,terms_ciphertext,starts_at,expires_at,offered_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, access.organizationId, input.creditorId, input.billId, terms.paymentId, digest, encrypt(JSON.stringify(terms)), input.startsAt, input.expiresAt, access.userId, now());
    return { ...ownLink(access, id), terms };
  });
}

export function acceptInvoice(access: AccessContext, id: string, termsHash: string) {
  owner(access);
  return transaction(db => {
    const link = ownLink(access, id); registration(access.organizationId);
    assertCounterparty(link.debtor_id, link.bill_id, link.creditor_id);
    if (link.creditor_id !== access.organizationId || !["offered", "accepted"].includes(link.status) || link.terms_hash !== termsHash || hash(eligibleTerms(link.debtor_id, link.bill_id)) !== termsHash || Date.parse(link.expires_at) <= Date.now()) throw new ApiError(409, "Only the receiving company owner can accept these unchanged shared terms", "CLEARING_ACCEPTANCE_INVALID");
    db.prepare("UPDATE clearing_links SET status='accepted',accepted_by=?,accepted_at=COALESCE(accepted_at,?) WHERE id=?").run(access.userId, now(), id);
    return { ...ownLink(access, id), terms: JSON.parse(decrypt(link.terms_ciphertext)) };
  });
}

export function revokeInvoice(access: AccessContext, id: string) {
  owner(access);
  return transaction(db => {
    const link = ownLink(access, id);
    if (activePayment(link.payment_id) || link.status === "cleared") throw new ApiError(409, "Revoke the pending NEAR round before changing its accepted invoices", "CLEARING_LOCKED");
    db.prepare("UPDATE clearing_links SET status='revoked' WHERE id=?").run(id); return { id, status: "revoked" };
  });
}

export function shareInvoice(access: AccessContext, id: string, companyId: string) {
  owner(access);
  return transaction(db => {
    const link = ownLink(access, id); registration(companyId);
    if (link.status !== "accepted" || companyId === link.debtor_id || companyId === link.creditor_id || activePayment(link.payment_id)) throw new ApiError(409, "Share an accepted unlocked agreement with a different participating company", "CLEARING_SHARING_INVALID");
    const column = access.organizationId === link.debtor_id ? "debtor_consent" : "creditor_consent";
    db.prepare(`INSERT INTO clearing_link_shares(link_id,organization_id,${column}) VALUES(?,?,1) ON CONFLICT(link_id,organization_id) DO UPDATE SET ${column}=1`).run(id, companyId);
    return row("SELECT * FROM clearing_link_shares WHERE link_id=? AND organization_id=?", id, companyId);
  });
}

function sharedWith(link: Link, organizationId: string) {
  return link.debtor_id === organizationId || link.creditor_id === organizationId || !!row("SELECT link_id FROM clearing_link_shares WHERE link_id=? AND organization_id=? AND debtor_consent=1 AND creditor_consent=1", link.id, organizationId);
}

export interface PreviewInput { linkIds: string[]; startsAt: string; expiresAt: string }
export function previewRoundSelection(access: AccessContext, input: PreviewInput, cash = false) {
  owner(access);
  if (input.linkIds.length < 2 || input.linkIds.length > 32 || new Set(input.linkIds).size !== input.linkIds.length) throw new ApiError(422, "Choose 2 to 32 different accepted invoice agreements", "CLEARING_SELECTION_INVALID");
  const links = [...input.linkIds].sort().map(id => {
    const value = row<Link>("SELECT * FROM clearing_links WHERE id=?", id);
    if (!value || !sharedWith(value, access.organizationId)) throw new ApiError(404, "An accepted round invitation was not found", "NOT_FOUND"); return value;
  });
  const companyIds = [...new Set(links.flatMap(link => [link.debtor_id, link.creditor_id]))].sort();
  if (!companyIds.includes(access.organizationId)) throw new ApiError(403, "Only an invited participating company can propose this round", "FORBIDDEN");
  for (const link of links) assertLink(link);
  if (links.some(link => companyIds.some(companyId => !sharedWith(link, companyId)))) throw new ApiError(409, "Both invoice counterparties must explicitly share its amount with every additional company in this cycle", "CLEARING_SHARING_REQUIRED");
  const start = Date.parse(input.startsAt), end = Date.parse(input.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end <= Date.now() || end > Date.now() + 86400000 || links.some(link => start < Date.parse(link.starts_at) || end > Date.parse(link.expires_at))) throw new ApiError(422, "Use a common accepted window ending within the next 24 hours", "CLEARING_WINDOW_INVALID");
  const parties = companyIds.map(id => registration(id));
  if (parties.some(value => value.network !== parties[0].network || value.token_contract !== parties[0].token_contract)) throw new ApiError(409, "Round participants use incompatible settlement rails", "CLEARING_ASSET_MISMATCH");
  const calculation = computeClearing(links.map(link => ({ id: link.payment_id, debtor: link.debtor_id, creditor: link.creditor_id, amount: JSON.parse(decrypt(link.terms_ciphertext)).amount })));
  if (!cash && calculation.dischargedInvoiceValue === "0") throw new ApiError(422, "These obligations have no reciprocal or multi-company cycle to clear", "CLEARING_NO_CYCLE");
  const participants = parties.map(value => ({ company_id: value.organization_id, treasury_id: value.treasury_id, treasury_company_id:value.treasury_company_id, owner_id: value.owner_account_id, version: String(value.version), policy_version: value.policy_version }));
  const obligations = calculation.obligations.map(edge => ({ ...edge, terms_hash: links.find(link => link.payment_id === edge.id)!.terms_hash }));
  const reviewed = { asset: "USDC" as const, fee: "0", starts_at_ms: String(start), expires_at_ms: String(end), participants, obligations };
  return { ...calculation, reviewed, reviewToken: hash(reviewed), linkIds: links.map(link => link.id), network: parties[0].network, warning: "NEAR consent publishes opaque obligation IDs, treasury accounts and USDC amounts. Private invoice documents and descriptions remain offchain." };
}
export function previewRound(access: AccessContext, input: PreviewInput) { return previewRoundSelection(access, input); }

export function createRound(access: AccessContext, input: PreviewInput & { reviewToken: string }) {
  assertFeature(access, "clearing");
  owner(access); const config = settings();
  return transaction(db => {
    const preview = previewRound(access, input);
    if (preview.reviewToken !== input.reviewToken || preview.network !== config.network) throw new ApiError(409, "The exact clearing proposal changed. Review it again", "CLEARING_REVIEW_STALE");
    const id = randomUUID(), manifest: Manifest = { id, ...preview.reviewed }, manifestJson = JSON.stringify(manifest), digest = hash(manifestJson);
    db.prepare("INSERT INTO clearing_rounds(id,manifest_hash,manifest_json,network,contract_id,created_by,created_at,expires_at,optimization_json) VALUES(?,?,?,?,?,?,?,?,?)").run(id, digest, manifestJson, config.network, config.contractId, access.userId, now(), input.expiresAt, JSON.stringify(preview.optimization));
    for (const party of manifest.participants) db.prepare("INSERT INTO clearing_round_participants(round_id,organization_id) VALUES(?,?)").run(id, party.company_id);
    for (const linkId of preview.linkIds) { const link = ownRoundLink(linkId); db.prepare("INSERT INTO clearing_round_links(round_id,link_id,bill_id,payment_id) VALUES(?,?,?,?)").run(id, link.id, link.bill_id, link.payment_id); }
    return roundDetail(access, id);
  });
}

function ownRoundLink(id: string) { return row<Link>("SELECT * FROM clearing_links WHERE id=?", id)!; }
function roundFor(access: AccessContext, id: string): Round {
  requirePermission(access, "payments:read");
  const value = row<Round>("SELECT r.* FROM clearing_rounds r JOIN clearing_round_participants p ON p.round_id=r.id WHERE r.id=? AND p.organization_id=? AND r.mode='debt_discharge_v1'", id, access.organizationId);
  if (!value) throw new ApiError(404, "Clearing round not found for this company", "NOT_FOUND"); return value;
}
export function assertRoundTerms(round: Round, at = Date.now()) {
  const manifest = JSON.parse(round.manifest_json) as Manifest;
  if (hash(round.manifest_json) !== round.manifest_hash) throw new ApiError(409, "The local round commitment is inconsistent", "CLEARING_REVIEW_STALE");
  const links = rows<Link>("SELECT l.* FROM clearing_links l JOIN clearing_round_links rl ON rl.link_id=l.id WHERE rl.round_id=? ORDER BY l.payment_id", round.id);
  if (links.length !== manifest.obligations.length) throw new ApiError(409, "The round obligation list changed", "CLEARING_REVIEW_STALE");
  for (const link of links) {
    assertLink(link, round.id, at);
    const edge = manifest.obligations.find(edge => edge.id === link.payment_id);
    if (!edge || edge.terms_hash !== link.terms_hash || edge.debtor !== link.debtor_id || edge.creditor !== link.creditor_id || edge.original !== JSON.parse(decrypt(link.terms_ciphertext)).amount) throw new ApiError(409, "An accepted obligation differs from the NEAR commitment", "CLEARING_REVIEW_STALE");
  }
  for (const party of manifest.participants) { const current = registration(party.company_id); if (current.treasury_id !== party.treasury_id || current.treasury_company_id !== party.treasury_company_id || current.owner_account_id !== party.owner_id || String(current.version) !== party.version || current.policy_version !== party.policy_version) throw new ApiError(409, "Participant authority changed after proposal", "CLEARING_REVIEW_STALE"); }
  try { if (describeCommittedClearing(manifest.obligations).dischargedInvoiceValue === "0" && !manifest.cash) throw new Error("The committed clearing has no debt discharge"); }
  catch { throw new ApiError(409, "The round no longer matches its exact conservation calculation", "CLEARING_REVIEW_STALE"); }
  return { manifest, links };
}

export function roundDetail(access: AccessContext, id: string) {
  const value = roundFor(access, id), manifest = JSON.parse(value.manifest_json) as Manifest;
  const calculation = describeCommittedClearing(manifest.obligations, value.optimization_json ? JSON.parse(value.optimization_json) as ClearingOptimization : null);
  const companies = manifest.participants.map(party => ({ ...party, name: row<{ name: string }>("SELECT name FROM organizations WHERE id=?", party.company_id)?.name ?? party.company_id }));
  const links = rows<Link>("SELECT l.* FROM clearing_links l JOIN clearing_round_links rl ON rl.link_id=l.id WHERE rl.round_id=? AND (l.debtor_id=? OR l.creditor_id=?)", id, access.organizationId, access.organizationId).map(({ terms_ciphertext, ...link }) => ({ ...link, terms: JSON.parse(decrypt(terms_ciphertext)) }));
  return { ...value, proof_ciphertext: undefined, optimization_json: undefined, manifest, calculation, companies, sharedInvoices: links, proof: value.proof_ciphertext ? JSON.parse(decrypt(value.proof_ciphertext)) as FinalEvidence : null };
}

function action(account: string, methodName: string, args: unknown, deposit = "1", gas = "180000000000000"): WalletTransaction { return { receiverId: account, actions: [{ type: "FunctionCall", params: { methodName, args, deposit, gas } }] }; }

export async function prepareRoundAction(access: AccessContext, id: string, manifestHash: string, operation: "register" | "consent" | "finalize" | "revoke") {
  owner(access); const local = roundFor(access, id);
  if (manifestHash !== local.manifest_hash || !["prepared", "registered"].includes(local.status)) throw new ApiError(409, "Review the exact active clearing round first", "CLEARING_REVIEW_STALE");
  const context = await finalContext(), manifest = JSON.parse(local.manifest_json) as Manifest;
  if (context.config.contractId !== local.contract_id || context.config.network !== local.network) throw new ApiError(409, "The clearing deployment changed", "CLEARING_CODE_MISMATCH");
  const mine = registration(access.organizationId);
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, mine.owner_account_id, mine.network)) throw new ApiError(403, "Link the exact NEAR treasury owner wallet before signing", "TREASURY_OWNER_UNVERIFIED");
  const chain = await context.view<import("./types").ChainRound | null>(local.contract_id, "get_round", { round_id: id });
  if (chain && (chain.hash !== manifestHash || chain.manifest_json !== local.manifest_json)) throw new ApiError(409, "The deployed round has different terms", "CLEARING_CHAIN_MISMATCH");
  if (operation !== "revoke") {
    if (context.clearing.paused) throw new ApiError(409, "New clearing consent is paused", "CLEARING_PAUSED");
    assertRoundTerms(local);
    await Promise.all(manifest.participants.map(party => verifyRegistration(context, registration(party.company_id))));
  }
  let actions: WalletTransaction[];
  if (operation === "register" || operation === "revoke" && !chain) {
    if (chain) throw new ApiError(409, "This round was already submitted. Refresh its NEAR evidence", "CLEARING_ALREADY_REGISTERED");
    const deposit = await context.view<string>(local.contract_id, "registration_cost", { manifest_json: local.manifest_json });
    if (!/^[1-9]\d*$/.test(deposit)) throw new ApiError(502, "The registration storage budget is invalid", "CLEARING_RESPONSE_INVALID");
    actions = [action(local.contract_id, "register_round", { manifest_json: local.manifest_json, manifest_hash: manifestHash }, deposit)];
    if (operation === "revoke") actions[0].actions.push({ type: "FunctionCall", params: { methodName: "revoke", args: { round_id: id, manifest_hash: manifestHash }, deposit: "1", gas: "20000000000000" } });
  } else {
    if (!chain || (operation === "revoke" ? ["finalized", "revoked", "expired"].includes(chain.status) : chain.status !== "ready")) throw new ApiError(409, "Wait for a verified ready round before consent or finalization", "CLEARING_NOT_READY");
    if (operation === "consent" && chain.consents.includes(access.organizationId)) return { walletActions: [], network: local.network, ownerAccount: mine.owner_account_id, operation, alreadyConsented: true };
    if (operation === "finalize" && !manifest.participants.every(party => chain.consents.includes(party.company_id))) throw new ApiError(409, "Every participating owner must consent before finalization", "CLEARING_CONSENTS_REQUIRED");
    actions = [action(local.contract_id, operation === "finalize" ? "finalize_round" : operation, { round_id: id, manifest_hash: manifestHash, ...(operation === "consent" ? { company_id: access.organizationId } : {}) })];
  }
  const latest = roundFor(access, id); owner(access);
  if (!["prepared", "registered"].includes(latest.status) || latest.manifest_hash !== manifestHash) throw new ApiError(409, "Round state changed while preparing the wallet action", "CLEARING_REVIEW_STALE");
  if (operation !== "revoke") assertRoundTerms(latest);
  return { walletActions: actions, network: local.network, ownerAccount: mine.owner_account_id, operation, alreadyConsented: false };
}

export async function reconcileRound(access: AccessContext, id: string) {
  roundFor(access, id);
  const evidence = await roundEvidence(id);
  return applyFinalEvidence(access, id, evidence);
}

function applyFinalEvidence(access: AccessContext, id: string, evidence: FinalEvidence) {
  return transaction(db => {
    const local = roundFor(access, id), config = settings(), manifest = JSON.parse(local.manifest_json) as Manifest, chain = evidence.round;
    if (local.status === "cleared") return roundDetail(access, id);
    if (evidence.network !== local.network || evidence.contractId !== local.contract_id || evidence.codeHash !== config.codeHash || !evidence.blockHash || !/^\d+$/.test(evidence.blockHeight) || !/^\d+$/.test(evidence.timestampMs)) throw new ApiError(409, "Final evidence does not belong to the reviewed clearing deployment", "CLEARING_PROOF_INVALID");
    if (chain && (chain.hash !== local.manifest_hash || chain.manifest_json !== local.manifest_json)) throw new ApiError(409, "The final NEAR round does not match the exact reviewed proposal", "CLEARING_CHAIN_MISMATCH");
    const expired = BigInt(evidence.timestampMs) >= BigInt(manifest.expires_at_ms);
    if (!chain && expired || chain && ["revoked", "rejected", "expired"].includes(chain.status) || chain && chain.status !== "finalized" && expired) {
      db.prepare("UPDATE clearing_rounds SET status=?,proof_ciphertext=? WHERE id=?").run(chain?.status === "revoked" ? "revoked" : chain?.status === "rejected" ? "rejected" : "expired", encrypt(JSON.stringify(evidence)), id); return roundDetail(access, id);
    }
    if (!chain || chain.status !== "finalized") { if (chain) db.prepare("UPDATE clearing_rounds SET status='registered',proof_ciphertext=? WHERE id=?").run(encrypt(JSON.stringify(evidence)), id); return roundDetail(access, id); }
    if (!["prepared", "registered"].includes(local.status)) throw new ApiError(409, "A closed local round cannot discharge invoice liabilities", "CLEARING_ROUND_CLOSED");
    if (!chain.finalized_at_ms || !chain.finalized_height || !/^\d+$/.test(chain.finalized_at_ms) || !/^\d+$/.test(chain.finalized_height) || BigInt(chain.finalized_at_ms) < BigInt(manifest.starts_at_ms) || BigInt(chain.finalized_at_ms) >= BigInt(manifest.expires_at_ms) || BigInt(chain.finalized_height) > BigInt(evidence.blockHeight) || chain.consents.length !== manifest.participants.length || new Set(chain.consents).size !== manifest.participants.length || !manifest.participants.every(party => chain.consents.includes(party.company_id))) throw new ApiError(409, "The finalized round lacks exact complete consent and settlement-window evidence", "CLEARING_CONSENTS_REQUIRED");
    if (!evidence.authority?.blockHash || evidence.authority.blockHeight !== chain.finalized_height || hash(evidence.authority.participants) !== hash(manifest.participants.map(party => ({ companyId: party.company_id, treasuryId: party.treasury_id, treasuryCompanyId:party.treasury_company_id, ownerId: party.owner_id, policyVersion: party.policy_version })))) throw new ApiError(409, "Every participating treasury owner and policy must be verified at the finalized block", "CLEARING_AUTHORITY_UNVERIFIED");
    const { links } = assertRoundTerms(local, Number(chain.finalized_at_ms));
    db.prepare("UPDATE clearing_rounds SET status='applying' WHERE id=? AND status IN ('prepared','registered')").run(id);
    for (const link of links) {
      const edge = manifest.obligations.find(edge => edge.id === link.payment_id)!, old = row<Payment>("SELECT * FROM payments WHERE id=?", link.payment_id)!, savedAt = now();
      db.prepare("UPDATE payments SET status='cancelled',hold_reason='Retired by consented business clearing; use the residual invoice obligation',updated_at=? WHERE id=?").run(savedAt, old.id);
      let residualId: string | null = null;
      if (BigInt(edge.residual) > 0n) {
        residualId = randomUUID();
        db.prepare("INSERT INTO payments(id,organization_id,recipient_id,kind,reference,amount,max_fee,status,scheduled_for,recipient_version,recipient_snapshot,metadata,created_at,updated_at) VALUES(?,?,?,'invoice',?,?,?,'draft',?,?,?,?,?,?)")
          .run(residualId, link.debtor_id, old.recipient_id, `bill:${link.bill_id}:clearing:${id}`, edge.residual, old.max_fee, old.scheduled_for, old.recipient_version, old.recipient_snapshot, JSON.stringify({ ...JSON.parse(old.metadata), clearingRoundId: id, originalPaymentId: old.id }), savedAt, savedAt);
        db.prepare("INSERT INTO bill_installments(id,bill_id,payment_id,created_at) VALUES(?,?,?,?)").run(randomUUID(), link.bill_id, residualId, savedAt);
      }
      const bill = row<Bill>("SELECT * FROM bills WHERE id=?", link.bill_id)!;
      db.prepare("UPDATE bills SET setoff_amount=?,payment_id=?,status=?,accepted_at=NULL,updated_at=? WHERE id=?").run((BigInt(bill.setoff_amount) + BigInt(edge.reduction)).toString(), residualId, residualId ? "draft" : "cleared", savedAt, bill.id);
      db.prepare("INSERT INTO clearing_setoffs(id,round_id,link_id,organization_id,bill_id,original_payment_id,residual_payment_id,amount,manifest_hash,proof_block_hash,proof_block_height,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), id, link.id, link.debtor_id, bill.id, old.id, residualId, edge.reduction, local.manifest_hash, evidence.blockHash, evidence.blockHeight, savedAt);
      db.prepare("UPDATE clearing_links SET status='cleared' WHERE id=?").run(link.id);
    }
    db.prepare("UPDATE clearing_rounds SET status='cleared',proof_ciphertext=?,applied_at=? WHERE id=?").run(encrypt(JSON.stringify(evidence)), now(), id);
    return roundDetail(access, id);
  });
}

export function lookupCompany(access: AccessContext, companyId: string) {
  requirePermission(access, "payments:read");
  const value = registration(companyId);
  return { id: value.organization_id, name: row<{ name: string }>("SELECT name FROM organizations WHERE id=?", companyId)!.name, network: value.network, treasuryId: value.treasury_id };
}

export function overview(access: AccessContext) {
  requirePermission(access, "payments:read");
  const links = rows<Link>("SELECT l.* FROM clearing_links l WHERE l.debtor_id=? OR l.creditor_id=? OR EXISTS(SELECT 1 FROM clearing_link_shares s WHERE s.link_id=l.id AND s.organization_id=? AND s.debtor_consent=1 AND s.creditor_consent=1) ORDER BY l.created_at DESC", access.organizationId, access.organizationId, access.organizationId).map(({ terms_ciphertext, ...link }) => {
    const terms = JSON.parse(decrypt(terms_ciphertext));
    return { ...link, terms: link.debtor_id === access.organizationId || link.creditor_id === access.organizationId ? terms : { amount: terms.amount }, shares: rows<{ organization_id: string; debtor_consent: number; creditor_consent: number }>("SELECT organization_id,debtor_consent,creditor_consent FROM clearing_link_shares WHERE link_id=?", link.id) };
  });
  const rounds = rows<{ id: string }>("SELECT r.id FROM clearing_rounds r JOIN clearing_round_participants p ON p.round_id=r.id WHERE p.organization_id=? AND r.mode='debt_discharge_v1' ORDER BY r.created_at DESC", access.organizationId).map(value => roundDetail(access, value.id));
  const bills = rows<{ id: string; reference: string }>("SELECT id,reference FROM bills WHERE organization_id=? ORDER BY created_at DESC", access.organizationId).map(bill => { try { return { id: bill.id, reference: bill.reference, eligible: true, amount: eligibleTerms(access.organizationId, bill.id).amount, reason: null }; } catch (error) { return { id: bill.id, reference: bill.reference, eligible: false, amount: null, reason: error instanceof Error ? error.message : "Not eligible" }; } });
  return { registration: row<Registration>("SELECT * FROM clearing_companies WHERE organization_id=?", access.organizationId) ?? null, setup: readiness(), links, rounds, bills, companyId: access.organizationId, owner: row<{ owner_id: string }>("SELECT owner_id FROM organizations WHERE id=?", access.organizationId)?.owner_id === access.userId };
}

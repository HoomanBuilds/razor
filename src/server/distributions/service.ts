import { reserveOptionalCreation } from "../billing/capabilities";
import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getRecipient, listRecipients, type RecipientRecord } from "../identity/recipients";
import { audit, getAccess } from "../identity/session";
import { contractCodeHash, treasuryAction, view, validNearAccount } from "../payments/near";
import { getTreasury, syncTreasury } from "../payments/service";
import { reviewedArtifactHash } from "../near-artifacts";
import { NATIVE_USDC } from "../../lib/native-usdc";
import type { TreasuryConfig } from "../payments/types";
import { assertChainTerms, distributionInput, pageInput, hash, sumEntitlements, type Allocation, type ChainClaim, type ChainDistribution, type DistributionRow, type FrozenPlan, type Payload, type Policy } from "./model";

const now = () => new Date().toISOString();
const payload = (value: DistributionRow) => JSON.parse(decrypt(value.payload_ciphertext)) as Payload;
const plan = (value: DistributionRow) => value.plan_ciphertext ? JSON.parse(decrypt(value.plan_ciphertext)) as FrozenPlan : null;
function accessFor(access: AccessContext, permission = "payments:read") { const live = getAccess(access.userId, access.organizationId); requirePermission(live, "company:read"); requirePermission(live, permission); return live; }
function owner(access: AccessContext) {
  const live = accessFor(access, "company:manage"); requirePermission(live, "payments:approve");
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", live.organizationId, live.userId)) throw new ApiError(403, "The company owner funds or cancels a distribution", "DISTRIBUTION_OWNER_REQUIRED");
  return live;
}
function local(access: AccessContext, id: string) {
  const value = row<DistributionRow>("SELECT * FROM claim_distributions WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!value) throw new ApiError(404, "Distribution not found", "DISTRIBUTION_NOT_FOUND"); return value;
}
async function configFor(access: AccessContext) {
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config || config.architecture !== "shared_v1") throw new ApiError(409, "Activate the reviewed shared treasury before native distributions", "DISTRIBUTION_TREASURY_REQUIRED");
  if (config.network === "mainnet" && config.token_contract !== NATIVE_USDC.near || await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "Review the native-USDC treasury deployment and code pin", "TREASURY_CODE_MISMATCH");
  return config;
}
function linked(userId: string, config: TreasuryConfig) { return rows<{ address: string }>("SELECT address FROM linked_wallets WHERE user_id=? AND family='near' AND network=? ORDER BY address", userId, config.network).map(item => item.address); }
function nativeProfile(profile: RecipientRecord, token?: string) {
  if (!profile.user_id || profile.archived || profile.preference_status !== "confirmed" || profile.primary_network !== "near" || profile.primary_memo
    || !["USDC", `nep141:${token ?? NATIVE_USDC.near}`].includes(profile.primary_asset) || !validNearAccount(profile.primary_address)) throw new ApiError(409, "Choose a confirmed native NEAR USDC payee with a bound personal account and no memo. Use ordinary push payments for other destinations", "DISTRIBUTION_NATIVE_ONLY");
}
function currentProfiles(access: AccessContext, value: Payload, token: string) {
  return value.items.map(item => {
    const profile = getRecipient(access.organizationId, item.recipientId); nativeProfile(profile, token);
    if (profile.version !== item.recipientVersion || profile.user_id !== item.boundUserId || profile.primary_address !== item.address) throw new ApiError(409, "A distribution payee changed. Cancel this draft and review a new distribution", "DISTRIBUTION_RECIPIENT_CHANGED"); return profile;
  });
}
export function distributionLocalReserve(organizationId: string) { return rows<{ local_reserved: string }>("SELECT local_reserved FROM claim_distributions WHERE organization_id=?", organizationId).reduce((total, item) => total + BigInt(item.local_reserved), 0n).toString(); }
export function createDistribution(access: AccessContext, input: unknown) {
  const live = accessFor(access, "payments:prepare"), parsed = distributionInput.parse(input);
  requirePermission(live, "recipients:read");
  const expiry = Date.parse(parsed.deadline);
  if (expiry <= Date.now() || expiry > Date.now() + 366 * 86400000 || new Set(parsed.items.map(item => item.recipientId)).size !== parsed.items.length) throw new ApiError(422, "Use unique payees and a claim deadline within 366 days", "DISTRIBUTION_INPUT_INVALID");
  const normalized = { reference: parsed.reference, deadline: parsed.deadline, items: [...parsed.items].sort((a, b) => a.recipientId < b.recipientId ? -1 : 1) }, fingerprint = hash(normalized);
  return transaction(db => {
    const existing = row<DistributionRow>("SELECT * FROM claim_distributions WHERE organization_id=? AND request_key=?", live.organizationId, parsed.requestKey);
    if (existing) { if (existing.input_hash !== fingerprint) throw new ApiError(409, "This request identity already names different distribution terms", "DISTRIBUTION_IDEMPOTENCY_CONFLICT"); return summary(existing); }
    if (row("SELECT id FROM claim_distributions WHERE organization_id=? AND reference=?", live.organizationId, parsed.reference)) throw new ApiError(409, "This distribution reference already exists", "DISTRIBUTION_REFERENCE_EXISTS");
    const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", live.organizationId);
    const items: Allocation[] = normalized.items.map(item => { const profile = getRecipient(live.organizationId, item.recipientId); nativeProfile(profile, config?.token_contract); return { claimId: randomUUID(), recipientId: profile.id, recipientVersion: profile.version, boundUserId: profile.user_id!, name: profile.name, address: profile.primary_address, amount: item.amount }; });
    const id = randomUUID(), total = sumEntitlements(items), value: Payload = { reference: parsed.reference, deadline: parsed.deadline, items };
    reserveOptionalCreation(live, "claim_pool", id);
    db.prepare("INSERT INTO claim_distributions(id,organization_id,reference,request_key,input_hash,payload_ciphertext,total_amount,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, live.organizationId, parsed.reference, parsed.requestKey, fingerprint, encrypt(JSON.stringify(value)), total, live.userId, now(), now());
    for (const item of items) db.prepare("INSERT INTO claim_distribution_allocations(id,distribution_id,organization_id,recipient_id,bound_user_id,payload_ciphertext) VALUES(?,?,?,?,?,?)").run(item.claimId, id, live.organizationId, item.recipientId, item.boundUserId, encrypt(JSON.stringify(item)));
    audit(live.userId, live.organizationId, "distribution.drafted", id, { total, mode: "independent_native_claim_pool" }); return summary(local(live, id));
  });
}
function summary(value: DistributionRow) {
  const { payload_ciphertext: _payload, plan_ciphertext: _plan, ...safe } = value;
  return { ...safe, payload: payload(value), network: plan(value)?.network ?? null };
}
export function listDistributions(access: AccessContext, input: unknown = {}) {
  const { page } = pageInput.parse(input);
  const live = accessFor(access), config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", live.organizationId);
  const recipients = live.permissions.includes("recipients:read") ? listRecipients(live.organizationId).filter(profile => { try { nativeProfile(profile, config?.token_contract); return true; } catch { return false; } }).map(profile => ({ id: profile.id, name: profile.name })) : [];
  const total = row<{ total: number }>("SELECT COUNT(*) AS total FROM claim_distributions WHERE organization_id=?", live.organizationId)!.total;
  return { distributions: rows<DistributionRow>("SELECT * FROM claim_distributions WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?", live.organizationId, (page - 1) * 25).map(summary), recipients, page, total, hasMore: page * 25 < total,
    configured: !!config, crossChainClaims: false, mode: "independent_native_claim_pool", privacy: "Allocation accounts and amounts are public in NEAR transaction data. The personal workspace exposes only your own allocations. Ordinary push payroll remains separate." };
}
export function discardDistribution(access: AccessContext, id: string) {
  return transaction(db => {
    const live = accessFor(access, "payments:prepare"), value = local(live, id);
    if (value.created_by !== live.userId && !row("SELECT id FROM organizations WHERE id=? AND owner_id=?", live.organizationId, live.userId)) throw new ApiError(403, "The draft creator or company owner can cancel this draft", "DISTRIBUTION_CREATOR_REQUIRED");
    if (value.stage !== "draft" || value.plan_ciphertext || value.local_reserved !== "0") throw new ApiError(409, "Use the owner-signed NEAR cancellation for a reviewed or uncertain creation", "DISTRIBUTION_CREATION_HELD");
    const changed = db.prepare("UPDATE claim_distributions SET stage='voided',updated_at=? WHERE id=? AND organization_id=? AND stage='draft' AND plan_ciphertext IS NULL AND local_reserved='0'").run(now(), id, live.organizationId);
    if (changed.changes !== 1) throw new ApiError(409, "The draft changed before cancellation. Refresh its current review", "DISTRIBUTION_CREATION_HELD");
    audit(live.userId, live.organizationId, "distribution.draft_cancelled", id); return { cancelled: true };
  });
}
export async function releaseUnsignedDistribution(access: AccessContext, id: string) {
  const live = owner(access), value = local(live, id);
  if (value.stage !== "review" || value.source_tx_hash) throw new ApiError(409, "An initiated wallet request needs authoritative NEAR cancellation or reconciliation", "DISTRIBUTION_CREATION_HELD");
  const config = await configFor(live);
  if (await view<ChainDistribution | null>(config, "get_distribution", { distribution_id: id })) throw new ApiError(409, "A proposal already exists on NEAR. Use its onchain cancellation or reclaim workflow", "DISTRIBUTION_ALREADY_CREATED");
  await syncTreasury(live);
  return transaction(db => {
    owner(live);
    const changed = db.prepare("UPDATE claim_distributions SET stage='voided',local_reserved='0',updated_at=? WHERE id=? AND organization_id=? AND stage='review' AND source_tx_hash IS NULL AND plan_hash=?").run(now(), id, live.organizationId, value.plan_hash);
    if (!changed.changes) throw new ApiError(409, "The wallet request started while releasing this review. Its reservation remains held", "DISTRIBUTION_CREATION_HELD");
    audit(live.userId, live.organizationId, "distribution.unsigned_review_released", id); return { cancelled: true, onchainTransactionRequired: false };
  });
}
interface ClaimObservation { observed_status: string | null; observed_nonce: string }
function staleObservation(): never { throw new ApiError(409, "A newer distribution observation is already recorded. Refresh the original pool or fixed claim; existing backing and wallet fences remain held", "DISTRIBUTION_OBSERVATION_STALE"); }
function claimAdvances(claim: ChainClaim, previous: ClaimObservation) {
  const nonce = BigInt(claim.nonce), seen = BigInt(previous.observed_nonce);
  if (nonce < seen) return false;
  if (["paid", "reclaimed"].includes(previous.observed_status ?? "")) return nonce === seen && claim.status === previous.observed_status;
  if (nonce === seen && previous.observed_status === "ready") return claim.status === "ready" || claim.status === "reclaimed";
  return true;
}
function observeClaim(claim: ChainClaim, previous: ClaimObservation) {
  if (!claimAdvances(claim, previous)) staleObservation();
  const resolved = claim.status !== "ready" || BigInt(claim.nonce) > BigInt(previous.observed_nonce);
  getDb().prepare("UPDATE claim_distribution_allocations SET observed_status=?,source_unknown=CASE WHEN ? THEN 0 ELSE source_unknown END,observed_nonce=? WHERE id=?")
    .run(claim.status, Number(resolved), claim.nonce, claim.allocation.claim_id);
}
function poolAdvances(chain: ChainDistribution, current: DistributionRow) {
  const transitions: Record<string, string[]> = { proposed: ["proposed", "active", "complete", "closed", "cancelled"], active: ["active", "complete", "closed"], complete: ["complete"], closed: ["closed"], cancelled: ["cancelled"] };
  return (!current.chain_status || transitions[current.chain_status]?.includes(chain.status))
    && BigInt(chain.paid) >= BigInt(current.paid_amount) && BigInt(chain.reclaimed) >= BigInt(current.reclaimed_amount)
    && !(current.stage === "voided" && chain.status !== "cancelled");
}
export async function inspectDistribution(access: AccessContext, id: string) {
  const live = accessFor(access), value = local(live, id), frozen = plan(value);
  if (!frozen) return { ...summary(value), chain: null, policy: null, problems: [value.stage === "voided" ? "This unfunded draft was cancelled" : "The owner must review native setup and funding"], eligibleSigners: [] as string[], storage: null, heldClaims: [] as string[] };
  const config = await configFor(live);
  const [chain, voided, policy, storage, receiving] = await Promise.all([view<ChainDistribution | null>(config, "get_distribution", { distribution_id: id }), view<boolean>(config, "distribution_voided", { distribution_id: id }), view<Policy>(config, "get_config"), view<{ storage_credit: string; storage_used: string; storage_available: string }>(config, "get_storage"),
    view<({ version: string; active: boolean; primary: { address: string } } | null)[]>(config, "get_distribution_recipients", { recipient_ids: frozen.allocations.map(item => item.recipient_id) })]);
  await syncTreasury(live);
  if (chain) assertChainTerms(chain, frozen);
  accessFor(live);
  transaction(db => {
    const current = local(live, id);
    if (current.plan_hash !== value.plan_hash) staleObservation();
    if (!chain) {
      if (current.chain_status) staleObservation();
      if (voided) db.prepare("UPDATE claim_distributions SET stage='voided',local_reserved='0',last_error=NULL,updated_at=? WHERE id=? AND organization_id=?").run(now(), id, live.organizationId);
      else db.prepare("UPDATE claim_distributions SET last_error=NULL,updated_at=? WHERE id=? AND organization_id=?").run(now(), id, live.organizationId);
      return;
    }
    if (!poolAdvances(chain, current) || voided && !["proposed", "cancelled"].includes(chain.status)) staleObservation();
    for (const claim of chain.claims) {
      const previous = row<ClaimObservation>("SELECT observed_status,observed_nonce FROM claim_distribution_allocations WHERE id=? AND distribution_id=?", claim.allocation.claim_id, id);
      if (!previous || !claimAdvances(claim, previous)) staleObservation();
    }
    const clear = voided || chain.status !== "proposed";
    db.prepare("UPDATE claim_distributions SET stage=?,local_reserved=CASE WHEN ? THEN '0' ELSE local_reserved END,chain_status=?,chain_reserved=?,pending_amount=?,paid_amount=?,reclaimed_amount=?,last_error=NULL,updated_at=? WHERE id=? AND organization_id=?")
      .run(voided || current.stage === "voided" ? "voided" : "observed", Number(clear), chain.status, chain.unclaimed, chain.pending, chain.paid, chain.reclaimed, now(), id, live.organizationId);
    for (const claim of chain.claims) observeClaim(claim, row<ClaimObservation>("SELECT observed_status,observed_nonce FROM claim_distribution_allocations WHERE id=? AND distribution_id=?", claim.allocation.claim_id, id)!);
  });
  const problems = [];
  if (voided) problems.push("This creation identity was cancelled on NEAR. A delayed creation cannot fund it");
  if (policy.paused || row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", live.organizationId)?.paused) problems.push("Company payments are paused");
  if (chain && chain.policy_version !== policy.policy_version) problems.push("Financial policy or owner changed. Claims are held; reclaim only eligible unclaimed funds after the fixed deadline");
  const heldClaims = chain?.claims.filter((claim, index) => claim.status === "ready" && (!receiving[index]?.active || receiving[index]!.version !== claim.allocation.recipient_version || receiving[index]!.primary.address !== claim.destination)).map(claim => claim.allocation.claim_id) ?? [];
  if (heldClaims.length) problems.push("One or more approved receiving profiles changed. Those claims are held and cannot redirect; reclaim eligible funds only after the deadline");
  if (Date.now() >= Date.parse(payload(value).deadline)) problems.push("The claim deadline passed. Only unclaimed funds can return to company cash; pending transfers remain protected");
  return { ...summary(local(live, id)), chain, policy, problems, heldClaims, storage, eligibleSigners: linked(live.userId, config), network: config.network };
}
export async function prepareDistribution(access: AccessContext, id: string) {
  const live = owner(access), value = local(live, id), data = payload(value), config = await configFor(live), policy = await view<Policy>(config, "get_config");
  if (!linked(live.userId, config).includes(policy.owner_id)) throw new ApiError(403, "Link the company owner's NEAR wallet before reviewing this distribution", "DISTRIBUTION_WALLET_REQUIRED");
  if (policy.paused || row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", live.organizationId)?.paused) throw new ApiError(409, "Company payments are paused", "COMPANY_PAUSED");
  if (value.stage === "signing" || value.stage === "observed" || value.stage === "voided") throw new ApiError(409, "Inspect the existing creation before preparing another action. Uncertain creation can be cancelled on NEAR", "DISTRIBUTION_CREATION_HELD");
  const profiles = currentProfiles(live, data, config.token_contract);
  if (Date.parse(data.deadline) <= Date.now()) throw new ApiError(409, "The distribution deadline passed", "DISTRIBUTION_EXPIRED");
  const recipients = await view<({ version: string; active: boolean; primary: { network: string; asset_id: string; address: string } } | null)[]>(config, "get_distribution_recipients", { recipient_ids: profiles.map(profile => profile.id) });
  const missing = profiles.flatMap((profile, index) => {
    const actual = recipients[index]; return actual?.active && actual.primary.network === "near" && actual.primary.asset_id === `nep141:${config.token_contract}` && actual.primary.address === profile.primary_address ? [] : [{ profile, index }];
  });
  if (missing.length) {
    const actions = [];
    for (const { profile } of missing.slice(0, 5)) {
      const backup = profile.backup_network && profile.backup_address ? await view<string | null>(config, "get_backup_asset", { network: profile.backup_network }) : null;
      if (profile.backup_address && !backup) throw new ApiError(409, "Configure this payee's confirmed USDC backup network in Treasury before binding the profile", "DISTRIBUTION_BACKUP_REQUIRED");
      actions.push(...treasuryAction(config, "set_recipient", { recipient_id: profile.id, primary: { asset_id: `nep141:${config.token_contract}`, network: "near", address: profile.primary_address }, backup: backup ? { asset_id: backup, network: profile.backup_network, address: profile.backup_address } : null, backup_consent: !!profile.fallback_consent, active: true }, "1", "40000000000000").actions);
    }
    return { phase: "recipients" as const, network: config.network, eligibleSigners: [policy.owner_id], walletActions: [{ receiverId: config.near_account_id, actions }], remainingProfiles: missing.length, planHash: null, total: value.total_amount };
  }
  const frozen: FrozenPlan = { network: config.network, treasury: config.near_account_id, companyId: config.company_id!, token: config.token_contract, owner: policy.owner_id, policyVersion: policy.policy_version,
    requiredApprovals: Math.max(...policy.approval_tiers.map(tier => tier.required_approvals)), deadlineMs: String(Date.parse(data.deadline)), id, reference: data.reference, total: value.total_amount,
    allocations: data.items.map((item, index) => ({ claim_id: item.claimId, recipient_id: item.recipientId, recipient_version: recipients[index]!.version, amount: item.amount, destination: item.address })) };
  const planHash = hash(frozen);
  transaction(db => {
    owner(live); const current = local(live, id);
    if (!["draft", "review"].includes(current.stage)) throw new ApiError(409, "The creation is already being submitted", "DISTRIBUTION_CREATION_HELD");
    const treasury = getTreasury(live) as ReturnType<typeof getTreasury> & { distributionLocalReserved?: string };
    const extra = BigInt(distributionLocalReserve(live.organizationId)) - BigInt(treasury.distributionLocalReserved ?? "0");
    if (BigInt(frozen.total) > BigInt(treasury.available) - (extra > 0n ? extra : 0n) + BigInt(current.local_reserved)) throw new ApiError(409, "Fund this pool's full entitlement without using payroll, client or other distribution reserves", "DISTRIBUTION_UNFUNDED");
    db.prepare("UPDATE claim_distributions SET stage='review',local_reserved=?,plan_ciphertext=?,plan_hash=?,updated_at=? WHERE id=?").run(frozen.total, encrypt(JSON.stringify(frozen)), planHash, now(), id);
  });
  return { phase: "fund" as const, network: config.network, eligibleSigners: [policy.owner_id], walletActions: [creationAction(config, frozen)], remainingProfiles: 0, planHash, total: frozen.total, requiredApprovals: frozen.requiredApprovals };
}
function creationAction(config: TreasuryConfig, value: FrozenPlan) { return treasuryAction(config, "create_distribution", { distribution_id: value.id, reference: value.reference, network: value.network, allocations: value.allocations.map(({ destination: _destination, ...allocation }) => allocation), expected_total: value.total, deadline_ms: value.deadlineMs, expected_policy_version: value.policyVersion }, "1", "220000000000000"); }
export async function beginDistribution(access: AccessContext, id: string, input: { planHash: string; signerAccount: string }) {
  const live = owner(access), value = local(live, id), frozen = plan(value);
  if (!frozen || value.plan_hash !== input.planHash || input.signerAccount !== frozen.owner) throw new ApiError(409, "Review the exact funding plan and owner wallet", "DISTRIBUTION_REVIEW_CHANGED");
  const preview = await prepareDistribution(live, id);
  if (preview.phase !== "fund" || preview.planHash !== input.planHash) throw new ApiError(409, "The funding plan changed. Review it again", "DISTRIBUTION_REVIEW_CHANGED");
  transaction(db => { owner(live); const changed = db.prepare("UPDATE claim_distributions SET stage='signing',updated_at=? WHERE id=? AND organization_id=? AND stage='review' AND plan_hash=?").run(now(), id, live.organizationId, input.planHash); if (!changed.changes) throw new ApiError(409, "A wallet request already owns this creation", "DISTRIBUTION_CREATION_HELD"); });
  return { fenced: true };
}
export async function prepareDistributionControl(access: AccessContext, id: string, action: "approve" | "void" | "reclaim", accountId?: string) {
  const live = accessFor(access, action === "approve" ? "payments:approve" : "company:manage"), value = local(live, id), config = await configFor(live);
  const state = await inspectDistribution(live, id), policy = state.policy;
  if (!policy) throw new ApiError(409, "Review native funding first", "DISTRIBUTION_NOT_PREPARED");
  const signer = action === "approve" ? accountId : policy.owner_id;
  if (action !== "approve") owner(live);
  if (!signer || !linked(live.userId, config).includes(signer) || action === "approve" && ![policy.owner_id, ...policy.approvers].includes(signer)) throw new ApiError(403, "Link the authorized NEAR signer for this action", "DISTRIBUTION_WALLET_REQUIRED");
  if (action === "approve" && state.chain?.status !== "proposed") throw new ApiError(409, "Only an unfunded proposal can collect another approval", "DISTRIBUTION_NOT_PROPOSED");
  if (action === "approve" && state.chain?.policy_version !== policy.policy_version) throw new ApiError(409, "The approval policy changed. Cancel the unfunded proposal and review a new distribution", "DISTRIBUTION_POLICY_CHANGED");
  if (action === "void" && state.chain && !["proposed", "cancelled"].includes(state.chain.status)) throw new ApiError(409, "A funded pool cannot be cancelled. After its deadline, return only eligible unclaimed funds", "DISTRIBUTION_ALREADY_FUNDED");
  if (action === "reclaim" && (!state.chain || Date.now() < Number(state.chain.deadline_ms))) throw new ApiError(409, "Wait for the agreed deadline before reclaiming unclaimed funds", "DISTRIBUTION_NOT_EXPIRED");
  if (action === "reclaim" && state.chain && (BigInt(state.chain.unclaimed) === 0n || !["active", "closed"].includes(state.chain.status))) throw new ApiError(409, "No unclaimed funds are available to return. Pending transfers remain protected", "DISTRIBUTION_NOT_RECLAIMABLE");
  const method = action === "approve" ? "approve_distribution" : action === "void" ? "void_distribution" : "reclaim_distribution";
  return { phase: action, network: config.network, eligibleSigners: [signer], walletActions: [treasuryAction(config, method, { distribution_id: id, ...(action !== "void" ? { expected_terms_hash: state.chain!.terms_hash } : {}) }, "1", "180000000000000")], planHash: null, total: value.total_amount };
}

interface OwnAllocation {
  id: string; distribution_id: string; organization_id: string; payload_ciphertext: string; source_unknown: number; observed_nonce: string; observed_status: string | null;
  review_generation: string | null; review_hash: string | null; review_expires_at: string | null; review_consumed: number;
  wallet_lease_generation: string | null; wallet_lease_expires_at: string | null;
}
function ownAllocation(userId: string, id: string) {
  const allocation = row<OwnAllocation>("SELECT a.* FROM claim_distribution_allocations a JOIN claim_distributions d ON d.id=a.distribution_id WHERE a.id=? AND a.bound_user_id=? AND d.chain_status IS NOT NULL", id, userId);
  if (!allocation) throw new ApiError(404, "Claim entitlement not found", "DISTRIBUTION_CLAIM_NOT_FOUND"); return allocation;
}
export function ownDistributionClaims(userId: string, input: unknown = {}) {
  const { page } = pageInput.parse(input), total = row<{ total: number }>("SELECT COUNT(*) AS total FROM claim_distribution_allocations a JOIN claim_distributions d ON d.id=a.distribution_id WHERE a.bound_user_id=? AND d.chain_status IS NOT NULL", userId)!.total;
  return { page, total, hasMore: page * 25 < total, claims: rows<{ id: string; distribution_id: string; organization_id: string; payload_ciphertext: string; observed_status: string | null; source_unknown: number; source_tx_hash: string | null; name: string; reference: string; chain_status: string | null; stage: string }>("SELECT a.*,o.name,d.reference,d.chain_status,d.stage FROM claim_distribution_allocations a JOIN claim_distributions d ON d.id=a.distribution_id JOIN organizations o ON o.id=a.organization_id WHERE a.bound_user_id=? AND d.chain_status IS NOT NULL ORDER BY d.created_at DESC,a.id LIMIT 25 OFFSET ?", userId, (page - 1) * 25)
    .map(item => { const own = JSON.parse(decrypt(item.payload_ciphertext)) as Allocation; const distribution = row<DistributionRow>("SELECT * FROM claim_distributions WHERE id=?", item.distribution_id)!;
      return { id: item.id, distributionId: item.distribution_id, company: item.name, reference: item.reference, amount: own.amount, address: own.address, deadline: payload(distribution).deadline, status: item.observed_status ?? item.chain_status ?? item.stage, sourceUnknown: !!item.source_unknown, reportedTransaction: item.source_tx_hash, network: plan(distribution)?.network ?? null }; }) };
}
export async function inspectOwnClaim(userId: string, id: string) {
  const own = ownAllocation(userId, id), distribution = row<DistributionRow>("SELECT * FROM claim_distributions WHERE id=?", own.distribution_id)!, frozen = plan(distribution);
  const allocation = JSON.parse(decrypt(own.payload_ciphertext)) as Allocation;
  if (!frozen) return { claim: null, amount: allocation.amount, address: allocation.address, network: null, problems: ["The company has not authorized and funded this claim pool"], eligibleSigners: [] as string[] };
  const readAccess: AccessContext = { userId, organizationId: own.organization_id, permissions: ["company:read"] }, config = await configFor(readAccess);
  const [chain, policy, profile] = await Promise.all([view<ChainDistribution | null>(config, "get_distribution", { distribution_id: own.distribution_id }), view<Policy>(config, "get_config"), view<{ version: string; active: boolean; primary: { address: string } } | null>(config, "get_recipient", { recipient_id: allocation.recipientId })]);
  const problems = [];
  if (chain) assertChainTerms(chain, frozen);
  const claim = chain?.claims.find(item => item.allocation.claim_id === id) ?? null;
  if (!chain || chain.status !== "active") problems.push("The pool is not active and funded");
  if (chain && chain.policy_version !== policy.policy_version) problems.push("Company policy changed. New claims are held for company review");
  if (policy.paused || row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", own.organization_id)?.paused) problems.push("The company paused new claims");
  if (Date.now() >= Date.parse(payload(distribution).deadline)) problems.push("The agreed claim deadline passed");
  if (!claim || claim.status !== "ready") problems.push(claim?.status === "pending" ? "The original native transfer is pending. Refresh its contract outcome; a timeout does not create another entitlement" : claim?.status === "paid" ? "The native token callback records this entitlement as paid" : "This entitlement is not available to claim");
  if (claim && (!profile?.active || profile.version !== claim.allocation.recipient_version || profile.primary.address !== claim.destination)) problems.push("The approved receiving profile changed. This claim cannot redirect; ask the company to review it");
  const current = getRecipient(own.organization_id, allocation.recipientId);
  if (current.archived || current.preference_status !== "confirmed" || current.version !== allocation.recipientVersion || current.user_id !== allocation.boundUserId || current.primary_address !== allocation.address) problems.push("Your Razor receiving profile changed. This app will not retry the old allocation. The company must review its onchain receiving record; changing an app profile alone cannot revoke a public onchain claim");
  transaction(() => {
    const previous = ownAllocation(userId, id), current = row<DistributionRow>("SELECT * FROM claim_distributions WHERE id=?", own.distribution_id)!;
    if (current.plan_hash !== distribution.plan_hash || !chain && previous.observed_status || chain && !poolAdvances(chain, current)) staleObservation();
    if (claim) observeClaim(claim, previous);
  });
  const latest = ownAllocation(userId, id);
  return { claim, amount: allocation.amount, address: allocation.address, network: config.network, deadline: payload(distribution).deadline, problems, eligibleSigners: linked(userId, config), sourceUnknown: !!latest.source_unknown, walletLeaseExpiresAt: latest.wallet_lease_expires_at };
}
async function claimPlanFor(userId: string, id: string) {
  const own = ownAllocation(userId, id), state = await inspectOwnClaim(userId, id);
  if (state.problems.length || !state.claim) throw new ApiError(409, state.problems.join(". "), "DISTRIBUTION_CLAIM_HELD");
  if (!state.eligibleSigners.length) throw new ApiError(403, "Link a NEAR wallet to pay claim gas, or ask the company for ordinary push payment support", "DISTRIBUTION_GAS_WALLET_REQUIRED");
  const config = await configFor({ userId, organizationId: own.organization_id, permissions: [] });
  const token = { ...config, near_account_id: config.token_contract };
  const storage = await view<{ total: string } | null>(token, "storage_balance_of", { account_id: state.address });
  const walletActions = [];
  let registrationDeposit = "0";
  if (!storage) {
    const bounds = await view<{ min: string }>(token, "storage_balance_bounds");
    if (!/^\d{1,39}$/.test(bounds.min) || BigInt(bounds.min) > 10n ** 24n) throw new ApiError(502, "Review the token's required storage deposit before claiming", "DISTRIBUTION_STORAGE_INVALID");
    registrationDeposit = bounds.min;
    walletActions.push({ receiverId: config.token_contract, actions: [{ type: "FunctionCall" as const, params: { methodName: "storage_deposit", args: { account_id: state.address, registration_only: true }, gas: "30000000000000", deposit: bounds.min } }] });
  }
  const phase = storage ? "claim" as const : "registration" as const;
  if (storage) walletActions.push(treasuryAction(config, "claim_distribution", { distribution_id: own.distribution_id, claim_id: id }, "0", "120000000000000"));
  return { ...state, phase, walletActions, registrationDeposit, planHash: hash({ phase, claimId: id, nonce: state.claim.nonce, destination: state.address, amount: state.amount, network: state.network, walletActions }) };
}
const CLAIM_REVIEW_MS = 300_000;
const CLAIM_WALLET_LEASE_MS = 120_000;
export async function prepareOwnClaim(userId: string, id: string) {
  const previous = ownAllocation(userId, id);
  if (previous.wallet_lease_expires_at && previous.wallet_lease_expires_at > now()) throw new ApiError(409, "A wallet dialog already owns this fixed claim. Finish that dialog or wait for its short review lease, then refresh the same entitlement", "DISTRIBUTION_WALLET_BUSY");
  const preview = await claimPlanFor(userId, id), reviewGeneration = randomUUID(), reviewExpiresAt = new Date(Date.now() + CLAIM_REVIEW_MS).toISOString();
  const planHash = hash({ reviewGeneration, actionHash: preview.planHash });
  transaction(db => {
    const current = ownAllocation(userId, id);
    if (current.wallet_lease_expires_at && current.wallet_lease_expires_at > now()) throw new ApiError(409, "Another wallet dialog started during review. Refresh the original fixed claim", "DISTRIBUTION_WALLET_BUSY");
    db.prepare("UPDATE claim_distribution_allocations SET review_generation=?,review_hash=?,review_expires_at=?,review_consumed=0,wallet_lease_generation=NULL,wallet_lease_expires_at=NULL WHERE id=? AND bound_user_id=?").run(reviewGeneration, planHash, reviewExpiresAt, id, userId);
  });
  return { ...preview, planHash, reviewGeneration, reviewExpiresAt, retrySameClaim: preview.phase === "claim" && !!preview.sourceUnknown };
}
export async function beginOwnClaim(userId: string, id: string, input: { planHash: string; signerAccount: string; reviewGeneration: string; retrySameClaim?: boolean }) {
  const preview = await claimPlanFor(userId, id);
  if (preview.phase === "claim" && preview.sourceUnknown && input.retrySameClaim !== true) throw new ApiError(409, "Explicitly review retrying this same fixed claim ID and its additional gas costs", "DISTRIBUTION_SAME_CLAIM_REVIEW_REQUIRED");
  if (hash({ reviewGeneration: input.reviewGeneration, actionHash: preview.planHash }) !== input.planHash || !preview.eligibleSigners.includes(input.signerAccount)) throw new ApiError(409, "The fixed claim or its gas signer changed. Review again", "DISTRIBUTION_REVIEW_CHANGED");
  transaction(db => {
    ownAllocation(userId, id);
    const timestamp = now(), leaseUntil = new Date(Date.now() + CLAIM_WALLET_LEASE_MS).toISOString();
    const changed = db.prepare("UPDATE claim_distribution_allocations SET review_consumed=1,wallet_lease_generation=?,wallet_lease_expires_at=?,source_unknown=CASE WHEN ? THEN 1 ELSE source_unknown END WHERE id=? AND bound_user_id=? AND review_generation=? AND review_hash=? AND review_expires_at>? AND review_consumed=0 AND (wallet_lease_expires_at IS NULL OR wallet_lease_expires_at<=?)")
      .run(input.reviewGeneration, leaseUntil, Number(preview.phase === "claim"), id, userId, input.reviewGeneration, input.planHash, timestamp, timestamp);
    if (changed.changes !== 1) throw new ApiError(409, "This review was replaced, expired or already opened a wallet dialog. Refresh and review the same fixed claim", "DISTRIBUTION_REVIEW_CHANGED");
  });
  return { fenced: preview.phase === "claim", phase: preview.phase };
}
export function finishOwnClaimWallet(userId: string, id: string, reviewGeneration: string) {
  ownAllocation(userId, id);
  const changed = getDb().prepare("UPDATE claim_distribution_allocations SET wallet_lease_generation=NULL,wallet_lease_expires_at=NULL WHERE id=? AND bound_user_id=? AND wallet_lease_generation=?").run(id, userId, reviewGeneration);
  return { released: changed.changes === 1 };
}
function validReportedHash(value: string) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(value)) throw new ApiError(422, "Use the NEAR wallet's transaction reference", "DISTRIBUTION_REFERENCE_INVALID"); }
export function recordDistributionWalletReference(access: AccessContext, id: string, transactionHash: string) {
  const live = owner(access); local(live, id); validReportedHash(transactionHash);
  getDb().prepare("UPDATE claim_distributions SET source_tx_hash=COALESCE(source_tx_hash,?),updated_at=? WHERE id=? AND organization_id=?").run(transactionHash, now(), id, live.organizationId);
  audit(live.userId, live.organizationId, "distribution.wallet_reference_reported", id, { transactionHash, verified: false }); return { recorded: true, verified: false };
}
export function recordOwnClaimWalletReference(userId: string, id: string, transactionHash: string, reviewGeneration: string) {
  const own = ownAllocation(userId, id); validReportedHash(transactionHash);
  if (own.review_generation !== reviewGeneration || own.wallet_lease_generation !== reviewGeneration) throw new ApiError(409, "A newer wallet review owns this claim reference", "DISTRIBUTION_REVIEW_CHANGED");
  getDb().prepare("UPDATE claim_distribution_allocations SET source_tx_hash=? WHERE id=? AND bound_user_id=?").run(transactionHash, id, userId);
  audit(userId, own.organization_id, "distribution.claim_wallet_reference_reported", id, { transactionHash, verified: false }); return { recorded: true, verified: false };
}
export async function monitorDistributions(options: { organizationId?: string; maxPools?: number } = {}) {
  const items = rows<{ id: string; organization_id: string; owner_id: string }>("SELECT d.id,d.organization_id,o.owner_id FROM claim_distributions d JOIN organizations o ON o.id=d.organization_id WHERE d.plan_ciphertext IS NOT NULL AND d.stage!='voided' AND (d.chain_status IS NULL OR d.chain_status IN ('proposed','active') OR d.pending_amount!='0' OR d.local_reserved!='0' OR d.chain_reserved!='0') AND (? IS NULL OR d.organization_id=?) ORDER BY d.updated_at,d.id LIMIT ?", options.organizationId ?? null, options.organizationId ?? null, Math.max(1, Math.min(5, options.maxPools ?? 1)));
  let processed = 0, held = 0;
  for (const item of items) {
    try { await inspectDistribution(getAccess(item.owner_id, item.organization_id), item.id); processed++; }
    catch {
      held++;
      getDb().prepare("UPDATE claim_distributions SET last_error=?,updated_at=? WHERE id=? AND organization_id=?").run("Native distribution check is unavailable. Existing backing remains held; refresh or inspect the original NEAR action.", now(), item.id, item.organization_id);
    }
  }
  return { processed, held };
}

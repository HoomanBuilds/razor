import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { getRecipient, listRecipients } from "../identity/recipients";
import { contractCodeHash, treasuryAction, view } from "../payments/near";
import type { TreasuryConfig } from "../payments/types";
import { reviewedArtifactHash } from "../near-artifacts";
import { notify, iso } from "../operations/service";
import { assertNativeSupplier, standingProblems, supplierHash, type StandingGrant, type StandingPolicy, type StandingRow, type StandingTerms } from "./model";

const atomic = z.string().regex(/^[1-9]\d*$/).max(39).refine(value => /^[1-9]\d{0,38}$/.test(value) && BigInt(value) <= (1n << 128n) - 1n);
export const grantInput = z.object({ recipientId: z.string().uuid(), actorAccountId: z.string().min(2).max(64),
  actorPublicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/), perPaymentMaxInput: atomic,
  periodMaxInput: atomic, lifetimeMaxInput: atomic, periodDays: z.number().int().min(1).max(366),
  validFrom: z.string().datetime(), expiresAt: z.string().datetime() });

export async function standingConfig(access: AccessContext) {
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config || config.architecture !== "shared_v1") throw new ApiError(409, "Activate the reviewed shared treasury first", "STANDING_TREASURY_REQUIRED");
  if (await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "Review the current treasury deployment before using standing authority", "TREASURY_CODE_MISMATCH");
  return config;
}
function local(access: AccessContext, id: string) {
  const value = row<StandingRow>("SELECT * FROM standing_mandates WHERE id=? AND organization_id=?", id, access.organizationId);
  if (!value) throw new ApiError(404, "Standing grant not found", "STANDING_NOT_FOUND");
  return value;
}
function owner(access: AccessContext) {
  requirePermission(access, "company:manage");
  if (!row("SELECT id FROM organizations WHERE id=? AND owner_id=?", access.organizationId, access.userId)) throw new ApiError(403, "The company owner manages standing authority", "ONLY_COMPANY_OWNER");
}
function linked(access: AccessContext, config: TreasuryConfig, account: string) {
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, account, config.network)) throw new ApiError(403, "Verify the NEAR wallet required for this action", "STANDING_WALLET_REQUIRED");
}
function audit(access: AccessContext, action: string, id: string, details: unknown) {
  getDb().prepare("INSERT INTO activity(id,organization_id,actor_id,action,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), access.organizationId, access.userId, action, id, JSON.stringify(details), iso());
}
export async function inspectGrant(access: AccessContext, id: string) {
  requirePermission(access, "payments:read");
  const value = local(access, id), config = await standingConfig(access);
  const [grant, policy, activation, recipient] = await Promise.all([
    view<StandingGrant | null>(config, "get_standing_mandate", { mandate_id: id }), view<StandingPolicy>(config, "get_config"),
    view<string | null>(config, "get_recipient_activation", { recipient_id: value.recipient_id }),
    view<{ version: string; active: boolean; primary: StandingGrant["destination"] } | null>(config, "get_recipient", { recipient_id: value.recipient_id })]);
  const profile = getRecipient(access.organizationId, value.recipient_id), problems: string[] = [];
  if (value.invalidated_at || supplierHash(profile) !== value.supplier_profile_hash) problems.push("Supplier profile changed. Review a new grant");
  if (!grant) problems.push("The owner has not confirmed this grant on NEAR");
  else {
    if (!recipient?.active || recipient.version !== grant.terms.recipient_version || recipient.primary.asset_id !== grant.destination.asset_id || recipient.primary.network !== grant.destination.network || recipient.primary.address !== grant.destination.address) problems.push("The onchain supplier recipient changed. Review a new grant");
    if (JSON.stringify(grant.terms) !== JSON.stringify(JSON.parse(value.terms_json))) {
      const expected = JSON.parse(value.terms_json) as StandingTerms;
      if ((Object.keys(expected) as (keyof StandingTerms)[]).some(key => grant.terms[key] !== expected[key])) problems.push("The onchain grant differs from the reviewed proposal");
    }
    if (grant.destination.network !== "near" || grant.destination.asset_id !== `nep141:${config.token_contract}` || grant.destination.address !== profile.primary_address) problems.push("The approved native destination changed");
    problems.push(...standingProblems(grant, policy, activation));
  }
  const nextResetMs = grant ? (BigInt(grant.terms.valid_from_ms) + ((BigInt(Math.max(Date.now(), Number(grant.terms.valid_from_ms))) - BigInt(grant.terms.valid_from_ms)) / BigInt(grant.terms.period_ms) + 1n) * BigInt(grant.terms.period_ms)).toString() : null;
  const currentPeriodIndex = grant && Date.now() >= Number(grant.terms.valid_from_ms) ? (BigInt(Date.now()) - BigInt(grant.terms.valid_from_ms)) / BigInt(grant.terms.period_ms) : 0n;
  const currentPeriodUsedInput = grant && BigInt(grant.period_index) === currentPeriodIndex ? grant.period_used_input : "0";
  return { ...value, currentPeriodUsedInput, terms: JSON.parse(value.terms_json) as StandingTerms, grant, activationMs: activation, nextResetMs, policy, problems, eligible: !problems.length && !!value.enabled, supplierName: profile.name, network: config.network };
}
export async function listGrants(access: AccessContext) {
  requirePermission(access, "payments:read");
  const ids = rows<{ id: string }>("SELECT id FROM standing_mandates WHERE organization_id=? ORDER BY created_at DESC LIMIT 25", access.organizationId);
  const grants = [];
  for (const value of ids) grants.push(await inspectGrant(access, value.id));
  return { grants, suppliers: listRecipients(access.organizationId).filter(profile => profile.kind === "business" && profile.preference_status === "confirmed" && profile.primary_network === "near" && !profile.primary_memo).map(profile => ({ id: profile.id, name: profile.name })), scope: "native_near_usdc_only", crossChainStanding: false, cooldownHours: 24,
    usageRule: "Principal plus the complete approved fee ceiling is permanently charged at submission, including failed transfers. Periods are anchored to valid-from in UTC with no rollover. Replenishment requires a newly reviewed grant.",
    invoiceRule: "Only already accepted, application-approved and funded vendor bills qualify. Purchase commitments remain application review gates. Exact-route owner review remains available." };
}
export async function prepareGrant(access: AccessContext, data: unknown) {
  owner(access);
  const input = grantInput.parse(data), config = await standingConfig(access), policy = await view<StandingPolicy>(config, "get_config");
  linked(access, config, policy.owner_id);
  const profile = getRecipient(access.organizationId, input.recipientId); assertNativeSupplier(profile, config.token_contract);
  if (!policy.executors.includes(input.actorAccountId) || policy.owner_id === input.actorAccountId || policy.approvers.includes(input.actorAccountId)) throw new ApiError(409, "Grant the dedicated actor an executor role before creating its mandate", "DEDICATED_EXECUTOR_REQUIRED");
  const starts = Date.parse(input.validFrom), expiry = Date.parse(input.expiresAt);
  if (expiry <= Date.now() || expiry <= starts || expiry - starts > 366 * 86400000 || BigInt(input.periodMaxInput) < BigInt(input.perPaymentMaxInput) || BigInt(input.lifetimeMaxInput) < BigInt(input.periodMaxInput)) throw new ApiError(422, "Check the grant dates and increasing payment, period and lifetime limits", "STANDING_TERMS_INVALID");
  const recipient = await view<{ version: string; active: boolean; primary: { network: string; asset_id: string; address: string } } | null>(config, "get_recipient", { recipient_id: profile.id });
  const destination = { network: "near", asset_id: `nep141:${config.token_contract}`, address: profile.primary_address };
  const backupAsset = profile.backup_network && profile.backup_address
    ? await view<string | null>(config, "get_backup_asset", { network: profile.backup_network }) : null;
  if (profile.backup_address && !backupAsset) throw new ApiError(409, "Configure the supplier's confirmed backup asset in treasury policy before rebinding its recipient", "STANDING_BACKUP_REGISTRY_REQUIRED");
  const backup = backupAsset ? { network: profile.backup_network!, asset_id: backupAsset, address: profile.backup_address! } : null;
  const terms: StandingTerms = { id: randomUUID(), recipient_id: profile.id, recipient_version: (BigInt(recipient?.version ?? "0") + 1n).toString(), supplier_profile_hash: supplierHash(profile),
    actor_id: input.actorAccountId, actor_public_key: input.actorPublicKey, per_payment_max_input: input.perPaymentMaxInput,
    period_max_input: input.periodMaxInput, lifetime_max_input: input.lifetimeMaxInput, period_ms: String(input.periodDays * 86400000), valid_from_ms: String(starts), expires_at_ms: String(expiry), invoice_condition: "accepted_vendor_bill_application_gate" };
  transaction(db => {
    if (supplierHash(getRecipient(access.organizationId, profile.id)) !== terms.supplier_profile_hash) throw new ApiError(409, "Supplier details changed during review", "SUPPLIER_CHANGED");
    db.prepare("INSERT INTO standing_mandates(id,organization_id,recipient_id,supplier_profile_hash,supplier_version,terms_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(terms.id, access.organizationId, profile.id, terms.supplier_profile_hash, profile.version, JSON.stringify(terms), access.userId, iso(), iso());
    audit(access, "standing.grant_prepared", terms.id, { supplierVersion: profile.version, scope: "native_near_usdc_only" });
    notify(access.organizationId, `standing-proposed:${terms.id}`, "Native supplier authority proposed", "The owner must confirm the receiving details and bounded grant on NEAR. Highest-tier company quorum and a fresh 24-hour recipient delay are required before activation.", terms.id, "payments:read");
  });
  const walletActions = [];
  walletActions.push(treasuryAction(config, "set_recipient", { recipient_id: profile.id, primary: destination, backup, backup_consent: !!profile.fallback_consent, active: true }, "1"));
  walletActions.push(treasuryAction(config, "grant_standing_mandate", { terms }, "1"));
  return { id: terms.id, terms, network: config.network, walletActions, ownerAccount: policy.owner_id, requiredApprovals: Math.max(...policy.approval_tiers.map(tier => tier.required_approvals)), cooldownHours: 24 };
}
export async function prepareApproval(access: AccessContext, id: string, account: string) {
  requirePermission(access, "payments:approve");
  const state = await inspectGrant(access, id), config = await standingConfig(access);
  linked(access, config, account);
  if (state.invalidated_at || supplierHash(getRecipient(access.organizationId, state.recipient_id)) !== state.supplier_profile_hash) throw new ApiError(409, "Supplier details changed. Review a new grant", "SUPPLIER_CHANGED");
  if (!state.grant || ![state.policy.owner_id, ...state.policy.approvers].includes(account)) throw new ApiError(403, "Use a current company approver wallet after the owner grants the mandate", "STANDING_APPROVER_REQUIRED");
  return { id, network: config.network, ownerAccount: account, walletActions: [treasuryAction(config, "approve_standing_mandate", { mandate_id: id, expected_terms_hash: state.grant.terms_hash }, "1")] };
}
export async function observeGrant(access: AccessContext, id: string) {
  owner(access);
  const state = await inspectGrant(access, id);
  if (!state.grant || state.problems.length) throw new ApiError(409, state.problems.join(". "), "STANDING_NOT_ACTIVE");
  transaction(db => {
    if (supplierHash(getRecipient(access.organizationId, state.recipient_id)) !== state.supplier_profile_hash) throw new ApiError(409, "Supplier details changed", "SUPPLIER_CHANGED");
    db.prepare("UPDATE standing_mandates SET enabled=0,updated_at=? WHERE organization_id=? AND recipient_id=?").run(iso(), access.organizationId, state.recipient_id);
    db.prepare("UPDATE standing_mandates SET enabled=1,terms_hash=?,updated_at=? WHERE id=? AND invalidated_at IS NULL").run(state.grant!.terms_hash, iso(), id);
    audit(access, "standing.activation_observed", id, { termsHash: state.grant!.terms_hash, approvals: state.grant!.approvals });
    notify(access.organizationId, `standing-active:${id}`, "Native vendor autopay enabled", "Accepted native-USDC vendor bills may execute within this grant. Inspect usage or pause it in Automation.", id, "company:manage");
  });
  return inspectGrant(access, id);
}
export async function prepareStatus(access: AccessContext, id: string, paused: boolean, revoke: boolean) {
  owner(access);
  local(access, id);
  getDb().prepare("UPDATE standing_mandates SET enabled=0,updated_at=? WHERE id=? AND organization_id=?").run(iso(), id, access.organizationId);
  audit(access, "standing.disabled_locally", id, { paused, revoke });
  const state = await inspectGrant(access, id), config = await standingConfig(access);
  linked(access, config, state.policy.owner_id);
  return { id, network: config.network, ownerAccount: state.policy.owner_id, walletActions: [treasuryAction(config, "set_standing_mandate_status", { mandate_id: id, paused, revoke }, "1")] };
}
export function nativeExecutionHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { row, rows } from "../db";
import { configureTreasury } from "../payments/service";
import { NATIVE_USDC } from "../payments/policy";
import { contractCodeHash, deriveSharedCompanyId, isCompanyBinding, validNearAccount } from "../payments/near";
import { atomic } from "../../lib/money";
import { reviewedArtifactHash } from "../near-artifacts";
import type { WalletTransaction } from "../payments/types";
import { ownerWalletProviders } from "../account-recovery/providers";
import { describeContractUpgradePolicy } from "../near-upgrade-policy";

const Account = z.string().refine(validNearAccount, "Enter a valid NEAR account");
const Amount = z.string().refine(value => { try { atomic(value); return true; } catch { return false; } }, "Use a positive microUSDC amount within the supported range");
const creationFields = z.object({ ownerAccount: Account, slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/, "Use 1 to 24 lowercase letters, digits or hyphens").default("company"), perPaymentLimit: Amount, dailyLimit: Amount });
export const creationInput = creationFields.refine(input => { try { return atomic(input.dailyLimit) >= atomic(input.perPaymentLimit); } catch { return false; } }, { message: "Daily limit must cover the per-payment limit", path: ["dailyLimit"] });
export const recoveryInput = creationFields.pick({ ownerAccount: true, slug: true });
export type CreationInput = z.infer<typeof creationInput>;
type Network = "mainnet" | "testnet";
const Atomic = z.string().refine(value => { try { atomic(value, true); return true; } catch { return false; } });
const Platform = z.object({ architecture: z.literal("shared_v1"), owner_id: Account, token_contract: Account, paused: z.boolean() });
const Quote = z.object({ company_id: z.string(), architecture: z.literal("shared_v1"), token_contract: Account, minimum_deposit: Atomic, storage_bytes: z.union([z.number().int().nonnegative(), Atomic]) });
const Company = z.object({ company_id: z.string(), architecture: z.literal("shared_v1"), owner_id: Account, token_contract: Account, per_payment_limit: Atomic, daily_limit: Atomic });
interface Settings { network: Network; treasuryId: string; treasuryCodeHash: string }

function settings(): Settings {
  const network = process.env.NEAR_NETWORK || "testnet", treasuryId = process.env.NEAR_TREASURY_ID;
  if (network !== "mainnet" && network !== "testnet") throw new ApiError(503, "Choose mainnet or testnet for NEAR_NETWORK", "TREASURY_SETUP_REQUIRED");
  if (!treasuryId || !validNearAccount(treasuryId)) throw new ApiError(503, "Configure the deployed shared NEAR_TREASURY_ID to enable company registration", "TREASURY_SETUP_REQUIRED");
  return { network, treasuryId, treasuryCodeHash: reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm") };
}

async function rpc<T>(config: Settings, method: string, params: unknown): Promise<T> {
  const response = await fetch(process.env.NEAR_RPC_URL || `https://rpc.${config.network}.near.org`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "razor-onboarding", method, params }), cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new ApiError(503, "NEAR is unavailable. Refresh company registration before trying again.", "NEAR_UNAVAILABLE");
  const result = await response.json();
  if (result.error) throw new ApiError(422, "NEAR could not verify the shared treasury. Check its network and account.", "TREASURY_VERIFICATION_FAILED");
  return result.result as T;
}

async function view<T>(config: Settings, method: string, args: object = {}): Promise<T> {
  const response = await rpc<{ result: number[] }>(config, "query", { request_type: "call_function", finality: "final", account_id: config.treasuryId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  try { return JSON.parse(Buffer.from(response.result).toString()) as T; } catch { throw new ApiError(502, "The shared treasury returned an invalid response", "TREASURY_RESPONSE_INVALID"); }
}

async function verifiedPlatform() {
  const config = settings();
  const [status, account, response] = await Promise.all([rpc<{ chain_id: string }>(config, "status", []), rpc<{ code_hash: string }>(config, "query", { request_type: "view_account", finality: "final", account_id: config.treasuryId }), view(config, "get_platform_config")]);
  if (status.chain_id !== config.network) throw new ApiError(503, "The configured NEAR RPC uses a different network", "TREASURY_NETWORK_MISMATCH");
  if (account.code_hash !== config.treasuryCodeHash) throw new ApiError(503, "The deployed treasury code differs from the reviewed artifact", "TREASURY_CODE_MISMATCH");
  if (process.env.NEAR_CONTRACT_UPGRADE_POLICY && process.env.NEAR_CONTRACT_UPGRADE_POLICY !== "immutable") {
    const checkedHash = await contractCodeHash({ near_account_id: config.treasuryId, network: config.network });
    if (checkedHash !== config.treasuryCodeHash) throw new ApiError(503, "The deployed treasury code differs from the reviewed artifact", "TREASURY_CODE_MISMATCH");
  }
  const parsed = Platform.safeParse(response);
  if (!parsed.success) throw new ApiError(502, "The contract does not expose the reviewed shared treasury architecture", "TREASURY_RESPONSE_INVALID");
  if (config.network === "mainnet" && parsed.data.token_contract !== NATIVE_USDC.near) throw new ApiError(503, "Mainnet registration requires verified native USDC on NEAR", "SETTLEMENT_TOKEN_MISMATCH");
  return { config, platform: parsed.data, upgradePolicy: describeContractUpgradePolicy(config.treasuryId) };
}

function verifiedOwner(access: AccessContext, owner: string, network: Network) {
  requirePermission(access, "company:manage");
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, owner, network)) throw new ApiError(403, "Link and verify the NEAR wallet that will own this company treasury", "TREASURY_OWNER_UNVERIFIED");
}

export function deriveTreasuryAccount(owner: string, slug: string, factory: string): string {
  const suffix = createHash("sha256").update(owner).digest("hex").slice(0, 16), account = `${slug}-${suffix}.${factory}`;
  if (!validNearAccount(account)) throw new ApiError(422, "This legacy treasury name is longer than NEAR allows", "TREASURY_ACCOUNT_TOO_LONG");
  return account;
}

function companyIdFor(access: AccessContext, owner: string): string {
  const stored = row<{architecture: string; company_id: string | null}>("SELECT architecture,company_id FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!stored) return deriveSharedCompanyId(access.organizationId, owner);
  if (stored.architecture !== "shared_v1" || !isCompanyBinding(access.organizationId, stored.company_id)) throw new ApiError(409, "Existing isolated treasury funds need an explicit migration", "TREASURY_CHANGE_REQUIRES_MIGRATION");
  return stored.company_id!;
}

async function companyRecord(config: Settings, companyId: string, ownerAccount: string, slug: string) {
  const response = await view(config, "get_company", { company_id: companyId });
  if (response === null) return null;
  const parsed = Company.safeParse(response);
  if (!parsed.success) throw new ApiError(502, "The company registration response is invalid", "TREASURY_RESPONSE_INVALID");
  const company = parsed.data;
  if (company.company_id !== companyId || company.owner_id !== ownerAccount) throw new ApiError(409, "This company registration belongs to another owner or organization", "REGISTRATION_TERMS_MISMATCH");
  return { ...company, account_id: config.treasuryId, slug, status: "ready" as const, treasury_funding: "0", factory_storage_fee: "0", refund_amount: "0", generation: "1", created_at_ms: "0" };
}

export async function getOnboardingConfig(access: AccessContext) {
  requirePermission(access, "company:manage");
  const network = process.env.NEAR_NETWORK || "testnet", verifiedWallets = rows<{ address: string; network: string }>("SELECT address,network FROM linked_wallets WHERE user_id=? AND family='near' AND network=?", access.userId, network);
  const common = { upgradePolicy: null as ReturnType<typeof describeContractUpgradePolicy> | null, architecture: "shared_v1", companyId: row<{company_id: string | null}>("SELECT company_id FROM treasury_config WHERE organization_id=?", access.organizationId)?.company_id ?? null, network, verifiedWallets, ownerWalletSetup: { ...ownerWalletProviders(network), needsWallet: !verifiedWallets.length, mode: "native_near_signer" } };
  try {
    const { config, platform, upgradePolicy } = await verifiedPlatform();
    return { ...common, ready: !platform.paused, treasuryId: config.treasuryId, factoryId: config.treasuryId, settlementEnabled: network === "mainnet", upgradePolicy, factory: { ...platform, treasury_wasm_hash: config.treasuryCodeHash, treasury_funding: "0", factory_storage_fee: "0", minimum_deposit: "0" }, reason: platform.paused ? "New company registration is paused. Existing treasury records remain available." : null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { ...common, ready: false, treasuryId: process.env.NEAR_TREASURY_ID || null, factoryId: process.env.NEAR_TREASURY_ID || null, settlementEnabled: false, reason: error.message, code: error.code };
  }
}

export async function quoteTreasury(access: AccessContext, input: CreationInput) {
  requirePermission(access, "company:manage");
  const parsed = creationInput.parse(input), { config, platform, upgradePolicy } = await verifiedPlatform();
  verifiedOwner(access, parsed.ownerAccount, config.network);
  if (platform.paused) throw new ApiError(409, "New company registration is paused", "TREASURY_PAUSED");
  const companyId = companyIdFor(access, parsed.ownerAccount);
  const connected = row<{ near_account_id: string; network: string; architecture: string; company_id: string | null }>("SELECT near_account_id,network,architecture,company_id FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (connected && (connected.near_account_id !== config.treasuryId || connected.network !== config.network || connected.architecture !== "shared_v1" || connected.company_id !== companyId)) throw new ApiError(409, "This company already has an isolated treasury. Its funds must be migrated explicitly before shared registration can replace it.", "TREASURY_CHANGE_REQUIRES_MIGRATION");
  const [response, creation] = await Promise.all([view(config, "quote_registration", { company_id: companyId }), companyRecord(config, companyId, parsed.ownerAccount, parsed.slug)]);
  const quoted = Quote.parse(response);
  if (quoted.company_id !== companyId || quoted.token_contract !== platform.token_contract) throw new ApiError(502, "The registration quote does not match this company and settlement token", "REGISTRATION_TERMS_MISMATCH");
  const quote = { architecture: "shared_v1", companyId, accountId: config.treasuryId, ownerAccount: parsed.ownerAccount, slug: parsed.slug, tokenContract: platform.token_contract, treasuryCodeHash: config.treasuryCodeHash, factoryCodeHash: config.treasuryCodeHash, minimumDeposit: quoted.minimum_deposit, treasuryFunding: "0", factoryStorageFee: quoted.minimum_deposit, storageBytes: String(quoted.storage_bytes), perPaymentLimit: parsed.perPaymentLimit, dailyLimit: parsed.dailyLimit, network: config.network, treasuryId: config.treasuryId, factoryId: config.treasuryId, upgradePolicy };
  return { quote: { ...quote, hash: createHash("sha256").update(JSON.stringify(quote)).digest("hex") }, creation };
}

export async function prepareTreasury(access: AccessContext, input: CreationInput, quoteHash: string) {
  const result = await quoteTreasury(access, input);
  if (result.quote.hash !== quoteHash) throw new ApiError(409, "Registration terms changed. Review a fresh storage quote before signing.", "CREATION_QUOTE_CHANGED");
  if (result.creation) throw new ApiError(409, "This company is already registered. Reconcile it to connect the treasury.", "CREATION_ALREADY_REQUESTED");
  const walletActions: WalletTransaction[] = [{ receiverId: result.quote.treasuryId, actions: [{ type: "FunctionCall", params: { methodName: "register_company", args: { company_id: result.quote.companyId, per_payment_limit: result.quote.perPaymentLimit, daily_limit: result.quote.dailyLimit }, deposit: result.quote.minimumDeposit, gas: "100000000000000" } }] }];
  return { ...result, walletActions };
}

export async function reconcileTreasury(access: AccessContext, input: z.infer<typeof recoveryInput>) {
  requirePermission(access, "company:manage");
  const parsed = recoveryInput.parse(input), { config, platform } = await verifiedPlatform();
  verifiedOwner(access, parsed.ownerAccount, config.network);
  const companyId = companyIdFor(access, parsed.ownerAccount);
  const creation = await companyRecord(config, companyId, parsed.ownerAccount, parsed.slug);
  if (!creation) return { status: "not_requested", creation: null, configured: false };
  if (creation.token_contract !== platform.token_contract) throw new ApiError(409, "The registration uses another settlement token", "REGISTRATION_TERMS_MISMATCH");
  const treasury = await configureTreasury(access, { nearAccountId: config.treasuryId, network: config.network, tokenContract: platform.token_contract, companyId });
  return { status: "ready", creation, configured: true, treasury };
}

export async function prepareCreationRefund(access: AccessContext, input: z.infer<typeof recoveryInput>) {
  requirePermission(access, "company:manage");
  recoveryInput.parse(input);
  throw new ApiError(409, "Shared company registration does not create a child account or a pending deployment refund", "CREATION_REFUND_UNAVAILABLE");
}

import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { activity } from "../business/service";
import { getDb, row, rows, transaction } from "../db";
import { encrypt } from "../identity/crypto";
import { atomic } from "../../lib/money";
import { getSupportedTokens, type Token } from "../payments/intents";
import { contractCodeHash, nearTransactionStatus, validNearAccount, verifyTokenReceipt, view } from "../payments/near";
import { reviewedArtifactHash } from "../near-artifacts";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import { eligibleRetainedTokens, indicativeValue, verifyMetadata } from "./policy";
import type { RetainedAsset, RetainedPreview, TokenMetadata } from "./types";
import { inspectRetainedWithdrawal } from "./withdrawal-proof";

interface ContractConfig { owner_id: string; token_contract: string; paused: boolean; retained_assets_enabled: boolean; max_retained_assets: number }
interface State { config: TreasuryConfig; contract: ContractConfig; localPaused: boolean }
const amount = (value: string) => { try { return atomic(value).toString(); } catch { throw new ApiError(422, "Enter a positive integer token amount within the supported range", "INVALID_AMOUNT"); } };
const action = (receiverId: string, methodName: string, args: object, deposit = "1", gas = "100000000000000"): WalletTransaction => ({ receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }] });

async function state(access: AccessContext): Promise<State> {
  requirePermission(access, "company:read");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) throw new ApiError(409, "Connect the company NEAR treasury first", "TREASURY_SETUP_REQUIRED");
  if (await contractCodeHash(config) !== reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm")) throw new ApiError(409, "This treasury does not run the reviewed retained-asset contract", "TREASURY_CODE_MISMATCH");
  const contract = await view<ContractConfig>(config, "get_config");
  if (contract.token_contract !== config.token_contract || contract.retained_assets_enabled !== true || contract.max_retained_assets !== 16) throw new ApiError(409, "Use a newly deployed treasury with reviewed retained-asset support", "RETAINED_ASSETS_UNAVAILABLE");
  return { config, contract, localPaused: !!row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", access.organizationId)?.paused };
}

function owner(access: AccessContext, current: State): string {
  requirePermission(access, "company:manage");
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, current.contract.owner_id, current.config.network)) throw new ApiError(403, "Verify the current NEAR treasury owner wallet first", "OWNER_WALLET_REQUIRED");
  return current.contract.owner_id;
}
function running(current: State) {
  if (current.localPaused || current.contract.paused) throw new ApiError(409, "Company or NEAR treasury execution is paused", "PAYMENTS_PAUSED");
}
function holder(access: AccessContext, current: State, accountId: string) {
  if (!validNearAccount(accountId) || !row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, accountId, current.config.network)) throw new ApiError(403, "Choose a verified NEAR token holder wallet on this network", "TOKEN_HOLDER_WALLET_REQUIRED");
}
function checkedAsset(asset: RetainedAsset | null, current: State, tokenContract: string): RetainedAsset {
  if (!asset || asset.token_contract !== tokenContract || tokenContract === current.config.token_contract || asset.asset_id !== `nep141:${tokenContract}` || !validNearAccount(tokenContract) || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 38 || !asset.symbol || asset.symbol.length > 32) throw new ApiError(409, "This token is not an approved retained NEAR asset", "RETAINED_ASSET_UNAPPROVED");
  try { atomic(asset.balance, true); atomic(asset.in_flight, true); atomic(asset.balance_epoch, true); } catch { throw new ApiError(409, "The treasury returned an invalid retained balance", "RETAINED_BALANCE_INVALID"); }
  return asset;
}
async function asset(current: State, tokenContract: string) {
  return checkedAsset(await view<RetainedAsset | null>(current.config, "get_retained_asset", { token_contract: tokenContract }), current, tokenContract);
}
async function liveToken(current: State, tokenContract: string): Promise<{ token: Token; metadata: TokenMetadata }> {
  if (current.config.network !== "mainnet") throw new ApiError(409, "The live supported NEAR asset catalog is for mainnet. Retained deposits are unavailable on testnet", "RETAINED_MAINNET_REQUIRED");
  const token = eligibleRetainedTokens(await getSupportedTokens(true), current.config.token_contract).find((item) => item.contractAddress === tokenContract);
  if (!token) throw new ApiError(422, "Choose a currently supported NEAR NEP-141 token other than company payment USDC", "RETAINED_ASSET_UNSUPPORTED");
  const metadata = await view<TokenMetadata>({ ...current.config, near_account_id: tokenContract }, "ft_metadata");
  verifyMetadata(token, metadata);
  return { token, metadata };
}
async function storageActions(current: State, tokenContract: string, receiverId: string) {
  const token = { ...current.config, near_account_id: tokenContract };
  if (await view(token, "storage_balance_of", { account_id: receiverId })) return [];
  const bounds = await view<{ min: string }>(token, "storage_balance_bounds");
  let cost: string;
  try { cost = atomic(bounds.min, true).toString(); } catch { throw new ApiError(502, "The token returned an invalid storage registration price", "TOKEN_STORAGE_INVALID"); }
  return [action(tokenContract, "storage_deposit", { account_id: receiverId, registration_only: true }, cost, "30000000000000")];
}
function preview(current: State, selected: RetainedAsset | { token_contract: string; asset_id: string; symbol: string; decimals: number }, signerAccount: string, kind: RetainedPreview["kind"], message: string, walletActions: WalletTransaction[]): RetainedPreview {
  return { kind, network: current.config.network, signerAccount, tokenContract: selected.token_contract, assetId: selected.asset_id, symbol: selected.symbol, decimals: selected.decimals, expiresAt: new Date(Date.now() + 120_000).toISOString(), message, walletActions };
}

export async function retainedOverview(access: AccessContext) {
  const current = await state(access);
  let catalog: Token[] = [], catalogUnavailable = false, catalogObservedAt: string | undefined;
  try { catalog = await getSupportedTokens(true); catalogObservedAt = new Date().toISOString(); } catch { catalogUnavailable = true; }
  const eligible = current.config.network === "mainnet" ? eligibleRetainedTokens(catalog, current.config.token_contract) : [];
  const registered = await view<RetainedAsset[]>(current.config, "get_retained_assets");
  if (!Array.isArray(registered) || registered.length > 16 || new Set(registered.map((item) => item.token_contract)).size !== registered.length) throw new ApiError(502, "The treasury returned an invalid retained-asset registry", "RETAINED_REGISTRY_INVALID");
  const holdings = await Promise.all(registered.map(async (item) => {
    const selected = checkedAsset(item, current, item.token_contract), tokenConfig = { ...current.config, near_account_id: selected.token_contract };
    const [quantityResult, metadataResult] = await Promise.allSettled([view<string>(tokenConfig, "ft_balance_of", { account_id: current.config.near_account_id }), view<TokenMetadata>(tokenConfig, "ft_metadata")]);
    let observedBalance: string | null = null;
    if (quantityResult.status === "fulfilled") try { observedBalance = atomic(quantityResult.value, true).toString(); } catch {}
    const token = eligible.find((value) => value.contractAddress === selected.token_contract);
    const metadata = metadataResult.status === "fulfilled" ? metadataResult.value : null;
    let identityVerified = false;
    if (token && metadata) try { verifyMetadata(token, metadata); identityVerified = token.assetId === selected.asset_id && token.decimals === selected.decimals && token.symbol === selected.symbol; } catch {}
    const pending = selected.in_flight !== "0";
    const reconciliationRequired = !pending && observedBalance !== null && observedBalance !== selected.balance;
    const indicativeValueMicroUsd = identityVerified && !pending && observedBalance !== null ? indicativeValue(observedBalance, selected.decimals, token!.price, token!.priceUpdatedAt ?? catalogObservedAt) : null;
    return { ...selected, observedBalance, observedAt: observedBalance === null ? null : new Date().toISOString(), reconciliationRequired, identityVerified, currentlySupported: !!token, indicativeValueMicroUsd, priceUpdatedAt: indicativeValueMicroUsd === null ? null : token!.priceUpdatedAt ?? null, priceObservedAt: indicativeValueMicroUsd === null ? null : catalogObservedAt ?? null, observationError: observedBalance === null ? "The token balance could not be observed. Do not infer a deposit or withdrawal from this view." : null };
  }));
  const events = rows<{ id: string; token_contract: string; amount: string; event_type: string; transaction_hash: string; created_at: string }>("SELECT id,token_contract,amount,event_type,transaction_hash,created_at FROM retained_asset_events WHERE organization_id=? ORDER BY created_at DESC LIMIT 20", access.organizationId);
  const canManage = access.permissions.includes("company:manage") && !!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, current.contract.owner_id, current.config.network);
  return { configured: true, network: current.config.network, treasuryAccount: current.config.near_account_id, ownerAccount: current.contract.owner_id, paused: current.localPaused || current.contract.paused, canManage, canDeposit: access.permissions.includes("payments:prepare"), catalogUnavailable, supportedTokens: eligible, holdings, events, scope: "Retained NEAR NEP-141 tokens. Quantities and indicative valuations never add to spendable company USDC or payment reserves." };
}

export async function prepareRetainedPolicy(access: AccessContext, input: { tokenContract: string; enabled: boolean }) {
  const current = await state(access), signer = owner(access, current);
  if (input.enabled) running(current);
  const existing = await view<RetainedAsset | null>(current.config, "get_retained_asset", { token_contract: input.tokenContract });
  let selected: Pick<RetainedAsset, "token_contract" | "asset_id" | "symbol" | "decimals">;
  if (input.enabled) {
    if (!existing) {
      const registered = await view<RetainedAsset[]>(current.config, "get_retained_assets");
      if (!Array.isArray(registered) || registered.length >= current.contract.max_retained_assets) throw new ApiError(409, "This treasury has reached its retained-token registry limit. Existing tokens remain visible and withdrawable", "RETAINED_ASSET_LIMIT");
    }
    const { token } = await liveToken(current, input.tokenContract);
    selected = { token_contract: token.contractAddress!, asset_id: token.assetId, symbol: token.symbol, decimals: token.decimals };
    if (existing && (existing.asset_id !== selected.asset_id || existing.symbol !== selected.symbol || existing.decimals !== selected.decimals)) throw new ApiError(409, "The registered token identity is immutable. Retire deposits and withdraw its remaining units before using a different token", "RETAINED_IDENTITY_CHANGED");
  } else selected = checkedAsset(existing, current, input.tokenContract);
  activity(access, "retained.policy_prepared", input.tokenContract, { enabled: input.enabled });
  return { ...preview(current, selected, signer, "allow", input.enabled ? "Approve this exact NEAR token contract for retained deposits. It will remain separate from USDC payment cash." : "Disable further retained deposits. Existing quantities stay visible and the owner can still withdraw them.", [action(current.config.near_account_id, "set_retained_asset", { token_contract: selected.token_contract, asset_id: selected.asset_id, symbol: selected.symbol, decimals: selected.decimals, enabled: input.enabled })]), enabled: input.enabled };
}

export async function prepareRetainedDeposit(access: AccessContext, input: { tokenContract: string; senderAccountId: string; amount: string }) {
  requirePermission(access, "payments:prepare");
  const current = await state(access); running(current); holder(access, current, input.senderAccountId);
  const selected = await asset(current, input.tokenContract), value = amount(input.amount), { token } = await liveToken(current, input.tokenContract);
  if (!selected.enabled || token.assetId !== selected.asset_id || token.decimals !== selected.decimals || token.symbol !== selected.symbol) throw new ApiError(409, "This token's retained deposits are disabled or its identity changed", "RETAINED_DEPOSITS_DISABLED");
  if (selected.in_flight !== "0") throw new ApiError(409, "Wait for this token's pending withdrawal to be reconciled before depositing", "RETAINED_WITHDRAWAL_PENDING");
  const sourceBalance = await view<string>({ ...current.config, near_account_id: input.tokenContract }, "ft_balance_of", { account_id: input.senderAccountId });
  if (atomic(sourceBalance, true) < BigInt(value)) throw new ApiError(409, "The connected NEAR token holder has insufficient units. Native NEAR is not automatically wrapped", "RETAINED_SOURCE_BALANCE_LOW");
  const actions = await storageActions(current, selected.token_contract, current.config.near_account_id);
  const instructions = { method: "ft_transfer_call" as const, receiver_id: current.config.near_account_id, amount: value, msg: "razor:retain" as const, attachedYoctoNear: "1" as const, gas: "100000000000000" };
  actions.push(action(selected.token_contract, instructions.method, { receiver_id: instructions.receiver_id, amount: value, msg: instructions.msg }, "1", instructions.gas));
  activity(access, "retained.deposit_prepared", input.tokenContract);
  return { ...preview(current, selected, input.senderAccountId, "deposit", "Transfer only this NEAR NEP-141 token. Use ft_transfer_call with the exact message. The deposit does not create USDC payment credit.", actions), amount: value, receiver: current.config.near_account_id, instructions };
}

export async function prepareRetainedWithdrawal(access: AccessContext, input: { tokenContract: string; receiverId: string; amount: string }) {
  const current = await state(access), signer = owner(access, current); running(current); holder(access, current, input.receiverId);
  const selected = await asset(current, input.tokenContract), value = amount(input.amount);
  if (selected.in_flight !== "0") throw new ApiError(409, "Reconcile the earlier retained-token withdrawal before preparing another", "RETAINED_WITHDRAWAL_PENDING");
  const actual = atomic(await view<string>({ ...current.config, near_account_id: selected.token_contract }, "ft_balance_of", { account_id: current.config.near_account_id }), true);
  if (actual !== BigInt(selected.balance) || selected.confirmed_at_ms === "0") throw new ApiError(409, "Refresh this retained balance in the NEAR treasury before withdrawal", "RETAINED_RECONCILIATION_REQUIRED");
  if (BigInt(value) > actual) throw new ApiError(409, "Withdrawal exceeds the observed retained token quantity", "INSUFFICIENT_RETAINED_BALANCE");
  const actions = await storageActions(current, selected.token_contract, input.receiverId);
  actions.push(action(current.config.near_account_id, "withdraw_retained_asset", { token_contract: selected.token_contract, receiver_id: input.receiverId, amount: value, expected_epoch: selected.balance_epoch }));
  activity(access, "retained.withdrawal_prepared", input.tokenContract);
  return { ...preview(current, selected, signer, "withdraw", "Withdraw retained token units to your verified NEAR wallet. No conversion or USDC payment credit occurs. The contract refuses withdrawals while paused or another withdrawal is unresolved.", actions), amount: value, receiver: input.receiverId };
}

export async function prepareRetainedRefresh(access: AccessContext, tokenContract: string) {
  const current = await state(access), signer = owner(access, current), selected = await asset(current, tokenContract);
  if (selected.in_flight !== "0") throw new ApiError(409, "A balance observation cannot close an unresolved withdrawal. Review its final source receipt first", "RETAINED_WITHDRAWAL_PENDING");
  return preview(current, selected, signer, "refresh", "Observe the configured token contract's actual treasury balance. This never changes USDC payment cash.", [action(current.config.near_account_id, "refresh_retained_balance", { token_contract: tokenContract }, "0", "50000000000000")]);
}

export async function verifyRetainedDeposit(access: AccessContext, input: { tokenContract: string; senderAccountId: string; amount: string; transactionHash: string }) {
  requirePermission(access, "payments:prepare");
  const current = await state(access); holder(access, current, input.senderAccountId);
  const selected = await asset(current, input.tokenContract), value = amount(input.amount);
  const proof = await verifyTokenReceipt({ ...current.config, token_contract: selected.token_contract }, input.transactionHash, input.senderAccountId, current.config.near_account_id, value);
  transaction(db => {
    for (const event of proof.events) db.prepare("INSERT OR IGNORE INTO retained_asset_events(id,organization_id,event_key,event_type,token_contract,amount,transaction_hash,proof_ciphertext,actor_id,created_at) VALUES(?,?,?,'deposit_verified',?,?,?,?,?,?)")
      .run(randomUUID(), access.organizationId, `${current.config.network}:${selected.token_contract}:${event.receiptId}:${event.logIndex}:${event.dataIndex}`, selected.token_contract, event.amount, input.transactionHash, encrypt(JSON.stringify(proof)), access.userId, new Date().toISOString());
  });
  return { receipt: proof, holdings: await retainedOverview(access), message: "The final NEAR token receipt is verified. Retained quantities come from token balance observations; company USDC and payment reserves are unchanged." };
}

export async function prepareRetainedRecovery(access: AccessContext, input: { tokenContract: string; transactionHash: string; senderAccountId: string }) {
  const current = await state(access), signer = owner(access, current), selected = await asset(current, input.tokenContract);
  if (selected.in_flight === "0" || selected.withdrawal?.status !== "pending") throw new ApiError(409, "No retained withdrawal needs callback recovery", "RETAINED_RECOVERY_NOT_REQUIRED");
  const result = await nearTransactionStatus(current.config, input.transactionHash, input.senderAccountId);
  const proof = inspectRetainedWithdrawal(result, current.config, selected);
  const receipt = JSON.stringify({ transaction_hash: proof.transactionHash, receipt_id: proof.tokenReceiptId, succeeded: proof.succeeded });
  activity(access, "retained.recovery_prepared", selected.token_contract, { withdrawalId: selected.withdrawal.id });
  return { ...preview(current, selected, signer, "recovery", "The application verified a final token-transfer receipt. The contract trusts the owner's explicit outcome attestation, then observes the token balance. No timeout or balance probe alone proves closure.", [action(current.config.near_account_id, "recover_retained_withdrawal", { token_contract: selected.token_contract, withdrawal_id: selected.withdrawal.id, succeeded: proof.succeeded, receipt }, "1", "100000000000000")]), proof };
}

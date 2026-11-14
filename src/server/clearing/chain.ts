import { ApiError } from "../context";
import { reviewedArtifactHash } from "../near-artifacts";
import { validNearAccount } from "../payments/near";
import { NATIVE_USDC } from "../payments/policy";
import type { ChainRound, FinalEvidence, Registration } from "./types";

export function settings() {
  const network = process.env.NEAR_NETWORK || "testnet", contractId = process.env.NEAR_CLEARING_ID, treasuryId = process.env.NEAR_TREASURY_ID;
  if ((network !== "mainnet" && network !== "testnet") || !contractId || !treasuryId || !validNearAccount(contractId) || !validNearAccount(treasuryId)) throw new ApiError(503, "Configure the reviewed NEAR clearing contract and shared treasury on one network", "CLEARING_SETUP_REQUIRED");
  return { network: network as "mainnet" | "testnet", contractId, treasuryId, codeHash: reviewedArtifactHash("NEAR_CLEARING_CODE_HASH", "razor_clearing.wasm"), treasuryHash: reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm") };
}

export function readiness() {
  try { return { configured: true as const, ...settings(), limitation: "Configuration is not deployment or settlement evidence" }; }
  catch (error) { return { configured: false as const, reason: error instanceof Error ? error.message : "Configure NEAR clearing" }; }
}

async function rpc<T>(network: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(process.env.NEAR_RPC_URL || `https://rpc.${network}.near.org`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "razor-clearing", method, params }), signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (!response.ok) throw new ApiError(503, "NEAR clearing verification is unavailable", "NEAR_UNAVAILABLE");
  const payload = await response.json();
  if (payload.error) throw new ApiError(409, "The NEAR clearing state could not be verified", "CLEARING_VERIFICATION_FAILED");
  return payload.result as T;
}

export async function finalContext(blockHeight?: number) {
  const config = settings();
  const [status, block] = await Promise.all([rpc<{ chain_id: string }>(config.network, "status", []), rpc<{ header: { hash: string; height: number; timestamp_nanosec: string } }>(config.network, "block", blockHeight === undefined ? { finality: "final" } : { block_id: blockHeight })]);
  if (status.chain_id !== config.network || !block.header.hash || !Number.isSafeInteger(block.header.height) || blockHeight !== undefined && block.header.height !== blockHeight || !/^\d+$/.test(block.header.timestamp_nanosec)) throw new ApiError(503, "The NEAR network or final block could not be established", "CLEARING_NETWORK_MISMATCH");
  const query = <T>(accountId: string, request: Record<string, unknown>) => rpc<T>(config.network, "query", { ...request, account_id: accountId, block_id: block.header.hash });
  const view = async <T>(accountId: string, method: string, args: unknown = {}) => {
    const value = await query<{ result: number[] }>(accountId, { request_type: "call_function", method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    try { return JSON.parse(Buffer.from(value.result).toString()) as T; } catch { throw new ApiError(502, "The clearing contract returned invalid evidence", "CLEARING_RESPONSE_INVALID"); }
  };
  const [clearingCode, treasuryCode, clearing, platform] = await Promise.all([
    query<{ code_hash: string }>(config.contractId, { request_type: "view_account" }), query<{ code_hash: string }>(config.treasuryId, { request_type: "view_account" }),
    view<{ treasury_id: string; token_contract: string; paused: boolean; state_version?: number; cash_network?: "mainnet" | "testnet" | null; max_cash_deposits_per_company?: number }>(config.contractId, "get_config"), view<{ architecture: string; token_contract: string }>(config.treasuryId, "get_platform_config"),
  ]);
  if (clearingCode.code_hash !== config.codeHash || treasuryCode.code_hash !== config.treasuryHash || clearing.treasury_id !== config.treasuryId || clearing.token_contract !== platform.token_contract || platform.architecture !== "shared_v1") throw new ApiError(409, "Clearing code, shared treasury or settlement token differs from the reviewed deployment", "CLEARING_CODE_MISMATCH");
  if (config.network === "mainnet" && clearing.token_contract !== NATIVE_USDC.near) throw new ApiError(409, "Business clearing requires verified native USDC on NEAR mainnet", "CLEARING_ASSET_MISMATCH");
  return { config, clearing, view, query, blockHash: block.header.hash, blockHeight: String(block.header.height), timestampMs: (BigInt(block.header.timestamp_nanosec) / 1000000n).toString() };
}

export async function verifyRegistration(context: Awaited<ReturnType<typeof finalContext>>, registration: Pick<Registration, "organization_id" | "treasury_company_id" | "network" | "token_contract" | "treasury_id" | "owner_account_id" | "policy_version">) {
  if (registration.network !== context.config.network || registration.token_contract !== context.clearing.token_contract) throw new ApiError(409, "All companies must use the same NEAR network and USDC settlement token", "CLEARING_ASSET_MISMATCH");
  if (registration.treasury_id !== context.config.treasuryId) throw new ApiError(409, "The company is not registered in the reviewed shared treasury", "CLEARING_TREASURY_MISMATCH");
  const [code, treasury] = await Promise.all([
    context.query<{ code_hash: string }>(registration.treasury_id, { request_type: "view_account" }),
    context.view<{ architecture: string; company_id: string; owner_id: string; token_contract: string; paused: boolean; policy_version: string }>(registration.treasury_id, "get_config", {company_id: registration.treasury_company_id}),
  ]);
  if (code.code_hash !== context.config.treasuryHash || treasury.architecture !== "shared_v1" || treasury.company_id !== registration.treasury_company_id || treasury.owner_id !== registration.owner_account_id || treasury.token_contract !== registration.token_contract || !/^[1-9]\d*$/.test(treasury.policy_version) || treasury.policy_version !== registration.policy_version || treasury.paused) throw new ApiError(409, "The participating company must match its shared registration, current owner, token and unpaused policy", "CLEARING_TREASURY_MISMATCH");
}

export async function roundEvidence(roundId: string): Promise<FinalEvidence> {
  const context = await finalContext();
  const round = await context.view<ChainRound | null>(context.config.contractId, "get_round", { round_id: roundId });
  const evidence: FinalEvidence = { network: context.config.network, contractId: context.config.contractId, codeHash: context.config.codeHash, blockHash: context.blockHash, blockHeight: context.blockHeight, timestampMs: context.timestampMs, round };
  if (round?.status !== "finalized") return evidence;
  const height = Number(round.finalized_height);
  if (!Number.isSafeInteger(height) || height <= 0 || height > Number(context.blockHeight)) throw new ApiError(409, "The finalized clearing height is invalid", "CLEARING_PROOF_INVALID");
  const finalized = height === Number(context.blockHeight) ? context : await finalContext(height);
  const historic = await finalized.view<ChainRound | null>(context.config.contractId, "get_round", { round_id: roundId });
  if (finalized.clearing.paused || finalized.timestampMs !== round.finalized_at_ms || historic?.status !== "finalized" || historic.manifest_json !== round.manifest_json || historic.hash !== round.hash || historic.finalized_height !== round.finalized_height || historic.finalized_at_ms !== round.finalized_at_ms) throw new ApiError(409, "The exact clearing finalization could not be verified at its recorded block", "CLEARING_PROOF_INVALID");
  await Promise.all(round.manifest.participants.map(party => verifyRegistration(finalized, { organization_id: party.company_id, treasury_company_id:party.treasury_company_id, network: context.config.network, token_contract: finalized.clearing.token_contract, treasury_id: party.treasury_id, owner_account_id: party.owner_id, policy_version: party.policy_version })));
  evidence.authority = { blockHash: finalized.blockHash, blockHeight: finalized.blockHeight, participants: round.manifest.participants.map(party => ({ companyId: party.company_id, treasuryId: party.treasury_id, treasuryCompanyId:party.treasury_company_id, ownerId: party.owner_id, policyVersion: party.policy_version })) };
  return evidence;
}

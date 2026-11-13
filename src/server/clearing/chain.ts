import { ApiError } from "../context";
import { reviewedArtifactHash } from "../near-artifacts";
import { validNearAccount } from "../payments/near";
import { NATIVE_USDC } from "../payments/policy";
import type { ChainRound, FinalEvidence, Registration } from "./types";

export function settings() {
  const network = process.env.NEAR_NETWORK || "testnet", contractId = process.env.NEAR_CLEARING_ID, factoryId = process.env.NEAR_FACTORY_ID;
  if ((network !== "mainnet" && network !== "testnet") || !contractId || !factoryId || !validNearAccount(contractId) || !validNearAccount(factoryId)) throw new ApiError(503, "Configure the reviewed NEAR clearing contract and treasury factory on one network", "CLEARING_SETUP_REQUIRED");
  return { network: network as "mainnet" | "testnet", contractId, factoryId, codeHash: reviewedArtifactHash("NEAR_CLEARING_CODE_HASH", "razor_clearing.wasm"), factoryHash: reviewedArtifactHash("NEAR_FACTORY_CODE_HASH", "razor_factory.wasm"), treasuryHash: reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm") };
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
  const [clearingCode, factoryCode, clearing, factory] = await Promise.all([
    query<{ code_hash: string }>(config.contractId, { request_type: "view_account" }), query<{ code_hash: string }>(config.factoryId, { request_type: "view_account" }),
    view<{ factory_id: string; token_contract: string; paused: boolean }>(config.contractId, "get_config"), view<{ token_contract: string; treasury_wasm_hash: string }>(config.factoryId, "get_config"),
  ]);
  if (clearingCode.code_hash !== config.codeHash || factoryCode.code_hash !== config.factoryHash || clearing.factory_id !== config.factoryId || clearing.token_contract !== factory.token_contract || factory.treasury_wasm_hash !== config.treasuryHash) throw new ApiError(409, "Clearing code, factory, treasury code or settlement token differs from the reviewed deployment", "CLEARING_CODE_MISMATCH");
  if (config.network === "mainnet" && clearing.token_contract !== NATIVE_USDC.near) throw new ApiError(409, "Business clearing requires verified native USDC on NEAR mainnet", "CLEARING_ASSET_MISMATCH");
  return { config, clearing, view, query, blockHash: block.header.hash, blockHeight: String(block.header.height), timestampMs: (BigInt(block.header.timestamp_nanosec) / 1000000n).toString() };
}

export async function verifyRegistration(context: Awaited<ReturnType<typeof finalContext>>, registration: Pick<Registration, "network" | "token_contract" | "treasury_id" | "owner_account_id" | "policy_version">) {
  if (registration.network !== context.config.network || registration.token_contract !== context.clearing.token_contract) throw new ApiError(409, "All companies must use the same NEAR network and USDC settlement token", "CLEARING_ASSET_MISMATCH");
  const [code, treasury, creation] = await Promise.all([
    context.query<{ code_hash: string }>(registration.treasury_id, { request_type: "view_account" }),
    context.view<{ owner_id: string; token_contract: string; paused: boolean; policy_version: string }>(registration.treasury_id, "get_config"),
    context.view<{ account_id: string; token_contract: string; status: string } | null>(context.config.factoryId, "get_creation", { account_id: registration.treasury_id }),
  ]);
  if (code.code_hash !== context.config.treasuryHash || treasury.owner_id !== registration.owner_account_id || treasury.token_contract !== registration.token_contract || !/^[1-9]\d*$/.test(treasury.policy_version) || treasury.policy_version !== registration.policy_version || treasury.paused || creation?.account_id !== registration.treasury_id || creation.token_contract !== registration.token_contract || creation.status !== "ready") throw new ApiError(409, "The participating treasury must match its current owner, reviewed factory creation, token and unpaused policy", "CLEARING_TREASURY_MISMATCH");
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
  await Promise.all(round.manifest.participants.map(party => verifyRegistration(finalized, { network: context.config.network, token_contract: finalized.clearing.token_contract, treasury_id: party.treasury_id, owner_account_id: party.owner_id, policy_version: party.policy_version })));
  evidence.authority = { blockHash: finalized.blockHash, blockHeight: finalized.blockHeight, participants: round.manifest.participants.map(party => ({ companyId: party.company_id, treasuryId: party.treasury_id, ownerId: party.owner_id, policyVersion: party.policy_version })) };
  return evidence;
}

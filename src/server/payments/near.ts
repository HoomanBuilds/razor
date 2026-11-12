import { ApiError } from "../context";
import type { TreasuryConfig } from "./types";

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function validNearAccount(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT.test(value);
}

async function rpc<T>(network: "mainnet" | "testnet", method: string, params: unknown): Promise<T> {
  const url = network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "float", method, params }), signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!response.ok) throw new ApiError(503, "NEAR RPC is unavailable", "NEAR_UNAVAILABLE");
  const payload = await response.json();
  if (payload.error) throw new ApiError(422, "NEAR could not verify this account or receipt", "NEAR_VERIFICATION_FAILED");
  return payload.result as T;
}

export async function view<T>(config: Pick<TreasuryConfig, "near_account_id" | "network">, method: string, args: unknown = {}): Promise<T> {
  const result = await rpc<{ result: number[] }>(config.network, "query", { request_type: "call_function", finality: "final", account_id: config.near_account_id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  try { return JSON.parse(Buffer.from(result.result).toString()) as T; } catch { throw new ApiError(502, "The NEAR contract returned invalid data", "CONTRACT_RESPONSE_INVALID"); }
}

export async function verifyTokenReceipt(config: TreasuryConfig, txHash: string, receiver: string, minimum: bigint): Promise<{ amount: string; transactionHash: string; blockHashes: string[] }> {
  const result = await rpc<Record<string, unknown>>(config.network, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: config.near_account_id, wait_until: "FINAL" });
  if (result.final_execution_status !== "FINAL") throw new ApiError(409, "The NEAR transaction is not final", "RECEIPT_NOT_FINAL");
  const status = result.status as Record<string, unknown> | undefined;
  if (!status || !("SuccessValue" in status)) throw new ApiError(409, "The NEAR transaction did not complete successfully", "RECEIPT_FAILED");
  const outcomes = (result.receipts_outcome ?? []) as { block_hash: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }[];
  let received = 0n;
  const hashes: string[] = [];
  for (const item of outcomes) {
    if (item.outcome.executor_id !== config.token_contract || !("SuccessValue" in item.outcome.status)) continue;
    for (const log of item.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event;
      try { event = JSON.parse(log.slice(11)); } catch { continue; }
      if (event.standard !== "nep141" || event.event !== "ft_transfer" || !Array.isArray(event.data)) continue;
      for (const transfer of event.data) {
        if (transfer.new_owner_id === receiver && /^(0|[1-9]\d*)$/.test(String(transfer.amount))) {
          received += BigInt(transfer.amount);
          hashes.push(item.block_hash);
        }
      }
    }
  }
  if (received < minimum) throw new ApiError(409, "A matching final token delivery could not be verified", "DELIVERY_UNVERIFIED");
  return { amount: received.toString(), transactionHash: txHash, blockHashes: [...new Set(hashes)] };
}

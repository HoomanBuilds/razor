import { ApiError } from "../context";
import type { TreasuryConfig } from "./types";
import { atomic } from "../../lib/money";

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function validNearAccount(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT.test(value);
}

async function rpc<T>(network: "mainnet" | "testnet", method: string, params: unknown): Promise<T> {
  const url = network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "razor", method, params }), signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!response.ok) throw new ApiError(503, "NEAR RPC is unavailable", "NEAR_UNAVAILABLE");
  const payload = await response.json();
  if (payload.error) throw new ApiError(422, "NEAR could not verify this account or receipt", "NEAR_VERIFICATION_FAILED");
  return payload.result as T;
}

export async function view<T>(config: Pick<TreasuryConfig, "near_account_id" | "network">, method: string, args: unknown = {}): Promise<T> {
  const result = await rpc<{ result: number[] }>(config.network, "query", { request_type: "call_function", finality: "final", account_id: config.near_account_id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  try { return JSON.parse(Buffer.from(result.result).toString()) as T; } catch { throw new ApiError(502, "The NEAR contract returned invalid data", "CONTRACT_RESPONSE_INVALID"); }
}

export async function contractCodeHash(config: Pick<TreasuryConfig, "near_account_id" | "network">): Promise<string> {
  const account = await rpc<{ code_hash: string }>(config.network, "query", { request_type: "view_account", finality: "final", account_id: config.near_account_id });
  return account.code_hash;
}

export interface TokenReceiptEvent {
  receiptId: string;
  logIndex: number;
  dataIndex: number;
  amount: string;
  sender: string;
  receiver: string;
  blockHash: string;
}

export interface TokenReceiptProof {
  network: "mainnet" | "testnet";
  tokenContract: string;
  transactionHash: string;
  senderAccountId: string;
  receiver: string;
  finality: "FINAL";
  amount: string;
  events: TokenReceiptEvent[];
}

export interface NearAction { FunctionCall?: { method_name: string; args: string } }

export interface FinalTransaction {
  final_execution_status?: string;
  status?: Record<string, unknown>;
  transaction?: { hash?: string; signer_id?: string; receiver_id?: string; actions?: NearAction[] };
  transaction_outcome?: { outcome: { receipt_ids: string[] } };
  receipts?: { receipt_id: string; receiver_id: string; predecessor_id: string; receipt?: { Action?: { actions: NearAction[] } } }[];
  receipts_outcome?: { id: string; block_hash: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown>; receipt_ids?: string[] } }[];
}

export function inspectTokenReceipt(result: FinalTransaction, config: TreasuryConfig, txHash: string, senderAccountId: string, receiver: string, expected: string, receiptId?: string, excludedEvents: string[] = []): TokenReceiptProof {
  if (result.final_execution_status !== "FINAL") throw new ApiError(409, "The NEAR transaction is not final", "RECEIPT_NOT_FINAL");
  if (result.transaction?.hash !== txHash || result.transaction.signer_id !== senderAccountId) throw new ApiError(409, "The returned transaction does not match its hash and signer", "RECEIPT_IDENTITY_MISMATCH");
  const status = result.status;
  if (!status || !("SuccessValue" in status)) throw new ApiError(409, "The NEAR transaction did not complete successfully", "RECEIPT_FAILED");
  const events: TokenReceiptEvent[] = [];
  for (const item of result.receipts_outcome ?? []) {
    if (item.outcome.executor_id !== config.token_contract || !("SuccessValue" in item.outcome.status || "SuccessReceiptId" in item.outcome.status)) continue;
    for (const [logIndex, log] of item.outcome.logs.entries()) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event;
      try { event = JSON.parse(log.slice(11)); } catch { continue; }
      if (event.standard !== "nep141" || event.event !== "ft_transfer" || !Array.isArray(event.data)) continue;
      for (const [dataIndex, transfer] of event.data.entries()) {
        if (!/^[1-9]\d*$/.test(String(transfer.amount))) continue;
        if (transfer.old_owner_id === receiver) throw new ApiError(409, "The transaction includes funds leaving or being refunded from the destination. Review it manually", "RECEIPT_CONTAINS_OUTFLOW");
        if (transfer.new_owner_id === receiver && typeof transfer.old_owner_id === "string" && validNearAccount(transfer.old_owner_id) && (!receiptId || item.id === receiptId) && !excludedEvents.includes(`${item.id}:${logIndex}:${dataIndex}`)) events.push({ receiptId: item.id, logIndex, dataIndex, amount: atomic(transfer.amount).toString(), sender: transfer.old_owner_id, receiver, blockHash: item.block_hash });
      }
    }
  }
  const required = atomic(expected);
  if (new Set(events.map((event) => `${event.receiptId}:${event.logIndex}:${event.dataIndex}`)).size !== events.length) throw new ApiError(502, "The receipt response repeats a token event", "RECEIPT_EVENT_DUPLICATE");
  const exact = events.find((event) => atomic(event.amount) === required);
  const selected = exact ? [exact] : events;
  if (!selected.length || selected.some((event) => !event.receiptId || !event.blockHash) || selected.reduce((sum, event) => sum + atomic(event.amount), 0n) !== required) throw new ApiError(409, "A final native-token transfer matching this funding amount could not be verified", "DELIVERY_UNVERIFIED");
  return { network: config.network, tokenContract: config.token_contract, transactionHash: txHash, senderAccountId, receiver, finality: "FINAL", amount: required.toString(), events: selected };
}

export async function verifyTokenReceipt(config: TreasuryConfig, txHash: string, senderAccountId: string | undefined, receiver: string, expected: string, receiptId?: string, excludedEvents: string[] = []): Promise<TokenReceiptProof> {
  if ((senderAccountId !== undefined && !validNearAccount(senderAccountId)) || !validNearAccount(receiver)) throw new ApiError(422, "Enter valid NEAR signer and destination account IDs", "INVALID_ACCOUNT");
  const result = senderAccountId
    ? await nearTransactionStatus(config, txHash, senderAccountId)
    : await rpc<FinalTransaction>(config.network, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: receiver, wait_until: "FINAL" });
  const actualSigner = senderAccountId ?? result.transaction?.signer_id;
  if (!actualSigner || !validNearAccount(actualSigner)) throw new ApiError(409, "The transaction signer could not be discovered. Open advanced verification and supply the signer shown by the NEAR explorer", "RECEIPT_SIGNER_REQUIRED");
  return inspectTokenReceipt(result, config, txHash, actualSigner, receiver, expected, receiptId, excludedEvents);
}

export async function nearTransactionStatus(config: TreasuryConfig, txHash: string, senderAccountId: string): Promise<FinalTransaction> {
  if (!validNearAccount(senderAccountId)) throw new ApiError(422, "Enter the NEAR transaction signer", "INVALID_ACCOUNT");
  const result = await rpc<FinalTransaction>(config.network, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: senderAccountId, wait_until: "FINAL" });
  if (result.final_execution_status !== "FINAL" || result.transaction?.hash !== txHash || result.transaction.signer_id !== senderAccountId) throw new ApiError(409, "The NEAR transaction is not final or does not match the supplied signer", "RECEIPT_IDENTITY_MISMATCH");
  return result;
}

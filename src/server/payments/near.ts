import { createHash } from "node:crypto";
import { ApiError } from "../context";
import type { TreasuryConfig, WalletTransaction } from "./types";
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

type TreasuryTarget = Pick<TreasuryConfig, "near_account_id" | "network"> & Partial<Pick<TreasuryConfig, "organization_id" | "token_contract" | "architecture" | "company_id">>;

export function deriveSharedCompanyId(organizationId: string, initialOwnerAccount: string): string {
  if (!organizationId || organizationId.length > 96 || !validNearAccount(initialOwnerAccount)) throw new ApiError(422, "Use a valid company and verified NEAR owner", "TREASURY_COMPANY_MISMATCH");
  return `${organizationId}:${createHash("sha256").update(initialOwnerAccount).digest("hex").slice(0, 16)}`;
}

export function isCompanyBinding(organizationId: string | undefined, companyId: string | null | undefined): boolean {
  return !!organizationId && !!companyId && companyId.startsWith(`${organizationId}:`) && /^[a-f0-9]{16}$/.test(companyId.slice(organizationId.length + 1));
}

export function treasuryArgs(config: TreasuryTarget, args: unknown = {}): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ApiError(422, "Contract arguments must be an object", "CONTRACT_ARGUMENTS_INVALID");
  const value = args as Record<string, unknown>;
  if (config.architecture !== "shared_v1") return value;
  if (!isCompanyBinding(config.organization_id, config.company_id)) throw new ApiError(409, "The shared treasury binding does not match this company", "TREASURY_COMPANY_MISMATCH");
  if (value.company_id !== undefined && value.company_id !== config.company_id) throw new ApiError(409, "Contract arguments name a different company", "TREASURY_COMPANY_MISMATCH");
  return { ...value, company_id: config.company_id };
}

function scopedArgs(config: TreasuryTarget, method: string, args: unknown) {
  if (config.near_account_id === config.token_contract || method.startsWith("storage_") || method.startsWith("ft_") || method === "get_platform_config" || method === "quote_registration") return args;
  return treasuryArgs(config, args);
}

export function treasuryAction(config: TreasuryConfig, methodName: string, args: unknown = {}, deposit = "0", gas = "100000000000000"): WalletTransaction {
  return { receiverId: config.near_account_id, actions: [{ type: "FunctionCall", params: { methodName, args: scopedArgs(config, methodName, args), gas, deposit } }] };
}

export function sharedFundingMessage(config: TreasuryConfig, depositId: string, kind: "funding" | "retained" = "funding"): string {
  if (config.architecture !== "shared_v1") return kind === "retained" ? "razor:retain" : "razor:funding";
  if (!depositId || depositId.length > 128) throw new ApiError(422, "Use a valid funding identifier", "FUNDING_ID_INVALID");
  const company = treasuryArgs(config).company_id;
  return JSON.stringify({ company_id: company, deposit_id: depositId, kind });
}

export async function view<T>(config: TreasuryTarget, method: string, args: unknown = {}): Promise<T> {
  const result = await rpc<{ result: number[] }>(config.network, "query", { request_type: "call_function", finality: "final", account_id: config.near_account_id, method_name: method, args_base64: Buffer.from(JSON.stringify(scopedArgs(config, method, args))).toString("base64") });
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

export interface SharedDepositCredit {
  company_id: string;
  deposit_id: string;
  token_contract: string;
  sender_id: string;
  amount: string;
  kind: "funding" | "retained";
  credited_at_ms: string;
}

export function tokenReceiptIdentity(proof: TokenReceiptProof): string {
  if (!proof.events.length) throw new ApiError(409, "A final token receipt is required", "DELIVERY_UNVERIFIED");
  const entries = proof.events.map(event => `${event.receiptId}:${event.logIndex}:${event.dataIndex}`).sort();
  return `sha256:${createHash("sha256").update(JSON.stringify({ network: proof.network, token: proof.tokenContract, events: entries })).digest("hex")}`;
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

export function inspectSharedDeposit(result: FinalTransaction, config: TreasuryConfig, proof: TokenReceiptProof, depositId?: string, kind: "funding" | "retained" = "funding"): SharedDepositCredit {
  const companyId = treasuryArgs(config).company_id;
  if (config.architecture !== "shared_v1" || !companyId || !proof.events.length || proof.receiver !== config.near_account_id || result.final_execution_status !== "FINAL" || result.transaction?.hash !== proof.transactionHash || result.transaction.signer_id !== proof.senderAccountId || !result.status || !("SuccessValue" in result.status)) throw new ApiError(409, "Shared funding requires a final transaction bound to this company", "SHARED_DEPOSIT_UNVERIFIED");
  const credits: SharedDepositCredit[] = [];
  for (const receipt of result.receipts_outcome ?? []) {
    if (receipt.outcome.executor_id !== config.near_account_id || !("SuccessValue" in receipt.outcome.status || "SuccessReceiptId" in receipt.outcome.status)) continue;
    for (const log of receipt.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let event;
      try { event = JSON.parse(log.slice(11)); } catch { continue; }
      if (!event || event.standard !== "razor" || event.event !== "deposit_credited" || !Array.isArray(event.data)) continue;
      for (const credit of event.data) {
        if (!credit || typeof credit !== "object") continue;
        if (credit.company_id === companyId && typeof credit.deposit_id === "string" && (!depositId || credit.deposit_id === depositId) && credit.token_contract === proof.tokenContract && credit.amount === proof.amount && credit.kind === kind && typeof credit.credited_at_ms === "string" && proof.events.every(transfer => transfer.sender === credit.sender_id)) credits.push(credit);
      }
    }
  }
  if (credits.length !== 1) throw new ApiError(409, "The transaction does not prove exactly one matching company deposit credit", "SHARED_DEPOSIT_UNVERIFIED");
  return credits[0];
}

export async function verifySharedDeposit(config: TreasuryConfig, proof: TokenReceiptProof, depositId?: string, kind: "funding" | "retained" = "funding"): Promise<SharedDepositCredit> {
  const result = await nearTransactionStatus(config, proof.transactionHash, proof.senderAccountId);
  const credit = inspectSharedDeposit(result, config, proof, depositId, kind);
  const stored = await view<SharedDepositCredit | null>(config, "get_deposit", { deposit_id: credit.deposit_id });
  if (!stored || (["company_id", "deposit_id", "token_contract", "sender_id", "amount", "kind", "credited_at_ms"] as const).some(key => stored[key] !== credit[key])) throw new ApiError(409, "The shared treasury ledger does not match the final deposit credit", "SHARED_DEPOSIT_UNVERIFIED");
  return credit;
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

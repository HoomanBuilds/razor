import type { ChainReference } from "./packet";
import { decodeBase64, encodeBase64, type HistoricalObservation } from "./verify";

interface Outcome { block_hash: string; outcome: { executor_id: string; status: { Failure?: unknown; SuccessValue?: string; SuccessReceiptId?: string } } }
interface FinalTransaction {
  final_execution_status?: string; status: { Failure?: unknown; SuccessValue?: string };
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: Array<{ FunctionCall?: { method_name: string; args: string } }> };
  receipts_outcome: Outcome[];
}

export function historicalNearLookup(rpcUrl: string, transport: typeof fetch = fetch) {
  const url = new URL(rpcUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) RPC without embedded credentials");
  return async (ref: ChainReference): Promise<HistoricalObservation> => {
    async function rpc<T>(method: string, params: unknown): Promise<T> {
      const response = await transport(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "razor-portable-verifier", method, params }), signal: AbortSignal.timeout(15_000), cache: "no-store" });
      if (!response.ok) throw new Error("Historical RPC unavailable");
      const body = await response.json() as { result?: T; error?: unknown };
      if (body.error || !body.result) throw new Error("Historical RPC evidence unavailable");
      return body.result;
    }
    const status = await rpc<{ chain_id: string }>("status", []);
    const block = await rpc<{ header: { hash: string; height: number } }>("block", { block_id: ref.blockHash });
    const account = await rpc<{ code_hash: string; block_hash: string; block_height: number }>("query", { request_type: "view_account", block_id: ref.blockHash, account_id: ref.contractId });
    const args = { payment_id: ref.paymentId, ...(ref.architecture === "shared_v1" ? { company_id: ref.companyId } : {}) };
    const paymentResult = await rpc<{ result: number[]; block_hash: string; block_height: number }>("query", { request_type: "call_function", block_id: ref.blockHash, account_id: ref.contractId, method_name: "get_payment", args_base64: encodeBase64(new TextEncoder().encode(JSON.stringify(args))) });
    if (account.block_hash !== block.header.hash || paymentResult.block_hash !== block.header.hash || account.block_height !== block.header.height || paymentResult.block_height !== block.header.height) throw new Error("Historical queries returned different blocks");
    const payment = JSON.parse(new TextDecoder().decode(Uint8Array.from(paymentResult.result))) as { id: string; amount: string; recipient_id: string; recipient_version: string; policy_version: string };
    if (!payment) throw new Error("Payment did not exist at this block");
    const transaction = await rpc<FinalTransaction>("EXPERIMENTAL_tx_status", { tx_hash: ref.transactionHash, sender_account_id: ref.signerId, wait_until: "FINAL" });
    const callMatches = transaction.transaction.actions.some(action => {
      if (!action.FunctionCall || !["execute_payment", "approve_payment", "report_settlement", "report_partial_settlement", "confirm_source_transfer"].includes(action.FunctionCall.method_name)) return false;
      try {
        const value = JSON.parse(new TextDecoder().decode(decodeBase64(action.FunctionCall.args)));
        return value.payment_id === ref.paymentId && (ref.architecture !== "shared_v1" || value.company_id === ref.companyId);
      } catch { return false; }
    });
    const transactionBound = status.chain_id === ref.network && transaction.final_execution_status === "FINAL" && transaction.status.Failure === undefined && typeof transaction.status.SuccessValue === "string" && transaction.transaction.hash === ref.transactionHash && transaction.transaction.signer_id === ref.signerId && transaction.transaction.receiver_id === ref.contractId && callMatches && transaction.receipts_outcome.some(item => item.block_hash === ref.blockHash && item.outcome.executor_id === ref.contractId && item.outcome.status.Failure === undefined && (typeof item.outcome.status.SuccessValue === "string" || typeof item.outcome.status.SuccessReceiptId === "string")) && transaction.receipts_outcome.every(item => item.outcome.status.Failure === undefined);
    return { network: status.chain_id, blockHash: block.header.hash, blockHeight: block.header.height, codeHash: account.code_hash, payment: { id: payment.id, amount: payment.amount, recipientId: payment.recipient_id, recipientVersion: payment.recipient_version, policyVersion: payment.policy_version }, transactionBound };
  };
}

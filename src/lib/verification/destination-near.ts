import type { DestinationTransfer } from "./destination-packet";
import {
  destinationRpc,
  DestinationUnavailable,
  requireDestination,
} from "./destination-rpc";
interface Outcome {
  id: string;
  block_hash: string;
  outcome: {
    executor_id: string;
    logs: string[];
    receipt_ids?: string[];
    status: {
      Failure?: unknown;
      SuccessValue?: string;
      SuccessReceiptId?: string;
    };
  };
}
interface FinalTransaction {
  final_execution_status: string;
  status: { Failure?: unknown; SuccessValue?: string };
  transaction: { hash: string; signer_id: string };
  transaction_outcome: {
    outcome: { receipt_ids: string[]; status?: { SuccessReceiptId?: string } };
  };
  receipts_outcome: Outcome[];
}
export async function observeNearDestination(
  ref: Extract<DestinationTransfer, { kind: "near" }>,
  endpoint: string,
  transport?: typeof fetch,
) {
  const { JsonRpcProvider } = await import("near-api-js"),
    rpc = destinationRpc(endpoint, transport),
    provider = new JsonRpcProvider({ url: endpoint }, { retries: 0 });
  provider.sendJsonRpc = (async (method: string, params: unknown) =>
    rpc(method, params)) as typeof provider.sendJsonRpc;
  const status = await provider.viewNodeStatus();
  requireDestination(
    status.chain_id === ref.network,
    "The selected NEAR RPC is on a different network",
  );
  const tx = (await provider.viewTransactionStatusWithReceipts({
    txHash: ref.transactionHash,
    accountId: ref.signerId,
    waitUntil: "FINAL",
  })) as unknown as FinalTransaction;
  requireDestination(
    tx.transaction?.hash === ref.transactionHash &&
      tx.transaction.signer_id === ref.signerId,
    "The NEAR transaction hash or signer does not match",
  );
  if (tx.final_execution_status !== "FINAL")
    throw new DestinationUnavailable("The NEAR transaction is not finalized");
  requireDestination(
    tx.status &&
      typeof tx.status.SuccessValue === "string" &&
      tx.status.Failure === undefined,
    "The NEAR transaction failed",
  );
  if (!Array.isArray(tx.receipts_outcome) || tx.receipts_outcome.length > 2048)
    throw new DestinationUnavailable(
      "The NEAR receipt graph is missing or exceeds its supported bound",
    );
  const outcomes = new Map(tx.receipts_outcome.map((item) => [item.id, item]));
  requireDestination(
    outcomes.size === tx.receipts_outcome.length,
    "The RPC repeated a receipt identity",
  );
  const pending = [...tx.transaction_outcome.outcome.receipt_ids],
    reachable = new Set<string>();
  if (tx.transaction_outcome.outcome.status?.SuccessReceiptId)
    pending.push(tx.transaction_outcome.outcome.status.SuccessReceiptId);
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    if (reachable.size >= 2048)
      throw new DestinationUnavailable(
        "The receipt graph exceeds its supported bound",
      );
    reachable.add(id);
    const value = outcomes.get(id);
    if (!value) continue;
    pending.push(...(value.outcome.receipt_ids ?? []));
    if (value.outcome.status.SuccessReceiptId)
      pending.push(value.outcome.status.SuccessReceiptId);
  }
  const receipt = outcomes.get(ref.receiptId);
  requireDestination(
    receipt &&
      reachable.has(ref.receiptId) &&
      receipt.outcome.executor_id === ref.tokenContract &&
      receipt.outcome.status.Failure === undefined &&
      (typeof receipt.outcome.status.SuccessValue === "string" ||
        typeof receipt.outcome.status.SuccessReceiptId === "string"),
    "The selected successful token receipt is not part of this transaction",
  );
  const log = receipt.outcome.logs[ref.logIndex];
  requireDestination(
    typeof log === "string" && log.startsWith("EVENT_JSON:"),
    "The selected log is not a NEP141 transfer event",
  );
  let event;
  try {
    event = JSON.parse(log.slice(11));
  } catch {
    throw new DestinationUnavailable("The token event is not valid JSON");
  }
  const entry = event?.data?.[ref.dataIndex];
  requireDestination(
    event?.standard === "nep141" &&
      event.event === "ft_transfer" &&
      event.version === "1.0.0" &&
      Array.isArray(event.data) &&
      entry?.old_owner_id === ref.sender &&
      entry.new_owner_id === ref.recipient &&
      entry.amount === ref.amount,
    "The exact NEP141 token, sender, recipient or base-unit amount does not match",
  );
  let received = 0n,
    sent = 0n;
  for (const item of tx.receipts_outcome) {
    if (
      !reachable.has(item.id) ||
      item.outcome.executor_id !== ref.tokenContract ||
      item.outcome.status.Failure !== undefined
    )
      continue;
    for (const wire of item.outcome.logs) {
      if (!wire.startsWith("EVENT_JSON:")) continue;
      let transfer;
      try {
        transfer = JSON.parse(wire.slice(11));
      } catch {
        continue;
      }
      if (
        transfer.standard !== "nep141" ||
        transfer.event !== "ft_transfer" ||
        !Array.isArray(transfer.data)
      )
        continue;
      for (const value of transfer.data) {
        if (
          value.new_owner_id !== ref.recipient &&
          value.old_owner_id !== ref.recipient
        )
          continue;
        if (
          typeof value.amount !== "string" ||
          !/^[1-9]\d{0,38}$/.test(value.amount)
        )
          throw new DestinationUnavailable(
            "Relevant token event has unsupported amount encoding",
          );
        if (value.new_owner_id === ref.recipient)
          received += BigInt(value.amount);
        if (value.old_owner_id === ref.recipient) sent += BigInt(value.amount);
      }
    }
  }
  requireDestination(
    received === BigInt(ref.amount) && sent === 0n,
    "The transaction contains additional recipient inflows, outflows or refunds; the selected gross event is not an isolated exact delivery",
  );
  const token = await provider.viewAccount({
    accountId: ref.tokenContract,
    blockQuery: { blockId: receipt.block_hash },
  });
  requireDestination(
    token.block_hash === receipt.block_hash &&
      typeof token.code_hash === "string" &&
      token.code_hash !== "11111111111111111111111111111111",
    "The token contract was not deployed at this receipt block",
  );
  requireDestination(
    (await provider.viewNodeStatus()).chain_id === ref.network,
    "The RPC network changed during verification",
  );
  return {
    network: ref.network,
    transaction: ref.transactionHash,
    blockHash: receipt.block_hash,
    blockHeight: token.block_height,
    amount: ref.amount,
    recipient: ref.recipient,
    token: ref.tokenContract,
    selector: `${ref.receiptId}:${ref.logIndex}:${ref.dataIndex}`,
    scope:
      "Final NEP141 transfer record with exact isolated recipient inflow and no transaction refund; token identity/standard behavior remains an independent trust input.",
  };
}

import { z } from "zod";
import {
  destinationRpc,
  DestinationFailure,
  requireDestination,
} from "./destination-rpc";
import {
  canonicalAnchor,
  inferenceAnchorChallengeSchema,
  inferenceAnchorReferenceSchema,
  inferenceAnchorTrustSchema,
  type InferenceAnchorReference,
  type InferenceAnchorTrust,
} from "./inference-anchors";
import { decodeBase64 } from "./verify";

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,19})$/);
const challengeEvent = z
  .object({
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    context_hash: z.string(),
    salt: z.string(),
    recorder: z.string(),
    block_height: decimal,
    timestamp_ms: decimal,
  })
  .strict();
const responseEvent = z
  .object({
    challenge_transaction_hash: z.string(),
    nonce: z.string(),
    request_sha256: z.string(),
    response_sha256: z.string(),
    reports_sha256: z.string(),
    recorder: z.string(),
    block_height: decimal,
    timestamp_ms: decimal,
  })
  .strict();
interface Outcome {
  id: string;
  block_hash: string;
  outcome: {
    executor_id: string;
    logs: string[];
    receipt_ids: string[];
    status: {
      Failure?: unknown;
      SuccessReceiptId?: string;
      SuccessValue?: string;
    };
  };
}
interface Transaction {
  final_execution_status: string;
  status: { Failure?: unknown; SuccessValue?: string };
  transaction: {
    hash: string;
    signer_id: string;
    receiver_id: string;
    actions: unknown[];
  };
  transaction_outcome: Outcome;
  receipts_outcome: Outcome[];
  receipts?: Array<{
    receipt_id: string;
    predecessor_id: string;
    receiver_id: string;
    receipt: { Action?: { signer_id: string; actions: unknown[] } };
  }>;
}
interface Header {
  hash: string;
  height: number;
  prev_hash: string;
  timestamp_nanosec?: string;
  timestamp?: number;
}

function functionCall(actions: unknown[], method: string, args: unknown) {
  requireDestination(
    Array.isArray(actions) && actions.length === 1,
    "Anchor requires exactly one transaction action",
  );
  const action = actions[0] as {
    FunctionCall?: {
      method_name: string;
      args: string;
      deposit: string;
      gas: string | number;
    };
  };
  requireDestination(
    action &&
      Object.keys(action).length === 1 &&
      action.FunctionCall?.method_name === method &&
      action.FunctionCall.deposit === "0",
    "Anchor must be the exact zero-deposit function call",
  );
  const bytes = decodeBase64(action.FunctionCall.args);
  requireDestination(
    bytes.length <= 4096 &&
      canonicalAnchor(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ) === canonicalAnchor(args),
    "Anchor call arguments differ from the reviewed commitments",
  );
}

function successful(outcome: Outcome) {
  requireDestination(
    outcome?.outcome &&
      !Object.hasOwn(outcome.outcome.status, "Failure") &&
      (typeof outcome.outcome.status.SuccessValue === "string") !==
        (typeof outcome.outcome.status.SuccessReceiptId === "string"),
    "Anchor receipt failed or has ambiguous status",
  );
  requireDestination(
    Array.isArray(outcome.outcome.receipt_ids) &&
      outcome.outcome.receipt_ids.length <= 16 &&
      Array.isArray(outcome.outcome.logs) &&
      outcome.outcome.logs.length <= 16,
    "Anchor receipt exceeds the supported bound",
  );
}

export function inferenceAnchorObserver(
  endpoint: string,
  transport?: typeof fetch,
) {
  const rpc = destinationRpc(endpoint, transport);
  async function checkedNetwork(network: string) {
    const status = await rpc<{ chain_id: string }>("status", []);
    requireDestination(
      status.chain_id === network,
      "The selected archival RPC is on a different network",
    );
  }
  async function lockedAt(trust: InferenceAnchorTrust, header: Header) {
    const account = await rpc<{
      code_hash: string;
      block_hash: string;
      block_height: number;
    }>("query", {
      request_type: "view_account",
      account_id: trust.contractId,
      block_id: header.hash,
    });
    const keys = await rpc<{
      keys: unknown[];
      block_hash: string;
      block_height: number;
      last_key?: unknown;
    }>("query", {
      request_type: "view_access_key_list",
      account_id: trust.contractId,
      block_id: header.hash,
    });
    requireDestination(
      account.block_hash === header.hash &&
        keys.block_hash === header.hash &&
        account.block_height === header.height &&
        keys.block_height === header.height &&
        account.code_hash === trust.codeHash &&
        Array.isArray(keys.keys) &&
        keys.keys.length === 0 &&
        !keys.last_key,
      "Historical anchor deployment must match independently reviewed code and have zero access keys",
    );
  }
  async function observe(
    trustInput: InferenceAnchorTrust,
    ref: InferenceAnchorReference,
    method: "challenge" | "record_response",
    args: unknown,
  ) {
    const trust = inferenceAnchorTrustSchema.parse(trustInput);
    ref = inferenceAnchorReferenceSchema.parse(ref);
    requireDestination(
      ref.signerId === trust.recorder && ref.signerId !== trust.contractId,
      "The independent recorder does not match this transaction",
    );
    await checkedNetwork(trust.network);
    const tx = await rpc<Transaction>("EXPERIMENTAL_tx_status", {
      tx_hash: ref.transactionHash,
      sender_account_id: ref.signerId,
      wait_until: "FINAL",
    });
    requireDestination(
      tx.final_execution_status === "FINAL" &&
        tx.transaction.hash === ref.transactionHash &&
        tx.transaction.signer_id === trust.recorder &&
        tx.transaction.receiver_id === trust.contractId &&
        typeof tx.status.SuccessValue === "string" &&
        !Object.hasOwn(tx.status, "Failure"),
      "The exact final successful anchor transaction is required",
    );
    functionCall(tx.transaction.actions, method, args);
    requireDestination(
      Array.isArray(tx.receipts_outcome) &&
        tx.receipts_outcome.length > 0 &&
        tx.receipts_outcome.length <= 16,
      "The complete bounded anchor receipt graph is required",
    );
    successful(tx.transaction_outcome);
    requireDestination(
      tx.transaction_outcome.id === ref.transactionHash &&
        tx.transaction_outcome.outcome.executor_id === trust.recorder,
      "Anchor transaction outcome identity mismatch",
    );
    const outcomes = new Map(
      tx.receipts_outcome.map((item) => [item.id, item]),
    );
    requireDestination(
      outcomes.size === tx.receipts_outcome.length,
      "Duplicate anchor receipt identity",
    );
    const pending = [...tx.transaction_outcome.outcome.receipt_ids],
      seen = new Set<string>();
    const first = tx.transaction_outcome.outcome.status.SuccessReceiptId;
    requireDestination(
      first && pending.includes(first),
      "Anchor root receipt identity is missing",
    );
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      const item = outcomes.get(id);
      requireDestination(
        item && seen.size < 16,
        "The final anchor receipt graph is incomplete",
      );
      seen.add(id);
      successful(item);
      pending.push(...item.outcome.receipt_ids);
      if (item.outcome.status.SuccessReceiptId)
        pending.push(item.outcome.status.SuccessReceiptId);
    }
    requireDestination(
      seen.size === outcomes.size,
      "Anchor outcomes include unrelated receipts",
    );
    const executed = outcomes.get(first)!;
    requireDestination(
      executed.outcome.executor_id === trust.contractId &&
        executed.outcome.status.SuccessValue === tx.status.SuccessValue &&
        tx.receipts_outcome.filter(
          (item) => item.outcome.executor_id === trust.contractId,
        ).length === 1,
      "Anchor executor or return value is not uniquely bound to the root receipt",
    );
    const receipt = tx.receipts?.filter((item) => item.receipt_id === first);
    requireDestination(
      receipt?.length === 1 &&
        receipt[0].predecessor_id === trust.recorder &&
        receipt[0].receiver_id === trust.contractId &&
        receipt[0].receipt.Action?.signer_id === trust.recorder,
      "Anchor action receipt must bind exact signer, predecessor and receiver",
    );
    functionCall(receipt[0].receipt.Action.actions, method, args);
    for (const item of tx.receipts_outcome)
      if (item.id !== first) {
        const wire = tx.receipts?.filter(
          (value) => value.receipt_id === item.id,
        );
        requireDestination(
          wire?.length === 1 &&
            wire[0].predecessor_id === "system" &&
            wire[0].receiver_id === trust.recorder &&
            item.outcome.executor_id === trust.recorder &&
            item.outcome.logs.length === 0,
          "Only recorder gas-refund receipts may accompany the anchor call",
        );
        const actions = wire[0].receipt.Action?.actions as
          | Array<{ Transfer?: { deposit: string } }>
          | undefined;
        requireDestination(
          actions?.length === 1 &&
            Object.keys(actions[0]).length === 1 &&
            /^\d+$/.test(actions[0].Transfer?.deposit ?? ""),
          "Unsupported action in anchor refund graph",
        );
      }
    requireDestination(
      executed.outcome.logs.length === 1 &&
        executed.outcome.logs[0].startsWith("EVENT_JSON:"),
      "Exactly one reviewed anchor event is required",
    );
    const event = z
      .object({
        standard: z.literal("razor-evidence"),
        version: z.literal("1.0.0"),
        event: z.literal(
          method === "challenge" ? "challenge" : "response_commitment",
        ),
        data: z
          .array(method === "challenge" ? challengeEvent : responseEvent)
          .length(1),
      })
      .strict()
      .parse(JSON.parse(executed.outcome.logs[0].slice(11)));
    const data = event.data[0];
    const block = await rpc<{ header: Header }>("block", {
      block_id: executed.block_hash,
    });
    requireDestination(
      block.header.hash === executed.block_hash &&
        Number.isSafeInteger(block.header.height) &&
        block.header.height > 0 &&
        typeof block.header.timestamp_nanosec === "string" &&
        /^\d{1,20}$/.test(block.header.timestamp_nanosec),
      "Exact archival execution timestamp is unavailable",
    );
    requireDestination(
      data.recorder === trust.recorder &&
        data.block_height === String(block.header.height) &&
        data.timestamp_ms ===
          String(BigInt(block.header.timestamp_nanosec!) / 1_000_000n),
      "Anchor event is not bound to its actual receipt execution block",
    );
    const previous = await rpc<{ header: Header }>("block", {
      block_id: block.header.prev_hash,
    });
    requireDestination(
      previous.header.hash === block.header.prev_hash &&
        previous.header.height < block.header.height,
      "Historical parent block mismatch",
    );
    await lockedAt(trust, previous.header);
    await lockedAt(trust, block.header);
    await checkedNetwork(trust.network);
    if (method === "challenge") {
      const value = challengeEvent.parse(data);
      requireDestination(
        canonicalAnchor(value) ===
          canonicalAnchor(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                decodeBase64(tx.status.SuccessValue!),
              ),
            ),
          ) &&
          value.context_hash === trust.contextHash &&
          canonicalAnchor(args) ===
            canonicalAnchor({
              context_hash: value.context_hash,
              salt: value.salt,
            }),
        "Challenge return, event and original arguments differ",
      );
      return {
        event: value,
        blockHash: block.header.hash,
        blockHeight: block.header.height,
        timestampNs: block.header.timestamp_nanosec!,
        receiptId: first,
      };
    }
    const value = responseEvent.parse(data),
      {
        recorder: _recorder,
        block_height: _height,
        timestamp_ms: _time,
        ...committed
      } = value;
    requireDestination(
      tx.status.SuccessValue === "" &&
        canonicalAnchor(committed) === canonicalAnchor(args),
      "Response anchor does not bind the exact retained commitments",
    );
    return {
      event: value,
      blockHash: block.header.hash,
      blockHeight: block.header.height,
      timestampNs: block.header.timestamp_nanosec!,
      receiptId: first,
    };
  }
  return {
    challenge: async (
      trust: InferenceAnchorTrust,
      ref: InferenceAnchorReference,
      salt: string,
    ) => {
      const observed = await observe(trust, ref, "challenge", {
        context_hash: trust.contextHash,
        salt,
      });
      const event = challengeEvent.parse(observed.event);
      return {
        challenge: inferenceAnchorChallengeSchema.parse({
          schema: "razor.inference-anchor-challenge",
          version: 1,
          network: trust.network,
          contractId: trust.contractId,
          contextHash: event.context_hash,
          salt: event.salt,
          nonce: event.nonce,
          challenge: ref,
        }),
        observation: observed,
      };
    },
    response: (
      trust: InferenceAnchorTrust,
      ref: InferenceAnchorReference,
      args: {
        challenge_transaction_hash: string;
        nonce: string;
        request_sha256: string;
        response_sha256: string;
        reports_sha256: string;
      },
    ) => observe(trust, ref, "record_response", args),
  };
}

export { DestinationFailure as InferenceAnchorFailure };

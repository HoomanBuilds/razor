import { z } from "zod";
import {
  canonicalSettlementLink,
  settlementLinkSourceSchema,
  settlementLinkTransactionSchema,
  type SettlementLinkSource,
  type SettlementLinkTransaction,
} from "./settlement-link";
import { decodeBase64, encodeBase64, hashText } from "./verify";
import { destinationRpc, requireDestination } from "./destination-rpc";

interface Outcome {
  id: string;
  block_hash: string;
  outcome: {
    executor_id: string;
    receipt_ids: string[];
    logs: string[];
    status: {
      Failure?: unknown;
      SuccessReceiptId?: string;
      SuccessValue?: string;
    };
  };
}
interface Receipt {
  receipt_id: string;
  predecessor_id: string;
  receiver_id: string;
  receipt: {
    Action?: {
      signer_id: string;
      actions: unknown[];
      input_data_ids?: string[];
      output_data_receivers?: Array<{ data_id: string; receiver_id: string }>;
    };
  };
}
interface FinalTransaction {
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
  receipts?: Receipt[];
}
const text = z.string().max(256),
  amount = z.string().regex(/^\d{1,39}$/);
const chainDestination = settlementLinkSourceSchema.shape.destination;
const chainRoute = settlementLinkSourceSchema.shape.route;
const chainAttempt = z
  .object({
    id: text,
    use_backup: z.boolean(),
    destination: chainDestination,
    route: chainRoute,
    authorized: z.boolean(),
    approval_policy_version: amount,
    status: text,
    receipt: z.string().max(256).nullable(),
    actual_output: amount,
    credited_amount: amount,
  })
  .strip();
const chainPayment = z
  .object({
    id: text,
    recipient_id: text,
    recipient_version: amount,
    amount,
    max_fee: amount,
    policy_version: amount,
    status: text,
    attempts: z.array(chainAttempt).max(100),
  })
  .strip();
const chainRecipient = z
  .object({
    id: text,
    version: amount,
    primary: chainDestination,
    backup: chainDestination.nullable(),
    backup_consent: z.boolean(),
    active: z.boolean(),
  })
  .strip();
const chainConfig = z
  .object({
    architecture: z.literal("shared_v1"),
    company_id: text,
    owner_id: text,
    settlement_reporter: text.nullable(),
    token_contract: text,
    policy_version: amount,
  })
  .strip();
const chainApproval = z
  .object({
    policy_version: amount,
    payment_terms_hash: text,
    attempt_terms_hash: text.nullable(),
    attempt_id: text.nullable(),
  })
  .strip();

function call(actions: unknown[], method: string) {
  requireDestination(
    Array.isArray(actions) && actions.length === 1,
    "Exactly one action is required; batched source transactions cannot establish this link",
  );
  const value = actions[0] as {
    FunctionCall?: { method_name: string; args: string; deposit: string };
  };
  requireDestination(
    value &&
      Object.keys(value).length === 1 &&
      value.FunctionCall?.method_name === method,
    "The selected source transaction has an unsupported action",
  );
  const bytes = decodeBase64(value.FunctionCall.args);
  requireDestination(
    bytes.length <= 8192,
    "Source action arguments exceed the supported bound",
  );
  return {
    args: JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as Record<string, unknown>,
    deposit: value.FunctionCall.deposit,
  };
}
function exact(value: unknown, expected: unknown, message: string) {
  requireDestination(
    canonicalSettlementLink(value) === canonicalSettlementLink(expected),
    message,
  );
}

export function settlementLinkObserver(
  endpoint: string,
  transport?: typeof fetch,
) {
  const rpc = destinationRpc(endpoint, transport);
  async function network(expected: string) {
    requireDestination(
      (await rpc<{ chain_id: string }>("status", [])).chain_id === expected,
      "The selected NEAR RPC is on a different source network",
    );
  }
  async function query<T>(
    contractId: string,
    companyId: string,
    blockHash: string,
    method: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ) {
    const result = await rpc<{
      block_hash: string;
      block_height: number;
      result: number[];
    }>("query", {
      request_type: "call_function",
      account_id: contractId,
      block_id: blockHash,
      method_name: method,
      args_base64: encodeBase64(
        new TextEncoder().encode(
          JSON.stringify({ ...args, company_id: companyId }),
        ),
      ),
    });
    requireDestination(
      result.block_hash === blockHash && result.result.length <= 256_000,
      "Historical contract query returned a different block or exceeded its bound",
    );
    return schema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(result.result),
        ),
      ),
    );
  }
  async function code(contractId: string, blockHash: string, expected: string) {
    const value = await rpc<{ code_hash: string; block_hash: string }>(
      "query",
      {
        request_type: "view_account",
        account_id: contractId,
        block_id: blockHash,
      },
    );
    requireDestination(
      value.block_hash === blockHash && value.code_hash === expected,
      "The historical execution block does not run independently reviewed code",
    );
  }
  async function snapshot(
    identity: Pick<
      SettlementLinkSource,
      | "network"
      | "contractId"
      | "codeHash"
      | "companyId"
      | "paymentId"
      | "attemptId"
    >,
    blockHash: string,
  ) {
    await code(identity.contractId, blockHash, identity.codeHash);
    const payment = await query(
      identity.contractId,
      identity.companyId,
      blockHash,
      "get_payment",
      { payment_id: identity.paymentId },
      chainPayment,
    );
    const attempt = payment.attempts.find(
      (item) => item.id === identity.attemptId,
    );
    requireDestination(
      attempt &&
        payment.attempts.filter((item) => item.id === identity.attemptId)
          .length === 1,
      "Exact historical payment attempt is unavailable",
    );
    const config = await query(
      identity.contractId,
      identity.companyId,
      blockHash,
      "get_config",
      {},
      chainConfig,
    );
    const recipient = await query(
      identity.contractId,
      identity.companyId,
      blockHash,
      "get_recipient",
      { recipient_id: payment.recipient_id },
      chainRecipient,
    );
    const approval = await query(
      identity.contractId,
      identity.companyId,
      blockHash,
      "get_approval_status",
      { payment_id: payment.id, attempt_id: attempt.id },
      chainApproval,
    );
    requireDestination(
      config.company_id === identity.companyId &&
        payment.id === identity.paymentId &&
        recipient.id === payment.recipient_id &&
        recipient.version === payment.recipient_version &&
        config.policy_version === payment.policy_version &&
        approval.policy_version === payment.policy_version &&
        approval.attempt_id === attempt.id &&
        attempt.approval_policy_version === payment.policy_version &&
        approval.attempt_terms_hash &&
        attempt.authorized,
      "Historical recipient, policy or route authorization versions do not match this payment",
    );
    exact(
      attempt.destination,
      attempt.use_backup ? recipient.backup : recipient.primary,
      "Historical route differs from the versioned confirmed recipient",
    );
    requireDestination(
      !attempt.use_backup || recipient.backup_consent,
      "Historical backup route lacks recipient consent",
    );
    const source = settlementLinkSourceSchema.parse({
      ...identity,
      architecture: "shared_v1",
      tokenContract: config.token_contract,
      recipientId: payment.recipient_id,
      recipientVersion: payment.recipient_version,
      policyVersion: payment.policy_version,
      amount: payment.amount,
      maxFee: payment.max_fee,
      paymentTermsHash: approval.payment_terms_hash,
      attemptTermsHash: approval.attempt_terms_hash,
      recipientHash: hashText(canonicalSettlementLink(recipient)),
      useBackup: attempt.use_backup,
      destination: attempt.destination,
      route: attempt.route,
    });
    return { source, payment, attempt, config };
  }
  async function transaction(
    source: SettlementLinkSource,
    referenceInput: SettlementLinkTransaction,
    method: "execute_payment" | "report_settlement",
  ) {
    const reference = settlementLinkTransactionSchema.parse(referenceInput);
    await network(source.network);
    const tx = await rpc<FinalTransaction>("EXPERIMENTAL_tx_status", {
      tx_hash: reference.transactionHash,
      sender_account_id: reference.signerId,
      wait_until: "FINAL",
    });
    requireDestination(
      tx.final_execution_status === "FINAL" &&
        tx.transaction.hash === reference.transactionHash &&
        tx.transaction.signer_id === reference.signerId &&
        tx.transaction.receiver_id === source.contractId &&
        typeof tx.status.SuccessValue === "string" &&
        !Object.hasOwn(tx.status, "Failure"),
      "The exact successful finalized source transaction is required",
    );
    const action = call(tx.transaction.actions, method);
    requireDestination(
      action.deposit === "0",
      "The source association requires the exact zero-deposit treasury action",
    );
    requireDestination(
      Array.isArray(tx.receipts_outcome) &&
        tx.receipts_outcome.length > 0 &&
        tx.receipts_outcome.length <= 64 &&
        Array.isArray(tx.receipts) &&
        tx.receipts.length <= 64,
      "Complete bounded source receipts are required",
    );
    const outcomes = new Map(
        tx.receipts_outcome.map((item) => [item.id, item]),
      ),
      receipts = new Map(tx.receipts.map((item) => [item.receipt_id, item]));
    requireDestination(
      outcomes.size === tx.receipts_outcome.length &&
        receipts.size === tx.receipts.length &&
        tx.transaction_outcome.id === reference.transactionHash &&
        tx.transaction_outcome.outcome.executor_id === reference.signerId,
      "Source outcome identities are ambiguous",
    );
    const first = tx.transaction_outcome.outcome.status.SuccessReceiptId;
    requireDestination(
      first &&
        tx.transaction_outcome.outcome.receipt_ids.includes(first) &&
        !Object.hasOwn(tx.transaction_outcome.outcome.status, "Failure"),
      "Source root receipt is unavailable",
    );
    const pending = [...tx.transaction_outcome.outcome.receipt_ids],
      reached = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (reached.has(id)) continue;
      const value = outcomes.get(id);
      requireDestination(
        value &&
          reached.size < 64 &&
          !Object.hasOwn(value.outcome.status, "Failure") &&
          (typeof value.outcome.status.SuccessValue === "string" ||
            typeof value.outcome.status.SuccessReceiptId === "string") &&
          Array.isArray(value.outcome.receipt_ids) &&
          value.outcome.receipt_ids.length <= 64 &&
          value.outcome.logs.length <= 128,
        "The source receipt graph is incomplete, failed or exceeds its bound",
      );
      reached.add(id);
      pending.push(...value.outcome.receipt_ids);
      if (value.outcome.status.SuccessReceiptId)
        pending.push(value.outcome.status.SuccessReceiptId);
    }
    requireDestination(
      reached.size === outcomes.size,
      "Unrelated receipt outcomes cannot establish source association",
    );
    const root = outcomes.get(first)!,
      receipt = receipts.get(first);
    requireDestination(
      root.outcome.executor_id === source.contractId &&
        receipt?.predecessor_id === reference.signerId &&
        receipt.receiver_id === source.contractId &&
        receipt.receipt.Action?.signer_id === reference.signerId,
      "Source root does not bind exact signer, predecessor and treasury executor",
    );
    exact(
      call(receipt.receipt.Action.actions, method),
      action,
      "Source transaction and execution receipt actions differ",
    );
    const historical = await snapshot(source, root.block_hash);
    exact(
      historical.source,
      source,
      "Historical frozen source terms differ from independent expectations",
    );
    return { tx, action, outcomes, receipts, root, historical, reached };
  }
  function event(outcome: Outcome, name: string, companyId: string) {
    const values: Record<string, unknown>[] = [];
    for (const log of outcome.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const value = JSON.parse(log.slice(11));
      if (
        value.standard === "razor" &&
        value.version === "2.0.0" &&
        value.event === name &&
        Array.isArray(value.data)
      )
        for (const data of value.data)
          if (data.company_id === companyId) values.push(data);
    }
    requireDestination(
      values.length === 1,
      "Exactly one company-bound reviewed treasury event is required",
    );
    return values[0];
  }
  return { rpc, network, code, snapshot, transaction, event };
}

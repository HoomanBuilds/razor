import { NATIVE_USDC } from "../native-usdc";
import type { VerificationClaim } from "./packet";
import { verifyDestinationEvidence } from "./destination";
import { DestinationFailure, requireDestination } from "./destination-rpc";
import {
  canonicalSettlementLink,
  parseSettlementStatement,
  settlementLinkEvidenceSchema,
  settlementLinkTrustSchema,
  settlementSourceHash,
  type SettlementLinkEvidence,
  type SettlementLinkTrust,
} from "./settlement-link";
import { settlementLinkObserver } from "./settlement-link-rpc";
import { decodeBase64, hashText } from "./verify";

function exact(actual: unknown, expected: unknown, message: string) {
  requireDestination(
    canonicalSettlementLink(actual) === canonicalSettlementLink(expected),
    message,
  );
}
function decoded(value: string) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(value)),
  );
}

export async function verifySettlementLinkEvidence(
  input: SettlementLinkEvidence,
  options: {
    trust?: SettlementLinkTrust;
    sourceRpcUrl?: string;
    destinationRpcUrl?: string;
    transport?: typeof fetch;
  } = {},
) {
  const evidence = settlementLinkEvidenceSchema.parse(input),
    trust = options.trust
      ? settlementLinkTrustSchema.parse(options.trust)
      : undefined;
  const claims: VerificationClaim[] = [],
    add = (
      claim: string,
      status: VerificationClaim["status"],
      detail: string,
    ) => claims.push({ claim, status, detail });
  add(
    "settlement_link_format",
    "passed",
    "Strict separate source-link evidence. This verifier does not update payment, treasury, salary or delivery state.",
  );
  const matched =
    !!trust &&
    canonicalSettlementLink(evidence.source) ===
      canonicalSettlementLink(trust.expectedSource) &&
    canonicalSettlementLink(evidence.sourceTransaction) ===
      canonicalSettlementLink(trust.expectedSourceTransaction) &&
    canonicalSettlementLink(evidence.transfer) ===
      canonicalSettlementLink(trust.destination.expectedTransfer);
  add(
    "settlement_link_independent_expectations",
    trust ? (matched ? "passed" : "failed") : "not_checked",
    "Requires independently reviewed source deployment/code, company, exact payment/attempt/recipient/policy versions and approval hashes, route/asset/amount, source transaction and exact destination event. Packet IDs and address/amount equality alone are insufficient.",
  );
  let associated = false;
  if (trust && matched && options.sourceRpcUrl) {
    try {
      const source = evidence.source,
        observer = settlementLinkObserver(
          options.sourceRpcUrl,
          options.transport,
        );
      const original = {
        company_id: source.companyId,
        payment_id: source.paymentId,
        attempt_id: source.attemptId,
      };
      if (evidence.kind === "native_execution") {
        const transfer = evidence.transfer;
        requireDestination(
          transfer.kind === "near" &&
            trust.expectedTokenCodeHash &&
            source.route.kind === "direct" &&
            source.destination.network === "near" &&
            source.destination.asset_id === `nep141:${source.tokenContract}` &&
            (source.network !== "mainnet" ||
              source.tokenContract === NATIVE_USDC.near),
          "Native binding supports only the reviewed canonical NEAR treasury token and an independently pinned token code",
        );
        requireDestination(
          transfer.network === source.network &&
            transfer.transactionHash ===
              evidence.sourceTransaction.transactionHash &&
            transfer.signerId === evidence.sourceTransaction.signerId &&
            transfer.tokenContract === source.tokenContract &&
            transfer.sender === source.contractId &&
            transfer.recipient === source.destination.address &&
            transfer.amount === source.amount &&
            source.route.source_receiver === transfer.recipient &&
            source.route.input_amount === source.amount &&
            source.route.output_amount === source.amount,
          "Native transfer differs from the frozen direct treasury route",
        );
        const proof = await observer.transaction(
          source,
          evidence.sourceTransaction,
          "execute_payment",
        );
        exact(
          proof.action.args,
          original,
          "Native execution action targets different company/payment/attempt terms",
        );
        exact(
          observer.event(
            proof.root,
            "source_transfer_started",
            source.companyId,
          ),
          {
            ...original,
            amount: source.amount,
            receiver_id: transfer.recipient,
          },
          "Native source-start event does not match the exact payment",
        );
        const token = proof.outcomes.get(transfer.receiptId),
          wire = proof.receipts.get(transfer.receiptId);
        requireDestination(
          token &&
            wire &&
            proof.root.outcome.receipt_ids.includes(transfer.receiptId) &&
            token.outcome.executor_id === source.tokenContract &&
            wire.predecessor_id === source.contractId &&
            wire.receiver_id === source.tokenContract &&
            typeof token.outcome.status.SuccessValue === "string",
          "Selected token receipt was not created directly by this treasury execution",
        );
        const tokenAction = wire.receipt.Action?.actions;
        requireDestination(
          tokenAction?.length === 1,
          "Token call is ambiguous",
        );
        const action = tokenAction[0] as {
          FunctionCall?: { method_name: string; args: string; deposit: string };
        };
        requireDestination(
          Object.keys(tokenAction[0] as object).length === 1 &&
            action.FunctionCall?.method_name === "ft_transfer" &&
            action.FunctionCall.deposit === "1",
          "Expected one canonical one-yocto NEP141 transfer",
        );
        exact(
          decoded(action.FunctionCall.args),
          {
            receiver_id: transfer.recipient,
            amount: source.amount,
            memo: source.paymentId,
          },
          "Token transfer call is not bound by its exact payment memo, recipient and amount",
        );
        await observer.code(
          source.tokenContract,
          token.block_hash,
          trust.expectedTokenCodeHash!,
        );
        const selectedLog = token.outcome.logs[transfer.logIndex];
        requireDestination(
          selectedLog?.startsWith("EVENT_JSON:"),
          "Selected token event is unavailable",
        );
        const event = JSON.parse(selectedLog.slice(11));
        requireDestination(
          event.standard === "nep141" &&
            event.version === "1.0.0" &&
            event.event === "ft_transfer" &&
            Array.isArray(event.data),
          "Selected event is not a canonical token transfer",
        );
        const selected = event.data[transfer.dataIndex];
        requireDestination(
          selected?.old_owner_id === source.contractId &&
            selected.new_owner_id === transfer.recipient &&
            selected.amount === source.amount &&
            selected.memo === source.paymentId,
          "Selected token event is not the exact payment transfer",
        );
        let matching = 0;
        for (const item of proof.outcomes.values())
          if (item.outcome.executor_id === source.tokenContract)
            for (const log of item.outcome.logs)
              if (log.startsWith("EVENT_JSON:")) {
                const value = JSON.parse(log.slice(11));
                if (
                  value.standard === "nep141" &&
                  value.event === "ft_transfer" &&
                  Array.isArray(value.data)
                )
                  for (const data of value.data)
                    if (
                      data.new_owner_id === transfer.recipient ||
                      data.old_owner_id === transfer.recipient
                    ) {
                      requireDestination(
                        data.old_owner_id === source.contractId &&
                          data.new_owner_id === transfer.recipient &&
                          data.amount === source.amount &&
                          item.id === transfer.receiptId,
                        "Additional recipient transfer or refund makes native association ambiguous",
                      );
                      matching++;
                    }
              }
        requireDestination(
          matching === 1,
          "Exactly one isolated destination event is required",
        );
        const callbacks = [...proof.outcomes.values()].filter(
          (item) =>
            item.outcome.executor_id === source.contractId &&
            item.id !== proof.root.id,
        );
        requireDestination(
          callbacks.length === 1,
          "Native payment callback is ambiguous or unavailable",
        );
        const callback = callbacks[0],
          callbackWire = proof.receipts.get(callback.id),
          callbackAction = callbackWire?.receipt.Action?.actions;
        requireDestination(
          callbackWire?.predecessor_id === source.contractId &&
            callbackWire.receiver_id === source.contractId &&
            proof.root.outcome.receipt_ids.includes(callback.id) &&
            callbackAction?.length === 1 &&
            proof.root.outcome.status.SuccessReceiptId === callback.id,
          "Native callback does not belong to this original treasury promise",
        );
        const callbackCall = (
          callbackAction[0] as {
            FunctionCall?: {
              method_name: string;
              args: string;
              deposit: string;
            };
          }
        ).FunctionCall;
        requireDestination(
          callbackCall?.method_name === "on_transfer_result" &&
            callbackCall.deposit === "0",
          "Unexpected native transfer callback",
        );
        exact(
          decoded(callbackCall.args),
          original,
          "Native callback identifies different frozen payment terms",
        );
        const dependency = wire.receipt.Action?.output_data_receivers?.filter(
          (value) =>
            value.receiver_id === source.contractId &&
            callbackWire.receipt.Action?.input_data_ids?.includes(
              value.data_id,
            ),
        );
        requireDestination(
          dependency?.length === 1,
          "Native callback is not bound to the selected token promise result",
        );
        exact(
          observer.event(callback, "source_transfer_result", source.companyId),
          { ...original, success: true, payment_status: "paid" },
          "Native callback did not record successful delivery for this payment",
        );
        requireDestination(
          callback.outcome.status.SuccessValue &&
            decoded(callback.outcome.status.SuccessValue) === true &&
            decoded(proof.tx.status.SuccessValue!) === true,
          "Native payment promise did not finish successfully",
        );
        const final = await observer.snapshot(source, callback.block_hash);
        exact(final.source, source, "Native final historical terms changed");
        requireDestination(
          final.payment.status === "paid" &&
            final.attempt.status === "delivered" &&
            final.attempt.actual_output === source.amount &&
            final.attempt.credited_amount === source.amount,
          "Historical native payment is not delivered for the exact entitlement",
        );
        associated = true;
        add(
          "native_same_execution_binding",
          "passed",
          "One final exact treasury execute_payment action created the selected canonical token transfer, exact payment memo/event and dependent successful callback. Frozen historical recipient, policy, route and approval hashes match independent trust. This is same-transaction selected-RPC execution binding, not a light-client proof.",
        );
      } else {
        requireDestination(
          trust.expectedReporter && source.route.kind === "intents",
          "Reporter association requires an independently specified authorized reporter and Intents route",
        );
        const statement = parseSettlementStatement(evidence.statement);
        requireDestination(
          statement.sourceSha256 === settlementSourceHash(source) &&
            statement.actualOutput === evidence.transfer.amount &&
            BigInt(statement.actualOutput) >=
              BigInt(source.route.output_amount),
          "Structured receipt does not bind the exact frozen source terms and full quoted output",
        );
        exact(
          statement.transfer,
          evidence.transfer,
          "Structured receipt identifies a different destination event",
        );
        const proof = await observer.transaction(
          source,
          evidence.sourceTransaction,
          "report_settlement",
        );
        requireDestination(
          evidence.sourceTransaction.signerId === trust.expectedReporter &&
            (proof.historical.config.owner_id === trust.expectedReporter ||
              proof.historical.config.settlement_reporter ===
                trust.expectedReporter),
          "Historical company authority does not authorize the independently expected reporter",
        );
        const commitment = `sha256:${hashText(evidence.statement)}`;
        exact(
          proof.action.args,
          {
            ...original,
            outcome: "delivered",
            receipt: commitment,
            actual_output: statement.actualOutput,
          },
          "Authorized report does not commit the exact structured UTF8 receipt and actual output",
        );
        exact(
          observer.event(proof.root, "settlement_reported", source.companyId),
          {
            ...original,
            outcome: "delivered",
            reporter: trust.expectedReporter,
          },
          "Historical settlement reporter event does not match",
        );
        requireDestination(
          proof.root.outcome.status.SuccessValue ===
            proof.tx.status.SuccessValue &&
            proof.historical.payment.status === "paid" &&
            proof.historical.attempt.status === "delivered" &&
            proof.historical.attempt.receipt === commitment &&
            proof.historical.attempt.actual_output === statement.actualOutput &&
            proof.historical.attempt.credited_amount === source.amount,
          "Final immutable payment receipt does not match the exact structured report",
        );
        const returned = decoded(proof.tx.status.SuccessValue!);
        requireDestination(
          returned.id === source.paymentId &&
            returned.attempts?.some(
              (item: { id: string; receipt: string; actual_output: string }) =>
                item.id === source.attemptId &&
                item.receipt === commitment &&
                item.actual_output === statement.actualOutput,
            ),
          "Final report return does not bind the exact payment and structured receipt",
        );
        associated = true;
        add(
          "authorized_reporter_association",
          "passed",
          "The independently expected authorized reporter committed the exact structured destination receipt on NEAR for this frozen payment/attempt. This is an operator association attestation, not trustless bridge causality or independent destination observation.",
        );
      }
      await observer.network(evidence.source.network);
    } catch (error) {
      add(
        evidence.kind === "native_execution"
          ? "native_same_execution_binding"
          : "authorized_reporter_association",
        error instanceof DestinationFailure ? "failed" : "unavailable",
        error instanceof DestinationFailure
          ? error.message
          : "Bounded historical source receipts, code, frozen terms or retained structured material are unavailable. No current-state or free-text reconstruction fallback is used.",
      );
    }
  } else
    add(
      evidence.kind === "native_execution"
        ? "native_same_execution_binding"
        : "authorized_reporter_association",
      "not_checked",
      "Independent matching trust and an explicitly selected archival source NEAR RPC are required.",
    );
  const destination = await verifyDestinationEvidence(
    {
      schema: "razor.destination-evidence",
      version: 1,
      transfer: evidence.transfer,
    },
    {
      ...(trust
        ? {
            trust: {
              schema: "razor.destination-trust",
              version: 1,
              ...trust.destination,
            },
          }
        : {}),
      rpcUrl: matched ? options.destinationRpcUrl : undefined,
      transport: options.transport,
    },
  );
  claims.push(
    ...destination.claims.filter((item) =>
      [
        "independent_destination_expectation",
        "destination_transfer_observation",
      ].includes(item.claim),
    ),
  );
  return {
    schema: "razor.settlement-link-report" as const,
    version: 1 as const,
    associationClass:
      evidence.kind === "native_execution"
        ? "same_transaction_execution"
        : "authorized_reporter_attestation",
    associated,
    destinationObservation: destination.observation,
    claims,
    limitations: [
      "RPC responses are trusted observations, not independently checked light-client proofs.",
      "Cross-chain reporter association and independent destination observation remain distinct. Neither proves bridge causality, invoice truth, inference plaintext or legal discharge.",
      "Only shared_v1 full-delivery execute_payment/report_settlement flows are supported. Batched actions, partial delivery, old free-text receipts, expired/redacted raw statements and changed historical recipient/policy snapshots remain unavailable.",
      "Explicitly exporting a selected structured statement discloses one payment's destination, amount, public references and blinded source-term hash. No other salary rows, documents or keys are included.",
    ],
  };
}

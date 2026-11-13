import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { getDb, row, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { contractCodeHash, view } from "../payments/near";
import { reconcilePayment } from "../payments/service";
import type { AccessContext } from "../context";
import type { ApprovalStatus, ChainPayment, Payment, PayoutAttempt, TreasuryConfig } from "../payments/types";
import { isPaused, iso, notify, workerConfiguration } from "./service";
import { assertLease } from "./worker";
import { checkedApprovalStatus } from "../treasury-policy/approvals";
import { executionTerms, type ExecutionRecord } from "../reconciliation/direct";
import type { AgentMandate, OperationJob } from "./types";
import { reviewedArtifactHash } from "../near-artifacts";

interface Submission { tx_hash: string; signed_transaction_ciphertext: string; status: string; executor_account_id: string }
interface ChainConfig { paused: boolean; owner_id: string; token_contract: string; policy_version: string; executors: string[]; approvers: string[] }
type RoutePayment = Omit<ChainPayment, "attempts"> & { policy_version: string; recipient_version: string; attempts: (ChainPayment["attempts"][number] & { destination: { asset_id: string; network: string; address: string } })[] };

export async function executeApprovedAttempt(job: OperationJob, access: AccessContext) {
  const blocked = (reason: string) => {
    notify(job.organization_id, `execute-attention:${job.entity_id}:${reason}`, "Payment requires attention", reason, job.entity_id);
    return { status: "blocked" as const, delayMs: 300_000, detail: { mode: "manual", reason, attemptId: job.entity_id } };
  };
  const worker = workerConfiguration();
  if (!worker.configured || !worker.accountId) return blocked("A company signer must authorize this payment in the NEAR wallet. No restricted worker signer is configured.");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", job.organization_id);
  const mandate = row<AgentMandate>("SELECT * FROM agent_mandates WHERE organization_id=?", job.organization_id);
  if (!config || config.network !== worker.network || config.near_account_id !== worker.treasuryAccountId) return blocked("The configured worker signer belongs to another treasury or network.");
  if (!mandate?.enabled || mandate.executor_account_id !== worker.accountId || Date.parse(mandate.expires_at) <= Date.now()) return blocked("Execution mandate is paused, expired or missing. Owner wallet approval is still required for every new route.");
  if (isPaused(job.organization_id)) return blocked("Company payments are paused.");
  const attempt = row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE id=? AND organization_id=?", job.entity_id, job.organization_id);
  if (!attempt) return { status: "completed" as const, detail: { missing: true } };
  const payment = row<Payment>("SELECT * FROM payments WHERE id=? AND organization_id=?", attempt.payment_id, job.organization_id);
  if (!payment || ["paid", "cancelled", "partially_paid"].includes(payment.status)) return { status: "completed" as const, detail: { closed: true } };
  if (payment.scheduled_for && Date.parse(payment.scheduled_for) > Date.now()) return blocked("This payment is not due yet.");
  const recipient = row<{ version: number; archived: number; preference_status: string }>("SELECT version,archived,preference_status FROM recipients WHERE id=? AND organization_id=?", payment.recipient_id, job.organization_id);
  if (!recipient || recipient.version !== payment.recipient_version || recipient.archived || recipient.preference_status !== "confirmed") return blocked("Recipient preferences changed. Review a new payment before execution.");
  if (BigInt(attempt.amount_in) > BigInt(mandate.max_amount)) return blocked("The exact source amount exceeds the execution mandate ceiling.");
  let reviewedCode: string;
  try { reviewedCode = reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm"); } catch { return blocked("Review the treasury deployment before enabling automatic execution."); }
  const [chain, chainConfig, code] = await Promise.all([view<RoutePayment | null>(config, "get_payment", { payment_id: payment.id }), view<ChainConfig>(config, "get_config"), contractCodeHash(config)]);
  if (code !== reviewedCode) return blocked("The treasury code changed from the reviewed deployment. Automatic signing is disabled until its authority is reviewed.");
  const recorded = chain?.attempts.find((item) => item.id === attempt.id);
  const exact = chain?.attempts.at(-1);
  if (recorded && ["sending", "source_sent", "uncertain", "refund_pending", "refund_verifying", "delivered", "partially_delivered", "refunded", "transfer_failed", "discarded"].includes(recorded.status)) {
    await reconcilePayment(access, payment.id);
    getDb().prepare("UPDATE operation_submissions SET status='source_recorded',updated_at=? WHERE attempt_id=? AND organization_id=?").run(iso(), attempt.id, job.organization_id);
    return { status: "completed" as const, detail: { sourceRecorded: true, chainStatus: recorded.status } };
  }
  if (!chain || !exact || exact.id !== attempt.id || exact.status !== "prepared" || !exact.authorized || !["approved", "retryable"].includes(chain.status)) return blocked("The exact route needs owner or approver authorization in the NEAR wallet.");
  if (chainConfig.paused || isPaused(job.organization_id)) return blocked("Company or onchain treasury payments are paused.");
  if (chainConfig.token_contract !== config.token_contract || chainConfig.owner_id === worker.accountId || !chainConfig.executors.includes(worker.accountId) || chainConfig.approvers.includes(worker.accountId)) return blocked("A dedicated executor role is required. The worker cannot act as owner or approver.");
  if (chain.policy_version !== chainConfig.policy_version || BigInt(chain.expires_at_ms) <= BigInt(Date.now())) return blocked("The onchain policy or payment approval expired. Renew it in the owner wallet.");
  if (BigInt(chain.not_before_ms) > BigInt(Date.now()) || chain.not_before_ms !== String(payment.scheduled_for ? Math.max(0, Date.parse(payment.scheduled_for)) : 0)) return blocked("The onchain schedule is not due or differs from the approved obligation.");
  let quorum: ApprovalStatus;
  try { quorum = checkedApprovalStatus(await view<ApprovalStatus>(config, "get_approval_status", { payment_id: payment.id, attempt_id: attempt.id }), payment.id, attempt.id); } catch { return blocked("The treasury approval quorum could not be verified. Refresh the reviewed contract state."); }
  if (!quorum.can_execute || quorum.policy_version !== chainConfig.policy_version || quorum.approval_amount !== (BigInt(payment.amount) + BigInt(payment.max_fee)).toString()) return blocked("The current amount-based approval quorum is incomplete or stale. Every required wallet must approve the exact route.");
  const quote = JSON.parse(attempt.quote) as ExecutionRecord;
  const terms = executionTerms(quote);
  const deadline = Date.parse(terms.deadline);
  if (deadline <= Date.now() || String(deadline) !== exact.route.deadline_ms) return blocked("The owner-authorized quote expired or its deadline changed.");
  if (chain.amount !== payment.amount || chain.max_fee !== payment.max_fee || chain.reference !== `razor:${payment.id}` || chain.recipient_id !== payment.recipient_id
    || exact.route.quote_hash !== createHash("sha256").update(attempt.quote).digest("hex") || exact.route.kind !== terms.kind
    || exact.route.input_amount !== attempt.amount_in || exact.route.output_amount !== attempt.expected_output || exact.route.source_receiver !== attempt.deposit_address
    || exact.destination.asset_id !== attempt.destination_asset || exact.destination.network !== attempt.destination_network || exact.destination.address !== attempt.destination_address
    || exact.use_backup !== (attempt.route === "backup")) return blocked("The stored payment and the exact onchain route disagree. Reconcile them before signing.");
  const { Account, JsonRpcProvider, KeyPairSigner, SignedTransaction, actions } = await import("near-api-js");
  const provider = new JsonRpcProvider({ url: config.network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org" }, { retries: 0 });
  const signer = KeyPairSigner.fromSecretKey(process.env.RAZOR_EXECUTOR_PRIVATE_KEY as `ed25519:${string}`);
  const publicKey = await signer.getPublicKey();
  const key = await provider.viewAccessKey({ accountId: worker.accountId, publicKey, finalityQuery: { finality: "final" } });
  const permission = typeof key.permission === "object" && "FunctionCall" in key.permission ? key.permission.FunctionCall : null;
  if (!permission || permission.receiver_id !== config.near_account_id || permission.method_names.length !== 1 || permission.method_names[0] !== "execute_payment") return blocked("Refusing an unrestricted key. Configure a function-call key limited to this treasury's execute_payment method.");
  let submission = row<Submission>("SELECT * FROM operation_submissions WHERE attempt_id=? AND organization_id=?", attempt.id, job.organization_id);
  if (submission?.status === "failed") return blocked("The recorded source transaction failed. Close or renew the unsent route in the owner wallet.");
  if (submission && submission.executor_account_id !== worker.accountId) return blocked("The executor changed while a signed submission is unresolved.");
  if (!submission) {
    const account = new Account(worker.accountId, provider, signer);
    const signed = await account.createSignedTransaction({ receiverId: config.near_account_id, actions: [actions.functionCall("execute_payment", { payment_id: payment.id, attempt_id: attempt.id }, 100_000_000_000_000n, 0n)] });
    const hash = base58.encode(createHash("sha256").update(signed.transaction.encode()).digest());
    transaction(() => {
      assertLease(job);
      getDb().prepare("INSERT OR IGNORE INTO operation_submissions(attempt_id,organization_id,executor_account_id,tx_hash,signed_transaction_ciphertext,status,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?)")
        .run(attempt.id, job.organization_id, worker.accountId!, hash, encrypt(Buffer.from(signed.encode()).toString("base64")), iso(), iso());
    });
    submission = row<Submission>("SELECT * FROM operation_submissions WHERE attempt_id=? AND organization_id=?", attempt.id, job.organization_id)!;
  }
  assertLease(job);
  const currentMandate = row<AgentMandate>("SELECT * FROM agent_mandates WHERE organization_id=?", job.organization_id);
  if (isPaused(job.organization_id) || !currentMandate?.enabled || currentMandate.executor_account_id !== worker.accountId || Date.parse(currentMandate.expires_at) <= Date.now() || BigInt(attempt.amount_in) > BigInt(currentMandate.max_amount)) return blocked("The execution mandate was paused or changed before broadcast.");
  const currentPayment = row<{ status: string; recipient_version: number }>("SELECT status,recipient_version FROM payments WHERE id=? AND organization_id=?", payment.id, job.organization_id);
  const currentRecipient = row<{ version: number; archived: number; preference_status: string }>("SELECT version,archived,preference_status FROM recipients WHERE id=? AND organization_id=?", payment.recipient_id, job.organization_id);
  if (!currentPayment || ["paid", "cancelled", "partially_paid"].includes(currentPayment.status) || currentPayment.recipient_version !== payment.recipient_version || !currentRecipient || currentRecipient.version !== payment.recipient_version || currentRecipient.archived || currentRecipient.preference_status !== "confirmed") return blocked("Payment or recipient preferences changed before broadcast. Review the obligation in the owner wallet.");
  const signed = SignedTransaction.decode(Buffer.from(decrypt(submission.signed_transaction_ciphertext), "base64"));
  if (signed.transaction.signerId !== worker.accountId || signed.transaction.receiverId !== config.near_account_id || signed.transaction.publicKey.toString() !== publicKey.toString()) return blocked("The recorded transaction does not match the restricted executor.");
  try {
    const outcome = await provider.sendTransactionUntil(signed, "FINAL");
    const failed = typeof outcome.status === "object" && "Failure" in outcome.status;
    getDb().prepare("UPDATE operation_submissions SET status=?,updated_at=? WHERE attempt_id=?").run(failed ? "failed" : "broadcast", iso(), attempt.id);
    getDb().prepare("UPDATE payout_attempts SET source_tx_hash=?,state=CASE WHEN state='prepared' THEN 'submitted' ELSE state END,updated_at=? WHERE id=? AND organization_id=?").run(submission.tx_hash, iso(), attempt.id, job.organization_id);
    await reconcilePayment(access, payment.id);
    return failed ? blocked("The source transaction failed. Inspect its receipt and renew authorization if needed.") : { status: "completed" as const, detail: { txHash: submission.tx_hash, sourceSubmitted: true, finalDeliveryRequiresReconciliation: true } };
  } catch {
    getDb().prepare("UPDATE operation_submissions SET status='uncertain',updated_at=? WHERE attempt_id=? AND status!='failed'").run(iso(), attempt.id);
    return { status: "queued" as const, delayMs: 60_000, detail: { txHash: submission.tx_hash, uncertain: true, sameSignedTransactionOnly: true } };
  }
}

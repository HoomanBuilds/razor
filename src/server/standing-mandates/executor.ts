import { createHash, randomUUID } from "node:crypto";
import { base58 } from "@scure/base";
import { ApiError, type AccessContext } from "../context";
import { getDb, row, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { getRecipient } from "../identity/recipients";
import { assertNoActiveClearing } from "../clearing/locks";
import { billCommitmentReview } from "../vendor-commitments/service";
import { assertPaymentLiabilityApproved, getTreasury, reconcilePayment } from "../payments/service";
import { treasuryArgs, view } from "../payments/near";
import type { ChainPayment, Payment, PayoutAttempt, TreasuryConfig } from "../payments/types";
import type { DirectExecution } from "../reconciliation/direct";
import { assertLease } from "../operations/worker";
import { iso, isPaused, notify } from "../operations/service";
import type { OperationJob } from "../operations/types";
import { inspectGrant, nativeExecutionHash, standingConfig } from "./service";
import { assertNativeSupplier, standingProblems, supplierHash, type StandingRow } from "./model";

export function standingWorker(config: TreasuryConfig) {
  const env = process.env;
  return { accountId: env.RAZOR_STANDING_EXECUTOR_ACCOUNT_ID ?? null, configured: !!env.RAZOR_STANDING_EXECUTOR_PRIVATE_KEY
    && !!env.RAZOR_STANDING_EXECUTOR_ACCOUNT_ID && env.RAZOR_STANDING_EXECUTOR_NETWORK === config.network
    && env.RAZOR_STANDING_EXECUTOR_TREASURY_ACCOUNT_ID === config.near_account_id
    && env.RAZOR_STANDING_EXECUTOR_COMPANY_ID === config.company_id };
}
export function assertStandingBill(access: AccessContext, payment: Payment, mandate: StandingRow) {
  if (isPaused(access.organizationId) || !mandate.enabled || mandate.invalidated_at) throw new ApiError(409, "Company or native grant is paused or invalidated", "STANDING_DISABLED");
  if (!["approved", "prepared"].includes(payment.status) || !payment.approved_at || !payment.approved_by
    || payment.kind !== "invoice" || payment.total_spent !== "0" || payment.delivered_amount !== "0") throw new ApiError(409, "Only accepted, approved and unpaid vendor bills qualify", "STANDING_BILL_REQUIRED");
  if (payment.recipient_id !== mandate.recipient_id || payment.recipient_version !== mandate.supplier_version
    || supplierHash(getRecipient(access.organizationId, payment.recipient_id)) !== mandate.supplier_profile_hash) throw new ApiError(409, "Supplier profile changed after the grant", "STANDING_SUPPLIER_CHANGED");
  if (payment.scheduled_for && Date.parse(payment.scheduled_for) > Date.now()) throw new ApiError(409, "The bill is not due", "STANDING_NOT_DUE");
  assertNoActiveClearing(access.organizationId, payment.id);
  assertPaymentLiabilityApproved(access, payment);
  const bill = row<{ id: string; accepted_at: string | null; amount: string; setoff_amount: string; vendor_commitment_id: string | null }>("SELECT id,accepted_at,amount,setoff_amount,vendor_commitment_id FROM bills WHERE payment_id=? AND organization_id=? AND recipient_id=? AND status='approved'", payment.id, access.organizationId, payment.recipient_id);
  if (!bill?.accepted_at || bill.amount !== payment.amount || bill.setoff_amount !== "0") throw new ApiError(409, "A complete accepted vendor invoice is required. Cleared and partial bills use exact review", "STANDING_BILL_REQUIRED");
  const commitment = billCommitmentReview(access.organizationId, bill.id);
  if (commitment && (!commitment.accepted || commitment.problems.length)) throw new ApiError(409, "The named purchase commitment needs application review", "STANDING_COMMITMENT_REQUIRED");
  if (BigInt(payment.reserved_amount) < BigInt(payment.amount) + BigInt(payment.max_fee)) throw new ApiError(409, "Fund and reserve the complete accepted budget first", "STANDING_UNFUNDED");
  if (getTreasury(access).reserveDeficit !== "0") throw new ApiError(409, "Company cash reservations need reconciliation", "STANDING_RESERVE_DEFICIT");
}

export async function tryExecuteStandingPayment(job: OperationJob, access: AccessContext) {
  const payment = row<Payment>("SELECT * FROM payments WHERE id=? AND organization_id=?", job.entity_id, job.organization_id);
  if (!payment || ["paid", "cancelled", "partially_paid"].includes(payment.status)) return null;
  const execution = row<{ mandate_id: string; attempt_id: string }>("SELECT mandate_id,attempt_id FROM standing_executions WHERE payment_id=? AND organization_id=?", payment.id, job.organization_id);
  const mandate = row<StandingRow>(execution ? "SELECT * FROM standing_mandates WHERE id=? AND organization_id=?" : "SELECT * FROM standing_mandates WHERE recipient_id=? AND organization_id=? AND enabled=1", execution?.mandate_id ?? payment.recipient_id, job.organization_id);
  if (!mandate) return null;
  const blocked = (reason: string) => {
    notify(job.organization_id, `standing-held:${payment.id}:${reason}`, "Native autopay needs review", `${reason}. Exact-route owner review remains available.`, payment.id);
    return { status: "blocked" as const, delayMs: 300_000, detail: { reason, paymentId: payment.id, grantId: mandate.id, mode: "native_standing", exactReviewAvailable: true } };
  };
  const config = await standingConfig(access);
  // Monitoring remains available after local pause, expiry, supplier changes or revocation.
  const chain = await view<ChainPayment | null>(config, "get_payment", { payment_id: payment.id });
  if (execution && chain) {
    const bound = await view<string | null>(config, "get_standing_payment", { payment_id: payment.id });
    if (bound !== mandate.id || chain.attempts.at(-1)?.id !== execution.attempt_id) return blocked("The onchain payment does not match the recorded native grant");
    await reconcilePayment(access, payment.id);
    return { status: "completed" as const, detail: { monitored: true, paymentId: payment.id, grantId: mandate.id, status: chain.status } };
  }
  if (chain) return blocked("This payment already has exact-route authority. Continue its existing review");
  try {
    assertStandingBill(access, payment, mandate);
    const profile = getRecipient(access.organizationId, payment.recipient_id); assertNativeSupplier(profile, config.token_contract);
    const state = await inspectGrant(access, mandate.id);
    const worstCase = (BigInt(payment.amount) + BigInt(payment.max_fee)).toString();
    if (!state.grant || !state.eligible || state.grant.terms_hash !== mandate.terms_hash) return blocked(state.problems.join(". ") || "Observe and enable the reviewed grant first");
    const problems = standingProblems(state.grant, state.policy, state.activationMs, Date.now(), worstCase);
    if (problems.length) return blocked(problems.join(". "));
    const worker = standingWorker(config);
    if (!worker.configured || worker.accountId !== state.grant.terms.actor_id) return blocked("Configure the dedicated native worker for this company and grant");
    const { Account, JsonRpcProvider, KeyPairSigner, SignedTransaction, actions } = await import("near-api-js");
    const provider = new JsonRpcProvider({ url: config.network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org" }, { retries: 1 });
    const signer = KeyPairSigner.fromSecretKey(process.env.RAZOR_STANDING_EXECUTOR_PRIVATE_KEY as `ed25519:${string}`);
    const publicKey = await signer.getPublicKey();
    if (publicKey.toString() !== state.grant.terms.actor_public_key) return blocked("The native worker key differs from the owner's grant");
    const key = await provider.viewAccessKey({ accountId: worker.accountId!, publicKey, finalityQuery: { finality: "final" } });
    const permission = typeof key.permission === "object" && "FunctionCall" in key.permission ? key.permission.FunctionCall : null;
    if (!permission || permission.receiver_id !== config.near_account_id || permission.method_names.length !== 1 || permission.method_names[0] !== "execute_standing_payment") return blocked("The native key must permit only this treasury's execute_standing_payment method");
    let attempt = execution ? row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE id=? AND organization_id=?", execution.attempt_id, job.organization_id) : undefined;
    if (!attempt) {
      if (row("SELECT id FROM payout_attempts WHERE payment_id=?", payment.id)) return blocked("An existing attempt must be reconciled before native autopay");
      const attemptId = randomUUID();
      const quote: DirectExecution = { kind: "direct", network: "near", assetId: `nep141:${config.token_contract}`,
        recipient: state.grant.destination.address, amountIn: payment.amount, amountOut: payment.amount,
        deadline: new Date(Number(state.grant.terms.expires_at_ms)).toISOString(), authorization: "NEAR standing mandate", standingGrantId: mandate.id };
      transaction(db => {
        assertLease(job);
        const fresh = row<Payment>("SELECT * FROM payments WHERE id=? AND organization_id=?", payment.id, job.organization_id)!;
        const freshGrant = row<StandingRow>("SELECT * FROM standing_mandates WHERE id=? AND organization_id=?", mandate.id, job.organization_id)!;
        assertStandingBill(access, fresh, freshGrant);
        if (row("SELECT id FROM payout_attempts WHERE payment_id=?", payment.id)) throw new ApiError(409, "Another worker prepared this obligation", "STANDING_ATTEMPT_EXISTS");
        db.prepare("INSERT INTO payout_attempts(id,payment_id,organization_id,route,state,quote,destination_asset,destination_network,destination_address,expected_output,amount_in,deposit_address,created_at,updated_at) VALUES(?,?,?,'primary','prepared',?,?,?,?,?,?,?,?,?)")
          .run(attemptId, payment.id, job.organization_id, JSON.stringify(quote), quote.assetId, "near", quote.recipient, payment.amount, payment.amount, quote.recipient, iso(), iso());
        const decision = { actorType: "standing_executor", actorAccountId: worker.accountId, grantId: mandate.id,
          termsHash: state.grant!.terms_hash, supplierProfileHash: mandate.supplier_profile_hash,
          invoiceGate: "existing_human_application_acceptance", commitmentEnforcement: "application_review_gate", maximumInput: worstCase };
        db.prepare("INSERT INTO standing_executions(payment_id,organization_id,mandate_id,attempt_id,actor_account_id,decision_json,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(payment.id, job.organization_id, mandate.id, attemptId, worker.accountId!, JSON.stringify(decision), iso());
        db.prepare("UPDATE payments SET status='prepared',updated_at=? WHERE id=? AND organization_id=?").run(iso(), payment.id, job.organization_id);
        db.prepare("INSERT INTO activity(id,organization_id,actor_id,action,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), job.organization_id, `near:${worker.accountId}`, "standing.bill_eligible", payment.id, JSON.stringify(decision), iso());
      });
      attempt = row<PayoutAttempt>("SELECT * FROM payout_attempts WHERE id=?", attemptId)!;
    }
    const args = treasuryArgs(config, { mandate_id: mandate.id, payment_id: payment.id, attempt_id: attempt.id,
      amount: payment.amount, max_fee: payment.max_fee, reference: `razor:${payment.id}`, expected_terms_hash: state.grant.terms_hash, execution_hash: nativeExecutionHash(JSON.parse(attempt.quote)) });
    type Submission = { tx_hash: string; signed_transaction_ciphertext: string; executor_account_id: string; status: string };
    let submission = row<Submission>("SELECT * FROM operation_submissions WHERE attempt_id=? AND organization_id=?", attempt.id, job.organization_id);
    if (submission?.status === "failed") return blocked("The native source transaction failed. Inspect its final receipt before reviewing a replacement grant");
    if (!submission) {
      const account = new Account(worker.accountId!, provider, signer);
      const signed = await account.createSignedTransaction({ receiverId: config.near_account_id,
        actions: [actions.functionCall("execute_standing_payment", args, 100_000_000_000_000n, 0n)] });
      transaction(db => {
        assertLease(job);
        db.prepare("INSERT OR IGNORE INTO operation_submissions(attempt_id,organization_id,executor_account_id,tx_hash,signed_transaction_ciphertext,status,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?)")
          .run(attempt!.id, job.organization_id, worker.accountId!, base58.encode(createHash("sha256").update(signed.transaction.encode()).digest()), encrypt(Buffer.from(signed.encode()).toString("base64")), iso(), iso());
      });
      submission = row<Submission>("SELECT * FROM operation_submissions WHERE attempt_id=? AND organization_id=?", attempt.id, job.organization_id)!;
    }
    const signed = SignedTransaction.decode(Buffer.from(decrypt(submission.signed_transaction_ciphertext), "base64"));
    const call = signed.transaction.actions.length === 1 ? signed.transaction.actions[0].functionCall : undefined;
    if (signed.transaction.signerId !== worker.accountId || signed.transaction.receiverId !== config.near_account_id
      || signed.transaction.publicKey.toString() !== publicKey.toString() || !call || call.methodName !== "execute_standing_payment"
      || call.deposit !== 0n || JSON.stringify(JSON.parse(Buffer.from(call.args).toString())) !== JSON.stringify(args)) return blocked("The stored signed native submission has different authority or terms");
    assertLease(job);
    assertStandingBill(access, row<Payment>("SELECT * FROM payments WHERE id=? AND organization_id=?", payment.id, job.organization_id)!, row<StandingRow>("SELECT * FROM standing_mandates WHERE id=? AND organization_id=?", mandate.id, job.organization_id)!);
    getDb().prepare("UPDATE payout_attempts SET source_tx_hash=?,updated_at=? WHERE id=? AND organization_id=?").run(submission.tx_hash, iso(), attempt.id, job.organization_id);
    try {
      const outcome = await provider.sendTransactionUntil(signed, "FINAL");
      const failed = typeof outcome.status === "object" && "Failure" in outcome.status;
      getDb().prepare("UPDATE operation_submissions SET status=?,updated_at=? WHERE attempt_id=? AND organization_id=?").run(failed ? "failed" : "broadcast", iso(), attempt.id, job.organization_id);
      getDb().prepare("UPDATE payout_attempts SET source_tx_hash=?,state=CASE WHEN state='prepared' THEN 'submitted' ELSE state END,updated_at=? WHERE id=? AND organization_id=?").run(submission.tx_hash, iso(), attempt.id, job.organization_id);
      await reconcilePayment(access, payment.id);
      return failed ? blocked("Native source execution failed. Reconcile the existing attempt") : { status: "completed" as const, detail: { txHash: submission.tx_hash, grantId: mandate.id, nativeSourceSubmitted: true, deliveryRequiresReconciliation: true } };
    } catch {
      getDb().prepare("UPDATE operation_submissions SET status='uncertain',updated_at=? WHERE attempt_id=? AND status!='failed'").run(iso(), attempt.id);
      getDb().prepare("UPDATE payout_attempts SET state='unknown',updated_at=? WHERE id=? AND organization_id=?").run(iso(), attempt.id, job.organization_id);
      return { status: "queued" as const, delayMs: 60_000, detail: { txHash: submission.tx_hash, uncertain: true, sameSignedTransactionOnly: true } };
    }
  } catch (error) {
    if (error instanceof ApiError) return blocked(error.message);
    throw error;
  }
}

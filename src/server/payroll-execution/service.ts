import { createHash, randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { payrollReview } from "../payment-management/service";
import { recipientRouteReadiness } from "../payment-management/routing";
import { getPayrollRun } from "../business/service";
import { closeUnfundedAttempt, getAttempt, getPayment, listAttempts, markAttemptSubmitted, prepareAttemptApproval, preparePaymentQuote, reconcilePayment, reserveApprovedPayment, resumeAttempt } from "../payments/service";
import { getSupportedTokens, type Token } from "../payments/intents";
import { nearTransactionStatus, view, type FinalTransaction } from "../payments/near";
import { executionTerms, type ExecutionRecord } from "../reconciliation/direct";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import { BATCH_LIMITS, boundedTransactions, intersectSigners, type ExecutionStage } from "./model";

const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const active = ["planning", "review", "signing", "reconciling"];
const closedAttempts = ["closed_unfunded", "refunded_verified"];
type Plan = Awaited<ReturnType<typeof resumeAttempt>>;
type Block = { paymentId: string; code: string; reason: string };
interface Approval { id: string; review_hash: string; approved_by: string; approvedName: string; created_at: string }
interface Selection { paymentId: string; useBackup?: boolean }
interface Entry { paymentId: string; attemptId: string; recipientName: string; entitlement: string; maxFee: string; amountIn: string; routeCost: string; asset: string; symbol: string | null; decimals: number | null; network: string; address: string; memo: string | null; output: string; deadline: string; quoteHash: string; planHash: string; accounts: string[]; approvals: Plan["approvals"]; actions: WalletTransaction[] }
interface Payload { approvalId: string; approvalHash: string; network: string; entries: Entry[]; transactions: { paymentId: string; attemptId: string; action: WalletTransaction }[]; signerAccounts: string[]; blocked: Block[]; gas: string; remainingTransactions: number }
interface BatchRow { id: string; organization_id: string; run_id: string; actor_id: string; stage: ExecutionStage; status: string; review_hash: string | null; payload_ciphertext: string; signer_account: string | null; receipts_ciphertext: string; created_at: string; updated_at: string }
export interface BatchReceipt { index: number; hash: string }
interface ReceiptRecord extends BatchReceipt { verified?: boolean; failed?: boolean }
interface Authority { policyVersion: string; paused: boolean; signerAccounts: string[]; approvalAccounts: string[] }
export interface ExecutionDependencies { quote: typeof preparePaymentQuote; resume: typeof resumeAttempt; approval: typeof prepareAttemptApproval; reconcile: typeof reconcilePayment; close: typeof closeUnfundedAttempt; receipt: typeof nearTransactionStatus; tokens: () => Promise<Token[]>; authority: (access: AccessContext) => Promise<Authority | null> }
async function runAuthority(access: AccessContext): Promise<Authority | null> {
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) return null;
  const policy = await view<{ owner_id: string; approvers: string[]; executors?: string[]; policy_version: string; paused: boolean }>(config, "get_config");
  const linked = rows<{ address: string }>("SELECT address FROM linked_wallets WHERE user_id=? AND family='near' AND network=?", access.userId, config.network).map(value => value.address);
  return { policyVersion: policy.policy_version, paused: policy.paused, signerAccounts: linked.filter(account => account === policy.owner_id || policy.approvers.includes(account) || policy.executors?.includes(account)), approvalAccounts: linked.filter(account => account === policy.owner_id || policy.approvers.includes(account)) };
}
const defaults: ExecutionDependencies = { quote: preparePaymentQuote, resume: resumeAttempt, approval: prepareAttemptApproval, reconcile: reconcilePayment, close: closeUnfundedAttempt, receipt: nearTransactionStatus, tokens: getSupportedTokens, authority: runAuthority };

function approval(access: AccessContext, runId: string) {
  return row<Approval>("SELECT a.id,a.review_hash,a.approved_by,a.created_at,u.name AS approvedName FROM payroll_run_approvals a JOIN users u ON u.id=a.approved_by WHERE a.organization_id=? AND a.run_id=? ORDER BY a.rowid DESC LIMIT 1", access.organizationId, runId) ?? null;
}

function errorBlock(paymentId: string, error: unknown): Block {
  return { paymentId, code: error instanceof ApiError ? error.code : "ROUTE_CHECK_UNAVAILABLE", reason: error instanceof ApiError ? error.message : "The network check is unavailable. Check status before resuming this line" };
}

function getBatch(access: AccessContext, runId: string, batchId: string) {
  requirePermission(access, "payments:read");
  const batch = row<BatchRow>("SELECT * FROM payroll_execution_batches WHERE id=? AND organization_id=? AND run_id=?", batchId, access.organizationId, runId);
  if (!batch) throw new ApiError(404, "Run wallet group not found", "BATCH_NOT_FOUND");
  return batch;
}

function payload(batch: BatchRow): Payload { return JSON.parse(decrypt(batch.payload_ciphertext)); }
function receipts(batch: BatchRow): ReceiptRecord[] { return JSON.parse(decrypt(batch.receipts_ciphertext)); }
function publicBatch(batch: BatchRow) {
  const data = payload(batch);
  return { id: batch.id, stage: batch.stage, status: batch.status, reviewHash: batch.review_hash, signerAccount: batch.signer_account, createdAt: batch.created_at, ...data, receipts: receipts(batch), limits: BATCH_LIMITS };
}

function assertApproved(access: AccessContext, runId: string) {
  const review = payrollReview(access, runId), version = approval(access, runId);
  if (!version || review.run.status !== "approved") throw new ApiError(409, "Review and approve the current pay run before preparing wallet actions", "RUN_APPROVAL_REQUIRED");
  return { review, version };
}

export async function executionOverview(access: AccessContext, runId: string, dependencies = defaults) {
  const review = payrollReview(access, runId), run = getPayrollRun(access, runId), version = approval(access, runId);
  let tokens: Token[] | null = null;
  const [catalog, currentAuthority] = await Promise.allSettled([dependencies.tokens(), dependencies.authority(access)]);
  if (catalog.status === "fulfilled") tokens = catalog.value;
  const authority = currentAuthority.status === "fulfilled" ? currentAuthority.value : null;
  const disabled = new Set(rows<{ network: string }>("SELECT network FROM payment_networks WHERE organization_id=? AND enabled=0", access.organizationId).map(value => value.network));
  const batches = rows<BatchRow>("SELECT * FROM payroll_execution_batches WHERE organization_id=? AND run_id=? ORDER BY rowid DESC LIMIT 20", access.organizationId, runId);
  const current = batches.find(batch => active.includes(batch.status));
  const data = current ? payload(current) : null;
  const lines = review.items.map(item => {
    const attempts = listAttempts(access, item.payment.id), attempt = attempts.at(-1) ?? null;
    const liability = run.items.find(line => line.id === item.id)!;
    const route = recipientRouteReadiness(item.recordedProfile, tokens, disabled);
    const blocks: { code: string; reason: string }[] = [];
    const block = (code: string, reason: string) => blocks.push({ code, reason });
    let stage: string = "prepare", deadline: string | null = null;
    if (!version || review.run.status !== "approved" || !item.payment.approved_at) block("RUN_APPROVAL_REQUIRED", "Review and approve the exact current run amounts and receiving details");
    if (item.profileChanged || item.currentProfile.archived || item.currentProfile.preference_status !== "confirmed" || !item.currentProfile.confirmed_at) block("RECIPIENT_CONFIRMATION_REQUIRED", "Recipient confirmation is missing or the approved receiving profile changed. Review the recipient details");
    if (!review.funding.treasuryConfigured) block("TREASURY_SETUP_REQUIRED", "Connect the company treasury before preparing routes");
    if (!access.permissions.includes("payments:execute")) block("EXECUTOR_REQUIRED", "An authorized company executor must prepare and execute routes");
    if (currentAuthority.status === "rejected") block("AUTHORITY_CHECK_UNAVAILABLE", "The current NEAR authority could not be checked. Refresh before signing");
    if (authority?.paused) block("POLICY_PAUSED", "The treasury is paused. Ask the owner to review the current payment policy");
    if (authority && !authority.signerAccounts.length && !authority.approvalAccounts.length) block("MISSING_AUTHORITY", "Link a verified NEAR wallet authorized by the company treasury policy");
    if (item.activeClearingRound) block("CLEARING_ROUND_LOCKED", "Reconcile the active clearing round before paying this obligation");
    if (["unknown", "recovery_pending", "in_flight", "held"].includes(item.payment.status) || attempt && !["prepared", ...closedAttempts].includes(attempt.state)) stage = "reconcile";
    if (item.payment.partial_delivery_observed || item.payment.status === "partially_paid") { stage = "held"; block("PARTIAL_LIABILITY", "Resolve the terminal partial entitlement and separately review its unpaid remainder"); }
    if (item.payment.status === "cancelled") { stage = "held"; block("PAYMENT_CANCELLED", "This cancelled obligation needs an explicitly reviewed replacement"); }
    if (attempt?.state === "prepared") {
      stage = "review";
      try { deadline = executionTerms(JSON.parse(attempt.quote) as ExecutionRecord).deadline; if (Date.parse(deadline) <= Date.now()) { stage = "close"; block("QUOTE_EXPIRED", "The exact route expired. Close its unused attempt before explicitly preparing a fresh quote"); } } catch { block("QUOTE_INVALID", "The stored route requires reconciliation"); stage = "reconcile"; }
      try {
        const evidence = JSON.parse(attempt.reconciliation ?? "{}") as { chain?: { policy_version?: string; attempts?: { id: string; approval_policy_version?: string }[] } };
        const saved = evidence.chain?.attempts?.find(value => value.id === attempt.id);
        if (saved && saved.approval_policy_version !== evidence.chain?.policy_version || evidence.chain?.policy_version && authority && evidence.chain.policy_version !== authority.policyVersion) block("POLICY_CHANGED", "The recorded policy changed. Refresh the exact NEAR approvals");
      } catch {}
    } else if (!attempt || closedAttempts.includes(attempt.state)) {
      if (route.primary.status !== "supported") block(route.primary.status === "unsupported" ? "UNSUPPORTED_ROUTE" : "ROUTE_SUPPORT_UNKNOWN", route.primary.reason);
    }
    if (!item.payment.reserved_amount || item.payment.reserved_amount === "0") block("PAYMENT_UNFUNDED", "Reserve confirmed entitlement and permitted costs. Other client reserves and runs remain protected");
    if (item.payment.scheduled_for && Date.parse(item.payment.scheduled_for) > Date.now()) block("SCHEDULED", `Source execution is locked until ${item.payment.scheduled_for}`);
    if (item.payment.hold_reason) block("PAYMENT_HELD", item.payment.hold_reason);
    if (data?.entries.some(entry => entry.paymentId === item.payment.id)) block("BATCH_ACTIVE", current!.status === "review" ? "Review the saved wallet group below" : "Reconcile the saved wallet group before another wallet request");
    const delivered = liability.remainingLiability === "0";
    const state = delivered ? "delivered" : stage === "held" ? "held" : data?.entries.some(entry => entry.paymentId === item.payment.id) && current?.status === "review" ? "awaiting_signature" : ["signing", "reconciling"].includes(current?.status ?? "") && data?.entries.some(entry => entry.paymentId === item.payment.id) ? "unknown" : item.payment.status === "held" ? "held" : attempt?.state ?? item.payment.status;
    return { id: item.id, paymentId: item.payment.id, recipientName: item.recipientName, entitlement: item.amount, maxFee: item.maxFee, delivered: liability.deliveredAmount, remaining: liability.remainingLiability, spent: liability.spent, reserved: item.payment.reserved_amount, state, nextAction: delivered ? "complete" : stage, blocks: delivered ? [] : blocks, route, attempt, deadline, canPrepare: !delivered && stage === "prepare" && !blocks.some(value => !["SCHEDULED"].includes(value.code)), canReview: !delivered && ["review", "close"].includes(stage) };
  });
  return { run: { ...review.run, status: run.status }, approvedVersion: version, authority, totalEntitlements: review.total, maximumCosts: review.maxFees, funding: review.funding, complete: lines.length > 0 && lines.every(line => line.remaining === "0"), lines, activeBatch: current ? publicBatch(current) : null, recentBatches: batches.filter(batch => !active.includes(batch.status)).slice(0, 5).map(publicBatch), limits: BATCH_LIMITS };
}

export function reserveRun(access: AccessContext, runId: string) {
  const { review } = assertApproved(access, runId);
  if (!access.permissions.includes("payments:approve")) requirePermission(access, "payments:prepare");
  return transaction(() => {
    const blocked: Block[] = [];
    for (const item of review.items) {
      if (!["approved_unfunded", "held"].includes(item.payment.status)) continue;
      if (item.payment.partial_delivery_observed || listAttempts(access, item.payment.id).some(attempt => !closedAttempts.includes(attempt.state))) continue;
      try { reserveApprovedPayment(access, item.payment.id); } catch (error) { if (!(error instanceof ApiError)) throw error; blocked.push(errorBlock(item.payment.id, error)); }
    }
    return { funding: payrollReview(access, runId).funding, blocked };
  });
}

async function closePlan(access: AccessContext, attemptId: string, dependencies: ExecutionDependencies): Promise<Plan> {
  const result = await dependencies.close(access, attemptId), attempt = getAttempt(access, attemptId);
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  if (!config) throw new ApiError(409, "Connect the company treasury", "TREASURY_SETUP_REQUIRED");
  const accounts = (await dependencies.authority(access))?.signerAccounts ?? [];
  return { attempt, network: config.network, stage: "prepare", walletActions: result.walletActions, approvalActions: [], signerAccounts: accounts, approvalAccounts: [], approvals: null, message: "Close the unused exact attempt" };
}

async function planFor(access: AccessContext, attemptId: string, stage: ExecutionStage, dependencies: ExecutionDependencies) {
  return stage === "approve" ? dependencies.approval(access, attemptId) : stage === "close" ? closePlan(access, attemptId, dependencies) : dependencies.resume(access, attemptId);
}

function selectedActions(plan: Plan, stage: ExecutionStage) {
  if (stage !== "close" && plan.stage !== stage) throw new ApiError(409, plan.message, plan.stage === "scheduled" ? "SCHEDULED" : "STAGE_CHANGED");
  if (stage === "execute" && !plan.approvals?.can_execute) throw new ApiError(409, "This exact route has not reached its current approval quorum", "APPROVAL_NOT_READY");
  const actions = stage === "approve" ? plan.approvalActions : plan.walletActions;
  const accounts = stage === "approve" ? plan.approvalAccounts : plan.signerAccounts;
  if (!actions.length || !accounts.length) throw new ApiError(409, plan.message || "Link an eligible NEAR wallet before continuing", "SIGNER_ACCOUNT_REQUIRED");
  if (actions.some(transaction => transaction.actions.some(action => stage === "execute" ? !["execute_payment", "storage_deposit"].includes(action.params.methodName) : action.params.methodName === "execute_payment"))) throw new ApiError(409, "A wallet action does not match its reviewed stage", "BATCH_STAGE_INVALID");
  return { actions, accounts, hash: digest({ stage, network: plan.network, actions, accounts: [...accounts].sort(), approvals: plan.approvals }) };
}

export async function prepareRunBatch(access: AccessContext, runId: string, input: { stage: ExecutionStage; selections: Selection[]; maximumTransactions?: number }, dependencies = defaults) {
  requirePermission(access, input.stage === "approve" ? "payments:approve" : "payments:execute");
  const { review, version } = assertApproved(access, runId);
  if (!input.selections.length || input.selections.length > BATCH_LIMITS.lines || new Set(input.selections.map(value => value.paymentId)).size !== input.selections.length) throw new ApiError(422, "Choose one to five distinct payroll lines", "BATCH_SELECTION_INVALID");
  const itemMap = new Map(review.items.map(item => [item.payment.id, item]));
  if (input.selections.some(value => !itemMap.has(value.paymentId))) throw new ApiError(404, "A selected payment is outside this pay run", "PAYMENT_NOT_FOUND");
  const batchId = randomUUID();
  const data: Payload = { approvalId: version.id, approvalHash: version.review_hash, network: "", entries: [], transactions: [], signerAccounts: [], blocked: [], gas: "0", remainingTransactions: 0 };
  transaction(db => {
    if (row("SELECT id FROM payroll_execution_batches WHERE organization_id=? AND run_id=? AND status IN ('planning','review','signing','reconciling')", access.organizationId, runId)) throw new ApiError(409, "Resume or reconcile the saved wallet group before preparing another", "BATCH_ACTIVE");
    db.prepare("INSERT INTO payroll_execution_batches(id,organization_id,run_id,actor_id,stage,status,payload_ciphertext,receipts_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,'planning',?,?,?,?)").run(batchId, access.organizationId, runId, access.userId, input.stage, encrypt(JSON.stringify(data)), encrypt("[]"), now(), now());
  });
  try {
    for (const selection of input.selections) {
      try {
        let payment = getPayment(access, selection.paymentId), attempt = listAttempts(access, payment.id).at(-1);
        if (attempt && !closedAttempts.includes(attempt.state)) {
          await dependencies.reconcile(access, payment.id);
          payment = getPayment(access, payment.id); attempt = listAttempts(access, payment.id).at(-1);
        }
        if (["paid", "partially_paid", "cancelled"].includes(payment.status) || payment.delivered_amount !== "0" || payment.partial_delivery_observed) throw new ApiError(409, "This entitlement is delivered, cancelled or needs a separately reviewed partial resolution", "ENTITLEMENT_NOT_EXECUTABLE");
        let plan: Plan;
        if (!attempt || closedAttempts.includes(attempt.state)) {
          if (input.stage !== "prepare") throw new ApiError(409, "Explicitly prepare and review a fresh exact route first", "ROUTE_PREPARATION_REQUIRED");
          const result = await dependencies.quote(access, payment.id, { useBackup: !!selection.useBackup });
          if (!("attempt" in result) || !result.attempt) throw new ApiError(409, "An executable route is required", "QUOTE_REQUIRED");
          plan = result as Plan;
        } else plan = await planFor(access, attempt.id, input.stage, dependencies);
        const selected = selectedActions(plan, input.stage), terms = executionTerms(JSON.parse(plan.attempt.quote) as ExecutionRecord);
        if (data.network && data.network !== plan.network) throw new ApiError(409, "Use one NEAR network per wallet group", "BATCH_NETWORK_MISMATCH");
        const item = itemMap.get(payment.id)!;
        const entry: Entry = { paymentId: payment.id, attemptId: plan.attempt.id, recipientName: item.recipientName, entitlement: payment.amount, maxFee: payment.max_fee, amountIn: plan.attempt.amount_in, routeCost: (BigInt(plan.attempt.amount_in) - BigInt(payment.amount)).toString(), asset: plan.attempt.destination_asset, symbol: plan.attempt.destination_symbol ?? null, decimals: plan.attempt.destination_decimals ?? null, network: plan.attempt.destination_network, address: plan.attempt.destination_address, memo: plan.attempt.destination_memo ?? null, output: plan.attempt.expected_output, deadline: terms.deadline, quoteHash: digest(JSON.parse(plan.attempt.quote)), planHash: selected.hash, accounts: selected.accounts, approvals: plan.approvals, actions: selected.actions };
        if (data.entries.length && !intersectSigners([...data.entries.map(value => value.accounts), entry.accounts]).length) throw new ApiError(409, "This line needs a different signing account. Review it in a separate wallet group", "NO_COMMON_SIGNER");
        data.network = plan.network; data.entries.push(entry);
      } catch (error) { data.blocked.push(errorBlock(selection.paymentId, error)); }
    }
    const flat = data.entries.flatMap(entry => entry.actions.map(action => ({ paymentId: entry.paymentId, attemptId: entry.attemptId, action })));
    const bounded = boundedTransactions(flat.map(value => value.action), input.maximumTransactions ?? BATCH_LIMITS.transactions);
    data.transactions = flat.slice(0, bounded.transactions.length);
    const included = new Set(data.transactions.map(value => value.paymentId));
    data.entries = data.entries.filter(entry => included.has(entry.paymentId));
    data.gas = bounded.gas; data.remainingTransactions = bounded.remaining;
    data.signerAccounts = intersectSigners(data.entries.map(entry => entry.accounts));
    transaction(db => {
      const current = getBatch(access, runId, batchId);
      if (current.status !== "planning") throw new ApiError(409, "This wallet group was interrupted. Refresh the run", "BATCH_STATE_CHANGED");
      db.prepare("UPDATE payroll_execution_batches SET status=?,review_hash=?,payload_ciphertext=?,updated_at=? WHERE id=?").run(data.transactions.length ? "review" : "closed", digest(data), encrypt(JSON.stringify(data)), now(), batchId);
    });
    return publicBatch(getBatch(access, runId, batchId));
  } catch (error) {
    getDb().prepare("UPDATE payroll_execution_batches SET status='cancelled',updated_at=? WHERE id=? AND status='planning'").run(now(), batchId);
    throw error;
  }
}

export async function beginRunBatch(access: AccessContext, runId: string, batchId: string, input: { reviewHash: string; signerAccount: string }, dependencies = defaults) {
  const batch = getBatch(access, runId, batchId);
  requirePermission(access, batch.stage === "approve" ? "payments:approve" : "payments:execute");
  if (batch.actor_id !== access.userId) throw new ApiError(403, "The person who prepared this group must review it with their linked wallet", "BATCH_ACTOR_MISMATCH");
  if (batch.status !== "review" || input.reviewHash !== batch.review_hash) throw new ApiError(409, "Refresh the saved wallet group before signing", "BATCH_REVIEW_STALE");
  const data = payload(batch), version = assertApproved(access, runId).version;
  if (version.id !== data.approvalId || version.review_hash !== data.approvalHash || !data.signerAccounts.includes(input.signerAccount)) throw new ApiError(409, "The run approval or eligible signing account changed", "BATCH_REVIEW_STALE");
  for (const entry of data.entries) {
    await dependencies.reconcile(access, entry.paymentId);
    const plan = await planFor(access, entry.attemptId, batch.stage, dependencies), selected = selectedActions(plan, batch.stage);
    if (selected.hash !== entry.planHash || !selected.accounts.includes(input.signerAccount) || digest(JSON.parse(plan.attempt.quote)) !== entry.quoteHash) throw new ApiError(409, "Route terms, policy, wallet actions or quorum changed. Cancel this unsigned group and review again", "BATCH_REVIEW_STALE");
  }
  transaction(db => {
    const current = getBatch(access, runId, batchId);
    if (current.status !== "review" || current.review_hash !== input.reviewHash) throw new ApiError(409, "This group is already signing or requires reconciliation", "BATCH_STATE_CHANGED");
    db.prepare("UPDATE payroll_execution_batches SET status='signing',signer_account=?,updated_at=? WHERE id=?").run(input.signerAccount, now(), batchId);
  });
  return publicBatch(getBatch(access, runId, batchId));
}

function exactReceipt(result: FinalTransaction, expected: WalletTransaction) {
  if (!result.status || !("SuccessValue" in result.status || "Failure" in result.status) || result.transaction?.receiver_id !== expected.receiverId || result.transaction.actions?.length !== expected.actions.length) return false;
  return result.transaction.actions.every((value, index) => {
    const action = value.FunctionCall as { method_name: string; args: string; gas?: string | number; deposit?: string } | undefined, expectedAction = expected.actions[index].params;
    try { return !!action && action.method_name === expectedAction.methodName && String(action.gas) === expectedAction.gas && action.deposit === expectedAction.deposit && digest(JSON.parse(Buffer.from(action.args, "base64").toString())) === digest(expectedAction.args); } catch { return false; }
  });
}

export async function reconcileRunBatch(access: AccessContext, runId: string, batchId: string, input: { receipts?: BatchReceipt[] } = {}, dependencies = defaults) {
  const batch = getBatch(access, runId, batchId), data = payload(batch);
  if (!["signing", "reconciling"].includes(batch.status)) throw new ApiError(409, "Only a submitted or interrupted wallet group needs receipt reconciliation", "BATCH_STATE_CHANGED");
  const stored = transaction(db => {
    const latest = getBatch(access, runId, batchId), known = receipts(latest);
    if (!["signing", "reconciling"].includes(latest.status)) throw new ApiError(409, "This wallet group was already reconciled", "BATCH_STATE_CHANGED");
    for (const receipt of input.receipts ?? []) {
      if (!Number.isInteger(receipt.index) || receipt.index < 0 || receipt.index >= data.transactions.length || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(receipt.hash)) throw new ApiError(422, "Supply a valid transaction index and NEAR hash", "BATCH_RECEIPT_INVALID");
      const previous = known.find(value => value.index === receipt.index);
      if (previous && previous.hash !== receipt.hash) throw new ApiError(409, "This action already has another transaction hash", "BATCH_RECEIPT_CONFLICT");
      if (!previous) known.push(receipt);
    }
    db.prepare("UPDATE payroll_execution_batches SET status='reconciling',receipts_ciphertext=?,updated_at=? WHERE id=?").run(encrypt(JSON.stringify(known)), now(), batchId);
    return known;
  });
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  const blocked: Block[] = [], verified = [...stored];
  if (config && batch.signer_account) {
    for (const receipt of verified) {
      const entry = data.transactions[receipt.index];
      try {
        if (!receipt.verified) {
          const result = await dependencies.receipt(config, receipt.hash, batch.signer_account);
          if (!exactReceipt(result, entry.action)) throw new ApiError(409, "The final receipt does not match the reviewed wallet action", "BATCH_RECEIPT_MISMATCH");
          receipt.verified = true; receipt.failed = !!result.status && "Failure" in result.status;
        }
        const attempt = getAttempt(access, entry.attemptId);
        if (!receipt.failed && batch.stage === "execute" && ["prepared", "submitted"].includes(attempt.state) && !attempt.source_tx_hash && entry.action.actions.some(action => action.params.methodName === "execute_payment")) await markAttemptSubmitted(access, entry.attemptId, receipt.hash);
      } catch (error) { blocked.push(errorBlock(entry.paymentId, error)); }
    }
  }
  for (const entry of data.entries) {
    try { await dependencies.reconcile(access, entry.paymentId); } catch (error) { blocked.push(errorBlock(entry.paymentId, error)); }
  }
  const safe = !blocked.length && (batch.stage !== "execute" || data.transactions.every((entry, index) => {
    if (!entry.action.actions.some(action => action.params.methodName === "execute_payment")) return true;
    const attempt = getAttempt(access, entry.attemptId);
    return verified.some(receipt => receipt.index === index && receipt.verified) || ["submitted", "processing", "delivered", "recovery_pending", "reported_delivered", "reported_partial", "partially_delivered", "refunded_verified"].includes(attempt.state);
  }));
  transaction(db => {
    const latest = getBatch(access, runId, batchId), merged = receipts(latest);
    if (latest.status === "closed") return;
    for (const receipt of verified) { const target = merged.find(value => value.index === receipt.index && value.hash === receipt.hash); if (target) Object.assign(target, receipt); }
    db.prepare("UPDATE payroll_execution_batches SET status=?,receipts_ciphertext=?,updated_at=? WHERE id=?").run(safe ? "closed" : "reconciling", encrypt(JSON.stringify(merged)), now(), batchId);
  });
  return { batch: publicBatch(getBatch(access, runId, batchId)), blocked, requiresReceipt: !safe && batch.stage === "execute", message: safe ? "Recorded attempts reconciled. Review the remaining run actions before another wallet request" : "An execution may still be pending. Supply its wallet transaction hash or wait for authoritative route evidence. Another send remains blocked" };
}

export function cancelRunBatch(access: AccessContext, runId: string, batchId: string) {
  return transaction(db => {
    const batch = getBatch(access, runId, batchId);
    requirePermission(access, batch.stage === "approve" ? "payments:approve" : "payments:execute");
    if (!["planning", "review"].includes(batch.status)) throw new ApiError(409, "Reconcile this wallet request before resuming. Its source may still deliver", "BATCH_RECONCILIATION_REQUIRED");
    db.prepare("UPDATE payroll_execution_batches SET status='cancelled',updated_at=? WHERE id=?").run(now(), batchId);
    return { cancelled: true };
  });
}

export async function reconcileRun(access: AccessContext, runId: string, dependencies = defaults) {
  const review = payrollReview(access, runId), blocked: Block[] = [];
  for (const item of review.items) {
    if (!listAttempts(access, item.payment.id).length || ["paid", "cancelled"].includes(item.payment.status)) continue;
    try { await dependencies.reconcile(access, item.payment.id); } catch (error) { blocked.push(errorBlock(item.payment.id, error)); }
  }
  return { blocked };
}

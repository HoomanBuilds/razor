import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { audit, getAccess } from "../identity/session";
import {
  nearTransactionStatus,
  validNearAccount,
  type FinalTransaction,
} from "../payments/near";
import type { TreasuryConfig } from "../payments/types";
import { digest, functionalAmount, type Connection, type Job } from "./model";

const now = () => new Date().toISOString(),
  id = z.string().min(1).max(128),
  positive = z.string().regex(/^[1-9]\d{0,17}$/);
export const valuationInput = z
  .object({
    numerator: positive,
    denominator: positive,
    source: z.string().trim().min(3).max(300),
    date: z.iso.date(),
    rounding: z.enum(["exact", "half_even_to_cent"]),
  })
  .strict();
export type Valuation = z.infer<typeof valuationInput>;
export interface FeeBatch {
  id: string;
  organization_id: string;
  network: string;
  amount_atomic: string;
  source_hash: string;
  state: string;
  created_at: string;
}
export interface FxDifference {
  id: string;
  organization_id: string;
  connection_id: string;
  entity_id: string;
  payment_id: string;
  settlement_job_id: string;
  basis_hash: string;
  payload_ciphertext: string;
  source_hash: string;
  created_at: string;
}
function access(access: AccessContext) {
  const live = getAccess(access.userId, access.organizationId);
  for (const permission of [
    "company:read",
    "company:manage",
    "payments:read",
    "reports:read",
    "payments:approve",
  ])
    requirePermission(live, permission);
  return live;
}
export function valuedAsset(amount: string, decimals: number, raw: unknown) {
  const rate = valuationInput.parse(raw);
  if (
    !/^[1-9]\d{0,45}$/.test(amount) ||
    ![6, 24].includes(decimals) ||
    rate.date > now().slice(0, 10)
  )
    throw new ApiError(
      422,
      "Use an observed positive asset amount and a reviewed historical rate",
      "ACCOUNTING_VALUATION_INVALID",
    );
  const numerator = BigInt(amount) * BigInt(rate.numerator) * 100n,
    denominator = 10n ** BigInt(decimals) * BigInt(rate.denominator);
  let cents = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder && rate.rounding === "exact")
    throw new ApiError(
      409,
      "This valuation has fractional functional-currency cents. Choose an explicit accountant-reviewed rounding policy or retain it unposted",
      "ACCOUNTING_PRECISION_REQUIRED",
    );
  if (
    rate.rounding === "half_even_to_cent" &&
    (remainder * 2n > denominator ||
      (remainder * 2n === denominator && cents % 2n === 1n))
  )
    cents++;
  if (cents <= 0n || cents > 99_999_999_999n)
    throw new ApiError(
      409,
      "The valued entry is below one cent or exceeds provider limits. Keep the exact fee evidence and group eligible fees before posting",
      "ACCOUNTING_PRECISION_REQUIRED",
    );
  const text = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  return {
    text,
    value: Number(text),
    cents: cents.toString(),
    residualNumerator: (numerator - cents * denominator).toString(),
    residualDenominator: denominator.toString(),
    valuation: rate,
  };
}
function reference(
  org: string,
  kind: "payment" | "funding",
  referenceId: string,
  hash: string,
) {
  const found =
    kind === "payment"
      ? row(
          "SELECT r.attempt_id FROM payment_source_receipts r JOIN payout_attempts a ON a.id=r.attempt_id WHERE r.organization_id=? AND a.organization_id=? AND a.payment_id=? AND r.transaction_hash=?",
          org,
          org,
          referenceId,
          hash,
        )
      : row(
          "SELECT id FROM funding_credit_receipts WHERE organization_id=? AND funding_id=? AND transaction_hash=?",
          org,
          referenceId,
          hash,
        );
  if (!found)
    throw new ApiError(
      409,
      "Match this transaction to an independently verified company source-payment or funding receipt first. Provider references alone are insufficient",
      "ACCOUNTING_FEE_REFERENCE_UNVERIFIED",
    );
  return found;
}
export async function observeNearFee(rawAccess: AccessContext, data: unknown) {
  const live = access(rawAccess),
    input = z
      .object({
        referenceKind: z.enum(["payment", "funding"]),
        referenceId: id,
        transactionHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
        signerAccount: z.string().refine(validNearAccount),
        companyExpenseAcknowledged: z.literal(true),
      })
      .strict()
      .parse(data);
  const config = row<TreasuryConfig>(
    "SELECT * FROM treasury_config WHERE organization_id=?",
    live.organizationId,
  );
  if (!config)
    throw new ApiError(
      409,
      "Configure the original NEAR company treasury first",
      "ACCOUNTING_FEE_REFERENCE_UNVERIFIED",
    );
  const linked = () =>
    row(
      "SELECT w.id FROM linked_wallets w JOIN memberships m ON m.user_id=w.user_id AND m.organization_id=? AND m.status='active' WHERE w.family='near' AND w.network=? AND w.address=?",
      live.organizationId,
      config.network,
      input.signerAccount,
    );
  reference(
    live.organizationId,
    input.referenceKind,
    input.referenceId,
    input.transactionHash,
  );
  if (!linked())
    throw new ApiError(
      409,
      "The fee payer must be a currently verified company-member NEAR wallet. Third-party solver and relayer costs are not assumed company fees",
      "ACCOUNTING_FEE_PAYER_UNVERIFIED",
    );
  const result = (await nearTransactionStatus(
    config,
    input.transactionHash,
    input.signerAccount,
  )) as FinalTransaction & {
    transaction_outcome?: {
      id?: string;
      block_hash?: string;
      outcome: { tokens_burnt?: string; receipt_ids: string[] };
    };
    receipts_outcome?: Array<{
      id: string;
      block_hash: string;
      outcome: { tokens_burnt?: string; status: unknown };
    }>;
  };
  const action = result.transaction?.actions?.[0]?.FunctionCall;
  if (result.transaction?.actions?.length !== 1 || !action)
    throw new ApiError(
      409,
      "Only a single company-bound function-call transaction is supported for fee attribution",
      "ACCOUNTING_FEE_REFERENCE_UNVERIFIED",
    );
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(Buffer.from(action.args, "base64").toString("utf8"));
  } catch {
    throw new ApiError(
      409,
      "The transaction's company binding is unreadable",
      "ACCOUNTING_FEE_REFERENCE_UNVERIFIED",
    );
  }
  const directCompany =
    result.transaction?.receiver_id === config.near_account_id &&
    (config.architecture !== "shared_v1" ||
      args.company_id === config.company_id) &&
    (input.referenceKind !== "payment" ||
      args.payment_id === input.referenceId);
  let fundingCompany = false;
  if (
    input.referenceKind === "funding" &&
    result.transaction?.receiver_id === config.token_contract &&
    action.method_name === "ft_transfer_call" &&
    args.receiver_id === config.near_account_id
  ) {
    try {
      const msg = JSON.parse(String(args.msg));
      fundingCompany =
        config.architecture !== "shared_v1" ||
        msg.company_id === config.company_id;
    } catch {
      fundingCompany = false;
    }
  }
  if (!directCompany && !fundingCompany)
    throw new ApiError(
      409,
      "The final transaction does not bind this exact company treasury and source reference",
      "ACCOUNTING_FEE_REFERENCE_UNVERIFIED",
    );
  const outcomes = [
    result.transaction_outcome,
    ...(result.receipts_outcome ?? []),
  ];
  if (
    outcomes.length < 2 ||
    outcomes.length > 500 ||
    outcomes.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        typeof item.block_hash !== "string" ||
        typeof item.outcome.tokens_burnt !== "string" ||
        !/^(0|[1-9]\d{0,38})$/.test(item.outcome.tokens_burnt),
    ) ||
    new Set(outcomes.map((item) => item?.id)).size !== outcomes.length
  )
    throw new ApiError(
      409,
      "The final transaction omitted bounded, exact token-burn outcomes",
      "ACCOUNTING_FEE_EVIDENCE_INCOMPLETE",
    );
  const amount = outcomes.reduce(
    (sum, item) => sum + BigInt(item!.outcome.tokens_burnt!),
    0n,
  );
  if (amount <= 0n || amount > (1n << 128n) - 1n)
    throw new ApiError(
      409,
      "No supported positive final NEAR token burn was recorded",
      "ACCOUNTING_FEE_ZERO",
    );
  const evidence = {
      network: config.network,
      transactionHash: input.transactionHash,
      signer: input.signerAccount,
      companyTreasury: config.near_account_id,
      companyId: config.company_id ?? null,
      amountAtomic: amount.toString(),
      asset: "NEAR",
      decimals: 24,
      outcomes: outcomes.map((item) => ({
        id: item!.id,
        blockHash: item!.block_hash,
        tokensBurnt: item!.outcome.tokens_burnt,
      })),
      measurement:
        "Final RPC token burn, not USDC spread, a fee ceiling, a storage deposit or a cash-out cost",
    },
    fingerprint = digest(evidence);
  return transaction((db) => {
    access(live);
    reference(
      live.organizationId,
      input.referenceKind,
      input.referenceId,
      input.transactionHash,
    );
    if (!linked())
      throw new ApiError(
        409,
        "The company fee-payer relationship changed during verification",
        "ACCOUNTING_FEE_PAYER_UNVERIFIED",
      );
    const previous = row<{
      id: string;
      evidence_hash: string;
      organization_id: string;
    }>(
      "SELECT id,evidence_hash,organization_id FROM accounting_fee_evidence WHERE network=? AND transaction_hash=?",
      config.network,
      input.transactionHash,
    );
    if (previous) {
      if (
        previous.organization_id !== live.organizationId ||
        previous.evidence_hash !== fingerprint
      )
        throw new ApiError(
          409,
          "This transaction burn already has a different accounting attribution",
          "ACCOUNTING_FEE_CONFLICT",
        );
      return { id: previous.id, replayed: true };
    }
    const feeId = randomUUID();
    db.prepare(
      "INSERT INTO accounting_fee_evidence(id,organization_id,network,transaction_hash,signer_account,reference_kind,reference_id,amount_atomic,asset,decimals,evidence_ciphertext,evidence_hash,reviewed_by,created_at) VALUES(?,?,?,?,?,?,?,?,'NEAR',24,?,?,?,?)",
    ).run(
      feeId,
      live.organizationId,
      config.network,
      input.transactionHash,
      input.signerAccount,
      input.referenceKind,
      input.referenceId,
      amount.toString(),
      encrypt(JSON.stringify(evidence)),
      fingerprint,
      live.userId,
      now(),
    );
    audit(
      live.userId,
      live.organizationId,
      "accounting.final_fee_observed",
      feeId,
    );
    return { id: feeId, replayed: false };
  });
}
export function groupFees(rawAccess: AccessContext, data: unknown) {
  const live = access(rawAccess),
    input = z
      .object({
        feeIds: z.array(id).min(1).max(100),
        acknowledgement: z.literal(true),
      })
      .strict()
      .parse(data);
  if (new Set(input.feeIds).size !== input.feeIds.length)
    throw new ApiError(
      422,
      "Select each observed fee once",
      "ACCOUNTING_FEE_DUPLICATE",
    );
  return transaction((db) => {
    const fees = input.feeIds.map((feeId) =>
      row<{
        id: string;
        network: string;
        amount_atomic: string;
        evidence_hash: string;
      }>(
        "SELECT id,network,amount_atomic,evidence_hash FROM accounting_fee_evidence WHERE id=? AND organization_id=?",
        feeId,
        live.organizationId,
      ),
    );
    if (
      fees.some((value) => !value) ||
      new Set(fees.map((value) => value!.network)).size !== 1 ||
      input.feeIds.some((feeId) =>
        row(
          "SELECT batch_id FROM accounting_fee_batch_items WHERE fee_id=?",
          feeId,
        ),
      )
    )
      throw new ApiError(
        409,
        "Group only unassigned exact fees from one network",
        "ACCOUNTING_FEE_GROUP_HELD",
      );
    const batchId = randomUUID(),
      amount = fees
        .reduce((sum, value) => sum + BigInt(value!.amount_atomic), 0n)
        .toString();
    if (BigInt(amount) > (1n << 128n) - 1n)
      throw new ApiError(
        422,
        "This fee group exceeds the supported atomic-amount bound",
        "ACCOUNTING_AMOUNT_INVALID",
      );
    db.prepare(
      "INSERT INTO accounting_fee_batches(id,organization_id,network,amount_atomic,source_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      batchId,
      live.organizationId,
      fees[0]!.network,
      amount,
      digest(fees),
      live.userId,
      now(),
    );
    for (const feeId of input.feeIds)
      db.prepare(
        "INSERT INTO accounting_fee_batch_items(batch_id,fee_id) VALUES(?,?)",
      ).run(batchId, feeId);
    audit(live.userId, live.organizationId, "accounting.fees_grouped", batchId);
    return { id: batchId };
  });
}
export function releaseFeeGroup(rawAccess: AccessContext, batchId: string) {
  const live = access(rawAccess);
  return transaction((db) => {
    const batch = row<FeeBatch>(
      "SELECT * FROM accounting_fee_batches WHERE id=? AND organization_id=?",
      batchId,
      live.organizationId,
    );
    if (!batch || batch.state !== "grouped")
      throw new ApiError(
        409,
        "Choose an active unposted fee group",
        "ACCOUNTING_FEE_GROUP_HELD",
      );
    if (
      row(
        "SELECT id FROM accounting_jobs WHERE organization_id=? AND kind='fee' AND source_id=? AND (attempts>0 OR approved_by IS NOT NULL OR state NOT IN ('review','held','cancelled'))",
        live.organizationId,
        batchId,
      )
    )
      throw new ApiError(
        409,
        "Approved, attempted or unknown fee postings keep their exact original group",
        "ACCOUNTING_FEE_GROUP_HELD",
      );
    db.prepare(
      "UPDATE accounting_jobs SET state='cancelled',last_error='UNPOSTED_FEE_GROUP_RELEASED',updated_at=? WHERE organization_id=? AND kind='fee' AND source_id=? AND attempts=0 AND approved_by IS NULL",
    ).run(now(), live.organizationId, batchId);
    db.prepare("DELETE FROM accounting_fee_batch_items WHERE batch_id=?").run(
      batchId,
    );
    db.prepare(
      "UPDATE accounting_fee_batches SET state='released' WHERE id=? AND state='grouped'",
    ).run(batchId);
    audit(
      live.userId,
      live.organizationId,
      "accounting.unposted_fees_released",
      batchId,
    );
    return { released: true };
  });
}
export function ledgerOverview(access: AccessContext) {
  return {
    fees: rows<{
      id: string;
      network: string;
      transaction_hash: string;
      reference_kind: string;
      reference_id: string;
      amount_atomic: string;
      created_at: string;
      batch_id: string | null;
    }>(
      "SELECT f.id,f.network,f.transaction_hash,f.reference_kind,f.reference_id,f.amount_atomic,f.created_at,i.batch_id FROM accounting_fee_evidence f LEFT JOIN accounting_fee_batch_items i ON i.fee_id=f.id WHERE f.organization_id=? ORDER BY f.created_at DESC LIMIT 100",
      access.organizationId,
    ),
    feeBatches: rows<FeeBatch>(
      "SELECT * FROM accounting_fee_batches WHERE organization_id=? ORDER BY created_at DESC LIMIT 100",
      access.organizationId,
    ),
    fxDifferences: rows<FxDifference>(
      "SELECT * FROM accounting_fx_differences WHERE organization_id=? ORDER BY created_at DESC LIMIT 100",
      access.organizationId,
    ).map(({ payload_ciphertext, ...value }) => ({
      ...value,
      terms: JSON.parse(decrypt(payload_ciphertext)),
    })),
    credits: rows<{
      id: string;
      reference_ciphertext: string;
      amount: string;
      bill_id: string;
    }>(
      "SELECT n.id,n.reference_ciphertext,v.amount,n.bill_id FROM invoice_credit_notes n JOIN invoice_credit_versions v ON v.note_id=n.id AND v.version=n.accepted_version WHERE n.organization_id=? AND n.status='accepted' ORDER BY n.accepted_at DESC LIMIT 100",
      access.organizationId,
    ).map(({ reference_ciphertext, ...value }) => ({
      ...value,
      reference: decrypt(reference_ciphertext),
    })),
  };
}
export function approveFxDifference(
  rawAccess: AccessContext,
  connection: Connection,
  data: unknown,
) {
  const live = access(rawAccess),
    input = z
      .object({
        paymentId: id,
        valuation: valuationInput,
        reason: z.string().trim().min(3).max(2000),
        acknowledgement: z.literal(true),
      })
      .strict()
      .parse(data);
  return transaction((db) => {
    const job = row<Job>(
      "SELECT * FROM accounting_jobs WHERE organization_id=? AND connection_id=? AND entity_id=? AND kind='settlement' AND source_id=? AND state='done'",
      live.organizationId,
      connection.id,
      connection.entity_id,
      input.paymentId,
    );
    if (!job || !job.provider_hash)
      throw new ApiError(
        409,
        "Reconcile the exact original full settlement posting before approving a separate valuation difference",
        "ACCOUNTING_FX_BASIS_REQUIRED",
      );
    const posting = JSON.parse(decrypt(job.payload_ciphertext)) as {
      source: { amount: string };
      amount: { cents?: string; value: number };
      functionalCurrency: string;
    };
    if (posting.functionalCurrency !== connection.currency)
      throw new ApiError(
        409,
        "The original settlement currency differs from this legal entity",
        "ACCOUNTING_FX_BASIS_REQUIRED",
      );
    const changed = valuedAsset(posting.source.amount, 6, input.valuation),
      basis =
        posting.amount.cents ?? String(Math.round(posting.amount.value * 100)),
      difference = BigInt(changed.cents) - BigInt(basis);
    if (difference === 0n)
      throw new ApiError(
        422,
        "The approved valuation has no nonzero difference to post",
        "ACCOUNTING_FX_ZERO",
      );
    const payload = {
        valuation: input.valuation,
        sourceMicroUSDC: posting.source.amount,
        carryingCents: basis,
        revaluedCents: changed.cents,
        differenceCents: difference.toString(),
        residualNumerator: changed.residualNumerator,
        residualDenominator: changed.residualDenominator,
        reason: input.reason,
        functionalCurrency: connection.currency,
        classification:
          "Separately approved crypto-clearing valuation adjustment, not an additional payment, refund, provider FX quote or change to the original bill settlement",
      },
      sourceHash = digest({
        jobId: job.id,
        sourceHash: job.source_hash,
        providerHash: job.provider_hash,
        payload,
      }),
      existing = row<{ id: string; source_hash: string }>(
        "SELECT id,source_hash FROM accounting_fx_differences WHERE connection_id=? AND entity_id=? AND payment_id=?",
        connection.id,
        connection.entity_id,
        input.paymentId,
      );
    if (existing) {
      if (existing.source_hash !== sourceHash)
        throw new ApiError(
          409,
          "A different immutable FX adjustment already exists for this settlement",
          "ACCOUNTING_FX_EXISTS",
        );
      return { id: existing.id };
    }
    const sourceId = randomUUID();
    db.prepare(
      "INSERT INTO accounting_fx_differences(id,organization_id,connection_id,entity_id,payment_id,settlement_job_id,basis_hash,payload_ciphertext,source_hash,approved_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      sourceId,
      live.organizationId,
      connection.id,
      connection.entity_id,
      input.paymentId,
      job.id,
      job.provider_hash,
      encrypt(JSON.stringify(payload)),
      sourceHash,
      live.userId,
      now(),
    );
    audit(
      live.userId,
      live.organizationId,
      "accounting.fx_difference_approved",
      sourceId,
    );
    return { id: sourceId };
  });
}

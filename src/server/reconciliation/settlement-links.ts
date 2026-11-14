import { Hono } from "hono";
import { z } from "zod";
import {
  ApiError,
  requirePermission,
  type AccessContext,
  type AppEnv,
} from "../context";
import { row, rows } from "../db";
import { getAccess } from "../identity/session";
import { decrypt } from "../identity/crypto";
import { getAttempt, prepareSettlement } from "../payments/service";
import { getSupportedTokens } from "../payments/intents";
import { isCompanyBinding } from "../payments/near";
import type { TreasuryConfig } from "../payments/types";
import { reviewedArtifactHash } from "../near-artifacts";
import {
  canonicalSettlementLink,
  createSettlementStatement,
  parseSettlementStatement,
  settlementLinkEvidenceSchema,
  settlementLinkSourceSchema,
  settlementLinkTransactionSchema,
  type SettlementLinkSource,
} from "../../lib/verification/settlement-link";
import { destinationTransferSchema } from "../../lib/verification/destination-packet";
import { settlementLinkObserver } from "../../lib/verification/settlement-link-rpc";
import { hashText } from "../../lib/verification/verify";

function permissions(access: AccessContext, approve = false) {
  const live = getAccess(access.userId, access.organizationId);
  for (const permission of [
    "company:read",
    "payments:read",
    "reports:read",
    ...(approve ? ["payments:approve"] : []),
  ])
    requirePermission(live, permission);
  return live;
}
function target(access: AccessContext) {
  const config = row<TreasuryConfig>(
    "SELECT * FROM treasury_config WHERE organization_id=?",
    access.organizationId,
  );
  if (
    !config ||
    config.architecture !== "shared_v1" ||
    !isCompanyBinding(access.organizationId, config.company_id)
  )
    throw new ApiError(
      409,
      "Settlement-link evidence currently requires the reviewed shared treasury architecture",
      "SETTLEMENT_LINK_ARCHITECTURE",
    );
  return { ...config, company_id: config.company_id! };
}
function observer(config: TreasuryConfig) {
  return settlementLinkObserver(
    config.network === "mainnet"
      ? "https://rpc.mainnet.near.org"
      : "https://rpc.testnet.near.org",
  );
}
interface Retained {
  id: string;
  evidence_kind: string;
  content_hash: string;
  ciphertext: string | null;
  created_at: string;
  expires_at: string;
}
function records(access: AccessContext, attemptId: string) {
  return rows<Retained>(
    "SELECT id,evidence_kind,content_hash,ciphertext,created_at,expires_at FROM private_settlement_evidence WHERE organization_id=? AND attempt_id=? ORDER BY created_at DESC LIMIT 100",
    access.organizationId,
    attemptId,
  );
}
function matchSource(
  access: AccessContext,
  attemptId: string,
  source: SettlementLinkSource,
) {
  const config = target(access),
    attempt = getAttempt(access, attemptId);
  if (
    source.network !== config.network ||
    source.architecture !== config.architecture ||
    source.contractId !== config.near_account_id ||
    source.companyId !== config.company_id ||
    source.tokenContract !== config.token_contract ||
    source.codeHash !==
      reviewedArtifactHash("NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm") ||
    source.paymentId !== attempt.payment_id ||
    source.attemptId !== attempt.id
  )
    throw new ApiError(
      409,
      "The selected source does not belong to this exact company payment and reviewed treasury",
      "SETTLEMENT_LINK_SCOPE",
    );
  return { config, attempt };
}
export function settlementLinkOverview(
  access: AccessContext,
  attemptId: string,
) {
  const live = permissions(access),
    attempt = getAttempt(live, attemptId);
  return {
    attempt: {
      id: attempt.id,
      paymentId: attempt.payment_id,
      state: attempt.state,
      sourceTransactionHash: attempt.source_tx_hash,
      reportedDestinationHash: attempt.destination_tx_hash,
      asset: attempt.destination_asset,
      network: attempt.destination_network,
      address: attempt.destination_address,
      symbol: attempt.destination_symbol,
      decimals: attempt.destination_decimals,
    },
    retained: records(live, attemptId).map(({ ciphertext, ...value }) => ({
      ...value,
      available: !!ciphertext && value.expires_at > new Date().toISOString(),
    })),
    limits:
      "Only explicitly selected structured full-delivery statements can establish reporter association. Old free-text, partial, expired or redacted receipts are not reconstructed. Native evidence requires one exact unbatched execute_payment transaction.",
  };
}
export async function prepareSettlementLinkSource(
  access: AccessContext,
  attemptId: string,
) {
  const live = permissions(access),
    config = target(live),
    attempt = getAttempt(live, attemptId),
    selected = observer(config);
  await selected.network(config.network);
  const block = await selected.rpc<{ header: { hash: string } }>("block", {
    finality: "final",
  });
  const current = await selected.snapshot(
    {
      network: config.network,
      contractId: config.near_account_id,
      codeHash: reviewedArtifactHash(
        "NEAR_TREASURY_CODE_HASH",
        "razor_treasury.wasm",
      ),
      companyId: config.company_id,
      paymentId: attempt.payment_id,
      attemptId,
    },
    block.header.hash,
  );
  permissions(access);
  return {
    source: current.source,
    observedBlock: block.header.hash,
    scope:
      "Current final source terms for preparation only. This is an exporter suggestion, never independent verifier trust or historical settlement proof.",
  };
}
const prepareSchema = z
  .object({
    source: settlementLinkSourceSchema,
    transfer: destinationTransferSchema,
    reviewConfirmed: z.literal(true),
    discloseSelectedReceipt: z.literal(true),
  })
  .strict();
export async function prepareStructuredSettlementLink(
  access: AccessContext,
  attemptId: string,
  input: z.infer<typeof prepareSchema>,
) {
  let live = permissions(access, true);
  const { config, attempt } = matchSource(live, attemptId, input.source),
    selected = observer(config);
  if (input.source.route.kind !== "intents")
    throw new ApiError(
      409,
      "Native direct transfers use same-transaction evidence and do not need a reporter statement",
      "NATIVE_SETTLEMENT_LINK",
    );
  const destination =
    input.transfer.kind === "solana"
      ? input.transfer.recipientOwner
      : input.transfer.recipient;
  const token =
    input.transfer.kind === "solana"
      ? input.transfer.mint
      : input.transfer.tokenContract;
  const selectedToken = (await getSupportedTokens()).find(
    (asset) => asset.assetId === input.source.destination.asset_id,
  );
  const same = (left: string, right: string) =>
    input.transfer.kind === "evm"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  if (
    !same(destination, input.source.destination.address) ||
    !selectedToken?.contractAddress ||
    !same(token, selectedToken.contractAddress) ||
    selectedToken.blockchain !== input.source.destination.network
  )
    throw new ApiError(
      409,
      "The selected destination token and receiver do not match the frozen route's supported asset",
      "SETTLEMENT_LINK_DESTINATION",
    );
  const txHash =
    input.transfer.kind === "solana"
      ? input.transfer.transactionSignature
      : input.transfer.transactionHash;
  if (!attempt.destination_tx_hash || attempt.destination_tx_hash !== txHash)
    throw new ApiError(
      409,
      "Choose the exact destination transaction already observed for this original routing attempt",
      "SETTLEMENT_LINK_DESTINATION",
    );
  const block = await selected.rpc<{ header: { hash: string } }>("block", {
    finality: "final",
  });
  const current = await selected.snapshot(input.source, block.header.hash);
  if (
    canonicalSettlementLink(current.source) !==
      canonicalSettlementLink(input.source) ||
    !["in_flight", "recovery_pending"].includes(current.payment.status) ||
    !["source_sent", "uncertain", "refund_pending"].includes(
      current.attempt.status,
    )
  )
    throw new ApiError(
      409,
      "Payment terms or settlement state changed. Refresh and review the original attempt",
      "SETTLEMENT_LINK_STALE",
    );
  const statement = createSettlementStatement(input.source, input.transfer);
  live = permissions(access, true);
  const plan = await prepareSettlement(live, attemptId, {
    outcome: "delivered",
    receipt: statement,
  });
  const calls = plan.walletActions
    .flatMap((action) => action.actions)
    .filter((action) => action.params.methodName === "report_settlement");
  const args = calls[0]?.params.args as
    | { actual_output?: string; receipt?: string }
    | undefined;
  const reportArgs = calls[0]?.params.args as
    | Record<string, unknown>
    | undefined;
  if (
    calls.length !== 1 ||
    plan.walletActions.length !== 1 ||
    plan.walletActions[0].receiverId !== input.source.contractId ||
    args?.actual_output !== input.transfer.amount ||
    args.receipt !== `sha256:${hashText(statement)}` ||
    reportArgs?.company_id !== input.source.companyId ||
    reportArgs.payment_id !== input.source.paymentId ||
    reportArgs.attempt_id !== attemptId ||
    reportArgs.outcome !== "delivered"
  )
    throw new ApiError(
      409,
      "The provider's exact measured output changed or the payment was already settled. No new report is prepared",
      "SETTLEMENT_LINK_OUTPUT_CHANGED",
    );
  matchSource(permissions(access, true), attemptId, input.source);
  return {
    ...plan,
    statement,
    statementSha256: hashText(statement),
    source: input.source,
    transfer: input.transfer,
    associationClass: "authorized_reporter_attestation",
    disclosure:
      "Only this selected structured receipt is retained encrypted and committed through the existing explicit reporter wallet action. It is an operator association assertion, not proof of bridge causality or independent destination observation.",
  };
}
const exportSchema = z
  .object({
    kind: z.enum(["native_execution", "reporter_statement"]),
    source: settlementLinkSourceSchema,
    sourceTransaction: settlementLinkTransactionSchema,
    transfer: destinationTransferSchema,
    retainedEvidenceId: z.string().min(1).max(128).optional(),
    discloseSelectedReceipt: z.literal(true),
  })
  .strict();
export async function exportSettlementLink(
  access: AccessContext,
  attemptId: string,
  input: z.infer<typeof exportSchema>,
) {
  const live = permissions(access),
    { config } = matchSource(live, attemptId, input.source);
  let statement: string | undefined;
  if (input.kind === "reporter_statement") {
    const retained = records(live, attemptId).find(
      (item) => item.id === input.retainedEvidenceId,
    );
    if (
      !retained?.ciphertext ||
      retained.expires_at <= new Date().toISOString() ||
      retained.evidence_kind !== "settlement:delivered"
    )
      throw new ApiError(
        409,
        "The selected full-delivery statement is missing, expired or redacted. Historical free-text is not reconstructed",
        "SETTLEMENT_LINK_MATERIAL_UNAVAILABLE",
      );
    statement = decrypt(retained.ciphertext);
    try {
      parseSettlementStatement(statement);
    } catch {
      throw new ApiError(
        409,
        "This historical receipt is not a structured settlement statement. Keep it as unverified private evidence",
        "SETTLEMENT_LINK_LEGACY_RECEIPT",
      );
    }
    if (hashText(statement) !== retained.content_hash)
      throw new ApiError(
        409,
        "Retained statement integrity did not validate",
        "SETTLEMENT_LINK_INTEGRITY",
      );
  } else if (input.retainedEvidenceId)
    throw new ApiError(
      422,
      "Native evidence does not disclose a reporter statement",
      "SETTLEMENT_LINK_INPUT",
    );
  const proof = await observer(config).transaction(
    input.source,
    input.sourceTransaction,
    input.kind === "native_execution" ? "execute_payment" : "report_settlement",
  );
  if (
    proof.action.args.company_id !== input.source.companyId ||
    proof.action.args.payment_id !== input.source.paymentId ||
    proof.action.args.attempt_id !== attemptId ||
    (statement && proof.action.args.receipt !== `sha256:${hashText(statement)}`)
  )
    throw new ApiError(
      409,
      "The actual historical source action does not commit this exact payment and selected receipt",
      "SETTLEMENT_LINK_SOURCE",
    );
  matchSource(permissions(access), attemptId, input.source);
  if (statement) {
    const retained = records(permissions(access), attemptId).find(
      (item) => item.id === input.retainedEvidenceId,
    );
    if (
      !retained?.ciphertext ||
      retained.expires_at <= new Date().toISOString() ||
      retained.content_hash !== hashText(statement)
    )
      throw new ApiError(
        409,
        "The selected receipt expired or was removed while checking its source. No raw statement is exported",
        "SETTLEMENT_LINK_MATERIAL_UNAVAILABLE",
      );
  }
  return settlementLinkEvidenceSchema.parse({
    schema: "razor.settlement-link-evidence",
    version: 1,
    kind: input.kind,
    source: input.source,
    sourceTransaction: input.sourceTransaction,
    transfer: input.transfer,
    ...(statement ? { statement } : {}),
  });
}
async function body<T extends z.ZodType>(request: Request, schema: T) {
  if (!request.body)
    throw new ApiError(
      422,
      "Send structured JSON evidence",
      "SETTLEMENT_LINK_INPUT",
    );
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 64 * 1024)
        throw new ApiError(
          413,
          "Settlement-link input exceeds 64 KB",
          "SETTLEMENT_LINK_INPUT",
        );
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    data.set(chunk, position);
    position += chunk.length;
  }
  const bytes = new TextDecoder("utf-8", { fatal: true }).decode(data);
  try {
    return schema.parse(JSON.parse(bytes));
  } catch {
    throw new ApiError(
      422,
      "Check the exact structured source and destination evidence fields",
      "SETTLEMENT_LINK_INPUT",
    );
  }
}
export const settlementLinkRoutes = new Hono<AppEnv>();
settlementLinkRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
settlementLinkRoutes.get("/attempts/:id", (c) =>
  c.json(settlementLinkOverview(c.get("access"), c.req.param("id"))),
);
settlementLinkRoutes.post("/attempts/:id/source", async (c) =>
  c.json(await prepareSettlementLinkSource(c.get("access"), c.req.param("id"))),
);
settlementLinkRoutes.post("/attempts/:id/prepare", async (c) =>
  c.json(
    await prepareStructuredSettlementLink(
      c.get("access"),
      c.req.param("id"),
      await body(c.req.raw, prepareSchema),
    ),
  ),
);
settlementLinkRoutes.post("/attempts/:id/export", async (c) => {
  const evidence = await exportSettlementLink(
    c.get("access"),
    c.req.param("id"),
    await body(c.req.raw, exportSchema),
  );
  c.header(
    "Content-Disposition",
    'attachment; filename="razor-settlement-link.json"',
  );
  return c.json(evidence);
});

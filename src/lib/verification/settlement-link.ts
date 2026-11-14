import { base58 } from "@scure/base";
import { z } from "zod";
import {
  canonicalDestination,
  destinationTransferSchema,
  destinationTrustSchema,
} from "./destination-packet";
import { hashText } from "./verify";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const account = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/);
const hash = z
  .string()
  .max(64)
  .refine((value) => {
    try {
      return base58.decode(value).length === 32;
    } catch {
      return false;
    }
  });
const integer = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,38})$/)
  .refine((value) => BigInt(value) < 2n ** 128n);
const identifier = z.string().min(1).max(128);
export const settlementLinkTransactionSchema = z
  .object({ transactionHash: hash, signerId: account })
  .strict();
export const settlementLinkSourceSchema = z
  .object({
    network: z.enum(["mainnet", "testnet"]),
    architecture: z.literal("shared_v1"),
    contractId: account,
    codeHash: hash,
    companyId: identifier,
    tokenContract: account,
    paymentId: identifier,
    attemptId: identifier,
    recipientId: identifier,
    recipientVersion: integer,
    policyVersion: integer,
    amount: integer.refine((value) => BigInt(value) > 0n),
    maxFee: integer,
    paymentTermsHash: digest,
    attemptTermsHash: digest,
    recipientHash: digest,
    useBackup: z.boolean(),
    destination: z
      .object({
        asset_id: z.string().min(1).max(256),
        network: z.string().min(1).max(64),
        address: z.string().min(1).max(256),
      })
      .strict(),
    route: z
      .object({
        kind: z.enum(["direct", "intents"]),
        source_receiver: account,
        input_amount: integer,
        output_amount: integer,
        quote_id: z.string().max(128),
        quote_hash: z.string().max(128),
        deadline_ms: integer,
      })
      .strict(),
  })
  .strict();
export const settlementStatementSchema = z
  .object({
    schema: z.literal("razor.settlement-statement"),
    version: z.literal(1),
    sourceSha256: digest,
    transfer: destinationTransferSchema,
    actualOutput: integer.refine((value) => BigInt(value) > 0n),
  })
  .strict();
const common = {
  schema: z.literal("razor.settlement-link-evidence"),
  version: z.literal(1),
  source: settlementLinkSourceSchema,
  sourceTransaction: settlementLinkTransactionSchema,
  transfer: destinationTransferSchema,
};
export const settlementLinkEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("native_execution") }).strict(),
  z
    .object({
      ...common,
      kind: z.literal("reporter_statement"),
      statement: z.string().min(1).max(2000),
    })
    .strict(),
]);
export const settlementLinkTrustSchema = z
  .object({
    schema: z.literal("razor.settlement-link-trust"),
    version: z.literal(1),
    expectedSource: settlementLinkSourceSchema,
    expectedSourceTransaction: settlementLinkTransactionSchema,
    destination: z
      .object({
        expectedTransfer: destinationTransferSchema,
        tokenBehavior: destinationTrustSchema.shape.tokenBehavior,
        minimumEvmConfirmations: z.number().int().min(1).max(100000).default(1),
      })
      .strict()
      .superRefine((value, ctx) => {
        const expected = {
          near: "standard_nep141",
          evm: "standard_erc20",
          solana: "legacy_spl",
        }[value.expectedTransfer.kind];
        if (value.tokenBehavior !== expected)
          ctx.addIssue({
            code: "custom",
            path: ["tokenBehavior"],
            message: "Review the actual destination token behavior",
          });
      }),
    expectedTokenCodeHash: hash.optional(),
    expectedReporter: account.optional(),
  })
  .strict();
export type SettlementLinkSource = z.infer<typeof settlementLinkSourceSchema>;
export type SettlementLinkTransaction = z.infer<
  typeof settlementLinkTransactionSchema
>;
export type SettlementLinkEvidence = z.infer<
  typeof settlementLinkEvidenceSchema
>;
export type SettlementLinkTrust = z.infer<typeof settlementLinkTrustSchema>;
export const MAX_SETTLEMENT_LINK_BYTES = 64 * 1024;
export const canonicalSettlementLink = canonicalDestination;
export const settlementSourceHash = (source: SettlementLinkSource) =>
  hashText(canonicalSettlementLink(settlementLinkSourceSchema.parse(source)));
export function parseSettlementLinkEvidence(text: string) {
  if (new TextEncoder().encode(text).length > MAX_SETTLEMENT_LINK_BYTES)
    throw Error("Settlement link exceeds 64 KB");
  return settlementLinkEvidenceSchema.parse(JSON.parse(text));
}
export function parseSettlementLinkTrust(text: string) {
  if (new TextEncoder().encode(text).length > MAX_SETTLEMENT_LINK_BYTES)
    throw Error("Settlement trust exceeds 64 KB");
  return settlementLinkTrustSchema.parse(JSON.parse(text));
}
export function parseSettlementStatement(text: string) {
  if (text !== text.trim() || new TextEncoder().encode(text).length > 2000)
    throw Error(
      "Structured statement must be exact UTF8 JSON up to 2,000 bytes",
    );
  return settlementStatementSchema.parse(JSON.parse(text));
}
export function createSettlementStatement(
  source: SettlementLinkSource,
  transfer: z.infer<typeof destinationTransferSchema>,
) {
  const amount = transfer.amount;
  const statement = canonicalSettlementLink(
    settlementStatementSchema.parse({
      schema: "razor.settlement-statement",
      version: 1,
      sourceSha256: settlementSourceHash(source),
      transfer,
      actualOutput: amount,
    }),
  );
  parseSettlementStatement(statement);
  return statement;
}

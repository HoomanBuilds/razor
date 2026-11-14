import { base58 } from "@scure/base";
import { z } from "zod";
import { chainReferenceSchema } from "./packet";
const integer = /^[1-9]\d{0,77}$/;
const amount = z
  .string()
  .refine(
    (value) => integer.test(value) && BigInt(value) < 2n ** 256n,
    "Use an exact positive base-unit amount",
  );
const hash = (bytes: number) =>
  z
    .string()
    .max(100)
    .refine((value) => {
      try {
        return base58.decode(value).length === bytes;
      } catch {
        return false;
      }
    }, "Invalid base58 byte length");
const account = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/);
const address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .refine(
    (value) => !/^0x0{40}$/.test(value),
    "A real nonzero token/source/recipient address is required",
  );
const txHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const index = z.number().int().min(0).max(4095);
export const destinationTransferSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("near"),
      network: z.enum(["mainnet", "testnet"]),
      transactionHash: hash(32),
      signerId: account,
      tokenContract: account,
      sender: account,
      recipient: account,
      amount: amount.refine(
        (value) => integer.test(value) && BigInt(value) < 2n ** 128n,
      ),
      receiptId: hash(32),
      logIndex: index,
      dataIndex: index,
      finality: z.literal("FINAL"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("evm"),
      chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      transactionHash: txHash,
      tokenContract: address,
      sender: address,
      recipient: address,
      amount,
      logIndex: index,
      finality: z.literal("rpc_finalized"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("solana"),
      genesisHash: hash(32),
      transactionSignature: hash(64),
      tokenProgram: z.enum(["legacy_spl", "token_2022"]),
      mint: hash(32),
      sourceTokenAccount: hash(32),
      sourceOwner: hash(32),
      authority: hash(32),
      destinationTokenAccount: hash(32),
      recipientOwner: hash(32),
      amount: amount.refine(
        (value) => integer.test(value) && BigInt(value) < 2n ** 64n,
      ),
      instructionIndex: index,
      innerIndex: index.optional(),
      finality: z.literal("finalized"),
    })
    .strict(),
]);
export const destinationEvidenceSchema = z
  .object({
    schema: z.literal("razor.destination-evidence"),
    version: z.literal(1),
    transfer: destinationTransferSchema,
    source: chainReferenceSchema.optional(),
  })
  .strict();
export const destinationTrustSchema = z
  .object({
    schema: z.literal("razor.destination-trust"),
    version: z.literal(1),
    expectedTransfer: destinationTransferSchema,
    expectedSource: chainReferenceSchema.optional(),
    minimumEvmConfirmations: z.number().int().min(1).max(100000).default(1),
    tokenBehavior: z.enum(["standard_nep141", "standard_erc20", "legacy_spl"]),
  })
  .strict()
  .superRefine((trust, ctx) => {
    const expected = {
      near: "standard_nep141",
      evm: "standard_erc20",
      solana: "legacy_spl",
    }[trust.expectedTransfer.kind];
    if (trust.tokenBehavior !== expected)
      ctx.addIssue({
        code: "custom",
        path: ["tokenBehavior"],
        message: "Independently review the actual supported token behavior",
      });
  });
export type DestinationTransfer = z.infer<typeof destinationTransferSchema>;
export type DestinationEvidence = z.infer<typeof destinationEvidenceSchema>;
export type DestinationTrust = z.infer<typeof destinationTrustSchema>;
export const MAX_DESTINATION_BYTES = 100_000;
export function parseDestinationEvidence(text: string) {
  if (new TextEncoder().encode(text).length > MAX_DESTINATION_BYTES)
    throw new Error("Destination evidence exceeds 100 KB");
  return destinationEvidenceSchema.parse(JSON.parse(text));
}
export function parseDestinationTrust(text: string) {
  if (new TextEncoder().encode(text).length > MAX_DESTINATION_BYTES)
    throw new Error("Destination trust exceeds 100 KB");
  return destinationTrustSchema.parse(JSON.parse(text));
}
export function canonicalDestination(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalDestination).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalDestination(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(
    typeof value === "string" && /^0x[a-fA-F0-9]+$/.test(value)
      ? value.toLowerCase()
      : value,
  );
}

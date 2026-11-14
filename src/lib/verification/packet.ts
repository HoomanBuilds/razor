import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hex = z.string().regex(/^(?:0x)?[a-fA-F0-9]+$/).max(2000);
const identity = z.object({ signingAlgo: z.enum(["ed25519", "ecdsa"]), signingAddress: hex }).strict();
const report = z.object({
  nonce: z.string().max(256), signer: identity, intelQuote: z.string().max(200_000),
  eventLog: z.union([z.string().max(500_000), z.array(z.unknown()).max(2000)]), appCompose: z.string().max(500_000),
  signingPublicKey: z.string().max(256).optional(), nvidiaPayload: z.string().max(500_000).optional(),
  reportedQuoteData: z.string().max(200_000).optional(), spkiFingerprint: z.string().max(256).optional(),
  ohttpAttestation: z.object({ signingAlgo: z.literal("ed25519"), signingKey: z.string().max(256), keyConfig: z.string().max(20_000), signature: z.string().max(2000) }).strict().optional(),
  composeManagerAttestation: z.object({ actions: z.array(z.record(z.string(), z.union([z.string(), z.array(z.string())]))).max(2000), actionsHash: z.string().max(256), nonce: z.string().max(256), intelQuote: z.string().max(200_000), eventLog: z.union([z.string().max(500_000), z.array(z.unknown()).max(2000)]), reportedQuoteData: z.string().max(200_000).optional() }).strict().optional(),
}).strict();
const wire = z.object({ sha256: digest, base64: z.string().max(24_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).nullable() }).strict();
export const chainReferenceSchema = z.object({
  network: z.enum(["mainnet", "testnet"]), contractId: z.string().min(2).max(64),
  architecture: z.enum(["shared_v1", "isolated_v1"]), companyId: z.string().max(128).nullable(),
  blockHash: z.string().min(32).max(64), blockHeight: z.number().int().nonnegative(),
  codeHash: z.string().min(32).max(64), transactionHash: z.string().min(32).max(64), signerId: z.string().min(2).max(64),
  paymentId: z.string().min(1).max(128), amount: z.string().regex(/^\d+$/), recipientId: z.string().min(1).max(128),
  recipientVersion: z.string().regex(/^\d+$/), policyVersion: z.string().regex(/^\d+$/),
}).strict();

export const portablePacketSchema = z.object({
  schema: z.literal("razor.portable-evidence"), version: z.literal(1),
  network: z.enum(["mainnet", "testnet"]).nullable(),
  subject: z.object({ kind: z.enum(["invoice_analysis", "finance_proposal", "payment_evidence"]), id: z.string().min(1).max(128) }).strict(),
  exportedAt: z.string().datetime(), executionObservedAt: z.string().datetime().nullable(),
  disclosure: z.object({ mode: z.enum(["encrypted_wire", "metadata"]), plaintextIncluded: z.literal(false), decryptionKeysIncluded: z.literal(false) }).strict(),
  inference: z.object({
    model: z.string().min(1).max(256), completionId: z.string().min(1).max(256),
    request: wire.nullable(), response: wire.nullable(),
    signature: z.object({ kind: z.literal("provider_tee"), signer: identity, signedText: z.string().max(1024), signature: hex }).strict().nullable(),
    gatewayReport: report.nullable(), modelReports: z.array(report).max(64),
  }).strict().nullable(),
  chain: chainReferenceSchema.nullable(),
  limitations: z.array(z.string().max(1000)).max(32),
}).strict();

export const verifierTrustSchema = z.object({
  schema: z.literal("razor.verifier-trust"), version: z.literal(1),
  expectedSubject: z.object({ kind: z.enum(["invoice_analysis", "finance_proposal", "payment_evidence"]), id: z.string().min(1).max(128) }).strict().optional(),
  expectedModel: z.string().max(256).optional(), expectedSigner: identity.optional(),
  approvedGatewayComposeSha256: z.array(digest).max(100).optional(), approvedModelComposeSha256: z.array(digest).max(100).optional(),
  hardware: z.object({
    acceptedTcbStatuses: z.array(z.enum(["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded", "OutOfDate", "OutOfDateConfigurationNeeded", "TDRelaunchAdvised", "TDRelaunchAdvisedConfigurationNeeded"])).min(1).max(8).default(["UpToDate"]),
    requireGpuEvidence: z.boolean().default(true),
    expectedGatewayNonce: z.string().min(1).max(256).optional(),
    expectedGatewaySpki: z.string().min(1).max(256).optional(),
    expectedModelNonces: z.array(z.object({ signer: identity, nonce: z.string().min(1).max(256) }).strict()).max(64).optional(),
  }).strict().optional(),
  expectedChain: chainReferenceSchema.omit({ blockHash: true, blockHeight: true, transactionHash: true, signerId: true }).optional(),
}).strict();

export type PortablePacket = z.infer<typeof portablePacketSchema>;
export type VerifierTrust = z.infer<typeof verifierTrustSchema>;
export type ChainReference = z.infer<typeof chainReferenceSchema>;
export type VerificationClaim = { claim: string; status: "passed" | "failed" | "unavailable" | "not_checked"; detail: string };
export const MAX_PACKET_BYTES = 40 * 1024 * 1024;

export function parsePacket(text: string): PortablePacket {
  if (new TextEncoder().encode(text).length > MAX_PACKET_BYTES) throw new Error("Evidence packet exceeds 40 MB");
  return portablePacketSchema.parse(JSON.parse(text));
}

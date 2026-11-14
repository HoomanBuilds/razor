import { z } from "zod";
import { canonicalDestination } from "./destination-packet";
import { portablePacketSchema, type PortablePacket } from "./packet";
import { decodeBase64, hashBytes, hashText } from "./verify";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nearHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
const account = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const inferenceAnchorReferenceSchema = z
  .object({ transactionHash: nearHash, signerId: account })
  .strict();
const reference = inferenceAnchorReferenceSchema;
const statuses = z.enum([
  "UpToDate",
  "SWHardeningNeeded",
  "ConfigurationNeeded",
  "ConfigurationAndSWHardeningNeeded",
  "OutOfDate",
  "OutOfDateConfigurationNeeded",
  "TDRelaunchAdvised",
  "TDRelaunchAdvisedConfigurationNeeded",
]);

export const inferenceAnchorTrustSchema = z
  .object({
    schema: z.literal("razor.inference-anchor-trust"),
    version: z.literal(1),
    network: z.enum(["mainnet", "testnet"]),
    contractId: account,
    codeHash: nearHash,
    recorder: account,
    contextHash: digest,
    expectedModel: z.string().min(1).max(256),
    maxIntervalMs: z.number().int().min(1000).max(600_000),
    approvedGatewayComposeSha256: z.array(digest).min(1).max(100),
    approvedModelComposeSha256: z.array(digest).min(1).max(100),
    acceptedTcbStatuses: z.array(statuses).min(1).max(8),
    acceptValidatorRandomnessAssumption: z.literal(true),
    originalGatewaySpki: z
      .string()
      .regex(/^(?:0x)?[a-fA-F0-9]{64}$/)
      .optional(),
  })
  .strict();

export const inferenceAnchorChallengeSchema = z
  .object({
    schema: z.literal("razor.inference-anchor-challenge"),
    version: z.literal(1),
    network: z.enum(["mainnet", "testnet"]),
    contractId: account,
    contextHash: digest,
    salt: digest,
    nonce: digest,
    challenge: reference,
  })
  .strict();

export const inferenceAnchorEvidenceSchema = z
  .object({
    schema: z.literal("razor.inference-anchor-evidence"),
    version: z.literal(1),
    network: z.enum(["mainnet", "testnet"]),
    contractId: account,
    contextHash: digest,
    salt: digest,
    nonce: digest,
    challenge: reference,
    response: reference,
    requestSha256: digest,
    responseSha256: digest,
    reportsSha256: digest,
  })
  .strict();

export type InferenceAnchorTrust = z.infer<typeof inferenceAnchorTrustSchema>;
export type InferenceAnchorChallenge = z.infer<
  typeof inferenceAnchorChallengeSchema
>;
export type InferenceAnchorEvidence = z.infer<
  typeof inferenceAnchorEvidenceSchema
>;
export type InferenceAnchorReference = z.infer<typeof reference>;
export const MAX_ANCHOR_BYTES = 64 * 1024;
export const canonicalAnchor = canonicalDestination;

export function parseInferenceAnchorTrust(text: string) {
  if (new TextEncoder().encode(text).length > MAX_ANCHOR_BYTES)
    throw Error("Anchor trust exceeds its bound");
  return inferenceAnchorTrustSchema.parse(JSON.parse(text));
}

export function parseInferenceAnchorEvidence(text: string) {
  if (new TextEncoder().encode(text).length > MAX_ANCHOR_BYTES)
    throw Error("Anchor evidence exceeds its bound");
  return inferenceAnchorEvidenceSchema.parse(JSON.parse(text));
}

export function retainedInferenceCommitments(input: PortablePacket) {
  const inference = portablePacketSchema.parse(input).inference;
  if (
    !inference?.request?.base64 ||
    !inference.response?.base64 ||
    !inference.gatewayReport ||
    !inference.modelReports.length ||
    !inference.signature
  )
    throw Error(
      "Original encrypted wire bodies, complete reports and model signature are required",
    );
  const requestSha256 = hashBytes(decodeBase64(inference.request.base64)),
    responseSha256 = hashBytes(decodeBase64(inference.response.base64));
  if (
    requestSha256 !== inference.request.sha256 ||
    responseSha256 !== inference.response.sha256
  )
    throw Error("Retained inference wire hashes do not match the exact bytes");
  const reportsSha256 = hashText(
    canonicalAnchor({
      gatewayReport: inference.gatewayReport,
      modelReports: inference.modelReports,
    }),
  );
  return { requestSha256, responseSha256, reportsSha256 };
}

export const INFERENCE_ANCHOR_LIMITATIONS = [
  "The reviewed contract records public hashes, not AI verification, invoice truth, payment authority or settlement.",
  "A challenge-to-response chain interval is conditional on NEAR validator randomness not being predicted or colluded upon. The block producer can predict its seed. It is not an unconditional wall-clock proof.",
  "Archival RPC responses are trusted observations, not independently verified light-client proofs. Current Intel/NVIDIA collateral validation does not prove historical collateral validity at the anchored block.",
  "Public commitments and recorder accounts remain linkable metadata. Use a new random blinded context and salt; never publish source identifiers, plaintext, keys or credentials.",
  "Gateway TLS identity requires an independently retained original SPKI observation. An exporter-provided fingerprint is not an independent verifier observation.",
] as const;

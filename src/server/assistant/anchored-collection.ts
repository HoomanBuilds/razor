import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { VerifiedModelAttestation } from "@nearai/inference-sdk/node";
import { verifyModelResponse } from "@nearai/inference-sdk/node";
import {
  canonicalAnchor,
  inferenceAnchorChallengeSchema,
  inferenceAnchorEvidenceSchema,
  inferenceAnchorTrustSchema,
  retainedInferenceCommitments,
  type InferenceAnchorChallenge,
  type InferenceAnchorTrust,
} from "../../lib/verification/inference-anchors";
import {
  portablePacketSchema,
  type PortablePacket,
} from "../../lib/verification/packet";
import { decodeBase64 } from "../../lib/verification/verify";
import { inferenceAnchorObserver } from "../../lib/verification/inference-anchors-rpc";

const descriptor = z
  .object({
    receiverId: z.string(),
    actions: z
      .array(
        z
          .object({
            type: z.literal("FunctionCall"),
            params: z
              .object({
                methodName: z.enum(["challenge", "record_response"]),
                args: z.record(z.string(), z.string()),
                gas: z.literal("30000000000000"),
                deposit: z.literal("0"),
              })
              .strict(),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();
export const preparedAnchorSchema = z
  .object({
    schema: z.literal("razor.inference-anchor-prepared"),
    version: z.literal(1),
    network: z.enum(["mainnet", "testnet"]),
    contractId: z.string(),
    recorder: z.string(),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
    wallet: descriptor,
  })
  .strict();
export const pendingAnchorSchema = z
  .object({
    schema: z.literal("razor.inference-anchor-pending"),
    version: z.literal(1),
    challenge: inferenceAnchorChallengeSchema,
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reportsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    wallet: descriptor,
  })
  .strict();

function wallet(
  contractId: string,
  methodName: "challenge" | "record_response",
  args: Record<string, string>,
) {
  return {
    receiverId: contractId,
    actions: [
      {
        type: "FunctionCall" as const,
        params: {
          methodName,
          args,
          gas: "30000000000000" as const,
          deposit: "0" as const,
        },
      },
    ],
  };
}

export function prepareInferenceChallenge(trustInput: InferenceAnchorTrust) {
  const trust = inferenceAnchorTrustSchema.parse(trustInput);
  if (trust.recorder === trust.contractId)
    throw Error("A separate recorder wallet is required");
  const salt = randomBytes(32).toString("hex");
  return preparedAnchorSchema.parse({
    schema: "razor.inference-anchor-prepared",
    version: 1,
    network: trust.network,
    contractId: trust.contractId,
    recorder: trust.recorder,
    contextHash: trust.contextHash,
    salt,
    wallet: wallet(trust.contractId, "challenge", {
      context_hash: trust.contextHash,
      salt,
    }),
  });
}

export async function collectInferenceChallenge(
  preparedInput: z.infer<typeof preparedAnchorSchema>,
  trustInput: InferenceAnchorTrust,
  transactionHash: string,
  rpcUrl: string,
) {
  const prepared = preparedAnchorSchema.parse(preparedInput),
    trust = inferenceAnchorTrustSchema.parse(trustInput);
  if (
    prepared.network !== trust.network ||
    prepared.contractId !== trust.contractId ||
    prepared.recorder !== trust.recorder ||
    prepared.contextHash !== trust.contextHash ||
    canonicalAnchor(prepared.wallet) !==
      canonicalAnchor(
        wallet(trust.contractId, "challenge", {
          context_hash: trust.contextHash,
          salt: prepared.salt,
        }),
      )
  )
    throw Error("Prepared challenge does not match independent trust");
  return (
    await inferenceAnchorObserver(rpcUrl).challenge(
      trust,
      { transactionHash, signerId: trust.recorder },
      prepared.salt,
    )
  ).challenge;
}

export function prepareInferenceResponse(
  challengeInput: InferenceAnchorChallenge,
  packetInput: PortablePacket,
  trustInput: InferenceAnchorTrust,
) {
  const challenge = inferenceAnchorChallengeSchema.parse(challengeInput),
    packet = portablePacketSchema.parse(packetInput),
    trust = inferenceAnchorTrustSchema.parse(trustInput);
  if (
    challenge.network !== trust.network ||
    challenge.contractId !== trust.contractId ||
    challenge.challenge.signerId !== trust.recorder ||
    challenge.contextHash !== trust.contextHash ||
    packet.inference?.model !== trust.expectedModel
  )
    throw Error(
      "Response commitment does not match independent challenge/model trust",
    );
  const commitments = retainedInferenceCommitments(packet),
    inference = packet.inference!,
    signature = inference.signature!;
  if (
    signature.kind !== "provider_tee" ||
    signature.signer.signingAlgo !== "ed25519" ||
    inference.gatewayReport!.nonce !== challenge.nonce ||
    inference.modelReports.some((report) => report.nonce !== challenge.nonce)
  )
    throw Error(
      "Response is missing the exact chain-challenged model and gateway reports",
    );
  const matches = inference.modelReports.filter(
    (report) =>
      report.signer.signingAlgo === "ed25519" &&
      report.signer.signingAddress.toLowerCase().replace(/^0x/, "") ===
        signature.signer.signingAddress.toLowerCase().replace(/^0x/, ""),
  );
  if (matches.length !== 1)
    throw Error("Exactly one quote must identify the response signer");
  const requestBody = decodeBase64(inference.request!.base64!),
    responseBody = decodeBase64(inference.response!.base64!);
  verifyModelResponse({
    requestBody,
    responseBody,
    signature,
    attestation: { signer: matches[0].signer } as VerifiedModelAttestation,
  });
  if (
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBody))
      .model !== trust.expectedModel ||
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBody))
      .id !== inference.completionId
  )
    throw Error("Signed model or completion identity does not match");
  return pendingAnchorSchema.parse({
    schema: "razor.inference-anchor-pending",
    version: 1,
    challenge,
    ...commitments,
    wallet: wallet(trust.contractId, "record_response", {
      challenge_transaction_hash: challenge.challenge.transactionHash,
      nonce: challenge.nonce,
      request_sha256: commitments.requestSha256,
      response_sha256: commitments.responseSha256,
      reports_sha256: commitments.reportsSha256,
    }),
  });
}

export async function collectInferenceResponse(
  pendingInput: z.infer<typeof pendingAnchorSchema>,
  packet: PortablePacket,
  trustInput: InferenceAnchorTrust,
  transactionHash: string,
  rpcUrl: string,
) {
  const pending = pendingAnchorSchema.parse(pendingInput),
    trust = inferenceAnchorTrustSchema.parse(trustInput),
    expected = prepareInferenceResponse(pending.challenge, packet, trust);
  if (canonicalAnchor(pending) !== canonicalAnchor(expected))
    throw Error(
      "Pending response commitments differ from the retained wire and reports",
    );
  const observer = inferenceAnchorObserver(rpcUrl),
    start = await observer.challenge(
      trust,
      pending.challenge.challenge,
      pending.challenge.salt,
    );
  if (start.challenge.nonce !== pending.challenge.nonce)
    throw Error("Historical challenge mismatch");
  const response = { transactionHash, signerId: trust.recorder },
    args = pending.wallet.actions[0].params.args;
  const end = await observer.response(trust, response, {
    challenge_transaction_hash: args.challenge_transaction_hash,
    nonce: args.nonce,
    request_sha256: args.request_sha256,
    response_sha256: args.response_sha256,
    reports_sha256: args.reports_sha256,
  });
  const interval =
    BigInt(end.timestampNs) - BigInt(start.observation.timestampNs);
  if (
    end.blockHeight <= start.observation.blockHeight ||
    interval <= 0n ||
    interval > BigInt(trust.maxIntervalMs) * 1_000_000n
  )
    throw Error(
      "Final response anchor is outside the independent maximum interval",
    );
  return inferenceAnchorEvidenceSchema.parse({
    schema: "razor.inference-anchor-evidence",
    version: 1,
    network: trust.network,
    contractId: trust.contractId,
    contextHash: trust.contextHash,
    salt: pending.challenge.salt,
    nonce: pending.challenge.nonce,
    challenge: pending.challenge.challenge,
    response,
    requestSha256: pending.requestSha256,
    responseSha256: pending.responseSha256,
    reportsSha256: pending.reportsSha256,
  });
}

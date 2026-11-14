import type {
  GatewayAttestation,
  ModelAttestation,
} from "@nearai/inference-sdk";
import {
  portablePacketSchema,
  type PortablePacket,
  type VerificationClaim,
} from "./packet";
import { decodeBase64, hashText } from "./verify";
import {
  INFERENCE_ANCHOR_LIMITATIONS,
  inferenceAnchorEvidenceSchema,
  inferenceAnchorTrustSchema,
  retainedInferenceCommitments,
  type InferenceAnchorEvidence,
  type InferenceAnchorTrust,
} from "./inference-anchors";
import { inferenceAnchorObserver } from "./inference-anchors-rpc";
import { DestinationFailure } from "./destination-rpc";

export async function verifyInferenceAnchors(
  input: InferenceAnchorEvidence,
  packetInput: PortablePacket,
  options: {
    trust?: InferenceAnchorTrust;
    rpcUrl?: string;
    verifyHardware?: boolean;
    transport?: typeof fetch;
  } = {},
) {
  const evidence = inferenceAnchorEvidenceSchema.parse(input),
    packet = portablePacketSchema.parse(packetInput);
  const claims: VerificationClaim[] = [];
  const add = (
    claim: string,
    status: VerificationClaim["status"],
    detail: string,
  ) => claims.push({ claim, status, detail });
  add(
    "anchor_format",
    "passed",
    "Separate strict anchor-evidence schema. Exporter assertions and packet allowlists are not adopted as verifier trust.",
  );
  let commitments: ReturnType<typeof retainedInferenceCommitments> | undefined;
  try {
    commitments = retainedInferenceCommitments(packet);
    if (
      Object.entries(commitments).some(
        ([key, value]) =>
          evidence[key as keyof InferenceAnchorEvidence] !== value,
      )
    )
      throw Error("Mismatch");
    add(
      "anchor_retained_commitments",
      "passed",
      "Recomputed exact disclosed encrypted request/response bytes and canonical retained model/gateway report hash.",
    );
  } catch {
    add(
      "anchor_retained_commitments",
      "failed",
      "Missing retained wire/report material or a commitment mismatch. Metadata-only packets cannot complete this check.",
    );
  }
  const trust = options.trust
    ? inferenceAnchorTrustSchema.parse(options.trust)
    : undefined;
  if (!trust) {
    add(
      "anchor_independent_trust",
      "not_checked",
      "Supply independently reviewed contract, code, recorder, context, model, measurements and maximum interval. No value is inferred from the packet.",
    );
    return { claims, limitations: INFERENCE_ANCHOR_LIMITATIONS };
  }
  const identityMatches =
    evidence.network === trust.network &&
    evidence.contractId === trust.contractId &&
    evidence.contextHash === trust.contextHash &&
    evidence.challenge.signerId === trust.recorder &&
    evidence.response.signerId === trust.recorder &&
    evidence.challenge.transactionHash !== evidence.response.transactionHash &&
    packet.inference?.model === trust.expectedModel;
  add(
    "anchor_independent_trust",
    identityMatches ? "passed" : "failed",
    "Compared with separate verifier input. Context is a blinded commitment, not proof of a source document or business fact.",
  );
  if (!identityMatches || !commitments)
    return { claims, limitations: INFERENCE_ANCHOR_LIMITATIONS };
  let intervalPassed = false;
  if (options.rpcUrl) {
    try {
      const observer = inferenceAnchorObserver(
        options.rpcUrl,
        options.transport,
      );
      const start = await observer.challenge(
        trust,
        evidence.challenge,
        evidence.salt,
      );
      if (start.challenge.nonce !== evidence.nonce)
        throw new DestinationFailure("Challenge nonce differs");
      const end = await observer.response(trust, evidence.response, {
        challenge_transaction_hash: evidence.challenge.transactionHash,
        nonce: evidence.nonce,
        request_sha256: evidence.requestSha256,
        response_sha256: evidence.responseSha256,
        reports_sha256: evidence.reportsSha256,
      });
      const elapsed =
        BigInt(end.timestampNs) - BigInt(start.observation.timestampNs);
      if (
        end.blockHeight <= start.observation.blockHeight ||
        elapsed <= 0n ||
        elapsed > BigInt(trust.maxIntervalMs) * 1_000_000n
      )
        throw new DestinationFailure("Anchor interval outside policy");
      intervalPassed = true;
      add(
        "anchor_final_chain_interval",
        "passed",
        `Selected archival RPC bound both exact successful calls, reachable receipts, executors, logs, historical reviewed code, zero access keys and timestamps. Interval ${elapsed / 1_000_000n} ms is within independent policy ${trust.maxIntervalMs} ms. These are RPC observations, not light-client proofs.`,
      );
    } catch (error) {
      add(
        "anchor_final_chain_interval",
        error instanceof DestinationFailure ? "failed" : "unavailable",
        "Exact finalized archival transaction/receipt/code/key/time evidence did not complete within the bounded selected RPC policy. No current-state or endpoint fallback is used.",
      );
    }
  } else
    add(
      "anchor_final_chain_interval",
      "not_checked",
      "No independently selected archival NEAR RPC was authorized. Exported timestamps are not accepted.",
    );
  let authenticated = false;
  if (options.verifyHardware) {
    const sdk = await import("@nearai/inference-sdk");
    try {
      const inference = packet.inference!;
      const signature = inference.signature!;
      if (
        signature.kind !== "provider_tee" ||
        signature.signer.signingAlgo !== "ed25519"
      )
        throw new DestinationFailure("Provider model signature required");
      const matches = inference.modelReports.filter(
        (report) =>
          report.signer.signingAlgo === "ed25519" &&
          report.signer.signingAddress.toLowerCase().replace(/^0x/, "") ===
            signature.signer.signingAddress.toLowerCase().replace(/^0x/, ""),
      );
      if (
        matches.length !== 1 ||
        inference.gatewayReport!.nonce !== evidence.nonce ||
        inference.modelReports.some((report) => report.nonce !== evidence.nonce)
      )
        throw new DestinationFailure("Ambiguous or non-challenged reports");
      if (!inference.gatewayReport!.spkiFingerprint)
        throw new DestinationFailure("TLS-bound gateway report is required");
      if (!trust.originalGatewaySpki)
        throw Error("Independent original TLS observation is unavailable");
      const gateway = await sdk.verifyGatewayAttestation({
        attestation: inference.gatewayReport as GatewayAttestation,
        clientBinding: {
          nonce: evidence.nonce,
          ...(trust.originalGatewaySpki
            ? { spkiFingerprint: trust.originalGatewaySpki }
            : {}),
        },
        policy: { acceptedTcbStatuses: trust.acceptedTcbStatuses },
      });
      const models = await Promise.all(
        inference.modelReports.map((report) =>
          sdk.verifyModelAttestation({
            attestation: report as ModelAttestation,
            clientBinding: { nonce: evidence.nonce },
            policy: {
              acceptedTcbStatuses: trust.acceptedTcbStatuses,
              gpuEvidence: "required",
            },
          }),
        ),
      );
      if (
        gateway.tlsBinding.kind !== "attested" ||
        !trust.approvedGatewayComposeSha256.includes(
          hashText(gateway.deployment.appCompose),
        ) ||
        models.some(
          (model) =>
            !trust.approvedModelComposeSha256.includes(
              hashText(model.deployment.appCompose),
            ) ||
            model.gpuEvidence !== "verified" ||
            !model.signingPublicKey,
        )
      )
        throw new DestinationFailure("Measurements or GPU policy failed");
      const selected = models.find(
        (model) =>
          model.signer.signingAlgo === "ed25519" &&
          model.signer.signingAddress.toLowerCase().replace(/^0x/, "") ===
            signature.signer.signingAddress.toLowerCase().replace(/^0x/, ""),
      );
      if (!selected)
        throw new DestinationFailure("Selected quote signer missing");
      const requestBody = decodeBase64(inference.request!.base64!),
        responseBody = decodeBase64(inference.response!.base64!);
      sdk.verifyModelResponse({
        requestBody,
        responseBody,
        signature,
        attestation: selected,
      });
      if (
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(requestBody),
        ).model !== trust.expectedModel ||
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(responseBody),
        ).id !== inference.completionId
      )
        throw new DestinationFailure("Signed model/completion mismatch");
      authenticated = true;
      add(
        "anchor_hardware_wire_binding",
        "passed",
        "Official SDK authenticated exact challenge nonce, measured model/gateway deployments, accepted TCB, required GPU identity and model signature over the retained encrypted wire bodies. Collateral is checked now, not retrospectively proven valid at the historical block.",
      );
      add(
        "anchor_original_gateway_tls",
        trust.originalGatewaySpki && gateway.tlsBinding.kind === "attested"
          ? "passed"
          : "not_checked",
        "Only independently supplied original TLS SPKI observations can authenticate the original TLS binding. Packet fingerprints are never adopted as observations.",
      );
    } catch (error) {
      const missingTls =
        !trust.originalGatewaySpki &&
        !!packet.inference!.gatewayReport?.spkiFingerprint;
      add(
        "anchor_hardware_wire_binding",
        !missingTls &&
          (error instanceof DestinationFailure ||
            (sdk.isVerificationError(error) && !error.retryable))
          ? "failed"
          : "unavailable",
        "Official hardware verification, challenge nonce, model signature, exact wire or independent measurement policy did not complete. Missing independent original TLS observations or collateral access remain unavailable. No Gateway-only or unverified fallback is accepted.",
      );
    }
  } else
    add(
      "anchor_hardware_wire_binding",
      "not_checked",
      "Enable hardware verification explicitly; official Intel/NVIDIA collateral access may be required. A retained report hash is not hardware verification.",
    );
  add(
    "anchor_conditional_inference_interval",
    intervalPassed && authenticated ? "passed" : "not_checked",
    "Requires both final chain interval and hardware-authenticated nonce/wire binding. Under the explicitly accepted non-colluding validator randomness assumption this bounds challenged report/inference evidence between the chain observations. It does not prove unconditional wall-clock time, model honesty, plaintext or invoice truth.",
  );
  return { claims, limitations: INFERENCE_ANCHOR_LIMITATIONS };
}

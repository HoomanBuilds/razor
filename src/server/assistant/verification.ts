import { createHash } from "node:crypto";
import type { AttestationVerificationResult, MeasuredDeployment, VerifiedCompletionResult, VerifiedModelCompletionResult } from "@nearai/inference-sdk/node";
import { ApiError } from "../context";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function approveDeployment(deployment: MeasuredDeployment, allowed: readonly string[]): void {
  if (!allowed.includes(sha256(deployment.appCompose))) throw new ApiError(502, "The attested deployment is not approved for private invoice processing", "AI_DEPLOYMENT_UNAPPROVED");
}

export function assertFreshDeployment(evidence: AttestationVerificationResult, maxAge: number, now = Date.now()): void {
  const age = now - evidence.verifiedAt;
  if (!Number.isFinite(age) || age < 0 || age > maxAge) throw new ApiError(502, "Private inference attestation is stale", "AI_ATTESTATION_STALE");
  if (evidence.gateway.tlsBinding.kind !== "attested" || !evidence.models.length) throw new ApiError(502, "Private inference requires TLS-bound Gateway evidence and model TEE evidence", "AI_MODEL_ATTESTATION_REQUIRED");
  if (evidence.models.some((model) => model.gpuEvidence !== "verified" || !model.signingPublicKey || !model.report.nonce)) throw new ApiError(502, "The model has no complete verified GPU identity and encryption key", "AI_MODEL_IDENTITY_INVALID");
}

export function requireModelReceipt(receipt: VerifiedCompletionResult, completionId: string): asserts receipt is VerifiedModelCompletionResult {
  if (receipt.id !== completionId || receipt.signatureKind !== "provider_tee" || !receipt.attestations.length) throw new ApiError(502, "This invoice response is not bound to a verified model TEE signature", "AI_MODEL_SIGNATURE_REQUIRED");
  if (receipt.signature.kind !== "provider_tee" || !receipt.attestations.some((model) => model.signer.signingAddress === receipt.signature.signer.signingAddress && model.signer.signingAlgo === receipt.signature.signer.signingAlgo)) throw new ApiError(502, "The response signer does not match the verified model identity", "AI_RESPONSE_SIGNER_MISMATCH");
}

export function publicVerification(model: string, deployment: AttestationVerificationResult, receipt: VerifiedModelCompletionResult) {
  const wireHashes = /^(.*):([a-f0-9]{64}):([a-f0-9]{64})$/i.exec(receipt.signature.signedText);
  return {
    ok: true,
    provider: "NEAR AI Cloud",
    model,
    completionId: receipt.id,
    signatureKind: receipt.signatureKind,
    signer: receipt.signature.signer,
    verifiedAt: new Date(deployment.verifiedAt).toISOString(),
    responseVerifiedAt: new Date().toISOString(),
    fieldEncryption: true,
    gatewayTlsBound: true,
    requestBound: true,
    responseBound: true,
    requestWireHash: wireHashes?.[2] ?? null,
    responseWireHash: wireHashes?.[3] ?? null,
    gatewayComposeSha256: sha256(deployment.gateway.deployment.appCompose),
    modelComposeSha256: receipt.attestations.map((attestation) => sha256(attestation.deployment.appCompose)),
    gatewayTcbStatus: deployment.gateway.tcbStatus,
    modelTcbStatuses: receipt.attestations.map((attestation) => attestation.tcbStatus),
    gpuEvidenceVerified: receipt.attestations.every((attestation) => attestation.gpuEvidence === "verified"),
  };
}

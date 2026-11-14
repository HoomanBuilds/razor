import { z } from "zod";
import { portablePacketSchema, type PortablePacket } from "../../lib/verification/packet";
import { ApiError } from "../context";

export const packetDisclosure = z.object({ disclosure: z.enum(["encrypted_wire", "metadata"]).default("encrypted_wire") }).strict();

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function rawReport(value: unknown) {
  const report = asRecord(value);
  return Object.fromEntries(["nonce", "signer", "intelQuote", "eventLog", "appCompose", "signingPublicKey", "nvidiaPayload", "reportedQuoteData", "spkiFingerprint", "ohttpAttestation", "composeManagerAttestation"].filter(key => report[key] !== undefined).map(key => [key, report[key]]));
}

export function createAnalysisPacket(input: { id: string; kind: "invoice_analysis" | "finance_proposal"; evidence: unknown; model?: string }, disclosure: "encrypted_wire" | "metadata", now = new Date()): PortablePacket {
  const evidence = asRecord(input.evidence), deployment = asRecord(evidence.deployment), receipt = asRecord(evidence.receipt), verification = asRecord(evidence.verification), wire = asRecord(evidence.wire), signature = asRecord(receipt.signature);
  const wireBody = (value: unknown) => {
    const body = asRecord(value);
    return typeof body.sha256 === "string" ? { sha256: body.sha256, base64: disclosure === "encrypted_wire" && typeof body.base64 === "string" ? body.base64 : null } : null;
  };
  const model = input.model || verification.model;
  const inference = typeof receipt.id === "string" && typeof model === "string" ? {
    model, completionId: receipt.id, request: wireBody(wire.request), response: wireBody(wire.response),
    signature: signature.kind === "provider_tee" ? { kind: signature.kind, signer: signature.signer, signature: signature.signature, signedText: signature.signedText } : null,
    gatewayReport: asRecord(deployment.gateway).report ? rawReport(asRecord(deployment.gateway).report) : null,
    modelReports: Array.isArray(receipt.attestations) ? receipt.attestations.map(item => rawReport(asRecord(item).report)) : [],
  } : null;
  const result = portablePacketSchema.safeParse({
    schema: "razor.portable-evidence", version: 1, network: null, subject: { kind: input.kind, id: input.id }, exportedAt: now.toISOString(),
    executionObservedAt: typeof deployment.verifiedAt === "number" && Number.isFinite(deployment.verifiedAt) ? new Date(deployment.verifiedAt).toISOString() : null,
    disclosure: { mode: disclosure, plaintextIncluded: false, decryptionKeysIncluded: false }, inference, chain: null,
    limitations: [
      "This local export contains encrypted inference wire data and public attestation reports where retained. No plaintext, workspace credentials or decryption keys are exported.",
      "Subject identity, execution time and association with this review draft are exporter assertions, not encrypted plaintext verification.",
      "Wire signatures do not cryptographically bind separately supplied decrypted invoice text, extracted amounts or recipients without additional evidence.",
      "Hardware identity and historical attestation freshness require independent review and collateral. Packet verification flags and packet-provided allowlists cannot establish trust.",
      "This analysis is a review proposal and includes no finalized payment, destination settlement or treasury authority proof.",
      "A downloaded local file cannot be revoked or made unreadable by server deletion or expiry. No public sharing link is created.",
      ...(disclosure === "metadata" ? ["Request and response wire bytes are redacted. Hash and signature binding cannot be independently checked from this export."] : []),
      ...(!wire.request || !wire.response ? ["Historical wire bytes were not retained. They have not been reconstructed from plaintext hashes."] : []),
    ],
  });
  if (!result.success) throw new ApiError(409, "Retained evidence cannot be represented safely in the portable packet format", "PORTABLE_EVIDENCE_INVALID");
  return result.data;
}

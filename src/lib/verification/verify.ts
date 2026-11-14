import type { VerifiedModelAttestation } from "@nearai/inference-sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { portablePacketSchema, verifierTrustSchema, type ChainReference, type PortablePacket, type VerificationClaim, type VerifierTrust } from "./packet";

export const hashBytes = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export const hashText = (text: string) => hashBytes(new TextEncoder().encode(text));
export const decodeBase64 = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0));
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export interface HistoricalObservation {
  network: string; blockHash: string; blockHeight: number; codeHash: string;
  payment: { id: string; amount: string; recipientId: string; recipientVersion: string; policyVersion: string };
  transactionBound: boolean;
}
export interface VerificationOptions {
  trust?: VerifierTrust;
  lookupHistory?: (reference: ChainReference) => Promise<HistoricalObservation>;
  verifyHardware?: boolean;
}

export async function verifyPacket(input: PortablePacket, options: VerificationOptions = {}): Promise<VerificationClaim[]> {
  const packet = portablePacketSchema.parse(input), trust = options.trust ? verifierTrustSchema.parse(options.trust) : undefined;
  const claims: VerificationClaim[] = [], add = (claim: string, status: VerificationClaim["status"], detail: string) => claims.push({ claim, status, detail });
  add("packet_format", "passed", "Portable evidence schema version 1. Packet metadata and limitations are exporter assertions.");
  if (packet.chain) add("network_consistency", packet.network === packet.chain.network ? "passed" : "failed", "Packet network must match its referenced chain execution.");
  if (packet.subject.kind === "payment_evidence") add("payment_subject_binding", packet.chain?.paymentId === packet.subject.id ? "passed" : "failed", "The chain reference must identify this payment subject. Inference-to-payment associations require additional authenticated evidence.");
  if (trust?.expectedSubject) add("expected_subject", JSON.stringify(trust.expectedSubject) === JSON.stringify(packet.subject) ? "passed" : "failed", "Compared with a separate verifier input. This does not bind the subject to encrypted model content.");
  else add("expected_subject", "not_checked", "No independently supplied subject identity. A packet identifier cannot authenticate its own invoice or proposal.");
  const inference = packet.inference;
  if (inference) {
    let request: Uint8Array | undefined, response: Uint8Array | undefined;
    for (const [name, wire] of [["request", inference.request], ["response", inference.response]] as const) {
      if (!wire?.base64) { add(`${name}_bytes`, "unavailable", "Actual signed wire bytes were not retained or were redacted. A supplied hash is not byte verification."); continue; }
      const bytes = decodeBase64(wire.base64), valid = hashBytes(bytes) === wire.sha256;
      add(`${name}_bytes`, valid ? "passed" : "failed", "SHA-256 recomputed from the disclosed encrypted wire bytes.");
      if (name === "request") request = bytes; else response = bytes;
    }
    if (request && response && inference.signature) {
      try {
        const signerReport = inference.modelReports.find(report => report.signer.signingAlgo === inference.signature!.signer.signingAlgo && report.signer.signingAddress.toLowerCase().replace(/^0x/, "") === inference.signature!.signer.signingAddress.toLowerCase().replace(/^0x/, ""));
        if (!signerReport) throw new Error("No raw model report matches the response signer");
        // Only the SDK signature and wire-binding routine consumes this identity. Hardware trust is evaluated separately.
        const { verifyModelResponse } = await import("@nearai/inference-sdk");
        verifyModelResponse({ requestBody: request, responseBody: response, signature: inference.signature, attestation: { signer: signerReport.signer } as VerifiedModelAttestation });
        const requestModel = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request)).model;
        if (requestModel !== inference.model) throw new Error("Signed request model differs from packet model");
        const responseId = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response)).id;
        if (responseId !== inference.completionId) throw new Error("Signed response ID differs from packet completion ID");
        add("model_signature_and_wire_binding", "passed", "Official NEAR SDK verified provider_tee signature over the exact encrypted request and response, model and response ID. The signing key is not authenticated by this check.");
      } catch {
        add("model_signature_and_wire_binding", "failed", "Invalid signature, changed bytes, mismatched signer, model, or response ID.");
      }
    } else add("model_signature_and_wire_binding", "unavailable", "Signature and both original wire bodies are required. Redacted bodies cannot retain a signature-success label.");
    if (trust?.expectedModel) add("expected_model", inference.model === trust.expectedModel ? "passed" : "failed", "Compared with separately supplied model identity.");
    if (trust?.expectedSigner && inference.signature) {
      const actual = inference.signature.signer, expected = trust.expectedSigner;
      add("expected_signer", actual.signingAlgo === expected.signingAlgo && actual.signingAddress.toLowerCase().replace(/^0x/, "") === expected.signingAddress.toLowerCase().replace(/^0x/, "") ? "passed" : "failed", "Compared with separately reviewed signer input. Does not establish hardware identity.");
    } else add("expected_signer", "not_checked", "No independently supplied signer trust input.");
    for (const [name, reports, approved] of [["gateway", inference.gatewayReport ? [inference.gatewayReport] : [], trust?.approvedGatewayComposeSha256], ["model", inference.modelReports, trust?.approvedModelComposeSha256]] as const) {
      add(`${name}_reported_deployment`, !approved?.length ? "not_checked" : !reports.length ? "unavailable" : reports.every(report => approved.includes(hashText(report.appCompose))) ? "passed" : "failed", "Only compares raw reported compose hashes with separately reviewed inputs. Hardware measurement binding has not been independently established.");
    }
    if (options.verifyHardware) {
      const { verifyHardware } = await import("./hardware");
      claims.push(...await verifyHardware(packet, trust));
    } else add("hardware_attestation", inference.modelReports.length && inference.gatewayReport ? "not_checked" : "unavailable", "Hardware verification is disabled in offline mode. Enable it explicitly to revalidate retained reports with the official NEAR SDK and current Intel/NVIDIA collateral. Historical freshness, plaintext and settlement remain separate claims.");
    add("attestation_freshness_at_execution", "not_checked", "The observed execution time is an exporter assertion. Authenticated historical collateral and time evidence are required; current verification cannot establish freshness at past execution.");
    add("decrypted_plaintext_binding", "not_checked", "No decryption keys or plaintext are included. Signed encrypted wire hashes do not prove a separately supplied invoice, extracted amount, recipient or model conclusion.");
  } else add("inference_evidence", "unavailable", "No signed inference material was retained for this record.");
  if (trust?.expectedChain) {
    const expected = trust.expectedChain;
    add("expected_financial_context", packet.chain && Object.entries(expected).every(([key, value]) => packet.chain![key as keyof ChainReference] === value) ? "passed" : "failed", "Network, deployment, code, payment, amount and recipient/policy versions compared with independently supplied expectations.");
  } else add("expected_financial_context", "not_checked", "No separate chain and financial expectations. Inference packets alone do not prove a payment or financial terms.");
  if (packet.chain && options.lookupHistory) {
    try {
      const ref = packet.chain, observed = await options.lookupHistory(ref);
      const match = observed.network === ref.network && observed.blockHash === ref.blockHash && observed.blockHeight === ref.blockHeight && observed.codeHash === ref.codeHash && observed.payment.id === ref.paymentId && observed.payment.amount === ref.amount && observed.payment.recipientId === ref.recipientId && observed.payment.recipientVersion === ref.recipientVersion && observed.payment.policyVersion === ref.policyVersion;
      add("historical_chain_context", match ? "passed" : "failed", "Code and frozen payment terms queried at the referenced execution block through the verifier-selected RPC. Current deployment/profile state is not used. RPC responses are trusted observations, not light-client proofs.");
      add("final_transaction_binding", observed.transactionBound ? "passed" : "failed", "Final successful transaction must target this contract/payment and include its execution outcome at this block. This is not proof of destination settlement.");
    } catch {
      add("historical_chain_context", "unavailable", "Historical block, code, payment or final transaction could not be independently fetched. No fallback to current state.");
    }
  } else add("historical_chain_context", packet.chain ? "not_checked" : "unavailable", packet.chain ? "Offline mode. Enable a verifier-selected archival NEAR RPC to query the execution block." : "No finalized chain execution reference is present.");
  add("provider_reported_delivery", "unavailable", "This packet supplies no authenticated provider delivery report. A provider report alone would not prove independently observed destination settlement.");
  add("operator_attestation", "unavailable", "No independently authenticated operator settlement assertion is supplied. Exporter metadata is not an operator settlement signature.");
  add("settlement", "not_checked", "Destination-chain transfer receipts require independent settlement verification. A final NEAR payment call or inference signature does not prove invoice truth or destination delivery.");
  return claims;
}

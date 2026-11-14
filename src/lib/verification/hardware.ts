import type { GatewayAttestation, ModelAttestation, VerifiedModelAttestation } from "@nearai/inference-sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { PortablePacket, VerificationClaim, VerifierTrust } from "./packet";

type Signer = { signingAlgo: string; signingAddress: string };
const sameSigner = (left: Signer, right: Signer) => left.signingAlgo === right.signingAlgo && left.signingAddress.toLowerCase().replace(/^0x/, "") === right.signingAddress.toLowerCase().replace(/^0x/, "");
const composeHash = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));

export async function verifyHardware(packet: PortablePacket, trust?: VerifierTrust): Promise<VerificationClaim[]> {
  const claims: VerificationClaim[] = [];
  const add = (claim: string, status: VerificationClaim["status"], detail: string) => claims.push({ claim, status, detail });
  const inference = packet.inference;
  if (!inference) return claims;
  const sdk = await import("@nearai/inference-sdk");
  const policy = trust?.hardware;
  const acceptedTcbStatuses = policy?.acceptedTcbStatuses ?? ["UpToDate" as const];
  let authenticatedModel: VerifiedModelAttestation | undefined;
  const matching = inference.signature ? inference.modelReports.filter(report => sameSigner(report.signer, inference.signature!.signer)) : [];
  if (matching.length !== 1) {
    add("model_hardware_attestation", matching.length > 1 ? "failed" : "unavailable", "Exactly one raw model report must match the completion signer. Unrelated or ambiguous reports cannot authenticate this completion.");
  } else {
    const report = matching[0];
    const expected = policy?.expectedModelNonces?.filter(item => sameSigner(item.signer, report.signer)) ?? [];
    if (expected.length > 1) {
      add("model_hardware_attestation", "failed", "The independently supplied trust input contains ambiguous nonce expectations for the model signer.");
    } else {
      try {
        authenticatedModel = await sdk.verifyModelAttestation({
          attestation: report as ModelAttestation,
          clientBinding: { nonce: expected[0]?.nonce ?? report.nonce },
          policy: { acceptedTcbStatuses, gpuEvidence: policy?.requireGpuEvidence === false ? "if-present" : "required" },
        });
        add("model_hardware_attestation", "passed", `Official NEAR SDK revalidated Intel quote, signer, measured deployment and required GPU evidence using current collateral. Accepted TCB: ${authenticatedModel.tcbStatus}; GPU: ${authenticatedModel.gpuEvidence}. This does not establish the original request time.`);
        add("model_authenticated_deployment", !trust?.approvedModelComposeSha256?.length ? "not_checked" : trust.approvedModelComposeSha256.includes(composeHash(authenticatedModel.deployment.appCompose)) ? "passed" : "failed", "Compares the quote-authenticated deployment with independently reviewed compose hashes. A hash match does not establish source-build provenance or model-output correctness.");
        add("model_nonce_expectation", expected.length ? "passed" : "not_checked", expected.length ? "Quote nonce matches a separately supplied expected challenge. Its origin and execution-time window still require independently trusted historical evidence." : "Quote binds the reported nonce, but no independently retained challenge was supplied. A packet cannot establish its own freshness.");
      } catch (error) {
        add("model_hardware_attestation", sdk.isVerificationError(error) ? "failed" : "unavailable", "Model quote, measurement, nonce, signer, TCB or GPU validation did not complete successfully. Missing collateral/network access is not a successful check.");
      }
    }
  }
  if (authenticatedModel && inference.signature && inference.request?.base64 && inference.response?.base64) {
    try {
      const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
      sdk.verifyModelResponse({ requestBody: decode(inference.request.base64), responseBody: decode(inference.response.base64), signature: inference.signature, attestation: authenticatedModel });
      add("hardware_bound_completion_signature", "passed", "The exact disclosed encrypted request and response signature binds to the hardware-authenticated model signer. Decrypted content and destination settlement remain separate.");
    } catch {
      add("hardware_bound_completion_signature", "failed", "The disclosed wire bodies or completion signature do not match the hardware-authenticated signer.");
    }
  } else add("hardware_bound_completion_signature", "unavailable", "A successfully authenticated model, completion signature and both original encrypted wire bodies are required.");
  const gateway = inference.gatewayReport;
  if (!gateway?.reportedQuoteData) {
    add("gateway_hardware_attestation", "unavailable", "A complete raw gateway report, including reported quote data, is required.");
  } else {
    try {
      const verified = await sdk.verifyGatewayAttestation({
        attestation: gateway as GatewayAttestation,
        clientBinding: { nonce: policy?.expectedGatewayNonce ?? gateway.nonce, ...(policy?.expectedGatewaySpki ? { spkiFingerprint: policy.expectedGatewaySpki } : {}) },
        policy: { acceptedTcbStatuses },
      });
      add("gateway_hardware_attestation", "passed", `Official NEAR SDK revalidated the gateway quote, signer and measured deployment using current collateral. Accepted TCB: ${verified.tcbStatus}.`);
      add("gateway_authenticated_deployment", !trust?.approvedGatewayComposeSha256?.length ? "not_checked" : trust.approvedGatewayComposeSha256.includes(composeHash(verified.deployment.appCompose)) ? "passed" : "failed", "Compares the quote-authenticated gateway deployment with independently reviewed compose hashes.");
      add("gateway_nonce_expectation", policy?.expectedGatewayNonce ? "passed" : "not_checked", "A separately supplied challenge can bind the expected nonce. Packet-provided nonces alone do not establish historical freshness.");
      add("gateway_tls_observation", verified.tlsBinding.kind === "attested" && policy?.expectedGatewaySpki ? "passed" : "not_checked", "TLS binding requires an independently observed original peer SPKI fingerprint. The fingerprint reported in the packet is never adopted as an observation.");
    } catch (error) {
      add("gateway_hardware_attestation", sdk.isVerificationError(error) ? "failed" : "unavailable", "Gateway quote, measurements, TCB, expected nonce or independently observed TLS binding did not validate. No fallback to packet verification booleans.");
    }
  }
  return claims;
}

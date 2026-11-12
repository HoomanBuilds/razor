import { InferenceClient, getSdkError, type AttestationVerificationResult } from "@nearai/inference-sdk/node";
import { ApiError } from "../context";
import { requirePrivateAiConfig } from "./config";
import { INVOICE_SYSTEM_PROMPT, parseExtraction, reviewExtraction } from "./extraction";
import { approveDeployment, assertFreshDeployment, publicVerification, requireModelReceipt, sha256 } from "./verification";

export async function extractPrivateInvoice(text: string) {
  const config = requirePrivateAiConfig();
  const client = new InferenceClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    e2ee: true,
    signingAlgo: "ed25519",
    attestationCacheTimeToLiveMs: config.maxAttestationAgeMs,
    responseCacheTimeToLiveMs: 120_000,
    gatewayVerification: {
      includeSpkiFingerprint: true,
      policy: { acceptedTcbStatuses: ["UpToDate", "SWHardeningNeeded"] },
      verifiers: { deployment: (deployment) => approveDeployment(deployment, config.gatewayHashes) },
    },
    modelVerification: {
      policy: { acceptedTcbStatuses: ["UpToDate", "SWHardeningNeeded"], gpuEvidence: "required" },
      verifiers: { deployment: (deployment) => approveDeployment(deployment, config.modelHashes) },
    },
    deploymentPolicy: ({ model }) => {
      if (model !== config.model) throw new ApiError(502, "The verified model does not match the configured invoice model", "AI_MODEL_MISMATCH");
    },
  });
  let stage: "deployment" | "inference" | "response" = "deployment";
  try {
    const deployment: AttestationVerificationResult = await client.verify(config.model);
    assertFreshDeployment(deployment, config.maxAttestationAgeMs);
    stage = "inference";
    const completion = await client.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      stream: false,
      messages: [{ role: "system", content: INVOICE_SYSTEM_PROMPT }, { role: "user", content: text }],
    }, { signal: AbortSignal.timeout(90_000), maxRetries: 0 });
    stage = "response";
    const receipt = await client.verifyResponse(completion.id);
    requireModelReceipt(receipt, completion.id);
    assertFreshDeployment(deployment, config.maxAttestationAgeMs);
    const content = completion.choices[0]?.message.content;
    if (!content || completion.choices[0]?.finish_reason !== "stop") throw new ApiError(502, "The verified response did not finish an invoice extraction", "INVOICE_EXTRACTION_INCOMPLETE");
    const extracted = parseExtraction(content);
    return {
      draft: reviewExtraction(extracted, text),
      verification: publicVerification(config.model, deployment, receipt),
      evidence: { deployment, receipt, inputSha256: sha256(text), extractionSha256: sha256(content), extracted },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const sdk = getSdkError(error);
    const code = sdk?.failure.code ?? "unavailable";
    throw new ApiError(502, stage === "deployment" ? "Private model identity verification failed before invoice text was sent" : stage === "response" ? "The private model response could not be verified. No invoice draft was accepted" : "NEAR AI Cloud did not complete private invoice analysis", `PRIVATE_AI_${stage.toUpperCase()}_FAILED:${code}`);
  } finally {
    client.clearResponseCache();
  }
}

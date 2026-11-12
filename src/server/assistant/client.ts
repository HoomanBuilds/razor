import { InferenceClient, getSdkError, type AttestationVerificationResult } from "@nearai/inference-sdk/node";
import { ApiError } from "../context";
import { requirePrivateAiConfig } from "./config";
import { INVOICE_SYSTEM_PROMPT, parseExtraction, reviewExtraction } from "./extraction";
import { FINANCE_SYSTEM_PROMPT } from "./finance/prompt";
import { approveDeployment, assertFreshDeployment, publicVerification, requireModelReceipt, sha256 } from "./verification";

export async function runVerifiedPrivateInference(task: "invoice" | "finance", text: string) {
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
      if (model !== config.model) throw new ApiError(502, "The verified model does not match the configured private model", "AI_MODEL_MISMATCH");
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
      messages: [{ role: "system", content: task === "invoice" ? INVOICE_SYSTEM_PROMPT : FINANCE_SYSTEM_PROMPT }, { role: "user", content: text }],
    }, { signal: AbortSignal.timeout(90_000), maxRetries: 0 });
    stage = "response";
    const receipt = await client.verifyResponse(completion.id);
    requireModelReceipt(receipt, completion.id);
    assertFreshDeployment(deployment, config.maxAttestationAgeMs);
    const content = completion.choices[0]?.message.content;
    if (!content || completion.choices[0]?.finish_reason !== "stop") throw new ApiError(502, task === "invoice" ? "The verified response did not finish an invoice extraction" : "The verified response did not finish a finance proposal", task === "invoice" ? "INVOICE_EXTRACTION_INCOMPLETE" : "FINANCE_PLAN_INCOMPLETE");
    return {
      content,
      verification: publicVerification(config.model, deployment, receipt),
      evidence: { deployment, receipt, inputSha256: sha256(text), responseSha256: sha256(content) },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const sdk = getSdkError(error);
    const code = sdk?.failure.code ?? "unavailable";
    throw new ApiError(502, stage === "deployment" ? "Private model identity verification failed before input was sent" : stage === "response" ? "The private model response could not be verified. No proposal was accepted" : "NEAR AI Cloud did not complete private analysis", `PRIVATE_AI_${stage.toUpperCase()}_FAILED:${code}`);
  } finally {
    client.clearResponseCache();
  }
}

export async function extractPrivateInvoice(text: string) {
  const result = await runVerifiedPrivateInference("invoice", text);
  const extracted = parseExtraction(result.content);
  return { draft: reviewExtraction(extracted, text), verification: result.verification, evidence: { ...result.evidence, extractionSha256: result.evidence.responseSha256, extracted } };
}

import {
  getSdkError,
  type AttestationVerificationResult,
} from "@nearai/inference-sdk/node";
import { createHash } from "node:crypto";
import { ApiError } from "../context";
import { requirePrivateAiConfig } from "./config";
import {
  INVOICE_SYSTEM_PROMPT,
  parseExtraction,
  reviewExtraction,
} from "./extraction";
import { FINANCE_SYSTEM_PROMPT } from "./finance/prompt";
import { PAYROLL_MAPPING_SYSTEM_PROMPT } from "../payroll-import/prompt";
import {
  approveDeployment,
  assertFreshDeployment,
  publicVerification,
  requireModelReceipt,
  sha256,
} from "./verification";
import {
  EvidenceInferenceClient,
  type EvidenceSessionFactory,
} from "./capture";
import { encodeBase64, hashBytes } from "../../lib/verification/verify";

export interface InvoiceImage {
  mimeType: "image/png" | "image/jpeg";
  data: string;
}

export function invoiceMessageContent(
  text: string,
  images: InvoiceImage[] = [],
) {
  if (!images.length) return text;
  if (
    images.length > 8 ||
    images.reduce((sum, image) => sum + image.data.length, 0) >
      12 * 1024 * 1024 ||
    images.some(
      (image) =>
        !["image/png", "image/jpeg"].includes(image.mimeType) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data),
    )
  )
    throw new ApiError(
      422,
      "The invoice images exceed the private processing limit",
      "INVOICE_IMAGES_INVALID",
    );
  return [
    { type: "text" as const, text },
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: `data:${image.mimeType};base64,${image.data}`,
        detail: "high" as const,
      },
    })),
  ];
}

export async function runVerifiedPrivateInference(
  task: "invoice" | "finance" | "payroll_mapping",
  text: string,
  images: InvoiceImage[] = [],
  options: {
    createVerifiedSession?: EvidenceSessionFactory;
    signal?: AbortSignal;
  } = {},
) {
  if (task !== "invoice" && images.length)
    throw new ApiError(
      422,
      "Images are only accepted for invoice review",
      "INVOICE_IMAGES_INVALID",
    );
  const content = invoiceMessageContent(text, images);
  const config = requirePrivateAiConfig();
  const client = new EvidenceInferenceClient({
    createVerifiedSession: options.createVerifiedSession,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    e2ee: true,
    signingAlgo: "ed25519",
    attestationCacheTimeToLiveMs: config.maxAttestationAgeMs,
    responseCacheTimeToLiveMs: 120_000,
    gatewayVerification: {
      includeSpkiFingerprint: true,
      policy: { acceptedTcbStatuses: ["UpToDate", "SWHardeningNeeded"] },
      verifiers: {
        deployment: (deployment) =>
          approveDeployment(deployment, config.gatewayHashes),
      },
    },
    modelVerification: {
      policy: {
        acceptedTcbStatuses: ["UpToDate", "SWHardeningNeeded"],
        gpuEvidence: "required",
      },
      verifiers: {
        deployment: (deployment) =>
          approveDeployment(deployment, config.modelHashes),
      },
    },
    deploymentPolicy: ({ model }) => {
      if (model !== config.model)
        throw new ApiError(
          502,
          "The verified model does not match the configured private model",
          "AI_MODEL_MISMATCH",
        );
    },
  });
  let stage: "deployment" | "inference" | "response" = "deployment";
  try {
    const deployment: AttestationVerificationResult = await client.verify(
      config.model,
    );
    assertFreshDeployment(deployment, config.maxAttestationAgeMs);
    stage = "inference";
    const completion = await client.chat.completions.create(
      {
        model: config.model,
        temperature: 0,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        stream: false,
        messages: [
          {
            role: "system",
            content:
              task === "invoice"
                ? INVOICE_SYSTEM_PROMPT
                : task === "finance"
                  ? FINANCE_SYSTEM_PROMPT
                  : PAYROLL_MAPPING_SYSTEM_PROMPT,
          },
          { role: "user", content },
        ],
      },
      {
        signal: AbortSignal.any([
          AbortSignal.timeout(90_000),
          ...(options.signal ? [options.signal] : []),
        ]),
        maxRetries: 0,
      },
    );
    stage = "response";
    const receipt = await client.verifyResponse(completion.id);
    requireModelReceipt(receipt, completion.id);
    const wire = await client.capturedWire(completion.id);
    assertFreshDeployment(deployment, config.maxAttestationAgeMs);
    const output = completion.choices[0]?.message.content;
    if (!output || completion.choices[0]?.finish_reason !== "stop")
      throw new ApiError(
        502,
        task === "invoice"
          ? "The verified response did not finish an invoice extraction"
          : task === "finance"
            ? "The verified response did not finish a finance proposal"
            : "The verified response did not finish its column suggestions. Map columns manually",
        task === "invoice"
          ? "INVOICE_EXTRACTION_INCOMPLETE"
          : task === "finance"
            ? "FINANCE_PLAN_INCOMPLETE"
            : "IMPORT_SUGGESTION_INCOMPLETE",
      );
    return {
      content: output,
      verification: publicVerification(config.model, deployment, receipt),
      evidence: {
        deployment,
        receipt,
        wire: {
          request: {
            sha256: hashBytes(wire.requestBody),
            base64: encodeBase64(wire.requestBody),
          },
          response: {
            sha256: hashBytes(wire.responseBody),
            base64: encodeBase64(wire.responseBody),
          },
        },
        inputSha256: sha256(
          typeof content === "string" ? content : JSON.stringify(content),
        ),
        responseSha256: sha256(output),
        ...(images.length
          ? {
              imageSha256: images.map((image) =>
                createHash("sha256")
                  .update(Buffer.from(image.data, "base64"))
                  .digest("hex"),
              ),
              inputFormat: "image_parts",
            }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const sdk = getSdkError(error);
    const code = sdk?.failure.code ?? "unavailable";
    throw new ApiError(
      502,
      stage === "deployment"
        ? "Private model identity verification failed before input was sent"
        : stage === "response"
          ? "The private model response could not be verified. No proposal was accepted"
          : "NEAR AI Cloud did not complete private analysis",
      `PRIVATE_AI_${stage.toUpperCase()}_FAILED:${code}`,
    );
  } finally {
    client.clearResponseCache();
  }
}

export async function extractPrivateInvoice(
  text: string,
  images: InvoiceImage[] = [],
  sourceHash?: string,
  options: {
    createVerifiedSession?: EvidenceSessionFactory;
    signal?: AbortSignal;
  } = {},
) {
  if (sourceHash && !/^[a-f0-9]{64}$/.test(sourceHash))
    throw new ApiError(
      422,
      "The invoice source identity is invalid",
      "INVOICE_SOURCE_INVALID",
    );
  const source = sourceHash
    ? `Source document SHA-256: ${sourceHash}\n\n${text}`
    : text;
  const result = await runVerifiedPrivateInference(
    "invoice",
    source,
    images,
    options,
  );
  const extracted = parseExtraction(result.content);
  const draft = reviewExtraction(extracted, text);
  if (images.length)
    draft.warnings.push(
      "This draft includes image interpretation. Check every amount and line item against the original document",
    );
  return {
    draft,
    verification: result.verification,
    evidence: {
      ...result.evidence,
      ...(sourceHash ? { sourceDocumentSha256: sourceHash } : {}),
      extractionSha256: result.evidence.responseSha256,
      extracted,
    },
  };
}

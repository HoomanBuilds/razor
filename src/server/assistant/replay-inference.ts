import { createHash } from "node:crypto";
import { ApiError } from "../context";
import {
  INVOICE_SYSTEM_PROMPT,
  parseExtraction,
  reviewExtraction,
} from "./extraction";
import { invoiceMessageContent, type InvoiceImage } from "./client";
import { requirePrivateAiConfig } from "./config";
import {
  approveDeployment,
  assertFreshDeployment,
  publicVerification,
  requireModelReceipt,
  sha256,
} from "./verification";
import {
  ReplayEvidenceInferenceClient,
  type ReplayVerifiedSession,
} from "./replay-client";
import { encodeBase64, hashBytes } from "../../lib/verification/verify";
import {
  clearReplayDisclosure,
  type ReplayDisclosure,
  type ReplayExpectations,
} from "../../lib/private-inference-replay/schema";

export function createCompanyReplayInference(options: {
  acknowledgeSensitiveDisclosure: true;
  signal?: AbortSignal;
  createVerifiedSession?: (model: string) => Promise<ReplayVerifiedSession>;
}) {
  if (options.acknowledgeSensitiveDisclosure !== true)
    throw new Error("Explicit sensitive local replay disclosure is required");
  const controller = new AbortController();
  let retained: {
      disclosure: ReplayDisclosure;
      expectations: ReplayExpectations;
    } | null = null,
    used = false;
  const dispose = () => {
    controller.abort();
    clearReplayDisclosure(retained?.disclosure);
    retained = null;
  };
  return {
    async infer(
      text: string,
      images: InvoiceImage[] = [],
      sourceHash?: string,
    ) {
      if (used || controller.signal.aborted)
        throw new Error(
          "Start a new explicit local replay run for another invoice",
        );
      used = true;
      if (sourceHash && !/^[a-f0-9]{64}$/.test(sourceHash))
        throw new ApiError(
          422,
          "The invoice source identity is invalid",
          "INVOICE_SOURCE_INVALID",
        );
      const config = requirePrivateAiConfig(),
        source = sourceHash
          ? `Source document SHA-256: ${sourceHash}\n\n${text}`
          : text,
        content = invoiceMessageContent(source, images);
      const client = new ReplayEvidenceInferenceClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        e2ee: true,
        signingAlgo: "ed25519",
        acknowledgeSensitiveDisclosure: true,
        maxAttestationAgeMs: config.maxAttestationAgeMs,
        createVerifiedSession: options.createVerifiedSession,
        attestationCacheTimeToLiveMs: config.maxAttestationAgeMs,
        responseCacheTimeToLiveMs: 120000,
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
              "The verified model differs from the configured private model",
              "AI_MODEL_MISMATCH",
            );
        },
      });
      try {
        const deployment = await client.verify(config.model);
        assertFreshDeployment(deployment, config.maxAttestationAgeMs);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(90000),
          ...(options.signal ? [options.signal] : []),
        ]);
        const completion = await client.chat.completions.create(
          {
            model: config.model,
            temperature: 0,
            max_tokens: 4000,
            response_format: { type: "json_object" },
            stream: false,
            messages: [
              { role: "system", content: INVOICE_SYSTEM_PROMPT },
              { role: "user", content },
            ],
          },
          { signal, maxRetries: 0 },
        );
        const receipt = await client.verifyResponse(completion.id);
        requireModelReceipt(receipt, completion.id);
        assertFreshDeployment(deployment, config.maxAttestationAgeMs);
        const output = completion.choices[0]?.message.content;
        if (!output || completion.choices[0]?.finish_reason !== "stop")
          throw new ApiError(
            502,
            "The verified response did not complete invoice extraction",
            "INVOICE_EXTRACTION_INCOMPLETE",
          );
        const extracted = parseExtraction(output),
          draft = reviewExtraction(extracted, text),
          wire = await client.capturedWire(completion.id);
        if (images.length)
          draft.warnings.push(
            "This draft includes image interpretation. Check every amount and line item against the original document",
          );
        retained = client.takeReplayDisclosure(completion.id);
        return {
          draft,
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
            ...(sourceHash ? { sourceDocumentSha256: sourceHash } : {}),
            extractionSha256: sha256(output),
            extracted,
          },
        };
      } catch (error) {
        dispose();
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          502,
          "Local replay inference or required verification failed. No sensitive disclosure was exported and no plaintext fallback was used",
          "PRIVATE_REPLAY_FAILED",
        );
      } finally {
        client.clearResponseCache();
      }
    },
    takeDisclosure() {
      if (!retained)
        throw new Error("No verified local replay disclosure is available");
      const value = retained;
      retained = null;
      return value;
    },
    dispose,
  };
}

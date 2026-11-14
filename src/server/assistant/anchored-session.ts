/*
 * MIT License. Copyright (c) 2026 NEAR AI.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  AttestationClient,
  createPinnedTlsFetch,
  verifyGatewayAttestation,
  verifyModelAttestation,
  verifyModelResponse,
  NO_ALIASING_HEADER,
  type AttestationVerificationResult,
  type CompletionSignature,
  type GatewayAttestation,
  type ModelAttestation,
  type VerifiedModelCompletionResult,
} from "@nearai/inference-sdk/node";
import { z } from "zod";
import { hashText } from "../../lib/verification/verify";
import {
  inferenceAnchorChallengeSchema,
  inferenceAnchorTrustSchema,
  type InferenceAnchorChallenge,
  type InferenceAnchorTrust,
} from "../../lib/verification/inference-anchors";
import { inferenceAnchorObserver } from "../../lib/verification/inference-anchors-rpc";
import { supportedRuntime } from "./config";

const BASE = "https://cloud-api.near.ai/v1/";
const text = z.string().max(500_000);
const hex32 = z.string().regex(/^(?:0x)?[a-fA-F0-9]{64}$/);
const optionalText = text.nullish().transform((value) => value ?? undefined);
const eventLog = z.union([text, z.array(z.unknown()).max(2000)]);
const composeInfo = z.object({ app_compose: text }).strip();
const managerAction = z
  .object({
    action: z.string().max(100_000),
    timestamp: z.string().max(256),
    image: z.string().max(100_000).optional(),
    commit: z.string().max(100_000).optional(),
    file: z.string().max(100_000).optional(),
    file_sha256: z.string().max(256).optional(),
    services: z.array(z.string().max(100_000)).max(1000).optional(),
  })
  .catchall(
    z.union([
      z.string().max(100_000),
      z.array(z.string().max(100_000)).max(1000),
    ]),
  );
const composeManager = z
  .object({
    actions: z.array(managerAction).max(2000),
    actions_hash: z.string().max(256),
    nonce: z.string().max(256),
    quote: text,
    event_log: eventLog,
    report_data: optionalText,
  })
  .strip()
  .nullish();
const rawEvidence = z
  .object({
    request_nonce: hex32,
    signing_algo: z.literal("ed25519"),
    signing_address: hex32,
    intel_quote: text,
    event_log: eventLog,
    info: z
      .object({
        tcb_info: z.union([
          composeInfo,
          text.transform((value) => composeInfo.parse(JSON.parse(value))),
        ]),
      })
      .strip(),
    tls_cert_fingerprint: hex32.nullish(),
    report_data: optionalText,
  })
  .strip();
const rawModel = rawEvidence
  .extend({
    signing_public_key: hex32,
    nvidia_payload: text,
    compose_manager_attestation: composeManager,
  })
  .strip();
const rawGateway = rawEvidence
  .extend({ report_data: text, tls_cert_fingerprint: hex32 })
  .strip();
const ohttp = z
  .object({
    signing_algo: z.literal("ed25519"),
    signing_key: hex32,
    key_config: z
      .string()
      .min(2)
      .max(20_000)
      .regex(/^(?:0x)?(?:[a-fA-F0-9]{2})+$/),
    signature: z.string().regex(/^(?:0x)?[a-fA-F0-9]{128}$/),
  })
  .strip()
  .nullish();

function reportBase(value: z.infer<typeof rawEvidence>) {
  return {
    nonce: value.request_nonce.toLowerCase().replace(/^0x/, ""),
    signer: {
      signingAlgo: value.signing_algo,
      signingAddress: value.signing_address,
    },
    intelQuote: value.intel_quote,
    eventLog: value.event_log,
    appCompose: value.info.tcb_info.app_compose,
  };
}

function modelReport(value: z.infer<typeof rawModel>): ModelAttestation {
  const manager = value.compose_manager_attestation;
  return {
    ...reportBase(value),
    signingPublicKey: value.signing_public_key,
    nvidiaPayload: value.nvidia_payload,
    ...(value.report_data ? { reportedQuoteData: value.report_data } : {}),
    ...(manager
      ? {
          composeManagerAttestation: {
            actions: manager.actions,
            actionsHash: manager.actions_hash,
            nonce: manager.nonce,
            intelQuote: manager.quote,
            eventLog: manager.event_log,
            ...(manager.report_data
              ? { reportedQuoteData: manager.report_data }
              : {}),
          },
        }
      : {}),
  };
}

async function boundedBody(response: Response, maximum = 8 * 1024 * 1024) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error("Anchored attestation service unavailable");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw Error("Anchored response exceeds its bound");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

async function boundedJson(response: Response) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBody(response),
    ),
  ) as unknown;
}

class ChallengeAttestationClient extends AttestationClient {
  async gateway(nonce: string) {
    const url = new URL("attestation/report", BASE);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("signing_algo", "ed25519");
    url.searchParams.set("include_tls_fingerprint", "true");
    const response = await this.requestGatewayAttestation(
      new Request(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(30_000),
        headers: { accept: "application/json" },
      }),
      true,
    );
    if (!response.peerSpkiFingerprint) {
      await response.response.body?.cancel();
      throw Error("Original TLS SPKI observation is required");
    }
    const body = z
      .object({ gateway_attestation: rawGateway, ohttp_attestation: ohttp })
      .strip()
      .parse(await boundedJson(response.response));
    const raw = body.gateway_attestation,
      gateway: GatewayAttestation = {
        ...reportBase(raw),
        reportedQuoteData: raw.report_data,
        spkiFingerprint: raw.tls_cert_fingerprint,
        ...(body.ohttp_attestation
          ? {
              ohttpAttestation: {
                signingAlgo: body.ohttp_attestation.signing_algo,
                signingKey: body.ohttp_attestation.signing_key,
                keyConfig: body.ohttp_attestation.key_config,
                signature: body.ohttp_attestation.signature,
              },
            }
          : {}),
      };
    if (gateway.nonce !== nonce)
      throw Error("Gateway did not return the selected chain challenge");
    return { gateway, peerSpkiFingerprint: response.peerSpkiFingerprint };
  }
}

export interface AnchoredSessionEvidence {
  challenge: InferenceAnchorChallenge;
  gatewayReport: GatewayAttestation;
  modelReports: ModelAttestation[];
  originalGatewaySpki: string;
}

export interface AnchoredVerifiedSession {
  attestationResult: AttestationVerificationResult;
  modelKey: { signingAlgo: "ed25519"; publicKey: string };
  transport: {
    fetch: typeof fetch;
    fetchCompletionSignature: (params: {
      completionId: string;
      signingAlgo?: "ed25519" | "ecdsa";
    }) => Promise<CompletionSignature>;
  };
  verifyResponse: (params: {
    id: string;
    requestBody: Uint8Array;
    responseBody: Uint8Array;
    signature: CompletionSignature;
  }) => VerifiedModelCompletionResult;
}

export function createAnchoredSessionFactory(options: {
  challenge: InferenceAnchorChallenge;
  trust: InferenceAnchorTrust;
  rpcUrl: string;
  apiKey: string;
  maxLocalAgeMs?: number;
  onEvidence?: (evidence: AnchoredSessionEvidence) => void;
}) {
  const challenge = inferenceAnchorChallengeSchema.parse(options.challenge),
    trust = inferenceAnchorTrustSchema.parse(options.trust);
  if (
    !supportedRuntime() ||
    !options.apiKey.trim() ||
    challenge.network !== trust.network ||
    challenge.contractId !== trust.contractId ||
    challenge.contextHash !== trust.contextHash ||
    challenge.challenge.signerId !== trust.recorder
  )
    throw Error(
      "Anchored session requires a supported company process and independently reviewed matching challenge trust",
    );
  const localAge =
    options.maxLocalAgeMs ?? Math.min(trust.maxIntervalMs, 120_000);
  if (
    !Number.isSafeInteger(localAge) ||
    localAge < 1000 ||
    localAge > trust.maxIntervalMs
  )
    throw Error(
      "Choose a bounded local session age within the independent anchor interval",
    );
  let created = false;
  return async (model: string): Promise<AnchoredVerifiedSession> => {
    if (created || model !== trust.expectedModel)
      throw Error(
        "Use a new independently verified chain challenge for each anchored session",
      );
    created = true;
    const observed = await inferenceAnchorObserver(options.rpcUrl).challenge(
      trust,
      challenge.challenge,
      challenge.salt,
    );
    if (observed.challenge.nonce !== challenge.nonce)
      throw Error(
        "The retained challenge nonce does not match final chain execution",
      );
    const timestamp = Number(
        BigInt(observed.observation.timestampNs) / 1_000_000n,
      ),
      clockAge = Date.now() - timestamp;
    if (
      !Number.isSafeInteger(timestamp) ||
      clockAge < -10_000 ||
      clockAge > trust.maxIntervalMs
    )
      throw Error(
        "The selected challenge is outside the conservative local collection window",
      );
    const { gateway, peerSpkiFingerprint } =
      await new ChallengeAttestationClient().gateway(challenge.nonce);
    const gatewayVerified = await verifyGatewayAttestation({
      attestation: gateway,
      clientBinding: {
        nonce: challenge.nonce,
        spkiFingerprint: peerSpkiFingerprint,
      },
      policy: { acceptedTcbStatuses: trust.acceptedTcbStatuses },
    });
    if (
      gatewayVerified.tlsBinding.kind !== "attested" ||
      gatewayVerified.signer.signingAlgo !== "ed25519" ||
      !trust.approvedGatewayComposeSha256.includes(
        hashText(gatewayVerified.deployment.appCompose),
      )
    )
      throw Error(
        "Anchored Gateway identity or approved measurement is unavailable",
      );
    const nativePinned = createPinnedTlsFetch(peerSpkiFingerprint);
    let calls = 0,
      selectedPublicKey: string | undefined;
    const pinned: typeof fetch = async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      const completion =
        request.method === "POST" && url.pathname === "/v1/chat/completions";
      const evidenceRead =
        request.method === "GET" &&
        (url.pathname === "/v1/attestation/report" ||
          url.pathname.startsWith("/v1/signature/") ||
          url.pathname === `/v1/model/${encodeURIComponent(model)}`);
      if (
        ++calls > 12 ||
        url.origin !== new URL(BASE).origin ||
        (!completion && !evidenceRead) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Error(
          "Anchored inference transport rejected an endpoint outside its fixed pinned origin",
        );
      if (
        completion &&
        (!selectedPublicKey ||
          request.headers.get("x-model-pub-key") !== selectedPublicKey ||
          request.headers.get("x-signing-algo") !== "ed25519" ||
          request.headers.get("x-encryption-version") !== "3" ||
          request.headers.get("x-encrypt-all-fields") !== "true" ||
          request.headers.get(NO_ALIASING_HEADER) !== "true" ||
          !hex32.safeParse(request.headers.get("x-client-pub-key")).success)
      )
        throw Error(
          "Anchored inference requires the selected model's complete SDK v3 field encryption",
        );
      if (
        Date.now() - gatewayVerifiedAt > localAge ||
        Date.now() < gatewayVerifiedAt ||
        Date.now() - timestamp > trust.maxIntervalMs
      )
        throw Error(
          "Anchored session expired locally; no unverified transport fallback is allowed",
        );
      const response = await nativePinned(
        new Request(request, {
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(90_000),
          ]),
        }),
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw Error("Pinned inference redirects are not allowed");
      }
      const bytes = await boundedBody(
        response,
        completion
          ? 24 * 1024 * 1024
          : url.pathname === "/v1/attestation/report"
            ? 8 * 1024 * 1024
            : 256 * 1024,
      );
      const headers = new Headers(response.headers);
      for (const key of [
        "content-length",
        "content-encoding",
        "transfer-encoding",
      ])
        headers.delete(key);
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
    const gatewayVerifiedAt = Date.now();
    const client = new AttestationClient({
      baseUrl: BASE,
      apiKey: options.apiKey,
      fetch: pinned,
    });
    const metadata = await client.fetchModelMetadata(model);
    if (metadata.providerType !== "vllm" || !metadata.attestationSupported)
      throw Error(
        "Anchored inference requires a self-hosted attested model; Gateway-only models are unavailable",
      );
    const url = new URL("attestation/report", BASE);
    url.searchParams.set("model", model);
    url.searchParams.set("provider", "near");
    url.searchParams.set("nonce", challenge.nonce);
    url.searchParams.set("include_tls_fingerprint", "false");
    url.searchParams.set("signing_algo", "ed25519");
    const body = z
      .object({ model_attestations: z.array(rawModel).min(1).max(16) })
      .strip()
      .parse(
        await boundedJson(
          await pinned(url, {
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              [NO_ALIASING_HEADER]: "true",
            },
          }),
        ),
      );
    const reports = body.model_attestations.map(modelReport);
    if (
      reports.some((report) => report.nonce !== challenge.nonce) ||
      new Set(
        reports.map((report) =>
          report.signer.signingAddress.toLowerCase().replace(/^0x/, ""),
        ),
      ).size !== reports.length
    )
      throw Error(
        "Model report nonce or unique signer identity differs from the verified chain challenge",
      );
    const verified = await Promise.all(
      reports.map((attestation) =>
        verifyModelAttestation({
          attestation,
          clientBinding: { nonce: challenge.nonce },
          policy: {
            acceptedTcbStatuses: trust.acceptedTcbStatuses,
            gpuEvidence: "required",
          },
        }),
      ),
    );
    if (
      verified.some(
        (attestation) =>
          !trust.approvedModelComposeSha256.includes(
            hashText(attestation.deployment.appCompose),
          ) ||
          attestation.gpuEvidence !== "verified" ||
          !attestation.signingPublicKey,
      )
    )
      throw Error(
        "Model measured deployment or GPU evidence does not satisfy the independent policy",
      );
    const selected = verified[0];
    if (
      selected.signer.signingAlgo !== "ed25519" ||
      selected.signingPublicKey!.toLowerCase().replace(/^0x/, "") !==
        selected.signer.signingAddress.toLowerCase().replace(/^0x/, "")
    )
      throw Error(
        "Selected encryption key is not the quote-bound Ed25519 model signer",
      );
    selectedPublicKey = selected.signingPublicKey!;
    options.onEvidence?.({
      challenge,
      gatewayReport: gateway,
      modelReports: reports,
      originalGatewaySpki: peerSpkiFingerprint,
    });
    return {
      attestationResult: {
        gateway: gatewayVerified,
        models: verified,
        verifiedAt: gatewayVerifiedAt,
      },
      modelKey: {
        signingAlgo: "ed25519",
        publicKey: selected.signingPublicKey!,
      },
      transport: {
        fetch: pinned,
        fetchCompletionSignature: (params) =>
          client.fetchCompletionSignature(params),
      },
      verifyResponse: ({ id, requestBody, responseBody, signature }) => {
        if (
          signature.kind !== "provider_tee" ||
          signature.signer.signingAlgo !== "ed25519"
        )
          throw Error(
            "Only the selected model TEE may sign anchored inference",
          );
        verifyModelResponse({
          requestBody,
          responseBody,
          signature,
          attestation: selected,
        });
        if (
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(requestBody),
          ).model !== model ||
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(responseBody),
          ).id !== id
        )
          throw Error("Anchored signed request/response identity mismatch");
        const matches = verified.filter(
          (attestation) =>
            attestation.signer.signingAlgo === signature.signer.signingAlgo &&
            attestation.signer.signingAddress
              .toLowerCase()
              .replace(/^0x/, "") ===
              signature.signer.signingAddress.toLowerCase().replace(/^0x/, ""),
        );
        return {
          id,
          completionId: id,
          signatureKind: "provider_tee",
          signature,
          attestations: matches,
          attestation: selected,
        };
      },
    };
  };
}

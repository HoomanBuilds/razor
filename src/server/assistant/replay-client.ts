import type {
  InferenceClientOptions,
  VerifiedModelCompletionResult,
} from "@nearai/inference-sdk/node";
import { EvidenceInferenceClient } from "./capture";
import { assertFreshDeployment, requireModelReceipt } from "./verification";
import { ApiError } from "../context";
import {
  parseReplayWireResponse,
  prepareReplayRequest,
  readReplayBody,
  replayHash,
} from "../../lib/private-inference-replay/codec";
import { REPLAY_MAX_RESPONSE_BYTES } from "../../lib/private-inference-replay/schema";

class ReplayTypeHook extends EvidenceInferenceClient {
  sessionType() {
    return this.createVerificationState;
  }
  captureType() {
    return this.registerResponse;
  }
}
export type ReplayVerifiedSession = Awaited<
  ReturnType<ReturnType<ReplayTypeHook["sessionType"]>>
>;
type Capture = Parameters<ReturnType<ReplayTypeHook["captureType"]>>[0];
type Prepared = Awaited<ReturnType<typeof prepareReplayRequest>>;
interface Retained {
  prepared: Prepared;
  response: Uint8Array;
  plaintextResponse: Uint8Array;
  originalRequestHash: string;
  session: ReplayVerifiedSession;
  receipt: VerifiedModelCompletionResult;
  release: () => void;
}
export type ReplayClientOptions = Omit<
  InferenceClientOptions,
  "e2ee" | "signingAlgo"
> & {
  e2ee: true;
  signingAlgo: "ed25519";
  acknowledgeSensitiveDisclosure: true;
  maxAttestationAgeMs: number;
  createVerifiedSession?: (model: string) => Promise<ReplayVerifiedSession>;
};

export class ReplayEvidenceInferenceClient extends EvidenceInferenceClient {
  private readonly retained = new Map<string, Retained>();
  private readonly pending = new Set<Prepared>();
  private readonly freshness: number;
  private readonly sessionFactory: ReplayClientOptions["createVerifiedSession"];
  private readonly verificationPolicy: Pick<
    InferenceClientOptions,
    "gatewayVerification" | "modelVerification" | "deploymentPolicy"
  >;
  private used = false;
  constructor(options: ReplayClientOptions) {
    const {
      acknowledgeSensitiveDisclosure,
      maxAttestationAgeMs,
      createVerifiedSession,
      ...sdk
    } = options;
    if (
      acknowledgeSensitiveDisclosure !== true ||
      sdk.e2ee !== true ||
      sdk.signingAlgo !== "ed25519" ||
      !Number.isInteger(maxAttestationAgeMs) ||
      maxAttestationAgeMs < 10000 ||
      maxAttestationAgeMs > 300000
    )
      throw new Error("Explicit bounded own-key replay disclosure is required");
    // The protected transport below always encrypts before the original verified fetch.
    super({ ...sdk, e2ee: false, signingAlgo: "ed25519" });
    this.freshness = maxAttestationAgeMs;
    this.sessionFactory = createVerifiedSession;
    this.verificationPolicy = {
      gatewayVerification: options.gatewayVerification,
      modelVerification: options.modelVerification,
      deploymentPolicy: options.deploymentPolicy,
    };
  }
  protected override async sendSystemOneRequest(
    _request: Request,
  ): Promise<Response> {
    throw new Error(
      "Private replay does not support System One or plaintext transports",
    );
  }
  protected override async createVerificationState(
    model: string,
  ): Promise<ReplayVerifiedSession> {
    const original = this.sessionFactory
      ? await this.sessionFactory(model)
      : await super.createVerificationState(model);
    assertFreshDeployment(original.attestationResult, this.freshness);
    const gatewayPolicy = this.verificationPolicy.gatewayVerification,
      modelPolicy = this.verificationPolicy.modelVerification;
    if (
      !(gatewayPolicy?.policy?.acceptedTcbStatuses || ["UpToDate"]).includes(
        original.attestationResult.gateway.tcbStatus,
      )
    )
      throw new Error(
        "The anchored Gateway TCB status is outside this client's policy",
      );
    await gatewayPolicy?.verifiers?.deployment?.(
      original.attestationResult.gateway.deployment,
    );
    for (const attestation of original.attestationResult.models) {
      if (
        !(modelPolicy?.policy?.acceptedTcbStatuses || ["UpToDate"]).includes(
          attestation.tcbStatus,
        )
      )
        throw new Error(
          "The anchored model TCB status is outside this client's policy",
        );
      await modelPolicy?.verifiers?.deployment?.(attestation.deployment);
      await this.verificationPolicy.deploymentPolicy?.({
        model,
        deployment: attestation.deployment,
      });
    }
    if (
      !original.modelKey ||
      original.modelKey.signingAlgo !== "ed25519" ||
      !original.attestationResult.models.some(
        (value) => value.signingPublicKey === original.modelKey!.publicKey,
      )
    )
      throw new Error(
        "Private replay requires the exact verified Ed25519 model key",
      );
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (this.used)
        throw new Error(
          "A replay client supports exactly one explicit nonstream completion",
        );
      this.used = true;
      const request = new Request(input, init),
        url = new URL(request.url),
        base = new URL(this.getBaseUrl());
      if (
        request.method !== "POST" ||
        url.origin !== base.origin ||
        url.search ||
        !url.pathname.endsWith("/chat/completions")
      )
        throw new Error(
          "Private replay supports only the configured Chat Completions endpoint",
        );
      assertFreshDeployment(original.attestationResult, this.freshness);
      request.signal.throwIfAborted();
      const prepared = await prepareReplayRequest(
        request,
        original.modelKey!.publicKey,
      );
      this.pending.add(prepared);
      const release = () => {
        prepared.dispose();
      };
      request.signal.addEventListener("abort", release, { once: true });
      try {
        if (
          JSON.parse(new TextDecoder().decode(prepared.requestBytes)).model !==
          model
        )
          throw new Error("The replay request changed verified models");
        const response = await original.transport.fetch(prepared.request);
        if (
          !response.ok ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          await response.body?.cancel().catch(() => {});
          throw new Error(
            "A supported encrypted JSON response was not returned",
          );
        }
        const responseBytes = await readReplayBody(
            response,
            REPLAY_MAX_RESPONSE_BYTES,
          ),
          encrypted = parseReplayWireResponse(responseBytes);
        request.signal.throwIfAborted();
        if (encrypted.model !== model || this.retained.has(encrypted.id))
          throw new Error("The encrypted model response context changed");
        const signature = await original.transport.fetchCompletionSignature({
          completionId: encrypted.id,
          signingAlgo: "ed25519",
        });
        const receipt = await original.verifyResponse({
          id: encrypted.id,
          requestBody: prepared.requestBytes,
          responseBody: responseBytes,
          signature,
        });
        requireModelReceipt(receipt, encrypted.id);
        assertFreshDeployment(original.attestationResult, this.freshness);
        request.signal.throwIfAborted();
        if (receipt.signature.signer.signingAlgo !== "ed25519")
          throw new Error("A provider model Ed25519 signature is required");
        const plaintext = prepared.decryptResponse(responseBytes),
          plaintextResponse = new TextEncoder().encode(
            JSON.stringify(plaintext),
          );
        this.retained.set(encrypted.id, {
          prepared,
          response: responseBytes,
          plaintextResponse,
          originalRequestHash: replayHash(prepared.originalBytes),
          session: original,
          receipt,
          release: () => {
            request.signal.removeEventListener("abort", release);
            release();
            plaintextResponse.fill(0);
          },
        });
        this.pending.delete(prepared);
        const headers = new Headers(response.headers);
        for (const name of [
          "content-length",
          "content-encoding",
          "content-md5",
          "etag",
          "digest",
        ])
          headers.delete(name);
        headers.set("content-type", "application/json");
        return new Response(plaintextResponse, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        request.signal.removeEventListener("abort", release);
        release();
        this.pending.delete(prepared);
        this.clearResponseCache();
        throw new ApiError(
          502,
          "The encrypted replay request or verified model response could not be completed. No replay success or plaintext transport fallback was accepted",
          "PRIVATE_REPLAY_FAILED",
        );
      }
    };
    return { ...original, transport: { ...original.transport, fetch } };
  }
  protected override registerResponse(
    captured: Capture,
    generation: number,
  ): void {
    if (generation !== this.responseCacheGeneration) return;
    const value = this.retained.get(captured.id);
    if (
      !value ||
      replayHash(captured.requestBody) !== value.originalRequestHash
    )
      throw new Error("The SDK replay capture changed request context");
    captured.requestBody.fill(0);
    const encrypted = captured.responseBody.then((plaintext) => {
      try {
        if (replayHash(plaintext) !== replayHash(value.plaintextResponse))
          throw new Error("The SDK replay capture changed response context");
        return value.response;
      } finally {
        plaintext.fill(0);
        value.plaintextResponse.fill(0);
      }
    });
    void encrypted.catch(() => {});
    super.registerResponse(
      {
        ...captured,
        requestBody: value.prepared.requestBytes,
        responseBody: encrypted,
        session: value.session,
      },
      generation,
    );
  }
  takeReplayDisclosure(id: string) {
    const value = this.retained.get(id);
    if (!value)
      throw new Error(
        "No verified replay secrets were retained for this completion",
      );
    try {
      return {
        disclosure: value.prepared.disclosure(id, value.response),
        expectations: value.prepared.expectations(value.response),
      };
    } finally {
      value.release();
      this.retained.delete(id);
    }
  }
  override clearResponseCache(): void {
    for (const pending of this.pending) pending.dispose();
    this.pending.clear();
    for (const value of this.retained.values()) value.release();
    this.retained.clear();
    super.clearResponseCache();
  }
}

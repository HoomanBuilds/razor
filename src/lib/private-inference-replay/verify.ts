import nacl from "tweetnacl";
import { base64 } from "@scure/base";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  portablePacketSchema,
  type VerificationClaim,
} from "../verification/packet";
import {
  decryptRequestField,
  decryptResponseField,
  normalizeReplayKey,
  parseReplayWireRequest,
  parseReplayWireResponse,
  replayHash,
  replayKeyBytes,
  responseEncryptedFields,
  verifyReplySecret,
} from "./codec";
import {
  clearReplayDisclosure,
  REPLAY_MAX_REQUEST_BYTES,
  REPLAY_MAX_RESPONSE_BYTES,
  replayDisclosureSchema,
  replayExpectationsSchema,
  type ReplayFieldPath,
} from "./schema";

export function verifyPrivateInferenceReplay(
  packetInput: unknown,
  disclosureInput: unknown,
  expectationsInput: unknown,
) {
  const claims: VerificationClaim[] = [],
    add = (
      claim: string,
      status: VerificationClaim["status"],
      detail: string,
    ) => claims.push({ claim, status, detail });
  const packetResult = portablePacketSchema.safeParse(packetInput),
    keysResult = replayDisclosureSchema.safeParse(disclosureInput),
    expectedResult = replayExpectationsSchema.safeParse(expectationsInput);
  if (!packetResult.success || !keysResult.success || !expectedResult.success) {
    add(
      "local_replay_format",
      "failed",
      "A bounded supported packet, explicit local secret disclosure and separate expected model/plaintext digests are required. Unsupported fields and algorithms are rejected.",
    );
    return {
      claims,
      coverage: {
        replayedFields: 0,
        expectedFields: 0,
        totalWireFields: 0,
        complete: false,
      },
    };
  }
  const packet = packetResult.data,
    disclosure = keysResult.data,
    expected = expectedResult.data,
    requestKeys = new Map(
      disclosure.requestFields.map((field) => [
        field.path,
        field.ephemeralSecretHex,
      ]),
    );
  let request: Uint8Array | undefined,
    response: Uint8Array | undefined,
    replySecret: Uint8Array | undefined,
    replayedFields = 0,
    totalWireFields = 0;
  const fieldChecks = new Map<
    ReplayFieldPath,
    { ciphertext: string; request: boolean }
  >();
  try {
    const inference = packet.inference;
    if (!inference?.request?.base64 || !inference.response?.base64) {
      add(
        "local_replay_wire_bytes",
        "unavailable",
        "Both actual original encrypted wire bodies are required. Metadata-only or redacted wire exports cannot be replayed from hashes.",
      );
      return {
        claims,
        coverage: {
          replayedFields,
          expectedFields: expected.fields.length,
          totalWireFields,
          complete: false,
        },
      };
    }
    if (
      inference.request.base64.length >
        Math.ceil(REPLAY_MAX_REQUEST_BYTES / 3) * 4 ||
      inference.response.base64.length >
        Math.ceil(REPLAY_MAX_RESPONSE_BYTES / 3) * 4
    )
      throw new Error("Wire bound");
    request = base64.decode(inference.request.base64);
    response = base64.decode(inference.response.base64);
    const requestHash = replayHash(request),
      responseHash = replayHash(response);
    if (
      requestHash !== inference.request.sha256 ||
      requestHash !== disclosure.requestWireSha256 ||
      requestHash !== expected.requestWireSha256 ||
      responseHash !== inference.response.sha256 ||
      responseHash !== disclosure.responseWireSha256 ||
      responseHash !== expected.responseWireSha256
    )
      throw new Error("Wire hash mismatch");
    const encryptedRequest = parseReplayWireRequest(request),
      encryptedResponse = parseReplayWireResponse(response),
      modelKey = normalizeReplayKey(expected.modelSigningPublicKey),
      signature = inference.signature;
    if (
      inference.model !== expected.model ||
      disclosure.model !== expected.model ||
      encryptedRequest.model !== expected.model ||
      encryptedResponse.model !== expected.model ||
      inference.completionId !== disclosure.completionId ||
      inference.completionId !== encryptedResponse.id ||
      normalizeReplayKey(disclosure.context.modelPublicKey) !== modelKey
    )
      throw new Error("Context mismatch");
    if (
      !signature ||
      signature.kind !== "provider_tee" ||
      signature.signer.signingAlgo !== "ed25519" ||
      normalizeReplayKey(signature.signer.signingAddress) !== modelKey ||
      signature.signedText !==
        `${expected.model}:${requestHash}:${responseHash}`
    )
      throw new Error("Model signature context");
    const signatureHex = signature.signature.replace(/^0x/i, "");
    if (
      !/^[a-fA-F0-9]{128}$/.test(signatureHex) ||
      !nacl.sign.detached.verify(
        new TextEncoder().encode(signature.signedText),
        hexToBytes(signatureHex),
        replayKeyBytes(expected.modelSigningPublicKey),
      )
    )
      throw new Error("Model signature");
    if (
      !inference.modelReports.some(
        (report) =>
          report.signer.signingAlgo === "ed25519" &&
          normalizeReplayKey(report.signer.signingAddress) === modelKey &&
          report.signingPublicKey &&
          normalizeReplayKey(report.signingPublicKey) === modelKey,
      )
    )
      throw new Error("Reported model encryption identity");
    add(
      "local_replay_signed_wire",
      "passed",
      "Actual wire bytes, hashes, model, completion ID and provider_tee Ed25519 signature match the separately supplied expected model signing key. Hardware trust and historical freshness remain separate checks.",
    );
    encryptedRequest.messages.forEach((message, index) =>
      fieldChecks.set(`messages[${index}].content` as ReplayFieldPath, {
        ciphertext: message.content,
        request: true,
      }),
    );
    for (const field of responseEncryptedFields(encryptedResponse))
      fieldChecks.set(field.path, {
        ciphertext: field.ciphertext,
        request: false,
      });
    totalWireFields = fieldChecks.size;
    if (disclosure.clientReplySecretHex) {
      replySecret = hexToBytes(disclosure.clientReplySecretHex);
      verifyReplySecret(replySecret, disclosure.context.clientPublicKey);
    }
    for (const field of expected.fields) {
      const wire = fieldChecks.get(field.path);
      if (!wire) {
        add(
          `local_replay:${field.path}`,
          "failed",
          "The separately expected field does not exist in this supported signed transcript.",
        );
        continue;
      }
      const requestSecret = wire.request
        ? requestKeys.get(
            field.path as "messages[0].content" | "messages[1].content",
          )
        : undefined;
      if ((wire.request && !requestSecret) || (!wire.request && !replySecret)) {
        add(
          `local_replay:${field.path}`,
          "unavailable",
          "The explicit disclosure redacted this field's replay secret. No plaintext match is claimed.",
        );
        continue;
      }
      let secret: Uint8Array | undefined, plaintext: Uint8Array | undefined;
      try {
        if (wire.request) {
          secret = hexToBytes(requestSecret!);
          plaintext = decryptRequestField(
            wire.ciphertext,
            secret,
            expected.modelSigningPublicKey,
            disclosure.context.clientPublicKey,
          );
        } else
          plaintext = decryptResponseField(
            wire.ciphertext,
            replySecret!,
            disclosure.context.clientPublicKey,
          );
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        const equal = replayHash(plaintext) === field.sha256;
        if (equal) replayedFields++;
        add(
          `local_replay:${field.path}`,
          equal ? "passed" : "failed",
          wire.request
            ? "Derived the disclosed ephemeral public key and matched the request envelope, derived the shared key against the separately expected model key, checked protocol/client/field AAD and AEAD, then compared the exact plaintext bytes with the separately supplied digest."
            : wire.ciphertext === ""
              ? "The signed response field is empty. Its empty UTF-8 digest is compared; the protocol has no AEAD envelope for this empty-field case."
              : "The client reply secret matches the converted request client Ed25519 public key. Protocol response decryption uses no AAD; AEAD and the separately supplied exact plaintext digest were checked.",
        );
      } catch {
        add(
          `local_replay:${field.path}`,
          "failed",
          "Replay failed: secret/public-key binding, model-bound derivation, protocol AEAD, UTF-8 or independently expected plaintext digest did not match.",
        );
      } finally {
        secret?.fill(0);
        plaintext?.fill(0);
      }
    }
    const complete =
      replayedFields === expected.fields.length &&
      replayedFields === totalWireFields;
    add(
      "local_replay_coverage",
      complete ? "passed" : "not_checked",
      complete
        ? "Every supported signed content field in these exact wire bodies matched a separately supplied expected plaintext digest."
        : `${replayedFields} of ${totalWireFields} signed content fields were replayed against supplied expectations. Redacted keys, omitted expectations and unsupported material carry no plaintext-binding claim.`,
    );
    add(
      "local_replay_hardware_identity",
      "not_checked",
      "This pure local replay does not validate Intel/NVIDIA collateral, deployment measurements, TLS peer identity or historical freshness. The expected model key must come from an independent trust decision, not a packet-provided allowlist.",
    );
    add(
      "local_replay_invoice_truth",
      "not_checked",
      "A plaintext byte match does not establish factual invoice correctness, the accuracy of model conclusions, authorization of a payment or destination settlement. Header context is retained for protocol binding; the body signature does not independently authenticate all HTTP headers.",
    );
    add(
      "local_replay_key_disclosure_scope",
      "not_checked",
      "Request ephemeral secrets disclose their individual fields. The client reply secret unlocks all supported response content fields, including reasoning/refusal fields, even when only selected plaintext digests are compared. Omitting expectations does not restrict a key holder's decryption access.",
    );
    return {
      claims,
      coverage: {
        replayedFields,
        expectedFields: expected.fields.length,
        totalWireFields,
        complete,
      },
    };
  } catch {
    add(
      "local_replay_required_context",
      "failed",
      "Replay rejected changed/redacted wire bytes, unsupported protocol, mismatched context/model key, invalid model signature or reply-key binding. No decrypted-content success is claimed.",
    );
    return {
      claims,
      coverage: {
        replayedFields: 0,
        expectedFields: expected.fields.length,
        totalWireFields,
        complete: false,
      },
    };
  } finally {
    request?.fill(0);
    response?.fill(0);
    replySecret?.fill(0);
    clearReplayDisclosure(disclosure);
  }
}

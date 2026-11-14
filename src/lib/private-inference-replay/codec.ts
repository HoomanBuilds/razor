// Adapted from @nearai/inference-sdk 0.3.0 E2EE v3. See LICENSE.nearai-inference-sdk.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import ed2curve from "ed2curve";
import nacl from "tweetnacl";
import { z } from "zod";
import {
  REPLAY_MAX_PLAINTEXT_BYTES,
  REPLAY_MAX_REQUEST_BYTES,
  REPLAY_MAX_RESPONSE_BYTES,
  replayDisclosureSchema,
  type ReplayDisclosure,
  type ReplayExpectations,
  type ReplayFieldPath,
} from "./schema";

export const replayHash = (value: Uint8Array) => bytesToHex(sha256(value));
const utf8 = (value: string) => new TextEncoder().encode(value);
const decoder = new TextDecoder("utf-8", { fatal: true });
const info = utf8("ed25519_encryption");
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(
    parts.reduce((sum, value) => sum + value.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
export const normalizeReplayKey = (value: string) =>
  value.replace(/^0x/i, "").toLowerCase();
export function replayKeyBytes(value: string) {
  if (!/^[a-f0-9]{64}$/.test(normalizeReplayKey(value)))
    throw new Error("Replay requires a 32-byte Ed25519 key");
  return hexToBytes(normalizeReplayKey(value));
}
export function modelCurveKey(value: string) {
  const converted = ed2curve.convertPublicKey(replayKeyBytes(value));
  if (!converted || converted.length !== 32)
    throw new Error("The model Ed25519 key cannot be converted");
  return converted;
}
function sharedKey(secret: Uint8Array, publicKey: Uint8Array) {
  const shared = nacl.scalarMult(secret, publicKey);
  try {
    if (shared.every((value) => value === 0))
      throw new Error("The replay shared secret is invalid");
    return hkdf(sha256, shared, undefined, info, 32);
  } finally {
    shared.fill(0);
  }
}
export function requestFieldAad(clientPublicKey: string) {
  modelCurveKey(clientPublicKey);
  return concat(
    utf8("nearai-e2ee-request-v3"),
    new Uint8Array([2]),
    replayKeyBytes(clientPublicKey),
    new Uint8Array([0]),
    utf8("messages[].content"),
  );
}
function envelope(value: string) {
  if (
    !/^[a-fA-F0-9]+$/.test(value) ||
    value.length % 2 ||
    value.length > REPLAY_MAX_REQUEST_BYTES * 2
  )
    throw new Error("The encrypted field is invalid");
  const bytes = hexToBytes(value);
  if (bytes.length < 72)
    throw new Error("The encrypted field envelope is too short");
  return {
    bytes,
    publicKey: bytes.subarray(0, 32),
    nonce: bytes.subarray(32, 56),
    ciphertext: bytes.subarray(56),
  };
}
export function decryptRequestField(
  ciphertext: string,
  secret: Uint8Array,
  modelPublicKey: string,
  clientPublicKey: string,
) {
  const encrypted = envelope(ciphertext),
    publicKey = nacl.scalarMult.base(secret);
  if (!nacl.verify(publicKey, encrypted.publicKey))
    throw new Error("The disclosed request secret does not match its envelope");
  const key = sharedKey(secret, modelCurveKey(modelPublicKey));
  try {
    return xchacha20poly1305(
      key,
      encrypted.nonce,
      requestFieldAad(clientPublicKey),
    ).decrypt(encrypted.ciphertext);
  } finally {
    key.fill(0);
  }
}
export function verifyReplySecret(secret: Uint8Array, clientPublicKey: string) {
  if (
    secret.length !== 32 ||
    !nacl.verify(nacl.scalarMult.base(secret), modelCurveKey(clientPublicKey))
  )
    throw new Error(
      "The response secret does not match the request client Ed25519 public key",
    );
}
export function decryptResponseField(
  ciphertext: string,
  secret: Uint8Array,
  clientPublicKey: string,
) {
  verifyReplySecret(secret, clientPublicKey);
  if (ciphertext === "") return new Uint8Array();
  const encrypted = envelope(ciphertext),
    key = sharedKey(secret, encrypted.publicKey);
  try {
    return xchacha20poly1305(key, encrypted.nonce).decrypt(
      encrypted.ciphertext,
    );
  } finally {
    key.fill(0);
  }
}
const parts = z
  .array(
    z.union([
      z
        .object({
          type: z.literal("text"),
          text: z.string().min(1).max(REPLAY_MAX_PLAINTEXT_BYTES),
        })
        .strict(),
      z
        .object({
          type: z.literal("image_url"),
          image_url: z
            .object({
              url: z
                .string()
                .max(REPLAY_MAX_PLAINTEXT_BYTES)
                .regex(
                  /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/,
                ),
              detail: z.literal("high"),
            })
            .strict(),
        })
        .strict(),
    ]),
  )
  .min(2)
  .max(9);
const requestSchema = z
  .object({
    model: z.string().min(1).max(256),
    temperature: z.literal(0),
    max_tokens: z.literal(4000),
    response_format: z.object({ type: z.literal("json_object") }).strict(),
    stream: z.literal(false),
    messages: z.tuple([
      z
        .object({
          role: z.literal("system"),
          content: z.string().min(1).max(REPLAY_MAX_PLAINTEXT_BYTES),
        })
        .strict(),
      z
        .object({
          role: z.literal("user"),
          content: z.union([
            z.string().min(1).max(REPLAY_MAX_PLAINTEXT_BYTES),
            parts,
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
const nullableText = z
  .string()
  .max(REPLAY_MAX_RESPONSE_BYTES * 2)
  .nullable()
  .optional();
const responseSchema = z
  .object({
    id: z.string().min(1).max(256),
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative(),
    model: z.string().min(1).max(256),
    choices: z.tuple([
      z
        .object({
          index: z.literal(0),
          message: z
            .object({
              role: z.literal("assistant"),
              content: z.string().max(REPLAY_MAX_RESPONSE_BYTES * 2),
              reasoning_content: nullableText,
              reasoning: nullableText,
              refusal: nullableText,
              tool_calls: z.array(z.never()).max(0).nullable().optional(),
              function_call: z.null().optional(),
              audio: z.null().optional(),
              annotations: z.array(z.never()).max(0).optional(),
            })
            .strict(),
          finish_reason: z.enum(["stop", "length", "content_filter"]),
          logprobs: z.null().optional(),
          stop_reason: z
            .union([z.string().max(100), z.number(), z.null()])
            .optional(),
        })
        .strict(),
    ]),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
        prompt_tokens_details: z
          .object({
            cached_tokens: z.number().int().nonnegative().optional(),
            audio_tokens: z.number().int().nonnegative().optional(),
          })
          .strict()
          .nullable()
          .optional(),
        completion_tokens_details: z
          .object({
            reasoning_tokens: z.number().int().nonnegative().optional(),
            audio_tokens: z.number().int().nonnegative().optional(),
            accepted_prediction_tokens: z
              .number()
              .int()
              .nonnegative()
              .optional(),
            rejected_prediction_tokens: z
              .number()
              .int()
              .nonnegative()
              .optional(),
          })
          .strict()
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
    system_fingerprint: z.string().max(256).nullable().optional(),
    service_tier: z.string().max(100).nullable().optional(),
    prompt_logprobs: z.null().optional(),
    kv_transfer_params: z.null().optional(),
  })
  .strict();
export function parseReplayWireRequest(bytes: Uint8Array) {
  if (bytes.length > REPLAY_MAX_REQUEST_BYTES)
    throw new Error("Encrypted replay request exceeds its limit");
  const value = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
  const encrypted = z
    .object({
      model: z.string(),
      temperature: z.literal(0),
      max_tokens: z.literal(4000),
      response_format: z.object({ type: z.literal("json_object") }).strict(),
      stream: z.literal(false),
      messages: z.tuple([
        z.object({ role: z.literal("system"), content: z.string() }).strict(),
        z.object({ role: z.literal("user"), content: z.string() }).strict(),
      ]),
    })
    .strict()
    .parse(value);
  for (const message of encrypted.messages) envelope(message.content);
  return encrypted;
}
export function parseReplayWireResponse(bytes: Uint8Array) {
  if (bytes.length > REPLAY_MAX_RESPONSE_BYTES)
    throw new Error("Encrypted replay response exceeds its limit");
  return responseSchema.parse(JSON.parse(decoder.decode(bytes)));
}
export function responseEncryptedFields(
  body: ReturnType<typeof parseReplayWireResponse>,
) {
  const message = body.choices[0].message;
  return (
    ["content", "reasoning_content", "reasoning", "refusal"] as const
  ).flatMap((field) =>
    typeof message[field] === "string"
      ? [
          {
            name: field,
            path: `choices[0].message.${field}` as ReplayFieldPath,
            ciphertext: message[field]!,
          },
        ]
      : [],
  );
}
export async function readReplayBody(
  source: Request | Response,
  maximum: number,
) {
  const reader = source.body?.getReader();
  if (!reader) throw new Error("The replay wire body is missing");
  const buffer = new Uint8Array(maximum + 1);
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      if (size + value.value.length > maximum)
        throw new Error("The replay wire body exceeds its limit");
      buffer.set(value.value, size);
      size += value.value.length;
    }
    return buffer.slice(0, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    buffer.fill(0);
    reader.releaseLock();
  }
}

export async function prepareReplayRequest(
  request: Request,
  modelPublicKey: string,
) {
  request.signal.throwIfAborted();
  if (
    request.method !== "POST" ||
    !new URL(request.url).pathname.endsWith("/chat/completions")
  )
    throw new Error("Replay supports only nonstream Chat Completions");
  const originalBytes = await readReplayBody(
    request.clone(),
    REPLAY_MAX_PLAINTEXT_BYTES,
  );
  let body: z.infer<typeof requestSchema>;
  try {
    const original = JSON.parse(decoder.decode(originalBytes));
    requestSchema.parse(original);
    body = original;
    request.signal.throwIfAborted();
  } catch (error) {
    originalBytes.fill(0);
    throw error;
  }
  let reply: ReturnType<typeof nacl.sign.keyPair>;
  try {
    reply = nacl.sign.keyPair();
  } catch (error) {
    originalBytes.fill(0);
    throw error;
  }
  let replySecret: Uint8Array | null = null;
  try {
    replySecret = ed2curve.convertSecretKey(reply.secretKey);
  } catch (error) {
    originalBytes.fill(0);
    throw error;
  } finally {
    reply.secretKey.fill(0);
  }
  if (!replySecret) {
    originalBytes.fill(0);
    throw new Error("The client reply key could not be converted");
  }
  const clientPublicKey = bytesToHex(reply.publicKey),
    responseSecret = replySecret;
  const retained: Array<{
      path: "messages[0].content" | "messages[1].content";
      secret: Uint8Array;
    }> = [],
    expectations: ReplayExpectations["fields"] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    responseSecret.fill(0);
    for (const field of retained) field.secret.fill(0);
    originalBytes.fill(0);
  };
  try {
    const aad = requestFieldAad(clientPublicKey),
      modelKey = modelCurveKey(modelPublicKey);
    const encrypted = {
      ...body,
      messages: body.messages.map((message, index) => {
        const plaintext = utf8(
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
          ),
          path = `messages[${index}].content` as
            | "messages[0].content"
            | "messages[1].content";
        let secret: Uint8Array | undefined, key: Uint8Array | undefined;
        try {
          secret = nacl.randomBytes(32);
          const publicKey = nacl.scalarMult.base(secret),
            nonce = nacl.randomBytes(24);
          key = sharedKey(secret, modelKey);
          const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(
            plaintext,
          );
          retained.push({ path, secret });
          expectations.push({ path, sha256: replayHash(plaintext) });
          return {
            ...message,
            content: bytesToHex(concat(publicKey, nonce, ciphertext)),
          };
        } catch (error) {
          secret?.fill(0);
          throw error;
        } finally {
          key?.fill(0);
          plaintext.fill(0);
        }
      }),
    };
    const bytes = utf8(JSON.stringify(encrypted));
    if (bytes.length > REPLAY_MAX_REQUEST_BYTES)
      throw new Error("Encrypted replay request exceeds its limit");
    const headers = new Headers(request.headers);
    for (const name of [
      "content-length",
      "content-encoding",
      "content-md5",
      "etag",
      "digest",
    ])
      headers.delete(name);
    headers.set("content-type", "application/json");
    headers.set("x-signing-algo", "ed25519");
    headers.set("x-client-pub-key", clientPublicKey);
    headers.set("x-model-pub-key", modelPublicKey);
    headers.set("x-encryption-version", "3");
    headers.set("x-no-aliasing", "true");
    headers.set("x-encrypt-all-fields", "true");
    return {
      request: new Request(request, { headers, body: bytes }),
      requestBytes: bytes,
      originalBytes,
      dispose,
      decryptResponse(responseBytes: Uint8Array) {
        if (disposed) throw new Error("Replay keys were cleared");
        const response = parseReplayWireResponse(responseBytes),
          message = { ...response.choices[0].message };
        for (const field of responseEncryptedFields(response)) {
          const plaintext = decryptResponseField(
            field.ciphertext,
            responseSecret,
            clientPublicKey,
          );
          try {
            message[field.name] = decoder.decode(plaintext);
            expectations.push({
              path: field.path,
              sha256: replayHash(plaintext),
            });
          } finally {
            plaintext.fill(0);
          }
        }
        return { ...response, choices: [{ ...response.choices[0], message }] };
      },
      disclosure(
        completionId: string,
        responseBytes: Uint8Array,
      ): ReplayDisclosure {
        if (disposed) throw new Error("Replay keys were cleared");
        return replayDisclosureSchema.parse({
          schema: "razor.private-inference-replay-keys",
          version: 1,
          codec: "nearai-sdk-0.3.0-ed25519-chat-v3",
          sensitive: true,
          model: body.model,
          completionId,
          requestWireSha256: replayHash(bytes),
          responseWireSha256: replayHash(responseBytes),
          context: {
            signingAlgo: "ed25519",
            clientPublicKey,
            modelPublicKey,
            encryptionVersion: "3",
            noAliasing: "true",
            encryptAllFields: "true",
          },
          requestFields: retained.map((field) => ({
            path: field.path,
            ephemeralSecretHex: bytesToHex(field.secret),
          })),
          clientReplySecretHex: bytesToHex(responseSecret),
        });
      },
      expectations(responseBytes: Uint8Array): ReplayExpectations {
        return {
          schema: "razor.private-inference-replay-expectations",
          version: 1,
          model: body.model,
          modelSigningPublicKey: modelPublicKey,
          requestWireSha256: replayHash(bytes),
          responseWireSha256: replayHash(responseBytes),
          fields: expectations.map((value) => ({ ...value })),
        };
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

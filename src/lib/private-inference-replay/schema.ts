import { z } from "zod";

export const REPLAY_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
export const REPLAY_MAX_REQUEST_BYTES = 17 * 1024 * 1024;
export const REPLAY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const REPLAY_MAX_DISCLOSURE_BYTES = 32 * 1024;
export const REPLAY_MAX_EXPECTATIONS_BYTES = 32 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const publicKey = z.string().regex(/^(?:0x)?[a-fA-F0-9]{64}$/);
const requestPath = z.enum(["messages[0].content", "messages[1].content"]);
export const replayFieldPath = z.enum([
  "messages[0].content",
  "messages[1].content",
  "choices[0].message.content",
  "choices[0].message.reasoning_content",
  "choices[0].message.reasoning",
  "choices[0].message.refusal",
]);
export const replayDisclosureSchema = z
  .object({
    schema: z.literal("razor.private-inference-replay-keys"),
    version: z.literal(1),
    codec: z.literal("nearai-sdk-0.3.0-ed25519-chat-v3"),
    sensitive: z.literal(true),
    model: z.string().min(1).max(256),
    completionId: z.string().min(1).max(256),
    requestWireSha256: hash,
    responseWireSha256: hash,
    context: z
      .object({
        signingAlgo: z.literal("ed25519"),
        clientPublicKey: hash,
        modelPublicKey: publicKey,
        encryptionVersion: z.literal("3"),
        noAliasing: z.literal("true"),
        encryptAllFields: z.literal("true"),
      })
      .strict(),
    requestFields: z
      .array(z.object({ path: requestPath, ephemeralSecretHex: hash }).strict())
      .max(2)
      .refine(
        (fields) =>
          new Set(fields.map((value) => value.path)).size === fields.length,
      ),
    clientReplySecretHex: hash.nullable(),
  })
  .strict();
export const replayExpectationsSchema = z
  .object({
    schema: z.literal("razor.private-inference-replay-expectations"),
    version: z.literal(1),
    model: z.string().min(1).max(256),
    modelSigningPublicKey: publicKey,
    requestWireSha256: hash,
    responseWireSha256: hash,
    fields: z
      .array(z.object({ path: replayFieldPath, sha256: hash }).strict())
      .min(1)
      .max(6)
      .refine(
        (fields) =>
          new Set(fields.map((value) => value.path)).size === fields.length,
      ),
  })
  .strict();
export type ReplayDisclosure = z.infer<typeof replayDisclosureSchema>;
export type ReplayExpectations = z.infer<typeof replayExpectationsSchema>;
export type ReplayFieldPath = z.infer<typeof replayFieldPath>;
export function parseReplayDisclosure(text: string): ReplayDisclosure {
  if (new TextEncoder().encode(text).length > REPLAY_MAX_DISCLOSURE_BYTES)
    throw new Error("Local replay key disclosure exceeds its limit");
  try {
    return replayDisclosureSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(
      "The local replay key disclosure is invalid or unsupported",
    );
  }
}
export function parseReplayExpectations(text: string): ReplayExpectations {
  if (new TextEncoder().encode(text).length > REPLAY_MAX_EXPECTATIONS_BYTES)
    throw new Error("Local replay expectations exceed their limit");
  try {
    return replayExpectationsSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(
      "The separate replay expectations are invalid or unsupported",
    );
  }
}
export function clearReplayDisclosure(
  value: ReplayDisclosure | null | undefined,
) {
  if (!value) return;
  value.clientReplySecretHex = null;
  for (const field of value.requestFields) field.ephemeralSecretHex = "";
  value.requestFields.length = 0;
}

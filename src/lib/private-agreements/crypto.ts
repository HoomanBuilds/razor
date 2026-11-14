import {
  bindingSchema,
  canonical,
  envelopeSchema,
  keyBundleSchema,
  openedSchema,
  publicKeySchema,
  type LocalKey,
  type OpenedOffer,
  type SealedBinding,
  type SealedEnvelope,
} from "./schema";

const encoder = new TextEncoder();
export const bytes64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
}
export async function sha256(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(canonical(value))),
    ),
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
export async function keyIdentity(input: unknown) {
  return sha256(publicKeySchema.parse(input));
}
export async function generateLocalKey(): Promise<LocalKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const publicKey = publicKeySchema.parse(
    await crypto.subtle.exportKey("jwk", pair.publicKey),
  );
  return keyBundleSchema.parse({
    schema: "razor.agreement-local-key",
    version: 1,
    keyId: await keyIdentity(publicKey),
    publicKey,
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  });
}
export async function loadLocalKey(input: unknown) {
  const result = keyBundleSchema.parse(input);
  if (
    (await keyIdentity(result.publicKey)) !== result.keyId ||
    result.publicKey.n !== result.privateKey.n ||
    result.publicKey.e !== result.privateKey.e
  )
    throw new Error("The local private key does not match its public identity");
  await crypto.subtle.importKey(
    "jwk",
    result.privateKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  return result;
}
export async function sealOffer(
  bindingInput: SealedBinding,
  terms: OpenedOffer["terms"],
  publicKeys: unknown[],
): Promise<SealedEnvelope> {
  const binding = bindingSchema.parse(bindingInput),
    opened = openedSchema.parse({
      terms,
      salt: bytes64(crypto.getRandomValues(new Uint8Array(32))),
    });
  const commitment = await sha256({ binding, ...opened }),
    keys = publicKeys.map((value) => publicKeySchema.parse(value));
  const identities = await Promise.all(keys.map(keyIdentity));
  if (
    !keys.length ||
    keys.length > 2 ||
    new Set(identities).size !== identities.length
  )
    throw new Error("Choose one or two distinct reviewed encryption keys");
  const aes = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    ),
    raw = await crypto.subtle.exportKey("raw", aes);
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    aad = encoder.encode(
      canonical({ binding, commitment, keyIds: identities }),
    );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    aes,
    encoder.encode(canonical(opened)),
  );
  const wrappedKeys = await Promise.all(
    keys.map(async (key, index) => ({
      keyId: identities[index]!,
      value: bytes64(
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            await crypto.subtle.importKey(
              "jwk",
              key,
              { name: "RSA-OAEP", hash: "SHA-256" },
              false,
              ["encrypt"],
            ),
            raw,
          ),
        ),
      ),
    })),
  );
  return envelopeSchema.parse({
    schema: "razor.sealed-agreement-envelope",
    version: 1,
    algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
    binding,
    commitment,
    iv: bytes64(iv),
    ciphertext: bytes64(new Uint8Array(ciphertext)),
    wrappedKeys,
  });
}
export async function openOffer(
  input: unknown,
  keyInput: unknown,
): Promise<OpenedOffer> {
  const envelope = envelopeSchema.parse(input),
    key = await loadLocalKey(keyInput),
    wrapped = envelope.wrappedKeys.find((value) => value.keyId === key.keyId);
  if (!wrapped)
    throw new Error(
      "This sealed offer is not addressed to the selected local key",
    );
  const rsa = await crypto.subtle.importKey(
    "jwk",
    key.privateKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const raw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    rsa,
    decode(wrapped.value),
  );
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "decrypt",
    ]),
    aad = encoder.encode(
      canonical({
        binding: envelope.binding,
        commitment: envelope.commitment,
        keyIds: envelope.wrappedKeys.map((value) => value.keyId),
      }),
    );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(envelope.iv),
      additionalData: aad,
      tagLength: 128,
    },
    aes,
    decode(envelope.ciphertext),
  );
  const opened = openedSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
  );
  if (
    (await sha256({ binding: envelope.binding, ...opened })) !==
    envelope.commitment
  )
    throw new Error(
      "The offer does not match its bidder, tender and complete terms commitment",
    );
  return opened;
}

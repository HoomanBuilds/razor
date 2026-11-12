import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApiError } from "../context";

export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

function encryptionKey(): Buffer {
  const configured = process.env.DATA_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, /^[a-f0-9]{64}$/i.test(configured) ? "hex" : "base64");
    if (key.length !== 32) throw new ApiError(503, "DATA_ENCRYPTION_KEY must encode exactly 32 bytes", "ENCRYPTION_SETUP_REQUIRED");
    return key;
  }
  if (process.env.NODE_ENV === "production") throw new ApiError(503, "Configure DATA_ENCRYPTION_KEY before storing private recipient records", "ENCRYPTION_SETUP_REQUIRED");
  const file = resolve(".data/private-data.key");
  mkdirSync(dirname(file), { recursive: true });
  try {
    return readFileSync(file);
  } catch {
    try { writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return readFileSync(file);
  }
}

export function encrypt(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["enc1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), payload.toString("base64url")].join(":");
}

export function decrypt(value: string): string {
  if (!value.startsWith("enc1:")) return value;
  const [, nonce, tag, ciphertext] = value.split(":");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

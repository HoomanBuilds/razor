import { ApiError } from "../context";

export const DOCUMENT_LIMITS = {
  fileBytes: 3 * 1024 * 1024,
  requestBytes: 3 * 1024 * 1024 + 65_536,
  companyBytes: 30 * 1024 * 1024,
  companyRecords: 100,
  pdfPages: 8,
  imageSide: 4000,
  imagePixels: 12_000_000,
  textCharacters: 20_000,
  processMs: 25_000,
  memoryBytes: 256 * 1024 * 1024,
  renderedBytes: 8 * 1024 * 1024,
} as const;

export type DocumentKind = "pdf" | "png" | "jpeg";
export const mediaTypes = { pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg" } as const;

export function imageDimensions(bytes: Buffer, kind: "png" | "jpeg") {
  if (kind === "png") {
    if (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new ApiError(422, "The PNG image header is incomplete", "DOCUMENT_INVALID");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) break;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new ApiError(422, "The JPEG image header is incomplete", "DOCUMENT_INVALID");
}

export function validateDocument(bytes: Buffer, declaredType?: string): DocumentKind {
  if (!bytes.length || bytes.length > DOCUMENT_LIMITS.fileBytes) throw new ApiError(413, "Choose an invoice file from 1 byte to 3 MB", "DOCUMENT_SIZE_INVALID");
  let kind: DocumentKind;
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") kind = "pdf";
  else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) kind = "png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) kind = "jpeg";
  else throw new ApiError(422, "Upload a PDF, PNG or JPEG invoice", "DOCUMENT_TYPE_UNSUPPORTED");
  if (declaredType && ![mediaTypes[kind], "application/octet-stream"].includes(declaredType)) throw new ApiError(422, "The file contents do not match its declared type", "DOCUMENT_TYPE_MISMATCH");
  if (kind !== "pdf") {
    const { width, height } = imageDimensions(bytes, kind);
    if (!width || !height || width > DOCUMENT_LIMITS.imageSide || height > DOCUMENT_LIMITS.imageSide || width * height > DOCUMENT_LIMITS.imagePixels) throw new ApiError(422, "Use an image no larger than 4,000 pixels per side and 12 megapixels", "DOCUMENT_IMAGE_TOO_LARGE");
  }
  return kind;
}

export function documentFilename(value: string) {
  return value.replaceAll("\\", "/").split("/").at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) || "invoice";
}

export function documentRetentionDays(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.DOCUMENT_RETENTION_DAYS ?? "7";
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 30) throw new ApiError(503, "DOCUMENT_RETENTION_DAYS must be from 1 to 30", "DOCUMENT_SETUP_REQUIRED");
  return Number(raw);
}

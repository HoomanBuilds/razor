import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { extractPrivateInvoice } from "../assistant/client";
import { requirePrivateAiConfig } from "../assistant/config";
import { createAnalysisPacket } from "../assistant/packet";
import { ApiError } from "../context";
import { DOCUMENT_LIMITS, validateDocument } from "../document-intake/limits";
import { documentImages, extractDocumentText } from "../document-intake/processor";
import { companyReviewSchema } from "../../lib/company-private/schema";

type Inference = typeof extractPrivateInvoice;

export async function readCompanyInvoice(path: string) {
  if (!isAbsolute(path)) throw new ApiError(422, "Choose an absolute local invoice file path", "COMPANY_INPUT_PATH_INVALID");
  const expected = await lstat(path);
  if (!expected.isFile() || expected.isSymbolicLink()) throw new ApiError(422, "Choose a regular local invoice file without links", "COMPANY_INPUT_INVALID");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev || info.nlink !== 1 || info.size < 1 || info.size > DOCUMENT_LIMITS.fileBytes) throw new ApiError(422, "Choose one regular invoice file up to 3 MB, without symbolic or hard links", "COMPANY_INPUT_INVALID");
    const buffer = Buffer.alloc(DOCUMENT_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await file.read(buffer, length, buffer.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (!length || length > DOCUMENT_LIMITS.fileBytes) throw new ApiError(413, "The invoice file exceeds 3 MB", "COMPANY_INPUT_TOO_LARGE");
    const bytes = buffer.subarray(0, length), sha256 = createHash("sha256").update(bytes).digest("hex");
    if (extname(path).toLowerCase() === ".txt") {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ApiError(422, "Use UTF-8 invoice text or a supported PDF/image", "COMPANY_TEXT_INVALID"); }
      if (!text.trim() || text.includes("\0") || text.length > DOCUMENT_LIMITS.textCharacters) throw new ApiError(422, "Use invoice text from 1 to 20,000 characters", "COMPANY_TEXT_INVALID");
      return { bytes, text, source: { sha256, kind: "text" as const, bytes: length }, images: [] };
    }
    const kind = validateDocument(bytes), extracted = await extractDocumentText(bytes, kind);
    const images = extracted.needsVision ? await documentImages(bytes, kind) : [];
    return { bytes, text: extracted.text, source: { sha256, kind, bytes: length }, images };
  } finally { await file.close(); }
}

export async function processCompanyInvoice(path: string, options: { infer?: Inference; disclosure?: "encrypted_wire" | "metadata"; now?: Date } = {}) {
  if (!options.infer) requirePrivateAiConfig();
  const input = await readCompanyInvoice(path);
  const result = await (options.infer ?? extractPrivateInvoice)(input.text, input.images, input.source.sha256);
  const verification = result.verification, now = options.now ?? new Date();
  const review = companyReviewSchema.parse({
    schema: "razor.company-private.invoice", version: 1, processedAt: now.toISOString(), source: input.source, draft: result.draft,
    processing: { mode: "company_operated", provider: "NEAR AI Cloud", model: verification.model,
      reportedVerifiedAt: verification.verifiedAt, reportedGatewayComposeSha256: verification.gatewayComposeSha256,
      reportedModelComposeSha256: verification.modelComposeSha256, reportedRequestWireHash: verification.requestWireHash,
      reportedResponseWireHash: verification.responseWireHash },
  });
  const packet = createAnalysisPacket({ id: `company-${input.source.sha256}`, kind: "invoice_analysis", model: verification.model, evidence: { ...result.evidence, verification } }, options.disclosure ?? "encrypted_wire", now);
  const secret = process.env.NEAR_AI_API_KEY;
  if (secret && JSON.stringify({ review, packet }).includes(secret)) throw new ApiError(422, "A credential appeared in the proposed export. No local result was saved; inspect the source privately", "COMPANY_CREDENTIAL_EXPORT_BLOCKED");
  return { review, packet };
}

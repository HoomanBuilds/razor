import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../context";
import { DOCUMENT_LIMITS, imageDimensions, type DocumentKind } from "./limits";

let active = false;
const findTool = (name: string) => ["/usr/bin", "/usr/sbin", "/bin"].map(path => join(path, name)).find(existsSync);

export function processorReadiness() {
  const missing = ["prlimit", "pdfinfo", "pdftotext", "pdftoppm"].filter(name => !findTool(name));
  if (process.platform !== "linux") missing.push("Linux resource-limited document worker");
  return { ready: missing.length === 0, missing };
}

async function tool(name: string, args: string[], deadline: number, outputBytes = 128 * 1024) {
  const limiter = findTool("prlimit"), executable = findTool(name), remaining = deadline - Date.now();
  if (!limiter || !executable || process.platform !== "linux") throw new ApiError(503, "PDF extraction is unavailable. Keep the document and enter invoice fields manually", "DOCUMENT_PROCESSOR_UNAVAILABLE");
  if (remaining <= 0) throw new ApiError(422, "Document processing exceeded its time limit. Enter invoice fields manually", "DOCUMENT_PROCESSING_TIMEOUT");
  return new Promise<string>((resolve, reject) => {
    execFile(limiter, ["--as=" + DOCUMENT_LIMITS.memoryBytes, "--cpu=15", "--fsize=" + DOCUMENT_LIMITS.renderedBytes, "--nofile=64", "--", executable, ...args], {
      timeout: remaining, killSignal: "SIGKILL", maxBuffer: outputBytes,
      env: { PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C.UTF-8", NODE_ENV: "production" },
      encoding: "utf8", windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        const limited = error.killed || (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        reject(new ApiError(422, limited ? "Document processing reached a safety limit. Enter invoice fields manually" : "This document could not be read safely. Try an unlocked PDF or enter the invoice manually", limited ? "DOCUMENT_PROCESSING_LIMIT" : "DOCUMENT_INVALID"));
      } else resolve(stdout);
    });
  });
}

export async function withDocumentWorker<T>(bytes: Buffer, job: (path: string, directory: string, deadline: number) => Promise<T>) {
  if (active) throw new ApiError(429, "Another document is being processed. Your upload is saved; retry shortly", "DOCUMENT_PROCESSOR_BUSY");
  active = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "razor-invoice-"));
    const path = join(directory, "source.pdf");
    await writeFile(path, bytes, { mode: 0o600 });
    return await job(path, directory, Date.now() + DOCUMENT_LIMITS.processMs);
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { active = false; }
  }
}

export function validatePdfInfo(info: string) {
  const pages = /^Pages:\s*(\d+)\s*$/m.exec(info);
  if (!pages || Number(pages[1]) < 1) throw new ApiError(422, "The PDF page count could not be verified", "DOCUMENT_INVALID");
  if (Number(pages[1]) > DOCUMENT_LIMITS.pdfPages) throw new ApiError(422, "Use a PDF with no more than 8 pages", "DOCUMENT_TOO_MANY_PAGES");
  if (/^Encrypted:\s*yes\b/im.test(info)) throw new ApiError(422, "Remove PDF password protection before uploading", "DOCUMENT_ENCRYPTED");
  return Number(pages[1]);
}

export async function extractDocumentText(bytes: Buffer, kind: DocumentKind) {
  if (kind !== "pdf") return { text: "", pages: 1, needsVision: true };
  return withDocumentWorker(bytes, async (path, _directory, deadline) => {
    const pages = validatePdfInfo(await tool("pdfinfo", [path], deadline, 32 * 1024));
    const raw = await tool("pdftotext", ["-layout", "-enc", "UTF-8", "-f", "1", "-l", String(pages), path, "-"], deadline), text = raw.trim();
    if (text.length > DOCUMENT_LIMITS.textCharacters) throw new ApiError(422, "The invoice text exceeds 20,000 characters. Enter the relevant invoice fields manually", "DOCUMENT_TEXT_TOO_LONG");
    const pageText = raw.split("\f").slice(0, pages);
    return { text, pages, needsVision: pageText.length < pages || pageText.some(page => page.replace(/\s/g, "").length < 20) };
  });
}

export async function documentImages(bytes: Buffer, kind: DocumentKind) {
  if (kind !== "pdf") return [{ mimeType: kind === "png" ? "image/png" as const : "image/jpeg" as const, data: bytes.toString("base64") }];
  return withDocumentWorker(bytes, async (path, directory, deadline) => {
    const pages = validatePdfInfo(await tool("pdfinfo", [path], deadline, 32 * 1024));
    await tool("pdftoppm", ["-jpeg", "-jpegopt", "quality=82", "-scale-to", "1800", "-f", "1", "-l", String(pages), path, join(directory, "page")], deadline, 4096);
    const names = (await readdir(directory)).filter(name => /^page-\d+\.jpg$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (names.length !== pages) throw new ApiError(422, "Not every PDF page could be read. Enter the invoice manually", "DOCUMENT_INVALID");
    let total = 0;
    const images: Array<{ mimeType: "image/jpeg"; data: string }> = [];
    for (const name of names) {
      const path = join(directory, name), size = (await stat(path)).size;
      total += size;
      if (total > DOCUMENT_LIMITS.renderedBytes) throw new ApiError(422, "The scanned invoice exceeds the image processing limit", "DOCUMENT_IMAGE_TOO_LARGE");
      const image = await readFile(path), dimensions = imageDimensions(image, "jpeg");
      if (dimensions.width > 1800 || dimensions.height > 1800) throw new ApiError(422, "The PDF produced an oversized page", "DOCUMENT_IMAGE_TOO_LARGE");
      images.push({ mimeType: "image/jpeg", data: image.toString("base64") });
    }
    return images;
  });
}

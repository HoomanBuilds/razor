import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { supportedRuntime } from "../assistant/config";
import { ApiError } from "../context";
import { MAX_PACKET_BYTES } from "../../lib/verification/packet";
import { COMPANY_REVIEW_MAX_BYTES } from "../../lib/company-private/schema";
import { processCompanyInvoice } from "./processor";

export const companyPrivateHelp = `Usage: node --max-old-space-size=512 --import tsx scripts/process-invoice-private.ts --input /absolute/invoice.pdf --output /absolute/review.json [--packet /absolute/evidence.json] [--packet-mode encrypted_wire|metadata]
Use Node.js 24.22.1 or newer. Input supports UTF-8 TXT, PDF, PNG and JPEG, with the existing file/page/image limits. Configure your own NEAR_AI_API_KEY, NEAR_AI_MODEL and approved NEAR_AI_MODEL_COMPOSE_SHA256 / NEAR_AI_GATEWAY_COMPOSE_SHA256 in this company process only. Required verification is never downgraded. PDF tools must be installed locally for PDFs.
The source, decrypted model output and key stay on this computer. Only verified NEAR AI processing receives encrypted input; this command has no Razor endpoint. The local review file contains plaintext extracted fields. Optional evidence contains encrypted wire data or redacted metadata, never plaintext or decryption keys. Output files are new, atomic, mode 0600 and never overwrite an existing file. No hosted store is used. Input and output files remain until you delete them; provider key revocation remains in your NEAR AI account. Importing selected reviewed fields in Razor is a separate explicit action.\n`;

async function availableOutput(path: string) {
  if (!isAbsolute(path)) throw new ApiError(422, "Choose absolute local output paths", "COMPANY_OUTPUT_PATH_INVALID");
  const directory = dirname(path), parent = await stat(directory);
  if (!parent.isDirectory()) throw new ApiError(422, "Choose an existing output directory", "COMPANY_OUTPUT_PATH_INVALID");
  await access(directory, constants.W_OK | constants.X_OK);
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new ApiError(409, "Choose new output paths; existing files are never overwritten", "COMPANY_OUTPUT_EXISTS");
}

export async function writePrivateJson(path: string, input: unknown, maximumBytes: number) {
  const text = JSON.stringify(input, null, 2) + "\n";
  if (Buffer.byteLength(text) > maximumBytes) throw new ApiError(422, "The local result exceeded its export limit", "COMPANY_OUTPUT_TOO_LARGE");
  const temporary = join(dirname(path), `.razor-private-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, path);
  }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function runCompanyPrivateCommand(args: string[], processFile: typeof processCompanyInvoice = processCompanyInvoice) {
  const parsed = parseArgs({ args, options: { input: { type: "string" }, output: { type: "string" }, packet: { type: "string" }, "packet-mode": { type: "string" }, help: { type: "boolean" } } }).values;
  if (parsed.help) return { help: companyPrivateHelp };
  if (!supportedRuntime()) throw new ApiError(422, "Use Node.js 24.22.1 or newer for required private verification", "COMPANY_RUNTIME_REQUIRED");
  const limits = [...`${process.env.NODE_OPTIONS ?? ""} ${process.execArgv.join(" ")}`.matchAll(/--max-old-space-size(?:=|\s+)(\d+)/g)], oldSpace = Number(limits.at(-1)?.[1]);
  if (!oldSpace || oldSpace > 512 || getHeapStatistics().heap_size_limit > 768 * 1024 * 1024) throw new ApiError(422, "Run this command with --max-old-space-size=512 to keep local memory bounded", "COMPANY_HEAP_LIMIT_REQUIRED");
  if (!parsed.input || !parsed.output) throw new ApiError(422, "Choose --input and --output absolute local paths; use --help for setup", "COMPANY_PATHS_REQUIRED");
  if (!isAbsolute(parsed.input)) throw new ApiError(422, "Choose an absolute local invoice file path", "COMPANY_INPUT_PATH_INVALID");
  if (parsed["packet-mode"] && !["encrypted_wire", "metadata"].includes(parsed["packet-mode"])) throw new ApiError(422, "Choose encrypted_wire or metadata for --packet-mode", "COMPANY_DISCLOSURE_INVALID");
  const paths = [parsed.input, parsed.output, ...(parsed.packet ? [parsed.packet] : [])].map(path => resolve(path));
  if (new Set(paths).size !== paths.length) throw new ApiError(422, "Input, review and evidence paths must be distinct", "COMPANY_PATHS_CONFLICT");
  await availableOutput(parsed.output); if (parsed.packet) await availableOutput(parsed.packet);
  const result = await processFile(parsed.input, { disclosure: parsed["packet-mode"] as "encrypted_wire" | "metadata" | undefined });
  let reviewWritten = false;
  try {
    await writePrivateJson(parsed.output, result.review, COMPANY_REVIEW_MAX_BYTES); reviewWritten = true;
    if (parsed.packet) await writePrivateJson(parsed.packet, result.packet, MAX_PACKET_BYTES);
  } catch (error) { if (reviewWritten) await unlink(parsed.output).catch(() => {}); throw error; }
  return { help: null, packetWritten: !!parsed.packet };
}

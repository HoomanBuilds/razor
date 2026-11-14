import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { z } from "zod";
import {
  generateLocalKey,
  loadLocalKey,
  openOffer,
  sha256,
} from "../../lib/private-agreements/crypto";
import {
  checkedOffer,
  localReviewSchema,
  privateJobSchema,
} from "../../lib/private-agreements/schema";
import { MAX_PACKET_BYTES } from "../../lib/verification/packet";
import { runVerifiedPrivateInference } from "../assistant/client";
import { requirePrivateAiConfig, supportedRuntime } from "../assistant/config";
import { createAnalysisPacket } from "../assistant/packet";
import { writePrivateJson } from "../company-private/command";
import { ApiError } from "../context";

const maximum = 180000;
export const privateAgreementHelp = `Usage: node --max-old-space-size=512 --import tsx scripts/private-agreements.ts --mode key --output /absolute/company-key.json
Open one exported sealed job locally: --mode open --input /absolute/job.json --key /absolute/key.json --output /absolute/review.json
Request a verified bounded price suggestion: --mode suggest --input /absolute/job.json --key /absolute/key.json --output /absolute/review.json [--packet /absolute/evidence.json]
Only suggest contacts NEAR AI Cloud using this company's environment-only credentials, approved model/gateway measurements, TLS binding, GPU evidence, freshness and signed response verification. No credentials belong in flags or files. Missing verification holds the operation without fallback. There is no Razor network client in this command.
Keys and decrypted terms stay on this computer; review output contains plaintext. Existing output files are never overwritten. All output files use mode 0600. Source files and local keys remain until you delete them. A local report is an exporter assertion, not independent proof of invoice truth or that a future published agreement equals private inference. Suggestions change only unit price while preserving human quantity, delivery and conditions. A human must reseal any proposal, then both parties approve exact final terms and the company independently approves its ordinary PO.\n`;

async function readJson(path: string) {
  if (!isAbsolute(path))
    throw new ApiError(
      422,
      "Use explicit absolute local input and key paths",
      "PRIVATE_LOCAL_PATH_REQUIRED",
    );
  const expected = await lstat(path);
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.nlink !== 1 ||
    expected.size < 1 ||
    expected.size > maximum
  )
    throw new ApiError(
      422,
      "Choose one regular local JSON file below 180 KB without links",
      "PRIVATE_LOCAL_INPUT_INVALID",
    );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.ino !== expected.ino ||
      info.dev !== expected.dev ||
      info.nlink !== 1 ||
      info.size > maximum
    )
      throw new ApiError(
        422,
        "The selected local file changed",
        "PRIVATE_LOCAL_INPUT_INVALID",
      );
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size > maximum)
      throw new ApiError(
        422,
        "The local file exceeds 180 KB",
        "PRIVATE_LOCAL_INPUT_INVALID",
      );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    ) as unknown;
  } finally {
    await file.close();
  }
}

export async function runPrivateAgreementCommand(args: string[]) {
  const input = parseArgs({
    args,
    options: {
      mode: { type: "string" },
      input: { type: "string" },
      key: { type: "string" },
      output: { type: "string" },
      packet: { type: "string" },
      help: { type: "boolean" },
    },
  }).values;
  if (input.help) return { help: privateAgreementHelp };
  if (!supportedRuntime())
    throw new ApiError(
      422,
      "Use Node.js 24.22.1 or newer",
      "PRIVATE_LOCAL_RUNTIME_REQUIRED",
    );
  const limits = [
      ...`${process.env.NODE_OPTIONS ?? ""} ${process.execArgv.join(" ")}`.matchAll(
        /--max-old-space-size(?:=|\s+)(\d+)/g,
      ),
    ],
    limit = Number(limits.at(-1)?.[1]);
  if (
    !limit ||
    limit > 512 ||
    getHeapStatistics().heap_size_limit > 768 * 1024 * 1024
  )
    throw new ApiError(
      422,
      "Run this local command with --max-old-space-size=512",
      "PRIVATE_LOCAL_HEAP_REQUIRED",
    );
  if (
    !input.output ||
    !isAbsolute(input.output) ||
    !["key", "open", "suggest"].includes(input.mode ?? "")
  )
    throw new ApiError(
      422,
      "Choose --mode key, open or suggest and an absolute new --output path",
      "PRIVATE_LOCAL_ARGUMENTS_REQUIRED",
    );
  const paths = [input.input, input.key, input.output, input.packet].filter(
    (path): path is string => !!path,
  );
  if (
    paths.some((path) => !isAbsolute(path)) ||
    new Set(paths.map((path) => resolve(path))).size !== paths.length
  )
    throw new ApiError(
      422,
      "Choose distinct absolute input, key, output and evidence paths",
      "PRIVATE_LOCAL_PATH_CONFLICT",
    );
  if (input.mode === "key") {
    if (input.input || input.key || input.packet)
      throw new ApiError(
        422,
        "Key creation accepts only a new output path",
        "PRIVATE_LOCAL_ARGUMENTS_REQUIRED",
      );
    await writePrivateJson(input.output, await generateLocalKey(), maximum);
    return { help: null };
  }
  if (!input.input || !input.key || (input.mode !== "suggest" && input.packet))
    throw new ApiError(
      422,
      "Opening requires --input and --key; evidence is available only for verified suggestions",
      "PRIVATE_LOCAL_ARGUMENTS_REQUIRED",
    );
  if (input.mode === "suggest") requirePrivateAiConfig();
  const job = privateJobSchema.parse(await readJson(input.input)),
    key = await loadLocalKey(await readJson(input.key)),
    opened = await openOffer(job.envelope, key);
  const binding = job.envelope.binding;
  if (
    (await sha256({
      organizationId: binding.organizationId,
      tenderId: binding.tenderId,
      version: binding.tenderVersion,
      terms: job.tender,
      buyerPublicKey: job.buyerPublicKey,
    })) !== binding.tenderHash
  )
    throw new ApiError(
      422,
      "The exported tender does not match the sealed source identity",
      "PRIVATE_LOCAL_SOURCE_CHANGED",
    );
  checkedOffer(job.tender, opened.terms);
  let review = localReviewSchema.parse({
      schema: "razor.private-agreement-review",
      version: 1,
      binding,
      commitment: job.envelope.commitment,
      opened,
    }),
    packet: unknown;
  if (input.mode === "suggest") {
    if (
      !job.mandate ||
      job.mandate.terms.expiresAt <= new Date().toISOString() ||
      job.tender.negotiationDeadline <= new Date().toISOString() ||
      job.tender.revealAt > new Date().toISOString()
    )
      throw new ApiError(
        409,
        "A current independently approved mandate and revealed tender are required for a private suggestion",
        "PRIVATE_NEGOTIATION_HELD",
      );
    const base = checkedOffer(job.tender, opened.terms, job.mandate.terms),
      cap =
        BigInt(job.mandate.terms.maximumTotal) -
        BigInt(base.commercial.fixedCharges);
    if (cap <= 0n)
      throw new ApiError(
        422,
        "The mandate has no remaining positive line-price budget",
        "PRIVATE_MANDATE_LIMITS",
      );
    const result = await runVerifiedPrivateInference(
      "finance",
      JSON.stringify({
        instruction: `Propose a lower commercial line subtotal for one supplier, represented as an opaque allocation. Keep the supplied quantity, dates and included charges fixed. ${job.mandate.terms.instruction}`,
        context: {
          netEntitlementCapMicroUSDC: cap.toString(),
          recipients: [
            {
              recipientId: "commercial-line",
              capMicroUSDC: cap.toString(),
              priorPaidMicroUSDC: base.commercial.lineSubtotal,
            },
          ],
          quantity: opened.terms.quantity,
          deliveryDate: opened.terms.deliveryDate,
          includedFixedCharges: base.commercial.fixedCharges,
          commercialConditions: opened.terms.terms,
        },
      }),
    );
    const response = z
      .object({
        allocations: z.tuple([
          z
            .object({
              recipientId: z.literal("commercial-line"),
              amount: z.string().regex(/^[1-9]\d{0,30}$/),
            })
            .strict(),
        ]),
        explanation: z.string().max(2000),
        warnings: z.array(z.string().max(500)).max(20),
      })
      .strict()
      .parse(JSON.parse(result.content));
    const line = BigInt(response.allocations[0].amount);
    if (line > cap || line < BigInt(opened.terms.quantity))
      throw new ApiError(
        422,
        "The verified model returned a price outside the human mandate",
        "PRIVATE_SUGGESTION_HELD",
      );
    const suggestedTerms = {
      ...opened.terms,
      unitPrice: (line / BigInt(opened.terms.quantity)).toString(),
      validUntil: [
        opened.terms.validUntil,
        job.mandate.terms.expiresAt,
        job.tender.negotiationDeadline,
      ].sort()[0]!,
    };
    checkedOffer(job.tender, suggestedTerms, job.mandate.terms);
    review = localReviewSchema.parse({
      ...review,
      suggestedTerms,
      inference: {
        provider: "NEAR AI Cloud",
        model: result.verification.model,
        reportedVerifiedAt: result.verification.verifiedAt,
        reportedRequestWireHash: result.verification.requestWireHash,
        reportedResponseWireHash: result.verification.responseWireHash,
      },
    });
    packet = createAnalysisPacket(
      {
        id: `agreement-${job.envelope.commitment}`,
        kind: "finance_proposal",
        model: result.verification.model,
        evidence: { ...result.evidence, verification: result.verification },
      },
      "encrypted_wire",
    );
  }
  if (
    process.env.NEAR_AI_API_KEY &&
    JSON.stringify({ review, packet }).includes(process.env.NEAR_AI_API_KEY)
  )
    throw new ApiError(
      422,
      "A credential appeared in the proposed export. No result was saved",
      "PRIVATE_CREDENTIAL_EXPORT_HELD",
    );
  let written = false;
  try {
    await writePrivateJson(input.output, review, maximum);
    written = true;
    if (input.packet)
      await writePrivateJson(input.packet, packet, MAX_PACKET_BYTES);
  } catch (error) {
    if (written) await unlink(input.output).catch(() => {});
    throw error;
  }
  return { help: null };
}

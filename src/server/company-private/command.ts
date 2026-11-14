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
import type { ReplayVerifiedSession } from "../assistant/replay-client";
import type {
  ReplayDisclosure,
  ReplayExpectations,
} from "../../lib/private-inference-replay/schema";

export const companyPrivateHelp = `Usage: node --max-old-space-size=512 --import tsx scripts/process-invoice-private.ts --input /absolute/invoice.pdf --output /absolute/review.json [--packet /absolute/evidence.json] [--packet-mode encrypted_wire|metadata]
Use Node.js 24.22.1 or newer. Input supports UTF-8 TXT, PDF, PNG and JPEG, with the existing file/page/image limits. Configure your own NEAR_AI_API_KEY, NEAR_AI_MODEL and approved NEAR_AI_MODEL_COMPOSE_SHA256 / NEAR_AI_GATEWAY_COMPOSE_SHA256 in this company process only. Required verification is never downgraded. PDF tools must be installed locally for PDFs.
The source, decrypted model output and key stay on this computer. Only verified NEAR AI processing receives encrypted input; this command has no Razor endpoint. The local review file contains plaintext extracted fields. Optional evidence contains encrypted wire data or redacted metadata, never plaintext or decryption keys. Output files are new, atomic, mode 0600 and never overwrite an existing file. No hosted store is used. Input and output files remain until you delete them; provider key revocation remains in your NEAR AI account. Importing selected reviewed fields in Razor is a separate explicit action.
Optional independent content replay: add --replay-keys /private/local/replay-keys.json --replay-digests /private/local/replay-digests.json --acknowledge-replay-key-disclosure together with --packet and --packet-mode encrypted_wire. This deliberately retains this request's per-field ephemeral X25519 secrets and client reply secret in a SEPARATE highly sensitive 0600 file. Anyone with that file and the encrypted packet can decrypt the supported content. No model private key or API key is exported. Keep the key file outside public, synchronized and version-controlled directories; never upload it to Razor or include it with an ordinary evidence packet. The separate digest file records exact UTF-8 content hashes observed locally, including SDK JSON serialization of image parts. Review expected source/model/digests independently before treating replay as more than byte consistency. Replay does not prove invoice facts, hardware identity, historical freshness or payment delivery. This narrow replay mode accepts only Ed25519 E2EE v3, nonstream JSON-object Chat Completions with the current system/user string or image-parts input. Replay input is limited to 8 MiB; larger/unsupported requests fail before inference transport. Cancellation clears mutable key buffers and removes completed outputs from this run. JavaScript immutable strings and external filesystem backups cannot be reliably erased; deleting the local key file cannot revoke copies already made. The default SDK mode never retains these replay secrets.
Optional NEAR timing anchors: add --anchor-trust /absolute/independent-trust.json --anchor-challenge /absolute/final-challenge.json --anchor-rpc-url HTTPS_ARCHIVE --anchor-observation /absolute/new-session-observation.json with an encrypted_wire --packet. First prepare, explicitly sign and collect a challenge using scripts/inference-anchors.ts. This command verifies its final historical code/keys and uses its nonce for actual hardware-attested Gateway/model verification and pinned TLS. The separate session observation retains the original public TLS fingerprint and report commitments, never keys. Replay secret export remains optional. After inference, use scripts/inference-anchors.ts response and complete to explicitly sign and collect the second commitment before the accepted interval expires. No command signs or transfers automatically. Two optional anchor transactions have normal recorder gas; preparation or a session observation alone is not a completed freshness proof. The reviewed validator-randomness assumption, independently chosen archival RPC and current hardware collateral remain explicit trust assumptions.\n`;

async function availableOutput(path: string) {
  if (!isAbsolute(path))
    throw new ApiError(
      422,
      "Choose absolute local output paths",
      "COMPANY_OUTPUT_PATH_INVALID",
    );
  const directory = dirname(path),
    parent = await stat(directory);
  if (!parent.isDirectory())
    throw new ApiError(
      422,
      "Choose an existing output directory",
      "COMPANY_OUTPUT_PATH_INVALID",
    );
  await access(directory, constants.W_OK | constants.X_OK);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new ApiError(
    409,
    "Choose new output paths; existing files are never overwritten",
    "COMPANY_OUTPUT_EXISTS",
  );
}

export async function writePrivateJson(
  path: string,
  input: unknown,
  maximumBytes: number,
  signal?: AbortSignal,
) {
  const bytes = Buffer.from(JSON.stringify(input, null, 2) + "\n");
  const temporary = join(dirname(path), `.razor-private-${randomUUID()}.tmp`);
  try {
    if (bytes.length > maximumBytes)
      throw new ApiError(
        422,
        "The local result exceeded its export limit",
        "COMPANY_OUTPUT_TOO_LARGE",
      );
    const file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      signal?.throwIfAborted();
      await file.chmod(0o600);
      if (((await file.stat()).mode & 0o777) !== 0o600)
        throw new ApiError(
          422,
          "This filesystem could not enforce private 0600 output permissions",
          "COMPANY_PRIVATE_PERMISSIONS_REQUIRED",
        );
      await file.writeFile(bytes, { signal });
      await file.sync();
      signal?.throwIfAborted();
    } finally {
      await file.close();
    }
    await link(temporary, path);
  } finally {
    bytes.fill(0);
    await unlink(temporary).catch(() => {});
  }
}

export async function runCompanyPrivateCommand(
  args: string[],
  processFile: typeof processCompanyInvoice = processCompanyInvoice,
  options: {
    createVerifiedSession?: (model: string) => Promise<ReplayVerifiedSession>;
  } = {},
) {
  const parsed = parseArgs({
    args,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      packet: { type: "string" },
      "packet-mode": { type: "string" },
      "replay-keys": { type: "string" },
      "replay-digests": { type: "string" },
      "acknowledge-replay-key-disclosure": { type: "boolean" },
      "anchor-trust": { type: "string" },
      "anchor-challenge": { type: "string" },
      "anchor-rpc-url": { type: "string" },
      "anchor-observation": { type: "string" },
      help: { type: "boolean" },
    },
  }).values;
  if (parsed.help) return { help: companyPrivateHelp };
  if (!supportedRuntime())
    throw new ApiError(
      422,
      "Use Node.js 24.22.1 or newer for required private verification",
      "COMPANY_RUNTIME_REQUIRED",
    );
  const limits = [
      ...`${process.env.NODE_OPTIONS ?? ""} ${process.execArgv.join(" ")}`.matchAll(
        /--max-old-space-size(?:=|\s+)(\d+)/g,
      ),
    ],
    oldSpace = Number(limits.at(-1)?.[1]);
  if (
    !oldSpace ||
    oldSpace > 512 ||
    getHeapStatistics().heap_size_limit > 768 * 1024 * 1024
  )
    throw new ApiError(
      422,
      "Run this command with --max-old-space-size=512 to keep local memory bounded",
      "COMPANY_HEAP_LIMIT_REQUIRED",
    );
  if (!parsed.input || !parsed.output)
    throw new ApiError(
      422,
      "Choose --input and --output absolute local paths; use --help for setup",
      "COMPANY_PATHS_REQUIRED",
    );
  if (!isAbsolute(parsed.input))
    throw new ApiError(
      422,
      "Choose an absolute local invoice file path",
      "COMPANY_INPUT_PATH_INVALID",
    );
  if (
    parsed["packet-mode"] &&
    !["encrypted_wire", "metadata"].includes(parsed["packet-mode"])
  )
    throw new ApiError(
      422,
      "Choose encrypted_wire or metadata for --packet-mode",
      "COMPANY_DISCLOSURE_INVALID",
    );
  const replayRequested = !!(
    parsed["replay-keys"] ||
    parsed["replay-digests"] ||
    parsed["acknowledge-replay-key-disclosure"]
  );
  if (
    replayRequested &&
    (!parsed["replay-keys"] ||
      !parsed["replay-digests"] ||
      !parsed["acknowledge-replay-key-disclosure"] ||
      !parsed.packet ||
      parsed["packet-mode"] !== "encrypted_wire")
  )
    throw new ApiError(
      422,
      "Replay requires explicit --replay-keys, --replay-digests, --acknowledge-replay-key-disclosure and an encrypted_wire --packet. No secret file is created implicitly.",
      "COMPANY_REPLAY_DISCLOSURE_REQUIRED",
    );
  const anchoredRequested = !!(
    parsed["anchor-trust"] ||
    parsed["anchor-challenge"] ||
    parsed["anchor-rpc-url"] ||
    parsed["anchor-observation"]
  );
  if (
    anchoredRequested &&
    (!parsed["anchor-trust"] ||
      !parsed["anchor-challenge"] ||
      !parsed["anchor-rpc-url"] ||
      !parsed["anchor-observation"] ||
      !parsed.packet ||
      parsed["packet-mode"] !== "encrypted_wire" ||
      options.createVerifiedSession)
  )
    throw new ApiError(
      422,
      "Anchored inference requires --anchor-trust, --anchor-challenge, --anchor-rpc-url, --anchor-observation and an encrypted_wire --packet. A custom session cannot override the explicit anchor inputs.",
      "COMPANY_ANCHOR_INPUT_REQUIRED",
    );
  const paths = [
    parsed.input,
    parsed.output,
    ...(parsed.packet ? [parsed.packet] : []),
    ...(parsed["replay-keys"] ? [parsed["replay-keys"]] : []),
    ...(parsed["replay-digests"] ? [parsed["replay-digests"]] : []),
    ...(parsed["anchor-trust"] ? [parsed["anchor-trust"]] : []),
    ...(parsed["anchor-challenge"] ? [parsed["anchor-challenge"]] : []),
    ...(parsed["anchor-observation"] ? [parsed["anchor-observation"]] : []),
  ].map((path) => resolve(path));
  if (new Set(paths).size !== paths.length)
    throw new ApiError(
      422,
      "Input, review and evidence paths must be distinct",
      "COMPANY_PATHS_CONFLICT",
    );
  await availableOutput(parsed.output);
  if (parsed.packet) await availableOutput(parsed.packet);
  if (parsed["replay-keys"]) await availableOutput(parsed["replay-keys"]);
  if (parsed["replay-digests"]) await availableOutput(parsed["replay-digests"]);
  if (parsed["anchor-observation"])
    await availableOutput(parsed["anchor-observation"]);
  const controller = new AbortController(),
    written: string[] = [];
  let replay:
      | ReturnType<
          (typeof import("../assistant/replay-inference"))["createCompanyReplayInference"]
        >
      | undefined,
    disclosed:
      | { disclosure: ReplayDisclosure; expectations: ReplayExpectations }
      | undefined;
  const cancel = () => {
    controller.abort();
    replay?.dispose();
    if (disclosed) {
      disclosed.disclosure.clientReplySecretHex = null;
      for (const field of disclosed.disclosure.requestFields)
        field.ephemeralSecretHex = "";
      disclosed.disclosure.requestFields.length = 0;
    }
  };
  if (replayRequested || anchoredRequested) {
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
  }
  try {
    const anchored = anchoredRequested
      ? await (
          await import("./anchors")
        ).companyAnchoredSession({
          trustPath: parsed["anchor-trust"]!,
          challengePath: parsed["anchor-challenge"]!,
          rpcUrl: parsed["anchor-rpc-url"]!,
        })
      : undefined;
    const sessionFactory =
      anchored?.createVerifiedSession ?? options.createVerifiedSession;
    if (replayRequested) {
      const { createCompanyReplayInference } = await import(
        "../assistant/replay-inference"
      );
      replay = createCompanyReplayInference({
        acknowledgeSensitiveDisclosure: true,
        signal: controller.signal,
        createVerifiedSession: sessionFactory,
      });
    }
    const result = await processFile(parsed.input, {
      disclosure: parsed["packet-mode"] as
        | "encrypted_wire"
        | "metadata"
        | undefined,
      ...(replay
        ? { infer: replay.infer }
        : anchored
          ? {
              infer: async (text, images, sourceHash) => {
                const { extractPrivateInvoice } = await import(
                  "../assistant/client"
                );
                return extractPrivateInvoice(text, images, sourceHash, {
                  createVerifiedSession: sessionFactory,
                  signal: controller.signal,
                });
              },
            }
          : {}),
    });
    controller.signal.throwIfAborted();
    if (replay) {
      disclosed = replay.takeDisclosure();
      if (
        disclosed.disclosure.requestWireSha256 !==
          result.packet.inference?.request?.sha256 ||
        disclosed.disclosure.responseWireSha256 !==
          result.packet.inference?.response?.sha256 ||
        disclosed.disclosure.completionId !==
          result.packet.inference?.completionId
      )
        throw new ApiError(
          422,
          "The sensitive replay file does not match the retained encrypted evidence",
          "COMPANY_REPLAY_BINDING_FAILED",
        );
      if (
        process.env.NEAR_AI_API_KEY &&
        JSON.stringify(disclosed).includes(process.env.NEAR_AI_API_KEY)
      )
        throw new ApiError(
          422,
          "A credential appeared in the proposed local output. No replay result was saved",
          "COMPANY_CREDENTIAL_EXPORT_BLOCKED",
        );
    }
    await writePrivateJson(
      parsed.output,
      result.review,
      COMPANY_REVIEW_MAX_BYTES,
      controller.signal,
    );
    written.push(parsed.output);
    controller.signal.throwIfAborted();
    if (parsed.packet) {
      await writePrivateJson(
        parsed.packet,
        result.packet,
        MAX_PACKET_BYTES,
        controller.signal,
      );
      written.push(parsed.packet);
      controller.signal.throwIfAborted();
    }
    if (anchored && parsed["anchor-observation"]) {
      const { MAX_ANCHOR_BYTES } = await import(
        "../../lib/verification/inference-anchors"
      );
      await writePrivateJson(
        parsed["anchor-observation"],
        anchored.observation(),
        MAX_ANCHOR_BYTES,
        controller.signal,
      );
      written.push(parsed["anchor-observation"]);
      controller.signal.throwIfAborted();
    }
    if (disclosed && parsed["replay-keys"] && parsed["replay-digests"]) {
      const limits = await import("../../lib/private-inference-replay/schema");
      await writePrivateJson(
        parsed["replay-digests"],
        disclosed.expectations,
        limits.REPLAY_MAX_EXPECTATIONS_BYTES,
        controller.signal,
      );
      written.push(parsed["replay-digests"]);
      controller.signal.throwIfAborted();
      await writePrivateJson(
        parsed["replay-keys"],
        disclosed.disclosure,
        limits.REPLAY_MAX_DISCLOSURE_BYTES,
        controller.signal,
      );
      written.push(parsed["replay-keys"]);
      controller.signal.throwIfAborted();
    }
    return {
      help: null,
      packetWritten: !!parsed.packet,
      replayKeysWritten: replayRequested,
      replayDigestsWritten: replayRequested,
      anchorObservationWritten: anchoredRequested,
    };
  } catch (error) {
    for (const path of written.reverse()) await unlink(path).catch(() => {});
    throw error;
  } finally {
    replay?.dispose();
    if (disclosed) {
      disclosed.disclosure.clientReplySecretHex = null;
      for (const field of disclosed.disclosure.requestFields)
        field.ephemeralSecretHex = "";
      disclosed.disclosure.requestFields.length = 0;
    }
    if (replayRequested || anchoredRequested) {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}

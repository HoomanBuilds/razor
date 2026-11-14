import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { parsePacket, MAX_PACKET_BYTES } from "../src/lib/verification/packet";
import {
  INFERENCE_ANCHOR_LIMITATIONS,
  MAX_ANCHOR_BYTES,
  inferenceAnchorChallengeSchema,
  parseInferenceAnchorEvidence,
  parseInferenceAnchorTrust,
} from "../src/lib/verification/inference-anchors";
import { verifyInferenceAnchors } from "../src/lib/verification/inference-anchors-verify";
import {
  collectInferenceChallenge,
  collectInferenceResponse,
  pendingAnchorSchema,
  prepareInferenceChallenge,
  prepareInferenceResponse,
  preparedAnchorSchema,
} from "../src/server/assistant/anchored-collection";
import { supportedRuntime } from "../src/server/assistant/config";
import { writePrivateJson } from "../src/server/company-private/command";

const help = `Usage: node --max-old-space-size=512 --import tsx scripts/inference-anchors.ts COMMAND --trust /absolute/independent-trust.json --output /absolute/new-output.json [options]
Commands:
  prepare: create unsigned challenge wallet descriptor from independently reviewed trust. Choose a fresh random blinded contextHash in that trust; a fresh random salt is generated locally.
  challenge: --prepared /absolute/prepared.json --tx-hash HASH --rpc-url HTTPS_ARCHIVE. Collect a real finalized challenge after you explicitly sign its descriptor in your recorder wallet.
  response: --challenge /absolute/challenge.json --packet /absolute/encrypted-packet.json. After actual anchored inference, prepare an unsigned exact wire/report commitment descriptor. Signature/wire binding is checked; full hardware verification remains separate.
  complete: --pending /absolute/pending.json --packet /absolute/encrypted-packet.json --tx-hash HASH --rpc-url HTTPS_ARCHIVE. After your explicit response signature, retrieve both final anchors and enforce the reviewed interval.
  verify: --evidence /absolute/anchors.json --packet /absolute/encrypted-packet.json [--rpc-url HTTPS_ARCHIVE] [--hardware]. Independently recheck retained evidence; offline by default.
Trust schema razor.inference-anchor-trust/version1 fixes network, contractId, reviewed codeHash, recorder, fresh random contextHash, expectedModel, maxIntervalMs (1000..600000), approved gateway/model compose hashes, accepted TCB statuses and acceptValidatorRandomnessAssumption:true. Obtain these independently, never from an evidence packet. Optional originalGatewaySpki is an independently retained original TLS observation.
No command signs, broadcasts, deploys, spends, creates backend keys or contacts Razor. Wallet descriptors require normal NEAR network gas paid explicitly by the recorder, zero attached contract deposit, and a reviewed contract already deployed with all keys removed. No per-company state or funds are stored. Preparing is not final evidence. A completed chain-reference file still needs independent hardware verification to establish a conditional interval claim.
RPC options authorize only public references to your selected endpoint; no endpoint fallback. --hardware authorizes official Intel/NVIDIA collateral verification. Files are local, new mode0600, never overwritten or automatically deleted. No plaintext, credentials or decryption keys are accepted in anchor JSON. Never place invoice names, raw hashes of guessable private content or identifiers in public context/salt.\n`;

async function local(path: string, max: number) {
  if (!isAbsolute(path)) throw Error("Use absolute local file paths");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > max)
      throw Error("Local input exceeds its file bound");
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const item = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!item.bytesRead) break;
      length += item.bytesRead;
    }
    if (length > max || length > info.size)
      throw Error("Local input changed or exceeded its bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
  } finally {
    await file.close();
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    process.stdout.write(help);
    return;
  }
  const values = parseArgs({
    args: argv,
    options: {
      trust: { type: "string" },
      output: { type: "string" },
      prepared: { type: "string" },
      challenge: { type: "string" },
      pending: { type: "string" },
      evidence: { type: "string" },
      packet: { type: "string" },
      "tx-hash": { type: "string" },
      "rpc-url": { type: "string" },
      hardware: { type: "boolean" },
    },
    strict: true,
  }).values;
  if (!supportedRuntime()) throw Error("Use Node.js >=24.22.1");
  const limits = [
      ...`${process.env.NODE_OPTIONS ?? ""} ${process.execArgv.join(" ")}`.matchAll(
        /--max-old-space-size(?:=|\s+)(\d+)/g,
      ),
    ],
    heap = Number(limits.at(-1)?.[1]);
  if (
    !heap ||
    heap > 512 ||
    getHeapStatistics().heap_size_limit > 768 * 1024 * 1024
  )
    throw Error("Run with --max-old-space-size=512 or lower");
  if (!values.trust || !values.output || !isAbsolute(values.output))
    throw Error("Choose independent trust and a new absolute output file");
  const allowed: Record<string, string[]> = {
    prepare: [],
    challenge: ["prepared", "tx-hash", "rpc-url"],
    response: ["challenge", "packet"],
    complete: ["pending", "packet", "tx-hash", "rpc-url"],
    verify: ["evidence", "packet", "rpc-url", "hardware"],
  };
  if (!Object.hasOwn(allowed, command))
    throw Error("Choose a supported command");
  if (
    Object.keys(values).some(
      (key) => !["trust", "output", ...allowed[command]].includes(key),
    )
  )
    throw Error("An option does not belong to this command");
  const trust = parseInferenceAnchorTrust(
    await local(values.trust, MAX_ANCHOR_BYTES),
  );
  let result: unknown;
  function required(
    key:
      | "prepared"
      | "challenge"
      | "pending"
      | "evidence"
      | "packet"
      | "tx-hash"
      | "rpc-url",
  ) {
    const value = values[key];
    if (!value) throw Error("A required command option is missing");
    return value;
  }
  if (command === "prepare") result = prepareInferenceChallenge(trust);
  else if (command === "challenge")
    result = await collectInferenceChallenge(
      preparedAnchorSchema.parse(
        JSON.parse(await local(required("prepared"), MAX_ANCHOR_BYTES)),
      ),
      trust,
      required("tx-hash"),
      required("rpc-url"),
    );
  else if (command === "response")
    result = prepareInferenceResponse(
      inferenceAnchorChallengeSchema.parse(
        JSON.parse(await local(required("challenge"), MAX_ANCHOR_BYTES)),
      ),
      parsePacket(await local(required("packet"), MAX_PACKET_BYTES)),
      trust,
    );
  else if (command === "complete")
    result = await collectInferenceResponse(
      pendingAnchorSchema.parse(
        JSON.parse(await local(required("pending"), MAX_ANCHOR_BYTES)),
      ),
      parsePacket(await local(required("packet"), MAX_PACKET_BYTES)),
      trust,
      required("tx-hash"),
      required("rpc-url"),
    );
  else {
    const verified = await verifyInferenceAnchors(
      parseInferenceAnchorEvidence(
        await local(required("evidence"), MAX_ANCHOR_BYTES),
      ),
      parsePacket(await local(required("packet"), MAX_PACKET_BYTES)),
      { trust, rpcUrl: values["rpc-url"], verifyHardware: values.hardware },
    );
    result = {
      schema: "razor.inference-anchor-report",
      version: 1,
      ...verified,
    };
    process.exitCode = verified.claims.some((item) => item.status === "failed")
      ? 1
      : verified.claims.some((item) =>
            ["unavailable", "not_checked"].includes(item.status),
          )
        ? 2
        : 0;
  }
  await writePrivateJson(values.output, result, 256 * 1024);
  process.stdout.write(
    `Saved a new local ${command} file. ${command === "prepare" || command === "response" ? "Review its unsigned wallet action and sign explicitly; no action was sent." : command === "complete" ? "Final chain references collected; hardware and source-content claims remain separate." : "No transaction was signed or sent."}\n`,
  );
  if (command === "prepare")
    process.stdout.write(INFERENCE_ANCHOR_LIMITATIONS[1] + "\n");
}

void main().catch(() => {
  process.stderr.write(
    "Inference anchor operation could not complete. Check strict local schemas, independent trust, fresh output path and explicitly selected archival endpoint; use --help. No credentials, input, endpoint or key material is printed. No transaction was signed or sent.\n",
  );
  process.exitCode = 1;
});

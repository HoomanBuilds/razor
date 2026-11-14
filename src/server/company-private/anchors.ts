import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  MAX_ANCHOR_BYTES,
  canonicalAnchor,
  inferenceAnchorChallengeSchema,
  parseInferenceAnchorTrust,
} from "../../lib/verification/inference-anchors";
import { hashText } from "../../lib/verification/verify";
import {
  createAnchoredSessionFactory,
  type AnchoredSessionEvidence,
} from "../assistant/anchored-session";
import { requirePrivateAiConfig } from "../assistant/config";

async function readAnchorInput(path: string) {
  if (!isAbsolute(path))
    throw Error("Choose absolute local anchor input paths");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_ANCHOR_BYTES)
      throw Error("Anchor input exceeds its regular-file bound");
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
    if (length !== info.size) throw Error("Anchor input changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
  } finally {
    await file.close();
  }
}

export async function companyAnchoredSession(input: {
  trustPath: string;
  challengePath: string;
  rpcUrl: string;
}) {
  const trust = parseInferenceAnchorTrust(
      await readAnchorInput(input.trustPath),
    ),
    challenge = inferenceAnchorChallengeSchema.parse(
      JSON.parse(await readAnchorInput(input.challengePath)),
    ),
    config = requirePrivateAiConfig();
  if (
    trust.expectedModel !== config.model ||
    trust.approvedGatewayComposeSha256.some(
      (hash) => !config.gatewayHashes.includes(hash),
    ) ||
    trust.approvedModelComposeSha256.some(
      (hash) => !config.modelHashes.includes(hash),
    )
  )
    throw Error(
      "Independent anchor model and measurements must also satisfy this company's local private-processing policy",
    );
  let observed: AnchoredSessionEvidence | undefined;
  const createVerifiedSession = createAnchoredSessionFactory({
    trust,
    challenge,
    rpcUrl: input.rpcUrl,
    apiKey: config.apiKey,
    maxLocalAgeMs: Math.min(config.maxAttestationAgeMs, trust.maxIntervalMs),
    onEvidence: (value) => {
      observed = value;
    },
  });
  return {
    createVerifiedSession,
    observation() {
      if (!observed)
        throw Error("No original verified anchored session was collected");
      return {
        schema: "razor.inference-anchor-session",
        version: 1,
        challenge: observed.challenge,
        originalGatewaySpki: observed.originalGatewaySpki,
        gatewayReportSha256: hashText(canonicalAnchor(observed.gatewayReport)),
        modelReportsSha256: hashText(canonicalAnchor(observed.modelReports)),
        completedChainInterval: false,
        note: "Original company-process TLS observation. Retain independently from the packet. Sign and collect the response commitment using scripts/inference-anchors.ts; this session record alone does not prove an execution interval.",
      };
    },
  };
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  MAX_PACKET_BYTES,
  parsePacket,
  verifierTrustSchema,
  type VerificationClaim,
} from "../src/lib/verification/packet";
import {
  MAX_DESTINATION_BYTES,
  parseDestinationEvidence,
  parseDestinationTrust,
} from "../src/lib/verification/destination-packet";
import {
  MAX_ANCHOR_BYTES,
  parseInferenceAnchorEvidence,
  parseInferenceAnchorTrust,
} from "../src/lib/verification/inference-anchors";
import {
  MAX_SETTLEMENT_LINK_BYTES,
  parseSettlementLinkEvidence,
  parseSettlementLinkTrust,
} from "../src/lib/verification/settlement-link";

const help = `Usage: node --max-old-space-size=512 --import tsx scripts/verify-evidence.ts [packet.json] [options]
Portable packet: --trust reviewed-trust.json --rpc-url HTTPS_ARCHIVE --hardware
Standalone destination: --destination destination.json [--destination-trust independently-reviewed.json] [--destination-rpc-url HTTPS_RPC]
Private replay: --replay /absolute/private-keys.json --replay-expectations /absolute/independently-reviewed-expectations.json --acknowledge-replay-key-disclosure (requires packet)
Inference timing: --anchors anchors.json [--anchor-trust independently-reviewed-anchor-trust.json] [--anchor-rpc-url HTTPS_ARCHIVE] [--anchor-hardware] (requires packet)
Settlement association: --settlement-link link.json [--settlement-link-trust independently-reviewed-link-trust.json] [--settlement-source-rpc-url HTTPS_NEAR_ARCHIVE] [--settlement-destination-rpc-url HTTPS_DESTINATION_RPC]
Offline by default. Loading files never authorizes RPC or collateral access. Each RPC option explicitly sends public references to your selected endpoint, without fallback or backend proxy. Hardware switches authorize official NEAR SDK Intel/NVIDIA collateral and attestation-service requests. RPC evidence is trusted node observation, not a light-client proof.
Replay files must be private owner-only regular files without links. The explicit acknowledgment permits using sensitive local secrets. Request ephemeral secrets disclose their individual fields; the reply secret unlocks ALL supported response content, reasoning and refusal fields even when expectations cover only selected digests. Expectations must come from an independent trust decision. Replay runs locally, outputs only claims/coverage and clears mutable secret references; no keys, plaintext, credentials or filenames are printed. JavaScript string copies cannot be guaranteed erased. Hardware identity, historical freshness and invoice truth remain separate.
Anchors use separate razor.inference-anchor-evidence/trust version1. Independent trust fixes reviewed contract/code, recorder, model/measurement policy, context and maximum interval. Original Gateway SPKI must be independently retained. Validator seed prediction/collusion and archival RPC assumptions prevent an unconditional wall-clock proof. Current collateral does not prove historical collateral validity.
Settlement links use separate razor.settlement-link-evidence/trust version1. Native exact unbatched execution binding and authorized cross-chain reporter statements are distinct classes. The latter is an operator association attestation, never trustless bridge causality. Destination observation is reported separately. Free-text, partial, unsupported, expired or redacted material remains unavailable. A standalone destination file never establishes payment association by matching IDs or amounts.
Limits: packet40MB; general/destination trust100KB; replay32KB each; anchor/link64KB each. No trust is adopted from exporter allowlists. Exit0 means all reported checks passed; exit1 invalid/failed; exit2 incomplete. A claim pass is limited to its stated scope.\n`;

async function local(path: string, maximum: number) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximum)
      throw Error("Verifier input exceeds its regular-file bound");
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const item = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!item.bytesRead) break;
      length += item.bytesRead;
    }
    if (!length || length > info.size || length > maximum)
      throw Error("Verifier input changed or exceeded its byte bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await file.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(help);
    return;
  }
  const switches = new Set([
    "--hardware",
    "--anchor-hardware",
    "--acknowledge-replay-key-disclosure",
  ]);
  const valueOptions = new Set([
    "--trust",
    "--rpc-url",
    "--destination",
    "--destination-trust",
    "--destination-rpc-url",
    "--replay",
    "--replay-expectations",
    "--anchors",
    "--anchor-trust",
    "--anchor-rpc-url",
    "--settlement-link",
    "--settlement-link-trust",
    "--settlement-source-rpc-url",
    "--settlement-destination-rpc-url",
  ]);
  const flags = new Map<string, string | true>();
  let file: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!option.startsWith("-")) {
      if (file) throw Error("Only one portable packet is supported");
      file = option;
      continue;
    }
    if (flags.has(option)) throw Error("Duplicate verifier option");
    if (switches.has(option)) flags.set(option, true);
    else if (
      valueOptions.has(option) &&
      args[index + 1] &&
      !args[index + 1].startsWith("-")
    )
      flags.set(option, args[++index]);
    else throw Error("Invalid verifier option; use --help");
  }
  const has = (name: string) => flags.has(name),
    value = (name: string) => {
      const result = flags.get(name);
      return typeof result === "string" ? result : undefined;
    };
  if (!file && !has("--destination") && !has("--settlement-link"))
    throw Error("Choose a packet, destination or settlement-link input");
  if (
    !file &&
    [
      "--trust",
      "--rpc-url",
      "--hardware",
      "--replay",
      "--replay-expectations",
      "--acknowledge-replay-key-disclosure",
      "--anchors",
      "--anchor-trust",
      "--anchor-rpc-url",
      "--anchor-hardware",
    ].some(has)
  )
    throw Error("Portable verification, replay and anchors require a packet");
  for (const [parent, children] of [
    ["--destination", ["--destination-trust", "--destination-rpc-url"]],
    ["--anchors", ["--anchor-trust", "--anchor-rpc-url", "--anchor-hardware"]],
    [
      "--settlement-link",
      [
        "--settlement-link-trust",
        "--settlement-source-rpc-url",
        "--settlement-destination-rpc-url",
      ],
    ],
  ] as const)
    if (!has(parent) && children.some(has))
      throw Error("Mode options require their matching evidence file");
  const replayRequested = [
    "--replay",
    "--replay-expectations",
    "--acknowledge-replay-key-disclosure",
  ].some(has);
  if (
    replayRequested &&
    ![
      "--replay",
      "--replay-expectations",
      "--acknowledge-replay-key-disclosure",
    ].every(has)
  )
    throw Error(
      "Replay requires both separate files and explicit key-disclosure acknowledgment",
    );
  const packet = file
    ? parsePacket(await local(file, MAX_PACKET_BYTES))
    : undefined;
  const trustFile = value("--trust"),
    trust = trustFile
      ? verifierTrustSchema.parse(
          JSON.parse(await local(trustFile, MAX_DESTINATION_BYTES)),
        )
      : undefined;
  const destinationFile = value("--destination"),
    destination = destinationFile
      ? parseDestinationEvidence(
          await local(destinationFile, MAX_DESTINATION_BYTES),
        )
      : undefined;
  const destinationTrustFile = value("--destination-trust"),
    destinationTrust = destinationTrustFile
      ? parseDestinationTrust(
          await local(destinationTrustFile, MAX_DESTINATION_BYTES),
        )
      : undefined;
  const anchorFile = value("--anchors"),
    anchors = anchorFile
      ? parseInferenceAnchorEvidence(await local(anchorFile, MAX_ANCHOR_BYTES))
      : undefined;
  const anchorTrustFile = value("--anchor-trust"),
    anchorTrust = anchorTrustFile
      ? parseInferenceAnchorTrust(
          await local(anchorTrustFile, MAX_ANCHOR_BYTES),
        )
      : undefined;
  const linkFile = value("--settlement-link"),
    link = linkFile
      ? parseSettlementLinkEvidence(
          await local(linkFile, MAX_SETTLEMENT_LINK_BYTES),
        )
      : undefined;
  const linkTrustFile = value("--settlement-link-trust"),
    linkTrust = linkTrustFile
      ? parseSettlementLinkTrust(
          await local(linkTrustFile, MAX_SETTLEMENT_LINK_BYTES),
        )
      : undefined;
  const claims: Array<VerificationClaim & { scope: string }> = [],
    add = (scope: string, items: VerificationClaim[]) =>
      claims.push(...items.map((item) => ({ ...item, scope })));
  const modes: Record<string, unknown> = {};
  let destinationReport:
    | Awaited<
        ReturnType<
          typeof import("../src/lib/verification/destination").verifyDestinationEvidence
        >
      >
    | undefined;
  if (replayRequested) {
    const { readLocalReplayFile } = await import(
      "../src/server/assistant/replay-local"
    );
    const { clearReplayDisclosure } = await import(
      "../src/lib/private-inference-replay/schema"
    );
    const disclosure = await readLocalReplayFile(value("--replay")!, "keys");
    if (!("sensitive" in disclosure)) throw Error("Unsupported key disclosure");
    try {
      const expected = await readLocalReplayFile(
        value("--replay-expectations")!,
        "expectations",
      );
      const { verifyPrivateInferenceReplay } = await import(
        "../src/lib/private-inference-replay/verify"
      );
      const result = verifyPrivateInferenceReplay(packet, disclosure, expected);
      modes.replay = {
        coverage: result.coverage,
        sensitiveKeyAcknowledgment: true,
        plaintextIncluded: false,
        keysIncluded: false,
      };
      add("private_replay", result.claims);
    } finally {
      clearReplayDisclosure(disclosure);
    }
  }
  if (packet) {
    const { verifyPacket } = await import("../src/lib/verification/verify");
    const rpc = value("--rpc-url");
    const lookupHistory = rpc
      ? (
          await import("../src/lib/verification/near-history")
        ).historicalNearLookup(rpc)
      : undefined;
    add(
      "portable_packet",
      await verifyPacket(packet, {
        trust,
        verifyHardware: has("--hardware"),
        lookupHistory,
      }),
    );
    modes.portablePacket = {
      hardware: has("--hardware"),
      historicalRpc: !!rpc,
    };
  }
  if (destination) {
    const { verifyDestinationEvidence } = await import(
      "../src/lib/verification/destination"
    );
    const result = await verifyDestinationEvidence(destination, {
      trust: destinationTrust,
      rpcUrl: value("--destination-rpc-url"),
      sourcePacket: packet,
    });
    destinationReport = result;
    modes.destination = {
      observation: result.observation,
      association: "unavailable_without_separate_settlement_link",
    };
    add("destination", result.claims);
  }
  if (anchors) {
    const { verifyInferenceAnchors } = await import(
      "../src/lib/verification/inference-anchors-verify"
    );
    const result = await verifyInferenceAnchors(anchors, packet!, {
      trust: anchorTrust,
      rpcUrl: value("--anchor-rpc-url"),
      verifyHardware: has("--anchor-hardware"),
    });
    modes.inferenceAnchors = {
      hardware: has("--anchor-hardware"),
      archivalRpc: has("--anchor-rpc-url"),
      intervalClass: "conditional_validator_randomness_and_selected_rpc",
      limitations: result.limitations,
    };
    add("inference_anchors", result.claims);
  }
  if (link) {
    const { verifySettlementLinkEvidence } = await import(
      "../src/lib/verification/settlement-link-verify"
    );
    const result = await verifySettlementLinkEvidence(link, {
      trust: linkTrust,
      sourceRpcUrl: value("--settlement-source-rpc-url"),
      destinationRpcUrl: value("--settlement-destination-rpc-url"),
    });
    modes.settlementLink = {
      associationClass: result.associationClass,
      associated: result.associated,
      destinationObservation: result.destinationObservation,
      limitations: result.limitations,
    };
    add("settlement_link", result.claims);
  }
  const networkEnabled = [
    "--rpc-url",
    "--hardware",
    "--destination-rpc-url",
    "--anchor-rpc-url",
    "--anchor-hardware",
    "--settlement-source-rpc-url",
    "--settlement-destination-rpc-url",
  ].some(has);
  process.stdout.write(
    JSON.stringify(
      {
        schema: "razor.verification-report",
        version: 1,
        mode: networkEnabled ? "network-enabled" : "offline",
        checks: {
          hardware: has("--hardware"),
          historicalRpc: has("--rpc-url"),
          destinationRpc: has("--destination-rpc-url"),
          replay: replayRequested,
          anchorHardware: has("--anchor-hardware"),
          anchorHistoricalRpc: has("--anchor-rpc-url"),
          settlementSourceRpc: has("--settlement-source-rpc-url"),
          settlementDestinationRpc: has("--settlement-destination-rpc-url"),
        },
        modes,
        coverage: {
          passed: claims.filter((item) => item.status === "passed").length,
          failed: claims.filter((item) => item.status === "failed").length,
          unavailable: claims.filter((item) => item.status === "unavailable")
            .length,
          notChecked: claims.filter((item) => item.status === "not_checked")
            .length,
        },
        claims,
        ...(destinationReport ? { destination: destinationReport } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = claims.some((item) => item.status === "failed")
    ? 1
    : claims.some((item) =>
          ["not_checked", "unavailable"].includes(item.status),
        )
      ? 2
      : 0;
}
void main().catch(() => {
  process.stderr.write(
    "Evidence verification could not complete. Check strict file schemas, matching mode options, explicit network choices and private owner-only replay files; use --help. No keys, plaintext, credentials, filenames or endpoint values are printed.\n",
  );
  process.exitCode = 1;
});

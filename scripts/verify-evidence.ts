import { readFile, stat } from "node:fs/promises";
import {
  MAX_PACKET_BYTES,
  parsePacket,
  verifierTrustSchema,
} from "../src/lib/verification/packet";
import { verifyPacket } from "../src/lib/verification/verify";
import { historicalNearLookup } from "../src/lib/verification/near-history";
import {
  MAX_DESTINATION_BYTES,
  parseDestinationEvidence,
  parseDestinationTrust,
} from "../src/lib/verification/destination-packet";
import { verifyDestinationEvidence } from "../src/lib/verification/destination";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: node --max-old-space-size=512 --import tsx scripts/verify-evidence.ts [packet.json] [--trust reviewed-trust.json] [--rpc-url https://archival-near-rpc] [--hardware] [--destination destination.json] [--destination-trust reviewed-destination.json] [--destination-rpc-url https://selected-destination-rpc]\nOffline by default. Files stay local. Each RPC option explicitly authorizes public references to that selected endpoint; no backend proxy or default endpoint exists. --hardware preserves official SDK Intel/NVIDIA collateral requests; public hardware evidence may leave this device.\nDestination JSON uses schema razor.destination-evidence/version1 and one strict transfer: near (FINAL receipt/log/data selector), evm (chainId, rpc_finalized ERC20 logIndex), solana (genesisHash, finalized legacy SPL instruction and exact source/destination token-account balances). Independently reviewed razor.destination-trust/version1 supplies expectedTransfer, tokenBehavior and optional expectedSource. No trust is inferred from files supplied by a packet author. Token-2022/fee extensions, missing archive balances and unsupported finality remain unavailable.\nA real destination transfer does not prove that it belongs to this Razor payment. Association remains unavailable without an authenticated cross-chain binding witness; matching packet IDs or trust-file references do not create one. Destination observations are trusted RPC evidence, not light-client proofs. No raw invoice plaintext or keys are requested.\nExit codes: 0 all reported checks passed; 1 invalid input or failed claim; 2 incomplete verification (unavailable/not checked).\n",
    );
    return;
  }
  const flags = new Map<string, string>();
  let file: string | undefined,
    hardware = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--hardware") {
      if (hardware) throw Error("Duplicate verifier option");
      hardware = true;
      continue;
    }
    if (!flag.startsWith("--")) {
      if (file) throw Error("Only one portable packet path is supported");
      file = flag;
      continue;
    }
    if (
      ![
        "--trust",
        "--rpc-url",
        "--destination",
        "--destination-trust",
        "--destination-rpc-url",
      ].includes(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--") ||
      flags.has(flag)
    )
      throw Error("Invalid or duplicate verifier option; use --help");
    flags.set(flag, args[++index]);
  }
  const destinationFile = flags.get("--destination");
  if (!file && !destinationFile)
    throw Error(
      "Load a portable packet or separate destination evidence; use --help",
    );
  if (!file && (hardware || flags.has("--trust") || flags.has("--rpc-url")))
    throw Error(
      "Portable packet hardware/history options require a packet path",
    );
  if (
    !destinationFile &&
    (flags.has("--destination-trust") || flags.has("--destination-rpc-url"))
  )
    throw Error("Destination options require separate destination evidence");
  async function local(path: string, max: number) {
    if ((await stat(path)).size > max)
      throw Error("Verifier input exceeds its file-size limit");
    const text = await readFile(path, "utf8");
    if (new TextEncoder().encode(text).length > max)
      throw Error("Verifier input exceeds its byte limit");
    return text;
  }
  const packet = file
      ? parsePacket(await local(file, MAX_PACKET_BYTES))
      : undefined,
    trustFile = flags.get("--trust"),
    trust = trustFile
      ? verifierTrustSchema.parse(JSON.parse(await local(trustFile, 100000)))
      : undefined,
    rpc = flags.get("--rpc-url");
  const claims = packet
    ? await verifyPacket(packet, {
        trust,
        verifyHardware: hardware,
        ...(rpc ? { lookupHistory: historicalNearLookup(rpc) } : {}),
      })
    : [];
  const destinationTrust = flags.get("--destination-trust"),
    destination = destinationFile
      ? await verifyDestinationEvidence(
          parseDestinationEvidence(
            await local(destinationFile, MAX_DESTINATION_BYTES),
          ),
          {
            ...(destinationTrust
              ? {
                  trust: parseDestinationTrust(
                    await local(destinationTrust, MAX_DESTINATION_BYTES),
                  ),
                }
              : {}),
            rpcUrl: flags.get("--destination-rpc-url"),
            sourcePacket: packet,
          },
        )
      : undefined;
  if (destination) claims.push(...destination.claims);
  process.stdout.write(
    JSON.stringify(
      {
        schema: "razor.verification-report",
        version: 1,
        mode:
          rpc || hardware || flags.has("--destination-rpc-url")
            ? "network-enabled"
            : "offline",
        checks: {
          hardware,
          historicalRpc: !!rpc,
          destinationRpc: flags.has("--destination-rpc-url"),
        },
        claims,
        ...(destination ? { destination } : {}),
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
    "Evidence verification could not complete. Check local JSON schemas, file bounds and explicit RPC options; use --help. No secrets or endpoint credentials are printed.\n",
  );
  process.exitCode = 1;
});

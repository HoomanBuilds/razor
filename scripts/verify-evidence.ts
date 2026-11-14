import { readFile, stat } from "node:fs/promises";
import { MAX_PACKET_BYTES, parsePacket, verifierTrustSchema } from "../src/lib/verification/packet";
import { verifyPacket } from "../src/lib/verification/verify";
import { historicalNearLookup } from "../src/lib/verification/near-history";

async function main() {
  const [file, ...args] = process.argv.slice(2);
  if (file === "--help") {
    process.stdout.write('Usage: node --max-old-space-size=512 --import tsx scripts/verify-evidence.ts packet.json [--trust reviewed-trust.json] [--rpc-url https://your-archival-near-rpc] [--hardware]\nOffline by default. Files never upload to Razor. RPC mode sends public chain references to the selected endpoint. --hardware permits official SDK Intel/NVIDIA collateral and attestation-service requests; public hardware evidence may leave this device.\nExit codes: 0 all checks passed; 1 invalid input or failed claims; 2 incomplete verification (unavailable or not checked).\nTrust input example: {"schema":"razor.verifier-trust","version":1,"expectedModel":"reviewed-model-id","expectedSigner":{"signingAlgo":"ed25519","signingAddress":"reviewed-public-key-hex"},"approvedModelComposeSha256":["reviewed-compose-sha256"],"hardware":{"acceptedTcbStatuses":["UpToDate"],"requireGpuEvidence":true}}\nObtain trust inputs independently. Hardware mode authenticates retained quotes and measured deployments with current collateral, then binds the encrypted wire signature to the authenticated signer. Historical freshness, plaintext binding and destination settlement remain separate and incomplete.\n');
    return;
  }
  if (!file) throw new Error("An evidence packet path is required; use --help for options");
  const flags = new Map<string, string>();
  let hardware = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--hardware") {
      if (hardware) throw new Error("Duplicate verifier option");
      hardware = true;
      continue;
    }
    if (!["--trust", "--rpc-url"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Invalid verifier option; use --help for options");
    if (flags.has(flag)) throw new Error("Duplicate verifier option");
    flags.set(flag, args[++index]);
  }
  if ((await stat(file)).size > MAX_PACKET_BYTES) throw new Error("Evidence packet exceeds 40 MB");
  const packet = parsePacket(await readFile(file, "utf8"));
  const trustFile = flags.get("--trust");
  if (trustFile && (await stat(trustFile)).size > 100_000) throw new Error("Trust input exceeds 100 KB");
  const trust = trustFile ? verifierTrustSchema.parse(JSON.parse(await readFile(trustFile, "utf8"))) : undefined;
  const rpc = flags.get("--rpc-url"), claims = await verifyPacket(packet, { trust, verifyHardware: hardware, ...(rpc ? { lookupHistory: historicalNearLookup(rpc) } : {}) });
  process.stdout.write(JSON.stringify({ schema: "razor.verification-report", version: 1, mode: rpc || hardware ? "network-enabled" : "offline", checks: { hardware, historicalRpc: Boolean(rpc) }, claims }, null, 2) + "\n");
  process.exitCode = claims.some(item => item.status === "failed") ? 1 : claims.some(item => ["not_checked", "unavailable"].includes(item.status)) ? 2 : 0;
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Evidence verification failed"}\n`);
  process.exitCode = 1;
});

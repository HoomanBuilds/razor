"use client";

import { useRef, useState } from "react";
import {
  MAX_PACKET_BYTES,
  parsePacket,
  verifierTrustSchema,
  type PortablePacket,
  type VerificationClaim,
  type VerifierTrust,
} from "@/lib/verification/packet";
import { historicalNearLookup } from "@/lib/verification/near-history";
import { verifyPacket } from "@/lib/verification/verify";
import {
  MAX_DESTINATION_BYTES,
  parseDestinationEvidence,
  parseDestinationTrust,
  type DestinationEvidence,
  type DestinationTrust,
} from "@/lib/verification/destination-packet";
import { verifyDestinationEvidence } from "@/lib/verification/destination";

export function PacketVerifier() {
  const [packet, setPacket] = useState<PortablePacket | null>(null),
    [trust, setTrust] = useState<VerifierTrust | undefined>(),
    [claims, setClaims] = useState<VerificationClaim[] | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [rpcUrl, setRpcUrl] = useState(""),
    [networkEnabled, setNetworkEnabled] = useState(false);
  const [hardwareEnabled, setHardwareEnabled] = useState(false);
  const [destination, setDestination] = useState<DestinationEvidence | null>(
      null,
    ),
    [destinationTrust, setDestinationTrust] = useState<
      DestinationTrust | undefined
    >(),
    [destinationEnabled, setDestinationEnabled] = useState(false),
    [destinationRpc, setDestinationRpc] = useState("");
  const running = useRef(false);
  async function readFile(
    file: File | undefined,
    kind: "packet" | "trust" | "destination" | "destination trust",
  ) {
    setClaims(null);
    setError("");
    if (kind === "packet") setPacket(null);
    else if (kind === "trust") setTrust(undefined);
    else if (kind === "destination") setDestination(null);
    else setDestinationTrust(undefined);
    if (!file) return;
    setBusy(true);
    try {
      if (
        file.size >
        (kind === "packet" ? MAX_PACKET_BYTES : MAX_DESTINATION_BYTES)
      )
        throw new Error("Verifier input exceeds its byte limit");
      const text = await file.text();
      if (kind === "packet") setPacket(parsePacket(text));
      else if (kind === "trust")
        setTrust(verifierTrustSchema.parse(JSON.parse(text)));
      else if (kind === "destination")
        setDestination(parseDestinationEvidence(text));
      else setDestinationTrust(parseDestinationTrust(text));
    } catch {
      setError(
        `Invalid ${kind} file. Check the JSON format, version and size.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    if ((!packet && !destination) || running.current) return;
    running.current = true;
    setBusy(true);
    setClaims(null);
    setError("");
    try {
      if (!packet && (hardwareEnabled || networkEnabled))
        throw new Error(
          "Portable packet is required for hardware/history mode",
        );
      const results = packet
        ? await verifyPacket(packet, {
            trust,
            verifyHardware: hardwareEnabled,
            ...(networkEnabled
              ? { lookupHistory: historicalNearLookup(rpcUrl) }
              : {}),
          })
        : [];
      if (destination) {
        const observed = await verifyDestinationEvidence(destination, {
          trust: destinationTrust,
          rpcUrl: destinationEnabled ? destinationRpc : undefined,
          sourcePacket: packet ?? undefined,
        });
        results.push(...observed.claims);
      }
      setClaims(results);
    } catch {
      setError(
        "Verification could not run. Check the local packet/destination JSON, independent trust inputs and explicitly selected RPC URLs. Hardware/history options require a portable packet.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="min-w-0 space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        Open an exported JSON packet to verify its disclosed encrypted wire
        bytes and model signature on this device. No workspace sign-in, AI key
        or file upload is required. Hardware identity, decrypted content and
        destination settlement are separate claims.
      </p>
      <fieldset
        disabled={busy}
        className="grid min-w-0 grid-cols-1 gap-5 rounded-xl border p-5"
      >
        <label className="grid gap-2 text-sm font-medium">
          Evidence packet (JSON, up to 40 MB)
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) =>
              void readFile(event.target.files?.[0], "packet")
            }
          />
        </label>
        <label className="grid gap-2 text-sm font-medium">
          Optional independently reviewed trust input (JSON, up to 100 KB)
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) =>
              void readFile(event.target.files?.[0], "trust")
            }
          />
          <span className="font-normal text-xs leading-5 text-muted-foreground">
            Obtain expected signer, deployment hashes and financial references
            from a source you trust. An allowlist supplied by the packet author
            does not establish trust. This input checks expectations; it does
            not replace Intel/NVIDIA hardware verification.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={hardwareEnabled}
            onChange={(event) => {
              setHardwareEnabled(event.target.checked);
              setClaims(null);
            }}
          />
          <span>
            Revalidate hardware reports with the official NEAR SDK. This permits
            Intel/NVIDIA collateral and attestation-service requests, including
            SDK proxy endpoints. Public quote/GPU evidence may leave this
            device. Current hardware trust does not prove the original execution
            time or decrypted content.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={networkEnabled}
            onChange={(event) => {
              setNetworkEnabled(event.target.checked);
              setClaims(null);
            }}
          />
          <span>
            Enable historical NEAR RPC lookups. This sends public contract,
            payment and transaction references to the RPC you choose. When both
            network options are off, checks remain offline.
          </span>
        </label>
        {networkEnabled && (
          <label className="grid gap-2 text-sm font-medium">
            Archival NEAR RPC URL
            <input
              type="url"
              required
              className="rounded-md border bg-background p-2 font-normal"
              placeholder="https://your-archival-near-rpc"
              value={rpcUrl}
              onChange={(event) => {
                setRpcUrl(event.target.value);
                setClaims(null);
              }}
            />
            <span className="font-normal text-xs text-muted-foreground">
              The selected RPC is a trusted observation source. Lookups use the
              execution block, with no fallback to current state. RPC responses
              are not light-client proofs.
            </span>
          </label>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4">
          <h3 className="text-sm font-medium">
            Separate destination transfer observation
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            Load strict public transaction references for native NEP141, ERC20
            or legacy SPL. This neither modifies portable packet v1 nor uploads
            files. A real transfer and matching IDs do not authenticate a
            source-to-destination Razor payment link. Unsupported finality,
            fees, Token-2022 extensions or missing archive data remain
            unavailable.
          </p>
          <label className="grid min-w-0 gap-2 text-sm font-medium">
            Destination evidence (JSON, up to 100 KB)
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) =>
                void readFile(event.target.files?.[0], "destination")
              }
            />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-medium">
            Independent expected destination trust (JSON, up to 100 KB)
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) =>
                void readFile(event.target.files?.[0], "destination trust")
              }
            />
            <span className="text-xs font-normal text-muted-foreground">
              Review the actual network/genesis or chain ID, token
              behavior/contract, exact transaction/event, source/recipient
              identities and base-unit amount independently. An
              exporter-authored trust file cannot establish your intent.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={destinationEnabled}
              onChange={(event) => {
                setDestinationEnabled(event.target.checked);
                setClaims(null);
              }}
            />
            <span>
              Authorize public destination references to the RPC I select. There
              is no default endpoint, backend proxy, live wallet action or
              automatic network request when files are opened.
            </span>
          </label>
          {destinationEnabled && (
            <label className="grid min-w-0 gap-2 text-sm font-medium">
              Destination RPC URL
              <input
                type="url"
                required
                className="min-w-0 rounded-md border bg-background p-2 font-normal"
                value={destinationRpc}
                placeholder="https://your-selected-destination-rpc"
                onChange={(event) => {
                  setDestinationRpc(event.target.value);
                  setClaims(null);
                }}
              />
              <span className="text-xs font-normal text-muted-foreground">
                HTTPS or explicit loopback HTTP only. Browser CORS may make an
                endpoint unavailable. RPC observations are trusted node
                responses, not light-client proofs. ERC20 checks require
                finalized blocks and historical balance queries. SPL checks
                require exact pre/post token-account balances and exclude
                Token-2022.
              </span>
            </label>
          )}
          {destination && (
            <p className="break-words text-xs text-muted-foreground">
              Loaded {destination.transfer.kind} transfer of{" "}
              {destination.transfer.amount} exact base units. No USD price or
              quote conversion is inferred.
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={
            (!packet && !destination) ||
            busy ||
            (networkEnabled && !rpcUrl) ||
            (destinationEnabled && (!destination || !destinationRpc))
          }
          onClick={() => void verify()}
          className="justify-self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Checking evidence..." : "Verify locally"}
        </button>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {packet && (
        <p className="break-all text-xs text-muted-foreground">
          Loaded {packet.subject.kind}: {packet.subject.id}. Disclosure:{" "}
          {packet.disclosure.mode}. The subject association and observed
          execution time remain exporter assertions.
        </p>
      )}
      {claims && (
        <div aria-live="polite" className="space-y-4">
          <p className="text-sm font-medium">
            {claims.filter((item) => item.status === "passed").length} passed,{" "}
            {claims.filter((item) => item.status === "failed").length} failed,{" "}
            {claims.filter((item) => item.status === "unavailable").length}{" "}
            unavailable,{" "}
            {claims.filter((item) => item.status === "not_checked").length} not
            checked. Read each claim's scope.
          </p>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Independent evidence verification results
              </caption>
              <thead className="bg-muted">
                <tr>
                  <th scope="col" className="p-3">
                    Claim
                  </th>
                  <th scope="col" className="p-3">
                    Result
                  </th>
                  <th scope="col" className="p-3">
                    Scope and limitations
                  </th>
                </tr>
              </thead>
              <tbody>
                {claims.map((item) => (
                  <tr key={item.claim} className="border-t align-top">
                    <th scope="row" className="break-words p-3 font-medium">
                      {item.claim.replaceAll("_", " ")}
                    </th>
                    <td className="whitespace-nowrap p-3">
                      {item.status.replaceAll("_", " ")}
                    </td>
                    <td className="min-w-64 p-3 leading-6 text-muted-foreground">
                      {item.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        No signature proves that an invoice or model conclusion is factually
        correct. Downloaded files cannot be revoked or expired remotely. Share
        only the disclosure you intend to make. Destination transfer observation
        never proves decrypted invoice correctness or that a packet subject
        authorized the transfer.
      </p>
      <details className="min-w-0 text-xs">
        <summary className="cursor-pointer font-medium">
          Trust file format and local command
        </summary>
        <p className="my-3 leading-5 text-muted-foreground">
          Replace the example values with independently reviewed inputs. Omit
          fields you cannot independently establish. Trust files never come from
          automatic packet allowlists.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3">
          {
            '{"schema":"razor.verifier-trust","version":1,"expectedModel":"reviewed-model-id","expectedSigner":{"signingAlgo":"ed25519","signingAddress":"reviewed-public-key-hex"},"approvedModelComposeSha256":["reviewed-compose-sha256"]}'
          }
        </pre>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-3">
          node --max-old-space-size=512 --import tsx scripts/verify-evidence.ts
          packet.json --trust reviewed-trust.json
        </pre>
        <pre className="mt-3 max-w-full overflow-x-auto rounded-lg bg-muted p-3">
          node --max-old-space-size=512 --import tsx scripts/verify-evidence.ts
          --destination destination.json --destination-trust
          independently-reviewed-destination.json --destination-rpc-url
          https://your-selected-rpc
        </pre>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Destination evidence format:{" "}
          {`{"schema":"razor.destination-evidence","version":1,"transfer":{"kind":"evm","chainId":1,"transactionHash":"0x...","tokenContract":"0x...","sender":"0x...","recipient":"0x...","amount":"1000000","logIndex":0,"finality":"rpc_finalized"}}`}
          . Replace placeholders with real independently checked identities.
          Expected destination trust uses schema razor.destination-trust/version
          1, expectedTransfer with the same strict shape and tokenBehavior
          standard_erc20 (or standard_nep141 / legacy_spl for its chain). Source
          association remains unavailable.
        </p>
        <p className="mt-3 leading-5 text-muted-foreground">
          The standalone CLI exits 1 for failed claims or invalid input and 2
          for incomplete verification. Use --help for RPC options and limits.
        </p>
      </details>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  MAX_PACKET_BYTES,
  parsePacket,
  verifierTrustSchema,
  type PortablePacket,
  type VerificationClaim,
  type VerifierTrust,
} from "@/lib/verification/packet";
import {
  MAX_DESTINATION_BYTES,
  parseDestinationEvidence,
  parseDestinationTrust,
  type DestinationEvidence,
  type DestinationTrust,
} from "@/lib/verification/destination-packet";
import {
  MAX_ANCHOR_BYTES,
  parseInferenceAnchorEvidence,
  parseInferenceAnchorTrust,
  type InferenceAnchorEvidence,
  type InferenceAnchorTrust,
} from "@/lib/verification/inference-anchors";
import {
  MAX_SETTLEMENT_LINK_BYTES,
  parseSettlementLinkEvidence,
  parseSettlementLinkTrust,
  type SettlementLinkEvidence,
  type SettlementLinkTrust,
} from "@/lib/verification/settlement-link";
import {
  clearReplayDisclosure,
  parseReplayDisclosure,
  parseReplayExpectations,
  REPLAY_MAX_DISCLOSURE_BYTES,
  REPLAY_MAX_EXPECTATIONS_BYTES,
  type ReplayDisclosure,
  type ReplayExpectations,
} from "@/lib/private-inference-replay/schema";

interface Inputs {
  packet?: PortablePacket;
  trust?: VerifierTrust;
  destination?: DestinationEvidence;
  destinationTrust?: DestinationTrust;
  replayExpectations?: ReplayExpectations;
  anchors?: InferenceAnchorEvidence;
  anchorTrust?: InferenceAnchorTrust;
  link?: SettlementLinkEvidence;
  linkTrust?: SettlementLinkTrust;
}
type InputKind = keyof Inputs;
interface NetworkOptions {
  hardware: boolean;
  history: boolean;
  historyRpc: string;
  destination: boolean;
  destinationRpc: string;
  anchorHardware: boolean;
  anchorHistory: boolean;
  anchorRpc: string;
  linkSource: boolean;
  linkSourceRpc: string;
  linkDestination: boolean;
  linkDestinationRpc: string;
}
const defaults: NetworkOptions = {
  hardware: false,
  history: false,
  historyRpc: "",
  destination: false,
  destinationRpc: "",
  anchorHardware: false,
  anchorHistory: false,
  anchorRpc: "",
  linkSource: false,
  linkSourceRpc: "",
  linkDestination: false,
  linkDestinationRpc: "",
};
type ScopedClaim = VerificationClaim & { scope: string };
interface Results {
  claims: ScopedClaim[];
  summary: string[];
  network: boolean;
}
const field = "min-w-0 rounded-md border bg-background p-2 font-normal";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-4 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}
function FileInput({
  label,
  maximum,
  disabled,
  onFile,
}: {
  label: string;
  maximum: number;
  disabled?: boolean;
  onFile: (file?: File) => void;
}) {
  return (
    <label className="grid min-w-0 gap-2 text-sm font-medium">
      {label}
      <input
        type="file"
        accept="application/json,.json"
        disabled={disabled}
        onChange={(event) => onFile(event.currentTarget.files?.[0])}
      />
      <span className="text-xs font-normal text-muted-foreground">
        JSON up to {Math.ceil(maximum / 1024)} KB. Selected files stay local.
      </span>
      <button
        type="button"
        className="justify-self-start text-xs underline disabled:opacity-50"
        disabled={disabled}
        onClick={() => onFile(undefined)}
      >
        Clear this input
      </button>
    </label>
  );
}
function Choice({
  children,
  checked,
  onChange,
  disabled,
}: {
  children: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{children}</span>
    </label>
  );
}
function RpcInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-2 text-sm font-medium">
      {label}
      <input
        type="url"
        className={field}
        value={value}
        maxLength={2048}
        placeholder="https://your-selected-archival-rpc"
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <span className="text-xs font-normal text-muted-foreground">
        Only explicitly chosen endpoints are used. HTTPS or loopback HTTP;
        browser CORS or missing archive data may make evidence unavailable. RPC
        responses are trusted observations, not light-client proofs.
      </span>
    </label>
  );
}

export function PacketVerifier({
  initialPacket,
  sourceNote,
}: { initialPacket?: PortablePacket; sourceNote?: string } = {}) {
  const [inputs, setInputs] = useState<Inputs>({}),
    [options, setOptions] = useState<NetworkOptions>(defaults),
    [results, setResults] = useState<Results | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [replayEnabled, setReplayEnabled] = useState(false),
    [acknowledged, setAcknowledged] = useState(false),
    [hasKeys, setHasKeys] = useState(false),
    [fileEpoch, setFileEpoch] = useState(0),
    [keyEpoch, setKeyEpoch] = useState(0);
  const running = useRef(false),
    generation = useRef(0),
    mounted = useRef(true),
    replayKeys = useRef<ReplayDisclosure | null>(null);
  function invalidate() {
    generation.current++;
    setResults(null);
    setError("");
    return generation.current;
  }
  function dropKeys(resetAcknowledgment = true) {
    clearReplayDisclosure(replayKeys.current);
    replayKeys.current = null;
    setHasKeys(false);
    setKeyEpoch((value) => value + 1);
    if (resetAcknowledgment) setAcknowledged(false);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      clearReplayDisclosure(replayKeys.current);
      replayKeys.current = null;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setResults(null);
    setError("");
    clearReplayDisclosure(replayKeys.current);
    replayKeys.current = null;
    setHasKeys(false);
    setAcknowledged(false);
    setReplayEnabled(false);
    setOptions(defaults);
    setFileEpoch((value) => value + 1);
    try {
      setInputs(
        initialPacket
          ? { packet: parsePacket(JSON.stringify(initialPacket)) }
          : {},
      );
    } catch {
      setInputs({});
      setError(
        "The supplied packet is invalid or exceeds its disclosure bound. No trust was adopted.",
      );
    }
  }, [initialPacket]);
  function setOption<K extends keyof NetworkOptions>(
    key: K,
    value: NetworkOptions[K],
  ) {
    invalidate();
    setOptions((previous) => ({ ...previous, [key]: value }));
  }
  async function loadPublic(kind: InputKind, file?: File) {
    if (running.current) return;
    running.current = true;
    const stamp = invalidate();
    dropKeys();
    setBusy(true);
    setInputs((previous) => {
      const next = { ...previous };
      delete next[kind];
      return next;
    });
    try {
      if (!file) return;
      const maximum =
        kind === "packet"
          ? MAX_PACKET_BYTES
          : kind === "replayExpectations"
            ? REPLAY_MAX_EXPECTATIONS_BYTES
            : kind === "anchors" || kind === "anchorTrust"
              ? MAX_ANCHOR_BYTES
              : kind === "link" || kind === "linkTrust"
                ? MAX_SETTLEMENT_LINK_BYTES
                : MAX_DESTINATION_BYTES;
      if (!file.size || file.size > maximum) throw Error("Input bound");
      const text = await file.text();
      if (new TextEncoder().encode(text).length > maximum)
        throw Error("Input bound");
      let parsed: Inputs[InputKind];
      if (kind === "packet") parsed = parsePacket(text);
      else if (kind === "trust")
        parsed = verifierTrustSchema.parse(JSON.parse(text));
      else if (kind === "destination") parsed = parseDestinationEvidence(text);
      else if (kind === "destinationTrust")
        parsed = parseDestinationTrust(text);
      else if (kind === "replayExpectations")
        parsed = parseReplayExpectations(text);
      else if (kind === "anchors") parsed = parseInferenceAnchorEvidence(text);
      else if (kind === "anchorTrust") parsed = parseInferenceAnchorTrust(text);
      else if (kind === "link") parsed = parseSettlementLinkEvidence(text);
      else parsed = parseSettlementLinkTrust(text);
      if (mounted.current && generation.current === stamp)
        setInputs((previous) => ({ ...previous, [kind]: parsed }));
    } catch {
      if (mounted.current && generation.current === stamp)
        setError(
          "Invalid selected JSON file. Check its schema, version and byte limit. No input was uploaded.",
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadKeys(file?: File) {
    if (running.current || !replayEnabled || !acknowledged) return;
    running.current = true;
    const stamp = invalidate();
    dropKeys(false);
    setBusy(true);
    let disclosure: ReplayDisclosure | null = null;
    try {
      if (!file) return;
      if (!file.size || file.size > REPLAY_MAX_DISCLOSURE_BYTES)
        throw Error("Input bound");
      disclosure = parseReplayDisclosure(await file.text());
      if (!mounted.current || generation.current !== stamp) return;
      replayKeys.current = disclosure;
      disclosure = null;
      setHasKeys(true);
    } catch {
      if (mounted.current && generation.current === stamp)
        setError(
          "Replay key disclosure is invalid, unsupported or larger than 32 KB. Its content is never printed or uploaded.",
        );
    } finally {
      clearReplayDisclosure(disclosure);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function clearAll() {
    invalidate();
    dropKeys();
    setInputs({});
    setOptions(defaults);
    setReplayEnabled(false);
    setFileEpoch((value) => value + 1);
  }
  const dependenciesMissing =
    ((options.hardware ||
      options.history ||
      inputs.trust ||
      inputs.anchors ||
      replayEnabled) &&
      !inputs.packet) ||
    (replayEnabled &&
      (!acknowledged || !hasKeys || !inputs.replayExpectations)) ||
    (options.history && !options.historyRpc.trim()) ||
    (inputs.destinationTrust && !inputs.destination) ||
    (options.destination &&
      (!inputs.destination || !options.destinationRpc.trim())) ||
    ((inputs.anchorTrust || options.anchorHistory || options.anchorHardware) &&
      !inputs.anchors) ||
    ((options.anchorHistory || options.anchorHardware) &&
      !inputs.anchorTrust) ||
    (options.anchorHistory && !options.anchorRpc.trim()) ||
    (inputs.linkTrust && !inputs.link) ||
    ((options.linkSource || options.linkDestination) &&
      (!inputs.link || !inputs.linkTrust)) ||
    (options.linkSource && !options.linkSourceRpc.trim()) ||
    (options.linkDestination && !options.linkDestinationRpc.trim());
  async function verify() {
    if (
      running.current ||
      dependenciesMissing ||
      (!inputs.packet && !inputs.destination && !inputs.link)
    )
      return;
    running.current = true;
    const stamp = invalidate();
    setBusy(true);
    const current = () => mounted.current && generation.current === stamp;
    const claims: ScopedClaim[] = [],
      summary: string[] = [],
      add = (scope: string, values: VerificationClaim[]) =>
        claims.push(...values.map((item) => ({ ...item, scope })));
    try {
      if (replayEnabled) {
        const disclosure = replayKeys.current;
        if (!disclosure || !acknowledged || !inputs.replayExpectations)
          throw Error("Replay disclosure required");
        try {
          const { verifyPrivateInferenceReplay } = await import(
            "@/lib/private-inference-replay/verify"
          );
          if (!current()) return;
          const result = verifyPrivateInferenceReplay(
            inputs.packet,
            disclosure,
            inputs.replayExpectations,
          );
          add("Private replay", result.claims);
          summary.push(
            `Replay coverage: ${result.coverage.replayedFields}/${result.coverage.totalWireFields} wire fields; ${result.coverage.expectedFields} separately expected; ${result.coverage.complete ? "complete" : "incomplete"}. No plaintext is displayed. Mutable key references were cleared after use.`,
          );
        } finally {
          clearReplayDisclosure(disclosure);
          if (replayKeys.current === disclosure) replayKeys.current = null;
          if (mounted.current) {
            setHasKeys(false);
            setAcknowledged(false);
            setKeyEpoch((value) => value + 1);
          }
        }
      }
      if (!current()) return;
      if (inputs.packet) {
        const { verifyPacket } = await import("@/lib/verification/verify");
        const lookupHistory = options.history
          ? (
              await import("@/lib/verification/near-history")
            ).historicalNearLookup(options.historyRpc.trim())
          : undefined;
        if (!current()) return;
        add(
          "Portable packet",
          await verifyPacket(inputs.packet, {
            trust: inputs.trust,
            verifyHardware: options.hardware,
            lookupHistory,
          }),
        );
      }
      if (!current()) return;
      if (inputs.destination) {
        const { verifyDestinationEvidence } = await import(
          "@/lib/verification/destination"
        );
        if (!current()) return;
        const result = await verifyDestinationEvidence(inputs.destination, {
          trust: inputs.destinationTrust,
          rpcUrl: options.destination
            ? options.destinationRpc.trim()
            : undefined,
          sourcePacket: inputs.packet,
        });
        add("Destination observation", result.claims);
        summary.push(
          "Standalone destination evidence observes a transfer only. It does not associate that transfer with a Razor payment.",
        );
      }
      if (!current()) return;
      if (inputs.anchors) {
        const { verifyInferenceAnchors } = await import(
          "@/lib/verification/inference-anchors-verify"
        );
        if (!current()) return;
        const result = await verifyInferenceAnchors(
          inputs.anchors,
          inputs.packet!,
          {
            trust: inputs.anchorTrust,
            rpcUrl: options.anchorHistory
              ? options.anchorRpc.trim()
              : undefined,
            verifyHardware: options.anchorHardware,
          },
        );
        add("Inference anchors", result.claims);
        summary.push(
          "Inference interval class: conditional validator-randomness and selected archival-RPC evidence. This is not an unconditional wall-clock or historical-collateral proof.",
        );
      }
      if (!current()) return;
      if (inputs.link) {
        const { verifySettlementLinkEvidence } = await import(
          "@/lib/verification/settlement-link-verify"
        );
        if (!current()) return;
        const result = await verifySettlementLinkEvidence(inputs.link, {
          trust: inputs.linkTrust,
          sourceRpcUrl: options.linkSource
            ? options.linkSourceRpc.trim()
            : undefined,
          destinationRpcUrl: options.linkDestination
            ? options.linkDestinationRpc.trim()
            : undefined,
        });
        add("Settlement link", result.claims);
        summary.push(
          `Settlement association class: ${result.associationClass.replaceAll("_", " ")}. Association ${result.associated ? "verified within this class" : "unverified"}; independent destination observation ${result.destinationObservation ? "available" : "unavailable"}. Reporter attestation never establishes trustless bridge causality.`,
        );
      }
      if (current())
        setResults({
          claims,
          summary,
          network:
            options.hardware ||
            options.history ||
            options.destination ||
            options.anchorHardware ||
            options.anchorHistory ||
            options.linkSource ||
            options.linkDestination,
        });
    } catch {
      if (current())
        setError(
          "Verification could not complete. Check bounded local evidence, independent matching trust and explicitly selected network options. Unsupported or missing evidence is not a pass; no secret or plaintext is displayed.",
        );
    } finally {
      clearReplayDisclosure(replayKeys.current);
      replayKeys.current = null;
      running.current = false;
      if (mounted.current) {
        setHasKeys(false);
        setBusy(false);
      }
    }
  }
  const fileInput = (kind: InputKind, label: string, maximum: number) => (
    <FileInput
      key={`${fileEpoch}:${kind}`}
      label={label}
      maximum={maximum}
      onFile={(file) => void loadPublic(kind, file)}
    />
  );
  return (
    <div className="min-w-0 space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        Verify selected evidence on this device. No sign-in, AI credential, file
        upload or wallet action is required. Signature, private replay, hardware
        identity, conditional inference timing, source association and
        independent destination observation are separate claims.
      </p>
      {initialPacket && (
        <p className="rounded-lg border p-3 text-xs leading-5 text-muted-foreground">
          {sourceNote ??
            "A packet was supplied by this evidence page. Its source and metadata are exporter assertions. No signer, allowlist, financial expectation or trust file was adopted automatically."}
        </p>
      )}
      <fieldset
        disabled={busy}
        className="grid min-w-0 gap-5 rounded-xl border p-5"
      >
        <Section title="Portable packet v1">
          {fileInput("packet", "Evidence packet", MAX_PACKET_BYTES)}
          {fileInput(
            "trust",
            "Separately reviewed signer, deployment and financial expectations",
            MAX_DESTINATION_BYTES,
          )}
          {inputs.packet && (
            <p className="break-all text-xs text-muted-foreground">
              Loaded {inputs.packet.subject.kind}: {inputs.packet.subject.id}.
              Disclosure {inputs.packet.disclosure.mode}. Subject identity and
              exporter time are not authenticated by loading this file.
            </p>
          )}
          <Choice
            checked={options.hardware}
            onChange={(value) => setOption("hardware", value)}
          >
            Revalidate public hardware reports through the official NEAR SDK.
            Intel/NVIDIA collateral, attestation services and SDK proxy
            endpoints may receive public quote/GPU evidence. Current
            verification does not prove original execution time or plaintext.
          </Choice>
          <Choice
            checked={options.history}
            onChange={(value) => setOption("history", value)}
          >
            Authorize historical NEAR lookups for this packet's public
            contract/payment references.
          </Choice>
          {options.history && (
            <RpcInput
              label="Portable packet archival NEAR RPC"
              value={options.historyRpc}
              onChange={(value) => setOption("historyRpc", value)}
            />
          )}
        </Section>
        <Section title="Optional sensitive private replay">
          <Choice
            checked={replayEnabled}
            onChange={(value) => {
              invalidate();
              dropKeys();
              setReplayEnabled(value);
            }}
          >
            Enable local replay against independently reviewed plaintext
            digests. This does not establish hardware trust, invoice truth or
            payment authority.
          </Choice>
          {replayEnabled && (
            <>
              <p className="text-xs leading-5 text-muted-foreground">
                Use reviewed verifier code on a device you trust. Hosted browser
                JavaScript can access files you select. Request ephemeral
                secrets disclose individual request fields. The client reply
                secret unlocks every supported response content, reasoning and
                refusal field even when expectations compare only selected
                digests. No key is uploaded, stored, logged or rendered here.
                Clearing references is best effort; JavaScript string copies and
                downloaded files cannot be guaranteed erased or revoked.
              </p>
              {fileInput(
                "replayExpectations",
                "Independent expected model key, wire hashes and plaintext digests",
                REPLAY_MAX_EXPECTATIONS_BYTES,
              )}
              <Choice
                checked={acknowledged}
                onChange={(value) => {
                  invalidate();
                  if (!value) dropKeys();
                  setAcknowledged(value);
                }}
              >
                I explicitly acknowledge using this sensitive key disclosure and
                understand that a reply secret unlocks all response fields. My
                expectations came from an independent trust decision.
              </Choice>
              <FileInput
                key={`${fileEpoch}:keys:${keyEpoch}`}
                label="Sensitive local replay key file"
                maximum={REPLAY_MAX_DISCLOSURE_BYTES}
                disabled={!acknowledged}
                onFile={(file) => void loadKeys(file)}
              />
              <p className="text-xs text-muted-foreground">
                {hasKeys
                  ? "A local key disclosure is ready. Its contents are hidden and will be cleared after use."
                  : "No replay keys retained. Reload keys after each verification or input replacement."}
              </p>
            </>
          )}
        </Section>
        <Section title="Separate inference chain anchors">
          <p className="text-xs leading-5 text-muted-foreground">
            Requires the original packet's encrypted wire bodies plus separate
            razor.inference-anchor-evidence/trust v1. Independently choose
            contract/code, recorder, model measurements, context, original
            Gateway SPKI and maximum interval. The block producer can predict
            its random seed; the conditional interval never becomes an
            unconditional wall-clock proof.
          </p>
          {fileInput(
            "anchors",
            "Final challenge and response-commitment evidence",
            MAX_ANCHOR_BYTES,
          )}
          {fileInput(
            "anchorTrust",
            "Independently reviewed anchor trust",
            MAX_ANCHOR_BYTES,
          )}
          <Choice
            checked={options.anchorHistory}
            onChange={(value) => setOption("anchorHistory", value)}
          >
            Authorize bounded archival NEAR lookups for both finalized anchors,
            historical code/keys, receipts and execution timestamps.
          </Choice>
          {options.anchorHistory && (
            <RpcInput
              label="Anchor archival NEAR RPC"
              value={options.anchorRpc}
              onChange={(value) => setOption("anchorRpc", value)}
            />
          )}
          <Choice
            checked={options.anchorHardware}
            onChange={(value) => setOption("anchorHardware", value)}
          >
            Authorize official hardware/collateral verification for the exact
            chain nonce and retained wire/report commitments. Public evidence
            may leave this device; current collateral does not prove its
            historical validity.
          </Choice>
        </Section>
        <Section title="Standalone destination transfer observation">
          <p className="text-xs leading-5 text-muted-foreground">
            Strict NEP141, ERC20 or legacy SPL references. A real transfer,
            address/amount match or matching packet IDs does not establish
            payment association. Unsupported finality, fee extensions,
            Token-2022 and missing archive data remain unavailable.
          </p>
          {fileInput(
            "destination",
            "Destination evidence",
            MAX_DESTINATION_BYTES,
          )}
          {fileInput(
            "destinationTrust",
            "Independent exact destination and token behavior expectations",
            MAX_DESTINATION_BYTES,
          )}
          <Choice
            checked={options.destination}
            onChange={(value) => setOption("destination", value)}
          >
            Authorize this destination's public references to my selected RPC.
          </Choice>
          {options.destination && (
            <RpcInput
              label="Standalone destination RPC"
              value={options.destinationRpc}
              onChange={(value) => setOption("destinationRpc", value)}
            />
          )}
        </Section>
        <Section title="Separate payment settlement association">
          <p className="text-xs leading-5 text-muted-foreground">
            Separate razor.settlement-link-evidence/trust v1 supports one exact
            native treasury execution or an explicitly authorized reporter's
            structured statement committed on NEAR. Reporter association and
            destination observation are separate. Old free-text, partial,
            expired or redacted receipts cannot be reconstructed into proof.
          </p>
          {fileInput(
            "link",
            "Settlement-link evidence",
            MAX_SETTLEMENT_LINK_BYTES,
          )}
          {fileInput(
            "linkTrust",
            "Independent source, payment/route/version, reporter and destination trust",
            MAX_SETTLEMENT_LINK_BYTES,
          )}
          <Choice
            checked={options.linkSource}
            onChange={(value) => setOption("linkSource", value)}
          >
            Authorize historical NEAR source action, code, frozen terms and
            receipt lookup.
          </Choice>
          {options.linkSource && (
            <RpcInput
              label="Settlement source archival NEAR RPC"
              value={options.linkSourceRpc}
              onChange={(value) => setOption("linkSourceRpc", value)}
            />
          )}
          <Choice
            checked={options.linkDestination}
            onChange={(value) => setOption("linkDestination", value)}
          >
            Separately authorize destination RPC observation. This does not
            convert a reporter statement into trustless bridge causality.
          </Choice>
          {options.linkDestination && (
            <RpcInput
              label="Settlement-link destination RPC"
              value={options.linkDestinationRpc}
              onChange={(value) => setOption("linkDestinationRpc", value)}
            />
          )}
        </Section>
        {dependenciesMissing && (
          <p className="text-xs leading-5 text-muted-foreground">
            Complete the selected mode's inputs before checking: replay needs a
            packet, both separate files and acknowledgment; anchors need a
            packet and independent trust for network checks; network switches
            need their matching evidence and explicit RPC URL. Settlement
            network checks require independent link trust.
          </p>
        )}
        <button
          type="button"
          disabled={
            busy ||
            !!dependenciesMissing ||
            (!inputs.packet && !inputs.destination && !inputs.link)
          }
          onClick={() => void verify()}
          className="justify-self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy
            ? "Checking selected local evidence..."
            : "Verify selected evidence locally"}
        </button>
      </fieldset>
      <button type="button" className="text-sm underline" onClick={clearAll}>
        Clear local files, replay keys and results
      </button>
      <p className="text-xs text-muted-foreground">
        Clearing discards local references and invalidates late results. Public
        network requests you already authorized may finish; no background
        request starts from selecting a file.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {results && (
        <div aria-live="polite" className="space-y-4">
          <p className="text-sm font-medium">
            {results.network
              ? "Explicit network-enabled checks"
              : "Offline local checks"}
            : {results.claims.filter((item) => item.status === "passed").length}{" "}
            passed,{" "}
            {results.claims.filter((item) => item.status === "failed").length}{" "}
            failed,{" "}
            {
              results.claims.filter((item) => item.status === "unavailable")
                .length
            }{" "}
            unavailable,{" "}
            {
              results.claims.filter((item) => item.status === "not_checked")
                .length
            }{" "}
            not checked. Read each scope.
          </p>
          {results.summary.map((text, index) => (
            <p key={index} className="text-xs leading-5 text-muted-foreground">
              {text}
            </p>
          ))}
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Independent verification results by evidence class
              </caption>
              <thead className="bg-muted">
                <tr>
                  <th scope="col" className="p-3">
                    Class / claim
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
                {results.claims.map((item, index) => (
                  <tr
                    key={`${item.scope}:${item.claim}:${index}`}
                    className="border-t align-top"
                  >
                    <th scope="row" className="break-words p-3 font-medium">
                      <span className="mb-1 block text-xs text-muted-foreground">
                        {item.scope}
                      </span>
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
        Independent trust must come from a source you reviewed, never an
        exporter-provided allowlist. No signature or plaintext match proves
        invoice accuracy, model honesty, legal discharge or settlement outside
        the exact reported verification class. Downloaded disclosures cannot be
        revoked remotely.
      </p>
      <details className="min-w-0 text-xs">
        <summary className="cursor-pointer font-medium">
          Local command and input schemas
        </summary>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-3">
          node --max-old-space-size=512 --import tsx scripts/verify-evidence.ts
          --help
        </pre>
        <p className="mt-3 leading-5 text-muted-foreground">
          Portable packet: razor.portable-evidence v1 and razor.verifier-trust
          v1. Destination: razor.destination-evidence/trust v1. Private replay:
          razor.private-inference-replay-keys and
          razor.private-inference-replay-expectations v1. Anchors:
          razor.inference-anchor-evidence/trust v1. Settlement:
          razor.settlement-link-evidence/trust v1. The command is offline by
          default, requires --acknowledge-replay-key-disclosure for owner-only
          key files, prints no keys/plaintext and exits 1 for invalid/failed or
          2 for incomplete claims.
        </p>
      </details>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Download, FileCheck2 } from "lucide-react";
import { api, RequestError } from "@/lib/api";
import { usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import {
  MAX_DESTINATION_BYTES,
  parseDestinationEvidence,
  type DestinationTransfer,
} from "@/lib/verification/destination-packet";
import type { SettlementLinkSource } from "@/lib/verification/settlement-link";
import type { WalletTransaction } from "@/server/payments/types";
import { AssetIdentity } from "@/components/assets/asset-identity";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel } from "./shared";

interface Overview {
  attempt: {
    id: string;
    paymentId: string;
    state: string;
    sourceTransactionHash: string | null;
    reportedDestinationHash: string | null;
    asset: string;
    network: string;
    address: string;
    symbol?: string | null;
    decimals?: number | null;
  };
  retained: {
    id: string;
    evidence_kind: string;
    content_hash: string;
    available: boolean;
    expires_at: string;
  }[];
  limits: string;
}
export interface StructuredSettlementReport {
  statement: string;
  statementSha256: string;
  walletActions: WalletTransaction[];
  source: SettlementLinkSource;
  transfer: DestinationTransfer;
  associationClass: string;
  disclosure: string;
}
function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function displayedAmount(value: string, decimals?: number | null) {
  try {
    return decimals == null
      ? `${value} exact base units`
      : formatUnits(value, decimals);
  } catch {
    return `${value} exact base units`;
  }
}
export function SettlementLinkPanel({
  attemptId,
  onReportPrepared,
  focused = false,
}: {
  attemptId: string;
  focused?: boolean;
  onReportPrepared?: (plan: StructuredSettlementReport) => void;
}) {
  const { organization, base } = useWorkspace();
  if (
    !["company:read", "payments:read", "reports:read"].every((permission) =>
      organization.permissions?.includes(permission),
    )
  )
    return null;
  return (
    <SettlementLinkEditor
      key={`${base}:${attemptId}`}
      attemptId={attemptId}
      onReportPrepared={onReportPrepared}
      focused={focused}
    />
  );
}
function SettlementLinkEditor({
  attemptId,
  onReportPrepared,
  focused = false,
}: {
  attemptId: string;
  focused?: boolean;
  onReportPrepared?: (plan: StructuredSettlementReport) => void;
}) {
  const { base, revision, organization, notify } = useWorkspace(),
    endpoint = `${base}/settlement-links/attempts/${encodeURIComponent(attemptId)}`;
  const resource = useResource<Overview>(endpoint, revision),
    { busy, error, run } = useAction();
  const [source, setSource] = useState<SettlementLinkSource | null>(null),
    [transfer, setTransfer] = useState<DestinationTransfer | null>(null),
    [disclose, setDisclose] = useState(false),
    [prepared, setPrepared] = useState<StructuredSettlementReport | null>(null),
    [selectedReceipt, setSelectedReceipt] = useState("");
  const [step, setStep] = useState<"source" | "destination" | "review" | "export" | "prepared">("source");
  const active = useRef(true), generation = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++;
    setStep("source");
    setSource(null);
    setPrepared(null);
    setDisclose(false);
    setSelectedReceipt("");
  }, [revision]);
  const overview = resource.data,
    canApprove = organization.permissions?.includes("payments:approve"),
    unavailable = !!busy || resource.refreshing || !!resource.error;
  function changed() {
    generation.current++;
    setDisclose(false);
    setPrepared(null);
  }
  async function loadSource() {
    changed(); const request = generation.current;
    const result = await api<{ source: SettlementLinkSource }>(`${endpoint}/source`, {});
    if (!active.current || request !== generation.current) return;
    setSource(result.source); if (focused) setStep("destination");
  }
  async function loadFile(file: File) {
    const request = generation.current;
    if (file.size > MAX_DESTINATION_BYTES) throw new RequestError("Choose destination evidence smaller than 100 KB", 422, "EVIDENCE_TOO_LARGE");
    let value: DestinationTransfer;
    try { value = parseDestinationEvidence(await file.text()).transfer; } catch { throw new RequestError("Choose a valid structured destination evidence file", 422, "INVALID_DESTINATION_EVIDENCE"); }
    if (!active.current || request !== generation.current) return;
    setTransfer(value); if (focused) setStep("review");
  }
  async function prepareReport() {
    if (!source || !transfer || !disclose) return;
    const request = generation.current;
    const result = await api<StructuredSettlementReport>(`${endpoint}/prepare`, { source, transfer, reviewConfirmed: true, discloseSelectedReceipt: true });
    if (!active.current || request !== generation.current) return;
    setPrepared(result); if (focused) setStep("prepared"); notify("Delivery report prepared for separate NEAR authorization.");
  }
  async function exportEvidence(values: FormData) {
    if (!source || !transfer || !disclose) return;
    const request = generation.current, kind = source.route.kind === "direct" ? "native_execution" : "reporter_statement";
    const evidence = await api(`${endpoint}/export`, { kind, source, transfer, sourceTransaction: { transactionHash: String(values.get("hash")).trim(), signerId: String(values.get("signer")).trim().toLowerCase() }, ...(kind === "reporter_statement" ? { retainedEvidenceId: selectedReceipt } : {}), discloseSelectedReceipt: true });
    if (!active.current || request !== generation.current) return;
    download(evidence, "razor-settlement-link.json"); notify("Selected settlement evidence exported.");
  }
  if (focused) {
    const back = () => { setDisclose(false); setPrepared(null); setStep(step === "prepared" || step === "export" ? "review" : step === "review" ? "destination" : "source"); };
    const consent = <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={disclose} disabled={unavailable || !source || !transfer} className="mt-1" onChange={event => setDisclose(event.target.checked)}/><span>I reviewed this transfer and allow its selected receipt to be shared with this company and included in an export.</span></label>;
    return <section aria-busy={!!busy} className="grid gap-5">
      {step !== "source" && <button type="button" disabled={!!busy} className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground" onClick={back}><ChevronLeft size={16}/>{step === "destination" ? "Source terms" : step === "review" ? "Destination evidence" : "Evidence review"}</button>}
      <h3 className="text-xl font-medium">{step === "source" ? "Settlement evidence" : step === "destination" ? "Add destination evidence" : step === "review" ? "Review evidence" : step === "export" ? "Export settlement link" : "Report prepared"}</h3>
      {(resource.error || error) && <p role="alert" className="text-sm text-destructive">{resource.error || error}</p>}
      {resource.loading ? <Empty>Loading payment evidence...</Empty> : !overview ? <Empty>Evidence unavailable.</Empty> : <>
        <div className="grid gap-3 rounded-2xl bg-muted/50 p-5"><AssetIdentity symbol={overview.attempt.symbol ?? "Asset"} network={overview.attempt.network} assetId={overview.attempt.asset}/>{transfer && ["review", "export", "prepared"].includes(step) && <p className="text-2xl font-medium tabular-nums">{displayedAmount(transfer.amount, overview.attempt.decimals)} {overview.attempt.symbol}</p>}<Address value={overview.attempt.address} network={overview.attempt.network}/></div>
        {step === "source" && <div><Action disabled={unavailable} busy={busy === "source"} onClick={() => void run("source", loadSource)}><FileCheck2 size={15}/>Load source terms</Action></div>}
        {step === "destination" && <Field label="Destination evidence JSON"><input type="file" accept="application/json,.json" className={control} disabled={unavailable} onChange={event => { const file = event.currentTarget.files?.[0]; setTransfer(null); changed(); if (file) void run("file", () => loadFile(file)); }}/><span className="text-xs text-muted-foreground">razor.destination-evidence v1 · Up to 100 KB</span></Field>}
        {step === "review" && source && transfer && <>
          <dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Approved entitlement</dt><dd>{usd(source.amount)} USDC</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Cost ceiling</dt><dd>{usd(source.maxFee)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Receiving profile / policy</dt><dd>v{source.recipientVersion} / v{source.policyVersion}</dd></div></dl>
          <p role="status" className="text-sm text-muted-foreground">{source.route.kind === "direct" ? "Native execution evidence. Independent verification required." : "Cross-chain reporter statement. It does not prove bridge causality."}</p>
          <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Source and destination records</summary><pre className="mt-4 max-h-72 overflow-auto text-xs">{JSON.stringify({ source, transfer }, null, 2)}</pre></details>
          {canApprove && source.route.kind === "intents" && <>{consent}<p className="text-xs text-muted-foreground">The private statement is retained encrypted. Separate NEAR authorization publishes its hash.</p></>}
          <div className="flex flex-wrap justify-end gap-3 border-t pt-5"><button type="button" className="text-sm text-primary" disabled={unavailable} onClick={() => { setDisclose(false); setStep("export"); }}>Export existing evidence</button>{canApprove && source.route.kind === "intents" && <Action disabled={unavailable || !disclose} busy={busy === "prepare"} onClick={() => void run("prepare", prepareReport)}>Prepare report</Action>}</div>
        </>}
        {step === "prepared" && prepared && <>
          <p role="status" className="text-sm text-muted-foreground">Unsigned reporter statement</p>
          <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Statement and wallet calls</summary><div className="mt-4 grid gap-4"><Address value={prepared.statementSha256} label="statement hash"/><pre className="max-h-72 overflow-auto text-xs">{JSON.stringify({ statement: prepared.statement, walletActions: prepared.walletActions }, null, 2)}</pre></div></details>
          <div className="flex flex-wrap justify-end gap-3 border-t pt-5"><button type="button" className="inline-flex items-center gap-2 text-sm text-primary" disabled={unavailable} onClick={() => download({ statement: prepared.statement, walletActions: prepared.walletActions }, "razor-unsigned-settlement-report.json")}><Download size={15}/>Download</button>{onReportPrepared && <Action disabled={unavailable || !disclose} onClick={() => onReportPrepared(prepared)}>Review NEAR authorization</Action>}</div>
        </>}
        {step === "export" && source && transfer && <form className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("export", () => exportEvidence(values)); }}>
          <Field label={source.route.kind === "direct" ? "Original NEAR execution hash" : "Final NEAR reporter transaction hash"}><input name="hash" className={control} minLength={32} maxLength={64} required disabled={unavailable} defaultValue={source.route.kind === "direct" ? overview.attempt.sourceTransactionHash ?? "" : ""} spellCheck={false} autoCapitalize="none" onChange={changed}/></Field>
          <Field label="NEAR transaction signer"><input name="signer" className={control} minLength={2} maxLength={64} required disabled={unavailable} spellCheck={false} autoCapitalize="none" onChange={changed}/></Field>
          {source.route.kind === "intents" && <Field label="Retained delivery receipt"><select className={control} value={selectedReceipt} required disabled={unavailable} onChange={event => { setSelectedReceipt(event.target.value); changed(); }}><option value="">Choose receipt</option>{overview.retained.filter(item => item.evidence_kind === "settlement:delivered").map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.available ? "Retained" : "Expired/redacted"} · {item.content_hash.slice(0, 12)}</option>)}</select>{!overview.retained.some(item => item.available && item.evidence_kind === "settlement:delivered") && <span role="status" className="text-xs text-muted-foreground">No structured delivery receipt is retained.</span>}</Field>}
          {consent}
          <div className="flex justify-end border-t pt-5"><Action disabled={unavailable || !disclose || source.route.kind === "intents" && !selectedReceipt} busy={busy === "export"}><Download size={15}/>Export link</Action></div>
        </form>}
      </>}
    </section>;
  }
  return (
    <Panel
      title="Link settlement evidence"
      description="Native transfers can bind to one exact NEAR execution. Cross-chain links require an explicit authorized reporter statement; they do not prove bridge causality."
    >
      {resource.error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {resource.error}
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {resource.loading ? (
        <Empty>Loading this payment's evidence controls...</Empty>
      ) : !overview ? (
        <Empty>Settlement-link details are unavailable.</Empty>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg bg-muted p-4 text-sm">
            <AssetIdentity
              symbol={overview.attempt.symbol ?? "Asset"}
              network={overview.attempt.network}
              assetId={overview.attempt.asset}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Frozen receiving account
            </p>
            <Address
              value={overview.attempt.address}
              network={overview.attempt.network}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {overview.limits}
            </p>
          </div>
          <Action
            disabled={unavailable}
            busy={busy === "source"}
            onClick={() =>
              void run("source", async () => {
                await loadSource();
              })
            }
          >
            <FileCheck2 size={15} />
            Load reviewed source terms
          </Action>
          {source && (
            <div className="rounded-lg border p-4 text-sm">
              <p>
                Approved entitlement: <strong>{usd(source.amount)} USDC</strong>
                . Maximum payment fee: {usd(source.maxFee)} USDC.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Recipient version {source.recipientVersion}, policy version{" "}
                {source.policyVersion}. This current final snapshot is a
                preparation suggestion. Independent verification requires
                separately reviewed historical expectations.
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs">
                  Inspect source and approval hashes
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto text-xs">
                  {JSON.stringify(source, null, 2)}
                </pre>
              </details>
            </div>
          )}
          <Field
            label="Final destination evidence file"
            hint="Load razor.destination-evidence version1 JSON locally. It is sent to the company workspace only after an explicit preparation/export action. Loading it does not start RPC verification."
          >
            <input
              type="file"
              accept="application/json,.json"
              className={control}
              disabled={unavailable}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                setTransfer(null);
                changed();
                if (!file) return;
                void run("file", async () => {
                  await loadFile(file);
                });
              }}
            />
          </Field>
          {transfer && (
            <div className="rounded-lg border p-4 text-sm">
              <p>
                Selected transfer:{" "}
                <strong>
                  {displayedAmount(transfer.amount, overview.attempt.decimals)}{" "}
                  {overview.attempt.symbol ?? "asset"}
                </strong>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The display uses the recorded asset's decimals. The structured
                event, token and network still require verification.
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs">
                  Inspect exact destination event
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto text-xs">
                  {JSON.stringify(transfer, null, 2)}
                </pre>
              </details>
            </div>
          )}
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={disclose}
              disabled={unavailable || !source || !transfer}
              className="mt-0.5"
              onChange={(event) => setDisclose(event.target.checked)}
            />
            <span>
              I reviewed this exact payment, asset, amount, destination and
              public transaction/event. I explicitly allow this selected receipt
              to be sent to this company workspace and included in a local
              export. Preparing a cross-chain report retains its statement
              encrypted and later publishes only its hash through an
              independently signed NEAR action.
            </span>
          </label>
          {canApprove && source?.route.kind === "intents" && (
            <Action
              disabled={unavailable || !transfer || !disclose}
              busy={busy === "prepare"}
              onClick={() =>
                void run("prepare", async () => {
                  await prepareReport();
                })
              }
            >
              Prepare structured delivery report
            </Action>
          )}
          {prepared && (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="text-sm">{prepared.disclosure}</p>
              <p className="break-all font-mono text-xs">
                sha256:{prepared.statementSha256}
              </p>
              <details>
                <summary className="cursor-pointer text-xs">
                  Review exact statement and unsigned action
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto text-xs">
                  {JSON.stringify(
                    {
                      statement: prepared.statement,
                      walletActions: prepared.walletActions,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <div className="flex flex-wrap gap-3">
                <Action
                  disabled={unavailable}
                  onClick={() =>
                    download(
                      {
                        statement: prepared.statement,
                        walletActions: prepared.walletActions,
                      },
                      "razor-unsigned-settlement-report.json",
                    )
                  }
                >
                  <Download size={15} />
                  Download unsigned report
                </Action>
                {onReportPrepared && (
                  <Action
                    disabled={unavailable || !disclose}
                    onClick={() => onReportPrepared(prepared)}
                  >
                    Open existing NEAR report authorization
                  </Action>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Only the company's current authorized reporter or owner can
                submit the ordinary report. This panel never signs
                automatically.
              </p>
            </div>
          )}
          <form
            className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void run("export", async () => {
                await exportEvidence(values);
              });
            }}
          >
            <Field
              label={
                source?.route.kind === "direct"
                  ? "Original NEAR execution hash"
                  : "Final NEAR reporter transaction hash"
              }
            >
              <input
                key={source?.route.kind}
                name="hash"
                className={control}
                minLength={32}
                maxLength={64}
                required
                disabled={unavailable}
                defaultValue={
                  source?.route.kind === "direct"
                    ? (overview.attempt.sourceTransactionHash ?? "")
                    : ""
                }
                spellCheck={false}
                autoCapitalize="none"
                onChange={changed}
              />
            </Field>
            <Field label="NEAR transaction signer">
              <input
                name="signer"
                className={control}
                required
                minLength={2}
                maxLength={64}
                disabled={unavailable}
                spellCheck={false}
                autoCapitalize="none"
                onChange={changed}
              />
            </Field>
            {source?.route.kind === "intents" && (
              <Field label="Explicitly selected retained delivery receipt">
                <select
                  className={control}
                  value={selectedReceipt}
                  disabled={unavailable}
                  required
                  onChange={(event) => {
                    setSelectedReceipt(event.target.value);
                    changed();
                  }}
                >
                  <option value="">Choose a retained receipt</option>
                  {overview.retained
                    .filter(
                      (item) => item.evidence_kind === "settlement:delivered",
                    )
                    .map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={!item.available}
                      >
                        {item.available ? "Retained" : "Expired/redacted"}{" "}
                        sha256:{item.content_hash.slice(0, 16)}
                      </option>
                    ))}
                </select>
                {!overview.retained.some(
                  (item) =>
                    item.available &&
                    item.evidence_kind === "settlement:delivered",
                ) && (
                  <p className="text-xs text-muted-foreground">
                    No retained full-delivery statement is available. An old
                    free-text receipt cannot be converted into historical
                    structured proof.
                  </p>
                )}
              </Field>
            )}
            <div className="sm:col-span-2">
              <Action
                disabled={
                  unavailable ||
                  !source ||
                  !transfer ||
                  !disclose ||
                  (source.route.kind === "intents" && !selectedReceipt)
                }
                busy={busy === "export"}
              >
                <Download size={15} />
                Export selected settlement link
              </Action>
            </div>
          </form>
        </div>
      )}
    </Panel>
  );
}

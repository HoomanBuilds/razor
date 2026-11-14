"use client";

import { useEffect, useState } from "react";
import { Download, FileCheck2 } from "lucide-react";
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
}: {
  attemptId: string;
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
    />
  );
}
function SettlementLinkEditor({
  attemptId,
  onReportPrepared,
}: {
  attemptId: string;
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
  useEffect(() => {
    setSource(null);
    setPrepared(null);
    setDisclose(false);
    setSelectedReceipt("");
  }, [revision]);
  const overview = resource.data,
    canApprove = organization.permissions?.includes("payments:approve"),
    unavailable = !!busy || resource.refreshing || !!resource.error;
  function changed() {
    setDisclose(false);
    setPrepared(null);
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
                changed();
                const result = await api<{ source: SettlementLinkSource }>(
                  `${endpoint}/source`,
                  {},
                );
                setSource(result.source);
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
                  if (file.size > MAX_DESTINATION_BYTES)
                    throw new RequestError(
                      "Choose destination evidence smaller than 100 KB",
                      422,
                      "EVIDENCE_TOO_LARGE",
                    );
                  try {
                    setTransfer(
                      parseDestinationEvidence(await file.text()).transfer,
                    );
                  } catch {
                    throw new RequestError(
                      "Choose a valid structured destination evidence file",
                      422,
                      "INVALID_DESTINATION_EVIDENCE",
                    );
                  }
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
                  const result = await api<StructuredSettlementReport>(
                    `${endpoint}/prepare`,
                    {
                      source,
                      transfer,
                      reviewConfirmed: true,
                      discloseSelectedReceipt: true,
                    },
                  );
                  setPrepared(result);
                  notify(
                    "Structured report prepared. No wallet action was signed.",
                  );
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
                const kind =
                  source?.route.kind === "direct"
                    ? "native_execution"
                    : "reporter_statement";
                const evidence = await api(`${endpoint}/export`, {
                  kind,
                  source,
                  transfer,
                  sourceTransaction: {
                    transactionHash: String(values.get("hash")).trim(),
                    signerId: String(values.get("signer")).trim().toLowerCase(),
                  },
                  ...(kind === "reporter_statement"
                    ? { retainedEvidenceId: selectedReceipt }
                    : {}),
                  discloseSelectedReceipt: true,
                });
                download(evidence, "razor-settlement-link.json");
                notify(
                  "Selected evidence exported. Verify it with independent trust and explicitly selected RPCs.",
                );
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

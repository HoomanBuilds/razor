"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import {
  generateLocalKey,
  keyIdentity,
  loadLocalKey,
  openOffer,
  sealOffer,
  sha256,
} from "@/lib/private-agreements/crypto";
import {
  canonical,
  checkedOffer,
  localReviewSchema,
  type LocalKey,
  type OfferTerms,
  type OpenedOffer,
  type SealedBinding,
} from "@/lib/private-agreements/schema";
import type {
  companyOverview,
  CompanyPrivateTender,
  supplierOverview,
} from "@/server/private-agreements/service";
import {
  ProcurementCommercialTerms,
  QuotedPayoutIdentity,
  type QuoteAsset,
} from "../procurement-commercial";
import { useWorkspace } from "../workspace/context";
import { useAction, useResource } from "../workspace/hooks";
import {
  Action,
  control,
  Empty,
  Field,
  Panel,
  Status,
} from "../workspace/shared";
import {
  localJson,
  MandateEditor,
  OfferEditor,
  saveLocal,
  TenderEditor,
} from "./forms";

type Detail = CompanyPrivateTender;
type Invite = Detail["invites"][number];
type RecordView =
  | Invite["offers"][number]
  | Invite["mandates"][number]["rounds"][number];
type Opened = {
  id: string;
  kind: "offer" | "negotiation";
  commitment: string;
  binding: SealedBinding;
  value: OpenedOffer;
  suggestion?: OfferTerms;
};
type Mode = "company" | "supplier";
const disclosure =
  "Keys and opened terms are held in this tab's memory only. Razor serves this browser code, which can access them. Use the company-operated CLI on a trusted local checkout for a stronger company-owned key boundary. Encryption and hidden bids do not prove a hardware-private auction. Final disclosed terms are visible to Razor and both exact parties.";

function KeyControl({
  value,
  busy,
  onLoad,
  run,
}: {
  value: LocalKey | null;
  busy: boolean;
  onLoad: (key: LocalKey | null) => void;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
}) {
  return (
    <section
      className="grid min-w-0 gap-3 rounded-lg border p-4"
      aria-label="Local agreement encryption key"
    >
      <p className="text-sm font-medium">Local encryption key</p>
      <p className="text-xs leading-5 text-muted-foreground">
        {disclosure} Creating a key uses your device and costs no NEAR. Neither
        the key nor its file is uploaded.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Action
          type="button"
          disabled={busy || !!value}
          onClick={() => {
            void run("key", async () => {
              const key = await generateLocalKey();
              saveLocal("razor-agreement-private-key.json", key);
              onLoad(key);
            });
          }}
        >
          Create and download local key
        </Action>
        <label className="text-sm">
          Load an existing local key
          <input
            type="file"
            accept="application/json,.json"
            className="mt-2 block max-w-full text-xs"
            disabled={busy || !!value}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void run("load-key", async () =>
                onLoad(await loadLocalKey(await localJson(file))),
              );
            }}
          />
        </label>
        {value && (
          <>
            <button
              type="button"
              disabled={busy}
              className="text-sm text-primary"
              onClick={() =>
                saveLocal("razor-agreement-private-key.json", value)
              }
            >
              Download key backup
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-sm text-primary"
              onClick={() => onLoad(null)}
            >
              Forget key from this tab
            </button>
          </>
        )}
      </div>
      {value && (
        <p className="break-all text-xs">
          Loaded public key SHA-256: {value.keyId}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Forgetting the key does not delete downloaded files, browser memory
        copies or backups. Delete company files through your normal
        operating-system controls. NEAR AI credentials, if used by the optional
        local CLI, remain in that process environment; revoke them in your NEAR
        AI account.
      </p>
    </section>
  );
}

function binding(
  tender: Detail,
  invite: Invite,
  revision: number,
  phase: "offer" | "negotiation",
  author: Mode,
  mandateId: string | null,
): SealedBinding {
  return {
    schema: "razor.sealed-agreement",
    organizationId: tender.organization_id,
    tenderId: tender.id,
    tenderVersion: tender.current_version,
    tenderHash: tender.termsHash,
    inviteId: invite.id,
    supplierUserId: invite.supplierUserId,
    supplierVersion: invite.supplierVersion,
    revision,
    phase,
    mandateId,
    author,
  };
}

function TenderContent({
  tender,
  mode,
  base,
  localKey,
  assets,
  disabled,
  canPrepare,
  canApprove,
  canDelete,
  onMutate,
  run,
  busy,
}: {
  tender: Detail;
  mode: Mode;
  base: string;
  localKey: LocalKey | null;
  assets: readonly QuoteAsset[];
  disabled: boolean;
  canPrepare: boolean;
  canApprove: boolean;
  canDelete: boolean;
  onMutate: () => void;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
  busy: string | null;
}) {
  const [opened, setOpened] = useState<Opened | null>(null),
    active = !tender.historical && ["open", "revealed"].includes(tender.state),
    now = Date.now();
  const fresh = !disabled && !busy,
    liveAgreement = tender.agreements.find(
      (value) => value.state !== "cancelled",
    );
  const mutate = async (path: string, input: unknown) => {
    await api(path, input);
    setOpened(null);
    onMutate();
  };
  async function seal(
    invite: Invite,
    terms: OfferTerms,
    revision: number,
    mandateId: string | null = null,
  ) {
    if (!localKey)
      throw new Error("Load your saved local encryption key first");
    const expectedKey =
      mode === "company"
        ? tender.buyerPublicKey
        : (invite.replyPublicKey ?? localKey.publicKey);
    if ((await keyIdentity(expectedKey)) !== localKey.keyId)
      throw new Error(
        "The loaded local key does not match this invitation's captured encryption identity",
      );
    return sealOffer(
      binding(
        tender,
        invite,
        revision,
        mandateId ? "negotiation" : "offer",
        mode,
        mandateId,
      ),
      terms,
      [tender.buyerPublicKey, invite.replyPublicKey ?? localKey.publicKey],
    );
  }
  async function openRecord(record: RecordView, kind: "offer" | "negotiation") {
    if (!localKey)
      throw new Error(
        "Load the matching local private key or use the trusted local CLI",
      );
    const result = await api<{ envelope: Parameters<typeof openOffer>[0] }>(
        `${base}/sealed/${kind}/${record.id}`,
      ),
      value = await openOffer(result.envelope, localKey);
    checkedOffer(tender.terms, value.terms);
    setOpened({
      id: record.id,
      kind,
      commitment: record.commitment,
      binding: record.binding,
      value,
    });
  }
  function records(
    invite: Invite,
    values: RecordView[],
    kind: "offer" | "negotiation",
    mandate?: Invite["mandates"][number],
  ) {
    const authorization =
      mandate ??
      invite.mandates.filter((value) => value.state === "approved").at(-1);
    return values.map((record) => (
      <section
        key={record.id}
        className="grid min-w-0 gap-3 rounded-lg border p-3 text-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p>
            {kind === "offer"
              ? `Offer revision ${"revision" in record ? record.revision : ""}`
              : `Negotiation message ${"sequence" in record ? record.sequence : ""}`}{" "}
            · {new Date(record.created_at).toLocaleString()}
          </p>
          {"status" in record && <Status value={record.status} />}
        </div>
        <p className="break-all">Full sealed commitment: {record.commitment}</p>
        <p>
          Encrypted content{" "}
          {record.contentAvailable
            ? `retained until ${new Date(record.purge_at).toLocaleString()}`
            : "deleted"}
          . Amounts and private transcript text are absent from this hosted
          view.
        </p>
        <div className="flex flex-wrap gap-3">
          <Action
            type="button"
            disabled={
              !fresh ||
              !record.contentAvailable ||
              !localKey ||
              (mode === "company" && !tender.revealAuthorized)
            }
            onClick={() => {
              void run(`open:${record.id}`, () => openRecord(record, kind));
            }}
          >
            Open selected content in this tab
          </Action>
          <Action
            type="button"
            disabled={
              !fresh ||
              !record.contentAvailable ||
              (mode === "company" && !tender.revealAuthorized)
            }
            onClick={() => {
              void run(`export:${record.id}`, async () => {
                const result = await api<{ envelope: unknown }>(
                  `${base}/sealed/${kind}/${record.id}`,
                );
                saveLocal(`razor-sealed-${record.id}.json`, {
                  schema: "razor.private-agreement-job",
                  version: 1,
                  envelope: result.envelope,
                  tender: tender.terms,
                  buyerPublicKey: tender.buyerPublicKey,
                  mandate:
                    authorization?.state === "approved"
                      ? {
                          id: authorization.id,
                          state: "approved",
                          terms: authorization.terms,
                        }
                      : null,
                });
              });
            }}
          >
            Export encrypted job for local CLI
          </Action>
          <label className="text-xs">
            Import a locally opened review
            <input
              type="file"
              accept="application/json,.json"
              className="mt-1 block max-w-full"
              disabled={!fresh}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void run(`import:${record.id}`, async () => {
                  const review = localReviewSchema.parse(await localJson(file));
                  if (
                    review.commitment !== record.commitment ||
                    canonical(review.binding) !== canonical(record.binding) ||
                    (await sha256({
                      binding: review.binding,
                      ...review.opened,
                    })) !== record.commitment
                  )
                    throw new Error(
                      "The local review belongs to different sealed parties, terms or version",
                    );
                  checkedOffer(tender.terms, review.opened.terms);
                  if (review.suggestedTerms) {
                    if (!authorization || authorization.state !== "approved")
                      throw new Error(
                        "Suggestions require the selected independently approved mandate",
                      );
                    checkedOffer(
                      tender.terms,
                      review.suggestedTerms,
                      authorization.terms,
                    );
                  }
                  setOpened({
                    id: record.id,
                    kind,
                    commitment: record.commitment,
                    binding: record.binding,
                    value: review.opened,
                    suggestion: review.suggestedTerms,
                  });
                });
              }}
            />
          </label>
        </div>
        {canDelete && record.contentAvailable && (
          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(`delete:${record.id}`, () =>
                mutate(`${base}/sealed/${kind}/${record.id}/delete`, {
                  commitment: record.commitment,
                  deleteCiphertextAcknowledged: true,
                }),
              );
            }}
          >
            <label className="flex gap-2">
              <input type="checkbox" required disabled={!fresh} />
              Delete this hosted ciphertext copy. Metadata and any final
              disclosed terms remain.
            </label>
            <Action disabled={!fresh}>Delete encrypted copy</Action>
          </form>
        )}
      </section>
    ));
  }
  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {tender.reference} · {tender.companyName}
          </h3>
          <p className="mt-1 text-xs">
            Immutable tender version {tender.selectedVersion}, generation{" "}
            {tender.generation}
          </p>
        </div>
        <Status value={tender.historical ? "historical" : tender.state} />
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">
        {tender.terms.specification}
      </p>
      <p className="text-sm">
        Quantity {tender.terms.minimumQuantity} to {tender.terms.quantity}{" "}
        {tender.terms.unit}; complete commercial budget{" "}
        {usd(tender.terms.budget)} USDC.
      </p>
      <p className="text-xs">
        Delivery {tender.terms.deliveryFrom} to {tender.terms.deliveryTo}, UTC.
        Bids close {new Date(tender.terms.bidDeadline).toLocaleString()}. Reveal
        after {new Date(tender.terms.revealAt).toLocaleString()}. Final
        agreement and PO proposal deadline{" "}
        {new Date(tender.terms.negotiationDeadline).toLocaleString()}.
      </p>
      <p className="whitespace-pre-wrap text-xs">
        Eligibility: {tender.terms.eligibility}
        <br />
        Award rules: {tender.terms.awardRule}
      </p>
      <p className="break-all text-xs">
        Tender terms SHA-256: {tender.termsHash}
      </p>
      {mode === "company" && !tender.historical && (
        <form
          className="grid gap-3 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            const action = String(values.get("action"));
            void run(`tender:${action}`, () =>
              mutate(`${base}/tenders/${tender.id}/${action}`, {
                generation: tender.generation,
                reason: values.get("reason"),
              }),
            );
          }}
        >
          <Field label="Reason for this sourcing decision, visible to invited parties">
            <input
              name="reason"
              className={control}
              required
              minLength={3}
              maxLength={2000}
              disabled={!fresh || !canApprove}
            />
          </Field>
          <Field label="Explicit tender action">
            <select
              name="action"
              className={control}
              disabled={!fresh || !canApprove}
            >
              <option
                value="publish"
                disabled={
                  tender.state !== "draft" ||
                  now >= Date.parse(tender.terms.bidDeadline)
                }
              >
                Publish reviewed invitations
              </option>
              <option
                value="reveal"
                disabled={
                  tender.state !== "open" ||
                  now < Date.parse(tender.terms.revealAt)
                }
              >
                Reveal after agreed time
              </option>
              <option
                value="close"
                disabled={!!liveAgreement || !!tender.commitment_id}
              >
                Close with no award
              </option>
            </select>
          </Field>
          <div>
            <Action disabled={!fresh || !canApprove}>
              Apply explicit sourcing decision
            </Action>
          </div>
        </form>
      )}
      {tender.invites.map((invite) => (
        <article
          key={invite.id}
          className="grid min-w-0 gap-4 rounded-lg border p-4"
        >
          <div>
            <h4 className="font-medium">
              {invite.supplier.name} · captured profile {invite.supplierVersion}
            </h4>
            <QuotedPayoutIdentity
              asset={invite.supplier.asset}
              network={invite.supplier.network}
              assets={assets}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Actual confirmed payout preference snapshot. This workflow cannot
              redirect funds or replace that destination.
            </p>
          </div>
          {!invite.identityCurrent && (
            <p role="status" className="text-sm text-amber-900">
              This invitation is historical or its supplier identity changed.
              New offers, negotiation and agreement acceptance are held.
              Existing obligations and history remain.
            </p>
          )}
          {mode === "supplier" &&
            active &&
            invite.identityCurrent &&
            tender.state === "open" &&
            now < Date.parse(tender.terms.bidDeadline) &&
            !liveAgreement && (
              <OfferEditor
                key={`${invite.id}:${invite.offers[0]?.id ?? "new"}:${opened?.suggestion ? "suggestion" : "manual"}`}
                tender={tender.terms}
                initial={
                  opened?.binding.inviteId === invite.id
                    ? (opened.suggestion ?? opened.value.terms)
                    : undefined
                }
                busy={!fresh || !localKey || invite.offers.length >= 20}
                label="Seal and submit immutable offer revision"
                onSave={(terms) =>
                  run("offer", async () => {
                    const envelope = await seal(
                      invite,
                      terms,
                      (invite.offers[0]?.binding.revision ?? 0) + 1,
                    );
                    await mutate(`${base}/invitations/${invite.id}/offers`, {
                      expectedRevision: invite.offers[0]?.binding.revision ?? 0,
                      replyPublicKey: localKey!.publicKey,
                      envelope,
                    });
                  })
                }
              />
            )}
          {mode === "supplier" &&
            active &&
            invite.identityCurrent &&
            invite.offers[0]?.status === "submitted" &&
            !liveAgreement && (
              <form
                className="flex flex-wrap gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = new FormData(event.currentTarget);
                  void run("withdraw", () =>
                    mutate(`${base}/invitations/${invite.id}/withdraw`, {
                      expectedRevision: invite.offers[0]!.binding.revision,
                      reason: value.get("reason"),
                    }),
                  );
                }}
              >
                <input
                  name="reason"
                  className={control}
                  placeholder="Reason to withdraw the current offer"
                  minLength={3}
                  maxLength={2000}
                  required
                  disabled={!fresh}
                />
                <Action disabled={!fresh}>Withdraw current offer</Action>
              </form>
            )}
          <details>
            <summary className="cursor-pointer text-sm">
              Sealed offer history ({invite.offers.length})
            </summary>
            <div className="mt-3 grid gap-3">
              {records(invite, invite.offers, "offer")}
              {!invite.offers.length && (
                <Empty>
                  No sealed offers submitted. No bid means no agreement or PO.
                </Empty>
              )}
            </div>
          </details>
          {mode === "company" &&
            canPrepare &&
            active &&
            tender.state === "revealed" &&
            invite.identityCurrent &&
            invite.offers[0]?.status === "submitted" &&
            !liveAgreement && (
              <details>
                <summary className="cursor-pointer text-sm">
                  Create a separately authorized negotiation mandate
                </summary>
                <div className="mt-3">
                  <MandateEditor
                    tender={tender.terms}
                    busy={!fresh}
                    onSave={(terms) =>
                      run("mandate", () =>
                        mutate(`${base}/tenders/${tender.id}/mandates`, {
                          generation: tender.generation,
                          inviteId: invite.id,
                          terms,
                        }),
                      )
                    }
                  />
                </div>
              </details>
            )}
          {invite.mandates.map((mandate) => (
            <section
              key={mandate.id}
              className="grid min-w-0 gap-3 rounded-lg border p-3"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <h5 className="text-sm font-medium">
                  Bounded negotiation mandate
                </h5>
                <Status value={mandate.state} />
              </div>
              <p className="text-xs">
                Maximum {usd(mandate.terms.maximumTotal)} USDC,{" "}
                {mandate.terms.minimumQuantity} to{" "}
                {mandate.terms.maximumQuantity} {tender.terms.unit}, delivery{" "}
                {mandate.terms.deliveryFrom} to {mandate.terms.deliveryTo}.{" "}
                {mandate.terms.maximumRounds} round pairs, expires{" "}
                {new Date(mandate.terms.expiresAt).toLocaleString()}.
              </p>
              <p className="whitespace-pre-wrap text-xs">
                {mandate.terms.instruction}
              </p>
              <p className="break-all text-xs">
                Authorized terms SHA-256: {mandate.terms_hash}
              </p>
              {mode === "company" &&
                canApprove &&
                active &&
                !liveAgreement &&
                mandate.state !== "revoked" && (
                  <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void run("mandate-decision", () =>
                        mutate(`${base}/mandates/${mandate.id}/decision`, {
                          generation: tender.generation,
                          termsHash: mandate.terms_hash,
                          action: values.get("action"),
                          reason: values.get("reason"),
                        }),
                      );
                    }}
                  >
                    <select name="action" className={control} disabled={!fresh}>
                      {mandate.state === "proposed" && (
                        <option value="approve">
                          Approve as a different authorized reviewer
                        </option>
                      )}
                      <option value="revoke">Revoke this mandate</option>
                    </select>
                    <input
                      name="reason"
                      className={control}
                      required
                      minLength={3}
                      maxLength={2000}
                      placeholder="Independent authorization or revocation reason"
                      disabled={!fresh}
                    />
                    <div>
                      <Action disabled={!fresh}>Record mandate decision</Action>
                    </div>
                  </form>
                )}
              {records(invite, mandate.rounds, "negotiation", mandate)}
              {active &&
                tender.state === "revealed" &&
                !liveAgreement &&
                invite.identityCurrent &&
                mandate.state === "approved" &&
                now < Date.parse(mandate.terms.expiresAt) &&
                mandate.rounds.length < mandate.terms.maximumRounds * 2 &&
                mode ===
                  (mandate.rounds.length % 2 === 0 ? "company" : "supplier") &&
                (mode !== "company" || canPrepare) && (
                  <OfferEditor
                    key={`${mandate.id}:${mandate.rounds.length}:${opened?.id ?? "new"}`}
                    tender={tender.terms}
                    mandate={mandate.terms}
                    initial={
                      opened?.binding.inviteId === invite.id
                        ? (opened.suggestion ?? opened.value.terms)
                        : undefined
                    }
                    busy={!fresh || !localKey}
                    label={
                      mode === "company"
                        ? "Seal reviewed company counterproposal"
                        : "Seal reviewed supplier response"
                    }
                    onSave={(terms) =>
                      run("round", async () => {
                        const envelope = await seal(
                          invite,
                          terms,
                          mandate.rounds.length + 1,
                          mandate.id,
                        );
                        await mutate(`${base}/mandates/${mandate.id}/rounds`, {
                          expectedSequence: mandate.rounds.length,
                          envelope,
                        });
                      })
                    }
                  />
                )}
            </section>
          ))}
        </article>
      ))}
      {opened && (
        <section
          className="grid min-w-0 gap-3 rounded-lg border p-4"
          aria-label="Locally opened commercial terms"
        >
          <div className="flex flex-wrap justify-between gap-3">
            <h4 className="font-medium">
              Selected terms opened locally for{" "}
              {
                tender.invites.find(
                  (invite) => invite.id === opened.binding.inviteId,
                )?.supplier.name
              }
            </h4>
            <button
              type="button"
              className="text-xs text-primary"
              onClick={() => setOpened(null)}
            >
              Forget plaintext from this view
            </button>
          </div>
          <p className="text-sm">
            {opened.value.terms.quantity} {tender.terms.unit}; unit price{" "}
            {usd(opened.value.terms.unitPrice)} USDC. Exact complete total{" "}
            {usd(checkedOffer(tender.terms, opened.value.terms).total)} USDC.
          </p>
          <ProcurementCommercialTerms
            terms={checkedOffer(tender.terms, opened.value.terms).commercial}
          />
          <p className="whitespace-pre-wrap text-sm">
            {opened.value.terms.terms}
          </p>
          <p className="text-xs">
            Delivery {opened.value.terms.deliveryDate}, valid until{" "}
            {new Date(opened.value.terms.validUntil).toLocaleString()}. Opening
            is not supplier acceptance, an award, proof of truthful source
            claims or a payment.
          </p>
          {opened.suggestion && (
            <p className="text-xs">
              A local file also supplied a proposed unit price of{" "}
              {usd(opened.suggestion.unitPrice)} USDC. Its verification labels
              are exporter assertions. Use the bounded editor to review and
              reseal it as a new proposal; it is not the source commitment shown
              here.
            </p>
          )}
          {mode === "company" &&
            canApprove &&
            active &&
            tender.state === "revealed" &&
            !liveAgreement && (
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run("disclose", () =>
                    mutate(`${base}/tenders/${tender.id}/final`, {
                      generation: tender.generation,
                      sourceKind: opened.kind,
                      sourceId: opened.id,
                      opened: opened.value,
                      discloseToRazor: true,
                    }),
                  );
                }}
              >
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" required disabled={!fresh} />
                  <span>
                    Disclose only these exact selected terms and their
                    commitment salt to Razor and both agreement parties. I
                    reviewed all included and excluded charges. Both exact
                    parties must accept before a separately approved PO.
                  </span>
                </label>
                <div>
                  <Action disabled={!fresh}>
                    Publish selected final agreement for both parties
                  </Action>
                </div>
              </form>
            )}
        </section>
      )}
      {tender.agreements.map((value) => (
        <section
          key={value.id}
          className="grid min-w-0 gap-3 rounded-lg border p-4"
        >
          <div className="flex flex-wrap justify-between gap-3">
            <h4 className="font-medium">
              Final agreement version {value.version}
            </h4>
            <Status value={value.state} />
          </div>
          <p className="text-sm">
            Supplier:{" "}
            {
              tender.invites.find((invite) => invite.id === value.invite_id)
                ?.supplier.name
            }
            . {value.terms.quantity} {tender.terms.unit}; complete allowance{" "}
            {usd(value.total)} USDC.
          </p>
          <ProcurementCommercialTerms
            terms={checkedOffer(tender.terms, value.terms).commercial}
          />
          <p className="whitespace-pre-wrap text-sm">{value.terms.terms}</p>
          <p className="text-xs">
            Delivery {value.terms.deliveryDate}; valid until{" "}
            {new Date(value.terms.validUntil).toLocaleString()}. Company
            acceptance:{" "}
            {value.company_accepted_at
              ? new Date(value.company_accepted_at).toLocaleString()
              : "pending"}
            . Supplier acceptance:{" "}
            {value.supplier_accepted_at
              ? new Date(value.supplier_accepted_at).toLocaleString()
              : "pending"}
            .
          </p>
          <p className="break-all text-xs">
            Exact immutable agreement SHA-256: {value.terms_hash}
          </p>
          <p className="text-xs text-muted-foreground">{value.disclosure}</p>
          {!tender.historical &&
            value.state !== "cancelled" &&
            value.state !== "disputed" &&
            (mode !== "company" || canApprove) && (
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  void run("agreement-decision", () =>
                    mutate(`${base}/agreements/${value.id}/decision`, {
                      generation: tender.generation,
                      termsHash: value.terms_hash,
                      action: values.get("action"),
                      reason: values.get("reason"),
                    }),
                  );
                }}
              >
                <select name="action" className={control} disabled={!fresh}>
                  <option
                    value="accept"
                    disabled={
                      value.state !== "pending" ||
                      now >= Date.parse(value.terms.validUntil) ||
                      now >= Date.parse(tender.terms.negotiationDeadline)
                    }
                  >
                    Accept this exact final agreement
                  </option>
                  <option
                    value="cancel"
                    disabled={
                      value.state !== "pending" || !!value.commitment_id
                    }
                  >
                    Cancel this pending agreement proposal
                  </option>
                  <option value="dispute">
                    Record a dispute and hold this sourcing flow
                  </option>
                </select>
                <Field label="Exact-party decision reason">
                  <textarea
                    name="reason"
                    className={control}
                    minLength={3}
                    maxLength={2000}
                    required
                    disabled={!fresh}
                  />
                </Field>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" required disabled={!fresh} />I reviewed
                  this exact immutable hash and full terms. This decision
                  creates no refund or payment.
                </label>
                <div>
                  <Action disabled={!fresh}>Record exact-party decision</Action>
                </div>
              </form>
            )}
          {mode === "company" &&
            canPrepare &&
            canApprove &&
            !tender.historical &&
            value.state === "accepted" &&
            !tender.commitment_id && (
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  void run("purchase", () =>
                    mutate(`${base}/agreements/${value.id}/purchase`, {
                      generation: tender.generation,
                      termsHash: value.terms_hash,
                      purchaseReference: values.get("reference"),
                      separateApprovalAcknowledged: true,
                    }),
                  );
                }}
              >
                <Field label="One ordinary PO reference">
                  <input
                    name="reference"
                    className={control}
                    maxLength={120}
                    required
                    disabled={!fresh}
                  />
                </Field>
                <label className="flex gap-2 text-sm">
                  <input type="checkbox" required disabled={!fresh} />
                  Propose this exact allowance once. Its normal PO approval,
                  invoice matching, funding and payment approvals remain
                  separate.
                </label>
                <div>
                  <Action
                    disabled={
                      !fresh ||
                      now >= Date.parse(value.terms.validUntil) ||
                      now >= Date.parse(tender.terms.negotiationDeadline)
                    }
                  >
                    Create one unapproved PO proposal
                  </Action>
                </div>
              </form>
            )}
          {value.commitment_id && (
            <p className="break-all text-xs">
              Existing PO: {value.commitment_id}. Inspect it in Purchase
              commitments. A sourcing dispute does not revoke an already
              approved PO, pause its payments or erase delivered funds; use that
              PO's normal controls.
            </p>
          )}
        </section>
      ))}
      <details>
        <summary className="cursor-pointer text-sm">
          Party-scoped decision history
        </summary>
        <div className="mt-3 grid gap-3">
          {tender.history.map((value) => (
            <div key={value.id} className="rounded-lg border p-3 text-xs">
              <p>
                {value.kind.replaceAll("_", " ")} · {value.actor_role} ·{" "}
                {new Date(value.created_at).toLocaleString()}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{value.reason}</p>
            </div>
          ))}
        </div>
      </details>
      <p className="text-xs leading-5 text-muted-foreground">
        {tender.privacy} Ciphertext deletion keeps commitments, decision history
        and any already disclosed final terms. Local downloads, backups and
        provider records require separate company controls. Optional verified AI
        suggestions hold without configured credentials and approved
        measurements; no hosted fallback exists.
      </p>
    </div>
  );
}

export function CompanyPrivateAgreements({
  assets = [],
}: {
  assets?: readonly QuoteAsset[];
}) {
  const { organization, base, revision, refresh } = useWorkspace();
  const catalog = useResource<{ tokens: QuoteAsset[] }>(assets.length ? null : "/assets", revision);
  if (
    !["company:read", "payments:read"].every((permission) =>
      organization.permissions?.includes(permission),
    )
  )
    return null;
  return (
    <AgreementPanel
      key={organization.id}
      mode="company"
      base={`${base}/private-agreements`}
      refreshRevision={revision}
      onRefresh={refresh}
      assets={assets.length ? assets : catalog.data?.tokens ?? []}
      canPrepare={
        organization.permissions?.includes("payments:prepare") === true
      }
      canApprove={
        organization.permissions?.includes("payments:approve") === true
      }
      canDelete={
        organization.permissions?.includes("documents:manage") === true
      }
    />
  );
}
export function SupplierPrivateAgreements({
  assets = [],
  refreshRevision = 0,
}: {
  assets?: readonly QuoteAsset[];
  refreshRevision?: number;
}) {
  return (
    <AgreementPanel
      mode="supplier"
      base="/supplier-private-agreements"
      assets={assets}
      refreshRevision={refreshRevision}
      canPrepare
      canApprove
      canDelete
    />
  );
}
function AgreementPanel({
  mode,
  base,
  refreshRevision,
  onRefresh,
  assets,
  canPrepare,
  canApprove,
  canDelete,
}: {
  mode: Mode;
  base: string;
  refreshRevision: number;
  onRefresh?: () => void;
  assets: readonly QuoteAsset[];
  canPrepare: boolean;
  canApprove: boolean;
  canDelete: boolean;
}) {
  const [revision, setRevision] = useState(0),
    [selected, setSelected] = useState(""),
    [selectedVersion, setSelectedVersion] = useState(""),
    [localKey, setLocalKey] = useState<LocalKey | null>(null),
    [notice, setNotice] = useState("");
  const { busy, error, run } = useAction(),
    resource = useResource<
      ReturnType<typeof companyOverview> | ReturnType<typeof supplierOverview>
    >(base, refreshRevision + revision);
  const detail = useResource<{ tender: Detail }>(
      selected
        ? `${base}/tenders/${selected}${selectedVersion ? `?version=${selectedVersion}` : ""}`
        : null,
      refreshRevision + revision,
    ),
    tender = detail.data?.tender;
  const refresh = () => {
    setRevision((value) => value + 1);
    onRefresh?.();
    setNotice("Recorded. No financial signature or funds movement occurred.");
  };
  return (
    <Panel
      title={
        mode === "company"
          ? "Private sourcing and agreements"
          : "My sealed sourcing invitations"
      }
      description="Your sealed offers, negotiations and commercial agreements." help="Company-owned sealed offers use exact-party commercial acceptance. Ordinary purchase and payment approvals stay separate."
    >
      <div className="grid min-w-0 gap-5">
        <details className="rounded-2xl border border-border bg-white px-5 py-4"><summary className="cursor-pointer text-sm font-medium">{localKey?"Private key loaded":"Privacy keys and operator tools"}</summary><div className="mt-4 grid gap-4"><KeyControl
          value={localKey}
          busy={!!busy}
          run={run}
          onLoad={setLocalKey}
        />
        <p className="rounded-lg bg-muted/40 p-3 text-xs leading-5">
          For company-operated opening or verified price suggestions, export one
          encrypted job and use{" "}
          <code className="break-words">
            node --max-old-space-size=512 --import tsx
            scripts/private-agreements.ts --help
          </code>{" "}
          from a reviewed local checkout. Only the optional suggestion command
          contacts NEAR AI Cloud. Its fees, credentials and local file retention
          belong to that company.
        </p></div></details>
        {resource.loading ? (
          <Empty>Loading private sourcing records...</Empty>
        ) : resource.data?.tenders.length ? (
          <div className="flex flex-wrap gap-2">
            {resource.data.tenders.map((value) => (
              <Action
                key={value.id}
                type="button"
                disabled={!!busy || resource.refreshing}
                onClick={() => {
                  setSelected(value.id);
                  setSelectedVersion("");
                  setNotice("");
                }}
              >
                {value.reference} · {value.state}
              </Action>
            ))}
          </div>
        ) : (
          <Empty>
            {mode === "company"
              ? "No private tenders yet. Load or create a local key, then save your first sourcing draft."
              : "No sealed tender invitations. A company must invite your confirmed business receiving profile first."}
          </Empty>
        )}
        {resource.data &&
          mode === "company" &&
          canPrepare &&
          "roles" in resource.data && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Create a sealed tender draft
              </summary>
              <div className="mt-4">
                <TenderEditor
                  setup={resource.data}
                  buyerKey={localKey}
                  busy={!!busy || resource.refreshing}
                  onSave={(input) =>
                    run("create", async () => {
                      const result = await api<{ tender: Detail }>(base, input);
                      setSelected(result.tender.id);
                      setSelectedVersion("");
                      refresh();
                    })
                  }
                />
              </div>
            </details>
          )}
        {selected && (
          <section className="grid min-w-0 gap-4 rounded-lg border p-4">
            <div className="flex flex-wrap justify-between gap-3">
              <h3 className="text-sm font-medium">Selected tender</h3>
              <button
                type="button"
                className="text-xs text-primary"
                disabled={!!busy}
                onClick={() => {
                  setSelected("");
                  setSelectedVersion("");
                }}
              >
                Close tender
              </button>
            </div>
            {detail.loading ? (
              <Empty>Loading exact tender terms and party history...</Empty>
            ) : detail.error ? (
              <p role="alert" className="text-sm text-destructive">
                {detail.error}
              </p>
            ) : (
              tender && (
                <>
                  <Field label="Immutable tender version history">
                    <select
                      className={control}
                      value={String(tender.selectedVersion)}
                      disabled={!!busy || detail.refreshing}
                      onChange={(event) =>
                        setSelectedVersion(event.target.value)
                      }
                    >
                      {tender.versions.map((value) => (
                        <option key={value.version} value={value.version}>
                          Version {value.version}
                          {value.version === tender.current_version
                            ? " (current)"
                            : " (historical)"}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <TenderContent
                    key={`${tender.id}:${tender.selectedVersion}:${localKey?.keyId ?? "no-key"}`}
                    tender={tender}
                    mode={mode}
                    base={base}
                    localKey={localKey}
                    assets={assets}
                    disabled={
                      detail.refreshing ||
                      !!detail.error ||
                      resource.refreshing ||
                      !!resource.error
                    }
                    busy={busy}
                    canPrepare={canPrepare}
                    canApprove={canApprove}
                    canDelete={canDelete}
                    run={run}
                    onMutate={refresh}
                  />
                  {mode === "company" &&
                    canPrepare &&
                    !tender.historical &&
                    !tender.commitment_id &&
                    ["draft", "closed"].includes(tender.state) &&
                    resource.data &&
                    "roles" in resource.data && (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">
                          Revise or reopen as a new immutable tender version
                        </summary>
                        <p className="my-3 text-xs">
                          Original offers, commitments and party history remain
                          intact. New dates and identities require new
                          publication. An accepted agreement or existing PO
                          blocks reopening.
                        </p>
                        <TenderEditor
                          key={`${tender.id}:${tender.generation}`}
                          setup={resource.data}
                          buyerKey={localKey}
                          initial={tender.terms}
                          supplierIds={tender.invites.map(
                            (value) => value.recipientId,
                          )}
                          busy={!!busy || detail.refreshing}
                          onSave={(input) =>
                            run("reopen", async () => {
                              await api(
                                `${base}/tenders/${tender.id}/revisions`,
                                {
                                  ...(input as object),
                                  generation: tender.generation,
                                },
                              );
                              setSelectedVersion("");
                              refresh();
                            })
                          }
                        />
                      </details>
                    )}
                </>
              )
            )}
          </section>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {(error || resource.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || resource.error}
          </p>
        )}
      </div>
    </Panel>
  );
}

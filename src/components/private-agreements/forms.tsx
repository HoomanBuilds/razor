"use client";

import { useState, type FormEvent } from "react";
import { microUsd, usdcInput, usd } from "@/lib/format";
import {
  checkedOffer,
  offerTermsSchema,
  type LocalKey,
  type MandateTerms,
  type OfferTerms,
  type TenderTerms,
} from "@/lib/private-agreements/schema";
import type { companyOverview } from "@/server/private-agreements/service";
import { Action, control, Field } from "../workspace/shared";

type Setup = Pick<ReturnType<typeof companyOverview>, "roles" | "suppliers">;
export function saveLocal(name: string, value: unknown) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2) + "\n"], {
        type: "application/json",
      }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function localJson(file: File | undefined) {
  if (!file || file.size < 1 || file.size > 180000)
    throw new Error("Select one local JSON file below 180 KB");
  return JSON.parse(await file.text()) as unknown;
}
const localTime = (value?: string) =>
  value
    ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
export function TenderEditor({
  setup,
  buyerKey,
  initial,
  supplierIds = [],
  busy,
  onSave,
}: {
  setup: Setup;
  buyerKey: LocalKey | null;
  initial?: TenderTerms;
  supplierIds?: string[];
  busy: boolean;
  onSave: (input: unknown) => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <form
      className="grid min-w-0 gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        try {
          setError("");
          void onSave({
            terms: {
              reference: values.get("reference"),
              specification: values.get("specification"),
              eligibility: values.get("eligibility"),
              quantity: values.get("quantity"),
              minimumQuantity: values.get("minimumQuantity"),
              unit: values.get("unit"),
              budget: microUsd(String(values.get("budget"))),
              deliveryFrom: values.get("deliveryFrom"),
              deliveryTo: values.get("deliveryTo"),
              bidDeadline: new Date(
                String(values.get("bidDeadline")),
              ).toISOString(),
              revealAt: new Date(String(values.get("revealAt"))).toISOString(),
              negotiationDeadline: new Date(
                String(values.get("negotiationDeadline")),
              ).toISOString(),
              awardRule: values.get("awardRule"),
              disclosureRule: "selected_terms_to_razor_after_buyer_review",
              revealRule: "buyer_explicitly_after_reveal_at",
              encryptedRetentionDays: Number(values.get("retention")),
              reviewingRoleId: values.get("role"),
            },
            supplierIds: values.getAll("supplier"),
            buyerPublicKey: buyerKey?.publicKey,
          });
        } catch {
          setError(
            "Enter an exact USDC budget and complete valid dates before saving",
          );
        }
      }}
    >
      <fieldset disabled={busy || !buyerKey} className="contents">
        <Field label="Tender reference">
          <input
            name="reference"
            className={control}
            required
            maxLength={120}
            defaultValue={initial?.reference}
            readOnly={!!initial}
          />
        </Field>
        <Field label="Reviewing company role">
          <select
            name="role"
            className={control}
            required
            defaultValue={initial?.reviewingRoleId ?? ""}
          >
            <option value="">Choose a purchasing reviewer</option>
            {setup.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Full purchase specification">
            <textarea
              name="specification"
              className={control}
              minLength={3}
              maxLength={3000}
              required
              defaultValue={initial?.specification}
            />
          </Field>
        </div>
        <Field label="Supplier eligibility rules">
          <textarea
            name="eligibility"
            className={control}
            minLength={3}
            maxLength={3000}
            required
            defaultValue={
              initial?.eligibility ??
              "Only the invited confirmed business supplier identities may submit"
            }
          />
        </Field>
        <Field label="Award and review rules">
          <textarea
            name="awardRule"
            className={control}
            minLength={3}
            maxLength={3000}
            required
            defaultValue={
              initial?.awardRule ??
              "Company manually compares complete terms after reveal; both exact parties approve the final agreement before a separate PO proposal"
            }
          />
        </Field>
        {[
          ["quantity", "Maximum quantity", initial?.quantity],
          [
            "minimumQuantity",
            "Minimum acceptable quantity",
            initial?.minimumQuantity ?? initial?.quantity ?? "1",
          ],
        ].map(([name, label, value]) => (
          <Field key={name} label={label!}>
            <input
              name={name}
              className={control}
              pattern="[1-9][0-9]{0,11}"
              required
              defaultValue={value}
            />
          </Field>
        ))}
        <Field label="Quantity unit">
          <input
            name="unit"
            className={control}
            required
            maxLength={40}
            defaultValue={initial?.unit ?? "units"}
          />
        </Field>
        <Field label="Maximum complete commercial total, USDC">
          <input
            name="budget"
            className={control}
            inputMode="decimal"
            required
            maxLength={32}
            defaultValue={initial ? usdcInput(initial.budget) : ""}
          />
        </Field>
        {(
          [
            ["deliveryFrom", "Earliest delivery, UTC"],
            ["deliveryTo", "Latest delivery, UTC"],
          ] as const
        ).map(([name, label]) => (
          <Field key={name} label={label}>
            <input
              name={name}
              className={control}
              type="date"
              required
              defaultValue={initial?.[name]}
            />
          </Field>
        ))}
        {(
          [
            ["bidDeadline", "Sealed bid deadline, device time"],
            ["revealAt", "Earliest explicit buyer reveal, device time"],
            [
              "negotiationDeadline",
              "Final agreement and PO deadline, device time",
            ],
          ] as const
        ).map(([name, label]) => (
          <Field key={name} label={label}>
            <input
              name={name}
              className={control}
              type="datetime-local"
              required
              defaultValue={localTime(initial?.[name])}
            />
          </Field>
        ))}
        <Field label="Encrypted transcript retention after negotiation ends">
          <input
            name="retention"
            className={control}
            type="number"
            min={1}
            max={30}
            step={1}
            required
            defaultValue={initial?.encryptedRetentionDays ?? 7}
          />
        </Field>
        <fieldset className="grid gap-2 rounded-lg border p-3 sm:col-span-2">
          <legend className="px-1 text-sm">
            Invite confirmed business suppliers
          </legend>
          {setup.suppliers.length ? (
            setup.suppliers.map((supplier) => (
              <label
                key={supplier.id}
                className="flex items-start gap-2 text-sm"
              >
                <input
                  name="supplier"
                  type="checkbox"
                  value={supplier.id}
                  defaultChecked={supplierIds.includes(supplier.id)}
                />
                <span>
                  {supplier.name}, confirmed profile version {supplier.version}
                </span>
              </label>
            ))
          ) : (
            <p className="text-sm">
              Add a business recipient and wait for their account and receiving
              profile confirmation.
            </p>
          )}
        </fieldset>
        <label className="flex items-start gap-2 text-xs sm:col-span-2">
          <input type="checkbox" required />
          <span>
            I saved the local decryption key. Only its public key is submitted.
            Selected final terms become visible to Razor only after explicit
            disclosure. Losing the key can make sealed bids unreadable.
          </span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        )}
        <div>
          <Action
            disabled={busy || !buyerKey || !setup.suppliers.length}
            busy={busy}
          >
            Save unpublished tender version
          </Action>
        </div>
      </fieldset>
    </form>
  );
}

const emptyCommercial = {
  version: 2 as const,
  settlementUnit: "USDC" as const,
  shippingAmount: "0",
  serviceAmount: "0",
  taxAmount: "0",
  otherAmount: "0",
  taxTreatment: "not_applicable" as const,
  taxConditions: "No additional tax applies",
  shippingConditions: "No additional shipping charges",
  serviceConditions: "No additional service charges",
  deliveryConditions: "Deliver within the agreed window",
  acceptanceConditions: "Company inspects and accepts the specified work",
  otherChargeConditions: "No other included charges",
  excludedCharges: [],
  conversionEstimate: null,
};
export function OfferEditor({
  tender,
  initial,
  mandate,
  busy,
  onSave,
  label,
}: {
  tender: TenderTerms;
  initial?: OfferTerms;
  mandate?: MandateTerms;
  busy: boolean;
  onSave: (terms: OfferTerms) => Promise<void>;
  label: string;
}) {
  const commercial = initial?.commercial ?? emptyCommercial,
    [error, setError] = useState(""),
    [preview, setPreview] = useState("");
  const [excludedRows, setExcludedRows] = useState(() =>
    commercial.excludedCharges.map((value) => ({
      ...value,
      key: crypto.randomUUID(),
    })),
  );
  function read(form: HTMLFormElement) {
    const value = new FormData(form),
      estimate = String(value.get("conversion") ?? "").trim();
    return offerTermsSchema.parse({
      quantity: value.get("quantity"),
      unitPrice: microUsd(String(value.get("unitPrice"))),
      deliveryDate: value.get("deliveryDate"),
      validUntil: new Date(String(value.get("validUntil"))).toISOString(),
      terms: value.get("terms"),
      commercial: {
        ...commercial,
        ...Object.fromEntries(
          ["shippingAmount", "serviceAmount", "taxAmount", "otherAmount"].map(
            (name) => [name, microUsd(String(value.get(name)), true)],
          ),
        ),
        taxTreatment: value.get("taxTreatment"),
        ...Object.fromEntries(
          [
            "taxConditions",
            "shippingConditions",
            "serviceConditions",
            "deliveryConditions",
            "acceptanceConditions",
            "otherChargeConditions",
          ].map((name) => [name, value.get(name)]),
        ),
        excludedCharges: value
          .getAll("excludedKind")
          .map((kind, index) => ({
            kind,
            description: value.getAll("excluded")[index],
            estimateUSDC: String(
              value.getAll("excludedEstimate")[index] ?? "",
            ).trim()
              ? microUsd(String(value.getAll("excludedEstimate")[index]), true)
              : null,
          })),
        conversionEstimate: estimate
          ? {
              amountUSDC: microUsd(estimate, true),
              description: value.get("conversionBasis"),
            }
          : null,
      },
    });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const result = checkedOffer(tender, read(event.currentTarget), mandate);
      setError("");
      void onSave(result.terms);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Review exact terms and limits",
      );
    }
  }
  return (
    <form
      className="grid min-w-0 gap-3 rounded-lg border p-4 sm:grid-cols-2"
      onSubmit={submit}
      onInput={(event) => {
        try {
          setPreview(
            checkedOffer(tender, read(event.currentTarget), mandate).total,
          );
          setError("");
        } catch {
          setPreview("");
        }
      }}
    >
      <fieldset disabled={busy} className="contents">
        <Field label={`Quantity, ${tender.unit}`}>
          <input
            name="quantity"
            className={control}
            required
            pattern="[1-9][0-9]{0,11}"
            defaultValue={initial?.quantity ?? tender.quantity}
          />
        </Field>
        <Field label="Unit price, USDC">
          <input
            name="unitPrice"
            className={control}
            inputMode="decimal"
            required
            maxLength={32}
            defaultValue={initial ? usdcInput(initial.unitPrice) : ""}
          />
        </Field>
        <Field label="Delivery date, UTC">
          <input
            name="deliveryDate"
            type="date"
            className={control}
            required
            min={mandate?.deliveryFrom ?? tender.deliveryFrom}
            max={mandate?.deliveryTo ?? tender.deliveryTo}
            defaultValue={initial?.deliveryDate}
          />
        </Field>
        <Field label="Complete offer valid until, device time">
          <input
            name="validUntil"
            type="datetime-local"
            className={control}
            required
            defaultValue={localTime(initial?.validUntil)}
          />
        </Field>
        {(
          [
            ["shippingAmount", "Included shipping, USDC"],
            ["serviceAmount", "Included service, USDC"],
            ["taxAmount", "Included tax, USDC"],
            ["otherAmount", "Other included charges, USDC"],
          ] as const
        ).map(([name, title]) => (
          <Field key={name} label={title}>
            <input
              name={name}
              className={control}
              inputMode="decimal"
              required
              maxLength={32}
              defaultValue={usdcInput(commercial[name])}
            />
          </Field>
        ))}
        <Field label="Tax treatment">
          <select
            name="taxTreatment"
            className={control}
            defaultValue={commercial.taxTreatment}
          >
            <option value="not_applicable">Not applicable</option>
            <option value="included">Included above</option>
            <option value="excluded">
              Excluded below, requires zero included tax
            </option>
          </select>
        </Field>
        {(
          [
            ["taxConditions", "Tax conditions"],
            ["shippingConditions", "Shipping conditions"],
            ["serviceConditions", "Service conditions"],
            ["deliveryConditions", "Delivery conditions"],
            ["acceptanceConditions", "Acceptance conditions"],
            ["otherChargeConditions", "Other charge conditions"],
          ] as const
        ).map(([name, title]) => (
          <Field key={name} label={title}>
            <textarea
              name={name}
              className={control}
              required
              minLength={3}
              maxLength={500}
              defaultValue={commercial[name]}
            />
          </Field>
        ))}
        <fieldset className="grid gap-3 rounded-lg border p-3 sm:col-span-2">
          <legend className="px-1 text-xs">
            Excluded commercial charges, outside the included total
          </legend>
          {excludedRows.map((value) => (
            <div
              key={value.key}
              className="grid min-w-0 gap-3 rounded-lg border p-3 sm:grid-cols-3"
            >
              <Field label="Excluded charge category">
                <select
                  name="excludedKind"
                  className={control}
                  defaultValue={value.kind}
                >
                  <option value="other">Other</option>
                  <option value="tax">Tax</option>
                  <option value="shipping">Shipping</option>
                  <option value="service">Service</option>
                </select>
              </Field>
              <Field label="Excluded commercial condition">
                <textarea
                  name="excluded"
                  className={control}
                  minLength={3}
                  maxLength={500}
                  required
                  defaultValue={value.description}
                />
              </Field>
              <Field label="Supplier estimate, USDC, optional">
                <input
                  name="excludedEstimate"
                  className={control}
                  inputMode="decimal"
                  maxLength={32}
                  defaultValue={
                    value.estimateUSDC === null
                      ? ""
                      : usdcInput(value.estimateUSDC)
                  }
                />
              </Field>
              <button
                type="button"
                className="text-xs text-primary"
                disabled={busy}
                onClick={() =>
                  setExcludedRows((rows) =>
                    rows.filter((row) => row.key !== value.key),
                  )
                }
              >
                Remove excluded charge
              </button>
            </div>
          ))}
          <button
            type="button"
            className="justify-self-start text-xs text-primary"
            disabled={busy || excludedRows.length >= 8}
            onClick={() =>
              setExcludedRows((rows) => [
                ...rows,
                {
                  kind: "other",
                  description: "",
                  estimateUSDC: null,
                  key: crypto.randomUUID(),
                },
              ])
            }
          >
            Add excluded tax or charge
          </button>
        </fieldset>
        <Field label="Supplier-only conversion estimate, USDC, optional">
          <input
            name="conversion"
            className={control}
            inputMode="decimal"
            maxLength={32}
            defaultValue={
              commercial.conversionEstimate
                ? usdcInput(commercial.conversionEstimate.amountUSDC)
                : ""
            }
          />
        </Field>
        <Field label="Conversion estimate basis">
          <input
            name="conversionBasis"
            className={control}
            minLength={3}
            maxLength={500}
            defaultValue={commercial.conversionEstimate?.description}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Full additional commercial conditions">
            <textarea
              name="terms"
              className={control}
              required
              minLength={3}
              maxLength={3000}
              defaultValue={initial?.terms}
            />
          </Field>
        </div>
        <p className="text-xs sm:col-span-2">
          {preview
            ? `Exact included total: ${usd(preview)} USDC.`
            : "Complete valid fields to calculate the exact USDC total."}{" "}
          Excluded charges and conversion estimates are supplier assertions
          outside the PO allowance, payment route and fee ceiling. Nothing in
          this editor changes a receiving destination.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        )}
        <div>
          <Action disabled={busy} busy={busy}>
            {label}
          </Action>
        </div>
      </fieldset>
    </form>
  );
}

export function MandateEditor({
  tender,
  busy,
  onSave,
}: {
  tender: TenderTerms;
  busy: boolean;
  onSave: (value: MandateTerms) => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <form
      className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const values = new FormData(event.currentTarget);
          const input = {
            maximumTotal: microUsd(String(values.get("maximumTotal"))),
            minimumQuantity: String(values.get("minimumQuantity")),
            maximumQuantity: String(values.get("maximumQuantity")),
            deliveryFrom: String(values.get("deliveryFrom")),
            deliveryTo: String(values.get("deliveryTo")),
            expiresAt: new Date(String(values.get("expiresAt"))).toISOString(),
            maximumRounds: Number(values.get("maximumRounds")),
            instruction: String(values.get("instruction")),
          };
          setError("");
          void onSave(input);
        } catch {
          setError(
            "Enter an exact USDC cap and complete future mandate limits",
          );
        }
      }}
    >
      <fieldset className="contents" disabled={busy}>
        <Field label="Negotiation maximum complete total, USDC">
          <input
            name="maximumTotal"
            className={control}
            inputMode="decimal"
            required
            defaultValue={usdcInput(tender.budget)}
          />
        </Field>
        <Field label="Maximum company and supplier round pairs">
          <input
            name="maximumRounds"
            className={control}
            type="number"
            min={1}
            max={8}
            step={1}
            required
            defaultValue={3}
          />
        </Field>
        <Field label="Minimum quantity">
          <input
            name="minimumQuantity"
            className={control}
            required
            defaultValue={tender.minimumQuantity}
          />
        </Field>
        <Field label="Maximum quantity">
          <input
            name="maximumQuantity"
            className={control}
            required
            defaultValue={tender.quantity}
          />
        </Field>
        <Field label="Earliest delivery">
          <input
            name="deliveryFrom"
            type="date"
            className={control}
            required
            defaultValue={tender.deliveryFrom}
          />
        </Field>
        <Field label="Latest delivery">
          <input
            name="deliveryTo"
            type="date"
            className={control}
            required
            defaultValue={tender.deliveryTo}
          />
        </Field>
        <Field label="Mandate expiry, device time">
          <input
            name="expiresAt"
            type="datetime-local"
            className={control}
            required
            defaultValue={localTime(tender.negotiationDeadline)}
          />
        </Field>
        <Field label="Human negotiation instruction">
          <textarea
            name="instruction"
            className={control}
            required
            minLength={3}
            maxLength={3000}
          />
        </Field>
        <p className="text-xs sm:col-span-2">
          This draft authorizes no negotiation until a different company
          reviewer approves it. Price, quantity, date, counterparty, round and
          expiry limits remain independent of any model suggestion.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Action disabled={busy} busy={busy}>
            Propose separate negotiation mandate
          </Action>
        </div>
      </fieldset>
    </form>
  );
}

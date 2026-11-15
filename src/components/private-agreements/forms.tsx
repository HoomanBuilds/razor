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
export function TenderEditor({ setup, buyerKey, initial, supplierIds = [], busy, onSave }: { setup: Setup; buyerKey: LocalKey | null; initial?: TenderTerms; supplierIds?: string[]; busy: boolean; onSave: (input: unknown) => Promise<void> }) {
  const [error, setError] = useState(""), [step, setStep] = useState(0);
  const next = (form: HTMLFormElement) => {
    if (step === 0) {
      const budget = form.elements.namedItem("budget") as HTMLInputElement;
      budget.setCustomValidity("");
      try { microUsd(budget.value); } catch (cause) { budget.setCustomValidity(cause instanceof Error ? cause.message : "Enter a valid budget."); budget.reportValidity(); return; }
    }
    const invalid = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-tender-step="${step}"] input, [data-tender-step="${step}"] select, [data-tender-step="${step}"] textarea`)).find(field => !field.checkValidity());
    if (invalid) invalid.reportValidity(); else setStep(value => value + 1);
  };
  return <form noValidate className="grid min-w-0 gap-6" aria-busy={busy} onInvalidCapture={event => { const element = event.target as HTMLElement; const target = element.closest<HTMLElement>("[data-tender-step]"); if (target) { setStep(Number(target.dataset.tenderStep)); requestAnimationFrame(() => element.focus()); } }} onSubmit={event => {
    event.preventDefault();
    if (step < 2) { next(event.currentTarget); return; }
    const form = event.currentTarget;
    const invalid = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")).find(field => !field.checkValidity());
    if (invalid) { const target = invalid.closest<HTMLElement>("[data-tender-step]"); if (target) setStep(Number(target.dataset.tenderStep)); requestAnimationFrame(() => invalid.reportValidity()); return; }
    const values = new FormData(form);
    if (!values.getAll("supplier").length) { setStep(1); setError("Choose at least one supplier."); return; }
    try {
      setError("");
      void onSave({ terms: { reference: values.get("reference"), specification: values.get("specification"), eligibility: values.get("eligibility"), quantity: values.get("quantity"), minimumQuantity: values.get("minimumQuantity"), unit: values.get("unit"), budget: microUsd(String(values.get("budget"))), deliveryFrom: values.get("deliveryFrom"), deliveryTo: values.get("deliveryTo"), bidDeadline: new Date(String(values.get("bidDeadline"))).toISOString(), revealAt: new Date(String(values.get("revealAt"))).toISOString(), negotiationDeadline: new Date(String(values.get("negotiationDeadline"))).toISOString(), awardRule: values.get("awardRule"), disclosureRule: "selected_terms_to_razor_after_buyer_review", revealRule: "buyer_explicitly_after_reveal_at", encryptedRetentionDays: Number(values.get("retention")), reviewingRoleId: values.get("role") }, supplierIds: values.getAll("supplier"), buyerPublicKey: buyerKey?.publicKey });
    } catch { setError("Enter a valid USDC budget and dates."); }
  }}>
    <ol className="flex gap-4 border-b pb-4 text-xs">{["Purchase", "Suppliers", "Timing"].map((label, index) => <li key={label} className={index === step ? "font-medium text-primary" : "text-muted-foreground"}>{index + 1}. {label}</li>)}</ol>
    <fieldset disabled={busy || !buyerKey} className="grid min-w-0 gap-6">
      <div data-tender-step="0" hidden={step !== 0}><div className="grid gap-5"><Field label="What are you buying?"><textarea name="specification" className={control} minLength={3} maxLength={3000} required rows={3} defaultValue={initial?.specification}/></Field><div className="grid grid-cols-2 gap-4"><Field label="Reference"><input name="reference" className={control} required maxLength={120} defaultValue={initial?.reference} readOnly={!!initial}/></Field><Field label="Budget (USDC)"><input name="budget" className={control} inputMode="decimal" onInput={event => event.currentTarget.setCustomValidity("")} required maxLength={32} defaultValue={initial ? usdcInput(initial.budget) : ""}/></Field></div><div className="grid grid-cols-2 gap-4"><Field label="Maximum quantity"><input name="quantity" className={control} pattern="[1-9][0-9]{0,11}" required defaultValue={initial?.quantity}/></Field><Field label="Minimum quantity"><input name="minimumQuantity" className={control} pattern="[1-9][0-9]{0,11}" required defaultValue={initial?.minimumQuantity ?? initial?.quantity ?? "1"}/></Field></div><Field label="Unit"><input name="unit" className={control} required maxLength={40} defaultValue={initial?.unit ?? "units"}/></Field></div></div>
      <div data-tender-step="1" hidden={step !== 1}><div className="grid gap-5"><Field label="Reviewer role"><select name="role" className={control} required defaultValue={initial?.reviewingRoleId ?? ""}><option value="">Choose a role</option>{setup.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field><fieldset className="grid gap-3 border-y py-4"><legend className="text-xs text-muted-foreground">Suppliers</legend>{setup.suppliers.length ? setup.suppliers.map(supplier => <label key={supplier.id} className="flex items-start gap-2 text-sm"><input name="supplier" type="checkbox" value={supplier.id} defaultChecked={supplierIds.includes(supplier.id)}/>{supplier.name}</label>) : <p className="text-sm text-muted-foreground">No confirmed business suppliers.</p>}</fieldset><Field label="Eligibility"><textarea name="eligibility" className={control} minLength={3} maxLength={3000} required rows={2} defaultValue={initial?.eligibility ?? "Invited confirmed business suppliers only"}/></Field><Field label="Award rules"><textarea name="awardRule" className={control} minLength={3} maxLength={3000} required rows={3} defaultValue={initial?.awardRule ?? "Company review after reveal; both parties accept before purchase approval"}/></Field></div></div>
      <div data-tender-step="2" hidden={step !== 2}><div className="grid gap-5"><div className="grid gap-4 sm:grid-cols-2">{([["deliveryFrom", "Delivery from (UTC)"], ["deliveryTo", "Delivery to (UTC)"]] as const).map(([name, label]) => <Field key={name} label={label}><input name={name} className={control} type="date" required defaultValue={initial?.[name]}/></Field>)}</div>{([["bidDeadline", "Bids close"], ["revealAt", "Reveal after"], ["negotiationDeadline", "Agreement deadline"]] as const).map(([name, label]) => <Field key={name} label={`${label} (device time)`}><input name={name} className={control} type="datetime-local" required defaultValue={localTime(initial?.[name])}/></Field>)}<Field label="Encrypted history retention (days)"><input name="retention" className={control} type="number" min={1} max={30} step={1} required defaultValue={initial?.encryptedRetentionDays ?? 7}/></Field><label className="flex items-start gap-2 text-sm"><input type="checkbox" required/>I saved my key. Losing it may make offers unreadable.</label></div></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3 border-t pt-5">{step > 0 ? <button type="button" className="text-sm text-muted-foreground" onClick={() => setStep(value => value - 1)}>Back</button> : <span/>}{step < 2 ? <Action type="button" onClick={event => next(event.currentTarget.form!)}>Continue</Action> : <Action disabled={busy || !buyerKey || !setup.suppliers.length} busy={busy}>Save draft</Action>}</div>
    </fieldset>
  </form>;
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
  compact = false,
}: {
  tender: TenderTerms;
  initial?: OfferTerms;
  mandate?: MandateTerms;
  busy: boolean;
  onSave: (terms: OfferTerms) => Promise<void>;
  label: string;
  compact?: boolean;
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
      if (compact) {
        for (const field of Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]'))) {
          if (!field.required && !field.value.trim()) continue;
          try { microUsd(field.value, field.name !== "unitPrice"); }
          catch (inputError) {
            for (let detail = field.closest("details"); detail; detail = detail.parentElement?.closest("details") ?? null) detail.open = true;
            field.setCustomValidity(inputError instanceof Error ? inputError.message : "Enter a valid amount.");
            field.reportValidity();
            return;
          }
        }
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Review exact terms and limits",
      );
    }
  }
  return (
    <form
      className={compact ? "grid min-w-0 gap-5 sm:grid-cols-2" : "grid min-w-0 gap-3 rounded-lg border p-4 sm:grid-cols-2"}
      onInvalidCapture={event => { if (!compact) return; const target = event.target as HTMLElement; for (let detail = target.closest("details"); detail; detail = detail.parentElement?.closest("details") ?? null) detail.open = true; }}
      onSubmit={submit}
      onInput={(event) => {
        if (compact && event.target instanceof HTMLInputElement) event.target.setCustomValidity("");
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
        <details className={compact ? "border-t pt-4 sm:col-span-2" : "contents"} open={compact ? undefined : true}>
          <summary className={compact ? "cursor-pointer text-sm" : "hidden"}>Charges & conditions</summary>
          <div className={compact ? "mt-5 grid gap-5 sm:grid-cols-2" : "contents"}>
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
          </div>
        </details>
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
          {!compact && <>Excluded charges and conversion estimates are supplier assertions
          outside the PO allowance, payment route and fee ceiling. Nothing in
          this editor changes a receiving destination.</>}
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
      className="grid gap-5 sm:grid-cols-2"
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
        <Field label="Maximum total (USDC)">
          <input
            name="maximumTotal"
            className={control}
            inputMode="decimal"
            required
            defaultValue={usdcInput(tender.budget)}
          />
        </Field>
        <Field label="Maximum round pairs">
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
        <Field label="Expires (device time)">
          <input
            name="expiresAt"
            type="datetime-local"
            className={control}
            required
            defaultValue={localTime(tender.negotiationDeadline)}
          />
        </Field>
        <Field label="Instructions">
          <textarea
            name="instruction"
            className={control}
            required
            minLength={3}
            maxLength={3000}
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Action disabled={busy} busy={busy}>
            Propose negotiation
          </Action>
        </div>
      </fieldset>
    </form>
  );
}

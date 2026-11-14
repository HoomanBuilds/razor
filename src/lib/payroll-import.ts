import { formatUnits } from "./money";
import type { PayrollCsvItem } from "./csv";

export const importFields = ["recipientId", "email", "name", "amount", "baseAmount", "bonusAmount", "adjustmentAmount", "currency", "note", "maxFee"] as const;
export type ImportField = typeof importFields[number];
export interface ImportSettings {
  delimiter: "," | ";" | "\t" | "|";
  decimal: "." | ",";
  thousands: "" | "," | "." | " " | "'";
  defaultCurrency: "USDC";
  defaultMaxFee: string;
  mapping: Partial<Record<ImportField, string>>;
}
export interface ImportRecipient { id: string; email: string | null; name?: string; preference_status?: string }
export interface PayrollImportRow {
  rowNumber: number;
  source: Record<string, string>;
  values: Partial<Record<ImportField, string>>;
  recipientId: string | null;
  recipientName: string | null;
  errors: string[];
  warnings: string[];
  item: PayrollCsvItem | null;
}
export interface PayrollImportPreview {
  headers: string[];
  rows: PayrollImportRow[];
  ready: number;
  total: number;
  principal: string;
  maxFees: string;
  canCommit: boolean;
}
export const defaultImportSettings: ImportSettings = { delimiter: ",", decimal: ".", thousands: "", defaultCurrency: "USDC", defaultMaxFee: "1", mapping: {} };
const maximum = 10n ** 30n;

export function parsePayrollTable(source: string, delimiter: ImportSettings["delimiter"]) {
  if (typeof source !== "string" || new TextEncoder().encode(source).byteLength > 500_000) throw new Error("Upload a UTF-8 CSV smaller than 500 KB.");
  if (![",", ";", "\t", "|"].includes(delimiter)) throw new Error("Choose a supported column delimiter.");
  const records: string[][] = [];
  let record: string[] = [], field = "", quoted = false, closed = false;
  function finishField() { record.push(field.trim()); field = ""; closed = false; }
  function finishRow() {
    finishField();
    if (record.some(Boolean)) records.push(record);
    record = [];
    if (records.length > 1001) throw new Error("Import up to 1,000 payroll rows at a time.");
  }
  const input = source.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === delimiter) finishField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index++;
      finishRow();
    } else if (char === '"') {
      if (field.trim() || closed) throw new Error(`Row ${records.length + 1}: a quote must begin its field.`);
      field = ""; quoted = true;
    } else if (closed && !/\s/.test(char)) throw new Error(`Row ${records.length + 1}: unexpected text after a quoted field.`);
    else if (!closed) field += char;
    if (field.length > 2000 || record.length > 64) throw new Error("Use at most 64 columns and 2,000 characters per cell.");
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  finishRow();
  if (records.length < 2) throw new Error("CSV needs a header and at least one data row.");
  const headers = records.shift()!;
  if (headers.length > 64 || headers.some(value => !value || value.length > 200) || new Set(headers).size !== headers.length) throw new Error("Use up to 64 unique, nonempty column headers of at most 200 characters.");
  const rows = records.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`Row ${index + 2}: the number of columns differs from the header. Check the delimiter and quoted amounts.`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });
  return { headers, rows };
}

export function validateImportSettings(settings: ImportSettings, headers: string[]) {
  if (![".", ","].includes(settings.decimal) || !["", ",", ".", " ", "'"].includes(settings.thousands) || settings.thousands === settings.decimal) throw new Error("Choose different decimal and thousands separators.");
  if (settings.defaultCurrency !== "USDC") throw new Error("Payroll obligations use USDC. Foreign-currency amounts require an explicitly agreed USDC value.");
  const used = new Map<string, string>();
  for (const field of importFields) {
    const column = settings.mapping[field];
    if (!column) continue;
    if (!headers.includes(column)) throw new Error(`Mapped column "${column}" is not present. Review the mapping against this file's headers.`);
    if (used.has(column)) throw new Error(`Column "${column}" is mapped to both ${used.get(column)} and ${field}.`);
    used.set(column, field);
  }
  if (!settings.mapping.recipientId && !settings.mapping.email && !settings.mapping.name) throw new Error("Map a recipient ID, email or name column. Names require manual payee selection in the preview.");
  if (!settings.mapping.amount && !settings.mapping.baseAmount) throw new Error("Map the net amount or base amount column.");
  if ((settings.mapping.bonusAmount || settings.mapping.adjustmentAmount) && !settings.mapping.baseAmount) throw new Error("Map a base amount when supplying bonuses or adjustments.");
  normalizePayrollAmount(settings.defaultMaxFee, settings, true);
}

export function normalizePayrollAmount(raw: string, format: Pick<ImportSettings, "decimal" | "thousands">, allowZero = false, signed = false): bigint {
  let input = raw.trim();
  if (!input || input.length > 100) throw new Error("Enter an amount with at most six decimal places.");
  const negative = input.startsWith("-");
  if (signed && /^[+-]/.test(input)) input = input.slice(1);
  else if (/^[+-]/.test(input)) throw new Error("Use an unsigned amount; only corrections may be negative.");
  if (format.thousands === format.decimal) throw new Error("Decimal and thousands separators must differ.");
  const parts = input.split(format.decimal);
  if (parts.length > 2) throw new Error("Amount has more than one decimal separator.");
  let whole = parts[0];
  const fraction = parts[1] ?? "";
  if (format.thousands && whole.includes(format.thousands)) {
    const escaped = format.thousands.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^\\d{1,3}(${escaped}\\d{3})+$`).test(whole)) throw new Error("Amount has a misplaced thousands separator.");
    whole = whole.split(format.thousands).join("");
  }
  if (!/^\d+$/.test(whole) || parts.length === 2 && !/^\d+$/.test(fraction)) throw new Error("Amount does not match the confirmed number format.");
  if (fraction.length > 6 || whole.length > 31) throw new Error("Amount exceeds the supported precision or range.");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (amount > maximum || !allowZero && amount === 0n) throw new Error("Enter an amount within the supported range.");
  return negative ? -amount : amount;
}

export function suggestPayrollColumns(headers: string[]): ImportSettings["mapping"] {
  const aliases: Record<ImportField, string[]> = {
    recipientId: ["recipientid", "payeeid"], email: ["email", "emailaddress", "employeeemail", "workemail"], name: ["name", "employeename", "fullname"],
    amount: ["amount", "net", "netpay", "netamount", "netusdc", "salary"], baseAmount: ["baseamount", "basepay", "basesalary"], bonusAmount: ["bonus", "bonusamount"],
    adjustmentAmount: ["adjustment", "adjustmentamount", "correction"], currency: ["currency", "settlementcurrency"], note: ["note", "notes", "memo", "reason"], maxFee: ["maxfee", "feecap", "maxcost"],
  };
  const mapping: ImportSettings["mapping"] = {}, used = new Set<string>();
  for (const field of importFields) {
    const matches = headers.filter(header => aliases[field].includes(header.toLowerCase().replace(/[^a-z0-9]/g, "")) && !used.has(header));
    if (matches.length === 1) { mapping[field] = matches[0]; used.add(matches[0]); }
  }
  return mapping;
}

export function previewPayrollImport(source: string, settings: ImportSettings, recipients: ImportRecipient[], resolutions: Record<string, string> = {}, corrections: Record<string, Partial<Record<ImportField, string>>> = {}): PayrollImportPreview {
  const table = parsePayrollTable(source, settings.delimiter);
  validateImportSettings(settings, table.headers);
  const seen = new Set<string>();
  let principal = 0n, maxFees = 0n;
  const rows = table.rows.map((source, index): PayrollImportRow => {
    const rowNumber = index + 2, errors: string[] = [], warnings: string[] = [];
    const values = Object.fromEntries(importFields.map(field => [field, corrections[rowNumber]?.[field] ?? (settings.mapping[field] ? source[settings.mapping[field]!] : "")])) as Partial<Record<ImportField, string>>;
    const resolved = resolutions[rowNumber];
    let candidates = recipients.filter(recipient => resolved ? recipient.id === resolved : values.recipientId ? recipient.id === values.recipientId : recipient.email?.toLowerCase() === values.email?.trim().toLowerCase());
    if (!resolved && values.recipientId && values.email) candidates = candidates.filter(recipient => recipient.email?.toLowerCase() === values.email!.trim().toLowerCase());
    const recipient = candidates.length === 1 ? candidates[0] : null;
    if (!recipient) errors.push(candidates.length > 1 ? "Email matches several payees. Select the intended person." : "Payee not found. Select an existing payee or add/invite them, then resume this import.");
    else if (seen.has(recipient.id)) errors.push("This payee appears more than once in this import.");
    else seen.add(recipient.id);
    if (resolved && recipient) warnings.push("Payee selected manually; confirm it matches the source person.");
    if (Object.keys(corrections[rowNumber] ?? {}).length) warnings.push("Manual corrections applied. Original cells remain available for review.");
    if (recipient?.preference_status && recipient.preference_status !== "confirmed") warnings.push("Receiving details still need recipient confirmation before payout approval.");
    if (values.currency && values.currency.toUpperCase() !== "USDC" || settings.mapping.currency && !values.currency) errors.push("Use explicitly agreed USDC obligations. Currency values are not converted automatically.");
    let item: PayrollCsvItem | null = null;
    try {
      const base = normalizePayrollAmount(values.baseAmount || values.amount || "", settings, true), bonus = normalizePayrollAmount(values.bonusAmount || "0", settings, true), adjustment = normalizePayrollAmount(values.adjustmentAmount || "0", settings, true, true), net = base + bonus + adjustment;
      if (!values.baseAmount && (bonus !== 0n || adjustment !== 0n)) throw new Error("Supply the base amount for a bonus or correction.");
      if (net <= 0n || net > maximum) throw new Error("Net pay must be positive and within the supported range.");
      if (values.baseAmount && values.amount && normalizePayrollAmount(values.amount, settings) !== net) throw new Error("Net amount differs from base plus bonus and correction.");
      if ((bonus !== 0n || adjustment !== 0n) && !values.note?.trim()) throw new Error("Explain the supplied bonus or correction in a note.");
      if ((values.note?.length ?? 0) > 500) throw new Error("Use at most 500 characters for the note.");
      const fee = normalizePayrollAmount(values.maxFee || settings.defaultMaxFee, settings, true);
      const displaySigned = (amount: bigint) => amount < 0n ? `-${formatUnits((-amount).toString())}` : formatUnits(amount.toString());
      item = { amount: formatUnits(net.toString()), maxFee: formatUnits(fee.toString()), ...(values.note ? { note: values.note.trim() } : {}), ...(values.baseAmount ? { baseAmount: formatUnits(base.toString()), bonusAmount: formatUnits(bonus.toString()), adjustmentAmount: displaySigned(adjustment) } : {}) };
      if (!errors.length) { principal += net; maxFees += fee; }
    } catch (error) { errors.push(error instanceof Error ? error.message : "Check this row's amounts."); }
    return { rowNumber, source, values, recipientId: recipient?.id ?? null, recipientName: recipient?.name ?? null, errors, warnings, item };
  });
  return { headers: table.headers, rows, ready: rows.filter(row => !row.errors.length).length, total: rows.length, principal: principal.toString(), maxFees: maxFees.toString(), canCommit: rows.length > 0 && rows.every(row => !row.errors.length) };
}

import { formatUnits, parseUnits } from "./money";

export function parseCsv(source: string): Record<string, string>[] {
  const records: string[][] = [];
  let current: string[] = [], field = "", quoted = false;
  const input = source.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { current.push(field.trim()); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index++;
      current.push(field.trim()); if (current.some(Boolean)) records.push(current); current = []; field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  current.push(field.trim()); if (current.some(Boolean)) records.push(current);
  if (records.length < 2) throw new Error("CSV needs a header and at least one data row.");
  const headers = records.shift()!.map((value) => value.toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some((value) => !value)) throw new Error("CSV column names must be unique and nonempty.");
  return records.map((record, index) => {
    if (record.length !== headers.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    return Object.fromEntries(headers.map((header, column) => [header, record[column]]));
  });
}

export interface PayrollCsvItem { amount: string; baseAmount?: string; bonusAmount?: string; adjustmentAmount?: string; maxFee?: string; note?: string }

export function parsePayrollDetailsCsv(source: string, recipients: { id: string; email: string | null }[]): Record<string, PayrollCsvItem> {
  const items: Record<string, PayrollCsvItem> = {};
  const records = parseCsv(source);
  if (records.length > 1000) throw new Error("Import up to 1,000 recipients at a time.");
  for (const [index, record] of records.entries()) {
    const recipient = recipients.find((value) => record.recipient_id ? value.id === record.recipient_id : value.email?.toLowerCase() === record.email?.toLowerCase());
    if (!recipient) throw new Error(`Row ${index + 2}: recipient not found. Add or invite this payee first.`);
    if (record.recipient_id && record.email && recipient.email?.toLowerCase() !== record.email.toLowerCase()) throw new Error(`Row ${index + 2}: recipient_id and email do not identify the same payee.`);
    if (recipient.id in items) throw new Error(`Row ${index + 2}: recipient appears more than once.`);
    const value = (input: string, field: string, signed = false) => {
      try {
        const negative = signed && input.startsWith("-"), parsed = BigInt(parseUnits(negative ? input.slice(1) : signed ? input.replace(/^\+/, "") : input, 6));
        if (parsed > 10n ** 30n) throw new Error();
        return negative ? -parsed : parsed;
      } catch { throw new Error(`Row ${index + 2}: ${field} needs a valid USDC amount with at most six decimals.`); }
    };
    const bonus = record.bonus_amount || record.bonus || "0", adjustment = record.adjustment_amount || record.adjustment || "0";
    if (record.bonus_amount && record.bonus && record.bonus_amount !== record.bonus || record.adjustment_amount && record.adjustment && record.adjustment_amount !== record.adjustment) throw new Error(`Row ${index + 2}: use one bonus and one adjustment column.`);
    if (!record.base_amount && (value(bonus, "bonus") !== 0n || value(adjustment, "adjustment", true) !== 0n)) throw new Error(`Row ${index + 2}: provide base_amount when supplying a bonus or adjustment; amount is the agreed final net pay.`);
    const base = value(record.base_amount || record.amount || "", "base amount"), added = value(bonus, "bonus"), adjusted = value(adjustment, "adjustment", true), net = base + added + adjusted;
    if (net <= 0n || net > 10n ** 30n) throw new Error(`Row ${index + 2}: enter a positive net USDC amount within the supported range.`);
    if (record.base_amount && record.amount && value(record.amount, "amount") !== net) throw new Error(`Row ${index + 2}: amount differs from base_amount plus bonus_amount and adjustment_amount.`);
    if (record.note?.length > 500) throw new Error(`Row ${index + 2}: use at most 500 characters for the note.`);
    if ((added !== 0n || adjusted !== 0n) && !record.note?.trim()) throw new Error(`Row ${index + 2}: explain the supplied bonus or adjustment in note.`);
    const signed = (amount: bigint) => amount < 0n ? `-${formatUnits((-amount).toString())}` : formatUnits(amount.toString());
    items[recipient.id] = { amount: record.amount || formatUnits(net.toString()), ...(record.base_amount ? { baseAmount: formatUnits(base.toString()), bonusAmount: formatUnits(added.toString()), adjustmentAmount: signed(adjusted) } : {}), ...(record.max_fee ? { maxFee: formatUnits(value(record.max_fee, "max_fee").toString()) } : {}), ...(record.note ? { note: record.note.trim() } : {}) };
  }
  return items;
}

export function parsePayrollCsv(source: string, recipients: { id: string; email: string | null }[]): Record<string, string> {
  return Object.fromEntries(Object.entries(parsePayrollDetailsCsv(source, recipients)).map(([recipientId, item]) => [recipientId, item.amount]));
}
